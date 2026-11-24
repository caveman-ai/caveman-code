// What happens on a workspace's disk on This Mac: the worktree on branch
// caveman/<slug>, its ports, copy-on-write caches and [setup].run, the
// [archive].run before removal, and the work-in-progress ref a park pushes.
// Git goes through upstream GitVcsDriver (the ported process runner). On a Cloud
// computer scripts and temporary indexes live in the tools container too
// (cloudLink/tools.ts): the checkout is the agent's.
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { signalProcessGroup } from "@caveman-app/engine-core/server/processGroup";
import { type PosixShellCommand, posixShellCommand } from "@caveman-app/shared/posixShell";

import * as Effect from "effect/Effect";

import { gitEnv, isPlumbing, toolsIndex, toolsRun, toolsSocket, toolsStart } from "../cloudLink/tools.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  CONFIG_PATH,
  SNAPSHOT_MARKER_PATH,
  parseComputerConfig,
  type ComputerConfig,
} from "./computerConfig.ts";

type Git = GitVcsDriver.GitVcsDriver["Service"];

export class LifecycleError extends Error {}

/**
 * The runtime's own git in `cwd`. It never waits on this machine's resolver: every command but a person's `git commit`
 * carries the email git falls back to where nobody set an identity (cloudLink/tools.ts gitEnv), so a reflog entry it
 * writes (a fetch, a checkout, a worktree) makes git guess none from the hostname. An identity the command sets, and
 * the person's own in any config, come first as before.
 */
