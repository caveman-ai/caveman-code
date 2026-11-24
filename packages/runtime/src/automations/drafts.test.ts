import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { draftSignature, draftsOf, splitProjectRef, worktreesOf } from "./drafts.ts";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const MERGED = ".caveman/automations/merged.yaml";

let dir: string;
let root: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "drafts-")));
  root = path.join(dir, "repo");
  fs.mkdirSync(root);
  run(root, "init", "-q", "-b", "main");
  write(root, MERGED, "steps: { a: { prompt: hi } }\n");
  run(root, "add", ".");
  run(root, "commit", "-qm", "init");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const textsAt = (rel: string) => new Map([[rel, fs.readFileSync(path.join(root, rel), "utf8")]]);
const drafts = () =>
  draftsOf({ root, checkout: textsAt(MERGED), defaultBranch: textsAt(MERGED), defaultRef: "main" });

describe("worktreesOf", () => {
  it("lists the other worktrees on a branch, never the checkout itself or a detached one", () => {
    run(root, "worktree", "add", "-q", "-b", "chat-1", path.join(dir, "wt1"));
    run(root, "worktree", "add", "-q", "--detach", path.join(dir, "wt2"));
    expect(worktreesOf(root)).toEqual([{ path: path.join(dir, "wt1"), branch: "chat-1" }]);
    // Read from inside a worktree, the project's own checkout is one of the others.
    expect(worktreesOf(path.join(dir, "wt1")).map((w) => w.branch)).toEqual([]);
  });

  it("forgets a worktree whose folder is gone", () => {
    run(root, "worktree", "add", "-q", "-b", "chat-1", path.join(dir, "wt1"));
    fs.rmSync(path.join(dir, "wt1"), { recursive: true, force: true });
    expect(worktreesOf(root)).toEqual([]);
  });
});

describe("draftsOf", () => {
  it("finds a new file, uncommitted or committed on the branch, and a Me file", async () => {
    const wt = path.join(dir, "wt1");
    run(root, "worktree", "add", "-q", "-b", "chat-1", wt);
    write(wt, ".caveman/automations/fresh.yaml", "steps: { a: { prompt: new } }\n");
    write(wt, ".caveman/local/automations/mine.yaml", "steps: { a: { prompt: mine } }\n");
    expect((await drafts()).map((d) => [d.path, d.scope, d.worktree.branch])).toEqual([
      [".caveman/automations/fresh.yaml", "project", "chat-1"],
      [".caveman/local/automations/mine.yaml", "me", "chat-1"],
    ]);
    run(wt, "add", ".caveman/automations/fresh.yaml");
    run(wt, "commit", "-qm", "add");
    expect((await drafts()).map((d) => d.path)).toContain(".caveman/automations/fresh.yaml");
  });

  it("finds a branch's edit of a merged file, but never a stale copy the branch did not touch", async () => {
    const wt = path.join(dir, "wt1");
    run(root, "worktree", "add", "-q", "-b", "old", wt);
    // main moves on after the branch left: the branch's copy differs, yet it is not the branch's change.
    write(root, MERGED, "steps: { a: { prompt: newer } }\n");
    run(root, "commit", "-qam", "newer");
    expect(await drafts()).toEqual([]);
    write(wt, MERGED, "steps: { a: { prompt: edited } }\n");
    expect((await drafts()).map((d) => d.path)).toEqual([MERGED]);
  });

  it("skips a worktree file that matches the checkout", async () => {
    const wt = path.join(dir, "wt1");
    run(root, "worktree", "add", "-q", "-b", "chat-1", wt);
    expect(await drafts()).toEqual([]);
  });
});

describe("draftSignature", () => {
  it("moves when a worktree writes an automation file", () => {
    const wt = path.join(dir, "wt1");
    run(root, "worktree", "add", "-q", "-b", "chat-1", wt);
    const before = draftSignature(root);
    write(wt, ".caveman/automations/fresh.yaml", "x\n");
    expect(draftSignature(root)).not.toBe(before);
  });
});

describe("splitProjectRef", () => {
  it("reads a draft's branch after the first @, project ids keep their colons", () => {
    expect(splitProjectRef("caveman-repo:abc")).toEqual({ projectId: "caveman-repo:abc" });
    expect(splitProjectRef("caveman-repo:abc@caveman/chat-1")).toEqual({
      projectId: "caveman-repo:abc",
      branch: "caveman/chat-1",
    });
  });
});
