// ), apps/server/src/textGeneration/CodexTextGeneration.ts @ ab3a3cd1.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ServerProviderModel,
  TextGenerationError,
} from "@caveman-app/protocol";
import { resolveSpawnCommand } from "@caveman-app/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@caveman-app/engine-core/server/pathExpansion";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { routeCodexTextGeneration } from "../secrets/EngineEgress.ts";
import { withEngineKey } from "../cloudLink/engineKeys.ts";
import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import type { TextGenerationUsage } from "@caveman-app/engine-core/server/textGeneration";
import * as TextGenerationOperations from "@caveman-app/engine-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@caveman-app/engine-core/server/textGenerationUtils";
import { codexModelFamily, getModelSelectionStringOptionValue } from "@caveman-app/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import * as HostProcess from "@caveman-app/shared/HostProcess";

const CODEX_TIMEOUT_MS = 180_000;
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
// Plugins and apps bring MCP servers of their own; the user's are listed and
// turned off by name below. These follow the user's launch args, so they win
// over a `-c features.plugins=true` there, which `--disable plugins` does not.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
// The person's own Codex memory (their `[memories]`) would put their terminal
// memory summary, about 4K tokens, in front of every title or commit message.
const CODEX_NO_MEMORY_ARGS = [
  "--config",
  "memories.use_memories=false",
  "--config",
  "memories.generate_memories=false",
] as const;
// The person's hooks never run on a text-generation call, as Claude's disableAllHooks.
const CODEX_NO_HOOK_ARGS = ["--config", "features.hooks=false"] as const;
// A prompt-only call (everything but an investigation) needs no tools and none of the agent's instructions for
// using them. Measured on codex-cli 0.165 for one title: 17.0K input tokens down to 8.6K, most of it the person's
// skills list (~5.5K) and tool definitions. What is left is Codex's own base instructions, the same on every call,
// so a title after the first reads them from the prompt cache.
const CODEX_PROMPT_ONLY_ARGS = [
  ...["skills.include_instructions", "include_collaboration_mode_instructions", "include_permissions_instructions", "include_environment_context"].flatMap(
    (key) => ["--config", `${key}=false`],
  ),
  ...[
    "multi_agent",
    "shell_tool",
    "unified_exec",
    "image_generation",
    "goals",
    "skill_search",
    "tool_suggest",
    "view_image",
    "computer_use",
    "browser_use",
    "in_app_browser",
    "sleep_tool",
    "skill_mcp_dependency_install",
    "workspace_dependencies",
  ].flatMap((feature) => ["--config", `features.${feature}=false`]),
  "--config",
  'web_search="disabled"',
] as const;
const CodexMcpServers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);
const decodeCodexMcpServers = Schema.decodeEffect(CodexMcpServers);

/**
 * The `--config` value that turns off each MCP server Codex would start.
 * `mcp_servers={}` merges into the user's servers rather than replacing them,
 * so each is named; quoting the name keeps one with a dot a single key.
 */
const codexMcpServersOff = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
/**
 * Build a Codex text-generation closure bound to a specific `CodexSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
/** The usage on the last `turn.completed` event of `codex exec --json`, if any. */
export function codexTurnUsage(stdout: string): TextGenerationUsage | undefined {
  let found: TextGenerationUsage | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.includes('"turn.completed"')) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
      };
      if (event.type !== "turn.completed" || !event.usage) continue;
      const cached = event.usage.cached_input_tokens ?? 0;
      // Codex counts cached tokens inside input_tokens.
      found = {
        inputTokens: Math.max(0, (event.usage.input_tokens ?? 0) - cached),
        outputTokens: event.usage.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      };
    } catch {
      // Not an event line.
    }
  }
  return found;
}

