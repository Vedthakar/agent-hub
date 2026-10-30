import type { AgentId } from '../../shared/types.js';
import type { HubConfig } from '../config.js';
import type { Store, TaskRow } from '../store.js';
import type { Transports } from '../transports/index.js';

export interface AdapterContext {
  store: Store;
  cfg: HubConfig;
  transports: Transports;
}

export interface Delivery {
  ok: boolean;
  /** Human-readable note for the audit log ("emailed instinct@...", "queued in MCP inbox"). */
  detail: string;
  /** Transport reference (e.g. email Message-ID) used to match bounces back to the task. */
  ref?: string;
  /** False for failures retrying can't fix (not configured); these dead-letter immediately. */
  retryable?: boolean;
}

export interface Capabilities {
  /** What the router reads to decide whether this agent is the right target for a task. */
  profile: string;
  /** How the hub learns what happened with this agent. */
  readVia: 'mcp' | 'imessage' | 'telegram' | 'email';
  /** How the hub hands work / context to this agent. */
  deliverVia: 'mcp-inbox' | 'email' | 'telegram' | 'imessage';
  canReceiveTasks: boolean;
}

/**
 * One file per agent: `{ id, readEvents(), deliverContext(), triggerTask(), capabilities }`.
 * Adding a new agent to the hub means implementing this interface and registering it in adapters/index.ts.
 */
export interface Adapter {
  id: AgentId;
  name: string;
  capabilities: Capabilities;
  /**
   * Pull-based read path (Telegram polling, IMAP). Returns the number of new messages ingested.
   * Agents whose reads are pushed (Mac daemon, MCP) return 0.
   */
  readEvents(ctx: AdapterContext): Promise<number>;
  /** Silent context delivery (e.g. the nightly digest). Never posts into a thread the user personally chats in. */
  deliverContext(ctx: AdapterContext, digest: { subject: string; body: string }): Promise<Delivery>;
  /** Hand a task to the agent, with a compact, scope-filtered context block. */
  triggerTask(ctx: AdapterContext, task: TaskRow, context: string[]): Promise<Delivery>;
  /** Handles the Mac daemon should watch for this agent (iMessage-read agents only). */
  imessageHandles?(cfg: HubConfig): string[];
  /** Static configuration check shown on the dashboard and /health. */
  configured(cfg: HubConfig): { ok: boolean; note: string };
}

export const NO_PULL_READS = async (): Promise<number> => 0;

export function composeTaskMessage(ownerName: string, agentName: string, task: TaskRow, context: string[]): string {
  const lines = [
    `Hi ${agentName} — this is ${ownerName}'s agent hub, writing on ${ownerName}'s behalf.`,
    '',
    `Task [${task.code}]: ${task.payload}`,
  ];
  if (context.length) {
    lines.push('', 'Relevant context:', ...context.map((c) => `- ${c}`));
  }
  return lines.join('\n');
}

export const notConfigured = (detail: string): Delivery => ({ ok: false, detail, retryable: false });
