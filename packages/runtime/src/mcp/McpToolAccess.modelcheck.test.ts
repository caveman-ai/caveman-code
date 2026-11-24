// Exhaustive check of every McpToolAccess declaration against a reference decision table, over the whole finite
// domain of callers (thread or outside client, client access, runtime and interaction modes, liveness, lineage,
// automation root, orchestration capability), write, fork and message targets (their modes, and where they sit from
// the caller's step or tree root: delegates, provider subagents, forks and what hangs under them) and requested start
// modes. The handlers run through the real `McpToolAccess.toLayer` and the real mode resolution in
// OrchestratorMcpService; only ThreadManagementService's `getThreadShell` is a stub, answering from a world of threads
// built per case. Skill: .claude/skills/mcp-and-rpc-authorization/SKILL.md
import {
  AuthMcpClientAccess,
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type ProviderInteractionMode,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@caveman-app/protocol";
import { canonicalKey } from "@caveman-app/model-check";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

type Access = typeof AuthMcpClientAccess.Type;
type Life =
  | "running"
  | "background"
  | "background-elsewhere"
  | "ended"
  | "archived"
  | "other-instance"
  | "missing"
  | "deleted";
type Lineage = "root" | "subagent" | "fork";
type Automation = "none" | "self" | "root";

type CallerCase =
  | { readonly kind: "client"; readonly access: Access; readonly orchestration: boolean }
  | {
      readonly kind: "thread";
      readonly runtime: RuntimeMode;
      readonly interaction: ProviderInteractionMode;
      readonly life: Life;
      readonly lineage: Lineage;
      readonly automation: Automation;
      readonly orchestration: boolean;
    };

/**
 * Where a target sits from the caller's home (its automation step, else the root of its tree): the home itself, an
 * agent delegate_task started under it or under such an agent, a provider's own subagent of it, a fork of it or of a
 * delegate, a delegate under a fork, a delegate of another automation step, or a tree of its own.
 */
type Position =
  | "home"
  | "delegate"
  | "nested-delegate"
  | "native-subagent"
  | "fork"
  | "fork-of-delegate"
  | "delegate-of-fork"
  | "other-step-delegate"
  | "elsewhere";

type TargetCase =
  | { readonly kind: "omitted" }
  | { readonly kind: "own" }
  | { readonly kind: "missing" }
  | { readonly kind: "deleted" }
  | {
      readonly kind: "other";
      readonly runtime: RuntimeMode;
      readonly interaction: ProviderInteractionMode;
      readonly position: Position;
    };

/** `startsThreads` takes a concrete mode or none; tools turn their own "inherit" into none before declaring. */
type RequestedRuntime = RuntimeMode | undefined;
type RequestedInteraction = "inherit" | ProviderInteractionMode | undefined;

const RUNTIME_MODES = RuntimeMode.literals;
const INTERACTION_MODES: ReadonlyArray<ProviderInteractionMode> = ["default", "grill"];
const LIVES: ReadonlyArray<Life> = [
  "running",
  "background",
  "background-elsewhere",
  "ended",
  "archived",
  "other-instance",
  "missing",
  "deleted",
];
const LINEAGES: ReadonlyArray<Lineage> = ["root", "subagent", "fork"];

const callerCases = (): ReadonlyArray<CallerCase> => {
  const cases: Array<CallerCase> = [];
  for (const orchestration of [true, false]) {
    for (const access of AuthMcpClientAccess.literals)
      cases.push({ kind: "client", access, orchestration });
    for (const runtime of RUNTIME_MODES)
      for (const interaction of INTERACTION_MODES)
        for (const life of LIVES)
          for (const lineage of LINEAGES)
            // A root thread's root is itself, so "the root is an automation step" is "it is one".
            for (const automation of lineage === "root"
              ? (["none", "self"] as const)
              : (["none", "self", "root"] as const))
              cases.push({
                kind: "thread",
                runtime,
                interaction,
                life,
                lineage,
                automation,
                orchestration,
              });
  }
  return cases;
};

const POSITIONS: ReadonlyArray<Position> = [
  "home",
  "delegate",
  "nested-delegate",
  "native-subagent",
  "fork",
  "fork-of-delegate",
  "delegate-of-fork",
  "other-step-delegate",
  "elsewhere",
];

const targetCases = (positions: ReadonlyArray<Position>): ReadonlyArray<TargetCase> => [
  { kind: "omitted" },
  { kind: "own" },
  { kind: "missing" },
  { kind: "deleted" },
  ...RUNTIME_MODES.flatMap((runtime) =>
    INTERACTION_MODES.flatMap((interaction) =>
      positions.map((position) => ({ kind: "other" as const, runtime, interaction, position })),
    ),
  ),
];
/** Only a message's rule reads where its target sits; a change or a fork reads its modes. */
const writeTargets = targetCases(["elsewhere", "fork"]);
const messageTargets = targetCases(POSITIONS);

const requestedRuntimes: ReadonlyArray<RequestedRuntime> = [undefined, ...RUNTIME_MODES];
const requestedInteractions: ReadonlyArray<RequestedInteraction> = [
  undefined,
  "inherit",
  ...INTERACTION_MODES,
];

// ---- The world a case describes: the caller's credential scope and the shells getThreadShell answers with.

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const AUTOMATION_STEP = ThreadId.make("automation:r_1.build.1");
const OTHER_STEP = ThreadId.make("automation:r_2.build.1");
const PARENT = ThreadId.make("thread:parent");
const CLIENT_HOME = ThreadId.make("thread:client-home");
const DELEGATE = ThreadId.make("thread:delegate");
const FORK = ThreadId.make("thread:fork");
const TARGET = ThreadId.make("thread:target");
const MISSING = ThreadId.make("thread:missing");
const DELETED_TARGET = ThreadId.make("thread:deleted-target");

const callerId = (c: Extract<CallerCase, { kind: "thread" }>) =>
  c.automation === "self" ? AUTOMATION_STEP : ThreadId.make("thread:caller");

const ownId = (c: CallerCase): ThreadId | undefined =>
  c.kind === "thread" ? callerId(c) : undefined;

/** The root of a thread caller's tree. */
const callerRoot = (c: Extract<CallerCase, { kind: "thread" }>): ThreadId =>
  c.lineage === "root" ? callerId(c) : c.automation === "root" ? AUTOMATION_STEP : PARENT;

/** Where the caller's targets hang from: its automation step, else the root of its tree (a client's is a thread of its own). */
const homeOf = (c: CallerCase): ThreadId =>
  c.kind === "client" ? CLIENT_HOME : c.automation !== "none" ? AUTOMATION_STEP : callerRoot(c);

const callerShell = (
  c: Extract<CallerCase, { kind: "thread" }>,
): OrchestrationV2ThreadShell | null => {
  if (c.life === "missing") return null;
  const id = callerId(c);
  const hasRun =
    c.life === "running" ||
    c.life === "archived" ||
    c.life === "other-instance" ||
    c.life === "deleted";
  const base = liveThreadShell(id, {
    runtimeMode: c.runtime,
    interactionMode: c.interaction,
    ...(hasRun ? {} : { activeRunId: null }),
  });
  const rootThreadId = callerRoot(c);
  return {
    ...base,
    lineage:
      c.lineage === "root"
        ? { rootThreadId, parentThreadId: null, relationshipToParent: null }
        : { rootThreadId, parentThreadId: PARENT, relationshipToParent: c.lineage },
    ...(c.life === "background"
      ? {
          pendingBackgroundTasks: [
            { taskId: "task:bg", kind: "subagent" as const, providerInstanceId: codex },
          ],
        }
      : {}),
    ...(c.life === "background-elsewhere"
      ? {
          pendingBackgroundTasks: [
            { taskId: "task:bg", kind: "subagent" as const, providerInstanceId: claude },
          ],
        }
      : {}),
    ...(c.life === "archived" ? { archivedAt: base.updatedAt } : {}),
    ...(c.life === "other-instance" ? { providerInstanceId: claude } : {}),
    ...(c.life === "deleted" ? { deletedAt: base.updatedAt } : {}),
  };
};

const scopeOf = (c: CallerCase): McpInvocationContext.McpInvocationScope => {
  const capabilities = new Set<McpInvocationContext.McpCapability>(
    c.orchestration ? ["orchestration", "worktree", "pull-requests"] : ["preview"],
  );
  const base = { environmentId: EnvironmentId.make("environment"), capabilities, issuedAt: 0 };
  return c.kind === "client"
    ? {
        ...base,
        requestNamespace: "client:session",
        thread: undefined,
        client: { sessionId: "session", label: "outside agent", access: c.access },
      }
    : {
        ...base,
        requestNamespace: "provider:session",
        thread: {
          threadId: callerId(c),
          providerSessionId: "provider:session",
          providerInstanceId: codex,
        },
        client: undefined,
      };
};

/**
 * A thread of the case's world besides the caller, and how it hangs from `parent`: started by delegate_task under it,
 * a provider's own subagent of it, or a fork of it. The reference reads only these edges; the code reads the shells
 * built from them.
 */
interface WorldThread {
  readonly id: ThreadId;
  readonly parent: ThreadId | null;
  readonly edge: "delegate" | "native" | "fork" | null;
  readonly modes?: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  };
}