export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  resolveRuntime?: Effect.Effect<
    import("../orchestration-v2/Adapters/CodexAdapterV2.ts").CodexEffectiveRuntime,
    import("@caveman-app/protocol").ProviderSetupError,
    Scope.Scope
  >,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;
  // Titles, commit messages and PR text carry session content: through the project-secrets egress scrub.
  const egress = yield* Effect.serviceOption(EgressRoute);

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const removeTempFileDir = (filePath: string): Effect.Effect<void, never> =>
    fileSystem
      .remove(path.dirname(filePath), { recursive: true })
      .pipe(Effect.catch(() => Effect.void));

  // Deliberately unscoped: text generation runs from background fibers whose
  // ambient scope may already be closed (a closed scope reaps the temp
  // directory the moment it is created). Each allocation removes its own
  // directory on failure; success-path cleanup is explicit in runCodexJson.
  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> =>
    fileSystem
      .makeTempFile({
        prefix: `t3code-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) =>
          fileSystem
            .writeFileString(filePath, content)
            .pipe(Effect.onError(() => removeTempFileDir(filePath))),
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
  ) {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  });

  /**
   * The MCP servers Codex would start for this configuration, by name. Text
   * generation goes ahead with them listed as none if Codex cannot list them.
   */
  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
    }) {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binary,
        [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"],
        { env: input.env },
      );
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawnCommand.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
          reason: "exit",
          exitCode,
        });
        return [];
      }
      const servers = yield* decodeCodexMcpServers(stdout).pipe(
        Effect.tapError(() =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "decode",
          }),
        ),
      );
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "timeout",
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    attachments,
    investigate,
    onUsage,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"]
  > {
    const imagePaths = yield* materializeImageAttachments(attachments);
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "").pipe(
      Effect.onError(() => removeTempFileDir(schemaPath)),
    );

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const resolved = resolveRuntime
        ? yield* resolveRuntime.pipe(
            Effect.mapError(
              (cause) => new TextGenerationError({ operation, detail: cause.detail }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const model =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        models.find(
          (candidate) => !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
        )?.slug ??
        requestedModel;
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier = resolved ? undefined : getCodexServiceTierOptionValue(modelSelection);
      const binary = effectiveConfig.binaryPath || "codex";
      const home = {
        ...effectiveEnvironment,
        ...(effectiveConfig.homePath
          ? {
              CODEX_HOME: expandHomePath(
                effectiveConfig.homePath,
                yield* HostProcess.HomeDirectory,
              ),
            }
          : {}),
      };
      // On a Cloud computer codex holds stand-ins here too (cloudLink/engineKeys.ts), for the login its person chose:
      // its followed sign-in's auth.json in this CODEX_HOME and its refresh route, or the vault key's stand-in; one
      // that can't serve fails this rather than run on another. Elsewhere nothing changes.
      const env = {
        ...((yield* withEngineKey("codex", home).pipe(
          Effect.mapError((cause) => new TextGenerationError({ operation, detail: cause.message, cause })),
        )) ?? home),
      };
      const routing = yield* routeCodexTextGeneration({ egress, env, launchArgs, cwd }).pipe(
        Effect.mapError((cause) => new TextGenerationError({ operation, detail: cause.message, cause })),
      );
      Object.assign(env, routing.env);
      // Titles, problem reports and chat picks need only the supplied prompt (as Claude's): not the checkout's AGENTS.md, which would add
      // its tokens to every call and could send the model reading the repository. The egress check above still reads the
      // real cwd.
      const workingDirectory =
        (operation === "generateThreadTitle" || operation === "generateBugReport" || operation === "findChats")
          ? yield* fileSystem
              .makeTempDirectoryScoped({ prefix: "caveman-codex-title-" })
              .pipe(Effect.mapError((cause) => normalizeCliError("codex", operation, cause, "Failed to create title directory")))
          : cwd;
      // Last, so the user's launch arguments cannot pick another provider.
      const execLaunchArgs = [...codexExecLaunchArgs(launchArgs), ...routing.args];
      const mcpServersOff = yield* listEnabledMcpServers({
        binary,
        cwd: workingDirectory,
        env,
        // `codex mcp` rejects --strict-config; the overrides still apply.
        launchArgs: execLaunchArgs.filter((arg) => arg !== "--strict-config"),
      }).pipe(Effect.map(codexMcpServersOff));
      const spawnCommand = yield* resolveSpawnCommand(
        binary,
        [
          "exec",
          ...execLaunchArgs,
          // Text generation needs only the prompt. A user's MCP server would
          // otherwise start and could act on it, as Claude's --strict-mcp-config
          // prevents for Claude.
          ...CODEX_NO_PLUGIN_ARGS,
          ...CODEX_NO_MEMORY_ARGS,
          ...(mcpServersOff ? ["--config", mcpServersOff] : []),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          ...CODEX_NO_HOOK_ARGS,
          ...(investigate ? [] : CODEX_PROMPT_ONLY_ARGS),
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          // Events on stdout, for the usage turn.completed reports; the answer still lands in outputPath.
          ...(onUsage ? ["--json"] : []),
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: effectiveEnvironment },
      ).pipe(Effect.mapError((cause) => normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process")));
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
        forceKillAfter: "1 second",
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
      if (onUsage) {
        const usage = codexTurnUsage(stdout);
        if (usage) onUsage(usage);
      }
    });

    const cleanup = Effect.all([removeTempFileDir(schemaPath), removeTempFileDir(outputPath)], {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        // The read-only sandbox already holds an investigation to reading; it only needs longer.
        Effect.timeoutOption(investigate?.timeoutMs ?? CODEX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  return TextGenerationOperations.fromRunner("CodexTextGeneration", runCodexJson);
});
