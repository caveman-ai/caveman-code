// ), packages/shared/src/shell.ts @ ab3a3cd1; perf from 7f63b10275.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as HostProcess from "./HostProcess.ts";
import { envValue } from "./processEnv.ts";
import * as Context from "effect/Context";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";
const WINDOWS_REGISTRY_PROBE_TIMEOUT_MS = 10_000;
// A PowerShell stuck in the kernel survives the kill and holds stdout, so execFile's callback never fires.
const WINDOWS_REGISTRY_PROBE_DEADLINE = Duration.millis(WINDOWS_REGISTRY_PROBE_TIMEOUT_MS + 1000);
const LOGIN_SHELL_PROBE_TIMEOUT_MS = 5000;
const LOGIN_SHELL_PROBE_GRACE_MS = 1000;

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    encoding: "utf8";
    timeout: number;
    killSignal?: NodeJS.Signals | number;
    detached?: true;
    stdio?: ["ignore", "pipe", "ignore"];
  },
) => string;

function canExecuteFile(filePath: string): boolean {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CommandAvailabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
}

const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escapes a single argument for `cmd.exe` shell mode (`spawn(..., { shell: true })`
 * on Windows). Node hands the command string to `cmd.exe /d /s /c "<command>"`
 * without any quoting, so every dynamic argument must be escaped to survive both
 * cmd.exe parsing and the target program's `CommandLineToArgvW` parsing.
 * Mirrors cross-spawn's argument escaping.
 */
