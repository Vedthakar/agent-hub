import { createHmac, randomBytes } from 'node:crypto';
import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AGENT_IDS, TOPICS, agentIds, isAgentId, isBuiltinAgent, type AgentId, type Autonomy, type CustomAgentId } from '../shared/types.js';
import { ADAPTERS } from './adapters/index.js';
import { EnvLockedError } from './connections.js';
import { safeEqual } from './crypto.js';
import { queueDigestNow } from './debrief.js';
import type { Hub } from './hub.js';
import { HARD_DENY, SENSITIVE } from './scopes.js';
import { formatLocal } from './tz.js';
import { connectionDetail, connectionsGrid, newCustomAgent } from './ui/connectionsPage.js';
import { field, h, hidden, page, pill } from './ui/layout.js';
import { renderStep, stepAgent, wizardSteps, type Step } from './ui/onboarding.js';
import { EMAIL_PROVIDERS, editableKeys, mailUrl, type EmailProvider } from './ui/panels.js';
import { settingsBody } from './ui/settings.js';
import { macStatus } from './ui/status.js';
import { todayBody, todayFragment } from './ui/today.js';

export { standingInstructions } from './ui/panels.js';

const COOKIE = 'hub_session';
const SESSION_TTL_MS = 30 * 24 * 3600_000;

function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const OK_MESSAGES: Record<string, string> = {
  saved: 'Saved.',
  generated: 'New credentials generated.',
  paused: 'Paused.',
  resumed: 'Resumed.',
  disconnected: 'Disconnected.',
  password: 'Password changed. Other devices are signed out.',
  unpaired: 'Mac unpaired.',
  added: 'Agent added. Now connect it.',
  deleted: 'Agent deleted.',
  signedout: 'Signed out of Telegram.',
};
const ERR_MESSAGES: Record<string, string> = {
  env: 'That setting comes from the server’s environment (.env), so it can’t be changed here.',
  invalid: 'That doesn’t look right. Check it and try again.',
  secrets: 'This hub has no secret store, so it can’t save passwords or keys. See the README.',
  wrong: 'Wrong password.',
  weak: 'Use at least 10 characters.',
  email: 'Enter your email address and an app password.',
};

const PHONE_OR_EMAIL = /^(\+?[\d][\d\s().-]{5,24}|[^@\s]{1,64}@[^@\s]{1,190})$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;
const HTTP_URL = /^https?:\/\/[^\s]{3,500}$/;

/** Shape checks for values typed into the dashboard. Secrets are checked by the service that uses them. */
function validValue(key: string, v: string): boolean {
  if (/^handle\./.test(key) || key === 'approval.handle') return PHONE_OR_EMAIL.test(v);
  if (key === 'instinct.email' || key === 'boardy.email' || key === 'email.from') return EMAIL.test(v);
  if (/^profile\.link\./.test(key) || /\.url$/.test(key) || key === 'grok.webhookUrl') return HTTP_URL.test(v);
  if (key === 'stanley.apiId') return /^\d{3,12}$/.test(v);
  if (key === 'stanley.peer') return /^@?[A-Za-z0-9_]{4,64}$/.test(v);
  if (key === 'owner.timezone') {
    try {
      return Intl.DateTimeFormat('en-US', { timeZone: v }).resolvedOptions().timeZone === v;
    } catch {
      return false;
    }
  }
  return v.length <= 2000;
}

