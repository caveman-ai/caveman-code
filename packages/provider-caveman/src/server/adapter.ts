// ), packages/provider-pi/src/server/adapter.ts @ ab3a3cd1 (adapted for the in-process Caveman engine).
/**
 * CavemanAdapterV2 — orchestrator-v2 adapter for the Caveman engine, in
 * process. Shaped ):
 * the engine is the Caveman harness (`@caveman-ai/harness`, harness.ts), built
 * on Pi, and its session hands back Pi's own agent events (`message_update`,
 * `tool_execution_*`) unchanged, so the item mapping below follows Pi's. What
 * differs is the transport and the journal:
 *
 * - No child process. The harness runs in this process through its public
 *   library API: a `HarnessSession` per thread, on the loadout its model was
 *   measured on (a coding thread) or the general one (the Chief), its tools in
 *   an env on this computer or, on a Cloud computer, in the tools container.
 * - The journal is the source of truth. Every engine run (`<nativeThreadId>-
 *   <random>`) leaves its conversation checkpoint under the runtime's state
 *   dir, so resume, rollback, fork and a move restore the conversation from
 *   it instead of from anything this adapter keeps. The provider thread's
 *   `nativeConversationHeadRef` names the run whose checkpoint is the head; a
 *   head the classic engine journaled before the harness took over still reads.
 * - Keys come from the runtime's secret store, never the environment.
 * - Model choice and context management are the engine's own. Usage is
 *   reported on the provider turn; nothing here renders it.
 */
import {
  isDelegatedAppThread,
  ProviderDriverKind,
  type ChatAttachment,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type TurnTokenUsage,
} from "@caveman-app/protocol";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as EgressRoute from "@caveman-app/engine-core/server/EgressRoute";
import * as ChiefSessions from "@caveman-app/engine-core/server/ChiefSessions";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as SessionPlugins from "@caveman-app/engine-core/server/SessionPlugins";
import { beforeTool } from "@caveman-app/engine-core/server/ToolGate";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import { type McpProviderSessionConfig, mcpHubUrl } from "@caveman-app/engine-core/server/mcpSession";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@caveman-app/engine-core/server/adapterDriver";
import { makeProviderFailure } from "@caveman-app/engine-core/server/failure";
import { UI_PROOF_INSTRUCTIONS } from "@caveman-app/engine-core/server/runtimeInstructions";
import { isHarnessNote, runtimeInstructionBlocks, runtimeTextChoice, type RuntimeTextChoice } from "./runtimeText.ts";
import { turnScopedSelectionTransition } from "@caveman-app/engine-core/server/selectionTransition";
import { compileIgnore } from "@caveman-app/shared/ignorePaths";
import { getModelSelectionStringOptionValue } from "@caveman-app/shared/model";
import { CREDITS_LIMIT_CODE, CREDITS_PROVIDER, creditsRefusal } from "./credits.ts";
import { classicRunMessages } from "./journal.ts";
import type { Api, Model, ModelThinkingLevel, MutableModels, StreamOptions } from "@earendil-works/pi-ai";
import { resolveAzureBaseUrl } from "@earendil-works/pi-ai/api/azure-openai-config";
import type { Provider } from "@earendil-works/pi-ai/models";
import { resolveCloudflareModel } from "@earendil-works/pi-ai/providers/cloudflare-stream";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CavemanSettings } from "../settings.ts";
import { APPROVAL_WAIT_MS, approvalKindFor, approvalPrompt } from "./approvals.ts";
import { AUTO_PROVIDERS, CAVEMAN_AUTO_MODEL, CREDITS_DEFAULT_MODEL, resolveCavemanModel } from "./autoModel.ts";
import { cavemanModels, cavemanSecrets, planProvidersFor, readCavemanKeys, storedSignIns, type CavemanKeys } from "./credentials.ts";
import { CavemanExecutionBackend, CavemanToolsLauncher, CavemanToolsStreamRef, type CavemanToolsLaunch } from "./execution.ts";
import { providerInfo, slotProvider } from "./providers.ts";
import { autoPool, CloudAutoRouter, type AutoAsk } from "./autoRouter.ts";
import { connectedModels, connectedSources, NOTHING_CONNECTED, sourceOf, type ConnectedSource } from "./connected.ts";
import { cavemanEngine } from "./engine.ts";
import type * as Harness from "@caveman-ai/harness";
import { BackendEnv } from "./backendEnv.ts";
import {
  callPolicy,
  eventChannel,
  harnessMcpServers,
  harnessStopNotice,
  hookCall,
  itemCall,
  loadHarness,
  nestedResultText as harnessResultText,
  patchFiles,
  patchText,
  readHarnessCheckpoint,
  renderSections,
  skillTool,
  userWords,
  WorkspaceEnv,
  writeHarnessCheckpoint,
  type CavemanMcpServerEntry,
  type TurnInput,
} from "./harness.ts";
import { defaultEffort, effortLevel } from "./engineConfig.ts";
import { harnessSideTurn, harnessModelOf } from "./sideText.ts";
import { cavemanHarnessRoot, cavemanSessionStartRoot } from "./journal.ts";
import { ToolsEnv } from "./toolsEnv.ts";

import { CavemanRuntimeToolsRef, type CavemanRuntimeTools } from "./runtimeTools.ts";
import { expandSkillMentions } from "./skillMentions.ts";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@caveman-app/engine-core/server/attachmentPrompt";

export const CAVEMAN_PROVIDER = ProviderDriverKind.make("caveman");
const DEFAULT_CAVEMAN_SETTINGS = Schema.decodeSync(CavemanSettings)({});

// The engine's own `auto` lives in a module without heavy imports, so `agent exec` resolves it without this adapter.
export { AUTO_PROVIDERS, CAVEMAN_AUTO_MODEL, CREDITS_DEFAULT_MODEL, resolveCavemanModel };

/** The runtime's own MCP server (delegate_task, thread_send, preview_*): the engine calls its tools from programs and exec cells. */
export const CAVEMAN_RUNTIME_MCP_SERVER = "caveman-code";
/** MCP server names the engine takes. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,59}$/;

/**
 * The egress scrub's probe: `route(CAVEMAN_GATEWAY_URL)` answers only while the scrub runs. Never called: no model
 * request goes to a gateway (the harness calls each provider at its own base URL, through the scrub).
 */
export const CAVEMAN_GATEWAY_URL = "http://127.0.0.1:8787";

/** An MCP CallToolResult, as JSON text, that says the call failed (`isError: true` beside its `content`). */
export const isMcpErrorResult = (text: string): boolean => {
  if (!text.startsWith("{") || !text.includes('"isError"')) return false;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && (value as { isError?: unknown }).isError === true && Array.isArray((value as { content?: unknown }).content);
  } catch {
    return false;
  }
};

const STREAM_FLUSH_MS = 50;
/** Real key shapes only, so `src/skeleton-loader.tsx` stays a path. Stored keys are redacted by value. */
const SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{35}|\bgh[pousr]_[A-Za-z0-9]{36,}/g;

export const CavemanProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    // The durable run id lands on the provider turn when it settles, not at start.
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    // App-owned queued turns, as for Claude Agent, Codex and Pi: the orchestrator holds a message sent behind a
    // running turn (a queued send, a follow-up, a runtime wake) and starts it with startTurn once that run settles.
    // The engine never sees the queue. False refused every one of them while an engine turn ran.
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    // The runtime's server and Space servers, called from programs and exec cells (and a few declared).
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  // The engine's tool policy asks (approvals.ts): edits and commands under
  // approval-required, commands and outside tools under auto-accept-edits.
  // Reads never ask. A program's or exec cell's calls go through the same policy.
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

/** Test seam: drive the engine without a network. Production passes nothing. */
export interface CavemanEngineOverrides {
  /** Every model call (pi-ai's `streamSimple` shape): a scripted model. */
  readonly streamFn?: Harness.HarnessStreamFn;
  /** The model every turn runs on, whatever the selection names (a pi-ai model: what the harness reads of one). */
  readonly model?: Model<Api> | Harness.HarnessModel;
  /** Test seam: Cloud's route transport. */
  readonly routeFetch?: typeof fetch;
}

export interface CavemanAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CavemanSettings;
  readonly engine?: CavemanEngineOverrides;
}

// ── small helpers ─────────────────────────────────────────────

const field = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
const stringField = (input: unknown, key: string): string | undefined => {
  const value = field(input, key);
  return typeof value === "string" ? value : undefined;
};
const numberField = (input: unknown, key: string): number => {
  const value = field(input, key);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
};

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (field(block, "type") === "text" ? (stringField(block, "text") ?? "") : "")).join("");
}

/** web_search and web_fetch as the engine names them, declared or called from a code cell (the runtime's caveman_web server). */
const WEB_SEARCH_TOOL = "mcp__caveman_web__web_search";
const WEB_FETCH_TOOL = "mcp__caveman_web__web_fetch";

/** A web tool's text: a declared call's answer arrives as its CallToolResult's JSON, a code cell's as the text itself. */
const webToolText = (output: string): string => {
  if (!output.startsWith("{")) return output;
  try {
    const content = field(JSON.parse(output), "content");
    return Array.isArray(content) ? contentText(content) : output;
  } catch {
    return output;
  }
};

/** The sources a web_search answer lists: `[n] title`, then its URL on the next line (runtime web/WebTools.ts searchText); excerpts are indented. */
export const webSearchSources = (text: string) => [...text.matchAll(/^\[\d+\] (.+)\n(https?:\/\/\S+)/gm)].map((m) => ({ title: m[1]!.trim(), url: m[2]! }));

/** The page a web_fetch read: the `Title:` and `URL:` lines the runtime writes above the page. */
export const webFetchSource = (text: string) => {
  const url = /^URL: (https?:\/\/\S+)$/m.exec(text)?.[1];
  const title = /^Title: (.+)$/m.exec(text)?.[1]?.trim();
  return url === undefined ? [] : [{ url, ...(title ? { title } : {}) }];
};

/** A nested call's result (a code cell's tool call): text as is, MCP-style content as its text, anything else as JSON. */
const nestedResultText = (result: unknown): string =>
  typeof result === "string" ? result : Array.isArray(field(result, "content")) ? contentText(field(result, "content")) : (JSON.stringify(result) ?? "");

/**
 * The engine's MCP servers: the runtime's own (when this thread has its
 * credential; the header goes to the server, never into argv or the prompt)
 * and the thread's Space and personal servers. With the credential, every one
 * of those goes through the runtime's MCP hub (`mcpHubUrl`), which is their
 * MCP client and runs the runtime's hook set on their calls; without it they
 * are started directly, minus `hubOnly` (servers only the hub can sign in
 * to). SSE and names the SDK cannot take are left out.
 * `stdio` is where a Space's stdio server started directly runs: here
 * ("local"), through a launch into the tools container (a Cloud computer), or
 * nowhere (null).
 */
export function cavemanMcpServers(
  runtimeSession: McpProviderSessionConfig | undefined,
  spaces: Readonly<Record<string, SessionPlugins.PluginMcpServer>>,
  hubOnly: ReadonlyArray<string> = [],
  stdio: "local" | { readonly launch: CavemanToolsLaunch; readonly cwd: string } | null = "local",
  /** Grill mode's server, while the thread is in grill mode. */
  grill?: CavemanRuntimeTools["grill"],
  /** A setup chat's server, on its thread. */
  setup?: CavemanRuntimeTools["setup"],
  /** web_search and web_fetch's server, when the credential carries `web`. */
  web?: CavemanRuntimeTools["web"],
  /** The agent file's custom tools' server, on a thread that has them. */
  client?: CavemanRuntimeTools["client"],
): ReadonlyArray<CavemanMcpServerEntry> {
  const space = Object.entries(spaces).flatMap(([name, server]): Array<CavemanMcpServerEntry> => {
    if (!MCP_SERVER_NAME.test(name) || name === CAVEMAN_RUNTIME_MCP_SERVER || name === grill?.server || name === setup?.server || name === web?.server || name === client?.server) return [];
    if (runtimeSession !== undefined && server.type !== "sse") {
      return [{ name, source: "space", config: { url: `${mcpHubUrl(runtimeSession.endpoint, name)}?hooks=1`, headers: { Authorization: runtimeSession.authorizationHeader } } }];
    }
    if (hubOnly.includes(name)) return [];
    if (server.type === "stdio") {
      if (stdio === null) return [];
      if (stdio !== "local") {
        // The client the SDK spawns here is the runtime's own exec channel; the server runs in tools.
        const routed = stdio.launch({ command: server.command, args: server.args, cwd: server.cwd ?? stdio.cwd, env: server.env });
        return [{ name, source: "space", config: { command: routed.command, args: [...routed.args], env: { ...routed.env } } }];
      }
      return [{ name, source: "space", config: { command: server.command, args: [...server.args], env: server.env, ...(server.cwd === undefined ? {} : { cwd: server.cwd }) } }];
    }
    return server.type === "http" ? [{ name, source: "space", config: { url: server.url, headers: server.headers } }] : [];
  });
  if (runtimeSession === undefined) return space;
  return [
    {
      name: CAVEMAN_RUNTIME_MCP_SERVER,
      source: "caveman-app",
      config: {
        url: runtimeSession.endpoint,
        headers: { Authorization: runtimeSession.authorizationHeader },
        description: "Caveman Code: delegate_task subagents, messages to other threads, worktrees, scheduled tasks, the shared browser (preview_*).",
      },
    },
    ...(grill === undefined
      ? []
      : [
          {
            name: grill.server,
            source: "caveman-app",
            config: { url: grill.endpoint(runtimeSession.endpoint), headers: { Authorization: runtimeSession.authorizationHeader }, description: "Caveman Code grill mode." },
          },
        ]),
    ...(setup === undefined
      ? []
      : [
          {
            name: setup.server,
            source: "caveman-app",
            config: { url: setup.endpoint(runtimeSession.endpoint), headers: { Authorization: runtimeSession.authorizationHeader }, description: "Caveman Code: this repo's Cloud test builds." },
          },
        ]),
    ...(web === undefined
      ? []
      : [
          {
            name: web.server,
            source: "caveman-app",
            config: { url: web.endpoint(runtimeSession.endpoint), headers: { Authorization: runtimeSession.authorizationHeader }, description: "Caveman Code: web search and reading web pages." },
          },
        ]),
    ...(client === undefined
      ? []
      : [
          {
            name: client.server,
            source: "caveman-app",
            config: { url: client.endpoint(runtimeSession.endpoint), headers: { Authorization: runtimeSession.authorizationHeader }, description: "Tools the caller of this session runs for you." },
          },
        ]),
    ...space,
  ];
}

