import { spawn } from 'node:child_process';

export type SecurityRunner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs /usr/bin/security. Secrets only ever travel over stdin, never argv (visible to `ps`). */
export function securityRunner(bin = '/usr/bin/security', timeoutMs = 15_000): SecurityRunner {
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(stdin ?? '');
    });
}

const NAME = /^[A-Za-z0-9._:/@-]{1,200}$/;
const NOT_FOUND = 44;

/**
 * Generic passwords in the user's login Keychain, under one service name. Values are stored base64-encoded
 * so `find-generic-password -w` always prints them verbatim, and written with `security -i` reading
 * `add-generic-password ... -X <hex>` from stdin.
 */
export class Keychain {
  constructor(
    readonly service: string,
    private run: SecurityRunner = securityRunner(),
  ) {
    if (!NAME.test(service)) throw new Error('bad keychain service name');
  }

  private check(account: string) {
    if (!NAME.test(account)) throw new Error('bad keychain account name');
  }

  async get(account: string): Promise<string | null> {
    this.check(account);
    const r = await this.run(['find-generic-password', '-s', this.service, '-a', account, '-w']);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`keychain read failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`);
    const raw = r.stdout.replace(/\n$/, '');
    return raw.startsWith('b64:') ? Buffer.from(raw.slice(4), 'base64').toString('utf8') : raw;
  }

  async set(account: string, value: string): Promise<void> {
    this.check(account);
    const hex = Buffer.from(`b64:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8').toString('hex');
    const r = await this.run(['-i'], `add-generic-password -U -s "${this.service}" -a "${account}" -X ${hex}\n`);
    if (r.code !== 0 || /error|fail/i.test(r.stderr)) throw new Error(`keychain write failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`);
  }

  async delete(account: string): Promise<void> {
    this.check(account);
    const r = await this.run(['delete-generic-password', '-s', this.service, '-a', account]);
    if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`keychain delete failed (${r.code})`);
  }
}