const worldFor = (c: CallerCase, target: TargetCase | undefined): ReadonlyArray<WorldThread> => {
  if (target?.kind !== "other") return [];
  const home = homeOf(c);
  const modes = { runtimeMode: target.runtime, interactionMode: target.interaction };
  const homeThread: ReadonlyArray<WorldThread> =
    home === ownId(c)
      ? []
      : [{ id: home, parent: null, edge: null, ...(target.position === "home" ? { modes } : {}) }];
  const at = (parent: ThreadId, edge: WorldThread["edge"]): WorldThread => ({
    id: TARGET,
    parent,
    edge,
    modes,
  });
  switch (target.position) {
    case "home":
      return homeThread;
    case "delegate":
      return [...homeThread, at(home, "delegate")];
    case "nested-delegate":
      return [
        ...homeThread,
        { id: DELEGATE, parent: home, edge: "delegate" },
        at(DELEGATE, "delegate"),
      ];
    case "native-subagent":
      return [...homeThread, at(home, "native")];
    case "fork":
      return [...homeThread, at(home, "fork")];
    case "fork-of-delegate":
      return [
        ...homeThread,
        { id: DELEGATE, parent: home, edge: "delegate" },
        at(DELEGATE, "fork"),
      ];
    case "delegate-of-fork":
      return [...homeThread, { id: FORK, parent: home, edge: "fork" }, at(FORK, "delegate")];
    case "other-step-delegate":
      return [{ id: OTHER_STEP, parent: null, edge: null }, at(OTHER_STEP, "delegate")];
    case "elsewhere":
      return [{ id: TARGET, parent: null, edge: null, modes }];
  }
};

