import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeBoardyBrief } from '../src/hub/adapters/boardy.js';
import { signWebhook } from '../src/hub/adapters/grok.js';
import { handleBounces } from '../src/hub/bounces.js';
import { twilioSignature } from '../src/hub/transports/sms.js';
import { Daemon, HubHttpError, type DaemonState, type HubClient } from '../src/daemon/daemon.js';
import { createLogger } from '../src/shared/log.js';
import type { DaemonMessage } from '../src/shared/types.js';
import { HANDLES, makeHub, msg, serve } from './helpers.js';
import { buildChatDb } from './fixtures/chatdb.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(env: Record<string, string> = {}) {
  const ctx = await makeHub({ DELIVERY_BACKOFF_MS: '1', ROUTER_MAX_ATTEMPTS: '3', ...env });
  cleanups.push(async () => {
    await ctx.hub.idle();
    await ctx.db.close();
  });
  return ctx;
}

const approvedTask = (store: Awaited<ReturnType<typeof setup>>['store'], target: 'instinct' | 'boardy' | 'grok' | 'stanley', payload: string, topics: string[]) =>
  store.createTask({ originAgent: 'claude', targetAgent: target, payload, rationale: '', topics, author: 'user', originEventId: null, hop: 1, status: 'approved' });

describe('delivery: retries, backoff, dead-letter queue, delivery-layer guard', () => {
  it('retries a failing email with backoff, then dead-letters and tells the user', async () => {
    const { hub, store, email } = await setup({ DELIVERY_MAX_ATTEMPTS: '3' });
    email.failWith = 'SMTP 421 try again later';
    const t = await approvedTask(store, 'instinct', 'Remind me to call the bank tomorrow at 9', ['schedule']);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 15));
      await hub.dispatchApproved();
    }
    const row = (await store.task(t.id))!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
    const dlq = await store.openDeadLetters();
    expect(dlq.map((d) => [d.kind, d.ref_id, d.agent])).toEqual([['delivery', t.id, 'instinct']]);
    expect((await store.recentOutbox()).some((o) => o.body.includes(`Couldn't deliver ${t.code}`))).toBe(true);
    expect((await store.agentStatuses()).get('instinct')?.last_error).toContain('SMTP 421');

    // Retry from the DLQ once SMTP is back.
    email.failWith = null;
    await store.retryFailedTask(t.id);
    await hub.dispatchApproved();
    expect((await store.task(t.id))!.status).toBe('sent');
    expect(email.sent.at(-1)!.subject).toContain(t.code);
  });

  it('blocks Boardy at delivery even if a sensitive task was approved', async () => {
    const { hub, store, email } = await setup({ OWNER_LINKS: 'LinkedIn=https://linkedin.com/in/ved' });
    const t = await approvedTask(store, 'boardy', 'Find investors, and mention my midterm schedule and my knee surgery', ['networking']);
    await hub.dispatchApproved();
    const row = (await store.task(t.id))!;
    expect(row.status).toBe('blocked');
    expect(row.status_reason).toMatch(/delivery guard: payload mentions school, health/);
    expect(email.sent).toHaveLength(0);
  });

  it('sends Boardy the official brief, with sensitive standing context filtered out', async () => {
    const { hub, store, email, cfg } = await setup({
      OWNER_FULL_NAME: 'Ved Thakar',
      OWNER_BIO: 'Student founder building Agent Hub.',
      OWNER_LINKS: 'LinkedIn=https://linkedin.com/in/ved,GitHub=https://github.com/ved',
    });
    await store.addSituation({ text: 'Launching Agent Hub publicly next week', slot: null, topics: ['projects', 'professional'], sourceAgent: 'claude', author: 'user', originEventId: null, validFrom: new Date(), expiresAt: new Date(Date.now() + 86400_000) });
    await store.addSituation({ text: 'Midterm on Friday', slot: null, topics: ['professional'], sourceAgent: 'claude', author: 'user', originEventId: null, validFrom: new Date(), expiresAt: new Date(Date.now() + 86400_000) });
    const t = await approvedTask(store, 'boardy', 'Seed investors who back developer tools', ['networking', 'professional']);
    await hub.dispatchApproved();
    expect((await store.task(t.id))!.status).toBe('sent');
    const mail = email.sent[0];
    expect(mail.to).toBe(cfg.boardyEmail);
    expect(mail.subject).toBe('Ask Boardy: Seed investors who back developer tools');
    expect(mail.text).toContain("Who they'd like to meet");
    expect(mail.text).toContain('Launching Agent Hub publicly next week');
    expect(mail.text).not.toContain('Midterm');
    expect(mail.text).toContain('LinkedIn: https://linkedin.com/in/ved');
    expect((await store.task(t.id))!.delivery_ref).toBe(mail.messageId);
    expect(composeBoardyBrief(cfg, (await store.task(t.id))!, []).text).toContain('Could you find people who fit?');
  });

  it('a bounce puts a sent task back in the queue', async () => {
    const { hub, store, email } = await setup();
    const t = await approvedTask(store, 'instinct', 'Block 3-5pm tomorrow for the shoot', ['schedule']);
    await hub.dispatchApproved();
    const ref = email.sent[0].messageId;
    const n = await handleBounces(store, [{ uid: 1, messageId: '<b@x>', from: 'mailer-daemon@x', subject: 'Undelivered Mail', text: '', date: new Date(), refs: [ref] }], { maxAttempts: 5, baseBackoffMs: 1 });
    expect(n).toBe(1);
    expect((await store.task(t.id))!.status).toBe('approved');
  });

  it('"pause hub" stops delivery mid-cycle and holds iMessage deliveries in the outbox', async () => {
    const { hub, store, email } = await setup();
    await approvedTask(store, 'instinct', 'one', ['schedule']);
    await store.setPaused(true, 'test');
    expect(await hub.dispatchApproved()).toBe(0);
    expect(email.sent).toHaveLength(0);
    await store.enqueueOutbox({ toHandle: HANDLES.instinct, body: 'held', purpose: 'delivery' });
    await store.enqueueOutbox({ toHandle: HANDLES.approval, body: 'notice', purpose: 'notice' });
    expect((await store.claimOutbox(10, { paused: true })).map((o) => o.body)).toEqual(['notice']);
  });
});

