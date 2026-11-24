import { GitManagerError, PullRequestOperationError, PullRequestUnavailableError, SourceControlProviderKind, type PullRequestActivity, type PullRequestDetail, type PullRequestListEntry, type PullRequestListResult } from "@caveman-app/protocol";
import * as fs from "node:fs";
import * as path from "node:path";

import { connect } from "@caveman-app/session-protocol";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as ServerConfig from "../config.ts";
import { GitManager } from "../git/GitManager.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ProtocolError } from "./handlers.ts";
import {
  checkoutGit,
  detailOf,
  discussionOf,
  guideOf,
  guideResultOf,
  hunkAt,
  makeReviewHandlers,
  parseGrep,
  parsePatch,
  protocolErrorOf,
  repoOf,
  type ReviewGit,
  summaryOf,
  workspaceFor,
} from "./reviews.ts";
import type { WorkspaceRecord } from "./store.ts";
import { git, loadTranscript, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const entry = (overrides: Partial<PullRequestListEntry> = {}) =>
  ({
    provider: "github",
    host: "github.com",
    projectId: "p1",
    projectTitle: "widgets",
    repository: "acme/widgets",
    number: 12,
    title: "Gate merges on CI",
    url: "https://github.com/Acme/Widgets/pull/12",
    author: { login: "Julius", name: null, avatarUrl: "https://a/j.png" },
    headBranch: "gate",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 0,
    deletions: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    viewerReviewRequested: true,
    labels: [{ name: "ci", color: "00ff00" }, { name: "bare", color: null }],
    reviewDecision: "changes-requested",
    checksState: "failing",
    ...overrides,
  }) as PullRequestListEntry;

/** For the handlers that never read the checkout. */
const noCheckout = { projectRoot: () => Effect.succeed(undefined), git: () => Effect.die("no git here") };

const record = (id: string, workspace: Partial<WorkspaceRecord["workspace"]>) => ({ workspace: { id, project_id: "p1", branch: "gate", status: "idle", created_at: "2026-10-01T00:00:00Z", ...workspace } }) as WorkspaceRecord;

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1..2 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " one",
  "-two",
  "+TWO",
  "+--- not a header",
  " three",
  " four",
  "diff --git a/new.md b/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.md",
  "@@ -0,0 +1 @@",
  "+hi",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old.ts b/moved.ts",
  "similarity index 100%",
  "rename from old.ts",
  "rename to moved.ts",
  "",
].join("\n");

