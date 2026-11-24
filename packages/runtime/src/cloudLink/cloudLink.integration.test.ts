// The runtime's Cloud link end to end against a stand-in Cloud: This Mac
// enrolls through cloud.enroll and links only while Settings.remote_control
// is on; a relayed client is a Session Protocol connection that runs a turn
// (smoke-claude, no model); a Cloud computer works in its snapshot checkout
// and pushes through the git proxy with the runtime token.
import { execFileSync, spawn } from "node:child_process";
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import { Embedder, type EmbedderService } from "../search/Embedder.ts";
import { allowedStream } from "../session-protocol/devices.testkit.ts";
import { createReady, FAKE_CLAUDE, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { SEAL_INFO } from "./bootstrap.ts";
import { enroll, KEY_FILE, RECORD_FILE } from "./identity.ts";
import { CloudComputer, CloudLinkState, cloudComputerFromEnv } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";
import { TOOLS_EXEC } from "./tools.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const reasonOf = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason);
const refusalOf = (promise: Promise<unknown>) =>
  promise.then(() => "ok", (error: { error?: { message?: string; data?: { reason?: string } } }) => `${error.error?.data?.reason}: ${error.error?.message}`);

/** A JSON-RPC call over one relayed stream from a device This Mac allowed (sealed, devices.ts); resolves with its reply. */
async function rpc(device: Awaited<ReturnType<typeof allowedStream>>, method: string, params: unknown) {
  const reply = await device.call(method, params);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result as Record<string, any>;
}

test("This Mac: enroll, link only while remote_control is on, and a relayed client runs a turn", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const localStates: string[] = [];
  const local = connect(runtime.url, runtime.token, (state) => localStates.push(state));
  cleanups.push(() => local.close());

  expect(await local.call("cloud.status", {})).toEqual({ state: "off" });
  // Cloud refusing the person's token is its own reason: the client must not read it as its runtime token failing.
  expect(await reasonOf(local.call("cloud.enroll", { request_id: "e0", cloud_url: cloud.url, token: "not-a-session" }))).toBe("cloud_unauthorized");
  expect(localStates).not.toContain("unauthorized");
  const enrolled = await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  expect(enrolled).toMatchObject({ cloud_url: cloud.url, organization_id: cloud.state.organizationId });
  const linkDir = path.join(config.stateDir, "cloud-link");
  // Windows has no mode bits: the state dir's place in the person's profile (its ACL) keeps the key private.
  if (process.platform !== "win32") expect(fs.statSync(path.join(linkDir, "runtime.key")).mode & 0o777).toBe(0o600);
  // The person's token is in no file and no receipt.
  const files = fs.readdirSync(config.stateDir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name));
  expect(files.filter((file) => fs.readFileSync(file).includes(cloud.state.personToken))).toEqual([]);

  // Enrolled but off: no link.
  await new Promise((r) => setTimeout(r, 2_500));
  expect(cloud.state.relays).toHaveLength(0);
  expect((await local.call("cloud.status", {})).state).toBe("off");

  await local.call("settings.set", { request_id: "rc-on", settings: { remote_control: true } });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const relay = cloud.state.relays[0]!;
  await until(() => cloud.state.heartbeats.length > 0);

  // A stream naming another organization is closed and served nothing.
  const stranger = relay.open({ organization_id: randomUUID() });
  relay.send(stranger, JSON.stringify({ jsonrpc: "2.0", id: 99, method: "engine.list", params: {} }));
  // Driving This Mac needs a device it allowed on its own screen (session-protocol/devices.ts).
  const stream = relay.open();
  const device = await allowedStream(relay, local, undefined, stream);
  const { engines } = await rpc(device, "engine.list", {});
  expect(relay.frames.some((f) => f.type === 4 && f.id.equals(stranger))).toBe(true);
  expect(relay.replies(stranger)).toEqual([]);
  expect(engines.map((e: { id: string }) => e.id)).toContain("claude-agent");
  const repo = makeRepo(tempRoot("cloud-link-repo-"), { "README.md": "hello\n" });
  const workspace = await rpc(device, "workspace.create", { request_id: "w1", repo: { path: repo }, title: "Relayed", engine: "claude-agent", options: { model: MODEL } });
  expect(workspace.computer.kind).toBe("this_mac");
  await rpc(device, "session.attach", { session_id: workspace.session_id, cursor: 0 });
  await rpc(device, "turn.submit", { request_id: "t1", session_id: workspace.session_id, kind: "followup", input: { text: "hello through the relay" } });
  // What the Mac sent back, opened with the device's key: the relay carries ciphertext only.
  const events = async () => (await device.opened()).filter((r) => r.method === "session.event").map((r) => r.params as { type: string; payload: Record<string, unknown> });
  await until(async () => (await events()).some((e) => e.type === "turn.done"), 60_000);
  expect(JSON.stringify(relay.replies(stream))).not.toContain("hello through the relay");
  const said = (await events()).find((e) => e.type === "message.done" && e.payload.role === "assistant");
  expect(JSON.stringify(said)).toContain("hello through the relay");
  // The relayed client counted as attached.
  expect(cloud.state.heartbeats.some((h) => h.active)).toBe(true);

  // The client leaves: its connection and attachment end, so a later turn sends it nothing.
  relay.close(stream, "client left");
  await new Promise((r) => setTimeout(r, 300));
  const before = relay.frames.filter((f) => f.id.equals(stream)).length;
  const seenLocally: Array<string> = [];
  await local.attach(workspace.session_id, 0, (event) => seenLocally.push(event.type));
  await local.call("turn.submit", { request_id: "t2", session_id: workspace.session_id, kind: "followup", input: { text: "second turn" } });
  await until(() => seenLocally.filter((type) => type === "turn.done").length === 2, 60_000);
  expect(relay.frames.filter((f) => f.id.equals(stream)).length).toBe(before);

  await local.call("settings.set", { request_id: "rc-off", settings: { remote_control: false } });
  await until(() => relay.ws.readyState === relay.ws.CLOSED, 10_000);
  expect((await local.call("cloud.status", {})).state).toBe("off");
}, 120_000);

