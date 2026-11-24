// ), apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.test.ts @ ab3a3cd1.
// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";

import { AgentScope } from "@caveman-app/shared/AgentScope";
import { ProviderEventLoggers } from "@caveman-app/engine-core/server/ProviderEventLoggers";
import { makeProviderFailure } from "@caveman-app/engine-core/server/failure";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { signalProcessGroup } from "@caveman-app/engine-core/server/processGroup";
import * as PortScanner from "../../preview/PortScanner.ts";
import { StalledMcpServers } from "../../plugins/StalledMcpServers.ts";
import {
  CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryOpenInput,
  layerQueryRunner,
  spawnClaudeProcessGroup,
} from "./ClaudeAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

it.effect("logs successful task stops for replay and omits failed stops", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const stopTask = vi.fn(async (_taskId: string) => {});
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      stopTask,
    } as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const threadId = ThreadId.make("thread-stop");
    const providerSessionId = ProviderSessionId.make("session-stop");
    yield* Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId,
        providerSessionId,
        options: {
          sessionId: "native-session-stop",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      writes.length = 0;
      yield* session.stopTask("workflow-task");
      assert.deepEqual(stopTask.mock.calls, [["workflow-task"]]);
      assert.deepEqual(writes, [
        {
          provider: "claudeAgent",
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId,
          event: {
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.stop_task", taskId: "workflow-task" },
          },
        },
      ]);
      stopTask.mockRejectedValueOnce(new Error("Stop failed"));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(session.stopTask("failed-task"))));
      assert.equal(writes.length, 1);
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, {
              native: {
                filePath: "/tmp/events.log",
                write: (event) =>
                  Effect.sync(() => {
                    writes.push(event);
                  }),
                close: () => Effect.void,
              },
              canonical: undefined,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const realQueryRunner = layerQueryRunner.pipe(
  Layer.provide(PortScanner.layerTest),
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const RESUMED_SESSION_ID = "native-session-restart-registration";
const resumedMcpQueryInput = {
  threadId: ThreadId.make("thread-restart-registration"),
  providerSessionId: ProviderSessionId.make("session-restart-registration"),
  options: {
    resume: RESUMED_SESSION_ID,
    model: "claude-sonnet-4-6",
    tools: [],
    permissionMode: "default",
    mcpServers: {
      "caveman-code": {
        type: "http",
        url: "http://localhost:3773/mcp",
        headers: { Authorization: "Bearer test-mcp-credential" },
      },
    },
  },
} satisfies ClaudeAgentSdkQueryOpenInput;

it.effect("reopens a stalled MCP registration before delivering the resumed prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const prompts: AsyncIterable<ClaudeSdk.SDKUserMessage>[] = [];
      const firstClose = vi.fn();
      const secondClose = vi.fn();
      const firstRegistration = vi.fn(() => {
        registrationStarted.resolve();
        return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
      });
      const secondRegistration = vi.fn(async () => ({
        added: ["caveman-code"],
        removed: [],
        errors: {},
      }));
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ prompt }) => {
        if (typeof prompt === "string") throw new Error("Expected streaming input");
        prompts.push(prompt);
        return {
          setMcpServers: prompts.length === 1 ? firstRegistration : secondRegistration,
          close: prompts.length === 1 ? firstClose : secondClose,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner.open(resumedMcpQueryInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      const session = yield* Fiber.join(opening);
      yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));

      assert.equal(firstClose.mock.calls.length, 1);
      assert.equal(secondClose.mock.calls.length, 0);
      assert.equal(querySpy.mock.calls.length, 2);
      for (const [call] of querySpy.mock.calls) {
        assert.equal(call.options?.resume, RESUMED_SESSION_ID);
        assert.isUndefined(call.options?.mcpServers);
      }
      assert.deepEqual(secondRegistration.mock.calls, [[resumedMcpQueryInput.options.mcpServers]]);
      const message = {
        type: "user",
        message: { role: "user", content: "Continue where you left off." },
        parent_tool_use_id: null,
        session_id: RESUMED_SESSION_ID,
      } satisfies ClaudeSdk.SDKUserMessage;
      yield* session.offer(message);
      // The stalled CLI's prompt stream is closed: the prompt reaches only the new one.
      assert.isTrue((yield* Effect.promise(() => prompts[0]![Symbol.asyncIterator]().next())).done);
      const delivered = yield* Effect.promise(() => prompts[1]![Symbol.asyncIterator]().next());
      assert.deepEqual(delivered.value, message);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect.each([true, false])("only retries after the stalled CLI exits: %s", (exits) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const cleanupProgress = Promise.withResolvers<"kill" | "retry">();
      const events = new NodeEvents.EventEmitter();
      const stdin = new NodeStream.PassThrough();
      const stdout = new NodeStream.PassThrough();
      const child = {
        stdin,
        stdout,
        killed: false,
        exitCode: null,
        kill: vi.fn(() => {
          cleanupProgress.resolve("kill");
          return true;
        }),
        on: events.on.bind(events),
        once: events.once.bind(events),
        off: events.off.bind(events),
      } satisfies ClaudeSdk.SpawnedProcess;
      const signal = yield* Effect.abortSignal;
      const closed = vi.fn();
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
        const first = querySpy.mock.calls.length === 1;
        if (first) {
          options?.spawnClaudeCodeProcess?.({ command: "claude", args: [], env: {}, signal });
        } else {
          cleanupProgress.resolve("retry");
        }
        return {
          setMcpServers: () => {
            registrationStarted.resolve();
            return first
              ? new Promise<ClaudeSdk.McpSetServersResult>(() => {})
              : Promise.resolve({ added: ["caveman-code"], removed: [], errors: {} });
          },
          close: closed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          querySpy.mockRestore();
          stdin.destroy();
          stdout.destroy();
        }),
      );
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner
        .open({
          ...resumedMcpQueryInput,
          options: { ...resumedMcpQueryInput.options, spawnClaudeCodeProcess: () => child },
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");

      assert.equal(yield* Effect.promise(() => cleanupProgress.promise), "kill");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.deepEqual(child.kill.mock.calls, [["SIGKILL"]]);
      if (exits) events.emit("exit", null, "SIGKILL");
      else yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(opening);
      assert.equal(Exit.isSuccess(result), exits);
      if (Exit.isSuccess(result)) yield* result.value.close;
      assert.equal(querySpy.mock.calls.length, exits ? 2 : 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("stops retrying MCP registration after two timeouts and reports the cause", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstRegistration = Promise.withResolvers<void>();
      const secondRegistration = Promise.withResolvers<void>();
      const closed = vi.fn();
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(() => {
        const started = querySpy.mock.calls.length === 1 ? firstRegistration : secondRegistration;
        return {
          setMcpServers: () => {
            started.resolve();
            return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
          },
          close: closed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner
        .open(resumedMcpQueryInput)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => firstRegistration.promise);
      yield* TestClock.adjust("90 seconds");
      yield* Effect.promise(() => secondRegistration.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(querySpy.mock.calls.length, 2);
      assert.equal(closed.mock.calls.length, 2);
      assert.equal(
        makeProviderFailure({
          cause: { _tag: "ProviderAdapterTurnStartError", cause: result.failure },
        }).message,
        "Claude Agent timed out while registering its MCP tools. Retry the turn; if it keeps failing, check Claude Agent and the runtime logs.",
      );
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("does not reuse a fresh session ID after MCP registration times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const closed = vi.fn();
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            setMcpServers: () => {
              registrationStarted.resolve();
              return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
            },
            close: closed,
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const { resume, ...options } = resumedMcpQueryInput.options;
      const opening = yield* runner
        .open({ ...resumedMcpQueryInput, options: { ...options, sessionId: resume } })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, "Failure");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.equal(closed.mock.calls.length, 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

/** Writes an executable stand-in for the Claude CLI into a fresh directory. */
function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId: ThreadId.make("thread-fake-cli"),
      providerSessionId: ProviderSessionId.make("session-fake-cli"),
      options: {
        sessionId: "native-session-fake-cli",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // The CLI stops the MCP servers it started, but not their children: a
  // plugin's `bun server.ts` outlives its `bun run` wrapper (#3089). The fake
  // CLI leaves a child running the same way. The child holds a FIFO open, so
  // its death reads as end-of-file here, with no polling.
  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // Only does anything when the test fails: do not leak its child.
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();

      const stopped = yield* Deferred.make<string>();
      const session = yield* openFakeCli(cli).pipe(
        Effect.provide(
          realQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(AgentScope, {
                ...AgentScope.defaultValue(),
                wrap: ({ command, args }) =>
                  Effect.succeed({ command, args, unit: "t3code-claude-test.scope" }),
                stop: (unit) => Deferred.succeed(stopped, unit).pipe(Effect.asVoid),
              }),
            ),
          ),
        ),
      );
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
      assert.strictEqual(yield* Deferred.await(stopped), "t3code-claude-test.scope");
    }),
  );

  const rootRefusal =
    "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";

  const startupFailureMessage = (stderr: string) =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(`printf '%s\\n' '${stderr}' >&2\nexit 1`);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(NodePath.dirname(cli), { recursive: true, force: true })),
      );
      const session = yield* openFakeCli(cli);
      const exit = yield* Stream.runDrain(session.messages).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      return Exit.isFailure(exit)
        ? makeProviderFailure({ cause: exit.cause, class: "transport_error" }).message
        : "";
    });

  // Claude Code refuses bypassPermissions as root and explains why only on
  // stderr, so the turn failure has to carry that line.
  it.effect("reports the CLI's root refusal when it exits before answering", () =>
    Effect.gen(function* () {
      assert.include(yield* startupFailureMessage(rootRefusal), rootRefusal);
    }).pipe(Effect.provide(realQueryRunner)),
  );

  // Startup stderr can carry paths, tokens, or settings, so only the known
  // refusal reaches the failure the client shows.
  it.effect("keeps other startup stderr out of the turn failure", () =>
    Effect.gen(function* () {
      const surrounded = yield* startupFailureMessage(
        `token=sk-private-123\n${rootRefusal}\nat /home/private/settings.json`,
      );
      assert.include(surrounded, rootRefusal);
      assert.notInclude(surrounded, "sk-private-123");
      assert.notInclude(surrounded, "/home/private");

      const unknown = yield* startupFailureMessage("token=sk-private-123");
      assert.notInclude(unknown, "sk-private-123");
    }).pipe(Effect.provide(realQueryRunner)),
  );

  // The CLI keeps running its turn after its pipes close, so a runtime that
  // crashed would leave it working next to the session it resumes (#23370).
  it.effect("stops the CLI when the runtime that started it goes away", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(['dir=$(dirname "$0")', 'sleep 600 > "$dir/alive"'].join("\n"));
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      const child = spawnClaudeProcessGroup({
        command: cli,
        args: [],
        cwd: dir,
        env: process.env,
        signal: new AbortController().signal,
      }) as NodeChildProcess.ChildProcess;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            signalProcessGroup(child.pid ?? 0, "SIGKILL");
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const turnStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const turnStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();
      yield* Effect.promise(() => turnStarted);

      // A dying runtime's descriptors close; the kernel would do this for it.
      for (const pipe of child.stdio) pipe?.destroy();
      yield* Effect.promise(() => turnStopped);
    }),
  );

  it.effect("marks the CLI's jobs with its thread and counts it as an agent until it exits", () => {
    let runningAgents = 0;
    let releaseAgent!: () => void;
    const agentReleased = new Promise<void>((resolve) => (releaseAgent = resolve));
    const runner = layerQueryRunner.pipe(
      Layer.provide(
        Layer.mock(PortScanner.PortDiscovery)({
          trackAgent: () => {
            runningAgents += 1;
            return () => {
              runningAgents -= 1;
              releaseAgent();
            };
          },
        }),
      ),
      Layer.provide(
        Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    return Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          `printf '%s' "$${PortScanner.AGENT_THREAD_ENV}" > "$dir/thread"`,
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "thread")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const threadRead = new Promise<string>((resolve) => {
        let thread = "";
        NodeFS.createReadStream(NodePath.join(dir, "thread"), "utf8")
          .on("data", (chunk) => (thread += chunk))
          .once("end", () => resolve(thread));
      });

      const session = yield* openFakeCli(cli);
      assert.equal(yield* Effect.promise(() => threadRead), "thread-fake-cli");
      assert.equal(runningAgents, 1);
      yield* session.close;
      yield* Effect.promise(() => agentReleased);
      assert.equal(runningAgents, 0);
    }).pipe(Effect.provide(runner));
  });
});

