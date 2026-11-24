/**
 * Space checkout. A space (v0) is a git repo URL at a pinned commit, checked
 * out read-only under the runtime state dir. A checkout is immutable and
 * keyed by commit, so a session sees the same files from start to end and an
 * update lands at the next session start. A checkout is hashed when it is made
 * and re-hashed each time it is reused (the registry reuses one once per
 * runtime); one that changed on disk is replaced by a fresh checkout.
 *
 * Nothing from the repo runs here: no hooks (git never transfers them), no
 * submodules, no LFS filters, and only https, ssh and file transports.
 *
 * @module plugins/spaces
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, statSync, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export class SpaceCheckoutError extends Error {}

/** A full commit: SHA-1, or SHA-256 for a repository that uses it. */
export const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A readable name from the URL: `git@github.com:acme/bird-backend.git` is `bird-backend`. */
export function spaceNameFor(url: string): string {
  const base = url.replace(/[/\\]+$/, "").replace(/\.git$/, "").split(/[/\\:]/).pop() ?? "";
  const id = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return id === "" ? "space" : id;
}

/**
 * The space's id, `<name>-<urlhash>`: stable whatever else is in Settings, so
 * a plugin id (`<plugin>@<space>`) always names the same repo.
 */
export function spaceIdFor(url: string): string {
  return `${spaceNameFor(url)}-${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
}

/** A fetch that takes longer than this is killed; the space then counts as failed. */
const GIT_TIMEOUT_MS = 120_000;

/** git, never prompting, never hanging past the timeout. `env` adds variables (GIT_INDEX_FILE); `input` goes to stdin. */
export async function git(args: ReadonlyArray<string>, cwd?: string, opts: { readonly env?: Record<string, string>; readonly input?: string } = {}): Promise<string> {
  const pending = run("git", args, {
    cwd,
    env: {
      ...process.env,
      ...opts.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "https:ssh:file",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_LFS_SKIP_SMUDGE: "1",
      // ssh asks about unknown host keys on the terminal, which GIT_TERMINAL_PROMPT does not cover.
      ...(process.env.GIT_SSH_COMMAND === undefined && process.env.GIT_SSH === undefined
        ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }
        : {}),
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (opts.input !== undefined) pending.child.stdin?.end(opts.input);
  const { stdout } = await pending;
  return stdout.trim();
}

/**
 * Clears the write bits of every file, keeping exec bits, so nothing edits a
 * checkout in place. Directories stay writable so the tree can be deleted.
 */
export async function makeReadOnly(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    await fs.chmod(file, (await fs.stat(file)).mode & 0o555);
  }
}

/** Throws unless `url` is a git URL or an absolute path (git runs in a temp dir, so a relative path would point elsewhere). */
export function checkSpaceUrl(url: string): void {
  const isRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\s]+@[^/\s]+:/.test(url);
  if (url.startsWith("-") || (!isRemote && !path.isAbsolute(url))) {
    throw new SpaceCheckoutError(`use a git URL or an absolute path: ${url}`);
  }
  // A token in the URL (https://user:ghp_xxx@host/…) would land in settings.json, in
  // SpaceInfo sent to the client, and in git argv every local process can see. Refuse it.
  try {
    if (new URL(url).password !== "") {
      throw new SpaceCheckoutError("remove the password from the URL; use SSH or a git credential helper");
    }
  } catch (cause) {
    if (cause instanceof SpaceCheckoutError) throw cause;
    // Not a parseable URL (scp-style or a path): no userinfo to leak.
  }
}

/** The commit `ref` (a branch, tag or HEAD; default HEAD) names in the repo at `url`. A full commit id is taken as it is. */
export async function resolveSpaceRef(url: string, ref = "HEAD"): Promise<string> {
  checkSpaceUrl(url);
  if (COMMIT.test(ref)) return ref;
  if (ref.startsWith("-")) throw new SpaceCheckoutError(`not a ref: ${ref}`);
  let out: string;
  try {
    out = await git(["ls-remote", "--", url, ref]);
  } catch (cause) {
    const detail = (cause as { stderr?: string }).stderr?.trim() || (cause as Error).message;
    throw new SpaceCheckoutError(`${url}: ${detail}`);
  }
  // ls-remote matches ref patterns loosely; prefer the exact name, then the branch, then the tag.
  const lines = out.split("\n").map((line) => line.split("\t") as [string, string]);
  const commit = [ref, `refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]
    .map((name) => lines.find(([, n]) => n === name)?.[0])
    .find((sha) => sha !== undefined && COMMIT.test(sha));
  if (commit === undefined) throw new SpaceCheckoutError(`${url} has no ${ref}`);
  return commit;
}

