import { DatabaseSync } from 'node:sqlite';
import type { DaemonMessage } from '../shared/types.js';
import { cleanMessageText, decodeAttributedBody } from './attributedBody.js';

const APPLE_EPOCH_OFFSET_S = 978_307_200;

/** chat.db stores dates as nanoseconds since 2001-01-01 (seconds on very old macOS). */
export function appleDateToIso(value: number | bigint): string {
  const big = BigInt(value);
  const ms = big > 1_000_000_000_000n ? Number(big / 1_000_000n) : Number(big) * 1000;
  return new Date(ms + APPLE_EPOCH_OFFSET_S * 1000).toISOString();
}

export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  if (h.includes('@')) return h;
  const digits = h.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

interface Row {
  rowid: bigint;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  is_from_me: bigint;
  date: bigint;
  service: string | null;
  handle: string | null;
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
   */
  readSince(afterRowId: number, watch: Set<string>, limit = 500): { messages: DaemonMessage[]; scannedTo: number } {
    const stmt = this.db.prepare(
        `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.is_from_me, m.date, m.service,
                COALESCE(h.id, c.chat_identifier) AS handle
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
    const messages: DaemonMessage[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      const rowid = Number(r.rowid);
      scannedTo = Math.max(scannedTo, rowid);
      if (seen.has(rowid) || !r.handle) continue;
      seen.add(rowid);
      if (!watch.has(normalizeHandle(r.handle))) continue;
      let text: string;
      try {
        text = cleanMessageText(r.text ?? decodeAttributedBody(r.attributedBody));
      } catch {
        this.undecodable++;
        continue;
      }
      if (!text) continue;
      messages.push({
        guid: r.guid,
        rowid,
        handle: r.handle,
        isFromMe: Number(r.is_from_me) === 1,
        text,
        sentAt: appleDateToIso(r.date),
        service: r.service ?? 'iMessage',
      });
    }
    return { messages, scannedTo };
  }

  close(): void {
    this.db.close();
  }
}
