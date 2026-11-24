// ), apps/server/vite.config.ts @ ab3a3cd1.
// Its `vp pack` block, plus scripts/lib/cli-external-packages.ts (the external list and the inlined
// scan) and the runtime-external staging from scripts/build-desktop-artifact.ts.
//
// `pnpm --filter @caveman-app/runtime build` writes dist/:
//   bin.mjs (+ chunks)   the runtime, every JS dependency inlined
//   sandboxLaunch.mjs    the plugin launcher src/plugins/resolve.ts runs beside the bundle
//   toolsExec.mjs        a Cloud computer's exec channel between its runtime and tools containers
//   toolsShellEnv.sh     what Claude Agent's shell sources there before each command (the tools PATH)
//   grill-plugin/        grill mode's skill (src/grill/grill.ts)
//   automations-plugin/  the automations skill (src/automations/skill.ts)
//   catalog/             the Caveman plugin catalog, marketplace `caveman` (src/plugins/marketplaces.ts catalogDir)
//   model/               the task classifier's ask model, ask_r4 (src/askModel/model.ts)
//   node_modules/        only the packages Node must load from disk (natives and their closure)
//   manifest.json        what dist needs at run time, and the build's version, for the desktop app and the computer image
//   client/              the web client (apps/web/dist), served at / so a runtime started
//                        without the desktop (`caveman code`) can hand out a browser link
//   THIRD_PARTY_LICENSES.txt  the license of every npm package inlined into the chunks
//   THIRD_PARTY_NOTICES.md    the MIT notices of ported code (the repo root's)
// dist runs without the monorepo: copy it anywhere and run `node bin.mjs`.
//
// T3 packs with tsdown (vite-plus); this calls rolldown, the bundler under
// tsdown, with the same entries, deps split, banner and sourcemaps, then
// minifies the chunks (names kept) once its checks have read them.
// Dropped from T3: the single-executable mode and build-time defines (relay,
// Clerk, OTLP).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type OutputChunk } from "rolldown";
import { minify } from "rolldown/utils";

import { hostCommand } from "./hostCommand.ts";

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.resolve(runtimeDir, "../../apps/web/dist");

/**
 * Packages the bundle must NOT inline, matched as prefixes. Native addons, the
 * loaders that dlopen them by real path, and packages that read files beside
 * themselves; upstream reasons, per entry, are in its cli-external-packages.ts.
 */
export const RUNTIME_EXTERNAL_PREFIXES = [
 // Cursor ships computed Webpack imports and platform helper packages (provider-native sdk.ts).
  "@cursor/sdk",
  // Playwright reads package.json and browsers.json beside its runtime modules.
  "playwright-core",
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "node-gyp-build",
  "node-addon-api",
  // The OS keychain binding project secrets keep their sealing key in, and its per-platform native.
  "@napi-rs/",
  // ONNX Runtime for chat search's on-device embeddings (src/search/Embedder.ts): a native addon and its dylib.
  "onnxruntime-",
  // WebRTC for the direct path to devices (src/cloudLink/direct.ts): libdatachannel as N-API prebuilds, one optional
  // package per platform beside the loader that picks it.
  "node-datachannel",
  "@node-datachannel/",
  // ws's optional accelerators; ws falls back to JS when they are absent.
  "bufferutil",
  "utf-8-validate",
  // The Caveman engine resolves ./tool-worker.js, ./sandbox-probe-worker.js
  // and ../package.json beside its own files.
  "@caveman-ai/agent",
] as const;

export const isExternalRuntimeDependency = (id: string): boolean =>
  RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));

/**
 * Executables the runtime spawns but does not ship. The Claude Agent SDK only
 * falls back to its bundled CLI (a ~200 MB optional platform package) when no
 * `pathToClaudeCodeExecutable` is given; the runtime always passes the user's
 * own `claude` (settings `binaryPath`, default `claude` on PATH), so T3 leaves
 * that package out of its app and so does this bundle.
 */
