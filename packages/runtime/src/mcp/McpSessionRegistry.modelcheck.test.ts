// Bounded model check of McpSessionRegistry: every sequence of issue, resolve, touch, the three revocations and clock
// advances (to the 24 h liveness window and one millisecond past it), up to the depth below, run on the real registry
// with its real default window and Node crypto, compared step by step with a reference model of the promise: a
// credential resolves iff it was issued, is unrevoked and is within 24 h of its last sign of life, and then only as
// its own thread and provider session. Skill: .claude/skills/mcp-and-rpc-authorization/SKILL.md
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@caveman-app/protocol";
import { assertHolds, check, type Step } from "@caveman-app/model-check";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

/** The promise's 24 h. The registry is built without `livenessWindowMs`, so this checks its real default. */
const WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_TOKENS = 3;
const MAX_DEPTH = 8;

type Thread = "A" | "B";
const THREADS: ReadonlyArray<Thread> = ["A", "B"];

type Action =
  | { readonly op: "issue"; readonly thread: Thread }
  | { readonly op: "resolve"; readonly token: number }
  | { readonly op: "resolveForged" }
  | { readonly op: "touch"; readonly thread: Thread }
  | { readonly op: "revokeThread"; readonly thread: Thread }
  | { readonly op: "revokeProviderSession"; readonly token: number }
  | { readonly op: "revokeAll" }
  | { readonly op: "advance"; readonly ms: number };

interface ModelToken {
  readonly thread: Thread;
  readonly lastAliveAt: number;
  readonly revoked: boolean;
}

interface State {
  readonly now: number;
  readonly tokens: ReadonlyArray<ModelToken>;
  /** Every action so far, replayed on a fresh registry to reach this state in the real code. */
  readonly log: ReadonlyArray<Action>;
  /** The last action's outcome in the model and in the real registry. */
  readonly expected: string;
  readonly observed: string;
}

const describe = (action: Action): string => {
  switch (action.op) {
    case "issue":
    case "touch":
    case "revokeThread":
      return `${action.op}(${action.thread})`;
    case "resolve":
    case "revokeProviderSession":
      return `${action.op}(token ${action.token})`;
    case "advance":
      return action.ms === WINDOW_MS ? "advance(24h)" : `advance(${action.ms}ms)`;
    default:
      return action.op;
  }
};

// ---- The reference model, from the promise in McpSessionRegistry.ts.

const live = (state: Pick<State, "now">, token: ModelToken) =>
  !token.revoked && state.now - token.lastAliveAt <= WINDOW_MS;

const modelStep = (state: State, action: Action): Pick<State, "now" | "tokens" | "expected"> => {
  const { now, tokens } = state;
  switch (action.op) {
    case "issue":
      return {
        now,
        tokens: [...tokens, { thread: action.thread, lastAliveAt: now, revoked: false }],
        expected: "issued",
      };
    case "resolve": {
      const token = tokens[action.token]!;
      if (!live(state, token)) return { now, tokens, expected: "refused" };
      // MCP traffic is a sign of life.
      return {
        now,
        tokens: tokens.map((t, index) => (index === action.token ? { ...t, lastAliveAt: now } : t)),
        expected: `thread ${token.thread}, session of token ${action.token}`,
      };
    }
    case "resolveForged":
      return { now, tokens, expected: "refused" };
    case "touch":
      // A provider turn is a sign of life for every credential of its thread, even one past the window.
      return {
        now,
        tokens: tokens.map((t) => (t.thread === action.thread ? { ...t, lastAliveAt: now } : t)),
        expected: "done",
      };
    case "revokeThread":
      return {
        now,
        tokens: tokens.map((t) => (t.thread === action.thread ? { ...t, revoked: true } : t)),
        expected: "done",
      };
    case "revokeProviderSession":
      return {
        now,
        tokens: tokens.map((t, index) => (index === action.token ? { ...t, revoked: true } : t)),
        expected: "done",
      };
    case "revokeAll":
      return { now, tokens: tokens.map((t) => ({ ...t, revoked: true })), expected: "done" };
    case "advance":
      return { now: now + action.ms, tokens, expected: "done" };
  }
};

const enabled = (state: State): ReadonlyArray<Action> => [
  ...(state.tokens.length < MAX_TOKENS
    ? THREADS.map((thread) => ({ op: "issue" as const, thread }))
    : []),
  ...state.tokens.map((_, token) => ({ op: "resolve" as const, token })),
  { op: "resolveForged" },
  ...THREADS.map((thread) => ({ op: "touch" as const, thread })),
  ...THREADS.map((thread) => ({ op: "revokeThread" as const, thread })),
  ...state.tokens.map((_, token) => ({ op: "revokeProviderSession" as const, token })),
  { op: "revokeAll" },
  { op: "advance", ms: WINDOW_MS },
  { op: "advance", ms: 1 },
];

