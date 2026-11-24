# Caveman Code Runtime (`packages/runtime`)

Per-computer local daemon shared by Desktop, CLI, Web, and Mobile clients.
Owns the session event log, projections, git worktree management, hidden-ref
checkpoints, engine adapter orchestration, MCP host, and Cloud sync.

## Commands

```bash
pnpm --filter @caveman-app/runtime test
pnpm --filter @caveman-app/runtime typecheck
```

Wire contract with clients: [`packages/session-protocol/README.md`](../session-protocol/README.md).
