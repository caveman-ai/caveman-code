// `pnpm --filter @caveman-app/runtime pack:computer [out.tgz] [--arch arm64|amd64|x64] [--name <container>]` writes
// caveman-runtime.tgz, the runtime the Caveman Cloud computer image carries (Caveman Cloud
// cloud/runner/code/Dockerfile, build context "runtime"):
//   bin/caveman-runtime   starts lib/bin.mjs on the image's node 24 with --disable-sigusr1
//   lib/                  the bundle step's dist (scripts/bundle.ts), toolsExec.mjs included
//   lib/bin/              the app's pinned caveman-proxy, caveman-mcp and caveman-engine for this arch
//                         (cavemanBinaries.ts): Claude Agent and Codex chats there run through the proxies,
//                         the Caveman engine's levers on caveman-engine; and their licenses
//
// The launcher says the runtime's version (CAVEMAN_APP_VERSION, unless the image set one): what the runtime's
// heartbeat tells Cloud, which holds it against its minimum (cloudLink/index.ts runtimeVersion). It is the release's
// (CAVEMAN_APP_VERSION, as the desktop and npm packs take it), else the newest release in releases/ whose notes are
// finished, else the package's own.
//
// The bundle's native packages (node-pty, fff, ffi-rs) are the build host's, so the tgz is built
// on Linux: from `git archive HEAD` in node:24-bookworm-slim for the target arch. The computer image
// is Wolfi with node 24: same ABI, a newer glibc than bookworm's, so these natives load there. Reproducible: committed files only, a frozen install, entries
// sorted, owner 0, every mtime the commit's time, gzip without a name or time.
// `--here` packs on this machine instead (the test, or a Linux CI host already in the image).
// `--name` names the Docker container (default caveman-runtime-pack-<pid>), so a lab finds and removes only its own.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { bundleRuntime, bundleVersion, type RuntimeManifest } from "./bundle.ts";
import { installCavemanBinaries } from "./cavemanBinaries.ts";

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(runtimeDir, "../..");
/** Node 24 (the image's ABI; memory_sql needs 24.15) on a glibc no newer than Caveman Cloud cloud/runner/code/Dockerfile's. */
export const BUILD_IMAGE = "node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";

/** A version as a release names one (apps/desktop/scripts/package.mjs): 1.4.2, 0.2.0-beta.1. */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The launcher, naming `version` as the runtime's own unless what starts it (the image) names one. */
export const launcher = (version: string) => `#!/bin/sh
# Caveman Code runtime (caveman-runtime.tgz). --disable-sigusr1: no inspector on a signal.
here=$(cd "$(dirname "$0")/.." && pwd)
# This runtime's version, which its heartbeat tells Caveman Cloud.
CAVEMAN_APP_VERSION="\${CAVEMAN_APP_VERSION:-${version}}"
export CAVEMAN_APP_VERSION
exec node --disable-sigusr1 "$here/lib/bin.mjs" "$@"
`;

/** A release as its notes name it (releases/<version>.md): its version, and whether the notes are still a draft. */
export interface ReleaseNotes {
  readonly version: string;
  readonly draft: boolean;
}

/** The releases a checkout holds notes for; a file that names no version (README.md) is none. */
export function releasesIn(dir: string): ReadonlyArray<ReleaseNotes> {
  let names: ReadonlyArray<string>;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (!name.endsWith(".md")) return [];
    const front = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(dir, name), "utf8"))?.[1];
    const version = front === undefined ? undefined : /^version:\s*(\S+)\s*$/m.exec(front)?.[1];
    if (version === undefined || !VERSION.test(version) || `${version}.md` !== name) return [];
    return [{ version, draft: /^draft:\s*true\s*$/m.test(front!) }];
  });
}

