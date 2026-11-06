import { TOPICS, type AgentId, type Autonomy } from '../../shared/types.js';
import { ADAPTERS } from '../adapters/index.js';
import type { Hub } from '../hub.js';
import { HARD_DENY, SENSITIVE, type Scope } from '../scopes.js';
import { metaFor } from './agents.js';
import { avatar, field, h, hidden, pill, relTime } from './layout.js';
import { connectPanel, type PanelCtx } from './panels.js';
import { STATE_LABEL, STATE_TONE, agentCards, type AgentCard } from './status.js';

export const TOPIC_LABELS: Record<string, string> = {
  plan: 'Plans', schedule: 'Schedule', school: 'School', projects: 'Projects', work: 'Work', open_source: 'Open source', content: 'Content',
  shoots: 'Shoots', professional: 'Professional', networking: 'Networking', health: 'Health', finances: 'Finances', personal: 'Personal', general: 'Everything else',
};

export const AUTONOMY: { value: Autonomy; label: string; note: string }[] = [
  { value: 'ask', label: 'Ask me first', note: 'Text me for a yes or no before anything goes out.' },
  { value: 'notify', label: 'Send, then tell me', note: 'For hand-offs you started yourself.' },
  { value: 'auto', label: 'Send silently', note: 'For hand-offs you started yourself.' },
];

function card(c: AgentCard): string {
  const meta = metaFor(c.agent);
  return `<a class="card agent-card" href="/connections/${h(c.agent)}">
  <div class="head">${avatar(c.name, meta.color, 44)}<div class="grow" style="min-width:0"><h3>${h(c.name)}</h3><div class="meta">${h(meta.tagline)}</div></div></div>
  <div class="between">${pill(STATE_LABEL[c.state], STATE_TONE[c.state])}<span class="meta">${c.lastEventAt ? `Last event ${h(relTime(c.lastEventAt))}` : 'No events yet'}</span></div>
  <div class="meta">${h(c.detail)}</div>
  <span class="btn ${c.state === 'connected' ? 'secondary' : ''} sm" style="align-self:flex-start">${c.state === 'setup' ? 'Connect' : 'Manage'}</span></a>`;
}

export async function connectionsGrid(hub: Hub): Promise<string> {
  const cards = await agentCards(hub);
  const ready = cards.filter((c) => c.state === 'connected').length;
  return `<div class="hero"><div><h1>Connections</h1><div class="muted">${ready} of ${cards.length} agents connected</div></div>
    <a class="btn secondary" href="/settings#mac">Your Mac</a></div>
  <div class="grid">${cards.map(card).join('')}
    <a class="card agent-card add" href="/connections/new"><span style="line-height:1">+</span><b>Add custom agent</b><span class="small">Any agent that can call MCP or a webhook</span></a></div>`;
}

function settingsBlock(agent: AgentId, scope: Scope | undefined, back: string): string {
  const s = scope ?? { agent, allow_topics: [], deny_topics: SENSITIVE, autonomy: 'ask' as Autonomy, enabled: false };
  const hard = new Set(HARD_DENY[agent] ?? []);
  const all = s.allow_topics.includes('*');
  const chips = TOPICS.map((t) => {
    const locked = hard.has(t);
    const checked = !locked && !s.deny_topics.includes(t) && (all || s.allow_topics.includes(t));
    return `<label class="chip${locked ? ' locked' : ''}" title="${locked ? 'Never shared with this agent (enforced in code)' : ''}"><input type="checkbox" name="topic" value="${t}"${checked ? ' checked' : ''}${locked ? ' disabled' : ''}>${h(TOPIC_LABELS[t] ?? t)}${locked ? ' · never' : ''}</label>`;
  }).join('');
  const seg = AUTONOMY.map((a) => `<label><input type="radio" name="autonomy" value="${a.value}"${s.autonomy === a.value ? ' checked' : ''}> <b>${a.label}</b><span class="muted">${a.note}</span></label>`).join('');
  return `<form method="post" action="/connections/${h(agent)}/settings" class="stack">${hidden('back', back)}
  <div><div class="label">What ${h(ADAPTERS[agent].name)} can see</div><div class="chips">${chips}</div>
    <p class="help">Health, finances, school and personal topics stay off for most agents. Unticked topics are also checked again, word for word, before anything is sent.</p></div>
  <div><div class="label">Hand-offs to ${h(ADAPTERS[agent].name)}</div><div class="seg">${seg}</div>
    <p class="help">Anything an agent suggested on its own always asks you first, whatever this says.</p></div>
  <div class="row"><button class="btn">Save settings</button></div></form>`;
}

