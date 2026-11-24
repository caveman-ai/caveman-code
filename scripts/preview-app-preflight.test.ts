import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { previewPreflight } from "./preview-app-preflight.mjs";

// The preflight's own git calls, recorded and passed through (the dotfile test reads its grep patterns).
vi.mock("node:child_process", async (load) => {
  const real = await load<typeof import("node:child_process")>();
  return { ...real, spawnSync: vi.fn(real.spawnSync) };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-preflight-test-"));
  roots.push(root);
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  for (const dir of ["", "apps/web", "packages/runtime", "packages/ui"]) {
    write(path.join(dir, "package.json"), '{"type":"module"}');
  }
  for (const dir of ["apps/web", "packages/runtime", "packages/ui"]) {
    write(path.join(dir, "tsconfig.json"), '{"extends":"../../tsconfig.base.json"}');
  }
  write("tsconfig.base.json", "{}");
  write("apps/web/index.html", '<script type="module" src="/src/main.tsx"></script>');
  write("apps/web/src/main.tsx", "export {};\n");
  write("apps/web/vite.config.ts", "export default {};");
  write("apps/web/node_modules/vite/bin/vite.js", 'throw new Error("Vite must not start");');
  write("packages/runtime/src/bin.ts", 'throw new Error("Runtime must not start");');
  return { root, write };
}

test("a whole checkout passes, following JSONC, arrays, and extensionless extends", () => {
  const { root, write } = checkout();
  write(
    "apps/web/tsconfig.json",
    '{/* config */ "extends": ["../../config/web", "../../tsconfig.base.json",],}',
  );
  write(
    "config/web.json",
    '{"extends":"../tsconfig.base.json", "compilerOptions":{"baseUrl":"https://example.test/*keep*/",},}',
  );
  expect(previewPreflight(root)).toBeUndefined();
});

test("a deleted base config refuses the launcher before scratch home or either child exists", () => {
  const { root, write } = checkout();
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "-q");
  git("add", "--", "tsconfig.base.json");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "test fixture",
  );
  fs.unlinkSync(path.join(root, "tsconfig.base.json"));
  for (const file of ["preview-app.mjs", "preview-app-preflight.mjs"]) {
    write(`scripts/${file}`, fs.readFileSync(new URL(file, import.meta.url), "utf8"));
  }
  const home = path.join(root, "scratch-home-must-not-exist");
  const result = spawnSync(process.execPath, [path.join(root, "scripts/preview-app.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: "5899", CAVEMAN_PREVIEW_HOME: home },
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "preview-app: cannot start preview; this checkout is incomplete or has invalid config.\n" +
      "  - tsconfig.base.json: missing (deleted from this checkout).\n" +
      "Inspect checkout changes first: git status -- tsconfig.base.json; git diff -- tsconfig.base.json\n" +
      "Deleted files may be intentional; check with whoever made the change first.\n" +
      "Only if deletion was unintended, restore: git restore -- tsconfig.base.json\n" +
      "Fix this checkout, then open preview again. No servers were started.\n",
  );
  expect(fs.existsSync(home)).toBe(false);
});

test("lists all missing entrypoint files and distinguishes install from restore", () => {
  const { root } = checkout();
  for (const file of [
    "package.json",
    "apps/web/package.json",
    "apps/web/vite.config.ts",
    "packages/runtime/tsconfig.json",
  ]) {
    fs.unlinkSync(path.join(root, file));
  }
  fs.rmSync(path.join(root, "apps/web/node_modules/vite"), { recursive: true });
  const failure = previewPreflight(root);
  for (const file of [
    "package.json",
    "apps/web/package.json",
    "apps/web/vite.config.ts",
    "packages/runtime/tsconfig.json",
    "apps/web/node_modules/vite",
  ]) {
    expect(failure).toContain(`- ${file}: missing`);
  }
  expect(failure).toContain("Install checkout dependencies: pnpm install");
  expect(failure?.split("\n").find((line) => line.includes("git restore")) ?? "").not.toContain(
    "node_modules",
  );
});

test("checks imported workspace configs, including nested extends, rather than a fixed base filename", () => {
  const { root, write } = checkout();
  write("apps/web/package.json", '{"dependencies":{"@test/ui":"workspace:*"}}');
  write("packages/ui/tsconfig.json", '{"extends":"../../config/shared.json"}');
  fs.mkdirSync(path.join(root, "apps/web/node_modules/@test"), { recursive: true });
  fs.symlinkSync(
    path.join(root, "packages/ui"),
    path.join(root, "apps/web/node_modules/@test/ui"),
    "junction",
  );
  expect(previewPreflight(root)).toContain("config/shared.json: missing");
});

test("invalid or circular configs fail clearly instead of silently skipping their chain", () => {
  const { root, write } = checkout();
  write("tsconfig.base.json", '{"extends":"./apps/web/tsconfig.json"}');
  expect(previewPreflight(root)).toContain("apps/web/tsconfig.json: circular tsconfig extends");
  write("tsconfig.base.json", "{broken");
  expect(previewPreflight(root)).toContain("tsconfig.base.json: cannot read config:");
});

test("a missing package-provided base config asks for installation", () => {
  const { root, write } = checkout();
  write("apps/web/tsconfig.json", '{"extends":"@test/tsconfig/web.json"}');
  expect(previewPreflight(root)).toContain(
    'cannot resolve extends "@test/tsconfig/web.json"; run pnpm install',
  );
});

function track(root: string, ...files: string[]) {
  for (const args of [
    ["init", "-q"],
    ["add", "--", ...files],
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "test fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }
}

test("finding 1: refuses missing entrypoints and the index script target", () => {
  const { root, write } = checkout();
  for (const file of [
    "apps/web/index.html",
    "apps/web/src/main.tsx",
    "apps/web/vite.config.ts",
    "packages/runtime/src/bin.ts",
  ]) {
    const original = fs.readFileSync(path.join(root, file), "utf8");
    fs.unlinkSync(path.join(root, file));
    expect(previewPreflight(root), file).toContain(`${file}: missing`);
    write(file, original);
  }
  write("apps/web/index.html", '<script type="module" src="/src/alternate.tsx?dev"></script>');
  expect(previewPreflight(root)).toContain(
    "apps/web/src/alternate.tsx: missing; referenced by apps/web/index.html",
  );
});

test("finding 1: refuses imported deleted source with importer, allows unused and committed removals", () => {
  const { root, write } = checkout();
  write("apps/web/src/gone.ts", "export const value = 1;");
  track(root, "apps/web/src/gone.ts");
  fs.unlinkSync(path.join(root, "apps/web/src/gone.ts"));
  expect(previewPreflight(root)).toBeUndefined();
  for (const statement of [
    'import { value } from "./gone.js";',
    'export * from "./gone";',
    'import "./gone.ts";',
    'const lazy = import("./gone");',
  ]) {
    write("apps/web/src/main.tsx", statement);
    expect(previewPreflight(root), statement).toContain(
      "apps/web/src/gone.ts: missing (deleted from this checkout); imported by apps/web/src/main.tsx",
    );
  }
  write(
    "apps/web/src/main.tsx",
    '// import "./gone";\nconst sample = `import "./gone";`;\nexport {};',
  );
  expect(previewPreflight(root)).toBeUndefined();
  spawnSync("git", ["rm", "--cached", "--", "apps/web/src/gone.ts"], { cwd: root });
  write("apps/web/src/main.tsx", 'import "./gone";');
  expect(previewPreflight(root)).toContain(
    "apps/web/src/gone.ts: missing (deleted from this checkout); imported by apps/web/src/main.tsx",
  );
  expect(previewPreflight(root)).not.toContain("git restore");
  spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "remove unused source",
    ],
    { cwd: root },
  );
  expect(previewPreflight(root)).toBeUndefined();
});

test("finding 2: checks third-party dependencies and devDependencies from each workspace package", () => {
  const { root, write } = checkout();
  write(
    "apps/web/package.json",
    JSON.stringify({
      dependencies: { "@test/ui": "workspace:*" },
      devDependencies: { "@vitejs/plugin-react": "1" },
    }),
  );
  write("packages/ui/package.json", JSON.stringify({ dependencies: { "esm-only": "1" } }));
  fs.mkdirSync(path.join(root, "apps/web/node_modules/@test"), { recursive: true });
  fs.symlinkSync("../../../../packages/ui", path.join(root, "apps/web/node_modules/@test/ui"));
  expect(previewPreflight(root)).toContain("@vitejs/plugin-react");
  expect(previewPreflight(root)).toContain("packages/ui/node_modules/esm-only");
  expect(previewPreflight(root)).toContain("run pnpm install");
  write(
    "apps/web/node_modules/@vitejs/plugin-react/package.json",
    '{"name":"@vitejs/plugin-react","exports":{"import":"./index.js"}}',
  );
  write("apps/web/node_modules/@vitejs/plugin-react/index.js", "export {};");
  write(
    "packages/ui/node_modules/esm-only/package.json",
    '{"name":"esm-only","exports":{"./feature":"./feature.js"}}',
  );
  write("packages/ui/node_modules/esm-only/feature.js", "export {};");
  expect(previewPreflight(root)).toBeUndefined();
  fs.rmSync(path.join(root, "packages/ui/node_modules/esm-only"), { recursive: true });
  fs.symlinkSync("missing-dependency", path.join(root, "packages/ui/node_modules/esm-only"));
  expect(previewPreflight(root)).toContain("packages/ui/node_modules/esm-only");
});

test("finding 3: dangling symlink and modified config get inspection advice, never restore", () => {
  const { root, write } = checkout();
  track(root, "tsconfig.base.json");
  fs.unlinkSync(path.join(root, "tsconfig.base.json"));
  fs.symlinkSync("my-unfinished-config.json", path.join(root, "tsconfig.base.json"));
  const dangling = previewPreflight(root);
  expect(dangling).toContain("present but broken");
  expect(dangling).toContain("git status -- tsconfig.base.json");
  expect(dangling).toContain("git diff -- tsconfig.base.json");
  expect(dangling).not.toContain("git restore");
  expect(fs.readlinkSync(path.join(root, "tsconfig.base.json"))).toBe("my-unfinished-config.json");
  fs.unlinkSync(path.join(root, "tsconfig.base.json"));
  write("tsconfig.base.json", "{unfinished");
  expect(previewPreflight(root)).not.toContain("git restore");
});

test("many issues keep header, first eight issues, remainder count and recovery visible", () => {
  const { root, write } = checkout();
  write(
    "apps/web/package.json",
    JSON.stringify({
      dependencies: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`missing-${i}`, "1"])),
    }),
  );
  const failure = previewPreflight(root)!;
  expect(failure.split("\n")[0]).toContain("preview-app: cannot start preview");
  expect(failure.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(8);
  expect(failure).toContain("12 more issues");
  expect(failure).toContain("Install checkout dependencies: pnpm install");
  expect(failure.split("\n").length).toBeLessThanOrEqual(13);
});