// ---- The real registry, rebuilt and replayed for every step.

const environment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:model-check")),
  getDescriptor: Effect.die("unused"),
});
const httpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const threadIdOf = (thread: Thread) => ThreadId.make(`thread:${thread}`);
const FORGED_TOKEN = Buffer.alloc(32, 7).toString("base64url");

/** Runs `log` on a fresh registry and returns the last action's outcome in the model's words. */
const replay = (log: ReadonlyArray<Action>): string =>
  Effect.runSync(
    Effect.gen(function* () {
      let now = 1_000_000;
      const registry = yield* McpSessionRegistry.__testing.make({ now: () => now });
      const issued: Array<{ readonly token: string; readonly providerSessionId: string }> = [];
      let outcome = "nothing ran";
      for (const action of log) {
        switch (action.op) {
          case "issue": {
            const { config } = yield* registry.issue({
              threadId: threadIdOf(action.thread),
              providerInstanceId: ProviderInstanceId.make("codex"),
            });
            issued.push({
              token: config.authorizationHeader.replace(/^Bearer\s+/, ""),
              providerSessionId: config.providerSessionId,
            });
            outcome =
              config.threadId === threadIdOf(action.thread)
                ? "issued"
                : `issued for ${config.threadId}`;
            break;
          }
          case "resolve":
          case "resolveForged": {
            const scope = yield* registry.resolve(
              action.op === "resolve" ? issued[action.token]!.token : FORGED_TOKEN,
            );
            if (scope === undefined) {
              outcome = "refused";
              break;
            }
            const thread =
              THREADS.find((t) => threadIdOf(t) === scope.thread.threadId) ?? scope.thread.threadId;
            const session = issued.findIndex(
              (i) => i.providerSessionId === scope.thread.providerSessionId,
            );
            outcome = `thread ${thread}, session of token ${session}`;
            break;
          }
          case "touch":
            yield* registry.touch(threadIdOf(action.thread));
            outcome = "done";
            break;
          case "revokeThread":
            yield* registry.revokeThread(threadIdOf(action.thread));
            outcome = "done";
            break;
          case "revokeProviderSession":
            yield* registry.revokeProviderSession(issued[action.token]!.providerSessionId);
            outcome = "done";
            break;
          case "revokeAll":
            yield* registry.revokeAll;
            outcome = "done";
            break;
          case "advance":
            now += action.ms;
            outcome = "done";
            break;
        }
      }
      return outcome;
    }).pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );

/**
 * Two states are the same when every credential behaves the same from here on: revoked ones never resolve again,
 * and ages past the window are all alike (only a touch revives them).
 */
const abstractKey = (state: State): string =>
  JSON.stringify({
    tokens: state.tokens.map((t) =>
      t.revoked ? "revoked" : [t.thread, Math.min(state.now - t.lastAliveAt, WINDOW_MS + 1)],
    ),
    agrees: state.expected === state.observed,
  });

it("a registry credential resolves iff issued, unrevoked and alive within 24 h, and only as its own thread and session", () => {
  const init: State = {
    now: 1_000_000,
    tokens: [],
    log: [],
    expected: "nothing ran",
    observed: "nothing ran",
  };
  const verdict = check<State>({
    init: [init],
    next: (state) =>
      enabled(state).map((action): Step<State> => {
        const log = [...state.log, action];
        return {
          action: describe(action),
          state: { ...modelStep(state, action), log, observed: replay(log) },
        };
      }),
    invariants: {
      "the real registry answers as the reference model": (state) =>
        state.expected === state.observed,
    },
    key: abstractKey,
    maxDepth: MAX_DEPTH,
  });
  if (verdict.ok) {
    console.log(
      `McpSessionRegistry: ${verdict.states} abstract states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive=${verdict.exhaustive} (bounded by maxDepth ${MAX_DEPTH}, ${MAX_TOKENS} credentials)`,
    );
  }
  assertHolds(verdict, {
    requireExhaustive: false,
    show: (state) =>
      `model says ${state.expected}; registry says ${state.observed}; credentials ${JSON.stringify(state.tokens.map((t) => ({ thread: t.thread, ageMs: state.now - t.lastAliveAt, revoked: t.revoked })))}`,
  });
  expect(verdict.ok).toBe(true);
});
