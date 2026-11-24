// The bundle step's checks: every package a chunk requires from disk ships in dist, and the start loads nothing it
// should load on first use.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { expect, it } from "vitest";

import { loadedAtStart, missingRequireTargets } from "./bundle.ts";

it("counts a required package only when it resolves inside dist (or is a builtin), never from a node_modules above it", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bundle-guard-"));
  try {
    const pkg = (dir: string, name: string) => {
      fs.mkdirSync(path.join(dir, "node_modules", name), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, main: "index.js" }));
      fs.writeFileSync(path.join(dir, "node_modules", name, "index.js"), "");
    };
    // As packages/runtime/dist: the workspace's own node_modules sit above it.
    const outDir = path.join(root, "runtime", "dist");
    pkg(path.join(root, "runtime"), "workspace-only");
    pkg(outDir, "staged");
    const code = 'const require = createRequire(import.meta.url);\nrequire("staged");\nrequire("workspace-only");\nrequire("node:fs");\nrequire("fs");\nrequire("nowhere");\n';
    expect(missingRequireTargets([{ fileName: "chunk.mjs", code }], outDir)).toEqual(["chunk.mjs -> workspace-only", "chunk.mjs -> nowhere"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("finds a staged package when dist sits under a symlink, as macOS's tmpdir does", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bundle-guard-link-"));
  try {
    const outDir = path.join(root, "real", "dist");
    fs.mkdirSync(path.join(outDir, "node_modules", "staged"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "node_modules", "staged", "package.json"), JSON.stringify({ name: "staged", main: "index.js" }));
    fs.writeFileSync(path.join(outDir, "node_modules", "staged", "index.js"), "");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    const code = 'const require = createRequire(import.meta.url);\nrequire("staged");\n';
    expect(missingRequireTargets([{ fileName: "chunk.mjs", code }], path.join(root, "link", "dist"))).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("finds a first-use module the start reaches through static imports, never through an import()", () => {
  // bin imports server, server imports shared and the engine's journal; the engine and the page parsers only from lazy chunks.
  const chunks = [
    { fileName: "bin.mjs", imports: ["server.mjs", "node:fs"], moduleIds: ["/app/src/bin.ts"] },
    { fileName: "server.mjs", imports: ["shared.mjs", "@caveman-ai/agent/durable"], moduleIds: ["/app/src/server.ts", "/app/node_modules/.pnpm/effect@4.0.4/node_modules/effect/dist/Effect.js"] },
    { fileName: "shared.mjs", imports: ["server.mjs"], moduleIds: ["/app/src/web/pages.ts"] },
    { fileName: "lazy.mjs", imports: ["@caveman-ai/agent", "@caveman-ai/agent/code"], moduleIds: ["/app/node_modules/.pnpm/linkedom@0.18.13/node_modules/linkedom/esm/index.js"] },
  ];
  expect(loadedAtStart(chunks, ["bin.mjs"])).toEqual([]);
  // A shared chunk that imports the engine statically, or has a page parser bundled in, puts it in the start.
  const regressed = chunks.map((chunk) =>
    chunk.fileName === "shared.mjs"
      ? { ...chunk, imports: [...chunk.imports, "@caveman-ai/agent"], moduleIds: [...chunk.moduleIds, "/app/node_modules/.pnpm/linkedom@0.18.13/node_modules/linkedom/esm/index.js", "/app/node_modules/.pnpm/linkedom@0.18.13/node_modules/linkedom/esm/dom.js"] }
      : chunk,
  );
  expect(loadedAtStart(regressed, ["bin.mjs"])).toEqual(["shared.mjs -> @caveman-ai/agent", "shared.mjs -> linkedom"]);
});