export const git = (
  driver: Git,
  cwd: string,
  args: ReadonlyArray<string>,
  /** `maxOutputBytes`: stdout past it is cut (the result's `stdoutTruncated`), not failed; 32 MiB unless given. */
  options: { allowNonZeroExit?: boolean; env?: NodeJS.ProcessEnv; stdin?: string; maxOutputBytes?: number } = {},
) => {
  const env = isPlumbing(args) ? gitEnv(options.env) : options.env;
  return driver
    .execute({
      operation: `session-protocol.${args[0]}`,
      cwd,
      args,
      ...(options.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
      ...(env ? { env } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      maxOutputBytes: options.maxOutputBytes ?? 32 * 1024 * 1024,
    })
    .pipe(Effect.mapError((error) => new LifecycleError(error.message)));
};

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";

/** What a Cloud build leaves at each clone's root (.caveman/snapshot.json, git-excluded): its commit, when, and the setup it built. */
export interface SnapshotMarker {
  readonly commit?: unknown;
  /** The branch the build cloned ("HEAD" when it had none). */
  readonly branch?: unknown;
  readonly built_at?: unknown;
  /** The resolved computer.toml text the build ran: the repo's file, or the organization's Cloud copy. */
  readonly config?: unknown;
  /**
   * `{ postgres: "<database>" }` when the build's setup ran against the computer's Postgres: the database it filled,
   * which each workspace's own starts as a copy of (workspaceIsolation.ts). Older markers have none.
   */
  readonly seed?: unknown;
}

/** The snapshot marker at a worktree; undefined when there is none or it doesn't parse. */
export function readSnapshotMarker(root: string): SnapshotMarker | undefined {
  try {
    const marker: unknown = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT_MARKER_PATH), "utf8"));
    return typeof marker === "object" && marker !== null ? (marker as SnapshotMarker) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The checkout a linked worktree is one of: the clone's root, where a Cloud build left its marker and what setup
 * installed. Read from the worktree's `.git` file and the `commondir` git keeps beside what it names. Undefined for
 * a checkout that is its own root (its `.git` is a folder), a submodule, or a folder that is no checkout.
 */
export function cloneRootOf(worktree: string): string | undefined {
  try {
    const pointer = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(worktree, ".git"), "utf8"))?.[1]?.trim();
    if (pointer === undefined) return undefined;
    const gitDir = path.resolve(worktree, pointer);
    const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    return path.basename(common) === ".git" ? path.dirname(common) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the setup at a worktree: .caveman/computer.toml, else the setup the snapshot it booted from was built
 * with (the Cloud copy, for a repo without the file); null when there is neither. The build's marker is at the
 * clone's root and git-excluded, so a worktree of that clone reads the root's. Throws with the line on bad keys.
 */
export function readComputerConfig(root: string): ComputerConfig | null {
  const file = path.join(root, CONFIG_PATH);
  if (fs.existsSync(file)) return parseComputerConfig(fs.readFileSync(file, "utf8"));
  let marker = readSnapshotMarker(root);
  if (marker === undefined) {
    const clone = cloneRootOf(root);
    if (clone !== undefined) marker = readSnapshotMarker(clone);
  }
  const built = marker?.config;
  return typeof built === "string" ? parseComputerConfig(built) : null;
}

/** The parts of a setup a snapshot's identity covers (Cloud's snapshots.Identity): [setup] but its checks, [computer], [env], [services], [system]. */
export const setupIdentity = (config: ComputerConfig) => {
  const sorted = (table: Record<string, string>) => Object.fromEntries(Object.entries(table).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const { run = [], cache = [], inputs = [] } = config.setup;
  return JSON.stringify([run, cache, inputs, config.computer.size ?? "", sorted(config.env), sorted(config.services), config.system.packages ?? []]);
};

// ponytail: one fixed range per runtime; make it a setting when two runtimes share a machine.
export const PORT_RANGE = { from: 42100, to: 42999 } as const;

const portIsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

/** Picks a free port per name from PORT_RANGE, skipping `taken` and ports something already listens on. */
export async function pickPorts(names: ReadonlyArray<string>, taken: ReadonlySet<number>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let port = PORT_RANGE.from;
  for (const name of names) {
    while (port <= PORT_RANGE.to && (taken.has(port) || !(await portIsFree(port)))) port++;
    if (port > PORT_RANGE.to) throw new LifecycleError("no free port left in the runtime's range");
    out[name] = port++;
  }
  return out;
}

/** How a [setup].cache path reaches a new worktree, in the order cloneCaches tries them. */
export type CacheMethod = "clone" | "link";
export const CACHE_METHODS: ReadonlyArray<CacheMethod> = ["clone", "link"];

/** The [setup].cache paths cloneCaches brought into a worktree, by how each arrived. */
export interface BroughtCaches {
  readonly cloned: ReadonlyArray<string>;
  readonly linked: ReadonlyArray<string>;
}

/** How the caches arrived, for the note after setup; undefined when none did. */
export const broughtCachesNote = (caches: BroughtCaches): string | undefined =>
  [
    ...(caches.cloned.length > 0 ? [`Cloned from the first checkout: ${caches.cloned.join(", ")}`] : []),
    ...(caches.linked.length > 0 ? [`Hard-linked from the first checkout: ${caches.linked.join(", ")}`] : []),
  ].join("\n") || undefined;

/**
 * The only cache paths hard links may bring: a `node_modules` folder. No package manager edits an installed file: npm
 * unpacks a package into a fresh folder, and pnpm and Bun hard link each file from a store every project on the disk
 * already shares. Any other cache (.turbo, .next, target, .venv) is written in place by its tool, and through a hard
 * link that write would change the other worktree's file too. So would a tool that edits an installed package in
 * place (patch-package), as it already does to every project through pnpm's store.
 */
const hardLinkable = (entry: string) => entry.split(/[\\/]/).filter((part) => part !== "").at(-1) === "node_modules";

/**
 * Brings the cache path `$1` of the first checkout to `$2` by the first method in `$3` that works, and prints which.
 * POSIX sh: the same text runs here and in a Cloud computer's tools container. Every folder it makes is the
 * worktree's own, never a link to the first checkout's. A clone is the whole path. Hard links (hardLinkable) cover
 * the packages only: every name at the top of node_modules that does not start with a dot, and pnpm's .pnpm, which
 * holds its packages. The other dot names there are the package manager's and tools' own files, some rewritten in
 * place (npm's .package-lock.json, Prisma's .prisma): those are copied, and .cache is left for its tools to rebuild.
 */
const BRING_CACHE = `
from=$1 to=$2
# A link in the first checkout is not followed: the worktree would share the folder it points at.
if [ ! -e "$from" ] || [ -L "$from" ] || [ -e "$to" ] || [ -L "$to" ]; then exit 0; fi
mkdir -p -- "$(dirname -- "$to")" || exit 0
case $(uname -s) in Darwin) cow="cp -c" ;; *) cow="cp --reflink=always" ;; esac
if [ ! -d "$from" ]; then
  # A single file (a build info file) is only ever cloned.
  case " $3 " in *" clone "*) $cow -p -- "$from" "$to" 2>/dev/null && echo clone || rm -f -- "$to" ;; esac
  exit 0
fi
# One file before the tree: a disk that cannot clone or link says so once, not once per file.
first=$(find "$from" -type f | head -n 1)
probe() { [ -z "$first" ] || { "$@" "$first" "$to/.caveman-probe" && rm -f -- "$to/.caveman-probe"; }; }
clone() { probe $cow -- && $cow -R -P -p -- "$from"/. "$to"/; }
link() {
  probe ln -- && cd -- "$from" &&
    find . -mindepth 1 -maxdepth 1 \\( ! -name ".*" -o -name .pnpm \\) -exec sh -c 'exec cp -R -P -p -l -- "$@" "$0"/' "$to" {} + &&
    find . -mindepth 1 -maxdepth 1 -name ".*" ! -name .pnpm ! -name .cache -exec sh -c 'exec cp -R -P -p -- "$@" "$0"/' "$to" {} +
}
for how in $3; do
  # The folder is this script's from here: a method that fails takes what it wrote with it.
  mkdir -- "$to" || exit 0
  if ($how) >/dev/null 2>&1; then echo "$how"; exit 0; fi
  rm -rf -- "$to"
done
`;

/**
 * Whether files clone from `from` into the worktree. Asked on macOS only, whose `cp -c` quietly copies in full where
 * it cannot clone, and no command there says clone or fail (Node's forced clone is not implemented on macOS). A
 * clone needs both on one volume, and that volume to be APFS: the system volume's kind on every macOS this app runs on.
 */
const clonesOnMac = (from: string, worktree: string): boolean => {
  try {
    return fs.statSync(from).dev === fs.statSync(worktree).dev && fs.statfsSync(worktree).type === fs.statfsSync("/").type;
  } catch {
    return false;
  }
};

/**
 * Brings each [setup].cache path from the first checkout (`source`: the project's own on This Mac, the computer's on
 * a Cloud computer, where this runs in the tools container) into a new worktree, so its setup is an incremental
 * install and not a cold one. Per path, the first of `methods` that works: a copy-on-write clone (APFS clonefile,
 * a Linux reflink), which uses no disk until a file changes; else hard links, for a node_modules only (hardLinkable);
 * else nothing, and setup installs as it would have. Skips a path that is missing, a link, or already present, and
 * every path when the worktree is the first checkout itself. Windows has no cheap clone outside a Dev Drive and no
 * command for it: it brings nothing, never a full copy of node_modules. Never fails: setup runs either way.
 */
export async function cloneCaches(
  source: string,
  worktree: string,
  cache: ReadonlyArray<string>,
  methods: ReadonlyArray<CacheMethod> = CACHE_METHODS,
): Promise<BroughtCaches> {
  const cloned: string[] = [];
  const linked: string[] = [];
  if (process.platform === "win32" || path.resolve(source) === path.resolve(worktree)) return { cloned, linked };
  const tools = toolsSocket();
  for (const entry of cache) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) continue;
    const from = path.join(source, entry);
    const to = path.join(worktree, entry);
    const tried = methods.filter((how) => (how === "link" ? hardLinkable(entry) : tools !== undefined || process.platform !== "darwin" || clonesOnMac(from, worktree)));
    if (tried.length === 0) continue;
    const argv = ["/bin/sh", "-c", BRING_CACHE, "sh", from, to, tried.join(" ")];
    const how = await (tools !== undefined
      ? toolsRun(tools, worktree, argv).then((ran) => ran.stdout)
      : new Promise<string>((resolve) => execFile(argv[0]!, argv.slice(1), (error, stdout) => resolve(error === null ? stdout : "")))
    ).catch(() => "");
    if (how.trim() === "clone") cloned.push(entry);
    else if (how.trim() === "link") linked.push(entry);
  }
  return { cloned, linked };
}

export interface ScriptResult {
  readonly ok: boolean;
  readonly output: string;
  readonly failed?: string;
}

/**
 * Runs commands one after another in `cwd` with `env`; stops at the first failure. On a Cloud computer
 * they run in the tools container: the repo (or the agent) wrote them.
 */
