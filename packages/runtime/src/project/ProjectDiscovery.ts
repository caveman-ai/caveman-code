// project.discover: the repositories this person works on, best first, each
// linked to its repository on its git host. Sources: the folders Claude Code
// and Codex sessions ran in, git checkouts beside them and in the usual code
// folders, existing projects and workspaces, and the user's GitHub
// repositories. Reads transcript heads and `.git` directly; never spawns git
// and never parses a whole transcript (AgentSessionScanner does that for imports).
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { expandHomePath } from "@caveman-app/engine-core/server/pathExpansion";
import type { ProviderInstanceConfig } from "@caveman-app/protocol";
import type { ProjectCandidate, ProjectCandidateSource, RepositoryLink } from "@caveman-app/session-protocol";
import { normalizeGitRemoteUrl, parseOriginUrlFromGitConfig } from "@caveman-app/shared/git";
import type * as GitHubApi from "@caveman-app/source-control-github/server/GitHubApi";
import * as Effect from "effect/Effect";

/** Canonical case on case-insensitive volumes too, which fs.promises.realpath is not. */
const realpath = promisify(fs.realpath.native);

/** Code folders under home worth sweeping when they exist. */
const CODE_FOLDERS = [
  "code", "Code", "dev", "Developer", "src", "projects", "Projects", "repos", "workspace", "work", "git", "github", "GitHub", "Sites",
  "Documents/GitHub", "Desktop/GitHub", "Desktop/code", "Desktop/projects",
];
/** Where clone_dir falls back to, in order, when no folder holds discovered checkouts. */
const CLONE_FALLBACKS = ["Developer", "code", "src", "projects"];
/** One scan's file system reads: this many in all, this many at once, none started after SCAN_MS. */
const MAX_FS_OPS = 8000;
const IO_CONCURRENCY = 16;
const SCAN_MS = 1500;
/** Then it answers with what it has, even while a read hangs (a dead network mount). */
const SCAN_HARD_MS = 2000;
const MAX_CANDIDATES = 80;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** A transcript names its cwd in its first records; Claude's can open with a long queued prompt, so a miss reads on. */
const HEAD_BYTES = 8 * 1024;
const MAX_HEAD_BYTES = 64 * 1024;
const SESSION_DAYS = 180;
const MAX_CODEX_FILES = 3000;
const SOURCE_ORDER: ReadonlyArray<ProjectCandidateSource> = ["claude", "codex", "folder", "github"];

// ------------------------------------------------------------------ remotes

