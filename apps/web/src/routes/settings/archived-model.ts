// Settings > Archived chats, as data: every archived chat under the project it
// came from (a removed project's chats too: Restore brings the project back),
// newest first. The sidebar and ⌘K hide archived chats, so this is the one way
// back to them besides a chat's own address.
import type { Project, Workspace } from "@caveman-app/session-protocol";
import { ago } from "../../components/project-candidates.ts";
import { matches } from "../../lib/search.ts";

export interface ArchivedChat {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
  /** When it was archived: its last change. */
  readonly at: string;
}

export interface ArchivedGroup {
  readonly key: string;
  readonly label: string;
  /** The project is no longer in the sidebar; Restore puts it back. */
  readonly removed: boolean;
  readonly chats: ReadonlyArray<ArchivedChat>;
}

const repoName = (w: Workspace): string =>
  "path" in w.repo ? (w.repo.path.split("/").filter(Boolean).pop() ?? w.repo.path) : w.repo.url.replace(/^.*[/:]([^/]+\/[^/]+?)(\.git)?$/, "$1");

/** Archived chats by project, the group with the newest archive first; `query` keeps chats whose title or project holds every word. */
export function archivedGroups(workspaces: ReadonlyArray<Workspace>, projects: ReadonlyArray<Project>, query = ""): ReadonlyArray<ArchivedGroup> {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const groups = new Map<string, { label: string; removed: boolean; chats: ArchivedChat[] }>();
  for (const w of workspaces) {
    if (w.status !== "archived" || w.kind === "chief") continue;
    const project = w.project_id ? byId.get(w.project_id) : undefined;
    const label = project?.name ?? repoName(w);
    if (query.trim() && !matches(query, `${w.title} ${label} ${w.branch}`)) continue;
    const key = w.project_id ?? `repo:${label}`;
    const group = groups.get(key) ?? { label, removed: !project, chats: [] };
    group.chats.push({ id: w.id, title: w.title, branch: w.branch, at: w.updated_at });
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, removed: g.removed, chats: g.chats.sort((a, b) => b.at.localeCompare(a.at)) }))
    .sort((a, b) => b.chats[0]!.at.localeCompare(a.chats[0]!.at));
}

/** "archived just now", "archived 3h ago", "archived Jul 2026". */
export function archivedWhen(at: string, now = Date.now()): string {
  const when = ago(at, now);
  if (!when) return "archived";
  if (when === "now") return "archived just now";
  return /^\d+[mhdw]$/.test(when) ? `archived ${when} ago` : `archived ${when}`;
}