describe("pull request mappers", () => {
  it("lists a pull request as the Review queue shows it", () => {
    expect(summaryOf(entry({ isDraft: true }), { "github.com": "julius" }, "w1")).toEqual({
      project_id: "p1",
      repo: "Acme/Widgets",
      host: "github.com",
      number: 12,
      title: "Gate merges on CI",
      url: "https://github.com/Acme/Widgets/pull/12",
      author: { login: "Julius", avatar_url: "https://a/j.png" },
      head_branch: "gate",
      base_branch: "main",
      state: "draft",
      additions: 0,
      deletions: 0,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-02T00:00:00Z",
      review_requested: true,
      mine: true,
      review: "changes_requested",
      checks: "failing",
      labels: [{ name: "ci", color: "00ff00" }, { name: "bare" }],
      workspace_id: "w1",
    });
    expect(summaryOf(entry({ state: "merged", isDraft: true }), {}, undefined)).toMatchObject({ state: "merged", mine: false });
  });

  it("keeps the host's own casing of owner/name, from the pull request's URL", () => {
    expect(repoOf("https://github.com/JuliusBrussee/caveman/pull/1312", "juliusbrussee/caveman")).toBe("JuliusBrussee/caveman");
    expect(repoOf("https://gitlab.com/Group/Sub/Proj/-/merge_requests/3", "group/sub/proj")).toBe("Group/Sub/Proj");
    expect(repoOf("https://github.com/acme/widgets-old/pull/1", "acme/widgets")).toBe("acme/widgets");
    expect(repoOf("not a url", "acme/widgets")).toBe("acme/widgets");
  });

  it("finds the newest live chat of the project on the head branch", () => {
    const records = [
      record("old", {}),
      record("new", { created_at: "2026-10-05T00:00:00Z" }),
      record("archived", { created_at: "2026-10-09T00:00:00Z", status: "archived" }),
      record("setup", { created_at: "2026-10-09T00:00:00Z", kind: "setup" }),
      record("other", { created_at: "2026-10-09T00:00:00Z", project_id: "p2" }),
    ];
    expect(workspaceFor(records, "p1", "gate")).toBe("new");
    expect(workspaceFor(records, "p1", "nope")).toBeUndefined();
  });

  it("splits a diff into per-file patches with their counts", () => {
    const files = parsePatch(patch);
    expect(files.map(({ patch: _, ...f }) => f)).toEqual([
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "new.md", status: "added", additions: 1, deletions: 0 },
      { path: "gone.ts", status: "deleted", additions: 0, deletions: 1 },
      { path: "moved.ts", old_path: "old.ts", status: "renamed", additions: 0, deletions: 0 },
    ]);
    expect(files[0]!.patch.startsWith("diff --git a/src/a.ts")).toBe(true);
    expect(files.every((f) => f.patch.endsWith("\n") && !f.patch.endsWith("\n\n"))).toBe(true);
    expect(parsePatch("")).toEqual([]);
  });

  it("cuts the hunk a line comment was written on", () => {
    const file = parsePatch(patch)[0]!.patch;
    expect(hunkAt(file, 4, "new")).toBe(["@@ -1,4 +1,5 @@", "-two", "+TWO", "+--- not a header", " three"].join("\n"));
    expect(hunkAt(file, 2, "old")).toBe(["@@ -1,4 +1,5 @@", " one", "-two"].join("\n"));
    expect(hunkAt(file, 99, "new")).toBeUndefined();
  });

  it("orders comments, reviews and threads oldest first, a line comment in its thread only", () => {
    const actor = { login: "rev", name: null, avatarUrl: null };
    const activity = {
      comments: [
        { id: "c2", kind: "review", author: actor, body: "", createdAt: "2026-10-03T00:00:00Z", url: null, path: null, reviewState: "APPROVED" },
        { id: "c1", kind: "issue-comment", author: actor, body: "hi", createdAt: "2026-10-01T00:00:00Z", url: "https://x", path: null, reviewState: null },
        { id: "c3", kind: "review-comment", author: actor, body: "line", createdAt: "2026-10-02T00:00:00Z", url: null, path: "src/a.ts", reviewState: null },
      ],
      commentCount: 3,
      commentsTruncated: false,
      reviewThreads: [
        { id: "t1", path: "src/a.ts", line: 4, side: "right", isResolved: false, isOutdated: false, comments: [{ id: "c3", author: actor, body: "line", createdAt: "2026-10-02T00:00:00Z", url: null }] },
        { id: "t2", path: "src/a.ts", line: null, side: "left", isResolved: true, isOutdated: true, comments: [{ id: "c4", author: null, body: "old", createdAt: "2026-10-04T00:00:00Z", url: null }] },
      ],
      commits: [],
    } as unknown as PullRequestActivity;
    const items = discussionOf(activity, new Map([["src/a.ts", parsePatch(patch)[0]!.patch]]));
    expect(items.map((i) => [i.type, i.id])).toEqual([
      ["comment", "c1"],
      ["thread", "t1"],
      ["comment", "c2"],
      ["thread", "t2"],
    ]);
    expect(items[0]).toEqual({ type: "comment", id: "c1", author: { login: "rev" }, body: "hi", at: "2026-10-01T00:00:00Z", url: "https://x" });
    expect(items[1]).toMatchObject({ path: "src/a.ts", line: 4, side: "new", resolved: false, outdated: false, hunk: expect.stringContaining("+TWO") });
    expect(items[2]).toMatchObject({ verdict: "approved" });
    expect(items[3]).toEqual({ type: "thread", id: "t2", path: "src/a.ts", side: "old", resolved: true, outdated: true, comments: [{ id: "c4", body: "old", at: "2026-10-04T00:00:00Z" }] });
  });

  const detail = {
    provider: "github",
    capabilities: { diff: true, comment: true, actions: ["merge"], mergeMethods: ["merge", "squash", "rebase"], search: true, review: { inlineComment: true, reply: true, resolve: true, verdicts: ["comment", "approve", "request-changes"] }, reviewers: {} },
    viewerPermissions: { actions: ["merge"], comment: true, resolve: true, verdicts: ["comment", "approve"], requestReviewers: true },
    projectId: "p1",
    projectTitle: "widgets",
    workspaceRoot: "/r",
    repository: "acme/widgets",
    number: 12,
    title: "Gate merges on CI",
    body: "Why.",
    url: "https://github.com/ACME/widgets/pull/12",
    author: { login: "author", name: null, avatarUrl: null },
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 3,
    deletions: 2,
    changedFiles: 4,
    headBranch: "gate",
    headSha: "abc123",
    baseBranch: "main",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [{ login: "me", name: null, avatarUrl: null }, { login: "rev", name: null, avatarUrl: null }],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: false, squash: true, rebase: true },
    viewer: "me",
  } as unknown as PullRequestDetail;

  it("reads a pull request's page: verdicts, merge gate, files and what the person may do", () => {
    const activity = {
      comments: [{ id: "r1", kind: "review", author: { login: "rev", name: null, avatarUrl: null }, body: "", createdAt: "2026-10-03T00:00:00Z", url: null, path: null, reviewState: "CHANGES_REQUESTED" }],
      commentCount: 1,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [{ oid: "a", messageHeadline: "x", committedDate: "2026-10-01T00:00:00Z" }],
    } as unknown as PullRequestActivity;
    const result = detailOf({
      detail,
      host: "github.com",
      summary: { reviewDecision: "review-required", checksState: null } as never,
      activity,
      checks: [
        { name: "ci", status: "failure", description: null, url: "https://ci", required: true },
        { name: "lint", status: "neutral", description: null, url: null },
      ],
      files: parsePatch(patch),
      viewed: new Set(["new.md"]),
      workspaceId: undefined,
    });
    expect(result).toMatchObject({
      repo: "ACME/widgets",
      state: "open",
      head_sha: "abc123",
      body: "Why.",
      mergeable: "blocked",
      review: "review_required",
      checks: "failing",
      checks_list: [{ name: "ci", status: "failed", url: "https://ci" }, { name: "lint", status: "skipped" }],
      reviewers: [{ login: "me", state: "pending" }, { login: "rev", state: "changes_requested" }],
      review_requested: true,
      mine: false,
      commits: 1,
      can: { merge: true, review: true, comment: true, merge_methods: ["squash", "rebase"], ready: false },
    });
    expect(result.files.map((f) => [f.path, f.viewed])).toEqual([["src/a.ts", false], ["new.md", true], ["gone.ts", false], ["moved.ts", false]]);
    expect(result.files[0]).not.toHaveProperty("patch");
    const clean = detailOf({ detail, host: "github.com", summary: null, activity: null, checks: [], files: [], viewed: new Set(), workspaceId: "w1" });
    expect(clean).toMatchObject({ mergeable: "clean", commits: 0, workspace_id: "w1" });
    expect(clean).not.toHaveProperty("checks");
    expect(clean).not.toHaveProperty("diff_stat_truncated");
  });

  it("tells the page a cut line count is a floor", () => {
    const cut = { ...detail, additions: 10_000, deletions: 5000, changedFiles: 12_000, diffStatTruncated: true } as PullRequestDetail;
    const result = detailOf({ detail: cut, host: "bitbucket.org", summary: null, activity: null, checks: [], files: [], viewed: new Set(), workspaceId: undefined });
    expect(result).toMatchObject({ additions: 10_000, deletions: 5000, diff_stat_truncated: true });
  });

  it("says a guide run is going or failed only for the head the pull request is at", () => {
    const guide = {
      headSha: "old",
      generatedAt: "2026-10-01T00:00:00Z",
      modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
      overview: "Gate merges.",
      beforeAfter: { title: "Merge", rows: [{ op: "+" as const, depth: 0, text: "gate", stop: 1 }] },
      stops: [],
    } as never;
    expect(guideResultOf({ guide, run: { _tag: "Running", headSha: "new", startedAt: "x" }, currentHeadSha: "new" }, "GPT-6 Luna")).toEqual({
      guide: { head_sha: "old", generated_at: "2026-10-01T00:00:00Z", model: "GPT-6 Luna", overview: "Gate merges.", before_after: { title: "Merge", rows: [{ op: "+", depth: 0, text: "gate", stop: 1 }] }, stops: [], by: "model" },
      running: true,
      head_sha: "new",
    });
    expect(guideResultOf({ guide: null, run: { _tag: "Failed", headSha: "old", failedAt: "x", detail: "boom" }, currentHeadSha: "new" }, undefined)).toEqual({ guide: null, running: false, head_sha: "new" });
    expect(guideResultOf({ guide: null, run: { _tag: "Failed", headSha: "new", failedAt: "x", detail: "boom" }, currentHeadSha: "new" }, undefined)).toMatchObject({ failed: "boom" });
  });

  it("names who wrote a guide and how", () => {
    const guide = (writer?: { tier: "template" | "single-pass" | "checkout" }) =>
      ({ headSha: "h", generatedAt: "2026-10-19T00:00:00Z", modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" }, stops: [], ...(writer ? { writer } : {}) }) as never;
    expect(guideOf(guide({ tier: "single-pass" }), "Claude Haiku 5.5").model).toBe("Claude Haiku 5.5 · single pass");
    expect(guideOf(guide({ tier: "checkout" }), "Claude Haiku 5.5").model).toBe("Claude Haiku 5.5 · read the checkout");
    expect(guideOf(guide({ tier: "template" }), "Claude Haiku 5.5").model).toBe("No model · template");
    expect(guideOf(guide(), "Claude Haiku 5.5").model).toBe("Claude Haiku 5.5");
    expect(guideOf(guide({ tier: "chat" } as never), "Claude Opus 5.5").model).toBe("Claude Opus 5.5 · in the chat that opened it");
  });

  it("says how deep a guide goes, its one call, and who wrote it, naming the chat that wrote its TL;DR", () => {
    const base = { headSha: "h", generatedAt: "2026-10-23T00:00:00Z", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } };
    const chat = {
      ...base,
      writer: { tier: "chat" },
      depth: "tldr",
      tldr: "Merge locks on red CI.",
      attention: { kind: "risk", note: "Blocks hotfixes too." },
      stops: [],
      threadId: "caveman:w1",
    } as never;
    expect(guideOf(chat, "Claude Opus 5.5", "w1")).toEqual({
      head_sha: "h",
      generated_at: "2026-10-23T00:00:00Z",
      model: "Claude Opus 5.5 · in the chat that opened it",
      tldr: "Merge locks on red CI.",
      stops: [],
      depth: "tldr",
      attention: { kind: "risk", note: "Blocks hotfixes too." },
      by: "chat",
      workspace_id: "w1",
    });
    // A chat not here is left out.
    expect(guideOf(chat, "Claude Opus 5.5")).not.toHaveProperty("workspace_id");
    const tour = (tier: string) => guideOf({ ...base, writer: { tier }, depth: "tour", stops: [] } as never, "Claude Haiku 5.5", "w1");
    expect(tour("single-pass")).toMatchObject({ depth: "tour", by: "model" });
    expect(tour("checkout")).toMatchObject({ by: "model" });
    expect(tour("template")).toMatchObject({ by: "template" });
    // Only a chat's guide names a chat.
    expect(tour("single-pass")).not.toHaveProperty("workspace_id");
    // A guide from before depth and writers existed is a model's tour, its depth unsaid.
    const old = guideOf({ ...base, stops: [] } as never, "Claude Haiku 5.5");
    expect(old).not.toHaveProperty("depth");
    expect(old.by).toBe("model");
  });

  it("maps a host's refusal to a protocol error with its sentence", () => {
    expect(protocolErrorOf(new PullRequestOperationError({ operation: "detail", detail: "No such pull request.", reason: "not-found" }))).toMatchObject({ reason: "not_found", message: "No such pull request." });
    expect(protocolErrorOf(new PullRequestOperationError({ operation: "merge", detail: "Not mergeable." }))).toMatchObject({ reason: "invalid_state", message: "Not mergeable." });
    expect(protocolErrorOf(new PullRequestUnavailableError({ reason: "cli-unauthenticated", provider: SourceControlProviderKind.make("github") }))).toMatchObject({ reason: "engine_unavailable", message: expect.stringContaining("gh auth login") });
    expect(protocolErrorOf(new PullRequestUnavailableError({ reason: "provider-unsupported" }))).toMatchObject({ reason: "unsupported", capability: "pull_requests" });
  });
});

