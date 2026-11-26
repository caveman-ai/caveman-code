# Caveman Code (`caveman-ai/caveman-code`)

Public Apache-2.0 repository for Caveman Code: Desktop (Electron), CLI
(`@caveman-ai/code`), Web, and Mobile coding agent built on
[`@caveman-ai/harness`](https://github.com/caveman-ai/agent-sdk).

`CLAUDE.md` is a symlink to this file.

## Layout

| Path | Role |
|---|---|
| `apps/desktop/` | Electron desktop shell bundling the local runtime ([README](apps/desktop/README.md)) |
| `apps/cli/` | `@caveman-ai/code` (`caveman-code` CLI) sharing the local runtime ([README](apps/cli/README.md)) |
| `apps/web/` | Vite React web client ([README](apps/web/README.md)) |
| `apps/mobile/` | Expo mobile client ([README](apps/mobile/README.md)) |
| `packages/runtime/` | Per-computer local daemon: event log, projections, git worktrees, checkpoints, MCP host ([README](packages/runtime/README.md)) |
| `packages/provider-caveman/` | Caveman engine adapter wired to `@caveman-ai/harness` ([README](packages/provider-caveman/README.md)) |
| `packages/provider-*/` | Adapters for Claude Agent, Codex, Cursor, Grok, Muse, OpenCode, Pi, and ACP agents |
| `packages/session-protocol/` | Structured transcript and client-to-runtime contract ([README](packages/session-protocol/README.md)) |
| `packages/automations/` | `AGENT.md` / automation file parser and runner ([README](packages/automations/README.md)) |
| `packages/protocol/`, `packages/shared/`, `packages/engine-core/` | Core protocol types, shared helpers, and engine primitives |
| `packages/source-control-*/` | GitHub, GitLab, Bitbucket, Azure DevOps, and Forgejo integrations |
| `packages/ui/` | Component kit and style guide (`STYLE.md`, [README](packages/ui/README.md)) |
| `catalog/` | Curated plugin marketplace ([README](catalog/README.md)) |
| `docs/` | Public user documentation aggregated into `docs.caveman.so/code` |
| `scripts/` | Verification (`verify-clean-room.mjs`), preview, and release scripts |

## Checks

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
node scripts/verify-clean-room.mjs
```

## Rules

- **Public clean-room repository.** Never add private repository names, internal strategy/design memos, local machine paths, credentials, or vendored private tarballs. `node scripts/verify-clean-room.mjs` enforces this boundary and must pass before every commit.
- **Depend on published packages.** Keep `@caveman-ai/*` dependencies pinned to published npm versions (no `file:` or `vendor/` overrides).
- **Attribution.** Modules ported from T3 Code (MIT) and other third-party notices are documented in [`NOTICE`](NOTICE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Keep `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md` intact in source and release bundles.
- **Scoped conventional commits** (`feat(runtime): ...`, `fix(cli): ...`, `docs(repo): ...`).

## Workflow

- Work in a clean branch or worktree off `origin/main`; never commit or push directly to `main`.
- Stage explicit paths (`git commit --only -- <paths>`), never `git add -A`.
- Run `node scripts/verify-clean-room.mjs` and the checks above before pushing.
- Open a pull request against `main` and squash-merge once CI (`Check`) is green.
