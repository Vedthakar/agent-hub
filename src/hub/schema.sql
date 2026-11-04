-- Agent Hub schema. Idempotent: safe to run on every boot.

-- Raw chat lines shipped by the Mac daemon (iMessage) or pulled by adapters (Telegram).
-- The router turns bursts of these into events.
CREATE TABLE IF NOT EXISTS raw_messages (
  id            BIGSERIAL PRIMARY KEY,
  agent         TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  channel       TEXT NOT NULL,
  author        TEXT NOT NULL CHECK (author IN ('user', 'agent', 'hub')),
  text          TEXT NOT NULL,
  sent_at       TIMESTAMPTZ NOT NULL,
  processed_at  TIMESTAMPTZ,
  event_id      BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);
CREATE INDEX IF NOT EXISTS raw_messages_unprocessed ON raw_messages (agent, sent_at) WHERE processed_at IS NULL;

-- Append-only log of what happened, per agent session.
CREATE TABLE IF NOT EXISTS events (
  id                 BIGSERIAL PRIMARY KEY,
  agent              TEXT NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL,
  author             TEXT NOT NULL CHECK (author IN ('user', 'agent', 'hub')),
  raw_excerpt        TEXT NOT NULL DEFAULT '',
  summary            TEXT NOT NULL DEFAULT '',
  topics             TEXT[] NOT NULL DEFAULT '{}',
  kind               TEXT NOT NULL DEFAULT 'session',
  caused_by_task_id  BIGINT,
  hop                INT NOT NULL DEFAULT 0,
  routed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_occurred ON events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_unrouted ON events (created_at) WHERE routed_at IS NULL;

-- Live state with TTL. Newer statements supersede older ones (same slot or explicit).
CREATE TABLE IF NOT EXISTS situation (
  id               BIGSERIAL PRIMARY KEY,
  text             TEXT NOT NULL,
  slot             TEXT,
  topics           TEXT[] NOT NULL DEFAULT '{}',
  source_agent     TEXT NOT NULL,
  author           TEXT NOT NULL CHECK (author IN ('user', 'agent', 'hub')),
  origin_event_id  BIGINT,
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ,
  superseded_by    BIGINT,
  superseded_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS situation_live ON situation (expires_at) WHERE superseded_at IS NULL;

-- Durable goals / preferences.
CREATE TABLE IF NOT EXISTS facts (
  id               BIGSERIAL PRIMARY KEY,
  text             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('goal', 'preference', 'fact')),
  topics           TEXT[] NOT NULL DEFAULT '{}',
  source_agent     TEXT NOT NULL,
  author           TEXT NOT NULL CHECK (author IN ('user', 'agent', 'hub')),
  origin_event_id  BIGINT,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extracted actions routed to other agents.
CREATE TABLE IF NOT EXISTS tasks (
  id               BIGSERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  origin_agent     TEXT NOT NULL,
  target_agent     TEXT NOT NULL,
  payload          TEXT NOT NULL,
  rationale        TEXT NOT NULL DEFAULT '',
  topics           TEXT[] NOT NULL DEFAULT '{}',
  author           TEXT NOT NULL CHECK (author IN ('user', 'agent', 'hub')),
  status           TEXT NOT NULL DEFAULT 'proposed'
                   CHECK (status IN ('proposed', 'approved', 'rejected', 'blocked', 'sent', 'done', 'failed')),
  status_reason    TEXT,
  origin_event_id  BIGINT,
  hop              INT NOT NULL DEFAULT 1,
  dedup_key        TEXT NOT NULL,
  approval_sent_at TIMESTAMPTZ,
  decided_at       TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  fetched_at       TIMESTAMPTZ,
  done_at          TIMESTAMPTZ,
  result           TEXT,
  attempts         INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, target_agent);
CREATE INDEX IF NOT EXISTS tasks_dedup ON tasks (dedup_key, created_at);

-- Per-agent read permissions by topic + autonomy.
CREATE TABLE IF NOT EXISTS scopes (
  agent        TEXT PRIMARY KEY,
  allow_topics TEXT[] NOT NULL DEFAULT '{}',
  deny_topics  TEXT[] NOT NULL DEFAULT '{}',
  autonomy     TEXT NOT NULL DEFAULT 'ask' CHECK (autonomy IN ('notify', 'ask', 'auto')),
  enabled      BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages the Mac daemon must send through Messages.app.
CREATE TABLE IF NOT EXISTS outbox (
  id          BIGSERIAL PRIMARY KEY,
  channel     TEXT NOT NULL DEFAULT 'imessage',
  to_handle   TEXT NOT NULL,
  body        TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('approval', 'delivery', 'notice')),
  task_id     BIGINT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'sent', 'failed')),
  claimed_at  TIMESTAMPTZ,
  sent_at     TIMESTAMPTZ,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, created_at);

