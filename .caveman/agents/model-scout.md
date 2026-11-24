---
description: Compares the models vendors have released against the models this repository lists, and decides whether an update is due
engine: codex
model: gpt-6-luna
effort: medium
decides: [update, current]
---
Find every generally available model released by the vendors this repository already lists (Anthropic, OpenAI, Google, xAI, DeepSeek, Moonshot, Zhipu/GLM, and any other family you find in the files below) that is missing from this repository's model lists, or whose listed facts (id, price, context window) are out of date.

Sources, in order of trust:
1. The vendor's own models page or changelog (docs.anthropic.com models overview, platform.openai.com/docs/models, ai.google.dev models, docs.x.ai, api-docs.deepseek.com, and so on).
2. `curl -s https://external tools.ai/api/v1/models` (public, no key) for ids, `created` dates, prices and context lengths. Use it to find candidates; confirm each on the vendor's page before you report it.

Ignore previews, betas, deprecated models and models announced but not yet callable. Never guess a price or context window: report only what a source states, with its URL.

Where this repository lists models (read them; search for others with `git grep` on a known id such as the newest Claude or GPT id):
- `packages/protocol/src/model.ts`
- `packages/runtime/src/provider/model-manifest.json`
- `packages/ui/src/lib/model-facts.ts`
- `packages/provider-caveman/src/server/engineConfig.ts`, `credits.ts`, `rewriter.ts`
- `packages/runtime/src/session-protocol/engineAccounts.ts`
- `apps/mobile/src/board/catalog.ts`

Change nothing. End with a list: each model, its vendor, its id, the facts the files need (price per million tokens in and out, context window, release date), the source URL, and which files lack it. Then `decision: update` if anything is missing or wrong, or `decision: current` if every list is up to date.