function escapeWindowsShellArg(arg: string): string {
  // Double up backslashes that precede a double quote, then escape the quote
  // itself so it survives CommandLineToArgvW.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes so the closing quote is not escaped away.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  // Quote the whole argument so embedded whitespace is preserved.
  escaped = `"${escaped}"`;
  // Escape cmd.exe metacharacters so cmd passes them through verbatim.
  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export type SpawnExecutableResolver = (
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => string | undefined;

function resolveSpawnExecutableWithNode(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const candidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );
  const isExecutable = (candidate: string) => {
    try {
      if (!NodeFS.statSync(candidate).isFile()) return false;
      if (platform === "win32") {
        return windowsPathExtensions.includes(path.extname(candidate).toUpperCase());
      }
      return canExecuteFile(candidate);
    } catch {
      return false;
    }
  };

  if (command.includes("/") || command.includes("\\")) {
    return candidates.find(isExecutable);
  }

  for (const pathEntry of (readEnvPath(env) ?? "").split(pathDelimiterForPlatform(platform))) {
    const normalizedPathEntry = stripWrappingQuotes(pathEntry.trim());
    if (normalizedPathEntry.length === 0) continue;
    for (const candidate of candidates) {
      const candidatePath = path.join(normalizedPathEntry, candidate);
      if (isExecutable(candidatePath)) return candidatePath;
    }
  }
  return undefined;
}

export const SpawnExecutableResolution = Context.Reference<SpawnExecutableResolver>(
  "@caveman-app/shared/shell/SpawnExecutableResolution",
  {
    defaultValue: () => resolveSpawnExecutableWithNode,
  },
);

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(NodeOS.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = NodeChildProcess.execFileSync,
): string | undefined {
  try {
    return trimNonEmpty(
      execFile("/bin/launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  } catch {
    return undefined;
  }
}

export function mergePathEntries(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = platform === "win32" ? ";" : ":";
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const pathValue of [preferredPath, inheritedPath]) {
    if (!pathValue) continue;
    for (const entry of pathValue.split(delimiter)) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry || seen.has(trimmedEntry)) {
        continue;
      }
      seen.add(trimmedEntry);
      merged.push(trimmedEntry);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function envCaptureStart(name: string): string {
  return `__CAVEMAN_CODE_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__CAVEMAN_CODE_ENV_${name}_END__`;
}

export function buildEnvironmentCaptureCommand(
  shell: string,
  names: ReadonlyArray<string>,
): string {
  const executableName = NodePath.basename(shell).toLowerCase();
  const isNushell = executableName.startsWith("nu");

  return names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      if (isNushell) {
        // Without a configured conversion, Nu expands home paths only in a list PATH.
        const defaultValue =
          name === "PATH"
            ? "if ($env.PATH? | describe | str starts-with 'list') { " +
              "$env.PATH | each {|p| if ($p | str starts-with '~') { " +
              "$p | path expand --no-symlink } else { $p } } | str join (char esep) " +
              "} else { $env.PATH? | default '' }"
            : `$env.${name}? | default ''`;
        const value =
          `if $env.${name}? == null { '' } else if ` +
          `$env.ENV_CONVERSIONS?.${name}?.to_string? != null { ` +
          `$env.${name} | do $env.ENV_CONVERSIONS.${name}.to_string $env.${name} ` +
          `} else { ${defaultValue} }`;
        return [
          `print '${envCaptureStart(name)}'`,
          `print (${value})`,
          `print '${envCaptureEnd(name)}'`,
        ].join("; ");
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");
}

function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  const value = output
    .slice(valueStartIndex, endIndex)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");

  return value.length > 0 ? value : undefined;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = NodeChildProcess.execFileSync,
) => {
  if (names.length === 0) {
    return {};
  }

  // Interactive startup loads PATH entries; detaching prevents job control on an
  // inherited controlling TTY from stopping the probe while the parent waits.
  // Interactive shells ignore SIGTERM, so only SIGKILL ends one whose rc hangs.
  const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(shell, names)], {
    encoding: "utf8",
    timeout: 5000,
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    killSignal: "SIGKILL",
  });

  return capturedEnvironment(output, names);
};

/**
 * readEnvironmentFromLoginShell off the event loop: the same command, run async. Spawned, not
 * execFile'd, because execFile drops `detached`, and the detached session is what keeps an
 * interactive shell's job control from stopping the probe on an inherited terminal.
 *
 * Every macOS and Linux start waits on this read, so it always settles: at `timeoutMs` the shell's
 * whole process group gets SIGKILL (an interactive shell ignores SIGTERM, and a grandchild may hold
 * stdout), and a second later it gives up whether or not the shell closed, since a process stuck in
 * the kernel survives even SIGKILL.
 */
export const readEnvironmentFromLoginShellAsync = (
  shell: string,
  names: ReadonlyArray<string>,
  timeoutMs = LOGIN_SHELL_PROBE_TIMEOUT_MS,
): Promise<Partial<Record<string, string>>> =>
  names.length === 0
    ? Promise.resolve({})
    : new Promise((resolve, reject) => {
        const child = NodeChildProcess.spawn(shell, ["-ilc", buildEnvironmentCaptureCommand(shell, names)], {
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const lastMarker = envCaptureEnd(names[names.length - 1]!);
        let output = "";
        let exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
        let timedOut = false;
        let settled = false;
        const settle = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(deadline);
          child.stdout?.destroy();
          outcome();
        };
        const timedOutError = () => new Error(`${shell} timed out reading the login environment`);
        // A job the rc started can hold stdout open long after the shell exits, so the pipe closing is
        // not the only sign the shell's output is all here: its last marker is too. A failed shell's
        // output is not read at all.
        const settleIfDone = (streamClosed: boolean) => {
          if (exit === undefined) return;
          const { code, signal } = exit;
          if (timedOut) {
            settle(() => reject(timedOutError()));
          } else if (code !== 0) {
            settle(() => reject(new Error(`${shell} exited with ${code ?? signal}`)));
          } else if (streamClosed || output.includes(lastMarker)) {
            settle(() => resolve(capturedEnvironment(output, names)));
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          // Detached, the shell leads its own process group, so -pid reaches anything it started.
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, timeoutMs);
        const deadline = setTimeout(() => {
          child.stdout?.destroy();
          child.unref();
          settle(() => reject(timedOutError()));
        }, timeoutMs + LOGIN_SHELL_PROBE_GRACE_MS);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          settleIfDone(false);
        });
        child.on("error", (error) => settle(() => reject(error)));
        child.on("exit", (code, signal) => {
          exit = { code, signal };
          settleIfDone(false);
        });
        child.on("close", (code, signal) => {
          exit ??= { code, signal };
          settleIfDone(true);
        });
      });

function capturedEnvironment(output: string, names: ReadonlyArray<string>): Partial<Record<string, string>> {
  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

const execWindowsEnvironmentProbe = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) =>
  Effect.callback<Option.Option<string>>((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.execFile(
        file,
        args,
        { ...options, windowsHide: true },
        (error, stdout) => {
          resume(Effect.succeed(error ? Option.none() : Option.some(stdout)));
        },
      );
    } catch {
      resume(Effect.succeedNone);
      return;
    }
    return Effect.sync(() => {
      child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    });
  });