// Skipped on Windows: a Cloud computer is Linux; git trusts its checkout by owner uid and mode bits (gitTrusts), which Windows has not.
test.skipIf(process.platform === "win32")("Cloud computer: the snapshot checkout is the workspace, setup is skipped on the build's marker, git goes through the proxy", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("cloud-computer-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  // What the snapshot build leaves on the volume: the repo at its commit, caches, and the git-excluded marker.
  const checkout = makeRepo(tempRoot("cloud-computer-"), {
    ".caveman/computer.toml": '[setup]\nrun = ["echo ran >> setup-ran.txt"]\ninputs = ["package.json"]\n',
    "package.json": "{}\n",
    ".gitignore": "setup-ran.txt\n",
  });
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  fs.appendFileSync(path.join(checkout, ".git/info/exclude"), ".caveman/snapshot.json\n");
  fs.writeFileSync(path.join(checkout, ".caveman/snapshot.json"), JSON.stringify({ hash: "h", commit: git("rev-parse", "HEAD"), branch: "main", built_at: new Date().toISOString() }));

  const config = await makeConfig();
  // References: providing them yields Layer<never>, which the harness's Layer<any> slot needs cast.
  const provide = Layer.mergeAll(
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());

  // No setting needed: a Cloud computer is always linked.
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);
  expect(await reasonOf(client.call("cloud.enroll", { request_id: "e", cloud_url: cloud.url, token: cloud.state.personToken }))).toBe("invalid_state");

  const create = (request_id: string, extra: Record<string, unknown> = {}) =>
    client.call("workspace.create", { request_id, repo: { url: "https://github.com/acme/widgets" }, title: "Fix the thing", engine: "claude-agent", options: { model: MODEL }, ...extra });
  // A checkout another uid can write (the agent's, on a real computer): the runtime runs no git in it.
  const head = git("rev-parse", "HEAD");
  fs.chmodSync(path.join(checkout, ".git"), 0o777);
  expect(await reasonOf(create("w0"))).toBe("unsupported");
  expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(git("rev-parse", "HEAD")).toBe(head);
  fs.chmodSync(path.join(checkout, ".git"), 0o755);
  fs.chmodSync(checkout, 0o755);
  const workspace = await createReady(client, { request_id: "w1", repo: { url: "https://github.com/acme/widgets" }, title: "Fix the thing", engine: "claude-agent", options: { model: MODEL } });
  expect(workspace.computer).toMatchObject({ id: identity.computerId, kind: "caveman_cloud" });
  expect(workspace.root_path).toBeUndefined();
  expect(workspace.branch).toMatch(/^caveman\/fix-the-thing-/);
  expect(git("symbolic-ref", "--short", "HEAD")).toBe(workspace.branch);
  const notes: Array<string> = [];
  await client.attach(workspace.session_id, 0, (event) => {
    if (event.type === "notification") notes.push(event.payload.title);
  });
  await until(() => notes.length > 0);
  expect(notes[0]).toMatch(/Setup skipped/);
  expect(fs.existsSync(path.join(checkout, "setup-ran.txt"))).toBe(false);

  // A second chat on the computer gets a worktree of the checkout (builders.integration.test.ts has the rest); the
  // first keeps the checkout and its branch.
  const second = await createReady(client, { request_id: "w2", repo: { url: "https://github.com/acme/widgets" }, title: "Another", engine: "claude-agent", options: { model: MODEL } });
  expect(git("worktree", "list")).toContain(second.branch);
  expect(git("symbolic-ref", "--short", "HEAD")).toBe(workspace.branch);
  await client.call("workspace.archive", { request_id: "a2", workspace_id: second.id });

  // git.push reaches Cloud's git proxy (github.com rewritten), carrying the runtime token; this stand-in refuses it.
  expect(await reasonOf(client.call("git.push", { request_id: "p1", workspace_id: workspace.id }))).toBe("invalid_state");
  const pushed = cloud.state.gitRequests.find((r) => r.url.startsWith("/relay/v1/git/acme/widgets.git/info/refs"));
  expect(pushed?.authorization).toMatch(/^Bearer ccrt_/);
  expect(cloud.state.tokens.has(pushed!.authorization!.slice(7))).toBe(true);

  // Archive leaves the checkout (it goes with the computer).
  await client.call("workspace.archive", { request_id: "a1", workspace_id: workspace.id });
  expect(fs.existsSync(path.join(checkout, ".git"))).toBe(true);
}, 120_000);

