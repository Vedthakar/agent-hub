import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { ArchiveMessage } from './store.js';

/** One thing to bring in. A preset folder or summary settles it by rule, with no worker and no tokens. */
export interface ImportedConversation {
  source: string;
  externalId: string;
  title: string;
  messages: ArchiveMessage[];
  /** chat: read and organize. code: organize only. memory: filed by rule. */
  kind?: 'chat' | 'code' | 'memory';
  folder?: string;
  summary?: string;
}

const MAX_TEXT = 20_000;
const MAX_MESSAGES = 1000;

/** Keys pasted into old chats shouldn't end up in notes or in front of other agents. */
const SECRET = /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|\d{8,10}:AA[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
export const redactSecrets = (text: string) => text.replace(SECRET, '[secret removed]');

const iso = (seconds: unknown): string | null => (typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);

/** ChatGPT keeps each chat as a tree of edits. The chat you see is the path back from current_node. */
function chatGptConversation(c: Record<string, any>): ImportedConversation | null {
  const mapping: Record<string, any> = c.mapping ?? {};
  const chain: any[] = [];
  let node = c.current_node ? mapping[c.current_node] : undefined;
  while (node) {
    chain.unshift(node);
    node = node.parent ? mapping[node.parent] : undefined;
  }
  const nodes = chain.length ? chain : Object.values(mapping).sort((a: any, b: any) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0));
  const messages: ArchiveMessage[] = [];
  nodes.forEach((n: any, i: number) => {
    const m = n.message;
    const role = m?.author?.role;
    if ((role !== 'user' && role !== 'assistant') || m.metadata?.is_visually_hidden_from_conversation) return;
    const text = (m.content?.parts ?? []).filter((p: unknown) => typeof p === 'string').join('\n').trim();
    if (text) messages.push({ id: String(m.id ?? i), role, text, at: iso(m.create_time) });
  });
  const externalId = String(c.conversation_id ?? c.id ?? '');
  return externalId && messages.length ? { source: 'chatgpt', externalId, title: String(c.title ?? '').trim() || 'Untitled', messages } : null;
}