/** The repository a remote URL names on its host: credentials, port and `.git` dropped. Undefined for local paths and file:// URLs. */
export function repositoryLinkOf(url: string | null | undefined): RepositoryLink | undefined {
  const raw = url?.trim() ?? "";
  let host: string;
  let repoPath: string;
  const scp = /^[^@/\s]+@([^:/\s]+):([^\s]+)$/.exec(raw);
  if (scp) {
    host = scp[1]!;
    repoPath = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return undefined;
    }
    if (!/^(https?|ssh|git):$/.test(parsed.protocol) || parsed.hostname === "") return undefined;
    host = parsed.hostname;
    repoPath = parsed.pathname;
  }
  host = host.toLowerCase().replace(/^www\.github\.com$/, "github.com");
  const segments = repoPath.replace(/(\.git)?\/*$/i, "").split("/").filter((s) => s !== "");
  // A github.com web URL can go on past owner/name (/tree/main, /pull/7).
  const kept = host === "github.com" ? segments.slice(0, 2) : segments;
  if (kept.length < 2 || kept.some((s) => s === "." || s === ".." || /[\s\\]/.test(s))) return undefined;
  const full_name = kept.join("/");
  return { host, full_name, web_url: `https://${host}/${full_name}`, clone_url: `https://${host}/${full_name}.git` };
}

/**
 * What project.create clones for a `url`: `owner/name` and GitHub web URLs (https, http, www.) become the
 * repository's clone URL, over ssh when `ssh` (the user's other GitHub checkouts use it); anything else as given.
 */
export function cloneUrlOf(url: string, ssh = false) {
  const trimmed = url.trim();
  const gitHub = /^[\w.-]+\/[\w.-]+$/.test(trimmed)
    ? repositoryLinkOf(`https://github.com/${trimmed}`)
    : /^https?:\/\/(www\.)?github\.com\//i.test(trimmed)
      ? repositoryLinkOf(trimmed)
      : undefined;
  if (gitHub === undefined) return trimmed;
  return ssh ? `git@github.com:${gitHub.full_name}.git` : gitHub.clone_url;
}

/** `url` with no user or password in it (an ssh user like `git@` stays: it is not a secret). */
export function withoutCredentials(url: string) {
  if (!/^(https?|ssh):\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("ssh")) parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A folder name for a clone of `url`: its repository's name as one safe path segment, never hidden or an option. */
export function cloneNameOf(url: string) {
  const last = url.replace(/[?#].*$/, "").replace(/(\.git)?\/*$/i, "").split(/[/:]/).pop() ?? "";
  return last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 100) || "repo";
}

/** Why `git clone` failed, from its stderr, with any credentials in it removed. */
export function cloneFailure(stderr: string) {
  // Over https GitHub answers a repository that does not exist like a private one: it asks for a sign-in, which git may not prompt for.
  if (/could not read (username|password)|terminal prompts disabled/i.test(stderr)) return "repository not found, or private and git has no sign-in for it here";
  if (/authentication failed|permission denied \(publickey|error: 403|host key verification failed/i.test(stderr)) {
    return "authentication failed";
  }
  if (/not found|does not exist|does not appear to be a git repository|error: 404/i.test(stderr)) return "repository not found";
  if (/could not resolve host|failed to connect|connection (refused|reset|timed out)|network is unreachable|operation timed out/i.test(stderr)) return "network error";
  return stderr.trim().split("\n").pop()?.replace(/\/\/[^/@\s]*@/g, "//") || "git clone failed";
}

// ---------------------------------------------------------------- checkouts

/** Runs one read; a scan's queues and counts them (scanIo), everything else reads directly. */
type Io = (<T>(read: () => Promise<T>) => Promise<T>) & {
  /** A read was refused for time or count: what the scan found is not everything there is. */
  readonly spent: () => boolean;
};
const direct: Io = Object.assign(<T>(read: () => Promise<T>) => read(), { spent: () => false });

/** Reads a small git file: a `.git` pointer, `commondir`, `config`. */
type ReadText = (file: string) => Promise<string>;
const readTextDirect: ReadText = (file) => fsp.readFile(file, "utf8");

/** A git file read past this is abandoned (its `cat` killed), and its path skipped for BLOCKED_RETRY_MS. */
const GIT_FILE_DEADLINE_MS = 2000;
const MAX_GIT_FILE_BYTES = 1024 * 1024;
const BLOCKED_RETRY_MS = 5 * 60 * 1000;
const MAX_BLOCKED_PATHS = 1024;
const blockedGitFiles = new Map<string, number>();

/**
 * A scan reads git files under any folder a session named. open() on a path macOS guards waits on a consent
 * prompt a background runtime never answers, and a FIFO waits for a writer; either pins one of libuv's four
 * threads for good, and four of them stall every file read in the runtime. So a scan reads them with a `cat`
 * it can kill, and skips a path that blocked until BLOCKED_RETRY_MS has passed. Windows has neither and reads
 * directly. , which does the same for its session scanner.
 */
export function readGitFileKillable(file: string): Promise<string> {
  if (process.platform === "win32") return readTextDirect(file);
  const blockedUntil = blockedGitFiles.get(file);
  if (blockedUntil !== undefined) {
    if (blockedUntil > Date.now()) return Promise.reject(new Error(`${file} blocked a read`));
    blockedGitFiles.delete(file);
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      "cat",
      ["--", file],
      { encoding: "utf8", timeout: GIT_FILE_DEADLINE_MS, killSignal: "SIGKILL", maxBuffer: MAX_GIT_FILE_BYTES },
      (error, stdout) => {
        if (error === null) return resolve(stdout);
        if (Date.now() - started >= GIT_FILE_DEADLINE_MS) {
          if (blockedGitFiles.size >= MAX_BLOCKED_PATHS) blockedGitFiles.delete(blockedGitFiles.keys().next().value!);
          blockedGitFiles.set(file, Date.now() + BLOCKED_RETRY_MS);
        }
        reject(error);
      },
    );
  });
}

/** One scan's reads: at most IO_CONCURRENCY at a time, MAX_FS_OPS in all, none started after `deadline`. */
function scanIo(deadline: number): Io {
  let ops = MAX_FS_OPS;
  let active = 0;
  let spent = false;
  const waiting: Array<() => void> = [];
  const refuse = () => {
    spent = true;
    return new Error("discovery budget spent");
  };
  const io = async <T>(read: () => Promise<T>): Promise<T> => {
    if (--ops < 0 || Date.now() >= deadline) throw refuse();
    if (active < IO_CONCURRENCY) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      if (Date.now() >= deadline) throw refuse();
      return await read();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
  return Object.assign(io, { spent: () => spent });
}

interface Git {
  /** This checkout's git dir. */
  readonly dir: string;
  /** Where its config and objects live: the main checkout's `.git` for a linked worktree. */
  readonly common: string;
  /** A linked worktree: its main checkout's top level (absent for a bare one). */
  readonly worktreeOf?: string | null;
}

/** The checkout at `dir`, or undefined when `dir` has no `.git`. */
async function gitOf(dir: string, io: Io = direct, readText: ReadText = readTextDirect): Promise<Git | undefined> {
  const dotGit = path.join(dir, ".git");
  const stat = await io(() => fsp.stat(dotGit)).catch(() => undefined);
  if (stat === undefined) return undefined;
  if (stat.isDirectory()) return { dir: dotGit, common: dotGit };
  // A `.git` pointer is a regular file; a FIFO or a device in its place is never opened.
  if (!stat.isFile()) return undefined;
  const target = /^gitdir:\s*(.+)$/m.exec(await io(() => readText(dotGit)).catch(() => ""))?.[1]?.trim();
  if (!target) return undefined;
  const gitDir = path.resolve(dir, target);
  if (!/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)) return { dir: gitDir, common: gitDir };
  const common = path.resolve(gitDir, (await io(() => readText(path.join(gitDir, "commondir"))).catch(() => "../..")).trim());
  return { dir: gitDir, common, worktreeOf: path.basename(common) === ".git" ? path.dirname(common) : null };
}

const originOf = async (git: Git, io: Io = direct, readText: ReadText = readTextDirect) =>
  parseOriginUrlFromGitConfig(await io(() => readText(path.join(git.common, "config"))).catch(() => ""));

/** The origin remote URL of the checkout at `top`, or null. */
export async function readOriginUrl(top: string) {
  const git = await gitOf(top);
  return git ? originOf(git) : null;
}

/** The repository the checkout at `top` came from, read from its git config. */
export const readRepositoryLink = async (top: string) => repositoryLinkOf(await readOriginUrl(top));

/** Last commit, checkout or fetch: the newest of the files git touches for each. */
const activityOf = async (git: Git, io: Io) =>
  Math.max(
    0,
    ...(await Promise.all(
      [path.join(git.dir, "logs", "HEAD"), path.join(git.dir, "index"), path.join(git.common, "FETCH_HEAD")].map((file) =>
        io(() => fsp.stat(file)).then((s) => s.mtimeMs, () => 0),
      ),
    )),
  );

// ----------------------------------------------------------------- sessions

/** Sessions that ran in one folder, from one of Claude Code's or Codex's homes. */
export interface SessionFolder {
  readonly cwd: string;
  readonly source: "claude" | "codex";
  sessions: number;
  lastMs: number;
}

export interface SessionHomes {
  readonly claude: ReadonlyArray<string>;
  readonly codex: ReadonlyArray<string>;
}

/**
 * Where Claude Code and Codex keep sessions: always the user's own homes (`$CLAUDE_CONFIG_DIR` or ~/.claude,
 * `$CODEX_HOME` or ~/.codex), whatever Caveman's instances use, plus any home an instance in Settings points at.
 */
export function sessionHomes(home: string, env: NodeJS.ProcessEnv, instances: Readonly<Record<string, ProviderInstanceConfig>> = {}): SessionHomes {
  const homes = (driver: string, variable: string, fallback: string) =>
    [
      env[variable]?.trim() || path.join(home, fallback),
      ...Object.values(instances).flatMap((instance) =>
        instance.driver === driver ? [(instance.config as { homePath?: unknown } | undefined)?.homePath, instance.environment?.findLast((v) => v.name === variable)?.value] : [],
      ),
    ]
      .filter((dir): dir is string => typeof dir === "string" && dir.trim() !== "")
      .map((dir) => path.resolve(expandHomePath(dir.trim(), home)));
  return { claude: homes("claudeAgent", "CLAUDE_CONFIG_DIR", ".claude"), codex: homes("codex", "CODEX_HOME", ".codex") };
}

/** The `cwd` a transcript's first records name: from its first 8 KiB, else its first 64 KiB. */
const cwdOf = (file: string, io: Io) =>
  io(async () => {
    const handle = await fsp.open(file, "r");
    try {
      for (const size of [HEAD_BYTES, MAX_HEAD_BYTES]) {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(size), 0, size, 0);
        const quoted = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(buffer.toString("utf8", 0, bytesRead))?.[1];
        const cwd: unknown = quoted === undefined ? undefined : JSON.parse(quoted);
        if (typeof cwd === "string" && cwd !== "") return cwd;
        if (bytesRead < size) return undefined;
      }
      return undefined;
    } finally {
      await handle.close();
    }
  }).catch(() => undefined);

/** Claude Code keeps a folder per cwd under projects/: its recent transcripts' count and newest mtime, and the cwd the newest names. */
async function claudeFolders(home: string, cutoff: number, io: Io, out: Array<SessionFolder>) {
  const projects = path.join(home, "projects");
  const dirs = (await io(() => fsp.readdir(projects, { withFileTypes: true })).catch(() => [])).filter((entry) => entry.isDirectory());
  await Promise.all(
    dirs.map(async (dir) => {
      const at = path.join(projects, dir.name);
      const files = (await io(() => fsp.readdir(at, { withFileTypes: true })).catch(() => [])).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
      const stats = await Promise.all(files.map((file) => io(() => fsp.stat(path.join(at, file.name))).then((s) => ({ file: path.join(at, file.name), ms: s.mtimeMs }), () => undefined)));
      const recent = stats.filter((it): it is { file: string; ms: number } => it !== undefined && it.ms >= cutoff).sort((a, b) => b.ms - a.ms);
      // The folder is named after the cwd; a transcript can still open elsewhere (a resumed or moved session).
      let cwd: string | undefined;
      for (const transcript of recent.slice(0, 3)) {
        const named = await cwdOf(transcript.file, io);
        cwd ??= named;
        if (named !== undefined && named.replace(/[^a-zA-Z0-9]/g, "-") === dir.name) {
          cwd = named;
          break;
        }
      }
      if (cwd !== undefined) out.push({ cwd, source: "claude", sessions: recent.length, lastMs: recent[0]!.ms });
    }),
  );
}

/** Codex keeps sessions/YYYY/MM/DD/rollout-*.jsonl: the newest first, back to `cutoff` or MAX_CODEX_FILES files. */
async function codexFolders(home: string, cutoff: number, io: Io, out: Array<SessionFolder>) {
  const sessions = path.join(home, "sessions");
  const oldestDay = new Date(cutoff).toISOString().slice(0, 10);
  const newestFirst = async (dir: string) => (await io(() => fsp.readdir(dir)).catch(() => [])).filter((name) => /^\d+$/.test(name)).sort().reverse();
  const files: Array<string> = [];
  walk: for (const year of await newestFirst(sessions)) {
    for (const month of await newestFirst(path.join(sessions, year))) {
      for (const day of await newestFirst(path.join(sessions, year, month))) {
        if (`${year}-${month}-${day}` < oldestDay) break walk;
        const at = path.join(sessions, year, month, day);
        for (const name of (await io(() => fsp.readdir(at)).catch(() => [])).filter((n) => n.endsWith(".jsonl")).sort().reverse()) {
          files.push(path.join(at, name));
          if (files.length >= MAX_CODEX_FILES) break walk;
        }
      }
    }
  }
  const byCwd = new Map<string, SessionFolder>();
  await Promise.all(
    files.map(async (file) => {
      const ms = await io(() => fsp.stat(file)).then((s) => s.mtimeMs, () => 0);
      const cwd = ms >= cutoff ? await cwdOf(file, io) : undefined;
      if (cwd === undefined) return;
      let folder = byCwd.get(cwd);
      if (folder === undefined) {
        folder = { cwd, source: "codex", sessions: 0, lastMs: 0 };
        byCwd.set(cwd, folder);
        out.push(folder);
      }
      folder.sessions += 1;
      folder.lastMs = Math.max(folder.lastMs, ms);
    }),
  );
}

/**
 * The folders sessions ran in over the last SESSION_DAYS, from each distinct Claude Code and Codex home. Missing
 * homes are none. Folders land in `out` as they are read, so a scan cut short keeps what it has.
 */
export async function readSessions(homes: SessionHomes, now = Date.now(), io: Io = direct, out: Array<SessionFolder> = []) {
  const distinct = async (dirs: ReadonlyArray<string>) =>
    [...new Set(await Promise.all(dirs.map((dir) => io(() => realpath(dir)).catch(() => undefined))))].filter((dir) => dir !== undefined);
  const [claude, codex] = await Promise.all([distinct(homes.claude), distinct(homes.codex)]);
  const cutoff = now - SESSION_DAYS * DAY_MS;
  await Promise.all([...claude.map((home) => claudeFolders(home, cutoff, io, out)), ...codex.map((home) => codexFolders(home, cutoff, io, out))]);
  return out;
}

// ------------------------------------------------------------------- GitHub

export interface GitHubRepository {
  readonly full_name: string;
  readonly private?: boolean;
  readonly archived?: boolean;
  readonly pushed_at?: string | null;
}

/** The user's GitHub repositories, most recently pushed first; none without a login or on any failure. */
export const gitHubRepositories = (api: GitHubApi.GitHubApi["Service"]) =>
  api
    .rest({
      host: "github.com",
      operation: "ProjectDiscovery.repositories",
      path: "user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member",
      timeout: "4 seconds",
    })
    .pipe(
      Effect.flatMap((response) => Effect.try(() => (response.status === 200 ? JSON.parse(response.body) : []))),
      Effect.map((body): ReadonlyArray<GitHubRepository> => (Array.isArray(body) ? body.filter((repo) => typeof repo?.full_name === "string") : [])),
      Effect.timeout("4 seconds"),
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<GitHubRepository>)),
    );