export async function runScripts(commands: ReadonlyArray<string>, cwd: string, env: Record<string, string>): Promise<ScriptResult> {
  const tools = toolsSocket();
  let output = "";
  for (const command of commands) {
    const result =
      tools !== undefined
        ? await toolsRun(tools, cwd, ["/bin/sh", "-c", command], env).then((r) => ({ code: r.code, text: `${r.stdout}${r.stderr}` }))
        : await new Promise<{ code: number; text: string }>((resolve) => {
            let shell: PosixShellCommand;
            try {
              shell = posixShellCommand(command);
            } catch (error) {
              return resolve({ code: 127, text: `${(error as Error).message}\n` });
            }
            execFile(
              shell.command,
              [...shell.args],
              { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
              (error, stdout, stderr) =>
                resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, text: `${stdout}${stderr}` }),
            );
          });
    output += `$ ${command}\n${result.text}`;
    if (result.code !== 0) return { ok: false, output, failed: command };
  }
  return { ok: true, output };
}

/** A command the runtime started and left running (startScript). */
export interface StartedScript {
  /** Its end: its exit code (128 + n for a signal, 127 when it never started), and the last of what it wrote. */
  readonly done: Promise<{ readonly code: number; readonly output: string }>;
  /** Ends it and everything it started (its process group). */
  readonly stop: () => void;
}

/** The last of a started command's output that is kept, for the note when it fails. */
const STARTED_OUTPUT_TAIL = 4000;

/**
 * Starts `command` in `cwd` with `env` and leaves it running: a service or a dev server ([start].run, bootSteps.ts).
 * On a Cloud computer it runs in the tools container, as runScripts' do, and ends with the runtime (the channel
 * closes); here it is its own process group, ended whole by `stop`, which whoever started it calls when it stops.
 */
export function startScript(command: string, cwd: string, env: Record<string, string>): StartedScript {
  let output = "";
  const take = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-STARTED_OUTPUT_TAIL);
  };
  const tools = toolsSocket();
  if (tools !== undefined) {
    const run = toolsStart(tools, cwd, ["/bin/sh", "-c", command], env, take);
    return { done: run.done.then((end) => ({ code: end.code, output })), stop: run.stop };
  }
  let shell: PosixShellCommand;
  try {
    shell = posixShellCommand(command);
  } catch (error) {
    return { done: Promise.resolve({ code: 127, output: `${(error as Error).message}\n` }), stop: () => undefined };
  }
  // Its own process group: ended as a whole, and never a member of the runtime's.
  const child = spawn(shell.command, [...shell.args], { cwd, env: { ...process.env, ...env }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const done = new Promise<{ code: number; output: string }>((resolve) => {
    child.once("error", (error) => resolve({ code: 127, output: `${output}${error.message}\n` }));
    child.once("exit", (code, signal) => {
      const end = () => resolve({ code: code ?? 128 + (signal === null ? 0 : (os.constants.signals[signal] ?? 0)), output });
      // What it wrote last is read once its pipes close; something it left running may hold them open, so not for long.
      child.once("close", end);
      setTimeout(end, 200).unref();
    });
  });
  const signalAll = (signal: "SIGTERM" | "SIGKILL") => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else signalProcessGroup(child.pid, signal);
    } catch {
      // Nothing left in the group.
    }
  };
  return {
    done,
    stop: () => {
      signalAll("SIGTERM");
      // What ignores the first signal (a shell's children that trap it) goes two seconds later.
      setTimeout(() => signalAll("SIGKILL"), 2_000).unref();
    },
  };
}

/**
 * What setup watches when a config has no [setup].inputs key (docs/ D2): the
 * lockfiles, manifests and version pins the drafter reads at the repo's top level, and the dependency lockfiles
 * and manifests one directory down (backend/requirements.txt; a monorepo's apps/web is two down, under the root
 * lockfile). Git glob pathspecs: `*` never crosses a `/`. One absent at both commits is no change; one added or
 * removed since the build is. An explicit `inputs = []` watches nothing.
 *
 * Cloud's copy lives in Caveman Cloud Sandboxes (Caveman Cloud): a snapshot's identity uses the same list when
 * [setup].inputs is absent. The two must change together.
 */
export const DEFAULT_SETUP_INPUTS: ReadonlyArray<string> = [
  // JavaScript
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  // Python
  "pyproject.toml",
  "requirements*.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  // Go, Rust, Ruby, PHP, Elixir, Dart, .NET, Java
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "mix.exs",
  "mix.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "packages.lock.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.lockfile",
  // Version pins (top level only)
  ".nvmrc",
  ".node-version",
  ".bun-version",
  ".python-version",
  ".ruby-version",
  ".java-version",
  ".sdkmanrc",
  ".tool-versions",
  "mise.toml",
  ".mise.toml",
  ".config/mise.toml",
  "mise/config.toml",
  "rust-toolchain",
  "rust-toolchain.toml",
  // One directory down: dependency lockfiles and manifests (a backend/ or frontend/ beside the root)
  "*/package.json",
  "*/package-lock.json",
  "*/npm-shrinkwrap.json",
  "*/pnpm-lock.yaml",
  "*/yarn.lock",
  "*/bun.lock",
  "*/bun.lockb",
  "*/deno.lock",
  "*/pyproject.toml",
  "*/requirements*.txt",
  "*/Pipfile.lock",
  "*/poetry.lock",
  "*/uv.lock",
  "*/go.mod",
  "*/go.sum",
  "*/Cargo.toml",
  "*/Cargo.lock",
  "*/Gemfile",
  "*/Gemfile.lock",
  "*/composer.lock",
  "*/mix.lock",
  "*/pubspec.lock",
  "*/packages.lock.json",
  "*/gradle.lockfile",
];

/**
 * Whether [setup].run must run on this disk: never when the snapshot it booted
 * from was built with the same setup identity (setupIdentity: a changed check,
 * [run] or comment never reinstalls) at a commit whose [setup].inputs match
 * HEAD's; once when either differs, or the marker is missing or unreadable.
 * A config without the inputs key is compared on DEFAULT_SETUP_INPUTS, so a
 * changed lockfile still reinstalls; an explicit `inputs = []` watches nothing.
 * The setup it was built with is the marker's `config`, else (older builds)
 * computer.toml at its commit. Only a build's marker counts: the build
 * git-excludes it, so a committed one came with a plain checkout that has no caches.
 * `root`: the clone the worktree is a checkout of. Its marker decides for a
 * worktree that has none, against the worktree's HEAD, and the answer says so
 * (`root`): setup is baked into the computer, and the caller brings what it
 * installed from the root (cloneCaches, cachesMissing). No marker there
 * either (This Mac): setup runs, as before.
 */
