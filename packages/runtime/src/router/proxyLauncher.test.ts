// The app's own proxy: its own binary and home, compress mode on a port of its own, a short env, restarted on
// its port when it dies, never a foreign listener taken for it, and stopping it stops only the child it started.
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { pickEnv } from "@caveman-app/shared/processEnv";
import { afterEach, expect, test } from "vitest";

import { AppProxy, type AppProxyCloud, appProxyEnv, ensureAppProxy, findCavemanBinary, findMcpBinary, findProxyBinary, privateHome, setAppProxyCloud, setAppProxyHome, writeProxyCloud } from "./proxyLauncher.ts";

const WIN = process.platform === "win32";
/** Windows runs no script as a binary: there node starts the stand-in, through AppProxy's spawn seam. */
const viaNode = WIN ? { spawn: (bin: string, env: NodeJS.ProcessEnv) => spawn(process.execPath, [bin, "serve"], { stdio: "ignore", env, windowsHide: true }) } : {};
/** What every environment has on Windows, and the proxy keeps (pickEnv); nothing elsewhere. */
const base = WIN ? pickEnv(process.env, []) : {};

// A stand-in caveman-proxy: writes the env it got, its run state (pid, instance token) in CAVEMAN_HOME, and
// answers /health/live on CAVEMAN_LISTEN with that token, as v4's does.
const fakeProxy = (dir: string) => {
  const bin = path.join(dir, WIN ? "caveman-proxy.exe" : "caveman-proxy");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
fs.writeFileSync(${JSON.stringify(path.join(dir, "env.json"))}, JSON.stringify(process.env));
const [host, port] = process.env.CAVEMAN_LISTEN.split(":");
const token = require("node:crypto").randomBytes(8).toString("hex");
fs.mkdirSync(path.join(process.env.CAVEMAN_HOME, "run"), { recursive: true });
fs.writeFileSync(path.join(process.env.CAVEMAN_HOME, "run", port + ".json"), JSON.stringify({ pid: process.pid, instance_token: token }));
http.createServer((req, res) => res.writeHead(200, { "x-caveman-instance": token }).end(req.url === "/health/live" ? "ok" : "")).listen(Number(port), host);
`,
    { mode: 0o755 },
  );
  return bin;
};

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "app-proxy-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const proxies: AppProxy[] = [];
afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.stop();
});

test("starts the app's own binary in pass-through record mode, on its own port and home, with only what it needs", async () => {
  const dir = scratch();
  const home = path.join(dir, "app-home");
  const env = {
    ...base,
    HOME: dir,
    PATH: "/usr/bin",
    CAVEMAN_PROXY_BIN: fakeProxy(dir),
    SECRET_TOKEN: "never-passed",
    CAVEMAN_MODE: "compress",
    CAVEMAN_HOME: path.join(dir, ".caveman"),
    CAVEMAN_CONFIG: path.join(dir, ".caveman", "caveman.yaml"),
    HTTPS_PROXY: "http://corp:3128",
  };
  const proxy = new AppProxy({ env, home, ...viaNode });
  proxies.push(proxy);
  expect(proxy.url()).toBeUndefined();
  expect(proxy.state()).toBeUndefined();
  expect(await proxy.ensure()).toBe("started");
  const url = proxy.url()!;
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(url).not.toBe("http://127.0.0.1:8787");
  const got = JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8")) as Record<string, string>;
  // The app's mode and home win over the person's; their caveman.yaml is never read.
  expect(got).toMatchObject({ CAVEMAN_MODE: "record", CAVEMAN_HOME: home, CAVEMAN_LISTEN: url.slice("http://".length), HTTPS_PROXY: "http://corp:3128" });
  expect(got.CAVEMAN_CONFIG).toBeUndefined();
  expect(got.SECRET_TOKEN).toBeUndefined();
  // Not told every request carries caveman_retrieve: it shortens only those that do.
  expect(got.CAVEMAN_RECOVERY).toBeUndefined();
  // Windows: also what any process there needs (Go's Winsock cannot start without SystemRoot).
  if (WIN) expect(got).toMatchObject(base);
  expect(await proxy.ensure()).toBe("running");
  expect(proxy.state()).toBe("running");
});

test("brings a dead proxy back on the same port, and stop ends only its own child", async () => {
  const dir = scratch();
  const proxy = new AppProxy({ env: { ...base, HOME: dir, PATH: "/usr/bin", CAVEMAN_PROXY_BIN: fakeProxy(dir) }, home: path.join(dir, "home"), ...viaNode });
  proxies.push(proxy);
  await proxy.ensure();
  const url = proxy.url();
  const pid = proxy.pid()!;
  process.kill(pid, "SIGKILL");
  await sleep(200);
  expect(proxy.url()).toBeUndefined();
  // Down between checks: its chats say so.
  expect(proxy.state()).toBe("failed");
  expect(await proxy.ensure()).toBe("started");
  expect(proxy.url()).toBe(url);
  expect(proxy.pid()).not.toBe(pid);
  const child = proxy.pid()!;
  proxy.stop();
  await sleep(200);
  expect(() => process.kill(child, 0)).toThrow();
  expect(proxy.url()).toBeUndefined();
});

test("after a crash, a port another process took meanwhile is given up for a new one, not failed on until a restart", async () => {
  const dir = scratch();
  const proxy = new AppProxy({ env: { ...base, HOME: dir, PATH: "/usr/bin", CAVEMAN_PROXY_BIN: fakeProxy(dir) }, home: path.join(dir, "home"), ...viaNode });
  proxies.push(proxy);
  expect(await proxy.ensure()).toBe("started");
  const url = proxy.url()!;
  process.kill(proxy.pid()!, "SIGKILL");
  await sleep(200);
  const foreign = http.createServer((_req, res) => res.writeHead(200, { "x-caveman-instance": "someone-else" }).end("ok"));
  await new Promise<void>((resolve) => foreign.listen(Number(new URL(url).port), "127.0.0.1", resolve));
  try {
    expect(await proxy.ensure()).toBe("started");
    expect(proxy.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proxy.url()).not.toBe(url);
    expect(await proxy.ensure()).toBe("running");
  } finally {
    foreign.close();
  }
});

test("a listener that took its remembered port is never taken for it", async () => {
  const dir = scratch();
  const bin = fakeProxy(dir);
  const proxy = new AppProxy({ env: { ...base, HOME: dir, PATH: "/usr/bin:/bin", CAVEMAN_PROXY_BIN: bin }, home: path.join(dir, "home"), readyMs: 800, ...viaNode });
  proxies.push(proxy);
  expect(await proxy.ensure()).toBe("started");
  const port = Number(new URL(proxy.url()!).port);
  proxy.stop();
  await sleep(200);
  // Someone else answers health there now; the next child never listens.
  const foreign = http.createServer((_req, res) => res.writeHead(200, { "x-caveman-instance": "someone-else" }).end("ok"));
  await new Promise<void>((resolve) => foreign.listen(port, "127.0.0.1", resolve));
  fs.writeFileSync(bin, WIN ? "setTimeout(() => {}, 30_000);\n" : "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  try {
    expect(await proxy.ensure()).toBe("failed");
    expect(proxy.url()).toBeUndefined();
    expect(proxy.why()).toMatch(/no answer from it/);
  } finally {
    foreign.close();
  }
});

test("no binary of the app's own: nothing starts and an installed caveman is never used", async () => {
  const dir = scratch();
  // The person's own install, on PATH and in v4's places.
  for (const place of ["bin", ".caveman/bin", ".local/bin"]) {
    fs.mkdirSync(path.join(dir, place), { recursive: true });
    fakeProxy(path.join(dir, place));
  }
  const env = { HOME: dir, CAVEMAN_HOME: path.join(dir, ".caveman"), PATH: path.join(dir, "bin") };
  expect(findProxyBinary(env)).toBeUndefined();
  const proxy = new AppProxy({ env, home: path.join(dir, "home") });
  expect(await proxy.ensure()).toBe("no_binary");
  expect(proxy.state()).toBe("no_binary");
  expect(proxy.why()).toMatch(/CAVEMAN_PROXY_BIN/);
  // The bundle's copy is found beside the runtime.
  const bundled = path.join(dir, "bundle-bin");
  fs.mkdirSync(bundled);
  fakeProxy(bundled);
  expect(findCavemanBinary("caveman-proxy", undefined, bundled)).toBe(path.join(bundled, WIN ? "caveman-proxy.exe" : "caveman-proxy"));
});

test("only a proxy told so counts on the chats' caveman_retrieve, and only with the app's caveman-mcp", () => {
  const dir = scratch();
  const mcp = path.join(dir, "caveman-mcp");
  fs.writeFileSync(mcp, "#!/bin/sh\n", { mode: 0o755 });
  const home = path.join(dir, "home");
  expect(appProxyEnv({ HOME: dir, CAVEMAN_MCP_BIN: mcp }, "127.0.0.1:1", { home, recovery: true }).CAVEMAN_RECOVERY).toBe("mcp");
  expect(appProxyEnv({ HOME: dir, CAVEMAN_MCP_BIN: mcp }, "127.0.0.1:1", { home, recovery: false }).CAVEMAN_RECOVERY).toBeUndefined();
  // One on PATH is the person's, not the app's: no way back it knows of, so no claim.
  expect(appProxyEnv({ HOME: dir, PATH: dir }, "127.0.0.1:1", { home, recovery: true }).CAVEMAN_RECOVERY).toBeUndefined();
  // A Cloud computer: its engines run in the tools container, which cannot read the proxies' home. No claim.
  const computer = { HOME: dir, CAVEMAN_MCP_BIN: mcp, CAVEMAN_RUNTIME_TOOLS_ADDRESS: "127.0.0.1:47917" };
  expect(findMcpBinary(computer)).toBe(mcp);
  expect(appProxyEnv(computer, "127.0.0.1:1", { home, recovery: true }).CAVEMAN_RECOVERY).toBeUndefined();
});

test("the app's own sign-in goes where the proxy reads it; signed out, a cloud.json with none", () => {
  const home = path.join(scratch(), "home");
  const read = () => JSON.parse(fs.readFileSync(path.join(home, "cloud.json"), "utf8")) as Record<string, unknown>;
  const out = writeProxyCloud(home, undefined);
  // Present even signed out: without it the proxy would read the person's ~/.caveman-cloud sign-in.
  expect(read()).toEqual({ telemetry: { enabled: false } });
  expect(fs.existsSync(path.join(home, "credentials"))).toBe(false);
  const cloud = { cloudUrl: "https://app.caveman.so", accessToken: "cave-app-token", gatewayUrl: "https://gateway.caveman.so" };
  const signedIn = writeProxyCloud(home, cloud, out);
  expect(read()).toEqual({ baseURL: "https://app.caveman.so", gatewayUrl: "https://gateway.caveman.so", tokenStore: "file", deviceId: "caveman-code", modules: { routing: false }, telemetry: { enabled: false } });
  expect(JSON.parse(fs.readFileSync(path.join(home, "credentials"), "utf8"))).toEqual({ access_token: "cave-app-token" });
  // Windows has no mode bits: the profile's ACL keeps the file the person's.
  if (!WIN) expect(fs.statSync(path.join(home, "credentials")).mode & 0o077).toBe(0);
  // Unchanged: not written again (the proxy re-reads on every change).
  const stamp = fs.statSync(path.join(home, "cloud.json")).mtimeMs;
  expect(writeProxyCloud(home, cloud, signedIn)).toBe(signedIn);
  expect(fs.statSync(path.join(home, "cloud.json")).mtimeMs).toBe(stamp);
  const paid = writeProxyCloud(home, { ...cloud, routingKey: "cave_router_fake" }, signedIn);
  expect(read()).toMatchObject({ modules: { routing: true } });
  expect(JSON.parse(fs.readFileSync(path.join(home, "credentials"), "utf8"))).toEqual({ access_token: "cave-app-token", gateway_api_key: "cave_router_fake" });
  // Windows has no mode bits: the profile's ACL keeps the file the person's.
  if (!WIN) expect(fs.statSync(path.join(home, "credentials")).mode & 0o077).toBe(0);
  writeProxyCloud(home, cloud, paid);
  expect(read()).toMatchObject({ modules: { routing: false } });
  expect(JSON.parse(fs.readFileSync(path.join(home, "credentials"), "utf8"))).not.toHaveProperty("gateway_api_key");
  writeProxyCloud(home, undefined, signedIn);
  expect(read()).toEqual({ telemetry: { enabled: false } });
  expect(fs.existsSync(path.join(home, "credentials"))).toBe(false);
});

// Skipped on Windows: it has no mode bits; the home there is private by its place under the person's profile.
test.skipIf(process.platform === "win32")("the proxies' home is private to the runtime's uid even when it already existed wider", () => {
  const home = path.join(scratch(), "home");
  fs.mkdirSync(home, { mode: 0o755 });
  fs.chmodSync(home, 0o755);
  writeProxyCloud(home, { cloudUrl: "https://cloud.example", accessToken: "cave_access_mode_test" });
  expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(home, "credentials")).mode & 0o777).toBe(0o600);
  // As the runtime does at start and each proxy launch, with nothing to write.
  fs.chmodSync(home, 0o777);
  privateHome(home);
  expect(fs.statSync(home).mode & 0o777).toBe(0o700);
});

test("a warm Cloud computer starts no proxy before its claim, and starts it at the first ensure after", async () => {
  const dir = scratch();
  const link = path.join(dir, "link");
  fs.mkdirSync(link);
  const proxy = new AppProxy({ env: { ...base, HOME: dir, PATH: "/usr/bin", CAVEMAN_PROXY_BIN: fakeProxy(dir) }, home: path.join(dir, "home"), ...viaNode });
  proxies.push(proxy);
  const warm = { CAVEMAN_RUNTIME_LINK_WAIT: "1", CAVEMAN_CLOUD_LINK_DIR: link };
  expect(await ensureAppProxy(proxy, warm)).toBe("failed");
  expect(proxy.url()).toBeUndefined();
  expect(fs.existsSync(path.join(dir, "env.json"))).toBe(false);
  // The claim writes the computer's identity.
  fs.writeFileSync(path.join(link, "runtime.key"), crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
  fs.writeFileSync(
    path.join(link, "runtime.json"),
    JSON.stringify({ cloud_url: "https://cloud.example", runtime_id: crypto.randomUUID(), organization_id: crypto.randomUUID(), computer_id: crypto.randomUUID() }),
  );
  expect(await ensureAppProxy(proxy, warm)).toBe("started");
  expect(proxy.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

test("two tells at once: the sign-in read before a new routing key never lands over the one read after it", async () => {
  const home = path.join(scratch(), "home");
  let current: AppProxyCloud = { cloudUrl: "https://cloud.example", accessToken: "cave_access_overlap_test" };
  const answers: Array<() => void> = [];
  // Each read answers when the test says, with the sign-in as it was when it was asked.
  setAppProxyCloud(() => {
    const read = current;
    return new Promise((resolve) => answers.push(() => resolve(read)));
  });
  setAppProxyHome(home);
  try {
    const proxy = new AppProxy({ env: {} });
    const older = ensureAppProxy(proxy, {});
    // A mint (or credits turned on) lands, and the proxies are told again while the first read is still out.
    current = { ...current, routingKey: "cave_router_overlap_fake" };
    const newer = ensureAppProxy(proxy, {});
    // The newer read answers first; the older one, slower (a sign-in refresh), after it.
    answers.at(-1)!();
    await newer;
    answers[0]!();
    await older;
    expect(JSON.parse(fs.readFileSync(path.join(home, "cloud.json"), "utf8"))).toMatchObject({ modules: { routing: true } });
    expect(JSON.parse(fs.readFileSync(path.join(home, "credentials"), "utf8"))).toEqual({ access_token: "cave_access_overlap_test", gateway_api_key: "cave_router_overlap_fake" });
  } finally {
    setAppProxyHome(undefined);
    setAppProxyCloud(async () => undefined);
  }
});
