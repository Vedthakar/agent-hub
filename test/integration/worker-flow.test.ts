import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { situationFor } from '../../src/hub/context.js';
import { WorkerUnavailable } from '../../src/hub/worker.js';
import { HANDLES, STANLEY_ENV, makeHub, minutesFromNow, msg, serve } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(env: Record<string, string> = {}) {
  const ctx = await makeHub({ ...STANLEY_ENV, ...env });
  const http = await serve(ctx.hub);
  cleanups.push(async () => {
    await http.close();
    await ctx.hub.idle();
    await ctx.db.close();
  });
  return { ...ctx, url: http.url };
}

async function mcp(url: string, token: string) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  cleanups.push(() => client.close());
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join('\n'), error: Boolean(res.isError) };
  };
}

const INSTINCT_CHAT = [msg(HANDLES.instinct, 'pause open source for a week', { fromMe: true }), msg(HANDLES.instinct, 'Done.')];

describe('triage: rules first, the worker only for the rest', () => {
  it('a plain agent summary never wakes the worker; a chat does and gets sorted', async () => {
    const { hub, store, worker, url } = await setup();
    await (await mcp(url, 'claude-token'))('log_session', { summary: 'Outlined the launch post' });
    await hub.routePending();
    expect(worker.calls).toHaveLength(0);

    await hub.ingestDaemon(INSTINCT_CHAT);
    await hub.collectBursts(minutesFromNow(11));
    worker.next.push(() => ({
      summary: 'Paused open source for a week.',
      topics: ['open_source'],
      situation: [{ text: 'Open source paused for a week', topics: ['open_source'], evidence: ['m1'] }],
      tasks: [{ target_agent: 'grok', payload: 'Pause open-source work for a week.', topics: ['open_source'], evidence: ['m1'] }],
    }));
    await hub.routePending();
    expect(worker.calls).toHaveLength(1);
    const event = (await store.recentEvents(5)).find((e) => e.agent === 'instinct')!;
    expect(event.triage).toBe('both');
    expect((await store.tasksByStatus(['proposed']))[0].target_agent).toBe('grok');
  });

  it('a chat the worker may not read stays private: only the fact it happened is recorded', async () => {
    const { hub, store, worker, cfg } = await setup();
    cfg.worker.sources = ['stanley'];
    await hub.ingestDaemon(INSTINCT_CHAT);
    await hub.collectBursts(minutesFromNow(11));
    await hub.routePending();
    expect(worker.calls).toHaveLength(0);
    const [event] = await store.recentEvents(1);
    expect(event.summary).toBe('Ved talked with Instinct (2 messages).');
    expect(JSON.stringify(await situationFor(store, 'claude'))).not.toContain('pause open source');
  });

  it('with no worker at all, nothing is lost and the hub keeps running', async () => {
    const ctx = await makeHub(STANLEY_ENV, null);
    cleanups.push(() => ctx.db.close());
    await ctx.hub.ingestDaemon(INSTINCT_CHAT);
    await ctx.hub.collectBursts(minutesFromNow(11));
    expect(await ctx.hub.routePending()).toBe(1);
    expect((await ctx.store.recentEvents(1))[0].raw_excerpt).toContain('pause open source');
  });

  it('a signed-out or limited account pauses the queue, burns no retries, tells you once, and recovers', async () => {
    const { hub, store, worker, transports } = await setup();
    await hub.ingestDaemon(INSTINCT_CHAT);
    await hub.collectBursts(minutesFromNow(11));
    const real = worker.complete;
    let calls = 0;
    worker.complete = async () => {
      calls++;
      throw new WorkerUnavailable('The worker account hit a usage limit', 'limit', 60_000);
    };
    await hub.routePending();
    await hub.routePending();
    expect(calls).toBe(1);
    expect(hub.workerProblem).toBe('limit');
    expect((await store.unroutedEvents(new Date()))[0].route_attempts).toBe(0);
    expect((await store.claimOutbox()).filter((o) => o.body.includes('usage limit'))).toHaveLength(1);
    expect(transports).toBeTruthy();

    worker.complete = real;
    await hub.reconfigure(); // switching accounts in Settings clears the pause
    expect(await hub.routePending()).toBe(1);
    expect(hub.workerProblem).toBeNull();
  });

  it('stops at the daily run cap and carries on the next day', async () => {
    const { hub, store, worker } = await setup({ WORKER_MAX_RUNS_PER_DAY: '1' });
    await hub.ingestDaemon(INSTINCT_CHAT);
    await hub.ingestDaemon([msg(HANDLES.stanley, 'any hooks?', { fromMe: true })]);
    await hub.collectBursts(minutesFromNow(11));
    await hub.routePending();
    expect(worker.calls).toHaveLength(1);
    expect(await store.unroutedEvents(new Date())).toHaveLength(1);
    expect(await hub.routePending(new Date(Date.now() + 26 * 3600_000))).toBe(1);
  });
});

