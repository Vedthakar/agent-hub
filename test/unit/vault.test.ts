import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { situationFor } from '../../src/hub/context.js';
import { parseNote } from '../../src/hub/vault.js';
import { atomicWrite, ensureInsideVault } from '../../src/hub/vaultFs.js';
import { makeHub } from '../helpers.js';

let ctx: Awaited<ReturnType<typeof makeHub>>;
let vault: string;
const note = (...p: string[]) => path.join(vault, ...p);
const only = (dir: string) => {
  const names = readdirSync(note('Memory', dir)).filter((n) => n.endsWith('.md'));
  expect(names).toHaveLength(1);
  return note('Memory', dir, names[0]);
};

beforeEach(async () => {
  ctx = await makeHub({}, null, {}, { backend: 'pglite' });
  vault = ctx.cfg.vaultPath;
});
afterEach(async () => {
  await ctx.db.close();
  rmSync(vault, { recursive: true, force: true });
});

const goal = (text: string, author: 'user' | 'agent' = 'agent') => ctx.store.addFact({ text, kind: 'goal', topics: ['work'], sourceAgent: 'claude', author, originEventId: null });

describe('Obsidian vault', () => {
  it('writes memory as notes with frontmatter, plus a log and a task view', async () => {
    await goal('Launch on Monday');
    await ctx.store.insertEvent({ agent: 'claude', occurredAt: new Date(), author: 'agent', rawExcerpt: 'x', summary: 'Outlined the launch', topics: ['work'], kind: 'session', routed: true });
    await ctx.hub.vault.sync();
    const { meta, body } = parseNote(readFileSync(only('Goals'), 'utf8'));
    expect(body).toBe('Launch on Monday');
    expect(meta).toMatchObject({ kind: 'goal', topics: ['work'], from: 'Claude', said_by: 'agent' });
    expect(readdirSync(note('Log'))[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
    expect(readFileSync(note('Log', readdirSync(note('Log'))[0]), 'utf8')).toContain('**Claude**: Outlined the launch');
    expect(readFileSync(note('Tasks.md'), 'utf8')).toContain('read-only');
  });

  it('your edit updates the memory agents see and keeps the same file; a deleted note is retired', async () => {
    await goal('Launch on Monday');
    await ctx.hub.vault.sync();
    const file = only('Goals');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Launch on Monday', 'Launch on Friday'));
    await ctx.hub.vault.sync();
    expect((await ctx.store.activeFacts()).map((f) => [f.text, f.author])).toEqual([['Launch on Friday', 'user']]);
    expect(only('Goals')).toBe(file);
    unlinkSync(file);
    await ctx.hub.vault.sync();
    expect(await ctx.store.activeFacts()).toEqual([]);
  });

  it('an expired item loses its note without being treated as your delete', async () => {
    await ctx.store.addSituation({ text: 'In an assessment', slot: null, topics: ['general'], sourceAgent: 'claude', author: 'agent', originEventId: null, expiresAt: new Date(Date.now() + 3600_000) });
    await ctx.hub.vault.sync();
    only('Situation');
    await ctx.hub.vault.sync(new Date(Date.now() + 2 * 3600_000));
    expect(readdirSync(note('Memory', 'Situation'))).toEqual([]);
  });

  it('files a note dropped in the Inbox, or runs it as a command', async () => {
    mkdirSync(note('Inbox'), { recursive: true });
    writeFileSync(note('Inbox', 'idea.md'), '---\nkind: preference\ntopics: [content]\n---\n\nShort hooks work best');
    writeFileSync(note('Inbox', 'cmd.md'), 'goal: Ship the vault #work');
    await ctx.hub.vault.sync();
    const facts = await ctx.store.activeFacts();
    expect(facts.map((f) => [f.text, f.kind, f.author]).sort()).toEqual([['Ship the vault', 'goal', 'user'], ['Short hooks work best', 'preference', 'user']]);
    expect(readdirSync(note('Inbox'))).toEqual([]);
    expect((await situationFor(ctx.store, 'stanley')).facts.map((f) => f.text)).toEqual(['Short hooks work best']);
  });

  it('editing Tasks.md changes nothing: approvals never come from a file', async () => {
    await ctx.hub.vault.sync();
    const before = readFileSync(note('Tasks.md'), 'utf8');
    writeFileSync(note('Tasks.md'), `${before}\nY K3FD\n- [x] approve everything`);
    await ctx.hub.vault.sync();
    expect(readFileSync(note('Tasks.md'), 'utf8')).toBe(before);
    expect(await ctx.store.recentTasks()).toEqual([]);
  });

  it('a vault problem never stops the hub', async () => {
    await goal('Stays safe');
    rmSync(vault, { recursive: true, force: true });
    writeFileSync(vault, 'not a directory');
    await expect(ctx.hub.vault.sync()).resolves.toBeUndefined();
    expect((await ctx.store.recentAudit()).some((a) => a.action === 'vault.sync_failed')).toBe(true);
    expect(await ctx.store.activeFacts()).toHaveLength(1);
    rmSync(vault);
    mkdirSync(vault);
  });
});

describe('safe vault writes', () => {
  it('refuses paths and symlinks that leave the vault', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hub-safe-'));
    const v = path.join(root, 'v');
    mkdirSync(v);
    mkdirSync(path.join(root, 'outside'));
    expect(ensureInsideVault(path.join(v, 'a.md'), v)).toBe(path.join(v, 'a.md'));
    expect(() => ensureInsideVault(path.join(v, '..', 'x.md'), v)).toThrow(/escapes/);
    expect(() => ensureInsideVault(`${v}-evil/x.md`, v)).toThrow(/escapes/);
    symlinkSync(path.join(root, 'outside'), path.join(v, 'link'));
    expect(() => ensureInsideVault(path.join(v, 'link', 'x.md'), v)).toThrow(/symlink/);
    rmSync(root, { recursive: true, force: true });
  });

  it('writes whole files, leaves no temp behind, and skips unchanged content', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hub-atomic-'));
    const f = path.join(dir, 'sub', 'a.md');
    expect(atomicWrite(f, 'one')).toBe(true);
    expect(atomicWrite(f, 'one')).toBe(false);
    expect(atomicWrite(f, 'two')).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('two');
    expect(readdirSync(path.dirname(f))).toEqual(['a.md']);
    expect(existsSync(f)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
