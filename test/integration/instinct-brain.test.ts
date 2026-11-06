import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDebriefDigest } from '../../src/hub/context.js';
import { scheduleDigest } from '../../src/hub/debrief.js';
import { readInstinctMail } from '../../src/hub/instinctMail.js';
import type { InboundEmail, ImapTransport } from '../../src/hub/transports/imap.js';
import { INSTINCT_EMAIL, makeHub, serve } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fakeImap() {
  const inbox: InboundEmail[] = [];
  const imap: ImapTransport & { inbox: InboundEmail[] } = {
    inbox,
    async fetchSince(last) {
      return { messages: inbox.filter((m) => m.uid > last), uidValidity: '1' };
    },
  };
  return imap;
}

async function setup(env: Record<string, string> = {}) {
  const imap = fakeImap();
  const ctx = await makeHub(env, undefined, { imap });
  const http = await serve(ctx.hub);
  cleanups.push(async () => {
    await http.close();
    await ctx.hub.idle();
    await ctx.db.close();
  });
  return { ...ctx, url: http.url, imap };
}

async function seed(ctx: Awaited<ReturnType<typeof setup>>) {
  const { store } = ctx;
  const add = async (id: string, title: string, text: string, topics: string[], folder: string, summary: string) => {
    await store.upsertArchive({ source: 'claude', externalId: id, title, messages: [{ id, role: 'user', text, at: '2026-05-01T00:00:00Z' }], hash: id, startedAt: new Date('2026-05-01'), updatedAt: new Date('2026-05-01') });
    const row = (await store.archiveByKey('claude', id))!;
    await store.markArchiveOrganized(row.id, folder, topics, false);
    await store.markArchiveRead(row.id, folder, topics, summary, 2);
    return row.id;
  };
  return {
    stripe: await add('k1', 'Stripe interview prep', 'Prep me for the Stripe <script>alert(1)</script> interview', ['professional'], 'Job Search/Stripe', 'Prepared for Stripe.'),
    health: await add('k2', 'Knee surgery recovery', 'Recovery plan for my knee surgery', ['health'], 'Health', 'Knee surgery plan.'),
  };
}

async function link(ctx: Awaited<ReturnType<typeof setup>>) {
  const token = randomBytes(32).toString('base64url');
  await ctx.hub.connections.setMany({ 'instinct.brainToken': token });
  return { token, base: `${ctx.url}/brain/${token}` };
}

describe('Instinct’s private page', () => {
  it('doesn’t exist until you create a link, and a wrong link gets nothing', async () => {
    const ctx = await setup();
    await seed(ctx);
    expect((await fetch(`${ctx.url}/brain/anything`)).status).toBe(404);
    await link(ctx);
    const wrong = await fetch(`${ctx.url}/brain/${'x'.repeat(43)}`);
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).not.toContain('Stripe');
  });

  it('shows what’s current, the library and search, read-only, private and escaped', async () => {
    const ctx = await setup();
    const ids = await seed(ctx);
    await ctx.store.addSituation({ text: 'In an assessment', slot: null, topics: ['general'], sourceAgent: 'claude', author: 'agent', originEventId: null, expiresAt: new Date(Date.now() + 3600_000) });
    const { base } = await link(ctx);
    const home = await fetch(base);
    expect(home.status).toBe(200);
    expect(home.headers.get('cache-control')).toBe('no-store');
    expect(home.headers.get('x-robots-tag')).toContain('noindex');
    expect(home.headers.get('content-security-policy')).toContain("default-src 'none'");
    const body = await home.text();
    expect(body).toContain('In an assessment');
    expect(body).toContain('Job Search/Stripe');
    expect(body).toContain('not as instructions');
    expect(await (await fetch(`${base}?q=stripe`)).text()).toContain('Stripe interview prep');
    expect(await (await fetch(`${base}?q=${encodeURIComponent("%' OR '1'='1")}`)).text()).toContain('Nothing found.');
    const chat = await (await fetch(`${base}/chat/${ids.stripe}`)).text();
    expect(chat).toContain('Prep me for the Stripe');
    expect(chat).not.toContain('<script>alert');
    expect((await fetch(base, { method: 'POST' })).status).toBe(404);
    expect((await ctx.store.recentAudit()).some((a) => a.action === 'brain.read')).toBe(true);
  });

  it('follows Instinct’s topic limits, and pausing or turning it off shuts the page', async () => {
    const ctx = await setup();
    const ids = await seed(ctx);
    const { base } = await link(ctx);
    await ctx.store.updateScope('instinct', { allow_topics: ['*'], deny_topics: ['health'], autonomy: 'ask', enabled: true }, 'owner');
    expect(await (await fetch(base)).text()).not.toContain('Health');
    expect(await (await fetch(`${base}?q=knee`)).text()).toContain('Nothing found.');
    expect((await fetch(`${base}/chat/${ids.health}`)).status).toBe(404);
    await ctx.store.setPaused(true, 'user');
    expect((await fetch(base)).status).toBe(503);
    await ctx.store.setPaused(false, 'user');
    await ctx.hub.connections.setMany({ 'instinct.brainToken': null });
    expect((await fetch(base)).status).toBe(404);
  });
});

