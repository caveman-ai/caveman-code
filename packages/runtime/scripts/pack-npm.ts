// `pnpm --filter @caveman-app/runtime pack:npm [out-dir] [--smoke]` writes the `caveman-code` command's npm
// packages for this machine, , scripts/build-npm-platform-packages.ts):
//   caveman-ai-code-<platform>-<arch>-<version>.tgz   @caveman-ai/code-<platform>-<arch>: the web client and
//       the bundle step's dist (scripts/bundle.ts, minified) with its node_modules as bundled dependencies,
//       and the pinned caveman-proxy, caveman-mcp and caveman-engine in bin/ beside it (cavemanBinaries.ts,
//       as the desktop app carries them). Its natives are this machine's, so it declares this os and cpu.
//   caveman-ai-code-<version>.tgz   @caveman-ai/code: the launcher (npm-launcher.mjs, `caveman-code` =
//       `caveman code`), with every platform package at the same version as an optional dependency, of
//       which npm installs the one matching the machine.
// Each platform package is packed and smoked on its own runner, then all are published before the launcher,
// by .github/workflows/npm-release.yml: public, the license stays UNLICENSED. The desktop app installs the
// same command from its own runtime (apps/desktop/src/cli.ts).
// --smoke installs both into a temp prefix as npm would, and runs `caveman-code --help` and a foreground
// start against a temp home, which must serve the web client and start its own caveman-proxy.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWebClient, bundleRuntime, bundleVersion } from "./bundle.ts";
import { binaryFile, installCavemanBinaries, type CavemanPlatform } from "./cavemanBinaries.ts";
import { installAgentDesktop } from "./agentDesktopBinary.ts";
import { cmdFile, hostCommand, type HostCommand } from "./hostCommand.ts";
import { stopTree } from "./processTree.ts";

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every platform package the launcher lists; npm-release.yml builds each on its own runner. */
export const NPM_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"] as const;
export type NpmPlatform = (typeof NPM_PLATFORMS)[number];

export const LAUNCHER = "@caveman-ai/code";
export const platformPackage = (key: NpmPlatform): string => `${LAUNCHER}-${key}`;

const HOMEPAGE = "https://caveman.so/code";

/** Without a README of its own, npm shows the first one in the tarball: a bundled dependency's. */
const readme = (name: string, body: string) => `# ${name}\n\n${body}\n\n${HOMEPAGE}\n`;

const run = ({ file, args, shell }: HostCommand, cwd: string): string =>
  execFileSync(file, args, { cwd, shell, encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true });

/** `npm pack` of `stage` into `outDir`; returns the tarball's path. */
const npmPack = (stage: string, outDir: string): string => {
  const out = run(hostCommand("npm", ["pack", "--json", "--pack-destination", outDir]), stage);
  return path.join(outDir, (JSON.parse(out) as Array<{ filename: string }>)[0]!.filename);
};

const hostKey = (): NpmPlatform => {
  const key = `${process.platform}-${process.arch}`;
  if (!(NPM_PLATFORMS as ReadonlyArray<string>).includes(key)) throw new Error(`no Caveman Code npm package for ${key}; there are ${NPM_PLATFORMS.join(", ")}`);
  return key as NpmPlatform;
};

export interface Packed {
  /** @caveman-ai/code-<platform>-<arch>, this machine's. */
  readonly platform: string;
  /** @caveman-ai/code, the launcher. */
  readonly launcher: string;
}