/** The Windows environment as the registry keeps it for new processes, `%NAME%` references as written. */
export interface WindowsRegistryEnvironmentValues {
  /** HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment. */
  readonly machine: Readonly<Record<string, string>>;
  /** HKCU\Environment. */
  readonly user: Readonly<Record<string, string>>;
}

/**
 * Prints both environment keys' values unexpanded, as base64 of UTF-8 JSON: only ASCII crosses the pipe, so a folder
 * under a profile like `José Ñ` survives whatever code page the console has. No double quotes, which Node's argument
 * quoting would mangle.
 */
const WINDOWS_REGISTRY_ENVIRONMENT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$read = { param($key) $values = @{}; if ($null -ne $key) { foreach ($name in $key.GetValueNames()) { if ($name) { $values[$name] = [string]$key.GetValue($name, '', 'DoNotExpandEnvironmentNames') } } }; $values }",
  "$machine = & $read ([Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'))",
  "$user = & $read ([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'))",
  "$json = ConvertTo-Json -Compress -Depth 3 -InputObject @{ machine = $machine; user = $user }",
  "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))",
].join("; ");

const decodeWindowsRegistryEnvironment = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      machine: Schema.Record(Schema.String, Schema.String),
      user: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);

/** WINDOWS_REGISTRY_ENVIRONMENT_SCRIPT's answer; anything else (a module that printed, a cut-off run) is none. */
function parseWindowsRegistryEnvironment(
  output: string,
): WindowsRegistryEnvironmentValues | undefined {
  const encoded = output.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  return Option.getOrUndefined(
    decodeWindowsRegistryEnvironment(Buffer.from(encoded, "base64").toString("utf8")),
  );
}

/**
 * Reads the registry's environment through Windows PowerShell, by full path and without a profile: a profile can take
 * seconds and print anything. Undefined when it cannot (PowerShell blocked, timed out), so the PATH stays as it is.
 */
export const readWindowsRegistryEnvironment = Effect.fn("shell.readWindowsRegistryEnvironment")(
  function* (execFile: typeof execWindowsEnvironmentProbe = execWindowsEnvironmentProbe) {
    const env = yield* HostProcess.Environment;
    const systemRoot = envValue(env, "SystemRoot", "win32")?.trim() || "C:\\Windows";
    const powershell = NodePath.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const output = yield* execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_REGISTRY_ENVIRONMENT_SCRIPT],
      { encoding: "utf8", timeout: WINDOWS_REGISTRY_PROBE_TIMEOUT_MS },
    ).pipe(Effect.timeoutOption(WINDOWS_REGISTRY_PROBE_DEADLINE), Effect.map(Option.flatten));
    return Option.isNone(output) ? undefined : parseWindowsRegistryEnvironment(output.value);
  },
);

export type WindowsRegistryEnvironmentReader = () => Effect.Effect<
  WindowsRegistryEnvironmentValues | undefined
>;

export const WindowsRegistryEnvironment = Context.Reference<WindowsRegistryEnvironmentReader>(
  "@caveman-app/shared/shell/WindowsRegistryEnvironment",
  { defaultValue: () => () => readWindowsRegistryEnvironment() },
);

/**
 * `value` with each `%NAME%` that `lookup` knows replaced, as ExpandEnvironmentStrings does: an unknown one stays as
 * written, and its closing `%` may open the next.
 */
function expandWindowsReferences(
  value: string,
  lookup: (name: string) => string | undefined,
): string {
  let expanded = "";
  let index = 0;
  while (index < value.length) {
    const open = value.indexOf("%", index);
    const close = open === -1 ? -1 : value.indexOf("%", open + 1);
    if (close === -1) return expanded + value.slice(index);
    const replacement = close > open + 1 ? lookup(value.slice(open + 1, close)) : undefined;
    if (replacement === undefined) {
      expanded += value.slice(index, close);
      index = close;
    } else {
      expanded += value.slice(index, open) + replacement;
      index = close + 1;
    }
  }
  return expanded;
}

/**
 * The PATH a new terminal gets: the Machine `Path`, then the User `Path`, each `%NAME%` expanded against the
 * registry's variables over this process's, so one an installer set since this process started (nvm-windows'
 * NVM_HOME) still resolves.
 */
