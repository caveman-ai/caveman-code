// session.fork shares the journal prefix; session.park pushes the work in
// progress to refs/caveman/sessions/<id> on a local remote; fs.diff and git.*
// run on the workspace's worktree.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { makeProviderReplayGate } from "@caveman-app/engine-testing/replayGate";
import { afterAll, expect, test } from "vitest";

import { git, loadTranscript, makeConfig, makeRepo, MODEL, PROMPT, startRuntime, tempRoot, until } from "./testHarness.ts";
import { CAVEMAN_CO_AUTHOR } from "../git/coAuthor.ts";

const root = tempRoot("sp-fork-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );

test("fork at a turn.done, park and resume, diff, commit and push", async () => {
  const origin = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const repo = makeRepo(root, { "README.md": "hello\n" });
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");

  const runtime = await startRuntime(await makeConfig(), await loadTranscript(), makeProviderReplayGate([]));
  const client = connect(runtime.url, runtime.token);
  try {
    const w = await client.call("workspace.create", { request_id: "w", repo: { path: repo }, title: "Source", engine: "claude-agent", options: { model: MODEL } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text: PROMPT } });
    await until(() => events.some((e) => e.type === "turn.done"));
    const at = events.find((e) => e.type === "turn.done")!.cursor;
    expect(await reason(client.call("session.fork", { request_id: "f0", session_id: w.session_id, at: 1 }))).toBe("invalid_params");
    // Without `at` (the sidebar's and header's Fork): from the latest finished turn.
    const latest = await client.call("session.fork", { request_id: "f-latest", session_id: w.session_id });
    expect(latest.session.forked_from).toEqual({ session_id: w.session_id, cursor: at });

    // Fork: a new workspace and session sharing events 1..at, re-stamped with the fork's id.
    const fork = await client.call("session.fork", { request_id: "f1", session_id: w.session_id, at });
    expect(fork.session.forked_from).toEqual({ session_id: w.session_id, cursor: at });
    expect(fork.session.head).toBe(at);
    expect(fork.workspace.branch).toMatch(/^caveman\/source-fork-/);
    // What the fork is at comes from its own prefix (here the source's, which has not moved on).
    expect(fork.workspace.activity).toMatchObject({ last_outcome: "completed" });
    expect(fork.workspace.activity).toEqual((await client.call("workspace.get", { workspace_id: w.id })).activity);
    const forked: Array<SessionEvent> = [];
    await client.attach(fork.session.id, 0, (e) => forked.push(e));
    await until(() => forked.length >= at);
    expect(forked.map(({ session_id: _s, ...rest }) => rest)).toEqual(events.slice(0, at).map(({ session_id: _s, ...rest }) => rest));
    expect(forked.every((e) => e.session_id === fork.session.id)).toBe(true);
    const forkFile = await client.call("fs.read", { workspace_id: fork.workspace.id, path: "README.md" });
    expect(forkFile.content).toBe("hello\n");

    // Work in progress in the source worktree.
    // git lists worktrees with forward slashes on Windows; root_path is the native path.
    const tree = path.resolve(git(repo, "worktree", "list", "--porcelain").split("\n").find((l, i, all) => all[i + 2] === `branch refs/heads/${w.branch}`)!.slice(9));
    fs.writeFileSync(path.join(tree, "README.md"), "hello\nworld\n");
    fs.writeFileSync(path.join(tree, "notes.txt"), "draft\n");
    expect(w.root_path).toBe(tree);
    fs.mkdirSync(path.join(tree, "src"));
    fs.writeFileSync(path.join(tree, "src", "parser.ts"), "export {};\n");
    fs.writeFileSync(path.join(tree, ".gitignore"), "*.log\n");
    fs.writeFileSync(path.join(tree, "debug.log"), "noise\n");
    const listing = await client.call("fs.list", { workspace_id: w.id, path: "" });
    expect(listing.entries.map((e) => [e.name, e.type])).toEqual([["src", "dir"], [".gitignore", "file"], ["notes.txt", "file"], ["README.md", "file"]]);
    const withIgnored = await client.call("fs.list", { workspace_id: w.id, path: "", include_ignored: true });
    expect(withIgnored.entries.find((e) => e.name === "debug.log")).toMatchObject({ ignored: true });
    expect((await client.call("fs.list", { workspace_id: w.id, path: "src" })).entries).toEqual([{ name: "parser.ts", path: "src/parser.ts", type: "file", size: 11 }]);
    expect((await client.call("fs.search", { workspace_id: w.id, query: "prs" })).paths).toEqual(["src/parser.ts"]);
    expect((await client.call("fs.search", { workspace_id: w.id, query: "rdm" })).paths[0]).toBe("README.md");
    const partial = await client.call("fs.read", { workspace_id: w.id, path: "README.md", max_bytes: 5 });
    expect(partial).toMatchObject({ content: "hello", truncated: true, size: 12, mime_type: "text/markdown" });
    fs.rmSync(path.join(tree, "src"), { recursive: true });
    fs.rmSync(path.join(tree, ".gitignore"));
    fs.rmSync(path.join(tree, "debug.log"));
    const diff = await client.call("fs.diff", { workspace_id: w.id });
    expect(diff.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["README.md", "modified", 1, 0],
      ["notes.txt", "added", 1, 0],
    ]);
    expect(diff.files[0]!.patch).toContain("+world");

    // Park: the work in progress lands on refs/caveman/sessions/<id> at the remote; the branch and files stay.
    const head = git(tree, "rev-parse", "HEAD").trim();
    const parked = await client.call("session.park", { request_id: "p1", session_id: w.session_id });
    expect(parked.state).toBe("parked");
    expect(parked.lease).toBeUndefined();
    await until(() => events.some((e) => e.type === "session.parked"));
    const ref = `refs/caveman/sessions/${w.session_id}`;
    const pushed = execFileSync("git", ["--git-dir", origin, "show", `${ref}:notes.txt`], { encoding: "utf8" });
    expect(pushed).toBe("draft\n");
    expect(execFileSync("git", ["--git-dir", origin, "show", `${ref}:README.md`], { encoding: "utf8" })).toBe("hello\nworld\n");
    expect(git(tree, "rev-parse", "HEAD").trim()).toBe(head);
    expect(fs.readFileSync(path.join(tree, "notes.txt"), "utf8")).toBe("draft\n");
    expect((await client.call("workspace.get", { workspace_id: w.id })).status).toBe("parked");
    expect(await reason(client.call("turn.submit", { request_id: "t2", session_id: w.session_id, kind: "queue", input: { text: "x" } }))).toBe("parked");

    const resumed = await client.call("session.resume", { request_id: "r1", session_id: w.session_id });
    expect(resumed.state).toBe("live");
    await until(() => events.some((e) => e.type === "session.resumed"));
    expect(events.find((e) => e.type === "session.resumed")?.payload).toEqual({ computer_id: "this-mac" });

    // git.*: commit one path, push the branch.
    const commit = await client.call("git.commit", { request_id: "c1", workspace_id: w.id, message: "docs: world", paths: ["README.md"] });
    expect(git(tree, "log", "-1", "--format=%H %s").trim()).toBe(`${commit.sha} docs: world`);
    // Caveman's co-author trailer is on by default.
    expect(git(tree, "log", "-1", "--format=%b").trim()).toBe(CAVEMAN_CO_AUTHOR);
    const status = await client.call("git.status", { workspace_id: w.id });
    expect(status.files.map((f) => f.path)).toEqual(["notes.txt"]);
    const push = await client.call("git.push", { request_id: "g1", workspace_id: w.id });
    expect(push).toEqual({ branch: w.branch, sha: commit.sha });
    expect(execFileSync("git", ["--git-dir", origin, "rev-parse", w.branch], { encoding: "utf8" }).trim()).toBe(commit.sha);
    expect(await reason(client.call("git.pr", { request_id: "pr", workspace_id: w.id, title: "x" }))).toBe("unsupported");
    expect(await reason(client.call("git.commit", { request_id: "c2", workspace_id: w.id, message: "x", paths: ["../escape"] }))).toBe("invalid_params");
    // Off in Settings: the message goes in as written.
    await client.call("settings.set", { request_id: "s-off", settings: { git_co_author: false } });
    await client.call("git.commit", { request_id: "c3", workspace_id: w.id, message: "chore: notes", paths: ["notes.txt"] });
    expect(git(tree, "log", "-1", "--format=%s|%b").trim()).toBe("chore: notes|");
    await client.call("settings.set", { request_id: "s-on", settings: { git_co_author: true } });

    const repos = await client.call("repo.list", {});
    expect(repos.repos[0]).toMatchObject({ path: fs.realpathSync(repo), name: path.basename(repo), remote_url: origin, default_branch: "main" });
    expect(await reason(client.call("message.caveman_version", { session_id: w.session_id, item_id: events.find((e) => e.type === "message.done" && e.payload.role === "assistant")!.item_id! }))).toBe("engine_unavailable");
    expect(await reason(client.call("browser.snapshot", { workspace_id: w.id }))).toBe("unsupported");
    const settings = await client.call("settings.set", { request_id: "s1", settings: { theme: "dark", favorite_models: ["claude-agent/claude-sonnet-4-6"] } });
    expect(settings).toMatchObject({ theme: "dark", default_engine: "claude-agent", favorite_models: ["claude-agent/claude-sonnet-4-6"] });
    expect(await client.call("settings.get", {})).toEqual(settings);
  } finally {
    client.close();
    await runtime.close();
  }
});

