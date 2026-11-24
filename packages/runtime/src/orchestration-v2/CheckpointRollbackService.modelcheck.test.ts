// Model check: a rollback (the provider-thread.rollback effect) that fails at any of its steps and is retried by the
// effect worker, up to its 5 attempts, still ends with the provider holding exactly the turns up to the target, the
// files under the thread's directory byte-identical to the target checkpoint, nothing else in the repository touched,
// and each later run marked rolled_back once. A rollback whose restore refuses (the person's ignored file in its way)
// refuses on every attempt with the provider still holding every turn and nothing changed. Real CheckpointRollbackService, CheckpointService, GitVcsDriver
// checkpoints on a temp repo, EventSink and ProjectionStore over in-memory SQLite; the provider is a Codex app-server
// stand-in holding native turns, driven by the real resolveCodexRollbackBoundary and revertCodexThreadFrom.
// The skill that maintains this check: .claude/skills/checkpoint-rollback/SKILL.md.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { sequences } from "@caveman-app/model-check";
import {
  CheckpointId,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@caveman-app/protocol";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { revertCodexThreadFrom } from "../provider/CodexThreadRevert.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveCodexRollbackBoundary } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { snapshotTree, trackExecBit } from "../testUtils/fileTree.ts";

/** Where an attempt can fail, in the order execute reaches them (CheckpointRollbackService.ts). */
const FAULTS = [
  // session.rollbackThread reverted the Codex thread; checkpoints.restore then hits a held .git/index.lock.
  "after the provider rollback",
  // checkpoints.restore wrote the files; the step still fails.
  "after the restore",
  // checkpoints.deleteStaleRefs removed the later refs; the step still fails.
  "after deleteStaleRefs",
  // eventSink.write committed; the worker then loses the settlement and requeues (provider-thread.rollback is in
  // REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS).
  "after the event write",
] as const;
type Fault = (typeof FAULTS)[number];

/** EffectWorker's default maxAttempts. */
const MAX_ATTEMPTS = 5;

/**
 * Every fault sequence of up to two failed attempts (each followed by a clean one), then each fault on all 5 attempts,
 * after which the worker gives up. A third to fourth retry of the same fault adds nothing the 5-attempt run lacks.
 */
const SCHEDULES: ReadonlyArray<ReadonlyArray<Fault>> = [
  ...sequences(FAULTS, 2),
  ...FAULTS.map((fault) => Array<Fault>(MAX_ATTEMPTS).fill(fault)),
];

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test" };
const threadId = ThreadId.make("mc-rollback");
const providerThreadId = ProviderThreadId.make("mc-rollback-provider");
const providerSessionId = ProviderSessionId.make("mc-rollback-session");
const scopeId = CheckpointScopeId.make("mc-rollback-root");
const NATIVE_THREAD = "native-thread";
const runId = (ordinal: number) => RunId.make(`mc-rollback-run-${ordinal}`);
const nodeId = (ordinal: number) => NodeId.make(`mc-rollback-node-${ordinal}`);
const attemptId = (ordinal: number) => RunAttemptId.make(`mc-rollback-attempt-${ordinal}`);

/** Native Codex turns per run, oldest first; run 2 is a goal run spanning two native turns. */
const NATIVE_TURNS: Readonly<Record<number, ReadonlyArray<string>>> = {
  1: ["n1"],
  2: ["n2a", "n2b"],
  3: ["n3"],
};
const RUNS = [1, 2, 3] as const;
const nativeTurnsThrough = (ordinal: number) =>
  RUNS.filter((run) => run <= ordinal).flatMap((run) => NATIVE_TURNS[run]!);
const TARGETS = [0, 1, 2] as const;

trackExecBit();

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const isIgnored = (rel: string) => rel.endsWith(".log") || rel.split("/").includes("build");

