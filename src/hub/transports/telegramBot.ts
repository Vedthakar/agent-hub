import type { HubConfig } from '../config.js';
import type { Store } from '../store.js';

export interface TelegramInbound {
  id: string;
  text: string;
  at: Date;
  /** Telegram user id of the sender. */
  fromId: string;
}

export interface TelegramBotTransport {
  send(text: string): Promise<void>;
  /** Replies in the approval chat. The offset is persisted so a restart never replays old replies. */
  poll(): Promise<TelegramInbound[]>;
}

const OFFSET_KEY = 'approval.telegram.offset';

/** The hub's own Telegram bot: an approval channel that is genuinely separate from every agent thread. */
export function createTelegramBot(cfg: HubConfig['approval'], store: Store): TelegramBotTransport | null {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return null;
  const base = `https://api.telegram.org/bot${cfg.telegramBotToken}`;
  const chatId = String(cfg.telegramChatId);
  return {
    async send(text) {
      const res = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`telegram sendMessage ${res.status}`);
    },
    async poll() {
      const offset = await store.getSetting<number>(OFFSET_KEY, 0);
      const res = await fetch(`${base}/getUpdates?timeout=0&offset=${offset}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`telegram getUpdates ${res.status}`);
      const body = (await res.json()) as {
        result: { update_id: number; message?: { message_id: number; date: number; text?: string; chat: { id: number }; from?: { id: number } } }[];
      };
      let next = offset;
      const out: TelegramInbound[] = [];
      for (const u of body.result) {
        next = Math.max(next, u.update_id + 1);
        const m = u.message;
        if (m?.text && String(m.chat.id) === chatId) {
          out.push({ id: `${m.chat.id}:${m.message_id}`, text: m.text, at: new Date(m.date * 1000), fromId: String(m.from?.id ?? '') });
        }
      }
      if (next !== offset) await store.setSetting(OFFSET_KEY, next);
      return out;
    },
  };
}
