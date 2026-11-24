// .caveman/computer.toml rules on This Mac (docs/computer-config.md), each
// proved on a temp repo through the Session Protocol client.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ThreadId } from "@caveman-app/protocol";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { enroll } from "../cloudLink/identity.ts";
import { CloudComputer, CloudLinkState } from "../cloudLink/index.ts";
import { startTestCloud } from "../cloudLink/testCloud.ts";
import { TOOLS_EXEC } from "../cloudLink/tools.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ComputerConfigError, parseComputerConfig, workspaceEnv } from "./computerConfig.ts";
import {
  cachesMissing,
  cloneCaches,
  cloneRootOf,
  DEFAULT_SETUP_INPUTS,
  indexSeed,
  putBackInside,
  putSecretsBack,
  readComputerConfig,
  SECRET_CLEAN_EXCLUDES,
  secretsAsTheyAre,
  setupDecision,
  setupIdentity,
  snapshotWorkInProgress,
  wipTree,
} from "./lifecycle.ts";
import { createReady, git, loadTranscript, makeConfig, makeRepo, MODEL, orchestratorOf, startRuntime, tempRoot, until, type Transcript } from "./testHarness.ts";

/** Whether the temp dir's filesystem clones as cloneCaches asks it to; ext4 (GitHub's Linux runners) cannot, and there cloneCaches hard links a node_modules and brings nothing else. */
const tempDirClones = (() => {
  if (process.platform === "win32") return false;
  const dir = tempRoot("caveman-clone-probe-");
  try {
    fs.writeFileSync(path.join(dir, "a"), "a");
    execFileSync("cp", [process.platform === "darwin" ? "-c" : "--reflink=always", path.join(dir, "a"), path.join(dir, "b")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

test("Windows clones no caches: no cheap clone there, and never a full copy", async () => {
  const root = tempRoot("caveman-clone-win-");
  const platform = process.platform;
  try {
    fs.mkdirSync(path.join(root, "source", "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "source", "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    fs.mkdirSync(path.join(root, "worktree"));
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(await cloneCaches(path.join(root, "source"), path.join(root, "worktree"), ["node_modules"])).toEqual({ cloned: [], linked: [] });
    expect(fs.existsSync(path.join(root, "worktree", "node_modules"))).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Skipped on Windows, which brings nothing (above).
describe.skipIf(process.platform === "win32")("a new worktree's caches come from the first checkout", () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot("caveman-caches-");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const NONE = { cloned: [], linked: [] };
  const LOCK = '{"lockfileVersion":3}\n';
  /** A first checkout after its install and a build: packages (npm's and pnpm's layout), npm's own file, a tool's cache, a launcher, a build cache. */
  const firstCheckout = () => {
    const source = path.join(root, "source");
    const files: Record<string, string> = {
      "node_modules/dep/lib/index.js": "module.exports = 1;\n",
      "node_modules/@scope/pkg/index.js": "module.exports = 2;\n",
      "node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js": "module.exports = 3;\n",
      "node_modules/.package-lock.json": LOCK,
      "node_modules/.cache/tool/entry": "cached\n",
      ".turbo/cache/a.log": "built\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
      fs.writeFileSync(path.join(source, rel), text);
    }
    fs.mkdirSync(path.join(source, "node_modules/.bin"));
    fs.symlinkSync("../dep/lib/index.js", path.join(source, "node_modules/.bin/dep"));
    return source;
  };
  const worktree = (name: string) => {
    const at = path.join(root, name);
    fs.mkdirSync(at);
    return at;
  };
  const inode = (...parts: Array<string>) => fs.statSync(path.join(...parts)).ino;
  const read = (...parts: Array<string>) => fs.readFileSync(path.join(...parts), "utf8");

  test("per path, the first method that works: a clone, else hard links for a node_modules only, else nothing", async () => {
    const source = firstCheckout();
    // As setup calls it. On a disk that cannot clone (ext4, tmpfs) the same call falls to hard links by itself.
    const tree = worktree("default");
    expect(await cloneCaches(source, tree, ["node_modules", ".turbo", "missing", "../outside", path.join(root, "absolute")])).toEqual(
      tempDirClones ? { cloned: ["node_modules", ".turbo"], linked: [] } : { cloned: [], linked: ["node_modules"] },
    );
    // Where it clones, the clone came first: the worktree's file is its own, not a second name for the first checkout's.
    expect(inode(tree, "node_modules/dep/lib/index.js") === inode(source, "node_modules/dep/lib/index.js")).toBe(!tempDirClones);
    expect(fs.existsSync(path.join(tree, ".turbo"))).toBe(tempDirClones);
    // What is there already stays: nothing is brought over it.
    expect(await cloneCaches(source, tree, ["node_modules"])).toEqual(NONE);

    // Without the clone: hard links, and only for node_modules. A build cache is never linked, so it does not arrive.
    const linked = worktree("link-only");
    expect(await cloneCaches(source, linked, ["node_modules", ".turbo"], ["link"])).toEqual({ cloned: [], linked: ["node_modules"] });
    expect(fs.existsSync(path.join(linked, ".turbo"))).toBe(false);
    // The caller's order is the order: links first still leaves the build cache to the clone.
    const reversed = worktree("link-first");
    expect(await cloneCaches(source, reversed, ["node_modules", ".turbo"], ["link", "clone"])).toEqual({ cloned: tempDirClones ? [".turbo"] : [], linked: ["node_modules"] });
    // With no method nothing arrives, and nothing is left behind.
    const none = worktree("none");
    expect(await cloneCaches(source, none, ["node_modules", ".turbo"], [])).toEqual(NONE);
    expect(fs.readdirSync(none)).toEqual([]);
  });

  test.skipIf(!tempDirClones)("a clone shares nothing: every folder and file is the worktree's own", async () => {
    const source = firstCheckout();
    const tree = worktree("cloned");
    expect(await cloneCaches(source, tree, ["node_modules", ".turbo"], ["clone"])).toEqual({ cloned: ["node_modules", ".turbo"], linked: [] });
    for (const dir of ["node_modules", "node_modules/dep/lib", ".turbo/cache"]) {
      expect(fs.lstatSync(path.join(tree, dir)).isDirectory()).toBe(true);
      expect(inode(tree, dir)).not.toBe(inode(source, dir));
    }
    // The whole path arrives, a tool's cache too, and a launcher still points into its own tree.
    expect(read(tree, "node_modules/.cache/tool/entry")).toBe("cached\n");
    expect(fs.readlinkSync(path.join(tree, "node_modules/.bin/dep"))).toBe("../dep/lib/index.js");
    // Files written in place in the worktree (what a build tool does to its cache) leave the first checkout's as they were.
    fs.appendFileSync(path.join(tree, ".turbo/cache/a.log"), "rebuilt\n");
    fs.appendFileSync(path.join(tree, "node_modules/dep/lib/index.js"), "// patched\n");
    fs.writeFileSync(path.join(tree, "node_modules/dep/lib/new.js"), "new\n");
    expect(read(source, ".turbo/cache/a.log")).toBe("built\n");
    expect(read(source, "node_modules/dep/lib/index.js")).toBe("module.exports = 1;\n");
    expect(fs.existsSync(path.join(source, "node_modules/dep/lib/new.js"))).toBe(false);
  });

  test("hard links share the packages' files and nothing else: folders are the worktree's own, and a replaced package leaves the first checkout's", async () => {
    const source = firstCheckout();
    const tree = worktree("linked");
    expect(await cloneCaches(source, tree, ["node_modules"], ["link"])).toEqual({ cloned: [], linked: ["node_modules"] });
    // A package's file is the first checkout's own file under a second name (no copy), npm's layout and pnpm's.
    for (const file of ["node_modules/dep/lib/index.js", "node_modules/@scope/pkg/index.js", "node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js"]) {
      expect(inode(tree, file)).toBe(inode(source, file));
    }
    // Every folder is the worktree's own: none is a link, none is the first checkout's.
    for (const dir of ["node_modules", "node_modules/dep", "node_modules/dep/lib", "node_modules/@scope/pkg", "node_modules/.pnpm/dep@1.0.0/node_modules/dep", "node_modules/.bin"]) {
      expect(fs.lstatSync(path.join(tree, dir)).isDirectory()).toBe(true);
      expect(inode(tree, dir)).not.toBe(inode(source, dir));
    }
    expect(fs.readlinkSync(path.join(tree, "node_modules/.bin/dep"))).toBe("../dep/lib/index.js");
    // npm rewrites its own file at the top in place: it arrives as a copy, so that write stays here.
    expect(inode(tree, "node_modules/.package-lock.json")).not.toBe(inode(source, "node_modules/.package-lock.json"));
    fs.writeFileSync(path.join(tree, "node_modules/.package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
    expect(read(source, "node_modules/.package-lock.json")).toBe(LOCK);
    // A tool's cache there is written in place too: it is not brought at all.
    expect(fs.existsSync(path.join(tree, "node_modules/.cache"))).toBe(false);

    // What an install does in the worktree: one file replaced (a new file renamed over it), one package removed and
    // unpacked anew, one package added. The first checkout keeps every file it had, and gains none.
    const file = path.join(tree, "node_modules/dep/lib/index.js");
    fs.writeFileSync(`${file}.new`, "module.exports = 'replaced';\n");
    fs.renameSync(`${file}.new`, file);
    fs.rmSync(path.join(tree, "node_modules/@scope/pkg"), { recursive: true });
    fs.mkdirSync(path.join(tree, "node_modules/@scope/pkg"));
    fs.writeFileSync(path.join(tree, "node_modules/@scope/pkg/index.js"), "module.exports = 'unpacked anew';\n");
    fs.mkdirSync(path.join(tree, "node_modules/added"));
    fs.writeFileSync(path.join(tree, "node_modules/added/index.js"), "added\n");
    expect(read(source, "node_modules/dep/lib/index.js")).toBe("module.exports = 1;\n");
    expect(read(source, "node_modules/@scope/pkg/index.js")).toBe("module.exports = 2;\n");
    expect(fs.existsSync(path.join(source, "node_modules/added"))).toBe(false);
    expect(read(tree, "node_modules/dep/lib/index.js")).toBe("module.exports = 'replaced';\n");
  });

  test("nothing is brought into the first checkout itself, or through a link in it", async () => {
    const source = firstCheckout();
    const listing = () => fs.readdirSync(source, { recursive: true }).sort();
    const before = listing();
    // A Cloud computer's first chat runs in the first checkout: source and worktree are one path, however it is spelled.
    for (const same of [source, `${source}${path.sep}`, `${source}${path.sep}node_modules${path.sep}..`]) {
      expect(await cloneCaches(source, same, ["node_modules", ".turbo", "elsewhere/node_modules"])).toEqual(NONE);
    }
    expect(listing()).toEqual(before);
    // A cache path that is a link in the first checkout is left out: bringing it would hand the worktree the folder it points at.
    fs.mkdirSync(path.join(source, "packages/a"), { recursive: true });
    fs.symlinkSync(path.join(source, "node_modules"), path.join(source, "packages/a/node_modules"));
    const tree = worktree("no-links");
    expect(await cloneCaches(source, tree, ["packages/a/node_modules"])).toEqual(NONE);
    expect(fs.existsSync(path.join(tree, "packages/a/node_modules"))).toBe(false);
  });

  test("on a Cloud computer the caches come the same way, in the tools container", async () => {
    const source = firstCheckout();
    // The tools container's exec channel, as the computers service starts it. Its cp is a wrapper that says it ran
    // there: the runtime's own PATH has no such cp.
    const bin = path.join(root, "tools-bin");
    const ranInTools = path.join(root, "ran-in-tools.log");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "cp"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(ranInTools)}\nexec /bin/cp "$@"\n`, { mode: 0o755 });
    const socket = path.join(tempRoot("caches-tools-sock-"), "tools.sock");
    const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: "ignore" });
    try {
      await until(() => fs.existsSync(socket));
      process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
      // A chat beside the computer's first: its worktree gets the first checkout's caches, by the same order.
      const tree = worktree("cloud-default");
      expect(await cloneCaches(source, tree, ["node_modules", ".turbo"])).toEqual(tempDirClones ? { cloned: ["node_modules", ".turbo"], linked: [] } : { cloned: [], linked: ["node_modules"] });
      expect(read(tree, "node_modules/dep/lib/index.js")).toBe("module.exports = 1;\n");
      expect(inode(tree, "node_modules/dep/lib")).not.toBe(inode(source, "node_modules/dep/lib"));
      const linked = worktree("cloud-linked");
      expect(await cloneCaches(source, linked, ["node_modules", ".turbo"], ["link"])).toEqual({ cloned: [], linked: ["node_modules"] });
      expect(inode(linked, "node_modules/dep/lib/index.js")).toBe(inode(source, "node_modules/dep/lib/index.js"));
      expect(inode(linked, "node_modules/dep/lib")).not.toBe(inode(source, "node_modules/dep/lib"));
      expect(fs.existsSync(path.join(linked, ".turbo"))).toBe(false);
      expect(fs.readFileSync(ranInTools, "utf8")).toContain(path.join(linked, "node_modules"));
      // The computer's first chat is in the first checkout itself: nothing to bring.
      expect(await cloneCaches(source, source, ["node_modules"])).toEqual(NONE);
      // With the tools container gone nothing is brought here in its place, and setup still gets its answer.
      tools.kill();
      await until(() => tools.exitCode !== null || tools.signalCode !== null);
      const late = worktree("cloud-no-tools");
      expect(await cloneCaches(source, late, ["node_modules"])).toEqual(NONE);
      expect(fs.existsSync(path.join(late, "node_modules"))).toBe(false);
    } finally {
      delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
      tools.kill();
      fs.rmSync(path.dirname(socket), { recursive: true, force: true });
    }
  });
});

describe("computer.toml loader", () => {
  test("parses the documented file", () => {
    const config = parseComputerConfig(`[setup]
# comment
run = ["pnpm install --frozen-lockfile"]
check = ["pnpm typecheck"]
cache = ["node_modules", ".turbo"]
inputs = [
  "pnpm-lock.yaml",
  'package.json', # trailing comment
]

[run]
command = "pnpm dev"
ports = ["web", "api"]

[archive]
run = ["docker compose down"]

[env]
NODE_ENV = "development"

[services]
postgres = "16"
redis = "7"

[computer]
size = "4x16"

[idle]
sleep_after = "10m"

[network]
allow = ["registry.npmjs.org", "*.githubusercontent.com"]

[system]
packages = ["libvips", "ffmpeg", "pkg-config"]
`);
    // Cloud and VPC only (the egress proxy enforces it there): read so a repo using it still opens here.
    expect(config.network).toEqual({ allow: ["registry.npmjs.org", "*.githubusercontent.com"] });
    expect(config.system).toEqual({ packages: ["libvips", "ffmpeg", "pkg-config"] });
    expect(config.setup).toEqual({ run: ["pnpm install --frozen-lockfile"], check: ["pnpm typecheck"], cache: ["node_modules", ".turbo"], inputs: ["pnpm-lock.yaml", "package.json"] });
    expect(config.services).toEqual({ postgres: "16", redis: "7" });
    expect(config.run).toEqual({ command: "pnpm dev", ports: ["web", "api"] });
    expect(config.env).toEqual({ NODE_ENV: "development" });
    // [env], then what is the workspace's own (workspaceIsolation.test.ts covers each variable).
    expect(workspaceEnv(config, { id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", ports: { web: 42100, api: 42101 } })).toEqual({
      NODE_ENV: "development",
      CAVEMAN_WORKSPACE_ID: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
      COMPOSE_PROJECT_NAME: "ws_1b9d6bcd",
      AGENT_BROWSER_SESSION: "ws_1b9d6bcd",
      CAVEMAN_PORT_WEB: "42100",
      CAVEMAN_PORT_API: "42101",
      CAVEMAN_PORT: "42100",
      PORT: "42100",
    });
    expect(parseComputerConfig("")).toEqual({ setup: {}, run: {}, archive: {}, env: {}, services: {}, computer: {}, idle: {}, network: {}, system: {}, on_wake: {}, start: {} });
    // An absent inputs key (the defaults) and an empty list (none) stay distinct.
    expect(parseComputerConfig(`[setup]\nrun = ["x"]\n`).setup.inputs).toBeUndefined();
    expect(parseComputerConfig(`[setup]\ninputs = []\n`).setup.inputs).toEqual([]);
    expect(parseComputerConfig(`[setup]\ninputs = [\n]\n`).setup.inputs).toEqual([]);
  });

  test("unknown keys, unknown tables and wrong types are errors with the line number", () => {
    const error = (text: string) => {
      try {
        parseComputerConfig(text);
      } catch (e) {
        expect(e).toBeInstanceOf(ComputerConfigError);
        return (e as Error).message;
      }
      throw new Error("parsed");
    };
    expect(error(`[setup]\nrun = ["a"]\n\nrnu = ["b"]\n`)).toBe('.caveman/computer.toml:4: unknown key "setup.rnu"');
    expect(error(`[run]\ncommand = "x"\n[stup]\n`)).toBe(".caveman/computer.toml:3: unknown table [stup]");
    expect(error(`[run]\nports = "web"\n`)).toBe('.caveman/computer.toml:2: "run.ports" must be an array of strings');
    expect(error(`command = "x"\n`)).toBe('.caveman/computer.toml:1: unknown key "command" (keys belong in a table such as [setup])');
    expect(error(`[computer]\nsize = "big"\n`)).toContain('size "big" is not <vCPU>x<GiB>');
    expect(error(`[services]\npostgres = ["16"]\n`)).toBe('.caveman/computer.toml:2: "services.postgres" must be a string');
    // [system]: conda-forge names only (never a flag), at most 64, and its own keys.
    expect(error(`[system]\npackage = ["libvips"]\n`)).toBe('.caveman/computer.toml:2: unknown key "system.package"');
    expect(error(`[system]\npackages = "libvips"\n`)).toBe('.caveman/computer.toml:2: "system.packages" must be an array of strings');
    expect(error(`[setup]\nrun = ["x"]\n\n[system]\npackages = [\n  "libvips",\n  "--prefix=/",\n]\n`)).toBe(
      '.caveman/computer.toml:5: [system] package "--prefix=/" is not a conda-forge name, such as "libvips"',
    );
    expect(error(`[system]\npackages = ["libvips", "apt:libpq-dev"]\n`)).toContain('"apt:libpq-dev" is not a conda-forge name');
    const many = Array.from({ length: 65 }, (_, i) => `"p${i}"`).join(", ");
    expect(error(`[system]\npackages = [${many}]\n`)).toBe(".caveman/computer.toml:2: [system] packages lists 65; at most 64");
    expect(parseComputerConfig(`[system]\npackages = [${Array.from({ length: 64 }, (_, i) => `"p${i}"`).join(", ")}]\n`).system.packages).toHaveLength(64);
  });

  test("[on_wake] and [start]: commands for every boot of a Cloud computer, and whether a first message waits for them", () => {
    const config = parseComputerConfig(`[setup]
run = ["pnpm install --frozen-lockfile"]

[on_wake]
run = ["pnpm db:migrate"] # after the built-in fetch
wait = true

[start]
run = [
  "docker compose up -d",
  'pnpm dev',
]
wait = false
`);
    expect(config.on_wake).toEqual({ run: ["pnpm db:migrate"], wait: true });
    expect(config.start).toEqual({ run: ["docker compose up -d", "pnpm dev"], wait: false });
    // Both tables and each of their keys are optional; `wait` left out reads as false where it is asked.
    expect(parseComputerConfig(`[on_wake]\n[start]\nrun = []\n`)).toMatchObject({ on_wake: {}, start: { run: [] } });
    expect(parseComputerConfig(`[start]\nwait = true`).start).toEqual({ wait: true });
    // Neither is part of the snapshot's identity, as [run] is not: adding or changing one never reinstalls or rebuilds.
    const bare = `[setup]\nrun = ["x"]\n`;
    expect(setupIdentity(parseComputerConfig(`${bare}[on_wake]\nrun = ["a"]\nwait = true\n[start]\nrun = ["b"]\n`))).toBe(setupIdentity(parseComputerConfig(bare)));

    const error = (text: string) => {
      try {
        parseComputerConfig(text);
      } catch (e) {
        expect(e).toBeInstanceOf(ComputerConfigError);
        return (e as Error).message;
      }
      throw new Error("parsed");
    };
    expect(error(`[on_wake]\nrnu = ["a"]\n`)).toBe('.caveman/computer.toml:2: unknown key "on_wake.rnu"');
    expect(error(`[start]\nrun = ["a"]\nports = ["web"]\n`)).toBe('.caveman/computer.toml:3: unknown key "start.ports"');
    expect(error(`[on-wake]\nrun = ["a"]\n`)).toBe(".caveman/computer.toml:1: unknown table [on-wake]");
    expect(error(`[start]\nrun = "pnpm dev"\n`)).toBe('.caveman/computer.toml:2: "start.run" must be an array of strings');
    expect(error(`[on_wake]\nrun = [true]\n`)).toBe('.caveman/computer.toml:2: "on_wake.run" must be an array of strings');
    // `wait` is true or false, bare: never a string, a number or another word.
    expect(error(`[on_wake]\nwait = "true"\n`)).toBe('.caveman/computer.toml:2: "on_wake.wait" must be true or false');
    expect(error(`[start]\nrun = ["a"]\nwait = 1\n`)).toBe('.caveman/computer.toml:3: "start.wait" must be true or false');
    expect(error(`[start]\nwait = yes\n`)).toBe('.caveman/computer.toml:2: "start.wait" must be true or false');
    expect(error(`[start]\nwait = truely\n`)).toBe('.caveman/computer.toml:2: "start.wait" must be true or false');
    expect(error(`[start]\nwait = true false\n`)).toBe(".caveman/computer.toml:2: unexpected text after value");
    expect(error(`[start]\nwait = true\nwait = false\n`)).toBe('.caveman/computer.toml:3: key "start.wait" set twice');
    // A bare true stays an error where a string or a list is expected.
    expect(error(`[env]\nDEBUG = true\n`)).toBe('.caveman/computer.toml:2: "env.DEBUG" must be a string');
    expect(error(`[setup]\nrun = false\n`)).toBe('.caveman/computer.toml:2: "setup.run" must be an array of strings');
  });
});

describe("setupDecision on a snapshot build's disk", () => {
  const toml = `[setup]\nrun = ["true"]\ninputs = ["package.json"]\n`;
  const layer = GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "sp-setup-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  // As handlers.ts calls it: a failure falls back to running setup; a defect would reject.
  const decide = (repo: string, text = fs.readFileSync(path.join(repo, ".caveman/computer.toml"), "utf8"), root?: string) =>
    Effect.runPromise(
      Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) => setupDecision(driver, repo, parseComputerConfig(text), root)).pipe(
        Effect.orElseSucceed(() => ({ run: true, marker: false, fallback: true }) as const),
        Effect.provide(layer),
      ),
    );
  // What the build does: the marker at the clone root, git-excluded.
  const build = (marker: unknown) => {
    const repo = makeRepo(tempRoot("sp-setup-"), { ".caveman/computer.toml": toml, "package.json": "{}\n" });
    fs.appendFileSync(path.join(repo, ".git/info/exclude"), ".caveman/snapshot.json\n");
    const commit = git(repo, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repo, ".caveman/snapshot.json"), typeof marker === "string" ? marker : JSON.stringify(marker ?? { hash: "h", commit, branch: "main" }));
    return { repo, commit };
  };
  const commitFile = (repo: string, file: string, text: string) => {
    fs.writeFileSync(path.join(repo, file), text);
    git(repo, "add", file);
    git(repo, "commit", "-qm", `change ${file}`);
  };

  test("unchanged since the build commit: skip, even after unrelated commits", async () => {
    const { repo } = build(undefined);
    commitFile(repo, "README.md", "x\n");
    expect(await decide(repo)).toEqual({ run: false, marker: true });
  });

  test("an input or computer.toml changed since the build: run once", async () => {
    const a = build(undefined);
    commitFile(a.repo, "package.json", '{"changed":true}\n');
    expect(await decide(a.repo)).toEqual({ run: true, marker: true });
    const b = build(undefined);
    commitFile(b.repo, ".caveman/computer.toml", toml.replace('"true"', '"true && true"'));
    expect(await decide(b.repo)).toEqual({ run: true, marker: true });
  });

  test("only the setup's identity counts: a check, [run] or comment changes nothing; [env], [services], [computer] or [system] reinstall", async () => {
    const a = build(undefined);
    commitFile(a.repo, ".caveman/computer.toml", `# a comment\n${toml}check = ["pnpm test"]\n\n[run]\ncommand = "pnpm dev"\n`);
    expect(await decide(a.repo)).toEqual({ run: false, marker: true });
    for (const table of ['[env]\nDATABASE_URL = "postgres://127.0.0.1/app"', '[services]\npostgres = "16"', '[computer]\nsize = "8x32"', '[system]\npackages = ["libvips"]']) {
      const b = build(undefined);
      commitFile(b.repo, ".caveman/computer.toml", `${toml}\n${table}\n`);
      expect(await decide(b.repo)).toEqual({ run: true, marker: true });
    }
  });

  test("a Cloud copy: the repo has no file, so the setup is the one snapshot.json says it built", async () => {
    const cloudCopy = `[setup]\nrun = ["true"]\ncheck = ["true"]\n\n[env]\nDATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres"\n\n[services]\npostgres = "16"\n`;
    const repo = makeRepo(tempRoot("sp-setup-"), { "package.json": "{}\n" });
    fs.appendFileSync(path.join(repo, ".git/info/exclude"), ".caveman/snapshot.json\n");
    fs.mkdirSync(path.join(repo, ".caveman"));
    const marker = { hash: "h", commit: git(repo, "rev-parse", "HEAD").trim(), branch: "HEAD", built_at: "2026-10-18T00:00:00Z", config: cloudCopy };
    fs.writeFileSync(path.join(repo, ".caveman/snapshot.json"), JSON.stringify(marker));
    const config = readComputerConfig(repo)!;
    expect(config.env).toEqual({ DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres" });
    expect(config.services).toEqual({ postgres: "16" });
    // A computer that runs no Postgres of its own (This Mac) leaves the URL as written.
    expect(workspaceEnv(config, { id: "ws", ports: {} }).DATABASE_URL).toBe("postgres://postgres:postgres@127.0.0.1:5432/postgres");
    expect(await decide(repo, cloudCopy)).toEqual({ run: false, marker: true });
    // The branch gains its own file later: the repo's wins, and a different setup runs once.
    commitFile(repo, ".caveman/computer.toml", `[setup]\nrun = ["true && true"]\n`);
    expect(readComputerConfig(repo)!.setup.run).toEqual(["true && true"]);
    expect(await decide(repo)).toEqual({ run: true, marker: true });
    // A build from before snapshot.json carried its config: computer.toml at its commit, here none.
    fs.writeFileSync(path.join(repo, ".caveman/snapshot.json"), JSON.stringify({ ...marker, config: undefined }));
    fs.rmSync(path.join(repo, ".caveman/computer.toml"));
    expect(readComputerConfig(repo)).toBeNull();
  });

  test("a config without [setup].inputs watches the lockfiles and pins the repo has", async () => {
    const bare = `[setup]\nrun = ["true"]\n`;
    const withoutInputs = (files: Record<string, string>, text = bare) => {
      const repo = makeRepo(tempRoot("sp-setup-"), { ".caveman/computer.toml": text, "package.json": "{}\n", ...files });
      fs.appendFileSync(path.join(repo, ".git/info/exclude"), ".caveman/snapshot.json\n");
      fs.writeFileSync(path.join(repo, ".caveman/snapshot.json"), JSON.stringify({ commit: git(repo, "rev-parse", "HEAD").trim() }));
      return repo;
    };
    // Nothing it watches changed: skip.
    const quiet = withoutInputs({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    commitFile(quiet, "index.ts", "export {};\n");
    expect(await decide(quiet)).toEqual({ run: false, marker: true });
    // A lockfile, a pin, a requirements file (a glob) or a lockfile that is new since the build: run once.
    for (const [file, text] of [
      ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n# changed\n"],
      [".nvmrc", "22\n"],
      ["requirements-dev.txt", "pytest==8\n"],
      ["uv.lock", "version = 1\n"],
    ] as const) {
      const repo = withoutInputs({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", ".nvmrc": "20\n", "requirements-dev.txt": "pytest==7\n" });
      commitFile(repo, file, text);
      expect(await decide(repo), file).toEqual({ run: true, marker: true });
    }
    // One directory down, a dependency file counts (a backend/ beside the root); a pin there or anything deeper doesn't.
    const backend = withoutInputs({ "backend/requirements.txt": "django==5.0\n" });
    commitFile(backend, "backend/requirements.txt", "django==5.1\n");
    expect(await decide(backend)).toEqual({ run: true, marker: true });
    for (const [file, text] of [
      ["examples/a/b/package-lock.json", '{"changed":true}\n'],
      ["backend/.nvmrc", "22\n"],
    ] as const) {
      const repo = withoutInputs({ "examples/a/b/package-lock.json": "{}\n", "backend/.nvmrc": "20\n" });
      commitFile(repo, file, text);
      expect(await decide(repo), file).toEqual({ run: false, marker: true });
    }
    // Listed inputs replace the defaults: a lockfile outside them changes nothing.
    const listed = withoutInputs({ "yarn.lock": "a\n" }, toml);
    commitFile(listed, "yarn.lock", "b\n");
    expect(await decide(listed)).toEqual({ run: false, marker: true });
    // An explicit empty list opts out: setup never reruns on boot, whatever changed.
    const optedOut = withoutInputs({ "pnpm-lock.yaml": "a\n" }, `${bare}inputs = []\n`);
    commitFile(optedOut, "pnpm-lock.yaml", "b\n");
    commitFile(optedOut, "package.json", '{"changed":true}\n');
    expect(await decide(optedOut)).toEqual({ run: false, marker: true });
    expect(DEFAULT_SETUP_INPUTS).toEqual(expect.arrayContaining(["package-lock.json", "go.sum", "Cargo.lock", ".tool-versions", "rust-toolchain.toml", "gradle.lockfile", "*/requirements*.txt"]));
    // Pins stay top level; nothing crosses more than one directory.
    expect(DEFAULT_SETUP_INPUTS.filter((p) => p.startsWith("*/") && /version|mise|rust-toolchain|nvmrc/.test(p))).toEqual([]);
    expect(DEFAULT_SETUP_INPUTS.filter((p) => p.includes("**"))).toEqual([]);
  });

  test("an unreadable marker or a short or unknown commit: run", async () => {
    expect(await decide(build("{bad").repo)).toMatchObject({ run: true, fallback: true });
    expect(await decide(build("null").repo)).toMatchObject({ run: true });
    const { repo, commit } = build(undefined);
    fs.writeFileSync(path.join(repo, ".caveman/snapshot.json"), JSON.stringify({ commit: commit.slice(0, 7) }));
    expect(await decide(repo)).toEqual({ run: true, marker: true });
    fs.writeFileSync(path.join(repo, ".caveman/snapshot.json"), JSON.stringify({ commit: "f".repeat(40) }));
    expect(await decide(repo)).toEqual({ run: true, marker: true });
  });

  // A chat beside a Cloud computer's first one, and every builder, works in a worktree of the clone the build filled.
  const worktreeOf = (repo: string, branch: string) => {
    const at = path.join(tempRoot("sp-setup-wt-"), branch);
    git(repo, "worktree", "add", "-q", "-b", branch, at);
    return at;
  };

  test("a worktree of the build's clone is decided on the clone root's marker: setup is baked in, and never runs there again", async () => {
    const { repo } = build(undefined);
    const chat = worktreeOf(repo, "chat");
    // The build git-excludes its marker, so the worktree has none: alone it reads as a disk nothing was installed on.
    expect(fs.existsSync(path.join(chat, ".caveman/snapshot.json"))).toBe(false);
    expect(await decide(chat)).toEqual({ run: true, marker: false });
    // With the clone it is a checkout of: the root's marker, against the worktree's own HEAD.
    expect(await decide(chat, undefined, repo)).toEqual({ run: false, marker: true, root: true });
    commitFile(chat, "README.md", "the chat's own work\n");
    expect(await decide(chat, undefined, repo)).toEqual({ run: false, marker: true, root: true });
    // The root itself (the computer's first chat, in place) answers as before, with or without being named its own root.
    expect(await decide(repo)).toEqual({ run: false, marker: true });
    expect(await decide(repo, undefined, repo)).toEqual({ run: false, marker: true });
    expect(await decide(repo, undefined, `${repo}${path.sep}`)).toEqual({ run: false, marker: true });
  });

  test("a worktree whose branch changed a watched input or the setup since the build: setup runs there once", async () => {
    const { repo } = build(undefined);
    // A lockfile changed on the chat's own branch.
    const moved = worktreeOf(repo, "moved");
    commitFile(moved, "package.json", '{"changed":true}\n');
    expect(await decide(moved, undefined, repo)).toEqual({ run: true, marker: true, root: true });
    // The default branch moved on after the build and the chat was cut from it: the same, though the root stayed behind.
    commitFile(repo, "package.json", '{"main":"moved"}\n');
    const late = worktreeOf(repo, "late");
    git(repo, "reset", "-q", "--hard", "HEAD~1");
    expect(await decide(late, undefined, repo)).toEqual({ run: true, marker: true, root: true });
    expect(await decide(repo)).toEqual({ run: false, marker: true });
    // The setup itself changed on the branch (its identity): once too. A check, [run], [on_wake] or [start] is no such change.
    const other = worktreeOf(repo, "other");
    commitFile(other, ".caveman/computer.toml", `${toml}check = ["true"]\n\n[on_wake]\nrun = ["true"]\n\n[start]\nrun = ["true"]\nwait = true\n`);
    expect(await decide(other, undefined, repo)).toEqual({ run: false, marker: true, root: true });
    commitFile(other, ".caveman/computer.toml", toml.replace('"true"', '"true && true"'));
    expect(await decide(other, undefined, repo)).toEqual({ run: true, marker: true, root: true });
  });

  test("no build's marker at the clone root (This Mac), a committed one, or one with an unknown commit: setup runs in the worktree as before", async () => {
    // This Mac: a project's own checkout has no marker, and its chats' worktrees run setup.
    const mac = makeRepo(tempRoot("sp-setup-"), { ".caveman/computer.toml": toml, "package.json": "{}\n" });
    expect(await decide(worktreeOf(mac, "chat"), undefined, mac)).toEqual({ run: true, marker: false });
    // A marker the repository commits is no build's: it is in the root and in the worktree, and counts in neither.
    const committed = makeRepo(tempRoot("sp-setup-"), { ".caveman/computer.toml": toml, "package.json": "{}\n" });
    fs.writeFileSync(path.join(committed, ".caveman/snapshot.json"), JSON.stringify({ commit: git(committed, "rev-parse", "HEAD").trim() }));
    git(committed, "add", ".caveman/snapshot.json");
    git(committed, "commit", "-qm", "a marker");
    const copy = worktreeOf(committed, "chat");
    expect(fs.existsSync(path.join(copy, ".caveman/snapshot.json"))).toBe(true);
    expect(await decide(copy, undefined, committed)).toEqual({ run: true, marker: false });
    // A branch that commits a marker of its own beside a real build's: the worktree's own file is what is read, and it does not count.
    const { repo, commit } = build(undefined);
    const forged = worktreeOf(repo, "forged");
    fs.writeFileSync(path.join(forged, ".caveman/snapshot.json"), JSON.stringify({ commit }));
    git(forged, "add", "-f", ".caveman/snapshot.json");
    git(forged, "commit", "-qm", "a marker");
    expect(await decide(forged, undefined, repo)).toEqual({ run: true, marker: false });
    // The root's marker names a commit the clone does not have, or none: run, and say the marker was there.
    const unknown = build({ commit: "f".repeat(40) });
    expect(await decide(worktreeOf(unknown.repo, "chat"), undefined, unknown.repo)).toEqual({ run: true, marker: true, root: true });
    const short = build({ commit: unknown.commit.slice(0, 7) });
    expect(await decide(worktreeOf(short.repo, "chat"), undefined, short.repo)).toEqual({ run: true, marker: true, root: true });
    expect(await decide(worktreeOf(build("{bad").repo, "chat"))).toMatchObject({ run: true, marker: false });
  });

  test("a worktree of a repo with no computer.toml reads the setup the build ran, from the clone root's marker", async () => {
    const cloudCopy = `[setup]\nrun = ["true"]\ncache = ["node_modules"]\n\n[env]\nNODE_ENV = "development"\n\n[start]\nrun = ["pnpm dev"]\n`;
    const repo = makeRepo(tempRoot("sp-setup-"), { "package.json": "{}\n" });
    fs.appendFileSync(path.join(repo, ".git/info/exclude"), ".caveman/snapshot.json\n");
    fs.mkdirSync(path.join(repo, ".caveman"));
    fs.writeFileSync(path.join(repo, ".caveman/snapshot.json"), JSON.stringify({ hash: "h", commit: git(repo, "rev-parse", "HEAD").trim(), branch: "main", built_at: "2026-11-10T00:00:00Z", config: cloudCopy }));
    const chat = worktreeOf(repo, "chat");
    expect(cloneRootOf(chat)).toBe(fs.realpathSync(repo));
    // The clone is its own root, and a folder that is no checkout has none.
    expect(cloneRootOf(repo)).toBeUndefined();
    expect(cloneRootOf(path.dirname(chat))).toBeUndefined();
    const config = readComputerConfig(chat)!;
    expect(config.setup).toEqual({ run: ["true"], cache: ["node_modules"] });
    expect(config.env).toEqual({ NODE_ENV: "development" });
    expect(config.start).toEqual({ run: ["pnpm dev"] });
    expect(await decide(chat, cloudCopy, repo)).toEqual({ run: false, marker: true, root: true });
    // The branch gains its own file: the repo's wins, as at the root.
    fs.mkdirSync(path.join(chat, ".caveman"));
    commitFile(chat, ".caveman/computer.toml", `[setup]\nrun = ["true && true"]\n`);
    expect(readComputerConfig(chat)!.setup.run).toEqual(["true && true"]);
    expect(await decide(chat, undefined, repo)).toEqual({ run: true, marker: true, root: true });
    // A worktree of a clone no build filled has no setup at all, as before.
    const plain = makeRepo(tempRoot("sp-setup-"), { "package.json": "{}\n" });
    expect(readComputerConfig(worktreeOf(plain, "chat"))).toBeNull();
  });

  test("what setup installed must be in the worktree for it to be ready: the cache paths the root has and the worktree lacks", () => {
    const root = tempRoot("sp-setup-caches-");
    const [clone, chat] = [path.join(root, "clone"), path.join(root, "chat")];
    fs.mkdirSync(path.join(clone, "node_modules/dep"), { recursive: true });
    fs.mkdirSync(path.join(clone, "apps/web/.next"), { recursive: true });
    fs.mkdirSync(chat);
    const cache = ["node_modules", "apps/web/.next", ".turbo", "../outside", path.join(root, "absolute")];
    // Nothing came: both paths the root has are missing. One the root never had (.turbo) is not, nor one never brought.
    expect(cachesMissing(clone, chat, cache)).toEqual(["node_modules", "apps/web/.next"]);
    fs.mkdirSync(path.join(chat, "node_modules"));
    expect(cachesMissing(clone, chat, cache)).toEqual(["apps/web/.next"]);
    fs.mkdirSync(path.join(chat, "apps/web/.next"), { recursive: true });
    expect(cachesMissing(clone, chat, cache)).toEqual([]);
    expect(cachesMissing(clone, chat, [])).toEqual([]);
  });
});

describe("workspace lifecycle on This Mac", () => {
  let root: string;
  let transcript: Transcript;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;
  const events = new Map<string, Array<SessionEvent>>();

  beforeAll(async () => {
    root = tempRoot("sp-life-");
    transcript = await loadTranscript();
    runtime = await startRuntime(await makeConfig(), transcript);
    client = connect(runtime.url, runtime.token);
  });
  afterAll(async () => {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const create = async (repo: string, request: string) => {
    const workspace = await createReady(client, { request_id: request, repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
    const list: Array<SessionEvent> = [];
    events.set(workspace.id, list);
    await client.attach(workspace.session_id, 0, (event) => list.push(event));
    return workspace;
  };
  const notes = (id: string) =>
    (events.get(id) ?? []).flatMap((e) => (e.type === "notification" ? [`${e.payload.level}: ${e.payload.title}`] : []));
  const worktreeOf = (repo: string, branch: string) => {
    const lines = git(repo, "worktree", "list", "--porcelain").split("\n");
    const at = lines.indexOf(`branch refs/heads/${branch}`);
    return at < 0 ? undefined : lines[at - 2]!.slice("worktree ".length);
  };

  test("a chat starts from its base as GitHub has it and counts only its own changes, when the local base fell behind and ran ahead", async () => {
    const remote = path.join(root, "origin-start.git");
    git(root, "clone", "-q", "--bare", makeRepo(root, { "a.txt": "a\n" }), remote);
    const repo = path.join(root, "clone-start");
    const other = path.join(root, "other-start");
    git(root, "clone", "-q", remote, repo);
    git(root, "clone", "-q", remote, other);
    // GitHub moves on from another checkout; this checkout's main gets a merge nothing pushed.
    fs.writeFileSync(path.join(other, "b.txt"), "b\n");
    git(other, "add", ".");
    git(other, "commit", "-qm", "b on GitHub");
    git(other, "push", "-q", "origin", "main");
    fs.writeFileSync(path.join(repo, "local.txt"), "local\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "merged here, never pushed");
    const localMain = git(repo, "rev-parse", "main").trim();

    const w = await create(repo, "start-from-origin");
    const tree = worktreeOf(repo, w.branch)!;
    expect(git(tree, "rev-parse", "HEAD").trim()).toBe(git(other, "rev-parse", "HEAD").trim());
    expect(git(repo, "rev-parse", "main").trim()).toBe(localMain);
    expect((await client.call("fs.diff", { workspace_id: w.id })).files).toEqual([]);
    fs.writeFileSync(path.join(tree, "mine.txt"), "mine\n");
    expect((await client.call("fs.diff", { workspace_id: w.id })).files.map((f) => f.path)).toEqual(["mine.txt"]);
  });

  test("ports per workspace, exported to setup with [env]; freed on archive; archive script runs before removal; restore keeps the session", async () => {
    const out = path.join(root, "archive-ran.txt");
    // In the shell line with `/`: a Windows path's backslashes are escapes in TOML's strings and in Git Bash.
    const shellOut = out.split(path.sep).join("/");
    const repo = makeRepo(root, {
      "README.md": "hi\n",
      ".caveman/computer.toml": `[setup]\nrun = ["echo $CAVEMAN_PORT_WEB $CAVEMAN_PORT_API $CAVEMAN_PORT $GREETING > setup.txt"]\n[run]\ncommand = "pnpm dev"\nports = ["web", "api"]\n[archive]\nrun = ["test -f setup.txt && echo archived > '${shellOut}'"]\n[env]\nGREETING = "hello"\n`,
    });
    const a = await create(repo, "life-a");
    const b = await create(repo, "life-b");
    expect(a.run_command).toBe("pnpm dev");
    expect(Object.keys(a.ports ?? {})).toEqual(["web", "api"]);
    const all = [...Object.values(a.ports!), ...Object.values(b.ports!)];
    expect(new Set(all).size).toBe(4);

    const tree = worktreeOf(repo, a.branch)!;
    await until(() => notes(a.id).some((n) => n.startsWith("info: Setup finished")));
    expect(fs.readFileSync(path.join(tree, "setup.txt"), "utf8").trim()).toBe(`${a.ports!.web} ${a.ports!.api} ${a.ports!.web} hello`);

    const archived = await client.call("workspace.archive", { request_id: "archive-a", workspace_id: a.id });
    expect(archived.status).toBe("archived");
    expect(archived.ports).toBeUndefined();
    expect(fs.readFileSync(out, "utf8").trim()).toBe("archived");
    expect(fs.existsSync(tree)).toBe(false);
    expect((await client.call("workspace.list", {})).workspaces.map((w) => w.id)).not.toContain(a.id);
    expect((await client.call("workspace.list", { include_archived: true })).workspaces.map((w) => w.id)).toContain(a.id);

    // A's ports are free again: the next workspace gets the lowest ones back.
    const c = await create(repo, "life-c");
    expect(Object.values(c.ports!).sort()).toEqual(Object.values(a.ports!).sort());

    const restored = await client.call("workspace.restore", { request_id: "restore-a", workspace_id: a.id });
    expect(restored.status).toBe("idle");
    expect(restored.session_id).toBe(a.session_id);
    expect(restored.branch).toBe(a.branch);
    const fresh = worktreeOf(repo, a.branch)!;
    expect(fresh).not.toBe(tree);
    expect(fs.existsSync(path.join(fresh, "README.md"))).toBe(true);
  });

  test("archive keeps the chat's uncommitted work and restore puts it back uncommitted; a moved branch keeps it on the ref", async () => {
    const repo = makeRepo(root, { "README.md": "hi\n", "other.txt": "other\n" });
    const w = await create(repo, "keep-a");
    const tree = worktreeOf(repo, w.branch)!;
    fs.writeFileSync(path.join(tree, "README.md"), "edited by the agent\n");
    fs.writeFileSync(path.join(tree, "new.txt"), "never committed\n");
    fs.rmSync(path.join(tree, "other.txt"));
    await client.call("workspace.archive", { request_id: "keep-archive", workspace_id: w.id });
    expect(fs.existsSync(tree)).toBe(false);
    const ref = `refs/caveman/archived/${w.id}`;
    expect(git(repo, "for-each-ref", "--format=%(refname)", ref).trim()).toBe(ref);

    const restored = await client.call("workspace.restore", { request_id: "keep-restore", workspace_id: w.id });
    const fresh = restored.root_path!;
    expect(fs.readFileSync(path.join(fresh, "README.md"), "utf8")).toBe("edited by the agent\n");
    expect(fs.readFileSync(path.join(fresh, "new.txt"), "utf8")).toBe("never committed\n");
    expect(fs.existsSync(path.join(fresh, "other.txt"))).toBe(false);
    // Uncommitted again, as they were: nothing staged, nothing committed, the ref gone.
    expect(git(fresh, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" D other.txt", " M README.md", "?? new.txt"]);
    expect(git(fresh, "rev-parse", "HEAD").trim()).toBe(git(repo, "rev-parse", "main").trim());
    expect(git(repo, "for-each-ref", "--format=%(refname)", ref).trim()).toBe("");

    // A clean chat archives without a ref.
    const clean = await create(repo, "keep-clean");
    await client.call("workspace.archive", { request_id: "keep-clean-archive", workspace_id: clean.id });
    expect(git(repo, "for-each-ref", "--format=%(refname)", `refs/caveman/archived/${clean.id}`).trim()).toBe("");

    // The branch moved while archived: the work stays on the ref and the chat says where.
    await client.call("workspace.archive", { request_id: "keep-archive-2", workspace_id: w.id });
    const moved = git(repo, "commit-tree", `${w.branch}^{tree}`, "-p", w.branch, "-m", "moved").trim();
    git(repo, "update-ref", `refs/heads/${w.branch}`, moved);
    const again = await client.call("workspace.restore", { request_id: "keep-restore-2", workspace_id: w.id });
    expect(fs.existsSync(path.join(again.root_path!, "new.txt"))).toBe(false);
    expect(git(repo, "for-each-ref", "--format=%(refname)", ref).trim()).toBe(ref);
    await until(() => notes(w.id).includes("warning: Uncommitted changes from before the archive were not put back"));
  });

  test("archiving again keeps the work an earlier restore could not put back on the ref it named, through gc", async () => {
    const repo = makeRepo(root, { "README.md": "hi\n" });
    const w = await create(repo, "again-a");
    const ref = `refs/caveman/archived/${w.id}`;
    fs.writeFileSync(path.join(worktreeOf(repo, w.branch)!, "w1.txt"), "first work, never committed\n");
    await client.call("workspace.archive", { request_id: "again-archive-1", workspace_id: w.id });
    const first = git(repo, "rev-parse", ref).trim();
    // The branch moves while archived: restore leaves the first work on the ref and says so.
    git(repo, "update-ref", `refs/heads/${w.branch}`, git(repo, "commit-tree", `${w.branch}^{tree}`, "-p", w.branch, "-m", "moved").trim());
    const restored = await client.call("workspace.restore", { request_id: "again-restore-1", workspace_id: w.id });
    await until(() => notes(w.id).includes("warning: Uncommitted changes from before the archive were not put back"));

    // New uncommitted work, and the chat is archived again.
    fs.writeFileSync(path.join(restored.root_path!, "w2.txt"), "second work\n");
    await client.call("workspace.archive", { request_id: "again-archive-2", workspace_id: w.id });
    git(repo, "gc", "--prune=now", "--quiet");
    expect(git(repo, "for-each-ref", "--contains", first, "--format=%(refname)").trim()).toBe(ref);
    expect(git(repo, "show", `${first}:w1.txt`)).toBe("first work, never committed\n");

    // The branch stayed put this time: the second work comes back, and the first stays on the ref.
    const again = await client.call("workspace.restore", { request_id: "again-restore-2", workspace_id: w.id });
    expect(fs.readFileSync(path.join(again.root_path!, "w2.txt"), "utf8")).toBe("second work\n");
    expect(git(again.root_path!, "status", "--porcelain").trim()).toBe("?? w2.txt");
    expect(git(repo, "rev-parse", ref).trim()).toBe(first);
  });

  test("an archive that does not go through leaves the ref as it found it, so edits the person discarded never come back", async () => {
    const repo = makeRepo(root, { "README.md": "hi\n" });
    const w = await create(repo, "undone-a");
    const ref = `refs/caveman/archived/${w.id}`;
    const worktree = worktreeOf(repo, w.branch)!;
    fs.writeFileSync(path.join(worktree, "w1.txt"), "first try\n");
    // Its worktree is locked: the archive keeps the work, cannot remove the worktree, and does not go through.
    git(repo, "worktree", "lock", worktree);
    await expect(client.call("workspace.archive", { request_id: "undone-archive-1", workspace_id: w.id })).rejects.toThrow(/removeWorktree/);
    expect((await client.call("workspace.get", { workspace_id: w.id })).status).not.toBe("archived");
    expect(git(repo, "for-each-ref", ref).trim()).toBe("");

    // The person changes the work and archives it again; restore brings that back, and nothing stays on the ref.
    git(repo, "worktree", "unlock", worktree);
    fs.writeFileSync(path.join(worktree, "w1.txt"), "second try\n");
    await client.call("workspace.archive", { request_id: "undone-archive-2", workspace_id: w.id });
    const restored = await client.call("workspace.restore", { request_id: "undone-restore-1", workspace_id: w.id });
    expect(fs.readFileSync(path.join(restored.root_path!, "w1.txt"), "utf8")).toBe("second try\n");
    expect(git(repo, "for-each-ref", ref).trim()).toBe("");

    // Discarded, the chat goes and comes back clean.
    fs.rmSync(path.join(restored.root_path!, "w1.txt"));
    await client.call("workspace.archive", { request_id: "undone-archive-3", workspace_id: w.id });
    const again = await client.call("workspace.restore", { request_id: "undone-restore-2", workspace_id: w.id });
    expect(git(again.root_path!, "status", "--porcelain").trim()).toBe("");
  });

  test("an archive that stopped after keeping the work keeps it once when it is made again", async () => {
    const repo = makeRepo(root, { "README.md": "hi\n" });
    const w = await create(repo, "kept-once-a");
    const ref = `refs/caveman/archived/${w.id}`;
    const worktree = worktreeOf(repo, w.branch)!;
    fs.writeFileSync(path.join(worktree, "w1.txt"), "the work\n");
    // What a runtime that stopped right after keeping it left: the work on the ref, the worktree still there.
    git(worktree, "add", "-A");
    const tree = git(worktree, "write-tree").trim();
    git(worktree, "reset", "-q");
    const kept = git(worktree, "commit-tree", tree, "-p", "HEAD", "-m", "Caveman Code: uncommitted work when the chat was archived").trim();
    git(repo, "update-ref", ref, kept);
    await client.call("workspace.archive", { request_id: "kept-once-archive-1", workspace_id: w.id });
    expect(git(repo, "rev-parse", ref).trim()).toBe(kept);

    // Restored, then discarded: the chat goes and comes back clean.
    const restored = await client.call("workspace.restore", { request_id: "kept-once-restore-1", workspace_id: w.id });
    expect(fs.readFileSync(path.join(restored.root_path!, "w1.txt"), "utf8")).toBe("the work\n");
    fs.rmSync(path.join(restored.root_path!, "w1.txt"));
    await client.call("workspace.archive", { request_id: "kept-once-archive-2", workspace_id: w.id });
    const again = await client.call("workspace.restore", { request_id: "kept-once-restore-2", workspace_id: w.id });
    expect(git(again.root_path!, "status", "--porcelain").trim()).toBe("");
  });

  test("a chat git cannot make a worktree for opens, says why in words on its worktree row, and leaves nothing behind", async () => {
    // The chat opens at once; its worktree row ends failed with the reason, and only archive works on it.
    const reason = async (params: object) => {
      const w = await client.call("workspace.create", { request_id: `why-${Math.random()}`, engine: "claude-agent", options: { model: MODEL }, task: { text: "hi" }, ...params } as never);
      const seen: Array<SessionEvent> = [];
      await client.attach(w.session_id, 0, (event) => seen.push(event));
      await until(() => seen.some((e) => e.type === "notification"));
      const [message, started, done, notice] = seen;
      expect([message?.type, started?.type, done?.type, notice?.type]).toEqual(["message.done", "tool.started", "tool.done", "notification"]);
      expect(started?.type === "tool.started" && started.payload.name).toBe("worktree");
      expect(done?.item_id).toBe(started?.item_id);
      expect(notice?.type === "notification" && notice.payload).toEqual({ level: "warning", title: "This chat could not start", body: "Archive it and start a new chat." });
      expect((await client.call("workspace.get", { workspace_id: w.id })).status).toBe("failed");
      await expect(client.call("turn.submit", { request_id: `why-turn-${w.id}`, session_id: w.session_id, kind: "followup", input: { text: "again" } })).rejects.toMatchObject({
        error: { data: { reason: "invalid_state" } },
      });
      expect((await client.call("workspace.archive", { request_id: `why-archive-${w.id}`, workspace_id: w.id })).status).toBe("archived");
      return done?.type === "tool.done" ? `${done.payload.status}: ${done.payload.error}` : "missing";
    };
    const empty = path.join(root, "brand-new");
    fs.mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    expect(await reason({ repo: { path: empty } })).toBe("failed: brand-new has no commits yet. Make a first commit, then start a chat in it.");
    const repo = makeRepo(root, { "README.md": "hi\n" });
    const name = path.basename(repo);
    expect(await reason({ repo: { path: repo }, base_ref: "no-such" })).toBe(`failed: ${name} has no branch or commit named no-such.`);
    await create(repo, "why-taken");
    git(repo, "branch", "taken");
    expect(await reason({ repo: { path: repo }, branch: "taken" })).toBe(`failed: ${name} already has a branch named taken. Pick another branch name.`);
    expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(2);
    expect(git(repo, "branch", "--list", "taken").trim()).toBe("taken");
  });

  test("fs.read at a ref returns a binary file's own bytes, capped by max_bytes with its full size", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const repo = makeRepo(root, { "README.md": "hi\n" });
    fs.writeFileSync(path.join(repo, "dot.png"), png);
    git(repo, "add", "dot.png");
    git(repo, "commit", "-qm", "image");
    const w = await create(repo, "binary-ref");
    const read = await client.call("fs.read", { workspace_id: w.id, path: "dot.png", ref: "main" });
    expect(read).toMatchObject({ encoding: "base64", mime_type: "image/png", size: png.length, truncated: false });
    expect(Buffer.from(read.content, "base64").equals(png)).toBe(true);
    const capped = await client.call("fs.read", { workspace_id: w.id, path: "dot.png", ref: "main", max_bytes: 10 });
    expect(capped).toMatchObject({ size: png.length, truncated: true });
    expect(Buffer.from(capped.content, "base64").equals(png.subarray(0, 10))).toBe(true);
    expect((await client.call("fs.read", { workspace_id: w.id, path: "README.md", ref: "main" })).content).toBe("hi\n");
    await expect(client.call("fs.read", { workspace_id: w.id, path: "nope.png", ref: "main" })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
  });

  test("a failed setup leaves the workspace usable and says so", async () => {
    const repo = makeRepo(root, { ".caveman/computer.toml": `[setup]\nrun = ["echo before", "exit 3", "echo never > never.txt"]\n` });
    const w = await create(repo, "life-fail");
    await until(() => notes(w.id).some((n) => n.startsWith("warning: Setup failed")));
    const note = events.get(w.id)!.find((e) => e.type === "notification" && e.payload.level === "warning");
    expect(note?.type === "notification" && note.payload.body).toContain("before");
    expect(fs.existsSync(path.join(worktreeOf(repo, w.branch)!, "never.txt"))).toBe(false);
    const read = await client.call("fs.read", { workspace_id: w.id, path: ".caveman/computer.toml" });
    expect(read.content).toContain("exit 3");
    expect((await client.call("workspace.get", { workspace_id: w.id })).status).toBe("idle");
  });

  test("an unknown key in computer.toml is reported with its line", async () => {
    const repo = makeRepo(root, { ".caveman/computer.toml": `[setup]\nrun = ["true"]\nrnu = ["x"]\n` });
    const w = await create(repo, "life-typo");
    await until(() => notes(w.id).length > 0);
    const note = events.get(w.id)!.find((e) => e.type === "notification");
    expect(note?.type === "notification" && note.payload.body).toBe('.caveman/computer.toml:3: unknown key "setup.rnu"');
  });

  describe("setup never reruns on a ready disk", () => {
    const toml = `[setup]\nrun = ["echo ran >> setup-count.log"]\ncache = ["node_modules"]\ninputs = ["package.json"]\n`;
    // What the cloud build writes; the runtime compares by commit, not hash.
    const markerFor = (repo: string) =>
      JSON.stringify({ hash: "cloud-identity", commit: git(repo, "rev-parse", "HEAD").trim(), branch: "main", built_at: "2026-10-15T00:00:00Z" });

    test("a committed marker is not a build's: setup runs", async () => {
      const repo = makeRepo(root, { ".caveman/computer.toml": toml, "package.json": "{}\n" });
      fs.writeFileSync(path.join(repo, ".caveman/snapshot.json"), markerFor(repo));
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "marker");
      const w = await create(repo, "marker-committed");
      await until(() => notes(w.id).some((n) => n.startsWith("info: Setup finished")));
      expect(fs.readFileSync(path.join(worktreeOf(repo, w.branch)!, "setup-count.log"), "utf8")).toBe("ran\n");
    });

    // Skipped on Windows, which brings no caches.
    test.skipIf(process.platform === "win32")("no marker: caches come from the first checkout before setup (cloned copy-on-write, else node_modules hard-linked), and the note says how", async () => {
      const repo = makeRepo(root, { ".caveman/computer.toml": toml.replace('echo ran', 'test -f node_modules/dep/index.js && echo ran'), ".gitignore": "node_modules\n" });
      fs.mkdirSync(path.join(repo, "node_modules/dep"), { recursive: true });
      fs.writeFileSync(path.join(repo, "node_modules/dep/index.js"), "module.exports = 1;\n");
      const w = await create(repo, "cow");
      await until(() => notes(w.id).some((n) => n.startsWith("info: Setup finished") || n.startsWith("warning:")));
      const tree = worktreeOf(repo, w.branch)!;
      expect(notes(w.id)[0]).toMatch(/^info: Setup finished/);
      const note = events.get(w.id)!.find((e) => e.type === "notification");
      expect(note?.type === "notification" && note.payload.body).toBe(`${tempDirClones ? "Cloned" : "Hard-linked"} from the first checkout: node_modules`);
      expect(fs.lstatSync(path.join(tree, "node_modules")).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(tree, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1;\n");
      expect(fs.readFileSync(path.join(tree, "setup-count.log"), "utf8")).toBe("ran\n");
    });
  });
});

describe("archiving a chat whose engine is at work", () => {
  let root: string;
  let config: Awaited<ReturnType<typeof makeConfig>>;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;

  beforeAll(async () => {
    root = tempRoot("sp-archive-working-");
    config = await makeConfig();
    runtime = await startRuntime(config, "fake-claude");
    client = connect(runtime.url, runtime.token);
  });
  afterAll(async () => {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("stops its turn and archives T3's thread: no run left, its engine session closed; restore takes turns again", async () => {
    const repo = makeRepo(root, { "README.md": "hello\n" });
    const w = await createReady(client, { request_id: "busy-create", repo: { path: repo }, title: "Busy", engine: "claude-agent", options: { model: MODEL } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "busy-turn", session_id: w.session_id, kind: "followup", input: { text: "slow 60000: keep working" } });
    await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "assistant"));
    const threadId = ThreadId.make(`caveman:${w.id}`);
    const engine = async () => {
      const projection = await Effect.runPromise(orchestratorOf(runtime).getThreadProjection(threadId));
      return {
        threadArchived: projection.thread.archivedAt !== null,
        activeRuns: projection.runs.filter((r) => ["preparing", "queued", "starting", "running", "waiting"].includes(r.status)).map((r) => r.status),
        liveSessions: projection.providerSessions.filter((s) => s.status !== "stopped" && s.status !== "error").map((s) => s.status),
      };
    };
    expect((await engine()).activeRuns).toEqual(["running"]);

    const archived = await client.call("workspace.archive", { request_id: "busy-archive", workspace_id: w.id });
    expect(archived.status).toBe("archived");
    expect(fs.existsSync(w.root_path!)).toBe(false);
    const stopped = { threadArchived: true, activeRuns: [], liveSessions: [] };
    await until(async () => JSON.stringify(await engine()) === JSON.stringify(stopped), 10_000).catch(() => undefined);
    expect(await engine()).toEqual(stopped);
 // upstream own archive cleanup ran: the engine session's detach revoked the thread's MCP credential, and its terminals
    // were cleaned up.
    const cleanup = () => {
      const db = new DatabaseSync(config.dbPath, { readOnly: true });
      try {
        return (db.prepare("SELECT effect_type AS type, payload_json AS payload, status FROM orchestration_v2_effect_outbox WHERE thread_id = ? AND effect_type IN ('provider-session.detach', 'terminal.cleanup')").all(threadId) as Array<{ type: string; payload: string; status: string }>)
          .map((row) => ({ type: row.type, revokes: (JSON.parse(row.payload) as { revokeMcpCredential?: boolean }).revokeMcpCredential === true, status: row.status }))
          .sort((a, b) => a.type.localeCompare(b.type));
      } finally {
        db.close();
      }
    };
    const cleaned = [
      { type: "provider-session.detach", revokes: true, status: "succeeded" },
      { type: "terminal.cleanup", revokes: false, status: "succeeded" },
    ];
    await until(() => JSON.stringify(cleanup()) === JSON.stringify(cleaned), 10_000).catch(() => undefined);
    expect(cleanup()).toEqual(cleaned);

    const restored = await client.call("workspace.restore", { request_id: "busy-restore", workspace_id: w.id });
    expect(restored.status).toBe("idle");
    expect((await engine()).threadArchived).toBe(false);
    const done = events.filter((e) => e.type === "turn.done").length;
    await client.call("turn.submit", { request_id: "after-restore", session_id: w.session_id, kind: "followup", input: { text: "back again" } });
    await until(() => events.filter((e) => e.type === "turn.done").length > done, 30_000);
    const said = events.filter((e) => e.type === "message.done" && e.payload.role === "assistant").at(-1);
    expect(said?.type === "message.done" && said.payload.text).toBe("smoke ok: back again");
  }, 90_000);
});

describe("snapshotWorkInProgress", () => {
  const layer = GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "sp-wip-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const snapshot = (repo: string, ref = "refs/caveman/sessions/s1", options?: { readonly leave?: boolean | "untracked" }) =>
    Effect.runPromise(Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) => snapshotWorkInProgress(driver, repo, ref, "wip", options)).pipe(Effect.provide(layer)));
  /** The worktree's own index as indexSeed answers it (undefined: read-tree HEAD). */
  const seedOf = (repo: string) => Effect.runPromise(Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) => indexSeed(driver, repo)).pipe(Effect.provide(layer)));
  /** Every file under `root` but .git, with its bytes and mode. */
  const files = (root: string): Record<string, string> =>
    Object.fromEntries(
      (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as Array<fs.Dirent>)
        .filter((d) => d.isFile() && !path.relative(root, path.join(d.parentPath, d.name)).startsWith(".git"))
        .map((d) => {
          const full = path.join(d.parentPath, d.name);
          return [path.relative(root, full), `${fs.statSync(full).mode.toString(8)}:${fs.readFileSync(full).toString("base64")}`];
        })
        .sort(),
    );

  test("a snapshot that leaves the machine leaves secret-shaped files git does not ignore here, lists them, and changes nothing in the checkout (decision 24)", async () => {
    const repo = makeRepo(tempRoot("sp-wip-secrets-"), { "README.md": "hello\n", ".env.local": "TOKEN=head\n", "config/app.key": "head key\n" });
    fs.appendFileSync(path.join(repo, ".gitignore"), "ignored.env\n");
    git(repo, "add", ".gitignore");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore");
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=never-leaves-untracked\n", { mode: 0o600 });
    fs.mkdirSync(path.join(repo, "keys"));
    fs.writeFileSync(path.join(repo, "keys", "id_ed25519"), "never-leaves-ssh\n", { mode: 0o600 });
    fs.writeFileSync(path.join(repo, ".env.local"), "TOKEN=never-leaves-tracked\n");
    fs.writeFileSync(path.join(repo, "server.pem"), "never-leaves-staged\n");
    git(repo, "add", "server.pem");
    fs.writeFileSync(path.join(repo, "prod.tfvars"), "never-leaves-tfvars\n");
    // In any case (a Mac's checkout ignores it), more of the names, and a folder so named with what is in it.
    fs.writeFileSync(path.join(repo, "Deploy.PEM"), "never-leaves-upper-pem\n");
    fs.writeFileSync(path.join(repo, ".ENV.PROD"), "never-leaves-upper-env\n");
    fs.writeFileSync(path.join(repo, "terraform.tfstate.backup"), "never-leaves-tfstate-backup\n");
    fs.writeFileSync(path.join(repo, "ID_ECDSA"), "never-leaves-ecdsa\n");
    fs.mkdirSync(path.join(repo, "sub", ".env.d"), { recursive: true });
    fs.writeFileSync(path.join(repo, "sub", ".env.d", "secret"), "never-leaves-env-dir\n");
    fs.writeFileSync(path.join(repo, "ignored.env"), "ignored, not ours to list\n");
    fs.writeFileSync(path.join(repo, "README.md"), "hello, edited\n");
    fs.writeFileSync(path.join(repo, "work.txt"), "work\n");
    const before = { files: files(repo), cached: git(repo, "diff", "--cached", "--name-only"), status: git(repo, "status", "--porcelain"), stash: git(repo, "stash", "list") };
    const out = await snapshot(repo, "refs/caveman/sessions/s1", { leave: true });
    const tree = git(repo, "ls-tree", "-r", "--name-only", out.commit).trim().split("\n");
    expect(tree).toEqual(expect.arrayContaining(["README.md", "work.txt", ".env.local", "config/app.key", ".gitignore"]));
    for (const gone of [".env", "keys/id_ed25519", "server.pem", "prod.tfvars", "ignored.env", "Deploy.PEM", ".ENV.PROD", "terraform.tfstate.backup", "ID_ECDSA", "sub/.env.d/secret"]) expect(tree).not.toContain(gone);
    expect(spawnSync("git", ["grep", "-c", "never-leaves", out.commit, "--"], { cwd: repo, encoding: "utf8" }).stdout).toBe("");
    // A tracked one keeps HEAD's version in the pack.
    expect(git(repo, "show", `${out.commit}:.env.local`)).toBe("TOKEN=head\n");
    expect(git(repo, "show", `${out.commit}:README.md`)).toBe("hello, edited\n");
    // What is inside a folder so named is named once, as the folder.
    expect(out.left).toEqual([".ENV.PROD", ".env", ".env.local", "Deploy.PEM", "ID_ECDSA", "keys/id_ed25519", "prod.tfvars", "server.pem", "sub/.env.d/", "terraform.tfstate.backup"]);
    // Nothing here moved: bytes and modes, the index, the status, and no stash.
    expect({ files: files(repo), cached: git(repo, "diff", "--cached", "--name-only"), status: git(repo, "status", "--porcelain"), stash: git(repo, "stash", "list") }).toEqual(before);
    // A snapshot that stays here (a local ref) keeps everything.
    const kept = await snapshot(repo, "refs/caveman/kept/s1");
    expect(git(repo, "show", `${kept.commit}:.env`)).toBe("SECRET=never-leaves-untracked\n");
    expect(kept.left).toEqual([]);
  });

  test("a Cloud computer's snapshot carries its edits to secret-shaped files HEAD tracks, deletions too, and leaves only new ones there, naming them (A-5)", async () => {
    const repo = makeRepo(tempRoot("sp-wip-cloud-secrets-"), { "README.md": "hello\n", ".env.example": "TOKEN=head\n", "certs/dev.pem": "head cert\n", "old.key": "head key\n" });
    fs.writeFileSync(path.join(repo, ".env.example"), "TOKEN=edited-on-cloud\nNEW=1\n");
    fs.writeFileSync(path.join(repo, "certs", "dev.pem"), "edited cert\n");
    git(repo, "add", "certs/dev.pem");
    fs.rmSync(path.join(repo, "old.key"));
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=written-on-cloud\n", { mode: 0o600 });
    fs.writeFileSync(path.join(repo, "staged.pem"), "new and staged\n");
    git(repo, "add", "staged.pem");
    fs.mkdirSync(path.join(repo, "keys"));
    fs.writeFileSync(path.join(repo, "keys", "id_ed25519"), "new key\n", { mode: 0o600 });
    fs.writeFileSync(path.join(repo, "work.txt"), "work\n");
    const before = { files: files(repo), cached: git(repo, "diff", "--cached", "--name-only"), status: git(repo, "status", "--porcelain") };
    const out = await snapshot(repo, "refs/caveman/sessions/s1", { leave: "untracked" });
    const tree = git(repo, "ls-tree", "-r", "--name-only", out.commit).trim().split("\n");
    expect(git(repo, "show", `${out.commit}:.env.example`)).toBe("TOKEN=edited-on-cloud\nNEW=1\n");
    expect(git(repo, "show", `${out.commit}:certs/dev.pem`)).toBe("edited cert\n");
    expect(git(repo, "show", `${out.commit}:work.txt`)).toBe("work\n");
    expect(tree).not.toContain("old.key");
    for (const gone of [".env", "staged.pem", "keys/id_ed25519"]) expect(tree).not.toContain(gone);
    expect(out.left).toEqual([".env", "keys/id_ed25519", "staged.pem"]);
    expect({ files: files(repo), cached: git(repo, "diff", "--cached", "--name-only"), status: git(repo, "status", "--porcelain") }).toEqual(before);
    // This Mac's (leave: true) keeps HEAD's version of every one, as before.
    const mac = await snapshot(repo, "refs/caveman/sessions/s2", { leave: true });
    expect(git(repo, "show", `${mac.commit}:.env.example`)).toBe("TOKEN=head\n");
    expect(git(repo, "show", `${mac.commit}:old.key`)).toBe("head key\n");
    expect(mac.left).toEqual([".env", ".env.example", "certs/dev.pem", "keys/id_ed25519", "old.key", "staged.pem"]);
  });

  test("a return reads only the secret-shaped files its checkout overwrites, puts back only those it changed, and fails on one it cannot read rather than take it for gone (decision 24)", async () => {
    const run = <A>(make: (driver: GitVcsDriver.GitVcsDriver["Service"]) => Effect.Effect<A, unknown>) => Effect.runPromise(Effect.flatMap(GitVcsDriver.GitVcsDriver, make).pipe(Effect.provide(layer)));
    const repo = makeRepo(tempRoot("sp-wip-return-"), { "README.md": "hello\n", ".env.local": "TOKEN=head\n" });
    // What comes back: Cloud's work on top of this branch's commit.
    const head = git(repo, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repo, "README.md"), "from Cloud\n");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "Cloud's work");
    const at = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "reset", "-q", "--hard", head);
    // The Mac's own: an untracked key nobody may read, a virtualenv git does not ignore, a tracked one edited here.
    fs.writeFileSync(path.join(repo, ".env.prod"), "SECRET=nobody-reads-this\n", { mode: 0o600 });
    fs.chmodSync(path.join(repo, ".env.prod"), 0o000);
    const venv = Array.from({ length: 40 }, (_, i) => path.join(".envs", "lib", `m${i}.py`));
    fs.mkdirSync(path.join(repo, ".envs", "lib"), { recursive: true });
    for (const file of venv) fs.writeFileSync(path.join(repo, file), `${file}\n`);
    fs.writeFileSync(path.join(repo, ".env.local"), "TOKEN=mac\n", { mode: 0o640 });
    fs.chmodSync(path.join(repo, ".env.local"), 0o640);
    const stamps = () => [".env.prod", ...venv].map((file) => fs.statSync(path.join(repo, file))).map((st) => `${st.ino}:${st.mtimeMs}:${st.mode}`);
    const before = stamps();
    const mine = await run((driver) => secretsAsTheyAre(driver, repo));
    // Read: the tracked one only. The rest are stamped, never read.
    expect(mine.filter((f) => f.bytes !== undefined).map((f) => f.rel)).toEqual([".env.local"]);
    expect(mine.filter((f) => f.unread).length).toBe(1 + venv.length);
    // The return's checkout, as adoptCheckout's place runs it.
    git(repo, "checkout", "-q", "-f", "-B", "main", `${at}^`, "--");
    git(repo, "clean", "-fdq", ...SECRET_CLEAN_EXCLUDES);
    git(repo, "restore", `--source=${at}`, "--worktree", "--", ".");
    expect(fs.readFileSync(path.join(repo, ".env.local"), "utf8")).toBe("TOKEN=head\n");
    expect(putSecretsBack(repo, mine)).toEqual([]);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("from Cloud\n");
    expect(fs.readFileSync(path.join(repo, ".env.local"), "utf8")).toBe("TOKEN=mac\n");
    expect(fs.statSync(path.join(repo, ".env.local")).mode & 0o777).toBe(0o640);
    // Nothing else unlinked and made again; the unreadable one as it was.
    expect(stamps()).toEqual(before);
    fs.chmodSync(path.join(repo, ".env.prod"), 0o600);
    expect(fs.readFileSync(path.join(repo, ".env.prod"), "utf8")).toBe("SECRET=nobody-reads-this\n");
    // A tracked one this computer cannot read: the return fails before it writes anything, never taking it for gone.
    fs.writeFileSync(path.join(repo, ".env.local"), "TOKEN=mac-again\n");
    fs.chmodSync(path.join(repo, ".env.local"), 0o000);
    try {
      await expect(run((driver) => secretsAsTheyAre(driver, repo))).rejects.toThrow(/could not be read/);
    } finally {
      fs.chmodSync(path.join(repo, ".env.local"), 0o640);
    }
    // Past the bytes a return holds: stamped only; one the checkout then overwrites is answered, not put back.
    const capped = await run((driver) => secretsAsTheyAre(driver, repo, 4));
    expect(capped.find((f) => f.rel === ".env.local")).toMatchObject({ unread: true });
    git(repo, "checkout", "-q", "-f", "-B", "main", `${at}^`, "--");
    expect(putSecretsBack(repo, capped).map((r) => r.rel)).toEqual([".env.local"]);
  });

  test("a snapshot that fails leaves no temporary index behind", async () => {
    const repo = makeRepo(tempRoot("sp-wip-fail-"), { "README.md": "hello\n" });
    fs.writeFileSync(path.join(repo, "work.txt"), "work\n");
    // A stale lock on the ref (a git that died holding it): update-ref fails after the index was made.
    fs.mkdirSync(path.join(repo, ".git/refs/caveman/sessions"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git/refs/caveman/sessions/s1.lock"), "");
    // And one that fails with the index still in use: no commit yet, so read-tree HEAD has nothing to read.
    const unborn = tempRoot("sp-wip-unborn-");
    execFileSync("git", ["init", "-q", unborn]);
    fs.writeFileSync(path.join(unborn, "work.txt"), "work\n");
    const tmp = tempRoot("sp-wip-tmp-");
    const was = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      await expect(snapshot(repo)).rejects.toThrow();
      await expect(snapshot(unborn)).rejects.toThrow();
    } finally {
      process.env.TMPDIR = was;
    }
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith("caveman-wip-"))).toEqual([]);
  });

  /** The two ways to the same tree: a temporary index copied from the worktree's own, and read-tree HEAD. */
  const both = async (repo: string, leave = false) => {
    const tree = (seed: string | undefined) => Effect.runPromise(Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) => wipTree(driver, repo, { leave, seed })).pipe(Effect.provide(layer)));
    const seed = await seedOf(repo);
    return { seeded: seed === undefined ? undefined : (await tree(seed)).tree, read: (await tree(undefined)).tree };
  };

  test("a temporary index copied from the worktree's own makes the same tree as read-tree HEAD: clean, modified, staged, deleted, untracked, renamed and intent-to-add (decision 25)", async () => {
    const repo = makeRepo(tempRoot("sp-wip-parity-"), { "README.md": "hello\n", "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "old.txt": "old\n", ".env.local": "TOKEN=head\n" });
    const before = files(repo);
    // Clean: the same.
    expect((await both(repo)).seeded).toBe((await both(repo)).read);
    fs.writeFileSync(path.join(repo, "a.txt"), "a, modified\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "b, staged\n");
    git(repo, "add", "b.txt");
    fs.writeFileSync(path.join(repo, "b.txt"), "b, staged then changed again\n");
    fs.rmSync(path.join(repo, "c.txt"));
    git(repo, "mv", "old.txt", "new.txt");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");
    fs.writeFileSync(path.join(repo, "intent.txt"), "intent to add\n");
    git(repo, "add", "-N", "intent.txt");
    fs.writeFileSync(path.join(repo, ".env.local"), "TOKEN=edited\n");
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=x\n");
    const index = { cached: git(repo, "diff", "--cached", "--name-only"), status: git(repo, "status", "--porcelain") };
    // Seeded indeed: nothing here that git would trust without looking.
    expect(await seedOf(repo)).toBe(path.join(fs.realpathSync(repo), ".git", "index"));
    const out = await both(repo);
    expect(out.seeded).toBe(out.read);
    const left = await both(repo, true);
    expect(left.seeded).toBe(left.read);
    expect(git(repo, "show", `${(await snapshot(repo, "refs/caveman/sessions/x", { leave: true })).commit}:.env.local`)).toBe("TOKEN=head\n");
    // Neither touched the worktree's own index.
    expect({ cached: git(repo, "diff", "--cached", "--name-only"), status: git(repo, "status", "--porcelain") }).toEqual(index);
    expect(files(repo)).not.toEqual(before);
  });

  test("entries git trusts without looking (assume-unchanged, skip-worktree) fall back to read-tree HEAD, so their changes still go (decision 25)", async () => {
    const repo = makeRepo(tempRoot("sp-wip-trusted-"), { "README.md": "hello\n", "trusted.txt": "head\n", "skipped.txt": "head\n" });
    git(repo, "update-index", "--assume-unchanged", "trusted.txt");
    fs.writeFileSync(path.join(repo, "trusted.txt"), "changed under assume-unchanged\n");
    const assumed = await snapshot(repo);
    expect(git(repo, "show", `${assumed.commit}:trusted.txt`)).toBe("changed under assume-unchanged\n");
    git(repo, "update-index", "--no-assume-unchanged", "trusted.txt");
    git(repo, "checkout", "--", "trusted.txt");
    git(repo, "update-index", "--skip-worktree", "skipped.txt");
    fs.writeFileSync(path.join(repo, "skipped.txt"), "changed under skip-worktree\n");
    const skipped = await snapshot(repo);
    expect(git(repo, "show", `${skipped.commit}:skipped.txt`)).toBe("changed under skip-worktree\n");
    expect(await seedOf(repo)).toBeUndefined();
    // The flag gone again: the index changed, so the answer is asked again, not remembered.
    git(repo, "update-index", "--no-skip-worktree", "skipped.txt");
    expect(await seedOf(repo)).toBeDefined();
  });

  test("a file that stayed here goes back only inside the worktree: never through a folder the checkout made a link, nor over a folder (decision 24)", () => {
    const root = tempRoot("sp-putback-");
    const worktree = path.join(root, "w");
    const outside = path.join(root, "outside");
    fs.mkdirSync(worktree);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, ".env"), "the person's own, elsewhere\n", { mode: 0o600 });
    fs.writeFileSync(path.join(outside, "gone.key"), "elsewhere too\n");
    const was = { env: fs.readFileSync(path.join(outside, ".env"), "utf8"), key: fs.readFileSync(path.join(outside, "gone.key"), "utf8") };
    // The checkout that came back made `sub` a link out of the worktree, and `dir.pem` a folder.
    fs.symlinkSync(outside, path.join(worktree, "sub"));
    fs.mkdirSync(path.join(worktree, "dir.pem"));
    expect(() => putBackInside(worktree, { rel: "sub/.env", bytes: Buffer.from("SECRET=mac\n"), mode: 0o600 })).toThrow(/sub is a link now/);
    // One that was gone here is not removed through it either.
    expect(() => putBackInside(worktree, { rel: "sub/gone.key" })).toThrow(/sub is a link now/);
    expect(() => putBackInside(worktree, { rel: "dir.pem", bytes: Buffer.from("pem\n"), mode: 0o600 })).toThrow(/is a folder now/);
    expect(() => putBackInside(worktree, { rel: "../outside/.env", bytes: Buffer.from("x\n"), mode: 0o600 })).toThrow(/not a path inside/);
    expect({ env: fs.readFileSync(path.join(outside, ".env"), "utf8"), key: fs.readFileSync(path.join(outside, "gone.key"), "utf8") }).toEqual(was);
    expect(fs.readdirSync(outside).sort()).toEqual([".env", "gone.key"]);
    // Inside: written with its mode in a folder made for it, a link made again, a link in its place replaced, not followed.
    putBackInside(worktree, { rel: "keys/id_ed25519", bytes: Buffer.from("ssh\n"), mode: 0o600 });
    expect(fs.statSync(path.join(worktree, "keys", "id_ed25519")).mode & 0o777).toBe(0o600);
    fs.symlinkSync(path.join(outside, ".env"), path.join(worktree, ".env"));
    putBackInside(worktree, { rel: ".env", bytes: Buffer.from("SECRET=mac\n"), mode: 0o640 });
    expect(fs.lstatSync(path.join(worktree, ".env")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(worktree, ".env"), "utf8")).toBe("SECRET=mac\n");
    expect(fs.statSync(path.join(worktree, ".env")).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(path.join(outside, ".env"), "utf8")).toBe(was.env);
    putBackInside(worktree, { rel: "link.key", link: "keys/id_ed25519" });
    expect(fs.readlinkSync(path.join(worktree, "link.key"))).toBe("keys/id_ed25519");
    putBackInside(worktree, { rel: "keys/id_ed25519" });
    expect(fs.existsSync(path.join(worktree, "keys", "id_ed25519"))).toBe(false);
  });
});

// Skipped on Windows: a Cloud computer is Linux, and its tools channel is a Unix socket.
test.skipIf(process.platform === "win32")("on a Cloud computer a chat beside the first, and one moved there, start from the first checkout's caches; the first chat brings nothing", async () => {
  const cleanups: Array<() => unknown> = [];
  try {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    const socket = path.join(tempRoot("caches-cloud-sock-"), "tools.sock");
    const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { stdio: "ignore" });
    cleanups.push(() => tools.kill());
    await until(() => fs.existsSync(socket));
    Object.assign(process.env, { CAVEMAN_RUNTIME_TOOLS_ADDRESS: socket, CAVEMAN_COMPUTER_CPUS: "4", CAVEMAN_COMPUTER_MEMORY_GIB: "8" });
    cleanups.push(() => (delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS, delete process.env.CAVEMAN_COMPUTER_CPUS, delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB));
    // Setup passes only on installed dependencies: a worktree that got none would fail it.
    const source = makeRepo(tempRoot("caches-cloud-source-"), {
      ".caveman/computer.toml": `[setup]\nrun = ["test -f node_modules/dep/index.js && echo ran >> setup-count.log"]\ncache = ["node_modules"]\n`,
      ".gitignore": "node_modules\nsetup-count.log\n",
    });
    // GitHub as the git proxy serves it, and each computer's snapshot checkout with its dependencies installed.
    const backend = tempRoot("caches-cloud-github-");
    fs.mkdirSync(path.join(backend, "acme"), { recursive: true });
    execFileSync("git", ["clone", "--bare", "--quiet", source, path.join(backend, "acme", "widgets.git")]);
    cloud.state.gitBackend = backend;
    cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
    const computer = async (name: string) => {
      const checkout = path.join(tempRoot(`caches-cloud-${name}-`), "workspace");
      execFileSync("git", ["clone", "--quiet", path.join(backend, "acme", "widgets.git"), checkout]);
      git(checkout, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
      git(checkout, "config", "user.email", "t@t");
      git(checkout, "config", "user.name", "t");
      fs.mkdirSync(path.join(checkout, "node_modules/dep"), { recursive: true });
      fs.writeFileSync(path.join(checkout, "node_modules/dep/index.js"), "module.exports = 1;\n");
      const linkDir = path.join(tempRoot(`caches-cloud-${name}-link-`), "link");
      const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name });
      const provide = Layer.mergeAll(Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }), Layer.succeed(CloudLinkState, {})) as unknown as Layer.Layer<any>;
      const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide });
      cleanups.push(runtime.close);
      const client = connect(runtime.url, runtime.token);
      cleanups.push(() => client.close());
      await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);
      return { checkout, identity, client };
    };
    const create = (on: { client: ReturnType<typeof connect> }, id: string, title: string) =>
      createReady(on.client, { request_id: id, repo: { url: "https://github.com/acme/widgets" }, title, engine: "claude-agent", options: { model: MODEL } });
    /** The chat's note after setup, read on `on`: its title and what it says of the caches. */
    const setupNote = async (on: { client: ReturnType<typeof connect> }, sessionId: string) => {
      const events: Array<SessionEvent> = [];
      await on.client.attach(sessionId, 0, (event) => events.push(event));
      const said = () => events.flatMap((e) => (e.type === "notification" && e.payload.title.startsWith("Setup ") ? [e.payload] : []))[0];
      await until(() => said() !== undefined, 30_000);
      return { title: said()!.title.replace(/ in [\d.]+ s$/, ""), body: said()!.body };
    };
    const worktreeOf = (checkout: string, branch: string) => {
      const lines = git(checkout, "worktree", "list", "--porcelain").split("\n");
      return lines[lines.indexOf(`branch refs/heads/${branch}`) - 2]!.slice("worktree ".length);
    };
    const arrived = `${tempDirClones ? "Cloned" : "Hard-linked"} from the first checkout: node_modules`;
    const itsOwn = (tree: string, checkout: string) => {
      expect(fs.realpathSync(tree)).not.toBe(fs.realpathSync(checkout));
      expect(fs.lstatSync(path.join(tree, "node_modules")).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(tree, "node_modules/dep")).ino).not.toBe(fs.statSync(path.join(checkout, "node_modules/dep")).ino);
      expect(fs.readFileSync(path.join(tree, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1;\n");
      expect(fs.readFileSync(path.join(tree, "setup-count.log"), "utf8")).toBe("ran\n");
    };

    // The computer's first chat runs in the checkout itself: setup runs on what is there, and nothing is brought.
    const home = await computer("home");
    const first = await create(home, "first", "First");
    expect(git(home.checkout, "symbolic-ref", "--short", "HEAD").trim()).toBe(first.branch);
    expect(await setupNote(home, first.session_id)).toEqual({ title: "Setup finished", body: undefined });

    // A chat beside it (workspace.create, as a builder's is) is a worktree, set up on the first checkout's caches.
    const beside = await create(home, "beside", "Beside");
    expect(await setupNote(home, beside.session_id)).toEqual({ title: "Setup finished", body: arrived });
    itsOwn(worktreeOf(home.checkout, beside.branch), home.checkout);

    // A chat moved here from another computer lands in a worktree beside them, and starts the same way.
    const away = await computer("away");
    const mover = await create(away, "mover", "Moves over");
    const turns: Array<SessionEvent> = [];
    await away.client.attach(mover.session_id, 0, (event) => turns.push(event));
    await away.client.call("turn.submit", { request_id: "m1", session_id: mover.session_id, kind: "followup", input: { text: "slow 0: first part" } });
    await until(() => turns.some((e) => e.type === "turn.done"), 30_000);
    await until(() => cloud.state.chats.sessions.has(mover.session_id), 15_000);
    expect(await away.client.call("session.move", { request_id: "move-1", session_id: mover.session_id, to: { computer_id: home.identity.computerId } })).toMatchObject({ pending: false });
    await until(async () => (await home.client.call("workspace.list", {})).workspaces.some((w) => w.session_id === mover.session_id && w.status !== "starting"), 30_000);
    // Its notes from the computer it left came along: the one written here is the last.
    const moved: Array<SessionEvent> = [];
    await home.client.attach(mover.session_id, 0, (event) => moved.push(event));
    const setups = () => moved.flatMap((e) => (e.type === "notification" && e.payload.title.startsWith("Setup ") ? [e.payload] : []));
    await until(() => setups().length === 2, 30_000);
    expect(setups().map((n) => [n.title.replace(/ in [\d.]+ s$/, ""), n.body])).toEqual([["Setup finished", undefined], ["Setup finished", arrived]]);
    itsOwn(worktreeOf(home.checkout, mover.branch), home.checkout);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}, 180_000);
