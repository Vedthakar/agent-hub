import type { Hub } from '../hub.js';
import { field, h, hidden } from './layout.js';
import { emailBlock, keepAwakeBlock, macBlock } from './panels.js';

const ENV_KEYS: [string, string][] = [
  ['owner.name', 'Your name'],
  ['owner.timezone', 'Time zone'],
  ['approval.handle', 'Approval number'],
  ['router.key', 'AI key'],
  ['email.smtp', 'Email sending'],
  ['email.imap', 'Email reading'],
  ['instinct.email', "Instinct's forwarding email"],
  ['handle.instinct', "Instinct's thread"],
  ['handle.stanley', "Stanley's thread"],
  ['handle.boardy', "Boardy's thread"],
  ['stanley.session', 'Telegram session'],
  ['token.grok', 'Grok Bot token'],
  ['hub.sessionSecret', 'Session signing key'],
];

export function settingsBody(hub: Hub): string {
  const c = hub.connections;
  const lock = (k: string) => (c.source(k) === 'env' ? c.envVar(k) : null);
  const back = '/settings';
  const fromEnv = ENV_KEYS.filter(([k]) => c.source(k) === 'env');
  return `<h1>Settings</h1><p class="muted">Everything here is saved on your hub. Passwords and keys are encrypted (${h(c.secrets?.label ?? 'no secret store configured')}).</p>
  ${c.secretError ? `<div class="banner err"><div><b>Can't read saved secrets:</b> ${h(c.secretError)}</div></div>` : ''}
  <div class="section-head"><h2>You</h2></div>
  <form method="post" action="/settings/profile" class="card">${hidden('back', back)}
    ${field('owner.name', 'Your name', { value: c.value('owner.name') ?? (hub.cfg.ownerName === 'the user' ? '' : hub.cfg.ownerName), locked: lock('owner.name') })}
    ${field('owner.timezone', 'Time zone', { value: hub.cfg.timezone, locked: lock('owner.timezone'), help: 'IANA name, e.g. America/New_York.' })}
    <button class="btn">Save</button></form>

  <div class="section-head"><h2>Approvals</h2></div>
  <form method="post" action="/settings/approval" class="card stack">${hidden('back', back)}
    ${field('approval.handle', 'Approval texts go to', { value: hub.cfg.approval.imessageHandle ?? '', inputmode: 'tel', locked: lock('approval.handle'), help: 'Reply “Y CODE” to approve or “N CODE” to deny. Only replies sent from your own devices count.' })}
    <div class="row"><button class="btn">Save</button></div>
    <div data-widget="test-text" data-input="#f-approval-handle" class="stack"><div class="row"><button type="button" class="btn secondary">Send a test text</button></div><div data-status class="hide"></div></div>
  </form>

  <div class="section-head"><h2>AI model</h2></div>
  ${lock('router.key') ? `<div class="card muted">Set on the server (${h(lock('router.key')!)}).</div>` : `<form method="post" action="/settings/router" class="card stack">${hidden('back', back)}
    ${providerPicker(hub.cfg.router.provider)}
    ${field('router.key', 'API key (only for Anthropic or OpenAI)', { type: 'password', secretSaved: c.isSet('router.key') })}
    <div class="row"><button class="btn">Save</button></div>
    ${hub.llm ? `<div data-widget="test-router" class="stack"><div class="row"><button type="button" class="btn secondary">Test it</button></div><div data-status class="hide"></div></div>` : ''}</form>`}

  <div class="section-head"><h2>Email</h2></div><section class="card">${emailBlock(hub, back)}</section>

  <div class="section-head" id="mac"><h2>Your Mac</h2></div>
  <section class="card">${macBlock(hub, { installHere: Boolean(hub.macInstaller) })}
    ${c.hasPairedDaemon() && !hub.cfg.daemonToken ? `<form method="post" action="/settings/unpair" class="mt" data-confirm="Unpair your Mac? The helper stops syncing until you pair it again.">${hidden('back', back)}<button class="btn danger-ghost sm">Unpair this Mac</button></form>` : ''}</section>
  <section class="card"><h3>Keep awake</h3>${keepAwakeBlock()}</section>

  <div class="section-head"><h2>Password</h2></div>
  ${hub.cfg.ownerPassword ? '<div class="card muted">Your password is set on the server (HUB_OWNER_PASSWORD).</div>' : `<form method="post" action="/settings/password" class="card">${hidden('back', back)}
    ${field('current', 'Current password', { type: 'password', autocomplete: 'current-password' })}
    ${field('next', 'New password', { type: 'password', autocomplete: 'new-password', help: 'At least 10 characters. Changing it signs out every other device.' })}
    <button class="btn">Change password</button></form>`}

  <div class="section-head"><h2>Advanced</h2></div>
  <section class="card stack"><p>Prefer config files? Every setting can also come from environment variables (see <code>.env.example</code>). Anything set there wins over this page and shows as “Set in .env”.</p>
    ${fromEnv.length ? `<p class="muted small">From the environment right now: ${fromEnv.map(([, l]) => h(l)).join(', ')}.</p>` : '<p class="muted small">Nothing is coming from the environment right now.</p>'}
    <form method="post" action="/logout" class="inline"><button class="btn secondary">Sign out</button></form></section>`;
}

/** Free local model first: it needs no key and costs nothing. */
export function providerPicker(current: string): string {
  const pick = current === 'anthropic' || current === 'openai' ? current : 'ollama';
  const opt = (v: string, name: string, note: string) =>
    `<label><input type="radio" name="router.provider" value="${v}"${pick === v ? ' checked' : ''}> <b>${name}</b><span class="muted">${note}</span></label>`;
  return `<div class="seg" style="grid-template-columns:1fr 1fr 1fr">
    ${opt('ollama', 'Free (Ollama)', 'Runs on your Mac. No key, no cost.')}
    ${opt('anthropic', 'Anthropic', 'Claude. Key from console.anthropic.com')}
    ${opt('openai', 'OpenAI', 'Key from platform.openai.com')}</div>
  <p class="muted small">Free setup, once: <code>brew install ollama && brew services start ollama && ollama pull llama3.2</code>, then restart the hub.</p>`;
}
