// ), packages/provider-opencode/src/server/adapter.test.ts @ 13aa882c22.
// @effect-diagnostics-next-line nodeBuiltinImport:off - Exercise HTTP authentication with the real SDK.
import * as NodeHttp from "node:http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createOpencodeClient, type OpencodeClient, type ToolPart } from "@opencode-ai/sdk/v2";
import {
  CheckpointId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  MessageId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderOptionSelection,
} from "@caveman-app/protocol";
import { OpenCodeSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import type * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";

import {
  advanceOpenCodePromptAdmission,
  cancelOpenCodePromptAdmission,
  openCodeBoundaryAfterProviderTurn,
  openCodeChildPermissionRules,
  openCodePermissionRules,
  openCodePermissionRequestKind,
  openCodeToolProjectionKind,
  makeOpenCodeProtocolLogger,
  makeOpenCodeAdapterV2,
  OPENCODE_PROVIDER,
  reconcileOpenCodePromptAdmissionStatus,
} from "./adapter.ts";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeOpenCodeSettings = Schema.decodeEffect(OpenCodeSettings);
const OPEN_CODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: "http://test.invalid",
});

function promiseGate<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function asyncEventStream() {
  const values: Array<{ value: unknown; handled: ReturnType<typeof promiseGate<void>> }> = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  let previousHandled: ReturnType<typeof promiseGate<void>> | undefined;
  let closed = false;
  return {
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    push(value: unknown) {
      const handled = promiseGate<void>();
      const waiter = waiters.shift();
      if (waiter) {
        previousHandled = handled;
        waiter({ done: false, value });
      } else values.push({ value, handled });
      return handled.promise;
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            previousHandled?.resolve();
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            const entry = values.shift();
            if (entry !== undefined) {
              previousHandled = entry.handled;
              return Promise.resolve({ done: false as const, value: entry.value });
            }
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

const OPENCODE_TEST_SETTINGS = Schema.decodeUnknownSync(OpenCodeSettings)({});

/**
 * The real SDK event client over an in-memory network, so its reconnects run
 * without a socket or a real timer. Each `/event` request opens a connection
 * that starts with server.connected; once the server goes away, requests fail
 * as fetch does when nothing listens.
 */
function openCodeEventNetwork() {
  let requests = 0;
  let connections = 0;
  let gone = false;
  let current: ReadableStreamDefaultController<Uint8Array> | undefined;
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  const fetch = async (request: Request) => {
    if (new URL(request.url).pathname !== "/event") return new Response(null, { status: 404 });
    requests += 1;
    if (gone) throw new TypeError("fetch failed");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        current = controller;
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'),
        );
      },
    });
    connections += 1;
    for (const waiter of waiters.filter((entry) => entry.count <= connections)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const drop = () => current?.error(new TypeError("terminated"));
  return {
    client: createOpencodeClient({
      baseUrl: "http://opencode.test",
      fetch: fetch as typeof globalThis.fetch,
      throwOnError: true,
    }),
    get requests() {
      return requests;
    },
    get connections() {
      return connections;
    },
    connected: (count: number) =>
      count <= connections
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve })),
    drop,
    goAway: () => {
      gone = true;
      drop();
    },
  };
}

function runtimePolicy(
  runtimeMode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
  override: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = {},
): ProviderAdapter.ProviderAdapterV2RuntimePolicy {
  return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
    ...override,
  });
}

function permissionAction(rules: ReturnType<typeof openCodePermissionRules>, permission: string) {
  return rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)
    ?.action;
}

function providerTurn(input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
}): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(input.id),
    providerThreadId: ProviderThreadId.make("provider-thread:opencode-test"),
    nodeId: NodeId.make(`node:${input.id}`),
    runAttemptId: null,
    nativeTurnRef:
      input.nativeId === null
        ? null
        : { driver: OPENCODE_PROVIDER, nativeId: input.nativeId, strength: "weak" },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: null,
    completedAt: null,
  };
}