export const setupDecision = (driver: Git, worktree: string, config: ComputerConfig, root?: string) =>
  Effect.gen(function* () {
    const decided = (decision: SetupDecision) => decision;
    // A worktree of a build's clone has no marker of its own (the build git-excludes it, so `git worktree add`
    // never brings it): the clone root's decides, against the worktree's own HEAD. One that has a marker file is
    // decided on that file, as a checkout that is its own root is.
    const at = root !== undefined && path.resolve(root) !== path.resolve(worktree) && !fs.existsSync(path.join(worktree, SNAPSHOT_MARKER_PATH)) ? root : worktree;
    const from = at === worktree ? {} : { root: true as const };
    const found = yield* buildMarker(driver, at);
    if (found === undefined) return decided({ run: true, marker: false });
    const { marker, commit } = found;
    if (commit === undefined) return decided({ run: true, marker: true, ...from });
    const builtText =
      typeof marker!.config === "string"
        ? marker!.config
        : (yield* git(driver, at, ["show", `${commit}:${CONFIG_PATH}`], { allowNonZeroExit: true }).pipe(Effect.map((r) => (r.exitCode === 0 ? r.stdout : ""))));
    const built = yield* Effect.try(() => parseComputerConfig(builtText)).pipe(Effect.orElseSucceed(() => undefined));
    if (built === undefined || setupIdentity(built) !== setupIdentity(config)) return decided({ run: true, marker: true, ...from });
    return decided({ run: yield* setupInputsChanged(driver, worktree, config, commit, "HEAD"), marker: true, ...from });
  });

/**
 * setupDecision's answer: whether [setup].run runs, and whether a build's marker was there to decide it. `root`: the
 * marker is the clone root's and the worktree is another checkout of that clone, so what the build installed is in
 * the root and reaches the worktree only as [setup].cache paths (cloneCaches).
 */
export interface SetupDecision {
  readonly run: boolean;
  readonly marker: boolean;
  readonly root?: true;
}

/**
 * A build's marker at a checkout, and the commit it names when that is a full SHA the repository has (short hex can
 * resolve to a branch of the same name). Undefined without a marker file, and for one git tracks: the build
 * git-excludes its own, so a committed one came with a plain checkout that nothing was installed in. A file that
 * does not parse fails.
 */
