import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Daemon, HubHttpError, fileStateStore, type DaemonState, type HubClient, type StateStore } from '../../src/daemon/daemon.js';
import { createLogger } from '../../src/shared/log.js';
import type { DaemonMessage } from '../../src/shared/types.js';
import { HANDLES } from '../helpers.js';
import { buildChatDb, type FixtureRow } from '../fixtures/chatdb.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hubd-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface HarnessOpts {
  rows: FixtureRow[];
  rejectText?: string;
  failIngest?: number;
  /** null = first run (no checkpoint yet). */
  state?: DaemonState | null;
  stateStore?: StateStore;
  watch?: string[];
  backfillHours?: number;
  newHandleBackfillHours?: number;
  pageSize?: number;
}

function harness(opts: HarnessOpts) {
  const dir = tempDir();
  const fixture = buildChatDb(path.join(dir, 'chat.db'), opts.rows);
  cleanups.push(() => fixture.close());
  const shipped: DaemonMessage[] = [];
  const batches: number[][] = [];
  const acks: [number, boolean][] = [];
  let failures = opts.failIngest ?? 0;
  const outbox: { id: number; toHandle: string; body: string }[] = [];
  const sent: string[] = [];
  let state: DaemonState | null = opts.state === undefined ? { lastRowId: 0, knownHandles: [] } : opts.state;
  const cfg = { watchHandles: opts.watch ?? [HANDLES.instinct, HANDLES.stanley], approvalHandle: null, pollIntervalMs: 5000, paused: false };
  const hub: HubClient = {
    config: async () => cfg,
    ingest: async (messages) => {
      if (failures > 0) {
        failures--;
        throw new Error('ECONNREFUSED');
      }
      if (opts.rejectText && messages.some((m) => m.text === opts.rejectText)) throw new HubHttpError(400, 'bad');
      batches.push(messages.map((m) => m.rowid));
      shipped.push(...messages);
    },
    outbox: async () => outbox.splice(0),
    ack: async (id, ok) => {
      acks.push([id, ok]);
    },
    heartbeat: async () => undefined,
  };
  let clock = Date.now();
  const stateStore = opts.stateStore ?? { load: async () => structuredClone(state), save: async (s: DaemonState) => void (state = structuredClone(s)) };
  const make = () => {
    const d = new Daemon({
      chatDbPath: fixture.file,
      hub,
      state: stateStore,
      send: async (_h, body) => void sent.push(body),
      log: createLogger({ test: true }),
      pageSize: opts.pageSize ?? 3,
      backfillHours: opts.backfillHours,
      newHandleBackfillHours: opts.newHandleBackfillHours,
      now: () => clock,
    });
    cleanups.push(() => d.close());
    return d;
  };
  return { d: make(), restart: make, cfg, shipped, batches, acks, outbox, sent, fixture, getState: () => state, advance: (ms: number) => (clock += ms) };
}

const texts = (ms: DaemonMessage[]) => ms.map((m) => m.text);

