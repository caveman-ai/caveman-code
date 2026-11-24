#!/usr/bin/env node
// Preview this checkout of the app without touching the person's own Caveman Code. A runtime holds one server per
// home (its lock, database, settings, secrets, worktrees all live under ~/.caveman-code/userdata), so a branch is
// never pointed at that folder: this starts a throwaway runtime on a scratch home of its own (--base-dir in the temp
// folder, empty), and the web client from this checkout pointed at it, then prints the address that opens the one
// on the other (CAVEMAN_PREVIEW_URL=, which the runtime's preview opens).
//
//   A chat's preview:  register_preview command "node scripts/preview-app.mjs"   (serves on $PORT)
//   By hand:           PORT=5800 node scripts/preview-app.mjs
//
// The scratch runtime has no projects, keys or chats of the person's; their own `claude` login still works there,
// since Claude Agent runs their CLI. CAVEMAN_PREVIEW_HOME keeps a scratch home between runs. Stopping this (the
// preview's Stop, idle, archive, quit, or Ctrl-C) stops both, and a temp home goes with them.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { previewPreflight } from "./preview-app-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failure = previewPreflight(root);
if (failure) {
  console.error(failure);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 5733);
const live = path.join(os.homedir(), ".caveman-code");

const kept = process.env.CAVEMAN_PREVIEW_HOME;
const home = kept ? path.resolve(kept) : fs.mkdtempSync(path.join(os.tmpdir(), "caveman-preview-"));
const inside = (dir, parent) => {
  const rel = path.relative(parent, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
if (inside(home, live) || inside(live, home)) {
  console.error(
    `preview-app: refusing ${home}: it is (or holds) the person's own Caveman Code folder, ${live}.`,
  );
  process.exit(2);
}
fs.mkdirSync(home, { recursive: true });

/** The environment for the children: nothing that points a runtime at another home, another runtime or its token. */
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(CAVEMAN_CODE_|VITE_RUNTIME_|VITE_DEV_SERVER_URL$)/.test(key),
  ),
);

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
const listening = (at) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: at });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const children = [];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    if (!kept) fs.rmSync(home, { recursive: true, force: true });
    process.exit(code);
  }, 1500).unref();
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop(0));
const run = (name, file, args, options) => {
  const child = spawn(file, args, { stdio: ["ignore", "inherit", "inherit"], env, ...options });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(
        `preview-app: the ${name} stopped (${signal ?? `code ${code}`}); stopping the preview.`,
      );
      stop(1);
    }
  });
  children.push(child);
  return child;
};

// A kept home holds the last run's token: gone first, so the one read below is this runtime's.
const tokenFile = path.join(home, "userdata", "session-protocol.token");
fs.rmSync(tokenFile, { force: true });
const runtimePort = await freePort();
console.log(`preview-app: a scratch runtime on 127.0.0.1:${runtimePort}, home ${home}`);
run(
  "runtime",
  process.execPath,
  [
    path.join(root, "packages/runtime/src/bin.ts"),
    "serve",
    "--base-dir",
    home,
    "--port",
    String(runtimePort),
    "--host",
    "127.0.0.1",
  ],
  { cwd: home },
);

// Its token is written when it starts serving: a fresh one each start, in its own state folder.
const deadline = Date.now() + 60_000;
while (!(fs.existsSync(tokenFile) && (await listening(runtimePort)))) {
  if (stopping) process.exit(1);
  if (Date.now() > deadline) {
    console.error("preview-app: the scratch runtime did not start within 60 s.");
    stop(1);
    await sleep(2000);
  }
  await sleep(200);
}
const token = fs.readFileSync(tokenFile, "utf8").trim();

// Announced before the web server listens, so the runtime's preview opens this address, token and all.
const runtimeUrl = `ws://127.0.0.1:${runtimePort}/session/v1`;
console.log(
  `CAVEMAN_PREVIEW_URL=http://localhost:${port}/?runtime=${encodeURIComponent(runtimeUrl)}#token=${token}`,
);
run(
  "web client",
  process.execPath,
  [
    path.join(root, "apps/web/node_modules/vite/bin/vite.js"),
    "--port",
    String(port),
    "--strictPort",
    "--host",
    "localhost",
  ],
  { cwd: path.join(root, "apps/web") },
);
