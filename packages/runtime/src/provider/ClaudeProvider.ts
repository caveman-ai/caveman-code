// ), apps/server/src/provider/ClaudeProvider.ts @ ab3a3cd1; perf from 5932c193a0, 76ff0eb2a1, 6e45544850.
import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderSlashCommand,
} from "@caveman-app/protocol";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createModelCapabilities } from "@caveman-app/shared/model";
import { resolveSpawnCommand } from "@caveman-app/shared/shell";
import type {
  ModelInfo as ClaudeModelInfo,
  Options as ClaudeQueryOptions,
  SlashCommand as ClaudeSlashCommand,
  SDKControlGetUsageResponse,
  SDKUserMessage,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { loadClaudeAgentSdk } from "./claudeAgentSdk.ts";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@caveman-app/engine-core/server/snapshotProbe";
import { resolveClaudeSdkExecutablePath, scopeClaudeLaunch } from "./Drivers/ClaudeExecutable.ts";
import { isEngineLoginUnavailable } from "../cloudLink/engineKeys.ts";
import { appProxyUrl } from "../router/proxyLauncher.ts";
import { hasClaudeManagedMcpConfig, makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { discoverClaudeSkills, readClaudeSettingsEnv } from "./Drivers/ClaudeSkills.ts";
import type { ProviderWorkspaceSnapshot } from "@caveman-app/engine-core/server/driver";
import { makeUnavailableUsageLimits } from "@caveman-app/engine-core/server/usageLimits";
import {
  type ClaudeScopedLimitNames,
  claudeUsageResponseToLimits,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  claudeReportedModels,
  formatClaudeVersionUpgradeMessage,
  parseClaudeReportedModels,
  rememberClaudeModels,
  resolveClaudeModelsForVersion,
  resolveClaudeUpdateRequiredModels,
  withReportedClaudeModels,
} from "./ClaudeModelCatalog.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude Agent",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;
function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
    case "claudemax5xsubscription":
      return "Max";
    case "claudemax20xsubscription":
      return "Ultra";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
    case "max5":
      return "Max";
    case "max20":
      return "Ultra";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
  readonly apiKeySource: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey" ||
    (input.apiKeySource && input.apiKeySource !== "none" && (!input.authMethod || input.authMethod === "none"))) {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

/**
 * Whether the SDK's account payload evidences a credential the CLI can use.
 *
 * The capability probe resolves for a logged-out CLI, so a completed probe only
 * proves Claude Code started. `tokenSource: "none"` is the CLI reporting it
 * found no token at all, and is the one shape that disproves authentication.
 * Everything else either names a credential or, on a third-party backend, omits
 * these fields by design because auth lives with AWS or gcloud instead.
 *
 * Silence is deliberately not disproof. Profile-authenticated installs report no
 * token source, and a CLI too old to send an account payload reports nothing at
 * all; treating either as logged out would sign working setups out of Settings.
 * `apiKeySource: "none"` means no API key is in use, so it is no evidence either.
 */
function claudeAuthStatus(
  capabilities: Pick<
    ClaudeCapabilitiesProbe,
    "email" | "subscriptionType" | "tokenSource" | "apiKeySource" | "apiProvider"
  >,
): "authenticated" | "unauthenticated" {
  if (capabilities.apiProvider !== undefined && capabilities.apiProvider !== "firstParty") {
    return "authenticated";
  }
  if (capabilities.tokenSource !== "none") return "authenticated";
  // An `ANTHROPIC_API_KEY` install reports no token source but is authenticated
  // all the same, so the key and account fields still get a say.
  const hasApiKey = Boolean(capabilities.apiKeySource) && capabilities.apiKeySource !== "none";
  return hasApiKey || capabilities.email || capabilities.subscriptionType
    ? "authenticated"
    : "unauthenticated";
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;
// Native CLI startup on Windows can exceed the shared probe deadline.
const CLAUDE_VERSION_CHECK_TIMEOUT_MS = 20_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  /** An administrator's `managed-mcp.json` is installed; see `hasClaudeManagedMcpConfig`. */
  readonly managedMcpConfig: boolean;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config, which
    // Claude refuses next to a managed-mcp.json that already excludes them.
    mcpServers: {},
    ...(input.managedMcpConfig ? {} : { strictMcpConfig: true }),
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // This is a noninteractive health check, so IDE discovery cannot add any
      // useful capability data. Skipping it also avoids Claude spawning a
      // Windows `tasklist | findstr` process tree on every periodic refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

export type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /** Where the CLI found an API key, when it authenticates with one. */
  readonly apiKeySource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly models?: ReadonlyArray<ClaudeModelInfo>;
  /**
   * Subscription windows from the SDK's `get_usage` control request, or
   * `undefined` when the request itself failed. Absent windows on an
   * otherwise successful response mean the account has none (API key).
   */
  readonly usage?: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly usageCheckedAt?: string;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * With gateway model discovery on, Claude Code refreshes its model cache in the background after
 * initialization, so the probe subprocess outlives init by Claude Code's discovery timeout.
 */
function claudeGatewayDiscoveryGraceMs(environment: Readonly<Record<string, unknown>>): number {
  const enabled = String(environment.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "")
    .trim()
    .toLowerCase();
  if (!enabled || enabled === "0" || enabled === "false") return 0;
  if (!String(environment.ANTHROPIC_BASE_URL ?? "").trim()) return 0;
  const configured = Number(environment.CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 3_000;
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  includeUsage = true,
) => {
  const abort = new AbortController();
  const abortProbe = Effect.sync(() => {
    if (!abort.signal.aborted) abort.abort();
  });
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
    // Workspace probes (no usage) discard models; the machine probe refreshes the shared cache.
    const graceMs = includeUsage
      ? claudeGatewayDiscoveryGraceMs({
          ...claudeEnvironment,
          ...(yield* readClaudeSettingsEnv(claudeSettings, cwd, claudeEnvironment)),
        })
      : 0;
    // Started where sessions start (on a Cloud computer, the tools container), so the login it reads is theirs.
    const options = yield* scopeClaudeLaunch(
      buildClaudeCapabilitiesProbeQueryOptions({
        executablePath,
        abortController: abort,
        environment: claudeEnvironment,
        cwd,
        managedMcpConfig,
      }),
    );
    return yield* Effect.tryPromise(async () => {
      const { query: claudeQuery } = await loadClaudeAgentSdk();
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options,
      });
      const init = await q.initializationResult();
      return { q, init, graceMs };
    });
  }).pipe(
    Effect.timeout(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.flatMap(({ q, init, graceMs }) =>
      Effect.gen(function* () {
        // Usage has its own deadline so a slow optional request cannot discard initialization.
        // Only the rate limits are read, so skip the local transcript scan that fills
        // `behaviors`: with a few GB of transcripts it outlasts the deadline.
        const usageCheckedAt = DateTime.formatIso(yield* DateTime.now);
        const usageResult = includeUsage
          ? yield* Effect.tryPromise(() =>
              q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
            ).pipe(Effect.timeout(DEFAULT_TIMEOUT_MS), Effect.result)
          : undefined;
        const usage =
          usageResult && Result.isSuccess(usageResult)
            ? {
                rate_limits_available: usageResult.success.rate_limits_available,
                rate_limits: usageResult.success.rate_limits,
              }
            : undefined;
        const account = init.account as
          | {
              readonly email?: string;
              readonly subscriptionType?: string;
              readonly tokenSource?: string;
              readonly apiKeySource?: string;
              readonly apiProvider?: string;
            }
          | undefined;
        return {
          email: account?.email,
          subscriptionType: account?.subscriptionType,
          tokenSource: account?.tokenSource,
          apiKeySource: account?.apiKeySource,
          apiProvider: account?.apiProvider,
          slashCommands: parseClaudeInitializationCommands(init.commands),
          ...(init.models?.length ? { models: init.models } : {}),
          ...(usage ? { usage, usageCheckedAt } : {}),
        } satisfies ClaudeCapabilitiesProbe;
      }).pipe(
        Effect.tap(() =>
          graceMs > 0
            ? Effect.sleep(graceMs).pipe(Effect.andThen(abortProbe), Effect.forkDetach)
            : abortProbe,
        ),
      ),
    ),
    Effect.onError(() => abortProbe),
    Effect.tapError((error) =>
      Effect.logWarning("Claude capability probe failed.", { errorTag: error._tag }),
    ),
  );
};

type ClaudeCapabilitiesProbeError = Effect.Error<ReturnType<typeof probeClaudeCapabilities>>;

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
    ...(cwd ? { cwd } : {}),
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

/**
 * A first-party login the SDK names no plan for, as `claude auth status` reports it. A claude.ai login and a
 * long-lived OAuth token (`claude setup-token`, whose init sends no account details) are both a Claude plan;
 * anything else stays undescribed.
 */
const claudePlanLogin = (claudeSettings: ClaudeSettings, environment?: NodeJS.ProcessEnv, cwd?: string) =>
  runClaudeCommand(claudeSettings, ["auth", "status"], environment, cwd).pipe(
    Effect.timeoutOption(CLAUDE_VERSION_CHECK_TIMEOUT_MS),
    Effect.map((result) => {
      if (Option.isNone(result) || result.value.code !== 0) return undefined;
      let authMethod: unknown;
      try {
        authMethod = (JSON.parse(result.value.stdout) as { authMethod?: unknown }).authMethod;
      } catch {
        return undefined;
      }
      return authMethod === "claude.ai" || authMethod === "oauth_token" ? { type: "subscription", label: "Claude subscription" } : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );

/** Read commands from the same cwd Claude uses for a workspace session. */
export const probeClaudeWorkspaceSnapshot = Effect.fn("probeClaudeWorkspaceSnapshot")(function* (
  claudeSettings: ClaudeSettings,
  machineSnapshot: ServerProvider,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ProviderWorkspaceSnapshot, never, FileSystem.FileSystem | Path.Path> {
  if (!claudeSettings.enabled) return machineSnapshot;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, environment);
  const fileSystem = yield* FileSystem.FileSystem;
  // A deleted worktree can never answer the probe. Pending would make clients rescan it forever.
  const cwdExists = yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true));
  // A CLI the machine probe found missing cannot answer either; skipping it also leaves the SDK unloaded.
  const probeResult = cwdExists && machineSnapshot.installed
    ? yield* probeClaudeCapabilities(claudeSettings, environment, cwd, false).pipe(Effect.result)
    : undefined;
  const capabilities =
    probeResult && Result.isSuccess(probeResult) ? probeResult.success : undefined;
  return {
    ...machineSnapshot,
    skills,
    slashCommands: dedupeSlashCommands([
      COMPACT_SLASH_COMMAND,
      ...(capabilities?.slashCommands ?? []),
    ]),
    slashCommandsPending: cwdExists && !capabilities,
  };
});

/**
 * The command that installs `claude`, for the platform this runtime runs on. Anthropic's own installer is the
 * recommended way (native install, updates itself): macOS, Linux and WSL run the curl line, Windows PowerShell the irm
 * line; any other platform falls back to npm. Source: https://docs.claude.com/en/docs/claude-code/setup (redirects to
 * https://code.claude.com/docs/en/setup, "Install Claude Code"). The app's install box shows the same commands
 * (apps/web/src/routes/engines/install-commands.ts); keep the two in step.
 */
export function claudeInstallLine(platform: NodeJS.Platform): string {
  if (platform === "darwin" || platform === "linux") return "Install it with: curl -fsSL https://claude.ai/install.sh | bash";
  if (platform === "win32") return "Install it in PowerShell with: irm https://claude.ai/install.ps1 | iex";
  return "Install it with: npm install -g @anthropic-ai/claude-code@latest";
}

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined, ClaudeCapabilitiesProbeError>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  /** Shared with the adapter so turn events reuse the scoped-bucket names this probe saw. */
  scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    modelCatalog.models.map((entry) => entry.model),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude Agent is disabled in Caveman Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
    cwd,
  ).pipe(Effect.timeoutOption(CLAUDE_VERSION_CHECK_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `Claude Agent CLI (\`claude\`) was not found on PATH. ${claudeInstallLine(process.platform)}`
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const probeResult = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.result)
    : undefined;
  const capabilities =
    probeResult && Result.isSuccess(probeResult) ? probeResult.success : undefined;

  // What this `claude` lists decides which models exist; the manifest names and
  // describes them. A model it lists that no release has bundled yet is listed too.
  const liveCatalog = withReportedClaudeModels(modelCatalog, parseClaudeReportedModels(capabilities?.models));
  yield* Effect.sync(() => rememberClaudeModels(liveCatalog));
  const updateRequiredModels = resolveClaudeUpdateRequiredModels(liveCatalog, parsedVersion);
  const versionUpgradeMessage = formatClaudeVersionUpgradeMessage(liveCatalog, parsedVersion);
  const probeFailure =
    probeResult && Result.isFailure(probeResult) ? probeResult.failure : undefined;
  const models = providerModelsFromSettings(
    [
      ...resolveClaudeModelsForVersion(liveCatalog, parsedVersion),
      // What it reports beyond the Anthropic models above: a gateway's or a proxy's.
      ...claudeReportedModels(liveCatalog, claudeSettings.customModels, capabilities?.models),
    ],
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = [COMPACT_SLASH_COMMAND, ...(capabilities?.slashCommands ?? [])];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  // On a Cloud computer the login its person chose for Claude can't serve (cloudLink/engineKeys.ts): signed out,
  // so the sign-in card shows, and no other login was tried.
  if (probeFailure !== undefined && isEngineLoginUnavailable(probeFailure)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: { installed: true, version: parsedVersion, status: "error", auth: { status: "unauthenticated" }, message: probeFailure.message },
    });
  }

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: probeFailure
          ? Cause.isTimeoutError(probeFailure)
            ? `Timed out after ${CAPABILITIES_PROBE_TIMEOUT_MS / 1_000}s while checking Claude Agent account status.`
            : "Claude Agent CLI failed while checking account status."
          : "Could not verify Claude Agent authentication status from initialization result.",
      },
    });
  }

  // First-party account fields cannot verify custom endpoint credentials. The app's own
  // caveman-proxy forwards to Anthropic on the CLI's login, so it is not a custom endpoint.
  // Claude Code applies its settings' `env` over the process env.
  const baseUrl =
    (yield* readClaudeSettingsEnv(claudeSettings, cwd, resolvedEnvironment)).ANTHROPIC_BASE_URL ??
    resolvedEnvironment.ANTHROPIC_BASE_URL;
  const endpoint = URL.parse(baseUrl?.trim() ?? "");
  const appProxy = URL.parse(appProxyUrl() ?? "");
  const customApiEndpoint =
    endpoint !== null &&
    (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
    endpoint.hostname !== "" &&
    endpoint.hostname !== "api.anthropic.com" &&
    endpoint.origin !== appProxy?.origin;
  if (!customApiEndpoint && claudeAuthStatus(capabilities) === "unauthenticated") {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      // Every verdict on an installed version names what it is too old for: without it the registry keeps the
      // pending snapshot's whole list, and a signed-out Claude Code offered models it can't run.
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Claude Agent is not authenticated. Run `claude auth login` and try again.",
      },
    });
  }

  // A proxy's ANTHROPIC_AUTH_TOKEN reads as an API key; the endpoint is what the token is for.
  const authMetadata =
    apiProviderAuthMetadata(capabilities.apiProvider) ??
    (customApiEndpoint ? { type: "customEndpoint", label: "Custom API endpoint" } : undefined) ??
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
      apiKeySource: capabilities.apiKeySource,
    }) ??
    (yield* claudePlanLogin(claudeSettings, resolvedEnvironment, cwd));
  const usageCheckedAt = capabilities.usageCheckedAt ?? checkedAt;
  const usageLimits = !capabilities.usage
    ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })
    : scopedLimitNames
      ? yield* recordClaudeUsageResponse(scopedLimitNames, {
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
        })
      : claudeUsageResponseToLimits({
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
        }).limits;
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    updateRequiredModels,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
      usageLimits,
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude Agent is disabled in Caveman Code settings.",
        },
      });
    }

    return {
      ...buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude Agent status has not been checked in this session yet.",
        },
      }),
      // Caveman Code: a placeholder, not a probe result (engine.list reads "checking").
      probePending: true,
    };
  });

export { probeClaudeCapabilities };
