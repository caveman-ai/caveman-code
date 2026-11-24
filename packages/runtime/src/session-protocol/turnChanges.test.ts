// The Changes card on the real runtime (Claude adapter on scripts/smoke-claude.mjs, which writes "write: <path> <text>"):
// a turn's checkpoint.created names the files the turn itself wrote, with line counts; checkpoint.undo puts them back
// to the turn's start only while each is still what the turn left, and never touches what was there before the turn,
// what the person staged, or a turn other than the latest; checkpoint.keep closes the card. The fake's writes wait for
// the PreToolUse hook, as a real CLI's tools do, so no turn writes before its baseline is kept: a new chat's first
// turn's is its thread's start, every later turn's the workspace as it began.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { git, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-turn-changes-");
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
    () => "ok",
    (error: { error?: { message?: string; data?: { reason?: string } } }) => `${error.error?.data?.reason}: ${error.error?.message}`,
  );
const done = (events: ReadonlyArray<SessionEvent>) => events.filter((e) => e.type === "turn.done").length;
const checkpoints = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "checkpoint.created" ? [e.payload] : []));
/** The later turns' baselines kept in this repo so far (CheckpointService's turn starts). */
const turnStarts = (tree: string) =>
  git(tree, "for-each-ref", "--format=%(refname)", "refs/t3/orchestration-v2/checkpoints/").split("\n").filter((ref) => ref.includes("/turn-start/")).length;

