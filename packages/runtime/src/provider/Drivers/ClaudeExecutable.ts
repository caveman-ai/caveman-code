// ), apps/server/src/provider/Drivers/ClaudeExecutable.ts @ ab3a3cd1.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { AgentScope } from "@caveman-app/shared/AgentScope";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { SpawnExecutableResolution } from "@caveman-app/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { withEngineKey } from "../../cloudLink/engineKeys.ts";

/**
 * Windows launcher-script extensions that Node cannot spawn without a shell
 * (`spawn EINVAL` since Node 20.12) and that the Claude Agent SDK therefore
 * cannot use as `pathToClaudeCodeExecutable`.
 */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Whether `filePath` names a Windows launcher script that the Claude Agent SDK
 * cannot spawn directly as `pathToClaudeCodeExecutable`.
 */
export const isWindowsClaudeLauncherShimPath = (filePath: string): boolean =>
  WINDOWS_SHIM_EXTENSIONS.has(NodePath.win32.extname(filePath).toLowerCase());

/**
 * Entry points of the npm `@anthropic-ai/claude-code` package relative to the
 * global `node_modules` directory that sits next to the npm launcher shim.
 * Newer package versions ship a native `bin/claude.exe`; older versions only
 * ship `cli.js`, which the SDK runs with a JavaScript runtime.
 */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

export type ExecutableFileCheck = (filePath: string) => boolean;

function isExistingFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Injectable file-existence check so tests can run against a fake filesystem. */
export const ClaudeExecutableFileCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableFileCheck",
  {
    defaultValue: () => isExistingFile,
  },
);

/** Whether `filePath` is a file this user may execute (symlinks followed). */
export function isExecutableFile(filePath: string): boolean {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Injectable so tests can describe a PATH without touching the real one. */
export const ClaudeExecutableCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableCheck",
  { defaultValue: () => isExecutableFile },
);

/**
 * cmux puts a `claude` shim first on `PATH` in its terminals; it runs the real
 * CLI inside cmux's own hooks. This is the test cmux's shim applies to itself.
 */
const isCmuxShimDirectory = (dir: string, environment: NodeJS.ProcessEnv): boolean =>
  dir === environment.CMUX_CLAUDE_WRAPPER_SHIM_ROOT ||
  dir.includes("/cmux-cli-shims/") ||
  dir.endsWith("/cmux-cli-shims");

/**
 * On POSIX, resolves a bare command name against `PATH` the way the user's
 * shell does, except that cmux's shim is skipped: it would wrap every session
 * the runtime starts in cmux's hooks. Other shims (pnpm, asdf, nix wrappers)
 * are the `claude` the user's terminal runs, so they are kept. An explicit
 * path is the user's choice and is kept; with only cmux's shim on `PATH` it is
 * used.
 */
