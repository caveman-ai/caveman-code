// Model check of the real ClaudeAdapterV2 turn lifecycle over every order of CLI frames, stop, steer, a second
// startTurn, the CLI exiting and the 10 s close timeout. Skill: .claude/skills/adapter-turn-lifecycle/SKILL.md
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import type { PermissionUpdate, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  assertHolds,
  checkAsync,
  formatTrace,
  type Action,
  type AsyncSpec,
} from "@caveman-app/model-check";
import { ADVANCE_CLOCK, Gates, openHarness, type Harness } from "@caveman-app/model-check/effect";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@caveman-app/protocol";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appProxy } from "../../router/proxyLauncher.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

// As ClaudeAdapterV2.test.ts does: the app proxy as if the runtime had started it, and no managed Claude settings.
vi.spyOn(appProxy, "url").mockReturnValue("http://127.0.0.1:8787");
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings)
    .mockReset()
    .mockResolvedValue({ effective: {}, provenance: {}, sources: [] });
});

const NATIVE_SESSION = "native-thread-model-check";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "high" }],
} satisfies ModelSelection;
const RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const ATTACHMENTS_DIR = NodeFS.mkdtempSync(
  NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "claude-model-check-"),
);

const appThread = (
  threadId: ThreadId,
  providerThread: OrchestrationV2ProviderThread,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make(`project-${threadId}`),
  title: "Claude model check",
  providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  modelSelection: MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: providerThread.id,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const turnInput = (
  threadId: ThreadId,
  providerThread: OrchestrationV2ProviderThread,
  now: DateTime.Utc,
  ordinal: number,
): ProviderAdapter.ProviderAdapterV2TurnInput => ({
  appThread: appThread(threadId, providerThread, now),
  threadId,
  runId: RunId.make(`run-${ordinal}`),
  runOrdinal: ordinal,
  providerTurnOrdinal: ordinal,
  attemptId: RunAttemptId.make(`attempt-${ordinal}`),
  rootNodeId: NodeId.make(`node-${ordinal}`),
  providerThread,
  message: {
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message-${ordinal}`),
    text: `Turn ${ordinal}.`,
    attachments: [],
  },
  modelSelection: MODEL_SELECTION,
  runtimePolicy: RUNTIME_POLICY,
});

const frame = (message: Record<string, unknown>) => message as unknown as SDKMessage;
const resultFrame = (uuid: string, kind: "success" | "aborted" | "error") =>
  frame({
    type: "result",
    subtype: kind === "error" ? "error_during_execution" : "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: kind === "error",
    num_turns: 1,
    result: kind === "success" ? "Done." : "",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: NATIVE_SESSION,
    terminal_reason: kind === "aborted" ? "aborted_streaming" : "completed",
    ...(kind === "error" ? { errors: ["Claude Agent hit an internal error."] } : {}),
  });

const toolUseFrame = (cli: number) =>
  frame({
    type: "assistant",
    uuid: `tool-frame-${cli}`,
    session_id: NATIVE_SESSION,
    parent_tool_use_id: null,
    message: {
      id: `tool-message-${cli}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", id: `tool-${cli}`, name: "Bash", input: { command: "make" } }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

interface CliProcess {
  readonly messages: Queue.Queue<SDKMessage, Cause.Done>;
  frames: number;
  toolCalls: number;
  ended: boolean;
}

interface Claude {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly threadId: ThreadId;
  readonly events: Array<ProviderAdapter.ProviderAdapterV2Event>;
  readonly processes: Array<CliProcess>;
  /** The permission callback the adapter handed the SDK when it opened the CLI. */
  readonly canUseTool: { current: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["canUseTool"] };
  /** Set while the system is thrown away: the CLI double stops parking so the session's finalizers can run. */
  readonly disposing: { value: boolean };
}

// The adapter logs every wake and timeout it handles; thousands of explored states would bury the verdict.
const quiet = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, References.MinimumLogLevel, "None");

const buildClaude = (gateOpen: boolean) =>
  Effect.gen(function* () {
    const gates = yield* Gates;
    const services = yield* Layer.build(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    );
    return yield* Effect.gen(function* () {
      const processes: Array<CliProcess> = [];
      const disposing = { value: false };
      const opens = { value: 0 };
      const canUseTool: Claude["canUseTool"] = { current: undefined };
      const cliGate = (name: string) =>
        Effect.suspend(() => (disposing.value ? Effect.void : gates.gate(name)));
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
        settings: Schema.decodeSync(ClaudeSettings)({}),
        environment: {},
        attachmentsDir: ATTACHMENTS_DIR,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        random: yield* SecureRandom.SecureRandom,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed(NATIVE_SESSION),
          open: (input) =>
            Effect.gen(function* () {
              canUseTool.current = input.options.canUseTool;
              // Gated only where the second startTurn may overlap the first: the open is where both can pass the active-turn check.
              if (gateOpen) yield* cliGate(`CLI open #${++opens.value} returns`);
              const messages = yield* Queue.unbounded<SDKMessage, Cause.Done>();
              processes.push({ messages, frames: 0, toolCalls: 0, ended: false });
              const cli = `CLI ${processes.length}`;
              return {
                messages: Stream.fromQueue(messages),
                offer: () => Effect.void,
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                setMcpServers: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                stopTask: () => Effect.void,
                // The SDK's interrupt and close each wait on the CLI; when the CLI answers is the checker's choice.
                interrupt: cliGate(`${cli}: interrupt returns`),
                close: cliGate(`${cli}: close returns`),
              } satisfies ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
            }),
          forkSession: () => Effect.die("unused forkSession"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      const threadId = ThreadId.make("thread-claude-model-check");
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-claude-model-check"),
        modelSelection: MODEL_SELECTION,
        runtimePolicy: RUNTIME_POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: MODEL_SELECTION,
        runtimePolicy: RUNTIME_POLICY,
      });
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
        Effect.forkScoped,
      );
      return {
        runtime,
        providerThread,
        threadId,
        events,
        processes,
        canUseTool,
        disposing,
      } satisfies Claude;
    }).pipe(Effect.provide(services), quiet);
  });

const FS_REQUESTS = /^(FSReq|FileHandle|StatWatcher)/;
/** Quiet means every fiber finished or parked and no file system request is still on the libuv pool. */
const quiesce = async (harness: Harness<Claude>) => {
  for (let round = 0; round < 1000; round++) {
    await harness.settle();
    if (!process.getActiveResourcesInfo().some((resource) => FS_REQUESTS.test(resource))) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("the adapter never went quiet: a file system request is still pending");
};

type Result = "success" | "aborted" | "error";

interface Bounds {
  /** startTurn calls, issued in order. */
  readonly turns: number;
  /** Result frames each CLI process sends before it can only exit. */
  readonly framesPerCli: number;
  readonly results: ReadonlyArray<Result>;
  readonly steer: boolean;
  /** The second startTurn may be called while the first is still opening the CLI. */
  readonly overlap: boolean;
  /** Each CLI may start one Bash call that never reports a result. */
  readonly toolCall: boolean;
}

interface System {
  readonly harness: Harness<Claude>;
  starts: number;
  readonly stops: Set<number>;
  readonly steers: Set<number>;
}

interface TurnView {
  readonly ordinal: number;
  readonly updates: ReadonlyArray<string>;
  /** Latest status of each tool call item the turn owns. */
  readonly tools: ReadonlyArray<string>;
  readonly terminals: ReadonlyArray<{ readonly status: string; readonly failure: boolean }>;
}

interface Observation {
  readonly turns: ReadonlyArray<TurnView>;
  readonly calls: Readonly<Record<string, string>>;
  readonly clis: ReadonlyArray<{ readonly frames: number; readonly ended: boolean }>;
  readonly parked: ReadonlyArray<string>;
  readonly now: number;
}

const TERMINAL_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);
const TERMINAL_ITEM_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "declined",
]);
const ordinalOfAttempt = (attemptId: string | null) =>
  Number(/^attempt-(\d+)$/.exec(attemptId ?? "")?.[1] ?? Number.NaN);

