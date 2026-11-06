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
  claude: { color: '#a0755a', tagline: 'Deep work, writing and coding help', kind: 'mcp', app: 'Claude' },
  chatgpt: { color: '#6f7f68', tagline: 'General assistant', kind: 'mcp', app: 'ChatGPT' },
  gemini: { color: '#6d7a85', tagline: 'Google assistant', kind: 'mcp', app: 'Gemini' },
  instinct: { color: '#7d6b78', tagline: 'Chief of staff: debriefs, schedule, reminders', kind: 'imessage' },
  stanley: { color: '#a68a56', tagline: 'Content: ideas, scripts, shoots', kind: 'imessage' },
  boardy: { color: '#5f7f80', tagline: 'Networking: warm intros', kind: 'imessage' },
  grok: { color: '#4f4a44', tagline: 'Autonomous operator for work projects', kind: 'webhook' },
};

const CUSTOM_COLORS = ['#7a7264', '#8f6f63', '#66786c', '#7b7083', '#94785a', '#62747d'];

export function metaFor(agent: AgentId): AgentMeta {
  if (agent in AGENT_META) return AGENT_META[agent as BuiltinAgentId];
  let n = 0;
  for (const c of agent) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return { color: CUSTOM_COLORS[n % CUSTOM_COLORS.length], tagline: 'Custom agent', kind: 'custom' };
}
