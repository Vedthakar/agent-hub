import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Keychain, type SecurityRunner } from '../shared/keychain.js';
import type { Db } from './db.js';

export type SecretStoreKind = 'keychain' | 'vault' | 'local';

/**
 * Where credentials entered in the dashboard live. Values are encrypted at rest by the backend; the
 * settings table only ever records which names are set. Env vars still win over anything stored here.
 */
export interface SecretStore {
  readonly kind: SecretStoreKind;
  /** Shown in the UI ("Saved in macOS Keychain"). */
  readonly label: string;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
function checkName(name: string) {
  if (!NAME.test(name)) throw new Error(`bad secret name: ${name}`);
}

/** macOS Keychain, for a hub running on the Mac itself. */
export function keychainSecretStore(opts: { service?: string; run?: SecurityRunner } = {}): SecretStore {
  const kc = new Keychain(opts.service ?? 'agent-hub', opts.run);
  return {
    kind: 'keychain',
    label: 'macOS Keychain',
    async get(name) {
      checkName(name);
      return kc.get(name);
    },
    async set(name, value) {
      checkName(name);
      await kc.set(name, value);
    },
    async delete(name) {
      checkName(name);
      await kc.delete(name);
    },
  };
}

const VAULT_PREFIX = 'agent-hub:';

/** True when Supabase Vault is usable on this database (installing the extension if it's available). */
export async function vaultAvailable(db: Db): Promise<boolean> {
  try {
    const ext = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'supabase_vault'");
    if (!ext[0]?.n) return false;
    await db.exec('CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE');
    await db.query('SELECT 1 FROM vault.secrets LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

/** Supabase Vault (authenticated encryption with a key Supabase manages outside the database). */
export function vaultSecretStore(db: Db): SecretStore {
  return {
    kind: 'vault',
    label: 'Supabase Vault',
    async get(name) {
      checkName(name);
      const rows = await db.query<{ v: string | null }>('SELECT decrypted_secret AS v FROM vault.decrypted_secrets WHERE name = $1', [VAULT_PREFIX + name]);
      return rows[0]?.v ?? null;
    },
    async set(name, value) {
      checkName(name);
      const rows = await db.query<{ id: string }>('SELECT id::text AS id FROM vault.secrets WHERE name = $1', [VAULT_PREFIX + name]);
      if (rows[0]) await db.query('SELECT vault.update_secret($1::uuid, $2)', [rows[0].id, value]);
      else await db.query('SELECT vault.create_secret($1, $2, $3)', [value, VAULT_PREFIX + name, 'Agent Hub credential']);
    },
    async delete(name) {
      checkName(name);
      await db.query('DELETE FROM vault.secrets WHERE name = $1', [VAULT_PREFIX + name]);
    },
  };
}

/** Reads HUB_SECRET_KEY (32 bytes, base64 or hex) or a 0600 key file, creating the file on first use. */
export function loadSecretKey(env: NodeJS.ProcessEnv, keyFile: string): Buffer {
  const raw = env.HUB_SECRET_KEY?.trim();
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('HUB_SECRET_KEY must be 32 bytes (64 hex chars or base64)');
    return key;
  }
  if (existsSync(keyFile)) {
    const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${keyFile} is not a valid secret key`);
    return key;
  }
  mkdirSync(path.dirname(keyFile), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return key;
}

/**
 * AES-256-GCM in the hub's own `secrets` table, keyed outside the database. Used when neither the Keychain
 * nor Vault is available (a Linux host with plain Postgres, or embedded PGlite).
 */
export function localSecretStore(db: Db, key: Buffer): SecretStore {
  if (key.length !== 32) throw new Error('secret key must be 32 bytes');
  const seal = (name: string, value: string) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(name));
    const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  };
  const open = (name: string, sealed: string) => {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1') throw new Error('unknown secret format');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(name));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  };
  return {
    kind: 'local',
    label: 'encrypted in the hub database (AES-256-GCM)',
    async get(name) {
      checkName(name);
      const rows = await db.query<{ value: string }>('SELECT value FROM secrets WHERE name = $1', [name]);
      return rows[0] ? open(name, rows[0].value) : null;
    },
    async set(name, value) {
      checkName(name);
      await db.query(
        `INSERT INTO secrets (name, value) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [name, seal(name, value)],
      );
    },
    async delete(name) {
      checkName(name);
      await db.query('DELETE FROM secrets WHERE name = $1', [name]);
    },
  };
}

/**
 * Picks the backend: HUB_SECRET_STORE if set, else the Keychain on a Mac, else Supabase Vault when the
 * database has it, else the local encrypted table.
 */
export async function createSecretStore(opts: { db: Db; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; postgres: boolean; keyFile: string }): Promise<SecretStore> {
  const env = opts.env ?? process.env;
  const want = env.HUB_SECRET_STORE as SecretStoreKind | undefined;
  if (want && !['keychain', 'vault', 'local'].includes(want)) throw new Error('HUB_SECRET_STORE must be keychain, vault or local');
  const platform = opts.platform ?? process.platform;
  if (want === 'keychain' || (!want && platform === 'darwin')) return keychainSecretStore();
  if (want === 'vault' || (!want && opts.postgres)) {
    if (await vaultAvailable(opts.db)) return vaultSecretStore(opts.db);
    if (want === 'vault') throw new Error('HUB_SECRET_STORE=vault but Supabase Vault is not available on this database');
  }
  return localSecretStore(opts.db, loadSecretKey(env, opts.keyFile));
}
