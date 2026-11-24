// `caveman-runtime self-check`: this build of the runtime loads where it is, before anything depends on it. Caveman Cloud's
// computer image runs it in its release start check (cloud/runner/code/caveman-computer check, when manifest.json names
// "self-check"), on the image's node and libc: a native addon, glibc or libstdc++ that fails there would otherwise pass
// the release and fail every computer that wakes. It loads the server's module graph without running it, then every
// native package through the entry the runtime loads it with, and confirms from the process report that each native
// library the bundle staged for this platform (manifest.json externals) is mapped: one that nothing loads, or that
// loaded from somewhere else, fails. One line on stdout when it passes; `self-check failed: <what>: <why>` and exit 1.
// The loading happens in a child process, which names each package on stderr before it loads it: an addon that crashes
// the process as it loads (glibc's dynamic loader SIGBUSes on a truncated library, a foreign one can SIGILL) kills only
// that child, and this process reports it like any other failure, by the last package named, with exit 1.
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** What this reads of the bundle's manifest.json (scripts/bundle.ts RuntimeManifest). */
interface Manifest {
  readonly platform: string;
  readonly externals: ReadonlyArray<{ readonly name: string; readonly path: string; readonly native: ReadonlyArray<string> }>;
}

const requireNative = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;

/**
 * Each native package, loaded as the runtime loads it: NodePtyAdapter.ts, WorkspaceSearchIndex.ts (fff-node loads
 * ffi-rs's addon, then its own library through ffi-rs on first use), CursorKeychain.ts, search/embedderModel.ts,
 * cloudLink/direct.ts, and native SDK, which loads its vendored tree-sitter from its platform package when this
 * platform has one (it answers false when not). The staged list below holds the check to what shipped.
 */
const LOADERS: ReadonlyArray<readonly [string, () => unknown]> = [
  ["node-pty", () => requireNative("node-pty")],
  ["@ff-labs/fff-node", () => (requireNative("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node")).FileFinder.ensureLoaded()],
  ["@napi-rs/keyring", () => requireNative("@napi-rs/keyring")],
  ["onnxruntime-node", () => requireNative("onnxruntime-node")],
  ["node-datachannel", () => import("node-datachannel")],
  [
    `@cursor/sdk-${platform}`,
    () => {
      const vendor = `@cursor/sdk-${platform}/vendor`;
      try {
        requireNative.resolve(`${vendor}/tree-sitter/index.js`);
      } catch {
        return false;
      }
      for (const vendored of ["tree-sitter", "tree-sitter-bash"]) requireNative(`${vendor}/${vendored}/index.js`);
    },
  ],
];

/** What dlopen maps on this platform: Node addons and the shared libraries they bring. Executables are not loaded. */
const LIBRARY = process.platform === "darwin" ? /\.(node|dylib)$/ : process.platform === "win32" ? /\.(node|dll)$/ : /\.(node|so(\.\d+)*)$/;
/** A file under another platform's directory (node-pty's prebuilds/<os>-<arch>/, ONNX Runtime's <os>/<arch>/). */
const PLATFORM_DIR = /(?:^|\/)(darwin|linux|win32)[-/](x64|arm64|ia32|arm)(?=\/)/;

const real = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

/** The line the check's process writes on stderr before it loads a package: the last one names a load that crashed it. */
const LOADING = "caveman-runtime: self-check: loading ";

class SelfCheckFailure extends Error {}
const failure = (what: string, cause: unknown) =>
  new SelfCheckFailure(`${what}: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`);

const check = async (): Promise<string> => {
  const started = performance.now();
  // Beside the chunk in a bundle (lib/manifest.json); run from source there is none.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestFile = path.join(here, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? (JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest) : undefined;
  if (manifest !== undefined && manifest.platform !== platform) throw failure("manifest.json", `built for ${manifest.platform}, running on ${platform}`);
  try {
    await import("./binCli.ts");
  } catch (error) {
    throw failure("the server's modules", error);
  }
  const loaded: Array<string> = [];
  for (const [name, load] of LOADERS) {
    fs.writeSync(2, `${LOADING}${name}\n`);
    try {
      if ((await load()) !== false) loaded.push(name);
    } catch (error) {
      throw failure(name, error);
    }
  }
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string }; sharedObjects: ReadonlyArray<string> };
  const mapped = new Set(report.sharedObjects.map(real));
  // On Linux the pack stages both libcs' builds of a package with per-platform builds (...-gnu beside ...-musl): the
  // other libc's is never loaded here.
  const otherLibc = process.platform !== "linux" ? undefined : report.header.glibcVersionRuntime ? /-musl$/ : /-gnu$/;
  let libraries = 0;
  for (const pkg of manifest?.externals ?? []) {
    if (otherLibc?.test(pkg.name)) continue;
    for (const file of pkg.native) {
      const dir = PLATFORM_DIR.exec(file);
      if (!LIBRARY.test(file) || (dir !== null && `${dir[1]}-${dir[2]}` !== platform)) continue;
      if (!mapped.has(real(path.join(here, pkg.path, file)))) throw failure(pkg.name, `${file} is staged for ${platform} but was not loaded`);
      libraries++;
    }
  }
  const staged = manifest === undefined ? "no manifest.json beside it, staged libraries not checked" : `${libraries} staged libraries loaded`;
  return `node ${process.version} ${platform}; natives ${loaded.join(", ")}; ${staged}; ${Math.round(performance.now() - started)} ms`;
};

/** Prints the one line and exits with `code`. A loaded addon may hold the event loop open. */
const finish = (code: number, line: string): void => {
  (code === 0 ? process.stdout : process.stderr).write(`${line}\n`, () => process.exit(code));
};

/** The argument the check's own child runs with (`self-check --child`): that process loads everything. */
const CHILD = "--child";

/**
 * Prints the one line and exits: 0 when every check passed, 1 otherwise. The check itself runs in a child of this
 * process, its stdout and stderr passed through: a native whose load kills that child by a signal is a failure here
 * like any other, named by the package the child last said it was loading.
 */
export async function runSelfCheck(): Promise<void> {
  const entry = process.argv[1];
  if (process.argv[3] === CHILD || entry === undefined) {
    try {
      finish(0, `caveman-runtime: self-check ok: ${await check()}`);
    } catch (error) {
      if (!(error instanceof SelfCheckFailure)) throw error;
      finish(1, `caveman-runtime: self-check failed: ${error.message}`);
    }
    return;
  }
  const child = spawn(process.execPath, [...process.execArgv, entry, "self-check", CHILD], { stdio: ["ignore", "inherit", "pipe"] });
  let loading: string | undefined;
  let partial = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(chunk);
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith(LOADING)) loading = line.slice(LOADING.length);
  });
  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  } catch (error) {
    finish(1, `caveman-runtime: self-check failed: its process: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // The child wrote its own line; what this passed on of its stderr goes out before the exit.
  if (signal === null) process.stderr.write("", () => process.exit(code ?? 1));
  else finish(1, `caveman-runtime: self-check failed: ${loading === undefined ? `its process: killed by ${signal}` : `${loading}: killed the process by ${signal} as it loaded`}`);
}
