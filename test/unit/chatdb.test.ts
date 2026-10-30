import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { decodeAttributedBody } from '../../src/daemon/attributedBody.js';
import { ChatDb, appleDateToIso, normalizeHandle } from '../../src/daemon/chatdb.js';
import { attributedBody } from '../fixtures/chatdb.js';

describe('attributedBody', () => {
  it('decodes short, long and unicode bodies', () => {
    expect(decodeAttributedBody(attributedBody('pause open source for a week'))).toBe('pause open source for a week');
    const long = 'x'.repeat(5000) + ' end';
    expect(decodeAttributedBody(attributedBody(long))).toBe(long);
    expect(decodeAttributedBody(attributedBody('shoot tomorrow 🎬 ✓'))).toBe('shoot tomorrow 🎬 ✓');
  });

  it('handles every length-prefix boundary (1-byte, 0x81 int16, 0x82 int32)', () => {
    for (const n of [0, 1, 127, 128, 255, 256, 65_535, 65_536, 70_000]) {
      const text = 'a'.repeat(n);
      expect(decodeAttributedBody(attributedBody(text))?.length, `length ${n}`).toBe(n);
    }
    // Multi-byte characters: the prefix counts UTF-8 bytes, not characters.
    const emoji = '🎬'.repeat(40); // 160 bytes
    expect(decodeAttributedBody(attributedBody(emoji))).toBe(emoji);
  });

  it('returns null for truncated blobs instead of reading past the end', () => {
    const full = Buffer.from(attributedBody('x'.repeat(300)));
    const lenAt = full.indexOf(0x2b, full.indexOf('NSString')) + 1;
    expect(full[lenAt]).toBe(0x81);
    expect(decodeAttributedBody(full.subarray(0, lenAt + 2))).toBeNull(); // half the int16
    expect(decodeAttributedBody(full.subarray(0, lenAt + 3 + 100))).toBeNull(); // body cut short
    expect(decodeAttributedBody(full.subarray(0, lenAt))).toBeNull(); // ends at the '+'
  });

  it('returns null on garbage', () => {
    expect(decodeAttributedBody(Buffer.from('nothing here'))).toBeNull();
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(new Uint8Array())).toBeNull();
    // NSString present but no '+' marker nearby.
    expect(decodeAttributedBody(Buffer.concat([Buffer.from('NSString'), Buffer.alloc(40)]))).toBeNull();
    // Unsupported length tag (0x83 is a float in typedstream).
    expect(decodeAttributedBody(Buffer.concat([Buffer.from('NSString'), Buffer.from([0x01, 0x2b, 0x83, 0x01])]))).toBeNull();
    // Random bytes never throw.
    for (let i = 0; i < 200; i++) {
      const junk = Buffer.concat([Buffer.from('NSString\x01\x2b'), Buffer.from(Array.from({ length: i % 17 }, () => Math.floor(Math.random() * 256)))]);
      expect(() => decodeAttributedBody(junk)).not.toThrow();
    }
  });

  it('decodes from a Uint8Array view with a non-zero offset (as node:sqlite returns)', () => {
    const blob = attributedBody('offset view');
    const padded = new Uint8Array(blob.length + 10);
    padded.set(blob, 10);
    expect(decodeAttributedBody(padded.subarray(10))).toBe('offset view');
  });
});

describe('chat.db access', () => {
  it('opens read-only: Messages’ database can never be written by the daemon', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'chatdb-')), 'chat.db');
    new DatabaseSync(file).exec('CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT)');
    const reader = new ChatDb(file);
    const inner = (reader as unknown as { db: DatabaseSync }).db;
    expect(() => inner.exec("INSERT INTO message (text) VALUES ('x')")).toThrow(/readonly/i);
    reader.close();
  });
});

describe('chat.db reader', () => {
  function fixture() {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'chatdb-')), 'chat.db');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, style INTEGER);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER,
        date INTEGER, service TEXT, handle_id INTEGER, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      INSERT INTO handle VALUES (1, '+15550001111'), (2, '+15557777777');
      INSERT INTO chat VALUES (1, '+15550001111', 45), (2, '+15557777777', 45), (3, 'chat123', 43);
    `);
    const ins = db.prepare('INSERT INTO message (ROWID, guid, text, attributedBody, is_from_me, date, service, handle_id, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const join = db.prepare('INSERT INTO chat_message_join VALUES (?, ?)');
    const date = BigInt(Math.floor(Date.UTC(2026, 9, 29, 22, 0) / 1000 - 978307200)) * 1_000_000_000n;
    ins.run(1, 'g1', 'hey instinct', null, 1, date, 'iMessage', 1, 0); join.run(1, 1);
    ins.run(2, 'g2', null, attributedBody('Got it. Debrief at 10?'), 0, date, 'iMessage', 1, 0); join.run(1, 2);
    ins.run(3, 'g3', 'friend message', null, 0, date, 'iMessage', 2, 0); join.run(2, 3);
    ins.run(4, 'g4', 'Loved "hey instinct"', null, 0, date, 'iMessage', 1, 2000); join.run(1, 4);
    ins.run(5, 'g5', 'group chatter', null, 0, date, 'iMessage', 1, 0); join.run(3, 5);
    ins.run(6, 'g6', 'later', null, 1, date, 'iMessage', 0, 0); join.run(1, 6);
    db.close();
    return file;
  }

  it('only forwards watched 1:1 threads, decodes attributedBody, and skips tapbacks/groups', () => {
    const reader = new ChatDb(fixture());
    const watch = new Set([normalizeHandle('+1 (555) 000-1111')]);
    const { messages, scannedTo } = reader.readSince(0, watch);
    expect(scannedTo).toBe(6);
    expect(messages.map((m) => [m.rowid, m.text, m.isFromMe])).toEqual([
      [1, 'hey instinct', true],
      [2, 'Got it. Debrief at 10?', false],
      [6, 'later', true],
    ]);
    expect(messages[0].sentAt).toBe('2026-10-29T22:00:00.000Z');
    expect(reader.readSince(6, watch).messages).toHaveLength(0);
    reader.close();
  });

  it('pages through a backlog without skipping rows', () => {
    const reader = new ChatDb(fixture());
    const watch = new Set([normalizeHandle('+15550001111')]);
    const seen: number[] = [];
    let cursor = 0;
    for (;;) {
      const { messages, scannedTo } = reader.readSince(cursor, watch, 2);
      seen.push(...messages.map((m) => m.rowid));
      if (scannedTo === cursor) break;
      cursor = scannedTo;
    }
    expect(seen).toEqual([1, 2, 6]);
    reader.close();
  });

  it('converts Apple timestamps in seconds and nanoseconds', () => {
    expect(appleDateToIso(0)).toBe('2001-01-01T00:00:00.000Z');
    expect(appleDateToIso(694224000)).toBe('2023-01-01T00:00:00.000Z');
    expect(appleDateToIso(694224000n * 1_000_000_000n)).toBe('2023-01-01T00:00:00.000Z');
  });
});