const turnsOf = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
): ReadonlyArray<TurnView & { readonly id: string }> => {
  const turns = new Map<
    string,
    {
      ordinal: number;
      updates: Array<string>;
      tools: Map<string, string>;
      terminals: Array<{ status: string; failure: boolean }>;
    }
  >();
  const turn = (id: string) => {
    const existing = turns.get(id);
    if (existing !== undefined) return existing;
    const created = {
      ordinal: Number.NaN,
      updates: [] as Array<string>,
      tools: new Map<string, string>(),
      terminals: [] as Array<{ status: string; failure: boolean }>,
    };
    turns.set(id, created);
    return created;
  };
  for (const event of events) {
    if (event.type === "provider_turn.updated") {
      const view = turn(event.providerTurn.id);
      view.ordinal = ordinalOfAttempt(event.providerTurn.runAttemptId);
      view.updates.push(event.providerTurn.status);
    } else if (event.type === "turn.terminal") {
      turn(event.providerTurnId).terminals.push({
        status: event.status,
        failure: event.failure !== null,
      });
    } else if (
      event.type === "turn_item.updated" &&
      event.turnItem.providerTurnId !== null &&
      event.turnItem.nativeItemRef?.nativeId?.startsWith("tool-") === true
    ) {
      turn(event.turnItem.providerTurnId).tools.set(event.turnItem.id, event.turnItem.status);
    }
  }
  return [...turns.entries()]
    .map(([id, view]) => ({ id, ...view, tools: [...view.tools.values()] }))
    .sort((a, b) => a.ordinal - b.ordinal);
};

