import { backoffMs } from './llm.js';
import type { Store } from './store.js';
import type { InboundEmail } from './transports/imap.js';

/**
 * An SMTP server accepting a message isn't delivery. When a bounce quotes the Message-ID of a hub email,
 * the task goes back to `approved` with a backoff (or dead-letters once out of attempts).
 */
export async function handleBounces(store: Store, emails: InboundEmail[], opts: { maxAttempts: number; baseBackoffMs: number }): Promise<number> {
  let handled = 0;
  for (const m of emails) {
    for (const ref of m.refs) {
      const task = await store.taskByDeliveryRef(ref);
      if (!task || task.status !== 'sent') continue;
      const reason = `email bounced: ${m.subject.slice(0, 120)}`;
      await store.touchDelivery(task.target_agent, reason);
      if (task.attempts >= opts.maxAttempts) {
        await store.transitionTask(task.id, ['sent'], 'failed', { reason });
        await store.addDeadLetter({ kind: 'delivery', refId: task.id, agent: task.target_agent, reason, attempts: task.attempts });
      } else {
        await store.reopenForRetry(task.id, reason, new Date(Date.now() + backoffMs(task.attempts, opts.baseBackoffMs)));
      }
      await store.audit('hub', 'task.bounced', { code: task.code, target: task.target_agent, ref });
      handled++;
    }
  }
  return handled;
}
