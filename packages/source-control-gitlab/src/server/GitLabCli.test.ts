// ), packages/source-control-gitlab/src/server/GitLabCli.test.ts @ 13aa882c22.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError, VcsProcessSpawnError } from "@caveman-app/protocol";

import type * as SourceControlHost from "@caveman-app/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@caveman-app/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(Layer.provide(TestSourceControlHost.layer({ process: { run: mockedRun } }))),
);

function processOutput(stdout: string): SourceControlHost.SourceControlProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

/** The error the server's process runner reports when the real spawner cannot start `glab`. */
const realSpawnFailure = (options: { readonly cwd: string; readonly path?: string }) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cause = yield* Effect.scoped(
      spawner.spawn(
        ChildProcess.make("glab", ["version"], {
          cwd: options.cwd,
          ...(options.path === undefined ? {} : { env: { PATH: options.path } }),
        }),
      ),
    ).pipe(Effect.flip);
    return new VcsProcessSpawnError({
      operation: "GitLabCli.execute",
      command: "glab",
      cwd: options.cwd,
      argumentCount: 1,
      cause,
    });
  }).pipe(Effect.provide(NodeServices.layer));

const withTempDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "gitlab-cli-test-"))),
    use,
    (directory) => Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true })),
  );

layer("GitLabCli.layer", (it) => {
  it.effect("parses merge request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              sha: "a".repeat(40),
              state: "closed",
              closed_at: "2026-08-23T10:00:00Z",
              source_project_id: 101,
              target_project_id: 100,
              source_project: {
                path_with_namespace: "octocat/t3code",
              },
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add MR thread creation",
        url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/mr-threads",
        headSha: "a".repeat(40),
        state: "closed",
        closedAt: "2026-08-23T10:00:00Z",
        mergedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/t3code",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "--output", "json", "--", "42"],
        }),
      );
    }),
  );

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                iid: 0,
                title: "invalid",
                web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/0",
                target_branch: "main",
                source_branch: "feature/invalid",
              },
              {
                iid: 43,
                title: "  Valid MR  ",
                web_url: " https://gitlab.com/pingdotgg/t3code/-/merge_requests/43 ",
                target_branch: " main ",
                source_branch: " feature/mr-list ",
                state: "merged",
                merged_at: "2026-08-23T11:00:00Z",
              },
            ]),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/mr-list",
          state: "all",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid MR",
          url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/43",
          baseRefName: "main",
          headRefName: "feature/mr-list",
          state: "merged",
          closedAt: null,
          mergedAt: "2026-08-23T11:00:00Z",
        },
      ]);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "mr",
            "list",
            "--source-branch",
            "feature/mr-list",
            "--all",
            "--per-page",
            "20",
            "--output",
            "json",
          ],
        }),
      );
    }),
  );

  /** A merge request as `glab mr list` and `glab mr view` print it: projects by id, not path. */
  const glabMergeRequest = (overrides: Record<string, unknown>) => ({
    id: 9001,
    iid: 44,
    project_id: 100,
    title: "Fork MR",
    web_url: "https://gitlab.com/pingdotgg/t3code/-/merge_requests/44",
    target_branch: "main",
    source_branch: "feature/fork",
    sha: "b".repeat(40),
    state: "opened",
    source_project_id: 101,
    target_project_id: 100,
    references: { short: "!44", relative: "!44", full: "pingdotgg/t3code!44" },
    ...overrides,
  });

  const forkProject = JSON.stringify({
    id: 101,
    path: "t3code",
    path_with_namespace: "octocat/t3code",
  });

  it.effect("names the fork a listed merge request comes from, which glab gives only by id", () =>
    Effect.gen(function* () {
      mockedRun.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[0] === "mr"
              ? JSON.stringify([
                  glabMergeRequest({}),
                  glabMergeRequest({ iid: 45, source_project_id: 100 }),
                ])
              : input.args.join(" ") === "api projects/101"
                ? forkProject
                : "{}",
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.listMergeRequests({
        cwd: "/repo-listed",
        headSelector: "feature/fork",
        state: "open",
      });

      assert.deepStrictEqual(
        result.map((mergeRequest) => ({
          number: mergeRequest.number,
          isCrossRepository: mergeRequest.isCrossRepository,
          headRepositoryNameWithOwner: mergeRequest.headRepositoryNameWithOwner,
          headRepositoryOwnerLogin: mergeRequest.headRepositoryOwnerLogin,
        })),
        [
          {
            number: 44,
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/t3code",
            headRepositoryOwnerLogin: "octocat",
          },
          {
            number: 45,
            isCrossRepository: false,
            headRepositoryNameWithOwner: undefined,
            headRepositoryOwnerLogin: undefined,
          },
        ],
      );
    }),
  );

  it.effect("asks for each fork once, however many of its merge requests are listed", () =>
    Effect.gen(function* () {
      mockedRun.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[0] === "mr"
              ? JSON.stringify([glabMergeRequest({}), glabMergeRequest({ iid: 46 })])
              : forkProject,
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.listMergeRequests({
        cwd: "/repo-once",
        headSelector: "feature/fork",
        state: "all",
      });

      assert.deepStrictEqual(
        result.map((mergeRequest) => mergeRequest.headRepositoryNameWithOwner),
        ["octocat/t3code", "octocat/t3code"],
      );
      assert.deepStrictEqual(
        mockedRun.mock.calls.map(([call]) => call.args[0]),
        ["mr", "api"],
      );
    }),
  );

  it.effect("leaves a fork the reader cannot see unnamed rather than failing the list", () =>
    Effect.gen(function* () {
      mockedRun.mockImplementation((input) =>
        input.args[0] === "mr"
          ? Effect.succeed(processOutput(JSON.stringify([glabMergeRequest({})])))
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitLabCli.execute",
                command: "glab",
                cwd: "/repo",
                exitCode: 1,
                detail: "GET 404 Project Not Found",
                failureKind: "not-found",
              }),
            ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const [mergeRequest] = yield* glab.listMergeRequests({
        cwd: "/repo-hidden",
        headSelector: "feature/fork",
        state: "open",
      });

      assert.isDefined(mergeRequest);
      assert.strictEqual(mergeRequest.isCrossRepository, true);
      assert.notProperty(mergeRequest, "headRepositoryNameWithOwner");
      assert.notProperty(mergeRequest, "headRepositoryOwnerLogin");
    }),
  );

  it.effect("fails the list when the fork lookup fails for another reason", () =>
    Effect.gen(function* () {
      mockedRun.mockImplementation((input) =>
        input.args[0] === "mr"
          ? Effect.succeed(processOutput(JSON.stringify([glabMergeRequest({})])))
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitLabCli.execute",
                command: "glab",
                cwd: "/repo",
                exitCode: 1,
                detail: "API rate limit exceeded.",
                failureKind: "rate-limited",
              }),
            ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .listMergeRequests({ cwd: "/repo-throttled", headSelector: "feature/fork", state: "open" })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliRateLimitError");
    }),
  );

  it.effect("names the fork a viewed merge request comes from, which glab gives only by id", () =>
    Effect.gen(function* () {
      mockedRun.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[0] === "mr" ? JSON.stringify(glabMergeRequest({})) : forkProject,
          ),
        ),
      );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.getMergeRequest({ cwd: "/repo-viewed", reference: "44" });

      assert.strictEqual(result.isCrossRepository, true);
      assert.strictEqual(result.headRepositoryNameWithOwner, "octocat/t3code");
      assert.strictEqual(result.headRepositoryOwnerLogin, "octocat");
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({ command: "glab", args: ["api", "projects/101"] }),
      );
    }),
  );

  it.effect("keeps a fork's path between reads rather than asking on every status read", () =>
    Effect.gen(function* () {
      mockedRun.mockImplementation((input) =>
        Effect.succeed(
          processOutput(
            input.args[0] === "mr" ? JSON.stringify([glabMergeRequest({})]) : forkProject,
          ),
        ),
      );
      const glab = yield* GitLabCli.GitLabCli;
      const read = () =>
        glab.listMergeRequests({ cwd: "/repo-kept", headSelector: "feature/fork", state: "open" });

      const first = yield* read();
      const again = yield* read();
      yield* TestClock.adjust("11 minutes");
      const later = yield* read();

      for (const [mergeRequest] of [first, again, later]) {
        assert.strictEqual(mergeRequest?.headRepositoryNameWithOwner, "octocat/t3code");
      }
      assert.deepStrictEqual(
        mockedRun.mock.calls.map(([call]) => call.args[0]),
        ["mr", "api", "mr", "mr", "api"],
      );
    }),
  );

  it.effect("asks for a fork's path again after the lookup failed", () =>
    Effect.gen(function* () {
      let lookups = 0;
      mockedRun.mockImplementation((input) => {
        if (input.args[0] === "mr") {
          return Effect.succeed(processOutput(JSON.stringify([glabMergeRequest({})])));
        }
        lookups += 1;
        return lookups === 1
          ? Effect.fail(
              new VcsProcessExitError({
                operation: "GitLabCli.execute",
                command: "glab",
                cwd: "/repo-retried",
                exitCode: 1,
                detail: "API rate limit exceeded.",
                failureKind: "rate-limited",
              }),
            )
          : Effect.succeed(processOutput(forkProject));
      });
      const glab = yield* GitLabCli.GitLabCli;
      const read = () =>
        glab.listMergeRequests({
          cwd: "/repo-retried",
          headSelector: "feature/fork",
          state: "open",
        });

      const throttled = yield* Effect.flip(read());
      const [mergeRequest] = yield* read();

      assert.strictEqual(throttled._tag, "GitLabCliRateLimitError");
      assert.strictEqual(mergeRequest?.headRepositoryNameWithOwner, "octocat/t3code");
      assert.strictEqual(lookups, 2);
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              path_with_namespace: "octocat/t3code",
              web_url: "https://gitlab.com/octocat/t3code",
              http_url_to_repo: "https://gitlab.com/octocat/t3code.git",
              ssh_url_to_repo: "git@gitlab.com:octocat/t3code.git",
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/t3code",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/t3code",
        url: "https://gitlab.com/octocat/t3code",
        sshUrl: "git@gitlab.com:octocat/t3code.git",
      });
    }),
  );

  it.effect("creates merge requests through the GitLab API without placing the body in argv", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "owner:feature/provider",
        title: "Provider MR",
        bodyFile: "/tmp/t3-mr-body.md",
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/provider",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "title=Provider MR",
            "--field",
            "description=@/tmp/t3-mr-body.md",
          ],
        }),
      );
    }),
  );

  const baseProject = JSON.stringify({
    id: 100,
    path: "proj",
    path_with_namespace: "group/proj",
  });

  it.effect("opens a fork's merge request on the fork, aimed at the base project by its id", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(Effect.succeed(processOutput(baseProject)))
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      // A caller that names the fork only by its owner: that owner's fork keeps the base's path.
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "alice:fix",
        source: { owner: "alice", refName: "fix" },
        title: "Fix",
        bodyFile: "/tmp/body.md",
      });

      assert.deepStrictEqual(
        mockedRun.mock.calls.map(([call]) => call.args),
        [
          ["api", "projects/:fullpath"],
          [
            "api",
            "--method",
            "POST",
            "projects/alice%2Fproj/merge_requests",
            "--raw-field",
            "source_branch=fix",
            "--raw-field",
            "target_branch=main",
            "--field",
            "target_project_id=100",
            "--raw-field",
            "title=Fix",
            "--field",
            "description=@/tmp/body.md",
          ],
        ],
      );
    }),
  );

  it.effect("opens a fork's merge request on the fork's full path when it is known", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(Effect.succeed(processOutput(baseProject)))
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "acme:fix",
        source: { owner: "acme", repository: "acme/forks/proj-renamed", refName: "fix" },
        title: "Fix",
        bodyFile: "/tmp/body.md",
      });

      const create = mockedRun.mock.calls[1]?.[0].args ?? [];
      assert.strictEqual(create[3], "projects/acme%2Fforks%2Fproj-renamed/merge_requests");
      assert.include(create, "target_project_id=100");
    }),
  );

  it.effect("keeps a branch on the base project itself a same-project merge request", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(Effect.succeed(processOutput(baseProject)))
        .mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "Group:fix",
        source: { owner: "Group", refName: "fix" },
        title: "Fix",
        bodyFile: "/tmp/body.md",
      });

      const create = mockedRun.mock.calls[1]?.[0].args ?? [];
      assert.strictEqual(create[3], "projects/:fullpath/merge_requests");
      assert.isFalse(create.some((arg) => arg.startsWith("target_project_id=")));
    }),
  );

  it.effect("opens nothing when the base project cannot be read for a fork's merge request", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput('{"message":"404 Not found"}')));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .createMergeRequest({
          cwd: "/repo",
          baseBranch: "main",
          headSelector: "fix",
          source: { repository: "alice/proj", refName: "fix" },
          target: { repository: "group/proj", refName: "main" },
          title: "Fix",
          bodyFile: "/tmp/body.md",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabRepositoryDecodeError");
      assert.include(error, { operation: "createMergeRequest", repository: "group/proj" });
      assert.deepStrictEqual(
        mockedRun.mock.calls.map(([call]) => call.args),
        [["api", "projects/group%2Fproj"]],
      );
    }),
  );

  it.effect("creates repositories under an explicit namespace", () =>
    Effect.gen(function* () {
      mockedRun

        .mockReturnValueOnce(Effect.succeed(processOutput(JSON.stringify({ id: 1234 }))))
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                path_with_namespace: "octocat/t3code",
                web_url: "https://gitlab.com/octocat/t3code",
                http_url_to_repo: "https://gitlab.com/octocat/t3code.git",
                ssh_url_to_repo: "git@gitlab.com:octocat/t3code.git",
              }),
            ),
          ),
        );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.createRepository({
        cwd: "/repo",
        repository: "octocat/t3code",
        visibility: "public",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/t3code",
        url: "https://gitlab.com/octocat/t3code",
        sshUrl: "git@gitlab.com:octocat/t3code.git",
      });
      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["api", "namespaces/octocat"],
        }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects",
            "--raw-field",
            "path=t3code",
            "--raw-field",
            "name=t3code",
            "--raw-field",
            "visibility=public",
            "--raw-field",
            "namespace_id=1234",
          ],
        }),
      );
    }),
  );

  it.effect("does not pass unsupported force flags when checking out merge requests", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.checkoutMergeRequest({
        cwd: "/repo",
        reference: "42",
        force: true,
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "checkout", "--", "42"],
        }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the merge request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 merge request not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request 4888 was not found"), true);
      assert.strictEqual(error._tag, "GitLabMergeRequestNotFoundError");
      assert.strictEqual(error.command, "glab");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }),
  );

  it.effect("keeps non-merge-request not-found failures generic", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "GET 404 project not found",
        failureKind: "not-found",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "missing/project",
        });
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliCommandError");
      assert.strictEqual(error.cause, cause);
    }),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .execute({ cwd: "/repo", args: ["api", "projects"] })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliRateLimitError");
      assert.strictEqual(error.cause, cause);
    }),
  );

  it.effect("reports glab as missing when the glab executable is not on PATH", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const cause = yield* realSpawnFailure({ cwd: directory, path: directory });
        mockedRun.mockReturnValueOnce(Effect.fail(cause));

        const glab = yield* GitLabCli.GitLabCli;
        const error = yield* glab.execute({ cwd: directory, args: ["version"] }).pipe(Effect.flip);

        assert.strictEqual(error._tag, "GitLabCliUnavailableError");
        assert.strictEqual(error.cause, cause);
      }),
    ),
  );

  it.effect("does not report a removed working directory as a missing glab", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const removedRoot = path.join(directory, "deleted-worktree");
        const cause = yield* realSpawnFailure({ cwd: removedRoot });
        mockedRun.mockReturnValueOnce(Effect.fail(cause));

        const glab = yield* GitLabCli.GitLabCli;
        const error = yield* glab
          .execute({ cwd: removedRoot, args: ["version"] })
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "GitLabCliCommandError");
        assert.strictEqual(error.cause, cause);
      }),
    ),
  );

  it.effect("does not report a spawn the system refused as a missing glab", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessSpawnError({
        operation: "GitLabCli.execute",
        command: "glab",
        cwd: "/repo",
        argumentCount: 1,
        cause: PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "spawn",
          syscall: "spawn glab",
          pathOrDescriptor: "glab version",
          cause: Object.assign(new Error("spawn glab EMFILE"), { code: "EMFILE" }),
        }),
      });
      mockedRun.mockReturnValueOnce(Effect.fail(cause));

      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab.execute({ cwd: "/repo", args: ["version"] }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitLabCliCommandError");
      assert.strictEqual(error.cause, cause);
    }),
  );
});