/** Bundles the runtime and packs this machine's platform package and the launcher into `outDir`. */
export async function packNpm(outDir: string, version: string): Promise<Packed> {
  const key = hostKey();
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-code-npm-"));
  const launcherStage = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-code-npm-launcher-"));
  try {
    buildWebClient();
    // The runtime reports the package's version (src/runtimeVersion.ts).
    const manifest = await bundleRuntime(stage, undefined, version);
    if (!manifest.client) throw new Error("pack:npm: apps/web/dist has no index.html, so the package would serve no web client");
    // Where src/router/proxyLauncher.ts and provider-caveman's levers look: bin/ beside the bundle.
    await installCavemanBinaries({
      platform: process.platform as CavemanPlatform,
      arch: process.arch === "x64" ? "x64" : "arm64",
      dest: stage,
      cacheDir: path.join(runtimeDir, ".cache/caveman-binaries"),
    });
    // Computer use on a Mac (src/session-protocol/macDesktop): agent-desktop and its helper, in the same bin/.
    if (process.platform === "darwin") await installAgentDesktop({ arch: process.arch === "x64" ? "x64" : "arm64", dest: stage, cacheDir: path.join(runtimeDir, ".cache/agent-desktop") });
    for (const entry of fs.readdirSync(stage)) if (entry.endsWith(".map")) fs.rmSync(path.join(stage, entry));
    const modules = path.join(stage, "node_modules");
    const bundled = fs
      .readdirSync(modules)
      .flatMap((name) => (name.startsWith("@") ? fs.readdirSync(path.join(modules, name)).map((sub) => `${name}/${sub}`) : name.startsWith(".") ? [] : [name]))
      .sort();
    const versionOf = (name: string) => (JSON.parse(fs.readFileSync(path.join(modules, name, "package.json"), "utf8")) as { version: string }).version;
    const name = platformPackage(key);
    const pkg = {
      name,
      version,
      description: `Caveman Code for ${key}: what the caveman-code command of ${LAUNCHER} runs on this platform.`,
      license: "UNLICENSED",
      homepage: HOMEPAGE,
      type: "module",
      os: [process.platform],
      cpu: [process.arch],
      // Its natives (node-pty, the caveman binaries) are built against glibc: npm on musl (Alpine) skips it.
      ...(process.platform === "linux" ? { libc: ["glibc"] } : {}),
      engines: { node: manifest.node },
      // Every package in node_modules at the version on disk: npm keeps a bundled tree only when it is declared.
      dependencies: Object.fromEntries(bundled.map((dep) => [dep, versionOf(dep)])),
      bundleDependencies: bundled,
      publishConfig: { access: "public" },
    };
    fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    fs.writeFileSync(
      path.join(stage, "README.md"),
      readme(name, `Caveman Code for ${key}. Install ${LAUNCHER}, which runs this package as \`caveman-code\`:\n\n    npm install --global ${LAUNCHER}`),
    );

    const launcher = {
      name: LAUNCHER,
      version,
      description: "Caveman Code: `caveman-code` starts or attaches to the Caveman Code runtime on this computer.",
      license: "UNLICENSED",
      homepage: HOMEPAGE,
      bin: { "caveman-code": "bin/caveman-code.mjs" },
      engines: { node: manifest.node },
      optionalDependencies: Object.fromEntries(NPM_PLATFORMS.map((platform) => [platformPackage(platform), version])),
      publishConfig: { access: "public" },
    };
    fs.mkdirSync(path.join(launcherStage, "bin"));
    fs.copyFileSync(path.join(runtimeDir, "scripts/npm-launcher.mjs"), path.join(launcherStage, "bin/caveman-code.mjs"));
    fs.chmodSync(path.join(launcherStage, "bin/caveman-code.mjs"), 0o755);
    fs.writeFileSync(path.join(launcherStage, "package.json"), `${JSON.stringify(launcher, null, 2)}\n`);
    fs.writeFileSync(
      path.join(launcherStage, "README.md"),
      readme(LAUNCHER, `\`caveman-code\` starts or attaches to the Caveman Code runtime on this computer. Builds for ${NPM_PLATFORMS.join(", ")}.\n\n    npm install --global ${LAUNCHER}\n    caveman-code`),
    );

    fs.mkdirSync(outDir, { recursive: true });
    return { platform: npmPack(stage, outDir), launcher: npmPack(launcherStage, outDir) };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(launcherStage, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** The runtime's own caveman-proxy, answering as itself from its home: what the runtime's run state says it started. */
async function proxyAnswering(proxyHome: string): Promise<string | undefined> {
  const runDir = path.join(proxyHome, "run");
  for (const entry of fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((name) => /^\d+\.json$/.test(name)) : []) {
    const token = (JSON.parse(fs.readFileSync(path.join(runDir, entry), "utf8")) as { instance_token?: string }).instance_token;
    const live = await fetch(`http://127.0.0.1:${entry.slice(0, -5)}/health/live`).catch(() => undefined);
    if (token && live?.ok && live.headers.get("x-caveman-instance") === token) return `${((await live.json()) as { service: string }).service} on ${entry.slice(0, -5)}`;
  }
  return undefined;
}

/**
 * Installs both tarballs into a temp prefix, as npm installs the launcher and this machine's platform package,
 * then checks `caveman-code --help`, that the Caveman engine's caveman-engine is installed, and that a bare
 * `caveman-code` starts the runtime, serves the web client, and starts its bundled caveman-proxy (compression
 * and Auto). Stops the runtime as PLAN interface 1 says (processTree.ts).
 */
export async function smokeNpm(packed: Packed): Promise<string> {
  const win = process.platform === "win32";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-code-npm-smoke-"));
  const prefix = path.join(root, "prefix");
  // --offline: the launcher's optional dependencies (unpublished, or another build of this version on the
  // registry) never come from the registry, so what runs is these two files: the launcher finds its platform
  // package beside it in the prefix's node_modules.
  const installing = Date.now();
  run(hostCommand("npm", ["install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", packed.launcher, packed.platform]), root);
  const installed = `npm install ${((Date.now() - installing) / 1000).toFixed(0)} s`;
  // npm's bin shims: a symlink in <prefix>/bin, or <prefix>\caveman-code.cmd on Windows (packages in <prefix>\node_modules).
  const bin = win ? path.join(prefix, "caveman-code.cmd") : path.join(prefix, "bin", "caveman-code");
  const command = (args: ReadonlyArray<string>): HostCommand => (win ? cmdFile(bin, args) : { file: bin, args: [...args], shell: false });
  const help = run(command(["--help"]), root);
  if (!help.includes("caveman code attach")) throw new Error(`caveman-code --help printed: ${help}`);
  const platformDir = path.join(prefix, win ? "" : "lib", "node_modules", platformPackage(hostKey()));
  fs.accessSync(path.join(platformDir, "bin", binaryFile("caveman-engine", process.platform as CavemanPlatform)), fs.constants.X_OK);
  const home = path.join(root, "home");
  const user = path.join(root, "user");
  // The runtime's home, and every place its config could live: HOME, and on Windows the profile folders os.homedir() and apps read.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CAVEMAN_CODE_HOME: home,
    HOME: user,
    ...(win ? { USERPROFILE: user, APPDATA: path.join(user, "AppData", "Roaming"), LOCALAPPDATA: path.join(user, "AppData", "Local") } : {}),
  };
  const start = command([]);
  // detached off Windows: the runtime's group is ours to stop, and only ours.
  const child = spawn(start.file, start.args, { env, shell: start.shell, stdio: ["pipe", "pipe", "pipe"], detached: !win, windowsHide: true });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (output += chunk));
  try {
    const started = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no start within 60 s:\n${output}`)), 60_000);
      const poll = setInterval(() => {
        const line = /started the Caveman Code runtime pid \d+ at \S+/.exec(output)?.[0];
        if (line) (clearTimeout(timer), clearInterval(poll), resolve(line));
      }, 200);
      child.once("exit", (code) => (clearTimeout(timer), clearInterval(poll), reject(new Error(`caveman-code exited ${code}:\n${output}`))));
    });
    const port = /127\.0\.0\.1:(\d+)/.exec(started)![1];
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const title = /<title>([^<]*)<\/title>/.exec(await page.text())?.[1];
    if (page.status !== 200 || title !== "Caveman Code") throw new Error(`the runtime's / answered ${page.status} with title ${title}`);
    let proxy: string | undefined;
    for (let i = 0; i < 100 && proxy === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      proxy = await proxyAnswering(path.join(home, "userdata/proxy"));
    }
    if (proxy === undefined) throw new Error(`the runtime started no caveman-proxy within 20 s:\n${output}`);
    return `${installed} | ${help.trim().split("\n")[0]} | ${started} | / ${page.status} "${title}" | ${proxy} | caveman-engine installed`;
  } finally {
    await stopTree(child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const smoke = args.includes("--smoke");
  const outDir = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? path.join(runtimeDir, "dist-npm"));
  const version = bundleVersion();
  const started = Date.now();
  const packed = await packNpm(outDir, version);
  const size = (file: string) => `${(fs.statSync(file).size / 1e6).toFixed(1)} MB`;
  console.log(`packed ${packed.platform} (${size(packed.platform)}) and ${packed.launcher} (${size(packed.launcher)}) in ${Date.now() - started} ms`);
  if (smoke) console.log(`smoke: ${await smokeNpm(packed)}`);
}
