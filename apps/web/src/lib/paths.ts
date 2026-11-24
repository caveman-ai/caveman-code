// Paths the runtime reports, as the page shows and reads them. macOS and Linux
// paths use /, Windows' use \ (and take / too): every helper reads both, and
// a POSIX path comes out exactly as before.

/** "/x", "~", "~/x", "C:\x", "C:/x", "\\server\share": a folder path typed in full, not a search word. */
export function isTypedPath(raw: string): boolean {
  return raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
}

const HOMES = [/^\/(?:Users|home)\/[^/]+/, /^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i];

/** The home folder as ~: /Users/me, /home/me, C:\Users\me. `whole`: also a path that is the home folder itself. */
export function tildify(path: string, whole = true): string {
  for (const home of HOMES) {
    const found = home.exec(path)?.[0];
    if (found === undefined) continue;
    const rest = path.slice(found.length);
    if (rest === "" ? whole : /^[\\/]/.test(rest)) return `~${rest}`;
  }
  return path;
}

/** The last part: /a/b/c -> c, C:\a\b -> b. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** The folder a path sits in: /a/b/c -> /a/b, C:\a\b -> C:\a, C:\a -> C:\. */
export function parentPath(path: string): string {
  const parent = path.replace(/[\\/][^\\/]+[\\/]?$/, "");
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || "/";
}

/** Comparable spelling: Windows paths in either separator and any case (its file system ignores case). */
export const pathKey = (path: string): string => path.replace(/\\/g, "/").toLowerCase();