export function windowsRegistryPath(
  registry: WindowsRegistryEnvironmentValues,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const variables = new Map<string, string>();
  const lookup = (name: string) => variables.get(name.toUpperCase());
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) variables.set(name.toUpperCase(), value);
  }
  for (const scope of [registry.machine, registry.user]) {
    for (const [name, value] of Object.entries(scope)) {
      if (name.toUpperCase() !== "PATH") {
        variables.set(name.toUpperCase(), expandWindowsReferences(value, lookup));
      }
    }
  }
  const paths = [registry.machine, registry.user].flatMap((scope) => {
    const value = envValue(scope, "Path", "win32")?.trim();
    return value ? [expandWindowsReferences(value, lookup)] : [];
  });
  return paths.length > 0 ? paths.join(WINDOWS_PATH_DELIMITER) : undefined;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}

function normalizePathEntryForComparison(entry: string, platform: NodeJS.Platform): string {
  const normalized = stripWrappingQuotes(entry.trim());
  // Windows: `C:\Program Files\nodejs\` (as Node's installer writes it) is `C:\Program Files\nodejs`.
  return platform === "win32" ? normalized.replace(/(.)[\\/]+$/, "$1").toLowerCase() : normalized;
}

function sanitizePathEntry(entry: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? entry.replaceAll('"', "") : entry;
}

export function mergePathValues(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = pathDelimiterForPlatform(platform);
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of [preferredPath, inheritedPath]) {
    if (!rawValue) continue;

    for (const entry of rawValue.split(delimiter)) {
      const sanitized = sanitizePathEntry(entry.trim(), platform);
      if (sanitized.length === 0) continue;

      const normalized = normalizePathEntryForComparison(sanitized, platform);
      if (normalized.length === 0 || seen.has(normalized)) continue;

      seen.add(normalized);
      merged.push(sanitized);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function readEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return readEnvPath(env) ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed: string[] = [];
  for (const entry of rawValue.split(";")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    parsed.push(trimmed.startsWith(".") ? trimmed.toUpperCase() : `.${trimmed.toUpperCase()}`);
  }
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
  extname: (path: string) => string,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

// Session bootstrap resolves the same commands over and over, each PATH scan
// costing hundreds of 'shell.isExecutableFile' filesystem probes (tens of
// thousands per connect). Memoize the scan outcome per
// (platform, PATH, PATHEXT, command) for a short window: repeat scans hit the
// cache while any change to the search environment invalidates immediately.
// Explicit-path resolution is never cached - callers probe paths they have
// just written (e.g. managed binary installs). A "not-found" outcome is also
// cached for the TTL, so a just-installed binary can stay invisible for up to
// 30s unless resolved by explicit path.
// TTL expiry uses the monotonic clock (Clock.monotonicTimeNanos) so backward
// wall-clock adjustments cannot keep expired entries alive.
const COMMAND_RESOLUTION_CACHE_TTL_NANOS = 30_000_000_000n;
const COMMAND_RESOLUTION_CACHE_MAX_ENTRIES = 512;
const COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR = String.fromCharCode(0);

interface CommandResolutionCacheEntry {
  readonly resolvedPath: string | null;
  readonly expiresAtNanos: bigint;
}

// The cache lives in the Effect environment (like HostProcess.Platform above)
// so tests and embedders can provide an isolated instance; the default is a
// single process-wide map shared by all consumers.
export const CommandResolutionCache = Context.Reference<Map<string, CommandResolutionCacheEntry>>(
  "@caveman-app/shared/shell/CommandResolutionCache",
  {
    defaultValue: () => new Map(),
  },
);

interface PathDirectoryListing {
  readonly modified: number | null | undefined;
  readonly names: ReadonlySet<string> | undefined;
}

// mtime of a PATH directory; null when missing, undefined when unreadable.
const directoryMtime = (directory: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.stat(directory)).pipe(
    Effect.map((info) =>
      info.type === "Directory" ? Option.getOrUndefined(info.mtime)?.getTime() : undefined,
    ),
    Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? null : undefined)),
  );

// Dated before it is read, so an entry added in between changes the mtime seen
// on the next check. Without names, lookups probe candidates directly.
const listPathDirectory = Effect.fnUntraced(function* (
  directory: string,
): Effect.fn.Return<PathDirectoryListing, never, FileSystem.FileSystem> {
  const modified = yield* directoryMtime(directory);
  if (modified == null) return { modified, names: modified === null ? new Set() : undefined };
  const entries = yield* FileSystem.FileSystem.use((fileSystem) =>
    fileSystem.readDirectory(directory),
  ).pipe(Effect.orElseSucceed(() => undefined));
  return { modified, names: entries && new Set(entries.map((entry) => entry.toLowerCase())) };
});