export const buildMarker = (driver: Git, checkout: string) =>
  Effect.gen(function* () {
    const markerFile = path.join(checkout, SNAPSHOT_MARKER_PATH);
    if (!fs.existsSync(markerFile)) return undefined;
    const tracked = yield* git(driver, checkout, ["ls-files", "--error-unmatch", "--", SNAPSHOT_MARKER_PATH], { allowNonZeroExit: true });
    if (tracked.exitCode === 0) return undefined;
    const marker = yield* Effect.try(() => JSON.parse(fs.readFileSync(markerFile, "utf8")) as SnapshotMarker | null);
    const commit = marker?.commit;
    if (typeof commit !== "string" || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return { marker };
    if ((yield* git(driver, checkout, ["cat-file", "-e", `${commit}^{commit}`], { allowNonZeroExit: true })).exitCode !== 0) return { marker };
    return { marker, commit };
  });

/**
 * The Postgres database a clone's build filled when its setup ran, as its marker names it (`seed.postgres`): what a
 * workspace's own database starts as a copy of (workspaceIsolation.ts). Undefined without a build's own marker
 * (buildMarker: a committed one names nothing) or without a seed in it.
 */
export const snapshotSeed = (driver: Git, root: string) =>
  buildMarker(driver, root).pipe(
    Effect.map((found) => {
      const seed = found?.marker?.seed;
      const name = typeof seed === "object" && seed !== null ? (seed as { readonly postgres?: unknown }).postgres : undefined;
      return typeof name === "string" ? name : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Whether what setup watches differs between two commits, as `checkout` names them: [setup].inputs, else the
 * defaults (DEFAULT_SETUP_INPUTS). An empty list is the person opting out: nothing is watched (and `git diff --`
 * with no paths would compare everything).
 */
export const setupInputsChanged = (driver: Git, checkout: string, config: ComputerConfig, from: string, to: string) =>
  Effect.gen(function* () {
    const listed = config.setup.inputs ?? DEFAULT_SETUP_INPUTS;
    if (listed.length === 0) return false;
    const inputs = listed.map((p) => `:(glob)${p}`);
    const diff = yield* git(driver, checkout, ["diff", "--quiet", from, to, "--", ...inputs], { allowNonZeroExit: true });
    return diff.exitCode !== 0;
  });

/**
 * The [setup].cache paths the clone root has that a worktree of it lacks, after cloneCaches: with any, the worktree
 * is not what the build left, and setup installs there. Paths cloneCaches never brings (absolute, or through `..`)
 * are left out.
 */
export const cachesMissing = (root: string, worktree: string, cache: ReadonlyArray<string>): ReadonlyArray<string> =>
  cache.filter((entry) => !path.isAbsolute(entry) && !entry.split(/[\\/]/).includes("..") && fs.existsSync(path.join(root, entry)) && !fs.existsSync(path.join(worktree, entry)));

/**
 * Where a chat's branch left its base, the point its changes are measured from: HEAD's merge base with the base as
 * its remote has it (where a chat starts) or with the local base branch, whichever is nearer HEAD. A local base that
 * fell behind GitHub or ran ahead of it (merged into, never pushed or pulled) then never counts other people's
 * commits as the chat's. The base itself when neither has one (an unborn branch, a detached base).
 */
export const forkPoint = (driver: Git, worktree: string, base: string) =>
  Effect.gen(function* () {
    if (base === "" || base === "HEAD" || base.startsWith("-")) return base;
    const remote = yield* driver.resolveWorktreeBaseRemote({ cwd: worktree, refName: base }).pipe(Effect.orElseSucceed(() => null));
    const refs = remote === null ? [base] : [`refs/remotes/${remote.remoteName}/${remote.branchName}`, base];
    let nearest: string | undefined;
    for (const ref of refs) {
      const found = yield* git(driver, worktree, ["merge-base", ref, "HEAD"], { allowNonZeroExit: true }).pipe(Effect.orElseSucceed(() => undefined));
      const sha = found?.exitCode === 0 ? found.stdout.trim() : "";
      if (sha === "") continue;
      if (nearest !== undefined && nearest !== sha) {
        const behind = yield* git(driver, worktree, ["merge-base", "--is-ancestor", nearest, sha], { allowNonZeroExit: true }).pipe(
          Effect.map((r) => r.exitCode === 0),
          Effect.orElseSucceed(() => false),
        );
        if (!behind) continue;
      }
      nearest = sha;
    }
    return nearest ?? base;
  });

/** A chat's changes: the working tree against where its branch left `base` (forkPoint). */
export const chatChanges = (driver: Git, worktree: string, base: string) =>
  forkPoint(driver, worktree, base).pipe(Effect.flatMap((from) => diffSummary(driver, worktree, from)));

/** Per-file summary of the working tree against `base` (tracked changes plus untracked files). */
export const diffSummary = (driver: Git, worktree: string, base: string) =>
  Effect.gen(function* () {
    const numstat = yield* git(driver, worktree, ["diff", "--numstat", "-z", "--no-renames", "--end-of-options", base, "--"]);
    const names = yield* git(driver, worktree, ["diff", "--name-status", "-z", "--no-renames", "--end-of-options", base, "--"]);
    const untracked = yield* git(driver, worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
    // ponytail: no rename detection; a rename shows as a delete plus an add.
    const statuses = new Map<string, "added" | "modified" | "deleted">();
    // -z keeps paths literal (no core.quotePath escaping), even with tabs or newlines.
    // --name-status -z separates both the status and path with NULs.
    const nameRecords = names.stdout.split("\0");
    for (let index = 0; index + 1 < nameRecords.length; index += 2) {
      const code = nameRecords[index];
      const file = nameRecords[index + 1]!;
      statuses.set(file, code === "A" ? "added" : code === "D" ? "deleted" : "modified");
    }
    const files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number }> = [];
    for (const line of numstat.stdout.split("\0").filter(Boolean)) {
      const [add, del, ...rest] = line.split("\t");
      const file = rest.join("\t");
      files.push({
        path: file,
        status: statuses.get(file) ?? "modified",
        additions: add === "-" ? 0 : Number(add),
        deletions: del === "-" ? 0 : Number(del),
      });
    }
    const untrackedFiles = untracked.stdout.split("\0").filter(Boolean);
    const attributes = untrackedFiles.length === 0 ? new Map<string, string>() : yield* diffAttributes(driver, worktree, untrackedFiles);
    for (const file of untrackedFiles) {
      const additions = yield* Effect.try({
        try: () => untrackedAdditions(path.join(worktree, file), attributes.get(file)),
        catch: (error) => new LifecycleError(`${file} could not be read: ${(error as Error).message}`),
      });
      if (additions !== undefined) files.push({ path: file, status: "added", additions, deletions: 0 });
    }
    return files;
  });

/** How far git looks for a NUL byte to call a file binary (xdiff's FIRST_FEW_BYTES). */
const BINARY_SNIFF_BYTES = 8000;

/** git's spellings of true for a boolean config value; a key with no value at all is true too. */
const GIT_TRUE = new Set(["true", "yes", "on", "1"]);

/**
 * Each path's `diff` attribute (.gitattributes, info/attributes, core.attributesFile), one `git check-attr` for all:
 * "unset" (`-diff`, `binary`, or a diff driver whose config says `binary = true`), "set" (`diff`), "unspecified", or
 * a diff driver's name.
 */
const diffAttributes = (driver: Git, worktree: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const read = yield* git(driver, worktree, ["check-attr", "-z", "--stdin", "diff"], { stdin: files.map((file) => `${file}\0`).join("") });
    const fields = read.stdout.split("\0");
    const attributes = new Map<string, string>();
    for (let at = 0; at + 2 < fields.length; at += 3) attributes.set(fields[at]!, fields[at + 2]!);
    if (![...attributes.values()].some((value) => value !== "set" && value !== "unset" && value !== "unspecified")) return attributes;
    // Exit 1 is "no such key"; -z writes `key\nvalue` and a bare `key` for one with no value.
    const config = yield* git(driver, worktree, ["config", "-z", "--get-regexp", "^diff\\..*\\.binary$"], { allowNonZeroExit: true });
    const binary = new Set<string>();
    for (const record of config.stdout.split("\0").filter(Boolean)) {
      const [key = "", value] = record.split("\n");
      if (value === undefined || GIT_TRUE.has(value.toLowerCase())) binary.add(key.slice("diff.".length, -".binary".length));
    }
    for (const [file, value] of attributes) if (binary.has(value)) attributes.set(file, "unset");
    return attributes;
  });

/**
 * Lines an untracked path adds, as git counts them: a link is its target's name, one line, never followed; a binary
 * file adds none, as numstat's "-". Its `diff` attribute decides first, as in git: unset is binary, set is text even
 * with a NUL; otherwise a NUL in its first 8000 bytes makes it binary. Anything but a regular file (a FIFO, a device)
 * adds none and is never read: a read could block the runtime's only thread for good. Opened without following a link
 * or waiting on a FIFO, in case one was swapped in after the lstat. Undefined once gone.
 */
const untrackedAdditions = (full: string, diff: string | undefined): number | undefined => {
  const entry = lstatOrGone(full);
  if (entry === undefined) return undefined;
  if (diff === "unset") return 0;
  if (entry.isSymbolicLink()) return 1;
  const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size >= 4 * 1024 * 1024) return 0;
    const bytes = fs.readFileSync(fd);
    if (bytes.length === 0 || (diff !== "set" && bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0))) return 0;
    let lines = bytes[bytes.length - 1] === 0x0a ? 0 : 1;
    for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, at + 1)) lines++;
    return lines;
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Secret-shaped files (decision 24): work in progress that leaves this computer never carries one git does not
 * ignore. Claude Code leaves the same names behind; files git ignores never travel at all. In either case (a Mac's
 * checkout ignores case: `Server.PEM` is one), and a folder so named with everything in it (`.env.d/`), as `git clean -e`
 * keeps the folder whole.
 */
export const SECRET_SHAPED: ReadonlyArray<string> = [".env*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*", "*.tfvars", "*.tfstate*"];
/**
 * Which secret-shaped files git does not ignore stay here when a snapshot leaves this computer (decision 24): `true`,
 * every one (This Mac: a tracked one goes at HEAD's version, a new one not at all); "untracked", only the ones HEAD does
 * not have (a Cloud computer: an agent's edit to a tracked `.env.example` goes with the chat, never lost with the
 * computer, and This Mac holds it for review); `false`, none (the snapshot stays here).
 */