export function dashboardRouter(hub: Hub): Router {
  const { store, cfg } = hub;
  const conn = hub.connections;
  const r = express.Router();
  // Defence in depth on top of SameSite=Strict: state-changing requests must come from the dashboard's own origin.
  const origin = new URL(cfg.publicUrl).origin;
  r.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const from = req.get('origin') ?? (req.get('referer') ? new URL(req.get('referer')!).origin : null);
    if (req.get('sec-fetch-site') === 'cross-site' || (from !== null && from !== origin)) {
      void store.audit('hub', 'dashboard.cross_origin_blocked', { path: req.path, origin: from });
      res.status(403).send('Cross-origin request blocked');
      return;
    }
    next();
  });
  r.use(express.urlencoded({ extended: false, limit: '64kb' }));
  r.use('/api', express.json({ limit: '64kb' }));
  // Row ids in action URLs must be positive integers; anything else is a 404, never a query.
  r.param('id', (_req, res, next, id: string) => {
    if (/^[1-9]\d{0,15}$/.test(id)) return next();
    res.status(404).end();
  });
  r.param('agent', (_req, res, next, agent: string) => {
    if (isAgentId(agent)) return next();
    res.status(404).type('html').send(page('Not found', '<h1>No such agent</h1><p><a href="/connections">Back to Connections</a></p>', { nav: 'connections' }));
  });

  const authed = (req: Request) => {
    const raw = readCookie(req, COOKIE);
    if (!raw || !conn.hasOwnerPassword()) return false;
    const [exp, sig] = raw.split('.');
    return Number(exp) > Date.now() && safeEqual(sig ?? '', sign(cfg.sessionSecret, exp));
  };
  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (authed(req)) return next();
    res.redirect(302, conn.hasOwnerPassword() ? '/login' : '/welcome');
  };
  const apiOwner = (req: Request, res: Response, next: NextFunction) => {
    if (authed(req)) return next();
    res.status(401).json({ error: 'Your session expired. Sign in again.' });
  };
  const issueSession = (res: Response) => {
    const exp = String(Date.now() + SESSION_TTL_MS);
    const secure = cfg.publicUrl.startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(cfg.sessionSecret, exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  };
  const t = (d: Date | string | null) => (d ? formatLocal(new Date(d), cfg.timezone) : '—');
  const name = (a: string) => (isAgentId(a) ? ADAPTERS[a].name : a);
  const flashOf = (req: Request) => {
    const ok = typeof req.query.ok === 'string' ? OK_MESSAGES[req.query.ok] : undefined;
    const err = typeof req.query.err === 'string' ? ERR_MESSAGES[req.query.err] : undefined;
    return err ? { flash: err, flashKind: 'err' as const } : ok ? { flash: ok, flashKind: 'ok' as const } : {};
  };
  const backTo = (req: Request, fallback: string) => {
    const b = String(req.body?.back ?? '');
    return /^\/[A-Za-z0-9/_-]{0,120}$/.test(b) ? b : fallback;
  };
  const go = (res: Response, path: string, q?: { ok?: string; err?: string }) => {
    const qs = q?.err ? `?err=${q.err}` : q?.ok ? `?ok=${q.ok}` : '';
    res.redirect(303, `${path}${qs}`);
  };
  /** Saves a patch, mapping the expected failures to a flash message instead of a 500. */
  const save = async (patch: Record<string, string | null>): Promise<'ok' | 'env' | 'invalid' | 'secrets'> => {
    for (const [k, v] of Object.entries(patch)) if (v !== null && v !== '' && !validValue(k, v.trim())) return 'invalid';
    try {
      await conn.setMany(patch);
      return 'ok';
    } catch (err) {
      if (err instanceof EnvLockedError) return 'env';
      if (/secret store/.test(String(err))) return 'secrets';
      throw err;
    }
  };
  const send = (res: Response, title: string, body: string, opts: Parameters<typeof page>[2] = {}) => res.type('html').send(page(title, body, opts));

  const loginLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: cfg.rateLimit.loginPer15Min,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode < 400,
    handler: (_req, res) => {
      res.status(429).type('html').send(page('Sign in', '<div class="card"><p class="flash err">Too many attempts. Try again in 15 minutes.</p></div>', { bare: true }));
    },
  });

  // ---------- first run + sign in ----------

  const welcomePage = (token: string, error?: string) =>
    page('Set up', `<div class="card stack" style="margin-top:6vh"><h1>Welcome to Agent Hub</h1>
      <p class="muted">First, create the password you’ll use to open this dashboard and approve agent connections.</p>
      ${error ? `<p class="flash err">${h(error)}</p>` : ''}
      <form method="post" action="/welcome">
        ${token ? hidden('token', token) : field('token', 'Setup code', { help: 'It’s in the link the hub printed when it started (…/welcome?token=…).' })}
        ${field('password', 'Create a password', { type: 'password', autocomplete: 'new-password', required: true, help: 'At least 10 characters.' })}
        ${field('confirm', 'Type it again', { type: 'password', autocomplete: 'new-password', required: true })}
        <button class="btn big block">Create password</button></form></div>`, { bare: true });

  r.get('/welcome', (req, res) => {
    if (conn.hasOwnerPassword()) return res.redirect(302, authed(req) ? '/' : '/login');
    res.type('html').send(welcomePage(typeof req.query.token === 'string' ? req.query.token.slice(0, 100) : ''));
  });
  r.post('/welcome', loginLimit, async (req, res) => {
    const token = String(req.body.token ?? '');
    const password = String(req.body.password ?? '');
    if (password !== String(req.body.confirm ?? '')) {
      res.status(400).type('html').send(welcomePage(token, 'The two passwords don’t match.'));
      return;
    }
    const result = await conn.createOwnerPassword(password, token);
    if (result === 'exists') return res.redirect(303, '/login');
    if (result === 'bad-token') {
      await store.audit('hub', 'owner.setup_bad_token', {});
      res.status(401).type('html').send(welcomePage('', 'That setup code isn’t right. Copy the link from the hub’s log again (it changes every restart).'));
      return;
    }
    if (result === 'weak') {
      res.status(400).type('html').send(welcomePage(token, 'Use at least 10 characters.'));
      return;
    }
    issueSession(res);
    res.redirect(303, '/onboarding');
  });

  r.get('/login', (_req, res) => {
    if (!conn.hasOwnerPassword()) return res.redirect(302, '/welcome');
    send(res, 'Sign in', `<form method="post" action="/login" class="card stack" style="margin-top:10vh"><h1>Sign in</h1>
      ${field('password', 'Password', { type: 'password', autocomplete: 'current-password', required: true })}
      <button class="btn big block">Sign in</button></form>`, { bare: true });
  });
  r.post('/login', loginLimit, async (req, res) => {
    if (!conn.hasOwnerPassword() || !(await conn.verifyOwnerPassword(String(req.body.password ?? '')))) {
      res.status(401).type('html').send(page('Sign in', '<div class="card stack" style="margin-top:10vh"><p class="flash err">Wrong password.</p><a class="btn secondary" href="/login">Try again</a></div>', { bare: true }));
      return;
    }
    issueSession(res);
    res.redirect(302, '/');
  });
  r.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
    res.redirect(302, '/login');
  });

  // ---------- Today ----------

  r.get('/', requireOwner, async (req, res) => {
    if (req.query.fragment === '1') {
      res.type('html').send(await todayFragment(hub));
      return;
    }
    send(res, 'Today', await todayBody(hub), { nav: 'today', ...flashOf(req) });
  });

  // ---------- onboarding ----------

  r.get('/onboarding', requireOwner, (_req, res) => {
    const steps = wizardSteps(hub);
    const at = conn.onboarding.step && steps.includes(conn.onboarding.step as Step) ? conn.onboarding.step : steps[0];
    res.redirect(302, `/onboarding/${at}`);
  });
  r.post('/onboarding/skip-all', requireOwner, async (_req, res) => {
    await conn.setOnboarding({ completed: true });
    res.redirect(303, '/');
  });
  r.get('/onboarding/:step', requireOwner, (req, res) => {
    const step = req.params.step as Step;
    const view = renderStep(hub, step);
    if (!view) return res.redirect(302, '/onboarding');
    send(res, view.title, view.html, { bare: true, ...flashOf(req) });
  });
  r.post('/onboarding/:step', requireOwner, async (req, res) => {
    const step = req.params.step as Step;
    const here = `/onboarding/${step}`;
    const b = req.body as Record<string, string | string[]>;
    const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
    const unlocked = (k: string) => conn.source(k) !== 'env';
    let result: Awaited<ReturnType<typeof save>> = 'ok';
    if (step === 'welcome') {
      const patch: Record<string, string | null> = {};
      if (unlocked('owner.name') && str('owner.name').trim()) patch['owner.name'] = str('owner.name');
      if (unlocked('owner.timezone') && str('owner.timezone')) patch['owner.timezone'] = str('owner.timezone');
      result = await save(patch);
    } else if (step === 'phone') {
      if (unlocked('approval.handle') && str('approval.handle').trim()) result = await save({ 'approval.handle': str('approval.handle') });
    } else if (step === 'brain') {
      const patch: Record<string, string | null> = {};
      if (['anthropic', 'openai'].includes(str('router.provider'))) patch['router.provider'] = str('router.provider');
      if (str('router.key').trim()) patch['router.key'] = str('router.key');
      if (Object.keys(patch).length) result = await save(patch);
    } else if (step === 'agents') {
      const picked = ([] as string[]).concat(b.agent ?? []).filter((a): a is (typeof AGENT_IDS)[number] => isBuiltinAgent(a));
      await conn.setOnboarding({ agents: AGENT_IDS.filter((a) => picked.includes(a)) });
      const scopes = await store.scopes();
      for (const a of AGENT_IDS) {
        const on = picked.includes(a);
        if ((scopes.get(a)?.enabled ?? false) !== on) await store.setAgentEnabled(a, on, 'owner');
      }
    } else if (step === 'finish') {
      await conn.setOnboarding({ completed: true, step: undefined });
      return res.redirect(303, '/?ok=saved');
    } else if (!['mac', 'keep-awake'].includes(step) && !stepAgent(step)) {
      return res.redirect(303, '/onboarding');
    }
    if (result !== 'ok') return go(res, here, { err: result });
    const steps = wizardSteps(hub);
    const next = steps[steps.indexOf(step) + 1] ?? 'finish';
    await conn.setOnboarding({ step: next });
    res.redirect(303, `/onboarding/${next}`);
  });

  // ---------- connections ----------

  r.get('/connections', requireOwner, async (req, res) => {
    send(res, 'Connections', await connectionsGrid(hub), { nav: 'connections', ...flashOf(req) });
  });
  r.get('/connections/new', requireOwner, (_req, res) => {
    send(res, 'Add agent', newCustomAgent(), { nav: 'connections' });
  });
  r.post('/connections/new', requireOwner, async (req, res) => {
    const nm = String(req.body.name ?? '').trim();
    if (!nm) return send(res.status(400), 'Add agent', newCustomAgent('Give it a name.'), { nav: 'connections' });
    const topics = ([] as string[]).concat(req.body.topic ?? []).filter((x) => (TOPICS as readonly string[]).includes(x));
    const def = await conn.addCustomAgent({ name: nm, profile: String(req.body.profile ?? ''), topics });
    go(res, `/connections/${def.id}`, { ok: 'added' });
  });
  r.post('/connections/email/save', requireOwner, async (req, res) => {
    const back = backTo(req, '/connections');
    const provider = String(req.body.provider ?? 'other') as EmailProvider;
    const address = String(req.body.address ?? '').trim();
    const password = String(req.body.password ?? '');
    const patch: Record<string, string | null> = {};
    if (!(provider in EMAIL_PROVIDERS)) return go(res, back, { err: 'invalid' });
    if (conn.source('email.from') !== 'env') {
      if (!address) return go(res, back, { err: 'email' });
      patch['email.from'] = address;
    }
    patch['email.provider'] = provider;
    const preset = EMAIL_PROVIDERS[provider];
    const user = address || cfg.email.from || '';
    if (preset.smtp && password) {
      patch['email.smtp'] = mailUrl(preset.smtp, user, password);
      patch['email.imap'] = mailUrl(preset.imap, user, password);
    }
    for (const k of ['smtp', 'imap'] as const) {
      const v = String(req.body[k] ?? '').trim();
      if (!v) continue;
      if (!/^(smtps?|imaps?):\/\/.+/.test(v)) return go(res, back, { err: 'invalid' });
      patch[`email.${k}`] = v;
    }
    if (!patch['email.smtp'] && !conn.isSet('email.smtp')) return go(res, back, { err: 'email' });
    const result = await save(patch);
    go(res, back, result === 'ok' ? { ok: 'saved' } : { err: result });
  });
  r.get('/connections/:agent', requireOwner, async (req, res) => {
    const agent = req.params.agent as AgentId;
    send(res, ADAPTERS[agent].name, await connectionDetail(hub, agent, { back: `/connections/${agent}` }), { nav: 'connections', ...flashOf(req) });
  });
  r.post('/connections/:agent/save', requireOwner, async (req, res) => {
    const agent = req.params.agent as AgentId;
    const back = backTo(req, `/connections/${agent}`);
    const patch: Record<string, string | null> = {};
    for (const key of editableKeys(agent)) {
      if (!(key in req.body)) continue;
      const v = String(req.body[key] ?? '').trim();
      // A blank secret field means "keep what's saved"; removing one is Disconnect's job.
      if (key === 'stanley.apiHash' && !v) continue;
      if (conn.source(key) === 'env') continue;
      patch[key] = v || null;
    }
    const result = await save(patch);
    go(res, back, result === 'ok' ? { ok: 'saved' } : { err: result });
  });
  r.post('/connections/:agent/settings', requireOwner, async (req, res) => {
    const agent = req.params.agent as AgentId;
    const back = backTo(req, `/connections/${agent}`);
    const scope = await store.scope(agent);
    if (!scope) return go(res, back, { err: 'invalid' });
    const hard = new Set(HARD_DENY[agent] ?? []);
    const picked = ([] as string[]).concat(req.body.topic ?? []).filter((x) => (TOPICS as readonly string[]).includes(x) && !hard.has(x));
    const everything = TOPICS.filter((x) => !hard.has(x)).every((x) => picked.includes(x));
    const autonomy = ['ask', 'notify', 'auto'].includes(req.body.autonomy) ? (req.body.autonomy as Autonomy) : scope.autonomy;
    await store.updateScope(agent, {
      allow_topics: everything ? ['*'] : picked,
      deny_topics: SENSITIVE.filter((x) => !picked.includes(x)),
      autonomy,
      enabled: scope.enabled,
    }, 'owner');
    go(res, back, { ok: 'saved' });
  });
  r.post(['/connections/:agent/pause', '/connections/:agent/resume'], requireOwner, async (req, res) => {
    const agent = req.params.agent as AgentId;
    const on = req.path.endsWith('/resume');
    await store.setAgentEnabled(agent, on, 'owner');
    if (on) hub.kick();
    go(res, backTo(req, `/connections/${agent}`), { ok: on ? 'resumed' : 'paused' });
  });
  r.post('/connections/:agent/disconnect', requireOwner, async (req, res) => {
    const agent = req.params.agent as AgentId;
    await conn.disconnect(agent);
    go(res, backTo(req, `/connections/${agent}`), { ok: 'disconnected' });
  });
  r.post('/connections/:agent/delete', requireOwner, async (req, res) => {
    const agent = req.params.agent as AgentId;
    if (!agent.startsWith('custom-')) return res.status(404).end();
    await conn.removeCustomAgent(agent as CustomAgentId);
    go(res, '/connections', { ok: 'deleted' });
  });
  r.post('/connections/:agent/generate', requireOwner, async (req, res) => {
    const agent = req.params.agent as AgentId;
    if (agent !== 'grok' && !agent.startsWith('custom-')) return res.status(404).end();
    const tokenKey = `token.${agent}`;
    const secretKey = agent === 'grok' ? 'grok.webhookSecret' : `hook.${agent}.secret`;
    const revealed: Record<string, string> = {};
    if (conn.source(tokenKey) !== 'env') revealed[tokenKey] = `hub_${randomBytes(24).toString('base64url')}`;
    if (conn.source(secretKey) !== 'env') revealed[secretKey] = randomBytes(32).toString('hex');
    const result = await save(revealed);
    if (result !== 'ok') return go(res, `/connections/${agent}`, { err: result });
    // The old token stops working at once; any OAuth grants stay (they're revoked by Disconnect).
    await store.audit('owner', 'agent.credentials_generated', { agent });
    const back = backTo(req, `/connections/${agent}`);
    const view = back.startsWith('/onboarding/') ? renderStep(hub, back.slice('/onboarding/'.length) as Step, revealed) : null;
    if (view) return send(res, view.title, view.html, { bare: true, flash: OK_MESSAGES.generated });
    send(res, ADAPTERS[agent].name, await connectionDetail(hub, agent, { back, revealed }), { nav: 'connections', flash: OK_MESSAGES.generated });
  });
  r.post('/connections/stanley/telegram-logout', requireOwner, async (req, res) => {
    const result = await save({ 'stanley.session': null, 'stanley.account': null });
    go(res, backTo(req, '/connections/stanley'), result === 'ok' ? { ok: 'signedout' } : { err: result });
  });

  // ---------- settings ----------

  r.get('/settings', requireOwner, (req, res) => {
    send(res, 'Settings', settingsBody(hub), { nav: 'settings', ...flashOf(req) });
  });
  r.post('/settings/profile', requireOwner, async (req, res) => {
    const patch: Record<string, string | null> = {};
    for (const k of ['owner.name', 'owner.timezone']) if (k in req.body && conn.source(k) !== 'env') patch[k] = String(req.body[k]).trim() || null;
    const result = await save(patch);
    go(res, '/settings', result === 'ok' ? { ok: 'saved' } : { err: result });
  });
  r.post('/settings/approval', requireOwner, async (req, res) => {
    const result = conn.source('approval.handle') === 'env' ? 'env' : await save({ 'approval.handle': String(req.body['approval.handle'] ?? '').trim() || null });
    go(res, '/settings', result === 'ok' ? { ok: 'saved' } : { err: result });
  });
  r.post('/settings/router', requireOwner, async (req, res) => {
    const patch: Record<string, string | null> = {};
    if (['anthropic', 'openai'].includes(req.body['router.provider'])) patch['router.provider'] = req.body['router.provider'];
    if (String(req.body['router.key'] ?? '').trim()) patch['router.key'] = String(req.body['router.key']);
    const result = await save(patch);
    go(res, '/settings', result === 'ok' ? { ok: 'saved' } : { err: result });
  });
  r.post('/settings/password', requireOwner, loginLimit, async (req, res) => {
    const result = await conn.changeOwnerPassword(String(req.body.current ?? ''), String(req.body.next ?? ''));
    if (result === 'ok') {
      issueSession(res);
      return go(res, '/settings', { ok: 'password' });
    }
    go(res, '/settings', { err: result === 'env' ? 'env' : result });
  });
  r.post('/settings/unpair', requireOwner, async (_req, res) => {
    await conn.unpairDaemons();
    await store.setSetting('daemon.heartbeat', null);
    go(res, '/settings', { ok: 'unpaired' });
  });

  // ---------- JSON API for the dashboard's widgets ----------

  const api = express.Router();
  api.use(apiOwner);
  api.param('id', (_req, res, next, id: string) => {
    if (/^[1-9]\d{0,15}$/.test(id)) return next();
    res.status(404).json({ error: 'not found' });
  });
  api.param('agent', (_req, res, next, agent: string) => {
    if (isAgentId(agent)) return next();
    res.status(404).json({ error: 'unknown agent' });
  });
  const needMac = async (res: Response) => {
    const m = await macStatus(hub);
    if (!m.paired && !m.lastSeenAt) {
      res.status(409).json({ error: 'Connect your Mac first.' });
      return false;
    }
    return true;
  };

  api.get('/mac', async (_req, res) => {
    res.json({ ...(await macStatus(hub)), installHere: Boolean(hub.macInstaller) });
  });
  api.post('/mac/pair-code', async (_req, res) => {
    const code = await conn.createPairingCode();
    res.json({ code, command: `cd ~/agent-hub && ./scripts/install-daemon.sh pair '${cfg.publicUrl}' ${code}`, expiresInMin: 15 });
  });
  api.post('/mac/install', async (_req, res) => {
    if (!hub.macInstaller) return res.status(404).json({ error: 'The hub isn’t running on a Mac. Use the install command instead.' });
    const code = await conn.createPairingCode();
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.publicUrl) ? cfg.publicUrl : `http://127.0.0.1:${cfg.port}`;
    try {
      await hub.macInstaller(local, code);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: `The installer failed: ${String((err as Error).message ?? err).slice(0, 300)}` });
    }
  });
  api.post('/mac/keep-awake', async (req, res) => {
    if (!(await needMac(res))) return;
    const job = await store.enqueueJob('keep-awake', { on: req.body?.on === true });
    await store.audit('owner', 'mac.keep_awake_requested', { on: req.body?.on === true });
    res.json({ jobId: job.id });
  });
  api.post('/mac/open-fda', async (_req, res) => {
    if (!(await needMac(res))) return;
    res.json({ jobId: (await store.enqueueJob('open-settings', { pane: 'full-disk-access' })).id });
  });
  api.post('/mac/threads', async (_req, res) => {
    if (!(await needMac(res))) return;
    res.json({ jobId: (await store.enqueueJob('list-threads', { days: 30 })).id });
  });
  api.get('/jobs/:id', async (req, res) => {
    const job = await store.job(Number(req.params.id));
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json({ status: job.status, result: job.result, error: job.error });
  });
  api.post('/approval/test', async (req, res) => {
    const typed = String(req.body?.handle ?? '').trim();
    if (typed && conn.source('approval.handle') !== 'env' && typed !== cfg.approval.imessageHandle) {
      const result = await save({ 'approval.handle': typed });
      if (result !== 'ok') return res.status(400).json({ error: ERR_MESSAGES[result] });
    }
    const handle = cfg.approval.channel === 'imessage' ? cfg.approval.imessageHandle : null;
    if (!handle) return res.status(400).json({ error: 'Enter your number first.' });
    if (!(await needMac(res))) return;
    const row = await store.enqueueOutbox({ toHandle: handle, body: 'Agent Hub test ✓ Approval requests will arrive in this thread. No need to reply.', purpose: 'notice' });
    await store.audit('owner', 'approval.test_text', {});
    res.json({ outboxId: row.id });
  });
  api.get('/outbox/:id', async (req, res) => {
    const row = await store.outboxItem(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ status: row.status, error: row.error });
  });
  api.post('/email/test', async (_req, res) => {
    const to = cfg.email.from;
    if (!hub.transports.email || !to) return res.status(400).json({ error: 'Email sending isn’t set up yet.' });
    try {
      await hub.transports.email.send({ to, subject: 'Agent Hub test email', text: 'This is a test from your Agent Hub. Email sending works.' });
      res.json({ ok: true, to });
    } catch (err) {
      res.status(502).json({ error: `Couldn’t send: ${String((err as Error).message ?? err).replace(/\/\/[^@\s]*@/g, '//***@').slice(0, 200)}` });
    }
  });
  api.post('/router/test', async (_req, res) => {
    if (!hub.llm) return res.status(400).json({ error: 'Add a key first.' });
    try {
      await hub.llm.complete('You are a connectivity check. Reply with the single word OK.', 'ping');
      res.json({ ok: true, model: `${cfg.router.provider}:${cfg.router.model}` });
    } catch (err) {
      res.status(502).json({ error: `The key didn’t work: ${String((err as Error).message ?? err).slice(0, 200)}` });
    }
  });
  api.post('/agents/:agent/test', (_req, res) => {
    res.json({ since: Date.now() });
  });
  api.get('/agents/:agent/seen', async (req, res) => {
    const agent = req.params.agent as AgentId;
    const since = Number(req.query.since ?? Date.now());
    let closed = false;
    req.on('close', () => (closed = true));
    for (let i = 0; i < 20 && !closed; i++) {
      const at = (await store.agentStatuses()).get(agent)?.last_read_at;
      if (at && new Date(at).getTime() >= since) return res.json({ seen: true, at });
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!closed) res.json({ seen: false });
  });
  api.post('/telegram/start', async (req, res) => {
    const { apiId, apiHash } = cfg.stanley;
    if (!apiId || !apiHash) return res.status(400).json({ error: 'Save your api_id and api_hash first.' });
    const phone = String(req.body?.phone ?? '').trim();
    if (!/^\+?[\d\s().-]{6,24}$/.test(phone)) return res.status(400).json({ error: 'Enter your phone number with the country code.' });
    const step = await hub.telegramLogin.start(apiId, apiHash, phone);
    if (step.status === 'error') return res.status(400).json({ error: step.message });
    res.json(step);
  });
  const finishTelegram = async (res: Response, step: Awaited<ReturnType<Hub['telegramLogin']['code']>>) => {
    if (step.status === 'error') return res.status(400).json({ error: step.message });
    if (step.status === 'done') {
      const result = await save({ 'stanley.session': step.session, 'stanley.account': step.account });
      if (result !== 'ok') return res.status(400).json({ error: ERR_MESSAGES[result] });
      await store.audit('owner', 'stanley.telegram_signed_in', {});
      return res.json({ status: 'done', account: step.account });
    }
    res.json(step);
  };
  api.post('/telegram/code', async (req, res) => {
    await finishTelegram(res, await hub.telegramLogin.code(String(req.body?.loginId ?? ''), String(req.body?.code ?? '')));
  });
  api.post('/telegram/password', async (req, res) => {
    await finishTelegram(res, await hub.telegramLogin.password(String(req.body?.loginId ?? ''), String(req.body?.password ?? '')));
  });
  api.post('/test-event', async (_req, res) => {
    const since = new Date(Date.now() - 1000);
    const agent = conn.onboarding.agents[0] ?? 'claude';
    const ev = await store.insertEvent({
      agent,
      occurredAt: new Date(),
      author: 'hub',
      rawExcerpt: '',
      summary: 'Test event from setup: the hub is working.',
      topics: ['general'],
      kind: 'test',
      routed: true,
    });
    res.json({ eventId: ev.id, since: since.toISOString() });
  });
  api.get('/events', async (req, res) => {
    const since = new Date(String(req.query.since ?? ''));
    const from = Number.isNaN(since.getTime()) ? new Date(Date.now() - 3600_000) : since;
    const events = await store.eventsSince(from, 50);
    res.json({ events: events.map((e) => ({ id: e.id, agent: e.agent, name: name(e.agent), summary: e.summary, at: e.occurred_at })) });
  });
  r.use('/api', api);

  // ---------- activity + advanced scopes ----------

  r.get('/timeline', requireOwner, async (_req, res) => {
    const [events, audit, recent] = await Promise.all([store.recentEvents(150), store.recentAudit(300), store.recentTasks(30)]);
    const items = [
      ...events.map((e) => ({
        at: new Date(e.occurred_at),
        html: `<b>${h(name(e.agent))}</b> ${pill(e.kind)} ${e.hop ? pill(`hop ${e.hop}`) : ''}
          ${h(e.summary || '(not routed yet)')}<div class="muted small">${e.topics.map(h).join(', ')} · ${e.author === 'user' ? 'with you' : 'agent-reported'}</div>
          ${e.raw_excerpt ? `<details class="more"><summary>excerpt</summary><pre>${h(e.raw_excerpt)}</pre></details>` : ''}`,
      })),
      ...audit.map((a) => ({ at: new Date(a.at), html: `<span class="muted">${h(a.actor)} · ${h(a.action)}</span> <code class="small">${h(JSON.stringify(a.detail))}</code>` })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    const tasks = recent.map((task) => `<tr><td><code>${h(task.code)}</code></td><td>${h(name(task.origin_agent))} → ${h(name(task.target_agent))}</td>
      <td>${h(task.payload)}${task.result ? `<div class="muted small">↳ ${h(task.result)}</div>` : ''}</td>
      <td>${pill(task.status, task.status === 'done' || task.status === 'sent' ? 'ok' : task.status === 'proposed' || task.status === 'approved' ? 'warn' : 'err')}${task.status_reason ? `<div class="muted small">${h(task.status_reason)}</div>` : ''}</td>
      <td class="time">${h(t(task.created_at))}</td>
      <td>${task.status === 'proposed' || task.status === 'approved' ? `<form method="post" action="/actions/task/${task.id}/cancel" class="inline"><button class="btn ghost sm">Cancel</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No tasks yet.</td></tr>';
    send(res, 'Activity', `<h1>Activity</h1>
      <div class="section-head"><h2>Recent hand-offs</h2><form method="post" action="/actions/debrief-digest" class="inline"><button class="btn secondary sm">Send debrief digest now</button></form></div>
      <section class="card" style="overflow-x:auto"><table>${tasks}</table></section>
      <div class="section-head"><h2>Everything</h2><a class="small" href="/scopes">Advanced scopes →</a></div>
      <section class="card"><ul class="list">${items.map((i) => `<li><span class="time" style="min-width:120px">${h(t(i.at))}</span><div class="grow">${i.html}</div></li>`).join('')}</ul></section>`, { nav: 'activity' });
  });

  r.get('/scopes', requireOwner, async (_req, res) => {
    const scopes = await store.scopes();
    const ids = agentIds().filter((a) => scopes.has(a));
    const opt = (cur: Autonomy, v: Autonomy, label: string) => `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`;
    const rows = ids.map((a) => {
      const s = scopes.get(a)!;
      return `<form method="post" action="/actions/scope/${a}" class="card">
        <div class="between"><h3>${h(ADAPTERS[a].name)}</h3><label class="switch"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> enabled</label></div>
        <p class="muted small">${h(ADAPTERS[a].capabilities.profile)}</p>
        ${field('allow', 'Can see topics (comma-separated, * = everything)', { value: s.allow_topics.join(', ') })}
        ${field('deny', 'Never sees', { value: s.deny_topics.join(', ') })}
        <div class="field"><label>Hand-offs to ${h(ADAPTERS[a].name)}</label><select name="autonomy">${opt(s.autonomy, 'ask', 'Ask me first')}${opt(s.autonomy, 'notify', 'Send, then tell me')}${opt(s.autonomy, 'auto', 'Send silently')}</select></div>
        <button class="btn">Save</button></form>`;
    }).join('');
    const routes = await store.routes();
    const routeRows = routes.map((rt) => `<tr><td>${h(name(rt.origin_agent))} → <b>${h(name(rt.target_agent))}</b></td><td>${h(rt.autonomy)}</td>
      <td><form method="post" action="/actions/route" class="inline">${hidden('origin', rt.origin_agent)}${hidden('target', rt.target_agent)}${hidden('autonomy', '')}
      <button class="btn ghost sm">Remove</button></form></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No overrides: each target uses its default above.</td></tr>';
    const agentOpts = ids.map((a) => `<option value="${a}">${h(ADAPTERS[a].name)}</option>`).join('');
    send(res, 'Scopes', `<p><a class="small" href="/timeline">← Activity</a></p><h1>Advanced scopes</h1>
      <p class="muted">The same settings as each agent's Connections page, as raw lists. “Never sees” is enforced again at delivery time with a content check, so a router mistake can't leak it.</p>
      <section class="card"><h2>Per-route autonomy</h2><p class="muted small">Overrides the target's default for one origin → target pair. Hand-offs an agent suggested always ask, whatever this says.</p>
        <table>${routeRows}</table>
        <form method="post" action="/actions/route" class="row mt"><select name="origin" style="width:auto">${agentOpts}</select><select name="target" style="width:auto">${agentOpts}</select>
        <select name="autonomy" style="width:auto"><option value="ask">Ask me first</option><option value="notify">Send, then tell me</option><option value="auto">Send silently</option></select><button class="btn">Set</button></form></section>
      <p class="muted small">Topics: ${TOPICS.join(', ')}</p><div class="grid">${rows}</div>`, { nav: 'activity' });
  });

  r.get('/setup', requireOwner, (_req, res) => {
    res.redirect(302, '/connections');
  });

  // ---------- actions ----------

  r.post('/actions/task/:id/:decision', requireOwner, async (req, res) => {
    const id = Number(req.params.id);
    const decision = req.params.decision;
    if (decision === 'cancel') {
      const updated = await store.transitionTask(id, ['proposed', 'approved'], 'cancelled', { reason: 'cancelled from dashboard' });
      if (updated) await store.audit('owner', 'task.cancelled', { code: updated.code, via: 'dashboard' });
      res.redirect(303, '/');
      return;
    }
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(404).end();
      return;
    }
    const approve = decision === 'approve';
    const task = await store.task(id);
    if (approve && task?.approval_expires_at && new Date(task.approval_expires_at) <= new Date()) {
      await store.transitionTask(id, ['proposed'], 'expired', { reason: 'approval window passed' });
      res.redirect(303, '/');
      return;
    }
    const updated = await store.transitionTask(id, ['proposed'], approve ? 'approved' : 'rejected', { reason: 'dashboard' });
    if (updated) await store.audit('owner', approve ? 'task.approved' : 'task.rejected', { code: updated.code, via: 'dashboard' });
    if (approve) hub.kick();
    res.redirect(303, '/');
  });

  r.post('/actions/dead-letter/:id/:action', requireOwner, async (req, res) => {
    const id = Number(req.params.id);
    const retry = req.params.action === 'retry';
    const dl = await store.resolveDeadLetter(id, retry ? 'retried' : 'dismissed');
    if (dl && retry) {
      if (dl.kind === 'route' && dl.ref_id) await store.requeueEvent(dl.ref_id);
      if (dl.kind === 'delivery' && dl.ref_id) await store.retryFailedTask(dl.ref_id);
      if (dl.kind === 'digest') await queueDigestNow(hub.ctx);
      hub.kick();
    }
    if (dl) await store.audit('owner', retry ? 'dead_letter.retried' : 'dead_letter.dismissed', { id, kind: dl.kind, ref: dl.ref_id });
    res.redirect(303, '/');
  });

  r.post('/actions/route', requireOwner, async (req, res) => {
    const { origin: o, target } = req.body;
    if (!isAgentId(o) || !isAgentId(target) || o === target) {
      res.redirect(303, '/scopes');
      return;
    }
    const autonomy = ['ask', 'notify', 'auto'].includes(req.body.autonomy) ? (req.body.autonomy as Autonomy) : null;
    await store.setRoute(o, target, autonomy, 'owner');
    res.redirect(303, '/scopes');
  });

  r.post('/actions/pause', requireOwner, async (_req, res) => {
    await store.setPaused(true, 'owner');
    res.redirect(303, '/');
  });

  r.post('/actions/resume', requireOwner, async (_req, res) => {
    await store.setPaused(false, 'owner');
    hub.kick();
    res.redirect(303, '/');
  });

  r.post('/actions/situation/:id/expire', requireOwner, async (req, res) => {
    await store.supersedeSituation([Number(req.params.id)], null);
    await store.audit('owner', 'situation.cleared', { id: Number(req.params.id) });
    res.redirect(303, '/');
  });

  r.post('/actions/debrief-digest', requireOwner, async (_req, res) => {
    await hub.sendDebriefDigest();
    res.redirect(303, '/timeline');
  });

  r.post('/actions/scope/:agent', requireOwner, async (req, res) => {
    const agent = req.params.agent as AgentId;
    const split = (v: unknown) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const autonomy = ['ask', 'notify', 'auto'].includes(req.body.autonomy) ? (req.body.autonomy as Autonomy) : 'ask';
    await store.updateScope(agent, { allow_topics: split(req.body.allow), deny_topics: split(req.body.deny), autonomy, enabled: req.body.enabled === 'on' }, 'owner');
    res.redirect(303, '/scopes');
  });

  return r;
}