/** Each world thread's shell, as the orchestrator builds it: a child takes its parent's root (makeSubagentChildThread, ThreadForkService). */
const shellsFor = (
  c: CallerCase,
  target: TargetCase | undefined,
): ReadonlyMap<string, OrchestrationV2ThreadShell | null> => {
  const shells = new Map<string, OrchestrationV2ThreadShell | null>();
  if (c.kind === "thread") shells.set(callerId(c), callerShell(c));
  for (const thread of worldFor(c, target)) {
    const base = liveThreadShell(thread.id, thread.modes);
    const root =
      thread.parent === null
        ? thread.id
        : (shells.get(thread.parent)?.lineage.rootThreadId ?? thread.parent);
    shells.set(thread.id, {
      ...base,
      creationSource:
        thread.edge === "native" ? "provider" : thread.edge === null ? base.creationSource : "mcp",
      lineage: {
        rootThreadId: root,
        parentThreadId: thread.parent,
        relationshipToParent:
          thread.edge === null ? null : thread.edge === "fork" ? "fork" : "subagent",
      },
    });
  }
  if (target?.kind === "deleted")
    shells.set(DELETED_TARGET, {
      ...liveThreadShell(DELETED_TARGET),
      deletedAt: liveThreadShell(DELETED_TARGET).updatedAt,
    });
  return shells;
};

