// How long a new worktree takes from `git worktree add` to setup finished, with and without the first checkout's
// caches (finding P11 of docs/), on a real package manager's install. The steps are
// the runtime's own, in the order session-protocol/handlers.ts startSetup runs them: the worktree through
// GitVcsDriver.createWorktree, the .caveman/computer.toml it holds, cloneCaches, then runScripts on [setup].run.
//
//   node packages/runtime/scripts/warm-start.ts <scratch dir> [--pm npm|pnpm] [--runs <n>]
//
// The first run makes <scratch dir>/<pm>/repo: a few real dependencies, a lockfile and a computer.toml whose
// [setup].run is the package manager's install and whose cache is node_modules. It installs that once, online, which
// makes the first checkout and fills the package manager's own download cache (npm's cache, pnpm's store), kept
// under <scratch dir>/<pm> and named in the install command. Later runs reuse both. Every timed install runs
// offline on that cache, the cold ones too: no run waits on the network, and a cold one that needed it would fail.
//
// Each round times three new worktrees: cold (no caches brought), clone (copy-on-write) and link (hard links). A
// worktree is removed once it is timed. Prints one JSON line per worktree, then a summary with the median of each.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../src/config.ts";
import {
  type CacheMethod,
  cloneCaches,
  readComputerConfig,
  runScripts,
} from "../src/session-protocol/lifecycle.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";

const [scratchArg, ...flags] = process.argv.slice(2);
const flag = (name: string) => {
  const i = flags.indexOf(name);
  return i < 0 ? undefined : flags[i + 1];
};
const pm = flag("--pm") ?? "npm";
const runs = Number(flag("--runs") ?? 3);
if (
  scratchArg === undefined ||
  !fs.existsSync(scratchArg) ||
  (pm !== "npm" && pm !== "pnpm") ||
  !Number.isInteger(runs) ||
  runs < 1
) {
  console.error(
    "usage: node packages/runtime/scripts/warm-start.ts <scratch dir> [--pm npm|pnpm] [--runs <n>]",
  );
  process.exit(2);
}
const scratch = fs.realpathSync(scratchArg);
const checkout = fs.realpathSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
);
if (
  scratch === checkout ||
  scratch.startsWith(checkout + path.sep) ||
  checkout.startsWith(scratch + path.sep)
) {
  console.error(`${scratch} holds the checkout this script runs from. Pass a temporary folder.`);
  process.exit(2);
}

/** Real packages, few files: about a hundred packages and a few thousand files installed. */
const DEPENDENCIES = {
  ajv: "^8",
  commander: "^12",
  express: "^4",
  fastify: "^4",
  pino: "^9",
  semver: "^7",
  uuid: "^10",
  ws: "^8",
  yaml: "^2",
  zod: "^3",
};
const home = path.join(scratch, pm);
const repo = path.join(home, "repo");
// The download cache is named in the command, unquoted: pnpm reads no environment name for its store that all its versions share.
if (/[^\w./-]/.test(home)) {
  console.error(
    `${home} has a character the install command would need quoted. Pass a plain temporary folder.`,
  );
  process.exit(2);
}
const MANAGERS = {
  // `npm install`, not `npm ci`: ci removes node_modules before it installs, caches brought or not.
  npm: {
    first: `npm install --no-audit --no-fund --cache ${home}/cache`,
    setup: `npm install --no-audit --no-fund --offline --cache ${home}/cache`,
    lock: "package-lock.json",
  },
  pnpm: {
    first: `pnpm install --store-dir ${home}/store`,
    setup: `pnpm install --frozen-lockfile --offline --store-dir ${home}/store`,
    lock: "pnpm-lock.yaml",
  },
} as const;
const manager = MANAGERS[pm];
const quiet = { npm_config_update_notifier: "false" };
const config = `[setup]\nrun = [${JSON.stringify(manager.setup)}]\ncache = ["node_modules"]\n`;

const gitIn = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
if (!fs.existsSync(path.join(repo, ".git"))) {
  fs.mkdirSync(path.join(repo, ".caveman"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "warm-start-fixture", version: "0.0.0", private: true, dependencies: DEPENDENCIES }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(repo, ".caveman", "computer.toml"), config);
  gitIn(repo, "init", "-q", "-b", "main");
  // The first checkout's own install: online, once. It writes the lockfile and fills the download cache.
  execFileSync("/bin/sh", ["-c", manager.first], {
    cwd: repo,
    env: { ...process.env, ...quiet },
    stdio: ["ignore", "ignore", "inherit"],
  });
  gitIn(repo, "add", "package.json", manager.lock, ".gitignore", ".caveman/computer.toml");
  gitIn(
    repo,
    "-c",
    "user.name=warm-start",
    "-c",
    "user.email=warm-start@localhost",
    "commit",
    "-qm",
    "fixture",
  );
} else if (fs.readFileSync(path.join(repo, ".caveman", "computer.toml"), "utf8") !== config) {
  console.error(
    `${repo} was made by another version of this script. Pass a fresh temporary folder.`,
  );
  process.exit(2);
}

