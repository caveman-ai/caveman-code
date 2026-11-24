// WorkspaceEnv (harness.ts): the workspace rules around an env, here around a stand-in that records its calls.
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import type * as Harness from "@caveman-ai/harness";
import { expect, it } from "vitest";

import { WorkspaceEnv } from "./harness.ts";

it("reads the workspace's files in one batch and memory's on the runtime's disk; a refused path is its own error", async () => {
  const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "caveman-memory-"));
  NodeFS.writeFileSync(NodePath.join(memoryDir, "notes.md"), "remembered");
  // The workspace as this platform spells it: WorkspaceEnv resolves paths with node:path.
  const root = NodePath.resolve("/ws");
  const batches: string[][] = [];
  const base = {
    id: "stand-in",
    cwd: root,
    readFiles: async (paths: string[]) => {
      batches.push(paths);
      return paths.map((path) => (path.endsWith("missing.txt") ? Object.assign(new Error("ENOENT"), { code: "ENOENT" }) : new TextEncoder().encode(`base:${path}`)));
    },
    readFile: async () => {
      throw new Error("read one by one");
    },
  } as unknown as Harness.ExecEnv;
  const env = new WorkspaceEnv(base, { root, hidden: (path) => path === "secret.env", readAnywhere: false, memory: { dir: memoryDir } });

  const read = await env.readFiles(["a.txt", "/memory/notes.md", "secret.env", "/etc/passwd", "missing.txt", "src/b.ts"]);
  const text = (result: Uint8Array | Error | undefined) => (result instanceof Error ? `error:${result.message}` : new TextDecoder().decode(result));

  const inRoot = (path: string) => NodePath.join(root, path);
  expect(batches).toEqual([[inRoot("a.txt"), inRoot("missing.txt"), inRoot("src/b.ts")]]);
  expect(text(read[0])).toBe(`base:${inRoot("a.txt")}`);
  expect(text(read[1])).toBe("remembered");
  expect(text(read[2])).toMatch(/hidden in this project/);
  expect(text(read[3])).toMatch(/outside the workspace/);
  expect(read[4]).toMatchObject({ code: "ENOENT" });
  expect(text(read[5])).toBe(`base:${inRoot("src/b.ts")}`);
});
