import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/hub/db.js';
import { createSecretStore, vaultAvailable, vaultSecretStore } from '../../src/hub/secrets.js';
import { backend, freshDatabase } from '../support/db.js';

const run = backend() === 'supabase' ? describe : describe.skip;

run('Supabase Vault secret store', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });
  async function db(): Promise<Db> {
    const fresh = await freshDatabase();
    const d = await openDb({ databaseUrl: fresh.url, pgliteDir: null, maxConnections: 2 });
    cleanups.push(async () => {
      await d.close();
      await fresh.drop();
    });
    return d;
  }

  it('is picked on Postgres, keeps only ciphertext in vault.secrets, and round-trips', async () => {
    const d = await db();
    expect(await vaultAvailable(d)).toBe(true);
    const store = await createSecretStore({ db: d, env: {}, platform: 'linux', postgres: true, keyFile: '/nonexistent/secret.key' });
    expect(store.kind).toBe('vault');
    const secret = 'telegram-session-1BVtsOK8Bu-very-secret';
    await store.set('cfg.stanley.session', secret);
    const raw = await d.query<{ secret: string }>("SELECT secret FROM vault.secrets WHERE name = 'agent-hub:cfg.stanley.session'");
    expect(raw).toHaveLength(1);
    expect(raw[0].secret).not.toContain(secret);
    expect(await store.get('cfg.stanley.session')).toBe(secret);
    await store.set('cfg.stanley.session', 'rotated');
    expect(await store.get('cfg.stanley.session')).toBe('rotated');
    expect(await d.query("SELECT 1 FROM vault.secrets WHERE name = 'agent-hub:cfg.stanley.session'")).toHaveLength(1);
    // Nothing lands in the hub's own tables.
    expect(await d.query('SELECT 1 FROM secrets')).toHaveLength(0);
    await store.delete('cfg.stanley.session');
    expect(await store.get('cfg.stanley.session')).toBeNull();
  });

  it('values are stored as parameters, never spliced into SQL', async () => {
    const d = await db();
    expect(await vaultAvailable(d)).toBe(true);
    const store = vaultSecretStore(d);
    const hostile = "x'); SELECT vault.create_secret('pwned'); --";
    await store.set('cfg.router.key', hostile);
    expect(await store.get('cfg.router.key')).toBe(hostile);
    await expect(store.set("bad'name", 'x')).rejects.toThrow(/bad secret name/);
  });
});
