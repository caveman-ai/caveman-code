// caveman-runtime.tgz unpacks without the monorepo, its launcher starts the
// runtime, and the exec channel a Cloud computer's tools container serves
// runs from the unpacked copy. Packed here for this machine (`--here`); the
// image's Linux pack is the same code in node:24-bookworm-slim.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol/client";
import { afterAll, beforeAll, expect, it } from "vitest";

import { packComputer, versionHere } from "./pack-computer.ts";

// A Cloud computer runs Linux: the pack is a tar with a sh launcher, its runtime talks to tools over a unix socket.
const notOnWindows = process.platform === "win32";
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "caveman-runtime-pack-test-"));
const tgz = path.join(scratch, "caveman-runtime.tgz");
const opt = path.join(scratch, "opt");
const children: Array<ChildProcess> = [];

beforeAll(async () => {
  if (notOnWindows) return;
  const clientDir = path.join(scratch, "client-src");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>pack client</title>\n");
  // No caveman binaries: nothing here runs a chat, and the pack's download of them is the release's to check.
  await packComputer(tgz, { clientDir, epoch: 1_760_000_000, binaries: false });
  fs.mkdirSync(opt);
  expect(spawnSync("tar", ["-xzf", tgz, "-C", opt]).status).toBe(0);
  // No time limit (0): bundling, packing and unpacking some 300 MB takes as long as the machine's load makes it (past
  // three minutes on a busy Mac), and it ends or throws on its own.
}, 0);

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    process.kill(-child.pid!, "SIGTERM");
    await exited;
  }
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

it.skipIf(notOnWindows)("holds the launcher and the bundle, owned by root, nothing else", () => {
  const listing = spawnSync("tar", ["-tvzf", tgz], { encoding: "utf8" }).stdout.trim().split("\n");
  expect(listing.every((line) => / (root|0)[ /]+(root|wheel|0) /.test(line) || /\b0\s+0\b/.test(line)), listing.slice(0, 3).join("\n")).toBe(true);
  expect(fs.readdirSync(opt).sort()).toEqual(["bin", "lib"]);
  expect(fs.statSync(path.join(opt, "bin/caveman-runtime")).mode & 0o111).not.toBe(0);
  // The launcher names this checkout's version, which the runtime's heartbeat tells Cloud: never the package's 0.0.0.
  expect(versionHere()).not.toBe("0.0.0");
  expect(fs.readFileSync(path.join(opt, "bin/caveman-runtime"), "utf8")).toContain(`CAVEMAN_APP_VERSION="\${CAVEMAN_APP_VERSION:-${versionHere()}}"`);
  for (const file of ["bin.mjs", "toolsExec.mjs", "toolsShellEnv.sh", "sandboxLaunch.mjs", "manifest.json", "node_modules/node-pty/package.json", "catalog/.agents/plugins/marketplace.json"])
    expect(fs.existsSync(path.join(opt, "lib", file)), file).toBe(true);
  expect(fs.readdirSync(path.join(opt, "lib")).filter((file) => file.endsWith(".map"))).toEqual([]);
});

