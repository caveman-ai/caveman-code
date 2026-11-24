// ), apps/server/src/textGeneration/ClaudeTextGeneration.ts @ ab3a3cd1.
/**
 * ClaudeTextGeneration – Text generation layer using the Claude CLI.
 *
 * Implements the same TextGeneration service contract as CodexTextGeneration but
 * delegates to the `claude` CLI (`claude -p`) with structured JSON output
 * instead of the `codex exec` CLI.
 *
 * @module ClaudeTextGeneration
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type ClaudeSettings, TextGenerationError } from "@caveman-app/protocol";
import { resolveSpawnCommand } from "@caveman-app/shared/shell";
import { routeClaudeTextGeneration } from "../secrets/EngineEgress.ts";
import { withEngineKey } from "../cloudLink/engineKeys.ts";

import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import * as TextGenerationOperations from "@caveman-app/engine-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@caveman-app/engine-core/server/textGenerationUtils";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@caveman-app/shared/model";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogUltracodeEffort,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import {
  hasClaudeManagedMcpConfig,
  makeClaudeEnvironment,
} from "../provider/Drivers/ClaudeHome.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
/** The tools an investigation can see. `--tools` takes bare names; patterns go in the allow list. */
const CLAUDE_INVESTIGATION_TOOLS = "Read,Grep,Glob,Bash";
/** What it may run without asking. In dontAsk mode every other call, Bash included, is refused. */
const CLAUDE_INVESTIGATION_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
].join(",");
/**
 * The allowed git commands accept any trailing arguments, and `--output` makes each of them write
 * a file anywhere. Deny rules win over allow rules, so this keeps the investigation read-only.
 */
const CLAUDE_INVESTIGATION_DENIED = ["Bash(git * --output*)", "Bash(git * -o *)"].join(",");

/**
 * Schema for the wrapper JSON returned by `claude -p --output-format json`.
 * Verbose mode wraps the result in an array of conversation messages.
 */
const ClaudeUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.Number),
  output_tokens: Schema.optionalKey(Schema.Number),
  cache_read_input_tokens: Schema.optionalKey(Schema.Number),
  cache_creation_input_tokens: Schema.optionalKey(Schema.Number),
});
const NO_SESSION_PERSISTENCE = "--no-session-persistence";
// Claude Code before 2.0.63 exits with this on stderr; those runs retry without the flag.
const NO_SESSION_PERSISTENCE_REJECTED = `error: unknown option '${NO_SESSION_PERSISTENCE}'`;

const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
  usage: Schema.optionalKey(ClaudeUsage),
  total_cost_usd: Schema.optionalKey(Schema.Number),
});
const ClaudeOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
  usage: Schema.optionalKey(ClaudeUsage),
  total_cost_usd: Schema.optionalKey(Schema.Number),
});
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

const ClaudeErrorResult = Schema.Struct({ is_error: Schema.Literal(true), result: Schema.String });
const isClaudeErrorResult = Schema.is(ClaudeErrorResult);
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The error a failed `claude -p --output-format json` run reports on stdout. Stderr may only
 * hold notices from a wrapper around the binary, so the caller prefers this when present.
 */