const SPAWNED = [
  {
    name: "claude",
    engine: "claudeAgent",
    resolve: "PATH",
    setting: "binaryPath",
    sdkPackage: `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
    shipped: false,
  },
] as const;

/** Type-only packages, and the SDK's platform packages: its bundled CLI, never run (see SPAWNED). */
const neverShipped = (name: string): boolean =>
  name.startsWith("@types/") || name.startsWith("@anthropic-ai/claude-agent-sdk-");

/** Files Node never loads: type declarations and source maps. */
const buildOnlyFile = /\.(d\.[cm]?ts|map)$/;

/**
 * Another platform's natives in a package that ships every platform's: ONNX Runtime keeps a bin/napi-vN/OS/ARCH
 * directory for each, about 30 MB apiece (CUDA too on Linux), and only the build host's ever loads.
 */
const foreignNative = (relative: string): boolean => {
  const m = /^bin\/napi-v\d+\/([^/]+)(?:\/([^/]+))?/.exec(relative);
  return m !== null && (m[1] !== process.platform || (m[2] !== undefined && m[2] !== process.arch));
};

const MAGIC = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "7f454c46", "4d5a"]);

/** Mach-O, ELF or PE, by magic number: what a target must rebuild, re-sign or replace. */
const isNativeBinary = (file: string): boolean => {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    const read = fs.readSync(fd, head, 0, 4, 0);
    return (read === 4 && MAGIC.has(head.toString("hex"))) || (read >= 2 && MAGIC.has(head.toString("hex", 0, 2)));
  } finally {
    fs.closeSync(fd);
  }
};

const listFiles = (dir: string): Array<string> =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));

/** `node_modules/<name>` as Node finds it walking up from `fromDir`, real path, or undefined. */
const findPackage = (name: string, fromDir: string): string | undefined => {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return undefined;
  }
};

const packageName = (id: string): string => {
  const parts = id.split("/");
  return id.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
};

interface StagedPackage {
  readonly name: string;
  readonly version: string;
  /** Where it sits in dist; a second version of a name nests under the package that needs it. */
  readonly path: string;
  readonly native: ReadonlyArray<string>;
}

/**
 * Copies `roots` and their installed dependency closure (optional and peer
 * dependencies only when installed, as npm does) into `outDir/node_modules`:
 * flat, except where a second version of a name has to nest under its parent.
 */
const stageExternals = (roots: ReadonlyArray<readonly [string, string]>, outDir: string): Array<StagedPackage> => {
  const placed = new Map<string, { name: string; dir: string; version: string }>();
  const visit = (name: string, fromDir: string, parent: string | undefined, optional: boolean) => {
    if (neverShipped(name)) return;
    const dir = findPackage(name, fromDir);
    if (dir === undefined) {
      if (optional) return;
      throw new Error(`runtime bundle: external ${name} is not installed (needed from ${fromDir})`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    let target = `node_modules/${name}`;
    const atRoot = placed.get(target);
    if (atRoot?.version === manifest.version) return;
    if (atRoot !== undefined) {
      // ponytail: nests beside the parent only; an ancestor's own copy of the name would still win.
      if (parent === undefined) throw new Error(`runtime bundle: ${name} needed at ${atRoot.version} and ${manifest.version}`);
      target = `${parent}/node_modules/${name}`;
      if (placed.has(target)) return;
    }
    placed.set(target, { name, dir, version: manifest.version });
    for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep, dir, target, false);
    for (const dep of Object.keys({ ...manifest.optionalDependencies, ...manifest.peerDependencies })) visit(dep, dir, target, true);
  };
  // ws's accelerators are optional for ws too; everything else must be installed.
  for (const [root, fromDir] of roots) visit(root, fromDir, undefined, root === "bufferutil" || root === "utf-8-validate");

  return [...placed].sort(([a], [b]) => a.localeCompare(b)).map(([relative, { name, dir, version }]) => {
    const target = path.join(outDir, relative);
    fs.cpSync(dir, target, {
      recursive: true,
      dereference: true,
      // A pnpm package dir has no node_modules of its own; skip any so nesting stays ours.
      filter: (file) => {
        const relative = path.relative(dir, file).split(path.sep).join("/");
        return relative.split("/")[0] !== "node_modules" && !buildOnlyFile.test(file) && !(name === "onnxruntime-node" && foreignNative(relative));
      },
    });
    // ONNX Runtime's install script fetches CUDA providers from nuget.org on Linux x64 whenever the install is not
    // a local one, as `npm install --global` of the runtime's npm package is: chat search runs on the CPU, so the
    // shipped copy has no install script and nothing downloads at install time.
    if (name === "onnxruntime-node") {
      const file = path.join(target, "package.json");
      const { scripts: _scripts, ...shipped } = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(file, `${JSON.stringify(shipped, null, 2)}\n`);
    }
    const native = listFiles(target)
      .filter((file) => !path.relative(target, file).split(path.sep).includes("node_modules"))
      .filter(isNativeBinary)
      .map((file) => path.relative(target, file).split(path.sep).join("/"))
      .sort();
    return { name, version, path: relative, native };
  });
};

/** A package under node_modules in a `//#region` path, which names it with the build host's separator. */
const NODE_MODULES_PACKAGE = /node_modules[/\\]((?:@[^/\\\s]+[/\\])?[^/\\\s]+)[/\\]/g;
const packageIn = (match: RegExpMatchArray): string => match[1]!.replace("\\", "/");

/** `[package name, package dir]` for each npm package in a chunk's `//#region <path>` comments. */
const regionPackages = (source: string): Array<readonly [string, string]> =>
  [...source.matchAll(/\/\/#region\s+(\S+)/g)].flatMap((region) => {
    const matches = [...(region[1] ?? "").matchAll(NODE_MODULES_PACKAGE)].filter((match) => match[1] !== ".pnpm");
    const last = matches.at(-1);
    if (last === undefined) return [];
    return [[packageIn(last), path.resolve(runtimeDir, region[1]!.slice(0, last.index + last[0].length))] as const];
  });

/**
 * `[package name, package dir]` for each npm package among a chunk's source map sources. A CommonJS package
 * imported from ESM is wrapped inside its importer's region and has no region comment of its own (saxes, in the
 * document text worker), so the regions alone miss it.
 */
const sourceMapPackages = (chunk: OutputChunk, outDir: string): Array<readonly [string, string]> =>
  (chunk.map?.sources ?? []).flatMap((source) => {
    const matches = [...source.matchAll(NODE_MODULES_PACKAGE)].filter((match) => match[1] !== ".pnpm");
    const last = matches.at(-1);
    if (last === undefined) return [];
    return [[packageIn(last), path.resolve(outDir, path.dirname(chunk.fileName), source.slice(0, last.index + last[0].length))] as const];
  });

/** The license text of every package inlined into the chunks (they lose their own files). */
const thirdPartyLicenses = (packages: ReadonlyMap<string, string>): string => {
  const sections = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([dir, name]) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const file = fs
      .readdirSync(dir)
      .sort()
      .find((entry) => /^(licen[cs]e|copying)([.-]|$)/i.test(entry));
    const text = file === undefined ? `(no license file in the package; package.json says ${manifest.license ?? "nothing"})` : fs.readFileSync(path.join(dir, file), "utf8").trim();
    return `==== ${name}@${manifest.version} (${manifest.license ?? "unknown"}) ====\n\n${text}\n`;
  });
  return `Third-party software inlined into bin.mjs and its chunks (${sections.length} packages).\nPackages under node_modules/ keep their own license files.\n\n${sections.join("\n")}`;
};

