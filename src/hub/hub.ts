import type { AgentId, DaemonConfig, DaemonMessage } from '../shared/types.js';
import { log } from '../shared/log.js';
import { ADAPTERS } from './adapters/index.js';
import type { AdapterContext } from './adapters/types.js';
import { Approvals, type CommandOutcome, type InboundCommand } from './approvals.js';
import type { HubConfig } from './config.js';
import { debriefActive, noteDebriefStart, processPendingDebrief, queueDigestNow } from './debrief.js';
import { dispatchApproved } from './dispatch.js';
import { LlmError, backoffMs, type Llm } from './llm.js';
import { routeEvent } from './router.js';
import type { RawMessageRow, Store } from './store.js';
import type { Transports } from './transports/index.js';

const REPLY_ATTRIBUTION_WINDOW_MS = 12 * 3600_000;
const ROUTE_BACKOFF_BASE_MS = 30_000;

export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  if (h.includes('@')) return h;
  const digits = h.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export interface TickReport {
  read: number;
  events: number;
  routed: number;
  asked: number;
  expired: number;
  sent: number;
  digest: string;
}

export class Hub {
  readonly ctx: AdapterContext;
  readonly approvals: Approvals;
  private ticking: Promise<void> | null = null;
  private rerun = false;
  private routing: Promise<number> = Promise.resolve(0);
  lastTick: { at: Date; ok: boolean; error?: string; report?: TickReport } | null = null;

  constructor(
    readonly store: Store,
    readonly cfg: HubConfig,
    readonly transports: Transports,
    readonly llm: Llm | null,
  ) {
    this.ctx = { store, cfg, transports };
    this.approvals = new Approvals({ store, cfg, transports, kick: () => this.kick() });
  }

  // ---------------------------------------------------------------- daemon

  daemonConfig(paused: boolean): DaemonConfig {
    const handles = new Set<string>();
    for (const a of Object.values(ADAPTERS)) for (const h of a.imessageHandles?.(this.cfg) ?? []) handles.add(h);
    const approvalHandle = this.cfg.approval.channel === 'imessage' ? this.cfg.approval.imessageHandle : null;
    if (approvalHandle) handles.add(approvalHandle);
    return { watchHandles: [...handles], approvalHandle, pollIntervalMs: 5000, paused };
  }

  private agentForHandle(handle: string): AgentId | null {
    const n = normalizeHandle(handle);
    for (const [agent, h] of Object.entries(this.cfg.imessageHandles)) {
      if (h && normalizeHandle(h) === n) return agent as AgentId;
    }
    return null;
  }

  /**
   * Messages shipped by the Mac daemon. Agent threads become raw messages (idempotent on the iMessage guid);
   * the approval thread becomes commands, accepted only when the user's own device sent them.
   */
  async ingestDaemon(messages: DaemonMessage[]): Promise<{ accepted: number; commands: number }> {
    let accepted = 0;
    let commands = 0;
    const approvalHandle = this.cfg.approval.channel === 'imessage' ? this.cfg.approval.imessageHandle : null;
    const ordered = [...messages].sort((a, b) => a.rowid - b.rowid);
    for (const m of ordered) {
      const text = (m.text ?? '').trim();
      if (!text) continue;
      const sentAt = new Date(m.sentAt);

      if (approvalHandle && normalizeHandle(m.handle) === normalizeHandle(approvalHandle)) {
        if (m.isFromMe && (await this.store.isHubSent(approvalHandle, text, sentAt))) continue;
        const outcome = await this.approvals.handleInbound({
          channel: 'imessage',
          externalId: m.guid,
          fromOwner: m.isFromMe,
          sender: m.isFromMe ? 'me' : m.handle,
          text,
        });
        if (outcome !== 'ignored' && outcome !== 'replay' && outcome !== 'rejected_sender') commands++;
        continue;
      }

      const agent = this.agentForHandle(m.handle);
      if (!agent) continue;
      const author = m.isFromMe ? ((await this.store.isHubSent(m.handle, text, sentAt)) ? 'hub' : 'user') : 'agent';
      const inserted = await this.store.insertRawMessages([{ agent, externalId: m.guid, channel: 'imessage', author, text, sentAt }]);
      if (!inserted.length) continue;
      accepted++;
      await this.store.touchRead(agent);
      if (agent === 'instinct' && author === 'user' && (await noteDebriefStart(this.ctx, inserted[0]))) this.kick();
    }
    return { accepted, commands };
  }

  /** Approval replies from the hub's own bot / phone number arrive here. */
  handleInbound(cmd: InboundCommand): Promise<CommandOutcome> {
    return this.approvals.handleInbound(cmd);
  }

  // ---------------------------------------------------------------- router

  /** Turns quiet conversation bursts into events. */
  async collectBursts(now = new Date()): Promise<number> {
    let made = 0;
    for (const agent of await this.store.quietBursts(this.cfg.router.debounceMs, now)) {
      const made1 = await this.store.tx(async (tx) => {
        const rows = await tx.unprocessedFor(agent);
        const convo = rows.filter((r) => r.author !== 'hub');
        if (!convo.length) {
          await tx.markProcessed(rows.map((r) => r.id), null);
          return 0;
        }
        const userDriven = convo.some((r) => r.author === 'user');
        // Bursts the user took part in start a fresh chain; agent-only replies inherit the hop of the task that prompted them.
        const cause = userDriven ? undefined : await tx.lastTaskSentTo(agent, REPLY_ATTRIBUTION_WINDOW_MS, convo[convo.length - 1].sent_at);
        const event = await tx.insertEvent({
          agent,
          occurredAt: convo[0].sent_at,
          author: userDriven ? 'user' : 'agent',
          rawExcerpt: this.transcript(agent, convo),
          summary: '',
          topics: [],
          kind: 'chat',
          causedByTaskId: cause?.id ?? null,
          hop: cause?.hop ?? 0,
        });
        await tx.markProcessed(rows.map((r) => r.id), event.id);
        return 1;
      });
      made += made1;
    }
    return made;
  }

