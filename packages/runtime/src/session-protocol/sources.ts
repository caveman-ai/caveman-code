// Projects with several sources (docs/ §2). A chat that works in several
// sources of its project has one folder (its record's worktreePath, the engine's working directory) holding a git
// worktree per source, side by side under the sources' names; every path such a chat names starts with the name of
// the source it is in. A chat in one source is exactly what it was before sources: its folder is its worktree, its
// paths are the worktree's, and nothing here adds a field to it.
import * as path from "node:path";

import type {
  FileChange,
  ProjectSource,
  PullRequest,
  RepositoryLink,
  Workspace,
  WorkspaceCheckout,
} from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import { SOURCE_NAME } from "../checkpointing/SourceRoots.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { chatChanges } from "./lifecycle.ts";
import type { WorkspaceRecord } from "./store.ts";

type Git = GitVcsDriver.GitVcsDriver["Service"];

/** One source a chat works in, as git is run on it. */
export interface SourceCheckout {
  /** Its folder in the chat's folder; "" for a chat in one source. */
  readonly name: string;
  /** What its paths start with when read from the chat's folder: `name/`, or "" for a chat in one source. */
  readonly prefix: string;
  readonly primary: boolean;
  /** The repository its worktree is one of (or the plain folder itself). */
  readonly repoPath: string;
  /** Its worktree: the chat's folder for a chat in one source, else the folder `name` in it. */
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  /** A plain folder linked into the chat's folder: git never runs on it. */
  readonly folder?: true;
  readonly repository?: RepositoryLink;
}

/** Whether a chat works in several sources: its worktreePath is then a folder of worktrees, not a worktree. */
export const severalSources = (record: Pick<WorkspaceRecord, "internal">) =>
  record.internal.sources !== undefined && record.internal.sources.length > 0;

/**
 * The sources a chat works in, the primary first. A chat in one source has one, with no name and no prefix, at its
 * own worktree: code written over this list does for that chat what it did before sources.
 */
export function checkoutsOf(record: WorkspaceRecord): ReadonlyArray<SourceCheckout> {
  const root = record.internal.worktreePath ?? "";
  const sources = record.internal.sources;
  if (sources === undefined || sources.length === 0) {
    return [
      {
        name: "",
        prefix: "",
        primary: true,
        repoPath: record.internal.repoPath ?? root,
        worktreePath: root,
        branch: record.workspace.branch,
        baseRef: record.workspace.base_ref,
      },
    ];
  }
  return sources.map((source, index): SourceCheckout => {
    const wire =
      index === 0
        ? undefined
        : record.workspace.checkouts?.find((checkout) => checkout.name === source.name);
    return {
      name: source.name,
      prefix: `${source.name}/`,
      primary: index === 0,
      repoPath: source.repoPath,
      worktreePath: path.join(root, source.name),
      branch: index === 0 ? record.workspace.branch : (wire?.branch ?? record.workspace.branch),
      baseRef: index === 0 ? record.workspace.base_ref : (wire?.base_ref ?? ""),
      ...(source.folder ? { folder: true as const } : {}),
      ...(wire?.repository ? { repository: wire.repository } : {}),
    };
  });
}

/** The sources git runs on (a plain folder has no repository). */
export const gitCheckoutsOf = (record: WorkspaceRecord) =>
  checkoutsOf(record).filter((checkout) => !checkout.folder);

/** A source's folder name from what it is called: one safe path segment, unique among `taken` (-2, -3 …). */
export function sourceName(wanted: string, taken: ReadonlySet<string>): string {
  const base =
    wanted
      .replace(/\.git$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .slice(0, 48)
      .replace(/[.-]+$/, "") || "source";
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (SOURCE_NAME.test(name) && !taken.has(name.toLowerCase())) return name;
  }
}

/** Files of one source as the chat names them. */
export const prefixChanges = <
  T extends { readonly path: string; readonly old_path?: string | undefined },
>(
  files: ReadonlyArray<T>,
  prefix: string,
): Array<T> =>
  prefix === ""
    ? [...files]
    : files.map((file) => ({
        ...file,
        path: `${prefix}${file.path}`,
        ...(file.old_path === undefined ? {} : { old_path: `${prefix}${file.old_path}` }),
      }));

/**
 * A chat's changes (the Changes card, diff.changed): each source's working tree against where its branch left its
 * base, every source's files in one list. For a chat in one source this is chatChanges of its worktree.
 */
export const recordChanges = (driver: Git, record: WorkspaceRecord) =>
  Effect.gen(function* () {
    const files: Array<typeof FileChange.Type> = [];
    for (const checkout of gitCheckoutsOf(record)) {
      files.push(
        ...prefixChanges(
          yield* chatChanges(driver, checkout.worktreePath, checkout.baseRef),
          checkout.prefix,
        ),
      );
    }
    return files;
  });

