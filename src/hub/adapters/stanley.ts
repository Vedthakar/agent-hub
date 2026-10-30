import { TelegramFloodWait } from '../transports/telegramUser.js';
import { composeTaskMessage, notConfigured, type Adapter } from './types.js';

const LAST_ID_KEY = 'stanley.telegram.lastId';
const HUB_IDS_KEY = 'stanley.telegram.hubIds';
const FLOOD_UNTIL_KEY = 'stanley.telegram.floodUntil';

/**
 * Stanley (Stan): content agent. The user chats with Stan on iMessage; the hub uses a separate Telegram
 * thread with Stan, so tasks never show up in the user's own conversation. Stan's web app has no API,
 * so there is no web fallback: without Telegram, tasks are held and surfaced in health.
 */
export const stanley: Adapter = {
  id: 'stanley',
  name: 'Stanley',
  capabilities: {
    profile: 'Content strategist: video ideas, scripts, hooks, posting plans, and scheduling for shoots.',
    readVia: 'imessage',
    deliverVia: 'telegram',
    canReceiveTasks: true,
  },
  imessageHandles: (cfg) => (cfg.imessageHandles.stanley ? [cfg.imessageHandles.stanley] : []),

  async readEvents(ctx) {
    const tg = ctx.transports.telegramUser;
    if (!tg) return 0;
    const floodUntil = await ctx.store.getSetting<number>(FLOOD_UNTIL_KEY, 0);
    if (Date.now() < floodUntil) return 0;
    const lastId = await ctx.store.getSetting<number | null>(LAST_ID_KEY, null);
    let msgs;
    try {
      msgs = await tg.fetchSince(lastId ?? 0);
    } catch (err) {
      if (err instanceof TelegramFloodWait) {
        await ctx.store.setSetting(FLOOD_UNTIL_KEY, Date.now() + err.seconds * 1000);
        return 0;
      }
      throw err;
    }
    if (!msgs.length) {
      // An empty thread has no history to skip; without this the first real exchange would be.
      if (lastId === null) await ctx.store.setSetting(LAST_ID_KEY, 0);
      return 0;
    }
    if (lastId === null) {
      // First run: start from "now" rather than importing the whole chat history.
      await ctx.store.setSetting(LAST_ID_KEY, msgs[msgs.length - 1].id);
      return 0;
    }
    const hubIds = new Set(await ctx.store.getSetting<number[]>(HUB_IDS_KEY, []));
    const inserted = await ctx.store.insertRawMessages(
      msgs.map((m) => ({
        agent: 'stanley' as const,
        externalId: `tg:${m.id}`,
        channel: 'telegram',
        author: m.out ? (hubIds.has(m.id) ? ('hub' as const) : ('user' as const)) : ('agent' as const),
        text: m.text,
        sentAt: m.at,
      })),
    );
    await ctx.store.setSetting(LAST_ID_KEY, msgs[msgs.length - 1].id);
    if (inserted.length) await ctx.store.touchRead('stanley');
    return inserted.length;
  },

  async deliverContext() {
    // Stan only gets context bundled with a task, at the moment he has to act.
    return { ok: true, detail: 'held: Stanley receives context only with tasks' };
  },

  async triggerTask(ctx, task, context) {
    const tg = ctx.transports.telegramUser;
    if (!tg) return notConfigured('Telegram not configured for Stanley (TELEGRAM_* + STANLEY_TELEGRAM_PEER)');
    let id: number;
    try {
      id = await tg.send(composeTaskMessage(ctx.cfg.ownerName, 'Stan', task, context));
    } catch (err) {
      if (err instanceof TelegramFloodWait) return { ok: false, detail: err.message, retryable: true };
      throw err;
    }
    const hubIds = await ctx.store.getSetting<number[]>(HUB_IDS_KEY, []);
    await ctx.store.setSetting(HUB_IDS_KEY, [...hubIds, id].slice(-500));
    return { ok: true, detail: `sent to Stan on Telegram (msg ${id})`, ref: `tg:${id}` };
  },

  configured(cfg) {
    const tg = Boolean(cfg.stanley.apiId && cfg.stanley.apiHash && cfg.stanley.session && cfg.stanley.peer);
    return {
      ok: tg,
      note: [
        cfg.imessageHandles.stanley ? 'reads via iMessage daemon' : 'no iMessage handle',
        tg ? 'delivers + reads replies via Telegram' : 'Telegram not configured: tasks held',
      ].join('; '),
    };
  },
};
