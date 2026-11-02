import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { log } from '../shared/log.js';
import { CUSTOM_AGENT_ID, isAgentId, type AgentId, type CustomAgentId } from '../shared/types.js';
import { registerCustomAgents } from './adapters/index.js';
import type { CustomAgentDef } from './adapters/custom.js';
import type { HubConfig } from './config.js';
import { safeEqual } from './crypto.js';
import { customDefaultScope } from './scopes.js';
import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Env = Record<string, string | undefined>;

/** One setting the dashboard can edit. Secret fields go to the secret store; the rest to `settings`. */
interface Field {
  secret: boolean;
  /** The env var that overrides it (shown as "set in .env"), if any. */
  env: string | null;
  envSet(env: Env): boolean;
  write(cfg: HubConfig, value: string): void;
}

const has = (env: Env, name: string) => Boolean(env[name]?.trim());
const mapHas = (env: Env, name: string, agent: string) =>
  (env[name] ?? '').split(',').some((p) => p.trim().startsWith(`${agent}:`) && p.slice(p.indexOf(':') + 1).trim() !== '');

function field(env: string | null, write: Field['write'], secret = false): Field {
  return { secret, env, envSet: (e) => (env ? has(e, env) : false), write };
}

const LINK_LABELS = { linkedin: 'LinkedIn', x: 'X', github: 'GitHub', website: 'Website' } as const;

const FIELDS: Record<string, Field> = {
  'owner.name': field('HUB_OWNER_NAME', (c, v) => (c.ownerName = v)),
  'owner.timezone': field('HUB_TIMEZONE', (c, v) => (c.timezone = v)),
  'approval.handle': {
    ...field('APPROVAL_IMESSAGE_HANDLE', (c, v) => {
      c.approval.imessageHandle = v;
      if (c.approval.channel === 'none') c.approval.channel = 'imessage';
    }),
  },
  'router.provider': field('ROUTER_PROVIDER', (c, v) => {
    if (v !== 'anthropic' && v !== 'openai') return;
    if (c.router.provider !== v) c.router.model = v === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5';
    c.router.provider = v;
  }),
  'router.key': {
    secret: true,
    env: 'ANTHROPIC_API_KEY',
    envSet: (e) => has(e, 'ANTHROPIC_API_KEY') || has(e, 'OPENAI_API_KEY'),
    write: (c, v) => {
      c.router.apiKey = v;
      if (c.router.provider === 'none') c.router.provider = v.startsWith('sk-ant-') ? 'anthropic' : 'openai';
      if (!c.router.model) c.router.model = c.router.provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5';
    },
  },
  'email.provider': field(null, () => undefined),
  'email.from': field('EMAIL_FROM', (c, v) => (c.email.from = v)),
  'email.smtp': field('SMTP_URL', (c, v) => (c.email.smtpUrl = v), true),
  'email.imap': field('IMAP_URL', (c, v) => (c.imap.url = v), true),
  'instinct.email': field('INSTINCT_EMAIL', (c, v) => (c.instinctEmail = v)),
  'boardy.email': field('BOARDY_EMAIL', (c, v) => (c.boardyEmail = v)),
  'profile.fullName': field('OWNER_FULL_NAME', (c, v) => (c.owner.fullName = v)),
  'profile.bio': field('OWNER_BIO', (c, v) => (c.owner.bio = v)),
  'profile.offer': field('OWNER_OFFER', (c, v) => (c.owner.offer = v)),
  'profile.location': field('OWNER_LOCATION', (c, v) => (c.owner.location = v)),
  'profile.keepPrivate': field('OWNER_KEEP_PRIVATE', (c, v) => (c.owner.keepPrivate = v)),
  ...Object.fromEntries(
    Object.entries(LINK_LABELS).map(([k, label]) => [
      `profile.link.${k}`,
      field('OWNER_LINKS', (c, v) => {
        c.owner.links = [...c.owner.links.filter((l) => l.label !== label), { label, url: v }];
      }),
    ]),
  ),
  'stanley.apiId': field('TELEGRAM_API_ID', (c, v) => (c.stanley.apiId = Number(v) || null)),
  'stanley.apiHash': field('TELEGRAM_API_HASH', (c, v) => (c.stanley.apiHash = v), true),
  'stanley.session': field('TELEGRAM_SESSION', (c, v) => (c.stanley.session = v), true),
  'stanley.peer': field('STANLEY_TELEGRAM_PEER', (c, v) => (c.stanley.peer = v)),
  'stanley.account': field(null, () => undefined),
  'grok.webhookUrl': field('GROK_WEBHOOK_URL', (c, v) => (c.grokWebhookUrl = v)),
  'grok.webhookSecret': field('GROK_WEBHOOK_SECRET', (c, v) => (c.grokWebhookSecret = v), true),
  'hub.sessionSecret': field('HUB_SESSION_SECRET', (c, v) => {
    c.sessionSecret = v;
    c.ephemeralSessionSecret = false;
  }, true),
};

