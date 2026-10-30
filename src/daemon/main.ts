import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { log } from '../shared/log.js';
import { DAEMON_VERSION, Daemon, fileStateStore, httpHubClient } from './daemon.js';
import { sendIMessage } from './send.js';

const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AgentHub');
dotenv.config({ path: process.env.AGENT_HUB_ENV ?? path.join(SUPPORT_DIR, 'daemon.env'), quiet: true });
dotenv.config({ quiet: true });

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:8787';
const TOKEN = process.env.HUB_DAEMON_TOKEN ?? '';
const CHAT_DB = process.env.CHAT_DB ?? path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const STATE_FILE = process.env.DAEMON_STATE_FILE ?? path.join(SUPPORT_DIR, 'state.json');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!TOKEN) throw new Error('HUB_DAEMON_TOKEN is not set');
  const dlog = log.child({ svc: 'daemon' });
  dlog.info('daemon.start', { version: DAEMON_VERSION, hub: HUB_URL, chatDb: CHAT_DB });
  const daemon = new Daemon({
    chatDbPath: CHAT_DB,
    hub: httpHubClient(HUB_URL, TOKEN),
    state: fileStateStore(STATE_FILE),
    send: sendIMessage,
    log: dlog,
    backfillHours: Number(process.env.BACKFILL_HOURS ?? 0),
    newHandleBackfillHours: Number(process.env.NEW_HANDLE_BACKFILL_HOURS ?? 24),
  });

  let stopping = false;
  const stop = (sig: string) => {
    dlog.info('daemon.stop', { signal: sig });
    stopping = true;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (!stopping) {
    const r = await daemon.cycle();
    if (r.shipped || r.sent || r.skipped) dlog.info('daemon.cycle', { shipped: r.shipped, pages: r.pages, sent: r.sent, skipped: r.skipped, checkpoint: daemon.checkpoint });
    await sleep(daemon.backoffMs || 5_000);
  }
  daemon.close();
}

main().catch((err) => {
  log.error('daemon.fatal', { error: String(err) });
  process.exit(1);
});