test("finding 3: unreadable files and locally modified deletions never suggest restore", () => {
  const { root, write } = checkout();
  track(root, "tsconfig.base.json");
  // chmod cannot deny reads to root, and Windows does not implement POSIX read bits.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    fs.chmodSync(path.join(root, "tsconfig.base.json"), 0);
    try {
      expect(previewPreflight(root)).toContain("present but broken");
      expect(previewPreflight(root)).not.toContain("git restore");
    } finally {
      fs.chmodSync(path.join(root, "tsconfig.base.json"), 0o644);
    }
  }
  write("tsconfig.base.json", "{local work");
  spawnSync("git", ["add", "--", "tsconfig.base.json"], { cwd: root });
  fs.unlinkSync(path.join(root, "tsconfig.base.json"));
  expect(previewPreflight(root)).toContain("git diff -- tsconfig.base.json");
  expect(previewPreflight(root)).not.toContain("git restore");
});

test("finding 1: checks deleted workspace export targets and their relative imports", () => {
  const { root, write } = checkout();
  write("apps/web/package.json", '{"dependencies":{"@test/ui":"workspace:*"}}');
  write(
    "packages/ui/package.json",
    '{"name":"@test/ui","exports":{"./components/*":{"import":"./src/*.tsx"}}}',
  );
  write("packages/ui/src/button.tsx", 'export * from "./theme.js";');
  write("packages/ui/src/theme.ts", "export {};");
  write("apps/web/src/main.tsx", 'import "@test/ui/components/button";');
  fs.mkdirSync(path.join(root, "apps/web/node_modules/@test"), { recursive: true });
  fs.symlinkSync("../../../../packages/ui", path.join(root, "apps/web/node_modules/@test/ui"));
  track(root, "packages/ui/src/button.tsx", "packages/ui/src/theme.ts");
  fs.unlinkSync(path.join(root, "packages/ui/src/theme.ts"));
  expect(previewPreflight(root)).toContain(
    "packages/ui/src/theme.ts: missing (deleted from this checkout); imported by packages/ui/src/button.tsx",
  );
  fs.unlinkSync(path.join(root, "packages/ui/src/button.tsx"));
  expect(previewPreflight(root)).toContain(
    "packages/ui/src/button.tsx: missing (deleted from this checkout); imported by apps/web/src/main.tsx",
  );
});

