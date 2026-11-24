/**
 * Per session: the enabled plugins become one engine-neutral bundle, then a
 * projection per engine.
 *
 * Containment is applied once, in the bundle, so every engine gets it: each
 * stdio MCP server, command hook, LSP server and monitor starts through
 * `sandboxLaunch.mjs` (see `LaunchPolicy`). It drops every environment
 * variable not on the allowlist, keeps the process out of the runtime's
 * state directory and the credential files in `containmentFor`, and lets it
 * write only to the session's worktree (minus its .git, .caveman and .claude)
 * and a package cache holding its temp dir: with sandbox-exec on macOS,
 * bubblewrap on Linux when it works, else the environment filter alone
 * (`detectSandbox`). What stays
 * open is in README.md beside this file. Credentials come only from the
 * broker, only for names a connector of the plugin declares. A stdio server
 * gets them through a 0600 file the launcher reads, so the value is never in
 * the engine's config, the launcher's environment or argv; a remote server
 * gets them in its HTTP headers (which engines receive over stdin or RPC).
 * Plugin processes are started by the engine, so they also run inside the
 * engine's own containment and egress rules.
 *
 * Nothing here writes the user's ~/.claude or ~/.codex.
 *
 * @module plugins/resolve
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findGitBash, PosixShellMissingError } from "@caveman-app/shared/posixShell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import type {
  AcpPluginMcpServer,
  CavemanPluginOptions,
  ClaudeAgentPluginOptions,
  CodexPluginOptions,
  PluginMcpServer,
} from "@caveman-app/engine-core/server/SessionPlugins";

import { CredentialBroker } from "./CredentialBroker.ts";
import {
  CONTAINED_HOOK_TYPES,
  findFrontmatter,
  type HookCommand,
  type Hooks,
  type LspServer,
  type McpServerConfig,
  type Monitor,
} from "./format.ts";
import { type LoadedPlugin, type PluginItem, reservedServerName } from "./load.ts";
import { PERSONAL_SPACE_ID } from "./personal.ts";
import { treeDigest, treeStamp, watchedTreeStamp } from "./spaces.ts";

export const SANDBOX_LAUNCHER = fileURLToPath(new URL("./sandboxLaunch.mjs", import.meta.url));

/** What every plugin process may see. Anything else needs Settings' envAllowlist or the broker. */
export const BASE_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
];
/** Variables Claude Code sets for hooks. */
const HOOK_ENV = ["CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_DATA", "CLAUDE_ENV_FILE"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A plugin's own MCP `env` reaches the launcher under this prefix; the launcher unwraps it for the child only. */
export const PLUGIN_ENV_PREFIX = "CAVEMAN_PLUGIN_ENV_";
/** Unset before the launcher starts: each could run code inside it, before it filters anything. */
const LOADER_ENV = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
];

/**
 * How plugin processes are kept out of files: `macos` (sandbox-exec), `bwrap`
 * (bubblewrap, Linux), or `none` (only the environment filter applies).
 */
export type Sandbox = "macos" | "bwrap" | "none";

/** What a plugin process may see and touch. Passed to the launcher in argv: names and paths, never values. */
export interface LaunchPolicy {
  /** Environment variable names passed through from the engine. */
  readonly keep: ReadonlyArray<string>;
  /** Paths the process can neither read nor write. */
  readonly deny: ReadonlyArray<string>;
  /** Paths inside `deny` it may read. */
  readonly read: ReadonlyArray<string>;
  /**
   * The only places it may write besides `cache` (never a root's `.git`,
   * `.caveman` or `.claude`): a session's MCP servers get its worktree, and
   * so do its hooks when it lies outside `worktrees`. Absent: no write limit.
   */
  readonly write?: ReadonlyArray<string>;
  /** A writable package cache, set as the process's XDG_CACHE_HOME and npm cache; `<cache>/tmp` is its TMPDIR. */
  readonly cache?: string;
  /**
   * The runtime's worktrees dir: a hook's CLAUDE_PROJECT_DIR inside it is
   * writable, so the shared Claude Agent plugin copy needs no per-session policy.
   */
  readonly worktrees?: string;
  /** How `deny` is enforced; absent means sandbox-exec on macOS, nothing elsewhere. */
  readonly sandbox?: Sandbox;
  /** A 0600 JSON file of brokered credentials the launcher sets for the child alone. */
  readonly secrets?: string;
}

/**
 * The sandbox plugin processes get here: sandbox-exec on macOS; on Linux
 * bubblewrap when it can make a sandbox (it needs unprivileged user
 * namespaces, which some hosts and containers turn off); else none.
 */
const BWRAP_PROBE = ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--", "true"];

export function detectSandbox(platform: NodeJS.Platform = process.platform): Sandbox {
  if (platform === "darwin") return existsSync("/usr/bin/sandbox-exec") ? "macos" : "none";
  if (platform !== "linux") return "none";
  // ponytail: bubblewrap only; Landlock needs a native helper and allowlists rather than denies.
  const probe = spawnSync("bwrap", BWRAP_PROBE, {
    stdio: "ignore",
    timeout: 5_000,
  });
  return probe.status === 0 ? "bwrap" : "none";
}

/**
 * `detectSandbox` without holding the caller: the bubblewrap probe runs as a child the event loop does not wait on.
 * A runtime starts it as it builds its plugin registry and waits for the answer only where a plugin is listed or
 * launched; the synchronous probe held a Cloud computer's start about 0.35 s under gVisor (Caveman Cloud ADR
 * 0136 addendum 2026-10-24). Never rejects: a probe that cannot run answers "none", as `detectSandbox` does.
 */
export function detectSandboxLater(platform: NodeJS.Platform = process.platform): Promise<Sandbox> {
  if (platform !== "linux") return Promise.resolve(detectSandbox(platform));
  return new Promise((resolve) => {
    try {
      const probe = spawn("bwrap", BWRAP_PROBE, { stdio: "ignore", timeout: 5_000 });
      probe.once("error", () => resolve("none"));
      probe.once("close", (code) => resolve(code === 0 ? "bwrap" : "none"));
    } catch {
      resolve("none");
    }
  });
}

