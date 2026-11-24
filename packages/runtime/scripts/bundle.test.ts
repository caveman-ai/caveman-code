// The bundle runs on its own: built into a temp dir outside the repo, it
// starts in desktop mode from upstream bootstrap envelope on fd 3, answers
// engine.list over Session Protocol (its bootstrap token and its token file
// alike), serves the web client at /, and loads node-pty from its own
// node_modules. It reports the version it was bundled with everywhere it says
// which build it is. Every home and config dir is a temp dir.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";

import { DatabaseSync } from "node:sqlite";

import { PROTOCOL_REVISION } from "@caveman-app/session-protocol";
import { connect } from "@caveman-app/session-protocol/client";
import { afterAll, beforeAll, expect, it } from "vitest";

import { bundleRuntime, type RuntimeManifest } from "./bundle.ts";
import { stopTree } from "./processTree.ts";

const win = process.platform === "win32";
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";

/**
 * Runs `script` on this Node in a child process, with `load(name)` requiring from the bundle's own node_modules. Native
 * addons load there, not in the test process: Windows keeps a loaded addon's files until its process exits, which would
 * leave the temp dir behind.
 */
const inChildNode = (script: string) =>
  spawnSync(process.execPath, ["-e", `const load = require("node:module").createRequire(process.argv[1]);\n${script}`, path.join(outDir, "bin.mjs")], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 60_000,
  });

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "caveman-runtime-bundle-"));
/** What CAVEMAN_APP_VERSION would make it (a nightly's). */
const VERSION = "9.8.7-nightly.20261110.4";
const outDir = path.join(scratch, "runtime");
let manifest: RuntimeManifest;
let child: ChildProcess | undefined;

beforeAll(async () => {
  const clientDir = path.join(scratch, "client-src");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>bundle client</title>\n");
  manifest = await bundleRuntime(outDir, clientDir, VERSION);
}, 120_000);

