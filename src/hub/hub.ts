import type { AgentId, DaemonConfig, DaemonMessage } from '../shared/types.js';
import { log } from '../shared/log.js';
import { ADAPTERS } from './adapters/index.js';
import type { AdapterContext } from './adapters/types.js';
import { Approvals, type CommandOutcome, type InboundCommand } from './approvals.js';
import type { HubConfig } from './config.js';
import { debriefActive, noteDebriefStart, processPendingDebrief, queueDigestNow } from './debrief.js';
import { dispatchApproved } from './dispatch.js';
import { backoffMs } from './backoff.js';
import { Importer } from './importer.js';
import { VaultSync } from './vault.js';
import { WorkerError, WorkerUnavailable, type Worker } from './worker.js';
import { routeEvent } from './router.js';
import { localDateKey } from './tz.js';
import { REPLY_ATTRIBUTION_WINDOW_MS } from './tasks.js';
import { normalizeHandle, sameHandle } from '../shared/handles.js';
import type { EventRow, RawMessageRow, Store } from './store.js';
import type { Transports } from './transports/index.js';
import { Connections } from './connections.js';
import type { SecretStore } from './secrets.js';
import { telegramLoginDriver, type TelegramLoginDriver } from './telegramLogin.js';

const ROUTE_BACKOFF_BASE_MS = 30_000;

export interface HubOptions {
  secrets?: SecretStore | null;
  /** The environment the config was loaded from; settings it defines are locked in the dashboard. */
  env?: Record<string, string | undefined>;
  makeTransports?: (cfg: HubConfig, store: Store) => Transports;
  makeWorker?: (cfg: HubConfig) => Worker | null;
}

export type MacInstaller = (hubUrl: string, pairingCode: string) => Promise<void>;