describe('router: persistent retries and dead-letter queue', () => {
  it('malformed LLM output is retried with backoff and then dead-lettered, without blocking other events', async () => {
    const { hub, store, llm } = await setup();
    const bad = await store.insertEvent({ agent: 'claude', occurredAt: new Date(), author: 'user', rawExcerpt: 'x', summary: '', topics: [], kind: 'session' });
    let calls = 0;
    llm.complete = async () => (++calls <= 3 ? 'Sorry, I cannot help with that.' : JSON.stringify({ summary: 'ok', topics: ['general'] }));
    const far = (n: number) => new Date(Date.now() + n * 3600_000);
    await hub.routePending();
    expect((await store.db.query<{ route_attempts: number }>('SELECT route_attempts FROM events WHERE id = $1', [bad.id]))[0].route_attempts).toBe(1);
    await hub.routePending(far(1));
    await hub.routePending(far(2));
    const [ev] = await store.db.query<{ dead_lettered_at: Date | null; last_error: string }>('SELECT dead_lettered_at, last_error FROM events WHERE id = $1', [bad.id]);
    expect(ev.dead_lettered_at).toBeTruthy();
    expect(ev.last_error).toBe('no JSON object in model reply');
    expect((await store.openDeadLetters())[0].kind).toBe('route');

    const good = await store.insertEvent({ agent: 'gemini', occurredAt: new Date(), author: 'user', rawExcerpt: 'y', summary: '', topics: [], kind: 'session' });
    expect(await hub.routePending(far(3))).toBe(1);
    expect((await store.db.query<{ routed_at: Date | null }>('SELECT routed_at FROM events WHERE id = $1', [good.id]))[0].routed_at).toBeTruthy();
  });
});

