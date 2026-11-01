import { escapeHtml as h } from '../html.js';
import { CLIENT_JS } from './client.js';

export { h };

export type NavKey = 'today' | 'connections' | 'activity' | 'settings' | null;

const ICONS = {
  today: '<path d="M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  connections: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6h7M6 8.5v7M18 8.5v7M8.5 18h7"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
};

export function icon(name: keyof typeof ICONS, size = 20): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

const NAV: { key: Exclude<NavKey, null>; href: string; label: string }[] = [
  { key: 'today', href: '/', label: 'Today' },
  { key: 'connections', href: '/connections', label: 'Connections' },
  { key: 'activity', href: '/timeline', label: 'Activity' },
  { key: 'settings', href: '/settings', label: 'Settings' },
];

export function page(title: string, body: string, opts: { nav?: NavKey; bare?: boolean; flash?: string | null; flashKind?: 'ok' | 'err' } = {}): string {
  const nav = opts.nav ?? null;
  const links = NAV.map((n) => `<a href="${n.href}" class="${n.key === nav ? 'on' : ''}" ${n.key === nav ? 'aria-current="page"' : ''}>${icon(n.key)}<span>${n.label}</span></a>`).join('');
  const header = opts.bare
    ? `<header class="top bare"><a class="brand" href="/">${logo()}<span>Agent Hub</span></a>${themeButton()}</header>`
    : `<header class="top"><a class="brand" href="/">${logo()}<span>Agent Hub</span></a><nav class="tabs">${links}</nav>${themeButton()}</header>`;
  const flash = opts.flash ? `<div class="flash ${opts.flashKind ?? 'ok'}" role="status">${h(opts.flash)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f7f7f8" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0d0d10" media="(prefers-color-scheme: dark)">
<title>${h(title)} · Agent Hub</title>
<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${CSS}</style></head><body class="${opts.bare ? 'is-bare' : ''}">
${header}<main id="main">${flash}${body}</main>
<script>${CLIENT_JS}</script></body></html>`;
}

function logo(): string {
  return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6" fill="var(--accent)"/><circle cx="8.5" cy="12" r="2.2" fill="#fff"/><circle cx="15.5" cy="8.5" r="2.2" fill="#fff" opacity=".85"/><circle cx="15.5" cy="15.5" r="2.2" fill="#fff" opacity=".7"/><path d="M10.5 11l3-1.6M10.5 13l3 1.6" stroke="#fff" stroke-width="1.4"/></svg>`;
}

function themeButton(): string {
  return `<button class="icon-btn theme" type="button" data-theme-toggle aria-label="Switch light or dark mode" title="Light / dark">
<svg class="sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
<svg class="moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg></button>`;
}

// ---------- small components ----------

export type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'accent';

export function pill(text: string, tone: Tone = 'muted'): string {
  return `<span class="pill ${tone}">${h(text)}</span>`;
}

export function copyField(value: string, opts: { label?: string; multiline?: boolean; id?: string; secret?: boolean } = {}): string {
  const id = opts.id ?? `c${Math.random().toString(36).slice(2, 9)}`;
  const field = opts.multiline
    ? `<textarea id="${id}" readonly rows="${Math.min(10, value.split('\n').length + 1)}">${h(value)}</textarea>`
    : `<input id="${id}" readonly value="${h(value)}" spellcheck="false" ${opts.secret ? 'class="mono secret"' : 'class="mono"'}>`;
  return `<div class="copy">${opts.label ? `<label for="${id}">${h(opts.label)}</label>` : ''}<div class="copy-row">${field}<button type="button" class="btn secondary" data-copy="#${id}">Copy</button></div></div>`;
}

export function field(name: string, label: string, opts: { value?: string | null; type?: string; placeholder?: string; help?: string; locked?: string | null; required?: boolean; autocomplete?: string; inputmode?: string; secretSaved?: boolean } = {}): string {
  const id = `f-${name.replace(/[^a-z0-9]/gi, '-')}`;
  if (opts.locked) {
    return `<div class="field"><label for="${id}">${h(label)}</label><input id="${id}" disabled value="Set in .env (${h(opts.locked)})"><p class="help">Managed on the server. Remove ${h(opts.locked)} from the environment to edit it here.</p></div>`;
  }
  const isSecret = opts.type === 'password';
  const placeholder = isSecret && opts.secretSaved ? 'Saved. Leave blank to keep it.' : (opts.placeholder ?? '');
  return `<div class="field"><label for="${id}">${h(label)}${isSecret && opts.secretSaved ? ' <span class="pill ok sm">saved</span>' : ''}</label>
<input id="${id}" name="${h(name)}" type="${opts.type ?? 'text'}" value="${isSecret ? '' : h(opts.value ?? '')}" placeholder="${h(placeholder)}"${opts.required ? ' required' : ''}${opts.autocomplete ? ` autocomplete="${opts.autocomplete}"` : isSecret ? ' autocomplete="off"' : ''}${opts.inputmode ? ` inputmode="${opts.inputmode}"` : ''} spellcheck="false">
${opts.help ? `<p class="help">${opts.help}</p>` : ''}</div>`;
}

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${h(name)}" value="${h(value)}">`;
}

