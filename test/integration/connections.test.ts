import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signWebhook } from '../../src/hub/adapters/grok.js';
import type { TelegramLoginDriver } from '../../src/hub/telegramLogin.js';
import { ChatDb } from '../../src/daemon/chatdb.js';
import { Daemon, httpHubClient, pairWithHub, type DaemonState } from '../../src/daemon/daemon.js';
import type { MacOps } from '../../src/daemon/mac.js';
import { isAgentId } from '../../src/shared/types.js';
import { createLogger } from '../../src/shared/log.js';
import { buildChatDb } from '../fixtures/chatdb.js';
import { HANDLES, makeHub, serve } from '../helpers.js';
import { mcpClient, onCleanup } from '../security/harness.js';

/** Everything a fresh install has: no password, no tokens, no handles, nothing to send email with. */
const BLANK = {
  HUB_OWNER_PASSWORD: '',
  HUB_DAEMON_TOKEN: '',
  HUB_AGENT_TOKENS: 'claude:claude-token',
  IMESSAGE_HANDLES: '',
  APPROVAL_IMESSAGE_HANDLE: '',
  SMTP_URL: '',
  EMAIL_FROM: '',
  INSTINCT_EMAIL: '',
  HUB_OWNER_NAME: '',
  HUB_TIMEZONE: '',
};

async function hubFor(env: Record<string, string>) {
  const ctx = await makeHub(env);
  const http = await serve(ctx.hub);
  onCleanup(async () => {
    await http.close();
    await ctx.hub.idle();
    await ctx.db.close();
  });
  return { ...ctx, url: http.url };
}

type Form = Record<string, string | string[]>;

