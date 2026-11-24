// ), scripts/lib/server-compile-cache.ts and scripts/prepare-server-compile-cache.cjs @
// 67eebaca23 (58a407c093, with 80120b1aa3, bdf5806dfc and 9f6326812c): V8 bytecode for the runtime's start, made
// when the app is packaged, so the first start after an install or update compiles nothing it already knows.
//
// scripts/build.mjs bundles this to dist-electron/serverCompileCache.mjs; scripts/package.mjs copies it into
// <resources>/runtime and runs it there with the bundled Node and `--generate`, which imports the runtime's server
// chunk (binCli-*.mjs, which runs nothing on import) under a portable compile cache and keeps the files in
// <resources>/runtime/compile-cache with a manifest. The desktop then starts the runtime with
// `--import=<this file>` (src/runtime.ts runtimeCommand): before bin.mjs loads, it enables Node's compile cache in a
// writable directory of this user's and links each prepared file in under the key for where this install's modules
// are. Node replaces a stale entry by renaming a new file over the link, so nothing writes into the signed app. The
// runtime's own enableCompileCache (bin.ts) then finds the cache on, and its flush writes only what was missing.
//
// macOS only: Node's compile cache stays off on Windows, where its synchronous writes slowed the runtime's start by
// seconds, so Windows builds get no prepared cache and no preload.
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as NodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cachedDataVersionTag } from "node:v8";
import { isMainThread } from "node:worker_threads";
import { crc32 } from "node:zlib";

export const PREPARED_DIR = "compile-cache";
const MANIFEST = "manifest.json";

/** What compiled bytecode is only valid for: this Node, OS, processor and V8's flag-sensitive tag. */
export const runtimeIdentity = (): string =>
  [process.version, process.platform, process.arch, cachedDataVersionTag()].join("-");

/**
 * Node 24's portable cache key: CRC32 of a one-byte module type (1, ESM) followed by the module's path relative to
 * the cache directory. Generation checks it against the files Node itself wrote and fails the build if it changed.
 */
export const cacheKey = (active: string, filename: string): string =>
  crc32(relative(active, filename), crc32(Buffer.from([1])))
    .toString(16)
    .padStart(8, "0");

interface ManifestEntry {
  readonly module: string;
  readonly file: string;
}

/** Links every prepared file into `active` under its key for `runtimeDir`'s modules; false when any is unusable. */
export function seedPreparedCache(runtimeDir: string, active: string, identity: string): boolean {
  const prepared = join(runtimeDir, PREPARED_DIR);
  try {
    const manifest = JSON.parse(readFileSync(join(prepared, MANIFEST), "utf8")) as {
      format?: unknown;
      runtime?: unknown;
      entries?: unknown;
    };
    if (
      manifest.format !== 1 ||
      manifest.runtime !== identity ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length === 0
    )
      return false;
    for (const entry of manifest.entries as ReadonlyArray<Partial<ManifestEntry>>) {
      if (
        typeof entry.module !== "string" ||
        typeof entry.file !== "string" ||
        !/^[a-f0-9]{8}$/.test(entry.file) ||
        !/^[^/\\]+\.mjs$/.test(entry.module)
      )
        return false;
      const destination = join(active, cacheKey(active, join(runtimeDir, entry.module)));
      try {
        // A file link, never a directory link: Node could then write into the signed app.
        if (process.platform === "win32") linkSync(join(prepared, entry.file), destination);
        else symlinkSync(join(prepared, entry.file), destination);
      } catch {}
      if (!existsSync(destination)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Turns the compile cache on for the runtime in `runtimeDir`, seeded from its prepared files; false when it is not on. */
export function enablePreparedCache(runtimeDir: string, cacheRoot: string): boolean {
  try {
    const resources = realpathSync(runtimeDir);
    if (!existsSync(join(resources, PREPARED_DIR, MANIFEST))) return false;
    // One directory per install, so two copies of the app never share keys.
    const directory = join(cacheRoot, crc32(resources).toString(16));
    mkdirSync(directory, { recursive: true });
    const result = NodeModule.enableCompileCache({ directory, portable: true });
    const active = NodeModule.getCompileCacheDir();
    if (result.status !== NodeModule.constants.compileCacheStatus.ENABLED || !active) return false;
    return seedPreparedCache(resources, active, runtimeIdentity());
  } catch {
    return false;
  }
}

/** Compiles the runtime's start into <runtimeDir>/compile-cache; the number of modules it holds. */
export async function generatePreparedCache(runtimeDirInput: string): Promise<number> {
  const runtimeDir = realpathSync(runtimeDirInput);
  const prepared = join(runtimeDir, PREPARED_DIR);
  rmSync(prepared, { recursive: true, force: true });
  const scratch = join(tmpdir(), `caveman-compile-cache-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  try {
    const result = NodeModule.enableCompileCache({ directory: scratch, portable: true });
    if (result.status !== NodeModule.constants.compileCacheStatus.ENABLED)
      throw new Error(`cannot enable the compile cache: ${result.message ?? result.status}`);
    const server = readdirSync(runtimeDir).find((file) => /^binCli-.*\.mjs$/.test(file));
    if (!server) throw new Error(`no binCli-*.mjs in ${runtimeDir}: build the runtime first`);
    // bin.mjs runs nothing when it is not the entry; the server chunk only defines the CLI.
    await import(pathToFileURL(join(runtimeDir, "bin.mjs")).href);
    await import(pathToFileURL(join(runtimeDir, server)).href);
    NodeModule.flushCompileCache();
    const active = NodeModule.getCompileCacheDir()!;
    mkdirSync(prepared, { recursive: true });
    const entries = readdirSync(runtimeDir)
      .filter((file) => file.endsWith(".mjs"))
      .flatMap((file): ManifestEntry[] => {
        const key = cacheKey(active, join(runtimeDir, file));
        if (!existsSync(join(active, key))) return [];
        copyFileSync(join(active, key), join(prepared, key));
        return [{ module: file, file: key }];
      });
    if (!entries.some((entry) => entry.module === server))
      throw new Error("Node's compile cache keys changed: no prepared file for the server chunk");
    writeFileSync(
      join(prepared, MANIFEST),
      `${JSON.stringify({ format: 1, runtime: runtimeIdentity(), entries })}\n`,
    );
    return entries.length;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const here = dirname(fileURLToPath(import.meta.url));
if (
  process.argv[2] === "--generate" &&
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  generatePreparedCache(process.argv[3] ?? here).then(
    (count) => {
      console.log(`[compile-cache] prepared ${count} runtime modules`);
      process.exit(0);
    },
    (error: unknown) => {
      console.error(`[compile-cache] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
} else if (isMainThread && process.platform !== "win32" && isRuntimeEntry(process.argv[1])) {
  // Preloaded (--import) by the runtime's own Node for its bin.mjs: never for another script started with the same
  // flags (a fork inherits them), or for its workers.
  enablePreparedCache(here, join(tmpdir(), "caveman-code", "compile-cache", "prepared"));
}

function isRuntimeEntry(entry: string | undefined): boolean {
  try {
    return entry !== undefined && realpathSync(entry) === join(here, "bin.mjs");
  } catch {
    return false;
  }
}
