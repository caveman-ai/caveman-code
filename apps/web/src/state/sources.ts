// A project's sources and the chats that work in several of them, as the screens read them: what a chat can still
// add, which sources a new chat works in (and whether Cloud can have them), and changed files under their source.
// A chat in one source reads none of this: every function here answers null, [] or its input for one.
import {
  groupBySource,
  hasSeveralSources,
  projectSources,
  sourceOfPath,
  workspaceSources,
  type Project,
  type ProjectSource,
  type PullRequest,
  type Workspace,
  type WorkspaceSource,
} from "@caveman-app/session-protocol";
import { thisComputer } from "../lib/platform.ts";

/** What the screens read of a chat in several sources: its sources, each one's branch and pull request. */
export type ChatSources = Pick<
  Workspace,
  "source" | "checkouts" | "branch" | "base_ref" | "pull_request" | "unmerged"
>;

/** A chat in several sources, cut to what its screens read; null for a chat in one source. */
export function chatSources(workspace: ChatSources | undefined): ChatSources | null {
  if (!workspace || !hasSeveralSources(workspace)) return null;
  return {
    branch: workspace.branch,
    base_ref: workspace.base_ref,
    ...(workspace.source !== undefined ? { source: workspace.source } : {}),
    ...(workspace.checkouts ? { checkouts: workspace.checkouts } : {}),
    ...(workspace.pull_request ? { pull_request: workspace.pull_request } : {}),
    ...(workspace.unmerged ? { unmerged: workspace.unmerged } : {}),
  };
}

const samePlace = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

/** The source of its project a chat in one source works in: the one its repository is, else the project's own. */
function ownSource(
  sources: ReadonlyArray<ProjectSource>,
  repo: Workspace["repo"],
): ProjectSource | undefined {
  const found =
    "path" in repo
      ? sources.find((s) => s.path !== undefined && samePlace(s.path, repo.path))
      : sources.find(
          (s) =>
            s.repository !== undefined &&
            (s.repository.clone_url === repo.url ||
              repo.url
                .replace(/\.git$/, "")
                .toLowerCase()
                .endsWith(`/${s.repository.full_name.toLowerCase()}`)),
        );
  return found ?? sources[0];
}

/**
 * The sources of its project a chat does not work in yet, in the project's order: what workspace.add_source can add.
 * None for a chat with no repository of its own (a Chief's), an archived or sleeping one, and a project with one
 * source. A plain folder stays on its Mac, so a chat on another computer is never offered one.
 */
export function addableSources(
  project: Pick<Project, "path" | "no_git" | "repository" | "sources"> | undefined,
  workspace: Pick<Workspace, "source" | "checkouts" | "repo" | "kind" | "status" | "computer">,
): ReadonlyArray<ProjectSource> {
  if (
    !project ||
    workspace.kind !== undefined ||
    workspace.status === "archived" ||
    workspace.status === "parked"
  )
    return [];
  const sources = projectSources(project);
  if (sources.length < 2) return [];
  const has = hasSeveralSources(workspace)
    ? new Set([workspace.source ?? "", ...(workspace.checkouts ?? []).map((c) => c.name)])
    : new Set([ownSource(sources, workspace.repo)?.name ?? ""]);
  return sources.filter(
    (s) => !has.has(s.name) && (s.kind !== "folder" || workspace.computer.kind === "this_mac"),
  );
}

/** A source in one short line: its repository as its host names it, else the folder it is. */
export function sourceLine(
  source: Pick<ProjectSource, "kind" | "repository">,
  here: string = thisComputer,
): string {
  if (source.repository) return source.repository.full_name;
  return source.kind === "folder" ? "Folder" : `Repository on ${here}`;
}

// ------------------------------------------------------------------ a new chat's sources

const LEFT_OUT = "caveman.newChat.sourcesLeftOut";