/** Fields keyed by agent: `handle.<agent>`, `token.<agent>`, `hook.<agent>.url|secret`. */
function fieldFor(key: string): Field | null {
  if (FIELDS[key]) return FIELDS[key];
  let m = /^handle\.(instinct|stanley|boardy)$/.exec(key);
  if (m) {
    const agent = m[1] as AgentId;
    return { secret: false, env: 'IMESSAGE_HANDLES', envSet: (e) => mapHas(e, 'IMESSAGE_HANDLES', agent), write: (c, v) => (c.imessageHandles[agent] = v) };
  }
  m = /^token\.(grok|custom-[a-z0-9-]+)$/.exec(key);
  if (m) {
    const agent = m[1] as AgentId;
    return { secret: true, env: 'HUB_AGENT_TOKENS', envSet: (e) => mapHas(e, 'HUB_AGENT_TOKENS', agent), write: (c, v) => (c.agentTokens[agent] = v) };
  }
  m = /^hook\.(custom-[a-z0-9-]+)\.(url|secret)$/.exec(key);
  if (m) {
    const agent = m[1] as CustomAgentId;
    const part = m[2] as 'url' | 'secret';
    return {
      secret: part === 'secret',
      env: null,
      envSet: () => false,
      write: (c, v) => (c.agentWebhooks[agent] = { url: null, secret: null, ...c.agentWebhooks[agent], [part]: v }),
    };
  }
  return null;
}

export class EnvLockedError extends Error {
  constructor(readonly key: string, readonly envVar: string | null) {
    super(`${key} is set by ${envVar ?? 'the environment'} on the server; change it there`);
  }
}

export interface OnboardingState {
  completed: boolean;
  /** Agents picked in the wizard, in order. */
  agents: AgentId[];
  /** Where the owner left off. */
  step?: string;
}

interface PasswordHash {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PAIRING_TTL_MS = 15 * 60_000;
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Everything the Connections page and onboarding wizard configure. UI values are layered over the env
 * config (env always wins) and applied to the live HubConfig, so changes take effect without a restart.
 */
export class Connections {
  private values: Record<string, string> = {};
  private secretValues: Record<string, string> = {};
  private base: HubConfig;
  private daemonTokenHashes: string[] = [];
  private ownerHash: PasswordHash | null = null;
  custom: CustomAgentDef[] = [];
  onboarding: OnboardingState = { completed: false, agents: [] };
  /** Unlocks first-run password creation. Kept until a password exists so a restart doesn't kill the setup link. */
  setupToken = randomBytes(18).toString('base64url');
  /** Set when the secret store couldn't be read (e.g. a locked Keychain). */
  secretError: string | null = null;
  onChange: (() => void | Promise<void>) | null = null;

  constructor(
    readonly store: Store,
    readonly secrets: SecretStore | null,
    readonly cfg: HubConfig,
    readonly env: Env = {},
  ) {
    this.base = structuredClone(cfg);
  }