const PathDirectoryListings = Context.Reference<
  Cache.Cache<string, PathDirectoryListing, never, FileSystem.FileSystem> | undefined
>("@caveman-app/shared/shell/PathDirectoryListings", { defaultValue: () => undefined });

/**
 * Run a batch of command lookups (e.g. editor discovery) that lists each PATH
 * directory once, relisting it if its mtime changes, and probes only listed
 * names instead of every PATH x PATHEXT candidate per command.
 */
export const withPathDirectoryListings = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const listings = yield* Cache.make({
      capacity: 1024,
      lookup: listPathDirectory,
      requireServicesAt: "lookup",
    });
    return yield* effect.pipe(Effect.provideService(PathDirectoryListings, listings));
  });

// An injected resolver or locator may answer differently for the same search, so its
// entries are kept apart from every other resolver's.
let spawnResolverCacheIdCount = 0;
const spawnResolverCacheIds = new WeakMap<SpawnExecutableResolver | XcodeGitLocator, number>();
function spawnResolverCacheId(resolver: SpawnExecutableResolver | XcodeGitLocator): number {
  const known = spawnResolverCacheIds.get(resolver);
  if (known !== undefined) return known;
  const id = spawnResolverCacheIdCount++;
  spawnResolverCacheIds.set(resolver, id);
  return id;
}

function cacheCommandResolution(
  cache: Map<string, CommandResolutionCacheEntry>,
  cacheKey: string,
  resolvedPath: string | null,
  nowNanos: bigint,
): void {
  if (cache.size >= COMMAND_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(cacheKey, {
    resolvedPath,
    expiresAtNanos: nowNanos + COMMAND_RESOLUTION_CACHE_TTL_NANOS,
  });
}

// Trace each command lookup, not every candidate file it probes.
const isExecutableFile = Effect.fnUntraced(function* (
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (stat === null || stat.type !== "File") return false;

  if (platform === "win32") {
    const extension = path.extname(filePath);
    if (extension.length === 0) return false;
    return windowsPathExtensions.includes(extension.toUpperCase());
  }

  return canExecuteFile(filePath);
});

const resolveCommandPathForPlatform = Effect.fn("shell.resolveCommandPathForPlatform")(function* (
  command: string,
  options: CommandAvailabilityOptions & { readonly platform: NodeJS.Platform },
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const platform = options.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );

  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of commandCandidates) {
      if (yield* isExecutableFile(candidate, platform, windowsPathExtensions)) {
        return candidate;
      }
    }
    return null;
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) {
    return null;
  }

  const cacheKey = [platform, pathValue, windowsPathExtensions.join(";"), command].join(
    COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR,
  );
  const cache = yield* CommandResolutionCache;
  const nowNanos = yield* Clock.monotonicTimeNanos;
  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    return cached.resolvedPath;
  }

  // Keep case variants: Windows can make PATH directories case-sensitive.
  const pathEntries: string[] = [];
  const seenPathEntries = new Set<string>();
  for (const entry of pathValue.split(pathDelimiterForPlatform(platform))) {
    const pathEntry = stripWrappingQuotes(entry.trim());
    if (pathEntry.length === 0 || seenPathEntries.has(pathEntry)) continue;

    seenPathEntries.add(pathEntry);
    pathEntries.push(pathEntry);
  }

  const listings = yield* PathDirectoryListings;
  for (const pathEntry of pathEntries) {
    let listing = listings && (yield* Cache.get(listings, pathEntry));
    if (listings && listing?.names && listing.modified !== (yield* directoryMtime(pathEntry))) {
      yield* Cache.invalidate(listings, pathEntry);
      listing = yield* Cache.get(listings, pathEntry);
    }
    for (const candidate of commandCandidates) {
      // The stat below still checks exact case and rejects non-files.
      if (listing?.names && !listing.names.has(candidate.toLowerCase())) continue;
      const candidatePath = path.join(pathEntry, candidate);
      if (yield* isExecutableFile(candidatePath, platform, windowsPathExtensions)) {
        cacheCommandResolution(cache, cacheKey, candidatePath, nowNanos);
        return candidatePath;
      }
    }
  }
  cacheCommandResolution(cache, cacheKey, null, nowNanos);
  return null;
});

