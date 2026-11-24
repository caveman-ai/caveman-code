// ), packages/source-control-gitlab/src/server/GitLabPullRequestProvider.test.ts @ 13aa882c22.
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as TestSourceControlHost from "@caveman-app/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import { gitLabViewerPermissions, make } from "./GitLabPullRequestProvider.ts";

it.effect.each(["merge", "disable-auto-merge"] as const)(
  "keeps reads and %s on the selected host when glab prefers another remote",
  (action) =>
    Effect.gen(function* () {
      const selectedHost = "gitlab.example.test:8443";
      const otherHost = "other.gitlab.example.test";
      const readHosts: string[] = [];
      const mergedHosts: string[] = [];
      const native = yield* GitLabCli.make.pipe(
        Effect.provide(
          TestSourceControlHost.layer({
            process: {
              run: (input) => {
                // glab prefers a remote named `gitlab` to `origin`. The checkout's
                // selected repository must still own every request and mutation.
                const host = input.env?.GITLAB_HOST ?? otherHost;
                const path = input.args[1];
                const mutation =
                  input.args[0] === "mr" || (input.args.includes("POST") && path !== "graphql");
                if (mutation) mergedHosts.push(host);
                else readHosts.push(host);
                const response = mutation
                  ? {}
                  : path === "graphql"
                    ? {
                        data: {
                          project: {
                            mergeRequests: {
                              nodes: [
                                { iid: "7", diffStatsSummary: { additions: 2, deletions: 1 } },
                              ],
                            },
                            mergeRequest: {
                              diffStatsSummary: { fileCount: 1 },
                              diffStats: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
                            },
                          },
                        },
                      }
                    : path?.includes("merge_requests/")
                      ? {
                          iid: 7,
                          title: "Merge request 7",
                          web_url: `https://${host}/acme/web/-/merge_requests/7`,
                          source_branch: "feature",
                          target_branch: "main",
                          created_at: "2026-07-01T00:00:00Z",
                          updated_at: "2026-07-02T00:00:00Z",
                          user: { can_merge: true },
                          diff_refs: {
                            head_sha: "a".repeat(40),
                            base_sha: "b".repeat(40),
                            start_sha: "b".repeat(40),
                          },
                        }
                      : path === "user"
                        ? { username: "reviewer" }
                        : path?.includes("/labels?") || path?.includes("/users?")
                          ? []
                          : { merge_method: "merge", squash_option: "default_off" };
                return Effect.succeed(
                  TestSourceControlHost.processOutput(JSON.stringify(response)),
                );
              },
            },
          }),
        ),
      );
      const cli = yield* GitLabPullRequestCli.make.pipe(
        Effect.provideService(GitLabCli.GitLabCli, native),
      );
      const provider = yield* make.pipe(
        Effect.provideService(GitLabPullRequestCli.GitLabPullRequestCli, cli),
      );
      const reference = {
        cwd: "/repo",
        repository: "acme/web",
        host: selectedHost,
        number: 7,
      };
      const detail = yield* provider.getChangeRequest(reference);
      expect({ additions: detail.additions, deletions: detail.deletions }).toEqual({
        additions: 2,
        deletions: 1,
      });
      assert.isDefined(provider.getChangeRequestSummary);
      expect((yield* provider.getChangeRequestSummary(reference)).additions).toBe(2);
      assert.isDefined(provider.listChangeRequestStats);
      expect(
        yield* provider.listChangeRequestStats({ ...reference, changeRequests: [reference] }),
      ).toEqual([{ repository: reference.repository, number: 7, additions: 2, deletions: 1 }]);
      expect(yield* provider.getViewer(reference)).toBe("reviewer");
      yield* provider.runAction({ ...reference, action });

      expect(readHosts).toEqual(Array(action === "merge" ? 9 : 8).fill(selectedHost));
      expect({ url: detail.url, mutatedHosts: mergedHosts }).toEqual({
        url: `https://${selectedHost}/acme/web/-/merge_requests/7`,
        mutatedHosts: [selectedHost],
      });
    }),
);