  async load(): Promise<void> {
    const s = this.store;
    this.values = await s.getSetting<Record<string, string>>('connections.values', {});
    this.custom = (await s.getSetting<CustomAgentDef[]>('agents.custom', [])).filter((d) => CUSTOM_AGENT_ID.test(d.id));
    this.onboarding = { completed: false, agents: [], ...(await s.getSetting<Partial<OnboardingState>>('onboarding', {})) };
    this.ownerHash = await s.getSetting<PasswordHash | null>('owner.password', null);
    this.daemonTokenHashes = await s.getSetting<string[]>('daemon.tokens', []);
    if (!this.hasOwnerPassword()) {
      const stored = await s.getSetting<string | null>('owner.setupToken', null);
      if (stored) this.setupToken = stored;
      else await s.setSetting('owner.setupToken', this.setupToken);
    } else {
      await s.setSetting('owner.setupToken', null);
    }
    this.secretValues = {};
    if (this.secrets) {
      try {
        for (const key of await s.getSetting<string[]>('connections.secrets', [])) {
          const v = await this.secrets.get(`cfg.${key}`);
          if (v !== null) this.secretValues[key] = v;
        }
        if (this.cfg.ephemeralSessionSecret && !this.secretValues['hub.sessionSecret']) {
          await this.writeSecret('hub.sessionSecret', randomBytes(32).toString('base64url'));
        }
        this.secretError = null;
      } catch (err) {
        this.secretError = String(err instanceof Error ? err.message : err);
        log.error('connections.secret_store_failed', { store: this.secrets.kind, error: this.secretError });
      }
    }
    registerCustomAgents(this.custom);
    for (const d of this.custom) await s.ensureScope(d.id, customDefaultScope([]));
    this.apply();
  }

  /** Rebuilds the live config: env/defaults first, then every UI value that env doesn't override. */
  apply(): void {
    const c = this.cfg;
    const b = structuredClone(this.base);
    Object.assign(c, {
      ownerName: b.ownerName,
      timezone: b.timezone,
      sessionSecret: b.sessionSecret,
      ephemeralSessionSecret: b.ephemeralSessionSecret,
      agentTokens: b.agentTokens,
      imessageHandles: b.imessageHandles,
      instinctEmail: b.instinctEmail,
      boardyEmail: b.boardyEmail,
      grokWebhookUrl: b.grokWebhookUrl,
      grokWebhookSecret: b.grokWebhookSecret,
      agentWebhooks: b.agentWebhooks,
      owner: b.owner,
      stanley: b.stanley,
    });
    Object.assign(c.approval, { channel: b.approval.channel, imessageHandle: b.approval.imessageHandle });
    Object.assign(c.router, { provider: b.router.provider, apiKey: b.router.apiKey, model: b.router.model });
    Object.assign(c.email, b.email);
    Object.assign(c.imap, b.imap);

    const all = { ...this.values, ...this.secretValues };
    // Provider before key, so the key's default provider only kicks in when none was chosen.
    const order = Object.keys(all).sort((a, b) => (a === 'router.provider' ? -1 : b === 'router.provider' ? 1 : 0));
    for (const key of order) {
      const f = fieldFor(key);
      if (!f || f.envSet(this.env)) continue;
      f.write(c, all[key]);
    }
    if (all['owner.name'] && !this.env.OWNER_FULL_NAME && !all['profile.fullName']) c.owner.fullName = c.ownerName;
  }

  /** Current value of a non-secret field (UI or env). Secrets are never returned. */
  value(key: string): string | null {
    const f = fieldFor(key);
    if (!f || f.secret) return null;
    if (f.envSet(this.env)) return null;
    return this.values[key] ?? null;
  }

  isSet(key: string): boolean {
    const f = fieldFor(key);
    if (!f) return false;
    return f.envSet(this.env) || key in this.values || key in this.secretValues;
  }

  source(key: string): 'env' | 'ui' | null {
    const f = fieldFor(key);
    if (!f) return null;
    if (f.envSet(this.env)) return 'env';
    return key in this.values || key in this.secretValues ? 'ui' : null;
  }

  envVar(key: string): string | null {
    return fieldFor(key)?.env ?? null;
  }

  /** Reads a secret this hub generated, so the UI can show it right after generation. */
  generatedSecret(key: string): string | null {
    return this.secretValues[key] ?? null;
  }