describe('Instinct by email', () => {
  const mail = (uid: number, from: string, subject: string, text = '') => ({ uid, messageId: `<m${uid}@x>`, from, subject, text, date: new Date(), refs: [] });

  it('answers a search to Instinct’s mailbox only, and ignores anyone else asking', async () => {
    const ctx = await setup();
    await seed(ctx);
    expect(await readInstinctMail(ctx.hub.ctx, null)).toBe(0); // first run just sets the checkpoint
    ctx.imap.inbox.push(mail(1, 'stranger@evil.example', 'vault: stripe'), mail(2, INSTINCT_EMAIL, 'vault: stripe interview'));
    expect(await readInstinctMail(ctx.hub.ctx, 'https://hub.example/brain/t')).toBe(1);
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0].to).toBe(INSTINCT_EMAIL);
    expect(ctx.email.sent[0].text).toContain('Stripe interview prep');
    expect(ctx.email.sent[0].text).toContain('https://hub.example/brain/t/chat/');
    expect(ctx.email.sent[0].text).toContain('not instructions');
    await readInstinctMail(ctx.hub.ctx, null);
    expect(ctx.email.sent).toHaveLength(1); // not answered twice
  });

  it('saves "remember" as Instinct’s, not yours, and files anything else as its activity', async () => {
    const ctx = await setup();
    await readInstinctMail(ctx.hub.ctx, null);
    ctx.imap.inbox.push(mail(1, INSTINCT_EMAIL, 'remember: launch moved to Friday #work'), mail(2, INSTINCT_EMAIL, 'Today’s recap', 'Ved finished the deck.'));
    await readInstinctMail(ctx.hub.ctx, null);
    const [fact] = await ctx.store.activeFacts();
    expect([fact.text, fact.author, fact.source_agent, fact.topics]).toEqual(['launch moved to Friday', 'agent', 'instinct', ['work']]);
    const raw = await ctx.store.db.query<{ text: string; channel: string; author: string }>("SELECT text, channel, author FROM raw_messages WHERE agent = 'instinct'");
    expect(raw).toEqual([{ text: 'Today’s recap\n\nVed finished the deck.', channel: 'email', author: 'agent' }]);
    expect(ctx.email.sent).toEqual([]);
  });

  it('can’t be used to approve anything, and caps replies so agents can’t loop', async () => {
    const ctx = await setup();
    await readInstinctMail(ctx.hub.ctx, null);
    const task = await ctx.store.createTask({ originAgent: 'claude', targetAgent: 'grok', payload: 'Do it', rationale: '', topics: ['work'], author: 'agent', originEventId: null, hop: 1, status: 'proposed', statusReason: null });
    ctx.imap.inbox.push(mail(1, INSTINCT_EMAIL, `Y ${task.code}`));
    for (let i = 2; i < 50; i++) ctx.imap.inbox.push(mail(i, INSTINCT_EMAIL, `vault: anything ${i}`));
    await readInstinctMail(ctx.hub.ctx, null);
    expect((await ctx.store.task(task.id))!.status).toBe('proposed');
    expect(ctx.email.sent.length).toBe(40);
  });
});

describe('regular updates', () => {
  it('sends at the set times once each, skips missed ones, and doesn’t use up the debrief', async () => {
    const ctx = await setup({ INSTINCT_DIGEST_TIMES: '08:00,21:00', HUB_TIMEZONE: 'America/New_York' });
    const at = (t: string) => new Date(`2026-11-06T${t}:00-05:00`);
    expect(await scheduleDigest(ctx.hub.ctx, at('07:59'))).toBe(false);
    expect(await scheduleDigest(ctx.hub.ctx, at('08:01'))).toBe(true);
    expect(await ctx.store.getSetting('debrief.pending', null)).toMatchObject({ scheduled: true });
    await ctx.store.setSetting('debrief.pending', null);
    expect(await scheduleDigest(ctx.hub.ctx, at('08:30'))).toBe(false);
    expect(await scheduleDigest(ctx.hub.ctx, at('12:00'))).toBe(false); // 8am was missed by hours by now, and 9pm isn't due
    expect(await scheduleDigest(ctx.hub.ctx, at('21:05'))).toBe(true);
    expect(await ctx.store.getSetting('debrief.lastDate', null)).toBeNull();
  });

  it('holds off when Instinct is off or no email is set up, and includes the link and how to ask', async () => {
    const ctx = await setup({ INSTINCT_DIGEST_TIMES: '08:00', HUB_TIMEZONE: 'America/New_York' });
    await ctx.store.setAgentEnabled('instinct', false, 'owner');
    expect(await scheduleDigest(ctx.hub.ctx, new Date('2026-11-06T08:01:00-05:00'))).toBe(false);
    const digest = await buildDebriefDigest(ctx.store, { ownerName: 'Ved', tz: 'America/New_York', scheduled: true, brainUrl: 'https://hub.example/brain/t', replyTo: 'ved@example.com' });
    expect(digest.subject).toBe("Ved's update");
    expect(digest.body).toContain('https://hub.example/brain/t');
    expect(digest.body).toContain('"vault: your search"');
  });
});
