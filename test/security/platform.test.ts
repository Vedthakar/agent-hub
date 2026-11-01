import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { ChatDb } from '../../src/daemon/chatdb.js';
import { normalizeHandle } from '../../src/shared/handles.js';
import { Daemon, httpHubClient, type DaemonState } from '../../src/daemon/daemon.js';
import { loadConfig } from '../../src/hub/config.js';
import { twilioSignature } from '../../src/hub/transports/sms.js';
import { createLogger, setLogSink } from '../../src/shared/log.js';
import { buildChatDb } from '../fixtures/chatdb.js';
import { HANDLES, minutesFromNow, msg } from '../helpers.js';
import { backend } from '../support/db.js';
import { dashboardLogin, mcpClient, onCleanup, secureHub } from './harness.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HUB_TABLES = [...readFileSync(path.join(ROOT, 'src/hub/schema.sql'), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const srcFiles = (dir = path.join(ROOT, 'src')): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : [p];
  });
const tracked = () => execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

const onSupabase = backend() === 'supabase' ? it : it.skip;

describe('Supabase: RLS, keys and secrets', () => {
  onSupabase('SB-01 row-level security is on for every table, and anon / authenticated / service_role can touch none of them', async () => {
    const h = await secureHub();
    const sql = postgres(h.databaseUrl!, { max: 1, onnotice: () => {} });
    onCleanup(() => sql.end({ timeout: 5 }));
    const rls = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    expect(rls.map((r) => r.relname).sort()).toEqual([...HUB_TABLES].sort());
    expect(rls.filter((r) => !r.relrowsecurity)).toEqual([]);
    expect(await sql`SELECT policyname FROM pg_policies WHERE schemaname = 'public'`).toEqual([]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const t of HUB_TABLES) {
        const [p] = await sql<{ s: boolean; i: boolean; u: boolean; d: boolean }[]>`
          SELECT has_table_privilege(${role}, ${'public.' + t}, 'SELECT') AS s, has_table_privilege(${role}, ${'public.' + t}, 'INSERT') AS i,
                 has_table_privilege(${role}, ${'public.' + t}, 'UPDATE') AS u, has_table_privilege(${role}, ${'public.' + t}, 'DELETE') AS d`;
        expect(p, `${role} on ${t}`).toEqual({ s: false, i: false, u: false, d: false });
      }
      await expect(sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx.unsafe('SELECT * FROM tasks');
      })).rejects.toThrow(/permission denied/);
    }
  });

  it('SB-02 no service key, JWT or Supabase client library anywhere in the source', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith('@supabase/'))).toEqual([]);
    for (const f of [...srcFiles(), ...readdirSync(path.join(ROOT, 'scripts')).map((f) => path.join(ROOT, 'scripts', f))]) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/);
      expect(text, f).not.toMatch(/SERVICE_ROLE_KEY|SUPABASE_SERVICE|supabase-js|createClient\(/);
      if (!f.endsWith('schema.sql')) expect(text, f).not.toMatch(/service_role/);
    }
  });

  it('SB-03 secrets live only in env: .env / smoke.env are ignored and untracked, and no secret-shaped strings are committed', () => {
    const files = tracked();
    expect(files.filter((f) => /(^|\/)(\.env(\..+)?|smoke\.env|.*\.(pem|key|p12|session))$/.test(f) && !f.endsWith('.example'))).toEqual([]);
    const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
    for (const rule of ['.env', '.env.*', 'smoke.env', '*.session', 'state.json.*']) expect(ignore).toContain(rule);
    const SECRET = /(sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\d{8,10}:AA[A-Za-z0-9_-]{30,})/;
    for (const f of files) {
      if (!existsSync(path.join(ROOT, f)) || /\.(png|jpg|ico|lock)$/.test(f) || f.endsWith('package-lock.json')) continue;
      expect(readFileSync(path.join(ROOT, f), 'utf8'), f).not.toMatch(SECRET);
    }
    for (const example of ['.env.example', 'smoke.env.example']) {
      const vals = readFileSync(path.join(ROOT, example), 'utf8').split('\n').filter((l) => /^[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|HASH|SESSION)[A-Z_]*=/.test(l)).map((l) => l.split('=').slice(1).join('=').split('#')[0].trim());
      for (const v of vals) expect(v.length < 12 || /change-me|your-|example|<|\$\{|\.\.\./.test(v), `${example}: ${v}`).toBe(true);
    }
  });

  it('SB-04 config has no built-in secrets: with an empty environment every credential is empty', () => {
    const cfg = loadConfig({});
    expect([cfg.ownerPassword, cfg.daemonToken, cfg.router.apiKey ?? '', cfg.approval.twilio.authToken ?? '', cfg.approval.telegramBotToken ?? '', cfg.grokWebhookSecret ?? '']).toEqual(['', '', '', '', '', '']);
    expect(Object.keys(cfg.agentTokens)).toEqual([]);
    // No session key in env means a random one per process (replaced by the stored key once the secret store loads).
    expect(cfg.ephemeralSessionSecret).toBe(true);
    expect(loadConfig({}).sessionSecret).not.toBe(cfg.sessionSecret);
    // Production may start with no credentials (they're set in the dashboard), but never with the .env.example placeholders.
    expect(() => loadConfig({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production', HUB_OWNER_PASSWORD: 'change-me' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production', HUB_DAEMON_TOKEN: 'change-me-too' })).toThrow();
  });
});

