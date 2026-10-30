import type { HubConfig } from '../config.js';

export interface TelegramUserTransport {
  /** Returns the Telegram message id so the hub can recognise its own messages when reading back. */
  send(text: string): Promise<number>;
  /** All messages in the peer's chat with id > `minId`, oldest first (paginated, no gaps). */
  fetchSince(minId: number): Promise<{ id: number; text: string; out: boolean; at: Date }[]>;
}

/** Telegram's FLOOD_WAIT: the server told us how long to back off. */
export class TelegramFloodWait extends Error {
  constructor(readonly seconds: number) {
    super(`Telegram FLOOD_WAIT ${seconds}s`);
  }
}

const PAGE = 100;
const MAX_PAGES = 20;

/**
 * Talks to an agent's Telegram bot as the user (MTProto). Bots can't message other bots, so the
 * Bot API can't be used here. Run `npm run telegram:login` once to produce TELEGRAM_SESSION.
 */
export function createTelegramUser(cfg: HubConfig['stanley']): TelegramUserTransport | null {
  if (!cfg.apiId || !cfg.apiHash || !cfg.session || !cfg.peer) return null;
  let clientPromise: Promise<import('telegram').TelegramClient> | null = null;

  function client() {
    clientPromise ??= (async () => {
      const { TelegramClient } = await import('telegram');
      const { StringSession } = await import('telegram/sessions/index.js');
      const c = new TelegramClient(new StringSession(cfg.session!), cfg.apiId!, cfg.apiHash!, { connectionRetries: 5 });
      c.setLogLevel('error' as never);
      await c.connect();
      return c;
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
    return clientPromise;
  }

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const seconds = (err as { seconds?: number }).seconds;
      if (typeof seconds === 'number') throw new TelegramFloodWait(seconds);
      // Connection-level failures: drop the client so the next call reconnects.
      clientPromise = null;
      throw err;
    }
  };

  return {
    send: (text) =>
      wrap(async () => {
        const sent = await (await client()).sendMessage(cfg.peer!, { message: text });
        return sent.id;
      }),
    fetchSince: (minId) =>
      wrap(async () => {
        const c = await client();
        const out: { id: number; text: string; out: boolean; at: Date }[] = [];
        let cursor = minId;
        for (let page = 0; page < MAX_PAGES; page++) {
          // reverse: oldest first starting after `cursor`, so a burst bigger than one page isn't truncated.
          const msgs = await c.getMessages(cfg.peer!, { limit: PAGE, minId: cursor, reverse: true });
          const batch = [...msgs].filter((m) => m.id > cursor).sort((a, b) => a.id - b.id);
          for (const m of batch) {
            if (typeof m.message === 'string' && m.message.length > 0) {
              out.push({ id: m.id, text: m.message, out: Boolean(m.out), at: new Date(m.date * 1000) });
            }
          }
          if (!batch.length) break;
          cursor = batch[batch.length - 1].id;
          if (batch.length < PAGE) break;
        }
        return out;
      }),
  };
}