function readLeftOut(storage: Pick<Storage, "getItem">): Record<string, ReadonlyArray<string>> {
  try {
    const kept = JSON.parse(storage.getItem(LEFT_OUT) ?? "{}") as unknown;
    return kept !== null && typeof kept === "object" && !Array.isArray(kept)
      ? (kept as Record<string, ReadonlyArray<string>>)
      : {};
  } catch {
    return {};
  }
}

/** The sources the person left out of this project's new chats last time, by name; none: every source. */
export function leftOutSources(
  storage: Pick<Storage, "getItem">,
  projectId: string,
): ReadonlyArray<string> {
  const names = readLeftOut(storage)[projectId];
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
}

/** Remembers what the person left out, per project: a source added to the project later starts ticked. */
export function rememberLeftOut(
  storage: Pick<Storage, "getItem" | "setItem">,
  projectId: string,
  names: ReadonlyArray<string>,
): void {
  const { [projectId]: _, ...rest } = readLeftOut(storage);
  storage.setItem(
    LEFT_OUT,
    JSON.stringify(names.length > 0 ? { ...rest, [projectId]: names } : rest),
  );
}

/** The sources a new chat works in: the project's own (first) always, each other unless left out. */
export function tickedSources(
  sources: ReadonlyArray<ProjectSource>,
  leftOut: ReadonlyArray<string>,
): ReadonlyArray<ProjectSource> {
  return sources.filter((s, i) => i === 0 || !leftOut.includes(s.name));
}

/** What is left out once `name` is ticked or unticked; the first source never is. */
export function toggleSource(
  sources: ReadonlyArray<ProjectSource>,
  leftOut: ReadonlyArray<string>,
  name: string,
): ReadonlyArray<string> {
  if (sources[0]?.name === name) return leftOut;
  const known = leftOut.filter((n) => sources.some((s) => s.name === n));
  return known.includes(name) ? known.filter((n) => n !== name) : [...known, name];
}

/** The chip's words: the repositories and folders the chat works in, by name ("api, web, notes"). */
export function sourcesLabel(ticked: ReadonlyArray<ProjectSource>): string {
  return ticked.map((s) => s.name).join(", ");
}

/** workspace.create's `sources`: the ticked names when more than the first is ticked; else nothing, as before sources. */
export function createSources(ticked: ReadonlyArray<ProjectSource>): { sources?: Array<string> } {
  return ticked.length > 1 ? { sources: ticked.map((s) => s.name) } : {};
}

const onGitHub = (source: ProjectSource) => source.repository?.host === "github.com";

/**
 * The ticked sources a chat in Cloud is started without: only a repository on GitHub goes there, so a plain folder and
 * a repository with no GitHub link stay on this computer. The app leaves them out; it never asks the person to untick
 * them. The project's own source is the Cloud row's own to refuse (state/environment.ts).
 */
export function cloudLeavesOut(ticked: ReadonlyArray<ProjectSource>): ReadonlyArray<ProjectSource> {
  return ticked.slice(1).filter((s) => !onGitHub(s));
}

/** The sources a chat works in where it runs: every ticked one on a Mac, the ones Cloud can have in Cloud. */
export function sourcesFor(
  ticked: ReadonlyArray<ProjectSource>,
  cloud: boolean,
): ReadonlyArray<ProjectSource> {
  if (!cloud) return ticked;
  const out = new Set(cloudLeavesOut(ticked).map((s) => s.name));
  return ticked.filter((s) => !out.has(s.name));
}

/** What the run-on pill adds for what Cloud left out: "without notes", "without notes and docs", "without notes and 2 more". */
export function withoutLabel(left: ReadonlyArray<Pick<ProjectSource, "name">>): string | null {
  const [first, second] = left;
  if (!first) return null;
  if (!second) return `without ${first.name}`;
  return left.length === 2
    ? `without ${first.name} and ${second.name}`
    : `without ${first.name} and ${left.length - 1} more`;
}

