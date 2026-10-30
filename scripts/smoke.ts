/**
 * Live smoke test with real credentials. Run it by hand:
 *
 *   npm run smoke                      # all four checks
 *   npm run smoke -- --dry-run         # show targets and guard results, send nothing
 *   npm run smoke -- --only=mcp,email  # a subset: mcp, email, telegram, approval
 *
 * Reads .env, then smoke.env (gitignored) on top. Every message goes to YOU, never to an agent:
 *   mcp       OAuth-connects to the hub exactly like Claude's connector does, calls get_situation, revokes the token.
 *   email     one test email over SMTP to SMOKE_EMAIL_TO (default EMAIL_FROM), not Instinct's forwarding address.
 *   telegram  one message from your Telegram account to SMOKE_TELEGRAM_PEER (your own test bot), not Stanley.
 *   approval  one approval-style text to your phone over the configured approval channel.
 * Before sending anything, every target is checked against the agents' addresses and handles; a match aborts the check.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config as dotenv } from 'dotenv';
import { loadConfig, type HubConfig } from '../src/hub/config.js';
import { normalizeHandle } from '../src/daemon/chatdb.js';
import { createEmail, type EmailTransport } from '../src/hub/transports/email.js';
import { createSms, type SmsTransport } from '../src/hub/transports/sms.js';

export const CHECKS = ['mcp', 'email', 'telegram', 'approval'] as const;
export type CheckName = (typeof CHECKS)[number];

export interface SmokeTelegram {
  resolve(peer: string): Promise<{ id: string; bot: boolean }>;
  send(peer: string, text: string): Promise<number>;
  /** True if message `id` is visible in the chat with `peer` (read-back through the same path the hub reads Stanley). */
  readBack(peer: string, id: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface SmokeDeps {
  email(cfg: HubConfig['email']): EmailTransport | null;
  telegram(cfg: HubConfig['stanley']): SmokeTelegram | null;
  sms(cfg: HubConfig['approval']['twilio']): SmsTransport | null;
  telegramBot(token: string, chatId: string, text: string): Promise<void>;
  imessage(handle: string, body: string): Promise<void>;
}

export interface CheckResult {
  name: CheckName;
  ok: boolean;
  detail: string;
  ms: number;
}

/** Thrown when a target belongs to an agent. */
class GuardError extends Error {}

const BOARDY_DEFAULT = 'boardy@boardy.ai';
const normEmail = (e: string) => e.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, '$1');
const normPeer = (p: string) => p.trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');

/** Every address, handle and peer that reaches a real agent. Smoke targets must not be any of these. */
export function agentTargets(env: Record<string, string | undefined>, cfg: HubConfig) {
  const emails = new Set<string>([BOARDY_DEFAULT, normEmail(cfg.boardyEmail)]);
  if (cfg.instinctEmail) emails.add(normEmail(cfg.instinctEmail));
  const handles = new Set<string>();
  for (const h of Object.values(cfg.imessageHandles)) {
    if (!h) continue;
    handles.add(normalizeHandle(h));
    if (h.includes('@')) emails.add(normEmail(h));
  }
  const peers = new Set<string>();
  if (cfg.stanley.peer) peers.add(normPeer(cfg.stanley.peer));
  for (const p of (env.SMOKE_EXTRA_AGENT_PEERS ?? '').split(',').filter(Boolean)) peers.add(normPeer(p));
  return { emails, handles, peers, domains: new Set(['boardy.ai']) };
}

function guardEmail(to: string, t: ReturnType<typeof agentTargets>) {
  const e = normEmail(to);
  if (t.emails.has(e) || t.domains.has(e.split('@')[1] ?? '')) throw new GuardError(`refusing: ${to} is an agent's address`);
}

function guardHandle(handle: string, t: ReturnType<typeof agentTargets>) {
  if (t.handles.has(normalizeHandle(handle))) throw new GuardError(`refusing: ${handle} is an agent's iMessage handle`);
  if (handle.includes('@')) guardEmail(handle, t);
}

/** Error text with every configured secret value blanked (SMTP URLs embed passwords). */
function scrub(err: unknown, env: Record<string, string | undefined>): string {
  let s = err instanceof Error ? err.message : String(err);
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 6 && /PASSWORD|SECRET|TOKEN|SESSION|KEY|SMTP_URL|IMAP_URL|AUTH|HASH|DATABASE_URL/i.test(k)) s = s.split(v).join('***');
  }
  return s.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***@').slice(0, 300);
}

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// ------------------------------------------------------------------ checks

