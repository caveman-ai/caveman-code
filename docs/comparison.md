---
title: Caveman Code features
description: What Caveman Code ships, and how its formats line up with Claude Code.
---

# Caveman Code features

What Caveman Code ships as of the August 2026 freeze.

<CopyForLlms />

## Capabilities

| Capability | Caveman Code |
|---|---|
| Token compression (3-layer Caveman Mode) | yes |
| 20+ providers, OAuth for ChatGPT / Copilot / Gemini | yes |
| Session branching + fork | yes |
| Native MCP | yes |
| Native sandbox | yes |
| Plan mode | yes |
| Repo map (PageRank) | yes |
| Edit-format-per-model | yes |
| Worktree-isolated subagents | yes |
| Daemon / multi-client | yes |
| Shadow-git checkpoints + `/rollback N` | yes |
| Containerized parallel sessions | yes |
| Cost transparency (per-msg $) | yes |
| MIT open source | yes |

## Format compatibility

Caveman Code is a **superset** of Claude Code's authoring formats. Concretely, you can paste these directly into `~/.cave/`:

- `~/.claude/settings.json` → `~/.cave/settings.json` (hooks, permissions, statusLine identical schema)
- `~/.claude/commands/*.md` → `~/.cave/commands/*.md`
- `~/.claude/skills/<name>/SKILL.md` → `~/.cave/skills/<name>/SKILL.md`
- `~/.claude/agents/<name>.md` → `~/.cave/agents/<name>.md`
- `.mcp.json` (Codex / Claude Code standard) is read at the project root

See [migration from Claude Code](/migration/from-claude-code) for the step-by-step.

## Caveat — these comparisons evolve

Claude Code, Codex, Crush, and opencode all iterate weekly. We pin our compatibility target to **Claude Code v2.1.119 schemas** with a CI delta check; tracking the others is best-effort. If you spot drift, [open an issue](https://github.com/JuliusBrussee/caveman-cli/issues/new?labels=docs).
