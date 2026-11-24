// The Caveman router in Caveman Code: a chat whose model is Auto runs its
// engine through the app's own caveman-proxy (proxyLauncher.ts), which asks
// Caveman Cloud which model and effort each message gets, among the engine's
// own vendor's models only. The policy stays in Cloud; the app only points
// engines at the proxy and reads, locally, which model each call ran on.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CAVEMAN_GATEWAY_URL } from "@caveman-app/provider-caveman/server";
import type { EngineDescriptor } from "@caveman-app/session-protocol";

import { APP_CLAUDE_AGENT, appProxyHome, appProxyUrl, codexProxyUrl } from "./proxyLauncher.ts";
import { isRouterModel, ROUTER_MODEL } from "./routerModel.ts";

export { isRouterModel, ROUTER_MODEL };

/** The person's own caveman-proxy (`caveman start`); provider-caveman's CAVEMAN_GATEWAY_URL. The app's chats never use it. */
export const PERSONAL_PROXY_URL = CAVEMAN_GATEWAY_URL;

/** Keys the proxy's route records and its warm-session routing to one chat. */
export const ROUTER_SESSION_HEADER = "x-cave-session";

/**
 * A chat's id as the proxy takes it (`[A-Za-z0-9._:-]`, at most 256): a delegated chat's id carries `%`, which the
 * proxy would refuse, leaving its rows unattributed. Anything else is spelled `_hh`; the same function keys the reads.
 */
export const proxySession = (threadId: string): string => {
  const safe = threadId.replace(/[^A-Za-z0-9.:-]/gu, (char) =>
    [...Buffer.from(char, "utf8")].map((byte) => `_${byte.toString(16).padStart(2, "0")}`).join(""));
  return safe.length <= 256 ? safe : `${safe.slice(0, 239)}.${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 16)}`;
};


/** Auto in an engine's model list. */
export const ROUTER_MODEL_ENTRY: EngineDescriptor["models"][number] = {
  id: ROUTER_MODEL,
  label: "Auto",
  efforts: [],
  description: "Caveman picks the model for each message",
};

export const ROUTER_UNAVAILABLE = "Auto needs Caveman credits or a paid Caveman plan, and Caveman Code's proxy running. Pick another model.";
/**
 * Why Auto can't run Claude Agent or Codex on a Cloud computer whose Cloud does not route it there (an older Cloud, or
 * its switch off: `routes_auto` names neither): their Auto is the app's proxy asking Caveman with the person's
 * sign-in, which a Cloud computer never keeps, and under the credential rule their requests leave through Cloud's data
 * plane. Where Cloud names the agent, its data plane routes Auto. The Caveman engine's Auto does run there
 * either way (routerKey.ts).
 */
export const routerUnavailableOnComputer = (engine: string) =>
  `Auto doesn't run ${engine === "codex" ? "Codex" : "Claude Agent"} in Cloud yet. Pick a model, or use Caveman's Auto.`;
/** What a chat that moved here on Auto says once, where Auto does not run for its agent: the model it runs on now. */
export const autoLeftNote = (model: string) => `This chat runs on ${model} now. Auto isn't available here.`;
export const ROUTER_UNAVAILABLE_HERE =
  "Auto can't run in this project: its Claude settings send Claude Code to another endpoint or a cloud lane. Pick another model.";
export const ROUTER_UNAVAILABLE_CODEX = "Auto can't run for Codex here: its config sends Codex to a model provider other than OpenAI. Pick another model.";

/**
 * Whether Claude Code may be pointed at the proxy in `cwd`: the same files the
 * launch reads (user, project, local settings), so the picker's Auto never
 * meets an unknown-model error at launch.
 */
