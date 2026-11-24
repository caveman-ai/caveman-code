// Claude Agent's and Codex's API keys on a Cloud computer (cloud parity R1, environments lane G; fix round R-f;
// platform 2026-10-21 for Codex). A person who runs Claude Agent on an Anthropic API key, or Codex on an OpenAI
// one, types it once for their Cloud computers. Caveman Cloud keeps it sealed in the vault under the reserved
// `caveman:servers` key, as a personal MCP server's keys are. Each computer reads it into the runtime's memory
// only (every read is in the access log) and joins it to the scrubber. The claude or codex it starts, which runs
// as the agent in the tools container, gets a stand-in as ANTHROPIC_API_KEY or OPENAI_API_KEY; the runtime's
// egress scrub, which every request of theirs goes through (secrets/EgressScrub.ts), swaps the stand-in for the
// key on requests to that engine's own API only. So code running as the agent can use the key through the CLI
// but never read it. A claude.ai or compact sign-in made on a computer follows the person instead (engineLogins.ts,
// 2026-10-21), and the CLI holds stand-ins for it the same way.
//
// Which of the two pays is the person's choice, kept by Cloud (its lane, agent-continuity.md §7.4): the last one they set up,
// a sign-in or a key. A launch runs on that lane only. When it can't, the launch fails with EngineLoginUnavailable
// and says what to do; it never falls to the key, a sign-in made on the computer, or another account.
//
// Where the person's credentials stay outside the computer (credentialRule.ts, 2026-11-09) no key is read into this
// process at all: a launch gets the stand-in of the first of the person's connections that serves the engine
// (modelConnections.ts), and Cloud's data plane attaches the real credential.
//
// On a Mac none of the lanes above exist. There, once its person connected an engine's plan (macConnections.ts), a
// chat's launch on this Mac's own login gets a connection's stand-in the same way and the Mac's own egress attaches
// the credential; without one the launch is untouched and the CLI runs on its own login, as before.
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";

import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { proxySession } from "../router/cavemanRouter.ts";
import { CONNECT_WHERE } from "./credentialRule.ts";
import { CODEX_LOGIN_REFRESH, followedLogins, NOT_STARTED, withFollowedLogin, type FollowedLogins, type LaunchLane } from "./engineLogins.ts";
import { CloudLinkState } from "./index.ts";
import { macConnectionsOf } from "./macConnections.ts";

/** The engines a Cloud computer runs on a vault key, and the variable each reads it from. */
export const ENGINE_KEY_VARIABLE = { "claude-agent": "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY" } as const;
export type KeyedEngine = keyof typeof ENGINE_KEY_VARIABLE;

/** Its name in `caveman:servers`: the first 16 hex of sha256("engine\0<engine>"), a dot, the variable. */
export const engineKeyName = (engine: KeyedEngine) =>
  `${createHash("sha256").update(`engine\0${engine}`).digest("hex").slice(0, 16)}.${ENGINE_KEY_VARIABLE[engine]}`;

/** Whether a `caveman:servers` name is an engine key (This Mac's server-key mirror leaves those alone). */
export const isEngineKeyName = (name: string) => (Object.keys(ENGINE_KEY_VARIABLE) as KeyedEngine[]).some((engine) => engineKeyName(engine) === name);

export interface EngineCloudKeysShape {
  /** The engine's key for this computer's person, or undefined. */
  readonly get: (engine: KeyedEngine) => Effect.Effect<string | undefined>;
  /** Keeps `key` in the vault for this person's Cloud computers; null removes it. */
  readonly set: (engine: KeyedEngine, key: string | null) => Effect.Effect<void, Error>;
}

/** None off a Cloud computer (This Mac never hands Claude a key). computerSecrets.ts provides the computer's. */
export const EngineCloudKeys = Context.Reference<EngineCloudKeysShape>("caveman/cloudLink/EngineCloudKeys", {
  defaultValue: () => ({
    get: () => Effect.succeed(undefined),
    set: () => Effect.fail(new Error("API keys for engines are kept only for Cloud computers")),
  }),
});