// Skipped on Windows: a Cloud computer is Linux, and its tools channel is a Unix socket.
test.skipIf(process.platform === "win32")("Cloud computer with a tools container: setup, archive, park's index and Claude Agent's turns run there; pull requests go through Cloud", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("cloud-tools-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  const checkout = makeRepo(tempRoot("cloud-tools-computer-"), {
    ".caveman/computer.toml": `[setup]\nrun = ['echo "$TOOLS_SIDE" > setup-side.txt']\n\n[archive]\nrun = ['echo "$TOOLS_SIDE" > archive-side.txt']\n`,
    ".gitignore": "*-side.txt\n",
  });
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();

  // The tools container's exec channel; TOOLS_SIDE marks what it ran. The computers service sets the address.
  const socket = path.join(tempRoot("cloud-tools-sock-"), "tools.sock");
  const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, TOOLS_SIDE: "yes" }, stdio: "ignore" });
  cleanups.push(() => tools.kill());
  await until(() => fs.existsSync(socket));
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
  cleanups.push(() => delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS);

  // The computer's claude: the stand-in behind a wrapper that marks where it ran (no script extension, so the SDK
  // runs it as the CLI binary it is on the image).
  const mark = path.join(tempRoot("cloud-tools-claude-"), "ran");
  const claude = path.join(path.dirname(mark), "claude");
  fs.writeFileSync(claude, `#!/bin/sh\necho "\${TOOLS_SIDE:-runtime}" >> '${mark}'\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`, { mode: 0o755 });

  const config = await makeConfig();
  const provide = Layer.mergeAll(
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide, claudeBinary: claude });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());

  const workspace = await createReady(client, { request_id: "w1", repo: { url: "https://github.com/acme/widgets" }, title: "Fix the thing", engine: "claude-agent", options: { model: MODEL } });
  const notes: Array<string> = [];
  let said = "";
  let done = false;
  await client.attach(workspace.session_id, 0, (event) => {
    if (event.type === "notification") notes.push(event.payload.title);
    if (event.type === "message.done" && event.payload.role === "assistant") said += JSON.stringify(event.payload);
    if (event.type === "turn.done") done = true;
  });
  await until(() => notes.some((title) => /Setup finished/.test(title)), 15_000);
  expect(fs.readFileSync(path.join(checkout, "setup-side.txt"), "utf8").trim()).toBe("yes");

  // A Claude Agent turn: its claude runs in the tools container, as every session CLI there does.
  await client.call("turn.submit", { request_id: "t1", session_id: workspace.session_id, kind: "followup", input: { text: "hello from the computer" } });
  await until(() => done, 60_000);
  expect(said).toContain("hello from the computer");
  expect(fs.readFileSync(mark, "utf8").trim().split("\n")).toEqual(["yes"]);

  // No gh here (tools holds no GitHub credential): git.pr pushes through Cloud's git proxy first, which serves only
  // GitHub, so this checkout without a GitHub origin stops there (computerPullRequests.integration.test.ts opens one).
  expect(await refusalOf(client.call("git.pr", { request_id: "pr", workspace_id: workspace.id, title: "Fix" }))).toMatch(/origin is not a github\.com https URL the git proxy serves/);

  // Park snapshots the work in progress through an index the tools side made.
  fs.writeFileSync(path.join(checkout, "wip.txt"), "wip\n");
  await client.call("session.park", { request_id: "park", session_id: workspace.session_id });
  expect(git("show", `refs/caveman/sessions/${workspace.session_id}:wip.txt`)).toBe("wip");

  await client.call("workspace.archive", { request_id: "a1", workspace_id: workspace.id });
  expect(fs.readFileSync(path.join(checkout, "archive-side.txt"), "utf8").trim()).toBe("yes");
}, 120_000);

