import type { HubConfig } from '../config.js';
import type { Store } from '../store.js';
import { createEmail, type EmailTransport } from './email.js';
import { createImap, type ImapTransport } from './imap.js';
import { createSms, type SmsTransport } from './sms.js';
import { createTelegramUser, type TelegramUserTransport } from './telegramUser.js';
import { createTelegramBot, type TelegramBotTransport } from './telegramBot.js';

export interface IMessageTransport {
  /** Queues a message for the Mac daemon to send through Messages.app. */
  send(toHandle: string, body: string, purpose: 'approval' | 'delivery' | 'notice', taskId?: number | null): Promise<void>;
}

export interface Transports {
  email: EmailTransport | null;
  imap: ImapTransport | null;
  imessage: IMessageTransport;
  telegramUser: TelegramUserTransport | null;
  telegramBot: TelegramBotTransport | null;
  sms: SmsTransport | null;
}

export function createTransports(cfg: HubConfig, store: Store): Transports {
  return {
    email: createEmail(cfg.email),
    imap: createImap(cfg.imap),
    imessage: {
      async send(toHandle, body, purpose, taskId) {
        await store.enqueueOutbox({ toHandle, body, purpose, taskId });
      },
    },
    telegramUser: createTelegramUser(cfg.stanley),
    telegramBot: createTelegramBot(cfg.approval, store),
    sms: createSms(cfg.approval.twilio),
  };
}
