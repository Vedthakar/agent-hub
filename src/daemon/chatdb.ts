import { DatabaseSync } from 'node:sqlite';
import type { DaemonMessage } from '../shared/types.js';
import { cleanMessageText, decodeAttributedBody } from './attributedBody.js';
import { normalizeHandle } from '../shared/handles.js';

const APPLE_EPOCH_OFFSET_S = 978_307_200;

/** chat.db stores dates as nanoseconds since 2001-01-01 (seconds on very old macOS). */
export function appleDateToIso(value: number | bigint): string {
  const big = BigInt(value);
  const ms = big > 1_000_000_000_000n ? Number(big / 1_000_000n) : Number(big) * 1000;
  return new Date(ms + APPLE_EPOCH_OFFSET_S * 1000).toISOString();
}

export { normalizeHandle } from '../shared/handles.js';

interface Row {
  rowid: bigint;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  is_from_me: bigint;
  date: bigint;
  service: string | null;
  /** The sender's handle. Null on many outgoing rows, where the chat identifier is the only name. */
  handle: string | null;
  /** The conversation the row belongs to. The thread picker stores this, and it can differ from `handle`. */
  chat: string | null;
}

/**
 * Read-only reader for ~/Library/Messages/chat.db. Opening it requires Full Disk Access for the
 * process running the daemon (the `node` binary when launched by launchd).
 */
export class ChatDb {
  private db: DatabaseSync;
  /** Rows whose body couldn't be decoded; skipped rather than blocking the checkpoint. */
  undecodable = 0;

  constructor(path: string, opts: { busyTimeoutMs?: number } = {}) {
    // Messages.app holds a write lock while it checkpoints the WAL; wait for it instead of failing.
    this.db = new DatabaseSync(path, { readOnly: true, timeout: opts.busyTimeoutMs ?? 5_000 });
  }

  maxRowId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS m FROM message').get() as { m: number };
    return Number(row.m);
  }

  /** Smallest ROWID at or after a point in time; used for an optional first-run backfill. */
  firstRowIdSince(date: Date): number {
    const appleNs = BigInt(Math.floor(date.getTime() / 1000 - APPLE_EPOCH_OFFSET_S)) * 1_000_000_000n;
    const row = this.db.prepare('SELECT MIN(ROWID) AS m FROM message WHERE date >= ?').get(appleNs) as { m: number | null };
    return row.m === null ? this.maxRowId() : Number(row.m) - 1;
  }

  /**
   * Rows after `afterRowId` in 1:1 conversations. Returns the highest ROWID scanned so the caller can
   * advance past rows it chose not to forward. Tapbacks and group-event rows are skipped.
   *
   * A thread matches if either the sender handle or the chat identifier is watched. Outgoing rows often
   * have no sender handle, and the chat identifier (what the thread picker stores) can be an email while
   * the handle row is a phone number. `maxMessages` keeps one page small enough to post.
   */
  readSince(afterRowId: number, watch: Set<string>, limit = 500, maxMessages = 40): { messages: DaemonMessage[]; scannedTo: number } {
    const stmt = this.db.prepare(
        `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.is_from_me, m.date, m.service,
                h.id AS handle, c.chat_identifier AS chat
         FROM message m
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE m.ROWID > ?
           AND COALESCE(m.associated_message_type, 0) = 0
           AND COALESCE(m.item_type, 0) = 0
           AND (c.style IS NULL OR c.style = 45)
         ORDER BY m.ROWID
         LIMIT ?`,
    );
    // Nanosecond dates exceed Number.MAX_SAFE_INTEGER.
    stmt.setReadBigInts(true);
    const rows = stmt.all(afterRowId, limit) as unknown as Row[];

    let scannedTo = afterRowId;
    let chars = 0;
    const messages: DaemonMessage[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      const rowid = Number(r.rowid);
      if (seen.has(rowid)) continue;
      seen.add(rowid);
      const chatNorm = r.chat ? normalizeHandle(r.chat) : '';
      const handleNorm = r.handle ? normalizeHandle(r.handle) : '';
      const watched = watch.has(chatNorm) ? r.chat : watch.has(handleNorm) ? r.handle : null;
      if (!watched) {
        scannedTo = Math.max(scannedTo, rowid);
        continue;
      }
      let text: string;
      try {
        text = cleanMessageText(r.text ?? decodeAttributedBody(r.attributedBody));
      } catch {
        this.undecodable++;
        scannedTo = Math.max(scannedTo, rowid);
        continue;
      }
      if (!text) {
        scannedTo = Math.max(scannedTo, rowid);
        continue;
      }
      // Stop before this row so the next page starts here, instead of skipping the rest of the scan.
      if (messages.length >= maxMessages || chars >= 120_000) break;
      scannedTo = Math.max(scannedTo, rowid);
      chars += text.length;
      messages.push({
        guid: r.guid,
        rowid,
        handle: watched,
        isFromMe: Number(r.is_from_me) === 1,
        text,
        sentAt: appleDateToIso(r.date),
        service: r.service ?? 'iMessage',
      });
    }
    return { messages, scannedTo };
  }

  /**
   * Recent 1:1 conversations, newest first, for the dashboard's "which thread is Instinct?" picker.
   * Handles, counts and times only: no message text leaves the Mac for this.
   */
  recentThreads(since: Date, limit = 30): RecentThread[] {
    const stmt = this.db.prepare(
      `SELECT c.chat_identifier AS handle, MAX(m.date) AS last, COUNT(*) AS n,
              SUM(CASE WHEN m.is_from_me = 1 THEN 0 ELSE 1 END) AS inbound, MAX(m.service) AS service
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE c.style = 45 AND m.date >= ? AND COALESCE(m.associated_message_type, 0) = 0
       GROUP BY c.ROWID
       ORDER BY last DESC
       LIMIT ?`,
    );
    stmt.setReadBigInts(true);
    const appleNs = BigInt(Math.floor(since.getTime() / 1000 - APPLE_EPOCH_OFFSET_S)) * 1_000_000_000n;
    const rows = stmt.all(appleNs, limit) as unknown as { handle: string | null; last: bigint; n: bigint; inbound: bigint; service: string | null }[];
    return rows
      .filter((r) => r.handle)
      .map((r) => ({ handle: r.handle!, lastAt: appleDateToIso(r.last), messages: Number(r.n), fromThem: Number(r.inbound), service: r.service ?? 'iMessage' }));
  }

  close(): void {
    this.db.close();
  }
}

export interface RecentThread {
  handle: string;
  lastAt: string;
  messages: number;
  fromThem: number;
  service: string;
}
