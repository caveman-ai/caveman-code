/**
 * Codex API-key accounts in a home the app manages.
 *
 * Codex in Caveman Code runs on an OpenAI API key. Each Codex instance is one
 * account with its own CODEX_HOME under the runtime state dir (upstream
 * CodexManagedHome layout, `<stateDir>/providers/codex/<instanceId>/home`).
 * Codex's own `account/login/start` writes the key into that home, so the
 * key never sits in settings, in the runtime's environment or in `~/.codex`.
 * The home is forced to file credentials and API-key login only.
 *
 * Signing out (`account/logout`) removes the key from the home. Removing the
 * account in Settings (`removeCodexAccount`, on the explicit remove mutation)
 * signs out and deletes `<stateDir>/providers/codex/<instanceId>`. The
 * registry's reconcile never deletes a home: it cannot tell a user's deletion
 * from a settings reload.
 *
 * The user's own Codex login (`~/.codex`, a compact plan) is the
 * `chatGptLogin` setting. It waits for OpenAI's approval and is off by default.
 */
import * as NodeFS from "node:fs";

import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderSetupError,
  type CodexSettings,
  type ProviderInstanceId,
} from "@caveman-app/protocol";
import { tokenizeCliArgs } from "@caveman-app/shared/cliArgs";
import * as CodexErrors from "@caveman-app/codex-app-server/errors";
import * as ProviderAuthFlow from "@caveman-app/engine-core/server/providerAuthFlow";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { toolsSocket } from "../cloudLink/tools.ts";
import { removeTree } from "../removeTree.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import { withCodexAppServerClient } from "./CodexProvider.ts";

/** Last on the command line, so a user's launch arguments cannot undo them. */
export const CODEX_MANAGED_LAUNCH_ARGS = `-c 'cli_auth_credentials_store="file"' -c 'forced_login_method="api"'`;
/**
 * On a Cloud computer the person may also sign the home in with compact, in a terminal there
 * (`codex login --device-auth`): the login stays on that computer's volume, readable by the
 * tools uid only, and we never read it.
 */
export const CODEX_COMPUTER_LAUNCH_ARGS = `-c 'cli_auth_credentials_store="file"'`;

/** Ambient variables that could pay for, redirect or relaunch a managed home's turns. */
export const AMBIENT_CODEX_VARIABLES = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
  "CAVEMAN_CODE_CODEX_LAUNCH_ARGS",
] as const;

export const CODEX_API_KEY_METHOD_ID = "api-key";

export interface CodexLaunch {
  /** True for an API-key account in an app-managed home. */
  readonly managed: boolean;
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * An account's managed home. On a Cloud computer every account's is one home, `providers/codex/active/home`: the
 * tools container, where Codex runs as the agent's uid, mounts only `providers/codex/active` (Caveman Cloud
 * driver.go), so no other account's key is there for code to read, and a sign-in made on the computer is the
 * computer's one Codex login. The runtime makes the home inside the mount, so it owns what it chmods.
 */
export const codexManagedHomePath = (path: Path.Path, stateDir: string, instanceId: string) =>
  path.join(stateDir, "providers", "codex", toolsSocket() === undefined ? instanceId : "active", "home");

/**
 * Whether the runtime may touch a Codex home: on a Cloud computer the agent's uid writes in it, so one that is not
 * a real directory (a symlink planted in its place) is never chmodded, cleaned or read through.
 */
export const codexHomeIsReal = (home: string) => {
  if (toolsSocket() === undefined) return true;
  try {
    return NodeFS.lstatSync(home).isDirectory();
  } catch {
    return false;
  }
};