/**
 * Files no plugin process may touch: the runtime's state directory (secrets,
 * brokered credential files, sessions, settings, any engine home the app keeps
 * there), except the space checkouts and plugin copies, which stay readable
 * but not writable; the user's credential files (ssh, netrc, cloud CLIs,
 * Kubernetes, Docker, npm, GitHub, keychains); and other agents' token
 * stores. ~/.claude itself stays readable because hooks read the session
 * transcript there; only its credentials file is denied. Writes go nowhere
 * but the package cache and each session's worktree (see `resolveBundle`):
 * not the user's TMPDIR or /tmp, where executables later run outside the
 * sandbox (a terminal's CLI shims, a repo cloned there).
 */
export function containmentFor(
  stateDir: string,
  home: string = os.homedir(),
  // A Cloud computer's runtime identity (runtime.key), mounted outside the state dir.
  linkDir: string | undefined = process.env.CAVEMAN_CLOUD_LINK_DIR,
): Pick<LaunchPolicy, "deny" | "read" | "write"> {
  // Best effort: a denylist can never name every credential store, so the real
  // guarantee is the file sandbox over the paths below, not completeness.
  const inHome = [
    ".ssh",
    ".netrc",
    ".git-credentials",
    ".gnupg",
    ".password-store",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".docker/config.json",
    ".npmrc",
    ".pypirc",
    ".config/gh",
    ".config/hub",
    ".config/op",
    "Library/Keychains",
    // Login / next-shell / launch persistence: writing any of these is code execution
    // outside the sandbox (the reviewer wrote ~/.gitconfig core.fsmonitor, ~/.zshrc and a
    // LaunchAgent). The write allowlist already refuses them; also denied read+write here
    // so the env-filter-only fallback is no worse and nothing reads them.
    ".gitconfig",
    ".config/git",
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".bashrc",
    ".bash_profile",
    ".profile",
    "Library/LaunchAgents",
    "Library/LaunchDaemons",
    // The user's Claude configuration: MCP server env (`claude mcp add -e TOKEN=…`),
    // settings env blocks and apiKeyHelper. The transcript dir stays readable (hooks need it).
    ".claude.json",
    ".claude/settings.json",
    // Cloud and package registry credentials.
    ".config/.wrangler",
    ".wrangler",
    ".vault-token",
    ".terraform.d/credentials.tfrc.json",
    ".cargo/credentials.toml",
    ".gem/credentials",
    ".m2/settings.xml",
    ".yarnrc.yml",
    ".pgpass",
    ".my.cnf",
    ".cache/huggingface/token",
    ".config/doctl",
    ".vercel",
    ".supabase",
    // Other agents' logins and tokens.
    ".codex",
    ".claude/.credentials.json",
    ".gemini",
    ".config/github-copilot",
    ".local/share/opencode",
    ".cursor",
  ];
  return {
    deny: [stateDir, ...(linkDir ? [linkDir] : []), ...inHome.map((rel) => path.join(home, ...rel.split("/")))],
    read: [path.join(stateDir, "spaces"), path.join(stateDir, "plugins")],
    write: [],
  };
}

export interface BundleItem extends PluginItem {
  readonly plugin: string;
}

export interface BundleHook {
  readonly plugin: string;
  readonly event: string;
  readonly matcher?: string;
  /** The hook as Claude reads it; a `command` hook starts through the launcher. */
  readonly hook: Readonly<Record<string, unknown>>;
}

