# Session Protocol v1

`@caveman-app/session-protocol` is the wire contract between Caveman Code
clients (web app, desktop app, `caveman code`, Cloud's relay) and the runtime
that runs on each computer. Its only dependency is `effect`.

- `src/protocol.ts` has the Effect schemas and the TypeScript types they
  produce: resources, the method table, events, notifications, errors.
- `src/client.ts` is a small client for browsers and Node 22.
- `schema/session-protocol.v1.json` is the JSON Schema for non-TypeScript
  consumers (the Go relay tests). Regenerate it with `pnpm schema`; a test
  fails when the committed file is stale.

## Transport

JSON-RPC 2.0 over one WebSocket. Each text frame holds one JSON object; batch
arrays are not supported. All keys are snake_case. Clients send requests,
the runtime answers each one, and it pushes notifications (requests without
an `id`). The runtime never sends requests to the client: anything that needs
a person, such as an approval, arrives as an event and is answered with a
method call.

The JSON-RPC `id` only matches a reply to a request on one connection. The
`request_id` in params is the idempotency key, and it stays the same across
connections.

## Auth (the runtime implements this)

- The client sends a bearer token on the upgrade request, never in the URL.
  Clients that can set headers (Node, Go, the relay) send
  `Authorization: Bearer <token>`. Browsers cannot, so they offer two
  subprotocols: `caveman.session.v1` and `base64url.bearer.<token>` (the
  token in unpadded base64url). The runtime and relay read the token from
  the second and select `caveman.session.v1` in the response; a browser
  fails a handshake that offered subprotocols when none is selected.
- A bad token fails the upgrade with HTTP 401. A token that expires
  mid-connection makes later calls fail with `unauthorized`. Browsers and
  Node cannot read the status of a failed upgrade, so the bundled client
  takes a token function and calls it before every connection attempt.
- The runtime and relay never log the `Authorization` or
  `Sec-WebSocket-Protocol` headers, and redact a `token` query parameter
  from any URL they log.
- A local runtime listens on 127.0.0.1 only. At start it writes a random
  token (32 bytes, hex) to a file in its state directory with mode 0600, and
  the desktop app and `caveman code` read it from there.
- Remote clients connect through Cloud's relay with a relay token: short-lived
  and scoped to one user and one runtime. Runtimes never accept inbound
  connections from the internet.
- Tenant scope comes from the verified token and never from params. An id
  outside the token's scope returns `not_found`.
- A runtime has one owner: the clients on its own computer and, through the
  relay, the Cloud user its enrollment names. A Mac that names its owner
  takes only their devices: another person's device is refused at its
  `device.hello` ("<This Mac> takes only its owner's devices."), before any
  question on the Mac's screen, as Caveman Cloud lets a person attach only to
  computers of their own. Anyone else the relay does bring (another member of
  the org on a Cloud computer, which has no device check; a device allowed on
  a Mac whose sign-in names nobody, one from before Cloud named the person)
  drives chats, and is `forbidden` wherever a method holds, changes
  or returns the owner's keys and sign-ins, changes what runs with them, or
  writes what is the owner's own: `secret.*`, `web.keys.*`,
  `engine.account.*`, `account.*`, `chief.*`, `rule.*`, and the methods the
  runtime's `session-protocol/ownerGate.ts` names. Those are `credential.*`,
  `secret_provider.*`, `secret_slot.set`, `mcp.*`, marketplaces, plugin
  installs and sign-ins, connectors, imports, automations; `cloud.enroll`,
  `cloud.signin` and `cloud.signout`, since an enrollment names the owner;
  `skill.save`, `skill.record` and `skill.read`, `memory.*`, every project
  write with `project.discover`, `project.logo.candidates` and `repo.list`,
  `setup.scan`, `settings.set` (any key), `keybindings.set`,
  `spend.summary`, the owner's Cloud
  computers (`cloud.computers`, `cloud.computer.*`, `cloud.workspace.create`,
  `environment.warm`), a chat's moves (`session.move`, `session.move.check`,
  `session.move.held`, `session.adopt`: where a chat runs is the owner's to
  say), and what Caveman Cloud or GitHub answers the owner's sign-in
  (`automation.cloud_list`, `automation.cloud_runs`, `agent.published`,
  `github.status`, `github.issues`, and the reads of a repository's Cloud
  setup: `environment.get`, `.draft`, `.list`, `.versions`, `.proposals`,
  `.ci`, `.build.get`, `.build.log`). `workspace.create` is theirs in a
  project the owner already has: in a folder that is not one, or for a
  repository that would have to be cloned, it would add to the owner's list
  and is `forbidden`. The reads the chat screen makes stay open to
  them: `plugin.list`, `skill.list`, `project.list`, `project.logo.read`,
  `project.branches`, `settings.get`, `keybindings.get`, and `cloud.status`, which leaves a
  sign-in in progress out of their answer and of their `cloud.changed`; so
  does what a chat they drive is made of (`workspace.*`, `session.fork`,
  `park` and `resume`, its `git.*` and `pr.*`, its files and terminals). A
  client that writes a setting for another person's runtime is refused, so it
  says nothing when a pick in the composer does not stick. One answer in a
  chat writes a setting too, and is the owner's alone: `ask.respond` with an
  app's Always allow (computer use), kept for every later chat on that Mac;
  Allow in this chat and Deny are anyone's who drives the chat. An outside
  agent's calls are its own gate's to pass (`outside_agent.*`), not this
  one's.
