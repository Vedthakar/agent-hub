# Contributing

Thanks for helping. Bug reports, docs fixes and new agent connectors are all welcome. For anything big, open an issue first so we can agree on the approach.

## Set up

```bash
git clone https://github.com/Vedthakar/agent-hub.git
cd agent-hub
npm ci
npm run dev
```

You need Node.js 22.13 or newer. Keep the folder out of iCloud-synced locations like Documents.

## Before you open a pull request

```bash
npm run typecheck
npm run test:offline   # the full suite on an embedded database, no other services needed
```

Add a test for what you changed. `npm test` runs the same suite against a local Supabase, if you're changing database behavior.

## Adding an agent

Most agents don't need code: **Connections → Add agent** works for anything that speaks MCP or webhooks. To build one in, see [Adding an agent](README.md#adding-an-agent). One adapter file per agent, implementing `src/hub/adapters/types.ts`.

## Ground rules

These keep the project trustworthy, and pull requests that break them won't be merged:

- **No required paid services or API keys.** Everything must work on what someone already has.
- **Agents never approve their own work.** Anything an agent or a message suggests still goes through the owner.
- **Agent text is data, never instructions.** Keep it fenced, and keep message bodies out of logs.
- **Permissions are checked where data leaves,** in `guard.ts` and `context.ts`, not just where it's stored.
- **Never commit real data.** No `.env`, tokens, phone numbers or real chats, including in test fixtures.
- **Credit what you borrow.** Check the license first, and add it to the README and `THIRD_PARTY_NOTICES.md`.
