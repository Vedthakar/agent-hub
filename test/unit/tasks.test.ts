import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../../src/hub/store.js';
import { proposeTask } from '../../src/hub/tasks.js';
import type { AgentId } from '../../src/shared/types.js';
import { makeHub } from '../helpers.js';

let ctx: Awaited<ReturnType<typeof makeHub>>;
beforeAll(async () => {
  ctx = await makeHub({}, null, {}, { backend: 'pglite' });
});
afterAll(async () => {
  await ctx.db.close();
});

let n = 0;
const propose = (target: AgentId, payload: string, extra: Partial<Parameters<typeof proposeTask>[1]> = {}, maxHops = 2) =>
  proposeTask(ctx.store, { originAgent: 'claude', targetAgent: target, payload, rationale: '', topics: ['content'], author: 'user', originEventId: null, hop: 1, ...extra }, maxHops);
const unique = (s: string) => `${s} #${++n}`;

describe('dedupKey', () => {
  it('ignores case, punctuation and spacing but not the target', () => {
    const k = Store.dedupKey('stanley', 'Write a 60-second script!');
    expect(Store.dedupKey('stanley', '  write a 60 second   script ')).toBe(k);
    expect(Store.dedupKey('boardy', 'Write a 60-second script!')).not.toBe(k);
  });

  it('keeps non-English text and emoji distinct (they are not stripped to an empty key)', () => {
    expect(Store.dedupKey('stanley', 'guion del vídeo 🎬')).not.toBe(Store.dedupKey('stanley', 'guion del vídeo'));
    expect(Store.dedupKey('stanley', '台本を書いて')).not.toBe(Store.dedupKey('stanley', '動画を撮って'));
    expect(Store.dedupKey('stanley', 'ﬁlm it')).toBe(Store.dedupKey('stanley', 'film it')); // NFKC ligature
  });
});

describe('proposeTask: validation', () => {
  it('rejects self-targeting, empty payloads and agents that cannot receive tasks', async () => {
    expect(await propose('claude', 'x')).toMatchObject({ kind: 'invalid', reason: 'task targets its own origin agent' });
    expect(await propose('stanley', '   ')).toMatchObject({ kind: 'invalid', reason: 'empty task' });
    expect(await propose('nobody' as AgentId, 'x')).toMatchObject({ kind: 'invalid', reason: 'unknown agent nobody' });
  });
});

describe('proposeTask: hop limit', () => {
  it('allows hop == maxHops and blocks hop == maxHops + 1', async () => {
    expect((await propose('stanley', unique('hop two'), { hop: 2 })).kind).toBe('created');
    const r = await propose('stanley', unique('hop three'), { hop: 3 });
    expect(r).toMatchObject({ kind: 'blocked', reason: 'hop limit (3 > 2)' });
    expect((await propose('stanley', unique('hop one, max 0'), { hop: 1 }, 0)).kind).toBe('blocked');
  });

  it('records the blocked task, so the loop is visible on the dashboard', async () => {
    const r = await propose('grok', unique('loop'), { hop: 5, topics: ['work'] });
    expect(r.kind).toBe('blocked');
    if (r.kind !== 'blocked') return;
    expect((await ctx.store.task(r.task.id))!.status).toBe('blocked');
  });
});

describe('proposeTask: dedup', () => {
  it('folds a repeat of an open task into the existing one', async () => {
    const payload = unique('Write a script about the launch');
    const first = await propose('stanley', payload);
    expect(first.kind).toBe('created');
    const again = await propose('stanley', `${payload.toUpperCase()}!!`);
    expect(again.kind).toBe('duplicate');
    if (first.kind === 'created' && again.kind === 'duplicate') expect(again.existing.id).toBe(first.task.id);
  });

  it.each([
    ['rejected', 'duplicate'],
    ['cancelled', 'duplicate'],
    ['sent', 'duplicate'],
    ['done', 'duplicate'],
    ['failed', 'created'],
    ['expired', 'created'],
  ])('a prior %s task → %s', async (status, expected) => {
    const payload = unique(`status ${status}`);
    const first = await propose('stanley', payload);
    if (first.kind !== 'created') throw new Error('setup');
    await ctx.store.db.query('UPDATE tasks SET status = $2 WHERE id = $1', [first.task.id, status]);
    expect((await propose('stanley', payload)).kind).toBe(expected);
  });

  it('only dedups within 24 hours', async () => {
    const payload = unique('weekly recap video');
    const first = await propose('stanley', payload);
    if (first.kind !== 'created') throw new Error('setup');
    await ctx.store.db.query("UPDATE tasks SET created_at = now() - interval '25 hours' WHERE id = $1", [first.task.id]);
    expect((await propose('stanley', payload)).kind).toBe('created');
  });

  it('allocates unambiguous 4-character codes', async () => {
    const r = await propose('stanley', unique('code check'));
    if (r.kind !== 'created') throw new Error('setup');
    expect(r.task.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  });
});
