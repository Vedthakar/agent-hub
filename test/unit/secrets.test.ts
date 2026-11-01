import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/hub/db.js';
import { createSecretStore, keychainSecretStore, loadSecretKey, localSecretStore } from '../../src/hub/secrets.js';
import { Keychain, type SecurityRunner } from '../../src/shared/keychain.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function pglite(): Promise<Db> {
  const db = await openDb({ databaseUrl: null, pgliteDir: null, maxConnections: 1 });
  cleanups.push(() => db.close());
  return db;
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-secrets-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An in-memory stand-in for /usr/bin/security that records every argv and stdin it was given. */
function fakeSecurity() {
  const items = new Map<string, string>();
  const calls: { args: string[]; stdin: string }[] = [];
  const run: SecurityRunner = async (args, stdin = '') => {
    calls.push({ args, stdin });
    const opt = (a: string[], flag: string) => a[a.indexOf(flag) + 1];
    if (args[0] === '-i') {
      const line = stdin.trim().match(/^add-generic-password -U -s "([^"]+)" -a "([^"]+)" -X ([0-9a-f]+)$/);
      if (!line) return { code: 1, stdout: '', stderr: 'parse error' };
      items.set(`${line[1]}/${line[2]}`, Buffer.from(line[3], 'hex').toString('utf8'));
      return { code: 0, stdout: '', stderr: '' };
    }
    const key = `${opt(args, '-s')}/${opt(args, '-a')}`;
    if (args[0] === 'find-generic-password') return items.has(key) ? { code: 0, stdout: `${items.get(key)}\n`, stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
    if (args[0] === 'delete-generic-password') return items.delete(key) ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: '' };
    return { code: 2, stdout: '', stderr: 'unknown' };
  };
  return { run, calls, items };
}

describe('local secret store (AES-256-GCM in the hub database)', () => {
  it('stores only ciphertext and reads it back', async () => {
    const db = await pglite();
    const store = localSecretStore(db, randomBytes(32));
    const secret = 'sk-ant-api03-very-secret-value';
    await store.set('cfg.router.key', secret);
    const [row] = await db.query<{ value: string }>('SELECT value FROM secrets WHERE name = $1', ['cfg.router.key']);
    expect(row.value).toMatch(/^v1\./);
    expect(row.value).not.toContain(secret);
    expect(row.value).not.toContain(Buffer.from(secret).toString('base64'));
    expect(await store.get('cfg.router.key')).toBe(secret);
    await store.set('cfg.router.key', 'rotated');
    expect(await store.get('cfg.router.key')).toBe('rotated');
    await store.delete('cfg.router.key');
    expect(await store.get('cfg.router.key')).toBeNull();
  });

  it('a wrong key, tampered ciphertext or a value moved to another name fails to decrypt', async () => {
    const db = await pglite();
    const key = randomBytes(32);
    await localSecretStore(db, key).set('cfg.a', 'alpha');
    await expect(localSecretStore(db, randomBytes(32)).get('cfg.a')).rejects.toThrow();
    const [row] = await db.query<{ value: string }>('SELECT value FROM secrets WHERE name = $1', ['cfg.a']);
    const parts = row.value.split('.');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 1;
    await db.query('UPDATE secrets SET value = $1 WHERE name = $2', [[...parts.slice(0, 3), ct.toString('base64')].join('.'), 'cfg.a']);
    await expect(localSecretStore(db, key).get('cfg.a')).rejects.toThrow();
    // The name is authenticated data: copying one secret's row under another name doesn't decrypt.
    await localSecretStore(db, key).set('cfg.b', 'bravo');
    await db.query('INSERT INTO secrets (name, value) SELECT $1, value FROM secrets WHERE name = $2', ['cfg.c', 'cfg.b']);
    await expect(localSecretStore(db, key).get('cfg.c')).rejects.toThrow();
  });

  it('rejects odd names and keys that are not 32 bytes', async () => {
    const db = await pglite();
    const store = localSecretStore(db, randomBytes(32));
    await store.set('cfg.hub.sessionSecret', 's3cret');
    expect(await store.get('cfg.hub.sessionSecret')).toBe('s3cret');
    await expect(store.set('../etc/passwd', 'x')).rejects.toThrow(/bad secret name/);
    await expect(store.set("x'; DROP TABLE secrets; --", 'x')).rejects.toThrow(/bad secret name/);
    expect(() => localSecretStore(db, randomBytes(16))).toThrow();
  });

  it('the key comes from HUB_SECRET_KEY or a 0600 key file created on first use', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'secret.key');
    const first = loadSecretKey({}, file);
    expect(first).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadSecretKey({}, file).equals(first)).toBe(true);
    const hex = randomBytes(32).toString('hex');
    expect(loadSecretKey({ HUB_SECRET_KEY: hex }, file).toString('hex')).toBe(hex);
    expect(() => loadSecretKey({ HUB_SECRET_KEY: 'short' }, file)).toThrow(/32 bytes/);
  });

  it('createSecretStore: Keychain on a Mac, local table elsewhere, HUB_SECRET_STORE overrides', async () => {
    const db = await pglite();
    const keyFile = path.join(tempDir(), 'secret.key');
    expect((await createSecretStore({ db, env: {}, platform: 'darwin', postgres: false, keyFile })).kind).toBe('keychain');
    expect((await createSecretStore({ db, env: {}, platform: 'linux', postgres: false, keyFile })).kind).toBe('local');
    expect((await createSecretStore({ db, env: { HUB_SECRET_STORE: 'local' }, platform: 'darwin', postgres: false, keyFile })).kind).toBe('local');
    await expect(createSecretStore({ db, env: { HUB_SECRET_STORE: 'vault' }, platform: 'linux', postgres: false, keyFile })).rejects.toThrow(/Vault is not available/);
    await expect(createSecretStore({ db, env: { HUB_SECRET_STORE: 'plaintext' }, platform: 'linux', postgres: false, keyFile })).rejects.toThrow();
  });
});