describe("pr.* handlers", () => {
  const ctx = { connectionId: "c" };

  it("writes the full tour when asked, and names the chat here that wrote a guide's TL;DR", async () => {
    const asked: Array<unknown> = [];
    const chatGuide = {
      headSha: "h",
      generatedAt: "2026-10-23T00:00:00Z",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      writer: { tier: "chat" },
      depth: "tldr",
      tldr: "Merge locks on red CI.",
      stops: [],
      threadId: "caveman:w2",
    };
    const result = { guide: chatGuide, run: null, currentHeadSha: "h" } as never;
    const handlers = makeReviewHandlers({
      pullRequests: Option.some({} as PullRequestService["Service"]),
      guides: Option.some({
        get: () => Effect.succeed(result),
        generate: (_ref: unknown, options: unknown) => (asked.push(options), Effect.succeed({ ...(result as object), started: true })),
      } as never),
      projectRepository: () => Effect.succeed("acme/widgets"),
      workspaces: Effect.succeed([
        { ...record("w1", {}), internal: { threadId: "caveman:w1" } },
        { ...record("w2", {}), internal: { threadId: "caveman:w2" } },
      ] as never),
      modelLabel: () => Effect.succeed("Claude Opus 5.5"),
      ...noCheckout,
    });
    const read = await Effect.runPromise(handlers["pr.guide"]({ project_id: "p1", number: 12 }, ctx));
    expect(read.guide).toMatchObject({ by: "chat", depth: "tldr", workspace_id: "w2", model: "Claude Opus 5.5 · in the chat that opened it" });
    expect(asked).toEqual([]);
    await Effect.runPromise(handlers["pr.guide"]({ project_id: "p1", number: 12, generate: true, full: true }, ctx));
    await Effect.runPromise(handlers["pr.guide"]({ project_id: "p1", number: 12, generate: true }, ctx));
    expect(asked).toEqual([{ full: true }, { full: false }]);
  });

  const make = (service: Partial<PullRequestService["Service"]>, repository: string | null = "acme/widgets") => {
    const calls: Array<[string, unknown]> = [];
    const recorded = new Proxy(service, {
      get: (target, name: string) =>
        (target as Record<string, unknown>)[name] ??
        ((input: unknown) => {
          calls.push([name, input]);
          return Effect.void;
        }),
    }) as PullRequestService["Service"];
    const handlers = makeReviewHandlers({
      pullRequests: Option.some(recorded),
      guides: Option.none(),
      projectRepository: () => Effect.succeed(repository ?? undefined),
      workspaces: Effect.succeed([record("w1", {})]),
      modelLabel: (s) => Effect.succeed(s.model),
      ...noCheckout,
    });
    return { handlers, calls };
  };
  const ref = { projectId: "p1", repository: "acme/widgets", number: 12 };

  it("writes each kind of comment through the host", async () => {
    const { handlers, calls } = make({});
    const base = { request_id: "r", project_id: "p1", number: 12 };
    await Effect.runPromise(handlers["pr.comment"]({ ...base, body: "top" }, ctx));
    await Effect.runPromise(handlers["pr.comment"]({ ...base, body: "on line", path: "src/a.ts", line: 4 }, ctx));
    await Effect.runPromise(handlers["pr.comment"]({ ...base, body: "on old", path: "src/a.ts", line: 2, side: "old" }, ctx));
    await Effect.runPromise(handlers["pr.comment"]({ ...base, body: "reply", thread_id: "t1" }, ctx));
    expect(calls).toEqual([
      ["comment", { ...ref, body: "top" }],
      ["submitReview", { ...ref, verdict: "comment", body: "", comments: [{ path: "src/a.ts", position: { kind: "added", newLine: 4 }, body: "on line" }] }],
      ["submitReview", { ...ref, verdict: "comment", body: "", comments: [{ path: "src/a.ts", position: { kind: "deleted", oldLine: 2 }, body: "on old" }] }],
      ["replyToThread", { ...ref, threadId: "t1", body: "reply" }],
    ]);
  });

  it("resolves, reviews, merges and marks files viewed", async () => {
    const { handlers, calls } = make({});
    const base = { request_id: "r", project_id: "p1", number: 12, repo: "acme/other", host: "github.com" };
    const other = { ...ref, repository: "acme/other", host: "github.com" };
    expect(await Effect.runPromise(handlers["pr.resolve"]({ ...base, thread_id: "t1", resolved: true }, ctx))).toEqual({});
    await Effect.runPromise(handlers["pr.review"]({ ...base, verdict: "request_changes", body: "no" }, ctx));
    await Effect.runPromise(handlers["pr.review"]({ ...base, verdict: "approve" }, ctx));
    await Effect.runPromise(handlers["pr.merge"]({ ...base, method: "squash" }, ctx));
    await Effect.runPromise(handlers["pr.ready"](base, ctx));
    await Effect.runPromise(handlers["pr.viewed"]({ ...base, paths: ["a", "b"], viewed: false }, ctx));
    expect(calls).toEqual([
      ["setThreadResolution", { ...other, threadId: "t1", resolved: true }],
      ["submitReview", { ...other, verdict: "request-changes", body: "no", comments: [] }],
      ["submitReview", { ...other, verdict: "approve", body: "", comments: [] }],
      ["runAction", { ...other, action: "merge", mergeMethod: "squash" }],
      ["runAction", { ...other, action: "ready" }],
      ["setFilesViewed", { ...other, files: [{ path: "a", viewed: false }, { path: "b", viewed: false }] }],
    ]);
  });

  it("re-runs failed checks through GitHub's Actions API, or brings a fixed base in through the host", async () => {
    // A base fixed since: the host's update-branch, which starts CI afresh.
    const { handlers, calls } = make({});
    expect(await Effect.runPromise(handlers["pr.rerun"]({ request_id: "r", project_id: "p1", number: 12, update_branch: true }, ctx))).toEqual({ rerun: 0, updated: true });
    expect(calls).toEqual([["runAction", { ...ref, action: "update-branch" }]]);
    // Otherwise the failed jobs of each failed Actions run, on the person's own sign-in.
    const posted: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return posted.push(url), new Response(null, { status: 201 });
      if (url.endsWith("/pulls/12")) return new Response(JSON.stringify({ head: { sha: "c".repeat(40) } }));
      return new Response(JSON.stringify({ check_runs: [{ conclusion: "failure", details_url: "https://github.com/acme/widgets/actions/runs/5/job/1" }] }));
    }) as typeof fetch;
    const signedIn = makeReviewHandlers({
      pullRequests: Option.none(),
      guides: Option.none(),
      projectRepository: () => Effect.succeed("acme/widgets"),
      workspaces: Effect.succeed([]),
      modelLabel: (s) => Effect.succeed(s.model),
      ...noCheckout,
      githubToken: () => Effect.succeed("t"),
      fetch: fake,
    });
    expect(await Effect.runPromise(signedIn["pr.rerun"]({ request_id: "r", project_id: "p1", number: 12 }, ctx))).toEqual({ rerun: 1, updated: false });
    expect(posted).toEqual(["https://api.github.com/repos/acme/widgets/actions/runs/5/rerun-failed-jobs"]);
    // Another host, or no way to reach GitHub: unsupported, said so.
    expect((await Effect.runPromise(Effect.flip(signedIn["pr.rerun"]({ request_id: "r", project_id: "p1", number: 12, host: "gitlab.com" }, ctx)))).reason).toBe("unsupported");
    expect((await Effect.runPromise(Effect.flip(handlers["pr.rerun"]({ request_id: "r", project_id: "p1", number: 12 }, ctx)))).reason).toBe("unsupported");
  });

  it("refuses a project with no repository and passes the host's refusal on", async () => {
    const none = make({}, null).handlers;
    const refused = await Effect.runPromise(Effect.flip(none["pr.merge"]({ request_id: "r", project_id: "p1", number: 1, method: "merge" }, ctx)));
    expect(refused).toBeInstanceOf(ProtocolError);
    expect(refused.reason).toBe("not_found");
    const failing = make({ runAction: () => Effect.fail(new PullRequestOperationError({ operation: "merge", detail: "Base branch policy prohibits the merge." })) }).handlers;
    const error = await Effect.runPromise(Effect.flip(failing["pr.merge"]({ request_id: "r", project_id: "p1", number: 1, method: "merge" }, ctx)));
    expect(error).toMatchObject({ reason: "invalid_state", message: "Base branch policy prohibits the merge." });
  });

  it("reads one changed file whole, before and after, named as the service names the change", async () => {
    const asked: Array<unknown> = [];
    const { handlers } = make({
      diffFileContents: (input) => (asked.push(input), Effect.succeed({ oldContents: `old of ${input.oldPath}`, newContents: `new of ${input.newPath}` })),
    });
    const base = { project_id: "p1", number: 12 };
    expect(await Effect.runPromise(handlers["pr.file"]({ ...base, path: "src/a.ts", status: "modified" }, ctx))).toEqual({ old: "old of src/a.ts", new: "new of src/a.ts" });
    await Effect.runPromise(handlers["pr.file"]({ ...base, path: "new.md", status: "added" }, ctx));
    await Effect.runPromise(handlers["pr.file"]({ ...base, path: "gone.ts", status: "deleted" }, ctx));
    await Effect.runPromise(handlers["pr.file"]({ ...base, repo: "acme/other", host: "github.com", path: "moved.ts", old_path: "old.ts", status: "renamed" }, ctx));
    expect(asked).toEqual([
      { ...ref, changeType: "change", oldPath: "src/a.ts", newPath: "src/a.ts" },
      { ...ref, changeType: "new", oldPath: "new.md", newPath: "new.md" },
      { ...ref, changeType: "deleted", oldPath: "gone.ts", newPath: "gone.ts" },
      { ...ref, repository: "acme/other", host: "github.com", changeType: "rename-changed", oldPath: "old.ts", newPath: "moved.ts" },
    ]);
  });

  it("reads a file at the push its patch was read at, which pr.diff names", async () => {
    const asked: Array<unknown> = [];
    const at = (path: string) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const { handlers } = make({
      diff: (input) =>
        Effect.succeed(
          input.cursor === undefined
            ? { patch: at("src/a.ts"), truncated: false, nextCursor: "3:1", revision: "3" }
            : { patch: at("src/b.ts"), truncated: false, nextCursor: null, revision: "3" },
        ),
      diffFileContents: (input) => (asked.push(input), Effect.succeed({ oldContents: "old", newContents: "new" })),
    });
    const base = { project_id: "p1", number: 12 };
    const diff = await Effect.runPromise(handlers["pr.diff"](base, ctx));
    expect(diff.revision).toBe("3");
    expect(diff.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    await Effect.runPromise(handlers["pr.file"]({ ...base, path: "src/b.ts", status: "modified", ...(diff.revision ? { revision: diff.revision } : {}) }, ctx));
    expect(asked).toEqual([{ ...ref, revision: "3", changeType: "change", oldPath: "src/b.ts", newPath: "src/b.ts" }]);
  });

  it("names the head its patch was read at when a push lands between the diff and detail reads", async () => {
    const host = { head: "aaaa", file: "a.ts" };
    const at = (file: string) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const { handlers } = make({
      // The patch is read at the head it names; the author's push lands right after.
      diff: () =>
        Effect.sync(() => {
          const read = { patch: at(host.file), truncated: false, nextCursor: null, headSha: host.head };
          Object.assign(host, { head: "bbbb", file: "b.ts" });
          return read;
        }),
      detail: () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => ({ headSha: host.head }) as PullRequestDetail))),
    });
    const diff = await Effect.runPromise(handlers["pr.diff"]({ project_id: "p1", number: 12 }, ctx));
    expect({ head_sha: diff.head_sha, files: diff.files.map((f) => f.path) }).toEqual({ head_sha: "aaaa", files: ["a.ts"] });
  });

  it("names no head for a patch the host cannot vouch for, or one read across a push", async () => {
    const at = (file: string) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const detail = () => Effect.succeed({ headSha: "dddd" } as PullRequestDetail);
    const unvouched = make({ diff: () => Effect.succeed({ patch: at("a.ts"), truncated: false, nextCursor: null }), detail });
    expect(await Effect.runPromise(unvouched.handlers["pr.diff"]({ project_id: "p1", number: 12 }, ctx))).not.toHaveProperty("head_sha");
    // A push between the slices: the files are of two heads, so neither names them all.
    const split = make({
      diff: (input) =>
        Effect.succeed(
          input.cursor === undefined
            ? { patch: at("a.ts"), truncated: false, nextCursor: "2", headSha: "aaaa" }
            : { patch: at("b.ts"), truncated: false, nextCursor: null, headSha: "bbbb" },
        ),
      detail,
    });
    const diff = await Effect.runPromise(split.handlers["pr.diff"]({ project_id: "p1", number: 12 }, ctx));
    expect(diff.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(diff).not.toHaveProperty("head_sha");
  });

  it("answers not_found for a file the pull request does not change", async () => {
    const { handlers } = make({
      diffFileContents: () => Effect.fail(new PullRequestOperationError({ operation: "diffFileContents", detail: "This file is not part of the change request.", reason: "not-found" })),
    });
    const error = await Effect.runPromise(Effect.flip(handlers["pr.file"]({ project_id: "p1", number: 12, path: "secrets.env", status: "modified" }, ctx)));
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error).toMatchObject({ reason: "not_found", message: "This file is not part of the change request." });
  });

  it("lists with counts filled by one stats read and the chat on each head", async () => {
    const listed = {
      viewers: { "github.com": "julius" },
      providers: [],
      entries: [entry(), entry({ number: 13, headBranch: "other", additions: 5, deletions: 1 })],
      errors: [{ projectId: "p2", projectTitle: "x", message: "gh failed" }],
      truncated: false,
      nextCursors: {},
    } as unknown as PullRequestListResult;
    const statsCalls: Array<unknown> = [];
    const { handlers } = make({
      list: () => Effect.succeed(listed),
      listStats: (input) => (statsCalls.push(input), Effect.succeed({ stats: [{ projectId: "p1", repository: "acme/widgets", number: 12, additions: 9, deletions: 4 }] })) as never,
    });
    const result = await Effect.runPromise(handlers["pr.list"]({}, ctx));
    expect(statsCalls).toEqual([{ refs: [{ projectId: "p1", repository: "acme/widgets", number: 12, host: "github.com" }] }]);
    expect(result.prs.map((p) => [p.number, p.additions, p.deletions, p.workspace_id, p.mine])).toEqual([
      [12, 9, 4, "w1", true],
      [13, 5, 1, undefined, true],
    ]);
    expect(result.errors).toEqual([{ project_id: "p2", message: "gh failed" }]);
    expect(result).not.toHaveProperty("unavailable");
    expect(result.prs.some((p) => "guide_ready" in p)).toBe(false);
    const signedOut = make({ list: () => Effect.fail(new PullRequestUnavailableError({ reason: "cli-missing", provider: SourceControlProviderKind.make("github") })) }).handlers;
    expect(await Effect.runPromise(signedOut["pr.list"]({}, ctx))).toMatchObject({ prs: [], unavailable: expect.stringContaining("GitHub") });
  });
});

