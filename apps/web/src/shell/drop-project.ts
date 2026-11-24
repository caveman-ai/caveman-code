import { parseAddQuery } from "../components/project-candidates.ts";

/** What a drop on the sidebar adds: a folder on this computer (a file stands for its folder), or a GitHub repository. */
export type DroppedProject = { path: string } | { url: string };

/**
 * The drag types that name files on this computer. Finder, Zed and JetBrains drag the files themselves (Files);
 * VS Code and its forks (Cursor, Windsurf) also list them as file:// links in text/uri-list and in their own types,
 * which a Chromium drop sees lowercased: application/vnd.code.uri-list (links), codefiles (paths as a JSON array),
 * resourceurls (links as a JSON array).
 */
const PATH_TYPES = ["Files", "application/vnd.code.uri-list", "codefiles", "resourceurls"];

/**
 * Whether a drag can be added as a project, read from its types alone (a drag shows no contents until the drop):
 * files where their paths reach this computer's runtime (the desktop app), a link anywhere.
 */
export function carriesProject(types: ReadonlyArray<string>, readsPaths: boolean): boolean {
  return (
    types.includes("text/uri-list") || (readsPaths && PATH_TYPES.some((t) => types.includes(t)))
  );
}

/**
 * The projects a drop names, each once. `files`: the dropped files' paths on disk ("" for one that has none);
 * `data`: the drop's data by type. With `readsPaths`, every path and file:// link it carries, file or folder (the
 * runtime takes a file as its folder); with none, the GitHub links in text/uri-list (one per line, `#` lines are
 * comments): a page or a file in a repository names the repository. Any other link is not a project.
 */
export function droppedProjects(
  files: ReadonlyArray<string>,
  data: (type: string) => string,
  readsPaths: boolean,
): DroppedProject[] {
  const seen = new Set<string>();
  const out: DroppedProject[] = [];
  const push = (key: string, project: DroppedProject) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(project);
  };
  const links = [
    ...uriLines(data("text/uri-list")),
    ...uriLines(data("application/vnd.code.uri-list")),
    ...jsonStrings(data("resourceurls")),
  ];
  if (readsPaths) {
    const paths = [...files, ...jsonStrings(data("codefiles")), ...links.map(fileLinkPath)];
    for (const path of paths) if (path) push(path.replace(/[\\/]+$/, "") || path, { path });
    if (out.length > 0) return out;
  }
  for (const link of links) {
    const parsed = parseAddQuery(link);
    if (parsed?.kind !== "url" || parsed.fullName === null) continue;
    push(parsed.fullName.toLowerCase(), { url: `https://github.com/${parsed.fullName}` });
  }
  return out;
}

/** What the sidebar says while it adds one: the folder's or the repository's name (a file's folder, by its look). */
export function droppedName(project: DroppedProject): string {
  const where = "path" in project ? project.path : project.url;
  const parts = where.split(/[\\/]/).filter(Boolean);
  const last = parts.at(-1) ?? where;
  return "path" in project && parts.length > 1 && /^[^.].*\.\w{1,8}$/.test(last)
    ? parts.at(-2)!
    : last;
}

/** What a drop says once a project's past chats are in; null when there were none to bring. */
export function importedLine(
  project: string,
  result: { readonly imported: number; readonly already: number; readonly skipped: number },
): string | null {
  if (result.imported > 0)
    return `${result.imported} ${result.imported === 1 ? "chat" : "chats"} from Claude Code and Codex came into ${project}.`;
  if (result.skipped > 0 && result.already === 0)
    return `${project}'s Claude Code and Codex chats could not be brought in.`;
  return null;
}

function uriLines(list: string): string[] {
  return list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

function jsonStrings(raw: string): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A file:// link's path on this computer (`file:///C:/x` is `C:/x`); "" for any other link. */
function fileLinkPath(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return "";
  }
  if (url.protocol !== "file:" || (url.host !== "" && url.host !== "localhost")) return "";
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}
