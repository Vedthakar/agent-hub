import { afterEach, describe, expect, it } from 'vitest';
import { setLogSink } from '../../src/shared/log.js';
import { HANDLES, minutesFromNow } from '../helpers.js';
import { stack, type Stack } from '../e2e/stack.js';

/** Fixture chat.db → real daemon → hub HTTP API → local Supabase, with the realistic mess a real chat.db has. */

let s: Stack;
afterEach(async () => {
  await s?.close();
});

const FRIEND = '+15553334444';
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

function seedThreads(st: Stack) {
  st.chat.addMany([
    // Instinct: Ved's own thread, mix of plain text and Ventura-style attributedBody rows.
    { handle: HANDLES.instinct, text: 'Morning! What is on today?', fromMe: true, at: minsAgo(30) },
    { handle: HANDLES.instinct, text: 'You have the assessment at 2pm and a shoot later.', at: minsAgo(29), attributed: true },
    { handle: HANDLES.instinct, text: 'Loved “You have the assessment at 2pm…”', fromMe: true, at: minsAgo(29), associatedType: 2000 },
    // Stanley.
    { handle: HANDLES.stanley, text: 'Need a hook for the launch video', fromMe: true, at: minsAgo(25) },
    { handle: HANDLES.stanley, text: 'Try: “I gave my AI agents a group chat.” 🎬', at: minsAgo(24), attributed: true },
    { handle: HANDLES.stanley, text: '\uFFFC', at: minsAgo(24) }, // attachment-only row
    // Boardy (iMessage over email handle).
    { handle: HANDLES.boardy, text: 'Found a climate founder you should meet. Want an intro?', at: minsAgo(20) },
    { handle: HANDLES.boardy, text: 'Yes please', fromMe: true, at: minsAgo(19) },
    // Noise the daemon must never forward.
    { handle: FRIEND, text: 'are we still on for dinner', at: minsAgo(18) },
    { handle: HANDLES.instinct, text: 'group thread chatter', at: minsAgo(17), group: true },
  ]);
}

const rawRows = (st: Stack) =>
  st.store.db.query<{ agent: string; author: string; channel: string; text: string }>('SELECT agent, author, channel, text FROM raw_messages ORDER BY id');

describe('chat.db pipeline on Supabase', () => {
  it('forwards only the watched 1:1 threads, decodes attributedBody, and attributes authors', async () => {
    s = await stack();
    seedThreads(s);
    const r = await s.poll();
    expect(r.shipped).toBe(6);

    expect(await rawRows(s)).toEqual([
      { agent: 'instinct', author: 'user', channel: 'imessage', text: 'Morning! What is on today?' },
      { agent: 'instinct', author: 'agent', channel: 'imessage', text: 'You have the assessment at 2pm and a shoot later.' },
      { agent: 'stanley', author: 'user', channel: 'imessage', text: 'Need a hook for the launch video' },
      { agent: 'stanley', author: 'agent', channel: 'imessage', text: 'Try: “I gave my AI agents a group chat.” 🎬' },
      { agent: 'boardy', author: 'agent', channel: 'imessage', text: 'Found a climate founder you should meet. Want an intro?' },
      { agent: 'boardy', author: 'user', channel: 'imessage', text: 'Yes please' },
    ]);
  });

  it('is idempotent: a daemon that loses its checkpoint and re-sends everything creates no duplicates', async () => {
    s = await stack();
    seedThreads(s);
    await s.poll();
    // Simulate a lost checkpoint by shipping the same rows straight to the ingest API again.
    const again = await fetch(`${s.url}/daemon/ingest`, {
      method: 'POST',
      headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: (await s.store.db.query<{ external_id: string }>('SELECT external_id FROM raw_messages')).map((r, i) => ({ guid: r.external_id, rowid: i + 1, handle: HANDLES.instinct, isFromMe: false, text: 'dup', sentAt: new Date().toISOString(), service: 'iMessage' })) }),
    });
    expect(await again.json()).toEqual({ accepted: 0, commands: 0 });
    expect(await rawRows(s)).toHaveLength(6);
  });

  it('turns each quiet thread into one event per agent, in order, after the 10-minute debounce', async () => {
    s = await stack();
    seedThreads(s);
    await s.poll();
    expect(await s.hub.collectBursts(new Date())).toBe(3); // seeded threads went quiet 17+ minutes ago

    // A live thread stays held until it has been quiet for 10 minutes.
    s.say(HANDLES.instinct, 'one more thing: push the shoot to 5');
    await s.poll();
    expect(await s.hub.collectBursts(minutesFromNow(5))).toBe(0);
    s.say(HANDLES.instinct, 'actually 6', true);
    await s.poll();
    expect(await s.hub.collectBursts(minutesFromNow(9))).toBe(0);
    expect(await s.hub.collectBursts(minutesFromNow(11))).toBe(1);

    const events = (await s.store.recentEvents(10)).reverse();
    expect(events.map((e) => [e.agent, e.author, e.hop])).toEqual([
      ['instinct', 'user', 0],
      ['stanley', 'user', 0],
      ['boardy', 'user', 0],
      ['instinct', 'user', 0],
    ]);
    expect(events[0].raw_excerpt.split('\n').map((l) => l.replace(/^\[[^\]]+\] /, ''))).toEqual([
      'Ved: Morning! What is on today?',
      'Instinct: You have the assessment at 2pm and a shoot later.',
    ]);
    expect(events[3].raw_excerpt).toMatch(/push the shoot to 5[\s\S]*actually 6/);
    // Every raw message is accounted for exactly once.
    const [{ n }] = await s.store.db.query<{ n: number }>('SELECT count(*)::int AS n FROM raw_messages WHERE processed_at IS NULL');
    expect(n).toBe(0);
  });

  it('keeps message bodies out of the logs end to end', async () => {
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    const level = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    try {
      s = await stack();
      seedThreads(s);
      await s.poll();
      // Malformed model output that quotes the conversation: parser errors must not carry it into logs.
      s.llm.complete = async () => '{"summary": Ved has the assessment at 2pm and a climate founder intro}';
      await s.hub.collectBursts(new Date());
      await s.hub.tick();
      await s.hub.idle();
    } finally {
      restore();
      process.env.LOG_LEVEL = level;
    }
    const all = lines.join('\n');
    expect(all).toContain('router.failed');
    for (const body of ['Ved has', 'Morning! What is on today?', 'assessment at 2pm', 'group chat', 'climate founder', 'dinner']) expect(all).not.toContain(body);
  });
});
