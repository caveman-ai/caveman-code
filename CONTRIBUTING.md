# Contributing to Caveman Code

Thank you for contributing to `caveman-ai/caveman-code`. Read
[`AGENTS.md`](AGENTS.md) for layout and architecture rules before opening a
pull request.

## Prerequisites

- Node.js 24.15+
- pnpm 10+

## Development & checks

```bash
pnpm install
pnpm --filter @caveman-app/desktop dev   # desktop + local runtime
pnpm typecheck
pnpm test
pnpm lint
node scripts/verify-clean-room.mjs
```

## Guidelines

- Keep all changes clean-room (`node scripts/verify-clean-room.mjs` must pass).
- Preserve `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md` attributions.
- Add or update Vitest coverage alongside behavioral changes.
- Use scoped conventional commits (`feat(web): ...`, `fix(runtime): ...`).
- Report security vulnerabilities privately per [`SECURITY.md`](SECURITY.md).