test("a fork's first turn runs on Claude: the SDK forks the source's session at the turn and the fork resumes it", async () => {
  const repo = makeRepo(root, { "README.md": "hello\n" });
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  const client = connect(runtime.url, runtime.token);
  try {
    const w = await client.call("workspace.create", { request_id: "cw", repo: { path: repo }, title: "Source", engine: "claude-agent", options: { model: MODEL, access: "full" } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    for (const text of ["first", "second"]) {
      const done = events.filter((e) => e.type === "turn.done").length;
      await client.call("turn.submit", { request_id: text, session_id: w.session_id, kind: "followup", input: { text } });
      await until(() => events.filter((e) => e.type === "turn.done").length > done, 30_000);
    }
    const at = events.find((e) => e.type === "turn.done")!.cursor;
    const { workspace, session } = await client.call("session.fork", { request_id: "cf", session_id: w.session_id, at });
    const forked: Array<SessionEvent> = [];
    await client.attach(session.id, 0, (e) => forked.push(e));
    await client.call("turn.submit", { request_id: "on-fork", session_id: session.id, kind: "followup", input: { text: "on the fork" } });
    await until(() => forked.some((e) => e.type === "turn.done" && e.cursor > at), 30_000);
    const done = forked.find((e) => e.type === "turn.done" && e.cursor > at)!;
    expect(done.payload).toEqual({ status: "completed" });
    expect(forked.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" && e.cursor > at ? [e.payload.text] : []))).toEqual(["smoke ok: on the fork"]);
    expect(workspace.id).not.toBe(w.id);
  } finally {
    client.close();
    await runtime.close();
  }
});
