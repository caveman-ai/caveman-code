// ), apps/server/src/os-jank.ts @ ab3a3cd1.
import * as HostProcess from "@caveman-app/shared/HostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readEnvironmentFromLoginShellAsync,
  readPathFromLaunchctl,
  resolveWindowsPath,
  setWindowsPath,
  WindowsRegistryEnvironment,
  windowsRegistryPath,
} from "@caveman-app/shared/shell";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

// mise's record of the PATH entries it added. It must travel with the
// shell's PATH, or `mise x` can rebuild PATH behind a same-named wrapper
// (`exec mise x claude -- claude`) that then re-runs itself forever.
const LOGIN_SHELL_NAMES = ["PATH", "__MISE_DIFF"];

/**
 * A Cloud computer's runtime (its tools channel, CAVEMAN_RUNTIME_TOOLS_ADDRESS): every tool runs in the tools container
 * with the PATH the computer image and the computers service give it, and the runtime container's user has no login
 * shell (/sbin/nologin), so a login shell read adds nothing. Under gVisor it held the server for its 5 s timeout, about
 * 2 s of every wake after the module graph loaded (Caveman Cloud the spec addendum 2026-10-24).
 */
const onCloudComputer = (env: NodeJS.ProcessEnv): boolean => (env.CAVEMAN_RUNTIME_TOOLS_ADDRESS?.trim() ?? "") !== "";

type LoginShellAnswer = { readonly environment: Partial<Record<string, string>> } | { readonly error: unknown };
let prefetchedLoginShell: { readonly shell: string; readonly answer: Promise<LoginShellAnswer> } | undefined;

/**
 * Starts the login shell read fixPath takes (the user's rc files: often a second or more), so it
 * runs while the runtime's module graph loads instead of blocking startup after it. bin.ts calls it.
 */
export function prefetchLoginShellEnvironment(env = process.env, platform = process.platform): void {
  // Without HOME, fixPath sets it first and the shell must see it: read then, as before.
  if ((platform !== "darwin" && platform !== "linux") || (env.HOME?.trim() ?? "") === "" || onCloudComputer(env)) return;
  const shell = listLoginShellCandidates(platform, env.SHELL)[0];
  if (shell === undefined) return;
  prefetchedLoginShell = {
    shell,
    answer: readEnvironmentFromLoginShellAsync(shell, LOGIN_SHELL_NAMES).then(
      (environment) => ({ environment }),
      (error: unknown) => ({ error }),
    ),
  };
}

function hydratePosixPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  prefetched?: { readonly shell: string } & LoginShellAnswer,
): void {
  let shellEnvironment: Partial<Record<string, string>> = {};
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      if (prefetched?.shell !== shell) {
        shellEnvironment = readEnvironmentFromLoginShell(shell, LOGIN_SHELL_NAMES);
      } else if ("error" in prefetched) {
        throw prefetched.error;
      } else {
        shellEnvironment = prefetched.environment;
      }
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellEnvironment.PATH) break;
  }

  const shellPath = shellEnvironment.PATH;
  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;
  // A PATH the user chose (the terminal that ran `caveman code`) keeps its
  // order, like a command run by hand there; the login shell only adds what it
  // lacks. Only a bare system PATH, what launchd or a service manager hands a
  // GUI app, lets the login shell's order lead. Re-read under another HOME, the
  // login shell skips the user's rc files and path_helper puts /opt/homebrew/bin
  // first, so a stale `codex` there beat the user's own.
  const shellLeads = isBareSystemPath(env.PATH);
  const loginPath = shellPath ?? launchctlPath;
  const mergedPath = shellLeads
    ? mergePathEntries(loginPath, env.PATH, platform)
    : mergePathEntries(env.PATH, loginPath, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
  if (shellLeads && shellPath && shellEnvironment.__MISE_DIFF) {
    env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
  }
}

// System and package-manager dirs: a GUI PATH made of only these (launchd's, or one a
// `launchctl config user path` gave Homebrew) is not the user's choice of order.
// ponytail: fixed list; a service PATH with another system dir (a distro's /usr/lib/...) counts as user-chosen.
const SYSTEM_PATH_DIRS = new Set([
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/snap/bin",
  "/usr/games",
  "/usr/local/games",
]);

const isBareSystemPath = (path: string | undefined): boolean =>
  (path ?? "").split(":").every((entry) => entry.trim() === "" || SYSTEM_PATH_DIRS.has(entry.trim()));

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (options?: {
  readonly shellEnvironmentPrepared?: boolean | undefined;
}): Effect.fn.Return<void> {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;

  // Windows: no process before the server listens (PowerShell took 0.3-2.4 s to start on windows-2025, past 10 s
  // with a profile). The registry's PATH is read before engines are probed (makePathRefresh).
  if (platform === "win32") {
    yield* Effect.sync(() => {
      const path = resolveWindowsPath(env);
      if (path !== undefined) setWindowsPath(env, path);
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect)),
      ),
    );
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  const early = prefetchedLoginShell;
  prefetchedLoginShell = undefined;
  if (options?.shellEnvironmentPrepared === true || onCloudComputer(env)) return;
  const prefetched = early === undefined ? undefined : { shell: early.shell, ...(yield* Effect.promise(() => early.answer)) };
  yield* Effect.sync(() => hydratePosixPath(env, platform, prefetched)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

/** Refreshes within this long of a registry read share it: a refresh of every engine reads it once. */
const PATH_REFRESH_SHARED_NANOS = 5_000_000_000n;
/**
 * For this long after the runtime starts, the PATH it was given is as fresh as the registry's (Explorer passed it on at
 * launch), so the engines' first probes start no PowerShell while the first run loads.
 */
const PATH_FRESH_AT_LAUNCH_NANOS = 15_000_000_000n;

/**
 * Brings PATH up to date before engines are probed. Windows: the Machine and User `Path` as the registry holds them now
 * (windowsRegistryPath), their new entries after this process's, so a tool installed while Caveman Code is open (Git,
 * Node, gh, Claude Code) is found without a restart; a failed read leaves PATH as it was. Elsewhere it does nothing:
 * a login shell read at startup already gave PATH what the person's shell has.
 */
export const makePathRefresh = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  const startedAt = yield* Clock.monotonicTimeNanos;
  const lastReadAt = yield* Ref.make<bigint | undefined>(undefined);
  return lock.withPermits(1)(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "win32") return;
      const now = yield* Clock.monotonicTimeNanos;
      const last = yield* Ref.get(lastReadAt);
      if (now - startedAt < PATH_FRESH_AT_LAUNCH_NANOS) return;
      if (last !== undefined && now - last < PATH_REFRESH_SHARED_NANOS) return;
      yield* Ref.set(lastReadAt, now);
      const registry = yield* (yield* WindowsRegistryEnvironment)();
      if (registry === undefined) return;
      const env = yield* HostProcess.Environment;
      const path = resolveWindowsPath(env, windowsRegistryPath(registry, env));
      if (path !== undefined) setWindowsPath(env, path);
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => logPathHydrationWarning("Failed to read PATH from the registry.", defect)),
      ),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(yield* HostProcess.HomeDirectory, ".caveman-code");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
