# Caveman Code (`caveman-ai/caveman-code`)

Desktop, CLI, Web, and Mobile coding agent built on [Caveman Agents](https://github.com/caveman-ai/agent-sdk) (`@caveman-ai/harness`). Run multiple agents in parallel on your laptop or hand sessions off to persistent Firecracker computers on Caveman Cloud.

Looking for something else in Caveman?

| If you want to... | Use |
|---|---|
| Build custom agents in TypeScript or embed Harness v4 | [caveman-ai/agent-sdk](https://github.com/caveman-ai/agent-sdk) |
| Manage Caveman Cloud, Sandboxes, or call the API from TS/Python/Go | [caveman-ai/cloud-sdk](https://github.com/caveman-ai/cloud-sdk) |
| Compress prompts and tool outputs for Claude Code, Codex, or Cursor | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) |

## Quickstart

### CLI

```bash
npm install -g @caveman-ai/code
caveman-code --help
caveman-code chat
```

### Run from source

```bash
pnpm install
pnpm --filter @caveman-app/desktop dev
```

## Repository layout

| Path | What it is |
|---|---|
| `apps/desktop/` | Electron desktop app (macOS, Linux, Windows) bundling the local runtime. |
| `apps/cli/` | `@caveman-ai/code` (`caveman-code` CLI) sharing the exact same local runtime, workspaces, auth, and session journal as Desktop. |
| `apps/web/` | Vite React web client. |
| `apps/mobile/` | Expo mobile client for monitoring and steering active sessions. |
| `packages/runtime/` | Local daemon per computer: event log, projections, git worktrees, checkpoints, MCP host, and Cloud sync. |
| `packages/provider-caveman/` | Caveman engine adapter wired directly to `@caveman-ai/harness` (Harness v4). |
| `packages/provider-*/` | First-class adapters for Claude Agent, Codex, Cursor, OpenCode, Pi, and ACP agents. |
| `packages/session-protocol/` | Structured transcript and client-to-runtime contract. |
| `packages/source-control-*/` | GitHub, GitLab, Bitbucket, Azure DevOps, and Forgejo PR/diff integrations. |
| `docs/` | User documentation synced to `docs.caveman.so/code`. |

## Why Desktop and CLI live in one repo

Desktop and `caveman-code` drive the exact same local daemon (`packages/runtime`). Workspaces, git worktrees, approval rules, MCP servers, and session journals stay in sync so you can start a task in the terminal and inspect diffs or approvals in Desktop without switching tools.

## Documentation

- [Overview](./docs/index.mdx)
- [Desktop App](./docs/desktop.mdx)
- [CLI & Local Daemon](./docs/cli.mdx)
- [Cloud Computers](./docs/cloud-computers.mdx)
- [MCP Servers & Plugins](./docs/mcp-plugins.mdx)
- [Architecture](./docs/architecture.mdx)

## Attribution & License

Built on [`@caveman-ai/harness`](https://github.com/caveman-ai/agent-sdk) with modules ported from T3 Code (MIT). See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for complete notices.
