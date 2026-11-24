// What the project picker and the Add project dialog list: project.discover's
// candidates grouped and filtered by the query, plus whatever the query itself
// names (a folder path, a git URL, owner/name on GitHub). The dialog splits
// them in two: folders on this computer, and GitHub repositories.
import type { ProjectCandidate } from "@caveman-app/session-protocol";
import { matches } from "../lib/search.ts";
import { isTypedPath, parentPath, pathKey, tildify as tildifyPath } from "../lib/paths.ts";

export type AddQuery = { kind: "path"; path: string } | { kind: "url"; url: string; fullName: string | null };

/** A typed folder path, a git or web URL, or owner/name; null for a plain search. */
export function parseAddQuery(raw: string): AddQuery | null {
  const trimmed = raw.trim();
  if (isTypedPath(trimmed)) return { kind: "path", path: trimmed };
  // A GitHub address copied without its scheme.
  const q = /^(www\.)?github\.com\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(q)) {
    const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(q);
    return { kind: "url", url: q, fullName: m ? `${m[1]}/${m[2]}` : null };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(q)) return { kind: "url", url: q, fullName: q.replace(/\.git$/, "") };
  return null;
}

/**
 * Whether a project or candidate answers the query: a typed URL or owner/name
 * finds that repository, a typed path finds checkouts under it, anything else
 * is a word search over name, owner/name and path.
 */
export function answers(query: string, item: { name: string; full_name?: string | undefined; path?: string | undefined }): boolean {
  const q = query.trim();
  const parsed = parseAddQuery(q);
  if (parsed?.kind === "url") return parsed.fullName !== null && item.full_name?.toLowerCase() === parsed.fullName.toLowerCase();
  if (parsed?.kind === "path") {
    const path = item.path && (parsed.path.startsWith("~") ? tildify(item.path) : item.path);
    return Boolean(path && pathKey(path).startsWith(pathKey(parsed.path)));
  }
  return !q || matches(q, [item.name, item.full_name, item.path].filter(Boolean).join(" "));
}

/** Add a project's two ways in: a folder on this computer, or a GitHub repository. */
export type AddFrom = "folder" | "github";

export type AddField =
  | { kind: "search" }
  | { kind: "path"; path: string }
  | { kind: "url"; url: string; fullName: string | null }
  /** It belongs on the other tab: a link typed under This Mac, a path typed under GitHub. */
  | { kind: "elsewhere"; to: AddFrom };

/**
 * What a tab's field holds. This Mac takes a folder path (anything else searches what was found here, a
 * bare owner/name included); GitHub takes a link or owner/name. Each hands the other's kind across.
 */
export function readAddField(from: AddFrom, raw: string): AddField {
  const trimmed = raw.trim();
  const parsed = parseAddQuery(trimmed);
  if (from === "folder") {
    if (parsed?.kind === "path") return parsed;
    if (parsed?.kind === "url" && !/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return { kind: "elsewhere", to: "github" };
    return { kind: "search" };
  }
  if (parsed?.kind === "path") return { kind: "elsewhere", to: "folder" };
  return parsed ?? { kind: "search" };
}

/**
 * The repositories one tab lists, in the runtime's rank order: under This Mac every checkout found here;
 * under GitHub every repository on GitHub, cloned here or not. Neither lists what is a project already.
 */
export function candidatesFor(from: AddFrom, candidates: ReadonlyArray<ProjectCandidate>, query: string): ProjectCandidate[] {
  return candidates.filter(
    (c) => !c.project_id && (from === "folder" ? c.path !== undefined : c.repository?.host === "github.com") && answers(query, { name: c.name, full_name: c.repository?.full_name, path: c.path }),
  );
}

export type CandidateSection = "Suggested" | "On GitHub";

/** Candidates that are not projects yet and answer the query: checkouts here first, then GitHub-only, each in the runtime's rank order. */
export function candidateSections(candidates: ReadonlyArray<ProjectCandidate>, query: string): Array<{ section: CandidateSection; candidate: ProjectCandidate }> {
  const shown = candidates.filter((c) => !c.project_id && answers(query, { name: c.name, full_name: c.repository?.full_name, path: c.path }));
  return [
    ...shown.filter((c) => c.path).map((candidate) => ({ section: "Suggested" as const, candidate })),
    ...shown.filter((c) => !c.path).map((candidate) => ({ section: "On GitHub" as const, candidate })),
  ];
}

/** "now", "5m", "3h", "2d", "6w", then the month and year. */
export function ago(at: string, now = Date.now()): string {
  const m = Math.floor((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
  if (m < 60 * 24 * 14) return `${Math.floor(m / (60 * 24))}d`;
  if (m < 60 * 24 * 90) return `${Math.floor(m / (60 * 24 * 7))}w`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** A path with a macOS, Linux or Windows home folder shortened to ~. */
export const tildify = (path: string): string => tildifyPath(path);

/** /Users/me/code/app -> ~/code (C:\Users\me\code\app -> ~\code): the folder a checkout sits in. */
export function parentLabel(path: string): string {
  return tildify(parentPath(path));
}