describe('agents save as they chat', () => {
  it('set_situation reaches agents by topic right away, and shows up in the vault', async () => {
    const { hub, store, url, cfg } = await setup();
    const claude = await mcp(url, 'claude-token');
    expect((await claude('set_situation', { text: 'Applying to fintech backend roles', topics: ['professional'] })).error).toBe(false);
    expect((await situationFor(store, 'boardy')).situation.map((s) => s.text)).toEqual(['Applying to fintech backend roles']);
    expect((await situationFor(store, 'stanley')).situation).toEqual([]);
    await hub.vault.sync();
    const dir = path.join(cfg.vaultPath, 'Memory', 'Situation');
    expect(readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8')).toContain('said_by: agent');
  });

  it('an agent can replace its own slot but not what you said, or what it can’t see', async () => {
    const { store, url } = await setup();
    const claude = await mcp(url, 'claude-token');
    const grok = await mcp(url, 'grok-token');
    await claude('set_situation', { text: 'Coding', topics: ['projects'], slot: 'now:agent' });
    expect((await claude('set_situation', { text: 'Reviewing', topics: ['projects'], slot: 'now:agent' })).error).toBe(false);
    expect((await store.liveSituation()).map((s) => s.text)).toEqual(['Reviewing']);
    await store.addSituation({ text: 'In an assessment', slot: 'now:activity', topics: ['general'], sourceAgent: 'owner' as never, author: 'user', originEventId: null, expiresAt: minutesFromNow(60) });
    expect((await claude('set_situation', { text: 'Actually free', topics: ['general'], slot: 'now:activity' })).error).toBe(true);
    expect((await grok('set_situation', { text: 'Overwrite', topics: ['work'], slot: 'now:agent' })).error).toBe(true);
    expect((await claude('set_situation', { text: 'Old', topics: ['general'], expires_at: '2020-01-01T00:00:00Z' })).error).toBe(true);
  });

  it('agents can’t skip topics, and can retire agent memories but not yours', async () => {
    const { store, url } = await setup();
    const claude = await mcp(url, 'claude-token');
    expect((await claude('save_memory', { text: 'Likes short hooks', kind: 'preference', topics: [] })).error).toBe(true);
    await claude('save_memory', { text: 'Likes short hooks', kind: 'preference', topics: ['content'] });
    await store.addFact({ text: 'Launch Monday', kind: 'goal', topics: ['work'], sourceAgent: 'owner' as never, author: 'user', originEventId: null });
    const facts = await store.activeFacts();
    const id = (t: string) => facts.find((f) => f.text === t)!.id;
    expect((await claude('retire_memory', { id: id('Launch Monday') })).error).toBe(true);
    expect((await claude('retire_memory', { id: id('Likes short hooks') })).error).toBe(false);
    expect((await store.activeFacts()).map((f) => f.text)).toEqual(['Launch Monday']);
  });
});

describe('texting the hub', () => {
  const text = (t: string, fromMe = true) => msg(HANDLES.approval, t, { fromMe });
  const replies = async (store: Awaited<ReturnType<typeof setup>>['store']) => (await store.claimOutbox()).map((o) => o.body);

  it('saves what you say, as your own words, for everyone allowed to see it', async () => {
    const { hub, store } = await setup();
    await hub.ingestDaemon([text('now: starting a coding assessment until 23:59')]);
    const view = await situationFor(store, 'claude');
    expect(view.situation[0]).toMatchObject({ text: 'starting a coding assessment until 23:59', provenance: 'you said' });
    expect((await situationFor(store, 'boardy')).situation).toEqual([]);
    expect((await replies(store)).join()).toContain('Noted');
    await hub.ingestDaemon([text('now: done with the assessment')]);
    expect((await store.liveSituation()).map((s) => s.text)).toEqual(['done with the assessment']);
  });

  it('a hand-off you type goes straight out, no second approval', async () => {
    const { hub, store, telegram } = await setup();
    await hub.ingestDaemon([text('stanley: write a script for tomorrow’s shoot')]);
    await hub.tick();
    const [task] = await store.tasksByStatus(['sent']);
    expect([task.target_agent, task.author, task.topics]).toEqual(['stanley', 'user', ['content']]);
    expect(telegram.chat[0].text).toContain('write a script');
  });

  it('never from anyone else, and privacy rules still apply to your own commands', async () => {
    const { hub, store } = await setup();
    await hub.ingestDaemon([text('goal: from a stranger', false), text('stanley: forward this', false)]);
    expect(await store.activeFacts()).toEqual([]);
    expect(await store.recentTasks()).toEqual([]);
    await hub.ingestDaemon([text('boardy: tell them about my knee surgery')]);
    expect((await replies(store)).join()).toContain('Not sent to Boardy');
    expect((await store.recentTasks())[0].status).toBe('blocked');
  });

  it('over SMS, where caller ID can be spoofed, a typed hand-off still asks', async () => {
    const { hub, store } = await setup();
    await hub.handleInbound({ channel: 'sms', externalId: 's1', fromOwner: true, sender: 'me', text: 'stanley: write a script' });
    expect((await store.tasksByStatus(['proposed']))).toHaveLength(1);
  });

  it('forget removes one match and asks when there are several', async () => {
    const { hub, store } = await setup();
    await hub.ingestDaemon([text('goal: launch on Monday'), text('goal: launch the podcast')]);
    await hub.ingestDaemon([text('forget: launch')]);
    expect(await store.activeFacts()).toHaveLength(2);
    await hub.ingestDaemon([text('forget: on monday')]);
    expect((await store.activeFacts()).map((f) => f.text)).toEqual(['launch the podcast']);
  });
});
