// A chat's own changes wherever it runs: This Mac, and a Cloud computer whose person's credentials stay outside it
// (cloud-computers CONTRACT §2, §6, §7). The same real runtime in both places, the stand-in CLI as the agent. What it
// settles, case by case in both places so the difference (there is none) can be read off:
//
// - The changes view (fs.diff), a turn's Undo and Keep, and git.status are this computer's own git, and need no
//   credential, no GitHub and nothing of Cloud's: under the rule they call no route the rule closes and read nothing
//   through the connector proxy.
// - A project computer holds several chats at once, a worktree each: each chat's changes, Undo and Keep are its own.
// - A chat in several repositories on a Cloud computer under the rule: its changes are every source's, named by
//   source; Undo puts every source back or none; and it ends in one pull request per repository, each naming the
//   other, opened by Cloud's App from branches the git proxy took.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { workspaceSources, type SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { builderKit, gitIn } from "./builders.kit.ts";
import { everySystemKit, refusalOf, watch } from "./everySystem.kit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { mac, computer } = everySystemKit(cleanups);
const { startTools } = builderKit(cleanups);

const checkpoints = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((event) => (event.type === "checkpoint.created" ? [event.payload] : []));
const FILES = { "README.md": "widgets\n", "src/api.ts": "export const v = 1;\n" };

