// An inline code span that names a file in the workspace, drawn as a file
// chip. , apps/web/src/markdown-links.ts @ ab3a3cd1):
// inline code mostly holds identifiers and refs (`node.meta`, `origin/main`),
// so it needs a `/` (or Windows' `\`) with an extension, or a `:line` the author wrote. Links
// are chatLink's (components/transcript/links.ts).
import { resolvePathLinkTarget } from "@caveman-app/shared/fileLinks";
import { isWindowsAbsolutePath } from "@caveman-app/shared/path";
import { isHtmlFile } from "../browser/htmlFile.ts";
import { isAbsolutePath, workspacePath } from "../../state/workspace-paths.ts";
import { workspaceJoin } from "./tree.ts";

export interface FileRef {
  /** Workspace-relative. A single segment (`retry.go`) may live anywhere: look it up before opening. */
  readonly path: string;
  readonly line?: number;
  /** A folder opens the Files tree, not the file reader. */
  readonly directory?: boolean;
  /** The path is known as it is (a diff's, a tab's, a changed file's): never looked up by name or rewritten. */
  readonly exact?: boolean;
}

const POSITION = /:(\d+)(?::\d+)?$/;
const EXTENSION = /\.[A-Za-z0-9_-]+$/;
// A last dot between digits is a version or a model id (`glm-5.3`, `v1.2`), not an extension.
const VERSION = /\d\.\d[^.]*$/;
const HOSTNAME = /^(?:[a-z\d-]+\.)+[a-z]{2,}$/i;
const EXTENSIONLESS = new Set(["Makefile", "makefile", "Dockerfile", "Containerfile", "Justfile", "justfile", "Rakefile", "Gemfile", "Procfile", "Brewfile", "LICENSE", "README", "CODEOWNERS"]);
/**
 * A span whose `\` cannot be Windows' folder separator: Windows names hold none of `*?"<>|`, and a last name of only a
 * dot and a word after a `\` is a regex's escaped dot (`foo\.ts`, `[a-z]+\.json`), not a file.
 */
const NOT_A_WINDOWS_PATH = /[*?"<>|]|\\\.[A-Za-z0-9_-]+(?::\d+(?::\d+)?)?$/;

/** An inline code span, when it is clearly a path to a file in the workspace. */
export function codeRef(text: string, root: string | null | undefined): FileRef | null {
  const written = text.trim();
  const windows = isWindowsAbsolutePath(written);
  if (!windows && written.includes("\\") && NOT_A_WINDOWS_PATH.test(written)) return null;
 // Windows separates folders with `\` (upstream inlineCodeFilePathCandidate): a drive or share path is read as written, any other with `/`.
  const t = windows ? written : written.replaceAll("\\", "/");
  if (/[\\/]$/.test(t)) {
    const folder = folderCandidate(t, root);
    return folder ? { ...folder, directory: true } : null;
  }
  if (!t || /[`\r\n]/.test(t)) return null;
  if (/\s/.test(t) && !(isHtmlFile(t) && (isAbsolutePath(t) || t.startsWith("~/")))) return null;
  const position = POSITION.exec(t);
  const path = position ? t.slice(0, position.index) : t;
  if (!position && !/[\\/]/.test(path) && !isHtmlFile(path)) return null;
  if (!/^(\.{1,2}\/|\/)/.test(path) && !isWindowsAbsolutePath(path)) {
    if (path.includes("/") && HOSTNAME.test(path.split("/", 1)[0]!)) return null;
    const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
    if (VERSION.test(name) || !(EXTENSION.test(name) || EXTENSIONLESS.has(name))) return null;
  }
  return located(path, position ? Number(position[1]) : 0, root);
}

/**
 * The one file in `known` (the files a chat touched) that a bare file name means: `pilot.md` for `notes/pilot.md`.
 * Null for anything that is not a plain name with an extension, and for a name two touched files share.
 */
export function touchedFile(name: string, known: ReadonlyArray<string>): string | null {
  const n = name.trim();
  if (!/^[\p{L}\p{N}_.-]+\.[\p{L}\p{N}]+$/u.test(n)) return null;
  const hits = [...new Set(known.filter((f) => f === n || f.endsWith(`/${n}`)))];
  return hits.length === 1 ? hits[0]! : null;
}

/** Workspace-relative with `.` and `..` resolved; null when it leaves the chat's folder. */
function located(path: string, line: number, root: string | null | undefined): FileRef | null {
  // `~/…` is the home folder (inferred from the chat's folder, as chatLink does), never a folder named `~`; HTML reads it on the runtime.
  const home = path.startsWith("~/") && !isHtmlFile(path) ? (root ? resolvePathLinkTarget(path, root) : path) : path;
  if (home.startsWith("~/") && !isHtmlFile(home)) return null;
  const rel = workspacePath(home, root);
  if (isHtmlFile(rel) && !/^[\\/]{2}/.test(rel) && (isAbsolutePath(rel) || rel.startsWith("~/"))) return { path: rel, ...(line > 0 ? { line } : {}) };
  // A code span is the path as written, not a link's percent-encoded destination: nothing in it is decoded.
  const file = workspaceJoin("", rel);
  return file ? { path: file, ...(line > 0 ? { line } : {}) } : null;
}

/** A possible folder, checked against the workspace before an ambiguous code span becomes a chip. */
export function folderCandidate(text: string, root: string | null | undefined): FileRef | null {
  const t = text.trim();
  if (!t || /[`\n\r\t:*?#[\]\\]/.test(t) || (!t.includes("/") && !/^[\p{L}\p{N}_.-]+$/u.test(t))) return null;
  if (!/^(\.{1,2}\/|\/)/.test(t) && HOSTNAME.test(t.split("/", 1)[0]!)) return null;
  return located(t, 0, root);
}

const MARKDOWN = /\.(md|mdx|markdown)$/i;
export const isMarkdownPath = (path: string) => MARKDOWN.test(path);
