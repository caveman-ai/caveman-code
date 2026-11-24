// Projects with several repositories on This Mac, on the real runtime and real git (the Claude adapter on
// scripts/smoke-claude.mjs, which runs "sh: <command>" lines of its prompt in its working directory): a project gets
// a second source, one chat works in both, a turn edits both with relative paths, that turn's checkpoint and Undo
// cover both, one commit lands in each, and the chat ends in one pull request per repository, each naming the other.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  connect,
  projectSources,
  workspaceSources,
  type SessionEvent,
  type Workspace,
} from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import { readSourceRoot, sourcesManifestPath } from "../checkpointing/SourceRoots.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { git, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

/** The pull requests the host was asked to open, by the checkout they were opened from. */
const opened: Array<{
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  number: number;
  url: string;
}> = [];
/** A git host that opens what it is asked to and lists it back: no network, and nothing of the person's. */
const host = Layer.succeed(SourceControlProviderRegistry.SourceControlProviderRegistry, {
  resolve: ({ cwd }: { cwd: string }) =>
    Effect.succeed({
      createChangeRequest: (input: {
        cwd: string;
        baseRefName: string;
        headSelector: string;
        title: string;
        bodyFile: string;
      }) =>
        Effect.sync(() => {
          const repo = path.basename(git(input.cwd, "remote", "get-url", "origin").trim(), ".git");
          const number = opened.filter((pr) => pr.url.includes(`/${repo}/`)).length + 1;
          opened.push({
            cwd: input.cwd,
            base: input.baseRefName,
            head: input.headSelector,
            title: input.title,
            body: fs.readFileSync(input.bodyFile, "utf8"),
            number,
            url: `https://git.test/acme/${repo}/pull/${number}`,
          });
        }),
      listChangeRequests: (input: { cwd: string; headSelector: string }) =>
        Effect.sync(() =>
          opened
            .filter((pr) => pr.cwd === input.cwd && pr.head === input.headSelector)
            .map((pr) => ({ number: pr.number, url: pr.url, isDraft: false })),
        ),
      cwd,
    }),
} as never);

beforeAll(async () => {
  root = fs.realpathSync(tempRoot("sp-sources-"));
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: host });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { message?: string; data?: { reason?: string } } }) =>
      `${error.error?.data?.reason}: ${error.error?.message}`,
  );
const done = (events: ReadonlyArray<SessionEvent>) =>
  events.filter((e) => e.type === "turn.done").length;
const checkpoints = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) => (e.type === "checkpoint.created" ? [e.payload] : []));

/** A repository named `name` with one commit, and a bare origin it pushes to (a file URL, so a push is real). */
function repoWithOrigin(name: string, files: Record<string, string>) {
  const made = makeRepo(root, files);
  const repo = path.join(root, name);
  fs.renameSync(made, repo);
  const origin = path.join(root, "origins", `${name}.git`);
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, origin };
}

