# Caveman Code

Give Claude and Codex the same repo and let them try different fixes in separate Git worktrees. Review the two diffs side by side. If a turn goes sideways, restore the chat's Git checkpoint.

Caveman Code is a Mac app with a terminal client. Use your existing subscriptions or API keys for local work; Caveman Code doesn't charge for that. Cloud computers are optional.

[Download for Mac](https://caveman.so/download) · [Build from source](#build-from-source)

## Get started on a Mac

The download runs on Apple silicon and Intel, on macOS 13.5 or later. Pick Stable or Nightly under Settings → General.

1. Open a local Git repository in Caveman Code.
2. In Settings → Models & keys, connect an agent or add a provider key. Supported engines can reuse an existing CLI sign-in.
3. Start a chat in a worktree. Start another chat in a different worktree to try a second approach without touching the first chat's working files.

Pick an engine per chat: Claude Agent, Codex, Cursor, OpenCode, Pi, Grok, Muse Code, Antigravity, an ACP agent, or [Caveman Harness](https://github.com/caveman-ai/agent-sdk). The app puts tool calls and changes in the transcript. For a split view, drag a second chat onto one side of the open pane.

Approval options depend on the engine. Where supported, you can require approval before tools run, let the agent apply edits while holding other actions for review, or give it full access. Git checkpoints let you rewind repo changes; they can't take back a tool call that already changed something outside the repo.

## Continue in the terminal

Install the command line tool under Settings → General. It connects to the same runtime as the app, so both clients see your session history. Start a chat in the app before running these commands:

```bash
caveman-code
caveman-code attach
```

The first command opens the app and connects to the runtime. `attach` follows your most recently updated session as plain text; pass a session ID to follow another. Each line you type sends a turn. The separate `@caveman-ai/code` npm package isn't published yet.

## Keep a job running after you close the lid

Run the chat on a [Cloud computer](./docs/cloud-computers.mdx) when a build or test suite needs to outlast your laptop. It runs in a Firecracker VM. Caveman Cloud handles provider and GitHub credentials outside the VM and restricts Git pushes to `caveman/*` branches.

The [phone app prototype](./apps/mobile/README.md) can follow your chats, send a message or stop a run after you sign in. A Mac asks you to approve the phone before it can open chats on that Mac.

## Give agents your tools

Review pull requests and diffs from GitHub, GitLab, Bitbucket, Azure DevOps or Forgejo. Use the [plugin catalog](./catalog/README.md) or add an MCP server of your own. By default, local stdio MCP servers get a small system environment plus the variables you set for that server.

Save this file in a project's `.caveman/local/automations/digest.yaml` for a weekday digest. Local automations stay out of Git. Shared automations belong in `.caveman/automations/` and use the default branch's copy when they trigger.

```yaml
on:
  schedule:
    at: "09:00"
    timezone: Europe/Amsterdam
    weekdays: [mon, tue, wed, thu, fri]
steps:
  digest:
    prompt: Summarize yesterday's merged PRs and flag anything risky.
    model: fast
```

See the [automation guide](./packages/automations/README.md) for a reviewer that updates one comment on every push and an automation that takes an issue through to a draft PR.

## Build from source

Use Node 24.15 or later, pnpm 10.14.0 and Git.

```bash
git clone https://github.com/caveman-ai/caveman-code.git
cd caveman-code
pnpm install --frozen-lockfile
pnpm --filter @caveman-app/desktop dev
```

The last command builds the web client and opens Electron with the runtime from your checkout. The repo also includes a Windows desktop target; the public download is for macOS.

See [Contributing](./CONTRIBUTING.md) for checks and [Security](./SECURITY.md) for private reports. Caveman Code is [Apache-2.0](./LICENSE). Some modules come from T3 Code (MIT); see [NOTICE](./NOTICE) and the [third-party notices](./THIRD_PARTY_NOTICES.md).