describe("pr.list guides", () => {
  it("marks the open pull requests with a guide stored, never asking about a draft or a closed one", async () => {
    const listed = {
      viewers: { "github.com": "julius" },
      providers: [],
      entries: [entry({ number: 12 }), entry({ number: 13 }), entry({ number: 14, isDraft: true }), entry({ number: 15, state: "merged" })],
      errors: [],
      truncated: false,
      nextCursors: {},
    } as unknown as PullRequestListResult;
    const asked: Array<number> = [];
    const handlers = makeReviewHandlers({
      pullRequests: Option.some({ list: () => Effect.succeed(listed), listStats: () => Effect.succeed({ stats: [] }) } as never),
      guides: Option.some({ stored: (ref: { number: number }) => (asked.push(ref.number), Effect.succeed(ref.number === 12)) } as never),
      projectRepository: () => Effect.succeed("acme/widgets"),
      workspaces: Effect.succeed([]),
      modelLabel: (s) => Effect.succeed(s.model),
      ...noCheckout,
    });
    const result = await Effect.runPromise(handlers["pr.list"]({}, { connectionId: "c" }));
    expect(result.prs.map((p) => [p.number, p.guide_ready])).toEqual([
      [12, true],
      [13, undefined],
      [14, undefined],
      [15, undefined],
    ]);
    expect(asked.sort()).toEqual([12, 13]);
  });
});