/** Engine-neutral, JSON-safe. */
export interface PluginBundle {
  readonly plugins: ReadonlyArray<{ readonly id: string; readonly root: string }>;
  readonly skills: ReadonlyArray<BundleItem>;
  readonly commands: ReadonlyArray<BundleItem>;
  readonly agents: ReadonlyArray<BundleItem>;
  readonly hooks: ReadonlyArray<BundleHook>;
  /** Keyed `<plugin>__<server>` (plugin name; the full id when two spaces share a name). */
  readonly mcpServers: Readonly<Record<string, PluginMcpServer>>;
  readonly rules: ReadonlyArray<{ readonly plugin: string; readonly name: string; readonly text: string }>;
  /** How this session's hooks start, for hooks found outside hooks.json (skill frontmatter). */
  readonly hookPolicy: LaunchPolicy;
  /** Plugin ids whose hooks are kept (Settings' trusted list); every other plugin's hooks are left out. Absent: all kept. */
  readonly trusted?: ReadonlyArray<string>;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Claude Code expands `${CLAUDE_PLUGIN_ROOT}` in MCP and hook configs. */
const withRoot = (value: string, root: string) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", root);

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** A resolved value; `brokered` when a credential from the broker went into it. */
interface Resolved {
  readonly value: string;
  readonly brokered: boolean;
}

/** `${NAME}` and `${NAME:-default}` from allowlisted env, then the broker. None when one is missing. */
const expand = Effect.fn("plugins.expand")(function* (
  value: string,
  lookup: (name: string) => Effect.Effect<Option.Option<Resolved>>,
) {
  let out = "";
  let last = 0;
  let brokered = false;
  for (const match of value.matchAll(REFERENCE)) {
    const found = yield* lookup(match[1]!);
    const resolved = Option.isSome(found) ? found.value.value : match[2];
    if (resolved === undefined) return Option.none<Resolved>();
    brokered ||= Option.isSome(found) && found.value.brokered;
    out += value.slice(last, match.index) + resolved;
    last = match.index + match[0].length;
  }
  return Option.some<Resolved>({ value: out + value.slice(last), brokered });
});

/**
 * The launcher's argv. `/usr/bin/env -u` first clears what could run code in it, wherever a POSIX shell starts
 * it: everywhere for hooks and monitors (on Windows Claude Code runs those in Git Bash, which has env), and for
 * MCP and LSP servers off Windows. An engine starts those on Windows with CreateProcess, where no env exists:
 * there `LAUNCHER_ENV_CLEARED` empties the same variables in the server's environment instead.
 */
function launcherArgv(policy: LaunchPolicy, platform: NodeJS.Platform = process.platform, shell = true): ReadonlyArray<string> {
  const json = JSON.stringify(policy);
  const node = [
    process.execPath,
    // The launcher runs outside the sandbox: a plugin's SIGUSR1 must not open an inspector in it.
    "--disable-sigusr1",
    SANDBOX_LAUNCHER,
    // Git Bash rewrites the quotes and backslashes of a JSON argument on its way to a Windows program:
    // there the policy crosses as base64url, which it leaves alone.
    platform === "win32" && shell ? `${POLICY_BASE64}${Buffer.from(json).toString("base64url")}` : json,
  ];
  return platform === "win32" && !shell ? node : ["/usr/bin/env", ...LOADER_ENV.flatMap((name) => ["-u", name]), ...node];
}

/**
 * A contained server's own command line from its launch arguments (launcherArgv's, then the server's command and
 * arguments): without the launcher and its policy, which names the session's own folders. Undefined for a server
 * the launcher does not start.
 */
export function containedCommand(args: ReadonlyArray<string>): ReadonlyArray<string> | undefined {
  const at = args.indexOf(SANDBOX_LAUNCHER);
  return at === -1 ? undefined : args.slice(at + 2);
}

/** The launcher's policy argument as base64url JSON (sandboxLaunch.mjs reads both forms). */
export const POLICY_BASE64 = "base64url:";

/** On Windows, the variables `/usr/bin/env -u` clears elsewhere, emptied in an MCP or LSP server's environment. */
const launcherEnvCleared = (platform: NodeJS.Platform = process.platform): Record<string, string> =>
  platform === "win32" ? Object.fromEntries(LOADER_ENV.map((name) => [name, ""])) : {};

/**
 * A path as a POSIX shell command reads it: on Windows with forward slashes, which Git Bash takes as the same
 * Windows path (`C:/Users/…`), where its backslashes would be escapes.
 */
const shellPath = (p: string, platform: NodeJS.Platform = process.platform): string => (platform === "win32" ? p.replaceAll("\\", "/") : p);

/**
 * A hook's or monitor's shell: /bin/sh, or on Windows Git Bash by its Windows path (the launcher, a Windows process,
 * starts it). Throws PosixShellMissingError on a Windows without it, never `/bin/sh`: Windows would read that as
 * `\bin\sh.exe` on the drive the hook starts on.
 */
const hookShell = (platform: NodeJS.Platform = process.platform): string => {
  if (platform !== "win32") return "/bin/sh";
  const bash = findGitBash();
  if (bash === undefined) throw new PosixShellMissingError();
  return bash;
};

/** `contain` of one hook or monitor, or undefined (left out) when it needs a POSIX shell this Windows lacks. */
const withShell = <A>(contain: () => A | undefined, onMissing: (error: PosixShellMissingError) => void = () => undefined): A | undefined => {
  try {
    return contain();
  } catch (error) {
    if (!(error instanceof PosixShellMissingError)) throw error;
    onMissing(error);
    return undefined;
  }
};

/**
 * A hook as Claude reads it, with a `command` hook rewritten to start through
 * the launcher (an exec-form hook keeps its argv, without a shell). Undefined
 * for a hook the launcher cannot contain.
 */
export function containHook(
  hook: HookCommand,
  root: string,
  policy: LaunchPolicy,
): Record<string, unknown> | undefined {
  // Throws PosixShellMissingError for a shell command on a Windows without Git Bash (hookShell).
  if (!CONTAINED_HOOK_TYPES.has(hook.type)) return undefined;
  if (hook.type !== "command") return { ...hook };
  if (typeof hook.command !== "string") return undefined;
  const { args, ...rest } = hook;
  const tail =
    args === undefined
      ? [hookShell(), "-c", withRoot(hook.command, shellPath(root))]
      : [withRoot(hook.command, root), ...args.map((a) => withRoot(a, root))];
  return { ...rest, command: [...launcherArgv(policy), ...tail].map(shellQuote).join(" ") };
}

/** `containHook` over a whole hooks map (skill frontmatter); hooks it cannot contain are left out. */
function containHooks(hooks: Hooks, root: string, policy: LaunchPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [event, matchers] of Object.entries(hooks)) {
    out[event] = matchers.map((matcher) => ({
      ...matcher,
      hooks: matcher.hooks.flatMap((hook) => withShell(() => containHook(hook, root, policy)) ?? []),
    }));
  }
  return out;
}

export const mcpServerKey = (pluginName: string, server: string) =>
  `${pluginName}__${server}`.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * Each plugin server's bundle key, in bundle order: `<plugin>__<server>`, a
 * personal server by its own name, the same plugin name from a second
 * marketplace by its full id, numbered when that is taken too (`a@b` keys as
 * `a_b`, the plugin `a_b`'s own name). A server whose key would pass for one
 * of the runtime's own is left out (`reserved` hears of it): `caveman` from a
 * marketplace named `setup`, next to another `caveman`, would be keyed
 * `caveman_setup__<server>`, whose tools the Caveman engine runs as a setup
 * chat's, without a card. The loader checks names alone (load.ts
 * reservedServerName); this is the key every engine sees.
 */
export function serverKeys(
  plugins: ReadonlyArray<LoadedPlugin>,
  reserved?: (plugin: LoadedPlugin, server: string, key: string) => void,
): Map<string, { readonly plugin: LoadedPlugin; readonly server: string }> {
  const keys = new Map<string, { readonly plugin: LoadedPlugin; readonly server: string }>();
  for (const plugin of plugins) {
    for (const [server, config] of Object.entries(plugin.mcpServers)) {
      if ("url" in config && config.unavailable !== undefined) continue;
      let key = plugin.space === PERSONAL_SPACE_ID ? server.replace(/[^A-Za-z0-9_-]/g, "_") : mcpServerKey(plugin.name, server);
      if (keys.has(key)) key = mcpServerKey(plugin.id, server);
      for (let n = 2; keys.has(key); n++) key = mcpServerKey(`${plugin.id}_${n}`, server);
      if (reservedServerName(key)) reserved?.(plugin, server, key);
      else keys.set(key, { plugin, server });
    }
  }
  return keys;
}