describe("gitLabViewerPermissions", () => {
  it("offers everything to a viewer GitLab says can merge", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: true })).toEqual({
      actions: [
        "merge",
        "ready",
        "draft",
        "close",
        "reopen",
        "update-branch",
        "enable-auto-merge",
        "disable-auto-merge",
      ],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      requestReviewers: true,
      updateMethods: ["rebase"],
    });
  });

  it("keeps merge, now and later, from a viewer GitLab says cannot", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: false })).toEqual({
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      requestReviewers: true,
    });
  });

  it("names no way of updating a branch it will not let this viewer update", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: false }).updateMethods).toBeUndefined();
  });

  it("treats an author with read access as any other reader, which is all GitLab says", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: false }).actions).toEqual([
      "ready",
      "draft",
      "close",
      "reopen",
    ]);
  });
});

describe("getChangeRequest base freshness", () => {
  const detail = {
    number: 7,
    title: "Merge request 7",
    url: "https://gitlab.com/acme/web/-/merge_requests/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  };

  it.effect("reads checks without fetching project settings", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDetail: () => Effect.succeed(detail),
          }),
        ),
      );
      const read = provider.getChangeRequestChecks;
      if (read === undefined) return yield* Effect.die("checks read missing");
      expect(
        yield* read({ cwd: "/w", repository: "group/subgroup/web", host: "gitlab.com", number: 7 }),
      ).toEqual({ state: "open", checks: [] });
    }),
  );

  it.effect.each(["getChangeRequestPreview", "getChangeRequestSummary"] as const)(
    "%s preserves merge request fields without fetching project settings",
    (operation) =>
      Effect.gen(function* () {
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              getMergeRequestDetail: () => Effect.succeed(detail),
              getReviewDecisions: () => Effect.succeed(new Map()),

              listMergeRequestStats: () => Effect.succeed([]),
            }),
          ),
        );
        const read = provider[operation];
        assert.isDefined(read);
        expect(
          yield* read({ cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 }),
        ).toEqual(detail);
      }),
  );

  const readWith = (
    divergence: { readonly divergedCommits?: number },
    stats: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listMergeRequestStats"] = () =>
      Effect.succeed([]),
  ) =>
    Effect.gen(function* () {
      const provider = yield* make;
      return yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
      });
    }).pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          getMergeRequestDetail: () => Effect.succeed({ ...detail, ...divergence }),
          getProjectMergeCapabilities: () =>
            Effect.succeed({ merge: true, squash: true, rebase: true }),
          listMergeRequestStats: stats,
        }),
      ),
    );

  it.effect("reads a counted divergence as a branch that has fallen behind", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({ divergedCommits: 3 });

      expect(changeRequest.baseComparison).toBe("behind");
      expect(changeRequest.behindBy).toBe(3);
    }),
  );

  it.effect("reads a divergence of none as a branch that is current", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({ divergedCommits: 0 });

      expect(changeRequest.baseComparison).toBe("up-to-date");
      expect(changeRequest.behindBy).toBe(0);
    }),
  );

  it.effect("says nothing at all where GitLab counted nothing", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({});

      expect(changeRequest.baseComparison).toBe("unknown");
      expect(changeRequest.behindBy).toBeUndefined();
    }),
  );

  it.effect("fills in the line counts the REST detail leaves out", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({}, () =>
        Effect.succeed([{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }]),
      );

      expect(changeRequest.additions).toBe(40);
      expect(changeRequest.deletions).toBe(2);
    }),
  );

  it.effect("reports an unauthenticated line count read instead of a detail without counts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        readWith({}, () =>
          Effect.fail(
            new GitLabCli.GitLabCliAuthenticationError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: null,
            }),
          ),
        ),
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "PullRequestProviderError", reason: "unauthenticated" },
      });
    }),
  );

  it.effect("gives linked threads line counts without reading the merge settings", () =>
    Effect.gen(function* () {
      const summary = yield* Effect.gen(function* () {
        const provider = yield* make;
        const read = provider.getChangeRequestSummary;
        if (read === undefined) return yield* Effect.die("summary read missing");
        return yield* read({ cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 });
      }).pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDetail: () => Effect.succeed(detail),
            getProjectMergeCapabilities: () => Effect.die("linked threads skip merge settings"),
            getReviewDecisions: () => Effect.succeed(new Map()),
            listMergeRequestStats: () =>
              Effect.succeed([{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }]),
          }),
        ),
      );

      expect(summary.additions).toBe(40);
      expect(summary.deletions).toBe(2);
    }),
  );
});