function claudeConversation(c: Record<string, any>): ImportedConversation | null {
  const messages: ArchiveMessage[] = [];
  (c.chat_messages ?? []).forEach((m: any, i: number) => {
    const text = (String(m.text ?? '').trim() || (m.content ?? []).filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')).trim();
    if (text) messages.push({ id: String(m.uuid ?? i), role: m.sender === 'human' ? 'user' : 'assistant', text, at: m.created_at ?? null });
  });
  const externalId = String(c.uuid ?? '');
  return externalId && messages.length ? { source: 'claude', externalId, title: String(c.name ?? '').trim() || 'Untitled', messages } : null;
}

/** Tells the format from the data itself, so a renamed file still works. */
export function parseConversations(json: string): ImportedConversation[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('not a list of conversations');
  const out: ImportedConversation[] = [];
  for (const c of data as Record<string, any>[]) {
    const conv = c?.mapping ? chatGptConversation(c) : c?.chat_messages ? claudeConversation(c) : null;
    if (conv) out.push(conv);
  }
  return out;
}

const one = (id: string, text: string, at: string | null = null): ArchiveMessage[] => [{ id, role: 'assistant', text, at }];

/** Claude's memory about you is already sorted and already yours, so it's filed as is. */
function claudeMemories(json: string): ImportedConversation[] {
  const d = JSON.parse(json) as { conversations_memory?: string; memory_files?: { path: string; content: string; updated_at?: string }[] };
  const out: ImportedConversation[] = [];
  if (d.conversations_memory?.trim()) {
    out.push({ source: 'claude-memory', externalId: 'conversations_memory', title: 'What Claude remembers', messages: one('m', d.conversations_memory), kind: 'memory', folder: 'Claude Memory', summary: 'Claude’s saved memory across chats.' });
  }
  for (const f of d.memory_files ?? []) {
    if (!f.content?.trim()) continue;
    const name = f.path.replace(/\.(md|txt)$/i, '').split('/').pop() ?? f.path;
    out.push({ source: 'claude-memory', externalId: f.path, title: name, messages: one(f.path, f.content, f.updated_at ?? null), kind: 'memory', folder: 'Claude Memory', summary: `Claude memory file: ${f.path}` });
  }
  return out;
}

function claudeProject(json: string): ImportedConversation[] {
  const p = JSON.parse(json) as { uuid: string; name: string; description?: string; prompt_template?: string; created_at?: string; docs?: { uuid: string; filename: string; content: string; created_at?: string }[] };
  const out: ImportedConversation[] = [];
  const about = [p.description, p.prompt_template].filter((x) => x?.trim()).join('\n\n');
  if (about) out.push({ source: 'claude-project', externalId: p.uuid, title: `${p.name} (project)`, messages: one(p.uuid, about, p.created_at ?? null) });
  for (const d of p.docs ?? []) {
    if (d.content?.trim()) out.push({ source: 'claude-project', externalId: d.uuid, title: `${p.name}: ${d.filename}`, messages: one(d.uuid, d.content, d.created_at ?? null) });
  }
  return out;
}

/** Pages keep their text. App-style artifacts are code bundles, so only their title and description come in. */
function claudeArtifact(meta: string, page: string | null): ImportedConversation | null {
  const a = JSON.parse(meta) as { id: string; updated_at?: string; versions?: { title?: string; description?: string; created_at?: string }[] };
  const v = a.versions?.[0];
  const text = page?.trim() || v?.description?.trim();
  if (!text) return null;
  return { source: 'claude-artifact', externalId: a.id, title: v?.title?.trim() || 'Untitled artifact', messages: one(a.id, text, a.updated_at ?? v?.created_at ?? null) };
}

function claudeRoutines(json: string): ImportedConversation[] {
  const d = JSON.parse(json) as { claude_code_cloud?: { routine_id: string; name?: string; prompt?: string; prompt_withheld?: boolean; created_at?: string }[] };
  return (d.claude_code_cloud ?? [])
    .filter((r) => r.prompt?.trim())
    .map((r) => ({ source: 'claude-code-cloud', externalId: r.routine_id, title: r.name?.trim() || 'Cloud routine', messages: one(r.routine_id, r.prompt!, r.created_at ?? null), kind: 'code' as const, folder: 'Projects/Cloud routines', summary: `Scheduled cloud routine: ${r.name ?? ''}` }));
}

/** What each part of a split export means. Account data like login history is deliberately left out. */
export function parseExportFiles(files: { name: string; text: string }[]): { conversations: ImportedConversation[]; understood: boolean } {
  const conversations: ImportedConversation[] = [];
  let understood = false;
  const byName = new Map(files.map((f) => [f.name, f.text]));
  for (const { name, text } of files) {
    const base = path.basename(name);
    if (/^conversations[^/]*\.json$/i.test(base)) {
      conversations.push(...parseConversations(text));
      understood = true;
    } else if (/(^|\/)memories\/[^/]+\.json$/.test(name)) {
      conversations.push(...claudeMemories(text));
      understood = true;
    } else if (/(^|\/)projects\/[^/]+\.json$/.test(name)) {
      conversations.push(...claudeProject(text));
      understood = true;
    } else if (/(^|\/)artifacts\/[^/]+\/artifact\.json$/.test(name)) {
      const c = claudeArtifact(text, byName.get(name.replace(/artifact\.json$/, 'page.md')) ?? null);
      if (c) conversations.push(c);
      understood = true;
    } else if (/claude_code_cloud\/routines\.json$/.test(name)) {
      conversations.push(...claudeRoutines(text));
      understood = true;
    }
  }
  return { conversations, understood };
}

/** Parts of an export that aren't conversations: an index file, and account data the vault has no use for. */
export const isSkippablePart = (name: string, zipEntries: string[]) =>
  /^manifest-/i.test(name) || (zipEntries.length > 0 && zipEntries.every((e) => /(^|\/)(users|login_history)\.json$/.test(e) || /claude_code_cloud\/routine_runs\.json$/.test(e)));

/** The folder a session belongs to, from where it ran. Worktrees count as their repo. */
export function projectFromCwd(cwd: string): string {
  const repo = cwd.replace(/\/\.claude\/worktrees\/.*$/, '').replace(/\/\.worktrees\/.*$/, '');
  if (/scratch-workspaces|\/tmp\/|\/private\/tmp/.test(repo)) return 'Scratch';
  return path.basename(repo).replace(/-(main|master)$/i, '').replace(/[-_.]+$/, '') || 'Scratch';
}

const NOISE = /^\s*(<(command-|local-command|system-reminder|task-notification|side-sessions|ci-monitor|environment_context|user_instructions|permissions)|# AGENTS\.md instructions)/;

/** Codex wraps what you typed in a block about your editor. Keep just what you asked. */
const realRequest = (text: string) => {
  const m = /^# Context from my IDE setup:[\s\S]*?## My request for Codex:\s*([\s\S]*)$/.exec(text);
  return m ? m[1].trim() : text;
};

async function jsonLines(file: string, each: (d: any) => void): Promise<void> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      each(JSON.parse(line));
    } catch {
      // One damaged line shouldn't cost the rest of the session.
    }
  }
}