async function checkMcp(hubUrl: string, cfg: HubConfig, dry: boolean): Promise<string> {
  if (!hubUrl) throw new Error('set SMOKE_HUB_URL or HUB_PUBLIC_URL');
  if (!cfg.ownerPassword) throw new Error('HUB_OWNER_PASSWORD is needed to approve the OAuth consent screen');
  const base = hubUrl.replace(/\/$/, '');
  if (dry) return `would OAuth-connect to ${base}/mcp as Claude and call get_situation`;

  const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  if (unauth.status !== 401) throw new Error(`unauthenticated /mcp returned ${unauth.status}, expected 401`);

  const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as {
    authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; revocation_endpoint?: string;
  };
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const regRes = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude (smoke test)', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
  });
  if (!regRes.ok) throw new Error(`client registration failed: ${regRes.status}`);
  const reg = (await regRes.json()) as { client_id: string };

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(8).toString('hex');
  const consent = await fetch(`${base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, state, agent: 'claude', password: cfg.ownerPassword, decision: 'allow' }),
  });
  const location = consent.headers.get('location');
  if (consent.status !== 302 || !location) throw new Error(`consent failed: ${consent.status} (wrong HUB_OWNER_PASSWORD?)`);
  const loc = new URL(location);
  if (loc.searchParams.get('state') !== state || !loc.searchParams.get('code')) throw new Error('consent redirect missing code/state');

  const tokenRes = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: loc.searchParams.get('code')!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
  const { access_token: token } = (await tokenRes.json()) as { access_token: string };

  const client = new Client({ name: 'agent-hub-smoke', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    if (!tools.includes('get_situation')) throw new Error(`get_situation missing; tools: ${tools.join(', ')}`);
    const res = (await client.callTool({ name: 'get_situation', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map((c) => c.text).join('\n');
    if (res.isError || !text.includes('CURRENT SITUATION')) throw new Error('get_situation returned an unexpected response');
    const items = text.split('CURRENT SITUATION')[1]?.split('\n\n')[0].split('\n').filter((l) => l.startsWith('- ')).length ?? 0;

    let revoked = 'not revoked (no revocation endpoint)';
    if (meta.revocation_endpoint) {
      await fetch(meta.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, client_id: reg.client_id }) });
      const after = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      if (after.status !== 401) throw new Error(`revoked token still accepted (${after.status})`);
      revoked = 'token revoked';
    }
    return `OAuth as Claude → get_situation OK (${items} situation line${items === 1 ? '' : 's'}); ${revoked}`;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function checkEmail(env: Record<string, string | undefined>, cfg: HubConfig, deps: SmokeDeps, t: ReturnType<typeof agentTargets>, dry: boolean): Promise<string> {
  const to = env.SMOKE_EMAIL_TO || cfg.email.from;
  if (!to) throw new Error('set SMOKE_EMAIL_TO (your own address)');
  guardEmail(to, t);
  const mail = deps.email(cfg.email);
  if (!mail) throw new Error('SMTP_URL and EMAIL_FROM are not set');
  if (dry) return `would email ${to}`;
  const { messageId } = await mail.send({
    to,
    subject: `Agent Hub smoke test ${stamp()}`,
    text: 'This is the Agent Hub live smoke test. It used the same SMTP path that delivers tasks to Instinct, but was sent to you instead. No action needed.',
  });
  return `SMTP accepted mail to ${to} (${messageId})`;
}

async function checkTelegram(env: Record<string, string | undefined>, cfg: HubConfig, deps: SmokeDeps, t: ReturnType<typeof agentTargets>, dry: boolean): Promise<string> {
  const peer = env.SMOKE_TELEGRAM_PEER;
  if (!peer) throw new Error('set SMOKE_TELEGRAM_PEER to your own test bot (@username)');
  if (t.peers.has(normPeer(peer))) throw new GuardError(`refusing: ${peer} is an agent's Telegram peer`);
  const tg = deps.telegram({ ...cfg.stanley, peer });
  if (!tg) throw new Error('TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION are not set (run `npm run telegram:login`)');
  try {
    const target = await tg.resolve(peer);
    for (const agentPeer of t.peers) {
      const agent = await tg.resolve(agentPeer).catch(() => null);
      if (agent && agent.id === target.id) throw new GuardError(`refusing: ${peer} resolves to the same account as agent peer @${agentPeer}`);
    }
    if (!target.bot) throw new GuardError(`refusing: ${peer} is not a bot; point SMOKE_TELEGRAM_PEER at your own test bot`);
    if (dry) return `would message ${peer} (bot id ${target.id})`;
    const id = await tg.send(peer, `Agent Hub smoke test ${stamp()}: Stanley's delivery path, sent to your test bot instead.`);
    if (!(await tg.readBack(peer, id))) throw new Error(`sent message ${id} but could not read it back`);
    return `sent and read back message ${id} with ${peer}`;
  } finally {
    await tg.close().catch(() => undefined);
  }
}