export async function connectionDetail(hub: Hub, agent: AgentId, ctx: PanelCtx): Promise<string> {
  const cards = await agentCards(hub);
  const c = cards.find((x) => x.agent === agent)!;
  const meta = metaFor(agent);
  const scope = await hub.store.scope(agent);
  const custom = agent.startsWith('custom-');
  return `<p class="mb0"><a href="/connections" class="small">← All connections</a></p><div style="height:48px"></div><div class="detail-head">${avatar(c.name, meta.color, 56)}<div><h1>${h(c.name)}</h1><div class="muted">${h(custom ? ADAPTERS[agent].capabilities.profile : meta.tagline)}</div></div>
    <div class="row">${pill(STATE_LABEL[c.state], STATE_TONE[c.state])}<div class="muted small">${c.lastEventAt ? `Last event ${h(relTime(c.lastEventAt))}` : 'No events yet'}</div></div></div>
  ${c.missing.length ? `<div class="banner warn"><div><b>To finish connecting:</b> ${c.missing.map(h).join(' · ')}</div></div>` : ''}
  ${c.state === 'error' ? `<div class="banner err"><div><b>Problem:</b> ${h(c.detail)}</div></div>` : ''}
  <div class="section-head"><h2>Connect</h2></div>
  <section class="card">${connectPanel(hub, agent, ctx)}</section>
  <div class="section-head"><h2>Settings</h2></div>
  <section class="card">${settingsBlock(agent, scope, ctx.back)}</section>
  <section class="card"><div class="between"><div><h3>${c.enabled ? 'Pause' : 'Paused'}</h3><div class="muted small">${c.enabled ? `Stop sending ${h(c.name)} context and tasks, without forgetting its setup.` : `${h(c.name)} gets nothing until you resume.`}</div></div>
    <form method="post" action="/connections/${h(agent)}/${c.enabled ? 'pause' : 'resume'}" class="inline">${hidden('back', ctx.back)}<button class="btn ${c.enabled ? 'secondary' : 'ok'}">${c.enabled ? 'Pause' : 'Resume'}</button></form></div></section>
  <section class="card"><div class="between"><div><h3>Disconnect</h3><div class="muted small">Removes what you entered here and signs ${h(c.name)} out of the hub.${custom ? '' : ' Settings from .env stay.'}</div></div>
    <div class="row"><form method="post" action="/connections/${h(agent)}/disconnect" class="inline" data-confirm="Disconnect ${h(c.name)}? It will need to be set up again.">${hidden('back', ctx.back)}<button class="btn danger-ghost">Disconnect</button></form>
    ${custom ? `<form method="post" action="/connections/${h(agent)}/delete" class="inline" data-confirm="Delete ${h(c.name)} completely?"><button class="btn danger">Delete agent</button></form>` : ''}</div></div></section>`;
}

export function newCustomAgent(error?: string): string {
  const chips = TOPICS.filter((t) => !SENSITIVE.includes(t)).map((t) => `<label class="chip"><input type="checkbox" name="topic" value="${t}"${['projects', 'work'].includes(t) ? ' checked' : ''}>${h(TOPIC_LABELS[t])}</label>`).join('');
  return `<p><a href="/connections" class="small">← All connections</a></p><h1>Add a custom agent</h1>
  <p class="muted">Any agent that can call an MCP server or a webhook can join: it gets the shared situation, logs what it did, and receives approved hand-offs.</p>
  ${error ? `<div class="flash err">${h(error)}</div>` : ''}
  <form method="post" action="/connections/new" class="card stack">
    ${field('name', 'Name', { placeholder: 'e.g. Notion AI', required: true })}
    ${field('profile', 'What it’s good at', { placeholder: 'Keeps my reading list and notes organised', help: 'The hub uses this to decide which hand-offs should go to it.' })}
    <div><div class="label">What it can see</div><div class="chips">${chips}</div><p class="help">Sensitive topics (health, finances, school, personal) start off. You can change this later.</p></div>
    <div class="row"><button class="btn">Add agent</button></div></form>`;
}
