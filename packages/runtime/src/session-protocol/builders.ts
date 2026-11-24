// Builders (DESIGN S9 "Builders"). A lead starts builders with delegate_task. On This Mac T3 makes each a
// worktree-isolated child thread, as before. On a Cloud computer the lead keeps the checkout and each builder is a
// Caveman Code workspace of its own: a worktree of that checkout under `<worktreesDir>/chats`, made by git in the
// tools container, while the computer has room for another chat (capacity.ts). Beyond that, and for a lead on
// This Mac that asks for Cloud (`where: "cloud"`), a builder gets a Cloud computer of its own through Cloud's
// `mail/spawn`; a lead that names one of the person's Cloud computers (`computerId`) sends it there instead. Its
// result comes back by mail and wakes the lead as a local builder's does.
//
// The route that owns workspaces binds the implementation (as SetupChats and ChiefHost are bound); the MCP's
// delegate_task reaches it through this service, so neither knows how the other is built.
import { createHash } from "node:crypto";

import type { OrchestratorMcpComputer } from "@caveman-app/protocol";
import type { BuilderState, BuildersResult, SessionEvent } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";

import { listCloudComputers, type CloudComputer } from "../cloudLink/computers.ts";
import { CloudError, type Identity } from "../cloudLink/identity.ts";
import type { LinkState } from "../cloudLink/index.ts";
import { untilText } from "../cloudLink/modelConnections.ts";
import { ackTreeMail, claimPaths, releasePaths, sendTreeMail, spawnBuilder, spawnPayloadOf, takeTreeMail, waitTreeComputer, waitTreeMail, type TreeMail } from "../cloudLink/mail.ts";
import { BRANCH_MISSING, builderStateOf, conflictShown, failedWhy, leadMailShown, leftOutWhy, NOT_FINISHED, NOTHING_MERGED, planName, PULL_REQUEST_REFUSED, resultRow, resultShown, RESUME_SHOWN } from "./builderState.ts";
import { COMPUTER_FULL } from "./capacity.ts";
import { conflictText, describeResult, leadSummary, leftOutForConflict, MAX_CONFLICT_ROUNDS, mergeAcrossSources, mergeBranches, shortNote, type BuilderResult, type Candidate, type IntegrationGit, type SourceCandidates } from "./integration.ts";
import { gitCheckoutsOf, severalSources } from "./sources.ts";
import type { SessionStore, WorkspaceRecord } from "./store.ts";

// ------------------------------------------------------------------ the route's service

export class BuilderError extends Schema.TaggedError<BuilderError>()("BuilderError", {
  reason: Schema.Literals(["invalid_request", "limit_reached", "unavailable"]),
  message: Schema.String,
}) {}

/** One delegate_task as a builder: the lead's thread and the brief. */
export interface BuilderStart {
  readonly parentThreadId: string;
  readonly task: string;
  readonly title?: string | undefined;
  /** An engine for the builder; absent: the lead's. */
  readonly engine?: string | undefined;
  /** Its model on that engine; absent: the lead's when it runs the lead's engine, else that engine's default. */
  readonly model?: string | undefined;
  readonly where?: "cloud" | undefined;
  /** One of the person's Cloud computers (never with `where`); this runtime's own computer means here. */
  readonly computerId?: string | undefined;
  /** Stable across retries of one delegation: a retry starts nothing new. */
  readonly requestKey: string;
  /** A schedule the builder holds on a Cloud computer of its own, running `task` on it (cloudSchedules.ts). */
  readonly schedule?: Record<string, unknown> | undefined;
  /**
   * What every delegation passes before it starts (Settings > Agents: depth, agents at once, the tree's tokens), run
   * once the start is known to be new: a retry of one that started is that builder, whatever the limits say now.
   */
  readonly admit?: Effect.Effect<void, BuilderError> | undefined;
}

/** What a lead's chat tells its Cloud schedule's builder: a change, a run now, or the end of it. */
export interface ScheduleControl {
  readonly enabled?: boolean;
  readonly title?: string;
  readonly prompt?: string;
  readonly schedule?: Record<string, unknown>;
  readonly run_now?: true;
  readonly delete?: true;
}

/** A Cloud schedule's builder row is keyed by this, then the schedule's id. */
export const SCHEDULE_KEY = "schedule:";
/** A control mail's body starts with this; the rest is a ScheduleControl as JSON. It never reaches the builder's agent. */
export const SCHEDULE_CONTROL = "[caveman-schedule] ";

export interface BuilderStarted {
  /** The builder's workspace: local, or Cloud's on its own computer. */
  readonly workspaceId: string;
  /** This runtime's thread for a builder here; absent for one on another computer. */
  readonly threadId?: string;
  readonly where: "here" | "cloud";
  readonly computerId?: string;
  /** Set when the lead named its computer (computerId): its name as Cloud listed it, else its id. */
  readonly computerName?: string;
  readonly title: string;
  readonly engine: string;
  /** The model it was started on, when one was named (else its engine's default where it runs). */
  readonly model?: string;
}

/** Where a lead's builders may go besides here (orchestrator_capabilities computers), or why nowhere. */
export interface BuilderComputers {
  readonly computers: ReadonlyArray<OrchestratorMcpComputer>;
  readonly note?: string;
}

export interface BuildersShape {
  /**
 * Starts a builder for a Caveman Code lead, or answers undefined when upstream own delegated child applies (a lead on
   * This Mac that did not ask for Cloud or another computer, a thread that is no Caveman Code chat).
   */
  readonly start: (input: BuilderStart) => Effect.Effect<BuilderStarted | undefined, BuilderError>;
  /** A builder that started earlier, by the workspace id start answered (task_status). */
  readonly status: (workspaceId: string) => Effect.Effect<BuilderStatus | undefined>;
  /** This runtime's own Cloud computer, when it is signed in: a computerId naming it means here. */
  readonly thisComputer: () => string | undefined;
  /** The person's Cloud computers a lead's builders may go to, this one and laptops left out. Never fails: a note says why none. */
  readonly computers: (threadId: string) => Effect.Effect<BuilderComputers>;
  /**
   * A lead's builders as Settings > Agents' limits count them: how many are at work now (here or on another computer),
   * the threads of those on this computer, whose tokens the tree's ceiling adds up, and `tokens`: what its builders on
   * other computers have used, as each last said with a branch it pushed (it spends where it runs, so this is what
   * it reported, not a live count; one that never pushed a branch has said none).
   */
  readonly tree: (leadThreadId: string) => Effect.Effect<{ readonly running: number; readonly threadIds: ReadonlyArray<string>; readonly tokens: number }>;
  /** True for a builder sharing this computer with its lead: it never takes the computer's desktop. */
  readonly sharesComputer: (threadId: string) => Effect.Effect<boolean>;
  /**
   * A message from a thread here to a tree member on another computer (thread_send to `cloud:<workspace>`): a
   * lead to its builder on Cloud, or a builder Cloud spawned here to its lead. Undefined when `toThreadId` is none.
   */
  readonly message: (input: { readonly fromThreadId: string; readonly toThreadId: string; readonly text: string; readonly requestKey: string; readonly ask: boolean }) => Effect.Effect<{ readonly id: string } | undefined, BuilderError>;
}

/** The thread id a tree member on another computer goes by here (delegate_task's childThreadId for it). */
export const CLOUD_THREAD = "cloud:";

export interface BuilderStatus extends BuilderStarted {
  readonly state: "running" | "completed" | "failed";
  readonly summary?: string;
}

/** Why a thread lists no computer but its own, and why where/computerId cannot take its task elsewhere. */
export const NOT_A_LEAD = "Only a Caveman Code chat sends builders to other computers.";

/** The engines a Cloud computer runs (Caveman Cloud mailbox.go placeBuilder: an ACP agent's CLI is not on it). */
const CLOUD_ENGINES = new Set(["caveman", "claude-agent", "codex"]);
/** The same three as orchestrator_capabilities names harnesses (provider driver kinds). */
const CLOUD_DRIVER_KINDS = ["caveman", "claudeAgent", "codex"];
/**
 * Cloud's list of computers is kept this long (a failure or no answer, for RETRY), and waited for at most TIMEOUT:
 * capabilities never hang on Cloud. A start refuses a computer the last list showed unable to take a builder only
 * after Cloud lists it so again: one started or paid for since is not refused.
 */
const COMPUTERS_TTL_MS = 30_000;
const COMPUTERS_RETRY_MS = 5_000;
const COMPUTERS_TIMEOUT_MS = 3_000;
/** The name Cloud gives a computer it makes for one builder (Caveman Cloud mailbox.go placeBuilder, which also sets spawned_for). */
const BUILDER_COMPUTER_NAME = "builder";
/** Cloud refusing a named computer it does not place builders on: a laptop, an unknown id (mailbox.go placeBuilder notFound("Computer")). */
export const NO_SUCH_COMPUTER = "No Cloud computer of yours has that id; orchestrator_capabilities lists them.";

/** Asleep because nothing pays for its time (sleep_reason "usage"): mail to it does not wake it (mailbox.go post, ComputerFundsTx). */
const unpaid = (c: CloudComputer) => c.sleep_reason === "usage";
/** Stopped by the person: mail resumes only a suspended computer (mailbox.go post), so it waits for them to start it. */
const stopped = (c: CloudComputer) => c.desired_state === "stopped";
/** Why an asleep computer won't wake for a builder, or undefined when work sent to it wakes it. */
const wontWake = (c: CloudComputer) => (stopped(c) ? "stopped" : unpaid(c) ? "unpaid" : undefined);

/** A Cloud computer as a lead's agent reads it; undefined for one on its way out. */
function cloudComputerEntry(c: CloudComputer): OrchestratorMcpComputer | undefined {
  if (c.desired_state === "deleted" || c.observed_state === "deleted") return undefined;
  const state =
    c.observed_state === "failed"
      ? "failed"
      : c.observed_state === "running"
        ? "awake"
        : c.observed_state === "pending" || c.observed_state === "starting" || c.desired_state === "running"
          ? "starting"
          : "asleep";
  return { id: c.id, name: c.name, kind: "cloud", os: "linux", state, driverKinds: CLOUD_DRIVER_KINDS, canRunBuilder: state !== "failed" && !(state === "asleep" && wontWake(c) !== undefined) };
}

/**
 * The person's computers a builder may be sent to: no laptop (Cloud refuses one: it takes no work sent from elsewhere),
 * not this one, which is here, and none Cloud made for a builder: Cloud names those "builder" (mailbox.go placeBuilder)
 * and its list does not say whose (spawned_for), so one is another builder's computer.
 */
function builderTargets(computers: ReadonlyArray<CloudComputer>, here: string): BuilderComputers {
  const targets = computers.flatMap((c) => {
    const entry = c.driver === "local" || c.id === here || c.name === BUILDER_COMPUTER_NAME ? undefined : cloudComputerEntry(c);
    return entry === undefined ? [] : [entry];
  });
  if (targets.length === 0) return { computers: [], note: 'No Cloud computer of yours yet: where "cloud" starts a builder on a new one.' };
  const byId = new Map(computers.map((c) => [c.id, c]));
  const named = (ids: ReadonlyArray<OrchestratorMcpComputer>) => ids.map((t) => `${t.name} (${t.id})`).join(", ");
  const asleep = targets.filter((t) => t.state === "asleep" && !t.canRunBuilder);
  const unpaidOnes = asleep.filter((t) => wontWake(byId.get(t.id)!) === "unpaid");
  const stoppedOnes = asleep.filter((t) => wontWake(byId.get(t.id)!) === "stopped");
  const notes = [
    ...(unpaidOnes.length === 0 ? [] : [`${named(unpaidOnes)} ${unpaidOnes.length === 1 ? "is" : "are"} asleep because nothing pays for the time, so no builder runs there until credits are added.`]),
    ...(stoppedOnes.length === 0 ? [] : [`${named(stoppedOnes)} ${stoppedOnes.length === 1 ? "is" : "are"} stopped, so no builder runs there until the person starts it.`]),
  ];
  return notes.length === 0 ? { computers: targets } : { computers: targets, note: `${notes.join(" ")} Pick another computer.` };
}

/** Why a named computer cannot take a builder, as Cloud last listed it; undefined when it can (or is not listed). */
function cannotTake(c: CloudComputer | undefined): string | undefined {
  const entry = c === undefined ? undefined : cloudComputerEntry(c);
  if (entry === undefined || entry.canRunBuilder) return undefined;
  return entry.state === "failed"
    ? `Cloud computer ${entry.name} has failed and takes no builder: pick another computer.`
    : wontWake(c!) === "stopped"
      ? `Cloud computer ${entry.name} is stopped and takes no builder until the person starts it: pick another computer.`
      : `Cloud computer ${entry.name} is asleep because nothing pays for its time: add credits or pick another computer.`;
}

/** Cloud's refusals that are the lead agent's to fix by asking otherwise (mailbox.go Spawn and placeBuilder). */
const AGENT_FIXES = new Set(["cave_bad_request", "cave_code_computer_not_yours", "cave_code_engine_unavailable"]);

/**
 * A Cloud call's failure as a builder error, by Cloud's error code: what the agent asked wrong (a computer not the
 * person's, or none of theirs, a bad request) is invalid_request; Cloud's 409s are limits; any other refusal (a
 * revoked runtime, the lead's Cloud workspace gone) and no answer are unavailable. A refusal without a code (no
 * Cloud's JSON) goes by its status, as before codes were read.
 */
