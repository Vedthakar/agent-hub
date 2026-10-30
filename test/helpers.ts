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

export async function makeHub(env: Record<string, string> = {}, llm: Llm | null = fakeLlm(), overrides: Partial<Transports> = {}) {
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
  const db = await openDb({ databaseUrl: null, pgliteDir: null });
  const store = new Store(db);
  await store.ensureDefaultScopes();
  const email = fakeEmail();
  const transports: Transports = { ...createTransports(cfg, store), email, ...overrides };
  const hub = new Hub(store, cfg, transports, llm);
  return { hub, store, cfg, db, llm: llm as FakeLlm, email, transports };
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
