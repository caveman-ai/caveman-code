// Real git against a local bare repository standing in for GitHub; only the GitHub API is faked.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { VcsProcessExitError } from "@caveman-app/protocol";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as TestSourceControlHost from "@caveman-app/source-control-testing/TestSourceControlHost";

import * as GitHubApi from "./GitHubApi.ts";
import { runGitHubStackAction } from "./githubStackActions.ts";
import { cascadeRebaseStack } from "./githubStackRebase.ts";

/** Kept off the developer's own git config, which may sign commits or rewrite URLs. */
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

const GITHUB_URL = "https://github.com/acme/web.git";

/**
 * main <- #1 (feat/two-steps: two commits on one line) <- #2 (feat/on-top: one commit), then #1
 * squash-merged the way GitHub's "Squash and merge" does it.
 */
function squashMergedStack() {
  const root = mkdtempSync(join(tmpdir(), "stack-rebase-test-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  git(root, "clone", "--quiet", remote, work);
  const write = (text: string) => writeFileSync(join(work, "index.ts"), text);
  write("export const answer = 41;\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "Initial");
  git(work, "switch", "--quiet", "-c", "feat/two-steps");
  write("export const answer = 40;\n");
  git(work, "commit", "--quiet", "-am", "A1");
  write("export const answer = 42;\n");
  git(work, "commit", "--quiet", "-am", "A2");
  const mergedHeadSha = git(work, "rev-parse", "HEAD");
  git(work, "switch", "--quiet", "-c", "feat/on-top");
  write("/** The answer. */\nexport const answer = 42;\n");
  git(work, "commit", "--quiet", "-am", "B");
  git(work, "push", "--quiet", "origin", "main", "feat/two-steps", "feat/on-top");
  git(work, "switch", "--quiet", "main");
  git(work, "merge", "--quiet", "--squash", "feat/two-steps");
  git(work, "commit", "--quiet", "-m", "A (#1)");
  git(work, "push", "--quiet", "origin", "main");
  const bare = (...args: string[]) => git(remote, "--git-dir=.", ...args);
  return {
    work,
    remote,
    mergedHeadSha,
    bare,
    head: (branch: string) => bare("rev-parse", `refs/heads/${branch}`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The host runs real git, with the repository's GitHub URL pointed at the bare repository. */
const realGit = (remote: string) =>
  TestSourceControlHost.layer({
    process: {
      run: (input) =>
        Effect.suspend(() => {
          const args = input.args.map((arg) => (arg === GITHUB_URL ? remote : arg));
          const out = spawnSync(input.command, args, {
            cwd: input.cwd,
            env: { ...gitEnv, ...input.env },
            encoding: "utf8",
          });
          const exitCode = out.status ?? 1;
          if (exitCode !== 0 && input.allowNonZeroExit !== true) {
            return Effect.fail(
              new VcsProcessExitError({
                operation: input.operation,
                command: input.command,
                cwd: input.cwd,
                exitCode,
                detail: out.stderr,
              }),
            );
          }
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(exitCode),
            stdout: out.stdout,
            stderr: out.stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        }),
    },
  });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const githubApi = (stackRead: unknown = null) =>
  Layer.mock(GitHubApi.GitHubApi)({
    credential: () => Effect.succeed({ token: Redacted.make("token"), fingerprint: "fp" }),
    rest: () =>
      Effect.succeed({
        status: 200,
        headers: {},
        body: encodeJson(stackRead),
        truncated: false,
        invalidUtf8: false,
      }),
    graphql: () =>
      Effect.succeed(
        encodeJson({
          data: {
            repository: {
              pr2: { headRepository: { viewerPermission: "WRITE" }, maintainerCanModify: false },
            },
          },
        }),
      ),
  });

it.effect("rebases the layer above a squash-merged pull request onto the base cleanly", () => {
  const repo = squashMergedStack();
  const topHeadSha = repo.head("feat/on-top");
  const stackRead = [
    {
      number: 50,
      url: "https://api.github.com/repos/acme/web/stacks/50",
      base: { ref: "main" },
      pull_requests: [
        {
          number: 1,
          title: "A",
          head: { ref: "feat/two-steps", sha: repo.mergedHeadSha },
          state: "closed",
          merged_at: "2026-11-01T00:00:00Z",
        },
        {
          number: 2,
          title: "B",
          head: { ref: "feat/on-top", sha: topHeadSha },
          state: "open",
          draft: false,
        },
      ],
    },
  ];
  return Effect.gen(function* () {
    yield* runGitHubStackAction({
      cwd: "/repo",
      repository: "acme/web",
      host: "github.com",
      number: 2,
      stackNumber: 50,
      expectedStackHeads: [{ number: 2, headSha: topHeadSha }],
      action: "update-branch",
    });
    const top = repo.head("feat/on-top");
    expect(repo.bare("rev-parse", `${top}~1`)).toBe(repo.head("main"));
    expect(repo.bare("log", "--format=%s", `main..${top}`)).toBe("B");
  }).pipe(
    Effect.provide(Layer.mergeAll(githubApi(stackRead), realGit(repo.remote), NodeServices.layer)),
    Effect.ensuring(Effect.sync(repo.cleanup)),
  );
});

it.effect("keeps to the fork point once the open layer no longer sits on the merged head", () => {
  const repo = squashMergedStack();
  // Someone already moved #2 onto the squash by hand, so the merged layer's head is behind it.
  git(repo.work, "switch", "--quiet", "feat/on-top");
  git(repo.work, "rebase", "--quiet", "--onto", "main", repo.mergedHeadSha);
  git(repo.work, "push", "--quiet", "--force", "origin", "feat/on-top");
  const headSha = repo.head("feat/on-top");
  return Effect.gen(function* () {
    const completed = yield* cascadeRebaseStack({
      host: "github.com",
      repository: "acme/web",
      base: "main",
      layers: [{ number: 2, headBranch: "feat/on-top", headSha }],
      mergedHeadSha: repo.mergedHeadSha,
      remote: repo.remote,
    });
    expect(completed).toBe(1);
    expect(repo.head("feat/on-top")).toBe(headSha);
  }).pipe(
    Effect.provide(Layer.mergeAll(githubApi(), realGit(repo.remote), NodeServices.layer)),
    Effect.ensuring(Effect.sync(repo.cleanup)),
  );
});
