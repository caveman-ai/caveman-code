// Pull requests wherever a chat runs: This Mac, and a Cloud computer whose person's credentials stay outside it
// (cloud-computers CONTRACT §2, §3). The same real runtime in both places. What it settles:
//
// - A chat's own pull request works on a Cloud computer under the rule with no GitHub sign-in in it: its branch goes
//   through Cloud's git proxy, Cloud's App opens the pull request, and the pill follows Cloud's word, checks included.
// - The Review page (the queue, a pull request's page, its guide) reads the host with a sign-in of the person's,
//   through GitHub's GraphQL. Cloud's connector proxy serves reads of REST paths only and no write, and the computer
//   is given no sign-in. So there the page says where it works, in one sentence, and asks the host and Cloud nothing;
//   a comment, a review, a merge and checks run again say where they are done. Never "run `gh auth login`".
// - Not one route the rule closes is called for any of it.
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, expect, test } from "vitest";

import { OUTSIDE_PULL_REQUEST_CHANGE, OUTSIDE_PULL_REQUESTS } from "../session-protocol/reviews.ts";
import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, gitIn } from "./builders.kit.ts";
import { everySystemKit, refusalOf, watch } from "./everySystem.kit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { mac, computer } = everySystemKit(cleanups);
const { startTools, githubWith, checkoutOf } = builderKit(cleanups);

test("the sentences, word for word", () => {
  expect(OUTSIDE_PULL_REQUESTS).toBe(
    "Review pull requests on your Mac (Review). A chat in Cloud still opens its own and shows its checks.",
  );
  expect(OUTSIDE_PULL_REQUEST_CHANGE).toBe("Do this on your Mac (Review), or on GitHub.");
  for (const said of [OUTSIDE_PULL_REQUESTS, OUTSIDE_PULL_REQUEST_CHANGE])
    expect(said).not.toMatch(/gh auth|GH_TOKEN|token/i);
});