// ---------------------------------------------------------------- discovery

export interface DiscoveryInput {
  readonly home: string;
  /** Never offered or swept: the runtime's own state, base and worktrees dirs. */
  readonly excluded: ReadonlyArray<string>;
  readonly sessionHomes: Effect.Effect<SessionHomes, unknown>;
  readonly gitHub: Effect.Effect<ReadonlyArray<GitHubRepository>, unknown>;
  /** Repository paths of existing projects and workspaces. */
  readonly known: Effect.Effect<ReadonlyArray<string>, unknown>;
  /**
   * Whether to read inside the folders macOS asks the person about first (PROTECTED_FOLDERS): Desktop, Documents,
   * Downloads, iCloud Drive and other volumes. False for the scan at the runtime's start, so the "would like to access
   * files in your Documents folder" prompts come when someone picks a project, not over the sign-in screen. Read when
   * the scan starts; default true. Off macOS there is nothing to ask, and it reads everything.
   */
  readonly protectedFolders?: () => boolean;
  /** For tests. */
  readonly now?: () => number;
  /** For tests: the local scan's time budget (SCAN_MS). */
  readonly scanMs?: number;
  readonly platform?: NodeJS.Platform;
}

/** Under home: the folders macOS guards with a Files and Folders prompt (TCC). /Volumes is guarded as well. */
const PROTECTED_FOLDERS = ["Desktop", "Documents", "Downloads", "Library/Mobile Documents"];

