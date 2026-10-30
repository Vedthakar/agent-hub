import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSmoke, type SmokeDeps, type SmokeTelegram } from '../../scripts/smoke.js';
import { HANDLES, INSTINCT_EMAIL, makeHub, serve } from '../helpers.js';

/** The live smoke script, with the outside world faked. The MCP check runs for real against a local hub. */

let hub: Awaited<ReturnType<typeof makeHub>>;
let http: Awaited<ReturnType<typeof serve>>;
beforeAll(async () => {
  hub = await makeHub({}, null, {}, { backend: 'pglite' });
  http = await serve(hub.hub);
});
afterAll(async () => {
  await http.close();
  await hub.db.close();
});

const ACCOUNTS: Record<string, { id: string; bot: boolean }> = {
  stan: { id: '100', bot: true },
  stanley_alias: { id: '100', bot: true },
  ved_test_bot: { id: '200', bot: true },
  some_person: { id: '300', bot: false },
};

function fakes() {
  const sent: { channel: string; to: string; text: string }[] = [];
  const telegram: SmokeTelegram = {
    async resolve(peer) {
      const a = ACCOUNTS[peer.replace(/^@/, '').toLowerCase()];
      if (!a) throw new Error(`no such peer ${peer}`);
      return a;
    },
    async send(peer, text) {
      sent.push({ channel: 'telegram', to: peer, text });
      return 42;
    },
    async readBack(_peer, id) {
      return id === 42;
    },
    async close() {},
  };
  const deps: SmokeDeps = {
    email: (cfg) => (cfg.smtpUrl && cfg.from ? { send: async (m) => (sent.push({ channel: 'email', to: m.to, text: m.text }), { messageId: '<m1@x>' }) } : null),
    telegram: (cfg) => (cfg.apiId && cfg.apiHash && cfg.session ? telegram : null),
    sms: (cfg) => (cfg.accountSid && cfg.authToken && cfg.from && cfg.userNumber ? { send: async (text) => void sent.push({ channel: 'sms', to: cfg.userNumber!, text }) } : null),
    telegramBot: async (_t, chatId, text) => void sent.push({ channel: 'telegram-bot', to: chatId, text }),
    imessage: async (handle, text) => void sent.push({ channel: 'imessage', to: handle, text }),
  };
  return { sent, deps };
}

const baseEnv = () => ({
  SMOKE_HUB_URL: http.url,
  HUB_OWNER_PASSWORD: 'hunter2',
  SMTP_URL: 'smtps://ved%40example.com:sup3rs3cret-pass@smtp.example.com:465',
  EMAIL_FROM: 'ved@example.com',
  SMOKE_EMAIL_TO: 'ved.personal@example.com',
  INSTINCT_EMAIL,
  BOARDY_EMAIL: 'boardy@boardy.ai',
  IMESSAGE_HANDLES: `instinct:${HANDLES.instinct},stanley:${HANDLES.stanley},boardy:${HANDLES.boardy}`,
  TELEGRAM_API_ID: '1',
  TELEGRAM_API_HASH: 'hash-value-123',
  TELEGRAM_SESSION: 'session-value-123',
  STANLEY_TELEGRAM_PEER: '@stan',
  SMOKE_TELEGRAM_PEER: '@ved_test_bot',
  TWILIO_ACCOUNT_SID: 'AC1',
  TWILIO_AUTH_TOKEN: 'twilio-auth-token',
  TWILIO_FROM_NUMBER: '+15550009999',
  APPROVAL_USER_NUMBER: '+15551112222',
});

async function run(env: Record<string, string>, opts: Parameters<typeof runSmoke>[2] = {}) {
  const f = fakes();
  const lines: string[] = [];
  const results = await runSmoke(env, f.deps, { ...opts, print: (l) => lines.push(l) });
  return { ...f, results, lines, byName: Object.fromEntries(results.map((r) => [r.name, r])) };
}

