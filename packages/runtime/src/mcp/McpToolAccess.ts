// ), apps/server/src/mcp/McpToolAccess.ts @ ab3a3cd1.
import {
  OrchestratorMcpFailure,
  type OrchestratorMcpInteractionMode,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  AUTOMATION_STEP_CHANGES_NO_ENVIRONMENT,
  AUTOMATION_STEP_MESSAGES_ONLY_ITS_OWN,
  AUTOMATION_STEP_STARTS_NO_THREADS,
  DELEGATED_AGENT_STARTS_NO_THREADS,
  inAutomationRun,
  messageStaysInRun,
} from "./delegationPolicy.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./OrchestratorMcpService.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

// Only the classes below assign these, from their static blocks, so nothing
// outside this module can build a declaration or a handlers layer.

/**
 * Both constructors demand this. Their private constructors only stop the type
 * checker; this also stops `Reflect.construct` and friends at runtime.
 */
const builtHere: unique symbol = Symbol("caveman-code/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

/** Builds a declaration; only the declaration functions below call it. */
let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

/** Turns each declaration back into the handler it checks, keeping its type. */
interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

/** Only `toLayer` below builds one. */
let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/**
 * Who may call a Caveman Code MCP tool. Every handler is built by one of the
 * declarations below, which say what the tool does. `toLayer` accepts only
 * declarations, and `/mcp` registers only layers `toLayer` built, so a tool
 * without a decision here does not compile. Both are nominal classes, so a
 * handler or layer cannot pass for one by copying its fields. Effect's own
 * registration functions accept any handler, so the
 * `t3code/no-raw-mcp-registration` lint rule keeps Effect's `McpServer` inside
 * McpHttpServer.
 *
 * Parameters choose the target; the caller sets the limits: a thread caller
 * its own runtime and interaction modes, an outside client the ceiling it was
 * approved with. Nothing a caller starts or changes may run with broader
 * modes, and a thread caller changes things only while its own run is live.
 * A refusal is an `OrchestratorMcpFailure`, so the compiler requires it in the
 * tool's failure schema, and `ThreadManagementService` in its dependencies.
 *
 * The declaration checks the caller before the handler runs. Handlers still
 * check what only they can see, such as a queued run belonging to its thread.
 */
export class Declaration<out Handler> {
  // A private field makes the class nominal, and only this module can build
  // one: its constructor is private and the static block hands the only way
  // in to module-scoped functions. Copying a declaration's fields onto
  // anything else fails to typecheck and, at runtime, to run.
  readonly #handle: Handler;
  private constructor(token: typeof builtHere, handle: Handler) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
  }
  static {
    declare = (handle) => new Declaration(builtHere, handle);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
  }
}

/** A client approved for read-only access changes nothing. */
const refuseReadOnlyClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client?.access === "read-only"
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This tool changes the environment, and this MCP client was approved for read-only access.",
          }),
        )
      : Effect.void,
  ),
);

/**
 * The caller of a tool that changes something. Tools that act for a
 * capability of their own (preview, device, worktree, pull requests) check it
 * themselves.
 */
const writingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(loadCaller()),
  Effect.tap(assertLiveCaller),
);

/** The same, for tools whose only capability is controlling threads. */
const orchestratingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(readCaller()),
  Effect.tap(assertLiveCaller),
);

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

/** Changes nothing, so every caller may call it. */
export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => handle(params));

/** Reads what belongs to the calling T3 thread, such as its preview tabs or devices. */
export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Acts as the calling T3 thread (its subagents, preview tabs, devices,
 * worktree) while that thread's run is live. Only an agent running inside a
 * T3 thread has one.
 */
export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => writingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

/** Changes something that belongs to no thread, such as a pending upload or a scheduled task. */
export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => orchestratingCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Changes something that belongs to no thread under a capability of the tool's own, such as
 * writing a pull request's review guide. Unlike `writes` it does not need thread control; the
 * handler checks its capability, as the capability toolkits do.
 */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => writingCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * The checks `writesThreads`, `messagesThread` and `forksThreads` share. A message starts a turn in its target, and a
 * fork is a new thread, so a caller in an automation run is held to its step there.
 */
const changingThreads =
  <P, A, E, R>(
    threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
    handle: (params: P) => Effect.Effect<A, E, R>,
    change: "changes" | "messages" | "forks",
  ) =>
  (params: P) =>
    Effect.gen(function* () {
      const caller = yield* writingCaller;
      if (change === "forks" && caller.caller !== undefined && inAutomationRun(caller.caller)) {
        return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: AUTOMATION_STEP_STARTS_NO_THREADS });
      }
      const shell = (threadId: ThreadId) => caller.threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      for (const threadId of threads(params)) {
        if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
        const target = yield* shell(threadId);
        if (change === "messages" && caller.caller !== undefined && !(yield* messageStaysInRun(caller.caller, target, shell))) {
          return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: AUTOMATION_STEP_MESSAGES_ONLY_ITS_OWN });
        }
        if (target !== null && target.deletedAt === null) {
          yield* assertTargetWithinLimits(caller.limits, target);
        }
      }
      // The target's user can raise its modes after the check above; the
      // orchestrator checks again under the thread's lock and records its
      // refusal here, since handlers wrap dispatch errors their own way.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      return yield* handle(params).pipe(
        Effect.provideService(DispatchModeLimit, { ...caller.limits, refused }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail<E | OrchestratorMcpFailure>(
              refusal === undefined ? error : escalationDenied(refusal),
            ),
          ),
        ),
      );
    });

