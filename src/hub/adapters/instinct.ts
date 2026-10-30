import { NO_PULL_READS, composeTaskMessage, notConfigured, type Adapter } from './types.js';

/**
 * Instinct: personal chief of staff on iMessage. Reads come from the Mac daemon. Context and tasks go to
 * Instinct's own forwarding email address, so nothing lands in the user's iMessage thread. Writing into
 * that thread is only possible with ALLOW_THREAD_FALLBACK=1, and then only one compact message at the
 * moment Instinct has to act (tasks), never digests.
 */
export const instinct: Adapter = {
  id: 'instinct',
  name: 'Instinct',
  capabilities: {
    profile:
      "Personal chief of staff. Runs the nightly debrief and plans tomorrow. Owns the user's schedule, priorities, reminders and personal logistics.",
    readVia: 'imessage',
    deliverVia: 'email',
    canReceiveTasks: true,
  },
  imessageHandles: (cfg) => (cfg.imessageHandles.instinct ? [cfg.imessageHandles.instinct] : []),
  readEvents: NO_PULL_READS,

  async deliverContext(ctx, digest) {
    if (!ctx.cfg.instinctEmail || !ctx.transports.email) {
      return notConfigured('no side channel for Instinct (set INSTINCT_EMAIL + SMTP); digest held');
    }
    const { messageId } = await ctx.transports.email.send({ to: ctx.cfg.instinctEmail, subject: digest.subject, text: digest.body });
    return { ok: true, detail: `emailed digest to ${ctx.cfg.instinctEmail}`, ref: messageId };
  },

  async triggerTask(ctx, task, context) {
    const body = composeTaskMessage(ctx.cfg.ownerName, 'Instinct', task, context);
    if (ctx.cfg.instinctEmail && ctx.transports.email) {
      const { messageId } = await ctx.transports.email.send({
        to: ctx.cfg.instinctEmail,
        subject: `Task [${task.code}] from ${ctx.cfg.ownerName}'s hub`,
        text: body,
      });
      return { ok: true, detail: `emailed task to ${ctx.cfg.instinctEmail}`, ref: messageId };
    }
    const handle = ctx.cfg.imessageHandles.instinct;
    if (!ctx.cfg.allowThreadFallback || !handle) {
      return notConfigured('no side channel for Instinct (set INSTINCT_EMAIL + SMTP, or opt in with ALLOW_THREAD_FALLBACK=1)');
    }
    await ctx.transports.imessage.send(handle, body, 'delivery', task.id);
    return { ok: true, detail: 'queued one compact message in the Instinct thread (ALLOW_THREAD_FALLBACK)' };
  },

  configured(cfg) {
    const email = Boolean(cfg.instinctEmail && cfg.email.smtpUrl && cfg.email.from);
    const read = Boolean(cfg.imessageHandles.instinct);
    return {
      ok: read && email,
      note: [
        read ? 'reads via iMessage daemon' : 'set IMESSAGE_HANDLES=instinct:<handle>',
        email ? 'delivers via email' : cfg.allowThreadFallback ? 'no email: thread fallback enabled' : 'no email: deliveries held',
      ].join('; '),
    };
  },
};
