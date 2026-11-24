# @caveman-app/provider-caveman

The Caveman engine as an engine adapter, the same shape 
packages (`packages/provider-pi` @ `ab3a3cd1` is the structural reference; the
Caveman engine is built on Pi). It implements `@caveman-app/engine-core`'s
`ProviderAdapterV2` and `ProviderDriver`, so the runtime registers it beside
Claude Agent and Codex.

| Export | What |
|---|---|
| `./server` | `CavemanDriver`, `CavemanAdapterV2Driver`, `CAVEMAN_PROVIDER` (`caveman`), `setCavemanKey` / `readCavemanKeys` for Settings |
| `./client` | `cavemanClient`: label "Caveman", settings schema, the app's pixel caveman as the icon |
| `./settings` | `CavemanSettings` (`enabled`, `customModels`; `optimization` is kept so older settings still parse, and does nothing) |

## The engine

Every Caveman chat runs on **the Caveman harness** (`@caveman-ai/harness`,
`src/server/harness.ts`), the loop and surfaces measured against Claude Code
and Codex: coding chats on this computer (macOS, Linux, and Windows through
Git Bash) and on a Cloud computer (tools in its tools container, streamed
over the runtime's exec channel by `src/server/toolsEnv.ts`), the Chief,
`agent exec`, text generation and the side requests. The classic engine (the
SDK's own coding agent loop) is gone; `@caveman-ai/agent` stays only as a
library for the plugin and skill loader, the Cloud tools container's execution
backend contract, and reading a classic journal (a chat from before continues
on the harness).

- **In process.** No child process. A thread is one `HarnessSession`, kept
  across turns: its exec cells, background commands and cache keep-alive live
  with it (a rollback, fork, resume or a new MCP credential starts a new one).
- **Surfaces per model** (`appLoadoutFor`): a GPT model on a Responses API
 (OpenAI's, or compact through a sign-in) gets Codex's exec surface word for
  word (`exec` cells calling `exec_command`, `apply_patch`, `view_image`;
  `wait`). Every other model gets the compact surface: `read`, `bash`, `wait`,
  `edit`, `write`, plus a `program` tool whenever the thread has MCP tools.
  Prompts are v4's (2.7k tokens on Claude), with `app.identity` in place of the
  benchmark's "nobody will answer questions", then the app's own text (UI
  proof, the runtime's blocks, the repository's instructions, SessionStart
  hooks, the skills index).
- **The Chief** runs on the general loadout (`appLoadouts().general`): no
  file, shell, program or MCP tools, only its own (declared, full access, never
  asking), and `chiefInstructions(profile)` as its whole system text, so two
  Chiefs with the same rules send byte-identical prefixes.
- **Where tools run.** On this computer, `LocalEnv`: each command in its own
  process group (on Windows its own process tree, killed with `taskkill /T`, in
  Git for Windows' bash, which the model is told), an allowlisted environment
  plus the workspace's variables and secrets, never the runtime's. On a Cloud
  computer, `BackendEnv` (`src/server/backendEnv.ts`): every command and file
  read or write goes through the runtime's execution backend into the tools
  container, never beside the runtime's Cloud key; a command left running is
  reached by handle like a local one, its output arriving when it ends.
- **MCP through programs.** The runtime's own server, the Space and plugin
  servers (through the runtime's MCP hub; a Space's stdio server on a Cloud
  computer through the tools launch) are connected when the session starts, so
  their tool list is part of the cached prefix. A program calls them as
  `tools.<server>__<tool>(args)` (one line per tool in its description) and
  only what it prints reaches the model; on the exec surface they are Codex's
  deferred `tools.mcp__<server>__<tool>`. A program has 2,000 calls, 16 at once
  and 300 s. The runtime's tools that wait on a person or another agent, grill
  mode's, a setup chat's, web search and fetch, an agent file's custom tools,
  and the ones that answer with an image (`preview_snapshot`, `computer`) are
  declared beside the surface.
- **Every call asks the same way.** A direct call, and each call a program or an
  exec cell makes, goes through the access mode's approval (approvals.ts, under
  the names the app has always used: `write`/`edit`/`apply_patch` are file
  changes, `bash`/`exec_command` commands, MCP tools outside tools), then
  trusted plugins' PreToolUse hooks; a refusal reaches the model as the call's
  result. A program's calls show as items of their own (a command, a file
  change per patched file, an MCP tool). PostToolUse hooks add their note to
  the result; UserPromptSubmit, SessionStart and Stop hooks run as Claude Code
  runs them.
- **Workspace rules** (`WorkspaceEnv`): the file tools read and write inside the
  workspace (reads anywhere on a full-access turn on this computer), refuse
  hidden paths, and reach memory's copy as the one directory outside it (read
  and written by the runtime, even on a Cloud computer), each write handed to
  the runtime.
- **On a Cloud computer** (`ToolsEnv`, `toolsEnv.ts`): every command and every
  file read, write, stat and listing runs in the tools container as its uid,
  over the runtime's exec channel (`CavemanToolsStreamRef`, set from
  `cloudLink/tools.ts` `toolsStream`), never beside the runtime's Cloud key.
  Each command is a channel request of its own, so it gets its own process
  group: past its yield it keeps running under a handle, its output arrives as
  it is written, and kill, a timeout or Stop ends the group. Closing the session
  ends what its commands left running (each carries `HARNESS_PROC`) and its
  scratch directory. Memory's copy stays on the runtime's own disk. A Space's
  stdio MCP servers start in tools. Without the exec channel the env is
  `BackendEnv` over the execution backend (above).
