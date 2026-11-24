// Pull requests from a Cloud computer's own chats (DESIGN 2026-10-21 S9), end to end on the real runtime against the
// stand-in Cloud. The computer runs git in its tools container (a tools server over a socket) and holds no GitHub
// login: its branch goes through the runtime's mirror to Cloud's git proxy (`git http-backend` over a bare
// repository, taking only the runtime's token), and Cloud acts as the repository's App on the computer's own link
// identity: it opens git.pr's pull request, reads a pull request a chat starts on, moves that pull request's branch
// after each push (a fork's gets one follow-up pull request instead), and answers the sidebar's pill.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud, type TestCloud } from "./testCloud.ts";
import { TOOLS_EXEC } from "./tools.ts";

let cloud: TestCloud;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let tools: ChildProcess;
let bare: string;
let checkout: string;
// Skipped on Windows: a Cloud computer is Linux; with its git in a tools container over a Unix socket, or else only
// where owner uid and mode bits show the agent cannot write the checkout (gitTrusts).
const onComputer = test.skipIf(process.platform === "win32");

const cleanups: Array<() => unknown> = [];

const gitIn = (cwd: string, ...args: Array<string>) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const refusalOf = (promise: Promise<unknown>) =>
  promise.then(() => "ok", (error: { error?: { message?: string; data?: { reason?: string } } }) => `${error.error?.data?.reason}: ${error.error?.message}`);
