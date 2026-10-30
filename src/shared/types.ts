export const AGENT_IDS = ['claude', 'chatgpt', 'gemini', 'instinct', 'stanley', 'boardy', 'grok'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
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
