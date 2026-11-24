// Schedule-exhaustive check of delegate_task's Settings > Agents limits on the real OrchestratorMcpService: k calls
// from one tree run at once, and every order in which their limit reads (delegationTree's read of the root's
// subagents) and dispatches can interleave is explored by parking each at a gate and releasing one at a time. Some
// calls are thread_send to a finished delegated agent, which sets it working again as a new task. However they
// interleave, no more agents start than maxConcurrent leaves room for, and a caller nested maxDepth deep starts none.
// ThreadManagementService is an in-memory store; everything between the gates is the real service.
// Skill: .claude/skills/mcp-and-rpc-authorization/SKILL.md
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@caveman-app/protocol";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const ROOT = ThreadId.make("thread:lead");
const codex = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:delegation");
const runId = RunId.make("run:caller");
const rootNodeId = NodeId.make("node:caller-root");

/** Which of the concurrent calls is running, so the store knows whose read or dispatch it is parking. */
const CallIndex = Context.Reference<number>("modelcheck/delegation/CallIndex", {
  defaultValue: () => -1,
});

type GateOp = "limits read" | "dispatch";
interface Gate {
  readonly call: number;
  readonly op: GateOp;
  readonly open: Deferred.Deferred<void>;
}

interface Scenario {
  readonly maxConcurrent: number;
  readonly maxDepth: number;
  /** Delegated agents already working beside the caller when the calls arrive, besides the caller's own ancestors. */
  readonly working: number;
  /** How deep the caller is: 0 is the lead, n is n delegations below it. */
  readonly callerDepth: number;
  readonly calls: number;
  /** How many of the calls are thread_send to one of the caller's finished delegated agents, each its own. */
  readonly followups: number;
}

const ancestor = (level: number) =>
  level === 0 ? ROOT : ThreadId.make(`thread:delegate-${level}`);
const callerOf = (scenario: Scenario) => ancestor(scenario.callerDepth);
const lineageOf = (level: number) =>
  level === 0
    ? { rootThreadId: ROOT, parentThreadId: null, relationshipToParent: null }
    : {
        rootThreadId: ROOT,
        parentThreadId: ancestor(level - 1),
        relationshipToParent: "subagent" as const,
      };

const workingTask = (parent: ThreadId, child: ThreadId) => ({
  id: NodeId.make(`node:${child}`),
  threadId: parent,
  origin: "app_owned",
  childThreadId: child,
  status: "running",
});

/** The task each dispatch reports: finished, so only the store's working entry counts toward the limit. */
const reportedTask = (parent: ThreadId, n: number) => ({
  id: NodeId.make(`node:started-${n}`),
  threadId: parent,
  runId,
  parentNodeId: rootNodeId,
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: codex,
  providerThreadId: null,
  childThreadId: ThreadId.make(`thread:started-${n}`),
  nativeTaskRef: null,
  prompt: "Find where retries happen.",
  title: null,
  model: "gpt-5.4",
  status: "completed",
  result: "done",
  startedAt: null,
  completedAt: null,
});

const levelOf = (threadId: ThreadId) =>
  threadId === ROOT ? 0 : Number(String(threadId).replace("thread:delegate-", ""));

/** A delegated agent of the lead that finished its task; a message sets it working again. */
const finished = (n: number) => ThreadId.make(`thread:finished-${n}`);
const isFinished = (threadId: ThreadId) => String(threadId).startsWith("thread:finished-");
const finishedLineage = {
  rootThreadId: ROOT,
  parentThreadId: ROOT,
  relationshipToParent: "subagent" as const,
};
const finishedTask = (child: ThreadId) => ({
  ...workingTask(ROOT, child),
  id: NodeId.make(`node:${child}:done`),
  status: "completed",
  result: "done",
});

const threadProjection = (threadId: ThreadId, subagents: ReadonlyArray<unknown>) =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: "delegating agent",
      createdBy: "user",
      creationSource: "web",
      modelSelection: { instanceId: codex, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: null,
      archivedAt: null,
      deletedAt: null,
      // A delegated agent's own children sit one level below the deepest ancestor.
      lineage: isFinished(threadId)
        ? finishedLineage
        : lineageOf(Number.isNaN(levelOf(threadId)) ? 9 : levelOf(threadId)),
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        status: "running",
        rootNodeId,
        providerInstanceId: codex,
        modelSelection: { instanceId: codex, model: "gpt-5.4" },
      },
    ],
    contextTransfers: [],
    messages: [],
    subagents,
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    turnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const provider: ServerProvider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

/** The outcome of one schedule: what each call answered, and how many delegations the store holds at the end. */
interface Run {
  readonly outcomes: ReadonlyArray<string>;
  readonly started: number;
  readonly schedule: ReadonlyArray<string>;
  /** How many gates were open to choose from at each decision, for enumerating the siblings of this schedule. */
  readonly choices: ReadonlyArray<number>;
}

