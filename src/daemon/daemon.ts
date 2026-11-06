import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonConfig, DaemonMessage, OutboxItem } from '../shared/types.js';
import type { Logger } from '../shared/log.js';
import { ChatDb, normalizeHandle } from './chatdb.js';
import type { MacOps } from './mac.js';

export const DAEMON_VERSION = '0.4.0';

export interface DaemonState {
  lastRowId: number;
  /** Handles already backfilled, so a handle added later in the hub's config gets its recent history once. */
  knownHandles?: string[];
  /** ROWIDs the hub refused individually (poison pills). Kept for the record; never re-sent. */
  skipped?: number[];
  /** Outbox ids already sent. If an ack is lost the hub re-offers the item; this stops a second text. */
  sentOutbox?: number[];
}

export class HubHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface HeartbeatBody {
  lastRowId: number;
  error: string | null;
  version: string;
  resumedAfterMs?: number;
  fullDiskAccess?: boolean | null;
  keepAwake?: boolean | null;
  nodePath?: string;
}

export interface DaemonJob {
  id: number;
  kind: 'list-threads' | 'keep-awake' | 'open-settings' | 'read-history';
  args: Record<string, unknown>;
}

export interface HubClient {
  config(): Promise<DaemonConfig>;
  ingest(messages: DaemonMessage[]): Promise<unknown>;
  outbox(): Promise<OutboxItem[]>;
  ack(id: number, ok: boolean, error?: string): Promise<void>;
  heartbeat(body: HeartbeatBody): Promise<void>;
  /** Work queued from the dashboard. Optional so older hubs (and tests) without it still work. */
  jobs?(): Promise<DaemonJob[]>;
  finishJob?(id: number, ok: boolean, result?: unknown, error?: string): Promise<void>;
}

export function httpHubClient(baseUrl: string, token: string, timeoutMs = 20_000): HubClient {
  const url = baseUrl.replace(/\/$/, '');
  async function call<T>(method: 'GET' | 'POST', route: string, body?: unknown, timeout = timeoutMs): Promise<T> {
    const res = await fetch(`${url}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    // The hub's error body never echoes message text, but cap it anyway.
    if (!res.ok) throw new HubHttpError(res.status, `${method} ${route} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return (await res.json()) as T;
  }
  return {
    config: () => call('GET', '/daemon/config'),
    ingest: (messages) => call('POST', '/daemon/ingest', { messages }),
    outbox: async () => (await call<{ items: OutboxItem[] }>('GET', '/daemon/outbox')).items,
    ack: async (id, ok, error) => {
      await call('POST', `/daemon/outbox/${id}/ack`, { ok, error });
    },
    heartbeat: async (body) => {
      await call('POST', '/daemon/heartbeat', body);
    },
    jobs: async () => (await call<{ jobs: DaemonJob[] }>('GET', '/daemon/jobs')).jobs,
    finishJob: async (id, ok, result, error) => {
      // A history page is the whole conversation so far for that slice. Give it longer than a heartbeat.
      await call('POST', `/daemon/jobs/${id}`, { ok, result, error }, 120_000);
    },
  };
}

/** Trades a one-time pairing code from the dashboard for this daemon's own token. */
export async function pairWithHub(baseUrl: string, code: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/daemon/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? `pairing failed (${res.status})`);
  return body.token;
}

export interface StateStore {
  load(): Promise<DaemonState | null>;
  save(state: DaemonState): Promise<void>;
}

function parseState(raw: string): DaemonState {
  const s = JSON.parse(raw) as DaemonState;
  if (!s || typeof s !== 'object' || !Number.isSafeInteger(s.lastRowId) || s.lastRowId < 0) throw new Error('bad checkpoint');
  return s;
}

/**
 * Atomic writes, plus the previous checkpoint kept in `<file>.bak`. A missing file means first run;
 * an unreadable one is an error rather than a first run, since a first run starts at the newest message
 * and would silently drop everything since the last good checkpoint.
 */
export function fileStateStore(file: string): StateStore {
  const backup = `${file}.bak`;
  const read = async (f: string): Promise<DaemonState | 'missing' | 'corrupt'> => {
    let raw: string;
    try {
      raw = await readFile(f, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw err;
    }
    try {
      return parseState(raw);
    } catch {
      return 'corrupt';
    }
  };
  return {
    async load() {
      const main = await read(file);
      if (typeof main === 'object') return main;
      const prev = await read(backup);
      if (typeof prev === 'object') return prev;
      if (main === 'missing' && prev === 'missing') return null;
      throw new Error(`daemon checkpoint ${file} is unreadable; fix or delete it (deleting restarts from the newest message)`);
    },
    async save(state) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state));
      await copyFile(file, backup).catch(() => undefined);
      await rename(tmp, file);
    },
  };
}

