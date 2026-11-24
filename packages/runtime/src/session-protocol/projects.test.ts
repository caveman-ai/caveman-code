// project.* on upstream project event log: a project per repository top level,
// added by project.create or workspace.create, removed only once its
// workspaces are archived, and brought back by re-adding or restoring. Each
// workspace's thread lives in the same project as its record.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@caveman-app/protocol";
import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as GitHubApi from "@caveman-app/source-control-github/server/GitHubApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { createReady, git, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const root = tempRoot("sp-projects-");
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ reason: "ok", message: "" }),
    (error: { error?: { message?: string; data?: { reason?: string } } }) => ({ reason: error.error?.data?.reason, message: error.error?.message }),
  );
/** A repository on disk as a file URL: file:///C:/… on Windows, where `file://${path}` is no URL. */
const fileUrl = (file: string) => pathToFileURL(file).href;
const idFor = (repo: string) => `caveman-repo:${createHash("sha256").update(fs.realpathSync(repo)).digest("hex").slice(0, 16)}`;
const listed = async () => (await client.call("project.list", {})).projects;
const workspace = (request_id: string, repo: { path: string } | { url: string }) =>
  createReady(client, { request_id, repo, engine: "claude-agent", options: { model: MODEL } });
/** The project T3 holds the workspace's thread in. */
const threadProject = (dbPath: string, w: Pick<Workspace, "id">) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(`caveman:${w.id}`) as { project_id: string }).project_id;
  } finally {
    db.close();
  }
};

