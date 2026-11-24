// Whether a change can affect the runtime's suite, which CI spreads over 24 shards (ci.yml `runtime`).
//
//   node scripts/runtime-affected.ts <base>     compare HEAD (and uncommitted files) with the merge base with <base>
//
// Prints the verdict and why, and writes `runtime=true|false` to $GITHUB_OUTPUT when CI sets it. Main pushes,
// nightlies and workflow_dispatch never ask: they run every shard.
//
// The runtime's tests load app code by relative path: desktop's lid.ts, web's state modules (some through a dynamic
// import vitest's module graph cannot see), a web JSON fixture, the phone's live modules. So a change under apps/ or
// packages/ui skips the shards only when it is outside everything those files reach. That set is computed here on
// every run, from the `../apps/...` paths in packages/runtime and the imports they follow, so a new test that loads an
// app file is covered without editing this script. Everything else (any other package, a lockfile, a config, CI)
// runs the shards; docs/ and Markdown outside packages/ never do.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Test files are run by their own suites; a template path names a module, never one of them. */
const TEST = /\.(?:test|browser)\.[^/]*$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-electron", ".turbo", ".vite", "coverage"]);
/** The parts of the repo whose files count only when the runtime's tests reach them. */
const GATED = /^(?:apps\/(?:web|mobile|desktop)|packages\/ui)\//;

const toPosix = (path: string) => path.split(NodePath.sep).join("/");

function walk(dir: string, out: Array<string> = []): Array<string> {
  if (!NodeFS.existsSync(dir)) return out;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."))
        walk(NodePath.join(dir, entry.name), out);
    } else out.push(NodePath.join(dir, entry.name));
  }
  return out;
}

/** `../../apps/web/src/state/x.ts` and `../../apps/web/src/state/${p}` in a file under packages/runtime. */
const APP_PATH = /(?:\.\.\/)+(apps\/(?:web|mobile|desktop)\/[^"'`\s)]*)/g;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

function resolveImport(fromFile: string, spec: string): string | undefined {
  const base = NodePath.resolve(NodePath.dirname(fromFile), spec);
  const candidates = [base, ...[".ts", ".tsx", ".js", ".mjs", ".json"].map((ext) => base + ext)];
  candidates.push(
    ...["index.ts", "index.tsx", "index.js"].map((name) => NodePath.join(base, name)),
  );
  // A `.js` specifier that names a `.ts` source (TypeScript's NodeNext style).
  if (/\.[cm]?js$/.test(base))
    candidates.push(base.replace(/\.([cm]?)js$/, ".$1ts"), base.replace(/\.js$/, ".tsx"));
  return candidates.find((path) => NodeFS.existsSync(path) && NodeFS.statSync(path).isFile());
}

/**
 * Every file under apps/ and packages/ui the runtime's tests can load, as repo-relative paths. `ui` is true when that
 * code imports @caveman-app/ui, which then counts whole.
 */
export function runtimeReach(repoRoot: string = root): { files: Set<string>; ui: boolean } {
  const seeds = new Set<string>();
  for (const file of walk(NodePath.join(repoRoot, "packages/runtime"))) {
    if (!CODE.test(file) && !file.endsWith(".json")) continue;
    for (const [, path] of NodeFS.readFileSync(file, "utf8").matchAll(APP_PATH)) {
      const cut = path!.indexOf("${");
      if (cut === -1) {
        const abs = NodePath.join(repoRoot, path!);
        if (NodeFS.existsSync(abs)) seeds.add(abs);
      } else {
        // A template names some file in that folder: all of them.
        const dir = NodePath.join(repoRoot, path!.slice(0, cut));
        for (const inside of walk(dir))
          if ((CODE.test(inside) || inside.endsWith(".json")) && !TEST.test(inside))
            seeds.add(inside);
      }
    }
  }
  const files = new Set<string>();
  let ui = false;
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const key = toPosix(NodePath.relative(repoRoot, file));
    if (files.has(key)) continue;
    files.add(key);
    if (!CODE.test(file)) continue;
    for (const [, spec] of NodeFS.readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (spec!.startsWith("@caveman-app/ui")) ui = true;
      if (!spec!.startsWith(".")) continue;
      const target = resolveImport(file, spec!);
      if (target && GATED.test(toPosix(NodePath.relative(repoRoot, target)))) queue.push(target);
    }
  }
  return { files, ui };
}

/** Why `file` runs the runtime's shards, or undefined when it cannot affect them. */
export function reason(
  file: string,
  reach: { files: Set<string>; ui: boolean },
): string | undefined {
  if (file.startsWith("docs/")) return undefined;
  if (file.endsWith(".md") && !file.startsWith("packages/")) return undefined;
  if (/(?:^|\/)package\.json$/.test(file)) return "a package manifest";
  if (!GATED.test(file)) return "outside apps/ and packages/ui";
  if (file.startsWith("packages/ui/"))
    return reach.ui ? "packages/ui, which app code the runtime's tests load imports" : undefined;
  return reach.files.has(file) ? "app code the runtime's tests load" : undefined;
}

function git(args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

function changedFiles(base: string): Array<string> {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const tracked = git(["diff", "--name-only", "--no-renames", mergeBase]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))].sort();
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: node scripts/runtime-affected.ts <base>");
    process.exit(2);
  }
  const files = changedFiles(base);
  const reach = runtimeReach();
  const hits = files.flatMap((file) => {
    const why = reason(file, reach);
    return why ? [`${file} (${why})`] : [];
  });
  // An empty diff (a re-run, a rewritten history) is no evidence: run.
  const runtime = files.length === 0 || hits.length > 0;
  console.log(
    `${files.length} changed files; the runtime's tests reach ${reach.files.size} app files${reach.ui ? " and packages/ui" : ""}.`,
  );
  if (files.length === 0) console.log("No changed files found: running the runtime's shards.");
  for (const hit of hits.slice(0, 20)) console.log(`  runs the shards: ${hit}`);
  if (hits.length > 20) console.log(`  ...and ${hits.length - 20} more`);
  console.log(`runtime=${runtime}`);
  if (process.env.GITHUB_OUTPUT)
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `runtime=${runtime}\n`);
}