/** Credential names a plugin's connectors declare for `server` (a connector without a server covers all). */
export function declaredCredentials(plugin: LoadedPlugin, server: string): ReadonlySet<string> {
  return new Set(
    (plugin.contributes.connectors ?? [])
      .filter((connector) => connector.server === undefined || connector.server === server)
      .flatMap((connector) => connector.credentials ?? []),
  );
}

/** The directory a space's credential files go in, under the runtime's `credentialsDir`. */
export const credentialFilesFor = (credentialsDir: string, plugin: Pick<LoadedPlugin, "space">) =>
  path.join(credentialsDir, plugin.space.replace(/[^A-Za-z0-9._-]/g, "_"));

/**
 * Writes one server's brokered credentials to a 0600 file (in a 0700
 * directory) for the launcher, replacing the previous values. Named by the
 * server, never by the values, so a rotation or revocation reaches a server
 * the engine restarts.
 */
async function writeCredentialFile(dir: string, id: string, values: Readonly<Record<string, string>>) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const file = path.join(dir, `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`);
  // Sessions resolve at once (the hub opens a chat's servers together), each writing this file: one temp file each.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(values), { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, file);
  } catch (error) {
    // Nothing else removes it: left behind, it would keep a value after the person revokes it.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return file;
}

/**
 * Builds the bundle for one session from the plugins enabled for it.
 * `envAllowlist` adds names to `BASE_ENV_ALLOWLIST`.
 */
export const resolveBundle = Effect.fn("plugins.resolveBundle")(function* (
  plugins: ReadonlyArray<LoadedPlugin>,
  options: {
    readonly envAllowlist?: ReadonlyArray<string>;
    /** Files plugin processes are kept out of and where they write; see `containmentFor`. */
    readonly contain?: Pick<LaunchPolicy, "deny" | "read" | "write" | "cache" | "worktrees">;
    /** The session's worktree root: its MCP servers may write there (hooks learn it from Claude inside `worktrees`). */
    readonly worktree?: string;
    /** How they are kept out; see `detectSandbox`. */
    readonly sandbox?: Sandbox;
    /** Where brokered credentials for stdio servers are written (inside the denied state dir). */
    readonly credentialsDir?: string;
    /**
     * Brokered values ride in the server's own environment (as the launcher's prefixed variables)
     * instead of a credentials file: a Cloud computer, where only the runtime's MCP hub starts those
     * servers, in the tools container, which cannot read the state dir, and no value may touch the volume.
     */
    readonly brokeredInEnv?: boolean;
    /**
     * A Cloud computer whose person's credentials stay outside it (credentialRule.ts): a key a server declares that is
     * not here cannot be brought in (credential.grant is refused there), and a server started without its key only
     * fails where the person cannot see why. Such a server is left out of the chat, never started; its row in the
     * list of servers says why (personal.ts keyStaysOnMac).
     */
    readonly keysStayOutside?: boolean;
    /** Plugin ids whose hooks run; absent: every plugin's. */
    readonly trusted?: ReadonlyArray<string>;
  } = {},
) {
  const broker = yield* CredentialBroker;
  const allowlist = [
    ...new Set([...BASE_ENV_ALLOWLIST, ...(options.envAllowlist ?? []).filter((n) => ENV_NAME.test(n))]),
  ];
  const contain = {
    ...(options.contain ?? { deny: [], read: [] }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  };
  const worktreeWrite =
    contain.write === undefined || options.worktree === undefined ? {} : { write: [...contain.write, options.worktree] };
  const serverPolicy: LaunchPolicy = { keep: allowlist, ...contain, ...worktreeWrite };
  // Baked into the Claude Agent plugin copy. Worktree chats share it: the launcher opens their worktree from
  // CLAUDE_PROJECT_DIR, which it trusts only inside `worktrees`. A chat elsewhere (a plain folder, a Cloud
  // computer's workspace) names its own, so its copy is its own.
  const inWorktrees =
    options.worktree !== undefined &&
    contain.worktrees !== undefined &&
    path.resolve(options.worktree).startsWith(path.resolve(contain.worktrees) + path.sep);
  const hookPolicy: LaunchPolicy = { keep: [...allowlist, ...HOOK_ENV], ...contain, ...(inWorktrees ? {} : worktreeWrite) };
  const ambient = (name: string) =>
    allowlist.includes(name) && process.env[name] !== undefined
      ? Option.some<Resolved>({ value: process.env[name]!, brokered: false })
      : Option.none<Resolved>();

  const mcpServers: Record<string, PluginMcpServer> = {};
  const hooks: BundleHook[] = [];
  const reserved: Array<string> = [];
  // A server we cannot sign in to yet (no registered client for the service) reaches no engine, nor one keyed like the
  // runtime's own.
  const keys = serverKeys(plugins, (plugin, server, key) => reserved.push(`${plugin.id}'s server ${server} is left out: its key ${key} is reserved by Caveman Code`));
  for (const message of reserved) yield* Effect.logWarning(message);
  for (const [key, { plugin, server }] of keys) {
    const config = plugin.mcpServers[server]!;
    const destination = withRoot("url" in config ? config.url : config.command, plugin.root);
    const declared = declaredCredentials(plugin, server);
    // Only a name a connector declares is asked of the broker; anything else stays unset.
    const lookup = (name: string): Effect.Effect<Option.Option<Resolved>> =>
      Option.isSome(ambient(name))
        ? Effect.succeed(ambient(name))
        : !declared.has(name)
          ? Effect.succeed(Option.none())
          : broker
              .resolve({ plugin: plugin.id, space: plugin.origin, server, destination, name })
              .pipe(Effect.map(Option.map((value) => ({ value: Redacted.value(value), brokered: true }))));
    const credentialFile = (values: Readonly<Record<string, string>>) => {
      const dir = options.credentialsDir;
      if (dir === undefined) {
        return Effect.die(new Error(`${plugin.id}: brokered credentials need a credentials directory`));
      }
      // A write failure (EACCES, ENOSPC) is a typed failure so the session can fall back
      // to running without plugins, not a defect that crashes it.
      return Effect.tryPromise({
        try: () => writeCredentialFile(credentialFilesFor(dir, plugin), `${plugin.id}\0${server}`, values),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
    };
    if (options.keysStayOutside === true) {
      const missing = yield* Effect.filter([...declared], (name) => Effect.map(lookup(name), Option.isNone));
      if (missing.length > 0) {
        yield* Effect.logInfo(`${plugin.id}'s server ${server} is left out here: it needs ${missing.join(", ")}, which stays outside this computer`);
        continue;
      }
    }
    mcpServers[key] = yield* resolveServer(config, plugin.root, serverPolicy, lookup, options.brokeredInEnv === true ? undefined : credentialFile);
  }
  for (const plugin of plugins) {
    // Hooks run code at every matching event: only a plugin the user trusts keeps them.
    const hooksKept = options.trusted === undefined || options.trusted.includes(plugin.id);
    for (const [event, matchers] of hooksKept ? Object.entries(plugin.hooks) : []) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          let missing: PosixShellMissingError | undefined;
          const contained = withShell(() => containHook(hook, plugin.root, hookPolicy), (error) => (missing = error));
          if (missing) yield* Effect.logWarning(`A ${event} hook of ${plugin.id} is left out: ${missing.message}`);
          if (contained === undefined) continue;
          hooks.push({
            plugin: plugin.id,
            event,
            ...(matcher.matcher === undefined ? {} : { matcher: matcher.matcher }),
            hook: contained,
          });
        }
      }
    }
  }
  // An item's frontmatter hooks are the loader's, uncontained: only the Claude Agent copy runs them, contained.
  const items = (pick: (p: LoadedPlugin) => ReadonlyArray<PluginItem>) =>
    plugins.flatMap((plugin) => pick(plugin).map(({ hooks: _hooks, ...item }) => ({ ...item, plugin: plugin.id })));
  return {
    plugins: plugins.map(({ id, root }) => ({ id, root })),
    skills: items((p) => p.skills),
    commands: items((p) => p.commands),
    agents: items((p) => p.agents),
    hooks,
    mcpServers,
    rules: plugins.flatMap((plugin) =>
      plugin.rules.map(({ name, text }) => ({ plugin: plugin.id, name, text })),
    ),
    hookPolicy,
    ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
  } satisfies PluginBundle;
});