export type SecretsLeave = boolean | "untracked";
/** In any directory, the root's included (`**` matches none too). */
const secretPathspecs = SECRET_SHAPED.flatMap((glob) => [`:(glob,icase)**/${glob}`, `:(glob,icase)**/${glob}/**`]);
/** Everything but them. */
const besideSecrets = secretPathspecs.map((spec) => spec.replace(":(glob,icase)", ":(exclude,glob,icase)"));
/** SECRET_SHAPED as `git clean` exclude patterns, each letter in either case (`-e` follows core.ignorecase, off on Linux). */
export const SECRET_CLEAN_EXCLUDES: ReadonlyArray<string> = SECRET_SHAPED.flatMap((glob) => ["-e", glob.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)]);

/**
 * The secret-shaped files here that a move would carry if it could: untracked and not ignored, or tracked and changed
 * against HEAD (in the worktree or the index; deleted ones too), each saying whether git tracks it. One `git status`
 * that takes no lock on the person's index.
 */
const secretShapedStatus = (driver: Git, worktree: string) =>
  git(driver, worktree, ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--", ...secretPathspecs], { env: { GIT_OPTIONAL_LOCKS: "0" } }).pipe(
    Effect.map((r) => {
      const seen = new Map<string, string>();
      for (const entry of r.stdout.split("\0")) if (entry.length > 3) seen.set(entry.slice(3), entry.slice(0, 2));
      // `inHead`: HEAD has it (an edit or a deletion of a committed file), not a new one, staged ("A") or not ("??").
      return [...seen]
        .map(([rel, xy]) => ({ rel, untracked: xy === "??", inHead: xy !== "??" && !xy.startsWith("A") }))
        .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    }),
  );
/** secretShapedStatus' paths, sorted. */
export const secretShapedChanges = (driver: Git, worktree: string) => secretShapedStatus(driver, worktree).pipe(Effect.map((entries) => entries.map((e) => e.rel) as ReadonlyArray<string>));

