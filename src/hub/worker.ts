import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { HubConfig, WorkerAccount } from './config.js';

/**
 * The hub has no AI of its own and no API keys. To read a conversation it wakes an agent you already pay for:
 * Claude Code in headless mode, signed in with your subscription, with every tool switched off. It can only
 * answer with text, so a message trying to trick it has nothing to act with.
 */
export interface Worker {
  /** Returns the agent's raw text reply. Callers are responsible for parsing. */
  complete(system: string, user: string): Promise<string>;
  /** Token counts from the last run, when the agent reports them. */
  lastUsage?: { input: number; output: number } | null;
}

/** Thrown for every worker failure so the router can decide between retry-with-backoff and dead-lettering. */
export class WorkerError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Suggested wait before trying again. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

/** The account can't run right now (signed out, usage limit, not installed). No event is at fault, so nothing burns a retry. */
export class WorkerUnavailable extends WorkerError {
  constructor(
    message: string,
    readonly reason: 'signed_out' | 'limit' | 'not_installed',
    retryAfterMs: number,
  ) {
    super(message, true, retryAfterMs);
    this.name = 'WorkerUnavailable';
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type Runner = (bin: string, args: string[], opts: { stdin: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<RunResult>;

const defaultRunner: Runner = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: tmpdir(), env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: opts.timeoutMs, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.stdin);
  });

/** launchd and other minimal environments don't have the installer's directory on PATH. */
export function claudeBin(configured: string | null): string {
  if (configured) return configured;
  const local = path.join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

/**
 * Only the chosen account may run. API settings are removed so a key or endpoint that happens to be in the
 * environment can never turn a subscription run into a metered bill.
 */
export function accountEnv(account: WorkerAccount | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CONFIG_DIR') delete env[k];
  if (account?.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  return env;
}

const LIMIT_WAIT_MS = 30 * 60_000;

function unavailable(text: string): WorkerUnavailable | null {
  if (/not logged in|\/login|invalid api key|authenticat|unauthorized|oauth/i.test(text)) {
    return new WorkerUnavailable('The worker account is signed out', 'signed_out', LIMIT_WAIT_MS);
  }
  if (/usage limit|limit reached|hit your .*limit|rate.?limit|resets? (at|in)|overloaded|credit balance/i.test(text)) {
    return new WorkerUnavailable('The worker account hit a usage limit', 'limit', LIMIT_WAIT_MS);
  }
  return null;
}

export function createWorker(cfg: HubConfig['worker'], timeoutMs: number, run: Runner = defaultRunner): Worker | null {
  if (!cfg.enabled) return null;
  const worker: Worker = {
    lastUsage: null,
    async complete(system, user) {
      const account = cfg.accounts.find((a) => a.id === cfg.activeAccount);
      const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', '--model', cfg.model, '--system-prompt', system];
      let res: RunResult;
      try {
        res = await run(claudeBin(cfg.bin), args, { stdin: user, env: accountEnv(account), timeoutMs });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkerUnavailable('Claude Code is not installed', 'not_installed', LIMIT_WAIT_MS);
        throw new WorkerError(`worker failed to start: ${(err as Error).message}`, true);
      }
      let envelope: { result?: string; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number } } | null = null;
      try {
        envelope = JSON.parse(res.stdout);
      } catch {
        envelope = null;
      }
      if (res.code !== 0 || !envelope || envelope.is_error) {
        // Only the agent's own status text is inspected and kept. Conversation text never reaches stderr.
        const detail = `${envelope?.result ?? ''} ${res.stderr}`.trim().slice(0, 300);
        throw unavailable(detail) ?? new WorkerError(`worker exited ${res.code ?? 'on timeout'}: ${detail}`, true);
      }
      worker.lastUsage = envelope.usage ? { input: envelope.usage.input_tokens ?? 0, output: envelope.usage.output_tokens ?? 0 } : null;
      return envelope.result ?? '';
    },
  };
  return worker;
}

/** Is this account signed in? null when Claude Code isn't installed or didn't answer. */
export async function accountSignedIn(cfg: HubConfig['worker'], account: WorkerAccount, run: Runner = defaultRunner): Promise<boolean | null> {
  try {
    const res = await run(claudeBin(cfg.bin), ['auth', 'status'], { stdin: '', env: accountEnv(account), timeoutMs: 8000 });
    return Boolean((JSON.parse(res.stdout) as { loggedIn?: boolean }).loggedIn);
  } catch {
    return null;
  }
}

/** Pulls the first JSON object out of an agent's reply (tolerates code fences / prose around it). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new WorkerError('no JSON object in worker reply', true);
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    // V8's message quotes part of the input, which is conversation content; keep only the position.
    const at = /position (\d+)/.exec((err as Error).message)?.[1];
    throw new WorkerError(`malformed JSON in worker reply${at ? ` at position ${at}` : ''}`, true);
  }
}
