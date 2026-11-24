// Builds Caveman Code with electron-builder (upstream scripts/build-desktop-artifact.ts does the same with far
// more targets), for the machine it runs on:
//
// macOS: Caveman Code.app, a .dmg and the .zip the updater installs. Ad-hoc signed unless a signing identity
// is in the environment: CSC_LINK + CSC_KEY_PASSWORD (a Developer ID .p12) or CSC_NAME (a keychain identity).
// A signed build signs its .dmg too, and notarizes and staples the app, which the .dmg and the .zip carry, when
// notarytool credentials are in the environment as well: APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (an
// App Store Connect key), or APPLE_KEYCHAIN_PROFILE (a `xcrun notarytool store-credentials` profile), or APPLE_ID +
// APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID. --release refuses to build without both and checks Gatekeeper
// accepts the app, and the .dmg's signature.
//
// Windows (x64): the app in release/win-unpacked and its NSIS installer, Caveman-Code-Setup-<version>-x64.exe
// with its .blockmap and latest.yml, which the updater reads. Unsigned unless Azure Artifact Signing is in
// the environment (upstream names): AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (the service
// principal) and AZURE_TRUSTED_SIGNING_ENDPOINT, _ACCOUNT_NAME, _CERTIFICATE_PROFILE_NAME, _PUBLISHER_NAME.
// Then electron-builder signs every .exe, .dll and .node with Authenticode, the runtime's included, and
// --release refuses to build without them and checks Windows accepts every signature.
//
// Secrets never live in this repo. CAVEMAN_APP_VERSION sets the version (the release tag's). Nothing is
// published from here: the feed in app-update.yml (https://download.caveman.so/code/mac, /code/win) is filled
// by .github/workflows/desktop-release.yml and desktop-publish.yml.
//   node scripts/package.mjs            the app + .dmg + .zip, or + the installer, in apps/desktop/release;
//                                       ad-hoc signed on a Mac without an identity: no update feed, and it
//                                       opens on another Mac only once its quarantine is lifted (it says how)
//   node scripts/package.mjs --dir      the app only
//   node scripts/package.mjs --release  signed (and notarized), or it fails
//   node scripts/package.mjs --local    the app only, with no update feed: a build from source for this
//                                       computer (scripts/install-app.sh), which the updater would otherwise
//                                       replace with the last published release
//
// macOS 13.5 or newer (MAC_MINIMUM): every Mach-O in the runtime is checked against it. On Windows the runtime
// carries the Visual C++ runtime DLLs its natives import (carryVcRuntime), from Visual Studio's redistributable
// folder, since a clean Windows has none.
//
// The runtime ships as <resources>/runtime (Contents/Resources on macOS, <install dir>/resources on Windows):
// the bundle from `pnpm --filter @caveman-app/runtime build` plus Node itself (`runtime/node`, `node.exe` on
// Windows), which runs it, and the pinned caveman-proxy, caveman-mcp and caveman-engine (`runtime/bin`,
// packages/runtime/scripts/cavemanBinaries.ts) its chats run through. A separate Node lets the runAsNode fuse
// be off: the Electron binary never acts as Node, and the runtime's own children (plugin launcher, ACP bridge)
// re-run `process.execPath` as Node, which a utility process could not offer.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { Arch, build, Platform } from "electron-builder";