// Skipped on Windows: a warm Cloud computer is Linux.
test.skipIf(process.platform === "win32")("warm Cloud computer: serves before its claim, touching no Cloud and running no git in its checkout, and links within a second of it", async () => {
  // Cloud's own token rotation, its grace cut to 2 s: a second mint at the claim would leave the link refused (K14).
  const cloud = await startTestCloud({ graceMs: 2_000 });
  cleanups.push(cloud.close);
  const root = tempRoot("cloud-warm-");
  // What the image's entrypoint hands a warm pod's runtime: an empty link dir the claim's identity lands in.
  const linkDir = path.join(root, "link-run");
  fs.mkdirSync(linkDir, { mode: 0o700 });
  const checkout = makeRepo(tempRoot("cloud-warm-checkout-"), { "README.md": "hello\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: checkout });
  // Every git the runtime runs, with where it ran.
  const shims = path.join(root, "shims");
  const gitLog = path.join(root, "git.log");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.mkdirSync(shims);
  fs.writeFileSync(path.join(shims, "git"), `#!/bin/sh\nprintf '%s|%s\\n' "$(pwd)" "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${shims}${path.delimiter}${PATH}`;
  cleanups.push(() => (process.env.PATH = PATH));
  const computer = cloudComputerFromEnv({ CAVEMAN_CLOUD_LINK_DIR: linkDir, CAVEMAN_RUNTIME_LINK_WAIT: "1", CAVEMAN_WORKSPACE_ROOT: checkout })!;
  const config = await makeConfig();
  // Chat search's on-device model (about 170 MiB loaded) waits for the claim: this stand-in counts its loads.
  let modelLoads = 0;
  const embedder: EmbedderService = {
    model: "stand-in",
    dimensions: 3,
    load: Effect.sync(() => void modelLoads++),
    ready: () => modelLoads > 0,
    isWord: () => false,
    embed: () => Effect.succeed([]),
  };
  const provide = Layer.mergeAll(Layer.succeed(CloudComputer, computer), Layer.succeed(CloudLinkState, {}), Layer.succeed(Embedder, embedder)) as unknown as Layer.Layer<any>;
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());

  // Before the claim it serves; past the link's own 2 s check, nothing reached Cloud (it does not know which Cloud
  // yet) and no git ran in the checkout.
  expect((await client.call("engine.list", {})).engines.map((e: { id: string }) => e.id)).toContain("claude-agent");
  await new Promise((r) => setTimeout(r, 2_500));
  expect((await client.call("cloud.status", {})).state).toBe("off");
  expect([cloud.state.mints, cloud.state.heartbeats, cloud.state.relays, cloud.state.gitRequests].map((list) => list.length)).toEqual([0, 0, 0, 0]);
  const gits = () => (fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf8").trim().split("\n").filter(Boolean) : []);
  expect(gits().filter((line) => line.includes(checkout))).toEqual([]);
  expect(modelLoads).toBe(0);

  // The claim: Cloud's identity for the computer, written as link-bootstrap.mjs writes it (the key, then the record).
  const issued = path.join(root, "issued");
  const identity = await enroll({ dir: issued, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "warm" });
  const claimedAt = Date.now();
  for (const file of [KEY_FILE, RECORD_FILE]) {
    fs.copyFileSync(path.join(issued, file), path.join(linkDir, `${file}.tmp`));
    fs.renameSync(path.join(linkDir, `${file}.tmp`), path.join(linkDir, file));
  }
  let relayAt = 0;
  while (cloud.state.relays.length === 0) {
    if (Date.now() - claimedAt > 10_000) throw new Error("the warm computer never linked");
    await new Promise((r) => setTimeout(r, 5));
  }
  relayAt = Date.now() - claimedAt;
  await until(() => cloud.state.heartbeats.length > 0, 10_000);
  const heartbeatAt = Date.now() - claimedAt;
  console.log(`warm computer: claim -> relay connected ${relayAt} ms, first heartbeat ${heartbeatAt} ms`);
  expect(relayAt).toBeLessThan(1_500);
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 5_000);
  // The model loads half a minute after the claim, off the adopt's path.
  expect(modelLoads).toBe(0);
  await until(() => modelLoads > 0, 45_000);
  expect(Date.now() - claimedAt).toBeGreaterThanOrEqual(30_000);
  // One token for the claim: everything that started with it took the link's (kind K14).
  expect(cloud.state.mints.filter((m) => m.ok && m.runtimeId === identity.runtimeId)).toHaveLength(1);
  // Idle once linked: its mail waits are held, one at a time per channel (kind K10, a core of CPU when they were not).
  const waits = () => cloud.state.chats.waits.filter((w) => w.runtime_id === identity.runtimeId).length;
  let before = waits();
  await new Promise((r) => setTimeout(r, 5_000));
  expect(waits() - before).toBeLessThanOrEqual(4);
  // A Cloud, or a proxy, that answers every wait at once: still at most about one a second per channel.
  cloud.state.chats.waitsAnswerAtOnce = true;
  before = waits();
  await new Promise((r) => setTimeout(r, 5_000));
  cloud.state.chats.waitsAnswerAtOnce = false;
  console.log(`warm computer: ${waits() - before} mail waits in 5 s answered at once`);
  expect(waits() - before).toBeLessThanOrEqual(15);

  // Its chats are on the computer the claim named.
  const workspace = await createReady(client, { request_id: "w1", repo: { url: "https://github.com/acme/widgets" }, title: "Warm start", engine: "claude-agent", options: { model: MODEL } });
  expect(workspace.computer).toMatchObject({ id: identity.computerId, kind: "caveman_cloud" });
}, 120_000);

// Skipped on Windows: a warm Cloud computer is Linux.
test.skipIf(process.platform === "win32")("warm Cloud computer: the runtime asks Cloud's bootstrap route for its identity itself, and links within a second of the claim", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const root = tempRoot("cloud-warm-boot-");
  // The pod's link mount with its bootstrap file (Cloud's origin, a token, the pod's X25519 key), and the runtime's own dir.
  const mount = path.join(root, "link");
  const linkDir = path.join(root, "link-run");
  fs.mkdirSync(mount);
  fs.mkdirSync(linkDir, { mode: 0o700 });
  const podKey = generateKeyPairSync("x25519");
  const podPublic = Buffer.from(podKey.publicKey.export({ format: "jwk" }).x!, "base64url");
  // Cloud's bootstrap route: holds each ask until the claim, then answers with the identity sealed to the pod.
  let sealed: Buffer | undefined;
  const held: Array<() => void> = [];
  let asks = 0;
  const route = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      asks++;
      const answer = () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sealed: sealed!.toString("base64") }));
      if (sealed) return answer();
      held.push(answer);
      setTimeout(() => response.headersSent || response.writeHead(204).end(), 25_000).unref();
    });
  });
  await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (route.closeAllConnections(), route.close(() => resolve()))));
  const bootFile = path.join(mount, "bootstrap.json");
  fs.writeFileSync(bootFile, JSON.stringify({ cloud_url: `http://127.0.0.1:${(route.address() as AddressInfo).port}`, token: "pod-token", key: podKey.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") }));
  const computer = cloudComputerFromEnv({ CAVEMAN_CLOUD_LINK_DIR: linkDir, CAVEMAN_RUNTIME_LINK_WAIT: "1", CAVEMAN_RUNTIME_LINK_BOOTSTRAP: bootFile, CAVEMAN_WORKSPACE_ROOT: makeRepo(tempRoot("cloud-warm-boot-checkout-"), { "README.md": "hi\n" }) })!;
  const config = await makeConfig();
  const provide = Layer.mergeAll(Layer.succeed(CloudComputer, computer), Layer.succeed(CloudLinkState, {})) as unknown as Layer.Layer<any>;
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());

  // Serving and asking, unclaimed.
  await until(() => asks > 0, 10_000);
  expect((await client.call("cloud.status", {})).state).toBe("off");
  expect(fs.readdirSync(linkDir)).toEqual([]);

  // The claim: Cloud's identity for the computer, sealed to the pod's key, answers the held ask.
  const issued = path.join(root, "issued");
  await enroll({ dir: issued, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "warm" });
  const claimedAt = Date.now();
  sealed = seal(podPublic, { [KEY_FILE]: fs.readFileSync(path.join(issued, KEY_FILE)), [RECORD_FILE]: fs.readFileSync(path.join(issued, RECORD_FILE)) });
  for (const answer of held.splice(0)) answer();
  while (cloud.state.relays.length === 0) {
    if (Date.now() - claimedAt > 10_000) throw new Error("the warm computer never linked");
    await new Promise((r) => setTimeout(r, 5));
  }
  const linked = Date.now() - claimedAt;
  console.log(`warm computer over the bootstrap route: claim -> relay connected ${linked} ms`);
  expect(linked).toBeLessThan(1_500);
  expect(fs.statSync(path.join(linkDir, KEY_FILE)).mode & 0o777).toBe(0o600);
}, 120_000);

/** What the computers service does at a claim (Caveman Cloud Sandboxes Seal, format 1). */
function seal(podPublic: Buffer, files: Record<string, Buffer>): Buffer {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x!, "base64url");
  const pod = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: podPublic.toString("base64url") }, format: "jwk" });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: pod });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, podPublic]), SEAL_INFO, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(SEAL_INFO));
  const body = JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes.toString("base64")])));
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), ephemeralRaw, nonce, ciphertext, cipher.getAuthTag()]);
}
