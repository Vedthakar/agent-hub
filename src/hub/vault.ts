import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { log } from '../shared/log.js';
import { ADAPTERS } from './adapters/index.js';
import type { HubConfig } from './config.js';
import { cleanTopics } from './scopes.js';
import type { FactRow, SituationRow, Store } from './store.js';
import { formatLocal, localDateKey, startOfLocalDay } from './tz.js';
import { atomicWrite, ensureInsideVault } from './vaultFs.js';

/**
 * The hub's memory as notes you can read and edit in Obsidian. The database stays the index, because
 * permissions and expiry need it; tasks and approvals live only there, so editing a file can never approve anything.
 *
 *   Inbox/             drop a note here and the hub files it (a command like "goal: ..." also works)
 *   Memory/Goals, Preferences, Facts, Situation/   one note per item; edit the text or delete the note
 *   Log/<date>.md      one line per thing an agent did (idea from Crew in obsidian-second-brain)
 *   Tasks.md           read-only view
 */
const FACT_DIR = { goal: 'Goals', preference: 'Preferences', fact: 'Facts' } as const;
const NOTES_KEY = 'vault.notes';
const OWNER = 'owner';

interface Tracked {
  kind: 'fact' | 'situation';
  id: number;
  hash: string;
}

const sha = (s: string) => createHash('sha256').update(s.trim()).digest('hex').slice(0, 16);
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'note';

export function renderNote(meta: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(meta)}---\n\n${body.trim()}\n`;
}

export function parseNote(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  try {
    return { meta: (parseYaml(m[1]) as Record<string, unknown>) ?? {}, body: m[2].trim() };
  } catch {
    return { meta: {}, body: m[2].trim() };
  }
}

export class VaultSync {
  constructor(
    private store: Store,
    private cfg: HubConfig,
    /** Runs an Inbox note as an owner command. Returns false if it isn't one. */
    private command: (text: string) => Promise<boolean>,
  ) {}

  private file(rel: string): string {
    return ensureInsideVault(path.join(this.cfg.vaultPath, rel), this.cfg.vaultPath);
  }

  /** A vault problem never stops the hub: memory is safe in the database and the next tick tries again. */
  async sync(now = new Date()): Promise<void> {
    try {
      mkdirSync(this.file('Inbox'), { recursive: true });
      const tracked = await this.importEdits();
      await this.importInbox();
      await this.render(tracked, now);
    } catch (err) {
      log.warn('vault.sync_failed', { error: (err as Error).message });
      await this.store.audit('hub', 'vault.sync_failed', { error: (err as Error).message });
    }
  }

  /** Your edits win: a changed note updates the memory, and a deleted note retires it. */
  private async importEdits(): Promise<Record<string, Tracked>> {
    const tracked = await this.store.getSetting<Record<string, Tracked>>(NOTES_KEY, {});
    for (const [rel, note] of Object.entries(tracked)) {
      const file = this.file(rel);
      if (!existsSync(file)) {
        if (note.kind === 'fact') await this.store.retireFacts([note.id]);
        else await this.store.supersedeSituation([note.id], null);
        await this.store.audit(OWNER as never, 'vault.note_deleted', { kind: note.kind, id: note.id });
        delete tracked[rel];
        continue;
      }
      const { body } = parseNote(readFileSync(file, 'utf8'));
      if (sha(body) === note.hash || !body) continue;
      if (note.kind === 'fact') await this.store.updateFactText(note.id, body);
      else await this.store.updateSituationText(note.id, body);
      await this.store.audit(OWNER as never, 'vault.note_edited', { kind: note.kind, id: note.id });
      note.hash = sha(body);
    }
    return tracked;
  }

  private async importInbox(): Promise<void> {
    for (const name of readdirSync(this.file('Inbox'))) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const file = this.file(path.join('Inbox', name));
      const { meta, body } = parseNote(readFileSync(file, 'utf8'));
      if (!body) continue;
      if (!(await this.command(body))) {
        const kind = meta.kind === 'goal' || meta.kind === 'preference' ? meta.kind : 'fact';
        const topics = Array.isArray(meta.topics) ? meta.topics.map(String) : [];
        await this.store.addFact({ text: body, kind, topics: cleanTopics(topics), sourceAgent: OWNER as never, author: 'user', originEventId: null });
      }
      unlinkSync(file);
    }
  }

  private async render(tracked: Record<string, Tracked>, now: Date): Promise<void> {
    const name = (a: string) => (a === OWNER ? 'You' : (ADAPTERS[a as keyof typeof ADAPTERS]?.name ?? a));
    const wanted = new Map<string, { kind: Tracked['kind']; id: number; content: string; body: string }>();
    // A note keeps its filename for life, so a note open in Obsidian doesn't vanish when its text changes.
    const relFor = (kind: Tracked['kind'], id: number, fresh: string) =>
      Object.entries(tracked).find(([, n]) => n.kind === kind && n.id === id)?.[0] ?? fresh;
    const [facts, situation] = await Promise.all([this.store.activeFacts(), this.store.currentAndUpcomingSituation(now)]);
    for (const f of facts as FactRow[]) {
      wanted.set(relFor('fact', f.id, path.join('Memory', FACT_DIR[f.kind], `${f.id}-${slug(f.text)}.md`)), {
        kind: 'fact',
        id: f.id,
        body: f.text,
        content: renderNote({ kind: f.kind, topics: f.topics, from: name(f.source_agent), said_by: f.author }, f.text),
      });
    }
    for (const s of situation as SituationRow[]) {
      wanted.set(relFor('situation', s.id, path.join('Memory', 'Situation', `${s.id}-${slug(s.text)}.md`)), {
        kind: 'situation',
        id: s.id,
        body: s.text,
        content: renderNote({ topics: s.topics, from: name(s.source_agent), said_by: s.author, starts: s.valid_from, expires: s.expires_at }, s.text),
      });
    }
    // Expired, replaced or retired: the note goes away, and that isn't you deleting it.
    for (const rel of Object.keys(tracked)) {
      if (wanted.has(rel)) continue;
      if (existsSync(this.file(rel))) unlinkSync(this.file(rel));
      delete tracked[rel];
    }
    for (const [rel, note] of wanted) {
      atomicWrite(this.file(rel), note.content);
      tracked[rel] = { kind: note.kind, id: note.id, hash: sha(note.body) };
    }
    await this.store.setSetting(NOTES_KEY, tracked);

    const tz = this.cfg.timezone;
    const events = (await this.store.eventsSince(startOfLocalDay(now, tz), 300)).filter((e) => e.summary).reverse();
    if (events.length) {
      atomicWrite(
        this.file(path.join('Log', `${localDateKey(now, tz)}.md`)),
        `# ${localDateKey(now, tz)}\n\n${events.map((e) => `- ${formatLocal(new Date(e.occurred_at), tz, { withDay: false })} **${name(e.agent)}**${e.triage && e.triage !== 'log' ? ` (${e.triage})` : ''}: ${e.summary.replace(/\s*[\r\n]+\s*/g, ' ')}`).join('\n')}\n`,
      );
    }
    const tasks = await this.store.recentTasks(50);
    atomicWrite(
      this.file('Tasks.md'),
      `# Tasks\n\nA read-only view. Editing this file changes nothing: approve by text or in the dashboard.\n\n${tasks.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] \`${t.code}\` ${name(t.origin_agent)} → ${name(t.target_agent)}: ${t.payload.replace(/\s*[\r\n]+\s*/g, ' ')} (${t.status})`).join('\n') || 'No tasks yet.'}\n`,
    );
  }
}