  private async writeSecret(key: string, value: string | null) {
    if (!this.secrets) throw new Error('no secret store is configured on this hub');
    const names = new Set(await this.store.getSetting<string[]>('connections.secrets', []));
    if (value === null) {
      await this.secrets.delete(`cfg.${key}`);
      delete this.secretValues[key];
      names.delete(key);
    } else {
      await this.secrets.set(`cfg.${key}`, value);
      this.secretValues[key] = value;
      names.add(key);
    }
    await this.store.setSetting('connections.secrets', [...names].sort());
  }

  /** Saves several fields at once. Empty strings clear. Throws EnvLockedError before writing anything if env owns one. */
  async setMany(patch: Record<string, string | null | undefined>, actor = 'owner'): Promise<void> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [string, string | null][];
    for (const [key] of entries) {
      const f = fieldFor(key);
      if (!f) throw new Error(`unknown setting ${key}`);
      if (f.envSet(this.env)) throw new EnvLockedError(key, f.env);
    }
    let valuesChanged = false;
    for (const [key, raw] of entries) {
      const v = raw === null ? null : raw.trim() || null;
      if (fieldFor(key)!.secret) await this.writeSecret(key, v);
      else {
        if (v === null) delete this.values[key];
        else this.values[key] = v;
        valuesChanged = true;
      }
    }
    if (valuesChanged) await this.store.setSetting('connections.values', this.values);
    await this.store.audit(actor, 'connection.updated', { keys: entries.map(([k]) => k) });
    this.apply();
    await this.onChange?.();
  }

  async set(key: string, value: string | null, actor = 'owner'): Promise<void> {
    await this.setMany({ [key]: value }, actor);
  }

  // ---------- owner password ----------

  hasOwnerPassword(): boolean {
    return Boolean(this.cfg.ownerPassword) || this.ownerHash !== null;
  }

