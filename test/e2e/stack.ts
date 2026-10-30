import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect } from 'vitest';
import { Daemon, httpHubClient, type DaemonState } from '../../src/daemon/daemon.js';
import { createLogger } from '../../src/shared/log.js';
import { HANDLES, makeHub, minutesFromNow, serve } from '../helpers.js';
import { buildChatDb, type FixtureRow } from '../fixtures/chatdb.js';

/**
 * The whole system as it runs in production, minus the outside world: a fixture chat.db read by the real
 * daemon, talking HTTP to the real hub on local Supabase, with agents reached over real MCP clients and
 * fake email / Telegram transports. Texts the daemon sends are written back into chat.db as "from me",
 * the way Messages.app records them.
 */
export async function stack(env: Record<string, string> = {}) {
  const cleanups: (() => Promise<void> | void)[] = [];
  const ctx = await makeHub(env);
  const http = await serve(ctx.hub);
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-e2e-'));
  const chat = buildChatDb(path.join(dir, 'chat.db'));
  const texts: { handle: string; body: string }[] = [];
  let state: DaemonState | null = { lastRowId: 0, knownHandles: [] };
  const daemon = new Daemon({
    chatDbPath: chat.file,
    hub: httpHubClient(http.url, 'daemon-token'),
    state: { load: async () => state, save: async (s) => void (state = structuredClone(s)) },
    send: async (handle, body) => {
      texts.push({ handle, body });
      chat.add({ handle, text: body, fromMe: true });
    },
    log: createLogger({ test: true }),
  });
  const clients: Client[] = [];
  cleanups.push(async () => {
    for (const c of clients) await c.close();
    daemon.close();
    chat.close();
    await http.close();
    await ctx.hub.idle();
    await ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    ...ctx,
    url: http.url,
    chat,
    texts,
    /** One daemon poll: ship new chat.db rows, send queued texts. Fails the test on any daemon error. */
    async poll() {
      const r = await daemon.cycle();
      expect(r.error).toBeNull();
      return r;
    },
    say(handle: string, text: string, fromMe = true) {
      chat.add({ handle, text, fromMe } satisfies FixtureRow);
    },
    /** Lets the debounce window pass, then runs one hub tick (read → route → approvals → dispatch). */
    async settle() {
      await ctx.hub.collectBursts(minutesFromNow(11));
      await ctx.hub.tick();
      await ctx.hub.idle();
    },
    async mcp(token: string) {
      const client = new Client({ name: 'e2e', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      clients.push(client);
      return async (name: string, args: Record<string, unknown> = {}) => {
        const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        expect(res.isError, `${name} failed: ${res.content.map((c) => c.text).join(' ')}`).toBeFalsy();
        return res.content.map((c) => c.text).join('\n');
      };
    },
    /** Approves by texting "Y <code>" from Ved's phone into the approval thread, then lets the hub deliver. */
    async approve(code: string) {
      this.say(HANDLES.approval, `Y ${code}`);
      await this.poll();
      await ctx.hub.tick();
      await ctx.hub.idle();
    },
    /** Everything the hub put into a thread Ved personally chats in (must stay empty). */
    textsIntoAgentThreads() {
      return texts.filter((t) => t.handle !== HANDLES.approval);
    },
    close: async () => {
      while (cleanups.length) await cleanups.pop()!();
    },
  };
}

export type Stack = Awaited<ReturnType<typeof stack>>;
