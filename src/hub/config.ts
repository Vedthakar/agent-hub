import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { isAgentId, type AgentId } from '../shared/types.js';

dotenv.config({ quiet: true });

type Env = NodeJS.ProcessEnv;

function list(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parses `agent:value,agent:value` maps, e.g. `instinct:+15551234567,stanley:stan@example.com`. */
function agentMap(env: Env, name: string): Partial<Record<AgentId, string>> {
  const out: Partial<Record<AgentId, string>> = {};
  for (const pair of list(env, name)) {
    const idx = pair.indexOf(':');
    if (idx < 0) continue;
    const agent = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!isAgentId(agent)) throw new Error(`${name}: unknown agent "${agent}"`);
    out[agent] = value;
  }
  return out;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export interface HubConfig {
  port: number;
  publicUrl: string;
  databaseUrl: string | null;
  pgliteDir: string;
  ownerName: string;
  ownerPassword: string;
  sessionSecret: string;
  timezone: string;
  daemonToken: string;
  agentTokens: Partial<Record<AgentId, string>>;
  imessageHandles: Partial<Record<AgentId, string>>;
  approval: {
    channel: 'imessage' | 'telegram' | 'sms' | 'none';
    /** iMessage: the thread the daemon watches for replies. Only messages sent from this Mac's account (the user) count. */
    imessageHandle: string | null;
    telegramBotToken: string | null;
    telegramChatId: string | null;
    /** Telegram numeric user id of the owner; replies from anyone else are ignored. */
    telegramUserId: string | null;
    twilio: { accountSid: string | null; authToken: string | null; from: string | null; userNumber: string | null };
    ttlMs: number;
    maxInvalidPerWindow: number;
  };
  router: {
    provider: 'anthropic' | 'openai' | 'none';
    model: string;
    apiKey: string | null;
    baseUrl: string | null;
    debounceMs: number;
    maxHops: number;
    tickMs: number;
    timeoutMs: number;
    maxAttempts: number;
  };
  delivery: { maxAttempts: number; baseBackoffMs: number };
  /** Allow writing into the agent's iMessage thread (the user's own conversation) when no side channel exists. Off by default. */
  allowThreadFallback: boolean;
  imap: { url: string | null; mailbox: string };
  owner: {
    fullName: string;
    bio: string | null;
    offer: string | null;
    location: string | null;
    keepPrivate: string | null;
    links: { label: string; url: string }[];
  };
  rateLimit: { mcpPerMinute: number; loginPer15Min: number };
  email: {
    smtpUrl: string | null;
    from: string | null;
  };
  instinctEmail: string | null;
  boardyEmail: string;
  debriefPattern: RegExp;
  stanley: {
    apiId: number | null;
    apiHash: string | null;
    session: string | null;
    peer: string | null;
  };
  grokWebhookUrl: string | null;
  grokWebhookSecret: string | null;
}

export function loadConfig(env = process.env): HubConfig {
  const port = int(env, 'PORT', 8787);
  const anthropicKey = env.ANTHROPIC_API_KEY ?? null;
  const openaiKey = env.OPENAI_API_KEY ?? null;
  const provider = (env.ROUTER_PROVIDER as HubConfig['router']['provider'] | undefined) ??
    (anthropicKey ? 'anthropic' : openaiKey ? 'openai' : 'none');

  const approvalChannel = (env.APPROVAL_CHANNEL as HubConfig['approval']['channel'] | undefined) ??
    (env.APPROVAL_IMESSAGE_HANDLE ? 'imessage' : env.APPROVAL_TELEGRAM_BOT_TOKEN ? 'telegram' : env.TWILIO_ACCOUNT_SID ? 'sms' : 'none');

  const ownerPassword = env.HUB_OWNER_PASSWORD ?? '';
  if (!ownerPassword && env.NODE_ENV === 'production') {
    throw new Error('HUB_OWNER_PASSWORD is required in production');
  }
  if (env.NODE_ENV === 'production') {
    const placeholders = ['HUB_OWNER_PASSWORD', 'HUB_DAEMON_TOKEN', 'HUB_AGENT_TOKENS', 'HUB_SESSION_SECRET'].filter((k) => /change-me/i.test(env[k] ?? ''));
    if (placeholders.length) throw new Error(`Replace the change-me placeholder in ${placeholders.join(', ')} before running in production`);
  }

  return {
    port,
    publicUrl: (env.HUB_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL ?? null,
    pgliteDir: env.PGLITE_DIR ?? '.data/pglite',
    ownerName: env.HUB_OWNER_NAME ?? 'the user',
    ownerPassword,
    // Without an explicit secret, sessions are signed with a per-process random key (they reset on restart).
    sessionSecret: env.HUB_SESSION_SECRET || ownerPassword || randomBytes(32).toString('hex'),
    timezone: env.HUB_TIMEZONE ?? 'America/New_York',
    daemonToken: env.HUB_DAEMON_TOKEN ?? '',
    agentTokens: agentMap(env, 'HUB_AGENT_TOKENS'),
    imessageHandles: agentMap(env, 'IMESSAGE_HANDLES'),
    approval: {
      channel: approvalChannel,
      imessageHandle: env.APPROVAL_IMESSAGE_HANDLE ?? null,
      telegramBotToken: env.APPROVAL_TELEGRAM_BOT_TOKEN ?? null,
      telegramChatId: env.APPROVAL_TELEGRAM_CHAT_ID ?? null,
      telegramUserId: env.APPROVAL_TELEGRAM_USER_ID ?? null,
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID ?? null,
        authToken: env.TWILIO_AUTH_TOKEN ?? null,
        from: env.TWILIO_FROM_NUMBER ?? null,
        userNumber: env.APPROVAL_USER_NUMBER ?? null,
      },
      ttlMs: int(env, 'APPROVAL_TTL_HOURS', 12) * 3600_000,
      maxInvalidPerWindow: int(env, 'APPROVAL_MAX_INVALID', 5),
    },
    router: {
      provider,
      model: env.ROUTER_MODEL ?? (provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5'),
      apiKey: provider === 'openai' ? openaiKey : anthropicKey,
      baseUrl: env.ROUTER_BASE_URL ?? null,
      debounceMs: int(env, 'ROUTER_DEBOUNCE_MS', 10 * 60_000),
      maxHops: int(env, 'ROUTER_MAX_HOPS', 2),
      tickMs: int(env, 'ROUTER_TICK_MS', 30_000),
      timeoutMs: int(env, 'ROUTER_TIMEOUT_MS', 60_000),
      maxAttempts: int(env, 'ROUTER_MAX_ATTEMPTS', 5),
    },
    delivery: {
      maxAttempts: int(env, 'DELIVERY_MAX_ATTEMPTS', 6),
      baseBackoffMs: int(env, 'DELIVERY_BACKOFF_MS', 60_000),
    },
    allowThreadFallback: env.ALLOW_THREAD_FALLBACK === '1' || env.ALLOW_THREAD_FALLBACK === 'true',
    imap: { url: env.IMAP_URL ?? null, mailbox: env.IMAP_MAILBOX ?? 'INBOX' },
    owner: {
      fullName: env.OWNER_FULL_NAME ?? env.HUB_OWNER_NAME ?? 'the user',
      bio: env.OWNER_BIO ?? null,
      offer: env.OWNER_OFFER ?? null,
      location: env.OWNER_LOCATION ?? null,
      keepPrivate: env.OWNER_KEEP_PRIVATE ?? null,
      links: list(env, 'OWNER_LINKS').flatMap((pair) => {
        const idx = pair.indexOf('=');
        return idx > 0 ? [{ label: pair.slice(0, idx).trim(), url: pair.slice(idx + 1).trim() }] : [];
      }),
    },
    rateLimit: {
      mcpPerMinute: int(env, 'RATE_LIMIT_MCP_PER_MIN', 120),
      loginPer15Min: int(env, 'RATE_LIMIT_LOGIN_PER_15MIN', 10),
    },
    email: {
      smtpUrl: env.SMTP_URL ?? null,
      from: env.EMAIL_FROM ?? null,
    },
    instinctEmail: env.INSTINCT_EMAIL ?? null,
    boardyEmail: env.BOARDY_EMAIL ?? 'boardy@boardy.ai',
    debriefPattern: new RegExp(env.DEBRIEF_PATTERN ?? '\\b(debrief|end of (the )?day|wrap(ping)? up (the |my )?day|nightly review)\\b', 'i'),
    stanley: {
      apiId: env.TELEGRAM_API_ID ? Number(env.TELEGRAM_API_ID) : null,
      apiHash: env.TELEGRAM_API_HASH ?? null,
      session: env.TELEGRAM_SESSION ?? null,
      peer: env.STANLEY_TELEGRAM_PEER ?? null,
    },
    grokWebhookUrl: env.GROK_WEBHOOK_URL ?? null,
    grokWebhookSecret: env.GROK_WEBHOOK_SECRET ?? null,
  };
}