- A Cloud computer's owner is the person who asked for it, whom its
  enrollment names. One nobody asked for (a service account's, an
  automation's) names no person and has no owner among people: its sessions
  come as mail, and the calls Caveman Cloud queues for a chat (`turn.submit`,
  `turn.interrupt`, `ask.respond`) reach their handlers as the chat's person
  (an app's Always allow is asked on a Mac only).

## Idempotency

Every mutating method (one that changes state that outlives the connection)
takes a client-generated `request_id`, for example `crypto.randomUUID()`.
Reuse that id when you retry the same operation.

- Same `request_id` and same params: the runtime returns the original result,
  even if state has changed since. If the first call is still running, the
  retry waits for it.
- Same `request_id` and different params: `request_id_conflict`.
- Replay records are keyed by (verified principal, method, `request_id`).
  Auth and scope checks run before the replay lookup, so one principal can
  never replay another's `request_id` or read its result.
- The runtime stores a hash of the canonical params, never the params, plus
  the result. It remembers request ids for at least 24 hours, except
  `term.write`, `term.resize`, `browser.input` and `computer.input`, which
  it keeps for 10 minutes: keystrokes (a password typed at a sudo prompt)
  are not worth a day of retention.
- `browser.control` and `computer.control` keep no record: control belongs
  to the connection that took it and goes back to the agent when that
  connection closes, so the call runs again wherever it is sent. One resent
  after a reconnect takes control on the new connection.
- `chief.voice.start` keeps no record either: a call belongs to the
  connection that started it and ends when that connection closes. One
  resent after a reconnect starts the call on the new connection.

These methods have no `request_id`. They are reads, or they only change what
this connection receives: `workspace.list/get`, `session.attach/detach`,
`fs.diff/read`, `media.read`, `git.status`, `browser.screencast/snapshot`, `mail.wait`,
`engine.list`, `settings.get`, `agent.types`, `setup.scan`, `plugin.list`, `plugin.read`, `marketplace.list`, `rule.list/read`, `import.scan`, `repo.list`, `project.list`, `project.discover`, `project.logo.candidates`, `project.logo.read`,
`message.caveman_version`, `spend.summary`, `chief.get`, `chief.items.list`,
`chief.change_sets.list`. Any call can be resent after a
reconnect, which is what the bundled client does.

## Resources

| Resource | What it is |
|---|---|
| `Workspace` | One task: repo (`{path}` or `{url}`), `base_ref`, `branch`, engine, computer, its one `session_id`, status (`starting`, `working`, `needs_input`, `waiting`, `idle`, `parked`, `archived`, `failed`). Builders carry `parent_workspace_id`. |
| `Session` | The workspace's durable conversation journal. Carries `engine_session_ref` (the engine's own id, used as evidence, never as identity), `state` (`live` or `parked`), `lease` (the computer allowed to write it), `head` (the newest cursor), `forked_from`, and `mode` (`default` or `grill`, absent = `default`; see Grill mode). |
| `EngineDescriptor` | One engine: `caveman`, `claude-agent` (labelled "Claude Agent"), `codex`, or `acp:<id>`. Lists capability flags, models with their efforts, auth (`signed_in`, `signed_out`, `api_key`, `unavailable`, or `checking` while the engine's first probe since the runtime started is still running) with account labels (never credentials), and a version with an upgrade hint. |
| `Computer` | Where files and processes live: `this_mac`, `caveman_cloud` or `pool`, plus its status. Cloud lists computers; the runtime only names its own. |
| `PluginInfo` | A Claude-compatible plugin: `id` (for calls and keys) and `name` (what people see), skills, commands, agents, hooks, MCP servers, `tools` (`PluginTool`: a tool one of its MCP servers offers, for the tool palette), `connectors` (`PluginConnector`: a service it reaches, with the credential names the broker supplies and which of them are `granted`, never values), `lsp_servers`, `monitors`, `containment` (`macos_sandbox`, `bubblewrap` or `env_filter`: how its processes are kept from the user's credential files and the runtime's state), `problems` (parts left out and why), and `panels` (`PanelContribution`: an https URL or a path the runtime serves from the plugin's directory, loaded in a sandboxed frame as a workspace tab or a settings page; see Plugin panels). |
| `Project` | A git repository on this computer that chats start in (the sidebar's folders): `id`, `name` (the folder's name unless renamed), `path` (the repository's top level, realpath), and `repository` (`RepositoryLink`: its origin on a git host, so the same repository matches on any computer). Every workspace made from a local repository carries its project's `project_id`. |
| `Settings` | A typed options document. `settings.set` takes a patch: each key present replaces that key, and absent keys are kept. |

## Methods

| Method | Semantics |
|---|---|
| `runtime.hello` | The client's first call on every connection: `{client_version, protocol_revision}`. Answers `{version, protocol_revision, min_client_revision, capabilities}` (Versioning). |
| `workspace.create` | Takes repo, plus optional base ref, branch, title, engine, computer, and `task` (submitted as the first turn). Missing choices come from Settings. |
| `workspace.prewarm` | Fire-and-forget from the New chat page: the runtime makes a worktree in that repository ahead (one per repository, two in all, dropped after ten minutes unused), and a `workspace.create` there takes it instead of running `git worktree add`. With `engine` and `options` as the page has them (send them again when they change), an engine that can (Claude Agent) also starts for that chat's first turn, so Send skips its start-up; a `workspace.create` on that engine is that chat. Answers `{}` at once; nothing lists it. |
| `workspace.list` / `.get` / `.archive` | Archived workspaces are hidden unless `include_archived` is set. |
| `session.attach(session_id, cursor)` | See Events. |
| `session.detach` | Stops this connection's events for that session. |
| `session.fork(at)` | Creates a new workspace and session that share events `1..at`, with the same cursors. `at` must be the cursor of a `turn.done`. Engines without `fork` return `unsupported`. Every event delivered on an attachment carries the attached session's `session_id`: the shared prefix is re-stamped with the fork's id on delivery. |
| `session.park` / `.resume` | Park stops at the next safe point, closes the turn as interrupted, flushes the journal and releases the lease (`session.parked`). Resume takes the lease on this runtime (`session.resumed`). Moves go through these two. |
| `turn.submit(kind, input, options)` | `steer` goes into the running turn now; an engine without `steer` interrupts and restarts with the input. `followup` becomes the next turn when the running one ends, ahead of the queue. `queue` goes to the back of the queue. With no running turn, every kind starts a turn. The result's `disposition` is `started`, `steered` or `queued`. `options` (engine, model, effort, access) apply from that turn on. A changed engine/model/login is a followup, never a steer into another provider's running turn. Here and in `workspace.create`, an `access` other than `full` on an engine without approvals (its `access_modes` is `["full"]`) answers `unsupported` with `data.capability` `approvals`; see Permissions. `input.attachments` (an image or a file, base64) go into the runtime's attachment store and on to the engine: an image as image content, a file by the path it is saved at; one an engine cannot take (an image that is not one, an empty file, more than 100, over 10 MB per image or 50 MB per file) is `invalid_params`. |
| `turn.interrupt` | Stop, as .done` and status `interrupted`; every agent it delegated (each a workspace under this one) stops too, keeping its transcript and diff. Inputs waiting behind it are kept and wait: the next `turn.submit` that is not `queue` starts its own turn and then lets them run. With no running turn, it stops the delegated agents still working. |
| `ask.respond(ask_id, response)` | Answers an `ask.user`. `ask_id` is that event's `item_id`. The first answer wins; later ones get `invalid_state`. |
| `fs.diff(from?, to?, paths?)` | Patches per file. `from` defaults to `base_ref` and `to` to the working tree; either one may be a git ref or a `checkpoint_id`. |
| `fs.read(path, ref?)` | `utf8` or `base64` content. `truncated` is set when the file is over the runtime's limit. |
| `media.read(path)` | An image a chat shows, most often an agent's proof screenshot (`![alt](/abs/shot.png)` in its reply), as base64 with its `mime_type`. The one read that takes a host path: absolute, `~/…`, or relative to the worktree. It returns image files only, recognized by their bytes (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO; SVG by its `.svg` name and `<svg` text), up to 16 MB; anything else is `invalid_params`, a missing file `not_found`. Clients read images through it, not through a URL, so they load the same through Cloud's relay. |
| Paths and refs | `fs.read.path`, `fs.write.path`, `editor.open.path`, `fs.diff.paths`, `git.commit.paths` and `term.open.cwd` are `WorkspacePath`s: relative to the workspace's worktree root, never absolute, never a `..` segment, never shell-expanded (`~` is a plain name). The runtime resolves the real path, symlinks included, and returns `invalid_params` for anything outside the worktree, so no call can read a file such as `~/.claude/.credentials.json`. `media.read` is the one exception: it takes any host path but answers only with bytes that are an image. `base_ref` and `branch` are `GitRef`s (no leading `-`, no `..`, no revision syntax); git commands get them after `--end-of-options`. `fs.diff.from/to` and `fs.read.ref` take a `GitRef` or a checkpoint id exactly as `checkpoint.created` carries it (`checkpoint:...`, colons included): the runtime looks the id up and hands git its ref, never the id, and an unknown one is `not_found`. |
| `git.status` / `.commit` / `.push` / `.pr` | `git.pr` opens a draft PR for the workspace branch. Pushes go through Cloud's git proxy when the computer is remote. |
| `term.open` / `.write` / `.resize` / `.close` | Terminals run commands (dev servers, tests). They are never an engine's UI. A terminal belongs to the workspace. `term.output` and `term.exit` go to the connection that opened it and to every connection attached to the workspace's session. After a reconnect, output arrives only through an attached session, so attach before opening a terminal you want to keep watching. v1 has no scrollback replay. |
| `browser.screencast(enabled)` | Starts or stops `browser.frame` notifications on this connection. The bundled client turns active screencasts back on after a reconnect. |
| `browser.snapshot` | Returns the URL, title, a screenshot, and `refs` (element refs as text). Answers `not_found` when the workspace has no browser tab yet. |
| `mail.task` / `.note` / `.ask` | `task` assigns or updates work. `note` informs without waking the receiver. `ask` wakes it. A reply (`reply_to`) to an `ask` always wakes the asker. Every `MailMessage` carries its `authority`: `human` (a person), `agent` (a peer session) or `system` (Caveman). Only `human` counts as a person's consent. |
| `mail.wait(after?)` | A pure read: it never consumes or marks mail, so a reply lost on a dropped connection is simply read again. Returns the messages to the caller's workspace that come after the message `after` (all of them without it), oldest first. Returns at once when one of them wakes; otherwise blocks until every listed child has finished, a waking message arrives, or `timeout_ms` passes. Pass the last id you have seen as `after` next time. |
| `mail.claim` / `.release` | Intent locks on paths before editing. Claim returns what it granted and the claims other workspaces hold. Locks are advisory and released when the workspace finishes. |
| `mail.handoff` | Passes the session to another engine, computer or person, with a brief. |
| `engine.list`, `settings.get` / `.set`, `plugin.list` | As named. An engine the runtime probed on an earlier run answers with that run's state (auth, version, models) until this run's probe ends; `auth.state: "checking"` only before its first probe ever. `engine.changed` (the `engine.list` shape) goes to every connection whenever that answer changes. `settings.subagent_*` are delegate_task's limits (depth, agents at once per chat, a token ceiling for everything delegated under one chat) and its default child model; the runtime enforces them and `settings.get` reports the values in force. |
| `workspace.rename(title)` | Renames the chat and its engine thread. An agent renaming its own thread renames the workspace too. |
| `workspace.topic(topic)` | Sets the chat's topic (`Workspace.topic`, null for none): the group it sits in when the sidebar shows chats by topic, which the title writer otherwise names, once. After that only the person changes it. |
| `agent.types(project_id?)` | Subagent types an engine's `delegate_task` can start by name: built-in `investigator`, `builder`, `reviewer`, Claude-compatible agent files in `~/.caveman/agents` and enabled Space plugins, and with `project_id` the project's `.caveman/agents` and `.claude/agents`. A type's `tools` are told to the agent, not enforced. |
| Delegated agents | A `delegate_task` child is a workspace of its own with `parent_workspace_id` set to the delegating one: its session, asks, spend and diff work like any chat's. The parent's `subagent.started` carries its `workspace_id`. |
| Native subagents | An engine's own subagent (Claude's Agent tool, Codex's collab agents) is never a workspace: its steps, text and result are events of its chat's session with `parent_item_id` set to its `subagent.started` item, and the chat's `Workspace.subagents` lists the latest 20 with their status and, once finished, `ended_at`. A finished message or subagent can end again on the same item when the engine corrects it (a summary replaced by the full result); clients replace what they showed. |
| `Workspace.activity` | What the chat's latest turn is at, folded by the runtime from its journal so a sidebar or inbox shows one status per chat without attaching its session: the open `ask` (its kind and the first line of its prompt, the latest when several wait; asks inside a native subagent count), `turn_started_at` while a turn runs, the latest turn's `last_outcome` and `turn_ended_at`, `awaiting` while the latest turn has ended but work that will wake the chat still runs (a delegated agent, background work its agent marked with `background_wait`, a pull request it watches until it merges: upstream pending background work that holds completion, folded from the thread's events; it never moves `updated_at`), the latest todo list's `todos` (completed and in all), `ready_to_build` from `grill.finished` until the next turn starts, and `last_reply`, the latest answer as plain text on one line (at most 280 characters, for the line under a sidebar row's title). Turn, todo, grill and reply fields read the chat's own events, never a subagent's. Empty keys are left out; a chat with nothing to say has no `activity`. A workspace journaled before the runtime folded it gets one as its next events land; `last_reply` is filled in once at start for chats answered before it existed. |
| `setup.scan(repo_path?)` | First run's "Bring my setup": the MCP servers and skills already set up for Claude Code (`~/.claude.json`, the repo's `.mcp.json`, `~/.claude/skills`) and Codex (`~/.codex/config.toml`, its `skills`), and the repo's `AGENTS.md` / `CLAUDE.md`, each with `loaded_by`: the engines that load it by themselves today (Codex reads `~/.codex` only on the user's own compact login; an API-key Codex runs in a managed home). Names, commands and URLs only: an MCP server's `env` lists variable names, and no value, header or auth file is read into the answer. A scan never clones. |
| `engine.account.add(engine, provider?, key?)` / `.remove(engine, account_id)` / `.activate(engine, account_id)` | Settings -> Engines. A key travels once, in `add`, and no call, event, log or receipt carries it back: accounts show labels only ("OpenAI API key ...4f2a"). Caveman engine: one key per `provider` (`anthropic`, `openai`, `google`) in the runtime's secret store; every key is in use at once (each pays for its provider's models), so `activate` is `invalid_params`. Codex: each account is an OpenAI API key that Codex itself signs in with, inside that account's own app-managed `CODEX_HOME` under the runtime's state dir; `remove` signs it out and deletes that home; `activate` picks the account new workspaces run on (a workspace keeps the account it started on). A compact login (the user's own `~/.codex`) is listed but never signed out by the app. Claude Agent: no key ever; the account is whatever the user's own `claude` is logged in as, and `add` returns `sign_in {command, message}` (run `claude` in a terminal and log in there). A blank `key` is `invalid_params`: `add` never removes. A connection the person made once (`add` with `everywhere`) is an account too, kept in Caveman Cloud: "Sign in once" below. At rest, keys are owner-only files under the runtime's state dir (the secret store, each Codex home's `auth.json`): plugins are denied that dir, but engine tool processes run as the same user and can read it. |
| `engine.scan` | Settings > Models & keys' "Add what's on this computer". Each harness nobody connected (Cursor, OpenCode, Muse, Grok, Pi, Antigravity) is turned on, probed, and kept where it is installed here and already signed in through its own CLI; the rest go back exactly as they were. Cursor counts only with a `~/.cursor` folder: its SDK ships with the app, so its probe always finds it. Claude Agent and Codex are always on and are probed afresh. Answers `engines: [{engine, found}]`, `found` one of `ready`, `signed_out` (here but signed out: `engine.account.add` signs it in), `not_found`. No credential is read; each engine's own probe says whether it is signed in. |
| `fs.list(workspace_id, path, ref?, include_ignored?)` | One directory for the Files tree: directories first, .gitignore respected unless asked; `truncated` when capped. |
| `fs.search(workspace_id, query, limit?)` | Fuzzy path search over tracked and untracked, non-ignored files (Search files, quick open). |
| `chat.search(query, limit?)` | Finds the chats where something was said or done (⌘K), archived ones and the Chief's included. Every message, answer, plan, question, subagent summary, tool call and title is its own passage in the runtime's SQLite (FTS5), kept current from the journal by rowid; a chat mostly about something else is still found at the one place it matters. The query reads as a question (filler words dropped, rare words weigh most, `set up`/`setup` alike, typos corrected and named in `corrected`) and is matched by words and by meaning on an on-device model (bge-small-en-v1.5, downloaded once from a pinned revision and checked by sha256; chats never leave the computer). Each chat comes with its best places (`passages`: kind, item_id to scroll to, text with `marks`, found by words, meaning or both). `indexing` while a first start or an upgrade rebuilds the index; `meaning` says whether matching by meaning is ready, preparing or unavailable. |
| `chat.find(query)` | Asks a fast, cheap model which chat the person means (⌘K's Ask), only when they ask. chat.search's best 20 chats with their best two places, and the 24 most recent of the rest by title, go to the first writer the review guides would use (`rankReviewGuideWriters`: a subscription before a key, the cheapest guide model first; else the writer for titles), with today's date for "yesterday" and "last week"; a writer that fails falls to the next (three at most). The model answers with numbers and a reason, so the reply is a few dozen tokens. `chats`: at most three picks, each a ChatSearchHit with `why`; `model`: who picked, by its name; `read`: how many chats it read. Titles and found passages leave the computer for that model; the passages are scrubbed of secrets as chat.search returns them. Outside agents cannot call it. |
| `fs.write(path, content, if_match?)` | Replaces an existing workspace file whole (the reader's ticked checkbox). `if_match` is the sha256 (hex) of the content the client read; a file that changed since fails with `invalid_state`, so the write never clobbers an agent's edit. Never a path under `.git`. |
| `editor.list` / `editor.open(path, line?, editor?, reveal?)` | The editors installed on the runtime's computer (upstream discovery) and whether it can reveal a file; open a workspace file in one at a line (only where the editor takes a line), or select it in the file manager. `unsupported` when the editor isn't installed. |
| `term.list` / `term.attach` / `term.detach` | Terminals outlive clients. `term.attach` subscribes this connection and returns recent scrollback; `term.detach` stops the flow, never the process. Only `term.close` ends a terminal. |
| `tool.diff` | One file-change step's recorded change, read when the person opens it (the Changes panel's step view), never journaled: the engine's `diff` (unified or git patch, a bare hunk, or an added or deleted file's content), else `before`/`after`, and the `changes` it names, with `root_path`, the chat's folder on the computer that recorded it (any computer, Cloud ones included), for reading its absolute paths relative to it. Bounded per text (256 KB, marked when cut). `not_found` for any other step. |
| `tool.watch` / `tool.unwatch` | A running command's output as it prints, for a tool row on screen: `tool.live {workspace_id, item_id, kind, text, truncated, running}` frames to this connection, from the command's bounded tail (`replace`) then appends, until the frame with `running: false` or `tool.unwatch`. Feed `text` through `appendTerminalOutput` (`@caveman-app/shared/terminalOutput`). Secret values are masked. Not stored; `tool.output` and `tool.done` still carry the final output. |
| `suggestion.watch` / `suggestion.unwatch` | The engine's guess at the person's next message in a workspace's chat (`Settings.prompt_suggestions`, off unless turned on): `suggestion.live {workspace_id, run_id, text}` frames to this connection, now and at each change, until `suggestion.unwatch`. The Caveman engine, Claude Agent and Codex make one after a completed turn; `text` is null once the chat sends again, or when there is none. The empty composer shows it and Tab takes it. Not stored. |
| `browser.navigate` / `.history` / `.control` / `.input`, notifications `browser.state`, `browser.pointer` | Live browser control. Coordinates are the page's CSS pixels: the space of `browser.frame`'s `width` and `height`, not the JPEG's own pixels, which can differ. `browser.control` hands the browser to the user or back; while the user holds it the agent's browser tools wait or fail with `user_in_control`, and only that connection may send `browser.input` (events batched per animation frame, modifiers as a CDP bitmask). A page's alert, confirm, prompt or leave-page check rides on `browser.state` as `dialog`; the page waits until the connection holding control answers with a `browser.input` event `{type: "dialog", accept, text?}`, or, once nobody holds the browser, the agent does. As in a browser, pointer, wheel, key and text input sent meanwhile never reaches the page, then or once the dialog is answered. `browser.input` answers once its input is on its way, not when the page has taken it. `browser.pointer` is the agent's cursor for the overlay. |
| Live view rules | Turning a screencast on (`browser.screencast` / `computer.screencast` with `enabled: true`) sends the current `*.state` and one frame right away, since a static page may never repaint. Control returns to the agent when the connection that took it drops. One live viewer per screen per connection: a second view of the same screen on one connection replaces the first. `browser.history` with `action: "reload"` and `ignore_cache: true` is a hard reload. |
| `computer.screencast` / `.control` / `.input`, notifications `computer.frame`, `computer.state`, `computer.pointer` | The same control set for the workspace computer's desktop (a cloud VM screen). |
| The agent at work on a screen | `browser.state` and `computer.state` also go to every connection, watching or not: with `reveal: true` when the agent asks to show its page (`preview_open`) or first uses a desktop since it started, and with `active: true` when it acts there, at most every few seconds per workspace while it keeps at it. A client can show which screen is in use from these alone, without a screencast. |
| `workspace.servers` / `.servers.stop` | Ports listening on the workspace's computer (port, URL, process), for the new tab and the browser's empty state. A server the workspace's chat started carries `started_by` (`terminal` with its `terminal_id`, or `agent`) and its `pid`; `workspace.servers.stop` ends that server's job (its process group: SIGTERM, then SIGKILL after 3 s) and refuses anything else. `can_stop` is false on Windows. |
| `workspace.restore` | Brings an archived workspace back: a fresh worktree from its branch (the archive script ran before it was removed), the same session. `workspace.archive` first stops a running turn, then archives the engine's thread too (its engine session closes, its terminals and PR watches end; restore brings the thread back). It keeps what was not committed (the agent's edits usually are not) as a commit on `refs/caveman/archived/<workspace_id>` before it removes the worktree, and refuses with `internal` when it cannot; an archive whose worktree git will not remove leaves the ref as it was. Restore puts it back as uncommitted changes and drops the ref. A chat in a plain folder (a `no_git` project) comes back in that folder, which archive never touched. When the branch moved meanwhile, the changes stay on the ref and the session gets a warning saying where; archiving again keeps them there, as the second parent of the new commit, and a restore that puts the new changes back leaves them on the ref. A done chat comes back off the Done shelf, unless `keep_done` (Tidy's Undo): its done mark stays as it was. A delegated agent comes back into the checkout it worked in: its own when that is still there, else its lead's as it is now (`invalid_state` while that lead is archived). |
| `repo.list` | Repositories this runtime knows (used by workspaces, or configured roots), newest first. |
| `project.list` / `.create(path or url, name?)` / `.update(project_id, name)` / `.remove(project_id)` | The project list, oldest first. `create` takes any folder inside a git repository and adds its top level, or a `url` (owner/name, a GitHub web URL, an https, ssh or file URL): a checkout already here is linked, otherwise it is cloned into `clone_dir`; a repository that already has a project returns it, and a removed one comes back. `workspace.create` adds the project for its repository when there is none. `remove` takes a project off the list and keeps its files; while any of its workspaces is not archived it answers `invalid_state`. |
| `project.update(project_id, logo)` / `project.logo.read(project_id)` / `project.logo.candidates(project_id)` | `Project.logo`, the mark drawn in place of the project's folder, is `{ id, path?, auto? }`: `id` is a short hash of the image's bytes, and `project.list`, which every client polls, carries nothing more. `project.logo.read` answers `{ id, url }` (a `data:` URL of at most 64 KiB), open as `project.list` is; a client fetches it once per new `id` and keeps it by `id`. `Project.logo_mode` says how the logo is chosen: absent for auto, `"none"` for the folder, `"picked"` for the person's image. `logo: "auto"`, the default, shows the first favicon or app icon in the resolver's order that a browser draws within 64 KiB (an `.icns` or an oversized file is passed over); `"none"` keeps the folder; `{ url, path? }` is the person's pick, which the client draws as a 64px PNG: only a `data:image/png;base64,` URL whose base64 round-trips, with the PNG signature and at most 64 KiB, is taken. `path` names the checkout file it was drawn from; the runtime notes that file's bytes then. The pick is kept in the project's settings on this computer. `candidates` (owner only) reads the checkout and answers at most 12 images, best first, each a `data:` URL of at most 256 KiB, within a few seconds with what it found by then: the favicons in the resolver's order, tracked files named like a logo, icon, favicon, mark, brand or mascot (outside dependencies, builds, tests and vendored code), then the GitHub owner's avatar, which the runtime fetches with a short timeout and leaves out on any failure. `current: true` marks the one that is the logo now: auto's file, or the picked file while it holds the bytes it had when picked (never an upload or the avatar). Every read opens the file without blocking and takes only a regular file inside the checkout; a client never names a file to read. |
| `project.import_chats(project_id)` | The project's Claude Code and Codex sessions from the last 30 days, as chats in its folder (no worktree), each continuing its own session natively; `{ imported, already, skipped }`. Run again, it brings in only sessions it has not. |
| `project.discover(refresh?)` | Repositories worth adding, best first (`ProjectCandidate`): where Claude Code and Codex sessions ran, git checkouts beside them and in the usual code folders, and the user's GitHub repositories; plus `clone_dir`. Cached briefly; `refresh` rescans. |
| `message.caveman_version(session_id, item_id)` | The same answer rewritten short in caveman speak by a cheap side request; never written to the session. |
| `spend.summary(from?, to?, group_by)` | Settings -> Spend. Measured cost comes from `usage` events and runtime side calls (`message.caveman_version`, `skill.record`), counted under the Caveman engine and their workspace. `saved_tokens` counts measured proxy deltas; `saved_usd` is their inferred list-price equivalent (null when unknown), with `saved_usd_partial` for missing prices. Plan spend stays null; `verified_usd` stays null until an A/B. |
| notification `workspace.changed` | Sent to every connection when a workspace is created or changes, so lists update without polling. |
| `TurnOptions.mode` | `grill` or `default` (see Grill mode). It holds from that turn on until a turn sends the other; a turn without `mode` keeps the session's. Engines without `capabilities.grill_mode` answer `unsupported` for `grill`. |
| `queue.list` / `.edit` / `.remove` / `.reorder` | Inputs waiting behind the running turn (`turn.submit` with disposition `queued`), next first, each with the text as the user typed it. Edit replaces the text, remove drops the input, reorder moves it before `before_turn_id` (`null`: to the back). A queued input that has started is no longer in the queue: those calls answer `invalid_state`. Every change (a queued `turn.submit`, edit, remove, reorder) appends `queue.updated {turns}` with the whole queue, so every attached client sees another client's edits at once; an input that starts leaves the queue with its `turn.started`. |
| `session.restore(at)` | Files and transcript back to the `turn.done` at `at`: the engine's conversation rolls back to that turn and the worktree to its checkpoint. When later turns or edits exist they are kept as a branch first: a new workspace forked at the latest turn, holding the files exactly as they were (uncommitted edits included). The session then gets `session.restored {at, branch_workspace_id}`. Refused with `invalid_state` while a turn runs; engines without `capabilities.restore` answer `unsupported`. |
| `checkpoint.keep(checkpoint_id)` / `checkpoint.undo(checkpoint_id)` | The Changes card after a finished turn. Keep leaves the files and closes the card. Undo puts back the files the session's latest finished turn changed (every file its `checkpoint.created` counts, beyond the 200 `files` lists too, from the checkpoint taken as it began) as they were before it, and nothing else: the transcript stays (`session.restore` is the rewind) and the index is not touched. Every file must still be exactly as the turn left it; Undo is refused with `invalid_state`, writing nothing, while a turn runs, once a later turn finished, when any file changed again, and when another chat worked in the same checkout during the turn. Both append `checkpoint.resolved` (Undo also `diff.changed`). |
| `goal.set(objective)` | The session's goal, kept until cleared with `null`. Engines with `native_goal` (Codex) pursue it themselves across turns; for the others the runtime prepends it to every turn it sends the engine (the transcript keeps the user's own words). Emits `goal.updated`. |
| `plugin.set_enabled(plugin_id, enabled, cwd?, here?)` | Turns an installed plugin on or off for me, for sessions started from now on; a Required one is `invalid_state`. With `here` and `cwd`, only for the project at `cwd`: every other project keeps what it has, and `plugin.list` from that folder answers `here: "on" \| "off"` where the project differs. `mcp.set_enabled(name, enabled, cwd?, here?)` and `mcp.list(cwd?)` do the same for a personal MCP server. |
| `credential.grant(marketplace, name, value)` / `credential.revoke` | A credential a plugin of the marketplace declares (`PluginInfo.connectors[].credentials`; `personal` for your own servers). The runtime keeps the value in its secret store; no call returns it. The broker attaches it when the plugin's process starts, through a 0600 file the launcher reads (never the engine's config, an environment it does not need, or argv); an undeclared name is `invalid_params`. |
| `skill.save(scope, project_id?, plugin_id?, name, markdown, path?)` / `skill.record(session_id, scope, ...)` | Writes a `SKILL.md` (Claude skill format: YAML front matter with `name` and `description`, then instructions) into my skills (`~/.agents/skills`), a project's (`.agents/skills`) or a plugin of a folder marketplace. `record` writes it from the session with the Caveman engine and the user's key (`engine_unavailable` without one). |
| `marketplace.list` / `.add(source)` / `.update(name)` / `.remove(name)` | Plugins page. A marketplace is a `marketplace.json` (`.agents/plugins/`, `.claude-plugin/` or `.cursor-plugin/`) in a git repository pinned to a commit, a plain folder read in place, the Caveman catalog shipped with the app, your team's (Caveman Cloud) or the open repository's. `update` repins a git one and drops hook trust for plugins whose files changed. |
| `plugin.list(marketplace?, query?, cwd?)` / `plugin.read(id)` | Every plugin in every marketplace, installed or not (`PluginSummary`: id `name@marketplace`, `interface` from the Codex manifest block or the Claude fields, `includes` counts, scope, policy, `required`, `needs_connect`, `suggested`: offered by the open repository, off until `plugin.set_enabled(cwd)` turns it on there); `read` adds the detail page (`PluginDetail`). `cloud_problem`: Caveman Cloud did not answer, the last team and project installs stay. |
| `plugin.install(id, scope, project_id?, policy?, connection?, add_to_team?)` / `plugin.uninstall(id, scope, project_id?)` / `plugin.connect(id, server, shared?)` | Project and team installs take only plugins teammates can fetch (`MarketplaceInfo.shareable`); `add_to_team` adds a git marketplace to the team first (org admins). Install copies a git plugin into the install cache at a pinned commit (a folder marketplace's is read in place) and turns it on for me, a project or the team; project and team installs live in Caveman Cloud (team: org admins). Effective set for a session: `required(team) ∪ required(project) ∪ ((default(team) ∪ default(project) ∪ mine ∪ repo-declared) − my turned-off)`; `plugin.set_enabled` turns any but a Required one off for me. `connect` signs in to a plugin's MCP server as `connector.connect` does. |
| `project.add_repo(project_id, repository)` / `.remove_repo` | A project's `repos`: the repositories that share its plugins. |
| `rule.list(project_id?)` / `rule.read(path)` / `rule.save(path, text)` | Rules: the instruction files each engine reads at session start, at home (`~/.claude/CLAUDE.md`; Codex's home `AGENTS.md` on the person's own Codex login) and at each project's root (`CLAUDE.md`, `AGENTS.md`; `.claude/CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.override.md` when present), with the engines that read each. A file that does not exist yet is listed (`exists: false`) so it can be created. `read` and `save` take only a path `list` gives, and refuse one that leads (through a link) outside its project or home folder; `save` replaces the file through a temp file and a rename. Owner only. |
| `import.scan` / `import.apply(items)` / `import.folder(path, confirm?)` | Bring in Claude Code, Codex and Cursor setups (marketplaces, enabled plugins, skills, MCP servers, instruction files) and plain folders, no git needed. Never reads a secret value. `import.folder` answers a preview (skills, servers with commands, hooks, rules) and imports only with `confirm`; links and key files in skills are never copied. |
| `secret.list(repo)` / `.set(repo, secrets)` / `.delete(repo, name)`, notification `secret.changed` | A repository's secrets: the `.env` a person pasted, imported or typed into a secret card. They belong to the repository, keyed by `repository` (`host/owner/name` from its origin, the key Caveman Cloud uses; `local:<path>` without one), so every computer working on it gets the same names. `set` is the only call that carries a value; no call returns one, and its value never enters the request record, logs or traces. `list` gives names, `updated_at` and `hidden` (false when a value is too short or plain to scrub: injected, but visible if a command prints it). The runtime sets them as environment variables in every process it starts for the repository (setup, archive, terminals, the Run command, engines) after `[env]` and the port variables, never in plugin processes, and replaces every value, raw or encoded, with `[secret:NAME]` in everything a client or a model receives. `secret.changed` carries names only; running processes keep the environment they started with. |
| `secret.env_files(repo)` / `secret.import(repo, path)` | Git-ignored `.env*` files at a local repository's top level holding names it has not stored (names only), and storing one of them. The runtime reads the file; `import` takes only a path `env_files` lists. |
| `Settings.remote_control` | The Environment card's Remote control switch: the runtime keeps its Cloud link open so the user's other devices can reach it. Absent means off. |
| `cloud.enroll(cloud_url, token, name?)` / `cloud.status` | Remote control's sign-in. `enroll` registers This Mac with Caveman Cloud using the access token of the person's Cloud sign-in (a session Cloud accepts for `code:write`); the token is used for that enrollment only and never stored, logged or returned. Each `enroll` makes a fresh Ed25519 key (0600, the runtime's state dir), so signing in again never re-trusts a key an owner revoked; it re-keys the same computer and revokes the runtime it replaces. From then on the runtime mints short-lived runtime tokens itself. Errors: `unauthorized` / `forbidden` (Cloud refused the sign-in), `rate_limited`, `internal` (Cloud unreachable or failing), `invalid_params` (a bad URL or request). `status` says where the link is: `off` (remote_control off), `not_enrolled`, `connecting`, `connected`, `unauthorized` (Cloud refused the runtime: revoked, or the person lost access) or `replaced` (another instance of this runtime holds the relay). A client attached through the relay is a Session Protocol connection like a local one, with its idempotency receipts keyed to the Cloud user the relay verified. |
| `cloud.signin` / `cloud.signout`, notification `cloud.changed`, `Settings.cloud_url` | Remote control's sign-in, driven by the runtime so the person's Cloud credential never reaches a client: `signin` starts Cloud's device flow at `Settings.cloud_url` (absent = `https://app.caveman.so`) and answers `{user_code, verification_uri, verification_uri_complete, expires_at}`; the client shows the code and opens the URL; the runtime polls, enrolls with the approved credential once (as `cloud.enroll`), then signs that credential out. Whoever approves the code controls this computer, so `signin` turns `remote_control` off and the runtime keeps the approving account (`cloud.status.account`: `email`, `organization_name`); the person switches Remote control back on here once they see it is theirs. Switching `remote_control` off cancels a sign-in still waiting; a sign-in that replaces an enrollment revokes the old runtime with its own key. Errors: `forbidden` (device sign-in is off), `rate_limited`, `internal` (Cloud unreachable or failing), `invalid_params` (a bad Cloud URL). `cloud.status` carries `signin` while it waits and `signin_error` when it ended without enrolling; `usage_reported` is true while This Mac is signed in, so each call's tokens and cost go to the Caveman account (Cloud's `POST /api/v1/code/runtime/local-usage`, nothing else leaves). `cloud.changed` (the `cloud.status` shape) goes to every connection whenever that answer changes. `signout` revokes this runtime in Cloud, forgets the link here and turns `remote_control` off. |
| `cloud.computers`, `cloud.computer.set`, `cloud.workspace.create` | Cloud computers from This Mac, through the runtime's own Cloud sign-in: Cloud acts as the member who signed the runtime in, so no person credential reaches a client. `computers` answers `{available, computers}` (`available`: this Cloud runs Cloud computers); `computer.set` wakes (`running`) or sleeps (`suspended`) one; `workspace.create` makes a Cloud workspace on a new computer for `repo` (a GitHub URL or owner/name) and answers `{workspace_id, computer_id, open_url}`, the Cloud-hosted client where the session continues. Codex is refused there for now. Errors: `invalid_state` (not signed in, Cloud computers off, the org's limit), `forbidden`, `invalid_params`, `internal`. |

The runtime authorizes every `mail.*` call from the caller's token. The
`session_id` in params names which session acts; it never grants anything.

## Plugin panels

A panel loads in an `<iframe sandbox="allow-scripts">`, never with
`allow-same-origin` beside `allow-scripts`, so it runs in an opaque origin
and cannot reach the client's storage or the runtime token. The client
puts no token in the panel URL and posts none to it. A panel that needs a
service asks the runtime's credential broker, which attaches credentials
outside the frame; plugins get no ambient secrets.

## The Chief

A chat you hand missions to. It sorts each note (answer, queue, start a
chat, steer one, remember, ask you) and starts and watches chats for you. It
runs with only its own tools, on anything connected (no key or credits: it
only captures). Chiefs are the person's, never a project's: each works in
the projects it lists, every project when it lists none. They share one
board and one set of limits, and each item is on one Chief's board
(`ChiefItem.chief_id`).

- `ChiefProfile`: `id` (its workspace's), `name`, `avatar` (a pixel
  character and tone), `role` (one line on what it does, at most 140
  characters; it opens its prompt), `model` (null: Auto), `access` (the
  permissions of the chats it starts; null: what a new chat in that project
  takes), `project_ids` (the projects it works in; empty: every project),
  `soul` (markdown standing instructions in its prefix, after Settings'
  `chief_soul`, the soul every Chief shares; a `## Crew rules` section in
  either goes to every chat it starts). For older clients, which show a Chief
  under one project, a Chief whose list is exactly one project carries it as
  `project_id`; nothing routes by it. `project_default` is never sent now (a
  runtime of 2026-11-15 to 17 sent it on a Chief it refused to remove). `home` is true only on a
  runtime's one Chief from before profiles.
- A call that names no Chief is routed in code, with no model call: a Chief
  that works in `project_id` (for a note with none, the project its words, a
  path in it or the chat on screen point at, else the project with the
  latest chat activity), the one with the fewest projects first (every
  project counts as most), then the oldest; else the Chief with the latest
  activity. With no Chief at all, the first is made: "Chief", in every
  project. No project is needed for any of it.
- `chief.list` lists every Chief, oldest first, and makes none.
  `chief.create(name?, avatar?, role?, soul?, project_ids?)` adds one with
  its own workspace and an empty board, in those projects (none: every
  project; an unknown one: `not_found`); `project_id` from older clients
  reads as `[project_id]`. `chief.update(chief_id, …)` replaces each field
  present (a name renames its workspace; a soul, role or project list
  reaches its next turn; `project_ids: []` is every project).
  `chief.remove(chief_id)` takes any Chief: each open and running item moves
  to another Chief picked for the item's project as above, its own turn
  stops and its workspace is archived. The last Chief with open items is
  refused (`invalid_state`: "Make another Chief first: its missions need
  somewhere to go."); the last with none goes. `project.remove` takes the
  project off every Chief's list; a Chief left with none retires as
  `chief.remove` takes one, its open items dropped, saying why, and other
  Chiefs' items in that project drop too. A removed Chief's own (closed)
  items can't be edited or started (`invalid_state`). Names are unique
  (trimmed, any case: `invalid_state`); unnamed, a Chief takes the first
  free of a short list of names, and the first character of the cast no
  Chief uses.
- `chief.get(chief_id?, project_id?)` (`chief_id`'s; else routed as above)
  returns its workspace (`kind: "chief"`, no repository: `repo.path` is its
  private home folder, `base_ref` and `branch` are empty), its profile
  (`chief`), `availability` (`ready`, or `no_key`: notes are captured,
  nothing is triaged), the whole board, its model `picker` and pick
  (`model`). `workspace.list` leaves Chiefs out unless `include_chief`.
- `chief.capture(chief_id?, project_id?, text, mode, attachments?)` lands
  the note on that Chief's board (absent: as above) at once, before any
  model call. `attachments` are images only (inline, as `turn.submit` takes them),
  kept in the runtime's attachment store and referenced from the item
  (`ChiefItem.attachments`); the Chief sees them as images and hands them to
  a chat by id (`chat_start` and `chat_send` take `attachments`). `showing`
  (a worker chat's `workspace_id`) names the chat that was on the person's
  screen as they typed; the runtime tells the Chief its chat, item and
  project, the typed-note counterpart to a call's `showing:` line.
  `decide`: the Chief triages it (notes sent while it works join its running
  turn); `queue`: queued as is; `start`: the Chief starts it without asking.
  The limits (`chief_max_concurrent`, `chief_daily_cap_usd`,
  `chief_daily_turns`, `chief_ask_above_chats`) are shared by every Chief and
  enforced by the runtime, never by a prompt: past them an item waits
  `blocked` on `capacity` or `cap`, or is `proposed` for you to start
  (`chief.start`).
- `chief.attach(chief_id?, workspace_id)` puts a chat you started yourself
  on a Chief's board (absent: one that works in its project, routed as above) as a started item (`source: "attached"`) titled from
  the chat. From then the Chief hears its updates and may message and
  answer it like one it started. Attaching it again to the same board
  answers its item; a chat on another Chief's board, a Chief, an archived
  chat, or one outside the Chief's projects is refused (`invalid_state`).
- `chief.manage(topic, chief_id | null, hand_over?)` sets who manages a
  group of chats by topic (`ChiefProfile.topics`, one Chief per group). A
  chat that joins the group (the title writer names it, or the person moves
  it in) goes on that Chief's board as `source: "topic"`, on the same terms
  as `chief.attach`; one that leaves comes off the board of the Chief
  that manages the group it left, when a group put it there. A Chief that
  gives a group up keeps the chats it already took. `hand_over` names chats already in the
  group to take too, the ones the app listed; any on a board already,
  outside the Chief's project or no longer in the group stay where they
  are. `handed` lists the ones that went.
- `chief.items.*` edit, drop, delete and reorder Queue items (a reorder pins
  the item, so the Chief never moves it; `project_ids` naming a project its
  Chief does not work in is `invalid_params`); `chief.change_sets.list`
  lists the linked chats of older changes that spanned repositories (none
  are made now).
- An item carries `number`, its place on its Chief's board, never reused
  (the app shows APP-12; the Chief writes `[[12]]`). Absent from runtimes
  before numbers.
- `ChiefItem.done_when` is what proves its mission done (trimmed, at most
  280 characters); `check_in` is `day` or `week`, how often its Chief looks
  in while it is open or running. Both are optional. `chief.items.update`
  sets them; empty `done_when` clears the proof and null `check_in` clears
  the pace. The Chief's `queue_add` and `queue_update` take them too. Only
  a due check-in wakes the Chief; closed items never do. Result wakes carry
  the mission's proof so its Chief can check it before calling it done.
- An item a Chief asked you about carries `asked`: the question, the answer
  it recommends, and `go_ahead_at`, when it goes ahead with that answer
  unless you answer first (`chief_ask_wait_minutes`, default 15; absent: it
  waits for you). `workspace_id` and `ask_id` name the chat and question
  card it passed on.
- The board's `routines` (`ChiefRoutine`) are the automations with a
  `chief` output, each with its last run: when it ran, the Chief it reported
  to (`chief_id`), what its step decided and its report. A run reports to
  the Chief its file names (`outputs.chief.to`) while that Chief is there,
  else to one that works in its project, routed as above. A run that
  decided `news` also writes a `news` moment (with `routine`) in that
  Chief's session and wakes it. An automation's row in `automation.list`
  names its `routine` (the step, the schedule in words, `until`, the
  `chief_id` it names); Pause, Run now and Edit are the automation's own
  calls. Absent from runtimes before routines.
- Notifications to the owner's connections (as `chief.*` answers only
  them): `chief.board.updated` after any board change, with the whole board;
  `chief.list.updated` after a Chief is made, edited or removed, with every
  Chief.
- Settings' `chief_model` and `chief_rules` are from before profiles: read
  once as such a runtime upgrades, into its one Chief's model and soul, never
  again.
- Chiefs' turns are their own `spend.summary` bucket, `chief`. No Chief
  message or card carries cost.

### Calls

Talking to a Chief (app `docs/chief.md`, "Calls"). The client holds the
voice engine's socket and its media; the runtime holds the key and decides
everything the call says.

- `chief.get` carries `voice`: `state` (`ready`, `no_key`, `cap`, `off`),
  the engine, its name, where to get a key and what kind (`key_url`,
  `key_help`), its voices, a stored key's last four (`key_hint`), `credits`
  when the person has Caveman credits and no key of their own (`on`: they
  pay; `unavailable`: Caveman Cloud doesn't offer voice on them yet, and
  `state` is `no_key`) and the call on now, on any device. A start refused
  while credits are unavailable is `invalid_state` with a message starting
  `not_offered:`.
- `chief.voice.key(engine, key)` checks a key with the engine and seals it;
  `null` removes it. A key the engine refuses is `key_refused`.
- `chief.voice.start(device, answer?, chief_id?)` returns the call and how
  to connect: `url`, `protocols` (a short-lived token, or on credits a
  one-time ticket for Caveman Cloud's relay; never a key), the
  engine's first message (`settings`) and the audio rates. `chief_id`: the
  Chief to call (absent: the Chief with the latest activity); `answer`: the item a ring-back was
  about, which calls the Chief that rang. The call carries its
  `chief_id`; its transcript lines go in that Chief's session. One call at
  a time per runtime. Refused `invalid_state` with a message starting
  `no_key:`, `busy:` or `cap:`, or `engine_unavailable`.
- `chief.voice.signal(call_id, seq, events)` hands the engine's JSON
  messages to the runtime in order (`seq` from 0; one arriving early waits
  for the ones before it). It answers `send`: messages for the client to
  write to the engine as they are. Later ones come as `chief.voice.send`,
  to the connection that started the call only.
- `chief.voice.update(call_id, muted)` and `chief.voice.end(call_id,
  reason?)`. A call whose connection closes ends `connection_lost`.
- Notification `chief.voice.updated` (the call, on every owner connection)
  and `chief.voice.ringing` (`item_id`, `title`, `state`, the spoken
  `line`, `chief_id`): work handed off on a call is ready, done or stuck.
  With `muted: true` (Ring me back off, or `chief_voice_ring_muted_until`
  ahead) the client shows it quietly and never rings.
- The call's `showing` (`VoiceShowing`) is what it put on the person's
  screens: `pr` (the Review page: `project_id`, `pr_number`, `path` for one
  file), `diff` (the chat's changes, `path` one file) or `chat`, with a
  `caption`. Every device shows it; it clears when the call ends. The
  runtime sets it when work from the call is ready, when a ring back is
  answered, and when the voice's `show` function moves it.
- Events in the Chief's session: `voice.call` (`started`, `ended` with
  `duration_ms` and `reason`) and `voice.turn` (`role` `person` or `voice`,
  `text`, and `handoff` with the note's `item_id` and exact text). A note
  said on a call is `source: "voice"`; its `message.done` shows once, as
  its turn.

### Dictation

Talking into a box instead of typing (app `docs/chief.md`, "Dictation"). It
uses the calls' engine and key. The client holds the engine's socket, its
media and the words; the runtime only mints the connection and records the
minutes.

- `dictation.start(workspace_id?)` returns a `dictation_id` and how to
  connect: `url`, `protocols` (a short-lived token or a one-time ticket,
  never a key) and the mic's `input_rate`. Refused `invalid_state` with a message starting
  `no_key:`, or `engine_unavailable`.
- `dictation.end(dictation_id, audio_ms)` records the streamed audio at the
  engine's list price, in that chat's spend (none for a box with no chat:
  a new chat, the Chief's), capped at the time since it started. A
  dictation that never ends is not recorded.

## Thread references

A turn's text can point at another thread with upstream composer-context link,
`[label](t3-context://v1/thread/<workspace_id>)`. The label is display text;
the id is the identity. The runtime resolves each referenced workspace and
gives the engine a digest of it (status, goal, latest answer) with its thread
id, so the agent rarely has to read it. An id it cannot resolve is marked
unavailable, never guessed. The stored text keeps the link, so clients render
it in the sent message too. `formatThreadReference` and
`parseThreadReferences` build and read it.

## Permissions

`access` is upstream permission mode (its runtime mode) under a shorter
name. It says when the engine needs the user's approval to act; it never
stops the engine asking questions about the task.

| `access` | Label | T3 runtime mode | Behaviour |
|---|---|---|---|
| `ask` | Supervised | `approval-required` | Asks before commands and file changes. |
| `auto` | Auto-accept edits | `auto-accept-edits` | Edits go through; other actions can still ask. |
| `review` | Auto | `auto` | The engine's own automatic review approves routine actions and asks about the rest (Claude's `auto` permission mode, Codex's `auto_review`). |
| `full` | Full access | `full-access` | No approval prompts. |

- A chat keeps its own mode. `Session.access` reports it, and `turn.started`
  carries it. A `turn.submit` with `options.access` changes it from that turn
  on. Clients send `access` only when the user picks one.
- A new chat with no `options.access` takes its project's
  `Project.default_access` (`project.update`, null clears it), else
 `Settings.default_access`, else `full`, upstream initial default. It never
  copies the mode of the chat the user was viewing.
- `EngineDescriptor.access_modes` lists the modes an engine offers: its
  provider's `supportedRuntimeModes`, or `["full"]` for an engine without
  approvals; absent means all four. A mode an engine does not offer runs
  as `ask`, as T3 does.

### A new chat's model

The model works the same way. A chat keeps its own; a `turn.submit` with
`options.model` changes it from that turn on, and never the default. A new
chat with no `options.model` takes its project's
`Project.default_models[engine]` (`project.update`, a null model clears it),
else `Settings.engines[engine].model` (Settings > General > New chats), else
the engine's `EngineDescriptor.default_model`: Auto (`caveman-auto`) while
Caveman can route Claude Agent or Codex, the Caveman engine's own `auto`,
else the engine's default. A saved Auto while Auto is not offered gives way
to the engine's default. Auto is listed first.

### Sign in once

A person connects a Claude plan or a compact plan once, and it runs their
chats on this computer and on every Cloud computer of theirs: never again per
project, per computer or per chat. A connection is an account of the engines
it serves (`EngineAccount`), kept sealed in Caveman Cloud. There is no second
list: `engine.list` and `engine.account.*` carry both kinds.

- `EngineAccount.where` says where an account works: `everywhere` (a
  connection that runs here and on Cloud computers), `cloud` (a connection
  this computer does not run on) or `this_mac` (a login or key kept on this
  computer only). `EngineAccount.connection` is a connection's state: `ready`,
  `used_up` until a time, `expired` or `revoked` (connect it again), and `off`
  where this Caveman Cloud switched its kind off.
- Order is the order accounts are tried: connections first, in the person's
  order in Cloud, then this computer's own. `engine.account.activate` on a
  connection moves it first, for every computer. When one runs out the chat
  carries on with the next and says so once ("Claude plan used up until
  11:08 PM. Running on your Anthropic key."); with nothing left it says why
  in one note ("Claude plan used up. Carries on at 11:08 PM." on a Mac;
  in Cloud only until when), asks before
  it spends Caveman credits, and sends the person's last message again by
  itself once something serves it.
- `EngineDescriptor.auth.everywhere` says what this computer can do about an
  engine's plan: `available` (connect it here), `off` (switched off on this
  Caveman Cloud), `manage` (a Cloud computer: connect and remove from the
  person's own device). Absent, this computer is not signed in to Caveman and
  everything works as before connections.
- `engine.account.add(engine, everywhere: true)` connects. On a desktop the
  runtime runs the official CLI's own sign-in itself: `claude setup-token` for
 Claude Agent, `codex login` (with `compact: true`; `device_code: true` for
  its device code) in a private home it deletes afterwards. The answer's
  `sign_in` carries the provider's page; nothing is typed in a terminal.
  `engine.account.complete(engine, account_id: "connecting", callback_url: "")`
  waits for the person's approval and answers the accounts; `waiting: true`
  says they have not approved yet, so ask again. A sign-in that ended without
  a connection answers `invalid_state` with why. A client with no `claude`
  beside it sends `token`: the line `claude setup-token` printed on another
  computer.
- A sign-in in progress is the runtime's, one per engine, not a window's.
  `EngineDescriptor.auth.connecting` (`request_id`, `since`) says one is open
  and which `engine.account.add` started it; `engine.changed` tells every
  client when it starts and when it ends, however it ends. Any client may
  wait for it. An `add` while one is open is answered that one's page and
  starts nothing. Only its starter ends it:
  `engine.account.remove(engine, account_id: "connecting:<request_id>")`
  gives it up, and `add(..., connecting: <request_id>)` starts it over (with
  `device_code`, say). A bare `"connecting"`, or another call's id, ends
  nothing: closing a window or pressing Escape never cancels a sign-in.
- This computer's own `claude` and `codex` logins are never read, copied or
  uploaded. With a plan connected, the engine's chats here run on the
  connections; without one, on this computer's own login, as before.
- No token is in any answer, event, log line or journal entry. The engine's
  process holds a stand-in on every computer; the runtime's egress attaches
  the real credential on this computer, and Cloud's data plane does on a Cloud
  computer.
- A Cloud computer lists the person's connections and changes none
  (`no_sign_in_here`): `add`, `remove` and `activate` answer `unsupported`
  there, and a client with the person's own Cloud session writes to Cloud's
  `model-connections` routes itself.
- Nor does such a computer keep any other key of the person's:
  `web.keys.set`, a `chief.voice.key` that sets one, `secret_provider.save`,
  a `secret_slot.set` that sets `ref`, `credential.grant`, and an `mcp.add`
  or `marketplace.add` whose command line or URL carries a key answer
  `unsupported` there, each with where it is done instead. The calls that
  only remove one (`web.keys.clear`, `secret_provider.remove`,
  `credential.revoke`, a null key or `ref`) still work.

### Switching harnesses in a chat

`turn.submit` with `options.engine` selects the next turn's harness without
creating a new app thread, session, workspace or checkout. The v2 orchestrator
hands the canonical conversation to the target provider; returning to a
previous provider resumes its native conversation with the missing context
when compatible, otherwise creates a fresh provider conversation with a handoff.
`options.model` and `account_id` belong to the target harness. Without them,
a switch uses the target's project/settings/default model and active login,
never the previous harness's model or account. The choice is local to this chat.
A switch while work runs waits as a followup; the active turn is not interrupted.
`workspace.engine`, `session.engine` and `turn.started.engine` change when the
new turn starts, not when it is queued. `turn.prewarm` never commits a switch.

## Grill mode

`turn.submit` (or `workspace.create`) with `options.mode: "grill"` puts the
session in grill mode until a turn sends `mode: "default"`. The engine
interviews the user before anything is built: it maps the decisions the task
needs and asks them in rounds, each with a recommended answer, while it looks
up facts itself. Grill mode changes no permissions: `access` applies as set.

- Each round is one `ask.user` of kind `question` with `round` (1, 2, ...).
  Every question has `prompt` (its title), `detail` (markdown), options with
  a `recommended` option id, `multi_select: false` and `allow_text: true`.
  One `ask.respond` answers the whole round: per question, one option id or
  a `text`. While a round waits the workspace is `needs_input`, as with any
  ask. The end of its turn (an interrupt included), or a `turn.submit` of
  kind `followup` or `steer` while it waits (the user wrote instead of
  answering), resolves it `cancelled`; an answer after that is refused with
  `invalid_state`. A queued input, mail and `goal.set` leave it open.
- When every question is settled the engine writes a decisions doc in the
  worktree and the session gets `grill.finished {doc_path, summary}`
  (`doc_path` relative to the worktree; the file must exist there). The
  engine stops there; the client offers "Build it", a turn with `mode:
  "default"`.
- `Session.mode` is the mode after a reload; `turn.started.mode` shows each
  change live. In default mode the engine sees nothing of grill mode.
- Only the user puts a session in grill mode. `session.fork` keeps the
  mode; a fork an agent makes starts in default mode. A session moved to an
  engine without `grill_mode` (`mail.handoff`) goes back to default mode.
- Codex reloads its conversation to add or drop the grill tools, which would
  end background work, so it never does while any runs: a turn entering
  grill mode then fails ("Codex has background work running. Stop it first,
  or turn on grill mode in a new chat."), and after leaving grill mode the
  tools stay until the next reload (a late round reads that the user left).

## Events

Every session has one event stream. Each event has an integer `cursor` that
is gap-free and increases by one, starting at 1. The envelope is
`{session_id, cursor, at, turn_id?, item_id?, parent_item_id?, type, payload}`.

**Attach and reconnect.** `session.attach(session_id, cursor)` takes the last
cursor the client already has (0 for none). The reply `{session}` comes
first, and `session.head` marks where the backlog ends. After it, the runtime
sends a `session.event` notification for every event after `cursor`, in
order: the backlog first, then live events, with no gap. With `batch: true`
the backlog comes instead as `session.events` notifications
(`{session_id, events}`, consecutive events, a few hundred KB a frame); a
runtime from before `batch` ignores it. Attaching again on
the same connection replaces the earlier attachment, and many connections
can attach to the same session. Delivery is at least once, so clients drop
any event with `cursor <=` their last one. After a disconnect, the client
re-attaches from its last cursor and loses nothing. A gap is a runtime bug;
the client re-attaches from its last cursor rather than skip. The runtime
keeps a session's events for the life of the session.

**Turns and items.** `turn.started` and `turn.done` bracket each turn, and
every event inside the turn carries its `turn_id`. `item_id` groups the
events that build one item: a message (`message.delta`, then
`message.done` with the full text, which replaces the deltas), a tool
(`tool.started`, `tool.output`, `tool.done`), an ask (`ask.user`, then
`ask.resolved`), a subagent (`subagent.started`, then `subagent.done`).
Events produced inside a subagent carry that subagent's `item_id` as
`parent_item_id`, and nested subagents chain the same way. Each user input
appears as `message.done` with `role: "user"` when it enters the transcript,
either when its turn starts or when a steer is delivered. Queued inputs show
only in `queue.updated` until they start.

| Type | Payload |
|---|---|
| `turn.started` | engine, model, effort, and `mode` (the session's mode for this turn) |
| `message.delta` / `message.done` | text; done adds `role`, attachments and, when another thread's agent wrote a user-role message, `from` (`title`, and `workspace_id` when that thread is a workspace); a user-role message steered into a running turn or sent from the queue says so in `delivery` (`steer`, `queue`). An attachment's `data` is an image's bytes up to 1 MB; it is empty for a file or a larger image, which the runtime's store keeps; a larger image names its `id`, which `attachment.read` reads (this chat's and its fork sources' only) |
| `reasoning.delta` | text. Clients may choose not to render it. |
| `tool.started` / `tool.output` / `tool.done` | name, title, kind, input / streamed text / `completed`, `failed` or `declined`, with result or error. A call shown as the model begins it can start before its input is known (an empty command or file); another `tool.started` for the same item, once the input is whole, replaces its name, title, kind and input. The runtime's own tools on other threads add `threads` (`title`, and `workspace_id` when that thread is a workspace): on `tool.started` the threads the input names (thread_send's target), on `tool.done` the ones the result names (the threads thread_launch and create_threads made) |
| `plan.updated` | The engine's todos (`todos`): all steps (each `pending`, `in_progress` or `completed`) and optional markdown. Each event replaces the previous list. |
| `diff.changed` | Per-file summary of the working tree against `base_ref`. Replaces the previous one. Use `fs.diff` for patches. |
| `ask.user` | `approval` (title, detail, the tool's item, allow/deny options), `question` (questions, each with options, `multi_select` and `allow_text`; a grill round adds `round`, and each question its markdown `detail` and `recommended` option id) or `secret` (`repo`, the variable `name`, a `reason`): the client stores the value with `secret.set`, then answers `{kind: "secret", provided}`, so the value never rides in the answer |
| `ask.resolved` | `answered` with the response, `cancelled` (interrupted turn; for a grill round, also the end of its turn or the user's own follow-up or steer while it waits) or `expired` |
| `subagent.started` / `subagent.done` | title and agent, and for a delegated agent its `workspace_id` and the `task_id` its delegate_task call returned / status and summary |
| `checkpoint.created` | `checkpoint_id` and its hidden git ref. Usable as `from`/`to` in `fs.diff`. `files`: what the turn itself changed (from the checkpoint taken as it began), each with its line counts; files a pull or rebase in the turn brought in are left out. A turn that changed more than 200 files lists the first 200 and adds `files_total` (`count`, `additions`, `deletions` over every file), so the card can say how many more there are. |
| `checkpoint.resolved` | `checkpoint_id`, `resolution` (`kept` or `undone`) and the files Undo put back. The turn's Changes card closes. |
| `session.restored` | `at` and the branch workspace. Clients drop what they built from events after `at` up to this one. |
| `goal.updated` | `objective` (null when cleared) and whether the engine pursues it natively. |
| `compaction.started` / `compaction.done` | The engine shrinking its context / `completed` or `failed`, with the context's tokens before and after. Engines that only report the result send `compaction.done` alone. |
| `model.routed` | The model the router moved the engine's calls to. Only the model: the router's reasons stay in Caveman Cloud. |

| `grill.finished` | `doc_path` (the decisions doc the engine wrote, a worktree path) and `summary`. Clients offer "Build it". |
| `queue.updated` | The whole queue after any client changed it (`turns`, next first). Replaces the previous one. |
| `turn.done` | `completed`, `interrupted` or `failed`, with an error. Exactly one per turn. |
| `usage` | The `engine` that made the call (absent on older events: the workspace's engine), tokens since the previous `usage` event, and `cost`: `billed`, `list_price` (computed, not paid) or null (not known, e.g. a subscription). One per finished turn that made a model call: a Caveman engine turn, stopped and failed ones included, carries `list_price` (every call, its subagents' included) when the provider reported every call's usage and the engine priced every call from the public catalog, else null; Claude Agent and Codex turns carry null. Recorded for Settings → Spend and **never rendered in a session**. |
| `session.parked` / `session.resumed` | reason / the computer that holds the lease now |
| `engine.status` | auth state, rate limit, version, message |
| `notification` | info or warning for the person, including incoming `mail`; in a Chief's session, `moment`: a chat on its board started, showed its plan, needs the person, finished with a result, a routine found something, or the Chief reacted to a note (`ChiefMoment`), written by the runtime. A `reaction` carries `message_id` (the person's `message.done` item id) and `emoji` (`👍`, `👀`, `✅`, `❤️`); the latest reaction per message wins. Cards need no model turn; the Chief uses `react` for a reaction instead of a sentence. A client without moments shows its title line. |
| `error` | A session problem that does not end the turn (a failed turn ends with `turn.done`). With `retry` (attempt, max attempts, delay), the engine is retrying the failed call. |

Other notifications: `term.output {terminal_id, data}`,
`term.exit {terminal_id, exit_code, signal?}`,
`term.resync {terminal_id}`, and
`browser.frame {workspace_id, mime_type, data, width, height}`, where
`width` and `height` are the page's CSS size (the coordinate space of
`browser.input`), not the size of the JPEG in `data`.

### A client that reads slowly

What the runtime has for a connection waits in a bounded queue once the
socket backs up. A pushed state (`workspace.changed`, `chief.board.updated`,
`engine.changed`, `cloud.changed`, `environment.updated`, `secret.changed`,
`chief.voice.updated`) replaces the same state still waiting, so a slow
client gets the latest one. A terminal's waiting output is sent as one
`term.output`; when too much of one terminal waits, it is dropped and
`term.resync` is sent: `term.attach` the terminal again for its scrollback
(no more of its output comes until then). A client too far behind on
everything else is disconnected with close code 4008; reconnect and
re-attach from your cursors, as after any drop.

## Errors

Every error has `code`, `message` and `data.reason`. Malformed frames get
standard JSON-RPC codes (-32700 parse error, -32600 invalid request, -32601
unknown method). Everything else uses this table:

| reason | code | when |
|---|---|---|
| `not_found` | -32001 | No such id, or the id is outside the token's scope |
| `invalid_params` | -32002 | Params fail the schema or the rules above |
| `request_id_conflict` | -32003 | A `request_id` was reused with different params |
| `invalid_state` | -32004 | Wrong state for the call (an ask already answered, an archived workspace) |
| `engine_unavailable` | -32005 | The engine is missing, signed out or crashed |
| `unauthorized` | -32006 | Token missing or expired |
| `forbidden` | -32007 | Token valid, action not allowed |
| `rate_limited` | -32008 | `data.retry_after_ms` says when to retry |
| `parked` | -32009 | The session is parked; call `session.resume` first |
| `lease_lost` | -32010 | Another computer holds the session now; ask Cloud where it lives |
| `unsupported` | -32011 | The engine lacks a capability; the flag is named in `data.capability` |
| `internal` | -32012 | A runtime bug |
| `user_in_control` | -32013 | The user holds the browser or desktop |
| `secret_in_input` | -32014 | `turn.submit`, `queue.edit` or a workspace's task text carries a known credential or a stored secret's value; store it with `secret.set` instead |

## Vocabulary next to upstream

The runtime ports upstream orchestration and keeps upstream names inside it.
This protocol uses ours.

| Session Protocol | upstream |
|---|---|
| repo | project |
| workspace | thread plus its worktree and branch |
| session | the thread's conversation (AppThread with its ProviderThread bindings) |
| turn | run: a counted, user-visible turn. upstream provider turns stay internal. |
| item | execution node or turn item |
| `parent_item_id` | `parentNodeId` of a subagent node |
| ask (`ask.user`) | runtime request (approval or user input) |
| engine | provider |
| `engine_session_ref` | provider refs (`nativeThreadRef`) |
| cursor | event `sequence` |
| checkpoint | checkpoint |
| Run (Runs board) | none. A workspace started from the Runs board, not upstream run. |

## Versioning

Within v1, changes are additive only: new methods, new event types, new
optional fields, new enum members. Clients ignore event types and fields
they do not know and treat unknown enum values as opaque. Removing or
renaming anything, or changing what an existing field means, makes v2,
which is served next to v1 on its own endpoint.

Inside v1, `runtime.hello` says which build answers. Each connection opens
with it, and the client keeps the answer (`client.hello()`, `onHello`).
Every connection asks again, because a runtime can be updated between two
connections (a Cloud computer that woke on a new image).

- `version` is the runtime's build: the desktop app's version for the
  runtime it bundles, the npm package's for `caveman-code`, and the release's
  for a Cloud computer image. It is for people and logs. Nothing compares it.
- `protocol_revision` is an integer (`PROTOCOL_REVISION`, `src/revision.ts`).
  It rises only when a change needs both sides to know it. A runtime from
  before `runtime.hello` answers -32601 and reads as revision 0
  (`LEGACY_RUNTIME`).
- `min_client_revision` is the oldest client revision the runtime serves.
  The client has its own floor, `MIN_RUNTIME_REVISION`. `versionSkew` reads
  both: `runtime_older` (the client asks for the runtime's update; a Cloud
  computer gets Update now) or `client_older` (the client asks for its own
  update, or a reload in a browser).
- `capabilities` name features. A client gates a feature on its capability,
  never on `version` or the revision. The list is empty today: every feature
  clients gate on so far predates `runtime.hello` and keeps its -32601 or
  `unsupported` fallback, and those fallbacks stay.

When a change needs both sides, raise `PROTOCOL_REVISION`. Then raise
`MIN_CLIENT_REVISION` if older clients would break against the new runtime,
or `MIN_RUNTIME_REVISION` if this client would break against older runtimes.

## Client

```ts
import { connect } from "@caveman-app/session-protocol";

// The token may be a string or a function, called before every attempt.
const client = connect(runtimeUrl, () => relayToken(), (state, error) => show(state, error));
const sub = await client.attach(
  sessionId,
  0,
  (event) => render(event),
  (error) => showEnded(error), // the subscription is over for good
);
await client.call("turn.submit", {
  request_id: crypto.randomUUID(),
  session_id: sessionId,
  kind: "followup",
  input: { text: "now add tests" },
});
client.on("term.output", ({ terminal_id, data }) => write(terminal_id, data));
```

When the socket drops or an attempt fails, the client reconnects with
backoff (250 ms, doubling up to 5 s; it resets once a connection has stayed
up for 10 s). It resends unanswered calls with their original params, so a
mutating call keeps its `request_id` and runs once. It re-attaches every
session from the last delivered cursor, drops events it has already
delivered, and turns active screencasts back on. It does not validate
incoming events, so it keeps working with a newer v1 runtime.

- `onState` reports `connecting`, `open`, `unauthorized` and `closed`.
  A failed upgrade looks like a network failure, so it shows as
  `connecting`.
- A call answered `unauthorized` is resent once on a fresh token (a token
  function only). When that fails too, the client reports `unauthorized`
  and rejects the call with `SessionProtocolError` reason `unauthorized`.
  When the token function throws, it reports `unauthorized` and rejects
  the waiting reads that way; mutating calls keep waiting, as they do for
  a socket, since one that went out may have run. Attaches, first ones
  included, keep waiting too: no runtime refused the chat, and the next
  socket that opens takes them out at once. It keeps retrying.
- A re-attach refused for a reason that will not pass (`not_found`,
  `forbidden`, `lease_lost`, `parked`, `unauthorized`, ...) ends the
  subscription through `onError`. `rate_limited`, `engine_unavailable` and
  `internal` are retried with backoff. A gap is re-attached up to three
  times without progress, then ends the subscription with `internal`.
- Several subscriptions to one session on one client each get every event;
  the session is detached when the last one detaches, or when the last
  one's first attach fails (it may still be answered late).
