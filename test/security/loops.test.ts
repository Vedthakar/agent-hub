import { describe, expect, it } from 'vitest';
import { minutesFromNow } from '../helpers.js';
import { dashboardLogin, mcpClient, secureHub, type SecureHub } from './harness.js';

/** Loops stop at the hop limit (2), and "pause hub" halts delivery within one cycle. */

const approve = async (h: SecureHub, code: string, id = `ok-${code}`) => {
  await h.hub.idle();
  await h.hub.requestApprovals();
  expect((await h.store.taskByCode(code))!.approval_sent_at).toBeTruthy();
  await h.hub.handleInbound({ channel: 'imessage', externalId: id, fromOwner: true, sender: 'me', text: `Y ${code}` });
  await h.hub.dispatchApproved();
};
const task = async (h: SecureHub, code: string) => (await h.store.taskByCode(code))!;
const codeOf = (text: string) => /\[([A-Z0-9]{4})\]/.exec(text)?.[1] ?? '';

describe('agent loops', () => {
  it('LP-01 a Grok ↔ Stanley ping-pong stops at hop 2, whether or not Grok passes the task code', async () => {
    const h = await secureHub();
    const grok = await mcpClient(h.url, 'grok-token');

    // Hop 1: Grok asks Stanley for a script.
    const first = codeOf((await grok('propose_task', { target_agent: 'stanley', task: 'Write a launch script', topics: ['content'] })).text);
    expect((await task(h, first)).hop).toBe(1);
    await approve(h, first);
    expect((await task(h, first)).status).toBe('sent');

    // Stan replies over Telegram; the router (pushed by the reply) hands a follow-up to Grok at hop 2.
    h.telegram.reply('Script attached. Ask Grok to post it to the README.');
    h.llm.next.push(() => ({ summary: 's', tasks: [{ target_agent: 'grok', payload: 'Post the script to the README', topics: ['work'], evidence: [] }] }));
    await h.hub.pollReads();
    await h.hub.collectBursts(minutesFromNow(11));
    await h.hub.routePending();
    const [second] = await h.store.tasksByStatus(['proposed']);
    expect([second.target_agent, second.hop]).toEqual(['grok', 2]);
    await approve(h, second.code);
    expect((await task(h, second.code)).status).toBe('sent');

    // Hop 3 attempts from Grok: with the code, without it, and with someone else's lower-hop code.
    const attempts = [
      { task_code: second.code },
      {},
      { task_code: first },
      { task_code: 'ZZZZ' },
    ];
    for (const extra of attempts) {
      const out = await grok('propose_task', { target_agent: 'stanley', task: `Another script ${JSON.stringify(extra)}`, topics: ['content'], ...extra });
      expect(out.text, JSON.stringify(extra)).toMatch(/Blocked: hop limit \(3 > 2\)/);
    }
    // A session logged without a code inherits the chain too, so the router can't start hop 1 from it.
    h.llm.next.push(() => ({ summary: 's', tasks: [{ target_agent: 'stanley', payload: 'Yet another script', topics: ['content'], evidence: [] }] }));
    await grok('log_session', { summary: 'Posted it. Stanley should make another.' });
    await h.hub.idle();
    await h.hub.routePending();
    const [ev] = await h.store.recentEvents(1);
    expect([ev.agent, ev.hop, ev.caused_by_task_id]).toEqual(['grok', 2, second.id]);
    const blocked = (await h.store.recentTasks(20)).filter((t) => t.status === 'blocked');
    expect(blocked.length).toBe(5);
    expect(blocked.every((t) => t.status_reason === 'hop limit (3 > 2)')).toBe(true);
    // Exactly two deliveries happened.
    expect((await h.store.recentTasks(20)).filter((t) => t.status === 'sent').map((t) => t.hop).sort()).toEqual([1, 2]);
  });

  it('LP-02 the chain only carries over for 12h after the last delivery; then a fresh request starts at hop 1', async () => {
    const h = await secureHub();
    const t = await h.store.createTask({ originAgent: 'stanley', targetAgent: 'grok', payload: 'p', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 2, status: 'approved' });
    await h.hub.dispatchApproved();
    const grok = await mcpClient(h.url, 'grok-token');
    expect((await grok('propose_task', { target_agent: 'stanley', task: 'x', topics: ['content'] })).text).toMatch(/hop limit/);
    await h.store.db.query("UPDATE tasks SET sent_at = now() - interval '13 hours' WHERE id = $1", [t.id]);
    const out = await grok('propose_task', { target_agent: 'stanley', task: 'y', topics: ['content'] });
    expect(out.text).toMatch(/Proposed as/);
    expect((await task(h, codeOf(out.text))).hop).toBe(1);
  });

  it('LP-03 agent-only replies inherit the hop of the task that prompted them; the router cannot exceed the limit', async () => {
    const h = await secureHub();
    const ev = await h.store.insertEvent({ agent: 'stanley', occurredAt: new Date(), author: 'agent', rawExcerpt: 'x', summary: '', topics: [], kind: 'chat', hop: 2 });
    h.llm.next.push(() => ({ summary: 's', tasks: [{ target_agent: 'grok', payload: 'more', topics: ['work'], evidence: [] }] }));
    await h.hub.routePending();
    const [t] = await h.store.recentTasks(1);
    expect([t.origin_event_id, t.hop, t.status]).toEqual([ev.id, 3, 'blocked']);
  });
});

