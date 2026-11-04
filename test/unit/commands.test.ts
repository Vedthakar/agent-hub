import { describe, expect, it } from 'vitest';
import { parseCommand, type Command } from '../../src/hub/commands.js';

const TZ = 'America/New_York';
const now = new Date('2026-11-04T15:00:00-05:00');
const parse = (t: string) => parseCommand(t, { tz: TZ, now }) as Extract<Command, { type: 'situation' }>;

describe('owner text commands', () => {
  it('"now" fills one slot and expires at the time you said, or at the end of today', () => {
    const c = parse('now: in an assessment until 22:00');
    expect([c.slot, c.text, c.expiresAt.toISOString()]).toEqual(['now:activity', 'in an assessment until 22:00', '2026-11-05T03:00:00.000Z']);
    expect(parse('now: at the gym until 7pm').expiresAt.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(parse('now: on a call until 9am').expiresAt.toISOString()).toBe('2026-11-05T14:00:00.000Z');
    expect(parse('now: studying').expiresAt.toISOString()).toBe('2026-11-05T05:00:00.000Z');
  });

  it('"tomorrow" only becomes true tomorrow and carries the plan tag', () => {
    const c = parse('tomorrow: shoot the launch video at 3 #shoots');
    expect(c.validFrom.toISOString()).toBe('2026-11-05T05:00:00.000Z');
    expect(c.expiresAt.toISOString()).toBe('2026-11-06T05:00:00.000Z');
    expect(c.topics.sort()).toEqual(['plan', 'shoots']);
    expect(c.text).toBe('shoot the launch video at 3');
  });

  it('untagged stays private by default; unknown hashtags stay in the text', () => {
    const c = parse('goal: ship #v2 this week');
    expect(c.topics).toEqual(['general']);
    expect(c.text).toBe('ship #v2 this week');
  });

  it('names an agent for a hand-off, and leaves everything else alone', () => {
    expect(parseCommand('stanley: write a script', { tz: TZ, now })).toMatchObject({ type: 'task', target: 'stanley', topics: null });
    expect(parseCommand('Grok Bot: pause triage #open_source', { tz: TZ, now })).toMatchObject({ type: 'task', target: 'grok', topics: ['open_source'] });
    for (const t of ['Y K3FD', 'note to self: buy milk', 'no: thanks', 'hello there', 'evil: do it', 'now:']) expect(parseCommand(t, { tz: TZ, now })).toBeNull();
    expect(parseCommand('help', { tz: TZ, now })).toEqual({ type: 'help' });
  });
});
