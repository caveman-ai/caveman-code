// ), packages/source-control-gitlab/src/server/GitLabPullRequestCli.test.ts @ 13aa882c22.
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError } from "@caveman-app/protocol";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

const mockedExecute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();

const layer = it.layer(
  GitLabPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: mockedExecute,
      }),
    ),
  ),
);

function output(stdout: string, stdoutTruncated = false, stdoutInvalidUtf8 = false) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated,
    stderrTruncated: false,
    stdoutInvalidUtf8,
  };
}

function mergeRequests(count: number, firstNumber: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      iid: firstNumber + index,
      title: `Merge request ${firstNumber + index}`,
      web_url: `https://gitlab.com/acme/web/-/merge_requests/${firstNumber + index}`,
      source_branch: "feat/page",
      target_branch: "main",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    })),
  );
}

function diffPage(firstIndex: number, count = 100): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      old_path: `src/${firstIndex + index}.ts`,
      new_path: `src/${firstIndex + index}.ts`,
      diff: "@@ -1 +1 @@\n-a\n+b\n",
    })),
  );
}

function notes(count: number, firstId: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      body: `note ${firstId + index}`,
      author: { username: "bilal" },
      created_at: "2026-07-01T00:00:00Z",
    })),
  );
}

/** The newest diff version, which a first slice reads either side of its page. */
const newestVersion = output(
  JSON.stringify([
    {
      id: 11,
      head_commit_sha: "b".repeat(40),
      base_commit_sha: "a".repeat(40),
      start_commit_sha: "a".repeat(40),
      state: "collected",
    },
  ]),
);

const author = { id: 1, username: "bilal" };
const reviewer = { id: 5, username: "octocat" };

function mergeRequestJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    iid: 7,
    title: "Merge request 7",
    web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
    source_branch: "feat/page",
    target_branch: "main",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    author,
    ...overrides,
  });
}

function argsOfCall(index: number): ReadonlyArray<string> {
  return callAt(index).args;
}

function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

afterEach(() => {
  mockedExecute.mockReset();
});

