// ), apps/server/src/textGeneration/ClaudeTextGeneration.test.ts @ ab3a3cd1.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@caveman-app/protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { createModelSelection } from "@caveman-app/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";

import * as ServerConfig from "../config.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "@caveman-app/engine-core/server/textGenerationUtils";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { followedLogins } from "../cloudLink/engineLogins.ts";
import { writeFakeCli } from "@caveman-app/engine-testing/fakeCli";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const layerClaudeTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The stub behaviour lives in Node so the same implementation runs on Windows,
// where a shebang file is not executable and would fall through to the real
// Claude CLI on PATH; `writeFakeCli` picks the launcher shape per host.
function makeFakeClaudeBinary(dir: string, lifecyclePort?: number) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const binDir = path.join(dir, "bin");
    const fixturePath = yield* path.fromFileUrl(
      new URL("./testing/ClaudeTextGeneration.fixture.mjs", import.meta.url),
    );
    const source = yield* fs.readFileString(fixturePath);
    writeFakeCli({
      directory: binDir,
      name: "claude",
      platform,
      source:
        lifecyclePort === undefined
          ? source
          : `process.on("SIGTERM", () => {}); ${processProbeSource(lifecyclePort)}`,
    });
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    rejectsNoSessionPersistence?: boolean;
    lifecyclePort?: number;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir, input.lifecyclePort);
    const pathDelimiter = (yield* HostProcess.isWindows) ? ";" : ":";
    const previousPath = process.env.PATH;
    const previousRejectsNoSessionPersistence =
      process.env.T3_FAKE_CLAUDE_REJECTS_NO_SESSION_PERSISTENCE;
    const previousOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.T3_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousConfigDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
    const previousCwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${pathDelimiter}${previousPath ?? ""}`;
        process.env.T3_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.rejectsNoSessionPersistence) {
          process.env.T3_FAKE_CLAUDE_REJECTS_NO_SESSION_PERSISTENCE = "1";
        } else {
          delete process.env.T3_FAKE_CLAUDE_REJECTS_NO_SESSION_PERSISTENCE;
        }

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.cwdMustNotBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = input.cwdMustNotBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
        }

        if (input.configDirMustBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = input.configDirMustBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousRejectsNoSessionPersistence === undefined) {
            delete process.env.T3_FAKE_CLAUDE_REJECTS_NO_SESSION_PERSISTENCE;
          } else {
            process.env.T3_FAKE_CLAUDE_REJECTS_NO_SESSION_PERSISTENCE =
              previousRejectsNoSessionPersistence;
          }

          if (previousOutput === undefined) {
            delete process.env.T3_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.T3_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.T3_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDERR;
          } else {
            process.env.T3_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousCwdMustNotBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = previousCwdMustNotBe;
          }

          if (previousConfigDirMustBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = previousConfigDirMustBe;
          }
        }),
    );

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(
      config,
      undefined,
      Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(layerClaudeTextGenerationTest)("ClaudeTextGeneration", (it) => {
  it.effect("kills a stalled CLI when the request times out", () =>
    Effect.gen(function* () {
      const probe = yield* makeProcessProbe;
      yield* withFakeClaudeEnv({ output: "", lifecyclePort: probe.port }, (textGeneration) =>
        Effect.gen(function* () {
          const fiber = yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            })
            .pipe(Effect.flip, Effect.forkScoped);
          yield* probe.started;

          yield* TestClock.adjust("180 seconds");
          yield* probe.exited;
          expect((yield* Fiber.join(fiber)).detail).toBe("Claude Agent request timed out.");
        }),
      );
    }),
  );

  it.effect.each([
    { thinking: true, settings: '{"disableAllHooks":true,"alwaysThinkingEnabled":true}' },
    { thinking: false, settings: '{"disableAllHooks":true,"alwaysThinkingEnabled":false}' },
    { thinking: undefined, settings: '{"disableAllHooks":true}' },
  ])("forwards only the explicit thinking choice ($thinking)", ({ thinking, settings }) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: `--settings ${settings}`,
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              SYNTHETIC_CLAUDE_THINKING_MODEL,
              [
                ...(thinking === undefined ? [] : [{ id: "thinking", value: thinking }]),
                { id: "effort", value: "high" },
              ],
            ),
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("hands claude a followed sign-in's stand-in, never its real token (Cloud computer)", () => {
    // The real token is assembled here so the fixture's own env check (it holds the same string) cannot match it.
    const real = ["sk-ant-oat01", "real-access-for-text-generation"].join("-");
    followedLogins.connect({
      cloud: {
        list: async () => [],
        lanes: async () => ({ lanes: { "claude-agent": "followed_login" }, followed: ["claude-agent"] }),
        get: async () => ({ engine: "claude", version: 1, status: "ready", access_token: real, expires_at: new Date(Date.now() + 3_600_000).toISOString(), profile: { subscription_type: "max" } }),
        refresh: async () => {
          throw new Error("no refresh in this test");
        },
        put: async () => ({ version: 1 }),
        remove: async () => undefined,
      },
      files: { read: async () => undefined, write: async () => undefined, removeStandIn: async () => undefined },
      paths: { claude: async () => "/nonexistent/.claude/.credentials.json", codex: async () => "/nonexistent/auth.json" },
    });
    return Effect.acquireRelease(
      Effect.sync(() => {
        process.env.T3_FAKE_CLAUDE_OAUTH_TOKEN_MUST_BE = followedLogins.claudeStandIn.access;
        process.env.T3_FAKE_CLAUDE_ENV_MUST_NOT_CONTAIN = "real-access-for-text-generation";
      }),
      () =>
        Effect.sync(() => {
          delete process.env.T3_FAKE_CLAUDE_OAUTH_TOKEN_MUST_BE;
          delete process.env.T3_FAKE_CLAUDE_ENV_MUST_NOT_CONTAIN;
        }),
    ).pipe(
      Effect.andThen(
        withFakeClaudeEnv({ output: JSON.stringify({ structured_output: { subject: "Use the followed sign-in", body: "" } }) }, (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/followed",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), SYNTHETIC_CLAUDE_STANDARD_MODEL),
            });
            expect(generated.subject).toBe("Use the followed sign-in");
          }),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect("keeps a configured custom alias opaque to the Claude CLI", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Keep custom model",
            body: "",
          },
        }),
        argsMustContain: `--model ${SYNTHETIC_CLAUDE_COLLIDING_ALIAS} --effort max --settings`,
        claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/custom-model",
            commitSummary: "Keep custom model",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
              [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
                { id: "contextWindow", value: "expanded" },
              ],
            ),
          });

          expect(generated.title).toBe("Keep custom model");
        }),
    ),
  );

  it.effect(
    "keeps canonical built-in capabilities when a custom model collides with its alias",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Improve orchestration flow",
              body: "Body",
            },
          }),
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort max --settings {"disableAllHooks":true,"fastMode":true}`,
          claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/claude-effect",
              commitSummary: "Improve orchestration",
              diffSummary: "1 file changed",
              diffPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                ...createModelSelection(
                  ProviderInstanceId.make("claudeAgent"),
                  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
                  [
                    { id: "effort", value: "max" },
                    { id: "fastMode", value: true },
                  ],
                ),
              },
            });

            expect(generated.title).toBe("Improve orchestration flow");
          }),
      ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "/call-script",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(
              sanitizeThreadTitle(
                '"Reconnect failures after restart because the session state does not recover"',
              ),
            );
          }),
      ),
  );

  it.effect("generates branch names from skill prompts without executable capabilities", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { branch: "call-script" } }),
        stdinMustContain: "/call-script",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "/call-script",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.branch).toBe("call-script");
        }),
    ),
  );

  it.effect("writes a single-pass guide with no tools and reports the run's usage", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            tldr: "Adds search.",
            overview: "what: search\nwhy: asked",
            before_after: { title: "Search", rows: [{ op: "+", depth: 0, text: "search", stop: null }] },
            stops: [],
          },
          usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 50, cache_creation_input_tokens: 7 },
          total_cost_usd: 0.004,
        }),
        argsMustContain: "--tools ",
        argsMustNotContain: "Bash(git diff:*)",
        stdinMustContain: "<diff>",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const usages: Array<unknown> = [];
          const guide = yield* textGeneration.generateReviewGuide({
            cwd: process.cwd(),
            number: 1,
            title: "Add search",
            description: "",
            baseBranch: "main",
            baseCommit: "abc",
            settledReview: "",
            diff: "diff --git a/a b/a\n",
            onUsage: (usage) => usages.push(usage),
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });
          expect(guide.tldr).toBe("Adds search.");
          expect(guide.beforeAfter?.rows).toEqual([{ op: "+", depth: 0, text: "search" }]);
          expect(usages).toEqual([
            { inputTokens: 900, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 7, costUsd: 0.004 },
          ]);
        }),
    ),
  );

  it.effect("sends thread title instructions to the provider prompt", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        stdinMustContain: "Additional instructions:\nUse two to four words.",
      },
      (textGeneration) =>
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Investigate reconnect failures",
          instructions: "Use two to four words.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
          },
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("retries without --no-session-persistence when the Claude CLI rejects it", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        rejectsNoSessionPersistence: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Investigate reconnect failures",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Reconnect failures");
        }),
    ),
  );

  it.effect.each([
    { verbose: false, label: "normal" },
    { verbose: true, label: "verbose" },
  ])("unwraps a JSON title in $label Claude output", ({ verbose }) => {
    const result = {
      type: "result",
      structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
    };
    return withFakeClaudeEnv(
      { output: JSON.stringify(verbose ? [result] : result) },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
        }),
    );
  });

  it.effect.each([
    { previousTitle: undefined, label: "generating" },
    { previousTitle: "Old thread title", label: "regenerating" },
  ])("reads the result from verbose Claude output when $label a title", ({ previousTitle }) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify([
          { type: "system", subtype: "init" },
          { type: "assistant", message: { content: [] } },
          { type: "user", message: { content: [] } },
          { type: "rate_limit_event" },
          {
            type: "result",
            subtype: "success",
            result: '{"title":"Refresh ev-stg APP ASG Instances"}',
            structured_output: { title: "Refresh ev-stg APP ASG Instances" },
          },
        ]),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            previousTitle,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG Instances");
        }),
    ),
  );

  it.effect.each([
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const)("rejects verbose Claude output with %s", ([, output]) =>
    withFakeClaudeEnv({ output: JSON.stringify(output) }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error._tag).toBe("TextGenerationError");
      }),
    ),
  );

  const apiError = "API Error: 400 Model blocked by guardrail: 4 endpoints excluded";
  const wrapperNotice = "Using the OpenRouter credential from the global credential file.";
  it.effect.each([
    [
      "the stdout error over a stderr notice",
      JSON.stringify({ is_error: true, api_error_status: 400, result: apiError }),
      apiError,
    ],
    [
      "the verbose stdout error over a stderr notice",
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "result", is_error: true, result: apiError },
        { type: "result", is_error: true, result: " " },
      ]),
      apiError,
    ],
    ["stderr when stdout has no error", "not json", wrapperNotice],
    [
      "a stdout error naming --no-session-persistence without retrying",
      JSON.stringify({
        is_error: true,
        result: "error: unknown option '--no-session-persistence'",
      }),
      "error: unknown option '--no-session-persistence'",
    ],
  ] as const)("reports %s when the Claude CLI fails", ([, output, expected]) =>
    withFakeClaudeEnv({ output, stderr: wrapperNotice, exitCode: 1 }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error.detail).toBe(`Claude Agent command failed: ${expected}`);
      }),
    ),
  );

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );
});