const providerTurnIdOf = (claude: Claude, ordinal: number) => {
  const id = turnsOf(claude.events).find((view) => view.ordinal === ordinal)?.id;
  if (id === undefined) throw new Error(`turn ${ordinal} never reported its provider turn`);
  return ProviderTurnId.make(id);
};

const fiberStatus = (system: System, name: string) => system.harness.fibers()[name];

const claudeSpec = (bounds: Bounds): AsyncSpec<System, Observation> => ({
  make: async () => {
    const harness = await openHarness(buildClaude(bounds.overlap));
    await quiesce(harness);
    return { harness, starts: 0, stops: new Set(), steers: new Set() };
  },
  actions: (system) => {
    const { harness } = system;
    const claude = harness.value;
    const step = (name: string, run: () => void): Action<System> => ({
      name,
      run: async () => {
        run();
        await quiesce(harness);
      },
    });
    const actions: Array<Action<System>> = harness.enabled().map((name) =>
      step(name, () => {
        if (name === ADVANCE_CLOCK) {
          if (!harness.clock.advanceToNext()) throw new Error("no sleeper to wake");
        } else if (!harness.gates.release(name)) throw new Error(`no fiber is parked at "${name}"`);
      }),
    );
    if (
      system.starts < bounds.turns &&
      (bounds.overlap ||
        system.starts === 0 ||
        fiberStatus(system, `startTurn ${system.starts}`) !== "running")
    ) {
      const ordinal = system.starts + 1;
      actions.push(
        step(`startTurn ${ordinal}`, () => {
          system.starts = ordinal;
          const now = DateTime.makeUnsafe(harness.clock.currentTimeMillisUnsafe());
          harness.fork(
            `startTurn ${ordinal}`,
            quiet(
              claude.runtime.startTurn(
                turnInput(claude.threadId, claude.providerThread, now, ordinal),
              ),
            ),
          );
        }),
      );
    }
    for (let ordinal = 1; ordinal <= system.starts; ordinal++) {
      if (fiberStatus(system, `startTurn ${ordinal}`) !== "done") continue;
      if (!system.stops.has(ordinal)) {
        actions.push(
          step(`stop turn ${ordinal}`, () => {
            system.stops.add(ordinal);
            harness.fork(
              `stop turn ${ordinal}`,
              quiet(
                claude.runtime.interruptTurn({
                  providerThread: claude.providerThread,
                  providerTurnId: providerTurnIdOf(claude, ordinal),
                }),
              ),
            );
          }),
        );
      }
      if (bounds.steer && !system.steers.has(ordinal)) {
        actions.push(
          step(`steer turn ${ordinal}`, () => {
            system.steers.add(ordinal);
            harness.fork(
              `steer turn ${ordinal}`,
              quiet(
                claude.runtime.steerTurn({
                  threadId: claude.threadId,
                  runId: RunId.make(`run-${ordinal}`),
                  providerThread: claude.providerThread,
                  providerTurnId: providerTurnIdOf(claude, ordinal),
                  message: {
                    createdBy: "user",
                    creationSource: "web",
                    messageId: MessageId.make(`steer-${ordinal}`),
                    text: "Also this.",
                    attachments: [],
                  },
                }),
              ),
            );
          }),
        );
      }
    }
    // A replaced CLI is closed but may still flush frames before its stream ends, so every live one can speak.
    for (const [at, cli] of claude.processes.entries()) {
      if (cli.ended) continue;
      const index = at + 1;
      if (cli.frames < bounds.framesPerCli) {
        for (const kind of bounds.results) {
          actions.push(
            step(`CLI ${index}: result ${kind}`, () => {
              cli.frames++;
              Effect.runSync(
                Queue.offer(cli.messages, resultFrame(`result-${index}-${cli.frames}`, kind)),
              );
            }),
          );
        }
      }
      if (bounds.toolCall && cli.toolCalls < 1) {
        actions.push(
          step(`CLI ${index}: starts a Bash call`, () => {
            cli.toolCalls++;
            Effect.runSync(Queue.offer(cli.messages, toolUseFrame(index)));
          }),
        );
      }
      actions.push(
        step(`CLI ${index}: exits`, () => {
          cli.ended = true;
          Effect.runSync(Queue.end(cli.messages));
        }),
      );
    }
    return actions;
  },
  observe: (system) => {
    const claude = system.harness.value;
    return {
      turns: turnsOf(claude.events).map(({ ordinal, updates, tools, terminals }) => ({
        ordinal,
        updates,
        tools,
        terminals,
      })),
      calls: system.harness.fibers(),
      clis: claude.processes.map(({ frames, ended }) => ({ frames, ended })),
      parked: system.harness.gates.parked(),
      now: system.harness.clock.currentTimeMillisUnsafe(),
    };
  },
  invariants: {
    "a provider turn gets at most one turn.terminal": (o) =>
      o.turns.every((turn) => turn.terminals.length <= 1),
    "a provider turn gets at most one terminal provider_turn.updated": (o) =>
      o.turns.every(
        (turn) => turn.updates.filter((status) => TERMINAL_STATUSES.has(status)).length <= 1,
      ),
    "no provider_turn.updated follows a terminal one": (o) =>
      o.turns.every((turn) => {
        const end = turn.updates.findIndex((status) => TERMINAL_STATUSES.has(status));
        return end === -1 || end === turn.updates.length - 1;
      }),
    "a terminal is failed exactly when it carries a failure": (o) =>
      o.turns.every((turn) =>
        turn.terminals.every((terminal) => (terminal.status === "failed") === terminal.failure),
      ),
    "turn.terminal and the provider turn agree on how it ended": (o) =>
      o.turns.every((turn) =>
        turn.terminals.every((terminal) => turn.updates.at(-1) === terminal.status),
      ),
    "a settled turn leaves no tool call running": (o) =>
      o.turns.every(
        (turn) =>
          turn.terminals.length === 0 ||
          turn.tools.every((status) => TERMINAL_ITEM_STATUSES.has(status)),
      ),
    "a stop that returned leaves its turn ended": (o) =>
      Object.entries(o.calls).every(([call, status]) => {
        const stopped = /^stop turn (\d+)$/.exec(call);
        return (
          stopped === null ||
          status !== "done" ||
          o.turns.some((turn) => turn.ordinal === Number(stopped[1]) && turn.terminals.length === 1)
        );
      }),
  },
  atEnd: {
    "every accepted startTurn ends with exactly one turn.terminal": (o) =>
      Object.entries(o.calls).every(([call, status]) => {
        const started = /^startTurn (\d+)$/.exec(call);
        return (
          started === null ||
          status !== "done" ||
          o.turns.some((turn) => turn.ordinal === Number(started[1]) && turn.terminals.length === 1)
        );
      }),
  },
  dispose: async ({ harness }) => {
    harness.value.disposing.value = true;
    harness.gates.releaseAll();
    await harness.close();
  },
});