/**
 * Changes the threads `threads` names. An omitted id is the caller's own
 * thread; any other thread must run within the caller's modes, checked here
 * and again by the orchestrator when it applies each command. A thread that
 * does not exist is the handler's to report.
 */
export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) => declare(changingThreads(threads, handle, "changes"));

/**
 * Sends to the thread `thread` names (omitted, the caller's own), which starts a turn there if it is idle:
 * `writesThreads`, except that a caller in an automation run reaches only what its step's run pays for and stops
 * (`messageStaysInRun`: the step's thread and the agents delegated under it, never a fork). A turn anywhere else,
 * here or on another computer, would escape the run's wallet and outlive the step.
 */
export const messagesThread = <P, A, E, R>(
  thread: (params: P) => ThreadId | undefined,
  handle: (params: P) => Effect.Effect<A, E, R>,
) => declare(changingThreads((params: P) => [thread(params)], handle, "messages"));

/**
 * Forks a thread `threads` names into a new one: `writesThreads`, except that a caller in an automation run may not.
 * The fork would share the step's root but be no delegate of it, so the run would neither pay for its turns nor stop
 * them.
 */
export const forksThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) => declare(changingThreads(threads, handle, "forks"));

/** How an agent hears that a thread it targets was raised above its modes mid-call. */
const escalationDenied = (refusal: DispatchModeRefusal) =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.`,
  });

/** The modes a started thread runs with: those requested, else the caller's own. */
export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Starts threads with the modes `modes` requests, which may not be broader than the caller's.
 * A delegated agent may not: each new thread would be a fresh root outside Settings > Subagents' limits.
 */
export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: OrchestratorMcpInteractionMode | ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const { limits, caller } = yield* writingCaller;
      if (caller?.lineage.relationshipToParent === "subagent") {
        return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: DELEGATED_AGENT_STARTS_NO_THREADS });
      }
      // An automation step's work stays inside its run: anything it started would escape the run's wallet and could recurse.
      if (caller !== undefined && inAutomationRun(caller)) {
        return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: AUTOMATION_STEP_STARTS_NO_THREADS });
      }
      const requested = modes(params);
      const started: StartedModes = {
        runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, requested.runtimeMode),
        interactionMode: yield* resolveInteractionMode(
          limits.interactionMode,
          requested.interactionMode,
        ),
      };
      return yield* handle(params, started);
    }),
  );

/** One tool with two access rules, picked per call, such as create versus update. */
export const either = <P, A, E, R, A2, E2, R2>(
  useFirst: (params: P) => boolean,
  first: Declaration<(params: P) => Effect.Effect<A, E, R>>,
  second: Declaration<(params: P) => Effect.Effect<A2, E2, R2>>,
) =>
  declare((params: P): Effect.Effect<A | A2, E | E2, R | R2> =>
    useFirst(params) ? checkedHandler(first)(params) : checkedHandler(second)(params),
  );

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access calling thread or a full-access client.";

/**
 * Changes projects or environment settings, which needs a full-access
 * caller. `check` re-checks the caller wherever the handler waits before
 * writing, such as for a lock, since the caller's modes can change meanwhile.
 */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) =>
      caller.caller !== undefined && inAutomationRun(caller.caller)
        ? Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message: AUTOMATION_STEP_CHANGES_NO_ENVIRONMENT }))
        : assertFullAccess(caller, fullAccessRequired),
    ),
  );
  return declare((params: P) => check.pipe(Effect.flatMap(() => handle(params, check))));
};

/** What a declaration's own check needs. */
type CheckServices = Effect.Services<typeof orchestratingCaller>;

/**
 * Each handler of `Handlers`, built by one of the declarations above. A
 * declaration is never callable, which rules out a handler function wearing a
 * declaration's fields.
 */
type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

/** Anything but a function. */
type NotCallable = { readonly call?: never } & { readonly apply?: never };

/** A toolkit's handlers, each built by one of the declarations above. */
export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

/**
 * A toolkit's handler layer built by `toLayer`, the only kind `/mcp`
 * registers. Like a declaration it is nominal, so nothing else passes for one.
 */
export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  /** The handlers, for registering this toolkit on the MCP server. */
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

/** `Toolkit.toLayer` for handlers that all declare their access. */
export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> =>
  handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build)
        ? Effect.map(build, checkedHandlers<Toolkit.HandlersFrom<Tools>>)
        : checkedHandlers(build),
    ),
  );