function builderErrorOf(error: unknown): BuilderError {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof CloudError)) return new BuilderError({ reason: "unavailable", message });
  // Cloud's notFound("Computer"): a laptop, someone's deleted computer, an id that is no computer.
  if (error.code === "cave_not_found" && error.message === "Computer not found.") return new BuilderError({ reason: "invalid_request", message: NO_SUCH_COMPUTER });
  if (error.code !== undefined && AGENT_FIXES.has(error.code)) return new BuilderError({ reason: "invalid_request", message });
  if (error.status === 409) return new BuilderError({ reason: "limit_reached", message });
  const asked = error.code === undefined && (error.status === 400 || error.status === 403 || error.status === 404);
  return new BuilderError({ reason: asked ? "invalid_request" : "unavailable", message });
}

export class Builders extends Context.Service<
  Builders,
  BuildersShape & {
    /** The route's implementation; the last bind wins. */
    readonly bind: (impl: BuildersShape) => Effect.Effect<void>;
  }
>()("caveman/session-protocol/Builders") {}

export const layer = Layer.sync(Builders, () => {
  let bound: BuildersShape | undefined;
  return Builders.of({
    start: (input) => (bound ? bound.start(input) : Effect.succeed(undefined)),
    status: (workspaceId) => (bound ? bound.status(workspaceId) : Effect.succeed(undefined)),
    thisComputer: () => bound?.thisComputer(),
    computers: (threadId) => (bound ? bound.computers(threadId) : Effect.succeed({ computers: [], note: NOT_A_LEAD })),
    tree: (leadThreadId) => (bound ? bound.tree(leadThreadId) : Effect.succeed({ running: 0, threadIds: [], tokens: 0 })),
    sharesComputer: (threadId) => (bound ? bound.sharesComputer(threadId) : Effect.succeed(false)),
    message: (input) => (bound ? bound.message(input) : Effect.succeed(undefined)),
    bind: (impl) => Effect.sync(() => void (bound = impl)),
  });
});

// ------------------------------------------------------------------ the route's implementation

/** A builder's lead learns of its result in one message (cut past this). */
const RESULT_MAX_CHARS = 16_000;
/**
 * The most builders one lead runs at once, whatever Settings > Agents says: a guard against a runaway.
 * Caveman Cloud's mailbox.go MaxBuilders caps the ones it places.
 */
export const MAX_BUILDERS_PER_LEAD = 64;
/** A builder in one of these states holds one of its lead's slots; one that finished or failed gave it back (P4). */
const AT_WORK = new Set(["starting", "running", "paused"]);
/** Between takes when Cloud offers no long wait (or failed): a pause this long. */
/**
 * How often a builder a Cloud computer turned away as full is asked of Cloud again (item: a lowered room). The computer
 * tells Cloud its room before it answers, so the next placement goes elsewhere; past this the lead hears the refusal.
 */
export const MAX_PLACED_AGAIN = 2;
const TREE_POLL_MS = 2_000;
const WAIT_MS = 25_000;
const MAX_BACKOFF_MS = 60_000;

const SCHEMA = [
  // One row per builder this runtime knows of:
  // - local: a builder of a lead here, in a worktree of this computer (lead_workspace_id, request_key = the delegation's);
  // - remote: a builder of a lead here, on a Cloud computer of its own (cloud names its Cloud rows and the spawn mail);
  // - hosted: a builder Cloud spawned here for a lead on another computer (request_key = the spawn mail's id).
  // reported_cursor: the last turn.done whose result went to the lead, so a restart sends what it owes and no more.
  `CREATE TABLE IF NOT EXISTS caveman_sp_builders (
     role TEXT NOT NULL,
     lead_workspace_id TEXT NOT NULL,
     request_key TEXT NOT NULL,
     workspace_id TEXT,
     title TEXT NOT NULL,
     engine TEXT NOT NULL,
     state TEXT NOT NULL,
     reported_cursor INTEGER NOT NULL DEFAULT 0,
     summary TEXT,
     cloud TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (role, lead_workspace_id, request_key))`,
  // What the integration step (integration.ts) made of a builder's branch: merged into its lead's, sent back for a
  // conflict (rounds counts the times), or left out for good. sha: the builder's commit it is about.
  `CREATE TABLE IF NOT EXISTS caveman_sp_builder_merges (
     lead_workspace_id TEXT NOT NULL,
     request_key TEXT NOT NULL,
     state TEXT NOT NULL,
     sha TEXT,
     rounds INTEGER NOT NULL DEFAULT 0,
     detail TEXT,
     PRIMARY KEY (lead_workspace_id, request_key))`,
  // A lead whose builders' work has come together: the outcome it was last told (a digest, so it hears each once)
  // and the pull request that carries it.
  `CREATE TABLE IF NOT EXISTS caveman_sp_integrations (
     lead_workspace_id TEXT PRIMARY KEY,
     settled TEXT NOT NULL,
     pull_request TEXT)`,
  // A lead whose plan refused (out of usage) while its builders worked: they stopped together and start again together
  // when the window resets (resets_at, as the refusal said; null: it did not say). A builder Cloud spawned here pauses
  // alone, under "hosted:<its spawn mail>".
  `CREATE TABLE IF NOT EXISTS caveman_sp_builder_pauses (
     tree TEXT PRIMARY KEY,
     resets_at TEXT,
     since TEXT NOT NULL)`,
  // A lead's own Cloud workspace (the tree's root in Cloud's mailbox), once it asked.
  `CREATE TABLE IF NOT EXISTS caveman_sp_builder_leads (
     workspace_id TEXT PRIMARY KEY,
     cloud_workspace_id TEXT NOT NULL UNIQUE)`,
];

type Role = "local" | "remote" | "hosted";
interface Row {
  readonly role: Role;
  readonly lead_workspace_id: string;
  readonly request_key: string;
  readonly workspace_id: string | null;
  readonly title: string;
  readonly engine: string;
  readonly state: string;
  readonly reported_cursor: number;
  readonly summary: string | null;
  readonly cloud: string | null;
  readonly created_at: string;
}
/** What a remote or hosted row keeps of Cloud's rows. */
interface CloudSide {
  /** The builder's Cloud workspace and session. */
  readonly workspace_id: string;
  readonly session_id?: string;
  /** The lead's Cloud workspace, and (hosted) its chat session when Cloud names it. */
  readonly lead_workspace_id: string;
  readonly lead_session_id?: string;
  /** The spawn mail: a result replies to it. */
  readonly spawn_mail_id: string;
  readonly computer_id?: string | null;
  /** A scheduled builder hosted here: the scheduled task it holds on its chat. */
  readonly schedule_task_id?: string;
  /** The model the spawn named (remote): what the lead's task_status reports. */
  readonly model?: string;
  /** The computer the lead named (remote, computerId), by its listed name or else its id; absent when Cloud picked one. */
  readonly named_computer?: string;
  /** What the builder pushed to GitHub when it last finished (remote): the branch its lead's computer fetches, and its head. */
  readonly branch?: string;
  readonly sha?: string;
  /** The tokens its turns have used so far (remote), as it last said with a branch it pushed: the tree's ceiling counts them. */
  readonly tokens?: number;
  /** Its brief (remote), kept until it has answered once: a builder its computer turned away as full is started again with it. */
  readonly brief?: string;
  /** How often Cloud was asked to place it again (remote), and the Cloud workspaces it had before: its lead's agent may still name one. */
  readonly again?: number;
  readonly earlier?: ReadonlyArray<string>;
}

/** A builder's row in caveman_sp_builder_merges. */
interface MergeRow {
  readonly lead_workspace_id: string;
  readonly request_key: string;
  readonly state: "merged" | "conflict" | "left_out";
  readonly sha: string | null;
  readonly rounds: number;
  readonly detail: string | null;
}

/** After a hosted builder's result: what it pushed, as JSON, on a line of its own. The lead's agent never reads it. */
export const BRANCH_TRAILER = "\n\n[caveman-branch] ";
/** A lead's mail to a builder on another computer whose branch conflicts starts with this, then JSON and a newline. */
export const CONFLICT_MAIL = "[caveman-conflict] ";

/** What the route needs from the handlers that own workspaces. */
export interface BuilderRouteDeps {
  readonly sql: SqlClient.SqlClient;
  readonly store: SessionStore["Service"];
  /** This runtime is a Cloud computer's. */
  readonly onComputer: boolean;
  /** The chats this computer has room for now (0 on This Mac). */
  readonly freeSlots: Effect.Effect<number>;
  /** Settings > Agents' "Agents working at once": how many builders a lead runs, as any delegation is counted. */
  readonly agentsAtOnce: Effect.Effect<number>;
  /**
   * Why this lead may not start a builder now though its own limits allow it, in one sentence for its agent, or
   * undefined: a lead a Chief started shares the Chief's limit on agents at once (chief/Chief.ts).
   */
  readonly leadMayStart?: (lead: WorkspaceRecord) => Effect.Effect<string | undefined>;
  /** A builder workspace on this computer: under `lead` here, or for a lead elsewhere (hosted, Cloud's session id). */
  readonly createLocal: (input: {
    readonly requestId: string;
    readonly lead?: WorkspaceRecord;
    readonly title: string;
    readonly engine?: string;
    readonly model?: string;
    /** Absent: the chat waits, as a scheduled builder does for its first run. */
    readonly task?: string;
    readonly repo?: string;
    readonly baseBranch?: string;
    readonly branch?: string;
    readonly sessionId?: string;
  }) => Effect.Effect<WorkspaceRecord, { readonly message: string }>;
  /** Starts a turn in `to` with text another agent wrote (a builder's result, the lead's message). */
  readonly wake: (
    to: WorkspaceRecord,
    input: { readonly requestId: string; readonly text: string; readonly from?: WorkspaceRecord; /** The line a person reads of it (message.done `generated`). */ readonly generated?: { readonly shown: string; readonly builders_result?: BuildersResult } },
  ) => Effect.Effect<void, { readonly message: string }>;
  /** Keeps a tree mail that reached a workspace here in its local mailbox (mail.wait reads it there). */
  readonly keep: (to: WorkspaceRecord, mail: TreeMail) => Effect.Effect<void>;
  /** The lead's own Cloud workspace: its chat registered with Cloud on this computer. */
  readonly registerLead: (lead: WorkspaceRecord) => Effect.Effect<string, { readonly message: string }>;
  /** The model the lead's chat runs now. */
  readonly modelOf: (lead: WorkspaceRecord) => Effect.Effect<string | undefined>;
  /** Pushes the lead's branch where a builder on another computer can fetch it, when this computer may (best effort). */
  readonly shareBranch: (lead: WorkspaceRecord) => Effect.Effect<boolean>;
  /** This runtime's Cloud identity and link, when it has one. */
  readonly link: () => { readonly identity: Identity; readonly state: LinkState } | undefined;
  /** git in a worktree on this computer: the lead's, for the integration step. */
  readonly git: (worktree: string) => IntegrationGit;
  /**
   * A builder's branch on another computer, fetched from GitHub into `into` in the lead's repository (through the git
   * proxy on a Cloud computer); false when it is not there.
   */
  readonly fetchBranch: (lead: WorkspaceRecord, branch: string, into: string, /** The lead's worktree of the source to fetch into, for a lead that works in several; absent: the lead's own. */ worktree?: string) => Effect.Effect<boolean>;
  /**
   * A builder's branch pushed from this computer to GitHub, where its lead's computer fetches it: its own caveman/
   * branch, never forced. Undefined when it could not go.
   */
  readonly publishBranch: (builder: WorkspaceRecord) => Effect.Effect<{ readonly branch: string; readonly sha: string } | undefined>;
  /** The lead's branch as GitHub has it, brought into this computer's repository for a builder here to merge. */
  readonly refreshBranch: (builder: WorkspaceRecord, branch: string) => Effect.Effect<boolean>;
  /** The tokens a builder here has used so far (uncached input plus output of its turns), as the tree's ceiling counts them. */
  readonly tokensOf?: (builder: WorkspaceRecord) => Effect.Effect<number>;
  /**
   * A builder Cloud spawned here that this computer could not take (it is full): Cloud's rows for it are closed, so it
   * holds neither one of its lead's places nor one of this computer's. Best effort.
   */
  readonly turnedAway?: (spawned: { readonly workspaceId: string; readonly sessionId: string; readonly title: string; readonly engine: string }) => Effect.Effect<void>;
  /** The one pull request for a lead's branch, opened (or the one it has, updated) by the path a person's own takes. */
  readonly openPullRequest: (
    lead: WorkspaceRecord,
    input: { readonly requestId: string; readonly title: string; readonly body: string },
  ) => Effect.Effect<{ readonly url: string; /** Each it opened, one per repository. */ readonly pullRequests?: ReadonlyArray<{ readonly number: number; readonly url: string; readonly repo?: string }> }, { readonly message: string }>;
  /** A line in a chat that starts no turn. */
  readonly note: (record: WorkspaceRecord, title: string, body?: string) => Effect.Effect<void>;
  /**
   * Ends a chat's turn at its next tool boundary, without waiting for it: at once when no tool runs, else when the
   * tool that runs has finished. Nothing when no turn runs.
   */
  readonly windDown: (record: WorkspaceRecord, requestId: string) => Effect.Effect<void>;
  /** When the plan that refused a chat's last turn resets, as its engine reported it; undefined when it did not say. */
  readonly planReset: (record: WorkspaceRecord) => Effect.Effect<string | undefined>;
  /**
   * A scheduled builder Cloud spawned here: saves its schedule on the builder's own chat, running `prompt` there, and
   * answers the scheduled task's id. Idempotent by `requestId`.
   */
  readonly holdSchedule: (
    builder: WorkspaceRecord,
    input: { readonly requestId: string; readonly title: string; readonly prompt: string; readonly schedule: Record<string, unknown> },
  ) => Effect.Effect<string, { readonly message: string }>;
  /** Applies a lead's control to the scheduled task a builder here holds. */
  readonly controlSchedule: (taskId: string, control: ScheduleControl) => Effect.Effect<void, { readonly message: string }>;
  /** A run of a Cloud schedule set from a chat here ended: recorded, and whether the schedule lives on. */
  readonly scheduleRan: (scheduleId: string, result: { readonly status: string; readonly text: string }) => Effect.Effect<"live" | "done">;
}