/** upstream own project service (its HTTP, MCP and CLI path) on a runtime's database while that runtime is stopped. */
const withT3Projects = <A>(dbConfig: ServerConfig.ServerConfig["Service"], use: (projects: ProjectService.ProjectService["Service"]) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* ProjectService.ProjectService);
    }).pipe(
      Effect.provide(
        RuntimeLayer.layerProjectService.pipe(
          Layer.provideMerge(ProjectEnrichmentService.layer),
          Layer.provideMerge(
            Layer.succeed(WorkspacePaths.WorkspacePaths, {
              normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
              resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
                Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
            }),
          ),
          Layer.provideMerge(
            Layer.merge(
              Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
              Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, { resolvePath: () => Effect.succeed(null) }),
            ),
          ),
          Layer.provideMerge(SqlitePersistence.layerFromPath(dbConfig.dbPath)),
          Layer.provideMerge(ServerSettings.layerTest()),
          Layer.provide(Layer.succeed(ServerConfig.ServerConfig, dbConfig)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
const t3Create = (dbConfig: ServerConfig.ServerConfig["Service"], workspaceRoot: string) =>
  withT3Projects(dbConfig, (projects) => {
    const id = crypto.randomUUID();
    return projects.create({ commandId: CommandId.make(id), projectId: ProjectId.make(id), title: "T3", workspaceRoot });
  });
const t3Owner = (dbConfig: ServerConfig.ServerConfig["Service"], workspaceRoot: string) =>
  withT3Projects(dbConfig, (projects) => projects.getByWorkspaceRoot(workspaceRoot).pipe(Effect.map(Option.getOrThrow)));

test("create adds a repository's top level once; the list holds ours, oldest first", async () => {
  const a = makeRepo(root, { "src/index.ts": "export {};\n" });
  const pa = await client.call("project.create", { request_id: "a1", path: path.join(a, "src") });
  expect(pa).toMatchObject({ id: idFor(a), name: path.basename(a), path: fs.realpathSync(a) });
  expect(await client.call("project.create", { request_id: "a2", path: a, name: "Ignored" })).toEqual(pa);
  const b = makeRepo(root, { "README.md": "b\n" });
  const pb = await client.call("project.create", { request_id: "b1", path: b, name: "Bee" });
  expect(pb.name).toBe("Bee");
  const ids = (await listed()).map((p) => p.id);
  expect(ids.indexOf(pa.id)).toBeLessThan(ids.indexOf(pb.id));
  expect(ids.every((id) => id.startsWith("caveman-repo:"))).toBe(true);
});

test("update renames; unknown, blank and T3 ids are not_found for update and remove", async () => {
  const p = await client.call("project.create", { request_id: "r1", path: makeRepo(root, { "README.md": "r\n" }) });
  const renamed = await client.call("project.update", { request_id: "r2", project_id: p.id, name: "Renamed" });
  expect(renamed).toMatchObject({ id: p.id, name: "Renamed", created_at: p.created_at });
  for (const id of ["nope", "   ", "caveman-repo:nope"]) {
    expect((await failure(client.call("project.update", { request_id: `u:${id}`, project_id: id, name: "x" }))).reason).toBe("not_found");
    expect((await failure(client.call("project.remove", { request_id: `x:${id}`, project_id: id }))).reason).toBe("not_found");
  }
});

test("pin and archive stamp their first time, keep the name and undo; archiving keeps the project listed and its chat live", async () => {
  const repo = makeRepo(root, { "README.md": "pin\n" });
  const w = await workspace("organize", { path: repo });
  const id = w.project_id!;
  const pinned = await client.call("project.update", { request_id: "o1", project_id: id, pinned: true });
  expect(pinned.pinned_at).toBeDefined();
  expect(pinned.archived_at).toBeUndefined();
  // Pinning again keeps the first time; a rename leaves the pin alone.
  expect((await client.call("project.update", { request_id: "o2", project_id: id, pinned: true })).pinned_at).toBe(pinned.pinned_at);
  expect(await client.call("project.update", { request_id: "o3", project_id: id, name: "Pinned" })).toMatchObject({ name: "Pinned", pinned_at: pinned.pinned_at });

  // Archiving keeps the project listed (marked) and its chat live.
  const archived = await client.call("project.update", { request_id: "o4", project_id: id, archived: true, pinned: false });
  expect(archived.archived_at).toBeDefined();
  expect(archived.pinned_at).toBeUndefined();
  expect((await listed()).find((p) => p.id === id)).toMatchObject({ name: "Pinned", archived_at: archived.archived_at });
  expect((await client.call("workspace.get", { workspace_id: w.id })).status).not.toBe("archived");

  const restored = await client.call("project.update", { request_id: "o5", project_id: id, archived: false });
  expect(restored.archived_at).toBeUndefined();
  expect(restored).toMatchObject({ id, name: "Pinned" });
});

test("a wide ignored folder lists from one check of the folder; a tracked file under it makes git answer per child", async () => {
  const repo = makeRepo(root, { "src/app.ts": "export {};\n", ".gitignore": "vendor/\n" });
  const w = await workspace("wide-ignored", { path: repo });
  const tree = w.root_path!;
  for (let i = 0; i < 1001; i++) fs.mkdirSync(path.join(tree, "vendor", `pkg${i}`), { recursive: true });
  expect((await client.call("fs.list", { workspace_id: w.id, path: "vendor" })).entries).toEqual([]);
  const all = await client.call("fs.list", { workspace_id: w.id, path: "vendor", include_ignored: true });
  expect(all.entries).toHaveLength(1001);
  expect(all.entries.every((e) => e.type === "dir" && e.ignored === true)).toBe(true);
  fs.writeFileSync(path.join(tree, "vendor", "pkg1", "kept.js"), "1\n");
  git(tree, "add", "-f", "vendor/pkg1/kept.js");
  const mixed = await client.call("fs.list", { workspace_id: w.id, path: "vendor", include_ignored: true });
  expect(mixed.entries.find((e) => e.name === "pkg1")?.ignored).toBeUndefined();
  expect(mixed.entries.find((e) => e.name === "pkg2")).toMatchObject({ ignored: true });
  expect((await client.call("fs.list", { workspace_id: w.id, path: "vendor" })).entries.map((e) => e.name)).toEqual(["pkg1"]);
});

test("update keeps the user's instructions and hidden paths; search and the file panel leave hidden paths out", async () => {
  const repo = makeRepo(root, {
    "src/app.ts": "export {};\n",
    "fixtures/big.json": "{}\n",
    "secrets/prod.env": "X=1\n",
    "notes/plan.md": "plan\n",
    ".cavemanignore": "# committed\nnotes/\n",
  });
  const w = await workspace("hide", { path: repo });
  const id = w.project_id!;
  const searched = async () => (await client.call("fs.search", { workspace_id: w.id, query: "", limit: 100 })).paths;
  expect(await searched()).toEqual(expect.arrayContaining(["src/app.ts", "fixtures/big.json", "secrets/prod.env"]));
  expect(await searched()).not.toContain("notes/plan.md");

  const updated = await client.call("project.update", { request_id: "h1", project_id: id, instructions: "Use pnpm.", ignorePaths: ["/secrets/", " *.json ", ""] });
  expect(updated).toMatchObject({ id, instructions: "Use pnpm.", ignorePaths: ["/secrets/", "*.json"] });
  expect((await listed()).find((p) => p.id === id)).toMatchObject({ instructions: "Use pnpm.", ignorePaths: ["/secrets/", "*.json"] });
  expect(await searched()).toEqual(expect.arrayContaining(["src/app.ts", ".cavemanignore"]));
  for (const gone of ["fixtures/big.json", "secrets/prod.env", "notes/plan.md"]) expect(await searched()).not.toContain(gone);
  const top = (await client.call("fs.list", { workspace_id: w.id, path: "", include_ignored: true })).entries.map((e) => e.path);
  expect(top).toEqual(expect.arrayContaining(["src", "fixtures"]));
  expect(top).not.toContain("secrets");
  expect(top).not.toContain("notes");
  expect((await client.call("fs.list", { workspace_id: w.id, path: "fixtures" })).entries).toEqual([]);

  // A rename leaves them alone; empty values clear them.
  expect(await client.call("project.update", { request_id: "h2", project_id: id, name: "Hidden" })).toMatchObject({ name: "Hidden", instructions: "Use pnpm." });
  const cleared = await client.call("project.update", { request_id: "h3", project_id: id, instructions: " ", ignorePaths: [] });
  expect(cleared.instructions).toBeUndefined();
  expect(cleared.ignorePaths).toBeUndefined();
  expect(await searched()).toContain("secrets/prod.env");
  expect((await failure(client.call("project.update", { request_id: "h4", project_id: id }))).reason).toBe("invalid_params");
});

test("create takes a file as the folder it is in; refuses what is no folder, and Caveman's own worktrees", async () => {
  const repo = makeRepo(root, { "src/index.ts": "export {};\n" });
  expect(await client.call("project.create", { request_id: "file1", path: path.join(repo, "src", "index.ts") })).toMatchObject({ path: fs.realpathSync(repo) });
  for (const bad of ["relative/path", path.join(root, "missing")]) {
    expect((await failure(client.call("project.create", { request_id: `bad:${bad}`, path: bad }))).reason).toBe("invalid_params");
  }
  const w = await workspace("wt", { path: makeRepo(root, { "README.md": "wt\n" }) });
  expect((await failure(client.call("project.create", { request_id: "wt1", path: w.root_path! }))).reason).toBe("invalid_params");
});

test("a folder in no repository is a project whose chats run in it; init_git gives its new chats worktrees", async () => {
  const plain = path.join(root, "IPE - Riley");
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, "notes.md"), "lecture 1\n");
  const project = await client.call("project.create", { request_id: "plain1", path: plain });
  expect(project).toMatchObject({ path: fs.realpathSync(plain), no_git: true });

  // Its chat runs in the folder itself: no branch, no worktree, nothing of git made there.
  const w = await workspace("plain-w", { path: plain });
  expect(w).toMatchObject({ project_id: project.id, branch: "", base_ref: "", root_path: fs.realpathSync(plain) });
  expect(fs.existsSync(path.join(plain, ".git"))).toBe(false);
  // What needs its own checkout says why it can't.
  expect(await failure(client.call("session.fork", { request_id: "plain-fork", session_id: w.session_id }))).toMatchObject({ reason: "invalid_state", message: expect.stringContaining("not a checkout of its own") });
  expect((await failure(client.call("session.park", { request_id: "plain-park", session_id: w.session_id }))).reason).toBe("invalid_state");
  expect((await failure(createReady(client, { request_id: "plain-branch", repo: { path: plain }, branch: "topic", engine: "claude-agent", options: { model: MODEL } }))).reason).toBe("invalid_params");

  // Archiving leaves the folder and its files.
  await client.call("workspace.archive", { request_id: "plain-archive", workspace_id: w.id });
  expect(fs.readFileSync(path.join(plain, "notes.md"), "utf8")).toBe("lecture 1\n");

  // Initialize git: one commit of its files, the project is a repository, and a new chat gets its own worktree.
  const made = await client.call("project.init_git", { request_id: "plain-init", project_id: project.id });
  expect(made.no_git).toBeUndefined();
  expect(git(plain, "ls-files").trim()).toBe("notes.md");
  expect((await failure(client.call("project.init_git", { request_id: "plain-init2", project_id: project.id }))).reason).toBe("invalid_state");
  const next = await workspace("plain-w2", { path: plain });
  expect(next.project_id).toBe(project.id);
  expect(next.branch).toMatch(/^caveman\//);
  expect(next.root_path).not.toBe(fs.realpathSync(plain));
  expect(fs.readFileSync(path.join(next.root_path!, "notes.md"), "utf8")).toBe("lecture 1\n");
});

// A translated git (Homebrew's, linked to libintl) answers in the person's language: "Kein Git-Repository" under
// de_DE. This stand-in for one runs the real git and says what such a build says, unless the locale is C.
test.skipIf(process.platform === "win32")("a folder in no repository is a project whatever language the person's git speaks", async () => {
  const bin = path.join(root, "german-git");
  fs.mkdirSync(bin);
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(bin, "git"),
    [
      "#!/bin/sh",
      'case "${LC_ALL:-${LC_MESSAGES:-$LANG}}" in ""|C|C.*|POSIX) exec "$REAL_GIT" "$@" ;; esac',
      'err=$(mktemp); "$REAL_GIT" "$@" 2>"$err"; code=$?',
      "sed 's/^fatal: not a git repository (or any of the parent directories)/Schwerwiegend: Kein Git-Repository (oder irgendeines der Elternverzeichnisse)/' \"$err\" >&2",
      'rm -f "$err"; exit $code',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const plain = path.join(root, "Vorlesung");
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, "notizen.md"), "Vorlesung 1\n");
  const was = { PATH: process.env.PATH, LC_ALL: process.env.LC_ALL, REAL_GIT: process.env.REAL_GIT };
  const restore = () => {
    for (const [name, value] of Object.entries(was)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  };
  // The runtime as launched from a German terminal, with that git first on PATH.
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${was.PATH}`, LC_ALL: "de_DE.UTF-8", REAL_GIT: real });
  try {
    expect(execFileSync("sh", ["-c", "git rev-parse --is-inside-work-tree 2>&1 || true"], { cwd: plain, encoding: "utf8" })).toContain("Kein Git-Repository");
    const project = await client.call("project.create", { request_id: "plain-de", path: plain }).then(
      (made) => ({ path: made.path, no_git: made.no_git }),
      (error: { error?: { message?: string } }) => ({ refused: error.error?.message }),
    );
    expect(project).toEqual({ path: fs.realpathSync(plain), no_git: true });
    expect((await client.call("project.init_git", { request_id: "plain-de-init", project_id: (await listed()).find((p) => p.path === fs.realpathSync(plain))!.id })).no_git).toBeUndefined();
  } finally {
    restore();
  }
});

test("an archived chat in a plain folder comes back with restore, in its folder, and takes turns again", async () => {
  const plain = path.join(root, "Lecture notes");
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, "notes.md"), "lecture 1\n");
  await client.call("project.create", { request_id: "folder-restore-project", path: plain });
  const w = await workspace("folder-restore-w", { path: plain });
  await client.call("workspace.archive", { request_id: "folder-restore-archive", workspace_id: w.id });

  const restored = await client.call("workspace.restore", { request_id: "folder-restore", workspace_id: w.id });
  expect(restored).toMatchObject({ status: "idle", branch: "", root_path: fs.realpathSync(plain) });
  expect(fs.readFileSync(path.join(plain, "notes.md"), "utf8")).toBe("lecture 1\n");
  expect(fs.existsSync(path.join(plain, ".git"))).toBe(false);
  // Nothing made for it under the worktrees folder, and no word of changes it never had.
  expect(fs.existsSync(path.join(config.worktreesDir, path.basename(fs.realpathSync(plain))))).toBe(false);
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  expect(events.filter((e) => e.type === "notification" && e.payload.level === "warning")).toEqual([]);
  await client.call("turn.submit", { request_id: "folder-restore-turn", session_id: w.session_id, kind: "followup", input: { text: "still here" } });
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  const said = events.filter((e) => e.type === "message.done" && e.payload.role === "assistant").at(-1);
  expect(said?.type === "message.done" && said.payload.text).toBe("smoke ok: still here");
});

test("branches: the checkout's own first, then the rest; a query narrows them; a chat starts from the one picked", async () => {
  const repo = makeRepo(root, { "README.md": "b\n" });
  git(repo, "branch", "fix/footer");
  git(repo, "branch", "feat/launch-page");
  git(repo, "checkout", "-q", "feat/launch-page");
  const project = await client.call("project.create", { request_id: "branches1", path: repo });

  const all = await client.call("project.branches", { project_id: project.id });
  expect(all.checkout).toBe("feat/launch-page");
  expect(all.branches[0]).toEqual({ name: "feat/launch-page", current: true });
  expect(all.branches.map((b) => b.name).sort()).toEqual(["feat/launch-page", "fix/footer", "main"]);
  expect(all.more).toBe(false);
  expect((await client.call("project.branches", { project_id: project.id, query: "FOOT" })).branches.map((b) => b.name)).toEqual(["fix/footer"]);

  // The worktree New chat makes ahead is no base.
  await client.call("workspace.prewarm", { request_id: "branches-warm", repo: { path: repo } });
  await until(() => git(repo, "branch", "--list", "caveman/chat-*").trim() !== "");
  expect((await client.call("project.branches", { project_id: project.id })).branches.map((b) => b.name).sort()).toEqual(["feat/launch-page", "fix/footer", "main"]);

  // The checkout switched since: the picker opening reads it as it is now.
  git(repo, "checkout", "-q", "main");
  expect(await client.call("project.branches", { project_id: project.id })).toMatchObject({ checkout: "main", branches: [{ name: "main", current: true }, {}, {}] });

  // The picked branch is the chat's base.
  git(repo, "checkout", "-q", "fix/footer");
  fs.writeFileSync(path.join(repo, "footer.md"), "links\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "footer");
  git(repo, "checkout", "-q", "main");
  const w = await createReady(client, { request_id: "branches-w", repo: { path: repo }, base_ref: "fix/footer", engine: "claude-agent", options: { model: MODEL } });
  expect(w.base_ref).toBe("fix/footer");
  expect(fs.readFileSync(path.join(w.root_path!, "footer.md"), "utf8")).toBe("links\n");

  const plain = path.join(root, "plain-branches");
  fs.mkdirSync(plain);
  const folder = await client.call("project.create", { request_id: "branches-plain", path: plain });
  expect(await client.call("project.branches", { project_id: folder.id })).toEqual({ branches: [], more: false });
  expect((await failure(client.call("project.branches", { project_id: "caveman-repo:0000000000000000" }))).reason).toBe("not_found");
});

test("workspace.create puts the workspace and its thread in the repository's project", async () => {
  const c = makeRepo(root, { "README.md": "c\n" });
  const w = await workspace("wc", { path: c });
  expect(w.project_id).toBe(idFor(c));
  expect((await client.call("workspace.get", { workspace_id: w.id })).project_id).toBe(idFor(c));
  expect(threadProject(config.dbPath, w)).toBe(w.project_id);
  expect((await listed()).find((p) => p.id === w.project_id)).toMatchObject({ name: path.basename(c), path: fs.realpathSync(c) });

  // A repository from a URL is named from the URL, not its clone's folder.
  const origin = path.join(root, "widgets.git");
  execFileSync("git", ["clone", "-q", "--bare", c, origin]);
  const fromUrl = await workspace("wu", { url: fileUrl(origin) });
  expect((await listed()).find((p) => p.id === fromUrl.project_id)?.name).toBe("widgets");
  expect(threadProject(config.dbPath, fromUrl)).toBe(fromUrl.project_id);
});

test("remove waits for every workspace to be archived, keeps them, and succeeds again on a retry", async () => {
  const d = makeRepo(root, { "README.md": "d\n" });
  const w = await workspace("wd", { path: d });
  expect(await failure(client.call("project.remove", { request_id: "d1", project_id: w.project_id! }))).toEqual({
    reason: "invalid_state",
    message: "Archive its 1 workspace first",
  });
  await client.call("workspace.archive", { request_id: "d2", workspace_id: w.id });
  expect(await client.call("project.remove", { request_id: "d3", project_id: w.project_id! })).toEqual({});
  expect(await client.call("project.remove", { request_id: "d4", project_id: w.project_id! })).toEqual({});
  expect((await listed()).some((p) => p.id === w.project_id)).toBe(false);
  const kept = (await client.call("workspace.list", { include_archived: true })).workspaces.find((x) => x.id === w.id);
  expect(kept).toMatchObject({ status: "archived", project_id: w.project_id });
  expect((await client.call("repo.list", {})).repos.map((r) => r.path)).toContain(fs.realpathSync(d));
});

test("remove with archive_chats archives its open workspaces first, and restore brings the project back", async () => {
  const d = makeRepo(root, { "README.md": "d\n" });
  const a = await workspace("wa1", { path: d });
  const b = await workspace("wa2", { path: d });
  expect(b.project_id).toBe(a.project_id);
  expect(await client.call("project.remove", { request_id: "da1", project_id: a.project_id!, archive_chats: true })).toEqual({});
  expect((await listed()).some((p) => p.id === a.project_id)).toBe(false);
  const all = (await client.call("workspace.list", { include_archived: true })).workspaces;
  expect(all.filter((x) => x.id === a.id || x.id === b.id).map((x) => x.status)).toEqual(["archived", "archived"]);
  await client.call("workspace.restore", { request_id: "da2", workspace_id: a.id });
  expect((await listed()).some((p) => p.id === a.project_id)).toBe(true);
});

test("an archived workspace comes back only through restore, which brings back its project and name", async () => {
  const e = makeRepo(root, { "README.md": "e\n" });
  const w = await workspace("we", { path: e });
  await client.call("project.update", { request_id: "e0", project_id: w.project_id!, name: "Sea" });
  await client.call("session.park", { request_id: "e1", session_id: w.session_id });
  await client.call("workspace.archive", { request_id: "e2", workspace_id: w.id });
  await client.call("project.remove", { request_id: "e3", project_id: w.project_id! });
  expect(await failure(client.call("session.resume", { request_id: "e4", session_id: w.session_id }))).toEqual({
    reason: "invalid_state",
    message: "the workspace is archived; restore it first",
  });
 // upstream thread commands still run while its project is removed (restore re-points the thread first).
  const restored = await client.call("workspace.restore", { request_id: "e5", workspace_id: w.id });
  expect(restored).toMatchObject({ status: "idle", project_id: w.project_id });
  expect((await listed()).find((p) => p.id === w.project_id)).toMatchObject({ name: "Sea" });
  expect(threadProject(config.dbPath, restored)).toBe(w.project_id);
});

test("re-adding a removed repository brings the same project back", async () => {
  const f = makeRepo(root, { "README.md": "f\n" });
  const p = await client.call("project.create", { request_id: "f1", path: f, name: "Eff" });
  await client.call("project.remove", { request_id: "f2", project_id: p.id });
  const readded = await client.call("project.create", { request_id: "f3", path: f });
  expect(readded).toMatchObject({ id: p.id, name: "Eff", path: fs.realpathSync(f) });
  expect((await listed()).at(-1)?.id).toBe(p.id);
});

test("a fork stays in its source's project, record and thread", async () => {
  const g = makeRepo(root, { "README.md": "g\n" });
  const w = await workspace("wg", { path: g });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (event) => events.push(event));
  await client.call("turn.submit", { request_id: "g1", session_id: w.session_id, kind: "followup", input: { text: "hello" } });
  await until(() => events.some((event) => event.type === "turn.done"), 30_000);
  const at = events.find((event) => event.type === "turn.done")!.cursor;
  const fork = await client.call("session.fork", { request_id: "g2", session_id: w.session_id, at });
  expect(fork.workspace.project_id).toBe(w.project_id);
  expect(threadProject(config.dbPath, fork.workspace)).toBe(w.project_id);
});

test("records from before projects get their thread's project at start; live ones get it back", async () => {
  const own = await makeConfig();
  let rt = await startRuntime(own, "fake-claude");
  let c = connect(rt.url, rt.token);
  const seed = await createReady(c, { request_id: "s", repo: { path: makeRepo(root, { "README.md": "s\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  expect(seed.project_id).toBeDefined();
  c.close();
  await rt.close();

  const live = makeRepo(root, { "README.md": "live\n" });
  const archived = makeRepo(root, { "README.md": "archived\n" });
  const foreign = makeRepo(root, { "README.md": "foreign\n" });
  const db = new DatabaseSync(own.dbPath);
  const legacy = db.prepare(`INSERT INTO caveman_sp_workspaces (id, session_id, thread_id, workspace, session, internal, created_at)
    SELECT ?, ?, ?, json_set(json_remove(workspace, '$.project_id'), '$.id', ?, '$.session_id', ?, '$.status', ?),
      json_set(session, '$.id', ?, '$.workspace_id', ?), json_set(internal, '$.repoPath', ?, '$.threadId', ?), created_at
    FROM caveman_sp_workspaces WHERE id = ?`);
  for (const [id, status, repo] of [["legacy-live", "idle", live], ["legacy-archived", "archived", archived], ["legacy-foreign", "idle", foreign]] as const) {
    legacy.run(id, `${id}-session`, `caveman:${id}`, id, `${id}-session`, status, `${id}-session`, id, fs.realpathSync(repo), `caveman:${id}`, seed.id);
  }
  // A stored project_id that is not one of ours is not trusted.
  db.prepare(`UPDATE caveman_sp_workspaces SET workspace = json_set(workspace, '$.project_id', 'project-t3') WHERE id = 'legacy-foreign'`).run();
  db.close();
  rt = await startRuntime(own, "fake-claude");
  c = connect(rt.url, rt.token);
  try {
    expect((await c.call("workspace.get", { workspace_id: "legacy-live" })).project_id).toBe(idFor(live));
    expect((await c.call("workspace.get", { workspace_id: "legacy-archived" })).project_id).toBe(idFor(archived));
    expect((await c.call("workspace.get", { workspace_id: "legacy-foreign" })).project_id).toBe(idFor(foreign));
    const projects = (await c.call("project.list", {})).projects;
    expect(projects.find((p) => p.id === idFor(live))).toMatchObject({ name: path.basename(live), path: fs.realpathSync(live) });
    expect(projects.some((p) => p.id === idFor(archived))).toBe(false);
  } finally {
    c.close();
    await rt.close();
  }
});

test("a repository T3 already has a project for still gets ours; T3 still finds its own there", async () => {
  const own = await makeConfig();
  const repo = fs.realpathSync(makeRepo(root, { "README.md": "t3\n" }));
  const t3 = await t3Create(own, repo);
  const rt = await startRuntime(own, "fake-claude");
  const c = connect(rt.url, rt.token);
  try {
    const w = await createReady(c, { request_id: "t", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
    expect(w.project_id).toBe(idFor(repo));
    expect(threadProject(own.dbPath, w)).toBe(w.project_id);
    expect((await c.call("project.list", {})).projects.map((p) => p.id)).toEqual([idFor(repo)]);
  } finally {
    c.close();
    await rt.close();
  }
  expect((await t3Owner(own, repo)).id).toBe(t3.id);
});

test("the backfill gives a workspace its own project when T3 has one for the repository", async () => {
  const own = await makeConfig();
  let rt = await startRuntime(own, "fake-claude");
  let c = connect(rt.url, rt.token);
  const seed = await c.call("workspace.create", { request_id: "s", repo: { path: makeRepo(root, { "README.md": "s\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  c.close();
  await rt.close();

  const repo = fs.realpathSync(makeRepo(root, { "README.md": "legacy\n" }));
  const t3 = await t3Create(own, repo);
  const db = new DatabaseSync(own.dbPath);
  db.prepare(`INSERT INTO caveman_sp_workspaces (id, session_id, thread_id, workspace, session, internal, created_at)
    SELECT 'legacy', 'legacy-session', 'caveman:legacy', json_set(json_remove(workspace, '$.project_id'), '$.id', 'legacy', '$.session_id', 'legacy-session'),
      json_set(session, '$.id', 'legacy-session', '$.workspace_id', 'legacy'), json_set(internal, '$.repoPath', ?, '$.threadId', 'caveman:legacy'), created_at
    FROM caveman_sp_workspaces WHERE id = ?`).run(repo, seed.id);
  db.close();
  rt = await startRuntime(own, "fake-claude");
  c = connect(rt.url, rt.token);
  try {
    expect((await c.call("workspace.get", { workspace_id: "legacy" })).project_id).toBe(idFor(repo));
    expect((await c.call("project.list", {})).projects.map((p) => p.id)).toContain(idFor(repo));
  } finally {
    c.close();
    await rt.close();
  }
  expect((await t3Owner(own, repo)).id).toBe(t3.id);
});

test("discover offers the repositories sessions ran in and their siblings; a url adds that checkout or clones it", async () => {
  // A home where a Claude Code and a Codex session ran in widget; sibling sits next to it untouched; wt is widget's worktree.
  const home = path.join(root, "home");
  const stuff = path.join(home, "stuff");
  fs.mkdirSync(stuff, { recursive: true });
  const widget = makeRepo(stuff, { "src/index.ts": "export {};\n" });
  git(widget, "remote", "add", "origin", "git@github.com:acme/widget.git");
  const sibling = makeRepo(stuff, { "README.md": "sibling\n" });
  git(widget, "worktree", "add", "-q", "-b", "wt", path.join(stuff, "wt"));
  const transcripts = path.join(home, ".claude", "projects", widget.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, "s1.jsonl"), `${JSON.stringify({ type: "user", cwd: path.join(widget, "src"), sessionId: "s1" })}\n${JSON.stringify({ type: "assistant" })}\n`);
  const codexDay = path.join(home, ".codex", "sessions", ...new Date().toISOString().slice(0, 10).split("-"));
  fs.mkdirSync(codexDay, { recursive: true });
  fs.writeFileSync(path.join(codexDay, "rollout-1.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "r1", cwd: widget } })}\n`);

 // The user's own homes, with no Settings: Codex counts without a compact login. GitHub is a fake that lists one
  // repository with no checkout here, pushed ten days ago.
  const own = await makeConfig();
  const pushed = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const gitHub = {
    rest: () => Effect.succeed({ status: 200, body: JSON.stringify([{ full_name: "acme/gadget2", pushed_at: pushed }]), headers: {}, truncated: false, invalidUtf8: false }),
  };
  const provide = Layer.mergeAll(
    Layer.succeed(HostProcess.HomeDirectory, home),
    Layer.succeed(HostProcess.Environment, {}),
    Layer.succeed(GitHubApi.GitHubApi, gitHub as never),
  );
  const rt = await startRuntime(own, "fake-claude", undefined, { provide: provide as Layer.Layer<any> });
  const c = connect(rt.url, rt.token);
  try {
    const found = await c.call("project.discover", {});
    expect(found.clone_dir).toBe(stuff);
    expect(found.candidates.map((x) => x.path ?? x.name)).toEqual([widget, sibling, "gadget2"]);
    expect(found.candidates[0]).toMatchObject({
      name: path.basename(widget),
      sources: ["claude", "codex", "folder"],
      sessions: 2,
      repository: { host: "github.com", full_name: "acme/widget", web_url: "https://github.com/acme/widget", clone_url: "https://github.com/acme/widget.git" },
    });
    expect(found.candidates[1]).toMatchObject({ sources: ["folder"], sessions: 0 });
    expect(found.candidates[1]!.repository).toBeUndefined();
    expect(found.candidates[2]).toMatchObject({ sources: ["github"], repository: { full_name: "acme/gadget2" } });

    // owner/name of a repository with a checkout here adds that checkout; nothing is cloned.
    const linked = await c.call("project.create", { request_id: "u1", url: "acme/widget" });
    expect(linked).toMatchObject({ path: widget, repository: { full_name: "acme/widget" } });
    expect(fs.readdirSync(stuff).sort()).toEqual([path.basename(sibling), path.basename(widget), "wt"].sort());
    expect((await c.call("project.list", {})).projects.find((p) => p.id === linked.id)?.repository?.full_name).toBe("acme/widget");
    expect((await c.call("project.discover", {})).candidates.find((x) => x.path === widget)?.project_id).toBe(linked.id);

    // A repository with no checkout here is cloned into clone_dir, once.
    const bare = path.join(root, "gadget.git");
    execFileSync("git", ["clone", "-q", "--bare", sibling, bare]);
    const cloned = await c.call("project.create", { request_id: "u2", url: fileUrl(bare) });
    expect(cloned.path).toBe(path.join(stuff, "gadget"));
    expect(git(cloned.path, "remote", "get-url", "origin").trim()).toBe(fileUrl(bare));
    expect((await c.call("project.create", { request_id: "u3", url: fileUrl(bare) })).id).toBe(cloned.id);

    // A URL can name clone_dir's own git dir (".git.git" clones to ".git"); the clone gets a plain name instead.
    const evil = path.join(root, "evil", ".git.git");
    execFileSync("git", ["clone", "-q", "--bare", sibling, evil]);
    expect((await c.call("project.create", { request_id: "e1", url: fileUrl(evil) })).path).toBe(path.join(stuff, "git"));
    expect(fs.existsSync(path.join(stuff, ".git"))).toBe(false);

    // Unencrypted URLs are refused; credentials in a URL appear in no error, and the failed clone leaves nothing.
    for (const [id, url] of [["h1", "http://example.com/a/b.git"], ["h2", "git://example.com/a/b.git"]] as const) {
      expect(await failure(c.call("project.create", { request_id: id, url }))).toMatchObject({ reason: "invalid_params", message: expect.stringContaining("use https or ssh") });
    }
    const leaked = await failure(c.call("project.create", { request_id: "s1", url: "https://user:hunter2@127.0.0.1:9/acme/thing.git" }));
    expect(leaked).toMatchObject({ reason: "invalid_params", message: expect.stringContaining("network error") });
    expect(leaked.message).not.toMatch(/hunter2|user@/);
    expect(fs.existsSync(path.join(stuff, "thing"))).toBe(false);

    // A repository the scan saw only on GitHub, added since, shows as that project with its checkout.
    const gadget2 = makeRepo(root, { "README.md": "gadget2\n" });
    git(gadget2, "remote", "add", "origin", "https://github.com/acme/gadget2.git");
    const added = await c.call("project.create", { request_id: "g1", path: gadget2 });
    const shown = (await c.call("project.discover", {})).candidates.filter((x) => x.repository?.full_name === "acme/gadget2");
    expect(shown).toEqual([expect.objectContaining({ path: fs.realpathSync(gadget2), project_id: added.id })]);

    // `~` is the home.
    expect((await c.call("project.create", { request_id: "t1", path: `~/stuff/${path.basename(sibling)}` })).path).toBe(fs.realpathSync(sibling));

    // Exactly one of path or url; a clone that fails leaves no folder behind.
    for (const [id, params] of [["v1", {}], ["v2", { path: widget, url: "acme/widget" }], ["v3", { url: "-oops" }], ["v4", { url: fileUrl(path.join(root, "missing.git")) }]] as const) {
      expect((await failure(c.call("project.create", { request_id: id, ...params }))).reason).toBe("invalid_params");
    }
    expect(fs.existsSync(path.join(stuff, "missing"))).toBe(false);
  } finally {
    c.close();
    await rt.close();
  }
});

test("a chat's Actions: [run] first, then actions.toml from its checkout, then the person's own, and package.json's other scripts", async () => {
  const repo = makeRepo(root, {
    ".caveman/computer.toml": `[run]\ncommand = "pnpm dev"\n`,
    ".caveman/actions.toml": `[test]\ncommand = "pnpm test"\nicon = "test"\n\n[typecheck]\ncommand = "pnpm typecheck"\n`,
    "package.json": JSON.stringify({ scripts: { dev: "vite", test: "vitest", typecheck: "tsc", lint: "eslint .", postinstall: "x" } }),
    "pnpm-lock.yaml": "",
  });
  const w = await workspace("act", { path: repo });
  const listActions = () => client.call("actions.list", { workspace_id: w.id });
  expect(await listActions()).toEqual({
    actions: [
      { id: "run", name: "Run", command: "pnpm dev", icon: "play", source: "run" },
      { id: "test", name: "Test", command: "pnpm test", icon: "test", source: "repo" },
      { id: "typecheck", name: "Typecheck", command: "pnpm typecheck", source: "repo" },
    ],
    suggestions: [{ name: "lint", command: "pnpm run lint" }],
  });

  // The person's own are the project's, on this computer: a suggestion taken stops being suggested.
  const saved = await client.call("project.update", { request_id: "act-1", project_id: w.project_id!, actions: [{ id: "lint", name: " Lint ", command: " pnpm run lint ", icon: "lint" }] });
  expect(saved.actions).toEqual([{ id: "lint", name: "Lint", command: "pnpm run lint", icon: "lint" }]);
  expect((await listActions()).actions.at(-1)).toEqual({ id: "lint", name: "Lint", command: "pnpm run lint", icon: "lint", source: "personal" });
  expect((await listActions()).suggestions).toEqual([]);
  const dup = [{ id: "a", name: "A", command: "x" }, { id: "a", name: "B", command: "y" }];
  expect(await failure(client.call("project.update", { request_id: "act-2", project_id: w.project_id!, actions: dup }))).toMatchObject({ reason: "invalid_params", message: "two actions are named a" });
  expect((await failure(client.call("project.update", { request_id: "act-3", project_id: w.project_id!, actions: [{ id: "a", name: "A", command: "  " }] }))).reason).toBe("invalid_params");

  // The chat's own checkout is read each time: an edit on its branch shows, a bad file says why and keeps the rest.
  const checkout = (await client.call("workspace.get", { workspace_id: w.id })).root_path!;
  fs.writeFileSync(path.join(checkout, ".caveman/actions.toml"), `[test]\ncommand = "pnpm test"\nflavour = "x"\n`);
  const broken = await listActions();
  expect(broken.error).toBe('.caveman/actions.toml:3: unknown key "test.flavour"');
  expect(broken.actions.map((a) => a.source)).toEqual(["run", "personal"]);

  expect((await client.call("project.update", { request_id: "act-4", project_id: w.project_id!, actions: [] })).actions).toBeUndefined();
});

test("git.installed: this computer's git, as adding and cloning projects run it", async () => {
  const installed = await client.call("git.installed", {});
  expect(installed).toMatchObject({ ready: true, version: expect.stringMatching(/^\d+\.\d+/) });
  // git is here: nothing to start.
  await expect(client.call("git.install", { request_id: "gi1" })).rejects.toMatchObject({ error: { data: { reason: "invalid_state" } } });
});
