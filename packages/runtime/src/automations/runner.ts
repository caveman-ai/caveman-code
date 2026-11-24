// The AutomationRunner: admits runs (ids, concurrency, the revision they are pinned to), drives each one
// through the machine (steps as threads, checks, graders, picks, commits, timers, approvals, outputs), holds the
// run wallet, cancels (user Stop, superseded, deadline), and resumes what a restart left running. Every transition
// is journalled before it is acted on; the run's state is always the fold of its journal. What the machine asks
// for at once runs at once: a graph's ready steps, a parallel step's attempts, a timer beside a working step.
import { randomBytes, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { budgetOf, type BudgetLimits, type ParsedAgent } from "@caveman-app/automations";
import { ProjectId } from "@caveman-app/protocol";
import type { AutomationRunOutput } from "@caveman-app/session-protocol/protocol";
import * as GitHubCredentials from "@caveman-app/source-control-github/server/GitHubCredentials";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { CloudComputer } from "../cloudLink/index.ts";
import { toolsSocket } from "../cloudLink/tools.ts";
import * as ServerConfig from "../config.ts";
import { coAuthorOn, withCoAuthor } from "../git/coAuthor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunnerService from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { costSince, exhausted, sumCosts, walletOf } from "./budget.ts";
import type { OutputKind } from "./machine.ts";
import { commandFailure, heldNote, holdEntryPoints, putBackHeld, refusedText, reviewMessage, runCommandCheck, runCommandStep } from "./checks.ts";
import { makeJournal, recordOf, summaryOf, type Journal, type RunBase, type RunRow } from "./journal.ts";
import {
  DEFAULT_MODEL,
  NO_COST,
  NO_MODEL,
  addCost,
  attemptId,
  isTerminal,
  next,
  planOf,
  replay,
  stepKind,
  type Action,
  type CancelReason,
  type Cost,
  type PlanStep,
  type RunEvent,
  type RunState,
  type StepState,
} from "./machine.ts";
import {
  OutputError,
  applyPullRequest,
  changedTests,
  commentBody,
  commentMarker,
  commentPlace,
  commentTarget,
  issueOf,
  planPullRequest,
  prBody,
  prTitle,
  pullRequestPreview,
  testChangesNote,
  upsertComment,
  gitHubRest,
  type GitHubRest,
} from "./outputs.ts";
import { splitProjectRef } from "./drafts.ts";
import { fileAutomationId, parseFileAutomationId } from "./triggers.ts";
import { AutomationRunner, type AdmitRequest, type AdmitResult, type ApproveResult, type ChiefSink, type CloudComment, type CloudGitHub, type CloudPullRequest, type RoutineReport, type TriggerEvent } from "./services.ts";
export type { CloudComment, CloudGitHub, CloudPullRequest };
import {
  StepError,
  blocksFor,
  commandDecision,
  commitAll,
  contractOf,
  correctiveMessage,
  earlierSteps,
  type PreviousResult,
  firstMessage,
  gitOf,
  graderAgent,
  pickedAttempt,
  pickerAgent,
  gitOk,
  headOf,
  instructionsOf,
  makeCopy,
  makeRunWorktree,
  makeThreadEngine,
  parseResult,
  removeCopy,
  retryMessage,
  runBranch,
  squashSince,
  trustedGit,
  worktreeGit,
  type CommitIdentity,
  type Git,
  type RunVariables,
  type StepEngine,
  type StepLauncher,
} from "./steps.ts";

/** SEMANTICS §10.2 */
export const RUN_DEADLINE_MS = 2 * 3_600_000;
/** A12: runs going at once in one project; later admissions wait `queued` and start in admission order. */
export const MAX_RUNNING_PER_PROJECT = 3;
/** K2: a finished run's worktree stays this long (unless the project holds more than KEEP_WORKTREES of them). */
export const WORKTREE_KEEP_MS = 7 * 24 * 3_600_000;
export const KEEP_WORKTREES = 20;

export interface RunnerDeps {
  readonly journal: Journal;
  readonly engine: StepEngine;
  readonly git: Git;
  readonly processRunner: ProcessRunnerService.ProcessRunner["Service"];
  /** Absent: outputs that write to GitHub fail with a sign-in note. */
  readonly github: GitHubRest | undefined;
  /** A project's checkout. */
  readonly projectRoot: (projectId: string) => Effect.Effect<string | undefined>;
  /** Where run worktrees and throwaway copies go. */
  readonly worktreesDir: string;
  /** Settings > General > Git: the co-author trailer and the pull request footer. */
  readonly coAuthor: Effect.Effect<boolean>;
  /** Caps above the file's budget (org, user, environment); they only lower it. */
  readonly caps?: ReadonlyArray<BudgetLimits & { readonly source: string }>;
  /** How often the wallet is read while an agent works. */
  readonly pollMs?: number;
  /** §7.5: an output gets 3 tries, waiting this, then twice this, between them. */
  readonly outputRetryBase?: Duration.Input;
  readonly runDeadlineMs?: number;
  /** Production: the Session Protocol's launcher goes to the thread engine. */
  readonly setLauncher?: (launcher: StepLauncher) => Effect.Effect<void>;
  /** The environment command checks and command steps start from (checkEnv and stepEnv strip it). */
  readonly checkEnv?: NodeJS.ProcessEnv;
  /**
   * A Cloud computer: git and the agents run in the tools container, as another user of the computer's group, so the
   * folders runs work in are the group's to write. This Mac: one user, nothing to share.
   */
  readonly sharedWithTools?: boolean;
  /** Who the run's commits are by where git has no identity (a Cloud computer, no person's git config); absent: git's. */
  readonly commitIdentity?: CommitIdentity;
  /** Where runs happen, for the run record: This Mac, or a Caveman Cloud computer. */
  readonly environment?: "this-mac" | "cloud";
  /**
   * Caveman Cloud posts slack.message, linear.comment and jira.comment for a run (POST /code/runtime/outputs).
   * Absent (This Mac): a dry run shows them, and applying one says only Caveman Cloud posts it.
   */
  readonly post?: (input: CloudOutputPost) => Effect.Effect<{ readonly url?: string; readonly remoteId?: string }, OutputError>;
  /** Every journalled transition, after it is written: the Cloud host's step events, approvals and run record. */
  readonly observe?: (row: RunRow, event: RunEvent, state: RunState) => Effect.Effect<void>;
  /**
   * Caveman Cloud writes to GitHub for a hosted run (CORRECTNESS C1): the branch goes through Cloud's git proxy, the
   * pull request and the comment through Cloud's runtime routes, as the repository's App. Absent: the GitHub sign-in.
   */
  readonly cloudGitHub?: CloudGitHub;
  /** A Cloud computer: runs left going resume once a host says where they run (useHost), not before. */
  readonly awaitHost?: boolean;
  /**
   * The run's own variables for a command it runs at `cwd`, and their end with the run (the Session Protocol's
   * launcher: StepLauncher.runEnv, runEnded). Absent: its commands get none.
   */
  readonly runEnv?: (runId: string, cwd: string) => Effect.Effect<RunVariables | undefined>;
  readonly runEnded?: (runId: string) => Effect.Effect<void>;
}

/** What a host adds to the runner: where runs happen, how Cloud outputs are posted, who watches each transition. */
export interface RunHost {
  readonly environment: "this-mac" | "cloud";
  readonly post?: RunnerDeps["post"];
  readonly observe?: RunnerDeps["observe"];
  readonly cloudGitHub?: CloudGitHub;
}


/** One Cloud output: what to post, where, and the key that keeps a retried post from posting twice (§7.3). */
export interface CloudOutputPost {
  readonly runId: string;
  readonly kind: Extract<OutputKind, "slack.message" | "linear.comment" | "jira.comment">;
  /** slack: `<channel>` or `<channel>/<thread_ts>`; linear: the issue id; jira: the issue key. */
  readonly target: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

/**
 * A run's id: from its delivery (a redelivery is the same run, §8.2), else the ULID of its `manual:<ulid>` subject
 * (so a retried request is the same run, and an agent run's branch carries its id), else a fresh ULID (§0).
 */
export function runIdFor(automationId: string, delivery: string | undefined, subject?: string): string {
  if (delivery !== undefined) return `r_${createHash("sha256").update(`${automationId}\n${delivery}`).digest("hex").slice(0, 20)}`;
  const manual = /^manual:([0-9a-hjkmnp-tv-z]{26})$/i.exec(subject ?? "")?.[1];
  return `r_${(manual ?? ulid()).toLowerCase()}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A ULID: 48 bits of milliseconds, then 80 random bits, Crockford base32. */
export function ulid(now = Date.now()): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32]! + time;
  const random = randomBytes(16);
  let rest = "";
  for (let i = 0; i < 16; i++) rest += CROCKFORD[random[i]! % 32]!;
  return time + rest;
}

export const automationIdOf = (projectId: string, scope: string, name: string): string => `file:${projectId}:${scope}:${name}`;
/** B6: an agent run's automation id, so its runs list under the agent. */
export const agentAutomationIdOf = (projectId: string, agent: string): string => `agent:${projectId}:${agent}`;

/** A file automation's scope from its id (`file:<project>:<scope>:<name>`; project ids have colons of their own). */
export const scopeOfId = (automationId: string): string | undefined => (automationId.startsWith("file:") ? automationId.split(":").at(-2) : undefined);

/** The branch a run's full steps write: a Me automation's under caveman/local/, an agent run's its own (§6.1, A14, B6). */
export const branchOf = (row: Pick<RunRow, "automation" | "automationId" | "subject" | "runId">): string =>
  runBranch({
    automation: row.automation,
    subject: row.subject,
    scope: row.automationId.startsWith("agent:") ? "agent" : scopeOfId(row.automationId) === "me" ? "me" : "project",
    runId: row.runId,
  });

/**
 * F-6: the pull request a run is about, when its trigger says so: a pull_request.* event, a comment on a pull
 * request, or a manual subject that resolved to one (its payload has the pull request's head).
 */
export function prOf(trigger: TriggerEvent):
  | { readonly number: number; readonly repo: string; readonly headRef?: string; readonly headRepo?: string; readonly baseRef?: string; readonly baseSha?: string; readonly fork?: boolean }
  | undefined {
  const p = trigger.payload as Record<string, unknown> | undefined;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return undefined;
  const head = p.head !== null && typeof p.head === "object" ? (p.head as { ref?: unknown; sha?: unknown; repo?: unknown }) : undefined;
  const base = p.base !== null && typeof p.base === "object" ? (p.base as { ref?: unknown; sha?: unknown }) : undefined;
  const event = String(p.event ?? trigger.event ?? "");
  const isPull = event.startsWith("pull_request.") || typeof head?.sha === "string" || p.pull_request === true || p.is_pull_request === true;
  if (!isPull) return undefined;
  const number = typeof p.number === "number" ? p.number : issueOf(trigger.subject)?.number;
  if (number === undefined) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const headRepo = str(head?.repo) ?? str((head?.repo as { full_name?: unknown } | undefined)?.full_name) ?? str(p.head_repo);
  return {
    number,
    repo: typeof p.repo === "string" ? p.repo : ((i) => (i === undefined ? "" : `${i.owner}/${i.repo}`))(issueOf(trigger.subject)),
    ...(str(head?.ref) === undefined ? {} : { headRef: str(head?.ref)! }),
    ...(headRepo === undefined ? {} : { headRepo }),
    ...(str(base?.ref) === undefined ? {} : { baseRef: str(base?.ref)! }),
    ...(str(base?.sha) === undefined ? {} : { baseSha: str(base?.sha)! }),
    ...(p.fork === true ? { fork: true } : {}),
  };
}

const CLOUD_OUTPUT_KINDS = new Set<OutputKind>(["slack.message", "linear.comment", "jira.comment"]);
const pick = (value: unknown, ...keys: string[]): string | undefined => {
  let at: unknown = value;
  for (const key of keys) at = at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
  return typeof at === "string" && at !== "" ? at : typeof at === "number" ? String(at) : undefined;
};

/**
 * Where a Cloud output goes, from the trigger that fired the run (its payload is data, read only for these ids): a
 * Slack reply in the thread that mentioned @caveman (or the output's channel), a comment on the Linear or Jira issue.
 */
export function cloudOutputTarget(kind: CloudOutputPost["kind"], trigger: TriggerEvent, channel: string | undefined): string | undefined {
  const p = trigger.payload;
  if (kind === "slack.message") {
    if (channel !== undefined) return channel;
    const where = pick(p, "channel") ?? pick(p, "event", "channel");
    const thread = pick(p, "thread_ts") ?? pick(p, "event", "thread_ts") ?? pick(p, "ts") ?? pick(p, "event", "ts");
    return where === undefined ? undefined : thread === undefined ? where : `${where}/${thread}`;
  }
  if (kind === "linear.comment") return pick(p, "issue", "id") ?? pick(p, "issue_id") ?? pick(p, "data", "id");
  return pick(p, "issue", "key") ?? pick(p, "issue_key") ?? pick(p, "issue", "id");
}

/** What stopped an attempt from outside its agent. */
class Stopped extends Data.TaggedError("Stopped")<{ readonly reason: "timeout" | "budget_exhausted"; readonly message: string }> {}

/** One attempt in flight: its clock (agent turns and checks, §10.1), its spend so far, and its threads. */
interface Flight {
  /** On the monotonic clock (monotonicMs). */
  deadline: number;
  readonly timeoutMs: number;
  usageAtStart: Cost;
  readonly threads: Set<string>;
}

interface Approval {
  readonly answer: Deferred.Deferred<{ readonly decision: "approve" | "reject"; readonly by?: string; readonly message?: string }>;
  /** Done once the answer is journalled, so automation.approve returns the run as it is after it. */
  readonly recorded: Deferred.Deferred<void>;
}

interface Live {
  readonly runId: string;
  row: RunRow;
  state: RunState;
  fiber?: Fiber.Fiber<void, unknown>;
  /** Every thread the run started (the wallet reads them all). */
  readonly threads: Set<string>;
  /** The threads working now: what a stop, a timeout or an empty wallet stops. */
  readonly current: Set<string>;
  /** Throwaway checkouts: by step, or by `<step>#<n>` for a parallel attempt's own copy. */
  readonly copies: Map<string, { readonly at: string; readonly sha: string | null }>;
  /** Attempts in flight, by `<step>.<n>`. */
  readonly flights: Map<string, Flight>;
  /** The fiber doing an attempt's own work now (its turn, a check, its grade), by `<step>.<n>`: what its stop ends. */
  readonly working: Map<string, Fiber.Fiber<ReadonlyArray<Action>, unknown>>;
  /** Attempts a stop_attempt ended (another won, §4.3, or their step failed), by `<step>.<n>`: nothing of theirs starts again. */
  readonly stopped: Set<string>;
  /** Approval gates waiting for an answer, by step. */
  readonly approvals: Map<string, Approval>;
  cancelling?: CancelReason;
  readonly lock: Semaphore.Semaphore;
  /** Done once the run's last action (its finish) ran: a newer run on its branch waits for it (A14). */
  readonly ended: Deferred.Deferred<void>;
}

/**
 * A folder the tools container's user writes too (a Cloud computer): the computer's group may write it, and setgid
 * keeps what either side makes in it in that group. A folder this runtime does not own (the pod made it, already the
 * group's) is left as it is.
 */
export function shareWithTools(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o2770);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
}

/** Who a Cloud computer's run commits as (the archive commits' author in handlers.ts). */
export const CLOUD_COMMIT_IDENTITY: CommitIdentity = { name: "Caveman Code", email: "code@caveman.so" };

const flightKey = (step: string, n: number) => `${step}.${n}`;

/**
 * Milliseconds on the monotonic clock, which the run's clocks read. Like the timers that run them, it stands still
 * while the computer sleeps, so a night with the lid closed is no work (§10.1, §10.2); the wall clock jumps over it.
 */
const monotonicMs = Clock.monotonicTimeNanos.pipe(Effect.map((nanos) => Number(nanos / 1_000_000n)));
const isParallel = (step: PlanStep) => (step.parallel ?? 1) > 1;
const copyKey = (step: PlanStep, n: number) => (isParallel(step) ? `${step.name}#${n}` : step.name);

/** A run waiting for a slot has no events until it starts: its admission, rebuilt from its row as admit made it. */
const admissionOf = (row: RunRow) => {
  const plan = planOf(row.revision.automation.file, row.revision.agents, row.apply, row.automation, { untrusted: !row.trigger.trusted });
  const admission: RunEvent = { type: "run_admitted", at: row.startedAt, run: row.runId, plan };
  return { admission, transition: next(undefined, admission) };
};

/** Why a run ends before it starts, with no events: stopped or replaced while it waited for a slot, or a schedule tick skipped. */
type UnstartedReason = CancelReason | "skipped_overlap";
const UNSTARTED_REASONS: ReadonlySet<string> = new Set<UnstartedReason>(["cancelled", "superseded", "deadline", "policy_denied", "skipped_overlap"]);
const isUnstarted = (reason: string | null): reason is UnstartedReason => reason !== null && UNSTARTED_REASONS.has(reason);

/**
 * §8.3 for a run that never started: every step skipped, every output dropped. Its admission may have opened a gate
 * or a timer no one could answer or wait out before it had a slot; a skipped step keeps neither.
 */
const endedUnstarted = (admitted: RunState, reason: UnstartedReason, at: string): RunState => ({
  ...admitted,
  status: "cancelled",
  reason,
  endedAt: at,
  steps: admitted.steps.map((s) => ({ name: s.name, status: "skipped", reason: "run_cancelled", sha: null, attempts: [] })),
  outputs: admitted.outputs.map((o) => ({ ...o, status: "dropped" })),
  owed: [],
});

export const makeRunner = (deps: RunnerDeps) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const live = new Map<string, Live>();
    const admitLock = yield* Semaphore.make(1);
    const pollMs = deps.pollMs ?? 2_000;
    const outputRetry = { schedule: Schedule.exponential(deps.outputRetryBase ?? "10 seconds"), times: 2, while: (e: OutputError) => e.retryable };
    const now = () => new Date().toISOString();
    const { journal, engine, git } = deps;
    // On a Cloud computer git makes run worktrees and copies from the tools container: they go in a folder it may write.
    if (deps.sharedWithTools) yield* Effect.sync(() => shareWithTools(deps.worktreesDir));
    /** Where runs happen, Cloud's outputs and who watches: the deps, or what a host (the Cloud host) set with useHost. */
    let host: { environment: "this-mac" | "cloud"; post?: RunHost["post"]; observe?: RunHost["observe"]; cloudGitHub?: CloudGitHub } = {
      environment: deps.environment ?? "this-mac",
      ...(deps.post === undefined ? {} : { post: deps.post }),
      ...(deps.observe === undefined ? {} : { observe: deps.observe }),
      ...(deps.cloudGitHub === undefined ? {} : { cloudGitHub: deps.cloudGitHub }),
    };
    /** Set once a host said where runs happen (useHost): on a Cloud computer, runs left going wait for it. */
    const hostSet = yield* Deferred.make<void>();
    /**
     * Where routine reports go, once the Session Protocol said (useChief): a run a restart left going waits for it, as
     * one waits for its host. Said to be none, a chief output is dropped with a note.
     */
    const chiefSet = yield* Deferred.make<ChiefSink | undefined>();
    /** Set once the runs a restart left are live again: a Stop or an answer for one waits for it, never missing it. */
    const resumeDone = yield* Deferred.make<void>();
    /** git in the project's own checkout (trusted), with fsmonitor and hooks off. Never in a run's worktree. */
    const rootGit = trustedGit(git);
    /** Runs waiting for a slot in their project (A12), in admission order. */
    const queue: Array<{ readonly run: Live; readonly actions: ReadonlyArray<Action>; /** Journalled as it starts (a run never started has no events yet). */ readonly admission?: RunEvent }> = [];

    // ---------------------------------------------------------------- the journal

    /** One event: journalled, then folded; uninterruptible so a cancel never splits the two. */
    const append = (run: Live, event: RunEvent) =>
      run.lock
        .withPermits(1)(
          Effect.gen(function* () {
            const transition = next(run.state, event);
            yield* journal.append(run.runId, event, transition.state);
            run.state = transition.state;
            return transition.actions;
          }),
        )
        .pipe(
          Effect.tap(() => (host.observe === undefined ? Effect.void : host.observe(run.row, event, run.state).pipe(Effect.catchCause(() => Effect.void)))),
          Effect.uninterruptible,
        );

    const agentOf = (run: Live, name: string | undefined): ParsedAgent | undefined =>
      name === undefined ? undefined : run.row.revision.agents.find((a) => a.name === name);
    const planStep = (run: Live, name: string) => run.state.plan.steps.find((s) => s.name === name)!;
    const stepState = (run: Live, name: string) => run.state.steps.find((s) => s.name === name)!;
    const attemptOf = (run: Live, step: string, n: number) => stepState(run, step).attempts.find((a) => a.n === n);

    // ---------------------------------------------------------------- spend and clocks

    const spentNow = (run: Live) => engine.usage([...run.threads]).pipe(Effect.map((byThread) => sumCosts(byThread.values())));
    const usageOf = (threadIds: ReadonlyArray<string>) =>
      threadIds.length === 0 ? Effect.succeed(NO_COST) : engine.usage([...threadIds]).pipe(Effect.map((m) => sumCosts(m.values())));

    /** Reads the wallet until it is empty (then fails); never succeeds. Raced against an agent's turn. */
    const watchWallet = (run: Live) =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(pollMs);
          const spent = yield* spentNow(run);
          yield* journal.update(run.runId, { spent });
          const empty = exhausted(run.row.wallet, spent);
          if (empty !== undefined) return yield* new Stopped({ reason: "budget_exhausted", message: empty });
        }
      });

    /** The flight of attempt n: made when the attempt starts; a check a restart left owed gets a fresh clock. */
    const flightOf = (run: Live, step: PlanStep, n: number) =>
      monotonicMs.pipe(
        Effect.map((at) => {
          const key = flightKey(step.name, n);
          let flight = run.flights.get(key);
          if (flight === undefined) {
            flight = { deadline: at + step.timeoutMs, timeoutMs: step.timeoutMs, usageAtStart: NO_COST, threads: new Set() };
            run.flights.set(key, flight);
          }
          return flight;
        }),
      );

    /** An agent's work (or a check) under its attempt's clock and the run wallet. */
    const guarded = <A, E>(run: Live, flight: Flight, work: Effect.Effect<A, E>) =>
      monotonicMs.pipe(
        Effect.flatMap((at) => Effect.raceFirst(work, watchWallet(run)).pipe(Effect.timeoutOption(Math.max(0, flight.deadline - at)))),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(new Stopped({ reason: "timeout", message: `The attempt ran out of its ${Math.round(flight.timeoutMs / 60_000)} minutes and was stopped.` })),
        ),
      );

    /** A thread starts working for an attempt: the wallet reads it, a stop reaches it. */
    const enter = (run: Live, flight: Flight, threadId: string) => {
      run.threads.add(threadId);
      run.current.add(threadId);
      flight.threads.add(threadId);
    };
    const leave = (run: Live, threadId: string) => run.current.delete(threadId);

    const stopThreads = (run: Live, ids: ReadonlyArray<string>, key: string) =>
      Effect.suspend(() => {
        for (const id of ids) run.current.delete(id);
        return ids.length === 0 ? Effect.void : engine.stop(ids, key);
      });

    // ---------------------------------------------------------------- the workspace

    const rootOf = (run: Live) =>
      deps.projectRoot(run.row.projectId).pipe(
        Effect.flatMap((root) => (root === undefined ? Effect.fail(new StepError({ reason: "engine_unavailable", message: "The project's checkout is gone." })) : Effect.succeed(root))),
      );

    /** A3: git for a checkout the agent can write (the run worktree, a copy), its git dir taken from the project's repository. */
    const gitIn = (run: Live, at: string) => rootOf(run).pipe(Effect.flatMap((root) => worktreeGit(git, root, at)));

    /**
     * Where a run starts: a pull request subject's head, fetched into a private ref (F-6), else the default branch
     * (origin's when there is one, else main, master, or what is checked out).
     */
    const baseOf = (run: Live, root: string) =>
      Effect.gen(function* () {
        const pr = prOf(run.row.trigger);
        if (pr !== undefined) {
          const ref = `refs/caveman/pr/${pr.number}`;
          const fetched = yield* rootGit(root, ["fetch", "--quiet", "--no-tags", "origin", `+refs/pull/${pr.number}/head:${ref}`]);
          if (fetched.code !== 0) {
            return yield* new StepError({ reason: "agent_error", message: `Pull request #${pr.number}'s head could not be fetched from origin: ${(fetched.stderr || fetched.stdout).trim().slice(0, 300)}` });
          }
          const sha = yield* gitOk(rootGit, root, ["rev-parse", "--verify", `${ref}^{commit}`]);
          // Same repository: its head branch is on origin at that commit (or the payload says whose head it is).
          let sameRepo = false;
          if (pr.fork !== true && pr.headRepo !== undefined) sameRepo = pr.headRepo.toLowerCase() === pr.repo.toLowerCase();
          else if (pr.fork !== true && pr.headRef !== undefined) {
            const listed = yield* rootGit(root, ["ls-remote", "origin", `refs/heads/${pr.headRef}`]);
            sameRepo = listed.code === 0 && listed.stdout.split(/\s/)[0] === sha;
          }
          return {
            branch: sameRepo && pr.headRef !== undefined ? pr.headRef : (pr.baseRef ?? "HEAD"),
            sha,
            pr: { number: pr.number, head: sha, ...(pr.baseRef === undefined ? {} : { baseBranch: pr.baseRef }), ...(pr.baseSha === undefined ? {} : { baseSha: pr.baseSha }), sameRepo },
          } satisfies RunBase;
        }
        const remoteHead = yield* rootGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
        if (remoteHead.code === 0) {
          const ref = remoteHead.stdout.trim();
          yield* rootGit(root, ["fetch", "--quiet", "origin", ref.replace(/^origin\//, "")]);
          return { branch: ref.replace(/^origin\//, ""), sha: yield* gitOk(rootGit, root, ["rev-parse", ref]) } satisfies RunBase;
        }
        for (const branch of ["main", "master"]) {
          const found = yield* rootGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
          if (found.code === 0) return { branch, sha: found.stdout.trim() } satisfies RunBase;
        }
        return { branch: (yield* rootGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim() || "HEAD", sha: yield* gitOk(rootGit, root, ["rev-parse", "HEAD"]) } satisfies RunBase;
      });

    /**
     * The step's own result from the last succeeded run on the same pull request, when that run worked at another
     * head: a review of a new push reads the commits since and carries the rest forward instead of starting over.
     */
    const previousOf = (run: Live, step: string, sha: string | null) =>
      Effect.gen(function* () {
        if (prOf(run.row.trigger) === undefined) return undefined;
        const last = yield* journal.lastSucceeded({ automationId: run.row.automationId, subject: run.row.subject, runId: run.runId });
        if (last?.base == null || last.base.sha === sha) return undefined;
        const result = replay(yield* journal.events(last.runId))?.steps.find((s) => s.name === step && s.status === "succeeded")?.result;
        return result === undefined || result.summary.trim() === "" ? undefined : ({ run: last.runId, head: last.base.sha, summary: result.summary } satisfies PreviousResult);
      });

    /** The run's base, fixed once (the first step that needs a checkout fetches it). */
    const baseLock = yield* Semaphore.make(1);
    const ensureBase = (run: Live) =>
      baseLock.withPermits(1)(
        Effect.gen(function* () {
          if (run.row.base !== null) return run.row.base;
          const base = yield* baseOf(run, yield* rootOf(run));
          yield* journal.update(run.runId, { base });
          run.row = { ...run.row, base };
          return base;
        }),
      );

    /** Rule 5's folder for what a command check sets aside in a checkout: each checkout its own, as checks run side by side. */
    const heldDir = (cwd: string) => `${cwd}.held`;

    /** The run's own variables for a command at `cwd` (deps.runEnv), as `runCommand` takes them; nothing where the host gives none. */
    const variablesOf = (run: Live, cwd: string) =>
      (deps.runEnv?.(run.runId, cwd) ?? Effect.succeed(undefined)).pipe(Effect.map((variables) => (variables === undefined ? {} : { variables })));

    /** §6.1: the run's one worktree on its branch, made by its first full step. */
    const worktreeLock = yield* Semaphore.make(1);
    const runWorktree = (run: Live) =>
      worktreeLock
        .withPermits(1)(
          Effect.gen(function* () {
            if (run.row.worktree !== null && fs.existsSync(run.row.worktree)) {
              // A check a restart cut short left the step's own versions of what it runs aside: they go back first.
              putBackHeld(heldDir(run.row.worktree), run.row.worktree);
              return run.row.worktree;
            }
            const root = yield* rootOf(run);
            if (run.row.worktree !== null && run.row.branch !== null) {
              // Its folder went away (a cleanup): the branch still holds the run's commits, so check it out again.
              yield* rootGit(root, ["worktree", "prune"]);
              yield* gitOk(rootGit, root, ["worktree", "add", "--", run.row.worktree, run.row.branch]);
              return run.row.worktree;
            }
            // A readonly step before it already fixed the run's base: the branch starts where that step read.
            const base = yield* ensureBase(run);
            const branch = branchOf(run.row);
            const at = path.join(deps.worktreesDir, run.runId);
            yield* makeRunWorktree(rootGit, { root, dir: deps.worktreesDir, path: at, branch, base: base.sha });
            yield* journal.update(run.runId, { branch, worktree: at, head: base.sha, base });
            run.row = { ...run.row, branch, worktree: at, head: base.sha, base };
            return at;
          }),
        )
        .pipe(Effect.uninterruptible);

    /** The commit later steps and copies see: the run worktree's head, else the run's base. */
    const runCommit = (run: Live) =>
      Effect.gen(function* () {
        if (run.row.worktree !== null && fs.existsSync(run.row.worktree)) return yield* headOf(yield* gitIn(run, run.row.worktree), run.row.worktree);
        return (yield* ensureBase(run)).sha;
      });

    const copyPath = (run: Live, step: PlanStep, n: number) => path.join(deps.worktreesDir, `${run.runId}.${step.name}${isParallel(step) ? `.c${n}` : ""}`);

    /**
     * The copy attempt n already works in, if it has one. A restart forgets the copies (run.copies), not their folders:
     * an attempt that started finds its own again, with the work its checks, grade, pick and commit are about.
     */
    const copyOf = (run: Live, step: PlanStep, n: number) =>
      Effect.gen(function* () {
        const key = copyKey(step, n);
        const known = run.copies.get(key);
        if (known !== undefined) return fs.existsSync(known.at) ? known : undefined;
        const at = copyPath(run, step, n);
        const attempt = attemptOf(run, step.name, n);
        if (attempt === undefined || !fs.existsSync(at)) return undefined;
        // A retry round's copies are made at the run's commit then, which a full step beside it may have moved.
        const copy = { at, sha: step.computer === "none" ? null : (attempt.startSha ?? stepState(run, step.name).startSha ?? (yield* runCommit(run))) };
        run.copies.set(key, copy);
        return copy;
      });

    /**
     * Where an attempt works: the run's worktree (full), a copy at the run's commit (readonly), or an empty folder
     * (none). A parallel attempt always gets its own copy (§4.1); a full one branches from the step's start and
     * reaches the run's worktree only if it is picked.
     */
    const workspaceOf = (run: Live, step: PlanStep, n: number) =>
      Effect.gen(function* () {
        if (step.computer === "full" && !isParallel(step)) {
          const cwd = yield* runWorktree(run);
          return { cwd, sha: yield* headOf(yield* gitIn(run, cwd), cwd), branch: run.row.branch ?? undefined };
        }
        const known = yield* copyOf(run, step, n);
        if (known !== undefined) return { cwd: known.at, sha: known.sha };
        // A fresh copy would hold none of the attempt's work: what is about that work must not run on the step's start.
        if (attemptOf(run, step.name, n) !== undefined) return yield* new StepError({ reason: "agent_error", message: "The attempt's copy is gone, so its work is lost." });
        const key = copyKey(step, n);
        const at = copyPath(run, step, n);
        if (step.computer === "none") {
          fs.rmSync(at, { recursive: true, force: true });
          if (deps.sharedWithTools) shareWithTools(at);
          else fs.mkdirSync(at, { recursive: true });
          run.copies.set(key, { at, sha: null });
          return { cwd: at, sha: null };
        }
        const startSha = step.computer === "full" ? (stepState(run, step.name).startSha ?? (yield* runCommit(run))) : yield* runCommit(run);
        // A7: whatever a restart left registered at `at` is removed first.
        yield* makeCopy(rootGit, yield* rootOf(run), at, startSha);
        run.copies.set(key, { at, sha: startSha });
        return { cwd: at, sha: startSha };
      });

    /** Attempt n's throwaway checkout, known to this runtime or left on disk by one before it (a restart forgets it). */
    const attemptCopy = (run: Live, step: PlanStep, n: number) => {
      const known = run.copies.get(copyKey(step, n));
      if (known !== undefined) return known.at;
      const at = copyPath(run, step, n);
      return (step.computer !== "full" || isParallel(step)) && fs.existsSync(at) ? at : undefined;
    };

    /**
     * The step's throwaway checkouts, by copy key: its attempts' and any this runtime made for an attempt never recorded.
     * An attempt being stopped keeps its own: its agent may still be working there, and its stop removes it after.
     */
    const copiesOf = (run: Live, step: PlanStep) => {
      const found = new Map<string, string>();
      for (const [key, copy] of run.copies) if (key === step.name || key.startsWith(`${step.name}#`)) found.set(key, copy.at);
      for (const attempt of stepState(run, step.name).attempts) {
        const at = attemptCopy(run, step, attempt.n);
        if (at !== undefined) found.set(copyKey(step, attempt.n), at);
      }
      for (const a of run.state.owed) if (a.type === "stop_attempt" && a.step === step.name) found.delete(copyKey(step, a.n));
      return found;
    };

    const dropCopy = (run: Live, step: PlanStep, key: string, at: string) =>
      Effect.gen(function* () {
        run.copies.delete(key);
        if (step.computer === "none") fs.rmSync(at, { recursive: true, force: true });
        else yield* removeCopy(rootGit, yield* rootOf(run).pipe(Effect.orElseSucceed(() => at)), at);
      });

    /** The step is over: its throwaway checkouts go, and its threads' workspaces leave the chat list. */
    const release = (run: Live, step: string) =>
      Effect.gen(function* () {
        yield* engine.close(threadsOf(run, step));
        const plan = planStep(run, step);
        for (const [key, at] of copiesOf(run, plan)) yield* dropCopy(run, plan, key, at);
      }).pipe(Effect.ignore);

    /** Every thread a step's attempts, checks and grades ran in. */
    const threadsOf = (run: Live, step: string) =>
      stepState(run, step).attempts.flatMap((a) => [
        ...(a.threadId === undefined ? [] : [a.threadId]),
        ...a.checks.flatMap((c) => (c.threadId === undefined ? [] : [c.threadId])),
        ...(a.grade?.threadId === undefined ? [] : [a.grade.threadId]),
      ]);

    // ---------------------------------------------------------------- an attempt

    /** A6: nothing starts or sends on a run being cancelled (its fiber is interrupted right after this is set). */
    const notCancelling = (run: Live) => Effect.suspend(() => (run.cancelling === undefined ? Effect.void : Effect.interrupt));

    /** Waits for a turn and reads its result, with the one corrective turn a missing or invalid result gets. */
    const awaitResult = (run: Live, input: { readonly threadId: string; readonly runId: string; readonly agent: ParsedAgent | undefined; readonly key: string }) =>
      Effect.gen(function* () {
        const projectId = run.row.projectId;
        let turn = yield* engine.wait({ projectId, threadId: input.threadId, runId: input.runId });
        if (turn.status !== "completed") return { failed: turn.text || (turn.status === "interrupted" ? "The engine stopped the turn." : "The engine's turn failed.") } as const;
        // K1: fields are checked against the agent's returns schema as the run was admitted with it.
        const schema = input.agent === undefined ? undefined : run.row.revision.returnsSchemas?.[input.agent.name];
        let parsed = parseResult(turn.text, input.agent, schema);
        const contract = contractOf(input.agent);
        if ("problem" in parsed && contract !== undefined) {
          yield* notCancelling(run);
          const corrected = yield* engine.send({ projectId, threadId: input.threadId, key: `${input.key}-correct`, text: correctiveMessage(parsed.problem, contract) });
          turn = yield* engine.wait({ projectId, threadId: input.threadId, runId: corrected.runId });
          if (turn.status !== "completed") return { failed: turn.text || "The engine's turn failed." } as const;
          parsed = parseResult(turn.text, input.agent, schema);
        }
        return "problem" in parsed ? ({ invalid: parsed.problem } as const) : ({ envelope: parsed.envelope } as const);
      });

    const startAttempt = (run: Live, action: Extract<Action, { type: "start_attempt" }>) =>
      Effect.gen(function* () {
        const step = planStep(run, action.step);
        const agent = agentOf(run, step.agent);
        // A prompt step may decide by itself (`decides:` on the step); an agent step decides what its file says.
        const decider: ParsedAgent | undefined =
          step.agent === undefined && step.decides !== undefined ? ({ ...agent, decides: [...step.decides] } as ParsedAgent) : agent;
        const at = attemptId(run.runId, step.name, action.n);
        const previous = stepState(run, step.name).attempts.filter((a) => a.n < action.n).at(-1);
        const effort = action.effort ?? step.effort;
        const started = (fields: Partial<Extract<RunEvent, { type: "step_started" }>>) =>
          append(run, {
            type: "step_started",
            at: now(),
            step: step.name,
            n: action.n,
            model: { asked: action.asked, resolved: action.asked },
            computer: step.computer,
            session: "new",
            ...fields,
          } as Extract<RunEvent, { type: "step_started" }>).pipe(Effect.map(() => attemptOf(run, step.name, action.n) !== undefined));
        const fail = (reason: Extract<RunEvent, { type: "attempt_failed" }>["reason"], message: string, cost?: Cost) =>
          append(run, { type: "attempt_failed", at: now(), step: step.name, n: action.n, reason, message, ...(cost === undefined ? {} : { cost }) });

        const flight: Flight = { deadline: (yield* monotonicMs) + step.timeoutMs, timeoutMs: step.timeoutMs, usageAtStart: NO_COST, threads: new Set() };
        run.flights.set(flightKey(step.name, action.n), flight);

        // A command step: the runtime runs it in the step's computer, with no model, keeping the person's git login (stepEnv).
        if (stepKind(step) === "run") {
          const workspace = yield* workspaceOf(run, step, action.n).pipe(Effect.result);
          if (!(yield* started({ model: { asked: NO_MODEL, resolved: NO_MODEL }, ...(workspace._tag === "Success" ? { start_sha: workspace.success.sha } : {}) }))) return [];
          if (workspace._tag === "Failure") return yield* fail("agent_error", `The step's checkout could not be made: ${workspace.failure.message}`);
          yield* notCancelling(run);
          const variables = yield* variablesOf(run, workspace.success.cwd);
          const result = yield* guarded(run, flight, runCommandStep(deps.processRunner, { command: step.run!, cwd: workspace.success.cwd, timeoutMs: step.timeoutMs, ...(deps.checkEnv === undefined ? {} : { env: deps.checkEnv }), ...variables })).pipe(Effect.result);
          if (result._tag === "Failure") return yield* fail(result.failure.reason, result.failure.message);
          const r = result.success;
          if (!r.passed) return yield* fail(r.exit === undefined ? "timeout" : "agent_error", commandFailure(r, step.timeoutMs));
          if (step.decides !== undefined && step.decides.length > 0) {
            const decided = commandDecision(r.tail, step.decides);
            if ("problem" in decided) {
              return yield* fail("agent_error", `${decided.problem} \`${step.run}\` must end its output with one line: decision: <one of ${step.decides.join(", ")}>.`);
            }
            const { summary, decision } = decided;
            return yield* append(run, { type: "attempt_finished", at: now(), step: step.name, n: action.n, result: { summary: summary || `\`${step.run}\` decided ${decision}.`, decision } });
          }
          return yield* append(run, { type: "attempt_finished", at: now(), step: step.name, n: action.n, result: { summary: r.tail.trim() || `\`${step.run}\` exited 0 with no output.` } });
        }

        // F-6: a fork's pull request head is never checked out to write on This Mac.
        if (step.computer === "full") {
          const base = yield* ensureBase(run).pipe(Effect.result);
          if (base._tag === "Success" && base.success.pr !== undefined && !base.success.pr.sameRepo && host.environment === "this-mac") {
            if (!(yield* started({}))) return [];
            return yield* fail(
              "needs_isolation",
              `Pull request #${base.success.pr.number} comes from a fork, so its code is never checked out with write access on This Mac. Make this step readonly, or run it somewhere isolated.`,
            );
          }
        }
        const selected = yield* engine
          .select({ projectId: run.row.projectId, engine: action.engine ?? agent?.engine, asked: action.asked, escalated: action.escalated, effort })
          .pipe(Effect.result);
        if (selected._tag === "Failure") {
          if (!(yield* started({}))) return [];
          return yield* fail("engine_unavailable", selected.failure.message);
        }
        const selection = selected.success;
        // §9.4: an attempt that cannot draw on the wallet never starts.
        const empty = exhausted(run.row.wallet, yield* spentNow(run));
        const workspace = yield* workspaceOf(run, step, action.n).pipe(Effect.result);
        const continuing = action.session === "continue" && previous?.threadId !== undefined;
        const threadId = continuing ? previous!.threadId! : `automation:${at}`;
        const starts = empty === undefined && workspace._tag === "Success";
        const recorded = yield* started({
          model: selection.model,
          engine: selection.engine,
          ...(effort === undefined ? {} : { effort }),
          ...(starts ? { thread_id: threadId } : {}),
          session: continuing ? "continue" : "new",
          ...(workspace._tag === "Success" ? { start_sha: workspace.success.sha } : {}),
        });
        // Another attempt of a parallel step won before this one began: it never starts.
        if (!recorded) return [];
        if (empty !== undefined) return yield* fail("budget_exhausted", empty);
        if (workspace._tag === "Failure") return yield* fail("agent_error", `The step's checkout could not be made: ${workspace.failure.message}`);
        const { cwd, sha, branch } = { branch: undefined, ...workspace.success };

        yield* notCancelling(run);
        enter(run, flight, threadId);
        flight.usageAtStart = continuing ? yield* usageOf([threadId]) : NO_COST;
        const contract = contractOf(decider);
        const lastRun = continuing ? undefined : yield* previousOf(run, step.name, sha);
        const outcome = yield* guarded(
          run,
          flight,
          Effect.gen(function* () {
            yield* notCancelling(run);
            const turn = continuing
              ? yield* engine.send({ projectId: run.row.projectId, threadId, key: `retry-${action.n}`, text: retryMessage(action.failures, contract) })
              : yield* engine.start({
                  projectId: run.row.projectId,
                  threadId,
                  title: `${run.row.automation}: ${step.name}${action.candidate === undefined ? "" : ` (${action.candidate})`}`,
                  selection,
                  cwd,
                  ...(branch === undefined ? {} : { branch }),
                  text: firstMessage({
                    instructions: instructionsOf(step, agent, run.row.automation),
                    blocks: blocksFor({ run: run.runId, trigger: run.row.trigger, ...(run.row.inputs === undefined ? {} : { inputs: run.row.inputs }), ...(lastRun === undefined ? {} : { previous: lastRun }), earlier: earlierSteps(run.state, step.name) }),
                    computer: step.computer,
                    sha,
                    contract,
                    ...(action.n > 1 && action.failures !== undefined ? { failures: action.failures } : {}),
                  }),
                  marker: { automation: run.row.automation, run: run.runId, step: step.name, attempt: action.n },
                });
            return yield* awaitResult(run, { threadId, runId: turn.runId, agent: decider, key: `a${action.n}` });
          }),
        ).pipe(Effect.result);
        const cost = costSince(yield* usageOf([threadId]), flight.usageAtStart);
        if (outcome._tag === "Failure") {
          yield* stopThreads(run, [threadId], at);
          const error = outcome.failure;
          return yield* error._tag === "Stopped" ? fail(error.reason, error.message, cost) : fail(error.reason === "engine_unavailable" ? "engine_unavailable" : "agent_error", error.message, cost);
        }
        leave(run, threadId);
        // A5: the attempt is over: its delegates stop and never wake it again, and its engine process ends.
        yield* engine.settle([threadId], at);
        const result = outcome.success;
        if ("failed" in result) return yield* fail("agent_error", result.failed, cost);
        if ("invalid" in result) return yield* fail("result_invalid", `${result.invalid} The one corrective turn did not fix it.`, cost);
        return yield* append(run, { type: "attempt_finished", at: now(), step: step.name, n: action.n, result: result.envelope, cost });
      });

    // ---------------------------------------------------------------- checks, the grader and the pick

    /**
     * A reviewing turn on attempt n's work (an agent check, the grader): its own thread, in a copy at the step's start
     * when the step changed files (rule 5: nothing the step wrote steers the reviewer's engine), reading the change
     * through git. Runs under the attempt's clock and the run wallet.
     */
    const reviewTurn = (
      run: Live,
      input: { readonly step: PlanStep; readonly n: number; readonly reviewer: ParsedAgent | undefined; readonly suffix: string; readonly title: string; readonly extra?: string },
    ) =>
      Effect.gen(function* () {
        const { step, n } = input;
        const attempt = attemptOf(run, step.name, n)!;
        const flight = yield* flightOf(run, step, n);
        const workspace = yield* workspaceOf(run, step, n);
        const start = step.computer === "full" ? (stepState(run, step.name).startSha ?? null) : workspace.sha;
        // A reviewer sees the step's commit: a full step's work so far is committed for it to read (§3.7).
        const reviewSha =
          step.computer === "full"
            ? yield* Effect.gen(function* () {
                const safe = yield* gitIn(run, workspace.cwd);
                return (yield* commitAll(safe, workspace.cwd, `${run.row.automation}: ${step.name} (attempt ${n}, for review)`, deps.commitIdentity)) ?? (yield* headOf(safe, workspace.cwd));
              }).pipe(Effect.uninterruptible)
            : workspace.sha;
        const changed = step.computer === "full" ? reviewSha !== start : false;
        const threadId = `automation:${attemptId(run.runId, step.name, n)}.${input.suffix}`;
        const copyAt = path.join(deps.worktreesDir, `${run.runId}.${step.name}.${n}.${input.suffix}`);
        const copySha = changed ? start : reviewSha;
        const root = yield* rootOf(run);
        const tests = changed && start !== null && reviewSha !== null ? testChangesNote(yield* changedTests(rootGit, root, start, reviewSha)) : "";
        const started = Date.now();
        const outcome = yield* Effect.gen(function* () {
          // Item 6: a reviewer with no model of its own runs on what the attempt it reviews ran on, never a pricier default.
          const reviewer = input.reviewer;
          const own = reviewer?.model !== undefined && reviewer.model !== "inherit" ? reviewer.model : undefined;
          const sameEngine = reviewer?.engine === undefined || reviewer.engine === attempt.engine;
          const selection = yield* engine.select({
            projectId: run.row.projectId,
            engine: reviewer?.engine ?? attempt.engine,
            asked: own ?? (sameEngine ? attempt.model.resolved : DEFAULT_MODEL),
            escalated: false,
            effort: reviewer?.effort,
          });
          const cwd = copySha === null ? copyAt : yield* makeCopy(rootGit, root, copyAt, copySha);
          if (copySha === null) {
            fs.rmSync(copyAt, { recursive: true, force: true });
            fs.mkdirSync(copyAt, { recursive: true });
          }
          yield* notCancelling(run);
          enter(run, flight, threadId);
          const contract = contractOf(reviewer);
          const blocks = blocksFor({ run: run.runId, trigger: run.row.trigger, ...(run.row.inputs === undefined ? {} : { inputs: run.row.inputs }), earlier: earlierSteps(run.state, step.name) });
          const result = { ...stepState(run, step.name), status: "succeeded" as const, result: attempt.result, sha: changed ? reviewSha : null } as StepState;
          const turn = yield* engine.start({
            projectId: run.row.projectId,
            threadId,
            title: `${run.row.automation}: ${step.name} ${input.title}`,
            selection,
            cwd,
            text: firstMessage({
              instructions: instructionsOf({ name: step.name, ...(reviewer === undefined ? {} : { agent: reviewer.name }) }, reviewer, run.row.automation),
              blocks: [...blocks, ...blocksFor({ run: run.runId, trigger: { kind: run.row.trigger.kind }, earlier: [result] })],
              computer: "readonly",
              sha: copySha,
              contract: [reviewMessage({ step: step.name, start: changed ? start : null, sha: changed ? reviewSha : null, tests }), input.extra, contract].filter((x) => x !== undefined && x !== "").join("\n\n"),
            }),
            marker: { automation: run.row.automation, run: run.runId, step: step.name, attempt: n, ...(input.suffix.startsWith("check") ? { check: Number(input.suffix.slice(5)) } : {}) },
          });
          return yield* awaitResult(run, { threadId, runId: turn.runId, agent: reviewer, key: input.suffix });
        }).pipe(
          (work) => guarded(run, flight, work),
          Effect.result,
          Effect.ensuring(removeCopy(rootGit, root, copyAt)),
        );
        const cost = yield* usageOf([threadId]);
        if (outcome._tag === "Failure") {
          yield* stopThreads(run, [threadId], `${attemptId(run.runId, step.name, n)}.${input.suffix}`);
          yield* engine.close([threadId]);
          return { threadId, cost, ms: Date.now() - started, failure: outcome.failure } as const;
        }
        leave(run, threadId);
        // The review is over: its engine process ends and its workspace (whose copy is gone) leaves the chat list.
        yield* engine.settle([threadId], `${attemptId(run.runId, step.name, n)}.${input.suffix}`);
        yield* engine.close([threadId]);
        return { threadId, cost, ms: Date.now() - started, result: outcome.success } as const;
      });

    const runCheck = (run: Live, action: Extract<Action, { type: "run_check" }>) =>
      Effect.gen(function* () {
        const step = planStep(run, action.step);
        const check = step.checks[action.index]!;
        const flight = yield* flightOf(run, step, action.n);
        const workspace = yield* workspaceOf(run, step, action.n);
        const record = (fields: Omit<Extract<RunEvent, { type: "check_result" }>, "type" | "at" | "step" | "n" | "index">) =>
          append(run, { type: "check_result", at: now(), step: step.name, n: action.n, index: action.index, ...fields });
        const fail = (reason: "timeout" | "budget_exhausted" | "agent_error", message: string, cost?: Cost) =>
          append(run, { type: "attempt_failed", at: now(), step: step.name, n: action.n, reason, message, ...(cost === undefined ? {} : { cost }) });
        /** The commit the step started from: what grades it is taken from here (rule 5). */
        const start = step.computer === "full" ? (stepState(run, step.name).startSha ?? null) : workspace.sha;

        if (check.kind === "command") {
          // Rule 5 (F-2): what the check runs is put back to its version from before the step, and returned after.
          const held = heldDir(workspace.cwd);
          const safe = workspace.sha === null || start === null ? undefined : yield* gitIn(run, workspace.cwd);
          const hold = safe === undefined ? { restored: [] as string[], refused: undefined } : yield* holdEntryPoints(safe, { cwd: workspace.cwd, start: start!, command: check.command, held });
          if (hold.refused !== undefined) {
            putBackHeld(held, workspace.cwd);
            return yield* record({ passed: false, ms: 0, text: refusedText(hold.refused) });
          }
          const variables = yield* variablesOf(run, workspace.cwd);
          const result = yield* guarded(run, flight, runCommandCheck(deps.processRunner, { command: check.command, cwd: workspace.cwd, ...(deps.checkEnv === undefined ? {} : { env: deps.checkEnv }), ...variables })).pipe(
            Effect.ensuring(Effect.sync(() => putBackHeld(held, workspace.cwd))),
            Effect.result,
          );
          if (result._tag === "Failure") return yield* fail(result.failure.reason, result.failure.message);
          const r = result.success;
          return yield* record({ passed: r.passed, ...(r.exit === undefined ? {} : { exit: r.exit }), ms: r.ms, text: heldNote(hold.restored) + r.tail });
        }

        const review = yield* reviewTurn(run, { step, n: action.n, reviewer: agentOf(run, check.agent), suffix: `check${action.index}`, title: "check" });
        if ("failure" in review) {
          const error = review.failure;
          return yield* fail(error._tag === "Stopped" ? error.reason : "agent_error", error.message, review.cost);
        }
        const result = review.result;
        if ("failed" in result) return yield* fail("agent_error", `The check ${check.agent} failed to run: ${result.failed}`, review.cost);
        // Anything but approve fails the attempt (§3.7), and the checker's summary goes to the retry.
        if ("invalid" in result) return yield* record({ passed: false, ms: review.ms, text: `The check did not decide: ${result.invalid}`, thread_id: review.threadId, cost: review.cost });
        const decision = result.envelope.decision;
        return yield* record({ passed: decision === "approve", ms: review.ms, ...(decision === undefined ? {} : { decision }), text: result.envelope.summary, thread_id: review.threadId, cost: review.cost });
      });

    /** The rubric (outcome): a separate grader scores attempt n; work that falls short goes back with its feedback. */
    const grade = (run: Live, action: Extract<Action, { type: "grade" }>) =>
      Effect.gen(function* () {
        const step = planStep(run, action.step);
        const review = yield* reviewTurn(run, { step, n: action.n, reviewer: graderAgent(step.outcome!.rubric), suffix: "grade", title: "grade" });
        const fail = (reason: "timeout" | "budget_exhausted" | "agent_error", message: string, cost?: Cost) =>
          append(run, { type: "attempt_failed", at: now(), step: step.name, n: action.n, reason, message, ...(cost === undefined ? {} : { cost }) });
        if ("failure" in review) return yield* fail(review.failure._tag === "Stopped" ? review.failure.reason : "agent_error", review.failure.message, review.cost);
        const result = review.result;
        if ("failed" in result) return yield* fail("agent_error", `The grader failed to run: ${result.failed}`, review.cost);
        const satisfied = "envelope" in result && result.envelope.decision === "satisfied";
        const text = "envelope" in result ? result.envelope.summary : `The grader did not decide: ${result.invalid}`;
        return yield* append(run, { type: "graded", at: now(), step: step.name, n: action.n, satisfied, text, thread_id: review.threadId, cost: review.cost });
      });

    /** pick: best (§4.3): a reviewer reads every attempt that passed (summary, change, checks, cost) and names one. */
    const pickOne = (run: Live, action: Extract<Action, { type: "pick" }>) =>
      Effect.gen(function* () {
        const step = planStep(run, action.step);
        const root = yield* rootOf(run);
        const start = stepState(run, step.name).startSha ?? null;
        const blocks: Array<ReturnType<typeof blocksFor>[number]> = [];
        for (const n of action.candidates) {
          const attempt = attemptOf(run, step.name, n)!;
          let stat = "";
          if (step.computer === "full" && start !== null) {
            const workspace = yield* workspaceOf(run, step, n);
            const safe = yield* gitIn(run, workspace.cwd);
            const sha = (yield* commitAll(safe, workspace.cwd, `${run.row.automation}: ${step.name} (attempt ${n}, for the pick)`, deps.commitIdentity)) ?? (yield* headOf(safe, workspace.cwd));
            stat = (yield* rootGit(root, ["diff", "--stat", `${start}..${sha}`])).stdout.trim();
          }
          const checks = attempt.checks.map((c) => `${c.check}: ${c.passed ? "passed" : "failed"}`).join("\n");
          blocks.push({
            tag: "step",
            attrs: { name: `attempt-${n}`, status: "passed" },
            body: [attempt.result?.summary ?? "", stat === "" ? "" : `Changed:\n${stat}`, checks === "" ? "" : `Checks:\n${checks}`, `Cost: $${attempt.cost.usd.toFixed(4)}`].filter(Boolean).join("\n\n"),
            where: `run ${run.runId}, step ${step.name}, attempt ${n}`,
          });
        }
        const picker = pickerAgent(action.candidates);
        const first = attemptOf(run, step.name, action.candidates[0]!)!;
        const threadId = `automation:${run.runId}.${step.name}.pick${action.candidates.join("-")}`;
        const copyAt = path.join(deps.worktreesDir, `${run.runId}.${step.name}.pick`);
        const outcome = yield* Effect.gen(function* () {
          const selection = yield* engine.select({ projectId: run.row.projectId, engine: first.engine, asked: first.model.resolved, escalated: false, effort: undefined });
          const cwd = start === null ? copyAt : yield* makeCopy(rootGit, root, copyAt, start);
          if (start === null) fs.mkdirSync(copyAt, { recursive: true });
          enter(run, { deadline: 0, timeoutMs: 0, usageAtStart: NO_COST, threads: new Set() }, threadId);
          const turn = yield* engine.start({
            projectId: run.row.projectId,
            threadId,
            title: `${run.row.automation}: ${step.name} pick`,
            selection,
            cwd,
            text: firstMessage({ instructions: picker.instructions, blocks, computer: "readonly", sha: start, contract: contractOf(picker) }),
            marker: { automation: run.row.automation, run: run.runId, step: step.name, attempt: action.candidates[0]! },
          });
          return yield* awaitResult(run, { threadId, runId: turn.runId, agent: picker, key: "pick" });
        }).pipe(
          Effect.timeoutOption(step.timeoutMs),
          Effect.result,
          Effect.ensuring(removeCopy(rootGit, root, copyAt).pipe(Effect.andThen(Effect.sync(() => fs.rmSync(copyAt, { recursive: true, force: true }))))),
        );
        const cost = yield* usageOf([threadId]);
        leave(run, threadId);
        yield* engine.settle([threadId], `${run.runId}.${step.name}.pick`).pipe(Effect.andThen(engine.close([threadId])));
        // No pick (a failed turn, no decision, a name that is no candidate): the cheapest candidate wins (pick_invalid).
        const result = outcome._tag === "Success" && Option.isSome(outcome.success) ? outcome.success.value : undefined;
        const envelope = result !== undefined && "envelope" in result ? result.envelope : undefined;
        return yield* append(run, {
          type: "picked",
          at: now(),
          step: step.name,
          n: pickedAttempt(envelope?.decision, action.candidates),
          ...(envelope === undefined ? {} : { text: envelope.summary }),
          thread_id: threadId,
          cost,
        });
      });

    /**
     * An attempt's own work runs as its own fiber, so its stop can end it. Once stopped, the stop says how it ended:
     * a check or a turn it had going says nothing more, and nothing of it starts again.
     */
    const attemptWork = (run: Live, key: string, work: Effect.Effect<ReadonlyArray<Action>, unknown>) =>
      Effect.gen(function* () {
        if (run.stopped.has(key)) return [];
        const fiber = yield* Effect.forkChild(work);
        run.working.set(key, fiber);
        if (run.stopped.has(key)) yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        if (run.working.get(key) === fiber) run.working.delete(key);
        if (Exit.isFailure(exit) && run.stopped.has(key)) return [];
        return yield* exit;
      });

    /** Another attempt won (pick: first) or the step failed: this one stops, its work first, then its threads; its cost stays in the record. */
    const stopAttempt = (run: Live, action: Extract<Action, { type: "stop_attempt" }>) =>
      Effect.gen(function* () {
        const key = flightKey(action.step, action.n);
        run.stopped.add(key);
        const work = run.working.get(key);
        if (work !== undefined) yield* Fiber.interrupt(work);
        yield* stopThreads(run, [...(run.flights.get(key)?.threads ?? [])], `${attemptId(run.runId, action.step, action.n)}.stop`);
        // Its work is thrown away, and with its turn ended its copy can go (its step's release left it to this stop).
        const step = planStep(run, action.step);
        const copy = attemptCopy(run, step, action.n);
        if (copy !== undefined) yield* dropCopy(run, step, copyKey(step, action.n), copy);
        return yield* stoppedRecord(run, action.step, action.n);
      });

    /** A stopped attempt's end in the journal, with what it spent since it started. */
    const stoppedRecord = (run: Live, step: string, n: number) =>
      Effect.gen(function* () {
        const key = flightKey(step, n);
        const flight = run.flights.get(key);
        const cost = costSince(yield* usageOf([...(flight?.threads ?? [])]), flight?.usageAtStart ?? NO_COST);
        run.flights.delete(key);
        return yield* append(run, { type: "attempt_stopped", at: now(), step, n, cost });
      });

    // ---------------------------------------------------------------- commit

    const commit = (run: Live, action: Extract<Action, { type: "commit" }>) =>
      Effect.gen(function* () {
        const step = planStep(run, action.step);
        const subject = `${run.row.automation}: ${action.step}`;
        const message = (yield* deps.coAuthor) ? withCoAuthor(subject) : subject;
        let sha: string | null;
        if (isParallel(step)) {
          // The picked attempt's copy is squashed onto the step's start, and the run's branch moves up to it.
          const copy = yield* copyOf(run, step, action.n);
          if (copy === undefined) return yield* new StepError({ reason: "agent_error", message: "The picked attempt's copy is gone, so its work cannot be committed." });
          const safe = yield* gitIn(run, copy.at);
          const start = stepState(run, action.step).startSha ?? copy.sha!;
          sha = yield* squashSince(safe, copy.at, start, message, deps.commitIdentity).pipe(Effect.uninterruptible);
          if (sha !== null) {
            const cwd = yield* runWorktree(run);
            yield* gitOk(yield* gitIn(run, cwd), cwd, ["merge", "--ff-only", "--quiet", sha]);
          }
        } else {
          const cwd = yield* runWorktree(run);
          const safe = yield* gitIn(run, cwd);
          const start = stepState(run, action.step).startSha ?? (yield* headOf(safe, cwd));
          sha = yield* squashSince(safe, cwd, start, message, deps.commitIdentity).pipe(Effect.uninterruptible);
        }
        const cwd = yield* runWorktree(run);
        const head = yield* headOf(yield* gitIn(run, cwd), cwd);
        yield* journal.update(run.runId, { head });
        run.row = { ...run.row, head };
        return yield* append(run, { type: "attempt_committed", at: now(), step: action.step, n: action.n, sha });
      });

    // ---------------------------------------------------------------- timers and approvals

    const sleepUntil = (until: string) => Effect.suspend(() => Effect.sleep(Math.max(0, Date.parse(until) - Date.now())));

    /** A wait step: the deadline is in the journal, so a restart re-arms the same one. */
    const waitUntil = (run: Live, action: Extract<Action, { type: "wait_until" }>) =>
      sleepUntil(action.until).pipe(Effect.andThen(append(run, { type: "timer_fired", at: now(), step: action.step })));

    /** §5: the gate waits for an answer (automation.approve, the Inbox, a Cloud answer mail) or its expiry. */
    const awaitApproval = (run: Live, action: Extract<Action, { type: "await_approval" }>) =>
      Effect.gen(function* () {
        const gate: Approval = { answer: Deferred.makeUnsafe(), recorded: Deferred.makeUnsafe() };
        run.approvals.set(action.step, gate);
        const answered = yield* Effect.raceFirst(Deferred.await(gate.answer).pipe(Effect.map(Option.some)), sleepUntil(action.until).pipe(Effect.as(Option.none())));
        run.approvals.delete(action.step);
        const actions = Option.isSome(answered)
          ? yield* append(run, {
              type: "approval_answered",
              at: now(),
              step: action.step,
              decision: answered.value.decision,
              ...(answered.value.by === undefined ? {} : { by: answered.value.by }),
              ...(answered.value.message === undefined ? {} : { message: answered.value.message }),
            })
          : yield* append(run, { type: "approval_expired", at: now(), step: action.step });
        yield* Deferred.succeed(gate.recorded, undefined);
        return actions;
      });

    // ---------------------------------------------------------------- outputs

    const outputText = (run: Live, step: string, field: string) => {
      const result = stepState(run, step).result;
      const value = field === "summary" ? result?.summary : result?.fields?.[field];
      return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
    };

    const needGitHub = Effect.suspend(() =>
      deps.github === undefined ? Effect.fail(new OutputError({ message: "Sign in to GitHub in Settings so automations can write to it.", retryable: false })) : Effect.succeed(deps.github),
    );

    const pullRequestPlan = (run: Live, step: string, draft: boolean) =>
      Effect.gen(function* () {
        const base = run.row.base;
        const sha = run.row.head;
        if (run.row.worktree === null || base === null || run.row.branch === null || sha === null) {
          return yield* new OutputError({ message: "No changes to propose: the step changed no files.", retryable: false, kind: "no_changes" });
        }
        const root = yield* rootOf(run).pipe(Effect.mapError((e) => new OutputError({ message: e.message, retryable: false })));
        const summary = outputText(run, step, "summary");
        const coAuthor = yield* deps.coAuthor;
        // F-6: a same-repo pull request's run proposes into that pull request's head branch; others into the default branch.
        return yield* planPullRequest(rootGit, {
          root,
          subject: run.row.subject,
          branch: run.row.branch,
          base: base.sha,
          baseBranch: base.branch,
          sha,
          title: prTitle(summary, run.row.automation, step),
          body: (tests) => prBody({ summary, automation: run.row.automation, run: run.runId, coAuthor, tests }),
          draft,
        });
      });

    /** A Slack message or a Linear or Jira comment: Caveman Cloud posts it; This Mac shows what would go. */
    const cloudOutput = (run: Live, output: RunState["outputs"][number], mode: "apply" | "preview") =>
      Effect.gen(function* () {
        const kind = output.kind as CloudOutputPost["kind"];
        const body = outputText(run, output.step, output.field);
        const target = cloudOutputTarget(kind, run.row.trigger, output.channel);
        const where = target === undefined ? "" : ` to ${target}`;
        if (mode === "preview") return { preview: `Cloud would post this as ${kind}${where}:\n\n${body}` };
        const post = host.post;
        if (post === undefined) {
          return yield* new OutputError({ message: `Only Cloud posts ${kind}; set host: cloud and send the automation there with caveman-runtime apply.`, retryable: false });
        }
        if (target === undefined) {
          return yield* new OutputError({ message: `Nothing to post ${kind} on: the trigger that fired this run names no ${kind === "slack.message" ? "Slack thread (give the output a channel)" : "issue"}.`, retryable: false, kind: "no_changes" });
        }
        const posted = yield* post({ runId: run.runId, kind, target, body, idempotencyKey: output.key }).pipe(Effect.retry(outputRetry));
        return { url: posted.url ?? "", remoteId: posted.remoteId ?? "" };
      });

    /** One output, for real (with retries, §7.5) or as a dry run with exactly what it would write. */
    const writeOutput = (run: Live, key: string, mode: "apply" | "preview") =>
      Effect.gen(function* () {
        const output = run.state.outputs.find((o) => o.key === key)!;
        const at = now;
        if (mode === "apply") yield* append(run, { type: "output_intent", at: at(), key });
        const written = yield* Effect.gen(function* () {
          if (CLOUD_OUTPUT_KINDS.has(output.kind)) return yield* cloudOutput(run, output, mode);
          // A routine's report stays on this computer, so a manual run hands it over too.
          if (output.kind === "chief") return yield* reportToChief(run, output, "succeeded");
          if (output.kind === "github.comment") {
            const text = outputText(run, output.step, output.field);
            if (mode === "preview") {
              const body = commentBody(text, commentMarker(run.row.automation, run.row.subject));
              const target = commentTarget(run.row.subject);
              return { preview: target === undefined ? `No issue or pull request to post this on: this run's trigger has none.\n\n${body}` : `Would post on ${target} (or edit this automation's comment there):\n\n${body}` };
            }
            const cloudGitHub = host.cloudGitHub;
            if (cloudGitHub !== undefined) {
              // Caveman Cloud comments as the repository's App, where the run's subject (or its event's commit) is.
              const place = commentPlace(run.row.subject, run.row.trigger.payload);
              if (place === undefined) return yield* new OutputError({ message: "This run's trigger has no issue, pull request or commit to comment on.", retryable: false, kind: "no_changes" });
              const marker = commentMarker(run.row.automation, run.row.subject);
              const posted = yield* cloudGitHub.comment({ runId: run.runId, ...place, body: commentBody(text, marker), marker, idempotencyKey: output.key }).pipe(Effect.retry(outputRetry));
              return { url: posted.url ?? "", remoteId: posted.remoteId ?? "" };
            }
            const gh = yield* needGitHub;
            return yield* upsertComment(gh, { automation: run.row.automation, subject: run.row.subject, text }).pipe(Effect.retry(outputRetry));
          }
          const plan = yield* pullRequestPlan(run, output.step, output.draft ?? false);
          if (mode === "preview") return { preview: pullRequestPreview(plan) };
          const cloudGitHub = host.cloudGitHub;
          if (cloudGitHub !== undefined) {
            const root = yield* rootOf(run).pipe(Effect.mapError((e) => new OutputError({ message: e.message, retryable: false })));
            const opened = yield* cloudGitHub
              .pullRequest({ runId: run.runId, root, repo: `${plan.owner}/${plan.repo}`, head: plan.branch, base: plan.base, sha: plan.sha, title: plan.title, body: plan.body, draft: plan.draft, idempotencyKey: output.key })
              .pipe(Effect.retry(outputRetry));
            return { url: opened.url ?? "", remoteId: opened.remoteId ?? "" };
          }
          const gh = yield* needGitHub;
          return yield* applyPullRequest(gh, rootGit, yield* rootOf(run).pipe(Effect.mapError((e) => new OutputError({ message: e.message, retryable: false }))), plan).pipe(Effect.retry(outputRetry));
        }).pipe(Effect.result);
        if (written._tag === "Failure") {
          const error = written.failure;
          // A14: nothing to propose is no failure; item 5: a dry run on a repository with no GitHub remote just says so.
          if (error._tag === "OutputError" && (error.kind === "no_changes" || (error.kind === "no_remote" && mode === "preview"))) {
            return yield* append(run, { type: "output_dropped", at: at(), key, note: error.message });
          }
          return yield* append(run, { type: "output_failed", at: at(), key, error: error.message });
        }
        const value = written.success;
        if ("preview" in value) return yield* append(run, { type: "output_dry_run", at: at(), key, preview: value.preview });
        return yield* append(run, {
          type: "output_applied",
          at: at(),
          key,
          ...(value.url === "" ? {} : { url: value.url }),
          ...(value.remoteId === "" ? {} : { remote_id: value.remoteId }),
        });
      });

    /** A routine's run, to the Chief its output names (`to`), else one that works in the project (Chief.ts routineReport). */
    const reportToChief = (run: Live, output: Pick<RunState["outputs"][number], "step" | "to">, status: RoutineReport["status"]) =>
      Effect.gen(function* () {
        const { step } = output;
        const said = yield* Deferred.await(chiefSet).pipe(Effect.timeoutOption("2 minutes"));
        if (Option.isNone(said)) return yield* new OutputError({ message: "Caveman Code's session server did not start, so no Chief heard this run.", retryable: false });
        const sink = said.value;
        if (sink === undefined) return yield* new OutputError({ message: "No Chief takes routine reports on this computer.", retryable: false, kind: "no_changes" });
        const state = stepState(run, step);
        const failure = state.attempts.at(-1)?.message ?? state.reason ?? run.state.reason ?? "failed";
        // A draft's run (a chat's worktree, `<project>@<branch>`) is its project's routine: its row and its Chief's.
        const ref = parseFileAutomationId(run.row.automationId);
        yield* sink({
          projectId: splitProjectRef(run.row.projectId).projectId,
          ...(output.to === undefined ? {} : { chiefId: output.to }),
          automationId: ref === undefined ? run.row.automationId : fileAutomationId(splitProjectRef(ref.projectId).projectId, ref.scope, ref.name),
          automation: run.row.automation,
          runId: run.runId,
          step,
          status,
          ...(status === "succeeded" && state.result?.decision !== undefined ? { decision: state.result.decision } : {}),
          summary: status === "succeeded" ? (state.result?.summary ?? "") : `${step} ${state.status === "skipped" ? "did not run" : "failed"}: ${failure}`,
          at: now(),
        }).pipe(Effect.mapError((e) => new OutputError({ message: e.message, retryable: false })));
        return { url: "", remoteId: "" };
      });

    // ---------------------------------------------------------------- the loop

    const finish = (run: Live) =>
      Effect.gen(function* () {
        for (const step of run.state.plan.steps) if (copiesOf(run, step).size > 0) yield* release(run, step.name);
        const spent = yield* spentNow(run).pipe(Effect.orElseSucceed(() => run.row.spent));
        yield* journal.update(run.runId, { spent });
        run.row = { ...run.row, spent };
        // A routine whose run failed before its report still updates its row, and wakes no one. Before run_finished,
        // so a restart that cut it short finishes the run again and hands it over (the Chief keeps one row per run).
        const report = run.state.outputs.find((o) => o.kind === "chief");
        if (report !== undefined && report.status !== "applied" && run.state.status === "failed") {
          yield* reportToChief(run, report, "failed").pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not hand run ${run.runId}'s failure to its Chief`, cause)));
        }
        yield* append(run, { type: "run_finished", at: now() });
        live.delete(run.runId);
        yield* Deferred.succeed(run.ended, undefined);
        // What was the run's own on this computer goes with it; its worktree stays for a while (K2).
        if (deps.runEnded !== undefined) yield* deps.runEnded(run.runId).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not release what run ${run.runId} had on this computer`, cause)));
        // A slot is free: the next queued run of its project starts; old worktrees go (K2).
        yield* startQueued;
        yield* cleanup.pipe(Effect.forkIn(scope));
      });

    const perform = (run: Live, action: Action): Effect.Effect<ReadonlyArray<Action>, never> => {
      const work: Effect.Effect<ReadonlyArray<Action>, unknown> =
        action.type === "start_attempt"
          ? attemptWork(run, flightKey(action.step, action.n), startAttempt(run, action))
          : action.type === "run_check"
            ? attemptWork(run, flightKey(action.step, action.n), runCheck(run, action))
            : action.type === "grade"
              ? attemptWork(run, flightKey(action.step, action.n), grade(run, action))
              : action.type === "pick"
                ? pickOne(run, action)
                : action.type === "stop_attempt"
                  ? stopAttempt(run, action)
                  : action.type === "commit"
                    ? commit(run, action)
                    : action.type === "release_step"
                      ? release(run, action.step).pipe(Effect.as([]))
                      : action.type === "wait_until"
                        ? waitUntil(run, action)
                        : action.type === "await_approval"
                          ? awaitApproval(run, action)
                          : action.type === "output"
                            ? writeOutput(run, action.key, action.mode)
                            : finish(run).pipe(Effect.as([]));
      // Anything unplanned (a git failure mid-commit) fails the attempt it happened in, never the runtime.
      // An interruption (a cancel, the runtime stopping) is not a failure: the journal stays as it was.
      return work.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.gen(function* () {
                yield* Effect.logWarning("Automation run step failed", { run: run.runId, action: action.type, cause });
                // The stop was sent first (engine.stop fails on nothing); only reading its cost or recording it failed.
                // The machine waits for attempt_stopped, and an attempt_failed would leave the attempt running for good.
                if (action.type === "stop_attempt") return yield* append(run, { type: "attempt_stopped", at: now(), step: action.step, n: action.n });
                if ("step" in action && "n" in action) {
                  const stepError = Cause.findErrorOption(cause);
                  const said = Option.isSome(stepError) && stepError.value instanceof StepError ? stepError.value.message : `The runtime failed during this attempt: ${String(cause).slice(0, 500)}`;
                  return yield* append(run, { type: "attempt_failed", at: now(), step: action.step, n: action.n, reason: "agent_error", message: said });
                }
                if (action.type === "pick") return yield* append(run, { type: "picked", at: now(), step: action.step, n: null });
                if (action.type === "output") return yield* append(run, { type: "output_failed", at: now(), key: action.key, error: String(cause).slice(0, 500) });
                return [];
              }),
        ),
      ) as Effect.Effect<ReadonlyArray<Action>, never>;
    };

    /** Every action at once, each followed by what it leads to: a graph's ready steps and a step's attempts run side by side. */
    const drive = (run: Live, actions: ReadonlyArray<Action>): Effect.Effect<void> =>
      Effect.forEach(actions, (action) => perform(run, action).pipe(Effect.flatMap((more) => (more.length === 0 ? Effect.void : drive(run, more)))), {
        concurrency: "unbounded",
        discard: true,
      });

    /**
     * §10.2: the run deadline counts only time something works; a run waiting on a timer or a person (status
     * waiting) does not use it up, nor does a computer asleep (monotonicMs). The work counted is journalled, so a
     * restart goes on from it.
     */
    const deadlineOf = (run: Live) =>
      Effect.gen(function* () {
        const deadline = deps.runDeadlineMs ?? RUN_DEADLINE_MS;
        const tick = Math.max(10, Math.min(1_000, deadline / 4));
        let worked = run.row.workedMs;
        let last = yield* monotonicMs;
        while (worked < deadline) {
          yield* Effect.sleep(Math.min(tick, deadline - worked));
          const at = yield* monotonicMs;
          if (run.state.status !== "waiting") {
            worked += at - last;
            // A write that fails costs only what a restart would forget; this runtime's count still holds the deadline.
            yield* journal.update(run.runId, { workedMs: worked }).pipe(
              Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning("Could not journal an automation run's work time", { run: run.runId, cause }))),
            );
          }
          last = at;
        }
        yield* cancel(run.runId, "deadline");
      });

    /** Starts a run's fiber, with its deadline (§10.2), in the runner's scope. */
    const launch = (run: Live, actions: ReadonlyArray<Action>) =>
      Effect.gen(function* () {
        live.set(run.runId, run);
        // A14: an older run on the same key that is still being cancelled (mid-commit) finishes before this one takes its branch.
        const leaving = [...live.values()].filter((r) => r !== run && r.row.concurrencyKey === run.row.concurrencyKey && r.row.projectId === run.row.projectId && r.cancelling !== undefined);
        // A deadline used up before a restart cancels the run at once, so it starts counting only once there is a
        // fiber for that cancel to interrupt.
        const launched = Deferred.makeUnsafe<void>();
        const deadline = yield* Deferred.await(launched).pipe(Effect.andThen(deadlineOf(run)), Effect.forkIn(scope));
        // A deadline that fired is the fiber cancelling this run: it must not be interrupted by the run it stops.
        run.fiber = yield* Effect.forEach(leaving, (r) => Deferred.await(r.ended).pipe(Effect.timeoutOption("10 minutes")), { discard: true }).pipe(
          Effect.andThen(drive(run, actions)),
          Effect.ensuring(Effect.suspend(() => (run.cancelling === "deadline" ? Effect.void : Fiber.interrupt(deadline)))),
          Effect.forkIn(scope),
        );
        yield* Deferred.succeed(launched, undefined);
      });

    /** A run is going in its project (started, not finished), so it holds one of the project's slots (A12). */
    const going = (projectId: string) => [...live.values()].filter((r) => r.row.projectId === projectId && r.fiber !== undefined && !isTerminal(r.state.status)).length;

    /** The first queued run of each project with a free slot starts, journalling its admission as it does. */
    const startQueued: Effect.Effect<void> = Effect.gen(function* () {
      for (let i = 0; i < queue.length; ) {
        const waiting = queue[i]!;
        if (going(waiting.run.row.projectId) >= MAX_RUNNING_PER_PROJECT) {
          i++;
          continue;
        }
        queue.splice(i, 1);
        if (waiting.admission !== undefined) yield* journal.append(waiting.run.runId, waiting.admission, waiting.run.state);
        yield* launch(waiting.run, waiting.actions);
      }
    });

    const liveOf = (row: RunRow, state: RunState): Live => {
      const threads = new Set<string>();
      for (const step of state.steps)
        for (const a of step.attempts) {
          if (a.threadId !== undefined) threads.add(a.threadId);
          for (const c of a.checks) if (c.threadId !== undefined) threads.add(c.threadId);
          if (a.grade?.threadId !== undefined) threads.add(a.grade.threadId);
        }
      return {
        runId: row.runId,
        row,
        state,
        threads,
        current: new Set(),
        copies: new Map(),
        flights: new Map(),
        working: new Map(),
        stopped: new Set(),
        approvals: new Map(),
        lock: Semaphore.makeUnsafe(1),
        ended: Deferred.makeUnsafe<void>(),
      };
    };

    // ---------------------------------------------------------------- cancel

    /**
     * §8.3: wallet closed, engines and their delegates stopped, running steps cancelled, pending skipped, outputs
     * dropped; the branch stays. A6: the run's fiber is interrupted first, so it can start nothing more, and only
     * then is every thread it was running stopped.
     */
    const cancel = (runId: string, reason: CancelReason): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Deferred.await(resumeDone);
        const run = live.get(runId);
        if (run === undefined || run.cancelling !== undefined || isTerminal(run.state.status)) return;
        run.cancelling = reason;
        const queued = queue.findIndex((q) => q.run === run);
        if (queued !== -1) {
          const [{ admission }] = queue.splice(queued, 1) as [(typeof queue)[number]];
          if (admission !== undefined) {
            // Queued and never started: it ends here with no events, every step skipped; its host still hears it end
            // as any run's end (a Cloud computer owes Cloud its record, CORRECTNESS H2).
            live.delete(runId);
            const at = now();
            const ended = endedUnstarted(run.state, reason, at);
            yield* journal.settleQueued(runId, { status: "cancelled", reason, endedAt: at, steps: ended.steps.map((s) => ({ name: s.name, status: s.status })) });
            yield* Deferred.succeed(run.ended, undefined);
            if (host.observe !== undefined) yield* host.observe(run.row, { type: "run_finished", at }, ended).pipe(Effect.catchCause(() => Effect.void));
            return;
          }
        }
        if (run.fiber !== undefined) yield* Fiber.interrupt(run.fiber);
        const threads = [...run.current];
        // An attempt being stopped left run.current when its stop began, and that stop was just interrupted: its threads
        // stop again, and it ends as that stop would have ended it, with what it spent.
        const stops = run.state.owed.flatMap((a) => (a.type === "stop_attempt" ? [a] : []));
        const stopping = stops.flatMap((a) => [...(run.flights.get(flightKey(a.step, a.n))?.threads ?? [])]);
        yield* stopThreads(run, [...new Set([...threads, ...stopping])], `cancel-${reason}`);
        for (const a of stops) {
          yield* stoppedRecord(run, a.step, a.n).pipe(
            Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning("Could not record a stopped attempt's cost", { run: runId, cause }))),
          );
        }
        // What the attempts in flight spent since they started, as one record on the cancel.
        const inFlight = [...run.flights.values()].filter((f) => [...f.threads].some((t) => threads.includes(t)));
        const cost = inFlight.length === 0 ? undefined : costSince(yield* usageOf(inFlight.flatMap((f) => [...f.threads])), inFlight.reduce((sum, f) => addCost(sum, f.usageAtStart), NO_COST));
        const actions = yield* append(run, { type: "run_cancelled", at: now(), reason, ...(cost === undefined ? {} : { cost }) });
        yield* drive(run, actions);
      });

    // ---------------------------------------------------------------- admit

    const admit = (request: AdmitRequest): Effect.Effect<AdmitResult> =>
      admitLock.withPermits(1)(
        Effect.gen(function* () {
          // The runs a restart left resume first, so a run admitted now is never taken for one of them.
          yield* Deferred.await(resumeDone);
          const automation = request.revision.automation;
          const automationId =
            request.automationId ?? (request.agent !== undefined ? agentAutomationIdOf(request.projectId, request.agent) : automationIdOf(request.projectId, automation.scope, automation.name));
          const runId = request.runId ?? runIdFor(automationId, request.trigger.delivery, request.trigger.kind === "manual" ? request.trigger.subject : undefined);
          if ((yield* journal.get(runId)) !== undefined) return { runId };
          if ((yield* deps.projectRoot(request.projectId)) === undefined) {
            return { refused: "engine_unavailable", message: "This project's checkout is not on this computer." } as const;
          }
          // SECURITY M1: text from outside the trusted people puts the owner's approval before every step that can write.
          const plan = planOf(automation.file, request.revision.agents, request.apply, automation.name, { untrusted: !request.trigger.trusted });
          const at = now();
          const row: RunRow = {
            runId,
            automationId,
            automation: automation.name,
            projectId: request.projectId,
            subject: request.trigger.subject,
            concurrencyKey: `${automation.name}:${request.trigger.subject}`,
            revision: request.revision,
            trigger: request.trigger,
            ...(request.inputs === undefined ? {} : { inputs: request.inputs }),
            apply: request.apply,
            status: "running",
            reason: null,
            startedAt: at,
            endedAt: null,
            wallet: walletOf(budgetOf(automation.file.budget), deps.caps),
            spent: NO_COST,
            steps: plan.steps.map((s) => ({ name: s.name, status: "pending" })),
            branch: null,
            head: null,
            worktree: null,
            base: null,
            workedMs: 0,
          };
          const running = [...live.values()].filter((r) => r.row.automationId === automationId && r.row.subject === request.trigger.subject && r.cancelling === undefined);
          // §8.1: a schedule tick skips while a run for its key is going (or waiting for a slot); anything else replaces it.
          if (running.length > 0 && request.trigger.kind === "schedule") {
            yield* journal.insert({ ...row, status: "cancelled", reason: "skipped_overlap", endedAt: at, steps: plan.steps.map((s) => ({ name: s.name, status: "skipped" })) });
            return { refused: "skipped_overlap", message: `A run of ${automation.name} for this schedule is still going (${running[0]!.runId}), so this tick was skipped.` } as const;
          }
          for (const old of running) yield* cancel(old.runId, "superseded");
          const admitted: RunEvent = { type: "run_admitted", at, run: runId, plan };
          const transition = next(undefined, admitted);
          const run = liveOf(row, transition.state);
          if (going(request.projectId) >= MAX_RUNNING_PER_PROJECT || queue.some((q) => q.run.row.projectId === request.projectId)) {
            // A12: the project has its runs going (or others already waiting); this one waits its turn, journalled when it starts.
            yield* journal.insert({ ...row, status: "queued", steps: transition.state.steps.map((s) => ({ name: s.name, status: s.status })) });
            live.set(runId, run);
            queue.push({ run, actions: transition.actions, admission: admitted });
            yield* startQueued;
          } else {
            yield* journal.insert({ ...row, steps: transition.state.steps.map((s) => ({ name: s.name, status: s.status })) }, admitted);
            if (host.observe !== undefined) yield* host.observe(row, admitted, transition.state).pipe(Effect.catchCause(() => Effect.void));
            yield* launch(run, transition.actions);
          }
          return { runId, ...(running[0] === undefined ? {} : { replaced: running[0].runId }) };
        }),
      );

    // ---------------------------------------------------------------- approvals

    const approve = (input: Parameters<AutomationRunner["Service"]["approve"]>[0]): Effect.Effect<ApproveResult> =>
      Effect.gen(function* () {
        yield* Deferred.await(resumeDone);
        const run = live.get(input.runId);
        if (run === undefined) {
          const known = yield* journal.get(input.runId);
          return known === undefined
            ? ({ refused: "not_found", message: `No run ${input.runId}.` } as const)
            : ({ refused: "invalid_state", message: `Run ${input.runId} is not waiting for an approval.` } as const);
        }
        const step = run.state.steps.find((s) => s.name === input.step);
        if (step === undefined) return { refused: "not_found", message: `Run ${input.runId} has no step ${input.step}.` } as const;
        const gate = run.approvals.get(input.step);
        if (step.status !== "waiting" || step.approval === undefined || step.approval.decision !== undefined || gate === undefined) {
          return { refused: "invalid_state", message: `Step ${input.step} is not waiting for an approval.` } as const;
        }
        const answered = yield* Deferred.succeed(gate.answer, {
          decision: input.decision,
          ...(input.by === undefined ? {} : { by: input.by }),
          ...(input.message === undefined ? {} : { message: input.message }),
        });
        if (!answered) return { refused: "invalid_state", message: `Step ${input.step} was already answered.` } as const;
        yield* Deferred.await(gate.recorded).pipe(Effect.timeoutOption("10 seconds"));
        return { run: recordOf(run.row, run.state, yield* workspacesOf(run.state), host.environment) };
      });

    // ---------------------------------------------------------------- cleanup (K2)

    /**
     * K2: a finished run's worktree goes after WORKTREE_KEEP_MS, or sooner while its project holds more than
     * KEEP_WORKTREES, never while its dry-run outputs wait to be applied (and it is younger than that). Its local
     * caveman/* branch goes with it when nothing pushed it and no other run uses it.
     */
    const cleanup: Effect.Effect<void> = Effect.gen(function* () {
      const rows = yield* journal.withWorktrees;
      const byProject = new Map<string, RunRow[]>();
      for (const row of rows) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row]);
      for (const [projectId, held] of byProject) {
        const root = yield* deps.projectRoot(projectId);
        if (root === undefined) continue;
        let count = held.length;
        for (const row of held) {
          if (live.has(row.runId) || !isTerminal(row.status) || row.worktree === null) continue;
          const old = Date.now() - Date.parse(row.endedAt ?? row.startedAt) > WORKTREE_KEEP_MS;
          if (!old && count <= KEEP_WORKTREES) continue;
          if (!old) {
            const state = replay(yield* journal.events(row.runId));
            if (state?.outputs.some((o) => o.status === "dry_run") === true) continue;
          }
          yield* removeCopy(rootGit, root, row.worktree);
          yield* journal.forgetWorktree(row.runId);
          count--;
          const branch = row.branch;
          const shared = branch === null || [...live.values()].some((r) => r.row.branch === branch) || held.some((r) => r !== row && r.branch === branch && r.worktree !== null);
          if (!shared && branch !== null && branch.startsWith("caveman/")) {
            const pushed = (yield* rootGit(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])).code === 0;
            if (!pushed) yield* rootGit(root, ["branch", "-D", "--", branch]);
          }
        }
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not clean up automation worktrees", cause)));

    /** On start: worktrees under the automations folder that no run references are removed (K2). */
    const prune = Effect.gen(function* () {
      const referenced = new Set((yield* journal.withWorktrees).map((r) => path.resolve(r.worktree!)));
      const liveIds = [...live.keys()];
      const kept = (at: string) => referenced.has(path.resolve(at)) || liveIds.some((id) => path.basename(at).startsWith(`${id}.`) || path.basename(at) === id);
      const projects = new Set((yield* journal.list({ limit: 1000 })).map((r) => r.projectId));
      for (const projectId of projects) {
        const root = yield* deps.projectRoot(projectId);
        if (root === undefined) continue;
        const listed = yield* rootGit(root, ["worktree", "list", "--porcelain"]);
        const ours = listed.stdout
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice(9))
          .filter((at) => path.resolve(at).startsWith(path.resolve(deps.worktreesDir) + path.sep) && !kept(at));
        for (const at of ours) yield* removeCopy(rootGit, root, at);
      }
      if (fs.existsSync(deps.worktreesDir)) {
        for (const name of fs.readdirSync(deps.worktreesDir)) {
          const at = path.join(deps.worktreesDir, name);
          if (!kept(at) && !referenced.has(path.resolve(at.replace(/\.held$/, "")))) fs.rmSync(at, { recursive: true, force: true });
        }
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not prune automation worktrees", cause)));

    // ---------------------------------------------------------------- resume

    /** §11: runs a restart left going continue from their journal; a step with a completion record is not run again. */
    const resume = Effect.gen(function* () {
      for (const row of yield* journal.live) {
        const events = yield* journal.events(row.runId);
        if (events.length === 0 && row.status === "queued") {
          // Queued, never started: it waits again, in admission order.
          const { admission, transition } = admissionOf(row);
          const run = liveOf(row, transition.state);
          live.set(row.runId, run);
          queue.push({ run, actions: transition.actions, admission });
          continue;
        }
        const state = replay(events);
        if (state === undefined) continue;
        const run = liveOf(row, state);
        // The agent turns that were under way, and the attempts being stopped, may still be running in their engines:
        // stop them before deciding.
        const inFlight = state.steps.flatMap((s) => s.attempts.filter((a) => a.status === "running" && a.threadId !== undefined).map((a) => a.threadId!));
        if (inFlight.length > 0) yield* engine.stop(inFlight, "resume");
        if (isTerminal(state.status)) {
          // It ended before the restart, and its finish never ran: what it still owes (its stops, its finish) is done now.
          yield* launch(run, state.owed);
          continue;
        }
        const actions = yield* append(run, { type: "run_resumed", at: now() });
        if (going(row.projectId) >= MAX_RUNNING_PER_PROJECT) {
          live.set(row.runId, run);
          queue.push({ run, actions });
        } else yield* launch(run, actions);
      }
      yield* startQueued;
      yield* prune;
      yield* cleanup;
    });
    const resumed = resume.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not resume automation runs", cause)),
      Effect.ensuring(Deferred.succeed(resumeDone, undefined)),
    );
    // On a Cloud computer a run left going is Cloud's: it resumes once the Cloud host is in place (its events, outputs
    // and record go through it), or after a minute without one.
    if (deps.awaitHost === true) yield* Deferred.await(hostSet).pipe(Effect.timeoutOption("60 seconds"), Effect.andThen(resumed), Effect.forkIn(scope));
    else yield* resumed;

    // ---------------------------------------------------------------- the rest

    // One apply at a time, each reading the journal afresh: a second click finds nothing left in dry run.
    const applyLock = yield* Semaphore.make(1);
    const applyOutputs = (runId: string, key?: string): Effect.Effect<ReadonlyArray<typeof AutomationRunOutput.Type>> =>
      applyLock.withPermits(1)(Effect.gen(function* () {
        const row = yield* journal.get(runId);
        if (row === undefined) return [];
        const state = replay(yield* journal.events(runId));
        if (state === undefined) return [];
        const run = live.get(runId) ?? liveOf(row, state);
        if (isTerminal(state.status)) {
          // B21: one output by its key, or all of them.
          for (const output of state.outputs) {
            if (output.status === "dry_run" && (key === undefined || output.key === key)) yield* writeOutput(run, output.key, "apply").pipe(Effect.catchCause(() => Effect.succeed([])));
          }
        }
        return recordOf(run.row, run.state, new Map(), host.environment).outputs;
      }));

    const runs = (filter: Parameters<AutomationRunner["Service"]["runs"]>[0]) =>
      journal
        .list({
          ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }),
          ...(filter.automationId === undefined ? {} : { automationId: filter.automationId }),
          ...(filter.automation === undefined ? {} : { automation: filter.automation }),
          ...(filter.status === undefined ? {} : { status: filter.status }),
          ...(filter.agentRuns === true ? { agentRuns: true } : {}),
          ...(filter.live === true ? { live: true } : {}),
          limit: filter.scope === undefined ? (filter.limit ?? 50) : 1000,
        })
        .pipe(
          Effect.map((rows) =>
            rows
              // B21: a scope names file automations of that scope (`file:<project>:<scope>:<name>`).
              .filter((r) => filter.scope === undefined || scopeOfId(r.automationId) === filter.scope)
              .slice(0, filter.live === true ? undefined : (filter.limit ?? 50))
              .map(summaryOf),
          ),
        );

    /** The workspace each of a run's threads was adopted as (B4). */
    const workspacesOf = (state: RunState | undefined) => {
      const ids = (state?.steps ?? []).flatMap((s) =>
        s.attempts.flatMap((a) => [
          ...(a.threadId === undefined ? [] : [a.threadId]),
          ...a.checks.flatMap((c) => (c.threadId === undefined ? [] : [c.threadId])),
          ...(a.grade?.threadId === undefined ? [] : [a.grade.threadId]),
        ]),
      );
      return engine.workspaces(ids);
    };

    /**
     * A run that has no events never started: still queued (read before resume queues it again, shown as a live one
     * is), or ended as cancel and admit ended it, which its row and its host were told. A row ended any other way
     * without events is not one this runner wrote, so nothing is made up for its steps.
     */
    const neverStarted = (row: RunRow): RunState | undefined => {
      const admitted = admissionOf(row).transition.state;
      if (!isTerminal(row.status)) return { ...admitted, status: row.status };
      return row.status === "cancelled" && isUnstarted(row.reason) && row.endedAt !== null ? endedUnstarted(admitted, row.reason, row.endedAt) : undefined;
    };

    const get = (runId: string) =>
      Effect.gen(function* () {
        const running = live.get(runId);
        // A run waiting for a slot (A12) says so; its steps are all still pending.
        if (running !== undefined) {
          const state = queue.some((q) => q.run === running) && running.fiber === undefined ? { ...running.state, status: "queued" as const } : running.state;
          return recordOf(running.row, state, yield* workspacesOf(running.state), host.environment);
        }
        const row = yield* journal.get(runId);
        if (row === undefined) return undefined;
        const events = yield* journal.events(runId);
        const state = events.length === 0 ? neverStarted(row) : replay(events);
        return recordOf(row, state, yield* workspacesOf(state), host.environment);
      });

    return AutomationRunner.of({
      admit,
      cancel: (runId, reason) => cancel(runId, reason),
      applyOutputs: (runId, key) => applyOutputs(runId, key),
      runs,
      get,
      useLauncher: (launcher) => deps.setLauncher?.(launcher) ?? Effect.void,
      approve,
      useHost: (next) => Effect.sync(() => void (host = { ...host, ...next } as typeof host)).pipe(Effect.andThen(Deferred.succeed(hostSet, undefined)), Effect.asVoid),
      useChief: (sink) => Deferred.succeed(chiefSet, sink).pipe(Effect.asVoid),
    });
  });

/** The runner on the runtime: steps as threads in Caveman Code projects, git through the runtime's driver. */
export const layer = Layer.effect(
  AutomationRunner,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* makeJournal;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const config = yield* ServerConfig.ServerConfig;
    const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const credentials = yield* Effect.serviceOption(GitHubCredentials.GitHubCredentials);
    const projects = yield* ProjectStore.make;
    // The first launcher wakes steps that started before the Session Protocol was up; a later one replaces it.
    const ready = yield* Deferred.make<StepLauncher>();
    let current: StepLauncher | undefined;
    const launcher = Effect.suspend(() =>
      current !== undefined
        ? Effect.succeed(current)
        : Deferred.await(ready).pipe(
            Effect.timeoutOption("2 minutes"),
            Effect.flatMap(Option.match({ onNone: () => Effect.fail(new StepError({ reason: "engine_unavailable", message: "Caveman Code's session server did not start." })), onSome: Effect.succeed })),
          ),
    );
    const engine = makeThreadEngine({
      launcher,
      providers: Option.isNone(providers) ? Effect.succeed([]) : providers.value.getProviders,
      threadLaunch: yield* ThreadLaunchService.ThreadLaunchService,
      threads: yield* ThreadManagementService.ThreadManagementService,
      sql,
      register: journal.register,
    });
    return yield* makeRunner({
      journal,
      engine,
      git: gitOf(driver),
      processRunner: yield* ProcessRunnerService.ProcessRunner,
      github: Option.isNone(credentials) ? undefined : gitHubRest(credentials.value),
      projectRoot: (projectId) =>
        projects.get(ProjectId.make(projectId)).pipe(
          Effect.map((row) => Option.getOrUndefined(row)?.workspaceRoot),
          Effect.orElseSucceed(() => undefined),
        ),
      worktreesDir: path.join(config.worktreesDir, "automations"),
      sharedWithTools: toolsSocket() !== undefined,
      // A Cloud computer's git has no person's identity: a run's commits are Caveman Code's (its pushes go as the App).
      ...(toolsSocket() !== undefined ? { commitIdentity: CLOUD_COMMIT_IDENTITY } : {}),
      coAuthor: sql<{ value: string }>`SELECT value FROM caveman_sp_kv WHERE key = 'settings'`.pipe(
        Effect.map((rows) => coAuthorOn(rows[0]?.value)),
        Effect.orElseSucceed(() => true),
      ),
      setLauncher: (next) => Effect.sync(() => void (current = next)).pipe(Effect.andThen(Deferred.succeed(ready, next)), Effect.asVoid),
      // On a Cloud computer the Cloud host (handlers.ts) says where runs happen before any run left going resumes.
      awaitHost: (yield* CloudComputer) !== undefined,
      // The launcher's, once the Session Protocol is up. A command never waits for it as a step's agent does: it needs
      // no engine, so one that runs before the session server is up runs without the run's variables.
      runEnv: (runId, cwd) => Effect.suspend(() => current?.runEnv?.(runId, cwd) ?? Effect.succeed(undefined)),
      runEnded: (runId) => Effect.suspend(() => current?.runEnded?.(runId) ?? Effect.void),
    });
  }),
);
