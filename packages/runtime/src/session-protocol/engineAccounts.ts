// Settings -> Models & keys: engine.account.add / .remove / .activate / .test /
// .signin, engine.providers, and the accounts engine.list shows. A key arrives
// once and goes straight to where its engine reads it; nothing here returns,
// logs or journals one.
//   Caveman engine: the runtime's secret store (setCavemanKey), sealed with a
//     key in the OS keychain; tested with one tiny call before it is kept.
//   Codex: Codex's own API-key login inside the account's app-managed
//     CODEX_HOME (ProviderAuthService), sent over the app-server's stdin.
//   Claude Agent: never a key; the user's own `claude` login, and further logins each in a config
//     folder of its own (CLAUDE_CONFIG_DIR), signed in there with their own `claude`.
import { randomBytes, randomUUID } from "node:crypto";
import * as os from "node:os";

import { CodexSettings, isSecretReference, ProviderInstanceId, type SecretReference, type ServerProvider } from "@caveman-app/protocol";
import type { EngineAccount, EngineProvider, KeyHealth, Params, SessionEvent } from "@caveman-app/session-protocol";
import { mergeProviderInstanceEnvironment } from "@caveman-app/engine-core/server/instanceEnvironment";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import {
  CREDITS_INFO,
  cavemanModels,
  connectedSources,
  FEATURED_PROVIDERS,
  LOCAL_PRESETS,
  MORE_PROVIDERS,
  isAddableProvider,
  providerInfo,
  KEY_SLOT,
  slotProvider,
  providerOrder,
  CavemanKeyTester,
  classifyProviderError,
  readCavemanKeys,
  resolveCavemanModel,
  setCavemanKey,
  startProviderSignIn,
  storedSignIns,
  type CavemanCredential,
  type CavemanKeyProvider,
  type CavemanKeys,
  type CavemanProviderInfo,
  type KeyTest,
} from "@caveman-app/provider-caveman/server";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CODEX_API_KEY_METHOD_ID, codexManagedHomePath, removeCodexAccount } from "../provider/CodexApiKeyAccount.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import { removeTree } from "../removeTree.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isRouterModel } from "../router/cavemanRouter.ts";
import { ProtocolError } from "./handlers.ts";
import { makeInsideComputer, RULE_UNHEARD } from "./insideComputer.ts";
import { accountIdOf, CLAUDE_ACCOUNT_PREFIX, CLAUDE_DEFAULT_ACCOUNT, CODEX_ACCOUNT_PREFIX, engineIdForInstance, instanceOfAccount } from "./projector.ts";
import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import { ANTHROPIC_VIA_PROXY } from "../secrets/EgressScrub.ts";
import { SecretResolver } from "../secrets/SecretResolver.ts";
import { assignAccountTags, defaultAccountTag, HARNESS_ACCOUNT_INFIX, HARNESSES, harnessEngineOf, harnessProvider, harnessProxies } from "./harnesses.ts";
import { SessionStore } from "./store.ts";
import { EngineCloudKeys } from "../cloudLink/engineKeys.ts";
import { followedLogins, STAND_IN_MARK, type FollowedEngine } from "../cloudLink/engineLogins.ts";
import { onYourMac, OUTSIDE_ORDER, OUTSIDE_REMOVE, outsideMessage, ruleOf } from "../cloudLink/credentialRule.ts";
import { credentialRule } from "../cloudLink/credentialsOutside.ts";
import { ConnectsHere, type ConnectEngine } from "../cloudLink/connectHere.ts";
import { CloudError } from "../cloudLink/identity.ts";
import { CloudComputer, CloudLinkState } from "../cloudLink/index.ts";
import { makeMacConnections } from "../cloudLink/macConnectionsLive.ts";
import { CLOUD_LACKS_CONNECTIONS, connectionName, connectionsFor, fits, PLAN_KIND, type ModelConnection, type ModelConnectionList, type ServedEngine } from "../cloudLink/modelConnections.ts";
import { resolveClaudeCliPath } from "../provider/Drivers/ClaudeExecutable.ts";
import { SignInsHere, type SignInPrompt, type SpawnLogin } from "../cloudLink/signInHere.ts";
import * as PtyAdapter from "@caveman-app/shared/PtyAdapter";
import { toolsSocket } from "../cloudLink/tools.ts";

const CAVEMAN = ProviderInstanceId.make("caveman");
const CREDITS: CavemanKeyProvider = "caveman";
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
/** Codex on the person's own compact login (`codex login`, CODEX_HOME): an account of its own, so API-key accounts stay as they are. */
const CODEX_CHATGPT = ProviderInstanceId.make("codex-account-chatgpt");
/** kv: each Caveman engine key's last test (KeyHealth), by provider. */
const CAVEMAN_HEALTH = "engine.caveman.health";
/**
 * kv: the highest key slot each provider has had (1 for its first, `openai`; 3 for `openai~3`), so a removed key's
 * slot, the first one too, is never handed out again.
 */
const CAVEMAN_SLOTS = "engine.caveman.slots";
/** A key slot's number: 1 for a provider's first (`openai`), n for `openai~n`. */
const slotNumber = (slot: string) => (slot.includes(KEY_SLOT) ? Number(slot.slice(slot.lastIndexOf(KEY_SLOT) + 1)) || 1 : 1);
/** kv: this installation's id, which Sign in with compact sends OpenAI to tell one agent host from another. Not a secret. */
const CAVEMAN_DEVICE = "engine.caveman.device_id";
/** kv: the Codex account new workspaces run on, and each Codex account's label. */
const CODEX_ACTIVE = "engine.codex.active";
const CODEX_LABELS = "engine.codex.labels";
/** kv: each harness engine's active instance, by engine. */
const HARNESS_ACTIVE = "engine.harness.active";
/** kv: the Claude login new workspaces run on. */
const CLAUDE_ACTIVE = "engine.claude.active";
/** Further compact logins for Codex (engine.account.add another): `codex-account-compact-<id>`, each in an app-managed CODEX_HOME. */
const CODEX_LOGIN_PREFIX = `${CODEX_ACCOUNT_PREFIX}chatgpt-`;

/** How to sign one more Claude login in: the person's own claude, in that account's config folder. */
export const claudeSignInAt = (dir: string) => ({
  command: `CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude`,
  message:
    "Run this in a terminal and log in there (/login) with your other Claude account. Its login stays in that folder, apart from your own; Caveman Code never sees your Claude credentials.",
});

/** How to sign one more compact login in for Codex: the person's own codex, in that account's home. */
export const codexSignInAt = (dir: string) => ({
  command: `CODEX_HOME=${shellQuote(dir)} codex login`,
  message:
    "Run this in a terminal and sign in there with your other ChatGPT account. Its login stays in that folder, apart from your own; Caveman Code never sees your ChatGPT credentials.",
});
/** kv: the tags people gave accounts (EngineAccount.tag), by account id, for every engine. */
export const ACCOUNT_TAGS = "engine.account.tags";
/** A connection's account id: `connection:<Cloud's id>`. The same connection is one account under each engine it serves. */
export const CONNECTION_ACCOUNT_PREFIX = "connection:";
/** engine.account.complete names a connection being made by this, before it is an account. */
export const CONNECTING = "connecting";
/** engine.account.remove gives one up by this and the request id of the engine.account.add that started it. */
export const CONNECTING_OF = `${CONNECTING}:`;
/**
 * Where engine.list's answer changes with no provider changing, it is published here: a connection made, removed,
 * reordered, used up or over, and a plan's sign-in opening or ending (auth.connecting). server.ts provides it and
 * sends every client engine.changed.
 */
export class EngineAccountChanges extends Context.Service<EngineAccountChanges, PubSub.PubSub<void>>()("caveman/session-protocol/EngineAccountChanges") {}
/** The engines a connection can be an account of. */
const CONNECTED_ENGINES = new Set(["claude-agent", "codex", "caveman"]);

export const CONNECT_NOT_SIGNED_IN = "Sign in to Caveman first, in Settings > Account.";
export const CONNECT_ONLY_PLANS = "Only a Claude plan (Claude Agent) or a ChatGPT plan (Codex) connects for every computer.";
/** Where no sign-in can be opened: a Claude plan is added by the token its own CLI prints, a compact plan from the desktop app. */
export const connectNoSignInHere = (engine: string) =>
  engine === "codex" ? "Connect your ChatGPT plan in the Caveman Code desktop app." : "This computer cannot open the sign-in. Run claude setup-token on any computer and paste the token.";
export const CONNECTION_NOT_PICKED = "Plans are used in your order. To use this one first, move it to the top in Settings > Models & keys.";
/** What connecting says where Cloud switched the plan's kind off, in Cloud's own words for it. */
export const connectKindOff = (engine: "claude-agent" | "codex") =>
  engine === "claude-agent"
    ? "Your admin turned Claude plans off. Claude Agent runs on this Mac's login."
    : "Your admin turned ChatGPT plans off. Codex runs on this Mac's login.";
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const CODEX_SIGN_IN = {
  command: "codex login",
  message:
    "Run codex login in a terminal and sign in with ChatGPT there. Caveman Code never sees your ChatGPT credentials: Codex runs on its own login and your plan's limits.",
};

/**
 * A sign-in on a Cloud computer, as engine.account.add answers it: no terminal command (the login runs in the runtime
 * container, cloudLink/signInHere.ts), the page to open and what to do there.
 */
const signInOnComputer = (prompt: SignInPrompt) => ({ command: "", message: prompt.message, ...(prompt.url ? { url: prompt.url } : {}) });

/** A pty in this container for a sign-in's CLI (never the tools channel: the agent must not see it). */
const ptyLogin =
  (adapter: PtyAdapter.PtyAdapter["Service"]): SpawnLogin =>
  async (input) => {
    const pty = await Effect.runPromise(adapter.spawn({ shell: input.command, args: [...input.args], cwd: input.cwd, cols: 1000, rows: 50, env: input.env }));
    return { write: (data) => pty.write(data), kill: () => pty.kill(), onData: (listener) => void pty.onData(listener), onExit: (listener) => void pty.onExit((event) => listener(event.exitCode)) };
  };

export const CLAUDE_SIGN_IN = {
  command: "claude",
  message:
    "Run claude in a terminal and log in there (/login). Caveman Code never sees your Claude credentials: Claude Agent runs your own claude on its own login.",
};

const fail = (reason: string, message: string) => Effect.fail(new ProtocolError({ reason, message }));

/** engine.providers' entry for one registry provider. */
const engineProvider = (p: CavemanProviderInfo): EngineProvider => ({
  id: p.id,
  label: p.label,
  group: p.group === "custom" ? "more" : p.group === "plan" ? "credits" : p.group,
  auth: p.auth,
  ...(p.keyLabel ? { key_label: p.keyLabel } : {}),
  ...(p.keyUrl ? { key_url: p.keyUrl } : {}),
  ...(p.fields ? { fields: p.fields.map((f) => ({ name: f.env, label: f.label, ...(f.placeholder ? { placeholder: f.placeholder } : {}), ...(f.optional ? { optional: true } : {}) })) } : {}),
  ...(p.section ? { section: p.section } : {}),
  ...(p.signIn ? { sign_in: true, sign_in_label: p.signIn.label, ...(p.signIn.plan ? { sign_in_plan: p.signIn.plan } : {}) } : {}),
  ...(p.signInOnly ? { sign_in_only: true } : {}),
  ...(p.plan ? { plan: true } : {}),
  ...(p.baseUrl ? { base_url: p.baseUrl } : {}),
});

/** http only to this computer or a private network; https anywhere. A key never crosses the internet in the clear. */
export const endpointUrlAllowed = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
  } catch {
    return false;
  }
};

/** The stored key a Caveman model runs on: `openai/gpt-6-luna` is the OpenAI key, `caveman/...` Caveman credits; Auto names none. */
export const keyProviderOf = (model: string | undefined): string | undefined =>
  model !== undefined && model.indexOf("/") > 0 ? model.slice(0, model.indexOf("/")) : undefined;

/** What a real turn says about its key: a refusal (401/403) failing, a limit (429, quota) limited, a finished turn ok. */
export const turnKeyHealth = (status: string, error: string | undefined, at: string): KeyHealth | undefined => {
  if (status === "completed") return { state: "ok", checked_at: at };
  if (status !== "failed" || error === undefined) return undefined;
  const kind = classifyProviderError(error);
  return kind === "limit" ? { state: "limited", message: error, checked_at: at } : kind === "auth" ? { state: "failing", message: error, checked_at: at } : undefined;
};

const healthOf = (test: KeyTest, at: string): KeyHealth =>
  test.ok ? { state: "ok", checked_at: at } : { state: test.kind === "limit" ? "limited" : "failing", message: test.message, checked_at: at };
// The last four characters only of a real-length key: on a short one they would be most of it.
const keyLabel = (name: string, key: string) => `${name} API key${key.length >= 20 ? ` ...${key.slice(-4)}` : ""}`;
const signedIn = (provider: ServerProvider | undefined) => provider?.auth.status === "authenticated";
/** Only a probe that found no key signs an account out; "unknown" (not probed yet, or the probe failed) keeps it. */
const usable = (provider: ServerProvider) => provider.auth.status !== "unauthenticated";
/**
 * Antigravity installed and healthy, its Google login never checked: it waits on a sign-in. Antigravity only: other
 * harnesses report "unknown" while signed in (Muse's catalog cannot tell), so "unknown" proves nothing for them.
 */
