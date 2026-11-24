// Session Protocol v1: the wire contract between clients (web, desktop,
// `caveman code`, Cloud's relay) and the runtime on a computer.
// Semantics live in ../README.md. Every key on the wire is snake_case.
// Within v1 only additive changes: new methods, new event types, new
// optional fields. Clients ignore event types and fields they do not know.
import * as Schema from "effect/Schema";
import { SECRET_NAME_PATTERN } from "./secrets.ts";

const { optionalKey } = Schema;

// ---------------------------------------------------------------- primitives

/** Opaque app-owned id. Engine-native ids never replace it. */
export const Id = Schema.NonEmptyString;
/** Client-generated idempotency key on every mutating call (README: Idempotency). */
export const RequestId = Schema.NonEmptyString.annotate({ identifier: "RequestId" });
/** Per-session event position. Gap-free, starts at 1; 0 means "before the first event". */
export const Cursor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  identifier: "Cursor",
});
/** RFC 3339 timestamp, UTC. */
export const IsoDateTime = Schema.String;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Strings = Schema.Array(Schema.String);
/**
 * A path inside the workspace's worktree, relative to its root: never
 * absolute, never a `..` segment. The runtime also resolves symlinks and
 * rejects anything that lands outside the worktree (README: Paths and refs).
 */
export const WorkspacePath = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/),
).annotate({ identifier: "WorkspacePath" });
/** A git ref: no leading `-` (never an option), no `..`, no git revision syntax. */
export const GitRef = Schema.String.check(
  Schema.isPattern(/^(?!-)(?!.*\.\.)[^\s\0~^:?*[\\]+$/),
).annotate({ identifier: "GitRef" });
/**
 * A GitRef, or a checkpoint id exactly as `checkpoint.created` carries it
 * (`checkpoint:...`). The runtime resolves a checkpoint id to its ref itself
 * and never hands it to git, so its `:` is never revision syntax.
 */
export const RefOrCheckpoint = Schema.String.check(
  Schema.isPattern(/^(?:checkpoint:(?!.*\.\.)[A-Za-z0-9%._:!'()*~-]+|(?!-)(?!.*\.\.)[^\s\0~^:?*[\\]+)$/),
).annotate({ identifier: "RefOrCheckpoint" });

export const EngineId = Schema.Union([
  Schema.Literals(["caveman", "claude-agent", "codex"]),
  // T3 Code harnesses (packages/provider-<id>): one engine per driver, its accounts the driver's instances.
  Schema.Literals(["cursor", "opencode", "muse", "grok", "pi", "antigravity"]),
  Schema.TemplateLiteral(["acp:", Schema.String]),
]).annotate({ identifier: "EngineId" });
export type EngineId = typeof EngineId.Type;

/** Base64 bytes with a media type. */
export const Blob = Schema.Struct({ mime_type: Schema.String, data: Schema.String }).annotate({
  identifier: "Blob",
});

// ----------------------------------------------------------------- resources

export const Repo = Schema.Union([
  Schema.Struct({ path: Schema.String }),
  Schema.Struct({ url: Schema.String }),
]).annotate({ identifier: "Repo" });
export type Repo = typeof Repo.Type;

/** An environment variable name: what a secret is called. */
export const SecretName = Schema.String.check(Schema.isPattern(SECRET_NAME_PATTERN));

/**
 * A repository's secret as clients see it: never its value. Secrets belong to
 * the repository, not a computer: `repository` is `host/owner/name` from the
 * checkout's origin (the key Caveman Cloud stores them under, so every
 * computer working on it gets the same names), or `local:<path>` for a
 * repository with no origin. The runtime injects them into every process it
 * starts for that repository and scrubs them from everything bound for a
 * model or a transcript.
 */
export const SecretInfo = Schema.Struct({
  name: SecretName,
  repository: Schema.String,
  updated_at: IsoDateTime,
  /**
   * False when the value is too short or too plain (`development`) to scrub
   * without wrecking ordinary text: it is still injected, but the model can
   * see it if a command prints it.
   */
  hidden: Schema.Boolean,
}).annotate({ identifier: "SecretInfo" });
export type SecretInfo = typeof SecretInfo.Type;

export const Computer = Schema.Struct({
  id: Id,
  kind: Schema.Literals(["this_mac", "caveman_cloud", "pool"]),
  label: Schema.String,
  status: Schema.Literals(["starting", "online", "suspended", "offline", "error"]),
}).annotate({ identifier: "Computer" });
export type Computer = typeof Computer.Type;

export const WorkspaceStatus = Schema.Literals([
  "starting",
  "working",
  "needs_input",
  "waiting",
  "idle",
  "parked",
  "archived",
  "failed",
]);

export const AccountTag = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{2,3}$/)).annotate({ identifier: "AccountTag" });

/** What a delegated agent does (its agent type's role): it decides the model class Auto picks for. */
export const SubagentRole = Schema.Literals(["implementation", "research", "review", "design", "test", "general"]).annotate({
  identifier: "SubagentRole",
});
export type SubagentRole = typeof SubagentRole.Type;

/**
 * What the runtime's task classifier (ask_r4, runtime/src/askModel) reads a task as, from its words alone: the
 * eight classes Caveman Cloud's router uses. Settings > Subagents pins a model per kind, for delegated agents and,
 * with new_chat_by_task, for new chats.
 */
export const TaskKind = Schema.Literals([
  "frontend_ui",
  "backend_fix",
  "general_coding",
  "large_refactor",
  "plan_design",
  "explore_readonly",
  "terminal_ops",
  "trivial_chat",
]).annotate({ identifier: "TaskKind" });
export type TaskKind = typeof TaskKind.Type;

/**
 * Who runs a delegated agent and who chose it. `pick.by`: the lead named the harness or model,
 * the person's pin for the role (Settings > Subagents, or the agent type's own model), Caveman Cloud's
 * Auto, or the lead's selection. `fallback`: Auto was on but could not answer (not paying, Cloud
 * not linked, an error or timeout, or routing paused for quota), so the lead's selection ran.
 */
export const SubagentRunner = Schema.Struct({
  engine: EngineId,
  /** The engine account (EngineAccount.id) that runs it. */
  instance_id: Id,
  /** The account's tag when the person set one; otherwise clients take engine.list's tag for instance_id. */
  account_tag: optionalKey(AccountTag),
  model: Schema.String,
  effort: optionalKey(Schema.String),
  pick: Schema.Struct({
    by: Schema.Literals(["lead", "user", "auto", "default"]),
    kind: optionalKey(SubagentRole),
    /** The kind of task the classifier read the brief as, when that kind's pin (subagent_task_pins) picked it. */
    task: optionalKey(TaskKind),
    fallback: optionalKey(Schema.Literals(["not_paying", "cloud_unlinked", "cloud_error", "quota"])),
    /** How many connected options (account × model) Auto sent Caveman Cloud to pick from. */
    options: optionalKey(Count),
  }),
}).annotate({ identifier: "SubagentRunner" });
export type SubagentRunner = typeof SubagentRunner.Type;

/**
 * A native subagent: the engine's own (Claude's Agent tool, Codex's collab agents). It runs inside
 * its chat's transcript, its steps under its `subagent.started` item, and is never a workspace;
 * the chat lists it so a sidebar can show it beside the chat's delegated agents.
 */
export const NativeSubagent = Schema.Struct({
  /** Its subagent.started item in the chat's session. */
  item_id: Id,
  /** The native subagent that started this one. */
  parent_item_id: optionalKey(Id),
  title: Schema.String,
  /** The engine running it, for its logo. */
  agent: optionalKey(Schema.String),
  status: Schema.Literals(["working", "completed", "failed", "interrupted"]),
  started_at: IsoDateTime,
  /** When it stopped working (its subagent.done); absent while it works, and on ones listed before the runtime stamped it. */
  ended_at: optionalKey(IsoDateTime),
}).annotate({ identifier: "NativeSubagent" });
export type NativeSubagent = typeof NativeSubagent.Type;

/** What a chat's latest turn is at, for a sidebar or inbox that never attaches its session. */
export const WorkspaceActivity = Schema.Struct({
  /** The open ask while the chat waits on the person (status needs_input): its kind and one line of its prompt. */
  ask: optionalKey(Schema.Struct({ kind: Schema.Literals(["question", "approval", "secret", "tool"]), prompt: Schema.String })),
  /** When the running turn started (turn.started); absent once it ends. */
  turn_started_at: optionalKey(IsoDateTime),
  /** How the latest finished turn ended (turn.done). */
  last_outcome: optionalKey(Schema.Literals(["completed", "interrupted", "failed"])),
  /** When the latest turn ended (turn.done); absent while one runs. How old its news is, which updated_at cannot say (a rename moves it). */
  turn_ended_at: optionalKey(IsoDateTime),
  /**
   * Its latest turn ended, but it still waits on work that will wake it: a delegated agent, background work its agent
   * marked with background_wait, a pull request it watches until it merges (T3's pending background work that holds
   * completion). Absent otherwise, and while a turn runs. A chat that awaits is at work, not finished. Never moves
   * updated_at.
   */
  awaiting: optionalKey(Schema.Literal(true)),
  /** The latest todo list (plan.updated kind "todos"): steps completed and in all. */
  todos: optionalKey(Schema.Struct({ done: Count, total: Count })),
  /** grill.finished: a decisions doc waits to be built; cleared when the next turn starts. */
  ready_to_build: optionalKey(Schema.Boolean),
  /**
   * The chat's latest answer (message.done, role assistant, its own agent's, never a subagent's) as plain text on one
   * line, at most 280 characters: the line a sidebar shows under the title. Scrubbed of secret values like its event.
   */
  last_reply: optionalKey(Schema.String),
}).annotate({ identifier: "WorkspaceActivity" });
export type WorkspaceActivity = typeof WorkspaceActivity.Type;

export const PullRequest = Schema.Struct({
  number: Count,
  url: Schema.String,
  state: Schema.Literals(["draft", "open", "merged", "closed"]),
  /** Its checks on the head commit, when the host read reports them (a chat's linked pull request, synced by the runtime); absent when unknown. */
  checks: optionalKey(Schema.Literals(["passing", "failing", "pending"])),
  /** Its review decision, when the host read reports one; absent when unknown. */
  review: optionalKey(Schema.Literals(["approved", "changes_requested", "review_required"])),
  /**
   * While its checks fail: those failures set against its base branch's CI (GitHub, read by the runtime), so a red
   * base is never blamed on this pull request. `failing` names its failing checks; `on_base` those of them that fail
   * on `base` too, or did when last compared (kept until the check passes here, so a base gone green still shows
   * which failures were its); `base_state` is CI on the base's head now. Absent until compared, and once checks pass.
   */
  base_ci: optionalKey(
    Schema.Struct({
      base: Schema.String,
      failing: Schema.Array(Schema.String),
      on_base: Schema.Array(Schema.String),
      base_state: Schema.Literals(["passing", "failing", "pending", "unknown"]),
    }),
  ),
}).annotate({ identifier: "PullRequest" });
export type PullRequest = typeof PullRequest.Type;

/**
 * How to serve what a chat built, from its own checkout (its agent's register_preview), so the person can try it in
 * their browser with one click (workspace.preview.open). `command` runs in the chat's worktree on the chat's own port:
 * `{port}` in it, and PORT and CAVEMAN_PORT, say which. The runtime owns the server it starts: one per chat, stopped
 * when it sits idle, when the chat is archived, and when the runtime quits, as a whole process group.
 */
export const WorkspacePreview = Schema.Struct({
  command: Schema.String,
  /** The address path to open, from "/": "/settings", "/?demo=1". */
  path: Schema.String,
  /** The port the command always listens on, when it can't be told one; absent: the chat's own port. */
  port: optionalKey(Count),
  registered_at: IsoDateTime,
}).annotate({ identifier: "WorkspacePreview" });
export type WorkspacePreview = typeof WorkspacePreview.Type;

/**
 * Where a chat stands in the person's inbox, kept on its engine thread by T3 Code's settlement, snooze, pin and
 * visit state, so every client of the runtime agrees. Empty keys are left out; a chat never touched has none.
 */
export const WorkspaceInbox = Schema.Struct({
  /**
   * Done: marked by the person (workspace.inbox), or by the runtime when its pull request merged or closed or
   * it sat quiet (Settings.inbox_done_*). Its next message clears it.
   */
  done_at: optionalKey(IsoDateTime),
  /**
   * Snoozed until then. It wakes early once it asks something, fails, or finishes a turn after `snoozed_at`;
   * clients read that from its status. Its next message clears it.
   */
  snoozed_until: optionalKey(IsoDateTime),
  snoozed_at: optionalKey(IsoDateTime),
  /** Pinned: kept on top and never marked done by the runtime. Pinning clears done and snooze; done unpins. */
  pinned_at: optionalKey(IsoDateTime),
  /** Read through this `updated_at`: unread while `updated_at` is later. Absent until a client first reports it. */
  visited_at: optionalKey(IsoDateTime),
}).annotate({ identifier: "WorkspaceInbox" });
export type WorkspaceInbox = typeof WorkspaceInbox.Type;

/** workspace.inbox: one change to a chat's WorkspaceInbox. */
export const InboxAction = Schema.Union([
  Schema.Struct({ do: Schema.Literal("done") }),
  Schema.Struct({ do: Schema.Literal("reopen") }),
  /** Not while it asks something or a message waits to start (invalid_state). */
  Schema.Struct({ do: Schema.Literal("snooze"), until: IsoDateTime }),
  Schema.Struct({ do: Schema.Literal("wake") }),
  Schema.Struct({ do: Schema.Literal("pin") }),
  Schema.Struct({ do: Schema.Literal("unpin") }),
  /** Read through `through` (the `updated_at` the client showed); never moves `visited_at` back. */
  Schema.Struct({ do: Schema.Literal("seen"), through: IsoDateTime }),
  /** Unread again, from just before its latest turn finished; invalid_state before any turn has. */
  Schema.Struct({ do: Schema.Literal("unread") }),
]).annotate({ identifier: "InboxAction" });
export type InboxAction = typeof InboxAction.Type;

/**
 * A repository on its git host, read from the checkout's origin remote. The
 * same repository on another computer (a cloud one, a teammate's) has the
 * same `full_name`, so it is what a project is matched by across computers.
 */
export const RepositoryLink = Schema.Struct({
  /** Host name, e.g. github.com. */
  host: Schema.String,
  /** owner/name. */
  full_name: Schema.String,
  /** The repository's page on its host. */
  web_url: Schema.String,
  /** Credential-free URL to clone it from. */
  clone_url: Schema.String,
}).annotate({ identifier: "RepositoryLink" });
export type RepositoryLink = typeof RepositoryLink.Type;

/**
 * One of the other sources a chat works in (Workspace.checkouts): its own worktree of that source, in the folder
 * `name` beside the chat's primary checkout. A path in such a chat (a changed file, fs.read) starts with the name of
 * the source it is in.
 */
export const WorkspaceCheckout = Schema.Struct({
  /** The source's name in its project (ProjectSource.name): the folder its worktree sits in under the chat's folder. */
  name: Schema.String,
  /** Where the source is, as Workspace.repo says it for the primary. */
  repo: Repo,
  /** Its repository on its git host, when it has one: what Caveman Cloud and a pull request know it by. */
  repository: optionalKey(RepositoryLink),
  /** Empty for a plain folder. */
  base_ref: Schema.String,
  /** The chat's branch in this source: Workspace.branch's name. Empty for a plain folder. */
  branch: Schema.String,
  /**
   * A plain folder on this Mac (ProjectSource kind folder): the chat works in the folder itself, linked into its own
   * folder, with no worktree, branch, diff, checkpoint or pull request there. A chat with one stays on its Mac.
   */
  folder: optionalKey(Schema.Literal(true)),
  /** Its branch's pull request in this source, as Workspace.pull_request is the primary's. */
  pull_request: optionalKey(PullRequest),
  /** What its worktree holds that `base_ref` does not, as Workspace.unmerged is the primary's. */
  unmerged: optionalKey(Schema.Struct({ files: Count, commits: Count })),
}).annotate({ identifier: "WorkspaceCheckout" });
export type WorkspaceCheckout = typeof WorkspaceCheckout.Type;

/** What became of a builder (Workspace.builder). */
export const BuilderState = Schema.Struct({
  /**
   * working: at work, or fixing a conflict its lead sent back. done: finished, its branch not yet brought together
   * with the others. merged: its branch is in its lead's. left_out: its branch is not, and `why`. paused: stopped
   * until its plan resets (`until`, `plan`), then it carries on by itself. failed: it could not do the work, and `why`.
   */
  state: Schema.Literals(["working", "done", "merged", "left_out", "paused", "failed"]),
  /** left_out and failed: why, in a few words a person reads after the colon ("conflicts in a.ts"). No path past three files. */
  why: optionalKey(Schema.String),
  /** paused: when the plan resets. Absent when the plan named no time. The client says it in the person's own clock. */
  until: optionalKey(IsoDateTime),
  /** paused: the plan that is used up, as a person names it ("Claude plan", "ChatGPT plan"). */
  plan: optionalKey(Schema.String),
}).annotate({ identifier: "BuilderState" });
export type BuilderState = typeof BuilderState.Type;

/** A topic's name (Workspace.topic): a group's heading in the sidebar, one line of at most 40 characters. */
export const TopicName = Schema.NonEmptyString.check(Schema.isMaxLength(40)).annotate({ identifier: "TopicName" });

/**
 * A topic's emoji (Workspace.topic_icon): the mark before a group's name in the sidebar by topic, one emoji ("🧭"). At
 * most 16 code units, room for a flag or a joined sequence.
 */
export const TopicIcon = Schema.NonEmptyString.check(Schema.isMaxLength(16)).annotate({ identifier: "TopicIcon" });

export const Workspace = Schema.Struct({
  id: Id,
  title: Schema.String,
  repo: Repo,
  base_ref: Schema.String,
  branch: Schema.String,
  /**
   * A chat that works in several sources of its project: the name of its primary source, which `repo`, `base_ref`,
   * `branch`, `pull_request` and `unmerged` describe. The chat's folder holds one worktree per source, side by side
   * under their names, and is the engine's working directory. Absent, with `checkouts`, for a chat in one source,
   * whose folder is its worktree.
   */
  source: optionalKey(Schema.String),
  /** The other sources this chat works in, each on a branch of the same name as `branch`. Absent for a chat in one source. */
  checkouts: optionalKey(Schema.Array(WorkspaceCheckout)),
  engine: EngineId,
  computer: Computer,
  session_id: Id,
  status: WorkspaceStatus,
  /** Set on builders: the lead workspace that spawned this one. */
  parent_workspace_id: optionalKey(Id),
  /**
   * Set on builders, by the runtime their lead runs on: what became of this builder, for its row. A client reads the
   * row from this and from nothing else: "Working", "Done", "Merged", "Left out: conflicts in a.ts", "Paused until
   * 11:08 PM", "Failed: its agent stopped". Absent on a chat that is no builder, and from a runtime before this field
   * (a client then reads `status`, as it did).
   */
  builder: optionalKey(BuilderState),
  /** Ports allocated to this workspace from .caveman/computer.toml [run].ports, by name. */
  ports: optionalKey(Schema.Record(Schema.String, Count)),
  /**
   * Absolute worktree root, only for This Mac (Copy absolute path, Reveal in
   * Finder). Never set for cloud or pool computers.
   */
  root_path: optionalKey(Schema.String),
  /** The repo's run command ([run].command), started in a terminal by the Run button. */
  run_command: optionalKey(Schema.String),
  /** The project (project.list) whose repository this workspace was made from. */
  project_id: optionalKey(Id),
  /**
   * chief: one of the person's Chiefs (chief.list), each its own. It has no
   * repository: `repo` is its private home folder, `base_ref` and `branch`
   * are empty. workspace.list leaves it out unless `include_chief`. Absent
   * for every chat. setup: a project's setup chat (environment.fix), which
   * workspace.list leaves out; environment.get names it.
   */
  kind: optionalKey(Schema.Literals(["chief", "setup"])),
  /**
   * The larger piece of work it belongs to ("Pricing Revamp"): chats that share a topic sit in one group when the sidebar
   * shows chats by topic. The runtime's title writer names it with the title, reusing a topic the person already has
   * when the chat fits one, once: a later title never changes it. Only the person moves it after (workspace.topic).
   * Absent: in no group.
   */
  topic: optionalKey(TopicName),
  /**
   * Its topic's emoji, the group's mark in the sidebar. The title writer picks one with a new topic and reuses an
   * existing topic's own; the person changes it for the whole group (workspace.topic `icon`). Absent with no topic, or
   * for a topic named before topics had one.
   */
  topic_icon: optionalKey(TopicIcon),
  /**
   * An automation run's step or agent check: which run and step it belongs to. The chat sidebar leaves it
   * out (the automation's run view opens it); workspace.list keeps it so a client can open it by id.
   */
  automation: optionalKey(Schema.Struct({ name: Schema.String, run_id: Schema.String, step: Schema.String, attempt: Schema.Number, check: optionalKey(Schema.Number) })),
  /** A delegated agent's workspace: who runs it (engine, account, model, effort) and who chose it. */
  runner: optionalKey(SubagentRunner),
  /** This chat's native subagents, in start order: the latest 20. */
  subagents: optionalKey(Schema.Array(NativeSubagent)),
  activity: optionalKey(WorkspaceActivity),
  /** Its branch's pull request on the repository's host, looked up for a chat on This Mac; absent when there is none. */
  pull_request: optionalKey(PullRequest),
  /** How to serve what it built (register_preview): its Open preview chip, here and on its Chief's board. */
  preview: optionalKey(WorkspacePreview),
  /**
   * What its worktree holds that `base_ref` does not: uncommitted files and commits on its branch, looked up with its
   * pull request. Absent when it holds nothing of its own, or before the first lookup. The queue reads a finished chat
   * with either (and no merged pull request) as ready for review.
   */
  unmerged: optionalKey(Schema.Struct({ files: Count, commits: Count })),
  /** Done, snoozed, pinned and read: kept by the runtime, never bumping `updated_at`. */
  inbox: optionalKey(WorkspaceInbox),
  /**
   * An outside agent started this chat through `caveman-code mcp`:
   * its name, as Settings > Caveman MCP lists it. Absent for the person's own chats.
   */
  started_by: optionalKey(Schema.Struct({ agent: Schema.String })),
  /**
   * The chat on another of the person's Macs whose mail this chat's latest turn runs (`mac:` mail, docs/agent-messaging.md):
   * its session in Caveman Cloud. That chat tells the person about the work; this one stays quiet. Absent otherwise.
   */
  asked_by_session_id: optionalKey(Id),
  /**
   * The session journal's identity (sync): cursors are gap-free within an epoch, and the epoch changes only when the
   * journal is rewritten (the chat was adopted from Cloud, or rebuilt from Cloud's copy after a lost tail). Starts at 1.
   * A runtime from before 2026-10-21 leaves `epoch`, `head` and `synced_through` out.
   */
  epoch: optionalKey(Count),
  /** The cursor of the session's newest event, as of this answer. */
  head: optionalKey(Cursor),
  /** How far Caveman Cloud's copy of the journal stands (its last cursor in `epoch`); null when this chat does not sync. */
  synced_through: optionalKey(Schema.NullOr(Cursor)),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
}).annotate({ identifier: "Workspace" });
export type Workspace = typeof Workspace.Type;

/**
 * Permissions: what the engine may do without asking, T3 Code's runtime
 * modes. ask (Supervised): approvals for commands and file changes. auto
 * (Auto-accept edits): edits go through, other actions can still ask. review
 * (Auto): the engine's own automatic review approves routine actions and asks
 * about the rest. full (Full access): no approvals. Engines map it onto their
 * own modes (Claude permission modes, Codex approval policy + sandbox); a mode
 * an engine does not offer runs as ask.
 */
export const AccessMode = Schema.Literals(["ask", "auto", "review", "full"]).annotate({ identifier: "AccessMode" });
export type AccessMode = typeof AccessMode.Type;

/** An action's glyph: T3's ProjectScript icons (packages/protocol project.ts), and diff: it tries the chat's changes, so the Changes bar offers it too. */
export const ActionIcon = Schema.Literals(["play", "test", "lint", "configure", "build", "debug", "diff"]);
export type ActionIcon = typeof ActionIcon.Type;

/**
 * A named command a person runs from a chat's Actions tab
 * (docs/computer-config.md "Actions"). The fields are T3's ProjectScript's; the
 * id follows its `script.<id>.run` rule.
 */
export const ProjectAction = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,23}$/)),
  name: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  icon: optionalKey(ActionIcon),
}).annotate({ identifier: "ProjectAction" });
export type ProjectAction = typeof ProjectAction.Type;

/**
 * One source of a project (Project.sources): a repository, or on a Mac a plain folder. A source belongs to one
 * project. Only a repository on a git host Caveman Cloud can fetch goes to a Cloud computer.
 */
export const ProjectSource = Schema.Struct({
  /** repo: a git repository. folder: a plain folder on this Mac, in no repository; it never leaves this Mac. */
  kind: Schema.Literals(["repo", "folder"]),
  /**
   * What a chat that works in several sources calls it: the folder its checkout sits in there. The repository's (or
   * the folder's) own name, with -2, -3 where two sources of a project share one.
   */
  name: Schema.String,
  /** Its repository on a git host: absent for a folder, and for a repository with no origin there. */
  repository: optionalKey(RepositoryLink),
  /**
   * Where it sits on this computer: the repository's checkout, or the folder. Absent for a repository with no
   * checkout here yet: it is cloned (into project.discover's clone_dir) when a chat first works in it.
   */
  path: optionalKey(Schema.String),
  /** The part of the repository this project is about, from its top level ("apps/web"): agents are pointed at it. */
  focus: optionalKey(Schema.String),
}).annotate({ identifier: "ProjectSource" });
export type ProjectSource = typeof ProjectSource.Type;

/**
 * A project's mark, drawn in place of its folder (Project.logo). project.list carries only its `id`, a short hash of
 * the image's bytes, so the list every client polls stays small: a client fetches the image once per id
 * (project.logo.read) and keeps it.
 */
export const ProjectLogo = Schema.Struct({
  id: Schema.String,
  /** The file it came from, relative to the project's root; absent for an upload or the repository owner's avatar. */
  path: optionalKey(Schema.String),
  /** Detected in the checkout (project.update `logo: "auto"`, the default): nobody picked it. */
  auto: optionalKey(Schema.Literal(true)),
}).annotate({ identifier: "ProjectLogo" });
export type ProjectLogo = typeof ProjectLogo.Type;

/** An image project.logo.candidates found for a project's logo: `url` a `data:image/...` URL of at most 256 KiB. */
export const ProjectLogoCandidate = Schema.Struct({
  /** Relative to the project's root; absent for the owner's avatar. */
  path: optionalKey(Schema.String),
  url: Schema.String,
  /** favicon: where web apps keep one (what "auto" shows comes first); file: a tracked file named like a logo; owner: the GitHub owner's avatar. */
  source: Schema.Literals(["favicon", "file", "owner"]),
  /**
   * The logo now: the file "auto" shows, or the file the person picked, while its bytes are still the ones picked.
   * Never an upload or the avatar.
   */
  current: optionalKey(Schema.Literal(true)),
}).annotate({ identifier: "ProjectLogoCandidate" });
export type ProjectLogoCandidate = typeof ProjectLogoCandidate.Type;

/**
 * A repository on this computer that chats start in: the sidebar's folders.
 * One per repository top level; every workspace made from a repository
 * belongs to that repository's project. A folder in no repository is a
 * project too (`no_git`).
 */
export const Project = Schema.Struct({
  id: Id,
  /** Shown in the sidebar; the folder's name unless renamed. */
  name: Schema.String,
  /** Absolute path of the repository's top level (realpath), or of the plain folder. */
  path: Schema.String,
  /**
   * A plain folder in no git repository: its chats run in the folder itself, with no
   * worktree, branch, diff, checkpoints or pull request (their `branch` and `base_ref`
   * are empty). project.init_git makes it a repository. Absent for a repository.
   */
  no_git: optionalKey(Schema.Literal(true)),
  /** Its origin remote on a git host; absent for a repository with no origin. */
  repository: optionalKey(RepositoryLink),
  /**
   * Its mark, drawn in place of the folder: the person's pick, else (unless they chose none) the favicon or app icon
   * the runtime finds in the checkout, marked `auto`. Absent: the folder.
   */
  logo: optionalKey(ProjectLogo),
  /** How its logo is chosen (project.update `logo`): "none", the folder; "picked", the person's image. Absent: auto. */
  logo_mode: optionalKey(Schema.Literals(["none", "picked"])),
  /** The user's own instructions for this repository, private to this computer; every engine gets them after AGENTS.md. */
  instructions: optionalKey(Schema.String),
  /**
   * Paths hidden from file search, @ mentions, the file panel and the agents'
   * file tools, in gitignore syntax, on top of the repository's committed
   * .cavemanignore. Hidden, not secured: a shell command can still read them.
   */
  ignorePaths: optionalKey(Strings),
  /** Permissions for its new chats, over Settings.default_access; absent = the environment default. */
  default_access: optionalKey(AccessMode),
  /** The model its new chats start on, by EngineId, over Settings.engines[id].model; an engine absent here follows Settings. */
  default_models: optionalKey(Schema.Record(Schema.String, Schema.String)),
  /**
   * Set by the runtime, never the person: where an engine's default_model (Auto) can't run in this project (its Claude
   * settings send Claude Code to another endpoint or a cloud lane), the model its new chats start on instead, by
   * EngineId. A configured Auto gives way to it too; default_models and Settings come first otherwise.
   */
  engine_default_models: optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The user's own actions for this repository, private to this computer; the team's are in .caveman/actions.toml (actions.list). */
  actions: optionalKey(Schema.Array(ProjectAction)),
  /**
   * The repositories that share its plugins: everyone working in any of them
   * gets the plugins installed for the project. Its own `repository` first.
   * Kept in Caveman Cloud when signed in (a repository belongs to at most one
   * project there), else on this computer.
   */
  repos: optionalKey(Schema.Array(RepositoryLink)),
  /**
   * What the project is made of, its own repository (or folder) first: the repositories of `repos`, each with where it
   * is checked out here, and on a Mac its plain folders. A chat works in one or more of them (workspace.create's
   * `sources`), and a Cloud computer of the project checks out the repositories. Absent for a project with one
   * source, which is its own repository or folder (projectSources reads both forms).
   */
  sources: optionalKey(Schema.Array(ProjectSource)),
  /**
   * When the person pinned it, kept through later pins: pinned projects lead the sidebar and every project picker,
   * in the order they were pinned (a chat's Workspace.inbox.pinned_at, for projects). Absent when not pinned.
   */
  pinned_at: optionalKey(IsoDateTime),
  /**
   * When the person archived it: it leaves the project pickers, and the sidebar keeps it under Archived projects
   * (its folder stays, last, while a chat in it is not archived). Its chats, settings and files are kept; unarchiving
   * brings it back as it was. Absent when not archived.
   */
  archived_at: optionalKey(IsoDateTime),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
}).annotate({ identifier: "Project" });
export type Project = typeof Project.Type;

/** Where project.discover found a candidate. */
export const ProjectCandidateSource = Schema.Literals(["claude", "codex", "cursor", "vscode", "folder", "github"]);
export type ProjectCandidateSource = typeof ProjectCandidateSource.Type;

/** A repository worth adding as a project (project.discover). */
export const ProjectCandidate = Schema.Struct({
  /** Repository top level on this computer; absent when it is only on the git host. */
  path: optionalKey(Schema.String),
  name: Schema.String,
  repository: optionalKey(RepositoryLink),
  /**
   * claude / codex: Claude Code or Codex sessions ran in it. cursor / vscode:
   * that editor opened the folder (read from the editor's own history on this
   * computer, never sent anywhere). folder: a git checkout next to ones you
   * use. github: one of your GitHub repositories.
   */
  sources: Schema.Array(ProjectCandidateSource),
  /** Claude Code and Codex sessions that ran in it. */
  sessions: Count,
  /** Last session, commit or checkout here; for a host-only repository, its last push. */
  last_active_at: optionalKey(IsoDateTime),
  /** Already a project: picking it selects that project. */
  project_id: optionalKey(Id),
  private: optionalKey(Schema.Boolean),
}).annotate({ identifier: "ProjectCandidate" });
export type ProjectCandidate = typeof ProjectCandidate.Type;

/** Where the runtime's GitHub login comes from: Caveman Cloud's lease, this computer's `gh`, or GH_TOKEN in its environment. */
export const GitHubLoginSource = Schema.Literals(["cloud", "gh", "env"]);
export type GitHubLoginSource = typeof GitHubLoginSource.Type;

/** One open issue of a project's repository on GitHub (github.issues). */
export const GitHubIssue = Schema.Struct({
  number: Count,
  title: Schema.String,
  /** The issue's page on github.com. */
  url: Schema.String,
  created_at: IsoDateTime,
  /** Label names. */
  labels: Strings,
  /** The runtime's GitHub login is one of its assignees. */
  assigned_to_me: Schema.Boolean,
}).annotate({ identifier: "GitHubIssue" });
export type GitHubIssue = typeof GitHubIssue.Type;

/** grill: the engine interviews the user in rounds of questions before anything is built (README: Grill mode). */
export const SessionMode = Schema.Literals(["default", "grill"]).annotate({ identifier: "SessionMode" });

export const Session = Schema.Struct({
  id: Id,
  workspace_id: Id,
  engine: EngineId,
  /** The engine's own handle (Claude session id, Codex thread id). Evidence, not identity. */
  engine_session_ref: optionalKey(Schema.String),
  state: Schema.Literals(["live", "parked"]),
  /** Which computer may write this session. Absent while parked. */
  lease: optionalKey(Schema.Struct({ computer_id: Id, expires_at: IsoDateTime })),
  /** Cursor of the newest event. */
  head: Cursor,
  forked_from: optionalKey(Schema.Struct({ session_id: Id, cursor: Cursor })),
  /** The mode turns run in, from the last turn.submit that set one. Absent = default. */
  mode: optionalKey(SessionMode),
  /** The permissions it runs with; absent on a session from before the runtime reported them. */
  access: optionalKey(AccessMode),
  /** Moves (ADR 0126): it copies its history to Caveman Cloud after each turn, so it can continue on another computer. */
  follow: optionalKey(Schema.Literal(true)),
  /** Moves: the runtime it last moved here from (Continue on This Mac goes back to it). */
  moved_from: optionalKey(Schema.Struct({ runtime_id: Id })),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
}).annotate({ identifier: "Session" });
export type Session = typeof Session.Type;

/** `checking`: the engine's first probe since the runtime started has not finished. */
export const AuthState = Schema.Literals(["signed_in", "signed_out", "api_key", "unavailable", "checking"]);

/**
 * The last test of a key: ok; failing (the provider refused it, or the call
 * failed); limited (rate limit or quota: the key works). Absent = never tested.
 */
export const KeyHealth = Schema.Struct({
  state: Schema.Literals(["ok", "failing", "limited"]),
  message: optionalKey(Schema.String),
  checked_at: IsoDateTime,
}).annotate({ identifier: "KeyHealth" });
export type KeyHealth = typeof KeyHealth.Type;

/** An account's short tag: two or three letters or digits, upper case. */

/** A subscription login's quota windows (Claude's five hours and week, Codex's), as its engine reports them. */
const UsageLimits = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
    used_percent: Schema.Number,
    resets_at: optionalKey(IsoDateTime),
  }),
);

/** What a connection the person made once is (README: Sign in once): a plan's sign-in, a key, or a gateway. */
export const ConnectionKind = Schema.Literals(["claude_plan", "chatgpt_plan", "copilot", "supergrok", "api_key", "gateway"]).annotate({ identifier: "ConnectionKind" });
export type ConnectionKind = typeof ConnectionKind.Type;

/** An account that is a connection kept in Caveman Cloud, as Cloud last said it. Never a credential. */
export const AccountConnection = Schema.Struct({
  kind: ConnectionKind,
  /**
   * `ready`; `used_up` until `used_up_until` (the next account in order runs meanwhile); `expired` or `revoked`: the
   * provider no longer takes it, and the person connects it again.
   */
  status: Schema.Literals(["ready", "used_up", "expired", "revoked"]),
  used_up_until: optionalKey(IsoDateTime),
  /** When it ends (a Claude plan's token lasts a year): clients ask to reconnect a month before. */
  expires_at: optionalKey(IsoDateTime),
  /** This Caveman Cloud switched connections of this kind off: it is listed and not used. */
  off: optionalKey(Schema.Literal(true)),
}).annotate({ identifier: "AccountConnection" });
export type AccountConnection = typeof AccountConnection.Type;

/**
 * One account an engine runs on. Labels only (an email, "OpenAI API key ...4f2a"); never a credential.
 *
 * An engine's accounts are listed in the order they are tried: the connections the person made once (README: Sign in
 * once), in their order, then this computer's own logins and keys.
 */
export const EngineAccount = Schema.Struct({
  id: Id,
  label: Schema.String,
  kind: Schema.Literals(["login", "api_key"]),
  /** The account new chats on this engine run on. */
  active: Schema.Boolean,
  /**
   * Where the account works. `everywhere`: a connection kept sealed in Caveman Cloud, which runs this engine on this
   * computer and on every Cloud computer of the person's. `cloud`: such a connection that this computer does not run
   * on (it serves their Cloud computers). `this_mac`: a login or key kept on this computer only. Absent from a
   * runtime before connections: this computer.
   */
  where: optionalKey(Schema.Literals(["everywhere", "cloud", "this_mac"])),
  /** An `everywhere` or `cloud` account's state. */
  connection: optionalKey(AccountConnection),
  /** Caveman engine: whose key it is (engine.providers id). */
  provider: optionalKey(Schema.String),
  health: optionalKey(KeyHealth),
  /** Two or three letters that tell this account apart wherever its agents show (engine.account.tag). */
  tag: optionalKey(AccountTag),
  /** A login of its own (one of several Claude or ChatGPT logins): its own quota windows. */
  usage_limits: optionalKey(UsageLimits),
});
export type EngineAccount = typeof EngineAccount.Type;

export const EngineDescriptor = Schema.Struct({
  id: EngineId,
  /** "Caveman", "Claude Agent", "Codex", or the ACP agent's name. */
  label: Schema.String,
  capabilities: Schema.Struct({
    structured: Schema.Boolean,
    fork: Schema.Boolean,
    steer: Schema.Boolean,
    interrupt: Schema.Boolean,
    tool_hooks: Schema.Boolean,
    resume_across_machines: Schema.Boolean,
    approvals: Schema.Boolean,
    plans: Schema.Boolean,
    subagents: Schema.Boolean,
    images: Schema.Boolean,
    mcp: Schema.Boolean,
    /** Takes `TurnOptions.mode: "grill"` (README: Grill mode). */
    grill_mode: optionalKey(Schema.Boolean),
    /** `session.restore`: files and transcript back to a turn's checkpoint. */
    restore: optionalKey(Schema.Boolean),
    /** `goal.set` reaches the engine's own goal (Codex); without it the runtime prepends the goal to each turn. */
    native_goal: optionalKey(Schema.Boolean),
    /** A turn of just `/compact` compacts the engine's own context (Claude Agent's /compact, Codex's thread/compact). */
    compact: optionalKey(Schema.Boolean),
    /**
     * Its Anthropic and OpenAI traffic goes through the app's caveman-proxy, compression on (OpenCode:
     * those two providers on OpenCode 2; its others go direct). False: the harness talks only to its
     * vendor's own service (Cursor, Muse), so nothing on this computer can shorten it.
     */
    proxy: optionalKey(Schema.Boolean),
  }),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      efforts: Strings,
      default_effort: optionalKey(Schema.String),
      /**
       * The speeds it offers past standard, slowest first: Claude Agent's fast mode ("fast"), Codex's service tiers
       * ("fast", "ultrafast"). Absent: standard only. A turn names one in TurnOptions.speed.
       */
      speeds: optionalKey(Strings),
      /** The speed a turn naming none runs at, when it is one of `speeds`; absent is standard. */
      default_speed: optionalKey(Schema.String),
      /** Older or less common models: the picker lists them under "More models". */
      legacy: optionalKey(Schema.Boolean),
      description: optionalKey(Schema.String),
      /**
       * The engine version this model needs, newer than the installed one (Claude Code 2.1.280 for Opus 5.5). Listed
       * so the person sees it; the runtime updates Claude Code by its own updater, and until then a turn runs on the
       * older CLI. `description` says so. Absent: the installed engine runs it.
       */
      needs_version: optionalKey(Schema.String),
    }),
  ),
  /**
   * The model a new chat starts on when neither its project (Project.default_models) nor Settings > General
   * (Settings.engines[id].model) names one: Auto while Caveman can route this engine, else the engine's own default.
   * Clients apply the project and the setting first, as workspace.create does.
   */
  default_model: optionalKey(Schema.String),
  /** Access modes this engine honours; absent means all three. */
  access_modes: optionalKey(Schema.Array(AccessMode)),
  auth: Schema.Struct({
    state: AuthState,
    accounts: Schema.Array(EngineAccount),
    message: optionalKey(Schema.String),
    /**
     * No sign-in or key is taken on this computer (a Cloud computer whose person's credentials stay outside it): the
     * engine runs on what the person connected in Settings > Models & keys, and `message` says what is missing.
     * Clients offer no sign-in and no key field for it here. No other key of the person's is taken there either:
     * web.keys.set, a chief.voice.key that sets one, secret_provider.save, a secret_slot.set that sets `ref`,
     * credential.grant, and an mcp.add or marketplace.add whose command line or URL carries a key answer
     * `unsupported` with where it is done instead, and clients offer no field for them.
     */
    no_sign_in_here: optionalKey(Schema.Literal(true)),
    /**
     * This engine's plan can be connected once for every computer (README: Sign in once): Claude Agent's Claude plan,
     * Codex's ChatGPT plan. `available`: engine.account.add `everywhere` connects it from this computer. `off`: this
     * Caveman Cloud switched that kind off, so the engine runs on this computer's own login. `manage`: connected and
     * removed from the person's own device (a Cloud computer takes no sign-in). Absent: this computer is not signed in
     * to Caveman, or the engine has no such connection; everything is as before connections.
     */
    everywhere: optionalKey(Schema.Literals(["available", "off", "manage"])),
    /**
     * A plan of this agent is being connected from this computer right now (engine.account.add `everywhere`): the
     * official CLI's sign-in is open and waits for the person's approval in a browser on this computer. Every client
     * hears it start and end (engine.changed). `request_id`: the engine.account.add that started it, so the client that
     * sent it knows the sign-in is its own; only engine.account.remove of `connecting:<request_id>` ends it.
     */
    connecting: optionalKey(Schema.Struct({ request_id: Schema.String, since: IsoDateTime })),
  }),
  version: optionalKey(Schema.String),
  upgrade: optionalKey(Schema.Struct({ version: optionalKey(Schema.String), hint: Schema.String })),
  /** A subscription login's quota windows (Claude's five hours and week, Codex's), as the engine reports them: the active login's. */
  usage_limits: optionalKey(UsageLimits),
  /** A plan window is full and turns run on the account's credits instead (Codex). */
  usage_on_credits: optionalKey(Schema.Boolean),
}).annotate({ identifier: "EngineDescriptor" });
export type EngineDescriptor = typeof EngineDescriptor.Type;

/** One of an engine's own slash commands (engine.commands): typed at the start of a message, the engine runs it. */
export const EngineCommand = Schema.Struct({
  name: Schema.String,
  description: optionalKey(Schema.String),
  /** What it takes after its name, as the engine words it ("[focus]"). */
  hint: optionalKey(Schema.String),
}).annotate({ identifier: "EngineCommand" });
export type EngineCommand = typeof EngineCommand.Type;

/** A provider the Caveman engine takes (engine.providers): what Models & keys needs to add its key. */
export const EngineProvider = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** featured and more: catalog providers; local: endpoint presets (Ollama, LM Studio, Ollama Cloud); credits: Caveman credits (Settings > Account). */
  group: Schema.Literals(["featured", "more", "local", "credits"]),
  /** Where Models & keys lists a featured provider or preset. A subscription sign-in (sign_in_plan) also shows under Subscriptions. */
  section: optionalKey(Schema.Literals(["keys", "plans", "gateways"])),
  /**
   * key: a pasted key; optional_key: an endpoint that may need none; account: turned on from Settings > Account;
   * cli: a harness that signs in with its own CLI (engine.account.add's sign_in says how).
   */
  auth: Schema.Literals(["key", "optional_key", "account", "cli"]),
  key_label: optionalKey(Schema.String),
  key_url: optionalKey(Schema.String),
  /** Settings besides the key (a region): sent as engine.account.add `fields`. */
  fields: optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        label: Schema.String,
        placeholder: optionalKey(Schema.String),
        optional: optionalKey(Schema.Boolean),
        /** A choice, not free text: render a select. The first is the default. */
        options: optionalKey(Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String }))),
      }),
    ),
  ),
  /** engine.account.signin works for it (OpenRouter, ChatGPT). */
  sign_in: optionalKey(Schema.Boolean),
  /** The sign-in button's words ("Sign in with ChatGPT"). */
  sign_in_label: optionalKey(Schema.String),
  /** The subscription the sign-in runs on ("ChatGPT"); absent when it hands back a key (OpenRouter). */
  sign_in_plan: optionalKey(Schema.String),
  /** Only the sign-in: there is no key to paste (GitHub Copilot). */
  sign_in_only: optionalKey(Schema.Boolean),
  /** Coding plans billed through their key: usage counts as the plan's. */
  plan: optionalKey(Schema.Boolean),
  /** Local presets: the usual address. */
  base_url: optionalKey(Schema.String),
}).annotate({ identifier: "EngineProvider" });
export type EngineProvider = typeof EngineProvider.Type;

/**
 * A provider the Caveman engine's web tools take a person's own key for: the web_search
 * providers, and Firecrawl, which reads the pages web_fetch can't on its own.
 */
export const WebSearchProvider = Schema.Literals(["brave", "perplexity", "exa", "firecrawl"]).annotate({ identifier: "WebSearchProvider" });
export type WebSearchProvider = typeof WebSearchProvider.Type;

/**
 * Each web provider's key (set or not, its last four characters, and whether the provider refused it at search or
 * read time), whether Caveman credits are on, and whether Firecrawl Local is installed on the runtime's computer
 * (web_fetch then reads pages with it; absent from older runtimes).
 */
export const WebKeys = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({ id: WebSearchProvider, configured: Schema.Boolean, hint: optionalKey(Schema.String), refused: optionalKey(Schema.Boolean) }),
  ),
  credits: Schema.Boolean,
  firecrawl_local: optionalKey(Schema.Boolean),
}).annotate({ identifier: "WebKeys" });
export type WebKeys = typeof WebKeys.Type;

/**
 * A secret in a secret manager (1Password), by the provider entry that reads it (SecretProviderInfo.id) and the
 * provider's own reference syntax (`op://vault/item/field`). Not itself a secret: settings keep it as written. The
 * value it names is read on this computer when it is used, and never stored, logged or sent to a client.
 */
export const SecretRef = Schema.Struct({
  provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  reference: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
}).annotate({ identifier: "SecretRef" });
export type SecretRef = typeof SecretRef.Type;

/** Settings > Secret providers: one secret manager this runtime reads secrets from. Never a credential. */
export const SecretProviderInfo = Schema.Struct({
  /** A slug of its name, what a SecretRef's `provider` names. */
  id: Schema.String,
  /** `one_password`; a kind this build cannot read keeps its name and label (`supported` false). */
  kind: Schema.String,
  label: Schema.String,
  supported: Schema.Boolean,
  /** 1Password through the app on this computer: the account `op --account` signs in to. */
  account: optionalKey(Schema.String),
  /** 1Password as a service account: its token is kept sealed on this computer and never sent back. */
  service_account: optionalKey(Schema.Boolean),
  /** A service account whose token is stored. */
  has_token: optionalKey(Schema.Boolean),
}).annotate({ identifier: "SecretProviderInfo" });
export type SecretProviderInfo = typeof SecretProviderInfo.Type;

/**
 * A credential setting that can point at a secret manager instead of holding a pasted value.
 * engine_env: an environment variable of an engine account (its provider instance), such as CURSOR_API_KEY. Never
 * Claude Agent's: it runs on the person's own login. source_control: a source control host's credential: GitHub's
 * token for `server_host`, Bitbucket's `accessToken` or `apiToken`.
 */
export const SecretSlotTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("engine_env"), instance_id: Schema.String, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("source_control"), host: Schema.String, field: Schema.String, server_host: optionalKey(Schema.String) }),
]).annotate({ identifier: "SecretSlotTarget" });
export type SecretSlotTarget = typeof SecretSlotTarget.Type;

export const SecretSlot = Schema.Struct({
  target: SecretSlotTarget,
  /** What it is, as Settings shows it: "Cursor · CURSOR_API_KEY", "GitHub token · github.com". */
  label: Schema.String,
  group: Schema.Literals(["engine", "source_control"]),
  /** Where it reads from now; absent when it holds a pasted value or nothing. */
  ref: optionalKey(SecretRef),
  /** A pasted value is stored for it (setting a reference replaces it). Never the value. */
  has_value: Schema.Boolean,
  /** Why its last read failed, one sentence. Absent when it was read, or not tried since the last refresh. */
  problem: optionalKey(Schema.String),
}).annotate({ identifier: "SecretSlot" });
export type SecretSlot = typeof SecretSlot.Type;

export const SecretProviders = Schema.Struct({
  providers: Schema.Array(SecretProviderInfo),
  slots: Schema.Array(SecretSlot),
}).annotate({ identifier: "SecretProviders" });
export type SecretProviders = typeof SecretProviders.Type;

/** A key's test call: ok, or why not (auth: the provider refused the key; limit: rate limit or quota, the key works). */
export const KeyTestResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), model: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), kind: Schema.Literals(["auth", "limit", "network", "other"]), message: Schema.String }),
]).annotate({ identifier: "KeyTestResult" });

export const PanelContribution = Schema.Struct({
  id: Id,
  title: Schema.String,
  placement: Schema.Literals(["workspace_tab", "settings"]),
  /**
   * What the client loads in a sandboxed frame (README: Plugin panels): an
   * https URL, or a path the runtime serves from the plugin's own directory.
   */
  entry: Schema.String.check(
    Schema.isPattern(/^(?:https:\/\/\S+|(?![/\\])(?!.*(?:^|\/)\.\.(?:\/|$))[^\s:\0\\]+)$/),
  ),
}).annotate({ identifier: "PanelContribution" });

/** A tool one of the plugin's MCP servers offers, listed in the app's tool palette. */
export const PluginTool = Schema.Struct({
  name: Schema.String,
  title: optionalKey(Schema.String),
  description: optionalKey(Schema.String),
  /** The plugin MCP server that serves it. */
  server: Schema.String,
}).annotate({ identifier: "PluginTool" });

/** A service the plugin reaches. `credentials` are names the broker supplies, never values. */
export const PluginConnector = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: optionalKey(Schema.String),
  server: optionalKey(Schema.String),
  credentials: optionalKey(Strings),
  /** Which of `credentials` the user has granted to the plugin's marketplace (plugin.list). */
  granted: optionalKey(Strings),
}).annotate({ identifier: "PluginConnector" });

/** One hook of a plugin: the event, its matcher, and the command as declared (before the runtime contains it). */
export const PluginHookEntry = Schema.Struct({
  event: Schema.String,
  matcher: optionalKey(Schema.String),
  /** `command`, `prompt` or `agent`. */
  type: Schema.String,
  command: optionalKey(Schema.String),
  /** Exec form: argv for `command`, no shell. */
  args: optionalKey(Strings),
  /** A `prompt` hook's text. */
  prompt: optionalKey(Schema.String),
}).annotate({ identifier: "PluginHookEntry" });

export const PluginInfo = Schema.Struct({
  id: Id,
  /** Shown to people; `id` is for calls and keys only. */
  name: Schema.String,
  version: optionalKey(Schema.String),
  description: optionalKey(Schema.String),
  enabled: Schema.Boolean,
  skills: Strings,
  commands: Strings,
  agents: Strings,
  hooks: Strings,
  mcp_servers: Strings,
  panels: Schema.Array(PanelContribution),
  /** Optional on the wire: runtimes before these fields omit them; read as empty. */
  tools: optionalKey(Schema.Array(PluginTool)),
  connectors: optionalKey(Schema.Array(PluginConnector)),
  lsp_servers: optionalKey(Strings),
  monitors: optionalKey(Strings),
  /**
   * How its processes are kept from the user's files and the runtime's state:
   * the macOS sandbox, bubblewrap (Linux), or only the environment filter.
   */
  containment: optionalKey(Schema.Literals(["macos_sandbox", "bubblewrap", "env_filter"])),
  /** Parts left out, and why, one line each. */
  problems: optionalKey(Strings),
  /** Whether its hooks run (plugin.set_trusted); an untrusted plugin's hooks reach no engine. */
  trusted: optionalKey(Schema.Boolean),
  /**
   * It was trusted, and its hooks are off now: its files changed since, or the
   * trust predates trust by content (an update, a migrated Space). Trusting it
   * again turns them back on.
   */
  trust_dropped: optionalKey(Schema.Boolean),
  /**
   * Estimated tokens it adds to every request while idle: its rules, skills
   * index and the tool schemas its MCP servers last listed, at 4 bytes a
   * token. An estimate from bytes, never a measured count.
   */
  idle_tokens_estimate: optionalKey(Count),
  /** Its MCP servers that have not listed their tools yet, so count 0 in the estimate. */
  unmeasured_servers: optionalKey(Strings),
  /** Per MCP server that has listed its tools through the hub: their schemas at 4 bytes a token, an estimate. */
  server_idle_tokens_estimate: optionalKey(Schema.Record(Schema.String, Count)),
  /** Its MCP servers that speak SSE: only Claude Agent and ACP agents reach those (Codex and the Caveman engine have no SSE). */
  sse_servers: optionalKey(Strings),
  /**
   * Each hook in the plugin's hooks/hooks.json and its manifest's `hooks`, as
   * declared: what runs once the plugin is trusted. Hooks in skill, command or
   * agent frontmatter (Claude Agent only, while that item is in use) are not
   * listed. Hook types the runtime cannot contain are left out here too (they
   * are in `problems`).
   */
  hook_entries: optionalKey(Schema.Array(PluginHookEntry)),
}).annotate({ identifier: "PluginInfo" });

/** Who gets an installed plugin: only me, everyone working in a project's repositories, or everyone in the org. */
export const PluginScope = Schema.Literals(["me", "project", "team"]).annotate({ identifier: "PluginScope" });
export type PluginScope = typeof PluginScope.Type;
/** A project or team install: offered in the marketplace, on for everyone until they turn it off, or on and locked. */
export const PluginPolicy = Schema.Literals(["available", "default", "required"]).annotate({ identifier: "PluginPolicy" });
export type PluginPolicy = typeof PluginPolicy.Type;

/**
 * How a plugin presents itself, from its manifest's Codex `interface` block,
 * else its Claude fields (description, author.name, homepage), else its
 * marketplace entry. Absent fields were not given; nothing is invented.
 */
export const PluginInterface = Schema.Struct({
  display_name: optionalKey(Schema.String),
  short_description: optionalKey(Schema.String),
  developer: optionalKey(Schema.String),
  /** The marketplace entry's category wins over the plugin's own. */
  category: optionalKey(Schema.String),
  /** An http(s) URL, or a `data:` URL of an image file in the plugin (at most 64 KiB). */
  logo: optionalKey(Schema.String),
  logo_dark: optionalKey(Schema.String),
  /** CSS colours as the manifest gives them (`#rrggbb`). */
  brand_color: optionalKey(Schema.String),
  brand_color_dark: optionalKey(Schema.String),
  capabilities: optionalKey(Strings),
}).annotate({ identifier: "PluginInterface" });

/** What a plugin brings, counted; absent parts are 0. */
export const PluginIncludes = Schema.Struct({
  skills: Count,
  mcp_servers: Count,
  /** Its MCP servers that sign in to a service (auth oauth or github). */
  connections: Count,
  hooks: Count,
  commands: Count,
  agents: Count,
  rules: Count,
}).annotate({ identifier: "PluginIncludes" });

/** One of a plugin's MCP servers that signs in, for plugin.connect. */
export const ConnectTarget = Schema.Struct({
  plugin_id: Id,
  /** The server's name in the plugin; plugin.connect takes it. */
  server: Schema.String,
  /** The service, as people know it (Linear, Slack). */
  title: Schema.String,
  auth: Schema.Literals(["oauth", "github"]),
  /** Why it cannot be connected yet (no registered app for the service); absent when it can. */
  unavailable: optionalKey(Schema.String),
  /** The team's shared account for a shared install: an org admin connects it (plugin.connect with `shared`); members cannot. */
  shared: optionalKey(Schema.Boolean),
}).annotate({ identifier: "ConnectTarget" });

/**
 * A plugin in a marketplace (plugin.list), installed or not. The PluginInfo
 * fields describe its files: complete for an installed plugin or one in a
 * marketplace read in place; empty lists for a remote entry not yet fetched.
 */
export const PluginSummary = Schema.Struct({
  ...PluginInfo.fields,
  /** `name@marketplace`. */
  id: Id,
  marketplace: Schema.String,
  /** Installed for me, my project or my team. */
  installed: Schema.Boolean,
  /** The widest scope it is installed at; absent when not installed. */
  scope: optionalKey(PluginScope),
  /** A project or team install's policy; absent for me. */
  policy: optionalKey(PluginPolicy),
  /** A project or team install's sign-in: each person connects (personal) or everyone uses the account an admin connected (shared). */
  connection: optionalKey(Schema.Literals(["personal", "shared"])),
  /**
   * The open repository suggests it (its marketplace installs it by default,
   * or its .claude/settings.json enables it). Off until the person turns it on
   * for this repository with plugin.set_enabled and `cwd`.
   */
  suggested: optionalKey(Schema.Boolean),
  /**
   * The open project's own switch (plugin.set_enabled with `cwd` and `here`), present only where it differs from
   * every other project: `off` is off in this project alone, `on` is on in this project alone. `enabled` already
   * says which.
   */
  here: optionalKey(Schema.Literals(["on", "off"])),
  /** On and locked by a team or project Required install: plugin.set_enabled refuses to turn it off. */
  required: Schema.Boolean,
  interface: PluginInterface,
  includes: PluginIncludes,
  /** It is on and one of its servers has no working sign-in. */
  needs_connect: Schema.Boolean,
  /** The marketplace entry's policy: offered (available), on at install (installed_by_default), hidden (not_available). */
  installation: optionalKey(Schema.Literals(["available", "installed_by_default", "not_available"])),
  /** When to sign in: right after install (on_install, the default) or at first tool use. */
  authentication: optionalKey(Schema.Literals(["on_install", "on_use"])),
}).annotate({ identifier: "PluginSummary" });
export type PluginSummary = typeof PluginSummary.Type;

/** plugin.read: everything the detail page shows. */
export const PluginDetail = Schema.Struct({
  ...PluginSummary.fields,
  long_description: optionalKey(Schema.String),
  /** Prompts to try it with, at most 3 of at most 128 characters. */
  default_prompts: Strings,
  links: Schema.Struct({ website: optionalKey(Schema.String), privacy: optionalKey(Schema.String), terms: optionalKey(Schema.String) }),
  screenshots: optionalKey(Strings),
  skill_details: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
  server_details: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      transport: Schema.Literals(["stdio", "http", "sse"]),
      auth: optionalKey(Schema.Literals(["oauth", "github"])),
      /** For a server that signs in: whether a working sign-in exists. */
      connected: optionalKey(Schema.Boolean),
      /** Not connected: why, when it had a sign-in that stopped working (a reconnect, not a first sign-in) or it failed. */
      problem: optionalKey(Schema.String),
      held_by: optionalKey(Schema.Literals(["cloud", "this_computer"])),
      unavailable: optionalKey(Schema.String),
      /** A shared install's server: the sign-in in use is the team's account an admin connected, not the person's own. */
      shared: optionalKey(Schema.Boolean),
      /** Who connected the team's account, as Caveman Cloud names them. */
      shared_by: optionalKey(Schema.String),
    }),
  ),
  /** Its rules/*.md files by name. */
  rules: Strings,
  /** Which of its parts reach each engine. */
  engines: Schema.Array(Schema.Struct({ engine: EngineId, gets: Strings, misses: Strings })),
  /** Where it comes from: a git URL at a commit, a folder, or the Caveman catalog. */
  source: Schema.String,
  commit: optionalKey(Schema.String),
}).annotate({ identifier: "PluginDetail" });
export type PluginDetail = typeof PluginDetail.Type;

/** A catalog of plugins (marketplace.list). */
export const MarketplaceInfo = Schema.Struct({
  /** Its `marketplace.json` name; the part after `@` in its plugins' ids. */
  name: Schema.String,
  display_name: Schema.String,
  /**
   * caveman: shipped in the app. team: added by your org in Caveman Cloud.
   * personal: ~/.agents/plugins/marketplace.json. repo: declared by the open
   * repository. added: a git repository or folder you added.
   */
  kind: Schema.Literals(["caveman", "team", "personal", "repo", "added"]),
  /** A git URL, an absolute folder path, or `caveman` for the built-in catalog. */
  source: Schema.String,
  /** A git marketplace: the branch, tag or commit Update follows; absent means HEAD. */
  ref: optionalKey(Schema.String),
  /** A git marketplace: the commit it is pinned to. */
  commit: optionalKey(Schema.String),
  plugin_count: Count,
  /** A git marketplace's checkout. */
  status: optionalKey(Schema.Literals(["ready", "checking_out", "failed"])),
  problems: Strings,
  /**
   * Whether a project or team install of its plugins reaches teammates: yes
   * (the Caveman catalog, a team marketplace), add_to_team (a git marketplace
   * only this person has: an org admin installs with `add_to_team`, which adds
   * it to the team first), no (a folder on this computer).
   */
  shareable: optionalKey(Schema.Literals(["yes", "add_to_team", "no"])),
}).annotate({ identifier: "MarketplaceInfo" });
export type MarketplaceInfo = typeof MarketplaceInfo.Type;

/** An item import.scan found, by where it came from, its kind and name; import.apply takes it back. */
export const ImportItemRef = Schema.Struct({
  from: Schema.Literals(["claude", "codex", "cursor"]),
  kind: Schema.Literals(["marketplace", "plugin", "skill", "mcp_server", "instructions"]),
  name: Schema.String,
}).annotate({ identifier: "ImportItemRef" });

/** One thing another agent's setup has, and what importing does with it. */
export const ImportItem = Schema.Struct({
  ...ImportItemRef.fields,
  /** A marketplace's URL, a plugin's id, a server's command or URL, a file's path. Never a secret value. */
  detail: Schema.String,
  /** add: a marketplace is added. install: a plugin is installed for me. import: copied into my setup. available: already read in place, nothing to do. skip: cannot be imported (reason). */
  action: Schema.Literals(["add", "install", "import", "available", "skip"]),
  reason: optionalKey(Schema.String),
  /** Credential names it will need granted; their values were never read. */
  credentials: optionalKey(Strings),
  /**
   * An MCP server another setup lists too, the same command or URL: that setup's row (its `from` and config `name`,
   * which may be spelled differently) imports it, with the keys both ask for (action available).
   */
  same_as: optionalKey(Schema.Struct({ from: Schema.Literals(["claude", "codex", "cursor"]), name: Schema.String })),
}).annotate({ identifier: "ImportItem" });

/** Claude Code, Codex or Cursor on this computer (import.scan). */
export const ImportSource = Schema.Struct({
  from: Schema.Literals(["claude", "codex", "cursor"]),
  /** Its config folder was found. */
  found: Schema.Boolean,
  items: Schema.Array(ImportItem),
}).annotate({ identifier: "ImportSource" });

const EngineDefaults = Schema.Struct({
  /**
   * Settings > General > New chats: the model a new chat on this engine starts on (a project's default_models
   * overrides it); absent = the engine's default_model, Auto where offered. A pick in the composer applies to its
   * chat only and never writes it; the ones older composers saved here were dropped once (2026-10-18).
   */
  model: optionalKey(Schema.String),
  /**
   * Counts only with `model` (saved together); a new model drops it. Read only where Settings.model_defaults names no
   * effort for that model; nothing writes it since model_defaults (2026-10-31).
   */
  effort: optionalKey(Schema.String),
  account_id: optionalKey(Id),
});
/** Where a model starts (Settings.model_defaults): its effort and speed, each one the model offers. */
const ModelStart = Schema.Struct({ effort: optionalKey(Schema.String), speed: optionalKey(Schema.String) });
const Theme = Schema.Literals(["system", "dark", "light"]);
const NotificationSettings = Schema.Struct({
  needs_input: Schema.Boolean,
  turn_done: Schema.Boolean,
  /** A Chief's reply, while the app is in the background. Absent: on. A Chief's ask follows needs_input. */
  chief_messages: optionalKey(Schema.Boolean),
});
/** Interface text: 15, 16, 18 or 20 px for the root size every text size scales from. */
const TextSize = Schema.Literals(["small", "default", "large", "larger"]);
/** Code, terminal and diff font. */
const MonoFont = Schema.Literals(["jetbrains_mono", "sf_mono", "menlo"]);
const Density = Schema.Literals(["comfortable", "compact"]);
/** "#rrggbb": the only colour form a theme carries, so a theme can never smuggle CSS into the page. */
const HexColor = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/));
/**
 * One appearance of a colour theme: 16 colours the client spreads over every
 * surface, text, state, chart, code and terminal colour.
 */
export const ThemePalette = Schema.Struct({
  /** The sidebar and the margin around the working panel. */
  shell: HexColor,
  /** The working panel. */
  panel: HexColor,
  /** Cards, menus and fields above the panel. */
  raised: HexColor,
  /** A hovered or selected row. */
  hover: HexColor,
  border: HexColor,
  text: HexColor,
  /** Secondary text, comments. */
  dim: HexColor,
  /** Buttons, focus and the selected item. */
  accent: HexColor,
  red: HexColor,
  orange: HexColor,
  yellow: HexColor,
  green: HexColor,
  cyan: HexColor,
  blue: HexColor,
  purple: HexColor,
  pink: HexColor,
}).annotate({ identifier: "ThemePalette" });
export type ThemePalette = typeof ThemePalette.Type;
/** A theme the user imported (a VS Code theme file or an Open VSX extension); at least one appearance. */
export const CustomTheme = Schema.Struct({
  /** "custom:<slug>": never collides with a built-in. */
  id: Schema.String.check(Schema.isPattern(/^custom:[a-z0-9][a-z0-9-]{0,63}$/)),
  name: Schema.String.check(Schema.isPattern(/^[^\0\n]{1,64}$/)),
  /** Where it came from, as "<namespace>.<name>" for Open VSX or the file name. */
  source: optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  dark: optionalKey(ThemePalette),
  light: optionalKey(ThemePalette),
}).annotate({ identifier: "CustomTheme" });
export type CustomTheme = typeof CustomTheme.Type;
/** Most imported themes a runtime keeps. */
export const MAX_CUSTOM_THEMES = 40;
const CustomThemes = Schema.Array(CustomTheme).check(Schema.isMaxLength(MAX_CUSTOM_THEMES));
/** What sends a message: Enter (Shift+Enter is a new line) or ⌘/Ctrl+Enter (Enter is a new line). */
const SendShortcut = Schema.Literals(["enter", "mod_enter"]);

/** A pinned runner: a review guide's, or (with `always`) a role's or task kind's in Settings > Subagents. */
const SubagentRolePin = Schema.Struct({ engine: EngineId, instance_id: Id, model: Schema.String, effort: optionalKey(Schema.String) });
/**
 * A role's or task kind's pin. `always`: it outranks the lead's own pick of a harness or model too; absent, the lead's
 * pick wins (prefer).
 */
const SubagentPin = Schema.Struct({ ...SubagentRolePin.fields, always: optionalKey(Schema.Boolean) });

/**
 * Settings > Subagents: what delegated agents (delegate_task) may do. The runtime enforces them;
 * settings.get always reports the values in force.
 */
const SubagentSettings = Schema.Struct({
  /** How deep delegated agents nest (1-8). Default 2. */
  subagent_max_depth: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
  /** Delegated agents working at once under one chat (1-64). Default 8. */
  subagent_max_concurrent: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
  /**
   * auto: Caveman Cloud picks the harness and model from what is connected, by the agent's role; without a
   * linked Cloud (or when it can't answer) it runs as auto-by-role. auto-by-role: the person's role pin or agent
   * type model wins, else agents inherit the lead's selection. Default auto.
   */
  subagent_default_model: optionalKey(Schema.Literals(["auto", "auto-by-role", "inherit"])),
  /**
   * A role's pinned harness account, model and effort, for the role the lead names. It outranks a task kind's pin and
   * Auto; the lead's own choice outranks it unless the pin says `always`. null clears a role (patch).
   */
  subagent_role_pins: optionalKey(
    Schema.Struct(
      Object.fromEntries(SubagentRole.literals.map((role) => [role, optionalKey(Schema.NullOr(SubagentPin))])) as {
        readonly [R in SubagentRole]: Schema.optionalKey<Schema.NullOr<typeof SubagentPin>>;
      },
    ),
  ),
  /**
   * A task kind's pinned runner: a delegated agent whose lead names no role (or general) runs on the pin for the kind
   * the task classifier reads its brief as, and so does a new chat started with new_chat_by_task. Below a named role's
   * pin, above general's and Auto. null clears a kind (patch).
   */
  subagent_task_pins: optionalKey(
    Schema.Struct(
      Object.fromEntries(TaskKind.literals.map((kind) => [kind, optionalKey(Schema.NullOr(SubagentPin))])) as {
        readonly [K in TaskKind]: Schema.optionalKey<Schema.NullOr<typeof SubagentPin>>;
      },
    ),
  ),
  /**
   * A new chat started from the New chat page runs on its task kind's pin (subagent_task_pins), read from its first
   * message; a kind with no pin, or one that can't run now, starts on the model the page shows. Default false.
   */
  new_chat_by_task: optionalKey(Schema.Boolean),
  /** Uncached input plus output tokens all delegated agents under one chat may use; 0 = no ceiling. Default 5,000,000. Never shown in a session. */
  subagent_tree_token_ceiling: optionalKey(Count),
});

/**
 * Settings > Models & keys > Claude Agent: when an idle Claude Agent chat over 200,000 tokens of context is compacted
 * (T3 Code's compactIdleThreads, which the runtime's idle compaction and Claude's resume prompt read). on_return:
 * Claude offers to compact when you come back to the chat, the default. before_cache_expires (beta): the runtime sends
 * /compact as a visible turn shortly before the chat's prompt cache expires, so coming back reads the short summary
 * from cache instead of the whole chat uncached. off: never, and Claude's resume prompt is skipped. settings.get
 * reports the value in force.
 */
export const ClaudeIdleCompaction = Schema.Literals(["on_return", "before_cache_expires", "off"]).annotate({
  identifier: "ClaudeIdleCompaction",
});
export type ClaudeIdleCompaction = typeof ClaudeIdleCompaction.Type;

/** One Snooze menu choice: a wait from the pick, or a local time on a day. */
export const SnoozeOption = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("after"), minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 * 24 * 60 })) }),
  Schema.Struct({
    kind: Schema.Literal("at"),
    day: Schema.Literals(["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
    time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  }),
]).annotate({ identifier: "SnoozeOption" });
export type SnoozeOption = typeof SnoozeOption.Type;

/**
 * Settings > General > Inbox: when the runtime marks a chat done by itself (T3 Code's auto-settle, which keeps
 * them in its settings; a pinned chat, one that asks something, works or waits never is), and when it archives
 * one that stayed done. settings.get reports the values in force.
 */
const InboxSettings = Schema.Struct({
  /** Done when its pull request merges (a closed one always is). Default on. */
  inbox_done_on_merge: optionalKey(Schema.Boolean),
  /** Done after this many days with nothing new; null = never. 1-90, default 3. */
  inbox_done_after_days: optionalKey(Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })))),
  /** The quiet days never mark a chat with a pull request done (its merge or close still does). Default off. */
  inbox_keep_pull_requests: optionalKey(Schema.Boolean),
  /**
   * The Snooze menu's choices, up to 8 (T3 Code's snoozePresets): `after` wakes that many minutes from the pick
   * (1 to 30 days), `at` wakes at a local `HH:MM` on `today`, `tomorrow` or the next given weekday. Default: 1 hour,
   * 3 hours, today 18:00, tomorrow 09:00, Monday 09:00.
   */
  inbox_snooze_options: optionalKey(Schema.Array(SnoozeOption).check(Schema.isMaxLength(8))),
  /**
   * Archive a chat once it has been done this many days (its uncommitted work kept, as workspace.archive does);
   * absent or null = never, the default. 1-90. Kept by the runtime, not T3.
   */
  inbox_archive_done_after_days: optionalKey(Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })))),
});

/** Settings > Memory. */
const MemorySettings = Schema.Struct({
  /** Memory for every engine and session. Absent = on. Off removes the copy, the brief and Claude Agent's own memory. */
  memory_enabled: optionalKey(Schema.Boolean),
});

/**
 * Settings > Work > Chief. The runtime enforces the numbers in code (never in
 * the Chief's prompt); settings.get reports the values in force.
 */
const ChiefSettings = Schema.Struct({
  /**
   * Chats the Chiefs keep running at once (1-20); 0 or absent = no limit (the default). Past it, an item waits as
   * blocked on capacity, and starts when one finishes or the limit is raised.
   */
  chief_max_concurrent: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  /**
   * What the Chief and the chats it started may spend in a day, in US dollars
   * (measured usage only); 0 or absent = no cap (the default). Past it, an
   * item waits as blocked on the cap.
   */
  chief_daily_cap_usd: optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * Turns the Chief and the chats it started may take in a day; 0 or absent =
   * no cap (the default). It holds where spend is not measured (a Claude plan's turns
   * cost $0 here but count against the plan's limits). Past it, as the $ cap.
   */
  chief_daily_turns: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
  /**
   * Before Chiefs had profiles: the one Chief's model. A runtime from then reads it once, as it upgrades, and never
   * again.
   */
  chief_model: optionalKey(Schema.NullOr(Schema.Struct({ engine: Schema.String, model: Schema.String, effort: optionalKey(Schema.String), account_id: optionalKey(Id) }))),
  /**
   * How much a Chief does without asking, for a Chief that picked none of its own (ChiefProfile.autonomy). 1 ask: it proposes new chats it is unsure of
   * and asks before acting. 2 start (default): it starts chats itself, proposes only past chief_ask_above_chats, and
   * answers chats' questions when it can. 3 manage: it proposes nothing and asks only what is critical, going ahead with its own
   * answer at once. The daily and concurrency limits hold at every level, and no level lets a Chief approve a
   * permission prompt, answer a secret request, merge a pull request or push to a protected branch.
   */
  chief_autonomy: optionalKey(Schema.Literals([1, 2, 3])),
  /** How often and how thoroughly a Chief tells the person what its chats did (ChiefUpdates), for a Chief that picked none (ChiefProfile.updates). Default milestones. */
  chief_updates: optionalKey(Schema.Literals(["results", "milestones", "everything"])),
  /** Below autonomy 3, a note that needs more chats than this is proposed, not started. Default 3. */
  chief_ask_above_chats: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  /**
   * Minutes a Chief waits for the person to answer its question before it goes ahead with the answer it
   * recommended (0-1440); 0 = it always waits. Default 15. A question the Chief marks as only the person's
   * to settle always waits, and approvals and secret requests are never the Chief's to answer.
   */
  chief_ask_wait_minutes: optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1440 }))),
  /** The desktop's global capture shortcut, as an Electron accelerator. Default Control+Alt+Space. */
  chief_capture_shortcut: optionalKey(Schema.String),
  /**
   * Before Chiefs had profiles: the one Chief's rules. A runtime from then reads them once, as it upgrades, into
   * that Chief's soul, and never again.
   */
  chief_rules: optionalKey(Schema.String),
  /**
   * The soul every Chief shares, in markdown (default empty): standing instructions about the person, the first
   * section of every Chief's prefix, before its own soul. A `## Crew rules` section goes to every chat any Chief
   * starts. An edit reaches each Chief's next turn.
   */
  chief_soul: optionalKey(Schema.String),
  /** Calls (chief.voice.*): the voice the Chief speaks in on a call, by its id in chief.get `voice.voices`. Default the engine's first. */
  chief_voice_name: optionalKey(Schema.String),
  /** Ring you when work you handed off on a call is ready (chief.voice.ringing), so it can walk you through it. Default on. Off: muted until you turn it back on. */
  chief_voice_ring_back: optionalKey(Schema.Boolean),
  /**
   * Rings muted until this time ("Mute for 15 minutes", "until tomorrow morning"): what would have rung arrives
   * quietly (chief.voice.ringing with `muted: true`) and stays on the board. null or past: not muted this way.
   */
  chief_voice_ring_muted_until: optionalKey(Schema.NullOr(IsoDateTime)),
  /**
   * How long a call waits on a pause before it takes your turn as done, and
   * how long words you handed off wait for more before they become one note.
   * Default normal; patient for slow talkers and thinking out loud.
   */
  chief_voice_patience: optionalKey(Schema.Literals(["quick", "normal", "patient"])),
  /**
   * Smart View: a Chief may open what is worth a look (a pull request ready for review, a chat, a picture, a page) in
   * the sidebar beside its chat, by the rules in smartView.ts. Default on. Off: its opens do nothing and it is told so.
   */
  chief_smart_view: optionalKey(Schema.Boolean),
});

/**
 * Settings > Work > Review: when a pull request gets its guide, how deep it goes, and who writes it. The runtime
 * enforces them (T3's reviewGuide* server settings); settings.get reports the values in force.
 */
const ReviewSettings = Schema.Struct({
  /** Guides on this computer. Off hides the Guide tab and writes none, for people and agents alike. Default on. */
  review_guides: optionalKey(Schema.Boolean),
  /**
   * Write a guide before anyone opens the pull request: one that asks for your review or is yours, when your
   * subscription is idle, and one a chat opens or links, at once. Default on.
   */
  review_prewarm: optionalKey(Schema.Boolean),
  /**
   * A short change's guide is its TL;DR and the one call, if any; the diff is the rest. Short means at most this
   * many changed lines of code and tests (lockfiles, generated and vendored files not counted). 0 = always the
   * full tour. 0-2000, default 30.
   */
  review_short_lines: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2000 }))),
  /**
   * The chat that opened a pull request writes its TL;DR in the same turn (link_pull_request `tldr`), on the
   * context its model already holds: a short change then needs no other model run, a long one starts with it.
   * Default on.
   */
  review_chat_tldr: optionalKey(Schema.Boolean),
  /**
   * A pull request a chat here opens gets its guide as one comment on the host, edited as the guide is rewritten,
   * so reviewers without Caveman Code read it there (pr.post_guide posts one by hand). Default on.
   */
  review_post: optionalKey(Schema.Boolean),
  /** The model that writes guides; null (patch) or absent = Auto: the cheapest guide model, a subscription before a key. */
  review_model: optionalKey(Schema.NullOr(SubagentRolePin)),
  /**
   * A guide a person asked for that misses the quality check is written once more on the same engine's next
   * model up (Haiku to Sonnet, Codex low to medium effort). Never for one written ahead. Default on.
   */
  review_step_up: optionalKey(Schema.Boolean),
  /** A diff of code and tests up to this many KB is read in one call; a larger one from a checkout. 8-512, default 48. */
  review_single_pass_kb: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 512 }))),
  /** Guides written ahead by a model in a day (0 = templates only). 0-200, default 20. */
  review_prewarm_daily: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
  /** Written ahead only while the fullest plan window is under this percent. 10-100, default 70. */
  review_prewarm_plan_percent: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 100 }))),
  /** Written ahead only after this many minutes with no turn on the writer's engine. 0-60, default 2. */
  review_prewarm_idle_minutes: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60 }))),
  /** Your taste for guides in plain words: what to dwell on, skip or order first. Never the format. At most 4,000 characters. */
  review_instructions: optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  /** How chats are named, in plain words ("two to four words, no articles"): every generated title follows it. At most 2,000 characters. */
  thread_title_instructions: optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
});

/** A note in memory as the Memory panel shows it (memory.*). Never its cost. */
export const MemoryNote = Schema.Struct({
  id: Id,
  /** me: holds in every repository; project: one repository's. */
  scope: Schema.Literals(["me", "project"]),
  /** The repository's memory id (`github.com/owner/name`, or `local/<root commit>`); null for me. */
  repo: Schema.NullOr(Schema.String),
  path: Schema.String,
  name: Schema.String,
  /** "" for a forgotten version (memory.history). */
  text: Schema.String,
  /**
   * told: the user's words; team: reviewed; draft: saved by an agent, out of the brief unless pinned.
   * learned: only on notes an older runtime's dreams confirmed (retired 2026-10-17); out of the brief unless pinned.
   */
  authority: Schema.Literals(["told", "team", "learned", "draft"]),
  /** Traced to outside content (web, third-party tools): never in a brief until the user keeps it. */
  tainted: Schema.Boolean,
  pinned: Schema.Boolean,
  /** Why the runtime or an agent doubts it. */
  suspect: Schema.NullOr(Schema.String),
  added: Schema.String,
  updated_at: IsoDateTime,
  by: Schema.String,
  /** The chat it was learned in. */
  thread: Schema.NullOr(Schema.Struct({ workspace_id: Id, title: Schema.String })),
  vid: Schema.String,
  /** How often the note reached a session (pushed, recalled, queried or acted on) and when last; null when never. */
  uses: optionalKey(Schema.NullOr(Schema.Struct({ count: Count, last_at: IsoDateTime }))),
  /** Why we know it: what the writer claimed, the words it restates, the files and URL it cites, Claude's Why and How. */
  provenance: optionalKey(
    Schema.Struct({
      /** The writer's claim: `session:<thread>`, `user`, `import:claude:<file>`, a URL. */
      source: Schema.String,
      quote: optionalKey(Schema.String),
      cites: optionalKey(Schema.Array(Schema.String)),
      url: optionalKey(Schema.String),
      why: optionalKey(Schema.String),
      how: optionalKey(Schema.String),
    }),
  ),
}).annotate({ identifier: "MemoryNote" });
export type MemoryNote = typeof MemoryNote.Type;

export const MemoryStatus = Schema.Struct({
  enabled: Schema.Boolean,
  /** Notes that aren't drafts (told, team, learned), drafts, and quarantined notes. */
  notes: Count,
  drafts: Count,
  unverified: Count,
  /** The brief a session would get now outside any repository, in tokens (4 characters each). */
  brief_tokens: Count,
  /** memory_sql works on this runtime (node:sqlite's authorizer, Node 24.15+). */
  sql: Schema.Boolean,
  /** Claude Agent's own memories still to import once (consent), or done. */
  claude_import: Schema.Struct({ available: Count, imported: Schema.Boolean }),
}).annotate({ identifier: "MemoryStatus" });

/** A subagent type delegate_task can start by name (agent.types). */
export const AgentTypeInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** builtin: investigator, builder, reviewer. user: ~/.caveman/agents. plugin: an enabled plugin. project: the project's .caveman/agents or .claude/agents. */
  source: Schema.Literals(["builtin", "user", "plugin", "project"]),
  model: optionalKey(Schema.String),
  tools: optionalKey(Strings),
  /** The harness it runs on, from its file's engine; absent: the new-chat default. */
  engine: optionalKey(EngineId),
  /** The values it decides (its final `decision:` line), which automation steps branch on. */
  decides: optionalKey(Strings),
  /** Its file, repo-relative for project agents (`.caveman/agents/<name>.md`); absent for built-ins. */
  path: optionalKey(Schema.String),
}).annotate({ identifier: "AgentTypeInfo" });
export type AgentTypeInfo = typeof AgentTypeInfo.Type;

/**
 * Where a Queue item stands (chief.*). unsorted: captured, not triaged yet;
 * queued: ready, waiting its turn; proposed: the Chief suggests starting it
 * and waits for you (Start all, chief.start); blocked: waits on `blocked_on`;
 * scheduled: starts at `not_before`; started: its chats run; review: a chat
 * finished with changes or a pull request, which waits on the person (their
 * review or merge); needs_you: a chat asks, or failed, or its pull request was
 * closed, has failing checks or changes requested (`detail` says which); done
 * and dropped fold into Done today. A merged pull request moves its item to
 * done with nobody touching it.
 */
export const ChiefItemState = Schema.Literals([
  "unsorted",
  "queued",
  "proposed",
  "blocked",
  "scheduled",
  "started",
  "review",
  "needs_you",
  "done",
  "dropped",
]).annotate({ identifier: "ChiefItemState" });
export type ChiefItemState = typeof ChiefItemState.Type;

/** What a blocked item waits on: another item, you, the Chief's concurrency limit, or its daily cap. */
export const ChiefBlock = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("item"), item_id: Id }),
  Schema.Struct({ kind: Schema.Literal("you"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("capacity") }),
  Schema.Struct({ kind: Schema.Literal("cap") }),
]).annotate({ identifier: "ChiefBlock" });
export type ChiefBlock = typeof ChiefBlock.Type;

/** Where a Queue item came from. chief: the Chief added it itself. */
/** voice: said on a call (chief.voice.*), the person's own words as transcribed. attached: a chat the person added to a Chief's board (chief.attach); its text is the chat's title, never their words. */
/** attached: a chat the person added (chief.attach). topic: a chat its group put there (ChiefProfile.topics), which leaves when it leaves the group. */
export const ChiefItemSource = Schema.Literals(["composer", "capture", "cli", "voice", "github", "automation", "chief", "attached", "topic"]);

/** An image a note carries, as the attachment store keeps it: a reference, never the bytes (the Chief's turn and the chats it hands it to read the file). */
export const ChiefAttachment = Schema.Struct({ id: Id, name: Schema.String, mime_type: Schema.String, size_bytes: Schema.Number }).annotate({ identifier: "ChiefAttachment" });
export type ChiefAttachment = typeof ChiefAttachment.Type;

/**
 * What a chat showed of its work: the screenshots its latest answer ended with (<ui_proof>), in order, each with its
 * caption (its alt text), so a run of them reads as a walkthrough. Copied into the attachment store under the Chief's
 * thread when the turn ended, so they outlive the temp folder they were saved in, and the Chief passes them on by id
 * (chat_start, chat_send) as it does a note's images. `path`: the stored file, for media.read with the Chief's workspace.
 */
export const ChiefProofImage = Schema.Struct({ ...ChiefAttachment.fields, caption: Schema.String, path: Schema.String }).annotate({ identifier: "ChiefProofImage" });
export type ChiefProofImage = typeof ChiefProofImage.Type;
export const ChiefProof = Schema.Struct({
  /** The chat that showed it. */
  workspace_id: Id,
  /** The turn whose answer it ended. */
  turn_id: optionalKey(Id),
  at: IsoDateTime,
  images: Schema.Array(ChiefProofImage),
}).annotate({ identifier: "ChiefProof" });
export type ChiefProof = typeof ChiefProof.Type;

/** The model a Chief thinks with, picked as in a chat's composer: an engine and a model (`account_id`: which login). */
export const ChiefModelPick = Schema.Struct({ engine: Schema.String, model: Schema.String, effort: optionalKey(Schema.String), account_id: optionalKey(Id) }).annotate({ identifier: "ChiefModelPick" });
export type ChiefModelPick = typeof ChiefModelPick.Type;

/**
 * A Chief's pixel character, from the mascot cast (the app's ui mascot/cast.ts): caveman, cavewoman, elder, kid,
 * one of the animals (mammoth to petrock, the CastCharacter list), or `custom:<id>` for a companion someone made. `tone`: its skin (the animals show none).
 */
export const ChiefAvatar = Schema.Struct({
  character: Schema.String.check(Schema.isPattern(/^(caveman|cavewoman|elder|kid|mammoth|sabertooth|wolf|bear|rhino|sloth|glyptodon|bison|elk|boar|beaver|owl|bat|dino|trike|ptero|petrock|custom:[a-z0-9][a-z0-9-]{0,39})$/)),
  tone: Schema.Literals(["light", "medium-light", "medium", "medium-dark", "dark"]),
}).annotate({ identifier: "ChiefAvatar" });
export type ChiefAvatar = typeof ChiefAvatar.Type;

/**
 * How often and how thoroughly a Chief tells the person what its chats did. The runtime decides which chat changes wake
 * the Chief at all (the board shows every one), and the Chief's prompt how much it says:
 * - results: only work that is ready (done, or for review with its checks through), a failure it can't fix by steering
 *   the chat, and a decision that needs the person. A pull request whose checks are still running waits quietly.
 * - milestones (default): also a pull request opening, checks going red or green, and a chat's question it answered.
 * - everything: every change as it happens.
 * At every level a change that says nothing new (the same state, report and pull request as last heard) wakes nobody,
 * and a question only the person can answer, an approval, a failure and a pull request to merge always get through.
 */
export const ChiefUpdates = Schema.Literals(["results", "milestones", "everything"]);
export type ChiefUpdates = typeof ChiefUpdates.Type;
/** How much a Chief does without asking (Settings.chief_autonomy): 1 ask, 2 start, 3 manage. */
export const ChiefAutonomyLevel = Schema.Literals([1, 2, 3]);
export type ChiefAutonomyLevel = typeof ChiefAutonomyLevel.Type;

/**
 * One Chief (chief.list): a coordinator chat the person hands missions to. Chiefs are the person's, never a
 * project's: each works in the projects it lists (`project_ids`; none listed: every project). The first is made when
 * a call first needs one (chief.get); chief.create adds more. Each is its own workspace of kind chief (`id` is that
 * workspace's id). They share one board and one set of limits (Settings > Chief); each item is on one Chief's board
 * (`ChiefItem.chief_id`). Any Chief can be called (chief.voice.start `chief_id`).
 */
export const ChiefProfile = Schema.Struct({
  id: Id,
  name: Schema.String,
  avatar: ChiefAvatar,
  /** What it thinks and replies with; null: Auto, on the fast floor of what is connected. */
  model: Schema.NullOr(ChiefModelPick),
  /**
   * Permissions for the chats it starts: what they may do without asking. null: what a new chat in that project
   * takes (the project's default_access, else Settings.default_access), as a chat you start would.
   */
  access: Schema.NullOr(AccessMode),
  /**
   * For older clients, which show a Chief under one project and list its routines by it: set when `project_ids` is
   * exactly one project, to that one. Nothing routes by it; read `project_ids`.
   */
  project_id: optionalKey(Id),
  /**
   * Sent only by a runtime from 2026-11-15 to 17, which refuses to remove a project's default Chief: a client offers no
   * Remove on one. Never sent now; any Chief can be removed.
   */
  project_default: optionalKey(Schema.Literal(true)),
  /** The projects it works in (project.list): it sees and starts chats only there. Empty: every project, new ones too. */
  project_ids: Schema.Array(Id),
  /** What it does, in one line of at most 140 characters ("I take recurring work off your plate"). Opens its prompt. Absent: none. */
  role: optionalKey(Schema.String),
  /**
   * Its soul: standing instructions in markdown, in its stable prefix after Settings.chief_soul. A `## Crew rules`
   * section goes to every chat it starts.
   */
  soul: Schema.String,
  /** Its own autonomy level; absent: Settings.chief_autonomy. */
  autonomy: optionalKey(ChiefAutonomyLevel),
  /** How often and how thoroughly it tells the person what its chats did (ChiefUpdates); absent: Settings.chief_updates. */
  updates: optionalKey(ChiefUpdates),
  /**
   * The groups it manages (Workspace.topic), set by chief.manage; each is one Chief's at most. A chat the title writer
   * names into one, or the person moves into one, goes on its board; moved out, it leaves. Absent: none.
   */
  topics: optionalKey(Schema.Array(Schema.String)),
  /** True only on a runtime's one Chief from before Chiefs had profiles, which works in every project like any other. Kept for older clients. */
  home: Schema.Boolean,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
}).annotate({ identifier: "ChiefProfile" });
export type ChiefProfile = typeof ChiefProfile.Type;

/** One Queue item: a note you captured, as the Chief sorts and starts it. Never its cost. */
export const ChiefItem = Schema.Struct({
  id: Id,
  /** Its number on its Chief's board, from 1, set when it is made and kept for life: the app shows CH-12, the Chief cites [[12]]. Absent from a runtime from before numbers. */
  number: optionalKey(Schema.Number),
  /** The Chief whose board it is on (ChiefProfile.id). Absent from a runtime with one Chief only. */
  chief_id: optionalKey(Id),
  /** Your words, verbatim. */
  text: Schema.String,
  /** The Chief's short name for it; absent until it is triaged. */
  title: optionalKey(Schema.String),
  /** What proves this mission done, trimmed, at most 280 characters; empty on update clears it. */
  done_when: optionalKey(Schema.String.check(Schema.isMaxLength(280))),
  /** How often its Chief looks in while it is open or running: every day or every week. */
  check_in: optionalKey(Schema.Literals(["day", "week"])),
  state: ChiefItemState,
  /** Queue order, ascending (a fractional index): items come sorted by it. */
  rank: Schema.Number,
  /** You placed it: the Chief never moves it. A drag pins it. */
  pinned: Schema.Boolean,
  /** The projects (project.list) it belongs to. */
  project_ids: Schema.Array(Id),
  change_set_id: optionalKey(Id),
  blocked_on: optionalKey(ChiefBlock),
  /** Starts, or wakes the Chief, no earlier than this. */
  not_before: optionalKey(IsoDateTime),
  /** needs_you: the chat's question or its error line. */
  detail: optionalKey(Schema.String),
  /**
   * The pull request of the chat doing it, as the runtime last saw it (Workspace.pull_request). The board follows it on
   * its own: merged moves the item to done; closed without merging, failing checks or changes requested move a review
   * item to needs_you (`detail` says which), and it goes back to review once the pull request is healthy again. Checks
   * that fail only as its base's do (`base_ci`) are not this pull request's: they never move it.
   */
  pull_request: optionalKey(PullRequest),
  /** The Chief asked the person about it (its `ask` tool) and waits for the answer. */
  asked: optionalKey(
    Schema.Struct({
      question: Schema.String,
      /** What the Chief would do: it goes ahead with this at `go_ahead_at` unless the person answers first. */
      recommended: Schema.String,
      asked_at: IsoDateTime,
      /** Absent: it waits for the person however long it takes (the Chief said only they can settle it, or the wait is 0). */
      go_ahead_at: optionalKey(IsoDateTime),
      /** The chat whose question it is, and its question card (ask.user) when it raised one. */
      workspace_id: optionalKey(Id),
      ask_id: optionalKey(Id),
    }),
  ),
  source: ChiefItemSource,
  /** The chats started for it, oldest first. */
  workspace_ids: Schema.Array(Id),
  /** The images sent with the note, in the runtime's attachment store: the Chief hands a chat one by its id (chat_start, chat_send). */
  attachments: optionalKey(Schema.Array(ChiefAttachment)),
  /** How much the person hears about this item's chats, over its Chief's level ("tell me everything about this one"); absent: its Chief's. */
  updates: optionalKey(ChiefUpdates),
  /** Its chats' latest screenshots, one entry per chat that showed any (ChiefProof). */
  proof: optionalKey(Schema.Array(ChiefProof)),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
}).annotate({ identifier: "ChiefItem" });
export type ChiefItem = typeof ChiefItem.Type;

/**
 * Linked chats for one change that spans repositories: one chat per repo,
 * sharing a contract (the agreed interface) and a merge order.
 */
export const ChiefChangeSet = Schema.Struct({
  id: Id,
  title: Schema.String,
  project_ids: Schema.Array(Id),
  contract: Schema.String,
  /** Project ids, first to merge first. */
  merge_order: Schema.Array(Id),
  state: Schema.Literals(["open", "done", "dropped"]),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
}).annotate({ identifier: "ChiefChangeSet" });
export type ChiefChangeSet = typeof ChiefChangeSet.Type;

/**
 * A routine: an automation with a `chief` output (packages/automations README, "A routine"). Each of its runs updates
 * this row; `decision` and `summary` are its last run's (`summary` is the step's report, at most 2,000 characters,
 * data from a command, never instructions). `chief_id`: the Chief its last run reported to (the one its file names,
 * else one that works in its project). Its schedule, Pause and Run now are its automation's (automation.list,
 * `automation_id`).
 */
export const ChiefRoutine = Schema.Struct({
  automation_id: Id,
  project_id: Id,
  chief_id: optionalKey(Id),
  name: Schema.String,
  run_id: Id,
  ran_at: IsoDateTime,
  status: Schema.Literals(["succeeded", "failed"]),
  decision: optionalKey(Schema.String),
  summary: Schema.String,
}).annotate({ identifier: "ChiefRoutine" });
export type ChiefRoutine = typeof ChiefRoutine.Type;

/**
 * The Chief's board: the Queue, in order, and its change sets. Done and
 * dropped items stay on it for 24 hours (Done today). `routines`: the last run
 * of each routine that reported to this Chief, newest first.
 */
export const ChiefBoard = Schema.Struct({
  items: Schema.Array(ChiefItem),
  change_sets: Schema.Array(ChiefChangeSet),
  routines: optionalKey(Schema.Array(ChiefRoutine)),
}).annotate({ identifier: "ChiefBoard" });
export type ChiefBoard = typeof ChiefBoard.Type;

/**
 * Smart View: something a Chief puts in the person's right sidebar, beside its chat. pr: a
 * pull request, on its guide unless `view` says otherwise; chat: a chat, live, read-only, one click from opening it;
 * image, video: a picture or a clip, by `url`, or by `path` in a chat's checkout (`workspace_id`); web: a page, loaded
 * by the person's own app. A new kind is a new member here plus its surface in the app (smart-view/targets.ts).
 */
export const SmartViewItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pr"), project_id: Id, number: Count, view: optionalKey(Schema.Literals(["guide", "discussion", "files"])) }),
  Schema.Struct({ kind: Schema.Literal("chat"), workspace_id: Id }),
  Schema.Struct({ kind: Schema.Literals(["image", "video"]), url: optionalKey(Schema.String), workspace_id: optionalKey(Id), path: optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("web"), url: Schema.String }),
]).annotate({ identifier: "SmartViewItem" });
export type SmartViewItem = typeof SmartViewItem.Type;

/**
 * One thing a Chief put in the sidebar (ChiefView.entries). `id` is the item's own key (smartView.ts smartViewKey), so
 * the same pull request is one entry however often it is opened. `seq` counts the times it was brought forward: a
 * client shows it again when it sees a higher one. `asked`: the person asked to see it, so it may take the front.
 * closed: by the person (its tab closed: chief.view.dismiss) or by the Chief; what the person closed stays closed a
 * while (smartView.ts SMART_VIEW_RULES).
 */
export const SmartViewEntry = Schema.Struct({
  id: Id,
  item: SmartViewItem,
  title: Schema.String,
  /** One line from the Chief: why this is worth a look. */
  note: optionalKey(Schema.String),
  asked: Schema.Boolean,
  opened_at: IsoDateTime,
  seq: Count,
  state: Schema.Literals(["open", "closed"]),
  closed_at: optionalKey(IsoDateTime),
  closed_by: optionalKey(Schema.Literals(["person", "chief"])),
}).annotate({ identifier: "SmartViewEntry" });
export type SmartViewEntry = typeof SmartViewEntry.Type;

/** What one Chief has put in the sidebar (chief.view.get, chief.view.updated): the whole list, which replaces the last. */
export const ChiefView = Schema.Struct({
  chief_id: Id,
  /** Settings chief_smart_view: off, a Chief opens nothing. */
  on: Schema.Boolean,
  entries: Schema.Array(SmartViewEntry),
}).annotate({ identifier: "ChiefView" });
export type ChiefView = typeof ChiefView.Type;

/**
 * A call with the Chief (chief.voice.*): one at a time per runtime. connecting: the client is opening the voice
 * engine's connection; live: talking; ended: over, `end_reason` says why. Never its cost.
 */
/**
 * What a call put on the person's screen (VoiceCall.showing): the work being walked through, as the app shows it.
 * pr: the pull request's Review page (`project_id`, `pr_number`; `path` opens one of its files); diff: the chat's
 * changes (`path` one file); chat: the chat itself. Every device of the owner shows it (a phone on a walk shows it
 * on the Mac); the voice's words are its caption.
 */
export const VoiceShowing = Schema.Struct({
  kind: Schema.Literals(["pr", "diff", "chat"]),
  item_id: Id,
  workspace_id: Id,
  title: Schema.String,
  project_id: optionalKey(Id),
  pr_number: optionalKey(Count),
  path: optionalKey(Schema.String),
  /** One short line for the screen: what this is. */
  caption: Schema.String,
}).annotate({ identifier: "VoiceShowing" });
export type VoiceShowing = typeof VoiceShowing.Type;

export const VoiceCall = Schema.Struct({
  id: Id,
  state: Schema.Literals(["connecting", "live", "ended"]),
  /** The voice engine (chief.get `voice.engine`), e.g. deepgram. */
  engine: Schema.String,
  started_at: IsoDateTime,
  /** When it went live; the call's length counts from here. */
  live_at: optionalKey(IsoDateTime),
  ended_at: optionalKey(IsoDateTime),
  /**
   * person: hung up; goodbye: the voice ended it after a goodbye; quiet: nobody spoke for a while; max_length; cap:
   * today's limit; connection_lost; runtime_restart; provider: the voice engine failed or refused.
   */
  end_reason: optionalKey(Schema.Literals(["person", "goodbye", "quiet", "max_length", "cap", "connection_lost", "runtime_restart", "provider"])),
  /** The client that holds the call ("This Mac", "iPhone"), as it named itself. */
  device: Schema.String,
  muted: Schema.Boolean,
  /** The board item it rang you about (a ring back answered), if any. */
  about_item_id: optionalKey(Id),
  /** The Chief on the call (ChiefProfile.id); absent from a runtime with one Chief only. */
  chief_id: optionalKey(Id),
  /** What the call is showing on the person's screens right now (chief.voice.updated carries each change); absent: nothing. */
  showing: optionalKey(VoiceShowing),
}).annotate({ identifier: "VoiceCall" });
export type VoiceCall = typeof VoiceCall.Type;

/**
 * How the client connects to the voice engine for a call (chief.voice.start). websocket: open `url` with these
 * subprotocols (a short-lived token or, on credits, Cloud's one-time ticket; never a key), send `settings` after the engine's first message, then stream
 * the mic as 16-bit PCM at `input_rate` and play what comes back at `output_rate`. Every JSON message the engine
 * sends goes to chief.voice.signal; what the runtime answers (and chief.voice.send) goes back to the engine as is.
 */
export const VoiceConnect = Schema.Struct({
  transport: Schema.Literal("websocket"),
  url: Schema.String,
  protocols: Schema.Array(Schema.String),
  settings: Schema.Unknown,
  input_rate: Count,
  output_rate: Count,
}).annotate({ identifier: "VoiceConnect" });
export type VoiceConnect = typeof VoiceConnect.Type;

/**
 * How the client connects to the voice engine to dictate into a box (dictation.start). websocket: open `url` with
 * these subprotocols (a short-lived token, never the key) and stream the mic as 16-bit PCM at `input_rate`. What the
 * engine sends back (the words, as they firm up) stays on the client; the runtime never sees the audio or the text.
 */
export const DictationConnect = Schema.Struct({
  transport: Schema.Literal("websocket"),
  url: Schema.String,
  protocols: Schema.Array(Schema.String),
  input_rate: Count,
}).annotate({ identifier: "DictationConnect" });
export type DictationConnect = typeof DictationConnect.Type;

/** Whether you can call the Chief now (chief.get `voice`), and with what. Never a cost. */
export const ChiefVoice = Schema.Struct({
  /**
   * ready; no_key: neither Caveman credits nor a key of the person's own for the voice engine (Settings > Chief >
   * Calls); cap: today's limit is reached; off: no calls on this runtime.
   */
  state: Schema.Literals(["ready", "no_key", "cap", "off"]),
  engine: Schema.String,
  /** The engine's name as Settings shows it. */
  engine_label: Schema.String,
  /** Where to get a key, and what kind of key it takes: Settings shows both. */
  key_url: Schema.String,
  key_help: Schema.String,
  /** The voices it offers, the default first. */
  voices: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, hint: Schema.String })),
  /** A stored key's last four characters, when there is one. */
  key_hint: optionalKey(Schema.String),
  /** Who pays for calls and dictation: key, the person's own key for the engine; credits, their Caveman credits (Cloud runs the engine). Absent: nothing does. */
  paid_by: optionalKey(Schema.Literals(["key", "credits"])),
  /**
   * Caveman credits, when the person has them and no key of their own here. on: calls and dictation run on them
   * (Caveman Cloud relays the engine on Caveman's key). unavailable: Cloud answered that it doesn't offer voice on
   * credits yet, so `state` is no_key until the runtime restarts or the person signs in again. Absent: their own key
   * pays, or they have no credits.
   */
  credits: optionalKey(Schema.Literals(["on", "unavailable"])),
  /** The call on now, on any device. */
  call: optionalKey(VoiceCall),
}).annotate({ identifier: "ChiefVoice" });
export type ChiefVoice = typeof ChiefVoice.Type;

/** An app on this Mac, as computer use names it: its name as macOS shows it, and its bundle id when known. */
export const ComputerApp = Schema.Struct({ name: Schema.String, bundle_id: optionalKey(Schema.String) }).annotate({ identifier: "ComputerApp" });
export type ComputerApp = typeof ComputerApp.Type;

/** A macOS privacy permission Caveman Code holds or lacks (System Settings > Privacy & Security). */
export const ComputerPermission = Schema.Literals(["granted", "denied", "unknown"]).annotate({ identifier: "ComputerPermission" });

/**
 * computer.access: whether agents can use apps on this computer. `supported` false where there is no local computer use
 * (a Cloud computer, which has its own desktop, or a computer without the agent-desktop binary), with `reason`.
 * Accessibility lets agents read and use apps; Screen Recording lets them, and you, see app windows.
 */
export const ComputerAccess = Schema.Struct({
  supported: Schema.Boolean,
  reason: optionalKey(Schema.String),
  accessibility: ComputerPermission,
  screen_recording: ComputerPermission,
  /** Apps no agent may use, whatever is allowed: terminals, password managers, Caveman Code itself, macOS security prompts. */
  blocked: Strings,
  /** The agent-desktop version that runs computer use here. */
  version: optionalKey(Schema.String),
}).annotate({ identifier: "ComputerAccess" });
export type ComputerAccess = typeof ComputerAccess.Type;

export const Settings = Schema.Struct({
  /**
   * The engine new chats, the Chief's chats and new automations start on. Until the person chooses one
   * (default_engine_chosen), the runtime's own: the Caveman engine wherever it can run on this computer (an API key,
   * a sign-in, Caveman credits or an endpoint it runs on is connected), else Claude Agent.
   */
  default_engine: EngineId,
  /**
   * Whether the person chose default_engine (Settings, first run). Absent or false: default_engine is the runtime's
   * own and follows what is connected. Set by the runtime whenever settings.set names a default_engine.
   */
  default_engine_chosen: optionalKey(Schema.Boolean),
  default_computer_id: Id,
  /** Keyed by EngineId. */
  engines: Schema.Record(Schema.String, EngineDefaults),
  /** Permissions for new chats (Settings > General); a project's default_access overrides it. Absent = full. */
  default_access: optionalKey(AccessMode),
  theme: Theme,
  notifications: NotificationSettings,
  /** Starred models in the picker, as "<engine>/<model>", in the user's order (⌘1..⌘9). */
  favorite_models: optionalKey(Strings),
  /**
   * The model picker's Home in the person's order, as "<engine>/<model>". Its first row is the default new chats start
   * on (default_engine and that engine's model), which leads Home whatever this says. Absent: the picker's own order.
   */
  home_models: optionalKey(Strings),
  /**
   * The person's own start for a model, keyed "<engine>/<model>" (the picker's level word, Settings > General): a turn that
   * names no effort or speed on that model starts there instead of at its default_effort and default_speed.
   */
  model_defaults: optionalKey(Schema.Record(Schema.String, ModelStart)),
  /** Remote control: this runtime keeps its Cloud link open so the user's other devices reach it. Absent = off. */
  remote_control: optionalKey(Schema.Boolean),
  /** Caveman Cloud's app origin for Remote control's sign-in. Absent = https://app.caveman.so; a local stack sets http://127.0.0.1:<port>. */
  cloud_url: optionalKey(Schema.String),
  /** True when CAVEMAN_CLOUD_URL pins cloud_url (an IT team's choice): Settings shows it, settings.set cannot change it. Absent = not pinned. */
  cloud_url_managed: optionalKey(Schema.Boolean),
  /** A Caveman co-author trailer on commits and a "Made with Caveman Code" footer on pull requests. Absent = on. */
  git_co_author: optionalKey(Schema.Boolean),
  /** Absent = default. */
  text_size: optionalKey(TextSize),
  /** Absent = jetbrains_mono. */
  mono_font: optionalKey(MonoFont),
  /** Absent = comfortable. */
  density: optionalKey(Density),
  /** Absent = enter. */
  send_shortcut: optionalKey(SendShortcut),
  /** A built-in theme id ("catppuccin-mocha") or a custom theme's id. Absent = the Caveman look. */
  color_theme: optionalKey(Schema.String),
  /** Imported themes, kept with the runtime so every client of it has them. */
  custom_themes: optionalKey(CustomThemes),
  /**
   * Cursor's plan limits read with its login from the macOS Keychain (Settings > Usage). Present only
   * where Cursor keeps its login there (a Mac runtime); absent elsewhere.
   */
  cursor_keychain_usage: optionalKey(Schema.Boolean),
  /**
   * After a completed Caveman engine, Claude Agent or Codex turn, the engine guesses the person's next message: the empty composer
   * shows it and Tab takes it. Each guess is one more request carrying the whole chat, on the engine's plan. Absent = off.
   */
  prompt_suggestions: optionalKey(Schema.Boolean),
  /** Get a project's Cloud setup ready in the background when it has a GitHub remote and a chat here. Absent = on. */
  cloud_prepare: optionalKey(Schema.Boolean),
  /** A failed Cloud build starts the setup chat by itself (it proposes; a person publishes). Default on. */
  cloud_auto_fix: optionalKey(Schema.Boolean),
  /**
   * Moves (ADR 0126): Caveman-engine chats copy their history and work in progress to Caveman Cloud after each turn
   * and move to a Cloud computer when the lid closes. Absent = not asked yet: on where this account has Cloud
   * computers, but nothing is copied until the person answers the chat's one-time notice (Keep on sets true).
   */
  move_to_cloud: optionalKey(Schema.Boolean),
  /**
   * Sync (Caveman Cloud ADR 0135): this Mac's chats, every engine's, copy to Caveman Cloud as they run, so the person's
   * other devices list and read them while this Mac sleeps. Absent = not asked yet: on where cloud.status `sync.available`,
   * but nothing is copied until the person answers the one-time notice. A Cloud computer's chats always sync.
   */
  sync_chats: optionalKey(Schema.Boolean),
  /**
   * Claude Agent and Codex chats move to a Cloud computer when the lid closes, as Caveman chats do, running there on
   * the person's Cloud login for that engine (a key in Caveman Cloud's vault, or a sign-in made on a Cloud computer).
   * Absent = on wherever that login exists; false keeps them on this Mac (the lid pauses them). Moving one by hand
   * (Move to) needs no setting.
   */
  move_other_engines: optionalKey(Schema.Boolean),
  /**
   * Keep this Mac awake while another device drives it (DESIGN S13): on power only, while a device drove a chat here
   * in the last 10 minutes or a chat it started still works. Idle sleep only, never the lid. Absent = on.
   */
  keep_awake_remote: optionalKey(Schema.Boolean),
  /** When an idle Claude Agent chat is compacted (ClaudeIdleCompaction). Absent = on_return. */
  claude_idle_compaction: optionalKey(ClaudeIdleCompaction),
  /**
   * Computer use on this Mac: agents see and use its apps in the background (the `desktop` tool), each app only once the
   * person allows it. False refuses every call; the tool stays listed. Absent = on. One computer's, never synced.
   */
  computer_use: optionalKey(Schema.Boolean),
  /** Apps agents may use on this Mac without asking (an approval's Always allow), in the order they were allowed. */
  computer_use_apps: optionalKey(Schema.Array(ComputerApp)),
  ...SubagentSettings.fields,
  ...MemorySettings.fields,
  ...ChiefSettings.fields,
  ...InboxSettings.fields,
  ...ReviewSettings.fields,
}).annotate({ identifier: "Settings" });
export type Settings = typeof Settings.Type;

/** settings.set: each key present replaces that key; absent keys are kept. */
export const SettingsPatch = Schema.Struct({
  default_engine: optionalKey(EngineId),
  default_computer_id: optionalKey(Id),
  engines: optionalKey(Schema.Record(Schema.String, EngineDefaults)),
  default_access: optionalKey(AccessMode),
  theme: optionalKey(Theme),
  notifications: optionalKey(NotificationSettings),
  favorite_models: optionalKey(Strings),
  home_models: optionalKey(Strings),
  /** Replaced whole, like `engines`. */
  model_defaults: optionalKey(Schema.Record(Schema.String, ModelStart)),
  remote_control: optionalKey(Schema.Boolean),
  cloud_url: optionalKey(Schema.String),
  git_co_author: optionalKey(Schema.Boolean),
  text_size: optionalKey(TextSize),
  mono_font: optionalKey(MonoFont),
  density: optionalKey(Density),
  send_shortcut: optionalKey(SendShortcut),
  color_theme: optionalKey(Schema.String),
  custom_themes: optionalKey(CustomThemes),
  cursor_keychain_usage: optionalKey(Schema.Boolean),
  prompt_suggestions: optionalKey(Schema.Boolean),
  cloud_prepare: optionalKey(Schema.Boolean),
  /** A failed Cloud build starts the setup chat by itself (it proposes; a person publishes). Default on. */
  cloud_auto_fix: optionalKey(Schema.Boolean),
  move_to_cloud: optionalKey(Schema.Boolean),
  sync_chats: optionalKey(Schema.Boolean),
  move_other_engines: optionalKey(Schema.Boolean),
  keep_awake_remote: optionalKey(Schema.Boolean),
  /** When an idle Claude Agent chat is compacted (ClaudeIdleCompaction). Absent = on_return. */
  claude_idle_compaction: optionalKey(ClaudeIdleCompaction),
  computer_use: optionalKey(Schema.Boolean),
  /** Replaced whole: Settings > Computer use removes an app by sending the rest. */
  computer_use_apps: optionalKey(Schema.Array(ComputerApp)),
  ...SubagentSettings.fields,
  ...MemorySettings.fields,
  ...ChiefSettings.fields,
  ...InboxSettings.fields,
  ...ReviewSettings.fields,
}).annotate({ identifier: "SettingsPatch" });

/**
 * One of the app's keyboard shortcuts: an `app.*` command and its key, as
 * "mod+shift+b" (mod is ⌘ on a Mac and Ctrl elsewhere), "ctrl+`" or "?".
 */
export const Keybinding = Schema.Struct({ command: Schema.String, key: Schema.String }).annotate({ identifier: "Keybinding" });
export type Keybinding = typeof Keybinding.Type;

// ---------------------------------------------------------- shared payloads

export const Attachment = Schema.Struct({
  type: Schema.Literals(["image", "file"]),
  name: Schema.String,
  mime_type: Schema.String,
  data: Schema.String,
  /** On message.done: a stored image too large to ride in `data` (empty), read with attachment.read. Ignored on input. */
  id: optionalKey(Schema.String.check(Schema.isMaxLength(256))),
}).annotate({ identifier: "Attachment" });

export const TurnInput = Schema.Struct({
  text: Schema.String,
  attachments: optionalKey(Schema.Array(Attachment)),
}).annotate({ identifier: "TurnInput" });
export type TurnInput = typeof TurnInput.Type;


export const TurnOptions = Schema.Struct({
  /** Run the next turn on this harness in the same app thread, handing off context when needed. */
  engine: optionalKey(EngineId),
  model: optionalKey(Schema.String),
  effort: optionalKey(Schema.String),
  /**
   * "standard" or one of the model's `speeds`. Absent, a chat on the same model keeps its own and a new chat starts at
   * Settings.model_defaults, else the model's default_speed. On turn.started: the speed it runs at, where it has any.
   */
  speed: optionalKey(Schema.String),
  /**
   * Which of the engine's logins runs the chat (an EngineAccount id: one of two Claude accounts). Absent, a
   * chat keeps its own and a new one takes the engine's active login. On turn.started: the login it runs on.
   */
  account_id: optionalKey(Id),
  access: optionalKey(AccessMode),
  /** grill: the engine grills the user before building; sticky until a turn sends `default`. Engines without `grill_mode` answer unsupported. */
  mode: optionalKey(SessionMode),
}).annotate({ identifier: "TurnOptions" });

export const TurnKind = Schema.Literals(["steer", "followup", "queue"]);

/** An input waiting for its turn (queue.*): its text as the user typed it. */
export const QueuedTurn = Schema.Struct({
  turn_id: Id,
  text: Schema.String,
  queued_at: IsoDateTime,
  /** Held by Stop: it waits for the next message or queue.resume. */
  held: optionalKey(Schema.Boolean),
  /** Another thread's agent sent it, not the person (as message.done's `from`). */
  from: optionalKey(Schema.Struct({ workspace_id: optionalKey(Id), title: Schema.String })),
  /** A scheduled task sent it on its schedule (as message.done's `scheduled_task`). */
  scheduled_task: optionalKey(Schema.Struct({ task_id: Id, title: optionalKey(Schema.String) })),
}).annotate({ identifier: "QueuedTurn" });

/** A personal MCP server (mcp.list): its command or URL, and credential names (never values) with whether each is granted. */
export const McpServerInfo = Schema.Struct({
  name: Schema.String,
  command: optionalKey(Schema.String),
  args: optionalKey(Strings),
  url: optionalKey(Schema.String),
  /** `oauth`: the runtime signs in and holds the tokens; `github`: the runtime's GitHub login. Only the runtime's MCP hub reaches it. */
  auth: optionalKey(Schema.Literals(["oauth", "github"])),
  source: Schema.Literals(["manual", "claude", "codex", "cursor", "connector"]),
  /** On for the folder mcp.list was asked about (everywhere, without one). */
  enabled: Schema.Boolean,
  /** That project's own switch (mcp.set_enabled with `cwd` and `here`), present only where it differs from every other project. */
  here: optionalKey(Schema.Literals(["on", "off"])),
  /**
   * Granted through credential.grant with marketplace "personal". `header`: the request header the value is sent as
   * (its credential is `<SERVER>_<HEADER>`); absent for an environment variable, which keeps its own name.
   */
  credentials: Schema.Array(Schema.Struct({ name: Schema.String, granted: Schema.Boolean, header: optionalKey(Schema.String) })),
  /** For a server that signs in: whether the runtime has a working sign-in. */
  status: optionalKey(Schema.Literals(["connected", "needs_sign_in", "signing_in", "error"])),
  problem: optionalKey(Schema.String),
  /** Who holds a working sign-in: Caveman Cloud (it works on Cloud computers too) or only this computer. */
  held_by: optionalKey(Schema.Literals(["cloud", "this_computer"])),
  /** Held by this computer only because Caveman Cloud cannot sign in to the server: why, in a sentence. */
  held_reason: optionalKey(Schema.String),
  /** The tools it last listed through the runtime's MCP hub; absent until it has. */
  tools: optionalKey(Strings),
  /** Estimated tokens its tool schemas add per request (bytes / 4); absent until it has listed them. */
  idle_tokens_estimate: optionalKey(Count),
  /** Its granted keys are available on Cloud computers (cloud.server.set_available). */
  cloud_available: optionalKey(Schema.Boolean),
}).annotate({ identifier: "McpServerInfo" });

const TimeOfDay = Schema.String.check(Schema.isPattern(/^([01]?\d|2[0-3]):[0-5]\d$/));
const Weekdays = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })));
const EveryMinutes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
/** An ISO 8601 instant with an offset: 2026-11-09T09:00:00.000+01:00. */
const Instant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/));
/** An IANA time zone, such as Europe/Amsterdam; absent, this computer's. */
const TimeZoneName = Schema.String.check(Schema.isMinLength(1));
const EveryCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }));
/** Day of month: 1 to 31, or -1 for the last day. A month without the day skips it. */
const MonthDays = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 31 }))).check(Schema.isMinLength(1));
/**
 * How a repeat may be bounded: no run before `start_at` (which also anchors every_days and every_weeks), none after
 * `until`, and none once `max_runs` scheduled runs have happened (runs by hand do not count).
 */
const RepeatEnds = {
  start_at: optionalKey(Instant),
  until: optionalKey(Instant),
  max_runs: optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
};
/** The time-based triggers, the same in automation.list and automation.save. */
const TimeTriggers = [
  Schema.Struct({ type: Schema.Literal("interval"), every_minutes: EveryMinutes, ...RepeatEnds }),
  /**
   * A wall-clock time; weekdays 0 (Sunday) to 6, every day when absent. every_days (no weekdays) runs every Nth day,
   * every_weeks (with weekdays) every Nth week, counted from start_at's week, weeks starting Monday.
   */
  Schema.Struct({
    type: Schema.Literal("daily"),
    time: TimeOfDay,
    weekdays: optionalKey(Weekdays),
    every_days: optionalKey(EveryCount),
    every_weeks: optionalKey(EveryCount),
    timezone: optionalKey(TimeZoneName),
    ...RepeatEnds,
  }),
  Schema.Struct({ type: Schema.Literal("monthly"), time: TimeOfDay, days: MonthDays, timezone: optionalKey(TimeZoneName), ...RepeatEnds }),
  /** Five-field cron (minute hour day-of-month month day-of-week, L for a month's last day) in a named zone. */
  Schema.Struct({ type: Schema.Literal("cron"), expression: Schema.String.check(Schema.isMinLength(1)), timezone: TimeZoneName, ...RepeatEnds }),
  /** Once, at an instant. After it runs, next_run_at is null and it stays listed with its result. */
  Schema.Struct({ type: Schema.Literal("once"), run_at: Instant }),
] as const;

/** A request value to test, as a prompt placeholder names it without braces: headers.x-github-event, body.action, body.issue.labels[].name. */
const WebhookFilterPath = Schema.String.check(Schema.isPattern(/^(body|headers|query)(\.|$)/));
/**
 * One test a webhook request must pass to start a run. A value compares as text; on a list (`[]` in the path) equals,
 * in and starts_with pass when any element does, not_equals when none equals it, exists when it is not empty.
 * An `in` value has no commas and no surrounding spaces, so a form can edit the list as "opened, reopened".
 */
export const WebhookFilter = Schema.Union([
  Schema.Struct({ path: WebhookFilterPath, op: Schema.Literals(["equals", "not_equals", "starts_with"]), value: Schema.String }),
  Schema.Struct({
    path: WebhookFilterPath,
    op: Schema.Literal("in"),
    value: Schema.Array(Schema.String.check(Schema.isPattern(/^[^,\s](?:[^,]*[^,\s])?$/))).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ path: WebhookFilterPath, op: Schema.Literal("exists") }),
]).annotate({ identifier: "WebhookFilter" });
/** Up to 16; a run starts only when every one passes, and other requests are logged as skipped. */
const WebhookFilters = Schema.Array(WebhookFilter).check(Schema.isMaxLength(16));
/**
 * Repeats and bursts. `replay_key`: a template over the request ({{headers.x-github-delivery}}); a request whose key
 * was seen in the last 7 days runs nothing. `coalesce_key` with `coalesce_window_seconds` (10 to 3600, default 120):
 * requests with the same key inside the window from the first one become one run, on the latest request.
 * A key whose placeholders are missing or render empty never dedupes.
 */
/** A dedupe key: at least one request placeholder ({{headers.x}}, {{body.a.b}}, {{query.q}}, {{request}}), and nothing else in braces. */
export function isWebhookKeyTemplate(template: string): boolean {
  const placeholders = /\{\{\s*(?:(?:body|headers|query)(?:\.[^{}.\s]+)*|request)\s*\}\}/g;
  const remainder = template.replace(placeholders, "");
  return [...template.matchAll(placeholders)].length > 0 && !remainder.includes("{{") && !remainder.includes("}}");
}
const WebhookKeyTemplate = Schema.String.check(Schema.makeFilter(isWebhookKeyTemplate));
export const WebhookDedupe = Schema.Struct({
  replay_key: optionalKey(WebhookKeyTemplate),
  coalesce_key: optionalKey(WebhookKeyTemplate),
  coalesce_window_seconds: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 }))),
}).annotate({ identifier: "WebhookDedupe" });

/** What starts an automation's run, as automation.list shows it. */
export const AutomationTrigger = Schema.Union([
  ...TimeTriggers,
  /**
   * A request to its URL. `path` (with its secret token) works on any origin
   * that reaches this runtime; `url` is a public one, null while this computer
   * has none (a webhook relay through Caveman Cloud is not built yet).
   */
  Schema.Struct({
    type: Schema.Literal("webhook"),
    path: Schema.String,
    url: Schema.NullOr(Schema.String),
    signed: Schema.Boolean,
    /** Which requests start a run; absent or empty, every request does. */
    filters: optionalKey(WebhookFilters),
    /** Repeats it drops and bursts it folds into one run; absent, each request runs. */
    dedupe: optionalKey(WebhookDedupe),
  }),
  /** A comment of yours mentioning @caveman on an issue or pull request of `repo` (owner/name), checked every minute. */
  Schema.Struct({ type: Schema.Literal("github_mention"), repo: Schema.String }),
  /** An automation file's `on:`: the kinds it declares (manual always) and each trigger in words ("Issue labelled caveman"). */
  Schema.Struct({ type: Schema.Literal("file"), kinds: Schema.Array(Schema.Literals(["manual", "schedule", "github", "webhook", "slack", "linear", "jira"])), words: Strings }),
]).annotate({ identifier: "AutomationTrigger" });

/** Me: `.caveman/local/automations/`, yours, live on save. Project: `.caveman/automations/`, triggers from the default branch. */
export const AutomationScope = Schema.Literals(["me", "project"]).annotate({ identifier: "AutomationScope" });
const AutomationComputer = Schema.Literals(["none", "code", "readonly", "full"]);
/** Where automation.file_read and file_write may reach: the automation and agent folders only. */
export const AutomationFilePath = Schema.String.check(
  Schema.isPattern(/^(?!.*(?:^|\/)\.\.(?:\/|$))\.caveman\/(?:automations|local\/automations|agents)\/[^\0]+$/),
).annotate({ identifier: "AutomationFilePath" });

/** A file by its repo-relative path; in automation.check, unsaved editor text that overrides the file on disk. */
export const AutomationSourceFile = Schema.Struct({ path: Schema.String, text: Schema.String }).annotate({ identifier: "AutomationSourceFile" });

/**
 * A problem check found in an automation or agent file. Line and column are 1-based; `code` is stable
 * (packages/automations RULES); the message says what to do. Same shape as @caveman-app/automations' Diagnostic.
 */
export const AutomationDiagnostic = Schema.Struct({
  path: Schema.String,
  line: Count,
  column: Count,
  severity: Schema.Literals(["error", "warning"]),
  code: Schema.String,
  message: Schema.String,
}).annotate({ identifier: "AutomationDiagnostic" });
export type AutomationDiagnostic = typeof AutomationDiagnostic.Type;

const ExplainRow = Schema.Struct({ key: Schema.String, value: Schema.String, detail: optionalKey(Schema.String), source: optionalKey(Schema.String) });
/** What will happen when an automation runs here (explain): header rows, then each step's rows. Same shape as the package's Explanation. */
export const AutomationExplanation = Schema.Struct({
  automation: Schema.String,
  scope: AutomationScope,
  path: Schema.String,
  header: Schema.Array(ExplainRow),
  steps: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String, rows: Schema.Array(ExplainRow) })),
}).annotate({ identifier: "AutomationExplanation" });
export type AutomationExplanation = typeof AutomationExplanation.Type;

const AutomationStepSummary = Schema.Struct({ name: Schema.String, agent: optionalKey(Schema.String), model: optionalKey(Schema.String), computer: Schema.String });
/** A template in the gallery, without its file bodies. Same shape as the package's TemplateSummary. */
export const AutomationTemplateSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  category: Schema.Literals(["Review", "Issues and PRs", "Monitoring", "Chores and reports"]),
  summary: Schema.String,
  /** From its triggers: GitHub, Schedule, Webhook, Slack, Linear, Jira. */
  chips: Strings,
  scope: AutomationScope,
  /** Where its triggers fire: This Mac, or Caveman Cloud once applied. */
  host: Schema.Literals(["this-mac", "cloud"]),
  /** The files Create writes, repo-relative. */
  paths: Strings,
  steps: Schema.Array(AutomationStepSummary),
  /** The run budget in dollars, when the file sets one. */
  budget: optionalKey(Schema.Number),
}).annotate({ identifier: "AutomationTemplateSummary" });
export type AutomationTemplateSummary = typeof AutomationTemplateSummary.Type;

const RunStatus = Schema.Literals(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
const StepStatus = Schema.Literals(["pending", "running", "waiting", "succeeded", "failed", "skipped", "cancelled"]);
/** Why a run, step or attempt ended as it did (SEMANTICS §12): exactly one per terminal status. */
export const AutomationRunReason = Schema.Literals([
  "condition_false", "need_not_succeeded", "need_skipped", "need_failed", "run_cancelled", "checks_failed", "review_rejected",
  "agent_error", "timeout", "result_invalid", "budget_exhausted", "cancelled", "superseded", "policy_denied", "deadline",
  "approval_rejected", "approval_expired", "engine_unavailable", "output_failed", "skipped_overlap", "pick_invalid", "not_home",
  "needs_isolation", "outcome_unmet", "not_picked", "start_failed",
]).annotate({ identifier: "AutomationRunReason" });
const CostLabel = Schema.Literals(["measured", "inferred", "verified"]);
const TriggerKind = Schema.Literals(["manual", "schedule", "github", "webhook", "slack", "linear", "jira"]);

/** One run on the automation's Runs tab (automation.runs), newest first. */
export const AutomationRunSummary = Schema.Struct({
  run_id: Id,
  automation_id: Id,
  automation: Schema.String,
  project_id: Id,
  status: RunStatus,
  reason: Schema.NullOr(AutomationRunReason),
  /** `subject_title`: the issue or pull request title, when the trigger knew it. */
  trigger: Schema.Struct({ kind: TriggerKind, subject: Schema.String, subject_title: optionalKey(Schema.String) }),
  started_at: IsoDateTime,
  ended_at: Schema.NullOr(IsoDateTime),
  /** Measured. */
  spent_usd: Schema.Number,
  /** `decision`: what the step decided, when its agent decides (an agent run's review: approve or request_changes). */
  steps: Schema.Array(Schema.Struct({ name: Schema.String, status: StepStatus, decision: optionalKey(Schema.String) })),
}).annotate({ identifier: "AutomationRunSummary" });
export type AutomationRunSummary = typeof AutomationRunSummary.Type;

/** An output a run writes, or (a manual run before apply) would write: `preview` is the text. */
export const AutomationRunOutput = Schema.Struct({
  /**
   * slack.message, linear.comment and jira.comment are posted by Caveman Cloud (host: cloud). chief: handed to the
   * Chief the file names, else one that works in the project (its routine's row, and a news run's wake), by hand too.
   */
  kind: Schema.Literals(["github.comment", "github.pull_request", "slack.message", "linear.comment", "jira.comment", "chief"]),
  /** `<run>.<step>.<kind>`: a retried step cannot write twice. */
  key: Schema.String,
  status: Schema.Literals(["pending", "dry_run", "applied", "failed", "dropped"]),
  url: optionalKey(Schema.String),
  preview: optionalKey(Schema.String),
  error: optionalKey(Schema.String),
}).annotate({ identifier: "AutomationRunOutput" });

const RunCheck = Schema.Struct({
  check: Schema.String,
  exit: optionalKey(Schema.Int),
  ms: optionalKey(Count),
  decision: optionalKey(Schema.String),
  output_tail_ref: optionalKey(Schema.String),
  /** A failed check's findings (an agent check) or the end of its output (a command check, 8 KiB at most). */
  text: optionalKey(Schema.String),
  /** An agent check's own summary, whatever it decided. */
  summary: optionalKey(Schema.String),
  /** The workspace an agent check's thread was adopted as: what the run view opens (`/w/<workspace_id>`). */
  workspace_id: optionalKey(Id),
});
const RunAttempt = Schema.Struct({
  n: Count,
  /** `<run>.<step>.<n>`. */
  id: Schema.String,
  status: StepStatus,
  reason: Schema.NullOr(AutomationRunReason),
  engine: optionalKey(Schema.String),
  model: Schema.Struct({ asked: Schema.String, resolved: Schema.String, via: optionalKey(Schema.String) }),
  effort: optionalKey(Schema.String),
  computer: optionalKey(AutomationComputer),
  started_at: IsoDateTime,
  ended_at: Schema.NullOr(IsoDateTime),
  cost: optionalKey(
    Schema.Struct({
      usd: Schema.Number,
      input: Count,
      output: Count,
      cache_read: Count,
      cache_write: Count,
      label: CostLabel,
      /** plan: a subscription login, which has no per-token price, so only token and turn caps held it (SEMANTICS §9.6). */
      billing: optionalKey(Schema.Literals(["api_key", "plan", "mixed", "none"])),
    }),
  ),
  optimizations: optionalKey(Schema.Array(Schema.Struct({ knob: Schema.String, applied: Schema.Boolean, reason: Schema.NullOr(Schema.String) }))),
  checks: Schema.Array(RunCheck),
  result_ref: optionalKey(Schema.String),
  sha: Schema.NullOr(Schema.String),
  /** The attempt's thread (runtime-internal id). */
  thread_id: optionalKey(Id),
  /** The workspace the attempt's thread was adopted as: what the run view opens (`/w/<workspace_id>`). */
  workspace_id: optionalKey(Id),
  /** Why it failed, in words (an engine error, a timeout, which budget cap stopped it); a failed check carries its own text. */
  message: optionalKey(Schema.String),
  /** A parallel attempt's place in its round (1 to 4). */
  candidate: optionalKey(Count),
  /** The grader's verdict against the step's rubric (outcome), and its feedback. */
  grade: optionalKey(Schema.Struct({ satisfied: Schema.Boolean, text: Schema.String, workspace_id: optionalKey(Id) })),
});

/** One run, as journalled (SEMANTICS §12): trigger, budget, workspace, every step's attempts, outputs. */
export const AutomationRunRecord = Schema.Struct({
  run: Id,
  automation: Schema.String,
  automation_id: optionalKey(Id),
  project_id: optionalKey(Id),
  /** `sha256:<hex>` of the revision the run is pinned to. */
  revision: Schema.String,
  trigger: Schema.Struct({
    kind: TriggerKind,
    event: optionalKey(Schema.String),
    subject: Schema.String,
    /** The issue or pull request title (or commit subject) the subject names, when the trigger knew it. */
    subject_title: optionalKey(Schema.String),
    /** A link to the subject on GitHub, when there is one. */
    subject_url: optionalKey(Schema.String),
    delivery: optionalKey(Schema.String),
    received_at: IsoDateTime,
  }),
  concurrency_key: Schema.String,
  status: RunStatus,
  reason: Schema.NullOr(AutomationRunReason),
  started_at: IsoDateTime,
  ended_at: Schema.NullOr(IsoDateTime),
  environment: Schema.String,
  population: Schema.Literals(["agent", "engineer"]),
  registry: Schema.String,
  budget: Schema.Struct({ limit_usd: Schema.NullOr(Schema.Number), spent_usd: Schema.Number, label: CostLabel }),
  workspace: Schema.Struct({ computer: Schema.String, branch: Schema.String, head: Schema.NullOr(Schema.String), workspace_id: optionalKey(Id) }),
  steps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: StepStatus,
      reason: Schema.NullOr(AutomationRunReason),
      decision: optionalKey(Schema.String),
      /** The step's result in prose (its envelope's summary), once it succeeded: what agent.run answers with. */
      summary: optionalKey(Schema.String),
      /** A graph step's needs. */
      needs: optionalKey(Strings),
      /** A wait step's timer, or how long an approval waits. */
      waiting_until: optionalKey(IsoDateTime),
      /**
       * An approval gate (approve): who may answer, until when, and the answer once given. While it waits the step is
       * `waiting`; automation.approve (or the Inbox, or Cloud's `answer` mail) answers it.
       */
      approval: optionalKey(
        Schema.Struct({
          by: Schema.Literals(["owner", "members"]),
          asked_at: IsoDateTime,
          expires_at: IsoDateTime,
          decision: optionalKey(Schema.Literals(["approve", "reject"])),
          decided_by: optionalKey(Schema.String),
          decided_at: optionalKey(IsoDateTime),
          message: optionalKey(Schema.String),
          /** The gate is before the step runs (one the run added because its trigger text is untrusted), not after. */
          before_run: optionalKey(Schema.Boolean),
        }),
      ),
      /**
       * The run's trigger text came from outside the trusted people and this step can write (a full computer, or an
       * output reads it), so the run added an approval by the owner before it runs.
       */
      untrusted_trigger: optionalKey(Schema.Boolean),
      /** A parallel step's chosen attempt, and `pick_invalid` when the pick named none and the cheapest passing attempt won. */
      chosen: optionalKey(Count),
      pick_note: optionalKey(Schema.Literal("pick_invalid")),
      attempts: Schema.Array(RunAttempt),
    }),
  ),
  outputs: Schema.Array(AutomationRunOutput),
}).annotate({ identifier: "AutomationRunRecord" });
export type AutomationRunRecord = typeof AutomationRunRecord.Type;

/**
 * How an applied revision moves an automation's authority against the active one (Cloud reads only the
 * authority-bearing keys: host, on, outputs, step engines and agents, secrets, budget). `before` and `after` are
 * the values as text; `widens` on a change, and on the whole, means the owner must approve it first.
 */
export const CloudAuthorityDiff = Schema.Struct({
  widens: Schema.Boolean,
  changes: Schema.Array(
    Schema.Struct({
      /** e.g. `on.github`, `outputs.slack.message`, `steps.implement.engine`, `budget`. */
      key: Schema.String,
      change: Schema.Literals(["added", "removed", "changed"]),
      before: Schema.NullOr(Schema.String),
      after: Schema.NullOr(Schema.String),
      widens: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "CloudAuthorityDiff" });
export type CloudAuthorityDiff = typeof CloudAuthorityDiff.Type;

/** One automation file Caveman Cloud took in (automation.apply): the revision it made, and whether it waits for the owner. */
export const CloudAutomationApplied = Schema.Struct({
  id: Id,
  name: Schema.String,
  revision_id: Schema.NullOr(Id),
  /**
   * active: it fires from now on; pending_approval: the owner approves it first (`reason` says why); unchanged: same
   * files; removed: the apply no longer carries its file, so it stopped firing.
   */
  state: Schema.Literals(["active", "pending_approval", "superseded", "unchanged", "removed"]),
  /** Why it waits for the owner: `widens` (it may do more than the active revision) or `not_owner` (you are not its owner). */
  reason: optionalKey(Schema.String),
  authority_diff: CloudAuthorityDiff,
  /**
   * The webhook trigger Cloud made for it just now: its path on Caveman Cloud and the secret a sender signs each body
   * with (`X-Caveman-Signature: sha256=<hex HMAC-SHA256>`). Cloud returns the secret this once; nothing keeps it.
   */
  hook: optionalKey(Schema.Struct({ id: Id, path: Schema.String, secret: Schema.String })),
}).annotate({ identifier: "CloudAutomationApplied" });
export type CloudAutomationApplied = typeof CloudAutomationApplied.Type;

/** One run of a Cloud-hosted automation, as Caveman Cloud records it (automation.cloud_runs). */
export const CloudAutomationRun = Schema.Struct({
  id: Id,
  automation_id: Id,
  revision_id: Schema.NullOr(Id),
  /** What fired it: `github.issues.labeled`, `schedule`, `slack.app_mention`, `manual`. */
  trigger: Schema.String,
  status: Schema.String,
  outcome: Schema.NullOr(Schema.String),
  /** The Cloud session it ran in, when it started one. */
  session_id: Schema.NullOr(Id),
  /** Measured. */
  cost_usd: Schema.Number,
  started_at: Schema.NullOr(IsoDateTime),
  finished_at: Schema.NullOr(IsoDateTime),
  /** The automation's name and repository, so a run sits under its file without an apply first. */
  name: optionalKey(Schema.String),
  repo: optionalKey(Schema.String),
  /** While the run waits on a person: the ask (automation.cloud_answer answers an approval). */
  requires_action: optionalKey(
    Schema.Struct({
      ask_id: Id,
      kind: Schema.Literals(["approval", "question", "tool"]),
      step: optionalKey(Schema.String),
      by: optionalKey(Schema.Literals(["owner", "members"])),
    }),
  ),
}).annotate({ identifier: "CloudAutomationRun" });

/** A Cloud-hosted automation as Caveman Cloud holds it (automation.cloud_list): what is deployed before anyone applies here. */
export const CloudAutomation = Schema.Struct({
  id: Id,
  name: Schema.String,
  repo: Schema.String,
  path: Schema.String,
  enabled: Schema.Boolean,
  /** The newest revision's state (removed: the last apply no longer carried its file, so it stopped firing). */
  state: Schema.Literals(["active", "pending_approval", "superseded", "unchanged", "removed"]),
  revision_id: Schema.NullOr(Id),
  applied_at: optionalKey(IsoDateTime),
  /** A pending revision against the active one. */
  authority_diff: optionalKey(CloudAuthorityDiff),
}).annotate({ identifier: "CloudAutomation" });
export type CloudAutomation = typeof CloudAutomation.Type;
export type CloudAutomationRun = typeof CloudAutomationRun.Type;

/** An agent file published to the org's Caveman Cloud (agent.published): its name and newest version. */
export const CloudAgent = Schema.Struct({
  id: Id,
  name: Schema.String,
  latest_version: Count,
  description: optionalKey(Schema.String),
  engine: optionalKey(Schema.String),
  model: optionalKey(Schema.String),
  archived: Schema.Boolean,
  /** sha256 of the newest version's file, so a client can tell whether the file here changed since. */
  file_sha256: optionalKey(Schema.String),
}).annotate({ identifier: "CloudAgent" });
export type CloudAgent = typeof CloudAgent.Type;

/** A scheduled or triggered prompt: each run is a new workspace in its project. */
export const Automation = Schema.Struct({
  id: Id,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  trigger: AutomationTrigger,
  project_id: Id,
  engine: EngineId,
  /** With follows_default, the default it resolved to when saved; each run resolves it again. */
  model: Schema.String,
  /** Saved without a model: each run starts on the new-chat default as it is then. */
  follows_default: optionalKey(Schema.Boolean),
  next_run_at: Schema.NullOr(IsoDateTime),
  last_run_at: Schema.NullOr(IsoDateTime),
  last_status: Schema.Literals(["never", "running", "succeeded", "failed"]),
  last_error: Schema.NullOr(Schema.String),
  run_count: Count,
  /** file: an automation file (id `file:<project_id>:<scope>:<name>`); app: a single prompt saved in the app before files. */
  source: optionalKey(Schema.Literals(["file", "app"])),
  scope: optionalKey(AutomationScope),
  /** A file's `host`: this-mac fires here; cloud fires in Caveman Cloud once applied (automation.apply), never here. */
  host: optionalKey(Schema.Literals(["this-mac", "cloud"])),
  /** The file, repo-relative. */
  path: optionalKey(Schema.String),
  description: optionalKey(Schema.String),
  steps: optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, agent: optionalKey(Schema.String), model: Schema.String, computer: AutomationComputer }))),
  /** How many problems check finds in its files; one error keeps it from running. */
  diagnostics: optionalKey(Count),
  /** A Project file is on the default branch, so its triggers are live. Absent while git cannot read that branch. */
  on_default_branch: optionalKey(Schema.Boolean),
  /** One cell per day, oldest first. */
  last30: optionalKey(Schema.Array(Schema.Literals(["worked", "failed", "none"]))),
  /** Measured. */
  spend_30d_usd: optionalKey(Schema.Number),
  runs_running: optionalKey(Count),
  /** How many of `diagnostics` are errors; only errors keep it from running (warnings never do). */
  errors: optionalKey(Count),
  /** Its `inputs:`, for a manual run's form. */
  inputs: optionalKey(
    Schema.Array(
      Schema.Struct({ name: Schema.String, description: optionalKey(Schema.String), required: optionalKey(Schema.Boolean), default: optionalKey(Schema.String) }),
    ),
  ),
  /** On, but its triggers do not fire here: why, in one sentence that says what to do (absent when they fire or it is off). */
  triggers_off_reason: optionalKey(Schema.String),
  /** The default branch its Project triggers read (e.g. main). */
  default_branch: optionalKey(Schema.String),
  /** Where its triggers fire: this Mac (Caveman Code polls) or GitHub Actions (the repo has the Caveman workflow). */
  runs_on: optionalKey(Schema.Literals(["this_mac", "github_actions"])),
  /** Its triggers can name a GitHub issue or pull request, so a manual run may take one as its subject. */
  takes_subject: optionalKey(Schema.Literals(["issue", "pull_request", "issue_or_pull_request"])),
  /**
   * A draft: the file is only in this worktree of the project (new there, or changed), so it is listed the moment it
   * is written. Its id is `file:<project_id>@<branch>:<scope>:<name>`, and every call that takes that id or that
   * project reference reads the worktree. It runs by hand; it cannot be turned on until it merges.
   */
  worktree: optionalKey(Schema.Struct({ branch: Schema.String, path: Schema.String })),
  /** The chat its runs go to: the one an agent's schedule wakes (in that chat, or from Cloud). */
  workspace_id: optionalKey(Id),
  /** An agent set it to run on Cloud (`host: cloud`): it starts only once the person allows it (automation.allow). */
  awaiting_approval: optionalKey(Schema.Boolean),
  /**
   * A routine: its `chief` output hands `step`'s report to a Chief. `chief_id`: the Chief its reports go to now, the
   * one the file names (`to`) while it is there, else one that works in the project, as chief.get picks it (absent with
   * no Chief). `schedule`: its schedule in words without its last day ("Every day at 09:00 (Europe/Amsterdam)");
   * `until`: that day, as the file says it.
   */
  routine: optionalKey(Schema.Struct({ step: Schema.String, schedule: optionalKey(Schema.String), until: optionalKey(Schema.String), chief_id: optionalKey(Id) })),
}).annotate({ identifier: "Automation" });

/** A connector (connector.list): a vendor's remote MCP server the runtime's hub signs in to. */
export const ConnectorInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  url: Schema.String,
  /** `oauth`: sign in in the browser, the runtime keeps the tokens; `github`: this computer's GitHub login (gh or GH_TOKEN). */
  auth: Schema.Literals(["oauth", "github"]),
  /** Whether it is one of the user's servers (mcp.list) yet. */
  added: Schema.Boolean,
  status: optionalKey(Schema.Literals(["connected", "needs_sign_in", "signing_in", "error"])),
  problem: optionalKey(Schema.String),
  /** Who holds a working sign-in: Caveman Cloud (it works on Cloud computers too) or only this computer. */
  held_by: optionalKey(Schema.Literals(["cloud", "this_computer"])),
  /** Held by this computer only because Caveman Cloud cannot sign in to the server: why, in a sentence. */
  held_reason: optionalKey(Schema.String),
  /** Why it cannot be connected yet; absent when it can. */
  unavailable: optionalKey(Schema.String),
}).annotate({ identifier: "ConnectorInfo" });

/** A server mcp.import_scan found in Claude Code's or Codex's config, or one it left out. */
export const McpImportCandidate = Schema.Struct({
  name: Schema.String,
  from: Schema.Literals(["claude", "codex"]),
  command: optionalKey(Schema.String),
  args: optionalKey(Strings),
  url: optionalKey(Schema.String),
  /** Credential names it will need granted; their values were never read. */
  credentials: optionalKey(Strings),
  /** Why it cannot be imported; absent when it can. */
  reason: optionalKey(Schema.String),
}).annotate({ identifier: "McpImportCandidate" });

/**
 * A skill an engine loads (skill.list): from an installed plugin, your home
 * folder (~/.claude/skills, ~/.agents/skills, ~/.codex/skills) or a project's
 * repository (.claude/skills, .agents/skills).
 */
export const SkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** me: your home folder; project: a project's repository; plugin: an installed plugin. */
  scope: Schema.Literals(["me", "project", "plugin"]),
  /** Absolute path of its SKILL.md; skill.read and skill.save take it. */
  path: Schema.String,
  /** The engines that load it. */
  engines: Schema.Array(EngineId),
  plugin_id: optionalKey(Id),
  /** A plugin skill: the marketplace its plugin comes from. */
  marketplace: optionalKey(Schema.String),
  project_id: optionalKey(Id),
  /** A plugin skill is on while its plugin is; a file in a home or repository folder always is. */
  enabled: Schema.Boolean,
  /** Its skills-index line (name, description, path) at 4 bytes a token: an estimate from bytes, never a measured count. */
  idle_tokens_estimate: Count,
}).annotate({ identifier: "SkillInfo" });

/**
 * An instruction file an engine reads at session start (rule.list): your
 * own (`~/.claude/CLAUDE.md`, Codex's home AGENTS.md) or a project's
 * (CLAUDE.md, AGENTS.md, ...). A file that does not exist yet is listed too,
 * with the engines that would read it once written.
 */
export const RuleInfo = Schema.Struct({
  /** Absolute; rule.read and rule.save take it. */
  path: Schema.String,
  /** The path under its folder (`CLAUDE.md`, `.claude/CLAUDE.md`). */
  name: Schema.String,
  scope: Schema.Literals(["me", "project"]),
  project_id: optionalKey(Id),
  /** The engines that read it; empty when another file shadows it (AGENTS.override.md). */
  engines: Schema.Array(EngineId),
  exists: Schema.Boolean,
  /** Its bytes at 4 a token: an estimate, never a measured count. 0 when it does not exist. */
  idle_tokens_estimate: Count,
}).annotate({ identifier: "RuleInfo" });

/** One file a finished turn changed, with its line counts (checkpoint.created). */
export const TurnFile = Schema.Struct({ path: Schema.String, additions: Count, deletions: Count }).annotate({ identifier: "TurnFile" });
export type TurnFile = typeof TurnFile.Type;
/** Every file a turn changed, when its `files` list is capped: how many, and their line counts. */
export const TurnFilesTotal = Schema.Struct({ count: Count, additions: Count, deletions: Count }).annotate({ identifier: "TurnFilesTotal" });
export type TurnFilesTotal = typeof TurnFilesTotal.Type;

export const FileChange = Schema.Struct({
  path: Schema.String,
  old_path: optionalKey(Schema.String),
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  additions: Count,
  deletions: Count,
}).annotate({ identifier: "FileChange" });

/** One file an edit tool call changed (tool.started `files`): a FileChange without line counts, which the call does not know. */
export const ToolFile = Schema.Struct({
  path: Schema.String,
  /** A moved file's path before the move. */
  old_path: optionalKey(Schema.String),
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
}).annotate({ identifier: "ToolFile" });

/**
 * A thread one of the runtime's own tools names (tool.started and tool.done `threads`): its workspace, else (a
 * delegated child's thread with none, a thread no longer known) only its title, as message.done's `from` says a sender.
 */
export const ToolThread = Schema.Struct({
  workspace_id: optionalKey(Id),
  title: Schema.String,
}).annotate({ identifier: "ToolThread" });
export type ToolThread = typeof ToolThread.Type;

/** One place a chat.search match was found: a passage of the chat, with what matched marked. */
export const ChatSearchPassage = Schema.Struct({
  /** title; user: the person's own words; assistant: an answer; agent: a subagent's task or summary; plan; ask: a question put to the person; tool: a command or file it touched; files: the chat's changed files. */
  kind: Schema.Literals(["title", "user", "assistant", "agent", "plan", "ask", "tool", "files"]),
  /** The transcript item it is in (the event's item_id, else `<type>:<cursor>`); absent for the title and the changed files. */
  item_id: optionalKey(Id),
  /** The journal event it came from; 0 for the title. */
  cursor: Cursor,
  at: IsoDateTime,
  /** The passage, cut around what matched. */
  text: Schema.String,
  /** What the query's words matched, as [start, end) offsets into `text`. None for a match by meaning alone. */
  marks: Schema.Array(Schema.Struct({ start: Count, end: Count })),
  /** Found by the query's words, by its meaning, or both. */
  by: Schema.Literals(["words", "meaning", "both"]),
}).annotate({ identifier: "ChatSearchPassage" });
export type ChatSearchPassage = typeof ChatSearchPassage.Type;

export const ChatSearchHit = Schema.Struct({
  workspace: Workspace,
  /** Its best places, best first (at most 3). */
  passages: Schema.Array(ChatSearchPassage),
  /** How many more of its passages matched. */
  more: Count,
}).annotate({ identifier: "ChatSearchHit" });
export type ChatSearchHit = typeof ChatSearchHit.Type;

export const ChatSearchResult = Schema.Struct({
  chats: Schema.Array(ChatSearchHit),
  /** The query as searched when a word the chats never use was taken for a typo ("stirpe" -> "stripe"). */
  corrected: optionalKey(Schema.String),
  /** Still reading the journal since this start (a first start or an upgrade rebuilds the index): chats may be missing. */
  indexing: Schema.Boolean,
  /**
   * Matching by meaning, on this computer: ready; preparing (the model is downloading, or passages wait for
   * their vectors, so meaning covers only some chats); unavailable (words only).
   */
  meaning: Schema.Literals(["ready", "preparing", "unavailable"]),
}).annotate({ identifier: "ChatSearchResult" });
export type ChatSearchResult = typeof ChatSearchResult.Type;

/** A chat a model picked for what the person is looking for (chat.find): its search hit, and why in a line. */
export const ChatFindPick = Schema.Struct({
  ...ChatSearchHit.fields,
  /** What in the chat matches, in about ten words. */
  why: Schema.String,
}).annotate({ identifier: "ChatFindPick" });
export type ChatFindPick = typeof ChatFindPick.Type;

export const ChatFindResult = Schema.Struct({
  /** Best first, at most three; empty when no chat fits. */
  chats: Schema.Array(ChatFindPick),
  /** The model that picked, as its engine names it. */
  model: Schema.String,
  /** How many chats it read. */
  read: Count,
}).annotate({ identifier: "ChatFindResult" });
export type ChatFindResult = typeof ChatFindResult.Type;


export const MailMessage = Schema.Struct({
  id: Id,
  /** `spawn` only on mail stored before builders started through delegate_task. */
  verb: Schema.Literals(["spawn", "task", "note", "ask", "handoff"]),
  /** Who stands behind it. Only `human` counts as a person's consent; `agent` is a peer session, `system` is Caveman. */
  /** api and automation: Cloud mail for a session an API key or an automation started (the caller's, never a person's consent beyond its own asks). */
  authority: Schema.Literals(["human", "agent", "system", "api", "automation"]),
  /** Optional topic within the tree, for filtering. */
  channel: optionalKey(Schema.String),
  from_workspace_id: Id,
  to_workspace_id: Id,
  body: Schema.String,
  /** True when the message starts a turn in the receiver. */
  wakes: Schema.Boolean,
  reply_to: optionalKey(Id),
  created_at: IsoDateTime,
}).annotate({ identifier: "MailMessage" });

export const Claim = Schema.Struct({ path: Schema.String, workspace_id: Id }).annotate({
  identifier: "Claim",
});

export const AskOption = Schema.Struct({
  id: Id,
  label: Schema.String,
  description: optionalKey(Schema.String),
});

/**
 * A moment of a chat on a Chief's board, as the Chief's conversation shows it: the runtime finds it in the chat's own
 * events and writes it into the Chief's session (a `notification`), once each, with no model turn. `started`: the chat
 * started. `plan`: its first edit after a stretch of reading; `text` is what it wrote just before, in its own words.
 * `needs_you`: it waits on the person; `text` is the question or what it waits on, and `ask` the card it waits on.
 * `result`: its turn ended with changes, a pull request or a review or done report; the Chief's next reply is its lines
 * and diagram. `news`: a routine's run found something; `text` is its report (a command's output, data, never
 * instructions) and `routine` the run, one moment each. A client draws the rest (the chat's state, its pull request,
 * screenshots, preview) from the board as it is now. `reaction`: the Chief acknowledges the person's note with an
 * emoji on that message instead of words; the latest reaction for each `message_id` wins.
 */
export const ChiefMoment = Schema.Struct({
  kind: Schema.Literals(["started", "plan", "needs_you", "result", "news", "reaction"]),
  workspace_id: optionalKey(Id),
  item_id: optionalKey(Id),
  text: optionalKey(Schema.String),
  /**
   * The card a `needs_you` chat waits on (its ask.user item id) and its kind. A question card names its first question
   * and the option the chat recommends, so the person answers it here (ask.respond on the chat's session).
   */
  ask: optionalKey(
    Schema.Struct({
      id: Id,
      kind: Schema.Literals(["question", "approval", "secret", "tool"]),
      question_id: optionalKey(Id),
      recommended: optionalKey(Schema.Struct({ option_id: Id, label: Schema.String })),
    }),
  ),
  /** A `news` moment's routine: its automation (automation.list's id), its name and the run that found it. */
  routine: optionalKey(Schema.Struct({ automation_id: Id, name: Schema.String, run_id: Id })),
  /** A `reaction` moment's target: the person's message.done item_id, never the board item's id. */
  message_id: optionalKey(Id),
  /** A `reaction` acknowledges that note without words; the latest reaction on its message wins. */
  emoji: optionalKey(Schema.Literals(["👍", "👀", "✅", "❤️"])),
});
export type ChiefMoment = typeof ChiefMoment.Type;

export const AskUser = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("approval"),
    title: Schema.String,
    detail: optionalKey(Schema.String),
    /** The tool call waiting on this approval. */
    tool_item_id: optionalKey(Id),
    /** Why the engine asks, in its own words, when that adds to the title (Claude's decision reason). */
    reason: optionalKey(Schema.String),
    /**
     * The chat runs with full access and the engine asked anyway: `ask_rule`, an ask rule in the engine's own
     * settings matched; `engine_check`, a safety check of the engine's own that no setting can skip.
     */
    full_access_override: optionalKey(Schema.Literals(["ask_rule", "engine_check"])),
    /**
     * A deny can carry the person's note (the response's `feedback`): the engine hands it to the tool call that asked,
     * a subagent's included, as why it was refused and what to do instead, and the turn goes on. Claude Agent's.
     */
    accepts_feedback: optionalKey(Schema.Boolean),
    options: Schema.Array(
      Schema.Struct({ ...AskOption.fields, decision: Schema.Literals(["allow", "deny"]) }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("question"),
    /** Grill mode: which round of questions this is, from 1. Absent on other questions. */
    round: optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    questions: Schema.Array(
      Schema.Struct({
        id: Id,
        header: optionalKey(Schema.String),
        prompt: Schema.String,
        /** Markdown body under the prompt. */
        detail: optionalKey(Schema.String),
        options: Schema.Array(
          Schema.Struct({
            ...AskOption.fields,
            /** What the option looks like, to compare them by (a mockup, a snippet), as the engine wrote it: plain text. */
            preview: optionalKey(Schema.String),
          }),
        ),
        /** The option id the engine recommends. */
        recommended: optionalKey(Id),
        multi_select: Schema.Boolean,
        allow_text: Schema.Boolean,
      }),
    ),
  }),
  /**
   * The agent needs a secret the repository lacks. The client stores the
   * value with secret.set, then answers with `provided`; the value never
   * travels in ask.respond or the session.
   */
  Schema.Struct({
    kind: Schema.Literal("secret"),
    repo: Repo,
    name: SecretName,
    reason: Schema.String,
  }),
  /**
   * The agent called a custom tool its agent file declares (`tools: [{type: custom, ...}]`): the one who drives
   * the session runs it and answers with its result (`content`, `is_error`), which the agent reads as the tool's.
   */
  Schema.Struct({
    kind: Schema.Literal("tool"),
    name: Schema.String,
    description: optionalKey(Schema.String),
    input: Schema.Unknown,
  }),
]).annotate({ identifier: "AskUser" });

export const AskResponse = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("approval"),
    option_id: Id,
    /** With a deny, on an approval that `accepts_feedback`: the person's note to the agent that asked. */
    feedback: optionalKey(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("question"),
    answers: Schema.Array(
      Schema.Struct({
        question_id: Id,
        option_ids: Strings,
        text: optionalKey(Schema.String),
      }),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("secret"), provided: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("tool"), content: Schema.String, is_error: optionalKey(Schema.Boolean) }),
]).annotate({ identifier: "AskResponse" });

// -------------------------------------------------------------------- errors

/** Every error carries `data.reason`; `code` is fixed per reason. */
export const ErrorCodes = {
  not_found: -32001,
  invalid_params: -32002,
  request_id_conflict: -32003,
  invalid_state: -32004,
  engine_unavailable: -32005,
  unauthorized: -32006,
  forbidden: -32007,
  rate_limited: -32008,
  parked: -32009,
  lease_lost: -32010,
  unsupported: -32011,
  internal: -32012,
  /** The user holds the browser or desktop (browser.control / computer.control). */
  user_in_control: -32013,
  /** turn.submit text carries a credential or a stored secret's value; store it with secret.set instead. */
  secret_in_input: -32014,
  /**
   * Caveman Cloud refused the person's sign-in (a Cloud 401): sign in to Caveman again. Not
   * `unauthorized`, which is this client's own runtime token and makes the client reconnect.
   */
  cloud_unauthorized: -32015,
  /** web.keys.set: the provider refused the key, so it was not stored. */
  key_refused: -32016,
  /**
   * The session's journal was rewritten under a new epoch (Workspace.epoch): what this attachment delivered no longer
   * holds. session.attach again with the old epoch; the answer says `reset` and replays the new journal from cursor 0.
   */
  journal_reset: -32017,
  /**
   * Driving This Mac through Caveman Cloud needs this device allowed on the Mac once (device.hello). The call did not
   * run; a client waiting for the Mac's answer sends it again once device.status says approved. A device.hello answered
   * with it was refused for good, and the message says why: a Mac that names its owner takes only its owner's devices,
   * so another person's device is told so and never asks its screen.
   */
  device_not_approved: -32018,
} as const;
export type ErrorReason = keyof typeof ErrorCodes;
export const ErrorReason = Schema.Literals(
  Object.keys(ErrorCodes) as [ErrorReason, ...Array<ErrorReason>],
);

/** The one result of a lead's builders (message.done `builders_result`). */
export const BuildersResult = Schema.Struct({
  /** Builders whose work was to come together, and how many of their branches are in the lead's. */
  total: Count,
  merged: Count,
  /** Those whose work is not in, with why in a few words ("conflicts in a.ts"); `workspace_id` when the builder's chat is on this computer. */
  left_out: Schema.Array(Schema.Struct({ workspace_id: optionalKey(Id), title: Schema.String, why: Schema.String })),
  /** The pull request that carries it: one per repository the lead works in (`repo` then names it, "owner/name"). */
  pull_requests: Schema.Array(Schema.Struct({ number: Count, url: Schema.String, repo: optionalKey(Schema.String) })),
  /** No pull request was opened, and why in one sentence of ours. */
  problem: optionalKey(Schema.String),
}).annotate({ identifier: "BuildersResult" });
export type BuildersResult = typeof BuildersResult.Type;

export const RpcError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: optionalKey(
    Schema.Struct({
      reason: ErrorReason,
      /** rate_limited: wait this long before retrying. */
      retry_after_ms: optionalKey(Count),
      /** unsupported: the missing EngineDescriptor capability. */
      capability: optionalKey(Schema.String),
      /**
       * A call the runtime made to Caveman Cloud for the person (cloud.*), refused by Cloud: Cloud's own error code
       * (`cave_code_computer_limit_person_total`, …), so a client can offer the way past it (Settings > Computers).
       */
      cloud_code: optionalKey(Schema.String),
      /**
       * git.pr for a chat in several repositories, when one did not open: the ones that did, and the one to try
       * again with why. The message says the same in one line ("web's pull request didn't open: <reason>. api's is
       * #128."); a client shows that line and offers the one again.
       */
      pull_requests: optionalKey(
        Schema.Struct({
          opened: Schema.Array(Schema.Struct({ source: Schema.String, number: Count, url: Schema.String })),
          failed: Schema.Struct({ source: Schema.String, reason: Schema.String }),
        }),
      ),
    }),
  ),
}).annotate({ identifier: "RpcError" });
export type RpcError = typeof RpcError.Type;

// ----------------------------------------------------------------- envelopes

const JsonRpc = Schema.Literal("2.0");
const JsonRpcId = Schema.Union([Schema.String, Schema.Int]);

export const RpcRequest = Schema.Struct({
  jsonrpc: JsonRpc,
  id: JsonRpcId,
  method: Schema.String,
  params: optionalKey(Schema.Unknown),
}).annotate({ identifier: "RpcRequest" });
export const RpcSuccess = Schema.Struct({
  jsonrpc: JsonRpc,
  id: JsonRpcId,
  result: Schema.Unknown,
}).annotate({ identifier: "RpcSuccess" });
export const RpcFailure = Schema.Struct({
  jsonrpc: JsonRpc,
  id: Schema.NullOr(JsonRpcId),
  error: RpcError,
}).annotate({ identifier: "RpcFailure" });
export const RpcNotification = Schema.Struct({
  jsonrpc: JsonRpc,
  method: Schema.String,
  params: Schema.Unknown,
}).annotate({ identifier: "RpcNotification" });

// -------------------------------------------------------------------- events

/**
 * How an engine classed a failed call or turn (T3's provider failure classes), with its own code when it has one
 * (`api_error_529`, `budget_exhausted`). Machine-readable, never shown: the message says it for people.
 */
export const EngineFailure = Schema.Struct({
  class: Schema.Literals(["usage_limit", "provider_error", "transport_error", "permission_error", "validation_error", "unknown"]),
  code: optionalKey(Schema.String),
}).annotate({ identifier: "EngineFailure" });
export type EngineFailure = typeof EngineFailure.Type;

const event = <const T extends string, P extends Schema.Top>(type: T, payload: P) =>
  Schema.Struct({
    session_id: Id,
    cursor: Cursor,
    at: IsoDateTime,
    turn_id: optionalKey(Id),
    item_id: optionalKey(Id),
    /** Subagent lineage: the subagent.started item this event belongs to. */
    parent_item_id: optionalKey(Id),
    type: Schema.Literal(type),
    payload,
  });
const S = Schema.Struct;
const Text = S({ text: Schema.String });

export const SessionEvent = Schema.Union([
  event("turn.started", S({ ...TurnOptions.fields, engine: EngineId })),
  event("message.delta", Text),
  event(
    "message.done",
    S({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      attachments: optionalKey(Schema.Array(Attachment)),
      /**
       * Another thread's agent wrote this user-role message, not the person; workspace_id when that thread is a workspace.
       * `agent`: an outside agent (`caveman-code mcp`) wrote it, and `title` is its name.
       */
      from: optionalKey(S({ workspace_id: optionalKey(Id), title: Schema.String, agent: optionalKey(Schema.Literal(true)) })),
      /** How a user-role message reached the engine when it was not a turn of its own: steered into the running turn, or sent from the queue. */
      delivery: optionalKey(Schema.Literals(["steer", "queue"])),
      /** A scheduled task (schedule_task) sent this user-role message on its schedule, not the person; its title when still known. */
      scheduled_task: optionalKey(S({ task_id: Id, title: optionalKey(Schema.String) })),
      /**
       * The runtime wrote this user-role message for the agent, not the person: a builder's result, its builders' one
       * result, the word to carry on after a plan's reset. `text` stays what the agent was given; `shown` is the one
       * line a person reads of it ("Port the settings page finished"). A client draws `shown` as a row of the chat,
       * never `text`, and never as the person's own message. With `builders_result` the row is that result.
       */
      generated: optionalKey(S({ shown: Schema.String })),
      /**
       * With `generated`: what became of a lead's builders once their work came together, for the one row "28 of 30
       * merged · 2 left out · PR #128". `left_out` names the builders the row's click shows.
       */
      builders_result: optionalKey(BuildersResult),
    }),
  ),
  event("reasoning.delta", Text),
  event(
    "tool.started",
    S({
      name: Schema.String,
      title: Schema.String,
      kind: Schema.Literals(["command", "read", "edit", "search", "web", "mcp", "browser", "other"]),
      input: Schema.Unknown,
      /**
       * An edit that changed several files at once (a Codex patch), or moved one: every file in the order the engine
       * gave them, with what happened to it. The title still names the first file, for clients that read only it.
       */
      files: optionalKey(Schema.Array(ToolFile)),
      /** One of the runtime's own tools on other threads (thread_send, thread_read, …): the threads its input names. */
      threads: optionalKey(Schema.Array(ToolThread)),
    }),
  ),
  event("tool.output", S({ text: Schema.String, stream: optionalKey(Schema.Literals(["stdout", "stderr"])) })),
  event(
    "tool.done",
    S({
      status: Schema.Literals(["completed", "failed", "declined"]),
      result: optionalKey(Schema.Unknown),
      error: optionalKey(Schema.String),
      /** One of the runtime's own tools: the threads its result names (the ones thread_launch and create_threads made). */
      threads: optionalKey(Schema.Array(ToolThread)),
    }),
  ),
  event(
    "plan.updated",
    S({
      kind: Schema.Literals(["todos"]),
      steps: Schema.Array(
        S({ text: Schema.String, status: Schema.Literals(["pending", "in_progress", "completed"]) }),
      ),
      markdown: optionalKey(Schema.String),
    }),
  ),
  event("diff.changed", S({ files: Schema.Array(FileChange) })),
  event("ask.user", AskUser),
  event(
    "ask.resolved",
    S({
      outcome: Schema.Literals(["answered", "cancelled", "expired"]),
      response: optionalKey(AskResponse),
    }),
  ),
  /** Grill mode: every question is settled and the engine wrote its decisions doc at `doc_path` (a worktree path). */
  event("grill.finished", S({ doc_path: Schema.String, summary: Schema.String })),
  /**
   * `workspace_id`: a delegated agent's own workspace (nested under this one), which holds its transcript, asks, spend
   * and diff. `task_id`: the delegate_task call that started it, as that call's result names it (`taskId`).
   */
  event("subagent.started", S({ title: Schema.String, agent: optionalKey(Schema.String), workspace_id: optionalKey(Id), task_id: optionalKey(Schema.String), runner: optionalKey(SubagentRunner) })),
  event(
    "subagent.done",
    S({
      status: Schema.Literals(["completed", "failed", "interrupted"]),
      summary: optionalKey(Schema.String),
    }),
  ),
  /**
   * A finished turn's checkpoint. `files`: what the turn itself changed, from the checkpoint taken as it began to this
   * one, with line counts (0 and 0 for a binary file), files a pull or rebase it ran brought in left out; the turn's
   * Changes card. Absent from checkpoints recorded before it was added. A turn that changed more than 200 files (a
   * vendored or generated tree) lists the first 200, and `files_total` counts them all: clients say "N more files".
   */
  event(
    "checkpoint.created",
    S({ checkpoint_id: Id, ref: Schema.String, files: optionalKey(Schema.Array(TurnFile)), files_total: optionalKey(TurnFilesTotal) }),
  ),
  /**
   * The turn that ended at `checkpoint_id` had its changes settled (checkpoint.keep / checkpoint.undo): kept, or
   * undone (`files` went back to how they were before the turn). Its Changes card closes.
   */
  event(
    "checkpoint.resolved",
    S({ checkpoint_id: Id, resolution: Schema.Literals(["kept", "undone"]), files: Schema.Array(WorkspacePath) }),
  ),
  /**
   * session.restore: files and transcript went back to the turn.done at
   * `at`. Clients drop what came after `at` up to this event; the later turns
   * live on in `branch_workspace_id`.
   */
  event("session.restored", S({ at: Cursor, branch_workspace_id: optionalKey(Id) })),
  /** The session's goal (goal.set); null when cleared. `native`: the engine pursues it itself. */
  event("goal.updated", S({ objective: Schema.NullOr(Schema.String), native: Schema.Boolean })),
  /**
   * How full the engine's context window is; drives the Context card. `compact_at_tokens`: where the engine compacts
   * by itself when its settings put that below the window (Claude Agent's auto-compact window).
   */
  event("context.updated", S({ used_tokens: Count, window_tokens: Count, compact_at_tokens: optionalKey(Count) })),
  /** The engine is shrinking its context. Engines that only report the result send `compaction.done` alone. */
  event("compaction.started", S({})),
  event(
    "compaction.done",
    S({ status: Schema.Literals(["completed", "failed"]), before_tokens: optionalKey(Count), after_tokens: optionalKey(Count) }),
  ),
  /** The router moved the engine's calls to this model. Never the router's reasons: the policy stays in Caveman Cloud. */
  event("model.routed", S({ model: Schema.String })),
  /**
   * The whole queue after any client changed it (turn.submit queued, queue.edit,
   * .remove, .reorder); replaces the previous one. Inputs that start leave the
   * queue with their turn.started.
   */
  event("queue.updated", S({ turns: Schema.Array(QueuedTurn) })),
  event(
    "turn.done",
    S({
      status: Schema.Literals(["completed", "interrupted", "failed"]),
      error: optionalKey(Schema.String),
      /** failed: the engine's own kind of failure, present even when `error` is left out (a usage-limit notice said it). */
      failure: optionalKey(EngineFailure),
      /** interrupted: the chat moved to another computer mid-turn; the turn carries on there, told what already ran. */
      reason: optionalKey(Schema.Literals(["moved"])),
    }),
  ),
  event(
    "usage",
    S({
      /** The engine that made the call; absent on older events (count it under the workspace's engine). */
      engine: optionalKey(EngineId),
      model: Schema.String,
      input_tokens: Count,
      output_tokens: Count,
      cache_read_tokens: Count,
      cache_write_tokens: Count,
      /** Web searches the turn ran, subagents' included, when the engine counts them (Claude Agent). Their price is already in `cost`. Settings only, never shown in a session. */
      web_searches: optionalKey(Count),
      /** null when nothing is known (a subscription). list_price = computed, not billed. */
      cost: Schema.NullOr(S({ usd: Schema.Number, basis: Schema.Literals(["billed", "list_price"]) })),
      /** Who pays: a per-token key (Caveman engine, Codex on an API key) or a subscription plan (Claude Agent, Codex on ChatGPT). Absent on older events. */
      billing: optionalKey(Schema.Literals(["api_key", "plan"])),
      /** From the turn's start to its first streamed text or reasoning, and to its end. Measured on this computer. */
      ttft_ms: optionalKey(Count),
      duration_ms: optionalKey(Count),
    }),
  ),
  event(
    "session.parked",
    S({
      reason: Schema.Literals(["user", "move", "suspend", "handoff"]),
      /** Moves (ADR 0126): where a `move` went, and why: the lid closed, the person asked, or Cloud moved it while the Mac slept. */
      to: optionalKey(Schema.Literals(["cloud", "this_mac"])),
      cause: optionalKey(Schema.Literals(["lid", "user", "asleep"])),
      /** A move to another of the person's Macs: that Mac's name, as Cloud lists it. */
      name: optionalKey(Schema.String),
    }),
  ),
  event(
    "session.resumed",
    S({
      computer_id: Id,
      /** Moves (ADR 0126): a move this computer started did not go through, so the chat carries on here; why, in a line. */
      move_failed: optionalKey(Schema.String),
    }),
  ),
  event(
    "engine.status",
    S({
      engine: EngineId,
      auth: optionalKey(AuthState),
      rate_limit: optionalKey(S({ limited: Schema.Boolean, resets_at: optionalKey(IsoDateTime) })),
      version: optionalKey(Schema.String),
      message: optionalKey(Schema.String),
    }),
  ),
  event(
    "notification",
    S({
      level: Schema.Literals(["info", "warning"]),
      title: Schema.String,
      body: optionalKey(Schema.String),
      mail: optionalKey(MailMessage),
      /**
       * A memory change or recall at the moment it happened (docs/memory.md "In the transcript"): `remembered`, a
       * note in the person's words; `saved`, an agent's unconfirmed draft; `recalled`, notes the runtime pushed to
       * the agent. The notes' ids are memory.forget / memory.undo's. Never a note's cost.
       */
      memory: optionalKey(
        S({
          kind: Schema.Literals(["remembered", "saved", "recalled"]),
          notes: Schema.Array(S({ id: Id, name: Schema.String })),
        }),
      ),
      /** A moment in a Chief's conversation (docs/chief.md "Its screen" and "Watching"), found by the runtime, never its model. */
      moment: optionalKey(ChiefMoment),
    }),
  ),
  /** A call with the Chief (chief.voice.*), in the Chief's session: it went live, or ended (`duration_ms` from live). */
  event(
    "voice.call",
    S({
      call_id: Id,
      state: Schema.Literals(["started", "ended"]),
      duration_ms: optionalKey(Count),
      reason: optionalKey(Schema.String),
    }),
  ),
  /**
   * One finished turn of a call, as transcribed: the person's words, or what the voice said. `handoff`: this turn
   * handed the person's words to the Chief as the note `item_id` (its text exactly the note's, which then shows as
   * handed off rather than as a second message).
   */
  event(
    "voice.turn",
    S({
      call_id: Id,
      role: Schema.Literals(["person", "voice"]),
      text: Schema.String,
      handoff: optionalKey(S({ item_id: Id, text: Schema.String })),
    }),
  ),
  event(
    "error",
    S({
      reason: ErrorReason,
      message: Schema.String,
      /** The engine is retrying the call that failed: the turn goes on. */
      retry: optionalKey(S({ attempt: Count, max_attempts: optionalKey(Count), delay_ms: optionalKey(Count) })),
      /** The engine's own kind of the failed call (a 429 is usage_limit, a 529 provider_error). */
      failure: optionalKey(EngineFailure),
    }),
  ),
]).annotate({ identifier: "SessionEvent" });
export type SessionEvent = typeof SessionEvent.Type;
export type SessionEventType = SessionEvent["type"];

// ------------------------------------------------------------- outside agents
// Agents Caveman Code did not launch, operating it through `caveman-code mcp`.

/**
 * How much an outside agent may do. read: look only. supervised: start, message and stop its own chats, which run
 * Supervised (every command and edit waits for the person). full: any chat but a Chief's or a setup chat, at any
 * access, plus commit, push, pull requests and new projects; its chats run commands as the person.
 */
export const OutsideAgentLevel = Schema.Literals(["read", "supervised", "full"]).annotate({ identifier: "OutsideAgentLevel" });
export type OutsideAgentLevel = typeof OutsideAgentLevel.Type;

/** One outside agent, by the name it connects as (Settings > Caveman MCP). */
export const OutsideAgent = Schema.Struct({
  name: Schema.String,
  level: OutsideAgentLevel,
  /** Disconnected by the person: `outside_agent.become` is refused under this name until they allow it again. */
  blocked: Schema.Boolean,
  /** Its connections open now (one per `caveman-code mcp` process). */
  connected: Count,
  first_seen_at: IsoDateTime,
  last_seen_at: IsoDateTime,
  /** Chats it started that are not archived, and how many of them are working. */
  chats: Count,
  working: Count,
}).annotate({ identifier: "OutsideAgent" });
export type OutsideAgent = typeof OutsideAgent.Type;

/** An MCP client Settings > Caveman MCP installs `caveman-code` into with one click (outside_agent.install). */
export const McpClientId = Schema.Literals(["claude-code", "codex", "grok", "cursor", "vscode", "grok-bot"]).annotate({ identifier: "McpClientId" });
export type McpClientId = typeof McpClientId.Type;

/** Whether a client is on this computer, and whether its config already holds the `caveman-code` server. */
export const McpClientStatus = Schema.Struct({ id: McpClientId, found: Schema.Boolean, installed: Schema.Boolean }).annotate({ identifier: "McpClientStatus" });
export type McpClientStatus = typeof McpClientStatus.Type;

export const OutsideAgentList = Schema.Struct({
  agents: Schema.Array(OutsideAgent),
  /** The command an MCP client runs to connect (argv): the `caveman-code` launcher's full path and `mcp`. */
  command: Schema.Array(Schema.String),
  /** Each client outside_agent.install knows, in McpClientId's order. A runtime from before it sends none. */
  clients: optionalKey(Schema.Array(McpClientStatus)),
}).annotate({ identifier: "OutsideAgentList" });
export type OutsideAgentList = typeof OutsideAgentList.Type;

/** workspace.digest: a chat in one answer, without replaying its transcript (what an outside agent's chat_read shows). */
export const WorkspaceDigest = Schema.Struct({
  workspace: Workspace,
  /** Its task: the first message, as typed. */
  goal: optionalKey(Schema.String),
  /** The latest assistant answer, cut at 2,000 characters (`latest_clipped`). */
  latest: optionalKey(Schema.String),
  latest_clipped: optionalKey(Schema.Boolean),
  messages: Count,
  /** The options the latest turn ran with (engine, model, effort, access). */
  options: optionalKey(TurnOptions),
  /** The running turn's latest tool, by its title. */
  step: optionalKey(Schema.String),
  /** When the chat entered its status: the running turn's start, else the latest turn's end. */
  since: optionalKey(IsoDateTime),
  /** The latest turn failed: its error line. */
  error: optionalKey(Schema.String),
  /** Messages waiting behind the running turn. */
  queued: Count,
  /** The ask the chat waits on, in full (ask.respond's ask_id). */
  ask: optionalKey(Schema.Struct({ ask_id: Id, ask: AskUser })),
  /** What the latest finished turn changed (its Changes card); `files_total` when `files` is its first 200. */
  files: optionalKey(Schema.Array(TurnFile)),
  files_total: optionalKey(TurnFilesTotal),
  /** The latest finished turn's checkpoint while its changes are unsettled: what checkpoint.undo takes. */
  checkpoint_id: optionalKey(Id),
  /**
   * With `transcript` asked: a page of the journal, oldest first, ending just before `before` (else at the head), at most
   * `max_bytes` of event JSON. `usage` events are left out. `from`: the first cursor in the page (pass it as the next
   * `before`); `more`: earlier events exist.
   */
  transcript: optionalKey(Schema.Struct({ events: Schema.Array(SessionEvent), from: Cursor, more: Schema.Boolean })),
}).annotate({ identifier: "WorkspaceDigest" });
export type WorkspaceDigest = typeof WorkspaceDigest.Type;

// ------------------------------------------------------------------- methods

const Empty = S({});
const req = { request_id: RequestId };
/** The longest SDP a direct.offer may carry: a data-channel offer with its candidates is about 1-3 KiB. */
export const DIRECT_SDP_MAX = 16 * 1024;
const DirectId = Id.check(Schema.isMaxLength(64));
/** An ICE candidate of a direct attempt (DESIGN S14): `candidate:...` text ("" ends them) and its media id. */
const DirectCandidate = S({
  id: DirectId,
  candidate: Schema.String.check(Schema.isMaxLength(1024)),
  mid: optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});

/** Who drives a browser or desktop right now. */
const Controller = Schema.Literals(["agent", "user", "none"]);
/** Modifier bitmask as in CDP: alt 1, ctrl 2, meta 4, shift 8. */
const Modifiers = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }));
const InputEvent = Schema.Union([
  S({
    type: Schema.Literal("pointer"),
    action: Schema.Literals(["move", "down", "up"]),
    x: Schema.Number,
    y: Schema.Number,
    button: optionalKey(Schema.Literals(["left", "middle", "right"])),
    modifiers: Modifiers,
  }),
  S({ type: Schema.Literal("wheel"), x: Schema.Number, y: Schema.Number, dx: Schema.Number, dy: Schema.Number, modifiers: Modifiers }),
  S({ type: Schema.Literal("key"), action: Schema.Literals(["down", "up"]), key: Schema.String, code: Schema.String, modifiers: Modifiers }),
  /** IME commits and paste. */
  S({ type: Schema.Literal("text"), text: Schema.String }),
]).annotate({ identifier: "InputEvent" });
/** A page's alert, confirm, prompt or leave-page check, waiting for an answer (browser.state `dialog`). */
const BrowserDialog = S({
  type: Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]),
  message: Schema.String,
  default_value: Schema.String,
}).annotate({ identifier: "BrowserDialog" });
/** browser.input's events: an InputEvent, or the answer to the page's dialog (OK with `accept`, a prompt's `text`). */
const BrowserInputEvent = Schema.Union([
  InputEvent,
  S({ type: Schema.Literal("dialog"), accept: Schema.Boolean, text: optionalKey(Schema.String) }),
]).annotate({ identifier: "BrowserInputEvent" });
const AgentPointer = S({ workspace_id: Id, x: Schema.Number, y: Schema.Number, phase: Schema.Literals(["move", "click", "type"]), seq: Count });
const ws = { workspace_id: Id };
const ses = { session_id: Id };
/** The longest diff session.move.held shows of one held-back file, in bytes, and of all of them together. */
export const HELD_DIFF_MAX = 32 * 1024;
export const HELD_DIFFS_MAX = 256 * 1024;
/**
 * One file a return from Cloud held back (session.move.held), as the person reviews it before applying (A-8): what
 * Cloud did to it against this Mac's version (`changed`; `added`, this Mac has none; `removed`, Cloud has none;
 * `link` or `submodule`, a link on either side, shown by its target and never followed; `binary`; `too_big`, past
 * what a review shows), a unified diff of this Mac's version against Cloud's (at most HELD_DIFF_MAX, `truncated`
 * past it), and `runs`: commands Cloud's version would have an agent, a tool or git run on this Mac that this Mac's
 * does not (hooks, MCP servers, .envrc, hook scripts), as written, the first HELD_RUNS_MAX of them; `more_runs` counts
 * the rest. A hook or an executable file is read as the script it is even when it holds a NUL (shown `binary`).
 * `runs_unread`: Cloud's version is config the review could not read as its tool does (it does not parse, names a
 * command the review cannot, or is past what a review parses), so `runs` is only what its lines show.
 */
export const HeldFile = S({
  path: Schema.String,
  change: Schema.Literals(["changed", "added", "removed", "link", "submodule", "binary", "too_big"]),
  diff: Schema.String,
  truncated: optionalKey(Schema.Boolean),
  runs: optionalKey(Schema.Array(Schema.String)),
  more_runs: optionalKey(Count),
  runs_unread: optionalKey(Schema.Boolean),
  /** A secret-shaped file (.env*, keys), not agent or tool config. */
  secret: optionalKey(Schema.Boolean),
}).annotate({ identifier: "HeldFile" });
export type HeldFile = typeof HeldFile.Type;
/** The most commands a held file's review names (HeldFile.runs); `more_runs` counts the rest. */
export const HELD_RUNS_MAX = 20;
/**
 * Why Cloud's held-back files cannot be applied from the review (F-4), or undefined when every one of them was shown
 * whole: the review covers each path (`files`), and none is binary, too big, cut short, would run more commands than
 * it names, or holds commands it could not read. What the review could not show waits on the held ref, to apply in git
 * by hand.
 */
export function heldNotShown(held: { readonly paths: ReadonlyArray<string>; readonly files?: ReadonlyArray<HeldFile> | undefined }): string | undefined {
  if (held.files === undefined) return "This Mac's runtime can't show these changes";
  if (held.files.length < held.paths.length) return `${held.paths.length} files are more than a review shows here`;
  const unshown = held.files.filter((file) => file.change === "binary" || file.change === "too_big" || file.truncated === true || (file.more_runs ?? 0) > 0 || file.runs_unread === true);
  if (unshown.length === 0) return undefined;
  const why = (file: HeldFile) =>
    file.change === "binary"
      ? "binary"
      : file.change === "too_big"
        ? "too big to show"
        : file.truncated
          ? "only partly shown"
          : file.runs_unread
            ? "its commands could not all be read"
            : `it would run ${file.more_runs} more commands than shown`;
  return `Not all of Cloud's changes can be shown here (${unshown.map((file) => `${file.path}: ${why(file)}`).join("; ")})`;
}
/**
 * The device that asked for a call or a move, and its signature over exactly it (devices.ts signCall, signMove): This
 * Mac runs a queued call, lets a chat go or takes one only when a device it allowed for that person signed it (S13).
 */
export const CallDevice = S({ device_id: Schema.String, at: IsoDateTime, signature: Schema.String });
export type CallDevice = typeof CallDevice.Type;
const m = <P extends Schema.Struct.Fields, R extends Schema.Top>(params: P, result: R) => ({
  params: S(params),
  result,
});
const mailSend = m({ ...req, ...ses, to_workspace_id: Id, body: Schema.String, reply_to: optionalKey(Id) }, MailMessage);

// ------------------------------------------------------------- problem reports
// One button wherever an error shows: the runtime gathers its logs, redacts them on this computer, a model
// describes the problem, and nothing leaves until the person has read the preview and pressed Send.

export const BugReportSurface = Schema.Literals(["chat", "chief", "onboarding", "install", "runtime", "other"]);
export const ReportedError = S({ name: optionalKey(Schema.String), message: Schema.String, stack: optionalKey(Schema.String) });
/** A report ready to read before sending: every text redacted, exactly as it would be sent. Nothing is sent yet. */
export const BugReportPrepared = S({
  report_id: Id,
  created_at: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  /** "template" until a model wrote it (bug_report.describe). */
  drafted_by: Schema.Literals(["template", "agent"]),
  /** `code`: holds chats or file contents, sent only with include.code. */
  files: Schema.Array(S({ name: Schema.String, code: Schema.Boolean, text: Schema.String, bytes: Count })),
  /** The end of the chat: `plain` with code removed, `with_code` as it is (both redacted otherwise). */
  excerpt: optionalKey(S({ plain: Schema.String, with_code: Schema.String })),
  screenshot: optionalKey(S({ bytes: Count, png_base64: Schema.String })),
  /** The rules' version and how many times each removed something. */
  redaction: S({ version: Schema.String, counts: Schema.Record(Schema.String, Count) }),
  meta: S({
    app_version: Schema.String,
    build_channel: Schema.String,
    platform: Schema.String,
    os_version: Schema.String,
    arch: Schema.String,
    error_signature: Schema.String,
    surface: BugReportSurface,
    provider_id: optionalKey(Schema.String),
    model_id: optionalKey(Schema.String),
    thread_id: optionalKey(Schema.String),
  }),
}).annotate({ identifier: "BugReportPrepared" });
export type BugReportPrepared = typeof BugReportPrepared.Type;
/** A report on this computer: waiting to send, sent (and what Caveman says of it since), or refused for good. */
export const BugReportRecord = S({
  report_id: Id,
  title: Schema.String,
  surface: BugReportSurface,
  created_at: Schema.String,
  state: Schema.Literals(["queued", "sending", "sent", "failed"]),
  attempts: Count,
  next_attempt_at: optionalKey(Schema.String),
  last_error: optionalKey(Schema.String),
  sent_at: optionalKey(Schema.String),
  server_status: optionalKey(Schema.Literals(["received", "triaged", "fixed"])),
  fixed_in_version: optionalKey(Schema.String),
  duplicate_of: optionalKey(Schema.String),
}).annotate({ identifier: "BugReportRecord" });
export type BugReportRecord = typeof BugReportRecord.Type;

// ------------------------------------------------------------- pull requests (Review)
// Compact views over the runtime's source-control service (T3's, through the host's own CLI such as gh):
// what the Review page draws, nothing more.

/** Someone on the git host. */
export const PrActor = S({ login: Schema.String, avatar_url: optionalKey(Schema.String), bot: optionalKey(Schema.Boolean) }).annotate({ identifier: "PrActor" });
export type PrActor = typeof PrActor.Type;

/** One pull request: a project of ours and its number; `repo`/`host` route one from another repository on the same host. */
const PrRef = { project_id: Id, number: Count, repo: optionalKey(Schema.String), host: optionalKey(Schema.String) };

/** A pull request as the Review queue lists it. */
export const PrSummary = S({
  project_id: Id,
  /** owner/name on the host. */
  repo: Schema.String,
  host: Schema.String,
  number: Count,
  title: Schema.String,
  url: Schema.String,
  author: optionalKey(PrActor),
  head_branch: Schema.String,
  base_branch: Schema.String,
  state: PullRequest.fields.state,
  /** 0 and 0 until the host reported counts. */
  additions: Count,
  deletions: Count,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  /** The signed-in person was asked to review it. */
  review_requested: Schema.Boolean,
  /** The signed-in person opened it. */
  mine: Schema.Boolean,
  review: optionalKey(Schema.Literals(["approved", "changes_requested", "review_required"])),
  checks: optionalKey(Schema.Literals(["passing", "failing", "pending"])),
  labels: optionalKey(Schema.Array(S({ name: Schema.String, color: optionalKey(Schema.String) }))),
  /** A chat of ours on its head branch, newest first. */
  workspace_id: optionalKey(Id),
  /** Open and a guide is stored for it, so opening it reads one at once (it may be a push behind). */
  guide_ready: optionalKey(Schema.Boolean),
}).annotate({ identifier: "PrSummary" });
export type PrSummary = typeof PrSummary.Type;

export const PrCheck = S({
  name: Schema.String,
  status: Schema.Literals(["passed", "failed", "pending", "skipped"]),
  url: optionalKey(Schema.String),
}).annotate({ identifier: "PrCheck" });
export type PrCheck = typeof PrCheck.Type;

export const PrDetail = S({
  ...PrSummary.fields,
  /** The host counted only part of the change, so `additions` and `deletions` are floors. */
  diff_stat_truncated: optionalKey(Schema.Boolean),
  /** Markdown, as its author wrote it. */
  body: Schema.String,
  /** Absent where the host did not say. */
  head_sha: optionalKey(Schema.String),
  mergeable: Schema.Literals(["clean", "conflicting", "blocked", "unknown"]),
  checks_list: Schema.Array(PrCheck),
  reviewers: Schema.Array(S({ ...PrActor.fields, state: Schema.Literals(["approved", "changes_requested", "commented", "pending"]) })),
  commits: Count,
  /** Changed files without patches (pr.diff has them); `viewed` is the person's own mark. */
  files: Schema.Array(S({ ...FileChange.fields, viewed: Schema.Boolean })),
  /** What the signed-in person may do here. */
  can: S({
    merge: Schema.Boolean,
    review: Schema.Boolean,
    comment: Schema.Boolean,
    merge_methods: Schema.Array(Schema.Literals(["squash", "merge", "rebase"])),
    /** Mark a draft ready for review (the author's, or anyone with write access). */
    ready: Schema.Boolean,
  }),
}).annotate({ identifier: "PrDetail" });
export type PrDetail = typeof PrDetail.Type;

/** A top-level comment or a submitted review, in the order they were written. */
export const PrComment = S({
  type: Schema.Literal("comment"),
  id: Id,
  author: optionalKey(PrActor),
  body: Schema.String,
  at: IsoDateTime,
  /** A review's verdict; absent for a plain comment. */
  verdict: optionalKey(Schema.Literals(["approved", "changes_requested", "commented"])),
  url: optionalKey(Schema.String),
  /** The pull request's review guide, posted as this comment; the Guide tab shows it. */
  guide: optionalKey(Schema.Boolean),
}).annotate({ identifier: "PrComment" });
/** A conversation on lines of one file. `line` is on `side`; absent once the lines are gone. */
export const PrThread = S({
  type: Schema.Literal("thread"),
  id: Id,
  path: Schema.String,
  line: optionalKey(Count),
  side: Schema.Literals(["new", "old"]),
  resolved: Schema.Boolean,
  outdated: Schema.Boolean,
  /** The diff lines it was written on, for showing it out of the diff. */
  hunk: optionalKey(Schema.String),
  comments: Schema.Array(S({ id: Id, author: optionalKey(PrActor), body: Schema.String, at: IsoDateTime })),
}).annotate({ identifier: "PrThread" });
export const PrDiscussionItem = Schema.Union([PrComment, PrThread]).annotate({ identifier: "PrDiscussionItem" });
export type PrDiscussionItem = typeof PrDiscussionItem.Type;

/**
 * The one call a maintainer should make at a stop (not a bug or a nit: review agents own those).
 * kind: tradeoff, contract (a compatibility or API promise), product, risk (accepted), accessibility.
 */
export const PrGuideAttention = S({ kind: Schema.Literals(["tradeoff", "contract", "product", "risk", "accessibility"]), note: Schema.String });

/** One stop of the tour, in reading order. Excerpts and notes are clamped to lines the change touched. */
export const PrGuideStop = S({
  /** What the stop accomplishes, as an action: "Merge gate blocks red CI". */
  title: Schema.String,
  /** Terse: before → after, and why. */
  summary: Schema.String,
  attention: Schema.NullOr(PrGuideAttention),
  excerpts: Schema.Array(S({ path: Schema.String, side: Schema.Literals(["new", "old"]), start: Count, end: Count, caption: Schema.String })),
  /** Changed files it owns that no stop excerpts, each with a one-line note. */
  files: Schema.Array(S({ path: Schema.String, note: optionalKey(Schema.String) })),
  /** Why a line is shaped this way, anchored inside one of the stop's excerpts. */
  notes: Schema.Array(S({ path: Schema.String, line: Count, title: Schema.String, body: Schema.String })),
  /** Questions about intent a reader might ask an agent here. */
  questions: Schema.Array(Schema.String),
}).annotate({ identifier: "PrGuideStop" });
export type PrGuideStop = typeof PrGuideStop.Type;

/**
 * A behaviour-level before/after of the whole change, as indented pseudo-code rows: " " kept, "-" gone, "+" new.
 * `stop` is the 1-based stop that implements a row.
 */
export const PrGuideBeforeAfter = S({
  title: Schema.String,
  rows: Schema.Array(S({ op: Schema.Literals([" ", "-", "+"]), depth: Count, text: Schema.String, stop: optionalKey(Count) })),
}).annotate({ identifier: "PrGuideBeforeAfter" });
export type PrGuideBeforeAfter = typeof PrGuideBeforeAfter.Type;

/** A guided review: a tour of the change for the person deciding whether it lands. */
export const PrGuide = S({
  /** The head it was written against; another head now means it is stale. */
  head_sha: Schema.String,
  generated_at: IsoDateTime,
  /** The model that wrote it, as the person would name it. */
  model: optionalKey(Schema.String),
  /** The whole change in one or two terse sentences: what it does, then why ("Merge button now locks on red CI and says why."). */
  tldr: optionalKey(Schema.String),
  /** One to three short lines: what the change does and why. Absent on guides written before it existed. */
  overview: optionalKey(Schema.String),
  before_after: optionalKey(PrGuideBeforeAfter),
  stops: Schema.Array(PrGuideStop),
  /**
   * tldr: a short change's guide (settings `review_short_lines`): the TL;DR and `attention`, no stops; the diff is the
   * rest. tour: the stops above. Absent on guides written before it existed, which are tours.
   */
  depth: optionalKey(Schema.Literals(["tldr", "tour"])),
  /** A short change's one call for the maintainer, when it has one; a tour puts its calls on its stops. */
  attention: optionalKey(PrGuideAttention),
  /**
   * chat: the TL;DR is the one the chat that opened the pull request wrote in that turn (`workspace_id` is that chat,
   * when it is here). model: a model read the change. template: code alone (a dependency bump, mechanical files).
   */
  by: optionalKey(Schema.Literals(["chat", "model", "template"])),
  workspace_id: optionalKey(Id),
  /** Read from the guide comment this person posted on the pull request, not written on this computer. */
  posted_by: optionalKey(Schema.String),
}).annotate({ identifier: "PrGuide" });
export type PrGuide = typeof PrGuide.Type;

export const PrGuideResult = S({
  guide: Schema.NullOr(PrGuide),
  /** A run is writing one for `head_sha` now (minutes on a large change; poll pr.guide). */
  running: Schema.Boolean,
  /** The last run for this head failed, saying why. */
  failed: optionalKey(Schema.String),
  /** The pull request's head now; absent where the host did not say. */
  head_sha: optionalKey(Schema.String),
  /**
   * The guide's comment on the pull request: where, the head it was written for (absent when it does not say), and
   * whether the signed-in person posted it, which is the one this runtime keeps current. Absent when there is none.
   */
  comment: optionalKey(S({ url: Schema.String, head_sha: optionalKey(Schema.String), mine: Schema.Boolean })),
  /** The signed-in person may post the guide here with pr.post_guide: a host it renders on, and they may comment. */
  can_post: optionalKey(Schema.Boolean),
}).annotate({ identifier: "PrGuideResult" });
export type PrGuideResult = typeof PrGuideResult.Type;

/** A Remote control sign-in waiting for the person to approve `user_code` in Caveman Cloud. */
export const CloudSignin = Schema.Struct({
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  /** ISO 8601: the code stops working then. */
  expires_at: Schema.String,
}).annotate({ identifier: "CloudSignin" });
export type CloudSignin = typeof CloudSignin.Type;

/** The Cloud account that approved this computer's sign-in: Remote control acts as it. */
export const CloudAccount = Schema.Struct({
  email: Schema.String,
  organization_name: optionalKey(Schema.String),
  /** Their role in the org when they signed in: owner and admin may install for the team and make a plugin Required. */
  role: optionalKey(Schema.Literals(["owner", "admin", "member"])),
}).annotate({ identifier: "CloudAccount" });
export type CloudAccount = typeof CloudAccount.Type;

/**
 * Pay as you go in Cloud's plan catalog (`code.auto_topup`): the smallest
 * monthly limit, the bounds of what one charge adds and of the balance that
 * triggers it, the shares of the limit at which Owners and Finance get an
 * email, and the monthly limits an organization unlocks with paid history. A
 * ceiling holds once `after_paid_usd` of top-ups were paid at least
 * `after_days` ago; while auto top-up is on, its request limits apply.
 * Cheapest first; the app shows these and none of its own.
 */
export const CodeAutoTopupCatalog = Schema.Struct({
  min_month_usd: Schema.Number,
  amount_usd: Schema.Struct({ min: Schema.Number, max: Schema.Number }),
  below_usd: Schema.Struct({ min: Schema.Number }),
  alert_pcts: Schema.Array(Schema.Number),
  ceilings: Schema.Array(
    Schema.Struct({
      month_usd: Schema.Number,
      after_paid_usd: Schema.Number,
      after_days: Schema.Number,
      requests_per_minute: Schema.Number,
      concurrent_requests: Schema.Number,
    }),
  ),
}).annotate({ identifier: "CodeAutoTopupCatalog" });
export type CodeAutoTopupCatalog = typeof CodeAutoTopupCatalog.Type;

/**
 * The organization's pay as you go (GET /api/v1/code/credits `auto_topup`),
 * absent until first set. Cloud adds `amount_usd` from the saved `card` when
 * credits fall below `below_usd`, never past `month_limit_usd` (nor
 * `ceiling_usd`) in a calendar month (UTC). `charged_micros`: this month's
 * succeeded and in-flight charges, pre-tax; `charging`: one is in flight now.
 * `paused`: why Cloud stopped charging (null while it charges); only Caveman
 * clears `disputed`. `confirm_url`: the open invoice's page while paused for
 * `authentication_required`, where the cardholder confirms the payment.
 * `next_ceiling`: what unlocks the next limit and how much counts toward it so
 * far; null at the top, or under a limit Caveman set by hand.
 */
export const CodeAutoTopup = Schema.Struct({
  enabled: Schema.Boolean,
  month_limit_usd: Schema.Number,
  amount_usd: Schema.Number,
  below_usd: Schema.Number,
  charged_micros: Schema.Number,
  charging: Schema.Boolean,
  card: Schema.NullOr(Schema.Struct({ brand: Schema.String, last4: Schema.String, exp_month: Schema.Number, exp_year: Schema.Number })),
  paused: Schema.NullOr(Schema.Literals(["card_declined", "authentication_required", "card_expired", "disputed", "charge_failed"])),
  confirm_url: Schema.NullOr(Schema.String),
  ceiling_usd: Schema.Number,
  next_ceiling: Schema.NullOr(Schema.Struct({ month_usd: Schema.Number, after_paid_usd: Schema.Number, after_days: Schema.Number, paid_usd: Schema.Number })),
}).annotate({ identifier: "CodeAutoTopup" });
export type CodeAutoTopup = typeof CodeAutoTopup.Type;

/**
 * The Code plans a Caveman Cloud sells, as its plan catalog says (GET
 * /api/v1/code/plans): the app shows these and no numbers of its own. Every
 * paid plan is listed, cheapest first; `on_sale` is false for a retired one an
 * organization may still hold. `purchasable` is false where this Cloud takes
 * no payments.
 *
 * What a plan holds stays private: the only dollars
 * here are a plan's price and its `up_to_usd` headline ("up to $60 of usage").
 * Its included dollars, the size of its limits, what a model or a computer
 * minute draws: none of that is in the protocol, and a client never works it
 * out. Plans compare in plain words through `usage_times`.
 */
export const CodeOffer = Schema.Struct({
  catalog_version: Schema.Number,
  purchasable: Schema.Boolean,
  plans: Schema.Array(
    Schema.Struct({
      plan: Schema.String,
      label: Schema.String,
      usd_month: Schema.Number,
      usd_year: Schema.Number,
      per_seat: Schema.Boolean,
      /** The headline: "up to $60 of usage" a month. The one dollar figure about what a plan holds. */
      up_to_usd: Schema.Number,
      on_sale: Schema.Boolean,
      /** How much usage the plan holds next to `usage_base`'s, in whole times, rounded down: 5 is "5 times Pro". Absent from a Cloud that does not say. */
      usage_times: optionalKey(Schema.Number),
      /** The limits that meter the plan, by name (`5h`, `week`, `month`), never their size or their share of one another. Absent from a Cloud that does not say. */
      windows: optionalKey(Schema.Array(Schema.String)),
      /** Cloud computers the plan allows: kept (asleep included), memory awake at once, largest size (`4x16`). */
      computers: optionalKey(Schema.Struct({ kept: Schema.Number, awake_gib: Schema.Number, max_size: Schema.String })),
      /** Free months of the gift plan a first purchase of this plan earns to give friends. */
      gifts: optionalKey(Schema.Number),
    }),
  ),
  /** What one gift gives a friend: `months` of `plan`, card required. Absent where this Cloud gives none. */
  gift: optionalKey(Schema.Struct({ plan: Schema.String, months: Schema.Number })),
  /** The plan `usage_times` counts from (the cheapest one a person can buy alone). */
  usage_base: optionalKey(Schema.String),
  top_up: Schema.Struct({ min_usd: Schema.Number, max_usd: Schema.Number, expires_days: Schema.Number }),
  /** Pay as you go's limits, amounts and alerts; absent where this Cloud offers none. */
  auto_topup: optionalKey(CodeAutoTopupCatalog),
}).annotate({ identifier: "CodeOffer" });
export type CodeOffer = typeof CodeOffer.Type;

/**
 * The organization's bound Code plan subscription as Stripe last reported it.
 * `status`: active; past_due (a payment failed, the plan still counts while
 * Stripe retries); canceled (unpaid or paused: Free until paid); none (not
 * paid yet). `scheduled_*` is a change waiting for renewal; `pending_update`,
 * an upgrade waiting for its prorated invoice to be paid. `trial_end` is set
 * while a free month runs (a gift), and `gift_from` names who gave it. Times
 * are ISO 8601.
 */
export const CodeSubscription = Schema.Struct({
  plan: Schema.String,
  seats: Schema.Number,
  status: Schema.String,
  interval: optionalKey(Schema.String),
  current_period_end: optionalKey(Schema.String),
  cancel_at_period_end: Schema.Boolean,
  scheduled_plan: optionalKey(Schema.String),
  scheduled_interval: optionalKey(Schema.String),
  scheduled_seats: optionalKey(Schema.Number),
  pending_update: Schema.Boolean,
  trial_end: optionalKey(Schema.String),
  gift_from: optionalKey(Schema.String),
}).annotate({ identifier: "CodeSubscription" });

/**
 * One free month the organization's plan earned to give a friend (account.gifts).
 * `status`: open (ready), sent (emailed, not used yet), claimed (a friend is at
 * checkout right now), redeemed (a friend took it). `url` is the link to share.
 */
export const CodeGift = Schema.Struct({
  code: Schema.String,
  url: Schema.String,
  plan: Schema.String,
  plan_label: Schema.String,
  months: Schema.Number,
  status: Schema.Literals(["open", "sent", "claimed", "redeemed"]),
  sent_to: optionalKey(Schema.String),
  sent_at: optionalKey(Schema.String),
  redeemed_by: optionalKey(Schema.String),
  redeemed_at: optionalKey(Schema.String),
}).annotate({ identifier: "CodeGift" });
export type CodeGift = typeof CodeGift.Type;
export type CodeSubscription = typeof CodeSubscription.Type;

/**
 * One limit of a Code plan as people see it: how much of it is used, in whole
 * percent, and when it starts over. Never its size in dollars.
 */
export const CodeUsageWindow = Schema.Struct({
  window: Schema.String,
  used_pct: Schema.Number,
  resets_at: optionalKey(Schema.String),
}).annotate({ identifier: "CodeUsageWindow" });
export type CodeUsageWindow = typeof CodeUsageWindow.Type;

/**
 * Settings -> Account: the person's Caveman account through the sign-in
 * cloud.signin keeps in the runtime's secret store. `credits` is null when
 * this Caveman Cloud sells no Code plans. Plan usage is a percent and a reset,
 * never dollars; the money here is the person's own
 * (credits they bought, pay as you go), in list-price micro-dollars.
 */
export const AccountSummary = Schema.Struct({
  signed_in: Schema.Boolean,
  cloud_url: optionalKey(Schema.String),
  email: optionalKey(Schema.String),
  role: optionalKey(Schema.String),
  organization_name: optionalKey(Schema.String),
  credits: optionalKey(
    Schema.NullOr(
      Schema.Struct({
        plan: Schema.String,
        seats: Schema.Number,
        /** The plan's limits (`5h`, `week`, `month`): whole percent used, 100 only once the limit is reached, and when each starts over. */
        windows: Schema.Array(CodeUsageWindow),
        balance_micros: Schema.Number,
        grants: Schema.Array(Schema.Struct({ kind: Schema.String, amount_micros: Schema.Number, remaining_micros: Schema.Number, expires_at: optionalKey(Schema.String) })),
        use_balance: Schema.Boolean,
        /** The bound plan subscription; absent when none is bound (Free). */
        subscription: optionalKey(CodeSubscription),
        /** The organization has a Stripe customer, so account.billing can open its billing portal. */
        customer_linked: optionalKey(Schema.Boolean),
        /** Paid checkouts not yet turned into credits: owed until Caveman grants or refunds them. */
        fulfillment_pending: optionalKey(Schema.Number),
        /** Cloud computers against the plan: kept and awake memory now, the plan's limits, and the share of this month's plan their time took (absent on a plan with no usage of its own). */
        computers: optionalKey(
          Schema.Struct({
            kept: Schema.Number,
            kept_limit: Schema.Number,
            awake_gib: Schema.Number,
            awake_gib_limit: Schema.Number,
            max_size: Schema.String,
            used_pct: optionalKey(Schema.Number),
          }),
        ),
        /** Free months to give friends: `open` still to give (sent ones included), of `total` earned. Absent until a plan earns any. */
        gifts: optionalKey(Schema.Struct({ open: Schema.Number, total: Schema.Number })),
        /** Pay as you go: credits that top themselves up from a saved card under a monthly limit. Absent until first set. */
        auto_topup: optionalKey(CodeAutoTopup),
      }),
    ),
  ),
  /** The plans this Cloud sells; null when it lists none (an older Cloud, or no Code plans). */
  offer: optionalKey(Schema.NullOr(CodeOffer)),
  members: optionalKey(Schema.Array(Schema.Struct({ email: Schema.String, name: optionalKey(Schema.String), role: Schema.String, status: Schema.String }))),
  /** The Caveman engine holds a Caveman credits key (account.credits): its picker lists the plan's models. */
  credits_on: optionalKey(Schema.Boolean),
  /** Why the account could not be read (Cloud unreachable, the sign-in ended). */
  error: optionalKey(Schema.String),
}).annotate({ identifier: "AccountSummary" });
export type AccountSummary = typeof AccountSummary.Type;

/** cloud.profile.status: what syncs to Caveman Cloud, and where each item runs on a Cloud computer. */
export const CloudProfileStatus = Schema.Struct({
  state: Schema.Literals(["off", "pending", "ok", "error", "paused"]),
  /**
   * two_way: this Mac sends its skills and plugins and takes your other computers' (every computer shares one
   * profile); push_only: Caveman cannot take shared writes yet, so this Mac only sends.
   */
  mode: optionalKey(Schema.Literals(["two_way", "push_only"])),
  /** Where what a sync replaced or removed on this Mac is kept, 30 days. */
  trash: optionalKey(Schema.String),
  /** The last sync that brought another computer's changes here, and how many. */
  received_at: optionalKey(IsoDateTime),
  received: optionalKey(Schema.Number),
  synced_at: optionalKey(IsoDateTime),
  error: optionalKey(Schema.String),
  digest: optionalKey(Schema.String),
  /** Opted-in server keys that did not reach Cloud, and why (names Cloud cannot keep, a failed upload). */
  keys_error: optionalKey(Schema.String),
  /**
   * A Cloud computer only: its MCP servers run beside the agent's commands (no servers container), so commands
   * on that computer can read their keys. Absent: servers run under their own user (I1). This Mac never sets it.
   */
  server_keys_shared: optionalKey(Schema.Literal(true)),
  items: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["marketplace", "plugin", "server", "skill"]),
      id: Schema.String,
      cloud: Schema.Literals(["runs", "needs_runtime", "mac_only", "skipped"]),
      reason: optionalKey(Schema.String),
      /** A server: its keys are available on Cloud computers. */
      available: optionalKey(Schema.Boolean),
      /** A home skill on This Mac: its SKILL.md's real path (skill.list's), so same-named folders each have a line. */
      path: optionalKey(Schema.String),
    }),
  ),
}).annotate({ identifier: "CloudProfileStatus" });

/** One thing Caveman Cloud holds for you, by name. */
export const CloudHolding = Schema.Struct({
  kind: Schema.Literals(["profile", "repository_secrets", "server_keys", "connection"]),
  id: Schema.String,
  label: Schema.String,
  names: Strings,
  updated_at: optionalKey(IsoDateTime),
}).annotate({ identifier: "CloudHolding" });

/** One read of what Cloud holds for you: who, what (names), when. */
export const CloudAccess = Schema.Struct({
  at: IsoDateTime,
  action: Schema.String,
  names: Strings,
  /** secret, server_key, profile or connection. */
  kind: optionalKey(Schema.String),
  repository: optionalKey(Schema.String),
  /** computer or mac. */
  reader: optionalKey(Schema.String),
  computer_id: optionalKey(Schema.String),
  workspace_id: optionalKey(Schema.String),
  workspace_title: optionalKey(Schema.String),
  actor_type: optionalKey(Schema.String),
  actor_id: optionalKey(Schema.String),
}).annotate({ identifier: "CloudAccess" });

export const CloudStatus = Schema.Struct({
  state: Schema.Literals(["off", "not_enrolled", "connecting", "connected", "unauthorized", "replaced"]),
  cloud_url: optionalKey(Schema.String),
  runtime_id: optionalKey(Id),
  computer_id: optionalKey(Id),
  /** Who approved the sign-in that enrolled this computer (cloud.signin); absent after cloud.enroll. */
  account: optionalKey(CloudAccount),
  /** A sign-in in progress (cloud.signin). Only the runtime's owner is told: whoever approves its code enrolls the runtime. */
  signin: optionalKey(CloudSignin),
  /** Why the last sign-in ended without enrolling (expired, refused, Cloud unreachable). Cleared by the next one. */
  signin_error: optionalKey(Schema.String),
  /** This Mac is signed in, so its usage (tokens and cost, nothing else) goes to the Caveman account. */
  usage_reported: optionalKey(Schema.Boolean),
  /**
   * Moves (ADR 0126), on This Mac: `on`, the link runs for moving chats to Cloud (even with Remote control off) and
   * Caveman-engine chats copy to Cloud after each turn; `ask`, Cloud computers are offered and the person has not
   * answered the one-time notice yet, so nothing is copied. Absent: off.
   */
  moves: optionalKey(Schema.Literals(["ask", "on"])),
  /**
   * Sync (Caveman Cloud ADR 0135): `available`, this Cloud keeps a copy of the person's chats for their other devices;
   * `on`, this runtime's chats copy there now (always on a Cloud computer; on This Mac with Settings.sync_chats).
   * `ask`: This Mac, sync is on offer and the person has not answered the one-time notice (Settings.sync_chats unset):
   * a client shows it once in a chat. Absent while the runtime is not signed in to a Cloud.
   */
  sync: optionalKey(S({ available: Schema.Boolean, on: Schema.Boolean, ask: optionalKey(Schema.Boolean) })),
  /**
   * What this computer does that a client may offer: open and update pull requests, and compress engine traffic.
   * Absent from older runtimes.
   */
  capabilities: optionalKey(S({ pull_requests: Schema.Boolean, compression: Schema.Boolean })),
}).annotate({ identifier: "CloudStatus" });
export type CloudStatus = typeof CloudStatus.Type;

/** setup.scan: something the user already set up for Claude Code or Codex, or a repository instruction file. */
export const SetupItem = Schema.Struct({
  kind: Schema.Literals(["mcp_server", "skill", "instructions"]),
  name: Schema.String,
  /** claude: ~/.claude.json, the repo's .mcp.json, ~/.claude/skills. codex: ~/.codex/config.toml and skills. repo: AGENTS.md, CLAUDE.md. */
  source: Schema.Literals(["claude", "codex", "repo"]),
  /** An MCP server's command line or URL; a skill's folder or an instruction file's path. */
  detail: Schema.String,
  /** Environment variable names an MCP server expects; their values are never read. */
  env: optionalKey(Strings),
  /** Engines that load it by themselves today. */
  loaded_by: Schema.Array(EngineId),
}).annotate({ identifier: "SetupItem" });
export type SetupItem = typeof SetupItem.Type;

/** A Caveman Cloud computer of the signed-in person's organization (Cloud's /code/computers row). */
export const CloudComputerRow = Schema.Struct({
  id: Id,
  name: Schema.String,
  /** kubernetes: a Cloud computer Cloud runs; local: a person's own Mac with Remote control. */
  driver: Schema.String,
  size: Schema.String,
  desired_state: Schema.Literals(["running", "stopped", "suspended", "deleted"]),
  observed_state: Schema.Literals(["pending", "starting", "running", "stopping", "stopped", "suspended", "deleted", "failed"]),
  observed_reason: Schema.String,
  updated_at: Schema.String,
  /** "usage": asleep because nothing paid for its time (the plan's usage and credits ran out). */
  sleep_reason: optionalKey(Schema.String),
  /**
   * When Cloud last lost the disk it kept for this computer, and its own words for why: the chats on it continued
   * from the copies Cloud keeps (each says so once, where it came back). Absent on a computer that never lost one.
   */
  disk_lost_at: optionalKey(Schema.String),
  disk_lost_reason: optionalKey(Schema.String),
  /** Its runtime is older than this Cloud's minimum: it updates when it next wakes. Absent or false: it is not. */
  runtime_outdated: optionalKey(Schema.Boolean),
}).annotate({ identifier: "CloudComputerRow" });
export type CloudComputerRow = typeof CloudComputerRow.Type;

// ------------------------------------------------- Cloud environments (E2)
// A repo's Cloud setup: one per repository per organization, built and proven
// by Caveman Cloud.

/** One step of a Cloud build: clone, services, setup, check, snapshot, restore_check. */
export const EnvironmentBuildStep = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["pending", "running", "done", "failed", "skipped"]),
  seconds: optionalKey(Schema.Number),
}).annotate({ identifier: "EnvironmentBuildStep" });

export const EnvironmentFailureKind = Schema.Literals(["command", "timeout", "too_big", "registry_auth", "service", "check", "restore", "clone", "start", "secret_on_disk"]).annotate({
  identifier: "EnvironmentFailureKind",
});

export const EnvironmentBuild = Schema.Struct({
  id: Id,
  status: Schema.Literals(["queued", "running", "validating", "succeeded", "failed"]),
  steps: Schema.Array(EnvironmentBuildStep),
  /** The last 2000 characters of the log. */
  log_tail: Schema.String,
  failure: Schema.NullOr(Schema.Struct({ kind: EnvironmentFailureKind, step: Schema.String, message: Schema.String })),
  /** Checks that failed on a build that still became ready ("ready with gaps"). */
  gaps: Strings,
  started_at: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.String),
  /** Who started it from this runtime: the person (a save or Rebuild), Caveman in the background, or a setup chat. */
  by: optionalKey(Schema.Literals(["person", "background", "setup_chat"])),
}).annotate({ identifier: "EnvironmentBuild" });
export type EnvironmentBuild = typeof EnvironmentBuild.Type;

export const Environment = Schema.Struct({
  /** owner/name on GitHub. */
  repo: Schema.String,
  branch: Schema.String,
  state: Schema.Literals(["not_set_up", "setting_up", "ready", "ready_with_gaps", "failed"]),
  /** repo: the branch's .caveman/computer.toml; cloud: the organization's Cloud copy; none: neither. */
  source: Schema.Literals(["repo", "cloud", "none"]),
  config: Schema.NullOr(Schema.String),
  config_version: optionalKey(Count),
  /** A person's name, or "Caveman". */
  updated_by: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
  /** Values its computers read, by name. */
  secret_names: Strings,
  /** Shared values only setup and checks read, at build time (Settings, Environments), by name; never on a chat's computer. */
  build_secret_names: optionalKey(Strings),
  /** Computer sizes this install offers, and its largest. */
  sizes: Strings,
  max_size: Schema.String,
  /** The install's service allowlist: name -> versions. */
  services: Schema.Record(Schema.String, Strings),
  snapshot: Schema.NullOr(
    Schema.Struct({
      commit: Schema.String,
      built_at: Schema.String,
      checks: Schema.Array(Schema.Struct({ command: Schema.String, ok: Schema.Boolean, seconds: Schema.Number })),
    }),
  ),
  /** The latest build. */
  build: Schema.NullOr(EnvironmentBuild),
}).annotate({ identifier: "Environment" });
export type Environment = typeof Environment.Type;

export const EnvironmentEvidence = Schema.Struct({
  source: Schema.Literals(["repo", "ci", "devcontainer", "mac"]),
  note: Schema.String,
}).annotate({ identifier: "EnvironmentEvidence" });

/** A project's setup chat: a Caveman-engine chat that repairs its Cloud setup with test builds (environment.fix). */
export const SetupChat = Schema.Struct({
  workspace_id: Id,
  session_id: Id,
  /** review: a test build passed and its setup waits for the person to publish or discard it; succeeded: published. */
  state: Schema.Literals(["working", "review", "succeeded", "failed", "stopped"]),
  /** Test builds it ran (at most 5). */
  builds: Count,
  started_at: IsoDateTime,
  /** The setup its passing test build ran, for the person to publish (environment.publish) or discard. */
  proposal: optionalKey(S({ config: Schema.String, build_id: Id, summary: Schema.String })),
}).annotate({ identifier: "SetupChat" });
export type SetupChat = typeof SetupChat.Type;

/** A setup change an agent proposed mid-chat (propose_setup_change): Apply hands it to the setup chat as its ask. */
export const SetupProposal = Schema.Struct({
  id: Id,
  workspace_id: Id,
  summary: Schema.String,
  why: Schema.String,
  at: IsoDateTime,
}).annotate({ identifier: "SetupProposal" });
export type SetupProposal = typeof SetupProposal.Type;

/** One saved version of a repo's Cloud copy, newest first in environment.versions. */
export const EnvironmentVersion = Schema.Struct({
  version: Count,
  config: Schema.String,
  /** A person's name, or "Caveman". */
  updated_by: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
}).annotate({ identifier: "EnvironmentVersion" });
export type EnvironmentVersion = typeof EnvironmentVersion.Type;

/** One of the organization's environments in environment.list; `project_id` when a project here is that repo. */
export const EnvironmentSummary = Schema.Struct({
  repo: Schema.String,
  branch: Schema.String,
  state: Schema.Literals(["not_set_up", "setting_up", "ready", "ready_with_gaps", "failed"]),
  source: Schema.Literals(["repo", "cloud", "none"]),
  updated_by: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
  snapshot_built_at: Schema.NullOr(Schema.String),
  project_id: optionalKey(Id),
}).annotate({ identifier: "EnvironmentSummary" });
export type EnvironmentSummary = typeof EnvironmentSummary.Type;

/** CI on a commit, as GitHub reports it (environment.ci): whether a failing check is the repo's, not the setup's. */
export const EnvironmentCi = Schema.Struct({
  commit: Schema.String,
  state: Schema.Literals(["passing", "failing", "pending", "unknown"]),
  /** Names of the failing checks. */
  failing: Strings,
  url: optionalKey(Schema.String),
}).annotate({ identifier: "EnvironmentCi" });
export type EnvironmentCi = typeof EnvironmentCi.Type;

// ------------------------------------------------------------------ devices (DESIGN S13)

/** A device's P-256 public key, JWK (packages/session-protocol devices.ts). */
export const DevicePublicKeyJwk = S({ kty: Schema.Literal("EC"), crv: Schema.Literal("P-256"), x: Schema.String, y: Schema.String }).annotate({
  identifier: "DevicePublicKeyJwk",
});
/** What holds a device key: a Mac's desktop app (`mac`, which may allow devices for the person's other Macs) or anything else. */
export const DeviceRole = Schema.Literals(["mac", "device"]);
/** Another of the person's Macs, as this Mac knows its desktop key: who allowed or removed a device for it. */
export const DeviceSigner = S({ device_id: Id, name: Schema.String });
/**
 * A Mac's signed word about a device, for the person's other Macs (session-protocol devices.ts DeviceStatement): every
 * field is under `signature`, by `signer`'s key, and a Mac counts it only when it trusts that key as a Mac's.
 */
const SignedDeviceStatement = S({
  kind: Schema.Literals(["allow", "remove", "agents"]),
  organization_id: Id,
  user_id: Id,
  device_id: Id,
  public_key: optionalKey(DevicePublicKeyJwk),
  name: optionalKey(Schema.String),
  role: optionalKey(DeviceRole),
  signer: S({ device_id: Id, public_key: DevicePublicKeyJwk }),
  at: IsoDateTime,
  nonce: Schema.String,
  signature: Schema.String,
}).annotate({ identifier: "DeviceStatement" });
/** A device this Mac allowed to drive it: its id is its key's thumbprint; `code` is what both screens showed. */
export const DeviceEntry = S({
  device_id: Id,
  name: Schema.String,
  code: Schema.String,
  /** The Caveman Cloud person it drives this Mac as. */
  user_id: Id,
  added_at: IsoDateTime,
  last_seen_at: optionalKey(IsoDateTime),
  /** Connected through Caveman Cloud right now. */
  connected: Schema.Boolean,
  /** `mac`: one of the person's Macs, whose approvals this Mac takes too. Absent: a device. */
  role: optionalKey(DeviceRole),
  /** Allowed through another of the person's Macs (its signed approval), not on this Mac's screen. */
  allowed_by: optionalKey(DeviceSigner),
  /** Allowed on this Mac's screen and signed for the person's other Macs; absent or false: this Mac only. */
  shared: optionalKey(Schema.Boolean),
  /** Signed for the person's other Macs, but Caveman Cloud would not carry it (why, as Cloud said): this Mac only. */
  not_shared: optionalKey(Schema.String),
  /** Signed for the person's other Macs and not sent yet: it waits on this Mac until Caveman Cloud takes it (m-j). */
  waiting: optionalKey(Schema.Boolean),
}).annotate({ identifier: "DeviceEntry" });
export type DeviceEntry = typeof DeviceEntry.Type;
/** A device waiting for this Mac's answer ("Allow?"); it lapses after 10 minutes. */
export const DeviceRequest = S({
  device_id: Id,
  name: Schema.String,
  code: Schema.String,
  user_id: Id,
  at: IsoDateTime,
  /** Its key and kind, as its hello signed them: what an Allow signed for the person's other Macs names. */
  public_key: optionalKey(DevicePublicKeyJwk),
  /** "mac" only for a Mac's desktop app that joined with the code this Mac's screen showed (device.pair.start); else a device. */
  role: optionalKey(DeviceRole),
}).annotate({ identifier: "DeviceRequest" });
export type DeviceRequest = typeof DeviceRequest.Type;
export const DeviceList = S({
  /** False on a Cloud computer: devices drive it on the person's Cloud sign-in alone. */
  required: Schema.Boolean,
  devices: Schema.Array(DeviceEntry),
  requests: Schema.Array(DeviceRequest),
  /**
   * Devices this Mac said no to, or removed, or another of the person's Macs removed (`removed_by`): they are refused
   * without asking until unblocked here (device.remove), which counts on this Mac only.
   */
  blocked: Schema.Array(
    S({
      device_id: Id,
      name: Schema.String,
      code: Schema.String,
      at: IsoDateTime,
      removed_by: optionalKey(DeviceSigner),
      /** Removed on this screen and signed, but Caveman Cloud would not carry the removal (why): this Mac only. */
      not_shared: optionalKey(Schema.String),
      /** Removed on this screen and signed, and not sent yet: the person's other Macs do not have the removal until Caveman Cloud takes it (m-j). */
      waiting: optionalKey(Schema.Boolean),
    }),
  ),
  /**
   * The person whose Macs share approvals with this one (what a statement this Mac's screen signs names). Absent: this
   * Mac shares none (no Caveman Cloud sign-in that names its person).
   */
  family: optionalKey(S({ organization_id: Id, user_id: Id })),
  /** This Mac's pairing code is live (device.pair.start) until then: the first hello that tries it uses it up. Never the code. */
  pairing: optionalKey(S({ expires_at: IsoDateTime })),
}).annotate({ identifier: "DeviceList" });
export type DeviceList = typeof DeviceList.Type;
export const DeviceStatus = Schema.Literals(["approved", "pending", "refused"]);
export type DeviceStatus = typeof DeviceStatus.Type;

// ---------------------------------------------------------------- versions (README: Versioning; constants in revision.ts)

/** runtime.hello's answer: which build the runtime is, the revision it speaks, the oldest client it serves, its features. */
export const RuntimeHello = S({
  /** The runtime's build (the desktop app's version, the npm package's, or the Cloud computer image's). */
  version: Schema.String,
  protocol_revision: Count,
  min_client_revision: Count,
  /** Features to gate on, never on `version`. Open: a client ignores names it does not know. */
  capabilities: Strings,
}).annotate({ identifier: "RuntimeHello" });
export type RuntimeHello = typeof RuntimeHello.Type;

/**
 * One finished turn as anonymous telemetry counts it (telemetry.turns). Content-free by construction: every string is from a closed list or token-shaped, ids are salted hashes
 * that never match a real session or turn id, and the prompt is only a length rounded down to a power of two.
 */
export const TurnFact = Schema.Struct({
  /** Its place in this runtime's outbox: telemetry.turns' `ack` names the highest one delivered. Never sent on. */
  seq: Count,
  id: Schema.String,
  session: Schema.String,
  started_at: IsoDateTime,
  index: Count,
  engine: Schema.String,
  engine_version: optionalKey(Schema.String),
  model: Schema.String,
  routed_model: optionalKey(Schema.String),
  effort: optionalKey(Schema.String),
  speed: optionalKey(Schema.String),
  access: optionalKey(AccessMode),
  mode: SessionMode,
  billing: optionalKey(Schema.Literals(["api_key", "plan"])),
  origin: Schema.Literals(["person", "automation", "chief", "setup", "builder", "delegated", "outside_agent", "scheduled", "agent"]),
  pick: optionalKey(Schema.Literals(["lead", "user", "auto", "default"])),
  queued: Schema.Boolean,
  prompt_chars: Count,
  images: Count,
  files: Count,
  context_tokens: optionalKey(Count),
  context_window: optionalKey(Count),
  status: Schema.Literals(["completed", "failed", "interrupted"]),
  moved: Schema.Boolean,
  failure_class: optionalKey(EngineFailure.fields.class),
  failure_code: optionalKey(Schema.String),
  retries: Count,
  rate_limited: Schema.Boolean,
  duration_ms: Count,
  ttft_ms: optionalKey(Count),
  wait_ms: Count,
  tool_ms: Count,
  requests: Count,
  input_tokens: Count,
  output_tokens: Count,
  cache_read_tokens: Count,
  cache_write_tokens: Count,
  web_searches: Count,
  context_end_tokens: optionalKey(Count),
  compactions: Count,
  compactions_failed: Count,
  tools: Count,
  tools_failed: Count,
  tools_declined: Count,
  tool_command: Count,
  tool_read: Count,
  tool_edit: Count,
  tool_search: Count,
  tool_web: Count,
  tool_mcp: Count,
  tool_browser: Count,
  tool_other: Count,
  subagents: Count,
  subagents_failed: Count,
  approvals: Count,
  approvals_denied: Count,
  questions: Count,
  steers: Count,
  todos: Count,
  todos_done: Count,
  files_changed: Count,
  lines_added: Count,
  lines_removed: Count,
  next: Schema.Literals(["followup", "none"]),
  next_gap_ms: optionalKey(Count),
  next_switch: optionalKey(Schema.Literals(["engine", "model", "effort", "speed"])),
  next_same_prompt: Schema.Boolean,
  undone: Schema.Boolean,
  kept: Schema.Boolean,
  restored: Schema.Boolean,
}).annotate({ identifier: "TurnFact" });
export type TurnFact = typeof TurnFact.Type;

/**
 * Every method: params and result schemas. A method is mutating (changes
 * state that outlives the connection) exactly when its params carry
 * `request_id`. session.attach/detach and browser.screencast only change
 * what this connection receives; the rest are reads.
 */
export const Methods = {
  /**
   * The client's first call on every connection (the client in client.ts sends it): which build and revision it is.
   * The answer says which the runtime is and the oldest client revision it serves. A runtime from before it answers
   * -32601, which a client reads as LEGACY_RUNTIME.
   */
  "runtime.hello": m({ client_version: Schema.String, protocol_revision: Count }, RuntimeHello),
  "workspace.create": m(
    {
      ...req,
      repo: Repo,
      base_ref: optionalKey(GitRef),
      branch: optionalKey(GitRef),
      title: optionalKey(Schema.String),
      engine: optionalKey(EngineId),
      computer_id: optionalKey(Id),
      /** When present, submitted as the first turn. */
      task: optionalKey(TurnInput),
      options: optionalKey(TurnOptions),
      /**
       * Start on the pin (Settings.subagent_task_pins) for the kind the task classifier reads `task` as, in place of
       * `engine` and `options`' model, effort and account. Without a pin for that kind, or one that can't run now, the
       * chat starts as `engine` and `options` say.
       */
      by_task: optionalKey(Schema.Boolean),
      /**
       * Start on this pull request of `repo`: its head checked out from the host into the chat's worktree, on the head
       * branch, so the agent's pushes land on the pull request. `branch` and `base_ref` are ignored. `repo` here: the
       * owner/name the pull request is in, when known; a checkout of another repository refuses it, since the number
       * there names another pull request.
       */
      pull_request: optionalKey(S({ number: Count, repo: optionalKey(Schema.String) })),
      /**
       * On a Cloud computer: the workspace Caveman Cloud placed for this chat (the id its `POST workspaces`
       * answered), which the chat's registration with Cloud takes up, and no other; "" when the client knows Cloud
       * placed none for it (a further run of one start). Absent: not said (an older client, a chat started on the
       * computer directly), and Cloud matches it as before. Ignored on This Mac.
       */
      placed_workspace_id: optionalKey(Schema.String.check(Schema.isMaxLength(64))),
      /**
       * The sources of `repo`'s project this chat works in, each by its name (ProjectSource.name) or by its
       * repository (owner/name, any case; how a chat started on another computer names them); `repo`'s own is always
       * one of them and is the chat's primary. With two or more, the chat gets one folder holding a worktree per source
       * on a branch of the same name (Workspace.source, Workspace.checkouts), and its engine works in that folder.
       * Absent, or naming only `repo`'s own: a chat in `repo` alone, exactly as before sources. A name the project
       * does not have is invalid_params. Not with `pull_request`.
       */
      sources: optionalKey(Schema.Array(Schema.String)),
      /**
       * The project the chat belongs to, when `repo` is one of that project's other sources rather than its own
       * repository (a chat that leaves the project's own repository out). `repo` may be the `url` of a source with no
       * checkout here: its clone is that source. Absent: `repo`'s own project.
       */
      project_id: optionalKey(Id),
    },
    Workspace,
  ),
  /**
   * Adds one of the project's sources to a chat, while it runs: its worktree is made on the chat's branch name and the
   * agent is told with the chat's next message. A chat that already works in several gets it beside the others at
   * once, a turn running or not. A chat in one source becomes a chat in several (Workspace.source and checkouts): its
   * folder stays where it is and now holds both worktrees, so its engine is restarted in it; refused (invalid_state)
   * while a turn runs. On a Cloud computer the source must already be one of the workspace's checkouts in Caveman
   * Cloud (a person adds it there; a computer cannot widen its own reach). A source it already works in answers the
   * workspace as it is.
   */
  "workspace.add_source": m({ ...req, ...ws, source: Schema.NonEmptyString }, Workspace),
  "workspace.list": m(
    {
      include_archived: optionalKey(Schema.Boolean),
      parent_workspace_id: optionalKey(Id),
      /** Also the Chief's own workspace (kind chief); left out by default. */
      include_chief: optionalKey(Schema.Boolean),
    },
    S({ workspaces: Schema.Array(Workspace) }),
  ),
  /**
   * The New chat page: makes a chat's worktree in this repository ahead, so the workspace.create that follows
   * runs no git worktree add. Answers at once; one per repository, gone after ten minutes unused. Never listed.
   * With the engine and options the page has picked (as workspace.create would take them; call again when they
   * change), an engine that can (Claude Agent) also starts for that chat's first turn, so Send skips its start-up.
   * That engine stops a minute after the last call (the worktree stays): the page calls again while it is in use.
   */
  "workspace.prewarm": m({ ...req, repo: Repo, engine: optionalKey(EngineId), options: optionalKey(TurnOptions) }, S({})),
  "workspace.get": m(ws, Workspace),
  /** The chat's title, here and on its engine thread (an agent's own rename reaches it too). */
  "workspace.rename": m({ ...req, ...ws, title: Schema.NonEmptyString }, Workspace),
  /**
   * The person's topic for the chat (Workspace.topic), on its engine thread too: into a group, out of every group
   * (null), or a group renamed (each of its chats). No title writer changes it after. `icon` is the topic's emoji
   * (Workspace.topic_icon): the group's own when a chat joins one or the group is renamed, a new one when the person
   * picks another (each of its chats), null for none. Left out, the chat keeps its emoji while its topic's name stays
   * the same, and has none under a new name.
   */
  "workspace.topic": m({ ...req, ...ws, topic: Schema.NullOr(TopicName), icon: optionalKey(Schema.NullOr(TopicIcon)) }, Workspace),
  "workspace.archive": m({ ...req, ...ws }, Workspace),
  /**
   * Done, reopen, snooze, wake, pin, unpin, seen or unread (InboxAction); the workspace as it stands after. Not the
   * Chief's. An archived chat takes only seen and unread (invalid_state otherwise) until workspace.restore.
   */
  "workspace.inbox": m({ ...req, ...ws, action: InboxAction }, Workspace),
  /**
   * Brings an archived workspace back: a fresh worktree from its branch, the same session. A done chat comes back off
   * the Done shelf, unless `keep_done` (an Undo of archiving it): then its done mark stays as it was, so the
   * runtime's auto-archive takes it again when it would have. A delegated agent comes back into the checkout it worked
   * in: its lead's (restored first; invalid_state while the lead is archived) or its own.
   */
  "workspace.restore": m({ ...req, ...ws, keep_done: optionalKey(Schema.Boolean) }, Workspace),
  /** A chat in one answer: state, task, latest answer, what it waits on, latest turn's files (WorkspaceDigest). */
  "workspace.digest": m(
    {
      ...ws,
      /** Also a page of the transcript (WorkspaceDigest.transcript): `max_bytes` defaults to 24 KiB, at most 64 KiB. */
      transcript: optionalKey(S({ before: optionalKey(Cursor), max_bytes: optionalKey(Count) })),
    },
    WorkspaceDigest,
  ),

  /**
   * Outside agents. `become`: the first call of `caveman-code mcp` on
   * an owner connection, which from then on is that agent's, for good (principal `agent:<agent_id>`), with the level
   * the person gave its name, lowered to `at_most`. Owner connections only, once each; refused for a blocked name.
   */
  "outside_agent.become": m(
    {
      agent_id: Id.check(Schema.isMaxLength(64)),
      name: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
      at_most: optionalKey(OutsideAgentLevel),
    },
    S({ name: Schema.String, level: OutsideAgentLevel }),
  ),
  /** Settings > Caveman MCP: every agent that has connected, the command that connects one, and the clients. Owner only. */
  "outside_agent.list": m({}, OutsideAgentList),
  /**
   * Adds the `caveman-code` server to a client's own config (its CLI, or its config file written in place), the
   * command outside_agent.list says; again replaces it. Answers the client's status after; `unavailable` with the
   * reason it couldn't (not on this computer, its CLI failed, a config it won't rewrite). Owner only.
   */
  "outside_agent.install": m({ ...req, client: McpClientId }, McpClientStatus),
  /** Sets an agent's level, or disconnects it (`blocked`: its connections close) and allows it again. Owner only. */
  "outside_agent.update": m(
    { ...req, name: Schema.String, level: optionalKey(OutsideAgentLevel), blocked: optionalKey(Schema.Boolean) },
    OutsideAgent,
  ),

  /**
   * batch: the backlog comes as session.events notifications, many events a frame; live events stay session.event.
   * A runtime from before it ignores the key and sends session.event only.
   */
  /**
   * `epoch`: the journal epoch the client's events are from (Workspace.epoch); absent when it holds none. The answer's
   * `reset` is true when that epoch is not the journal's, or `cursor` is past its head: the client drops every event it
   * holds for the session, and the backlog replays from cursor 0 of the answer's `epoch`. A live attachment whose journal
   * gets a new epoch ends with session.ended (journal_reset). A runtime from before 2026-10-21 answers neither key.
   */
  "session.attach": m(
    { ...ses, cursor: Cursor, batch: optionalKey(Schema.Boolean), epoch: optionalKey(Count) },
    S({ session: Session, epoch: optionalKey(Count), reset: optionalKey(Schema.Boolean) }),
  ),
  "session.detach": m(ses, Empty),
  /** A new workspace continuing from the turn.done at `at`; absent, from the latest finished turn. */
  "session.fork": m({ ...req, ...ses, at: optionalKey(Cursor) }, S({ workspace: Workspace, session: Session })),
  "session.park": m({ ...req, ...ses }, Session),
  "session.resume": m({ ...req, ...ses }, Session),

  /**
   * A chat whose engine is not running (the app restarted, or the chat idled out): its engine starts for the next
   * turn, on these options as turn.submit would take them, so Send skips its start-up. Fire-and-forget; answers at
   * once and does nothing when the engine is live, a turn is running, or the engine cannot start ahead.
   */
  "turn.prewarm": m({ ...req, ...ses, options: optionalKey(TurnOptions) }, S({})),
  "turn.submit": m(
    { ...req, ...ses, kind: TurnKind, input: TurnInput, options: optionalKey(TurnOptions) },
    S({ turn_id: Id, disposition: Schema.Literals(["started", "steered", "queued"]) }),
  ),
  "turn.interrupt": m({ ...req, ...ses }, S({ turn_id: optionalKey(Id) })),
  /** Inputs waiting behind the running turn, next first. */
  "queue.list": m(ses, S({ turns: Schema.Array(QueuedTurn) })),
  "queue.edit": m({ ...req, ...ses, turn_id: Id, text: Schema.String }, QueuedTurn),
  "queue.remove": m({ ...req, ...ses, turn_id: Id }, Empty),
  /** Runs the inputs Stop held, next first. */
  "queue.resume": m({ ...req, ...ses }, Empty),
  /** Moves a queued input before another one; `before_turn_id: null` moves it to the back. */
  "queue.reorder": m(
    { ...req, ...ses, turn_id: Id, before_turn_id: Schema.NullOr(Id) },
    S({ turns: Schema.Array(QueuedTurn) }),
  ),
  /**
   * Files and transcript back to the turn.done at `at` (its checkpoint). What
   * came after is kept as a branch: a workspace forked at the latest turn
   * with the files as they were. Engines without `restore` answer unsupported.
   */
  "session.restore": m({ ...req, ...ses, at: Cursor }, S({ session: Session, branch: optionalKey(Workspace) })),
  /**
   * The Changes card's Keep: the turn that ended at `checkpoint_id` keeps its changes and its card closes on every
   * client (checkpoint.resolved "kept"). The files are not touched.
   */
  "checkpoint.keep": m({ ...req, ...ses, checkpoint_id: Id }, Empty),
  /**
   * The Changes card's Undo: the files the latest finished turn changed go back to how they were before it, and
   * nothing else does (the transcript stays; session.restore is the rewind). Refused (invalid_state, nothing
   * written) while a turn runs, once a later turn finished, when a file changed again after the turn, and when
   * another chat worked in the same checkout during the turn. `files`: what went back (checkpoint.resolved "undone").
   */
  "checkpoint.undo": m({ ...req, ...ses, checkpoint_id: Id }, S({ files: Schema.Array(WorkspacePath) })),
  /** Sets (or with null clears) the session goal the engine keeps pursuing. */
  "goal.set": m(
    { ...req, ...ses, objective: Schema.NullOr(Schema.String) },
    S({ objective: Schema.NullOr(Schema.String), native: Schema.Boolean }),
  ),
  "ask.respond": m({ ...req, ...ses, ask_id: Id, response: AskResponse }, Empty),

  /**
   * What changed, each file with its patch. Without `from` and `to`: the working tree, untracked files included,
   * against the workspace's base (the Changes tab's All changes). `to` a finished turn's checkpoint, with no `from` or
   * with the checkpoint taken as that turn began: that turn alone (Latest turn / Turn N), from the checkpoint taken as it
   * began, files a pull, rebase or merge in it brought in left out, as its checkpoint.created `files` (its Changes card)
   * leaves them out. Otherwise `from` (default: the base) to `to` (default: the working tree). `from` in the answer:
   * where the range began.
   */
  "fs.diff": m(
    {
      ...ws,
      from: optionalKey(RefOrCheckpoint),
      to: optionalKey(RefOrCheckpoint),
      paths: optionalKey(Schema.Array(WorkspacePath)),
    },
    S({
      from: Schema.String,
      to: Schema.String,
      files: Schema.Array(S({ ...FileChange.fields, patch: Schema.String })),
    }),
  ),
  /**
   * One directory of the workspace for the Files tree. Respects .gitignore
   * unless include_ignored. Entries sorted directories first, then by name.
   */
  "fs.list": m(
    {
      ...ws,
      path: Schema.String,
      ref: optionalKey(Schema.String),
      include_ignored: optionalKey(Schema.Boolean),
    },
    S({
      path: Schema.String,
      entries: Schema.Array(
        S({
          name: Schema.String,
          path: Schema.String,
          type: Schema.Literals(["file", "dir", "symlink"]),
          size: optionalKey(Count),
          ignored: optionalKey(Schema.Boolean),
        }),
      ),
      truncated: Schema.Boolean,
    }),
  ),
  /**
   * Finds the chats where something was said or done, archived ones and the Chief's included (⌘K). Every
   * message, answer, plan, question, subagent summary, tool call and title is indexed as its own passage, so a
   * chat that was mostly about something else is still found at the one place it matters. The query is read
   * as a question (filler words dropped, rare words weigh most, typos corrected) and matched by words and, on
   * an on-device model, by meaning. Best first, each chat with its best places and what matched in them.
   */
  "chat.search": m({ query: Schema.String.check(Schema.isMaxLength(500)), limit: optionalKey(Count) }, ChatSearchResult),
  /**
   * Asks a fast, cheap model which chat the person means (⌘K's Ask): chat.search's best chats and the most
   * recent ones, a title, where and when, and the places that matched each, go to the first model the review
   * guides would use (a subscription before a key, the cheapest first), and it answers with the chats it
   * picks and why. One call of a few thousand tokens in and a few dozen out; only when the person asks.
   */
  "chat.find": m({ query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)) }, ChatFindResult),
  /**
   * Fuzzy path search over tracked and untracked, non-ignored files: "Search files" and quick open.
   * With include_directories, also ranks non-ignored directories (including empty ones) together with files
   * before applying the limit. Directory paths end in "/"; omitted or false keeps results file-only.
   * Project hidden paths and .cavemanignore apply to both kinds.
   */
  "fs.search": m(
    { ...ws, query: Schema.String, limit: optionalKey(Count), include_directories: optionalKey(Schema.Boolean) },
    S({ paths: Strings, truncated: Schema.Boolean }),
  ),
  /** Render a local HTML document, including an explicit absolute/~/ path outside the worktree.
   * Relative paths remain workspace-contained; HTML only, UTF-8, at most 16 MB.
   * Clients must render in an opaque-origin sandbox, never in the app origin. */
  "browser.readFile": m(
    { ...ws, path: Schema.String },
    S({ path: Schema.String, html: Schema.String }),
  ),
  /**
   * A page an agent showed in this chat with `html_render`, by the attachment id in the tool's result
   * (`htmlRender.attachmentId`): the stored document, its theme bootstrap included. Only this chat's own pages
   * and those of the chats it was forked from; any other id answers `not_found`. Clients must render it in an
   * opaque-origin sandbox, never in the app origin.
   */
  "htmlRender.read": m({ ...ws, attachment_id: Schema.String.check(Schema.isMaxLength(256)) }, S({ html: Schema.String })),
  /**
   * An image attached in this chat (or a chat it was forked from) that message.done names by `id` instead of
   * carrying its bytes (over 1 MB). Known by its bytes, up to 16 MB; any other id answers `not_found`.
   */
  "attachment.read": m(
    { ...ws, attachment_id: Schema.String.check(Schema.isMaxLength(256)) },
    S({ mime_type: Schema.String, /** Base64. */ data: Schema.String, size: Count }),
  ),
  "fs.read": m(
    {
      ...ws,
      path: WorkspacePath,
      ref: optionalKey(RefOrCheckpoint),
      /** Read up to this many bytes. Default 1 MB; the runtime clamps it to 16 MB. */
      max_bytes: optionalKey(Count),
      /**
       * Start at this byte (default 0): a large file's next window. A text window ends on a whole character, so
       * the next one starts at `offset` plus the UTF-8 length of `content`. `size` stays the whole file's.
       */
      offset: optionalKey(Count),
    },
    S({
      path: Schema.String,
      /** Sniffed from the extension and content, e.g. image/png; absent when unknown. */
      mime_type: optionalKey(Schema.String),
      encoding: Schema.Literals(["utf8", "base64"]),
      content: Schema.String,
      size: Count,
      truncated: Schema.Boolean,
    }),
  ),
  /**
   * An image a chat shows: most often the screenshot an agent saved as proof
   * of UI work and put in its reply as `![alt](/abs/shot.png)`. The one read
   * that takes a host path: absolute, `~/…`, or relative to the worktree.
   * Image files, recognized by their bytes (PNG, JPEG, GIF, WebP, AVIF, BMP,
   * ICO; SVG by its `.svg` name and `<svg` text), markdown outside the
   * chat's folder (`.md`, `.mdx`, `.markdown` real path, UTF-8 text, as
   * `text/markdown`), and audio and video an answer plays (MP3, WAV, AIFF,
   * Ogg, FLAC, MP4, QuickTime, WebM; by their bytes), up to 16 MB. Anything
   * else answers `invalid_params`, a missing file `not_found`.
   */
  "media.read": m(
    { ...ws, path: Schema.String },
    S({
      /** The file read: absolute, symlinks resolved. */
      path: Schema.String,
      mime_type: Schema.String,
      /** Base64. */
      data: Schema.String,
      size: Count,
    }),
  ),
  /**
   * Replace a file's content (a document's checkbox, ticked in the reader). `if_match` is the
   * sha256 (hex) of the content the client read; a file that changed since fails with
   * invalid_state, so the write never clobbers an agent's edit.
   */
  "fs.write": m(
    { ...req, ...ws, path: WorkspacePath, content: Schema.String, if_match: optionalKey(Schema.String) },
    S({ path: Schema.String, size: Count }),
  ),
  /** The editors installed on the runtime's computer (T3's discovery), and whether it can reveal a file in its file manager. */
  "editor.list": m(
    {},
    S({ editors: Schema.Array(S({ id: Schema.String, label: Schema.String })), reveal: Schema.Boolean }),
  ),
  /** Open a workspace file in an editor on the runtime's computer, at a line; `reveal` selects it in the file manager instead. */
  "editor.open": m(
    { ...req, ...ws, path: WorkspacePath, line: optionalKey(Count), editor: optionalKey(Schema.String), reveal: optionalKey(Schema.Boolean) },
    Empty,
  ),

  /**
   * A chat in several sources (Workspace.checkouts): the top-level fields are its primary source's, `files` lists
   * every source's with paths that start with the source's name, and `sources` says each one's branch state, the
   * primary first. `sources` is absent for a chat in one source.
   */
  "git.status": m(
    ws,
    S({
      branch: Schema.String,
      base_ref: Schema.String,
      upstream: optionalKey(Schema.String),
      ahead: Count,
      behind: Count,
      files: Schema.Array(FileChange),
      pull_request: optionalKey(PullRequest),
      sources: optionalKey(
        Schema.Array(
          S({
            name: Schema.String,
            branch: Schema.String,
            base_ref: Schema.String,
            upstream: optionalKey(Schema.String),
            ahead: Count,
            behind: Count,
            /** How many of `files` are this source's. */
            files: Count,
            pull_request: optionalKey(PullRequest),
          }),
        ),
      ),
    }),
  ),
  /**
   * A chat in several sources: one commit with this message in each source that has something to commit (`paths`
   * start with their source's name), all made or none: a source that refuses its commit takes the others' back.
   * `sha` is the primary's, else the first made; `commits` lists each. `commits` is absent for a chat in one source.
   */
  "git.commit": m(
    { ...req, ...ws, message: Schema.String, paths: optionalKey(Schema.Array(WorkspacePath)) },
    S({ sha: Schema.String, commits: optionalKey(Schema.Array(S({ source: Schema.String, sha: Schema.String }))) }),
  ),
  /**
   * A chat in several sources: every source whose branch holds commits its base does not is pushed; `branch` and
   * `sha` are the primary's, else the first pushed; `pushed` lists each. `pushed` is absent for a chat in one source.
   */
  "git.push": m(
    { ...req, ...ws },
    S({ branch: Schema.String, sha: Schema.String, pushed: optionalKey(Schema.Array(S({ source: Schema.String, branch: Schema.String, sha: Schema.String }))) }),
  ),
  /**
   * A chat in several sources: one pull request per source the chat changed (commits its base does not have), opened
   * together, each one's description naming the others. The answer is the primary's, else the first opened;
   * `pull_requests` lists each. `pull_requests` is absent for a chat in one source.
   */
  "git.pr": m(
    { ...req, ...ws, title: Schema.String, body: optionalKey(Schema.String) },
    S({ ...PullRequest.fields, pull_requests: optionalKey(Schema.Array(S({ source: Schema.String, ...PullRequest.fields }))) }),
  ),

  /** With `command`, the terminal runs that command in the person's shell and ends when it does (term.exit carries its code); without, an interactive shell. */
  /**
   * The Review queue: pull requests across this computer's projects (or one), newest update first. A project whose
   * host can't be read lands in `errors`; `unavailable` says why none could (the host's CLI missing or signed out).
   */
  "pr.list": m(
    { project_id: optionalKey(Id), state: optionalKey(Schema.Literals(["open", "closed", "merged", "all"])), query: optionalKey(Schema.String) },
    S({
      prs: Schema.Array(PrSummary),
      /** The signed-in login per host. */
      viewers: Schema.Record(Schema.String, Schema.String),
      errors: Schema.Array(S({ project_id: Id, message: Schema.String })),
      unavailable: optionalKey(Schema.String),
    }),
  ),
  "pr.get": m(PrRef, PrDetail),
  /**
   * Patches of the changed files (or of `paths`); a file too large for the host to send is in `omitted`. `revision`,
   * from a host that can read an earlier push again, names the one these patches were read at: pass it to pr.file.
   * `head_sha` is the head commit they were read at, only from a host that can vouch for it; absent otherwise, never
   * the head a separate read found.
   */
  "pr.diff": m(
    { ...PrRef, paths: optionalKey(Schema.Array(Schema.String)) },
    S({
      head_sha: optionalKey(Schema.String),
      revision: optionalKey(Schema.String),
      files: Schema.Array(S({ ...FileChange.fields, patch: Schema.String })),
      omitted: Schema.Array(Schema.String),
    }),
  ),
  /** Comments, reviews and line threads, oldest first. */
  "pr.discussion": m(PrRef, S({ items: Schema.Array(PrDiscussionItem) })),
  /**
   * The stored guide and any run writing one. `generate` starts a run for the current head (joining one already going);
   * reading never spends a model run.
   */
  "pr.guide": m(
    {
      ...PrRef,
      generate: optionalKey(Schema.Boolean),
      /** With `generate`: the full tour even for a short change (settings `review_short_lines`). */
      full: optionalKey(Schema.Boolean),
    },
    PrGuideResult,
  ),
  /**
   * Post the guide for the current head as one comment on the pull request, or rewrite the one this person posted
   * (settings `review_post` does it for pull requests a chat here opens). From then on a rewritten guide edits it.
   */
  "pr.post_guide": m({ ...req, ...PrRef }, PrGuideResult),
  /** A top-level comment; with `path`+`line` a comment on that line (`side` default new); with `thread_id` a reply. */
  "pr.comment": m(
    { ...req, ...PrRef, body: Schema.String, path: optionalKey(Schema.String), line: optionalKey(Count), side: optionalKey(Schema.Literals(["new", "old"])), thread_id: optionalKey(Id) },
    Empty,
  ),
  "pr.resolve": m({ ...req, ...PrRef, thread_id: Id, resolved: Schema.Boolean }, Empty),
  "pr.review": m({ ...req, ...PrRef, verdict: Schema.Literals(["approve", "request_changes", "comment"]), body: optionalKey(Schema.String) }, Empty),
  "pr.merge": m({ ...req, ...PrRef, method: Schema.Literals(["squash", "merge", "rebase"]) }, Empty),
  /**
   * Run its failed CI again (GitHub): the failed jobs of each failed Actions run on its head. `update_branch` instead
   * brings its base's new commits in (the host's update-branch), which starts CI afresh: what a pull request whose
   * failures came from a base since fixed needs, since a re-run replays the same merge commit. `rerun` counts the runs
   * started again. Nothing failed to re-run (or only checks outside Actions) answers invalid_state.
   */
  "pr.rerun": m({ ...req, ...PrRef, update_branch: optionalKey(Schema.Boolean) }, S({ rerun: Count, updated: Schema.Boolean })),
  /** Mark a draft ready for review. Never the other way from here: a draft is the author's call on the host. */
  "pr.ready": m({ ...req, ...PrRef }, Empty),
  "pr.viewed": m({ ...req, ...PrRef, paths: Schema.Array(Schema.String), viewed: Schema.Boolean }, Empty),
  /**
   * One file the pull request changes, whole, before and after: the lines its patch leaves out, for Files' "Show N
   * lines". Only a path pr.diff names (`old_path` for a rename); anything else answers not_found. An added file's
   * `old` and a deleted one's `new` are empty. `revision` is the pr.diff's, so the file matches its patch after a
   * push; without it the file is read as the pull request is now.
   */
  "pr.file": m(
    {
      ...PrRef,
      path: Schema.String,
      old_path: optionalKey(Schema.String),
      status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
      revision: optionalKey(Schema.String),
    },
    S({ old: Schema.String, new: Schema.String }),
  ),
  /**
   * Every line naming `name` as a whole word (case-sensitive), for Files' code navigation: `git grep` in this
   * computer's checkout of the project, at the pull request's head when that commit is here, else at its base branch;
   * never a fetch. `at` says which, `commit` is the commit searched. At most `limit` lines (default 200, at most 1000).
   * A pull request in a repository no project here is a checkout of answers unsupported.
   */
  "pr.symbol": m(
    { ...PrRef, name: Schema.String.check(Schema.isPattern(/^[A-Za-z_$][\w$]{0,199}$/)), limit: optionalKey(Count) },
    S({
      at: Schema.Literals(["head", "base"]),
      commit: Schema.String,
      hits: Schema.Array(S({ path: Schema.String, line: Count, text: Schema.String })),
      truncated: Schema.Boolean,
    }),
  ),

  "term.open": m(
    {
      ...req,
      ...ws,
      cols: Count,
      rows: Count,
      command: optionalKey(Schema.String),
      cwd: optionalKey(WorkspacePath),
    },
    S({ terminal_id: Id }),
  ),
  "term.write": m({ ...req, terminal_id: Id, data: Schema.String }, Empty),
  "term.resize": m({ ...req, terminal_id: Id, cols: Count, rows: Count }, Empty),
  "term.close": m({ ...req, terminal_id: Id }, Empty),
  /**
   * Terminals outlive clients: leaving a workspace never stops its dev
   * server. term.list shows a workspace's terminals; term.attach subscribes
   * this connection to one (term.output then flows) and returns its recent
   * scrollback; term.detach stops the flow without stopping the process.
   * Only term.close ends it.
   */
  "term.list": m(
    ws,
    S({
      terminals: Schema.Array(
        S({
          terminal_id: Id,
          title: Schema.String,
          command: optionalKey(Schema.String),
          cwd: Schema.String,
          created_at: IsoDateTime,
          exited: Schema.Boolean,
          /** A terminal opened with a command ends with it: exit_code is the command's. */
          exit_code: optionalKey(Schema.NullOr(Schema.Int)),
          /** Set when a signal ended it (Ctrl-C, a kill), as term.exit's. */
          signal: optionalKey(Schema.String),
          exited_at: optionalKey(IsoDateTime),
        }),
      ),
    }),
  ),
  "term.attach": m({ terminal_id: Id }, S({ scrollback: Schema.String, cols: Count, rows: Count, exited: Schema.Boolean })),
  "term.detach": m({ terminal_id: Id }, Empty),
  /**
   * A running command's output as it prints: tool.live frames to this connection, from the command's current tail,
   * until it settles (the frame with running: false is the last) or tool.unwatch. item_id is the command's tool row
   * (tool.started's item_id) in the workspace's own chat. Ask only for rows on screen; nothing of it is stored.
   * Fails with not_found for anything that is not such a command, or unsupported where the runtime streams none.
   */
  "tool.watch": m({ ...ws, item_id: Id }, Empty),
  "tool.unwatch": m({ ...ws, item_id: Id }, Empty),
  /**
   * The engine's guess at the person's next message in this workspace's chat (Settings.prompt_suggestions): a
   * suggestion.live frame to this connection now and at each change, until suggestion.unwatch.
   * The Caveman engine, Claude Agent and Codex make one after a completed turn; it clears when the chat sends again.
   * Nothing of it is stored.
   */
  "suggestion.watch": m({ ...ws }, Empty),
  "suggestion.unwatch": m({ ...ws }, Empty),
  /**
   * What one file-change step recorded (an `edit` tool row's item_id), read when the person opens it, never kept in
   * the journal: the engine's patch (`diff`: a unified or git patch, a bare hunk, or an added/deleted file's content),
   * else the content `before`/`after` when the engine sent no diff, and the files it names. Each text is bounded and
   * ends "\n… output truncated for transport" when cut. not_found for any other step.
   */
  "tool.diff": m(
    { ...ws, item_id: Id },
    S({
      /**
       * The chat's folder on the computer that recorded the step, whose paths engines often name absolutely: a client
       * reads them relative to it, as fs.read takes them. Set for a chat on any computer, Cloud ones included, unlike
       * Workspace.root_path; absent when the chat has no folder there.
       */
      root_path: optionalKey(Schema.String),
      path: Schema.String,
      diff: optionalKey(Schema.String),
      before: optionalKey(Schema.String),
      after: optionalKey(Schema.String),
      changes: optionalKey(Schema.Array(S({ operation: Schema.String, path: Schema.String, old_path: optionalKey(Schema.String) }))),
    }),
  ),

  "browser.screencast": m({ ...ws, enabled: Schema.Boolean, max_fps: optionalKey(Count) }, Empty),
  "browser.navigate": m({ ...req, ...ws, url: Schema.String }, Empty),
  /** ignore_cache with reload is a hard reload. */
  "browser.history": m(
    { ...req, ...ws, action: Schema.Literals(["back", "forward", "reload"]), ignore_cache: optionalKey(Schema.Boolean) },
    Empty,
  ),
  /**
   * Take over the browser, or hand it back. While the user holds it, the
   * agent's browser tools wait or fail with user_in_control; only the
   * connection that took control may send input.
   */
  "browser.control": m({ ...req, ...ws, controller: Schema.Literals(["user", "agent"]) }, S({ controller: Controller })),
  /**
   * Input while the user holds control, batched once per animation frame; coordinates in frame pixels. It answers
   * once the input is on its way: input the page cannot take yet (it waits on its dialog) waits in the browser.
   */
  "browser.input": m({ ...req, ...ws, events: Schema.Array(BrowserInputEvent) }, Empty),
  "browser.snapshot": m(
    ws,
    S({ url: Schema.String, title: Schema.String, image: Blob, refs: Schema.String }),
  ),

  /**
   * The workspace computer's screen: a Cloud computer's desktop, or on this Mac the app window the chat's agent is
   * using (computer.state `app`). The browser.* control set, without URLs. On this Mac taking over pauses the chat's
   * agent and brings its app forward for the person, who uses their own mouse: computer.input is unsupported there.
   */
  "computer.screencast": m({ ...ws, enabled: Schema.Boolean, max_fps: optionalKey(Count) }, Empty),
  "computer.control": m({ ...req, ...ws, controller: Schema.Literals(["user", "agent"]) }, S({ controller: Controller })),
  "computer.input": m({ ...req, ...ws, events: Schema.Array(InputEvent) }, Empty),
  /** Whether agents can use apps on this computer, and the macOS permissions that takes. */
  "computer.access": m({}, ComputerAccess),
  /**
   * Opens System Settings at the first missing permission, with a guide that shows which app to allow (Caveman Code).
   * This computer's own screen only (forbidden elsewhere). Answers at once; computer.access reads the result.
   */
  "computer.access.guide": m({ ...req }, Empty),
  /**
   * Ports listening on the workspace's computer, for the new tab and the browser's empty state. A server this
   * workspace's chat started says so: `started_by` `terminal` (one of its terminals, `terminal_id`) or `agent` (a job
   * its agent ran, still attributed after the turn ends), with the `pid` that `workspace.servers.stop` takes.
   */
  "workspace.servers": m(
    ws,
    S({
      servers: Schema.Array(
        S({
          port: Count,
          url: Schema.String,
          process_name: optionalKey(Schema.String),
          pid: optionalKey(Count),
          started_by: optionalKey(Schema.Literals(["terminal", "agent"])),
          terminal_id: optionalKey(Id),
        }),
      ),
      /** Whether this computer can stop a listed server (not on Windows). Absent on older runtimes. */
      can_stop: optionalKey(Schema.Boolean),
    }),
  ),
  /**
   * Stops a server this workspace's chat started (a `workspace.servers` entry with `started_by`): its job's process
   * group gets SIGTERM, then SIGKILL after 3 s. Never the runtime, an agent CLI or a terminal's shell: a server
   * sharing a group with one answers `invalid_state`; one no longer listed answers `not_found`.
   */
  "workspace.servers.stop": m({ ...req, ...ws, pid: Count, port: Count }, Empty),
  /**
   * Serves the chat's preview (Workspace.preview) and answers its address, for the person's browser: the server the
   * runtime already runs for it, else something already listening on its port, else its command started in the chat's
   * worktree, answered once the port takes connections (up to 90 s; `invalid_state` with the end of its output when it
   * exits or never listens). The runtime's owner only: it runs a command. This Mac only.
   */
  "workspace.preview.open": m({ ...req, ...ws }, S({ url: Schema.String, started: Schema.Boolean })),
  /** Stops the server workspace.preview.open started for the chat, as a whole process group; nothing when none runs. */
  "workspace.preview.stop": m({ ...req, ...ws }, Empty),

  "mail.task": mailSend,
  "mail.note": mailSend,
  "mail.ask": mailSend,
  /** A pure read: never consumes mail. `after` is the last message id the caller has seen. */
  "mail.wait": m(
    {
      ...ses,
      after: optionalKey(Id),
      workspace_ids: optionalKey(Schema.Array(Id)),
      timeout_ms: optionalKey(Count),
    },
    S({
      messages: Schema.Array(MailMessage),
      finished: Schema.Array(Workspace),
      timed_out: Schema.Boolean,
    }),
  ),
  "mail.claim": m(
    { ...req, ...ses, paths: Strings },
    S({ claims: Schema.Array(Claim), conflicts: Schema.Array(Claim) }),
  ),
  "mail.release": m({ ...req, ...ses, paths: Strings }, S({ released: Strings })),
  "mail.handoff": m(
    {
      ...req,
      ...ses,
      brief: Schema.String,
      engine: optionalKey(EngineId),
      computer_id: optionalKey(Id),
      user_id: optionalKey(Id),
    },
    Session,
  ),

  "engine.list": m({}, S({ engines: Schema.Array(EngineDescriptor) })),
  /**
   * The workspace engine's own slash commands in its checkout: Claude Agent's
   * built-in and custom ones (the repository's .claude/commands too), Codex's.
   * Sent as the start of a message, the engine runs them. `pending`: the
   * engine is still reading them; ask again.
   */
  "engine.commands": m({ ...ws }, S({ commands: Schema.Array(EngineCommand), pending: optionalKey(Schema.Boolean) })),
  /**
   * Settings -> Engines: adds an account. `key` is sent once and never
   * returned; the result shows labels only. Caveman engine: one key per
   * `provider`, kept in the runtime's secret store. Codex: an OpenAI API key,
   * signed in by Codex inside the account's own app-managed CODEX_HOME.
   * Claude Agent takes no key: `sign_in` says how to log in with the user's
   * own `claude` in a terminal. engine.account.* is owner only, as secret.*
   * (forbidden otherwise).
   */
  "engine.account.add": m(
    {
      ...req,
      engine: EngineId,
      /** Caveman engine: whose key it is, an engine.providers id or `custom-<slug>` for an endpoint of the person's own. */
      provider: optionalKey(Schema.String),
      key: optionalKey(Schema.NonEmptyString),
      /**
       * Harness engines that take a key (Cursor, Grok, ...): read the key from a secret manager instead of `key`,
       * when the account starts, never stored. Not Claude Agent, the Caveman engine or Codex.
       */
      key_ref: optionalKey(SecretRef),
      /** Caveman engine: the provider's other settings (EngineProvider.fields), by name. Harness engines: the new account's settings (binary path, server URL). */
      fields: optionalKey(Schema.Record(Schema.String, Schema.String)),
      /** Caveman engine, local and custom providers: an OpenAI-compatible endpoint and the model ids it serves. */
      endpoint: optionalKey(S({ name: Schema.String, base_url: Schema.String, models: Strings })),
      /** Codex: run it on the person's own ChatGPT login (their `codex login`) instead of an API key. */
      chatgpt: optionalKey(Schema.Boolean),
      /**
       * Claude Agent, and Codex with `chatgpt`: one more login of the person's, an account of its own with a
       * config folder of its own, signed in with the engine's own CLI there (`sign_in`). Without it, Claude
       * Agent's add is the person's own `claude` login.
       */
      another: optionalKey(Schema.Boolean),
      /**
       * Connect once for every computer (README: Sign in once): Claude Agent's Claude plan, or with `chatgpt` Codex's
       * ChatGPT plan. The runtime runs the official CLI's own sign-in (`claude setup-token`, `codex login` in a
       * private home it deletes afterwards), which opens the provider's page in the browser; `sign_in` carries that
       * page (`command` is empty: nothing is typed in a terminal). The result goes to Caveman Cloud, sealed for the
       * person; engine.account.complete (`account_id: "connecting"`) waits for it. The sign-in is the runtime's, one
       * per engine, and every client sees it (EngineDescriptor.auth.connecting, whose `request_id` is this call's): a
       * call while one is open is answered that one's page and starts nothing. Refused where this computer is not
       * signed in to Caveman (`invalid_state`), where Cloud switched the kind off (`unsupported`) and on a Cloud
       * computer.
       */
      everywhere: optionalKey(Schema.Boolean),
      /**
       * With `everywhere`: the `request_id` of the open sign-in this client started (EngineDescriptor.auth.connecting).
       * The runtime ends that sign-in and starts this call's in its place, which is how its starter switches to
       * `device_code`. Without it, or naming another call, the open sign-in stays and this call is answered its page.
       */
      connecting: optionalKey(Schema.String),
      /**
       * With `everywhere` on Claude Agent: the line `claude setup-token` printed on another computer, for a client
       * with no `claude` beside it (web, phone). Sent once and never returned.
       */
      token: optionalKey(Schema.NonEmptyString),
      /** With `everywhere` on Codex: codex's device code sign-in (`sign_in.code`), for a browser that cannot reach this computer. */
      device_code: optionalKey(Schema.Boolean),
    },
    S({
      /** The engine's accounts after the call (EngineDescriptor.auth.accounts). */
      accounts: Schema.Array(EngineAccount),
      /**
       * Engines that log in through their own CLI: the command to run in a terminal, and what to do there.
       * `url`: a harness's browser sign-in (Cursor) to open instead; the account appears once it finishes.
       * `code`: a one-time code to enter on that page (Codex's device code).
       */
      sign_in: optionalKey(S({ command: Schema.String, message: Schema.String, url: optionalKey(Schema.String), code: optionalKey(Schema.String) })),
      /** Caveman engine: the test call made before the key was kept. A key the provider refused is not kept. */
      test: optionalKey(KeyTestResult),
    }),
  ),
  /** Caveman engine: tests a stored key again with one tiny call and records its health. */
  "engine.account.test": m({ ...req, engine: EngineId, account_id: Id }, S({ accounts: Schema.Array(EngineAccount), test: KeyTestResult })),
  /**
   * Caveman engine: a provider's own sign-in, which hands back an API key
   * (OpenRouter) or a subscription's tokens (ChatGPT, GitHub Copilot,
   * SuperGrok). `provider` is the provider, or the slot of an account signing
   * in again. Open `url` in a browser and, with `code`, enter it there; the
   * credential is stored, tested and listed once the person approves.
   *
   * Harness engines: `provider` names the account. A browser sign-in answers
   * `url` (asking again returns the same page while it is open); one still
   * starting answers `message` only, and the page follows on a later call. A
   * CLI login answers `command` and `message`. Nothing set: already signed in.
   */
  "engine.account.signin": m(
    { ...req, engine: EngineId, provider: Schema.String },
    S({ url: optionalKey(Schema.String), code: optionalKey(Schema.String), command: optionalKey(Schema.String), message: optionalKey(Schema.String) }),
  ),
  /**
   * Harness engines: finishes a browser sign-in whose page redirected somewhere
   * this computer cannot hear (a remote or Cloud computer): paste the address
   * the browser ended on.
   *
   * A connection being made (engine.account.add `everywhere`), `account_id: "connecting"`: waits for the person to
   * approve on the provider's page, and answers the accounts once the connection is kept. `callback_url` is empty,
   * or the code Claude's page shows when the browser could not reach this computer. `waiting`: the person has not
   * approved yet, so ask again. A sign-in that ended without a connection is `invalid_state`, with what to do. Any
   * client may wait, whoever started the sign-in; waiting ends nothing.
   *
   * A pasted code `claude` did not take: `waiting`, with `refused` (why, in claude's own words when it said) and, when
   * claude started over, `url`: its new page, the only one whose code it takes from then on.
   */
  "engine.account.complete": m(
    { ...req, engine: EngineId, account_id: Id, callback_url: Schema.String },
    S({
      accounts: Schema.Array(EngineAccount),
      waiting: optionalKey(Schema.Literal(true)),
      refused: optionalKey(Schema.String),
      url: optionalKey(Schema.String),
    }),
  ),
  /** The providers an engine takes keys for (Caveman engine), for Settings > Models & keys. */
  "engine.providers": m({ engine: EngineId }, S({ providers: Schema.Array(EngineProvider) })),
  /**
   * Settings > Models & keys > Web search: the Caveman engine's web tool keys, never their
   * values. `credits`: Caveman credits are on, so searches run on them, at cost, when no own key answers. web.keys.* is
   * owner only, as secret.* (forbidden otherwise).
   */
  "web.keys.status": m({}, WebKeys),
  /**
   * Checks the key with one call (a search; Firecrawl's credit balance), then keeps it sealed on this computer. A key the provider refuses is not
   * stored (key_refused). `note`: kept, but the provider was rate limiting or did not answer the check. Where no key
   * is taken (EngineDescriptor.auth.no_sign_in_here) it is `unsupported`, before the check; web.keys.clear stays.
   */
  "web.keys.set": m({ ...req, provider: WebSearchProvider, key: Schema.NonEmptyString }, S({ ...WebKeys.fields, note: optionalKey(Schema.String) })),
  "web.keys.clear": m({ ...req, provider: WebSearchProvider }, WebKeys),
  /**
   * Settings > Secret providers: the secret managers this runtime reads from, and every credential setting that can
   * point at one (engine keys, source control tokens), each with where it reads from now. Starts no read: a slot's
   * `problem` is from the last read.
   */
  "secret_provider.list": m({}, SecretProviders),
  /**
   * Adds a 1Password provider (no `id`) or changes one. `account` signs in through the 1Password app on this
   * computer; `service_account` as a service account, whose `service_account_token` is sent once, sealed in this
   * runtime's secret store and never returned (sending none keeps the stored one). Changing it reads every
   * reference to it again. Where no key is taken (EngineDescriptor.auth.no_sign_in_here) it is `unsupported`, either
   * way of signing in; secret_provider.remove stays.
   */
  "secret_provider.save": m(
    {
      ...req,
      id: optionalKey(Schema.String),
      label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      account: optionalKey(Schema.String),
      service_account: optionalKey(Schema.Boolean),
      service_account_token: optionalKey(Schema.NonEmptyString),
    },
    SecretProviders,
  ),
  /** Removes a provider and its stored token. Settings that point at it stay, and read as unset until it is back. */
  "secret_provider.remove": m({ ...req, id: Schema.String }, SecretProviders),
  /**
   * Whether a provider can be reached and is signed in (it may ask for an unlock on this computer). With `reference`,
   * reads that secret too, to show it resolves: the value is never returned, only whether it was read.
   */
  "secret_provider.check": m(
    { ...req, id: Schema.String, reference: optionalKey(Schema.String) },
    S({ ok: Schema.Boolean, message: Schema.String }),
  ),
  /** Forgets every value read so far and reads them again; engines whose keys changed restart. */
  "secret_provider.refresh": m({ ...req }, SecretProviders),
  /**
   * Points a credential setting at a secret (`ref`), replacing any pasted value, or (`ref` null) stops reading it
   * from there, leaving it unset. The reference is checked against its provider's syntax, not read. Where no key is
   * taken (EngineDescriptor.auth.no_sign_in_here) setting a `ref` is `unsupported`; null stays.
   */
  "secret_slot.set": m({ ...req, target: SecretSlotTarget, ref: Schema.NullOr(SecretRef) }, SecretProviders),
  /**
   * Removes an account: deletes its key, or (Codex) signs out and deletes its managed home. A user's own CLI login is
   * never signed out. A connection (`where: everywhere` or `cloud`) is removed from Caveman Cloud, so from every
   * computer of the person's, and ended at its provider where the provider can. `account_id: "connecting:<request_id>"`
   * gives up a connection being made, when `request_id` is the engine.account.add that started it
   * (EngineDescriptor.auth.connecting). A bare `"connecting"` or another call's id ends nothing and answers the
   * accounts: a second window never ends the first's sign-in.
   */
  "engine.account.remove": m({ ...req, engine: EngineId, account_id: Id }, S({ accounts: Schema.Array(EngineAccount) })),
  /**
   * Uses an account first. A connection moves to the front of the person's order in Caveman Cloud, on every computer.
   * One of this computer's own accounts becomes the one new workspaces run on while no connection serves the engine.
   * A workspace keeps the account it started on.
   */
  "engine.account.activate": m({ ...req, engine: EngineId, account_id: Id }, S({ accounts: Schema.Array(EngineAccount) })),
  /**
   * Settings > Models & keys' "Add what's on this computer": turns on every agent installed here and already
   * signed in through its own CLI, and says what it found for each: `ready` (on, and in use), `signed_out` (on
   * this computer but signed out: an engine.account.add signs it in) or `not_found`. Claude Agent and Codex are
   * probed afresh. Never reads a credential: each agent's own probe says whether it is signed in.
   */
  "engine.scan": m(
    { ...req },
    S({ engines: Schema.Array(S({ engine: EngineId, found: Schema.Literals(["ready", "signed_out", "not_found"]) })) }),
  ),
  /** Sets an account's tag (EngineAccount.tag); null goes back to the one made from its label. */
  "engine.account.tag": m({ ...req, engine: EngineId, account_id: Id, tag: Schema.NullOr(AccountTag) }, S({ accounts: Schema.Array(EngineAccount) })),
  /**
   * First run's "Bring my setup": the MCP servers and skills already set up
   * for Claude Code and Codex, and `repo_path`'s instruction files, with the
   * engines that load each by themselves. Reads names, commands and URLs only:
   * never environment values, headers or auth files.
   */
  "setup.scan": m({ repo_path: optionalKey(Schema.String) }, S({ items: Schema.Array(SetupItem) })),
  /** Subagent types delegate_task can start: the built-ins, ~/.caveman/agents and enabled Space plugins, plus a project's own with project_id. */
  "agent.types": m({ project_id: optionalKey(Id) }, S({ types: Schema.Array(AgentTypeInfo) })),
  /** Runs one agent on a task as a one-step manual run (`caveman-runtime agent run <name> "<task>"`). */
  "agent.run": m(
    { ...req, project_id: Id, agent: Schema.String, task: Schema.NonEmptyString, model: optionalKey(Schema.String), computer: optionalKey(AutomationComputer) },
    S({ run_id: Id }),
  ),
  "settings.get": m({}, Settings),
  "settings.set": m({ ...req, settings: SettingsPatch }, Settings),
  /** The app's keyboard shortcuts (Settings > Keyboard), every command with its key: defaults and the user's own. */
  "keybindings.get": m({}, S({ keybindings: Schema.Array(Keybinding) })),
  /** Rebinds one of the app's commands; `key: null` puts its default back. A key no command can use is invalid_params. */
  "keybindings.set": m({ ...req, command: Schema.String, key: Schema.NullOr(Schema.String) }, S({ keybindings: Schema.Array(Keybinding) })),
  /**
   * The companions people made (Settings > Appearance > Companion): the folder they live in
   * (`~/.caveman/companions`, made with its README, the guide a chat follows) and each
   * `<id>.json` there as written (`problem` instead of `text` for one too big to read). The client
   * checks and draws them (@caveman-app/shared/companion).
   */
  "companion.list": m(
    {},
    S({ folder: Schema.String, files: Schema.Array(S({ id: Schema.String, text: optionalKey(Schema.String), problem: optionalKey(Schema.String) })) }),
  ),
  /**
   * Enrolls this runtime (This Mac) with Caveman Cloud: `token` is the access
   * token of the person's Cloud sign-in (code:write), used for this one call
   * and never stored or returned. The link runs while Settings.remote_control is on.
   */
  "cloud.enroll": m(
    { ...req, cloud_url: Schema.String, token: Schema.NonEmptyString, name: optionalKey(Schema.String) },
    S({ cloud_url: Schema.String, runtime_id: Id, organization_id: Id, computer_id: Id }),
  ),
  /** The Cloud link: off (remote_control off), not_enrolled, connecting, connected, unauthorized (revoked or refused), replaced (another instance of this runtime holds the relay). */
  "cloud.status": m({}, CloudStatus),
  /**
   * A short-lived bearer for Caveman Cloud's relay and chat routes (/api/v1/code/chats*), minted from this runtime's
   * Cloud sign-in, so the desktop opens Cloud chats in the app. Never the sign-in's refresh token. Only for a local
   * client (forbidden through the relay); invalid_state while the runtime is not signed in to a Cloud.
   */
  "cloud.client_token": m({}, S({ token: Schema.String, expires_at: IsoDateTime, api_url: Schema.String, relay_url: Schema.String })),
  /**
   * Device approval (DESIGN S13), answered on a relayed connection to This Mac after its device.challenge: the device's
   * key, a fresh ECDH key (`key`, the raw P-256 point, base64url) and its signature (ECDSA P-256 SHA-256, r||s,
   * base64url) over "caveman-device-v1" + "\n" + runtime_id + "\n" + nonce + "\n" + the challenge's key + "\n" + `key`.
   * `pending`: This Mac asks the person (device.request); device.status follows. Once approved every frame the device
   * sends is sealed (devices.ts sealFrame). Not served on a Cloud computer or to a local client (invalid_state).
   */
  "device.hello": m(
    {
      device_id: optionalKey(Id),
      name: Schema.String,
      public_key: DevicePublicKeyJwk,
      key: Schema.String,
      signature: Schema.String,
      /** Answering a challenge that offered `hello: 2`: the signature is over "caveman-device-v2", the same fields, then `kind` and the cleaned `name`. */
      kind: optionalKey(DeviceRole),
      /**
       * A Mac's desktop app joining this Mac as one of the person's Macs (decision 31): devices.ts pairProof of the code
       * this Mac's screen shows (device.pair.start) over this hello's key id and its v2 signed bytes. Without it a
       * hello's kind "mac" asks as a device. Any proof uses the code up; a wrong or old one, or one made for another
       * key, closes the connection (invalid_params).
       */
      pair: optionalKey(Schema.String),
    },
    S({ status: DeviceStatus, code: Schema.String }),
  ),
  /** The devices allowed to drive This Mac, the ones waiting and the ones blocked. Local clients only (forbidden through the relay). */
  "device.list": m({}, DeviceList),
  /**
   * Allows a waiting device: its open connection is served at once. Local clients only: only This Mac's own screen
   * allows. `statement`: this Mac's desktop key's signed allow of exactly that device (its key, name and kind as it
   * asked, for this Mac's person), which the runtime puts in the person's log for their other Macs. `role`: the kind
   * the screen showed when it was clicked; refused when the request says another. `device` on a Mac allowed here
   * before Macs shared approvals, now asking as a Mac, keeps it as it was and stops it asking.
   */
  "device.allow": m({ ...req, device_id: Id, statement: optionalKey(SignedDeviceStatement), role: optionalKey(DeviceRole) }, S({ device: DeviceEntry })),
  /**
   * Removes an allowed device (its open connections close at once and it is blocked), says no to a waiting one
   * (blocked), or unblocks a blocked one. Local clients only. `statement`: the desktop key's signed removal, which
   * every Mac of the person's that takes this Mac's approvals applies too.
   */
  "device.remove": m({ ...req, device_id: Id, statement: optionalKey(SignedDeviceStatement) }, S({})),
  /**
   * Add a Mac (decision 31): a new one-time code another of the person's Macs types into its desktop app to join this
   * one (device.hello `pair`); its request then asks as a Mac. One live code at a time, in memory only, for 10 minutes and
   * one try; a new one replaces it. Local clients only; invalid_state until this Mac's Caveman sign-in names its person.
   */
  "device.pair.start": m({ ...req }, S({ code: Schema.String, expires_at: IsoDateTime })),
  /** Whether another device drives This Mac under Settings.keep_awake_remote's rule, for the desktop's idle-sleep hold. Local clients only. */
  "device.awake": m({}, S({ wanted: Schema.Boolean })),
  /**
   * This runtime's agents key (the desktop app's; absent without it), under This Mac's name: `vouched` once this Mac's
   * log holds this screen's vouch for it, `shared` once Cloud took that vouch too, so the person's other Macs can read it
   * (until then its chats send no mail to them). Local clients only.
   */
  "device.agents": m({}, S({ agents: optionalKey(S({ device_id: Id, public_key: DevicePublicKeyJwk })), name: Schema.String, vouched: Schema.Boolean, shared: optionalKey(Schema.Boolean) })),
  /**
   * This Mac's desktop key vouches for its agents key: `statement` is its signed "agents" statement of exactly this
   * runtime's agents key, for this Mac's person, which the runtime puts in the person's log (and again under a new
   * runtime after a sign-in), so their other Macs take mail its chats sign while they trust this Mac. Local clients only.
   */
  "device.vouch": m({ ...req, statement: SignedDeviceStatement }, S({ vouched: Schema.Boolean })),
  /**
   * The lid is closing (S12): every synced chat's copy is flushed now, and each working one is handed to Caveman Cloud,
   * which continues it on a Cloud computer at once (`handed_off`); one Cloud cannot continue stops its turn here
   * (`paused`). Answers within `budget_ms` (default 2500). Chats that do not sync are the caller's (session.move,
   * turn.interrupt). Only for a client on this computer.
   */
  "cloud.suspend": m({ ...req, budget_ms: optionalKey(Count) }, S({ handed_off: Schema.Array(Id), paused: Schema.Array(Id), flushed: Count })),
  /**
   * What closing the lid would do to each chat on this computer, before it happens (AC-12): it continues on a Cloud
   * computer (with the gaps of its own in `gaps`: "continues from its transcript"), pauses here, or stays here by what
   * it is, with the reason and the fix. What every move leaves behind (servers and terminals stop, files git ignores
   * stay here) is no chat's own gap: a client says it once. Read from this Mac's settings and copies and Cloud's
   * holdings as last fetched, never a Cloud call per chat. Only for a client on this computer.
   */
  "cloud.lid.summary": m(
    {},
    S({
      chats: Schema.Array(
        S({
          session_id: Id,
          outcome: Schema.Literals(["continues", "continues_with_gaps", "pauses", "stays"]),
          reason: optionalKey(Schema.String),
          fix: optionalKey(Schema.String),
          gaps: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
  /**
   * Signs This Mac in to Caveman Cloud (Settings.cloud_url) with Cloud's
   * device flow: show `user_code`, open `verification_uri_complete`, and the
   * runtime enrolls itself once the person approves (cloud.changed follows).
   * The person's Cloud credential never reaches a client and is never stored.
   * Turns Remote control off: whoever approves the code controls this
   * computer, so the person switches it back on after cloud.status names the
   * approving `account`. Switching it off cancels a sign-in still waiting.
   * `provider`: the approve page signs a signed-out person in with GitHub or
   * Google straight away (a Cloud that does not know it shows its usual page).
   * `email`: prefills Caveman Cloud's sign-in; never a password.
   * `intent`: what the person picked in the app, so a signed-out approve page
   * opens Cloud's sign-in ("signin") or its new-account form ("signup") without
   * asking again.
   * A Cloud that does not know a field ignores it.
   */
  "cloud.signin": m(
    {
      ...req,
      provider: optionalKey(Schema.Literals(["github", "google"])),
      email: optionalKey(Schema.String),
      intent: optionalKey(Schema.Literals(["signin", "signup"])),
    },
    CloudSignin,
  ),
  /**
   * Forgets the Cloud link here, revokes this runtime in Cloud, signs the kept Caveman sign-in out, and turns Remote control off.
   * `delete_cloud_copies` (default true): first deletes what Cloud holds for you (cloud.holdings): the profile, the secrets of
   * repositories and servers you made available on Cloud computers, and your Cloud connections.
   */
  /** `cloud_copies_error`: what Cloud still holds after delete_cloud_copies (the sign-out itself went through). */
  "cloud.signout": m({ ...req, delete_cloud_copies: optionalKey(Schema.Boolean) }, S({ cloud_copies_error: optionalKey(Schema.String) })),
  /**
   * What syncs to Caveman Cloud by itself while signed in: settings, spaces, MCP server definitions and home skills,
   * never a secret value. `pending`: signed in, not synced yet. `paused`: you removed it from Cloud (cloud.profile.sync
   * turns it back on). On a Cloud computer: its last pull (an `error` keeps the last good one in use). Each item says
   * where it runs on a Cloud computer, or why it was left out (`skipped`).
   */
  "cloud.profile.status": m({}, CloudProfileStatus),
  /** Syncs now (This Mac pushes, a Cloud computer pulls); turns a paused sync back on. */
  "cloud.profile.sync": m({ ...req }, CloudProfileStatus),
  /**
   * "Available on Cloud computers" for one repository's secrets. Off by default. On: its values go to Caveman Cloud's
   * vault now and follow every secret.set, delete and import; off: Cloud's copies are deleted now. A repository that
   * is not on is never named to Cloud. With `names` (and available true), only those names go and follow their changes,
   * while the repository's switch stays as it was (Add from this Mac); `names` in the answer are the ones available.
   */
  "cloud.secrets.set_available": m(
    { ...req, repo: Repo, available: Schema.Boolean, names: optionalKey(Strings) },
    S({ repository: Schema.String, available: Schema.Boolean, names: Strings }),
  ),
  /**
   * "Available on Cloud computers" for one personal server's granted keys (its consent). On: the values go to Cloud's
   * vault and only that server's process on your Cloud computers gets them; off: Cloud's copies are deleted now.
   */
  "cloud.server.set_available": m({ ...req, name: Schema.String, available: Schema.Boolean }, S({ available: Schema.Boolean, names: Strings })),
  /** Everything Caveman Cloud holds for you, by name (never a value). */
  "cloud.holdings": m({}, S({ items: Schema.Array(CloudHolding) })),
  /** Removes one item (`kind` and `id`, as cloud.holdings lists them), or everything (`all`), from Caveman Cloud. */
  "cloud.holdings.remove": m(
    { ...req, all: optionalKey(Schema.Boolean), kind: optionalKey(CloudHolding.fields.kind), id: optionalKey(Schema.String) },
    S({ removed: Count }),
  ),
  /** Who read what Cloud holds for you, newest first: each secret resolve, server key, connection lease and profile read. */
  "cloud.access_log": m({ limit: optionalKey(Count) }, S({ entries: Schema.Array(CloudAccess) })),
  /**
   * The organization's computers, read through this runtime's Cloud sign-in as the person who
   * signed it in. `available`: this Caveman Cloud runs Cloud computers, so cloud.workspace.create
   * may ask for one. Fails `invalid_state` while this runtime is not signed in.
   */
  "cloud.computers": m({}, S({ available: Schema.Boolean, computers: Schema.Array(CloudComputerRow) })),
  /** Wakes (`running`) or puts to sleep (`suspended`: the pod goes, the disk stays) a Cloud computer. */
  "cloud.computer.set": m({ ...req, computer_id: Id, state: Schema.Literals(["running", "suspended"]) }, CloudComputerRow),
  /**
   * Deletes one of the person's Cloud computers (one this runtime's enroller made): the chats on it are archived, their
   * history kept in Caveman, and its disk goes, uncommitted work included. Answers the row, now deleted.
   */
  "cloud.computer.delete": m({ ...req, computer_id: Id }, CloudComputerRow),
  /**
   * A chat Caveman Cloud places on one of the person's Cloud computers for `repo` (a GitHub URL or
   * owner/name the computer clones); it runs the Caveman engine, Claude Agent or Codex. With `start`
   * Cloud also queues the chat's start, and the chat opens at once on any of the person's devices.
   * `open_url` is the Cloud-hosted client.
   */
  "cloud.workspace.create": m(
    {
      ...req,
      repo: Schema.NonEmptyString,
      base_branch: optionalKey(Schema.String),
      engine: EngineId,
      title: Schema.NonEmptyString,
      /**
       * The other repositories of `repo`'s project the chat works in (GitHub owner/name each): Caveman Cloud keeps
       * them on the workspace and the computer may fetch them, and no others. One outside the project, or one the
       * person cannot read, is refused (invalid_params) naming it. Absent: a chat in `repo` alone.
       */
      checkouts: optionalKey(Schema.Array(S({ repo: Schema.NonEmptyString, base_branch: optionalKey(Schema.String) }))),
      /**
       * The chat's start, queued in Caveman Cloud with its placement: the request id its Cloud computer's runtime
       * runs workspace.create under, and that call's params without `placed_workspace_id` (Cloud names the workspace
       * it placed). The computer starts the chat when it links, with no window waiting for it. Absent: Cloud places
       * the chat and the client starts it once the computer answers.
       */
      start: optionalKey(S({ request_id: RequestId.check(Schema.isMaxLength(150)), params: Schema.Record(Schema.String, Schema.Unknown) })),
    },
    S({
      workspace_id: Id,
      computer_id: Id,
      open_url: Schema.String,
      /**
       * With `start`, when this Caveman Cloud queued it: the chat's session and the queued call as Cloud holds it
       * (GET /api/v1/code/chats/{session_id}/calls/{request_id}). Absent from a Cloud that only placed the chat (one
       * from before queued starts): the client then starts it itself, as before.
       */
      session_id: optionalKey(Id),
      start: optionalKey(
        S({
          id: Id,
          request_id: RequestId,
          method: Schema.String,
          status: Schema.Literals(["queued", "delivered", "done", "failed", "expired"]),
          created_at: IsoDateTime,
        }),
      ),
    }),
  ),
  /**
   * Gathers a problem report for the preview: this computer's recent logs (bounded in time and size), the
   * error, and what the client passes (the end of the chat, a PNG of the window), all redacted here, with a
   * template description. Sends nothing and writes nothing: the report lives in memory for an hour.
   */
  "bug_report.prepare": m(
    {
      surface: BugReportSurface,
      error: optionalKey(ReportedError),
      provider_id: optionalKey(Schema.String),
      model_id: optionalKey(Schema.String),
      thread_id: optionalKey(Schema.String),
      thread_excerpt: optionalKey(Schema.String),
      screenshot_png_base64: optionalKey(Schema.String),
    },
    BugReportPrepared,
  ),
  /**
   * A model (Settings' text generation model, through the person's own engine) reads the prepared report's
   * redacted error and logs and writes its title and description. Without one that works, the template stays
   * and `error` says why; this never fails for want of a model.
   */
  "bug_report.describe": m(
    { report_id: Id },
    S({ title: Schema.String, summary: Schema.String, drafted_by: Schema.Literals(["template", "agent"]), error: optionalKey(Schema.String) }),
  ),
  /**
   * Sends a prepared report as the person left it in the preview: their title, description and note
   * (redacted again), and only the parts they turned on. It goes to the outbox first, so it survives
   * being offline or a restart; the answer comes after the first attempt (or a few seconds).
   */
  "bug_report.send": m(
    {
      ...req,
      report_id: Id,
      title: Schema.String,
      summary: Schema.String,
      note: optionalKey(Schema.String),
      include: S({ logs: Schema.Boolean, screenshot: Schema.Boolean, thread_excerpt: Schema.Boolean, code: Schema.Boolean }),
    },
    BugReportRecord,
  ),
  /** This computer's reports, newest first. `refresh`: ask Caveman what became of the sent ones first. */
  "bug_report.list": m({ refresh: optionalKey(Schema.Boolean) }, S({ reports: Schema.Array(BugReportRecord) })),
  /** Deletes a report and its logs: from Caveman when it was sent, and from this computer. */
  "bug_report.delete": m({ ...req, report_id: Id }, S({ deleted: Schema.Boolean })),
  /** Settings -> Account: who is signed in, the organization, its Code plan, credits and members (read-only). */
  "account.get": m({}, AccountSummary),
  /**
   * A Stripe Checkout page for a Code plan (`plan`, `interval`, Team `seats`)
   * or a credits top-up (`amount_usd`, whole dollars): the client opens `url`
   * in the browser, and the plan changes when Stripe confirms the payment. An
   * organization that already has a plan moves it instead (no `url`):
   * `effective` says when (now, once its prorated invoice is paid, or at
   * renewal for a smaller plan).
   */
  /**
   * Caveman credits on the Caveman engine: on mints a credits key for the
   * signed-in person in Cloud and keeps it in the runtime's secret store, so
   * the engine's picker lists the plan's models (run through Caveman's
   * gateway, paid from the plan and credits); off forgets it.
   */
  "account.credits": m({ ...req, enabled: Schema.Boolean }, S({ enabled: Schema.Boolean })),
  "account.checkout": m(
    {
      ...req,
      kind: Schema.Literals(["plan", "topup"]),
      plan: optionalKey(Schema.String),
      interval: optionalKey(Schema.Literals(["month", "year"])),
      seats: optionalKey(Schema.Number),
      amount_usd: optionalKey(Schema.Number),
    },
    S({ url: optionalKey(Schema.String), effective: optionalKey(Schema.Literals(["now", "payment", "renewal"])) }),
  ),
  /**
   * Manage the organization's Code billing. `portal`: Stripe's billing portal
   * (card, invoices, cancelling at the period's end) for the client to open in
   * the browser, as with checkout. `resume`: keep a plan that is set to end
   * renewing. Cancelling is only in the portal.
   */
  "account.billing": m({ ...req, action: Schema.Literals(["portal", "resume"]) }, S({ url: optionalKey(Schema.String) })),
  /**
   * Pay as you go on or off, its monthly limit, and what one charge adds when
   * credits fall below what, in whole dollars; an amount or threshold left out
   * takes Cloud's default from the limit. Turning it on with no card saved
   * also opens Stripe's page to save one: the client opens `url` in the
   * browser, and Cloud starts adding credits once the card is saved. Cloud
   * refuses a number out of its bounds or over the organization's ceiling,
   * saying which.
   */
  "account.auto_topup": m(
    { ...req, enabled: Schema.Boolean, month_limit_usd: optionalKey(Schema.Number), amount_usd: optionalKey(Schema.Number), below_usd: optionalKey(Schema.Number) },
    S({ auto_topup: CodeAutoTopup, url: optionalKey(Schema.String) }),
  ),
  /** Stripe's page to save another card for pay as you go, for the client to open in the browser. */
  "account.auto_topup_card": m({ ...req }, S({ url: Schema.String })),
  /** The free months the organization's plan earned to give friends, in the order they were earned. */
  "account.gifts": m({}, S({ gifts: Schema.Array(CodeGift) })),
  /** Emails a friend the link to one free month; Cloud sends it in the giver's name. */
  "account.gift_send": m({ ...req, code: Schema.String, email: Schema.String }, CodeGift),
  /**
   * Plugins in every marketplace, installed or not, in display order (the
   * marketplace's entry order; the Caveman catalog first). `marketplace` keeps
   * one marketplace's; `query` matches name, description, developer and
   * category; `cwd` (a project path) adds what that repository declares and its
   * project's installs. `featured`: ids the Caveman catalog features, in order.
   * `categories`: every category present, in first-seen order.
   */
  "plugin.list": m(
    { marketplace: optionalKey(Schema.String), query: optionalKey(Schema.String), cwd: optionalKey(Schema.String) },
    S({
      plugins: Schema.Array(PluginSummary),
      featured: optionalKey(Strings),
      categories: optionalKey(Strings),
      /** Caveman Cloud could not be read: team and project installs are the last ones it answered. */
      cloud_problem: optionalKey(Schema.String),
    }),
  ),
  /** One plugin, installed or not, for its detail page; not_found for an id plugin.list does not list. */
  "plugin.read": m({ id: Id, cwd: optionalKey(Schema.String) }, S({ plugin: PluginDetail })),
  /**
   * Installs a plugin for me, a project (`project_id`, a project.list id) or
   * the team. A git marketplace's plugin is copied into the install cache at
   * the marketplace's pinned commit (a remote entry: at the commit its ref
   * names now); a folder marketplace's is read in place. `policy` (project and
   * team; default `default`) and `connection` (personal unless a team or
   * project admin connects one shared account) go to Caveman Cloud with the
   * install; team installs need org admin (forbidden otherwise), project
   * and team installs need Caveman Cloud (unsupported unlinked, except a
   * project, which is kept on this computer). `needs_connect`: its servers
   * that still need a sign-in, for the connect step.
   */
  "plugin.install": m(
    {
      ...req,
      id: Id,
      scope: PluginScope,
      project_id: optionalKey(Id),
      /** A project path whose repository's own marketplace lists the plugin. */
      cwd: optionalKey(Schema.String),
      policy: optionalKey(PluginPolicy),
      connection: optionalKey(Schema.Literals(["personal", "shared"])),
      /**
       * A project or team install from a marketplace teammates do not have
       * (MarketplaceInfo.shareable add_to_team): add it to the team in Caveman
       * Cloud first (org admins; forbidden otherwise). Without it such an
       * install is invalid_params.
       */
      add_to_team: optionalKey(Schema.Boolean),
    },
    S({ installed: Schema.Literal(true), needs_connect: Schema.Array(ConnectTarget) }),
  ),
  /** Removes an install at that scope. Its cached copy stays until no install uses it. */
  "plugin.uninstall": m({ ...req, id: Id, scope: PluginScope, project_id: optionalKey(Id), cwd: optionalKey(Schema.String) }, Empty),
  /**
   * Signs in to one of a plugin's MCP servers, as connector.connect does for a
   * personal server: `authorization_url` for the client to open, or nothing
   * when it connected at once (a GitHub login). A server with an
   * `unavailable` reason is invalid_params.
   */
  "plugin.connect": m(
    /**
     * `shared`: for a shared install, true connects the team's account (org
     * admins) and false the person's own; absent, a shared install connects
     * the team's.
     */
    { ...req, id: Id, server: Schema.String, cwd: optionalKey(Schema.String), shared: optionalKey(Schema.Boolean) },
    S({
      status: Schema.Literals(["connected", "needs_sign_in", "signing_in", "error"]),
      authorization_url: optionalKey(Schema.String),
      problem: optionalKey(Schema.String),
    }),
  ),
  /**
   * Removes the team's account for one of a shared install's servers (org
   * admins; Caveman Cloud revokes its tokens). Members then sign in with
   * their own until an admin connects it again.
   */
  "plugin.disconnect": m({ ...req, id: Id, server: Schema.String, cwd: optionalKey(Schema.String) }, S({})),
  /** Every marketplace: the Caveman catalog, your team's, your own, the open repositories' and the ones you added. */
  "marketplace.list": m({ cwd: optionalKey(Schema.String) }, S({ marketplaces: Schema.Array(MarketplaceInfo) })),
  /**
   * Adds a marketplace: `owner/name[@ref]` on GitHub, a git URL (`#ref` or
   * `@ref` for a branch, tag or commit), or an absolute folder path. A git
   * one is pinned to the commit its ref names now; a folder is read in place
   * and re-read on change. A folder holding one plugin (no marketplace.json)
   * becomes a marketplace of that plugin. Where no key is taken
   * (EngineDescriptor.auth.no_sign_in_here) a URL that carries one is
   * `unsupported`.
   */
  "marketplace.add": m({ ...req, source: Schema.NonEmptyString }, S({ name: Schema.String, already_added: Schema.Boolean })),
  /**
   * Repins a git marketplace to the commit its ref names now. `changed`:
   * plugins whose files differ; `trust_dropped`: those whose hooks stop until
   * trusted again.
   */
  "marketplace.update": m({ ...req, name: Schema.String }, S({ changed: Strings, trust_dropped: Strings })),
  /** Removes a marketplace you added and every install from it for me. */
  "marketplace.remove": m({ ...req, name: Schema.String }, Empty),
  /**
   * Turns an installed plugin on or off for me, at any scope (a project or
   * team default too). A Required one is invalid_state. With `here` (and
   * `cwd`), only for the project at `cwd`: every other project keeps what it
   * has, and plugin.list from that folder answers `here`.
   */
  "plugin.set_enabled": m({ ...req, plugin_id: Id, enabled: Schema.Boolean, cwd: optionalKey(Schema.String), here: optionalKey(Schema.Boolean) }, S({})),
  /**
   * Grants a credential a plugin of the marketplace declares (`personal`: one
   * of your own servers). The runtime keeps the value in its secret store and
   * never returns it; the broker attaches it when the plugin's process starts.
   * Where no key is taken (EngineDescriptor.auth.no_sign_in_here) it is
   * `unsupported`; credential.revoke stays.
   */
  "credential.grant": m({ ...req, marketplace: Schema.String, name: Schema.String, value: Schema.NonEmptyString, cwd: optionalKey(Schema.String) }, S({})),
  "credential.revoke": m({ ...req, marketplace: Schema.String, name: Schema.String, cwd: optionalKey(Schema.String) }, S({})),
  /**
   * Runs the plugin's hooks (true) or leaves them out of every engine (false,
   * the default). Trust is for the plugin's files as they are now: any change
   * to them (an update, an edit in place, another source) needs trust again.
   * `cwd`: a project path, for a plugin of that repository or its project.
   */
  "plugin.set_trusted": m({ ...req, plugin_id: Id, trusted: Schema.Boolean, cwd: optionalKey(Schema.String) }, S({})),
  /** Personal MCP servers: added by hand, imported, or connectors. */
  /** `cwd`: a project's folder; each server answers whether it is on there (the project's own switch over everywhere's). */
  "mcp.list": m({ cwd: optionalKey(Schema.String) }, S({ servers: Schema.Array(McpServerInfo) })),
  /**
   * Adds a personal server: exactly one of `command` (stdio, started contained
   * like a plugin's) or `url` (streamable HTTP). `env` and `headers` are names;
   * grant their values with credential.grant (marketplace "personal"; a header
   * is granted as `<NAME>_<HEADER>`, upper case). `auth: "oauth"` signs in
   * through the runtime (connector.connect). Where no key is taken
   * (EngineDescriptor.auth.no_sign_in_here) a command line or URL that
   * carries one is `unsupported`.
   */
  "mcp.add": m(
    {
      ...req,
      name: Schema.String,
      command: optionalKey(Schema.String),
      args: optionalKey(Strings),
      url: optionalKey(Schema.String),
      env: optionalKey(Strings),
      headers: optionalKey(Strings),
      auth: optionalKey(Schema.Literal("oauth")),
    },
    McpServerInfo,
  ),
  /** Removes a personal server and the credentials only it used. */
  "mcp.remove": m({ ...req, name: Schema.String }, S({})),
  /** On or off everywhere; with `here` (and `cwd`), only for the project at `cwd`. */
  "mcp.set_enabled": m({ ...req, name: Schema.String, enabled: Schema.Boolean, cwd: optionalKey(Schema.String), here: optionalKey(Schema.Boolean) }, S({})),
  /**
   * The MCP servers in the user's Claude Code (~/.claude.json, user scope) and
   * Codex (config.toml) configs: names, commands and URLs. Environment and
   * header values are never read; a server whose command line or URL holds
   * a credential is listed with a reason and not imported.
   */
  "mcp.import_scan": m({}, S({ candidates: Schema.Array(McpImportCandidate) })),
  /**
   * Connects to a server through the runtime's MCP hub and lists its tools
   * now. `server` is a personal server's name, or with `plugin` (a plugin's
   * id) that plugin's server as its .mcp.json names it. Without `plugin`, a
   * name none of the person's servers has is read as a plugin server's key
   * (`<plugin>__<server>`), as clients sent it before `plugin`. The estimate
   * is its tool schemas' bytes / 4.
   */
  "mcp.tools": m(
    { server: Schema.String, plugin: optionalKey(Id) },
    S({ tools: Schema.Array(S({ name: Schema.String, description: optionalKey(Schema.String) })), idle_tokens_estimate: Count }),
  ),
  /**
   * Servers Claude Agent leaves out of new chats: Claude Code holds a chat's first turn until each server connects or
   * gives up after 30 seconds, and these gave up at a chat's start. `server` is the key mcp.tools takes; `at`, when
   * it last did; `until`, when new chats try it again on their own (sooner if a check finds it answering). One whose
   * command, arguments or URL changed is tried again at once.
   */
  "mcp.skipped": m({}, S({ servers: Schema.Array(S({ server: Schema.String, at: IsoDateTime, until: IsoDateTime })) })),
  /** Tries a skipped server again at the next chat's start. */
  "mcp.retry": m({ ...req, server: Schema.String }, S({})),
  /** Automations (files and the app's scheduled tasks), soonest first; with `project_id`, that project's only. */
  "automation.list": m({ project_id: optionalKey(Id) }, S({ automations: Schema.Array(Automation) })),
  /** Checks the project's automation and agent files; `files` (unsaved editor text) override those on disk. */
  "automation.check": m(
    { project_id: Id, files: optionalKey(Schema.Array(AutomationSourceFile)) },
    S({ diagnostics: Schema.Array(AutomationDiagnostic) }),
  ),
  /** What will happen when it runs here, as rows and as the text `caveman-runtime automation explain` prints. */
  "automation.explain": m(
    { project_id: Id, name: Schema.String, scope: AutomationScope, step: optionalKey(Schema.String) },
    S({ explanation: AutomationExplanation, text: Schema.String }),
  ),
  /** The templates gallery. */
  "automation.templates": m({}, S({ templates: Schema.Array(AutomationTemplateSummary) })),
  /** Writes a template's files, or an automation file from `text`, into the project (`written`: repo-relative paths). */
  "automation.create": m(
    {
      ...req,
      project_id: Id,
      scope: AutomationScope,
      from: Schema.Union([S({ template: Schema.String }), S({ text: Schema.String, name: Schema.String })]),
    },
    S({ automation: Automation, written: Strings, renamed: optionalKey(Schema.Array(S({ from: Schema.String, to: Schema.String }))) }),
  ),
  /** An automation or agent file of the project. */
  "automation.file_read": m({ project_id: Id, path: AutomationFilePath }, S({ text: Schema.String })),
  /** Saves an automation or agent file, even with errors (like an editor), and answers with what check finds. */
  "automation.file_write": m(
    { ...req, project_id: Id, path: AutomationFilePath, text: Schema.String },
    S({ diagnostics: Schema.Array(AutomationDiagnostic) }),
  ),
  /**
   * Creates or (with `id`) replaces an automation. A webhook trigger's
   * `secret` turns on an HMAC-SHA256 check of the body (`signature_header`,
   * default x-hub-signature-256, hex with a `sha256=` prefix); it is never
   * returned. `keep_secret` (an edit, no `secret`) keeps the check with the
   * stored secret; a webhook trigger with neither turns the check off.
   * A github_mention trigger runs on comments by this computer's
   * GitHub login only; the comment and its issue reach the prompt.
   */
  "automation.save": m(
    {
      ...req,
      id: optionalKey(Id),
      title: Schema.NonEmptyString,
      prompt: Schema.NonEmptyString,
      enabled: Schema.Boolean,
      trigger: Schema.Union([
        ...TimeTriggers,
        Schema.Struct({
          type: Schema.Literal("webhook"),
          secret: optionalKey(Schema.NonEmptyString),
          keep_secret: optionalKey(Schema.Boolean),
          signature_header: optionalKey(Schema.NonEmptyString),
          /** Absent keeps the stored filters; `[]` clears them. */
          filters: optionalKey(WebhookFilters),
          /** Absent keeps the stored settings; `{}` turns dedupe off. */
          dedupe: optionalKey(WebhookDedupe),
        }),
        Schema.Struct({ type: Schema.Literal("github_mention"), repo: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)) }),
      ]),
      project_id: Id,
      engine: EngineId,
      /** Absent: each run starts on the new-chat default as it is then (its project's, Settings > General, else default_model). */
      model: optionalKey(Schema.NonEmptyString),
      access: optionalKey(AccessMode),
    },
    Automation,
  ),
  "automation.set_enabled": m({ ...req, id: Id, enabled: Schema.Boolean }, Automation),
  /**
   * The person allows a schedule an agent set to run on Cloud (`awaiting_approval`): it starts there now, or takes
   * the agent's change. It spends computer time and credits while nobody watches, so only a person's client allows
   * one; agents have no way to.
   */
  "automation.allow": m({ ...req, id: Id }, Automation),
  /**
   * Changes only which requests start an app-saved webhook automation (`filters`) and its repeat and burst handling
   * (`dedupe`); everything else it stores stays. Absent keeps; `filters: []` clears them, `dedupe: {}` turns it off.
   */
  "automation.set_webhook_rules": m({ ...req, id: Id, filters: optionalKey(WebhookFilters), dedupe: optionalKey(WebhookDedupe) }, Automation),
  "automation.delete": m({ ...req, id: Id }, Empty),
  /**
   * Runs it now, outside its schedule. A file automation takes `inputs` (its `inputs:`); its outputs are a dry
   * run unless `apply` (automation.run_apply writes them later). `run_id` names the run it started.
   */
  "automation.run": m(
    {
      ...req,
      id: Id,
      inputs: optionalKey(Schema.Record(Schema.String, Schema.String)),
      apply: optionalKey(Schema.Boolean),
      /** What the run is about, like a trigger's: `github:<owner>/<repo>#<n>` in this project's repository (its issue or pull request is fetched as the input). */
      subject: optionalKey(Schema.String),
    },
    S({ ...Automation.fields, run_id: optionalKey(Id) }),
  ),
  /**
   * Runs of file automations, newest first; `status`: only the runs in it (the Inbox asks for `waiting`);
   * `agent_runs`: only agent.run's runs (`agent-<name>`, the Automations list's Agent runs).
   */
  "automation.runs": m(
    {
      project_id: optionalKey(Id),
      name: optionalKey(Schema.String),
      scope: optionalKey(AutomationScope),
      status: optionalKey(RunStatus),
      agent_runs: optionalKey(Schema.Literal(true)),
      limit: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
    },
    S({ runs: Schema.Array(AutomationRunSummary) }),
  ),
  "automation.run_get": m({ run_id: Id }, S({ run: AutomationRunRecord })),
  /**
   * Answers a run's approval gate: `approve` lets the step's outputs and the steps after it go on; `reject` fails
   * the step (approval_rejected). Only a step that waits for approval can be answered.
   */
  "automation.approve": m(
    { ...req, run_id: Id, step: Schema.String, decision: Schema.Literals(["approve", "reject"]), message: optionalKey(Schema.String) },
    S({ run: AutomationRunRecord }),
  ),
  /** Stops a run: its steps stop, unapplied outputs are dropped, the branch stays. */
  "automation.run_cancel": m({ ...req, run_id: Id }, Empty),
  /** Writes a manual run's dry-run outputs: all of them, or the one whose `key` is given. */
  "automation.run_apply": m({ ...req, run_id: Id, key: optionalKey(Schema.String) }, S({ outputs: Schema.Array(AutomationRunOutput) })),
  /**
   * Sends the repository's `host: cloud` automations (and the agent files they name) to Caveman Cloud as the person
   * signed in here; Cloud answers with each one's revision and how it moves authority. `repo_root`: a checkout on
   * this computer; else `project_id`'s. Files with errors are refused before anything is sent.
   */
  "automation.apply": m(
    { ...req, repo_root: optionalKey(Schema.String), project_id: optionalKey(Id) },
    S({
      repo: Schema.String,
      commit_sha: Schema.String,
      automations: Schema.Array(CloudAutomationApplied),
      /** Files that stayed here, each with why (a This Mac automation, a Me file). */
      skipped: Schema.Array(S({ path: Schema.String, reason: Schema.String })),
      /** The authority diff in words, as `caveman-runtime apply` prints it. */
      text: Schema.String,
    }),
  ),
  /** The org's Cloud-hosted automations, as Caveman Cloud holds them. */
  "automation.cloud_list": m({}, S({ automations: Schema.Array(CloudAutomation) })),
  /**
   * Answers a Cloud run's approval gate as the person signed in here: Caveman Cloud passes it to the run's session
   * as `user.approval` (allow approves, deny rejects). `session_id` from automation.cloud_runs; else it is looked up.
   */
  "automation.cloud_answer": m(
    { ...req, run_id: Id, session_id: optionalKey(Id), ask_id: Id, decision: Schema.Literals(["allow", "deny"]), message: optionalKey(Schema.String) },
    Empty,
  ),
  /** Runs of the org's Cloud-hosted automations (all, or one automation's), newest first, from Caveman Cloud. */
  "automation.cloud_runs": m(
    { automation_id: optionalKey(Id), limit: optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))) },
    S({ runs: Schema.Array(CloudAutomationRun) }),
  ),
  /**
   * Publishes an agent file (`.caveman/agents/<name>.md`, repo-relative with `project_id`, or absolute) to the org's
   * Caveman Cloud as a new version; the same text again keeps the version (`unchanged`). The file is checked first.
   */
  "agent.publish": m(
    { ...req, path: Schema.String, project_id: optionalKey(Id) },
    S({ agent_id: Id, name: Schema.String, version: Count, unchanged: Schema.Boolean }),
  ),
  /** The org's agents on Caveman Cloud, each with its newest version. */
  "agent.published": m({}, S({ agents: Schema.Array(CloudAgent) })),
  /** A new secret token in a webhook automation's URL; the old URL stops working at once. */
  "automation.rotate_url": m({ ...req, id: Id }, Automation),
  /** A webhook automation's recent requests, newest first: what happened to each, never its body. */
  "automation.deliveries": m(
    { id: Id },
    S({
      deliveries: Schema.Array(
        S({
          id: Id,
          received_at: IsoDateTime,
          outcome: Schema.String,
          error: Schema.NullOr(Schema.String),
          /** File automations: what happened, as data (outcome stays a sentence for older clients). */
          status: optionalKey(Schema.Literals(["started", "refused", "skipped"])),
          reason: optionalKey(Schema.String),
          run_id: optionalKey(Id),
          /** e.g. issues.labeled, schedule. */
          event: optionalKey(Schema.String),
          subject: optionalKey(Schema.String),
          subject_title: optionalKey(Schema.String),
        }),
      ),
    }),
  ),
  /** Connectors the hub offers (GitHub, Linear, Sentry, Notion, Slack) and whether each is connected. */
  "connector.list": m({}, S({ connectors: Schema.Array(ConnectorInfo) })),
  /**
   * Connects a connector (adding it to the user's servers first) or signs in
   * to any of the user's servers that signs in, by name. An OAuth server
   * answers `signing_in` with `authorization_url` for the client to open in
   * the person's browser. Unlinked, the runtime takes the redirect on a
   * loopback port and keeps the tokens; signed in to Caveman Cloud (and on
   * every Cloud computer) the page is Cloud's, Cloud keeps the tokens and the
   * runtime's hub leases them. mcp.list and connector.list show `connected`
   * once it is; `needs_sign_in` with a `problem` means reconnect.
   */
  "connector.connect": m(
    /** `move_to_cloud`: a sign-in only this Mac holds is made again with Caveman Cloud, then this Mac's copy is forgotten. */
    { ...req, id: Schema.String, move_to_cloud: optionalKey(Schema.Boolean) },
    S({
      status: Schema.Literals(["connected", "needs_sign_in", "signing_in", "error"]),
      authorization_url: optionalKey(Schema.String),
      problem: optionalKey(Schema.String),
    }),
  ),
  /** Forgets a server's sign-in (its tokens and client registration). The server stays (mcp.remove removes it). */
  "connector.disconnect": m({ ...req, id: Schema.String }, S({})),
  /** Adds what mcp.import_scan offers (only `names` when given) as personal servers. */
  "mcp.import": m({ ...req, names: optionalKey(Strings) }, S({ added: Strings, skipped: Schema.Array(McpImportCandidate) })),
  /** Skills every engine can load, with the engines that load each. Reads files; changes nothing. */
  "skill.list": m({}, S({ skills: Schema.Array(SkillInfo) })),
  /** A skill's SKILL.md, for a path skill.list lists. */
  "skill.read": m({ path: Schema.String }, S({ markdown: Schema.String })),
  /**
   * Writes a SKILL.md, every engine loading it from the next chat: into my
   * skills (`me`: ~/.agents/skills/<name>), a project's (`project`:
   * <repo>/.agents/skills/<name>) or a plugin of a folder marketplace
   * (`plugin`: its skills/<name>). `path` (a skill skill.list lists there)
   * changes that skill in place; without it the skill is new and `name` must
   * be lowercase words joined by hyphens (at most 64). Text holding a stored
   * secret is secret_in_input.
   */
  "skill.save": m(
    {
      ...req,
      scope: Schema.Literals(["me", "project", "plugin"]),
      project_id: optionalKey(Id),
      plugin_id: optionalKey(Id),
      name: Schema.NonEmptyString,
      markdown: Schema.NonEmptyString,
      path: optionalKey(Schema.String),
    },
    S({ name: Schema.String, path: Schema.String, markdown: Schema.String }),
  ),
  /** Instruction files each engine reads, at home and in every project (only `project_id`'s when given; an unknown one is not_found). Reads files; changes nothing. Owner only. */
  "rule.list": m({ project_id: optionalKey(Id) }, S({ rules: Schema.Array(RuleInfo) })),
  /**
   * A rule file rule.list lists; "" when it does not exist yet. `redacted`: it holds a stored secret, shown
   * as `[secret:NAME]`; rule.save refuses such a file (invalid_state), so the hidden text never replaces the value.
   */
  "rule.read": m({ path: Schema.String }, S({ text: Schema.String, redacted: Schema.Boolean })),
  /**
   * Writes (or creates) a rule file rule.list lists, in place; any other path is not_found. Owner only, as
   * secret.* (forbidden otherwise); text holding a secret is secret_in_input; at most 1 MiB.
   */
  "rule.save": m({ ...req, path: Schema.String, text: Schema.String }, RuleInfo),
  /**
   * What Claude Code, Codex and Cursor on this computer have that Caveman can
   * bring in: marketplaces, enabled plugins, skills, MCP servers and
   * instruction files, each with what importing does. Reads; never writes,
   * never reads a secret value.
   */
  "import.scan": m({}, S({ sources: Schema.Array(ImportSource) })),
  /** Imports the items import.scan listed. */
  "import.apply": m(
    { ...req, items: Schema.Array(ImportItemRef) },
    S({ imported: Count, failed: Schema.Array(S({ ref: ImportItemRef, reason: Schema.String })) }),
  ),
  /**
   * Brings in a folder, no git needed: a marketplace becomes a folder
   * marketplace, a plugin joins your personal marketplace, a skills folder or
   * a SKILL.md becomes your skills. Without `confirm` it only answers
   * `preview`: what the folder would bring (skills, MCP servers with their
   * commands, hooks, rules). With `confirm` it imports and answers `added`:
   * the marketplace name, plugin id or skill names. Symlinks and key or env
   * files in a skill are never copied.
   */
  "import.folder": m(
    { ...req, path: Schema.NonEmptyString, confirm: optionalKey(Schema.Boolean) },
    S({
      kind: Schema.Literals(["plugin", "marketplace", "skills"]),
      added: optionalKey(Schema.String),
      preview: S({
        name: Schema.String,
        skills: Strings,
        mcp_servers: Schema.Array(S({ name: Schema.String, plugin: optionalKey(Schema.String), command: optionalKey(Schema.String), args: optionalKey(Strings), url: optionalKey(Schema.String) })),
        hooks: Schema.Array(S({ event: Schema.String, plugin: optionalKey(Schema.String), command: optionalKey(Schema.String) })),
        rules: Strings,
      }),
    }),
  ),
  /**
   * Record a skill: the session becomes a SKILL.md (Claude skill format),
   * written where skill.save writes. Written by the Caveman engine with the
   * user's key; without one, engine_unavailable.
   */
  "skill.record": m(
    {
      ...req,
      ...ses,
      scope: Schema.Literals(["me", "project", "plugin"]),
      project_id: optionalKey(Id),
      plugin_id: optionalKey(Id),
      name: optionalKey(Schema.String),
      note: optionalKey(Schema.String),
    },
    S({ name: Schema.String, path: Schema.String, markdown: Schema.String }),
  ),
  /** Repositories this runtime knows: ones workspaces used, plus configured roots. Newest first. */
  "repo.list": m(
    {},
    S({
      repos: Schema.Array(
        S({
          path: Schema.String,
          name: Schema.String,
          remote_url: optionalKey(Schema.String),
          default_branch: optionalKey(Schema.String),
          last_used_at: optionalKey(IsoDateTime),
        }),
      ),
    }),
  ),
  /**
   * Every project not removed, oldest first, archived ones too (Project.archived_at). Reads stored rows and each
   * checkout's git config; never runs git.
   */
  "project.list": m({}, S({ projects: Schema.Array(Project) })),
  /**
   * The project's local branches a new chat can start from (workspace.create's `base_ref`): the branch its checkout
   * is on first (`current`), then the default branch, then the rest, last committed first. `query` keeps the names
   * that contain it, any case; at most 50, `more` when others match. `checkout`: the branch a chat starts from when
   * none is picked ("HEAD" when detached). No branches and no `checkout` for a `no_git` project.
   */
  "project.branches": m(
    { project_id: Id, query: optionalKey(Schema.String) },
    S({
      checkout: optionalKey(Schema.String),
      branches: Schema.Array(S({ name: Schema.String, current: optionalKey(Schema.Literal(true)), default: optionalKey(Schema.Literal(true)) })),
      more: Schema.Boolean,
    }),
  ),
  /**
   * Repositories worth adding, best first: ones Claude Code and Codex sessions
   * ran in, folders Cursor and VS Code opened, git checkouts beside them and in the usual code folders, and the
   * user's GitHub repositories (when this computer has a GitHub login). A
   * repository on GitHub and on disk is one candidate with both. Cached
   * briefly and warmed at startup; `refresh` rescans.
   */
  "project.discover": m(
    { refresh: optionalKey(Schema.Boolean) },
    S({
      candidates: Schema.Array(ProjectCandidate),
      /** Where project.create clones a repository given by `url`. */
      clone_dir: Schema.String,
      /**
       * Still looking: the scan ran out of time (a busy or slow computer) and a longer one runs. `candidates` is what
       * was found so far; ask again shortly for more. Absent: this is the whole answer.
       */
      searching: optionalKey(Schema.Boolean),
    }),
  ),
  /**
   * Adds a git repository as a project. Exactly one of `path` (any folder
   * inside a repository on this computer, or a folder in none, which becomes
   * a `no_git` project; a file stands for the folder it is in), `url` (a git URL, a web URL or owner/name on GitHub)
   * or `new_folder: true` (makes the empty folder ~/Caveman/new-project, or new-project-2, new-project-3 ... the first
   * name not already on disk, never touching one that is, and adds it as a `no_git` project; `name` still names the
   * project). A `url` whose repository already has a checkout
   * here (a project, or one project.discover found) adds that checkout;
   * otherwise it is cloned into clone_dir. Adding a repository that already
   * has a project returns that project; one removed before comes back.
   */
  "project.create": m(
    { ...req, path: optionalKey(Schema.String), url: optionalKey(Schema.String), new_folder: optionalKey(Schema.Boolean), name: optionalKey(Schema.NonEmptyString) },
    Project,
  ),
  /**
   * Brings in the project's past Claude Code and Codex sessions as chats: those from the last 30 days that ran in its
   * folder, up to their last 200 messages each, each with its own session's title and times. Each one runs in the
   * folder itself (no worktree or branch) and continues its own session natively on the next message. Sessions it
   * imported before, or that a chat here already runs, are not imported again (`already`); `skipped` counts those
   * it could not read or resume, or that ran past the scan's limits. Answered once they are all in.
   */
  "project.import_chats": m({ ...req, project_id: Id }, S({ imported: Count, already: Count, skipped: Count })),
  /**
   * Each key present replaces that field; an empty `instructions` or `ignorePaths`, or a null `default_access`, clears it.
   * `default_models` replaces the engines it names; a null model clears that engine's.
   */
  /**
   * Each key present replaces that field; an empty `instructions`, `ignorePaths` or `actions`, or a null `default_access`, clears it. Action ids are unique.
   * `pinned` and `archived` pin or archive the project (true) or undo it (false); the runtime stamps pinned_at and
   * archived_at, and pinning or archiving again keeps the first time. Archiving keeps its chats, settings and files.
   * `logo`: "auto" (the default) shows what the runtime finds in the checkout, "none" the folder, and an image the
   * person's pick, already drawn small by the client: a `data:image/png;base64,` URL of a PNG of at most 64 KiB.
   * `path` is the checkout file it was drawn from, if any: the runtime notes that file's bytes, so the picker can say
   * which candidate is the logo while the file is unchanged.
   */
  "project.update": m(
    {
      ...req,
      project_id: Id,
      name: optionalKey(Schema.NonEmptyString),
      instructions: optionalKey(Schema.String),
      ignorePaths: optionalKey(Strings),
      default_access: optionalKey(Schema.NullOr(AccessMode)),
      default_models: optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
      actions: optionalKey(Schema.Array(ProjectAction)),
      pinned: optionalKey(Schema.Boolean),
      archived: optionalKey(Schema.Boolean),
      logo: optionalKey(Schema.Union([Schema.Literals(["auto", "none"]), S({ url: Schema.String, path: optionalKey(Schema.String) })])),
    },
    Project,
  ),
  /**
   * Images in the project's checkout worth using as its logo, best first, at most 12: the one `logo: "auto"` shows,
   * the other favicons and icons where web apps keep them, tracked files named like a logo, icon, favicon, mark,
   * brand or mascot (outside dependencies, builds, tests and vendored code), then the GitHub owner's avatar. Only
   * formats a browser draws (svg, png, jpg, webp, gif, ico), each at most 256 KiB.
   */
  "project.logo.candidates": m({ project_id: Id }, S({ candidates: Schema.Array(ProjectLogoCandidate) })),
  /**
   * The image of the project's logo (Project.logo): its `id` and a `data:` URL of at most 64 KiB. Open as project.list
   * is; not_found while the project shows its folder.
   */
  "project.logo.read": m({ project_id: Id }, S({ id: Schema.String, url: Schema.String })),
  /**
   * A chat's Actions tab, read from its own checkout each time, so an
   * action an agent adds on the branch shows in that chat: `run` is
   * [run].command from .caveman/computer.toml, `repo` the tables of
   * .caveman/actions.toml in file order, `personal` the project's own
   * (Project.actions). `suggestions`: package.json scripts that no action
   * runs yet, with the lockfile's package manager. `error`: why
   * actions.toml was not read, with its line.
   */
  "actions.list": m(
    ws,
    S({
      actions: Schema.Array(S({ ...ProjectAction.fields, source: Schema.Literals(["run", "repo", "personal"]) })),
      suggestions: Schema.Array(S({ name: Schema.String, command: Schema.String })),
      error: optionalKey(Schema.String),
    }),
  ),
  /**
   * Takes a project off the list. Its files and archived workspaces stay
   * (restoring one brings the project back). While any workspace in it is not
   * archived, this fails with invalid_state, unless `archive_chats`: then each
   * is archived first, as workspace.archive does.
   */
  "project.remove": m({ ...req, project_id: Id, archive_chats: optionalKey(Schema.Boolean) }, Empty),
  /**
   * Makes a `no_git` project's folder a git repository: git init, then one
   * commit of its files (what a .gitignore there leaves out stays out). Its
   * new chats then get their own worktree and branch; chats already running
   * in the folder stay there. invalid_state for a project that has git.
   */
  "project.init_git": m({ ...req, project_id: Id }, Project),
  /**
   * Adds a repository (`owner/name` on GitHub, `host/owner/name`, or a git
   * URL) to the project's `repos`, so the project's plugins reach it. In
   * Caveman Cloud a repository belongs to at most one project: one already in
   * another is invalid_state.
   */
  "project.add_repo": m({ ...req, project_id: Id, repository: Schema.NonEmptyString }, Project),
  /** Takes a repository out of the project's `repos`; its own repository stays. */
  "project.remove_repo": m({ ...req, project_id: Id, repository: Schema.NonEmptyString }, Project),
  /**
   * Adds a source to the project (Project.sources). Exactly one of `repository` (as project.add_repo takes it: the
   * repository joins `repos` too, so in Caveman Cloud it belongs to this project and no other) or `path`: a folder
   * on this Mac. A `path` inside a git checkout adds that checkout's repository and remembers the checkout as where
   * it sits here (a checkout with no origin on a git host is kept on this Mac only); a `path` in no repository adds
   * a plain folder, on a Mac only. `focus`: the part of a repository the project is about, from its top level.
   * A source the project already has answers the project with its `focus` and checkout updated.
   */
  "project.add_source": m(
    { ...req, project_id: Id, repository: optionalKey(Schema.NonEmptyString), path: optionalKey(Schema.NonEmptyString), focus: optionalKey(Schema.String) },
    Project,
  ),
  /** Takes a source out of the project by its name (and its repository out of `repos`); its own repository or folder stays. Chats that work in it keep their checkout. */
  "project.remove_source": m({ ...req, project_id: Id, name: Schema.NonEmptyString }, Project),
  /**
   * GitHub as this runtime sees it: Caveman Cloud's leased GitHub login when signed in and connected there, else this
   * computer's `gh` login or GH_TOKEN (This Mac only). `login` is the GitHub username, null when there is no login
   * anywhere or GitHub refused it; `problem` then says what to do. The token itself never leaves the runtime.
   */
  "github.status": m(
    {},
    S({
      login: Schema.NullOr(Schema.String),
      source: Schema.NullOr(GitHubLoginSource),
      problem: optionalKey(Schema.String),
    }),
  ),
  /**
   * The project's repository's open issues on github.com, newest first, pull requests left out, read with the login
   * github.status names. `limit` defaults to 10, at most 30. A project with no GitHub remote, or a runtime with no
   * GitHub login, answers an empty list.
   */
  "github.issues": m({ project_id: Id, limit: optionalKey(Count) }, S({ issues: Schema.Array(GitHubIssue) })),
  /**
   * Connects GitHub to Caveman Cloud: `url` is the page to open in the browser, and github.status reports
   * `source: "cloud"` once the person is done there. Not signed in to Caveman Cloud: invalid_state.
   */
  "github.connect": m({ ...req }, S({ url: Schema.String })),
  /**
   * Git on this computer, which adding a project, cloning and every chat's worktree need: `ready` and its `version`,
   * else `problem` (what is wrong, in the person's words) and `install` (a page to open, a command to run, or `runs`
   * when git.install starts it). A Mac without Apple's Command Line Tools has only a stub that asks to install them; a
   * Windows without Git for Windows has no git, nor the bash Claude Code and the Caveman engine run commands in.
   */
  "git.installed": m(
    {},
    S({
      ready: Schema.Boolean,
      version: optionalKey(Schema.String),
      problem: optionalKey(Schema.String),
      install: optionalKey(S({ label: Schema.String, url: optionalKey(Schema.String), command: optionalKey(Schema.String), runs: optionalKey(Schema.Boolean) })),
    }),
  ),
  /** Starts git.installed's `install` when it `runs`: on a Mac, Apple's Command Line Tools installer, which then asks the person. Anything else is invalid_state. */
  "git.install": m({ ...req }, Empty),
  /**
   * The "Caveman version" of one assistant message: the same content rewritten
   * short in caveman speak, by a cheap side request. Not written to the session.
   */
  /** The repository's secrets: names and metadata, never values. */
  "secret.list": m(
    { repo: Repo },
    S({
      repository: Schema.String,
      secrets: Schema.Array(SecretInfo),
      /** Its values are available on Cloud computers (cloud.secrets.set_available). Absent, with no `cloud_names`: they stay here. */
      cloud_available: optionalKey(Schema.Boolean),
      /**
       * Without `cloud_available`: the names whose values are available on Cloud computers all the same, opted in one
       * by one (cloud.secrets.set_available with `names`); the others stay here.
       */
      cloud_names: optionalKey(Strings),
    }),
  ),
  /**
   * The repository key is pinned at first use; when the checkout's origin
   * later names another repository the runtime withholds its secrets
   * (`invalid_state`) rather than hand them to whatever the origin now says.
   * The person accepts the new origin here.
   */
  "secret.repin": m({ ...req, repo: Repo }, S({ repository: Schema.String })),
  /**
   * Stores secrets (replacing same-named ones). The only method that carries
   * a value; it is never echoed back, logged, or kept in the request record.
   */
  "secret.set": m(
    {
      ...req,
      repo: Repo,
      secrets: Schema.Array(S({ name: SecretName, value: Schema.NonEmptyString })).check(Schema.isMinLength(1)),
    },
    S({ secrets: Schema.Array(SecretInfo) }),
  ),
  "secret.delete": m({ ...req, repo: Repo, name: SecretName }, Empty),
  /**
   * Git-ignored `.env*` files at a local repository's top level holding names
   * it has not stored yet. Names only; empty for a repository given by URL.
   */
  "secret.env_files": m({ repo: Repo }, S({ files: Schema.Array(S({ path: Schema.String, names: Strings })) })),
  /**
   * Stores the assignments of one file secret.env_files listed; the runtime reads it, the client never does.
   * `names` limits it to the names the person reviewed; without it, every assignment.
   */
  "secret.import": m({ ...req, repo: Repo, path: Schema.String, names: Schema.optional(Strings) }, S({ secrets: Schema.Array(SecretInfo) })),
  "message.caveman_version": m({ ...ses, item_id: Id }, S({ text: Schema.String })),
  /**
   * Settings -> Spend. Only measured figures come from usage events; inferred
   * (what it would have cost without Caveman) and verified (an A/B on the
   * user's own work) are separate and null until measured. Never a guess.
   */
  "memory.status": m({}, MemoryStatus),
  /** Notes in force and drafts, newest first; with a project, its notes and the user's. */
  "memory.list": m({ query: optionalKey(Schema.String), project_id: optionalKey(Id) }, S({ notes: Schema.Array(MemoryNote) })),
  /** Every version of a note, newest first. */
  "memory.history": m({ id: Id }, S({ versions: Schema.Array(MemoryNote) })),
  /** A note the user wrote or edited: it is Told. A project note needs project_id. */
  "memory.put": m(
    { ...req, id: optionalKey(Id), text: Schema.NonEmptyString, scope: Schema.Literals(["me", "project"]), project_id: optionalKey(Id), name: optionalKey(Schema.String) },
    MemoryNote,
  ),
  /** A new version with no text: the note leaves every brief and copy; memory.undo brings it back. */
  "memory.forget": m({ ...req, id: Id }, Empty),
  /** Back to the version before the latest (a forget comes back, an edit goes back), as a new version. */
  "memory.undo": m({ ...req, id: Id }, S({ note: Schema.NullOr(MemoryNote) })),
  /** A pinned note is in every brief of its scope, whatever its authority. */
  "memory.pin": m({ ...req, id: Id, pinned: Schema.Boolean }, MemoryNote),
  /** Keep a tainted note: it may reach a brief again. */
  "memory.keep": m({ ...req, id: Id }, MemoryNote),
  /** Erase for good: every version goes. */
  "memory.erase": m({ ...req, id: Id }, Empty),
  /** The one-time import of Claude Agent's own memories, as drafts: none reaches a brief until the user pins or edits it. */
  "memory.import": m({ ...req, source: Schema.Literal("claude") }, S({ imported: Count, skipped: Count })),
  "spend.summary": m(
    {
      from: optionalKey(IsoDateTime),
      to: optionalKey(IsoDateTime),
      /** automation: each automation's runs (their step and check threads), the rest under "none". */
      group_by: Schema.Literals(["workspace", "engine", "model", "day", "project", "automation"]),
    },
    S({
      rows: Schema.Array(
        S({
          key: Schema.String,
          label: Schema.String,
          input_tokens: Count,
          output_tokens: Count,
          cache_read_tokens: Count,
          cache_write_tokens: Count,
          /**
           * Web searches in the row; absent when none. An engine's own searches (Claude Agent) are a count only, their
           * price already in the turn's cost; the Caveman engine's are priced in the row: list price on the person's
           * own key (estimated), billed on Caveman credits.
           */
          web_searches: optionalKey(Count),
          /** null when no event carried a cost (a subscription, or a model with no public price). */
          measured_usd: Schema.NullOr(Schema.Number),
          /** Inferred compression saving at list price, never spend on a plan; null when unknown. */
          saved_usd: Schema.NullOr(Schema.Number),
          /** Some measured token deltas had no price. */
          saved_usd_partial: Schema.Boolean,
          saved_tokens: Schema.Number,
          /** plan: a subscription, tokens only; unpriced: per-token, but no public price is known; none: older events that do not say. */
          basis: Schema.Literals(["billed", "list_price", "mixed", "plan", "unpriced", "none"]),
          /** Median time to first token and turn length, over the turns that measured them. */
          p50_ttft_ms: optionalKey(Count),
          p50_turn_ms: optionalKey(Count),
          /**
           * dream: memory dreams (retired 2026-10-17); only spend rows recorded before then carry it.
           * chief: the Chief's own turns (the chats it starts count as chats).
           * web: the Caveman engine's web searches (grouped by engine or project; by workspace they count in
           * their chat's row, `web_searches` saying how many).
           */
          bucket: optionalKey(Schema.Literals(["dream", "chief", "web"])),
        }),
      ),
      saved_usd: Schema.NullOr(Schema.Number),
      saved_usd_partial: Schema.Boolean,
      saved_tokens: Schema.Number,
      verified_usd: Schema.NullOr(Schema.Number),
    }),
  ),

  /**
   * Finished turns as anonymous telemetry, for the desktop app to send when the person has it on
   *. Only this computer's own screen may ask: forbidden otherwise.
   * `since`: when the disclosure naming turn stats showed; turns that started before it are never counted, and a new
   * `since` drops what waited from an older one. `ack`: the highest `seq` delivered; those leave the outbox (asking
   * again with the same `ack` changes nothing). The facts come in `seq` order, the unacknowledged ones again until
   * acknowledged.
   */
  "telemetry.turns": m({ since: IsoDateTime, ack: optionalKey(Count) }, S({ facts: Schema.Array(TurnFact) })),

  /**
   * A Chief (README: The Chief): `chief_id`'s; else one that works in `project_id` (the one with the fewest projects,
   * every project counting as most, then the oldest); else the Chief with the latest activity. With no Chief at all
   * it makes the first, "Chief", in every project; no project is needed. An unknown `project_id`: not_found. Its
   * workspace (kind chief), its profile, whether it can think (`no_key`: no Caveman engine key or credits, so
   * notes are captured but not triaged), and the whole board (every Chief's items, each with its `chief_id`).
   * `picker`: what its model picker offers, from what is connected (the Caveman engine's connected models and
   * Auto; a Claude plan's Claude models, with its quiet route label and tooltip). `model`: its pick
   * (`chief.model`), null on Auto. A `chief_id` that is no Chief's: not_found.
   */
  "chief.get": m(
    { chief_id: optionalKey(Id), project_id: optionalKey(Id) },
    S({
      workspace: Workspace,
      chief: optionalKey(ChiefProfile),
      availability: Schema.Literals(["ready", "no_key"]),
      board: ChiefBoard,
      picker: optionalKey(Schema.Array(S({ engine: Schema.String, models: Schema.Array(Schema.String), label: optionalKey(Schema.String), hint: optionalKey(Schema.String), account_id: optionalKey(Id), tag: optionalKey(Schema.String) }))),
      model: optionalKey(Schema.NullOr(ChiefModelPick)),
      voice: optionalKey(ChiefVoice),
    }),
  ),
  /** Every Chief, oldest first. Makes none: the first is made by chief.get, more by chief.create. */
  "chief.list": m({}, S({ chiefs: Schema.Array(ChiefProfile) })),
  /**
   * A new Chief, with its own workspace and an empty board, working in `project_ids` (each one of project.list:
   * not_found otherwise; none: every project). No project is needed. `project_id`, from older clients, reads as
   * `[project_id]`. Unset fields take defaults: the first free name of a short list (then "Chief N"), the first
   * character of the cast no Chief uses, no role, Auto, the permissions new chats take (access null), and a starter
   * soul. A name another Chief has (trimmed, any case) is invalid_state, on chief.update too. `role`: one line of at
   * most 140 characters (invalid_params past that); empty is none.
   */
  "chief.create": m(
    {
      ...req,
      name: optionalKey(Schema.NonEmptyString),
      avatar: optionalKey(ChiefAvatar),
      role: optionalKey(Schema.String),
      soul: optionalKey(Schema.String),
      project_ids: optionalKey(Schema.Array(Id)),
      project_id: optionalKey(Id),
    },
    S({ chief: ChiefProfile }),
  ),
  /**
   * Your edit of a Chief's profile: each key present replaces that field (`model: null` is Auto, `access: null` the
   * permissions new chats take). A new name renames its workspace. A new soul, role or project list reaches its next
   * turn. `project_ids`: each one of project.list (not_found otherwise); empty is every project. `role`: one line of
   * at most 140 characters; empty clears it.
   */
  "chief.update": m(
    {
      ...req,
      chief_id: Id,
      name: optionalKey(Schema.NonEmptyString),
      avatar: optionalKey(ChiefAvatar),
      model: optionalKey(Schema.NullOr(ChiefModelPick)),
      access: optionalKey(Schema.NullOr(AccessMode)),
      project_ids: optionalKey(Schema.Array(Id)),
      role: optionalKey(Schema.String),
      soul: optionalKey(Schema.String),
      /** null: back to Settings.chief_autonomy. Reaches its next turn. */
      autonomy: optionalKey(Schema.NullOr(ChiefAutonomyLevel)),
      /** null: back to Settings.chief_updates. Its gate changes at once; its prompt at its next turn. */
      updates: optionalKey(Schema.NullOr(ChiefUpdates)),
    },
    S({ chief: ChiefProfile }),
  ),
  /**
   * Removes any Chief: each of its open and running items moves to another Chief that works in the item's project (as
   * chief.get picks one), else to the Chief with the latest activity (a note it never sorted, for that Chief to sort;
   * a draft goes back to the Queue to be drafted again; running work keeps its chats); its own turn stops and its
   * workspace is archived. The last Chief with open items is refused (invalid_state): its missions need somewhere to
   * go. The last with none goes.
   */
  "chief.remove": m({ ...req, chief_id: Id }, Empty),
  /**
   * A note for the Chief. It lands on the Queue at once (`unsorted`) and never
   * waits on a model. decide: the Chief triages it; notes sent while it works
   * join its running turn. queue: queued as is, no model call. start: the Chief
   * starts it without asking (its limits still hold). With availability
   * `no_key` every mode only captures.
   */
  "chief.capture": {
    /**
     * `chief_id`: whose board it lands on; else a Chief that works in `project_id`, as chief.get picks it; with
     * neither, one that works in the project the note points at (its words, a path in it, the chat on screen; else
     * the project with the latest chat activity), else the Chief with the latest activity. Picked in code, with no
     * model call.
     */
    /**
     * `text`: the note's words; empty only beside an image (the item then reads "An image").
     * `attachments`: images with the note (inline, as turn.submit takes them); the Chief sees them and can hand them to the chats it starts.
     * `showing`: the worker chat on the person's screen as they typed (its id); the runtime names it and its project to the Chief, the same
     * signal a call's `showing:` line carries, so "that"/"this"/"it" and the project can be read from it.
     */
    params: S({ ...req, chief_id: optionalKey(Id), project_id: optionalKey(Id), text: Schema.String, source: optionalKey(ChiefItemSource), mode: Schema.Literals(["decide", "queue", "start"]), attachments: optionalKey(Schema.Array(Attachment)), showing: optionalKey(Schema.Struct({ workspace_id: Id })) }).check(
      Schema.makeFilter((p) => p.text.trim() !== "" || (p.attachments?.length ?? 0) > 0 || "a note needs words or an image"),
    ),
    result: S({ item: ChiefItem }),
  },
  /**
   * Adds a chat you started yourself to a Chief's board (`chief_id` absent: a Chief that works in its project, as chief.get picks it), as a started item
   * titled from the chat: from then the Chief hears its updates and can message and answer it as one it started.
   * The same chat again on the same board answers its item; refused (invalid_state) for a chat on another Chief's
   * board, an archived chat, or a chat outside the Chief's projects; not_found for a Chief's own chat.
   */
  "chief.attach": m({ ...req, chief_id: optionalKey(Id), workspace_id: Id }, S({ item: ChiefItem })),
  /**
   * Who manages a group (ChiefProfile.topics): `chief_id`'s from now on (taken from whichever Chief had it), or no one
   * (null). New chats in it go on that Chief's board as they join it. `hand_over`: chats already in it to take too (the
   * ones the app listed for the person), each as chief.attach would take it, but a chat on any board already stays
   * there, one outside the Chief's projects stays the person's, and one not in the group is skipped. `handed`: the chats
   * that went. Every Chief, as chief.list.
   */
  "chief.manage": m(
    { ...req, topic: TopicName, chief_id: Schema.NullOr(Id), hand_over: optionalKey(Schema.Array(Id)) },
    S({ chiefs: Schema.Array(ChiefProfile), handed: Schema.Array(Id) }),
  ),
  "chief.items.list": m({}, S({ items: Schema.Array(ChiefItem) })),
  /**
   * Your edit of an item: each key present replaces that field (`not_before:
   * null` clears it). `state` takes queued (back from blocked or proposed),
   * done or dropped; starting is chief.start.
   */
  "chief.items.update": m(
    {
      ...req,
      item_id: Id,
      text: optionalKey(Schema.NonEmptyString),
      title: optionalKey(Schema.String),
      pinned: optionalKey(Schema.Boolean),
      /** What proves it done, trimmed, at most 280 characters; empty clears it. */
      done_when: optionalKey(Schema.String.check(Schema.isMaxLength(280))),
      /** How often its Chief looks in; null clears the pace. */
      check_in: optionalKey(Schema.NullOr(Schema.Literals(["day", "week"]))),
      project_ids: optionalKey(Schema.Array(Id)),
      not_before: optionalKey(Schema.NullOr(IsoDateTime)),
      state: optionalKey(Schema.Literals(["queued", "done", "dropped"])),
      /** How much you hear about this item's chats; null: its Chief's level. */
      updates: optionalKey(Schema.NullOr(ChiefUpdates)),
    },
    ChiefItem,
  ),
  /** Deletes an item for good; its chats keep running. */
  "chief.items.remove": m({ ...req, item_id: Id }, Empty),
  /** Moves an item before another (`null`: to the end) and pins it there. */
  "chief.items.reorder": m({ ...req, item_id: Id, before_item_id: Schema.NullOr(Id) }, S({ items: Schema.Array(ChiefItem) })),
  "chief.change_sets.list": m({}, S({ change_sets: Schema.Array(ChiefChangeSet) })),
  /**
   * Start these items now (Start all on a Suggested card, ⌘Enter on an item):
   * you approved, so only the concurrency limit and the daily cap can still
   * hold one back (blocked). An item with no chat drafted yet goes to the
   * Chief to start.
   */
  "chief.start": m({ ...req, item_ids: Schema.Array(Id).check(Schema.isMinLength(1)) }, S({ items: Schema.Array(ChiefItem) })),
  /**
   * Calls (README: The Chief, Calls). Start one: the runtime checks it is yours, the voice engine has a key, today's
   * limit is not reached and no call is on (busy), then answers how to connect. Nothing is billed until the client
   * connects. `answer`: the ring back you are answering (chief.voice.ringing), so the Chief leads with it.
   * Refusals: forbidden, invalid_state (no key, the cap, busy, or not_offered: Caveman Cloud doesn't offer voice on
   * credits yet; the message starts with which), engine_unavailable (the voice engine could not be reached or refused,
   * its message scrubbed).
   */
  "chief.voice.start": m(
    /**
     * `chief_id`: which Chief to call; absent, the one chief.get picks with nothing named, the Chief with the latest
     * activity (an answered ring back calls the Chief that rang).
     */
    { ...req, device: Schema.NonEmptyString, answer: optionalKey(Id), chief_id: optionalKey(Id) },
    S({ call: VoiceCall, connect: VoiceConnect }),
  ),
  /**
   * The voice engine's JSON messages, in the order it sent them (`seq` counts from 0 per call), from the client that
   * holds the call; `request_id` names the call and seq, so a resend is answered once. `send`: messages for the
   * engine, to send now, in order.
   */
  "chief.voice.signal": m({ ...req, call_id: Id, seq: Count, events: Schema.Array(Schema.Unknown) }, S({ send: Schema.Array(Schema.Unknown) })),
  /** Mute or unmute (the client stops sending your voice; the Chief is told you stepped away). */
  "chief.voice.update": m({ ...req, call_id: Id, muted: Schema.Boolean }, S({ call: VoiceCall })),
  /** Hang up. `reason` connection_lost or provider when the client lost the engine; else person. */
  "chief.voice.end": m({ ...req, call_id: Id, reason: optionalKey(Schema.Literals(["person", "connection_lost", "provider"])) }, S({ call: VoiceCall })),
  /**
   * The voice engine's key: checked, then kept sealed on this computer (null removes it). Never returned. key_refused:
   * not kept. Where no key is taken (EngineDescriptor.auth.no_sign_in_here) setting one is `unsupported`, before the
   * check; null stays.
   */
  "chief.voice.key": m({ ...req, engine: Schema.String, key: Schema.NullOr(Schema.NonEmptyString) }, ChiefVoice),
  /**
   * Smart View: what this Chief (`chief_id`, else the Chief with the latest activity, as chief.get picks it) has put
   * in the sidebar, as chief.view.updated carries it.
   */
  "chief.view.get": m({ chief_id: optionalKey(Id) }, ChiefView),
  /**
   * The person closed a Smart View tab (`id`, a ChiefView entry's): it stays closed, and the Chief doesn't open it again
   * for a while (smartView.ts SMART_VIEW_RULES.closedCooldownMs) unless the person asks for it.
   */
  "chief.view.dismiss": m({ ...req, chief_id: Id, id: Id }, ChiefView),
  /**
   * Dictation (README: Dictation): talk into any box and the words land in it. Start one: the runtime checks it is
   * yours and the voice engine has a key (the one calls use), then answers how to connect. `workspace_id`: the chat
   * whose box it is, for its spend (absent: a new chat's box). Refusals: forbidden, invalid_state (a message starting
   * `no_key:`, or `not_offered:` while Caveman Cloud doesn't offer voice on credits), engine_unavailable (the voice
   * engine could not be reached or refused, its message scrubbed).
   */
  "dictation.start": m({ ...req, workspace_id: optionalKey(Id) }, S({ dictation_id: Id, connect: DictationConnect })),
  /**
   * Done dictating: `audio_ms` is how much of the mic it streamed, recorded at the engine's list price (never more
   * than the time since it started). An unknown or ended id changes nothing.
   */
  "dictation.end": m({ ...req, dictation_id: Id, audio_ms: Count }, Empty),

  // ----------------------------------------------- Cloud environments (E2)
  /**
   * The project's Cloud setup, through this runtime's Cloud sign-in. `environment` is null for a project with no
   * GitHub remote. `available` is false while signed out, on a Cloud computer, or against a Caveman Cloud without
   * environments; `reason` says which. `builds`: the builds this runtime saw for it, newest first. `fix`: whether
   * Fix it can start a setup chat (it needs a Caveman engine key or credits), else why not.
   */
  "environment.get": m(
    { project_id: Id },
    S({
      environment: Schema.NullOr(Environment),
      available: Schema.Boolean,
      reason: optionalKey(Schema.String),
      builds: optionalKey(Schema.Array(EnvironmentBuild)),
      fix: optionalKey(S({ ok: Schema.Boolean, reason: optionalKey(Schema.String) })),
      setup_chat: optionalKey(SetupChat),
      /** Setup changes agents proposed in chats here, newest first. */
      proposals: optionalKey(Schema.Array(SetupProposal)),
    }),
  ),
  /**
   * A first computer.toml for the project, drafted here with no network and no model: from its lockfiles, pins,
   * CI, devcontainer, compose files and checks, and what this Mac runs for it (tool versions in the login shell,
   * services listening here, env var names in its git-ignored .env files). Names and versions only.
   */
  "environment.draft": m({ project_id: Id }, S({ config: Schema.String, evidence: Schema.Array(EnvironmentEvidence), secret_names: Strings })),
  /** Saves `config` as the repo's Cloud copy (a new version) and starts a build. Refused (invalid_state) when the branch has its own file. */
  "environment.save": m({ ...req, project_id: Id, config: Schema.String, secret_names: optionalKey(Strings) }, S({ environment: Environment, build_id: Id })),
  /**
   * Set it up now (Settings, Environments; a new Cloud chat): a repo nobody set up gets the draft made here saved and
   * built, or a build when its branch has .caveman/computer.toml. One already set up, or building, is left as it is.
   * `evidence`: what the draft was made from, when one was. Refused in Cloud's words (`forbidden`) when the person may
   * not change the repo's Cloud setup.
   */
  "environment.setup": m(
    { ...req, project_id: Id },
    S({ environment: Schema.NullOr(Environment), evidence: optionalKey(Schema.Array(EnvironmentEvidence)) }),
  ),
  /**
   * The person is about to start a Cloud chat in the project (Cloud chosen, or typing with it): its Cloud computer
   * gets ready meanwhile. Background prepare sets the repo up if nobody has, and Cloud keeps a computer standing on
   * its snapshot, so Send claims it instead of restoring one. A hint: at most one Cloud call per project every 20 s,
   * and `warm` false, never an error, when there is nothing to keep warm (no snapshot yet, signed out, no GitHub
   * remote, a Caveman Cloud without warm hints).
   */
  "environment.warm": m({ ...req, project_id: Id }, S({ warm: Schema.Boolean })),
  /**
   * Sets up a repository only on GitHub, with no project and no full clone: the draft comes from a blobless sparse
   * checkout of its manifests (lockfiles, pins, CI, devcontainer, compose) in a temporary directory, with no Mac seed.
   */
  "environment.setup_repo": m(
    { ...req, repo: Schema.NonEmptyString },
    S({ environment: Schema.NullOr(Environment), evidence: optionalKey(Schema.Array(EnvironmentEvidence)) }),
  ),
  /** Every environment of the organization the person may read, with the project here that is each repo. */
  "environment.list": m({}, S({ environments: Schema.Array(EnvironmentSummary), available: Schema.Boolean, reason: optionalKey(Schema.String) })),
  /** Publishes the setup chat's proposal as the repo's Cloud copy, as the person (a save under their push rule), and builds it. */
  /**
   * `build_id` is the proposal's (SetupChat.proposal.build_id) the person reviewed: a fix that changed since is refused
   * `invalid_state`, so what is published is exactly what was looked at.
   */
  "environment.publish": m({ ...req, project_id: Id, build_id: Id }, S({ environment: Environment, build_id: Id })),
  /** Drops the setup chat's proposal; the setup stays as it was. */
  "environment.discard": m({ ...req, project_id: Id }, Empty),
  /** The repo's Cloud-copy versions, newest first (at most 50). */
  "environment.versions": m({ project_id: Id }, S({ versions: Schema.Array(EnvironmentVersion) })),
  /** Saves an earlier version again as the newest, and builds it. */
  /** `base_version`: the Cloud-copy version in use when the person chose; Cloud refuses when a newer one was saved since. */
  "environment.restore": m({ ...req, project_id: Id, version: Count, base_version: optionalKey(Count) }, S({ environment: Environment, build_id: Id })),
  /** Sets a shared build secret for the repo (setup and checks read it at build time); answers the names set. */
  "environment.build_secret.set": m({ ...req, project_id: Id, name: SecretName, value: Schema.String }, S({ names: Strings })),
  "environment.build_secret.delete": m({ ...req, project_id: Id, name: SecretName }, S({ names: Strings })),
  /** CI on the commit the repo's latest build ran, from GitHub; null when it can't be read. */
  "environment.ci": m({ project_id: Id }, S({ ci: Schema.NullOr(EnvironmentCi) })),
  /** Hands a proposal to the setup chat as its ask (a person reviews what it builds before it is saved). */
  "environment.proposal.apply": m({ ...req, project_id: Id, proposal_id: Id }, S({ workspace_id: Id, session_id: Id })),
  "environment.proposal.dismiss": m({ ...req, project_id: Id, proposal_id: Id }, Empty),
  /** The project's proposals, read here only (no Cloud call): what a chat shows under its transcript. */
  "environment.proposals": m({ project_id: Id }, S({ proposals: Schema.Array(SetupProposal) })),
  /** A test build: of `config` when given, else the resolved setup. With `save` and success, `config` becomes the Cloud copy. */
  "environment.build": m({ ...req, project_id: Id, config: optionalKey(Schema.String), save: optionalKey(Schema.Boolean) }, S({ build_id: Id })),
  "environment.build.get": m({ build_id: Id }, EnvironmentBuild),
  /** A build's whole log (at most 1 MiB). */
  "environment.build.log": m({ build_id: Id }, S({ text: Schema.String })),
  /**
   * Fix it, or Ask Caveman to change it (`ask`): starts the project's setup chat, a Caveman-engine chat that may
   * edit only .caveman/computer.toml and run test builds (environment_build), for at most 20 minutes or 5 builds,
   * and proposes the setup once one passes (the person publishes it). A running one is returned as is (`ask` joins it). It is not listed in
   * workspace.list; environment.get names it. Fails `invalid_state` without a Caveman engine key or credits.
   */
  "environment.fix": m({ ...req, project_id: Id, ask: optionalKey(Schema.String) }, S({ workspace_id: Id, session_id: Id })),
  /**
   * Add to repo: a pull request holding only .caveman/computer.toml with the Cloud copy, through the project's source
   * control. With `build_id`: the setup chat's proposal with that build (a repo whose branch owns its file can't take a
   * publish), refused `invalid_state` when the fix changed since.
   */
  "environment.add_to_repo": m({ ...req, project_id: Id, build_id: optionalKey(Id) }, S({ url: Schema.String })),

  // ---------------------------------------------------------------- moves (ADR 0126)
  /**
   * Moves the chat to another computer as the same session, never a fork: `cloud` (a Cloud computer: the one it had,
   * or a new one), `this_mac` (on a Cloud computer, back to the Mac it came from; on This Mac, here), a runtime by id,
   * or one of the person's computers by id (a Cloud computer is woken). Every engine moves: a Claude Agent or Codex
   * chat carries its CLI's own session and runs there on the person's Cloud login for that engine. On the chat's own
   * computer it parks at the turn boundary, copies the last of it to Caveman Cloud and hands it over (`lid`: the lid
   * closed). On This Mac for a chat that moved away, it asks for it back: `pending` until the chat's computer lets it
   * go, then it continues here.
   */
  "session.move": m(
    {
      ...req,
      ...ses,
      to: Schema.Union([Schema.Literals(["cloud", "this_mac"]), S({ runtime_id: Id }), S({ computer_id: Id })]),
      /** `lid`: the lid's own move, from a client on this computer only (forbidden from any other, as cloud.suspend). */
      reason: optionalKey(Schema.Literals(["lid", "user"])),
      /** This device's signature over exactly this move (devices.ts signMove), which a target Mac checks; a Cloud computer ignores it. */
      device: optionalKey(CallDevice),
      /**
       * Continue on This Mac for a chat whose Mac is mid-turn (RESEARCH-W2 decision 32): the same device's signed stop of
       * that turn for this move (devices.ts signStop, naming this request id), which the chat's Mac checks before it stops
       * the turn and lets the chat go at the boundary. Without it, or with one for another move, that Mac waits for the
       * turn to end. A chat at work on a Cloud computer takes the stop on Cloud's word, as it takes the move: its turn
       * stops there (decision 29's "Stop this turn and move").
       */
      stop: optionalKey(S({ request_id: RequestId, device: CallDevice })),
      /**
       * The person said yes to setting aside what changed in this chat's folder on This Mac since it moved away (the
       * answer to `needs_confirmation`): the move goes on, and those changes are kept on `kept_ref` first.
       */
      replace: optionalKey(Schema.Literal(true)),
    },
    S({
      session: Session,
      pending: Schema.Boolean,
      /**
       * Nothing moved: bringing the chat back to This Mac would replace files the person changed in its folder here
       * since it left (uncommitted changes, or commits it left without). `files`: the first of them, `total` how many,
       * `commits` the commits made here since; `kept_ref`: where they are kept once the person says yes. The client asks
       * once and sends the move again with `replace: true`. Absent when nothing changed here: no question.
       */
      needs_confirmation: optionalKey(S({ files: Schema.Array(Schema.String), total: Schema.Number, commits: Schema.Number, kept_ref: Schema.String })),
    }),
  ),
  /**
   * Whether the chat can move to `to`, without moving it: fails with the reason it can't (`invalid_state`; with
   * `data.capability` `engine_login` when a Claude Agent or Codex chat has no Cloud login for its engine there, the
   * fix in the message). `login`: which login its engine runs on there (a key in Caveman Cloud's vault, a sign-in made
   * on that computer, or a sign-in that follows the person to their Cloud computers); null for the Caveman engine, or
   * when Caveman Cloud does not say. `preflight` (agent-continuity.md §7.11's MovePreflight, in part): `work.left`, the
   * secret-shaped files git does not ignore (.env*, *.pem, *.key, id_rsa*, *.tfvars and the like) that stay on the
   * computer the chat leaves, as its last copy found them (decision 24). `context` (decision 28): `native`, its
   * engine's own session resumes there (always, for the Caveman engine); `handoff`, a new session there is handed the
   * conversation (a budgeted selection of whole items, the rest readable with thread_read), `why`: `no_session` (its
   * engine has none of it yet), `over_cap` (its session file grew past what a copy carries), `other_account` (another
   * Mac, whose CLI runs on that Mac's own login). Omitted by a runtime from before them.
   */
  "session.move.check": m(
    { ...ses, to: Schema.Union([Schema.Literals(["cloud", "this_mac"]), S({ runtime_id: Id }), S({ computer_id: Id })]) },
    S({
      login: Schema.NullOr(Schema.Literals(["vault_key", "computer_sign_in", "followed_sign_in"])),
      preflight: optionalKey(
        S({
          work: S({ left: Schema.Array(Schema.String) }),
          context: optionalKey(S({ mode: Schema.Literals(["native", "handoff"]), why: optionalKey(Schema.Literals(["no_session", "over_cap", "other_account"])) })),
        }),
      ),
    }),
  ),
  /** On the computer a chat moved to: rebuilds it from its copy in Caveman Cloud and its work in progress, and continues it here. */
  "session.adopt": m({ ...req, ...ses }, S({ workspace: Workspace, session: Session })),
  /**
   * On This Mac, after a chat came back from Cloud: the agent and tool config Cloud changed (.claude, .mcp.json,
   * .codex, .cursor, .vscode, .idea, .envrc, git config and hooks, CLAUDE.md, AGENTS.md, symlinks) and the
   * secret-shaped files it changed (.env*, keys) that this Mac kept its own versions of until the person applies them.
   * Empty when nothing is held back. `files`: each one as the person reviews it before applying (A-8), this Mac's
   * version against Cloud's, bounded; `commit` names what was held, for apply_held. Omitted by a runtime from before them.
   */
  "session.move.held": m(
    { ...ses },
    S({
      paths: Schema.Array(Schema.String),
      commit: optionalKey(Schema.String),
      files: optionalKey(Schema.Array(HeldFile)),
    }),
  ),
  /**
   * The person's word on This Mac itself (a relayed client is refused): Cloud's versions of the held-back files go into
   * the worktree. `commit`: the one session.move.held showed; a return that held something else since refuses it.
   */
  "session.move.apply_held": m({ ...req, ...ses, commit: optionalKey(Schema.String) }, S({ paths: Schema.Array(Schema.String) })),

  // ---------------------------------------------------------------- the direct path (DESIGN S14)
  /**
   * On a relayed connection to a laptop's runtime whose device the laptop allowed (S13): a WebRTC offer for one
   * reliable, ordered data channel to the runtime itself, answered with the runtime's SDP. `id` names the attempt;
   * candidates carry it both ways. The channel runs Session Protocol as a connection of its own, under the same
   * principal, and the runtime checks the device again on it. Cloud computers, local connections and the channel
   * itself refuse it `unsupported`. `ice_servers`: the STUN servers the device uses (`stun:host:port`: the install's
   * list, or Google's public one when the install says nothing), which the runtime uses for its own candidates too;
   * [] for none (this network only). Omitted (an older device): the runtime uses Google's.
   */
  "direct.offer": m(
    {
      id: DirectId,
      sdp: Schema.String.check(Schema.isMaxLength(DIRECT_SDP_MAX)),
      ice_servers: optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(4))),
    },
    S({ sdp: Schema.String }),
  ),
  /** One of the device's ICE candidates for an attempt (the runtime's arrive as direct.candidate notifications). */
  "direct.candidate": m(DirectCandidate.fields, Empty),
} as const;

export type MethodName = keyof typeof Methods;
export type Params<M extends MethodName> = (typeof Methods)[M]["params"]["Type"];
export type Result<M extends MethodName> = (typeof Methods)[M]["result"]["Type"];
export const isMutating = (method: MethodName): boolean =>
  "request_id" in Methods[method].params.fields;

/** Server -> client notifications (JSON-RPC requests without an id). */
export const Notifications = {
  "session.event": SessionEvent,
  /** Consecutive events of one session, in cursor order: an attach's backlog when it asked for batch. */
  "session.events": S({ session_id: Id, events: Schema.Array(SessionEvent) }),
  /**
   * The runtime ended this connection's attachment to a session on its own, and why (`error.data.reason`):
   * journal_reset when its journal got a new epoch (attach again with the old epoch to be told `reset`). The
   * attachment is gone: no more events of that session follow on this connection until it attaches again.
   */
  "session.ended": S({ session_id: Id, error: RpcError }),
  "term.output": S({ terminal_id: Id, data: Schema.String }),
  "term.exit": S({
    terminal_id: Id,
    exit_code: Schema.NullOr(Schema.Int),
    signal: optionalKey(Schema.String),
  }),
  /**
   * This connection fell too far behind on a terminal's output, so the runtime dropped what was waiting for it.
   * term.attach the terminal again for its scrollback; until then none of its output is sent to this connection.
   */
  "term.resync": S({ terminal_id: Id }),
  /**
   * Output of a command this connection watches (tool.watch). `replace` carries the whole bounded tail (the first
   * frame, or after the client fell behind), `append` extends it. Text is terminal output, secret values masked:
   * feed both through appendTerminalOutput (@caveman-app/shared/terminalOutput). The last frame has running: false.
   */
  "tool.live": S({ ...ws, item_id: Id, kind: Schema.Literals(["replace", "append"]), text: Schema.String, truncated: Schema.Boolean, running: Schema.Boolean }),
  /**
   * The chat's suggested next message (suggestion.watch): text the empty composer shows and Tab takes, and the run it
   * follows (a dismissal is per run); both null for none.
   */
  "suggestion.live": S({ ...ws, run_id: Schema.NullOr(Schema.String), text: Schema.NullOr(Schema.String) }),
  "browser.frame": S({ ...ws, ...Blob.fields, width: Count, height: Count }),
  /** On navigation, load and controller change. */
  "browser.state": S({
    ...ws,
    url: Schema.String,
    title: Schema.String,
    loading: Schema.Boolean,
    can_go_back: Schema.Boolean,
    can_go_forward: Schema.Boolean,
    controller: Controller,
    /** The agent opened a page and asked to show it: every connection gets this state, so a client can show the page as it works. */
    reveal: optionalKey(Schema.Literal(true)),
    /** The agent just used its browser: every connection gets this state, at most every few seconds while it keeps at it, so a client can show the browser is in use. */
    active: optionalKey(Schema.Literal(true)),
    /**
     * The page waits on this dialog, and input sent to it meanwhile never reaches it. The connection that holds control
     * answers it with a browser.input `dialog` event; once nobody holds the browser, the agent does.
     */
    dialog: optionalKey(BrowserDialog),
  }),
  /** The agent's cursor when it acts, for the cursor overlay; seq orders them. */
  "browser.pointer": AgentPointer,
  "computer.frame": S({ ...ws, ...Blob.fields, width: Count, height: Count }),
  "computer.state": S({
    ...ws,
    controller: Controller,
    width: Count,
    height: Count,
    /** This Mac: the app the frames show, the one the chat's agent used last. Absent on a Cloud computer and before any. */
    app: optionalKey(ComputerApp),
    /** The agent started on the desktop: every connection gets this state, once per desktop start, so a client can show the screen as it works. */
    reveal: optionalKey(Schema.Literal(true)),
    /** The agent just acted on the desktop: every connection gets this state, at most every few seconds while it keeps at it, so a client can show the screen is in use. */
    active: optionalKey(Schema.Literal(true)),
  }),
  "computer.pointer": AgentPointer,
  /**
   * Show the person where to allow Caveman Code in System Settings: the desktop app opens its guide panel over it
   * (for one `permission`, or the ones still missing). Sent to this computer's own windows when an agent's card asked.
   */
  "computer.guide": S({ permission: optionalKey(Schema.Literals(["accessibility", "screen_recording"])) }),
  /** Sent to every connection when a workspace is created or changes (status, title, computer). */
  "workspace.changed": Workspace,
  /** A repository's secrets changed (set, deleted, imported): names only. New processes get them; running ones do not. */
  "secret.changed": S({ repository: Schema.String, names: Strings }),
  /** Sent to every connection when engine.list would answer differently (a probe finished, a sign-in, a setting): its answer. */
  "engine.changed": S({ engines: Schema.Array(EngineDescriptor) }),
  /** outside_agent.list would answer differently (an agent connected, left, or the person changed one): to the owner's connections. */
  "outside_agent.changed": OutsideAgentList,
  /** Sent to every connection when cloud.status would answer differently (link state, a sign-in starting or ending). */
  "cloud.changed": CloudStatus,
  /**
   * automation.list may answer differently for this project: a file saved anywhere (an editor, an agent, another
   * worktree) or its default branch moved. Read it again; the runtime sends at most a few a second.
   */
  "automation.changed": S({ project_id: Id }),
  /** Sent to every connection of the owner after any change to the board: the whole board, which replaces the last one. chief.get has it on connect. */
  "chief.board.updated": ChiefBoard,
  /** Sent to every connection of the owner after a Chief is made, edited or removed: every Chief, as chief.list answers. */
  "chief.list.updated": S({ chiefs: Schema.Array(ChiefProfile) }),
  /**
   * A Chief opened or closed something in the sidebar (Smart View), the person closed one, or Smart View was turned on
   * or off: its whole ChiefView, to the owner's connections.
   */
  "chief.view.updated": ChiefView,
  /** A call started, went live, changed (muted) or ended: to every connection of the owner, so all devices agree. */
  "chief.voice.updated": VoiceCall,
  /** Messages for the voice engine, from the runtime between signals (an update to speak, the board changing): only to the client holding the call. */
  "chief.voice.send": S({ call_id: Id, messages: Schema.Array(Schema.Unknown) }),
  /**
   * Work you handed off on a call is ready (or needs you) and no call is on: the Chief rings. Answer with
   * chief.voice.start `answer: item_id`; unanswered, it stops on its own. To every connection of the owner.
   */
  "chief.voice.ringing": S({
    item_id: Id,
    title: Schema.String,
    state: Schema.Literals(["review", "done", "needs_you"]),
    line: Schema.String,
    chief_id: optionalKey(Id),
    /** Rings are muted (Settings chief_voice_ring_back off, or chief_voice_ring_muted_until ahead): show it quietly, never ring. */
    muted: optionalKey(Schema.Boolean),
  }),
  /** A project's Cloud setup changed: every 3 s while a build runs and a client asked for it in the last minute (environment.get). */
  "environment.updated": S({ project_id: Id, environment: Environment }),
  /** An agent proposed a setup change for the project (propose_setup_change). */
  "environment.proposed": S({ project_id: Id, proposal: SetupProposal }),
  /** The project's setup chat changed (a new proposal, review, published, stopped): clients replace the one they hold. */
  "environment.setup_chat": S({ project_id: Id, setup_chat: SetupChat }),
  /** Moves (ADR 0126): a chat moved to another computer. Clients follow it there, through the relay (runtime_id) or open_url. */
  "session.moved": S({
    session_id: Id,
    to: S({ runtime_id: Schema.String, computer_id: Schema.NullOr(Id), open_url: Schema.NullOr(Schema.String) }),
  }),
  /** First frame on a relayed connection to This Mac: answer with device.hello. `runtime_name` is how the Mac calls itself. */
  "device.challenge": S({
    nonce: Schema.String,
    runtime_id: Id,
    key: Schema.String,
    runtime_name: Schema.String,
    /** 2: this Mac checks the v2 hello (kind and name signed too); absent, v1 only. */
    hello: optionalKey(Schema.Number),
  }),
  /** This Mac's answer about this device changed (allowed or refused after device.hello said pending). */
  "device.status": S({
    status: DeviceStatus,
    runtime_name: Schema.String,
    code: Schema.String,
    /**
     * Only on the first frame sealed on a Join's own connection (decision 31): this Mac's screen allowed the joining key
     * as one of the person's Macs, and `proof` (session-protocol devices.ts pairAnswer, under the code it showed) says so
     * as nobody but this Mac can. The joining Mac says it was taken only then (m-h).
     */
    role: optionalKey(DeviceRole),
    proof: optionalKey(Schema.String),
  }),
  /** A device asks to drive This Mac: local clients show "Allow?" (device.allow, device.remove). */
  "device.request": DeviceRequest,
  /** device.list would answer differently: its answer, to local clients. */
  "device.changed": DeviceList,
  /** One of the runtime's ICE candidates for a direct attempt this connection offered (direct.offer). */
  "direct.candidate": DirectCandidate,
} as const;
export type NotificationName = keyof typeof Notifications;
export type NotificationParams<N extends NotificationName> = (typeof Notifications)[N]["Type"];
