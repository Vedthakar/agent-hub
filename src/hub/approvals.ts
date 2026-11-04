import { agentIds, type AgentId, type Autonomy } from '../shared/types.js';
import { log } from '../shared/log.js';
import { ADAPTERS } from './adapters/index.js';
import { COMMAND_HELP, parseCommand } from './commands.js';
import type { HubConfig } from './config.js';
import { canSee } from './scopes.js';
import type { Store, TaskRow } from './store.js';
import { proposeTask } from './tasks.js';
import type { Transports } from './transports/index.js';

export interface InboundCommand {
  channel: 'imessage' | 'telegram' | 'sms';
  /** Transport message id. Seen ids are ignored, so replays are no-ops. */
  externalId: string;
  /** Only the owner's own number / account may approve. Decided by the caller from transport metadata. */
  fromOwner: boolean;
  sender: string;
  text: string;
}

export type CommandOutcome =
  | 'paused' | 'resumed' | 'approved' | 'rejected' | 'cancelled' | 'mixed'
  | 'noted' | 'invalid' | 'expired' | 'stale' | 'missing_code' | 'locked' | 'replay' | 'rejected_sender' | 'ignored';

/** Stands in for an agent id on things you said directly to the hub. */
const OWNER = 'owner' as AgentId;

const DECISION = /^\s*(y|yes|ok|okay|approve|approved|n|no|nope|reject|deny|cancel)\b(.*)$/i;
const CODE_TOKEN = /\b[A-Z0-9]{4}\b/g;
const CODE_ALPHABET = /^[A-HJ-NP-Z2-9]{4}$/;
const LOCKOUT_WINDOW_MS = 15 * 60_000;

interface Deps {
  store: Store;
  cfg: HubConfig;
  transports: Transports;
  kick(): void;
}

export class Approvals {
  constructor(private deps: Deps) {}

  /** One line per task. Hand-offs not backed by the user's own messages say so, since an agent may have planted them. */
  describe(t: TaskRow): string {
    const flag = t.author === 'user' ? '' : ' (agent-suggested, not from your messages)';
    return `[${t.code}] ${ADAPTERS[t.origin_agent]?.name ?? t.origin_agent} → ${ADAPTERS[t.target_agent]?.name ?? t.target_agent}${flag}: ${t.payload.replace(/\s*[\r\n]+\s*/g, ' ')}`;
  }

  /** Sends to the user's approval channel. Returns false if nothing was sent, so callers can retry. */
  async notifyUser(text: string): Promise<boolean> {
    const { cfg, transports, store } = this.deps;
    const a = cfg.approval;
    try {
      if (a.channel === 'imessage' && a.imessageHandle) await transports.imessage.send(a.imessageHandle, text, 'approval');
      else if (a.channel === 'telegram' && transports.telegramBot) await transports.telegramBot.send(text);
      else if (a.channel === 'sms' && transports.sms) await transports.sms.send(text);
      else return false;
      await store.audit('hub', 'user.notified', { channel: a.channel, chars: text.length });
      return true;
    } catch (err) {
      log.warn('approval.notify_failed', { channel: a.channel, error: String(err) });
      await store.audit('hub', 'user.notify_failed', { channel: a.channel, error: String(err) });
      return false;
    }
  }

  /**
   * Autonomy for a task: the per-route setting wins over the target's default. Anything that didn't come
   * straight from the user (agent-suggested, or extracted from an agent-only conversation) always asks,
   * so a prompt-injected message can never trigger an action without a human.
   */
  async autonomyFor(task: TaskRow): Promise<Autonomy> {
    const { store } = this.deps;
    if (task.author !== 'user') return 'ask';
    if (task.origin_event_id) {
      const rows = await store.db.query<{ author: string }>('SELECT author FROM events WHERE id = $1', [task.origin_event_id]);
      if (rows[0]?.author !== 'user') return 'ask';
    }
    return (await store.routeAutonomy(task.origin_agent, task.target_agent)) ?? (await store.scope(task.target_agent))?.autonomy ?? 'ask';
  }

  /** One text covering every task not yet asked about. Tasks are only marked as asked if the text went out. */
  async request(): Promise<number> {
    const { store, cfg } = this.deps;
    if (await store.isPaused()) return 0;
    const pending = (await store.tasksByStatus(['proposed'])).filter((t) => !t.approval_sent_at).reverse();
    if (!pending.length) return 0;
    const ask: TaskRow[] = [];
    const notify: TaskRow[] = [];
    for (const t of pending) {
      const autonomy = await this.autonomyFor(t);
      if (autonomy === 'ask') {
        ask.push(t);
        continue;
      }
      const updated = await store.transitionTask(t.id, ['proposed'], 'approved', { reason: `auto (${autonomy})` });
      if (!updated) continue;
      await store.markApprovalSent(t.id);
      await store.audit('hub', 'task.auto_approved', { code: t.code, autonomy });
      if (autonomy === 'notify') notify.push(t);
    }
    if (notify.length) await this.notifyUser(['Hub sent:', ...notify.map((t) => this.describe(t))].join('\n'));
    if (!ask.length) return 0;
    const ttlH = Math.round(cfg.approval.ttlMs / 3600_000);
    const text =
      ask.length === 1
        ? `${this.describe(ask[0])}\nOK? Reply "Y ${ask[0].code}" or "N ${ask[0].code}" (expires in ${ttlH}h).`
        : [
            `Hub: ${ask.length} hand-offs to approve`,
            ...ask.map((t) => this.describe(t)),
            `Reply "Y <code>" or "N <code>", e.g. "Y ${ask[0].code}". Several codes are fine: "Y ${ask.map((t) => t.code).slice(0, 2).join(' ')}". Expires in ${ttlH}h.`,
          ].join('\n');
    if (!(await this.notifyUser(text))) return 0;
    const expires = new Date(Date.now() + cfg.approval.ttlMs);
    for (const t of ask) await store.markApprovalSent(t.id, expires);
    return ask.length;
  }