  private transcript(agent: AgentId, rows: RawMessageRow[]): string {
    const name = ADAPTERS[agent].name;
    const text = rows
      .map((r) => `[${new Date(r.sent_at).toISOString()}] ${r.author === 'user' ? this.cfg.ownerName : name}: ${r.text}`)
      .join('\n');
    return text.length > 12_000 ? `…${text.slice(-12_000)}` : text;
  }

  /** Serialized so the tick loop and the debrief flow never route the same event twice. */
  routePending(now = new Date()): Promise<number> {
    this.routing = this.routing.catch(() => 0).then(() => this.routePendingNow(now));
    return this.routing;
  }

  /**
   * Failures are persisted on the event (attempts, last error, next retry time), retried with exponential
   * backoff (honouring Retry-After), and after ROUTER_MAX_ATTEMPTS the event moves to the dead-letter queue.
   * A failing event never blocks the ones behind it, and nothing here throws out of the tick.
   */
  private async routePendingNow(now: Date): Promise<number> {
    let routed = 0;
    for (const event of await this.store.unroutedEvents(now)) {
      try {
        const debrief = event.agent === 'instinct' && (await debriefActive(this.ctx, new Date(event.occurred_at)));
        await routeEvent({ store: this.store, cfg: this.cfg, llm: this.llm }, event, { debrief });
        routed++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const attempt = event.route_attempts + 1;
        log.warn('router.failed', { event: event.id, attempt, error });
        await this.store.audit('router', 'event.route_failed', { event: event.id, attempt, error });
        if (attempt >= this.cfg.router.maxAttempts) {
          await this.store.recordRouteFailure(event.id, error, null);
          await this.store.deadLetterEvent(event.id, error);
          continue;
        }
        const hint = err instanceof LlmError ? err.retryAfterMs : null;
        const wait = Math.max(hint ?? 0, backoffMs(attempt, ROUTE_BACKOFF_BASE_MS));
        await this.store.recordRouteFailure(event.id, error, new Date(Date.now() + wait));
      }
    }
    return routed;
  }

  // ---------------------------------------------------------------- approvals / dispatch / debrief

  requestApprovals(): Promise<number> {
    return this.approvals.request();
  }

  dispatchApproved(): Promise<number> {
    return dispatchApproved(this.ctx, this.approvals);
  }

  /** Dashboard "send digest now". The tick sends it (with retries). */
  async sendDebriefDigest(): Promise<void> {
    await queueDigestNow(this.ctx);
    this.kick();
  }

  // ---------------------------------------------------------------- loop

  async pollReads(): Promise<number> {
    let read = 0;
    for (const a of Object.values(ADAPTERS)) {
      try {
        read += await a.readEvents(this.ctx);
      } catch (err) {
        await this.store.touchDelivery(a.id, `read failed: ${String(err)}`);
        await this.store.audit('hub', 'adapter.read_failed', { agent: a.id, error: String(err) });
      }
    }
    if (this.cfg.approval.channel === 'telegram' && this.transports.telegramBot) {
      try {
        const owner = String(this.cfg.approval.telegramUserId ?? this.cfg.approval.telegramChatId);
        for (const m of await this.transports.telegramBot.poll()) {
          await this.approvals.handleInbound({ channel: 'telegram', externalId: m.id, fromOwner: m.fromId === owner, sender: m.fromId, text: m.text });
        }
      } catch (err) {
        await this.store.audit('hub', 'approval.poll_failed', { error: String(err) });
      }
    }
    return read;
  }

  /** Callers arriving mid-tick get the in-flight run, which loops once more to cover their request. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.rerun = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.rerun = false;
          const report: TickReport = { read: 0, events: 0, routed: 0, asked: 0, expired: 0, sent: 0, digest: 'none' };
          try {
            report.read = await this.pollReads();
            report.events = await this.collectBursts();
            report.routed = await this.routePending();
            report.digest = await processPendingDebrief(this.ctx, () => this.routePending());
            report.expired = await this.approvals.sweepExpired();
            report.asked = await this.requestApprovals();
            report.sent = await this.dispatchApproved();
            this.lastTick = { at: new Date(), ok: true, report };
          } catch (err) {
            this.lastTick = { at: new Date(), ok: false, error: String(err), report };
            throw err;
          }
        } while (this.rerun);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  /** Resolves once any scheduled or running tick has finished (used for graceful shutdown and tests). */
  async idle(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    while (this.ticking) await this.ticking.catch(() => undefined);
  }

  /** Run a tick soon (after MCP writes) instead of waiting for the next interval. */
  kick(): void {
    setImmediate(() => {
      this.tick().catch((err) => log.error('hub.tick_failed', { error: String(err) }));
    });
  }

  start(): () => void {
    const timer = setInterval(() => {
      this.tick().catch((err) => log.error('hub.tick_failed', { error: String(err) }));
    }, this.cfg.router.tickMs);
    void this.tick().catch((err) => log.error('hub.tick_failed', { error: String(err) }));
    return () => clearInterval(timer);
  }
}