const show = (o: Observation) =>
  [
    ...o.turns.map(
      (turn) =>
        `turn ${turn.ordinal}: provider_turn [${turn.updates.join(", ")}] tools [${turn.tools.join(", ")}] turn.terminal [${turn.terminals.map((t) => `${t.status}${t.failure ? " with failure" : ""}`).join(", ")}]`,
    ),
    `calls ${Object.entries(o.calls)
      .map(([call, status]) => `${call}=${status}`)
      .join(", ")}`,
    `parked [${o.parked.join("; ")}] clis ${o.clis.map((c, i) => `${i + 1}:${c.frames}${c.ended ? " ended" : ""}`).join(" ")} now=${o.now}`,
  ].join("\n     ");

const SCOPES: ReadonlyArray<readonly [string, Bounds]> = [
  [
    "one turn: stop, steer, three result frames, exit and the close timeout",
    {
      turns: 1,
      framesPerCli: 3,
      results: ["success", "aborted", "error"],
      steer: true,
      overlap: false,
      toolCall: true,
    },
  ],
  [
    "two turns: the second startTurn against every way the first ends",
    {
      turns: 2,
      framesPerCli: 2,
      results: ["success", "error"],
      steer: false,
      overlap: false,
      toolCall: false,
    },
  ],
];

