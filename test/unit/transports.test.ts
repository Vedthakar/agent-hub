import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grok, signWebhook } from '../../src/hub/adapters/grok.js';
import { createTelegramBot } from '../../src/hub/transports/telegramBot.js';
import { createSms } from '../../src/hub/transports/sms.js';
import { makeHub } from '../helpers.js';

let ctx: Awaited<ReturnType<typeof makeHub>>;
beforeEach(async () => {
  ctx = await makeHub({}, null, {}, { backend: 'pglite' });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await ctx.db.close();
});

describe('Telegram approval bot', () => {
  const approval = (o: Partial<typeof ctx.cfg.approval> = {}) => ({ ...ctx.cfg.approval, telegramBotToken: 'BOT', telegramChatId: '555', ...o });

  it('only returns messages from the approval chat, and persists the offset so replies are never replayed', async () => {
    const updates = [
      { update_id: 10, message: { message_id: 1, date: 1_800_000_000, text: 'Y K3FD', chat: { id: 555 }, from: { id: 555 } } },
      { update_id: 11, message: { message_id: 2, date: 1_800_000_001, text: 'Y K3FD', chat: { id: 999 }, from: { id: 999 } } }, // another chat
      { update_id: 12, message: { message_id: 3, date: 1_800_000_002, chat: { id: 555 }, from: { id: 555 } } }, // sticker / no text
    ];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const offset = Number(new URL(url).searchParams.get('offset'));
      return Response.json({ ok: true, result: updates.filter((u) => u.update_id >= offset) });
    }));
    const bot = createTelegramBot(approval(), ctx.store)!;
    expect(await bot.poll()).toEqual([{ id: '555:1', text: 'Y K3FD', at: new Date(1_800_000_000_000), fromId: '555' }]);
    expect(await ctx.store.getSetting('approval.telegram.offset', 0)).toBe(13);
    // A restarted hub (new transport, same DB) continues after the last update.
    expect(await createTelegramBot(approval(), ctx.store)!.poll()).toEqual([]);
    expect(urls[1]).toContain('offset=13');
  });

  it('is disabled without a token and chat id, and surfaces HTTP errors', async () => {
    expect(createTelegramBot({ ...ctx.cfg.approval, telegramBotToken: null }, ctx.store)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const bot = createTelegramBot(approval(), ctx.store)!;
    await expect(bot.send('hi')).rejects.toThrow('telegram sendMessage 401');
    await expect(bot.poll()).rejects.toThrow('telegram getUpdates 401');
  });
});

describe('Twilio SMS', () => {
  it('sends only to the configured user number', async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, body: String(init.body) }), new Response('{}', { status: 201 }))));
    const sms = createSms({ accountSid: 'AC1', authToken: 't', from: '+15550009999', userNumber: '+15551112222' })!;
    await sms.send('Y?');
    const params = new URLSearchParams(calls[0].body);
    expect([params.get('From'), params.get('To'), params.get('Body')]).toEqual(['+15550009999', '+15551112222', 'Y?']);
    expect(createSms({ accountSid: 'AC1', authToken: 't', from: '+1', userNumber: null })).toBeNull();
  });
});

describe('Grok Bot webhook nudge', () => {
  async function receiver(status = 200) {
    const got: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push({ headers: req.headers, body });
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, got, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  const task = () => ctx.store.createTask({ originAgent: 'claude', targetAgent: 'grok', payload: 'Pause triage for a week', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'approved' });

  it('without a webhook, the task just waits in the MCP inbox', async () => {
    const r = await grok.triggerTask({ ...ctx.hub.ctx, cfg: { ...ctx.cfg, grokWebhookUrl: null } }, await task(), []);
    expect(r).toMatchObject({ ok: true });
  });

  it('sends only the code (never the payload), signed with HMAC over timestamp and body', async () => {
    const rx = await receiver();
    try {
      const t = await task();
      const r = await grok.triggerTask({ ...ctx.hub.ctx, cfg: { ...ctx.cfg, grokWebhookUrl: rx.url, grokWebhookSecret: 's3cret' } }, t, ['context line']);
      expect(r.ok).toBe(true);
      const [hit] = rx.got;
      expect(JSON.parse(hit.body)).toEqual({ type: 'task', code: t.code });
      expect(hit.body).not.toContain('Pause triage');
      const ts = String(hit.headers['x-hub-timestamp']);
      expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
      expect(hit.headers['x-hub-signature']).toBe(signWebhook('s3cret', ts, hit.body));
    } finally {
      await rx.close();
    }
  });

  it('retries 5xx and 429 but not 4xx', async () => {
    for (const [status, retryable] of [[503, true], [429, true], [404, false]] as const) {
      const rx = await receiver(status);
      try {
        const r = await grok.triggerTask({ ...ctx.hub.ctx, cfg: { ...ctx.cfg, grokWebhookUrl: rx.url, grokWebhookSecret: null } }, await task(), []);
        expect(r).toMatchObject({ ok: false, retryable });
      } finally {
        await rx.close();
      }
    }
  });
});