/** project.discover's answer before project ids, which the caller adds fresh on every read. */
export interface Discovered {
  readonly candidates: ReadonlyArray<ProjectCandidate>;
  readonly clone_dir: string;
  /** Most of the user's GitHub checkouts have an ssh origin: clone GitHub repositories over ssh too. */
  readonly github_ssh: boolean;
  /**
   * False when the local scan ran out of time or reads before it finished: one started while the runtime is busy
   * (its own start) can find nothing at all. Not an answer to keep for someone picking a project.
   */
  readonly complete: boolean;
}

interface Found {
  readonly path?: string;
  readonly name: string;
  readonly repository?: RepositoryLink;
  readonly sources: Set<ProjectCandidateSource>;
  readonly ssh?: boolean;
  sessions: number;
  lastMs: number;
  private?: boolean;
}

const orElse = <A>(effect: Effect.Effect<A, unknown>, fallback: A) => effect.pipe(Effect.catchCause(() => Effect.succeed(fallback)));

/** One full discovery. Never fails: a source that does is left out. */
export const discover = (input: DiscoveryInput): Effect.Effect<Discovered> =>
  Effect.gen(function* () {
    const now = (input.now ?? Date.now)();
    const local = Effect.all([orElse(input.sessionHomes, { claude: [], codex: [] }), orElse(input.known, [])], { concurrency: "unbounded" }).pipe(
      Effect.flatMap(([homes, known]) => {
        const quiet = (input.platform ?? process.platform) === "darwin" && !(input.protectedFolders?.() ?? true);
        return Effect.promise(() => findLocal(input.home, input.excluded, homes, known, now, quiet, input.scanMs ?? SCAN_MS));
      }),
      Effect.catchCause(() => Effect.succeed({ found: [] as Array<Found>, cloneDir: path.join(input.home, "code"), complete: false })),
    );
    const [{ found, cloneDir, complete }, gitHub] = yield* Effect.all([local, orElse(input.gitHub, [])], { concurrency: "unbounded" });
    const overSsh = found.filter((it) => it.repository?.host === "github.com" && it.ssh).length;
    const overHttps = found.filter((it) => it.repository?.host === "github.com" && !it.ssh).length;
    return { candidates: rank(found, gitHub, now), clone_dir: cloneDir, github_ssh: overSsh > overHttps, complete };
  });

