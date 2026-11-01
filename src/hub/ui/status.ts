import { agentIds, type AgentId } from '../../shared/types.js';
import { ADAPTERS } from '../adapters/index.js';
import { adapterHealth } from '../health.js';
import type { Hub } from '../hub.js';
import type { DaemonHeartbeat } from '../server.js';
import { metaFor } from './agents.js';

export type ConnState = 'connected' | 'setup' | 'error' | 'paused';

export interface MacStatus {
  paired: boolean;
  online: boolean;
  lastSeenAt: string | null;
  fullDiskAccess: boolean | null;
  keepAwake: boolean | null;
  nodePath: string | null;
  version: string | null;
  error: string | null;
}

const MAC_STALE_MS = 2 * 60_000;

export async function macStatus(hub: Hub): Promise<MacStatus> {
  const hb = await hub.store.getSetting<Partial<DaemonHeartbeat> | null>('daemon.heartbeat', null);
  const online = Boolean(hb?.at && Date.now() - new Date(hb.at).getTime() < MAC_STALE_MS);
  return {
    paired: hub.connections.hasPairedDaemon(),
    online,
    lastSeenAt: hb?.at ?? null,
    fullDiskAccess: hb?.fullDiskAccess ?? (hb?.error ? (/Full Disk Access/.test(hb.error) ? false : null) : hb ? true : null),
    keepAwake: hb?.keepAwake ?? null,
    nodePath: hb?.nodePath ?? null,
    version: hb?.version ?? null,
    error: hb?.error ?? null,
  };
}

export interface AgentCard {
  agent: AgentId;
  name: string;
  state: ConnState;
  /** One line under the name: what's missing, the error, or how it's connected. */
  detail: string;
  missing: string[];
  enabled: boolean;
  lastEventAt: Date | null;
  lastReadAt: Date | null;
}

export async function agentCards(hub: Hub): Promise<AgentCard[]> {
  const { cfg, store } = hub;
  const [health, lastEvents, mac, scopes] = await Promise.all([adapterHealth(hub), store.lastEventTimes(), macStatus(hub), store.scopes()]);
  const oauth = new Map<AgentId, boolean>();
  for (const a of agentIds()) if (ADAPTERS[a]?.capabilities.readVia === 'mcp') oauth.set(a, await store.hasOAuthConnection(a));
  const emailReady = Boolean(cfg.email.smtpUrl && cfg.email.from);
  const linkedin = cfg.owner.links.some((l) => /linkedin/i.test(l.label) || /linkedin\.com/i.test(l.url));

  return agentIds().map((agent) => {
    const name = ADAPTERS[agent].name;
    const hl = health.find((x) => x.agent === agent);
    const enabled = scopes.get(agent)?.enabled ?? false;
    const missing: string[] = [];
    let how = '';
    const kind = metaFor(agent).kind;
    if (kind === 'mcp' || kind === 'custom' || kind === 'webhook') {
      const cred = oauth.get(agent) || Boolean(cfg.agentTokens[agent]) || (agent === 'grok' ? Boolean(cfg.grokWebhookSecret) : Boolean(cfg.agentWebhooks[agent]?.secret));
      if (!cred) missing.push(kind === 'mcp' ? `Add the connector in ${name}` : 'Generate a token or webhook secret');
      how = hl?.lastReadAt ? 'Syncing over MCP' : 'Connected, waiting for its first call';
    } else {
      const handle = cfg.imessageHandles[agent];
      if (!mac.paired && !mac.lastSeenAt) missing.push('Connect your Mac');
      else if (mac.fullDiskAccess === false) missing.push('Turn on Full Disk Access');
      if (!handle) missing.push(`Pick ${name}'s Messages thread`);
      if (agent === 'instinct') {
        if (!cfg.instinctEmail) missing.push("Add Instinct's forwarding email");
        if (!emailReady) missing.push('Set up email sending');
      }
      if (agent === 'stanley') {
        if (!cfg.stanley.session) missing.push('Sign in to Telegram');
        if (!cfg.stanley.peer) missing.push("Add Stan's Telegram username");
      }
      if (agent === 'boardy') {
        if (!emailReady) missing.push('Set up email sending');
        if (!linkedin) missing.push('Add your LinkedIn');
      }
      how = 'Reading from Messages';
    }
    let state: ConnState = missing.length ? 'setup' : 'connected';
    let detail = missing.length ? missing[0] + (missing.length > 1 ? ` (+${missing.length - 1} more)` : '') : how;
    const imessage = kind === 'imessage';
    if (state === 'connected' && imessage && mac.lastSeenAt && !mac.online) {
      state = 'error';
      detail = 'Your Mac is offline';
    } else if (state === 'connected' && hl && (hl.state === 'down' || hl.state === 'degraded') && hl.lastError) {
      state = 'error';
      detail = hl.lastError.length > 90 ? `${hl.lastError.slice(0, 87)}…` : hl.lastError;
    }
    if (!enabled) {
      state = 'paused';
      detail = 'Paused: it gets no context or tasks';
    }
    return { agent, name, state, detail, missing, enabled, lastEventAt: lastEvents.get(agent) ?? null, lastReadAt: hl?.lastReadAt ? new Date(hl.lastReadAt) : null };
  });
}

export const STATE_LABEL: Record<ConnState, string> = { connected: 'Connected', setup: 'Needs setup', error: 'Error', paused: 'Paused' };
export const STATE_TONE = { connected: 'ok', setup: 'warn', error: 'err', paused: 'muted' } as const;
