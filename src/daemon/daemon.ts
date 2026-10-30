import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonConfig, DaemonMessage, OutboxItem } from '../shared/types.js';
import type { Logger } from '../shared/log.js';
import { ChatDb, normalizeHandle } from './chatdb.js';

export const DAEMON_VERSION = '0.2.0';

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

export interface HubClient {
  config(): Promise<DaemonConfig>;
  ingest(messages: DaemonMessage[]): Promise<unknown>;
  outbox(): Promise<OutboxItem[]>;
  ack(id: number, ok: boolean, error?: string): Promise<void>;
  heartbeat(body: { lastRowId: number; error: string | null; version: string; resumedAfterMs?: number }): Promise<void>;
}

export function httpHubClient(baseUrl: string, token: string, timeoutMs = 20_000): HubClient {
  const url = baseUrl.replace(/\/$/, '');
  async function call<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${url}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
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
  };
}

export interface StateStore {
  load(): Promise<DaemonState | null>;
  save(state: DaemonState): Promise<void>;
}

export function fileStateStore(file: string): StateStore {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as DaemonState;
      } catch {
        return null;
      }
    },
    /** Atomic write so a crash or lid-close mid-write can't corrupt the checkpoint. */
    async save(state) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state));
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
        throw new Error(
          `Cannot open ${this.o.chatDbPath}. Grant Full Disk Access to ${process.execPath} in System Settings → Privacy & Security → Full Disk Access, then restart the daemon.`,
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
      this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : 5_000, 5 * 60_000);
      this.o.log.warn('daemon.cycle_failed', { error: msg, backoffMs: this.backoffMs });
      // Messages.app restarting, a WAL checkpoint or a missing permission: reopen next time.
      if (RECOVERABLE_DB.test(msg) || /Full Disk Access/.test(msg)) this.closeDb();
    }

    if (now - this.lastHeartbeat > 30_000 || report.resumedAfterMs !== null) {
      try {
        await this.o.hub.heartbeat({
          lastRowId: this.state?.lastRowId ?? 0,
          error: this.lastError,
          version: DAEMON_VERSION,
          ...(report.resumedAfterMs !== null ? { resumedAfterMs: report.resumedAfterMs } : {}),
        });
        this.lastHeartbeat = now;
      } catch {
        // Hub unreachable; the next cycle retries.
      }
    }
    return report;
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
