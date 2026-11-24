# Caveman Code CLI (`@caveman-ai/code`)

Terminal interface (`caveman-code`) that drives the same local daemon
(`packages/runtime`), workspaces, git worktrees, MCP servers, and session
journal as the Caveman Code desktop app.

## Install & run

```bash
npm install -g @caveman-ai/code
caveman-code --help
caveman-code chat
```

Entrypoint: `bin/caveman-code.mjs`. Ships `LICENSE`, `NOTICE`, and
`THIRD_PARTY_NOTICES.md` inside the published npm package.