const resolveServer = Effect.fn("plugins.resolveServer")(function* (
  config: McpServerConfig,
  root: string,
  policy: LaunchPolicy,
  lookup: (name: string) => Effect.Effect<Option.Option<Resolved>>,
  credentialFile: ((values: Readonly<Record<string, string>>) => Effect.Effect<string, Error>) | undefined,
) {
  const resolveMap = Effect.fn(function* (map: Readonly<Record<string, string>> | undefined) {
    const out: Record<string, Resolved> = {};
    for (const [key, value] of Object.entries(map ?? {})) {
      const resolved = yield* expand(withRoot(value, root), lookup);
      // A credential the broker did not grant leaves the variable unset.
      if (Option.isSome(resolved)) out[key] = resolved.value;
    }
    return out;
  });
  const values = (map: Readonly<Record<string, Resolved>>) =>
    Object.fromEntries(Object.entries(map).map(([key, { value }]) => [key, value]));
  if ("url" in config) {
    // The engine makes the request, so a remote server's credentials ride in its headers.
    return {
      type: config.type,
      url: withRoot(config.url, root),
      headers: values(yield* resolveMap(config.headers)),
    } satisfies PluginMcpServer;
  }
  const env = Object.entries(yield* resolveMap(config.env)).filter(([name]) => ENV_NAME.test(name));
  const secret = credentialFile === undefined ? [] : env.filter(([, { brokered }]) => brokered);
  const launchPolicy =
    secret.length === 0 ? policy : { ...policy, secrets: yield* credentialFile!(values(Object.fromEntries(secret))) };
  const [command, ...launcherArgs] = launcherArgv(launchPolicy, process.platform, false);
  return {
    type: "stdio",
    command: command!,
    // Only ${CLAUDE_PLUGIN_ROOT} is expanded in argv: argv is visible to every local process.
    args: [
      ...launcherArgs,
      withRoot(config.command, root),
      ...(config.args ?? []).map((arg) => withRoot(arg, root)),
    ],
    // Never the launcher's own environment: a plugin's NODE_OPTIONS would run inside it. Brokered
    // values are in the credentials file instead.
    env: {
      ...launcherEnvCleared(),
      ...Object.fromEntries(
        env.filter(([, { brokered }]) => !brokered || credentialFile === undefined).map(([name, { value }]) => [PLUGIN_ENV_PREFIX + name, value]),
      ),
    },
    ...(config.cwd === undefined ? {} : { cwd: withRoot(config.cwd, root) }),
  } satisfies PluginMcpServer;
});

/**
 * An LSP server as Claude reads it, started through the launcher. Undefined
 * when it references anything but the plugin root: Claude would expand
 * `${VAR}` from its own environment, which could hand an engine secret over.
 */
export function containLspServer(
  server: LspServer,
  root: string,
  policy: LaunchPolicy,
): Record<string, unknown> | undefined {
  const { command, args, env, ...rest } = server;
  const launcher = launcherArgv(policy, process.platform, false);
  const contained = {
    ...rest,
    command: launcher[0]!,
    args: [...launcher.slice(1), withRoot(command, root), ...(args ?? []).map((a) => withRoot(a, root))],
    env: {
      ...launcherEnvCleared(),
      ...Object.fromEntries(
        Object.entries(env ?? {})
          .filter(([name]) => ENV_NAME.test(name))
          .map(([name, value]) => [PLUGIN_ENV_PREFIX + name, withRoot(value, root)]),
      ),
    },
  };
  const text = JSON.stringify({ ...rest, command, args, env });
  return withRoot(text, root).includes("${") ? undefined : contained;
}

