import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Minimal Postgres interface. Production uses a real Postgres (e.g. Supabase) via DATABASE_URL;
 * local dev and tests use embedded PGlite so nothing else needs to be running.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Runs `fn` in a transaction; the Db passed to `fn` is bound to it. Nested calls reuse the outer transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(opts: { databaseUrl: string | null; pgliteDir?: string | null; maxConnections?: number }): Promise<Db> {
  const db = opts.databaseUrl ? await openPostgres(opts.databaseUrl, opts.maxConnections ?? 10) : await openPglite(opts.pgliteDir ?? null);
  await migrate(db);
  return db;
}

interface PgLike {
  unsafe(text: string, params?: never[]): Promise<unknown>;
}

async function openPostgres(url: string, max: number): Promise<Db> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, {
    max,
    onnotice: () => {},
    ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(url) ? false : 'require',
    types: {
      int8: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
  });
  const wrap = (conn: PgLike, inTx: boolean): Db => ({
    async query<T>(text: string, params: unknown[] = []) {
      // JSON values are passed pre-serialized with an explicit ::text::jsonb cast; undefined means NULL, as in PGlite.
      const rows = await conn.unsafe(text, params.map((p) => (p === undefined ? null : p)) as never[]);
      return normalizeRows(rows as Record<string, unknown>[]) as T[];
    },
    async exec(text: string) {
      await conn.unsafe(text);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (inTx) return fn(wrap(conn, true));
      return (await sql.begin((tx) => fn(wrap(tx as unknown as PgLike, true)))) as T;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  });
  return wrap(sql as unknown as PgLike, false);
}

interface PgliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(text: string): Promise<unknown>;
}

async function openPglite(dir: string | null): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir) await mkdir(dir, { recursive: true });
  const pg = dir ? new PGlite(dir) : new PGlite();
  await pg.waitReady;
  const wrap = (conn: PgliteLike, inTx: boolean): Db => ({
    async query<T>(text: string, params: unknown[] = []) {
      const res = await conn.query(text, params);
      return normalizeRows(res.rows as Record<string, unknown>[]) as T[];
    },
    async exec(text: string) {
      await conn.exec(text);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (inTx) return fn(wrap(conn, true));
      return pg.transaction((tx) => fn(wrap(tx as unknown as PgliteLike, true)));
    },
    async close() {
      await pg.close();
    },
  });
  return wrap(pg as unknown as PgliteLike, false);
}

/** BIGSERIAL ids come back as bigint/string depending on driver; the hub never exceeds 2^53 so use numbers. */
function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'bigint') row[k] = Number(v);
    }
  }
  return rows;
}

export async function schemaSql(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFile(path.join(here, 'schema.sql'), 'utf8');
}

async function migrate(db: Db): Promise<void> {
  await db.exec(await schemaSql());
}