- **The journal.** Each engine run leaves its conversation at
  `<stateDir>/caveman/harness/<runId>.json` (written whole, digest-checked on
  read); the provider turn names the run, so resume, rollback, fork and a move
  to another computer read it (a move carries it as one journal line, packed
  against the copy before). A head the classic engine journaled
  (`<stateDir>/caveman/journal/`) still reads, its tool calls as text.
- **Steering and Stop.** A steer joins the running session before its next model
  call; one that lands after the last call starts one more session turn inside
  the same provider turn. Stop aborts the model call and the tools.
- **Compaction** at 80% of the model's window: the conversation so far becomes
  one summary, asked of the same model on the same prefix (a cache read), and
  the work goes on from it, inside a long turn too. The chat says so.
- **Cache keep-alive.** On Claude the session re-sends the last request with
  `max_tokens: 0` when none starts within 270 s, through long commands and
  while the person reads, at most 12 times a gap; pings between turns are
  billed to the next turn.
- **Policy**: v4's bounded autonomy (a repeated call nudged at 3 and stopped at
  6, three empty answers stop, three output-cap continuations), transient
  provider errors retried with the same request. A stop says why in the chat.
- **Keys.** API keys live in the runtime's secret store
  (`ProviderHost.credentials("caveman", instanceId)`). The engine sees them
  through a pi-ai `Models` whose credential store holds only those keys and
  whose ambient context is empty: an `OPENAI_API_KEY` in the runtime's
  environment, `~/.pi`, `~/.claude` and `~/.codex` are never read. A model
  whose provider has no stored key is refused before the engine runs. No
  claude.ai login exists for this engine. Every model's base URL goes through
  the egress scrub; a project with secrets needs it running.
- **Models and effort.** `auto` takes the first stored key in the engine's
  order and that provider's current default; with Caveman Cloud's Auto, Cloud
  picks each ask's model and effort among the connected ones. A reasoning
  model offers the catalog's levels under the composer's effort control, with
  what an untouched turn runs at marked as the default
  (`engineConfig.defaultEffort`).
