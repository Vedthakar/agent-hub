import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../shared/log.js';
import { ADAPTERS } from './adapters/index.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Hub, type MacInstaller } from './hub.js';
import { createLlm } from './llm.js';
import { createSecretStore } from './secrets.js';
import { createApp } from './server.js';
import { Store } from './store.js';
import { createTransports } from './transports/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** When the hub runs on the Mac, "Install on this Mac" runs the installer directly: no Terminal needed. */
const localInstaller: MacInstaller = (hubUrl, code) =>
  new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(REPO, 'scripts', 'install-daemon.sh'), 'pair', hubUrl, code], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `installer exited ${status}`))));
  });

async function main() {
  const cfg = loadConfig();
  const db = await openDb({ databaseUrl: cfg.databaseUrl, pgliteDir: cfg.pgliteDir });
  const store = new Store(db);
  await store.ensureDefaultScopes();
  const secrets = await createSecretStore({ db, postgres: Boolean(cfg.databaseUrl), keyFile: path.join(path.dirname(cfg.pgliteDir), 'secret.key') });

  const hub = new Hub(store, cfg, createTransports(cfg, store), createLlm(cfg.router), {
    secrets,
    env: process.env,
    makeTransports: createTransports,
    makeLlm: createLlm,
  });
  await hub.connections.load();
  await hub.reconfigure();
  if (process.platform === 'darwin') hub.macInstaller = localInstaller;

  log.info('hub.secret_store', { kind: secrets.kind });
  if (!hub.connections.hasOwnerPassword()) {
    // The only way in before a password exists. Printed once per boot, never stored.
    const url = `${cfg.publicUrl}/welcome?token=${hub.connections.setupToken}`;
    log.info('hub.setup', { url, hint: 'open this link to create your dashboard password' });
    if (process.stdout.isTTY) console.log(`\n  Agent Hub is running. Open this link to set it up:\n\n    ${url}\n`);
  }
  if (!hub.llm) log.warn('hub.no_router_llm', { hint: 'add an Anthropic or OpenAI key in the dashboard; sessions are logged but not analysed' });
  if (cfg.approval.channel === 'none') log.warn('hub.no_approval_channel', { hint: 'hand-offs can only be approved from the dashboard' });
  for (const a of Object.values(ADAPTERS)) {
    const c = a.configured(cfg);
    if (!c.ok) log.info('adapter.unconfigured', { agent: a.id, note: c.note });
  }

  const app = createApp(hub);
  const stop = hub.start();
  const server = app.listen(cfg.port, () => {
    log.info('hub.listening', { url: cfg.publicUrl, db: cfg.databaseUrl ? 'postgres' : `pglite:${cfg.pgliteDir}` });
  });

  const shutdown = async () => {
    stop();
    server.close();
    await hub.idle();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('hub.fatal', { error: String(err) });
  process.exit(1);
});