const makeOpenCodeRuntimeHarness = Effect.fn("makeOpenCodeRuntimeHarness")(function* (
  suffix: string,
  nativeSessionId: string,
  client: object,
  host: Partial<ProviderHost.ProviderHost["Service"]> = {},
  turnSettings: {
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
    readonly interactionMode?: ProviderAdapter.ProviderAdapterV2RuntimePolicy["interactionMode"];
  } = {},
) {
  const instanceId = ProviderInstanceId.make(`opencode-${suffix}`);
  const threadId = ThreadId.make(`thread-opencode-${suffix}`);
  const modelSelection = {
    instanceId,
    model: "anthropic/claude-sonnet",
    options: turnSettings.options ?? [],
  };
  const policy = runtimePolicy("full-access", {
    cwd: "/workspace",
    interactionMode: turnSettings.interactionMode ?? "default",
  });
  const adapter = yield* makeOpenCodeAdapterV2({
    instanceId,
    settings: OPEN_CODE_TEST_SETTINGS,
    environment: {},
  }).pipe(
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
      connectToOpenCodeServer: () => Effect.succeed({ url: "http://test.invalid", external: true }),
      createOpenCodeSdkClient: () => client,
    } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
    Effect.provideService(ProviderHost.ProviderHost, {
      paths: { cwd: "/workspace" },
      resolveAttachmentPath: () => null,
      ...host,
    } as unknown as ProviderHost.ProviderHost["Service"]),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session-opencode-${suffix}`),
    modelSelection,
    runtimePolicy: policy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: policy,
  });
  const now = yield* DateTime.now;
  const startTurn = (
    text = "hello",
    startProviderThread: OrchestrationV2ProviderThread = providerThread,
    turnPolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = policy,
    providerTurnOrdinal = 1,
  ) =>
    runtime.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make(`project-opencode-${suffix}`),
        title: suffix,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: policy.interactionMode,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-opencode-${suffix}`),
      runOrdinal: providerTurnOrdinal,
      providerTurnOrdinal,
      attemptId: RunAttemptId.make(`attempt-opencode-${suffix}`),
      rootNodeId: NodeId.make(`node-opencode-${suffix}`),
      providerThread: startProviderThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-opencode-${suffix}`),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy: turnPolicy,
    });
  return {
    nativeSessionId,
    now,
    policy,
    providerThread,
    runId: RunId.make(`run-opencode-${suffix}`),
    runtime,
    startTurn,
    threadId,
  };
});

/**
 * A root turn that launches a background `task`, in the event order of a live
 * OpenCode 1.18.32 run: the task part completes at launch and the child session
 * stays busy after the root settles.
 */
const makeBackgroundChildHarness = Effect.fn("makeBackgroundChildHarness")(function* (
  suffix: string,
) {
  const nativeEvents = asyncEventStream();
  const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
  const root = "ses_root";
  const child = "ses_child";
  const permissionId = "per_child_bash";
  const replies: Array<string> = [];
  let promptId = "";
  const harness = yield* makeOpenCodeRuntimeHarness(suffix, root, {
    event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
    session: {
      create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
      get: async () => ({
        data: { id: child, parentID: root, permission: [], time: { created: 2, updated: 2 } },
      }),
      update: async () => ({ data: { id: child, parentID: root } }),
      promptAsync: async (input: { messageID: string }) => {
        promptId = input.messageID;
        return { data: true };
      },
      abort: async () => ({ data: true }),
      children: async () => ({ data: [] }),
    },
    permission: {
      reply: async (input: { requestID: string }) => {
        replies.push(input.requestID);
        return { data: true };
      },
    },
  });
  const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  yield* harness.runtime.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => void collected.push(event))),
    Effect.forkScoped,
  );
  yield* harness.startTurn();
  const taskPart = (status: "running" | "completed") => ({
    type: "message.part.updated",
    properties: {
      sessionID: root,
      part: {
        id: "prt_task",
        sessionID: root,
        messageID: "msg_root_assistant",
        type: "tool",
        tool: "task",
        callID: "call_task",
        state: {
          status,
          input: { description: "Background build", prompt: "build", subagent_type: "general" },
          title: "Background build",
          metadata: { parentSessionId: root, sessionId: child, background: true },
          time: { start: 3, ...(status === "completed" ? { end: 3 } : {}) },
          ...(status === "completed" ? { output: "Background task started" } : {}),
        },
      },
    },
  });
  const status = (sessionID: string, type: "busy" | "idle") => ({
    type: "session.status",
    properties: { sessionID, status: { type } },
  });
  const launchChild = Effect.gen(function* () {
    yield* push({
      type: "message.updated",
      properties: {
        sessionID: root,
        info: { id: promptId, sessionID: root, role: "user", time: { created: 1 } },
      },
    });
    yield* push(status(root, "busy"));
    yield* push(taskPart("running"));
    yield* push({
      type: "session.created",
      properties: {
        sessionID: child,
        info: { id: child, parentID: root, time: { created: 2, updated: 2 } },
      },
    });
    yield* push(status(child, "busy"));
    yield* push({
      type: "message.updated",
      properties: {
        sessionID: child,
        info: { id: "msg_child_user", sessionID: child, role: "user", time: { created: 2 } },
      },
    });
    yield* push(taskPart("completed"));
  });
  // The collector runs on its own fiber; let it take what the adapter queued.
  const delivered = Effect.gen(function* () {
    for (let turn = 0; turn < 5; turn += 1) yield* Effect.yieldNow;
    return collected.flatMap((event) =>
      event.type === "runtime_request.updated" &&
      event.runtimeRequest.nativeRequestRef?.nativeId === permissionId
        ? [event]
        : [],
    );
  });
  return {
    root,
    permissionId,
    replies,
    push,
    status,
    launchChild,
    childAsksForBash: {
      type: "permission.asked",
      properties: {
        id: permissionId,
        sessionID: child,
        permission: "bash",
        patterns: ["npm run build"],
        always: ["npm run *"],
        metadata: {},
      },
    },
    requestUpdates: delivered.pipe(
      Effect.map((requests) =>
        requests.map((event) => ({
          status: event.runtimeRequest.status,
          thread: event.threadId === harness.threadId ? "root" : "child",
        })),
      ),
    ),
    /** Answers the request still pending in the app, as the person would. */
    answerPending: Effect.gen(function* () {
      const requests = yield* delivered;
      const pending = requests.findLast((event) => event.runtimeRequest.status === "pending");
      const answered = requests.some(
        (event) =>
          event.runtimeRequest.id === pending?.runtimeRequest.id &&
          event.runtimeRequest.status !== "pending",
      );
      if (pending === undefined || answered) return;
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
    }),
  };
});

describe("OpenCodeAdapterV2", () => {
  it.effect.each([
    {
      message: "<none>",
      statusCode: 503,
      responseBody: "<title> Service\n unavailable </title>",
      expected: "Service unavailable (HTTP 503).",
    },
    {
      message: " <NoNe> ",
      statusCode: 502,
      responseBody: "bad gateway",
      expected: "The model provider failed the request (HTTP 502).",
    },
    {
      message: "<none>",
      expected: "The model provider failed the request and did not include an error message.",
    },
    {
      message: "provider says no",
      statusCode: 503,
      responseBody: "<title>Unavailable</title>",
      expected: "provider says no",
    },
    {
      message: "<none>",
      statusCode: 503,
      responseBody: "<title>https://user:secret@example.com/error?token=secret</title>",
      expected: "https://example.com/error (HTTP 503).",
    },
  ])("reports readable and sanitized session and turn failures: $expected", (sample) =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const harness = yield* makeOpenCodeRuntimeHarness("provider-error", "root", {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.error",
          properties: { sessionID: "root", error: { name: "APIError", data: sample } },
        }),
      );
      const events = yield* Fiber.join(received);
      const session = events.findLast((event) => event.type === "provider_session.updated");
      const terminal = events.findLast((event) => event.type === "turn.terminal");
      assert.strictEqual(session?.providerSession.lastError, sample.expected);
      assert.strictEqual(terminal?.failure?.message, sample.expected);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("classifies APIError 429 as a usage limit", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const harness = yield* makeOpenCodeRuntimeHarness("usage-limit", "root", {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.error",
          properties: {
            sessionID: "root",
            error: {
              name: "APIError",
              data: {
                message: "Provider rejected request",
                statusCode: 429,
                isRetryable: true,
              },
            },
          },
        }),
      );
      const terminal = (yield* Fiber.join(received)).find(
        (event) => event.type === "turn.terminal",
      );
      assert.equal(terminal?.status, "failed");
      assert.equal(terminal?.failure?.class, "usage_limit");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("applies a changed runtime policy to the session on resume and turn start", () =>
    Effect.gen(function* () {
      const updates: Array<{ sessionID: string; permission: unknown }> = [];
      const fullAccess = runtimePolicy("full-access", { cwd: "/workspace" });
      const supervised = runtimePolicy("approval-required", { cwd: "/workspace" });
      const harness = yield* makeOpenCodeRuntimeHarness("policy-change", "root", {
        event: { subscribe: async () => ({ stream: asyncEventStream().stream }) },
        session: {
          create: async (input: { permission: unknown }) => ({
            data: {
              id: "root",
              permission: input.permission,
              time: { created: 1, updated: 1 },
            },
          }),
          get: async () => ({
            data: {
              id: "root",
              permission: openCodePermissionRules(fullAccess),
              time: { created: 1, updated: 1 },
            },
          }),
          update: async (input: { sessionID: string; permission: unknown }) => {
            updates.push(input);
            return { data: { id: input.sessionID, time: { created: 1, updated: 2 } } };
          },
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });

      yield* harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        runtimePolicy: fullAccess,
      });
      assert.deepStrictEqual(updates, []);

      yield* harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        runtimePolicy: supervised,
      });
      assert.deepStrictEqual(updates, [
        { sessionID: "root", permission: openCodePermissionRules(supervised) },
      ]);

      yield* harness.startTurn("hello", harness.providerThread, fullAccess);
      assert.deepStrictEqual(updates.slice(1), [
        { sessionID: "root", permission: openCodePermissionRules(fullAccess) },
      ]);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("applies a changed runtime policy to existing subagent sessions", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
      const updates: Array<{
        sessionID: string;
        permission: ReturnType<typeof openCodePermissionRules>;
      }> = [];
      const fullAccess = runtimePolicy("full-access", { cwd: "/workspace" });
      const supervised = runtimePolicy("approval-required", { cwd: "/workspace" });
      const root = "ses_root";
      const child = "ses_child";
      const taskDeny = { permission: "task", pattern: "*", action: "deny" as const };
      const nativePermissions = new Map<string, (typeof updates)[number]["permission"]>([
        [root, openCodePermissionRules(fullAccess)],
        [child, [taskDeny]],
      ]);
      let failNextChildUpdate = false;
      const harness = yield* makeOpenCodeRuntimeHarness("child-policy-change", root, {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
          get: async ({ sessionID }: { sessionID: string }) => ({
            data: {
              id: sessionID,
              ...(sessionID === child ? { parentID: root } : {}),
              permission: nativePermissions.get(sessionID),
              time: { created: 1, updated: 1 },
            },
          }),
          update: async (input: (typeof updates)[number]) => {
            if (input.sessionID === child && failNextChildUpdate) {
              failNextChildUpdate = false;
              throw new Error("child update failed");
            }
            updates.push(input);
            nativePermissions.set(input.sessionID, input.permission);
            return { data: { id: input.sessionID, time: { created: 1, updated: 2 } } };
          },
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });

      yield* harness.startTurn("hello", harness.providerThread, fullAccess);
      yield* push({
        type: "message.part.updated",
        properties: {
          sessionID: root,
          part: {
            id: "prt_task",
            sessionID: root,
            messageID: "msg_root_assistant",
            type: "tool",
            tool: "task",
            callID: "call_task",
            state: {
              status: "running",
              input: { description: "Explore", prompt: "look around", subagent_type: "general" },
              title: "Explore",
              metadata: { parentSessionId: root, sessionId: child },
              time: { start: 3 },
            },
          },
        },
      });
      const childUpdates = () => updates.filter((update) => update.sessionID === child);
      assert.equal(permissionAction(childUpdates().at(-1)!.permission, "bash"), "allow");

      yield* harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        runtimePolicy: supervised,
      });
      const childRules = childUpdates().at(-1)!.permission;
      assert.equal(childUpdates().length, 2);
      assert.equal(permissionAction(childRules, "bash"), "ask");
      assert.equal(permissionAction(childRules, "task"), "deny");
      assert.deepStrictEqual(childRules, openCodeChildPermissionRules(supervised, [taskDeny]));

      yield* harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        runtimePolicy: fullAccess,
      });
      assert.equal(permissionAction(nativePermissions.get(child)!, "bash"), "allow");

      failNextChildUpdate = true;
      const failed = yield* Effect.exit(
        harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          runtimePolicy: supervised,
        }),
      );
      assert.isTrue(Exit.isFailure(failed));
      yield* harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        runtimePolicy: supervised,
      });
      assert.equal(permissionAction(nativePermissions.get(child)!, "bash"), "ask");
      assert.equal(permissionAction(nativePermissions.get(child)!, "task"), "deny");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect.each(["get", "update"] as const)(
    "keeps turns going while a subagent's policy install fails at session.%s, then installs it",
    (failing) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
        const root = "ses_root";
        const child = "ses_child";
        const taskDeny = { permission: "task", pattern: "*", action: "deny" as const };
        const childUpdates: Array<ReturnType<typeof openCodePermissionRules>> = [];
        // Fails while the child is spawned and again when the next turn starts.
        let childFailures = 2;
        let promptId = "";
        const harness = yield* makeOpenCodeRuntimeHarness(`child-policy-${failing}`, root, {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
            get: async ({ sessionID }: { sessionID: string }) => {
              if (sessionID === child && failing === "get" && childFailures > 0) {
                childFailures -= 1;
                throw new Error("database is locked");
              }
              return {
                data: {
                  id: sessionID,
                  parentID: root,
                  permission: [taskDeny],
                  time: { created: 2 },
                },
              };
            },
            update: async (input: {
              sessionID: string;
              permission: ReturnType<typeof openCodePermissionRules>;
            }) => {
              if (input.sessionID === child && failing === "update" && childFailures > 0) {
                childFailures -= 1;
                throw new Error("database is locked");
              }
              if (input.sessionID === child) childUpdates.push(input.permission);
              return { data: { id: input.sessionID, time: { created: 1, updated: 2 } } };
            },
            promptAsync: async (input: { messageID: string }) => {
              promptId = input.messageID;
              return { data: true };
            },
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
        });
        yield* harness.startTurn();
        const terminal = yield* harness.runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* push({
          type: "message.updated",
          properties: {
            sessionID: root,
            info: { id: promptId, sessionID: root, role: "user", time: { created: 1 } },
          },
        });
        yield* push({
          type: "session.status",
          properties: { sessionID: root, status: { type: "busy" } },
        });
        // Not awaited: a failed install used to end the event stream right here.
        void nativeEvents.push({
          type: "message.part.updated",
          properties: {
            sessionID: root,
            part: {
              id: "prt_task",
              sessionID: root,
              messageID: "msg_root_assistant",
              type: "tool",
              tool: "task",
              callID: "call_task",
              state: {
                status: "running",
                input: { description: "Explore", prompt: "look around", subagent_type: "general" },
                title: "Explore",
                metadata: { parentSessionId: root, sessionId: child },
                time: { start: 3 },
              },
            },
          },
        });
        void nativeEvents.push({
          type: "session.status",
          properties: { sessionID: root, status: { type: "idle" } },
        });
        const settled = Option.getOrUndefined(yield* Fiber.join(terminal));
        const nextTurn = yield* Effect.exit(harness.startTurn());
        const policyBeforeResume = childUpdates.at(-1);
        yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          runtimePolicy: harness.policy,
        });

        assert.deepStrictEqual(
          {
            status: settled?.status,
            threadDisposition: settled?.threadDisposition,
            nextTurnAccepted: Exit.isSuccess(nextTurn),
            policyBeforeResume,
            policyAfterResume: childUpdates.at(-1),
          },
          {
            status: "completed",
            threadDisposition: "reusable",
            nextTurnAccepted: true,
            policyBeforeResume: undefined,
            policyAfterResume: openCodeChildPermissionRules(harness.policy, [taskDeny]),
          },
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect("keeps handling OpenCode events while a subagent's session lookup hangs", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
      const root = "ses_root";
      const child = "ses_child";
      const lookup = promiseGate<AbortSignal | undefined>();
      let promptId = "";
      const harness = yield* makeOpenCodeRuntimeHarness("child-lookup-hangs", root, {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
          get: (_input: unknown, options?: { signal?: AbortSignal }) => {
            lookup.resolve(options?.signal);
            return new Promise<never>(() => {});
          },
          promptAsync: async (input: { messageID: string }) => {
            promptId = input.messageID;
            return { data: true };
          },
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });
      yield* harness.startTurn();
      const terminal = promiseGate<string>();
      yield* harness.runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "turn.terminal") terminal.resolve(event.status);
          }),
        ),
        Effect.forkScoped,
      );
      yield* push({
        type: "message.updated",
        properties: {
          sessionID: root,
          info: { id: promptId, sessionID: root, role: "user", time: { created: 1 } },
        },
      });
      yield* push({
        type: "session.status",
        properties: { sessionID: root, status: { type: "busy" } },
      });
      void nativeEvents.push({
        type: "message.part.updated",
        properties: {
          sessionID: root,
          part: {
            id: "prt_task",
            sessionID: root,
            messageID: "msg_root_assistant",
            type: "tool",
            tool: "task",
            callID: "call_task",
            state: {
              status: "running",
              input: { description: "Explore", prompt: "look around", subagent_type: "general" },
              title: "Explore",
              metadata: { parentSessionId: root, sessionId: child },
              time: { start: 3 },
            },
          },
        },
      });
      const lookupSignal = yield* Effect.promise(() => lookup.promise);
      yield* TestClock.adjust("1 minute");
      void nativeEvents.push({
        type: "session.status",
        properties: { sessionID: root, status: { type: "idle" } },
      });
      // Real time bounds only the failure: a stalled handler never settles the turn.
      const settled = yield* Effect.promise(() =>
        Promise.race([
          terminal.promise,
          new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 2_000)),
        ]),
      );

      assert.deepStrictEqual(
        { terminal: settled, lookupAborted: lookupSignal?.aborted },
        { terminal: "completed", lookupAborted: true },
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect.each(["completed", "failed", "unresolved", "unavailable", "reconnect"] as const)(
    "normalizes OpenCode step usage for %s turns",
    (ending) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        let promptId = "";
        const harness = yield* makeOpenCodeRuntimeHarness(`usage-${ending}`, "root", {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async (input: { messageID: string }) => {
              promptId = input.messageID;
              return { data: true };
            },
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
        });
        yield* harness.startTurn();
        const received = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.updated",
            properties: {
              sessionID: "root",
              info: { id: promptId, role: "user", time: { created: 1 } },
            },
          }),
        );
        const step = (id: string, messageID = "assistant") => ({
          type: "message.part.updated",
          properties: {
            part: {
              type: "step-finish",
              id,
              sessionID: "root",
              messageID,
              reason: "stop",
              cost: 0.01,
              tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } },
            },
          },
        });
        if (ending !== "unavailable") {
          yield* Effect.promise(() => nativeEvents.push(step("one")));
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.updated",
              properties: {
                sessionID: "root",
                info: {
                  id: "assistant",
                  role: "assistant",
                  time: { created: 1 },
                  parentID: promptId,
                },
              },
            }),
          );
          yield* Effect.promise(() => nativeEvents.push(step("one")));
          yield* Effect.promise(() => nativeEvents.push(step("two")));
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.part.removed",
              properties: { sessionID: "root", messageID: "assistant", partID: "one" },
            }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.updated",
              properties: {
                sessionID: "root",
                info: {
                  id: "old-assistant",
                  role: "assistant",
                  time: { created: 1 },
                  parentID: "old-prompt",
                },
              },
            }),
          );
          yield* Effect.promise(() => nativeEvents.push(step("old", "old-assistant")));
        }
        if (ending === "unresolved")
          yield* Effect.promise(() => nativeEvents.push(step("unknown", "unknown-assistant")));
        if (ending === "reconnect") {
          yield* Effect.promise(() =>
            nativeEvents.push({ type: "server.connected", properties: {} }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({ type: "server.connected", properties: {} }),
          );
        }
        if (ending === "failed") {
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.error",
              properties: {
                sessionID: "root",
                error: { name: "UnknownError", data: { message: "failed" } },
              },
            }),
          );
        } else {
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.status",
              properties: { sessionID: "root", status: { type: "busy" } },
            }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.status",
              properties: { sessionID: "root", status: { type: "idle" } },
            }),
          );
        }
        const events = yield* Fiber.join(received);
        const completed = events.findLast((event) => event.type === "provider_turn.updated");
        assert.deepEqual(
          completed?.providerTurn.turnTokenUsage,
          ending === "unavailable"
            ? { usageStatus: "unavailable", usageScope: "main_agent", hasSubagents: false }
            : {
                usageStatus: ending === "completed" ? "complete" : "partial",
                usageScope: "main_agent",
                inputTokens: 34,
                cachedInputTokens: 6,
                cacheCreationTokens: 8,
                outputTokens: 14,
                reasoningTokens: 4,
                hasSubagents: false,
              },
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  // A reconnected event stream starts with a fresh server.connected; OpenCode
  // replays nothing that was sent meanwhile.
  it.effect.each(["settled", "asked"] as const)(
    "reconciles what OpenCode %s while the event stream was reconnecting",
    (gap) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
        let promptId = "";
        const gapPermission = {
          id: "per_gap",
          sessionID: "root",
          permission: "bash",
          patterns: ["rm -rf build"],
          always: [],
          metadata: {},
        };
        const harness = yield* makeOpenCodeRuntimeHarness(`reconnect-${gap}`, "root", {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async (input: { messageID: string }) => {
              promptId = input.messageID;
              return { data: true };
            },
            // Read a moment apart from the request list, so it may already say idle.
            status: async () => ({ data: {} }),
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
          permission: { list: async () => ({ data: gap === "asked" ? [gapPermission] : [] }) },
          question: { list: async () => ({ data: [] }) },
        });
        const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        yield* harness.runtime.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void collected.push(event))),
          Effect.forkScoped,
        );
        yield* push({ type: "server.connected", properties: {} });
        yield* harness.startTurn();
        yield* push({
          type: "message.updated",
          properties: {
            sessionID: "root",
            info: { id: promptId, role: "user", time: { created: 1 } },
          },
        });
        yield* push({
          type: "session.status",
          properties: { sessionID: "root", status: { type: "busy" } },
        });
        yield* push({ type: "server.connected", properties: {} });
        for (let turn = 0; turn < 5; turn += 1) yield* Effect.yieldNow;

        const nextTurn = yield* Effect.exit(harness.startTurn());
        const reconciled: {
          readonly terminal: ReadonlyArray<string>;
          readonly requests: ReadonlyArray<string>;
          readonly nextTurnAccepted: boolean;
        } = {
          terminal: collected.flatMap((event) =>
            event.type === "turn.terminal" ? [event.status] : [],
          ),
          requests: collected.flatMap((event) =>
            event.type === "runtime_request.updated"
              ? [
                  `${event.runtimeRequest.nativeRequestRef?.nativeId}:${event.runtimeRequest.status}`,
                ]
              : [],
          ),
          nextTurnAccepted: Exit.isSuccess(nextTurn),
        };
        assert.deepStrictEqual(
          reconciled,
          gap === "settled"
            ? { terminal: ["completed"], requests: [], nextTurnAccepted: true }
            : { terminal: [], requests: ["per_gap:pending"], nextTurnAccepted: false },
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect.each(["/compact", "auto-compaction"] as const)(
    "counts the tokens of OpenCode's own messages in a turn with %s",
    (compaction) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
        let promptId = "";
        const userMessage = (id: string) => ({
          type: "message.updated",
          properties: { sessionID: "root", info: { id, role: "user", time: { created: 1 } } },
        });
        const assistantMessage = (id: string, parentID: string) => ({
          type: "message.updated",
          properties: {
            sessionID: "root",
            info: { id, role: "assistant", time: { created: 1 }, parentID },
          },
        });
        const step = (messageID: string) => ({
          type: "message.part.updated",
          properties: {
            part: {
              type: "step-finish",
              id: `step:${messageID}`,
              sessionID: "root",
              messageID,
              reason: "stop",
              cost: 0.01,
              tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } },
            },
          },
        });
        // OpenCode writes its own compaction user message, then a summary
        // assistant under it.
        const compact = [
          userMessage("msg_compaction"),
          {
            type: "message.part.updated",
            properties: {
              part: {
                id: "prt_compaction",
                sessionID: "root",
                messageID: "msg_compaction",
                type: "compaction",
                auto: compaction === "auto-compaction",
              },
            },
          },
          assistantMessage("msg_summary", "msg_compaction"),
          step("msg_summary"),
          { type: "session.compacted", properties: { sessionID: "root" } },
        ];
        const harness = yield* makeOpenCodeRuntimeHarness(
          compaction === "/compact" ? "usage-manual-compaction" : "usage-auto-compaction",
          "root",
          {
            event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
            session: {
              create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
              promptAsync: async (input: { messageID: string }) => {
                promptId = input.messageID;
                return { data: true };
              },
              // The summary runs before OpenCode answers.
              summarize: async () => {
                for (const event of compact) await nativeEvents.push(event);
                return { data: true };
              },
              abort: async () => ({ data: true }),
              children: async () => ({ data: [] }),
            },
          },
        );
        const received = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        if (compaction === "/compact") {
          yield* harness.startTurn("/compact");
        } else {
          yield* harness.startTurn();
          yield* push(userMessage(promptId));
          yield* push(assistantMessage("msg_before", promptId));
          yield* push(step("msg_before"));
          for (const event of compact) yield* push(event);
          // The message OpenCode adds to carry on after the summary.
          yield* push(userMessage("msg_continue"));
          yield* push(assistantMessage("msg_after", "msg_continue"));
          yield* push(step("msg_after"));
          yield* push({
            type: "session.status",
            properties: { sessionID: "root", status: { type: "idle" } },
          });
        }
        const events = yield* Fiber.join(received);
        const steps = compaction === "/compact" ? 1 : 3;

        assert.deepEqual(
          events.findLast((event) => event.type === "provider_turn.updated")?.providerTurn
            .turnTokenUsage,
          {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 17 * steps,
            cachedInputTokens: 3 * steps,
            cacheCreationTokens: 4 * steps,
            outputTokens: 7 * steps,
            reasoningTokens: 2 * steps,
            hasSubagents: false,
          },
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect("preserves native multi-select and custom-answer flags through a live reply", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      let delivered: unknown;
      const harness = yield* makeOpenCodeRuntimeHarness("question-flags", "root", {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
        question: {
          reply: async (input: unknown) => {
            delivered = input;
            return { data: true };
          },
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "runtime_request.updated" ||
            (event.type === "turn_item.updated" && event.turnItem.type === "user_input_request"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "question.asked",
          properties: {
            id: "question",
            sessionID: "root",
            questions: [
              {
                header: "Drinks",
                question: "Which drinks?",
                multiple: true,
                custom: false,
                options: [
                  { label: "Tea", description: "Hot" },
                  { label: "Water", description: "Cold" },
                ],
              },
            ],
          },
        }),
      );
      const events = yield* Fiber.join(received);
      const item = events.find((event) => event.type === "turn_item.updated");
      const request = events.find((event) => event.type === "runtime_request.updated");
      assert.equal(item?.type, "turn_item.updated");
      if (
        item?.type !== "turn_item.updated" ||
        item.turnItem.type !== "user_input_request" ||
        request?.type !== "runtime_request.updated"
      )
        throw new Error("Native question missing");
      assert.equal(item.turnItem.questions[0]?.multiSelect, true);
      assert.equal(item.turnItem.questions[0]?.allowCustomAnswer, false);
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        answers: { "question-0-drinks": ["Tea", "Water"] },
      });
      assert.deepInclude(delivered, { answers: [["Tea", "Water"]] });
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect.each(["permission", "question"] as const)(
    "cancels an undelivered %s reply at its deadline",
    (kind) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const called = promiseGate<void>();
        let signal: AbortSignal | undefined;
        let deliver = false;
        const harness = yield* makeOpenCodeRuntimeHarness(`reply-${kind}`, "root", {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async () => ({ data: true }),
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
          [kind]: {
            reply: async (_input: unknown, options: { signal: AbortSignal }) => {
              if (deliver) return { data: true };
              signal = options.signal;
              called.resolve();
              return new Promise(() => {});
            },
          },
        });
        yield* harness.startTurn();
        const received = yield* harness.runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: `${kind}.asked`,
            properties:
              kind === "permission"
                ? {
                    id: "request",
                    sessionID: "root",
                    permission: "bash",
                    patterns: ["*"],
                    always: [],
                    metadata: {},
                  }
                : {
                    id: "request",
                    sessionID: "root",
                    questions: [
                      {
                        header: "Choice",
                        question: "Which?",
                        options: [{ label: "Yes", description: "Proceed" }],
                      },
                    ],
                  },
          }),
        );
        const request = (yield* Fiber.join(received))[0]!.runtimeRequest;
        const response = {
          requestId: request.id,
          ...(kind === "permission"
            ? { decision: "accept" as const }
            : { answers: { Choice: "Yes" } }),
        };
        const reply = yield* harness.runtime
          .respondToRuntimeRequest(response)
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.promise(() => called.promise);
        yield* TestClock.adjust("10 seconds");
        assert.isTrue(Exit.isFailure(yield* Fiber.join(reply)));
        assert.isTrue(signal?.aborted);
        deliver = true;
        yield* harness.runtime.respondToRuntimeRequest(response);
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect("aborts external root and descendants before closing the event stream", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const nativeEvents = asyncEventStream();
      const calls: string[] = [];
      yield* makeOpenCodeRuntimeHarness("release", "root", {
        event: {
          subscribe: async (_input: unknown, options: { signal: AbortSignal }) => {
            options.signal.addEventListener("abort", () => {
              calls.push("stream.close");
              nativeEvents.close();
            });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          abort: async ({ sessionID }: { sessionID: string }) => {
            calls.push(`abort:${sessionID}`);
            return { data: true };
          },
          children: async ({ sessionID }: { sessionID: string }) => {
            calls.push(`children:${sessionID}`);
            return { data: sessionID === "root" ? [{ id: "child" }] : [] };
          },
        },
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(calls, [
        "abort:root",
        "children:root",
        "abort:child",
        "children:child",
        "stream.close",
      ]);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect.each(["enumeration", "abort", "not-found", "timeout"] as const)(
    "reports descendant cleanup %s",
    (failure) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const called = promiseGate<void>();
        let childSignal: AbortSignal | undefined;
        const harness = yield* makeOpenCodeRuntimeHarness(`cleanup-${failure}`, "root", {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async () => ({ data: true }),
            get: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            messages: async () => ({ data: [] }),
            children: async ({ sessionID }: { sessionID: string }) => {
              if (failure === "enumeration") throw new Error("cannot enumerate");
              return { data: sessionID === "root" ? [{ id: "child" }] : [] };
            },
            abort: async (
              { sessionID }: { sessionID: string },
              options: { signal: AbortSignal },
            ) => {
              if (sessionID === "root") return { data: true };
              if (failure === "timeout" && childSignal?.aborted) return { data: true };
              childSignal = options.signal;
              called.resolve();
              if (failure === "timeout") {
                return new Promise(() => {});
              }
              if (failure === "not-found") throw { status: 404 };
              throw new Error("child abort failed");
            },
          },
        });
        yield* harness.startTurn();
        const snapshot = yield* harness.runtime.readThreadSnapshot({
          providerThread: harness.providerThread,
        });
        const stop = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: snapshot.providerTurns.at(-1)!.id,
          })
          .pipe(Effect.exit, Effect.forkScoped);
        if (failure === "timeout") {
          yield* Effect.promise(() => called.promise);
          yield* TestClock.adjust("15 seconds");
        }
        const result = yield* Fiber.join(stop);
        assert.equal(Exit.isSuccess(result), failure === "not-found");
        if (failure === "timeout") assert.isTrue(childSignal?.aborted);
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect(
    "preserves tool lifecycle, approval kinds, and late assistant text without cached tool payloads",
    () =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const nativeSessionId = "native-opencode-tool-lifecycle";
        const harness = yield* makeOpenCodeRuntimeHarness("tool-lifecycle", nativeSessionId, {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          session: {
            create: async () => ({
              data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
            }),
            promptAsync: async () => ({ data: true }),
          },
        });
        yield* harness.startTurn();
        const received = yield* harness.runtime.events.pipe(
          Stream.takeUntil(
            (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const states = [
          { status: "pending", input: { command: "pwd" }, raw: "" },
          {
            status: "running",
            input: { command: "pwd" },
            title: "Working directory",
            time: { start: 1 },
          },
          {
            status: "completed",
            input: { command: "pwd" },
            output: "/repo\n",
            title: "Working directory",
            metadata: {},
            time: { start: 1, end: 2 },
          },
          {
            status: "error",
            input: { command: "pwd" },
            error: "Command failed",
            time: { start: 3, end: 4 },
          },
        ] satisfies ReadonlyArray<ToolPart["state"]>;
        for (const state of states) {
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.part.updated",
              properties: {
                sessionID: nativeSessionId,
                part: {
                  id: state.status === "error" ? "part-failed" : "part-working",
                  sessionID: nativeSessionId,
                  messageID: "late-assistant",
                  type: "tool",
                  callID: state.status === "error" ? "call-failed" : "call-working",
                  tool: "bash",
                  state,
                },
              },
            }),
          );
        }
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: "part-exit",
                sessionID: nativeSessionId,
                messageID: "late-assistant",
                type: "tool",
                callID: "call-exit",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "vp test" },
                  output: "1 failed\n",
                  title: "Run tests",
                  metadata: { output: "1 failed\n", exit: 1, truncated: false },
                  time: { start: 4, end: 5 },
                },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: "part-read",
                sessionID: nativeSessionId,
                messageID: "late-assistant",
                type: "tool",
                callID: "call-read",
                tool: "read",
                state: { status: "pending", input: { filePath: "/outside/file" }, raw: "" },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "permission.asked",
            properties: {
              id: "read-permission",
              sessionID: nativeSessionId,
              permission: "external_directory",
              patterns: ["/outside/*"],
              always: [],
              metadata: {},
              tool: { messageID: "late-assistant", callID: "call-read" },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: "part-text",
                sessionID: nativeSessionId,
                messageID: "late-assistant",
                type: "text",
                text: "Tool results received",
                time: { start: 4 },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.updated",
            properties: {
              sessionID: nativeSessionId,
              info: {
                id: "late-assistant",
                sessionID: nativeSessionId,
                role: "assistant",
                time: { created: 1, completed: 4 },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "session.compacted",
            properties: { sessionID: nativeSessionId },
          }),
        );
        const events = yield* Fiber.join(received);
        const items = events.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        const commands = items.filter((item) => item.type === "command_execution");
        // No row while the part is pending: its input is still streaming.
        assert.deepEqual(
          commands.map((item) => item.status),
          ["running", "completed", "failed", "failed"],
        );
        assert.deepEqual(
          commands.map((item) => item.input),
          ["pwd", "pwd", "pwd", "vp test"],
        );
        assert.equal(commands[1]?.output, "/repo\n");
        assert.equal(commands[2]?.output, "Command failed");
        assert.equal(commands[3]?.exitCode, 1);
        assert.equal(
          events
            .flatMap((event) => (event.type === "node.updated" ? [event.node] : []))
            .findLast((node) => node.id === commands[3]?.nodeId)?.status,
          "failed",
        );
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.kind === "file-read",
          ),
        );
        const assistant = items.filter((item) => item.type === "assistant_message");
        assert.equal(assistant.at(-1)?.text, "Tool results received");
        assert.equal(assistant.at(-1)?.status, "completed");
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  // Event order from a live OpenCode 1.18.32 run of a `task` call with
  // background=true: the task part completes at launch, the root session
  // settles, and the child session stays busy until its own work ends.
  it.effect("reports a background task child as pending work after the root turn settles", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
      const root = "ses_root";
      const child = "ses_child";
      let promptId = "";
      const harness = yield* makeOpenCodeRuntimeHarness("background-child", root, {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
          get: async () => ({
            data: { id: child, parentID: root, permission: [], time: { created: 2, updated: 2 } },
          }),
          update: async () => ({ data: { id: child, parentID: root } }),
          promptAsync: async (input: { messageID: string }) => {
            promptId = input.messageID;
            return { data: true };
          },
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });
      const hasPendingBackgroundWork = harness.runtime.hasPendingBackgroundWork;
      if (hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("OpenCode runtime must expose hasPendingBackgroundWork.");
      }
      yield* harness.startTurn();
      const terminal = yield* harness.runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
        Effect.forkScoped,
      );
      const taskPart = (status: "running" | "completed") => ({
        type: "message.part.updated",
        properties: {
          sessionID: root,
          part: {
            id: "prt_task",
            sessionID: root,
            messageID: "msg_root_assistant",
            type: "tool",
            tool: "task",
            callID: "call_task",
            state: {
              status,
              input: {
                description: "Background sleep task",
                prompt: "sleep",
                subagent_type: "general",
              },
              title: "Background sleep task",
              metadata: { parentSessionId: root, sessionId: child, background: true },
              time: { start: 3, ...(status === "completed" ? { end: 3 } : {}) },
              ...(status === "completed" ? { output: "Background task started" } : {}),
            },
          },
        },
      });
      const status = (sessionID: string, type: "busy" | "idle") => ({
        type: "session.status",
        properties: { sessionID, status: { type } },
      });

      yield* push({
        type: "message.updated",
        properties: {
          sessionID: root,
          info: { id: promptId, sessionID: root, role: "user", time: { created: 1 } },
        },
      });
      yield* push(status(root, "busy"));
      yield* push(taskPart("running"));
      yield* push({
        type: "session.created",
        properties: {
          sessionID: child,
          info: { id: child, parentID: root, time: { created: 2, updated: 2 } },
        },
      });
      yield* push(status(child, "busy"));
      yield* push(taskPart("completed"));
      yield* push(status(root, "idle"));
      assert.equal(Option.getOrUndefined(yield* Fiber.join(terminal))?.status, "completed");
      assert.isTrue(yield* hasPendingBackgroundWork, "the running child must pin idle release");

      yield* push(status(child, "idle"));
      yield* push({ type: "session.idle", properties: { sessionID: child } });
      assert.isFalse(yield* hasPendingBackgroundWork, "an idle child must not pin idle release");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("surfaces a background child's approval asked after the root turn settled", () =>
    Effect.gen(function* () {
      const background = yield* makeBackgroundChildHarness("background-ask-after-root");
      yield* background.launchChild;
      yield* background.push(background.status(background.root, "idle"));
      yield* background.push(background.childAsksForBash);
      // Lets any routing retries run out.
      yield* TestClock.adjust("10 seconds");
      yield* background.answerPending;

      assert.deepStrictEqual(
        { requests: yield* background.requestUpdates, repliedToOpenCode: background.replies },
        {
          requests: [{ status: "pending", thread: "child" }],
          repliedToOpenCode: [background.permissionId],
        },
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("keeps a background child's waiting approval answerable after its root settles", () =>
    Effect.gen(function* () {
      const background = yield* makeBackgroundChildHarness("background-ask-before-root");
      yield* background.launchChild;
      yield* background.push(background.childAsksForBash);
      yield* background.push(background.status(background.root, "idle"));
      yield* background.answerPending;

      assert.deepStrictEqual(
        { requests: yield* background.requestUpdates, repliedToOpenCode: background.replies },
        {
          requests: [
            { status: "pending", thread: "root" },
            { status: "cancelled", thread: "root" },
            { status: "pending", thread: "child" },
          ],
          repliedToOpenCode: [background.permissionId],
        },
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("projects OpenCode read output and search titles from native tool calls", () =>
    Effect.gen(function* () {
      const directoryOutput =
        "<path>/workspace/src</path>\n<type>directory</type>\n<entries>\nenv.ts\nlib/\n\n(2 entries)\n</entries>";
      const fileOutput =
        "<path>/workspace/src/env.ts</path>\n<type>file</type>\n<content>\n1: hello\n2: </content> literal\n3: world\n</content>";
      const fileWithInstructions =
        "<path>/workspace/src/env.ts</path>\n<type>file</type>\n<content>1: hello\n\n(End of file - total 1 lines)\n</content>\n\n<system-reminder>\nProject instructions\n</system-reminder>";
      const missingPath = directoryOutput.slice(directoryOutput.indexOf("<type>"));
      const missingClose = fileOutput.slice(0, fileOutput.lastIndexOf("\n</content>"));
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-search";
      const harness = yield* makeOpenCodeRuntimeHarness("search-projection", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        mcp: { status: async () => ({ data: {} }) },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async () => ({ data: true }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const toolCalls = [
        ["read", { filePath: "src/env.ts" }, "---\nfile body"],
        ["read", { filePath: "/workspace/src" }, directoryOutput],
        ["read", { filePath: "/workspace/src/env.ts" }, fileOutput],
        ["read", { filePath: "/workspace/src/env.ts" }, fileWithInstructions],
        ["read", { filePath: "/workspace/src" }, missingPath],
        ["read", { filePath: "/workspace/src/env.ts" }, missingClose],
        ["custom_read", { filePath: "/workspace/src" }, directoryOutput],
        ["grep", { pattern: "TODO", path: "apps/web" }, "---\nfile body"],
        ["websearch", { query: "OpenCode documentation" }, "---\nfile body"],
        ["glob", { pattern: "missing", path: "apps/web" }, ""],
        ["codesearch", {}, " \n\t"],
      ] as const;
      for (const [index, [tool, input, output]] of toolCalls.entries()) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: `part-${index}`,
                sessionID: nativeSessionId,
                messageID: "assistant-search",
                type: "tool",
                callID: `call-${index}`,
                tool,
                state: {
                  status: "completed",
                  input,
                  output,
                  title: tool,
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        );
      }
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.compacted",
          properties: { sessionID: nativeSessionId },
        }),
      );
      const items = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const reads = items.filter((item) => item.type === "dynamic_tool");
      assert.equal(reads[0]?.title, "Read src/env.ts");
      assert.deepEqual(
        reads.map((item) => ({ toolName: item.toolName, output: item.output })),
        [
          { toolName: "read", output: "---\nfile body" },
          { toolName: "read", output: "env.ts\nlib/\n\n(2 entries)" },
          { toolName: "read", output: "1: hello\n2: </content> literal\n3: world" },
          {
            toolName: "read",
            output:
              "1: hello\n\n(End of file - total 1 lines)\n\n<system-reminder>\nProject instructions\n</system-reminder>",
          },
          { toolName: "read", output: missingPath },
          { toolName: "read", output: missingClose },
          { toolName: "custom_read", output: directoryOutput },
        ],
      );
      const grep = items.find((item) => item.type === "file_search");
      assert.equal(grep?.title, "Searched TODO in web");
      assert.equal(grep?.type === "file_search" ? grep.pattern : null, "TODO");
      assert.deepEqual(grep?.type === "file_search" ? grep.results : null, [
        { fileName: "apps/web", preview: "---\nfile body" },
      ]);
      const webSearch = items.find((item) => item.type === "web_search");
      assert.deepEqual(webSearch?.type === "web_search" ? webSearch.patterns : null, [
        "OpenCode documentation",
      ]);
      assert.deepEqual(webSearch?.type === "web_search" ? webSearch.results : null, [
        { snippet: "---\nfile body" },
      ]);
      const emptyFileSearch = items.find(
        (item) => item.type === "file_search" && item.pattern === "missing",
      );
      assert.ok(emptyFileSearch?.type === "file_search");
      assert.equal(emptyFileSearch.results, undefined);
      const emptyWebSearch = items.find(
        (item) => item.type === "web_search" && item.patterns === undefined,
      );
      assert.ok(emptyWebSearch?.type === "web_search");
      assert.equal(emptyWebSearch.results, undefined);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("drops cancelled OpenCode todos so a finished list completes", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-todos";
      const harness = yield* makeOpenCodeRuntimeHarness("todos", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        mcp: { status: async () => ({ data: {} }) },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async () => ({ data: true }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "plan.updated"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "todo.updated",
          properties: {
            sessionID: nativeSessionId,
            todos: [
              { content: "Write the fix", status: "completed", priority: "high" },
              { content: "Try another approach", status: "cancelled", priority: "low" },
              { content: "Add a test", status: "completed", priority: "medium" },
            ],
          },
        }),
      );
      const plan = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "plan.updated" ? [event.plan] : [],
      )[0];
      assert.ok(plan?.kind === "todo_list");
      assert.deepEqual(
        plan.steps.map((step) => ({ text: step.text, status: step.status })),
        [
          { text: "Write the fix", status: "completed" },
          { text: "Add a test", status: "completed" },
        ],
      );
      assert.equal(plan.status, "completed");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("presents OpenCode MCP calls without treating remote tools as local edits", () =>
    Effect.gen(function* () {
      const output =
        "<path>/workspace/src</path>\n<type>directory</type>\n<entries>\nenv.ts\nlib/\n\n(2 entries)\n</entries>";
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-mcp";
      let statusReads = 0;
      const harness = yield* makeOpenCodeRuntimeHarness("mcp-presentation", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: nativeSessionId, time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
        },
        mcp: {
          status: async () => {
            statusReads++;
            return {
              data: {
                "my.server_with_underscores": { status: "connected" },
                ambiguous: { status: "connected" },
                ambiguous_server: { status: "connected" },
                code: { status: "connected" },
                apply: { status: "connected" },
              },
            };
          },
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      for (const status of ["running", "completed", "error"] as const) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: "mcp-part",
                sessionID: nativeSessionId,
                messageID: "mcp-assistant",
                type: "tool",
                callID: "mcp-call",
                tool: "my_server_with_underscores_edit_document",
                state: {
                  status,
                  input: { document: "remote-doc" },
                  title: "Edit remote document",
                  metadata: {},
                  output,
                  error: "failed",
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        );
      }
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.part.updated",
          properties: {
            sessionID: nativeSessionId,
            part: {
              id: "ambiguous-part",
              sessionID: nativeSessionId,
              messageID: "mcp-assistant",
              type: "tool",
              callID: "ambiguous-call",
              tool: "ambiguous_server_edit_document",
              state: {
                status: "completed",
                input: {},
                title: "Ambiguous tool",
                metadata: {},
                output: "",
                time: { start: 1, end: 2 },
              },
            },
          },
        }),
      );
      for (const tool of ["code_search", "apply_patch"]) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: `native-${tool}`,
                sessionID: nativeSessionId,
                messageID: "mcp-assistant",
                type: "tool",
                callID: `native-${tool}`,
                tool,
                state: {
                  status: "completed",
                  input: { query: "needle", filePath: "local.ts" },
                  title: `Native ${tool}`,
                  metadata: {},
                  output: "done",
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        );
      }
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.compacted",
          properties: { sessionID: nativeSessionId },
        }),
      );
      const allItems = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      assert.equal(
        allItems.find((item) => item.title === "Native code_search")?.type,
        "web_search",
      );
      assert.equal(
        allItems.find((item) => item.title === "Native apply_patch")?.type,
        "file_change",
      );
      const items = allItems.filter((item) => item.type === "dynamic_tool");
      assert.deepEqual(
        items.slice(0, 3).map((item) => item.status),
        ["running", "completed", "failed"],
      );
      assert.deepEqual(
        items.slice(0, 3).map((item) => item.title),
        ["Edit remote document", "Edit remote document", "edit document"],
      );
      for (const item of items.slice(0, 3)) {
        assert.deepEqual(item.toolSource, {
          key: "mcp:my.server_with_underscores",
          name: "my.server with underscores",
          kind: "integration",
        });
        assert.deepEqual(item.input, { document: "remote-doc" });
      }
      assert.equal(items[1]?.output, output);
      assert.equal(items[3]?.toolName, "ambiguous_server_edit_document");
      assert.isUndefined(items[3]?.toolSource);
      assert.equal(statusReads, 1);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect.each(["failure", "timeout"] as const)("retries MCP status after %s", (failure) =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const called = promiseGate<void>();
      const sessionId = `mcp-status-${failure}`;
      let statusReads = 0;
      let signal: AbortSignal | undefined;
      const harness = yield* makeOpenCodeRuntimeHarness(sessionId, sessionId, {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
        },
        mcp: {
          status: async (_input: unknown, options: { signal?: AbortSignal }) => {
            statusReads++;
            if (statusReads === 1) {
              signal = options?.signal;
              called.resolve();
              if (failure === "timeout") return new Promise(() => {});
              throw new Error("MCP status unavailable");
            }
            return { data: { weather: { status: "connected" } } };
          },
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      for (const status of ["running", "completed"] as const) {
        const emitted = yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: sessionId,
              part: {
                id: "weather-part",
                sessionID: sessionId,
                messageID: "weather-message",
                type: "tool",
                callID: "weather-call",
                tool: "weather_edit_document",
                state: {
                  status,
                  input: { document: "remote-doc" },
                  title: "Edit remote document",
                  metadata: {},
                  output: "saved",
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        ).pipe(Effect.forkScoped);
        if (status === "running" && failure === "timeout") {
          yield* Effect.promise(() => called.promise);
          yield* TestClock.adjust("1 second");
        }
        yield* Fiber.join(emitted);
      }
      yield* Effect.promise(() =>
        nativeEvents.push({ type: "session.compacted", properties: { sessionID: sessionId } }),
      );
      const completed = (yield* Fiber.join(received)).find(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed",
      );
      assert.equal(statusReads, 2);
      assert.equal(
        completed?.type === "turn_item.updated" && completed.turnItem.title,
        "Edit remote document",
      );
      assert.deepEqual(completed?.type === "turn_item.updated" && completed.turnItem.toolSource, {
        key: "mcp:weather",
        name: "weather",
        kind: "integration",
      });
      if (failure === "timeout") assert.isTrue(signal?.aborted);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("admits a native command on its user receipt before generation completes", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const release = promiseGate<void>();
      const calls = yield* Queue.unbounded<{
        messageID: string;
        command: string;
        arguments: string;
        model: string;
      }>();
      let promptCalls = 0;
      const sessionId = "native-command";
      const harness = yield* makeOpenCodeRuntimeHarness("native-command", sessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        command: { list: async () => ({ data: [{ name: "git/review" }] }) },
        session: {
          create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
          command: async (input: {
            messageID: string;
            command: string;
            arguments: string;
            model: string;
          }) => {
            Queue.offerUnsafe(calls, input);
            await release.promise;
            return { data: true };
          },
          promptAsync: async () => {
            promptCalls++;
            return { data: true };
          },
        },
      });
      const start = yield* harness.startTurn("/git/review staged changes").pipe(Effect.forkScoped);
      const call = yield* Queue.take(calls);
      assert.equal(call.command, "git/review");
      assert.equal(call.arguments, "staged changes");
      assert.equal(call.model, "anthropic/claude-sonnet");
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: sessionId,
            info: {
              id: call.messageID,
              sessionID: sessionId,
              role: "user",
              time: { created: DateTime.toEpochMillis(harness.now) },
            },
          },
        }),
      );
      yield* Fiber.join(start);
      assert.equal(promptCalls, 0);
      release.resolve();
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("sends unadvertised slash commands as ordinary prompts", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const prompts: unknown[] = [];
      const harness = yield* makeOpenCodeRuntimeHarness("unknown-command", "unknown-command", {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        command: { list: async () => ({ data: [{ name: "review" }] }) },
        session: {
          create: async () => ({
            data: { id: "unknown-command", time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (input: { parts: unknown }) => {
            prompts.push(input.parts);
            return { data: true };
          },
        },
      });
      yield* harness.startTurn("/unknown words");
      assert.deepEqual(prompts, [[{ type: "text", text: "/unknown words" }]]);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("compacts with the native summarize API and emits a completed compaction", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const summarizeCalls: Array<unknown> = [];
      let promptCalls = 0;
      const harness = yield* makeOpenCodeRuntimeHarness("compact", "native-opencode-compact", {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: "native-opencode-compact", time: { created: 1, updated: 1 } },
          }),
          summarize: async (input: unknown) => {
            summarizeCalls.push(input);
            return { data: true };
          },
          promptAsync: async () => {
            promptCalls += 1;
            return { data: true };
          },
        },
      });
      yield* harness.startTurn("/compact");
      const events = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      assert.deepEqual(summarizeCalls, [
        {
          sessionID: "native-opencode-compact",
          providerID: "anthropic",
          modelID: "claude-sonnet",
          auto: false,
        },
      ]);
      assert.equal(promptCalls, 0);
      assert.equal(
        events.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "compaction" &&
            event.turnItem.status === "completed",
        ).length,
        1,
      );
      assert.isTrue(
        events.some((event) => event.type === "turn.terminal" && event.status === "completed"),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("ends a turn on the provider thread it started on", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const harness = yield* makeOpenCodeRuntimeHarness(
        "forked-row",
        "native-opencode-forked-row",
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          session: {
            create: async () => ({
              data: { id: "native-opencode-forked-row", time: { created: 1, updated: 1 } },
            }),
            summarize: async () => ({ data: true }),
          },
        },
      );
      const forkedRow = {
        ...harness.providerThread,
        id: ProviderThreadId.make("provider-thread:opencode-test:forked-run-row"),
      };
      yield* harness.startTurn("/compact", forkedRow);
      const terminal = yield* harness.runtime.events.pipe(
        Stream.filter(
          (event): event is Extract<typeof event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        ),
        Stream.runHead,
      );
      assert.equal(Option.getOrUndefined(terminal)?.providerThreadId, forkedRow.id);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("does not restore messages beyond OpenCode's persisted revert boundary", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-reverted-snapshot";
      const messages = [
        {
          info: {
            id: "user-kept",
            sessionID: nativeSessionId,
            role: "user",
            time: { created: 1 },
          },
          parts: [{ type: "text", text: "keep this prompt" }],
        },
        {
          info: {
            id: "assistant-kept",
            sessionID: nativeSessionId,
            role: "assistant",
            time: { created: 2, completed: 3 },
          },
          parts: [{ type: "text", text: "keep this answer" }],
        },
        {
          info: {
            id: "user-reverted",
            sessionID: nativeSessionId,
            role: "user",
            time: { created: 4 },
          },
          parts: [{ type: "text", text: "remove this prompt" }],
        },
        {
          info: {
            id: "assistant-reverted",
            sessionID: nativeSessionId,
            role: "assistant",
            time: { created: 5, completed: 6 },
          },
          parts: [{ type: "text", text: "remove this answer" }],
        },
      ];
      const harness = yield* makeOpenCodeRuntimeHarness("reverted-snapshot", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), {
              once: true,
            });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: {
              id: nativeSessionId,
              time: { created: 1, updated: 6 },
              revert: { messageID: "user-reverted" },
            },
          }),
          messages: async () => ({ data: messages }),
        },
      });

      const snapshot = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });

      assert.deepEqual(
        snapshot.messages.map((message) => message.text),
        ["keep this prompt", "keep this answer"],
      );
      const providerPayload = snapshot.providerPayload as ReadonlyArray<{
        readonly info: { readonly id: string };
      }>;
      assert.deepEqual(
        providerPayload.map((entry) => entry.info.id),
        ["user-kept", "assistant-kept"],
      );
      assert.equal(snapshot.providerThread.nativeConversationHeadRef?.nativeId, "user-kept");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("steers with the turn's agent, reasoning variant and system instructions", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const promptInputs: Array<{ agent?: string; variant?: string; system?: string }> = [];
      const harness = yield* makeOpenCodeRuntimeHarness(
        "steer-agent",
        "root",
        {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            get: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            messages: async () => ({ data: [] }),
            promptAsync: async (input: { agent?: string; variant?: string; system?: string }) => {
              promptInputs.push(input);
              return { data: true };
            },
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
        },
        {},
        {
          options: [
            { id: "variant", value: "high" },
            { id: "agent", value: "build" },
          ],
        },
      );
      yield* harness.startTurn();
      const snapshot = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: harness.runId,
        providerThread: harness.providerThread,
        providerTurnId: snapshot.providerTurns.at(-1)!.id,
        message: {
          messageId: MessageId.make("message-opencode-steer-agent"),
          text: "also cover the README",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });

      const [start, steer] = promptInputs;
      assert.equal(start?.agent, "build");
      assert.equal(start?.variant, "high");
      assert.include(start?.system ?? "", "OpenCode");
      assert.deepEqual(
        { agent: steer?.agent, variant: steer?.variant, system: steer?.system },
        { agent: start?.agent, variant: start?.variant, system: start?.system },
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("keeps a newly admitted prompt alive across stale idle and delayed busy evidence", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const prompt = promiseGate<void>();
      const promptStarted = promiseGate<void>();
      const steerPrompt = promiseGate<void>();
      const steerPromptStarted = promiseGate<void>();
      const stopPromptStarted = promiseGate<void>();
      const statusCalled = promiseGate<void>();
      const steerStatusCalled = promiseGate<void>();
      const abortCalled = promiseGate<void>();
      let status: "idle" | "busy" = "busy";
      let promptCalls = 0;
      let statusCalls = 0;
      const promptInputs: Array<{ readonly messageID?: string }> = [];
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: "native-opencode-race", time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: { id: "native-opencode-race", time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (
            input: { readonly messageID?: string },
            options?: { readonly signal?: AbortSignal },
          ) => {
            promptInputs.push(input);
            promptCalls += 1;
            if (promptCalls === 1) {
              promptStarted.resolve();
              await prompt.promise;
            } else if (promptCalls === 2) {
              steerPromptStarted.resolve();
              await steerPrompt.promise;
            } else {
              stopPromptStarted.resolve();
              await new Promise<void>((_resolve, reject) =>
                options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
                  once: true,
                }),
              );
            }
            return { data: true };
          },
          status: async () => ({
            data: (() => {
              statusCalls += 1;
              if (statusCalls === 1) statusCalled.resolve();
              else steerStatusCalled.resolve();
              return { "native-opencode-race": { type: status } };
            })(),
          }),
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          abort: async () => {
            abortCalled.resolve();
            return { data: true };
          },
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId: ProviderInstanceId.make("opencode-test"),
        settings: OPEN_CODE_TEST_SETTINGS,
        environment: {},
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
          connectToOpenCodeServer: () =>
            Effect.succeed({ url: "http://test.invalid", external: true }),
          createOpenCodeSdkClient: () => client,
        } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
        Effect.provideService(ProviderHost.ProviderHost, {
          paths: { cwd: "/workspace" },
          resolveAttachmentPath: () => null,
        } as unknown as ProviderHost.ProviderHost["Service"]),
      );
      const threadId = ThreadId.make("thread-opencode-admission-race");
      const providerSessionId = ProviderSessionId.make("session-opencode-admission-race");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode-test"),
        model: "anthropic/claude-sonnet",
        options: [],
      };
      const policy = runtimePolicy("full-access", { cwd: "/workspace" });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const now = yield* DateTime.now;
      const attemptId = RunAttemptId.make("attempt-opencode-admission-race");
      const runId = RunId.make("run-opencode-admission-race");
      const start = yield* runtime
        .startTurn({
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project-opencode-admission-race"),
            title: "race",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId,
          rootNodeId: NodeId.make("node-opencode-admission-race"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-opencode-admission-race"),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy: policy,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.promise(() => promptStarted.promise);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      prompt.resolve();
      yield* Fiber.join(start);
      assert.match(promptInputs[0]?.messageID ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{28}$/);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "busy" } },
        }),
      );
      status = "busy";
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: "stale-user-message",
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );
      assert.equal(statusCalls, 0, "an unrelated user message must not release prompt admission");
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: promptInputs[0]!.messageID!,
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );

      yield* Effect.promise(() => statusCalled.promise);

      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(snapshot.providerTurns.at(-1)?.status, "running");
      const activeTurn = snapshot.providerTurns.at(-1)!;
      const steer = yield* runtime
        .steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make("message-opencode-steer-race"),
            text: "follow up",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => steerPromptStarted.promise);
      assert.notEqual(promptInputs[1]?.messageID, promptInputs[0]?.messageID);
      steerPrompt.resolve();
      yield* Fiber.join(steer);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "busy" } },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: promptInputs[0]!.messageID!,
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: promptInputs[1]!.messageID!,
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );
      yield* Effect.promise(() => steerStatusCalled.promise);
      const pendingSteer = yield* runtime
        .steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make("message-opencode-stop-pending"),
            text: "pending when stopped",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => stopPromptStarted.promise);
      const interrupt = yield* runtime
        .interruptTurn({ providerThread, providerTurnId: activeTurn.id })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => abortCalled.promise);
      yield* Fiber.join(interrupt);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(pendingSteer)));
      const promptWhileStopping = yield* Effect.exit(
        runtime.steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make("message-opencode-after-stop"),
            text: "must not pass the pending stop",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        }),
      );
      assert.isTrue(Exit.isFailure(promptWhileStopping));
      assert.equal(promptCalls, 3);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      const interrupted = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(interrupted.providerTurns.at(-1)?.status, "interrupted");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("rejects steering when stop wins the extracted-text lookup", () =>
    Effect.gen(function* () {
      const events = asyncEventStream();
      const lookup = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let prompts = 0;
      const harness = yield* makeOpenCodeRuntimeHarness(
        "extraction-stop",
        "root",
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => events.close(), { once: true });
              return { stream: events.stream };
            },
          },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            get: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async () => {
              prompts++;
              return { data: true };
            },
            status: async () => ({ data: { root: { type: "busy" } } }),
            messages: async () => ({ data: [] }),
            children: async () => ({ data: [] }),
            abort: async () => ({ data: true }),
          },
          mcp: { add: async () => ({ data: true }) },
        },
        {
          resolveAttachmentPath: () => "/workspace/report.docx",
          resolveExtractedTextPath: () =>
            Deferred.succeed(lookup, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as("/workspace/report.docx.txt"),
            ),
        },
      );
      yield* harness.startTurn();
      const snapshot = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      const turn = snapshot.providerTurns.at(-1)!;
      const steer = yield* harness.runtime
        .steerTurn({
          threadId: harness.threadId,
          runId: harness.runId,
          providerThread: harness.providerThread,
          providerTurnId: turn.id,
          message: {
            messageId: MessageId.make("steer-extraction-stop"),
            text: "read this",
            createdBy: "user",
            creationSource: "web",
            attachments: [
              {
                type: "file",
                id: "report-docx",
                name: "report.docx",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                sizeBytes: 1,
              },
            ],
          },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(lookup);
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: turn.id,
      });
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(steer)));
      assert.equal(prompts, 1);
      yield* Effect.promise(() =>
        events.push({
          type: "session.status",
          properties: { sessionID: "root", status: { type: "idle" } },
        }),
      );
      const stopped = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      assert.equal(stopped.providerTurns.at(-1)?.status, "interrupted");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("interrupts an initial prompt while its SDK request is pending", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const promptStarted = promiseGate<void>();
      const abortCalled = promiseGate<void>();
      let abortCalls = 0;
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: "native-opencode-initial-stop", time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: { id: "native-opencode-initial-stop", time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (_input: unknown, options?: { readonly signal?: AbortSignal }) => {
            promptStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              const signal = options?.signal;
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
            return { data: true };
          },
          status: async () => ({
            data: { "native-opencode-initial-stop": { type: "idle" as const } },
          }),
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          abort: async () => {
            abortCalls += 1;
            abortCalled.resolve();
            return { data: true };
          },
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId: ProviderInstanceId.make("opencode-initial-stop-test"),
        settings: OPEN_CODE_TEST_SETTINGS,
        environment: {},
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
          connectToOpenCodeServer: () =>
            Effect.succeed({ url: "http://test.invalid", external: true }),
          createOpenCodeSdkClient: () => client,
        } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
        Effect.provideService(ProviderHost.ProviderHost, {
          paths: { cwd: "/workspace" },
          resolveAttachmentPath: () => null,
        } as unknown as ProviderHost.ProviderHost["Service"]),
      );
      const threadId = ThreadId.make("thread-opencode-initial-stop");
      const providerSessionId = ProviderSessionId.make("session-opencode-initial-stop");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode-initial-stop-test"),
        model: "anthropic/claude-sonnet",
        options: [],
      };
      const policy = runtimePolicy("full-access", { cwd: "/workspace" });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const terminalEvents = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      const start = yield* runtime
        .startTurn({
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project-opencode-initial-stop"),
            title: "initial stop",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-opencode-initial-stop"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-opencode-initial-stop"),
          rootNodeId: NodeId.make("node-opencode-initial-stop"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-opencode-initial-stop"),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy: policy,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.promise(() => promptStarted.promise);
      const running = yield* runtime.readThreadSnapshot({ providerThread });
      const activeTurn = running.providerTurns.at(-1)!;
      const interrupt = yield* runtime
        .interruptTurn({ providerThread, providerTurnId: activeTurn.id })
        .pipe(Effect.forkScoped);

      yield* Effect.promise(() => abortCalled.promise);
      yield* Fiber.join(start);
      yield* Fiber.join(interrupt);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: {
            sessionID: "native-opencode-initial-stop",
            status: { type: "idle" },
          },
        }),
      );

      const events = Array.from(yield* Fiber.join(terminalEvents));
      const terminals = events.filter((event) => event.type === "turn.terminal");
      assert.equal(abortCalls, 1);
      assert.lengthOf(terminals, 1);
      assert.equal(terminals[0]?.status, "interrupted");
      assert.isNull(terminals[0]?.failure ?? null);
      assert.isFalse(
        events.some(
          (event) =>
            (event.type === "turn.terminal" && event.status === "failed") ||
            (event.type === "provider_session.updated" && event.providerSession.status === "error"),
        ),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("fails an active turn when the OpenCode event stream ends cleanly", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const harness = yield* makeOpenCodeRuntimeHarness(
        "clean-event-eof",
        "native-opencode-clean-event-eof",
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          session: {
            create: async () => ({
              data: { id: "native-opencode-clean-event-eof", time: { created: 1, updated: 1 } },
            }),
            promptAsync: async () => ({ data: true }),
          },
        },
      );
      yield* harness.startTurn();
      const terminalEvents = yield* harness.runtime.events.pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );

      nativeEvents.close();
      const received = Array.from(yield* Fiber.join(terminalEvents));
      assert.isTrue(
        received.some(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "error",
        ),
      );
      const terminal = received.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.status, "failed");
      assert.equal(terminal?.failure?.class, "transport_error");
      assert.equal(terminal?.threadDisposition, "broken");
      assert.equal((yield* Effect.exit(harness.startTurn()))._tag, "Failure");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("keeps a running turn across event stream drops that each reconnect", () =>
    Effect.gen(function* () {
      const network = openCodeEventNetwork();
      const harness = yield* makeOpenCodeRuntimeHarness(
        "event-stream-drops",
        "native-opencode-event-stream-drops",
        {
          event: { subscribe: network.client.event.subscribe.bind(network.client.event) },
          session: {
            create: async () => ({
              data: { id: "native-opencode-event-stream-drops", time: { created: 1, updated: 1 } },
            }),
            promptAsync: async () => ({ data: true }),
            status: async () => ({
              data: { "native-opencode-event-stream-drops": { type: "busy" } },
            }),
          },
          permission: { list: async () => ({ data: [] }) },
          question: { list: async () => ({ data: [] }) },
        },
      );
      const received: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      yield* harness.runtime.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => received.push(event))),
        Effect.forkScoped,
      );
      yield* harness.startTurn();
      yield* Effect.promise(() => network.connected(1));

      // More drops than the reconnect bound allows in a row: each one reconnects.
      for (let drop = 1; drop <= 8; drop++) {
        network.drop();
        for (let second = 0; second < 600 && network.connections === drop; second++) {
          yield* TestClock.adjust("1 second");
        }
      }

      assert.deepStrictEqual(
        {
          connections: network.connections,
          events: received.flatMap((event) =>
            event.type === "turn.terminal" ||
            (event.type === "provider_session.updated" && event.providerSession.status === "error")
              ? [event.type]
              : [],
          ),
        },
        { connections: 9, events: [] },
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect(
    "fails a running turn once the event stream of a vanished server cannot reconnect",
    () =>
      Effect.gen(function* () {
        const network = openCodeEventNetwork();
        const harness = yield* makeOpenCodeRuntimeHarness(
          "vanished-server",
          "native-opencode-vanished-server",
          {
            event: { subscribe: network.client.event.subscribe.bind(network.client.event) },
            session: {
              create: async () => ({
                data: { id: "native-opencode-vanished-server", time: { created: 1, updated: 1 } },
              }),
              promptAsync: async () => ({ data: true }),
            },
          },
        );
        const received: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const ended = yield* Deferred.make<void>();
        yield* harness.runtime.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          Effect.andThen(Deferred.succeed(ended, undefined)),
          Effect.forkScoped,
        );
        yield* harness.startTurn();
        yield* Effect.promise(() => network.connected(1));
        network.goAway();

        for (let second = 0; second < 600 && !(yield* Deferred.isDone(ended)); second++) {
          yield* TestClock.adjust("1 second");
        }

        const terminal = received.find((event) => event.type === "turn.terminal");
        assert.deepStrictEqual(
          {
            terminal:
              terminal?.type === "turn.terminal"
                ? {
                    status: terminal.status,
                    failure: terminal.failure?.class ?? null,
                    threadDisposition: terminal.threadDisposition,
                  }
                : null,
            sessionError: received.some(
              (event) =>
                event.type === "provider_session.updated" &&
                event.providerSession.status === "error",
            ),
            reconnectAttempted: network.requests > 1,
          },
          {
            terminal: { status: "failed", failure: "transport_error", threadDisposition: "broken" },
            sessionError: true,
            reconnectAttempted: true,
          },
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect("fails compaction when its response races stream termination", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const summarizeStarted = promiseGate<void>();
      const summarizeResult = promiseGate<{ data: boolean }>();
      const baseClock = yield* Clock.Clock;
      const eofClockRead = yield* Deferred.make<void>();
      const releaseEofClockRead = yield* Deferred.make<void>();
      let blockNextClockRead = false;
      const blockingClock: Clock.Clock = {
        ...baseClock,
        currentTimeMillis: Effect.suspend(() => {
          if (!blockNextClockRead) return baseClock.currentTimeMillis;
          blockNextClockRead = false;
          return Deferred.succeed(eofClockRead, undefined).pipe(
            Effect.andThen(Deferred.await(releaseEofClockRead)),
            Effect.andThen(baseClock.currentTimeMillis),
          );
        }),
      };
      const harness = yield* makeOpenCodeRuntimeHarness(
        "compaction-eof-race",
        "native-opencode-compaction-eof-race",
        {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({
              data: { id: "native-opencode-compaction-eof-race", time: { created: 1, updated: 1 } },
            }),
            summarize: () => {
              summarizeStarted.resolve();
              return summarizeResult.promise;
            },
          },
        },
      ).pipe(Effect.provideService(Clock.Clock, blockingClock));
      const events = yield* harness.runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
      const start = yield* harness.startTurn("/compact").pipe(Effect.forkScoped);
      yield* Effect.promise(() => summarizeStarted.promise);
      blockNextClockRead = true;
      nativeEvents.close();
      yield* Deferred.await(eofClockRead);
      summarizeResult.resolve({ data: true });
      yield* Fiber.join(start);
      yield* Deferred.succeed(releaseEofClockRead, undefined);
      const received = Array.from(yield* Fiber.join(events));
      const terminals = received.filter((event) => event.type === "turn.terminal");
      assert.lengthOf(terminals, 1);
      assert.equal(terminals[0]?.status, "failed");
      assert.equal(terminals[0]?.failure?.class, "transport_error");
      assert.isFalse(
        received.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "compaction" &&
            event.turnItem.status === "completed",
        ),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("does not register a turn after the OpenCode event stream ends", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      let promptCalls = 0;
      const harness = yield* makeOpenCodeRuntimeHarness(
        "event-eof-start-race",
        "native-opencode-event-eof-start-race",
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          session: {
            create: async () => ({
              data: {
                id: "native-opencode-event-eof-start-race",
                time: { created: 1, updated: 1 },
              },
            }),
            promptAsync: async () => {
              promptCalls += 1;
              return { data: true };
            },
          },
        },
      );
      const baseClock = yield* Clock.Clock;
      const startClockRead = yield* Deferred.make<void>();
      const releaseStartClockRead = yield* Deferred.make<void>();
      let blockNextClockRead = true;
      const blockingClock: Clock.Clock = {
        ...baseClock,
        currentTimeMillis: Effect.suspend(() => {
          if (!blockNextClockRead) return baseClock.currentTimeMillis;
          blockNextClockRead = false;
          return Deferred.succeed(startClockRead, undefined).pipe(
            Effect.andThen(Deferred.await(releaseStartClockRead)),
            Effect.andThen(baseClock.currentTimeMillis),
          );
        }),
      };
      const start = yield* harness
        .startTurn()
        .pipe(Effect.provideService(Clock.Clock, blockingClock), Effect.exit, Effect.forkScoped);
      yield* Deferred.await(startClockRead);

      const events = yield* harness.runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
      nativeEvents.close();
      yield* Fiber.join(events);
      yield* Deferred.succeed(releaseStartClockRead, undefined);

      assert.isTrue(Exit.isFailure(yield* Fiber.join(start)));
      assert.equal(promptCalls, 0);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it("holds stale idle through prompt admission until the new user message is observed", () => {
    const admission = {
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: false,
    };

    assert.equal(advanceOpenCodePromptAdmission(admission, "idle"), "hold");
    assert.equal(advanceOpenCodePromptAdmission(admission, "accepted"), "hold");
    assert.isTrue(admission.admissionPending);
    assert.equal(advanceOpenCodePromptAdmission(admission, "user-message"), "reconcile-idle");
    assert.isTrue(admission.admissionPending);
  });

  it("releases admission only after prompt acceptance and new-turn evidence", () => {
    const admission = {
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: false,
    };

    assert.equal(advanceOpenCodePromptAdmission(admission, "busy"), "hold");
    assert.equal(advanceOpenCodePromptAdmission(admission, "accepted"), "release");
    assert.isFalse(admission.admissionPending);
  });

  it("releases admission when an assistant completes under a provider-assigned message id", () => {
    const admission = {
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: true,
    };

    assert.equal(advanceOpenCodePromptAdmission(admission, "assistant-completed"), "release");
    assert.isTrue(admission.admissionAccepted);
    assert.isTrue(admission.admissionMessageObserved);
    assert.isFalse(admission.admissionPending);
  });

  it("invalidates pending admission before aborting a turn", () => {
    const admission = {
      admissionGeneration: 4,
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: false,
    };

    cancelOpenCodePromptAdmission(admission, 5);

    assert.equal(admission.admissionGeneration, 5);
    assert.isFalse(admission.admissionPending);
    assert.equal(advanceOpenCodePromptAdmission(admission, "accepted"), "release");
  });

  it.effect("reconciles current idle and busy status replies after prompt admission", () =>
    Effect.gen(function* () {
      for (const expected of ["idle", "busy"] as const) {
        const admission = { admissionGeneration: 4, admissionPending: true };
        const status = yield* Deferred.make<"idle" | "busy" | "unknown">();
        const fiber = yield* reconcileOpenCodePromptAdmissionStatus(
          admission,
          4,
          Deferred.await(status),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.succeed(status, expected);

        assert.equal(yield* Fiber.join(fiber), expected);
        assert.isFalse(admission.admissionPending);
      }
    }),
  );

  it.effect("keeps admission pending after a transient status failure", () =>
    Effect.gen(function* () {
      const admission = { admissionGeneration: 4, admissionPending: true };
      assert.equal(
        yield* reconcileOpenCodePromptAdmissionStatus(admission, 4, Effect.succeed("unknown")),
        "unknown",
      );
      assert.isTrue(admission.admissionPending);
      assert.equal(
        yield* reconcileOpenCodePromptAdmissionStatus(admission, 4, Effect.succeed("idle")),
        "idle",
      );
      assert.isFalse(admission.admissionPending);
    }),
  );

  it.effect("retries a transient status failure without another idle event", () =>
    Effect.gen(function* () {
      const nativeSessionId = "native-opencode-status-retry";
      const nativeEvents = asyncEventStream();
      const promptRelease = promiseGate<void>();
      const promptCalls = yield* Queue.unbounded<string>();
      const statusCalls = yield* Queue.unbounded<number>();
      let statusCallCount = 0;
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (input: { readonly messageID?: string }) => {
            Queue.offerUnsafe(promptCalls, input.messageID!);
            await promptRelease.promise;
            return { data: true };
          },
          status: async () => {
            statusCallCount += 1;
            Queue.offerUnsafe(statusCalls, statusCallCount);
            if (statusCallCount === 1) throw new Error("transient status failure");
            return { data: { [nativeSessionId]: { type: "idle" as const } } };
          },
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          abort: async () => ({ data: true }),
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const harness = yield* makeOpenCodeRuntimeHarness("status-retry", nativeSessionId, client);
      const terminalEvents = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const start = yield* harness.startTurn().pipe(Effect.forkScoped);
      const admissionMessageId = yield* Queue.take(promptCalls);

      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: nativeSessionId, status: { type: "idle" } },
        }),
      );
      promptRelease.resolve();
      yield* Fiber.join(start);
      const userMessage = {
        type: "message.updated",
        properties: {
          sessionID: nativeSessionId,
          info: {
            id: admissionMessageId,
            sessionID: nativeSessionId,
            role: "user",
            time: { created: DateTime.toEpochMillis(harness.now) },
          },
        },
      };
      yield* Effect.promise(() => nativeEvents.push(userMessage));
      assert.equal(yield* Queue.take(statusCalls), 1);

      yield* Effect.promise(() => nativeEvents.push(userMessage));
      assert.equal(statusCallCount, 1, "duplicate events must share the generation's retry worker");
      yield* TestClock.adjust("250 millis");
      assert.equal(yield* Queue.take(statusCalls), 2);

      const events = Array.from(yield* Fiber.join(terminalEvents));
      const terminals = events.filter((event) => event.type === "turn.terminal");
      assert.equal(statusCallCount, 2);
      assert.lengthOf(terminals, 1);
      assert.equal(terminals[0]?.status, "completed");
      assert.isNull(terminals[0]?.failure ?? null);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("does not let a queued status retry adopt a newer steer generation", () =>
    Effect.gen(function* () {
      const nativeSessionId = "native-opencode-stale-status-retry";
      const nativeEvents = asyncEventStream();
      const firstPromptRelease = promiseGate<void>();
      const promptCalls = yield* Queue.unbounded<string>();
      const statusCalls = yield* Queue.unbounded<number>();
      let promptCallCount = 0;
      let statusCallCount = 0;
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (input: { readonly messageID?: string }) => {
            promptCallCount += 1;
            Queue.offerUnsafe(promptCalls, input.messageID!);
            if (promptCallCount === 1) {
              await firstPromptRelease.promise;
            }
            return { data: true };
          },
          status: async () => {
            statusCallCount += 1;
            Queue.offerUnsafe(statusCalls, statusCallCount);
            if (statusCallCount === 1) throw new Error("transient status failure");
            return { data: { [nativeSessionId]: { type: "idle" as const } } };
          },
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          abort: async () => ({ data: true }),
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const harness = yield* makeOpenCodeRuntimeHarness(
        "stale-status-retry",
        nativeSessionId,
        client,
      );
      const start = yield* harness.startTurn().pipe(Effect.forkScoped);
      const firstAdmissionMessageId = yield* Queue.take(promptCalls);

      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: nativeSessionId, status: { type: "idle" } },
        }),
      );
      firstPromptRelease.resolve();
      yield* Fiber.join(start);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: nativeSessionId,
            info: {
              id: firstAdmissionMessageId,
              sessionID: nativeSessionId,
              role: "user",
              time: { created: DateTime.toEpochMillis(harness.now) },
            },
          },
        }),
      );
      assert.equal(yield* Queue.take(statusCalls), 1);

      const running = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      const activeTurn = running.providerTurns.at(-1)!;
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: harness.runId,
        providerThread: harness.providerThread,
        providerTurnId: activeTurn.id,
        message: {
          messageId: MessageId.make("message-opencode-stale-status-retry-steer"),
          text: "new generation",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* Queue.take(promptCalls);
      yield* TestClock.adjust("250 millis");

      const afterRetry = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      assert.equal(statusCallCount, 1);
      assert.equal(afterRetry.providerTurns.at(-1)?.status, "running");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("ignores a delayed status reply after steering starts a newer admission", () =>
    Effect.gen(function* () {
      const admission = { admissionGeneration: 4, admissionPending: true };
      const status = yield* Deferred.make<"idle" | "busy" | "unknown">();
      const fiber = yield* reconcileOpenCodePromptAdmissionStatus(
        admission,
        4,
        Deferred.await(status),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      admission.admissionGeneration = 5;
      admission.admissionPending = true;
      yield* Deferred.succeed(status, "idle");

      assert.equal(yield* Fiber.join(fiber), "stale");
      assert.equal(admission.admissionGeneration, 5);
      assert.isTrue(admission.admissionPending);
    }),
  );

  it.effect("does not revive admission when abort wins a pending status lookup", () =>
    Effect.gen(function* () {
      const admission = { admissionGeneration: 4, admissionPending: true };
      const status = yield* Deferred.make<"idle" | "busy" | "unknown">();
      const fiber = yield* reconcileOpenCodePromptAdmissionStatus(
        admission,
        4,
        Deferred.await(status),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      cancelOpenCodePromptAdmission(admission, 5);
      yield* Deferred.succeed(status, "idle");

      assert.equal(yield* Fiber.join(fiber), "stale");
      assert.isFalse(admission.admissionPending);
    }),
  );

  it.effect("logs bounded structural protocol diagnostics without native payload values", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const records: Array<unknown> = [];
      const nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger = {
        filePath: "/tmp/provider-native.ndjson",
        write: (event) => Effect.sync(() => void records.push(event)),
        close: () => Effect.void,
      };
      const logProtocolEvent = makeOpenCodeProtocolLogger({
        nativeEventLogger,
        idAllocator,
        providerInstanceId: ProviderInstanceId.make("opencode-test"),
        providerSessionId: ProviderSessionId.make("provider-session-opencode-test"),
        threadId: ThreadId.make("thread-opencode-test"),
      });
      const secret = "secret-opencode-prompt";

      yield* logProtocolEvent({
        direction: "outgoing",
        messageKind: "request",
        method: "session.prompt",
        payload: { prompt: secret, nested: { token: secret } },
      });
      yield* logProtocolEvent({
        direction: "incoming",
        messageKind: "notification",
        method: "message.part.delta",
        payload: { type: "message.part.delta", properties: { delta: secret } },
      });

      assert.lengthOf(records, 1);
      const serialized = encodeUnknownJson(records);
      assert.notInclude(serialized, secret);
      assert.include(serialized, '"protocol":"opencode-sdk.sse"');
      assert.include(serialized, '"method":"session.prompt"');
      assert.include(serialized, '"fieldCount":2');
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it.effect("adopts the handed-over provider thread identity on session create", () =>
    Effect.gen(function* () {
      let createCount = 0;
      const createInputs: Array<unknown> = [];
      const fakeClient = {
        event: {
          subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => ({
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<never>>((resolve) => {
                    const done = () => resolve({ done: true, value: undefined });
                    if (options?.signal?.aborted) return done();
                    options?.signal?.addEventListener("abort", done, { once: true });
                  }),
              }),
            },
          }),
        },
        session: {
          create: async (input: unknown) => {
            createCount += 1;
            createInputs.push(input);
            return { data: { id: `ses_native_${createCount}`, time: { created: 1, updated: 1 } } };
          },
        },
      } as unknown as OpencodeClient;
      const unused = (operation: string) => () => Effect.die(`${operation} is not used`);
      const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
        startOpenCodeServerProcess: unused("startOpenCodeServerProcess"),
        connectToOpenCodeServer: () =>
          Effect.succeed({
            url: "test://opencode",
            version: "test",
            exitCode: null,
            external: true,
          }),
        runOpenCodeCommand: unused("runOpenCodeCommand"),
        createOpenCodeSdkClient: () => fakeClient,
        loadOpenCodeInventory: unused("loadOpenCodeInventory"),
        loadInventoryFromCli: unused("loadInventoryFromCli"),
        loadOpenCodeSkills: unused("loadOpenCodeSkills"),
        loadSkillsFromCli: unused("loadSkillsFromCli"),
      };
      const instanceId = ProviderInstanceId.make("opencode");
      const threadId = ThreadId.make("thread-opencode-adopt");
      const modelSelection = { instanceId, model: "default" };
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId,
        settings: OPENCODE_TEST_SETTINGS,
        environment: {},
      }).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-opencode-adopt"),
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      const now = yield* DateTime.now;
      const placeholder: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("thread:provider:opencode:native-thread:pending:run:adopt:1"),
        driver: OPENCODE_PROVIDER,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const adopted = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
        existingProviderThread: placeholder,
      });
      assert.equal(adopted.id, placeholder.id);
      assert.equal(adopted.nativeThreadRef?.nativeId, "ses_native_1");
      const minted = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      assert.notEqual(minted.id, placeholder.id);
      assert.equal(minted.nativeThreadRef?.nativeId, "ses_native_2");
      // OpenCode names a session from its first prompt only when create
      // leaves the title unset, so the adapter never sends one.
      for (const input of createInputs) {
        assert.notProperty(input, "title");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
  );

  it("maps native permission families to orchestration request kinds", () => {
    assert.equal(openCodePermissionRequestKind("bash"), "command");
    assert.equal(openCodePermissionRequestKind("read"), "file-read");
    assert.equal(openCodePermissionRequestKind("grep"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory", "edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("apply_patch"), "file-change");
    assert.equal(openCodePermissionRequestKind("todowrite"), "command");
    assert.equal(openCodePermissionRequestKind("custom", "todowrite"), "command");
  });

  it("maps OpenCode tools to semantic turn-item families", () => {
    assert.equal(openCodeToolProjectionKind("bash"), "command_execution");
    assert.equal(openCodeToolProjectionKind("edit"), "file_change");
    assert.equal(openCodeToolProjectionKind("read"), "dynamic_tool");
    assert.equal(openCodeToolProjectionKind("lsp"), "file_search");
    assert.equal(openCodeToolProjectionKind("websearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("codesearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("todowrite"), "dynamic_tool");
    assert.equal(openCodeToolProjectionKind("custom_tool"), "dynamic_tool");
  });

  it("maps runtime modes to safe OpenCode permission rules", () => {
    const approvalRequired = openCodePermissionRules(runtimePolicy("approval-required"));
    assert.equal(permissionAction(approvalRequired, "read"), "allow");
    assert.equal(permissionAction(approvalRequired, "edit"), "ask");
    assert.equal(permissionAction(approvalRequired, "bash"), "ask");
    assert.equal(permissionAction(approvalRequired, "doom_loop"), "ask");
    assert.equal(permissionAction(approvalRequired, "unknown_plugin_tool"), "ask");
    assert.equal(permissionAction(approvalRequired, "question"), "allow");

    const autoAcceptEdits = openCodePermissionRules(runtimePolicy("auto-accept-edits"));
    assert.equal(permissionAction(autoAcceptEdits, "edit"), "allow");
    assert.equal(permissionAction(autoAcceptEdits, "bash"), "ask");

    const fullAccess = openCodePermissionRules(runtimePolicy("full-access"));
    assert.equal(permissionAction(fullAccess, "bash"), "allow");
    assert.equal(permissionAction(fullAccess, "edit"), "allow");

    const granularApproval = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: { granular: { request_permissions: true } },
      }),
    );
    assert.equal(permissionAction(granularApproval, "bash"), "ask");
    assert.equal(permissionAction(granularApproval, "read"), "allow");

    const approvalRequiredWorkspaceWrite = openCodePermissionRules(
      runtimePolicy("approval-required", {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(approvalRequiredWorkspaceWrite, "edit"), "ask");
  });

  it("enforces non-interactive sandbox policy through OpenCode permissions", () => {
    const readOnly = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(readOnly, "read"), "allow");
    assert.equal(permissionAction(readOnly, "edit"), "deny");
    assert.equal(permissionAction(readOnly, "bash"), "deny");
    assert.equal(permissionAction(readOnly, "webfetch"), "deny");
    assert.equal(permissionAction(readOnly, "doom_loop"), "deny");
    assert.equal(permissionAction(readOnly, "unknown_plugin_tool"), "deny");
    assert.equal(permissionAction(readOnly, "external_directory"), "allow");

    const workspaceWrite = openCodePermissionRules(
      runtimePolicy("auto-accept-edits", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: true,
        },
      }),
    );
    assert.equal(permissionAction(workspaceWrite, "edit"), "allow");
    assert.equal(permissionAction(workspaceWrite, "bash"), "deny");
    assert.equal(permissionAction(workspaceWrite, "webfetch"), "allow");
    assert.deepInclude(workspaceWrite, {
      permission: "external_directory",
      pattern: "/tmp/opencode-workspace/*",
      action: "allow",
    });
  });

  it("preserves OpenCode's recursion guard on task-created child sessions", () => {
    const childRules = openCodeChildPermissionRules(runtimePolicy("full-access"), [
      { permission: "task", pattern: "*", action: "deny" },
    ]);

    assert.equal(permissionAction(childRules, "read"), "allow");
    assert.equal(permissionAction(childRules, "bash"), "allow");
    assert.equal(permissionAction(childRules, "task"), "deny");

    const approvalRequiredPolicy = runtimePolicy("approval-required");
    const parentRules = openCodePermissionRules(approvalRequiredPolicy);
    const childApprovalRules = openCodeChildPermissionRules(approvalRequiredPolicy, [
      ...parentRules.filter((rule) => rule.action === "deny"),
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    assert.equal(permissionAction(childApprovalRules, "bash"), "ask");
    assert.equal(permissionAction(childApprovalRules, "task"), "deny");

    const fullAccessChildRules = openCodeChildPermissionRules(runtimePolicy("full-access"), [
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    const reappliedRules = openCodeChildPermissionRules(
      approvalRequiredPolicy,
      fullAccessChildRules,
      openCodePermissionRules(runtimePolicy("full-access")),
    );
    assert.equal(permissionAction(reappliedRules, "bash"), "ask");
    assert.equal(permissionAction(reappliedRules, "task"), "deny");
  });

  it("uses the next native user message as the exclusive fork and revert boundary", () => {
    const first = providerTurn({ id: "turn:first", ordinal: 1, nativeId: "msg-user-1" });
    const synthetic = providerTurn({ id: "turn:synthetic", ordinal: 2, nativeId: null });
    const third = providerTurn({ id: "turn:third", ordinal: 3, nativeId: "msg-user-3" });

    assert.equal(
      openCodeBoundaryAfterProviderTurn([third, first, synthetic], first.id),
      "msg-user-3",
    );
    assert.isUndefined(openCodeBoundaryAfterProviderTurn([first, synthetic, third], third.id));
  });

  it("skips a turn that never got a native user message when choosing the boundary", () => {
    const first = providerTurn({ id: "turn:first", ordinal: 1, nativeId: "msg-user-1" });
    const unadmitted = providerTurn({
      id: "turn:unadmitted",
      ordinal: 2,
      nativeId: "ses_root:attempt:attempt-2",
    });
    const third = providerTurn({ id: "turn:third", ordinal: 3, nativeId: "msg-user-3" });

    assert.equal(
      openCodeBoundaryAfterProviderTurn([first, unadmitted, third], first.id),
      "msg-user-3",
    );
    assert.isUndefined(openCodeBoundaryAfterProviderTurn([first, unadmitted], first.id));
  });

  it.effect.each(["/compact", "rejected prompt"] as const)(
    "rewinds and forks to the turn before a %s turn",
    (kind) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const sessionId = "ses_rewind";
        const forkedAt: Array<string | undefined> = [];
        const message = (id: string, role: "user" | "assistant") => ({
          info: { id, sessionID: sessionId, role, time: { created: 1 } },
          parts: [],
        });
        const history = [
          message("msg_user_1", "user"),
          message("msg_assistant_1", "assistant"),
          ...(kind === "/compact"
            ? [message("msg_compaction", "user"), message("msg_summary", "assistant")]
            : []),
        ];
        const harness = yield* makeOpenCodeRuntimeHarness(
          kind === "/compact" ? "rewind-before-compaction" : "rewind-before-rejected",
          sessionId,
          {
            event: {
              subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
                options.signal?.addEventListener("abort", () => nativeEvents.close(), {
                  once: true,
                });
                return { stream: nativeEvents.stream };
              },
            },
            session: {
              create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
              get: async ({ sessionID }: { sessionID: string }) => ({
                data: { id: sessionID, time: { created: 1, updated: 2 } },
              }),
              promptAsync: async () => {
                throw new Error("provider rejected the prompt");
              },
              // OpenCode names the compaction's user message itself.
              summarize: async () => {
                await nativeEvents.push({
                  type: "message.updated",
                  properties: {
                    sessionID: sessionId,
                    info: message("msg_compaction", "user").info,
                  },
                });
                return { data: true };
              },
              messages: async ({ sessionID }: { sessionID: string }) => ({
                data: sessionID === sessionId ? history : history.slice(0, 2),
              }),
              fork: async ({ messageID }: { messageID?: string }) => {
                forkedAt.push(messageID);
                return { data: { id: "ses_fork", time: { created: 1, updated: 2 } } };
              },
              update: async () => ({ data: {} }),
            },
          },
        );
        const firstTurn = providerTurn({ id: "turn:first", ordinal: 1, nativeId: "msg_user_1" });
        const secondTurn = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map(
            (events) =>
              events.findLast((event) => event.type === "provider_turn.updated")?.providerTurn,
          ),
          Effect.forkScoped,
        );
        yield* harness
          .startTurn(
            kind === "/compact" ? "/compact" : "do something",
            harness.providerThread,
            harness.policy,
            2,
          )
          .pipe(Effect.exit);
        const second = yield* Fiber.join(secondTurn);
        if (second === undefined) return yield* Effect.die("The second turn was never emitted.");

        const rewind = yield* harness.runtime
          .rollbackThread({
            providerThread: harness.providerThread,
            target: {
              type: "provider_turn",
              checkpointId: CheckpointId.make("checkpoint-after-first-turn"),
              appRunOrdinal: 1,
              providerTurn: firstTurn,
            },
            providerThreadTurns: [firstTurn, second],
          })
          .pipe(Effect.exit);
        yield* harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          sourceProviderTurns: [firstTurn, second],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make(kind === "/compact" ? "thread-fork-a" : "thread-fork-b"),
        });

        assert.deepStrictEqual(
          { rewound: Exit.isSuccess(rewind), forkedAt },
          kind === "/compact"
            ? { rewound: true, forkedAt: ["msg_compaction", "msg_compaction"] }
            : { rewound: true, forkedAt: [undefined] },
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );
});

it.effect.each([false, true])(
  "OpenCode rewind forks history and validates the retained boundary, invalid=%s",
  (invalid) =>
    Effect.gen(function* () {
      const events = asyncEventStream();
      const nativeSessionId = "rewind-source";
      const forkId = "rewind-fork";
      const calls: string[] = [];
      const removed = {
        info: { id: "first-user", sessionID: nativeSessionId, role: "user", time: { created: 1 } },
        parts: [],
      };
      const harness = yield* makeOpenCodeRuntimeHarness("rewind-fork", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => events.close(), { once: true });
            return { stream: events.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: nativeSessionId, time: { created: 1, updated: 1 } } }),
          get: async ({ sessionID }: { sessionID: string }) => ({
            data: { id: sessionID, time: { created: 1, updated: 2 } },
          }),
          messages: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === nativeSessionId || invalid ? [removed] : [],
          }),
          fork: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
            assert.equal(sessionID, nativeSessionId);
            assert.equal(messageID, "first-user");
            calls.push("fork");
            return { data: { id: forkId, time: { created: 1, updated: 2 } } };
          },
          update: async () => {
            calls.push("permissions");
            return { data: {} };
          },
          revert: async () => {
            throw new Error("Native revert would change workspace files");
          },
        },
      });
      const effect = harness.runtime.rollbackThread({
        providerThread: harness.providerThread,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("rewind-checkpoint"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [],
      });
      if (invalid) {
        const error = yield* effect.pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterRollbackThreadError");
        assert.deepEqual(calls, ["fork"]);
      } else {
        const result = yield* effect;
        assert.equal(result.providerThread.nativeThreadRef?.nativeId, forkId);
        assert.equal(result.messages.length, 0);
        assert.deepEqual(calls, ["fork", "permissions"]);
      }
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
);

it.live.each([true, false])("opens an authenticated OpenCode session (external=%s)", (external) =>
  Effect.gen(function* () {
    const password = external ? "settings-password" : "environment-password";
    const requests: string[] = [];
    let eventConnected!: () => void;
    const eventRequest = new Promise<void>((resolve) => {
      eventConnected = resolve;
    });
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<ReturnType<typeof NodeHttp.createServer>>((resolve) => {
            const server = NodeHttp.createServer((request, response) => {
              if (
                request.headers.authorization !==
                `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
              ) {
                response.writeHead(401).end("Unauthorized");
                return;
              }
              const url = new URL(request.url!, "http://localhost");
              requests.push(url.pathname);
              if (url.pathname === "/event") {
                response.writeHead(200, { "Content-Type": "text/event-stream" });
                response.write(": connected\n\n");
                eventConnected();
                return;
              }
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(
                JSON.stringify(
                  url.pathname.endsWith("/children")
                    ? []
                    : url.pathname === "/session"
                      ? { id: "native-auth", time: { created: 1, updated: 1 } }
                      : { healthy: true, version: "1.14.19" },
                ),
              );
            });
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
    );
    const address = server.address();
    assert.isNotNull(address);
    if (!address || typeof address === "string") return;
    const url = `http://127.0.0.1:${address.port}`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let managedStarts = 0;
    const runtimeLayer = OpenCodeRuntime.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            assert.isTrue(ChildProcess.isStandardCommand(command));
            if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
            assert.include(command.args, "serve");
            assert.equal(command.options.env?.OPENCODE_SERVER_PASSWORD, password);
            managedStarts += 1;
            return spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [
                  "-e",
                  `console.log("server listening on " + process.argv[1]); setInterval(() => {}, 1000)`,
                  url,
                ],
                command.options,
              ),
            );
          }),
        ),
      ),
      Layer.provide(OpenCodeServerLedger.layerTest),
      Layer.provideMerge(NodeServices.layer),
    );
    const instanceId = ProviderInstanceId.make("opencode-auth");
    const adapter = yield* makeOpenCodeAdapterV2({
      instanceId,
      settings: yield* decodeOpenCodeSettings({
        serverUrl: external ? url : "",
        ...(external ? { serverPassword: password } : {}),
      }),
      environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
    }).pipe(Effect.provide(runtimeLayer));
    const session = yield* adapter.openSession({
      threadId: ThreadId.make("thread-opencode-auth"),
      providerSessionId: ProviderSessionId.make("session-opencode-auth"),
      modelSelection: { instanceId, model: "anthropic/claude-sonnet", options: [] },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    });
    yield* session.ensureThread({
      threadId: ThreadId.make("thread-opencode-auth"),
      modelSelection: { instanceId, model: "anthropic/claude-sonnet", options: [] },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    });
    assert.include(requests, "/session");
    yield* Effect.promise(() => eventRequest);
    assert.include(requests, "/event");
    assert.include(requests, "/global/health");
    assert.equal(managedStarts, external ? 0 : 1);
  }).pipe(
    Effect.scoped,
    Effect.provide([
      NodeServices.layer,
      TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      IdAllocator.layer,
      McpProviderSessions.layer,
    ]),
  ),
);