- **Usage.** Token usage goes on `ProviderTurn.tokenUsage` and the turn's spend
  (the Session Protocol's usage event), keep-alive pings and compaction
  summaries included, priced from the catalog; calls on a subscription plan are
  the plan's, unpriced. Nothing here renders spend.
- **Measured in the app** (connector suite, 32 tasks, same hours, k=1,
  `bench/connector-runner.ts`, against the classic engine before it was
  removed): Opus 5.5 high passed 31/32 at $0.132 a task against 27/32 at
  $0.212; Sol high 32/32 at $0.070 against 28/32 at $0.087. Over three long
  working sessions (48 steps): Opus 48/48 against 44/48 at 0.47x the cost and
  half the wall time; Sol 48/48 against 47/48 at 0.75x.

Capabilities are set to what the engine does (`CavemanProviderCapabilitiesV2`
in `src/server/adapter.ts`). Approvals use Claude Agent's cards: the engine's
tool policy (`src/server/approvals.ts`) asks before edits and commands under
`approval-required`, before commands and outside tools under
`auto-accept-edits`, and never under `full-access`; reads never ask. A card
waits an hour, then denies; Stop cancels it; a card for a program's call ends
with that call. A message sent behind a running turn is queued by the
orchestrator, as for Claude Agent and Codex. Not offered: plans/todos and
structured questions.

## Engine provenance

Built from the pinned read-only clones, packed with `npm pack`, consumed
through `file:` tarballs in `vendor/` (root `pnpm-workspace.yaml` overrides
point `@caveman-ai/agent`'s own dependencies at the sibling tarballs).

| Tarball | Source | sha256 |
|---|---|---|

Harness packed at `6881359`, over `556459a`: `SandboxEnv`, a coding agent's
tools on a Caveman sandbox through the public sandbox API
(`@caveman-ai/sdk/sandboxes`, packed from Caveman Cloud `3fd5845f7`), made at
the first tool call that needs one with no shape, or the session's attached,
the session's repository cloned from the git URL Cloud gives, the build's files
written into one it made, a build's secrets in each command's environment only (`agent exec --sandbox-file`, Cloud's tier linux); the program tool with no sandbox (`app-code`, Cloud's code tier); no
third-party sandbox env. `556459a` brought `LocalEnv` on Windows, `app-general` and stdio MCP
servers on the allowlisted environment.

`@caveman-ai/agent` is used only as a library now: `/plugins` (the skill
loader and index), `/durable` (reading a classic journal),
`/execution-backend` (the Cloud tools container's contract, a type) and
`/testing` (scripted models in tests).

To bump the harness: `node scripts/pack-lib.mjs <dir> <commit>` in
`caveman-agent-sdk/packages/harness`, replace the tarball, update the name
here and in `package.json`, run `pnpm install`, then the tests.

## Benchmark

`bench/connector-runner.ts` runs the engine as an app thread builds it on the
harness connector suite (one task, or a long session with `--messages-file`):
tools on this host, in the suite's no-network container through the harness's
`DockerEnv` (`--exec docker:`), or there through `BackendEnv` over an
execution backend (`--exec backend:`), a Cloud computer's path.

## Tests

- `adapter.test.ts`: the adapter end to end with only the model scripted (and
  the real pi-ai transport against local stand-ins where a wire matters):
  items and streaming, the journal, resume, rollback and fork, steering, Stop
  and a Stop that cancels a start, approvals (a program's calls too), plugin
  hooks, env and secrets behind the egress scrub, hidden paths and reads
  outside the workspace, instruction sections and a cache-stable prefix, the
  runtime's and a Space's MCP from one program, skills, attachments, retries
  and rate limits, Auto, usage (priced, unpriced, plan, partial), effort, the
  Claude keep-alive ping and its billing, compaction, grill mode, web and
  image tools, keys only from the store, a Cloud computer through the SDK's
  real local execution backend, Codex's exec surface, a classic-journaled
  thread continued, a move's checkpoint between state dirs, the Chief, and a
  Cloud computer's thread with its commands and files streamed to the tools
  side (`ToolsEnv`).
- `backendEnv.test.ts`: `BackendEnv` on the SDK's real local backend and its
  HTTP backend (exec, timeouts, background, poll, wait, kill, ranges, nested
  writes, stat, listDir with odd names), and a `HarnessSession` turn through it.
- `execSession.test.ts`: `agent exec`'s session on the harness (both shapes,
  approvals, custom tools, steering, Stop, the exec surface).
- `investigation*.test.ts`, `sideText.test.ts`, `rewriter.test.ts`,
  `driver.test.ts`, `levers.test.ts`, `engineConfig.test.ts`, `autoRouter.test.ts`:
  text generation and its tools, side requests, what the harness does in a
  session (checked against the loadouts), effort, Auto.
- runtime `cloudLink/tools.test.ts`: `ToolsEnv` against a real tools channel
  (`toolsExec.mjs serve`): a command's env, cwd and exit code, a yielded handle
  with its output so far, wait, kill, timeout, Stop, and every file call; on
  Linux, closing the env ends what its commands left running.
- `CAVEMAN_LIVE_ENGINE=1 CAVEMAN_LIVE_OPENAI_KEY_FILE=<file>`: one paid turn
  on `openai/gpt-5-nano` (override with `CAVEMAN_LIVE_MODEL`) through the
  production path. `CAVEMAN_LIVE_OUT=<file>` keeps its summary.