/** One chat's changes, read, undone and kept, in the place given. Answers what a person saw, so two places can be compared. */
async function changes(
  place: Awaited<ReturnType<typeof mac>> | Awaited<ReturnType<typeof computer>>,
) {
  const { client } = place;
  const chat = await createReady(client, {
    request_id: "chat",
    repo: place.where,
    title: "Raise the version",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const seen = await watch(client, chat);
  const turn = async (text: string) => {
    const before = checkpoints(seen.events).length;
    await seen.turn(text);
    await until(() => checkpoints(seen.events).length > before, 60_000);
    return checkpoints(seen.events).at(-1)!;
  };
  // A turn edits one file and adds another.
  const first = await turn(
    ["sh: printf 'export const v = 2;\\n' > src/api.ts", "sh: printf 'two\\n' > NOTES.md"].join(
      "\n",
    ),
  );
  const firstFiles = first.files?.map((file) => file.path).sort();
  const status = (await client.call("git.status", { workspace_id: chat.id })).files
    .map((file) => file.path)
    .sort();
  const diff = await client.call("fs.diff", { workspace_id: chat.id, to: first.checkpoint_id });
  const patch = diff.files.find((file) => file.path === "src/api.ts")?.patch ?? "";
  // Undo puts it back; the changes view is empty again.
  const undone = [
    ...(
      await client.call("checkpoint.undo", {
        request_id: "undo",
        session_id: chat.session_id,
        checkpoint_id: first.checkpoint_id,
      })
    ).files,
  ].sort();
  const afterUndo = (await client.call("git.status", { workspace_id: chat.id })).files.map(
    (file) => file.path,
  );
  // A second turn, kept: its card closes, and Undo of a kept turn says so.
  const second = await turn("sh: printf 'export const v = 3;\\n' > src/api.ts");
  await client.call("checkpoint.keep", {
    request_id: "keep",
    session_id: chat.session_id,
    checkpoint_id: second.checkpoint_id,
  });
  const afterKeep = (await client.call("fs.diff", { workspace_id: chat.id })).files.map((file) => [
    file.path,
    file.status,
  ]);
  const undoKept = await refusalOf(
    client.call("checkpoint.undo", {
      request_id: "undo-kept",
      session_id: chat.session_id,
      checkpoint_id: second.checkpoint_id,
    }),
  );
  return {
    firstFiles,
    status,
    diffed: diff.files.map((file) => [file.path, file.status]).sort(),
    patchHas: patch.includes("+export const v = 2;"),
    undone,
    afterUndo,
    afterKeep,
    undoKept,
    warnings: seen.notes().filter((note) => note.level !== "info"),
  };
}

test.skipIf(process.platform === "win32")(
  "a chat's changes are read, undone and kept the same on This Mac and on a Cloud computer under the rule, with nothing asked of Cloud or GitHub",
  async () => {
    const here = await changes(await mac({ files: FILES }));
    const there = await computer({ files: FILES });
    const onComputer = await changes(there);
    expect(here).toEqual({
      firstFiles: ["NOTES.md", "src/api.ts"],
      status: ["NOTES.md", "src/api.ts"],
      diffed: [
        ["NOTES.md", "added"],
        ["src/api.ts", "modified"],
      ],
      patchHas: true,
      undone: ["NOTES.md", "src/api.ts"],
      afterUndo: [],
      afterKeep: [["src/api.ts", "modified"]],
      undoKept: expect.stringMatching(/^invalid_state: /),
      warnings: [],
    });
    // The same result, the same words.
    expect(onComputer).toEqual(here);
    // And on the computer none of it touched a credential: no closed route, no read through the connector proxy.
    const report = await there.cloud.report();
    expect(report.closed).toEqual([]);
    expect(report.proxy).toEqual([]);
  },
  240_000,
);

test.skipIf(process.platform === "win32")(
  "several chats on one project computer under the rule: each chat's changes, Undo and Keep are its own",
  async () => {
    const there = await computer({ files: FILES });
    const { client } = there;
    const chats = [];
    for (const name of ["one", "two", "three"]) {
      const chat = await createReady(client, {
        request_id: `chat-${name}`,
        repo: there.where,
        title: `Chat ${name}`,
        engine: "claude-agent",
        options: { model: MODEL },
      });
      chats.push({ name, chat, seen: await watch(client, chat) });
    }
    // A worktree and a branch each, on the one computer.
    expect(new Set(chats.map(({ chat }) => chat.branch)).size).toBe(3);
    expect(new Set(chats.map(({ chat }) => chat.computer.id)).size).toBe(1);
    // All three edit the same file at once, each its own way.
    await Promise.all(
      chats.map(async ({ name, seen }) => {
        await seen.turn(`sh: printf 'export const v = "${name}";\\n' > src/api.ts`);
        await until(() => checkpoints(seen.events).length >= 1, 60_000);
      }),
    );
    for (const { name, chat } of chats) {
      const diff = await client.call("fs.diff", { workspace_id: chat.id });
      expect(diff.files.map((file) => file.path)).toEqual(["src/api.ts"]);
      expect(diff.files[0]!.patch).toContain(`+export const v = "${name}";`);
    }
    // Undo in one leaves the others as they were.
    const [one, two, three] = chats as [
      (typeof chats)[number],
      (typeof chats)[number],
      (typeof chats)[number],
    ];
    await client.call("checkpoint.undo", {
      request_id: "undo-one",
      session_id: one.chat.session_id,
      checkpoint_id: checkpoints(one.seen.events).at(-1)!.checkpoint_id,
    });
    await client.call("checkpoint.keep", {
      request_id: "keep-two",
      session_id: two.chat.session_id,
      checkpoint_id: checkpoints(two.seen.events).at(-1)!.checkpoint_id,
    });
    expect((await client.call("fs.diff", { workspace_id: one.chat.id })).files).toEqual([]);
    expect((await client.call("fs.diff", { workspace_id: two.chat.id })).files[0]!.patch).toContain(
      '+export const v = "two";',
    );
    expect(
      (await client.call("fs.diff", { workspace_id: three.chat.id })).files[0]!.patch,
    ).toContain('+export const v = "three";');
    expect((await there.cloud.report()).closed).toEqual([]);
  },
  240_000,
);

test.skipIf(process.platform === "win32")(
  "a chat in two repositories on a Cloud computer under the rule: its changes are both sources', Undo puts both back, and it ends in a pull request in each",
  async () => {
    const inner = await startTestCloud();
    cleanups.push(inner.close);
    await startTools();
    // GitHub, as Cloud's git proxy reaches it: two repositories of one project.
    const remotes = tempRoot("every-system-sources-github-");
    inner.state.gitBackend = remotes;
    const onGitHub = (name: string, files: Record<string, string>) => {
      const bare = path.join(remotes, `acme/${name}.git`);
      fs.mkdirSync(path.dirname(bare), { recursive: true });
      execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
      const scratch = makeRepo(tempRoot(`every-system-sources-${name}-`), files);
      gitIn(scratch)("push", "-q", bare, "main");
      return scratch;
    };
    const widgets = onGitHub("widgets", {
      "README.md": "widgets\n",
      "src/api.ts": "export const v = 1;\n",
    });
    onGitHub("site", { "README.md": "site\n", "src/page.ts": "export const v = 1;\n" });
    for (const repo of ["acme/widgets", "acme/site"])
      inner.state.chats.projectRepos.set(repo, "project-1");
    gitIn(widgets)("remote", "add", "origin", "https://github.com/acme/widgets.git");
    const there = await computer({
      inner,
      checkout: widgets,
      placed: ["acme/widgets", "acme/site"],
    });
    const { client } = there;
    inner.state.chats.markCloud(there.identity.computerId, "Project computer");
    // The person started it with both: Cloud's row for this computer names them, and the proxy serves by those rows.
    inner.state.chats.placed.set(there.identity.computerId, {
      repo: "acme/widgets",
      checkouts: [{ repo: "acme/site", base_branch: "main", branch: "" }],
    });
    inner.state.chats.gitScoped = true;

    const chat = await client.call("workspace.create", {
      request_id: "two",
      repo: there.where,
      sources: ["acme/site"],
      title: "Both sides",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const seen = await watch(client, chat);
    const made = () =>
      seen.events.find(
        (event) => event.type === "tool.started" && event.payload.name === "worktree",
      )?.item_id;
    await until(
      () => seen.events.some((event) => event.type === "tool.done" && event.item_id === made()),
      60_000,
    );
    const started = await client.call("workspace.get", { workspace_id: chat.id });
    expect(started.status).not.toBe("failed");
    expect(workspaceSources(started).map((source) => source.name)).toEqual(["widgets", "site"]);
    const turn = async (text: string) => {
      const before = checkpoints(seen.events).length;
      await seen.turn(text);
      await until(() => checkpoints(seen.events).length > before, 60_000);
      return checkpoints(seen.events).at(-1)!;
    };

    // One turn edits both: the changes view names each file by its source, and git.status says each source's state.
    const first = await turn(
      [
        "sh: printf 'export const v = 2;\\n' > widgets/src/api.ts",
        "sh: printf 'export const v = 2;\\n' > site/src/page.ts",
      ].join("\n"),
    );
    const diff = await client.call("fs.diff", { workspace_id: chat.id, to: first.checkpoint_id });
    expect(diff.files.map((file) => [file.path, file.status]).sort()).toEqual([
      ["site/src/page.ts", "modified"],
      ["widgets/src/api.ts", "modified"],
    ]);
    expect(diff.files.find((file) => file.path === "site/src/page.ts")?.patch).toContain(
      "diff --git a/site/src/page.ts b/site/src/page.ts",
    );
    const status = await client.call("git.status", { workspace_id: chat.id });
    expect(status.sources?.map((source) => [source.name, source.files])).toEqual([
      ["widgets", 1],
      ["site", 1],
    ]);
    // Undo: both repositories go back together.
    const undone = await client.call("checkpoint.undo", {
      request_id: "undo",
      session_id: chat.session_id,
      checkpoint_id: first.checkpoint_id,
    });
    expect([...undone.files].sort()).toEqual(["site/src/page.ts", "widgets/src/api.ts"]);
    expect((await client.call("git.status", { workspace_id: chat.id })).files).toEqual([]);

    // Again, kept: one commit in each, and one pull request in each through Cloud's App, each naming the other.
    const second = await turn(
      [
        "sh: printf 'export const v = 3;\\n' > widgets/src/api.ts",
        "sh: printf 'export const v = 3;\\n' > site/src/page.ts",
      ].join("\n"),
    );
    await client.call("checkpoint.keep", {
      request_id: "keep",
      session_id: chat.session_id,
      checkpoint_id: second.checkpoint_id,
    });
    const committed = await client.call("git.commit", {
      request_id: "commit",
      workspace_id: chat.id,
      message: "Move both to 3",
    });
    expect(committed.commits?.map((commit) => commit.source)).toEqual(["widgets", "site"]);
    // GitHub refuses site's at first: the error says which one did not open, why, and which did, as words and as data.
    inner.state.automations.refusePullRequests.set(
      "acme/site",
      "Pull requests are turned off for this repository.",
    );
    const partly = await client
      .call("git.pr", {
        request_id: "pr-refused",
        workspace_id: chat.id,
        title: "Move both to 3",
        body: "Both sides.",
      })
      .then(
        () => undefined,
        (error: { error?: { message?: string; data?: Record<string, unknown> } }) => error.error,
      );
    const widgetsNumber = inner.state.automations.pullRequests.find(
      (one) => one.repo === "acme/widgets",
    )!.number;
    expect(partly?.message).toBe(
      `site's pull request didn't open: Pull requests are turned off for this repository. widgets's is #${widgetsNumber}.`,
    );
    expect(partly?.data?.pull_requests).toEqual({
      opened: [
        {
          source: "widgets",
          number: widgetsNumber,
          url: `https://github.com/acme/widgets/pull/${widgetsNumber}`,
        },
      ],
      failed: { source: "site", reason: "Pull requests are turned off for this repository" },
    });
    // Tried again once GitHub takes it: only the missing one opens; widgets keeps its own.
    inner.state.automations.refusePullRequests.clear();
    const pr = await client.call("git.pr", {
      request_id: "pr",
      workspace_id: chat.id,
      title: "Move both to 3",
      body: "Both sides.",
    });
    expect(pr.pull_requests?.map((one) => one.source)).toEqual(["widgets", "site"]);
    expect(pr.pull_requests?.find((one) => one.source === "widgets")?.number).toBe(widgetsNumber);
    const opened = inner.state.automations.pullRequests;
    expect(opened.map((one) => [one.repo, one.head, one.base])).toEqual([
      ["acme/widgets", started.branch, "main"],
      ["acme/site", started.branch, "main"],
    ]);
    expect(opened[0]!.body).toContain(
      `- acme/site: https://github.com/acme/site/pull/${opened[1]!.number}`,
    );
    expect(opened[1]!.body).toContain(
      `- acme/widgets: https://github.com/acme/widgets/pull/${opened[0]!.number}`,
    );
    // Each pull request's pill follows Cloud's word for its own repository's branch, checks included.
    inner.state.chats.pullRequests.set(`acme/site#${started.branch}`, {
      number: opened[1]!.number,
      url: `https://github.com/acme/site/pull/${opened[1]!.number}`,
      state: "open",
      checks: "fail",
    });
    await seen.turn("how are the checks?");
    await until(
      async () =>
        workspaceSources(await client.call("workspace.get", { workspace_id: chat.id })).find(
          (source) => source.name === "site",
        )?.pull_request?.checks === "failing",
      30_000,
    );
    // The rule held: nothing closed was asked for, and the proxy refused no push.
    expect((await there.cloud.report()).closed).toEqual([]);
    expect(inner.state.gitRefused).toEqual([]);
  },
  300_000,
);