const runCheck = async (label: string, bounds: Bounds) => {
  const started = performance.now();
  const verdict = await checkAsync({
    ...claudeSpec(bounds),
    maxStates: Number(process.env.MC_MAX ?? 100_000),
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (verdict.ok) {
    console.log(
      `claude turn lifecycle model check (${label}): ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive=${verdict.exhaustive}, ${seconds}s`,
    );
  } else {
    console.log(
      `claude turn lifecycle model check (${label}): ${verdict.kind} "${verdict.property}" after ${verdict.states} states, ${seconds}s\n${formatTrace(verdict.trace, show)}`,
    );
    if (verdict.error !== undefined) console.log(String(verdict.error));
  }
  return verdict;
};

describe("ClaudeAdapterV2 turn lifecycle over every order of CLI frames, stop, steer, a second turn, exit and the close timeout", () => {
  it.each(SCOPES)(
    "settles every accepted turn exactly once, failed exactly when it carries a failure, and a returned stop leaves no turn running: %s",
    async (label, bounds) => {
      const verdict = await runCheck(label, bounds);
      assertHolds(verdict, { show });
      expect(verdict).toMatchObject({ ok: true, exhaustive: true });
    },
    300_000,
  );

  // FINDING: startTurn checks activeTurn, then awaits prepareQuery and queryRunner.open before attachTurn sets it, so
  // two overlapping calls both pass the check. The second open replaces queryContext and activeTurn; the first turn is
  // accepted but owned by nobody, its CLI's exit no longer finalizes it, and its Stop returns with it still running.
  // When this test fails because the check now passes, fold the scope into SCOPES.
  it("FINDING: two overlapping startTurn calls are both accepted and the first turn never settles", async () => {
    const verdict = await runCheck("two turns whose startTurn calls overlap", {
      turns: 2,
      framesPerCli: 1,
      results: ["success"],
      steer: false,
      overlap: true,
      toolCall: false,
    });
    expect(verdict).toMatchObject({
      ok: false,
      kind: "invariant",
      property: "a stop that returned leaves its turn ended",
    });
    if (verdict.ok) return;
    expect(verdict.trace.map((step) => step.action)).toEqual([
      "init",
      "startTurn 1",
      "startTurn 2",
      "CLI open #1 returns",
      "stop turn 1",
      "CLI open #2 returns",
      "CLI 1: interrupt returns",
      "CLI 1: close returns",
      "CLI 1: exits",
    ]);
    const end = verdict.trace.at(-1)!.state;
    expect(end.calls, "both starts were accepted and the stop returned").toMatchObject({
      "startTurn 1": "done",
      "startTurn 2": "done",
      "stop turn 1": "done",
    });
    expect(
      end.turns.find((turn) => turn.ordinal === 1),
      "turn 1 is still running with no terminal",
    ).toMatchObject({ updates: ["running"], terminals: [] });
  }, 120_000);
});

const DECISIONS: ReadonlyArray<ProviderApprovalDecision> = ProviderApprovalDecision.literals;
// acceptAlways approves too: the projector shows it as allow and the orchestrator settles the approval as completed.
const APPROVING = new Set<ProviderApprovalDecision>(["accept", "acceptForSession", "acceptAlways"]);
const SUGGESTION: PermissionUpdate = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "git status" }],
  behavior: "allow",
  destination: "localSettings",
};

