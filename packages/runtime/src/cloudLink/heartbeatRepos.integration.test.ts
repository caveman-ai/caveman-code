// Repos in the heartbeat (RESEARCH-W2 decision 30) from a real runtime on the test Cloud: a Mac names the checkouts it
// has, its projects and the ones discovery found in its home, as soon as it knows them. A checkout discovery finds is
// in the list Cloud keeps within moments of the runtime's start, never only at the next 5-minute look (Cloud would
// refuse a move to this Mac until then, though the Mac itself takes it).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import { makeConfig, makeRepo, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { repoHash } from "./heartbeatRepos.ts";
import { CloudLinkState } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("a checkout discovery finds in the Mac's home is in its heartbeat's repos at once, before any chat opens it", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const home = tempRoot("repos-home-");
  const checkout = makeRepo(path.join(home, "code", "found"), { "README.md": "found by discovery\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/found.git"], { cwd: checkout });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const provide = Layer.mergeAll(Layer.succeed(CloudLinkState, {}), Layer.succeed(HostProcess.HomeDirectory, home), Layer.succeed(HostProcess.Environment, {}));
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: provide as unknown as Layer.Layer<any> });
  cleanups.push(() => runtime.close());
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Studio" });
  await local.call("settings.set", { request_id: "rc", settings: { remote_control: true, sync_chats: true } });
  const hash = repoHash("https://github.com/acme/found")!;
  const startedAt = Date.now();
  await until(() => cloud.state.heartbeats.some((h) => h.repos?.some((r) => r.remote_hash === hash)), 30_000);
  console.log(`repos in the heartbeat (test Cloud, lab-only): a discovered checkout reached Cloud ${Date.now() - startedAt} ms after enrolling`);
  // The first list Cloud got already names it: none of the projects alone goes before discovery's first pass (Cloud
  // would refuse this Mac a chat in that repository, which the Mac itself takes).
  expect(cloud.state.heartbeats.find((h) => h.repos !== undefined)?.repos?.some((r) => r.remote_hash === hash)).toBe(true);
  // Its HEAD, read from the checkout's own files.
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  expect(cloud.state.heartbeats.flatMap((h) => h.repos ?? []).find((r) => r.remote_hash === hash)?.head).toBe(head);
  expect((await local.call("project.list", {})).projects).toHaveLength(0);
}, 120_000);

test("a checkout from elsewhere whose HEAD points outside its .git never has that file read: its head goes as none", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const home = tempRoot("repos-home-");
  // A folder whose .git came from somewhere else (an archive), with a GitHub origin and a HEAD that climbs out of
  // refs/heads to a file of 40 hex characters (as many tokens are), and one whose branch file links to such a file.
  const secret = path.join(home, "code", "token.txt");
  const climbing = makeRepo(path.join(home, "code", "climbing"), { "README.md": "from an archive\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/climbing.git"], { cwd: climbing });
  const linked = makeRepo(path.join(home, "code", "linked"), { "README.md": "from an archive\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/linked.git"], { cwd: linked });
  fs.writeFileSync(secret, `${"d".repeat(40)}\n`);
  fs.writeFileSync(path.join(climbing, ".git", "HEAD"), "ref: refs/heads/../../../../token.txt\n");
  const branch = fs.readFileSync(path.join(linked, ".git", "HEAD"), "utf8").trim().slice("ref: refs/heads/".length);
  fs.rmSync(path.join(linked, ".git", "refs", "heads", branch));
  fs.symlinkSync(secret, path.join(linked, ".git", "refs", "heads", branch));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const provide = Layer.mergeAll(Layer.succeed(CloudLinkState, {}), Layer.succeed(HostProcess.HomeDirectory, home), Layer.succeed(HostProcess.Environment, {}));
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: provide as unknown as Layer.Layer<any> });
  cleanups.push(() => runtime.close());
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Studio" });
  await local.call("settings.set", { request_id: "rc", settings: { remote_control: true, sync_chats: true } });
  const sent = (remote: string) => cloud.state.heartbeats.flatMap((h) => h.repos ?? []).find((r) => r.remote_hash === repoHash(remote));
  await until(() => sent("https://github.com/acme/climbing") !== undefined && sent("https://github.com/acme/linked") !== undefined, 30_000);
  expect(sent("https://github.com/acme/climbing")?.head).toBe("");
  expect(sent("https://github.com/acme/linked")?.head).toBe("");
  expect(JSON.stringify(cloud.state.heartbeats)).not.toContain("d".repeat(40));
}, 120_000);

