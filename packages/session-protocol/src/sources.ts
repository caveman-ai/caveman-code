// A project's sources and a chat's checkouts, read the same way whether the project has one source (the wire
// before sources: `Project.sources` and `Workspace.checkouts` absent) or several.
import type { Project, ProjectSource, PullRequest, RepositoryLink, Workspace } from "./protocol.ts";

/** The last segment of a path or of owner/name, as a source's name starts out. */
const lastSegment = (text: string) =>
  text
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? text;

/** A project's sources, its own repository or folder first; for a project with one source, that one. */
export function projectSources(
  project: Pick<Project, "path" | "no_git" | "repository" | "sources">,
): ReadonlyArray<ProjectSource> {
  if (project.sources !== undefined && project.sources.length > 0) return project.sources;
  return [
    {
      kind: project.no_git ? "folder" : "repo",
      name: project.repository
        ? lastSegment(project.repository.full_name)
        : lastSegment(project.path),
      ...(project.repository ? { repository: project.repository } : {}),
      path: project.path,
    },
  ];
}

/** One source a chat works in, the primary or another, as the changes view and the header read them. */
export interface WorkspaceSource {
  /** The folder its checkout sits in under the chat's folder; "" for a chat in one source, whose folder is its checkout. */
  readonly name: string;
  readonly primary: boolean;
  readonly branch: string;
  readonly base_ref: string;
  readonly repository?: RepositoryLink;
  readonly folder?: true;
  readonly pull_request?: PullRequest;
  readonly unmerged?: { readonly files: number; readonly commits: number };
}

/** The sources a chat works in, the primary first; one entry (name "") for a chat in one source. */
export function workspaceSources(
  workspace: Pick<
    Workspace,
    "source" | "checkouts" | "branch" | "base_ref" | "pull_request" | "unmerged"
  >,
): ReadonlyArray<WorkspaceSource> {
  const primary: WorkspaceSource = {
    name: workspace.checkouts === undefined ? "" : (workspace.source ?? ""),
    primary: true,
    branch: workspace.branch,
    base_ref: workspace.base_ref,
    ...(workspace.pull_request ? { pull_request: workspace.pull_request } : {}),
    ...(workspace.unmerged ? { unmerged: workspace.unmerged } : {}),
  };
  return [
    primary,
    ...(workspace.checkouts ?? []).map((checkout): WorkspaceSource => ({
      name: checkout.name,
      primary: false,
      branch: checkout.branch,
      base_ref: checkout.base_ref,
      ...(checkout.repository ? { repository: checkout.repository } : {}),
      ...(checkout.folder ? { folder: true as const } : {}),
      ...(checkout.pull_request ? { pull_request: checkout.pull_request } : {}),
      ...(checkout.unmerged ? { unmerged: checkout.unmerged } : {}),
    })),
  ];
}

/** Whether a chat works in several sources: its paths then start with a source's name. */
export const hasSeveralSources = (workspace: Pick<Workspace, "checkouts">) =>
  workspace.checkouts !== undefined;

/**
 * The source a path of a chat in several sources is in, and the path inside it. For a chat in one source, or a path
 * in none of its sources (a file in the chat's folder itself), the source is "" and the path is as given.
 */
export function sourceOfPath(
  workspace: Pick<Workspace, "source" | "checkouts">,
  file: string,
): { readonly source: string; readonly path: string } {
  if (workspace.checkouts === undefined) return { source: "", path: file };
  const cut = file.indexOf("/");
  const head = cut < 0 ? file : file.slice(0, cut);
  const known =
    head === workspace.source || workspace.checkouts.some((checkout) => checkout.name === head);
  return known
    ? { source: head, path: cut < 0 ? "" : file.slice(cut + 1) }
    : { source: "", path: file };
}

/** Paths grouped by the source they are in, in the chat's source order; one group (source "") for a chat in one source. */
export function groupBySource<T>(
  workspace: Pick<Workspace, "source" | "checkouts">,
  items: ReadonlyArray<T>,
  pathOf: (item: T) => string,
): ReadonlyArray<{ readonly source: string; readonly items: ReadonlyArray<T> }> {
  if (workspace.checkouts === undefined) return [{ source: "", items }];
  const order = [workspace.source ?? "", ...workspace.checkouts.map((checkout) => checkout.name)];
  const groups = new Map<string, Array<T>>();
  for (const item of items) {
    const { source } = sourceOfPath(workspace, pathOf(item));
    const group = groups.get(source);
    if (group) group.push(item);
    else groups.set(source, [item]);
  }
  return [...groups.entries()]
    .sort(
      ([a], [b]) =>
        (order.indexOf(a) < 0 ? order.length : order.indexOf(a)) -
        (order.indexOf(b) < 0 ? order.length : order.indexOf(b)),
    )
    .map(([source, grouped]) => ({ source, items: grouped }));
}
