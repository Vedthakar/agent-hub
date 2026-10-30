import { log } from '../shared/log.js';
import { ADAPTERS } from './adapters/index.js';
import type { AdapterContext, Delivery } from './adapters/types.js';
import type { Approvals } from './approvals.js';
import { compactContextFor } from './context.js';
import { checkDelivery } from './guard.js';
import { backoffMs } from './llm.js';
import type { TaskRow } from './store.js';

/**
 * Delivers approved tasks. Every task passes the deterministic scope guard here, at the delivery layer,
 * regardless of what the router or the approval step decided. The paused flag is re-read before each task
 * so "pause hub" takes effect within the current cycle.
 */
export async function dispatchApproved(ctx: AdapterContext, approvals: Approvals, now = new Date()): Promise<number> {
  const { store, cfg } = ctx;
  let sent = 0;
  for (const task of await store.dispatchable(now)) {
    if (await store.isPaused()) break;
    const adapter = ADAPTERS[task.target_agent];
    const scope = await store.scope(task.target_agent);
    const guard = checkDelivery(scope, adapter.name, task, await compactContextFor(store, task.target_agent));
    if (!guard.ok) {
      const blocked = await store.transitionTask(task.id, ['approved'], 'blocked', { reason: `delivery guard: ${guard.reason}` });
      if (blocked) {
        await store.audit('guard', 'task.blocked_at_delivery', { code: task.code, target: task.target_agent, reason: guard.reason });
        await approvals.notifyUser(`Blocked ${task.code} to ${adapter.name}: ${guard.reason}.`);
      }
      continue;
    }

    let res: Delivery;
    try {
      res = await adapter.triggerTask(ctx, task, guard.context);
    } catch (err) {
      res = { ok: false, detail: err instanceof Error ? err.message : String(err), retryable: true };
    }

    if (res.ok) {
      const updated = await store.transitionTask(task.id, ['approved'], 'sent', { reason: res.detail });
      if (updated && res.ref) await store.setDeliveryRef(task.id, res.ref);
      await store.touchDelivery(task.target_agent);
      await store.audit('hub', 'task.sent', { code: task.code, target: task.target_agent, detail: res.detail });
      sent++;
      continue;
    }
    await onDeliveryFailure(ctx, approvals, task, res);
  }
  return sent;
}

async function onDeliveryFailure(ctx: AdapterContext, approvals: Approvals, task: TaskRow, res: Delivery) {
  const { store, cfg } = ctx;
  const attempt = task.attempts + 1;
  await store.touchDelivery(task.target_agent, res.detail);
  log.warn('task.delivery_failed', { code: task.code, target: task.target_agent, attempt, error: res.detail });
  await store.audit('hub', 'task.delivery_failed', { code: task.code, target: task.target_agent, detail: res.detail, attempt });

  // Not-configured failures are retried slowly (the user may fix config), others with exponential backoff.
  const exhausted = attempt >= cfg.delivery.maxAttempts;
  if (exhausted) {
    const failed = await store.transitionTask(task.id, ['approved'], 'failed', { reason: res.detail });
    if (failed) {
      await store.addDeadLetter({ kind: 'delivery', refId: task.id, agent: task.target_agent, reason: res.detail, attempts: attempt });
      await approvals.notifyUser(`Couldn't deliver ${task.code} to ${ADAPTERS[task.target_agent].name} after ${attempt} tries (${res.detail}). It's in the dashboard's dead-letter queue.`);
    }
    return;
  }
  const base = res.retryable === false ? Math.max(cfg.delivery.baseBackoffMs, 15 * 60_000) : cfg.delivery.baseBackoffMs;
  await store.scheduleRetry(task.id, res.detail, new Date(Date.now() + backoffMs(attempt, base)));
}
