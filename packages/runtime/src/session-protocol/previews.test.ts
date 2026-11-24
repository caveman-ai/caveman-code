// A chat's preview server (previews.ts) on real processes: it starts in the worktree on the port it is given, a
// second open reuses it, Stop and the idle sweep end its whole process group (a child it started included), a
// server that exits or never listens says why with its output, and a runtime killed with servers still running
// stops them at its next start.
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { listening, makePreviewServers, previewUrl, withPort } from "./previews.ts";

const posix = process.platform !== "win32";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "previews-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const systemPort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
/** A port free on IPv4 loopback that nothing holds on IPv6 either (another program's [::]:port would answer the probe). */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await systemPort();
    if (!(await listening(port))) return port;
  }
}

/** A worktree whose server.js answers its folder's name on $PORT, and whose keeper.js idles, writing its pid. */
function worktree(name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "server.js"),
    `require("node:http").createServer((q, r) => r.end(${JSON.stringify(name)} + " " + q.url)).listen(Number(process.env.PORT), "127.0.0.1");\n`,
  );
  fs.writeFileSync(
    path.join(dir, "keeper.js"),
    `require("node:fs").writeFileSync("keeper.pid", String(process.pid)); setInterval(() => {}, 1000);\n`,
  );
  return dir;
}