test("finding 2: Node lookup accepts ancestor installations and follows third-party symlinks", () => {
  const { root, write } = checkout();
  write(
    "packages/runtime/package.json",
    '{"dependencies":{"ancestor-only":"1"},"devDependencies":{"linked":"1"}}',
  );
  write("node_modules/ancestor-only/package.json", '{"name":"ancestor-only"}');
  write("installed-linked/package.json", '{"name":"linked"}');
  fs.mkdirSync(path.join(root, "packages/runtime/node_modules"), { recursive: true });
  fs.symlinkSync(
    "../../../installed-linked",
    path.join(root, "packages/runtime/node_modules/linked"),
  );
  expect(previewPreflight(root)).toBeUndefined();
  fs.unlinkSync(path.join(root, "installed-linked/package.json"));
  expect(previewPreflight(root)).toContain(
    "packages/runtime/node_modules/linked: missing; run pnpm install",
  );
});

test("finding 1: checks config importers outside src and directory index imports", () => {
  const { root, write } = checkout();
  write("apps/web/config/index.ts", "export {};");
  write("apps/web/config/loader.ts", 'import ".";');
  write("apps/web/tailwind.config.cjs", 'const theme = require("./config/index.js");');
  track(root, "apps/web/config/index.ts");
  fs.unlinkSync(path.join(root, "apps/web/config/index.ts"));
  expect(previewPreflight(root)).toContain(
    "apps/web/config/index.ts: missing (deleted from this checkout); imported by apps/web/config/loader.ts",
  );
  fs.unlinkSync(path.join(root, "apps/web/config/loader.ts"));
  expect(previewPreflight(root)).toContain("imported by apps/web/tailwind.config.cjs");
});

test("a deleted dotfile gives the import scan its own search term, never an empty one that matches every file", () => {
  const { root, write } = checkout();
  write("packages/runtime/.gitignore", "dist/\n");
  write("packages/runtime/.eslintrc.cjs", "module.exports = {};\n");
  write("apps/web/src/other.ts", "export const other = 1;\n");
  track(
    root,
    "packages/runtime/.gitignore",
    "packages/runtime/.eslintrc.cjs",
    "apps/web/src/other.ts",
  );
  fs.unlinkSync(path.join(root, "packages/runtime/.gitignore"));
  fs.unlinkSync(path.join(root, "packages/runtime/.eslintrc.cjs"));
  const calls = vi.mocked(spawnSync).mock.calls;
  const from = calls.length;
  // An intentional deletion nothing imports stays allowed.
  expect(previewPreflight(root)).toBeUndefined();
  const grep = calls.slice(from).find(([file, args]) => file === "git" && args?.[0] === "grep");
  expect(grep, "the deletion is scanned for importers").toBeDefined();
  const args = grep![1] as string[];
  const patterns = args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []));
  expect(patterns).not.toContain("");
  expect(patterns).toEqual(expect.arrayContaining([".gitignore", ".eslintrc"]));
});