export const needsFirstSignIn = (provider: ServerProvider) =>
  provider.driver === "antigravity" && provider.installed && !provider.probePending && provider.status !== "error" && provider.auth.status === "unknown";
/** A login's quota windows as the wire has them (EngineDescriptor, EngineAccount); none reported, none. */
export const usageLimitsOf = (provider: ServerProvider | undefined) => {
  const windows = provider?.usageLimits?.windows ?? [];
  return windows.length === 0
    ? undefined
    : windows.map((w) => ({ id: w.id, label: w.label, kind: w.kind, used_percent: w.usedPercent, ...(w.resetsAt ? { resets_at: w.resetsAt } : {}) }));
};
/** A login's own models, Auto aside. */
const modelsOf = (provider: ServerProvider) => provider.models.filter((model) => !isRouterModel(model.slug)).map((model) => model.slug);

export const makeEngineAccounts = Effect.gen(function* () {
  const store = yield* SessionStore;
  const config = yield* ServerConfig.ServerConfig;
  /** A Cloud computer: engine CLIs run in its tools container, so sign-ins are made there. */
  const onCloudComputer = toolsSocket() !== undefined;
  const engineKeys = yield* EngineCloudKeys;
  const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const secretResolver = yield* Effect.serviceOption(SecretResolver);
  const auth = yield* Effect.serviceOption(ProviderAuthService.ProviderAuthService);
  const host = yield* Effect.serviceOption(ProviderHost.ProviderHost);
  const adapters = yield* Effect.serviceOption(ProviderAdapterRegistry.ProviderAdapterRegistryV2);
  // The runtime's egress scrub, read when the accounts are built: a Session Protocol call runs without it in context.
  const egressAtStart = yield* Effect.serviceOption(EgressRoute);
  // ponytail: one account change at a time, runtime-wide; per-engine locks if that ever queues.
  const lock = yield* Semaphore.make(1);
  const testCavemanCredential = yield* CavemanKeyTester;
  // Codex's sign-out and home removal spawn its app-server and touch files.
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The connections the person made once (README: Sign in once). On a Mac: its own read of Cloud's list, the
  // credentials its egress attaches and the connects it runs (cloudLink/macConnections.ts); undefined on a Cloud
  // computer, which reads the list and keeps nothing.
  const cloudLink = yield* CloudLinkState;
  const cloudComputer = yield* CloudComputer;
  const mac = yield* makeMacConnections;

  const known = Option.isSome(providers) ? providers.value.getProviders : Effect.succeed([] as ReadonlyArray<ServerProvider>);
  const refresh = (instanceId: ProviderInstanceId) =>
    Option.isSome(providers) ? providers.value.refreshInstance(instanceId).pipe(Effect.asVoid) : Effect.void;
  /** A refresh past the probe's cache: a login made in a terminal, or a key just kept, shows at once. */
  const refreshFresh = (instanceId: ProviderInstanceId) =>
    Option.isSome(providers) ? providers.value.refreshWorkspaceSnapshot({ instanceId, cwd: process.cwd(), fresh: true }).pipe(Effect.asVoid) : Effect.void;
  const kvJson = <A>(key: string, fallback: A) =>
    store.kvGet(key).pipe(Effect.map((raw) => (raw === undefined ? fallback : (JSON.parse(raw) as A))));
  const instanceConfig = (instanceId: string) =>
    Option.isNone(serverSettings)
      ? Effect.succeed(undefined)
      : serverSettings.value.getSettings.pipe(
          Effect.map((settings) => settings.providerInstances[ProviderInstanceId.make(instanceId)]),
          Effect.orElseSucceed(() => undefined),
        );
  const isChatGptLogin = (instanceId: string) =>
    instanceConfig(instanceId).pipe(Effect.map((entry) => (entry?.config as { chatGptLogin?: unknown } | undefined)?.chatGptLogin === true));

  // ------------------------------------------------------------- caveman

  const cavemanKeys = Option.isNone(host)
    ? Effect.succeed({} as CavemanKeys)
    : readCavemanKeys(CAVEMAN).pipe(
        Effect.provideService(ProviderHost.ProviderHost, host.value),
        Effect.orElseSucceed((): CavemanKeys => ({})),
      );
  // A test of a stored sign-in stores the tokens back if it refreshed them.
  const cavemanSignIns = Option.isNone(host) ? Effect.succeed(undefined) : storedSignIns(CAVEMAN).pipe(Effect.provideService(ProviderHost.ProviderHost, host.value));
  const deviceId = lock.withPermits(1)(
    Effect.gen(function* () {
      const known = yield* store.kvGet(CAVEMAN_DEVICE);
      if (known !== undefined) return known;
      const id = randomUUID();
      yield* store.kvSet(CAVEMAN_DEVICE, id);
      return id;
    }),
  );

  const cavemanLabel = (provider: string, credential: CavemanCredential) => {
    const info = providerInfo(provider);
    if (credential.endpoint) {
      let where = credential.endpoint.baseUrl;
      try {
        where = new URL(credential.endpoint.baseUrl).host;
      } catch {
        // Stored as typed.
      }
      return `${credential.endpoint.name} at ${where}`;
    }
    if (provider === CREDITS) return "Caveman credits";
    if (credential.oauth !== undefined) return `${info?.signIn?.plan ?? info?.label ?? provider} plan`;
    const name = info?.keyLabel?.replace(/ (API )?key$/i, "") ?? info?.label ?? provider;
    return keyLabel(name, credential.key ?? "");
  };

  const cavemanAccounts = Effect.gen(function* () {
    const keys = yield* cavemanKeys;
    const health = yield* kvJson<Record<string, KeyHealth>>(CAVEMAN_HEALTH, {});
    return Object.entries(keys)
      .sort(([a], [b]) => providerOrder(a) - providerOrder(b) || a.localeCompare(b))
      .map(
        // Every key is in use at once: each pays for its own provider's models.
        ([provider, credential]): EngineAccount => ({
          id: `caveman:${provider}`,
          label: cavemanLabel(provider, credential),
          kind: credential.oauth !== undefined ? "login" : "api_key",
          active: true,
          // A further key (`openai~2`) is listed under its provider; its id keeps it apart, and so does its tag (OA2).
          provider: slotProvider(provider),
          ...(slotProvider(provider) === provider
            ? {}
            : { tag: `${defaultAccountTag(cavemanLabel(provider, credential)).slice(0, 2)}${provider.slice(provider.lastIndexOf(KEY_SLOT) + 1)}`.slice(0, 3) }),
          ...(health[provider] ? { health: health[provider] } : {}),
        }),
      );
  });

  const recordHealth = (provider: string, health: KeyHealth | null) =>
    kvJson<Record<string, KeyHealth>>(CAVEMAN_HEALTH, {}).pipe(
      Effect.flatMap((all) => {
        const next = { ...all };
        if (health === null) delete next[provider];
        else next[provider] = health;
        return store.kvSet(CAVEMAN_HEALTH, JSON.stringify(next));
      }),
    );

  // Real Caveman-engine turns keep each key's health current, not only test calls. A turn names its key by the
  // model it started on (Auto: the model the engine starts it on, from the same keys, so a key refused on the first
  // request is still named), or the model its usage names (Auto's pick); no write when a healthy key stays healthy.
  const turnModels = new Map<string, string>();
  const onSessionEvent = (event: SessionEvent) =>
    Effect.gen(function* () {
      if (event.type === "turn.started") {
        const model = event.payload.engine === "caveman" ? event.payload.model : undefined;
        if (model) turnModels.set(event.session_id, keyProviderOf(model) === undefined ? (resolveCavemanModel(model, yield* cavemanKeys) ?? model) : model);
        else turnModels.delete(event.session_id);
        return;
      }
      if (event.type === "usage" && turnModels.has(event.session_id)) return void turnModels.set(event.session_id, event.payload.model);
      if (event.type === "model.routed" && turnModels.has(event.session_id)) {
        const left = keyProviderOf(turnModels.get(event.session_id));
        const next = keyProviderOf(event.payload.model);
        turnModels.set(event.session_id, event.payload.model);
        // Only the engine's rate-limit fallback moves a turn to another provider's key (Auto routes within one): the key it left is limited.
        if (left === undefined || next === undefined || left === next || (yield* cavemanKeys)[left] === undefined) return;
        const health: KeyHealth = { state: "limited", message: `Rate limited in a turn, which continued on ${event.payload.model}.`, checked_at: event.at };
        return yield* lock.withPermits(1)(recordHealth(left, health));
      }
      if (event.type !== "turn.done" || !turnModels.has(event.session_id)) return;
      const provider = keyProviderOf(turnModels.get(event.session_id));
      turnModels.delete(event.session_id);
      const health = turnKeyHealth(event.payload.status, event.payload.error, event.at);
      if (provider === undefined || health === undefined || (yield* cavemanKeys)[provider] === undefined) return;
      const current = (yield* kvJson<Record<string, KeyHealth>>(CAVEMAN_HEALTH, {}))[provider];
      if (health.state === "ok" && (current === undefined || current.state === "ok")) return;
      yield* lock.withPermits(1)(recordHealth(provider, health));
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Key health from a turn not recorded", cause)));
  // Subscribed before the fork, so no turn that ends from here on is missed.
  const turnEvents = yield* PubSub.subscribe(store.events);
  yield* Effect.forkScoped(Effect.forever(PubSub.take(turnEvents).pipe(Effect.flatMap(onSessionEvent))));

  const setKey = (provider: CavemanKeyProvider, key: CavemanCredential | string | null) =>
    Option.isNone(host)
      ? fail("engine_unavailable", "This runtime has no secret store for the Caveman engine's keys.")
      : setCavemanKey(CAVEMAN, provider, key).pipe(
          Effect.provideService(ProviderHost.ProviderHost, host.value),
          Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not store the Caveman engine's key." })),
          Effect.andThen(refresh(CAVEMAN)),
        );

  /** The credential engine.account.add describes, checked against the registry. */
  const cavemanCredential = (p: Params<"engine.account.add">) =>
    Effect.gen(function* () {
      // A key slot named outright (`openai~2`) is its provider: slots are handed out below, never picked.
      const provider = p.provider === undefined ? undefined : slotProvider(p.provider);
      if (provider === undefined) return yield* fail("invalid_params", "provider is required: an engine.providers id");
      const info = providerInfo(provider);
      if (info === undefined || !isAddableProvider(provider)) {
        return yield* fail("invalid_params", provider === CREDITS ? "Caveman credits are turned on from Settings > Account." : `The Caveman engine does not take ${provider} keys.`);
      }
      const key = p.key?.trim();
      if (info.signInOnly) return yield* fail("invalid_params", `${info.label} takes no key: ${info.signIn?.label ?? "sign in"} instead.`);
      if (info.auth === "optional_key") {
        const endpoint = p.endpoint;
        if (endpoint === undefined) return yield* fail("invalid_params", "An endpoint needs its address and model ids.");
        const models = [...new Set(endpoint.models.map((m) => m.trim()).filter((m) => m !== ""))];
        if (!endpointUrlAllowed(endpoint.base_url.trim())) {
          return yield* fail("invalid_params", "Use an https address, or http to this computer or your own network.");
        }
        if (models.length === 0 || models.length > 50) return yield* fail("invalid_params", "List the model ids this endpoint serves (1 to 50).");
        const name = endpoint.name.trim().slice(0, 60) || info.label;
        return { provider, credential: { ...(key ? { key } : {}), endpoint: { name, baseUrl: endpoint.base_url.trim(), models } } as CavemanCredential };
      }
      if (!key) return yield* fail("invalid_params", "Enter an API key.");
      // The same key again replaces itself.
      const slot = yield* slotFor(provider, (credential) => credential.key === key);
      const env: Record<string, string> = {};
      for (const field of info.fields ?? []) {
        const value = p.fields?.[field.env]?.trim();
        if (value) env[field.env] = value;
        else if (!field.optional) return yield* fail("invalid_params", `${field.label} is required for ${info.label}.`);
      }
      return { provider: slot, credential: { key, ...(Object.keys(env).length > 0 ? { env } : {}) } as CavemanCredential };
    });

  /**
   * The slot a new key or sign-in goes in: the one `reuse` picks, else the provider's first if it never had one, else
   * a further one (`openai~2`), a source of its own. Past every slot the provider ever had, its first one too: a chat
   * or the Chief still naming a removed key's slot must find it gone, never send with the key added after it.
   */
  const slotFor = (provider: string, reuse: (credential: CavemanCredential) => boolean) =>
    Effect.gen(function* () {
      const keys = yield* cavemanKeys;
      const slots = Object.keys(keys).filter((slot) => slotProvider(slot) === provider);
      const issued = yield* kvJson<Record<string, number>>(CAVEMAN_SLOTS, {});
      const found = slots.find((s) => reuse(keys[s]!)) ?? (keys[provider] === undefined && issued[provider] === undefined ? provider : undefined);
      if (found !== undefined) return found;
      const n = Math.max(issued[provider] ?? 1, ...slots.map(slotNumber)) + 1;
      yield* store.kvSet(CAVEMAN_SLOTS, JSON.stringify({ ...issued, [provider]: n }));
      return `${provider}${KEY_SLOT}${n}`;
    });

  /** Tests, then keeps, a credential. A key the provider refused is not kept; a limit or an unreachable provider is kept with its health. */
  const keepTested = (provider: string, credential: CavemanCredential) =>
    Effect.gen(function* () {
      const test = yield* testCavemanCredential(provider, credential);
      const label = providerInfo(provider)?.label ?? provider;
      if (!test.ok && test.kind === "auth") return yield* fail("invalid_params", `${label} refused the key: ${test.message}`);
      yield* setKey(provider, credential);
      yield* recordHealth(provider, healthOf(test, new Date().toISOString()));
      return test;
    });

  /** Sign-ins waiting for approval, by provider: a new one replaces the old. */
  const signIns = new Map<string, { cancel: () => void }>();

  // --------------------------------------------------------------- codex

  /**
   * Codex accounts are instances of the codex driver: the default `codex`
   * (listed once it holds an account) and `codex-account-*` ones. The active
   * one is the user's pick while it is usable, else the first usable one.
   */
  const codexState = Effect.gen(function* () {
    const codex = (yield* known).filter((p) => p.driver === "codex");
    const labels = yield* kvJson<Record<string, string>>(CODEX_LABELS, {});
    const preferred = yield* store.kvGet(CODEX_ACTIVE);
    // The disk, not the probe, says whether the default slot holds a key: the probe may not have run yet.
    // A home that cannot be checked counts as held, so an add never signs into it.
    const defaultAuth = path.join(codexManagedHomePath(path, config.stateDir, CODEX), "auth.json");
    // On a Mac that slot may hold a connection's stand-in sign-in (macConnections.ts): the connection is the account
    // then, and the slot is no account of this Mac's own.
    const onConnection = mac !== undefined && (yield* fs.readFileString(defaultAuth).pipe(Effect.map((text) => text.includes(STAND_IN_MARK)), Effect.orElseSucceed(() => false)));
    const defaultHeld = !onConnection && (yield* fs.exists(defaultAuth).pipe(Effect.orElseSucceed(() => true)));
    const listed: Array<ServerProvider & { readonly chatGpt: boolean }> = [];
    for (const p of codex) {
      if (p.instanceId === CODEX && onConnection) continue;
      // Removed from settings and not yet dropped by the registry: gone.
      if (p.instanceId !== CODEX && Option.isSome(serverSettings) && (yield* instanceConfig(p.instanceId)) === undefined) continue;
      const chatGpt = yield* isChatGptLogin(p.instanceId);
      if (p.instanceId !== CODEX || defaultHeld || signedIn(p) || chatGpt) listed.push({ ...p, chatGpt });
    }
    const active =
      listed.find((p) => p.instanceId === preferred && usable(p))?.instanceId ?? listed.find(usable)?.instanceId ?? CODEX;
    const accounts = listed.map(
      (p, i): EngineAccount => ({
        id: p.instanceId,
        label: p.chatGpt ? (p.auth.email ?? (p.instanceId.startsWith(CODEX_LOGIN_PREFIX) && !signedIn(p) ? "Signed out" : "ChatGPT login")) : usable(p) ? (labels[p.instanceId] ?? "OpenAI API key") : "Signed out",
        kind: p.chatGpt ? "login" : "api_key",
        active: p.instanceId === active,
        ...(p.chatGpt && usageLimitsOf(p) ? { usage_limits: usageLimitsOf(p)! } : {}),
 // A compact login with no email yet has nothing to make its lasting tag from: its place keeps it apart (O1, O2) until then.
        ...(p.chatGpt && p.auth.email === undefined ? { tag: `O${i + 1}` } : {}),
      }),
    );
    const ready = new Set(listed.filter(usable).map((p) => p.instanceId as string));
    return { active, accounts, listed, ready, defaultFree: !defaultHeld && !listed.some((p) => p.instanceId === CODEX) };
  });

  /** ProviderAuthService's API-key flow: start, answer the credentials interaction, wait for the verdict. */
  const codexSignIn = (instanceId: ProviderInstanceId, key: string) =>
    Effect.gen(function* () {
      if (Option.isNone(auth)) return yield* fail("engine_unavailable", "This runtime cannot sign Codex in.");
      const service = auth.value;
      const owner = `engine.account.add:${instanceId}`;
      // A new instance appears in the registry shortly after the settings change.
      yield* service
        .start({ instanceId, methodId: CODEX_API_KEY_METHOD_ID }, owner)
        .pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }));
      const phase = (done: (phase: string) => boolean) =>
        service.subscribe({ instanceId }, owner).pipe(
          Stream.filter((state) => done(state.phase)),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
          Effect.timeout("60 seconds"),
        );
      const waiting = yield* phase((p) => p === "waiting" || p === "failed");
      if (waiting?.phase !== "waiting" || !waiting.flowId || waiting.interaction?.type !== "credentials") {
        return yield* fail("engine_unavailable", waiting?.message ?? "Codex sign-in did not start.");
      }
      yield* service.respond(
        { instanceId, flowId: waiting.flowId, interactionId: waiting.interaction.id, response: { type: "credentials", values: { apiKey: key } } },
        owner,
      );
      const verdict = yield* phase((p) => p === "succeeded" || p === "failed" || p === "cancelled");
      if (verdict?.phase !== "succeeded") return yield* fail("invalid_params", verdict?.message ?? "Codex did not accept the API key.");
    }).pipe(
      // Setup errors carry fixed text only (CodexApiKeyAccount): nothing Codex echoes about the key.
      Effect.catchTag("ProviderSetupError", (error) =>
        fail(error.operation === "respond" || error.operation === "verify" ? "invalid_params" : "engine_unavailable", error.detail),
      ),
      Effect.catchTag("TimeoutError", () => fail("engine_unavailable", "Codex sign-in timed out.")),
    );

 /** Signs out in the account's managed home and deletes it (removeCodexAccount). Never a compact login. */
  const codexRemove = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      if (Option.isNone(serverSettings)) return yield* fail("engine_unavailable", "This runtime has no provider settings.");
      const entry = yield* instanceConfig(instanceId);
      const settings = yield* Schema.decodeUnknownEffect(CodexSettings)(entry?.config ?? {}).pipe(
        Effect.mapError(() => new ProtocolError({ reason: "internal", message: "This Codex account's settings do not decode." })),
      );
      if (settings.chatGptLogin && instanceId.startsWith(CODEX_LOGIN_PREFIX)) {
 // One more compact login the app made: its home is the app's, and only that home goes.
        yield* serverSettings.value
          .updateProviderInstance({ operation: "remove", instanceId })
          .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not remove the Codex login." })));
        yield* removeManagedDir(codexManagedHomePath(path, config.stateDir, instanceId));
        return;
      }
      if (settings.chatGptLogin) {
        return yield* fail("invalid_params", "This is your own ChatGPT login. Caveman Code never signs it out; run codex logout yourself.");
      }
      if (instanceId === CODEX) {
        // The default slot stays: stop its sessions and sign out (ProviderAuthService), then delete the home.
        if (Option.isSome(auth)) yield* auth.value.logout({ instanceId }).pipe(Effect.ignore);
      } else if (entry) {
        yield* serverSettings.value
          .updateProviderInstance({ operation: "remove", instanceId })
          .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not remove the Codex account." })));
      }
      yield* removeCodexAccount({
        path: yield* Path.Path,
        stateDir: config.stateDir,
        instanceId,
        config: settings,
        environment: yield* mergeProviderInstanceEnvironment(entry?.environment),
      }).pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not delete the Codex account's home." })));
      const labels = yield* kvJson<Record<string, string>>(CODEX_LABELS, {});
      delete labels[instanceId];
      yield* store.kvSet(CODEX_LABELS, JSON.stringify(labels));
      yield* refresh(instanceId);
    }).pipe(Effect.provide(context));

  const codexAdd = (key: string) =>
    Effect.gen(function* () {
      if (Option.isNone(serverSettings)) return yield* fail("engine_unavailable", "This runtime has no provider settings.");
      const before = yield* codexState;
      const instanceId = before.defaultFree ? CODEX : ProviderInstanceId.make(`${CODEX_ACCOUNT_PREFIX}${randomBytes(4).toString("hex")}`);
      if (!before.defaultFree) {
        // The same codex binary the default instance runs, in a home of its own.
        const binaryPath = ((yield* instanceConfig(CODEX))?.config as { binaryPath?: string } | undefined)?.binaryPath;
        yield* serverSettings.value
          .updateProviderInstance({ operation: "create", instanceId, instance: { driver: "codex" as never, ...(binaryPath ? { config: { binaryPath } } : {}) } })
          .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not add a Codex account." })));
      }
      const signed = yield* Effect.exit(codexSignIn(instanceId, key));
      if (signed._tag === "Failure") {
        // A failed key leaves no account behind (a new instance) and no half-written home. Only a slot
        // this call took is cleaned: a new instance, or the default when its home held no key.
        yield* codexRemove(instanceId).pipe(Effect.ignore);
        return yield* signed;
      }
      const labels = yield* kvJson<Record<string, string>>(CODEX_LABELS, {});
      yield* store.kvSet(CODEX_LABELS, JSON.stringify({ ...labels, [instanceId]: keyLabel("OpenAI", key) }));
      // The first signed-in account becomes active; later ones wait for activate.
      if (before.ready.size === 0) yield* store.kvSet(CODEX_ACTIVE, instanceId);
      yield* refresh(instanceId);
    });

  const codexAccount = (accountId: string) =>
    codexState.pipe(
      Effect.flatMap((state) =>
        state.accounts.some((a) => a.id === accountId) ? Effect.succeed(ProviderInstanceId.make(accountId)) : fail("not_found", `no Codex account ${accountId}`),
      ),
    );

 /** Codex on the person's own compact login: an instance with chatGptLogin on, using their own CODEX_HOME. Never signs them in or out. */
  const codexChatGpt = (on: boolean) =>
    Effect.gen(function* () {
      if (Option.isNone(serverSettings)) return yield* fail("engine_unavailable", "This runtime has no provider settings.");
      const existing = yield* instanceConfig(CODEX_CHATGPT);
      if (on && existing === undefined) {
        const binaryPath = ((yield* instanceConfig(CODEX))?.config as { binaryPath?: string } | undefined)?.binaryPath;
        yield* serverSettings.value
          .updateProviderInstance({
            operation: "create",
            instanceId: CODEX_CHATGPT,
            instance: { driver: "codex" as never, config: { chatGptLogin: true, ...(binaryPath ? { binaryPath } : {}) } },
          })
          .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not turn on your ChatGPT login for Codex." })));
        yield* store.kvSet(CODEX_ACTIVE, CODEX_CHATGPT);
      } else if (!on && existing !== undefined) {
        // The instance only: the person's own Codex login and CODEX_HOME stay exactly as they are.
        yield* serverSettings.value
          .updateProviderInstance({ operation: "remove", instanceId: CODEX_CHATGPT })
          .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not turn off your ChatGPT login for Codex." })));
        // No refresh of a removed instance: a probe answering after the registry dropped it would bring it back as a ghost.
        return;
      }
      yield* refresh(CODEX_CHATGPT);
    });

  /** Waits (5 s at most) until the registry lists a new login from the settings change, so the add's answer shows it. */
  const untilListed = (instanceId: ProviderInstanceId) =>
    refresh(instanceId).pipe(
      Effect.andThen(known),
      Effect.flatMap((list) => (list.some((x) => x.instanceId === instanceId) ? Effect.void : Effect.fail("pending"))),
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
      Effect.ignore,
    );

  /** Deletes a folder the app made for an account, and only one inside the runtime's providers dir. */
  const removeManagedDir = (dir: string) => {
    const root = path.join(config.stateDir, "providers");
    return dir.startsWith(root + path.sep)
      ? removeTree(fs, dir).pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not delete the account's folder." })))
      : Effect.void;
  };

 /** One more compact login for Codex: a further instance on its own app-managed CODEX_HOME; a login still waiting is offered again. */
  const codexLoginAdd = Effect.gen(function* () {
    if (Option.isNone(serverSettings)) return yield* fail("engine_unavailable", "This runtime has no provider settings.");
    const waiting = (yield* known).find((p) => p.instanceId.startsWith(CODEX_LOGIN_PREFIX) && !signedIn(p));
    const instanceId = ProviderInstanceId.make(waiting?.instanceId ?? `${CODEX_LOGIN_PREFIX}${randomBytes(4).toString("hex")}`);
    const home = codexManagedHomePath(path, config.stateDir, instanceId);
    if (waiting === undefined) {
      yield* fs.makeDirectory(home, { recursive: true }).pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not make the login's folder." })));
      const binaryPath = ((yield* instanceConfig(CODEX))?.config as { binaryPath?: string } | undefined)?.binaryPath;
      yield* serverSettings.value
        .updateProviderInstance({
          operation: "create",
          instanceId,
          instance: { driver: "codex" as never, config: { chatGptLogin: true, homePath: home, ...(binaryPath ? { binaryPath } : {}) } },
        })
        .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not add a ChatGPT login for Codex." })));
    }
    yield* untilListed(instanceId);
    return codexSignInAt(home);
  });

  // --------------------------------------------------------------- claude

  /** The config folder of one more Claude login: the app makes it; the person signs in there with their own claude. */
  const claudeAccountDir = (instanceId: string) => path.join(config.stateDir, "providers", "claudeAgent", instanceId, "config");

  /**
   * Claude Agent's accounts are instances of its driver: the person's own login (the default `claudeAgent`,
   * listed while it is signed in) and `claudeAgent-account-*` ones, each with a CLAUDE_CONFIG_DIR of its own.
   * The active one is the person's pick while it is signed in, else the first signed-in one.
   */
  const claudeState = Effect.gen(function* () {
    const claude = (yield* known).filter((p) => p.driver === "claudeAgent");
    const preferred = yield* store.kvGet(CLAUDE_ACTIVE);
    const listed: Array<ServerProvider> = [];
    for (const p of claude) {
      if (p.instanceId === CLAUDE) {
        if (signedIn(p)) listed.push(p);
        continue;
      }
      // Removed from settings and not yet dropped by the registry: gone.
      if (!p.instanceId.startsWith(CLAUDE_ACCOUNT_PREFIX) || (Option.isSome(serverSettings) && (yield* instanceConfig(p.instanceId)) === undefined)) continue;
      listed.push(p);
    }
    const ready = listed.filter(signedIn);
    const active = ready.find((p) => p.instanceId === preferred)?.instanceId ?? ready[0]?.instanceId ?? CLAUDE;
    const accounts = listed.map(
      (p, i): EngineAccount => ({
        id: accountIdOf(p.instanceId, ""),
        label: signedIn(p) ? (p.auth.email ?? p.auth.label ?? "Claude login") : "Signed out",
        kind: "login",
        active: p.instanceId === active,
        ...(usageLimitsOf(p) ? { usage_limits: usageLimitsOf(p)! } : {}),
        // Signed-out logins have no email to make a tag from: their place keeps them apart (C2, C3) until one is set.
        ...(signedIn(p) ? {} : { tag: `C${i + 1}`, health: { state: "failing" as const, message: "Not signed in yet.", checked_at: p.checkedAt } }),
      }),
    );
    return { active: active as string, accounts, listed, ready: new Set(ready.map((p) => p.instanceId as string)) };
  });

  const claudeAccount = (accountId: string) =>
    claudeState.pipe(
      Effect.flatMap((state) =>
        state.accounts.some((a) => a.id === accountId) ? Effect.succeed(ProviderInstanceId.make(instanceOfAccount(accountId, "").instanceId)) : fail("not_found", `no Claude Agent account ${accountId}`),
      ),
    );

  /** One more Claude login: a further instance with a config folder of its own; a login still waiting is offered again. */
  const claudeAdd = Effect.gen(function* () {
    if (Option.isNone(serverSettings)) return yield* fail("engine_unavailable", "This runtime has no provider settings.");
    const waiting = (yield* claudeState).listed.find((p) => p.instanceId !== CLAUDE && !signedIn(p));
    const instanceId = ProviderInstanceId.make(waiting?.instanceId ?? `${CLAUDE_ACCOUNT_PREFIX}${randomBytes(4).toString("hex")}`);
    const dir = claudeAccountDir(instanceId);
    if (waiting === undefined) {
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not make the login's folder." })));
      // The same claude the person's own login runs, in a config folder of its own.
      const binaryPath = ((yield* instanceConfig(CLAUDE))?.config as { binaryPath?: string } | undefined)?.binaryPath;
      yield* serverSettings.value
        .updateProviderInstance({ operation: "create", instanceId, instance: { driver: "claudeAgent" as never, config: { homePath: dir, ...(binaryPath ? { binaryPath } : {}) } } })
        .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not add a Claude login." })));
    }
    // A finished login shows at once.
    yield* untilListed(instanceId);
    return claudeSignInAt(dir);
  });

  /** Removes one more Claude login and its folder; the person's own login and every other account stay. */
  const claudeRemove = (accountId: string) =>
    Effect.gen(function* () {
      if (accountId === CLAUDE_DEFAULT_ACCOUNT) return yield* notHere("claude-agent");
      const instanceId = yield* claudeAccount(accountId);
      if (Option.isNone(serverSettings)) return yield* fail("engine_unavailable", "This runtime has no provider settings.");
      yield* serverSettings.value
        .updateProviderInstance({ operation: "remove", instanceId })
        .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not remove the Claude login." })));
      yield* removeManagedDir(path.dirname(claudeAccountDir(instanceId)));
      // The registry drops it from the settings change.
      yield* known.pipe(
        Effect.flatMap((list) => (list.some((x) => x.instanceId === instanceId) ? Effect.fail("pending") : Effect.void)),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
        Effect.ignore,
      );
    });

  // ------------------------------------------------------------ harnesses

  /**
   * A harness engine's accounts are its enabled instances: the default `<engine>` and
   * `<engine>-account-*`. The active one runs new workspaces; signed-out ones say so.
   */
  const harnessState = (engine: string) =>
    Effect.gen(function* () {
      const listed = (yield* known).filter((p) => harnessEngineOf(p.instanceId) === engine && p.enabled);
      const preferred = (yield* kvJson<Record<string, string>>(HARNESS_ACTIVE, {}))[engine];
      const active =
        listed.find((p) => p.instanceId === preferred && signedIn(p))?.instanceId ??
        listed.find(signedIn)?.instanceId ??
        listed.find((p) => p.instanceId === preferred)?.instanceId ??
        listed[0]?.instanceId ??
        engine;
      const label = HARNESSES.get(engine)?.client.label ?? engine;
      const accounts = listed.map(
        (p): EngineAccount => ({
          id: p.instanceId,
          label: p.auth.email ?? p.auth.label ?? p.displayName ?? label,
          kind: p.auth.type === "apiKey" || p.auth.type === "api_key" ? "api_key" : "login",
          active: p.instanceId === active,
          ...(p.auth.status === "unauthenticated"
            ? { health: { state: "failing" as const, message: p.message ?? "Signed out.", checked_at: p.checkedAt } }
            : needsFirstSignIn(p)
              ? { health: { state: "failing" as const, message: "Not signed in yet.", checked_at: p.checkedAt } }
              : {}),
        }),
      );
      return { active, accounts, listed };
    });

  const harnessAccount = (engine: string, accountId: string) =>
    harnessState(engine).pipe(
      Effect.flatMap((state) =>
        state.listed.some((p) => p.instanceId === accountId)
          ? Effect.succeed(ProviderInstanceId.make(accountId))
          : fail("not_found", `no ${HARNESSES.get(engine)?.client.label ?? engine} account ${accountId}`),
      ),
    );

  /**
   * Browser sign-ins in flight, by instance (Cursor, Antigravity). A flow outlives the call that
   * started it, so a slow start (Antigravity's first download) still delivers its page to the next
   * engine.account.signin, and a pasted redirect can finish it (engine.account.complete).
   */
  interface Flow {
    url?: string;
    flowId?: string;
    phase?: string;
    message?: string;
    readonly settled: Deferred.Deferred<void>;
  }
  const flows = new Map<string, Flow>();
  const flowOwner = (instanceId: string) => `engine.account.signin:${instanceId}`;
  const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

  /**
   * The page a browser sign-in opens, starting the flow unless one is open. Never under the
   * accounts lock: a start may wait on a download or a slow provider. Answers the page, or nothing
   * when the account signed in without one (an API key), or a message while it is still starting.
   */
  const harnessBrowserSignIn = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      if (Option.isNone(auth)) return yield* fail("engine_unavailable", "This runtime cannot run a sign-in.");
      const service = auth.value;
      let flow = flows.get(instanceId);
      if (flow === undefined || (flow.phase !== undefined && TERMINAL.has(flow.phase))) {
        const fresh: Flow = { settled: yield* Deferred.make<void>() };
        flow = fresh;
        flows.set(instanceId, fresh);
        const owner = flowOwner(instanceId);
        yield* Effect.gen(function* () {
          // A new or just-enabled instance appears in the registry shortly after the settings change.
          yield* service.start({ instanceId }, owner).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }));
          yield* service.subscribe({ instanceId }, owner).pipe(
            Stream.tap((state) =>
              Effect.gen(function* () {
                fresh.phase = state.phase;
                if (state.flowId) fresh.flowId = state.flowId;
                if (state.message) fresh.message = state.message;
                if (state.authorizationUrl) fresh.url = state.authorizationUrl;
                if (state.authorizationUrl || TERMINAL.has(state.phase)) yield* Deferred.succeed(fresh.settled, undefined);
              }),
            ),
            Stream.takeUntil((state) => TERMINAL.has(state.phase)),
            Stream.runDrain,
          );
        }).pipe(
          // ponytail: a flow nobody finishes is dropped after ten minutes.
          Effect.timeout("10 minutes"),
          Effect.catch((error) =>
            Effect.sync(() => {
              fresh.phase = "failed";
              fresh.message ??= (error as { readonly detail?: string }).detail ?? "The sign-in did not start.";
            }),
          ),
          Effect.ensuring(Deferred.succeed(fresh.settled, undefined)),
          Effect.forkDetach,
        );
      }
      yield* Deferred.await(flow.settled).pipe(Effect.timeout("20 seconds"), Effect.ignore);
      if (flow.url && flow.phase !== "succeeded") return { url: flow.url } as { url?: string; message?: string };
      if (flow.phase === "succeeded") return {};
      if (flow.phase === "failed" || flow.phase === "cancelled") return yield* fail("engine_unavailable", flow.message ?? "The sign-in did not finish.");
      return { message: "The sign-in is still starting (a first run can download its runtime). Choose Sign in again in a moment for its page." };
    });

  /** Finishes a browser sign-in from the address its page redirected to (a remote or Cloud computer). */
  const harnessComplete = (instanceId: ProviderInstanceId, callbackUrl: string) =>
    Effect.gen(function* () {
      const flow = flows.get(instanceId);
      if (Option.isNone(auth) || flow?.flowId === undefined) return yield* fail("invalid_state", "No sign-in is open for this account: choose Sign in first.");
      if (!URL.canParse(callbackUrl)) return yield* fail("invalid_params", "Paste the whole address the browser ended on.");
      yield* auth.value.complete({ instanceId, flowId: flow.flowId, callbackUrl }, flowOwner(instanceId)).pipe(
        Effect.catchTag("ProviderSetupError", (error) => fail("invalid_params", error.detail)),
      );
      yield* Deferred.await(flow.settled).pipe(Effect.timeout("20 seconds"), Effect.ignore);
      yield* refresh(instanceId).pipe(Effect.ignore);
    });

  /** A CLI login's steps for an account: with its own home, the command runs under that home. */
  const harnessCliSignIn = (engine: string, instanceId: string) =>
    Effect.gen(function* () {
      const harness = HARNESSES.get(engine)!;
      const steps = harness.cliSignIn!;
      const homeValue = harness.cliHome === undefined ? undefined : (yield* instanceConfig(instanceId))?.environment?.find((v) => v.name === harness.cliHome)?.value;
      const home = typeof homeValue === "string" ? homeValue : undefined;
      // ponytail: POSIX `NAME=value cmd`; a Windows shell would need `set` first.
      return home === undefined ? steps : { ...steps, command: `${harness.cliHome}=${shellQuote(home)} ${steps.command}` };
    });

  /**
   * Antigravity's ACP server is a pinned download from Google (antigravityRelease.ts). Adding an
   * account is the person's request for it: when it is missing, the download starts and the
   * account signs in once it lands (engine.account.signin). Undefined when it is already there.
   */
  const antigravityInstall = (binaryPath: string | undefined) =>
    Effect.gen(function* () {
      const installation = yield* Effect.serviceOption(AntigravityInstallation.AntigravityInstallation);
      if (Option.isNone(installation)) return undefined;
      const found = yield* installation.value.resolve(binaryPath).pipe(Effect.option);
      if (Option.isSome(found) || binaryPath) return undefined;
      const started = yield* installation.value.start.pipe(Effect.option);
      return {
        command: "",
        message: Option.isSome(started)
          ? "Downloading Google's Antigravity runtime (about 110 MB). Sign in from this account once it finishes."
          : "Antigravity's runtime is not on this computer and could not be downloaded. Set its binary path, or try again.",
      };
    });

  /**
   * Adds a harness account's instance (under the accounts lock): turns on the default instance the
   * first time, else a new `<engine>-account-*` one, with the form's settings, decoded by the
 * harness's own settings schema first, and an optional key (native CURSOR_API_KEY, stored
   * with the instance's other secrets). A second keyless account gets a CLI home of its own where
   * the harness has one, and is refused where it has none: it would share the first one's login.
   */
  /** engine.account.add's key_ref, checked: a provider configured here, in syntax it reads. Never read here. */
  const secretKeyRef = (ref: { readonly provider: string; readonly reference: string }) =>
    Effect.gen(function* () {
      if (Option.isNone(serverSettings)) return yield* fail("engine_unavailable", "This runtime has no provider settings.");
      const reference = { provider: ref.provider.trim(), reference: ref.reference.trim() } as SecretReference;
      if (!isSecretReference(reference)) return yield* fail("invalid_params", "That is not a secret reference.");
      const settings = yield* serverSettings.value.getSettings.pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not read settings." })));
      if (!Object.hasOwn(settings.secretProviders, reference.provider)) return yield* fail("not_found", `No secret provider named ${reference.provider}.`);
      const accepted = Option.isSome(secretResolver) ? yield* secretResolver.value.accepts(reference) : undefined;
      if (accepted !== true) return yield* fail("invalid_params", "Use a 1Password reference like op://vault/item/field.");
      return reference;
    });

  const harnessCreate = (p: Params<"engine.account.add">) =>
    Effect.gen(function* () {
      const harness = HARNESSES.get(p.engine)!;
      const label = harness.client.label;
      if (Option.isNone(serverSettings)) return yield* fail("engine_unavailable", "This runtime has no provider settings.");
      const key = p.key?.trim() || undefined;
      if ((key !== undefined || p.key_ref !== undefined) && harness.keyEnv === undefined) return yield* fail("invalid_params", `${label} takes no key: sign in with its own CLI.`);
      if (key !== undefined && p.key_ref !== undefined) return yield* fail("invalid_params", "Paste a key or point at a secret provider, not both.");
      // A key in a secret manager: the reference is stored, the key read when the account starts (SecretResolver).
      const keyRef = p.key_ref === undefined ? undefined : yield* secretKeyRef(p.key_ref);
      const form = harnessProvider(p.engine)?.fields ?? [];
      const allowed = new Set(form.map((f) => f.name));
      if (Object.keys(p.fields ?? {}).some((k) => !allowed.has(k))) return yield* fail("invalid_params", `${label} has no such setting`);
      const fields = Object.fromEntries(
        Object.entries(p.fields ?? {}).flatMap(([k, v]) => (v.trim() !== "" ? [[k, v.trim()] as const] : [])),
      );
      // Never echo a value: a key pasted into the wrong field must not reach a log or a message.
      const decoded = Schema.decodeUnknownExit(harness.client.settingsSchema as unknown as Schema.Codec<unknown>)({ ...fields, enabled: true });
      if (decoded._tag === "Failure") {
        const named = form.filter((f) => f.name in fields).map((f) => f.label);
        return yield* fail("invalid_params", `${label} did not accept ${named.length > 0 ? named.join(", ") : "those settings"}.`);
      }
      const state = yield* harnessState(p.engine);
      // The settings too: an add still waiting on the registry has already taken the default instance.
      const second = state.listed.some((x) => x.instanceId === p.engine) || (yield* instanceConfig(p.engine))?.enabled === true;
      const instanceId = ProviderInstanceId.make(second ? `${p.engine}${HARNESS_ACCOUNT_INFIX}${randomBytes(4).toString("hex")}` : p.engine);
      let home: string | undefined;
      if (second && key === undefined && keyRef === undefined && harness.cliSignIn !== undefined) {
        if (harness.cliHome === undefined) {
          return yield* fail(
            "invalid_params",
            harness.keyEnv !== undefined
              ? `${label} keeps one login on this computer, so a second account needs its own API key.`
              : `${label} keeps one login on this computer, so it has one account here.`,
          );
        }
        home = path.join(config.stateDir, "harness-homes", instanceId);
        yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 }).pipe(
          Effect.mapError(() => new ProtocolError({ reason: "internal", message: `Could not make a home for the ${label} account.` })),
        );
      }
      const environment = [
        ...(key ? [{ name: harness.keyEnv!, value: key, sensitive: true }] : []),
        ...(keyRef ? [{ name: harness.keyEnv!, value: keyRef, sensitive: true }] : []),
        ...(home ? [{ name: harness.cliHome!, value: home, sensitive: false }] : []),
      ];
      yield* serverSettings.value
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: { driver: p.engine as never, enabled: true, config: { ...fields, enabled: true }, ...(environment.length > 0 ? { environment } : {}) },
        })
        .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: `Could not add a ${label} account.` })));
      if (state.accounts.length === 0) yield* store.kvSet(HARNESS_ACTIVE, JSON.stringify({ ...(yield* kvJson<Record<string, string>>(HARNESS_ACTIVE, {})), [p.engine]: instanceId }));
      return { instanceId, keyed: key !== undefined || keyRef !== undefined, binaryPath: fields.binaryPath };
    });

  /** Waits for the registry to pick a just-enabled instance up, then probes it (a probe can take long: outside the lock). */
  const harnessProbe = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      yield* known.pipe(
        Effect.flatMap((list) => (list.some((x) => x.instanceId === instanceId && x.enabled) ? Effect.void : Effect.fail("pending"))),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
        Effect.ignore,
      );
      yield* refresh(instanceId).pipe(Effect.timeout("30 seconds"), Effect.ignore);
    });

  /**
   * After the instance exists, outside the lock (a probe or a sign-in start can take long): wait for
   * the registry to pick it up, probe it, then sign it in the harness's own way.
   */
  const harnessFinish = (engine: string, created: { readonly instanceId: ProviderInstanceId; readonly keyed: boolean; readonly binaryPath: string | undefined }) =>
    Effect.gen(function* () {
      const harness = HARNESSES.get(engine)!;
      const { instanceId } = created;
      yield* harnessProbe(instanceId);
      if (created.keyed) return {};
      if (harness.cliSignIn !== undefined) return { sign_in: yield* harnessCliSignIn(engine, instanceId) };
      const installing = engine === "antigravity" ? yield* antigravityInstall(created.binaryPath) : undefined;
      if (installing !== undefined) return { sign_in: installing };
      const started = yield* harnessBrowserSignIn(instanceId);
      if (started.url) return { sign_in: { command: "", message: `Sign in to ${harness.client.label} on the page this opens. The account appears once you finish.`, url: started.url } };
      return started.message ? { sign_in: { command: "", message: started.message } } : {};
    });

  /** Signs a browser sign-in out (it holds the credential) and removes the instance; a CLI login stays the harness's own. */
  const harnessRemove = (engine: string, instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      if (Option.isNone(serverSettings)) return yield* fail("engine_unavailable", "This runtime has no provider settings.");
      if (Option.isSome(auth) && HARNESSES.get(engine)?.cliSignIn === undefined) {
        yield* auth.value.logout({ instanceId }).pipe(Effect.ignore);
      }
      yield* serverSettings.value
        .updateProviderInstance({ operation: "remove", instanceId })
        .pipe(Effect.mapError(() => new ProtocolError({ reason: "internal", message: "Could not remove the account." })));
      // The registry drops it (or, for the default instance, turns it back off) from the settings change.
      yield* known.pipe(
        Effect.flatMap((list) => (list.some((x) => x.instanceId === instanceId && x.enabled) ? Effect.fail("pending") : Effect.void)),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
        Effect.ignore,
      );
    });

  /**
   * engine.scan: every harness nobody connected is turned on, probed, and kept where it is on this computer
   * and already signed in through its own CLI; the rest go back exactly as they were. Claude Agent is always
   * on and probed afresh, so a login made in a terminal a moment ago counts; Codex as scanCodex says. Nothing
   * here reads a credential; each engine's own probe says whether it is signed in.
   */
  const scanHarness = (engine: string) =>
    Effect.gen(function* () {
      const harness = HARNESSES.get(engine)!;
      const state = yield* harnessState(engine);
      if (state.accounts.length > 0) return state.listed.some(signedIn) ? ("ready" as const) : ("signed_out" as const);
      const before = yield* instanceConfig(engine);
      // An add still waiting on the registry: leave it to that add.
      if (before?.enabled === true || Option.isNone(serverSettings)) return "not_found" as const;
 // A harness whose probe always finds it (native SDK ships with the app) is on this computer only where its own folder is.
      if (harness.homeMarker !== undefined && !(yield* fs.exists(path.join(os.homedir(), harness.homeMarker)).pipe(Effect.orElseSucceed(() => false)))) {
        return "not_found" as const;
      }
      const created = yield* lock.withPermits(1)(harnessCreate({ request_id: "engine.scan", engine } as Params<"engine.account.add">));
      yield* harnessProbe(created.instanceId);
      const probed = (yield* known).find((p) => p.instanceId === created.instanceId);
      if (probed?.installed && signedIn(probed)) return "ready" as const;
      const instanceId = created.instanceId;
      yield* lock.withPermits(1)(
        serverSettings.value
          .updateProviderInstance(before === undefined ? { operation: "remove", instanceId } : { operation: "upsert", instanceId, instance: before })
          .pipe(Effect.ignore),
      );
      return probed?.installed && !probed.probePending && (probed.auth.status === "unauthenticated" || needsFirstSignIn(probed)) ? ("signed_out" as const) : ("not_found" as const);
    });

  /**
   * Codex's default account runs in a home of the app's own (an API key): the person's own `codex login` is
 * its compact login account, turned on here, kept when that login is signed in and turned back off when
   * not. Whichever account the person made active stays active.
   */
  const scanCodex = Effect.gen(function* () {
    if (!onCloudComputer && (yield* instanceConfig(CODEX_CHATGPT)) === undefined) {
      const preferred = yield* store.kvGet(CODEX_ACTIVE);
      yield* lock.withPermits(1)(codexChatGpt(true)).pipe(Effect.ignore);
      yield* untilListed(CODEX_CHATGPT);
      yield* refreshFresh(CODEX_CHATGPT).pipe(Effect.timeout("30 seconds"), Effect.ignore);
      if (!signedIn((yield* known).find((p) => p.instanceId === CODEX_CHATGPT))) yield* lock.withPermits(1)(codexChatGpt(false)).pipe(Effect.ignore);
      if (preferred !== undefined) yield* store.kvSet(CODEX_ACTIVE, preferred);
    } else {
      yield* codexState.pipe(Effect.flatMap((s) => refreshFresh(ProviderInstanceId.make(s.active))), Effect.timeout("30 seconds"), Effect.ignore);
    }
    const state = yield* codexState;
    if (state.listed.some((p) => p.installed && signedIn(p))) return "ready" as const;
    return (yield* known).some((p) => p.driver === "codex" && p.installed) ? ("signed_out" as const) : ("not_found" as const);
  });

  const scan = Effect.gen(function* () {
    const [, codex, harnesses] = yield* Effect.all(
      [
        refreshFresh(CLAUDE).pipe(Effect.timeout("30 seconds"), Effect.ignore),
        scanCodex,
        Effect.forEach([...HARNESSES.keys()], (engine) => scanHarness(engine).pipe(Effect.map((found) => ({ engine, found }))), { concurrency: "unbounded" }),
      ],
      { concurrency: "unbounded" },
    );
    const claude = (yield* known).find((x) => x.instanceId === CLAUDE);
    return {
      engines: [
        { engine: "claude-agent", found: claude === undefined || !claude.installed ? "not_found" : signedIn(claude) ? "ready" : "signed_out" },
        { engine: "codex", found: codex },
        ...harnesses,
      ] as Array<{ engine: Params<"engine.account.add">["engine"]; found: "ready" | "signed_out" | "not_found" }>,
    };
  });

  // ------------------------------------------------------------- tags

  const tagLock = yield* Semaphore.make(1);
  /**
   * One engine's accounts, each with its tag: the one the person set, else the first one made for
   * it, kept so it does not move when the label does, and unique within the engine (JO, JO2).
   */
  const withTags = (accounts: ReadonlyArray<EngineAccount>) =>
    tagLock.withPermits(1)(
      Effect.gen(function* () {
        const tags = yield* kvJson<Record<string, string>>(ACCOUNT_TAGS, {});
        const fresh = assignAccountTags(accounts, Object.fromEntries(accounts.flatMap((a) => (tags[a.id] ?? a.tag ? [[a.id, (tags[a.id] ?? a.tag)!]] : []))));
        if (Object.keys(fresh).length > 0) yield* store.kvSet(ACCOUNT_TAGS, JSON.stringify({ ...tags, ...fresh }));
        return accounts.map((a) => ({ ...a, tag: tags[a.id] ?? a.tag ?? fresh[a.id]! }));
      }),
    );

  // ------------------------------------------------------------- connections (sign in once)

  /**
   * The person's connections as this computer reads them: a Mac signed in to Caveman its own way, a Cloud computer
   * whose person's credentials stay outside it the read-only list. Undefined: this computer knows of none (not signed
   * in to Caveman, a Cloud from before connections), and everything is as it was before them.
   */
  const connectionList = Effect.promise(async (): Promise<ModelConnectionList | undefined> => {
    if (mac !== undefined) return mac.signedIn ? mac.list().catch(() => undefined) : undefined;
    if (cloudComputer === undefined || ruleOf(cloudLink).known() !== true) return undefined;
    return (await connectionsFor(cloudComputer, cloudLink).catch(() => undefined))?.list().catch(() => undefined);
  });

  /** A connection as an account of `engine`: where it works from here, and what Cloud last said of it. */
  const connectionAccount = (c: ModelConnection, engine: ServedEngine, input: { readonly runsHere: boolean; readonly first: string | undefined; readonly off: boolean }): EngineAccount => ({
    id: `${CONNECTION_ACCOUNT_PREFIX}${c.id}`,
    label: c.label || connectionName(c),
    kind: c.kind === "api_key" || c.kind === "gateway" ? "api_key" : "login",
    active: c.id === input.first,
    where: input.runsHere && fits(c, engine) ? "everywhere" : "cloud",
    connection: {
      kind: c.kind,
      status: c.status,
      ...(c.status === "used_up" && typeof c.used_up_until === "string" ? { used_up_until: c.used_up_until } : {}),
      ...(typeof c.expires_at === "string" ? { expires_at: c.expires_at } : {}),
      ...(input.off ? { off: true as const } : {}),
    },
  });

  /**
   * `engine`'s connections in the person's order, as accounts, and the one its next chat here runs on (`first`).
   * A Cloud computer runs Claude Agent and Codex on them; a Mac does once their plan is connected, and keeps its
   * Caveman engine on its own keys. Undefined: this computer knows of no connections.
   */
  const connectionsOf = (engine: string) =>
    Effect.gen(function* () {
      const list = yield* connectionList;
      if (list === undefined || !CONNECTED_ENGINES.has(engine) || (mac === undefined && engine === "caveman")) return undefined;
      const served = engine as ServedEngine;
      const plan = served === "caveman" ? undefined : served;
      const on = (c: ModelConnection) => list.kinds[c.kind]?.on !== false;
      const runsHere = mac === undefined || (plan !== undefined && (yield* Effect.promise(() => mac.runsOn(plan))));
      const first =
        mac === undefined
          ? list.connections.find((c) => c.serves.includes(served) && fits(c, served) && c.status === "ready" && on(c))
          : plan === undefined
            ? undefined
            : yield* Effect.promise(() => mac.ready(plan));
      const accounts = list.connections.filter((c) => c.serves.includes(served)).map((c) => connectionAccount(c, served, { runsHere, first: first?.id, off: !on(c) }));
      return { list, first, accounts };
    });

  /** What this computer can do about `engine`'s plan (EngineDescriptor.auth.everywhere). */
  const everywhereOf = (engine: string) =>
    Effect.gen(function* () {
      if (engine !== "claude-agent" && engine !== "codex") return undefined;
      const list = yield* connectionList;
      if (list === undefined) return undefined;
      if (mac === undefined) return "manage" as const;
      return list.kinds[PLAN_KIND[engine]]?.on === false ? ("off" as const) : ("available" as const);
    });

  /** Cloud's refusal of a connection change, in Cloud's own words (they never repeat a credential). */
  const cloudRefusal = (error: unknown) =>
    new ProtocolError(
      error instanceof CloudError
        ? {
            reason: error.code === "not_signed_in" ? "invalid_state" : error.status === 403 ? "unsupported" : error.status === 400 ? "invalid_params" : error.status === 404 ? "not_found" : error.status === 409 ? "invalid_state" : "internal",
            message: error.code === "not_signed_in" ? CONNECT_NOT_SIGNED_IN : error.message,
          }
        : { reason: "internal", message: "Caveman could not be reached. Try again in a moment." },
    );
  const inCloud = <A>(change: () => Promise<A>) => Effect.tryPromise({ try: change, catch: cloudRefusal });

  /** The connection an account id names, when `engine` lists it. */
  const connectionOfAccount = (engine: string, accountId: string) =>
    Effect.gen(function* () {
      const id = accountId.slice(CONNECTION_ACCOUNT_PREFIX.length);
      const listed = (yield* connectionsOf(engine))?.accounts.some((a) => a.id === accountId) === true;
      if (!listed) return yield* fail("not_found", `no ${engine} account ${accountId}`);
      return id;
    });

  // ------------------------------------------------------------- methods

  /**
   * Accounts for engine.list, in the order they are tried: the person's connections first, then this computer's own
   * logins and keys. Undefined keeps the snapshot's own account (ACP).
   */
  const accountsOf = (engine: string): Effect.Effect<ReadonlyArray<EngineAccount> | undefined> => {
    const own: Effect.Effect<ReadonlyArray<EngineAccount> | undefined> =
      engine === "caveman"
        ? cavemanAccounts
        : engine === "codex"
          ? codexState.pipe(Effect.map((s) => s.accounts))
          : engine === "claude-agent"
            ? claudeState.pipe(Effect.map((s) => s.accounts))
          : HARNESSES.has(engine)
            ? harnessState(engine).pipe(Effect.map((s) => s.accounts))
            : Effect.succeed(undefined);
    return own.pipe(
      Effect.flatMap((accounts) =>
        accounts === undefined
          ? Effect.succeed(undefined)
          : Effect.gen(function* () {
              // This computer knows of no connections: its accounts are as they were before them.
              if ((yield* connectionList) === undefined) return yield* withTags(accounts);
              const connected = yield* connectionsOf(engine);
              // A Cloud computer keeps no login of its own under the rule: what its probe reads there is a stand-in.
              if (mac === undefined) return yield* withTags(connected === undefined ? accounts : connected.accounts);
              // While a connection runs the engine here, none of this Mac's own accounts is the one new chats run on.
              const here = accounts.map((a): EngineAccount => ({ ...a, where: "this_mac", active: connected?.first === undefined && a.active }));
              return yield* withTags([...(connected?.accounts ?? []), ...here]);
            }),
      ),
    );
  };

  /** What a method answers: the engine's accounts after the change. */
  const after = (engine: string): Effect.Effect<ReadonlyArray<EngineAccount>> =>
    accountsOf(engine).pipe(
      Effect.flatMap((accounts) =>
        accounts !== undefined
          ? Effect.succeed(accounts)
          : known.pipe(
              Effect.map((list) => {
                const p = list.find((x) => x.instanceId === (engine === "claude-agent" ? CLAUDE : engine.replace(/^acp:/, "")));
                const label = p?.auth.email ?? p?.auth.label;
                return signedIn(p) && label ? [{ id: `${p!.instanceId}:default`, label, kind: "login" as const, active: true }] : ([] as ReadonlyArray<EngineAccount>);
              }),
              Effect.flatMap(withTags),
            ),
      ),
    );

  /**
   * The person's Claude plans (Pro, Max, Team), one per Claude login as its `claude` reports it: the Chief may
   * run on each through Claude Code (the Agent SDK), never with its token. An API-key or cloud-lane login is no
   * plan; a login that does not say which it is counts as none.
   */
  const claudePlans = Effect.gen(function* () {
    const state = yield* claudeState;
    const tags = yield* withTags(state.accounts);
    return state.listed.flatMap((p) => {
      const type = p.auth.type?.toLowerCase();
      if (!signedIn(p) || type === undefined || type === "apikey" || type === "bedrock") return [];
      const account = tags.find((a) => a.id === accountIdOf(p.instanceId, ""))!;
      return [{ account_id: account.id, instance_id: p.instanceId as string, label: p.auth.label ?? "Claude plan", tag: account.tag, active: account.active, models: modelsOf(p) }];
    });
  }).pipe(Effect.orElseSucceed(() => []));

  /**
   * Every signed-in Claude Agent and Codex login a Chief may run on, each engine's active login first: the Chief's
 * prompt and tools alone there (claudeChief.ts, codexChief.ts). `plan`: a subscription (a Claude plan, a compact
   * login), else an API key or a cloud lane. A connection made from another computer is no login to pick here.
   */
  const chiefLogins = Effect.gen(function* () {
    const claude = yield* claudeState;
    const codex = yield* codexState;
    const tags = yield* withTags([...claude.accounts, ...codex.accounts]);
    const login = (engine: "claude-agent" | "codex", id: string, plan: boolean, p: ServerProvider) => {
      const account = tags.find((a) => a.id === id);
      return account === undefined ? [] : [{ engine, account_id: id, plan, active: account.active, label: account.label, ...(account.tag ? { tag: account.tag } : {}), models: modelsOf(p) }];
    };
    const claudeType = (p: ServerProvider) => p.auth.type?.toLowerCase();
    const activeFirst = <T extends { readonly active: boolean }>(list: ReadonlyArray<T>) => [...list.filter((l) => l.active), ...list.filter((l) => !l.active)];
    return [
      ...activeFirst(
        claude.listed
          .filter(signedIn)
          .flatMap((p) => login("claude-agent", accountIdOf(p.instanceId, ""), claudeType(p) !== undefined && claudeType(p) !== "apikey" && claudeType(p) !== "bedrock", p)),
      ),
      ...activeFirst(codex.listed.filter(signedIn).flatMap((p) => login("codex", p.instanceId as string, p.chatGpt, p))),
    ];
  }).pipe(Effect.orElseSucceed(() => []));

  const notHere = (engine: string) =>
    fail("invalid_params", engine === "claude-agent" ? "Claude Agent runs on your own claude login: sign in or out with claude itself." : `Sign in to ${engine} with its own CLI.`);

  // ------------------------------------------------------------ sign-ins that follow the person (engineLogins.ts)

  if (onCloudComputer) {
    // A sign-in arrived or went (taken here, signed out everywhere, or it needs a new sign-in): re-check the engine,
    // so its sign-in card and the chats' state follow at once.
    followedLogins.onChange((engine) => {
      Effect.runFork(
        engine === "claude-agent" ? refreshFresh(CLAUDE) : codexState.pipe(Effect.flatMap((state) => refreshFresh(ProviderInstanceId.make(state.active as string))), Effect.ignore),
      );
    });
  }
  /**
   * Sign-ins on this Cloud computer, made in the runtime container where the agent can neither read nor write them
   * (cloudLink/signInHere.ts, security ruling S-R3). The person starting one from the card, which says it follows
   * them, is their consent.
   */
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  /**
   * Where the person's credentials stay outside the computer (cloudLink/credentialRule.ts) no sign-in is made and no
   * key is taken inside it, for any engine: what was signed in here would sit on a disk its agent can read. The
   * refusal says where to connect instead; while Cloud cannot say whether the rule applies, nothing is taken either.
   */
  const rule = yield* credentialRule;
  const refusalInside = (what: string) =>
    rule.outside().then(
      (outside) => (outside ? outsideMessage(what) : undefined),
      () => RULE_UNHEARD,
    );
  /** Passes where a sign-in or key may be changed on this computer; refuses with `refusal` where they stay outside it (insideComputer.ts). */
  const insideComputer = yield* makeInsideComputer;
  const signInsHere =
    onCloudComputer && Option.isSome(pty)
      ? new SignInsHere({ stateDir: config.stateDir, logins: followedLogins, spawn: ptyLogin(pty.value), refusal: () => refusalInside("Signing in") })
      : undefined;
  /**
   * Connecting a plan once from this Mac (cloudLink/connectHere.ts): the official CLI's own sign-in, run by the
   * runtime in a pty, in a private folder under its state. Undefined on a Cloud computer and on a runtime with no pty.
   */
  const connects =
    mac !== undefined && Option.isSome(pty)
      ? new ConnectsHere({
          stateDir: config.stateDir,
          spawn: ptyLogin(pty.value),
          binaries: () =>
            Effect.runPromise(
              Effect.gen(function* () {
                const configured = (instanceId: string) => instanceConfig(instanceId).pipe(Effect.map((entry) => (entry?.config as { binaryPath?: string } | undefined)?.binaryPath?.trim() || undefined));
                return { claude: yield* resolveClaudeCliPath((yield* configured(CLAUDE)) ?? "claude", process.env), codex: (yield* configured(CODEX)) ?? "codex" };
              }),
            ),
          keep: { claude: (token) => mac.connectClaude(token), chatgpt: (credential) => mac.connectChatGpt(credential) },
        })
      : undefined;
  /**
   * Codex's default home follows the person's connections (macConnections.ts settleCodexHome): Codex is probed again
   * when a stand-in sign-in arrives there or goes, so it reads as signed in, with its models, before the first chat.
   */
  const settleCodex =
    mac === undefined
      ? Effect.void
      : Effect.promise(() => mac.settleCodexHome().catch(() => false)).pipe(Effect.flatMap((changed) => (changed ? refreshFresh(CODEX).pipe(Effect.ignore) : Effect.void)));
  if (mac !== undefined) {
    const run = Effect.runForkWith(yield* Effect.context<never>());
    const changes = yield* Effect.serviceOption(EngineAccountChanges);
    const changed = Option.isSome(changes) ? PubSub.publish(changes.value, undefined).pipe(Effect.asVoid) : Effect.void;
    // A connection made, removed, reordered, used up or over: engine.list answers differently from here on.
    mac.onChange(() => void run(settleCodex.pipe(Effect.andThen(refresh(CLAUDE)), Effect.andThen(refresh(CODEX)), Effect.ignore, Effect.andThen(changed))));
    // So does it when a connect starts or ends (kept, failed, timed out, given up, its CLI gone): auth.connecting.
    connects?.onChange(() => void run(changed));
    yield* settleCodex.pipe(Effect.forkScoped);
  }
  /** Connects `engine`'s plan once for every computer (engine.account.add `everywhere`). */
  const connectEverywhere = (p: Params<"engine.account.add">) =>
    Effect.gen(function* () {
      const engine: ConnectEngine | undefined = p.engine === "claude-agent" ? "claude-agent" : p.engine === "codex" && p.chatgpt === true ? "codex" : undefined;
      if (engine === undefined || p.key !== undefined || p.key_ref !== undefined) return yield* fail("invalid_params", CONNECT_ONLY_PLANS);
      if (mac === undefined) return yield* fail("unsupported", connectNoSignInHere(engine));
      if (!mac.signedIn) return yield* fail("invalid_state", CONNECT_NOT_SIGNED_IN);
      // A Cloud from before connections cannot keep one: said now, before anyone approves in the browser.
      if (!(yield* Effect.promise(() => mac.canConnect().catch(() => true)))) return yield* fail("unsupported", CLOUD_LACKS_CONNECTIONS);
      if ((yield* everywhereOf(engine)) === "off") return yield* fail("unsupported", connectKindOff(engine));
      // The line `claude setup-token` printed on another computer: checked by Cloud, kept there and sealed here.
      if (p.token !== undefined) {
        if (engine !== "claude-agent") return yield* fail("invalid_params", "A ChatGPT plan takes no token: Codex signs in with codex login.");
        yield* inCloud(() => mac.connectClaude(p.token!.trim()));
        return { accounts: yield* after(p.engine) };
      }
      if (connects === undefined) return yield* fail("unsupported", connectNoSignInHere(engine));
      // The sign-in is this call's while none is open. While one is, this call is answered its page and changes nothing
      // about it, unless it names it as its own (`connecting`), which starts it over (with a code, say).
      const prompt = yield* Effect.tryPromise({
        try: () => connects.start(engine, { owner: p.request_id, deviceCode: engine === "codex" && p.device_code === true, ...(p.connecting === undefined ? {} : { restarts: p.connecting }) }),
        catch: (error) => new ProtocolError({ reason: "engine_unavailable", message: error instanceof Error ? error.message : String(error) }),
      });
      return { accounts: yield* after(p.engine), sign_in: { command: "", message: prompt.message, ...(prompt.url ? { url: prompt.url } : {}), ...(prompt.code ? { code: prompt.code } : {}) } };
    });
  const followSignIn = (engine: FollowedEngine) =>
    signInsHere === undefined || !followedLogins.connected
      ? fail("unavailable", "Cloud lost its link to Caveman. Try again in a moment.")
      : Effect.tryPromise({
          try: () => signInsHere.start(engine),
          catch: (error) => new ProtocolError({ reason: "unavailable", message: error instanceof Error ? error.message : String(error) }),
        });
  /** Sign out everywhere: Cloud drops the sign-in for every one of the person's computers. */
  const signOutEverywhere = (engine: FollowedEngine) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => followedLogins.signOut(engine),
        catch: (error) => new ProtocolError({ reason: "unavailable", message: `Caveman could not sign you out everywhere: ${error instanceof Error ? error.message : String(error)}` }),
      });
    });

  const accounts = {
    /** Caveman credits on the Caveman engine: the credits key Cloud minted for the signed-in person (Settings -> Account), or null to stop. */
    setCredits: (key: string | null, gateway?: string) => lock.withPermits(1)(setKey(CREDITS, key === null || gateway === undefined ? key : { key: key.trim(), gateway })),
    hasCredits: cavemanKeys.pipe(Effect.map((keys) => keys[CREDITS] !== undefined)),
    /**
     * A credential the Caveman engine can use is stored (an API key, a plan sign-in, Caveman credits, an endpoint):
     * what makes it ready in engine.list, read without building its model catalog, so Settings can ask on every read.
     */
    hasCredential: cavemanKeys.pipe(Effect.map((keys) => Object.keys(keys).length > 0)),
    /** Anything the Caveman engine can run on (connected.ts): the Chief captures only while this is false. */
    hasConnected: cavemanKeys.pipe(
      Effect.flatMap((keys) => cavemanModels(keys).pipe(Effect.map((models) => connectedSources(keys, models).length > 0))),
    ),
    /**
     * Everything connected (connected.ts): the Caveman engine's sources, then each Claude plan login and each
 * signed-in compact login for Codex, an account of its own.
     */
    connected: Effect.gen(function* () {
      const keys = yield* cavemanKeys;
      const plans = yield* claudePlans;
      const codex = (yield* codexState).listed.filter((p) => p.chatGpt && signedIn(p));
      return connectedSources(keys, yield* cavemanModels(keys), [
        ...plans.map((plan) => ({ engine: "claude-agent", account: plan.account_id, models: plan.models })),
        ...codex.map((p) => ({ engine: "codex", account: p.instanceId as string, models: modelsOf(p) })),
      ]);
    }),
    /** The Caveman engine models connected now (connected.ts): what the Chief's pick may name. */
    connectedModels: cavemanKeys.pipe(
      Effect.flatMap((keys) => cavemanModels(keys).pipe(Effect.map((models) => connectedSources(keys, models).flatMap((source) => source.models)))),
    ),
    /**
     * The person's Claude plan (Pro, Max, Team) as their own `claude` login reports it: the Chief may run on it
     * through Claude Code (the Agent SDK), never with its token. An API-key or cloud-lane login is no plan;
     * a login that does not say which it is counts as none.
     */
    claudePlan: claudePlans.pipe(Effect.map((plans) => plans.find((plan) => plan.active) ?? plans[0])),
    /** Every Claude login on a plan, each its own account. */
    claudePlans,
    chiefLogins,
    accountsOf,
    /** What this computer can do about an engine's plan (EngineDescriptor.auth.everywhere). */
    everywhereOf,
    /** The connection an engine's next chat here runs on, if one does (engine.list's state for it). */
    connectionOf: (engine: string) => connectionsOf(engine).pipe(Effect.map((connected) => connected?.first)),
    /**
     * The connect of `engine`'s plan that waits for the person's approval on this computer now, and the
     * engine.account.add that started it (EngineDescriptor.auth.connecting). Never its page or its code.
     */
    connectingOf: (engine: string) => {
      const open = connects !== undefined && (engine === "claude-agent" || engine === "codex") ? connects.pending(engine) : undefined;
      return open === undefined ? undefined : { request_id: open.owner, since: new Date(open.since).toISOString() };
    },
    withTags,
    /** Further Codex and harness accounts are folded into their engine, never listed as engines of their own. */
    folded: (instanceId: string) =>
      instanceId.startsWith(CODEX_ACCOUNT_PREFIX) ||
      instanceId.startsWith(CLAUDE_ACCOUNT_PREFIX) ||
      (harnessEngineOf(instanceId) !== undefined && instanceId.includes(HARNESS_ACCOUNT_INFIX)),
    /** The instance an EngineAccount id of `engine` names, when the engine lists it now and it is signed in (TurnOptions.account_id). */
    instanceOfAccount: (engine: string, accountId: string) =>
      Effect.gen(function* () {
        if (accountId.startsWith(CONNECTION_ACCOUNT_PREFIX)) return yield* fail("invalid_params", CONNECTION_NOT_PICKED);
        if (engine === "caveman" || !(yield* after(engine)).some((a) => a.id === accountId)) return yield* fail("invalid_params", `${engine} has no account ${accountId}`);
        const instanceId = instanceOfAccount(accountId, "").instanceId;
        const ready = engine === "claude-agent" ? (yield* claudeState).ready : engine === "codex" ? (yield* codexState).ready : undefined;
        if (ready !== undefined && !ready.has(instanceId)) return yield* fail("invalid_state", "That login is signed out: sign in there first, in Settings > Models & keys.");
        return instanceId;
      }),
    /**
     * The instance an engine's turn runs on. With `current` (the workspace's instance), the workspace keeps
     * the account it started on while that account exists; else, and for new workspaces and handoffs, the
     * engine's active account.
     */
    instanceOf: (engine: string, fallback: string, current?: string) =>
      Effect.gen(function* () {
        // A removed account's instance has no adapter: a workspace still on it would fail every turn.
        const exists = current === undefined || Option.isNone(adapters) || (yield* adapters.value.list()).includes(ProviderInstanceId.make(current));
        if (current !== undefined && engineIdForInstance(current) === engine && exists) return current;
        // With its plan connected and to be had, the engine's chats here run on the person's connections, which
        // stand behind its default account (macConnections.ts).
        if (mac !== undefined && (engine === "codex" || engine === "claude-agent") && (yield* Effect.promise(() => mac.ready(engine))) !== undefined) return engine === "codex" ? CODEX : CLAUDE;
        return engine === "codex"
          ? ((yield* codexState).active as string)
          : engine === "claude-agent"
            ? (yield* claudeState).active
            : HARNESSES.has(engine)
              ? (yield* harnessState(engine)).active
              : fallback;
      }),
    scan,
    add: (p: Params<"engine.account.add">) =>
      p.everywhere === true
        ? connectEverywhere(p)
        : p.key_ref !== undefined && !HARNESSES.has(p.engine)
        ? fail("invalid_params", "Only engines that read a key from their environment (Cursor, Grok, ...) take a key from a secret provider.")
        : HARNESSES.has(p.engine)
        ? Effect.gen(function* () {
            const created = yield* lock.withPermits(1)(harnessCreate(p));
            const finished = yield* harnessFinish(p.engine, created);
            return { accounts: yield* after(p.engine), ...finished };
          })
        : lock.withPermits(1)(
        Effect.gen(function* () {
          if (p.engine === "claude-agent") {
            // On a Cloud computer an Anthropic API key goes to Caveman Cloud's vault for this person's computers
            // (engineKeys.ts); This Mac's Claude Agent runs on the person's own claude login only.
            if (p.key !== undefined && !onCloudComputer) return yield* fail("invalid_params", "Claude Agent never takes a key.");
            if (p.key !== undefined) {
              const key = p.key.trim();
              if (!key) return yield* fail("invalid_params", "Enter an Anthropic API key.");
              yield* engineKeys.set("claude-agent", key).pipe(Effect.mapError((error) => new ProtocolError({ reason: "unavailable", message: error.message })));
              yield* refreshFresh(CLAUDE);
              return { accounts: yield* after(p.engine) };
            }
            if (p.another === true) {
              const sign_in = yield* claudeAdd;
              return { accounts: yield* after(p.engine), sign_in };
            }
            // On a Cloud computer the sign-in runs in the runtime container and follows the person (signInHere.ts):
            // the page to open, never a terminal in the tools container.
            if (onCloudComputer) {
              const prompt = yield* followSignIn("claude-agent");
              return { accounts: yield* after(p.engine), sign_in: signInOnComputer(prompt) };
            }
            // Sign-in happens in the user's own claude; re-check so a finished login shows at once.
            yield* refreshFresh(CLAUDE);
            return { accounts: yield* after(p.engine), sign_in: CLAUDE_SIGN_IN };
          }
          if (p.engine === "caveman") {
            const { provider, credential } = yield* cavemanCredential(p);
            const test = yield* keepTested(provider, credential);
            return { accounts: yield* after(p.engine), test };
          }
          if (p.engine === "codex" && p.chatgpt === true && p.another === true) {
            if (p.key !== undefined) return yield* fail("invalid_params", "A ChatGPT login takes no key: Codex signs in with codex login.");
            const sign_in = yield* codexLoginAdd;
            return { accounts: yield* after(p.engine), sign_in };
          }
          if (p.engine === "codex" && p.chatgpt === true && onCloudComputer) {
 // On a Cloud computer the compact sign-in runs in the runtime container and follows the person
            // (signInHere.ts); codex in the tools container then holds stand-ins in its home. No setting changes.
            if (p.key !== undefined) return yield* fail("invalid_params", "A ChatGPT login takes no key: Codex signs in with codex login.");
            const prompt = yield* followSignIn("codex");
            return { accounts: yield* after(p.engine), sign_in: signInOnComputer(prompt) };
          }
          if (p.engine === "codex" && p.chatgpt === true) {
            if (p.key !== undefined) return yield* fail("invalid_params", "Your ChatGPT login takes no key: Codex uses your own codex login.");
            yield* codexChatGpt(true);
            const accounts = yield* after(p.engine);
            const signedIn = accounts.some((a) => a.id === CODEX_CHATGPT && a.label !== "ChatGPT login");
            return { accounts, ...(signedIn ? {} : { sign_in: CODEX_SIGN_IN }) };
          }
          // An add never removes: a blank key would read as "delete" to the key store.
          const key = p.key?.trim();
          if (!key) return yield* fail("invalid_params", "Enter an API key.");
          if (p.engine === "codex" && onCloudComputer) {
            // On a Cloud computer an OpenAI API key goes to Caveman Cloud's vault for this person's computers, as
            // Claude Agent's does: codex there holds a stand-in, and the egress scrub swaps the key in toward OpenAI.
            if (p.provider !== undefined && p.provider !== "openai") return yield* fail("invalid_params", "Codex runs on an OpenAI API key");
            yield* engineKeys.set("codex", key).pipe(Effect.mapError((error) => new ProtocolError({ reason: "unavailable", message: error.message })));
            yield* refreshFresh((yield* codexState).active);
          } else if (p.engine === "codex") {
            if (p.provider !== undefined && p.provider !== "openai") return yield* fail("invalid_params", "Codex runs on an OpenAI API key");
            yield* codexAdd(key);
          } else return yield* notHere(p.engine);
          return { accounts: yield* after(p.engine) };
        }),
      ),
    remove: (p: Params<"engine.account.remove">) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (p.account_id === CONNECTING || p.account_id.startsWith(CONNECTING_OF)) {
            // Only the engine.account.add that started a connect gives it up, named by its request id. A bare
            // "connecting" and another call's id end nothing: a second window's Cancel leaves the first's sign-in open.
            if (connects !== undefined && p.account_id !== CONNECTING && (p.engine === "claude-agent" || p.engine === "codex")) {
              const engine: ConnectEngine = p.engine;
              yield* Effect.promise(() => connects.cancel(engine, p.account_id.slice(CONNECTING_OF.length)));
            }
            return { accounts: yield* after(p.engine) };
          }
          if (p.account_id.startsWith(CONNECTION_ACCOUNT_PREFIX)) {
            if (mac === undefined) return yield* fail("unsupported", OUTSIDE_REMOVE);
            const id = yield* connectionOfAccount(p.engine, p.account_id);
            yield* inCloud(() => mac.remove(id));
          } else if (p.engine === "caveman") {
            const provider = p.account_id.replace(/^caveman:/, "") as CavemanKeyProvider;
            if (!(yield* cavemanKeys)[provider]) return yield* fail("not_found", `no Caveman engine account ${p.account_id}`);
            // Its slot is retired (keys added before slots were counted included): the next key gets a new one.
            const issued = yield* kvJson<Record<string, number>>(CAVEMAN_SLOTS, {});
            const base = slotProvider(provider);
            yield* store.kvSet(CAVEMAN_SLOTS, JSON.stringify({ ...issued, [base]: Math.max(issued[base] ?? 0, slotNumber(provider)) }));
            yield* setKey(provider, null);
            yield* recordHealth(provider, null);
          } else if (HARNESSES.has(p.engine)) {
            yield* harnessRemove(p.engine, yield* harnessAccount(p.engine, p.account_id));
          } else if (p.engine === "claude-agent" && p.account_id === CLAUDE_DEFAULT_ACCOUNT && onCloudComputer && followedLogins.hasLogin("claude-agent")) {
            // A sign-in that follows the person: sign out everywhere.
            yield* signOutEverywhere("claude-agent");
            yield* refreshFresh(CLAUDE);
          } else if (p.engine === "claude-agent") {
            yield* claudeRemove(p.account_id);
          } else if (
            p.engine === "codex" &&
            onCloudComputer &&
            followedLogins.hasLogin("codex") &&
            (p.account_id === CODEX_CHATGPT || p.account_id === ((yield* codexState).active as string))
          ) {
            yield* signOutEverywhere("codex");
            yield* refreshFresh((yield* codexState).active);
          } else if (p.engine === "codex" && p.account_id === CODEX_CHATGPT) {
            yield* codexChatGpt(false);
          } else if (p.engine === "codex") {
            yield* codexRemove(yield* codexAccount(p.account_id));
          } else return yield* notHere(p.engine);
          // A removed account's tag goes with it: an account added later in its slot starts from its own label.
          const { [p.account_id]: _gone, ...tags } = yield* kvJson<Record<string, string>>(ACCOUNT_TAGS, {});
          if (_gone !== undefined) yield* store.kvSet(ACCOUNT_TAGS, JSON.stringify(tags));
          return { accounts: yield* after(p.engine) };
        }),
      ),
    activate: (p: Params<"engine.account.activate">) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (p.account_id.startsWith(CONNECTION_ACCOUNT_PREFIX)) {
            if (mac === undefined) return yield* fail("unsupported", OUTSIDE_ORDER);
            const id = yield* connectionOfAccount(p.engine, p.account_id);
            yield* inCloud(() => mac.useFirst(id));
            return { accounts: yield* after(p.engine) };
          }
          if (p.engine === "caveman") return yield* fail("invalid_params", "Every Caveman engine key is in use: each pays for its own provider's models.");
          if (HARNESSES.has(p.engine)) {
            const instanceId = yield* harnessAccount(p.engine, p.account_id);
            yield* store.kvSet(HARNESS_ACTIVE, JSON.stringify({ ...(yield* kvJson<Record<string, string>>(HARNESS_ACTIVE, {})), [p.engine]: instanceId }));
            return { accounts: yield* after(p.engine) };
          }
          if (p.engine === "claude-agent") {
            const instanceId = yield* claudeAccount(p.account_id);
            if (!(yield* claudeState).ready.has(instanceId)) return yield* fail("invalid_state", "That Claude login is signed out; sign in with claude there first.");
            yield* store.kvSet(CLAUDE_ACTIVE, instanceId);
            return { accounts: yield* after(p.engine) };
          }
          if (p.engine !== "codex") return yield* notHere(p.engine);
          const instanceId = yield* codexAccount(p.account_id);
          if (!(yield* codexState).ready.has(instanceId)) {
            return yield* fail("invalid_state", "That Codex account is signed out; add its key again.");
          }
          yield* store.kvSet(CODEX_ACTIVE, instanceId);
          return { accounts: yield* after(p.engine) };
        }),
      ),
    test: (p: Params<"engine.account.test">) =>
      Effect.gen(function* () {
        if (p.engine !== "caveman") return yield* fail("invalid_params", "Only the Caveman engine's keys are tested here.");
        const provider = p.account_id.replace(/^caveman:/, "");
        const credential = (yield* cavemanKeys)[provider];
        if (credential === undefined) return yield* fail("not_found", `no Caveman engine account ${p.account_id}`);
        const test = yield* testCavemanCredential(provider, credential, yield* cavemanSignIns);
        yield* lock.withPermits(1)(recordHealth(provider, healthOf(test, new Date().toISOString())));
        return { accounts: yield* after(p.engine), test };
      }),
    /** A tag for any engine's account; the account must be one engine.list shows. */
    tag: (p: Params<"engine.account.tag">) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* after(p.engine)).some((a) => a.id === p.account_id)) return yield* fail("not_found", `no ${p.engine} account ${p.account_id}`);
          yield* tagLock.withPermits(1)(
            Effect.gen(function* () {
              const { [p.account_id]: _old, ...rest } = yield* kvJson<Record<string, string>>(ACCOUNT_TAGS, {});
              yield* store.kvSet(ACCOUNT_TAGS, JSON.stringify(p.tag === null ? rest : { ...rest, [p.account_id]: p.tag }));
            }),
          );
          return { accounts: yield* after(p.engine) };
        }),
      ),
    signin: (p: Params<"engine.account.signin">) =>
      Effect.gen(function* () {
        // Claude Agent or Codex on a Cloud computer: the sign-in that follows the person, in the runtime container.
        if ((p.engine === "claude-agent" || p.engine === "codex") && onCloudComputer) {
          const prompt = yield* followSignIn(p.engine);
          return { message: prompt.message, ...(prompt.url ? { url: prompt.url } : {}), ...(prompt.code ? { code: prompt.code } : {}) };
        }
        // A harness account signing in again (`provider` names the account): its page, or its CLI's steps.
        if (HARNESSES.has(p.engine)) {
          const instanceId = yield* harnessAccount(p.engine, p.provider);
          return HARNESSES.get(p.engine)!.cliSignIn === undefined ? yield* harnessBrowserSignIn(instanceId) : yield* harnessCliSignIn(p.engine, instanceId);
        }
        // `provider` is a provider (a new sign-in) or one of its slots (that account signing in again).
        const provider = slotProvider(p.provider);
        if (p.engine !== "caveman" || providerInfo(provider)?.signIn === undefined) {
          return yield* fail("invalid_params", `${p.provider} has no sign-in here; paste an API key.`);
        }
        signIns.get(p.provider)?.cancel();
        const device = yield* deviceId;
        const started = yield* Effect.tryPromise({
          try: () => startProviderSignIn(provider, device),
          catch: (cause) => new ProtocolError({ reason: "engine_unavailable", message: cause instanceof Error ? cause.message : String(cause) }),
        });
        signIns.set(p.provider, started);
        // Approved in the browser: tested, then kept like a pasted key. A slot that holds a sign-in is that account
        // signing in again, and keeps its slot; anything else is a source of its own beside the provider's keys.
        const keep = (credential: CavemanCredential) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const slot = (yield* cavemanKeys)[p.provider]?.oauth !== undefined ? p.provider : yield* slotFor(provider, () => false);
              yield* keepTested(slot, credential);
            }),
          );
        yield* Effect.promise(() => started.credential.catch(() => undefined)).pipe(
          Effect.flatMap((credential) => (credential === undefined ? Effect.void : keep(credential))),
          Effect.catchCause((cause) => Effect.logWarning("A provider sign-in did not finish", { provider: p.provider, cause })),
          Effect.ensuring(Effect.sync(() => signIns.get(p.provider) === started && signIns.delete(p.provider))),
          Effect.forkDetach,
        );
        return { url: started.url, ...(started.code ? { code: started.code } : {}) };
      }),
    complete: (p: Params<"engine.account.complete">) =>
      Effect.gen(function* () {
        // A connection being made from this Mac: waits for the person's approval on the provider's page.
        if (p.account_id === CONNECTING) {
          if (connects === undefined || (p.engine !== "claude-agent" && p.engine !== "codex")) return yield* fail("unsupported", connectNoSignInHere(p.engine));
          const engine: ConnectEngine = p.engine;
          const result = yield* Effect.tryPromise({
            try: () => connects.wait(engine, p.callback_url),
            catch: (error) => new ProtocolError({ reason: "invalid_params", message: error instanceof Error ? error.message : String(error) }),
          });
          if (result.state === "failed") return yield* fail("invalid_state", result.why);
          // A pasted code claude did not take: the sign-in stays open, on claude's new page when it started over.
          if (result.state === "refused")
            return { accounts: yield* after(p.engine), waiting: true as const, refused: result.why, ...(result.url ? { url: result.url } : {}) };
          return { accounts: yield* after(p.engine), ...(result.state === "pending" ? { waiting: true as const } : {}) };
        }
        // The sign-in in the runtime container: Claude's page code typed into its CLI (callback_url), or Codex's
        // "Check again". Taken and uploaded when the CLI finishes.
        if ((p.engine === "claude-agent" || p.engine === "codex") && onCloudComputer) {
          if (signInsHere === undefined) return yield* fail("unavailable", `Connect it ${onYourMac("Settings > Models & keys")}.`);
          const engine: FollowedEngine = p.engine;
          const result = yield* Effect.tryPromise({
            try: () => signInsHere.submit(engine, p.callback_url),
            catch: (error) => new ProtocolError({ reason: "invalid_params", message: error instanceof Error ? error.message : String(error) }),
          });
          if (result === "failed") return yield* fail("unavailable", "The sign-in did not finish. Start it again from the card.");
          if (result === "pending") return yield* fail("unavailable", engine === "codex" ? "Finish the sign-in on the page, then check again." : "The sign-in is still finishing. Check again in a moment.");
          yield* engine === "claude-agent" ? refreshFresh(CLAUDE) : codexState.pipe(Effect.flatMap((state) => refreshFresh(ProviderInstanceId.make(state.active as string))));
          return { accounts: yield* after(p.engine) };
        }
        if (!HARNESSES.has(p.engine) || HARNESSES.get(p.engine)!.cliSignIn !== undefined) return yield* fail("invalid_params", `${p.engine} has no browser sign-in to finish.`);
        yield* harnessComplete(yield* harnessAccount(p.engine, p.account_id), p.callback_url);
        return { accounts: yield* after(p.engine) };
      }),
    /** Whether an engine's account (its instance) runs through the app's caveman-proxy. */
    proxies: (engine: string, instanceId: string) =>
      Effect.gen(function* () {
        const provider = (yield* known).find((x) => x.instanceId === instanceId);
        const entry = yield* instanceConfig(instanceId);
        const atCall = yield* Effect.serviceOption(EgressRoute);
        const egress = Option.isSome(atCall) ? atCall : egressAtStart;
        const scrubUp = Option.isSome(egress) && egress.value.route(ANTHROPIC_VIA_PROXY) !== undefined;
        return harnessProxies(engine, { version: provider?.version, config: entry?.config as Record<string, unknown> | undefined, scrubUp });
      }),
    providers: (p: Params<"engine.providers">) =>
      p.engine === "caveman"
        ? Effect.succeed({ providers: [...FEATURED_PROVIDERS, ...MORE_PROVIDERS, ...LOCAL_PRESETS, CREDITS_INFO].map(engineProvider) })
        : Effect.succeed({ providers: [harnessProvider(p.engine)].filter((x) => x !== undefined) }),
  };
  return {
    ...accounts,
    add: (p: Params<"engine.account.add">) => insideComputer(outsideMessage(p.key === undefined && p.key_ref === undefined ? "Signing in" : "Adding a key")).pipe(Effect.andThen(accounts.add(p))),
    signin: (p: Params<"engine.account.signin">) => insideComputer(outsideMessage("Signing in")).pipe(Effect.andThen(accounts.signin(p))),
    complete: (p: Params<"engine.account.complete">) => insideComputer(outsideMessage("Signing in")).pipe(Effect.andThen(accounts.complete(p))),
    remove: (p: Params<"engine.account.remove">) => insideComputer(OUTSIDE_REMOVE).pipe(Effect.andThen(accounts.remove(p))),
  };
});
