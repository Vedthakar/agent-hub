# Security

Agent Hub holds private conversations, so security reports matter a lot.

## Reporting a problem

Please don't open a public issue. Use [GitHub's private reporting](https://github.com/Vedthakar/agent-hub/security/advisories/new) instead, and include how to reproduce it. You should get a reply within a week. This is a volunteer project, so there's no bug bounty.

## What to know when you run it

Read the [threat model](THREAT_MODEL.md) for the full picture. The main points:

- **You run it, so you secure it.** Use a strong dashboard password, and keep your machine updated.
- **Give each agent its own connection password,** so your hub password stays with you.
- **Don't expose it without HTTPS.** Connecting Claude, ChatGPT or Gemini means putting it on the internet.
- **Instinct's private vault link is effectively a password.** Anyone holding it can read what Instinct may see. Replace it if it leaks.
- **Connected agents belong to other companies.** What you let them read goes to them under their terms.
- **Agents can be tricked.** A hostile message could try to steer an agent that reads it, which is why hand-offs need your approval by default.
