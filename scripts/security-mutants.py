"""
Mutation check for the step-4 security fixes: reverts each fix in turn, runs the test file that should
catch it, and restores the source. Every line should say KILLED.

    python3 scripts/security-mutants.py            # all mutants (needs local Supabase)
    python3 scripts/security-mutants.py Boardy     # only mutants whose name contains "Boardy"
"""
import subprocess, sys, os

MUTANTS = [
    ("nonce escaping removed", "src/hub/router.ts", "  return `<${tag} kind=\"${label}\">\\n${safe}\\n</${tag}>`;", "  return `<${tag} kind=\"${label}\">\\n${body}\\n</${tag}>`;", "test/security/injection.test.ts"),
    ("authorship: any cited user line", "src/hub/router.ts", "cited.every((a) => a === 'user')", "cited.some((a) => a === 'user')", "test/security/authorship.test.ts"),
    ("authorship: trust event author only", "src/hub/router.ts", "  if (event.author !== 'user') return 'agent';\n  const byId", "  if (event.author === 'user') return 'user';\n  const byId", "test/security/authorship.test.ts"),
    ("MCP hop from task_code only", "src/hub/mcp.ts", "return [own, recent].filter", "return [claimed].filter", "test/security/loops.test.ts"),
    ("Boardy hard floor removed", "src/hub/scopes.ts", "{ boardy: SENSITIVE }", "{}", "test/security/scopes.test.ts"),
    ("no obfuscation normalisation", "src/hub/guard.ts", "const variants = [text, normalizeForScan(text)];", "const variants = [text];", "test/security/scopes.test.ts"),
    ("context filtered by tags only", "src/hub/context.ts", "return !sensitiveTopicsIn(text).some((t) => deny.has(t));", "return true;", "test/security/scopes.test.ts"),
    ("loose Twilio sender match", "src/hub/server.ts", "fromOwner: sameHandle(from, t.userNumber)", "fromOwner: from.replace(/\\D/g, '').slice(-10) === (t.userNumber ?? '').replace(/\\D/g, '').slice(-10)", "test/security/approvals.test.ts"),
    ("dashboard origin check removed", "src/hub/dashboard.ts", "if (!allowed && (from !== null || req.get('sec-fetch-site') === 'cross-site')) {", "if (false) {", "test/security/approvals.test.ts"),
    ("refresh reuse not detected", "src/hub/oauth.ts", "      if (reused.length) {", "      if (false) {", "test/security/mcp-auth.test.ts"),
    ("consent not rate limited", "src/hub/server.ts", "app.post('/oauth/consent', consentLimit, ", "app.post('/oauth/consent', ", "test/security/mcp-auth.test.ts"),
    ("NUL bytes passed to Postgres", "src/hub/db.ts", "p.replace(/\\u0000/g, '') : p);", "p : p);", "test/security/platform.test.ts"),
    ("dashboard ids unvalidated", "src/hub/dashboard.ts", "if (/^[1-9]\\d{0,15}$/.test(id)) return next();", "return next();", "test/security/platform.test.ts"),
    ("agent approvals accepted", "src/hub/approvals.ts", "    if (task.author !== 'user') return 'ask';\n", "", "test/security/authorship.test.ts"),
    ("pause not re-checked per task", "src/hub/dispatch.ts", "    if (await store.isPaused()) break;\n", "", "test/security/loops.test.ts"),
]

env = dict(os.environ)
only = sys.argv[1:]
survived = 0
for name, path, old, new, test in MUTANTS:
    if only and not any(o in name for o in only):
        continue
    src = open(path).read()
    if old not in src:
        print(f"SKIP  {name}: pattern not found in {path}")
        continue
    try:
        open(path, "w").write(src.replace(old, new, 1))
        r = subprocess.run(["npx", "vitest", "run", test], capture_output=True, text=True, env=env)
        out = r.stdout + r.stderr
        failed = [l.strip() for l in out.splitlines() if l.strip().startswith("×")]
        verdict = "KILLED" if r.returncode != 0 else "SURVIVED"
        survived += verdict == "SURVIVED"
        print(f"{verdict:8} {name}: {len(failed)} failing -> {', '.join(f.split(' ')[1] for f in failed[:6])}")
    finally:
        open(path, "w").write(src)

sys.exit(1 if survived else 0)