/** The paths of `paths` that are in the source `checkout`, as that source names them; undefined when `paths` is. */
export function pathsIn(
  checkout: SourceCheckout,
  paths: ReadonlyArray<string> | undefined,
): Array<string> | undefined {
  if (paths === undefined) return undefined;
  if (checkout.prefix === "") return [...paths];
  return paths.flatMap((file) => {
    const normal = file.replace(/^\.\//, "");
    return normal.startsWith(checkout.prefix) && normal.length > checkout.prefix.length
      ? [normal.slice(checkout.prefix.length)]
      : [];
  });
}

/** The source of a chat a path is in; undefined for a path in none (a file in the chat's folder itself). */
export const checkoutOfPath = (checkouts: ReadonlyArray<SourceCheckout>, file: string) => {
  const normal = file.replace(/^\.\//, "");
  return checkouts.find(
    (checkout) =>
      checkout.prefix === "" || normal === checkout.name || normal.startsWith(checkout.prefix),
  );
};

/** What a source is called to a person: its repository (owner/name), else its folder's name. */
export const sourceLabel = (source: {
  readonly name: string;
  readonly repository?: RepositoryLink | undefined;
}) => source.repository?.full_name ?? source.name;

/**
 * What the engine is told when it starts working in several sources, or gains one: where each is, that each is its
 * own repository, and what becomes of its commits. `added`: the sources it has not been told of yet.
 */
export function sourcesNote(input: {
  readonly sources: ReadonlyArray<{
    readonly name: string;
    readonly label: string;
    readonly branch: string;
    readonly folder?: boolean;
    readonly focus?: string | undefined;
  }>;
  readonly added: ReadonlyArray<string>;
  /** The chat was in one source until now: what was in its folder is in that source's folder from here on. */
  readonly movedInto?: string;
}): string {
  const line = (source: (typeof input.sources)[number]) =>
    source.folder
      ? `- ${source.name}/: the folder ${source.label} (not a git repository; edits there are made in place)`
      : `- ${source.name}/: ${source.label}, on branch ${source.branch}${source.focus ? ` (this project is about ${source.focus}/ in it)` : ""}`;
  const all = input.sources.map(line).join("\n");
  const first = input.added.length === input.sources.length && input.movedInto === undefined;
  const head = first
    ? "[Caveman Code] This chat works in several repositories of one project. Your working directory is a folder that holds a checkout of each, side by side:"
    : input.movedInto !== undefined
      ? `[Caveman Code] This chat now works in several repositories. Your working directory is the same folder, which now holds a checkout of each: what was in it before is in ${input.movedInto}/ (so a path you used before now starts with ${input.movedInto}/), and ${input.added.filter((name) => name !== input.movedInto).join(", ") || "another"} was added beside it:`
      : `[Caveman Code] ${input.added.join(", ")} was added to this chat. Your working directory now holds:`;
  return `${head}\n${all}\nEach is its own git repository on its own branch: run git inside its folder, never in the folder that holds them. Read and edit across them with relative paths. Commit in each repository you change; the chat opens one pull request per repository it changed, each naming the others.`;
}

/**
 * The lines a pull request's description ends with when its chat changed several repositories: the others, each by
 * its pull request when that is open already, else by its repository and branch.
 */
export function relatedPullRequests(
  others: ReadonlyArray<{
    readonly label: string;
    readonly branch: string;
    readonly pull_request?: Pick<PullRequest, "number" | "url"> | undefined;
  }>,
): string {
  if (others.length === 0) return "";
  const lines = others.map((other) =>
    other.pull_request
      ? `- ${other.label}: ${other.pull_request.url}`
      : `- ${other.label}: branch \`${other.branch}\``,
  );
  return `Part of one change across ${others.length + 1} repositories. The others:\n${lines.join("\n")}`;
}

/** A pull request's description with the related ones under it. */
export const withRelated = (body: string | undefined, related: string) =>
  related === ""
    ? (body ?? "")
    : [body?.trim() ?? "", related].filter((part) => part !== "").join("\n\n");

/**
 * Why a chat in several sources stays on the computer it is on (SPEC §2). A move carries every source of a chat or
 * none, and a copy carries the files of one source so far: until it carries each, such a chat does not move, and
 * says so. The source that could never go is named first: a plain folder, which is on its own computer alone, then
 * a repository that is not on GitHub, which no other computer could check out.
 */
export function whySourcesStay(
  sources: ReadonlyArray<
    Pick<SourceCheckout, "name" | "primary" | "folder" | "repository" | "repoPath">
  >,
): string {
  const folder = sources.find((source) => source.folder);
  if (folder !== undefined)
    return `This chat stays here: it works in the folder ${folder.name} (${folder.repoPath}), which is on this computer alone.`;
  // Another source's link is the wire's (Workspace.checkouts); the primary's is asked of its checkout by the move's own check.
  const local = sources.find(
    (source) => !source.primary && source.repository?.host !== "github.com",
  );
  if (local !== undefined)
    return `This chat stays here: ${local.name} isn't on GitHub, so another computer can't check it out.`;
  return `This chat stays here: it works in ${sources.length} repositories (${sources.map((source) => source.name).join(", ")}), and a move carries the files of one for now.`;
}

/** Workspace.checkouts' entry for one source of a project, as a chat starts in it. */
export function wireCheckout(
  source: Pick<ProjectSource, "name" | "kind" | "repository">,
  repo: Workspace["repo"],
  branch: string,
  baseRef: string,
): WorkspaceCheckout {
  return {
    name: source.name,
    repo,
    ...(source.repository ? { repository: source.repository } : {}),
    base_ref: source.kind === "folder" ? "" : baseRef,
    branch: source.kind === "folder" ? "" : branch,
    ...(source.kind === "folder" ? { folder: true as const } : {}),
  };
}

/** A workspace with one checkout changed (its pull request, its unmerged count); the workspace itself when nothing did. */
export function withCheckout(
  workspace: Workspace,
  name: string,
  change: (checkout: WorkspaceCheckout) => WorkspaceCheckout,
): Workspace {
  if (workspace.checkouts === undefined) return workspace;
  let changed = false;
  const checkouts = workspace.checkouts.map((checkout) => {
    if (checkout.name !== name) return checkout;
    const next = change(checkout);
    if (next !== checkout) changed = true;
    return next;
  });
  return changed ? { ...workspace, checkouts } : workspace;
}
