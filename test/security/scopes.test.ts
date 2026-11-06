import { describe, expect, it } from 'vitest';
import type { AgentId } from '../../src/shared/types.js';
import { checkDelivery, normalizeForScan, sensitiveTopicsIn } from '../../src/hub/guard.js';
import { DEFAULT_SCOPES, HARD_DENY, canSee } from '../../src/hub/scopes.js';
import { dashboardLogin, mcpClient, secureHub, sentToBoardy, type SecureHub } from './harness.js';

/**
 * "Boardy can never receive school, health, finance, or personal items, even if the router proposes it.
 * Enforce at the delivery layer, not in the prompt." These tests skip the router and the approval step
 * entirely and put tasks straight into the database as approved.
 */

const LEAKS: Record<string, string[]> = {
  school: ["Ved's class schedule for the semester", 'Midterm on Friday, studying linear algebra', 'Share his GPA and transcript of grades: my grades'],
  health: ['Recovering from knee surgery', 'Ved has a doctor appointment Tuesday', 'His ADHD medication schedule'],
  finances: ['His bank account and routing number', 'Ved\u2019s salary and credit score', 'Paying rent late this month'],
  personal: ['His girlfriend is visiting this weekend', 'Home address: 1 Main St', 'Going through a break up'],
};

const OBFUSCATED = [
  's\u200bc\u200bh\u200bo\u200bo\u200bl schedule',
  's c h o o l timetable',
  's.c.h.o.o.l notes',
  'ＳＣＨＯＯＬ schedule',
  'mi\u00addterm prep',
  'thérapy session',
  'm\u0301idterm review',
  'kn\u200dee surgery',
  'b-a-n-k a-c-c-o-u-n-t number',
];

async function approved(h: SecureHub, payload: string, topics: string[], target: AgentId = 'boardy') {
  return h.store.createTask({ originAgent: 'claude', targetAgent: target, payload, rationale: '', topics, author: 'user', originEventId: null, hop: 1, status: 'approved' });
}