describe("rewriting what has already been said", () => {
  const updateMergeRequest = vi.fn(() => Effect.void);
  const updateNote = vi.fn(() => Effect.void);

  const providerWith = make.pipe(
    Effect.provide(
      Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({ updateMergeRequest, updateNote }),
    ),
  );

  it.effect("sends only the half of the merge request the reader rewrote", () =>
    Effect.gen(function* () {
      const provider = yield* providerWith;
      assert.isDefined(provider.updateChangeRequest);

      yield* provider.updateChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
        body: "What this changes.",
      });

      expect(updateMergeRequest).toHaveBeenCalledWith({
        cwd: "/w",
        host: "gitlab.com",
        repository: "acme/web",
        number: 7,
        description: "What this changes.",
      });
    }),
  );

  it.effect("rewrites a positioned comment through the same note as any other", () =>
    Effect.gen(function* () {
      const provider = yield* providerWith;
      assert.isDefined(provider.updateComment);

      yield* provider.updateComment({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
        commentId: "42",
        kind: "review-comment",
        body: "Reworded.",
      });

      expect(updateNote).toHaveBeenCalledWith({
        cwd: "/w",
        host: "gitlab.com",
        repository: "acme/web",
        number: 7,
        noteId: "42",
        body: "Reworded.",
      });
    }),
  );
});

describe("expanding unchanged lines", () => {
  const change = {
    cwd: "/w",
    repository: "acme/web",
    host: "gitlab.com",
    number: 7,
    changeType: "change" as const,
    oldPath: "src/page.ts",
    newPath: "src/page.ts",
  };

  it.effect("reads both sides of a file through the merge request or one of its commits", () =>
    Effect.gen(function* () {
      const getMergeRequestDiffFileContents = vi.fn(() =>
        Effect.succeed({ oldContents: "before\n", newContents: "after\n" }),
      );
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDiffFileContents,
          }),
        ),
      );
      assert.isDefined(provider.getDiffFileContents);
      const oneCommit = { ...change, commit: "a1b2c3d" };

      expect(yield* provider.getDiffFileContents(change)).toEqual({
        oldContents: "before\n",
        newContents: "after\n",
      });
      yield* provider.getDiffFileContents(oneCommit);
      expect(getMergeRequestDiffFileContents).toHaveBeenNthCalledWith(1, change);
      expect(getMergeRequestDiffFileContents).toHaveBeenNthCalledWith(2, oneCommit);
    }),
  );

  it.effect("reports a file GitLab cannot expand as a failed read", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDiffFileContents: () =>
              Effect.fail(
                new GitLabPullRequestCli.GitLabDiffFileContentsUnavailableError({
                  command: "glab",
                  cwd: "/w",
                  path: "assets/logo.png",
                  reason: "binary",
                }),
              ),
          }),
        ),
      );
      assert.isDefined(provider.getDiffFileContents);

      expect(yield* Effect.flip(provider.getDiffFileContents(change))).toMatchObject({
        _tag: "PullRequestProviderError",
        provider: "gitlab",
        operation: "getDiffFileContents",
        reason: "failed",
        detail: "The diff file 'assets/logo.png' is binary.",
      });
    }),
  );

  it.effect("refuses a revision the merge request never had as not found", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDiffFileContents: () =>
              Effect.fail(
                new GitLabPullRequestCli.GitLabDiffRevisionUnavailableError({
                  command: "glab",
                  cwd: "/w",
                  operation: "getMergeRequestDiffFileContents",
                }),
              ),
          }),
        ),
      );
      assert.isDefined(provider.getDiffFileContents);

      expect(
        yield* Effect.flip(provider.getDiffFileContents({ ...change, revision: "99" })),
      ).toMatchObject({
        _tag: "PullRequestProviderError",
        operation: "getDiffFileContents",
        reason: "not-found",
      });
    }),
  );

  it.effect("refuses the rest of a walk a push landed in as not found", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDiff: () =>
              Effect.fail(
                new GitLabPullRequestCli.GitLabDiffRevisionMovedError({
                  command: "glab",
                  cwd: "/w",
                }),
              ),
          }),
        ),
      );
      const { changeType: _, oldPath: _old, newPath: _new, ...ref } = change;

      expect(yield* Effect.flip(provider.getDiff({ ...ref, cursor: "11:2" }))).toMatchObject({
        _tag: "PullRequestProviderError",
        operation: "getDiff",
        reason: "not-found",
      });
    }),
  );
});

