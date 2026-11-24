// The prepared compile cache against a small runtime dist, on the Node running the tests (the app's own Node 24 in
// CI). It asserts what the change is for: on the first start every module's bytecode comes from the prepared files
// and nothing is compiled or written.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import * as NodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

// Node 22 has no portable compile cache (enableCompileCache takes no options there).
const portable =
  NodeModule.constants.compileCacheStatus !== undefined &&
  Number(process.versions.node.split(".")[0]) >= 24;

const makeRuntime = () => {
  const root = mkdtempSync(join(tmpdir(), "caveman-compile-cache-"));
  const rt = join(root, "runtime");
  mkdirSync(rt);
  // As the real bundle: bin.mjs runs only as the entry and loads the server chunk on demand.
  writeFileSync(
    join(rt, "bin.mjs"),
    `#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { run } = await import("./binCli-abc123.mjs");
  console.log("ran " + run());
}
`,
  );
  const functions = Array.from(
    { length: 300 },
    (_, i) =>
      `function f${i}(x) { let s = 0; for (let j = 0; j < x; j++) s += j * ${i}; return s; }`,
  ).join("\n");
  writeFileSync(
    join(rt, "binCli-abc123.mjs"),
    `${functions}\nimport { helper } from "./chunk-x.mjs";\nexport const run = () => helper() + f3(3);\n`,
  );
  writeFileSync(join(rt, "chunk-x.mjs"), "export const helper = () => 41;\n");
  writeFileSync(
    join(rt, "other.mjs"),
    `import * as m from "node:module"; console.log("cache " + m.getCompileCacheDir());\n`,
  );
  buildSync({
    entryPoints: [join(import.meta.dirname, "../src/serverCompileCache.ts")],
    outfile: join(rt, "serverCompileCache.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  const temp = join(root, "tmp");
  mkdirSync(temp);
  const node = (args: string[]) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      NODE_DEBUG_NATIVE: "COMPILE_CACHE",
    };
    delete env.NODE_OPTIONS;
    return spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 60_000 });
  };
  const preload = `--import=${pathToFileURL(join(rt, "serverCompileCache.mjs")).href}`;
  return { rt, temp, node, preload };
};

// Never on Windows, where the runtime's compile cache stays off (src/serverCompileCache.ts).
describe.skipIf(!portable || process.platform === "win32")("the prepared compile cache", () => {
  it("is made at package time and gives the first start every module's bytecode, writing nothing", () => {
    const { rt, temp, node, preload } = makeRuntime();
    const made = node([join(rt, "serverCompileCache.mjs"), "--generate", rt]);
    expect(made.status, made.stderr).toBe(0);
    expect(made.stdout).toContain("prepared 3 runtime modules");
    const manifest = JSON.parse(readFileSync(join(rt, "compile-cache", "manifest.json"), "utf8"));
    expect(manifest.entries.map((e: { module: string }) => e.module).sort()).toEqual([
      "bin.mjs",
      "binCli-abc123.mjs",
      "chunk-x.mjs",
    ]);

    const first = node([preload, join(rt, "bin.mjs"), "--bootstrap-fd", "3"]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("ran 50");
    const accepted = first.stderr.match(/V8 code cache for ESM \S+ was accepted/g) ?? [];
    expect(accepted).toHaveLength(3);
    expect(first.stderr).not.toMatch(/was rejected|cache miss|no cache found/i);
    expect(first.stderr).not.toMatch(/writing cache for/);
    // Links into the prepared files, never copies, and never a directory link into the app.
    const links = readdirSync(join(temp, "caveman-code", "compile-cache", "prepared"), {
      recursive: true,
      withFileTypes: true,
    }).filter((e) => e.isSymbolicLink());
    expect(links).toHaveLength(3);
    for (const link of links)
      expect(readlinkSync(join(link.parentPath, link.name))).toContain(
        join("runtime", "compile-cache"),
      );
  });

  it("is ignored when another Node made it, and the runtime still starts", () => {
    const { rt, temp, node, preload } = makeRuntime();
    expect(node([join(rt, "serverCompileCache.mjs"), "--generate", rt]).status).toBe(0);
    const file = join(rt, "compile-cache", "manifest.json");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/"runtime":"[^"]+"/, '"runtime":"v24.0.0-darwin-arm64-1"'),
    );
    const run = node([preload, join(rt, "bin.mjs")]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("ran 50");
    expect(
      readdirSync(temp, { recursive: true, withFileTypes: true }).filter((e) => e.isSymbolicLink()),
    ).toHaveLength(0);
  });

  it("does nothing for another script started with the same flags", () => {
    const { rt, node, preload } = makeRuntime();
    expect(node([join(rt, "serverCompileCache.mjs"), "--generate", rt]).status).toBe(0);
    const run = node([preload, join(rt, "other.mjs")]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("cache undefined");
  });
});