/**
 * Runs the calls of `scenario` on a fresh service, releasing at decision i the gate `prefix[i]` (0 past the prefix)
 * among those parked, ordered by call. A step is "settled" once nothing has changed for a while: every call is parked,
 * finished, or waiting on something only a parked call can release.
 */
const runSchedule = (scenario: Scenario, prefix: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const caller = callerOf(scenario);
    // Each ancestor below the lead is itself a working delegated agent, the child of the one above it.
    const subagents = new Map<string, Array<unknown>>(
      Array.from({ length: scenario.callerDepth }, (_, level) => [
        ancestor(level),
        [workingTask(ancestor(level), ancestor(level + 1))],
      ]),
    );
    subagents.set(caller, [
      ...Array.from({ length: scenario.working }, (_, n) =>
        workingTask(caller, ThreadId.make(`thread:working-${n}`)),
      ),
      ...Array.from({ length: scenario.followups }, (_, n) => finishedTask(finished(n))),
    ]);
    let started = 0;
    let progress = 0;
    const parked: Array<Gate> = [];
    const park = (op: GateOp) =>
      Effect.gen(function* () {
        const open = yield* Deferred.make<void>();
        parked.push({ call: yield* CallIndex, op, open });
        progress++;
        yield* Deferred.await(open);
      });
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      hasReceipt: () => Effect.succeed(false),
      assertProviderInstanceEnabled: () => Effect.void,
      getThreadEventSequence: () => Effect.succeed(0 as never),
      getThreadShell: (threadId) =>
        Effect.succeed(
          (isFinished(threadId)
            ? { id: threadId, projectId, deletedAt: null, lineage: finishedLineage }
            : { id: threadId, lineage: lineageOf(levelOf(threadId)) }) as never,
        ),
      getProjectThreadRecords: ({ threadId }) =>
        Effect.sync(() => {
          progress++;
          return { ...threadProjection(threadId, []), runs: [] } as never;
        }),
      getThreadRecords: (threadId, fields) =>
        Effect.gen(function* () {
          progress++;
          // delegationTree reads only subagents and providerTurns; the caller's own load reads its runs too, and a
          // follow-up's look at whether its agent is already at work reads subagents alone.
          const read = (fields ?? []) as ReadonlyArray<string>;
          const limitsRead = read.includes("providerTurns") && !read.includes("runs");
          if (limitsRead && threadId === ROOT) yield* park("limits read");
          return threadProjection(threadId, subagents.get(threadId) ?? []) as never;
        }),
      dispatch: (command) =>
        Effect.gen(function* () {
          progress++;
          // Only the request starts an agent; a follow-up such as its wake policy changes no count.
          if (command.type !== "delegated_task.request")
            return { sequence: 0, storedEvents: [] } as never;
          yield* park("dispatch");
          const n = started++;
          subagents.set(caller, [
            ...(subagents.get(caller) ?? []),
            reportedTask(caller, n),
            workingTask(caller, ThreadId.make(`thread:started-working-${n}`)),
          ]);
          return {
            sequence: n + 1,
            storedEvents: [
              {
                sequence: n + 1,
                commandId: null,
                event: { type: "subagent.updated", payload: reportedTask(caller, n) },
              },
            ],
          } as never;
        }),
      // The orchestrator records a message that sets a finished delegated agent working as a new task (recordSubagentFollowup).
      sendToThread: (input) =>
        Effect.gen(function* () {
          progress++;
          yield* park("dispatch");
          started++;
          subagents.set(ROOT, [
            ...(subagents.get(ROOT) ?? []),
            {
              ...workingTask(ROOT, input.threadId),
              id: NodeId.make(`node:${input.threadId}:followup`),
            },
          ]);
          return {
            run: { id: RunId.make(`run:${input.threadId}:followup`), status: "running" },
            delivery: "started",
          } as never;
        }),
    });
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      threads,
      ServerSettings.layerTest({
        subagents: {
          maxConcurrent: scenario.maxConcurrent,
          maxDepth: scenario.maxDepth,
          treeTokenCeiling: 0,
          defaultModel: "inherit",
        },
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        refreshInstance: () => Effect.succeed([provider]),
      }),
      Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed([codex]),
          get: (instanceId) =>
            Effect.succeed({
              instanceId,
            } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
        }),
      ),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    const service = OrchestratorMcpService.layer.pipe(
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(dependencies),
    );
    return yield* Effect.gen(function* () {
      const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:delegation"),
        requestNamespace: "provider-session:delegation",
        thread: {
          threadId: callerOf(scenario),
          providerSessionId: "provider-session:delegation",
          providerInstanceId: codex,
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const outcomes: Array<string | undefined> = Array.from(
        { length: scenario.calls },
        () => undefined,
      );
      const delegations = scenario.calls - scenario.followups;
      const fibers = yield* Effect.forEach(
        Array.from({ length: scenario.calls }, (_, call) => call),
        (call) => {
          const attempt: Effect.Effect<unknown, OrchestratorMcpFailure> =
            call < delegations
              ? orchestrator.delegateTask(scope, {
                  task: "Find where retries happen.",
                  mode: "async",
                  clientRequestId: `delegation-${call}`,
                })
              : orchestrator.sendToThread(scope, {
                  threadId: finished(call - delegations),
                  message: "Keep going.",
                  clientRequestId: `followup-${call}`,
                });
          return attempt.pipe(
            Effect.match({ onFailure: (error) => error.code, onSuccess: () => "started" }),
            Effect.tap((outcome) => Effect.sync(() => (outcomes[call] = outcome))),
            Effect.provideService(CallIndex, call),
            Effect.forkChild,
          );
        },
      );
      const settle = Effect.gen(function* () {
        let quiet = 0;
        let seen = -1;
        while (quiet < 40) {
          yield* Effect.yieldNow;
          const now = progress + outcomes.filter((outcome) => outcome !== undefined).length;
          quiet = now === seen ? quiet + 1 : 0;
          seen = now;
        }
      });
      const schedule: Array<string> = [];
      const choices: Array<number> = [];
      for (;;) {
        yield* settle;
        if (parked.length === 0) break;
        parked.sort((a, b) => a.call - b.call || a.op.localeCompare(b.op));
        const pick = prefix[choices.length] ?? 0;
        choices.push(parked.length);
        const [gate] = parked.splice(pick, 1);
        schedule.push(`call ${gate!.call}: ${gate!.op}`);
        yield* Deferred.succeed(gate!.open, undefined);
      }
      yield* Effect.forEach(fibers, Fiber.join);
      return {
        outcomes: outcomes.map((outcome) => outcome ?? "never answered"),
        started,
        schedule,
        choices,
      } satisfies Run;
    }).pipe(Effect.provide(service));
  });