describe("merge request reads", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
  const detail = {
    number: 7,
    title: "Merge request 7",
    url: "https://gitlab.com/acme/web/-/merge_requests/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  };

  const countingProvider = Effect.gen(function* () {
    const calls = { detail: 0, mergeCapabilities: 0 };
    const host = { viewerCanMerge: true };
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          listMergeRequestStats: () => Effect.succeed([]),
          getReviewDecisions: () => Effect.succeed(new Map()),
          getMergeRequestDetail: (input) =>
            Effect.sync(() => {
              calls.detail += 1;
              return { ...detail, number: input.number, viewerCanMerge: host.viewerCanMerge };
            }),
          getProjectMergeCapabilities: () =>
            Effect.sync(() => {
              calls.mergeCapabilities += 1;
              return { merge: true, squash: true, rebase: true };
            }),
          runMergeRequestAction: () => Effect.void,
        }),
      ),
    );
    const checks = provider.getChangeRequestChecks;
    const forget = provider.forgetChangeRequestReads;
    if (checks === undefined || forget === undefined) {
      return yield* Effect.die("GitLab answers checks and forgets its reads");
    }
    return { provider, checks, forget, calls, host };
  });

  it.effect("asks for a project's merge methods once across its merge requests", () =>
    Effect.gen(function* () {
      const { provider, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest({ ...reference, number: 8 });

      expect(calls.mergeCapabilities).toBe(1);
    }),
  );

  it.effect("answers checks from the merge request the detail just read", () =>
    Effect.gen(function* () {
      const { provider, checks, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* checks(reference);

      expect(calls.detail).toBe(1);

      const summary = provider.getChangeRequestSummary;
      assert.isDefined(summary);
      yield* summary(reference);
      expect(calls.detail).toBe(2);
    }),
  );

  it.effect("reads a merge request again after a write to it", () =>
    Effect.gen(function* () {
      const { provider, checks, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* provider.runAction({ ...reference, action: "ready" });
      yield* checks(reference);

      expect(calls.detail).toBe(2);
    }),
  );

  it.effect.each([{ cwd: "/other" }, { host: "other.gitlab.test" }])(
    "does not share reads with %j",
    (other) =>
      Effect.gen(function* () {
        const { provider, calls } = yield* countingProvider;

        yield* provider.getChangeRequest(reference);
        yield* provider.getChangeRequest({ ...reference, ...other });
        yield* provider.getChangeRequest(reference);
        yield* provider.getChangeRequest({ ...reference, ...other });

        expect(calls).toEqual({ detail: 2, mergeCapabilities: 2 });
      }),
  );

  it.effect("reads a merge request again once a minute has passed", () =>
    Effect.gen(function* () {
      const { provider, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* TestClock.adjust("61 seconds");
      yield* provider.getChangeRequest(reference);

      expect(calls.detail).toBe(2);
    }),
  );

  it.effect("answers viewer permissions from the host, not the page's read", () =>
    Effect.gen(function* () {
      const { provider, host } = yield* countingProvider;

      host.viewerCanMerge = false;
      yield* provider.getChangeRequest(reference);
      host.viewerCanMerge = true;
      const granted = yield* provider.getViewerPermissions(reference);
      host.viewerCanMerge = false;
      const revoked = yield* provider.getViewerPermissions(reference);

      expect(granted.actions).toContain("merge");
      expect(revoked.actions).not.toContain("merge");
    }),
  );

  it.effect("reads a merge request again once its reads are forgotten", () =>
    Effect.gen(function* () {
      const { provider, checks, forget, calls } = yield* countingProvider;
      const other = { ...reference, repository: "acme/api" };

      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest(other);
      yield* forget({ repository: "ACME/web", number: 7 });
      yield* checks(reference);
      yield* checks(other);
      expect(calls.detail).toBe(3);

      yield* forget({ repository: "acme/web" });
      yield* checks(reference);
      yield* forget();
      yield* checks(other);
      expect(calls.detail).toBe(5);
    }),
  );
});

describe("optional activity reads", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
  const comment = {
    id: "42",
    kind: "issue-comment" as const,
    author: null,
    body: "Keep this comment",
    createdAt: "2026-07-01T00:00:00Z",
    url: null,
    path: null,
    reviewState: null,
  };
  const commit = {
    oid: "abc",
    messageHeadline: "Keep this commit",
    committedDate: "2026-07-01T00:00:00Z",
  };
  const reads = {
    listNotes: () => Effect.succeed({ comments: [comment], truncated: false }),
    listCommits: () => Effect.succeed([commit]),
    listDiscussions: () => Effect.succeed({ threads: [], truncated: false }),
    listReactions: () => Effect.succeed({ reactions: [], reactionsByNoteId: new Map() }),
  };
  const context = {
    operation: "execute" as const,
    command: "glab" as const,
    cwd: "/w",
    cause: null,
  };

  it.effect.each([
    {
      operation: "listNotes",
      error: new GitLabCli.GitLabCliAuthenticationError(context),
      reason: "unauthenticated",
    },
    {
      operation: "listCommits",
      error: new GitLabCli.GitLabCliUnavailableError(context),
      reason: "missing-tool",
    },
  ] as const)(
    "reports $reason instead of successful partial activity",
    ({ operation, error, reason }) =>
      Effect.gen(function* () {
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              ...reads,
              [operation]: () => Effect.fail(error),
            }),
          ),
        );

        expect(yield* Effect.result(provider.getChangeRequestActivity(reference))).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PullRequestProviderError",
            provider: "gitlab",
            operation: "getChangeRequestActivity",
            reason,
            detail: error.detail,
            cause: error,
          },
        });
      }),
  );

  it.effect("keeps comments and commits when optional discussions and reactions fail", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listDiscussions: () =>
              Effect.fail(
                new GitLabPullRequestCli.GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: "/w",
                  operation: "listDiscussions",
                  cause: null,
                }),
              ),
            listReactions: () => Effect.fail(new GitLabCli.GitLabCliCommandError(context)),
          }),
        ),
      );

      expect(yield* provider.getChangeRequestActivity(reference)).toEqual({
        comments: [{ ...comment, reactions: [] }],
        commentCount: 1,
        commentsTruncated: true,
        reviewThreads: [],
        reactions: [],
        commits: [commit],
      });
    }),
  );
});