/** `child` is `parent` or inside it. */
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

async function findLocal(homeDir: string, excludedDirs: ReadonlyArray<string>, homes: SessionHomes, known: ReadonlyArray<string>, now: number, quiet = false, scanMs = SCAN_MS) {
  const io = scanIo(Date.now() + scanMs);
  const readText = readGitFileKillable;
  const home = path.resolve(homeDir);
  const realHome = await realpath(home).catch(() => home);
  // A quiet scan reads nothing inside a protected folder, nor a project or a session there: even a stat asks.
  const guarded = [...new Set([home, realHome])].flatMap((dir) => PROTECTED_FOLDERS.map((folder) => path.join(dir, folder))).concat("/Volumes");
  const isGuarded = (dir: string) => quiet && guarded.some((root) => inside(root, path.resolve(dir)));
  const excluded = await Promise.all(excludedDirs.map((dir) => realpath(dir).catch(() => path.resolve(dir))));
  const isExcluded = (dir: string) => dir.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`) || excluded.some((ex) => inside(ex, dir)) || isGuarded(dir);
  // Sessions in a temp dir (outside home), Downloads or Codex's per-chat scratch folders are not projects. Those under
  // home are compared as written: resolving them reads inside Documents, which macOS asks about.
  const scratchDirs = [os.tmpdir(), "/tmp", path.join(home, "Downloads"), path.join(home, "Documents", "Codex")];
  const scratch = [...scratchDirs, ...(await Promise.all(scratchDirs.map((dir) => (inside(home, dir) ? dir : realpath(dir).catch(() => dir)))))];
  // A home inside a temp dir (tests) keeps its own folders.
  const isScratch = (dir: string) => scratch.some((root) => inside(root, dir) && !(inside(root, realHome) && (inside(realHome, dir) || inside(home, dir))));

  const found = new Map<string, Promise<Found>>();
  const settled: Array<Found> = [];
  const add = async (dir: string, git: Git, sources: ReadonlyArray<ProjectCandidateSource>, sessionCount = 0, lastMs = 0) => {
    const real = await io(() => realpath(dir)).catch(() => dir);
    if (isExcluded(real) || real === realHome) return;
    let entry = found.get(real);
    if (entry === undefined) {
      entry = Promise.all([originOf(git, io, readText), activityOf(git, io)]).then(([origin, activity]) => {
        const repository = repositoryLinkOf(origin);
        const it: Found = {
          path: real,
          name: path.basename(real),
          ...(repository ? { repository, ssh: !/^https?:/i.test(origin ?? "") } : {}),
          sources: new Set(),
          sessions: 0,
          lastMs: activity,
        };
        settled.push(it);
        return it;
      });
      found.set(real, entry);
    }
    const it = await entry;
    for (const source of sources) it.sources.add(source);
    it.sessions += sessionCount;
    it.lastMs = Math.max(it.lastMs, lastMs);
  };

  // A session's cwd can be anywhere inside its repository: walk up to the checkout. One in a linked worktree
  // (Conductor's, Claude Code's, Codex's, ours) counts for its main checkout; the worktree itself is never offered.
  // A session's checkout in a temp dir is scratch however its cwd was spelled (/var vs /private/var); a project's is not.
  const fromSession = async (cwd: string, sources: ReadonlyArray<ProjectCandidateSource>, sessionCount: number, lastMs: number) => {
    const offer = async (top: string, git: Git) => {
      if (sessionCount > 0 && isScratch(await io(() => realpath(top)).catch(() => top))) return;
      return add(top, git, sources, sessionCount, lastMs);
    };
    for (let dir = path.resolve(cwd); dir !== home && dir !== realHome; ) {
      const git = await gitOf(dir, io, readText);
      if (git !== undefined) {
        if (git.worktreeOf === undefined) return offer(dir, git);
        return git.worktreeOf === null ? undefined : offer(git.worktreeOf, { dir: git.common, common: git.common });
      }
      const up = path.dirname(dir);
      if (up === dir) return;
      dir = up;
    }
  };

  const work = async () => {
    const sessions = await readSessions(homes, now, io);
    await Promise.all([
      ...sessions.filter((s) => !isScratch(path.resolve(s.cwd)) && !isGuarded(s.cwd)).map((s) => fromSession(s.cwd, [s.source], s.sessions, s.lastMs)),
      ...known.filter((dir) => !isGuarded(dir)).map((dir) => fromSession(dir, ["folder"], 0, 0)),
    ]);

    // Siblings of where you already work, and the usual code folders: only folders under home, never home itself.
    const roots = new Set<string>();
    await Promise.all(
      [...CODE_FOLDERS.map((folder) => path.join(home, folder)), ...[...found.keys()].map((dir) => path.dirname(dir))].map(async (dir) => {
        if (isGuarded(dir)) return;
        const real = await io(() => realpath(dir)).catch(() => undefined);
        if (real !== undefined && real !== realHome && inside(realHome, real) && !isExcluded(real) && !isScratch(real)) roots.add(real);
      }),
    );
    const sweep = async (dir: string, depth: number): Promise<void> => {
      const entries = await io(() => fsp.readdir(dir, { withFileTypes: true })).catch(() => []);
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") return;
          const child = path.join(dir, entry.name);
          if (isExcluded(child)) return;
          const git = await gitOf(child, io, readText);
          if (git === undefined) return depth < 2 ? sweep(child, depth + 1) : undefined;
          if (git.worktreeOf === undefined) return add(child, git, ["folder"]);
        }),
      );
    };
    await Promise.all([...roots].map((root) => sweep(root, 1)));
  };
  let timer: NodeJS.Timeout | undefined;
  let cut = false;
  await Promise.race([work(), new Promise<void>((resolve) => (timer = setTimeout(() => ((cut = true), resolve()), scanMs + (SCAN_HARD_MS - SCAN_MS))))]);
  clearTimeout(timer);
  return { found: settled, cloneDir: await cloneDirOf(settled, realHome, isExcluded), complete: !cut && !io.spent() };
}

/** Where project.create clones when there is no discovery to go by: the first usual code folder that exists. */
export async function defaultCloneDir(home: string) {
  for (const folder of CLONE_FALLBACKS) {
    if (await fsp.stat(path.join(home, folder)).then((s) => s.isDirectory(), () => false)) return path.join(home, folder);
  }
  return path.join(home, "code");
}

/** The folder under home holding the most discovered checkouts (ties: the most recently active), else a usual one. */
async function cloneDirOf(found: ReadonlyArray<Found>, home: string, isExcluded: (dir: string) => boolean) {
  const parents = new Map<string, { count: number; lastMs: number }>();
  for (const it of found) {
    const parent = path.dirname(it.path!);
    const relative = path.relative(home, parent);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).some((s) => s.startsWith(".")) || isExcluded(parent)) continue;
    const seen = parents.get(parent) ?? { count: 0, lastMs: 0 };
    parents.set(parent, { count: seen.count + 1, lastMs: Math.max(seen.lastMs, it.lastMs) });
  }
  const best = [...parents].sort(([, a], [, b]) => b.count - a.count || b.lastMs - a.lastMs)[0];
  return best ? best[0] : defaultCloneDir(home);
}

/** GitHub folded into local checkouts, then best first: many sessions, recently. */
function rank(found: ReadonlyArray<Found>, gitHub: ReadonlyArray<GitHubRepository>, now: number): Array<ProjectCandidate> {
  const byRemote = new Map<string, Found>();
  for (const it of found) {
    if (!it.repository) continue;
    const key = normalizeGitRemoteUrl(it.repository.clone_url);
    const seen = byRemote.get(key);
    if (seen === undefined || it.lastMs > seen.lastMs) byRemote.set(key, it);
  }
  const all = [...found];
  for (const repo of gitHub) {
    const repository = repositoryLinkOf(`https://github.com/${repo.full_name}`);
    if (repo.archived || !repository) continue;
    const pushed = Date.parse(repo.pushed_at ?? "") || 0;
    const local = byRemote.get(normalizeGitRemoteUrl(repository.clone_url));
    if (local) {
      local.sources.add("github");
      local.lastMs = Math.max(local.lastMs, pushed);
      if (repo.private !== undefined) local.private = repo.private;
    } else {
      all.push({ name: repository.full_name.split("/").pop()!, repository, sources: new Set(["github"]), sessions: 0, lastMs: pushed, ...(repo.private === undefined ? {} : { private: repo.private }) });
    }
  }
  // A checkout with no remote counts half: scratch and benchmark repositories pile up sessions too.
  const score = (it: Found) =>
    it.lastMs > 0 ? ((it.repository ? 1 : 0.5) * (1 + Math.log2(1 + it.sessions))) / (1 + Math.max(0, now - it.lastMs) / WEEK_MS) : -1;
  return all
    .map((it) => ({ it, score: score(it) }))
    .sort((a, b) => b.score - a.score || a.it.name.localeCompare(b.it.name))
    .slice(0, MAX_CANDIDATES)
    .map(({ it }) => ({
      ...(it.path === undefined ? {} : { path: it.path }),
      name: it.name,
      ...(it.repository ? { repository: it.repository } : {}),
      sources: SOURCE_ORDER.filter((source) => it.sources.has(source)),
      sessions: it.sessions,
      ...(it.lastMs > 0 ? { last_active_at: new Date(it.lastMs).toISOString() } : {}),
      ...(it.private === undefined ? {} : { private: it.private }),
    }));
}
