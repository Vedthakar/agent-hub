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
import { normalizeHandle, type Hub } from './hub.js';
import { createMcpServer } from './mcp.js';
import { HubOAuthProvider } from './oauth.js';
import { verifyTwilio } from './transports/sms.js';

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

  const provider = new HubOAuthProvider(store, cfg);
  const mcpUrl = new URL(`${cfg.publicUrl}/mcp`);

  const hasDaemonToken = (req: Request) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return Boolean(cfg.daemonToken) && safeEqual(token, cfg.daemonToken!);
  };

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
  app.post('/oauth/consent', express.urlencoded({ extended: false }), (req, res, next) => {
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
    await store.setSetting('daemon.heartbeat', {
      at: new Date().toISOString(),
      lastRowId: Number(req.body?.lastRowId ?? 0),
      error: req.body?.error ?? null,
      version: req.body?.version ?? null,
    });
    res.json({ ok: true });
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
      fromOwner: Boolean(t.userNumber) && normalizeHandle(from) === normalizeHandle(t.userNumber!),
      sender: from,
      text: params.Body ?? '',
    });
    res.type('text/xml').send('<Response></Response>');
  });

  // ---------- dashboard ----------
  app.use(dashboardRouter(hub));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('http.error', { error: String(err) });
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });
  return app;
}
