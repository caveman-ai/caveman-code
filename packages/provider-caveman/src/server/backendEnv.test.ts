/**
 * BackendEnv (the harness's ExecEnv over the runtime's ExecutionBackend) against real backends, no mocks: the SDK's
 * localExecutionBackend in a temp dir, and the SDK's httpExecutionBackend against a small local server that speaks the
 * backend HTTP contract (execution-backend.js) by running the same local backend. Then a real HarnessSession from the
 * vendored harness on the app's Claude loadout, its tools running through a BackendEnv, with only the model scripted.
 *
 * What BackendEnv cannot do that LocalEnv does (the backend has no streaming and no background processes) is asserted
 * as such: a yield returns no output so far, the whole output comes when the call ends.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import type * as Harness from "@caveman-ai/harness";
import {
  httpExecutionBackend,
  localExecutionBackend,
  type ExecutionBackend,
} from "@caveman-ai/agent/execution-backend";
import { fauxModel, scriptedStream } from "@caveman-ai/agent/testing";

import { BackendEnv } from "./backendEnv.ts";

const text = (data: Uint8Array) => Buffer.from(data).toString("utf8");

/** The backend HTTP contract (execution-backend.js's header) served by the SDK's local backend: /exec, /cancel, /read, /write. */
async function httpBackendServer(
  token: string,
): Promise<{ readonly url: string; readonly server: Server; readonly calls: string[] }> {
  const local = localExecutionBackend();
  const running = new Map<string, AbortController>();
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status: number, body: unknown) => {
        if (response.destroyed) return;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${token}`) return send(401, {});
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
      calls.push(request.url ?? "");
      void (async () => {
        switch (request.url) {
          case "/exec": {
            const controller = new AbortController();
            running.set(body.execId, controller);
            try {
              const { execId: _execId, ...exec } = body;
              return send(200, await local.exec({ ...(exec as any), signal: controller.signal }));
            } finally {
              running.delete(body.execId);
            }
          }
          case "/cancel":
            running.get(body.execId)?.abort();
            return send(200, {});
          case "/read":
            try {
              const data = await local.readFile(
                body.path,
                body.maxBytes === undefined ? undefined : { maxBytes: body.maxBytes },
              );
              return send(200, { data: Buffer.from(data).toString("base64") });
            } catch (error) {
              const code = (error as { code?: string }).code;
              return send(code === "ENOENT" ? 404 : code === "EISDIR" ? 422 : 500, {});
            }
          case "/write":
            // As the local backend writes: no parents made, so a write into a new directory fails here.
            await local.writeFile(body.path, Buffer.from(body.data, "base64"));
            return send(200, {});
          default:
            return send(404, {});
        }
      })().catch((error: unknown) => send(500, { error: String(error) }));
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, calls };
}

const TOKEN = "backend-env-test-token";
let http: Awaited<ReturnType<typeof httpBackendServer>>;
beforeAll(async () => {
  http = await httpBackendServer(TOKEN);
});
afterAll(async () => {
  await new Promise((closed) => http.server.close(closed));
});

const backends: ReadonlyArray<readonly [string, () => ExecutionBackend]> = [
  ["local backend", () => localExecutionBackend()],
  ["http backend", () => httpExecutionBackend({ url: http.url, token: TOKEN })],
];

/** A fresh, real (symlink-free: `pwd` prints it as is) temp workspace. */
const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "caveman-backend-env-")));

/** Reads `file` (relative to the env's cwd) until it holds a pid. */
async function pidIn(env: BackendEnv, file: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const pid = await env.readFile(file).then(
      (data) => text(data).trim(),
      () => "",
    );
    if (/^\d+$/u.test(pid)) return pid;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${file}: no pid`);
}

const alive = async (env: BackendEnv, pid: string) =>
  (await env.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).output.trim() ===
  "alive";
/**
 * Whether a killed process is gone within 5 s. A kill settles within a bounded wait, and on a loaded machine the
 * process can still be on its way out when it does: asked once at once, it was sometimes still there.
 */
