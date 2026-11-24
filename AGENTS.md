# Caveman Code (`caveman-ai/caveman-code`)

Desktop (Electron), CLI (`@caveman-ai/code`), Web, and Mobile coding agent built on `@caveman-ai/harness` (`caveman-ai/agent-sdk`).

## Layout

| Path | Role |
|---|---|
| `apps/desktop/` | Electron desktop app bundling the local runtime |
| `apps/cli/` | `@caveman-ai/code` (`caveman-code` CLI) sharing the local runtime |
| `apps/web/` | Vite React web client |
| `apps/mobile/` | Expo mobile client |
| `packages/runtime/` | Per-computer local daemon: event log, projections, git worktrees, checkpoints, MCP host |
| `packages/provider-caveman/` | Caveman engine adapter wired to `@caveman-ai/harness` |
| `packages/provider-*/` | Adapters for Claude Agent, Codex, Cursor, OpenCode, Pi, and ACP agents |
| `packages/session-protocol/` | Structured transcript and client-to-runtime contract |
| `docs/` | Public user documentation (`docs.caveman.so/code`) |

## Checks

```bash
pnpm install
pnpm typecheck
pnpm test
node scripts/verify-clean-room.mjs
```

## Attribution

Modules ported from T3 Code (MIT) are documented in `THIRD_PARTY_NOTICES.md`. Keep `THIRD_PARTY_NOTICES.md` intact.
