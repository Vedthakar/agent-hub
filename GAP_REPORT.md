# Agent Hub v1: Gap Report

Audit of the codebase against the *Agent Hub v1 Build Spec*.

- **Step 1 audit:** 2026-10-29.
- **Updated after step 2 ("fill the gaps"):** 2026-10-29. Every Missing/Partial row from step 1 has been addressed, or explicitly deferred with a reason. The step-1 status is shown in brackets wherever it changed.

Status key: **Done** = implemented and covered by a test · **Partial** = implemented but incomplete or happy-path only · **Missing** = not implemented · **Diverges** = implemented differently from the spec (reason given).

Nothing has been exercised against a live third-party account (Claude, ChatGPT, Gemini, Instinct, Stanley, Boardy, Grok Bot, Twilio, Telegram). "Done" means done in code and in local tests: 36 tests in 4 files, `npm test`. Steps 3–5 expand these into the full unit, integration, e2e, security and stress suites.

---

## 1. Product summary

| Item | Status | Where | Notes |
| --- | --- | --- | --- |
| Pillar 1: seamless context sync | Done | `context.ts` `situationFor`/`renderSituation`, `mcp.ts` `get_situation` | Pull for MCP agents; email digest for Instinct. |
| Pillar 2: cross-agent triggers with per-trigger text approval | Done | `router.ts`, `tasks.ts`, `approvals.ts`, `dispatch.ts` | Approval needs a per-task code ("Y K3FD"). |
| v2 per-route autonomy | Done [Partial] | `routes` table, `store.ts` `routeAutonomy`/`setRoute`, `approvals.ts` `autonomyFor`, `/scopes` editor | The route setting overrides the target default. Tasks suggested by an agent, or extracted from agent-only conversations, always ask. |
| Non-goal: no shared notes vault | Done | — | |
| Non-goal: never push into the user's own threads | Done [Partial] | `adapters/instinct.ts` | Digests go only to Instinct's forwarding email; otherwise they're held. The iMessage-thread fallback for tasks is off unless `ALLOW_THREAD_FALLBACK=1`. Test: `hub.test.ts` "nightly debrief" checks zero outbox rows to the Instinct handle. |

## 2. Launch connectors

Every adapter is one file implementing `{ id, readEvents(), deliverContext(), triggerTask(), capabilities }`. All four are now required by the type (`adapters/types.ts`).

