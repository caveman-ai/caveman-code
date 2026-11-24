---
name: debug-worker
description: Debug a Cloudflare Worker or a hostname that misbehaves by checking DNS records, routes, the Worker's deployed version, bindings and logs. Use when a Cloudflare-hosted route errors, does not resolve, or serves stale code.
---

# Debug a Worker or hostname

1. Resolve the chain: DNS record, proxy status, route or custom domain, then the Worker that serves it.
2. Compare the deployed version with the code in this repository (`wrangler.toml` or `wrangler.jsonc` name, last deployment).
3. Check the bindings the code expects (KV, R2, D1, secrets by name) exist on the deployed Worker.
4. Read recent logs or errors for the failing route.
5. Report the broken link in the chain and the fix. Change DNS or routes only with the user's go-ahead.