/**
 * A monitor as Claude reads it, its shell command started through the launcher.
 * Undefined when the command references anything but the plugin root: Claude
 * substitutes `${ENV_VAR}` (and `${user_config.*}`) from its own environment
 * before the shell runs, which would hand an engine secret to the command and
 * can break out of the launcher's quoting. Matches `containLspServer`.
 */
export function containMonitor(monitor: Monitor, root: string, policy: LaunchPolicy): Record<string, unknown> | undefined {
  const command = withRoot(monitor.command, shellPath(root));
  if (command.includes("${")) return undefined;
  return { ...monitor, command: [...launcherArgv(policy), hookShell(), "-c", command].map(shellQuote).join(" ") };
}

/** A plugin's monitors as the Claude Agent copy offers them: contained, minus refused ones, by name. */
export function monitorsOffered(
  plugin: Pick<LoadedPlugin, "monitors" | "root">,
  policy: LaunchPolicy,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const monitor of plugin.monitors) {
    const contained = withShell(() => containMonitor(monitor, plugin.root, policy));
    if (contained !== undefined) out[monitor.name] = contained;
  }
  return out;
}

// ------------------------------------------------------------ projections

/** Every plugin's rules together are at most this many bytes in a prompt; the plugins after that are left out. */
export const MAX_ALL_RULES_BYTES = 64 * 1024;

