// The tests this branch's changes can break, before you push: `vitest run --changed` in each package a change can
// reach.
//
//   pnpm test:changed                compare against the merge base with origin/main (else main)
//   pnpm test:changed <ref>          compare against the merge base with <ref>
//   pnpm test:changed <ref> --list   only say which packages would run
//
// Committed, uncommitted and untracked changes all count. A package runs when it holds a changed file or depends,
// through workspace dependencies, on one that does; inside it, vitest runs only the test files whose imports reach a
// changed file. It is a fast first pass, not CI: vitest cannot see a file a test loads by a computed path (the
// runtime's tests load some apps/web state modules that way; scripts/runtime-affected.ts lists them), and a change
// to a root config makes vitest rerun the package whole.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const refs = args.filter((arg) => !arg.startsWith("--"));

function git(gitArgs: ReadonlyArray<string>): { ok: boolean; out: string } {
  const result = NodeChildProcess.spawnSync("git", gitArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0, out: result.stdout };
}

function mergeBase(): string {
  for (const ref of refs.length > 0 ? refs : ["origin/main", "main"]) {
    const base = git(["merge-base", ref, "HEAD"]);
    if (base.ok) return base.out.trim();
    if (refs.length > 0) throw new Error(`test:changed: no merge base with ${ref}`);
  }
  throw new Error("test:changed: no merge base with origin/main or main; pass a ref");
}

interface Workspace {
  readonly name: string;
  readonly dir: string;
  readonly deps: ReadonlyArray<string>;
  readonly tested: boolean;
}

function workspaces(): Array<Workspace> {
  const out: Array<Workspace> = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of NodeFS.readdirSync(NodePath.join(root, group), { withFileTypes: true })) {
      const manifest = NodePath.join(root, group, entry.name, "package.json");
      if (!entry.isDirectory() || !NodeFS.existsSync(manifest)) continue;
      const pkg = JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as {
        name: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      out.push({
        name: pkg.name,
        dir: `${group}/${entry.name}/`,
        deps: Object.keys(all).filter((dep) => all[dep]!.startsWith("workspace:")),
        tested: Boolean(pkg.scripts?.test?.includes("vitest")),
      });
    }
  }
  return out;
}

const base = mergeBase();
const changed = [
  ...new Set(
    `${git(["diff", "--name-only", "--no-renames", base]).out}\n${git(["ls-files", "--others", "--exclude-standard"]).out}`
      .split("\n")
      .filter(Boolean),
  ),
];
const all = workspaces();
const hit = new Set(
  all.filter((ws) => changed.some((file) => file.startsWith(ws.dir))).map((ws) => ws.name),
);
// Everything that depends on a changed package, to a fixed point.
for (let grew = true; grew;) {
  grew = false;
  for (const ws of all) {
    if (!hit.has(ws.name) && ws.deps.some((dep) => hit.has(dep))) {
      hit.add(ws.name);
      grew = true;
    }
  }
}
const run = all
  .filter((ws) => ws.tested && hit.has(ws.name))
  .map((ws) => ws.name)
  .sort();

console.log(
  `${changed.length} changed files since ${base.slice(0, 9)}; ${run.length} packages to test: ${run.join(", ") || "none"}`,
);
if (listOnly || run.length === 0) process.exit(0);

const failed: Array<string> = [];
for (const name of run) {
  console.log(`\n== ${name}`);
  const result = NodeChildProcess.spawnSync(
    "pnpm",
    ["--filter", name, "exec", "vitest", "run", `--changed=${base}`, "--passWithNoTests"],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) failed.push(name);
}
if (failed.length > 0) {
  console.error(`\ntest:changed: failed in ${failed.join(", ")}`);
  process.exit(1);
}
