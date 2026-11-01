import type { AgentId, BuiltinAgentId } from '../../shared/types.js';

export type ConnectKind = 'mcp' | 'imessage' | 'webhook' | 'custom';

export interface AgentMeta {
  color: string;
  tagline: string;
  kind: ConnectKind;
  /** The app the owner opens to connect it (for MCP agents). */
  app?: string;
}

export const AGENT_META: Record<BuiltinAgentId, AgentMeta> = {
  claude: { color: '#d97757', tagline: 'Deep work, writing and coding help', kind: 'mcp', app: 'Claude' },
  chatgpt: { color: '#10a37f', tagline: 'General assistant', kind: 'mcp', app: 'ChatGPT' },
  gemini: { color: '#4285f4', tagline: 'Google assistant', kind: 'mcp', app: 'Gemini' },
  instinct: { color: '#8b5cf6', tagline: 'Chief of staff: debriefs, schedule, reminders', kind: 'imessage' },
  stanley: { color: '#f59e0b', tagline: 'Content: ideas, scripts, shoots', kind: 'imessage' },
  boardy: { color: '#0ea5e9', tagline: 'Networking: warm intros', kind: 'imessage' },
  grok: { color: '#3f3f46', tagline: 'Autonomous operator for work projects', kind: 'webhook' },
};

const CUSTOM_COLORS = ['#64748b', '#db2777', '#0d9488', '#7c3aed', '#ea580c', '#2563eb'];

export function metaFor(agent: AgentId): AgentMeta {
  if (agent in AGENT_META) return AGENT_META[agent as BuiltinAgentId];
  let n = 0;
  for (const c of agent) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return { color: CUSTOM_COLORS[n % CUSTOM_COLORS.length], tagline: 'Custom agent', kind: 'custom' };
}