/** A digest of a tree: each entry's path and kind, a file's exec bit and bytes, a link's target. */
export async function treeDigest(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = (await fs.readdir(dir, { withFileTypes: true, recursive: true }))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
  for (const rel of entries) {
    const file = path.join(dir, rel);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) hash.update(`l\0${rel}\0${await fs.readlink(file)}\0`);
    else if (stat.isDirectory()) hash.update(`d\0${rel}\0`);
    else {
      const bytes = await fs.readFile(file);
      hash.update(`f\0${rel}\0${stat.mode & 0o111 ? "x" : "-"}\0${bytes.length}\0`).update(bytes);
    }
  }
  return hash.digest("hex");
}

/**
 * What changes when anything in a tree does, read without opening a file: each
 * entry's path, mode, size, mtime and ctime (which no one sets back). Equal
 * stamps mean treeDigest would answer the same. ponytail: a write that keeps
 * size, mtime and ctime to the nanosecond goes unseen; that takes root.
 */
export async function treeStamp(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = (await fs.readdir(dir, { withFileTypes: true, recursive: true }))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
  // Every turn stamps the session's plugin trees (~/.agents/skills alone can be 700+ files): asked one at a time,
  // each lstat waited its turn on a busy event loop, 1.4-4.3 s a turn on a loaded Mac. Asked together, one wait.
  const stats = await Promise.all(entries.map((rel) => fs.lstat(path.join(dir, rel), { bigint: true })));
  entries.forEach((rel, i) => {
    const stat = stats[i]!;
    hash.update(`${rel}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
  });
  return hash.digest("hex");
}

interface WatchedStamp {
  stamp: Promise<string>;
  /** When the walk behind `stamp` began (performance.now()). */
  walked: number;
  readonly folder: string;
  readonly forget: () => void;
}
const watchedStamps = new Map<string, WatchedStamp>();
// One recursive watch from the OS (FSEvents, ReadDirectoryChangesW) sees the whole tree once it runs. Node builds
// Linux's from a watch per folder, added while it walks the tree, so a change in that walk can go unheard.
const WATCHES_WHOLE_TREES = process.platform === "darwin" || process.platform === "win32";
/**
 * FSEvents runs one stream for every directory watch in the process and starts it again, on a thread of its own, a
 * moment after any of them opens or closes; what changes until it runs reaches no watch, ever (measured: a write at
 * once after a watch opened, here or on another tree, went unheard 2 to 6 times in 30; none 200 ms on). A stamp is
 * trusted once a walk begun this long after the latest such start here agrees with it; until then each call walks
 * again. Windows' watch runs as it opens.
 */
export const WATCH_SETTLE_MS = 1000;
/**
 * The longest a stamp is trusted without a walk on macOS. Other code in the process (automations, settings,
 * keybindings, Cloud sync) opens and closes directory watches of its own, which start the stream again unseen here: a
 * change made then is seen by the walk this bound forces. A walk of ~/.agents/skills (975 entries) took 40-90 ms on a
 * loaded Mac.
 */
export const WATCH_TRUST_MS = 60_000;
const STREAM_RESTARTS = process.platform === "darwin";
let streamStarted = Number.NEGATIVE_INFINITY;
const streamRestarts = () => {
  if (STREAM_RESTARTS) streamStarted = performance.now();
};

// The watched folder itself, by identity. Windows' watch hears what happens under the folder but nothing when the
// folder is moved: one moved aside and made again under the same name is caught here, with one stat per call.
function folderIdentity(dir: string): string | undefined {
  try {
    const stat = statSync(dir, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

/**
 * treeStamp, taken again only once something under `dir` changed. A turn checks its plugin trees (~/.agents/skills
 * and each plugin copy, 700+ files here) every time it starts; walking them was 0.2-1.5 s of every turn on a loaded
 * Mac. A recursive watch, opened before the walk, drops the stamp at its first event and closes (the next call
 * watches anew), and a folder that is no longer the one watched drops it too, so a tree that was moved, removed or
 * replaced is never trusted on an old watch. Until a walk begun WATCH_SETTLE_MS after the latest watch here opened or
 * closed agrees (FSEvents drops what changes before it runs again), the tree is walked on every call, and a stamp is
 * walked again WATCH_TRUST_MS after its walk (another module's watch starts the stream again unseen). A tree that
 * cannot be watched (or on Linux) is stamped on every call. ponytail: the watch hears a change milliseconds after it
 * (FSEvents' delivery, 1-14 ms measured), so a call that close behind a change to a settled tree sees it on its next
 * call.
 */
export function watchedTreeStamp(dir: string): Promise<string> {
  if (!WATCHES_WHOLE_TREES) return treeStamp(dir);
  const folder = folderIdentity(dir);
  const known = watchedStamps.get(dir);
  if (known !== undefined) {
    if (known.folder === folder) {
      const now = performance.now();
      if (known.walked >= streamStarted + WATCH_SETTLE_MS && (!STREAM_RESTARTS || now - known.walked < WATCH_TRUST_MS)) return known.stamp;
      known.walked = now;
      known.stamp = treeStamp(dir);
      known.stamp.catch(known.forget);
      return known.stamp;
    }
    known.forget();
  }
  if (folder === undefined) return treeStamp(dir);
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { recursive: true, persistent: false });
  } catch {
    return treeStamp(dir);
  }
  streamRestarts();
  const walked = performance.now();
  const stamp = treeStamp(dir);
  const entry: WatchedStamp = {
    stamp,
    walked,
    folder,
    forget: () => {
      watcher.close();
      streamRestarts();
      if (watchedStamps.get(dir) === entry) watchedStamps.delete(dir);
    },
  };
  watcher.once("change", entry.forget);
  watcher.once("error", entry.forget);
  watchedStamps.set(dir, entry);
  stamp.catch(entry.forget);
  return stamp;
}

/** Each file's kind, exec bit and content hash (a link's target), by repo-relative posix path. */
async function fileSignatures(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) continue;
    const signature = stat.isSymbolicLink()
      ? `l:${await fs.readlink(file)}`
      : `f:${stat.mode & 0o111 ? "x" : "-"}:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`;
    out.set(path.relative(dir, file).split(path.sep).join("/"), signature);
  }
  return out;
}

/** Repo-relative paths added, removed or changed between two checkouts, sorted. */
export async function changedPaths(from: string, to: string): Promise<Array<string>> {
  const [a, b] = await Promise.all([fileSignatures(from), fileSignatures(to)]);
  return [...new Set([...a.keys(), ...b.keys()])].filter((rel) => a.get(rel) !== b.get(rel)).sort();
}

const exists = (file: string) => fs.stat(file).then(() => true, () => false);

/**
 * Checks `url` out at `commit` into `<spacesDir>/<id>-<urlhash>/<commit>`,
 * read-only, and returns that directory. An existing checkout is reused once
 * its digest (`<commit>.sha256` beside it) matches; otherwise it is removed,
 * `onReplaced` hears why, and the space is checked out again.
 */
export async function checkoutSpace(input: {
  readonly url: string;
  readonly commit: string;
  readonly spacesDir: string;
  readonly onReplaced?: (reason: string) => void;
}): Promise<string> {
  const { url, commit } = input;
  if (!COMMIT.test(commit)) throw new SpaceCheckoutError(`not a full commit id: ${commit}`);
  checkSpaceUrl(url);
  const parent = path.join(input.spacesDir, spaceIdFor(url));
  const target = path.join(parent, commit);
  const digestFile = path.join(parent, `${commit}.sha256`);
  // Re-hashes the whole checkout: seconds for large marketplaces, so the registry keeps one it verified (PluginRegistry `checkout`).
  if (await exists(target)) {
    const want = await fs.readFile(digestFile, "utf8").catch(() => "");
    if (want === "") {
      // A checkout made before digests existed (or after an interrupted write): trust it
      // on first use and record a digest, rather than deleting it — a re-fetch offline
      // would fail and lose the space's plugins.
      await fs.writeFile(digestFile, `${await treeDigest(target)}\n`);
      return target;
    }
    if ((await treeDigest(target)) === want.trim()) return target;
    input.onReplaced?.(`${url} at ${commit.slice(0, 12)}: the checkout changed on disk; checked out again`);
    await fs.rm(target, { recursive: true, force: true });
  }

  await fs.mkdir(parent, { recursive: true });
  const tmp = path.join(parent, `.tmp-${randomUUID()}`);
  try {
    await git(["init", "-q", tmp]);
    try {
      await git(["fetch", "-q", "--no-tags", "--depth=1", "--", url, commit], tmp);
    } catch {
      // Servers that refuse a fetch by commit id: fetch the branches, then look for it.
      await git(["fetch", "-q", "--no-tags", "--", url, "+refs/heads/*:refs/remotes/space/*"], tmp);
    }
    await git(["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit], tmp);
    const head = await git(["rev-parse", "HEAD"], tmp);
    if (head !== commit) throw new SpaceCheckoutError(`checked out ${head}, wanted ${commit}`);
    await fs.rm(path.join(tmp, ".git"), { recursive: true, force: true });
    await makeReadOnly(tmp);
    await fs.writeFile(digestFile, `${await treeDigest(tmp)}\n`);
    await fs.rename(tmp, target);
  } catch (cause) {
    await fs.rm(tmp, { recursive: true, force: true });
    // Another session finished the same checkout first.
    if (await exists(target)) return target;
    if (cause instanceof SpaceCheckoutError) throw cause;
    const detail = (cause as { stderr?: string }).stderr?.trim() || (cause as Error).message;
    throw new SpaceCheckoutError(`${url} at ${commit}: ${detail}`);
  }
  return target;
}
