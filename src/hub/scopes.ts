import type { AgentId, Autonomy } from '../shared/types.js';

export interface Scope {
  agent: AgentId;
  allow_topics: string[];
  deny_topics: string[];
  autonomy: Autonomy;
  enabled: boolean;
}

const SENSITIVE = ['school', 'health', 'finances', 'personal'];

export const DEFAULT_SCOPES: Record<AgentId, Omit<Scope, 'agent'>> = {
  instinct: { allow_topics: ['*'], deny_topics: [], autonomy: 'ask', enabled: true },
  claude: { allow_topics: ['*'], deny_topics: [], autonomy: 'ask', enabled: true },
  chatgpt: { allow_topics: ['*'], deny_topics: [], autonomy: 'ask', enabled: true },
  gemini: { allow_topics: ['*'], deny_topics: [], autonomy: 'ask', enabled: true },
  boardy: { allow_topics: ['professional', 'networking'], deny_topics: SENSITIVE, autonomy: 'ask', enabled: true },
  stanley: { allow_topics: ['content', 'shoots'], deny_topics: SENSITIVE, autonomy: 'ask', enabled: true },
  grok: { allow_topics: ['work', 'open_source'], deny_topics: SENSITIVE, autonomy: 'ask', enabled: true },
};

/**
 * Deny wins over allow. Untagged items count as "general", which only wildcard agents can see,
 * so anything the router failed to classify stays private by default.
 */
export function canSee(scope: Scope | undefined, topics: string[]): boolean {
  if (!scope || !scope.enabled) return false;
  const tags = topics.length ? topics : ['general'];
  if (tags.some((t) => scope.deny_topics.includes(t))) return false;
  if (scope.allow_topics.includes('*')) return true;
  return tags.some((t) => scope.allow_topics.includes(t));
}
