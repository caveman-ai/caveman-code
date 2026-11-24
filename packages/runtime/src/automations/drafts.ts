// Drafts: automation files that exist only in one of a project's other worktrees (a chat's, a branch someone is
// working on), so the Automations page shows what an agent just wrote without a merge or a copy. A draft runs by
// hand from its worktree; its triggers never fire until it reaches the default branch (rule 1). Worktrees are
// found and watched through the repository's own git dir with plain reads, so a project with hundreds of them
// costs a few hundred stats a second, and git runs only for a file that differs from what the project has.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Scope } from "@caveman-app/automations";

export interface Worktree {
  /** The worktree's top folder. */
  readonly path: string;
  /** The branch checked out there (`caveman/chat-58e341`). */
  readonly branch: string;
}

export interface Draft {
  readonly worktree: Worktree;
  readonly scope: Scope;
  /** Repo-relative, `.caveman/automations/<name>.yaml` or `.caveman/local/automations/<name>.yaml`. */
  readonly path: string;
}

/** Where a worktree keeps automation files, Project and Me. */
export const DIRS: ReadonlyArray<{ readonly rel: string; readonly scope: Scope }> = [
  { rel: ".caveman/automations", scope: "project" },
  { rel: ".caveman/local/automations", scope: "me" },
];
const FILE = /^[a-z][a-z0-9_-]{0,39}\.yaml$/;

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** The repository's common git dir for a checkout: `.git` itself, or what a linked worktree's `.git` file points at. */
export function commonGitDir(root: string): string | undefined {
  const dotGit = path.join(root, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "")?.[1]?.trim();
  if (pointer === undefined) return undefined;
  const gitDir = path.resolve(root, pointer);
  const common = readText(path.join(gitDir, "commondir"))?.trim();
  return common === undefined ? gitDir : path.resolve(gitDir, common);
}

/** The repository's other worktrees that are on a branch and still on disk; `root` itself is never one. */
export function worktreesOf(root: string): Worktree[] {
  const common = commonGitDir(root);
  if (common === undefined) return [];
  let ids: string[];
  try {
    ids = fs.readdirSync(path.join(common, "worktrees"));
  } catch {
    return [];
  }
  const self = realOr(root);
  const out: Worktree[] = [];
  for (const id of ids) {
    const meta = path.join(common, "worktrees", id);
    const gitdir = readText(path.join(meta, "gitdir"))?.trim();
    const head = /^ref: refs\/heads\/(.+)$/m
      .exec(readText(path.join(meta, "HEAD")) ?? "")?.[1]
      ?.trim();
    if (gitdir === undefined || head === undefined) continue;
    const top = path.dirname(gitdir);
    if (!fs.existsSync(top) || realOr(top) === self) continue;
    out.push({ path: top, branch: head });
  }
  return out.sort((a, b) => a.branch.localeCompare(b.branch));
}

const realOr = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** worktreesOf, read again only when git adds, removes or moves a worktree (its `worktrees/` folder changes). */
const listed = new Map<string, { stamp: string; list: Worktree[] }>();
function worktreesCached(root: string, common: string): Worktree[] {
  let stamp = "";
  try {
    const s = fs.statSync(path.join(common, "worktrees"));
    stamp = `${s.mtimeMs}`;
    for (const id of fs.readdirSync(path.join(common, "worktrees")))
      stamp += `|${id}:${fs.statSync(path.join(common, "worktrees", id)).mtimeMs}`;
  } catch {}
  const seen = listed.get(root);
  if (seen !== undefined && seen.stamp === stamp) return seen.list;
  const list = worktreesOf(root);
  listed.set(root, { stamp, list });
  return list;
}

/**
 * A cheap signature of every worktree's automation folders and of origin's branch heads, for the watch's poll:
 * it moves when a file is written, added or removed in any worktree, or a fetch moves the default branch.
 */
