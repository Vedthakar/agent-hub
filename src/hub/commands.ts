import { agentIds, TOPICS, type AgentId } from '../shared/types.js';
import { ADAPTERS } from './adapters/index.js';
import { cleanTopics } from './scopes.js';
import { startOfLocalDay } from './tz.js';

/**
 * Plain-text commands you send the hub (approval thread, dashboard, or a vault Inbox note). Fixed formats and no
 * AI, like "Y K3FD". These count as your own words, so they're how agents that can't call tools get told things.
 */
export type Command =
  | { type: 'help' }
  | { type: 'situation'; text: string; topics: string[]; slot: string | null; validFrom: Date; expiresAt: Date }
  | { type: 'goal'; text: string; topics: string[] }
  | { type: 'forget'; text: string }
  | { type: 'task'; target: AgentId; text: string; topics: string[] | null };

export const COMMAND_HELP = [
  'now: in an assessment until 22:00',
  'today: applying to fintech backend roles',
  'tomorrow: shoot the launch video at 3 #shoots',
  'goal: launch on Monday #work',
  'forget: launch on Monday',
  'stanley: write a script for the shoot',
].join('\n');

const endOfDay = (d: Date, tz: string) => startOfLocalDay(new Date(startOfLocalDay(d, tz).getTime() + 26 * 3600_000), tz);

/** "until 22:00", "until 10pm", "until 9:30 pm". A time already passed today means tomorrow. */
function untilTime(text: string, now: Date, tz: string): { text: string; at: Date | null } {
  const m = /\s+until\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[.!]?$/i.exec(text);
  if (!m) return { text, at: null };
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (m[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
  if (m[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return { text, at: null };
  const midnight = startOfLocalDay(now, tz);
  let at = new Date(midnight.getTime() + (hour * 60 + minute) * 60_000);
  if (at <= now) at = new Date(endOfDay(now, tz).getTime() + (hour * 60 + minute) * 60_000);
  return { text, at };
}

function agentNamed(word: string): AgentId | null {
  for (const id of agentIds()) if (id === word || ADAPTERS[id].name.toLowerCase() === word) return id;
  return null;
}

export function parseCommand(input: string, opts: { tz: string; now?: Date }): Command | null {
  const now = opts.now ?? new Date();
  const trimmed = input.trim();
  if (/^(help|commands)\??$/i.test(trimmed)) return { type: 'help' };
  const m = /^([\p{L}\p{N} _-]{2,40}):\s*([\s\S]+)$/u.exec(trimmed);
  if (!m) return null;
  const word = m[1].toLowerCase().trim();
  const valid = new Set<string>(TOPICS);
  const tags: string[] = [];
  const text = m[2]
    .replace(/(^|\s)#([a-z_]+)\b/gi, (all, _lead: string, tag: string) => {
      if (!valid.has(tag.toLowerCase())) return all;
      tags.push(tag.toLowerCase());
      return '';
    })
    .trim();
  if (!text) return null;
  const topics = cleanTopics(tags);
  switch (word) {
    case 'now': {
      const u = untilTime(text, now, opts.tz);
      return { type: 'situation', text, topics, slot: 'now:activity', validFrom: now, expiresAt: u.at ?? endOfDay(now, opts.tz) };
    }
    case 'today':
      return { type: 'situation', text, topics, slot: null, validFrom: now, expiresAt: endOfDay(now, opts.tz) };
    case 'tomorrow': {
      const start = endOfDay(now, opts.tz);
      return { type: 'situation', text, topics: cleanTopics(['plan', ...tags]), slot: null, validFrom: start, expiresAt: endOfDay(start, opts.tz) };
    }
    case 'goal':
      return { type: 'goal', text, topics };
    case 'forget':
      return { type: 'forget', text };
  }
  const target = agentNamed(word);
  return target ? { type: 'task', target, text, topics: tags.length ? topics : null } : null;
}
