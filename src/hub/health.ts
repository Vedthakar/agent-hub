import type { AgentId } from '../shared/types.js';
import { ADAPTERS } from './adapters/index.js';
import type { Hub } from './hub.js';

export type HealthState = 'ok' | 'degraded' | 'down' | 'unconfigured' | 'disabled';

export interface AdapterHealth {
  agent: AgentId;
  name: string;
  state: HealthState;
  configured: boolean;
  note: string;
  enabled: boolean;
  lastReadAt: Date | null;
  lastDeliveryAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  queued: number;
  retrying: number;
  failed24h: number;
  awaitingApproval: number;
}

export interface HubHealth {
  state: HealthState;
  paused: boolean;
  lastTick: Hub['lastTick'];
  daemon: { state: HealthState; lastSeenAt: string | null; lastRowId: number | null; error: string | null };
  deadLetters: number;
  pendingApprovals: number;
  adapters: AdapterHealth[];
}

const DAEMON_STALE_MS = 2 * 60_000;
const ERROR_FRESH_MS = 3600_000;

export async function adapterHealth(hub: Hub): Promise<AdapterHealth[]> {
  const { store, cfg } = hub;
  const [statuses, scopes, queue] = await Promise.all([store.agentStatuses(), store.scopes(), store.deliveryQueue()]);
  return Object.values(ADAPTERS).map((a) => {
    const st = statuses.get(a.id);
    const q = queue.get(a.id) ?? { queued: 0, retrying: 0, failed24h: 0, awaitingApproval: 0 };
    const conf = a.configured(cfg);
    const enabled = scopes.get(a.id)?.enabled ?? false;
    const errAt = st?.last_error_at ? new Date(st.last_error_at) : null;
    const okAt = Math.max(st?.last_delivery_at ? new Date(st.last_delivery_at).getTime() : 0, st?.last_read_at ? new Date(st.last_read_at).getTime() : 0);
    const recentError = errAt && Date.now() - errAt.getTime() < ERROR_FRESH_MS && errAt.getTime() > okAt;
    let state: HealthState = 'ok';
    if (!enabled) state = 'disabled';
    else if (!conf.ok) state = 'unconfigured';
    else if (q.failed24h > 0 && q.retrying > 0) state = 'down';
    else if (recentError || q.retrying > 0) state = 'degraded';
    return {
      agent: a.id,
      name: a.name,
      state,
      configured: conf.ok,
      note: conf.note,
      enabled,
      lastReadAt: st?.last_read_at ?? null,
      lastDeliveryAt: st?.last_delivery_at ?? null,
      lastErrorAt: errAt,
      lastError: st?.last_error ?? null,
      ...q,
    };
  });
}

export async function hubHealth(hub: Hub): Promise<HubHealth> {
  const { store } = hub;
  const hb = await store.getSetting<{ at: string; lastRowId: number; error: string | null } | null>('daemon.heartbeat', null);
  const daemonState: HealthState = !hb ? 'unconfigured' : Date.now() - new Date(hb.at).getTime() > DAEMON_STALE_MS ? 'down' : hb.error ? 'degraded' : 'ok';
  const adapters = await adapterHealth(hub);
  const deadLetters = (await store.openDeadLetters(1000)).length;
  const pendingApprovals = (await store.tasksByStatus(['proposed'], 1000)).filter((t) => t.approval_sent_at).length;
  const tickOk = !hub.lastTick || (hub.lastTick.ok && Date.now() - hub.lastTick.at.getTime() < Math.max(5 * hub.cfg.router.tickMs, 120_000));
  const bad = adapters.some((a) => a.state === 'down') || daemonState === 'down' || !tickOk;
  const meh = adapters.some((a) => a.state === 'degraded') || daemonState === 'degraded' || deadLetters > 0;
  return {
    state: bad ? 'down' : meh ? 'degraded' : 'ok',
    paused: await store.isPaused(),
    lastTick: hub.lastTick,
    daemon: { state: daemonState, lastSeenAt: hb?.at ?? null, lastRowId: hb?.lastRowId ?? null, error: hb?.error ?? null },
    deadLetters,
    pendingApprovals,
    adapters,
  };
}

/** Public view: states only, no error text, notes, or counts that could leak activity. */
export function publicHealth(h: HubHealth) {
  return {
    state: h.state,
    paused: h.paused,
    daemon: h.daemon.state,
    adapters: Object.fromEntries(h.adapters.map((a) => [a.agent, a.state])),
  };
}