describe('kill switch', () => {
  it('LP-04 "pause hub" texted mid-cycle stops the very next delivery in that same cycle', async () => {
    const h = await secureHub();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await h.store.createTask({ originAgent: 'claude', targetAgent: 'stanley', payload: `script ${i}`, rationale: '', topics: ['content'], author: 'user', originEventId: null, hop: 1, status: 'approved' })).id);
    }
    const send = h.telegram.send.bind(h.telegram);
    let paused = false;
    h.telegram.send = async (text) => {
      const id = await send(text);
      if (!paused) {
        paused = true;
        expect(await h.hub.handleInbound({ channel: 'imessage', externalId: 'pause-1', fromOwner: true, sender: 'me', text: 'pause hub' })).toBe('paused');
      }
      return id;
    };
    expect(await h.hub.dispatchApproved()).toBe(1);
    await h.hub.tick();
    await h.hub.idle();
    expect(h.telegram.chat.filter((m) => m.out)).toHaveLength(1);
    const statuses = await Promise.all(ids.map(async (id) => (await h.store.task(id))!.status));
    expect(statuses.sort()).toEqual(['approved', 'approved', 'sent']);
    expect((await h.store.recentOutbox(10)).map((o) => o.body)).toContain('Hub paused. Nothing will be sent to any agent. Text "resume hub" to turn it back on.');

    await h.hub.handleInbound({ channel: 'imessage', externalId: 'resume-1', fromOwner: true, sender: 'me', text: 'resume hub' });
    await h.hub.idle();
    await h.hub.tick();
    expect(h.telegram.chat.filter((m) => m.out)).toHaveLength(3);
  });

  it('LP-05 the dashboard kill switch pauses everything: no deliveries, no approval requests, delivery texts held in the outbox', async () => {
    const h = await secureHub({ ALLOW_THREAD_FALLBACK: '1' });
    const session = await dashboardLogin(h.url);
    expect((await fetch(`${h.url}/actions/pause`, { method: 'POST', redirect: 'manual', headers: session })).status).toBe(303);
    expect(await h.store.isPaused()).toBe(true);
    const daemonHeaders = { authorization: 'Bearer daemon-token' };
    expect((await (await fetch(`${h.url}/daemon/config`, { headers: daemonHeaders })).json()).paused).toBe(true);

    const approved = await h.store.createTask({ originAgent: 'claude', targetAgent: 'stanley', payload: 'held', rationale: '', topics: ['content'], author: 'user', originEventId: null, hop: 1, status: 'approved' });
    const proposed = await h.store.createTask({ originAgent: 'claude', targetAgent: 'grok', payload: 'ask later', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    await h.store.enqueueOutbox({ toHandle: '+15550002222', body: 'delivery text', purpose: 'delivery', taskId: approved.id });
    await h.store.enqueueOutbox({ toHandle: '+15559990000', body: 'notice text', purpose: 'notice' });
    await h.hub.tick();
    await h.hub.idle();
    expect((await h.store.task(approved.id))!.status).toBe('approved');
    expect((await h.store.task(proposed.id))!.approval_sent_at).toBeNull();
    expect(h.telegram.chat).toEqual([]);
    const items = (await (await fetch(`${h.url}/daemon/outbox`, { headers: daemonHeaders })).json()).items as { body: string }[];
    expect(items.map((i) => i.body)).toEqual(['notice text']);

    expect((await fetch(`${h.url}/actions/resume`, { method: 'POST', redirect: 'manual', headers: session })).status).toBe(303);
    await h.hub.idle();
    await h.hub.tick();
    expect((await h.store.task(approved.id))!.status).toBe('sent');
    expect((await h.store.task(proposed.id))!.approval_sent_at).toBeTruthy();
    const after = (await (await fetch(`${h.url}/daemon/outbox`, { headers: daemonHeaders })).json()).items as { body: string }[];
    expect(after.map((i) => i.body)).toContain('delivery text');
  });

  it('LP-06 only Ved can pause or resume; an agent or stranger texting "resume hub" does nothing', async () => {
    const h = await secureHub();
    await h.store.setPaused(true, 'test');
    expect(await h.hub.handleInbound({ channel: 'imessage', externalId: 'r1', fromOwner: false, sender: '+15550001111', text: 'resume hub' })).toBe('rejected_sender');
    const csrf = await fetch(`${h.url}/actions/resume`, { method: 'POST', redirect: 'manual', headers: { ...(await dashboardLogin(h.url)), origin: 'https://evil.example' } });
    expect(csrf.status).toBe(403);
    expect((await fetch(`${h.url}/actions/resume`, { method: 'POST', redirect: 'manual' })).headers.get('location')).toBe('/login');
    expect(await h.store.isPaused()).toBe(true);
  });
});