export interface DaemonOptions {
  chatDbPath: string;
  hub: HubClient;
  state: StateStore;
  send(handle: string, body: string): Promise<void>;
  log: Logger;
  /** First-run backfill window; 0 starts at the newest message. */
  backfillHours?: number;
  /** History fetched once for a handle that appears in the hub config later. */
  newHandleBackfillHours?: number;
  pageSize?: number;
  busyTimeoutMs?: number;
  /** A gap this much larger than the poll interval is treated as the Mac having slept. */
  sleepGapFactor?: number;
  now?: () => number;
  openDb?: (path: string, busyTimeoutMs: number) => ChatDb;
  /** Keep-awake and System Settings; omitted off macOS and in most tests. */
  mac?: MacOps;
  /** The binary that needs Full Disk Access (process.execPath). */
  nodePath?: string;
}

export interface CycleReport {
  shipped: number;
  pages: number;
  sent: number;
  skipped: number;
  resumedAfterMs: number | null;
  error: string | null;
}

const RECOVERABLE_DB = /SQLITE_BUSY|database is locked|SQLITE_IOERR|disk I\/O|malformed|SQLITE_CORRUPT|no such table|SQLITE_CANTOPEN|unable to open|SQLITE_READONLY_RECOVERY|not a database|database schema has changed/i;
const NO_FDA = /authoriz|permission|EPERM|operation not permitted/i;
const MAX_SKIPPED_KEPT = 500;

/**
 * The Mac daemon's loop body. One `cycle()` drains chat.db past the checkpoint (shipping pages in ROWID
 * order and advancing the checkpoint only after the hub accepts a page), sends queued approval texts,
 * and heartbeats. It never throws: every failure is reported and retried on the next cycle.
 */
export class Daemon {
  private db: ChatDb | null = null;
  private state: DaemonState | null = null;
  private config: DaemonConfig | null = null;
  private configAt = 0;
  private lastHeartbeat = 0;
  private lastCycleAt: number | null = null;
  lastError: string | null = null;
  backoffMs = 0;
  /** null until the first attempt to open chat.db. */
  fullDiskAccess: boolean | null = null;
  private keepAwake: boolean | null = null;
  private reported: { fda: boolean | null; awake: boolean | null } = { fda: null, awake: null };