  async sweepExpired(): Promise<number> {
    const expired = await this.deps.store.expireApprovals();
    for (const t of expired) await this.deps.store.audit('hub', 'task.expired', { code: t.code });
    return expired.length;
  }

  /**
   * Your own instruction, already authenticated by the caller. Returns the reply, or null if it isn't a command.
   * A hand-off you typed is your approval, except over SMS, where caller ID can be spoofed: that still asks.
   */
  async runCommand(text: string, via: string): Promise<string | null> {
    const { store, cfg } = this.deps;
    const c = parseCommand(text, { tz: cfg.timezone });
    if (!c) return null;
    switch (c.type) {
      case 'help':
        return `Things you can text me:\n${COMMAND_HELP}\nAdd #topic to say who may see it.`;
      case 'situation': {
        await store.addSituation({ text: c.text, slot: c.slot, topics: c.topics, sourceAgent: OWNER, author: 'user', originEventId: null, validFrom: c.validFrom, expiresAt: c.expiresAt });
        await store.audit('user', 'situation.added', { via });
        return `Noted. ${await this.whoSees(c.topics)}`;
      }
      case 'goal':
        await store.addFact({ text: c.text, kind: 'goal', topics: c.topics, sourceAgent: OWNER, author: 'user', originEventId: null });
        await store.audit('user', 'goal.added', { via });
        return `Goal saved. ${await this.whoSees(c.topics)}`;
      case 'forget': {
        const needle = c.text.toLowerCase();
        const facts = (await store.activeFacts()).filter((f) => f.text.toLowerCase().includes(needle));
        const live = (await store.currentAndUpcomingSituation()).filter((s) => s.text.toLowerCase().includes(needle));
        const total = facts.length + live.length;
        if (!total) return 'Nothing matches that.';
        if (total > 1) return `That matches ${total} things. Be more specific:\n${[...facts, ...live].slice(0, 5).map((x) => `- ${x.text}`).join('\n')}`;
        await store.retireFacts(facts.map((f) => f.id));
        await store.supersedeSituation(live.map((s) => s.id), null);
        await store.audit('user', 'memory.forgotten', { via });
        return 'Forgotten.';
      }
      case 'task': {
        const scope = await store.scope(c.target);
        const topics = c.topics ?? (scope?.allow_topics.filter((t) => t !== '*').slice(0, 1) ?? []);
        const outcome = await proposeTask(store, { originAgent: OWNER, targetAgent: c.target, payload: c.text, rationale: '', topics: topics.length ? topics : ['general'], author: 'user', originEventId: null, hop: 1 }, cfg.router.maxHops);
        const name = ADAPTERS[c.target].name;
        if (outcome.kind === 'invalid') return `Couldn't send that: ${outcome.reason}.`;
        if (outcome.kind === 'duplicate') return `Already on it as [${outcome.existing.code}] (${outcome.existing.status}).`;
        if (outcome.kind === 'blocked') return `Not sent to ${name}: ${outcome.reason}.`;
        if (via !== 'sms') await store.transitionTask(outcome.task.id, ['proposed'], 'approved', { reason: `your command (${via})` });
        this.deps.kick();
        return via === 'sms' ? `Reply "Y ${outcome.task.code}" to send it to ${name}.` : `Sending to ${name} [${outcome.task.code}]. Text "cancel ${outcome.task.code}" to stop it.`;
      }
    }
  }

  /** Says who will actually see something, so you can add a #topic if that isn't who you meant. */
  private async whoSees(topics: string[]): Promise<string> {
    const scopes = await this.deps.store.scopes();
    const names = agentIds().filter((a) => canSee(scopes.get(a), topics)).map((a) => ADAPTERS[a].name);
    return names.length ? `${names.join(', ')} can see it.` : 'No agent can see it yet.';
  }

  /** For a vault Inbox note: true if it was a command. */
  async ownerCommand(text: string, via: string): Promise<boolean> {
    return (await this.runCommand(text, via)) !== null;
  }

