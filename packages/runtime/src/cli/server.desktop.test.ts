// The desktop starts the runtime with --bootstrap-fd and holds its stdin open;
// when the desktop quits or dies, stdin hits EOF and the runtime must stop as on
// SIGTERM, through its finalizers: exit 0 and leave no child behind (on Windows
// too, where signalling itself would be TerminateProcess and run none of them).
// Its descriptor comes once the keychain has unsealed the Mac's agents key, after
// Electron's `ready`: maybe well after the runtime is ready to read it.
import { execFileSync, spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "@caveman-app/session-protocol/client";
import { expect, test } from "vitest";

import { descendantsOf } from "../testUtils/processTree.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a runtime started by the desktop takes its descriptor and agents key however late they come, answers engine.list, and its stdin closing stops it and its children", { timeout: 180_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-desktop-eof-"));
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo);
  const git = (...args: Array<string>) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", windowsHide: true });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "xdg") };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  const token = "desktop-token";
  const child = spawn(process.execPath, ["--disable-sigusr1", BIN, "--bootstrap-fd", "3"], { env, stdio: ["pipe", "ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  let client: ReturnType<typeof connect> | undefined;
  try {
 // Written well after the runtime starts to read it (startupTrace's "modules loaded"), past upstream 1 s wait.
    const deadlineLoaded = Date.now() + 120_000;
    while (!stderr.includes("startup: modules loaded") && Date.now() < deadlineLoaded) await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const agentsKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const fd3 = child.stdio[3] as NodeJS.WritableStream;
    fd3.end(`${JSON.stringify({ mode: "desktop", noBrowser: true, host: "127.0.0.1", port, t3Home: path.join(home, "state"), desktopBootstrapToken: token, agentsKey })}\n`);
    const deadline = Date.now() + 120_000;
    let status = 0;
    // Before it serves, the port answers 503 with Retry-After (rejectRequestsUntilServing): ask again, as the desktop does.
    while ((status === 0 || status === 503) && Date.now() < deadline) {
      status = await fetch(`http://127.0.0.1:${port}/session/v1`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status, () => 0);
      if (status === 0 || status === 503) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(status).toBe(401);

    // It answers as the desktop asks, well within the desktop's wait.
    client = connect(`ws://127.0.0.1:${port}/session/v1`, token);
    const asked = Date.now();
    const { engines } = await client.call("engine.list", {});
    expect(Date.now() - asked).toBeLessThan(10_000);
    expect(engines.map((e) => e.id)).toEqual(expect.arrayContaining(["claude-agent", "codex"]));
    // The agents key it signs mail to the person's other Macs with: the descriptor's.
    const { agents } = await client.call("device.agents", {});
    expect(agents?.public_key.x).toBe(createPublicKey(agentsKey).export({ format: "jwk" }).x);

    // A child of its own: a terminal's shell.
    const workspace = await client.call("workspace.create", { request_id: "eof-w", repo: { path: repo } });
    await client.call("term.open", { request_id: "eof-t", workspace_id: workspace.id, cols: 80, rows: 24 });
    let before: Array<string> = [];
    for (let i = 0; i < 50 && before.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Windows gives every console process a conhost; it goes with the runtime and proves nothing.
      before = descendantsOf(child.pid!).filter((row) => !/conhost/i.test(row));
    }
    expect(before.length).toBeGreaterThan(0);
    client.close();
    client = undefined;

    child.stdin!.end();
    const outcome = await Promise.race([exited, new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 30_000))]);
    expect(outcome, stderr.slice(-3000)).toEqual({ code: 0, signal: null });
    let left = before;
    for (let i = 0; i < 25 && left.length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      left = left.filter((row) => alive(Number(row.split(" ")[0])));
    }
    expect(left).toEqual([]);
  } finally {
    client?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
