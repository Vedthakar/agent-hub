import { setCustomAgentIds, type AgentId, type BuiltinAgentId } from '../../shared/types.js';
import type { Adapter } from './types.js';
import { claude } from './claude.js';
import { chatgpt } from './chatgpt.js';
import { gemini } from './gemini.js';
import { instinct } from './instinct.js';
import { stanley } from './stanley.js';
import { boardy } from './boardy.js';
import { grok } from './grok.js';
import { customAgent, type CustomAgentDef } from './custom.js';

export const BUILTIN_ADAPTERS: Record<BuiltinAgentId, Adapter> = { claude, chatgpt, gemini, instinct, stanley, boardy, grok };

/** Built-ins plus the custom agents registered from the dashboard. */
export const ADAPTERS: Record<AgentId, Adapter> = { ...BUILTIN_ADAPTERS };

export function adapter(id: AgentId): Adapter {
  return ADAPTERS[id];
}

export function registerCustomAgents(defs: readonly CustomAgentDef[]): void {
  for (const id of Object.keys(ADAPTERS)) if (!(id in BUILTIN_ADAPTERS)) delete ADAPTERS[id as AgentId];
  for (const d of defs) ADAPTERS[d.id] = customAgent(d);
  setCustomAgentIds(defs.map((d) => d.id));
}