const CHECKPOINT_REFS = "refs/t3/orchestration-v2/checkpoints/";
interface RepoState {
  readonly cwdTree: Record<string, string>;
  readonly ignored: Record<string, string>;
  readonly outside: Record<string, string>;
  readonly head: string;
  readonly refs: string;
  readonly checkpointRefs: ReadonlyArray<string>;
  readonly indexOutside: string;
}
function repoState(repo: string): RepoState {
  const cwd = path.join(repo, "ws");
  const refs = git(repo, "for-each-ref", "--format=%(refname) %(objectname)").trim().split("\n");
  const symbolicHead = fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8").trim();
  return {
    cwdTree: snapshotTree(cwd, (rel) => !isIgnored(rel)),
    ignored: snapshotTree(cwd, isIgnored),
    outside: snapshotTree(repo, (rel) => !rel.startsWith("ws/")),
    head: `${symbolicHead} ${refs.find((ref) => ref.startsWith(`${symbolicHead.replace("ref: ", "")} `)) ?? "unborn"}`,
    refs: refs.filter((ref) => !ref.startsWith(CHECKPOINT_REFS)).join("\n"),
    checkpointRefs: refs
      .filter((ref) => ref.startsWith(CHECKPOINT_REFS))
      .map((ref) => ref.split(" ")[0]!),
    indexOutside: git(repo, "ls-files", "--stage", "--", ".", ":(exclude)ws"),
  };
}

const layerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "mc-checkpoint-rollback-",
});
const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerConfig),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);
const layerCheckpoints = CheckpointService.layer.pipe(
  Layer.provide(Layer.mergeAll(layerCheckpointStore, IdAllocator.layer, NodeCrypto.layer)),
);

const scopeAt = (cwd: string, createdAt: DateTime.Utc): OrchestrationV2CheckpointScope => ({
  id: scopeId,
  threadId,
  runId: runId(1),
  nodeId: nodeId(1),
  parentScopeId: null,
  providerThreadId,
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd,
  createdAt,
});

interface Template {
  readonly repo: string;
  readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  /** What was under ws/ (ignored files left out) when each checkpoint was captured. */
  readonly trees: ReadonlyArray<Record<string, string>>;
  readonly now: DateTime.Utc;
}

/**
 * A repo whose thread directory is ws/ (files outside it, ignored files, the person's untracked and staged files),
 * three runs that write, rename, delete, flip exec bits and swap files, links and directories, and a checkpoint
 * captured by the real CheckpointService before run 1 and after each run.
 */
const buildTemplate = (root: string) =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const now = yield* DateTime.now;
    const repo = path.join(root, "template");
    const cwd = path.join(repo, "ws");
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text);
    };
    fs.mkdirSync(cwd, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    write(".gitignore", "*.log\nbuild/\n");
    write("outside.txt", "outside\n");
    write("ws/keep.txt", "keep\n");
    write("ws/run.sh", "#!/bin/sh\n");
    write("ws/d", "d\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    write("ws/notes.txt", "the person's own notes\n");
    write("ws/debug.log", "ignored\n");
    write("ws/build/out.bin", "ignored dir\n");

    const scope = scopeAt(cwd, now);
    const captured: Array<OrchestrationV2Checkpoint> = [];
    const trees: Array<Record<string, string>> = [];
    const capture = (ordinal: number) =>
      checkpoints
        .capture({
          scope,
          runId: ordinal === 0 ? null : runId(ordinal),
          nodeId: nodeId(Math.max(1, ordinal)),
          ordinalWithinScope: ordinal,
          appRunOrdinal: ordinal === 0 ? null : ordinal,
          capturedAt: now,
        })
        .pipe(
          Effect.tap((checkpoint) =>
            Effect.sync(() => {
              captured.push(checkpoint);
              trees.push(snapshotTree(cwd, (rel) => !isIgnored(rel)));
            }),
          ),
        );

    yield* capture(0);
    write("ws/keep.txt", "keep v1\n");
    write("ws/a.txt", "alpha\n");
    fs.chmodSync(path.join(cwd, "run.sh"), 0o755);
    yield* capture(1);
    fs.renameSync(path.join(cwd, "a.txt"), path.join(cwd, "b.txt"));
    fs.rmSync(path.join(cwd, "keep.txt"));
    fs.symlinkSync("b.txt", path.join(cwd, "link"));
    fs.rmSync(path.join(cwd, "d"));
    write("ws/d/x.txt", "x\n");
    git(repo, "add", "ws/notes.txt");
    yield* capture(2);
    write("ws/b.txt", "beta\n");
    fs.rmSync(path.join(cwd, "link"));
    write("ws/link", "a file now\n");
    fs.rmSync(path.join(cwd, "d"), { recursive: true });
    write("ws/d", "d again\n");
    fs.chmodSync(path.join(cwd, "run.sh"), 0o644);
    yield* capture(3);
    // The person, after the last run: edits rollback must discard, and things it must never touch.
    write("ws/b.txt", "the person's later edit\n");
    write("ws/later.log", "ignored, written after the last run\n");
    write("outside.txt", "outside, edited after the last run\n");
    write("staged-outside.txt", "staged outside ws\n");
    git(repo, "add", "staged-outside.txt");
    for (const [index, checkpoint] of captured.entries()) {
      expect(checkpoint.status, `checkpoint ${index} captured`).toBe("ready");
    }
    return { repo, checkpoints: captured, trees, now } satisfies Template;
  });