export { normalizeHandle } from '../shared/handles.js';

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
  readonly vault: VaultSync;
  readonly importer: Importer;
  /** Set when the worker's account can't run; events wait instead of burning retries. */
  workerPausedUntil = 0;
  workerProblem: string | null = null;
  lastTick: { at: Date; ok: boolean; error?: string; report?: TickReport } | null = null;

  readonly connections: Connections;
  /** Drives the Stanley login on the Connections page; replaced with a fake in tests. */
  telegramLogin: TelegramLoginDriver = telegramLoginDriver();
  /** Installs the daemon when the hub itself runs on the Mac; replaced in tests. */
  macInstaller: MacInstaller | null = null;

  constructor(
    readonly store: Store,
    readonly cfg: HubConfig,
    readonly transports: Transports,
    public worker: Worker | null,
    private opts: HubOptions = {},
  ) {
    this.ctx = { store, cfg, transports };
    this.approvals = new Approvals({ store, cfg, transports, kick: () => this.kick() });
    this.connections = new Connections(store, opts.secrets ?? null, cfg, opts.env ?? {});
    this.connections.onChange = () => this.reconfigure();
    this.importer = new Importer(this);
    this.vault = new VaultSync(store, cfg, (text) => this.approvals.ownerCommand(text, 'vault'));
  }

  /**
   * Re-reads settings changed in the dashboard. With factories (production) the transports and the
   * worker are rebuilt from the new config; without them (tests) the injected fakes stay.
   */
  async reconfigure(): Promise<void> {
    this.connections.apply();
    if (this.opts.makeTransports) {
      const next = this.opts.makeTransports(this.cfg, this.store);
      await this.transports.telegramUser?.close?.().catch(() => undefined);
      Object.assign(this.transports, next);
    }
    if (this.opts.makeWorker) this.worker = this.opts.makeWorker(this.cfg);
    this.workerPausedUntil = 0;
    this.workerProblem = null;
  }

  // ---------------------------------------------------------------- daemon

  daemonConfig(paused: boolean): DaemonConfig {
    const handles = new Set<string>();
    for (const a of Object.values(ADAPTERS)) for (const h of a.imessageHandles?.(this.cfg) ?? []) handles.add(h);
    const approvalHandle = this.cfg.approval.channel === 'imessage' ? this.cfg.approval.imessageHandle : null;
    if (approvalHandle) handles.add(approvalHandle);
    return { watchHandles: [...handles], approvalHandle, pollIntervalMs: 5000, paused };
  }

  agentForHandle(handle: string): AgentId | null {
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
    const filed: DaemonMessage[] = [];
    const approvalHandle = this.cfg.approval.channel === 'imessage' ? this.cfg.approval.imessageHandle : null;
    const ordered = [...messages].sort((a, b) => a.rowid - b.rowid);
    for (const m of ordered) {
      const text = (m.text ?? '').trim();
      if (!text) continue;
      const sentAt = new Date(m.sentAt);

      if (approvalHandle && sameHandle(m.handle, approvalHandle)) {
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
      filed.push({ ...m, text });
      await this.store.touchRead(agent);
      if (agent === 'instinct' && author === 'user' && (await noteDebriefStart(this.ctx, inserted[0]))) this.kick();
    }
    // The same lines become that day's note in the vault, so Obsidian stays current without waiting for the old-chat import.
    if (filed.length) {
      await this.importer.addHistory(filed, (handle) => this.agentForHandle(handle)).catch(async (err) => {
        await this.store.audit('hub', 'import.step_failed', { error: (err as Error).message.slice(0, 200) });
      });
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

  /** Rules first: the worker only spends tokens on what a rule can't settle. */
  private needsWorker(event: EventRow): boolean {
    if (event.kind === 'chat') return this.cfg.worker.sources.includes(event.agent);
    // A session the agent summarised itself is already structured, unless it passed along decisions or an excerpt.
    return event.kind === 'session' && event.raw_excerpt !== `Agent's summary: ${event.summary}`;
  }

  /** A day's worth of worker runs is capped so agents reacting to each other can't drain your plan. */
  private async takeWorkerRun(now: Date): Promise<boolean> {
    const date = localDateKey(now, this.cfg.timezone);
    const used = await this.store.getSetting<{ date: string; runs: number }>('worker.usage', { date, runs: 0 });
    const runs = used.date === date ? used.runs : 0;
    if (runs >= this.cfg.worker.maxRunsPerDay) return false;
    await this.store.setSetting('worker.usage', { date, runs: runs + 1 });
    return true;
  }

  async workerUnavailable(err: WorkerUnavailable, now: Date): Promise<void> {
    this.workerPausedUntil = now.getTime() + (err.retryAfterMs ?? 30 * 60_000);
    const changed = this.workerProblem !== err.reason;
    this.workerProblem = err.reason;
    log.warn('worker.unavailable', { reason: err.reason });
    if (!changed) return;
    await this.store.audit('hub', 'worker.unavailable', { reason: err.reason });
    await this.approvals.notifyUser(`Hub: ${err.message}. Conversations are waiting and nothing is lost. Switch accounts in Settings, or it retries by itself.`);
  }

  /**
   * Failures are persisted on the event (attempts, last error, next retry time), retried with exponential
   * backoff (honouring any suggested wait), and after ROUTER_MAX_ATTEMPTS the event moves to the dead-letter
   * queue. A failing event never blocks the ones behind it, and nothing here throws out of the tick.
   */
  private async routePendingNow(now: Date): Promise<number> {
    let routed = 0;
    for (const event of await this.store.unroutedEvents(now)) {
      try {
        const wanted = this.worker !== null && this.needsWorker(event);
        // Paused or out of runs for today: the event stays queued and costs nothing.
        if (wanted && (now.getTime() < this.workerPausedUntil || !(await this.takeWorkerRun(now)))) continue;
        const debrief = event.agent === 'instinct' && (await debriefActive(this.ctx, new Date(event.occurred_at)));
        await routeEvent({ store: this.store, cfg: this.cfg, worker: wanted ? this.worker : null }, event, { debrief });
        if (wanted) {
          this.workerProblem = null;
          await this.store.audit('hub', 'worker.run', { event: event.id, usage: this.worker?.lastUsage ?? null });
        }
        routed++;
      } catch (err) {
        if (err instanceof WorkerUnavailable) {
          await this.workerUnavailable(err, now);
          continue;
        }
        const error = err instanceof Error ? err.message : String(err);
        const attempt = event.route_attempts + 1;
        log.warn('router.failed', { event: event.id, attempt, error });
        await this.store.audit('router', 'event.route_failed', { event: event.id, attempt, error });
        if (attempt >= this.cfg.router.maxAttempts) {
          await this.store.recordRouteFailure(event.id, error, null);
          await this.store.deadLetterEvent(event.id, error);
          continue;
        }
        const hint = err instanceof WorkerError ? err.retryAfterMs : null;
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
    const scopes = await this.store.scopes();
    for (const a of Object.values(ADAPTERS)) {
      if (scopes.get(a.id)?.enabled === false) continue;
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
            await this.vault.sync();
            this.importer.kick();
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
    await this.importer.idle();
  }

  /** Run a tick soon (after MCP writes) instead of waiting for the next interval. */
  kick(): void {
    setImmediate(() => {
      this.tick().catch((err) => log.error('hub.tick_failed', { error: String(err) }));
    });
  }

  start(): () => void {
    void this.store.requeueTransientFailures().catch((err) => log.warn('router.requeue_failed', { error: String(err) }));
    void this.store.releaseHistoryClaims().catch((err) => log.warn('import.history_release_failed', { error: String(err) }));
    void this.store.getSetting<{ state?: string; afterRowId?: number } | null>('import.history', null).then((hist) => {
      log.info('import.history_state', { state: hist?.state ?? 'none', afterRowId: hist?.afterRowId ?? null });
    }).catch((err) => log.warn('import.history_state_failed', { error: String(err) }));
    const timer = setInterval(() => {
      this.tick().catch((err) => log.error('hub.tick_failed', { error: String(err) }));
    }, this.cfg.router.tickMs);
    void this.tick().catch((err) => log.error('hub.tick_failed', { error: String(err) }));
    return () => clearInterval(timer);
  }
}