/** A call on Caveman credits: pi-ai's provider is `caveman-<provider>` (credits.ts). */
const onCredits = (provider: string | undefined) => provider?.startsWith(`${CREDITS_PROVIDER}-`) === true;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** What the next-message guess is asked (Settings' prompt suggestions), as Codex's thread/sample is . */
export const CAVEMAN_PROMPT_SUGGESTION_INSTRUCTIONS =
  "You predict the next message a person will send to their coding agent. Reply with only that message, written as they would type it, in under 20 words. If there is no clear next step, reply with nothing.";
/** The exchange the guess reads, at most this many characters of each side (the reply's end, where its ask is). */
const PROMPT_SUGGESTION_EXCERPT_CHARS = 4_000;

/** The guess's prompt: the person's last message and the reply it got, nothing else of the chat. */
export const promptSuggestionPrompt = (asked: string, replied: string): string =>
  [
    "The person wrote:",
    asked.slice(0, PROMPT_SUGGESTION_EXCERPT_CHARS),
    "",
    "Their agent replied:",
    replied.slice(-PROMPT_SUGGESTION_EXCERPT_CHARS),
    "",
    "What will the person send next?",
  ].join("\n");

const redact = (text: string, secrets: ReadonlyArray<string>) =>
  secrets.reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text).replace(SECRET_PATTERN, "[redacted]");

function providerRef(nativeId: string, strength: "strong" | "weak" = "strong"): OrchestrationV2ProviderRef {
  return { driver: CAVEMAN_PROVIDER, nativeId, strength };
}

/**
 * `provider/model` from a selection, resolving the auto sentinel against stored
 * keys. Null unless that provider has a stored key: the engine would otherwise
 * fall back to an ambient one (it hands Pi `GOOGLE_API_KEY` per call).
 */
const isAutoModel = (model: string) => model === CAVEMAN_AUTO_MODEL || model === "default";

/** Why `resolveCavemanModel` returned null, in Settings terms. With `keys`, a pick whose key was removed says so. */
export function cavemanModelRefusal(model: string, keys?: CavemanKeys): string {
  if (model === CAVEMAN_AUTO_MODEL || model === "default") return "The Caveman engine has no key or sign-in. Add one in Settings.";
  const slash = model.indexOf("/");
  if (!(slash > 0 && slash < model.length - 1)) return `Caveman model '${model}' must use provider/model format.`;
  const provider = slotProvider(model.slice(0, slash));
  // Its slot is gone and another key of the provider holds a slot of its own: never that one's model by another name.
  if (keys !== undefined && Object.keys(keys).some((slot) => slotProvider(slot) === provider)) {
    return `The ${providerInfo(provider)?.label ?? provider} key this model ran on was removed. Pick the model again.`;
  }
  return `The Caveman engine has no ${model.slice(0, slash)} API key. Add one in Settings.`;
}

/** A grill-mode thread is refused, never escalated, where the runtime gives no grill tools. */
function runtimePolicyRefusal(policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy, tools: CavemanRuntimeTools): string | null {
  if (policy.interactionMode === "grill" && tools.grill === undefined) return "The Caveman engine has no grill mode here. Turn grill mode off to use it.";
  return null;
}

/** Grill mode's skill as the turn's first text, the shape Codex gives a loaded skill. */
const grillSkillText = (skill: string, rest: string) => `<skill>\n<name>grill</name>\n${skill.trim()}\n</skill>${rest === "" ? "" : `\n\n${rest}`}`;

interface Usage {
  /** Fresh input plus cache writes. */
  input: number;
  cached: number;
  written: number;
  output: number;
  reasoning: number;
  /** Model calls seen; a turn with none records no spend. */
  calls: number;
  /** Calls on a subscription plan (a sign-in, a plan's key): counted, never priced. */
  planCalls: number;
  /** The run ended and reported its usage (a run cut off mid-call is partial). */
  settled: boolean;
  /** The run's list price when the harness priced every call from the catalog; null otherwise, never a guess. */
  usd: number | null;
}

const noUsage = (): Usage => ({ input: 0, cached: 0, written: 0, output: 0, reasoning: 0, calls: 0, planCalls: 0, settled: false, usd: null });

/**
 * Stored attachments as engine input parts. The text names every attachment's
 * saved path, or says it is unavailable, so none drops out silently; images
 * the model can take also go in as bytes.
 */
const promptInput = Effect.fnUntraced(function* (
  text: string,
  attachments: ReadonlyArray<ChatAttachment>,
  resolvePath: (attachment: ChatAttachment) => string | null,
  // A document's text the runtime read out beside it (Word, Excel, slides), named next to the document.
  resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const message = yield* providerMessageTextWithAttachmentPaths({
    text,
    attachments,
    resolveAttachmentPath: resolvePath,
    resolveExtractedTextPath,
  });
  for (const attachment of attachments) {
    const path = resolvePath(attachment);
    if (path === null) continue;
    if (isProviderNativeImageAttachment(attachment)) {
      const bytes = yield* fileSystem.readFile(path);
      images.push({ type: "image", mimeType: attachment.mimeType, data: Buffer.from(bytes).toString("base64") });
    }
  }
  return images.length === 0 ? message : [{ type: "text" as const, text: message }, ...images];
});

// ── per-session state ─────────────────────────────────────────