const finish = (source: string, id: string, title: string, cwd: string, messages: ArchiveMessage[]): ImportedConversation | null => {
  if (!id || !messages.some((m) => m.role === 'user')) return null;
  const project = projectFromCwd(cwd);
  const name = title || messages.find((m) => m.role === 'user')!.text.replace(/\s+/g, ' ').slice(0, 70);
  // A session with no repo says nothing about where it belongs, so it gets read like a chat.
  if (project === 'Scratch') return { source, externalId: id, title: name, messages: messages.slice(-MAX_MESSAGES) };
  return { source, externalId: id, title: name, messages: messages.slice(-MAX_MESSAGES), kind: 'code', folder: `Projects/${project}`, summary: `${source === 'codex' ? 'Codex' : 'Claude Code'} session in ${project}: ${name}` };
};

/** Your words and its replies only. Tool calls and file contents stay out: they're huge and can hold secrets. */
export async function readClaudeCodeSession(file: string): Promise<ImportedConversation | null> {
  const messages: ArchiveMessage[] = [];
  let id = '';
  let cwd = '';
  let title = '';
  await jsonLines(file, (d) => {
    if (d.type === 'custom-title' || d.type === 'ai-title') title = String(d.customTitle ?? d.aiTitle ?? d.title ?? title);
    if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain || d.isMeta) return;
    id ||= String(d.sessionId ?? '');
    cwd ||= String(d.cwd ?? '');
    const c = d.message?.content;
    const text = realRequest((typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : '').trim());
    if (text && !NOISE.test(text)) messages.push({ id: String(d.uuid ?? messages.length), role: d.type, text: text.slice(0, MAX_TEXT), at: d.timestamp ?? null });
  });
  return finish('claude-code', id, title, cwd, messages);
}

export async function readCodexSession(file: string): Promise<ImportedConversation | null> {
  const messages: ArchiveMessage[] = [];
  let id = '';
  let cwd = '';
  await jsonLines(file, (d) => {
    const p = d.payload;
    if (d.type === 'session_meta') {
      id = String(p?.id ?? '');
      cwd = String(p?.cwd ?? '');
    }
    if (d.type !== 'response_item' || p?.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) return;
    const text = realRequest((p.content ?? []).filter((x: any) => typeof x?.text === 'string').map((x: any) => x.text).join('\n').trim());
    if (text && !NOISE.test(text)) messages.push({ id: String(messages.length), role: p.role, text: text.slice(0, MAX_TEXT), at: d.timestamp ?? null });
  });
  return finish('codex', id, '', cwd, messages);
}

function jsonlFiles(dir: string, skip?: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (skip?.test(e.name)) return [];
    return e.isDirectory() ? jsonlFiles(full, skip) : e.name.endsWith('.jsonl') ? [full] : [];
  });
}

export interface SessionFile {
  file: string;
  mtimeMs: number;
  read(file: string): Promise<ImportedConversation | null>;
}

/** Session logs on this machine. Background helpers (subagents) are part of their parent session, so they're skipped. */
export function findSessionFiles(home: string, extraClaudeDirs: string[] = []): SessionFile[] {
  const claude = [path.join(home, '.claude'), ...extraClaudeDirs].flatMap((d) => jsonlFiles(path.join(d, 'projects'), /^subagents$/));
  const codex = jsonlFiles(path.join(home, '.codex', 'sessions'));
  return [
    ...claude.map((file) => ({ file, mtimeMs: statSync(file).mtimeMs, read: readClaudeCodeSession })),
    ...codex.map((file) => ({ file, mtimeMs: statSync(file).mtimeMs, read: readCodexSession })),
  ];
}
