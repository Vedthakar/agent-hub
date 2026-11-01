import type { CustomAgentId } from '../../shared/types.js';
import { signWebhook } from './grok.js';
import { NO_PULL_READS, type Adapter } from './types.js';

export interface CustomAgentDef {
  id: CustomAgentId;
  name: string;
  /** What the router reads to decide whether this agent is the right target. */
  profile: string;
  createdAt: string;
}

/**
 * An agent added from the dashboard. Like Grok Bot it connects over MCP (OAuth or its own static token)
 * or the signed webhook at /hooks/<id>, and pulls its tasks from the MCP inbox. An optional nudge URL
 * gets a signed ping carrying only the task code.
 */
export function customAgent(def: CustomAgentDef): Adapter {
  return {
    id: def.id,
    name: def.name,
    capabilities: { profile: def.profile, readVia: 'mcp', deliverVia: 'mcp-inbox', canReceiveTasks: true },
    readEvents: NO_PULL_READS,
    async deliverContext() {
      return { ok: true, detail: `available to ${def.name} via get_situation` };
    },
    async triggerTask(ctx, task) {
      const hook = ctx.cfg.agentWebhooks[def.id];
      if (!hook?.url) return { ok: true, detail: `queued in ${def.name}'s inbox as [${task.code}]` };
      const body = JSON.stringify({ type: 'task', code: task.code });
      const ts = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-hub-timestamp': ts };
      if (hook.secret) headers['x-hub-signature'] = signWebhook(hook.secret, ts, body);
      const res = await fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { ok: false, detail: `webhook ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
      return { ok: true, detail: 'queued in inbox and pinged webhook' };
    },
    configured(cfg) {
      const token = Boolean(cfg.agentTokens[def.id]);
      const hook = Boolean(cfg.agentWebhooks[def.id]?.secret);
      return {
        ok: true,
        note: [token ? 'static token' : '', hook ? 'signed webhook' : '', 'OAuth at /mcp'].filter(Boolean).join('; '),
      };
    },
  };
}
