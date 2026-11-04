import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../src/hub/backoff.js';
import type { HubConfig } from '../../src/hub/config.js';
import { WorkerError, WorkerUnavailable, accountEnv, accountSignedIn, createWorker, type RunResult, type Runner } from '../../src/hub/worker.js';

const cfg = (over: Partial<HubConfig['worker']> = {}): HubConfig['worker'] => ({
  enabled: true,
  accounts: [{ id: 'default', label: 'Default', configDir: null }, { id: 'work', label: 'Work', configDir: '/tmp/work' }],
  activeAccount: 'default',
  sources: [],
  model: 'haiku',
  organizeModel: 'sonnet',
  maxRunsPerDay: 10,
  importRunsPerDay: 10,
  bin: 'claude',
  ...over,
});

const ok = (result: string): RunResult => ({ code: 0, stderr: '', stdout: JSON.stringify({ result, usage: { input_tokens: 12, output_tokens: 3 } }) });

function runner(res: RunResult | Error) {
  const calls: { args: string[]; stdin: string; env: NodeJS.ProcessEnv }[] = [];
  const run: Runner = async (_bin, args, opts) => {
    calls.push({ args, stdin: opts.stdin, env: opts.env });
    if (res instanceof Error) throw res;
    return res;
  };
  return { run, calls };
}

describe('background worker', () => {
  it('is off unless turned on', () => {
    expect(createWorker(cfg({ enabled: false }), 1000)).toBeNull();
  });

  it('runs headless with every tool off and the conversation on stdin, and reports tokens', async () => {
    const { run, calls } = runner(ok('{"summary":"s"}'));
    const worker = createWorker(cfg(), 1000, run)!;
    expect(await worker.complete('SYSTEM', 'CONVERSATION')).toBe('{"summary":"s"}');
    const { args, stdin } = calls[0];
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYSTEM');
    expect(args.join(' ')).not.toContain('CONVERSATION');
    expect(stdin).toBe('CONVERSATION');
    expect(worker.lastUsage).toEqual({ input: 12, output: 3 });
  });

  it('can never bill an API key, and runs as the chosen account', async () => {
    const env = accountEnv({ id: 'work', label: 'Work', configDir: '/tmp/work' }, { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_CONFIG_DIR: '/other', ANTHROPIC_BASE_URL: 'http://elsewhere', PATH: '/bin' });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/tmp/work', PATH: '/bin' });
    const { run, calls } = runner(ok('x'));
    await createWorker(cfg({ activeAccount: 'work' }), 1000, run)!.complete('s', 'u');
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe('/tmp/work');
    await createWorker(cfg(), 1000, run)!.complete('s', 'u');
    expect(calls[1].env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('tells "the account can’t run" apart from a failed run', async () => {
    const fails = async (res: RunResult | Error) => createWorker(cfg(), 1000, runner(res).run)!.complete('s', 'u').catch((e) => e as WorkerError);
    const signedOut = (await fails({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }), stderr: '' })) as WorkerUnavailable;
    expect([signedOut.constructor, signedOut.reason]).toEqual([WorkerUnavailable, 'signed_out']);
    const expired = (await fails({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }), stderr: '' })) as WorkerUnavailable;
    expect(expired.reason).toBe('signed_out');
    const limited = (await fails({ code: 1, stdout: JSON.stringify({ is_error: true, result: "You've hit your usage limit" }), stderr: '' })) as WorkerUnavailable;
    expect(limited.reason).toBe('limit');
    const missing = (await fails(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))) as WorkerUnavailable;
    expect(missing.reason).toBe('not_installed');
    const other = (await fails({ code: 2, stdout: 'not json', stderr: 'boom' })) as WorkerError;
    expect([other.constructor, other.retryable]).toEqual([WorkerError, true]);
  });

  it('reports whether an account is signed in', async () => {
    const c = cfg();
    expect(await accountSignedIn(c, c.accounts[0], runner({ code: 0, stderr: '', stdout: '{"loggedIn":true}' }).run)).toBe(true);
    expect(await accountSignedIn(c, c.accounts[0], runner({ code: 1, stderr: '', stdout: '{"loggedIn":false}' }).run)).toBe(false);
    expect(await accountSignedIn(c, c.accounts[0], runner(new Error('nope')).run)).toBeNull();
  });
});

describe('backoffMs', () => {
  it('grows exponentially with jitter in [exp/2, exp] and respects the cap', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const exp = Math.min(60_000, 1000 * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const v = backoffMs(attempt, 1000, 60_000);
        expect(v).toBeGreaterThanOrEqual(exp / 2);
        expect(v).toBeLessThanOrEqual(exp);
      }
    }
  });
});
