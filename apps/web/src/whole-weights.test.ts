// Weights are whole hundreds (packages/ui/STYLE.md, ): the system face draws an in-between weight
// (minimal 510 and 590) as a smeared faux bold. The 10-25 sweep fixed 75 files; screens added since brought three
// back. This reads every web and kit source for an arbitrary Tailwind weight or a CSS weight off the hundreds.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const WEB = fileURLToPath(new URL(".", import.meta.url));
const UI = fileURLToPath(new URL("../../../packages/ui/src/", import.meta.url));
const ODD_WEIGHT = /font-\[(\d+)\]|font-weight:\s*(\d+)|fontWeight:\s*(\d+)/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

test("every font weight is a whole hundred", () => {
  const hits = [WEB, UI].flatMap((root) =>
    sources(root).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(ODD_WEIGHT)]
        .filter((m) => Number(m[1] ?? m[2] ?? m[3]) % 100 !== 0)
        .map((m) => `${relative(root, file)}: ${m[0]}`),
    ),
  );
  expect(hits).toEqual([]);
});