describe('SQL injection', () => {
  it('SQ-01 every query is parameterised: no interpolated values in SQL strings', () => {
    const offenders: string[] = [];
    for (const f of srcFiles().filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/`([^`]*\b(?:SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE TABLE|DROP TABLE)\b[^`]*)`/g)) {
        for (const i of m[1].matchAll(/\$\{([^}]*)\}/g)) offenders.push(`${path.relative(ROOT, f)}: \${${i[1]}}`);
      }
    }
    // The one allowed interpolation picks from fixed string literals in code (store.transitionTask).
    expect(offenders).toEqual(['src/hub/store.ts: ${stamp}']);
  });

  const PAYLOADS = [
    "'; DROP TABLE tasks; --",
    "Robert'); DELETE FROM raw_messages; --",
    "x' OR '1'='1",
    '1; UPDATE settings SET value = \'true\'',
    "$1) OR (1=1",
    "\\'; SELECT pg_sleep(3); --",
    '%_%',
    '"; DROP TABLE scopes; --',
    'nul\u0000byte',
  ];

  it('SQ-02 hostile strings through every entry point are stored literally and leave every table intact', async () => {
    const h = await secureHub({ APPROVAL_CHANNEL: 'imessage', TWILIO_AUTH_TOKEN: 'tw', APPROVAL_USER_NUMBER: '+15551234567' });
    const seed = await h.store.createTask({ originAgent: 'instinct', targetAgent: 'grok', payload: 'seed', rationale: '', topics: ['work'], author: 'user', originEventId: null, hop: 1, status: 'proposed' });
    const auth = { authorization: 'Bearer daemon-token', 'content-type': 'application/json' };
    const session = await dashboardLogin(h.url);
    const claude = await mcpClient(h.url, 'claude-token');
    const statuses: number[] = [];
    for (const [i, p] of PAYLOADS.entries()) {
      // Mac daemon ingest: handle, guid and text.
      const ingest = await fetch(`${h.url}/daemon/ingest`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ messages: [{ ...msg(HANDLES.instinct, `msg ${p}`, { guid: `g-${i}-${p}` }) }, { ...msg(p, p) }, { ...msg(HANDLES.approval, `Y ${p}`, { fromMe: true }) }] }),
      });
      statuses.push(ingest.status);
      // Approval channels.
      await h.hub.handleInbound({ channel: 'imessage', externalId: p, fromOwner: true, sender: p, text: `Y ${p}` });
      const tw = { From: p, Body: `Y ${p}`, MessageSid: `SM${i}${p}` };
      statuses.push((await fetch(`${h.url}/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('tw', `${h.cfg.publicUrl}/twilio/sms`, tw) }, body: new URLSearchParams(tw) })).status);
      // MCP tools.
      await claude('log_session', { summary: p, task_code: p, transcript_excerpt: p });
      await claude('update_task', { task_code: p, status: 'done', result: p });
      await claude('propose_task', { target_agent: 'stanley', task: `Script about ${p}`, task_code: p, topics: ['content'] });
      // Dashboard routes and params.
      const enc = encodeURIComponent(p);
      for (const route of [`/actions/task/${enc}/approve`, `/actions/task/${enc}/${enc}`, `/actions/situation/${enc}/expire`, `/actions/dead-letter/${enc}/retry`, `/actions/scope/${enc}`]) {
        statuses.push((await fetch(`${h.url}${route}`, { method: 'POST', redirect: 'manual', headers: session, body: new URLSearchParams({ allow: p, deny: p, autonomy: p }) })).status);
      }
      statuses.push((await fetch(`${h.url}/actions/route`, { method: 'POST', redirect: 'manual', headers: session, body: new URLSearchParams({ origin: p, target: p, autonomy: p }) })).status);
      statuses.push((await fetch(`${h.url}/timeline?agent=${enc}&q=${enc}`, { headers: { cookie: session.cookie } })).status);
      statuses.push((await fetch(`${h.url}/health/${enc}`)).status);
      // OAuth.
      statuses.push((await fetch(`${h.url}/oauth/consent`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: p, redirect_uri: p, password: p, agent: p, decision: 'allow' }) })).status);
      statuses.push((await fetch(`${h.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: p, client_id: p }) })).status);
    }
    await h.hub.collectBursts(minutesFromNow(11));
    await h.hub.tick();
    await h.hub.idle();

    expect(statuses.filter((s) => s >= 500)).toEqual([]);
    const tables = await h.store.db.query<{ relname: string }>("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind = 'r'");
    expect(tables.map((t) => t.relname).sort()).toEqual([...HUB_TABLES].sort());
    expect((await h.store.scopes()).size).toBe(7);
    expect(await h.store.isPaused()).toBe(false);
    expect((await h.store.task(seed.id))!.status).toBe('proposed');
    const stored = (await h.store.db.query<{ text: string }>('SELECT text FROM raw_messages ORDER BY id')).map((r) => r.text);
    for (const p of PAYLOADS) expect(stored).toContain(`msg ${p.replace(/\u0000/g, '')}`);
    // The scope form's free-text fields can't smuggle SQL either: unknown agents are refused outright.
    expect((await h.store.scope('boardy'))!.deny_topics).toEqual(['school', 'health', 'finances', 'personal']);
  });
});