async function chat(title: string, files: Record<string, string> = { "README.md": "hi\n" }) {
  const repo = makeRepo(root, files);
  const w = await client.call("workspace.create", { request_id: title, repo: { path: repo }, title, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  // The chat's worktree is made after workspace.create answers: its folder shows before git has checked it out, and
  // its "git worktree add" step is done once git is.
  const made = () => events.find((e) => e.type === "tool.started" && e.payload.name === "worktree")?.item_id;
  await until(() => events.some((e) => e.type === "tool.done" && e.item_id === made()));
  let n = 0;
  const turn = async (text: string) => {
    const before = done(events);
    await client.call("turn.submit", { request_id: `${title}-${n++}`, session_id: w.session_id, kind: "followup", input: { text } });
    await until(() => done(events) > before && checkpoints(events).length > before, 30_000);
    return checkpoints(events).at(-1)!;
  };
  /**
   * A turn that does `work` to the files while it runs, as an agent's tools would (the stand-in CLI only writes): once
   * the turn's baseline is kept, as those tools wait for it.
   */
  const working = async (work: () => void) => {
    const kept = turnStarts(w.root_path!);
    const pending = turn("hold 2000");
    await until(() => turnStarts(w.root_path!) > kept);
    work();
    return pending;
  };
  return { w, repo, events, turn, working, tree: w.root_path!, undo: (id: string) => client.call("checkpoint.undo", { request_id: `u-${id}-${n++}`, session_id: w.session_id, checkpoint_id: id }) };
}
/** What Undo answered: the files it put back, or why it refused. */
const undone = (promise: Promise<{ files: ReadonlyArray<string> }>) =>
  promise.then(
    (result) => result.files.toSorted(),
    (error: { error?: { message?: string } }) => `refused: ${error.error?.message}`,
  );
/** A diff's files as a card lists them: path and counts, by path. */
const counts = (files: ReadonlyArray<{ path: string; additions: number; deletions: number }>) =>
  files.map(({ path, additions, deletions }) => ({ path, additions, deletions })).toSorted((x, y) => x.path.localeCompare(y.path));

test("a turn's files carry their counts; Undo puts back only them, keeps what was there before and what is staged", async () => {
  const { w, events, turn, tree, undo } = await chat("undo");
  // The person's own untracked file from before: never a turn's.
  fs.writeFileSync(path.join(tree, "scratch.txt"), "mine\n");
  // A turn that changes nothing has no files (no card).
  expect((await turn("hello")).files).toEqual([]);
  const first = await turn("write: pilot.md one\ntwo\n");
  expect(first.files).toEqual([{ path: "pilot.md", additions: 2, deletions: 0 }]);
  expect(fs.readFileSync(path.join(tree, "pilot.md"), "utf8")).toBe("one\ntwo");

  const second = await turn("write: README.md hello\n");
  expect(second.files).toEqual([{ path: "README.md", additions: 1, deletions: 1 }]);
  // The first turn is not the latest any more.
  expect(await failure(undo(first.checkpoint_id))).toMatch(/^invalid_state: a later turn finished/);

  git(tree, "add", "scratch.txt");
  const undone = await undo(second.checkpoint_id);
  expect(undone.files).toEqual(["README.md"]);
  expect(fs.readFileSync(path.join(tree, "README.md"), "utf8")).toBe("hi\n");
  // Nothing else moved: the first turn's file, the person's own file, and what they staged.
  expect(fs.readFileSync(path.join(tree, "pilot.md"), "utf8")).toBe("one\ntwo");
  expect(fs.readFileSync(path.join(tree, "scratch.txt"), "utf8")).toBe("mine\n");
  expect(git(tree, "diff", "--cached", "--name-only").trim()).toBe("scratch.txt");
  await until(() => events.some((e) => e.type === "checkpoint.resolved"));
  const resolved = events.find((e) => e.type === "checkpoint.resolved")!;
  expect(resolved.payload).toEqual({ checkpoint_id: second.checkpoint_id, resolution: "undone", files: ["README.md"] });
  // The Changes tab follows the files back.
  expect(events.find((e) => e.cursor === resolved.cursor - 1)?.type).toBe("diff.changed");
  expect(await failure(undo(second.checkpoint_id))).toMatch(/^invalid_state: those changes were already undone/);
  expect(await failure(client.call("checkpoint.keep", { request_id: "k-late", session_id: w.session_id, checkpoint_id: second.checkpoint_id }))).toMatch(/already undone/);
});

test("a new chat's first turn that writes at once lists every file, as the Changes tab's Latest turn does", async () => {
  // As the fake writes the instant its turn starts (a real engine's first tool can come within milliseconds), while the
  // run is still keeping the turn's baseline: a file written before the baseline was kept fell out of the card.
  const { w, turn } = await chat("first-turn", { "src/session.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n" });
  const changed = "export const a = 1;\nexport const b = 20;\nexport const c = 30;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n";
  const made = "import { a } from './session';\n\nexport function guard() {\n  return a;\n}\nexport const g = 7;";
  const first = await turn(`write: src/session.ts ${changed}\nwrite: src/middleware.ts ${made}`);
  expect(first.files).toEqual([
    { path: "src/middleware.ts", additions: 6, deletions: 0 },
    { path: "src/session.ts", additions: 5, deletions: 2 },
  ]);
  // The Changes tab's Latest turn for a chat's first turn: from the base to the turn's checkpoint.
  const tab = await client.call("fs.diff", { workspace_id: w.id, to: first.checkpoint_id });
  expect(counts(tab.files)).toEqual(first.files);
});

test("the Changes tab's turn starts where the turn began: a first turn's leaves out what was there before it", async () => {
  const { w, turn, tree } = await chat("tab-first");
  // The worktree's folder shows before its checkout is done: an edit written sooner is checked out over.
  await until(() => fs.existsSync(path.join(tree, "README.md")));
  // The person's own edits before the chat's first turn: in the turn's baseline, not its changes.
  fs.writeFileSync(path.join(tree, "README.md"), "mine\n");
  fs.writeFileSync(path.join(tree, "scratch.txt"), "mine\n");
  const first = await turn("write: pilot.md one");
  expect(first.files).toEqual([{ path: "pilot.md", additions: 1, deletions: 0 }]);
  // Latest turn (the web sends a chat's first turn with no `from`): from the checkpoint taken as the turn began.
  const tab = await client.call("fs.diff", { workspace_id: w.id, to: first.checkpoint_id });
  expect(counts(tab.files)).toEqual(first.files);
  expect(tab.from).toMatch(/^checkpoint:.*:name:0$/);
  // All changes still diffs the working tree against the base.
  const all = await client.call("fs.diff", { workspace_id: w.id });
  expect(all.files.map((f) => f.path).toSorted()).toEqual(["README.md", "pilot.md", "scratch.txt"]);
});

test("the Changes tab's turn leaves out what a merge in the turn brought in, as the card does; All changes keeps it", async () => {
  const { w, repo, turn, tree } = await chat("tab-merge");
  const hello = await turn("hello");
  // A teammate's work, committed before the turn began (a fetched branch): the turn merges it in.
  const old = { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
  git(repo, "checkout", "-q", "-b", "upstream");
  for (const name of ["a", "b", "c"]) {
    fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
    fs.writeFileSync(path.join(repo, "lib", `${name}.txt`), `${name}\n`);
  }
  git(repo, "add", "lib");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "upstream"], { cwd: repo, env: old });
  git(repo, "checkout", "-q", "main");
  // The turn writes its file, then (while it holds its answer) HEAD fast-forwards onto the teammate's commit.
  const pending = turn("write: pilot.md one\nhold 3000");
  await until(() => fs.existsSync(path.join(tree, "pilot.md")));
  git(tree, "merge", "-q", "--ff-only", "upstream");
  const merged = await pending;
  expect(merged.files).toEqual([{ path: "pilot.md", additions: 2, deletions: 0 }]);
  // Turn N as the web asks for it (from the turn before's checkpoint) and with no `from`: what the card says.
  const tab = await client.call("fs.diff", { workspace_id: w.id, from: hello.checkpoint_id, to: merged.checkpoint_id });
  expect(counts(tab.files)).toEqual(merged.files);
  expect(counts((await client.call("fs.diff", { workspace_id: w.id, to: merged.checkpoint_id })).files)).toEqual(merged.files);
  // All changes is everything against the base, the merged files too.
  const all = await client.call("fs.diff", { workspace_id: w.id });
  expect(all.files.map((f) => f.path).toSorted()).toEqual(["lib/a.txt", "lib/b.txt", "lib/c.txt", "pilot.md"]);
});

test("the Changes tab names a non-ASCII file the turn edited as it is, in the turn and in All changes, and it opens", async () => {
  const name = "café.md";
  const { w, repo, turn, tree } = await chat("tab-accents", { [name]: "before\n", "README.md": "hi\n" });
  // Git's default, stated so a global core.quotePath=false can't hide what git prints.
  git(repo, "config", "core.quotePath", "true");
  const hello = await turn("hello");
  const old = { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
  git(repo, "checkout", "-q", "-b", "upstream");
  fs.writeFileSync(path.join(repo, "lib.txt"), "lib\n");
  git(repo, "add", "lib.txt");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "upstream"], { cwd: repo, env: old });
  git(repo, "checkout", "-q", "main");
  // HEAD moves in the turn, so the turn's own range keeps only what it authored.
  const pending = turn(`write: ${name} after\nhold 3000`);
  await until(() => fs.readFileSync(path.join(tree, name), "utf8").startsWith("after"));
  git(tree, "merge", "-q", "--ff-only", "upstream");
  const edited = await pending;
  expect(edited.files?.map((f) => f.path)).toEqual([name]);

  const paths = async (params: { from?: string; to?: string }) =>
    (await client.call("fs.diff", { workspace_id: w.id, ...params })).files.map((f) => `${f.path} ${f.status}`).toSorted();
  expect(await paths({ to: edited.checkpoint_id })).toEqual([`${name} modified`]);
  expect(await paths({ from: hello.checkpoint_id, to: edited.checkpoint_id })).toEqual([`${name} modified`]);
  const all = await client.call("fs.diff", { workspace_id: w.id });
  expect(all.files.map((f) => `${f.path} ${f.status}`).toSorted()).toEqual([`${name} modified`, "lib.txt added"]);
  for (const file of all.files) expect((await client.call("fs.read", { workspace_id: w.id, path: file.path })).content).not.toBe("");
});

