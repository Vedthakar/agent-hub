import { ADAPTERS } from './adapters/index.js';
import type { AdapterContext } from './adapters/types.js';
import { buildDebriefDigest } from './context.js';
import { backoffMs } from './backoff.js';
import type { RawMessageRow } from './store.js';
import { localDateKey, startOfLocalDay } from './tz.js';

export const DEBRIEF_WINDOW_MS = 3 * 3600_000;
const MAX_DIGEST_ATTEMPTS = 5;

interface Pending {
  /** Set on a regular update, which doesn't count as the day's debrief. */
  scheduled?: boolean;
  date: string;
  startedAt: string;
  attempts: number;
  nextAt: number;
}

/** Called on ingest. Only records intent; the digest is sent from the tick so ingest stays fast. */
export async function noteDebriefStart(ctx: AdapterContext, msg: RawMessageRow): Promise<boolean> {
  const { store, cfg } = ctx;
  if (!cfg.debriefPattern.test(msg.text)) return false;
  const date = localDateKey(new Date(msg.sent_at), cfg.timezone);
  if ((await store.getSetting<string | null>('debrief.lastDate', null)) === date) return false;
  if ((await store.getSetting<Pending | null>('debrief.pending', null))?.date === date) return false;
  const startedAt = new Date(msg.sent_at).toISOString();
  await store.setSetting('debrief.startedAt', startedAt);
  await store.setSetting('debrief.pending', { date, startedAt, attempts: 0, nextAt: 0 } satisfies Pending);
  await store.audit('hub', 'debrief.started', { date });
  return true;
}

/**
 * Regular updates, so Instinct stays current even when it never hears the word "debrief". A time missed by more
 * than two hours (the Mac was asleep) is skipped instead of sent late.
 */
export async function scheduleDigest(ctx: AdapterContext, now = new Date()): Promise<boolean> {
  const { store, cfg, transports } = ctx;
  if (!cfg.instinctDigestTimes.length || !cfg.instinctEmail || !transports.email) return false;
  if ((await store.scope('instinct'))?.enabled === false || (await store.getSetting<Pending | null>('debrief.pending', null))) return false;
  const midnight = startOfLocalDay(now, cfg.timezone).getTime();
  const date = localDateKey(now, cfg.timezone);
  for (const time of cfg.instinctDigestTimes) {
    const [hour, minute] = time.split(':').map(Number);
    const at = midnight + (hour * 60 + minute) * 60_000;
    if (now.getTime() < at || now.getTime() - at > 2 * 3600_000) continue;
    const key = `${date}#${time}`;
    if ((await store.getSetting<string | null>('digest.lastSlot', null)) === key) continue;
    await store.setSetting('digest.lastSlot', key);
    await store.setSetting('debrief.pending', { date, startedAt: now.toISOString(), attempts: 0, nextAt: 0, scheduled: true } satisfies Pending);
    return true;
  }
  return false;
}

export async function debriefActive(ctx: AdapterContext, at: Date): Promise<boolean> {
  const started = await ctx.store.getSetting<string | null>('debrief.startedAt', null);
  if (!started) return false;
  const t = new Date(started).getTime();
  return at.getTime() >= t - 60_000 && at.getTime() - t < DEBRIEF_WINDOW_MS;
}

/** Sends a pending digest; retried with backoff, then dead-lettered. */
export async function processPendingDebrief(ctx: AdapterContext, routeFirst: () => Promise<unknown>, brainUrl: string | null = null): Promise<'sent' | 'none' | 'waiting' | 'failed' | 'paused'> {
  const { store, cfg } = ctx;
  const pending = await store.getSetting<Pending | null>('debrief.pending', null);
  if (!pending) return 'none';
  if (Date.now() < pending.nextAt) return 'waiting';
  if (await store.isPaused()) return 'paused';
  // Route anything still pending first so the digest includes the latest sessions.
  await routeFirst();
  const digest = await buildDebriefDigest(store, { ownerName: cfg.ownerName, tz: cfg.timezone, scheduled: pending.scheduled, brainUrl, replyTo: ctx.transports.imap ? cfg.email.from : null });
  let ok = false;
  let detail: string;
  try {
    const res = await ADAPTERS.instinct.deliverContext(ctx, digest);
    ok = res.ok;
    detail = res.detail;
  } catch (err) {
    detail = String(err);
  }
  await store.touchDelivery('instinct', ok ? undefined : detail);
  if (ok) {
    if (!pending.scheduled) await store.setSetting('debrief.lastDate', pending.date);
    await store.setSetting('debrief.pending', null);
    await store.audit('hub', 'debrief.digest_sent', { date: pending.date, detail });
    return 'sent';
  }
  const attempts = pending.attempts + 1;
  await store.audit('hub', 'debrief.digest_failed', { date: pending.date, detail, attempt: attempts });
  if (attempts >= MAX_DIGEST_ATTEMPTS) {
    await store.setSetting('debrief.pending', null);
    await store.addDeadLetter({ kind: 'digest', refId: null, agent: 'instinct', reason: detail, attempts });
    return 'failed';
  }
  await store.setSetting('debrief.pending', { ...pending, attempts, nextAt: Date.now() + backoffMs(attempts, 60_000) } satisfies Pending);
  return 'waiting';
}

/** Manual "send now" from the dashboard. */
export async function queueDigestNow(ctx: AdapterContext): Promise<void> {
  const date = localDateKey(new Date(), ctx.cfg.timezone);
  await ctx.store.setSetting('debrief.pending', { date, startedAt: new Date().toISOString(), attempts: 0, nextAt: 0 } satisfies Pending);
}