const nowIso = () => new Date().toISOString();
const short = (text: string) => (text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}\n\n[cut: the builder's full answer is in its chat]` : text);
/** A builder's branch, named as the app names a chat's, unique per delegation. */
export const builderBranch = (title: string, key: string) =>
  `caveman/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "builder"}-${createHash("sha256").update(key).digest("hex").slice(0, 6)}`;

/** How a turn of a builder ended, and what it said last: what its lead reads. */
export function resultOf(events: ReadonlyArray<SessionEvent>, throughCursor: number) {
  const done = [...events].reverse().find((e) => e.type === "turn.done" && e.cursor <= throughCursor);
  const said = [...events].reverse().find((e) => e.type === "message.done" && e.payload.role === "assistant" && e.cursor <= throughCursor);
  const status = done?.type === "turn.done" ? done.payload.status : "completed";
  const error = done?.type === "turn.done" ? done.payload.error : undefined;
  const text = said?.type === "message.done" ? said.payload.text : "";
  return { status, text: short(text.trim() || (error ? `It stopped: ${error}` : "It ended its turn without a message.")) };
}

/** How a builder's work reaches the one pull request: said to every builder, here or on another computer. */
const COMMIT_NOTE =
  "Commit your work on this branch: when every builder has finished, the branches are merged into the lead's and go into one pull request, and what is not committed is not in it.";
/** What a builder on its lead's computer reads after its brief. */
const localNote = `[Caveman Code] You are a builder, in a worktree and on a branch of your own. ${COMMIT_NOTE} When your turn ends, your last answer goes back to your lead by itself: say in a few sentences what you did and what is left.`;
/** What a builder Cloud spawned here reads after its brief: how its work gets back to its lead. */
const hostedNote = (lead: string) =>
  `[Caveman Code] You are a builder for a lead on another computer. When your turn ends, your last answer goes back to it by itself: say what you did, on which branch, and what is left. ${COMMIT_NOTE} To ask the lead something sooner, use thread_send with threadId "${CLOUD_THREAD}${lead}".`;

/** A control mail's JSON, or undefined when it is none. */
export function parseControl(text: string): ScheduleControl | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const c = value as Record<string, unknown>;
    const schedule = c.schedule !== null && typeof c.schedule === "object" && !Array.isArray(c.schedule) ? (c.schedule as Record<string, unknown>) : undefined;
    return {
      ...(typeof c.enabled === "boolean" ? { enabled: c.enabled } : {}),
      ...(typeof c.title === "string" && c.title.trim() !== "" ? { title: c.title } : {}),
      ...(typeof c.prompt === "string" && c.prompt.trim() !== "" ? { prompt: c.prompt } : {}),
      ...(schedule === undefined ? {} : { schedule }),
      ...(c.run_now === true ? { run_now: true as const } : {}),
      ...(c.delete === true ? { delete: true as const } : {}),
    };
  } catch {
    return undefined;
  }
}

/** What a scheduled builder's agent reads after each scheduled prompt. */
const scheduledNote = (lead: string) =>
  `[Caveman Code] This runs on a schedule, on a Cloud computer of its own, for a chat on another computer. When your turn ends, your last answer goes back to that chat by itself: say what you found or did, and what needs the person. To reach the chat sooner, use t3_thread_send with threadId "${CLOUD_THREAD}${lead}".`;

const scheduleWakeText = (title: string, workspaceId: string, status: string, text: string) =>
  `[Cloud schedule "${title}" ${status === "completed" ? "ran" : status === "interrupted" ? "was stopped" : "failed"} (on its own Cloud computer, workspace ${workspaceId})]\n\n${text}`;

const wakeText = (title: string, where: string, workspaceId: string, status: string, text: string) =>
  `[Builder "${title}" ${status === "completed" ? "finished its turn" : status === "interrupted" ? "was stopped" : "failed"} (${where}, workspace ${workspaceId})]\n\n${text}`;

/**
 * What a hosted builder pushed, from its result's trailer, and with it the tokens its turns have used so far when it
 * says them; undefined when it is not that. The tokens ride in the trailer a lead's runtime already strips, so a lead
 * from before them shows its agent nothing new, and no token count ever reads as a builder's words.
 */
function pushedOf(text: string): { readonly branch: string; readonly sha: string; readonly tokens?: number } | undefined {
  try {
    const value = JSON.parse(text.trim()) as { branch?: unknown; sha?: unknown; tokens?: unknown };
    if (typeof value.branch !== "string" || !value.branch.startsWith("caveman/") || typeof value.sha !== "string" || !/^[0-9a-f]{40,64}$/.test(value.sha)) return undefined;
    const tokens = typeof value.tokens === "number" && Number.isSafeInteger(value.tokens) && value.tokens >= 0 ? value.tokens : undefined;
    return { branch: value.branch, sha: value.sha, ...(tokens === undefined ? {} : { tokens }) };
  } catch {
    return undefined;
  }
}

/** What a builder's Cloud computer answers when it could not start it for want of room (deliver), as its lead reads it. */
const TURNED_AWAY = `Its Cloud computer could not start it: ${COMPUTER_FULL}`;

/** A conflict mail's lead branch and the words for the builder; undefined when it is not one. */
function conflictOf(body: string): { readonly branch: string; readonly files: ReadonlyArray<string>; readonly text: string } | undefined {
  const end = body.indexOf("\n");
  if (end < 0) return undefined;
  try {
    const value = JSON.parse(body.slice(CONFLICT_MAIL.length, end)) as { branch?: unknown; files?: unknown };
    // The files: a lead from before them names none.
    const files = Array.isArray(value.files) ? value.files.filter((file): file is string => typeof file === "string") : [];
    return typeof value.branch === "string" && value.branch.startsWith("caveman/") ? { branch: value.branch, files, text: body.slice(end + 1) } : undefined;
  } catch {
    return undefined;
  }
}

/** What a paused builder reads when its plan's window has reset (the words a chat's own usage-limit recovery uses). */
export const RESUME_TEXT = "Continue where you left off.";
/** A refusal that named no reset: the builders try again after this long. */
const RETRY_UNKNOWN_RESET_MS = 60 * 60_000;
/** An engine as a note names it. */
const ENGINE_NAMES: Readonly<Record<string, string>> = { "claude-agent": "Claude Agent", codex: "Codex", caveman: "Caveman" };
const engineName = (engine: string) => (Object.hasOwn(ENGINE_NAMES, engine) ? ENGINE_NAMES[engine]! : engine);
/**
 * The one note a lead gets when a plan runs out under its builders: whose plan (by the engine it ran out under), and
 * when it resets. Never an amount: spend stays out of a session (CLAUDE.md), and what a plan holds is not public (PLAN §9).
 *
 * `across`: the lead's tree runs on more than one engine (a Claude Agent lead with Codex builders). One engine's plan
 * running out stops that engine's builders alone, so the note says which builders pause, that the others keep working,
 * and (when it is the lead's own plan) that their results reach the lead at the reset.
 */
export const usedUpNote = (
  resetsAt: string | null | undefined,
  now: number,
  timeZone: string | undefined,
  plan: { readonly engine: string; readonly across?: { readonly stops: boolean; readonly lead: boolean } },
) => {
  const until = untilText(resetsAt, now, timeZone);
  const when = until === undefined ? "when it resets" : "then";
  const title = `Your ${planName(plan.engine)} is used up${until === undefined ? "" : ` until ${until}`}.`;
  const across = plan.across;
  if (across === undefined) return { title, body: `Your agents pause and carry on ${when}.` };
  if (!across.stops) return { title, body: across.lead ? `Your agents keep working and report back ${when}.` : "Your agents keep working." };
  const stops = `Your agents on ${engineName(plan.engine)} pause and carry on ${when}.`;
  return { title, body: `${stops} ${across.lead ? `The others keep working and report back ${when}.` : "The others keep working."}` };
};
/**
 * A pause's key: a lead's tree and the engine whose plan ran out. A plan belongs to an engine (a Claude plan, a
 * compact plan, the Caveman engine's own), so one running out says nothing of the others: a Claude Agent lead's Codex
 * builders go on when its Claude plan is used up. A key with no engine is a pause an earlier build kept, for them all.
 */
const pauseKey = (leadId: string, engine: string) => `${leadId}@${engine}`;
const pauseKeyParts = (tree: string): { readonly lead: string; readonly engine: string | undefined } => {
  const at = tree.indexOf("@");
  return at < 0 ? { lead: tree, engine: undefined } : { lead: tree.slice(0, at), engine: tree.slice(at + 1) };
};
/** A turn the plan refused: out of usage, whichever engine said so. */
const refusedByPlan = (event: SessionEvent | undefined) => event?.type === "turn.done" && event.payload.status === "failed" && event.payload.failure?.class === "usage_limit";
/** When a refusal said the plan resets: the newest engine.status among these events that names it. */
const resetIn = (events: ReadonlyArray<SessionEvent>) => {
  for (let at = events.length - 1; at >= 0; at--) {
    const event = events[at]!;
    if (event.type === "engine.status" && event.payload.rate_limit?.resets_at !== undefined) return event.payload.rate_limit.resets_at;
  }
  return undefined;
};
interface Pause {
  readonly tree: string;
  readonly resets_at: string | null;
  readonly since: string;
}

/** A chat in one of these is at work: the integration step waits for its turn to end. */
const BUSY = new Set(["starting", "working", "needs_input", "waiting"]);

