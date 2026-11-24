// A Cloud computer that booted with an empty checkout (its repository's snapshot was not built yet, kind run K1):
// the first chat clones the repository through Cloud's git proxy on the computer's own link before it checks out its
// branch, with git in the tools container and the remote reached only by the runtime's mirror; a clone that cannot
// happen fails the chat in one plain sentence. Real runtime, tools exec channel, `git http-backend` as GitHub.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud, type TestCloud } from "./testCloud.ts";
import { TOOLS_EXEC } from "./tools.ts";

let cloud: TestCloud;
let tools: ChildProcess;
let bare: string;
// Skipped on Windows: a Cloud computer is Linux, and its git runs in a tools container over a Unix socket.
const onComputer = test.skipIf(process.platform === "win32");
const cleanups: Array<() => unknown> = [];
const gitIn = (cwd: string, ...args: Array<string>) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(async () => {
  const socket = path.join(tempRoot("empty-checkout-tools-"), "tools.sock");
  tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, TOOLS_SIDE: "yes" }, stdio: "ignore" });
  cleanups.push(() => tools.kill());
  for (const deadline = Date.now() + 10_000; !fs.existsSync(socket) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 50));
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
  cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // GitHub behind the git proxy: acme/widgets with main (its HEAD) and dev.
  const remotes = tempRoot("empty-checkout-github-");
  bare = path.join(remotes, "acme/widgets.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const author = makeRepo(tempRoot("empty-checkout-author-"), { "README.md": "widgets\n" });
  gitIn(author, "push", "-q", bare, "main");
  gitIn(author, "checkout", "-q", "-b", "dev");
  fs.writeFileSync(path.join(author, "dev.txt"), "dev\n");
  gitIn(author, "add", "dev.txt");
  gitIn(author, "-c", "user.name=A", "-c", "user.email=a@example.com", "commit", "-qm", "dev work");
  gitIn(author, "push", "-q", bare, "dev");
  cloud.state.gitBackend = remotes;
}, 60_000);

afterAll(async () => {
  delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A Cloud computer whose checkout directory is there and empty, as the computers service mounts it before a snapshot. */
async function emptyComputer() {
  const linkDir = path.join(tempRoot("empty-checkout-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  const checkout = path.join(tempRoot("empty-checkout-"), "workspace");
  fs.mkdirSync(checkout);
  const config = await makeConfig();
  const provide = Layer.mergeAll(
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  const client = connect(runtime.url, runtime.token);
  cleanups.push(async () => {
    client.close();
    await runtime.close();
  });
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);
  return { client, checkout };
}

onComputer("an empty checkout is cloned through the git proxy before the chat's branch, from the repository's default branch", async () => {
  const { client, checkout } = await emptyComputer();
  const before = cloud.state.gitRequests.length;
  const workspace = await createReady(client, { request_id: "w-empty", repo: { url: "https://github.com/acme/widgets" }, title: "First chat", engine: "claude-agent", options: { model: MODEL } });
  expect(workspace.status).not.toBe("failed");
  expect(workspace.base_ref).toBe("main");
  expect(workspace.branch).toMatch(/^caveman\/first-chat-/);
  // The checkout is the repository now, on the chat's branch, cut from GitHub's main.
  expect(gitIn(checkout, "symbolic-ref", "--short", "HEAD")).toBe(workspace.branch);
  expect(gitIn(checkout, "rev-parse", "HEAD")).toBe(gitIn(bare, "rev-parse", "main"));
  expect(fs.readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("widgets\n");
  expect(gitIn(checkout, "remote", "get-url", "origin")).toBe("https://github.com/acme/widgets.git");
  // Through Cloud's git proxy, on the computer's own runtime token.
  const viaProxy = cloud.state.gitRequests.slice(before);
  expect(viaProxy.length).toBeGreaterThan(0);
  for (const request of viaProxy) {
    expect(request.url.startsWith("/relay/v1/git/acme/widgets.git/")).toBe(true);
    expect(request.authorization).toMatch(/^Bearer ccrt_/);
  }
}, 120_000);

onComputer("a chat that names its base on an empty computer starts from that branch", async () => {
  const { client, checkout } = await emptyComputer();
  const workspace = await createReady(client, { request_id: "w-dev", repo: { url: "https://github.com/acme/widgets" }, base_ref: "dev", title: "On dev", engine: "claude-agent", options: { model: MODEL } });
  expect(workspace.status).not.toBe("failed");
  expect(workspace.base_ref).toBe("dev");
  expect(gitIn(checkout, "rev-parse", "HEAD")).toBe(gitIn(bare, "rev-parse", "dev"));
  expect(fs.existsSync(path.join(checkout, "dev.txt"))).toBe(true);
}, 120_000);

onComputer("a repository the git proxy cannot clone fails the chat in one plain sentence, and leaves the checkout empty", async () => {
  const { client, checkout } = await emptyComputer();
  const workspace = await createReady(client, { request_id: "w-missing", repo: { url: "https://github.com/acme/missing" }, title: "Nowhere", engine: "claude-agent", options: { model: MODEL } });
  expect(workspace.status).toBe("failed");
  const events: Array<SessionEvent> = [];
  await client.attach(workspace.session_id, 0, (event) => events.push(event));
  await until(() => events.some((e) => e.type === "tool.done"), 10_000);
  const failed = events.find((e) => e.type === "tool.done") as Extract<SessionEvent, { type: "tool.done" }>;
  const reason = String((failed.payload as { error?: string }).error);
  // git's own words, without the proxy URL it quotes.
  expect(reason).toBe("Could not clone acme/missing into this Cloud computer through Caveman's git proxy: repository not found.");
  // No repository was made: the next chat for the right repository clones it.
  expect(fs.existsSync(path.join(checkout, ".git"))).toBe(false);
}, 120_000);

onComputer("a clone that stops halfway takes its .git with it, so the next chat clones afresh", async () => {
  const { client, checkout } = await emptyComputer();
  // The default branch comes down, the named base does not exist.
  const broken = await createReady(client, { request_id: "w-nope", repo: { url: "https://github.com/acme/widgets" }, base_ref: "nope", title: "No base", engine: "claude-agent", options: { model: MODEL } });
  expect(broken.status).toBe("failed");
  const events: Array<SessionEvent> = [];
  await client.attach(broken.session_id, 0, (event) => events.push(event));
  await until(() => events.some((e) => e.type === "tool.done"), 10_000);
  const failed = events.find((e) => e.type === "tool.done") as Extract<SessionEvent, { type: "tool.done" }>;
  expect(String((failed.payload as { error?: string }).error)).toMatch(/^Could not clone acme\/widgets into this Cloud computer through Caveman's git proxy: [^.]*nope[^.]*\.$/);
  expect(fs.readdirSync(checkout)).toEqual([]);
  await client.call("workspace.archive", { request_id: "w-nope-archive", workspace_id: broken.id });
  const next = await createReady(client, { request_id: "w-again", repo: { url: "https://github.com/acme/widgets" }, title: "Again", engine: "claude-agent", options: { model: MODEL } });
  expect(next.status).not.toBe("failed");
  expect(gitIn(checkout, "rev-parse", "HEAD")).toBe(gitIn(bare, "rev-parse", "main"));
}, 120_000);
