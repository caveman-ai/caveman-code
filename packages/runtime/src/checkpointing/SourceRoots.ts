// A chat that works in several sources of its project has one folder holding a git worktree per source, side by
// side under the sources' names; the folder is the engine's working directory and is no repository itself. This
// module says which folders are such chat folders (a small manifest the runtime keeps beside the folder, never in
// it), and rewrites git's diff output of one source so its paths read from the chat's folder.
import * as fs from "node:fs";
import * as path from "node:path";

/** A source's name in a chat's folder: one path segment, nothing git or a shell reads as anything else. */
export const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Where the manifest of the chat folder `root` is kept: beside it, so no agent working in the folder meets it. */
export const sourcesManifestPath = (root: string) => `${root.replace(/[\\/]+$/, "")}.sources.json`;

/**
 * The sources a chat folder holds, the primary first, as their worktrees' folders in it; undefined for any other
 * folder (a chat in one source, whose folder is its worktree). Names are single segments, so a manifest can only
 * ever name folders right inside `root`.
 */
export function readSourceRoot(root: string): ReadonlyArray<string> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(sourcesManifestPath(root), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { readonly sources?: unknown };
    if (!Array.isArray(parsed.sources)) return undefined;
    const names = parsed.sources.filter(
      (name): name is string =>
        typeof name === "string" && SOURCE_NAME.test(name) && name !== "." && name !== "..",
    );
    return names.length === 0 ? undefined : [...new Set(names)];
  } catch {
    return undefined;
  }
}

/** Says `root` is a chat folder holding these sources' worktrees, the primary first (written whole, then renamed in). */
export function writeSourceRoot(root: string, names: ReadonlyArray<string>): void {
  const file = sourcesManifestPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ v: 1, sources: names })}\n`);
  fs.renameSync(temp, file);
}

export function removeSourceRoot(root: string): void {
  fs.rmSync(sourcesManifestPath(root), { force: true });
}

/** The source a path from the chat's folder is in, and the path inside that source; undefined for a path in none. */
export function splitSourcePath(
  names: ReadonlyArray<string>,
  file: string,
): { readonly name: string; readonly path: string } | undefined {
  const normal = file.replace(/^\.\//, "");
  const cut = normal.indexOf("/");
  const name = cut < 0 ? normal : normal.slice(0, cut);
  if (!names.includes(name)) return undefined;
  return { name, path: cut < 0 ? "" : normal.slice(cut + 1) };
}

/** `git diff --numstat -z` of one source, its paths read from the chat's folder. */
export function prefixNumstat(numstat: string, name: string): string {
  const records = numstat.split("\0");
  const out: Array<string> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;
    const file = record.slice(counts[0].length);
    if (file.length === 0) {
      // A rename or copy: the counts, then the source and the destination as two more records.
      const from = records[index + 1];
      const to = records[index + 2];
      index += 2;
      if (from === undefined || to === undefined || to.length === 0) continue;
      out.push(counts[0], `${name}/${from}`, `${name}/${to}`);
      continue;
    }
    out.push(`${counts[0]}${name}/${file}`);
  }
  return out.length === 0 ? "" : `${out.join("\0")}\0`;
}

/** One path of a patch header, as git wrote it (quoted when it holds a character git escapes), under `name/`. */
const prefixHeaderPath = (text: string, side: "a/" | "b/" | "", name: string): string => {
  if (text === "/dev/null") return text;
  if (text.startsWith(`"${side}`)) return `"${side}${name}/${text.slice(1 + side.length)}`;
  if (text.startsWith(side)) return `${side}${name}/${text.slice(side.length)}`;
  return text;
};

/** Where the first path of `diff --git <a> <b>` ends: git names both sides, and an unquoted name may hold spaces. */
const splitDiffGit = (rest: string): readonly [string, string] | undefined => {
  if (rest.startsWith('"')) {
    for (let i = 1; i < rest.length; i += 1) {
      if (rest[i] === "\\") i += 1;
      else if (rest[i] === '"')
        return rest[i + 1] === " " ? [rest.slice(0, i + 1), rest.slice(i + 2)] : undefined;
    }
    return undefined;
  }
  // The same file on both sides (every diff but a rename's): two halves that differ only in their a/ and b/.
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " " && rest.slice(2, mid) === rest.slice(mid + 3))
    return [rest.slice(0, mid), rest.slice(mid + 1)];
  const quoted = rest.indexOf(' "b/');
  if (quoted >= 0) return [rest.slice(0, quoted), rest.slice(quoted + 1)];
  const plain = rest.indexOf(" b/");
  return plain < 0 ? undefined : [rest.slice(0, plain), rest.slice(plain + 1)];
};

/**
 * A `git diff --patch` of one source (prefixes a/ and b/), its file names read from the chat's folder. Only header
 * lines change: a hunk's lines are counted off by its `@@` header, so a removed line that reads "-- a/x" stays as it is.
 */
export function prefixPatch(patch: string, name: string): string {
  if (patch === "") return patch;
  const lines = patch.split("\n");
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (oldLeft > 0 || newLeft > 0) {
      const head = line[0];
      if (head === "\\") continue;
      if (head === "-") oldLeft -= 1;
      else if (head === "+") newLeft -= 1;
      else {
        oldLeft -= 1;
        newLeft -= 1;
      }
      if (oldLeft < 0 || newLeft < 0) oldLeft = newLeft = 0;
      else continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const sides = splitDiffGit(line.slice("diff --git ".length));
      if (sides)
        lines[i] =
          `diff --git ${prefixHeaderPath(sides[0], "a/", name)} ${prefixHeaderPath(sides[1], "b/", name)}`;
    } else if (line.startsWith("--- "))
      lines[i] = `--- ${prefixHeaderPath(line.slice(4), "a/", name)}`;
    else if (line.startsWith("+++ "))
      lines[i] = `+++ ${prefixHeaderPath(line.slice(4), "b/", name)}`;
    else {
      const moved = /^(rename from|rename to|copy from|copy to) (.*)$/.exec(line);
      if (moved)
        lines[i] =
          `${moved[1]} ${moved[2]!.startsWith('"') ? `"${name}/${moved[2]!.slice(1)}` : `${name}/${moved[2]!}`}`;
      else {
        const binary = /^Binary files (.*) and (.*) differ$/.exec(line);
        if (binary)
          lines[i] =
            `Binary files ${prefixHeaderPath(binary[1]!, "a/", name)} and ${prefixHeaderPath(binary[2]!, "b/", name)} differ`;
      }
    }
  }
  return lines.join("\n");
}