it.effect("records each registration's reply, a clean one too, at the start and on a live change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const recorded: Array<{
        readonly threadId: string;
        readonly servers: ReadonlyArray<string>;
        readonly added: ReadonlyArray<string>;
        readonly errors: Readonly<Record<string, string>>;
      }> = [];
      const timeout = 'MCP server "slow" connection timed out after 30000ms';
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
        setMcpServers: vi
          .fn()
          .mockResolvedValueOnce({ added: ["caveman-code", "slow"], removed: [], errors: { slow: timeout } })
          .mockResolvedValueOnce({ added: ["slow"], removed: ["caveman-code"], errors: {} }),
        close: vi.fn(),
      } as unknown as ClaudeSdk.Query);
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const slow = { type: "stdio" as const, command: "/plugins/slow/server" };
      yield* Effect.gen(function* () {
        const runner = yield* ClaudeAgentSdkQueryRunner;
        const session = yield* runner.open({
          ...resumedMcpQueryInput,
          options: { ...resumedMcpQueryInput.options, mcpServers: { ...resumedMcpQueryInput.options.mcpServers, slow } },
        });
        yield* session.setMcpServers!({ slow });
        yield* session.close;
      }).pipe(
        Effect.provide(
          layerQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(StalledMcpServers, {
                list: Effect.succeed([]),
                record: (threadId, servers, { added, errors }) =>
                  Effect.sync(() => void recorded.push({ threadId, servers: Object.keys(servers), added, errors })),
                tellLeftOut: () => Effect.void,
                answered: () => Effect.void,
                retry: () => Effect.void,
                stalls: Stream.empty,
              }),
            ),
            Layer.provide(PortScanner.layerTest),
            Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      assert.deepEqual(recorded, [
        { threadId: resumedMcpQueryInput.threadId, servers: ["caveman-code", "slow"], added: ["caveman-code", "slow"], errors: { slow: timeout } },
        // A clean reply too: a server it added without a timeout is forgotten.
        { threadId: resumedMcpQueryInput.threadId, servers: ["slow"], added: ["slow"], errors: {} },
      ]);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