const secretNames = SECRET_SHAPED.map((glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`, "i"));
/** Whether a path in a tree is secret-shaped (SECRET_SHAPED): its name, or a folder on its way, in any case. */
export const secretShapedPath = (rel: string): boolean => rel.split("/").some((part) => part !== "" && secretNames.some((name) => name.test(part)));
/**
 * Secret-shaped paths as the move card and the lid summary name them: what is inside a folder so named once, as the
 * folder (`.env/`, a virtualenv of thousands of files), sorted.
 */
export const secretsNamed = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  [
    ...new Set(
      paths.map((rel) => {
        const parts = rel.split("/");
        const folder = parts.slice(0, -1).findIndex((part) => secretNames.some((name) => name.test(part)));
        return folder < 0 ? rel : `${parts.slice(0, folder + 1).join("/")}/`;
      }),
    ),
  ].sort();

/** indexSeed's last answer for a worktree on this computer, while its index file stays the same (git keeps its flags there). */
const seeds = new Map<string, { readonly index: string; readonly stamp: string; readonly seed: string | undefined }>();
const stampOf = (file: string) => {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined;
  }
};

/**
 * The worktree's own index, to start a temporary one from (decision 25); undefined where git would trust entries of a
 * copy without looking at their files (assume-unchanged, skip-worktree, a sparse checkout or index) or the index is
 * split, so a change there could be missed: read-tree HEAD instead. Any doubt (a git that cannot say) answers undefined.
 * On This Mac the answer holds until the index file changes, so a snapshot of an unchanged index asks git nothing.
 */
export const indexSeed = (driver: Git, worktree: string) =>
  Effect.gen(function* () {
    const tools = toolsSocket() !== undefined;
    const cached = tools ? undefined : seeds.get(worktree);
    if (cached !== undefined && stampOf(cached.index) === cached.stamp) return cached.seed;
    // The index's path, then the shared index's (printed only for a split index).
    const [index = "", shared] = (yield* git(driver, worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index", "--shared-index-path"])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    // Taken before git is asked, so a change made meanwhile is looked at again next time.
    const stamp = tools ? undefined : stampOf(index);
    const seed = yield* Effect.gen(function* () {
      if (shared !== undefined || (!tools && stamp === undefined)) return undefined;
      const sparse = (yield* git(driver, worktree, ["config", "--type=bool", "--get-regexp", "^(core\\.sparsecheckout|index\\.sparse)$"], { allowNonZeroExit: true })).stdout;
      if (/ true$/m.test(sparse)) return undefined;
      // A lowercase tag is assume-unchanged, S skip-worktree.
      const entries = (yield* git(driver, worktree, ["ls-files", "-v", "-z"])).stdout.split("\0");
      return entries.some((entry) => /^[a-zS] /.test(entry)) ? undefined : index;
    });
    if (stamp !== undefined) seeds.set(worktree, { index, stamp, seed });
    return seed;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Whether commits `a` and `b` hold the same files beside the secret-shaped ones (which no copy carries). */
export const sameBesideSecrets = (driver: Git, worktree: string, a: string, b: string) =>
  git(driver, worktree, ["diff", "--quiet", "--no-renames", a, b, "--", ".", ...besideSecrets], { allowNonZeroExit: true }).pipe(Effect.map((r) => r.exitCode === 0));

/**
 * The tree of the worktree's state (respecting .gitignore), made in a temporary index that never touches the branch,
 * the index or the files. It starts as a copy of `seed`, the worktree's own index (indexSeed, decision 25): the same
 * tree as read-tree HEAD and add -A make, but git keeps its stat cache and hashes only what changed; without one, from
 * read-tree HEAD. `leave`: see snapshotWorkInProgress.
 */
export const wipTree = (driver: Git, worktree: string, options: { readonly leave: SecretsLeave; readonly seed: string | undefined; readonly keepHere?: ReadonlyArray<string> }) =>
  Effect.scoped(
    Effect.gen(function* () {
      // On a Cloud computer git runs in the tools container, so its index is made (copied) and removed there.
      // Either way it goes when the scope closes, the snapshot failed or not.
      const tools = toolsSocket();
      const { seed, leave } = options;
      const made =
        tools !== undefined
          ? yield* toolsIndex(tools, seed).pipe(Effect.mapError((error) => new LifecycleError(error.message)))
          : yield* Effect.acquireRelease(
              Effect.sync(() => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-wip-"));
                const index = path.join(dir, "index");
                if (seed === undefined) return { dir, path: index, seeded: false };
                // Its times too (cp -p): git's racy-entry check reads the index file's own mtime.
                fs.copyFileSync(seed, index);
                const st = fs.statSync(seed);
                fs.utimesSync(index, st.atime, st.mtime);
                return { dir, path: index, seeded: true };
              }),
              ({ dir }) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
            );
      const env = { GIT_INDEX_FILE: made.path };
      if (!made.seeded) yield* git(driver, worktree, ["read-tree", "HEAD"], { env });
      yield* git(driver, worktree, ["add", "-A", "--", ".", ...(leave ? besideSecrets : [])], { env });
      // What the index it starts from held of them (HEAD's): a tracked one goes at that version, a new one not at all.
      if (leave) yield* git(driver, worktree, ["reset", "-q", "HEAD", "--", ...secretPathspecs], { env });
      const secrets = leave ? yield* secretShapedStatus(driver, worktree) : [];
      // A Cloud computer's ("untracked"): the ones HEAD has go as they are here (an edit, a deletion), each by its own
      // name; only new ones stay.
      const tracked = leave === "untracked" ? secrets.filter((entry) => entry.inHead).map((entry) => `:(literal)${entry.rel}`) : [];
      for (let at = 0; at < tracked.length; at += 200) yield* git(driver, worktree, ["add", "-A", "--", ...tracked.slice(at, at + 200)], { env });
      // Files this computer keeps as its own whatever HEAD says (keepHere): they go at HEAD's version, as a tracked
      // secret-shaped one does here.
      const here = (options.keepHere ?? []).map((rel) => `:(literal)${rel}`);
      for (let at = 0; at < here.length; at += 200) yield* git(driver, worktree, ["reset", "-q", "HEAD", "--", ...here.slice(at, at + 200)], { env });
      const left = secretsNamed(secrets.filter((entry) => leave !== "untracked" || !entry.inHead).map((entry) => entry.rel));
      return { tree: (yield* git(driver, worktree, ["write-tree"], { env })).stdout.trim(), left };
    }),
  );

/**
 * Commits the worktree's state (wipTree) onto a private ref without touching the branch, the index or the files.
 * Returns the commit sha. The same files on the same parent as the ref holds already answer that commit, not a new one
 * a second later: a copy made again (a retry) bundles the same bytes. `leave`: the commit leaves this computer (a
 * move's copy), so secret-shaped files git does not ignore stay out of it, and `left` names those that stayed (SecretsLeave).
 */
export const snapshotWorkInProgress = (driver: Git, worktree: string, ref: string, message: string, options: { readonly leave?: SecretsLeave; readonly keepHere?: ReadonlyArray<string> } = {}) =>
  Effect.gen(function* () {
    const { tree, left } = yield* wipTree(driver, worktree, { leave: options.leave ?? false, seed: yield* indexSeed(driver, worktree), ...(options.keepHere ? { keepHere: options.keepHere } : {}) });
    const head = (yield* git(driver, worktree, ["rev-parse", "HEAD"])).stdout.trim();
    const held = (yield* git(driver, worktree, ["for-each-ref", "--format=%(refname) %(objectname) %(tree) %(parent)", ref])).stdout.split("\n").find((line) => line.startsWith(`${ref} `));
    const [, heldCommit, heldTree, ...heldParents] = held?.trim().split(" ") ?? [];
    // The checkpoints' identity: a Cloud computer's git has none of its own.
    const identity = { GIT_AUTHOR_NAME: "Caveman Code", GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com", GIT_COMMITTER_NAME: "Caveman Code", GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com" };
    const commit =
      heldCommit && heldTree === tree && heldParents.length === 1 && heldParents[0] === head
        ? heldCommit
        : (yield* git(driver, worktree, ["commit-tree", tree, "-p", head, "-m", message], { env: identity })).stdout.trim();
    if (commit !== heldCommit) yield* git(driver, worktree, ["update-ref", ref, commit]);
    return { commit, left };
  });

/** Resolves a WorkspacePath inside the worktree, symlinks included; undefined when it escapes. */
export function containedPath(worktree: string, relative: string): string | undefined {
  const root = fs.realpathSync(worktree);
  const joined = path.resolve(root, relative);
  let real: string;
  try {
    real = fs.realpathSync(joined);
  } catch {
    // A file that does not exist yet: check its parent instead.
    try {
      real = path.join(fs.realpathSync(path.dirname(joined)), path.basename(joined));
    } catch {
      return undefined;
    }
  }
  return real === root || real.startsWith(root + path.sep) ? real : undefined;
}

/**
 * A secret-shaped file as a return found it (secretsAsTheyAre): how to tell whether the return wrote there (`stamp`,
 * absent: it was gone), and what to put back if it did: its bytes and mode, a link's target, or neither (gone).
 * `unread`: kept only on the return's kept ref, never put back from here.
 */
export interface FileAsItWas {
  readonly rel: string;
  readonly stamp?: string;
  readonly bytes?: Buffer;
  readonly mode?: number;
  readonly link?: string;
  readonly unread?: true;
}

/** The bytes of the tracked secret-shaped files one return holds to put back; past them a file waits on the kept ref. */
export const SECRETS_HELD_MAX_BYTES = 64 * 1024 * 1024;

const lstatOrGone = (at: string) => {
  try {
    return fs.lstatSync(at);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
};
/**
 * `rel` in `worktree` as it stands, never looked at through a link on its way: inode, size, mtime and mode (a link's
 * target too); undefined when it is gone, "outside" when a folder on its way is no folder now.
 */
export const stampInside = (worktree: string, rel: string): string | undefined => {
  const parts = rel.split("/");
  let dir = worktree;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const st = lstatOrGone(dir);
    if (st === undefined) return undefined;
    if (!st.isDirectory()) return "outside";
  }
  const full = path.join(dir, parts.at(-1)!);
  const st = lstatOrGone(full);
  if (st === undefined) return undefined;
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}${st.isSymbolicLink() ? `:${fs.readlinkSync(full)}` : ""}`;
};

/**
 * The secret-shaped files in `worktree` a return must leave as they are (decision 24), before it checks out what came
 * back: each one's stamp, and the bytes and mode (or link) of the tracked ones, which the checkout overwrites, up to
 * `maxBytes` in all. Untracked ones are only stamped: the checkout and the clean leave them be unless what came back
 * tracks one, and kept on the return's ref (keepLocalEdits) they are not read here, however many (an un-ignored
 * `.env/` virtualenv). A file that cannot be read fails it, so nothing is written: never taken for gone.
 */
export const secretsAsTheyAre = (driver: Git, worktree: string, maxBytes = SECRETS_HELD_MAX_BYTES) =>
  Effect.gen(function* () {
    const entries = yield* secretShapedStatus(driver, worktree);
    return yield* Effect.try({
      try: () => {
        let held = 0;
        return entries.flatMap(({ rel, untracked }): Array<FileAsItWas> => {
          if (rel.split("/").some((part) => part === "" || part === "." || part === "..")) return [];
          const stamp = stampInside(worktree, rel);
          if (stamp === "outside") return [];
          if (stamp === undefined) return [{ rel }];
          if (untracked) return [{ rel, stamp, unread: true }];
          const full = path.join(worktree, rel);
          const st = fs.lstatSync(full);
          if (st.isSymbolicLink()) return [{ rel, stamp, link: fs.readlinkSync(full) }];
          if (!st.isFile()) return [];
          if (held + st.size > maxBytes) return [{ rel, stamp, unread: true }];
          held += st.size;
          return [{ rel, stamp, bytes: fs.readFileSync(full), mode: st.mode & 0o7777 }];
        });
      },
      catch: (error) => new LifecycleError(`a secret-shaped file here could not be read, so nothing was changed: ${(error as Error).message}`),
    });
  });

/**
 * Files this computer's git ignores that a return to `commits` would write over (F-2): paths one of those commits
 * tracks that HEAD here does not have the same, standing here as files git ignores (`.env.local` under the person's own
 * excludes, a globally ignored `.vscode/settings.json` a Cloud computer's agent committed). `git checkout -f` takes an
 * ignored file for expendable and writes the commit's over it, and no snapshot here keeps one (they honour ignore
 * rules): the person's own would be gone, with no copy anywhere. Each is read whole, as secretsAsTheyAre reads a tracked
 * one (bytes and mode, a link's target), to be put back after the checkout (putSecretsBack). Past `maxBytes` in all,
 * or one that cannot be read, it fails, so nothing is written.
 */
export const ignoredInTheWay = (driver: Git, worktree: string, commits: ReadonlyArray<string>, maxBytes = SECRETS_HELD_MAX_BYTES) =>
  Effect.gen(function* () {
    const named = new Set<string>();
    for (const commit of commits) {
      const out = yield* git(driver, worktree, ["diff-tree", "-r", "-z", "--no-renames", "--diff-filter=AM", "--name-only", "HEAD", commit]);
      for (const rel of out.stdout.split("\0")) if (rel !== "" && !rel.split("/").some((part) => part === "" || part === "." || part === "..")) named.add(rel);
    }
    const standing = [...named].filter((rel) => {
      try {
        const stamp = stampInside(worktree, rel);
        return stamp !== undefined && stamp !== "outside";
      } catch {
        return true;
      }
    });
    const ignored: Array<string> = [];
    for (let at = 0; at < standing.length; at += 200) {
      const out = yield* git(driver, worktree, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...standing.slice(at, at + 200).map((rel) => `:(literal)${rel}`)], { env: { GIT_OPTIONAL_LOCKS: "0" } });
      ignored.push(...out.stdout.split("\0").filter((rel) => named.has(rel)));
    }
    return yield* Effect.try({
      try: () => {
        let held = 0;
        return ignored.sort().flatMap((rel): Array<FileAsItWas> => {
          const stamp = stampInside(worktree, rel);
          if (stamp === undefined || stamp === "outside") return [];
          const full = path.join(worktree, rel);
          const st = fs.lstatSync(full);
          if (st.isSymbolicLink()) return [{ rel, stamp, link: fs.readlinkSync(full) }];
          if (!st.isFile()) return [];
          if (held + st.size > maxBytes) throw new Error(`${rel}, which git ignores here and what came back tracks, is more than a return keeps aside`);
          held += st.size;
          return [{ rel, stamp, bytes: fs.readFileSync(full), mode: st.mode & 0o7777 }];
        });
      },
      catch: (error) => new LifecycleError(`a file git ignores here that the return would write over could not be kept, so nothing was changed: ${(error as Error).message}`),
    });
  });

