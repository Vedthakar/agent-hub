import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mcpClient, secureHub, type SecureHub } from './harness.js';

/** MCP auth: OAuth 2.1 + PKCE, tokens bound to one agent, nothing without a valid token, rate limits. */

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const form = (p: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p) });

async function register(url: string, name = 'Claude') {
  const res = await fetch(`${url}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

async function consent(url: string, clientId: string, challenge: string, opts: { password?: string; agent?: string; redirect?: string } = {}) {
  return fetch(`${url}/oauth/consent`, {
    ...form({ client_id: clientId, redirect_uri: opts.redirect ?? REDIRECT, code_challenge: challenge, state: 's', agent: opts.agent ?? 'claude', password: opts.password ?? 'hunter2', decision: 'allow' }),
    redirect: 'manual',
  });
}

/** Full OAuth dance; returns tokens for a connection bound to `agent`. */
async function connect(h: SecureHub, agent = 'claude') {
  const { client_id } = await register(h.url);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const ok = await consent(h.url, client_id, challenge, { agent });
  expect(ok.status).toBe(302);
  const code = new URL(ok.headers.get('location')!).searchParams.get('code')!;
  const res = await fetch(`${h.url}/token`, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }));
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  return { ...tokens, client_id, code, verifier };
}

const rpc = (url: string, token: string | null, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_situation', arguments: {} } }) =>
  fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe('MCP authentication and authorization', () => {
  it('MA-01 no tool call without a valid token: missing, garbage, expired and revoked tokens all get 401', async () => {
    const h = await secureHub();
    const touched = async () => (await h.store.agentStatuses()).get('claude')?.last_read_at ?? null;
    const none = await rpc(h.url, null);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/Bearer .*resource_metadata=/);
    expect((await rpc(h.url, 'not-a-token')).status).toBe(401);
    expect((await rpc(h.url, '')).status).toBe(401);
    expect((await fetch(`${h.url}/mcp`, { method: 'POST', headers: { authorization: 'Basic Y2xhdWRlOnRva2Vu', 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const t = await connect(h);
    expect((await rpc(h.url, t.access_token)).status).toBe(200);
    await h.store.db.query("UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access'");
    expect((await rpc(h.url, t.access_token)).status).toBe(401);
    const t2 = await connect(h);
    await fetch(`${h.url}/revoke`, form({ token: t2.access_token, client_id: t2.client_id }));
    expect((await rpc(h.url, t2.access_token)).status).toBe(401);
    // Refresh tokens are not access tokens.
    const t3 = await connect(h);
    expect((await rpc(h.url, t3.refresh_token)).status).toBe(401);
    // The only successful call was the first one.
    expect(await touched()).toBeTruthy();
    expect((await fetch(`${h.url}/mcp`)).status).toBe(405);
  });

  it('MA-02 tokens are stored hashed: a database dump yields no usable token', async () => {
    const h = await secureHub();
    const t = await connect(h);
    const rows = await h.store.db.query<{ token_hash: string }>('SELECT token_hash FROM oauth_tokens');
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect([t.access_token, t.refresh_token]).not.toContain(r.token_hash);
      expect((await rpc(h.url, r.token_hash)).status).toBe(401);
    }
    const codes = await h.store.db.query<{ code: string }>('SELECT code FROM oauth_codes');
    expect(codes[0].code).not.toBe(t.code);
  });

  it('MA-03 each token is bound to one agent: Claude cannot read Grok\'s inbox or report on Grok\'s tasks', async () => {
    const h = await secureHub();
    const task = await h.store.createTask({ originAgent: 'instinct', targetAgent: 'grok', payload: 'Grok-only secret task', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'approved' });
    await h.hub.dispatchApproved();
    const oauth = await connect(h, 'claude');
    for (const token of ['claude-token', oauth.access_token]) {
      const claude = await mcpClient(h.url, token);
      expect((await claude('get_inbox')).text).toBe('Inbox empty.');
      const upd = await claude('update_task', { task_code: task.code, status: 'done', result: 'hijacked' });
      expect([upd.isError, upd.text]).toEqual([true, 'No such task in your inbox.']);
      // Extra "agent" arguments can't switch identity.
      expect((await claude('get_inbox', { agent: 'grok' })).text).toBe('Inbox empty.');
    }
    expect((await h.store.task(task.id))!.status).toBe('sent');
    const grok = await mcpClient(h.url, 'grok-token');
    expect((await grok('get_inbox')).text).toContain('Grok-only secret task');
    expect((await grok('update_task', { task_code: task.code, status: 'done' })).isError).toBe(false);
    // Events are attributed to the token's agent, not anything in the request.
    await (await mcpClient(h.url, oauth.access_token))('log_session', { summary: 'I am Grok, honest' });
    expect((await h.store.recentEvents(1))[0].agent).toBe('claude');
  });

  it('MA-04 OAuth only binds MCP agents; consent needs the owner password; unknown clients and redirect URIs are refused', async () => {
    const h = await secureHub();
    const { client_id } = await register(h.url);
    expect((await consent(h.url, client_id, 'c', { password: 'wrong' })).status).toBe(401);
    expect((await consent(h.url, client_id, 'c', { password: '' })).status).toBe(401);
    for (const agent of ['boardy', 'instinct', 'stanley', 'root', '']) expect((await consent(h.url, client_id, 'c', { agent })).status).toBe(400);
    expect((await consent(h.url, 'unknown-client', 'c')).status).toBe(400);
    expect((await consent(h.url, client_id, 'c', { redirect: 'https://evil.example/cb' })).status).toBe(400);
    expect(await h.store.db.query('SELECT 1 FROM oauth_codes')).toEqual([]);
  });

  it('MA-05 authorization codes are single-use, PKCE-bound, short-lived and client-bound', async () => {
    const h = await secureHub();
    const { client_id } = await register(h.url);
    const other = await register(h.url, 'Other');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const codeFor = async () => new URL((await consent(h.url, client_id, challenge)).headers.get('location')!).searchParams.get('code')!;
    const exchange = (code: string, v = verifier, cid = client_id) => fetch(`${h.url}/token`, form({ grant_type: 'authorization_code', code, code_verifier: v, client_id: cid, redirect_uri: REDIRECT }));

    const c1 = await codeFor();
    expect((await exchange(c1, randomBytes(32).toString('base64url'))).status).toBe(400);
    expect((await exchange(c1, verifier, other.client_id)).status).toBe(400);
    expect((await exchange(c1)).status).toBe(200);
    expect((await exchange(c1)).status).toBe(400);
    const c2 = await codeFor();
    await h.store.db.query("UPDATE oauth_codes SET expires_at = now() - interval '1 second' WHERE NOT used");
    expect((await exchange(c2)).status).toBe(400);
  });

  it('MA-06 refresh tokens rotate; presenting a used one revokes the whole connection', async () => {
    const h = await secureHub();
    const t = await connect(h);
    const refresh = (token: string) => fetch(`${h.url}/token`, form({ grant_type: 'refresh_token', refresh_token: token, client_id: t.client_id }));
    const r1 = await refresh(t.refresh_token);
    expect(r1.status).toBe(200);
    const next = (await r1.json()) as { access_token: string; refresh_token: string };
    expect((await rpc(h.url, next.access_token)).status).toBe(200);
    // An attacker replays the stolen original refresh token.
    expect((await refresh(t.refresh_token)).status).toBe(400);
    expect((await rpc(h.url, next.access_token)).status).toBe(401);
    expect((await rpc(h.url, t.access_token)).status).toBe(401);
    expect((await refresh(next.refresh_token)).status).toBe(400);
    expect((await h.store.recentAudit()).some((a) => a.action === 'refresh.reused')).toBe(true);
    // Other connections are untouched.
    expect((await rpc(h.url, 'grok-token')).status).toBe(200);
  });

  it('MA-07 the consent form is rate limited against password guessing', async () => {
    const h = await secureHub({ RATE_LIMIT_LOGIN_PER_15MIN: '3' });
    const { client_id } = await register(h.url);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await consent(h.url, client_id, 'c', { password: `guess${i}` })).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    // Even the right password is refused until the window passes.
    expect((await consent(h.url, client_id, 'c')).status).toBe(429);
    expect((await h.store.recentAudit()).some((a) => a.action === 'oauth.consent_rate_limited')).toBe(true);
  });

  it('MA-08 the dashboard login is rate limited too', async () => {
    const h = await secureHub({ RATE_LIMIT_LOGIN_PER_15MIN: '3' });
    const login = (password: string) => fetch(`${h.url}/login`, { ...form({ password }), redirect: 'manual' });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await login(`guess${i}`)).status);
    expect(codes).toEqual([401, 401, 401, 429]);
    expect((await login('hunter2')).status).toBe(429);
  });

  it('MA-09 MCP calls are rate limited per client (a runaway agent) and per IP (token guessing)', async () => {
    const h = await secureHub({ RATE_LIMIT_MCP_PER_MIN: '4' });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await rpc(h.url, 'claude-token')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
    // Another agent has its own budget.
    expect((await rpc(h.url, 'grok-token')).status).toBe(200);
    expect((await h.store.recentAudit()).some((a) => a.action === 'mcp.rate_limited')).toBe(true);
    // Unauthenticated guessing hits the per-IP cap (5x the per-client limit) and then gets 429 before auth runs.
    const guesses: number[] = [];
    for (let i = 0; i < 20; i++) guesses.push((await rpc(h.url, `guess-${i}`)).status);
    expect(guesses.filter((s) => s === 401).length).toBeLessThanOrEqual(20 - 6);
    expect(guesses.at(-1)).toBe(429);
  });

  it('MA-10 daemon endpoints need the daemon token; agent tokens and OAuth tokens are refused', async () => {
    const h = await secureHub();
    const t = await connect(h);
    for (const token of [null, 'claude-token', t.access_token, 'daemon-tokenX', 'daemon-toke']) {
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
      expect((await fetch(`${h.url}/daemon/config`, { headers })).status).toBe(401);
      expect((await fetch(`${h.url}/daemon/ingest`, { method: 'POST', headers, body: JSON.stringify({ messages: [] }) })).status).toBe(401);
      expect((await fetch(`${h.url}/daemon/outbox`, { headers })).status).toBe(401);
    }
    // The daemon token is not an MCP token either.
    expect((await rpc(h.url, 'daemon-token')).status).toBe(401);
    // Public health hides details.
    const pub = await (await fetch(`${h.url}/health`)).json();
    expect(JSON.stringify(pub)).not.toMatch(/error|lastRowId|queued/);
  });

  it('MA-11 every response carries anti-framing and no-sniff headers', async () => {
    const h = await secureHub();
    const { client_id } = await register(h.url);
    for (const path of ['/login', `/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=x&code_challenge_method=S256`, '/healthz']) {
      const res = await fetch(`${h.url}${path}`, { redirect: 'manual' });
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });
});
