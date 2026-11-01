import { AGENT_IDS, type AgentId } from '../../shared/types.js';
import { ADAPTERS } from '../adapters/index.js';
import type { Hub } from '../hub.js';
import { AGENT_META } from './agents.js';
import { avatar, field, h, hidden } from './layout.js';
import { connectPanel, keepAwakeBlock, macBlock } from './panels.js';

export type Step = 'welcome' | 'mac' | 'keep-awake' | 'phone' | 'brain' | 'agents' | `agent-${string}` | 'finish';

/** The wizard's steps for this hub, in order. Agent steps follow the agents picked in "agents". */
export function wizardSteps(hub: Hub): Step[] {
  const s: Step[] = ['welcome', 'mac', 'keep-awake', 'phone'];
  if (hub.connections.source('router.key') !== 'env') s.push('brain');
  s.push('agents');
  for (const a of hub.connections.onboarding.agents) s.push(`agent-${a}`);
  s.push('finish');
  return s;
}

export function stepAgent(step: string): AgentId | null {
  const a = step.startsWith('agent-') ? step.slice(6) : null;
  return a && a in ADAPTERS ? (a as AgentId) : null;
}

interface StepView {
  title: string;
  lead?: string;
  /** Rendered above the Continue form (may contain its own forms). */
  body?: string;
  /** Rendered inside the Continue form. */
  formBody?: string;
  skippable?: boolean;
  next?: string;
}

function welcome(hub: Hub): StepView {
  const name = hub.connections.value('owner.name') ?? (hub.cfg.ownerName === 'the user' ? '' : hub.cfg.ownerName);
  const nameLock = hub.connections.source('owner.name') === 'env' ? 'HUB_OWNER_NAME' : null;
  return {
    title: 'Welcome to Agent Hub',
    lead: 'Your AI agents each know a slice of your life. The hub quietly keeps them in sync, and lets them hand work to each other, with you approving every hand-off.',
    body: `<div class="card stack">
      <div class="feature"><span class="dot">⇄</span><div><b>Silent context sync</b><div class="muted">When you tell Instinct you're shooting tomorrow, Stanley knows. Claude knows what you planned with ChatGPT.</div></div></div>
      <div class="feature"><span class="dot">✓</span><div><b>You approve every hand-off</b><div class="muted">If one agent should ask another to do something, you get a text: reply Y or N.</div></div></div>
      <div class="feature"><span class="dot">🔒</span><div><b>Private by default</b><div class="muted">Each agent only sees the topics you allow. The hub never writes into your own chats, and never reads anything but the threads you pick.</div></div></div>
    </div>`,
    formBody: `<div class="card">${nameLock ? field('owner.name', 'What should your agents call you?', { locked: nameLock }) : field('owner.name', 'What should your agents call you?', { value: name, placeholder: 'Your first name', autocomplete: 'given-name' })}
      <input type="hidden" name="owner.timezone" data-tz value="${h(hub.cfg.timezone)}"><p class="help">Time zone: <span data-tz-label>${h(hub.cfg.timezone)}</span></p></div>
      <script>(function(){try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(z){document.querySelector('[data-tz]').value=z;document.querySelector('[data-tz-label]').textContent=z}}catch(e){}})()</script>`,
  };
}

function mac(hub: Hub): StepView {
  return {
    title: 'Connect your Mac',
    lead: 'Instinct, Stanley and Boardy live in Messages on your Mac. A small helper reads just their threads (read-only) and sends your approval texts.',
    body: `<div class="card">${macBlock(hub, { installHere: Boolean(hub.macInstaller) })}</div>`,
    skippable: true,
  };
}

function keepAwake(): StepView {
  return {
    title: 'Keep your Mac awake?',
    lead: 'The hub can only read Messages while your Mac is awake. If you close the lid a lot, you can stop it from sleeping.',
    body: `<div class="card">${keepAwakeBlock()}</div><div data-widget="mac-status" class="hide"></div>`,
    skippable: true,
  };
}

function phone(hub: Hub): StepView {
  const lock = hub.connections.source('approval.handle') === 'env' ? 'APPROVAL_IMESSAGE_HANDLE' : null;
  return {
    title: 'Where should approvals go?',
    lead: 'When one agent wants to hand something to another, the hub texts you. Reply “Y” and the code to approve, or “N” to say no.',
    formBody: `<div class="card stack">${lock ? field('approval.handle', 'Approval number', { locked: lock }) : field('approval.handle', 'Your phone number (or iMessage email)', { value: hub.cfg.approval.imessageHandle ?? '', placeholder: '+1 555 123 4567', inputmode: 'tel', autocomplete: 'tel', help: 'Texts come from your Mac. Only replies you send from your own iPhone or Mac count, never anyone else’s.' })}
      <div data-widget="test-text" data-input="#f-approval-handle" class="stack"><div class="row"><button type="button" class="btn secondary">Send a test text</button></div><div data-status class="hide"></div></div></div>`,
    skippable: true,
  };
}