  async handleInbound(cmd: InboundCommand): Promise<CommandOutcome> {
    const { store, cfg } = this.deps;
    const recordId = await store.recordInbound(cmd.channel, cmd.externalId, cmd.fromOwner ? 'owner' : cmd.sender, cmd.text);
    if (recordId === null) return 'replay';
    const finish = async (outcome: CommandOutcome, reply?: string) => {
      await store.setInboundOutcome(recordId, outcome);
      if (reply) await this.notifyUser(reply);
      return outcome;
    };

    if (!cmd.fromOwner) {
      // Silently drop: replying would confirm to a spoofer that the channel is live.
      await store.audit('hub', 'approval.rejected_sender', { channel: cmd.channel, sender: cmd.sender });
      return finish('rejected_sender');
    }

    const text = cmd.text.trim();
    const lower = text.toLowerCase();
    if (/^pause( the)? hub\b/.test(lower)) {
      await store.setPaused(true, 'user');
      return finish('paused', 'Hub paused. Nothing will be sent to any agent. Text "resume hub" to turn it back on.');
    }
    if (/^(resume|unpause|start)( the)? hub\b/.test(lower)) {
      await store.setPaused(false, 'user');
      this.deps.kick();
      return finish('resumed', 'Hub resumed.');
    }

    const reply = await this.runCommand(text, cmd.channel);
    if (reply !== null) return finish('noted', reply);

    const m = text.match(DECISION);
    if (!m) return finish('ignored');

    const invalidRecent = await store.countInboundOutcomes(['invalid'], new Date(Date.now() - LOCKOUT_WINDOW_MS));
    if (invalidRecent >= cfg.approval.maxInvalidPerWindow) {
      const alreadyTold = await store.countInboundOutcomes(['locked'], new Date(Date.now() - LOCKOUT_WINDOW_MS));
      return finish('locked', alreadyTold ? undefined : 'Too many unknown codes. Approvals are locked for 15 minutes.');
    }

    const verb = m[1].toLowerCase();
    const action: 'approve' | 'reject' | 'cancel' = verb === 'cancel' ? 'cancel' : /^(y|yes|ok|okay|approve|approved)$/.test(verb) ? 'approve' : 'reject';
    const codes = [...new Set((m[2].toUpperCase().match(CODE_TOKEN) ?? []).filter((c) => CODE_ALPHABET.test(c)))];
    if (!codes.length) {
      return finish('missing_code', `Include the code so I know which hand-off you mean, e.g. "${action === 'approve' ? 'Y' : action === 'reject' ? 'N' : 'cancel'} K3FD".`);
    }

    const results: { code: string; result: 'ok' | 'invalid' | 'expired' | 'stale'; status?: string }[] = [];
    for (const code of codes) {
      const task = await store.taskByCode(code);
      if (!task) {
        results.push({ code, result: 'invalid' });
        continue;
      }
      if (action === 'cancel') {
        const updated = await store.transitionTask(task.id, ['proposed', 'approved'], 'cancelled', { reason: 'user cancelled' });
        results.push(updated ? { code, result: 'ok' } : { code, result: 'stale', status: task.status });
        if (updated) await store.audit('user', 'task.cancelled', { code, via: cmd.channel });
        continue;
      }
      if (task.status !== 'proposed' || !task.approval_sent_at) {
        results.push({ code, result: 'stale', status: task.status });
        continue;
      }
      if (task.approval_expires_at && new Date(task.approval_expires_at) <= new Date()) {
        await store.transitionTask(task.id, ['proposed'], 'expired', { reason: 'approval window passed' });
        results.push({ code, result: 'expired' });
        continue;
      }
      const updated = await store.transitionTask(task.id, ['proposed'], action === 'approve' ? 'approved' : 'rejected', { reason: `user replied via ${cmd.channel}` });
      if (!updated) {
        results.push({ code, result: 'stale', status: (await store.task(task.id))?.status });
        continue;
      }
      await store.audit('user', action === 'approve' ? 'task.approved' : 'task.rejected', { code, via: cmd.channel });
      results.push({ code, result: 'ok' });
    }

    const ok = results.filter((r) => r.result === 'ok').map((r) => r.code);
    const lines: string[] = [];
    if (ok.length) lines.push(`${action === 'approve' ? '✓ Approved' : action === 'reject' ? '✗ Rejected' : '✗ Cancelled'} ${ok.join(', ')}.`);
    for (const r of results) {
      if (r.result === 'invalid') lines.push(`${r.code}: no such hand-off.`);
      if (r.result === 'expired') lines.push(`${r.code}: expired, it will not be sent.`);
      if (r.result === 'stale') lines.push(`${r.code}: already ${r.status}.`);
    }
    if (action === 'approve' && ok.length) this.deps.kick();

    const kinds = new Set(results.map((r) => r.result));
    const outcome: CommandOutcome =
      kinds.has('invalid') ? 'invalid' :
      kinds.size > 1 ? 'mixed' :
      kinds.has('expired') ? 'expired' :
      kinds.has('stale') ? 'stale' :
      action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
    return finish(outcome, lines.join('\n'));
  }
}