afterAll(async () => {
  // With everything it started (the engine probes: claude, codex), as the desktop stops it.
  if (child !== undefined) await stopTree(child);
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    // Windows keeps a directory a live process works in or holds a file of: name what outlived the runtime.
    if (win) {
      const filter = `$_.CommandLine -like '*${path.basename(scratch)}*' -or $_.Name -like 'caveman-*'`;
      const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | Where-Object { ${filter} } | Format-List ProcessId,ParentProcessId,CommandLine`], { encoding: "utf8" });
      console.error(`still running from ${scratch}:\n${ps.stdout}`);
    }
    throw error;
  }
});

it("lists node-pty as native and the Claude Agent CLI as spawned", () => {
  const nodePty = manifest.externals.find((pkg) => pkg.name === "node-pty");
  expect(nodePty?.native).toContain(`prebuilds/${process.platform}-${process.arch}/${win ? "conpty.node" : "pty.node"}`);
  expect(manifest.spawned).toContainEqual(expect.objectContaining({ name: "claude", engine: "claudeAgent", shipped: false }));
  expect(manifest.client).toBe(true);
  // The computer image's entrypoint starts a warm pod's runtime before its claim only when it says so.
  expect(manifest.features).toEqual(expect.arrayContaining(["link-wait", "link-bootstrap"]));
  // Its release start check runs the runtime's self-check first when the manifest names it.
  expect(manifest.features).toContain("self-check");
  expect(JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))).toEqual(manifest);
  for (const pkg of manifest.externals) expect(fs.existsSync(path.join(outDir, pkg.path, "package.json"))).toBe(true);
  // The Caveman engine loads workers beside its own files, so it ships whole.
  expect(manifest.externals).toContainEqual(expect.objectContaining({ name: "@caveman-ai/agent", path: "node_modules/@caveman-ai/agent" }));
});

it("says the version it was bundled with: --version and its manifest", () => {
  expect(manifest.version).toBe(VERSION);
  const result = spawnSync(process.execPath, [path.join(outDir, "bin.mjs"), "--version"], { cwd: scratch, encoding: "utf8", timeout: 60_000 });
  expect(result.stdout.trim(), result.stderr).toBe(`caveman-runtime v${VERSION}`);
});

it("ships ONNX Runtime for this platform only, with no install script to download CUDA", () => {
  const onnx = path.join(outDir, "node_modules/onnxruntime-node");
  expect(fs.readdirSync(path.join(onnx, "bin/napi-v6"))).toEqual([process.platform]);
  expect(fs.readdirSync(path.join(onnx, `bin/napi-v6/${process.platform}`))).toEqual([process.arch]);
  expect(JSON.parse(fs.readFileSync(path.join(onnx, "package.json"), "utf8")).scripts).toBeUndefined();
  // Chat search loads it from the bundle's own node_modules (in a child Node: see inChildNode).
  expect(inChildNode(`process.stdout.write(typeof load("onnxruntime-node").InferenceSession.create)`).stdout).toBe("function");
});

it("carries the license of every package it inlined", () => {
  const licenses = fs.readFileSync(path.join(outDir, "THIRD_PARTY_LICENSES.txt"), "utf8");
  expect(licenses).toMatch(/^==== effect@4\.1\.2 \(MIT\) ====$/m);
  // CommonJS imported from ESM sits in its importer's region: only the source map names it.
  expect(licenses).toMatch(/^==== saxes@6\.0\.0 \(ISC\) ====$/m);
  expect(licenses).not.toMatch(/^==== node-pty@/m); // external: keeps its own LICENSE
  expect(fs.existsSync(path.join(outDir, "node_modules/node-pty/LICENSE"))).toBe(true);
  expect(fs.readFileSync(path.join(outDir, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain("T3");
});

it("reads an attached document's text in the bundle's own child process", () => {
  const document = path.join(scratch, "cargo.rtf");
  fs.writeFileSync(document, String.raw`{\rtf1 Violet crates: 19}`);
  const result = spawnSync(process.execPath, [path.join(outDir, "bin.mjs"), "__document-text", document, ".rtf"], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("Violet crates: 19");
  expect(result.status).toBe(0);
});

it("ships minified chunks that keep the hashbang and point at their source maps", () => {
  const bin = fs.readFileSync(path.join(outDir, "bin.mjs"), "utf8");
  expect(bin.startsWith("#!/usr/bin/env node\n")).toBe(true);
  expect(bin.trimEnd().endsWith("//# sourceMappingURL=bin.mjs.map")).toBe(true);
  // Windows files have no execute bit.
  if (!win) expect(fs.statSync(path.join(outDir, "bin.mjs")).mode & 0o111).not.toBe(0);
  const chunks = fs.readdirSync(outDir).filter((name) => name.endsWith(".mjs") && name.includes("-"));
  expect(chunks.length).toBeGreaterThan(0);
  for (const name of chunks) expect(fs.readFileSync(path.join(outDir, name), "utf8")).not.toContain("//#region");
  expect(JSON.parse(fs.readFileSync(path.join(outDir, "bin.mjs.map"), "utf8")).version).toBe(3);
});

it("names no path in the repo", () => {
  const repo = Buffer.from(path.resolve(import.meta.dirname, "../../.."));
  // Source maps are left out: built outside the repo, their relative `sources` climb through it. The app drops them.
  const files = fs
    .readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".map"));
  const leaks = files.map((entry) => path.join(entry.parentPath, entry.name)).filter((file) => fs.readFileSync(file).includes(repo));
  expect(leaks.map((file) => path.relative(outDir, file))).toEqual([]);
});

// The computer image's release start check (Caveman Cloud caveman-computer check) runs `self-check` when the manifest names
// it: the module graph and every native library staged for this platform must load, or the release fails (audit R1).
it.skipIf(win)("self-check loads every native library the bundle staged for this platform", () => {
  const selfCheck = () => spawnSync(process.execPath, [path.join(outDir, "bin.mjs"), "self-check"], { cwd: scratch, encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: scratch } });
  const ok = selfCheck();
  expect(ok.status, ok.stderr).toBe(0);
  expect(ok.stdout).toMatch(new RegExp(`^caveman-runtime: self-check ok: node ${process.version} ${process.platform}-${process.arch}; natives node-pty, @ff-labs/fff-node, @napi-rs/keyring, onnxruntime-node, node-datachannel[^;]*; [1-9][0-9]* staged libraries loaded; [0-9]+ ms\n$`));
  // A package staged with a library for this platform that nothing loads fails it, by name.
  const original = fs.readFileSync(path.join(outDir, "manifest.json"), "utf8");
  const fake = path.join(outDir, "node_modules", "fake-native");
  const pty = manifest.externals.find((pkg) => pkg.name === "node-pty")!.native.find((file) => file.startsWith(`prebuilds/${process.platform}-${process.arch}/`) && file.endsWith(".node"))!;
  fs.mkdirSync(fake, { recursive: true });
  fs.copyFileSync(path.join(outDir, "node_modules/node-pty", pty), path.join(fake, "unreached.node"));
  try {
    // On Linux a package built for the other libc (pnpm stages ...-musl beside ...-gnu) is never loaded, and not asked for.
    const otherLibc = process.platform === "linux" ? [{ name: `fake-native-${process.platform}-${process.arch}-musl`, version: "1.0.0", path: "node_modules/fake-native", native: ["unreached.node"] }] : [];
    const extended = { ...manifest, externals: [...manifest.externals, ...otherLibc, { name: "fake-native", version: "1.0.0", path: "node_modules/fake-native", native: ["unreached.node"] }] };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(extended));
    const unreached = selfCheck();
    expect(unreached.status).toBe(1);
    expect(unreached.stderr).toContain(`caveman-runtime: self-check failed: fake-native: unreached.node is staged for ${process.platform}-${process.arch} but was not loaded\n`);
  } finally {
    fs.writeFileSync(path.join(outDir, "manifest.json"), original);
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

it("loads node-pty from the bundle's own node_modules", () => {
  // A pty can report the exit before its last output, so the child waits for both. cmd.exe by its full path: node-pty's
  // own PATH search skips PATH's last entry.
  const result = inChildNode(`
    const win = process.platform === "win32";
    const root = process.env.SystemRoot || "C:\\\\Windows";
    const term = win
      ? load("node-pty").spawn(root + "\\\\System32\\\\cmd.exe", ["/d", "/c", "echo pty-ok"], { env: { SystemRoot: root, PATH: root + "\\\\System32" } })
      : load("node-pty").spawn("/bin/echo", ["pty-ok"], { env: { PATH: "/usr/bin:/bin" } });
    let output = "", code;
    const done = () => output.includes("pty-ok") && code !== undefined && (console.log("pty-ok, exit " + code), process.exit(0));
    term.onData((data) => ((output += data), done()));
    term.onExit(({ exitCode }) => ((code = exitCode), done()));`);
  expect(result.stdout.trim(), result.stderr).toBe("pty-ok, exit 0");
});

it("starts from the unpacked copy and answers engine.list", async () => {
  const port = await new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
  const token = randomBytes(32).toString("hex");
  const home = path.join(scratch, "home");
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    // Windows: what any process needs there, and the profile folders os.homedir() and apps read, in the temp home.
    ...(win
      ? {
          SystemRoot: systemRoot,
          windir: systemRoot,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          USERPROFILE: home,
          APPDATA: path.join(home, "AppData", "Roaming"),
          LOCALAPPDATA: path.join(home, "AppData", "Local"),
        }
      : {}),
  };
  child = spawn(process.execPath, [path.join(outDir, "bin.mjs"), "--bootstrap-fd", "3"], {
    cwd: scratch,
    env,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    // Its own process group to stop (processTree.ts); Windows stops the tree with taskkill instead.
    detached: !win,
    windowsHide: true,
  });
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  (child.stdio[3] as Writable).end(
    `${JSON.stringify({ mode: "desktop", noBrowser: true, host: "127.0.0.1", port, t3Home: path.join(scratch, "state"), desktopBootstrapToken: token })}\n`,
  );
  const exited = new Promise<never>((_, reject) =>
    child!.once("exit", (code) => reject(new Error(`runtime exited ${code}: ${output}`))),
  );
  const timedOut = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`runtime not ready within 60 s: ${output}`)), 60_000),
  );
  // Connect at once: an upgrade before the runtime serves gets a 503 and the client retries.
  const client = connect(`ws://127.0.0.1:${port}/session/v1`, token);
  const hello = new Promise<void>((resolve) => client.onHello(() => resolve()));
  const engines = await Promise.race([client.call("engine.list", {}).then(async (answer) => (await hello, answer)), exited, timedOut]).finally(() => client.close());
  expect(engines.engines.map((engine) => engine.id), output).toEqual(expect.arrayContaining(["caveman", "codex", "claude-agent"]));
  // Which build answers: runtime.hello (the client's first call), server-runtime.json, and the database's record of
  // the last build to open it at its newest migration (an older build's refusal names it).
  expect(client.hello()).toEqual({ version: VERSION, protocol_revision: PROTOCOL_REVISION, min_client_revision: 0, capabilities: [] });
  const userdata = path.join(scratch, "state", "userdata");
  expect(JSON.parse(fs.readFileSync(path.join(userdata, "server-runtime.json"), "utf8"))).toMatchObject({ version: 1, serverVersion: VERSION });
  const db = new DatabaseSync(path.join(userdata, "statev2.sqlite"), { readOnly: true });
  try {
    expect(db.prepare("SELECT version FROM caveman_database_writers").all()).toEqual([{ version: VERSION }]);
  } finally {
    db.close();
  }
  // `caveman code` attaches to a desktop-started runtime with the token file.
  const fileToken = fs.readFileSync(path.join(scratch, "state", "userdata", "session-protocol.token"), "utf8");
  const local = connect(`ws://127.0.0.1:${port}/session/v1`, fileToken);
  const answered = await Promise.race([local.call("engine.list", {}), exited, timedOut]).finally(() => local.close());
  expect(answered.engines.length).toBe(engines.engines.length);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  expect(await page.text()).toContain("<title>bundle client</title>");
  // Opened from a link whose fragment carries a token: never cached, never sent on as a referrer.
  expect([page.headers.get("cache-control"), page.headers.get("referrer-policy")]).toEqual(["no-store", "no-referrer"]);
}, 90_000);