function brain(hub: Hub): StepView {
  const provider = hub.cfg.router.provider === 'openai' ? 'openai' : 'anthropic';
  const saved = hub.connections.isSet('router.key');
  return {
    title: 'Give the hub a brain',
    lead: 'The hub uses an AI model to read what happened in each conversation and decide what other agents should know. Bring your own key. It costs cents a day.',
    formBody: `<div class="card stack">
      <div class="seg" style="grid-template-columns:1fr 1fr">
        <label><input type="radio" name="router.provider" value="anthropic"${provider === 'anthropic' ? ' checked' : ''}> <b>Anthropic</b><span class="muted">Claude. Key from console.anthropic.com</span></label>
        <label><input type="radio" name="router.provider" value="openai"${provider === 'openai' ? ' checked' : ''}> <b>OpenAI</b><span class="muted">Key from platform.openai.com</span></label></div>
      ${field('router.key', 'API key', { type: 'password', secretSaved: saved, placeholder: 'sk-…', help: `Saved encrypted (${h(hub.connections.secrets?.label ?? 'secret store')}). Never shown again.` })}
      ${saved ? '<div data-widget="test-router" class="stack"><div class="row"><button type="button" class="btn secondary">Test the key</button></div><div data-status class="hide"></div></div>' : ''}</div>`,
    skippable: true,
  };
}

function agents(hub: Hub): StepView {
  const picked = new Set<string>(hub.connections.onboarding.agents.length ? hub.connections.onboarding.agents : []);
  return {
    title: 'Which agents do you use?',
    lead: 'Pick the ones you have. We’ll set each up next, one at a time. Agents you don’t pick stay off.',
    formBody: `<div class="stack">${AGENT_IDS.map((a) => `<label class="choice"><input type="checkbox" name="agent" value="${a}"${picked.has(a) ? ' checked' : ''}>
        ${avatar(ADAPTERS[a].name, AGENT_META[a].color, 36)}<span class="grow"><b>${h(ADAPTERS[a].name)}</b><div class="muted small">${h(AGENT_META[a].tagline)}</div></span></label>`).join('')}
      <p class="muted small">Using something else? Add a custom agent from Connections later.</p></div>`,
  };
}

function agentStep(hub: Hub, agent: AgentId, back: string, revealed?: Record<string, string>): StepView {
  const meta = AGENT_META[agent as keyof typeof AGENT_META];
  return {
    title: `Connect ${ADAPTERS[agent].name}`,
    lead: meta?.tagline,
    body: `<div class="card">${connectPanel(hub, agent, { back, revealed })}</div>`,
    skippable: true,
  };
}

function finish(): StepView {
  return {
    title: 'You’re all set',
    lead: 'Let’s make sure it works end to end. Send a test event through the hub and watch it arrive.',
    body: `<div class="card" data-widget="test-event"><div class="stack"><div class="row"><button type="button" class="btn big">Send a test event</button></div><div data-status class="hide"></div>
      <ul class="list hide" data-event-list></ul></div></div>
      <p class="muted">From now on, the <b>Today</b> page shows what each agent did, what's waiting for your approval, and whether everything is healthy. It works on your phone too: add it to your home screen.</p>`,
    next: 'Go to Today',
  };
}

export function renderStep(hub: Hub, step: Step, revealed?: Record<string, string>): { html: string; title: string } | null {
  const all = wizardSteps(hub);
  const i = all.indexOf(step);
  if (i < 0) return null;
  const back = `/onboarding/${step}`;
  const agent = stepAgent(step);
  const v =
    step === 'welcome' ? welcome(hub)
    : step === 'mac' ? mac(hub)
    : step === 'keep-awake' ? keepAwake()
    : step === 'phone' ? phone(hub)
    : step === 'brain' ? brain(hub)
    : step === 'agents' ? agents(hub)
    : step === 'finish' ? finish()
    : agent ? agentStep(hub, agent, back, revealed) : null;
  if (!v) return null;
  const prev = i > 0 ? all[i - 1] : null;
  const next = all[i + 1] ?? null;
  const pct = Math.round(((i + 1) / all.length) * 100);
  const html = `<div class="wizard">
  <div class="between"><span class="kicker">Step ${i + 1} of ${all.length}</span>${step === 'welcome' ? `<form method="post" action="/onboarding/skip-all" class="inline"><button class="btn ghost sm">Skip setup</button></form>` : ''}</div>
  <div class="progress" aria-hidden="true"><i style="width:${pct}%"></i></div>
  <h1>${h(v.title)}</h1>${v.lead ? `<p class="muted" style="font-size:16px;margin-top:6px">${h(v.lead)}</p>` : ''}
  ${v.body ?? ''}
  <form method="post" action="/onboarding/${h(step)}">${hidden('step', step)}${v.formBody ?? ''}
    <div class="wizard-foot">${prev ? `<a class="btn ghost" href="/onboarding/${h(prev)}">Back</a>` : '<span></span>'}
      <div class="right">${v.skippable && next ? `<a class="btn ghost" href="/onboarding/${h(next)}">Skip for now</a>` : ''}<button class="btn big">${h(v.next ?? 'Continue')}</button></div></div>
  </form></div>`;
  return { html, title: v.title };
}
