import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../../src/hub/db.js';
import { Store } from '../../src/hub/store.js';
import { SUPABASE_API_URL, SUPABASE_DB_URL, backend, signJwt } from '../support/db.js';

/**
 * Runs against the `postgres` database of local Supabase, the one PostgREST and pg_graphql actually
 * serve, so these are the same doors an attacker holding the project's anon key would knock on.
 */
const run = backend() === 'supabase' ? describe : describe.skip;

const HUB_TABLES = [...readFileSync(new URL('../../src/hub/schema.sql', import.meta.url), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const ROLES = ['anon', 'authenticated', 'service_role'] as const;

run('Supabase: migration + row-level security', () => {
  let admin: postgres.Sql;

  async function fingerprint() {
    return admin.unsafe(`
      SELECT c.relname, c.relrowsecurity,
             (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum)
                FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
             (SELECT string_agg(pg_get_constraintdef(k.oid), ' | ' ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid = c.oid) AS cons,
             (SELECT string_agg(i.indexname, ',' ORDER BY i.indexname) FROM pg_indexes i WHERE i.tablename = c.relname AND i.schemaname = 'public') AS idx
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1) ORDER BY c.relname`, [HUB_TABLES]);
  }

  beforeAll(async () => {
    admin = postgres(SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
    // Start from nothing so the first migration really is a first run.
    await admin.unsafe(`DROP TABLE IF EXISTS ${HUB_TABLES.join(', ')} CASCADE`);
  });
  afterAll(async () => {
    await admin.end({ timeout: 5 });
  });

  it('migration runs on a fresh database and again on an existing one, without changing schema or data', async () => {
    const first = await openDb({ databaseUrl: SUPABASE_DB_URL, maxConnections: 2 });
    const store = new Store(first);
    await store.ensureDefaultScopes();
    const task = await store.createTask({ originAgent: 'instinct', targetAgent: 'grok', payload: 'Pause open source for a week', rationale: '', topics: ['open_source'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    await store.setSetting('paused', false);
    const before = await fingerprint();
    await first.close();

    const second = await openDb({ databaseUrl: SUPABASE_DB_URL, maxConnections: 2 });
    const after = await fingerprint();
    const s2 = new Store(second);
    expect((await s2.task(task.id))?.payload).toBe('Pause open source for a week');
    expect(await s2.isPaused()).toBe(false);
    await s2.ensureDefaultScopes();
    expect((await s2.scopes()).size).toBe(7);
    await second.close();

    expect(after).toEqual(before);
    expect(before.map((r) => r.relname).sort()).toEqual([...HUB_TABLES].sort());
    // Tell PostgREST about the new tables so the REST checks below hit permissions, not "table not found".
    await admin.unsafe(`NOTIFY pgrst, 'reload schema'`);
    await new Promise((r) => setTimeout(r, 1500));
  });

  it('every hub table has RLS enabled and no policies', async () => {
    const rows = await admin.unsafe<{ relname: string; relrowsecurity: boolean; policies: number }[]>(
      `SELECT c.relname, c.relrowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [HUB_TABLES],
    );
    expect(rows).toHaveLength(HUB_TABLES.length);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.policies]).toEqual([r.relname, true, 0]);
  });

  it('anon, authenticated and service_role hold no privileges on any hub table or sequence', async () => {
    const grants = await admin.unsafe<{ grantee: string; table_name: string; privilege_type: string }[]>(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = ANY($1) AND grantee = ANY($2)`,
      [HUB_TABLES, [...ROLES]],
    );
    expect(grants).toEqual([]);
    const seqs = await admin.unsafe<{ grantee: string }[]>(
      `SELECT grantee FROM information_schema.usage_privileges WHERE object_schema = 'public' AND object_type = 'SEQUENCE' AND grantee = ANY($1)`,
      [[...ROLES]],
    );
    expect(seqs).toEqual([]);
  });

  for (const role of ROLES) {
    it(`SQL as ${role}: reads and writes are refused`, async () => {
      for (const sql of [
        'SELECT * FROM tasks LIMIT 1',
        'SELECT value FROM settings',
        'SELECT * FROM oauth_tokens',
        `INSERT INTO audit (actor, action) VALUES ('attacker', 'x')`,
        `UPDATE settings SET value = 'true' WHERE key = 'paused'`,
        `DELETE FROM raw_messages`,
      ]) {
        const err = await admin.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          return tx.unsafe(sql).then(() => null, (e: { code?: string }) => e.code);
        }).catch((e: { code?: string }) => e.code);
        expect(err, `${role}: ${sql}`).toBe('42501');
      }
    });
  }

  it('defence in depth: even if someone re-grants SELECT to anon, RLS with no policy returns zero rows', async () => {
    const rows = await admin.begin(async (tx) => {
      await tx.unsafe('GRANT SELECT ON tasks TO anon');
      await tx.unsafe('SET LOCAL ROLE anon');
      const r = await tx.unsafe('SELECT count(*)::int AS n FROM tasks');
      throw Object.assign(new Error('rollback'), { rows: r });
    }).catch((e: { rows?: { n: number }[] }) => e.rows);
    expect(rows).toEqual([{ n: 0 }]);
    const [{ n }] = await admin.unsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM tasks');
    expect(n).toBeGreaterThan(0);
  });

  for (const role of ['anon', 'authenticated', 'service_role']) {
    it(`REST (PostgREST) with a ${role} key: every table is refused`, async () => {
      const key = signJwt(role);
      const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
      for (const t of HUB_TABLES) {
        const res = await fetch(`${SUPABASE_API_URL}/rest/v1/${t}?select=*&limit=1`, { headers });
        const body = (await res.json()) as { code?: string };
        expect([t, res.status, body.code]).toEqual([t, role === 'anon' ? 401 : 403, '42501']);
      }
      const write = await fetch(`${SUPABASE_API_URL}/rest/v1/settings`, { method: 'POST', headers, body: JSON.stringify({ key: 'paused', value: true }) });
      expect([write.status, ((await write.json()) as { code?: string }).code]).toEqual([role === 'anon' ? 401 : 403, '42501']);
    });
  }

  it('GraphQL (pg_graphql) exposes none of the hub tables to anon or authenticated', async () => {
    // Hosted projects ship with pg_graphql on; enable it here so the check isn't vacuous.
    await admin.unsafe('CREATE EXTENSION IF NOT EXISTS pg_graphql');
    for (const role of ['anon', 'authenticated']) {
      const key = signJwt(role);
      const res = await fetch(`${SUPABASE_API_URL}/graphql/v1`, {
        method: 'POST',
        headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __schema { queryType { fields { name } } } }' }),
      });
      const body = (await res.json()) as { data?: { __schema: { queryType: { fields: { name: string }[] } } }; errors?: unknown };
      expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
      const fields = body.data!.__schema.queryType.fields.map((f) => f.name.toLowerCase());
      expect(fields).toContain('node'); // the endpoint really answered
      const camel = HUB_TABLES.map((t) => `${t.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())}collection`.toLowerCase());
      expect(fields.filter((f) => camel.includes(f))).toEqual([]);
    }
  });

  it('the hub needs no Supabase API key at all: no keys in source, and the client library is not a dependency', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('@supabase/supabase-js');
  });
});