describe('macOS Keychain', () => {
  it('secrets go over stdin, never argv, and round-trip any characters', async () => {
    const sec = fakeSecurity();
    const store = keychainSecretStore({ run: sec.run });
    const tricky = 'p@ss "SEKRIT" $(rm -rf ~) \n ünïcødé 🔑';
    await store.set('cfg.stanley.session', tricky);
    expect(await store.get('cfg.stanley.session')).toBe(tricky);
    for (const c of sec.calls) expect(c.args.join(' ')).not.toContain('SEKRIT');
    const write = sec.calls.find((c) => c.args[0] === '-i')!;
    expect(write.stdin).not.toContain('SEKRIT');
    expect(write.stdin).toMatch(/-X [0-9a-f]+\n$/);
    expect(sec.items.get('agent-hub/cfg.stanley.session')).toMatch(/^b64:/);
    await store.delete('cfg.stanley.session');
    expect(await store.get('cfg.stanley.session')).toBeNull();
    await store.delete('cfg.stanley.session');
  });

  it('refuses names that could break out of the security command line', async () => {
    const kc = new Keychain('agent-hub', fakeSecurity().run);
    await expect(kc.set('a" -X 00 "b', 'x')).rejects.toThrow(/bad keychain account/);
    await expect(kc.get('a b')).rejects.toThrow();
    expect(() => new Keychain('svc"; rm', fakeSecurity().run)).toThrow();
  });

  it('surfaces real failures (locked keychain) instead of treating them as "not set"', async () => {
    const kc = new Keychain('agent-hub', async () => ({ code: 51, stdout: '', stderr: 'User interaction is not allowed.' }));
    await expect(kc.get('x')).rejects.toThrow(/keychain read failed \(51\)/);
    await expect(kc.set('x', 'y')).rejects.toThrow(/keychain write failed/);
  });

  it.runIf(process.platform === 'darwin' && process.env.HUB_TEST_KEYCHAIN === '1')('round-trips through the real login Keychain', async () => {
    const store = keychainSecretStore({ service: `agent-hub-test-${process.pid}` });
    const value = `secret-${randomBytes(8).toString('hex')}`;
    await store.set('cfg.test', value);
    try {
      expect(await store.get('cfg.test')).toBe(value);
    } finally {
      await store.delete('cfg.test');
    }
    expect(await store.get('cfg.test')).toBeNull();
  });
});