/**
 * The run-on pill once Cloud is picked: Cloud's own words (state/environment.ts runOnLabel: "Cloud",
 * "Cloud · setting up 3/5", "Cloud · setup failed") with what it was started without right after "Cloud".
 */
export function cloudPill(chip: string, without: string | null): string {
  if (without === null) return chip;
  const state = chip.startsWith("Cloud · ") ? chip.slice("Cloud · ".length) : null;
  return state === null ? `Cloud · ${without}` : `Cloud · ${without} · ${state}`;
}

/**
 * Chats in several repositories do not move between a Mac and Cloud yet. One switch: when they do, this turns true
 * and the line below is never said.
 */
export const SEVERAL_REPOSITORIES_MOVE = false;

/**
 * What New chat says before Send when the chat would not keep going in Cloud although the person chose that: the
 * words the move menu uses. `keepsGoing`: Settings > Computers' "Keep chats going in Cloud" is on. Null when nothing
 * needs saying.
 */
export function staysOnMacLine(
  sources: number,
  keepsGoing: boolean,
  here: string = thisComputer,
): string | null {
  if (SEVERAL_REPOSITORIES_MOVE || !keepsGoing || sources < 2) return null;
  return `Chats in several repositories stay on ${here}.`;
}

/**
 * A Cloud start in several sources: cloud.workspace.create's `checkouts` (the other repositories) and the `sources`
 * its workspace.create names on the Cloud computer (every repository by owner/name, the project's own first).
 * Nothing for a chat in the first source alone.
 */
export function cloudSources(ticked: ReadonlyArray<ProjectSource>): {
  checkouts?: Array<{ repo: string }>;
  sources?: Array<string>;
} {
  const repos = ticked.filter(onGitHub).map((s) => s.repository!.full_name);
  const others = ticked
    .slice(1)
    .filter(onGitHub)
    .map((s) => s.repository!.full_name);
  return others.length > 0 ? { checkouts: others.map((repo) => ({ repo })), sources: repos } : {};
}

// ------------------------------------------------------------------ changed files, by source

/** One source's changed files: the source (null: files in the chat's folder, in none of its sources) and each file's path inside it. */
export interface SourceGroup<T> {
  /** The source's name; "" for files in none. */
  readonly name: string;
  readonly source: WorkspaceSource | null;
  readonly items: ReadonlyArray<{ readonly item: T; readonly path: string }>;
}

/** Changed files under their source, in the chat's source order, each with its path inside the source. */
export function groupChanges<T>(
  chat: ChatSources,
  items: ReadonlyArray<T>,
  pathOf: (item: T) => string,
): ReadonlyArray<SourceGroup<T>> {
  const sources = workspaceSources(chat);
  return groupBySource(chat, items, pathOf).map((group) => ({
    name: group.source,
    source: sources.find((s) => s.name === group.source) ?? null,
    items: group.items.map((item) => ({
      item,
      path: group.source === "" ? pathOf(item) : sourceOfPath(chat, pathOf(item)).path,
    })),
  }));
}

/** A path as it reads under its source's heading: without the source's name in front. */
export const pathInSource = (chat: ChatSources, path: string): string =>
  sourceOfPath(chat, path).path || path;

// ------------------------------------------------------------------ pull requests

/** A source's pull request, with what Review needs to open one outside the project's own repository. */
export interface SourcePullRequest {
  readonly source: string;
  readonly pr: PullRequest;
  /** owner/name and host of the repository it is in; absent for the primary source, which is the project's own. */
  readonly repo?: string;
  readonly host?: string;
}

/** The pull requests of a chat in several sources, the primary's first. */
export function sourcePullRequests(chat: ChatSources): ReadonlyArray<SourcePullRequest> {
  return workspaceSources(chat).flatMap((s) =>
    s.pull_request
      ? [
          {
            source: s.name,
            pr: s.pull_request,
            ...(!s.primary && s.repository
              ? { repo: s.repository.full_name, host: s.repository.host }
              : {}),
          },
        ]
      : [],
  );
}