it.skipIf(notOnWindows)("starts from the unpacked copy as a computer starts it, every child through the exec channel", async () => {
  // A stand-in tools side: records each request. Git rejects the scratch
  // directory, which is deliberately not a repository, as git does: exit 128
  // and its own message on stderr. Other probes succeed.
  // git, claude and codex arrive pinned: /usr/bin/env PATH=<system first> /usr/bin/git ...
  const requests: Array<ReadonlyArray<string>> = [];
  const program = (argv: ReadonlyArray<string>) => path.basename((argv[0] === "/usr/bin/env" ? argv.slice(1).find((arg) => !arg.includes("=")) : argv[0]) ?? "");
  // toolsExec.mjs wire: [type u8][length u32 BE][payload]; 17 stderr, 18 exit.
  const frame = (type: number, payload: string) => {
    const body = Buffer.from(payload);
    const head = Buffer.alloc(5);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(body.length, 1);
    return Buffer.concat([head, body]);
  };
  const tools = net.createServer((socket) => {
    let header = "";
    socket.on("data", (chunk) => {
      if (header.includes("\n")) return;
      header += chunk.toString();
      if (!header.includes("\n")) return;
      const argv: string[] = JSON.parse(header.slice(0, header.indexOf("\n"))).argv;
      requests.push(argv);
      const isGit = program(argv) === "git";
      socket.end(
        Buffer.concat([
          ...(isGit ? [frame(17, "fatal: not a git repository (or any of the parent directories): .git\n")] : []),
          frame(18, JSON.stringify({ code: isGit ? 128 : 0, signal: null })),
        ]),
      );
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => tools.listen(0, "127.0.0.1", resolve));
  const toolsAddress = `127.0.0.1:${(tools.address() as net.AddressInfo).port}`;
  const port = await freePort();
  const home = path.join(scratch, "home");
  fs.mkdirSync(home);
  const child = spawn(path.join(opt, "bin/caveman-runtime"), ["--port", String(port)], {
    cwd: scratch,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CODEX_HOME: path.join(home, ".codex"),
      CAVEMAN_CODE_HOME: path.join(scratch, "state"),
      CAVEMAN_CODE_NO_BROWSER: "1",
      CAVEMAN_RUNTIME_TOOLS_ADDRESS: toolsAddress,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 60_000;
  let status = 0;
  while (Date.now() < deadline && child.exitCode === null) {
    status = await fetch(`http://127.0.0.1:${port}/.well-known/caveman/environment`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.status, () => 0);
    if (status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(status, output).toBe(200);
  // The launcher runs node with --disable-sigusr1 (no inspector on a signal).
  const args = spawnSync("ps", ["-o", "args=", "-p", String(child.pid)], { encoding: "utf8" }).stdout;
  expect(args).toContain("--disable-sigusr1");
  // An empty runtime has no startup Git work. Request a repository explicitly
  // to prove the protocol's process runner uses the tools side too.
  const token = fs.readFileSync(path.join(scratch, "state", "userdata", "session-protocol.token"), "utf8");
  const client = connect(`ws://127.0.0.1:${port}/session/v1`, token);
  try {
    // A folder in no repository: git says so, and it is added as a plain folder.
    await expect(client.call("project.create", { request_id: "pack-git-probe", path: scratch })).resolves.toMatchObject({ no_git: true });
    const gits = requests.filter((argv) => program(argv) === "git");
    expect(gits.some((argv) => argv.includes("rev-parse") && argv.includes("--show-toplevel"))).toBe(true);
    // The image's git, with the system directories first: a git in the tools home never stands in.
    expect(gits.every((argv) => argv[0] === "/usr/bin/env" && argv[1]!.startsWith("PATH=/usr/local/sbin:") && argv.includes("/usr/bin/git")), JSON.stringify(gits[0])).toBe(true);
    // The Claude Agent CLI probe uses the engine driver above the HTTP layer.
    const seen = () => new Set(requests.map(program));
    const deadline2 = Date.now() + 30_000;
    while (!seen().has("claude") && Date.now() < deadline2) await new Promise((resolve) => setTimeout(resolve, 250));
    expect([...seen()], output).toEqual(expect.arrayContaining(["git", "claude"]));
  } finally {
    client.close();
    tools.close();
  }
}, 90_000);

it.skipIf(notOnWindows)("serves the exec channel from the unpacked copy, on loopback as a computer pod does", async () => {
  const socket = `127.0.0.1:${await freePort()}`;
  const server = spawn(process.execPath, [path.join(opt, "lib/toolsExec.mjs"), "serve", socket], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  children.push(server);
  const run = (argv: ReadonlyArray<string>, stdin: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [path.join(opt, "lib/toolsExec.mjs"), "exec", "--socket", socket, "--cwd", scratch, "--", ...argv], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, CAVEMAN_RUNTIME_TOOLS_ENV: Buffer.from(JSON.stringify(env)).toString("base64") },
    });
  // The client waits for a socket that is not there yet.
  const result = run(["sh", "-c", 'echo "out $PWD $X"; echo err >&2; cat; exit 3'], "from stdin", { X: "delta" });
  expect([result.status, result.stdout, result.stderr]).toEqual([3, `out ${scratch} delta\nfrom stdin`, "err\n"]);
  const missing = run(["no-such-command-here"], "");
  expect([missing.status, missing.stderr]).toEqual([127, "toolsExec: no-such-command-here: not found\n"]);
  const killed = run(["sh", "-c", "kill -TERM $$"], "");
  expect(killed.status).toBe(128 + os.constants.signals.SIGTERM);
});

// Audit R1: the computer image's release start check runs the unpacked launcher's self-check. A pack whose native addon
// cannot load (here node-pty's, truncated) fails it by name, before the runtime would start on any computer.
it.skipIf(notOnWindows)("the unpacked launcher's self-check loads the natives, and names node-pty when its addon is broken", () => {
  const selfCheck = () =>
    spawnSync(path.join(opt, "bin/caveman-runtime"), ["self-check"], { cwd: scratch, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, HOME: path.join(scratch, "self-check-home") } });
  const ok = selfCheck();
  expect(ok.status, ok.stderr).toBe(0);
  expect(ok.stdout).toMatch(/^caveman-runtime: self-check ok: node v\d+\.\d+\.\d+ \S+; natives node-pty, @ff-labs\/fff-node, @napi-rs\/keyring, onnxruntime-node, node-datachannel/);
  const addon = path.join(opt, "lib/node_modules/node-pty/prebuilds", `${process.platform}-${process.arch}`, "pty.node");
  // A new file in its place: macOS kills a process that maps a signed binary rewritten in place.
  fs.renameSync(addon, `${addon}.saved`);
  try {
    fs.writeFileSync(addon, fs.readFileSync(`${addon}.saved`).subarray(0, 4096));
    const broken = selfCheck();
    expect(broken.status, broken.stderr).toBe(1);
    expect(broken.stderr).toMatch(/^caveman-runtime: self-check failed: node-pty: /m);
  } finally {
    fs.renameSync(`${addon}.saved`, addon);
  }
});
