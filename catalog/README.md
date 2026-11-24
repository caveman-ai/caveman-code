# Caveman catalog

The plugins Caveman Code ships as the `caveman-curated` marketplace (the
open-source caveman marketplace is `caveman`). The same files work as a Codex
marketplace (`.agents/plugins/marketplace.json`) and a Claude Code marketplace
(`.claude-plugin/marketplace.json`); keep the two identical. Entry order is
the featured order.

Each plugin: `.codex-plugin/plugin.json` (with the `interface` block),
`.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, `assets/logo.*`, and
`caveman.json` for what only Caveman Code reads.
`packages/runtime/src/plugins/catalog.test.ts` checks all of it.

## MCP servers

Endpoints and sign-in were checked on 2026-10-17 against each vendor's docs
and the server's OAuth metadata (RFC 9728 / 8414); Atlassian's `/v2/mcp`
(not `/v1/mcp`, which serves no RFC 9728 metadata) again on 2026-10-17.
`.mcp.json` holds only the standard `type`/`url`/`command`/`args`, so it
stays valid for Claude Code and Codex. Ours, per server, are in `caveman.json`
under `mcpServers.<server>`:

- `auth`: `oauth` (OAuth with dynamic client registration) or `github`
  (this computer's GitHub login, as the GitHub connector does). Absent: the
  server needs no sign-in (Context7) or is a local command.
- `unavailable`: why Connect is off. Slack and Asana register no clients
  dynamically; Connect turns on once Caveman's own app client id exists.
- `note`: Figma and Vercel admit only clients they have approved.

Local servers are pinned: `@playwright/mcp@0.0.83`, `@caveman-ai/cloud@0.1.0-rc.28`.

## Logos

Logos are the vendors' marks, used only to name their service. Trademarks
belong to their owners.

| Plugin | Source | Licence |
|---|---|---|
| GitHub, Linear, Notion, Sentry, Figma, Vercel, Supabase, Neon, Stripe, Cloudflare, PostHog, Atlassian, Asana, Hugging Face | [simple-icons](https://simpleicons.org) 16.35.0 SVG, filled with the brand colour (white for `logo-dark`) | CC0-1.0 (marks subject to each vendor's brand guidelines) |
| Slack | Slack media kit, `a.slack-edge.com/80588/marketing/img/meta/slack_hash_256.png` | Slack brand guidelines |
| monday.com | monday.com brand page, `monday-logo-2.svg` | monday.com brand guidelines |
| Playwright | `playwright.dev/img/playwright-logo.svg` (microsoft/playwright) | Apache-2.0 |
| Context7 | `upstash/context7` `public/context7-icon.svg` | MIT |
| Caveman Cloud | Caveman Cloud web favicon | Ours |
