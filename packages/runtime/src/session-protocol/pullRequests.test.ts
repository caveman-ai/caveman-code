import { expect, test } from "vitest";
import type { Workspace } from "@caveman-app/session-protocol";
import type { GitBranchPullRequest } from "../git/GitManager.ts";
import type { ThreadPullRequestLink } from "@caveman-app/protocol";
import { followLinkedPullRequest, pullRequestOf, pullRequestOfLink, samePullRequest, unmergedOf, withPullRequest, withUnmerged } from "./pullRequests.ts";

const found = (over: Partial<GitBranchPullRequest>): GitBranchPullRequest =>
  ({ number: 450, title: "Inbox rows", url: "https://github.com/o/r/pull/450", baseRef: "main", headRef: "caveman/inbox", state: "open", repositoryKey: "github.com/o/r", updatedAt: null, ...over }) as GitBranchPullRequest;

test("a branch's pull request reads as its number, link and state; an open draft is a draft", () => {
  expect(pullRequestOf(null)).toBeUndefined();
  expect(pullRequestOf(found({}))).toEqual({ number: 450, url: "https://github.com/o/r/pull/450", state: "open" });
  expect(pullRequestOf(found({ isDraft: true }))?.state).toBe("draft");
  expect(pullRequestOf(found({ state: "merged", isDraft: true }))?.state).toBe("merged");
  expect(pullRequestOf(found({ state: "closed" }))?.state).toBe("closed");
});

test("a workspace is rewritten only when its pull request changed, and never moves in time for it", () => {
  const open = { number: 450, url: "u", state: "open" } as const;
  expect(samePullRequest(open, { ...open })).toBe(true);
  expect(samePullRequest(undefined, undefined)).toBe(true);
  expect(samePullRequest(open, { ...open, state: "merged" })).toBe(false);
  expect(samePullRequest(open, undefined)).toBe(false);
  const workspace = { id: "w", updated_at: "2026-10-18T10:00:00.000Z" } as Workspace;
  const withOne = withPullRequest(workspace, open);
  expect(withOne.pull_request).toEqual(open);
  expect(withOne.updated_at).toBe(workspace.updated_at);
  expect("pull_request" in withPullRequest(withOne, undefined)).toBe(false);
});

const link = (over: Partial<ThreadPullRequestLink> = {}, snapshot: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> | null = {}): ThreadPullRequestLink =>
  ({
    host: "github.com",
    repository: "o/r",
    number: 31,
    url: "https://github.com/o/r/pull/31",
    source: "agent",
    linkedAt: "2026-10-29T08:00:00.000Z",
    stack: null,
    snapshot: snapshot === null ? null : { state: "open", title: "Batch wakes", headBranch: "b", baseBranch: "main", isDraft: false, updatedAt: null, syncedAt: "2026-10-29T08:01:00.000Z", ...snapshot },
    ...over,
  }) as ThreadPullRequestLink;

test("a linked pull request's snapshot reads as the pill, with its checks and review decision", () => {
  expect(pullRequestOfLink(link({}, null))).toBeUndefined();
  expect(pullRequestOfLink(link())).toEqual({ number: 31, url: "https://github.com/o/r/pull/31", state: "open" });
  expect(pullRequestOfLink(link({}, { isDraft: true, checksState: "pending" }))).toMatchObject({ state: "draft", checks: "pending" });
  expect(pullRequestOfLink(link({}, { state: "merged", checksState: "passing", reviewDecision: "approved" }))).toEqual({ number: 31, url: "https://github.com/o/r/pull/31", state: "merged", checks: "passing", review: "approved" });
  expect(pullRequestOfLink(link({}, { checksState: "failing", reviewDecision: "changes-requested" }))).toMatchObject({ checks: "failing", review: "changes_requested" });
  expect(pullRequestOfLink(link({}, { reviewDecision: "review-required" }))?.review).toBe("review_required");
});

