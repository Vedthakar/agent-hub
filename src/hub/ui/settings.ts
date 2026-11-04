import type { Hub } from '../hub.js';
import { ADAPTERS } from '../adapters/index.js';
import { field, h, hidden, pill } from './layout.js';
import { emailBlock, keepAwakeBlock, macBlock } from './panels.js';

const ENV_KEYS: [string, string][] = [
  ['owner.name', 'Your name'],
  ['owner.timezone', 'Time zone'],
  ['approval.handle', 'Approval number'],
  ['worker.enabled', 'Background worker'],
  ['vault.path', 'Vault folder'],
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

export function settingsBody(hub: Hub, signedIn: Record<string, boolean | null> = {}): string {
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

  <div class="section-head" id="worker"><h2>Background worker</h2></div>
  ${workerBlock(hub, signedIn, back)}

  <div class="section-head" id="vault"><h2>Vault</h2></div>
  <form method="post" action="/settings/vault" class="card stack">${hidden('back', back)}
    ${field('vault.path', 'Vault folder', { value: hub.cfg.vaultPath, locked: lock('vault.path'), help: 'Open this folder as a vault in Obsidian. Your edits sync back. Tasks and approvals stay in the hub.' })}
    <div class="row"><button class="btn">Save</button></div></form>

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

const READABLE_AGENTS = ['instinct', 'stanley', 'boardy'] as const;

/** Worker settings: on/off, which conversations it may read, and which of your accounts runs it. */
export function workerBlock(hub: Hub, signedIn: Record<string, boolean | null>, back: string): string {
  const w = hub.cfg.worker;
  const status = (id: string) => (signedIn[id] === true ? pill('Signed in', 'ok') : signedIn[id] === false ? pill('Signed out', 'warn') : '');
  const login = (dir: string | null) => `${dir ? `CLAUDE_CONFIG_DIR=${JSON.stringify(dir)} ` : ''}claude auth login`;
  const problem = hub.workerProblem
    ? `<div class="banner err"><div><b>${hub.workerProblem === 'limit' ? 'This account hit a usage limit.' : hub.workerProblem === 'not_installed' ? 'Claude Code isn’t installed.' : 'This account is signed out.'}</b> Conversations are waiting. Switch accounts below, or the hub retries by itself.</div></div>`
    : '';
  return `${problem}<form method="post" action="/settings/worker" class="card stack">${hidden('back', back)}
    <p class="muted mb0">Reads conversations and sorts them into memory and tasks, using Claude Code on your Claude plan. No API key and no extra bill. It runs with every tool off, so it can only reply with text. It uses your plan’s limits, up to ${w.maxRunsPerDay} runs a day.</p>
    <label class="choice"><input type="checkbox" name="enabled" value="1"${w.enabled ? ' checked' : ''}><span class="grow"><b>Turn on the background worker</b></span></label>
    <div><b>Conversations it may read</b><div class="muted small">These go to Anthropic through your account. Leave one off and the hub only records that the chat happened.</div>
    ${READABLE_AGENTS.map((a) => `<label class="choice"><input type="checkbox" name="source" value="${a}"${w.sources.includes(a) ? ' checked' : ''}><span class="grow">${h(ADAPTERS[a].name)}</span></label>`).join('')}</div>
    <div><b>Account</b>${w.accounts.map((a) => `<label class="choice"><input type="radio" name="account" value="${h(a.id)}"${a.id === w.activeAccount ? ' checked' : ''}><span class="grow"><b>${h(a.label)}</b> ${status(a.id)}${signedIn[a.id] === true ? '' : `<div class="muted small">To sign in, run this in Terminal: <code>${h(login(a.configDir))}</code></div>`}</span>${a.configDir ? `<button class="btn ghost sm" formaction="/settings/worker/account/${h(a.id)}/remove" formnovalidate>Remove</button>` : ''}</label>`).join('')}</div>
    <div class="row"><button class="btn">Save</button></div>
    ${hub.worker ? '<div data-widget="test-router" class="stack"><div class="row"><button type="button" class="btn secondary">Test it</button></div><div data-status class="hide"></div></div>' : ''}</form>
  <form method="post" action="/settings/worker/account" class="card row">${hidden('back', back)}
    <div class="grow">${field('label', 'Add another Claude account (nickname)', { placeholder: 'Work account', help: 'Just a name for you to recognize it, not your email. You sign in with the Terminal command it gives you. Only needed if you have a second Claude account.' })}</div>
    <button class="btn secondary">Add</button></form>`;
}