/** Every `new URL("./x", import.meta.url)` in the output must name a file that ships. */
const missingUrlTargets = (chunks: ReadonlyArray<{ fileName: string; code: string }>, outDir: string): Array<string> =>
  chunks.flatMap((chunk) =>
    [...chunk.code.matchAll(/new URL\(\s*["'](\.\.?(?:\/[^"']*)?)["']\s*,\s*import\.meta\.url\s*\)/g)]
      .map((match) => path.resolve(outDir, path.dirname(chunk.fileName), match[1]!))
      .filter((target) => !fs.existsSync(target))
      .map((target) => `${chunk.fileName} -> ${path.relative(outDir, target)}`),
  );

/**
 * Every package a chunk loads with `createRequire(import.meta.url)` must resolve
 * from dist: the bundler never sees those loads, so a package that is neither a
 * declared dependency nor reached by an import would ship missing (native SDK did).
 * Inside dist, or a builtin: built into packages/runtime/dist, a missing one would
 * still resolve from the workspace's node_modules above it. `outDir` may sit under a symlink.
 */
export const missingRequireTargets = (chunks: ReadonlyArray<{ fileName: string; code: string }>, outDir: string): Array<string> =>
  chunks.flatMap((chunk) => {
    const names = [...chunk.code.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\.)?createRequire\(import\.meta\.url\)\s*;/g)].map((m) => m[1]!);
    const calls = [
      ...chunk.code.matchAll(/createRequire\(import\.meta\.url\)\(\s*"([^"]+)"\s*\)/g),
      ...names.flatMap((name) => [...chunk.code.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\(\\s*"([^"]+)"\\s*\\)`, "g"))]),
    ].map((m) => m[1]!);
    const require = createRequire(path.join(outDir, chunk.fileName));
    // require.resolve answers real paths: compare against dist's own (macOS's tmpdir is a symlink to /private/var).
    const root = fs.realpathSync(outDir);
    return [...new Set(calls)].filter((id) => {
      if (isBuiltin(id)) return false;
      try {
        const from = path.relative(root, require.resolve(id));
        return from.startsWith("..") || path.isAbsolute(from);
      } catch {
        return true;
      }
    }).map((id) => `${chunk.fileName} -> ${id}`);
  });

