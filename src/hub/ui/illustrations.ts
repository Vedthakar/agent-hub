import { escapeHtml as h } from '../html.js';

/**
 * Theme-aware SVG mock-ups of each app's settings screens for the step-by-step guides. They're
 * simplified drawings (labelled as such), so they stay accurate enough when the real UI shifts a little.
 */

type Body =
  | { kind: 'menu'; items: string[]; target: number }
  | { kind: 'button'; text: string; label: string }
  | { kind: 'form'; fields: { label: string; value: string }[]; target: number; button: string }
  | { kind: 'consent'; agent: string }
  | { kind: 'text'; label: string; lines: number; button?: string }
  | { kind: 'toggle'; label: string; note: string };

export interface Mock {
  app: string;
  color: string;
  nav: string[];
  activeNav: number;
  title: string;
  body: Body;
}

const W = 460;
const HGT = 250;

function txt(x: number, y: number, s: string, opts: { size?: number; weight?: number; fill?: string; anchor?: string } = {}) {
  return `<text x="${x}" y="${y}" font-size="${opts.size ?? 11}" font-weight="${opts.weight ?? 500}" fill="${opts.fill ?? 'var(--text)'}" text-anchor="${opts.anchor ?? 'start'}" font-family="ui-sans-serif,-apple-system,sans-serif">${h(s)}</text>`;
}

function ring(x: number, y: number, w: number, hh: number) {
  return `<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${hh + 8}" rx="9" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-dasharray="5 3"/>
<circle cx="${x + w + 6}" cy="${y - 4}" r="9" fill="var(--accent)"/><path d="M${x + w + 2} ${y - 4}l3 3 5-6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>`;
}