test("a checkout from elsewhere whose refs/heads links to a folder outside never has that folder's files read as its branch (m-o)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const home = tempRoot("repos-home-");
  // Outside the checkout, a folder holding a file named like a branch, of 64 hex characters (a raw private key).
  const outside = path.join(home, "keys");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "wallet"), `${"e".repeat(64)}\n`);
  const archive = makeRepo(path.join(home, "code", "archive"), { "README.md": "from an archive\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/archive.git"], { cwd: archive });
  fs.writeFileSync(path.join(archive, ".git", "HEAD"), "ref: refs/heads/wallet\n");
  fs.rmSync(path.join(archive, ".git", "refs", "heads"), { recursive: true });
  fs.symlinkSync(outside, path.join(archive, ".git", "refs", "heads"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const provide = Layer.mergeAll(Layer.succeed(CloudLinkState, {}), Layer.succeed(HostProcess.HomeDirectory, home), Layer.succeed(HostProcess.Environment, {}));
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: provide as unknown as Layer.Layer<any> });
  cleanups.push(() => runtime.close());
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Studio" });
  await local.call("settings.set", { request_id: "rc", settings: { remote_control: true, sync_chats: true } });
  const sent = () => cloud.state.heartbeats.flatMap((h) => h.repos ?? []).find((r) => r.remote_hash === repoHash("https://github.com/acme/archive"));
  await until(() => sent() !== undefined, 30_000);
  expect(sent()?.head).toBe("");
  expect(JSON.stringify(cloud.state.heartbeats)).not.toContain("e".repeat(64));
}, 120_000);

// The list is for Cloud's moves and pulls to this Mac: one whose moves are off takes none (acceptMove refuses every
// one), so its heartbeat names no repository, its signed-in Remote control notwithstanding. Cloud keeps the last list a
// heartbeat named while later ones name none (runtime.go HeartbeatRepos: an absent field keeps it), so turning moves off
// after naming some names an empty list, and Cloud forgets them.
test("a Mac whose moves are off names no repository in its heartbeat; turning them on names them at once, and off again empties what Cloud keeps", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const home = tempRoot("repos-home-");
  const checkout = makeRepo(path.join(home, "code", "kept"), { "README.md": "not Cloud's to know\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/kept.git"], { cwd: checkout });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const provide = Layer.mergeAll(Layer.succeed(CloudLinkState, {}), Layer.succeed(HostProcess.HomeDirectory, home), Layer.succeed(HostProcess.Environment, {}));
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: provide as unknown as Layer.Layer<any> });
  cleanups.push(() => runtime.close());
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Studio" });
  await local.call("settings.set", { request_id: "rc", settings: { remote_control: true } });
  await until(() => cloud.state.heartbeats.length >= 1, 30_000);
  // Long enough for discovery's first pass, after which a Mac with moves on beats again with its list at once.
  await new Promise((r) => setTimeout(r, 5_000));
  expect(cloud.state.heartbeats.some((h) => h.repos !== undefined)).toBe(false);
  await local.call("settings.set", { request_id: "sync-on", settings: { sync_chats: true } });
  const hash = repoHash("https://github.com/acme/kept")!;
  await until(() => cloud.state.heartbeats.some((h) => h.repos?.some((r) => r.remote_hash === hash)), 30_000);
  // What Cloud keeps for the runtime: the list of the last heartbeat that named one.
  const kept = () => cloud.state.heartbeats.findLast((h) => h.repos !== undefined && h.refused !== true)?.repos;
  expect(kept()?.some((r) => r.remote_hash === hash)).toBe(true);
  await local.call("settings.set", { request_id: "sync-off", settings: { sync_chats: false } });
  const after = cloud.state.heartbeats.length;
  await until(() => kept()?.length === 0, 30_000);
  await until(() => cloud.state.heartbeats.length > after + 1, 60_000);
  await new Promise((r) => setTimeout(r, 1_000));
  // Nothing of the checkout is named again, and what Cloud keeps stays empty.
  expect(cloud.state.heartbeats.slice(after).some((h) => h.repos?.some((r) => r.remote_hash === hash))).toBe(false);
  expect(kept()).toEqual([]);
}, 180_000);
