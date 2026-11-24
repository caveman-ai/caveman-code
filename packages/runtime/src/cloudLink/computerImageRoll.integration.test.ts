// A Cloud computer that wakes on a newer image (Cloud rolls a sleeping computer to the install's current image and
// says which in CAVEMAN_COMPUTER_IMAGE): setup runs once more though the snapshot still matches, since what it built
// may lean on the old image's libraries; on the same image, and on a computer's first image, the snapshot is trusted.
// The image setup last ran on is kept on the computer's volume, so a restart does not run it again.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";

// Skipped on Windows: a Cloud computer is Linux; with its git in a tools container over a Unix socket, or else only
// where owner uid and mode bits show the agent cannot write the checkout (gitTrusts).
const onComputer = test.skipIf(process.platform === "win32");

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  delete process.env.CAVEMAN_COMPUTER_IMAGE;
});

onComputer("setup runs once after the computer wakes on a newer image, and not on its first image, the same one, or a restart", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("image-roll-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  // What the snapshot build leaves: the repo at its commit and the git-excluded marker that its setup ran.
  const checkout = makeRepo(tempRoot("image-roll-"), {
    ".caveman/computer.toml": '[setup]\nrun = ["echo ran >> setup-ran.txt"]\ninputs = ["package.json"]\n',
    "package.json": "{}\n",
    ".gitignore": "setup-ran.txt\n",
  });
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  fs.appendFileSync(path.join(checkout, ".git/info/exclude"), ".caveman/snapshot.json\n");
  fs.writeFileSync(path.join(checkout, ".caveman/snapshot.json"), JSON.stringify({ hash: "h", commit: git("rev-parse", "HEAD"), branch: "main", built_at: new Date().toISOString() }));
  const ran = () => (fs.existsSync(path.join(checkout, "setup-ran.txt")) ? fs.readFileSync(path.join(checkout, "setup-ran.txt"), "utf8").trim().split("\n").length : 0);

  const config = await makeConfig();
  const provide = Layer.mergeAll(
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  let runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  let client = connect(runtime.url, runtime.token);
  cleanups.push(async () => {
    client.close();
    await runtime.close();
  });

  /** A chat on the computer (one at a time: the last is archived), and the setup line it was told. */
  let n = 0;
  const chat = async () => {
    for (const w of (await client.call("workspace.list", {})).workspaces) await client.call("workspace.archive", { request_id: `a-${w.id}`, workspace_id: w.id });
    n += 1;
    const workspace = await createReady(client, { request_id: `w-${n}`, repo: { url: "https://github.com/acme/widgets" }, title: `Chat ${n}`, engine: "claude-agent", options: { model: MODEL } });
    const notes: Array<string> = [];
    await client.attach(workspace.session_id, 0, (event: SessionEvent) => {
      if (event.type === "notification") notes.push(event.payload.title);
    });
    await until(() => notes.some((title) => /^Setup (skipped|finished|failed)/.test(title)), 20_000);
    return notes;
  };

  // Its first image: the snapshot is trusted.
  process.env.CAVEMAN_COMPUTER_IMAGE = "registry.example/caveman/code@sha256:aaaa";
  expect(await chat()).toEqual([expect.stringMatching(/^Setup skipped/)]);
  expect(ran()).toBe(0);

  // Woke on a newer image: setup runs again, once, and says why.
  process.env.CAVEMAN_COMPUTER_IMAGE = "registry.example/caveman/code@sha256:bbbb";
  const rolled = await chat();
  expect(rolled).toContain("Setup runs again: this computer woke on a newer image");
  expect(rolled.some((title) => /^Setup finished/.test(title))).toBe(true);
  expect(ran()).toBe(1);

  // The same image again, and after a restart of the runtime: trusted, not run.
  expect(await chat()).toEqual([expect.stringMatching(/^Setup skipped/)]);
  client.close();
  await runtime.close();
  runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  client = connect(runtime.url, runtime.token);
  expect(await chat()).toEqual([expect.stringMatching(/^Setup skipped/)]);
  expect(ran()).toBe(1);
}, 180_000);

// With a snapshot its setup was skipped on the first image; without one (a computer that booted before its repository's
// snapshot was built, or a chat moved onto one) it ran. Either way the roll runs it again and the chat says why.
onComputer.each([
  { snapshot: true, first: "Setup skipped" },
  { snapshot: false, first: "Setup finished" },
])("the chat a computer holds when it boots on a newer image runs its setup again then, once, and says why (snapshot: $snapshot)", async ({ snapshot, first }) => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("image-held-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  const checkout = makeRepo(tempRoot("image-held-"), {
    ".caveman/computer.toml": '[setup]\nrun = ["echo ran >> setup-ran.txt"]\ninputs = ["package.json"]\n',
    "package.json": "{}\n",
    ".gitignore": "setup-ran.txt\n",
  });
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  if (snapshot) {
    fs.appendFileSync(path.join(checkout, ".git/info/exclude"), ".caveman/snapshot.json\n");
    fs.writeFileSync(path.join(checkout, ".caveman/snapshot.json"), JSON.stringify({ hash: "h", commit: git("rev-parse", "HEAD"), branch: "main", built_at: new Date().toISOString() }));
  }
  const ran = () => (fs.existsSync(path.join(checkout, "setup-ran.txt")) ? fs.readFileSync(path.join(checkout, "setup-ran.txt"), "utf8").trim().split("\n").length : 0);
  const ranFirst = snapshot ? 0 : 1;

  const config = await makeConfig();
  const provide = Layer.mergeAll(
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let client: ReturnType<typeof connect> | undefined;
  const stop = async () => {
    client?.close();
    await runtime?.close();
    runtime = undefined;
  };
  cleanups.push(stop);
  /** The runtime starting on `image`, as the computer boots on it: the setup notes its chat has had, all of them. */
  const boot = async (image: string, sessionId?: string) => {
    await stop();
    process.env.CAVEMAN_COMPUTER_IMAGE = image;
    runtime = await startRuntime(config, "fake-claude", undefined, { provide });
    client = connect(runtime.url, runtime.token);
    const notes: Array<string> = [];
    if (sessionId !== undefined)
      await client.attach(sessionId, 0, (event: SessionEvent) => {
        if (event.type === "notification" && /^Setup /.test(event.payload.title)) notes.push(event.payload.title);
      });
    return notes;
  };

  // Made on the computer's first image.
  await boot("registry.example/caveman/code@sha256:aaaa");
  const workspace = await createReady(client!, { request_id: "w-1", repo: { url: "https://github.com/acme/widgets" }, title: "Held", engine: "claude-agent", options: { model: MODEL } });
  const made: Array<string> = [];
  await client!.attach(workspace.session_id, 0, (event: SessionEvent) => {
    if (event.type === "notification") made.push(event.payload.title);
  });
  await until(() => made.some((title) => /^Setup (skipped|finished|failed)/.test(title)), 20_000);
  expect(made.filter((title) => /^Setup /.test(title))).toEqual([expect.stringMatching(new RegExp(`^${first}`))]);
  expect(ran()).toBe(ranFirst);

  // The computer boots on a newer image with the chat on it: its setup runs again now, and says why.
  const rolled = await boot("registry.example/caveman/code@sha256:bbbb", workspace.session_id);
  await until(() => rolled.length === 3, 20_000);
  expect(rolled).toEqual([expect.stringMatching(new RegExp(`^${first}`)), "Setup runs again: this computer woke on a newer image", expect.stringMatching(/^Setup finished/)]);
  expect(ran()).toBe(ranFirst + 1);

  // Booted again on that image: setup ran on it already.
  const again = await boot("registry.example/caveman/code@sha256:bbbb", workspace.session_id);
  await until(() => again.length === 3, 20_000);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(again).toEqual(rolled);
  expect(ran()).toBe(ranFirst + 1);
}, 180_000);