interface FakeVersion {
  readonly id: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffs: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Merge request 7 of acme/web as GitLab's REST API serves it: every push a diff version, kept for
 * the life of the merge request and listed newest first, while the paged diff and the merge
 * request's own diff refs only ever speak for the newest. Files are read by path at a sha.
 */
function fakeGitLab(input: {
  readonly versions: Array<FakeVersion>;
  readonly files: Readonly<Record<string, string>>;
  readonly onDiffPage?: (page: number) => void;
}) {
  const mergeRequest = "projects/acme%2Fweb/merge_requests/7";
  const notFound = (cwd: string) =>
    Effect.fail(
      new GitLabCli.GitLabCliCommandError({
        operation: "execute",
        command: "glab",
        cwd,
        cause: new VcsProcessExitError({
          operation: "GitLabCli.execute",
          command: "glab",
          cwd,
          exitCode: 1,
          detail: "GET 404 Not Found",
          failureKind: "not-found",
        }),
      }),
    );
  const versionJson = (version: FakeVersion) => ({
    id: version.id,
    head_commit_sha: version.headSha,
    base_commit_sha: version.baseSha,
    start_commit_sha: version.baseSha,
    state: "collected",
  });
  const unbounded = output;
  mockedExecute.mockImplementation((call) => {
    // As the process runner does: past the bound asked for, or a million bytes, the rest is cut.
    const bound = call.maxOutputBytes ?? 1_000_000;
    const output = (stdout: string) =>
      Buffer.byteLength(stdout) > bound
        ? unbounded(Buffer.from(stdout).subarray(0, bound).toString(), true)
        : unbounded(stdout);
    const [, path = ""] = call.args;
    const [base = "", search = ""] = path.split("?");
    const params = new URLSearchParams(search);
    const perPage = Math.min(Number(params.get("per_page") ?? "20"), 100);
    const page = Number(params.get("page") ?? "1");
    const paged = <A>(rows: ReadonlyArray<A>) => rows.slice((page - 1) * perPage, page * perPage);
    const newest = input.versions[0];
    if (newest === undefined) return notFound(call.cwd);
    if (base === `${mergeRequest}/versions`) {
      return Effect.succeed(output(JSON.stringify(paged(input.versions.map(versionJson)))));
    }
    const versionId = /\/versions\/(\d+)$/.exec(base)?.[1];
    if (base.startsWith(`${mergeRequest}/versions/`)) {
      const version = input.versions.find((candidate) => String(candidate.id) === versionId);
      return version === undefined
        ? notFound(call.cwd)
        : Effect.succeed(output(JSON.stringify({ ...versionJson(version), diffs: version.diffs })));
    }
    if (base === `${mergeRequest}/diffs`) {
      const rows = paged(newest.diffs);
      input.onDiffPage?.(page);
      return Effect.succeed(output(JSON.stringify(rows)));
    }
    if (base === mergeRequest) {
      return Effect.succeed(
        output(
          JSON.stringify({
            iid: 7,
            diff_refs: {
              base_sha: newest.baseSha,
              head_sha: newest.headSha,
              start_sha: newest.baseSha,
            },
          }),
        ),
      );
    }
    const filePath = /^projects\/acme%2Fweb\/repository\/files\/(.+)\/raw$/.exec(base)?.[1];
    if (filePath !== undefined) {
      const contents = input.files[`${decodeURIComponent(filePath)}@${params.get("ref")}`];
      return contents === undefined ? notFound(call.cwd) : Effect.succeed(output(contents));
    }
    return notFound(call.cwd);
  });
}

const baseSha = "a".repeat(40);
const firstHead = "1".repeat(40);
const secondHead = "2".repeat(40);
const changedFile = (path: string, diff: string) => ({ old_path: path, new_path: path, diff });
const firstPush: FakeVersion = {
  id: 11,
  baseSha,
  headSha: firstHead,
  diffs: [changedFile("src/a.ts", "@@ -1 +1,2 @@\n one\n+two\n")],
};
const secondPush: FakeVersion = {
  id: 12,
  baseSha,
  headSha: secondHead,
  diffs: [
    changedFile("src/a.ts", "@@ -1 +1,3 @@\n one\n+two\n+three\n"),
    changedFile("src/b.ts", "@@ -1 +1 @@\n-b\n+B\n"),
  ],
};
/** A push of more files than one diff page holds, each saying which push it is. */
const manyFiles = (push: string) =>
  Array.from({ length: 45 }, (_, index) =>
    changedFile(`src/${index}.ts`, `@@ -1 +1 @@\n-a\n+${push}\n`),
  );
const firstLongPush: FakeVersion = { ...firstPush, diffs: manyFiles("first") };
const secondLongPush: FakeVersion = { ...secondPush, diffs: manyFiles("second") };

function cliFailure(failureKind: "not-found" | "command-failed" | "authentication") {
  const cause = new VcsProcessExitError({
    operation: "GitLabCli.execute",
    command: "glab",
    cwd: "/w",
    exitCode: 1,
    detail: "GET 500",
    failureKind,
  });
  const context = { operation: "execute" as const, command: "glab" as const, cwd: "/w", cause };
  return Effect.fail(
    failureKind === "authentication"
      ? new GitLabCli.GitLabCliAuthenticationError(context)
      : new GitLabCli.GitLabCliCommandError(context),
  );
}

const pushedFiles = {
  [`src/a.ts@${baseSha}`]: "one\n",
  [`src/a.ts@${firstHead}`]: "one\ntwo\n",
  [`src/a.ts@${secondHead}`]: "one\ntwo\nthree\n",
};

layer("GitLabPullRequestCli.layer", (it) => {
  it.effect("batches approval reads at GitLab's page limit and skips an empty list", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ stdin }) => {
        const { variables } = JSON.parse(stdin ?? "{}");
        return Effect.succeed(
          output(
            JSON.stringify({
              data: {
                metadata: { enterprise: true },
                project: {
                  mergeRequests: {
                    nodes: variables.iids.map((iid: string) => ({
                      iid,
                      approved: true,
                      approvedBy: { nodes: [{ username: "reviewer" }] },
                    })),
                  },
                },
              },
            }),
          ),
        );
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.internal" };
      expect(yield* cli.getReviewDecisions({ ...reference, numbers: [] })).toEqual(new Map());
      expect(mockedExecute).not.toHaveBeenCalled();
      const decisions = yield* cli.getReviewDecisions({
        ...reference,
        numbers: Array.from({ length: 101 }, (_, index) => index + 1),
      });
      expect(callAt(0).host).toBe(reference.host);
      expect(callAt(1).host).toBe(reference.host);
      expect(decisions.size).toBe(101);
      expect(decisions.get(101)).toBe("approved");
      expect(mockedExecute).toHaveBeenCalledTimes(2);
      expect(
        [0, 1].map((index) => JSON.parse(callAt(index).stdin ?? "{}").variables.iids.length),
      ).toEqual([100, 1]);
      expect(argsOfCall(0)).toEqual([
        "api",
        "graphql",
        "--method",
        "POST",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
    }),
  );

  it.effect("asks GitLab for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(3, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 3);
      assert.isFalse(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 3);
      const path = argsOfCall(0)[1] ?? "";
      expect(path).toContain("projects/acme%2Fweb/merge_requests");
      expect(path).toContain("per_page=11");
      expect(path).toContain("state=opened");
    }),
  );

  it.effect("walks pages at a fixed size, because GitLab pages by offset", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(100, 1))))
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(100, 101))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 150);
      assert.isTrue(batch.truncated);
      for (const index of [0, 1]) {
        expect(argsOfCall(index)[1]).toContain("per_page=100");
      }
      expect(argsOfCall(0)[1]).toContain("page=1");
      expect(argsOfCall(1)[1]).toContain("page=2");
    }),
  );

  it.effect("hands a search to GitLab's own search parameter", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "page",
      });

      expect(argsOfCall(0)[1]).toContain("search=page");
    }),
  );

  it.effect("carries on from the number of rows already delivered", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(3, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 10 },
      });

      // GitLab's timestamp filter has no tie-breaker, so an offset is what advances through a
      // boundary shared by more rows than one page can hold.
      const path = argsOfCall(0)[1] ?? "";
      expect(path).not.toContain("updated_before=");
      expect(path).toContain("order_by=updated_at");
      expect(path).toContain("per_page=11");
      expect(path).toContain("page=1");
    }),
  );

  it.effect("advances beyond several pages sharing the cursor timestamp", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(11, 144))))
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(11, 155))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z", delivered: 150 },
      });

      expect(argsOfCall(0)[1]).toContain("per_page=11");
      expect(argsOfCall(0)[1]).toContain("page=14");
      expect(argsOfCall(1)[1]).toContain("page=15");
      expect(batch.items.map((item) => item.number)).toEqual([
        151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
      ]);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("advances the cursor through malformed raw rows", () =>
    Effect.gen(function* () {
      const rows = JSON.parse(mergeRequests(2, 1)) as ReadonlyArray<unknown>;
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify([{ iid: "malformed" }, ...rows]))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      assert.strictEqual(batch.cursorAdvance, 3);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("URL-encodes a search, so it cannot add a parameter of its own", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: '-a&per_page=1 "b"',
      });

      const path = argsOfCall(0)[1] ?? "";
      expect(path).toContain("search=-a%26per_page%3D1%20%22b%22");
      assert.strictEqual(path.match(/per_page=/g)?.length, 1);
    }),
  );

  it.effect("asks for no search at all when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "   ",
      });

      expect(argsOfCall(0)[1]).not.toContain("search=");
    }),
  );

  it.effect("stops walking on a short page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(40, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 40);
      assert.isFalse(batch.truncated);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("stops walking when every row on a page fails to decode", () =>
    Effect.gen(function* () {
      const unusable = JSON.stringify(Array.from({ length: 100 }, () => ({ iid: "nope" })));
      mockedExecute.mockReturnValue(Effect.succeed(output(unusable)));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 0);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("asks GitLab for every state on the All tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "all",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(argsOfCall(0)[1]).toContain("state=all");
    }),
  );

  it.effect("filters by the reviewer when the viewer is reviewing", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "reviewing",
        viewer: "bilal",
        limit: 10,
      });

      expect(argsOfCall(0)[1]).toContain("reviewer_username=bilal");
    }),
  );

  it.effect("addresses a nested group project by its encoded full path", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/platform/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(argsOfCall(0)[1]).toContain("projects/acme%2Fplatform%2Fweb/merge_requests");
    }),
  );

  it.effect.each([
    { action: "merge", autoMerge: "false", mergeMethod: "squash" },
    { action: "enable-auto-merge", autoMerge: "true", mergeMethod: "squash" },
    { action: "merge", autoMerge: "false", mergeMethod: "rebase" },
    { action: "enable-auto-merge", autoMerge: "true", mergeMethod: "rebase" },
  ] as const)(
    "$action with $mergeMethod succeeds on a project requiring the current source SHA",
    ({ action, autoMerge, mergeMethod }) =>
      Effect.gen(function* () {
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        for (const headSha of ["first-head", "updated-head"]) {
          let currentHeadSha = headSha;
          mockedExecute.mockImplementation(({ cwd, args }) => {
            if (args[0] === "mr" && args[1] === "rebase") {
              return Effect.sync(() => {
                currentHeadSha = `${headSha}-rebased`;
                return output("");
              });
            }
            if (args[0] === "api") {
              return Effect.succeed(
                output(
                  mergeRequestJson({
                    diff_refs: { base_sha: "base", head_sha: currentHeadSha, start_sha: "start" },
                  }),
                ),
              );
            }
            if (args.includes("--rebase") || args[args.indexOf("--sha") + 1] !== currentHeadSha) {
              return Effect.fail(
                new GitLabCli.GitLabCliCommandError({
                  operation: "execute",
                  command: "glab",
                  cwd,
                  cause: new Error(
                    args.includes("--rebase")
                      ? "Merge must not combine --rebase with --sha: rebase changes the source HEAD"
                      : "SHA must match the current source branch HEAD",
                  ),
                }),
              );
            }
            return Effect.succeed(output(""));
          });

          yield* cli.runMergeRequestAction({
            cwd: "/w",
            repository: "acme/web",
            number: 7,
            action,
            mergeMethod,
          });

          const callsPerAction = mergeMethod === "rebase" ? 3 : 2;
          expect(
            mockedExecute.mock.calls.slice(-callsPerAction).map(([input]) => input.args),
          ).toEqual([
            ...(mergeMethod === "rebase" ? [["mr", "rebase", "7", "--repo", "acme/web"]] : []),
            ["api", "projects/acme%2Fweb/merge_requests/7"],
            [
              "mr",
              "merge",
              "7",
              "--repo",
              "acme/web",
              `--auto-merge=${autoMerge}`,
              "--yes",
              ...(mergeMethod === "squash" ? ["--squash"] : []),
              "--sha",
              mergeMethod === "rebase" ? `${headSha}-rebased` : headSha,
            ],
          ]);
        }
        expect(mockedExecute).toHaveBeenCalledTimes(mergeMethod === "rebase" ? 6 : 4);
      }),
  );

  it.effect.each(["merge", "enable-auto-merge"] as const)(
    "does not run %s when GitLab has no diff revisions",
    (action) =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(
          Effect.succeed(output(mergeRequestJson({ diff_refs: null }))),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const result = yield* Effect.result(
          cli.runMergeRequestAction({
            cwd: "/w",
            repository: "acme/web",
            number: 7,
            action,
            mergeMethod: "squash",
          }),
        );

        expect(mockedExecute.mock.calls.map(([input]) => input.args)).toEqual([
          ["api", "projects/acme%2Fweb/merge_requests/7"],
        ]);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "GitLabDiffRefsUnavailableError" },
        });
      }),
  );

  it.effect("cancels an armed auto-merge through the API glab has no flag for", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/platform/web",
        number: 7,
        action: "disable-auto-merge",
      });

      expect(argsOfCall(0)).toEqual([
        "api",
        "projects/acme%2Fplatform%2Fweb/merge_requests/7/cancel_merge_when_pipeline_succeeds",
        "--method",
        "POST",
      ]);
    }),
  );

  it.effect("brings a stale branch up to date by rebasing it, the only way GitLab has", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action: "update-branch",
      });

      expect(argsOfCall(0)).toEqual(["mr", "rebase", "7", "--repo", "acme/web"]);
    }),
  );

  it.effect("moves a merge request back to draft through glab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action: "draft",
      });

      expect(argsOfCall(0)).toEqual(["mr", "update", "7", "--repo", "acme/web", "--draft"]);
    }),
  );

  it.effect("sends a comment body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.commentOnMergeRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        body: "true",
      });

      const call = mockedExecute.mock.calls[0];
      assert.isDefined(call);
      expect(call[0].args).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7/notes",
        "--method",
        "POST",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      expect(call[0].stdin).toBe('{"body":"true"}');
    }),
  );

  it.effect("reads one diff page and hands back the cursor for the next", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(newestVersion))
        .mockReturnValueOnce(Effect.succeed(output(diffPage(0))))
        .mockReturnValueOnce(Effect.succeed(newestVersion));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const diff = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      assert.isNotNull(diff.nextCursor);
      assert.isFalse(diff.truncated);
      assert.strictEqual(diff.revision, "11");
      // The head of the version the page was read at, as GitLab names it.
      assert.strictEqual(diff.headSha, "b".repeat(40));
      expect(argsOfCall(1)[1]).toContain("merge_requests/7/diffs?per_page=30&page=1");
    }),
  );

  it.effect("carries on from a cursor at the page it names", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(newestVersion))
        .mockReturnValueOnce(Effect.succeed(output(diffPage(0))))
        .mockReturnValueOnce(Effect.succeed(newestVersion))
        .mockReturnValueOnce(Effect.succeed(output(diffPage(100, 3))))
        .mockReturnValueOnce(Effect.succeed(newestVersion));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      const first = yield* cli.getMergeRequestDiff(target);
      assert.strictEqual(first.nextCursor, "11:2");
      const second = yield* cli.getMergeRequestDiff({
        ...target,
        cursor: first.nextCursor ?? undefined,
      });

      expect(argsOfCall(3)[1]).toContain("diffs?per_page=30&page=2");
      assert.isNull(second.nextCursor);
      assert.strictEqual(second.revision, "11");
      assert.strictEqual(second.headSha, "b".repeat(40));
      expect(second.patch).toContain("diff --git a/src/100.ts b/src/100.ts");
    }),
  );

  it.effect(
    "pages a merge request diff 30 files at a time, which GitLab 15.7 to 17.10 accept",
    () =>
      Effect.gen(function* () {
        mockedExecute
          .mockReturnValueOnce(Effect.succeed(newestVersion))
          .mockReturnValueOnce(Effect.succeed(output(diffPage(0, 30))))
          .mockReturnValueOnce(Effect.succeed(newestVersion))
          .mockReturnValueOnce(Effect.succeed(output(diffPage(30, 30))))
          .mockReturnValueOnce(Effect.succeed(newestVersion))
          .mockReturnValueOnce(Effect.succeed(output(diffPage(60, 5))))
          .mockReturnValueOnce(Effect.succeed(newestVersion));
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
        const target = { cwd: "/w", repository: "acme/web", number: 7 };

        let patch = "";
        let cursor: string | undefined;
        do {
          const slice = yield* cli.getMergeRequestDiff({ ...target, cursor });
          patch += slice.patch;
          cursor = slice.nextCursor ?? undefined;
        } while (cursor !== undefined);

        expect(mockedExecute.mock.calls.map(([call]) => call.args[1])).toEqual([
          "projects/acme%2Fweb/merge_requests/7/versions?per_page=1&page=1",
          "projects/acme%2Fweb/merge_requests/7/diffs?per_page=30&page=1",
          "projects/acme%2Fweb/merge_requests/7/versions?per_page=1&page=1",
          "projects/acme%2Fweb/merge_requests/7/diffs?per_page=30&page=2",
          "projects/acme%2Fweb/merge_requests/7/versions?per_page=1&page=1",
          "projects/acme%2Fweb/merge_requests/7/diffs?per_page=30&page=3",
          "projects/acme%2Fweb/merge_requests/7/versions?per_page=1&page=1",
        ]);
        assert.strictEqual(patch.match(/^diff --git /gm)?.length, 65);
        expect(patch).toContain("diff --git a/src/64.ts b/src/64.ts");
      }),
  );

  it.effect("expands a file at the revision its patch was read at, after the author pushes", () =>
    Effect.gen(function* () {
      const versions = [firstPush];
      fakeGitLab({ versions, files: pushedFiles });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      const shown = yield* cli.getMergeRequestDiff(target);
      versions.unshift(secondPush);
      const expanded = yield* cli.getMergeRequestDiffFileContents({
        ...target,
        ...(shown.revision === undefined ? {} : { revision: shown.revision }),
        changeType: "change",
        oldPath: "src/a.ts",
        newPath: "src/a.ts",
      });

      expect(shown.patch).toContain("+two\n");
      expect(shown.patch).not.toContain("+three");
      expect(expanded).toEqual({ oldContents: "one\n", newContents: "one\ntwo\n" });
    }),
  );

  it.effect("reads the patch at the revision it names once the merge request has moved on", () =>
    Effect.gen(function* () {
      const versions = [firstPush];
      fakeGitLab({ versions, files: pushedFiles });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      const shown = yield* cli.getMergeRequestDiff(target);
      versions.unshift(secondPush);
      const again = yield* cli.getMergeRequestDiff({
        ...target,
        ...(shown.revision === undefined ? {} : { revision: shown.revision }),
      });
      const newest = yield* cli.getMergeRequestDiff(target);

      assert.isDefined(shown.revision);
      expect(again).toEqual({ ...shown, nextCursor: null });
      expect(newest.patch).toContain("diff --git a/src/b.ts b/src/b.ts");
      assert.notStrictEqual(newest.revision, shown.revision);
      // Read again after the push, the patch still names its own push's head, never the newest.
      expect([shown.headSha, again.headSha, newest.headSha]).toEqual([
        firstPush.headSha,
        firstPush.headSha,
        secondPush.headSha,
      ]);
    }),
  );

  it.effect("reads an earlier version larger than one diff page may be, as GitLab stores it", () =>
    Effect.gen(function* () {
      // Two thousand files of 4.5 KB: past a diff page's 8 MiB of JSON, and within the 15 MB of
      // patch text GitLab keeps for one version.
      const large: FakeVersion = {
        ...firstPush,
        diffs: Array.from({ length: 2_000 }, (_, index) =>
          changedFile(`src/${index}.ts`, `@@ -1 +1 @@\n-a\n+${"x".repeat(4_500)}\n`),
        ),
      };
      fakeGitLab({ versions: [secondPush, large], files: {} });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const slice = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        revision: "11",
      });

      assert.strictEqual(slice.revision, "11");
      assert.strictEqual(slice.patch.match(/^diff --git /gm)?.length, 2_000);
    }),
  );

  it.effect("names no revision when a push lands while the page is read", () =>
    Effect.gen(function* () {
      const versions = [firstPush];
      fakeGitLab({
        versions,
        files: pushedFiles,
        onDiffPage: () => {
          if (versions[0] === firstPush) versions.unshift(secondPush);
        },
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const slice = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.isUndefined(slice.revision);
      assert.isUndefined(slice.headSha);
    }),
  );

  it.effect("reads every page of a walk at the version its first slice named", () =>
    Effect.gen(function* () {
      fakeGitLab({ versions: [firstLongPush], files: {} });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      const first = yield* cli.getMergeRequestDiff(target);
      const second = yield* cli.getMergeRequestDiff({
        ...target,
        cursor: first.nextCursor ?? undefined,
      });

      expect([first.revision, first.nextCursor]).toEqual(["11", "11:2"]);
      expect([second.revision, second.nextCursor]).toEqual(["11", null]);
      assert.strictEqual(`${first.patch}${second.patch}`.match(/^\+first$/gm)?.length, 45);
    }),
  );

  it.effect("refuses the next page of a walk a push landed in rather than reading the push", () =>
    Effect.gen(function* () {
      const versions = [firstLongPush];
      fakeGitLab({ versions, files: {} });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      const first = yield* cli.getMergeRequestDiff(target);
      versions.unshift(secondLongPush);
      const second = yield* Effect.result(
        cli.getMergeRequestDiff({ ...target, cursor: first.nextCursor ?? undefined }),
      );

      assert.strictEqual(first.revision, "11");
      expect(Result.isSuccess(second) ? second.success : second.failure._tag).toBe(
        "GitLabDiffRevisionMovedError",
      );
    }),
  );

  it.effect("refuses the page a push lands in while it is read", () =>
    Effect.gen(function* () {
      const versions = [firstLongPush];
      fakeGitLab({
        versions,
        files: {},
        onDiffPage: (page) => {
          if (page === 2 && versions[0] === firstLongPush) versions.unshift(secondLongPush);
        },
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      const first = yield* cli.getMergeRequestDiff(target);
      const second = yield* Effect.flip(
        cli.getMergeRequestDiff({ ...target, cursor: first.nextCursor ?? undefined }),
      );

      assert.strictEqual(second._tag, "GitLabDiffRevisionMovedError");
    }),
  );

  it.effect("refuses a pinned cursor it could not have handed out", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };
      const commit = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

      for (const read of [
        { ...target, cursor: "0:2" },
        { ...target, cursor: "11:0" },
        { ...target, cursor: "11:2:3" },
        { ...target, cursor: "11/../8:2" },
        { ...target, commit, cursor: "11:2" },
      ]) {
        const error = yield* Effect.flip(cli.getMergeRequestDiff(read));
        assert.strictEqual(error._tag, "GitLabDiffCursorError");
      }
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("still reads the newest patch, unnamed, when its diff version cannot be read", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      for (const unreadable of [
        cliFailure("not-found"),
        cliFailure("command-failed"),
        Effect.succeed(output("<html>")),
      ]) {
        mockedExecute.mockReset();
        mockedExecute
          .mockReturnValueOnce(unreadable)
          .mockReturnValueOnce(Effect.succeed(output(diffPage(0, 30))));
        const slice = yield* cli.getMergeRequestDiff(target);
        expect([slice.revision, slice.nextCursor]).toEqual([undefined, "2"]);
        assert.strictEqual(slice.patch.match(/^diff --git /gm)?.length, 30);
      }

      mockedExecute.mockReset();
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(newestVersion))
        .mockReturnValueOnce(Effect.succeed(output(diffPage(0, 30))))
        .mockReturnValueOnce(cliFailure("command-failed"));
      const unchecked = yield* cli.getMergeRequestDiff(target);
      expect([unchecked.revision, unchecked.nextCursor]).toEqual([undefined, "2"]);
    }),
  );

  it.effect("fails the read when the CLI cannot read the diff version at all", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(cliFailure("authentication"));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({ cwd: "/w", repository: "acme/web", number: 7 }),
      );

      assert.strictEqual(error._tag, "GitLabCliAuthenticationError");
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("refuses a revision the merge request never had rather than reading another", () =>
    Effect.gen(function* () {
      fakeGitLab({ versions: [secondPush, firstPush], files: pushedFiles });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };
      const expand = (revision: string) =>
        cli.getMergeRequestDiffFileContents({
          ...target,
          revision,
          changeType: "change",
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
        });

      for (const revision of ["99", "11/../../8"]) {
        const diff = yield* Effect.flip(cli.getMergeRequestDiff({ ...target, revision }));
        const file = yield* Effect.flip(expand(revision));
        assert.strictEqual(diff._tag, "GitLabDiffRevisionUnavailableError");
        assert.strictEqual(file._tag, "GitLabDiffRevisionUnavailableError");
      }
      expect(
        mockedExecute.mock.calls.some(([call]) => call.args.some((arg) => arg.includes(".."))),
      ).toBe(false);
    }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a query", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads a named commit from its own diff, and pages inside it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(diffPage(0))))
        .mockReturnValueOnce(Effect.succeed(output(diffPage(100, 3))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const target = {
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      };

      const first = yield* cli.getMergeRequestDiff(target);
      assert.isNotNull(first.nextCursor);
      const second = yield* cli.getMergeRequestDiff({ ...target, cursor: first.nextCursor });

      const commitPath =
        "projects/acme%2Fweb/repository/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/diff";
      expect(argsOfCall(0)[1]).toBe(`${commitPath}?per_page=100&page=1`);
      expect(argsOfCall(1)[1]).toBe(`${commitPath}?per_page=100&page=2`);
      assert.isNull(second.nextCursor);
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a path", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          commit: "../../merge_requests/8/diffs",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffCommitError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reports a commit with no parent as a structured error", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ id: "a1b2c3d", parent_ids: [] }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          commit: "a1b2c3d",
          changeType: "change",
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffCommitParentUnavailableError");
      if (error._tag === "GitLabDiffCommitParentUnavailableError") {
        assert.strictEqual(error.commit, "a1b2c3d");
      }
    }),
  );

  it.effect("expands a new file from a root commit without requiring a parent", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ id: "a1b2c3d", parent_ids: [] }))),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("first contents\n")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const contents = yield* cli.getMergeRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        commit: "a1b2c3d",
        changeType: "new",
        oldPath: "src/first.ts",
        newPath: "src/first.ts",
      });

      expect(contents).toEqual({ oldContents: "", newContents: "first contents\n" });
      expect(argsOfCall(1)[1]).toContain("raw?ref=a1b2c3d");
    }),
  );

  it.effect("reports an oversized diff file with its path and reason", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              diff_refs: {
                base_sha: "a1b2c3d",
                head_sha: "b1c2d3e",
                start_sha: "a1b2c3d",
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("partial", true)));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          changeType: "deleted",
          oldPath: "src/large.ts",
          newPath: "src/large.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffFileContentsUnavailableError");
      if (error._tag === "GitLabDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "src/large.ts");
        assert.strictEqual(error.reason, "oversized");
      }
    }),
  );

  it.effect("reports undecodable diff file contents as binary", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              diff_refs: {
                base_sha: "a1b2c3d",
                head_sha: "b1c2d3e",
                start_sha: "a1b2c3d",
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("binary\uFFFDcontents", false, true)),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          changeType: "deleted",
          oldPath: "assets/logo.png",
          newPath: "assets/logo.png",
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffFileContentsUnavailableError");
      if (error._tag === "GitLabDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "assets/logo.png");
        assert.strictEqual(error.reason, "binary");
      }
    }),
  );

  it.effect("returns valid text containing a literal replacement character", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              diff_refs: {
                base_sha: "a1b2c3d",
                head_sha: "b1c2d3e",
                start_sha: "a1b2c3d",
              },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("before\uFFFDafter")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const contents = yield* cli.getMergeRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        changeType: "deleted",
        oldPath: "docs/encoding.md",
        newPath: "docs/encoding.md",
      });

      assert.strictEqual(contents.oldContents, "before\uFFFDafter");
    }),
  );

  it.effect("ends the diff on a page with no files rather than asking for it again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const diff = yield* cli.getMergeRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        cursor: "4",
      });

      assert.strictEqual(diff.patch, "");
      assert.isNull(diff.nextCursor);
    }),
  );

  it.effect("fails a diff page cut off mid-JSON rather than calling the diff whole", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(newestVersion))
        .mockReturnValueOnce(
          Effect.succeed({ ...output('[{"old_path":"src/x.ts","new_p'), stdoutTruncated: true }),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDiff({ cwd: "/w", repository: "acme/web", number: 7 }),
      );

      assert.strictEqual(error._tag, "GitLabMergeRequestReadError");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("offers no squash when the project does not say it allows one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ merge_method: "merge" }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const capabilities = yield* cli.getProjectMergeCapabilities({
        cwd: "/w",
        repository: "acme/web",
      });

      assert.deepStrictEqual(capabilities, { merge: true, squash: false, rebase: false });
    }),
  );

  it.effect("reads the project's merge settings as its merge capabilities", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ merge_method: "ff", squash_option: "never" }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const capabilities = yield* cli.getProjectMergeCapabilities({
        cwd: "/w",
        repository: "acme/web",
      });

      assert.deepStrictEqual(capabilities, { merge: false, squash: false, rebase: true });
    }),
  );

  it.effect("asks the detail read for the divergence GitLab withholds by default", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"404 Not Found"}')));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* Effect.ignore(
        cli.getMergeRequestDetail({ cwd: "/w", repository: "acme/web", number: 7 }),
      );

      expect(argsOfCall(0)[1]).toBe(
        "projects/acme%2Fweb/merge_requests/7?include_diverged_commits_count=true",
      );
    }),
  );

  it.effect("fails the read when GitLab returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"404 Not Found"}')));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.getMergeRequestDetail({ cwd: "/w", repository: "acme/web", number: 7 }),
      );

      assert.strictEqual(error._tag, "GitLabMergeRequestReadError");
    }),
  );

  it.effect("fails when the authenticated account has no username", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(JSON.stringify({ username: "" }))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(cli.getViewerUsername({ cwd: "/w" }));

      assert.strictEqual(error._tag, "GitLabViewerUnavailableError");
    }),
  );

  it.effect("walks the notes until GitLab answers with a short page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(notes(100, 1))));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(notes(2, 101))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { comments, truncated } = yield* cli.listNotes({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(argsOfCall(0).join(" ")).toContain("page=1");
      expect(argsOfCall(1).join(" ")).toContain("page=2");
      assert.strictEqual(comments.length, 102);
      assert.isFalse(truncated);
    }),
  );

  it.effect("stops the note walk at its bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output(notes(100, 1))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { truncated } = yield* cli.listNotes({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 10);
      assert.isTrue(truncated);
    }),
  );

  it.effect("reads a positioned discussion as a thread anchored to its line", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify([
              {
                id: "abc123",
                notes: [
                  {
                    id: 1,
                    body: "rename this",
                    author: { username: "bilal", avatar_url: "https://avatars/b.png" },
                    created_at: "2026-07-01T00:00:00Z",
                    resolvable: true,
                    resolved: true,
                    position: {
                      position_type: "text",
                      new_path: "src/a.ts",
                      old_path: "src/a.ts",
                      new_line: 12,
                      old_line: null,
                    },
                  },
                  {
                    id: 2,
                    body: "done",
                    author: { username: "julius" },
                    created_at: "2026-07-01T01:00:00Z",
                  },
                ],
              },
              { id: "def456", notes: [{ id: 3, body: "ship it", created_at: "2026-07-01Z" }] },
            ]),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const { threads } = yield* cli.listDiscussions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(threads.length, 1);
      expect(threads[0]).toMatchObject({
        id: "abc123",
        path: "src/a.ts",
        line: 12,
        side: "right",
        isResolved: true,
      });
      assert.strictEqual(threads[0]?.comments.length, 2);
    }),
  );

  it.effect("sends a review as its comments, then its summary, then the verdict", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [
          {
            path: "src/b.ts",
            oldPath: "src/a.ts",
            position: { kind: "deleted", oldLine: 4 },
            body: "why remove?",
          },
        ],
      });

      expect(argsOfCall(0)[1]).toContain("merge_requests/7");
      expect(argsOfCall(1)[1]).toContain("/discussions");
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({
        body: "why remove?",
        position: {
          base_sha: "base",
          head_sha: "head",
          start_sha: "start",
          position_type: "text",
          // A renamed file is the only case the two differ, and GitLab cannot place a
          // position that names the same path on both sides of the rename.
          old_path: "src/a.ts",
          new_path: "src/b.ts",
          old_line: 4,
        },
      });
      expect(argsOfCall(2)[1]).toContain("/notes");
      expect(argsOfCall(3)[1]).toContain("/approve");
    }),
  );

  it.effect("does not ask for diff revisions when a review carries no line comments", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "comment",
        body: "One thought.",
        comments: [],
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(argsOfCall(0)[1]).toContain("/notes");
    }),
  );

  it.effect("resolves a discussion in place rather than posting to it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setDiscussionResolution({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        discussionId: "abc123",
        resolved: true,
      });

      expect(argsOfCall(0)).toContain("--method");
      expect(argsOfCall(0)).toContain("PUT");
      expect(argsOfCall(0)[1]).toContain("/discussions/abc123");
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ resolved: true });
    }),
  );

  it.effect("awards an emoji through a POST naming it, not a body", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        content: "thumbs-up",
        reacted: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(argsOfCall(0)).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7/award_emoji?name=thumbsup",
        "--method",
        "POST",
      ]);
    }),
  );

  it.effect("removes an award by listing them and deleting the reader's own id", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ username: "bilal" }))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify([
              { id: 5, name: "thumbsup", user: { username: "bilal" } },
              { id: 6, name: "thumbsup", user: { username: "julius" } },
            ]),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        content: "thumbs-up",
        reacted: false,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 3);
      expect(argsOfCall(2)).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7/award_emoji/5",
        "--method",
        "DELETE",
      ]);
    }),
  );

  it.effect("takes back the reader's award when it is past GitLab's first page of awards", () =>
    Effect.gen(function* () {
      // Oldest first, as GitLab lists them; the reader's is the 131st of 250.
      const awards = Array.from({ length: 250 }, (_, index) => ({
        id: 1000 + index,
        name: index % 3 === 0 ? "heart" : "thumbsup",
        user: { username: index === 130 ? "bilal" : `user${index}` },
      }));
      // GitLab REST through `glab api`: 20 rows unless `per_page` (at most 100) says otherwise.
      mockedExecute.mockImplementation((input) => {
        const [, path = "", ...rest] = input.args;
        if (path === "user") return Effect.succeed(output(JSON.stringify({ username: "bilal" })));
        const [base = "", search = ""] = path.split("?");
        if (base.endsWith("/award_emoji") && !rest.includes("DELETE")) {
          const params = new URLSearchParams(search);
          const perPage = Math.min(Number(params.get("per_page") ?? "20"), 100);
          const page = Number(params.get("page") ?? "1");
          return Effect.succeed(
            output(JSON.stringify(awards.slice((page - 1) * perPage, page * perPage))),
          );
        }
        return Effect.succeed(output("{}"));
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        content: "thumbs-up",
        reacted: false,
      });

      assert.deepStrictEqual(
        mockedExecute.mock.calls.map(([call]) => call.args.join(" ")),
        [
          "api user",
          "api projects/acme%2Fweb/merge_requests/7/award_emoji?per_page=100&page=1",
          "api projects/acme%2Fweb/merge_requests/7/award_emoji?per_page=100&page=2",
          "api projects/acme%2Fweb/merge_requests/7/award_emoji/1130 --method DELETE",
        ],
      );
    }),
  );

  it.effect("does nothing when the reader has no award of that name to take back", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ username: "bilal" }))),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        content: "thumbs-up",
        reacted: false,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("counts every award and sees the reader's own past GitLab's first hundred", () =>
    Effect.gen(function* () {
      // Oldest first, as GitLab lists them; the reader's is the 131st of 250 on the merge request
      // and the 121st of 150 on its note.
      const mergeRequestAwards = Array.from({ length: 250 }, (_, index) => ({
        id: 1000 + index,
        name: index % 3 === 0 ? "heart" : "thumbsup",
        user: { username: index === 130 ? "bilal" : `user${index}` },
      }));
      const noteAwards = Array.from({ length: 150 }, (_, index) => ({
        id: 5000 + index,
        name: "heart",
        user: { username: index === 120 ? "bilal" : `user${index}` },
      }));
      // GitLab hands a connection over at most a hundred nodes at a time, asked for more or not.
      const connection = (awards: ReadonlyArray<(typeof mergeRequestAwards)[number]>) => ({
        pageInfo: { hasNextPage: awards.length > 100 },
        nodes: awards.slice(0, 100).map(({ name, user }) => ({ name, user })),
      });
      mockedExecute.mockImplementation((input) => {
        const [, path = ""] = input.args;
        if (path === "graphql") {
          return Effect.succeed(
            output(
              JSON.stringify({
                data: {
                  currentUser: { username: "bilal" },
                  project: {
                    mergeRequest: {
                      awardEmoji: connection(mergeRequestAwards),
                      notes: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [{ id: "gid://gitlab/Note/9", awardEmoji: connection(noteAwards) }],
                      },
                    },
                  },
                },
              }),
            ),
          );
        }
        const [base = "", search = ""] = path.split("?");
        const awards = base.endsWith("/merge_requests/7/award_emoji")
          ? mergeRequestAwards
          : base.endsWith("/merge_requests/7/notes/9/award_emoji")
            ? noteAwards
            : null;
        if (awards === null) return Effect.succeed(output("{}"));
        // GitLab REST through `glab api`: 20 rows unless `per_page` (at most 100) says otherwise.
        const params = new URLSearchParams(search);
        const perPage = Math.min(Number(params.get("per_page") ?? "20"), 100);
        const page = Number(params.get("page") ?? "1");
        return Effect.succeed(
          output(JSON.stringify(awards.slice((page - 1) * perPage, page * perPage))),
        );
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const listed = yield* cli.listReactions({ cwd: "/w", repository: "acme/web", number: 7 });

      expect(
        listed.reactions.map(({ content, count, viewerHasReacted }) => ({
          content,
          count,
          viewerHasReacted,
        })),
      ).toEqual([
        { content: "heart", count: 84, viewerHasReacted: false },
        { content: "thumbs-up", count: 166, viewerHasReacted: true },
      ]);
      expect(
        listed.reactionsByNoteId
          .get("9")
          ?.map(({ content, count, viewerHasReacted }) => ({ content, count, viewerHasReacted })),
      ).toEqual([{ content: "heart", count: 150, viewerHasReacted: true }]);
    }),
  );

  it.effect("names a merge request with no diff revisions rather than calling it unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: null,
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* Effect.flip(
        cli.submitReview({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          verdict: "comment",
          body: "",
          comments: [{ path: "src/a.ts", position: { kind: "added", newLine: 4 }, body: "nit" }],
        }),
      );

      assert.strictEqual(error._tag, "GitLabDiffRefsUnavailableError");
    }),
  );

  it.effect("shows a failed child pipeline that left the head pipeline green", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              mergeRequestJson({
                // A fork's pipeline runs in the source project, so its id is not the target's.
                head_pipeline: {
                  id: 31,
                  project_id: 12,
                  status: "success",
                  web_url: "https://gitlab.com/bilal/web/-/pipelines/31",
                },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify([
                {
                  name: "deploy",
                  status: "success",
                  downstream_pipeline: {
                    status: "failed",
                    web_url: "https://gitlab.com/bilal/web/-/pipelines/32",
                  },
                },
                { name: "docs", status: "created", downstream_pipeline: null },
              ]),
            ),
          ),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(detail.checks.map((check) => [check.name, check.status, check.url])).toEqual([
        ["Pipeline", "success", "https://gitlab.com/bilal/web/-/pipelines/31"],
        ["deploy", "failure", "https://gitlab.com/bilal/web/-/pipelines/32"],
      ]);
      expect(argsOfCall(1)[1]).toBe("projects/12/pipelines/31/bridges?per_page=100");
    }),
  );

  it.effect("keeps the one pipeline check when the trigger jobs cannot be read whole", () =>
    Effect.gen(function* () {
      const detailOutput = output(
        mergeRequestJson({ head_pipeline: { id: 31, project_id: 12, status: "success" } }),
      );
      const failedChild = { name: "deploy", downstream_pipeline: { status: "failed" } };
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(detailOutput))
        .mockReturnValueOnce(
          Effect.fail(
            new GitLabCli.GitLabCliCommandError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: new Error("403 Forbidden"),
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(detailOutput))
        // A full page may have left out the trigger job whose pipeline failed.
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify(Array.from({ length: 100 }, () => failedChild)))),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      for (const scenario of ["read fails", "page is full"]) {
        const detail = yield* cli.getMergeRequestDetail({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
        });
        expect(
          detail.checks.map((check) => [check.name, check.status]),
          scenario,
        ).toEqual([["Pipeline", "success"]]);
      }
    }),
  );

  it.effect("reads merge permissions without reading the trigger jobs", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            mergeRequestJson({
              head_pipeline: { id: 31, project_id: 12, status: "success" },
              user: { can_merge: false },
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        downstreamChecks: false,
      });

      expect(detail.viewerCanMerge).toBe(false);
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("reads who has access to the project and who is already on the merge request", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify([author, reviewer, { id: 9, username: "hubot" }]))),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(argsOfCall(1)[1]).toBe("projects/acme%2Fweb/users?per_page=100");
      expect(list.candidates.map((candidate) => [candidate.id, candidate.isRequested])).toEqual([
        ["5", true],
        ["9", false],
      ]);
      assert.isFalse(list.truncated);
    }),
  );

  it.effect("writes the reviewer set back with the one being asked added to it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: true,
      });

      // GitLab replaces the whole set, so the reviewer already on the merge request has to be
      // sent back with the new one or the request would take them off it.
      expect(argsOfCall(1)).toContain("PUT");
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5, 9] });
    }),
  );

  it.effect("takes a reviewer out of the set rather than clearing it", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(mergeRequestJson({ reviewers: [reviewer, { id: 9, username: "hubot" }] })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: false,
      });

      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5] });
    }),
  );

  it.effect("ignores an id GitLab could not have handed out, which names nobody", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ reviewers: [reviewer] }))))
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "octocat" }],
        requested: true,
      });

      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [5] });
    }),
  );

  it.effect("rewrites a title without touching the description", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.updateMergeRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        title: "A better title",
      });

      expect(argsOfCall(0)).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7",
        "--method",
        "PUT",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ title: "A better title" });
    }),
  );

  it.effect("sends a rewritten body as GitLab's description, and nothing else", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.updateMergeRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        description: "What this changes.",
      });

      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ description: "What this changes." });
    }),
  );

  it.effect("rewrites title and description together in one request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.updateMergeRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        title: "A better title",
        description: "What this changes.",
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({
        title: "A better title",
        description: "What this changes.",
      });
    }),
  );

  it.effect("rewrites a note in place through the note it names", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.updateNote({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        noteId: "42",
        body: "true",
      });

      expect(argsOfCall(0)).toEqual([
        "api",
        "projects/acme%2Fweb/merge_requests/7/notes/42",
        "--method",
        "PUT",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      expect(callAt(0).stdin).toBe('{"body":"true"}');
    }),
  );
  it.effect("reads blob ids for the marked paths at the merge request's head", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: {
                project: { repository: { blobs: { nodes: [{ path: "src/a.ts", oid: "aaa" }] } } },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths: ["src/a.ts", "src/gone.ts"],
      });

      expect([...revisions]).toEqual([
        ["src/a.ts", "aaa"],
        ["src/gone.ts", ""],
      ]);
      const body: unknown = JSON.parse(callAt(1).stdin ?? "{}");
      expect(body).toMatchObject({
        variables: { fullPath: "acme/web", ref: "head", paths: ["src/a.ts", "src/gone.ts"] },
      });
    }),
  );

  it.effect("leaves the paths out when GitLab did not answer the blobs query", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify({ data: { project: null } }))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths: ["src/a.ts", "src/b.ts"],
      });

      expect([...revisions]).toEqual([]);
    }),
  );

  it.effect("asks GitLab nothing when no file is marked", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths: [],
      });

      expect([...revisions]).toEqual([]);
      expect(mockedExecute).not.toHaveBeenCalled();
    }),
  );

  it.effect("splits the paths across requests, because GitLab charges the query by how many", () =>
    Effect.gen(function* () {
      const paths = Array.from({ length: 150 }, (_, index) => `src/${index}.ts`);
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockImplementation((request) => {
        const body = JSON.parse(request.stdin ?? "{}") as {
          readonly variables: { readonly paths: ReadonlyArray<string> };
        };
        return Effect.succeed(
          output(
            JSON.stringify({
              data: {
                project: {
                  repository: {
                    blobs: {
                      nodes: body.variables.paths.map((path) => ({ path, oid: `oid-${path}` })),
                    },
                  },
                },
              },
            }),
          ),
        );
      });
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const revisions = yield* cli.getFileRevisions({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        paths,
      });

      assert.strictEqual(revisions.size, 150);
      assert.strictEqual(revisions.get("src/149.ts"), "oid-src/149.ts");
      assert.strictEqual(mockedExecute.mock.calls.length, 3);
    }),
  );

  it.effect(
    "reads line counts a hundred at a time per project, keeping the reads that answered",
    () =>
      Effect.gen(function* () {
        const variablesOf = (stdin: string | undefined) =>
          (
            JSON.parse(stdin ?? "{}") as {
              readonly variables: {
                readonly fullPath: string;
                readonly iids: ReadonlyArray<string>;
              };
            }
          ).variables;
        mockedExecute.mockImplementation((request) => {
          const { fullPath, iids } = variablesOf(request.stdin);
          // GitLab answers only what it has (iid 3 is missing), and one project's read fails.
          const nodes = iids
            .filter((iid) => iid !== "3")
            .map((iid) => ({ iid, diffStatsSummary: { additions: Number(iid), deletions: 1 } }));
          return Effect.succeed(
            output(
              JSON.stringify(
                fullPath === "acme/api"
                  ? { errors: [{ message: "Query timed out" }] }
                  : { data: { project: { mergeRequests: { nodes } } } },
              ),
            ),
          );
        });
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const stats = yield* cli.listMergeRequestStats({
          cwd: "/w",
          changeRequests: [
            ...Array.from({ length: 150 }, (_, index) => ({
              repository: "acme/web",
              number: index + 1,
            })),
            { repository: "acme/api", number: 9 },
          ],
        });

        expect(stats).toHaveLength(149);
        expect(stats).toContainEqual({
          repository: "acme/web",
          number: 150,
          additions: 150,
          deletions: 1,
        });
        expect(stats.some((stat) => stat.number === 3 || stat.repository === "acme/api")).toBe(
          false,
        );
        expect(
          mockedExecute.mock.calls.map(([request]) => {
            const { fullPath, iids } = variablesOf(request.stdin);
            return [fullPath, iids.length];
          }),
        ).toEqual([
          ["acme/web", 100],
          ["acme/web", 50],
          ["acme/api", 1],
        ]);
      }),
  );
  it.effect.each([
    GitLabCli.GitLabCliUnavailableError,
    GitLabCli.GitLabCliAuthenticationError,
    GitLabCli.GitLabCliRateLimitError,
  ])("propagates unusable CLI and account failures from stats (%s)", (ErrorType) =>
    Effect.gen(function* () {
      const error = new ErrorType({
        operation: "execute",
        command: "glab",
        cwd: "/w",
        cause: null,
      });
      mockedExecute.mockReturnValueOnce(Effect.fail(error));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const result = yield* Effect.result(
        cli.listMergeRequestStats({
          cwd: "/w",
          changeRequests: [{ repository: "acme/web", number: 7 }],
        }),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: error });
    }),
  );
});