export function resolvePosixClaudeExecutablePath(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  isExecutable: ExecutableFileCheck = isExecutableFile,
): string {
  if (binaryPath.length === 0 || binaryPath.includes("/")) return binaryPath;
  let cmuxShim: string | undefined;
  for (const dir of (environment.PATH ?? "").split(NodePath.posix.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = NodePath.posix.join(dir, binaryPath);
    if (!isExecutable(candidate)) continue;
    if (!isCmuxShimDirectory(dir, environment)) return candidate;
    cmuxShim ??= candidate;
  }
  return cmuxShim ?? binaryPath;
}

/**
 * Resolves the configured Claude binary path into a value the Claude Agent
 * SDK can spawn directly via `pathToClaudeCodeExecutable`.
 *
 * The SDK spawns the given path without a shell and without Windows PATH /
 * PATHEXT resolution, so a bare command name like `claude` fails with
 * "native binary not found" and an npm `claude.cmd` shim fails with
 * `spawn EINVAL`. CLI probes avoid this via `resolveSpawnCommand`, which can
 * fall back to `shell: true`; the SDK offers no such escape hatch.
 *
 * On Windows this resolves the command against PATH/PATHEXT and, when the
 * result is an npm launcher shim, follows it to the real package entry
 * (`bin/claude.exe`, or `cli.js` for older package versions). On other
 * platforms it skips cmux's shim on `PATH` (see
 * `resolvePosixClaudeExecutablePath`).
 */
export const resolveClaudeSdkExecutablePath = Effect.fn("resolveClaudeSdkExecutablePath")(
  function* (binaryPath: string, environment: NodeJS.ProcessEnv): Effect.fn.Return<string> {
    const platform = yield* HostProcess.Platform;
    if (platform !== "win32") {
      return resolvePosixClaudeExecutablePath(
        binaryPath,
        environment,
        yield* ClaudeExecutableCheck,
      );
    }

    const resolveExecutable = yield* SpawnExecutableResolution;
    const isFile = yield* ClaudeExecutableFileCheck;
    const resolved = resolveExecutable(binaryPath, platform, environment) ?? binaryPath;
    const extension = NodePath.win32.extname(resolved).toLowerCase();
    if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) {
      return resolved;
    }

    const shimDirectory = NodePath.win32.dirname(resolved);
    for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
      const candidate = NodePath.win32.join(shimDirectory, ...entrySegments);
      if (isFile(candidate)) {
        return candidate;
      }
    }

    yield* Effect.logWarning(
      "Claude launcher shim resolved but no known package entry was found next to it; the Claude Agent SDK cannot spawn launcher scripts directly.",
      { binaryPath, resolvedShimPath: resolved },
    );
    return binaryPath;
  },
);

/**
 * The `claude` the driver hands every spawn site (SDK sessions, CLI probes,
 * text generation, update ownership), so they all run the same binary.
 * Windows keeps the configured command: its probes resolve launcher scripts
 * through a shell, and the SDK path goes through
 * `resolveClaudeSdkExecutablePath`.
 */
export const resolveClaudeCliPath = Effect.fn("resolveClaudeCliPath")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string> {
  if ((yield* HostProcess.Platform) === "win32") return binaryPath;
  return resolvePosixClaudeExecutablePath(binaryPath, environment, yield* ClaudeExecutableCheck);
});

// Entry extensions the Claude SDK runs through node instead of executing.
const CLAUDE_SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"];

/**
 * SDK options for the claude this computer starts: on a Cloud computer with the person's vault
 * key (engineKeys.ts) in its env, and through the agent scope (there, the tools container), as
 * `path ...executableArgs ...sdkArgs`. The SDK runs a script entry through node instead, so
 * those launch unwrapped. Sessions and the capability probe both use it, so the probe reads the
 * login where sessions run.
 */
type ClaudeLaunchOptions = {
  readonly pathToClaudeCodeExecutable?: string;
  readonly executableArgs?: Array<string>;
  readonly env?: Record<string, string | undefined>;
};

/** `scopeClaudeLaunch`, plus the agent scope the CLI runs in (for `AgentScope.stop` once it exits). */
export const scopeClaudeLaunchWithUnit = Effect.fn("scopeClaudeLaunch")(function* <O extends ClaudeLaunchOptions>(
  given: O,
  threadId?: string,
) {
  // No chat: the capability probe, which reads the login this computer has.
  const env = yield* withEngineKey("claude-agent", given.env, undefined, threadId, { probe: threadId === undefined });
  const options: O = env === given.env ? given : { ...given, env };
  const binaryPath = options.pathToClaudeCodeExecutable;
  if (binaryPath === undefined || CLAUDE_SCRIPT_EXTENSIONS.some((ext) => binaryPath.endsWith(ext))) {
    return { options, unit: undefined };
  }
  const launch = yield* (yield* AgentScope).wrap({ command: binaryPath, args: [], name: "claude", threadId, env: options.env });
  return {
    options:
      launch.args.length === 0
        ? options
        : { ...options, pathToClaudeCodeExecutable: launch.command, executableArgs: [...launch.args, ...(options.executableArgs ?? [])] },
    unit: launch.unit,
  };
});

export const scopeClaudeLaunch = <O extends ClaudeLaunchOptions>(given: O, threadId?: string) =>
  scopeClaudeLaunchWithUnit(given, threadId).pipe(Effect.map(({ options }) => options));
