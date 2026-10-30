import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type HubConfig } from '../src/hub/config.js';
import { openDb } from '../src/hub/db.js';
import { Hub } from '../src/hub/hub.js';
import type { Llm } from '../src/hub/llm.js';
import { createApp } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';
import { createTransports, type Transports } from '../src/hub/transports/index.js';
import type { EmailTransport } from '../src/hub/transports/email.js';
import type { SmsTransport } from '../src/hub/transports/sms.js';
import type { TelegramUserTransport } from '../src/hub/transports/telegramUser.js';
import { backend, freshDatabase, type Backend } from './support/db.js';

export const HANDLES = {
  instinct: '+1 (555) 000-1111',
  stanley: '+15550002222',
  boardy: 'boardy@example.com',
  approval: '+15559990000',
};

export interface FakeLlm extends Llm {
  calls: { system: string; user: string }[];
  next: ((user: string) => unknown)[];
}

/** Returns queued responses in order; falls back to "summary only". */
export function fakeLlm(): FakeLlm {
  const llm: FakeLlm = {
    calls: [],
    next: [],
    async complete(system, user) {
      llm.calls.push({ system, user });
      const fn = llm.next.shift();
      return JSON.stringify(fn ? fn(user) : { summary: 'Nothing notable.', topics: ['general'] });
    },
  };
  return llm;
}

export interface FakeEmail extends EmailTransport {
  sent: { to: string; subject: string; text: string; messageId: string }[];
  /** Set to make the next sends throw (simulates an SMTP outage). */
  failWith: string | null;
}

export function fakeEmail(): FakeEmail {
  let n = 0;
  const mail: FakeEmail = {
    sent: [],
    failWith: null,
    async send(m) {
      if (mail.failWith) throw new Error(mail.failWith);
      const messageId = `<hub.test.${++n}@example.com>`;
      mail.sent.push({ ...m, messageId });
      return { messageId };
    },
  };
  return mail;
}

export const INSTINCT_EMAIL = 'ved.instinct@forward.example.com';

/** Stanley's Telegram chat, as the user's MTProto client sees it. `reply()` simulates Stan answering. */
export interface FakeTelegram extends TelegramUserTransport {
  chat: { id: number; text: string; out: boolean; at: Date }[];
  reply(text: string): void;
  failWith: string | null;
}

export function fakeTelegram(): FakeTelegram {
  let id = 0;
  const tg: FakeTelegram = {
    chat: [],
    failWith: null,
    reply(text) {
      tg.chat.push({ id: ++id, text, out: false, at: new Date() });
    },
    async send(text) {
      if (tg.failWith) throw new Error(tg.failWith);
      tg.chat.push({ id: ++id, text, out: true, at: new Date() });
      return id;
    },
    async fetchSince(minId) {
      return tg.chat.filter((m) => m.id > minId);
    },
  };
  return tg;
}

export interface FakeSms extends SmsTransport {
  sent: string[];
}

export function fakeSms(): FakeSms {
  const sms: FakeSms = {
    sent: [],
    async send(text) {
      sms.sent.push(text);
    },
  };
  return sms;
}

/** Stanley wired up (so config checks pass) but talking to `fakeTelegram()`. */
export const STANLEY_ENV = { TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'x', TELEGRAM_SESSION: 'x', STANLEY_TELEGRAM_PEER: '@stan' };

export async function makeHub(
  env: Record<string, string> = {},
  llm: Llm | null = fakeLlm(),
  overrides: Partial<Transports> = {},
  opts: { backend?: Backend } = {},
) {
  const cfg: HubConfig = loadConfig({
    HUB_OWNER_NAME: 'Ved',
    HUB_OWNER_PASSWORD: 'hunter2',
    HUB_DAEMON_TOKEN: 'daemon-token',
    HUB_AGENT_TOKENS: 'claude:claude-token,grok:grok-token,boardy:boardy-token',
    IMESSAGE_HANDLES: `instinct:${HANDLES.instinct},stanley:${HANDLES.stanley},boardy:${HANDLES.boardy}`,
    APPROVAL_IMESSAGE_HANDLE: HANDLES.approval,
    HUB_TIMEZONE: 'America/New_York',
    ROUTER_DEBOUNCE_MS: '600000',
    SMTP_URL: 'smtp://fake.invalid:25',
    EMAIL_FROM: 'ved@example.com',
    INSTINCT_EMAIL,
    ...env,
  });
  const which = opts.backend ?? backend();
  const fresh = which === 'supabase' ? await freshDatabase() : null;
  const raw = await openDb({ databaseUrl: fresh?.url ?? null, pgliteDir: null, maxConnections: 4 });
  const db = {
    ...raw,
    async close() {
      await raw.close();
      await fresh?.drop();
    },
  };
  const store = new Store(raw);
  await store.ensureDefaultScopes();
  const email = fakeEmail();
  const telegram = fakeTelegram();
  const sms = fakeSms();
  const transports: Transports = { ...createTransports(cfg, store), email, telegramUser: telegram, sms, telegramBot: null, imap: null, ...overrides };
  const hub = new Hub(store, cfg, transports, llm);
  return { hub, store, cfg, db, llm: llm as FakeLlm, email, telegram, sms, transports, backend: which, databaseUrl: fresh?.url ?? null };
}

export async function serve(hub: Hub) {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  // OAuth issuer / resource URLs must match the address clients actually hit, so bind first.
  hub.cfg.publicUrl = `http://localhost:${port}`;
  server.on('request', createApp(hub));
  return { url: `http://localhost:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let guid = 0;
export function msg(handle: string, text: string, opts: { fromMe?: boolean; at?: Date; guid?: string } = {}) {
  guid++;
  return {
    guid: opts.guid ?? `guid-${guid}`,
    rowid: guid,
    handle,
    isFromMe: opts.fromMe ?? false,
    text,
    sentAt: (opts.at ?? new Date()).toISOString(),
    service: 'iMessage',
  };
}

export const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
