import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { decodeAttributedBody } from '../src/daemon/attributedBody.js';
import { ChatDb, appleDateToIso, normalizeHandle } from '../src/daemon/chatdb.js';

/** Mimics the typedstream layout macOS writes for NSAttributedString. */
function attributedBody(text: string): Uint8Array {
  const utf8 = Buffer.from(text, 'utf8');
  let len: Buffer;
  if (utf8.length < 0x80) len = Buffer.from([utf8.length]);
  else if (utf8.length <= 0xffff) {
    len = Buffer.alloc(3);
    len[0] = 0x81;
    len.writeUInt16LE(utf8.length, 1);
  } else {
    len = Buffer.alloc(5);
    len[0] = 0x82;
    len.writeUInt32LE(utf8.length, 1);
  }
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from('streamtyped'),
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
    Buffer.from([0x12]),
    Buffer.from('NSAttributedString'),
    Buffer.from([0x00, 0x84, 0x84, 0x08]),
    Buffer.from('NSObject'),
    Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08]),
    Buffer.from('NSString'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    len,
    utf8,
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]),
  ]);
}

describe('attributedBody', () => {
  it('decodes short, long and unicode bodies', () => {
    expect(decodeAttributedBody(attributedBody('pause open source for a week'))).toBe('pause open source for a week');
    const long = 'x'.repeat(5000) + ' end';
    expect(decodeAttributedBody(attributedBody(long))).toBe(long);
    expect(decodeAttributedBody(attributedBody('shoot tomorrow 🎬 ✓'))).toBe('shoot tomorrow 🎬 ✓');
  });

  it('returns null on garbage', () => {
    expect(decodeAttributedBody(Buffer.from('nothing here'))).toBeNull();
    expect(decodeAttributedBody(null)).toBeNull();
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