/** chmod through a descriptor opened without following a symlink: a home swapped for one fails (ELOOP) instead. */
const chmodNoFollow = (dir: string, mode: number) => {
  const fd = NodeFS.openSync(dir, NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW);
  try {
    NodeFS.fchmodSync(fd, mode);
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * The one answer to "which home is this instance's Codex": the managed home
 * for an API-key account, `undefined` for the user's own login (upstream layout
 * rules apply). Launches, terminals, the session scanner and usage all ask here.
 */
export const codexInstanceHomePath = (input: {
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly instanceId: string;
  readonly config: CodexSettings;
}) =>
  input.config.chatGptLogin
    ? undefined
    : codexManagedHomePath(input.path, input.stateDir, input.instanceId);

/** Re-quotes one argv entry so `tokenizeCliArgs` reads it back unchanged. */
const quoteCliArg = (arg: string) => `'${arg.replaceAll("'", `'"'"'`)}'`;

/**
 * What an instance really launches with. API-key accounts (the default) get
 * the managed home and lose ambient credentials; the user's own login keeps
 * upstream behaviour unchanged.
 */
export function resolveCodexLaunch(input: {
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}): CodexLaunch {
  const homePath = codexInstanceHomePath(input);
  if (homePath === undefined) {
    return { managed: false, config: input.config, environment: input.environment };
  }
  // `undefined`, not `delete`: spawns that extend process.env would bring a
  // deleted name back, while Node drops undefined entries after the merge.
  const environment = { ...input.environment };
  for (const name of AMBIENT_CODEX_VARIABLES) environment[name] = undefined;
  // The user's arguments are re-quoted one by one, so an unterminated quote in
  // them cannot swallow the managed flags.
  const userArgs = tokenizeCliArgs(input.config.launchArgs).map(quoteCliArg);
  return {
    managed: true,
    environment,
    config: {
      ...input.config,
      homePath,
      shadowHomePath: "",
      launchArgs: [...userArgs, toolsSocket() === undefined ? CODEX_MANAGED_LAUNCH_ARGS : CODEX_COMPUTER_LAUNCH_ARGS].join(" "),
    },
  };
}

const setupError = (instanceId: ProviderInstanceId, operation: string, detail: string) =>
  new ProviderSetupError({ instanceId, operation, detail });

// A Codex that went away is down however its going was noticed first: its exit, or a write to it or a read from it
// failing (on Linux a write to an exited Codex fails with EPIPE before the exit is reported).
const isCodexDown = Schema.is(
  Schema.Union([
    CodexErrors.CodexAppServerProcessExitedError,
    CodexErrors.CodexAppServerSpawnError,
    CodexErrors.CodexAppServerTransportError,
    CodexErrors.CodexAppServerInputStreamEndedError,
  ]),
);

/**
 * A Codex that exited, never started or never answered did not judge the key:
 * say so. Its own words (stderr) go to the runtime log, minus the key; the
 * client gets fixed text.
 */
const accountError =
  (instanceId: ProviderInstanceId, operation: string, rejected: string, apiKey?: string) =>
  (error: { readonly message: string }) =>
    Cause.isTimeoutError(error)
      ? Effect.fail(setupError(instanceId, operation, "Codex did not answer within 30 seconds."))
      : isCodexDown(error)
      ? Effect.logWarning(
          `Codex ${operation} failed`,
          apiKey ? error.message.replaceAll(apiKey, "[api key]") : error.message,
        ).pipe(
          Effect.andThen(
            Effect.fail(
              setupError(instanceId, operation, "Codex could not start. The runtime log has its error output."),
            ),
          ),
        )
      : Effect.fail(setupError(instanceId, operation, rejected));

/**
 * The managed home holds a credential: owner-only. On a Cloud computer Codex runs in the tools
 * container, which mounts the homes (Caveman Cloud Sandboxes) and shares the runtime's
 * group: the group writes it there, and Codex keeps its credential file to the tools uid.
 */
export const ensureCodexManagedHome = Effect.fn("ensureCodexManagedHome")(function* (
  launch: CodexLaunch,
) {
  if (!launch.managed) return;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(launch.config.homePath, { recursive: true });
  if (toolsSocket() === undefined) return yield* fs.chmod(launch.config.homePath, 0o700);
  yield* Effect.try({ try: () => chmodNoFollow(launch.config.homePath, 0o770), catch: (error) => new Error(`Codex's home is not a directory the runtime made: ${String(error)}`) });
});

const withAccountClient = (launch: CodexLaunch) =>
  withCodexAppServerClient({
    binaryPath: launch.config.binaryPath,
    homePath: launch.config.homePath,
    launchArgs: resolveCodexLaunchArgs(launch.config.launchArgs, launch.environment),
    cwd: launch.config.homePath,
    environment: launch.environment,
  });

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * Does OpenAI take this key? Codex stores any key at account/login/start, and
 * its model/list answers from a bundled list even when OpenAI refuses the key,
 * so the key is checked with one free authenticated call: GET <base>/models.
 * The key travels in a header only. 401/403 is a rejection, except "Missing
 * scopes": a restricted key without Models read still runs Codex's turns. No
 * answer at all is "unreachable"; any other status means OpenAI did not refuse the key.
 */
export const checkOpenAiKey = (baseUrl: string, apiKey: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (response.status !== 401 && response.status !== 403) {
      await response.body?.cancel();
      return "accepted" as const;
    }
    // Read, never logged: OpenAI's invalid-key message echoes part of the key.
    return /missing scopes/i.test(await response.text()) ? ("accepted" as const) : ("rejected" as const);
  }).pipe(Effect.orElseSucceed(() => "unreachable" as const));

/** The OpenAI base URL this Codex sends turns to (its `openai_base_url`), or undefined for another provider. */
const codexOpenAiBaseUrl = (config: unknown) => {
  const c = (config as { config?: { openai_base_url?: unknown; model_provider?: unknown } } | undefined)?.config;
  if (typeof c?.model_provider === "string" && c.model_provider !== "openai") return undefined;
  return typeof c?.openai_base_url === "string" && c.openai_base_url ? c.openai_base_url : OPENAI_API_BASE_URL;
};