/** The projection a thread has after three completed Codex runs, each with its checkpoint. */
function seedEvents(template: Template, cwd: string): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { now } = template;
  const events: Array<Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "occurredAt">> = [];
  const push = (event: unknown) => events.push(event as never);
  push({
    type: "thread.created",
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("mc-rollback-project"),
      title: "Rollback model check",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  push({
    type: "provider-thread.updated",
    payload: {
      id: providerThreadId,
      driver,
      providerInstanceId: instanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: NATIVE_THREAD, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 3,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  push({ type: "checkpoint-scope.created", payload: scopeAt(cwd, now) });
  let turnOrdinal = 0;
  for (const ordinal of RUNS) {
    push({
      type: "run.created",
      payload: {
        id: runId(ordinal),
        threadId,
        ordinal,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`mc-rollback-message-${ordinal}`),
        rootNodeId: nodeId(ordinal),
        activeAttemptId: attemptId(ordinal),
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: template.checkpoints[ordinal]!.id,
        contextHandoffId: null,
      },
    });
    push({
      type: "node.updated",
      payload: {
        id: nodeId(ordinal),
        threadId,
        runId: runId(ordinal),
        parentNodeId: null,
        rootNodeId: nodeId(ordinal),
        kind: "root_turn",
        status: "completed",
        countsForRun: true,
        providerThreadId,
        providerTurnId: ProviderTurnId.make(NATIVE_TURNS[ordinal]![0]!),
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: scopeId,
        startedAt: now,
        completedAt: now,
      },
    });
    push({
      type: "run-attempt.created",
      runId: runId(ordinal),
      payload: {
        id: attemptId(ordinal),
        runId: runId(ordinal),
        attemptOrdinal: 1,
        rootNodeId: nodeId(ordinal),
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: ProviderTurnId.make(NATIVE_TURNS[ordinal]![0]!),
        reason: "initial",
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
    for (const native of NATIVE_TURNS[ordinal]!) {
      push({
        type: "provider-turn.updated",
        payload: {
          id: ProviderTurnId.make(native),
          providerThreadId,
          nodeId: nodeId(ordinal),
          runAttemptId: attemptId(ordinal),
          nativeTurnRef: { driver, nativeId: native, strength: "strong" },
          ordinal: ++turnOrdinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
    }
  }
  for (const checkpoint of template.checkpoints)
    push({ type: "checkpoint.captured", payload: checkpoint });
  return events.map(
    (event, index) =>
      ({
        ...event,
        id: EventId.make(`mc-rollback-seed-${index}`),
        threadId,
        occurredAt: now,
      }) as OrchestrationV2DomainEvent,
  );
}

/** Codex app-server's thread history, as thread/turns/list, thread/revert and thread/read see it. */
function makeCodexAppServer(turns: ReadonlyArray<string>) {
  const state = { turns: [...turns] };
  const request = (method: string, params: Record<string, unknown>) =>
    Effect.sync(() => {
      switch (method) {
        case "thread/turns/list": {
          const newestFirst = [...state.turns].reverse();
          const start = params.cursor === null ? 0 : Number(params.cursor);
          const end = start + Number(params.limit);
          return {
            data: newestFirst.slice(start, end).map((id) => ({ id })),
            nextCursor: end < newestFirst.length ? String(end) : null,
          };
        }
        case "thread/revert": {
          const at = state.turns.indexOf(String(params.beforeTurnId));
          if (at >= 0) state.turns = state.turns.slice(0, at);
          return { thread: { id: params.threadId } };
        }
        case "thread/read":
          return { thread: { id: params.threadId } };
        default:
          throw new Error(`unexpected Codex request ${method}`);
      }
    });
  return { state, client: { request } as never };
}

/** The client message of a restore that refuses because the person's ignored files are in its way. */
const REFUSAL =
  /^Restoring would delete ignored files this checkpoint never saved: d\/mine\.log\. /;

interface Outcome {
  readonly target: number;
  readonly schedule: ReadonlyArray<Fault>;
  /** Before the rollback the person made ws/d, a file in checkpoints 0 and 1, a folder holding their ignored file. */
  readonly inTheWay: boolean;
  /**
   * Each attempt: the fault it hit ("clean" when none was scheduled or its point was not reached; "refused" when the
   * restore refused, naming the ignored file in its way), how it ended.
   */
  readonly attempts: ReadonlyArray<{
    readonly fault: Fault | "clean" | "refused";
    readonly error?: string;
  }>;
  readonly gaveUp: boolean;
  readonly nativeAfterEachAttempt: ReadonlyArray<ReadonlyArray<string>>;
  readonly before: RepoState;
  readonly after: RepoState;
  readonly rolledBackMarks: Readonly<Record<string, number>>;
  readonly runStatuses: Readonly<Record<string, string>>;
}

const runSchedule = (
  template: Template,
  root: string,
  target: number,
  schedule: ReadonlyArray<Fault>,
  index: number,
  inTheWay: boolean,
) =>
  Effect.gen(function* () {
    const repo = path.join(root, inTheWay ? `t${target}-in-the-way` : `t${target}-s${index}`);
    fs.cpSync(template.repo, repo, { recursive: true, verbatimSymlinks: true });
    const cwd = path.join(repo, "ws");
    if (inTheWay) {
      fs.rmSync(path.join(cwd, "d"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "d"));
      fs.writeFileSync(path.join(cwd, "d", "mine.log"), "the person's ignored file\n");
    }
    const codex = makeCodexAppServer(nativeTurnsThrough(3));
    let armed: Fault | "clean" = "clean";
    let fired = false;
    const fault = (at: Fault) =>
      Effect.suspend(() => {
        if (armed !== at) return Effect.void;
        fired = true;
        armed = "clean";
        return Effect.fail(new Error(`injected fault ${at}`));
      });

    const layerDatabase = SqlitePersistence.layerMemory;
    const layerStores = Layer.merge(EventStore.layer, ProjectionStoreWithV1.layer).pipe(
      Layer.provide(layerDatabase),
    );
    const layerEventSink = Layer.effect(
      EventSink.EventSinkV2,
      Effect.gen(function* () {
        const real = yield* EventSink.EventSinkV2;
        return EventSink.EventSinkV2.of({
          ...real,
          write: (input) =>
            real.write(input).pipe(
              Effect.tap(() =>
                fault("after the event write").pipe(
                  Effect.mapError(
                    (cause) =>
                      new EventSink.EventSinkWriteError({
                        eventCount: input.events.length,
                        cause,
                      }),
                  ),
                ),
              ),
            ),
        });
      }),
    ).pipe(
      Layer.provide(
        EventSink.layer.pipe(Layer.provide(Layer.mergeAll(layerStores, layerDatabase))),
      ),
    );
    const real = yield* CheckpointService.CheckpointServiceV2;
    const layerFaultyCheckpoints = Layer.succeed(
      CheckpointService.CheckpointServiceV2,
      CheckpointService.CheckpointServiceV2.of({
        ...real,
        restore: (input) =>
          real.restore(input).pipe(
            Effect.tap(() =>
              fault("after the restore").pipe(
                Effect.mapError(
                  (cause) =>
                    new CheckpointService.CheckpointRestoreError({
                      scopeId: input.scope.id,
                      checkpointId: input.checkpoint.id,
                      cause,
                    }),
                ),
              ),
            ),
          ),
        deleteStaleRefs: (input) =>
          real.deleteStaleRefs(input).pipe(
            Effect.tap(() =>
              fault("after deleteStaleRefs").pipe(
                Effect.mapError(
                  (cause) =>
                    new CheckpointService.CheckpointDeleteStaleRefsError({
                      scopeId: input.scope.id,
                      checkpointIds: input.checkpoints.map((checkpoint) => checkpoint.id),
                      cause,
                    }),
                ),
              ),
            ),
          ),
      }),
    );
    // As CodexAdapterV2's rollbackThread: find the oldest native turn after the target, revert from it.
    const rollbackThread = (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
      Effect.gen(function* () {
        const boundary = yield* resolveCodexRollbackBoundary(input);
        if (boundary !== null) yield* revertCodexThreadFrom(codex.client, NATIVE_THREAD, boundary);
        return {
          providerThread: {
            ...input.providerThread,
            nativeConversationHeadRef:
              input.target.type === "provider_turn"
                ? input.target.providerTurn.nativeTurnRef
                : null,
            status: "idle" as const,
          },
          providerTurns: [],
          messages: [],
          runtimeRequests: [],
        };
      });
    const layerTest = CheckpointRollbackService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          layerStores,
          layerEventSink,
          layerFaultyCheckpoints,
          ThreadCommandExecutor.layer,
          IdAllocator.layer,
          NodeServices.layer,
          layerConfig,
          ServerSettings.layerTest(),
          Layer.mock(GitWorkflow.GitWorkflowService)({}),
          // A root that does not exist never overlaps, so the thread's own scopes decide isolation.
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () =>
              Effect.succeed(
                Option.some({
                  workspaceRoot: "/nonexistent/mc-rollback-project",
                } as never),
              ),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: () => Effect.succeed({ rollbackThread } as never),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: () => Effect.succeed({} as never),
          }),
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      for (const event of seedEvents(template, cwd)) yield* store.apply(event);
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const before = repoState(repo);
      const attempts: Array<Outcome["attempts"][number]> = [];
      const nativeAfterEachAttempt: Array<ReadonlyArray<string>> = [];
      const indexLock = path.join(repo, ".git", "index.lock");
      let succeeded = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !succeeded; attempt++) {
        armed = schedule[attempt - 1] ?? "clean";
        fired = false;
        const lockHeld = armed === "after the provider rollback";
        if (lockHeld) fs.writeFileSync(indexLock, "");
        const exit = yield* Effect.exit(
          service.execute({
            threadId,
            providerThreadId,
            checkpointId: template.checkpoints[target]!.id,
            scopeId,
            restoreFiles: true,
          }),
        );
        fs.rmSync(indexLock, { force: true });
        succeeded = Exit.isSuccess(exit);
        const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
        const refused =
          Option.isSome(error) &&
          REFUSAL.test(CheckpointRollbackService.rollbackFailureClientMessage(error.value));
        attempts.push({
          fault: refused
            ? "refused"
            : (lockHeld && !succeeded) || fired
              ? schedule[attempt - 1]!
              : "clean",
          ...(Exit.isFailure(exit) ? { error: Cause.pretty(exit.cause) } : {}),
        });
        nativeAfterEachAttempt.push([...codex.state.turns]);
      }
      const events = yield* Stream.runCollect(
        (yield* EventStore.EventStoreV2).read({
          threadId,
          eventType: "run.updated",
        }),
      );
      const rolledBackMarks: Record<string, number> = {};
      for (const { event } of events) {
        if (event.type === "run.updated" && event.payload.status === "rolled_back")
          rolledBackMarks[event.payload.id] = (rolledBackMarks[event.payload.id] ?? 0) + 1;
      }
      const records = yield* store.getThreadRecords(threadId, ["runs"]);
      return {
        target,
        schedule,
        inTheWay,
        attempts,
        gaveUp: !succeeded,
        nativeAfterEachAttempt,
        before,
        after: repoState(repo),
        rolledBackMarks,
        runStatuses: Object.fromEntries(records.runs.map((run) => [run.id, run.status])),
      } satisfies Outcome;
    }).pipe(Effect.provide(layerTest));
  });

const describeOutcome = (outcome: Outcome) =>
  [
    `rollback to checkpoint ${outcome.target} (${outcome.target === 0 ? "thread_start" : `provider_turn of run ${outcome.target}`})${outcome.inTheWay ? ", the person's ignored ws/d/mine.log where it holds the file d" : ""};`,
    `Codex held [${nativeTurnsThrough(3).join(", ")}]:`,
    ...outcome.attempts.map(
      ({ fault }, index) =>
        `  attempt ${index + 1}: ${fault === "clean" ? "runs clean" : fault === "refused" ? "the restore refuses" : `fails ${fault}`}; Codex then holds [${outcome.nativeAfterEachAttempt[index]!.join(", ")}]`,
    ),
    outcome.gaveUp ? "  the worker gives up after 5 attempts" : "  the rollback succeeds",
  ].join("\n");

let root: string;
let template: Template;
let outcomes: Array<Outcome> = [];
let seconds = 0;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-checkpoint-rollback-"));
  const started = Date.now();
  outcomes = await Effect.runPromise(
    Effect.gen(function* () {
      template = yield* buildTemplate(root);
      const runs = [
        ...TARGETS.flatMap((target) =>
          SCHEDULES.map((schedule, index) => ({ target, schedule, index, inTheWay: false })),
        ),
        ...TARGETS.map((target) => ({ target, schedule: [], index: -1, inTheWay: true })),
      ];
      // In sequence: node spawns git on its main thread, so running schedules side by side is slower.
      return yield* Effect.forEach(runs, ({ target, schedule, index, inTheWay }) =>
        runSchedule(template, root, target, schedule, index, inTheWay),
      );
    }).pipe(Effect.provide(Layer.mergeAll(layerCheckpoints, NodeServices.layer))),
  );
  seconds = (Date.now() - started) / 1000;
  const attempts = outcomes.reduce((sum, outcome) => sum + outcome.attempts.length, 0);
  process.stdout.write(
    `checkpoint-rollback model check: ${TARGETS.length} targets x (${SCHEDULES.length} fault schedules + an ignored file in the way) = ${outcomes.length} schedules, ${attempts} attempts (transitions), exhaustive within the bound, ${seconds.toFixed(1)} s\n`,
  );
  // A heavily loaded machine has taken over 300 s here.
}, 600_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The first outcome, in schedule order (shortest first), that breaks `holds`. */
const firstBreak = (holds: (outcome: Outcome) => string | null) => {
  for (const outcome of outcomes) {
    const why = holds(outcome);
    if (why !== null) return `${why}\n${describeOutcome(outcome)}`;
  }
  return null;
};

describe("checkpoint rollback under faults and retries", () => {
  it("explores every schedule, and an attempt fails only where a fault was injected", () => {
    expect(outcomes.length).toBe(TARGETS.length * (SCHEDULES.length + 1));
    expect(
      firstBreak((outcome) => {
        const broken = outcome.attempts.findIndex(
          (a) => a.fault === "clean" && a.error !== undefined,
        );
        return broken < 0
          ? null
          : `attempt ${broken + 1} failed with no fault injected:\n${outcome.attempts[broken]!.error}`;
      }),
      "a modelling error: the harness, not the rollback",
    ).toBeNull();
  });

  it("the provider never holds fewer turns than the target, and holds exactly them once the rollback lands", () => {
    expect(
      firstBreak((outcome) => {
        const expected = nativeTurnsThrough(outcome.target);
        for (const [index, native] of outcome.nativeAfterEachAttempt.entries()) {
          if (native.length < expected.length)
            return `after attempt ${index + 1} Codex holds [${native.join(", ")}], fewer than the target's [${expected.join(", ")}]`;
        }
        const last = outcome.nativeAfterEachAttempt.at(-1)!;
        return !outcome.gaveUp && last.join() !== expected.join()
          ? `the rollback landed with Codex holding [${last.join(", ")}], not [${expected.join(", ")}]`
          : null;
      }),
    ).toBeNull();
  });

  it("a restore that would delete an ignored file refuses on every attempt, before the provider loses a turn, and nothing changes", () => {
    expect(
      firstBreak((outcome) => {
        // Checkpoints 0 and 1 hold d as a file: git restore would delete the folder there, the ignored file with it.
        const refuses = outcome.inTheWay && "d" in template.trees[outcome.target]!;
        const all = nativeTurnsThrough(3);
        for (const [index, { fault, error }] of outcome.attempts.entries()) {
          if ((fault === "refused") !== refuses)
            return refuses
              ? `attempt ${index + 1} did not refuse: ${error ?? "the rollback landed"}`
              : `attempt ${index + 1} refused where nothing ignored is in the way`;
          if (refuses && outcome.nativeAfterEachAttempt[index]!.join() !== all.join())
            return `after refused attempt ${index + 1} Codex holds [${outcome.nativeAfterEachAttempt[index]!.join(", ")}], not every turn [${all.join(", ")}]`;
        }
        if (!refuses) return null;
        if (!outcome.gaveUp) return "the rollback landed";
        if (JSON.stringify(outcome.after.cwdTree) !== JSON.stringify(outcome.before.cwdTree))
          return `ws/ changed: ${JSON.stringify(outcome.after.cwdTree)}`;
        if (outcome.after.checkpointRefs.join() !== outcome.before.checkpointRefs.join())
          return `checkpoint refs changed: ${outcome.after.checkpointRefs.join(", ")}`;
        return Object.keys(outcome.rolledBackMarks).length === 0
          ? null
          : `runs marked rolled_back: ${Object.keys(outcome.rolledBackMarks).join(", ")}`;
      }),
    ).toBeNull();
  });

  it("a rollback that lands leaves the files under the thread's directory byte-identical to the target checkpoint", () => {
    expect(
      firstBreak((outcome) => {
        if (outcome.gaveUp) return null;
        const expected = JSON.stringify(template.trees[outcome.target]);
        const actual = JSON.stringify(outcome.after.cwdTree);
        return expected === actual
          ? null
          : `ws/ is ${actual}\nbut checkpoint ${outcome.target} holds ${expected}`;
      }),
    ).toBeNull();
  });

  it("ignored files, files and staged changes outside the thread's directory, HEAD and other refs are never touched", () => {
    expect(
      firstBreak((outcome) => {
        const { before, after } = outcome;
        if (JSON.stringify(before.ignored) !== JSON.stringify(after.ignored))
          return `ignored files changed: ${JSON.stringify(after.ignored)}`;
        if (JSON.stringify(before.outside) !== JSON.stringify(after.outside))
          return `files outside ws/ changed: ${JSON.stringify(after.outside)}`;
        if (before.indexOutside !== after.indexOutside)
          return `the index outside ws/ changed:\n${after.indexOutside}`;
        if (before.head !== after.head) return `HEAD moved from ${before.head} to ${after.head}`;
        if (before.refs !== after.refs) return `refs changed:\n${after.refs}`;
        return null;
      }),
    ).toBeNull();
  });

  it("a rollback that lands deletes exactly the later checkpoints' refs", () => {
    expect(
      firstBreak((outcome) => {
        if (outcome.gaveUp) return null;
        const kept = template.checkpoints
          .filter((_, ordinal) => ordinal <= outcome.target)
          .map((checkpoint) => checkpoint.ref as string);
        return JSON.stringify(outcome.after.checkpointRefs.toSorted()) ===
          JSON.stringify(kept.toSorted())
          ? null
          : `checkpoint refs left: ${outcome.after.checkpointRefs.join(", ")}; expected ${kept.join(", ")}`;
      }),
    ).toBeNull();
  });

  it("each run after the target is marked rolled_back exactly once, and no other run is", () => {
    expect(
      firstBreak((outcome) => {
        if (outcome.gaveUp) return null;
        for (const ordinal of RUNS) {
          const marks = outcome.rolledBackMarks[runId(ordinal)] ?? 0;
          const expected = ordinal > outcome.target ? 1 : 0;
          if (marks !== expected)
            return `run ${ordinal} was marked rolled_back ${marks} times, expected ${expected}`;
          const status = outcome.runStatuses[runId(ordinal)];
          if ((status === "rolled_back") !== ordinal > outcome.target)
            return `run ${ordinal} ends ${status}`;
        }
        return null;
      }),
    ).toBeNull();
  });
});