async function follow(w: Workspace) {
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const made = () =>
    events.find((e) => e.type === "tool.started" && e.payload.name === "worktree")?.item_id;
  await until(() => events.some((e) => e.type === "tool.done" && e.item_id === made()));
  let n = 0;
  const turn = async (text: string) => {
    const before = done(events);
    await client.call("turn.submit", {
      request_id: `${w.id}-${n++}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text },
    });
    await until(() => done(events) > before && checkpoints(events).length > before, 30_000);
    return checkpoints(events).at(-1)!;
  };
  return { events, turn };
}

test("a project with one source says nothing of sources, and reads as one", async () => {
  const { repo } = repoWithOrigin("solo", { "README.md": "solo\n" });
  const project = await client.call("project.create", { request_id: "solo-project", path: repo });
  expect("sources" in project).toBe(false);
  expect(projectSources(project)).toEqual([{ kind: "repo", name: "solo", path: repo }]);
});

test("one chat works in two repositories: a turn edits both, its checkpoint and Undo cover both, and it ends in two pull requests that name each other", async () => {
  const api = repoWithOrigin("api", {
    "README.md": "api\n",
    "src/server.ts": "export const port = 1;\n",
  });
  const web = repoWithOrigin("web", {
    "README.md": "web\n",
    "src/app.ts": "export const api = 1;\n",
  });
  const project = await client.call("project.create", { request_id: "p", path: api.repo });

  // The project gets its second source: a checkout on this Mac, kept with where it sits here.
  const two = await client.call("project.add_source", {
    request_id: "add-web",
    project_id: project.id,
    path: web.repo,
  });
  expect(two.sources).toEqual([
    { kind: "repo", name: "api", path: api.repo },
    { kind: "repo", name: "web", path: web.repo },
  ]);
  expect(
    (await client.call("project.list", {})).projects
      .find((p) => p.id === project.id)
      ?.sources?.map((s) => s.name),
  ).toEqual(["api", "web"]);
  // Adding it again changes nothing; a name the project does not have is refused.
  expect(
    (
      await client.call("project.add_source", {
        request_id: "add-web-2",
        project_id: project.id,
        path: web.repo,
      })
    ).sources,
  ).toEqual(two.sources);
  expect(
    await failure(
      client.call("workspace.create", {
        request_id: "bad",
        repo: { path: api.repo },
        sources: ["nope"],
        engine: "claude-agent",
        options: { model: MODEL },
      }),
    ),
  ).toMatch(/invalid_params: This project has no source named nope/);

  const w = await client.call("workspace.create", {
    request_id: "chat",
    repo: { path: api.repo },
    sources: ["api", "web"],
    title: "Across",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  expect(w.source).toBe("api");
  expect(w.checkouts?.map((c) => c.name)).toEqual(["web"]);
  const { events, turn } = await follow(w);
  const made = (await client.call("workspace.get", { workspace_id: w.id })) as Workspace;
  expect(workspaceSources(made).map((s) => [s.name, s.primary, s.branch, s.base_ref])).toEqual([
    ["api", true, made.branch, "main"],
    ["web", false, made.branch, "main"],
  ]);
  expect(made.checkouts?.[0]?.repo).toEqual({ path: web.repo });

  // On disk: one folder holding a worktree of each repository, side by side under their names, on one branch name.
  const folder = made.root_path!;
  expect(fs.readdirSync(folder).sort()).toEqual(["api", "web"]);
  expect(git(path.join(folder, "api"), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
    made.branch,
  );
  expect(git(path.join(folder, "web"), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
    made.branch,
  );
  expect(
    git(path.join(folder, "api"), "rev-parse", "--path-format=absolute", "--git-common-dir").trim(),
  ).toBe(path.join(api.repo, ".git"));
  expect(
    git(path.join(folder, "web"), "rev-parse", "--path-format=absolute", "--git-common-dir").trim(),
  ).toBe(path.join(web.repo, ".git"));
  // The folder is no repository, and the manifest that says what it holds sits beside it, never in it.
  expect(fs.existsSync(path.join(folder, ".git"))).toBe(false);
  expect(readSourceRoot(folder)).toEqual(["api", "web"]);
  expect(sourcesManifestPath(folder).startsWith(folder + path.sep)).toBe(false);

  // One turn edits both, by relative paths from the folder (the engine's working directory), and makes a file in each.
  const first = await turn(
    [
      "sh: pwd > where.txt && mv where.txt api/where.txt",
      "sh: printf 'export const port = 2;\\n' > api/src/server.ts",
      "sh: printf 'export const api = 2;\\n' > web/src/app.ts",
      "sh: printf 'new\\n' > web/src/new.ts",
    ].join("\n"),
  );
  expect(fs.readFileSync(path.join(folder, "api", "where.txt"), "utf8").trim()).toBe(folder);
  // The engine was told where each repository is, once, in front of the message; the transcript keeps what was typed.
  const typed = events
    .filter((e) => e.type === "message.done" && e.payload.role === "user")
    .map((e) => (e.type === "message.done" ? e.payload.text : ""));
  expect(typed.some((text) => text.includes("[Caveman Code]"))).toBe(false);

  // The turn's checkpoint is one: it names the files of both repositories, each under its repository's name.
  expect(first.files?.map((f) => f.path).sort()).toEqual([
    "api/src/server.ts",
    "api/where.txt",
    "web/src/app.ts",
    "web/src/new.ts",
  ]);
  // The same ref in each repository, which is what makes it one checkpoint.
  for (const name of ["api", "web"])
    expect(
      git(path.join(folder, name), "rev-parse", "--verify", "--quiet", first.ref).trim(),
    ).toMatch(/^[0-9a-f]{40}$/);
  const changed = events.filter((e) => e.type === "diff.changed").at(-1);
  expect(
    changed?.type === "diff.changed" ? changed.payload.files.map((f) => f.path).sort() : [],
  ).toEqual(["api/src/server.ts", "api/where.txt", "web/src/app.ts", "web/src/new.ts"]);

  // git.status: each source's own state, and every source's files in one list.
  const status = await client.call("git.status", { workspace_id: w.id });
  expect(status.sources?.map((s) => [s.name, s.branch, s.base_ref, s.files])).toEqual([
    ["api", made.branch, "main", 2],
    ["web", made.branch, "main", 2],
  ]);
  expect(status.files.map((f) => f.path).sort()).toEqual([
    "api/src/server.ts",
    "api/where.txt",
    "web/src/app.ts",
    "web/src/new.ts",
  ]);

  // The turn's diff, read from the folder: every file with its patch, named as the chat names it.
  const diff = await client.call("fs.diff", { workspace_id: w.id, to: first.checkpoint_id });
  expect(diff.files.map((f) => [f.path, f.status]).sort()).toEqual([
    ["api/src/server.ts", "modified"],
    ["api/where.txt", "added"],
    ["web/src/app.ts", "modified"],
    ["web/src/new.ts", "added"],
  ]);
  expect(diff.files.find((f) => f.path === "web/src/app.ts")?.patch).toContain(
    "+export const api = 2;",
  );
  expect(diff.files.find((f) => f.path === "web/src/app.ts")?.patch).toContain(
    "diff --git a/web/src/app.ts b/web/src/app.ts",
  );

  // Undo: both repositories go back together.
  const undone = await client.call("checkpoint.undo", {
    request_id: "undo-1",
    session_id: w.session_id,
    checkpoint_id: first.checkpoint_id,
  });
  expect([...undone.files].sort()).toEqual([
    "api/src/server.ts",
    "api/where.txt",
    "web/src/app.ts",
    "web/src/new.ts",
  ]);
  expect(fs.readFileSync(path.join(folder, "api", "src/server.ts"), "utf8")).toBe(
    "export const port = 1;\n",
  );
  expect(fs.readFileSync(path.join(folder, "web", "src/app.ts"), "utf8")).toBe(
    "export const api = 1;\n",
  );
  expect(fs.existsSync(path.join(folder, "web", "src/new.ts"))).toBe(false);
  expect(fs.existsSync(path.join(folder, "api", "where.txt"))).toBe(false);
  expect((await client.call("git.status", { workspace_id: w.id })).files).toEqual([]);

  // A second turn edits both again; this time the person edits one file after it, so Undo refuses and touches neither.
  const second = await turn(
    [
      "sh: printf 'export const port = 3;\\n' > api/src/server.ts",
      "sh: printf 'export const api = 3;\\n' > web/src/app.ts",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(folder, "web", "src/app.ts"), "export const api = 3; // mine\n");
  expect(
    await failure(
      client.call("checkpoint.undo", {
        request_id: "undo-2",
        session_id: w.session_id,
        checkpoint_id: second.checkpoint_id,
      }),
    ),
  ).toMatch(/invalid_state: web\/src\/app\.ts changed after this turn/);
  expect(fs.readFileSync(path.join(folder, "api", "src/server.ts"), "utf8")).toBe(
    "export const port = 3;\n",
  );
  fs.writeFileSync(path.join(folder, "web", "src/app.ts"), "export const api = 3;\n");

  // One commit in each repository that has something to commit, with one message.
  const committed = await client.call("git.commit", {
    request_id: "commit",
    workspace_id: w.id,
    message: "Raise the port and the client to 3",
  });
  expect(committed.commits?.map((c) => c.source)).toEqual(["api", "web"]);
  expect(committed.sha).toBe(committed.commits?.[0]?.sha);
  for (const name of ["api", "web"]) {
    expect(git(path.join(folder, name), "log", "-1", "--format=%s").trim()).toBe(
      "Raise the port and the client to 3",
    );
    expect(git(path.join(folder, name), "status", "--porcelain").trim()).toBe("");
  }

  // Two pull requests, opened together, each one's description naming the other.
  const pr = await client.call("git.pr", {
    request_id: "pr",
    workspace_id: w.id,
    title: "Raise the port",
    body: "Both sides move to 3.",
  });
  expect(pr.pull_requests?.map((one) => [one.source, one.url])).toEqual([
    ["api", "https://git.test/acme/api/pull/1"],
    ["web", "https://git.test/acme/web/pull/1"],
  ]);
  expect(pr.url).toBe("https://git.test/acme/api/pull/1");
  expect(opened.map((one) => [path.basename(one.cwd), one.base, one.head, one.title])).toEqual([
    ["api", "main", made.branch, "Raise the port"],
    ["web", "main", made.branch, "Raise the port"],
  ]);
  const [apiPr, webPr] = opened;
  expect(apiPr!.body).toContain("Both sides move to 3.");
  expect(apiPr!.body).toContain("Part of one change across 2 repositories");
  expect(apiPr!.body).toMatch(/- web: branch `caveman\//);
  expect(webPr!.body).toContain("- api: https://git.test/acme/api/pull/1");
  // Each branch is on its own origin.
  expect(
    execFileSync("git", ["--git-dir", api.origin, "rev-parse", `refs/heads/${made.branch}`], {
      encoding: "utf8",
    }).trim(),
  ).toBe(committed.commits![0]!.sha);
  expect(
    execFileSync("git", ["--git-dir", web.origin, "rev-parse", `refs/heads/${made.branch}`], {
      encoding: "utf8",
    }).trim(),
  ).toBe(committed.commits![1]!.sha);
  // The chat shows each source's pull request.
  const after = (await client.call("workspace.get", { workspace_id: w.id })) as Workspace;
  expect(workspaceSources(after).map((s) => [s.name, s.pull_request?.url])).toEqual([
    ["api", "https://git.test/acme/api/pull/1"],
    ["web", "https://git.test/acme/web/pull/1"],
  ]);
}, 180_000);

test("a chat in one repository is on the wire it was on before sources, in a project that has several", async () => {
  const one = repoWithOrigin("one", { "README.md": "one\n" });
  const other = repoWithOrigin("other", { "README.md": "other\n" });
  const project = await client.call("project.create", { request_id: "p-one", path: one.repo });
  await client.call("project.add_source", {
    request_id: "add-other",
    project_id: project.id,
    path: other.repo,
  });

  // Absent `sources`, and `sources` naming only its own repository: a chat in `repo` alone.
  for (const [request, sources] of [
    ["plain", undefined],
    ["own-only", ["one"]],
  ] as const) {
    const w = await client.call("workspace.create", {
      request_id: request,
      repo: { path: one.repo },
      ...(sources ? { sources: [...sources] } : {}),
      title: request,
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const { events, turn } = await follow(w);
    const checkpoint = await turn("sh: printf 'changed\\n' > README.md");
    const made = await client.call("workspace.get", { workspace_id: w.id });
    // Nothing of sources on the workspace, in its events, or in what git.* answers.
    for (const value of [w, made]) {
      expect("checkouts" in value).toBe(false);
      expect("source" in value).toBe(false);
    }
    expect(JSON.stringify(events)).not.toMatch(/"checkouts"|"sources"|"source"/);
    expect(checkpoint.files?.map((f) => f.path)).toEqual(["README.md"]);
    const status = await client.call("git.status", { workspace_id: w.id });
    expect(Object.keys(status).sort()).toEqual(["ahead", "base_ref", "behind", "branch", "files"]);
    expect(
      Object.keys(
        await client.call("git.commit", {
          request_id: `${request}-commit`,
          workspace_id: w.id,
          message: "Change the readme",
        }),
      ),
    ).toEqual(["sha"]);
    expect(
      Object.keys(
        await client.call("git.push", { request_id: `${request}-push`, workspace_id: w.id }),
      ).sort(),
    ).toEqual(["branch", "sha"]);
    expect(
      Object.keys(
        await client.call("git.pr", {
          request_id: `${request}-pr`,
          workspace_id: w.id,
          title: "Readme",
        }),
      ).sort(),
    ).toEqual(["number", "state", "url"]);
    // Its folder is its worktree, as it always was, and no manifest sits beside it.
    expect(fs.existsSync(path.join(made.root_path!, ".git"))).toBe(true);
    expect(readSourceRoot(made.root_path!)).toBeUndefined();
  }
}, 180_000);

test("a source is added to a running chat: one in one repository becomes one in two, its folder where it was; a third joins beside them at once", async () => {
  const api = repoWithOrigin("svc", { "README.md": "svc\n" });
  const web = repoWithOrigin("site", { "README.md": "site\n" });
  const docs = repoWithOrigin("docs", { "README.md": "docs\n" });
  const project = await client.call("project.create", { request_id: "p-add", path: api.repo });
  await client.call("project.add_source", {
    request_id: "add-site",
    project_id: project.id,
    path: web.repo,
  });
  await client.call("project.add_source", {
    request_id: "add-docs",
    project_id: project.id,
    path: docs.repo,
  });

  const w = await client.call("workspace.create", {
    request_id: "one-then-two",
    repo: { path: api.repo },
    title: "Grows",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const { events, turn } = await follow(w);
  const before = await turn("sh: printf 'first\\n' > first.txt");
  expect(before.files?.map((f) => f.path)).toEqual(["first.txt"]);
  const one = await client.call("workspace.get", { workspace_id: w.id });
  const folder = one.root_path!;
  expect(fs.existsSync(path.join(folder, ".git"))).toBe(true);
  expect(
    await failure(
      client.call("workspace.add_source", {
        request_id: "add-nope",
        workspace_id: w.id,
        source: "nope",
      }),
    ),
  ).toMatch(/invalid_params: This chat's project has no source named nope/);
  // Its own source: the chat as it is.
  expect(
    "checkouts" in
      (await client.call("workspace.add_source", {
        request_id: "add-own",
        workspace_id: w.id,
        source: "svc",
      })),
  ).toBe(false);

  // The second source: the chat's folder stays where it is and now holds both worktrees, what it held under the primary's name.
  const two = await client.call("workspace.add_source", {
    request_id: "add-2",
    workspace_id: w.id,
    source: "site",
  });
  expect(two.root_path).toBe(folder);
  expect(two.source).toBe("svc");
  expect(two.checkouts?.map((c) => [c.name, c.branch, c.base_ref])).toEqual([
    ["site", two.branch, "main"],
  ]);
  expect(fs.readdirSync(folder).sort()).toEqual(["site", "svc"]);
  expect(fs.readFileSync(path.join(folder, "svc", "first.txt"), "utf8")).toBe("first\n");
  expect(git(path.join(folder, "svc"), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
    two.branch,
  );
  expect(git(path.join(folder, "site"), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
    two.branch,
  );
  expect(readSourceRoot(folder)).toEqual(["svc", "site"]);
  expect(
    events.some((e) => e.type === "notification" && /was added to this chat/.test(e.payload.title)),
  ).toBe(true);
  // Adding it again changes nothing.
  expect(
    (
      await client.call("workspace.add_source", {
        request_id: "add-2-again",
        workspace_id: w.id,
        source: "site",
      })
    ).checkouts?.length,
  ).toBe(1);

  // The engine carries on in the same folder, told what moved where, and edits both; the turn's checkpoint covers both.
  const second = await turn(
    ["sh: printf 'second\\n' >> svc/first.txt", "sh: printf 'page\\n' > site/page.txt"].join("\n"),
  );
  expect(second.files?.map((f) => f.path).sort()).toEqual(["site/page.txt", "svc/first.txt"]);
  // The first turn's changes, from before the chat had two sources, still read (now under the primary's name).
  const earlier = await client.call("fs.diff", { workspace_id: w.id, to: before.checkpoint_id });
  expect(earlier.files.map((f) => f.path)).toEqual(["svc/first.txt"]);

  // A third joins a chat that already works in several at once, and the next turn's checkpoint covers all three.
  const three = await client.call("workspace.add_source", {
    request_id: "add-3",
    workspace_id: w.id,
    source: "docs",
  });
  expect(three.checkouts?.map((c) => c.name)).toEqual(["site", "docs"]);
  expect(fs.readdirSync(folder).sort()).toEqual(["docs", "site", "svc"]);
  const third = await turn(
    ["sh: printf 'guide\\n' > docs/guide.md", "sh: printf 'third\\n' >> svc/first.txt"].join("\n"),
  );
  expect(third.files?.map((f) => f.path).sort()).toEqual(["docs/guide.md", "svc/first.txt"]);
  // Undo of that turn puts the source that joined before it back too.
  await client.call("checkpoint.undo", {
    request_id: "undo-third",
    session_id: w.session_id,
    checkpoint_id: third.checkpoint_id,
  });
  expect(fs.existsSync(path.join(folder, "docs", "guide.md"))).toBe(false);
  expect(fs.readFileSync(path.join(folder, "svc", "first.txt"), "utf8")).toBe("first\nsecond\n");

  // Files are found across the sources, each named from the chat's folder.
  const found = await client.call("fs.search", { workspace_id: w.id, query: "page" });
  expect(found.paths).toContain("site/page.txt");
  expect(
    (await client.call("fs.read", { workspace_id: w.id, path: "site/page.txt" })).content,
  ).toBe("page\n");
}, 240_000);

test("archive keeps every source's uncommitted work and restore puts it back; a fork and a restore to a turn cover every source", async () => {
  const api = repoWithOrigin("back", { "a.txt": "a0\n" });
  const web = repoWithOrigin("front", { "b.txt": "b0\n" });
  const project = await client.call("project.create", { request_id: "p-arch", path: api.repo });
  await client.call("project.add_source", {
    request_id: "add-front",
    project_id: project.id,
    path: web.repo,
  });
  const w = await client.call("workspace.create", {
    request_id: "arch",
    repo: { path: api.repo },
    sources: ["front"],
    title: "Kept",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const { events, turn } = await follow(w);
  await turn(["sh: printf 'a1\\n' > back/a.txt", "sh: printf 'b1\\n' > front/b.txt"].join("\n"));
  const firstDone = events.filter((e) => e.type === "turn.done").at(-1)!.cursor;
  await turn(
    [
      "sh: printf 'a2\\n' > back/a.txt",
      "sh: printf 'b2\\n' > front/b.txt",
      "sh: printf 'new\\n' > front/c.txt",
    ].join("\n"),
  );
  const made = await client.call("workspace.get", { workspace_id: w.id });
  const folder = made.root_path!;

  // A fork at the first turn: a folder of its own, each source at that turn's checkpoint, on the fork's branch.
  const fork = await client.call("session.fork", {
    request_id: "fork",
    session_id: w.session_id,
    at: firstDone,
  });
  const forked = await client.call("workspace.get", { workspace_id: fork.workspace.id });
  expect(forked.source).toBe("back");
  expect(forked.checkouts?.map((c) => [c.name, c.branch])).toEqual([["front", forked.branch]]);
  expect(forked.root_path).not.toBe(folder);
  expect(fs.readFileSync(path.join(forked.root_path!, "back", "a.txt"), "utf8")).toBe("a1\n");
  expect(fs.readFileSync(path.join(forked.root_path!, "front", "b.txt"), "utf8")).toBe("b1\n");
  expect(fs.existsSync(path.join(forked.root_path!, "front", "c.txt"))).toBe(false);
  expect(readSourceRoot(forked.root_path!)).toEqual(["back", "front"]);

  // Back to the first turn: both repositories go back together, and what came after (the second turn and the
  // person's own edit since) lives on in a branch chat that holds both as they were.
  fs.writeFileSync(path.join(folder, "front", "draft.md"), "mine\n");
  const rewound = await client.call("session.restore", {
    request_id: "rewind",
    session_id: w.session_id,
    at: firstDone,
  });
  expect(fs.readFileSync(path.join(folder, "back", "a.txt"), "utf8")).toBe("a1\n");
  expect(fs.readFileSync(path.join(folder, "front", "b.txt"), "utf8")).toBe("b1\n");
  expect(fs.existsSync(path.join(folder, "front", "c.txt"))).toBe(false);
  expect(fs.existsSync(path.join(folder, "front", "draft.md"))).toBe(false);
  const kept = rewound.branch!;
  expect(kept.checkouts?.map((c) => c.name)).toEqual(["front"]);
  expect(
    (await client.call("fs.read", { workspace_id: kept.id, path: "back/a.txt" })).content,
  ).toBe("a2\n");
  expect(
    (await client.call("fs.read", { workspace_id: kept.id, path: "front/b.txt" })).content,
  ).toBe("b2\n");
  expect(
    (await client.call("fs.read", { workspace_id: kept.id, path: "front/c.txt" })).content,
  ).toBe("new\n");
  expect(
    (await client.call("fs.read", { workspace_id: kept.id, path: "front/draft.md" })).content,
  ).toBe("mine\n");
  await until(() => events.some((e) => e.type === "session.restored"));
  // The person's own work since, in both, before the chat is archived.
  fs.writeFileSync(path.join(folder, "back", "a.txt"), "a2\n");
  fs.writeFileSync(path.join(folder, "front", "b.txt"), "b2\n");
  fs.writeFileSync(path.join(folder, "front", "c.txt"), "new\n");

  // Archive: both worktrees go, their uncommitted work kept in each repository; restore brings both back.
  const archived = await client.call("workspace.archive", {
    request_id: "archive",
    workspace_id: w.id,
  });
  expect(archived.status).toBe("archived");
  expect(fs.existsSync(path.join(folder, "back"))).toBe(false);
  expect(fs.existsSync(path.join(folder, "front"))).toBe(false);
  expect(readSourceRoot(folder)).toBeUndefined();
  for (const repo of [api.repo, web.repo])
    expect(
      git(repo, "rev-parse", "--verify", "--quiet", `refs/caveman/archived/${w.id}`).trim(),
    ).toMatch(/^[0-9a-f]{40}$/);
  const restored = await client.call("workspace.restore", {
    request_id: "restore",
    workspace_id: w.id,
  });
  expect(restored.checkouts?.map((c) => c.name)).toEqual(["front"]);
  const back = restored.root_path!;
  expect(fs.readFileSync(path.join(back, "back", "a.txt"), "utf8")).toBe("a2\n");
  expect(fs.readFileSync(path.join(back, "front", "b.txt"), "utf8")).toBe("b2\n");
  expect(fs.readFileSync(path.join(back, "front", "c.txt"), "utf8")).toBe("new\n");
  expect(readSourceRoot(back)).toEqual(["back", "front"]);
  expect(
    (await client.call("git.status", { workspace_id: w.id })).files.map((f) => f.path).sort(),
  ).toEqual(["back/a.txt", "front/b.txt", "front/c.txt"]);
}, 240_000);

test("each source's setup runs in its own worktree with its own ports, and a plain folder is linked in and never checkpointed", async () => {
  const toml = (name: string) =>
    `[setup]\nrun = ["sh -c 'echo ${name} $PORT $CAVEMAN_WORKSPACE_ID > setup-ran.txt'"]\n[run]\ncommand = "serve"\nports = ["dev"]\n`;
  const api = repoWithOrigin("core", {
    "README.md": "core\n",
    ".caveman/computer.toml": toml("core"),
    ".gitignore": "setup-ran.txt\n",
  });
  const web = repoWithOrigin("ui", {
    "README.md": "ui\n",
    ".caveman/computer.toml": toml("ui"),
    ".gitignore": "setup-ran.txt\n",
  });
  const notes = path.join(root, "notes");
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, "plan.md"), "plan\n");
  const project = await client.call("project.create", { request_id: "p-setup", path: api.repo });
  await client.call("project.add_source", {
    request_id: "add-ui",
    project_id: project.id,
    path: web.repo,
    focus: "/packages/app/",
  });
  const withFolder = await client.call("project.add_source", {
    request_id: "add-notes",
    project_id: project.id,
    path: notes,
  });
  expect(withFolder.sources).toEqual([
    { kind: "repo", name: "core", path: api.repo },
    { kind: "repo", name: "ui", path: web.repo, focus: "packages/app" },
    { kind: "folder", name: "notes", path: notes },
  ]);

  const w = await client.call("workspace.create", {
    request_id: "setup",
    repo: { path: api.repo },
    sources: ["ui", "notes"],
    title: "Set up",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const { events, turn } = await follow(w);
  await until(
    () =>
      events.filter((e) => e.type === "notification" && /Setup finished/.test(e.payload.title))
        .length === 2,
    30_000,
  );
  const made = await client.call("workspace.get", { workspace_id: w.id });
  const folder = made.root_path!;
  // Both declare a port `dev`: each has its own, the primary's under its name and the other's under its source's.
  expect(Object.keys(made.ports ?? {}).sort()).toEqual(["dev", "ui.dev"]);
  expect(made.ports!.dev).not.toBe(made.ports!["ui.dev"]);
  expect(made.run_command).toBe("cd core && serve");
  const ran = (name: string) =>
    fs
      .readFileSync(path.join(folder, name, "setup-ran.txt"), "utf8")
      .trim()
      .split(" ");
  expect(ran("core")).toEqual(["core", String(made.ports!.dev), w.id]);
  // The other source's setup ran with its own port and a workspace id of its own (so its database is not the primary's).
  expect(ran("ui")[0]).toBe("ui");
  expect(ran("ui")[1]).toBe(String(made.ports!["ui.dev"]));
  expect(ran("ui")[2]).not.toBe(w.id);
  expect(
    events
      .filter((e) => e.type === "notification" && /Setup finished/.test(e.payload.title))
      .map((e) => (e.type === "notification" ? e.payload.title.split(":")[0] : ""))
      .sort(),
  ).toEqual(["core", "ui"]);

  // The plain folder is the folder itself, linked in: an edit there is made in place, and no checkpoint holds it.
  expect(made.checkouts?.map((c) => [c.name, c.folder === true, c.branch])).toEqual([
    ["ui", false, made.branch],
    ["notes", true, ""],
  ]);
  expect(fs.lstatSync(path.join(folder, "notes")).isSymbolicLink()).toBe(true);
  expect(readSourceRoot(folder)).toEqual(["core", "ui"]);
  const edited = await turn(
    ["sh: printf 'more\\n' >> notes/plan.md", "sh: printf 'x\\n' > ui/x.txt"].join("\n"),
  );
  expect(fs.readFileSync(path.join(notes, "plan.md"), "utf8")).toBe("plan\nmore\n");
  expect(edited.files?.map((f) => f.path)).toEqual(["ui/x.txt"]);
  // Archive takes the link away and leaves the folder as it is.
  await client.call("workspace.archive", { request_id: "archive-setup", workspace_id: w.id });
  expect(fs.existsSync(path.join(folder, "notes"))).toBe(false);
  expect(fs.readFileSync(path.join(notes, "plan.md"), "utf8")).toBe("plan\nmore\n");
}, 240_000);
