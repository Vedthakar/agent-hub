import express, { type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { isAgentId } from '../shared/types.js';
import { log } from '../shared/log.js';
import { safeEqual } from './crypto.js';
import { dashboardRouter } from './dashboard.js';
import { hubHealth, publicHealth } from './health.js';
import type { Hub } from './hub.js';
import { sameHandle } from '../shared/handles.js';
import { createMcpServer } from './mcp.js';
import { HubOAuthProvider } from './oauth.js';
import { verifyTwilio } from './transports/sms.js';
import { signWebhook } from './adapters/grok.js';
import { inbox, logSession, propose, retireMemory, saveMemory, setSituation, updateTask } from './agentApi.js';
import { renderSituation, situationFor } from './context.js';
import type { HubConfig } from './config.js';
import { TOPICS, type AgentId } from '../shared/types.js';

export interface DaemonHeartbeat {
  at: string;
  lastRowId: number;
  error: string | null;
  version: string | null;
  /** null until a daemon new enough to report it checks in. */
  fullDiskAccess: boolean | null;
  keepAwake: boolean | null;
  /** The binary that needs Full Disk Access. */
  nodePath: string | null;
}

const HOOK_SKEW_S = 300;

/** The secret an agent's /hooks/<agent> calls are signed with (the same one signs the hub's nudges to it). */
export function hookSecret(cfg: HubConfig, agent: AgentId): string | null {
  return agent === 'grok' ? cfg.grokWebhookSecret : (cfg.agentWebhooks[agent]?.secret ?? null);
}

const Topics = z.array(z.enum(TOPICS)).optional();
const HookBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('situation') }),
  z.object({
    type: z.literal('session'),
    summary: z.string().min(1).max(4000),
    decisions: z.array(z.string().max(1000)).max(50).optional(),
    transcript_excerpt: z.string().max(8000).optional(),
    topics: Topics,
    task_code: z.string().max(16).optional(),
  }),
  z.object({ type: z.literal('inbox') }),
  z.object({
    type: z.literal('set_situation'),
    text: z.string().min(1).max(500),
    topics: z.array(z.enum(TOPICS)).min(1),
    expires_at: z.string().max(40).optional(),
    valid_from: z.string().max(40).optional(),
    slot: z.string().max(80).optional(),
  }),
  z.object({ type: z.literal('save_memory'), text: z.string().min(1).max(500), kind: z.enum(['goal', 'preference', 'fact']), topics: z.array(z.enum(TOPICS)).min(1) }),
  z.object({ type: z.literal('retire_memory'), id: z.number().int().positive() }),
  z.object({
    type: z.literal('propose'),
    target_agent: z.string().max(40),
    task: z.string().min(1).max(4000),
    reason: z.string().max(1000).optional(),
    user_requested: z.boolean().optional(),
    topics: Topics,
    task_code: z.string().max(16).optional(),
  }),
  z.object({ type: z.literal('task_result'), task_code: z.string().max(16), status: z.enum(['done', 'failed']), result: z.string().max(4000).optional() }),
]);

const DaemonMessages = z.object({
  messages: z
    .array(
      z.object({
        guid: z.string(),
        rowid: z.number(),
        handle: z.string(),
        isFromMe: z.boolean(),
        text: z.string(),
        sentAt: z.string(),
        service: z.string().default('iMessage'),
      }),
    )
    .max(1000),
});

