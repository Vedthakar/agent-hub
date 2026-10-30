import { createHash, randomInt } from 'node:crypto';
import type { Db } from './db.js';
import { AGENT_IDS, type AgentId, type Author, type Autonomy, type TaskStatus } from '../shared/types.js';
import { DEFAULT_SCOPES, type Scope } from './scopes.js';

export interface RawMessageRow {
  id: number;
  agent: AgentId;
  external_id: string;
  channel: string;
  author: Author;
  text: string;
  sent_at: Date;
}

export interface EventRow {
  id: number;
  agent: AgentId;
  occurred_at: Date;
  author: Author;
  raw_excerpt: string;
  summary: string;
  topics: string[];
  kind: string;
  caused_by_task_id: number | null;
  hop: number;
  routed_at: Date | null;
  route_attempts: number;
  next_route_at: Date | null;
  last_error: string | null;
  dead_lettered_at: Date | null;
  created_at: Date;
}

export interface SituationRow {
  id: number;
  text: string;
  slot: string | null;
  topics: string[];
  source_agent: AgentId;
  author: Author;
  origin_event_id: number | null;
  valid_from: Date;
  expires_at: Date | null;
  created_at: Date;
}

export interface FactRow {
  id: number;
  text: string;
  kind: 'goal' | 'preference' | 'fact';
  topics: string[];
  source_agent: AgentId;
  author: Author;
  created_at: Date;
}

export interface TaskRow {
  id: number;
  code: string;
  origin_agent: AgentId;
  target_agent: AgentId;
  payload: string;
  rationale: string;
  topics: string[];
  author: Author;
  status: TaskStatus;
  status_reason: string | null;
  origin_event_id: number | null;
  hop: number;
  dedup_key: string;
  approval_sent_at: Date | null;
  approval_expires_at: Date | null;
  next_attempt_at: Date | null;
  delivery_ref: string | null;
  decided_at: Date | null;
  sent_at: Date | null;
  fetched_at: Date | null;
  done_at: Date | null;
  result: string | null;
  attempts: number;
  created_at: Date;
}

export interface OutboxRow {
  id: number;
  channel: string;
  to_handle: string;
  body: string;
  purpose: 'approval' | 'delivery' | 'notice';
  task_id: number | null;
  status: 'pending' | 'claimed' | 'sent' | 'failed';
  created_at: Date;
  sent_at: Date | null;
}

export interface AgentStatusRow {
  agent: AgentId;
  last_read_at: Date | null;
  last_delivery_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
}

export class Store {
  constructor(readonly db: Db) {}