const targetId = (c: CallerCase, target: TargetCase): ThreadId | undefined => {
  switch (target.kind) {
    case "omitted":
      return undefined;
    case "own":
      return ownId(c) ?? TARGET;
    case "missing":
      return MISSING;
    case "deleted":
      return DELETED_TARGET;
    case "other":
      return target.position === "home" ? homeOf(c) : TARGET;
  }
};

// ---- The reference decision table, written from the promises in McpToolAccess.ts, threadAccess.ts and
// delegationPolicy.ts, never from their code.

const RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

const limitOf = (c: CallerCase): RuntimeMode =>
  c.kind === "client" ? (c.access === "read-only" ? "approval-required" : c.access) : c.runtime;

/** Undefined: the caller passes the step; otherwise the refusal code. */
const threadCredentialNeeded = (c: CallerCase) =>
  c.kind === "client" ? "thread_credential_required" : undefined;
const readOnlyClient = (c: CallerCase) =>
  c.kind === "client" && c.access === "read-only" ? "capability_denied" : undefined;
const controlsThreads = (c: CallerCase) => (c.orchestration ? undefined : "capability_denied");
const callerExists = (c: CallerCase) =>
  c.kind === "thread" && (c.life === "missing" || c.life === "deleted")
    ? "thread_not_found"
    : undefined;
const callerLive = (c: CallerCase) =>
  c.kind === "thread" && !(c.life === "running" || c.life === "background")
    ? "parent_not_active"
    : undefined;
const inAutomation = (c: CallerCase) => c.kind === "thread" && c.automation !== "none";

/**
 * What an automation step's run pays for and stops with the step (automations/steps.ts `family`): the step, and every
 * thread delegate_task started under a member, walked down from the step.
 */
const runFamily = (world: ReadonlyArray<WorldThread>, step: ThreadId): ReadonlyArray<ThreadId> => [
  step,
  ...world
    .filter((thread) => thread.parent === step && thread.edge === "delegate")
    .flatMap((thread) => runFamily(world, thread.id)),
];

const first = (...steps: ReadonlyArray<() => string | undefined>): string | undefined => {
  for (const step of steps) {
    const refusal = step();
    if (refusal !== undefined) return refusal;
  }
  return undefined;
};

const writer = (c: CallerCase) =>
  first(
    () => readOnlyClient(c),
    () => callerExists(c),
    () => callerLive(c),
  );
const orchestrator = (c: CallerCase) =>
  first(
    () => readOnlyClient(c),
    () => controlsThreads(c),
    () => callerExists(c),
    () => callerLive(c),
  );

type Call =
  | {
      readonly tool:
        | "reads"
        | "reads_as_caller"
        | "acts_as_caller"
        | "writes"
        | "writes_with_capability"
        | "writes_environment";
    }
  | {
      readonly tool: "writes_threads" | "messages_thread" | "forks_threads";
      readonly target: TargetCase;
    }
  | {
      readonly tool: "starts_threads";
      readonly runtimeMode: RequestedRuntime;
      readonly interactionMode: RequestedInteraction;
    }
  | { readonly tool: "either"; readonly create: boolean };