export const resolveCommandPath = Effect.fn("shell.resolveCommandPath")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return yield* resolveCommandPathForPlatform(command, {
    env: options.env ?? (yield* HostProcess.Environment),
    platform: yield* HostProcess.Platform,
  });
});

// Git for Windows 2.56 moved x64 builds from mingw64 to ucrt64; ARM64 builds
// live in clangarm64 and 32-bit ones in mingw32.
const GIT_FOR_WINDOWS_BUILDS = ["ucrt64", "clangarm64", "mingw64", "mingw32"] as const;

function isFileSync(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Swaps Git for Windows' launcher (`<Git>\cmd\git.exe`, the only git its
 * installer puts on PATH, or the portable build's `<Git>\bin\git.exe`) for the
 * git.exe it starts. The launcher costs a second process on every git command,
 * and each launch leaks a kernel token reference that slows process creation
 * machine-wide until reboot. The real binary sets HOME itself, but adds its own
 * folders to PATH for hooks, ssh and credential helpers only when MSYSTEM is
 * unset, so the launcher stays when MSYSTEM is set. Anything else is returned
 * as is.
 */
export function preferGitForWindowsBinary(
  executable: string,
  env: NodeJS.ProcessEnv,
  isFile: (filePath: string) => boolean = isFileSync,
): string {
  if (env.MSYSTEM) return executable;
  const path = NodePath.win32;
  if (path.basename(executable).toLowerCase() !== "git.exe") return executable;
  const launcherDirectory = path.dirname(executable);
  const launcherFolder = path.basename(launcherDirectory).toLowerCase();
  if (launcherFolder !== "cmd" && launcherFolder !== "bin") return executable;
  const installRoot = path.dirname(launcherDirectory);
  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = path.join(installRoot, build, "bin", "git.exe");
    if (isFile(candidate)) return candidate;
  }
  return executable;
}

// What npm's cmd-shim writes for a package whose bin is a native executable.
const NPM_EXECUTABLE_SHIM_PREFIX = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
];
const NPM_EXECUTABLE_SHIM_RUN = /^"%dp0%\\([^"%]+\.exe)" +%\*$/;

function readFileSyncOrUndefined(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The executable an npm cmd-shim runs, when the shim does nothing else.
 * Started through the shim, the executable is a child of `cmd.exe` and so
 * escapes the kill-on-close job libuv puts every child in: it keeps running
 * after this process is killed. Started directly it is in the job.
 */
export function npmShimExecutable(
  shimPath: string,
  readFile: (filePath: string) => string | undefined = readFileSyncOrUndefined,
  isFile: (filePath: string) => boolean = isFileSync,
): string | undefined {
  const path = NodePath.win32;
  if (path.extname(shimPath).toLowerCase() !== ".cmd") return undefined;
  // Compared exactly: whitespace CMD keeps, such as after `SET dp0=`, would
  // make it run a different file than the one found here.
  const lines = readFile(shimPath)
    ?.split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines?.length !== NPM_EXECUTABLE_SHIM_PREFIX.length + 1) return undefined;
  if (NPM_EXECUTABLE_SHIM_PREFIX.some((expected, index) => lines[index] !== expected)) {
    return undefined;
  }
  const target = NPM_EXECUTABLE_SHIM_RUN.exec(lines.at(-1)!)?.[1];
  if (target === undefined) return undefined;
  const executable = path.join(path.dirname(shimPath), target);
  return isFile(executable) ? executable : undefined;
}

export interface SpawnCommandOptions extends CommandAvailabilityOptions {
  /** Run the executable behind an npm cmd-shim directly (see `npmShimExecutable`). */
  readonly bypassNpmShim?: boolean;
}

/** A drive or UNC path: never looked up under the folder a child starts in. */
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;

/**
 * Whether Windows looks for a bare name on PATH alone: this process turned its current-directory search off
 * (NoDefaultCurrentDirectoryInExePath in its own environment, never a child's: the runtime sets it at its start,
 * exeSearch.ts), and every entry of the child's PATH is absolute, as one that is not is looked up under the child's
 * working directory. Off Windows (a Windows host in a test) there is no such search to fear.
 */
function searchesPathOnly(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== "win32") return true;
  if (envValue(process.env, "NoDefaultCurrentDirectoryInExePath", "win32") === undefined) return false;
  return resolvePathEnvironmentVariable(env)
    .split(WINDOWS_PATH_DELIMITER)
    .every((entry) => entry.length === 0 || WINDOWS_ABSOLUTE_PATH.test(stripWrappingQuotes(entry)));
}