test.skipIf(process.platform === "win32")(
  "a chat's own pull request on a Cloud computer under the rule: opened by Cloud's App from the branch the git proxy took, its checks on the pill, no GitHub sign-in in the computer",
  async () => {
    const inner = await startTestCloud();
    cleanups.push(inner.close);
    await startTools();
    inner.state.gitBackend = githubWith(
      makeRepo(tempRoot("every-system-pr-source-"), { "README.md": "widgets\n" }),
    );
    const there = await computer({
      inner,
      checkout: checkoutOf(inner.state.gitBackend, "every-system-pr-"),
    });
    const { client } = there;
    expect((await client.call("cloud.status", {})).capabilities).toMatchObject({
      pull_requests: true,
    });
    const chat = await createReady(client, {
      request_id: "chat",
      repo: there.where,
      title: "Fix the widget",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const seen = await watch(client, chat);
    // The agent commits in its worktree, as it would after a change.
    const worktree = gitIn(there.repo)("worktree", "list", "--porcelain")
      .split("\n\n")
      .map((entry) => ({
        branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1],
        at: /^worktree (.+)$/m.exec(entry)?.[1],
      }))
      .find((entry) => entry.branch === chat.branch)!.at!;
    fs.writeFileSync(path.join(worktree, "fix.txt"), "fixed\n");
    gitIn(worktree)("add", "fix.txt");
    gitIn(worktree)(
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.com",
      "commit",
      "-qm",
      "Fix the widget",
    );
    const sha = gitIn(worktree)("rev-parse", "HEAD");

    const pr = await client.call("git.pr", {
      request_id: "open",
      workspace_id: chat.id,
      title: "Fix the widget",
      body: "What changed.",
    });
    expect(pr).toEqual({
      number: expect.any(Number),
      url: `https://github.com/acme/widgets/pull/${pr.number}`,
      state: "open",
    });
    // GitHub has the chat's branch at the commit: it went through the proxy on the runtime's own token.
    expect(
      gitIn(path.join(inner.state.gitBackend, "acme", "widgets.git"))(
        "rev-parse",
        `refs/heads/${chat.branch}`,
      ),
    ).toBe(sha);
    expect(inner.state.automations.pullRequests).toEqual([
      expect.objectContaining({
        session_id: chat.session_id,
        repo: "acme/widgets",
        head: chat.branch,
        base: "main",
        sha,
      }),
    ]);

    // The pill follows Cloud's table, which the App's deliveries feed: red, then green and merged.
    inner.state.chats.pullRequests.set(chat.branch, {
      number: pr.number,
      url: pr.url,
      state: "open",
      checks: "fail",
    });
    await seen.turn("how are the checks?");
    await until(
      async () =>
        (await client.call("workspace.get", { workspace_id: chat.id })).pull_request?.checks ===
        "failing",
      30_000,
    );
    inner.state.chats.pullRequests.set(chat.branch, {
      number: pr.number,
      url: pr.url,
      state: "merged",
      checks: "pass",
    });
    await seen.turn("and now?");
    await until(
      async () =>
        (await client.call("workspace.get", { workspace_id: chat.id })).pull_request?.state ===
        "merged",
      30_000,
    );
    expect((await client.call("workspace.get", { workspace_id: chat.id })).pull_request).toEqual({
      ...pr,
      state: "merged",
      checks: "passing",
    });

    // The rule held throughout: nothing closed was asked for, and no GitHub read left through the connector proxy.
    const report = await there.cloud.report();
    expect(report.closed).toEqual([]);
    expect(report.proxy.filter((seen) => seen.connection === "github")).toEqual([]);
  },
  180_000,
);

test.skipIf(process.platform === "win32")(
  "several chats on one Cloud computer under the rule each open their own pull request, and each pill follows its own checks",
  async () => {
    const inner = await startTestCloud();
    cleanups.push(inner.close);
    await startTools();
    inner.state.gitBackend = githubWith(
      makeRepo(tempRoot("every-system-prs-source-"), { "README.md": "widgets\n" }),
    );
    const there = await computer({
      inner,
      checkout: checkoutOf(inner.state.gitBackend, "every-system-prs-"),
    });
    const { client } = there;
    const worktreeOf = (branch: string) =>
      gitIn(there.repo)("worktree", "list", "--porcelain")
        .split("\n\n")
        .map((entry) => ({
          branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1],
          at: /^worktree (.+)$/m.exec(entry)?.[1],
        }))
        .find((entry) => entry.branch === branch)!.at!;
    const chats = [];
    for (const name of ["one", "two"]) {
      const chat = await createReady(client, {
        request_id: `chat-${name}`,
        repo: there.where,
        title: `Change ${name}`,
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const seen = await watch(client, chat);
      const worktree = worktreeOf(chat.branch);
      fs.writeFileSync(path.join(worktree, `${name}.txt`), `${name}\n`);
      gitIn(worktree)("add", `${name}.txt`);
      gitIn(worktree)(
        "-c",
        "user.name=Agent",
        "-c",
        "user.email=agent@example.com",
        "commit",
        "-qm",
        `Change ${name}`,
      );
      const pr = await client.call("git.pr", {
        request_id: `open-${name}`,
        workspace_id: chat.id,
        title: `Change ${name}`,
        body: "What changed.",
      });
      // A pull request Cloud opens is in its table at once (Cloud's pull_requests_state.go); the stand-in is told.
      inner.state.chats.pullRequests.set(chat.branch, {
        number: pr.number,
        url: pr.url,
        state: "open",
        checks: "none",
      });
      chats.push({ name, chat, seen, pr });
    }
    const [one, two] = chats as [(typeof chats)[number], (typeof chats)[number]];
    // Two branches, two pull requests, each its own chat's.
    expect(one.pr.number).not.toBe(two.pr.number);
    expect(
      inner.state.automations.pullRequests.map((opened) => [opened.session_id, opened.head]),
    ).toEqual([
      [one.chat.session_id, one.chat.branch],
      [two.chat.session_id, two.chat.branch],
    ]);
    // One's checks fail and the other's pass: each pill says its own.
    inner.state.chats.pullRequests.set(one.chat.branch, {
      number: one.pr.number,
      url: one.pr.url,
      state: "open",
      checks: "fail",
    });
    inner.state.chats.pullRequests.set(two.chat.branch, {
      number: two.pr.number,
      url: two.pr.url,
      state: "open",
      checks: "pass",
    });
    await one.seen.turn("how are the checks?");
    await two.seen.turn("how are the checks?");
    const pill = async (chat: typeof one.chat) =>
      (await client.call("workspace.get", { workspace_id: chat.id })).pull_request;
    await until(
      async () =>
        (await pill(one.chat))?.checks === "failing" &&
        (await pill(two.chat))?.checks === "passing",
      30_000,
    );
    expect(await pill(one.chat)).toEqual({ ...one.pr, checks: "failing" });
    expect(await pill(two.chat)).toEqual({ ...two.pr, checks: "passing" });
    expect((await there.cloud.report()).closed).toEqual([]);
  },
  240_000,
);

test.skipIf(process.platform === "win32")(
  "the Review page on a Cloud computer under the rule says where it works; every change says where it is made; nothing is asked of the host or of Cloud",
  async () => {
    const there = await computer();
    const { client } = there;
    const chat = await createReady(client, {
      request_id: "chat",
      repo: there.where,
      title: "A chat",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const project = chat.project_id!;
    // The queue: empty, with the sentence where its list would be.
    expect(await client.call("pr.list", { state: "open" })).toEqual({
      prs: [],
      viewers: {},
      errors: [],
      unavailable: OUTSIDE_PULL_REQUESTS,
    });
    // A pull request's page, its diff, its discussion, a file, a symbol and its guide: each a read of the host.
    const ref = { project_id: project, number: 7 };
    const read = `unsupported: ${OUTSIDE_PULL_REQUESTS}`;
    expect(await refusalOf(client.call("pr.get", ref))).toBe(read);
    expect(await refusalOf(client.call("pr.diff", ref))).toBe(read);
    expect(await refusalOf(client.call("pr.discussion", ref))).toBe(read);
    expect(await refusalOf(client.call("pr.guide", { ...ref, generate: true }))).toBe(read);
    expect(await refusalOf(client.call("pr.symbol", { ...ref, name: "widget" }))).toBe(read);
    // Each change: a comment, a review, a merge, checks run again, a guide posted, a thread resolved, ready for review.
    const change = `unsupported: ${OUTSIDE_PULL_REQUEST_CHANGE}`;
    expect(
      await refusalOf(
        client.call("pr.comment", { request_id: "c1", ...ref, body: "Looks right." }),
      ),
    ).toBe(change);
    expect(
      await refusalOf(client.call("pr.review", { request_id: "c2", ...ref, verdict: "approve" })),
    ).toBe(change);
    expect(
      await refusalOf(client.call("pr.merge", { request_id: "c3", ...ref, method: "squash" })),
    ).toBe(change);
    expect(await refusalOf(client.call("pr.rerun", { request_id: "c4", ...ref }))).toBe(change);
    expect(
      await refusalOf(client.call("pr.rerun", { request_id: "c5", ...ref, update_branch: true })),
    ).toBe(change);
    expect(await refusalOf(client.call("pr.post_guide", { request_id: "c6", ...ref }))).toBe(
      change,
    );
    expect(
      await refusalOf(
        client.call("pr.resolve", { request_id: "c7", ...ref, thread_id: "t1", resolved: true }),
      ),
    ).toBe(change);
    expect(await refusalOf(client.call("pr.ready", { request_id: "c8", ...ref }))).toBe(change);
    // Nothing was asked: no route the rule closes, and no read through the connector proxy.
    const report = await there.cloud.report();
    expect(report.closed).toEqual([]);
    expect(report.proxy).toEqual([]);
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "This Mac, and a Cloud computer from before the rule, never say the Cloud sentence: the page is the host's own, on the computer's own sign-in",
  async () => {
    const here = await mac();
    const before = await computer({ rule: false });
    for (const place of [here, before]) {
      const listed = await place.client.call("pr.list", { state: "open" });
      expect(listed.unavailable).not.toBe(OUTSIDE_PULL_REQUESTS);
      const chat = await createReady(place.client, {
        request_id: "chat",
        repo: place.where,
        title: "A chat",
        engine: "claude-agent",
        options: { model: MODEL },
      });
      const merged = await refusalOf(
        place.client.call("pr.merge", {
          request_id: "m1",
          project_id: chat.project_id!,
          number: 7,
          method: "squash",
        }),
      );
      expect(merged).not.toContain(OUTSIDE_PULL_REQUEST_CHANGE);
    }
  },
  120_000,
);
