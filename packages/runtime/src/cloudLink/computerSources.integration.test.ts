// Projects with several repositories on a Cloud computer, end to end on the real runtime against the stand-in Cloud
// (CONTRACT §7 of cloud-computers-2026-11-09). The computer runs git in its tools container and holds no GitHub
// login: every repository reaches it through Cloud's git proxy, which serves this computer the repositories its
// chats were started with in Cloud's own rows and no other. One chat works in two of them: the second is cloned on
// first use, a turn edits both, its checkpoint and Undo cover both, and Cloud opens one pull request in each, each
// naming the other. A repository of the same project that no chat here was given stays out of reach, whatever the
// computer asks for.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  connect,
  workspaceSources,
  type SessionEvent,
  type Workspace,
} from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import { readSourceRoot } from "../checkpointing/SourceRoots.ts";
import {
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { enroll, type Identity } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud, type TestCloud } from "./testCloud.ts";
import { TOOLS_EXEC } from "./tools.ts";

let cloud: TestCloud;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let tools: ChildProcess;
let remotes: string;
let identity: Identity;
let config: Awaited<ReturnType<typeof makeConfig>>;
// Skipped on Windows: a Cloud computer is Linux, with its git in a tools container over a Unix socket.
const onComputer = test.skipIf(process.platform === "win32");
const cleanups: Array<() => unknown> = [];

const gitIn = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { message?: string; data?: { reason?: string } } }) =>
      `${error.error?.data?.reason}: ${error.error?.message}`,
  );
const done = (events: ReadonlyArray<SessionEvent>) =>
  events.filter((e) => e.type === "turn.done").length;
const checkpoints = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) => (e.type === "checkpoint.created" ? [e.payload] : []));

/** A repository on GitHub, as Cloud's git proxy reaches it: a bare repository with one commit on main. */
function onGitHub(name: string, files: Record<string, string>) {
  const bare = path.join(remotes, `acme/${name}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const scratch = makeRepo(tempRoot(`computer-sources-${name}-`), files);
  gitIn(scratch, "push", "-q", bare, "main");
  return { bare, scratch };
}

beforeAll(async () => {
  const socket = path.join(tempRoot("computer-sources-tools-"), "tools.sock");
  tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], {
    env: { ...process.env, TOOLS_SIDE: "yes" },
    stdio: "ignore",
  });
  cleanups.push(() => tools.kill());
  for (const deadline = Date.now() + 10_000; !fs.existsSync(socket) && Date.now() < deadline;)
    await new Promise((r) => setTimeout(r, 50));
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;

  cloud = await startTestCloud();
  cleanups.push(cloud.close);
  remotes = tempRoot("computer-sources-github-");
  cloud.state.gitBackend = remotes;
  const widgets = onGitHub("widgets", {
    "README.md": "widgets\n",
    "src/api.ts": "export const v = 1;\n",
  });
  onGitHub("site", { "README.md": "site\n", "src/page.ts": "export const v = 1;\n" });
  onGitHub("secret", { "README.md": "secret\n" });
  // One project holds all three; a fourth repository is in none.
  for (const repo of ["acme/widgets", "acme/site", "acme/secret"])
    cloud.state.chats.projectRepos.set(repo, "project-1");

  const linkDir = path.join(tempRoot("computer-sources-link-"), "link");
  identity = await enroll({
    dir: linkDir,
    cloudUrl: cloud.url,
    bearer: cloud.state.personToken,
    name: "computer",
  });
  cloud.state.chats.markCloud(identity.computerId, "Project computer");
  // The computer's own checkout is its project's first repository, as the computer was made with it.
  gitIn(widgets.scratch, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  config = await makeConfig();
  const provide = Layer.mergeAll(
    Layer.succeed(CloudComputer, {
      linkDir,
      computerId: identity.computerId,
      workspaceRoot: widgets.scratch,
    }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  cleanups.push(runtime.close);
  client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 15_000);
  // From here the proxy serves this computer by Cloud's rows alone.
  cloud.state.chats.gitScoped = true;
}, 60_000);

afterAll(async () => {
  delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function follow(w: Workspace) {
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const made = () =>
    events.find((e) => e.type === "tool.started" && e.payload.name === "worktree")?.item_id;
  await until(() => events.some((e) => e.type === "tool.done" && e.item_id === made()), 60_000);
  let n = 0;
  const turn = async (text: string) => {
    const before = done(events);
    await client.call("turn.submit", {
      request_id: `${w.id}-${n++}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text },
    });
    await until(() => done(events) > before && checkpoints(events).length > before, 60_000);
    return checkpoints(events).at(-1)!;
  };
  return { events, turn };
}

