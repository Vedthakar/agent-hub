import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { situationFor } from '../../src/hub/context.js';
import { applyRouterOutput, type RouterOutput } from '../../src/hub/router.js';
import type { EventRow } from '../../src/hub/store.js';
import { makeHub } from '../helpers.js';

let ctx: Awaited<ReturnType<typeof makeHub>>;
beforeEach(async () => {
  ctx = await makeHub({}, null, {}, { backend: 'pglite' });
});
afterEach(async () => {
  await ctx.db.close();
});

const H = 3600_000;
const at = (ms: number) => new Date(Date.now() + ms);
const add = (text: string, o: { slot?: string; from?: number; to?: number | null; event?: number | null; topics?: string[] } = {}) =>
  ctx.store.addSituation({
    text,
    slot: o.slot ?? null,
    topics: o.topics ?? ['schedule'],
    sourceAgent: 'claude',
    author: 'user',
    originEventId: o.event ?? null,
    validFrom: at(o.from ?? -60_000),
    expiresAt: o.to === null ? null : at(o.to ?? H),
  });
const live = async (when = new Date()) => (await ctx.store.liveSituation(when)).map((s) => s.text);
const event = (agent: EventRow['agent'] = 'claude') =>
  ctx.store.insertEvent({ agent, occurredAt: new Date(), author: 'user', rawExcerpt: 'x', summary: '', topics: [], kind: 'chat', hop: 0 });
const output = (o: Partial<RouterOutput>): RouterOutput => ({ summary: 's', topics: [], situation: [], supersede_situation_ids: [], facts: [], retire_fact_ids: [], tasks: [], ...o });

describe('situation TTL', () => {
  it('is live only between valid_from and expires_at', async () => {
    await add('now', { to: H });
    await add('expired', { from: -2 * H, to: -60_000 });
    await add('tomorrow', { from: 12 * H, to: 36 * H });
    await add('forever', { to: null });
    expect((await live()).sort()).toEqual(['forever', 'now']);
    expect((await live(at(13 * H))).sort()).toEqual(['forever', 'tomorrow']);
    expect(await live(at(40 * H))).toEqual(['forever']);
  });

  it('router items default to 24h, and already-expired or blank items are dropped', async () => {
    const e = await event();
    await applyRouterOutput(ctx.store, ctx.cfg, e, output({
      situation: [
        { text: 'no expiry given', slot: null, topics: [], evidence: [] },
        { text: 'stale', slot: null, topics: [], expires_at: at(-H).toISOString(), evidence: [] },
        { text: '   ', slot: null, topics: [], evidence: [] },
        { text: 'bad dates', slot: null, topics: [], valid_from: 'tomorrow-ish', expires_at: 'soon', evidence: [] },
      ],
    }));
    const rows = await ctx.store.db.query<{ text: string; valid_from: Date; expires_at: Date }>('SELECT * FROM situation ORDER BY id');
    expect(rows.map((r) => r.text)).toEqual(['no expiry given', 'bad dates']);
    for (const r of rows) {
      const ttl = new Date(r.expires_at).getTime() - new Date(r.valid_from).getTime();
      expect(ttl).toBe(24 * H);
    }
  });
});

describe('situation supersession', () => {
  it('a new item in a slot replaces the old one from an earlier conversation', async () => {
    const e1 = await event();
    const old = await add('in an assessment', { slot: 'now:activity', event: e1.id });
    const e2 = await event();
    await add('back at my desk', { slot: 'now:activity', event: e2.id });
    expect(await live()).toEqual(['back at my desk']);
    const [row] = await ctx.store.db.query<{ superseded_by: number }>('SELECT superseded_by FROM situation WHERE id = $1', [old.id]);
    expect(row.superseded_by).not.toBeNull();
  });

  it('items from the same conversation share a slot without replacing each other (debrief plan)', async () => {
    const e = await event('instinct');
    await applyRouterOutput(ctx.store, ctx.cfg, e, output({
      situation: ['study 9–11', 'shoot at 3', 'gym at 6'].map((text) => ({ text, slot: 'plan:tomorrow', topics: ['plan'], evidence: [] as string[] })),
    }));
    expect((await live()).sort()).toEqual(['gym at 6', 'shoot at 3', 'study 9–11']);
    // The next night's debrief replaces the whole plan.
    const e2 = await event('instinct');
    await applyRouterOutput(ctx.store, ctx.cfg, e2, output({ situation: [{ text: 'rest day', slot: 'plan:tomorrow', topics: ['plan'], evidence: [] }] }));
    expect(await live()).toEqual(['rest day']);
  });

  it('explicit supersede ids only touch items that are live (no reaching into history or unknown ids)', async () => {
    const liveItem = await add('paused open source');
    const expired = await add('old', { from: -3 * H, to: -H });
    const e = await event();
    await applyRouterOutput(ctx.store, ctx.cfg, e, output({ supersede_situation_ids: [liveItem.id, expired.id, 99_999] }));
    const rows = await ctx.store.db.query<{ id: number; superseded_at: Date | null }>('SELECT id, superseded_at FROM situation ORDER BY id');
    expect(rows.map((r) => [r.id, r.superseded_at !== null])).toEqual([[liveItem.id, true], [expired.id, false]]);
  });

  it('superseded items disappear from every agent’s get_situation', async () => {
    const a = await add('shoot today', { slot: 'shoot', topics: ['shoots'] });
    expect((await situationFor(ctx.store, 'stanley')).situation.map((s) => s.id)).toContain(a.id);
    await ctx.store.supersedeSituation([a.id], null);
    for (const agent of ['stanley', 'claude', 'instinct'] as const) {
      expect((await situationFor(ctx.store, agent)).situation.map((s) => s.id)).not.toContain(a.id);
    }
  });
});

describe('facts', () => {
  it('ignores case-insensitive duplicates and retires by id', async () => {
    const e = await event();
    await applyRouterOutput(ctx.store, ctx.cfg, e, output({
      facts: [
        { text: 'Goal: ship Agent Hub v1', kind: 'goal', topics: ['projects'], evidence: [] },
        { text: 'goal: ship agent hub v1', kind: 'goal', topics: ['projects'], evidence: [] },
      ],
    }));
    const facts = await ctx.store.activeFacts();
    expect(facts).toHaveLength(1);
    await applyRouterOutput(ctx.store, ctx.cfg, await event(), output({ retire_fact_ids: [facts[0].id] }));
    expect(await ctx.store.activeFacts()).toHaveLength(0);
  });
});
