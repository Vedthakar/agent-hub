/**
 * Runs the security suite and prints the pass/fail table, one row per test, grouped by the step-4
 * requirement it covers. `--write` also refreshes the table in THREAT_MODEL.md.
 *
 *   npm run security:table            # needs local Supabase (npm run supabase:start)
 *   npm run security:table -- --write
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AREAS: Record<string, string> = {
  PI: 'Prompt injection (stored as data, never executed)',
  DL: 'Router data blocks (per-call nonce delimiters)',
  AU: 'Authorship set from the message source, not the model',
  AP: 'Approval spoofing (owner only, per-task code, no replay/expiry/wrong task)',
  MA: 'MCP auth (OAuth, per-client tokens, no unauthenticated calls, rate limits)',
  SC: 'Scopes enforced at the delivery layer',
  SB: 'Supabase (RLS everywhere, no service key, secrets only in env)',
  SQ: 'SQL injection',
  CD: 'chat.db read-only',
  LG: 'No message bodies in logs',
  LP: 'Loops stop at the hop limit; "pause hub" halts delivery',
};

interface JsonReport {
  testResults: { name: string; assertionResults: { title: string; status: string; duration?: number; failureMessages: string[] }[] }[];
}

const out = path.join(mkdtempSync(path.join(tmpdir(), 'hub-security-')), 'report.json');
const run = spawnSync('npx', ['vitest', 'run', 'test/security', '--reporter=json', `--outputFile=${out}`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
const report = JSON.parse(readFileSync(out, 'utf8')) as JsonReport;

const rows = report.testResults.flatMap((f) =>
  f.assertionResults.map((a) => {
    const [id, ...rest] = a.title.split(' ');
    return { id, area: id.split('-')[0], test: rest.join(' '), file: path.relative(ROOT, f.name), pass: a.status === 'passed', status: a.status };
  }),
);
rows.sort((a, b) => Object.keys(AREAS).indexOf(a.area) - Object.keys(AREAS).indexOf(b.area) || a.id.localeCompare(b.id, 'en', { numeric: true }));

const cell = (s: string) => s.replace(/\|/g, '\\|');
const lines = [
  '| ID | Area | Check | Result |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.id} | ${cell(AREAS[r.area] ?? r.area)} | ${cell(r.test)} | ${r.pass ? 'PASS' : `**${r.status.toUpperCase()}**`} |`),
];
const passed = rows.filter((r) => r.pass).length;
const summary = `${passed}/${rows.length} passed (${new Date().toISOString().slice(0, 10)})`;
const table = `${lines.join('\n')}\n\n${summary}`;
console.log(table);

if (process.argv.includes('--write')) {
  const file = path.join(ROOT, 'THREAT_MODEL.md');
  const doc = readFileSync(file, 'utf8');
  const start = '<!-- security-table:start -->';
  const end = '<!-- security-table:end -->';
  const i = doc.indexOf(start);
  const j = doc.indexOf(end);
  if (i < 0 || j < i) throw new Error('THREAT_MODEL.md has no security-table markers');
  writeFileSync(file, `${doc.slice(0, i + start.length)}\n${table}\n${doc.slice(j)}`);
  console.log(`\nUpdated ${path.relative(process.cwd(), file)}`);
}
process.exit(run.status === 0 && passed === rows.length ? 0 : 1);
