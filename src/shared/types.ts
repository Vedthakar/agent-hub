/** The built-in agents. Custom agents added from the dashboard get `custom-<slug>` ids. */
export const AGENT_IDS = ['claude', 'chatgpt', 'gemini', 'instinct', 'stanley', 'boardy', 'grok'] as const;
export type BuiltinAgentId = (typeof AGENT_IDS)[number];
export type CustomAgentId = `custom-${string}`;
export type AgentId = BuiltinAgentId | CustomAgentId;

export const CUSTOM_AGENT_ID = /^custom-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const customIds = new Set<CustomAgentId>();

/** Replaces the registered custom agents (loaded from the hub's settings). */
export function setCustomAgentIds(ids: readonly string[]): void {
  customIds.clear();
  for (const id of ids) if (CUSTOM_AGENT_ID.test(id)) customIds.add(id as CustomAgentId);
}

/** Every agent the hub knows about: built-ins first, then custom agents in creation order. */
export function agentIds(): AgentId[] {
  return [...AGENT_IDS, ...customIds];
}

export function isBuiltinAgent(value: unknown): value is BuiltinAgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

export function isAgentId(value: unknown): value is AgentId {
  return isBuiltinAgent(value) || (typeof value === 'string' && customIds.has(value as CustomAgentId));
}

export type Author = 'user' | 'agent' | 'hub';
export type Autonomy = 'notify' | 'ask' | 'auto';
export type TaskStatus = 'proposed' | 'approved' | 'rejected' | 'blocked' | 'sent' | 'done' | 'failed' | 'cancelled' | 'expired';

/** Topic vocabulary used for scoping. Keep it small so the router tags consistently. */
export const TOPICS = [
  'plan',
  'schedule',
  'school',
  'projects',
  'work',
  'open_source',
  'content',
  'shoots',
  'professional',
  'networking',
  'health',
  'finances',
  'personal',
  'general',
] as const;
export type Topic = (typeof TOPICS)[number];

/** Payload the Mac daemon ships for each new chat.db row it is allowed to forward. */
export interface DaemonMessage {
  guid: string;
  rowid: number;
  handle: string;
  isFromMe: boolean;
  text: string;
  sentAt: string;
  service: string;
}

export interface DaemonConfig {
  /** Handles (phone / email) whose threads the daemon may read. */
  watchHandles: string[];
  /** Handle the approval texts go to / come from, if iMessage is the approval channel. */
  approvalHandle: string | null;
  pollIntervalMs: number;
  paused: boolean;
}

export interface OutboxItem {
  id: number;
  toHandle: string;
  body: string;
}
