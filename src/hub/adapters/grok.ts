import { createHmac } from 'node:crypto';
import { NO_PULL_READS, type Adapter } from './types.js';

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Grok Bot: runs in the cloud and operates apps like a person. It logs into the hub over MCP (static
 * token), pulls tasks with get_inbox, reports with log_session and closes tasks with update_task.
 * GROK_WEBHOOK_URL is an optional nudge so it doesn't have to poll. With GROK_WEBHOOK_SECRET set, every
 * call carries X-Hub-Timestamp and X-Hub-Signature (HMAC-SHA256 of "<timestamp>.<body>").
 * Feasibility spike: scripts/grok-spike.ts.
 */
export const grok: Adapter = {
  id: 'grok',
  name: 'Grok Bot',
  capabilities: {
    profile:
      'Autonomous operator for work/business projects: can operate apps and websites like a person (repos, project boards, posting, admin chores). Owns open-source work.',
    readVia: 'mcp',
    deliverVia: 'mcp-inbox',
    canReceiveTasks: true,
  },
  readEvents: NO_PULL_READS,

  async deliverContext() {
    return { ok: true, detail: 'available to Grok Bot via get_situation' };
  },

  async triggerTask(ctx, task) {
    if (!ctx.cfg.grokWebhookUrl) return { ok: true, detail: `queued in Grok Bot's MCP inbox as [${task.code}]` };
    // The nudge carries only the code; Grok fetches the payload over authenticated MCP.
    const body = JSON.stringify({ type: 'task', code: task.code });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-hub-timestamp': ts };
    if (ctx.cfg.grokWebhookSecret) headers['x-hub-signature'] = signWebhook(ctx.cfg.grokWebhookSecret, ts, body);
    const res = await fetch(ctx.cfg.grokWebhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, detail: `webhook ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
    return { ok: true, detail: 'queued in MCP inbox and pinged webhook' };
  },

  configured(cfg) {
    const notes = [cfg.agentTokens.grok ? 'static MCP token configured' : 'set HUB_AGENT_TOKENS=grok:<token>'];
    if (cfg.grokWebhookUrl && !cfg.grokWebhookSecret) notes.push('webhook is unsigned: set GROK_WEBHOOK_SECRET');
    return { ok: Boolean(cfg.agentTokens.grok), note: notes.join('; ') };
  },
};