describe("review decisions", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
  const item = {
    number: 7,
    title: "Merge request 7",
    url: "https://gitlab.com/acme/web/-/merge_requests/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
  };
  const detail = {
    ...item,
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  };
  const providerWith = (
    getReviewDecisions: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["getReviewDecisions"],
  ) =>
    make.pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          listMergeRequests: () =>
            Effect.succeed({
              items: [item, { ...item, number: 8 }],
              truncated: false,
              cursorAdvance: 2,
            }),
          getMergeRequestDetail: () => Effect.succeed(detail),
          getReviewDecisions,
          listMergeRequestStats: () =>
            Effect.succeed([{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }]),
        }),
      ),
    );
  const listing = {
    cwd: "/w",
    repository: "acme/web",
    host: "gitlab.com",
    state: "open" as const,
    involvement: "all" as const,
    viewer: "julius",
    limit: 2,
  };

  it.effect("puts GitLab's approval state on listed and summarized merge requests", () =>
    Effect.gen(function* () {
      const provider = yield* providerWith((input) => {
        expect(input.host).toBe(reference.host);
        return Effect.succeed(
          new Map([
            [7, "approved" as const],
            [8, null],
          ]),
        );
      });
      const listed = yield* provider.listChangeRequests(listing);
      assert.isDefined(provider.getChangeRequestSummary);
      const summary = yield* provider.getChangeRequestSummary(reference);

      expect(listed.items.map(({ reviewDecision }) => reviewDecision)).toEqual(["approved", null]);
      expect(summary.reviewDecision).toBe("approved");
      expect(summary.additions).toBe(40);
      expect(summary.deletions).toBe(2);
    }),
  );

  it.effect.each([
    {
      failure: "a failed read",
      error: new GitLabPullRequestCli.GitLabMergeRequestReadError({
        command: "glab",
        cwd: "/w",
        operation: "getReviewDecisions",
        cause: null,
      }),
    },
    {
      failure: "a rate limit",
      error: new GitLabCli.GitLabCliRateLimitError({
        operation: "execute",
        command: "glab",
        cwd: "/w",
        cause: null,
      }),
    },
  ])("keeps rows and summaries with an unknown decision after $failure", ({ error }) =>
    Effect.gen(function* () {
      const provider = yield* providerWith(() => Effect.fail(error));
      const listed = yield* provider.listChangeRequests(listing);
      assert.isDefined(provider.getChangeRequestSummary);
      const summary = yield* provider.getChangeRequestSummary(reference);

      expect(listed.items.map(({ reviewDecision }) => reviewDecision)).toEqual([
        undefined,
        undefined,
      ]);
      expect(summary.reviewDecision).toBeUndefined();
    }),
  );
});
