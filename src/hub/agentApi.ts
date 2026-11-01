import { agentIds, isAgentId, type AgentId } from '../shared/types.js';
import { ADAPTERS } from './adapters/index.js';
import type { Hub } from './hub.js';
import { cleanTopics } from './router.js';
import type { TaskRow } from './store.js';
import { REPLY_ATTRIBUTION_WINDOW_MS, proposeTask } from './tasks.js';

/**
 * What an agent can do once authenticated, shared by the MCP tools and the signed webhook (/hooks/:agent).
 * Every entry point passes the caller's identity from its credential, never from the request body.
 */

/**
 * The task chain a call belongs to. A `task_code` only counts if the task was sent to this agent, and the
 * agent's most recent hub task counts even if it leaves the code out: the higher hop wins, so an agent
 * can't reset loop protection by omitting or faking the code.
 */
export async function chainFor(hub: Hub, agent: AgentId, code: string | undefined): Promise<TaskRow | undefined> {
  const claimed = code ? await hub.store.taskByCode(code) : undefined;
  const own = claimed && claimed.target_agent === agent && claimed.sent_at ? claimed : undefined;
  const recent = await hub.store.lastTaskSentTo(agent, REPLY_ATTRIBUTION_WINDOW_MS);
  return [own, recent].filter((t) => t !== undefined).sort((a, b) => b.hop - a.hop)[0];
}

export interface LogSessionArgs {
  summary: string;
  decisions?: string[];
  transcript_excerpt?: string;
  topics?: string[];
  task_code?: string;
}

export async function logSession(hub: Hub, agent: AgentId, args: LogSessionArgs): Promise<{ eventId: number }> {
  const task = await chainFor(hub, agent, args.task_code);
  // The agent's own words are kept verbatim; the router later replaces `summary` with its own reading.
  const raw = [
    `Agent's summary: ${args.summary}`,
    args.transcript_excerpt ?? '',
    args.decisions?.length ? `Decisions:\n${args.decisions.map((d) => `- ${d}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const event = await hub.store.insertEvent({
    agent,
    occurredAt: new Date(),
    author: 'agent',
    rawExcerpt: raw,
    summary: args.summary,
    topics: args.topics ? cleanTopics(args.topics) : [],
    kind: 'session',
    causedByTaskId: task?.id ?? null,
    hop: task?.hop ?? 0,
  });
  await hub.store.touchRead(agent);
  hub.kick();
  return { eventId: event.id };
}

export async function inbox(hub: Hub, agent: AgentId) {
  const tasks = await hub.store.inbox(agent);
  await hub.store.markFetched(tasks.map((t) => t.id));
  return tasks;
}

export interface ProposeArgs {
  target_agent: string;
  task: string;
  reason?: string;
  user_requested?: boolean;
  topics?: string[];
  task_code?: string;
}

export async function propose(hub: Hub, agent: AgentId, args: ProposeArgs): Promise<{ ok: boolean; message: string; code?: string }> {
  const { cfg } = hub;
  if (!isAgentId(args.target_agent)) return { ok: false, message: `Rejected: unknown agent ${args.target_agent}.` };
  const me = ADAPTERS[agent].name;
  const parent = await chainFor(hub, agent, args.task_code);
  const outcome = await proposeTask(
    hub.store,
    {
      originAgent: agent,
      targetAgent: args.target_agent,
      payload: args.task,
      rationale: [args.reason ?? '', args.user_requested ? `${me} says ${cfg.ownerName} asked for this.` : ''].filter(Boolean).join(' '),
      topics: cleanTopics(args.topics ?? []),
      // An agent's claim that the user asked can't be verified, so agent proposals always need approval.
      author: 'agent',
      originEventId: null,
      hop: (parent?.hop ?? 0) + 1,
    },
    cfg.router.maxHops,
  );
  hub.kick();
  switch (outcome.kind) {
    case 'created':
      return { ok: true, message: `Proposed as [${outcome.task.code}]. ${cfg.ownerName} will be asked to approve it.`, code: outcome.task.code };
    case 'duplicate':
      return { ok: true, message: `Already proposed as [${outcome.existing.code}] (${outcome.existing.status}).`, code: outcome.existing.code };
    case 'blocked':
      return { ok: true, message: `Blocked: ${outcome.reason}.` };
    case 'invalid':
      return { ok: false, message: `Rejected: ${outcome.reason}.` };
  }
}

export interface UpdateTaskArgs {
  task_code: string;
  status: 'done' | 'failed';
  result?: string;
}

export async function updateTask(hub: Hub, agent: AgentId, args: UpdateTaskArgs): Promise<{ ok: boolean; message: string }> {
  const { store } = hub;
  const me = ADAPTERS[agent].name;
  const task = await store.taskByCode(args.task_code);
  if (!task || task.target_agent !== agent) return { ok: false, message: 'No such task in your inbox.' };
  const updated = await store.transitionTask(task.id, ['sent'], args.status, { result: args.result ?? null });
  if (!updated) return { ok: false, message: `Task is ${task.status}; nothing changed.` };
  await store.insertEvent({
    agent,
    occurredAt: new Date(),
    author: 'agent',
    rawExcerpt: args.result ?? '',
    summary: `${me} ${args.status === 'done' ? 'completed' : 'could not complete'} [${task.code}]: ${task.payload}${args.result ? ` — ${args.result}` : ''}`,
    topics: task.topics,
    kind: 'task_result',
    causedByTaskId: task.id,
    hop: task.hop,
  });
  await store.audit(agent, `task.${args.status}`, { code: task.code, result: args.result ?? null });
  hub.kick();
  return { ok: true, message: `[${task.code}] marked ${args.status}.` };
}

/** Agents this one may hand work to, with their profiles (for tool descriptions). */
export function otherAgents(agent: AgentId): string {
  return agentIds()
    .filter((a) => a !== agent && ADAPTERS[a]?.capabilities.canReceiveTasks)
    .map((a) => `${a} (${ADAPTERS[a].capabilities.profile})`)
    .join('; ');
}