/** Numbered how-to steps, each with optional illustration. */
export function steps(items: { title: string; body?: string; art?: string }[]): string {
  return `<ol class="steps">${items.map((s, i) => `<li><span class="num">${i + 1}</span><div><b>${s.title}</b>${s.body ? `<div class="muted">${s.body}</div>` : ''}${s.art ? `<figure class="art">${s.art}</figure>` : ''}</div></li>`).join('')}</ol>`;
}

export function avatar(name: string, color: string, size = 40): string {
  const initials = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  return `<span class="avatar" style="--c:${h(color)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px">${h(initials)}</span>`;
}

export function relTime(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return 'never';
  const ms = now - new Date(d).getTime();
  const abs = Math.abs(ms);
  const fmt = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`;
  const s = abs < 60_000 ? 'just now' : abs < 3600_000 ? fmt(Math.round(abs / 60_000), 'min') : abs < 86_400_000 ? fmt(Math.round(abs / 3600_000), 'hour') : fmt(Math.round(abs / 86_400_000), 'day');
  if (s === 'just now') return s;
  return ms >= 0 ? `${s} ago` : `in ${s}`;
}

const CSS = `
:root{--bg:#f7f7f8;--surface:#fff;--surface-2:#f2f2f4;--text:#16161a;--muted:#6b6b76;--border:#e4e4e9;--accent:#5b5bd6;--accent-2:#ececfd;--accent-text:#4646b8;
--ok:#15803d;--ok-bg:#e8f7ee;--warn:#b45309;--warn-bg:#fdf3e3;--err:#c0262d;--err-bg:#fdecec;--shadow:0 1px 2px rgba(16,16,24,.05),0 4px 16px rgba(16,16,24,.05);--radius:16px;--tab-h:64px}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d0d10;--surface:#16161b;--surface-2:#1e1e25;--text:#ececf1;--muted:#9a9aa8;--border:#2a2a33;--accent:#7c7cf0;--accent-2:#24244a;--accent-text:#a9a9ff;
--ok:#4ade80;--ok-bg:#12291b;--warn:#fbbf24;--warn-bg:#2d2410;--err:#f87171;--err-bg:#2f1517;--shadow:0 1px 2px rgba(0,0,0,.4)}}
:root[data-theme=dark]{--bg:#0d0d10;--surface:#16161b;--surface-2:#1e1e25;--text:#ececf1;--muted:#9a9aa8;--border:#2a2a33;--accent:#7c7cf0;--accent-2:#24244a;--accent-text:#a9a9ff;
--ok:#4ade80;--ok-bg:#12291b;--warn:#fbbf24;--warn-bg:#2d2410;--err:#f87171;--err-bg:#2f1517;--shadow:0 1px 2px rgba(0,0,0,.4)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent-text)}h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px;letter-spacing:-.01em}h3{font-size:15px;margin:0}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:10px 20px;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(1.6) blur(14px);-webkit-backdrop-filter:saturate(1.6) blur(14px);border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;color:var(--text);text-decoration:none;letter-spacing:-.01em}
.tabs{display:flex;gap:4px;margin-left:12px}.tabs a{display:flex;align-items:center;gap:7px;padding:7px 12px;border-radius:10px;color:var(--muted);text-decoration:none;font-weight:550}
.tabs a:hover{background:var(--surface-2);color:var(--text)}.tabs a.on{background:var(--accent-2);color:var(--accent-text)}
.icon-btn{margin-left:auto;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer}
.theme .moon{display:none}:root[data-theme=dark] .theme .sun{display:none}:root[data-theme=dark] .theme .moon{display:block}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .theme .sun{display:none}:root:not([data-theme=light]) .theme .moon{display:block}}
main{max-width:1080px;margin:0 auto;padding:24px 20px 48px}
.is-bare main{max-width:640px}
@media (max-width:720px){.tabs{position:fixed;bottom:0;left:0;right:0;margin:0;height:calc(var(--tab-h) + env(safe-area-inset-bottom));padding:6px 8px env(safe-area-inset-bottom);background:var(--surface);border-top:1px solid var(--border);justify-content:space-around;z-index:30}
.tabs a{flex-direction:column;gap:2px;font-size:11px;padding:6px 10px;flex:1;align-items:center}.tabs a.on{background:none}
body:not(.is-bare) main{padding-bottom:calc(var(--tab-h) + 32px + env(safe-area-inset-bottom))}main{padding:18px 14px}h1{font-size:22px}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow);margin-bottom:16px}
.card.flat{box-shadow:none}.card.tight{padding:14px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:28px 0 12px}.section-head h2{margin:0}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.between{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.stack>*+*{margin-top:12px}.muted{color:var(--muted)}.small{font-size:13px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:8px 16px;border-radius:11px;border:1px solid transparent;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap;transition:transform .05s,filter .15s}
.btn:hover{filter:brightness(1.07)}.btn:active{transform:scale(.98)}.btn[disabled]{opacity:.5;cursor:not-allowed;filter:none}
.btn.secondary{background:var(--surface);color:var(--text);border-color:var(--border)}.btn.secondary:hover{background:var(--surface-2)}
.btn.ghost{background:transparent;color:var(--muted)}.btn.ghost:hover{color:var(--text);background:var(--surface-2)}
.btn.danger{background:var(--err)}.btn.danger-ghost{background:transparent;color:var(--err);border-color:color-mix(in srgb,var(--err) 35%,transparent)}
.btn.ok{background:var(--ok);color:#fff}.btn.big{min-height:48px;font-size:16px;padding:10px 22px;border-radius:13px}.btn.sm{min-height:32px;padding:4px 11px;font-size:13px;border-radius:9px}
.btn.block{width:100%}
form.inline{display:inline}
.field{margin:0 0 14px}.field label,.copy label,.label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
input:not([type=checkbox]):not([type=radio]),select,textarea{width:100%;font:inherit;font-size:16px;padding:10px 12px;border-radius:11px;border:1px solid var(--border);background:var(--surface);color:var(--text);outline:none;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
input[disabled]{background:var(--surface-2);color:var(--muted)}textarea{resize:vertical;font-size:14px}
.help{margin:6px 0 0;color:var(--muted);font-size:13px}
.copy{margin:0 0 14px}.copy-row{display:flex;gap:8px}.copy-row input,.copy-row textarea{background:var(--surface-2)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12.5px;font-weight:600;background:var(--surface-2);color:var(--muted);white-space:nowrap}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.9}.pill.sm{padding:0 8px;font-size:11.5px}.pill.sm::before{display:none}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.err{background:var(--err-bg);color:var(--err)}.pill.accent{background:var(--accent-2);color:var(--accent-text)}
.avatar{display:inline-grid;place-items:center;flex:none;border-radius:30%;background:var(--c);color:#fff;font-weight:700;letter-spacing:.02em}
.agent-card{display:flex;flex-direction:column;gap:12px;text-decoration:none;color:inherit;transition:border-color .15s,transform .1s}
.agent-card:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
.agent-card .head{display:flex;gap:12px;align-items:center}.agent-card .meta{font-size:13px;color:var(--muted)}
.agent-card.add{border-style:dashed;align-items:center;justify-content:center;min-height:150px;color:var(--muted);box-shadow:none;background:transparent}
.flash{padding:12px 16px;border-radius:12px;margin-bottom:16px;font-weight:550}.flash.ok{background:var(--ok-bg);color:var(--ok)}.flash.err{background:var(--err-bg);color:var(--err)}
.banner{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:14px 16px;border-radius:14px;background:var(--accent-2);color:var(--accent-text);margin-bottom:16px}
.banner.warn{background:var(--warn-bg);color:var(--warn)}.banner.err{background:var(--err-bg);color:var(--err)}.banner b{color:inherit}
.steps{list-style:none;padding:0;margin:0}.steps li{display:flex;gap:14px;padding:12px 0;border-top:1px solid var(--border)}.steps li:first-child{border-top:0}
.num{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--accent-2);color:var(--accent-text);font-weight:700;font-size:13px}
.art{margin:10px 0 0;max-width:460px}.art svg{width:100%;height:auto;display:block;border-radius:12px;border:1px solid var(--border)}
.art figcaption{font-size:12px;color:var(--muted);margin-top:4px}
.list{list-style:none;margin:0;padding:0}.list>li{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--border)}.list>li:first-child{border-top:0}
.list .grow{flex:1;min-width:0}.time{color:var(--muted);font-size:13px;white-space:nowrap}
.approval{border-left:4px solid var(--warn)}.approval .actions{display:flex;gap:10px;margin-top:12px}.approval .actions .btn{flex:1}
@media (min-width:721px){.approval .actions .btn{flex:none;min-width:130px}}
.choice{display:flex;gap:12px;align-items:center;padding:12px 14px;border:1px solid var(--border);border-radius:13px;cursor:pointer;background:var(--surface);margin-bottom:8px}
.choice:hover{border-color:color-mix(in srgb,var(--accent) 40%,var(--border))}.choice input{width:18px;height:18px;accent-color:var(--accent);flex:none}
.choice:has(input:checked){border-color:var(--accent);background:var(--accent-2)}.choice .grow{flex:1;min-width:0}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border:1px solid var(--border);border-radius:999px;cursor:pointer;background:var(--surface);font-size:14px;user-select:none}
.chip input{accent-color:var(--accent);margin:0}.chip:has(input:checked){border-color:var(--accent);background:var(--accent-2);color:var(--accent-text)}.chip.locked{opacity:.6;cursor:not-allowed}
.seg{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.seg label{border:1px solid var(--border);border-radius:12px;padding:10px 12px;cursor:pointer;background:var(--surface)}
.seg label:has(input:checked){border-color:var(--accent);background:var(--accent-2)}.seg input{accent-color:var(--accent)}.seg b{display:block}.seg .muted{font-size:12.5px}
@media (max-width:560px){.seg{grid-template-columns:1fr}}
.switch{position:relative;display:inline-flex;align-items:center;gap:10px;cursor:pointer;font-weight:600}
.switch input{appearance:none;-webkit-appearance:none;width:46px;height:28px;border-radius:999px;background:var(--border);position:relative;cursor:pointer;transition:background .2s;margin:0;flex:none}
.switch input::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s}
.switch input:checked{background:var(--ok)}.switch input:checked::after{transform:translateX(18px)}.switch input:disabled{opacity:.5}
.wizard{max-width:640px;margin:0 auto}.progress{height:6px;border-radius:999px;background:var(--surface-2);overflow:hidden;margin:4px 0 22px}.progress>i{display:block;height:100%;background:var(--accent);border-radius:999px;transition:width .3s}
.wizard .kicker{font-size:13px;font-weight:650;color:var(--accent-text);text-transform:uppercase;letter-spacing:.06em}
.wizard-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:22px}.wizard-foot .right{display:flex;gap:10px;align-items:center;margin-left:auto}
.feature{display:flex;gap:14px;align-items:flex-start}.feature .dot{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:var(--accent-2);color:var(--accent-text);font-size:18px}
.status-line{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--surface-2);font-weight:550}
.status-line.ok{background:var(--ok-bg);color:var(--ok)}.status-line.err{background:var(--err-bg);color:var(--err)}.status-line.warn{background:var(--warn-bg);color:var(--warn)}
.spinner{width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .8s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
.arrive{animation:arrive .5s ease-out}@keyframes arrive{from{opacity:0;transform:translateY(-8px);background:var(--accent-2)}to{opacity:1;transform:none}}
details.more>summary{cursor:pointer;color:var(--muted);font-weight:600;list-style:none;padding:6px 0}details.more>summary::before{content:"▸ ";}details.more[open]>summary::before{content:"▾ "}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px 8px;border-top:1px solid var(--border);vertical-align:top;font-size:14px}th{color:var(--muted);font-weight:600;border-top:0}
pre{white-space:pre-wrap;word-break:break-word;background:var(--surface-2);padding:12px;border-radius:10px;font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:var(--surface-2);padding:1px 6px;border-radius:6px}
.two{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}@media (max-width:860px){.two{grid-template-columns:1fr}}
.hide{display:none!important}.center{text-align:center}.mt{margin-top:16px}.mb0{margin-bottom:0}
.kbd{font-family:ui-monospace,monospace;font-size:12px;border:1px solid var(--border);border-bottom-width:2px;border-radius:6px;padding:0 5px;background:var(--surface)}
`;