export type XcodeGitLocator = (env: NodeJS.ProcessEnv) => string | undefined;

// xcrun honors DEVELOPER_DIR and the `xcode-select` choice, as the shim does.
function locateXcodeGitWithXcrun(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const located = NodeChildProcess.execFileSync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
      env,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return NodePath.isAbsolute(located) ? located : undefined;
  } catch {
    return undefined;
  }
}

export const XcodeGitLocation = Context.Reference<XcodeGitLocator>(
  "@caveman-app/shared/shell/XcodeGitLocation",
  { defaultValue: () => locateXcodeGitWithXcrun },
);

const MACOS_GIT_SHIM = "/usr/bin/git";

/**
 * /usr/bin/git is an xcrun shim that finds the active developer directory on
 * every run: about 8 ms per spawn, against under 3 ms for the git behind it.
 * Only the shim is replaced, so a git the user put first on PATH (Homebrew,
 * Nix) still wins, and git's own children keep the same PATH. Any lookup
 * failure keeps plain `git`.
 */
const resolveMacosGit = Effect.fnUntraced(function* (
  env: NodeJS.ProcessEnv,
  resolveExecutable: SpawnExecutableResolver,
) {
  const locateXcodeGit = yield* XcodeGitLocation;
  const cache = yield* CommandResolutionCache;
  const cacheKey = [
    "xcode-git",
    String(spawnResolverCacheId(resolveExecutable)),
    String(spawnResolverCacheId(locateXcodeGit)),
    resolvePathEnvironmentVariable(env),
    env.DEVELOPER_DIR ?? "",
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
  const nowNanos = yield* Clock.currentTimeNanos;
  const cached = cache.get(cacheKey);
  // An Xcode update or removal deletes the binary; look again instead of failing the spawn.
  if (
    cached !== undefined &&
    cached.expiresAtNanos > nowNanos &&
    (cached.resolvedPath === null ||
      resolveExecutable(cached.resolvedPath, "darwin", env) !== undefined)
  ) {
    return cached.resolvedPath ?? "git";
  }
  const located =
    resolveExecutable("git", "darwin", env) === MACOS_GIT_SHIM ? locateXcodeGit(env) : undefined;
  const realGit =
    located !== undefined && resolveExecutable(located, "darwin", env) !== undefined
      ? located
      : null;
  cacheCommandResolution(cache, cacheKey, realGit, nowNanos);
  return realGit ?? "git";
});

/**
 * How to spawn `command` with `args`. On Windows: the executable PATH holds by full path (Git for Windows' real
 * git.exe for its launcher), and a `.cmd` or `.bat` through cmd.exe with its line escaped. A bare name PATH does not
 * hold goes to Node as is only where Windows would look for it on PATH alone (searchesPathOnly), which then fails
 * the spawn as this does; anywhere else it fails here, NotFound, as the spawn would: Windows would look for it in the
 * child's working directory, a project's own `git.exe` for one. Untraced because it runs before most spawns and
 * returns at once off Windows.
 */
export const resolveSpawnCommand = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnCommandOptions = {},
): Effect.fn.Return<ResolvedSpawnCommand, PlatformError.PlatformError> {
  const platform = yield* HostProcess.Platform;
  const isMacosGit = platform === "darwin" && command === "git";
  if (platform !== "win32" && !isMacosGit) {
    return { command, args: [...args], shell: false };
  }

  const hostEnvironment = yield* HostProcess.Environment;
  const env =
    options.env === undefined
      ? hostEnvironment
      : options.extendEnv
        ? { ...hostEnvironment, ...options.env }
        : options.env;
  const resolveExecutable = yield* SpawnExecutableResolution;
  if (isMacosGit) {
    return {
      command: yield* resolveMacosGit(env, resolveExecutable),
      args: [...args],
      shell: false,
    };
  }
  // The scan is synchronous and runs before every child process, so it shares
  // the PATH scan cache above. Explicit paths stay uncached for the same reason,
  // and so do misses: a failed spawn is how providers report "not installed",
  // and that has to clear the moment the binary appears.
  const explicitPath = command.includes("/") || command.includes("\\");
  const cache = yield* CommandResolutionCache;
  const cacheKey = [
    "spawn",
    String(spawnResolverCacheId(resolveExecutable)),
    platform,
    resolvePathEnvironmentVariable(env),
    resolveWindowsPathExtensions(env).join(";"),
    env.MSYSTEM ? "msystem" : "",
    command,
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
  const nowNanos = yield* Clock.currentTimeNanos;
  const cached = explicitPath ? undefined : cache.get(cacheKey);
  let resolvedExecutable: string | null;
  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    resolvedExecutable = cached.resolvedPath;
  } else {
    // Cached with the scan: its file checks would otherwise run before every
    // git launch. A Git upgrade that moves the real binary can fail git for up
    // to the cache lifetime.
    const found = resolveExecutable(command, platform, env);
    resolvedExecutable = found === undefined ? null : preferGitForWindowsBinary(found, env);
    if (!explicitPath && resolvedExecutable !== null) {
      cacheCommandResolution(cache, cacheKey, resolvedExecutable, nowNanos);
    }
  }
  if (resolvedExecutable === null && !explicitPath && !searchesPathOnly(env)) {
    return yield* Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        syscall: `spawn ${command}`,
        pathOrDescriptor: command,
        // Node's own words for it: callers recognise a command that is not installed by them.
        description: `spawn ${command} ENOENT`,
      }),
    );
  }
  const resolvedCommand = resolvedExecutable ?? command;
  const extension = NodePath.win32.extname(resolvedCommand).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolvedCommand, args: [...args], shell: false };
  }
  const shimExecutable = options.bypassNpmShim ? npmShimExecutable(resolvedCommand) : undefined;
  if (shimExecutable !== undefined) {
    return { command: shimExecutable, args: [...args], shell: false };
  }

  // Node runs a shell spawn as `cmd.exe /d /s /c "<command> <args...>"`, but
  // passing args with `shell: true` prints DEP0190. Build the same escaped line
  // here and pass no args.
  return {
    command: [resolvedCommand, ...args].map(escapeWindowsShellArg).join(" "),
    args: [],
    shell: true,
  };
});

