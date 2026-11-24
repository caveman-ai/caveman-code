# Caveman Code Web (`apps/web`)

Vite React single-page web client for Caveman Code. Talks to `packages/runtime`
over the Session Protocol (`packages/session-protocol`) and is bundled into
`apps/desktop` for local Electron distribution.

## Commands

```bash
pnpm --filter @caveman-app/web dev
pnpm --filter @caveman-app/web build
pnpm --filter @caveman-app/web test
```