describe("pr.symbol", () => {
  const ctx = { connectionId: "c" };
  // The runtime's own git, as handlers.ts wires it (checkoutGit over GitVcsDriver).
  const gitLayer = GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "sp-pr-symbol-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  let root: string;
  let repo: string;
  let base: string;
  let head: string;
  // Colons are not allowed in a Windows file name.
  const colonPath = process.platform === "win32" ? "weird/b-12-c.ts" : "we:ird/b:12:c.ts";

  beforeAll(() => {
    root = tempRoot("sp-pr-symbol-");
    repo = makeRepo(root, {
      "src/gate.ts": "export function mergeGate() {}\nconst mergeGateway = 1;\nconst MergeGate = mergeGate;\n",
      "src/use.ts": "import { mergeGate } from './gate';\nmergeGate();\n",
      [colonPath]: "x mergeGate\n",
      "bin.dat": "mergeGate\0binary\n",
    });
    base = git(repo, "rev-parse", "HEAD").trim();
    // The pull request's head, on its own branch: a new caller, and a long line.
    git(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "src/more.ts"), `mergeGate(); // ${"x".repeat(400)}\r\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "feature");
    head = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-q", "main");
    // Many lines naming one symbol, for the limits.
    git(repo, "checkout", "-q", "-b", "many");
    fs.writeFileSync(path.join(repo, "many.ts"), "manyName;\n".repeat(1005));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "many");
    git(repo, "checkout", "-q", "main");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const handlersFor = (gitRun: ReviewGit, options: { headSha?: string; baseBranch?: string; root?: string | null; repository?: string } = {}) =>
    makeReviewHandlers({
      pullRequests: Option.some({
        detail: () => Effect.succeed({ headSha: options.headSha ?? head, baseBranch: options.baseBranch ?? "main" }),
      } as never),
      guides: Option.none(),
      projectRepository: () => Effect.succeed(options.repository ?? "acme/widgets"),
      workspaces: Effect.succeed([]),
      modelLabel: (s) => Effect.succeed(s.model),
      projectRoot: () => Effect.succeed(options.root === null ? undefined : (options.root ?? repo)),
      git: gitRun,
    });
  type SymbolParams = Parameters<ReturnType<typeof makeReviewHandlers>["pr.symbol"]>[0];
  const run = <A, E>(use: (gitRun: ReviewGit) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) => use(checkoutGit(driver))).pipe(Effect.provide(gitLayer)));
  const symbol = (params: Omit<SymbolParams, "project_id" | "number">, options?: Parameters<typeof handlersFor>[1]) =>
    run((g) => handlersFor(g, options)["pr.symbol"]({ project_id: "p1", number: 12, ...params }, ctx));
  const refused = (params: Omit<SymbolParams, "project_id" | "number">, options?: Parameters<typeof handlersFor>[1]) =>
    run((g) => Effect.flip(handlersFor(g, options)["pr.symbol"]({ project_id: "p1", number: 12, ...params }, ctx)));

  it("searches the head when this checkout has it: whole words, case-sensitive, text files only", async () => {
    const found = await symbol({ name: "mergeGate" });
    expect(found).toMatchObject({ at: "head", commit: head, truncated: false });
    expect(found.hits.map((h) => [h.path, h.line])).toEqual([
      ["src/gate.ts", 1],
      ["src/gate.ts", 3],
      ["src/more.ts", 1],
      ["src/use.ts", 1],
      ["src/use.ts", 2],
      [colonPath, 1],
    ]);
    expect(found.hits.find((h) => h.path === "src/gate.ts")?.text).toBe("export function mergeGate() {}");
    // A long line is cut, its carriage return gone.
    const long = found.hits.find((h) => h.path === "src/more.ts")!.text;
    expect(long).toHaveLength(300);
    expect(long.startsWith("mergeGate(); // xxx")).toBe(true);
  });

  it("falls back to the base branch, origin's before the local one, when the head is not here", async () => {
    const missing = "f".repeat(40);
    expect(await symbol({ name: "mergeGate" }, { headSha: missing })).toMatchObject({ at: "base", commit: base });
    // The new caller is only at the head.
    expect((await symbol({ name: "mergeGate" }, { headSha: missing })).hits.some((h) => h.path === "src/more.ts")).toBe(false);
    git(repo, "update-ref", "refs/remotes/origin/main", head);
    try {
      expect(await symbol({ name: "mergeGate" }, { headSha: missing })).toMatchObject({ at: "base", commit: head });
    } finally {
      git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    }
    // No head reported at all is the same.
    expect(await symbol({ name: "mergeGate" }, { headSha: "not a sha" })).toMatchObject({ at: "base", commit: base });
  });

  it("says so when neither is here, and never takes a base name git would read as something else", async () => {
    const missing = "f".repeat(40);
    for (const baseBranch of ["gone", "+main", "main:main", "@{-1}", "-main", "a..b"]) {
      const error = await refused({ name: "mergeGate" }, { headSha: missing, baseBranch });
      expect(error).toBeInstanceOf(ProtocolError);
      expect(error.reason).toBe("invalid_state");
      expect(error.message).toContain("Fetch the project");
    }
  });

  it("answers unsupported for another repository, or a project with no checkout here", async () => {
    expect(await refused({ name: "mergeGate", repo: "acme/other" })).toMatchObject({ reason: "unsupported", capability: "pull_requests" });
    expect(await refused({ name: "mergeGate" }, { root: null })).toMatchObject({ reason: "unsupported", capability: "pull_requests" });
    // The same repository, spelled as the host spells it.
    expect(await symbol({ name: "mergeGate", repo: "Acme/Widgets" })).toMatchObject({ at: "head" });
  });

  it("finds nothing for a name no line holds as a word", async () => {
    expect(await symbol({ name: "mergeGat" })).toEqual({ at: "head", commit: head, hits: [], truncated: false });
    expect((await symbol({ name: "MergeGate" })).hits.map((h) => [h.path, h.line])).toEqual([["src/gate.ts", 3]]);
  });

  it("answers at most the limit asked (200 unasked, 1000 at most) and says there were more", async () => {
    const many = git(repo, "rev-parse", "many").trim();
    const at = { headSha: many };
    expect(await symbol({ name: "manyName", limit: 3 }, at)).toMatchObject({ hits: [{ path: "many.ts", line: 1 }, { line: 2 }, { line: 3 }], truncated: true });
    const unasked = await symbol({ name: "manyName" }, at);
    expect([unasked.hits.length, unasked.truncated]).toEqual([200, true]);
    const most = await symbol({ name: "manyName", limit: 5000 }, at);
    expect([most.hits.length, most.truncated]).toEqual([1000, true]);
    const exact = await symbol({ name: "mergeGate", limit: 6 });
    expect([exact.hits.length, exact.truncated]).toEqual([6, false]);
  });

  it("names paths from the repository's root when the project is a folder inside it", async () => {
    const found = await symbol({ name: "mergeGate" }, { root: path.join(repo, "src") });
    expect(found.hits.map((h) => h.path)).toContain(colonPath);
    expect(found.hits.map((h) => h.path)).toContain("src/use.ts");
  });

  it("parses git grep -z output whatever the path holds, leaving out a record the output limit cut", () => {
    const c = "a".repeat(40);
    const out = [`${c}:we:ird/b:12:c.ts\u00003\u0000x: 1:2: y\n`, `${c}:new\nline.ts\u00007\u0000a\u0000b\r\n`, `other:x.ts\u00001\u0000skip\n`, `${c}:cut.ts\u00009\u0000no newl`].join("");
    expect(parseGrep(out, c, 10)).toEqual({
      hits: [
        { path: "we:ird/b:12:c.ts", line: 3, text: "x: 1:2: y" },
        { path: "new\nline.ts", line: 7, text: "a\u0000b" },
      ],
      truncated: false,
    });
    expect(parseGrep(out, c, 10, true).truncated).toBe(true);
    expect(parseGrep(out, c, 1)).toEqual({ hits: [{ path: "we:ird/b:12:c.ts", line: 3, text: "x: 1:2: y" }], truncated: true });
    expect(parseGrep("", c, 10)).toEqual({ hits: [], truncated: false });
  });
});

// Through the runtime's own socket and the client's, so what crosses is what the schemas let through both ways.
describe("pr.diff and pr.file over the wire", () => {
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;
  const asked: Array<unknown> = [];

  beforeAll(async () => {
    const at = (file: string) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const pullRequests = Layer.mock(PullRequestService)({
      diff: (input) =>
        Effect.succeed(
          input.cursor === undefined
            ? { patch: at("src/a.ts"), truncated: false, nextCursor: "3:1", revision: "3" }
            : { patch: at("src/b.ts"), truncated: false, nextCursor: null, revision: "3" },
        ),
      detail: () => Effect.fail(new PullRequestOperationError({ operation: "detail", detail: "not asked here" })),
      diffFileContents: (input) => (asked.push(input), Effect.succeed({ oldContents: "a\n", newContents: "b\n" })),
    });
    runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { provide: pullRequests });
    client = connect(runtime.url, runtime.token);
  });
  afterAll(async () => {
    client.close();
    await runtime.close();
  });

  it("hands the client the push pr.diff read its patches at, and the runtime the one pr.file sends back", async () => {
    const pr = { project_id: "p1", number: 12, repo: "acme/widgets" };

    const diff = await client.call("pr.diff", pr);
    const file = await client.call("pr.file", { ...pr, path: "src/b.ts", status: "modified", ...(diff.revision ? { revision: diff.revision } : {}) });

    expect(diff.revision).toBe("3");
    expect(diff.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(file).toEqual({ old: "a\n", new: "b\n" });
    expect(asked).toEqual([{ projectId: "p1", repository: "acme/widgets", number: 12, revision: "3", changeType: "change", oldPath: "src/b.ts", newPath: "src/b.ts" }]);
  });
});

describe("workspace.create on a pull request", () => {
  let root: string;
  let repo: string;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let client: ReturnType<typeof connect>;
  const asked: Array<unknown> = [];

  beforeAll(async () => {
    root = tempRoot("sp-pr-");
    repo = makeRepo(root, { "README.md": "hi\n" });
 // The host's head of #7, as upstream checkout leaves it: a local branch at the pull request's commit.
    git(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "feature.txt"), "from the pull request\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "feature");
    git(repo, "checkout", "-q", "main");
    const pullRequest = { number: 7, title: "Feature", url: "https://github.com/acme/widgets/pull/7", baseBranch: "main", headBranch: "feature", state: "open" as const };
    const gitManager = {
      branchPullRequest: () => Effect.succeed(null),
      checkoutPullRequestBranch: (input: { cwd: string; reference: string }) => {
        asked.push(input);
        return input.reference === "7"
          ? Effect.succeed({ pullRequest, branch: "feature" })
          : Effect.fail(new GitManagerError({ operation: "checkoutPullRequestBranch", cwd: input.cwd, detail: "no such pull request" }));
      },
    } as unknown as GitManager["Service"];
    runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, { provide: Layer.mergeAll(Layer.succeed(GitManager, gitManager), RepositoryIdentityResolver.layer) });
    client = connect(runtime.url, runtime.token);
  });
  afterAll(async () => {
    client.close();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts the chat on the head branch, checked out in its own worktree, measured from the base", async () => {
    const created = await client.call("workspace.create", { request_id: "pr-7", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, pull_request: { number: 7 } });
    // Answered before the host is asked: the checkout is the background start's.
    expect(created.branch).toBe("pr-7");
    await until(async () => (await client.call("workspace.get", { workspace_id: created.id })).branch === "feature");
    const ready = await client.call("workspace.get", { workspace_id: created.id });
    expect(ready).toMatchObject({ branch: "feature", base_ref: "main" });
    expect(asked).toContainEqual({ cwd: fs.realpathSync(repo), reference: "7" });
    const worktrees = git(repo, "worktree", "list", "--porcelain");
    const at = worktrees.split("\n").indexOf("branch refs/heads/feature");
    const tree = worktrees.split("\n")[at - 2]!.slice("worktree ".length);
    expect(fs.readFileSync(path.join(tree, "feature.txt"), "utf8")).toBe("from the pull request\n");
  });

  it("fails the chat, saying why, and leaves the branch alone when the host refuses", async () => {
    const created = await client.call("workspace.create", { request_id: "pr-8", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, pull_request: { number: 8 } });
    await until(async () => (await client.call("workspace.get", { workspace_id: created.id })).status === "failed");
    const events: Array<{ type: string; payload?: { error?: string } }> = [];
    const sub = await client.attach(created.session_id, 0, (e) => events.push(e as never));
    await until(() => events.some((e) => e.type === "tool.done"));
    await sub.detach();
    expect(events.find((e) => e.type === "tool.done")?.payload?.error).toContain("Could not check out #8");
    expect(events.find((e) => e.type === "tool.done")?.payload?.error).toContain("no such pull request");
    expect(git(repo, "branch", "--list", "feature").trim()).toContain("feature");
  });

  it("starts on the pull request of the repository it names: another repository's number is refused, never read in this checkout", async () => {
    const widgets = makeRepo(tempRoot("sp-pr-widgets-"), { "README.md": "widgets\n" });
    git(widgets, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    git(widgets, "branch", "feature");
    const create = (id: string, repo: string) => client.call("workspace.create", { request_id: id, repo: { path: widgets }, engine: "claude-agent", options: { model: MODEL }, pull_request: { number: 7, repo } });
    const checkouts = () => asked.filter((a) => (a as { cwd: string }).cwd === fs.realpathSync(widgets));
    // other/lib#7, opened through this project on its host: #7 here is acme/widgets#7, another pull request.
    await expect(create("pr-other", "other/lib")).rejects.toMatchObject({ error: { data: { reason: "invalid_params" }, message: expect.stringContaining("other/lib") } });
    expect(checkouts()).toEqual([]);
    const created = await create("pr-own", "Acme/Widgets");
    await until(async () => (await client.call("workspace.get", { workspace_id: created.id })).branch === "feature");
    expect(checkouts()).toEqual([{ cwd: fs.realpathSync(widgets), reference: "7" }]);
  });
});