/** Every schedule of `scenario`, by depth-first enumeration of the gate choices. */
const everySchedule = (scenario: Scenario) =>
  Effect.gen(function* () {
    const runs: Array<Run> = [];
    let prefix: Array<number> = [];
    for (;;) {
      const run = yield* runSchedule(scenario, prefix);
      runs.push(run);
      // The next schedule: bump the deepest choice that has an untried sibling, and drop what follows it.
      let at = run.choices.length - 1;
      while (at >= 0 && (prefix[at] ?? 0) + 1 >= run.choices[at]!) at--;
      if (at < 0) return runs;
      prefix = [
        ...run.choices.slice(0, at).map((_, index) => prefix[index] ?? 0),
        (prefix[at] ?? 0) + 1,
      ];
    }
  });

const scenarios = (): ReadonlyArray<Scenario> => {
  const all: Array<Scenario> = [];
  for (const calls of [2, 3, 4])
    for (const maxConcurrent of [1, 2, 3])
      for (const working of [maxConcurrent - 1, maxConcurrent])
        all.push({ maxConcurrent, maxDepth: 2, working, callerDepth: 0, calls, followups: 0 });
  for (const maxDepth of [1, 2, 3])
    for (const callerDepth of [0, 1, 2, 3])
      all.push({ maxConcurrent: 4, maxDepth, working: 0, callerDepth, calls: 2, followups: 0 });
  // Follow-ups to finished delegated agents, alone and beside delegations.
  for (const calls of [2, 3])
    for (const followups of Array.from({ length: calls }, (_, n) => n + 1))
      for (const maxConcurrent of [1, 2])
        for (const working of [maxConcurrent - 1, maxConcurrent])
          all.push({ maxConcurrent, maxDepth: 2, working, callerDepth: 0, calls, followups });
  return all;
};

it.live(
  "delegate_task and follow-up messages never start more than maxConcurrent leaves room for, nor nest past maxDepth, in any order of concurrent calls",
  () =>
    Effect.gen(function* () {
      const violations: Array<string> = [];
      let schedules = 0;
      const all = scenarios();
      for (const scenario of all) {
        // The caller's delegated ancestors work too, so they count toward maxConcurrent.
        const room =
          scenario.callerDepth + 1 > scenario.maxDepth
            ? 0
            : Math.max(0, scenario.maxConcurrent - scenario.working - scenario.callerDepth);
        const allowed = Math.min(scenario.calls, room);
        for (const run of yield* everySchedule(scenario)) {
          schedules++;
          const ok =
            run.started === allowed &&
            run.outcomes.filter((outcome) => outcome === "started").length === allowed;
          const refusedRightly = run.outcomes.every(
            (outcome) => outcome === "started" || outcome === "limit_reached",
          );
          if (!ok || !refusedRightly) {
            violations.push(
              `${JSON.stringify(scenario)}: ${run.started} started where ${allowed} may; answers ${JSON.stringify(run.outcomes)}; schedule ${run.schedule.join(" -> ")}`,
            );
          }
        }
      }
      console.log(
        `delegate_task and follow-up limits: ${all.length} scenarios, ${schedules} schedules explored, exhaustive over gate orders`,
      );
      const shortest = violations.toSorted((a, b) => a.length - b.length).slice(0, 5);
      expect(shortest, shortest.join("\n")).toEqual([]);
    }),
  { timeout: 120_000 },
);