export const isCommandAvailable = Effect.fn("shell.isCommandAvailable")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return (yield* resolveCommandPath(command, options)) !== null;
});

export function resolveKnownWindowsCliDirs(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const userProfile = env.USERPROFILE?.trim();
  const programFiles = env.ProgramFiles?.trim();
  const fnmDir = env.FNM_DIR?.trim() || (appData ? `${appData}\\fnm` : undefined);

  return [
    ...(appData ? [`${appData}\\npm`] : []),
    ...(localAppData ? [`${localAppData}\\Programs\\nodejs`, `${localAppData}\\Volta\\bin`] : []),
    ...(localAppData ? [`${localAppData}\\pnpm`] : []),
    ...(userProfile
      ? [`${userProfile}\\.local\\bin`, `${userProfile}\\.bun\\bin`, `${userProfile}\\scoop\\shims`]
      : []),
    // winget's links to the command-line tools it installs.
    ...(localAppData ? [`${localAppData}\\Microsoft\\WinGet\\Links`] : []),
    // fnm's default Node, which otherwise only `fnm env` in a PowerShell profile puts on PATH.
    ...(fnmDir ? [`${fnmDir}\\aliases\\default`] : []),
    // The machine-wide installers' defaults: Node (nvm-windows' link too), Git for Windows, GitHub CLI.
    ...(programFiles
      ? [`${programFiles}\\nodejs`, `${programFiles}\\Git\\cmd`, `${programFiles}\\GitHub CLI`]
      : []),
  ];
}

/** Keep one PATH spelling in copied Windows environment records. */
export function setWindowsPath(env: NodeJS.ProcessEnv, value: string): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") {
      delete env[key];
    }
  }
  env.PATH = value;
}

/**
 * A Windows PATH: this process's first, in its order; then what `registryPath` (windowsRegistryPath) adds, the tools
 * installed since the process started; then the folders installers commonly use, for an environment missing both.
 * Starts no process: without `registryPath` it is the PATH the runtime starts with, before its server listens.
 */
export function resolveWindowsPath(
  env: NodeJS.ProcessEnv,
  registryPath?: string,
): string | undefined {
  const knownCliPath = resolveKnownWindowsCliDirs(env).join(WINDOWS_PATH_DELIMITER);
  return mergePathValues(
    mergePathValues(readEnvPath(env), registryPath, "win32"),
    knownCliPath,
    "win32",
  );
}