test("the pill follows the chat's own link: the one it created or linked, or the one it already shows; a sibling leaves it alone", () => {
  const workspace = { id: "w", updated_at: "2026-10-18T10:00:00.000Z" } as Workspace;
  // Nothing known yet: nothing changes.
  expect(followLinkedPullRequest(workspace, link({}, null))).toBe(workspace);
  const own = followLinkedPullRequest(workspace, link({}, { checksState: "failing" }));
  expect(own.pull_request).toEqual({ number: 31, url: "https://github.com/o/r/pull/31", state: "open", checks: "failing" });
  expect(own.updated_at).toBe(workspace.updated_at);
  // A stack sibling or a hand-linked pull request beside the chat's own is not the chat's.
  expect(followLinkedPullRequest(own, link({ number: 32, url: "https://github.com/o/r/pull/32", source: "stack" }, { state: "merged" }))).toBe(own);
  expect(followLinkedPullRequest(workspace, link({ source: "manual" }))).toBe(workspace);
  expect(followLinkedPullRequest(workspace, link({ source: "stack" }))).toBe(workspace);
  // The branch lookup found it first: the link of the same number refines it, whoever made the link.
  const branch = withPullRequest(workspace, { number: 31, url: "https://github.com/o/r/pull/31", state: "open" });
  expect(followLinkedPullRequest(branch, link({ source: "manual" }, { state: "merged", checksState: "passing" })).pull_request).toMatchObject({ state: "merged", checks: "passing" });
  // The same again: the same workspace, so nothing is published.
  expect(followLinkedPullRequest(own, link({}, { checksState: "failing" }))).toBe(own);
});

test("the branch lookup keeps the pill's checks and review for the same pull request, and drops them for another", () => {
  const current = { number: 450, url: "u", state: "open", checks: "failing", review: "approved" } as const;
  expect(pullRequestOf(found({}), current)).toEqual({ number: 450, url: "https://github.com/o/r/pull/450", state: "open", checks: "failing", review: "approved" });
  expect(pullRequestOf(found({ state: "merged" }), current)).toMatchObject({ state: "merged", checks: "failing" });
  expect(pullRequestOf(found({ number: 451 }), current)).toEqual({ number: 451, url: "https://github.com/o/r/pull/450", state: "open" });
  expect(samePullRequest({ ...current }, { ...current, checks: "passing" })).toBe(false);
  expect(samePullRequest({ ...current }, { ...current })).toBe(true);
});

test("a comparison with the base stays on the pill while the same pull request's checks still fail, and goes once they pass", () => {
  const base_ci = { base: "main", failing: ["test"], on_base: ["test"], base_state: "failing" } as const;
  const current = { number: 31, url: "https://github.com/o/r/pull/31", state: "open", checks: "failing", base_ci } as const;
  const workspace = withPullRequest({ id: "w", updated_at: "2026-10-18T10:00:00.000Z" } as Workspace, current);
  // The link's sync says failing again: the comparison stays, nothing republished.
  expect(followLinkedPullRequest(workspace, link({}, { checksState: "failing" }))).toBe(workspace);
  // Green: the comparison goes with the failures.
  expect(followLinkedPullRequest(workspace, link({}, { checksState: "passing" })).pull_request).toEqual({ number: 31, url: "https://github.com/o/r/pull/31", state: "open", checks: "passing" });
  // The branch lookup keeps it for the same pull request while it fails.
  expect(pullRequestOf(found({ number: 31 }), current)?.base_ci).toEqual(base_ci);
  expect(pullRequestOf(found({ number: 31 }), { ...current, checks: "passing" })?.base_ci).toBeUndefined();
  // A new comparison is a change worth publishing.
  expect(samePullRequest(current, { ...current, base_ci: { ...base_ci, base_state: "passing" } })).toBe(false);
});

test("what a worktree holds that its base does not: porcelain entries, a rename once, and commits ahead", () => {
  expect(unmergedOf("", "0\n")).toBeUndefined();
  expect(unmergedOf(" M a.ts\0?? b.ts\0", "0\n")).toEqual({ files: 2, commits: 0 });
  // A rename's second field is its old path, not another file.
  expect(unmergedOf("R  new.ts\0old.ts\0 M c.ts\0", "3\n")).toEqual({ files: 2, commits: 3 });
  expect(unmergedOf("", "2")).toEqual({ files: 0, commits: 2 });
  const w = { id: "w" } as Workspace;
  expect(withUnmerged(w, { files: 1, commits: 0 })).toEqual({ id: "w", unmerged: { files: 1, commits: 0 } });
  expect(withUnmerged({ ...w, unmerged: { files: 1, commits: 0 } }, undefined)).toEqual({ id: "w" });
});