import { binaryFile, installCavemanBinaries } from "../../../packages/runtime/scripts/cavemanBinaries.ts";
import { installAgentDesktop } from "../../../packages/runtime/scripts/agentDesktopBinary.ts";
import { hostCommand } from "../../../packages/runtime/scripts/hostCommand.ts";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
// pnpm is pnpm.cmd on Windows, which runs only through cmd.exe (hostCommand.ts).
const run = (command, args) => {
  const { file, args: argv, shell } = hostCommand(command, args);
  const result = spawnSync(file, argv, { cwd: desktopDir, shell, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const win = process.platform === "win32";
if (!win && process.platform !== "darwin") throw new Error(`package.mjs builds the macOS and Windows apps; this is ${process.platform}`);

// Node for the runtime: Electron 44's own Node version, from nodejs.org,
// checked against nodejs.org/dist/v24.21.0/SHASUMS256.txt.
const NODE_VERSION = "24.21.0";
const NODE = {
  "darwin-arm64": { name: `node-v${NODE_VERSION}-darwin-arm64`, ext: "tar.gz", sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057" },
  "darwin-x64": { name: `node-v${NODE_VERSION}-darwin-x64`, ext: "tar.gz", sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097" },
  "win32-x64": { name: `node-v${NODE_VERSION}-win-x64`, ext: "zip", sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541" },
};

/**
 * Writes Node to `runtimeDir/node` (`node.exe` on Windows) and its license to `licenseFile`. The archive
 * stays in .cache and is checked against the pin on every run.
 */
async function installNode(arch, runtimeDir, licenseFile) {
  const pin = NODE[`${process.platform}-${arch}`];
  if (pin === undefined) throw new Error(`no pinned Node for ${process.platform}-${arch}`);
  const archive = join(desktopDir, ".cache", `${pin.name}.${pin.ext}`);
  if (!existsSync(archive)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${pin.name}.${pin.ext}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
    mkdirSync(dirname(archive), { recursive: true });
    writeFileSync(`${archive}.partial`, Buffer.from(await response.arrayBuffer()));
    renameSync(`${archive}.partial`, archive);
  }
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (sha256 !== pin.sha256) throw new Error(`${archive}: sha256 ${sha256}, expected ${pin.sha256}; delete it to download again`);
  // Windows' own bsdtar reads zip; Git for Windows' GNU tar, often first on PATH there, cannot.
  const tarBinary = win ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const tar = (options, member) => {
    const result = spawnSync(tarBinary, ["-x", ...(win ? [] : ["-z"]), ...options, "-f", archive, member], { maxBuffer: 1 << 24 });
    if (result.status !== 0) throw new Error(`tar ${member}: ${result.stderr}`);
    return result.stdout;
  };
  if (win) tar(["-C", runtimeDir, "--strip-components", "1"], `${pin.name}/node.exe`);
  else tar(["-C", runtimeDir, "--strip-components", "2"], `${pin.name}/bin/node`);
  writeFileSync(licenseFile, tar(["-O"], `${pin.name}/LICENSE`));
}

/** The build host's natives the runtime bundle must carry for `arch` (it stages the host's only). */
const hostNatives = (arch) =>
  win
    ? [`@ff-labs/fff-bin-win32-${arch}`, `@yuuang/ffi-rs-win32-${arch}-msvc`, `@napi-rs/keyring-win32-${arch}-msvc`, `onnxruntime-node/bin/napi-v6/win32/${arch}`, `@node-datachannel/win32-${arch}-msvc`]
    : [`@ff-labs/fff-bin-darwin-${arch}`, `@yuuang/ffi-rs-darwin-${arch}`, `@napi-rs/keyring-darwin-${arch}`, `onnxruntime-node/bin/napi-v6/darwin/${arch}`, `@node-datachannel/darwin-${arch}`];

/**
 * Copies the compile-cache preload beside the runtime and runs it with the bundled Node to prepare the start's
 * bytecode (ported from upstream scripts/prepare-server-compile-cache.cjs). Before signing, which seals the files.
 * Skipped on Windows, whose Node compile cache stays off (its synchronous writes slowed the start by seconds), and
 * for an arch this Mac cannot run (an arm64 Mac runs an x64 Node under Rosetta).
 */
function prepareCompileCache(arch, runtimeDir) {
  if (win) return console.log("[compile-cache] skipped: off on Windows");
  if (arch !== process.arch && !(arch === "x64" && process.arch === "arm64")) return console.log(`[compile-cache] skipped: cannot run ${arch} here`);
  const preload = join(runtimeDir, "serverCompileCache.mjs");
  cpSync(join(desktopDir, "dist-electron/serverCompileCache.mjs"), preload);
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NODE_") && !name.startsWith("CAVEMAN_")));
  const result = spawnSync(join(runtimeDir, "node"), [preload, "--generate", runtimeDir], { env: childEnv, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(`compile cache generation failed: ${result.error ?? ""}${result.stderr}`);
  console.log(result.stdout.trim());
}

run(process.execPath, ["scripts/build.mjs"]);
// With SENTRY_AUTH_TOKEN (the release workflows') the web client's source maps are made too, for uploadSymbols below.
const symbols = Boolean(process.env.SENTRY_AUTH_TOKEN);
if (symbols) process.env.CAVEMAN_SOURCEMAPS = "1";
// Builds apps/web too: dist/client is the app's only copy of the web client.
run("pnpm", ["--filter", "@caveman-app/runtime", "build"]);

const env = process.env;
const AZURE = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
];
const sign = win ? AZURE.every((name) => env[name]) : Boolean(env.CSC_LINK || env.CSC_NAME);
const notary = Boolean((env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) || env.APPLE_KEYCHAIN_PROFILE || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID));
const release = process.argv.includes("--release");
if (release && win && !sign) {
  throw new Error(`--release needs Azure Artifact Signing; unset: ${AZURE.filter((name) => !env[name]).join(", ")}`);
}
if (release && !win && !(sign && notary)) {
  throw new Error(`--release needs a Developer ID identity (CSC_LINK or CSC_NAME) and notarytool credentials; found identity=${sign} notary=${notary}`);
}
const version = env.CAVEMAN_APP_VERSION?.replace(/^v/, "");
if (version !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`CAVEMAN_APP_VERSION ${version} is not a version`);
// Absolute: codesign runs from wherever this script was started.
const entitlements = join(desktopDir, "resources/entitlements.mac.plist");
const local = process.argv.includes("--local");
if (local && release) throw new Error("--local and --release do not go together");
const dir = local || process.argv.includes("--dir");
/** A Mac build with no Developer ID: it runs here, and on another Mac only once its quarantine is lifted. */
const adHocMac = !win && !sign;

/** Every file under `root` electron-builder would Authenticode-sign: executables and the signExts. */
const signable = (root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(exe|dll|node)$/i.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The oldest macOS the app says it runs on (LSMinimumSystemVersion). Nothing it carries may need a newer one: the
 * pinned Node is built for 13.5, and on 13.0-13.4 the window opened while its runtime kept stopping. afterPack checks
 * every Mach-O in the runtime against it (machoMinimums), so a Node or native that needs more fails the build.
 */
const MAC_MINIMUM = "13.5";
/**
 * Natives the runtime loads for one feature only and does without when they won't load, by where they sit in the
 * runtime: these may need a newer macOS. node-datachannel (14.0 on arm64) carries direct connections to devices;
 * without it they go through Cloud's relay (src/cloudLink/direct.ts).
 */
const MAC_OPTIONAL = ["node_modules/@node-datachannel/"];
const versionNumber = (v) => v.split(".").map(Number).reduce((n, part, i) => n + (part || 0) * 256 ** (2 - i), 0);

/** The macOS each slice of a Mach-O file says it needs (LC_BUILD_VERSION, or LC_VERSION_MIN_MACOSX), or [] for any other file. */
function machoMinimums(file) {
  const fd = openSync(file, "r");
  try {
    const read = (offset, length) => {
      const buffer = Buffer.alloc(length);
      return readSync(fd, buffer, 0, length, offset) === length ? buffer : null;
    };
    const slice = (offset) => {
      const header = read(offset, 32);
      if (!header || header.readUInt32LE(0) !== 0xfeedfacf) return [];
      const commands = read(offset + 32, header.readUInt32LE(20));
      if (!commands) return [];
      const found = [];
      for (let at = 0, left = header.readUInt32LE(16); left > 0 && at + 8 <= commands.length; left--) {
        const cmd = commands.readUInt32LE(at);
        // LC_BUILD_VERSION (platform, minos) for macOS (platform 1); LC_VERSION_MIN_MACOSX (version) before it.
        const minos = cmd === 0x32 && commands.readUInt32LE(at + 8) === 1 ? commands.readUInt32LE(at + 12) : cmd === 0x24 ? commands.readUInt32LE(at + 8) : undefined;
        if (minos !== undefined) found.push(`${minos >>> 16}.${(minos >>> 8) & 0xff}.${minos & 0xff}`.replace(/\.0$/, ""));
        at += commands.readUInt32LE(at + 4);
      }
      return found;
    };
    const magic = read(0, 8);
    if (!magic) return [];
    // A universal binary: its slices, each with its own header.
    if (magic.readUInt32BE(0) === 0xcafebabe) {
      const count = magic.readUInt32BE(4);
      const table = read(8, count * 20);
      return table ? Array.from({ length: count }, (_, i) => slice(table.readUInt32BE(i * 20 + 8))).flat() : [];
    }
    return slice(0);
  } finally {
    closeSync(fd);
  }
}

/** The DLLs a Windows PE file (.exe, .dll, .node) imports, from its import and delay-import tables, lower-cased; [] for any other file. */
function peImports(file) {
  const data = readFileSync(file);
  if (data.length < 64 || data.readUInt16LE(0) !== 0x5a4d) return [];
  const pe = data.readUInt32LE(0x3c);
  if (pe + 24 > data.length || data.readUInt32LE(pe) !== 0x4550) return [];
  const sectionCount = data.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const directories = optional + (data.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const sections = optional + data.readUInt16LE(pe + 20);
  const offsetOf = (rva) => {
    for (let i = 0; i < sectionCount; i++) {
      const at = sections + i * 40;
      const start = data.readUInt32LE(at + 12);
      if (rva >= start && rva < start + Math.max(data.readUInt32LE(at + 8), data.readUInt32LE(at + 16))) return rva - start + data.readUInt32LE(at + 20);
    }
    return undefined;
  };
  const names = [];
  // The import directory (1): 20-byte descriptors, the DLL's name at +12; delay imports (13): 32 bytes, at +4.
  for (const [index, size, nameAt] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = data.readUInt32LE(directories + index * 8);
    for (let at = rva ? offsetOf(rva) : undefined; at !== undefined && at + size <= data.length; at += size) {
      const name = offsetOf(data.readUInt32LE(at + nameAt));
      if (name === undefined || data.readUInt32LE(at + nameAt) === 0) break;
      names.push(data.toString("latin1", name, data.indexOf(0, name)).toLowerCase());
    }
  }
  return names;
}

/** The Visual C++ runtime's DLLs, which Windows does not ship: a clean install has none until something installs them. */
const VC_RUNTIME = /^(vcruntime140(_1)?|msvcp140(_\d|_atomic_wait|_codecvt_ids)?|concrt140|vccorlib140|vcomp140)\.dll$/;

/** Visual Studio's redistributable copy of them for x64 (VC\Redist\MSVC\<newest>\x64\Microsoft.VC*.CRT), which Microsoft lets an app carry. */
function vcRuntimeDir() {
  const vswhere = join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const install = existsSync(vswhere) ? spawnSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], { encoding: "utf8" }).stdout.trim() : "";
  const redist = install ? join(install, "VC", "Redist", "MSVC") : "";
  const newestFirst = (a, b) => b.localeCompare(a, undefined, { numeric: true });
  for (const version of redist && existsSync(redist) ? readdirSync(redist).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(newestFirst) : []) {
    const x64 = join(redist, version, "x64");
    const crt = existsSync(x64) ? readdirSync(x64).find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name)) : undefined;
    if (crt) return join(x64, crt);
  }
  throw new Error("no Visual C++ redistributable on this computer: install Visual Studio's C++ build tools (vswhere finds them)");
}

/**
 * Puts the Visual C++ runtime DLLs the runtime's natives import (fff_c.dll, onnxruntime) where Windows looks for them
 * on a computer that never installed them: beside node.exe, for a library ffi-rs opens (its dependencies are looked for
 * in the application's folder), and beside each native that imports them, for an addon Node loads (looked for in the
 * addon's own folder). With them, and with what they import in turn. Returns the copies.
 */
function carryVcRuntime(runtimeDir) {
  const pe = readdirSync(runtimeDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(exe|dll|node)$/i.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  const wanted = new Map();
  const want = (dir, dll) => (wanted.get(dir) ?? wanted.set(dir, new Set()).get(dir)).add(dll);
  for (const file of pe) for (const dll of peImports(file).filter((name) => VC_RUNTIME.test(name))) [dirname(file), runtimeDir].forEach((dir) => want(dir, dll));
  if (wanted.size === 0) return [];
  const crt = vcRuntimeDir();
  const copies = [];
  for (const [dir, dlls] of wanted) {
    for (const queue = [...dlls]; queue.length > 0; ) {
      const dll = queue.shift();
      const from = readdirSync(crt).find((name) => name.toLowerCase() === dll);
      if (!from) throw new Error(`${crt} has no ${dll}`);
      cpSync(join(crt, from), join(dir, dll));
      copies.push(join(dir, dll));
      for (const next of peImports(join(crt, from)).filter((name) => VC_RUNTIME.test(name) && !dlls.has(name))) (dlls.add(next), queue.push(next));
    }
  }
  console.log(`Visual C++ runtime from ${crt}: ${copies.map((file) => relative(runtimeDir, file)).join(", ")}`);
  return copies;
}

/** notarytool's credentials, from the environment `notary` checked. */
const notaryAuth = () =>
  env.APPLE_API_KEY
    ? ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER]
    : env.APPLE_KEYCHAIN_PROFILE
      ? ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE]
      : ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];

/**
 * Notarizes the signed app and staples its ticket, before the .dmg and .zip are made (afterSign): both carry the
 * stapled app, so it opens offline too. The .dmg itself is signed, not notarized (as T3 and electron-builder do):
 * Gatekeeper judges the app it holds, and a second submission held each release up by its own few minutes. The app
 * goes to Apple zipped. electron-builder's own notarize tries once, and Apple's ticket service drops connections from
 * CI runners now and then (error 68: runs 40259645722 failed three times on it). A submission Apple judged is never
 * retried.
 */
async function notarize(path) {
  const dir = mkdtempSync(join(tmpdir(), "caveman-notarize-"));
  try {
    const upload = join(dir, "app.zip");
    if (spawnSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path, upload], { stdio: "inherit" }).status !== 0) {
      throw new Error(`ditto could not zip ${path} for notarization`);
    }
    for (let attempt = 1; ; attempt++) {
      const submit = spawnSync("xcrun", ["notarytool", "submit", upload, ...notaryAuth(), "--wait", "--timeout", "1h", "--output-format", "json"], { encoding: "utf8" });
      let verdict;
      try {
        verdict = JSON.parse(submit.stdout);
      } catch {}
      if (verdict?.status === "Accepted") {
        console.log(`notarized ${path}: ${verdict.id}`);
        break;
      }
      if (verdict?.status === "Invalid" || verdict?.status === "Rejected") {
        spawnSync("xcrun", ["notarytool", "log", verdict.id, ...notaryAuth()], { stdio: "inherit" });
        throw new Error(`notarization ${verdict.id}: ${verdict.status}`);
      }
      const why = (submit.stderr || submit.stdout || "").trim();
      if (attempt === 3) throw new Error(`notarytool submit: ${why}`);
      console.log(`notarytool submit failed (${why}); try ${attempt + 1} of 3`);
      await sleep(30_000 * attempt);
    }
    for (let attempt = 1; ; attempt++) {
      if (spawnSync("xcrun", ["stapler", "staple", path], { stdio: "inherit" }).status === 0) break;
      if (attempt === 5) throw new Error(`stapler could not staple ${path}`);
      console.log(`stapler failed; try ${attempt + 1} of 5`);
      await sleep(15_000 * attempt);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Crash reports' stacks (docs/): Sentry reads the minified main process, page and runtime
 * through their source maps, uploaded here and matched by the debug id `sentry-cli sourcemaps inject` writes into each
 * file. Before electron-builder copies them, so the files that ship carry the ids; the maps never ship (the asar takes
 * only dist-electron/*.cjs, the runtime copy leaves out every .map, and the client's are deleted here). SENTRY_ORG and
 * SENTRY_PROJECT name the project.
 */
function uploadSymbols() {
  const runtimeDist = join(desktopDir, "../../packages/runtime/dist");
  const paths = [join(desktopDir, "dist-electron"), runtimeDist];
  const cli = (args) => run(process.execPath, [join(desktopDir, "node_modules/@sentry/cli/bin/sentry-cli"), ...args]);
  cli(["sourcemaps", "inject", "--ignore", "node_modules", ...paths]);
  cli(["sourcemaps", "upload", ...(version ? ["--release", `caveman-code@${version}`] : []), "--ignore", "node_modules", ...paths]);
  for (const dir of [join(runtimeDist, "client"), join(desktopDir, "../web/dist")])
    for (const file of readdirSync(dir, { recursive: true })) if (String(file).endsWith(".map")) rmSync(join(dir, String(file)));
}
if (symbols) uploadSymbols();
else if (release && process.env.CAVEMAN_CRASH_DSN) console.warn("Crash reports are on in this build, but without SENTRY_AUTH_TOKEN their stacks stay minified in Sentry.");

const artifacts = await build({
  projectDir: desktopDir,
  targets: win ? Platform.WINDOWS.createTarget(dir ? ["dir"] : ["nsis"]) : Platform.MAC.createTarget(dir ? ["dir"] : ["dmg", "zip"]),
  // Never from here, and never implicitly because CI is set.
  publish: "never",
  config: {
    // Windows installs into %LOCALAPPDATA%\Programs\<name>: a plain name, not the workspace's @caveman-app/desktop.
    ...(version || win ? { extraMetadata: { ...(version ? { version } : {}), ...(win ? { name: "caveman-code" } : {}) } } : {}),
    // Written into app-update.yml for src/updates/DesktopUpdates.ts: public files, read with no login, the Stable
    // feed in every build (Nightly is derived from it). None in a --local build, so its updater stays off, nor in an
    // ad-hoc signed Mac build: Squirrel.Mac installs only an update signed as the running app is, so one would
    // download the release every 6 h and fail each time.
    publish: local || adHocMac ? null : { provider: "generic", url: `https://download.caveman.so/code/${win ? "win" : "mac"}` },
    // Each channel has its own feed with its own latest-mac.yml / latest.yml (src/updates/updateChannels.ts): a
    // nightly such as 0.4.3-nightly.20261109.12 must not write nightly-mac.yml, which nothing reads.
    detectUpdateChannel: false,
    // The notes the feed carries for Settings > General (src/updates/releaseNotes.ts): a nightly's commit subjects,
    // from desktop-nightly.yml. In latest-mac.yml / latest.yml as `releaseNotes`.
    ...(env.CAVEMAN_RELEASE_NOTES_FILE ? { releaseInfo: { releaseNotesFile: env.CAVEMAN_RELEASE_NOTES_FILE } } : {}),
    appId: "so.caveman.code",
    productName: "Caveman Code",
    // No spaces: latest-mac.yml must name the files exactly as the release stores them.
    artifactName: "Caveman-Code-${version}-${arch}.${ext}",
    copyright: "Copyright © 2026 Caveman",
    directories: { output: "release", buildResources: "resources" },
    // Every bundle scripts/build.mjs writes (main and each preload): a preload left out leaves its window dead.
    files: ["package.json", "dist-electron/*.cjs"],
    extraResources: [
      // Apache-2.0, MIT, and Chromium notices travel with every copy, binary ones too.
      { from: "../../LICENSE", to: "LICENSE" },
      { from: "../../NOTICE", to: "NOTICE" },
      { from: "../../THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
      { from: "node_modules/electron/dist/LICENSE", to: "LICENSE.electron.txt" },
      { from: "node_modules/electron/dist/LICENSES.chromium.html", to: "LICENSES.chromium.html" },
    ],
    // <resources>/runtime is copied here, not by extraResources, which always
    // drops a node_modules at the root of a copy. Signing runs after this.
    afterPack: async ({ appOutDir, arch: archId, packager }) => {
      const arch = Arch[archId];
      if (arch !== "arm64" && arch !== "x64") throw new Error(`no runtime for ${arch} builds`);
      const dist = join(desktopDir, "../../packages/runtime/dist");
      // The bundle stages the build host's natives only, and the web client.
      for (const pkg of ["client/index.html", ...hostNatives(arch).map((native) => `node_modules/${native}`)]) {
        if (!existsSync(join(dist, pkg))) throw new Error(`packages/runtime/dist has no ${pkg}: build the runtime (on ${win ? "Windows" : "a Mac"}, ${arch})`);
      }
      const resources = win ? join(appOutDir, "resources") : join(appOutDir, `${packager.appInfo.productFilename}.app/Contents/Resources`);
 // As upstream MAC_FILE_EXCLUSIONS: no source maps or debug symbols, no other platform's natives (node-pty's
      // win32 prebuild carries its own conpty.dll and OpenConsole.exe; third_party is its build input).
      const foreign = new RegExp(`^node_modules/node-pty/(third_party|prebuilds/(?!${process.platform}-${arch}(/|$)))`);
      cpSync(dist, join(resources, "runtime"), {
        recursive: true,
        filter: (file) => !/\.(map|pdb)$/.test(file) && !foreign.test(relative(dist, file).split(sep).join("/")),
      });
      await installNode(arch, join(resources, "runtime"), join(resources, "LICENSE.node.txt"));
      // The app's own caveman-proxy, caveman-mcp and caveman-engine, never the person's install (src/router/proxyLauncher.ts).
      await installCavemanBinaries({ platform: process.platform, arch, dest: join(resources, "runtime"), cacheDir: join(desktopDir, ".cache") });
      // Computer use on a Mac: Vercel's agent-desktop and its helper (src/session-protocol/macDesktop). A Developer ID
      // build re-signs them with the app, so macOS grants them what it grants Caveman Code.
      if (!win) await installAgentDesktop({ arch, dest: join(resources, "runtime"), cacheDir: join(desktopDir, ".cache") });
      if (!win) {
        const needs = readdirSync(join(resources, "runtime"), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .flatMap((entry) => machoMinimums(join(entry.parentPath, entry.name)).map((minos) => ({ file: join(entry.parentPath, entry.name), minos })))
          .filter(({ file, minos }) => versionNumber(minos) > versionNumber(MAC_MINIMUM) && !MAC_OPTIONAL.some((dir) => relative(join(resources, "runtime"), file).split(sep).join("/").startsWith(dir)));
        if (needs.length > 0) throw new Error(`the app says it runs on macOS ${MAC_MINIMUM}, but ${needs.map(({ file, minos }) => `${relative(resources, file)} needs ${minos}`).join(", ")}: raise MAC_MINIMUM`);
      }
      // The runtime's start as V8 bytecode, made by the bundled Node (src/serverCompileCache.ts): macOS only.
      prepareCompileCache(arch, join(resources, "runtime"));
      // src/main.ts honours CAVEMAN_UPDATE_FEED_URL and CAVEMAN_TELEMETRY_URL only in builds that carry this.
      if (!release) writeFileSync(join(resources, "test-build"), "Built without --release: takes the test overrides.\n");
      // A clean Windows has no Visual C++ runtime: fff_c.dll and onnxruntime need it (file search, chat search).
      const vcRuntime = win ? carryVcRuntime(join(resources, "runtime")) : [];
      // electron-builder signs the app's own .exe, .dll and .node files after this, but not the ones copied
      // here: Node, the caveman binaries and the runtime's natives, which Smart App Control checks one by one.
      // Microsoft's own Visual C++ DLLs keep Microsoft's signature.
      if (win && sign) for (const file of signable(join(resources, "runtime")).filter((file) => !vcRuntime.includes(file))) if (!(await packager.signIf(file))) throw new Error(`${file} was not signed`);
    },
    asar: true,
    npmRebuild: false,
    protocols: [{ name: "Caveman Code", schemes: ["caveman-code"] }],
    electronFuses: {
      // The runtime runs on <resources>/runtime/node, so Electron never acts as Node.
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false, // pages load from caveman-code://, never file://
      // Flipping fuses breaks the ad-hoc signature; arm64 kills such a binary.
      // A signed build is re-signed by electron-builder instead.
      resetAdHocDarwinSignature: !win && !sign,
    },
    mac: {
      category: "public.app-category.developer-tools",
      minimumSystemVersion: MAC_MINIMUM,
      icon: "resources/icon.icns",
      // macOS shows these when a call with the Chief first asks for the microphone, and when looking for projects to
      // offer (when someone picks a project, never at start: src/project/ProjectDiscovery.ts) first reads a folder it guards.
      extendInfo: {
        NSMicrophoneUsageDescription: "Caveman Code uses the microphone when you call the Chief or talk to type.",
        NSDocumentsFolderUsageDescription: "Caveman Code looks in Documents for code projects to offer you, and works in the ones you open.",
        NSDesktopFolderUsageDescription: "Caveman Code looks on your Desktop for code projects to offer you, and works in the ones you open.",
        NSDownloadsFolderUsageDescription: "Caveman Code works in projects you open from Downloads.",
      },
      // A Developer ID build re-signs every Mach-O inside (Node, node-pty,
      // ffi-rs, libfff) with the app's team, so library validation stays on.
      // Ad-hoc signatures carry no team, and the hardened runtime (needed only
      // for notarization) refuses such natives, so ad-hoc builds go without it.
      hardenedRuntime: sign,
      entitlements,
      entitlementsInherit: entitlements,
      // "-" signs ad-hoc; undefined lets electron-builder use the CSC_* identity.
      identity: sign ? undefined : "-",
      // notarize (afterSign below) notarizes and staples instead, with retries.
      notarize: false,
    },
    // After signing, before the .dmg and .zip: they carry the stapled app.
    afterSign: ({ appOutDir, packager, electronPlatformName }) =>
      electronPlatformName === "darwin" && sign && notary ? notarize(join(appOutDir, `${packager.appInfo.productFilename}.app`)) : undefined,
    // The installer window: scripts/make-dmg-background.py draws its background (1x and 2x) around these spots.
    // The window takes the background's 1x size, 640 x 400 (dmg.window applies only without a background), with
    // no toolbar or sidebar; 128 px icons, the app at (180, 190) and Applications at (460, 190), centres in 1x
    // points. The volume mounts as "Caveman Code" and shows the flame. A signed build signs the .dmg with the app's
    // identity; the app inside it is the notarized, stapled one (afterSign).
    dmg: {
      title: "Caveman Code",
      background: "resources/dmg-background.tiff",
      icon: "resources/icon.icns",
      iconSize: 128,
      contents: [
        // No path: the app electron-builder just built.
        { x: 180, y: 190, type: "file" },
        { x: 460, y: 190, type: "link", path: "/Applications" },
      ],
      sign,
    },
    win: {
      // scripts/make-icon.py, from the same art as icon.icns.
      icon: "resources/icon.ico",
 // Smart App Control checks every native library on its own, not only the app's .exe (upstream reason).
      signExts: [".node", ".dll"],
      // A signed build signs everything, or fails.
      forceCodeSigning: win && sign,
      ...(win && sign
        ? {
            azureSignOptions: {
              publisherName: env.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME,
              endpoint: env.AZURE_TRUSTED_SIGNING_ENDPOINT,
              certificateProfileName: env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
              codeSigningAccountName: env.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME,
            },
          }
        : {}),
    },
    nsis: {
      // One click, for this user, no administrator: %LOCALAPPDATA%\Programs\caveman-code. `/S` installs silently.
      oneClick: true,
      perMachine: false,
 // An update downloads only the blocks that changed (the .blockmap beside the installer), as upstream.
      differentialPackage: true,
      artifactName: "Caveman-Code-Setup-${version}-${arch}.${ext}",
      // The flame on the installer, the uninstaller and the one-click installer's header, as on the app.
      installerIcon: "resources/icon.ico",
      uninstallerIcon: "resources/icon.ico",
      installerHeaderIcon: "resources/icon.ico",
    },
  },
});
console.log(`signed: ${win ? (sign ? "Azure Artifact Signing" : "no (unsigned)") : sign ? "identity" : "ad-hoc"}`);
const dmgs = artifacts.filter((file) => file.endsWith(".dmg"));
for (const artifact of artifacts) console.log(artifact);
// An ad-hoc .dmg opens on this Mac, but on another one macOS says the app "is damaged and can't be opened" (Apple
// silicon), or that it can't verify it (Intel): a download is quarantined, and only a notarized Developer ID app
// passes Gatekeeper with it. Say so here, where the build is made, with what the person receiving it must do.
const adHocDmgs = adHocMac ? artifacts.filter((file) => file.endsWith(".dmg")) : [];
if (adHocDmgs.length > 0)
  console.warn(
    [
      "",
      `Ad-hoc signed: ${adHocDmgs.map((file) => basename(file)).join(", ")} is for this Mac. For anyone else, send the signed`,
      "release (.github/workflows/desktop-release.yml). If they must run this build, after dragging it to Applications:",
      `  xattr -dr com.apple.quarantine "/Applications/Caveman Code.app"`,
      "It never updates itself (no update feed), and on a Mac that has another Caveman Code, macOS asks once to let it",
      "use the \"Caveman Code Safe Storage\" keychain item (Always Allow).",
      "",
    ].join("\n"),
  );

// Read the fuses back from the built binary: runAsNode must be off.
// electron-builder writes x64 builds to release/mac (release/win-unpacked), arm64 ones to release/mac-arm64.
const appDir = join(desktopDir, "release", win ? (process.arch === "x64" ? "win-unpacked" : `win-${process.arch}-unpacked`) : process.arch === "x64" ? "mac" : `mac-${process.arch}`);
const appPath = join(appDir, win ? "Caveman Code.exe" : "Caveman Code.app");
const fuses = spawnSync(process.execPath, [join(desktopDir, "node_modules/@electron/fuses/dist/bin.js"), "read", "--app", appPath], { encoding: "utf8" });
console.log(fuses.stdout.trim());
if (!/RunAsNode is Disabled/.test(fuses.stdout)) throw new Error(`runAsNode fuse is not off: ${fuses.stderr}`);
const runtimeDir = win ? join(appDir, "resources/runtime") : join(appPath, "Contents/Resources/runtime");
if (!win) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  if (release) {
    // Gatekeeper's own verdict: a notarized Developer ID app, with the ticket stapled, so it opens offline too. It
    // throws rather than exits, so a mounted .dmg below is still detached.
    const judge = async (app) => {
      if (spawnSync("spctl", ["--assess", "--type", "execute", "--verbose=2", app], { stdio: "inherit" }).status !== 0) throw new Error(`Gatekeeper refuses ${app}`);
      // stapler asks Apple's ticket service, which drops a connection now and then (error 68, run 40259645722).
      for (let attempt = 1; ; attempt++) {
        if (spawnSync("xcrun", ["stapler", "validate", app], { stdio: "inherit" }).status === 0) break;
        if (attempt === 3) throw new Error(`${app} has no valid stapled ticket`);
        await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
      }
    };
    await judge(appPath);
    // The .dmg the site links to: signed with the Developer ID, and not notarized (notarize, above), since what
    // Gatekeeper judges from a download is the app a person drags out of it. That copy is judged too, mounted.
    for (const dmg of dmgs) {
      run("codesign", ["--verify", "--strict", "--verbose=2", dmg]);
      const mount = mkdtempSync(join(tmpdir(), "caveman-dmg-"));
      run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
      try {
        await judge(join(mount, "Caveman Code.app"));
      } finally {
        if (spawnSync("hdiutil", ["detach", mount], { stdio: "inherit" }).status === 0) rmSync(mount, { recursive: true, force: true });
      }
    }
  }
} else if (sign) {
  // Windows' own verdict on each signature: the app, its runtime's executables and natives, and the installer.
  const files = [appPath, ...signable(runtimeDir), ...artifacts.filter((file) => file.endsWith(".exe"))];
  const verdicts = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "$env:CAVEMAN_SIGNED -split \"`n\" | ForEach-Object { \"$((Get-AuthenticodeSignature -LiteralPath $_).Status) $_\" }"],
    { encoding: "utf8", env: { ...env, CAVEMAN_SIGNED: files.join("\n") } },
  );
  const lines = verdicts.stdout.trim().split(/\r?\n/);
  const bad = lines.filter((line) => !line.startsWith("Valid "));
  console.log(`Authenticode: ${lines.length - bad.length} of ${files.length} signatures valid`);
  if (verdicts.status !== 0 || lines.length !== files.length || bad.length > 0) throw new Error(`signatures Windows does not accept:\n${bad.join("\n")}${verdicts.stderr}`);
}

// node-pty from the bundle, on the bundled Node, inside the built app.
const node = join(runtimeDir, win ? "node.exe" : "node");
const systemRoot = env.SystemRoot ?? "C:\\Windows";
const pty = spawnSync(
  node,
  [
    "-e",
    // The shell stays up after the echo: a pty that exits at once can drop its last output. Windows' ConPTY
    // paints the screen with escape sequences, which are dropped before the output is read; cmd.exe goes by its
    // full path, since node-pty's own PATH search skips PATH's last entry.
    `const pty = require("node:module").createRequire(process.argv[1])("node-pty");
     const t = process.platform === "win32"
       ? pty.spawn(require("node:path").join(process.env.SystemRoot, "System32", "cmd.exe"), "/d /c echo node-pty ok& ping -n 2 127.0.0.1 >nul", {})
       : pty.spawn("/bin/sh", ["-c", "echo node-pty ok; sleep 1"], {});
     let out = ""; t.onData((d) => { out += d; const text = out.replace(/\\x1b\\[[0-?]*[ -\\/]*[@-~]|\\x1b\\][^\\x07]*\\x07/g, "");
       if (text.includes("node-pty ok")) { console.log("node-pty ok on node", process.version); t.kill(); process.exit(0); } });`,
    join(runtimeDir, "bin.mjs"),
  ],
  { encoding: "utf8", env: win ? { SystemRoot: systemRoot, windir: systemRoot, PATH: join(systemRoot, "System32") } : { PATH: "/usr/bin:/bin" }, timeout: 20_000 },
);
console.log(pty.stdout.trim() || `node-pty check failed: status=${pty.status} signal=${pty.signal} ${pty.error ?? ""} ${pty.stderr.trim()}`);
if (!pty.stdout.includes("node-pty ok")) process.exit(1);

// node-datachannel (the direct path to devices, src/cloudLink/direct.ts) from the bundle, on the bundled Node, inside
// the built app: a data channel over loopback carries one message.
const rtc = spawnSync(
  node,
  [
    "-e",
    `const ndc = require("node:module").createRequire(process.argv[1])("node-datachannel");
     const a = new ndc.PeerConnection("a", { iceServers: [] }), b = new ndc.PeerConnection("b", { iceServers: [] });
     a.onLocalDescription((s, t) => b.setRemoteDescription(s, t)); a.onLocalCandidate((c, m) => b.addRemoteCandidate(c, m));
     b.onLocalDescription((s, t) => a.setRemoteDescription(s, t)); b.onLocalCandidate((c, m) => a.addRemoteCandidate(c, m));
     b.onDataChannel((dc) => dc.onMessage((m) => { console.log("node-datachannel " + m, "on node", process.version); a.close(); b.close(); ndc.cleanup(); process.exit(0); }));
     const dc = a.createDataChannel("check"); dc.onOpen(() => dc.sendMessage("ok"));`,
    join(runtimeDir, "bin.mjs"),
  ],
  // Windows: Winsock needs SystemRoot.
  { encoding: "utf8", env: win ? { SystemRoot: systemRoot, windir: systemRoot, PATH: join(systemRoot, "System32") } : { PATH: "/usr/bin:/bin" }, timeout: 20_000 },
);
console.log(rtc.stdout.trim() || `node-datachannel check failed: status=${rtc.status} signal=${rtc.signal} ${rtc.error ?? ""} ${rtc.stderr.trim()}`);
if (!rtc.stdout.includes("node-datachannel ok")) process.exit(1);

// The natives that load only when someone searches (onnxruntime, fff), from the bundle, on the bundled Node. On this
// computer that proves they load; windows.yml runs the same check where no Visual C++ runtime is installed.
const natives = spawnSync(node, [join(desktopDir, "scripts/check-natives.mjs"), runtimeDir], {
  encoding: "utf8",
  env: win ? { SystemRoot: systemRoot, windir: systemRoot, PATH: join(systemRoot, "System32"), TEMP: tmpdir(), TMP: tmpdir() } : { PATH: "/usr/bin:/bin", TMPDIR: tmpdir() },
  timeout: 60_000,
});
console.log(natives.stdout.trim() || `natives check failed: status=${natives.status} signal=${natives.signal} ${natives.error ?? ""} ${natives.stderr.trim()}`);
if (!natives.stdout.includes("natives ok")) process.exit(1);

// The bundled caveman-proxy, inside the built app, answers as itself (its run state's instance token) from a scratch home.
const proxyHome = mkdtempSync(join(tmpdir(), "caveman-package-proxy-"));
const port = await new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const proxyEnv = { HOME: proxyHome, CAVEMAN_HOME: proxyHome, CAVEMAN_MODE: "compress", CAVEMAN_LISTEN: `127.0.0.1:${port}` };
const proxy = spawn(join(runtimeDir, "bin", binaryFile("caveman-proxy", process.platform)), ["serve"], {
  // Windows: Winsock needs SystemRoot; every profile folder Go reads is the scratch home.
  env: win
    ? { ...proxyEnv, SystemRoot: systemRoot, windir: systemRoot, PATH: join(systemRoot, "System32"), USERPROFILE: proxyHome, APPDATA: proxyHome, LOCALAPPDATA: proxyHome, TEMP: proxyHome, TMP: proxyHome }
    : { ...proxyEnv, PATH: "/usr/bin:/bin" },
  stdio: "ignore",
  windowsHide: true,
});
let answered = "";
for (let i = 0; i < 50 && !answered; i++) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const token = (() => {
    try {
      return JSON.parse(readFileSync(join(proxyHome, "run", `${port}.json`), "utf8")).instance_token;
    } catch {
      return undefined;
    }
  })();
  const live = await fetch(`http://127.0.0.1:${port}/health/live`).catch(() => undefined);
  if (token && live?.ok && live.headers.get("x-caveman-instance") === token) answered = (await live.json()).service;
}
const exited = new Promise((resolve) => proxy.once("exit", resolve));
// On Windows this ends the proxy outright, which is all a self-check needs.
proxy.kill("SIGTERM");
await exited;
rmSync(proxyHome, { recursive: true, force: true, maxRetries: 5 });
console.log(answered ? `bundled ${answered} answered from the built app` : "bundled caveman-proxy did not answer");
if (!answered) process.exit(1);