/** A commit on top of the checkout's branch, as the agent makes one in the tools container. */
const agentCommits = (file: string, text: string) => {
  fs.writeFileSync(path.join(checkout, file), text);
  gitIn(checkout, "add", file);
  gitIn(checkout, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-qm", `Change ${file}`);
  return gitIn(checkout, "rev-parse", "HEAD");
};
/** A pull request on GitHub: `branch` one commit past main, also as refs/pull/N/head (where GitHub keeps every head). */
const pullRequestOnGitHub = (number: number, branch: string, file: string) => {
  const scratch = makeRepo(tempRoot("pr-author-"), { "README.md": "hi\n" });
  gitIn(scratch, "fetch", "-q", bare, "main");
  gitIn(scratch, "checkout", "-q", "-B", branch, "FETCH_HEAD");
  fs.writeFileSync(path.join(scratch, file), `${branch}\n`);
  gitIn(scratch, "add", file);
  gitIn(scratch, "-c", "user.name=Author", "-c", "user.email=author@example.com", "commit", "-qm", `Work on ${branch}`);
  gitIn(scratch, "push", "-q", bare, `HEAD:refs/heads/${branch}`, `HEAD:refs/pull/${number}/head`);
  return gitIn(scratch, "rev-parse", "HEAD");
};
const archiveAll = async () => {
  for (const w of (await client.call("workspace.list", {})).workspaces) await client.call("workspace.archive", { request_id: `archive-${w.id}`, workspace_id: w.id });
};

beforeAll(async () => {
  // The tools container: every git the runtime runs goes there, as on a Cloud computer.
  const socket = path.join(tempRoot("computer-pr-tools-"), "tools.sock");
  tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, TOOLS_SIDE: "yes" }, stdio: "ignore" });
  cleanups.push(() => tools.kill());
  for (const deadline = Date.now() + 10_000; !fs.existsSync(socket) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 50));
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;

  cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // GitHub, as Cloud's git proxy reaches it: a bare repository the proxy serves to the runtime's token.
  const remotes = tempRoot("computer-pr-github-");
  bare = path.join(remotes, "acme/widgets.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  cloud.state.gitBackend = remotes;

  const linkDir = path.join(tempRoot("computer-pr-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  checkout = makeRepo(tempRoot("computer-pr-checkout-"), { "README.md": "hi\n" });
  gitIn(checkout, "push", "-q", bare, "main");
  gitIn(checkout, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  const config = await makeConfig();
  const provide = Layer.mergeAll(
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  cleanups.push(runtime.close);
  client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);
}, 60_000);

afterAll(async () => {
  delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

onComputer("git.pr on a Cloud computer: the branch goes through the git proxy and Cloud opens the pull request for the chat, shown at once", async () => {
  // The computer says what it offers: pull requests through Cloud.
  expect((await client.call("cloud.status", {})).capabilities).toMatchObject({ pull_requests: true });
  // Its heartbeat says which engines run on the person's own login here (none on this stand-in computer: no CLI
  // signed in, no vault key), as soon as it knows, without waiting for the next 30 s beat.
  await until(() => cloud.state.heartbeats.some((h) => h.engines_signed_in !== undefined), 10_000);
  expect(cloud.state.heartbeats.find((h) => h.engines_signed_in !== undefined)!.engines_signed_in).toEqual([]);
  const workspace = await createReady(client, { request_id: "w-pr", repo: { url: "https://github.com/acme/widgets" }, title: "Fix the thing", engine: "claude-agent", options: { model: MODEL } });
  const sha = agentCommits("fix.txt", "fixed\n");

  const pr = await client.call("git.pr", { request_id: "open-1", workspace_id: workspace.id, title: "Fix the thing", body: "What changed." });
  expect(pr).toEqual({ number: expect.any(Number), url: `https://github.com/acme/widgets/pull/${pr.number}`, state: "open" });
  // Pushed through the mirror and the proxy: GitHub has the chat's branch at the commit.
  expect(gitIn(bare, "rev-parse", `refs/heads/${workspace.branch}`)).toBe(sha);
  // Cloud got the computer's own call (a runtime token; a person's would be refused) with what GitHub needs.
  expect(cloud.state.automations.pullRequests).toEqual([
    expect.objectContaining({ session_id: workspace.session_id, repo: "acme/widgets", head: workspace.branch, base: "main", sha, title: "Fix the thing", draft: false, idempotency_key: "open-1" }),
  ]);
  expect(cloud.state.automations.pullRequests[0]!.body.startsWith("What changed.")).toBe(true);
  // The record carries it before any lookup: the sidebar's pill is there now.
  expect((await client.call("workspace.get", { workspace_id: workspace.id })).pull_request).toEqual(pr);

  // Asked again (a retry), still one pull request.
  expect(await client.call("git.pr", { request_id: "open-1", workspace_id: workspace.id, title: "Fix the thing", body: "What changed." })).toEqual(pr);
  expect(cloud.state.automations.pullRequests).toHaveLength(1);

  // The pill follows Cloud's pull request table (fed by the App's webhooks), its checks included: the computer holds
  // no GitHub login to read them with, so Cloud's word is how a chat here learns its pull request went red.
  cloud.state.chats.pullRequests.set(workspace.branch, { number: pr.number, url: pr.url, state: "open", checks: "fail" });
  await client.call("turn.submit", { request_id: "t-red", session_id: workspace.session_id, kind: "followup", input: { text: "how are the checks?" } });
  await until(async () => (await client.call("workspace.get", { workspace_id: workspace.id })).pull_request?.checks === "failing", 30_000);
  expect((await client.call("workspace.get", { workspace_id: workspace.id })).pull_request).toEqual({ ...pr, checks: "failing" });
  // Merged on GitHub with its checks green: merged and passing here after a turn. No checks ("none") says nothing.
  cloud.state.chats.pullRequests.set(workspace.branch, { number: pr.number, url: pr.url, state: "merged", checks: "pass" });
  await client.call("turn.submit", { request_id: "t-pill", session_id: workspace.session_id, kind: "followup", input: { text: "anything else?" } });
  await until(async () => (await client.call("workspace.get", { workspace_id: workspace.id })).pull_request?.state === "merged", 30_000);
  expect((await client.call("workspace.get", { workspace_id: workspace.id })).pull_request).toEqual({ ...pr, state: "merged", checks: "passing" });
  cloud.state.chats.pullRequests.set(workspace.branch, { number: pr.number, url: pr.url, state: "merged", checks: "none" });
  await client.call("turn.submit", { request_id: "t-none", session_id: workspace.session_id, kind: "followup", input: { text: "and now?" } });
  await until(async () => (await client.call("workspace.get", { workspace_id: workspace.id })).pull_request?.checks === undefined, 30_000);
  await archiveAll();
}, 120_000);

onComputer("a chat starts on a pull request: Cloud reads it, its head comes into caveman/pr-N-*, and each push moves the pull request's branch", async () => {
  const head = pullRequestOnGitHub(7, "feature", "feature.txt");
  cloud.state.pulls.byNumber.set(7, { repo: "acme/widgets", title: "Feature", base: "main", head_ref: "feature", head_sha: head, head_repo: "acme/widgets", is_fork: false, maintainer_can_modify: true, state: "open" });

  // A client that picked a computer of another repository: refused before Cloud reads a #7 here.
  expect(await refusalOf(client.call("workspace.create", { request_id: "w-wrong-repo", repo: { url: "https://github.com/acme/other" }, engine: "claude-agent", options: { model: MODEL }, pull_request: { number: 7 } }))).toBe(
    "invalid_params: This Cloud computer holds acme/widgets, not acme/other. Start the chat on a Cloud computer for acme/other.",
  );
  expect(cloud.state.pulls.infoCalls).toEqual([]);
  const workspace = await createReady(client, { request_id: "w-on-7", repo: { url: "https://github.com/acme/widgets" }, engine: "claude-agent", options: { model: MODEL }, pull_request: { number: 7 } });
  expect(workspace.status).not.toBe("failed");
  expect(workspace.branch).toMatch(/^caveman\/pr-7-[0-9a-f]{6}$/);
  expect(workspace.base_ref).toBe("main");
  expect(workspace.pull_request).toEqual({ number: 7, url: "https://github.com/acme/widgets/pull/7", state: "open" });
  expect(cloud.state.pulls.infoCalls).toEqual([{ session_id: workspace.session_id, number: 7 }]);
  // Cloud knew the session on this computer before it was asked about #7 (it refuses any other, as Cloud does).
  expect(cloud.state.chats.sessions.get(workspace.session_id)).toMatchObject({ repo: "acme/widgets" });
  expect(cloud.state.pulls.unknownSessions).toEqual([]);
  // The checkout is on the chat's own branch, at the pull request's head.
  expect(gitIn(checkout, "symbolic-ref", "--short", "HEAD")).toBe(workspace.branch);
  expect(gitIn(checkout, "rev-parse", "HEAD")).toBe(head);

  const first = agentCommits("review-fix.txt", "one\n");
  expect(await client.call("git.push", { request_id: "push-1", workspace_id: workspace.id })).toEqual({ branch: workspace.branch, sha: first });
  // Only caveman/* was pushed; Cloud moved #7's own branch to it, a fast-forward from the head the chat fetched.
  expect(gitIn(bare, "rev-parse", `refs/heads/${workspace.branch}`)).toBe(first);
  expect(gitIn(bare, "rev-parse", "refs/heads/feature")).toBe(first);
  expect(cloud.state.pulls.updateHeads).toEqual([{ number: 7, session_id: workspace.session_id, sha: first, expected_head_sha: head, moved: true }]);

  // The next push carries on from where the last one left the pull request.
  const second = agentCommits("review-fix.txt", "two\n");
  await client.call("git.push", { request_id: "push-2", workspace_id: workspace.id });
  expect(cloud.state.pulls.updateHeads.at(-1)).toEqual({ number: 7, session_id: workspace.session_id, sha: second, expected_head_sha: first, moved: true });
  expect(gitIn(bare, "rev-parse", "refs/heads/feature")).toBe(second);
  // git.pr on it is that pull request, moved, not a new one.
  expect(await client.call("git.pr", { request_id: "pr-on-7", workspace_id: workspace.id, title: "ignored" })).toEqual({ number: 7, url: "https://github.com/acme/widgets/pull/7", state: "open" });
  expect(cloud.state.automations.pullRequests.filter((p) => p.head === workspace.branch)).toEqual([]);

  // Cloud moved #7 to a push of this chat's, and the runtime stopped before it noted so: the next push is refused as
  // "head moved", sees the head is a commit its branch holds, and moves it on from there (no second refusal shown).
  const lost = agentCommits("review-fix.txt", "lost\n");
  gitIn(checkout, "push", "-q", bare, `HEAD:refs/heads/${workspace.branch}`, "HEAD:refs/heads/feature");
  cloud.state.pulls.byNumber.get(7)!.head_sha = lost;
  const after = agentCommits("review-fix.txt", "after\n");
  await client.call("git.push", { request_id: "push-after-crash", workspace_id: workspace.id });
  expect(cloud.state.pulls.updateHeads.slice(-2)).toEqual([
    { number: 7, session_id: workspace.session_id, sha: after, expected_head_sha: second, moved: false },
    { number: 7, session_id: workspace.session_id, sha: after, expected_head_sha: lost, moved: true },
  ]);
  expect(gitIn(bare, "rev-parse", "refs/heads/feature")).toBe(after);

  // Someone pushed to #7 meanwhile: the chat's branch still goes up, the pull request is not moved over their work.
  cloud.state.pulls.byNumber.get(7)!.head_sha = "f".repeat(40);
  const third = agentCommits("review-fix.txt", "three\n");
  expect(await refusalOf(client.call("git.push", { request_id: "push-3", workspace_id: workspace.id }))).toMatch(/^invalid_state: caveman\/pr-7-[0-9a-f]{6} was pushed, but #7 was not moved to it: .*moved on GitHub/);
  expect(gitIn(bare, "rev-parse", `refs/heads/${workspace.branch}`)).toBe(third);
  expect(gitIn(bare, "rev-parse", "refs/heads/feature")).toBe(after);
  await archiveAll();
}, 120_000);

onComputer("a fork's pull request Cloud may not write: the chat's pushes go to one follow-up pull request against its base", async () => {
  const head = pullRequestOnGitHub(8, "patch-1", "patch.txt");
  cloud.state.pulls.byNumber.set(8, { repo: "acme/widgets", title: "Patch", base: "main", head_ref: "patch-1", head_sha: head, head_repo: "someone/widgets", is_fork: true, maintainer_can_modify: false, state: "open" });
  const workspace = await createReady(client, { request_id: "w-on-8", repo: { url: "https://github.com/acme/widgets" }, engine: "claude-agent", options: { model: MODEL }, pull_request: { number: 8 } });
  expect(gitIn(checkout, "rev-parse", "HEAD")).toBe(head);
  const before = cloud.state.pulls.updateHeads.length;

  const sha = agentCommits("patch.txt", "reviewed\n");
  await client.call("git.push", { request_id: "fork-push-1", workspace_id: workspace.id });
  const followUps = () => cloud.state.automations.pullRequests.filter((p) => p.head === workspace.branch);
  expect(followUps()).toEqual([expect.objectContaining({ session_id: workspace.session_id, repo: "acme/widgets", base: "main", sha, title: "Follow-up to #8", idempotency_key: `follow-up:${workspace.session_id}:8` })]);
  // The fork's branch is never asked to move, and the chat now shows the follow-up.
  expect(cloud.state.pulls.updateHeads.length).toBe(before);
  const shown = (await client.call("workspace.get", { workspace_id: workspace.id })).pull_request;
  expect(shown?.number).toBe(followUps()[0]!.number);

  const next = agentCommits("patch.txt", "again\n");
  await client.call("git.push", { request_id: "fork-push-2", workspace_id: workspace.id });
  expect(followUps()).toHaveLength(1);
  expect(followUps()[0]!.sha).toBe(next);
  await archiveAll();
}, 120_000);