export function draftSignature(root: string): string {
  const parts: string[] = [];
  const stamp = (file: string) => {
    try {
      const s = fs.statSync(file);
      parts.push(`${file}:${s.mtimeMs}:${s.size}`);
    } catch {}
  };
  const common = commonGitDir(root);
  if (common !== undefined) {
    stamp(path.join(common, "packed-refs"));
    stamp(path.join(common, "worktrees"));
    try {
      for (const name of fs.readdirSync(path.join(common, "refs", "remotes", "origin")))
        stamp(path.join(common, "refs", "remotes", "origin", name));
    } catch {}
  }
  for (const wt of common === undefined ? [] : worktreesCached(root, common)) {
    for (const dir of DIRS) {
      const abs = path.join(wt.path, dir.rel);
      let names: string[];
      try {
        names = fs.readdirSync(abs);
      } catch {
        continue;
      }
      stamp(abs);
      for (const name of names) if (FILE.test(name)) stamp(path.join(abs, name));
    }
  }
  return parts.join("|");
}

const gitCode = (
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve) =>
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) =>
        resolve({
          code:
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : 1,
          stdout: String(stdout),
        }),
    ),
  );

/**
 * The automation files in the project's other worktrees that the project does not have: new, or different from
 * both its checkout and its default branch. A Project file must also be this branch's own change (uncommitted, or
 * committed since it left the default branch), so an old branch's stale copy of a merged file is never a draft.
 */
export async function draftsOf(input: {
  readonly root: string;
  /** Repo-relative path to text, in the project's checkout. */
  readonly checkout: ReadonlyMap<string, string>;
  /** The same on the default branch. */
  readonly defaultBranch: ReadonlyMap<string, string>;
  /** `origin/main`: what a branch's own changes are measured from. */
  readonly defaultRef: string | undefined;
}): Promise<Draft[]> {
  const out: Draft[] = [];
  for (const worktree of worktreesOf(input.root)) {
    // The branch's own Project changes under .caveman/, asked of git once per worktree and only when a file differs.
    let own: Promise<ReadonlySet<string>> | undefined;
    const ownChanges = () => (own ??= ownChangesOf(worktree.path, input.defaultRef));
    for (const dir of DIRS) {
      let names: string[];
      try {
        names = fs
          .readdirSync(path.join(worktree.path, dir.rel))
          .filter((n) => FILE.test(n))
          .sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const rel = `${dir.rel}/${name}`;
        const text = readText(path.join(worktree.path, rel));
        if (
          text === undefined ||
          text === input.checkout.get(rel) ||
          text === input.defaultBranch.get(rel)
        )
          continue;
        if (dir.scope === "project" && !(await ownChanges()).has(rel)) continue;
        out.push({ worktree, scope: dir.scope, path: rel });
      }
    }
  }
  return out;
}

/** Paths under `.caveman/automations` the worktree changed: uncommitted (or untracked), or committed since it left the default branch. */
async function ownChangesOf(
  worktree: string,
  defaultRef: string | undefined,
): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  const status = await gitCode(worktree, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--",
    ".caveman/automations",
  ]);
  // `XY path` entries; a rename's second (old) path follows as its own entry and is harmless here.
  for (const entry of status.stdout.split("\0")) if (entry.length > 3) out.add(entry.slice(3));
  if (defaultRef !== undefined) {
    const committed = await gitCode(worktree, [
      "diff",
      "--name-only",
      "-z",
      `${defaultRef}...HEAD`,
      "--",
      ".caveman/automations",
    ]);
    if (committed.code === 0)
      for (const p of committed.stdout.split("\0")) if (p !== "") out.add(p);
  }
  return out;
}

/** A project reference: a project id, or `<project id>@<branch>` for a draft in that branch's worktree. Git refuses `:` in branch names, so a draft's automation id still parses from the right. */
export function splitProjectRef(ref: string): {
  readonly projectId: string;
  readonly branch?: string;
} {
  const at = ref.indexOf("@");
  return at <= 0 ? { projectId: ref } : { projectId: ref.slice(0, at), branch: ref.slice(at + 1) };
}

export const draftProjectRef = (projectId: string, branch: string) => `${projectId}@${branch}`;
