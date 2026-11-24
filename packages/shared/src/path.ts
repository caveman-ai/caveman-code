// ), packages/shared/src/path.ts @ ab3a3cd1.
export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function isRootPath(value: string): boolean {
  // The drive separator is required: a bare `C:` is not the drive root (it
  // means "current directory on C:"), and treating it as already-canonical
  // would leave it as `C:` while `C:\` and `C:/` normalize to the drive root,
  // so the same location would fail project identity/dedup comparisons.
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]$/.test(value);
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) {
    return value;
  }
  const trimmed = value.startsWith("/")
    ? value.replace(/\/+$/g, "")
    : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) {
    return value;
  }
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  if (isWindowsDrivePath(normalized) || isUncPath(normalized)) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

// Windows refuses these as file names, with or without an extension.
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/**
 * Folder name for a project started from just a name ("Pinball Stats" becomes
 * "pinball-stats"). The server uses it for `projects.createNew`, and clients
 * use it to show the path before the server makes it.
 */
export function newProjectFolderName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  if (slug.length === 0) return "project";
  return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-project` : slug;
}

const SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN = /^\/[A-Za-z]:[\\/]/;

/** Browser URL parsers write `C:/foo` as `/C:/foo` for file URLs. */
export function stripSlashPrefixedWindowsDrive(path: string): string {
  return SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN.test(path) ? path.slice(1) : path;
}

export function fileBasename(path: string): string {
  // A trailing separator is a valid way to write a directory. Trim it before
  // taking the final segment so the label is never empty.
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed.length === 0) return path;
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

export function workspaceRelativeFilePath(
  path: string,
  workspaceRoot: string | null | undefined,
): string | null {
  if (!workspaceRoot) return null;
  const normalizedPath = stripSlashPrefixedWindowsDrive(path.replaceAll("\\", "/"));
  const normalizedRoot = stripSlashPrefixedWindowsDrive(
    workspaceRoot.replaceAll("\\", "/"),
  ).replace(/\/+$/, "");
  const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
  const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (pathForCompare.replace(/\/+$/, "") === rootForCompare) return ".";
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  // `/repo/../x` starts with the root but escapes it; the server rejects that as a workspace path.
  let depth = 0;
  for (const segment of relativePath.split("/")) {
    if (segment === "..") depth -= 1;
    else if (segment.length > 0 && segment !== ".") depth += 1;
    if (depth < 0) return null;
  }
  return relativePath;
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

/** A folder on the host: absolute, or under the home folder. */
export function isHostPath(value: string): boolean {
  return isAbsolutePath(value) || value.startsWith("~/");
}

// Finder and Explorer copy a path ready for a shell: `'/a b'`, `/a\'s\ b`, or `"C:\a b"` (upstream #28460).
const QUOTED_PATH_AT_END = /(?:'((?:[^']|'\\'')+)'|"([^"]+)")\s*$/;
const SHELL_ESCAPE = /\\([\s'"\\()[\]{}<>|&;$`!*?#~^=])/g;

/**
 * What a folder box holds after a change. A full path pasted into it replaces the box, even after
 * the text already there, because `~/'/a b'` would create that nested folder.
 */
export function resolvePastedPath(previous: string, next: string): string {
  const isTyping = next.startsWith(previous)
    ? next.length === previous.length + 1
    : previous.startsWith(next);
  if (isTyping) return next;

  const match = QUOTED_PATH_AT_END.exec(next);
  // Text before the quote that wasn't in the box is a search, not a folder to paste after.
  if (match && previous.startsWith(next.slice(0, match.index).trimEnd())) {
    const quoted = match[1]?.replaceAll("'\\''", "'") ?? match[2] ?? "";
    if (isHostPath(quoted)) return quoted;
  }

  // Without a trailing separator, `/a` then `/a/b` is a longer path, not one pasted after a folder.
  const afterFolder = /[/\\]$/.test(previous) && next.startsWith(previous);
  const path = afterFolder ? next.slice(previous.length) : next;
  if (!isHostPath(path)) return next;
  // `\` separates folders in Windows paths, so it only escapes in `/` and `~/` paths.
  return isWindowsAbsolutePath(path) ? path : path.replace(SHELL_ESCAPE, "$1");
}

/** Resolve a literal filesystem path without interpreting file-link positions.
 * Home-relative paths stay intact for the server to expand. */
export function resolveWorkspaceFilePath(path: string, workspaceRoot: string): string {
  if (isAbsolutePath(path) || path.startsWith("~/") || path.startsWith("~\\")) return path;
  const base = workspaceRoot.replace(/[/\\]+$/, "");
  return isWindowsAbsolutePath(workspaceRoot)
    ? `${base}\\${path.replaceAll("/", "\\")}`
    : `${base}/${path}`;
}