-- Adapter health.
CREATE TABLE IF NOT EXISTS agent_status (
  agent            TEXT PRIMARY KEY,
  last_read_at     TIMESTAMPTZ,
  last_delivery_at TIMESTAMPTZ,
  last_error       TEXT,
  last_error_at    TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit trail of everything the hub did.
CREATE TABLE IF NOT EXISTS audit (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OAuth (single owner, one connection per agent).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id   TEXT PRIMARY KEY,
  info        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code            TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  agent           TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  resource        TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  used            BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id   TEXT NOT NULL,
  agent       TEXT NOT NULL,
  resource    TEXT,
  expires_at  TIMESTAMPTZ,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- v1.1: retries, dead letters, approvals hardening, per-route autonomy ----------

ALTER TABLE events ADD COLUMN IF NOT EXISTS route_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS next_route_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS triage TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approval_expires_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS delivery_ref TEXT;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN
  ('proposed', 'approved', 'rejected', 'blocked', 'sent', 'done', 'failed', 'cancelled', 'expired'));
CREATE INDEX IF NOT EXISTS tasks_delivery_ref ON tasks (delivery_ref) WHERE delivery_ref IS NOT NULL;

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

-- Anything the hub gave up on after retries. Shown on the dashboard with a retry button.
CREATE TABLE IF NOT EXISTS dead_letters (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('route', 'delivery', 'digest', 'ingest')),
  ref_id       BIGINT,
  agent        TEXT,
  reason       TEXT NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolution   TEXT
);
CREATE INDEX IF NOT EXISTS dead_letters_open ON dead_letters (created_at) WHERE resolved_at IS NULL;

-- Every inbound command (approval reply, kill switch). The unique key makes replays a no-op.
CREATE TABLE IF NOT EXISTS inbound_commands (
  id           BIGSERIAL PRIMARY KEY,
  channel      TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  sender       TEXT NOT NULL,
  text         TEXT NOT NULL,
  outcome      TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

-- Per-route autonomy (origin -> target). Overrides the target agent's default in `scopes`.
CREATE TABLE IF NOT EXISTS routes (
  origin_agent TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  autonomy     TEXT NOT NULL CHECK (autonomy IN ('notify', 'ask', 'auto')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (origin_agent, target_agent)
);

-- ---------- v1.2: connections UI ----------

-- Credentials entered in the dashboard when the secret store is the local one: AES-256-GCM ciphertext
-- only, keyed outside the database. (The Keychain and Supabase Vault backends don't use this table.)
CREATE TABLE IF NOT EXISTS secrets (
  name        TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Work the dashboard asks the Mac daemon to do (list recent threads, toggle keep-awake, open Settings).
CREATE TABLE IF NOT EXISTS daemon_jobs (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('list-threads', 'keep-awake', 'open-settings')),
  args        JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
  result      JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at  TIMESTAMPTZ,
  done_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS daemon_jobs_pending ON daemon_jobs (status, created_at);

ALTER TABLE daemon_jobs DROP CONSTRAINT IF EXISTS daemon_jobs_kind_check;
ALTER TABLE daemon_jobs ADD CONSTRAINT daemon_jobs_kind_check CHECK (kind IN ('list-threads', 'keep-awake', 'open-settings', 'read-history'));

-- Past conversations imported in bulk. History only: never current state and never a source of tasks.
CREATE TABLE IF NOT EXISTS archive (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  title        TEXT NOT NULL,
  messages     JSONB NOT NULL,
  hash         TEXT NOT NULL,
  started_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ,
  folder       TEXT,
  topics       TEXT[] NOT NULL DEFAULT '{general}',
  summary      TEXT,
  vault_path   TEXT,
  needs_write  BOOLEAN NOT NULL DEFAULT true,
  sorted_at    TIMESTAMPTZ,
  sort_attempts INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS archive_unsorted ON archive (id) WHERE sorted_at IS NULL;
ALTER TABLE archive ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE archive ADD COLUMN IF NOT EXISTS read_version INT NOT NULL DEFAULT 0;
ALTER TABLE archive ADD COLUMN IF NOT EXISTS organized_at TIMESTAMPTZ;

-- ---------- Row-level security ----------
-- The hub connects as the table owner and bypasses RLS. Supabase exposes the public schema to the
-- `anon` / `authenticated` roles through PostgREST, so every table gets RLS with no policies (deny all)
-- and those roles lose their default grants.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['raw_messages','events','situation','facts','tasks','scopes','outbox','agent_status',
    'audit','settings','oauth_clients','oauth_codes','oauth_tokens','dead_letters','inbound_commands','routes','secrets','daemon_jobs','archive'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
    -- The hub talks to Postgres directly and never uses PostgREST, so not even the service key gets in.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM service_role', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM service_role;
  END IF;
END $$;