/** What claude holds instead of the vault key: one per runtime run, worth nothing outside this runtime's scrub. */
export const VAULT_KEY_STAND_IN = `caveman-vault-key-${randomBytes(24).toString("hex")}`;
/** What codex holds instead of its vault key, likewise. */
export const CODEX_VAULT_KEY_STAND_IN = `caveman-vault-openai-${randomBytes(24).toString("hex")}`;
const STAND_IN: Record<KeyedEngine, string> = { "claude-agent": VAULT_KEY_STAND_IN, codex: CODEX_VAULT_KEY_STAND_IN };
const vaultKeys = new Map<KeyedEngine, string>();
/**
 * The vault key behind `standIn`, for the egress scrub: only `engine`'s own stand-in (default Claude Agent's) opens
 * it, so a stand-in sent toward another engine's API stays a stand-in. Undefined for any other value.
 */
export const vaultKeyFor = (standIn: string, engine: KeyedEngine = "claude-agent"): string | undefined => (standIn === STAND_IN[engine] ? vaultKeys.get(engine) : undefined);

/** Whether this runtime holds the engine's vault key now (read for a chat it started); asks Cloud nothing. */
export const holdsVaultKey = (engine: KeyedEngine): boolean => vaultKeys.has(engine);

/** A launch of a Claude Agent or Codex the lane its person chose can't serve now: nothing starts, and this says why. */
export class EngineLoginUnavailable extends Schema.TaggedError<EngineLoginUnavailable>()("EngineLoginUnavailable", {
  engine: Schema.Literals(["claude-agent", "codex"]),
  /** `connection`: one of the person's connections (modelConnections.ts), where credentials stay outside the computer. */
  lane: Schema.Literals(["followed_login", "vault_key", "connection", "unknown"]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}
export const isEngineLoginUnavailable = Schema.is(EngineLoginUnavailable);

/** The engine runs on the person's API key there and Caveman has none for this computer now: nothing else is used instead. */
const KEY_GONE: Record<KeyedEngine, string> = {
  "claude-agent": `Your Anthropic key is missing. Add it again in ${CONNECT_WHERE}.`,
  codex: `Your OpenAI key is missing. Add it again in ${CONNECT_WHERE}.`,
};

/** This runtime's connections where credentials stay outside the computer (undefined everywhere else), or the refusal when Cloud can't say. */
const outsideOrUnknown = (engine: KeyedEngine, logins: FollowedLogins) =>
  Effect.tryPromise({ try: () => logins.connections(), catch: () => new EngineLoginUnavailable({ engine, lane: "unknown", detail: NOT_STARTED }) });

/** The lane a launch of `engine` runs on (engineLogins.ts LaunchLane), or the refusal when Cloud can't say. */
export const engineLane = (engine: KeyedEngine, logins: FollowedLogins = followedLogins) =>
  Effect.tryPromise({
    try: () => logins.lane(engine),
    catch: (error) => new EngineLoginUnavailable({ engine, lane: "unknown", detail: error instanceof Error ? error.message : String(error) }),
  });

/**
 * `env` for a launch of `engine`, on the lane its person chose (engineLane): the stand-in for their sign-in that
 * follows them, or for their vault key; with neither, `env` as given (the CLI's own login, as on This Mac, where
 * nothing here runs). Either real value stays here. A lane that can't serve fails the launch (EngineLoginUnavailable)
 * before the key is read: a plan sign-in that expired, was removed or is out of reach is never replaced by the key,
 * and a removed key never by a sign-in. Off Cloud's lanes (an older Cloud) the sign-in still comes first, the same way.
 *
 * `probe`: the launch only reads which login this computer has (the engine's capability probe). On a Mac it never
 * gets a connection's stand-in, so Settings keeps showing this Mac's own login as it is.
 */
export const withEngineKey = (
  engine: KeyedEngine,
  env: Record<string, string | undefined> | undefined,
  logins: FollowedLogins = followedLogins,
  threadId?: string,
  options: { readonly probe?: boolean } = {},
) =>
  Effect.gen(function* () {
    // Credentials stay outside this computer: the stand-in of the first connection that serves the engine, and
    // nothing read from Cloud but the list. `threadId`'s chat hears it when nothing does.
    const outside = yield* outsideOrUnknown(engine, logins);
    if (outside !== undefined) {
      vaultKeys.delete(engine);
      const egress = yield* Effect.serviceOption(EgressRoute);
      const joined = logins.joined;
      const launch = yield* Effect.tryPromise({
        try: () =>
          outside.launch(engine, env, {
            session: threadId === undefined || threadId === "" ? undefined : proxySession(threadId),
            ...(joined === undefined ? {} : { files: joined.files, codexHome: async () => path.dirname(await joined.paths.codex()) }),
            codexRefreshUrl: engine === "codex" && Option.isSome(egress) ? egress.value.route(CODEX_LOGIN_REFRESH) : undefined,
          }),
        catch: () => new EngineLoginUnavailable({ engine, lane: "unknown", detail: NOT_STARTED }),
      });
      if ("unavailable" in launch) return yield* new EngineLoginUnavailable({ engine, lane: "connection", detail: launch.unavailable });
      return launch.env;
    }
    // A Mac whose person connected this engine's plan: the launch stands on their connections (macConnections.ts).
    // Anything in the way (not signed in to Caveman, nothing connected, Cloud out of reach with nothing kept) leaves
    // the launch on this Mac's own login.
    const mac = logins.connected || options.probe === true ? undefined : macConnectionsOf(yield* CloudLinkState);
    if (mac !== undefined) {
      const session = threadId === undefined || threadId === "" ? undefined : proxySession(threadId);
      const connected = yield* Effect.promise(() => mac.launch(engine, env, session).catch(() => undefined));
      if (connected !== undefined) return connected;
    }
    const lane: LaunchLane = yield* engineLane(engine, logins);
    if (lane === "followed_login") {
      vaultKeys.delete(engine);
      const launch = yield* withFollowedLogin(engine, env, logins);
      if (launch === undefined) return yield* new EngineLoginUnavailable({ engine, lane, detail: "Cloud lost its link to Caveman. Try again in a moment." });
      if ("unavailable" in launch) return yield* new EngineLoginUnavailable({ engine, lane, detail: launch.message });
      return launch.env;
    }
    if (lane === "none") {
      vaultKeys.delete(engine);
      return env;
    }
    // `vault_key`, or `legacy` (no followed sign-in, and Cloud says nothing of lanes): the key when there is one.
    const key = yield* (yield* EngineCloudKeys).get(engine);
    if (key === undefined) {
      vaultKeys.delete(engine);
      if (lane === "vault_key") return yield* new EngineLoginUnavailable({ engine, lane, detail: KEY_GONE[engine] });
      return env;
    }
    vaultKeys.set(engine, key);
    // A codex home still holding a sign-in's stand-ins would win over the key.
    yield* Effect.promise(() => logins.dropStandIns(engine, env));
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...rest } = env ?? {};
    // codex exec reads CODEX_API_KEY; the app-server and the openai provider read OPENAI_API_KEY.
    return { ...rest, [ENGINE_KEY_VARIABLE[engine]]: STAND_IN[engine], ...(engine === "codex" ? { CODEX_API_KEY: STAND_IN[engine] } : {}) };
  });

/** Whether a codex launch here holds a stand-in (a sign-in's or a vault key's), so it works only through the scrub. Reads no key. */
export const holdsCloudStandIn = (engine: KeyedEngine, logins: FollowedLogins = followedLogins) =>
  Effect.gen(function* () {
    // Where credentials stay outside the computer every launch holds a connection's stand-in.
    if ((yield* outsideOrUnknown(engine, logins)) !== undefined) return true;
    const lane = yield* engineLane(engine, logins);
    if (lane !== "legacy") return lane !== "none";
    return (yield* (yield* EngineCloudKeys).get(engine)) !== undefined;
  });
