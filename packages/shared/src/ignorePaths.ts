/**
 * Paths hidden from file search, @ mentions, the file panel and the agents'
 * file tools: a project's own list plus the repository's committed
 * .cavemanignore, both in gitignore syntax. Hidden, never secured: a shell
 * command can still read them.
 *
 * @module ignorePaths
 */

/** The committed file, at the repository's top level. */
export const CAVEMANIGNORE = ".cavemanignore";

interface Rule {
  readonly negate: boolean;
  readonly dirOnly: boolean;
  readonly re: RegExp;
}

const escape = (c: string) => c.replace(/[.+^${}()|\\]/g, "\\$&");

/** One gitignore line as a rule, or null for a blank line or comment. */
function rule(line: string): Rule | null {
  let p = line.replace(/(?<!\\)\s+$/, "");
  if (p === "" || p.startsWith("#")) return null;
  let negate = false;
  if (p.startsWith("!")) {
    negate = true;
    p = p.slice(1);
  } else if (p.startsWith("\\!") || p.startsWith("\\#")) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  // A slash at the start or in the middle anchors the pattern to the top level.
  const anchored = p.includes("/");
  p = p.replace(/^\/+/, "");
  if (p === "") return null;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*" && (i === 0 || p[i - 1] === "/") && (p[i + 2] === "/" || i + 2 === p.length)) {
      // "**/" is any number of directories; a trailing "**" is everything inside.
      if (p[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = p.indexOf("]", i + 2);
      if (end === -1) re += "\\[";
      else {
        const body = p.slice(i + 1, end).replace(/\\/g, "\\\\");
        re += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else if (c === "\\" && i + 1 < p.length) re += escape(p[++i]!);
    else re += escape(c);
  }
  return { negate, dirOnly, re: new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re}$`) };
}

export type IgnoreMatcher = (relativePath: string, isDirectory?: boolean) => boolean;

/**
 * A matcher for gitignore lines. Paths are relative to the repository's top
 * level, with forward slashes. As in git, the last matching line wins, and a
 * path inside a hidden directory stays hidden.
 */
export function compileIgnore(lines: ReadonlyArray<string>): IgnoreMatcher {
  const rules = lines.flatMap((line) => line.split(/\r?\n/)).map(rule).filter((r): r is Rule => r !== null);
  if (rules.length === 0) return () => false;
  const hidden = (path: string, isDirectory: boolean) => {
    let out = false;
    for (const r of rules) if ((!r.dirOnly || isDirectory) && r.re.test(path)) out = !r.negate;
    return out;
  };
  return (relativePath, isDirectory = false) => {
    const parts = relativePath.replace(/^\.?\/+/, "").replace(/\/+$/, "").split("/");
    for (let i = 1; i < parts.length; i++) if (hidden(parts.slice(0, i).join("/"), true)) return true;
    return hidden(parts.join("/"), isDirectory);
  };
}

/**
 * Claude Agent permission deny rules for the same lines (Claude's Read rules
 * follow the gitignore spec, relative to the session's directory, and cover
 * Grep and Glob). Negated lines cannot be expressed as a deny and are left out.
 */
export function claudeReadDenyRules(lines: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const line of lines.flatMap((l) => l.split(/\r?\n/))) {
    const p = line.trim();
    if (p === "" || p.startsWith("#") || p.startsWith("!")) continue;
    const dir = p.endsWith("/");
    let body = p.replace(/\/+$/, "");
    body = body.includes("/") ? body.replace(/^\/+/, "") : `**/${body}`;
    out.add(`Read(./${body})`);
    out.add(`Read(./${body}/**)`);
    if (dir) out.delete(`Read(./${body})`);
  }
  return [...out];
}