/** Codex's own API-key login, into the instance's managed home, then one check that OpenAI takes the key. */
export const loginCodexApiKey = Effect.fn("loginCodexApiKey")(function* (
  instanceId: ProviderInstanceId,
  launch: CodexLaunch,
  apiKey: string,
) {
  if (!launch.managed)
    return yield* setupError(instanceId, "start", "Turn off the ChatGPT login to add an API key.");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Errors carry fixed text only: nothing Codex echoes about the key reaches a client.
  yield* ensureCodexManagedHome(launch).pipe(
    Effect.mapError(() => setupError(instanceId, "start", "Could not prepare the Codex home.")),
  );
  const verdict = yield* Effect.gen(function* () {
    const { client } = yield* withAccountClient(launch);
    yield* client.request("account/login/start", { type: "apiKey", apiKey });
    const account = yield* client.request("account/read", {});
    if (account.account?.type !== "apiKey") return "rejected" as const;
    const baseUrl = codexOpenAiBaseUrl(yield* client.raw.request("config/read", {}).pipe(Effect.orElseSucceed(() => undefined)));
    return baseUrl === undefined ? ("accepted" as const) : yield* checkOpenAiKey(baseUrl, apiKey);
  }).pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
    // A refused key, or a sign-in cut short (timeout, interrupt, error), leaves no key in the home.
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) && exit.value !== "rejected"
        ? Effect.void
        : codexHomeIsReal(launch.config.homePath)
          ? fs.remove(path.join(launch.config.homePath, "auth.json"), { force: true }).pipe(Effect.ignore)
          : Effect.void,
    ),
    Effect.catch(accountError(instanceId, "verify", "Codex did not accept the API key.", apiKey)),
  );
  // Node's fetch ignores proxies Codex honours, so "unreachable" is no verdict: the key stays, turns will tell.
  if (verdict === "unreachable") yield* Effect.logWarning("Could not reach OpenAI to check a Codex API key; it was kept.");
  if (verdict === "rejected") return yield* setupError(instanceId, "verify", "Codex did not accept the API key.");
});

export const logoutCodexAccount = Effect.fn("logoutCodexAccount")(function* (
  instanceId: ProviderInstanceId,
  launch: CodexLaunch,
) {
  yield* Effect.gen(function* () {
    const { client } = yield* withAccountClient(launch);
    yield* client.request("account/logout", undefined);
  }).pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.catch(accountError(instanceId, "logout", "Codex could not remove the API key.")),
  );
});

/**
 * The account was removed in Settings: sign out in its managed home, then
 * delete the instance's app-owned directory. Only the explicit remove action
 * calls this. The user's own login (`chatGptLogin`) is never signed out, and
 * nothing outside the state dir is touched.
 */
export const removeCodexAccount = Effect.fn("removeCodexAccount")(function* (input: {
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const launch = resolveCodexLaunch(input);
  if (launch.managed && (yield* fs.exists(launch.config.homePath).pipe(Effect.orElseSucceed(() => false)))) {
    // Best effort: the directory goes either way, and auth.json with it.
    yield* logoutCodexAccount(input.instanceId, launch).pipe(
      Effect.catch((error) => Effect.logWarning("Codex sign-out before removal failed", error.detail)),
    );
  }
  yield* removeTree(fs, input.path.join(input.stateDir, "providers", "codex", input.instanceId));
  // The registry brings the default slot straight back as an API-key account,
  // possibly before this delete ran: leave it an empty home, not a missing one.
  if (input.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("codex"))) {
    yield* ensureCodexManagedHome(resolveCodexLaunch({ ...input, config: { ...input.config, chatGptLogin: false } }));
  }
});

/**
 * Sign-in for an API-key account: the client is asked for the key (a
 * `credentials` interaction), then Codex logs in with it inside the managed home.
 */
export const makeCodexApiKeyAuth = Effect.fn("makeCodexApiKeyAuth")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly launch: CodexLaunch;
  /** Re-probes the instance after the account changes. */
  readonly onChanged: Effect.Effect<void>;
}) {
  const { instanceId, launch, onChanged } = input;
  const context = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >();
  return yield* ProviderAuthFlow.make({
    instanceId,
    // The managed home is the account: instances never share it.
    credentialBinding: { owner: "t3", key: `codex:home:${launch.config.homePath}` },
    methods: Effect.succeed([
      {
        id: CODEX_API_KEY_METHOD_ID,
        name: "OpenAI API key",
        description: "Codex runs on this key in a home Caveman Code manages.",
        type: "credentials" as const,
      },
    ]),
    authenticate: (_methodId, flow) =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<string>();
        yield* flow.setInteraction(
          {
            type: "credentials",
            id: CODEX_API_KEY_METHOD_ID,
            fields: [{ name: "apiKey", label: "OpenAI API key", secret: true }],
          },
          (response) => {
            const apiKey = response.type === "credentials" ? response.values.apiKey?.trim() : "";
            return apiKey
              ? Deferred.succeed(answer, apiKey).pipe(Effect.asVoid)
              : Effect.fail(setupError(instanceId, "respond", "Enter an OpenAI API key."));
          },
        );
        const apiKey = yield* Deferred.await(answer);
        yield* flow.verifying;
        yield* loginCodexApiKey(instanceId, launch, apiKey).pipe(Effect.provide(context));
        yield* onChanged;
      }),
    logout: logoutCodexAccount(instanceId, launch).pipe(
      Effect.provide(context),
      Effect.andThen(onChanged),
      Effect.as("Signed out. The API key was removed from the Codex home."),
    ),
  });
});