describe('scopes are enforced at the delivery layer', () => {
  it('SC-01 an approved task inserted straight into the database is still blocked for every sensitive category', async () => {
    const h = await secureHub();
    const ids: number[] = [];
    for (const [cat, payloads] of Object.entries(LEAKS)) {
      for (const p of payloads) ids.push((await approved(h, p, ['networking'])).id);
      // Tagged honestly too.
      ids.push((await approved(h, `Intro for Ved (${cat})`, ['networking', cat])).id);
    }
    await h.hub.dispatchApproved();
    for (const id of ids) {
      const t = (await h.store.task(id))!;
      expect([t.status, t.status_reason?.startsWith('delivery guard:')], t.payload).toEqual(['blocked', true]);
    }
    expect(await sentToBoardy(h)).toEqual([]);
    expect((await h.store.recentAudit()).filter((a) => a.action === 'task.blocked_at_delivery')).toHaveLength(ids.length);
  });

  it('SC-02 tampering with Boardy\'s scope (dashboard or raw SQL) cannot open the hard floor', async () => {
    const h = await secureHub();
    await h.store.db.query("UPDATE scopes SET allow_topics = '{*}', deny_topics = '{}', autonomy = 'auto' WHERE agent = 'boardy'");
    const session = await dashboardLogin(h.url);
    await fetch(`${h.url}/actions/scope/boardy`, { method: 'POST', redirect: 'manual', headers: session, body: new URLSearchParams({ allow: '*', deny: '', autonomy: 'auto', enabled: 'on' }) });
    const scope = (await h.store.scope('boardy'))!;
    expect([scope.allow_topics, scope.deny_topics]).toEqual([['*'], []]);
    const school = await approved(h, 'Intro to a founder', ['school']);
    const leak = await approved(h, 'Midterm on Friday', ['networking']);
    const ok = await approved(h, 'Intro to climate founders', ['networking']);
    await h.hub.dispatchApproved();
    expect((await h.store.task(school.id))!.status).toBe('blocked');
    expect((await h.store.task(leak.id))!.status).toBe('blocked');
    expect((await h.store.task(ok.id))!.status).toBe('sent');
    expect(await sentToBoardy(h)).toHaveLength(2); // the one allowed task: its brief email and its row
    expect(HARD_DENY.boardy).toEqual(['school', 'health', 'finances', 'personal']);
    expect(canSee({ ...scope, agent: 'boardy' }, ['health'])).toBe(false);
  });

  it('SC-03 obfuscated sensitive words (zero-width, spacing, fullwidth, accents, soft hyphens) are still caught', async () => {
    for (const text of OBFUSCATED) expect(sensitiveTopicsIn(text), text).not.toEqual([]);
    expect(normalizeForScan('s\u200bc\u200bh\u200bo\u200bo\u200bl')).toBe('school');
    expect(normalizeForScan('ＳＣＨＯＯＬ')).toBe('SCHOOL');
    // No false positives on ordinary professional text.
    for (const text of ['World-class team, of course', 'Venture debt for the startup', 'Customer relationships at scale', 'a b c', 'Q3 board deck']) {
      expect(sensitiveTopicsIn(text), text).toEqual([]);
    }
    const h = await secureHub();
    const ids = [];
    for (const p of OBFUSCATED) ids.push((await approved(h, p, ['networking'])).id);
    await h.hub.dispatchApproved();
    for (const id of ids) expect((await h.store.task(id))!.status).toBe('blocked');
    expect(await sentToBoardy(h)).toEqual([]);
  });

  it('SC-04 context sent along with an allowed Boardy task never carries sensitive items, even mis-tagged ones', async () => {
    const h = await secureHub();
    const add = (text: string, topics: string[]) =>
      h.store.addSituation({ text, slot: null, topics, sourceAgent: 'claude', author: 'user', originEventId: null, expiresAt: new Date(Date.now() + 86400_000) });
    await add('Raising a pre-seed round', ['professional']);
    await add('Midterm on Friday', ['professional']);
    await add('Knee surgery recovery', ['networking']);
    await add('Class schedule: MWF 9am', ['school']);
    await h.store.addFact({ text: 'Bank account at Chase', kind: 'fact', topics: ['professional'], sourceAgent: 'claude', author: 'user', originEventId: null });
    const t = await approved(h, 'Find seed investors in climate', ['networking']);
    await h.hub.dispatchApproved();
    expect((await h.store.task(t.id))!.status).toBe('sent');
    const [brief] = h.email.sent;
    expect(brief.to).toBe('boardy@boardy.ai');
    expect(brief.text).toContain('Raising a pre-seed round');
    expect(brief.text).not.toMatch(/midterm|knee|surgery|class schedule|bank/i);
  });

  it('SC-05 get_situation for a restricted agent filters by text as well as tags', async () => {
    const h = await secureHub();
    await h.store.addSituation({ text: 'Studying for the linear algebra midterm', slot: null, topics: ['professional', 'work', 'content'], sourceAgent: 'claude', author: 'user', originEventId: null, expiresAt: new Date(Date.now() + 86400_000) });
    await h.store.addSituation({ text: 'Shipping the hub launch', slot: null, topics: ['professional', 'work', 'content'], sourceAgent: 'claude', author: 'user', originEventId: null, expiresAt: new Date(Date.now() + 86400_000) });
    const ev = await h.store.insertEvent({ agent: 'claude', occurredAt: new Date(), author: 'agent', rawExcerpt: '', summary: 'Ved talked about his therapist', topics: ['professional', 'work'], kind: 'session' });
    await h.store.updateEventAnalysis(ev.id, 'Ved talked about his therapist', ['professional', 'work']);
    for (const token of ['boardy-token', 'grok-token']) {
      const view = (await (await mcpClient(h.url, token))('get_situation')).text;
      expect(view).toContain('Shipping the hub launch');
      expect(view).not.toMatch(/midterm|therapist/);
    }
    // Full-scope agents see it all.
    expect((await (await mcpClient(h.url, 'claude-token'))('get_situation')).text).toContain('midterm');
  });

  it('SC-06 Stanley and Grok deny lists hold at delivery too, and disabled agents receive nothing', async () => {
    const h = await secureHub();
    const s = await approved(h, 'Film a video about my therapy journey', ['content'], 'stanley');
    const g = await approved(h, 'Put my salary in the README', ['work'], 'grok');
    const off = await approved(h, 'Fine task', ['work'], 'grok');
    await h.hub.dispatchApproved();
    expect((await h.store.task(s.id))!.status).toBe('blocked');
    expect((await h.store.task(g.id))!.status).toBe('blocked');
    expect((await h.store.task(off.id))!.status).toBe('sent');
    expect(h.telegram.chat).toEqual([]);
    await h.store.updateScope('grok', { ...DEFAULT_SCOPES.grok, enabled: false }, 'test');
    const after = await approved(h, 'Another fine task', ['work'], 'grok');
    await h.hub.dispatchApproved();
    expect((await h.store.task(after.id))!.status).toBe('blocked');
  });

  it('SC-07 the router-proposal path blocks too, and a blocked task can never be approved later', async () => {
    const h = await secureHub();
    const ev = await h.store.insertEvent({ agent: 'instinct', occurredAt: new Date(), author: 'user', rawExcerpt: 'x', summary: '', topics: [], kind: 'chat' });
    h.worker.next.push(() => ({ summary: 's', tasks: [{ target_agent: 'boardy', payload: 'Tell Boardy about my midterm', topics: ['networking'], evidence: [] }] }));
    await h.hub.routePending();
    const [t] = await h.store.recentTasks(1);
    expect(t.status).toBe('blocked');
    expect(ev.id).toBe(t.origin_event_id);
    expect(await h.hub.handleInbound({ channel: 'imessage', externalId: 'x', fromOwner: true, sender: 'me', text: `Y ${t.code}` })).toBe('stale');
    const session = await dashboardLogin(h.url);
    await fetch(`${h.url}/actions/task/${t.id}/approve`, { method: 'POST', redirect: 'manual', headers: session });
    await h.hub.dispatchApproved();
    expect((await h.store.task(t.id))!.status).toBe('blocked');
    expect(await sentToBoardy(h)).toEqual([]);
  });

  it('SC-08 checkDelivery is the same deterministic function at proposal and delivery time', () => {
    const boardy = { agent: 'boardy' as const, ...DEFAULT_SCOPES.boardy };
    expect(checkDelivery(boardy, 'Boardy', { payload: 'Intro to investors', topics: ['networking'] }).ok).toBe(true);
    expect(checkDelivery(boardy, 'Boardy', { payload: 'Intro to investors', topics: [] }).ok).toBe(false);
    expect(checkDelivery(boardy, 'Boardy', { payload: 'Intro to investors', topics: ['general'] }).ok).toBe(false);
    expect(checkDelivery({ ...boardy, deny_topics: [] }, 'Boardy', { payload: 'my midterm', topics: ['networking'] }).ok).toBe(false);
    expect(checkDelivery({ ...boardy, deny_topics: [] }, 'Boardy', { payload: 'x', topics: ['networking'] }, ['Knee surgery', 'Raising a seed']).context).toEqual(['Raising a seed']);
  });
});