  /** Runs `fn` with a Store bound to one transaction. */
  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    return this.db.transaction((txDb) => fn(new Store(txDb)));
  }

  // ---------- audit / settings ----------

  async audit(actor: string, action: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.db.query('INSERT INTO audit (actor, action, detail) VALUES ($1, $2, $3::text::jsonb)', [actor, action, JSON.stringify(detail)]);
  }

  async recentAudit(limit = 200): Promise<{ id: number; at: Date; actor: string; action: string; detail: Record<string, unknown> }[]> {
    return this.db.query('SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT $1', [limit]);
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const rows = await this.db.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : fallback;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::text::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async isPaused(): Promise<boolean> {
    return this.getSetting('paused', false);
  }

  async setPaused(paused: boolean, actor: string): Promise<void> {
    await this.setSetting('paused', paused);
    await this.audit(actor, paused ? 'hub.paused' : 'hub.resumed');
  }

  // ---------- scopes ----------

  async ensureDefaultScopes(): Promise<void> {
    for (const agent of AGENT_IDS) {
      const d = DEFAULT_SCOPES[agent];
      await this.db.query(
        `INSERT INTO scopes (agent, allow_topics, deny_topics, autonomy, enabled) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agent) DO NOTHING`,
        [agent, d.allow_topics, d.deny_topics, d.autonomy, d.enabled],
      );
    }
  }

  async scopes(): Promise<Map<AgentId, Scope>> {
    const rows = await this.db.query<Scope>('SELECT agent, allow_topics, deny_topics, autonomy, enabled FROM scopes');
    return new Map(rows.map((r) => [r.agent, r]));
  }

  async scope(agent: AgentId): Promise<Scope | undefined> {
    return (await this.scopes()).get(agent);
  }

  async updateScope(agent: AgentId, patch: { allow_topics: string[]; deny_topics: string[]; autonomy: Autonomy; enabled: boolean }, actor: string) {
    await this.db.query(
      `UPDATE scopes SET allow_topics = $2, deny_topics = $3, autonomy = $4, enabled = $5, updated_at = now() WHERE agent = $1`,
      [agent, patch.allow_topics, patch.deny_topics, patch.autonomy, patch.enabled],
    );
    await this.audit(actor, 'scope.updated', { agent, ...patch });
  }

  // ---------- raw messages ----------

  /** Returns only rows that were newly inserted (re-shipped rows are ignored). */
  async insertRawMessages(rows: { agent: AgentId; externalId: string; channel: string; author: Author; text: string; sentAt: Date }[]): Promise<RawMessageRow[]> {
    const inserted: RawMessageRow[] = [];
    for (const r of rows) {
      const res = await this.db.query<RawMessageRow>(
        `INSERT INTO raw_messages (agent, external_id, channel, author, text, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (channel, external_id) DO NOTHING
         RETURNING id, agent, external_id, channel, author, text, sent_at`,
        [r.agent, r.externalId, r.channel, r.author, r.text, r.sentAt],
      );
      inserted.push(...res);
    }
    return inserted;
  }

  /** Agents whose conversation has gone quiet for at least `quietMs` and has unprocessed lines. */
  async quietBursts(quietMs: number, now = new Date()): Promise<AgentId[]> {
    const rows = await this.db.query<{ agent: AgentId }>(
      `SELECT agent FROM raw_messages WHERE processed_at IS NULL
       GROUP BY agent HAVING max(sent_at) <= $1`,
      [new Date(now.getTime() - quietMs)],
    );
    return rows.map((r) => r.agent);
  }

  async unprocessedFor(agent: AgentId): Promise<RawMessageRow[]> {
    return this.db.query(
      `SELECT id, agent, external_id, channel, author, text, sent_at FROM raw_messages
       WHERE processed_at IS NULL AND agent = $1 ORDER BY sent_at, id`,
      [agent],
    );
  }

  async markProcessed(ids: number[], eventId: number | null): Promise<void> {
    if (!ids.length) return;
    await this.db.query('UPDATE raw_messages SET processed_at = now(), event_id = $2 WHERE id = ANY($1::bigint[])', [ids, eventId]);
  }

  // ---------- events ----------

  async insertEvent(e: {
    agent: AgentId;
    occurredAt: Date;
    author: Author;
    rawExcerpt: string;
    summary: string;
    topics: string[];
    kind: string;
    causedByTaskId?: number | null;
    hop?: number;
    routed?: boolean;
  }): Promise<EventRow> {
    const [row] = await this.db.query<EventRow>(
      `INSERT INTO events (agent, occurred_at, author, raw_excerpt, summary, topics, kind, caused_by_task_id, hop, routed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [e.agent, e.occurredAt, e.author, e.rawExcerpt, e.summary, e.topics, e.kind, e.causedByTaskId ?? null, e.hop ?? 0, e.routed ? new Date() : null],
    );
    return row;
  }

  async updateEventAnalysis(id: number, summary: string, topics: string[]): Promise<void> {
    await this.db.query('UPDATE events SET summary = $2, topics = $3, routed_at = now() WHERE id = $1', [id, summary, topics]);
  }

  /** Events due for routing: not routed, not dead-lettered, and past any retry backoff. */
  async unroutedEvents(now = new Date(), limit = 20): Promise<EventRow[]> {
    return this.db.query(
      `SELECT * FROM events WHERE routed_at IS NULL AND dead_lettered_at IS NULL AND (next_route_at IS NULL OR next_route_at <= $1)
       ORDER BY created_at, id LIMIT $2`,
      [now, limit],
    );
  }

  async recordRouteFailure(id: number, error: string, nextAt: Date | null): Promise<number> {
    const rows = await this.db.query<{ route_attempts: number }>(
      `UPDATE events SET route_attempts = route_attempts + 1, last_error = $2, next_route_at = $3 WHERE id = $1 RETURNING route_attempts`,
      [id, error.slice(0, 1000), nextAt],
    );
    return rows[0]?.route_attempts ?? 0;
  }

  async deadLetterEvent(id: number, reason: string): Promise<void> {
    await this.db.query('UPDATE events SET dead_lettered_at = now(), last_error = $2 WHERE id = $1', [id, reason.slice(0, 1000)]);
    const [ev] = await this.db.query<{ agent: string; route_attempts: number }>('SELECT agent, route_attempts FROM events WHERE id = $1', [id]);
    await this.addDeadLetter({ kind: 'route', refId: id, agent: ev?.agent ?? null, reason, attempts: ev?.route_attempts ?? 0 });
  }

  /** Puts a dead-lettered event back in the routing queue. */
  async requeueEvent(id: number): Promise<void> {
    await this.db.query('UPDATE events SET dead_lettered_at = NULL, next_route_at = NULL, route_attempts = 0 WHERE id = $1', [id]);
  }

  async eventsSince(since: Date, limit = 200): Promise<EventRow[]> {
    return this.db.query('SELECT * FROM events WHERE occurred_at >= $1 ORDER BY occurred_at DESC, id DESC LIMIT $2', [since, limit]);
  }

  async recentEvents(limit = 100): Promise<EventRow[]> {
    return this.db.query('SELECT * FROM events ORDER BY occurred_at DESC, id DESC LIMIT $1', [limit]);
  }

  // ---------- situation / facts ----------

  async liveSituation(now = new Date()): Promise<SituationRow[]> {
    return this.db.query(
      `SELECT * FROM situation WHERE superseded_at IS NULL AND valid_from <= $1 AND (expires_at IS NULL OR expires_at > $1)
       ORDER BY valid_from DESC, id DESC`,
      [now],
    );
  }

  /**
   * Inserting into an occupied slot supersedes the older item(s) in that slot. Items produced by the same
   * event don't supersede each other: a debrief puts every commitment for tomorrow in "plan:<date>".
   */
  async addSituation(s: {
    text: string;
    slot: string | null;
    topics: string[];
    sourceAgent: AgentId;
    author: Author;
    originEventId: number | null;
    validFrom?: Date;
    expiresAt: Date | null;
  }): Promise<SituationRow> {
    const [row] = await this.db.query<SituationRow>(
      `INSERT INTO situation (text, slot, topics, source_agent, author, origin_event_id, valid_from, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [s.text, s.slot, s.topics, s.sourceAgent, s.author, s.originEventId, s.validFrom ?? new Date(), s.expiresAt],
    );
    if (s.slot) {
      await this.db.query(
        `UPDATE situation SET superseded_by = $1, superseded_at = now()
         WHERE slot = $2 AND id <> $1 AND superseded_at IS NULL AND origin_event_id IS DISTINCT FROM $3::bigint`,
        [row.id, s.slot, s.originEventId],
      );
    }
    return row;
  }

  async supersedeSituation(ids: number[], byId: number | null): Promise<void> {
    if (!ids.length) return;
    await this.db.query(
      'UPDATE situation SET superseded_by = $2, superseded_at = now() WHERE id = ANY($1::bigint[]) AND superseded_at IS NULL',
      [ids, byId],
    );
  }

  async activeFacts(): Promise<FactRow[]> {
    return this.db.query('SELECT * FROM facts WHERE active ORDER BY created_at DESC LIMIT 200');
  }

  async addFact(f: { text: string; kind: FactRow['kind']; topics: string[]; sourceAgent: AgentId; author: Author; originEventId: number | null }): Promise<void> {
    const dup = await this.db.query('SELECT 1 FROM facts WHERE active AND lower(text) = lower($1)', [f.text]);
    if (dup.length) return;
    await this.db.query(
      'INSERT INTO facts (text, kind, topics, source_agent, author, origin_event_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [f.text, f.kind, f.topics, f.sourceAgent, f.author, f.originEventId],
    );
  }

  async retireFacts(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.db.query('UPDATE facts SET active = false WHERE id = ANY($1::bigint[])', [ids]);
  }

  // ---------- tasks ----------

  static dedupKey(target: string, payload: string): string {
    // Unicode-aware so non-English / emoji payloads keep their content in the key.
    const norm = payload.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/gu, ' ').replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(`${target}|${norm}`).digest('hex').slice(0, 24);
  }

  async findDuplicateTask(dedupKey: string, withinMs: number): Promise<TaskRow | undefined> {
    const rows = await this.db.query<TaskRow>(
      // Rejected and cancelled hand-offs count as duplicates so the router doesn't re-ask.
      `SELECT * FROM tasks WHERE dedup_key = $1 AND created_at >= $2 AND status NOT IN ('failed', 'expired')
       ORDER BY created_at DESC LIMIT 1`,
      [dedupKey, new Date(Date.now() - withinMs)],
    );
    return rows[0];
  }

  async createTask(t: {
    originAgent: AgentId;
    targetAgent: AgentId;
    payload: string;
    rationale: string;
    topics: string[];
    author: Author;
    originEventId: number | null;
    hop: number;
    status: TaskStatus;
    statusReason?: string | null;
  }): Promise<TaskRow> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = taskCode();
      const rows = await this.db.query<TaskRow>(
        `INSERT INTO tasks (code, origin_agent, target_agent, payload, rationale, topics, author, status, status_reason, origin_event_id, hop, dedup_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (code) DO NOTHING RETURNING *`,
        [code, t.originAgent, t.targetAgent, t.payload, t.rationale, t.topics, t.author, t.status, t.statusReason ?? null,
          t.originEventId, t.hop, Store.dedupKey(t.targetAgent, t.payload)],
      );
      if (rows.length) return rows[0];
    }
    throw new Error('could not allocate task code');
  }

  async task(id: number): Promise<TaskRow | undefined> {
    return (await this.db.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id]))[0];
  }

  async taskByCode(code: string): Promise<TaskRow | undefined> {
    return (await this.db.query<TaskRow>('SELECT * FROM tasks WHERE code = $1', [code.toUpperCase()]))[0];
  }

  async tasksByStatus(status: TaskStatus[], limit = 100): Promise<TaskRow[]> {
    return this.db.query('SELECT * FROM tasks WHERE status = ANY($1::text[]) ORDER BY created_at DESC, id DESC LIMIT $2', [status, limit]);
  }

  async recentTasks(limit = 100): Promise<TaskRow[]> {
    return this.db.query('SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
  }

  /** Atomic status transition; returns the updated row or undefined if the task wasn't in `from`. */
  async transitionTask(id: number, from: TaskStatus[], to: TaskStatus, extra: { reason?: string | null; result?: string | null } = {}): Promise<TaskRow | undefined> {
    const stamp =
      to === 'approved' || to === 'rejected' ? ', decided_at = now()' :
      to === 'sent' ? ', sent_at = now(), attempts = attempts + 1' :
      to === 'done' ? ', done_at = now()' :
      to === 'failed' ? ', attempts = attempts + 1' : '';
    const rows = await this.db.query<TaskRow>(
      `UPDATE tasks SET status = $3, status_reason = COALESCE($4, status_reason), result = COALESCE($5, result) ${stamp}
       WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
      [id, from, to, extra.reason ?? null, extra.result ?? null],
    );
    return rows[0];
  }

  async markApprovalSent(id: number, expiresAt: Date | null = null): Promise<void> {
    await this.db.query('UPDATE tasks SET approval_sent_at = now(), approval_expires_at = $2 WHERE id = $1', [id, expiresAt]);
  }

  /** Proposed tasks whose approval window has passed become `expired`; their codes stop working. */
  async expireApprovals(now = new Date()): Promise<TaskRow[]> {
    return this.db.query(
      `UPDATE tasks SET status = 'expired', status_reason = 'approval window passed', decided_at = now()
       WHERE status = 'proposed' AND approval_expires_at IS NOT NULL AND approval_expires_at <= $1 RETURNING *`,
      [now],
    );
  }

  /** Approved tasks whose retry backoff (if any) has elapsed, oldest first. */
  async dispatchable(now = new Date(), limit = 50): Promise<TaskRow[]> {
    return this.db.query(
      `SELECT * FROM tasks WHERE status = 'approved' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
       ORDER BY decided_at NULLS FIRST, id LIMIT $2`,
      [now, limit],
    );
  }

  async scheduleRetry(id: number, reason: string, nextAt: Date): Promise<TaskRow | undefined> {
    const rows = await this.db.query<TaskRow>(
      `UPDATE tasks SET attempts = attempts + 1, status_reason = $2, next_attempt_at = $3 WHERE id = $1 AND status = 'approved' RETURNING *`,
      [id, reason.slice(0, 1000), nextAt],
    );
    return rows[0];
  }

  async setDeliveryRef(id: number, ref: string): Promise<void> {
    await this.db.query('UPDATE tasks SET delivery_ref = $2 WHERE id = $1', [id, ref]);
  }

  async taskByDeliveryRef(ref: string): Promise<TaskRow | undefined> {
    return (await this.db.query<TaskRow>('SELECT * FROM tasks WHERE delivery_ref = $1', [ref]))[0];
  }

  /** A bounced / failed delivery puts the task back in the retry queue. */
  async reopenForRetry(id: number, reason: string, nextAt: Date): Promise<TaskRow | undefined> {
    const rows = await this.db.query<TaskRow>(
      `UPDATE tasks SET status = 'approved', status_reason = $2, next_attempt_at = $3, sent_at = NULL
       WHERE id = $1 AND status = 'sent' RETURNING *`,
      [id, reason.slice(0, 1000), nextAt],
    );
    return rows[0];
  }

  // ---------- routes (per-route autonomy) ----------

  async routeAutonomy(origin: AgentId, target: AgentId): Promise<Autonomy | null> {
    const rows = await this.db.query<{ autonomy: Autonomy }>('SELECT autonomy FROM routes WHERE origin_agent = $1 AND target_agent = $2', [origin, target]);
    return rows[0]?.autonomy ?? null;
  }

  async routes(): Promise<{ origin_agent: AgentId; target_agent: AgentId; autonomy: Autonomy }[]> {
    return this.db.query('SELECT origin_agent, target_agent, autonomy FROM routes ORDER BY origin_agent, target_agent');
  }

  async setRoute(origin: AgentId, target: AgentId, autonomy: Autonomy | null, actor: string): Promise<void> {
    if (autonomy === null) {
      await this.db.query('DELETE FROM routes WHERE origin_agent = $1 AND target_agent = $2', [origin, target]);
    } else {
      await this.db.query(
        `INSERT INTO routes (origin_agent, target_agent, autonomy) VALUES ($1, $2, $3)
         ON CONFLICT (origin_agent, target_agent) DO UPDATE SET autonomy = EXCLUDED.autonomy, updated_at = now()`,
        [origin, target, autonomy],
      );
    }
    await this.audit(actor, 'route.updated', { origin, target, autonomy });
  }

  // ---------- inbound commands (approval replies) ----------

  /** False when this (channel, id) was already seen: replays are ignored. */
  async recordInbound(channel: string, externalId: string, sender: string, text: string): Promise<number | null> {
    const rows = await this.db.query<{ id: number }>(
      `INSERT INTO inbound_commands (channel, external_id, sender, text) VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel, external_id) DO NOTHING RETURNING id`,
      [channel, externalId, sender, text.slice(0, 500)],
    );
    return rows[0]?.id ?? null;
  }

  async setInboundOutcome(id: number, outcome: string): Promise<void> {
    await this.db.query('UPDATE inbound_commands SET outcome = $2 WHERE id = $1', [id, outcome]);
  }

  async countInboundOutcomes(outcomes: string[], since: Date): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM inbound_commands WHERE outcome = ANY($1::text[]) AND received_at >= $2',
      [outcomes, since],
    );
    return Number(rows[0]?.n ?? 0);
  }

  // ---------- dead letters ----------

  async addDeadLetter(d: { kind: 'route' | 'delivery' | 'digest' | 'ingest'; refId: number | null; agent: string | null; reason: string; attempts: number }): Promise<void> {
    await this.db.query(
      'INSERT INTO dead_letters (kind, ref_id, agent, reason, attempts) VALUES ($1, $2, $3, $4, $5)',
      [d.kind, d.refId, d.agent, d.reason.slice(0, 1000), d.attempts],
    );
  }

  async openDeadLetters(limit = 100): Promise<{ id: number; kind: string; ref_id: number | null; agent: string | null; reason: string; attempts: number; created_at: Date }[]> {
    return this.db.query('SELECT * FROM dead_letters WHERE resolved_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
  }

  async resolveDeadLetter(id: number, resolution: string): Promise<{ kind: string; ref_id: number | null } | undefined> {
    const rows = await this.db.query<{ kind: string; ref_id: number | null }>(
      'UPDATE dead_letters SET resolved_at = now(), resolution = $2 WHERE id = $1 AND resolved_at IS NULL RETURNING kind, ref_id',
      [id, resolution],
    );
    return rows[0];
  }

  async inbox(agent: AgentId): Promise<TaskRow[]> {
    return this.db.query(`SELECT * FROM tasks WHERE target_agent = $1 AND status = 'sent' ORDER BY sent_at, id`, [agent]);
  }

  async markFetched(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.db.query('UPDATE tasks SET fetched_at = COALESCE(fetched_at, now()) WHERE id = ANY($1::bigint[])', [ids]);
  }

  /** The most recent task delivered to `agent` within `withinMs`, used to attribute hop counts to its replies. */
  /**
   * The task most likely to have prompted an agent's reply at `before`. `sent_at` is stamped by the database
   * clock while message times come from the Mac, so allow for skew; under-attributing would let a fast
   * agent-to-agent ping-pong restart at hop 0.
   */
  async lastTaskSentTo(agent: AgentId, withinMs: number, before = new Date(), skewMs = 120_000): Promise<TaskRow | undefined> {
    const rows = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE target_agent = $1 AND sent_at IS NOT NULL AND sent_at >= $2 AND sent_at <= $3
       ORDER BY sent_at DESC LIMIT 1`,
      [agent, new Date(before.getTime() - withinMs), new Date(before.getTime() + skewMs)],
    );
    return rows[0];
  }

  // ---------- outbox ----------

  async enqueueOutbox(o: { toHandle: string; body: string; purpose: OutboxRow['purpose']; taskId?: number | null }): Promise<OutboxRow> {
    const [row] = await this.db.query<OutboxRow>(
      'INSERT INTO outbox (to_handle, body, purpose, task_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [o.toHandle, o.body, o.purpose, o.taskId ?? null],
    );
    return row;
  }

  /**
   * Claims pending items; items claimed but never acked (daemon crashed / lid closed) are re-offered after
   * 2 minutes, so delivery is at-least-once. While the hub is paused only notices/approval texts go out.
   */
  async claimOutbox(limit = 10, opts: { paused?: boolean } = {}): Promise<OutboxRow[]> {
    return this.db.query(
      `UPDATE outbox SET status = 'claimed', claimed_at = now(), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM outbox
         WHERE (status = 'pending' OR (status = 'claimed' AND claimed_at < now() - interval '2 minutes'))
           AND ($2::boolean IS NOT TRUE OR purpose <> 'delivery')
         ORDER BY created_at, id LIMIT $1
         FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [limit, opts.paused ?? false],
    );
  }

  async ackOutbox(id: number, ok: boolean, error?: string): Promise<OutboxRow | undefined> {
    const rows = await this.db.query<OutboxRow>(
      `UPDATE outbox SET status = $2, sent_at = CASE WHEN $3 THEN now() ELSE sent_at END, error = $4 WHERE id = $1 RETURNING *`,
      [id, ok ? 'sent' : 'failed', ok, error ?? null],
    );
    return rows[0];
  }

  /** True if this outgoing chat line is one the hub itself sent (so it isn't mistaken for the user talking). */
  async isHubSent(handle: string, body: string, around: Date): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM outbox WHERE to_handle = $1 AND body = $2 AND created_at BETWEEN $3 AND $4 LIMIT 1`,
      [handle, body, new Date(around.getTime() - 24 * 3600_000), new Date(around.getTime() + 3600_000)],
    );
    return rows.length > 0;
  }

  async recentOutbox(limit = 50): Promise<OutboxRow[]> {
    return this.db.query('SELECT * FROM outbox ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
  }

  // ---------- health ----------

  async touchRead(agent: AgentId): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_status (agent, last_read_at) VALUES ($1, now())
       ON CONFLICT (agent) DO UPDATE SET last_read_at = now(), updated_at = now()`,
      [agent],
    );
  }

  async touchDelivery(agent: AgentId, error?: string): Promise<void> {
    if (error) {
      await this.db.query(
        `INSERT INTO agent_status (agent, last_error, last_error_at) VALUES ($1, $2, now())
         ON CONFLICT (agent) DO UPDATE SET last_error = $2, last_error_at = now(), updated_at = now()`,
        [agent, error],
      );
    } else {
      await this.db.query(
        `INSERT INTO agent_status (agent, last_delivery_at) VALUES ($1, now())
         ON CONFLICT (agent) DO UPDATE SET last_delivery_at = now(), updated_at = now()`,
        [agent],
      );
    }
  }

  async agentStatuses(): Promise<Map<AgentId, AgentStatusRow>> {
    const rows = await this.db.query<AgentStatusRow>('SELECT * FROM agent_status');
    return new Map(rows.map((r) => [r.agent, r]));
  }

  /** Dead-letter "retry": a failed delivery goes back to approved with a fresh attempt budget. */
  async retryFailedTask(id: number): Promise<TaskRow | undefined> {
    const [row] = await this.db.query<TaskRow>(
      `UPDATE tasks SET status = 'approved', attempts = 0, next_attempt_at = NULL, status_reason = 'retry from dead-letter queue'
       WHERE id = $1 AND status = 'failed' RETURNING *`,
      [id],
    );
    return row;
  }

  /** Per target agent: tasks waiting to go out, how many of those are retrying, and recent failures. */
  async deliveryQueue(): Promise<Map<AgentId, { queued: number; retrying: number; failed24h: number; awaitingApproval: number }>> {
    const rows = await this.db.query<{ agent: AgentId; queued: number; retrying: number; failed24h: number; awaiting: number }>(
      `SELECT target_agent AS agent,
              count(*) FILTER (WHERE status = 'approved')::int AS queued,
              count(*) FILTER (WHERE status = 'approved' AND attempts > 0)::int AS retrying,
              count(*) FILTER (WHERE status = 'failed' AND coalesce(decided_at, created_at) > now() - interval '24 hours')::int AS failed24h,
              count(*) FILTER (WHERE status = 'proposed')::int AS awaiting
       FROM tasks GROUP BY target_agent`,
    );
    return new Map(rows.map((r) => [r.agent, { queued: r.queued, retrying: r.retrying, failed24h: r.failed24h, awaitingApproval: r.awaiting }]));
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function taskCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
