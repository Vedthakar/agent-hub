import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramBot } from '../../src/hub/transports/telegramBot.js';
import { twilioSignature } from '../../src/hub/transports/sms.js';
import { HANDLES, msg } from '../helpers.js';
import { dashboardLogin, secureHub, type SecureHub } from './harness.js';

/**
 * Approval spoofing. Only Ved's own device can approve, only with the per-task code, only once, only
 * before it expires, and only for the task the code belongs to.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

async function pending(h: SecureHub, payload = 'Pause open source for a week', ttlMs = 3600_000) {
  const t = await h.store.createTask({ originAgent: 'instinct', targetAgent: 'grok', payload, rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
  await h.store.markApprovalSent(t.id, new Date(Date.now() + ttlMs));
  return t;
}
const status = async (h: SecureHub, id: number) => (await h.store.task(id))!.status;
/** Approving kicks a tick that may deliver at once (Grok's inbox), so let it settle and expect delivery. */
const delivered = async (h: SecureHub, id: number) => {
  await h.hub.idle();
  return status(h, id);
};

const TWILIO = {
  APPROVAL_CHANNEL: 'sms',
  APPROVAL_IMESSAGE_HANDLE: '',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'twilio-auth-token',
  TWILIO_FROM_NUMBER: '+15550009999',
  APPROVAL_USER_NUMBER: '+1 (555) 123-4567',
};

async function twilioPost(h: SecureHub, params: Record<string, string>, sign: 'good' | 'bad' | 'none' = 'good') {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign === 'good') headers['x-twilio-signature'] = twilioSignature(TWILIO.TWILIO_AUTH_TOKEN, `${h.cfg.publicUrl}/twilio/sms`, params);
  if (sign === 'bad') headers['x-twilio-signature'] = twilioSignature('wrong-token', `${h.cfg.publicUrl}/twilio/sms`, params);
  return fetch(`${h.url}/twilio/sms`, { method: 'POST', headers, body: new URLSearchParams(params) });
}

