import type { AgentId, Author } from '../shared/types.js';
import { ADAPTERS } from './adapters/index.js';
import { checkDelivery } from './guard.js';
import { Store, type TaskRow } from './store.js';

export const DEDUP_WINDOW_MS = 24 * 3600_000;
/** Agent activity this soon after the hub sent it a task counts as part of that task's chain (hop count). */
export const REPLY_ATTRIBUTION_WINDOW_MS = 12 * 3600_000;

export type ProposeOutcome =
  | { kind: 'created'; task: TaskRow }
  | { kind: 'blocked'; task: TaskRow; reason: string }
  | { kind: 'duplicate'; existing: TaskRow }
  | { kind: 'invalid'; reason: string };

/**
 * The single entry point for new tasks, whether extracted by the router or proposed over MCP.
 * Enforces target validity, scopes, the hop limit and dedup before anything reaches the user.
 */
export async function proposeTask(
  store: Store,
  input: {
    originAgent: AgentId;
    targetAgent: AgentId;
    payload: string;
    rationale: string;
    topics: string[];
    author: Author;
    originEventId: number | null;
    hop: number;
  },
  maxHops: number,
): Promise<ProposeOutcome> {
  const target = ADAPTERS[input.targetAgent];
  if (!target) return { kind: 'invalid', reason: `unknown agent ${input.targetAgent}` };
  if (!target.capabilities.canReceiveTasks) return { kind: 'invalid', reason: `${target.name} cannot receive tasks` };
  if (input.targetAgent === input.originAgent) return { kind: 'invalid', reason: 'task targets its own origin agent' };
  const payload = input.payload.trim();
  if (!payload) return { kind: 'invalid', reason: 'empty task' };

  const existing = await store.findDuplicateTask(Store.dedupKey(input.targetAgent, payload), DEDUP_WINDOW_MS);
  if (existing) {
    await store.audit('hub', 'task.deduped', { existing: existing.code, target: input.targetAgent, payload });
    return { kind: 'duplicate', existing };
  }

  let blockReason: string | null = null;
  const scope = await store.scope(input.targetAgent);
  if (input.hop > maxHops) blockReason = `hop limit (${input.hop} > ${maxHops})`;
  else {
    const guard = checkDelivery(scope, target.name, { payload, topics: input.topics });
    if (!guard.ok) blockReason = guard.reason;
  }

  const task = await store.createTask({ ...input, payload, status: blockReason ? 'blocked' : 'proposed', statusReason: blockReason });
  await store.audit(input.originAgent, blockReason ? 'task.blocked' : 'task.proposed', {
    code: task.code,
    target: input.targetAgent,
    payload,
    hop: input.hop,
    author: input.author,
    reason: blockReason,
  });
  return blockReason ? { kind: 'blocked', task, reason: blockReason } : { kind: 'created', task };
}
