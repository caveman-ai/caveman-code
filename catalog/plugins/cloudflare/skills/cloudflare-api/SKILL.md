---
name: cloudflare-api
description: Work with any Cloudflare product (Workers, DNS, R2, KV, D1, Pages, zones) through the Cloudflare API server by searching for the right endpoint, then reading or changing it with confirmation. Use for questions about or changes to a Cloudflare account.
---

# Use the Cloudflare API

The server exposes the whole Cloudflare API through two steps: search for the operation, then execute it.

1. Confirm the account and zone. If the repository has a Wrangler config (`wrangler.toml` or `wrangler.jsonc`), take names and IDs from it.
2. Search for the operation before calling it; do not guess endpoint paths.
3. Read before writing: fetch the current state (records, routes, bindings) and show it.
4. For a change, show the exact request and what it will change. Execute only after the user agrees.
5. If the project deploys with Wrangler, prefer changing the config and deploying over editing live resources, so the repository stays the source of truth.