/** Orders two versions as semver does: by their numbers, then a release above its own pre-releases. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [numbers = "", ...rest] = v.split("-");
    return { numbers: numbers.split(".").map(Number), pre: rest.join("-") };
  };
  const [x, y] = [split(a), split(b)];
  for (let i = 0; i < 3; i++) if ((x.numbers[i] ?? 0) !== (y.numbers[i] ?? 0)) return (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === "" || y.pre === "") return x.pre === "" ? 1 : -1;
  const [p, q] = [x.pre.split("."), y.pre.split(".")];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    const [l, r] = [p[i], q[i]];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    if (l === r) continue;
    const [ln, rn] = [/^\d+$/.test(l), /^\d+$/.test(r)];
    if (ln && rn) return Number(l) - Number(r);
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * The version a pack carries. `named` is the release's own word (CAVEMAN_APP_VERSION, a leading v dropped), refused
 * when it is no version, as the desktop pack refuses it. Without one: the newest release whose notes are finished
 * (a draft has not shipped), else the package's own version.
 */
export function packVersion(input: { readonly named?: string | undefined; readonly releases: ReadonlyArray<ReleaseNotes>; readonly packageVersion: string }): string {
  const named = input.named?.trim().replace(/^v/, "");
  if (named !== undefined && named !== "") {
    if (!VERSION.test(named)) throw new Error(`pack:computer: CAVEMAN_APP_VERSION ${input.named} is not a version (1.4.2, 0.2.0-beta.1)`);
    return named;
  }
  const shipped = input.releases.filter((release) => !release.draft).map((release) => release.version).sort(compareVersions);
  return shipped.at(-1) ?? input.packageVersion;
}

