# Agent Hub

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-339933)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](#contributing)

Make all your AI agents work as one.

<!-- Replace the line below with: ![Demo](docs/demo.gif) -->

*Demo GIF: add `docs/demo.gif`.*

People keep a stack of specialized agents. Instinct, Stanley, and Boardy live in iMessage. Claude, ChatGPT, and Gemini each have their own chat. Grok Bot runs on its own. Every one of them starts from zero. You repeat the plan, the constraints, and what you already finished, and none of them can hand a piece of work to the one who should do it.

Agent Hub is the layer in between. It keeps one picture of what you are doing, and it turns a decision in one conversation into a task for another agent after you approve it.

## What it does

**Seamless context sync.** Claude, ChatGPT, Gemini, and Grok Bot load the shared picture when a chat starts, limited to topics that agent may see. Instinct receives the day's picture by email when a debrief starts. Stanley and Boardy receive a short slice with a task, at the moment they have to act. Last night's plan is waiting in the morning. A study session in Gemini is there when you continue in Claude. Work you finished in Claude is in Instinct's digest, so the debrief starts from what already happened.

**Cross-agent actions.** A decision in one conversation becomes a task for the agent whose job it is. By default you approve it by texting a four-character code (`Y K3FD` or `N K3FD`) before anything is sent.

The default is ask-first. Per-route `notify` and `auto` exist for hand-offs taken from your own messages. Anything an agent proposes still asks. See [Roadmap](#roadmap) for sending those automatically.

## Use cases

### Nightly debrief

**Before.** Instinct asks how the day went. You reconstruct it from memory, including work that happened in other tools.

**With the hub.** When a debrief starts in the Instinct thread, the hub emails Instinct's forwarding address a digest of the day: what other agents logged, which hand-offs are `sent` or `done`, what is still current, and which goals are still standing.

### Morning handoff

**Before.** You open Claude and retype the plan you made with Instinct the night before.

**With the hub.** The debrief stores tomorrow's plan as situation items that become current in the morning. Claude reads them with `get_situation`. Stanley sees the shoot. The study block stays with Claude, ChatGPT, Gemini, and Instinct.

### Study across tools

**Before.** You study in Gemini or ChatGPT, then open Claude and spend the first messages catching it up.

**With the hub.** The study session is logged, tagged, and given an expiry. Claude and ChatGPT see it the next time they ask for the situation. Boardy, Stanley, and Grok Bot do not see school-tagged items.

### Content

**Before.** "I need to shoot tomorrow" sits in Claude. Stanley finds out when you remember to tell him.

**With the hub.** The hub proposes a script task for Stanley. After you reply `Y` and the code, it is delivered in a separate Telegram chat, with a short context block. It does not appear in your iMessage thread with Stanley.

### Project control

**Before.** "Pause open source for a week" is a sentence in Instinct. Grok Bot keeps going.

**With the hub.** The hub records a situation item that expires in a week and proposes a task for Grok Bot. You approve it. Saying you are resuming early replaces that item and proposes a follow-up task.

### Live situation

**Before.** You tell one agent you are starting a coding assessment. The others still try to pull you into other work.

**With the hub.** "In an assessment until 22:00" is stored with an expiry, in a slot so a later update replaces it. Claude, ChatGPT, Gemini, and Instinct can see it. A school-tagged item stays hidden from Boardy, Stanley, and Grok Bot. When the time passes, it drops off on its own.

### Goals and calendar

**Before.** You move a launch date in Claude, and you mention a bill to Instinct. The old date lingers, and a work agent is the wrong place for a rent reminder.

**With the hub.** A later conversation retires the old goal and records the new one. A finance reminder can be proposed for Instinct. The same reminder aimed at Grok Bot is blocked, including when the model tagged it as work.

### Progress you already made

**Before.** You finished the open-source list in Claude. Instinct still has yesterday's list, and you report the day a second time.

**With the hub.** Claude logs the session. Tonight's digest lists that work under today's activity, the goals still standing, and the status of each hand-off. A goal a later conversation replaces is retired, so the old one drops off the list. A hand-off closes when the agent it was sent to reports `done`, or when you cancel it (`cancel K3FD`, or the dashboard). Finishing the work in Claude updates the shared activity. Closing another agent's task is that second step.

## Supported agents

| Agent | Connects via | Read / write | Notes |
| --- | --- | --- | --- |
| Claude | MCP (OAuth) | `get_situation`, `log_session` / inbox tasks | Pick "Claude" on the consent screen. Needs the [standing instruction](#connect-claude-chatgpt-and-gemini). |
| ChatGPT | MCP (OAuth) | same | Developer-mode connectors run in the web app. They do not run in the mobile app. |
| Gemini | MCP (OAuth) | same | Custom MCP servers need the Spark tier. This server speaks Streamable HTTP. |
| Grok Bot | MCP (static bearer), optional webhook | same MCP tools / inbox | Webhook posts the task code, not the body. Scope is work and open source. |
| Instinct | iMessage read, email write | Daemon reads the thread / email digest and tasks | Forwarding address in `INSTINCT_EMAIL`. All topics. |
| Stanley | iMessage read, Telegram read and write | Daemon reads iMessage; adapter polls Telegram / tasks on Telegram | A separate Telegram chat. Context rides with the task. There is no digest. Content and shoots. |
| Boardy | iMessage read, email write, IMAP read | Daemon and inbox replies / email brief | Sends to `boardy@boardy.ai`. Professional and networking only. |

MCP tools are `get_situation`, `log_session`, `get_inbox`, `propose_task`, and `update_task`. Each OAuth connection is bound to one agent.

## How it works

```mermaid
flowchart LR
  Mac["Mac daemon"] --> Hub["Hub"]
  Hub --> Router["Router"]
  Router --> Adapters["Adapters"]
  Adapters --> Agents["Agents"]
```

The daemon ships new lines from watched iMessage threads. MCP agents push sessions and pull context themselves. An iMessage or Telegram thread is routed after 10 minutes of quiet. A session logged with `log_session` is routed on the next pass.

**Router.** One model pass (Anthropic or OpenAI, from the key you set) writes a short summary, situation updates, durable goals, and any tasks. Who sent each line comes from message metadata, not from the text. The transcript and the stored state are wrapped as untrusted data. With no API key, sessions are stored and not analysed.

**Situation.** This is short-lived state: what you are doing now, a plan, a temporary pause. Each item expires. If the model leaves the expiry off, the hub keeps it for 24 hours. A slot name (`now:activity`, `plan:2026-11-02`, `pause:open_source`) means a newer item replaces the older one. Tomorrow's plan can stay hidden until morning via `valid_from`. Goals and preferences are separate, and they stay until a later conversation retires them. You can clear a situation item on the dashboard.

**Tasks and approvals.** A task is one instruction for one other agent. Before you are asked, the hub checks that the target exists, that it is not the agent the conversation came from, that the payload is inside that agent's scope, that the same hand-off was not already proposed in the last 24 hours, and that the chain is within 2 hops. The text looks like:

```text
[K3FD] Instinct → Grok Bot: Pause open-source work for 1 week.
OK? Reply "Y K3FD" or "N K3FD" (expires in 12h).
```

Each code approves one hand-off, once. A reply has to include the code. Several codes can share one text. Only messages from your own account count. Five unknown codes in 15 minutes lock approvals. You can approve, reject, or cancel on the dashboard as well. Bursts you took part in start a new chain. Agent-only replies to a hub task inherit its hop count, and anything past hop 2 is blocked.

Delivery uses the adapter for that agent: an MCP inbox, email, or Telegram. The assignee marks the task `done` or `failed` with `update_task`.

## Privacy and security

**On your Mac.** The daemon is the hub's reader of Messages. It opens `~/Library/Messages/chat.db` read-only, and forwards 1:1 threads whose handles are listed in `IMESSAGE_HANDLES`. macOS hides that database behind Full Disk Access, so you grant it to the `node` binary the install script prints. That permission is what makes the file readable. The daemon opens it read-only, so this grant is not a write path into Messages. The first outgoing text, used for approval messages, triggers a separate Automation prompt for Messages. The checkpoint moves forward only after the hub has accepted a batch, so sleep and network drops are caught up rather than skipped.

**Your threads.** Digests and tasks go out on side channels: an MCP inbox, Instinct's or Boardy's email, or a Telegram chat with Stanley that is not your iMessage thread. Approval texts go to the handle, bot, or number you configure for that purpose. Point that at a separate thread, not at an agent's number. `ALLOW_THREAD_FALLBACK=1` is the opt-in that lets an Instinct task fall back into the iMessage thread. It is off.

**Scopes.** Instinct, Claude, ChatGPT, and Gemini see every topic. Stanley's default is content and shoots. Grok Bot's default is work and open source. Boardy sees professional and networking context only. School, health, finances, and personal are denied for Boardy in code, so a dashboard or database edit cannot open them. Untagged items stay with the full-access agents. The same check runs again at delivery, with a keyword scan, so a wrong tag does not leak a denied topic into the payload or the context lines.

**Approvals, injection, hops, pause.** Default autonomy is ask. Agent-suggested hand-offs always ask, even on a route set to `notify` or `auto`. `notify` and `auto` apply to hand-offs taken from your own messages. Text `pause hub` and outbound delivery stops. Text `resume hub` to turn it back on. The dashboard has the same control. Details of the injection wrapping, hop limit, and approval rules are in the sections above. The longer write-up is [THREAT_MODEL.md](THREAT_MODEL.md).

**What goes where.**

| Data | Where |
| --- | --- |
| Messages database | Stays on the Mac. The daemon sends text from watched threads only. |
| Events, situation, goals, tasks, audit log, hashed OAuth tokens | Hub database. Embedded PGlite in `.data/` when `DATABASE_URL` is unset, or your Postgres. |
| Transcript and current state, for the summary | The router provider you configured (Anthropic or OpenAI). |
| Context an agent can use | The slice its scope allows, when it calls `get_situation` or when you approved a task. |
| Grok webhook, if set | The task code. HMAC-SHA256 when `GROK_WEBHOOK_SECRET` is set. |
| Logs | Message bodies are replaced with their length. |

`/health` without the daemon token returns states only. Error text and counts stay behind `HUB_DAEMON_TOKEN`.

## Quick start

Node.js 22.13 or newer. A Mac is required for iMessage.

```bash
npm install
npm run dev
```

The hub prints a one-time setup link. Open it (or go to [http://localhost:8787](http://localhost:8787)) and:

1. Create a dashboard password.
2. Walk through the wizard: how it works, Full Disk Access, keep-awake, your approval number, which agents you use, then each agent's card.
3. On **Connections**, hook up the rest: copy the MCP URL for Claude / ChatGPT / Gemini, pick Instinct / Stanley / Boardy threads from Messages, generate Grok Bot's webhook.

Secrets you type in the UI are stored encrypted (macOS Keychain on a Mac, Supabase Vault in the cloud, or AES-GCM in the hub database). They are never written to `.env`.

**Today** is the home screen: current situation, today's events by agent, pending approvals with Approve / Deny, and adapter health. It works on a phone. You can still approve by text.

`.env` is optional, for servers and CI. Copy `.env.example` if you want to lock a value from the environment (the dashboard then shows it as “Set in .env”). With `DATABASE_URL` empty, data stays in `.data/`.

The longer walkthrough (Supabase, tunnels, Full Disk Access, lid-closed note) is [docs/setup.md](docs/setup.md).

### Connect Claude, ChatGPT, and Gemini

On each agent's Connections page the hub shows the MCP URL (`$HUB_PUBLIC_URL/mcp`), standing instructions with a copy button, and step-by-step screenshots. Cloud connectors need HTTPS. On the consent screen, choose the agent this connection is for, then hit **Test connection** — it waits for the first `get_situation` call.

- **Claude:** Settings → Connectors → Add custom connector.
- **ChatGPT:** Settings → Apps & Connectors → Advanced → Developer mode → Create connector. Web only.
- **Gemini:** Connected Apps → add a custom MCP server.

Grok Bot gets a generated token and webhook URL on its card. Instinct, Stanley, and Boardy use the thread picker plus their side channel (forwarding email, Telegram login, boardy.ai/agents).

### Smoke tests

`npm run smoke` talks to live services. Every message goes to you, and the script refuses a target that belongs to an agent. `--dry-run` prints what it would do.

```bash
npm run smoke -- --dry-run
npm run smoke -- --only=mcp,email
```

Checks are `mcp`, `email`, `telegram`, and `approval`. It reads `.env`, then `smoke.env` if that file exists.

## Adding an agent

An agent is one file that implements `Adapter`:

```ts
export interface Adapter {
  id: AgentId;
  name: string;
  capabilities: Capabilities; // profile, readVia, deliverVia, canReceiveTasks
  readEvents(ctx: AdapterContext): Promise<number>;
  deliverContext(ctx: AdapterContext, digest: { subject: string; body: string }): Promise<Delivery>;
  triggerTask(ctx: AdapterContext, task: TaskRow, context: string[]): Promise<Delivery>;
  configured(cfg: HubConfig): { ok: boolean; note: string };
}
```

1. Add the id to `AGENT_IDS` in `src/shared/types.ts`.
2. Add `src/hub/adapters/<id>.ts`.
3. Register it in `src/hub/adapters/index.ts`.
4. Give it a default scope in `src/hub/scopes.ts`.

`deliverContext` is for a silent digest. `triggerTask` is the moment the agent has to act. Both should use a side channel. A minimal email adapter:

```ts
import { NO_PULL_READS, composeTaskMessage, notConfigured, type Adapter } from './types.js';

export const acme: Adapter = {
  id: 'acme',
  name: 'Acme',
  capabilities: {
    profile: 'One sentence the router reads when choosing a target.',
    readVia: 'email',
    deliverVia: 'email',
    canReceiveTasks: true,
  },
  readEvents: NO_PULL_READS,
  async deliverContext(ctx, digest) {
    if (!ctx.transports.email) return notConfigured('email not configured');
    const { messageId } = await ctx.transports.email.send({
      to: 'acme@example.com',
      subject: digest.subject,
      text: digest.body,
    });
    return { ok: true, detail: 'emailed digest', ref: messageId };
  },
  async triggerTask(ctx, task, context) {
    if (!ctx.transports.email) return notConfigured('email not configured');
    const { messageId } = await ctx.transports.email.send({
      to: 'acme@example.com',
      subject: `Task [${task.code}]`,
      text: composeTaskMessage(ctx.cfg.ownerName, 'Acme', task, context),
    });
    return { ok: true, detail: 'emailed task', ref: messageId };
  },
  configured: () => ({ ok: true, note: 'example' }),
};
```

Reads that arrive on their own (the daemon, MCP) use `NO_PULL_READS`. Polling reads, like Stanley's Telegram loop, return how many new messages they stored.

## Roadmap

- **Automatic send for agent-suggested hand-offs on a route you trust.** `ask`, `notify`, and `auto` already exist per route. They apply to hand-offs taken from your own messages. A task an agent proposed still waits for a code.
- **More connectors.**
- **A Mac menu-bar app.** Today the daemon is a launchd agent (`com.agenthub.daemon`).

## Disclaimer

Agent Hub is not affiliated with Anthropic, OpenAI, Google, Instinct, Stanley, Boardy, or Grok Bot. Those products can change how they connect, and a connector that works today can need a new setup later.

## Contributing

Issues and pull requests are welcome.

```bash
npm run test:unit      # unit and golden tests, no extra services
npm run test:offline   # full suite on embedded PGlite
npm test               # full suite against local Supabase
```

`npm test` needs a local Supabase Postgres. Start it with `npm run supabase:start` (Docker), or use `npm run test:offline`. Do not commit `.env`, `smoke.env`, or daemon tokens.

## License

[MIT](LICENSE)

## Author

Ved Thakar