/** Every file under `dir` with its bytes (a link by its target), as one hash: whether a worktree's install changed the first checkout's. */
const treeHash = (dir: string) => {
  const hash = createHash("sha256");
  let files = 0;
  const walk = (at: string) => {
    for (const entry of fs
      .readdirSync(at, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = path.join(at, entry.name);
      if (entry.isSymbolicLink()) hash.update(`${file}\0-> ${fs.readlinkSync(file)}\0`);
      else if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        files++;
        hash.update(`${file}\0`).update(fs.readFileSync(file));
      }
    }
  };
  walk(dir);
  return { files, hash: hash.digest("hex") };
};

const run = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  new Promise<boolean>((resolve) =>
    execFile(command, [...args], { cwd }, (error) => resolve(error === null)),
  );
const seconds = (ms: number) => Number((ms / 1000).toFixed(2));
const MODES: ReadonlyArray<readonly [name: string, methods: ReadonlyArray<CacheMethod>]> = [
  ["cold", []],
  ["clone", ["clone"]],
  ["link", ["link"]],
];
const stamp = `${process.pid}-${Date.now().toString(36)}`;

const program = Effect.gen(function* () {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const before = treeHash(path.join(repo, "node_modules"));
  const totals = new Map<string, Array<number>>(MODES.map(([name]) => [name, []]));
  let ok = true;
  for (let round = 1; round <= runs; round++) {
    for (const [mode, methods] of MODES) {
      const at = path.join(home, `wt-${stamp}-${round}-${mode}`);
      const branch = `caveman/warm-start-${stamp}-${round}-${mode}`;
      const started = performance.now();
      yield* driver.createWorktree({ cwd: repo, refName: "HEAD", newRefName: branch, path: at });
      const made = performance.now();
      const computer = readComputerConfig(at)!;
      const caches = yield* Effect.promise(() =>
        cloneCaches(repo, at, computer.setup.cache ?? [], methods),
      );
      const brought = performance.now();
      const setup = yield* Effect.promise(() =>
        runScripts(computer.setup.run ?? [], at, { ...computer.env, ...quiet }),
      );
      const finished = performance.now();
      // The worktree's dependencies load from its own node_modules, whichever way they arrived.
      const loads = yield* Effect.promise(() =>
        run(at, process.execPath, [
          "-e",
          `for (const name of ${JSON.stringify(Object.keys(DEPENDENCIES))}) require(name);`,
        ]),
      );
      const arrived =
        caches.cloned.length > 0 ? "cloned" : caches.linked.length > 0 ? "linked" : "none";
      const good =
        setup.ok &&
        loads &&
        arrived === (mode === "cold" ? "none" : mode === "clone" ? "cloned" : "linked");
      ok &&= good;
      if (good) totals.get(mode)!.push(finished - started);
      console.log(
        JSON.stringify({
          round,
          mode,
          caches: arrived,
          worktree_s: seconds(made - started),
          caches_s: seconds(brought - made),
          setup_s: seconds(finished - brought),
          total_s: seconds(finished - started),
          setup_ok: setup.ok,
          dependencies_load: loads,
          ...(setup.ok ? {} : { output: setup.output.slice(-600) }),
        }),
      );
      yield* Effect.promise(async () => {
        if (!(await run(repo, "git", ["worktree", "remove", "--force", at])))
          fs.rmSync(at, { recursive: true, force: true });
        await run(repo, "git", ["worktree", "prune"]);
        await run(repo, "git", ["branch", "-D", branch]);
      });
    }
  }
  const after = treeHash(path.join(repo, "node_modules"));
  const median = (values: ReadonlyArray<number>) =>
    values.length === 0
      ? null
      : seconds([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!);
  console.log(
    JSON.stringify({
      pm,
      runs,
      setup: manager.setup,
      first_checkout_files: before.files,
      first_checkout_unchanged: after.hash === before.hash,
      total_s: Object.fromEntries([...totals].map(([mode, values]) => [mode, values.map(seconds)])),
      median_s: Object.fromEntries([...totals].map(([mode, values]) => [mode, median(values)])),
    }),
  );
  return ok && after.hash === before.hash;
});

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(repo, path.join(home, "runtime-home"))),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const ok = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
process.exit(ok ? 0 : 1);