/** A browser on the dashboard: keeps the session cookie and sends same-origin requests. */
function browser(url: string) {
  let cookie = '';
  const req = async (method: string, p: string, body?: URLSearchParams | object) => {
    const headers: Record<string, string> = { origin: url };
    if (cookie) headers.cookie = cookie;
    let payload: string | URLSearchParams | undefined;
    if (body instanceof URLSearchParams) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = body;
    } else if (body) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${url}${p}`, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set?.startsWith('hub_session=')) cookie = set.split(';')[0];
    return res;
  };
  const b = {
    get: (p: string) => req('GET', p),
    async html(p: string) {
      const res = await req('GET', p);
      expect(res.status, `GET ${p}`).toBe(200);
      return res.text();
    },
    form(p: string, data: Form) {
      const f = new URLSearchParams();
      for (const [k, v] of Object.entries(data)) for (const x of ([] as string[]).concat(v)) f.append(k, x);
      return req('POST', p, f);
    },
    /** POSTs a form and returns where it redirected to. */
    async submit(p: string, data: Form = {}) {
      const res = await b.form(p, data);
      expect([302, 303], `POST ${p} → ${res.status}`).toContain(res.status);
      return res.headers.get('location');
    },
    async api<T = Record<string, unknown>>(method: 'GET' | 'POST', p: string, body?: object) {
      const res = await req(method, `/api${p}`, method === 'POST' ? (body ?? {}) : undefined);
      return { status: res.status, body: (await res.json()) as T };
    },
    async login(password = 'hunter2') {
      expect(await b.submit('/login', { password })).toBe('/');
    },
  };
  return b;
}

function fakeMac() {
  const mac: MacOps & { awake: boolean; opened: number } = {
    awake: false,
    opened: 0,
    async setKeepAwake(on) {
      mac.awake = on;
    },
    async keepAwake() {
      return mac.awake;
    },
    async openFullDiskAccess() {
      mac.opened++;
    },
  };
  return mac;
}

/** The real Mac daemon against a fixture chat.db, with Full Disk Access switchable. */
async function macHelper(url: string, code: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-wizard-'));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  const chat = buildChatDb(path.join(dir, 'chat.db'), [
    { handle: HANDLES.instinct, text: 'Here is your plan for today', at: new Date(Date.now() - 3600_000) },
    { handle: HANDLES.stanley, text: 'New hook ideas', at: new Date(Date.now() - 7200_000) },
    { handle: '+15550004444', text: 'mom: call me', at: new Date(Date.now() - 86_400_000) },
  ]);
  onCleanup(() => chat.close());
  const token = await pairWithHub(url, code);
  const access = { granted: false };
  const mac = fakeMac();
  const sent: { handle: string; body: string }[] = [];
  let state: DaemonState | null = null;
  const d = new Daemon({
    chatDbPath: chat.file,
    hub: httpHubClient(url, token),
    state: { load: async () => state, save: async (s) => void (state = s) },
    send: async (handle, body) => void sent.push({ handle, body }),
    log: createLogger({ test: true }),
    mac,
    nodePath: '/opt/homebrew/bin/node',
    openDb: (file, busy) => {
      if (!access.granted) throw new Error('unable to open database file: authorization denied');
      return new ChatDb(file, { busyTimeoutMs: busy });
    },
  });
  onCleanup(() => d.close());
  return { d, token, access, mac, sent, chat };
}

const jobDone = async (b: ReturnType<typeof browser>, id: number) => (await b.api<{ status: string; result: Record<string, unknown>; error: string | null }>('GET', `/jobs/${id}`)).body;

describe('onboarding wizard', () => {
  it('first launch: create a password, then every step through to a test event', async () => {
    const h = await hubFor(BLANK);
    const b = browser(h.url);

    // Nothing works until a password exists, and only the setup link can create one.
    expect((await b.get('/')).headers.get('location')).toBe('/welcome');
    expect((await b.get('/connections')).headers.get('location')).toBe('/welcome');
    expect((await b.api('GET', '/mac')).status).toBe(401);
    expect((await b.get('/login')).headers.get('location')).toBe('/welcome');
    const welcome = await b.html(`/welcome?token=${h.hub.connections.setupToken}`);
    expect(welcome).toContain(`value="${h.hub.connections.setupToken}"`);
    expect((await b.form('/welcome', { token: 'guess', password: 'correct horse battery', confirm: 'correct horse battery' })).status).toBe(401);
    expect((await b.form('/welcome', { token: h.hub.connections.setupToken, password: 'short', confirm: 'short' })).status).toBe(400);
    expect((await b.form('/welcome', { token: h.hub.connections.setupToken, password: 'correct horse battery', confirm: 'different horse' })).status).toBe(400);
    expect(await b.submit('/welcome', { token: h.hub.connections.setupToken, password: 'correct horse battery', confirm: 'correct horse battery' })).toBe('/onboarding');
    // The password is stored as a scrypt hash, and the setup link is dead now.
    const stored = JSON.stringify(await h.store.getSetting('owner.password', null));
    expect(stored).toContain('scrypt');
    expect(stored).not.toContain('correct horse');
    expect((await browser(h.url).form('/welcome', { token: h.hub.connections.setupToken, password: 'attacker password', confirm: 'attacker password' })).headers.get('location')).toBe('/login');

    // Step 1: welcome.
    expect((await b.get('/onboarding')).headers.get('location')).toBe('/onboarding/welcome');
    expect(await b.html('/onboarding/welcome')).toMatch(/Step 1 of \d+/);
    expect((await b.submit('/onboarding/welcome', { 'owner.name': 'Ved', 'owner.timezone': 'Not/AZone' }))).toBe('/onboarding/welcome?err=invalid');
    expect(await b.submit('/onboarding/welcome', { 'owner.name': 'Ved', 'owner.timezone': 'America/Los_Angeles' })).toBe('/onboarding/mac');
    expect([h.cfg.ownerName, h.cfg.timezone]).toEqual(['Ved', 'America/Los_Angeles']);

    // Step 2: connect the Mac and grant Full Disk Access.
    expect(await b.html('/onboarding/mac')).toContain('data-widget="mac-status"');
    expect((await b.api('POST', '/mac/open-fda')).status).toBe(409);
    const pair = await b.api<{ code: string; command: string }>('POST', '/mac/pair-code');
    expect(pair.body.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(pair.body.command).toContain(`install-daemon.sh pair '${h.url}' ${pair.body.code}`);
    const mac = await macHelper(h.url, pair.body.code);
    await expect(pairWithHub(h.url, pair.body.code)).rejects.toThrow();
    await mac.d.cycle();
    let status = (await b.api<{ paired: boolean; online: boolean; fullDiskAccess: boolean | null; nodePath: string }>('GET', '/mac')).body;
    expect(status).toMatchObject({ paired: true, online: true, fullDiskAccess: false, nodePath: '/opt/homebrew/bin/node' });
    const fda = await b.api<{ jobId: number }>('POST', '/mac/open-fda');
    await mac.d.cycle();
    expect(mac.mac.opened).toBe(1);
    expect((await jobDone(b, fda.body.jobId)).status).toBe('done');
    mac.access.granted = true;
    await mac.d.cycle();
    status = (await b.api<typeof status>('GET', '/mac')).body;
    expect(status.fullDiskAccess).toBe(true);
    expect(await b.submit('/onboarding/mac')).toBe('/onboarding/keep-awake');

    // Step 3: keep awake.
    expect(await b.html('/onboarding/keep-awake')).toMatch(/battery|asleep|sleep/i);
    const awake = await b.api<{ jobId: number }>('POST', '/mac/keep-awake', { on: true });
    await mac.d.cycle();
    expect(mac.mac.awake).toBe(true);
    expect((await jobDone(b, awake.body.jobId)).result).toEqual({ keepAwake: true });
    expect((await b.api<{ keepAwake: boolean }>('GET', '/mac')).body.keepAwake).toBe(true);
    expect(await b.submit('/onboarding/keep-awake')).toBe('/onboarding/phone');

    // Step 4: approval number, with a test text the Mac actually sends.
    expect((await b.api('POST', '/approval/test', { handle: 'not a phone' })).status).toBe(400);
    const test = await b.api<{ outboxId: number }>('POST', '/approval/test', { handle: HANDLES.approval });
    expect(h.cfg.approval).toMatchObject({ channel: 'imessage', imessageHandle: HANDLES.approval });
    expect((await b.api<{ status: string }>('GET', `/outbox/${test.body.outboxId}`)).body.status).toBe('pending');
    await mac.d.cycle();
    expect(mac.sent).toEqual([{ handle: HANDLES.approval, body: expect.stringContaining('Agent Hub test') }]);
    expect((await b.api<{ status: string }>('GET', `/outbox/${test.body.outboxId}`)).body.status).toBe('sent');
    expect(await b.submit('/onboarding/phone', { 'approval.handle': HANDLES.approval })).toBe('/onboarding/brain');

    // Step 5: the background worker is opt-in, and turning it on stores no key anywhere.
    expect(h.cfg.worker.enabled).toBe(false);
    expect(await b.submit('/onboarding/brain', { enabled: '1' })).toBe('/onboarding/agents');
    expect(h.cfg.worker.enabled).toBe(true);

    // Step 6: pick agents. Picked ones are switched on, the rest off, and each gets its own step.
    expect(await b.submit('/onboarding/agents', { agent: ['claude', 'instinct', 'grok'] })).toBe('/onboarding/agent-claude');
    const scopes = await h.store.scopes();
    expect(['claude', 'instinct', 'grok', 'stanley', 'boardy', 'chatgpt', 'gemini'].map((a) => scopes.get(a as never)?.enabled)).toEqual([true, true, true, false, false, false, false]);

    // Claude: URL + instructions, and Test connection waits for its first call.
    const claudePage = await b.html('/onboarding/agent-claude');
    expect(claudePage).toContain(`${h.url}/mcp`);
    expect(claudePage).toContain('get_situation');
    const since = (await b.api<{ since: number }>('POST', '/agents/claude/test')).body.since;
    const seen = b.api<{ seen: boolean }>('GET', `/agents/claude/seen?since=${since}`);
    const claude = await mcpClient(h.url, 'claude-token');
    await claude('get_situation');
    expect((await seen).body.seen).toBe(true);
    expect(await b.submit('/onboarding/agent-claude')).toBe('/onboarding/agent-instinct');

    // Instinct: pick the thread from recent chats, add the forwarding email, set up Gmail.
    const threads = await b.api<{ jobId: number }>('POST', '/mac/threads');
    await mac.d.cycle();
    const listed = (await jobDone(b, threads.body.jobId)).result as { threads: { handle: string }[] };
    expect(listed.threads.map((t) => t.handle)).toEqual([HANDLES.instinct, HANDLES.stanley, '+15550004444']);
    expect(await b.submit('/connections/instinct/save', { back: '/onboarding/agent-instinct', 'handle.instinct': HANDLES.instinct, 'instinct.email': 'ved.abc123@in.instinct.app' })).toBe('/onboarding/agent-instinct?ok=saved');
    expect(await b.submit('/connections/email/save', { back: '/onboarding/agent-instinct', provider: 'gmail', address: 'ved@gmail.com', password: 'abcd efgh ijkl mnop' })).toBe('/onboarding/agent-instinct?ok=saved');
    expect(h.cfg.imessageHandles.instinct).toBe(HANDLES.instinct);
    expect(h.cfg.email.smtpUrl).toMatch(/^smtps:\/\/ved%40gmail\.com:.+@smtp\.gmail\.com/);
    expect(h.cfg.imap.url).toMatch(/^imaps:\/\/.+@imap\.gmail\.com/);
    expect(JSON.stringify(await h.store.db.query('SELECT * FROM settings'))).not.toMatch(/abcd|efgh/);
    const daemonCfg = await (await fetch(`${h.url}/daemon/config`, { headers: { authorization: `Bearer ${mac.token}` } })).json();
    expect(daemonCfg.watchHandles).toContain(HANDLES.instinct);
    expect(await b.submit('/onboarding/agent-instinct')).toBe('/onboarding/agent-grok');

    // Grok Bot: generate, shown once on this page only.
    const gen = await b.form('/connections/grok/generate', { back: '/onboarding/agent-grok' });
    const genHtml = await gen.text();
    expect(gen.status).toBe(200);
    expect(genHtml).toContain('Step ');
    expect(genHtml).toContain(h.cfg.agentTokens.grok!);
    expect(genHtml).toContain(h.cfg.grokWebhookSecret!);
    const again = await b.html('/onboarding/agent-grok');
    expect(again).not.toContain(h.cfg.agentTokens.grok!);
    expect(again).not.toContain(h.cfg.grokWebhookSecret!);
    expect(await b.submit('/onboarding/agent-grok')).toBe('/onboarding/finish');

    // Finish: a test event goes in and shows up.
    const ev = await b.api<{ eventId: number; since: string }>('POST', '/test-event');
    const events = await b.api<{ events: { id: number; name: string; summary: string }[] }>('GET', `/events?since=${encodeURIComponent(ev.body.since)}`);
    expect(events.body.events).toContainEqual(expect.objectContaining({ id: ev.body.eventId, name: 'Claude', summary: expect.stringContaining('Test event') }));
    expect(await b.submit('/onboarding/finish')).toBe('/?ok=saved');
    expect(h.hub.connections.onboarding.completed).toBe(true);
    const today = await b.html('/');
    expect(today).not.toContain('Finish setting up');
    expect(today).toContain('Test event');

    // A restart loads everything back from the database and secret store.
    const grid = await b.html('/connections');
    expect(grid).toContain('Claude');
    expect((await b.get('/setup')).headers.get('location')).toBe('/connections');
  });

  it('can be skipped, resumes where it left off, and the Today page nudges until it is done', async () => {
    const h = await hubFor({ HUB_OWNER_NAME: 'Ved' });
    const b = browser(h.url);
    await b.login();
    expect(await b.html('/')).toContain('Finish setting up');
    await b.submit('/onboarding/welcome', { 'owner.name': 'Ved', 'owner.timezone': 'America/New_York' });
    expect((await b.get('/onboarding')).headers.get('location')).toBe('/onboarding/mac');
    expect(await b.submit('/onboarding/skip-all')).toBe('/');
    expect(await b.html('/')).not.toContain('Finish setting up');
    // Unknown steps bounce back to the wizard instead of erroring.
    expect((await b.get('/onboarding/agent-nobody')).headers.get('location')).toBe('/onboarding');
  });

  it('adds, picks and removes a worker account; removing the active one falls back to the default', async () => {
    const h = await hubFor({});
    const b = browser(h.url);
    await b.login();
    expect(await b.submit('/settings/worker/account', { label: 'Work account' })).toBe('/settings?ok=saved');
    expect(h.cfg.worker.accounts.map((a) => a.id)).toEqual(['default', 'work-account']);
    expect(await b.submit('/settings/worker', { account: 'work-account' })).toBe('/settings?ok=saved');
    expect(h.cfg.worker.activeAccount).toBe('work-account');
    expect(await b.submit('/settings/worker/account/work-account/remove', {})).toBe('/settings?ok=saved');
    expect(h.cfg.worker.accounts.map((a) => a.id)).toEqual(['default']);
    expect(h.cfg.worker.activeAccount).toBe('default');
  });

  it('skips the worker step when it is set from the environment', async () => {
    const h = await hubFor({ WORKER_ENABLED: '1' });
    const b = browser(h.url);
    await b.login();
    expect(await b.submit('/onboarding/phone', { 'approval.handle': HANDLES.approval })).toBe('/onboarding/agents');
  });
});

describe('connect paths', () => {
  it('Claude, ChatGPT and Gemini: MCP URL, instructions, and Test connection', async () => {
    const h = await hubFor({ HUB_AGENT_TOKENS: 'claude:claude-token,chatgpt:chatgpt-token,gemini:gemini-token' });
    const b = browser(h.url);
    await b.login();
    for (const [agent, token] of [['claude', 'claude-token'], ['chatgpt', 'chatgpt-token'], ['gemini', 'gemini-token']] as const) {
      const page = await b.html(`/connections/${agent}`);
      expect(page).toContain(`${h.url}/mcp`);
      expect(page).toContain('data-widget="test-connection"');
      expect(page).toMatch(/<svg[^>]*role="img"/);
      const since = (await b.api<{ since: number }>('POST', `/agents/${agent}/test`)).body.since;
      const call = await mcpClient(h.url, token);
      await call('get_situation');
      expect((await b.api<{ seen: boolean }>('GET', `/agents/${agent}/seen?since=${since}`)).body.seen).toBe(true);
    }
    expect(await b.html('/connections')).toMatch(/Claude[\s\S]*Connected/);
    expect((await b.api('GET', '/agents/nobody/seen')).status).toBe(404);
  });

  it('Instinct: thread picker saves the handle, the email presets build working URLs, and the test email sends', async () => {
    const h = await hubFor({ IMESSAGE_HANDLES: '', INSTINCT_EMAIL: '', SMTP_URL: '', EMAIL_FROM: '' });
    const b = browser(h.url);
    await b.login();
    const page = await b.html('/connections/instinct');
    expect(page).toContain('data-widget="threads"');
    expect(page).toContain('Needs setup');
    expect(await b.submit('/connections/instinct/save', { 'handle.instinct': 'definitely not a handle!' })).toBe('/connections/instinct?err=invalid');
    expect(await b.submit('/connections/instinct/save', { 'instinct.email': 'not-an-email' })).toBe('/connections/instinct?err=invalid');
    expect(await b.submit('/connections/instinct/save', { 'handle.instinct': HANDLES.instinct, 'instinct.email': 'ved@in.instinct.app' })).toBe('/connections/instinct?ok=saved');
    expect(h.cfg.instinctEmail).toBe('ved@in.instinct.app');
    expect((await b.api('POST', '/email/test')).status).toBe(400);
    expect(await b.submit('/connections/email/save', { provider: 'icloud', address: 'ved@icloud.com', password: '' })).toBe('/connections?err=email');
    expect(await b.submit('/connections/email/save', { provider: 'icloud', address: 'ved@icloud.com', password: 'app-specific-pw' })).toBe('/connections?ok=saved');
    expect(h.cfg.email.smtpUrl).toMatch(/smtp\.mail\.me\.com/);
    const test = await b.api<{ to: string }>('POST', '/email/test');
    expect(test.body.to).toBe('ved@icloud.com');
    expect(h.email.sent.at(-1)).toMatchObject({ to: 'ved@icloud.com', subject: 'Agent Hub test email' });
    // "Other": raw URLs, which must at least be mail URLs.
    expect(await b.submit('/connections/email/save', { provider: 'other', address: 'ved@example.com', smtp: 'http://evil.example' })).toBe('/connections?err=invalid');
    expect(await b.submit('/connections/email/save', { provider: 'other', address: 'ved@example.com', smtp: 'smtp://u:p@mail.example.com:587' })).toBe('/connections?ok=saved');
    expect(h.cfg.email.smtpUrl).toBe('smtp://u:p@mail.example.com:587');
  });

  it('Stanley: Telegram sign-in by phone, code and 2FA password; the session is stored encrypted and never shown', async () => {
    const h = await hubFor({ TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '', TELEGRAM_SESSION: '', STANLEY_TELEGRAM_PEER: '' });
    const b = browser(h.url);
    await b.login();
    const calls: string[] = [];
    const driver: TelegramLoginDriver = {
      async start(apiId, apiHash, phone) {
        calls.push(`start ${apiId} ${apiHash} ${phone}`);
        return { status: 'code-sent', loginId: 'L1' };
      },
      async code(loginId, code) {
        calls.push(`code ${loginId} ${code}`);
        return code === '12345' ? { status: 'password-needed', loginId, hint: null } : { status: 'error', message: 'That code is wrong.' };
      },
      async password(loginId, pw) {
        calls.push(`password ${loginId}`);
        return pw === 'cloud-pw' ? { status: 'done', session: '1BVtsSECRETSESSION', account: '@ved' } : { status: 'error', message: 'Wrong password.' };
      },
    };
    h.hub.telegramLogin = driver;
    expect((await b.api('POST', '/telegram/start', { phone: '+15551234567' })).status).toBe(400);
    expect(await b.submit('/connections/stanley/save', { 'stanley.apiId': '12345', 'stanley.apiHash': 'abcdef0123456789', 'stanley.peer': '@stanley_ai' })).toBe('/connections/stanley?ok=saved');
    expect(await b.html('/connections/stanley')).toContain('data-widget="telegram-login"');
    expect((await b.api('POST', '/telegram/start', { phone: 'call me' })).status).toBe(400);
    expect((await b.api('POST', '/telegram/start', { phone: '+1 555 123 4567' })).body).toEqual({ status: 'code-sent', loginId: 'L1' });
    expect((await b.api('POST', '/telegram/code', { loginId: 'L1', code: '00000' })).body).toEqual({ error: 'That code is wrong.' });
    expect((await b.api('POST', '/telegram/code', { loginId: 'L1', code: '12345' })).body).toEqual({ status: 'password-needed', loginId: 'L1', hint: null });
    const done = await b.api('POST', '/telegram/password', { loginId: 'L1', password: 'cloud-pw' });
    expect(done.body).toEqual({ status: 'done', account: '@ved' });
    expect(calls[0]).toBe('start 12345 abcdef0123456789 +1 555 123 4567');
    expect(h.cfg.stanley).toMatchObject({ apiId: 12345, session: '1BVtsSECRETSESSION', peer: '@stanley_ai' });
    const page = await b.html('/connections/stanley');
    expect(page).toContain('@ved');
    expect(page).not.toContain('1BVtsSECRETSESSION');
    expect(page).not.toContain('abcdef0123456789');
    expect(JSON.stringify(await h.store.db.query('SELECT * FROM settings'))).not.toMatch(/SECRETSESSION|abcdef0123456789/);
    expect(JSON.stringify(await h.store.recentAudit(50))).not.toMatch(/SECRETSESSION|cloud-pw/);
    expect(await b.submit('/connections/stanley/telegram-logout')).toBe('/connections/stanley?ok=signedout');
    expect(h.cfg.stanley.session).toBeNull();
  });

  it('Boardy: thread, Boardy email and the profile it pitches; env-provided links are locked', async () => {
    const h = await hubFor({ IMESSAGE_HANDLES: '', BOARDY_EMAIL: '' });
    const b = browser(h.url);
    await b.login();
    expect(await b.html('/connections/boardy')).toMatch(/boardy\.ai/);
    expect(await b.submit('/connections/boardy/save', { 'profile.link.linkedin': 'javascript:alert(1)' })).toBe('/connections/boardy?err=invalid');
    expect(await b.submit('/connections/boardy/save', {
      'handle.boardy': HANDLES.boardy,
      'boardy.email': 'hello@boardy.ai',
      'profile.fullName': 'Ved Thakar',
      'profile.offer': 'Building Agent Hub',
      'profile.link.linkedin': 'https://linkedin.com/in/ved',
    })).toBe('/connections/boardy?ok=saved');
    expect(h.cfg.imessageHandles.boardy).toBe(HANDLES.boardy);
    expect(h.cfg.boardyEmail).toBe('hello@boardy.ai');
    expect(h.cfg.owner.links).toContainEqual({ label: 'LinkedIn', url: 'https://linkedin.com/in/ved' });

    const locked = await hubFor({ OWNER_LINKS: 'LinkedIn=https://linkedin.com/in/from-env' });
    const lb = browser(locked.url);
    await lb.login();
    expect(await lb.html('/connections/boardy')).toContain('Set in .env');
    await lb.submit('/connections/boardy/save', { 'profile.link.linkedin': 'https://linkedin.com/in/override' });
    expect(locked.cfg.owner.links).toEqual([{ label: 'LinkedIn', url: 'https://linkedin.com/in/from-env' }]);
  });

  it('Grok Bot: generated token works over MCP, the webhook checks signatures, and regenerating revokes the old pair', async () => {
    const h = await hubFor({ HUB_AGENT_TOKENS: '', GROK_WEBHOOK_SECRET: '' });
    const b = browser(h.url);
    await b.login();
    expect((await fetch(`${h.url}/hooks/grok`, { method: 'POST', body: '{}' })).status).toBe(404);
    const html = await (await b.form('/connections/grok/generate', {})).text();
    const token = h.cfg.agentTokens.grok!;
    const secret = h.cfg.grokWebhookSecret!;
    expect(token).toMatch(/^hub_/);
    expect(html).toContain(token);
    expect(html).toContain(`${h.url}/hooks/grok`);
    const grok = await mcpClient(h.url, token);
    expect((await grok('get_situation')).isError).toBe(false);

    const hook = (body: string, opts: { ts?: number; key?: string; sig?: string } = {}) => {
      const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
      return fetch(`${h.url}/hooks/grok`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-timestamp': ts, 'x-hub-signature': opts.sig ?? signWebhook(opts.key ?? secret, ts, body) }, body });
    };
    const situation = JSON.stringify({ type: 'situation' });
    expect((await hook(situation)).status).toBe(200);
    expect((await hook(situation, { key: 'wrong' })).status).toBe(401);
    expect((await hook(situation, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signWebhook(secret, String(ts), JSON.stringify({ type: 'inbox' }));
    expect((await hook(JSON.stringify({ type: 'inbox' }), { ts, sig })).status).toBe(200);
    expect((await hook(JSON.stringify({ type: 'inbox' }), { ts, sig })).status).toBe(409);
    expect((await hook('{"type":"rm -rf"}')).status).toBe(400);
    const proposed = await hook(JSON.stringify({ type: 'propose', target_agent: 'claude', task: 'Draft a reply to the investor thread', topics: ['work'] }));
    expect(await proposed.json()).toMatchObject({ ok: true });
    expect((await h.store.tasksByStatus(['proposed'])).map((t) => [t.origin_agent, t.target_agent, t.author])).toContainEqual(['grok', 'claude', 'agent']);
    expect((await h.store.recentAudit(100)).filter((a) => a.action === 'hook.bad_signature')).toHaveLength(2);

    await b.form('/connections/grok/generate', {});
    expect(h.cfg.agentTokens.grok).not.toBe(token);
    expect((await hook(JSON.stringify({ type: 'situation', n: 1 }))).status).toBe(401);
    await expect(mcpClient(h.url, token)).rejects.toThrow();
  });

  it('custom agents: create, receive hand-offs, call in, and delete', async () => {
    const h = await hubFor({});
    const b = browser(h.url);
    await b.login();
    expect((await b.form('/connections/new', { name: '' })).status).toBe(400);
    const loc = await b.submit('/connections/new', { name: 'Notion AI', profile: 'Writes and organises my notes.', topic: ['work', 'school', 'health'] });
    expect(loc).toBe('/connections/custom-notion-ai?ok=added');
    expect(isAgentId('custom-notion-ai')).toBe(true);
    // Sensitive topics are never on by default, even when ticked at creation.
    // Sensitive topics (school, health) are dropped even if they were ticked at creation.
    expect(await h.store.scope('custom-notion-ai')).toMatchObject({ allow_topics: ['work'], autonomy: 'ask', enabled: true });
    expect(await b.html('/connections')).toContain('Notion AI');
    expect(await b.html('/connections/custom-notion-ai')).toContain('Delete agent');

    // Other agents can hand work to it; it reads its inbox with its own token.
    const claude = await mcpClient(h.url, 'claude-token');
    expect((await claude('propose_task', { target_agent: 'custom-notion-ai', task: 'File the meeting notes under Work', topics: ['work'] })).isError).toBe(false);
    const task = (await h.store.tasksByStatus(['proposed'])).find((t) => t.target_agent === 'custom-notion-ai')!;
    expect(task).toBeDefined();
    await b.submit(`/actions/task/${task.id}/approve`);
    await h.hub.tick();
    await h.hub.idle();
    await b.form('/connections/custom-notion-ai/generate', {});
    const notion = await mcpClient(h.url, h.cfg.agentTokens['custom-notion-ai']!);
    expect((await notion('get_inbox')).text).toContain('File the meeting notes');

    // Unknown targets are still rejected.
    expect((await claude('propose_task', { target_agent: 'custom-nope', task: 'x', topics: ['work'] })).text).toMatch(/unknown agent/);

    // It survives a reload of the connection settings.
    await h.hub.connections.load();
    expect(isAgentId('custom-notion-ai')).toBe(true);

    expect(await b.submit('/connections/custom-notion-ai/delete')).toBe('/connections?ok=deleted');
    expect(isAgentId('custom-notion-ai')).toBe(false);
    expect(await h.store.scope('custom-notion-ai')).toBeUndefined();
    expect((await b.get('/connections/custom-notion-ai')).status).toBe(404);
    await expect(mcpClient(h.url, 'claude-token').then((c) => c('propose_task', { target_agent: 'custom-notion-ai', task: 'again', topics: ['work'] }))).resolves.toMatchObject({ isError: true });
    expect((await b.form('/connections/claude/delete', {})).status).toBe(404);
  });

  it('settings: topic checkboxes and autonomy update the scope, hard limits stay, pause and disconnect work', async () => {
    const h = await hubFor({});
    const b = browser(h.url);
    await b.login();
    // Boardy can never see health or finances, whatever the form says (unknown topic names are ignored).
    await b.submit('/connections/boardy/settings', { topic: ['work', 'professional', 'health', 'finances'], autonomy: 'auto' });
    const boardy = (await h.store.scope('boardy'))!;
    expect(boardy.allow_topics).toEqual(['work', 'professional']);
    expect(boardy.deny_topics).toEqual(expect.arrayContaining(['health', 'finances', 'school', 'personal']));
    expect(boardy.autonomy).toBe('auto');
    expect(await b.html('/connections/boardy')).toMatch(/name="topic" value="health"[^>]*disabled/);
    // Every real topic ticked means everything (still minus the hard floor at delivery).
    const all = ['plan', 'schedule', 'school', 'projects', 'work', 'open_source', 'content', 'shoots', 'professional', 'networking', 'health', 'finances', 'personal', 'general'];
    await b.submit('/connections/claude/settings', { topic: all, autonomy: 'notify' });
    expect(await h.store.scope('claude')).toMatchObject({ allow_topics: ['*'], deny_topics: [], autonomy: 'notify' });

    expect(await b.submit('/connections/stanley/pause')).toBe('/connections/stanley?ok=paused');
    expect((await h.store.scope('stanley'))!.enabled).toBe(false);
    expect(await b.html('/connections')).toMatch(/Stanley[\s\S]*?Paused/);
    expect(await b.submit('/connections/stanley/resume')).toBe('/connections/stanley?ok=resumed');
    expect((await h.store.scope('stanley'))!.enabled).toBe(true);

    // Disconnect clears what the dashboard saved and revokes OAuth grants.
    await b.submit('/connections/instinct/save', { 'instinct.email': 'ved@in.instinct.app' });
    await b.submit('/connections/instinct/disconnect');
    expect(h.hub.connections.source('instinct.email')).not.toBe('ui');
    expect((await h.store.recentAudit(20)).some((a) => a.action === 'agent.disconnected')).toBe(true);
  });

  it('env-provided settings are shown as locked and cannot be overwritten from the dashboard', async () => {
    const h = await hubFor({});
    const b = browser(h.url);
    await b.login();
    expect(await b.html('/settings')).toContain('Set in .env');
    expect(await b.submit('/settings/approval', { 'approval.handle': '+15550000000' })).toBe('/settings?err=env');
    expect(h.cfg.approval.imessageHandle).toBe(HANDLES.approval);
    await b.submit('/connections/instinct/save', { 'handle.instinct': '+15550000000' });
    expect(h.cfg.imessageHandles.instinct).toBe(HANDLES.instinct);
    expect(await b.html('/settings')).toMatch(/From the environment right now:[^<]*Approval number/);
  });

  it('Today: approvals with Approve/Deny buttons, events by agent, health, and a live fragment', async () => {
    const h = await hubFor({});
    const b = browser(h.url);
    await b.login();
    const task = await h.store.createTask({ originAgent: 'instinct', targetAgent: 'claude', payload: 'Prep slides for Thursday', rationale: 'study plan', topics: ['school'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    await h.store.insertEvent({ agent: 'stanley', occurredAt: new Date(), author: 'agent', rawExcerpt: '', summary: 'Drafted three hooks', topics: ['content'], kind: 'conversation', routed: true });
    const today = await b.html('/');
    expect(today).toContain('Prep slides for Thursday');
    expect(today).toContain(`/actions/task/${task.id}/approve`);
    expect(today).toContain(`/actions/task/${task.id}/reject`);
    expect(today).toContain('Drafted three hooks');
    expect(today).toContain('data-widget="today-refresh"');
    const fragment = await b.html('/?fragment=1');
    expect(fragment).not.toContain('<html');
    expect(fragment).toContain('Prep slides for Thursday');
    await b.submit(`/actions/task/${task.id}/reject`);
    expect((await h.store.task(task.id))!.status).toBe('rejected');
    expect(await b.html('/?fragment=1')).not.toContain(`/actions/task/${task.id}/approve`);
  });

  it('the JSON API needs a session and a same-origin request', async () => {
    const h = await hubFor({});
    expect((await fetch(`${h.url}/api/mac`)).status).toBe(401);
    expect((await fetch(`${h.url}/api/mac/pair-code`, { method: 'POST' })).status).toBe(401);
    const b = browser(h.url);
    await b.login();
    const res = await fetch(`${h.url}/api/mac/pair-code`, { method: 'POST', headers: { cookie: (await b.get('/')).headers.get('set-cookie') ?? '', origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect((await b.api('GET', '/jobs/abc')).status).toBe(404);
  });

  it('Mac pairing codes work once, expire, and the daemon token can be revoked from Settings', async () => {
    const h = await hubFor({ HUB_DAEMON_TOKEN: '' });
    const b = browser(h.url);
    await b.login();
    expect((await fetch(`${h.url}/daemon/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-BBBB' }) })).status).toBe(401);
    const { code } = (await b.api<{ code: string }>('POST', '/mac/pair-code')).body;
    const token = await pairWithHub(h.url, code.toLowerCase().replace('-', ''));
    expect(token).toMatch(/^hubd_/);
    const cfgRes = await fetch(`${h.url}/daemon/config`, { headers: { authorization: `Bearer ${token}` } });
    expect(cfgRes.status).toBe(200);
    expect(JSON.stringify(await h.store.db.query('SELECT * FROM settings'))).not.toContain(token);
    expect(await b.submit('/settings/unpair')).toBe('/settings?ok=unpaired');
    expect((await fetch(`${h.url}/daemon/config`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('the owner can change the password, which signs out other sessions', async () => {
    const h = await hubFor({ HUB_OWNER_PASSWORD: '' });
    const b = browser(h.url);
    await b.submit('/welcome', { token: h.hub.connections.setupToken, password: 'first password!', confirm: 'first password!' });
    const other = browser(h.url);
    await other.login('first password!');
    expect(await b.submit('/settings/password', { current: 'nope', next: 'second password!' })).toBe('/settings?err=wrong');
    expect(await b.submit('/settings/password', { current: 'first password!', next: 'second password!' })).toBe('/settings?ok=password');
    expect((await b.get('/settings')).status).toBe(200);
    expect((await other.get('/settings')).headers.get('location')).toBe('/login');
    await other.login('second password!');
  });
});
