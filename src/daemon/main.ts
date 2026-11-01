import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { Keychain } from '../shared/keychain.js';
import { log } from '../shared/log.js';
import { DAEMON_VERSION, Daemon, fileStateStore, httpHubClient, pairWithHub } from './daemon.js';
import { macOps } from './mac.js';
import { sendIMessage } from './send.js';

const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AgentHub');
const SETTINGS_FILE = path.join(SUPPORT_DIR, 'daemon.json');
dotenv.config({ path: process.env.AGENT_HUB_ENV ?? path.join(SUPPORT_DIR, 'daemon.env'), quiet: true });
dotenv.config({ quiet: true });

const CHAT_DB = process.env.CHAT_DB ?? path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const STATE_FILE = process.env.DAEMON_STATE_FILE ?? path.join(SUPPORT_DIR, 'state.json');
/** The daemon's pairing token lives in the login Keychain, never in a file. */
const keychain = new Keychain('agent-hub-daemon');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function savedHubUrl(): string | null {
  try {
    return (JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { hubUrl?: string }).hubUrl ?? null;
  } catch {
    return null;
  }
}

/** `daemon pair <hub-url> <code>`: run by the installer (or the dashboard's "Install on this Mac" button). */
async function pair(hubUrl: string, code: string) {
  const url = new URL(hubUrl).toString().replace(/\/$/, '');
  const token = await pairWithHub(url, code);
  await keychain.set('token', token);
  mkdirSync(SUPPORT_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify({ hubUrl: url }, null, 2), { mode: 0o600 });
  console.log(`Paired with ${url}. The token is in your login Keychain (agent-hub-daemon).`);
}

async function main() {
  if (process.argv[2] === 'pair') {
    const [hubUrl, code] = process.argv.slice(3);
    if (!hubUrl || !code) throw new Error('usage: daemon pair <hub-url> <pairing-code>');
    await pair(hubUrl, code);
    return;
  }
  const hubUrl = process.env.HUB_URL ?? savedHubUrl() ?? 'http://localhost:8787';
  const token = process.env.HUB_DAEMON_TOKEN || (process.platform === 'darwin' ? await keychain.get('token').catch(() => null) : null);
  if (!token) throw new Error('Not paired: open the hub dashboard → Connections → Mac, or set HUB_DAEMON_TOKEN');
  const dlog = log.child({ svc: 'daemon' });
  dlog.info('daemon.start', { version: DAEMON_VERSION, hub: hubUrl, chatDb: CHAT_DB, paired: !process.env.HUB_DAEMON_TOKEN });
  const daemon = new Daemon({
    chatDbPath: CHAT_DB,
    hub: httpHubClient(hubUrl, token),
    state: fileStateStore(STATE_FILE),
    send: sendIMessage,
    log: dlog,
    backfillHours: Number(process.env.BACKFILL_HOURS ?? 0),
    newHandleBackfillHours: Number(process.env.NEW_HANDLE_BACKFILL_HOURS ?? 24),
    mac: process.platform === 'darwin' ? macOps() : undefined,
    nodePath: process.execPath,
  });

  let stopping = false;
  const stop = (sig: string) => {
    dlog.info('daemon.stop', { signal: sig });
    stopping = true;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const started = Date.now();
  while (!stopping) {
    const r = await daemon.cycle();
    if (r.shipped || r.sent || r.skipped) dlog.info('daemon.cycle', { shipped: r.shipped, pages: r.pages, sent: r.sent, skipped: r.skipped, checkpoint: daemon.checkpoint });
    // macOS only applies a new Full Disk Access grant to a fresh process. Under launchd (KeepAlive) exiting
    // means a relaunch ~10s later, so the dashboard sees the grant without anyone restarting anything.
    if (daemon.fullDiskAccess === false && process.env.AGENT_HUB_LAUNCHD === '1' && Date.now() - started > 30_000) {
      dlog.info('daemon.restart_for_fda', {});
      break;
    }
    await sleep(daemon.backoffMs || 5_000);
  }
  daemon.close();
}

main().catch((err) => {
  log.error('daemon.fatal', { error: String(err) });
  process.exit(1);
});

