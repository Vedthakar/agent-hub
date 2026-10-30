import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { isAgentId, type AgentId } from '../shared/types.js';
import type { HubConfig } from './config.js';
import type { Store } from './store.js';
import { ADAPTERS } from './adapters/index.js';
import { escapeHtml } from './html.js';
import { safeEqual } from './crypto.js';

const ACCESS_TTL_S = 7 * 24 * 3600;
const REFRESH_TTL_S = 180 * 24 * 3600;
const CODE_TTL_MS = 5 * 60_000;
const MCP_AGENTS: AgentId[] = ['claude', 'chatgpt', 'gemini', 'grok'];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');

export { safeEqual } from './crypto.js';

function guessAgent(clientName: string | undefined): AgentId {
  const n = (clientName ?? '').toLowerCase();
  if (n.includes('chatgpt') || n.includes('openai')) return 'chatgpt';
  if (n.includes('gemini') || n.includes('google')) return 'gemini';
  if (n.includes('grok') || n.includes('cursor')) return 'grok';
  return 'claude';
}

/**
 * Single-owner OAuth 2.1 authorization server for the MCP endpoint. Each connection is bound to one
 * agent identity, chosen on the consent screen, so the hub always knows which agent is calling.
 */
export class HubOAuthProvider implements OAuthServerProvider {
  constructor(
    private store: Store,
    private cfg: HubConfig,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => {
        const rows = await this.store.db.query<{ info: OAuthClientInformationFull }>('SELECT info FROM oauth_clients WHERE client_id = $1', [clientId]);
        return rows[0]?.info;
      },
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        await this.store.db.query('INSERT INTO oauth_clients (client_id, info) VALUES ($1, $2)', [full.client_id, JSON.stringify(full)]);
        await this.store.audit('oauth', 'client.registered', { client_id: full.client_id, name: full.client_name ?? null });
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.status(200).type('html').send(consentPage({ client, params, selected: guessAgent(client.client_name) }));
  }