const goneSoon = async (env: BackendEnv, pid: string) => {
  const until = Date.now() + 5_000;
  while (await alive(env, pid)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
};

// BackendEnv serves the Linux tools container on a Cloud computer, and takes only POSIX paths: not on Windows.
const POSIX = process.platform !== "win32";

for (const [label, makeBackend] of backends) {
  describe.skipIf(!POSIX)(`BackendEnv on the ${label}`, () => {
    const withEnv = (
      name: string,
      body: (env: BackendEnv, cwd: string) => Promise<void>,
      extra?: Record<string, string>,
    ) =>
      it(name, async () => {
        const cwd = workspace();
        const env = new BackendEnv({
          backend: makeBackend(),
          cwd,
          ...(extra === undefined ? {} : { env: extra }),
        });
        try {
          await body(env, cwd);
        } finally {
          await env.close();
          rmSync(cwd, { recursive: true, force: true });
        }
      });

    withEnv(
      "names itself after the backend and resolves POSIX paths against its cwd",
      async (env, cwd) => {
        assert.match(env.id, /^backend:(local|http)$/u);
        assert.equal(env.user, undefined);
        assert.equal(env.cwd, cwd);
        assert.equal(env.resolvePath("x/y"), `${cwd}/x/y`);
        assert.equal(env.resolvePath("/etc/hosts"), "/etc/hosts");
        assert.throws(
          () => new BackendEnv({ backend: makeBackend(), cwd: "relative" }),
          /absolute POSIX path/u,
        );
      },
    );

    withEnv("exec: exit code, stdout then stderr combined, duration", async (env) => {
      const run = await env.exec("echo out; echo err >&2; exit 4");
      assert.deepEqual(
        [run.running, run.exitCode, run.output, run.totalBytes, run.truncated, run.handle],
        [false, 4, "out\nerr\n", 8, false, undefined],
      );
      assert.ok(run.durationMs >= 0);
      // The classic engine's combinedProcessOutput: a newline between when stdout does not end in one.
      assert.equal((await env.exec("printf out; printf err >&2")).output, "out\nerr");
      assert.equal((await env.exec("true")).exitCode, 0);
      assert.equal((await env.exec("exit 127")).exitCode, 127);
    });

    withEnv("exec runs in the env's cwd, or options.cwd resolved against it", async (env) => {
      await env.writeFile("sub/marker.txt", "x");
      assert.equal((await env.exec("pwd")).output.trim(), env.cwd);
      assert.equal((await env.exec("ls", { cwd: "sub" })).output.trim(), "marker.txt");
      assert.equal(
        (await env.exec("pwd", { cwd: `${env.cwd}/sub` })).output.trim(),
        `${env.cwd}/sub`,
      );
    });

    withEnv(
      "variables: the harness defaults, the env's, then the call's (which win)",
      async (env) => {
        const run = await env.exec(
          'echo "$PAGER $GIT_PAGER $GIT_TERMINAL_PROMPT $BASE_ONLY $BOTH"',
          { env: { BOTH: "call" } },
        );
        assert.equal(run.output, "cat cat 0 base call\n");
        assert.equal((await env.exec('echo "$BOTH"')).output, "env\n");
      },
      { BASE_ONLY: "base", BOTH: "env" },
    );

    withEnv("the hard timeout kills the command", async (env) => {
      const started = Date.now();
      const run = await env.exec("sleep 30", { timeoutMs: 300 });
      assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
      assert.deepEqual([run.running, run.timedOut, run.exitCode], [false, true, null]);
    });

    withEnv(
      "background: a handle at once; poll says running until it ends, then the whole result once",
      async (env) => {
        const bg = await env.exec("sleep 0.5; echo done", { background: true });
        assert.deepEqual([bg.running, bg.exitCode, bg.output, bg.handle], [true, null, "", "p1"]);
        const polled = await env.poll(bg.handle!);
        assert.deepEqual([polled.running, polled.output], [true, ""]);
        const short = await env.wait(bg.handle!, 50);
        assert.equal(short.running, true);
        const done = await env.wait(bg.handle!, 5_000);
        assert.deepEqual(
          [done.running, done.exitCode, done.output, done.handle],
          [false, 0, "done\n", undefined],
        );
        assert.ok(done.durationMs >= 400, `durationMs ${done.durationMs}`);
        await assert.rejects(env.poll(bg.handle!), /no background process "p1"/u);
        await assert.rejects(env.wait("p99", 10), /no background process "p99"/u);
        // A harness-internal command numbers on its own: the model's handles stay p1, p2, ...
        assert.equal(
          (await env.exec("sleep 0.2", { background: true, internal: true })).handle,
          "h1",
        );
        assert.equal((await env.exec("sleep 0.2", { background: true })).handle, "p2");
      },
    );

    withEnv(
      "a yield leaves the command running; its output comes whole when it ends (no streaming)",
      async (env) => {
        const chunks: string[] = [];
        const first = await env.exec("echo a; sleep 0.6; echo b", {
          yieldMs: 150,
          onOutput: (chunk) => chunks.push(chunk),
        });
        assert.deepEqual([first.running, first.exitCode, first.output], [true, null, ""]);
        assert.deepEqual(chunks, []);
        const rest = await env.wait(first.handle!, 5_000);
        assert.deepEqual([rest.running, rest.exitCode, rest.output], [false, 0, "a\nb\n"]);
        assert.deepEqual(chunks, ["a\nb\n"]);
        // A command that ends inside its yield returns at once with its result.
        const quick = await env.exec("echo fast", { yieldMs: 5_000 });
        assert.deepEqual([quick.running, quick.output], [false, "fast\n"]);
      },
    );

    withEnv("kill stops a background command and its process", async (env) => {
      const bg = await env.exec("echo $$ > k.pid; exec sleep 30", { background: true });
      const pid = await pidIn(env, "k.pid");
      assert.equal(await alive(env, pid), true);
      const started = Date.now();
      const killed = await env.kill(bg.handle!);
      assert.ok(Date.now() - started < 5_000);
      assert.deepEqual([killed.running, killed.killed, killed.exitCode], [false, true, null]);
      assert.equal(await goneSoon(env, pid), true);
      await assert.rejects(env.kill(bg.handle!), /no background process/u);
    });

    withEnv("an abort signal kills the command", async (env) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      const started = Date.now();
      const run = await env.exec("echo $$ > a.pid; exec sleep 30", { signal: controller.signal });
      assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
      assert.deepEqual([run.running, run.killed, run.exitCode], [false, true, null]);
      assert.equal(await goneSoon(env, await pidIn(env, "a.pid")), true);
    });

    withEnv(
      "files: write makes missing parents; read whole or a byte range; misses and directories say which",
      async (env, cwd) => {
        await env.writeFile("a/b/c.txt", "0123456789");
        assert.equal(readFileSync(join(cwd, "a/b/c.txt"), "utf8"), "0123456789");
        assert.equal(text(await env.readFile("a/b/c.txt")), "0123456789");
        assert.equal(text(await env.readFile("a/b/c.txt", { offset: 2, length: 3 })), "234");
        assert.equal(text(await env.readFile(`${cwd}/a/b/c.txt`, { offset: 8 })), "89");
        assert.equal(text(await env.readFile("a/b/c.txt", { length: 4 })), "0123");
        assert.equal(text(await env.readFile("a/b/c.txt", { offset: 8, length: 10 })), "89");
        assert.equal((await env.readFile("a/b/c.txt", { offset: 20, length: 2 })).byteLength, 0);
        await env.writeFile("a/b/c.txt", new Uint8Array([0, 255, 1]));
        assert.deepEqual([...(await env.readFile("a/b/c.txt"))], [0, 255, 1]);
        await assert.rejects(
          env.readFile("missing.txt"),
          (error: { code?: string }) => error.code === "ENOENT",
        );
        await assert.rejects(
          env.readFile("a"),
          (error: { code?: string }) => error.code === "EISDIR",
        );
      },
    );

    withEnv(
      "stat follows symlinks, as LocalEnv's does; a missing path is undefined",
      async (env, cwd) => {
        writeFileSync(join(cwd, "f.txt"), "0123456789");
        mkdirSync(join(cwd, "d"));
        writeFileSync(join(cwd, "with space.txt"), "abc");
        symlinkSync(join(cwd, "f.txt"), join(cwd, "to-file"));
        symlinkSync(join(cwd, "d"), join(cwd, "to-dir"));
        symlinkSync(join(cwd, "nowhere"), join(cwd, "dangling"));
        const file = await env.stat("f.txt");
        assert.deepEqual([file?.kind, file?.size], ["file", 10]);
        assert.equal(file?.mtimeMs, Math.floor(statSync(join(cwd, "f.txt")).mtimeMs / 1000) * 1000);
        assert.equal((await env.stat("d"))?.kind, "directory");
        assert.equal((await env.stat("."))?.kind, "directory");
        assert.deepEqual(
          await env.stat("with space.txt").then((info) => [info?.kind, info?.size]),
          ["file", 3],
        );
        assert.deepEqual(await env.stat("to-file").then((info) => [info?.kind, info?.size]), [
          "file",
          10,
        ]);
        assert.equal((await env.stat("to-dir"))?.kind, "directory");
        assert.equal((await env.stat("dangling"))?.kind, "symlink");
        assert.equal(lstatSync(join(cwd, "dangling")).isSymbolicLink(), true);
        assert.equal(await env.stat("missing"), undefined);
        assert.equal(await env.stat("f.txt/below"), undefined);
        assert.equal(await env.stat("$(touch pwned)"), undefined);
        assert.equal(existsSync(join(cwd, "pwned")), false, "a path is an argument, never script");
      },
    );

    withEnv(
      "listDir: every entry, names with spaces and newlines, symlinks as symlinks; errors say why",
      async (env, cwd) => {
        const dir = join(cwd, "list");
        mkdirSync(dir);
        writeFileSync(join(dir, "with space.txt"), "");
        writeFileSync(join(dir, "new\nline"), "");
        writeFileSync(join(dir, ".hidden"), "");
        mkdirSync(join(dir, "sub"));
        symlinkSync(join(dir, "sub"), join(dir, "link"));
        const entries = (await env.listDir("list")).sort((a, b) => (a.name < b.name ? -1 : 1));
        assert.deepEqual(entries, [
          { name: ".hidden", kind: "file" },
          { name: "link", kind: "symlink" },
          { name: "new\nline", kind: "file" },
          { name: "sub", kind: "directory" },
          { name: "with space.txt", kind: "file" },
        ]);
        assert.deepEqual(await env.listDir("list/sub"), []);
        await assert.rejects(
          env.listDir("nope"),
          (error: { code?: string }) => error.code === "ENOENT",
        );
        await assert.rejects(
          env.listDir("list/with space.txt"),
          (error: { code?: string }) => error.code === "ENOTDIR",
        );
      },
    );

    withEnv("batched reads and writes keep order and report each failure", async (env) => {
      await env.writeFiles([
        { path: "m/a.txt", data: "A" },
        { path: "m/n/b.bin", data: new Uint8Array([0, 255, 1]) },
      ]);
      const [a, missing, b] = await env.readFiles([
        "m/a.txt",
        "m/none.txt",
        `${env.cwd}/m/n/b.bin`,
      ]);
      assert.equal(text(a as Uint8Array), "A");
      assert.ok(missing instanceof Error);
      assert.deepEqual([...(b as Uint8Array)], [0, 255, 1]);
    });

    it("the scratch dir is outside the workspace, writable, one per env, and gone after close", async () => {
      const cwd = workspace();
      const env = new BackendEnv({ backend: makeBackend(), cwd });
      const scratch = await env.scratchDir();
      assert.ok(scratch.startsWith("/") && !scratch.startsWith(`${cwd}/`), scratch);
      assert.equal(await env.scratchDir(), scratch);
      await env.writeFile(`${scratch}/spill.log`, "full");
      assert.equal(text(await env.readFile(`${scratch}/spill.log`)), "full");
      assert.equal(statSync(scratch).isDirectory(), true);
      await env.close();
      assert.equal(existsSync(scratch), false);
      rmSync(cwd, { recursive: true, force: true });
    });

    it("close aborts every command still running and leaves the backend usable", async () => {
      const cwd = workspace();
      const backend = makeBackend();
      const env = new BackendEnv({ backend, cwd });
      const bg = await env.exec("echo $$ > c.pid; exec sleep 30", { background: true });
      const pid = await pidIn(env, "c.pid");
      await env.close();
      await assert.rejects(env.poll(bg.handle!), /no background process/u);
      const checker = new BackendEnv({ backend, cwd });
      try {
        // Its kill is sent; the process is gone a moment later (on a loaded runner, after close returns).
        assert.equal(await goneSoon(checker, pid), true);
      } finally {
        await checker.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
}

describe.skipIf(!POSIX)("BackendEnv over HTTP", () => {
  it("a write into a new directory fails on the backend, makes the parent through exec and goes again", async () => {
    const cwd = workspace();
    const env = new BackendEnv({
      backend: httpExecutionBackend({ url: http.url, token: TOKEN }),
      cwd,
    });
    try {
      const before = http.calls.length;
      await env.writeFile("new/dir/x.txt", "x");
      assert.deepEqual(http.calls.slice(before), ["/write", "/exec", "/write"]);
      assert.equal(readFileSync(join(cwd, "new/dir/x.txt"), "utf8"), "x");
      const again = http.calls.length;
      await env.writeFile("new/dir/y.txt", "y");
      assert.deepEqual(http.calls.slice(again), ["/write"], "an existing parent costs one call");
    } finally {
      await env.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ── the harness, end to end ─────────────────────────────────────

for (const [label, makeBackend] of backends) {
  it.skipIf(!POSIX)(
    `a HarnessSession on the app's Claude loadout runs bash, write and read through a BackendEnv on the ${label}`,
    async () => {
      const harness: typeof Harness = await import("@caveman-ai/harness");
      const cwd = workspace();
      const env = new BackendEnv({ backend: makeBackend(), cwd });
      const session = new harness.HarnessSession({
        model: { ...fauxModel({ priced: true }) },
        stream: scriptedStream([
          {
            toolCalls: [
              {
                name: "bash",
                args: {
                  command:
                    "mkdir -p out && echo hi from bash > out/bash.txt && cat out/bash.txt && echo $PAGER",
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: "write",
                args: { path: "out/deep/new/w.txt", content: "written by the harness\n" },
              },
            ],
          },
          { toolCalls: [{ name: "read", args: { path: "out/deep/new/w.txt" } }] },
          { text: "All three ran." },
        ]),
        loadout: harness.appLoadouts().claude,
        env,
      });
      try {
        assert.deepEqual(
          session.toolNames.filter((name) => ["bash", "write", "read"].includes(name)).sort(),
          ["bash", "read", "write"],
        );
        const outcome = await session.runTurn("Run the three tools.");
        assert.equal(outcome.status, "finished", outcome.error);
        assert.equal(outcome.finalText, "All three ran.");
        assert.equal(readFileSync(join(cwd, "out/bash.txt"), "utf8"), "hi from bash\n");
        assert.equal(
          readFileSync(join(cwd, "out/deep/new/w.txt"), "utf8"),
          "written by the harness\n",
        );
        const results = session.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => ({
            name: message.toolName as string,
            isError: message.isError as boolean,
            text: (message.content as Array<{ type: string; text?: string }>)
              .map((part) => part.text ?? "")
              .join(""),
          }));
        assert.deepEqual(
          results.map((result) => [result.name, result.isError]),
          [
            ["bash", false],
            ["write", false],
            ["read", false],
          ],
        );
        assert.match(results[0]!.text, /hi from bash\ncat/u);
        assert.match(results[1]!.text, /Successfully wrote 23 bytes to out\/deep\/new\/w\.txt/u);
        assert.match(results[2]!.text, /written by the harness/u);
      } finally {
        await session.close();
        await env.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
}