describe('approval spoofing', () => {
  it('AP-01 iMessage: "Y <code>" from anyone but Ved\'s own device is ignored, silently', async () => {
    const h = await secureHub();
    const t = await pending(h);
    // Someone else texting the approval thread, and every agent thread.
    await h.hub.ingestDaemon([msg(HANDLES.approval, `Y ${t.code}`, { fromMe: false })]);
    for (const handle of [HANDLES.instinct, HANDLES.stanley, HANDLES.boardy]) await h.hub.ingestDaemon([msg(handle, `Y ${t.code}`, { fromMe: false })]);
    // Ved's own words in an agent thread are conversation, not approvals.
    await h.hub.ingestDaemon([msg(HANDLES.instinct, `Y ${t.code}`, { fromMe: true })]);
    expect(await status(h, t.id)).toBe('proposed');
    expect((await h.store.recentAudit()).filter((a) => a.action === 'approval.rejected_sender')).toHaveLength(1);
    // No reply that would confirm the channel is live.
    expect((await h.store.recentOutbox(10)).filter((o) => o.to_handle === HANDLES.approval)).toEqual([]);
    await h.hub.ingestDaemon([msg(HANDLES.approval, `Y ${t.code}`, { fromMe: true })]);
    expect(await delivered(h, t.id)).toBe('sent');
  });

  it('AP-02 iMessage: lookalike approval handles (other country code, extra digit, email) are not the approval thread', async () => {
    const h = await secureHub();
    const t = await pending(h);
    for (const handle of ['+445559990000', '+155599900001', '5559990000@evil.com', '+1555999000']) {
      expect((await h.hub.ingestDaemon([msg(handle, `Y ${t.code}`, { fromMe: true })])).commands).toBe(0);
    }
    expect(await status(h, t.id)).toBe('proposed');
    // Formatting differences of the real handle still match.
    expect((await h.hub.ingestDaemon([msg('(555) 999-0000', `Y ${t.code}`, { fromMe: true })])).commands).toBe(1);
    expect(await delivered(h, t.id)).toBe('sent');
  });

  it('AP-03 Twilio: only a signed request from Ved\'s exact number approves; lookalikes and bad signatures do nothing', async () => {
    const h = await secureHub(TWILIO);
    const t = await pending(h);
    const body = (From: string, sid: string) => ({ From, Body: `Y ${t.code}`, MessageSid: sid, To: TWILIO.TWILIO_FROM_NUMBER });
    expect((await twilioPost(h, body('+15551234567', 'SM1'), 'none')).status).toBe(403);
    expect((await twilioPost(h, body('+15551234567', 'SM2'), 'bad')).status).toBe(403);
    for (const [i, lookalike] of ['+445551234567', '+155512345670', '+15551234568', '5551234567@x.com', '+1555123456'].entries()) {
      expect((await twilioPost(h, body(lookalike, `SM-l${i}`))).status).toBe(200);
    }
    expect(await status(h, t.id)).toBe('proposed');
    const inbound = await h.store.db.query<{ sender: string }>('SELECT sender FROM inbound_commands ORDER BY id');
    expect(inbound.every((r) => r.sender !== 'owner')).toBe(true);
    // Signed and from Ved's number (formatted differently): approved.
    expect((await twilioPost(h, body('+15551234567', 'SM-ok'))).status).toBe(200);
    expect(await delivered(h, t.id)).toBe('sent');
    expect((await h.store.recentAudit()).filter((a) => a.action === 'twilio.bad_signature')).toHaveLength(2);
  });

  it('AP-04 Telegram bot: messages from other chats or other users in the approval chat never approve', async () => {
    const h = await secureHub({ APPROVAL_CHANNEL: 'telegram', APPROVAL_IMESSAGE_HANDLE: '', APPROVAL_TELEGRAM_BOT_TOKEN: 'bot-token', APPROVAL_TELEGRAM_CHAT_ID: '-100777', APPROVAL_TELEGRAM_USER_ID: '4242' });
    h.transports.telegramBot = createTelegramBot(h.cfg.approval, h.store);
    const t = await pending(h);
    const updates = [
      { update_id: 1, message: { message_id: 1, date: 1, text: `Y ${t.code}`, chat: { id: -100999 }, from: { id: 4242 } } },
      { update_id: 2, message: { message_id: 2, date: 1, text: `Y ${t.code}`, chat: { id: -100777 }, from: { id: 666 } } },
      { update_id: 3, message: { message_id: 3, date: 1, text: `Y ${t.code}`, chat: { id: -100777 } } },
    ];
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('getUpdates')) {
        const offset = Number(new URL(url).searchParams.get('offset'));
        return new Response(JSON.stringify({ ok: true, result: updates.filter((u) => u.update_id >= offset) }));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await h.hub.pollReads();
    expect(await status(h, t.id)).toBe('proposed');
    updates.push({ update_id: 4, message: { message_id: 4, date: 1, text: `Y ${t.code}`, chat: { id: -100777 }, from: { id: 4242 } } });
    await h.hub.pollReads();
    expect(await delivered(h, t.id)).toBe('sent');
    // The offset was persisted: later polls start after update 4, and it was handled exactly once.
    await h.hub.pollReads();
    const offsets = fetchMock.mock.calls.filter(([u]) => String(u).includes('getUpdates')).map(([u]) => new URL(String(u)).searchParams.get('offset'));
    expect(offsets.at(-1)).toBe('5');
    const seen = await h.store.db.query<{ sender: string; outcome: string }>("SELECT sender, outcome FROM inbound_commands WHERE channel = 'telegram' ORDER BY id");
    expect(seen).toEqual([
      { sender: '666', outcome: 'rejected_sender' },
      { sender: '', outcome: 'rejected_sender' },
      { sender: 'owner', outcome: 'approved' },
    ]);
  });

  it('AP-05 replays: the same message id is processed once, on every channel', async () => {
    const h = await secureHub(TWILIO);
    const t1 = await pending(h, 'one');
    const t2 = await pending(h, 'two');
    const n = await h.hub.handleInbound({ channel: 'imessage', externalId: 'guid-x', fromOwner: true, sender: 'me', text: `N ${t1.code}` });
    expect(n).toBe('rejected');
    // Same guid, different text (an edited/replayed row): still a replay.
    expect(await h.hub.handleInbound({ channel: 'imessage', externalId: 'guid-x', fromOwner: true, sender: 'me', text: `Y ${t2.code}` })).toBe('replay');
    expect(await status(h, t2.id)).toBe('proposed');
    const p = { From: '+15551234567', Body: `Y ${t2.code}`, MessageSid: 'SM-replay', To: TWILIO.TWILIO_FROM_NUMBER };
    await twilioPost(h, p);
    await h.hub.idle();
    // Put the task back up for approval, then replay the identical signed webhook.
    expect(await h.store.transitionTask(t2.id, ['approved', 'sent'], 'proposed')).toBeDefined();
    await twilioPost(h, p);
    expect(await status(h, t2.id)).toBe('proposed');
    const rows = await h.store.db.query<{ outcome: string }>("SELECT outcome FROM inbound_commands WHERE external_id = 'SM-replay'");
    expect(rows.map((r) => r.outcome)).toEqual(['approved']);
  });

  it('AP-06 an expired code does not approve, and the task can never be sent afterwards', async () => {
    const h = await secureHub();
    const t = await pending(h, 'late', -1000);
    expect(await h.hub.handleInbound({ channel: 'imessage', externalId: 'e1', fromOwner: true, sender: 'me', text: `Y ${t.code}` })).toBe('expired');
    expect(await status(h, t.id)).toBe('expired');
    expect(await h.hub.handleInbound({ channel: 'imessage', externalId: 'e2', fromOwner: true, sender: 'me', text: `Y ${t.code}` })).toBe('stale');
    await h.hub.tick();
    expect(await status(h, t.id)).toBe('expired');
    // The sweep expires unanswered ones on its own too.
    const t2 = await pending(h, 'late2', -1000);
    await h.hub.tick();
    expect(await status(h, t2.id)).toBe('expired');
  });

  it('AP-07 a code only ever approves its own task: wrong, unknown, cancelled, already-decided and not-yet-asked codes fail', async () => {
    const h = await secureHub();
    const a = await pending(h, 'a');
    const b = await pending(h, 'b');
    const say = (text: string, id: string) => h.hub.handleInbound({ channel: 'imessage', externalId: id, fromOwner: true, sender: 'me', text });
    expect(await say(`Y ${a.code}`, '1')).toBe('approved');
    expect([await delivered(h, a.id), await status(h, b.id)]).toEqual(['sent', 'proposed']);
    const unknown = a.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    expect(await say(`Y ${unknown}`, '2')).toBe('invalid');
    expect(await say(`N ${a.code}`, '3')).toBe('stale');
    expect(await delivered(h, a.id)).toBe('sent');
    const c = await pending(h, 'c');
    expect(await say(`cancel ${c.code}`, '4')).toBe('cancelled');
    expect(await say(`Y ${c.code}`, '5')).toBe('stale');
    const notAsked = await h.store.createTask({ originAgent: 'instinct', targetAgent: 'grok', payload: 'd', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    expect(await say(`Y ${notAsked.code}`, '6')).toBe('stale');
    expect(await status(h, notAsked.id)).toBe('proposed');
    // Codes use an unambiguous alphabet; look-alike characters never match a real code.
    expect(a.code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(await say(`Y 0${b.code.slice(1)}`, '7')).toBe('missing_code');
    expect(await say('Y', '8')).toBe('missing_code');
    expect(await say(`yes ${b.code.toLowerCase()}`, '9')).toBe('approved');
  });

  it('AP-08 brute force: after repeated unknown codes, approvals lock for 15 minutes', async () => {
    const h = await secureHub({ APPROVAL_MAX_INVALID: '3' });
    const t = await pending(h);
    const guesses = ['AAAA', 'BBBB', 'CCCC', 'DDDD'].filter((g) => g !== t.code).slice(0, 3);
    for (const [i, g] of guesses.entries()) {
      expect(await h.hub.handleInbound({ channel: 'imessage', externalId: `bf${i}`, fromOwner: true, sender: 'me', text: `Y ${g}` })).toBe('invalid');
    }
    expect(await h.hub.handleInbound({ channel: 'imessage', externalId: 'bf-real', fromOwner: true, sender: 'me', text: `Y ${t.code}` })).toBe('locked');
    expect(await status(h, t.id)).toBe('proposed');
    // "pause hub" still works while locked: the kill switch is never locked out.
    expect(await h.hub.handleInbound({ channel: 'imessage', externalId: 'bf-pause', fromOwner: true, sender: 'me', text: 'pause hub' })).toBe('paused');
  });

  it('AP-09 the hub\'s own approval text (which contains "Y <code>") is not read back as Ved\'s reply', async () => {
    const h = await secureHub();
    const t = await h.store.createTask({ originAgent: 'instinct', targetAgent: 'grok', payload: 'p', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    await h.hub.requestApprovals();
    const [o] = await h.store.claimOutbox();
    expect(o.body).toContain(`"Y ${t.code}"`);
    await h.store.ackOutbox(o.id, true);
    // Messages.app records the hub's send as "from me" in the approval thread.
    expect((await h.hub.ingestDaemon([msg(HANDLES.approval, o.body, { fromMe: true })])).commands).toBe(0);
    // Even a hub text that starts with "Y <code>" (e.g. a crafted payload) is skipped as the hub's own.
    await h.store.enqueueOutbox({ toHandle: HANDLES.approval, body: `Y ${t.code}`, purpose: 'notice' });
    const [o2] = await h.store.claimOutbox();
    await h.store.ackOutbox(o2.id, true);
    expect((await h.hub.ingestDaemon([msg(HANDLES.approval, `Y ${t.code}`, { fromMe: true })])).commands).toBe(0);
    expect(await status(h, t.id)).toBe('proposed');
  });

  it('AP-10 dashboard approvals need a signed session and a same-origin request', async () => {
    const h = await secureHub();
    const t = await pending(h);
    const post = (headers: Record<string, string>) => fetch(`${h.url}/actions/task/${t.id}/approve`, { method: 'POST', redirect: 'manual', headers });
    expect((await post({})).headers.get('location')).toBe('/login');
    expect((await post({ cookie: `hub_session=${Date.now() + 1e9}.forged` })).headers.get('location')).toBe('/login');
    const session = await dashboardLogin(h.url);
    expect((await post({ ...session, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ cookie: session.cookie, referer: 'https://evil.example/page' })).status).toBe(403);
    expect((await post({ cookie: session.cookie, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(await status(h, t.id)).toBe('proposed');
    expect((await h.store.recentAudit()).filter((a) => a.action === 'dashboard.cross_origin_blocked')).toHaveLength(3);
    expect((await post(session)).status).toBe(303);
    expect(await delivered(h, t.id)).toBe('sent');
  });

  it('AP-11 approval codes are random: no collisions or sequence across many tasks', async () => {
    const h = await secureHub();
    const codes: string[] = [];
    for (let i = 0; i < 300; i++) {
      codes.push((await h.store.createTask({ originAgent: 'instinct', targetAgent: 'grok', payload: `t${i}`, rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' })).code);
    }
    expect(new Set(codes).size).toBe(300);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    const sorted = [...codes].sort();
    expect(sorted).not.toEqual(codes);
  });
});