const get = (url: string) =>
  new Promise<string>((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("the address: the port and path, or the one its command announced when it is this computer's", () => {
  expect(previewUrl(4100, "/")).toBe("http://localhost:4100/");
  expect(previewUrl(4100, "settings")).toBe("http://localhost:4100/settings");
  expect(
    previewUrl(4100, "/", "http://localhost:4100/?runtime=ws://127.0.0.1:9/session/v1#token=t"),
  ).toBe("http://localhost:4100/?runtime=ws://127.0.0.1:9/session/v1#token=t");
  // Another host is never opened from a command's output.
  expect(previewUrl(4100, "/a", "https://evil.example/")).toBe("http://localhost:4100/a");
  expect(withPort("vite --port {port} --strictPort", 4100)).toBe("vite --port 4100 --strictPort");
});

describe.runIf(posix)("on real processes", () => {
  test("starts in the worktree on its port, reuses itself, and Stop ends its whole group", async () => {
    const stateDir = path.join(root, "state-a");
    const stopped: Array<string> = [];
    const servers = makePreviewServers({ stateDir, onStopped: (id) => stopped.push(id) });
    const cwd = worktree("alpha");
    const port = await freePort();
    const spec = {
      workspaceId: "w-a",
      cwd,
      command: "node keeper.js & node server.js",
      path: "/hello",
      port,
      env: {},
    };

    // Two clicks at once start one server.
    const [first, second] = await Promise.all([servers.open(spec), servers.open(spec)]);
    expect(first).toEqual({ url: `http://localhost:${port}/hello`, started: true });
    expect(second).toEqual(first);
    expect(await get(first.url)).toBe("alpha /hello");
    expect(servers.running("w-a")).toBe(true);
    await until(() => fs.existsSync(path.join(cwd, "keeper.pid")));
    const keeper = Number(fs.readFileSync(path.join(cwd, "keeper.pid"), "utf8"));
    expect(alive(keeper)).toBe(true);
    // The ledger names it, for a runtime that dies before stopping it.
    expect(
      Object.keys(JSON.parse(fs.readFileSync(path.join(stateDir, "preview-servers.json"), "utf8"))),
    ).toEqual(["w-a"]);

    expect(await servers.open(spec)).toEqual({ url: first.url, started: false });

    expect(await servers.stop("w-a")).toBe(true);
    expect(await listening(port)).toBe(false);
    // The child it started in the background goes with it: the group, not the leader.
    await until(() => !alive(keeper));
    expect(servers.running("w-a")).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "preview-servers.json"))).toBe(false);
    // Stopped by Stop: not a server that ended by itself.
    expect(stopped).toEqual([]);
    expect(await servers.stop("w-a")).toBe(false);
  });

  test("something already on its port is opened as it is, and never stopped as ours", async () => {
    const port = await freePort();
    const theirs = http.createServer((_q, r) => r.end("theirs")).listen(port, "127.0.0.1");
    await new Promise((r) => theirs.once("listening", r));
    const servers = makePreviewServers({ stateDir: path.join(root, "state-b") });
    const opened = await servers.open({
      workspaceId: "w-b",
      cwd: worktree("beta"),
      command: "node server.js",
      path: "/",
      port,
      env: {},
    });
    expect(opened).toEqual({ url: `http://localhost:${port}/`, started: false });
    expect(servers.running("w-b")).toBe(false);
    expect(await servers.stop("w-b")).toBe(false);
    expect(await get(opened.url)).toBe("theirs");
    theirs.close();
  });

  test("a command that exits, or never listens, says so with its output and leaves nothing running", async () => {
    const servers = makePreviewServers({
      stateDir: path.join(root, "state-c"),
      readyTimeoutMs: 1_500,
    });
    const cwd = worktree("gamma");
    const port = await freePort();
    await expect(
      servers.open({
        workspaceId: "w-c",
        cwd,
        command: "echo missing script >&2; exit 3",
        path: "/",
        port,
        env: {},
      }),
    ).rejects.toThrow(/exited \(code 3\) before it listened.*\n.*missing script/s);
    expect(servers.running("w-c")).toBe(false);

    const deaf = await freePort();
    await expect(
      servers.open({
        workspaceId: "w-c",
        cwd,
        command: "node keeper.js",
        path: "/",
        port: deaf,
        env: {},
      }),
    ).rejects.toThrow(/did not listen on port \d+ within 2 s/);
    const keeper = Number(fs.readFileSync(path.join(cwd, "keeper.pid"), "utf8"));
    await until(() => !alive(keeper));
    expect(servers.running("w-c")).toBe(false);
  });

  test("failure output keeps the first diagnosis and recovery, bounded across chunks and long lines", async () => {
    const servers = makePreviewServers({ stateDir: path.join(root, "state-output") });
    const cwd = worktree("output");
    const port = await freePort();
    const failWith = async (text: string) => {
      fs.writeFileSync(path.join(cwd, "failure.txt"), text);
      fs.writeFileSync(
        path.join(cwd, "fail.js"),
        `const fs = require("node:fs"); const text = fs.readFileSync("failure.txt", "utf8"); let i = 0; const timer = setInterval(() => { process.stderr.write(text.slice(i, i += 317)); if (i >= text.length) { clearInterval(timer); process.exitCode = 1; } }, 1);`,
      );
      const command = "node fail.js";
      try {
        await servers.open({ workspaceId: "output", cwd, command, path: "/", port, env: {} });
        throw new Error("expected failure");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(`exited (code 1) before it listened on port ${port}.`);
        return message.slice(message.indexOf("\n") + 1);
      }
    };
    expect(await failWith("header\n  - missing file\nRestore file\nOpen preview again.\n")).toBe(
      "header\n  - missing file\nRestore file\nOpen preview again.",
    );
    const lines = Array.from({ length: 31 }, (_, i) => `issue ${i}`);
    expect(await failWith(lines.join("\n") + "\n")).toBe(
      [...lines.slice(0, 7), "… 16 lines omitted …", ...lines.slice(-8)].join("\n"),
    );
    const noisy = Array.from({ length: 200 }, (_, i) => `issue ${i}: ${"x".repeat(80)}`);
    const bounded = await failWith(
      noisy.join("\n") + "\nRestore missing files\nOpen preview again.\n",
    );
    expect(bounded).toContain(noisy[0]);
    expect(bounded).toContain("… 187 lines omitted …");
    expect(bounded).toContain("Restore missing files\nOpen preview again.");
    expect(bounded.length).toBeLessThanOrEqual(4_000);
    const longLine = await failWith("diagnosis " + "x".repeat(10_000) + " recovery");
    expect(longLine.startsWith("diagnosis ")).toBe(true);
    expect(longLine.endsWith(" recovery")).toBe(true);
    expect(longLine.length).toBeLessThanOrEqual(4_000);
    const longIssue = await failWith("diagnosis " + "x".repeat(10_000) + "\nRestore files\n");
    expect(longIssue.startsWith("diagnosis ")).toBe(true);
    expect(longIssue.endsWith("Restore files")).toBe(true);
    expect(longIssue.length).toBeLessThanOrEqual(4_000);
    const tight = await failWith("x".repeat(3_895) + "\nshort".repeat(15));
    expect(tight.length).toBeLessThanOrEqual(4_000);
  });

  test("{port} and $PORT both reach the command; an announced address is what opens", async () => {
    const servers = makePreviewServers({ stateDir: path.join(root, "state-d") });
    const cwd = worktree("delta");
    const port = await freePort();
    const announce = `echo CAVEMAN_PREVIEW_URL=http://localhost:{port}/?token=abc; PORT={port} node server.js`;
    const opened = await servers.open({
      workspaceId: "w-d",
      cwd,
      command: announce,
      path: "/",
      port,
      env: {},
    });
    expect(opened.url).toBe(`http://localhost:${port}/?token=abc`);
    expect(await get(opened.url)).toBe("delta /?token=abc");
    // Opened again, it is still the announced address.
    expect(
      (await servers.open({ workspaceId: "w-d", cwd, command: announce, path: "/", port, env: {} }))
        .url,
    ).toBe(opened.url);
    await servers.stopAll();
    expect(await listening(port)).toBe(false);
  });

  test("another command for the same chat stops the old server first", async () => {
    const servers = makePreviewServers({ stateDir: path.join(root, "state-e") });
    const cwd = worktree("epsilon");
    const port = await freePort();
    await servers.open({
      workspaceId: "w-e",
      cwd,
      command: "node server.js",
      path: "/",
      port,
      env: {},
    });
    const next = await servers.open({
      workspaceId: "w-e",
      cwd,
      command: "node  server.js",
      path: "/",
      port,
      env: {},
    });
    expect(next.started).toBe(true);
    expect(await get(next.url)).toBe("epsilon /");
    await servers.stopAll();
  });

  test("the sweep stops a server nobody opened for the idle time, and keeps one a tab is still connected to", async () => {
    let clock = 1_000_000;
    const stopped: Array<string> = [];
    const servers = makePreviewServers({
      stateDir: path.join(root, "state-f"),
      idleMs: 60_000,
      now: () => clock,
      onStopped: (id) => stopped.push(id),
    });
    const cwd = worktree("zeta");
    const port = await freePort();
    await servers.open({
      workspaceId: "w-f",
      cwd,
      command: "node server.js",
      path: "/",
      port,
      env: {},
    });
    clock += 30_000;
    expect(await servers.sweep()).toEqual([]);
    // A tab holding a connection open (a dev server's HMR socket) counts as use.
    const tab = net.connect({ host: "127.0.0.1", port });
    await new Promise((r) => tab.once("connect", r));
    clock += 60_000;
    expect(await servers.sweep()).toEqual([]);
    expect(servers.running("w-f")).toBe(true);
    tab.destroy();
    await new Promise((r) => setTimeout(r, 200));
    clock += 61_000;
    expect(await servers.sweep()).toEqual(["w-f"]);
    expect(stopped).toEqual(["w-f"]);
    expect(await listening(port)).toBe(false);
  });

  test("a server that ends by itself is forgotten, and the next open starts it again", async () => {
    const stopped: Array<string> = [];
    const servers = makePreviewServers({
      stateDir: path.join(root, "state-g"),
      onStopped: (id) => stopped.push(id),
    });
    const cwd = worktree("eta");
    const port = await freePort();
    fs.writeFileSync(
      path.join(cwd, "brief.js"),
      `require("node:http").createServer((q, r) => r.end("brief")).listen(Number(process.env.PORT), "127.0.0.1"); setTimeout(() => process.exit(0), 400);\n`,
    );
    await servers.open({
      workspaceId: "w-g",
      cwd,
      command: "node brief.js",
      path: "/",
      port,
      env: {},
    });
    await until(() => stopped.length === 1);
    expect(servers.running("w-g")).toBe(false);
    expect(
      (
        await servers.open({
          workspaceId: "w-g",
          cwd,
          command: "node server.js",
          path: "/",
          port,
          env: {},
        })
      ).started,
    ).toBe(true);
    await servers.stopAll();
  });

  test("a runtime killed with servers running stops them at its next start, and only the processes it started", async () => {
    const stateDir = path.join(root, "state-h");
    const dead = makePreviewServers({ stateDir });
    const cwd = worktree("theta");
    const port = await freePort();
    await dead.open({
      workspaceId: "w-h",
      cwd,
      command: "node keeper.js & node server.js",
      path: "/",
      port,
      env: {},
    });
    await until(() => fs.existsSync(path.join(cwd, "keeper.pid")));
    const keeper = Number(fs.readFileSync(path.join(cwd, "keeper.pid"), "utf8"));
    // A stale entry whose pid now belongs to someone else (this test runner) is left alone.
    const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, "preview-servers.json"), "utf8"));
    fs.writeFileSync(
      path.join(stateDir, "preview-servers.json"),
      JSON.stringify({
        ...ledger,
        other: { pid: process.pid, port: 1, started: "Thu Jan  1 00:00:00 1970" },
      }),
    );

    // The next runtime, on the same state folder; the first never stopped anything.
    const next = makePreviewServers({ stateDir });
    expect(await next.reapOrphans()).toBe(1);
    expect(await listening(port)).toBe(false);
    await until(() => !alive(keeper));
    expect(fs.existsSync(path.join(stateDir, "preview-servers.json"))).toBe(false);
  });
});
