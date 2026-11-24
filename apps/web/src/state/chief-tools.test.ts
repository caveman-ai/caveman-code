// The web knows every tool a Chief has: a tool missing from CHIEF_TOOLS turns its whole run into plain tool rows, and
// a run of only Chief tools with no words can then draw nothing, its Suggested or ask card with it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { CHIEF_TOOLS } from "./chief-model.ts";

const RUNTIME_TOOLS = fileURLToPath(
  new URL("../../../../packages/runtime/src/chief/tools.ts", import.meta.url),
);

test("every tool the runtime gives a Chief is one the web draws as a Chief's", () => {
  const declared = [...readFileSync(RUNTIME_TOOLS, "utf8").matchAll(/\btool\(\s*"([a-z_]+)"/g)].map(
    (m) => m[1]!,
  );
  expect(declared.length).toBeGreaterThan(15);
  expect(declared.filter((name) => !CHIEF_TOOLS.has(name))).toEqual([]);
});
