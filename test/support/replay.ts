import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLlm, type Llm } from '../../src/hub/llm.js';
import { loadConfig } from '../../src/hub/config.js';

/**
 * One recorded LLM exchange. `source` says where the reply came from:
 * - "recorded": captured from a real model with GOLDEN_RECORD=1 (model name kept);
 * - "authored": written by hand as the expected model reply (used when no API key is available).
 * The prompt hash pins the exact system + user prompt the reply belongs to, so a prompt change can't
 * silently replay a stale answer.
 */
export interface Recording {
  id: string;
  source: 'recorded' | 'authored';
  model: string | null;
  recordedAt: string;
  promptSha256: string;
  /** Raw model text, exactly as returned (may include prose or code fences). */
  reply: string;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const promptHash = (system: string, user: string) => sha256(`${system}\n\u0000\n${user}`);

export type ReplayMode = 'replay' | 'record' | 'rehash';

export function replayMode(): ReplayMode {
  if (process.env.GOLDEN_RECORD === '1') return 'record';
  if (process.env.GOLDEN_REHASH === '1') return 'rehash';
  return 'replay';
}

/**
 * Replays `file`. In record mode it calls the real model (ANTHROPIC_API_KEY / OPENAI_API_KEY) and
 * overwrites the file. In rehash mode it keeps an *authored* reply but refreshes its prompt hash
 * (for intentional prompt edits); recorded replies must be re-recorded instead.
 */
export function replayLlm(file: string, id: string): Llm & { used: () => boolean; lastPrompt: () => { system: string; user: string } | null } {
  const mode = replayMode();
  let used = false;
  let last: { system: string; user: string } | null = null;
  const real = mode === 'record' ? createLlm(loadConfig().router) : null;
  if (mode === 'record' && !real) throw new Error('GOLDEN_RECORD=1 needs ANTHROPIC_API_KEY or OPENAI_API_KEY');
  return {
    used: () => used,
    lastPrompt: () => last,
    async complete(system, user) {
      if (used) throw new Error(`${id}: recording holds one exchange but the router called the LLM twice`);
      used = true;
      last = { system, user };
      const hash = promptHash(system, user);
      if (mode === 'record') {
        const reply = await real!.complete(system, user);
        const cfg = loadConfig().router;
        save(file, { id, source: 'recorded', model: `${cfg.provider}:${cfg.model}`, recordedAt: new Date().toISOString(), promptSha256: hash, reply });
        return reply;
      }
      if (!existsSync(file)) throw new Error(`${id}: no recording at ${file}. Run with GOLDEN_RECORD=1 and an API key.`);
      const rec = JSON.parse(readFileSync(file, 'utf8')) as Recording;
      if (rec.promptSha256 !== hash) {
        if (mode === 'rehash' && rec.source === 'authored') {
          save(file, { ...rec, promptSha256: hash });
          return rec.reply;
        }
        throw new Error(
          `${id}: prompt changed since this reply was ${rec.source}. ` +
            (rec.source === 'recorded' ? 'Re-record with GOLDEN_RECORD=1.' : 'Review the case, then run `npm run golden:rehash`.'),
        );
      }
      return rec.reply;
    },
  };
}

function save(file: string, rec: Recording) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
}