export const claudeRoutableIn = (cwd: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  claudeRoutable({ ...env, ...claudeSettingsFilesEnv({ env, cwd }) });

/** The engines whose chats Auto routes, through the app's proxies. */
const ROUTER_ENGINES = new Set(["claude-agent", "codex"]);

const readJson = (file: string): Record<string, unknown> => {
  try {
    const doc: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    return typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

type ClaudeSettingSource = "user" | "project" | "local";

/**
 * The `env` blocks of the Claude Code settings files the CLI loads, later ones
 * winning (user, project, local), as strings. The CLI applies them over its
 * process env. EngineEgress's claudeSettingsEnv reads the same files; it cannot
 * be imported here (EngineEgress loads the Claude adapter, which loads this).
 */
export function claudeSettingsFilesEnv(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string | null;
  readonly sources?: ReadonlyArray<ClaudeSettingSource> | undefined;
}): Record<string, string> {
  const files: Array<[ClaudeSettingSource, string]> = [
    ["user", NodePath.join(input.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude"), "settings.json")],
  ];
  if (input.cwd) {
    files.push(["project", NodePath.join(input.cwd, ".claude", "settings.json")]);
    files.push(["local", NodePath.join(input.cwd, ".claude", "settings.local.json")]);
  }
  const out: Record<string, string> = {};
  for (const [source, file] of files) {
    if (!(input.sources ?? ["user", "project", "local"]).includes(source)) continue;
    const env = readJson(file).env;
    if (typeof env !== "object" || env === null) continue;
    for (const [name, value] of Object.entries(env)) if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** Claude Code lanes that bypass ANTHROPIC_BASE_URL (v4's claudeOffProxyLane). */
const CLAUDE_CLOUD_LANES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_FOUNDRY"];

/**
 * Whether Claude Code, with this effective env (process env under its settings
 * files' env), may be pointed at the proxy: it talks to api.anthropic.com or
 * already to the proxy, and no cloud lane is on. Otherwise its credentials for
 * another gateway would reach Anthropic, or Bedrock would get `caveman-auto`.
 */
export function claudeRoutable(env: Readonly<Record<string, string | undefined>>): boolean {
  if (CLAUDE_CLOUD_LANES.some((name) => !["", "0", "false"].includes((env[name] ?? "").trim().toLowerCase()))) return false;
  const base = env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return true;
  try {
    const url = new URL(base);
    const app = appProxyUrl();
    return url.host === "api.anthropic.com" || url.origin === new URL(PERSONAL_PROXY_URL).origin || (app !== undefined && url.origin === new URL(app).origin);
  } catch {
    return false;
  }
}

/**
 * Whether Auto can route `engine`: writeProxyCloud enables routing only
 * with this app's paid routing credential. Never the person's own caveman sign-in. For
 * Claude Agent, Claude Code itself must be routable too (claudeRoutable, with
 * the user's settings file).
 */
export function routingConfigured(engine: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!ROUTER_ENGINES.has(engine)) return false;
  if (engine === "claude-agent" && !claudeRoutable({ ...env, ...claudeSettingsFilesEnv({ env, sources: ["user"] }) })) return false;
  const home = appProxyHome();
  if (home === undefined) return false;
  const doc = readJson(NodePath.join(home, "cloud.json"));
  return (doc.modules as { routing?: unknown } | undefined)?.routing === true && typeof doc.baseURL === "string" && doc.baseURL !== "" && doc.tokenStore === "file";
}

/** Whether Auto is offered for `engine`: routing is configured and the engine's proxy is up. */
export function routerOffered(engine: string): Promise<boolean> {
  return Promise.resolve(routingConfigured(engine) && (engine === "codex" ? codexProxyUrl() : appProxyUrl()) !== undefined);
}

/** Claude Code's id for Auto: for an id it does not know, `[1m]` gives the 1M window, and it is stripped before sending. */
export const CLAUDE_ROUTER_MODEL = `${ROUTER_MODEL}[1m]`;

/** `name: value` in an ANTHROPIC_CUSTOM_HEADERS block (one header a line), replacing any earlier value. */
export const withCustomHeader = (block: string | undefined, name: string, value: string): string =>
  [
    ...(block ?? "").split(/\r\n|\n|\r/).filter((line) => {
      const colon = line.indexOf(":");
      return line.trim() !== "" && (colon < 0 ? line : line.slice(0, colon)).trim().toLowerCase() !== name;
    }),
    `${name}: ${value}`,
  ].join("\n");

/**
 * Settings env that runs Claude Code on Auto, as caveman v4 wires it: traffic
 * to the app proxy's Claude route (the agent slug Cloud holds to Claude models), keyed to `session`, with Auto as Claude Code's
 * custom model so it keeps effort and thinking. Flag settings, so it outranks
 * a base URL in the user's settings files. Claude Code's own login travels to
 * the proxy, which forwards it; nothing here reads it. `env` is Claude Code's
 * effective env (process env under its settings files'), which must be
 * claudeRoutable.
 */
export function claudeRouterEnv(session: string, env: Readonly<Record<string, string | undefined>>, proxy: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `${proxy}/w/${APP_CLAUDE_AGENT}`,
    ANTHROPIC_CUSTOM_HEADERS: withCustomHeader(env.ANTHROPIC_CUSTOM_HEADERS, ROUTER_SESSION_HEADER, proxySession(session)),
    ANTHROPIC_CUSTOM_MODEL_OPTION: CLAUDE_ROUTER_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,max_effort,xhigh_effort,thinking,adaptive_thinking,interleaved_thinking",
    // Auto is offered only while the proxy sends Claude to api.anthropic.com
    // (routingConfigured), so the claim that keeps the 1M window is true.
    ...(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL === undefined ? { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" } : {}),
  };
}

/**
 * Settings env that runs Claude Code on Auto where Cloud's data plane routes it (a Cloud computer whose Cloud names
 * Claude Agent in `routes_auto`, the spec): Auto as Claude Code's custom model, so it keeps effort and thinking and
 * sends `caveman-auto`, and nothing else. Its requests already leave through the egress scrub to the data plane, which
 * picks the model and sends them on to api.anthropic.com, so the first-party claim that keeps the 1M window is true.
 */
export function claudeCloudAutoEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return {
    ANTHROPIC_CUSTOM_MODEL_OPTION: CLAUDE_ROUTER_MODEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,max_effort,xhigh_effort,thinking,adaptive_thinking,interleaved_thinking",
    ...(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL === undefined ? { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" } : {}),
  };
}