describe('approvals: codes, expiry, lockout, channels', () => {
  it('expired codes stop working and invalid-code floods lock approvals', async () => {
    const { hub, store } = await setup({ APPROVAL_MAX_INVALID: '3' });
    const t = await store.createTask({ originAgent: 'claude', targetAgent: 'grok', payload: 'p', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    await hub.requestApprovals();
    await store.db.query(`UPDATE tasks SET approval_expires_at = now() - interval '1 minute' WHERE id = $1`, [t.id]);
    const reply = (text: string) => hub.handleInbound({ channel: 'imessage', externalId: `x-${Math.random()}`, fromOwner: true, sender: 'me', text });
    expect(await reply(`Y ${t.code}`)).toBe('expired');
    expect((await store.task(t.id))!.status).toBe('expired');

    const u = await store.createTask({ originAgent: 'claude', targetAgent: 'grok', payload: 'q', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    await hub.requestApprovals();
    for (const c of ['AAAA', 'BBBB', 'CCCC']) expect(await reply(`Y ${c}`)).toBe('invalid');
    expect(await reply(`Y ${u.code}`)).toBe('locked');
    expect((await store.task(u.id))!.status).toBe('proposed');
  });

  it('cancels from text, and the approval text is only marked sent when it actually went out', async () => {
    const { hub, store } = await setup({ APPROVAL_IMESSAGE_HANDLE: '', APPROVAL_CHANNEL: 'none' });
    const t = await store.createTask({ originAgent: 'claude', targetAgent: 'grok', payload: 'p', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    expect(await hub.requestApprovals()).toBe(0);
    expect((await store.task(t.id))!.approval_sent_at).toBeNull();
    expect(await hub.handleInbound({ channel: 'sms', externalId: 'c1', fromOwner: true, sender: 'me', text: `cancel ${t.code}` })).toBe('cancelled');
    expect((await store.task(t.id))!.status).toBe('cancelled');
  });

  it('Twilio webhook: valid signature from the owner approves; forged or foreign senders are dropped', async () => {
    const env = { APPROVAL_CHANNEL: 'sms', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tw-secret', TWILIO_FROM_NUMBER: '+15550009999', APPROVAL_USER_NUMBER: '+1 555 123 4567' };
    const { hub, store } = await setup(env);
    const http = await serve(hub);
    cleanups.push(() => http.close());
    const t = await store.createTask({ originAgent: 'claude', targetAgent: 'grok', payload: 'p', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    await store.markApprovalSent(t.id, new Date(Date.now() + 3600_000));
    const post = (params: Record<string, string>, sig?: string) =>
      fetch(`${http.url}/twilio/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sig ? { 'x-twilio-signature': sig } : {}) },
        body: new URLSearchParams(params),
      });
    const signed = (p: Record<string, string>) => twilioSignature('tw-secret', `${http.url}/twilio/sms`, p);

    const forged = { MessageSid: 'SM1', From: '+15551234567', Body: `Y ${t.code}` };
    expect((await post(forged, 'bogus')).status).toBe(403);
    const foreign = { MessageSid: 'SM2', From: '+15550000000', Body: `Y ${t.code}` };
    expect((await post(foreign, signed(foreign))).status).toBe(200);
    expect((await store.task(t.id))!.status).toBe('proposed');
    const mine = { MessageSid: 'SM3', From: '+15551234567', Body: `Y ${t.code}` };
    expect((await post(mine, signed(mine))).status).toBe(200);
    expect(['approved', 'sent']).toContain((await store.task(t.id))!.status);
  });

  it('signs the Grok webhook', () => {
    expect(signWebhook('s', '1', '{}')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('/health', () => {
  it('reports per-adapter state publicly and details with the daemon token', async () => {
    const { hub, store } = await setup();
    const http = await serve(hub);
    cleanups.push(() => http.close());
    await store.touchDelivery('instinct', 'SMTP down');
    const pub = await (await fetch(`${http.url}/health`)).json();
    expect(pub.adapters.instinct).toBe('degraded');
    expect(JSON.stringify(pub)).not.toContain('SMTP down');
    const full = await (await fetch(`${http.url}/health`, { headers: { authorization: 'Bearer daemon-token' } })).json();
    expect(full.adapters.find((a: { agent: string }) => a.agent === 'instinct').lastError).toBe('SMTP down');
    expect((await fetch(`${http.url}/health/stanley`)).status).toBe(200);
    expect((await fetch(`${http.url}/health/nobody`)).status).toBe(404);
  });
});

describe('daemon', () => {
  function harness(opts: { rows: { handle: string; text: string; fromMe?: boolean }[]; rejectText?: string; failIngest?: number }) {
    const dir = mkdtempSync(path.join(tmpdir(), 'hubd-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'chat.db');
    const fixture = buildChatDb(dbPath, opts.rows);
    const shipped: DaemonMessage[] = [];
    const acks: [number, boolean][] = [];
    let failures = opts.failIngest ?? 0;
    const outbox: { id: number; toHandle: string; body: string }[] = [];
    const sent: string[] = [];
    let state: DaemonState | null = { lastRowId: 0, knownHandles: [] };
    const hub: HubClient = {
      config: async () => ({ watchHandles: [HANDLES.instinct, HANDLES.stanley], approvalHandle: null, pollIntervalMs: 5000, paused: false }),
      ingest: async (messages) => {
        if (failures > 0) {
          failures--;
          throw new Error('ECONNREFUSED');
        }
        if (opts.rejectText && messages.some((m) => m.text === opts.rejectText)) throw new HubHttpError(400, 'bad');
        shipped.push(...messages);
      },
      outbox: async () => outbox.splice(0),
      ack: async (id, ok) => {
        acks.push([id, ok]);
      },
      heartbeat: async () => undefined,
    };
    let clock = Date.now();
    const d = new Daemon({
      chatDbPath: dbPath,
      hub,
      state: { load: async () => state, save: async (s) => void (state = structuredClone(s)) },
      send: async (_h, body) => void sent.push(body),
      log: createLogger({ test: true }),
      pageSize: 3,
      now: () => clock,
    });
    cleanups.push(() => d.close());
    return { d, shipped, acks, outbox, sent, fixture, getState: () => state, advance: (ms: number) => (clock += ms) };
  }

  it('isolates a poison message instead of wedging, keeps order, and never re-sends after a lost ack', async () => {
    const h = harness({
      rows: [
        { handle: HANDLES.instinct, text: 'one' },
        { handle: HANDLES.stanley, text: 'two' },
        { handle: HANDLES.instinct, text: 'POISON' },
        { handle: HANDLES.instinct, text: 'four' },
        { handle: '+15550003333', text: 'not watched' },
        { handle: HANDLES.stanley, text: 'six' },
      ],
      rejectText: 'POISON',
    });
    const r = await h.d.cycle();
    expect(r.error).toBeNull();
    expect(h.shipped.map((m) => m.text)).toEqual(['one', 'two', 'four', 'six']);
    expect(r.skipped).toBe(1);
    expect(h.getState()!.lastRowId).toBe(6);
    expect(h.getState()!.skipped).toEqual([3]);

    h.outbox.push({ id: 7, toHandle: HANDLES.approval, body: 'approve?' });
    await h.d.cycle();
    h.outbox.push({ id: 7, toHandle: HANDLES.approval, body: 'approve?' }); // ack lost; hub re-offers it
    await h.d.cycle();
    expect(h.sent).toEqual(['approve?']);
    expect(h.acks).toEqual([[7, true], [7, true]]);
  });

  it('holds the checkpoint while the hub is down, then catches up with nothing lost', async () => {
    const h = harness({ rows: [{ handle: HANDLES.instinct, text: 'a' }, { handle: HANDLES.instinct, text: 'b' }], failIngest: 1 });
    const r1 = await h.d.cycle();
    expect(r1.error).toContain('ECONNREFUSED');
    expect(h.getState()!.lastRowId).toBe(0);
    h.advance(10_000);
    await h.d.cycle();
    expect(h.shipped.map((m) => m.text)).toEqual(['a', 'b']);
  });

  it('detects a wake from sleep and reopens chat.db', async () => {
    const h = harness({ rows: [{ handle: HANDLES.instinct, text: 'before' }] });
    await h.d.cycle();
    h.advance(12 * 3600_000);
    h.fixture.add({ handle: HANDLES.instinct, text: 'after sleep' });
    const r = await h.d.cycle();
    expect(r.resumedAfterMs).toBe(12 * 3600_000);
    expect(h.shipped.map((m) => m.text)).toEqual(['before', 'after sleep']);
  });
});
