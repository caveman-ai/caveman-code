// Where a link in an engine's answer goes. Engines link the files they talk
// about ("[retry.ts](retry.ts#L2)", an absolute path, "src/a.ts:12", a
// file:// URL); those open in the side panel's file viewer. A link like that
// must never reach the browser: the app is a hash-routed page, so a relative
// href navigates the whole app away (react-router's 404).
import { resolvePathLinkTarget } from "@caveman-app/shared/fileLinks";
import { isHtmlFile } from "../../panels/browser/htmlFile.ts";
import { workspaceJoin } from "../../panels/files/tree.ts";
import { isAbsolutePath, workspacePath } from "../../state/workspace-paths.ts";

export type ChatLink = { readonly kind: "file"; readonly path: string; readonly line?: number; readonly directory?: boolean } | { readonly kind: "anchor"; readonly id: string };

const EXTERNAL = /^(?:https?|mailto):/i;
/** "src/a.ts:12", "src/a.ts:12:4" or "C:\src\a.ts:12": a file (it has an extension) with a line (and column), as engines write them; "localhost:3000" is not one. */
const PATH_LINE = /^((?:[A-Za-z]:[\\/])?(?:[^:]*[\\/])?[^:\\/]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?$/;

/**
 * A link in a chat answer: a file in the chat's folder, an anchor in the answer, or null (leave it alone or do nothing).
 * `href` as the renderer gives it, percent-encoded (`C:%5Ca.ts`, `My%20Repo`), or as written.
 */
export function chatLink(href: string, root: string | null | undefined): ChatLink | null {
  const h = href.trim();
  if (!h || EXTERNAL.test(h)) return null;
  if (h.startsWith("#")) return { kind: "anchor", id: safeDecode(h.slice(1)) };
  const [rawPath = "", rawHash = ""] = h.replace(/^file:\/\/(localhost)?/i, "").split("#", 2);
  // The renderer percent-encodes every destination (`C:%5Ca.ts`, `%5C%5Chost%5Cshare`); decoded once, here, it is the path it
 // names, and every check below reads that path, never a form a later decode could turn into a network share (upstream
  // parseMarkdownFileLink decodes the same way).
  let path = safeDecode(rawPath.split("?", 1)[0] ?? "");
  const hash = safeDecode(rawHash);
  if (!path) return hash ? { kind: "anchor", id: hash } : null;
  const hashLine = /^L(\d+)/.exec(hash)?.[1];
  let line = hashLine ? Number(hashLine) : undefined;
  const pathLine = PATH_LINE.exec(path);
  if (pathLine) {
    path = pathLine[1]!;
    line ??= Number(pathLine[2]);
  }
  // Agent output is often a self-contained HTML page in /tmp, not a repo file.
  // Only HTML gets the explicit host-path read, never arbitrary file schemes.
  if (!/^[\\/]{2}/.test(path) && isHtmlFile(path) && (isAbsolutePath(path) || path.startsWith("~/"))) {
    return { kind: "file", path: workspacePath(path, root), ...(line ? { line } : {}) };
  }
  // `~/…` is the home folder, never a folder named `~` in the chat's: it opens when it lands inside the chat's
 // folder (home inferred from the folder's own path, upstream rule) and, like any other host path, not otherwise (T3 #20950).
  const absolute = /^~[\\/]/.test(path) ? (root ? resolvePathLinkTarget(path.replace(/^~\\/, "~/"), root) : null) : path;
  if (absolute === null || /^~[\\/]/.test(absolute)) return null;
  let relative = path;
  if (isAbsolutePath(absolute)) {
    // Only a path inside the chat's folder opens; without the folder (a Cloud computer) nothing can be read by it.
    const inside = workspacePath(absolute, root);
    if (isAbsolutePath(inside)) return null;
    relative = inside === "." ? "" : inside;
  }
  const file = workspaceJoin("", relative);
  if (!file) return null;
  return { kind: "file", path: file, ...(line ? { line } : {}), ...(/[\\/]$/.test(path) ? { directory: true } : {}) };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