describe('chat.db', () => {
  it('CD-01 the daemon opens chat.db read-only and never changes it', async () => {
    const h = await secureHub();
    const dir = mkdtempSync(path.join(tmpdir(), 'hub-sec-'));
    onCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const chat = buildChatDb(path.join(dir, 'chat.db'));
    for (let i = 0; i < 20; i++) chat.add({ handle: HANDLES.instinct, text: `hello ${i}`, fromMe: i % 2 === 0 });
    // Messages.app keeps the database open (and its WAL populated) while the daemon reads.
    onCleanup(() => chat.close());
    expect(statSync(path.join(dir, 'chat.db-wal')).size).toBeGreaterThan(0);
    const digest = () =>
      ['chat.db', 'chat.db-wal'].map((f) => (existsSync(path.join(dir, f)) ? createHash('sha256').update(readFileSync(path.join(dir, f))).digest('hex') : 'absent')).join(',');
    const before = digest();
    const mtime = statSync(path.join(dir, 'chat.db')).mtimeMs;

    let state: DaemonState | null = { lastRowId: 0, knownHandles: [] };
    const daemon = new Daemon({
      chatDbPath: path.join(dir, 'chat.db'),
      hub: httpHubClient(h.url, 'daemon-token'),
      state: { load: async () => state, save: async (s) => void (state = structuredClone(s)) },
      send: async () => {},
      log: createLogger({ test: true }),
    });
    for (let i = 0; i < 3; i++) expect((await daemon.cycle()).error).toBeNull();
    daemon.close();
    expect(digest()).toBe(before);
    expect(statSync(path.join(dir, 'chat.db')).mtimeMs).toBe(mtime);
    expect((await h.store.db.query('SELECT 1 FROM raw_messages')).length).toBe(20);

    const reader = new ChatDb(path.join(dir, 'chat.db'));
    const inner = (reader as unknown as { db: { exec(s: string): void } }).db;
    for (const stmt of ["INSERT INTO message (text) VALUES ('x')", 'DELETE FROM message', 'DROP TABLE message', 'PRAGMA journal_mode = DELETE', "ATTACH DATABASE '" + path.join(dir, 'x.db') + "' AS x"]) {
      expect(() => inner.exec(stmt), stmt).toThrow();
    }
    expect(existsSync(path.join(dir, 'x.db'))).toBe(false);
  });

  it('CD-02 chat.db queries bind values; handles with quotes or SQL are just strings', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hub-sec-'));
    onCleanup(() => rmSync(dir, { recursive: true, force: true }));
    const chat = buildChatDb(path.join(dir, 'chat.db'));
    chat.add({ handle: HANDLES.instinct, text: 'ok', fromMe: false });
    chat.add({ handle: "x' OR '1'='1", text: 'evil handle', fromMe: false });
    chat.close();
    const reader = new ChatDb(path.join(dir, 'chat.db'));
    const res = reader.readSince(0, new Set(["' OR 1=1 --", "x' OR '1'='1"].map(normalizeHandle)));
    expect(res.messages.map((m) => [m.handle, m.text])).toEqual([["x' OR '1'='1", 'evil handle']]);
    expect(reader.readSince(0, new Set(["') OR 1=1 --"])).messages).toEqual([]);
  });
});

