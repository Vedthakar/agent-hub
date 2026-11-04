import { TOPICS, type AgentId, type Autonomy, type BuiltinAgentId } from '../shared/types.js';

export interface Scope {
  agent: AgentId;
  allow_topics: string[];
  deny_topics: string[];
  autonomy: Autonomy;
  enabled: boolean;
}

export const SENSITIVE = ['school', 'health', 'finances', 'personal'];

export const DEFAULT_SCOPES: Record<BuiltinAgentId, Omit<Scope, 'agent'>> = {
  instinct: { allow_topics: ['*'], deny_topics: [], autonomy: 'ask', enabled: true },
  claude: { allow_topics: ['*'], deny_topics: [], autonomy: 'ask', enabled: true },
  chatgpt: { allow_topics: ['*'], deny_topics: [], autonomy: 'ask', enabled: true },
  gemini: { allow_topics: ['*'], deny_topics: [], autonomy: 'ask', enabled: true },
  boardy: { allow_topics: ['professional', 'networking'], deny_topics: SENSITIVE, autonomy: 'ask', enabled: true },
  stanley: { allow_topics: ['content', 'shoots'], deny_topics: SENSITIVE, autonomy: 'ask', enabled: true },
  grok: { allow_topics: ['work', 'open_source'], deny_topics: SENSITIVE, autonomy: 'ask', enabled: true },
};

/** A custom agent starts narrow: only the topics picked when it was added, never anything sensitive. */
export function customDefaultScope(topics: string[]): Omit<Scope, 'agent'> {
  return { allow_topics: topics.filter((t) => !SENSITIVE.includes(t)), deny_topics: SENSITIVE, autonomy: 'ask', enabled: true };
}

/**
 * Categories an agent can never receive, whatever the stored scope says. Merged in code, so a scope edited
 * in the dashboard or the database (or a bug in either) can't open them up.
 */
export const HARD_DENY: Partial<Record<AgentId, readonly string[]>> = { boardy: SENSITIVE };

export function deniedTopics(scope: Scope): Set<string> {
  return new Set([...scope.deny_topics, ...(HARD_DENY[scope.agent] ?? [])]);
}

/**
 * Deny wins over allow. Untagged items count as "general", which only wildcard agents can see,
 * so anything the router failed to classify stays private by default.
 */
export function canSee(scope: Scope | undefined, topics: string[]): boolean {
  if (!scope || !scope.enabled) return false;
  const tags = topics.length ? topics : ['general'];
  const deny = deniedTopics(scope);
  if (tags.some((t) => deny.has(t))) return false;
  if (scope.allow_topics.includes('*')) return true;
  return tags.some((t) => scope.allow_topics.includes(t));
}

export function cleanTopics(topics: string[]): string[] {
  const valid = new Set<string>(TOPICS);
  const out = [...new Set(topics.map((t) => t.toLowerCase().trim()).filter((t) => valid.has(t)))];
  return out.length ? out : ['general'];
}
