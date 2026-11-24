// What the runtime keeps under src/mcp is what it serves: every module there that is not a test or a test kit is
// reached from the bundle's own entries (scripts/bundle.ts). A route server.ts stopped mounting would otherwise live
// on, tested and wired into engines, while no computer runs it (caveman_retrieve outlived compression that way).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The runtime bundle's entries, as scripts/bundle.ts builds them (bin.ts reaches server.ts). */
const ENTRIES = [
  "bin.ts",
  "claude-history-worker.ts",
  "search/embedder-worker.ts",
  "web/page-worker.ts",
];
const SPECIFIER =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
const TEST_ONLY = /\.test\.ts$|\.testkit\.ts$/;

/** Every runtime source file the entries reach through relative imports (comments count, so it errs toward reached). */
const shipped = (): Set<string> => {
  const seen = new Set<string>();
  const queue = ENTRIES.map((file) => path.join(SRC, file));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of fs.readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec === undefined || !spec.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), spec);
      const target = [base, `${base}.ts`, path.join(base, "index.ts")].find(
        (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
      );
      if (target !== undefined) queue.push(target);
    }
  }
  return seen;
};

it("every MCP module the runtime keeps is one its bundle ships", () => {
  const graph = shipped();
  // The walk itself: server.ts and the routes it mounts are reached.
  expect(graph.has(path.join(SRC, "server.ts"))).toBe(true);
  expect(graph.has(path.join(SRC, "mcp", "clientToolsEndpoint.ts"))).toBe(true);
  const kept = (fs.readdirSync(path.join(SRC, "mcp"), { recursive: true }) as Array<string>)
    .filter((file) => file.endsWith(".ts") && !TEST_ONLY.test(file))
    .map((file) => path.join(SRC, "mcp", file));
  expect(kept.filter((file) => !graph.has(file)).map((file) => path.relative(SRC, file))).toEqual(
    [],
  );
});