/** The permission result Claude receives when a person answers its Bash approval with `decision`, through the real adapter. */
const answerThroughAdapter = async (decision: ProviderApprovalDecision) => {
  const harness = await openHarness(buildClaude(false));
  try {
    const claude = harness.value;
    harness.fork(
      "startTurn 1",
      quiet(
        claude.runtime.startTurn(
          turnInput(claude.threadId, claude.providerThread, DateTime.makeUnsafe(0), 1),
        ),
      ),
    );
    await quiesce(harness);
    const callback = claude.canUseTool.current;
    if (callback === undefined)
      throw new Error("the adapter opened the CLI without a permission callback");
    const answer = callback(
      "Bash",
      { command: "git status" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-use-1",
        requestId: "request-1",
        suggestions: [SUGGESTION],
      },
    );
    await quiesce(harness);
    const request = claude.events.findLast((event) => event.type === "runtime_request.updated");
    if (request?.type !== "runtime_request.updated")
      throw new Error("the approval never reached the person");
    harness.fork(
      "respond",
      quiet(
        claude.runtime.respondToRuntimeRequest({ requestId: request.runtimeRequest.id, decision }),
      ),
    );
    await quiesce(harness);
    const answered = await answer;
    // A second answer (another device, a retry) must not reach Claude again.
    harness.fork(
      "respond again",
      quiet(
        claude.runtime.respondToRuntimeRequest({
          requestId: request.runtimeRequest.id,
          decision: "cancel",
        }),
      ),
    );
    await quiesce(harness);
    return { answered, again: harness.fibers()["respond again"] };
  } finally {
    harness.value.disposing.value = true;
    harness.gates.releaseAll();
    await harness.close();
  }
};

describe("Claude Agent approvals: every decision the protocol allows, through the adapter that answers the SDK", () => {
  it("permissionResultFromDecision allows exactly the approving decisions, with and without feedback and suggestions", () => {
    const cases = DECISIONS.flatMap((decision) =>
      [undefined, "Use a dry run."].flatMap((feedback) =>
        [undefined, [SUGGESTION]].map((suggestions: Array<PermissionUpdate> | undefined) => ({
          decision,
          feedback,
          suggestions,
        })),
      ),
    );
    const wrong = cases.flatMap(({ decision, feedback, suggestions }) => {
      const result = ClaudeAdapterV2.permissionResultFromDecision({
        toolName: "Bash",
        decision,
        toolInput: { command: "git status" },
        toolUseID: "tool-use-1",
        ...(feedback === undefined ? {} : { feedback }),
        ...(suggestions === undefined ? {} : { suggestions }),
      });
      const allows = result.behavior === "allow";
      return allows === APPROVING.has(decision)
        ? []
        : [
            `${decision}${feedback ? " with feedback" : ""}${suggestions ? " with suggestions" : ""} -> ${result.behavior}`,
          ];
    });
    console.log(`claude approval decisions: ${cases.length} cases, wrong: [${wrong.join("; ")}]`);
    expect(wrong, "decisions whose native answer contradicts what the person chose").toEqual([]);
  });

  it.each(DECISIONS)(
    "answers %s once, with allow exactly when the person approved",
    async (decision) => {
      const { answered, again } = await answerThroughAdapter(decision);
      const expected = APPROVING.has(decision) ? "allow" : "deny";
      expect(answered?.behavior, `Claude's answer to ${decision}`).toBe(expected);
      expect(again, "a second answer to the same request is refused, not sent to Claude").toBe(
        "failed",
      );
    },
    30_000,
  );
});