function claudeErrorResult(stdout: string): string | undefined {
  const output = Option.getOrUndefined(decodeJsonOption(stdout));
  const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
  return messages
    .filter(isClaudeErrorResult)
    .map((message) => message.result.trim())
    .findLast((result) => result.length > 0);
}

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<ClaudeModelCatalog> = Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  // Titles, commit messages and PR text carry session content: through the project-secrets egress scrub.
  const egress = yield* Effect.serviceOption(EgressRoute);
  const scopedModelCatalog = modelCatalog.pipe(
    Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)),
  );

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
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  /**
   * Spawn the Claude CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    investigate,
    onUsage,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"]
  > {
    const catalog = yield* scopedModelCatalog;
    const resolvedModelSelection = {
      ...modelSelection,
      model: resolveClaudeModelSlug(catalog, modelSelection.model),
    };
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    const caps = getClaudeCatalogModelCapabilities(catalog, resolvedModelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: resolvedModelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(resolvedModelSelection, "effort");
    const resolvedEffort = resolveClaudeCatalogEffort(
      catalog,
      resolvedModelSelection.model,
      rawEffortSelection,
    );
    const cliEffort = normalizeClaudeCatalogEffort(
      catalog,
      resolvedEffort,
      resolvedModelSelection.model,
    );
    const ultracode = isClaudeCatalogUltracodeEffort(resolvedEffort);
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    // Only a chosen value; otherwise Claude Code's own default applies, as in chat turns.
    const thinking =
      thinkingDescriptor?.type === "boolean"
        ? getModelSelectionBooleanOptionValue(resolvedModelSelection, "thinking")
        : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const settings = {
      disableAllHooks: true,
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
      ...(ultracode ? { ultracode: true } : {}),
    };
    // On a Cloud computer claude holds stand-ins here too, for the login its person chose: their sign-in that follows
    // them, or their vault key (cloudLink/engineKeys.ts); one that can't serve fails this rather than run on another.
    // Elsewhere the environment is as it was.
    const keyedEnvironment = ((yield* withEngineKey("claude-agent", claudeEnvironment).pipe(
      Effect.mapError((cause) => new TextGenerationError({ operation, detail: cause.message, cause })),
    )) ?? claudeEnvironment) as NodeJS.ProcessEnv;
    const routed = yield* routeClaudeTextGeneration({ egress, env: keyedEnvironment, settings, cwd }).pipe(
      Effect.mapError((cause) => new TextGenerationError({ operation, detail: cause.message, cause })),
    );
    const settingsJson = yield* encodeJsonForOperation(
      operation,
      routed.settings,
      "Failed to encode Claude CLI settings.",
    );

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* (
      noSessionPersistence: boolean,
    ) {
      // Titles, problem reports and chat picks need only the supplied prompt, not configuration from the checkout.
      const workingDirectory =
        (operation === "generateThreadTitle" || operation === "generateBugReport" || operation === "findChats")
          ? yield* fileSystem
              .makeTempDirectoryScoped({ prefix: "t3code-claude-title-" })
              .pipe(
                Effect.mapError((cause) =>
                  normalizeCliError("claude", operation, cause, "Failed to create title directory"),
                ),
              )
          : cwd;
      const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeCatalogApiModelId(catalog, resolvedModelSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          "--settings",
          settingsJson,
          // Metadata prompts need no executable capabilities, even when they contain a skill name.
          // An investigation gets the read-only file tools and Git's read commands, and nothing
          // that writes: in dontAsk mode anything not allowed here is refused.
          ...(investigate
            ? [
                "--tools",
                CLAUDE_INVESTIGATION_TOOLS,
                "--allowedTools",
                CLAUDE_INVESTIGATION_ALLOWED,
                "--disallowedTools",
                CLAUDE_INVESTIGATION_DENIED,
              ]
            : ["--tools", ""]),
          "--disable-slash-commands",
          // A title or commit message is a throwaway run: no transcript in ~/.claude/projects.
          ...(noSessionPersistence ? [NO_SESSION_PERSISTENCE] : []),
          // Claude refuses this flag next to a managed-mcp.json, which already keeps the
          // user's own MCP servers out.
          ...(managedMcpConfig ? [] : ["--strict-mcp-config"]),
          "--permission-mode",
          "dontAsk",
        ],
        { env: routed.env },
      ).pipe(Effect.mapError((cause) => normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process")));
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: routed.env,
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
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      return { stdout, stderr, exitCode };
    });

    const rawStdout = yield* runClaudeCommand(true).pipe(
      Effect.filterOrElse(
        (result) =>
          result.exitCode === 0 || !result.stderr.includes(NO_SESSION_PERSISTENCE_REJECTED),
        () => runClaudeCommand(false),
      ),
      Effect.flatMap(({ stdout, stderr, exitCode }) => {
        if (exitCode === 0) return Effect.succeed(stdout);
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail =
          claudeErrorResult(stdoutDetail) ??
          (stderrDetail.length > 0 ? stderrDetail : stdoutDetail);
        return Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Claude Agent command failed: ${detail}`
                : `Claude Agent command failed with code ${exitCode}.`,
          }),
        );
      }),
      Effect.scoped,
      Effect.timeoutOption(investigate?.timeoutMs ?? CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude Agent request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const output = yield* decodeClaudeOutput(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude Agent returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );
    const envelope = isClaudeOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");
    if (onUsage && envelope?.usage) {
      onUsage({
        inputTokens: envelope.usage.input_tokens ?? 0,
        outputTokens: envelope.usage.output_tokens ?? 0,
        cacheReadTokens: envelope.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: envelope.usage.cache_creation_input_tokens ?? 0,
        costUsd: envelope.total_cost_usd,
      });
    }

    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(envelope?.structured_output).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude Agent returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  return TextGenerationOperations.fromRunner("ClaudeTextGeneration", runClaudeJson);
});