| Agent | Read | Deliver / trigger | Status | Notes |
| --- | --- | --- | --- | --- |
| Claude | MCP `log_session` | MCP `get_situation` / `get_inbox` | Done | `adapters/claude.ts` → `mcpAgent.ts`. OAuth e2e test. |
| ChatGPT | MCP (Developer Mode) | same | Done | Client-specific standing instructions are a step-6 item. |
| Gemini | MCP (Connected Apps) | same | Done | Same. |
| Instinct | Mac daemon (chat.db) | Email to forwarding address | Done [Partial] | The digest is emailed (or held). Tasks are emailed with Message-ID tracking. Bounces found over IMAP re-queue the task (`bounces.ts`). Tests: `gaps.test.ts` retry/DLQ and bounce. |
| Stanley | Mac daemon (chat.db) and Telegram history | Telegram (separate thread) | Done, **Diverges** [Partial] | Uses an MTProto *user* session because Telegram bots can't message bots. Reads paginate (100 × 20 pages) from a persisted cursor, honour FLOOD_WAIT and reconnect. The hub's own messages are tagged `hub`. No web fallback: Stan's web app has no API. |
| Boardy | Mac daemon (iMessage/SMS) and IMAP inbox | Email to boardy@boardy.ai in the official [boardy.ai/agents](https://boardy.ai/agents) brief format | Done [Partial/Diverges] | `composeBoardyBrief` follows the official template (subject "Ask Boardy: …" plus the official sections), sent from the user's own address. Standing context is scope-filtered and DLP-filtered. IMAP read is read-only, with UID and UIDVALIDITY cursors. A warning is shown if LinkedIn isn't set, because Boardy can't search without it. Test: `gaps.test.ts` "official brief". |
| Grok Bot | Reports via MCP | Pulls via MCP `get_inbox`; optional webhook nudge | Done [Partial] | The webhook carries only the task code, signed with HMAC-SHA256 (`X-Hub-Signature: sha256=…` over `timestamp.body`). Feasibility spike: `scripts/grok-spike.ts` (list tools → get_situation → get_inbox → update_task). It has **not** been run against a live Grok Bot. |
| Design rule: side channel only; hold context and send one compact message at the moment of action | Done [Partial] | `deliverContext` is held for Stanley and Boardy; `composeTaskMessage` / Boardy brief | |

## 3. Architecture

| Item | Status | Where | Notes |
| --- | --- | --- | --- |
| Cloud hub: Postgres + Node/TS | Done | `db.ts` | Postgres (`DATABASE_URL`) or embedded PGlite. Adds `transaction()`: each router apply runs in one transaction. |
| MCP StreamableHTTP + OAuth | Done | `server.ts`, `oauth.ts` | |
| MCP rate limiting | Done [Missing] | `server.ts` | Per IP before auth (5× the limit) and per OAuth client after auth (`RATE_LIMIT_MCP_PER_MIN`, default 120). The 429s are audited. Load test in step 5. |
| Daemon: launchd, read-only chat.db, attributedBody, ROWID checkpoint | Done | `daemon/daemon.ts`, `daemon/chatdb.ts`, `scripts/install-daemon.sh` | |
| Daemon sends via AppleScript only when needed | Done | `daemon/send.ts` | Used only for approval texts and notices, or opted-in fallbacks. |
| Approvals "from the hub's own number" | Done [Partial] | `approvals.ts`, `server.ts` `/twilio/sms`, `hub.ts` | Three channels, each checking the sender. **iMessage:** only `is_from_me` messages that aren't the hub's own echo. **Telegram:** `from.id` must equal the owner. **SMS (Twilio):** a real separate hub number; the webhook signature is verified and `From` must equal `APPROVAL_USER_NUMBER`. |
| Daemon resilience | Done [Partial] | `daemon/daemon.ts` | Testable `Daemon.cycle()` that never throws. A rejected page is bisected to isolate and skip a poison message. Busy timeout is 5s. chat.db is reopened on BUSY/IOERR/CORRUPT/schema errors. Sleep/wake detection (gap > 6× the poll interval) reopens the DB and refreshes config. The checkpoint holds while the hub is down. Handles added later get a 24h backfill. Sent outbox ids are remembered, so a lost ack never causes a second text. Tests: `gaps.test.ts` "daemon". |
| Pluggable adapter interface | Done [Partial] | `adapters/types.ts` | All four members are required. |
| Approval text "Instinct → Grok Bot: … OK?" | Done | `approvals.ts` `request` | Text: `[CODE] Instinct → Grok Bot: … OK? Reply "Y CODE" or "N CODE" (expires in 12h).` |
| Keep awake (`pmset`) | Done | `scripts/keep-awake.sh` | Wake detection is in the daemon. The step-5 chaos test covers resume. |
| Catch-up after sleep | Done | `Daemon.drain` | Pages in ROWID order; the checkpoint advances only after the hub accepts a page. Throughput is measured in step 5. |
| Cloud agents never depend on the laptop | Done | — | |
| `/health` per adapter | Done [n/a in step 1] | `health.ts`, `server.ts` `/health`, `/health/:agent` | Public callers get states only. The daemon token unlocks errors and queue counts. Test: `gaps.test.ts` "/health". |

## 4. Data model

| Table / rule | Status | Where | Notes |
| --- | --- | --- | --- |
| `events` append-only + provenance | Done | `schema.sql` | Adds `route_attempts`, `next_route_at`, `last_error`, `dead_lettered_at`. |
| `situation` TTL + supersession | Done | `store.ts` | |
| `facts` | Done | | |
| `tasks` lifecycle + hop count | Done [Done, missing states] | `schema.sql` v1.1 | Adds `cancelled`, `expired`, `next_attempt_at`, `approval_expires_at`, `delivery_ref`. |
| `scopes` | Done | | |
| Provenance on every record | Done [Partial] | `mcp.ts` `propose_task` | MCP proposals are always `author='agent'`. The agent's "user asked" claim goes into the rationale only. Test: `hub.test.ts` "propose_task". |
| Dead-letter queue | Done [Missing] | `dead_letters` table; `/` dashboard with Retry/Dismiss | Kinds: route, delivery, digest. |
| Per-route autonomy table | Done [Missing] | `routes` table | |
| Inbound command log (replay protection) | Done [n/a] | `inbound_commands` (unique channel + external_id) | |
| Migration idempotent on an existing DB | Done | `schema.sql` | Verified by opening the same PGlite directory twice. The status constraint is recreated to include the new states. |

## 5. Router

| Item | Status | Where | Notes |
| --- | --- | --- | --- |
| 10-minute debounced bursts | Done | `hub.ts` `collectBursts` | Each burst is now written in one transaction. |
| Summarize → situation → tasks | Done | `router.ts` | `applyRouterOutput` is exported for the step-3 golden tests. |
| Scopes, dedup, hop limit | Done [Done with bugs] | `tasks.ts`, `store.ts` `dedupKey` | Dedup is Unicode-aware (NFKC, letters, numbers, emoji). Rejected and cancelled tasks count as duplicates, so nothing is re-proposed for 24h. The proposal gate also runs the deterministic DLP check. |
| Queue for approval | Done [bug] | `approvals.ts` `request` | Tasks are marked "asked" only if the text actually went out. |
| LLM robustness | Done [Missing] | `llm.ts`, `hub.ts` `routePendingNow` | 60s timeout. Retryable errors: 408/409/429/5xx (honouring Retry-After), network errors, bad JSON envelopes, missing or malformed JSON, and schema failures. Attempts are persisted on the event with exponential backoff and jitter. The DLQ triggers after `ROUTER_MAX_ATTEMPTS` (5). A failing event never blocks others. Test: `gaps.test.ts` "router". |
| Nightly debrief digest | Done [bug] | `debrief.ts` | Ingest only records `debrief.pending`; the tick sends with retries, and `lastDate` is set only after success. Dead-letters after 5 failures. Dashboard "send now" queues it. |
| Plan written to situation | Done | | The end of the debrief is still "burst went quiet". |

## 6. Privacy and scopes

| Item | Status | Where | Notes |
| --- | --- | --- | --- |
| Default scopes | Done | `scopes.ts` | |
| Dashboard editable | Done | `/scopes` | Adds an at-a-glance table and a per-route editor. |
| Enforced at the delivery layer | Done [Missing] | `guard.ts` `checkDelivery`, called from `dispatch.ts` | Re-checked after approval, right before the adapter call: enabled, topic scope, and a deterministic keyword scan for school/health/finances/personal against `deny_topics`. Context lines are filtered the same way. A violation becomes `blocked` and the user is told. Test: `gaps.test.ts` "blocks Boardy at delivery". The 15-fixture injection suite is in step 4. |

## 7. Safety

| Item | Status | Where | Notes |
| --- | --- | --- | --- |
| Agent content is data | Done [Partial] | `approvals.ts` `autonomyFor`, `router.ts` prompt, `context.ts` banner | Structural defence as well as the prompt: anything not straight from the user (agent author, or an event without the user in it) always needs a human, whatever the autonomy setting says. |
| Hop limit + dedup | Done | | |
| Kill switch | Done [Partial] | `dispatch.ts` (paused re-read before every task), `store.claimOutbox({paused})` | While paused, only approval/notice texts leave the outbox, never deliveries. "pause hub" works from iMessage, Telegram, SMS and the dashboard. |
| Audit timeline | Done | | Audit records character counts, not approval text bodies. |
| Approval spoofing defences | Done [Missing] | `approvals.ts` | A per-task code is required, multiple codes are allowed, and a bare "Y" does nothing. Owner-only per channel (see section 3). Replays are ignored via `inbound_commands`. Codes expire (`APPROVAL_TTL_HOURS`, default 12) and are swept every tick. Lockout after `APPROVAL_MAX_INVALID` (5) unknown codes per 15 min. The Telegram offset is persisted. Foreign senders are dropped silently. Tests: `hub.test.ts` and `gaps.test.ts` "approvals". |
| Supabase RLS | Done [Missing] | `schema.sql` DO block | RLS is enabled on all 16 tables with no policies. If the `anon`/`authenticated` roles exist, all privileges on tables and sequences are revoked from them. The hub connects as the table owner over a direct Postgres URL. No Supabase client or keys are in the code. |
| Structured logs with redaction | Done [Missing] | `shared/log.ts`; used by hub, server, daemon, dispatch | JSON lines. Body-like keys (`text`, `body`, `payload`, `summary`, …) are replaced by a length, and strings are capped at 300 characters. |
| No hardcoded secrets | Done [Partial] | `config.ts` | The `'dev-secret'` fallback is gone (random per boot, with a warning). With `NODE_ENV=production`, the hub refuses to boot with `change-me` placeholders. |

## 8. Dashboard

| Item | Status | Where |
| --- | --- | --- |
| Timeline, situation, scopes | Done | |
| Pending approvals | Done | Shows asked-at and expiry; dashboard approval honours expiry. |
| Adapter health | Done [Partial] | State (ok / degraded / down / unconfigured / disabled), last read, delivery and error, plus a queue column (waiting, queued, retrying, failed in the last 24h). |
| Dead-letter queue | Done [Missing] | Retry (route → requeue, delivery → fresh attempts, digest → resend) and Dismiss. |
| Cancel task | Done [Missing] | Button on proposed/approved tasks, plus `cancel CODE` by text. |
| Login hardening | Done [Partial] | 10 failed logins per 15 min per IP. CSRF still relies on `SameSite=Strict`; step 4 re-examines it. |

## 9. Build order

| # | Step | Status |
| --- | --- | --- |
| 1 | DB schema + MCP; Claude first | Done |
| 2 | Mac daemon, ROWID checkpoint, launchd | Done (resilience gaps closed) |
| 3 | Router; approval texts | Done (timeouts, retries, DLQ, codes) |
| 4 | Instinct email; nightly debrief | Done (email-only, retried) |
| 5 | ChatGPT + Gemini | Done; per-client instruction text in step 6 |
| 6 | Stanley (Telegram) + Boardy (email / boardy.ai/agents) | Done |
| 7 | Grok Bot (spike early) | Done in code; spike script written, not yet run live |
| 8 | Dashboard; v2 per-route auto mode | Done |

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| iMessage agents change or block automation | The read path is passive. Nothing writes into iMessage agent threads by default. |
| Gemini tier-gated; ChatGPT web-only | Documented. |
| Full Disk Access trust ask | Read-only open with whitelisted handles. The public "what data goes where" README is in step 6. |
| MCP agents only pull if instructed | One instruction for now; per-client versions in step 6. |

---

## Bugs from step 1: all fixed

| # | Bug | Fix | Test |
| --- | --- | --- | --- |
| 1 | Hung LLM call freezes the hub | `AbortSignal.timeout` in `llm.ts`; a failure is persisted and doesn't block the tick | `gaps.test.ts` router |
| 2 | Bare "Y" approves everything / no sender check | Codes required; sender checked per channel | `hub.test.ts` first test, `gaps.test.ts` Twilio |
| 3 | Telegram replies replay after restart | Offset persisted in `settings` | — (step 4) |
| 4 | Approval marked sent when the text failed | `notifyUser` returns a boolean; marked only on success | `gaps.test.ts` cancel test |
| 5 | No delivery-layer scope check | `checkDelivery` in `dispatch.ts` | `gaps.test.ts` Boardy block |
| 6 | Kill switch leaks | Paused re-read per task; outbox holds deliveries | `gaps.test.ts` pause |
| 7 | Dedup drops non-ASCII | Unicode-aware key | — (step 3 unit) |
| 8 | Rejected tasks re-proposed | Rejected/cancelled count as duplicates | — (step 3 unit) |
| 9 | Stanley read gap over 50 messages | Paginated `fetchSince` | — (step 3 unit, mocked) |
| 10 | Daemon poison pill | Bisect and skip | `gaps.test.ts` daemon |
| 11 | Debrief digest not retried / in request | `debrief.pending` processed in the tick with retries | `hub.test.ts` debrief |
| 12 | No delivery backoff / DLQ | Exponential backoff, DLQ, user notified | `gaps.test.ts` delivery |
| 13 | Outbox at-least-once duplicates | Daemon remembers sent ids and re-acks | `gaps.test.ts` daemon |
| 14 | `propose_task` trusts `user_requested` | Always `author='agent'` | `hub.test.ts` propose_task |
| 15 | Unsigned Grok webhook | HMAC-SHA256 + timestamp | `gaps.test.ts` |
| 16 | New handles never backfilled | 24h backfill per newly watched handle | — (step 3) |

A smaller bug was found and fixed during step 2: an iMessage-delivery outbox failure (`ack ok:false`) now re-queues its task instead of leaving it `sent`.

## TODOs left in code

None marked `TODO`/`FIXME`.

## Hardcoded secrets

- No real secrets in source. `rg` for `sk-`, `eyJ`, `service_role`, `password=` finds nothing in `src/`.
- The session secret falls back to a random value, not a literal. If `HUB_SESSION_SECRET` is unset, it reuses `HUB_OWNER_PASSWORD` as the HMAC key, with a boot warning. Step 4 decides whether to require it.
- Placeholder secrets refuse to boot in production.
- Test-only fixed tokens (`daemon-token`, `hunter2`, `tw-secret`).

## Still happy-path or deferred (owned by later steps)

- **Measured, not just designed:** 10k-message catch-up throughput, 50 concurrent `get_situation`, simultaneous approvals, and Messages.app restart mid-read. All step 5. Ingest is still one INSERT per message; batching is the expected step-5 fix.
- **Live accounts:** Telegram FLOOD_WAIT and IMAP are only exercised with mocks or not at all. Grok spike not run against a live bot. `npm run smoke` (step 3) checks SMTP, Telegram MTProto, the approval channel and the MCP OAuth flow with real credentials, sending only to Ved.
- **Postgres/Supabase:** done in step 3. Integration, e2e and RLS tests run on local Supabase (`npm run supabase:start`); `npm run test:offline` keeps a PGlite fallback.
- **CSRF:** relies on `SameSite=Strict` cookies; step 4 decides whether to add tokens.
- **Debrief end:** still inferred from burst quiet time; there's no explicit "debrief done" signal.

## Bugs found by the step-3 test suite: all fixed

| Bug | Found by | Fix |
|---|---|---|
| JSON settings, audit details and OAuth client metadata were double-encoded on real Postgres, so `isPaused()` read the string `"true"` | Integration tests on Supabase | Explicit `$n::text::jsonb` casts (`store.ts`, `oauth.ts`) |
| `undefined` query params crashed postgres.js (PGlite accepted them) | Integration tests on Supabase | `db.ts` maps `undefined` to `NULL` |
| Reply-to-task hop attribution failed when the DB clock ran ahead of the Mac's (about 30 ms here), so a reply could start a fresh hop-0 chain | Integration tests on Supabase | `lastTaskSentTo` allows 120 s of clock skew |
| `service_role` had table grants, so a leaked service key could read every table through PostgREST | RLS tests | Schema revokes all table and sequence grants from `service_role` (the hub talks to Postgres directly) |
| A debrief with several commitments kept only the last one: items in the same `plan:<date>` slot superseded each other | Golden case 04 | Items from the same event no longer supersede each other |
| Stanley: if the new side-channel Telegram thread was empty on the first poll, the first exchange (task plus Stan's reply) was skipped as "history" | Resilience test | An empty first poll sets the checkpoint to 0 |
| A corrupt daemon checkpoint counted as a first run, which restarts at the newest message and silently drops the backlog | Daemon unit tests | Atomic save keeps `state.json.bak`; load falls back to it and otherwise errors (shown in health) |
| Malformed model JSON put V8's parse error, which quotes about 20 characters of conversation, into the `router.failed` log line | chat.db pipeline log test | `extractJson` reports only the position |
| `LOG_LEVEL` was read once at import, so module-level loggers ignored later changes | Log test | Level is read on each call |

Deferred to step 4: a literal `</transcript>` inside a transcript can close the router's data block early (prompt-injection vector). The router can also claim `author: "user"` for content an agent wrote.
