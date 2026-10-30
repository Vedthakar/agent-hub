import { log } from '../shared/log.js';
import { ADAPTERS } from './adapters/index.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { createLlm } from './llm.js';
import { createApp } from './server.js';
import { Store } from './store.js';
import { createTransports } from './transports/index.js';

async function main() {
  const cfg = loadConfig();
  const db = await openDb({ databaseUrl: cfg.databaseUrl, pgliteDir: cfg.pgliteDir });
  const store = new Store(db);
  await store.ensureDefaultScopes();

  const llm = createLlm(cfg.router);
  if (!llm) log.warn('hub.no_router_llm', { hint: 'set ANTHROPIC_API_KEY or OPENAI_API_KEY; sessions are logged but not analysed' });
  if (!cfg.daemonToken) log.warn('hub.no_daemon_token', { hint: 'set HUB_DAEMON_TOKEN so the Mac daemon can connect' });
  if (!process.env.HUB_SESSION_SECRET) log.warn('hub.ephemeral_session_secret', { hint: 'set HUB_SESSION_SECRET or dashboard logins reset on restart' });
  if (cfg.approval.channel === 'none') log.warn('hub.no_approval_channel', { hint: 'hand-offs can only be approved from the dashboard' });
  for (const a of Object.values(ADAPTERS)) {
    const c = a.configured(cfg);
    if (!c.ok) log.info('adapter.unconfigured', { agent: a.id, note: c.note });
  }

  const hub = new Hub(store, cfg, createTransports(cfg, store), llm);
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