describe('logs', () => {
  it('LG-01 no message body reaches the logs, across ingest, routing failures, approvals, delivery failures and MCP', async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    const level = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    onCleanup(() => {
      restore();
      process.env.LOG_LEVEL = level;
    });
    const h = await secureHub({ ROUTER_MAX_ATTEMPTS: '1' });
    const SECRET = 'BODYMARK';
    // Ingest over HTTP, as the daemon does.
    await fetch(`${h.url}/daemon/ingest`, {
      method: 'POST',
      headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [msg(HANDLES.instinct, `my ${SECRET}1 midterm`, { fromMe: true }), msg(HANDLES.approval, `Y ${SECRET}2`, { fromMe: true })] }),
    });
    // The model echoes the conversation back as garbage, then the provider errors.
    h.llm.next.push(() => `not json ${SECRET}3`);
    await h.hub.collectBursts(minutesFromNow(11));
    await h.hub.routePending();
    const failing = { complete: async () => { throw new Error('upstream 500'); } };
    (h.hub as unknown as { llm: unknown }).llm = failing;
    await h.store.insertEvent({ agent: 'claude', occurredAt: new Date(), author: 'agent', rawExcerpt: `${SECRET}4`, summary: `${SECRET}5`, topics: [], kind: 'session' });
    await h.hub.routePending();
    // Delivery failure with the payload in hand.
    h.telegram.failWith = 'telegram 500';
    await h.store.createTask({ originAgent: 'claude', targetAgent: 'stanley', payload: `${SECRET}6 script`, rationale: '', topics: ['content'], author: 'user', originEventId: null, hop: 1, status: 'approved' });
    await h.hub.dispatchApproved();
    // MCP traffic.
    const claude = await mcpClient(h.url, 'claude-token');
    await claude('log_session', { summary: `${SECRET}7`, transcript_excerpt: `${SECRET}8` });
    await claude('propose_task', { target_agent: 'stanley', task: `${SECRET}9`, topics: ['content'] });
    await h.hub.tick();
    await h.hub.idle();

    expect(lines.length).toBeGreaterThan(3);
    expect(lines.filter((l) => l.includes(SECRET))).toEqual([]);
  });
});