/** The version of a pack made from this checkout (packVersion, from the environment, releases/ and package.json). */
export const versionHere = (env: NodeJS.ProcessEnv = process.env) =>
  packVersion({
    named: env.CAVEMAN_APP_VERSION,
    releases: releasesIn(path.join(repoDir, "releases")),
    packageVersion: (JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8")) as { version: string }).version,
  });

/**
 * Bundles the runtime on this machine and packs it as `outFile`, with this machine's caveman binaries unless
 * `binaries` is false (a test that never runs a chat). `epoch` is every entry's mtime; `version` is what its
 * launcher names as the runtime's (default: this checkout's, versionHere).
 */
export async function packComputer(outFile: string, options: { clientDir?: string; epoch?: number; binaries?: boolean; version?: string } = {}): Promise<RuntimeManifest> {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-runtime-pack-"));
  try {
    const manifest = await bundleRuntime(path.join(stage, "lib"), options.clientDir);
    if (options.binaries !== false) {
      if (process.platform !== "linux" && process.platform !== "darwin") throw new Error(`no caveman binaries for ${process.platform}`);
      await installCavemanBinaries({
        platform: process.platform,
        arch: process.arch === "x64" ? "x64" : "arm64",
        dest: path.join(stage, "lib"),
        cacheDir: path.join(runtimeDir, ".cache/caveman-binaries"),
      });
    }
    // Source maps name build paths; the image never needs them.
    for (const entry of fs.readdirSync(path.join(stage, "lib"))) if (entry.endsWith(".map")) fs.rmSync(path.join(stage, "lib", entry));
    fs.mkdirSync(path.join(stage, "bin"));
    fs.writeFileSync(path.join(stage, "bin/caveman-runtime"), launcher(options.version ?? versionHere()), { mode: 0o755 });
    const epoch = options.epoch ?? 0;
    const gnu = execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("GNU tar");
    // ponytail: bsdtar (macOS) has no --sort, so only a GNU tar pack is byte-for-byte reproducible.
    const flags = gnu
      ? ["--sort=name", `--mtime=@${epoch}`, "--owner=0", "--group=0", "--numeric-owner", "--format=gnu"]
      : ["--uid", "0", "--gid", "0", "--numeric-owner"];
    const tar = execFileSync("tar", [...flags, "-C", stage, "-cf", "-", "bin", "lib"], { maxBuffer: 2 ** 31 - 1 });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, execFileSync("gzip", ["-n", "-9"], { input: tar, maxBuffer: 2 ** 31 - 1 }));
    return manifest;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** What `pack:computer` was asked for. */
export type PackArgs = { outFile: string; here: boolean; epoch?: number; arch: "arm64" | "amd64"; name: string };

/** The image's architectures by Docker's names, and Node's x64 for amd64. */
const ARCHES: Record<string, PackArgs["arch"]> = { arm64: "arm64", amd64: "amd64", x64: "amd64" };
/** A name `docker run --name` takes. */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Parses `[out.tgz] [--arch arm64|amd64|x64] [--name <container>] [--here] [--epoch <s>]`. Without --arch, the
 * host's architecture; one the image is not built for is refused with the fix, before Docker gets an invalid
 * platform.
 */
export function parsePackArgs(argv: ReadonlyArray<string>, defaults: { hostArch: string; pid: number; outFile: string }): PackArgs {
  const args = [...argv];
  const flag = (name: string) => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const value = args[at + 1];
    if (value === undefined) throw new Error(`pack:computer: ${name} needs a value`);
    args.splice(at, 2);
    return value;
  };
  const here = args.includes("--here") ? (args.splice(args.indexOf("--here"), 1), true) : false;
  const epoch = flag("--epoch");
  const wanted = flag("--arch") ?? defaults.hostArch;
  const arch = Object.hasOwn(ARCHES, wanted) ? ARCHES[wanted] : undefined;
  if (arch === undefined) throw new Error(`pack:computer: no computer image for "${wanted}"; pass --arch arm64, amd64 or x64`);
  const name = flag("--name") ?? `caveman-runtime-pack-${defaults.pid}`;
  if (!CONTAINER_NAME.test(name)) throw new Error(`pack:computer: --name "${name}" is not a Docker container name ([a-zA-Z0-9][a-zA-Z0-9_.-]*)`);
  return { outFile: args[0] ?? defaults.outFile, here, ...(epoch === undefined ? {} : { epoch: Number(epoch) }), arch, name };
}

/** Builds and packs inside node:24-bookworm-slim from `git archive HEAD`, in container `name`. */
function packInDocker(outFile: string, arch: string, name: string) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  // The image's runtime reports the release's version (CAVEMAN_APP_VERSION, checked here before the build starts).
  const version = bundleVersion();
  const epoch = execFileSync("git", ["log", "-1", "--format=%ct", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" }).trim() !== "")
    console.error(`pack:computer: the worktree has uncommitted changes; packing HEAD ${head.slice(0, 12)} only`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-runtime-src-"));
  try {
    fs.mkdirSync(path.join(work, "src"));
    fs.mkdirSync(path.join(work, "out"));
    execFileSync("sh", ["-c", `git archive --format=tar HEAD | tar -x -C "${path.join(work, "src")}"`], { cwd: repoDir, stdio: "inherit" });
    const script = [
      "set -eu",
      "cp -a /src /build && cd /build",
      "corepack enable >/dev/null",
      "pnpm install --frozen-lockfile --reporter=silent",
      "pnpm --filter @caveman-app/web build >/dev/null",
      `node packages/runtime/scripts/pack-computer.ts /out/caveman-runtime.tgz --here --epoch ${epoch}`,
    ].join("\n");
    execFileSync(
      "docker",
      ["run", "--rm", "--name", name, "--platform", `linux/${arch}`,
        "-e", "COREPACK_ENABLE_DOWNLOAD_PROMPT=0", "-e", "CI=1", "-e", `CAVEMAN_APP_VERSION=${version}`,
        "-v", `${path.join(work, "src")}:/src:ro`, "-v", `${path.join(work, "out")}:/out`, BUILD_IMAGE, "sh", "-c", script],
      { stdio: "inherit" },
    );
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.copyFileSync(path.join(work, "out/caveman-runtime.tgz"), outFile);
    return head;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { outFile: out, here, epoch, arch, name } = parsePackArgs(process.argv.slice(2), {
    hostArch: process.arch,
    pid: process.pid,
    outFile: path.join(runtimeDir, "dist-computer/caveman-runtime.tgz"),
  });
  const outFile = path.resolve(out);
  const started = Date.now();
  if (here) {
    const version = versionHere();
    const manifest = await packComputer(outFile, { version, ...(epoch === undefined ? {} : { epoch }) });
    console.log(`packed ${outFile} (version ${version}, ${manifest.platform}, node ${process.versions.node}) in ${Date.now() - started} ms`);
  } else {
    const head = packInDocker(outFile, arch, name);
    const sha = createHash("sha256").update(fs.readFileSync(outFile)).digest("hex");
    console.log(`packed ${outFile} for linux/${arch} from ${head.slice(0, 12)} in ${Date.now() - started} ms; sha256 ${sha}`);
  }
}