test("the Changes tab shows a file whose name reads as a pattern (app/[slug]/page.tsx) with its own patch, never its look-alikes'", async () => {
  const routes = ["app/[slug]/page.tsx", "app/s/page.tsx", "app/l/page.tsx"];
  const { w, repo, tree } = await chat("tab-glob", Object.fromEntries(routes.map((file) => [file, "before\n"])));
  // The person's diff.submodule=log prints a changed submodule without a "diff --git" header, so the whole diff's
  // sections no longer line up with its files and each file's patch is asked for on its own.
  git(repo, "config", "diff.submodule", "log");
  for (const file of routes) fs.appendFileSync(path.join(tree, file), "after\n");
  git(tree, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
  fs.mkdirSync(path.join(tree, "vendor", "lib"), { recursive: true });

  const { files } = await client.call("fs.diff", { workspace_id: w.id });
  const headers = (file: string) => files.find((f) => f.path === file)?.patch.match(/^diff --git .*$/gm);
  expect(routes.map(headers)).toEqual(routes.map((file) => [`diff --git a/${file} b/${file}`]));
});

test("the person's edit between two turns is not the next turn's: its card, its Changes tab and its Undo leave it alone", async () => {
  const { w, turn, tree, undo } = await chat("between");
  await until(() => fs.existsSync(path.join(tree, "README.md")));
  const hello = await turn("hello");
  // Between the turns the person edits a file in their editor.
  fs.writeFileSync(path.join(tree, "README.md"), "mine\n");
  const second = await turn("write: notes.md note\n");
  expect(second.files).toEqual([{ path: "notes.md", additions: 1, deletions: 0 }]);
  // Turn 2 as the web asks for it (from the turn before's checkpoint) and with no `from`: what the card says.
  expect(counts((await client.call("fs.diff", { workspace_id: w.id, from: hello.checkpoint_id, to: second.checkpoint_id })).files)).toEqual(second.files);
  expect(counts((await client.call("fs.diff", { workspace_id: w.id, to: second.checkpoint_id })).files)).toEqual(second.files);
  expect(await undone(undo(second.checkpoint_id))).toEqual(["notes.md"]);
  expect(fs.existsSync(path.join(tree, "notes.md"))).toBe(false);
  expect(fs.readFileSync(path.join(tree, "README.md"), "utf8")).toBe("mine\n");
});

test("the Changes tab shows every file whatever the person's git diff settings", async () => {
  const repo = makeRepo(root, { "README.md": "one\n\ntwo\n" });
  // A nested repository committed as a submodule, which the chat moves.
  git(repo, "init", "-q", "-b", "main", "sub");
  git(path.join(repo, "sub"), "commit", "-q", "--allow-empty", "-m", "one");
  git(repo, "-c", "advice.addEmbeddedRepo=false", "add", "sub");
  git(repo, "commit", "-qm", "sub");
  const w = await client.call("workspace.create", { request_id: "diff-settings", repo: { path: repo }, title: "diff-settings", engine: "claude-agent", options: { model: MODEL } });
  const tree = w.root_path!;
  await until(() => fs.existsSync(path.join(tree, "README.md")));
  fs.writeFileSync(path.join(tree, "README.md"), "one\n\nthree\n");
  fs.writeFileSync(path.join(tree, "new.txt"), "new\n");
  git(tree, "clone", "-q", path.join(repo, "sub"), "sub");
  git(path.join(tree, "sub"), "commit", "-q", "--allow-empty", "-m", "moved");
  const before = await client.call("fs.diff", { workspace_id: w.id });
  expect(before.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
    ["README.md", "modified", 1, 1],
    ["sub", "modified", 1, 1],
    ["new.txt", "added", 1, 0],
  ]);
  expect(before.files[0]!.patch).toContain("diff --git a/README.md b/README.md\n");
  expect(before.files[0]!.patch).toContain(" one\n \n-two\n+three\n");
  expect(before.files[1]!.patch).toContain("+Subproject commit ");

  // What a person's ~/.gitconfig may say, set on the repository. (diff.relative is pinned too, but changes nothing
  // here: fs.diff runs at the worktree's root.)
  for (const [key, value] of [
    ["diff.external", "echo external"],
    ["color.ui", "always"],
    ["diff.noprefix", "true"],
    ["diff.mnemonicPrefix", "true"],
    ["diff.suppressBlankEmpty", "true"],
    ["diff.submodule", "log"],
  ] as const) git(tree, "config", key, value);
  expect(git(tree, "diff", "main")).toContain("external");
  expect(await client.call("fs.diff", { workspace_id: w.id })).toEqual(before);
});