const expected = (c: CallerCase, call: Call): string => {
  switch (call.tool) {
    case "reads":
      return "ran";
    case "reads_as_caller":
      return threadCredentialNeeded(c) ?? "ran";
    case "acts_as_caller":
      return (
        first(
          () => threadCredentialNeeded(c),
          () => writer(c),
        ) ?? "ran"
      );
    case "writes":
      return orchestrator(c) ?? "ran";
    case "writes_with_capability":
      return writer(c) ?? "ran";
    case "writes_environment":
      return (
        first(
          () => orchestrator(c),
          () => (inAutomation(c) ? "capability_denied" : undefined),
          () => (limitOf(c) === "full-access" ? undefined : "capability_denied"),
        ) ?? "ran"
      );
    case "either":
      return call.create
        ? expected(c, {
            tool: "starts_threads",
            runtimeMode: undefined,
            interactionMode: undefined,
          })
        : expected(c, { tool: "writes_environment" });
    case "writes_threads": {
      const refusal = writer(c);
      if (refusal !== undefined) return refusal;
      const { target } = call;
      // An omitted id is the caller's own thread, always within its modes.
      const id = targetId(c, target);
      if (id === undefined || id === ownId(c)) return "ran";
      // Grill grants nothing beyond default, so only the runtime mode can be broader than the caller's.
      if (target.kind === "other" && RANK[target.runtime] > RANK[limitOf(c)])
        return "runtime_mode_escalation_denied";
      return "ran";
    }
    case "messages_thread": {
      const refusal = writer(c);
      if (refusal !== undefined) return refusal;
      // A message starts a turn in an idle thread. From an automation run it reaches only what the step's run pays
      // for and stops: a turn anywhere else, a fork of the step's own threads included, would escape the run's wallet
      // and outlive the step.
      const { target } = call;
      const id = targetId(c, target);
      const ownThread = id === undefined || id === ownId(c);
      if (
        inAutomation(c) &&
        !ownThread &&
        !runFamily(worldFor(c, target), AUTOMATION_STEP).includes(id)
      )
        return "capability_denied";
      return expected(c, { tool: "writes_threads", target });
    }
    case "forks_threads": {
      const refusal = writer(c);
      if (refusal !== undefined) return refusal;
      // A fork is a new thread its run would neither pay for nor stop.
      if (inAutomation(c)) return "capability_denied";
      return expected(c, { tool: "writes_threads", target: call.target });
    }
    case "starts_threads": {
      const refusal = first(
        () => writer(c),
        () => (c.kind === "thread" && c.lineage === "subagent" ? "capability_denied" : undefined),
        () => (inAutomation(c) ? "capability_denied" : undefined),
      );
      if (refusal !== undefined) return refusal;
      const runtime = call.runtimeMode ?? limitOf(c);
      if (RANK[runtime] > RANK[limitOf(c)]) return "runtime_mode_escalation_denied";
      // Grill is the user's: a started thread never runs in it, whatever was asked or inherited.
      return `${runtime}/default`;
    }
  }
};

// ---- One probe tool per declaration, registered through the real McpToolAccess.toLayer.

