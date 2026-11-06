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
<meta name="color-scheme" content="light"><meta name="theme-color" content="#f4efe7">
<title>${h(title)} · Agent Hub</title>
<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${CSS}</style></head><body class="${opts.bare ? 'is-bare' : ''}">
${header}<main id="main">${flash}${body}</main>
<script>${CLIENT_JS}</script></body></html>`;
}

function logo(): string {
  return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5c7.9 0 10.5 2.6 10.5 10.5S19.9 22.5 12 22.5 1.5 19.9 1.5 12 4.1 1.5 12 1.5Z" fill="currentColor"/><circle cx="12" cy="12" r="3.2" fill="var(--bg)"/></svg>`;
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
:root{--bg:#f4efe7;--surface:#fbf8f3;--surface-2:#ebe4d9;--text:#1d1a16;--muted:#7a7165;--line:rgba(29,26,22,.07);--border:rgba(29,26,22,.09);--accent:#1d1a16;--on-accent:#fbf8f3;--accent-2:#e7dfd2;--accent-text:#1d1a16;
--ok:#55704f;--ok-bg:#e5e9dc;--warn:#8d6d2e;--warn-bg:#f0e6d0;--err:#9c4a3c;--err-bg:#f2e0d9;--shadow:0 4px 30px rgba(29,26,22,.04);--radius:36px;--t-xl:clamp(44px,6.4vw,84px);--t-md:16px;--t-sm:13px;--tab-h:68px}
:root[data-theme=dark]{--bg:#100f0d;--surface:#1a1815;--surface-2:#24211d;--text:#f1ebe1;--muted:#9d9488;--line:rgba(241,235,225,.08);--border:rgba(241,235,225,.11);--accent:#f1ebe1;--on-accent:#100f0d;--accent-2:#2c2823;--accent-text:#f1ebe1;
--ok:#a9bd9f;--ok-bg:#20261c;--warn:#d6b777;--warn-bg:#2a2415;--err:#dc9e8f;--err-bg:#2f1f1a;--shadow:0 4px 30px rgba(0,0,0,.25)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:400 var(--t-md)/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue",ui-sans-serif,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-underline-offset:3px;text-decoration-thickness:1px}
h1{font-size:var(--t-xl);font-weight:700;line-height:.98;letter-spacing:-.04em;margin:0 0 20px;text-wrap:balance}
h2{font-size:var(--t-sm);font-weight:500;line-height:1.4;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:0 0 24px}
h3{font-size:var(--t-md);font-weight:600;margin:0 0 8px}
b,strong{font-weight:600}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:40px;padding:24px clamp(24px,5vw,64px);background:color-mix(in srgb,var(--bg) 84%,transparent);backdrop-filter:saturate(1.4) blur(20px);-webkit-backdrop-filter:saturate(1.4) blur(20px)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;color:var(--text);text-decoration:none;letter-spacing:-.01em}
.tabs{display:flex;gap:32px;margin-left:auto}.tabs a{display:flex;align-items:center;color:var(--muted);text-decoration:none;transition:color .2s}.tabs a svg{display:none}
.tabs a:hover,.tabs a.on{color:var(--text)}
.icon-btn{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:var(--muted);cursor:pointer;transition:color .2s}.icon-btn:hover{color:var(--text)}.top.bare .icon-btn{margin-left:auto}
.theme .moon{display:none}:root[data-theme=dark] .theme .sun{display:none}:root[data-theme=dark] .theme .moon{display:block}
main{max-width:1240px;margin:0 auto;padding:clamp(40px,7vw,96px) clamp(24px,5vw,64px) 160px}
.is-bare main{max-width:760px}
.card{background:var(--surface);border:0;border-radius:var(--radius);padding:clamp(28px,4vw,48px);box-shadow:var(--shadow);margin-bottom:24px}
@supports (corner-shape:squircle){.card,.banner,.choice,.seg label,input:not([type=checkbox]):not([type=radio]),select,textarea,pre,.art svg{corner-shape:squircle}.card{--radius:64px}}
.card.flat{box-shadow:none;background:transparent;padding:0;border-radius:0;margin-bottom:72px}.card.tight{padding:32px}.card .card.flat{margin-bottom:40px}
section{margin-bottom:96px}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:24px;margin:96px 0 28px}.section-head h2{margin:0}section>.section-head:first-child,.two>div>.section-head:first-child{margin-top:0}
.grid{display:grid;gap:24px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}.grid .card{margin:0}
.row{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.between{display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap}
.stack>*+*{margin-top:24px}.muted{color:var(--muted)}.small,.small *{font-size:var(--t-sm)}.mono,code,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:12px 28px;border-radius:999px;border:0;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:500;cursor:pointer;text-decoration:none;white-space:nowrap;transition:opacity .2s,transform .2s}
.btn:hover{opacity:.82}.btn:active{transform:scale(.98)}.btn[disabled]{opacity:.35;cursor:not-allowed}
.btn.secondary,.btn.ghost,.btn.danger-ghost{background:transparent;color:var(--text);padding:12px 0;min-height:0;border-radius:0}
.btn.secondary::after,.btn.danger-ghost::after{content:"→";transition:transform .2s}.btn.secondary:hover::after,.btn.danger-ghost:hover::after{transform:translateX(3px)}
.btn.ghost{color:var(--muted)}.btn.ghost:hover{color:var(--text);opacity:1}
.btn.danger{background:var(--err);color:var(--on-accent)}.btn.danger-ghost{color:var(--err)}
.btn.ok{background:var(--accent);color:var(--on-accent)}.btn.big{min-height:56px;padding:14px 36px}.btn.sm{min-height:0;padding:8px 18px;font-size:var(--t-sm)}.btn.secondary.sm,.btn.ghost.sm{padding:4px 0}
.btn.block{width:100%}form.inline{display:inline}
.field{margin:0 0 32px}.field label,.copy label,.label{display:block;font-weight:600;margin-bottom:12px}
input:not([type=checkbox]):not([type=radio]),select,textarea{width:100%;font:inherit;padding:16px 20px;border-radius:20px;border:0;background:var(--surface-2);color:var(--text);outline:none;transition:box-shadow .2s;-webkit-appearance:none;appearance:none}
.card input:not([type=checkbox]):not([type=radio]),.card select,.card textarea{background:var(--bg)}
input::placeholder,textarea::placeholder{color:var(--muted)}
input:focus,select:focus,textarea:focus{box-shadow:0 0 0 2px var(--text)}:focus-visible{outline:2px solid var(--text);outline-offset:3px}input:focus-visible,select:focus-visible,textarea:focus-visible{outline:0}
input[disabled]{color:var(--muted)}textarea{resize:vertical}
.help{margin:12px 0 0;color:var(--muted);font-size:var(--t-sm)}
.copy{margin:0 0 32px}.copy-row{display:flex;gap:24px;align-items:flex-start}
.pill{display:inline-flex;align-items:center;gap:8px;font-size:var(--t-sm);font-weight:500;color:var(--muted);white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.pill.sm::before{display:none}
.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}.pill.err{color:var(--err)}.pill.accent{color:var(--text)}
.avatar{display:inline-grid;place-items:center;flex:none;border-radius:32%;background:var(--c);color:#fbf8f3;font-weight:600}
.agent-card{display:flex;flex-direction:column;gap:24px;text-decoration:none;color:inherit;transition:transform .3s cubic-bezier(.2,.8,.2,1);min-height:220px;justify-content:space-between}
.agent-card:hover{transform:translateY(-3px)}
.agent-card .head{display:flex;gap:16px;align-items:center}.agent-card .meta{font-size:var(--t-sm);color:var(--muted)}
.agent-card.add{align-items:flex-start;justify-content:flex-end;color:var(--muted);box-shadow:none;background:transparent;padding-left:0}
.flash{padding:0;margin:0 0 40px;font-weight:500}.flash.ok{color:var(--ok)}.flash.err{color:var(--err)}
.banner{display:flex;gap:24px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:28px 36px;border-radius:32px;background:var(--surface-2);margin-bottom:64px}
.banner.warn{background:var(--warn-bg);color:var(--warn)}.banner.err{background:var(--err-bg);color:var(--err)}.banner b{color:inherit}
.steps{list-style:none;padding:0;margin:0}.steps li{display:flex;gap:24px;padding:0 0 40px}.steps li:last-child{padding-bottom:0}
.num{flex:none;width:24px;font-size:var(--t-sm);font-weight:500;color:var(--muted);padding-top:3px;font-variant-numeric:tabular-nums}
.art{margin:24px 0 0;max-width:520px}.art svg{width:100%;height:auto;display:block;border-radius:24px}
.art figcaption{font-size:var(--t-sm);color:var(--muted);margin-top:12px}
.list{list-style:none;margin:0;padding:0}.list>li{display:flex;gap:20px;align-items:flex-start;padding:0 0 28px}.list>li:last-child{padding-bottom:0}
.list .grow{flex:1;min-width:0}.time{color:var(--muted);font-size:var(--t-sm);white-space:nowrap}
.approval .actions{display:flex;gap:32px;margin-top:32px;align-items:center}
.choice{display:flex;gap:18px;align-items:center;padding:22px 28px;border:0;border-radius:28px;cursor:pointer;background:var(--surface);margin-bottom:12px;transition:background .2s}
.choice:hover{background:var(--accent-2)}.choice input{width:20px;height:20px;accent-color:var(--text);flex:none;margin:0}
.choice:has(input:checked){background:var(--accent-2)}.choice .grow{flex:1;min-width:0}.card .choice{background:var(--bg)}
.chips{display:flex;flex-wrap:wrap;gap:10px}.chip{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border:0;border-radius:999px;cursor:pointer;background:var(--surface-2);user-select:none}
.chip input{accent-color:var(--text);margin:0}.chip:has(input:checked){background:var(--accent);color:var(--on-accent)}.chip.locked{opacity:.5;cursor:not-allowed}
.seg{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.seg label{border:0;border-radius:24px;padding:20px;cursor:pointer;background:var(--surface-2)}
.seg label:has(input:checked){background:var(--accent-2)}.seg input{accent-color:var(--text)}.seg b{display:block}.seg .muted{font-size:var(--t-sm)}
.switch{position:relative;display:inline-flex;align-items:center;gap:14px;cursor:pointer;font-weight:500}
.switch input{appearance:none;-webkit-appearance:none;width:48px;height:30px;border-radius:999px;background:var(--surface-2);position:relative;cursor:pointer;transition:background .2s;margin:0;flex:none}
.switch input::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:var(--surface);box-shadow:0 1px 4px rgba(0,0,0,.18);transition:transform .25s cubic-bezier(.2,.8,.2,1)}
.switch input:checked{background:var(--accent)}.switch input:checked::after{transform:translateX(18px)}.switch input:disabled{opacity:.5}
.wizard{max-width:760px}.progress{height:2px;background:var(--surface-2);overflow:hidden;margin:20px 0 72px}.progress>i{display:block;height:100%;background:var(--text);transition:width .5s cubic-bezier(.2,.8,.2,1)}
.wizard .kicker{font-size:var(--t-sm);font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.wizard>h1+p,.wizard>.muted{color:var(--muted);max-width:56ch;margin-bottom:56px}
.wizard-foot{display:flex;justify-content:space-between;align-items:center;gap:32px;margin-top:64px}.wizard-foot .right{display:flex;gap:32px;align-items:center;margin-left:auto}
.feature{display:flex;gap:20px;align-items:flex-start}.feature .dot{flex:none;width:24px;color:var(--muted)}
.status-line{display:flex;align-items:center;gap:12px;font-weight:500}.status-line.ok{color:var(--ok)}.status-line.err{color:var(--err)}.status-line.warn{color:var(--warn)}
.spinner{width:14px;height:14px;border-radius:50%;border:1.5px solid currentColor;border-right-color:transparent;animation:spin .8s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
.arrive{animation:arrive .5s ease-out}@keyframes arrive{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
details.more>summary{cursor:pointer;color:var(--muted);list-style:none;padding:8px 0}details.more>summary::after{content:" →"}details.more[open]>summary::after{content:" ↓"}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:14px 24px 14px 0;vertical-align:top}th{font-size:var(--t-sm);letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:500}
pre{white-space:pre-wrap;word-break:break-word;background:var(--surface-2);padding:24px;border-radius:24px;font-size:var(--t-sm);margin:0}
code{font-size:var(--t-sm);background:var(--surface-2);padding:2px 8px;border-radius:8px}
.two{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:clamp(40px,7vw,104px);align-items:start}
.hero{max-width:980px;margin-bottom:64px}.hero .date{font-size:var(--t-sm);letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:24px}
.tell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;margin-bottom:112px;padding:12px;border-radius:999px;background:var(--surface);box-shadow:var(--shadow)}
.tell select{width:auto;background:transparent!important;border-radius:999px;padding:14px 22px!important;font-weight:500;cursor:pointer}.tell input{background:transparent!important;padding:14px 8px!important}.tell input:focus,.tell select:focus{box-shadow:none}
.quiet{margin-top:96px}
.hide{display:none!important}.center{text-align:center}.card.flat.center{text-align:left;margin-bottom:0}.detail-head{display:flex;flex-direction:column;align-items:flex-start;gap:24px;margin-bottom:64px}.detail-head h1{margin:0 0 12px}.mt{margin-top:32px}.mb0{margin-bottom:0}
.kbd{font-family:ui-monospace,monospace;font-size:var(--t-sm);background:var(--surface-2);border-radius:6px;padding:1px 6px}
@media (max-width:860px){.two{grid-template-columns:1fr;gap:72px}}
@media (max-width:720px){:root{--t-xl:clamp(40px,12vw,56px)}.top{padding:18px 24px;backdrop-filter:none;-webkit-backdrop-filter:none;background:var(--bg);position:static}
.tabs{position:fixed;bottom:0;left:0;right:0;margin:0;height:calc(var(--tab-h) + env(safe-area-inset-bottom));padding:8px 8px env(safe-area-inset-bottom);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);gap:0;justify-content:space-around;z-index:30}
.tabs a{flex-direction:column;gap:4px;font-size:var(--t-sm);flex:1}.tabs a svg{display:block}.top:not(.bare) .icon-btn{margin-left:auto}
body:not(.is-bare) main{padding-bottom:calc(var(--tab-h) + 72px + env(safe-area-inset-bottom))}main{padding-top:32px}
.tell{grid-template-columns:1fr;border-radius:32px;padding:20px;margin-bottom:72px}.tell .btn{width:100%}.tell select{padding:8px 0!important}.tell input{padding:8px 0!important}
.seg{grid-template-columns:1fr}.copy-row{flex-direction:column;gap:8px}section{margin-bottom:72px}.section-head{margin-top:72px}.approval .actions{flex-wrap:wrap}.banner{padding:24px}}
`;