describe('smoke script', () => {
  it('runs all four checks, prints PASS for each, and messages only Ved', async () => {
    const r = await run(baseEnv());
    expect(r.lines.slice(1, 5).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual(['PASS mcp', 'PASS email', 'PASS telegram', 'PASS approval']);
    expect(r.lines.at(-1)).toBe('4/4 passed');
    expect(r.byName.mcp.detail).toMatch(/^OAuth as Claude → get_situation OK .*token revoked$/);
    expect(r.sent.map((s) => [s.channel, s.to])).toEqual([
      ['email', 'ved.personal@example.com'],
      ['telegram', '@ved_test_bot'],
      ['sms', '+15551112222'],
    ]);
    // The OAuth client it registered is the one Claude would use.
    const clients = await hub.store.db.query<{ agent: string | null }>('SELECT * FROM oauth_clients');
    expect(clients.length).toBeGreaterThan(0);
  });

  it('dry run sends nothing', async () => {
    const r = await run(baseEnv(), { dryRun: true });
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(r.sent).toEqual([]);
    expect(r.lines[0]).toContain('dry run');
  });

  it.each([
    ['Instinct’s forwarding address', { SMOKE_EMAIL_TO: INSTINCT_EMAIL }, 'email'],
    ['Instinct’s address, differently cased', { SMOKE_EMAIL_TO: `"Instinct" <${INSTINCT_EMAIL.toUpperCase()}>` }, 'email'],
    ['Boardy', { SMOKE_EMAIL_TO: 'boardy@boardy.ai' }, 'email'],
    ['any boardy.ai address', { SMOKE_EMAIL_TO: 'agents@boardy.ai' }, 'email'],
    ['Boardy’s iMessage email handle', { SMOKE_EMAIL_TO: HANDLES.boardy }, 'email'],
    ['Stanley’s Telegram peer', { SMOKE_TELEGRAM_PEER: 'stan' }, 'telegram'],
    ['an alias that resolves to Stanley', { SMOKE_TELEGRAM_PEER: '@stanley_alias' }, 'telegram'],
    ['a person instead of a bot', { SMOKE_TELEGRAM_PEER: '@some_person' }, 'telegram'],
    ['an agent’s phone number as the approval phone', { APPROVAL_USER_NUMBER: '5550002222' }, 'approval'],
  ])('refuses to message %s', async (_label, override, check) => {
    const r = await run({ ...baseEnv(), ...override } as Record<string, string>, { only: [check as 'email'] });
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].detail).toMatch(/^GUARD refusing/);
    expect(r.lines[1]).toMatch(/^\s+FAIL/);
    expect(r.sent).toEqual([]);
  });

  it('refuses an iMessage approval handle that belongs to an agent', async () => {
    const env = { ...baseEnv(), APPROVAL_CHANNEL: 'imessage', APPROVAL_IMESSAGE_HANDLE: HANDLES.instinct };
    const r = await run(env, { only: ['approval'] });
    expect(r.results[0].detail).toMatch(/GUARD refusing: .* agent's iMessage handle/);
    expect(r.sent).toEqual([]);
  });

  it('fails with a hint when something is not configured', async () => {
    const env: Record<string, string> = { SMOKE_HUB_URL: http.url, HUB_OWNER_PASSWORD: 'hunter2' };
    const r = await run(env);
    expect(r.byName.mcp.ok).toBe(true);
    expect(r.byName.email.detail).toMatch(/SMOKE_EMAIL_TO|SMTP_URL/);
    expect(r.byName.telegram.detail).toMatch(/SMOKE_TELEGRAM_PEER/);
    expect(r.byName.approval.detail).toMatch(/no approval channel/);
    expect(r.lines.at(-1)).toBe('1/4 passed');
  });

  it('fails the MCP check on a wrong owner password, and on an unreachable hub', async () => {
    expect((await run({ ...baseEnv(), HUB_OWNER_PASSWORD: 'nope' }, { only: ['mcp'] })).results[0].detail).toMatch(/consent failed: 401/);
    expect((await run({ ...baseEnv(), SMOKE_HUB_URL: 'http://127.0.0.1:9' }, { only: ['mcp'] })).results[0].ok).toBe(false);
  });

  it('never prints secrets from failing transports', async () => {
    const f = fakes();
    f.deps.email = () => ({
      send: async () => {
        throw new Error('connect failed smtps://ved%40example.com:sup3rs3cret-pass@smtp.example.com:465 token=twilio-auth-token');
      },
    });
    const lines: string[] = [];
    await runSmoke(baseEnv(), f.deps, { only: ['email'], print: (l) => lines.push(l) });
    expect(lines.join('\n')).not.toMatch(/sup3rs3cret|twilio-auth-token/);
  });
});