/**
 * secretsAsTheyAre's files put back as they were after a return checked out what came back, each one only if the
 * return changed it (its stamp), never through a link (putBackInside). Answers those that could not go back (an unread
 * one the return changed, or a link or folder on its way) and why; the rest still go back.
 */
export const putSecretsBack = (worktree: string, files: ReadonlyArray<FileAsItWas>) => {
  const refused: Array<{ readonly rel: string; readonly why: string }> = [];
  for (const file of files) {
    try {
      if (stampInside(worktree, file.rel) === file.stamp) continue;
      if (file.unread) throw new Error("the return changed it and its bytes were not held here");
      putBackInside(worktree, file);
    } catch (error) {
      refused.push({ rel: file.rel, why: (error as Error).message });
    }
  }
  return refused;
};

/**
 * `file` set back in `worktree` as it was (decision 24), never through a link: every folder on its way must be a
 * folder (made when missing), never a link, and only a file or a link is replaced, so a tree that came back with a link
 * where a folder was (a Cloud computer is lower trust than This Mac, S-R1) never gets a write outside the worktree.
 * Throws what stopped it, having written nothing.
 */
export const putBackInside = (worktree: string, file: FileAsItWas) => {
  const parts = file.rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`${file.rel} is not a path inside the worktree`);
  const look = (at: string) => {
    try {
      return fs.lstatSync(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const restores = file.bytes !== undefined || file.link !== undefined;
  let dir = worktree;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const st = look(dir);
    if (st === undefined) {
      // Gone, and nothing to put there: nothing to remove under it either.
      if (!restores) return;
      fs.mkdirSync(dir);
    } else if (!st.isDirectory()) throw new Error(`${path.relative(worktree, dir)} is ${st.isSymbolicLink() ? "a link" : "a file"} now`);
  }
  const full = path.join(dir, parts.at(-1)!);
  const st = look(full);
  if (st?.isDirectory()) throw new Error(`${file.rel} is a folder now`);
  if (st !== undefined) fs.unlinkSync(full);
  if (file.link !== undefined) fs.symlinkSync(file.link, full);
  else if (file.bytes !== undefined) {
    const fd = fs.openSync(full, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), file.mode);
    try {
      for (let at = 0; at < file.bytes.length; ) at += fs.writeSync(fd, file.bytes, at);
      fs.fchmodSync(fd, file.mode ?? 0o644);
    } finally {
      fs.closeSync(fd);
    }
  }
};