/**
 * Packages rolldown inlined that must stay external (upstream
 * findInlinedExternalPackages): a native loader inlined into a chunk looks for
 * its binaries beside the chunk and silently falls back or fails.
 */
const findInlinedExternals = (source: string): Array<string> => {
  const inlined = new Set<string>();
  for (const region of source.matchAll(/\/\/#region\s+(\S+)/g)) {
    for (const match of (region[1] ?? "").matchAll(NODE_MODULES_PACKAGE)) {
      if (isExternalRuntimeDependency(packageIn(match))) inlined.add(packageIn(match));
    }
  }
  return [...inlined].sort();
};

/**
 * What the runtime does not load to start (Caveman Cloud the spec addendum 2026-10-24): the Caveman engine's graph
 * (external), about a thousand files a woken Cloud computer used to read before it linked, which provider-caveman's
 * engine.ts imports on first use (its journal, `/durable`, and `/catalog`, a dozen files, stay in the start); and
 * web_fetch's HTML and PDF parsers (bundled), which only its page reader process runs (src/web/pageText.ts).
 */
const LOADED_ON_FIRST_USE: ReadonlyArray<string> = [
  // The Caveman harness (bundled, one file with its own Pi packages): imported at a coding thread's first session.
  "@caveman-ai/harness",
  "@caveman-ai/agent",
  "@caveman-ai/agent/code",
  "@caveman-ai/agent/mcp",
  "@caveman-ai/agent/plugins",
  "defuddle",
  "linkedom",
  "turndown",
  "unpdf",
];

/** The npm package a bundled module comes from, if any: the last `node_modules/<name>/` in its path. */
const bundledPackage = (moduleId: string): string | undefined => {
  const names = [...moduleId.matchAll(NODE_MODULES_PACKAGE)].map(packageIn).filter((name) => name !== ".pnpm");
  return names.at(-1);
};

/**
 * What of `firstUse` the `entries` chunks load before they run, through what they import statically, what those
 * import, and so on, never through an `import()`: an external module imported, or a package bundled into one of
 * those chunks. As `<chunk> -> <module or package>`.
 */
export const loadedAtStart = (
  chunks: ReadonlyArray<Pick<OutputChunk, "fileName" | "imports" | "moduleIds">>,
  entries: ReadonlyArray<string>,
  firstUse: ReadonlyArray<string> = LOADED_ON_FIRST_USE,
): Array<string> => {
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const seen = new Set<string>();
  const found = new Set<string>();
  const visit = (fileName: string): void => {
    if (seen.has(fileName)) return;
    seen.add(fileName);
    const chunk = byFile.get(fileName);
    for (const id of chunk?.imports ?? []) {
      if (byFile.has(id)) visit(id);
      else if (firstUse.includes(id)) found.add(`${fileName} -> ${id}`);
    }
    for (const id of chunk?.moduleIds ?? []) {
      const name = bundledPackage(id);
      if (name !== undefined && firstUse.includes(name)) found.add(`${fileName} -> ${name}`);
    }
  };
  for (const entry of entries) visit(entry);
  return [...found].sort();
};

const declaredExternals = (): Array<string> =>
  Object.keys(JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8")).dependencies).filter(
    isExternalRuntimeDependency,
  );

/** Builds apps/web into apps/web/dist, the client dist/client serves (a vite build takes about 2 s). */
export const buildWebClient = (): void => {
  const pnpm = hostCommand("pnpm", ["--filter", "@caveman-app/web", "build"]);
  execFileSync(pnpm.file, pnpm.args, { cwd: runtimeDir, shell: pnpm.shell, stdio: ["ignore", "ignore", "inherit"] });
};

/**
 * Minifies each chunk in place, names kept (Effect and stack traces read `name`), its source map carried through.
 * Runs after every check above: they read the chunks' `//#region` paths and createRequire calls, which minifying drops.
 */
const minifyChunks = async (chunks: ReadonlyArray<OutputChunk>, outDir: string): Promise<void> => {
  const keepNames = { function: true, class: true };
  await Promise.all(
    chunks.map(async (chunk) => {
      const result = await minify(chunk.fileName, chunk.code, {
        module: true,
        compress: { keepNames },
        mangle: { keepNames },
        sourcemap: chunk.map !== null,
        ...(chunk.map === null ? {} : { inputMap: chunk.map }),
      });
      if (result.errors.length > 0) throw new Error(`runtime bundle: minify ${chunk.fileName}: ${result.errors.map((error) => error.message).join("; ")}`);
      const file = path.join(outDir, chunk.fileName);
      if (result.map === undefined) return fs.writeFileSync(file, result.code);
      const mapFile = chunk.sourcemapFileName ?? `${chunk.fileName}.map`;
      fs.writeFileSync(file, `${result.code}\n//# sourceMappingURL=${path.basename(mapFile)}\n`);
      fs.writeFileSync(path.join(outDir, mapFile), JSON.stringify(result.map));
    }),
  );
  fs.chmodSync(path.join(outDir, "bin.mjs"), 0o755);
};

export interface RuntimeManifest {
  readonly schema: 1;
  /** The version the runtime reports (src/runtimeVersion.ts): `--version`, server-runtime.json, runtime.hello. */
  readonly version: string;
  readonly entry: "bin.mjs";
  readonly node: string;
  /** `process.platform-process.arch` of the build host, whose native binaries were staged. */
  readonly platform: string;
  readonly externals: ReadonlyArray<StagedPackage>;
  readonly spawned: typeof SPAWNED;
  /** dist/client holds the web client (src/config.ts resolveStaticDir serves it at /). */
  readonly client: boolean;
  /**
   * What a host may start this runtime with (Caveman Cloud cloud/runner/code/caveman-computer reads this). "link-wait":
   * on a warm Cloud computer, before its identity is in CAVEMAN_CLOUD_LINK_DIR (CAVEMAN_RUNTIME_LINK_WAIT=1).
   * "link-bootstrap": it takes that identity itself with the pod's bootstrap file (CAVEMAN_RUNTIME_LINK_BOOTSTRAP).
   * "self-check": `caveman-runtime self-check` loads the module graph and every staged native and exits (src/selfCheck.ts);
   * the computer image's release check runs it first.
   */
  readonly features: ReadonlyArray<"link-wait" | "link-bootstrap" | "self-check">;
}

/**
 * The version a bundle reports: CAVEMAN_APP_VERSION, which the release workflows set (the desktop app's, the npm
 * package's, the computer image's); else package.json's, 0.0.0, which readers take as unknown.
 */
export const bundleVersion = (env: NodeJS.ProcessEnv = process.env): string => {
  const given = env.CAVEMAN_APP_VERSION?.trim().replace(/^v/, "");
  if (!given) return (JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8")) as { version: string }).version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(given)) throw new Error(`CAVEMAN_APP_VERSION ${given} is not a version`);
  return given;
};

export async function bundleRuntime(
  outDir: string = path.join(runtimeDir, "dist"),
  clientDir: string = webDist,
  version: string = bundleVersion(),
): Promise<RuntimeManifest> {
  fs.rmSync(outDir, { recursive: true, force: true });
  const externalRoots = new Map<string, string>();
  const output = await build({
    cwd: runtimeDir,
    input: {
      bin: path.join(runtimeDir, "src/bin.ts"),
      "claude-history-worker": path.join(runtimeDir, "src/claude-history-worker.ts"),
      // chat.search's model thread (src/search/Embedder.ts finds it beside the chunks).
      "embedder-worker": path.join(runtimeDir, "src/search/embedder-worker.ts"),
      // web_fetch's page reader, a child process (src/web/pageProcess.ts finds it beside the chunks).
      "page-worker": path.join(runtimeDir, "src/web/page-worker.ts"),
    },
    platform: "node",
    // src/runtimeVersion.ts.
    transform: { define: { __CAVEMAN_RUNTIME_VERSION__: JSON.stringify(version) } },
    external: (id, importer) => {
      if (id.startsWith("node:") || id.startsWith(".") || path.isAbsolute(id)) return false;
      if (!isExternalRuntimeDependency(id)) return false;
      // Resolved later from the importing package, which may be a workspace package's dependency.
      if (!externalRoots.has(packageName(id))) externalRoots.set(packageName(id), importer ? path.dirname(importer) : runtimeDir);
      return true;
    },
    logLevel: "warn",
    output: {
      dir: outDir,
      format: "esm",
      entryFileNames: "[name].mjs",
      chunkFileNames: "[name]-[hash].mjs",
      sourcemap: true,
      banner: "#!/usr/bin/env node\n",
    },
  });

  const chunks = output.output.filter((chunk) => chunk.type === "chunk");
  const inlined = chunks.flatMap((chunk) => findInlinedExternals(chunk.code));
  if (inlined.length > 0) throw new Error(`runtime bundle inlined packages that must stay external: ${inlined.join(", ")}`);
  // The start: bin.mjs and the server it imports (src/binCli.ts).
  const server = chunks.find((chunk) => chunk.facadeModuleId === path.join(runtimeDir, "src/binCli.ts"));
  if (server === undefined) throw new Error("runtime bundle: no chunk for src/binCli.ts");
  const early = loadedAtStart(chunks, ["bin.mjs", server.fileName]);
  if (early.length > 0) throw new Error(`runtime bundle: the start loads modules it should load on first use: ${early.join(", ")}`);

  fs.copyFileSync(path.join(runtimeDir, "src/plugins/sandboxLaunch.mjs"), path.join(outDir, "sandboxLaunch.mjs"));
  // A Cloud computer's exec channel (src/cloudLink/tools.ts): the runtime's client, the tools container's server.
  fs.copyFileSync(path.join(runtimeDir, "src/cloudLink/toolsExec.mjs"), path.join(outDir, "toolsExec.mjs"));
  // What Claude Agent's shell sources there before each command (CLAUDE_ENV_FILE): the tools PATH back.
  fs.copyFileSync(path.join(runtimeDir, "src/cloudLink/toolsShellEnv.sh"), path.join(outDir, "toolsShellEnv.sh"));
  // The memory SQL sandbox (src/memory/MemorySandbox.ts): a child process the runtime can SIGKILL.
  fs.copyFileSync(path.join(runtimeDir, "src/memory/memorySandbox.mjs"), path.join(outDir, "memorySandbox.mjs"));
  // Grill mode's skill, a Claude plugin dir src/grill/grill.ts finds beside the chunks.
  fs.cpSync(path.join(runtimeDir, "src/grill/grill-plugin"), path.join(outDir, "grill-plugin"), { recursive: true });
  // The automations skill, a Claude plugin dir src/automations/skill.ts finds beside the chunks.
  fs.cpSync(path.join(runtimeDir, "src/automations/automations-plugin"), path.join(outDir, "automations-plugin"), { recursive: true });
  // The task classifier's ask model, which src/askModel/model.ts reads beside the chunks on first use.
  fs.cpSync(path.join(runtimeDir, "src/askModel/model"), path.join(outDir, "model"), { recursive: true });
  // The Caveman catalog ships with every runtime (the desktop app's and a Cloud computer's).
  fs.cpSync(path.join(runtimeDir, "../../catalog"), path.join(outDir, "catalog"), { recursive: true });
  fs.chmodSync(path.join(outDir, "bin.mjs"), 0o755);
  const client = fs.existsSync(path.join(clientDir, "index.html"));
  if (client) fs.cpSync(clientDir, path.join(outDir, "client"), { recursive: true });
  const missing = missingUrlTargets(chunks, outDir);
  if (missing.length > 0) throw new Error(`runtime bundle: files the chunks load beside themselves are missing: ${missing.join(", ")}`);
  const inlinedPackages = new Map(
    chunks.flatMap((chunk) => [...regionPackages(chunk.code), ...sourceMapPackages(chunk, outDir)]).map(([name, dir]) => [dir, name]),
  );
  fs.writeFileSync(path.join(outDir, "THIRD_PARTY_LICENSES.txt"), thirdPartyLicenses(inlinedPackages));
  fs.copyFileSync(path.join(runtimeDir, "../../THIRD_PARTY_NOTICES.md"), path.join(outDir, "THIRD_PARTY_NOTICES.md"));
  const manifest: RuntimeManifest = {
    schema: 1,
    version,
    entry: "bin.mjs",
 // upstream apps/server engines range.
    node: "^22.16 || ^23.11 || >=24.10",
    platform: `${process.platform}-${process.arch}`,
    // The runtime loads node-pty, fff and Playwright through createRequire, which
    // the bundler never sees, so the declared dependencies count as roots too
 // (upstream selectCliRuntimeExternalDependencies).
    externals: stageExternals(
      [...new Map([...declaredExternals().map((name) => [name, runtimeDir] as const), ...externalRoots])].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
      outDir,
    ),
    spawned: SPAWNED,
    client,
    features: ["link-wait", "link-bootstrap", "self-check"],
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const unresolved = missingRequireTargets(chunks, outDir);
  if (unresolved.length > 0) throw new Error(`runtime bundle: packages the chunks require from disk are not staged: ${unresolved.join(", ")}`);
  await minifyChunks(chunks, outDir);
  // package.json makes dist an ES module scope and a self-contained package.
  fs.writeFileSync(
    path.join(outDir, "package.json"),
    `${JSON.stringify({ name: "@caveman-app/runtime-dist", private: true, type: "module", bin: { "caveman-runtime": "bin.mjs" } }, null, 2)}\n`,
  );
  return manifest;
}

if (import.meta.main) {
  const started = Date.now();
  buildWebClient();
  const outDir = process.argv[2] === undefined ? undefined : path.resolve(process.argv[2]);
  const manifest = await bundleRuntime(outDir);
  const natives = manifest.externals.filter((pkg) => pkg.native.length > 0).map((pkg) => pkg.name);
  console.log(
    `built ${path.relative(process.cwd(), outDir ?? path.join(runtimeDir, "dist")) || "."}/bin.mjs in ${Date.now() - started} ms; ` +
      `externals ${manifest.externals.map((pkg) => pkg.name).join(", ")}; native ${natives.join(", ")}; ` +
      `client ${manifest.client ? "apps/web/dist" : "none"}`,
  );
}
