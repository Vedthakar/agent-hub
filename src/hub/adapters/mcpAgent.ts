import type { AgentId } from '../../shared/types.js';
import { NO_PULL_READS, type Adapter, type Capabilities } from './types.js';

/**
 * Agents that connect to the hub's MCP server (Claude, ChatGPT, Gemini). They pull context with
 * get_situation and pull tasks with get_inbox, so "triggering" just makes the task visible in the inbox
 * and "delivering context" is a no-op: the next get_situation call returns it.
 */
export function mcpAgent(id: AgentId, name: string, profile: string, extra: Partial<Capabilities> = {}): Adapter {
  return {
    id,
    name,
    capabilities: { profile, readVia: 'mcp', deliverVia: 'mcp-inbox', canReceiveTasks: true, ...extra },
    readEvents: NO_PULL_READS,
    async deliverContext() {
      return { ok: true, detail: `available to ${name} via get_situation` };
    },
    async triggerTask(_ctx, task) {
      return { ok: true, detail: `queued in ${name}'s MCP inbox as [${task.code}]` };
    },
    configured(cfg) {
      const hasToken = Boolean(cfg.agentTokens[id]);
      return {
        ok: true,
        note: hasToken ? 'static token configured; OAuth also available' : 'connect via OAuth at /mcp',
      };
    },
  };
}
