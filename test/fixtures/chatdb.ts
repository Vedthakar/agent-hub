import { DatabaseSync } from 'node:sqlite';

/** Mimics the typedstream layout macOS writes for NSAttributedString. */
export function attributedBody(text: string): Uint8Array {
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

export const appleNs = (d: Date) => BigInt(Math.floor(d.getTime() / 1000 - 978_307_200)) * 1_000_000_000n;

export interface FixtureRow {
  handle: string;
  text: string;
  fromMe?: boolean;
  at?: Date;
  /** Store the body only in attributedBody (text = NULL), like macOS Ventura+. */
  attributed?: boolean;
  /** 2000-range = tapback. */
  associatedType?: number;
  /** Put it in a group chat instead of the 1:1 thread. */
  group?: boolean;
}

/**
 * A minimal chat.db with Messages' real column names, in WAL mode like the real one. `add()` appends
 * rows through a separate writer connection while readers stay open, the way Messages.app does.
 */
export function buildChatDb(file: string, rows: FixtureRow[] = []) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS handle (ROWID INTEGER PRIMARY KEY, id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT UNIQUE, style INTEGER);
    CREATE TABLE IF NOT EXISTS message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE, text TEXT, attributedBody BLOB, is_from_me INTEGER,
      date INTEGER, service TEXT, handle_id INTEGER, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS chat_message_join (chat_id INTEGER, message_id INTEGER);
  `);
  const handleId = (h: string) => {
    db.prepare('INSERT OR IGNORE INTO handle (id) VALUES (?)').run(h);
    return Number((db.prepare('SELECT ROWID AS id FROM handle WHERE id = ?').get(h) as { id: number }).id);
  };
  const chatId = (identifier: string, style: number) => {
    db.prepare('INSERT OR IGNORE INTO chat (chat_identifier, style) VALUES (?, ?)').run(identifier, style);
    return Number((db.prepare('SELECT ROWID AS id FROM chat WHERE chat_identifier = ?').get(identifier) as { id: number }).id);
  };
  const insert = db.prepare(
    'INSERT INTO message (guid, text, attributedBody, is_from_me, date, service, handle_id, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const join = db.prepare('INSERT INTO chat_message_join VALUES (?, ?)');
  let n = 0;
  const add = (r: FixtureRow): number => {
    n++;
    const h = handleId(r.handle);
    const c = r.group ? chatId(`group-${r.handle}`, 43) : chatId(r.handle, 45);
    const res = insert.run(
      `fixture-${n}-${Math.random().toString(36).slice(2, 8)}`,
      r.attributed ? null : r.text,
      r.attributed ? attributedBody(r.text) : null,
      r.fromMe ? 1 : 0,
      appleNs(r.at ?? new Date()),
      'iMessage',
      r.fromMe ? 0 : h,
      r.associatedType ?? 0,
    );
    const rowid = Number(res.lastInsertRowid);
    join.run(c, rowid);
    return rowid;
  };
  const addMany = (rs: FixtureRow[]) => {
    db.exec('BEGIN');
    try {
      for (const r of rs) add(r);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  addMany(rows);
  return { file, add, addMany, db, close: () => db.close() };
}