export const makeBuilderRoute = (deps: BuilderRouteDeps) =>
  Effect.gen(function* () {
    const { sql, store } = deps;
    for (const statement of SCHEMA) yield* sql.unsafe(statement).pipe(Effect.orDie);
    const rows = (where: { role?: Role; lead?: string; key?: string; workspace?: string }) =>
      sql<Row>`SELECT * FROM caveman_sp_builders WHERE 1 = 1
        ${where.role === undefined ? sql`` : sql`AND role = ${where.role}`}
        ${where.lead === undefined ? sql`` : sql`AND lead_workspace_id = ${where.lead}`}
        ${where.key === undefined ? sql`` : sql`AND request_key = ${where.key}`}
        ${where.workspace === undefined ? sql`` : sql`AND workspace_id = ${where.workspace}`}
        ORDER BY created_at, request_key`.pipe(Effect.orDie);
    /** `why`: a builder that failed, why in one sentence of ours (its row reads "Failed: <why>"). */
    const put = (row: Row, why?: string) =>
      sql`INSERT INTO caveman_sp_builders (role, lead_workspace_id, request_key, workspace_id, title, engine, state, reported_cursor, summary, cloud, created_at)
          VALUES (${row.role}, ${row.lead_workspace_id}, ${row.request_key}, ${row.workspace_id}, ${row.title}, ${row.engine}, ${row.state}, ${row.reported_cursor}, ${row.summary}, ${row.cloud}, ${row.created_at})
          ON CONFLICT (role, lead_workspace_id, request_key) DO UPDATE SET workspace_id = excluded.workspace_id, state = excluded.state,
            reported_cursor = excluded.reported_cursor, summary = excluded.summary, cloud = excluded.cloud`.pipe(Effect.asVoid, Effect.orDie, Effect.andThen(keepState(row, why)));
    /**
     * What a builder here reads as for its row (Workspace.builder), kept beside it in caveman_sp_builder_states from its
     * row, its merge and its engine's pause, and its chat's clients told when it changes. A builder on another computer
     * has no chat here to carry it: the computer that runs it keeps its row (hosted, below), and its lead's one result
     * names it. A builder Cloud started here for a lead elsewhere reads as what this computer knows of it: at work,
     * done, paused or failed. Whether its work is merged is its lead's to say (the lead's one result).
     */
    const keepState = (row: Row, why?: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (row.role === "remote" || row.workspace_id === null) return;
        const hosted = row.role === "hosted";
        const before = (yield* sql<{ state: string }>`SELECT state FROM caveman_sp_builder_states WHERE workspace_id = ${row.workspace_id}`.pipe(Effect.orDie))[0];
        const previous = before === undefined ? undefined : (JSON.parse(before.state) as BuilderState);
        const merge = hosted ? undefined : (yield* sql<MergeRow>`SELECT * FROM caveman_sp_builder_merges WHERE lead_workspace_id = ${row.lead_workspace_id} AND request_key = ${row.request_key}`.pipe(Effect.orDie))[0];
        const pause = row.state !== "paused" ? undefined : hosted ? yield* pauseOf(`hosted:${row.request_key}`) : yield* pauseFor(row.lead_workspace_id, row.engine);
        const state = JSON.stringify(builderStateOf(row, merge === undefined ? undefined : { ...merge, files: filesOf(merge) }, pause, why ?? (previous?.state === "failed" ? previous.why : undefined)));
        if (before?.state === state) return;
        yield* sql`INSERT INTO caveman_sp_builder_states (workspace_id, state) VALUES (${row.workspace_id}, ${state}) ON CONFLICT (workspace_id) DO UPDATE SET state = excluded.state`.pipe(Effect.orDie);
        const record = yield* store.getWorkspace(row.workspace_id);
        if (record !== undefined) yield* store.publishWorkspace(record.workspace);
      });
    const keepStates = (leadId: string) => rows({ lead: leadId }).pipe(Effect.flatMap((found) => Effect.forEach(found, (row) => keepState(row), { discard: true })));
    const drop = (row: Pick<Row, "role" | "lead_workspace_id" | "request_key">) =>
      sql`DELETE FROM caveman_sp_builders WHERE role = ${row.role} AND lead_workspace_id = ${row.lead_workspace_id} AND request_key = ${row.request_key}`.pipe(Effect.asVoid, Effect.orDie);
    const cloudOf = (row: Row) => (row.cloud === null ? undefined : (JSON.parse(row.cloud) as CloudSide));
    /** One lead's starts at a time: its count and a retry's lookup see every start before them. */
    const leadLocks = new Map<string, Semaphore.Semaphore>();
    const leadLock = (id: string) => {
      let lock = leadLocks.get(id);
      if (lock === undefined) leadLocks.set(id, (lock = Semaphore.makeUnsafe(1)));
      return lock;
    };
    /** Results go one at a time per builder, so two turn.done events never send one result twice. */
    const reportLock = Semaphore.makeUnsafe(1);
    const cloudCall = <A>(run: (identity: Identity, state: LinkState) => Promise<A>) =>
      Effect.suspend(() => {
        const link = deps.link();
        if (link === undefined) return Effect.fail(new BuilderError({ reason: "unavailable", message: "This runtime has no Caveman link, so builders cannot start on Cloud computers. Sign in to Caveman first." }));
        return Effect.tryPromise({ try: () => run(link.identity, link.state), catch: builderErrorOf });
      });

    const startedOf = (row: Row) =>
      Effect.gen(function* () {
        if (row.workspace_id === null) return undefined;
        const side = cloudOf(row);
        // A builder here runs what its own chat runs; one elsewhere, what its spawn named.
        const builder = row.role === "local" ? yield* store.getWorkspace(row.workspace_id) : undefined;
        const model = builder !== undefined ? yield* deps.modelOf(builder) : side?.model;
        return {
          workspaceId: row.workspace_id,
          ...(row.role === "local" ? { threadId: `caveman:${row.workspace_id}` } : {}),
          where: row.role === "local" ? "here" : "cloud",
          ...(side?.computer_id ? { computerId: side.computer_id } : {}),
          ...(side?.named_computer ? { computerName: side.named_computer } : {}),
          title: row.title,
          engine: row.engine,
          ...(model ? { model } : {}),
        } satisfies BuilderStarted;
      });

    const leadCloudId = (lead: WorkspaceRecord) =>
      Effect.gen(function* () {
        const known = yield* sql<{ cloud_workspace_id: string }>`SELECT cloud_workspace_id FROM caveman_sp_builder_leads WHERE workspace_id = ${lead.workspace.id}`.pipe(Effect.orDie);
        if (known[0]) return known[0].cloud_workspace_id;
        const id = yield* deps.registerLead(lead).pipe(Effect.mapError((e) => new BuilderError({ reason: "unavailable", message: e.message })));
        yield* sql`INSERT OR IGNORE INTO caveman_sp_builder_leads (workspace_id, cloud_workspace_id) VALUES (${lead.workspace.id}, ${id})`.pipe(Effect.orDie);
        return id;
      });

    const thisComputer = () => deps.link()?.identity.computerId;

    const start = (input: BuilderStart): Effect.Effect<BuilderStarted | undefined, BuilderError> =>
      Effect.gen(function* () {
        // Cloud refuses both (mailbox.go Spawn): the computer named, or a new one, never both.
        if (input.where !== undefined && input.computerId !== undefined)
          return yield* new BuilderError({ reason: "invalid_request", message: "Name computerId or where, not both." });
        // This runtime's own computer is here: as if none was named.
        const computerId = input.computerId === thisComputer() ? undefined : input.computerId;
        const elsewhere = input.where === "cloud" || computerId !== undefined;
        const lead = yield* store.getByThread(input.parentThreadId);
 // Not a Caveman Code chat, or This Mac's own children: upstream delegated child, as before.
        if (lead === undefined || (!deps.onComputer && !elsewhere && input.schedule === undefined)) return undefined;
        // An automation's run or step (daemon.ts adoptAutomationRun: delegated, no parent) is no lead: its delegates
 // finish inside its turn, so they are upstream waiting children wherever it runs, never a Cloud computer's builders.
        if (lead.internal.delegated === true && lead.workspace.parent_workspace_id === undefined) {
          if (input.where === "cloud")
            return yield* new BuilderError({ reason: "invalid_request", message: "An automation's helpers work where it runs; a Cloud computer of their own (where \"cloud\") is for a chat's builders. Delegate without where." });
          if (computerId !== undefined)
            return yield* new BuilderError({ reason: "invalid_request", message: "An automation's helpers work where it runs; another computer (computerId) is for a chat's builders. Delegate without computerId." });
          if (input.schedule !== undefined)
            return yield* new BuilderError({ reason: "invalid_request", message: "An automation's run cannot set a schedule on Cloud; a chat's agent can." });
          return undefined;
        }
        // A schedule sleeps between runs on a Cloud computer of its own; Cloud picks it.
        if (input.schedule !== undefined && computerId !== undefined)
          return yield* new BuilderError({ reason: "invalid_request", message: "A schedule runs on a Cloud computer of its own: name no computerId." });
        if (lead.workspace.parent_workspace_id !== undefined)
          return yield* new BuilderError({ reason: "invalid_request", message: "A builder does its own work: only its lead starts builders. Message the lead if the work needs more hands." });
        return yield* leadLock(lead.workspace.id).withPermits(1)(
          Effect.gen(function* () {
            const mine = (yield* rows({ lead: lead.workspace.id })).filter((r) => r.role !== "hosted");
            const again = mine.find((r) => r.request_key === input.requestKey);
            if (again !== undefined) {
              const started = yield* startedOf(again);
              if (started !== undefined) return started;
            }
            // New from here on: the same limits as any delegation, then the lead's own count of its builders, by the
            // same number (Settings > Agents'). Both count builders at work only: one that finished gave its slot back.
            if (input.admit !== undefined) yield* input.admit;
            const allowed = Math.min(yield* deps.agentsAtOnce, MAX_BUILDERS_PER_LEAD);
            if (mine.filter((r) => AT_WORK.has(r.state)).length >= allowed)
              return yield* new BuilderError({
                reason: "limit_reached",
                message: `Not started: this lead runs ${allowed === 1 ? "one builder" : `${allowed} builders`} at once, and ${allowed === 1 ? "it is" : "they are"} all at work. Wait for one to finish (its result wakes you), then start the next.`,
              });
            const held = deps.leadMayStart === undefined ? undefined : yield* deps.leadMayStart(lead);
            if (held !== undefined) return yield* new BuilderError({ reason: "limit_reached", message: held });
            const title = (input.title ?? input.task.split("\n")[0] ?? "Builder").trim().slice(0, 80) || "Builder";
            const engine = input.engine ?? lead.workspace.engine;
            // The model asked for, else the lead's when the builder runs the lead's engine, as a builder here gets it.
            const model = input.model ?? (engine === lead.workspace.engine ? yield* deps.modelOf(lead) : undefined);
            const base: Row = { role: "local", lead_workspace_id: lead.workspace.id, request_key: input.requestKey, workspace_id: null, title, engine, state: "starting", reported_cursor: 0, summary: null, cloud: null, created_at: nowIso() };
            // A schedule always runs on a Cloud computer of its own: one that can sleep between runs and be woken for each.
            if (input.schedule === undefined && !elsewhere && deps.onComputer && (yield* deps.freeSlots) > 0) {
              yield* put(base);
              const made = yield* deps
                .createLocal({ requestId: `builder:${input.requestKey}`, lead, title, engine, ...(model === undefined ? {} : { model }), task: `${input.task}\n\n${localNote}` })
                .pipe(Effect.result);
              if (made._tag === "Success") {
                const row: Row = { ...base, workspace_id: made.success.workspace.id, state: "running" };
                yield* put(row);
                return (yield* startedOf(row))!;
              }
              if (made.failure.message !== COMPUTER_FULL) {
                yield* put({ ...base, state: "failed" });
                return yield* new BuilderError({ reason: "invalid_request", message: made.failure.message });
              }
              // Full after all: another chat took the last place, or Cloud counts one more chat here than this
              // computer does (one it placed that has yet to start). Nothing was made; Cloud places this builder,
              // on a computer of the project that has room or a new one.
              yield* drop(base);
            }
            // Before anything is asked of Cloud: a Cloud computer has no ACP agent's CLI.
            if (!CLOUD_ENGINES.has(engine))
              return yield* new BuilderError({
                reason: "invalid_request",
                message: `A Cloud computer runs the Caveman engine, Claude Agent or Codex (caveman, claude-agent, codex), not ${engine}. Pick one of those for a builder there, or run it on this computer.`,
              });
            // A named computer Cloud just listed as one that cannot take it: Cloud would take the spawn, and its builder
            // would never start (it wakes no computer nothing pays for, mailbox.go post).
            const refusal = computerId === undefined ? undefined : yield* refusalFor(computerId);
            if (refusal !== undefined) return yield* new BuilderError({ reason: "invalid_request", message: refusal });
            // A Cloud computer through Cloud's mailbox: the one named, else one of its own.
            const leadCloud = yield* leadCloudId(lead);
            yield* deps.shareBranch(lead);
            const spawned = yield* cloudCall((identity, state) =>
              spawnBuilder(identity, state, {
                request_id: `builder:${input.requestKey}`,
                from_workspace_id: leadCloud,
                title,
                brief: input.task,
                branch: builderBranch(title, input.requestKey),
                engine,
                ...(model === undefined ? {} : { model }),
                // The lead's Cloud workspace holds this chat's session (its registration, or its copy's).
                lead_session_id: lead.session.id,
                ...(computerId !== undefined ? { computer_id: computerId } : input.where === "cloud" || input.schedule !== undefined ? { where: "cloud" as const } : {}),
                ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
              }),
            );
            const side: CloudSide = {
              workspace_id: spawned.workspace.id,
              lead_workspace_id: leadCloud,
              spawn_mail_id: spawned.message.id,
              computer_id: spawned.workspace.computer_id,
              ...(model === undefined ? {} : { model }),
              ...(computerId === undefined ? {} : { named_computer: listedComputer(computerId)?.computer.name || computerId }),
              // Kept until it answers: should its computer turn it away as full, it is started again with it. Not for a
              // computer the lead named (it asked for that one), nor a schedule's.
              ...(computerId === undefined && input.schedule === undefined ? { brief: input.task } : {}),
            };
            const row: Row = { ...base, role: "remote", workspace_id: spawned.workspace.id, state: "running", cloud: JSON.stringify(side) };
            yield* put(row);
            wakeReader();
            return (yield* startedOf(row))!;
          }),
        );
      });

    const status = (workspaceId: string) =>
      Effect.gen(function* () {
        const row = (yield* rows({ workspace: workspaceId })).find((r) => r.role !== "hosted") ?? (yield* placedAgainAs(workspaceId));
        if (row === undefined) return undefined;
        const started = yield* startedOf(row);
        if (started === undefined) return undefined;
        const state = row.state === "completed" || row.state === "failed" ? row.state : "running";
        return { ...started, state, ...(row.summary === null ? {} : { summary: row.summary }) } satisfies BuilderStatus;
      });

    /** The builder on another computer that Cloud workspace `id` was, before Cloud was asked to place it again. */
    const placedAgainAs = (id: string) => rows({ role: "remote" }).pipe(Effect.map((found) => found.find((r) => cloudOf(r)?.earlier?.includes(id) === true)));

    const tree = (leadThreadId: string) =>
      Effect.gen(function* () {
        const lead = yield* store.getByThread(leadThreadId);
        if (lead === undefined) return { running: 0, threadIds: [] as ReadonlyArray<string>, tokens: 0 };
        const mine = (yield* rows({ lead: lead.workspace.id })).filter((r) => r.role !== "hosted");
        return {
          running: mine.filter((r) => AT_WORK.has(r.state)).length,
          threadIds: mine.flatMap((r) => (r.role === "local" && r.workspace_id !== null ? [`caveman:${r.workspace_id}`] : [])),
          // What each builder on another computer last said it has used: the tree's ceiling counts them with the rest.
          tokens: mine.reduce((sum, r) => sum + (r.role === "remote" ? (cloudOf(r)?.tokens ?? 0) : 0), 0),
        };
      });

    // ------------------------------------------------------------ the person's computers

    type Link = { readonly identity: Identity; readonly state: LinkState };
    const linkKey = (link: Link) => `${link.identity.cloudUrl}\0${link.identity.computerId}`;
    /** What a lead's agent is told, kept until `until`: Cloud's list COMPUTERS_TTL_MS, a failure or no answer COMPUTERS_RETRY_MS. */
    let listed: { readonly key: string; readonly until: number; readonly out: BuilderComputers } | undefined;
    /** The person's computers as Cloud last listed them: a named computer's name, and whether it can take a builder. */
    let lastList: { readonly key: string; readonly seq: number; readonly computers: ReadonlyArray<CloudComputer> } | undefined;
    /** Counts Cloud's lists: a refusal knows a list came after the one it doubted even within one millisecond. */
    let listSeq = 0;
    /** The one request to Cloud in flight: callers meanwhile wait on it, and its answer fills `listed` even after they stopped waiting. */
    let asking: { readonly key: string; readonly answer: Promise<BuilderComputers>; settled: boolean } | undefined;

    const askCloud = (link: Link, key: string) => {
      if (asking !== undefined && asking.key === key) return asking;
      const request: { key: string; answer: Promise<BuilderComputers>; settled: boolean } = { key, answer: Promise.resolve({ computers: [] }), settled: false };
      request.answer = listCloudComputers(link.identity, link.state)
        .then(
          (value) => {
            if (value.available) lastList = { key, seq: ++listSeq, computers: value.computers };
            const out: BuilderComputers = value.available ? builderTargets(value.computers, link.identity.computerId) : { computers: [], note: "This Caveman Cloud runs no Cloud computers." };
            return { out, keep: COMPUTERS_TTL_MS };
          },
          (error: unknown) => ({ out: { computers: [], note: `Caveman Cloud did not list its computers: ${error instanceof Error ? error.message : String(error)}` } satisfies BuilderComputers, keep: COMPUTERS_RETRY_MS }),
        )
        .then(({ out, keep }) => {
          request.settled = true;
          if (asking === request) asking = undefined;
          listed = { key, until: Date.now() + keep, out };
          return out;
        });
      asking = request;
      return request;
    };

    /** Cloud's list of the person's computers (computers?mine=true), kept a while: an agent may ask before each delegation. */
    const cloudComputers = (link: Link) =>
      Effect.gen(function* () {
        const key = linkKey(link);
        if (listed !== undefined && listed.key === key && Date.now() < listed.until) return listed.out;
        const request = askCloud(link, key);
        const answer = yield* Effect.promise(() => request.answer).pipe(Effect.timeoutOption(`${COMPUTERS_TIMEOUT_MS} millis`));
        if (Option.isSome(answer)) return answer.value;
        const out: BuilderComputers = { computers: [], note: "Caveman Cloud did not answer in time." };
        // Callers in the next few seconds hear the same at once; Cloud's answer, when it comes, replaces it.
        if (!request.settled) listed = { key, until: Date.now() + COMPUTERS_RETRY_MS, out };
        return out;
      });

    /** A computer of the person's as Cloud last listed it for this link, and which list that was. */
    const listedComputer = (id: string) => {
      const link = deps.link();
      if (link === undefined || lastList === undefined || lastList.key !== linkKey(link)) return undefined;
      const computer = lastList.computers.find((c) => c.id === id);
      return computer === undefined ? undefined : { computer, seq: lastList.seq };
    };

    /**
     * Why a named computer cannot take a builder, or undefined to let Cloud place it. A "no" from the last list is asked
     * of Cloud again first, so a computer started or paid for since is not refused; no fresh answer leaves it to Cloud.
     */
    const refusalFor = (id: string) =>
      Effect.gen(function* () {
        const cached = listedComputer(id);
        const link = deps.link();
        if (cached === undefined || cannotTake(cached.computer) === undefined || link === undefined) return undefined;
        const request = askCloud(link, linkKey(link));
        yield* Effect.promise(() => request.answer).pipe(Effect.timeoutOption(`${COMPUTERS_TIMEOUT_MS} millis`));
        const now = listedComputer(id);
        return now === undefined || now.seq === cached.seq ? undefined : cannotTake(now.computer);
      });

    const computers = (threadId: string) =>
      Effect.gen(function* () {
        const lead = yield* store.getByThread(threadId);
        if (lead === undefined) return { computers: [], note: NOT_A_LEAD } satisfies BuilderComputers;
        if (lead.workspace.parent_workspace_id !== undefined || lead.internal.delegated === true)
          return { computers: [], note: "A builder does its own work: only its lead sends builders to other computers." } satisfies BuilderComputers;
        const link = deps.link();
        if (link === undefined) return { computers: [], note: "Signed out of Caveman Cloud: sign in to send builders to Cloud computers." } satisfies BuilderComputers;
        return yield* cloudComputers(link);
      });

 // Only a record with a lead here (a builder, upstream child): an automation's run or step is marked delegated too, but
    // has no lead, so the desktop is its own.
    const sharesComputer = (threadId: string) =>
      store.getByThread(threadId).pipe(Effect.map((record) => record?.workspace.parent_workspace_id !== undefined));

    // ------------------------------------------------------------ mail across computers

    /** Who speaks for `from` in Cloud and whether `to` is its tree mate on another computer (Cloud's ids both). */
    const remotePair = (from: WorkspaceRecord, to: string) =>
      Effect.gen(function* () {
        const remote = (yield* rows({ role: "remote", lead: from.workspace.id })).find((r) => r.workspace_id === to || cloudOf(r)?.earlier?.includes(to) === true);
        // A builder Cloud placed again goes by its new workspace there, whichever of its ids the lead's agent names.
        if (remote !== undefined) return { from: cloudOf(remote)!.lead_workspace_id, to: remote.workspace_id ?? to };
        const hosted = (yield* rows({ role: "hosted", workspace: from.workspace.id }))[0];
        const side = hosted === undefined ? undefined : cloudOf(hosted);
        if (side !== undefined && side.lead_workspace_id === to) return { from: side.workspace_id, to };
        return undefined;
      });

    /** A task, note or ask to a tree mate on another computer, through Cloud; undefined when `to` is none. */
    const sendRemote = (from: WorkspaceRecord, to: string, verb: "task" | "note" | "ask", body: string, requestId: string, replyTo?: string) =>
      Effect.gen(function* () {
        const pair = yield* remotePair(from, to);
        if (pair === undefined) return undefined;
        return yield* cloudCall((identity, state) =>
          sendTreeMail(identity, state, verb, { request_id: requestId, from_workspace_id: pair.from, to_workspace_id: pair.to, body, ...(replyTo ? { reply_to: replyTo } : {}) }),
        );
      });

    const message = (input: { readonly fromThreadId: string; readonly toThreadId: string; readonly text: string; readonly requestKey: string; readonly ask: boolean }) =>
      Effect.gen(function* () {
        if (!input.toThreadId.startsWith(CLOUD_THREAD)) return undefined;
        const from = yield* store.getByThread(input.fromThreadId);
        if (from === undefined) return undefined;
        const to = input.toThreadId.slice(CLOUD_THREAD.length);
        const sent = yield* sendRemote(from, to, input.ask ? "ask" : "task", input.text, `message:${input.requestKey}`);
        if (sent === undefined) return yield* new BuilderError({ reason: "invalid_request", message: `${input.toThreadId} is no builder or lead of this chat's on another computer.` });
        return { id: sent.id };
      });

    /** Cloud's id for a workspace here whose tree spans computers (a lead with a builder on Cloud, a builder Cloud spawned here). */
    const spanning = (me: WorkspaceRecord) =>
      Effect.gen(function* () {
        const hosted = (yield* rows({ role: "hosted", workspace: me.workspace.id }))[0];
        if (hosted !== undefined) return cloudOf(hosted)!.workspace_id;
        const remote = (yield* rows({ role: "remote", lead: me.workspace.id }))[0];
        return remote === undefined ? undefined : cloudOf(remote)!.lead_workspace_id;
      });

    /** Path claims in a tree that spans computers are Cloud's (one place every computer of the tree sees); undefined: local. */
    const claim = (me: WorkspaceRecord, paths: ReadonlyArray<string>, requestId: string) =>
      Effect.gen(function* () {
        const id = yield* spanning(me);
        if (id === undefined) return undefined;
        const out = yield* cloudCall((identity, state) => claimPaths(identity, state, { request_id: requestId, from_workspace_id: id, paths }));
        const local = (c: { path: string; workspace_id: string }) => ({ path: c.path, workspace_id: c.workspace_id === id ? me.workspace.id : c.workspace_id });
        return { claims: out.claims.map(local), conflicts: out.conflicts.map(local) };
      });
    const release = (me: WorkspaceRecord, paths: ReadonlyArray<string> | undefined, requestId: string) =>
      Effect.gen(function* () {
        const id = yield* spanning(me);
        if (id === undefined) return undefined;
        return yield* cloudCall((identity, state) => releasePaths(identity, state, { request_id: requestId, from_workspace_id: id, paths: paths ?? [] }));
      });

    // ------------------------------------------------------------ out of usage, together (P8)

    const pauseOf = (tree: string) => sql<Pause>`SELECT * FROM caveman_sp_builder_pauses WHERE tree = ${tree}`.pipe(Effect.orDie, Effect.map((found) => found[0]));
    /** The pause that holds a lead's builders on `engine`: that engine's, or one an earlier build kept for them all. */
    const pauseFor = (leadId: string, engine: string) => pauseOf(pauseKey(leadId, engine)).pipe(Effect.flatMap((own) => (own !== undefined ? Effect.succeed<Pause | undefined>(own) : pauseOf(leadId))));
    /**
     * The plan of `engine` refused somewhere in a lead's tree: every builder of it on that engine still at work on
     * this computer stops at its next tool boundary, and the lead reads one note, however many builders it has and
     * however many of them meet the refusal themselves. The latest reset any of them heard stands. Builders on other
     * computers meet the same refusal at their own next model call, which is their next tool boundary. Builders on
     * another engine run on another plan and go on.
     */
    const planRefused = (leadId: string, engine: string, resetsAt: string | undefined): Effect.Effect<void> =>
      Effect.gen(function* () {
        const lead = yield* store.getWorkspace(leadId);
        if (lead === undefined) return;
        const before = yield* pauseFor(leadId, engine);
        const at = [before?.resets_at ?? undefined, resetsAt].filter((t): t is string => t !== undefined).sort().at(-1) ?? null;
        const key = before?.tree ?? pauseKey(leadId, engine);
        yield* sql`INSERT INTO caveman_sp_builder_pauses (tree, resets_at, since) VALUES (${key}, ${at}, ${nowIso()}) ON CONFLICT (tree) DO UPDATE SET resets_at = excluded.resets_at`.pipe(Effect.orDie);
        const all = yield* rows({ lead: leadId });
        const stopping = all.filter((row) => row.role === "local" && row.engine === engine && (row.state === "running" || row.state === "starting") && row.workspace_id !== null);
        if (before === undefined) {
          // The tree spans engines when the lead or any builder still at work is on another one: the note then names
          // the engine whose plan it is. On one engine it reads as it always has.
          const working = all.filter((row) => row.role !== "hosted" && AT_WORK.has(row.state));
          const across = lead.workspace.engine !== engine || working.some((row) => row.engine !== engine);
          const said = usedUpNote(at, Date.now(), undefined, { engine, ...(across ? { across: { stops: working.some((row) => row.engine === engine), lead: lead.workspace.engine === engine } } : {}) });
          yield* deps.note(lead, said.title, said.body);
        }
        // Its builders' rows read "Paused until" the reset, the latest one heard.
        yield* keepStates(leadId);
        for (const row of stopping) {
          const builder = yield* store.getWorkspace(row.workspace_id!);
          yield* put({ ...row, state: "paused" });
          if (builder !== undefined) yield* deps.windDown(builder, `plan-pause:${builder.session.id}:${builder.session.head}`);
        }
      });
    /** A lead's own turn was refused while its builders work: the ones on its engine stop with it, and what the others finish waits for it. */
    const leadRefused = (lead: WorkspaceRecord) =>
      Effect.gen(function* () {
        if (!(yield* rows({ lead: lead.workspace.id })).some((r) => r.role !== "hosted" && AT_WORK.has(r.state))) return;
        yield* planRefused(lead.workspace.id, lead.workspace.engine, (yield* deps.planReset(lead)) ?? resetIn(yield* store.readEvents(lead.session.id, Math.max(0, lead.session.head - 100), lead.session.head)));
      });
    /**
     * Pauses whose window has reset: every paused builder of the tree starts again, together, and the results that
     * waited go to the lead. The pause goes last, so a pass a crash cut short runs again and wakes nobody twice.
     */
    const resumeDue = Effect.gen(function* () {
      for (const pause of yield* sql<Pause>`SELECT * FROM caveman_sp_builder_pauses`.pipe(Effect.orDie)) {
        const due = pause.resets_at === null ? Date.parse(pause.since) + RETRY_UNKNOWN_RESET_MS : Date.parse(pause.resets_at);
        if (Number.isFinite(due) && Date.now() < due) continue;
        const hosted = pause.tree.startsWith("hosted:");
        // A lead's pause is one engine's: its builders on that engine start again; one with no engine is for them all.
        const of = pauseKeyParts(pause.tree);
        const tree = hosted ? [] : (yield* rows({ lead: of.lead })).filter((r) => r.role !== "hosted");
        const mine = hosted ? yield* rows({ role: "hosted", key: pause.tree.slice("hosted:".length) }) : tree.filter((r) => of.engine === undefined || r.engine === of.engine);
        for (const row of mine) {
          if (row.state !== "paused") continue;
          const builder = row.role === "remote" || row.workspace_id === null ? undefined : yield* store.getWorkspace(row.workspace_id);
          // One already at work again (the person wrote to it, or its own recovery continued it) needs no second push.
          if (builder !== undefined && !BUSY.has(builder.workspace.status)) yield* deps.wake(builder, { requestId: `plan-resume:${builder.session.id}:${pause.since}`, text: RESUME_TEXT, generated: { shown: RESUME_SHOWN } }).pipe(Effect.ignore);
          yield* put({ ...row, state: "running" });
        }
        yield* sql`DELETE FROM caveman_sp_builder_pauses WHERE tree = ${pause.tree}`.pipe(Effect.orDie);
        // Every builder of the lead here, not only this engine's: a result that waited for the lead's own plan is
        // another engine's builder's as often as not.
        for (const row of hosted ? mine : tree) if (row.role === "local") yield* report(row).pipe(Effect.ignore);
        if (!hosted) integrateSoon(of.lead);
      }
    });

    // ------------------------------------------------------------ results

    /** The paths a worktree holds that are not committed (changed, or new and not ignored); none when git cannot say. */
    const uncommittedIn = (worktree: string) =>
      deps
        .git(worktree)(["status", "--porcelain", "--untracked-files=normal"], { allowNonZeroExit: true })
        .pipe(
          Effect.map((r) => (r.exitCode === 0 ? r.stdout.split("\n").filter((line) => line.length > 3).map((line) => line.slice(3)) : [])),
          Effect.orElseSucceed((): Array<string> => []),
        );

    /** A builder's turns that ended since it last reported: each wakes its lead, here or by mail, once. */
    const report = (row: Row) =>
      reportLock.withPermits(1)(
        Effect.gen(function* () {
          const current = (yield* rows({ role: row.role, lead: row.lead_workspace_id, key: row.request_key }))[0];
          if (current === undefined || current.workspace_id === null) return;
          const builder = yield* store.getWorkspace(current.workspace_id);
          if (builder === undefined) return;
          const events = yield* store.readEvents(builder.session.id, current.reported_cursor, builder.session.head);
          const done = events.filter((e) => e.type === "turn.done");
          if (done.length === 0) return;
          const last = done[done.length - 1]!;
          const ended = resultOf(events, last.cursor);
          // Work it did not commit is not on its branch, so not in the pull request: its lead reads that with its answer.
          const loose = ended.status === "completed" && builder.internal.worktreePath ? yield* uncommittedIn(builder.internal.worktreePath) : [];
          const result = loose.length === 0 ? ended : { ...ended, text: `${ended.text}\n\n[Not committed in its worktree, so not on its branch: ${loose.slice(0, 8).join(", ")}${loose.length > 8 ? ` and ${loose.length - 8} more` : ""}]` };
          const settled = { ...current, state: result.status === "completed" ? ("completed" as const) : ("failed" as const), summary: result.text };
          // Out of usage (P8). The plan refused this turn, or its tree is paused for the plan and this turn was stopped
          // for it: the builder is paused, not failed, and no result goes to its lead, which reads one note for them all.
          const usedUp = refusedByPlan(last);
          const tree = current.role === "local" ? current.lead_workspace_id : `hosted:${current.request_key}`;
          // Its own engine's pause: a turn of its that ended unfinished under one was stopped for it.
          const pause = current.role === "local" ? yield* pauseFor(tree, current.engine) : yield* pauseOf(tree);
          if (usedUp || (pause !== undefined && result.status !== "completed")) {
            yield* put({ ...current, state: "paused", reported_cursor: last.cursor });
            if (!usedUp) return;
            const reset = (yield* deps.planReset(builder)) ?? resetIn(events);
            if (current.role === "local") return yield* planRefused(current.lead_workspace_id, current.engine, reset);
            // A builder for a lead elsewhere pauses by itself here, and its lead hears "paused", once, not a failure.
            const resetsAt = reset ?? null;
            yield* sql`INSERT INTO caveman_sp_builder_pauses (tree, resets_at, since) VALUES (${tree}, ${resetsAt}, ${nowIso()}) ON CONFLICT (tree) DO UPDATE SET resets_at = excluded.resets_at`.pipe(Effect.orDie);
            const side = cloudOf(current)!;
            yield* cloudCall((identity, state) =>
              sendTreeMail(identity, state, "task", { request_id: `paused:${side.workspace_id}:${last.cursor}`, from_workspace_id: side.workspace_id, to_workspace_id: side.lead_workspace_id, body: `[paused] ${resetsAt ?? ""}`, reply_to: side.spawn_mail_id }),
            ).pipe(Effect.ignore);
            return;
          }
          // Its state is what happened to the builder, kept before the lead hears of it: a lead woken by the result
          // that asks for its status sees it ended. reported_cursor moves only once the result is delivered.
          // Why it failed, in our words: the chat's own sentence when its agent said one, else by the failure's class.
          const why = settled.state === "failed" && last.type === "turn.done" ? failedWhy({ ...last.payload, error: [last.payload.error, result.text].filter(Boolean).join(" ") }) : undefined;
          yield* put(settled, why);
          if (current.role === "local") {
            const lead = yield* store.getWorkspace(current.lead_workspace_id);
            // It finished while its lead's own plan is used up: the lead could not read its result now. It waits for
            // that plan's reset, whichever engine the builder itself runs on.
            if (lead !== undefined && (yield* pauseFor(current.lead_workspace_id, lead.workspace.engine)) !== undefined) return;
            if (lead !== undefined && lead.workspace.status !== "archived") {
              // A lead that cannot take it now (parked) gets it on a later pass: reported_cursor stays.
              const woke = yield* deps
                .wake(lead, { requestId: `builder-result:${builder.session.id}:${last.cursor}`, text: wakeText(current.title, "on this computer", builder.workspace.id, result.status, result.text), from: builder, generated: { shown: resultShown(current.title, result.status) } })
                .pipe(Effect.option);
              if (woke._tag === "None") return;
            }
          } else if (current.role === "hosted") {
            const side = cloudOf(current)!;
            // Its branch goes to GitHub before its lead hears: the lead's computer fetches it to merge (integration.ts).
            const pushed = result.status === "completed" ? yield* deps.publishBranch(builder) : undefined;
            // With what it pushed, the tokens its turns have used so far: its lead's tree counts them toward its ceiling.
            const tokens = pushed === undefined || deps.tokensOf === undefined ? undefined : yield* deps.tokensOf(builder);
            const sent = yield* cloudCall((identity, state) =>
              sendTreeMail(identity, state, "task", {
                request_id: `result:${side.workspace_id}:${last.cursor}`,
                from_workspace_id: side.workspace_id,
                to_workspace_id: side.lead_workspace_id,
                body: `[${result.status}] ${result.text}${pushed === undefined ? "" : `${BRANCH_TRAILER}${JSON.stringify({ ...pushed, ...(tokens === undefined ? {} : { tokens }) })}`}`,
                reply_to: side.spawn_mail_id,
              }),
            ).pipe(Effect.option);
            // Cloud away: the next pass sends it (reported_cursor did not move).
            if (sent._tag === "None") return;
          }
          yield* put({ ...settled, reported_cursor: last.cursor }, why);
          if (current.role === "local") integrateSoon(current.lead_workspace_id);
        }),
      );

    // ------------------------------------------------------------ one branch, one pull request (integration.ts)

    const mergesOf = (lead: string) =>
      sql<MergeRow>`SELECT * FROM caveman_sp_builder_merges WHERE lead_workspace_id = ${lead}`.pipe(
        Effect.orDie,
        Effect.map((found) => new Map(found.map((m) => [m.request_key, m]))),
      );
    const putMerge = (m: MergeRow) =>
      sql`INSERT INTO caveman_sp_builder_merges (lead_workspace_id, request_key, state, sha, rounds, detail)
          VALUES (${m.lead_workspace_id}, ${m.request_key}, ${m.state}, ${m.sha}, ${m.rounds}, ${m.detail})
          ON CONFLICT (lead_workspace_id, request_key) DO UPDATE SET state = excluded.state, sha = excluded.sha, rounds = excluded.rounds, detail = excluded.detail`.pipe(
        Effect.asVoid,
        Effect.orDie,
        Effect.andThen(rows({ lead: m.lead_workspace_id, key: m.request_key })),
        Effect.flatMap((found) => Effect.forEach(found, (row) => keepState(row), { discard: true })),
      );
    const filesOf = (m: MergeRow | undefined): ReadonlyArray<string> => {
      try {
        const value: unknown = m?.detail ? JSON.parse(m.detail) : [];
        return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      } catch {
        return [];
      }
    };
    /** Leads whose builders changed since their last pass, and the pass that last ran to its end, by what it saw. */
    const dirty = new Set<string>();
    const passed = new Map<string, string>();
    let pokeIntegration: () => void = () => undefined;
    const integrateSoon = (lead: string) => {
      if (lead === "") return;
      dirty.add(lead);
      pokeIntegration();
    };

    /**
     * Brings a lead's finished builders' branches into its own and, once none of them is at work, opens the one pull
     * request and tells the lead once. Waits (does nothing) while a builder works or the lead's own turn runs: the
     * next turn's end runs it again. Every step is safe to run twice (see integration.ts), so a pass a crash cut
     * short is simply run again.
     */
    const integrate = (leadId: string): Effect.Effect<void> =>
      leadLock(leadId)
        .withPermits(1)(
          Effect.gen(function* () {
            const lead = yield* store.getWorkspace(leadId);
            const worktree = lead?.internal.worktreePath;
            if (lead === undefined || !worktree || lead.workspace.status === "archived" || BUSY.has(lead.workspace.status)) return;
            const mine = (yield* rows({ lead: leadId })).filter((r) => r.role !== "hosted" && !r.request_key.startsWith(SCHEDULE_KEY));
            if (mine.length === 0 || mine.some((r) => AT_WORK.has(r.state))) return;
            const builders = new Map<string, WorkspaceRecord>();
            for (const row of mine) {
              const record = row.role === "local" && row.workspace_id !== null ? yield* store.getWorkspace(row.workspace_id) : undefined;
              if (record !== undefined) builders.set(row.request_key, record);
            }
            // A builder here whose own turn runs again (its lead wrote to it) is not finished, whatever its row says yet.
            if ([...builders.values()].some((b) => BUSY.has(b.workspace.status))) return;
            const saw = JSON.stringify(mine.map((r) => [r.request_key, r.state, builders.get(r.request_key)?.session.head ?? cloudOf(r)?.sha ?? r.summary]));
            if (passed.get(leadId) === saw) return;
            const merges = yield* mergesOf(leadId);
            const branchOf = (row: Row) => builders.get(row.request_key)?.workspace.branch ?? (row.cloud === null ? undefined : cloudOf(row)?.branch) ?? builderBranch(row.title, row.request_key);

            // Every finished builder not left out for good, oldest first: the order the merges are made in. A lead
            // that works in several sources has them in each source, where a builder's branch has the same name.
            const several = severalSources(lead);
            const sources: Array<SourceCandidates> = [];
            for (const checkout of gitCheckoutsOf(lead)) {
              const candidates: Array<Candidate> = [];
              for (const row of mine) {
                if (row.state !== "completed" || merges.get(row.request_key)?.state === "left_out") continue;
                const branch = branchOf(row);
                if (row.role === "local") candidates.push({ key: row.request_key, title: row.title, branch, ref: `refs/heads/${branch}` });
                else {
                  // On another computer: its branch as it pushed it, fetched beside the lead's (never onto a branch here).
                  // A fetch that failed leaves what an earlier pass fetched: a branch already merged stays merged, and
                  // only one that never arrived names no commit (missing).
                  const into = `refs/caveman/builders/${row.workspace_id}`;
                  yield* deps.fetchBranch(lead, branch, into, checkout.worktreePath);
                  candidates.push({ key: row.request_key, title: row.title, branch, ref: into });
                }
              }
              sources.push({ name: checkout.name, git: deps.git(checkout.worktreePath), candidates });
            }
            if (sources.length === 0) return;
            const merged = several ? yield* mergeAcrossSources(sources) : yield* mergeBranches(sources[0]!.git, sources[0]!.candidates);
            if (merged.held !== undefined) {
              // In words a person reads; why git held it goes to the log.
              yield* Effect.logInfo(`builders: the merge into ${lead.workspace.branch} of ${leadId} is held: ${merged.held}`);
              yield* deps.note(lead, "Your agents' work is waiting to merge.", "Commit or set aside this chat's own changes. It merges by itself then.");
              return;
            }
            let sentBack = 0;
            for (const outcome of merged.outcomes) {
              const row = mine.find((r) => r.request_key === outcome.key)!;
              const before = merges.get(outcome.key);
              const base = { lead_workspace_id: leadId, request_key: outcome.key, rounds: before?.rounds ?? 0 };
              if (outcome.kind === "merged") yield* putMerge({ ...base, state: "merged", sha: outcome.sha, detail: null });
              else if (outcome.kind === "missing") yield* putMerge({ ...base, state: "left_out", sha: null, detail: JSON.stringify(BRANCH_MISSING) });
              else if (base.rounds >= MAX_CONFLICT_ROUNDS) yield* putMerge({ ...base, state: "left_out", sha: outcome.sha, detail: JSON.stringify(outcome.files) });
              else {
                // Back to its author, with the files named. The row says it works again before the message goes, so a
                // start never takes its place meanwhile; a message that did not go is sent again by the next pass.
                const round = base.rounds + 1;
                const text = conflictText({ branch: branchOf(row), leadBranch: lead.workspace.branch, files: outcome.files, round, ...(several ? { sources: sources.map((source) => source.name) } : {}) });
                const builder = builders.get(outcome.key);
                const sent =
                  builder !== undefined
                    ? yield* deps.wake(builder, { requestId: `integration-conflict:${builder.session.id}:${builder.session.head}`, text, from: lead, generated: { shown: conflictShown(outcome.files) } }).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
                    : yield* deps.shareBranch(lead).pipe(
                        Effect.andThen(sendRemote(lead, row.workspace_id!, "task", `${CONFLICT_MAIL}${JSON.stringify({ branch: lead.workspace.branch, files: outcome.files })}\n${text}`, `integration-conflict:${row.workspace_id}:${round}`)),
                        Effect.map((mail) => mail !== undefined),
                        Effect.orElseSucceed(() => false),
                      );
                if (!sent) continue;
                yield* putMerge({ ...base, state: "conflict", sha: outcome.sha, rounds: round, detail: JSON.stringify(outcome.files) });
                yield* put({ ...row, state: "running" });
                sentBack += 1;
              }
            }
            if (sentBack > 0) {
              wakeReader();
              return;
            }
            passed.set(leadId, saw);

            // Nobody is at work and nothing is owed: what the lead and the pull request say, once per outcome.
            const now = yield* mergesOf(leadId);
            const results: Array<BuilderResult> = mine.map((row) => {
              const m = now.get(row.request_key);
              const common = { title: row.title, branch: branchOf(row), note: shortNote(row.summary ?? "") };
              if (row.state !== "completed") return { ...common, state: "left_out" as const, why: `it did not finish${row.summary ? ` (${shortNote(row.summary, 160)})` : ""}` };
              if (m?.state === "merged") return { ...common, state: "merged" as const };
              const files = filesOf(m);
              return { ...common, state: "left_out" as const, why: files.length > 0 || m?.sha ? leftOutForConflict(files, m?.rounds ?? 0) : BRANCH_MISSING };
            });
            const digest = createHash("sha256").update(JSON.stringify([merged.head, results])).digest("hex").slice(0, 16);
            const settled = (yield* sql<{ settled: string; pull_request: string | null }>`SELECT settled, pull_request FROM caveman_sp_integrations WHERE lead_workspace_id = ${leadId}`.pipe(Effect.orDie))[0];
            if (settled?.settled === digest) return;
            const opened = results.some((r) => r.state === "merged")
              ? yield* deps.openPullRequest(lead, { requestId: `integration:${leadId}:${digest}`, title: lead.workspace.title, body: describeResult(results) }).pipe(Effect.result)
              : undefined;
            const pullRequest = opened?._tag === "Success" ? opened.success.url : undefined;
            // The same as data, for the lead's one row: who is not in and why (as each one's own row says it), and the
            // pull requests, by repository when the lead works in several.
            const pullRequests = opened?._tag === "Success" ? (opened.success.pullRequests ?? []) : [];
            const failed = new Map<string, string>();
            for (const row of mine) {
              if (row.state === "completed" || row.role !== "local" || row.workspace_id === null) continue;
              const kept = (yield* sql<{ state: string }>`SELECT state FROM caveman_sp_builder_states WHERE workspace_id = ${row.workspace_id}`.pipe(Effect.orDie))[0];
              const said = kept === undefined ? undefined : (JSON.parse(kept.state) as BuilderState);
              if (said?.state === "failed" && said.why !== undefined) failed.set(row.request_key, said.why);
            }
            const builtResult: BuildersResult = {
              total: mine.length,
              merged: results.filter((r) => r.state === "merged").length,
              left_out: mine.flatMap((row) => {
                const m = now.get(row.request_key);
                if (row.state === "completed" && m?.state === "merged") return [];
                // A builder that failed: the sentence its own row says after "Failed: ", from the one place that keeps it.
                const why = row.state !== "completed" ? (failed.get(row.request_key) ?? NOT_FINISHED) : leftOutWhy(m === undefined ? undefined : { sha: m.sha, files: filesOf(m) });
                return [{ ...(row.role === "local" && row.workspace_id !== null ? { workspace_id: row.workspace_id } : {}), title: row.title, why }];
              }),
              pull_requests: pullRequests.map((pr) => ({ number: pr.number, url: pr.url, ...(several && pr.repo !== undefined ? { repo: pr.repo } : {}) })),
              ...(pullRequests.length > 0 ? {} : { problem: opened === undefined ? NOTHING_MERGED : PULL_REQUEST_REFUSED }),
            };
            const woke = yield* deps
              .wake(lead, {
                requestId: `integration-done:${leadId}:${digest}`,
                text: leadSummary({ branch: lead.workspace.branch, results, ...(pullRequest === undefined ? {} : { pullRequest }), ...(opened?._tag === "Failure" ? { pullRequestProblem: opened.failure.message } : {}), ...(several ? { several: true } : {}) }),
                generated: { shown: resultRow(builtResult), builders_result: builtResult },
              })
              .pipe(Effect.as(true), Effect.orElseSucceed(() => false));
            // Told: kept, so the same outcome is never said twice. Not told (the lead cannot take it now): the next pass.
            if (!woke) return void passed.delete(leadId);
            yield* sql`INSERT INTO caveman_sp_integrations (lead_workspace_id, settled, pull_request) VALUES (${leadId}, ${digest}, ${pullRequest ?? settled?.pull_request ?? null})
                ON CONFLICT (lead_workspace_id) DO UPDATE SET settled = excluded.settled, pull_request = excluded.pull_request`.pipe(Effect.orDie);
          }),
        )
        .pipe(Effect.catchCause((cause) => Effect.logWarning(`builders: bringing the builders' work of ${leadId} together failed`, cause)));

    /** What became of a lead's builders' branches, and its pull request once opened. */
    const integrationOf = (leadId: string) =>
      Effect.gen(function* () {
        const merges = yield* mergesOf(leadId);
        const settled = (yield* sql<{ pull_request: string | null }>`SELECT pull_request FROM caveman_sp_integrations WHERE lead_workspace_id = ${leadId}`.pipe(Effect.orDie))[0];
        return {
          settled: settled !== undefined,
          ...(settled?.pull_request ? { pullRequest: settled.pull_request } : {}),
          builders: (yield* rows({ lead: leadId })).filter((r) => r.role !== "hosted").map((r) => ({ key: r.request_key, title: r.title, state: r.state, merge: merges.get(r.request_key)?.state, rounds: merges.get(r.request_key)?.rounds ?? 0 })),
        };
      });

    // ------------------------------------------------------------ the tree's mail

    let wakeReader: () => void = () => undefined;

    /**
     * Asks Cloud to place a builder again, after the Cloud computer it was placed on turned it away as full: the same
     * builder (its row, its branch, its brief) under a new request, so Cloud makes it a new workspace where there is
     * room now. True when Cloud placed it; false when it was asked MAX_PLACED_AGAIN times already, its brief is not
     * kept, or Cloud refused (a limit), and the lead then hears the refusal as it would have.
     */
    const placeAgain = (remote: Row, lead: WorkspaceRecord) =>
      leadLock(lead.workspace.id).withPermits(1)(
        Effect.gen(function* () {
          const row = (yield* rows({ role: "remote", lead: remote.lead_workspace_id, key: remote.request_key }))[0];
          const side = row === undefined ? undefined : cloudOf(row);
          const again = (side?.again ?? 0) + 1;
          if (row === undefined || side === undefined || side.brief === undefined || again > MAX_PLACED_AGAIN || row.workspace_id === null) return false;
          yield* deps.shareBranch(lead);
          const spawned = yield* cloudCall((identity, state) =>
            spawnBuilder(identity, state, {
              request_id: `builder:${row.request_key}:again-${again}`,
              from_workspace_id: side.lead_workspace_id,
              title: row.title,
              brief: side.brief!,
              branch: builderBranch(row.title, row.request_key),
              engine: row.engine,
              ...(side.model === undefined ? {} : { model: side.model }),
              lead_session_id: lead.session.id,
            }),
          ).pipe(Effect.result);
          if (spawned._tag === "Failure") {
            yield* Effect.logWarning(`builders: ${row.title} was turned away as full and Cloud did not place it again: ${spawned.failure.message}`);
            return false;
          }
          const next: CloudSide = {
            ...side,
            workspace_id: spawned.success.workspace.id,
            spawn_mail_id: spawned.success.message.id,
            computer_id: spawned.success.workspace.computer_id,
            again,
            earlier: [...(side.earlier ?? []), row.workspace_id],
          };
          yield* put({ ...row, workspace_id: spawned.success.workspace.id, state: "running", cloud: JSON.stringify(next) });
          wakeReader();
          return true;
        }),
      ).pipe(Effect.orElseSucceed(() => false));

    /** A mail for a workspace here: a spawn makes the builder, a result wakes its lead, a lead's message wakes its builder. */
    const deliver = (mail: TreeMail) =>
      Effect.gen(function* () {
        const spawn = spawnPayloadOf(mail);
        if (mail.verb === "spawn") {
          if (spawn === undefined) return "skip" as const;
          const known = (yield* rows({ role: "hosted", key: mail.id }))[0];
          if (known?.workspace_id) return "done" as const;
          const side: CloudSide = {
            workspace_id: spawn.workspace_id,
            session_id: spawn.session_id,
            lead_workspace_id: spawn.lead_workspace_id || mail.from_workspace_id || "",
            ...(spawn.lead_session_id ? { lead_session_id: spawn.lead_session_id } : {}),
            spawn_mail_id: mail.id,
          };
          const base: Row = { role: "hosted", lead_workspace_id: "", request_key: mail.id, workspace_id: null, title: spawn.title || "Builder", engine: spawn.engine, state: "starting", reported_cursor: 0, summary: null, cloud: JSON.stringify(side), created_at: nowIso() };
          // Registered before anything is made: a runtime that stops midway makes it when the mail comes again.
          yield* put(base);
          // A scheduled builder's chat waits for its schedule; the rest start on the brief at once.
          const scheduled = spawn.schedule;
          const made = yield* deps
            .createLocal({
              requestId: `spawn:${mail.id}`,
              title: base.title,
              engine: spawn.engine,
              ...(spawn.model ? { model: spawn.model } : {}),
              ...(scheduled === undefined ? { task: `${mail.body}\n\n${hostedNote(side.lead_workspace_id)}` } : {}),
              repo: spawn.repo,
              baseBranch: spawn.base_branch,
              branch: spawn.branch,
              sessionId: spawn.session_id,
            })
            .pipe(
              Effect.flatMap((record) =>
                scheduled === undefined
                  ? Effect.succeed({ record, taskId: undefined })
                  : deps
                      .holdSchedule(record, { requestId: `spawn:${mail.id}`, title: base.title, prompt: `${mail.body}\n\n${scheduledNote(side.lead_workspace_id)}`, schedule: scheduled })
                      .pipe(Effect.map((taskId) => ({ record, taskId: taskId as string | undefined }))),
              ),
              Effect.result,
            );
          if (made._tag === "Failure") {
            // It cannot start here: the lead hears why (once, by request id) instead of waiting for a result that never comes.
            yield* Effect.logWarning(`builders: the spawn ${mail.id} could not start here: ${made.failure.message}`);
            // Full: this computer holds fewer chats than Cloud believed when it placed the builder here (createLocal told
            // Cloud its room before it answered). Cloud's rows for it are closed, and its lead, reading TURNED_AWAY,
            // asks Cloud to place it again.
            if (made.failure.message === COMPUTER_FULL && deps.turnedAway !== undefined)
              yield* deps.turnedAway({ workspaceId: side.workspace_id, sessionId: spawn.session_id, title: base.title, engine: spawn.engine });
            yield* cloudCall((identity, state) =>
              sendTreeMail(identity, state, "task", {
                request_id: `result:${side.workspace_id}:start`,
                from_workspace_id: side.workspace_id,
                to_workspace_id: side.lead_workspace_id,
                body: `[failed] Its Cloud computer could not start it: ${made.failure.message}`,
                reply_to: mail.id,
              }),
            );
            yield* put({ ...base, state: "failed", summary: made.failure.message });
            return "done" as const;
          }
          const { record, taskId } = made.success;
          yield* put({ ...base, workspace_id: record.workspace.id, state: "running", cloud: JSON.stringify({ ...side, ...(taskId === undefined ? {} : { schedule_task_id: taskId }) } satisfies CloudSide) });
          return "done" as const;
        }
        if (mail.verb !== "task" && mail.verb !== "note" && mail.verb !== "ask") return "done" as const;
        // A result from a builder on its own computer, to its lead here.
        const remote = (yield* rows({ role: "remote" })).find((r) => {
          const side = cloudOf(r);
          return side !== undefined && (side.spawn_mail_id === mail.reply_to || (side.workspace_id === mail.from_workspace_id && side.lead_workspace_id === mail.to_workspace_id));
        });
        if (remote !== undefined) {
          const lead = yield* store.getWorkspace(remote.lead_workspace_id);
          const status = /^\[(completed|interrupted|failed)\] /.exec(mail.body)?.[1] ?? "completed";
          // What it pushed rides after its answer, for this runtime alone.
          const trailer = mail.body.lastIndexOf(BRANCH_TRAILER);
          const pushed = trailer < 0 ? undefined : pushedOf(mail.body.slice(trailer + BRANCH_TRAILER.length));
          const text = (pushed === undefined ? mail.body : mail.body.slice(0, trailer)).replace(/^\[(completed|interrupted|failed)\] /, "");
          // Its plan refused it where it runs: it is paused there and starts again there. Here the lead's other builders
          // stop with it, and the lead reads the one note, never a result that failed.
          if (/^\[paused\] /.test(mail.body)) {
            yield* put({ ...remote, state: "paused" });
            const resetsAt = mail.body.slice("[paused] ".length).trim();
            yield* planRefused(remote.lead_workspace_id, remote.engine, Number.isFinite(Date.parse(resetsAt)) ? resetsAt : undefined);
            return "done" as const;
          }
          // Its Cloud computer turned it away as full, and told Cloud its room first: Cloud is asked to place it again, on
          // another computer of the project or a new one, and the lead hears nothing of it unless that fails too.
          if (status === "failed" && text === TURNED_AWAY && lead !== undefined && lead.workspace.status !== "archived" && (yield* placeAgain(remote, lead))) return "done" as const;
          // A Cloud schedule's builder reports every run; it stays read until its schedule ends.
          const scheduleId = remote.request_key.startsWith(SCHEDULE_KEY) ? remote.request_key.slice(SCHEDULE_KEY.length) : undefined;
          // A lead that cannot take it now leaves the mail unacknowledged: Cloud hands it out again.
          const named = cloudOf(remote)?.named_computer;
          const wakeWith = scheduleId === undefined ? wakeText(remote.title, named ? `on Cloud computer ${named}` : "on its own Cloud computer", remote.workspace_id!, status, short(text)) : scheduleWakeText(remote.title, remote.workspace_id!, status, short(text));
          if (lead !== undefined && lead.workspace.status !== "archived" && mail.wakes)
            yield* deps.wake(lead, { requestId: `builder-mail:${mail.id}`, text: wakeWith, generated: { shown: resultShown(remote.title, status) } }).pipe(Effect.orDie);
          if (lead !== undefined) yield* deps.keep(lead, mail);
          // Last, unlike a builder here: this runtime reads Cloud's mail only while a remote builder runs, so a row
          // marked ended before its result was taken would leave a redelivery after a crash unread.
          const lives = scheduleId === undefined ? false : (yield* deps.scheduleRan(scheduleId, { status, text: short(text) })) === "live";
          // It has answered: its brief is kept no longer.
          const { brief: _answered, ...sideNow } = cloudOf(remote)!;
          yield* put({
            ...remote,
            state: lives ? "running" : status === "completed" ? "completed" : "failed",
            summary: short(text),
            cloud: JSON.stringify({ ...sideNow, ...pushed } satisfies CloudSide),
          });
          integrateSoon(remote.lead_workspace_id);
          return "done" as const;
        }
        // The lead's message to a builder Cloud spawned here.
        const hosted = (yield* rows({ role: "hosted" })).find((r) => cloudOf(r)?.workspace_id === mail.to_workspace_id);
        // Its schedule's controls, from its lead only, change the scheduled task it holds and never wake its agent.
        const held = hosted === undefined ? undefined : cloudOf(hosted);
        if (hosted !== undefined && held?.schedule_task_id !== undefined && mail.body.startsWith(SCHEDULE_CONTROL)) {
          if (mail.from_workspace_id !== held.lead_workspace_id) return "done" as const;
          const parsed = parseControl(mail.body.slice(SCHEDULE_CONTROL.length));
          if (parsed === undefined) return "done" as const;
          // A new prompt keeps the note on where its answer goes.
          const control = parsed.prompt === undefined ? parsed : { ...parsed, prompt: `${parsed.prompt}\n\n${scheduledNote(held.lead_workspace_id)}` };
          yield* deps.controlSchedule(held.schedule_task_id, control).pipe(
            Effect.catch((error) => Effect.logWarning(`builders: the schedule control ${mail.id} could not be applied: ${error.message}`)),
          );
          if (control.delete === true) yield* put({ ...hosted, state: "completed" });
          return "done" as const;
        }
        if (hosted?.workspace_id) {
          const builder = yield* store.getWorkspace(hosted.workspace_id);
          // Its branch conflicts with its lead's (integration.ts): the lead's branch is fetched here first, so the merge
          // it is asked for has something to merge, and it reads the words alone.
          const conflict = mail.body.startsWith(CONFLICT_MAIL) && mail.from_workspace_id === held?.lead_workspace_id ? conflictOf(mail.body) : undefined;
          if (conflict !== undefined && builder !== undefined) yield* deps.refreshBranch(builder, conflict.branch);
          const body = conflict === undefined ? mail.body : conflict.text;
          if (builder !== undefined && builder.workspace.status !== "archived" && mail.wakes)
            yield* deps
              .wake(builder, {
                requestId: `lead-mail:${mail.id}`,
                text: `[${mail.verb} from your lead (thread ${CLOUD_THREAD}${mail.from_workspace_id})]\n\n${body}`,
                generated: { shown: conflict === undefined ? leadMailShown(body) : conflictShown(conflict.files) },
              })
              .pipe(Effect.orDie);
          if (builder !== undefined) yield* deps.keep(builder, mail);
        }
        return "done" as const;
      });

    /** Whether this runtime has anything to read: a Cloud computer always (spawns), This Mac while a builder runs on Cloud. */
    const reading = Effect.gen(function* () {
      if (deps.onComputer) return true;
      return (yield* rows({ role: "remote" })).some((r) => r.state === "running" || r.state === "starting");
    });

    const takeOnce = Effect.gen(function* () {
      const taken = yield* cloudCall((identity, state) => takeTreeMail(identity, state));
      if (taken.lease === null) return 0;
      const acked: Array<string> = [];
      for (const mail of taken.messages) {
        const outcome = yield* deliver(mail).pipe(Effect.catchCause((cause) => Effect.logWarning(`builders: mail ${mail.id} failed`, cause).pipe(Effect.as("retry" as const))));
        if (outcome !== "retry") acked.push(mail.id);
      }
      if (acked.length > 0) yield* cloudCall((identity, state) => ackTreeMail(identity, state, taken.lease!, acked));
      return taken.messages.length;
    });

    /**
     * Until there is tree mail for this computer: Cloud's long wait for the whole computer; a Cloud without it (it
     * answers 400 or 404) gets the long wait on each lead here with a builder on Cloud, and a Cloud computer a pause.
     */
    let computerWait = true;
    const waitForMail = Effect.gen(function* () {
      if (computerWait) {
        const link = deps.link();
        if (link === undefined) return;
        const out = yield* Effect.tryPromise({ try: () => waitTreeComputer(link.identity, link.state, WAIT_MS), catch: (error) => error }).pipe(Effect.result);
        if (out._tag === "Success") return;
        const older = out.failure instanceof CloudError && (out.failure.status === 400 || out.failure.status === 404);
        if (!older) return yield* Effect.fail(new BuilderError({ reason: "unavailable", message: String(out.failure) }));
        computerWait = false;
      }
      if (deps.onComputer) return yield* Effect.sleep(`${TREE_POLL_MS} millis`);
      yield* waitOnLeads;
    });
    /** This Mac on an older Cloud: its long wait on each lead with a builder on Cloud; any mail, then a take. */
    const waitOnLeads = Effect.gen(function* () {
      const leads = new Set<string>();
      for (const r of yield* rows({ role: "remote" })) if (r.state === "running" || r.state === "starting") leads.add(cloudOf(r)!.lead_workspace_id);
      if (leads.size === 0) return;
      yield* Effect.raceAll(
        [...leads].slice(0, 8).map((lead) =>
          cloudCall((identity, state) => waitTreeMail(identity, state, { workspace_id: lead, timeout_ms: WAIT_MS })).pipe(
            Effect.flatMap((out) => (out.messages.length > 0 ? Effect.void : Effect.never)),
          ),
        ).concat([Effect.sleep(`${WAIT_MS} millis`)]),
      );
    });

    const run = (scope: Scope.Scope) =>
      Effect.gen(function* () {
        const woken = yield* Queue.unbounded<void>();
        wakeReader = () => void Queue.offerUnsafe(woken, undefined);
        // Integration runs on a fiber of its own: a pass over fifty branches never holds up results or mail.
        const poked = yield* Queue.sliding<void>(1);
        pokeIntegration = () => void Queue.offerUnsafe(poked, undefined);
        yield* Effect.forever(
          Queue.take(poked).pipe(
            Effect.flatMap(() => Effect.forEach([...dirty], (lead) => Effect.sync(() => dirty.delete(lead)).pipe(Effect.andThen(integrate(lead))), { discard: true })),
          ),
        ).pipe(Effect.forkIn(scope));
        // Results: every turn.done of a builder here; at start, what a restart left unsent.
        const events = yield* PubSub.subscribe(store.events);
        yield* Effect.forever(
          PubSub.take(events).pipe(
            Effect.flatMap((event) =>
              event.type !== "turn.done"
                ? Effect.void
                : store.getBySession(event.session_id).pipe(
                    // A lead's own turn ended: its builders' finished work may merge now; refused by the plan, they stop with it.
                    Effect.tap((record) => (record === undefined ? Effect.void : Effect.sync(() => integrateSoon(record.workspace.id)))),
                    Effect.tap((record) => (record !== undefined && refusedByPlan(event) ? leadRefused(record) : Effect.void)),
                    Effect.flatMap((record) => (record === undefined ? Effect.succeed([]) : rows({ workspace: record.workspace.id }))),
                    Effect.flatMap((found) => Effect.forEach(found.filter((r) => r.role !== "remote"), report, { discard: true })),
                  ),
            ),
            Effect.catchCause((cause) => Effect.logWarning("builders: reporting a result failed", cause)),
          ),
        ).pipe(Effect.forkIn(scope));
        // Paused builders start again when their plan's window resets, within moments of it.
        yield* Effect.forever(
          resumeDue.pipe(
            Effect.catchCause((cause) => Effect.logWarning("builders: resuming paused builders failed", cause)),
            Effect.andThen(Effect.sleep("5 seconds")),
          ),
        ).pipe(Effect.forkIn(scope));
        let backoff = TREE_POLL_MS;
        yield* Effect.forever(
          Effect.gen(function* () {
            for (const row of yield* rows({})) {
              if (row.role !== "remote" && row.workspace_id !== null) yield* report(row).pipe(Effect.ignore);
              // Every pass, and so at start: what a restart cut short is taken up again.
              if (row.role !== "hosted") integrateSoon(row.lead_workspace_id);
            }
            if (deps.link() === undefined || !(yield* reading)) {
              yield* Effect.race(Queue.take(woken), Effect.sleep("30 seconds"));
              return;
            }
            const outcome = yield* takeOnce.pipe(Effect.result);
            if (outcome._tag === "Failure") {
              yield* Effect.logWarning(`builders: reading the tree's mail failed: ${outcome.failure.message}`);
              yield* Effect.sleep(`${backoff} millis`);
              backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
              return;
            }
            backoff = TREE_POLL_MS;
            if (outcome.success > 0) return;
            yield* Effect.race(Queue.take(woken), waitForMail.pipe(Effect.catch(() => Effect.sleep(`${TREE_POLL_MS} millis`))));
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("builders: a pass failed", cause).pipe(Effect.andThen(Effect.sleep("5 seconds"))))),
        ).pipe(Effect.forkIn(scope));
      });

    /** A control to a Cloud schedule's builder (it wakes a sleeping one); undefined when the schedule has none yet. */
    const controlSchedule = (scheduleId: string, control: ScheduleControl, requestId: string) =>
      Effect.gen(function* () {
        const row = (yield* rows({ role: "remote" })).find((r) => r.request_key === `${SCHEDULE_KEY}${scheduleId}`);
        const side = row === undefined ? undefined : cloudOf(row);
        if (row === undefined || side === undefined) return undefined;
        const sent = yield* cloudCall((identity, state) =>
          sendTreeMail(identity, state, "task", {
            request_id: requestId,
            from_workspace_id: side.lead_workspace_id,
            to_workspace_id: side.workspace_id,
            body: `${SCHEDULE_CONTROL}${JSON.stringify(control)}`,
          }),
        );
        // An ended schedule's builder reports nothing more: stop reading for it.
        if (control.delete === true) yield* put({ ...row, state: "completed" });
        return sent;
      });

    /** Cloud's ids for the builder workspaces Cloud spawned on this computer and that still work. */
    const hostedWorkspaces = rows({ role: "hosted" }).pipe(
      Effect.map((found) => found.flatMap((r) => (r.state === "failed" || r.workspace_id === null ? [] : [cloudOf(r)!.workspace_id]))),
    );

    return { start, status, thisComputer, computers, tree, integrate, integrationOf, sharesComputer, message, sendRemote, claim, release, run, report, deliver, rows, hostedWorkspaces, controlSchedule } as const;
  });