/** Rules as always-on instructions; skills only by name and description until used. */
export function bundleInstructions(
  bundle: PluginBundle,
  options: { readonly skillsIndex: boolean },
): string {
  const parts: string[] = [];
  // Each plugin's rules under its own name (a plugin is not the team), and at most MAX_ALL_RULES_BYTES in all.
  let bytes = 0;
  for (const id of [...new Set(bundle.rules.map((rule) => rule.plugin))]) {
    const text = [`# Plugin rules from ${id}`, ...bundle.rules.filter((rule) => rule.plugin === id).map((rule) => `## ${rule.name}\n\n${rule.text.trim()}`)].join("\n\n");
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_ALL_RULES_BYTES) break;
    parts.push(text);
  }
  if (options.skillsIndex && bundle.skills.length > 0) {
    parts.push(
      "# Skills",
      "Before a task a skill covers, read its SKILL.md and follow it.",
      bundle.skills.map((s) => `- ${s.name}: ${s.description} (${s.path})`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

const inside = (dir: string, file: string) => file === dir || file.startsWith(dir + path.sep);

/**
 * Claude registers hooks from skill, command and agent frontmatter too, from any block its own match finds
 * (findFrontmatter). Returns the file with a block that could hold hooks written again from what Claude reads in it:
 * its hooks replaced by `hooks` contained (an item's, as the loader kept them, of a trusted plugin) or left out, and
 * no merge key to bring them back; with the block emptied when it reads as no table. Undefined when no block could.
 */
function containFrontmatterHooks(text: string, root: string, policy: LaunchPolicy, hooks: Hooks | undefined): string | undefined {
  const found = findFrontmatter(text);
  // Claude's parser makes a `hooks` key only of that word, written out or escaped (`"\x68ooks"`).
  if (found === undefined || !/hooks|\\/.test(found.block)) return undefined;
  // Emptied, not removed: Claude would read a block at the head of the body as the frontmatter instead.
  const emptied = `---\n---\n${found.body}`;
  const value = found.parsed?.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptied;
  // Bun merges a quoted `<<` too, which our YAML reading keeps as a key.
  const { hooks: _hooks, "<<": _merge, ...rest } = value as Record<string, unknown>;
  const kept = hooks === undefined ? rest : { ...rest, hooks: containHooks(hooks, root, policy) };
  try {
    // JSON, which Claude's YAML reads as written, with no `---` left in it to end the block early.
    return `---\n${JSON.stringify(kept, null, 2).replaceAll("---", "\\u002d\\u002d\\u002d")}\n---\n${found.body}`;
  } catch {
    // An alias inside its own anchor loops: no JSON holds it.
    return emptied;
  }
}

/** Each plugin copy's treeStamp when its digest last matched (projectForClaudeAgent). */
// FSEvents hands a new watch the events of the moment before it (1-14 ms measured, 250 to spare under load).
const COPY_WATCH_DELAY_MS = 250;
const checkedCopies = new Map<string, string>();

/** A copy no session was handed for this long is removed once another is made: no turn runs as long. */
const COPY_KEPT_MS = 24 * 60 * 60 * 1000;
/** How often a copy in use has its `.stamp` touched: the time a runtime that starts again reads as its last use. */
const COPY_TOUCH_MS = 60 * 60 * 1000;
/** When this runtime last handed each copy to a session. */
const handedOut = new Map<string, number>();
/** A projection directory's sweep, while it picks and moves aside old copies. */
const sweeps = new Map<string, Promise<void>>();

/**
 * Removes every copy under `dir` no session was handed for COPY_KEPT_MS, with its digest and stamp: a plugin read in
 * place gets a copy per edit, a checkout one per commit, and each launch policy or trust its own. One is first moved
 * aside, so no session is handed it half removed, and removed after the sweep.
 */
function sweepCopies(dir: string): void {
  if (sweeps.has(dir)) return;
  const aside: Array<string> = [];
  const sweep = (async () => {
    const now = Date.now();
    const entries = await fs.readdir(dir).catch(() => [] as Array<string>);
    for (const base of new Set(entries.map((entry) => entry.replace(/\.(?:sha256|stamp)$/, "")))) {
      const copy = path.join(dir, base);
      // Last handed out when its stamp was last touched; one with no stamp (made before stamps, or never finished) by
      // its own time.
      const used = await fs
        .stat(`${copy}.stamp`)
        .catch(() => fs.stat(copy))
        .catch(() => fs.stat(`${copy}.sha256`))
        .then((stat) => stat.mtimeMs, () => now);
      // One this runtime handed out within the day is kept whatever its stamp says.
      if (now - used < COPY_KEPT_MS || now - (handedOut.get(copy) ?? 0) < COPY_KEPT_MS) continue;
      if (base.includes(".old-")) aside.push(copy);
      else {
        const moved = `${copy}.old-${randomUUID()}`;
        // Gone already (a digest or stamp alone), or moved; one that cannot be moved (open on Windows) waits for the next sweep.
        const gone = await fs.rename(copy, moved).then(
          () => (aside.push(moved), true),
          (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
        if (!gone) continue;
      }
      checkedCopies.delete(copy);
      handedOut.delete(copy);
      await fs.rm(`${copy}.stamp`, { force: true }).catch(() => undefined);
      await fs.rm(`${copy}.sha256`, { force: true }).catch(() => undefined);
    }
  })().then(
    () => undefined,
    () => undefined,
  );
  sweeps.set(
    dir,
    sweep.finally(() => {
      sweeps.delete(dir);
      void (async () => {
        for (const old of aside) await fs.rm(old, { recursive: true, force: true }).catch(() => undefined);
      })();
    }),
  );
}

/**
 * Claude loads skills, commands, agents and hooks from a plugin directory. It
 * gets a copy of each plugin, made once per state of its files (a checkout, or
 * the stat stamp of one read in place) and launch policy under
 * `projectionDir`, with hooks (hooks.json and skill or command frontmatter)
 * rewritten to go through the launcher and the plugin's own MCP config
 * removed (the runtime passes the contained servers). LSP servers and
 * monitors start through the launcher too; an LSP server that references
 * anything but the plugin root is left out (`lspServersOffered`). The copy
 * holds no symlinks: one to a file inside the plugin becomes that file, any
 * other is left out. Like a space checkout, a copy is hashed when it is made
 * (`<copy>.sha256` beside it) and re-hashed when it is reused with a stat
 * stamp unlike the one it last matched with (taken again once a watch saw it
 * change); one that changed on disk, or has no digest, is made again. A
 * copy no session was handed for a day is removed when another is made.
 */
export async function projectForClaudeAgent(
  bundle: PluginBundle,
  plugins: ReadonlyArray<LoadedPlugin>,
  projectionDir: string,
): Promise<ClaudeAgentPluginOptions> {
  const dirs: string[] = [];
  for (const plugin of plugins) {
    const hooks: Record<string, Array<{ matcher?: string; hooks: Array<Readonly<Record<string, unknown>>> }>> = {};
    for (const { plugin: id, event, matcher, hook } of bundle.hooks) {
      if (id !== plugin.id) continue;
      (hooks[event] ??= []).push({ ...(matcher === undefined ? {} : { matcher }), hooks: [hook] });
    }
    const hooksJson = JSON.stringify({ hooks }, null, 2);
    const trusted = bundle.trusted === undefined || bundle.trusted.includes(plugin.id);
    // A plugin read in place (a folder marketplace, the repository's own) changes under the same root: a copy is made
    // per state of its files, as a checkout is per commit.
    const source = await watchedTreeStamp(plugin.root);
    // No copy is picked while a sweep is choosing which to remove; once picked, none removes it (handedOut).
    for (let sweep = sweeps.get(projectionDir); sweep !== undefined; sweep = sweeps.get(projectionDir)) await sweep;
    // Bump the leading version when the copy's contents change.
    const key = createHash("sha256")
      .update(`8\0${plugin.root}\0${source}\0${JSON.stringify(bundle.hookPolicy)}\0${hooksJson}\0${trusted}`)
      .digest("hex")
      .slice(0, 16);
    const target = path.join(projectionDir, `${plugin.name}-${key}`);
    const lastHanded = handedOut.get(target);
    handedOut.set(target, Date.now());
    const digestFile = `${target}.sha256`;
    // The stamp the copy last matched its digest with, kept beside the digest: a runtime that starts again reads
    // it instead of hashing every copy once more for its first session.
    const stampFile = `${target}.stamp`;
    if (await fs.stat(target).then(() => true, () => false)) {
      // Re-hashed only when its stat stamp moved since it was last checked; every turn reads these, so the stamp is
      // taken again only after its watch saw a change (watchedTreeStamp).
      const stamp = await watchedTreeStamp(target);
      if (checkedCopies.get(target) !== stamp) {
        if ((await fs.readFile(stampFile, "utf8").catch(() => "")) === stamp) checkedCopies.set(target, stamp);
        else {
          const want = await fs.readFile(digestFile, "utf8").catch(() => "");
          if (want === "" || (await treeDigest(target)) !== want.trim()) await fs.rm(target, { recursive: true, force: true });
          else {
            checkedCopies.set(target, stamp);
            await fs.writeFile(stampFile, stamp).catch(() => undefined);
          }
        }
      }
    }
    if (!(await fs.stat(target).then(() => true, () => false))) {
      // Two sessions can copy the same plugin in the same millisecond: each into its own folder, the first rename wins.
      const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await fs.cp(plugin.root, tmp, {
          recursive: true,
          dereference: true,
          filter: async (src) => {
            if (!(await fs.lstat(src)).isSymbolicLink()) return true;
            const real = await fs.realpath(src).catch(() => undefined);
            return real !== undefined && inside(plugin.root, real) && (await fs.stat(real)).isFile();
          },
        });
        const realTmp = await fs.realpath(tmp);
        const {
          hooks: _hooks,
          mcpServers: _mcp,
          lspServers: _lsp,
          monitors: _monitors,
          contributes: _contributes,
          // Read for the marketplace only (not Claude plugin.json fields).
          interface: _interface,
          category: _category,
          ...manifest
        } = plugin.manifest;
        // The copied files are read-only; replace rather than overwrite.
        const replace = async (file: string, text: string | undefined) => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          if (!inside(realTmp, await fs.realpath(path.dirname(file)))) {
            throw new Error(`${path.relative(tmp, file)} leads outside the plugin copy`);
          }
          await fs.rm(file, { force: true });
          if (text !== undefined) await fs.writeFile(file, text);
        };
        await replace(path.join(tmp, ".mcp.json"), undefined);
        // Claude starts LSP servers and monitors from a plugin too: only contained ones are offered.
        const lsp = lspServersOffered(plugin, bundle.hookPolicy);
        await replace(
          path.join(tmp, ".lsp.json"),
          Object.keys(lsp).length === 0 ? undefined : JSON.stringify(lsp, null, 2),
        );
        const monitors = Object.values(monitorsOffered(plugin, bundle.hookPolicy));
        await replace(
          path.join(tmp, "monitors/monitors.json"),
          monitors.length === 0 ? undefined : JSON.stringify(monitors, null, 2),
        );
        await replace(path.join(tmp, ".claude-plugin/plugin.json"), JSON.stringify(manifest, null, 2));
        await replace(path.join(tmp, "hooks/hooks.json"), hooksJson);
        // Frontmatter hooks run only as the loader kept them, by the item's real path (one through a link out of the
        // plugin is left out there), and only for a trusted plugin; any other file's are left out.
        const itemHooks = new Map(
          trusted ? [...plugin.skills, ...plugin.commands, ...plugin.agents].flatMap((item) => (item.hooks === undefined ? [] : [[item.path, item.hooks] as const])) : [],
        );
        for (const entry of await fs.readdir(tmp, { recursive: true, withFileTypes: true })) {
          // Claude reads `x.MD` as markdown too, on any filesystem.
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
          const file = path.join(entry.parentPath, entry.name);
          const real = itemHooks.size === 0 ? undefined : await fs.realpath(path.join(plugin.root, path.relative(tmp, file))).catch(() => undefined);
          const text = containFrontmatterHooks(await fs.readFile(file, "utf8"), plugin.root, bundle.hookPolicy, real === undefined ? undefined : itemHooks.get(real));
          if (text !== undefined) await replace(file, text);
        }
        // The digest lands before the copy, so a copy in place always has one; its stamp as made too (moving the
        // folder moves no entry's times), so the next session checks it without hashing it.
        await fs.writeFile(digestFile, `${await treeDigest(tmp)}\n`);
        const made = await treeStamp(tmp);
        await fs.writeFile(stampFile, made);
        await fs.rename(tmp, target);
        // Watched a moment later: a watch opened at once hears the rename that just made the copy and drops its stamp,
        // so the next session (often the turn right after the start that made it) would walk it again.
        setTimeout(() => {
          watchedTreeStamp(target).then(
            (stamp) => void (stamp === made && checkedCopies.set(target, stamp)),
            () => undefined,
          );
        }, COPY_WATCH_DELAY_MS).unref();
        sweepCopies(projectionDir);
      } catch (cause) {
        await fs.rm(tmp, { recursive: true, force: true });
        if (!(await fs.stat(target).then(() => true, () => false))) throw cause;
      }
    }
    if (lastHanded === undefined || Date.now() - lastHanded > COPY_TOUCH_MS) {
      const now = new Date();
      await fs.utimes(stampFile, now, now).catch(() => undefined);
    }
    dirs.push(target);
  }
  return {
    plugins: dirs.map((dir) => ({ type: "local", path: dir, skipMcpDiscovery: true })),
    mcpServers: bundle.mcpServers,
    settingSources: ["user", "project", "local"],
    appendSystemPrompt: bundleInstructions(bundle, { skillsIndex: false }),
  };
}

/** A plugin's LSP servers as the Claude Agent copy offers them: contained, minus refused ones. */
export function lspServersOffered(
  plugin: Pick<LoadedPlugin, "lspServers" | "root">,
  policy: LaunchPolicy,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(plugin.lspServers)) {
    const contained = containLspServer(server, plugin.root, policy);
    if (contained !== undefined) out[name] = contained;
  }
  return out;
}

/**
 * Codex gets the MCP servers (streamable HTTP and stdio; Codex has no SSE),
 * the rules plus a skills index as developer instructions, and the skills
 * themselves for a turn that mentions one (CodexAdapterV2). Plugin hooks,
 * commands and agents have no Codex equivalent and are left out.
 */
export function projectForCodex(bundle: PluginBundle): CodexPluginOptions {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(bundle.mcpServers)) {
    if (server.type === "stdio") {
      servers[name] = {
        command: server.command,
        args: server.args,
        env: server.env,
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      };
    } else if (server.type === "http") {
      servers[name] = { url: server.url, http_headers: server.headers };
    }
  }
  return {
    config: { mcp_servers: servers },
    developerInstructions: bundleInstructions(bundle, { skillsIndex: true }),
    ...(bundle.skills.length === 0 ? {} : { skills: bundle.skills.map((skill) => ({ name: skill.name, path: skill.path })) }),
  };
}

/**
 * The Caveman engine gets the MCP servers (stdio and streamable HTTP; its MCP
 * client has no SSE), the skills' directories for its agent environment, and
 * its instructions as composed (instructions/EngineInstructions.ts). Plugin
 * hooks, commands and agents are left out.
 */
export function projectForCaveman(
  bundle: PluginBundle,
  instructionSections: CavemanPluginOptions["instructionSections"],
): CavemanPluginOptions {
  return {
    mcpServers: Object.fromEntries(Object.entries(bundle.mcpServers).filter(([, server]) => server.type !== "sse")),
    skillRoots: [...new Set(bundle.skills.map((skill) => path.dirname(path.dirname(skill.path))))],
    instructionSections,
  };
}

export function projectForAcp(bundle: PluginBundle): ReadonlyArray<AcpPluginMcpServer> {
  const pairs = (map: Readonly<Record<string, string>>) =>
    Object.entries(map).map(([name, value]) => ({ name, value }));
  return Object.entries(bundle.mcpServers).map(([name, server]) =>
    server.type === "stdio"
      ? { type: "stdio", name, command: server.command, args: server.args, env: pairs(server.env) }
      : { type: server.type, name, url: server.url, headers: pairs(server.headers) },
  );
}
