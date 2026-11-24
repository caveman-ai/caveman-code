import { fileURLToPath } from "node:url";
// The plugins rule (README.md) removed Customize, Spaces and their Connectors tab. The runtime's
// own words reach people too (a hub error shows in the chat), so none may send them to those pages.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { expect, test } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const GONE = /\b(?:Customize|Spaces)\s*>|>\s*Connectors\b|\bConnectors tab\b/;

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });

test("no runtime message points at Customize, Spaces or a Connectors tab", () => {
  const hits = sources(SRC).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => (GONE.test(line) ? [`${relative(SRC, file)}:${i + 1}: ${line.trim().slice(0, 100)}`] : [])),
  );
  expect(hits).toEqual([]);
});
