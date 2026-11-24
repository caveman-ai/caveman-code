import { fileURLToPath } from "node:url";
// Spaces became marketplaces and plugins; the words "space" and "drive" leave
// the app's copy. This reads every source file's words people see (string literals with a space in them,
// and JSX text) and fails on either word. Identifiers, method names and class names are not copy.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const BANNED = /\b(spaces?|drives?)\b(?![-_.:/\w])/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The words a file shows: prose-like string literals and JSX text, comments dropped. */
export function copyOf(code: string): string[] {
  const out: string[] = [];
  const literal = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  for (const m of noComments.matchAll(literal)) if (/\s/.test(m[2]!)) out.push(m[2]!);
  const bare = noComments.replace(literal, '""');
  for (const m of bare.matchAll(/>([^<>{};=()]+)</g)) if (/[a-z]{2}/i.test(m[1]!)) out.push(m[1]!.trim());
  return out;
}

test("copyOf finds literals and JSX text, not identifiers or class names", () => {
  const code = `const spaces = r.spaces; // a space here\n<p className="mt-2 space-y-4">Add a space</p>; x("space.list"); y("Pick a drive")`;
  expect(copyOf(code).filter((s) => BANNED.test(s))).toEqual(["Pick a drive", "Add a space"]);
});

test("no screen says space or drive", () => {
  const hits = sources(ROOT).flatMap((file) =>
    copyOf(readFileSync(file, "utf8"))
      .filter((s) => BANNED.test(s))
      .map((s) => `${relative(ROOT, file)}: ${s.slice(0, 100)}`),
  );
  expect(hits).toEqual([]);
});