onComputer(
  "one chat on a Cloud computer works in two repositories, and ends in two pull requests that name each other",
  async () => {
    // The person started it with both (POST workspaces with checkouts): Cloud's row for this computer names them.
    cloud.state.chats.placed.set(identity.computerId, {
      repo: "acme/widgets",
      checkouts: [{ repo: "acme/site", base_branch: "main", branch: "" }],
    });

    const w = await client.call("workspace.create", {
      request_id: "two",
      repo: { url: "https://github.com/acme/widgets" },
      sources: ["acme/site"],
      title: "Both sides",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    expect(w.source).toBe("widgets");
    const { events, turn } = await follow(w);
    const made = await client.call("workspace.get", { workspace_id: w.id });
    expect(made.status).not.toBe("failed");
    expect(
      workspaceSources(made).map((s) => [s.name, s.branch, s.base_ref, s.repository?.full_name]),
    ).toEqual([
      ["widgets", made.branch, "main", undefined],
      ["site", made.branch, "main", "acme/site"],
    ]);
    expect(made.branch.startsWith("caveman/")).toBe(true);
    // Never a path of the computer's on the wire.
    expect("root_path" in made).toBe(false);

    // The second repository was cloned through the proxy on first use; the chat's folder holds a worktree of each.
    const clone = path.join(config.worktreesDir, "sources", "acme__site");
    expect(gitIn(clone, "remote", "get-url", "origin")).toBe("https://github.com/acme/site.git");
    const folder = fs
      .readdirSync(path.join(config.worktreesDir, "chats"))
      .map((name) => path.join(config.worktreesDir, "chats", name))
      .find((dir) => fs.existsSync(path.join(dir, "site")))!;
    expect(fs.readdirSync(folder).sort()).toEqual(["site", "widgets"]);
    expect(readSourceRoot(folder)).toEqual(["widgets", "site"]);
    for (const name of ["widgets", "site"])
      expect(gitIn(path.join(folder, name), "rev-parse", "--abbrev-ref", "HEAD")).toBe(made.branch);

    // One turn edits both; its checkpoint is one, and Undo puts both back.
    const first = await turn(
      [
        "sh: printf 'export const v = 2;\\n' > widgets/src/api.ts",
        "sh: printf 'export const v = 2;\\n' > site/src/page.ts",
      ].join("\n"),
    );
    expect(first.files?.map((f) => f.path).sort()).toEqual([
      "site/src/page.ts",
      "widgets/src/api.ts",
    ]);
    // The gate before each tool is the chat's, not a repository's (SPEC §7.3): each command's intent was in Cloud's copy
    // of this chat before it ran, whichever source it wrote in.
    await until(() => {
      const intents = (cloud.state.chats.sessions.get(w.session_id)?.segments ?? []).flatMap(
        (s) => (s.body as { intents?: ReadonlyArray<{ title: string }> }).intents ?? [],
      );
      return (
        intents.some((i) => i.title.includes("widgets/src/api.ts")) &&
        intents.some((i) => i.title.includes("site/src/page.ts"))
      );
    }, 20_000);
    await client.call("checkpoint.undo", {
      request_id: "undo",
      session_id: w.session_id,
      checkpoint_id: first.checkpoint_id,
    });
    expect(fs.readFileSync(path.join(folder, "widgets", "src/api.ts"), "utf8")).toBe(
      "export const v = 1;\n",
    );
    expect(fs.readFileSync(path.join(folder, "site", "src/page.ts"), "utf8")).toBe(
      "export const v = 1;\n",
    );

    // Again, kept this time: one commit in each, then one pull request in each through Cloud, each naming the other.
    await turn(
      [
        "sh: printf 'export const v = 3;\\n' > widgets/src/api.ts",
        "sh: printf 'export const v = 3;\\n' > site/src/page.ts",
      ].join("\n"),
    );
    const committed = await client.call("git.commit", {
      request_id: "commit",
      workspace_id: w.id,
      message: "Move both to 3",
    });
    expect(committed.commits?.map((c) => c.source)).toEqual(["widgets", "site"]);
    const pr = await client.call("git.pr", {
      request_id: "pr",
      workspace_id: w.id,
      title: "Move both to 3",
      body: "Both sides.",
    });
    expect(pr.pull_requests?.map((one) => one.source)).toEqual(["widgets", "site"]);
    const opened = cloud.state.automations.pullRequests;
    expect(opened.map((one) => [one.repo, one.head, one.base, one.session_id])).toEqual([
      ["acme/widgets", made.branch, "main", w.session_id],
      ["acme/site", made.branch, "main", w.session_id],
    ]);
    // Each branch went through the proxy to its own repository.
    expect(
      gitIn(path.join(remotes, "acme/widgets.git"), "rev-parse", `refs/heads/${made.branch}`),
    ).toBe(committed.commits![0]!.sha);
    expect(
      gitIn(path.join(remotes, "acme/site.git"), "rev-parse", `refs/heads/${made.branch}`),
    ).toBe(committed.commits![1]!.sha);
    // Each description names the other by its pull request (Cloud rewrote the first once the second had its address).
    const [widgetsPr, sitePr] = opened;
    expect(widgetsPr!.body).toContain("Both sides.");
    expect(widgetsPr!.body).toContain(
      `- acme/site: https://github.com/acme/site/pull/${sitePr!.number}`,
    );
    expect(sitePr!.body).toContain(
      `- acme/widgets: https://github.com/acme/widgets/pull/${widgetsPr!.number}`,
    );
    const after = await client.call("workspace.get", { workspace_id: w.id });
    expect(workspaceSources(after).map((s) => s.pull_request?.url)).toEqual([
      `https://github.com/acme/widgets/pull/${widgetsPr!.number}`,
      `https://github.com/acme/site/pull/${sitePr!.number}`,
    ]);
    expect(events.some((e) => e.type === "notification" && e.payload.level === "warning")).toBe(
      false,
    );

    // It stays on this computer, and says why: a move carries every source of a chat or none, and none of its files
    // go into its copy yet. Asked (the Move to menu) and told (a move) answer the same, before anything parks.
    const stays =
      /^invalid_state: This chat stays here: it works in 2 repositories \(widgets, site\), and a move carries the files of one for now\.$/;
    expect(
      await refusalOf(
        client.call("session.move.check", { session_id: w.session_id, to: "this_mac" }),
      ),
    ).toMatch(stays);
    expect(
      await refusalOf(
        client.call("session.move", {
          request_id: "move",
          session_id: w.session_id,
          to: "this_mac",
        }),
      ),
    ).toMatch(stays);
    expect((await client.call("workspace.get", { workspace_id: w.id })).computer.id).toBe(
      made.computer.id,
    );
    // Its copy with Cloud is its conversation: it went, and said nothing of work in progress that failed to go.
    await until(() => (cloud.state.chats.sessions.get(w.session_id)?.cursor_seq ?? 0) > 0, 30_000);
    expect(fs.existsSync(path.join(folder, ".git"))).toBe(false);
  },
  240_000,
);

onComputer(
  "a repository no chat on the computer was given stays out of its reach, whatever the computer asks",
  async () => {
    const live = (await client.call("workspace.list", {})).workspaces.find(
      (w) => w.title === "Both sides",
    )!;
    cloud.state.chats.gitOutOfScope.length = 0;

    // A chat that names it: Cloud's proxy refuses the clone, and the chat never starts.
    const w = await client.call("workspace.create", {
      request_id: "reach",
      repo: { url: "https://github.com/acme/widgets" },
      sources: ["acme/secret"],
      title: "Reach",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    await until(
      async () => (await client.call("workspace.get", { workspace_id: w.id })).status === "failed",
      60_000,
    );
    expect(cloud.state.chats.gitOutOfScope.map((one) => one.repo)).toContain("acme/secret");
    expect(fs.existsSync(path.join(config.worktreesDir, "sources", "acme__secret", ".git"))).toBe(
      false,
    );
    // Nothing of the failed start is left: no folder, no worktree of the computer's own checkout.
    expect(
      fs
        .readdirSync(path.join(config.worktreesDir, "chats"))
        .filter((name) => name.startsWith("reach")),
    ).toEqual([]);

    // Adding it to the running chat: refused before any git runs, in words that say who can.
    expect(
      await refusalOf(
        client.call("workspace.add_source", {
          request_id: "add-secret",
          workspace_id: live.id,
          source: "acme/secret",
        }),
      ),
    ).toMatch(
      /invalid_state: Add acme\/secret to this chat in Caveman first: a Cloud computer reaches only the repositories its chats were given/,
    );
    // The computer asking Cloud to widen its own row is refused, and the row is as it was.
    const token = cloud.state.tokens.keys().next().value as string;
    const asked = await fetch(
      `${cloud.url}/api/v1/code/runtime/sessions/${live.session_id}/checkouts`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          checkouts: [
            { repo: "acme/site", base_branch: "main", branch: live.branch },
            { repo: "acme/secret", base_branch: "main", branch: live.branch },
          ],
        }),
      },
    );
    expect(asked.status).toBe(403);
    expect(cloud.state.chats.sessions.get(live.session_id)?.checkouts?.map((c) => c.repo)).toEqual([
      "acme/site",
    ]);
    // A pull request in it is not opened either.
    const pr = await fetch(`${cloud.url}/api/v1/code/runtime/pull-requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        session_id: live.session_id,
        repo: "acme/secret",
        head: live.branch,
        base: "main",
        sha: "0".repeat(40),
        title: "x",
        body: "",
        draft: false,
        idempotency_key: "k",
      }),
    });
    expect(pr.status).toBe(403);
    // What it was given still works.
    expect(
      (await client.call("git.status", { workspace_id: live.id })).sources?.map((s) => s.name),
    ).toEqual(["widgets", "site"]);
    // Nothing either chat's runtime sent Cloud (its registration, its summaries, its copy) carried a field Cloud's
    // strict decoder does not know: several repositories ride on Cloud's own rows, never on those bodies.
    expect(cloud.state.chats.refused).toEqual([]);
    expect(cloud.state.tree.refused).toEqual([]);
  },
  240_000,
);
