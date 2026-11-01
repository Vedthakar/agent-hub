import { afterEach, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentId } from '../../src/shared/types.js';
import { DEFAULT_SCOPES } from '../../src/hub/scopes.js';
import type { InboundEmail, ImapTransport } from '../../src/hub/transports/imap.js';
import type { Transports } from '../../src/hub/transports/index.js';
import { HANDLES, STANLEY_ENV, makeHub, serve } from '../helpers.js';

export const ALL_TOKENS = 'claude:claude-token,chatgpt:chatgpt-token,gemini:gemini-token,grok:grok-token,boardy:boardy-token';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
export const onCleanup = (fn: () => Promise<void> | void) => void cleanups.push(fn);

export interface FakeImap extends ImapTransport {
  inbox: InboundEmail[];
  deliver(from: string, subject: string, text: string): void;
}

/** The user's mailbox as the Boardy adapter reads it over IMAP. */
export function fakeImap(): FakeImap {
  let uid = 0;
  const imap: FakeImap = {
    inbox: [],
    deliver(from, subject, text) {
      imap.inbox.push({ uid: ++uid, messageId: `<m${uid}@mail.example.com>`, from, subject, text, date: new Date(), refs: [] });
    },
    async fetchSince(lastUid) {
      return { messages: imap.inbox.filter((m) => m.uid > lastUid), uidValidity: '1' };
    },
  };
  return imap;
}

/** A hub on local Supabase with every agent wired up, served over HTTP, torn down after the test. */
export async function secureHub(env: Record<string, string> = {}, overrides: Partial<Transports> = {}) {
  const imap = fakeImap();
  const ctx = await makeHub(
    {
      ...STANLEY_ENV,
      HUB_AGENT_TOKENS: ALL_TOKENS,
      OWNER_LINKS: 'LinkedIn=https://linkedin.com/in/ved',
      IMAP_URL: 'imaps://ved:pw@imap.example.com',
      BOARDY_EMAIL: 'boardy@boardy.ai',
      ...env,
    },
    undefined,
    { imap, ...overrides },
  );
  const http = await serve(ctx.hub);
  onCleanup(async () => {
    await http.close();
    await ctx.hub.idle();
    await ctx.db.close();
  });
  // First reads set the IMAP and Telegram checkpoints, as on a fresh install.
  await ctx.hub.pollReads();
  return { ...ctx, url: http.url, imap };
}

export type SecureHub = Awaited<ReturnType<typeof secureHub>>;

export async function mcpClient(url: string, token: string) {
  const client = new Client({ name: 'security', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  onCleanup(() => client.close());
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join('\n'), isError: Boolean(res.isError) };
  };
}

/** The most permissive setting the user could choose: every agent and route on "auto". */
export async function everythingAuto(h: SecureHub) {
  for (const [agent, d] of Object.entries(DEFAULT_SCOPES)) {
    await h.store.updateScope(agent as AgentId, { ...d, autonomy: 'auto' }, 'test');
  }
}

/** Ved signs in to the dashboard; returns headers for same-origin POSTs. */
export async function dashboardLogin(url: string, password = 'hunter2') {
  const res = await fetch(`${url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: url },
    body: new URLSearchParams({ password }),
  });
  expect(res.status).toBe(302);
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return { cookie, origin: url, 'content-type': 'application/x-www-form-urlencoded' };
}

/** Everything that left the hub towards Boardy, on any channel. */
export async function sentToBoardy(h: SecureHub) {
  const outbox = (await h.store.recentOutbox(500)).filter((o) => o.to_handle === HANDLES.boardy);
  const mail = h.email.sent.filter((m) => m.to === h.cfg.boardyEmail);
  const tasks = (await h.store.recentTasks(500)).filter((t) => t.target_agent === 'boardy' && ['sent', 'done'].includes(t.status));
  return [...outbox.map((o) => o.body), ...mail.map((m) => `${m.subject}\n${m.text}`), ...tasks.map((t) => t.payload)];
}

/** The nonce-tagged data blocks in a router prompt, and what's left outside them. */
export function splitPrompt(system: string, user: string) {
  const tag = /<(untrusted-[0-9a-f]{16})>/.exec(system)?.[1];
  expect(tag, 'system prompt names the per-call data tag').toBeDefined();
  const opens = user.split(`<${tag} kind="`).length - 1;
  const closes = user.split(`</${tag}>`).length - 1;
  const block = new RegExp(`<${tag} kind="[a-z-]+">\\n([\\s\\S]*?)\\n</${tag}>`, 'g');
  const inside = [...user.matchAll(block)].map((m) => m[1]);
  const outside = user.replace(block, '');
  return { tag: tag!, opens, closes, inside, outside };
}