test("a file the turn made is removed; a file changed again after the turn blocks Undo and nothing is written", async () => {
  const { turn, tree, undo } = await chat("blocked");
  await turn("hello");
  const made = await turn("write: draft.md draft\n");
  expect(made.files).toEqual([{ path: "draft.md", additions: 1, deletions: 0 }]);
  expect((await undo(made.checkpoint_id)).files).toEqual(["draft.md"]);
  expect(fs.existsSync(path.join(tree, "draft.md"))).toBe(false);

  const edited = await turn("write: README.md turn\n");
  // The person edits the file after the turn: Undo would lose that.
  fs.writeFileSync(path.join(tree, "README.md"), "turn\nand mine\n");
  expect(await failure(undo(edited.checkpoint_id))).toMatch(/^invalid_state: README\.md changed after this turn/);
  expect(fs.readFileSync(path.join(tree, "README.md"), "utf8")).toBe("turn\nand mine\n");
});

test("with core.fileMode off, Undo of a turn's edit to a file that is executable on disk goes through", async () => {
  const { turn, tree, undo } = await chat("file-mode", { "README.md": "hi\n", "run.sh": "echo old\n" });
  // What git sets itself on a volume whose chmod doesn't stick (exFAT, SMB, DrvFs): every file shows as executable,
  // and git keeps recording run.sh as 100644.
  git(tree, "config", "core.fileMode", "false");
  fs.chmodSync(path.join(tree, "run.sh"), 0o755);
  expect(git(tree, "status", "--porcelain")).toBe("");
  const card = await turn("write: run.sh echo new\n");
  expect(card.files?.map((f) => f.path)).toEqual(["run.sh"]);
  expect(await undone(undo(card.checkpoint_id))).toEqual(["run.sh"]);
  expect(fs.readFileSync(path.join(tree, "run.sh"), "utf8")).toBe("echo old\n");
});