  async verifyOwnerPassword(password: string): Promise<boolean> {
    if (this.cfg.ownerPassword) return safeEqual(password, this.cfg.ownerPassword);
    const h = this.ownerHash;
    if (!h || !password) return false;
    const got = await scrypt(password, Buffer.from(h.salt, 'base64'), 32, { N: h.N, r: h.r, p: h.p, maxmem: SCRYPT.maxmem });
    const want = Buffer.from(h.hash, 'base64');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** First-run only (no env password, none stored yet), unlocked by the setup token from the server log. */
  async createOwnerPassword(password: string, setupToken: string): Promise<'ok' | 'exists' | 'bad-token' | 'weak'> {
    if (this.hasOwnerPassword()) return 'exists';
    if (!safeEqual(setupToken, this.setupToken)) return 'bad-token';
    if (password.length < 10) return 'weak';
    await this.storePassword(password);
    await this.store.setSetting('owner.setupToken', null);
    await this.store.audit('owner', 'owner.password_created', {});
    return 'ok';
  }

  async changeOwnerPassword(current: string, next: string): Promise<'ok' | 'env' | 'wrong' | 'weak'> {
    if (this.cfg.ownerPassword) return 'env';
    if (!(await this.verifyOwnerPassword(current))) return 'wrong';
    if (next.length < 10) return 'weak';
    await this.storePassword(next);
    // Rotating the session secret signs everyone out, including any stolen session.
    if (this.secrets && !this.env.HUB_SESSION_SECRET) await this.writeSecret('hub.sessionSecret', randomBytes(32).toString('base64url'));
    this.apply();
    await this.store.audit('owner', 'owner.password_changed', {});
    return 'ok';
  }

  private async storePassword(password: string) {
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 32, SCRYPT);
    this.ownerHash = { alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), hash: hash.toString('base64') };
    await this.store.setSetting('owner.password', this.ownerHash);
  }

  // ---------- Mac daemon pairing ----------

  /** A one-time code the daemon trades for its own token. Replaces any earlier unused code. */
  async createPairingCode(): Promise<string> {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)];
    await this.store.setSetting('daemon.pairing', { hash: sha256(raw), expiresAt: Date.now() + PAIRING_TTL_MS });
    await this.store.audit('owner', 'daemon.pairing_code_created', {});
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }

  async redeemPairingCode(code: string): Promise<string | null> {
    const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const p = await this.store.getSetting<{ hash: string; expiresAt: number } | null>('daemon.pairing', null);
    if (!p || p.expiresAt < Date.now() || !safeEqual(sha256(raw), p.hash)) {
      await this.store.audit('hub', 'daemon.pairing_failed', {});
      return null;
    }
    await this.store.setSetting('daemon.pairing', null);
    const token = `hubd_${randomBytes(32).toString('base64url')}`;
    this.daemonTokenHashes = [...this.daemonTokenHashes, sha256(token)].slice(-5);
    await this.store.setSetting('daemon.tokens', this.daemonTokenHashes);
    await this.store.audit('hub', 'daemon.paired', {});
    return token;
  }

  verifyDaemonToken(token: string): boolean {
    if (!token) return false;
    if (this.cfg.daemonToken && safeEqual(token, this.cfg.daemonToken)) return true;
    const h = sha256(token);
    return this.daemonTokenHashes.some((x) => safeEqual(x, h));
  }

  hasPairedDaemon(): boolean {
    return Boolean(this.cfg.daemonToken) || this.daemonTokenHashes.length > 0;
  }

  async unpairDaemons(): Promise<void> {
    this.daemonTokenHashes = [];
    await this.store.setSetting('daemon.tokens', []);
    await this.store.audit('owner', 'daemon.unpaired', {});
  }

  // ---------- custom agents ----------

  async addCustomAgent(input: { name: string; profile: string; topics: string[] }): Promise<CustomAgentDef> {
    const name = input.name.trim().slice(0, 60);
    if (!name) throw new Error('name is required');
    const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';
    let id = `custom-${base}` as CustomAgentId;
    for (let n = 2; isAgentId(id) || this.custom.some((d) => d.id === id); n++) id = `custom-${base}-${n}` as CustomAgentId;
    if (!CUSTOM_AGENT_ID.test(id)) throw new Error('could not make an id from that name');
    const def: CustomAgentDef = { id, name, profile: input.profile.trim().slice(0, 400) || `${name}: a custom agent.`, createdAt: new Date().toISOString() };
    this.custom = [...this.custom, def];
    await this.store.setSetting('agents.custom', this.custom);
    registerCustomAgents(this.custom);
    await this.store.ensureScope(id, customDefaultScope(input.topics));
    await this.store.audit('owner', 'agent.custom_added', { agent: id });
    return def;
  }

  async removeCustomAgent(id: CustomAgentId): Promise<void> {
    if (!this.custom.some((d) => d.id === id)) return;
    await this.disconnect(id);
    this.custom = this.custom.filter((d) => d.id !== id);
    await this.store.setSetting('agents.custom', this.custom);
    await this.store.deleteScope(id);
    registerCustomAgents(this.custom);
    await this.store.audit('owner', 'agent.custom_removed', { agent: id });
    this.apply();
  }

  /** Every UI-entered setting for this agent, cleared. Env-managed values are left alone. */
  agentKeys(agent: AgentId): string[] {
    const keys: Record<string, string[]> = {
      instinct: ['handle.instinct', 'instinct.email'],
      stanley: ['handle.stanley', 'stanley.apiId', 'stanley.apiHash', 'stanley.session', 'stanley.peer', 'stanley.account'],
      boardy: ['handle.boardy', 'boardy.email'],
      grok: ['token.grok', 'grok.webhookUrl', 'grok.webhookSecret'],
    };
    if (agent.startsWith('custom-')) return [`token.${agent}`, `hook.${agent}.url`, `hook.${agent}.secret`];
    return keys[agent] ?? [];
  }

  async disconnect(agent: AgentId): Promise<{ revoked: number }> {
    const patch: Record<string, null> = {};
    for (const k of this.agentKeys(agent)) if (this.source(k) === 'ui') patch[k] = null;
    if (Object.keys(patch).length) await this.setMany(patch);
    const revoked = await this.store.revokeAgentTokens(agent);
    await this.store.audit('owner', 'agent.disconnected', { agent, revoked });
    return { revoked };
  }

  // ---------- onboarding ----------

  async setOnboarding(patch: Partial<OnboardingState>): Promise<void> {
    this.onboarding = { ...this.onboarding, ...patch };
    await this.store.setSetting('onboarding', this.onboarding);
  }
}