async function checkApproval(cfg: HubConfig, deps: SmokeDeps, t: ReturnType<typeof agentTargets>, dry: boolean): Promise<string> {
  const body = `[SMOKE TEST] Agent Hub → you: this is what an approval text looks like. Real ones end with 'Reply "Y K3FD" or "N K3FD"'. Don't reply to this one.`;
  const a = cfg.approval;
  switch (a.channel) {
    case 'sms': {
      if (!a.twilio.userNumber) throw new Error('APPROVAL_USER_NUMBER is not set');
      guardHandle(a.twilio.userNumber, t);
      const sms = deps.sms(a.twilio);
      if (!sms) throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are needed');
      if (dry) return `would text ${a.twilio.userNumber} from ${a.twilio.from} via Twilio`;
      await sms.send(body);
      return `Twilio accepted a text to ${a.twilio.userNumber}`;
    }
    case 'telegram': {
      if (!a.telegramBotToken || !a.telegramChatId) throw new Error('APPROVAL_TELEGRAM_BOT_TOKEN and APPROVAL_TELEGRAM_CHAT_ID are needed');
      if (dry) return `would message chat ${a.telegramChatId} from the hub's approval bot`;
      await deps.telegramBot(a.telegramBotToken, a.telegramChatId, body);
      return `approval bot messaged chat ${a.telegramChatId}`;
    }
    case 'imessage': {
      if (!a.imessageHandle) throw new Error('APPROVAL_IMESSAGE_HANDLE is not set');
      guardHandle(a.imessageHandle, t);
      if (dry) return `would iMessage ${a.imessageHandle} through Messages.app`;
      await deps.imessage(a.imessageHandle, body);
      return `Messages.app sent a text to ${a.imessageHandle}`;
    }
    default:
      throw new Error('no approval channel configured (APPROVAL_IMESSAGE_HANDLE, APPROVAL_TELEGRAM_* or TWILIO_*)');
  }
}

// ------------------------------------------------------------------ runner

export async function runSmoke(
  env: Record<string, string | undefined>,
  deps: SmokeDeps,
  opts: { only?: CheckName[]; dryRun?: boolean; print?: (line: string) => void } = {},
): Promise<CheckResult[]> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const cfg = loadConfig(env as NodeJS.ProcessEnv);
  const targets = agentTargets(env, cfg);
  const hubUrl = env.SMOKE_HUB_URL || env.HUB_PUBLIC_URL || '';
  const dry = Boolean(opts.dryRun);
  const run: Record<CheckName, () => Promise<string>> = {
    mcp: () => checkMcp(hubUrl, cfg, dry),
    email: () => checkEmail(env, cfg, deps, targets, dry),
    telegram: () => checkTelegram(env, cfg, deps, targets, dry),
    approval: () => checkApproval(cfg, deps, targets, dry),
  };
  print(`Agent Hub live smoke test${dry ? ' (dry run: nothing is sent)' : ''} → ${hubUrl || '(no hub URL)'}`);
  const results: CheckResult[] = [];
  for (const name of opts.only?.length ? opts.only : CHECKS) {
    const t0 = Date.now();
    let r: CheckResult;
    try {
      r = { name, ok: true, detail: await run[name](), ms: Date.now() - t0 };
    } catch (err) {
      r = { name, ok: false, detail: (err instanceof GuardError ? 'GUARD ' : '') + scrub(err, env), ms: Date.now() - t0 };
    }
    results.push(r);
    print(`  ${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(9)} ${r.detail} (${r.ms} ms)`);
  }
  const passed = results.filter((r) => r.ok).length;
  print(`${passed}/${results.length} passed`);
  return results;
}

// ------------------------------------------------------------------ real dependencies

function realTelegram(cfg: HubConfig['stanley']): SmokeTelegram | null {
  if (!cfg.apiId || !cfg.apiHash || !cfg.session) return null;
  let clientP: Promise<import('telegram').TelegramClient> | null = null;
  const client = () =>
    (clientP ??= (async () => {
      const { TelegramClient } = await import('telegram');
      const { StringSession } = await import('telegram/sessions/index.js');
      const c = new TelegramClient(new StringSession(cfg.session!), cfg.apiId!, cfg.apiHash!, { connectionRetries: 3 });
      c.setLogLevel('error' as never);
      await c.connect();
      return c;
    })());
  return {
    async resolve(peer) {
      const e = (await (await client()).getEntity(peer)) as unknown as { id: { toString(): string }; bot?: boolean };
      return { id: e.id.toString(), bot: Boolean(e.bot) };
    },
    async send(peer, text) {
      return (await (await client()).sendMessage(peer, { message: text })).id;
    },
    async readBack(peer, id) {
      const msgs = await (await client()).getMessages(peer, { ids: [id] });
      return msgs.some((m) => m?.id === id);
    },
    async close() {
      if (clientP) await (await clientP).disconnect();
    },
  };
}

export const realDeps: SmokeDeps = {
  email: createEmail,
  telegram: realTelegram,
  sms: createSms,
  async telegramBot(token, chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`telegram sendMessage ${res.status}`);
  },
  async imessage(handle, body) {
    const { sendIMessage } = await import('../src/daemon/send.js');
    await sendIMessage(handle, body);
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dotenv({ quiet: true });
  if (existsSync('smoke.env')) dotenv({ path: 'smoke.env', override: true, quiet: true });
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean) as CheckName[] | undefined;
  const bad = only?.filter((c) => !CHECKS.includes(c));
  if (bad?.length) {
    console.error(`unknown check(s): ${bad.join(', ')}; choose from ${CHECKS.join(', ')}`);
    process.exit(2);
  }
  const results = await runSmoke(process.env, realDeps, { only, dryRun: args.includes('--dry-run') });
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