export function createApp(hub: Hub): express.Express {
  const { cfg, store } = hub;
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // The consent and dashboard pages take the owner password: never frameable, never sniffed, no referrers.
  app.use((_req, res, next) => {
    res.set({
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    next();
  });

  const provider = new HubOAuthProvider(store, cfg, hub.connections);
  const mcpUrl = new URL(`${cfg.publicUrl}/mcp`);

  // The env token, or one the daemon got by pairing from the dashboard.
  const hasDaemonToken = (req: Request) => hub.connections.verifyDaemonToken((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  // Public callers get states only; the daemon token (or a logged-in dashboard) sees error details and counts.
  app.get('/health', async (req, res) => {
    const h = await hubHealth(hub);
    res.status(h.state === 'down' ? 503 : 200).json(hasDaemonToken(req) ? h : publicHealth(h));
  });
  app.get('/health/:agent', async (req, res) => {
    const h = await hubHealth(hub);
    const a = h.adapters.find((x) => x.agent === req.params.agent);
    if (!a) {
      res.status(404).json({ error: 'unknown agent' });
      return;
    }
    res.status(a.state === 'down' ? 503 : 200).json(hasDaemonToken(req) ? a : { agent: a.agent, state: a.state });
  });

  // ---------- OAuth + MCP ----------
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(cfg.publicUrl),
      resourceServerUrl: mcpUrl,
      resourceName: 'Agent Hub',
      scopesSupported: ['hub'],
    }),
  );
  // The consent form takes the owner password, so it gets the same brute-force limit as the dashboard login.
  const consentLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: cfg.rateLimit.loginPer15Min,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    requestWasSuccessful: (_req, res) => res.statusCode === 302,
    skipSuccessfulRequests: true,
    handler: (_req, res) => {
      void store.audit('hub', 'oauth.consent_rate_limited', {});
      res.status(429).send('Too many attempts. Try again in 15 minutes.');
    },
  });
  app.post('/oauth/consent', consentLimit, express.urlencoded({ extended: false }), (req, res, next) => {
    provider.handleConsent(req, res).catch(next);
  });

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  // Per IP before auth (token guessing), then per OAuth client after auth (a runaway agent).
  const mcpIpLimit = rateLimit({ windowMs: 60_000, limit: cfg.rateLimit.mcpPerMinute * 5, standardHeaders: 'draft-7', legacyHeaders: false });
  const mcpClientLimit = rateLimit({
    windowMs: 60_000,
    limit: cfg.rateLimit.mcpPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `client:${req.auth?.clientId ?? 'unknown'}`,
    handler: (req, res) => {
      void store.audit('hub', 'mcp.rate_limited', { client: req.auth?.clientId ?? null });
      res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded' }, id: null });
    },
  });
  app.post('/mcp', mcpIpLimit, express.json({ limit: '1mb' }), bearer, mcpClientLimit, async (req, res) => {
    const agent = req.auth?.extra?.agent;
    if (!isAgentId(agent)) {
      res.status(403).json({ error: 'token is not bound to an agent' });
      return;
    }
    const server = createMcpServer(hub, agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('mcp.error', { error: String(err) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  // Stateless server: no SSE stream or session teardown.
  app.get('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').end();
  });
  app.delete('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').end();
  });

  // ---------- Mac daemon ----------
  const daemonAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!hasDaemonToken(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
  // Pairing trades a one-time code from the dashboard for the daemon's own token. Unauthenticated, so tightly limited.
  const pairLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
  app.post('/daemon/pair', pairLimit, express.json({ limit: '4kb' }), async (req, res) => {
    const token = await hub.connections.redeemPairingCode(String(req.body?.code ?? '').slice(0, 32));
    if (!token) {
      res.status(401).json({ error: 'That pairing code is wrong or expired. Make a new one in the dashboard.' });
      return;
    }
    res.json({ token });
  });

  const daemon = express.Router();
  daemon.use(express.json({ limit: '5mb' }), daemonAuth);

  daemon.get('/config', async (_req, res) => {
    res.json(hub.daemonConfig(await store.isPaused()));
  });
  daemon.post('/ingest', async (req, res) => {
    const parsed = DaemonMessages.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const result = await hub.ingestDaemon(parsed.data.messages);
    res.json(result);
  });
  daemon.get('/outbox', async (_req, res) => {
    // While paused only approval/notice texts go out, never agent deliveries.
    const items = await store.claimOutbox(10, { paused: await store.isPaused() });
    res.json({ items: items.map((o) => ({ id: o.id, toHandle: o.to_handle, body: o.body })) });
  });
  daemon.post('/outbox/:id/ack', async (req, res) => {
    const ok = req.body?.ok === true;
    const row = await store.ackOutbox(Number(req.params.id), ok, ok ? undefined : String(req.body?.error ?? 'unknown'));
    if (row && !ok) {
      await store.audit('daemon', 'outbox.failed', { id: row.id, error: req.body?.error ?? null });
      if (row.purpose === 'delivery' && row.task_id) {
        await store.reopenForRetry(row.task_id, `iMessage send failed: ${String(req.body?.error ?? 'unknown')}`, new Date(Date.now() + cfg.delivery.baseBackoffMs));
      }
    }
    res.json({ ok: Boolean(row) });
  });
  daemon.post('/heartbeat', async (req, res) => {
    const b = req.body ?? {};
    const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
    const hb: DaemonHeartbeat = {
      at: new Date().toISOString(),
      lastRowId: Number(b.lastRowId ?? 0),
      error: str(b.error, 500),
      version: str(b.version, 40),
      fullDiskAccess: flag(b.fullDiskAccess),
      keepAwake: flag(b.keepAwake),
      nodePath: str(b.nodePath, 300),
    };
    await store.setSetting('daemon.heartbeat', hb);
    res.json({ ok: true });
  });
  daemon.get('/jobs', async (_req, res) => {
    const jobs = await store.claimJobs();
    res.json({ jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, args: j.args })) });
  });
  daemon.post('/jobs/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(404).end();
      return;
    }
    const ok = req.body?.ok === true;
    const row = await store.finishJob(id, ok, ok ? (req.body?.result ?? null) : null, ok ? null : String(req.body?.error ?? 'unknown').slice(0, 500));
    res.json({ ok: Boolean(row) });
  });
  app.use('/daemon', daemon);

  // ---------- hub's own SMS number (Twilio) ----------
  app.post('/twilio/sms', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    const t = cfg.approval.twilio;
    const params = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)]));
    if (!t.authToken || !verifyTwilio(t.authToken, `${cfg.publicUrl}/twilio/sms`, params, req.header('x-twilio-signature'))) {
      await store.audit('hub', 'twilio.bad_signature', {});
      res.status(403).end();
      return;
    }
    const from = params.From ?? '';
    if (!params.MessageSid) {
      res.status(400).end();
      return;
    }
    await hub.handleInbound({
      channel: 'sms',
      externalId: params.MessageSid,
      fromOwner: sameHandle(from, t.userNumber),
      sender: from,
      text: params.Body ?? '',
    });
    res.type('text/xml').send('<Response></Response>');
  });

  // ---------- signed webhook for agents that can't hold an MCP session (Grok Bot, custom agents) ----------
  const hookLimit = rateLimit({ windowMs: 60_000, limit: cfg.rateLimit.mcpPerMinute, standardHeaders: 'draft-7', legacyHeaders: false });
  const seenSignatures = new Map<string, number>();
  app.post('/hooks/:agent', hookLimit, express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
    const agent = req.params.agent;
    const secret = isAgentId(agent) ? hookSecret(cfg, agent) : null;
    if (!isAgentId(agent) || !secret) {
      res.status(404).json({ error: 'no webhook for that agent' });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const ts = req.get('x-hub-timestamp') ?? '';
    const sig = req.get('x-hub-signature') ?? '';
    const now = Date.now();
    if (!/^\d{9,11}$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > HOOK_SKEW_S || !safeEqual(sig, signWebhook(secret, ts, body))) {
      await store.audit('hub', 'hook.bad_signature', { agent });
      res.status(401).json({ error: 'bad or stale signature' });
      return;
    }
    for (const [k, exp] of seenSignatures) if (exp < now) seenSignatures.delete(k);
    if (seenSignatures.has(sig)) {
      res.status(409).json({ error: 'replayed request' });
      return;
    }
    seenSignatures.set(sig, now + 2 * HOOK_SKEW_S * 1000);
    let parsed;
    try {
      parsed = HookBody.safeParse(JSON.parse(body));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) {
      res.status(400).json({ error: 'body must be JSON with a known "type"' });
      return;
    }
    const call = parsed.data;
    switch (call.type) {
      case 'situation': {
        const view = await situationFor(store, agent);
        await store.touchRead(agent);
        res.json({ text: renderSituation(view, cfg.ownerName, cfg.timezone), situation: view });
        return;
      }
      case 'session':
        res.json(await logSession(hub, agent, call));
        return;
      case 'inbox': {
        const tasks = await inbox(hub, agent);
        await store.touchRead(agent);
        res.json({ tasks: tasks.map((t) => ({ code: t.code, from: t.origin_agent, payload: t.payload })) });
        return;
      }
      case 'set_situation':
        res.json(await setSituation(hub, agent, call));
        return;
      case 'save_memory':
        res.json(await saveMemory(hub, agent, call));
        return;
      case 'retire_memory':
        res.json(await retireMemory(hub, agent, call.id));
        return;
      case 'propose':
        res.status(200).json(await propose(hub, agent, call));
        return;
      case 'task_result':
        res.json(await updateTask(hub, agent, call));
        return;
    }
  });

  // ---------- dashboard ----------
  app.use(dashboardRouter(hub));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('http.error', { error: String(err) });
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });
  return app;
}
