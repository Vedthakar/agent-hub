import { isAgentId, type AgentId } from '../../shared/types.js';
import { ADAPTERS } from '../adapters/index.js';
import type { Hub } from '../hub.js';
import type { EventRow } from '../store.js';
import { formatLocal, startOfLocalDay } from '../tz.js';
import { metaFor } from './agents.js';
import { avatar, h, pill, relTime } from './layout.js';
import { STATE_LABEL, STATE_TONE, agentCards, macStatus } from './status.js';

const nameOf = (a: string) => (isAgentId(a) ? ADAPTERS[a].name : a);
const chip = (a: string, size = 28) => avatar(nameOf(a), metaFor(a as AgentId).color, size);

function greeting(hub: Hub): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: hub.cfg.timezone }).format(new Date()));
  const part = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return hub.cfg.ownerName && hub.cfg.ownerName !== 'the user' ? `${part}, ${hub.cfg.ownerName}` : part;
}

/** The auto-refreshing body of the Today page. */
export async function todayFragment(hub: Hub): Promise<string> {
  const { store, cfg } = hub;
  const t = (d: Date | string | null) => (d ? formatLocal(new Date(d), cfg.timezone) : '—');
  const midnight = startOfLocalDay(new Date(), cfg.timezone);
  const [paused, proposed, live, events, cards, mac, dead] = await Promise.all([
    store.isPaused(),
    store.tasksByStatus(['proposed']),
    store.liveSituation(),
    store.eventsSince(midnight, 300),
    agentCards(hub),
    macStatus(hub),
    store.openDeadLetters(),
  ]);
  const upcoming = await store.db.query<{ id: number; text: string; valid_from: Date; expires_at: Date | null; source_agent: string }>(
    `SELECT id, text, valid_from, expires_at, source_agent FROM situation
     WHERE superseded_at IS NULL AND valid_from > now() ORDER BY valid_from LIMIT 10`,
  );

  const approvals = proposed.length
    ? proposed.map((task) => `<article class="card approval">
        <div class="between"><div class="row">${chip(task.origin_agent, 26)}<span class="muted">→</span>${chip(task.target_agent, 26)}<b>${h(nameOf(task.origin_agent))} → ${h(nameOf(task.target_agent))}</b></div>
          <code>${h(task.code)}</code></div>
        <p style="margin:10px 0 4px;font-size:16px">${h(task.payload)}</p>
        <div class="muted small">${task.author === 'user' ? 'You decided this' : '<b>Agent-suggested</b>, not from your own messages'}${task.rationale ? ` · ${h(task.rationale)}` : ''}${task.approval_expires_at ? ` · expires ${h(t(task.approval_expires_at))}` : ''}</div>
        <div class="actions">
          <form method="post" action="/actions/task/${task.id}/approve" class="inline"><button class="btn ok big block">Approve</button></form>
          <form method="post" action="/actions/task/${task.id}/reject" class="inline"><button class="btn danger-ghost big block">Deny</button></form>
        </div></article>`).join('')
    : `<div class="card flat center muted">Nothing waiting for you. Hand-offs between agents show up here (and as a text) for a yes or no.</div>`;

  const situation = [...live.map((s) => ({ ...s, upcoming: false })), ...upcoming.map((s) => ({ ...s, upcoming: true }))];
  const situationHtml = situation.length
    ? `<ul class="list">${situation.map((s) => `<li>${chip(s.source_agent, 26)}<div class="grow">${h(s.text)}${s.upcoming ? ` ${pill('upcoming', 'accent')}` : ''}
        <div class="muted small">${s.upcoming ? `from ${h(t(s.valid_from))} · ` : ''}until ${h(t(s.expires_at))}</div></div>
        <form method="post" action="/actions/situation/${s.id}/expire" class="inline"><button class="btn ghost sm" title="Clear this">Clear</button></form></li>`).join('')}</ul>`
    : '<p class="muted mb0">Nothing yet. As you talk to your agents, what you’re up to shows up here.</p>';

  const byAgent = new Map<string, EventRow[]>();
  for (const e of events) byAgent.set(e.agent, [...(byAgent.get(e.agent) ?? []), e]);
  const eventsHtml = byAgent.size
    ? [...byAgent.entries()].map(([agent, evs]) => `<div class="card tight"><div class="between"><div class="row">${chip(agent, 30)}<b>${h(nameOf(agent))}</b></div><span class="muted small">${evs.length} update${evs.length === 1 ? '' : 's'}</span></div>
        <ul class="list">${evs.slice(0, 6).map((e) => `<li><div class="grow">${h(e.summary || 'Processing…')}<div class="muted small">${e.author === 'user' ? 'with you' : 'agent-reported'}${e.kind !== 'session' && e.kind !== 'message' ? ` · ${h(e.kind.replace('_', ' '))}` : ''}</div></div><span class="time">${h(relTime(e.occurred_at))}</span></li>`).join('')}</ul></div>`).join('')
    : '<div class="card flat center muted">No agent activity yet today.</div>';

  const health = `<ul class="list">${cards.map((c) => `<li>${chip(c.agent, 26)}<div class="grow"><a href="/connections/${h(c.agent)}"><b>${h(c.name)}</b></a><div class="muted small">${h(c.detail)}</div></div>
      <div style="text-align:right">${pill(STATE_LABEL[c.state], STATE_TONE[c.state])}<div class="time">${c.lastEventAt ? h(relTime(c.lastEventAt)) : ''}</div></div></li>`).join('')}
    <li><span class="avatar" style="--c:var(--muted);width:26px;height:26px;font-size:11px">⌘</span><div class="grow"><a href="/settings#mac"><b>Your Mac</b></a><div class="muted small">${mac.online ? (mac.fullDiskAccess === false ? 'Needs Full Disk Access' : `Online${mac.keepAwake ? ' · kept awake' : ''}`) : mac.lastSeenAt ? `Last seen ${h(relTime(mac.lastSeenAt))}` : 'Not connected'}</div></div>
      ${pill(mac.online ? (mac.fullDiskAccess === false ? 'Needs setup' : 'Online') : mac.lastSeenAt ? 'Offline' : 'Needs setup', mac.online ? (mac.fullDiskAccess === false ? 'warn' : 'ok') : mac.lastSeenAt ? 'err' : 'warn')}</li></ul>`;

  const deadHtml = dead.length
    ? `<section class="card"><div class="between"><h2 class="mb0">Needs attention</h2>${pill(`${dead.length}`, 'err')}</div><p class="muted small">Work the hub gave up on after retrying. Retry once the cause is fixed, or dismiss.</p>
      <ul class="list">${dead.map((d) => `<li><div class="grow"><b>${h(d.kind)}</b>${d.agent ? ` · ${h(nameOf(d.agent))}` : ''}<div class="muted small">${h(d.reason)} · ${d.attempts} attempts · ${h(t(d.created_at))}</div></div>
        <form method="post" action="/actions/dead-letter/${d.id}/retry" class="inline"><button class="btn secondary sm">Retry</button></form>
        <form method="post" action="/actions/dead-letter/${d.id}/dismiss" class="inline"><button class="btn ghost sm">Dismiss</button></form></li>`).join('')}</ul></section>`
    : '';

  return `
  <div class="between" style="margin-bottom:18px"><div><h1>${h(greeting(hub))}</h1><div class="muted">${h(new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: cfg.timezone }).format(new Date()))}</div></div>
    <form method="post" action="/actions/${paused ? 'resume' : 'pause'}" class="inline"${paused ? '' : ' data-confirm="Pause the hub? Agents stop getting context and tasks until you resume."'}><button class="btn ${paused ? 'ok' : 'secondary'}">${paused ? 'Resume hub' : 'Pause hub'}</button></form></div>
  ${paused ? '<div class="banner err"><div><b>The hub is paused.</b> No context or tasks go to any agent. Approval texts still work.</div></div>' : ''}
  <section><div class="section-head"><h2>Waiting for you</h2>${proposed.length ? pill(`${proposed.length}`, 'warn') : ''}</div>${approvals}</section>
  ${deadHtml}
  <div class="two">
    <div><div class="section-head"><h2>Today</h2><a class="small" href="/timeline">All activity →</a></div>${eventsHtml}</div>
    <div>
      <div class="section-head"><h2>Right now</h2></div><section class="card">${situationHtml}</section>
      <div class="section-head"><h2>Health</h2><a class="small" href="/connections">Connections →</a></div><section class="card">${health}</section>
    </div>
  </div>`;
}

export async function todayBody(hub: Hub): Promise<string> {
  const ob = hub.connections.onboarding;
  const banner = ob.completed ? '' : `<div class="banner"><div><b>Finish setting up.</b> A few steps connect your Mac and agents.</div><a class="btn" href="/onboarding">Continue setup</a></div>`;
  return `${banner}<div id="today" data-widget="today-refresh">${await todayFragment(hub)}</div>`;
}
