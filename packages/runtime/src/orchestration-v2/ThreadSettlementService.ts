// ), apps/server/src/orchestration-v2/ThreadSettlementService.ts @ ab3a3cd1.
import {
  backgroundWorkHoldsCompletion,
  turnItemUpdateCanEndBackgroundWork,
} from "@caveman-app/shared/orchestrationV2PendingBackgroundWork";
import { resolveProjectSettings } from "@caveman-app/shared/projectSettings";
import { visibleThreadPullRequests } from "@caveman-app/shared/threadPullRequests";
import {
  CommandId,
  isOrchestrationV2WorkActive,
  type ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@caveman-app/protocol";
import { makeDrainableWorker } from "@caveman-app/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { isSessionProtocolProject } from "./ProjectCommands.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { PULL_REQUEST_CLOSE_COMMAND } from "./PullRequestSyncReactor.ts";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

function latestMillis(values: ReadonlyArray<number | null>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

function canonicalRepositoryKey(key: string): string {
  return key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
}

function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: {
    readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
  },
): boolean {
  return (
    pullRequest.repositoryKey !== null &&
    project.repositoryIdentity != null &&
    canonicalRepositoryKey(pullRequest.repositoryKey) ===
      canonicalRepositoryKey(project.repositoryIdentity.canonicalKey)
  );
}

type SettlementPullRequestLink = NonNullable<
  ProjectionStore.ProjectionSettlementCandidate["pullRequests"]
>[number];

/** When the linked pull request merged or closed, or -Infinity if it has not. */
function linkTerminalAtMs(link: SettlementPullRequestLink): number {
  const snapshot = link.snapshot;
  const value = snapshot?.state === "merged" ? snapshot.mergedAt : snapshot?.closedAt;
  const timestamp = Date.parse(value ?? "");
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

/**
 * The links whose outcome the thread waits on. A link made after its pull
 * request had already merged or closed records work the thread did, such as an
 * agent merging pull requests it was asked to merge, so it cannot settle the
 * thread.
 */
function settlementPullRequestLinks(
  links: ReadonlyArray<SettlementPullRequestLink>,
): ReadonlyArray<SettlementPullRequestLink> {
  return visibleThreadPullRequests(links).filter((link) => {
    if (link.snapshot === null || link.snapshot.state === "open") return true;
    const linkedAtMs = Date.parse(link.linkedAt);
    return Number.isNaN(linkedAtMs) || linkTerminalAtMs(link) >= linkedAtMs;
  });
}

/**
 * A recent user message stays queued until a run adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. A failed run start
 * clears the block immediately (mirrors the v1 session "error" rule).
 */
export function threadHasQueuedTurnStart(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
): boolean {
  const messageAtMs = toMillis(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
}

/**
 * A merged or closed pull request settles the thread unless the user wrote to
 * it afterwards. Runs that background work, a PR watch, or another agent
 * started do not count, so they cannot hold a merged thread open.
 */
function pullRequestSettles(
  thread: Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    "createdAt" | "latestUserAuthoredMessageAt"
  >,
  pullRequest: SettlementPullRequest,
  autoSettleOnMerge: boolean,
): boolean {
  if (pullRequest.state !== "closed" && (pullRequest.state !== "merged" || !autoSettleOnMerge)) {
    return false;
  }
  const terminalAt = pullRequest.state === "merged" ? pullRequest.mergedAt : pullRequest.closedAt;
  if (terminalAt == null) return false;
  const userAnchorMs = latestMillis([
    toMillis(thread.createdAt),
    toMillis(thread.latestUserAuthoredMessageAt),
  ]);
  if (userAnchorMs === null) return false;
  const pullRequestAtMs = Date.parse(terminalAt);
  if (Number.isNaN(pullRequestAtMs)) return false;
  return pullRequestAtMs >= userAnchorMs;
}

/** Cheap checks that run before any source control lookup. */
export function isAutoSettlementCandidate(
  thread: Omit<ProjectionStore.ProjectionSettlementCandidate, "latestUserAuthoredMessageAt">,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  // Blocked-on-you work must never park behind a settled override.
  if (thread.pendingRuntimeRequest !== null) return false;
  // A live run, or background work that will wake the agent, is not
  // staleness. A dev server left running is: the agent is done.
  if (thread.activityRunStatus != null) return false;
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  // Interrupted runs must keep the same snooze protection the sidebar shows.
  return !isSnoozed(thread, nowMs);
}

/**
 * Whether a thread is parked on its snooze: its wake time is in the future and
 * it has not raised its hand with a pending request or a fresh failure (completed
 * runs and background wakes keep it snoozed). Server twin of the client's
 * `effectiveSnoozed`, so agents and the sidebar agree on what is snoozed. One
 * difference: a failure counts as fresh when its run completed after the
 * snooze, like `isAutoSettlementCandidate`. The client compares the shell's
 * update time, so a rename can wake a failed thread there but not here.
 */
export function isSnoozed(
  thread: Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    "snoozedUntil" | "snoozedAt" | "latestRunCompletedAt" | "status" | "pendingRuntimeRequest"
  >,
  nowMs: number,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  const snoozedAtMs = toMillis(thread.snoozedAt);
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  return !wokeOnError;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: ProjectionStore.ProjectionSettlementCandidate;
  readonly pullRequest: SettlementPullRequest | null;
  readonly nowMs: number;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
  readonly autoSettleKeepPullRequests?: boolean;
}): DateTime.Utc | null {
  const { thread } = input;
  let pullRequest = input.pullRequest;
  const links = settlementPullRequestLinks(thread.pullRequests ?? []);
  if (links.some((link) => link.snapshot === null)) return null;
  // An open link means the pull request has not finished, so only inactivity
  // can settle the thread, never a merged or closed lookup.
  const hasOpenLink = links.some((link) => link.snapshot?.state === "open");
  if (hasOpenLink) {
    pullRequest = null;
  } else if (links.length > 0) {
    const latest = links.reduce((current, candidate) =>
      linkTerminalAtMs(candidate) > linkTerminalAtMs(current) ? candidate : current,
    );
    pullRequest =
      latest.snapshot === null
        ? null
        : {
            state: latest.snapshot.state,
            mergedAt: latest.snapshot.mergedAt ?? null,
            closedAt: latest.snapshot.closedAt ?? null,
          };
  }
  if (!isAutoSettlementCandidate(thread, input.nowMs)) return null;
  const activityAtMs =
    latestMillis([
      toMillis(thread.latestUserMessageAt),
      toMillis(thread.latestRunRequestedAt),
      toMillis(thread.latestRunStartedAt),
      toMillis(thread.latestRunCompletedAt),
    ]) ?? DateTime.toEpochMillis(thread.createdAt);
  if (pullRequest !== null && pullRequestSettles(thread, pullRequest, input.autoSettleOnMerge)) {
    return DateTime.makeUnsafe(activityAtMs);
  }
  const hasPullRequest =
    hasOpenLink ||
    pullRequest !== null ||
    thread.linkedPullRequest != null ||
    thread.branchPullRequest != null;
  if (input.autoSettleKeepPullRequests === true && hasPullRequest) return null;
  if (input.autoSettleAfterDays === null) return null;
  // A passed wake timer restarts inactivity. An earlier wake can only delay settlement.
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  const timerWakeAtMs =
    snoozedUntilMs !== null && snoozedUntilMs <= input.nowMs ? snoozedUntilMs : null;
  const inactivityAtMs =
    latestMillis([activityAtMs, toMillis(thread.lastSnoozeWakeAt), timerWakeAtMs]) ?? activityAtMs;
  return inactivityAtMs < input.nowMs - input.autoSettleAfterDays * DAY_MS
    ? DateTime.makeUnsafe(inactivityAtMs)
    : null;
}

export class ThreadSettlementServiceV2 extends Context.Service<
  ThreadSettlementServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadSettlementService/ThreadSettlementServiceV2") {}

function autoSettlementConfigured(settings: import("@caveman-app/protocol").ServerSettings): boolean {
  if (settings.sidebarAutoSettleOnMerge || settings.sidebarAutoSettleAfterDays !== null) {
    return true;
  }
  return Object.values(settings.projectSettingsOverrides).some(
    (entry) =>
      entry.sidebarAutoSettleOnMerge === true ||
      (entry.sidebarAutoSettleAfterDays !== undefined && entry.sidebarAutoSettleAfterDays !== null),
  );
}

/** Identity of every settlement input, so unrelated settings edits do not trigger a sweep. */
/** @internal Exported for tests. */
export function autoSettlementSettingsKey(
  settings: import("@caveman-app/protocol").ServerSettings,
): string {
  return JSON.stringify([
    settings.sidebarAutoSettleOnMerge,
    settings.sidebarAutoSettleAfterDays,
    settings.sidebarAutoSettleKeepPullRequests,
    // Only entries that touch settlement, in a stable order, so a project
    // override on an unrelated key does not queue a sweep. JSON drops
    // undefined, so inherit (absent) and never (null) need distinct marks.
    Object.entries(settings.projectSettingsOverrides)
      .filter(
        ([, entry]) =>
          entry.sidebarAutoSettleOnMerge !== undefined ||
          entry.sidebarAutoSettleAfterDays !== undefined ||
          entry.sidebarAutoSettleKeepPullRequests !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entry]) => [
        projectId,
        entry.sidebarAutoSettleOnMerge ?? "inherit",
        entry.sidebarAutoSettleAfterDays === undefined
          ? "inherit"
          : entry.sidebarAutoSettleAfterDays,
        entry.sidebarAutoSettleKeepPullRequests ?? "inherit",
      ]),
  ]);
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A shell merge or close sends no event, and the branch lookup caches an open pull request for
  // a minute, so these threads' next lookup reads the host fresh.
  const shellClosedThreads = new Set<ThreadId>();
  const terminals = yield* TerminalManager.TerminalManager;
  const projectScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  // Settling a settled thread re-emits thread.settled with the same settledAt,
  // so this keeps the settle action to one run per settlement.
  const settleActionRunAt = new Map<ThreadId, number>();

  const sweep = Effect.fn("ThreadSettlementServiceV2.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
    threadId?: ThreadId,
  ) {
    const settings = yield* settingsService.getSettings;
    if (!autoSettlementConfigured(settings)) {
      return;
    }
    // A sweep for one thread reads only that thread's candidate row.
    // Ours: Caveman Code workspaces never settle (settling closes their idle terminals).
    const threads = (yield* projections.getSettlementCandidates(threadId)).filter(
      (thread) => !isSessionProtocolProject(thread.projectId),
    );
    if (threads.length === 0) return;
    const projectShells = yield* projectStore.listShells();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const projects = new Map(projectShells.map((project) => [project.id, project]));
    // A merge event re-sweeps every candidate, not just the threads linked to
    // the merged pull request: most threads carry no link and settle from
    // their branch lookup, which would otherwise wait for the next minute's
    // sweep on a possibly stale cached answer.
    const candidates = threads.filter((thread) => isAutoSettlementCandidate(thread, nowMs));

    // Runs per candidate thread, thousands per sweep on busy servers; the sweep owns the span.
    const settleThread = Effect.fnUntraced(
      function* (thread: (typeof candidates)[number], pullRequest: SettlementPullRequest | null) {
        // thread.auto-settle does not recheck settings, so read them per decision; reads are cached.
        const currentSettings = resolveProjectSettings(
          yield* settingsService.getSettings,
          thread.projectId,
        ).settings;
        const decisionNow = yield* DateTime.now;
        const settledAt = resolveAutoSettlementAt({
          thread,
          pullRequest,
          nowMs: DateTime.toEpochMillis(decisionNow),
          autoSettleAfterDays: currentSettings.sidebarAutoSettleAfterDays,
          autoSettleOnMerge: currentSettings.sidebarAutoSettleOnMerge,
          autoSettleKeepPullRequests: currentSettings.sidebarAutoSettleKeepPullRequests,
        });
        if (settledAt === null) return thread;
        const uuid = yield* random.uuidV4();
        yield* orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
          threadId: thread.id,
          snapshotAt: thread.updatedAt,
          settledAt,
        });
        return null;
      },
      (effect, thread) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
          ),
        ),
    );

    // Inactivity is entirely projection-backed. Complete those decisions before
    // a source-control lookup can delay or fail an otherwise eligible thread.
    const lookupCandidates = (yield* Effect.forEach(
      candidates,
      (thread) => {
        const projectSettings = resolveProjectSettings(settings, thread.projectId).settings;
        // Skip no-op decisions; a real settlement still reads fresh settings before it dispatches.
        const settledAt = resolveAutoSettlementAt({
          thread,
          pullRequest: null,
          nowMs,
          autoSettleAfterDays: projectSettings.sidebarAutoSettleAfterDays,
          autoSettleOnMerge: projectSettings.sidebarAutoSettleOnMerge,
          autoSettleKeepPullRequests: projectSettings.sidebarAutoSettleKeepPullRequests,
        });
        return settledAt === null ? Effect.succeed(thread) : settleThread(thread, null);
      },
      { concurrency: 8 },
    ))
      .filter((thread) => thread !== null)
      .filter((thread) => visibleThreadPullRequests(thread.pullRequests ?? []).length === 0)
      // Without a branch or a linked pull request there is nothing to look up; the decision above stands.
      .filter(
        (thread) =>
          thread.branch !== null ||
          thread.linkedPullRequest != null ||
          thread.branchPullRequest != null,
      );
    // Use the same cwd as the sidebar so both paths share GitManager's PR cache.
    const lookupCwdByThreadId = new Map<string, string>();
    yield* Effect.forEach(
      lookupCandidates,
      (thread) =>
        Effect.gen(function* () {
          const project = projects.get(thread.projectId);
          if (project === undefined || thread.branch === null) return;
          // A worktree folder can outlive its .git, and git there fails with not_a_repository.
          // An unreadable .git keeps the worktree, so git fails there and the thread is skipped.
          lookupCwdByThreadId.set(
            thread.id,
            thread.worktreePath !== null &&
              (yield* fileSystem
                .exists(path.join(thread.worktreePath, ".git"))
                .pipe(Effect.orElseSucceed(() => true)))
              ? thread.worktreePath
              : project.workspaceRoot,
          );
        }),
      { concurrency: 8, discard: true },
    );
    if (mergedPullRequest !== null) {
      // The merge just confirmed a terminal state the lookup caches can still
      // call open (branch answers live two minutes, the sweep runs every
      // minute). Drop the swept checkouts' cached answers so the merge settles
      // its branch threads now instead of on a later sweep. Threads linked to
      // the merged pull request settle from the event itself below and need no
      // lookup, so they are absent from this map by construction.
      const cwds = [...new Set(lookupCwdByThreadId.values())];
      yield* Effect.forEach(cwds, (cwd) => git.invalidateStatus(cwd), {
        concurrency: 8,
        discard: true,
      });
    }
    const lookupKey = (thread: (typeof lookupCandidates)[number]) => {
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        return JSON.stringify([
          "linked",
          reference.projectId,
          reference.repository,
          reference.number,
          lookupCwdByThreadId.get(thread.id),
          thread.branch,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const cwd = lookupCwdByThreadId.get(thread.id);
      return JSON.stringify(
        cwd === undefined ? ["missing-project", thread.id] : ["branch", cwd, thread.branch],
      );
    };
    const groups = Map.groupBy(lookupCandidates, lookupKey);

    // wouldSettle and pullRequestFor run per lookup group; the git and pull request reads they make carry the spans.
    const wouldSettle = Effect.fnUntraced(function* (
      group: ReadonlyArray<(typeof lookupCandidates)[number]>,
      pullRequest: SettlementPullRequest,
    ) {
      const currentSettings = yield* settingsService.getSettings;
      const decisionNow = yield* DateTime.now;
      return group.some((thread) => {
        const { settings } = resolveProjectSettings(currentSettings, thread.projectId);
        return (
          resolveAutoSettlementAt({
            thread,
            pullRequest,
            nowMs: DateTime.toEpochMillis(decisionNow),
            autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
            autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
            autoSettleKeepPullRequests: settings.sidebarAutoSettleKeepPullRequests,
          }) !== null
        );
      });
    });

    const pullRequestFor = Effect.fnUntraced(function* (
      group: ReadonlyArray<(typeof lookupCandidates)[number]>,
    ) {
      const thread = group[0]!;
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        // The event carries the merged state, so only the threads linked to
        // that exact pull request settle from it. Every other linked thread
        // falls through to a fresh summary lookup below: the merge sweep
        // covers all candidates, and an unrelated merge must never settle
        // them.
        const matchesMerge =
          mergedPullRequest !== null &&
          reference.projectId === mergedPullRequest.projectId &&
          reference.repository.toLowerCase() === mergedPullRequest.repository.toLowerCase() &&
          reference.number === mergedPullRequest.number;
        if (!matchesMerge && !projects.has(reference.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const summary = matchesMerge
          ? ({
              state: "merged",
              closedAt: null,
              mergedAt: mergedPullRequest.mergedAt,
            } satisfies SettlementPullRequest)
          : yield* pullRequests.summary(
              {
                projectId: reference.projectId,
                repository: reference.repository,
                number: reference.number,
              },
              { recoverTransientFailure: false },
            );
        const terminal = {
          state: summary.state,
          closedAt: summary.closedAt ?? null,
          mergedAt: summary.mergedAt ?? null,
        } satisfies SettlementPullRequest;
        const cwd = lookupCwdByThreadId.get(thread.id);
        if (summary.state !== "open" && thread.branch !== null && cwd !== undefined) {
          // Recheck reused branches only when this sweep would settle a thread.
          // Eligibility that changes after this check waits for the next sweep.
          if (!(yield* wouldSettle(group, terminal))) return undefined;
          const current = yield* git.branchPullRequest(
            { cwd, branch: thread.branch },
            { refresh: true },
          );
          const project = projects.get(thread.projectId);
          if (
            current?.state === "open" &&
            project !== undefined &&
            pullRequestMatchesProject(current, project)
          ) {
            return current;
          }
        }
        return terminal;
      }
      if (thread.branch === null) return null;
      const cwd = lookupCwdByThreadId.get(thread.id);
      if (cwd === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      const refresh = group.filter((member) => shellClosedThreads.delete(member.id)).length > 0;
      return yield* git.branchPullRequest({ cwd, branch: thread.branch }, { refresh });
    });

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const pullRequest = yield* pullRequestFor(group);
          if (pullRequest === undefined) return;
          yield* Effect.forEach(group, (thread) => settleThread(thread, pullRequest), {
            discard: true,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const runSweep = (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
    threadId?: ThreadId,
  ) =>
    sweep(mergedPullRequest, threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  // A thread that just stopped must not wait behind a full sweep or another thread's host
  // reads: clients hold it in Working only briefly, so a late settle makes it appear and then vanish.
  const fullSweeps = yield* makeDrainableWorker(() => runSweep(null));
  const threadSweeps = yield* FiberSet.make<void>();
  const threadSweepSlots = yield* Semaphore.make(8);
  // One sweep per thread at a time; events during a running sweep coalesce into one more pass.
  const threadSweepStates = new Map<ThreadId, "queued" | "running" | "rerun">();
  const sweepThread = (
    threadId: ThreadId,
  ): Effect.Effect<void, Effect.Error<ReturnType<typeof runSweep>>> =>
    Effect.sync(() => threadSweepStates.set(threadId, "running")).pipe(
      Effect.andThen(runSweep(null, threadId)),
      threadSweepSlots.withPermits(1),
      Effect.andThen(
        Effect.suspend(() => {
          if (threadSweepStates.get(threadId) === "rerun") return sweepThread(threadId);
          threadSweepStates.delete(threadId);
          return Effect.void;
        }),
      ),
    );
  const enqueueThread = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const state = threadSweepStates.get(threadId);
      if (state === "running") threadSweepStates.set(threadId, "rerun");
      if (state !== undefined) return Effect.void;
      threadSweepStates.set(threadId, "queued");
      return sweepThread(threadId).pipe(FiberSet.run(threadSweeps), Effect.asVoid);
    });

  // Settling closes the thread's shells that sit at an idle prompt, so they stop
  // holding the worktree. A terminal running a command (a dev server, an
  // editor) stays for the user to close. Then the project's settle script runs
  // in the thread's own worktree; a thread in the shared checkout skips it,
  // because other threads may still be working there.
  const cleanUpSettledThread = Effect.fn("ThreadSettlementServiceV2.cleanUpSettledThread")(
    function* (threadId: ThreadId) {
      // A thread re-engaged before this event ran keeps its shells.
      const settled = yield* projections.getThread(threadId);
      if (settled.settledOverride !== "settled") return;
      yield* terminals.closeIdle({ threadId });
      const worktreePath = settled.worktreePath;
      if (worktreePath === null || !(yield* fileSystem.exists(worktreePath))) return;
      // Closing and the worktree check wait on I/O. A thread re-engaged
      // meanwhile is working again, so its worktree is no place for cleanup.
      const thread = yield* projections.getThread(threadId);
      if (thread.settledOverride !== "settled") return;
      const settledAtMs = toMillis(thread.settledAt);
      if (settledAtMs === null || settleActionRunAt.get(threadId) === settledAtMs) return;
      const run = yield* projectScripts.runForThread({
        threadId,
        projectId: thread.projectId,
        worktreePath,
        trigger: "settle",
        // A clean exit closes the script's shell so it does not hold the worktree.
        observeCompletion: {},
      });
      // Recorded after a successful start, so a failed start retries on the next event.
      settleActionRunAt.set(threadId, settledAtMs);
      if (run.status === "started" && run.completion) {
        yield* run.completion.pipe(Effect.forkDetach);
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("cleaning up a settled thread failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.settled":
        return cleanUpSettledThread(event.threadId);
      case "thread.pull-request-link-updated":
      case "thread.pull-request-synced":
      case "provider-session.detached":
      case "run.background-work-cancelled":
        return enqueueThread(event.threadId);
      // Sweep only when the work can have ended: progress updates cannot settle anything.
      case "subagent.updated":
        return isOrchestrationV2WorkActive(event.payload.status)
          ? Effect.void
          : enqueueThread(event.threadId);
      case "provider-thread.updated":
        return backgroundWorkHoldsCompletion(event.payload.pendingBackgroundTasks ?? [])
          ? Effect.void
          : enqueueThread(event.threadId);
      case "turn-item.updated": {
        const item = event.payload;
        // Remember a finished shell merge or close so the sweep reads the branch's
        // pull request fresh.
        if (
          item.type === "command_execution" &&
          !isOrchestrationV2WorkActive(item.status) &&
          PULL_REQUEST_CLOSE_COMMAND.test(item.input)
        ) {
          shellClosedThreads.add(event.threadId);
        }
        return turnItemUpdateCanEndBackgroundWork(item)
          ? enqueueThread(event.threadId)
          : Effect.void;
      }
      case "provider-session.updated":
        return event.payload.status !== "starting" && event.payload.status !== "running"
          ? enqueueThread(event.threadId)
          : Effect.void;
      case "run.updated":
        return ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
          event.payload.status,
        )
          ? enqueueThread(event.threadId)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: ThreadSettlementServiceV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementServiceV2.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const events = orchestrator.streamDomainEvents;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastSettlementSettings = autoSettlementSettingsKey(initialSettings);
    yield* forkParked(
      Effect.gen(function* () {
        yield* fullSweeps.enqueue(undefined);
        yield* fullSweeps.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        const key = autoSettlementSettingsKey(settings);
        if (key === lastSettlementSettings) {
          return Effect.void;
        }
        lastSettlementSettings = key;
        return fullSweeps.enqueue(undefined);
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, (event) => runSweep(event)));
    yield* forkParked(
      Stream.runForEach(events, processEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread settlement event stream failed", { cause }),
        ),
      ),
    );
  });

  return {
    start,
    drain: Effect.andThen(fullSweeps.drain, FiberSet.awaitEmpty(threadSweeps)),
  } satisfies ThreadSettlementServiceV2["Service"];
});

export const layer = Layer.effect(ThreadSettlementServiceV2, make);