  constructor(private o: DaemonOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private open(): ChatDb {
    const busy = this.o.busyTimeoutMs ?? 5_000;
    try {
      return this.o.openDb ? this.o.openDb(this.o.chatDbPath, busy) : new ChatDb(this.o.chatDbPath, { busyTimeoutMs: busy });
    } catch (err) {
      if (NO_FDA.test(String(err)) || /unable to open/i.test(String(err))) {
        this.fullDiskAccess = false;
        throw new Error(
          `Cannot open ${this.o.chatDbPath}. Grant Full Disk Access to ${this.o.nodePath ?? process.execPath} in System Settings → Privacy & Security → Full Disk Access, then restart the daemon.`,
        );
      }
      throw err;
    }
  }

  private closeDb() {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
  }

  get checkpoint(): number | null {
    return this.state?.lastRowId ?? null;
  }

  async cycle(): Promise<CycleReport> {
    const report: CycleReport = { shipped: 0, pages: 0, sent: 0, skipped: 0, resumedAfterMs: null, error: null };
    const now = this.now();
    const poll = this.config?.pollIntervalMs ?? 5_000;
    if (this.lastCycleAt !== null && now - this.lastCycleAt > poll * (this.o.sleepGapFactor ?? 6) + this.backoffMs) {
      // Woke from sleep: file handles into chat.db's WAL may be stale and config may have changed.
      report.resumedAfterMs = now - this.lastCycleAt;
      this.o.log.info('daemon.resumed', { gapMs: report.resumedAfterMs });
      this.closeDb();
      this.configAt = 0;
      this.lastHeartbeat = 0;
    }
    this.lastCycleAt = now;

    try {
      this.db ??= this.open();
      this.fullDiskAccess = true;
      this.state ??= await this.o.state.load();
      if (!this.state) {
        const hours = this.o.backfillHours ?? 0;
        const start = hours > 0 ? this.db.firstRowIdSince(new Date(now - hours * 3600_000)) : this.db.maxRowId();
        this.state = { lastRowId: start, knownHandles: [] };
        await this.o.state.save(this.state);
        this.o.log.info('daemon.first_run', { startAfterRowId: start });
      }

      if (!this.config || now - this.configAt > 60_000) {
        this.config = await this.o.hub.config();
        this.configAt = now;
      }
      const watch = new Set(this.config.watchHandles.map(normalizeHandle));

      await this.backfillNewHandles(watch, report);
      await this.drain(watch, report);
      await this.flushOutbox(report);

      if (this.lastError) this.o.log.info('daemon.recovered', { after: this.lastError });
      this.lastError = null;
      this.backoffMs = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      report.error = msg;
      // Waiting on Full Disk Access is polled at a steady 5s so the dashboard sees the grant quickly.
      this.backoffMs = this.fullDiskAccess === false ? 5_000 : Math.min(this.backoffMs ? this.backoffMs * 2 : 5_000, 5 * 60_000);
      this.o.log.warn('daemon.cycle_failed', { error: msg, backoffMs: this.backoffMs });
      // Messages.app restarting, a WAL checkpoint or a missing permission: reopen next time.
      if (RECOVERABLE_DB.test(msg) || /Full Disk Access/.test(msg)) this.closeDb();
    }

    // Dashboard jobs don't need chat.db (except listing threads), so they run even while it can't be opened.
    await this.runJobs().catch((err) => this.o.log.warn('daemon.jobs_failed', { error: String(err) }));

    const due = now - this.lastHeartbeat > 30_000;
    if (due && this.o.mac) this.keepAwake = await this.o.mac.keepAwake().catch(() => null);
    const changed = this.fullDiskAccess !== this.reported.fda || this.keepAwake !== this.reported.awake;
    if (due || changed || report.resumedAfterMs !== null) {
      try {
        await this.o.hub.heartbeat({
          lastRowId: this.state?.lastRowId ?? 0,
          error: this.lastError,
          version: DAEMON_VERSION,
          fullDiskAccess: this.fullDiskAccess,
          keepAwake: this.keepAwake,
          ...(this.o.nodePath ? { nodePath: this.o.nodePath } : {}),
          ...(report.resumedAfterMs !== null ? { resumedAfterMs: report.resumedAfterMs } : {}),
        });
        this.lastHeartbeat = now;
        this.reported = { fda: this.fullDiskAccess, awake: this.keepAwake };
      } catch {
        // Hub unreachable; the next cycle retries.
      }
    }
    return report;
  }

  private async runJobs() {
    const hub = this.o.hub;
    if (!hub.jobs || !hub.finishJob) return;
    for (const job of await hub.jobs()) {
      try {
        const result = await this.runJob(job);
        await hub.finishJob(job.id, true, result);
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        // A dropped connection doesn't mean the page was bad. Leave it claimed so it is tried again,
        // instead of telling the hub the whole import failed.
        if (job.kind === 'read-history' && /timeout|aborted|fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(msg)) {
          this.o.log.warn('daemon.history_retry', { id: job.id, error: msg });
          continue;
        }
        await hub.finishJob(job.id, false, undefined, msg).catch(() => undefined);
      }
    }
  }

  private async runJob(job: DaemonJob): Promise<unknown> {
    switch (job.kind) {
      case 'list-threads': {
        this.db ??= this.open();
        this.fullDiskAccess = true;
        const days = Math.min(Math.max(Number(job.args.days ?? 30), 1), 90);
        return { threads: this.db.recentThreads(new Date(this.now() - days * 86_400_000), 30) };
      }
      case 'read-history': {
        // Your older messages, a page at a time. Only the threads the hub names, and it only ever reads.
        this.db ??= this.open();
        this.fullDiskAccess = true;
        const watch = new Set((job.args.handles as string[]).map(normalizeHandle));
        let scannedTo = Number(job.args.afterRowId ?? 0);
        const messages: DaemonMessage[] = [];
        let done = false;
        // Most rows belong to other chats. Walk past them in this job, and stop once a post-sized batch is ready.
        for (let i = 0; i < 40 && messages.length < 30; i++) {
          const page = this.db.readSince(scannedTo, watch, 400, 30 - messages.length);
          messages.push(...page.messages);
          if (page.scannedTo === scannedTo) {
            done = true;
            break;
          }
          scannedTo = page.scannedTo;
        }
        this.o.log.info('daemon.history_page', { messages: messages.length, scannedTo, done });
        return { messages, scannedTo, done };
      }
      case 'keep-awake': {
        if (!this.o.mac) throw new Error('keep-awake is only available on macOS');
        await this.o.mac.setKeepAwake(job.args.on === true);
        this.keepAwake = await this.o.mac.keepAwake();
        return { keepAwake: this.keepAwake };
      }
      case 'open-settings': {
        if (!this.o.mac) throw new Error('only available on macOS');
        await this.o.mac.openFullDiskAccess();
        return { opened: true };
      }
      default:
        throw new Error(`unknown job ${(job as DaemonJob).kind}`);
    }
  }

  /** Drains the backlog page by page, in ROWID order. Nothing is lost if the hub is down: the checkpoint stays put. */
  private async drain(watch: Set<string>, report: CycleReport) {
    const pageSize = this.o.pageSize ?? 500;
    for (;;) {
      const { messages, scannedTo } = this.db!.readSince(this.state!.lastRowId, watch, pageSize);
      if (messages.length) {
        report.skipped += await this.ship(messages);
        report.shipped += messages.length;
      }
      if (scannedTo === this.state!.lastRowId) break;
      report.pages++;
      this.state = { ...this.state!, lastRowId: scannedTo };
      await this.o.state.save(this.state);
    }
  }

  /**
   * Sends a page. If the hub rejects it as a client error (400/413/422), the page is split in half until
   * the offending message is isolated, which is then skipped so one bad row can't wedge the daemon.
   * Network and 5xx errors propagate, leaving the checkpoint where it was.
   */
  private async ship(messages: DaemonMessage[]): Promise<number> {
    try {
      await this.o.hub.ingest(messages);
      return 0;
    } catch (err) {
      if (!(err instanceof HubHttpError) || ![400, 413, 422].includes(err.status)) throw err;
      if (messages.length === 1) {
        const rowid = messages[0].rowid;
        this.o.log.warn('daemon.message_skipped', { rowid, status: err.status });
        this.state = { ...this.state!, skipped: [...(this.state!.skipped ?? []), rowid].slice(-MAX_SKIPPED_KEPT) };
        return 1;
      }
      const mid = Math.ceil(messages.length / 2);
      return (await this.ship(messages.slice(0, mid))) + (await this.ship(messages.slice(mid)));
    }
  }

  private async backfillNewHandles(watch: Set<string>, report: CycleReport) {
    const known = new Set(this.state!.knownHandles ?? []);
    const fresh = [...watch].filter((h) => !known.has(h));
    if (!fresh.length) return;
    const hours = this.o.newHandleBackfillHours ?? 24;
    // The very first run already starts at "now" (or the configured backfill), so only later additions backfill.
    if (known.size > 0 && hours > 0) {
      const from = this.db!.firstRowIdSince(new Date(this.now() - hours * 3600_000));
      let cursor = from;
      const only = new Set(fresh);
      while (cursor < this.state!.lastRowId) {
        const { messages, scannedTo } = this.db!.readSince(cursor, only, this.o.pageSize ?? 500);
        const inRange = messages.filter((m) => m.rowid <= this.state!.lastRowId);
        if (inRange.length) {
          report.skipped += await this.ship(inRange);
          report.shipped += inRange.length;
        }
        if (scannedTo === cursor) break;
        cursor = scannedTo;
      }
      this.o.log.info('daemon.backfilled_handles', { count: fresh.length, fromRowId: from });
    }
    this.state = { ...this.state!, knownHandles: [...known, ...fresh] };
    await this.o.state.save(this.state);
  }

  private async flushOutbox(report: CycleReport) {
    for (const item of await this.o.hub.outbox()) {
      if (this.state!.sentOutbox?.includes(item.id)) {
        await this.o.hub.ack(item.id, true);
        continue;
      }
      try {
        await this.o.send(item.toHandle, item.body);
      } catch (err) {
        this.o.log.warn('daemon.send_failed', { id: item.id, error: String(err) });
        await this.o.hub.ack(item.id, false, String(err).slice(0, 500)).catch(() => undefined);
        continue;
      }
      this.state = { ...this.state!, sentOutbox: [...(this.state!.sentOutbox ?? []), item.id].slice(-MAX_SKIPPED_KEPT) };
      await this.o.state.save(this.state);
      report.sent++;
      // If this ack is lost, the next cycle re-acks from sentOutbox instead of sending again.
      await this.o.hub.ack(item.id, true);
    }
  }

  close() {
    this.closeDb();
  }
}