interface StreamItem {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

interface ActiveTurn {
  /** A Stop hook already kept this turn going once. */
  stopHookContinued?: boolean;
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly abort: AbortController;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  messageOrdinal: number;
  readonly streamItems: Map<string, StreamItem>;
  readonly toolArgs: Map<string, unknown>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly openTools: Set<string>;
  /** Steering text accepted for this turn and not yet seen in the transcript. */
  readonly steers: Array<string>;
  /** Steering not yet handed to the session (it drains this before each model call). */
  readonly pendingSteers: Array<string>;
  /** Set under the permit once no further run will start; later steers are refused. */
  finalizing: boolean;
  /** Runs whose conversation the journal holds, in order: the last is the turn's head. */
  readonly runIds: Array<string>;
  /** Stored key values, redacted from anything shown. */
  readonly secrets: ReadonlyArray<string>;
  /** The keys the turn started with: which of its calls are on the person's plan (a sign-in, a plan's key). */
  readonly keys: CavemanKeys;
  /** Approval cards waiting on an answer, by runtime request id. */
  readonly approvals: Map<string, Deferred.Deferred<ProviderApprovalDecision>>;
  /** Fires when a program or exec cell ends, by its tool call id: a card for one of its calls cannot outlive it. */
  readonly cellEnds: Map<string, AbortController>;
  interrupted: boolean;
  /** Done once the turn has settled and the thread is free. */
  readonly settled: Deferred.Deferred<void>;
  failure: ReturnType<typeof makeProviderFailure> | null;
  /** The last model call ended in an error; cleared when a later one (a turn retry) answers. */
  modelError: ReturnType<typeof makeProviderFailure> | null;
  /** The turn's last failed tool call, so a turn that then ends with no reply says so. */
  toolFailure: { readonly name: string; readonly text: string } | null;
  /** Per run: its model calls' usage (`message_end`, keep-alive pings and compaction summaries), priced when it ends. */
  readonly runUsage: Array<Usage>;
  contextTokens: number;
  /** Cloud Auto: this thread's router and the ask it decides for. */
  readonly auto: AutoRoute | undefined;
  /** The model the turn's calls run on now: the one it started on, or Auto's route. The usage names it. */
  model: string;
}

interface AutoRoute {
  readonly key: string;
  readonly router: CloudAutoRouter;
  readonly ask: AutoAsk;
  /** The turn's effort sent to Cloud (pi-ai's level names). */
  effort: string;
  /** The last model a route line showed. */
  shown: string | undefined;
}

interface ThreadState {
  providerThread: OrchestrationV2ProviderThread;
  readonly nativeThreadId: string;
  /** The conversation as of the thread's head; the live session continues exactly this array. */
  messages: Array<Harness.HarnessMessage>;
  activeTurn: ActiveTurn | null;
  /** A run compacted the conversation since SessionStart hooks last ran for a compaction. */
  compacted?: boolean;
}

/**
 * The engine runs commands with its own short env allowlist, never the runtime's environment. The
 * workspace's variables (CAVEMAN_PORT_*, computer.toml [env]), the repository's secrets and the
 * runtime's git settings join it as the env's variables: every command, a program's included,
 * sees them, and no value is in argv or a label.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every model request through the egress scrub, at the endpoint it is sent to. pi-ai settles that endpoint per
 * request, past the catalog's base URL: a key or sign-in may name its own (a Cloud computer's credits name their
 * gateway at each request, GitHub Copilot's sign-in its account's), and some providers build it from the credential's
 * settings (Azure's resource, Cloudflare's account and gateway, Bedrock's Region) or their SDK's default (Vertex on a
 * key). So each provider is wrapped where pi-ai hands it the request with its auth applied: that endpoint goes to
 * `route`, and the request to the route. Wraps `source`'s providers in place, and any set on it later.
 */
export function modelsThroughScrub(
  source: MutableModels,
  route: (upstream: string) => string | undefined,
  /** Headers every routed request carries to the scrub (a chat's name, ProviderHost.connections); the scrub keeps them from the provider. */
  headers?: Readonly<Record<string, string>>,
): MutableModels {
  /** A request the scrub will see carries `headers`; one that goes direct (the scrub is down) is left as it is. */
  const routed = <O extends StreamOptions>(model: Model<Api>, options: O | undefined) => {
    const request = routedRequest(model, options, route);
    const moved = request.model !== model || request.options !== options;
    if (!moved || headers === undefined || Object.keys(headers).length === 0) return request;
    return { model: request.model, options: Object.assign({}, request.options, { headers: { ...request.options?.headers, ...headers } }) as O };
  };
  const through = (provider: Provider): Provider => ({
    ...provider,
    stream: (model, context, options) => {
      const request = routed(model, options);
      return provider.stream(request.model, context, request.options);
    },
    streamSimple: (model, context, options) => {
      const request = routed(model, options);
      return provider.streamSimple(request.model, context, request.options);
    },
  });
  for (const provider of source.getProviders()) source.setProvider(through(provider));
  return new Proxy(source, {
    get(target, property) {
      if (property === "setProvider") return (provider: Provider) => target.setProvider(through(provider));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Vertex AI's express mode, how it runs on an API key (the only way Settings take one): Google's global host. */
const VERTEX_EXPRESS_URL = "https://aiplatform.googleapis.com";
const BEDROCK_HOST = /^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/;
const BEDROCK_ARN_REGION = /^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/;

/** A request pointed at the scrub's route for the endpoint pi-ai would send it to; unchanged while the scrub is down. */
function routedRequest<O extends StreamOptions>(model: Model<Api>, options: O | undefined, route: (upstream: string) => string | undefined) {
  const env = options?.env;
  if (model.api === "azure-openai-responses" || slotProvider(model.provider) === "azure") {
    const via = route(resolveAzureBaseUrl(model, options));
    if (via === undefined) return { model, options };
    // Azure takes its endpoint from the request (an option, then its env, the runtime's included) over the model's.
    return { model: { ...model, baseUrl: via }, options: Object.assign({}, options, { azureBaseUrl: via, env: { ...env, AZURE_OPENAI_BASE_URL: via } }) };
  }
  if (model.api === "bedrock-converse-stream") {
    const region = bedrockRegion(model, options);
    const via = route(region === undefined ? model.baseUrl : `https://bedrock-runtime.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`);
    if (via === undefined) return { model, options };
    // A base URL off AWS is the client's endpoint as given. The AWS SDK speaks HTTP/2 unless told; the scrub serves HTTP/1.1.
    return { model: { ...model, baseUrl: via }, options: Object.assign({}, options, { env: { ...env, AWS_BEDROCK_FORCE_HTTP1: "1", ...(region === undefined ? {} : { AWS_REGION: region }) } }) };
  }
  const upstream = model.api === "google-vertex" && model.baseUrl.includes("{location}") ? VERTEX_EXPRESS_URL : resolveCloudflareModel(model, env).baseUrl;
  const via = route(upstream);
  if (via === undefined) return { model, options };
  // pi-ai shapes a completions request by its endpoint's host (max_tokens, store, the thinking format, OpenAI's prompt
  // cache key), and a custom endpoint has no provider id it knows: the model keeps its host, only the requests move.
  if (model.api === "openai-completions") return { model, options: Object.assign({}, options, { fetch: fetchVia(upstream, via, options?.fetch) }) };
  return { model: { ...model, baseUrl: via }, options };
}

/** Sends a request addressed under `upstream` to the same path under `via`, and refuses any other: none skips the scrub. */
function fetchVia(upstream: string, via: string, send: typeof fetch | undefined): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const base = new URL(upstream).href.replace(/\/+$/, "");
    const rest = url.slice(base.length);
    if (!url.startsWith(base) || !(rest === "" || rest.startsWith("/") || rest.startsWith("?"))) throw new Error(`${url} is not under ${upstream}; not sent past the egress scrub`);
    return (send ?? globalThis.fetch)(input instanceof Request ? new Request(via + rest, input) : via + rest, init);
  };
}

/**
 * The Region a Bedrock request runs in, as pi-ai's client picks it for a catalog endpoint: an inference profile's
 * own, else the one configured (the credential's AWS_REGION, then the runtime's), else the catalog endpoint's.
 * Undefined for an endpoint off AWS.
 */
function bedrockRegion(model: Model<Api>, options: StreamOptions | undefined): string | undefined {
  const catalog = URL.canParse(model.baseUrl) ? BEDROCK_HOST.exec(new URL(model.baseUrl).hostname.toLowerCase())?.[1] : undefined;
  if (catalog === undefined) return undefined;
  const configured = (options as { readonly region?: string } | undefined)?.region || getProviderEnvValue("AWS_REGION", options?.env) || getProviderEnvValue("AWS_DEFAULT_REGION", options?.env);
  return BEDROCK_ARN_REGION.exec(model.id)?.[1] ?? (configured || catalog);
}

const ENV_DIR_PREFIX = "caveman-env-";

/**
 * Removes secret env dirs a crashed runtime left behind: the pid in each name
 * is its owner, and only dirs of processes that are gone are removed (another
 * runtime's live sessions keep theirs). Older unnamed ones go too.
 */
export async function sweepStaleSecretEnvDirs(root = NodeOS.tmpdir()): Promise<ReadonlyArray<string>> {
  const removed: string[] = [];
  // Off the event loop: a busy machine's tmpdir holds 100k+ entries, seconds of readdirSync.
  const entries = await NodeFS.promises.readdir(root).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.startsWith(ENV_DIR_PREFIX)) continue;
    const pid = Number(/^caveman-env-(\d+)-/.exec(entry)?.[1]);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (alive) continue;
    await NodeFS.promises.rm(NodePath.join(root, entry), { recursive: true, force: true }).then(
      () => removed.push(entry),
      () => undefined,
    );
  }
  return removed;
}

let swept = false;

// ── the Chief ─────────────────────────────────────────────────

/** The Chief's agent id: its journal and recovery namespace. */
export const CAVEMAN_CHIEF_ID = "caveman-chief";
/** A Chief tool may take this long (chat_start makes worktrees); past it the call fails. */
const CHIEF_TOOL_TIMEOUT_MS = 120_000;

/** The Chief's system text (engine-core ChiefSessions): the same on every engine. */
export const chiefInstructions = ChiefSessions.chiefInstructions;

/**
 * The Chief's tools, declared to the harness's general loadout as the whole tool set (no file, shell, program or
 * MCP tools). Each call runs in the runtime as the thread that made it, inside the app run `runId()` names. No run
 * is replayed, so no call carries an idempotency key. The Chief runs full access: its tools never ask.
 */
export const chiefTools = (profile: ChiefSessions.ChiefProfile, threadId: ProviderAdapter.ProviderAdapterV2OpenSessionInput["threadId"], runId: () => string): Array<Harness.HarnessTool> =>
  profile.tools.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    // Plain draft-07 JSON Schema: Pi's validator compiles it as it does TypeBox's.
    parameters: spec.input,
    execute: async (toolCallId: string, params: unknown) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${spec.name} took longer than ${CHIEF_TOOL_TIMEOUT_MS / 1000} s`)), CHIEF_TOOL_TIMEOUT_MS);
      });
      try {
        const answer = await Promise.race([spec.run(threadId, params, { callId: toolCallId, runId: runId() }), timedOut]);
        return { content: [{ type: "text" as const, text: typeof answer === "string" ? answer : JSON.stringify(answer) }] };
      } finally {
        clearTimeout(timer);
      }
    },
  }));

// ── adapter ───────────────────────────────────────────────────

export const makeCavemanAdapterV2 = Effect.fn("makeCavemanAdapterV2")(function* (
  options: CavemanAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const hostContext = yield* Effect.context<ProviderHost.ProviderHost | FileSystem.FileSystem>();
  // Optional: a host without workspaces adds no environment.
  const sessionPlugins = yield* Effect.serviceOption(SessionPlugins.SessionPlugins);
  // Optional: a host without the egress scrub sends model traffic direct, and gives no secrets.
  const egress = yield* Effect.serviceOption(EgressRoute.EgressRoute);
  // Optional: the thread's credential for the runtime's MCP server; a host without it gives the engine none.
  const mcpSessions = yield* Effect.serviceOption(McpProviderSessions.McpProviderSessions);
  // Optional: a host without the Chief runs every thread as a coding session.
  const chiefSessions = yield* Effect.serviceOption(ChiefSessions.ChiefSessions);
  // Set on a Cloud computer: every tool runs in the tools container (execution.ts).
  const executionBackend = yield* CavemanExecutionBackend;
  // There, a Space's stdio MCP server starts in the tools container too, or not at all.
  const toolsLaunch = yield* CavemanToolsLauncher;
  // And the harness's commands and files, streamed from there (toolsEnv.ts).
  const toolsStream = yield* CavemanToolsStreamRef;
  // The runtime's waiting tools and grill mode, declared beside the coding tools.
  const runtimeTools = yield* CavemanRuntimeToolsRef;
  if (!swept) {
    swept = true;
    void sweepStaleSecretEnvDirs();
  }
  const route = (upstream: string) => (Option.isSome(egress) ? egress.value.route(upstream) : undefined);

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CAVEMAN_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: CAVEMAN_PROVIDER,
    getCapabilities: () => Effect.succeed(CavemanProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("CavemanAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      // Settings' prompt suggestions, read when each turn ends (suggestNextPrompt).
      const promptSuggestionsEnabled = input.promptSuggestions ?? Effect.succeed(false);
      const policyRefusal = runtimePolicyRefusal(input.runtimePolicy, runtimeTools);
      if (policyRefusal !== null) {
        return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: CAVEMAN_PROVIDER,
          providerSessionId: input.providerSessionId,
          cause: protocolError(policyRefusal),
        });
      }
      // Imported at the first session, not at the runtime's start (engine.ts, harness.ts); later sessions share them.
      const engine = yield* cavemanEngine;
      const harness = yield* Effect.promise(loadHarness);
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      // The Chief's thread: its own prompt and tools, and nothing from spaces, repositories or memory copies.
      const chief = Option.isSome(chiefSessions)
        ? yield* chiefSessions.value.profile(input.threadId).pipe(
            Effect.mapError((cause) => new ProviderAdapter.ProviderAdapterOpenSessionError({ driver: CAVEMAN_PROVIDER, providerSessionId: input.providerSessionId, cause })),
          )
        : undefined;
      const plugins = chief === undefined ? sessionPlugins : Option.none<SessionPlugins.SessionPlugins["Service"]>();
      const threadEnv =
        Option.isSome(plugins) && plugins.value.env !== undefined
          ? yield* plugins.value.env(input.threadId)
          : {};
      // The project's hidden paths, refused by the file tools and dropped from grep. None: the tools stay as the engine made them.
      const hiddenLines =
        Option.isSome(plugins) && plugins.value.hiddenPaths !== undefined ? yield* plugins.value.hiddenPaths(input.threadId) : [];
      const hidden = hiddenLines.length === 0 ? null : compileIgnore(hiddenLines);
      // The thread's spaces and repository: MCP servers, skills, and the instructions in their cache-stable
      // order (the runtime's instructions/EngineInstructions.ts). Read once: a running session keeps them.
      const projection =
        Option.isSome(plugins) && plugins.value.caveman !== undefined
          ? yield* plugins.value.caveman(input.threadId, cwd)
          : undefined;
      // Space skills as the engine's agent environment (a load_skill tool and a skills index). The cwd
      // only anchors the search, which covers exactly these roots: home exists here even when the
      // workspace is in a Cloud computer's tools container.
      const skills =
        projection === undefined || projection.skillRoots.length === 0
          ? undefined
          : yield* Effect.promise(() =>
              engine.plugins.loadAgentEnvironment({
                cwd: NodeOS.homedir(),
                skillRoots: projection.skillRoots,
                includeDefaultRoots: false,
                includeWorkspacePlugin: false,
              }),
            );
      const openError = (cause: unknown) =>
        new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: CAVEMAN_PROVIDER,
          providerSessionId: input.providerSessionId,
          cause,
        });
      // Repository secrets (already without the engine's own names) reach bash only when the
      // model calls go through the scrub.
      const readSecretEnv = () =>
        Option.isSome(plugins) && plugins.value.secretEnv !== undefined
          ? plugins.value.secretEnv(input.threadId, input.runtimePolicy.cwd ?? undefined)
          : Effect.succeed({});
      const secretEnv = yield* readSecretEnv().pipe(Effect.mapError(openError));
      const hasSecrets = Object.keys(secretEnv).length > 0;
      if (hasSecrets && route(CAVEMAN_GATEWAY_URL) === undefined) {
        return yield* openError(
          protocolError(
            "This project has secrets, and the Caveman engine cannot start without the egress scrub that keeps them from the model (the scrub is not running).",
          ),
        );
      }
      /** Where each run's conversation checkpoint goes; a classic run's journal stays where it was (journal.ts). */
      const harnessDir = cavemanHarnessRoot(host.paths.stateDir);
      // What a thread's SessionStart hooks printed when it began, by native thread: its instructions are made anew in
      // each session, and a thread that resumes keeps that text, as Claude Code keeps it in the transcript it resumes.
      // Kept empty when they printed nothing, so a thread with no record is one that began before it was kept.
      const startupTextOf = (nativeThreadId: string) => pathService.join(cavemanSessionStartRoot(host.paths.stateDir), nativeThreadId);
      const readStartupText = (nativeThreadId: string) =>
        fileSystem.readFileString(startupTextOf(nativeThreadId)).pipe(Effect.orElseSucceed((): string | undefined => undefined));
      const keepStartupText = (nativeThreadId: string, text: string) =>
        fileSystem.makeDirectory(pathService.dirname(startupTextOf(nativeThreadId)), { recursive: true }).pipe(
          Effect.andThen(fileSystem.writeFileString(startupTextOf(nativeThreadId), text)),
          Effect.ignore({ log: true }),
        );
      const runSessionStart = (source: SessionPlugins.SessionStartSource) =>
        projection?.hooks === undefined ? Effect.succeed(undefined) : Effect.promise(() => projection.hooks!.sessionStart(source).catch(() => undefined));
      /**
       * The session's SessionStart text, set as its first thread loads (`startup`: what that thread's startup hooks
       * printed, kept for it): trusted plugins' hooks run then, `startup` for a new thread and `resume` for one that
       * carries a conversation on (`from`: itself, or a fork's source). A thread with no record began before the
       * runtime kept it, when its startup hooks ran at every load: they run once more and what they print is kept. A
       * hook that fails adds nothing. Every thread the session runs later shares it, as the instructions its agents
       * were made with.
       */
      let sessionStart: { readonly startup: string; readonly context: string | undefined } | undefined;
      const startSession = Effect.fnUntraced(function* (nativeThreadId: string, from: string | null) {
        if (sessionStart !== undefined) {
          if (from === nativeThreadId) return;
          const text = from === null ? sessionStart.startup : yield* readStartupText(from);
          if (text !== undefined) yield* keepStartupText(nativeThreadId, text);
          return;
        }
        const kept = from === null ? undefined : yield* readStartupText(from);
        const startup = kept ?? (yield* runSessionStart("startup")) ?? "";
        const resumed = from === null ? undefined : yield* runSessionStart("resume");
        if (from !== nativeThreadId || kept === undefined) yield* keepStartupText(nativeThreadId, startup);
        const context = [startup, resumed].filter((text): text is string => text !== undefined && text !== "").join("\n\n");
        sessionStart = { startup, context: context === "" ? undefined : context };
      });
      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: CAVEMAN_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: CavemanProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const permit = yield* Semaphore.make(1);
      let threadState: ThreadState | null = null;
      const modelContextWindows = new Map<string, number>();
      let closed = false;

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          const turn = threadState?.activeTurn;
          if (turn != null) {
            turn.interrupted = true;
            turn.abort.abort();
          }
          yield* closeHarness;
          yield* Queue.end(events);
        }),
      );

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession = (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = sessionEntity.lastError,
      ) =>
        Effect.gen(function* () {
          sessionEntity = { ...sessionEntity, status, lastError, updatedAt: yield* DateTime.now };
          yield* emit({ type: "provider_session.updated", driver: CAVEMAN_PROVIDER, providerSession: sessionEntity });
        });

      const updateProviderThread = (state: ThreadState, patch: Partial<OrchestrationV2ProviderThread>) =>
        Effect.gen(function* () {
          state.providerThread = { ...state.providerThread, ...patch, updatedAt: yield* DateTime.now };
          yield* emit({ type: "provider_thread.updated", driver: CAVEMAN_PROVIDER, providerThread: state.providerThread });
        });

      /** Cloud's session state outlives a turn, while its connected pool stays the same. */
      const autoRoutes = new Map<string, AutoRoute>();
      const autoRouteFor = (threadKey: string, start: string, connected: ReadonlyArray<string>, sources: ReadonlyArray<ConnectedSource>): AutoRoute | undefined => {
        if (host.routing === undefined) return undefined;
        const pool = autoPool(start, connected);
        if (pool.length === 0) return undefined;
        const key = pool.join(",");
        const existing = autoRoutes.get(threadKey);
        if (existing?.key === key) return existing;
        const ask: AutoAsk = { text: "", seq: 0 };
        const next: AutoRoute = { key, ask, effort: "medium", router: new CloudAutoRouter(host.routing, pool, sources, () => ask, () => next.effort, options.engine?.routeFetch), shown: undefined };
        autoRoutes.set(threadKey, next);
        return next;
      };

      /** The runtime text this session's prompt carries, fixed by its first agent (runtimeText.ts). */
      let runtimeText: RuntimeTextChoice | undefined;
      /**
       * The MCP servers a coding thread reaches and the tools declared beside the surface: the runtime's
       * own server and the thread's Space servers; declared, the tools that wait on another agent or a person and the
       * ones that answer with an image.
       */
      const runtimeMcpFor = (runtimeMcp: McpProviderSessionConfig | undefined, grill: boolean) => {
        const stdio = executionBackend === undefined ? "local" : toolsLaunch === undefined ? null : { launch: toolsLaunch, cwd };
        // A repo's setup chat: its test-build tool, on this thread only.
        const setup = runtimeTools.setup?.has(input.threadId) ? runtimeTools.setup : undefined;
        // Web search and fetch, on a credential the runtime gave the `web` capability.
        const web = runtimeMcp?.capabilities?.has("web") === true ? runtimeTools.web : undefined;
        // The agent file's custom tools, on this thread only.
        const clientTools = runtimeTools.client?.tools(input.threadId) ?? [];
        const client = clientTools.length > 0 ? runtimeTools.client : undefined;
        const servers = cavemanMcpServers(runtimeMcp, projection?.mcpServers ?? {}, projection?.hubOnly ?? [], stdio, grill ? runtimeTools.grill : undefined, setup, web, client);
        // Answers that are an image run declared too: a code cell hands back only what it prints.
        const imageTools = runtimeMcp === undefined
          ? []
          : [
              ...(runtimeMcp.browserToolsAvailable ? (runtimeTools.images?.browser ?? []) : []),
              ...(executionBackend === undefined ? (runtimeTools.images?.local ?? []) : (runtimeTools.images?.desktop ?? [])),
            ];
        // Calls that wait on another agent or a person run declared, outside the code cell's 120 s limit.
        const direct = runtimeMcp === undefined
          ? []
          : [
              ...runtimeTools.waiting.map((tool) => ({ ...tool, server: CAVEMAN_RUNTIME_MCP_SERVER })),
              ...imageTools.map((tool) => ({ ...tool, server: CAVEMAN_RUNTIME_MCP_SERVER })),
              ...(grill && runtimeTools.grill !== undefined ? runtimeTools.grill.tools.map((tool) => ({ ...tool, server: runtimeTools.grill!.server })) : []),
              ...(setup === undefined ? [] : setup.tools.map((tool) => ({ ...tool, server: setup.server }))),
              ...(web === undefined ? [] : web.tools.map((tool) => ({ ...tool, server: web.server }))),
              ...(client === undefined ? [] : clientTools.map((tool) => ({ ...tool, server: client.server }))),
            ];
        return { servers, direct, imageTools };
      };

      /** A harness run's checkpoint, or undefined when `runId` is a classic run. */
      const harnessCheckpoint = (runId: string) =>
        Effect.tryPromise({
          try: () => readHarnessCheckpoint(harnessDir, runId),
          catch: (cause) => protocolError(`Caveman journal ${runId} could not be read`, cause),
        });

      /**
       * The conversation as of the end of `runId`: its harness checkpoint, else the classic engine's journaled
       * conversation as it is (a thread from before the harness; the session turns calls of tools it lacks into text).
       */
      const messagesAfter = (runId: string | null | undefined) =>
        Effect.gen(function* () {
          if (runId == null) return [] as Array<Harness.HarnessMessage>;
          const own = yield* harnessCheckpoint(runId);
          if (own !== undefined) return [...own.messages];
          const classic = yield* Effect.tryPromise({
            try: () => classicRunMessages(host.paths.stateDir, runId),
            catch: (cause) => protocolError(`Caveman journal ${runId} is corrupt`, cause),
          });
          if (classic === undefined) return yield* protocolError(`Caveman journal ${runId} has no recoverable conversation`);
          return classic as Array<Harness.HarnessMessage>;
        });

      // ── items ─────────────────────────────────────────────

      const itemOrdinal = (turn: ActiveTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const baseItemFields = (turn: ActiveTurn, nativeItemId: string, startedAt: DateTime.Utc, updatedAt: DateTime.Utc) => ({
        id: idAllocator.derive.turnItemFromProviderItem({ driver: CAVEMAN_PROVIDER, nativeItemId }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({ driver: CAVEMAN_PROVIDER, nativeItemId }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      // ── approvals ─────────────────────────────────────────

      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

      /**
       * One approval card, Claude Agent's shape: pending request, waiting node and item. An answer
       * resolves it through the orchestrator; Stop cancels it and an hour unanswered expires it, both
       * a denial the engine reads as the tool's result.
       */
      /** A call that may ask: its id, its name and arguments as the card shows them, and the program or cell it came from. */
      interface ApprovalCall {
        readonly toolCallId: string;
        readonly name: string;
        readonly args: unknown;
        readonly parentToolCallId?: string | undefined;
      }

      const askApproval = Effect.fnUntraced(function* (turn: ActiveTurn, call: ApprovalCall, requestKind: "command" | "file-change") {
        const nativeRequestId = `${turn.providerTurn.id}:approval:${call.toolCallId}`;
        const requestId = yield* idAllocator.allocate.runtimeRequest({ driver: CAVEMAN_PROVIDER, providerTurnId: turn.providerTurn.id, nativeRequestId });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const now = yield* DateTime.now;
        const nativeItemRef = providerRef(nativeRequestId);
        const request: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: turn.providerTurn.id,
          nativeRequestRef: nativeItemRef,
          kind: requestKind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: now,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          parentNodeId: turn.turnInput.rootNodeId,
          rootNodeId: turn.turnInput.rootNodeId,
          kind: "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: turn.turnInput.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        };
        const turnItem: OrchestrationV2TurnItem = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId: turn.turnInput.threadId,
          runId: turn.turnInput.runId,
          nodeId,
          providerThreadId: turn.turnInput.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef,
          parentItemId: null,
          ordinal: itemOrdinal(turn, nativeRequestId),
          status: "waiting",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "approval_request",
          requestId,
          requestKind,
          prompt: approvalPrompt(call.name, call.args, (text) => redact(text, turn.secrets)),
        };
        const decision = yield* Deferred.make<ProviderApprovalDecision>();
        turn.approvals.set(String(requestId), decision);
        yield* emit({ type: "node.updated", driver: CAVEMAN_PROVIDER, node });
        yield* emit({ type: "runtime_request.updated", driver: CAVEMAN_PROVIDER, threadId: turn.turnInput.threadId, runtimeRequest: request });
        yield* emit({ type: "turn_item.updated", driver: CAVEMAN_PROVIDER, turnItem });
        const on = <A extends string>(signal: AbortSignal, value: A) =>
          Effect.callback<A>((resume) => {
            const onAbort = () => resume(Effect.succeed(value));
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
            return Effect.sync(() => signal.removeEventListener("abort", onAbort));
          });
        // A call from a program or exec cell: it has its own time limit, and once it ended the call can never run.
        const cell = call.parentToolCallId;
        if (cell !== undefined && !turn.cellEnds.has(cell)) turn.cellEnds.set(cell, new AbortController());
        const cellEnded = cell === undefined ? Effect.never : on(turn.cellEnds.get(cell)!.signal, "no_answer" as const);
        const answer = yield* Effect.raceAll([Deferred.await(decision), on(turn.abort.signal, "stopped" as const), cellEnded]).pipe(
          Effect.timeoutOption(Duration.millis(APPROVAL_WAIT_MS)),
          Effect.map(Option.getOrElse(() => "no_answer" as const)),
          Effect.ensuring(Effect.sync(() => turn.approvals.delete(String(requestId)))),
        );
        if (answer === "stopped" || answer === "no_answer") {
          const at = yield* DateTime.now;
          const status = answer === "stopped" ? ("cancelled" as const) : ("expired" as const);
          yield* emit({ type: "runtime_request.updated", driver: CAVEMAN_PROVIDER, threadId: turn.turnInput.threadId, runtimeRequest: { ...request, status, resolvedAt: at } });
          yield* emit({ type: "node.updated", driver: CAVEMAN_PROVIDER, node: { ...node, status: "cancelled", completedAt: at } });
          yield* emit({ type: "turn_item.updated", driver: CAVEMAN_PROVIDER, turnItem: { ...turnItem, status: "cancelled", completedAt: at, updatedAt: at } });
          return { deny: answer };
        }
        return answer.startsWith("accept") ? undefined : { deny: answer === "cancel" ? "cancelled" : "declined" };
      });

      const emitItemNode = (
        turn: ActiveTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: CAVEMAN_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({ driver: CAVEMAN_PROVIDER, nativeItemId }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      const emitStreamItem = (turn: ActiveTurn, item: StreamItem, streaming: boolean) =>
        Effect.gen(function* () {
          const emittedAt = yield* DateTime.now;
          const status = streaming ? ("running" as const) : ("completed" as const);
          const completedAt = streaming ? null : emittedAt;
          yield* emitItemNode(turn, item.nativeItemId, item.kind, status, item.startedAt, completedAt);
          const base = { ...baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt), status, title: null, completedAt };
          if (item.kind === "reasoning") {
            yield* emit({
              type: "turn_item.updated",
              driver: CAVEMAN_PROVIDER,
              turnItem: { ...base, type: "reasoning", text: item.text, streaming },
            });
            return;
          }
          const messageId = idAllocator.derive.messageFromProviderItem({ driver: CAVEMAN_PROVIDER, nativeItemId: item.nativeItemId });
          yield* emit({
            type: "turn_item.updated",
            driver: CAVEMAN_PROVIDER,
            turnItem: { ...base, type: "assistant_message", messageId, text: item.text, streaming },
          });
          yield* emit({
            type: "message.updated",
            driver: CAVEMAN_PROVIDER,
            message: {
              id: messageId,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              nodeId: base.nodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: item.startedAt,
              updatedAt: emittedAt,
            },
          });
        });

      const scheduleStreamFlush = (turn: ActiveTurn, item: StreamItem) =>
        Effect.gen(function* () {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              permit.withPermits(1)(
                Effect.suspend(() => {
                  item.flushScheduled = false;
                  return item.completed ? Effect.void : emitStreamItem(turn, item, true);
                }),
              ),
            ),
            Effect.forkIn(scope),
          );
        });

      const streamItemFor = Effect.fnUntraced(function* (turn: ActiveTurn, kind: StreamItem["kind"], contentIndex: number) {
        const nativeItemId = `${turn.providerTurn.id}:m${turn.messageOrdinal}:c${contentIndex}`;
        const existing = turn.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const item: StreamItem = { nativeItemId, kind, text: "", completed: false, flushScheduled: false, startedAt: yield* DateTime.now };
        turn.streamItems.set(nativeItemId, item);
        itemOrdinal(turn, nativeItemId);
        return item;
      });

      const completeStreamItem = (turn: ActiveTurn, item: StreamItem, text?: string) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
        });

      const completeOpenStreamItems = (turn: ActiveTurn) =>
        Effect.forEach(
          [...turn.streamItems.values()].filter((item) => !item.completed),
          (item) => completeStreamItem(turn, item),
          { discard: true },
        );

      const emitToolItem = Effect.fnUntraced(function* (turn: ActiveTurn, event: unknown, phase: "start" | "update" | "end" | "settle") {
        const toolCallId = stringField(event, "toolCallId");
        if (toolCallId === undefined) return;
        const toolName = stringField(event, "toolName") ?? "tool";
        // Provider tool-call ids are only unique within one model response.
        const nativeItemId = `${turn.providerTurn.id}:tool:${toolCallId}`;
        if (phase === "start") {
          turn.toolArgs.set(nativeItemId, field(event, "args"));
          turn.openTools.add(nativeItemId);
        }
        if (phase === "end" || phase === "settle") {
          turn.openTools.delete(nativeItemId);
          turn.cellEnds.get(toolCallId)?.abort();
          turn.cellEnds.delete(toolCallId);
        }
        const args = field(event, "args") ?? turn.toolArgs.get(nativeItemId);
        const emittedAt = yield* DateTime.now;
        const startedAt = turn.toolStartedAt.get(nativeItemId) ?? emittedAt;
        turn.toolStartedAt.set(nativeItemId, startedAt);
        const completed = phase === "end" || phase === "settle";
        const result = phase === "end" ? field(event, "result") : field(event, "partialResult");
        const outputText = redact(contentText(field(result, "content")), turn.secrets);
        // A declared MCP tool's answer arrives as its CallToolResult's JSON: the runtime refusing a call (a limit, a
        // bad target) says isError there and nowhere else, and is a failed call, not a done one.
        const isError = field(event, "isError") === true || phase === "settle" || (phase === "end" && isMcpErrorResult(outputText));
        const status = !completed ? "running" : !isError ? "completed" : turn.interrupted ? "interrupted" : "failed";
        // The last finished call decides: a failure the model got past is not why it gave no reply.
        if (phase === "end") turn.toolFailure = status === "failed" ? { name: toolName, text: outputText.trim().split("\n")[0]!.slice(0, 300) } : null;
        const completedAt = completed ? emittedAt : null;
        yield* emitItemNode(turn, nativeItemId, "tool_call", status, startedAt, completedAt);
        const shared = { ...baseItemFields(turn, nativeItemId, startedAt, emittedAt), status, completedAt, title: toolName } as const;

        if (toolName === "bash") {
          // A command's output arrives led by `exit <code>` (handleHarnessEvent, nestedResultText).
          const exit = /^exit (-?\d+)\n?/.exec(outputText);
          const output = exit === null ? outputText : outputText.slice(exit[0].length);
          yield* emit({
            type: "turn_item.updated",
            driver: CAVEMAN_PROVIDER,
            turnItem: {
              ...shared,
              type: "command_execution",
              input: stringField(args, "command") ?? "",
              ...(completed || output.length > 0 ? { output } : {}),
              ...(exit === null ? {} : { exitCode: Number(exit[1]) }),
            },
          });
          return;
        }
        const fileName = stringField(args, "path");
        if ((toolName === "write_file" || toolName === "edit_file") && fileName !== undefined && fileName.trim() !== "") {
          // edit_file's edits[] (batchGuidance): the sites joined, in order, so the card shows every change.
          const edits = toolName === "edit_file" ? field(args, "edits") : undefined;
          const sites = Array.isArray(edits) ? edits.filter((edit) => stringField(edit, "old_string") !== undefined) : [];
          const oldStr = toolName !== "edit_file" ? undefined
            : sites.length > 0 ? sites.map((edit) => stringField(edit, "old_string")!).join("\n…\n") : stringField(args, "old_string");
          const newStr = toolName !== "edit_file" ? stringField(args, "content")
            : sites.length > 0 ? sites.map((edit) => stringField(edit, "new_string") ?? "").join("\n…\n") : stringField(args, "new_string");
          yield* emit({
            type: "turn_item.updated",
            driver: CAVEMAN_PROVIDER,
            turnItem: {
              ...shared,
              type: "file_change",
              fileName: fileName.trim(),
              ...(oldStr === undefined ? {} : { oldStr }),
              ...(newStr === undefined ? {} : { newStr }),
              ...(isError && outputText.trim().length > 0 ? { diffStr: outputText } : {}),
            },
          });
          return;
        }
        if (toolName === WEB_SEARCH_TOOL || toolName === WEB_FETCH_TOOL) {
          // Both are web_search items (docs/ "In the transcript"): a search with its query and sources, a fetch
          // with its URL and the page it read. The item kind is what marks the session as having read the web (memory taint).
          const fetched = toolName === WEB_FETCH_TOOL;
          const pattern = stringField(args, fetched ? "url" : "query")?.trim();
          const text = completed && !isError ? webToolText(outputText) : "";
          const results = text === "" ? [] : fetched ? webFetchSource(text) : webSearchSources(text);
          yield* emit({
            type: "turn_item.updated",
            driver: CAVEMAN_PROVIDER,
            turnItem: {
              ...shared,
              title: fetched ? "web_fetch" : "web_search",
              type: "web_search",
              ...(pattern ? { patterns: [pattern] } : {}),
              ...(results.length > 0 ? { results } : {}),
            },
          });
          return;
        }
        yield* emit({
          type: "turn_item.updated",
          driver: CAVEMAN_PROVIDER,
          turnItem: {
            ...shared,
            type: "dynamic_tool",
            toolName,
            input: args ?? {},
            ...(completed ? { output: outputText } : {}),
          },
        });
      });

      // ── engine events ─────────────────────────────────────

      const handlePiEvent = Effect.fnUntraced(function* (turn: ActiveTurn, event: unknown) {
        switch (field(event, "type")) {
          case "message_start": {
            if (stringField(field(event, "message"), "role") === "assistant") turn.messageOrdinal += 1;
            return;
          }
          case "message_update": {
            const delta = field(event, "assistantMessageEvent");
            const deltaType = stringField(delta, "type");
            const contentIndex = numberField(delta, "contentIndex");
            if (deltaType === "text_delta" || deltaType === "thinking_delta") {
              const item = yield* streamItemFor(turn, deltaType === "text_delta" ? "assistant_message" : "reasoning", contentIndex);
              item.text += stringField(delta, "delta") ?? "";
              yield* scheduleStreamFlush(turn, item);
              return;
            }
            if (deltaType === "text_end" || deltaType === "thinking_end") {
              const item = yield* streamItemFor(turn, deltaType === "text_end" ? "assistant_message" : "reasoning", contentIndex);
              yield* completeStreamItem(turn, item, stringField(delta, "content"));
            }
            return;
          }
          case "message_end": {
            const message = field(event, "message");
            const role = stringField(message, "role");
            if (role === "user") {
              // A steer reached the transcript.
              const index = turn.steers.indexOf(contentText(field(message, "content")));
              if (index >= 0) turn.steers.splice(index, 1);
              return;
            }
            if (role !== "assistant") return;
            // Providers that do not stream still end with the full content.
            const content = field(message, "content");
            if (Array.isArray(content)) {
              for (const [index, block] of content.entries()) {
                const type = field(block, "type");
                if (type !== "text" && type !== "thinking") continue;
                const item = yield* streamItemFor(turn, type === "text" ? "assistant_message" : "reasoning", index);
                yield* completeStreamItem(turn, item, stringField(block, type === "text" ? "text" : "thinking"));
              }
            }
            yield* completeOpenStreamItems(turn);
            const usage = field(message, "usage");
            const input = numberField(usage, "input");
            const cached = numberField(usage, "cacheRead");
            const written = numberField(usage, "cacheWrite");
            const output = numberField(usage, "output");
            const run = turn.runUsage.at(-1);
            if (run !== undefined) {
              run.input += input + written;
              run.cached += cached;
              run.written += written;
              run.output += output;
              run.reasoning += numberField(usage, "reasoning");
              run.calls += 1;
              if (planProvidersFor(turn.keys, turn.model).has(stringField(message, "provider") ?? "")) run.planCalls += 1;
            }
            turn.contextTokens = input + cached + written + output;
            turn.modelError =
              stringField(message, "stopReason") === "error" && !turn.interrupted
                ? failureFrom(stringField(message, "errorMessage") ?? "The model returned an error.", turn.secrets, "provider_error", onCredits(stringField(message, "provider")))
                : null;
            return;
          }
          case "tool_execution_start":
            return yield* emitToolItem(turn, event, "start");
          case "tool_execution_update":
            return yield* emitToolItem(turn, event, "update");
          case "tool_execution_end":
            return yield* emitToolItem(turn, event, "end");
          default:
            return;
        }
      });

      /** A state line in the chat. Its own item, even beside another in the same millisecond (a stop, then "No reply"). */
      const emitNotice = Effect.fnUntraced(function* (turn: ActiveTurn, message: string) {
        const at = yield* DateTime.now;
        const id = `notice:${turn.providerTurn.id}:${DateTime.toEpochMillis(at)}:${turn.nextItemOrdinal}`;
        yield* emit({
          type: "turn_item.updated",
          driver: CAVEMAN_PROVIDER,
          turnItem: { ...baseItemFields(turn, id, at, at), status: "completed", title: null, completedAt: at, type: "system_notice", message },
        });
      });

      /** Auto moved the turn's calls to `model`: a route line in the chat, once per model it moves to. */
      const emitRoute = Effect.fnUntraced(function* (turn: ActiveTurn, model: string) {
        if (turn.auto === undefined || turn.auto.shown === model) return;
        turn.auto.shown = model;
        const at = yield* DateTime.now;
        yield* emit({
          type: "turn_item.updated",
          driver: CAVEMAN_PROVIDER,
          turnItem: { ...baseItemFields(turn, `route:${turn.providerTurn.id}:${model}`, at, at), status: "completed", title: null, completedAt: at, type: "system_notice", message: `Routed to ${model}`, routedModel: model },
        });
      });

      /** Stop: the session aborts its model call and tools, and nothing queued runs after it. */
      const stopTurn = (turn: ActiveTurn) => {
        turn.interrupted = true;
        turn.steers.length = 0;
        turn.pendingSteers.length = 0;
        turn.abort.abort();
      };

      const finalizeTurn = Effect.fnUntraced(function* (state: ThreadState, turn: ActiveTurn) {
        if (state.activeTurn !== turn) return;
        if (turn.auto) yield* Effect.promise(() => turn.auto!.router.finish(turn.interrupted ? "interrupted" : turn.failure ? "failed" : "completed")).pipe(Effect.forkIn(scope));
        state.activeTurn = null;
        yield* Deferred.succeed(turn.settled, undefined);
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        // A failed or stopped run leaves nothing open.
        for (const nativeItemId of [...turn.openTools]) {
          yield* emitToolItem(turn, { toolCallId: nativeItemId.slice(nativeItemId.indexOf(":tool:") + 6) }, "settle");
        }
        const interrupted = turn.interrupted;
        const failure = interrupted ? null : turn.failure;
        // A turn that ends with no reply after a tool failed is no silent success.
        const replied = [...turn.streamItems.values()].some((item) => item.kind === "assistant_message" && item.text.trim() !== "");
        if (!interrupted && failure === null && !replied && turn.toolFailure !== null) {
          const { name, text } = turn.toolFailure;
          yield* emitNotice(turn, `No reply: the turn ended after ${name} failed${text === "" ? "." : `: ${text}`}`);
        }
        const headRunId = turn.runIds.at(-1) ?? null;
        const usage = turn.runUsage.reduce(
          (total, run) => ({
            input: total.input + run.input,
            cached: total.cached + run.cached,
            written: total.written + run.written,
            output: total.output + run.output,
            reasoning: total.reasoning + run.reasoning,
            calls: total.calls + run.calls,
            planCalls: total.planCalls + run.planCalls,
            settled: total.settled && run.settled,
            usd: total.usd === null || run.usd === null ? null : total.usd + run.usd,
          }),
          { ...noUsage(), settled: turn.runUsage.length > 0, usd: turn.runUsage.length > 0 ? 0 : null },
        );
        const tokenUsage: OrchestrationV2ProviderTurnTokenUsage | undefined =
          turn.contextTokens === 0 && usage.input + usage.output === 0
            ? undefined
            : {
                usedTokens: turn.contextTokens,
                maxTokens: modelContextWindows.get(turn.turnInput.modelSelection.model) ?? null,
                inputTokens: usage.input,
                cachedInputTokens: usage.cached,
                outputTokens: usage.output,
                reasoningOutputTokens: usage.reasoning,
                updatedAt: DateTime.formatIso(completedAt),
              };
        // The turn's spend (the Session Protocol's usage event): every call, keep-alive pings and summaries included. No call, no spend.
        // Every call on the person's plan: the turn is the plan's, unpriced.
        const onPlan = usage.calls > 0 && usage.planCalls === usage.calls;
        const turnTokenUsage: TurnTokenUsage | undefined = usage.calls === 0 ? undefined : {
          usageStatus: usage.settled ? "complete" : "partial",
          usageScope: "turn",
          hasSubagents: false,
          inputTokens: usage.input + usage.cached,
          cachedInputTokens: usage.cached,
          cacheCreationTokens: usage.written,
          outputTokens: usage.output,
          reasoningTokens: usage.reasoning,
          ...(usage.usd === null || onPlan ? {} : { listPriceUsd: usage.usd }),
          ...(onPlan ? { billing: "plan" as const } : {}),
          model: turn.model,
        };
        turn.providerTurn = {
          ...turn.providerTurn,
          ...(headRunId === null ? {} : { nativeTurnRef: providerRef(headRunId) }),
          status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
          completedAt,
          ...(tokenUsage === undefined ? {} : { tokenUsage }),
          ...(turnTokenUsage === undefined ? {} : { turnTokenUsage }),
        };
        yield* emit({ type: "provider_turn.updated", driver: CAVEMAN_PROVIDER, threadId: turn.turnInput.threadId, providerTurn: turn.providerTurn });
        yield* updateProviderThread(state, {
          status: "idle",
          ...(headRunId === null ? {} : { nativeConversationHeadRef: providerRef(headRunId) }),
        });
        yield* updateProviderSession(failure !== null ? "error" : "ready", failure?.message ?? null);
        if (failure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          yield* emit({
            type: "turn_item.updated",
            driver: CAVEMAN_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, failureItemId, completedAt, completedAt),
              status: "failed",
              title: null,
              completedAt,
              type: "error",
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: CAVEMAN_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
          return;
        }
        yield* emit({
          type: "turn.terminal",
          driver: CAVEMAN_PROVIDER,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.turnInput.runOrdinal,
          status: interrupted ? "interrupted" : "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        if (!interrupted && replied) yield* suggestNextPrompt(state, turn).pipe(Effect.forkIn(scope));
      });

      /**
       * Settings' prompt suggestions on this engine: after a completed turn, one tool-free side turn on the turn's own
       * model at its lowest effort guesses the person's next message from the exchange (promptSuggestionPrompt), through
       * the turn's egress scrub. Best effort, and never for the Chief or a delegated thread, where no one types.
       */
      const suggestNextPrompt = Effect.fnUntraced(
        function* (state: ThreadState, turn: ActiveTurn) {
          if (chief !== undefined || isDelegatedAppThread(turn.turnInput.appThread) || !(yield* promptSuggestionsEnabled)) return;
          const reply = [...turn.streamItems.values()].filter((item) => item.kind === "assistant_message").at(-1)?.text.trim() ?? "";
          if (reply === "") return;
          const models = modelsThroughScrub(yield* cavemanModels(turn.keys, yield* storedSignIns(options.instanceId)), route, host.connections?.headers(input.threadId));
          const catalogModel = harnessModelOf(models, turn.model);
          const model = (options.engine?.model as Harness.HarnessModel | undefined) ?? catalogModel;
          if (model === undefined) return;
          // The lowest level the model offers; one that offers none of these runs at its own default.
          const effort =
            catalogModel === undefined
              ? undefined
              : (["minimal", "low"] as const)
                  .map((id) => effortLevel(catalogModel as never, id))
                  .find((level) => level !== undefined);
          const outcome = yield* Effect.tryPromise((signal) =>
            harnessSideTurn({
              model,
              stream:
                options.engine?.streamFn === undefined
                  ? (streamModel, streamContext, streamOptions) => models.streamSimple(streamModel, streamContext, streamOptions)
                  : (options.engine.streamFn as Harness.HarnessStreamFn),
              instructions: CAVEMAN_PROMPT_SUGGESTION_INSTRUCTIONS,
              prompt: promptSuggestionPrompt(turn.turnInput.message.text, reply),
              cwd,
              ...(effort === undefined ? {} : { effort: effort as Harness.Effort }),
              signal,
            }),
          );
          const text = outcome.status === "finished" ? redact(outcome.finalText.trim(), turn.secrets) : "";
          // The person may have sent again while it was written: the guess is about a turn that is no longer the last.
          if (text === "" || state.activeTurn !== null) return;
          yield* emit({ type: "prompt_suggestion.updated", driver: CAVEMAN_PROVIDER, threadId: turn.turnInput.threadId, runId: turn.turnInput.runId, text });
        },
        Effect.catchCause((cause) => Effect.logDebug("caveman: no prompt suggestion", cause)),
      );

      /**
       * What a turn runs next, once its engine run ended: the steers that arrived after the run's last model call (the
       * engine would otherwise keep them with no run to deliver them to), else a trusted Stop hook's reason (once a
       * turn), else nothing: the turn ends. Decided under the permit, so a steer either lands in the next run or is refused.
       */
      const nextInput = (turn: ActiveTurn) =>
        Effect.gen(function* () {
          const next = yield* permit.withPermits(1)(
            Effect.sync(() => {
              if (turn.interrupted || turn.failure !== null || turn.steers.length === 0 || closed) {
                turn.finalizing = true;
                return null;
              }
              turn.pendingSteers.length = 0;
              return turn.steers.splice(0).join("\n\n");
            }),
          );
          if (next === null) {
            const reason =
              turn.interrupted || turn.failure !== null || closed || turn.stopHookContinued === true || projection?.hooks === undefined
                ? undefined
                : yield* Effect.promise(() => projection.hooks!.stop(false).catch(() => undefined));
            if (reason === undefined) return null;
            turn.stopHookContinued = true;
            return `[Stop hook] ${reason}`;
          }
          if (turn.auto !== undefined) {
            turn.auto.ask.text = next;
            turn.auto.ask.seq++;
          }
          return next;
        });

      // ── the session ───────────────────────────────────────

      /** The thread's harness session: one at a time (a session hosts one thread), kept across turns for its cache and processes. */
      interface LiveHarness {
        readonly key: string;
        readonly session: Harness.HarnessSession;
        readonly env: WorkspaceEnv;
        readonly mcp: Harness.McpSession | undefined;
        /** Declared MCP tools by the harness's name for them: the server and tool an item and an approval name. */
        readonly direct: ReadonlyMap<string, { readonly server: string; readonly tool: string }>;
        /** The conversation it continues (the thread's): a rollback, fork or resume replaces it, and the session with it. */
        messages: ReadonlyArray<Harness.HarnessMessage>;
      }
      let liveHarness: LiveHarness | null = null;
      /** The models the running turn reads its keys from: the harness streams through the turn's own. */
      let harnessModels: MutableModels | undefined;
      const closeHarness = Effect.promise(async () => {
        const live = liveHarness;
        liveHarness = null;
        if (live === null) return;
        await live.session.close().catch(() => undefined);
        await live.mcp?.close().catch(() => undefined);
      });

      interface HarnessTurnContext {
        readonly models: MutableModels;
        readonly reasoning: ModelThinkingLevel | undefined;
        readonly runtimeMcp: McpProviderSessionConfig | undefined;
        readonly grill: boolean;
        readonly readAnywhere: boolean;
      }

      /** A denial as the model reads it, instead of the call's result. */
      const deniedText = (deny: string) =>
        deny === "stopped"
          ? "Not run: the turn was stopped."
          : deny === "no_answer"
            ? "Not run: nobody answered the approval request."
            : deny === "cancelled"
              ? "Not run: the user cancelled this action."
              : "Not run: the user declined this action.";

      /**
       * Whether a call runs, for every call the harness makes (direct, or from a program or exec cell): the turn's access
       * mode asks the person (approvals.ts, the classic engine's rules by the same names), then trusted plugins'
       * PreToolUse hooks (MCP calls run them in the runtime's hub). A reason refuses it.
       */
      const harnessDecision = (call: Harness.CallInfo) =>
        Effect.gen(function* () {
          const turn = threadState?.activeTurn;
          if (turn === null || turn === undefined) return "Not run: no turn is running.";
          // The Chief runs full access, and only its own tools: they never ask.
          if (chief !== undefined) return undefined;
          const mcp = call.mcp ?? liveHarness?.direct.get(call.name);
          const policy = callPolicy({ name: call.name, mcp });
          const shown = itemCall(call.name, call.args, mcp);
          const args = call.name === "apply_patch" ? { path: patchFiles(patchText(call.args))[0]?.path } : shown.args;
          const { runtimeMode, sandboxPolicy } = turn.turnInput.runtimePolicy;
          const readOnlySandbox = (sandboxPolicy as { readonly type?: unknown } | undefined)?.type === "readOnly";
          const kind = approvalKindFor(runtimeMode, policy.effect, { name: policy.name, readOnlySandbox, args });
          if (kind !== null) {
            const answer = yield* askApproval(
              turn,
              { toolCallId: call.id, name: policy.name, args, parentToolCallId: call.parentId },
              kind,
            );
            if (answer !== undefined) return deniedText(answer.deny);
          }
          const hooks = projection?.hooks;
          const hooked = mcp === undefined ? hookCall(call.name, call.args) : undefined;
          if (hooks !== undefined && hooked !== undefined) {
            // Stop reaches a hook still running (its process group goes), and the call it guards never runs after it.
            const refused = yield* Effect.promise(() => hooks.preToolUse(hooked.name, hooked.input, turn.abort.signal).catch(() => undefined));
            if (refused !== undefined) return `Blocked by a hook: ${refused}`;
            if (turn.abort.signal.aborted) return "Stopped before it ran.";
          }
          // The gate, last before the call's effect (ToolGate): the runtime gets a command's or an outside tool's
          // intent into Cloud's copy first, and holds a call that would start while the chat is being stopped.
          const item = (id: string) => idAllocator.derive.turnItemFromProviderItem({ driver: CAVEMAN_PROVIDER, nativeItemId: `${turn.providerTurn.id}:tool:${id}` });
          const patched = call.name === "apply_patch" ? patchFiles(patchText(call.args)) : [];
          const named = (shown.args ?? {}) as { readonly command?: unknown; readonly path?: unknown };
          const target = typeof named.command === "string" ? named.command : typeof named.path === "string" ? `${policy.name} ${named.path}` : policy.name;
          const held = yield* Effect.promise(() =>
            beforeTool({
              threadId: input.threadId,
              itemIds: patched.length > 0 ? patched.map((_, index) => item(`${call.id}:${index}`)) : [item(call.id)],
              name: policy.name,
              title: target,
              effect: policy.effect,
              signal: turn.abort.signal,
            }),
          );
          if (held !== undefined) return held;
          if (turn.abort.signal.aborted) return "Stopped before it ran.";
          return undefined;
        });

      /** PostToolUse and PostToolUseFailure on a direct call (not MCP: the hub runs those): a note for the model. */
      const harnessAfterCall = async (call: Harness.CallInfo, result: { readonly text: string; readonly isError: boolean }) => {
        const hooks = projection?.hooks;
        if (hooks === undefined || liveHarness?.direct.has(call.name) === true) return undefined;
        const hooked = hookCall(call.name, call.args);
        if (hooked === undefined) return undefined;
        return result.isError
          ? await hooks.postToolUseFailure?.(hooked.name, hooked.input, result.text).catch(() => undefined)
          : await hooks.postToolUse(hooked.name, hooked.input, result.text).catch(() => undefined);
      };

      /** Calls a declared runtime tool may wait (on another agent, a person): a program bounds its own calls. */
      const HARNESS_MCP_TIMEOUT_MS = 30 * 60_000;

      /**
       * The thread's harness session for this turn's model: the live one when it continues the thread's conversation
       * with the same surface and tools (only the model and effort move), else a new one on the thread's messages (its
       * MCP servers connected now, before the first request, since the tool list is part of the cached prefix).
       *
       * A coding thread runs on the loadout its model was measured on (Claude Code's shape, or Codex's exec surface for
       * GPT); the Chief on the general one, with only its own tools and its own system text. Commands and files go to
       * this computer (macOS, Linux; Windows through Git Bash) or, on a Cloud computer, to the tools container, never
       * beside the runtime's Cloud key.
       */
      const harnessSessionFor = (state: ThreadState, model: Harness.HarnessModel, effort: Harness.Effort | undefined, context: HarnessTurnContext) =>
        Effect.gen(function* () {
          const h = harness;
          const loadout = chief === undefined ? h.appLoadoutFor(model) : h.appLoadouts().general;
          const key = [loadout.name, context.runtimeMcp?.providerSessionId ?? "", String(context.runtimeMcp?.browserToolsAvailable ?? ""), String(context.grill)].join("\0");
          const live = liveHarness;
          const messages = state.messages;
          if (live !== null && live.key === key && live.messages === state.messages) {
            live.session.setModel(model, effort);
            live.env.readAnywhere = context.readAnywhere;
            return live;
          }
          yield* closeHarness;
          // The Chief reaches no MCP server: its tools are its own.
          const { servers: entries, direct } = chief === undefined ? runtimeMcpFor(context.runtimeMcp, context.grill) : { servers: [], direct: [] };
          const servers = harnessMcpServers(entries);
          const mcp =
            Object.keys(servers).length === 0
              ? undefined
              : yield* Effect.promise(() => h.connectMcp(servers, { tolerant: true, clientName: "caveman-code", timeoutMs: HARNESS_MCP_TIMEOUT_MS }));
          for (const failed of mcp?.failed ?? []) yield* Effect.logWarning(`Caveman engine: MCP server ${failed.server} did not connect: ${failed.error}`);
          const declared = (handle: Harness.McpToolHandle) => direct.some((tool) => tool.server === handle.server && tool.tool === handle.name);
          const handles = mcp?.tools ?? [];
          const directHandles = handles.filter(declared);
          const processEnv = {
            ...Object.fromEntries(Object.entries(threadEnv).filter(([name]) => ENV_NAME.test(name))),
            ...secretEnv,
          };
          // On a Cloud computer every command and file runs in the tools container, never beside the runtime's Cloud key:
          // streamed over the runtime's exec channel when it offers one (toolsEnv.ts: a process group and a handle per
          // command), otherwise through the tools container's execution backend.
          const base: Harness.ExecEnv =
            toolsStream !== undefined
              ? yield* Effect.promise(() => ToolsEnv.connect({ stream: toolsStream, cwd, env: processEnv }))
              : executionBackend === undefined
                ? new h.LocalEnv({ cwd, env: processEnv })
                : new BackendEnv({ backend: executionBackend, cwd, env: processEnv });
          const env = new WorkspaceEnv(base, { root: cwd, hidden, readAnywhere: context.readAnywhere, memory: projection?.memory });
          const instructions = chief !== undefined ? chiefInstructions(chief) : [
            // Static text first so the prompt cache holds: screenshots as proof of UI work, then the runtime's tools.
            UI_PROOF_INSTRUCTIONS,
            // Chosen at this session's first agent and kept: never toggled mid-session (runtimeText.ts).
            ...runtimeInstructionBlocks((runtimeText ??= runtimeTextChoice(context.runtimeMcp))),
            renderSections([...(projection?.instructionSections ?? []), ...(sessionStart?.context === undefined ? [] : [{ title: "SessionStart hooks", text: sessionStart.context }])]),
            skills === undefined || skills.skills.length === 0 ? undefined : engine.plugins.renderAgentSkillsIndex(skills.skills),
          ]
            .flatMap((text) => (text === undefined || text.trim() === "" ? [] : [text.trim()]))
            .join("\n\n");
          const stream: Harness.HarnessStreamFn =
            options.engine?.streamFn === undefined
              ? (streamModel, streamContext, streamOptions) => (harnessModels ?? context.models).streamSimple(streamModel, streamContext, streamOptions)
              : (options.engine.streamFn as Harness.HarnessStreamFn);
          const tools =
            chief !== undefined
              ? chiefTools(chief, input.threadId, () => threadState?.activeTurn?.turnInput.runId ?? "")
              : [...h.mcpDirectTools(directHandles, { images: true }), ...(skills === undefined || skills.skills.length === 0 ? [] : [skillTool(engine.plugins, skills)])];
          const session = new h.HarnessSession({
            model,
            stream,
            effort,
            loadout,
            env,
            // Reached from programs (Claude's surface) or exec cells (GPT's); the declared ones are tools of their own.
            mcp: handles.filter((handle) => !declared(handle)),
            tools,
            instructions,
            messages: [...messages],
            hooks: { beforeCall: (call) => runPromise(harnessDecision(call)), afterCall: harnessAfterCall },
          });
          const next: LiveHarness = {
            key,
            session,
            env,
            mcp,
            direct: new Map(directHandles.map((handle) => [handle.qualified, { server: handle.server, tool: handle.name }])),
            messages: state.messages,
          };
          liveHarness = next;
          return next;
        });

      /** A harness event as items, usage and notices: Pi's own events, its calls under the names the app's items know. */
      const handleHarnessEvent = (turn: ActiveTurn, event: Harness.SessionEvent, live: LiveHarness) =>
        Effect.gen(function* () {
          switch (event.type) {
            case "pi": {
              const pi = event.event;
              const phase = pi.type === "tool_execution_start" ? "start" : pi.type === "tool_execution_update" ? "update" : pi.type === "tool_execution_end" ? "end" : undefined;
              if (phase === undefined) return yield* handlePiEvent(turn, pi);
              const name = stringField(pi, "toolName") ?? "tool";
              const raw = field(pi, "args");
              const shown = itemCall(name, raw, live.direct.get(name));
              // bash's exit code rides in its details; the item reads it from the output's first line, as the classic bash wrote it.
              const result = field(pi, "result");
              const code = field(field(result, "details"), "exitCode");
              const led = phase === "end" && name === "bash" && typeof code === "number"
                ? { result: { content: [{ type: "text", text: `exit ${code}\n${contentText(field(result, "content"))}` }] } }
                : {};
              return yield* emitToolItem(turn, { ...pi, toolName: shown.toolName, ...(raw === undefined ? {} : { args: shown.args }), ...led }, phase);
            }
            case "nested_start":
            case "nested_end": {
              const { call } = event;
              const phase = event.type === "nested_start" ? "start" : "end";
              const ended = event.type === "nested_end" ? { isError: event.isError, result: { content: [{ type: "text", text: harnessResultText(call.name, event.result) }] } } : {};
              const files = call.name === "apply_patch" ? patchFiles(patchText(call.args)) : [];
              if (files.length > 0) {
                // A patch is a file change per file it touches.
                for (const [index, file] of files.entries()) {
                  const args = file.kind === "add" ? { path: file.path, content: file.newStr } : { path: file.path, old_string: file.oldStr, new_string: file.newStr };
                  yield* emitToolItem(turn, { toolCallId: `${call.id}:${index}`, toolName: file.kind === "add" ? "write_file" : "edit_file", args, ...ended }, phase);
                }
                return;
              }
              const shown = itemCall(call.name, call.args, call.mcp);
              return yield* emitToolItem(turn, { toolCallId: call.id, toolName: shown.toolName, args: shown.args, ...ended }, phase);
            }
            case "side_usage": {
              // A keep-alive ping or a compaction's summary: counted with the run, never shown.
              const run = turn.runUsage.at(-1);
              if (run === undefined) return;
              run.input += event.usage.input + event.usage.cacheWrite;
              run.cached += event.usage.cacheRead;
              run.written += event.usage.cacheWrite;
              run.output += event.usage.output;
              run.reasoning += event.usage.reasoning;
              run.calls += event.usage.requests;
              if (planProvidersFor(turn.keys, turn.model).has(live.session.model.provider)) run.planCalls += event.usage.requests;
              return;
            }
            case "compacted":
              if (threadState?.activeTurn === turn) threadState.compacted = true;
              return yield* emitNotice(turn, "Context compacted: the conversation so far was summarized so the work can go on.");
            default:
              return;
          }
        });

      /**
       * Drives one provider turn: one session turn, plus one more for each steer that arrived after its last model call
       * (or a Stop hook's reason); each leaves its conversation in the journal under its own run id. Auto decides each
       * ask before its run. The caller finalizes the turn however this exits.
       */
      const driveTurn = (state: ThreadState, turn: ActiveTurn, firstInput: TurnInput, context: HarnessTurnContext) =>
        Effect.gen(function* () {
          harnessModels = context.models;
          let input = firstInput;
          let reasoning = context.reasoning;
          while (true) {
            // The session compacted this thread's context in an earlier run: trusted plugins' SessionStart hooks for a
            // compaction run now, as Claude Code runs them after its own, and what they print goes with this input.
            if (state.compacted === true) {
              state.compacted = false;
              const compactContext = yield* runSessionStart("compact");
              if (compactContext !== undefined && compactContext !== "") {
                const note = `<session-start-hook>\n${compactContext}\n</session-start-hook>`;
                input = typeof input === "string" ? `${input}\n\n${note}` : [...input, { type: "text", text: note }];
              }
            }
            if (turn.auto !== undefined) {
              const hasImages = typeof input !== "string" && input.some((part) => part.type === "image");
              const decision = yield* Effect.promise(() =>
                turn.auto!.router.decide({ currentModel: turn.model, ctxTokens: turn.contextTokens, hasImages, toolErrorStreak: 0 }).catch(() => undefined),
              );
              const routed = decision === undefined ? undefined : context.models.getModel(sourceOf(decision.model), decision.model.slice(sourceOf(decision.model).length + 1));
              if (decision !== undefined && routed !== undefined && (!hasImages || routed.input.includes("image"))) {
                turn.model = decision.model;
                reasoning = decision.reasoning ?? defaultEffort(routed);
                yield* emitRoute(turn, decision.model);
              }
            }
            const provider = sourceOf(turn.model);
            const model = (options.engine?.model as Harness.HarnessModel | undefined) ?? (context.models.getModel(provider, turn.model.slice(provider.length + 1)) as Harness.HarnessModel | undefined);
            if (model === undefined) {
              turn.failure = failureFrom(`The Caveman engine has no model ${turn.model}.`, turn.secrets, "provider_error");
              return;
            }
            const effort = reasoning === undefined || reasoning === "off" ? undefined : (reasoning as Harness.Effort);
            const live = yield* harnessSessionFor(state, model, effort, context);
            const runId = `${state.nativeThreadId}-${randomUUID().slice(0, 12)}`;
            turn.runUsage.push(noUsage());
            const channel = eventChannel<Harness.SessionEvent>();
            const running = live.session
              .runTurn(typeof input === "string" ? input : [...input], { signal: turn.abort.signal, onEvent: channel.push, steering: () => turn.pendingSteers.splice(0) })
              .finally(channel.end);
            yield* Stream.fromAsyncIterable(channel.events, (cause) => cause).pipe(
              Stream.runForEach((event) => permit.withPermits(1)(handleHarnessEvent(turn, event, live))),
              Effect.catch(() => Effect.void),
            );
            const outcome = yield* Effect.promise(() => running);
            // The conversation this run ends on, in the journal before the turn names it as its head.
            const messages = live.session.messages;
            const saved = yield* Effect.tryPromise(() =>
              writeHarnessCheckpoint(harnessDir, { runId, model: turn.model, loadout: live.session.loadout.name, messages }),
            ).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));
            state.messages = messages;
            live.messages = messages;
            if (saved) turn.runIds.push(runId);
            else if (!turn.interrupted && turn.failure === null) turn.failure = failureFrom("The Caveman engine could not save the conversation.", turn.secrets, "transport_error");
            const run = turn.runUsage.at(-1)!;
            run.settled = true;
            run.usd = run.planCalls > 0 ? null : outcome.usage.costUsd;
            if (outcome.status === "error" && !turn.interrupted && turn.failure === null && turn.modelError === null) {
              turn.failure = failureFrom(outcome.error ?? outcome.stopReason, turn.secrets, outcome.stopReason === "harness_error" ? "transport_error" : "provider_error", onCredits(live.session.model.provider));
            }
            if (outcome.status === "stopped" && outcome.stopReason !== "aborted" && !turn.interrupted) yield* emitNotice(turn, harnessStopNotice(outcome.stopReason));
            // A model error no retry answered ends the turn with the provider's own words.
            if (!turn.interrupted && turn.failure === null) turn.failure = turn.modelError;
            const next = yield* nextInput(turn);
            if (next === null) return;
            input = next;
          }
        });

      // ── thread registration ───────────────────────────────

      const registerThread = Effect.fnUntraced(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        publish = true,
      ) {
        if (threadState?.activeTurn != null) return yield* protocolError("Cannot switch Caveman threads while a turn is active");
        const existing = threadInput.existingProviderThread;
        const resumeId = existing?.nativeThreadRef?.nativeId;
        const createdAt = yield* DateTime.now;
        if (existing !== undefined && resumeId != null) {
          const head = existing.nativeConversationHeadRef?.nativeId ?? null;
          // The live conversation is already this head; the journal is read only on a fresh session.
          const live =
            threadState !== null &&
            threadState.nativeThreadId === resumeId &&
            (threadState.providerThread.nativeConversationHeadRef?.nativeId ?? null) === head;
          const messages = live ? threadState!.messages : yield* messagesAfter(head);
          if (!live) yield* closeHarness;
          yield* startSession(resumeId, resumeId);
          threadState = {
            nativeThreadId: resumeId,
            messages,
            activeTurn: null,
            providerThread: { ...existing, providerSessionId: input.providerSessionId, status: "idle", updatedAt: createdAt },
          };
        } else {
          const nativeThreadId = `cvm-${randomUUID().replaceAll("-", "")}`;
          yield* closeHarness;
          yield* startSession(nativeThreadId, null);
          threadState = {
            nativeThreadId,
            messages: [],
            activeTurn: null,
            providerThread: {
              id: idAllocator.derive.providerThread({ driver: CAVEMAN_PROVIDER, nativeThreadId }),
              driver: CAVEMAN_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: providerRef(nativeThreadId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt,
              updatedAt: createdAt,
            },
          };
        }
        if (publish) yield* emit({ type: "provider_thread.updated", driver: CAVEMAN_PROVIDER, providerThread: threadState.providerThread });
        return threadState.providerThread;
      });

      const snapshotOf = (state: ThreadState): ProviderAdapter.ProviderAdapterV2ThreadSnapshot => {
        const threadId = state.providerThread.appThreadId ?? input.threadId;
        const messages = state.messages.flatMap((message, index) => {
          const role = stringField(message, "role");
          if (role !== "user" && role !== "assistant") return [];
          const raw = contentText(field(message, "content"));
          const text = role === "user" ? userWords(raw) : raw;
          if (text.length === 0) return [];
          // The engine's own notes (a classic run's runawayStop, a compaction's summary) are not something the person said.
          if (role === "user" && (isHarnessNote(text) || harness.isCompactionSummary(text))) return [];
          const timestamp = field(message, "timestamp");
          const at = Option.getOrElse(
            DateTime.make(typeof timestamp === "number" ? timestamp : Number.NaN),
            () => state.providerThread.createdAt,
          );
          return [
            {
              id: idAllocator.derive.messageFromProviderItem({
                driver: CAVEMAN_PROVIDER,
                nativeItemId: `${state.nativeThreadId}:${state.providerThread.nativeConversationHeadRef?.nativeId ?? "start"}:message:${index}`,
              }),
              threadId,
              runId: null,
              nodeId: null,
              role: role as "user" | "assistant",
              text,
              attachments: [],
              streaming: false,
              createdBy: role === "user" ? ("user" as const) : ("agent" as const),
              creationSource: "provider" as const,
              createdAt: at,
              updatedAt: at,
            },
          ];
        });
        return { providerThread: state.providerThread, providerTurns: [], messages, runtimeRequests: [] };
      };

      const hostedState = (providerThread: OrchestrationV2ProviderThread, action: string) =>
        Effect.gen(function* () {
          const state = threadState;
          if (state === null || state.nativeThreadId !== providerThread.nativeThreadRef?.nativeId) {
            return yield* protocolError(`Caveman ${action} requested for a thread this session does not host`);
          }
          if (state.activeTurn !== null) return yield* protocolError(`Cannot ${action} while a Caveman turn is active`);
          return state;
        });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: CAVEMAN_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        getModelContextWindow: (selection) =>
          selection.instanceId === options.instanceId ? modelContextWindows.get(selection.model) : undefined,
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) => new ProviderAdapter.ProviderAdapterEnsureThreadError({ driver: CAVEMAN_PROVIDER, threadId: threadInput.threadId, cause }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId: threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: CAVEMAN_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null) return yield* protocolError("Caveman session has no registered thread");
            // The orchestration starts a run once the one before it ended, so a turn still here from an earlier run is
            // one a Stop ended while its start was in flight: the Stop cancels the start, and can land after the turn
            // began but before the orchestration saw it, so nothing stops that turn or waits for it. Stop it here,
            // and start once it has settled.
            const stale = state.activeTurn;
            if (stale !== null && stale.turnInput.runOrdinal < turnInput.runOrdinal) {
              stopTurn(stale);
              yield* Deferred.await(stale.settled).pipe(Effect.timeoutOption("10 seconds"));
            }
            if (state.activeTurn !== null) return yield* protocolError(`Caveman thread ${turnInput.providerThread.id} already has an active turn`);
            if (state.nativeThreadId !== turnInput.providerThread.nativeThreadRef?.nativeId) {
              return yield* protocolError("Caveman turn requested for a different native thread");
            }
            const policyRefusal = runtimePolicyRefusal(turnInput.runtimePolicy, runtimeTools);
            if (policyRefusal !== null) return yield* protocolError(policyRefusal);
            const grill = turnInput.runtimePolicy.interactionMode === "grill";
            const keys = yield* readCavemanKeys(options.instanceId);
            const models: MutableModels = modelsThroughScrub(yield* cavemanModels(keys, yield* storedSignIns(options.instanceId)), route, host.connections?.headers(input.threadId));
            // Auto runs only on what is connected now (read each turn, so a removed key is gone from the next one).
            const autoTurn = isAutoModel(turnInput.modelSelection.model);
            const connected = autoTurn ? connectedModels(keys, models) : [];
            if (autoTurn && connected.length === 0) return yield* protocolError(NOTHING_CONNECTED);
            // The engine default until Cloud answers, for the Chief too.
            const preferred = !autoTurn ? null : resolveCavemanModel(CAVEMAN_AUTO_MODEL, keys);
            const model = autoTurn ? (preferred !== null && connected.includes(preferred) ? preferred : connected[0]!) : resolveCavemanModel(turnInput.modelSelection.model, keys);
            if (model === null) return yield* protocolError(cavemanModelRefusal(turnInput.modelSelection.model, keys));
            const keyProvider = model.slice(0, model.indexOf("/"));
            // Started without the scrub and the repository has secrets now (or the store cannot tell): stop.
            if (route(CAVEMAN_GATEWAY_URL) === undefined) {
              const secretsNow = yield* readSecretEnv().pipe(
                Effect.map((env) => Object.keys(env).length > 0),
                Effect.orElseSucceed(() => true),
              );
              if (secretsNow) {
                return yield* protocolError(
                  "This project has secrets now, and this Caveman engine session runs without the egress scrub that keeps them from the model. Start a new session.",
                );
              }
            }
            const routing = autoTurn ? yield* Effect.promise(() => host.routing?.get() ?? Promise.resolve(undefined)) : undefined;
            const auto = autoTurn && routing ? autoRouteFor(state.nativeThreadId, model, connected, connectedSources(keys, models)) : undefined;
            if (auto !== undefined) {
              auto.ask.text = turnInput.message.text;
              auto.ask.seq++;
            }
            const catalogModel = models.getModel(keyProvider, model.slice(keyProvider.length + 1));
            if (catalogModel !== undefined) modelContextWindows.set(turnInput.modelSelection.model, catalogModel.contextWindow);
            // The person's effort, else what an untouched turn runs at (defaultEffort); undefined: the model offers none.
            const reasoning =
              catalogModel === undefined
                ? undefined
                : (effortLevel(catalogModel, getModelSelectionStringOptionValue(turnInput.modelSelection, "effort")) ?? defaultEffort(catalogModel));
            // Cloud hears the turn's effort; medium where the provider's own default applies.
            if (auto !== undefined) auto.effort = reasoning ?? "medium";
            // The Chief has no runtime MCP server: its tools are its own.
            const runtimeMcp = chief === undefined && Option.isSome(mcpSessions) ? yield* mcpSessions.value.read(turnInput.threadId) : undefined;
            if (grill && runtimeMcp === undefined) return yield* protocolError("Grill mode needs the runtime's tools, and this thread has none. Turn grill mode off to use it.");
            // The turn that enters grill mode loads the skill; the runtime's mention always leaves the text.
            const grillRest = runtimeTools.grill?.takeSkillMention(turnInput.message.text);
            const text =
              grillRest === undefined
                ? expandSkillMentions(engine.plugins, turnInput.message.text, skills)
                : grill
                  ? grillSkillText(yield* fileSystem.readFileString(runtimeTools.grill!.skillPath).pipe(Effect.mapError((cause) => protocolError("The grill skill could not be read", cause))), grillRest)
                  : grillRest;
            // Trusted plugins' UserPromptSubmit hooks, as Claude Code runs them: one may refuse the prompt (the turn
            // ends with its reason and nothing reaches the model), or send context with it.
            const submitted =
              projection?.hooks?.userPromptSubmit === undefined
                ? undefined
                : yield* Effect.promise(() => projection.hooks!.userPromptSubmit!(turnInput.message.text).catch(() => undefined));
            if (submitted?.block !== undefined) return yield* new SessionPlugins.HookBlockedPrompt({ reason: submitted.block });
            const prompted = submitted?.context === undefined ? text : `${text}\n\n<user-prompt-submit-hook>\n${submitted.context}\n</user-prompt-submit-hook>`;
            const payload = yield* promptInput(prompted, turnInput.message.attachments, host.resolveAttachmentPath, host.resolveExtractedTextPath);
            const readAnywhere = executionBackend === undefined && turnInput.runtimePolicy.runtimeMode === "full-access";
            const startedAt = yield* DateTime.now;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({ driver: CAVEMAN_PROVIDER, nativeTurnId: `${state.nativeThreadId}:attempt:${turnInput.attemptId}` }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: null,
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const turn: ActiveTurn = {
              turnInput,
              providerTurn,
              pendingSteers: [],
              abort: new AbortController(),
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              messageOrdinal: 0,
              streamItems: new Map(),
              toolArgs: new Map(),
              toolStartedAt: new Map(),
              openTools: new Set(),
              steers: [],
              finalizing: false,
              runIds: [],
              secrets: [...cavemanSecrets(keys), ...(routing ? [routing.key] : [])],
              keys,
              approvals: new Map(),
              cellEnds: new Map(),
              interrupted: false,
              settled: Deferred.makeUnsafe<void>(),
              failure: null,
              modelError: null,
              toolFailure: null,
              runUsage: [],
              contextTokens: 0,
              auto,
              model,
            };
            // Claiming the thread and forking the drive that frees it are one step: a Stop cancels a start by
            // interrupting it (EffectWorker), and a claim with no drive left the thread busy for every later turn.
            // A start interrupted once it began stops the turn it began.
            yield* Effect.uninterruptibleMask((restore) =>
              permit
                .withPermits(1)(
                  Effect.gen(function* () {
                    if (threadState !== state || state.activeTurn !== null || closed) {
                      return yield* protocolError("Caveman turn ownership changed before it could start");
                    }
                    state.providerThread = turnInput.providerThread;
                    state.activeTurn = turn;
                    yield* emit({ type: "provider_turn.updated", driver: CAVEMAN_PROVIDER, threadId: turnInput.threadId, providerTurn });
                    yield* updateProviderThread(state, {
                      status: "active",
                      firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                      lastRunOrdinal: turnInput.runOrdinal,
                    });
                    yield* updateProviderSession("running", null);
                    if (autoTurn && !routing) yield* emitNotice(turn, `Auto unavailable. Running ${model}.`);
                  }),
                )
                .pipe(
                  Effect.andThen(
                    driveTurn(state, turn, payload, { models, reasoning, runtimeMcp, grill, readAnywhere }).pipe(
                      // However the drive ends (a defect included), the turn settles and the thread is free. A drive
                      // that did not end on its own (interrupted: its session closing) stops its run too: the run never
                      // outlives it, with model calls and tools going on for a session that is gone.
                      Effect.onExit((exit) =>
                        permit.withPermits(1)(
                          Effect.suspend(() => {
                            if (Exit.isFailure(exit)) turn.abort.abort();
                            if (Exit.isFailure(exit) && !turn.interrupted && turn.failure === null) {
                              if (Cause.hasInterruptsOnly(exit.cause)) turn.interrupted = true;
                              else turn.failure = failureFrom(errorText(Cause.squash(exit.cause)), turn.secrets, "transport_error");
                            }
                            return finalizeTurn(state, turn);
                          }),
                        ),
                      ),
                      Effect.forkIn(scope),
                    ),
                  ),
                  Effect.andThen(restore(Effect.void).pipe(Effect.onInterrupt(() => Effect.sync(() => stopTurn(turn))))),
                ),
            );
          }).pipe(
            Effect.provide(hostContext),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: CAVEMAN_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (steerInput) =>
          permit.withPermits(1)(
            Effect.gen(function* () {
              const turn = threadState?.activeTurn ?? null;
              if (turn === null || turn.finalizing || turn.providerTurn.id !== steerInput.providerTurnId) {
                return yield* protocolError(`Caveman turn ${steerInput.providerTurnId} is not active`);
              }
              const text = steerInput.message.text.trim();
              if (text === "") return yield* protocolError("Caveman steering needs text");
              turn.steers.push(text);
              turn.pendingSteers.push(text);
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver: CAVEMAN_PROVIDER,
                  providerThreadId: steerInput.providerThread.id,
                  providerTurnId: steerInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: (interruptInput) =>
          Effect.sync(() => {
            const turn = threadState?.activeTurn ?? null;
            // Nothing runs between turns, so a Stop on a settled turn has nothing to stop.
            if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) return;
            stopTurn(turn);
          }),
        respondToRuntimeRequest: (requestInput) =>
          Effect.gen(function* () {
            const pending = threadState?.activeTurn?.approvals.get(String(requestInput.requestId));
            if (pending === undefined) return yield* protocolError(`No pending Caveman approval ${requestInput.requestId}`);
            if (requestInput.decision === undefined) return yield* protocolError(`Caveman approval ${requestInput.requestId} needs a decision`);
            if (!(yield* Deferred.succeed(pending, requestInput.decision))) {
              return yield* protocolError(`Caveman approval ${requestInput.requestId} was already answered`);
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: CAVEMAN_PROVIDER,
                  requestId: requestInput.requestId,
                  cause,
                }),
            ),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null || state.nativeThreadId !== snapshotInput.providerThread.nativeThreadRef?.nativeId) {
              return yield* protocolError("Caveman snapshot requested for a thread this session does not host");
            }
            return snapshotOf(state);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                  driver: CAVEMAN_PROVIDER,
                  providerThreadId: snapshotInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        rollbackThread: (rollbackInput) =>
          permit.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* hostedState(rollbackInput.providerThread, "roll back");
              const head =
                rollbackInput.target.type === "thread_start" ? null : (rollbackInput.target.providerTurn.nativeTurnRef?.nativeId ?? undefined);
              if (head === undefined) return yield* protocolError("Caveman rollback target has no journaled run");
              state.messages = yield* messagesAfter(head);
              // Its processes, cells and warm cache belong to the turns rolled back.
              yield* closeHarness;
              yield* updateProviderThread(state, { nativeConversationHeadRef: head === null ? null : providerRef(head) });
              return snapshotOf(state);
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRollbackThreadError({
                  driver: CAVEMAN_PROVIDER,
                  providerThreadId: rollbackInput.providerThread.id,
                  checkpointId: rollbackInput.target.checkpointId,
                  cause,
                }),
            ),
          ),
        forkThread: (forkInput) =>
          Effect.gen(function* () {
            if (threadState?.activeTurn != null) return yield* protocolError("Cannot fork while a Caveman turn is active");
            const source = forkInput.sourceProviderThread;
            const target =
              forkInput.providerTurnId === undefined
                ? undefined
                : (forkInput.sourceProviderTurns ?? []).find((turn) => turn.id === forkInput.providerTurnId);
            if (forkInput.providerTurnId !== undefined && target?.nativeTurnRef == null) {
              return yield* protocolError("Caveman fork target turn has no journaled run");
            }
            const head = target?.nativeTurnRef?.nativeId ?? source.nativeConversationHeadRef?.nativeId ?? null;
            const messages = yield* messagesAfter(head);
            const nativeThreadId = `cvm-${randomUUID().replaceAll("-", "")}`;
            const now = yield* DateTime.now;
            const providerThread: OrchestrationV2ProviderThread = {
              ...source,
              id: idAllocator.derive.providerThread({ driver: CAVEMAN_PROVIDER, nativeThreadId }),
              appThreadId: forkInput.targetThreadId,
              providerSessionId: input.providerSessionId,
              providerInstanceId: options.instanceId,
              ownerNodeId: forkInput.ownerNodeId ?? null,
              nativeThreadRef: providerRef(nativeThreadId),
              // The fork's head is the source run; its own runs take over from the first turn.
              nativeConversationHeadRef: head === null ? null : providerRef(head),
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              pendingBackgroundTasks: [],
              forkedFrom: {
                providerThreadId: source.id,
                ...(forkInput.providerTurnId === undefined ? {} : { providerTurnId: forkInput.providerTurnId }),
              },
              createdAt: now,
              updatedAt: now,
            };
            yield* closeHarness;
            yield* startSession(nativeThreadId, source.nativeThreadRef?.nativeId ?? nativeThreadId);
            threadState = { nativeThreadId, messages, activeTurn: null, providerThread };
            return providerThread;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterForkThreadError({
                  driver: CAVEMAN_PROVIDER,
                  providerThreadId: forkInput.sourceProviderThread.id,
                  cause,
                }),
            ),
          ),
      };
      return runtime;
    }),
  });
});

/**
 * A model call's error as a provider failure. On Caveman credits (`credits`), Cloud's gateway says which plan limit
 * refused the call and when it lifts: a usage limit the runtime resumes after, or one only credits or another plan lift.
 * Anything else, and every other provider, is read from the error's words.
 */
export function failureFrom(
  message: string,
  secrets: ReadonlyArray<string>,
  failureClass: "provider_error" | "transport_error" = "provider_error",
  credits = false,
) {
  const text = redact(message, secrets);
  const refusal = credits ? creditsRefusal(text) : undefined;
  if (refusal !== undefined) {
    return makeProviderFailure({ message: refusal.message, code: CREDITS_LIMIT_CODE, class: "usage_limit", retryable: refusal.retryable, resetAt: refusal.resetAt });
  }
  const limited = /\b429\b|rate.?limit|quota|insufficient_quota/i.test(text);
  const auth = /\b401\b|\b403\b|api key|unauthori[sz]ed|authentication/i.test(text);
  return makeProviderFailure({
    message: text,
    class: limited ? "usage_limit" : auth ? "permission_error" : failureClass,
    retryable: limited ? true : null,
  });
}

export type CavemanAdapterV2DriverEnv =
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderHost.ProviderHost;

export const CavemanAdapterV2Driver: ProviderAdapterDriver<CavemanSettings, CavemanAdapterV2DriverEnv> = {
  driverKind: CAVEMAN_PROVIDER,
  configSchema: CavemanSettings,
  defaultConfig: (): CavemanSettings => DEFAULT_CAVEMAN_SETTINGS,
  create: Effect.fn("CavemanAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CavemanSettings>) {
      return yield* makeCavemanAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: CAVEMAN_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create the Caveman engine adapter.",
              cause,
            }),
        ),
      ),
  ),
};