const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const StartParameters = Schema.Struct({
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(Schema.Literals(["inherit", "default", "grill"])),
});
const ProbeToolkit = Toolkit.make(
  Tool.make("reads", probe),
  Tool.make("reads_as_caller", probe),
  Tool.make("acts_as_caller", probe),
  Tool.make("writes", probe),
  Tool.make("writes_with_capability", probe),
  Tool.make("writes_threads", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("messages_thread", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("forks_threads", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("starts_threads", { ...probe, parameters: StartParameters }),
  Tool.make("writes_environment", probe),
  Tool.make("either", { ...probe, parameters: Schema.Struct({ create: Schema.Boolean }) }),
);
const ran = Effect.succeed({ ran: "ran" });
const reportModes = (modes: McpToolAccess.StartedModes) =>
  Effect.succeed({ ran: `${modes.runtimeMode}/${modes.interactionMode}` });
const handlersLayer = McpToolAccess.HandlersLayer.layer(
  McpToolAccess.toLayer(ProbeToolkit, {
    reads: McpToolAccess.reads(() => ran),
    reads_as_caller: McpToolAccess.readsAsCaller(() => ran),
    acts_as_caller: McpToolAccess.actsAsCaller(() => ran),
    writes: McpToolAccess.writes(() => ran),
    writes_with_capability: McpToolAccess.writesWithCapability(() => ran),
    writes_threads: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      () => ran,
    ),
    messages_thread: McpToolAccess.messagesThread(
      (input) => input.threadId,
      () => ran,
    ),
    forks_threads: McpToolAccess.forksThreads(
      (input) => [input.threadId],
      () => ran,
    ),
    starts_threads: McpToolAccess.startsThreads(
      (input: typeof StartParameters.Type) => input,
      (_, modes) => reportModes(modes),
    ),
    writes_environment: McpToolAccess.writesEnvironment(() => ran),
    either: McpToolAccess.either(
      (input: { readonly create: boolean }) => input.create,
      McpToolAccess.startsThreads(
        () => ({}),
        (_, modes) => reportModes(modes),
      ),
      McpToolAccess.writesEnvironment(() => ran),
    ),
  }),
);

const callsFor = (): ReadonlyArray<Call> => [
  { tool: "reads" },
  { tool: "reads_as_caller" },
  { tool: "acts_as_caller" },
  { tool: "writes" },
  { tool: "writes_with_capability" },
  { tool: "writes_environment" },
  { tool: "either", create: true },
  { tool: "either", create: false },
  ...writeTargets.map((target) => ({ tool: "writes_threads" as const, target })),
  ...writeTargets.map((target) => ({ tool: "forks_threads" as const, target })),
  ...messageTargets.map((target) => ({ tool: "messages_thread" as const, target })),
  ...requestedRuntimes.flatMap((runtimeMode) =>
    requestedInteractions.map((interactionMode) => ({
      tool: "starts_threads" as const,
      runtimeMode,
      interactionMode,
    })),
  ),
];

const paramsOf = (c: CallerCase, call: Call): Record<string, unknown> => {
  switch (call.tool) {
    case "writes_threads":
    case "messages_thread":
    case "forks_threads": {
      const id = targetId(c, call.target);
      return id === undefined ? {} : { threadId: id };
    }
    case "starts_threads":
      return {
        ...(call.runtimeMode === undefined ? {} : { runtimeMode: call.runtimeMode }),
        ...(call.interactionMode === undefined ? {} : { interactionMode: call.interactionMode }),
      };
    case "either":
      return { create: call.create };
    default:
      return {};
  }
};

it.effect(
  "every McpToolAccess declaration allows exactly what the reference table allows, for every caller and target",
  () =>
    Effect.gen(function* () {
      const toolkit = yield* ProbeToolkit;
      let shells: ReadonlyMap<string, OrchestrationV2ThreadShell | null> = new Map();
      const threads = ThreadManagement.ThreadManagementService.of({
        getThreadShell: (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]);
      const callers = callerCases();
      const calls = callsFor();
      const mismatches: Array<string> = [];
      let explored = 0;
      for (const c of callers) {
        const scope = scopeOf(c);
        for (const call of calls) {
          shells = shellsFor(c, "target" in call ? call.target : undefined);
          const outcome = yield* toolkit.handle(call.tool, paramsOf(c, call) as never).pipe(
            Effect.flatMap(Stream.runLast),
            Effect.map((last) => {
              if (last._tag === "None") return "no result";
              const { result, isFailure } = last.value as {
                result: { ran?: string; code?: string };
                isFailure: boolean;
              };
              return isFailure
                ? (result.code ?? "failure without code")
                : (result.ran ?? "success without ran");
            }),
            Effect.catchCause((cause) => Effect.succeed(`defect: ${String(cause).slice(0, 200)}`)),
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(ThreadManagement.ThreadManagementService, threads),
          );
          explored++;
          const want = expected(c, call);
          if (outcome !== want && mismatches.length < 10) {
            mismatches.push(
              `${call.tool} ${canonicalKey(call)} from ${canonicalKey(c)}: got ${outcome}, reference says ${want}`,
            );
          }
        }
      }
      console.log(
        `McpToolAccess decision table: ${callers.length} callers x ${calls.length} calls = ${explored} cases explored, exhaustive over the stated domain`,
      );
      expect(mismatches, mismatches.join("\n")).toEqual([]);
      expect(explored).toBe(callers.length * calls.length);
    }).pipe(Effect.provide(Layer.mergeAll(handlersLayer))),
  // About 15 s on an idle machine; the margin is for a busy one.
  { timeout: 600_000 },
);