export function mockScreen(m: Mock): string {
  const parts: string[] = [];
  parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${HGT - 1}" rx="12" fill="var(--surface)" stroke="var(--border)"/>`);
  parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="28" rx="12" fill="var(--surface-2)"/><rect x="0.5" y="16" width="${W - 1}" height="13" fill="var(--surface-2)"/>`);
  parts.push(['#c9beae', '#c9beae', '#c9beae'].map((c, i) => `<circle cx="${16 + i * 15}" cy="14.5" r="4.5" fill="${c}"/>`).join(''));
  parts.push(`<rect x="${W / 2 - 52}" y="7" width="104" height="15" rx="7" fill="var(--surface)"/>`, txt(W / 2, 18, m.app, { size: 10, anchor: 'middle', fill: 'var(--muted)' }));
  // sidebar
  parts.push(`<rect x="0.5" y="29" width="118" height="${HGT - 30}" fill="var(--surface-2)" opacity=".55"/>`);
  parts.push(`<rect x="12" y="40" width="22" height="22" rx="6" fill="${h(m.color)}"/>`, txt(42, 55, m.app, { weight: 700 }));
  m.nav.forEach((n, i) => {
    const y = 78 + i * 24;
    if (i === m.activeNav) parts.push(`<rect x="8" y="${y - 14}" width="102" height="20" rx="6" fill="var(--accent-2)"/>`);
    parts.push(txt(16, y, n, { fill: i === m.activeNav ? 'var(--accent-text)' : 'var(--muted)', weight: i === m.activeNav ? 650 : 500 }));
  });
  // main
  const x0 = 136;
  parts.push(txt(x0, 56, m.title, { size: 14, weight: 700 }));
  const b = m.body;
  if (b.kind === 'menu') {
    b.items.forEach((it, i) => {
      const y = 72 + i * 30;
      parts.push(`<rect x="${x0}" y="${y}" width="${W - x0 - 20}" height="24" rx="7" fill="var(--surface-2)"/>`, txt(x0 + 10, y + 16, it));
      parts.push(`<path d="M${W - 34} ${y + 8}l4 4-4 4" stroke="var(--muted)" fill="none" stroke-width="1.5"/>`);
      if (i === b.target) parts.push(ring(x0, y, W - x0 - 20, 24));
    });
  } else if (b.kind === 'button') {
    parts.push(txt(x0, 80, b.label, { fill: 'var(--muted)' }));
    parts.push(`<rect x="${x0}" y="94" width="150" height="28" rx="8" fill="var(--accent)"/>`, txt(x0 + 75, 112, b.text, { fill: '#fff', anchor: 'middle', weight: 650 }), ring(x0, 94, 150, 28));
    [0, 1, 2].forEach((i) => parts.push(`<rect x="${x0}" y="${140 + i * 22}" width="${W - x0 - 40 - i * 40}" height="10" rx="5" fill="var(--surface-2)"/>`));
  } else if (b.kind === 'form') {
    b.fields.forEach((f, i) => {
      const y = 70 + i * 44;
      parts.push(txt(x0, y + 10, f.label, { size: 10, fill: 'var(--muted)', weight: 600 }));
      parts.push(`<rect x="${x0}" y="${y + 15}" width="${W - x0 - 20}" height="22" rx="6" fill="var(--surface)" stroke="var(--border)"/>`, txt(x0 + 8, y + 30, f.value, { size: 10 }));
      if (i === b.target) parts.push(ring(x0, y + 15, W - x0 - 20, 22));
    });
    const y = 70 + b.fields.length * 44 + 4;
    parts.push(`<rect x="${W - 110}" y="${y}" width="90" height="26" rx="8" fill="var(--accent)"/>`, txt(W - 65, y + 17, b.button, { fill: '#fff', anchor: 'middle', weight: 650 }));
  } else if (b.kind === 'consent') {
    parts.push(`<rect x="${x0}" y="68" width="${W - x0 - 20}" height="166" rx="10" fill="var(--surface-2)"/>`);
    parts.push(txt(x0 + 14, 92, 'Connect to Agent Hub', { size: 12, weight: 700 }));
    parts.push(txt(x0 + 14, 116, 'This connection is', { size: 10, fill: 'var(--muted)' }));
    parts.push(`<rect x="${x0 + 14}" y="121" width="180" height="22" rx="6" fill="var(--surface)" stroke="var(--border)"/>`, txt(x0 + 22, 136, b.agent, { size: 10, weight: 650 }), ring(x0 + 14, 121, 180, 22));
    parts.push(txt(x0 + 14, 162, 'Hub owner password', { size: 10, fill: 'var(--muted)' }));
    parts.push(`<rect x="${x0 + 14}" y="167" width="180" height="22" rx="6" fill="var(--surface)" stroke="var(--border)"/>`, txt(x0 + 22, 182, '••••••••••', { size: 10 }));
    parts.push(`<rect x="${W - 104}" y="200" width="70" height="24" rx="7" fill="var(--accent)"/>`, txt(W - 69, 216, 'Allow', { fill: '#fff', anchor: 'middle', weight: 650 }));
  } else if (b.kind === 'text') {
    parts.push(txt(x0, 80, b.label, { fill: 'var(--muted)', weight: 600, size: 10 }));
    parts.push(`<rect x="${x0}" y="88" width="${W - x0 - 20}" height="${b.lines * 16 + 14}" rx="7" fill="var(--surface)" stroke="var(--border)"/>`);
    for (let i = 0; i < b.lines; i++) parts.push(`<rect x="${x0 + 10}" y="${98 + i * 16}" width="${W - x0 - 50 - (i % 3) * 30}" height="7" rx="3.5" fill="var(--surface-2)"/>`);
    parts.push(ring(x0, 88, W - x0 - 20, b.lines * 16 + 14));
    if (b.button) {
      const y = 98 + b.lines * 16 + 14;
      parts.push(`<rect x="${W - 100}" y="${y}" width="80" height="24" rx="7" fill="var(--accent)"/>`, txt(W - 60, y + 16, b.button, { fill: '#fff', anchor: 'middle', weight: 650 }));
    }
  } else if (b.kind === 'toggle') {
    parts.push(`<rect x="${x0}" y="72" width="${W - x0 - 20}" height="44" rx="8" fill="var(--surface-2)"/>`, txt(x0 + 12, 92, b.label, { weight: 650 }), txt(x0 + 12, 107, b.note, { size: 9.5, fill: 'var(--muted)' }));
    parts.push(`<rect x="${W - 66}" y="83" width="34" height="20" rx="10" fill="var(--ok)"/><circle cx="${W - 42}" cy="93" r="8" fill="#fff"/>`, ring(W - 66, 83, 34, 20));
  }
  return `<svg viewBox="0 0 ${W} ${HGT}" role="img" aria-label="${h(`${m.app}: ${m.title}`)}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

export function figure(m: Mock): string {
  return `${mockScreen(m)}<figcaption>Illustration. ${h(m.app)}'s real screens may look a little different.</figcaption>`;
}