  /** POST /oauth/consent from the page rendered by authorize(). */
  async handleConsent(req: Request, res: Response): Promise<void> {
    const b = req.body as Record<string, string>;
    const client = await this.clientsStore.getClient(b.client_id ?? '');
    if (!client || !client.redirect_uris.includes(b.redirect_uri)) {
      res.status(400).send('Unknown client or redirect URI');
      return;
    }
    const redirect = new URL(b.redirect_uri);
    if (b.state) redirect.searchParams.set('state', b.state);

    if (b.decision !== 'allow') {
      redirect.searchParams.set('error', 'access_denied');
      res.redirect(302, redirect.toString());
      return;
    }
    if (!this.cfg.ownerPassword || !safeEqual(b.password ?? '', this.cfg.ownerPassword)) {
      res.status(401).type('html').send(
        consentPage({
          client,
          params: { codeChallenge: b.code_challenge, redirectUri: b.redirect_uri, state: b.state, resource: b.resource ? new URL(b.resource) : undefined },
          selected: isAgentId(b.agent) ? b.agent : 'claude',
          error: this.cfg.ownerPassword ? 'Wrong password.' : 'Set HUB_OWNER_PASSWORD on the server first.',
        }),
      );
      return;
    }
    if (!isAgentId(b.agent) || !MCP_AGENTS.includes(b.agent)) {
      res.status(400).send('Pick an agent');
      return;
    }
    const code = newSecret();
    await this.store.db.query(
      `INSERT INTO oauth_codes (code, client_id, agent, code_challenge, redirect_uri, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sha256(code), client.client_id, b.agent, b.code_challenge, b.redirect_uri, b.resource || null, new Date(Date.now() + CODE_TTL_MS)],
    );
    await this.store.audit('owner', 'oauth.authorized', { agent: b.agent, client: client.client_name ?? client.client_id });
    redirect.searchParams.set('code', code);
    res.redirect(302, redirect.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const rows = await this.store.db.query<{ code_challenge: string; client_id: string }>(
      'SELECT code_challenge, client_id FROM oauth_codes WHERE code = $1',
      [sha256(code)],
    );
    if (!rows.length || rows[0].client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return rows[0].code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const rows = await this.store.db.query<{ agent: AgentId; redirect_uri: string; resource: string | null }>(
      `UPDATE oauth_codes SET used = true
       WHERE code = $1 AND client_id = $2 AND NOT used AND expires_at > now()
       RETURNING agent, redirect_uri, resource`,
      [sha256(code), client.client_id],
    );
    const row = rows[0];
    if (!row) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    return this.issueTokens(client.client_id, row.agent, row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const rows = await this.store.db.query<{ agent: AgentId; resource: string | null }>(
      `UPDATE oauth_tokens SET revoked = true
       WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND NOT revoked AND (expires_at IS NULL OR expires_at > now())
       RETURNING agent, resource`,
      [sha256(refreshToken), client.client_id],
    );
    if (!rows[0]) throw new InvalidGrantError('Invalid refresh token');
    return this.issueTokens(client.client_id, rows[0].agent, rows[0].resource);
  }

  private async issueTokens(clientId: string, agent: AgentId, resource: string | null): Promise<OAuthTokens> {
    const access = newSecret();
    const refresh = newSecret();
    const now = Date.now();
    await this.store.db.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, agent, resource, expires_at) VALUES
       ($1, 'access', $3, $4, $5, $6), ($2, 'refresh', $3, $4, $5, $7)`,
      [sha256(access), sha256(refresh), clientId, agent, resource, new Date(now + ACCESS_TTL_S * 1000), new Date(now + REFRESH_TTL_S * 1000)],
    );
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'hub' };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    for (const [agent, secret] of Object.entries(this.cfg.agentTokens)) {
      if (secret && safeEqual(token, secret)) {
        return { token, clientId: `static:${agent}`, scopes: ['hub'], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { agent } };
      }
    }
    const rows = await this.store.db.query<{ agent: AgentId; client_id: string; expires_at: Date }>(
      `SELECT agent, client_id, expires_at FROM oauth_tokens
       WHERE token_hash = $1 AND kind = 'access' AND NOT revoked AND expires_at > now()`,
      [sha256(token)],
    );
    if (!rows[0]) throw new InvalidTokenError('Invalid or expired token');
    return {
      token,
      clientId: rows[0].client_id,
      scopes: ['hub'],
      expiresAt: Math.floor(new Date(rows[0].expires_at).getTime() / 1000),
      extra: { agent: rows[0].agent },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    await this.store.db.query('UPDATE oauth_tokens SET revoked = true WHERE token_hash = $1', [sha256(request.token)]);
  }
}

function consentPage(opts: { client: OAuthClientInformationFull; params: AuthorizationParams; selected: AgentId; error?: string }): string {
  const { client, params } = opts;
  const hidden = (name: string, value: string | undefined) =>
    value === undefined ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const options = MCP_AGENTS.map(
    (a) => `<option value="${a}"${a === opts.selected ? ' selected' : ''}>${escapeHtml(ADAPTERS[a].name)}</option>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Agent Hub</title>
<style>body{font:15px system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 20px;color:#111}
label{display:block;margin:14px 0 4px;font-weight:600}input,select{width:100%;padding:9px;font:inherit;box-sizing:border-box}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:10px;font:inherit;cursor:pointer}
.err{color:#b00020}.muted{color:#666}</style></head><body>
<h2>Connect to Agent Hub</h2>
<p class="muted"><b>${escapeHtml(client.client_name ?? client.client_id)}</b> wants to read your shared situation and receive tasks.</p>
${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
<form method="post" action="/oauth/consent">
${hidden('client_id', client.client_id)}${hidden('redirect_uri', params.redirectUri)}${hidden('code_challenge', params.codeChallenge)}
${hidden('state', params.state)}${hidden('resource', params.resource?.toString())}
<label for="agent">This connection is</label><select id="agent" name="agent">${options}</select>
<label for="password">Hub owner password</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus>
<div class="row"><button name="decision" value="deny" type="submit">Deny</button><button name="decision" value="allow" type="submit">Allow</button></div>
</form></body></html>`;
}
