import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatDb } from '../../src/daemon/chatdb.js';
import { Daemon, type DaemonJob, type HeartbeatBody, type HubClient } from '../../src/daemon/daemon.js';
import type { MacOps } from '../../src/daemon/mac.js';
import { parseSleepDisabled } from '../../src/daemon/mac.js';
import { createLogger } from '../../src/shared/log.js';
import { buildChatDb } from '../fixtures/chatdb.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fakeMac() {
  const mac: MacOps & { awake: boolean; opened: number; prompts: number } = {
    awake: false,
    opened: 0,
    prompts: 0,
    async setKeepAwake(on) {
      mac.prompts++;
      mac.awake = on;
    },
    async keepAwake() {
      return mac.awake;
    },
    async openFullDiskAccess() {
      mac.opened++;
    },
  };
  return mac;
}

function harness(opts: { fda?: boolean; mac?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-jobs-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const day = 86_400_000;
  const fixture = buildChatDb(path.join(dir, 'chat.db'), [
    { handle: '+15550001111', text: 'Instinct: morning plan', at: new Date(Date.now() - 2 * 3600_000) },
    { handle: '+15550001111', text: 'thanks', fromMe: true, at: new Date(Date.now() - 3600_000) },
    { handle: 'friend@example.com', text: 'dinner?', at: new Date(Date.now() - 3 * day) },
    { handle: '+15550009999', text: 'group noise', group: true },
    { handle: '+15550007777', text: 'ancient', at: new Date(Date.now() - 200 * day) },
  ]);
  cleanups.push(() => fixture.close());
  const access = { granted: opts.fda ?? true };
  const jobs: DaemonJob[] = [];
  const finished: { id: number; ok: boolean; result?: unknown; error?: string }[] = [];
  const beats: HeartbeatBody[] = [];
  const hub: HubClient = {
    config: async () => ({ watchHandles: [], approvalHandle: null, pollIntervalMs: 5000, paused: false }),
    ingest: async () => undefined,
    outbox: async () => [],
    ack: async () => undefined,
    heartbeat: async (b) => void beats.push(b),
    jobs: async () => jobs.splice(0),
    finishJob: async (id, ok, result, error) => void finished.push({ id, ok, result, error }),
  };
  const mac = opts.mac === false ? undefined : fakeMac();
  let clock = Date.now();
  const d = new Daemon({
    chatDbPath: fixture.file,
    hub,
    state: { load: async () => ({ lastRowId: 0, knownHandles: [] }), save: async () => undefined },
    send: async () => undefined,
    log: createLogger({ test: true }),
    now: () => clock,
    mac,
    nodePath: '/opt/homebrew/bin/node',
    openDb: (file, busy) => {
      if (!access.granted) throw new Error('unable to open database file: authorization denied');
      return new ChatDb(file, { busyTimeoutMs: busy });
    },
  });
  cleanups.push(() => d.close());
  return { d, jobs, finished, beats, mac, access, advance: (ms: number) => (clock += ms) };
}

describe('daemon: Full Disk Access detection', () => {
  it('reports missing access, polls every 5s, and heartbeats the moment access is granted', async () => {
    const h = harness({ fda: false });
    const r = await h.d.cycle();
    expect(r.error).toMatch(/Full Disk Access to \/opt\/homebrew\/bin\/node/);
    expect(h.d.backoffMs).toBe(5_000);
    expect(h.beats.at(-1)).toMatchObject({ fullDiskAccess: false, nodePath: '/opt/homebrew/bin/node' });
    h.advance(5_000);
    await h.d.cycle();
    expect(h.d.backoffMs).toBe(5_000);
    const before = h.beats.length;
    h.access.granted = true;
    h.advance(5_000);
    const ok = await h.d.cycle();
    expect(ok.error).toBeNull();
    expect(h.beats).toHaveLength(before + 1);
    expect(h.beats.at(-1)).toMatchObject({ fullDiskAccess: true, error: null });
  });
});

describe('daemon: dashboard jobs', () => {
  it('list-threads returns recent 1:1 threads with counts and no message text', async () => {
    const h = harness();
    h.jobs.push({ id: 1, kind: 'list-threads', args: { days: 30 } });
    await h.d.cycle();
    expect(h.finished).toHaveLength(1);
    const { ok, result } = h.finished[0];
    expect(ok).toBe(true);
    const threads = (result as { threads: { handle: string; messages: number; fromThem: number }[] }).threads;
    expect(threads.map((t) => t.handle)).toEqual(['+15550001111', 'friend@example.com']);
    expect(threads[0]).toMatchObject({ messages: 2, fromThem: 1 });
    expect(JSON.stringify(result)).not.toMatch(/morning plan|dinner|thanks/);
  });

  it('list-threads fails cleanly without Full Disk Access, and other jobs still run', async () => {
    const h = harness({ fda: false });
    h.jobs.push({ id: 1, kind: 'list-threads', args: {} }, { id: 2, kind: 'open-settings', args: { pane: 'full-disk-access' } });
    await h.d.cycle();
    expect(h.finished.map((f) => [f.id, f.ok])).toEqual([[1, false], [2, true]]);
    expect(h.finished[0].error).toMatch(/Full Disk Access/);
    expect(h.mac!.opened).toBe(1);
  });

  it('keep-awake toggles pmset through MacOps and reports the new state at once', async () => {
    const h = harness();
    await h.d.cycle();
    h.jobs.push({ id: 3, kind: 'keep-awake', args: { on: true } });
    h.advance(1000);
    await h.d.cycle();
    expect(h.mac!.awake).toBe(true);
    expect(h.finished[0]).toMatchObject({ id: 3, ok: true, result: { keepAwake: true } });
    expect(h.beats.at(-1)).toMatchObject({ keepAwake: true });
    h.jobs.push({ id: 4, kind: 'keep-awake', args: { on: 'yes' } });
    h.advance(1000);
    await h.d.cycle();
    // Only a literal `true` turns it on.
    expect(h.mac!.awake).toBe(false);
  });

  it('Mac-only jobs fail with a clear message when the daemon has no MacOps', async () => {
    const h = harness({ mac: false });
    h.jobs.push({ id: 5, kind: 'keep-awake', args: { on: true } });
    await h.d.cycle();
    expect(h.finished[0]).toMatchObject({ id: 5, ok: false });
    expect(h.finished[0].error).toMatch(/macOS/);
  });

  it('parses pmset output for SleepDisabled', () => {
    expect(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:')).toBe(true);
    expect(parseSleepDisabled(' SleepDisabled\t\t0')).toBe(false);
    expect(parseSleepDisabled('nothing here')).toBeNull();
  });
});
