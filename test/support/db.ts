import { createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';

/** Local Supabase (`supabase start`). Override with SUPABASE_DB_URL. */
export const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const SUPABASE_API_URL = process.env.SUPABASE_API_URL ?? 'http://127.0.0.1:54321';
/** The local stack's well-known default; never a real project's secret. */
export const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';

export type Backend = 'supabase' | 'pglite';

/** Integration and e2e tests run on local Supabase. HUB_TEST_DB=pglite is an explicit offline escape hatch. */
export function backend(): Backend {
  return process.env.HUB_TEST_DB === 'pglite' ? 'pglite' : 'supabase';
}

export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * A fresh, empty database on the local Supabase Postgres for one test, dropped afterwards. The
 * Supabase roles (anon, authenticated, service_role) are cluster-wide, so the RLS/revoke logic in the
 * migration runs exactly as it would in a real project.
 */
export async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `hub_t_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = postgres(SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  return {
    url: withDatabase(SUPABASE_DB_URL, name),
    async drop() {
      const a = postgres(SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end({ timeout: 5 });
      }
    },
  };
}

export async function supabaseReachable(): Promise<boolean> {
  const sql = postgres(SUPABASE_DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

export function signJwt(role: string, secret = SUPABASE_JWT_SECRET): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ role, iss: 'supabase-demo', exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