describe('daemon: ROWID checkpointing', () => {
  it('first run starts at the newest message, so history is never dumped on the hub', async () => {
    const h = harness({ rows: [{ handle: HANDLES.instinct, text: 'old 1' }, { handle: HANDLES.instinct, text: 'old 2' }], state: null });
    await h.d.cycle();
    expect(h.shipped).toEqual([]);
    expect(h.getState()!.lastRowId).toBe(2);
    h.fixture.add({ handle: HANDLES.instinct, text: 'new' });
    await h.d.cycle();
    expect(texts(h.shipped)).toEqual(['new']);
  });

  it('first run with a backfill window ships only messages inside it', async () => {
    const hourAgo = (n: number) => new Date(Date.now() - n * 3600_000);
    const h = harness({
      rows: [
        { handle: HANDLES.instinct, text: 'three days ago', at: hourAgo(72) },
        { handle: HANDLES.instinct, text: 'this morning', at: hourAgo(5) },
        { handle: HANDLES.stanley, text: 'just now', at: hourAgo(0) },
      ],
      state: null,
      backfillHours: 24,
    });
    await h.d.cycle();
    expect(texts(h.shipped)).toEqual(['this morning', 'just now']);
  });

  it('a restart resumes from the checkpoint: nothing duplicated, nothing lost', async () => {
    const h = harness({ rows: Array.from({ length: 7 }, (_, i) => ({ handle: HANDLES.instinct, text: `m${i + 1}` })) });
    await h.d.cycle();
    expect(h.getState()!.lastRowId).toBe(7);
    h.d.close();
    h.fixture.addMany([{ handle: HANDLES.instinct, text: 'm8' }, { handle: HANDLES.stanley, text: 'm9' }]);
    const d2 = h.restart();
    await d2.cycle();
    await d2.cycle();
    expect(texts(h.shipped)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(new Set(h.shipped.map((m) => m.guid)).size).toBe(9);
  });

  it('pages in ROWID order and checkpoints after every accepted page', async () => {
    const saves: number[] = [];
    let state: DaemonState | null = { lastRowId: 0, knownHandles: [] };
    const h = harness({
      rows: Array.from({ length: 8 }, (_, i) => ({ handle: i % 2 ? HANDLES.stanley : HANDLES.instinct, text: `m${i + 1}` })),
      stateStore: { load: async () => state, save: async (s) => void (saves.push(s.lastRowId), (state = structuredClone(s))) },
    });
    await h.d.cycle();
    expect(h.batches).toEqual([[1, 2, 3], [4, 5, 6], [7, 8]]);
    expect(saves.filter((v, i, a) => a.indexOf(v) === i)).toEqual(expect.arrayContaining([3, 6, 8]));
  });

  it('advances past unwatched, tapback and group rows without forwarding them', async () => {
    const h = harness({
      rows: [
        { handle: HANDLES.instinct, text: 'keep 1' },
        { handle: '+15553334444', text: 'a friend' },
        { handle: HANDLES.instinct, text: 'Loved “keep 1”', associatedType: 2000 },
        { handle: HANDLES.instinct, text: 'group chatter', group: true },
        { handle: HANDLES.instinct, text: 'keep 2', attributed: true },
        { handle: HANDLES.instinct, text: 'reply from me', fromMe: true },
      ],
    });
    await h.d.cycle();
    expect(h.shipped.map((m) => [m.text, m.isFromMe])).toEqual([
      ['keep 1', false],
      ['keep 2', false],
      ['reply from me', true],
    ]);
    expect(h.getState()!.lastRowId).toBe(6);
  });

  it('a handle added to the hub config later gets its recent history once', async () => {
    const h = harness({ rows: [{ handle: HANDLES.instinct, text: 'i1' }, { handle: HANDLES.boardy, text: 'b1' }], state: null, watch: [HANDLES.instinct] });
    await h.d.cycle();
    h.fixture.add({ handle: HANDLES.boardy, text: 'b2' });
    await h.d.cycle();
    expect(h.shipped).toEqual([]);
    h.cfg.watchHandles.push(HANDLES.boardy);
    h.advance(61_000); // config refresh interval
    await h.d.cycle();
    expect(texts(h.shipped)).toEqual(['b1', 'b2']);
    h.advance(61_000);
    await h.d.cycle();
    expect(texts(h.shipped)).toEqual(['b1', 'b2']);
  });

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
    expect(texts(h.shipped)).toEqual(['one', 'two', 'four', 'six']);
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
    expect(h.d.backoffMs).toBeGreaterThan(0);
    h.advance(10_000);
    await h.d.cycle();
    expect(texts(h.shipped)).toEqual(['a', 'b']);
    expect(h.d.backoffMs).toBe(0);
  });

  it('detects a wake from sleep and reopens chat.db', async () => {
    const h = harness({ rows: [{ handle: HANDLES.instinct, text: 'before' }] });
    await h.d.cycle();
    h.advance(12 * 3600_000);
    h.fixture.add({ handle: HANDLES.instinct, text: 'after sleep' });
    const r = await h.d.cycle();
    expect(r.resumedAfterMs).toBe(12 * 3600_000);
    expect(texts(h.shipped)).toEqual(['before', 'after sleep']);
  });
});

describe('daemon: checkpoint file', () => {
  it('writes atomically, keeps a backup, and leaves no temp files', async () => {
    const file = path.join(tempDir(), 'nested', 'state.json');
    const s = fileStateStore(file);
    expect(await s.load()).toBeNull();
    await s.save({ lastRowId: 5, knownHandles: ['5550001111'] });
    await s.save({ lastRowId: 9, knownHandles: ['5550001111'] });
    expect(await s.load()).toEqual({ lastRowId: 9, knownHandles: ['5550001111'] });
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).lastRowId).toBe(5);
    expect(readdirSync(path.dirname(file)).sort()).toEqual(['state.json', 'state.json.bak']);
  });

  it('falls back to the previous checkpoint when the current one is corrupt', async () => {
    const file = path.join(tempDir(), 'state.json');
    const s = fileStateStore(file);
    await s.save({ lastRowId: 5 });
    await s.save({ lastRowId: 9 });
    writeFileSync(file, '{"lastRowId": 9'); // torn write
    expect((await s.load())!.lastRowId).toBe(5);
  });

  it('refuses to guess when no checkpoint is readable, instead of restarting at the newest message', async () => {
    const file = path.join(tempDir(), 'state.json');
    writeFileSync(file, 'garbage');
    const s = fileStateStore(file);
    await expect(s.load()).rejects.toThrow(/unreadable/);
    writeFileSync(file, JSON.stringify({ lastRowId: -1 }));
    await expect(s.load()).rejects.toThrow(/unreadable/);

    const h = harness({ rows: [{ handle: HANDLES.instinct, text: 'backlog' }], stateStore: s });
    const r = await h.d.cycle();
    expect(r.error).toMatch(/unreadable/);
    expect(h.shipped).toEqual([]);
  });
});