test("Undo puts a file the turn moved back where it was", async () => {
  const long = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of a file long enough for git to see it moved`).join("\n") + "\n";
  const { turn, working, tree, undo } = await chat("moved", { "README.md": "hi\n", "src/old.ts": long });
  await until(() => fs.existsSync(path.join(tree, "src/old.ts")));
  await turn("hello");
  const moved = await working(() => fs.renameSync(path.join(tree, "src/old.ts"), path.join(tree, "src/new.ts")));
  // The card shows a move as the one file it is now.
  expect(moved.files).toEqual([{ path: "src/new.ts", additions: 0, deletions: 0 }]);
  expect(await undone(undo(moved.checkpoint_id))).toEqual(["src/new.ts", "src/old.ts"]);
  expect(fs.readFileSync(path.join(tree, "src/old.ts"), "utf8")).toBe(long);
  expect(fs.existsSync(path.join(tree, "src/new.ts"))).toBe(false);
  expect(git(tree, "status", "--porcelain")).toBe("");
});

test("a file whose name starts or ends with whitespace is on the card as git names it, and Undo puts it back", async () => {
  const { turn, working, tree, undo } = await chat("edge-space", { "README.md": "hi\n", " lead.md": "mine\n" });
  await until(() => fs.existsSync(path.join(tree, " lead.md")));
  await turn("hello");
  const edited = await working(() => {
    fs.writeFileSync(path.join(tree, " lead.md"), "the turn's\n");
    fs.writeFileSync(path.join(tree, "notes "), "the turn's\n");
    fs.writeFileSync(path.join(tree, " "), "the turn's\n");
  });
  expect(edited.files?.map((f) => f.path).toSorted()).toEqual([" ", " lead.md", "notes "]);
  expect(await undone(undo(edited.checkpoint_id))).toEqual([" ", " lead.md", "notes "]);
  expect(fs.readFileSync(path.join(tree, " lead.md"), "utf8")).toBe("mine\n");
  expect(fs.existsSync(path.join(tree, "notes "))).toBe(false);
  expect(fs.existsSync(path.join(tree, " "))).toBe(false);
  expect(git(tree, "status", "--porcelain")).toBe("");
});

test("Undo puts back a file the turn turned into a directory", async () => {
  const { turn, working, tree, undo } = await chat("file-to-dir", { "README.md": "hi\n", notes: "mine\n" });
  await until(() => fs.existsSync(path.join(tree, "notes")));
  await turn("hello");
  const swapped = await working(() => {
    fs.rmSync(path.join(tree, "notes"));
    fs.mkdirSync(path.join(tree, "notes"));
    fs.writeFileSync(path.join(tree, "notes/todo.md"), "the turn's\n");
  });
  expect(swapped.files?.map((f) => f.path)).toEqual(["notes", "notes/todo.md"]);
  expect(await undone(undo(swapped.checkpoint_id))).toEqual(["notes", "notes/todo.md"]);
  expect(fs.readFileSync(path.join(tree, "notes"), "utf8")).toBe("mine\n");
  expect(git(tree, "status", "--porcelain")).toBe("");
});

test("Undo puts back a directory the turn turned into a file, and refuses once the person does that after a turn", async () => {
  const { turn, working, tree, undo } = await chat("dir-to-file", { "README.md": "hi\n", "notes/todo.md": "mine\n" });
  await until(() => fs.existsSync(path.join(tree, "notes/todo.md")));
  await turn("hello");
  const swapped = await working(() => {
    fs.rmSync(path.join(tree, "notes"), { recursive: true });
    fs.writeFileSync(path.join(tree, "notes"), "the turn's\n");
  });
  expect(swapped.files?.map((f) => f.path)).toEqual(["notes", "notes/todo.md"]);
  expect(await undone(undo(swapped.checkpoint_id))).toEqual(["notes", "notes/todo.md"]);
  expect(fs.readFileSync(path.join(tree, "notes/todo.md"), "utf8")).toBe("mine\n");
  expect(git(tree, "status", "--porcelain")).toBe("");

  const later = await chat("dir-to-file-after", { "README.md": "hi\n", "notes/todo.md": "mine\n" });
  await until(() => fs.existsSync(path.join(later.tree, "notes/todo.md")));
  const edited = await later.turn("write: notes/todo.md the turn's\n");
  fs.rmSync(path.join(later.tree, "notes"), { recursive: true });
  fs.writeFileSync(path.join(later.tree, "notes"), "the person's\n");
  expect(await undone(later.undo(edited.checkpoint_id))).toMatch(/^refused: notes\/todo\.md changed after this turn/);
  expect(fs.readFileSync(path.join(later.tree, "notes"), "utf8")).toBe("the person's\n");
});

test("Keep closes the card on every client; a fork's copied turns are not this chat's", async () => {
  const { w, events, turn } = await chat("keep");
  const kept = await turn("write: a.md a\n");
  await client.call("checkpoint.keep", { request_id: "k1", session_id: w.session_id, checkpoint_id: kept.checkpoint_id });
  await until(() => events.some((e) => e.type === "checkpoint.resolved"));
  expect(events.find((e) => e.type === "checkpoint.resolved")!.payload).toEqual({ checkpoint_id: kept.checkpoint_id, resolution: "kept", files: [] });
  expect(await failure(client.call("checkpoint.undo", { request_id: "u-kept", session_id: w.session_id, checkpoint_id: kept.checkpoint_id }))).toMatch(/already kept/);
  expect(await failure(client.call("checkpoint.keep", { request_id: "k2", session_id: w.session_id, checkpoint_id: "checkpoint:nope" }))).toMatch(/^not_found/);

  const at = events.filter((e) => e.type === "turn.done").at(-1)!.cursor;
  const fork = await client.call("session.fork", { request_id: "kf", session_id: w.session_id, at });
  expect(await failure(client.call("checkpoint.undo", { request_id: "u-fork", session_id: fork.session.id, checkpoint_id: kept.checkpoint_id }))).toMatch(/^not_found/);
});

test("another chat working in the same checkout during the turn makes Undo refuse", async () => {
  const a = await chat("shared-a");
  const b = await chat("shared-b");
  // B is busy across A's whole turn.
  await client.call("turn.submit", { request_id: "b-slow", session_id: b.w.session_id, kind: "followup", input: { text: "slow 4000: thinking" } });
  await until(() => b.events.some((e) => e.type === "turn.started"));
  const turnA = await a.turn("write: shared.md a\n");
  await until(() => done(b.events) === 1, 30_000);
  // As if B ran in A's checkout (a chat on the same folder).
  const db = new DatabaseSync(config.dbPath);
  const row = db.prepare("SELECT internal FROM caveman_sp_workspaces WHERE session_id = ?").get(b.w.session_id) as { internal: string };
  db.prepare("UPDATE caveman_sp_workspaces SET internal = ? WHERE session_id = ?").run(JSON.stringify({ ...JSON.parse(row.internal), worktreePath: a.tree }), b.w.session_id);
  db.close();
  expect(await failure(a.undo(turnA.checkpoint_id))).toMatch(/^invalid_state: another chat worked in this checkout/);
  expect(fs.existsSync(path.join(a.tree, "shared.md"))).toBe(true);
});
