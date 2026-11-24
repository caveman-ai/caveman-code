// ), packages/source-control-github/src/server/GitHubSourceControlProvider.test.ts @ ab3a3cd1.
import { SourceControlProviderKind } from "@caveman-app/protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import type * as SourceControlHost from "@caveman-app/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@caveman-app/source-control-testing/TestSourceControlHost";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const processResult = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const processOutput = (
  stdout: string,
  exitCode = 0,
): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const remotesOutput = (...entries: ReadonlyArray<readonly [string, string]>) =>
  entries
    .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join("\n");

const restResponse = (body: unknown, status = 200): GitHubApi.GitHubRestResponse => ({
  status,
  headers: {},
  body: body === undefined ? "" : encodeJson(body),
  truncated: false,
  invalidUtf8: false,
});

const node = (number: number, headRefName: string, owner = "acme") => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  baseRefName: "main",
  headRefName,
  state: "OPEN",
  isCrossRepository: owner !== "acme",
  updatedAt: "2026-01-02T00:00:00Z",
  headRepository: { name: "web", nameWithOwner: `${owner}/web` },
  headRepositoryOwner: { login: owner },
});

/**
 * The provider over a mocked GitHubApi, git driver and process. `remotes` is what
 * `git remote -v` prints; `git` records every driver call.
 */
function harness(input: {
  readonly remotes: string;
  readonly api: Partial<GitHubApi.GitHubApi["Service"]>;
  readonly localBranches?: ReadonlyArray<string>;
  readonly resolved?: string;
  /** Fails the local branch listing, the first git read a checkout makes. */
  readonly gitFailure?: unknown;
  /** Fails every head-branch fetch, after recording it, as a branch that is gone does. */
  readonly headBranchGone?: boolean;
}) {
  const git: Array<readonly [string, unknown]> = [];
  const record =
    <A>(name: string, value: A) =>
    (args: unknown) =>
      Effect.sync(() => {
        git.push([name, args]);
        return value;
      });
  const hostGit: Partial<SourceControlHost.SourceControlHost["Service"]["git"]> = {
    execute: (args) =>
      Effect.sync(() => {
        git.push(["execute", args.args]);
        return processOutput("");
      }),
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    readConfigValue: () => Effect.succeed("git@github.com:acme/web.git"),
    ensureRemote: (args) =>
      Effect.sync(() => {
        git.push(["ensureRemote", args]);
        return args.preferredName;
      }),
    fetchRemoteTrackingBranch: (args) =>
      input.headBranchGone === true
        ? record(
            "fetchRemoteTrackingBranch",
            undefined,
          )(args).pipe(Effect.andThen(Effect.fail(new Error("couldn't find remote ref") as never)))
        : record("fetchRemoteTrackingBranch", undefined)(args),
    setBranchUpstream: (args) => record("setBranchUpstream", undefined)(args),
    createBranch: (args) => record("createBranch", undefined)(args),
    writeConfigValue: (args) => record("writeConfigValue", undefined)(args),
    switchRef: (args) => record("switchRef", { refName: args.refName })(args) as never,
    listLocalBranchNames: () =>
      input.gitFailure === undefined
        ? Effect.succeed([...(input.localBranches ?? [])])
        : Effect.fail(input.gitFailure as never),
    resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
  };
  const host = TestSourceControlHost.layer({
    git: hostGit,
    process: {
      run: (args) =>
        Effect.succeed(
          args.args[0] === "remote"
            ? processOutput(input.remotes)
            : processOutput(input.resolved ?? "", input.resolved ? 0 : 1),
        ),
    },
  });
  const layer = Layer.mergeAll(
    host,
    Layer.mock(GitHubApi.GitHubApi)(input.api),
    NodeServices.layer,
  );
  return { layer, git };
}

/** The provider context for a checkout whose remote is on `host`. */
/** The provider over a mocked GitHubApi, for reads that never touch the checkout. */
const makeProvider = (api: Partial<GitHubApi.GitHubApi["Service"]>) =>
  GitHubSourceControlProvider.make.pipe(Effect.provide(harness({ remotes: "", api }).layer));

const githubContext = (host: string) => ({
  provider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: `https://${host}`,
  },
  remoteName: "origin",
  remoteUrl: `git@${host}:acme/web.git`,
});

describe("GitHubSourceControlProvider repository resolution", () => {
  it.effect("reads the repository gh would pick from the remotes", () => {
    const paths: string[] = [];
    const { layer } = harness({
      remotes: remotesOutput(
        ["origin", "git@github.com:me/web.git"],
        ["upstream", "https://github.com/acme/web.git"],
      ),
      api: {
        rest: (input) =>
          Effect.sync(() => {
            paths.push(`${input.host} ${input.path}`);
            return restResponse({
              full_name: "acme/web",
              html_url: "https://github.com/acme/web",
              ssh_url: "git@github.com:acme/web.git",
              default_branch: "trunk",
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      assert.strictEqual(yield* gh.getDefaultBranch({ cwd: "/repo" }), "trunk");
      assert.deepStrictEqual(paths, ["github.com repos/acme/web"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("names a missing repository rather than a pull request", () => {
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/gone.git"]),
      api: {
        rest: (input) =>
          Effect.fail(
            new GitHubApi.GitHubApiNotFoundError({ host: input.host, operation: input.operation }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const error = yield* gh.getDefaultBranch({ cwd: "/repo" }).pipe(Effect.flip);
      assert.include(error.detail, "Repository not found");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails clearly when no remote is on GitHub", () => {
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@gitlab.com:a/b.git"]),
      api: {},
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const error = yield* gh.getDefaultBranch({ cwd: "/repo" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "SourceControlProviderError");
      assert.include(error.detail, "No GitHub repository");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads clone URLs on the given host before the checkout's", () => {
    const paths: string[] = [];
    const { layer } = harness({
      remotes: remotesOutput(["origin", "https://github.com/acme/web.git"]),
      api: {
        rest: (input) =>
          Effect.sync(() => {
            paths.push(`${input.host} ${input.path}`);
            return restResponse({
              full_name: "acme/web",
              html_url: `https://${input.host}/acme/web`,
              ssh_url: `git@${input.host}:acme/web.git`,
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const cloneUrls = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "acme/web",
        host: "GitHub.Enterprise.test",
      });
      yield* gh.getRepositoryCloneUrls({ cwd: "/repo", repository: "acme/web" });
      assert.strictEqual(cloneUrls.url, "https://github.enterprise.test/acme/web");
      assert.deepStrictEqual(paths, [
        "github.enterprise.test repos/acme/web",
        "github.com repos/acme/web",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["github", "git@github:acme/web.git"],
    ["github.com-scale", "git@github.com-scale:acme/web.git"],
    ["github.com-scale", "ssh://git@github.com-scale:22/acme/web.git"],
  ] as const)("reads an SSH alias on %s through github.com (%s)", ([host, remoteUrl]) => {
    const hosts: string[] = [];
    const { layer } = harness({
      remotes: remotesOutput(["origin", remoteUrl]),
      api: {
        rest: (input) =>
          Effect.sync(() => {
            hosts.push(`${input.host} ${input.path}`);
            return restResponse({
              full_name: "acme/web",
              html_url: "https://github.com/acme/web",
              ssh_url: "git@github.com:acme/web.git",
              default_branch: "main",
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.getDefaultBranch({ cwd: "/repo" });
      yield* gh.getDefaultBranch({
        cwd: "/repo",
        context: { ...githubContext(host), remoteUrl },
      });
      assert.deepStrictEqual(hosts, ["github.com repos/acme/web", "github.com repos/acme/web"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["sole", "upstream", "missing"])(
    "preserves an HTTPS context host with %s remotes",
    (mode) => {
      const paths: string[] = [];
      const remoteUrl = "https://github.com-scale/me/web.git";
      const { layer } = harness({
        remotes:
          mode === "missing"
            ? ""
            : remotesOutput(
                ["origin", remoteUrl],
                ...(mode === "upstream"
                  ? ([["upstream", "https://github.com/acme/web.git"]] as const)
                  : []),
              ),
        api: {
          rest: (input) =>
            Effect.sync(() => {
              paths.push(`${input.host} ${input.path}`);
              return restResponse({
                full_name: "me/web",
                html_url: "https://github.com-scale/me/web",
                ssh_url: "git@github.com-scale:me/web.git",
                default_branch: "trunk",
              });
            }),
        },
      });
      return Effect.gen(function* () {
        const gh = yield* GitHubSourceControlProvider.make;
        assert.strictEqual(
          yield* gh.getDefaultBranch({
            cwd: "/repo",
            context: { ...githubContext("github.com-scale"), remoteUrl },
          }),
          "trunk",
        );
        assert.deepStrictEqual(paths, ["github.com-scale repos/me/web"]);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("GitHubSourceControlProvider change request lookups by head", () => {
  const remotes = remotesOutput(["origin", "git@github.com:acme/web.git"]);

  it.effect("reads a background sweep's staggered heads in one GraphQL document", () => {
    const documents: Array<GitHubApi.GitHubGraphQlInput> = [];
    const { layer } = harness({
      remotes,
      api: {
        graphql: (input) =>
          Effect.sync(() => {
            documents.push(input);
            return encodeJson({
              data: {
                repository: {
                  h0: { nodes: [{ ...node(7, "feature/a"), headRefOid: "a".repeat(40) }] },
                  h1: { nodes: [] },
                },
              },
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const lookup = (headSelector: string) =>
        gh
          .listChangeRequests({
            cwd: "/repo",
            headSelector,
            state: "all",
            limit: 100,
            context: githubContext("github.com"),
          })
          .pipe(Effect.forkChild);
      // Each branch's own git reads come first, so a sweep's lookups arrive spread out.
      const firstLookup = yield* lookup("feature/a");
      yield* TestClock.adjust("200 millis");
      const secondLookup = yield* lookup("feature/b");
      yield* TestClock.adjust("300 millis");
      const first = yield* Fiber.join(firstLookup);
      const second = yield* Fiber.join(secondLookup);
      assert.deepStrictEqual(
        first?.map((pr) => pr.number),
        [7],
      );
      assert.strictEqual(first?.[0]?.headSha, "a".repeat(40));
      assert.deepStrictEqual(second, []);
      assert.strictEqual(documents.length, 1);
      assert.include(documents[0]!.query, "headRefOid");
      assert.deepStrictEqual(documents[0]!.variables, {
        owner: "acme",
        name: "web",
        h0: "feature/a",
        s0: ["OPEN", "CLOSED", "MERGED"],
        h1: "feature/b",
        s1: ["OPEN", "CLOSED", "MERGED"],
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("caps a background document at twenty-five heads", () => {
    const headCounts: Array<number> = [];
    const { layer } = harness({
      remotes,
      api: {
        graphql: (input) =>
          Effect.sync(() => {
            const heads = Object.keys(input.variables ?? {}).filter((key) => /^h\d+$/.test(key));
            headCounts.push(heads.length);
            return encodeJson({
              data: { repository: Object.fromEntries(heads.map((key) => [key, { nodes: [] }])) },
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const lookups = yield* Effect.all(
        Array.from({ length: 26 }, (_, index) =>
          gh.listChangeRequests({
            cwd: "/repo",
            headSelector: `feature/${index}`,
            state: "all",
            limit: 100,
            context: githubContext("github.com"),
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(lookups);
      assert.deepStrictEqual(
        headCounts.toSorted((a, b) => a - b),
        [1, 25],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("matches an owner:branch selector on the head owner", () => {
    const { layer } = harness({
      remotes,
      api: {
        graphql: (input) =>
          Effect.succeed(
            encodeJson({
              data: {
                repository: {
                  h0: {
                    nodes:
                      input.variables?.h0 === "main"
                        ? [node(9, "main", "someone"), node(8, "main", "me"), node(7, "main", "me")]
                        : [],
                  },
                },
              },
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const open = yield* gh
        .listChangeRequests({ cwd: "/repo", headSelector: "me:main", state: "open", limit: 1 })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("50 millis");
      assert.deepStrictEqual(
        (yield* Fiber.join(open)).map((pr) => pr.number),
        [8],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps API failures onto the errors callers handle", () => {
    const { layer } = harness({
      remotes,
      api: {
        graphql: (input) =>
          Effect.fail(
            input.variables?.h0 === "missing"
              ? new GitHubCredentials.GitHubCliMissingError({ host: "github.com" })
              : new GitHubApi.GitHubApiRateLimitError({
                  host: "github.com",
                  operation: "x",
                  retryAt: 123,
                }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const read = (headSelector: string) =>
        gh
          .listChangeRequests({ cwd: "/repo", headSelector, state: "open", limit: 1 })
          .pipe(Effect.flip, Effect.forkChild);
      const missing = yield* read("missing");
      yield* TestClock.adjust("500 millis");
      assert.include((yield* Fiber.join(missing)).detail, "No GitHub credential on the server");
      const limited = yield* read("limited");
      yield* TestClock.adjust("500 millis");
      const error = yield* Fiber.join(limited);
      assert.include(error.detail, "rate limit exceeded");
      assert.propertyVal(error.cause, "retryAt", 123);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubSourceControlProvider.getChangeRequest", () => {
  it.effect("reads a pull request by number, and by URL on its own repository", () => {
    const variables: Array<unknown> = [];
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      api: {
        graphql: (input) =>
          Effect.sync(() => {
            variables.push(input.variables);
            return encodeJson({ data: { repository: { pullRequest: node(42, "feature") } } });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      assert.strictEqual(
        (yield* gh.getChangeRequest({ cwd: "/repo", reference: "#42" })).number,
        42,
      );
      yield* gh.getChangeRequest({
        cwd: "/repo",
        reference: "https://github.com/other/thing/pull/42",
      });
      assert.deepStrictEqual(variables, [
        { owner: "acme", name: "web", number: 42 },
        { owner: "other", name: "thing", number: 42 },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a missing pull request as not found", () => {
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      api: {
        graphql: () => Effect.succeed(encodeJson({ data: { repository: { pullRequest: null } } })),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const error = yield* gh.getChangeRequest({ cwd: "/repo", reference: "7" }).pipe(Effect.flip);
      assert.include(error.detail, "Pull request not found");
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubSourceControlProvider writes", () => {
  it.effect("creates a cross-repository pull request with an owner:branch head", () => {
    const requests: Array<GitHubApi.GitHubRestInput> = [];
    const { layer } = harness({
      remotes: remotesOutput(
        ["origin", "git@github.com:me/web.git"],
        ["upstream", "git@github.com:acme/web.git"],
      ),
      api: {
        rest: (input) =>
          Effect.sync(() => {
            requests.push(input);
            return restResponse({ number: 1 }, 201);
          }),
      },
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bodyFile = yield* fs.makeTempFileScoped({ suffix: ".md" });
      yield* fs.writeFileString(bodyFile, "Body");
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.createChangeRequest({
        cwd: "/repo",
        baseRefName: "main",
        headSelector: "me:feature",
        title: "Title",
        bodyFile,
      });
      assert.strictEqual(requests[0]!.method, "POST");
      assert.strictEqual(requests[0]!.path, "repos/acme/web/pulls");
      // A user's own write, so the background's reserve is not held against it.
      assert.strictEqual(requests[0]!.allowReserve, true);
      assert.deepStrictEqual(requests[0]!.body, {
        base: "main",
        head: "me:feature",
        title: "Title",
        body: "Body",
        maintainer_can_modify: true,
      });
    }).pipe(Effect.provide(Layer.merge(layer, NodeServices.layer)), Effect.scoped);
  });

  it.effect("creates a repository under an organization the viewer is not", () => {
    const requests: Array<string> = [];
    const { layer } = harness({
      remotes: "",
      api: {
        rest: (input) =>
          Effect.sync(() => {
            requests.push(`${input.method ?? "GET"} ${input.path}`);
            return input.path === "user"
              ? restResponse({ login: "me" })
              : restResponse({
                  full_name: "acme/new",
                  html_url: "https://github.com/acme/new",
                  ssh_url: "git@github.com:acme/new.git",
                });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const urls = yield* gh.createRepository({
        cwd: "/repo",
        repository: "acme/new",
        visibility: "private",
      });
      assert.deepStrictEqual(urls, {
        nameWithOwner: "acme/new",
        url: "https://github.com/acme/new",
        sshUrl: "git@github.com:acme/new.git",
      });
      assert.deepStrictEqual(requests, ["GET user", "POST orgs/acme/repos"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("looks up a bare repository name under the signed-in account on that host", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const gh = yield* makeProvider({
        rest: (input) =>
          Effect.sync(() => {
            requests.push(`${input.host} ${input.method ?? "GET"} ${input.path}`);
            return input.path === "user"
              ? restResponse({ login: "me" })
              : restResponse({
                  full_name: "me/notes",
                  html_url: `https://${input.host}/me/notes`,
                  ssh_url: `git@${input.host}:me/notes.git`,
                });
          }),
      });

      const urls = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        context: githubContext("code.example.test"),
        repository: " notes.git ",
      });

      assert.deepStrictEqual(urls, {
        nameWithOwner: "me/notes",
        url: "https://code.example.test/me/notes",
        sshUrl: "git@code.example.test:me/notes.git",
      });
      assert.deepStrictEqual(requests, [
        "code.example.test GET user",
        "code.example.test GET repos/me/notes",
      ]);
      // Malformed names are still refused before any request.
      for (const repository of ["me/", "/notes", "a/b/c/d", "", "two words"]) {
        const error = yield* Effect.flip(gh.getRepositoryCloneUrls({ cwd: "/repo", repository }));
        assert.include(error.message, "Repositories are named owner/name.");
      }
      assert.strictEqual(requests.length, 2);
    });
  });
});

describe("GitHubSourceControlProvider.checkoutChangeRequest", () => {
  const repository = (fullName: string, defaultBranch = "main") =>
    restResponse({
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
      ssh_url: `git@github.com:${fullName}.git`,
      default_branch: defaultBranch,
    });

  it.effect("checks a same-repository pull request out from its head branch", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(5, "feature/x") } } }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.checkoutChangeRequest({ cwd: "/repo", reference: "5" });
      assert.deepStrictEqual(git, [
        [
          "fetchRemoteTrackingBranch",
          { cwd: "/repo", remoteName: "origin", remoteBranch: "feature/x" },
        ],
        [
          "createBranch",
          { cwd: "/repo", branch: "feature/x", startPoint: "refs/remotes/origin/feature/x" },
        ],
        ["switchRef", { cwd: "/repo", refName: "feature/x" }],
        [
          "setBranchUpstream",
          { cwd: "/repo", branch: "feature/x", remoteName: "origin", remoteBranch: "feature/x" },
        ],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a fork checkout when the base's default branch cannot be read", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      localBranches: ["main"],
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(6, "main", "someone") } } }),
          ),
        rest: () =>
          Effect.fail(
            new GitHubApi.GitHubApiRequestError({
              host: "github.com",
              operation: "x",
              cause: "offline",
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* Effect.flip(gh.checkoutChangeRequest({ cwd: "/repo", reference: "6", force: true }));
      // Nothing touched the local branches: `main` must not be reset to the fork's commit.
      assert.deepStrictEqual(git, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("adds a remote for a fork and names a default-branch head after its owner", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      localBranches: ["someone/main"],
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(6, "main", "someone") } } }),
          ),
        rest: (input) =>
          Effect.succeed(repository(input.path === "repos/acme/web" ? "acme/web" : "someone/web")),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.checkoutChangeRequest({ cwd: "/repo", reference: "6", force: true });
      assert.deepStrictEqual(git, [
        [
          "ensureRemote",
          { cwd: "/repo", preferredName: "someone", url: "git@github.com:someone/web.git" },
        ],
        [
          "fetchRemoteTrackingBranch",
          { cwd: "/repo", remoteName: "someone", remoteBranch: "main" },
        ],
        ["switchRef", { cwd: "/repo", refName: "someone/main" }],
        ["execute", ["reset", "--hard", "--quiet", "refs/remotes/someone/main"]],
        [
          "setBranchUpstream",
          { cwd: "/repo", branch: "someone/main", remoteName: "someone", remoteBranch: "main" },
        ],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("checks a pull request URL out from the remote that holds its repository", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(
        ["origin", "git@github.com:me/web.git"],
        ["upstream", "git@github.com:acme/web.git"],
      ),
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(5, "feature/x") } } }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.checkoutChangeRequest({
        cwd: "/repo",
        reference: "https://github.com/acme/web/pull/5",
      });
      assert.deepInclude(git, [
        "fetchRemoteTrackingBranch",
        { cwd: "/repo", remoteName: "upstream", remoteBranch: "feature/x" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "checks a pull request URL out through a remote that reaches GitHub on port 443",
    () => {
      const { layer, git } = harness({
        remotes: remotesOutput(["origin", "ssh://git@ssh.github.com:443/acme/web.git"]),
        api: {
          graphql: () =>
            Effect.succeed(
              encodeJson({ data: { repository: { pullRequest: node(5, "feature/x") } } }),
            ),
        },
      });
      return Effect.gen(function* () {
        const gh = yield* GitHubSourceControlProvider.make;
        yield* gh.checkoutChangeRequest({
          cwd: "/repo",
          reference: "https://github.com/acme/web/pull/5",
        });
        assert.deepInclude(git, [
          "fetchRemoteTrackingBranch",
          { cwd: "/repo", remoteName: "origin", remoteBranch: "feature/x" },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("checks a pull request URL out through an SSH alias that holds its repository", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@work:acme/web.git"]),
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(5, "feature/x") } } }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.checkoutChangeRequest({
        cwd: "/repo",
        reference: "https://github.com/acme/web/pull/5",
      });
      assert.deepInclude(git, [
        "fetchRemoteTrackingBranch",
        { cwd: "/repo", remoteName: "origin", remoteBranch: "feature/x" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a pull request URL from a repository this checkout has no remote for", () => {
    const reads: string[] = [];
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      api: {
        // Each repository answers under its own name: neither was renamed.
        rest: (input) =>
          Effect.sync(() => {
            reads.push(`${input.host} ${input.path}`);
            return repository(input.path.replace(/^repos\//, ""));
          }),
        graphql: (input) =>
          Effect.sync(() => {
            reads.push(`${input.host} ${input.operation}`);
            return encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    ...node(12, "fix-typo"),
                    url: "https://github.com/other/lib/pull/12",
                    headRepository: { name: "lib", nameWithOwner: "other/lib" },
                    headRepositoryOwner: { login: "other" },
                  },
                },
              },
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const result = yield* Effect.result(
        gh.checkoutChangeRequest({
          cwd: "/repo",
          reference: "https://github.com/other/lib/pull/12",
        }),
      );
      // origin is acme/web: neither its fix-typo branch nor its own pull request 12 is fetched.
      // Both repositories are asked for their current names, in case one was renamed.
      assert.deepStrictEqual(git, []);
      assert.deepStrictEqual(reads, [
        "github.com getPullRequest",
        "github.com repos/other/lib",
        "github.com repos/acme/web",
      ]);
      assert.strictEqual(
        Result.isFailure(result) ? result.failure.detail : "checked out",
        "This checkout has no git remote for other/lib, so its pull request cannot be checked out here.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      case: "a remote that still names the repository as it was before a rename",
      remote: "git@github.com:acme/old-web.git",
      url: "https://github.com/acme/web/pull/5",
    },
    {
      case: "a URL that still names the repository as it was before a transfer",
      remote: "git@github.com:acme/web.git",
      url: "https://github.com/old-owner/web/pull/5",
    },
  ])("checks a pull request out through $case", ({ remote, url }) => {
    // GitHub answers under every name the repository had with the one it has now.
    const current: Record<string, string> = {
      "repos/acme/web": "acme/web",
      "repos/acme/old-web": "acme/web",
      "repos/old-owner/web": "acme/web",
    };
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", remote]),
      api: {
        rest: (input) => Effect.succeed(repository(current[input.path]!)),
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(5, "feature/x") } } }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.checkoutChangeRequest({ cwd: "/repo", reference: url });
      assert.deepInclude(git, [
        "fetchRemoteTrackingBranch",
        { cwd: "/repo", remoteName: "origin", remoteBranch: "feature/x" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a pull request URL when no remote's repository is still there", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/gone.git"]),
      api: {
        rest: (input) =>
          input.path === "repos/acme/web"
            ? Effect.succeed(repository("acme/web"))
            : Effect.fail(
                new GitHubApi.GitHubApiNotFoundError({
                  host: input.host,
                  operation: input.operation,
                }),
              ),
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(5, "feature/x") } } }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const result = yield* Effect.result(
        gh.checkoutChangeRequest({ cwd: "/repo", reference: "https://github.com/acme/web/pull/5" }),
      );
      assert.deepStrictEqual(git, []);
      assert.strictEqual(
        Result.isFailure(result) ? result.failure.detail : "checked out",
        "This checkout has no git remote for acme/web, so its pull request cannot be checked out here.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      case: "from the fork's own remote",
      pullRequest: node(5, "feature/x", "me"),
      remoteName: "origin",
      added: [] as ReadonlyArray<readonly [string, unknown]>,
      reads: ["repos/acme/web"],
    },
    {
      case: "from a fork it adds a remote for",
      pullRequest: node(5, "feature/x", "someone"),
      remoteName: "someone",
      added: [
        [
          "ensureRemote",
          { cwd: "/repo", preferredName: "someone", url: "git@github.com:someone/web.git" },
        ] as const,
      ],
      reads: ["repos/acme/web", "repos/someone/web"],
    },
  ])(
    "checks a fork's pull request URL out $case in a clone with no remote for its base",
    ({ pullRequest, remoteName, added, reads }) => {
      const paths: string[] = [];
      const { layer, git } = harness({
        remotes: remotesOutput(["origin", "git@github.com:me/web.git"]),
        api: {
          rest: (input) =>
            Effect.sync(() => {
              paths.push(input.path);
              return repository(input.path.replace(/^repos\//, ""));
            }),
          graphql: () => Effect.succeed(encodeJson({ data: { repository: { pullRequest } } })),
        },
      });
      return Effect.gen(function* () {
        const gh = yield* GitHubSourceControlProvider.make;
        yield* gh.checkoutChangeRequest({
          cwd: "/repo",
          reference: "https://github.com/acme/web/pull/5",
        });
        // The head is the fork's, so acme/web's remote is never needed, nor its names read.
        assert.deepStrictEqual(git, [
          ...added,
          ["fetchRemoteTrackingBranch", { cwd: "/repo", remoteName, remoteBranch: "feature/x" }],
          [
            "createBranch",
            {
              cwd: "/repo",
              branch: "feature/x",
              startPoint: `refs/remotes/${remoteName}/feature/x`,
            },
          ],
          ["switchRef", { cwd: "/repo", refName: "feature/x" }],
          [
            "setBranchUpstream",
            { cwd: "/repo", branch: "feature/x", remoteName, remoteBranch: "feature/x" },
          ],
        ]);
        assert.deepStrictEqual(paths, reads);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    {
      case: "refuses it when no remote holds the base",
      remotes: remotesOutput(["origin", "git@github.com:me/web.git"]),
      fetchedPullRef: [] as ReadonlyArray<readonly [string, unknown]>,
      refusal:
        "This checkout has no git remote for acme/web, so its pull request cannot be checked out here.",
    },
    {
      case: "reads it from the remote that holds the base",
      remotes: remotesOutput(
        ["origin", "git@github.com:me/web.git"],
        ["upstream", "git@github.com:acme/web.git"],
      ),
      fetchedPullRef: [
        [
          "execute",
          ["fetch", "--quiet", "--no-tags", "--", "upstream", "refs/pull/5/head"],
        ] as const,
      ],
      refusal: null,
    },
  ])(
    "with a fork's head branch gone, $case for refs/pull/<n>/head",
    ({ remotes, fetchedPullRef, refusal }) => {
      const { layer, git } = harness({
        remotes,
        headBranchGone: true,
        api: {
          rest: (input) => Effect.succeed(repository(input.path.replace(/^repos\//, ""))),
          graphql: () =>
            Effect.succeed(
              encodeJson({ data: { repository: { pullRequest: node(5, "feature/x", "me") } } }),
            ),
        },
      });
      return Effect.gen(function* () {
        const gh = yield* GitHubSourceControlProvider.make;
        const result = yield* Effect.result(
          gh.checkoutChangeRequest({
            cwd: "/repo",
            reference: "https://github.com/acme/web/pull/5",
          }),
        );
        // origin is me/web: its own refs/pull/5/head is another pull request's code.
        assert.deepStrictEqual(git.slice(0, 1 + fetchedPullRef.length), [
          [
            "fetchRemoteTrackingBranch",
            { cwd: "/repo", remoteName: "origin", remoteBranch: "feature/x" },
          ],
          ...fetchedPullRef,
        ]);
        assert.notDeepInclude(git, [
          "execute",
          ["fetch", "--quiet", "--no-tags", "--", "origin", "refs/pull/5/head"],
        ]);
        assert.strictEqual(Result.isFailure(result) ? result.failure.detail : null, refusal);
        if (refusal !== null) assert.lengthOf(git, 1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    {
      case: "gh repo set-default named for the fork's parent",
      resolved: "remote.origin.gh-resolved acme/web",
      environment: {},
    },
    { case: "GH_REPO", resolved: "", environment: { GH_REPO: "acme/web" } },
  ])(
    "refuses a pull request by number from a base no remote holds, chosen by $case",
    ({ resolved, environment }) => {
      // A fork clone: origin is me/web, and nothing holds acme/web.
      const { layer, git } = harness({
        remotes: remotesOutput(["origin", "git@github.com:me/web.git"]),
        resolved,
        api: {
          rest: (input) => Effect.succeed(repository(input.path.replace(/^repos\//, ""))),
          graphql: () =>
            Effect.succeed(encodeJson({ data: { repository: { pullRequest: node(12, "fix") } } })),
        },
      });
      return Effect.gen(function* () {
        const gh = yield* GitHubSourceControlProvider.make;
        const result = yield* Effect.result(
          gh.checkoutChangeRequest({ cwd: "/repo", reference: "12" }),
        );
        // origin's own fix branch, or its own refs/pull/12/head, is another repository's code.
        assert.deepStrictEqual(git, []);
        assert.strictEqual(
          Result.isFailure(result) ? result.failure.detail : "checked out",
          "This checkout has no git remote for acme/web, so its pull request cannot be checked out here.",
        );
      }).pipe(Effect.provide(layer), Effect.provideService(HostProcess.Environment, environment));
    },
  );

  it.effect("checks a pull request out through the remote its provider was resolved from", () => {
    // An Enterprise remote served over SSH from a host the API does not answer on.
    const remoteUrl = "git@ssh.code.example.test:team/project.git";
    const { layer, git } = harness({
      remotes: remotesOutput(["corp", remoteUrl]),
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    ...node(42, "feature", "team"),
                    isCrossRepository: false,
                    headRepository: { name: "project", nameWithOwner: "team/project" },
                  },
                },
              },
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.checkoutChangeRequest({
        cwd: "/repo",
        reference: "42",
        context: { ...githubContext("code.example.test"), remoteName: "corp", remoteUrl },
      });
      assert.deepInclude(git, [
        "fetchRemoteTrackingBranch",
        { cwd: "/repo", remoteName: "corp", remoteBranch: "feature" },
      ]);
    }).pipe(Effect.provide(layer), Effect.provideService(HostProcess.Environment, {}));
  });

  it.effect("keeps git's own output out of what a failed checkout reports", () => {
    const { layer } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      gitFailure: new Error("fatal: /home/me/secret-path: permission denied"),
      api: {
        graphql: () =>
          Effect.succeed(
            encodeJson({ data: { repository: { pullRequest: node(5, "feature/x") } } }),
          ),
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      const error = yield* gh
        .checkoutChangeRequest({ cwd: "/repo", reference: "5" })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, "The pull request could not be checked out with git.");
      assert.notInclude(error.message, "secret-path");
    }).pipe(Effect.provide(layer));
  });

  it("names the local branch the way gh pr checkout does", () => {
    const name = (headRefName: string, isCrossRepository: boolean) =>
      GitHubSourceControlProvider.pullRequestCheckoutBranchName({
        headRefName,
        headOwner: "someone",
        isCrossRepository,
        defaultBranch: "main",
      });
    assert.strictEqual(name("main", true), "someone/main");
    assert.strictEqual(name("feature", true), "feature");
    assert.strictEqual(name("main", false), "main");
  });
});

it("accepts active authenticated GitHub accounts when another account fails", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
            {
              state: "error",
              active: false,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
              error: "The token in keyring is invalid.",
            },
          ],
        },
      }),
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

it("parses GitHub auth JSON from stdout when stderr has warnings", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
      { stderr: "warning: ignored diagnostic from gh\n" },
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      account: auth.account,
      host: auth.host,
    },
    {
      status: "authenticated",
      account: Option.some("active-user"),
      host: Option.some("github.com"),
    },
  );
});

it("parses GitHub auth status accounts by host and active state", () => {
  assert.deepStrictEqual(
    parseGitHubAuthStatus(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "active-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
            {
              state: "error",
              active: false,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
          "github.example.test": [
            {
              state: "success",
              active: false,
              host: "github.example.test",
              login: "enterprise-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
            },
          ],
        },
      }),
    ).accounts,
    [
      {
        host: "github.com",
        account: "active-user",
        authenticated: true,
        active: true,
        error: null,
        environmentVariable: null,
      },
      {
        host: "github.com",
        account: "stale-user",
        authenticated: false,
        active: false,
        error: null,
        environmentVariable: null,
      },
      {
        host: "github.example.test",
        account: "enterprise-user",
        authenticated: true,
        active: false,
        error: null,
        environmentVariable: null,
      },
    ],
  );
});

it("reports unauthenticated when GitHub JSON has accounts but none are valid", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "error",
              active: true,
              host: "github.com",
              login: "stale-user",
              tokenSource: "keyring",
              gitProtocol: "ssh",
              error: "The token in keyring is invalid.",
            },
          ],
        },
      }),
    ),
  );

  assert.deepStrictEqual(
    {
      status: auth.status,
      host: auth.host,
      detail: auth.detail,
    },
    {
      status: "unauthenticated",
      host: Option.some("github.com"),
      detail: Option.some("The token in keyring is invalid."),
    },
  );
});

it("reports an update hint instead of unauthenticated when gh predates --json", () => {
  const auth = GitHubSourceControlProvider.discovery.parseAuth(
    processResult("", {
      stderr: "unknown flag: --json\n\nUsage:  gh auth status [flags]\n",
      exitCode: ChildProcessSpawner.ExitCode(1),
    }),
  );

  assert.strictEqual(auth.status, "unknown");
  assert.match(
    Option.getOrElse(auth.detail, () => ""),
    /2\.81\.0/,
  );
});

it.effect.each(["pull", "issues"])(
  "resolves %s subjects on the linked host without using the checkout",
  (kind) =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({
        rest: (input) => {
          assert.strictEqual(input.host, "github.com");
          assert.strictEqual(input.path, "repos/owner/repo/issues/42");
          return Effect.succeed(
            restResponse({ title: "Pairing expiry", body: "Preserve remote access", id: 1 }),
          );
        },
      });
      const lookup = provider.resolveLink?.({
        cwd: "/unrelated",
        url: new URL(`https://github.com/owner/repo/${kind}/42`),
      });
      assert.ok(lookup);
      assert.deepStrictEqual(yield* lookup, {
        title: "Pairing expiry",
        body: "Preserve remote access",
      });
      assert.strictEqual(
        provider.resolveLink?.({
          cwd: "/unrelated",
          url: new URL("https://github.com/owner/repo"),
        }),
        undefined,
      );
    }),
);

it.effect.each(["read", "decode"] as const)(
  "retains the %s failure without exposing its raw contents",
  (stage) =>
    Effect.gen(function* () {
      const cause = new GitHubApi.GitHubApiResponseError({
        host: "github.com",
        operation: "resolveLink",
        status: 500,
      });
      const provider = yield* makeProvider({
        rest: () =>
          stage === "read"
            ? Effect.fail(cause)
            : Effect.succeed({ ...restResponse(undefined), body: "private response text" }),
      });
      const lookup = provider.resolveLink?.({
        cwd: "/repo",
        url: new URL("https://github.com/owner/repo/issues/42"),
      });
      assert.ok(lookup);
      const error = yield* Effect.flip(lookup);
      assert.strictEqual(error.operation, stage === "read" ? "resolveLink" : "resolveLink.decode");
      assert.strictEqual(error.detail, "The linked subject could not be read.");
      assert.notInclude(error.message, "private response text");
      if (stage === "read") assert.strictEqual(error.cause, cause);
      else assert.propertyVal(error.cause, "_tag", "SchemaError");
    }),
);

const multiAccountStatus = (extra: ReadonlyArray<Record<string, unknown>> = []) =>
  processResult(
    JSON.stringify({
      hosts: {
        "github.com": [
          { state: "success", active: true, host: "github.com", login: "personal" },
          { state: "success", active: false, host: "github.com", login: "work" },
          ...extra,
        ],
        "ghe.acme.test": [
          { state: "error", active: true, host: "ghe.acme.test", login: "jm", error: "expired" },
        ],
      },
    }),
  );

it("reports every gh login and leads with the account Settings pin", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(multiAccountStatus(), {
    hosts: { "github.com": { account: "work", enabled: true } },
    tokens: {},
  });
  assert.deepStrictEqual(auth.account, Option.some("work"));
  assert.deepStrictEqual(auth.accounts, [
    { host: "github.com", account: "personal", active: true, authenticated: true },
    { host: "github.com", account: "work", active: false, authenticated: true },
    { host: "ghe.acme.test", account: "jm", active: true, authenticated: false, error: "expired" },
  ]);
});

it("falls back to gh's active login when the pinned account is gone", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(multiAccountStatus(), {
    hosts: { "github.com": { account: "former-job", enabled: true } },
    tokens: {},
  });
  assert.deepStrictEqual(auth.account, Option.some("personal"));
});

it("reports unauthenticated when Settings turn off every signed-in host", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(multiAccountStatus(), {
    hosts: { "github.com": { enabled: false } },
    tokens: {},
  });
  assert.strictEqual(auth.status, "unauthenticated");
  assert.deepStrictEqual(
    auth.detail,
    Option.some("Every GitHub host gh is signed in to is turned off in Settings → Source Control."),
  );
});

it("names the environment token that overrides the Settings choice", () => {
  const auth = GitHubSourceControlProvider.parseGitHubAuth(
    multiAccountStatus([
      {
        state: "success",
        active: false,
        host: "github.com",
        login: "bot",
        tokenSource: "GH_TOKEN",
      },
    ]),
    { hosts: { "github.com": { account: "work", enabled: true } }, tokens: {} },
  );
  assert.deepStrictEqual(auth.account, Option.some("bot"));
  assert.deepStrictEqual(
    auth.detail,
    Option.some(
      "Using GH_TOKEN from the server environment; it overrides the account chosen in Settings.",
    ),
  );
  assert.strictEqual(auth.accounts?.[2]?.environmentVariable, "GH_TOKEN");
});

it.live.each([
  "git@code.example.test:team/project.git",
  "ssh://git@code.example.test/team/project.git",
  "https://code.example.test/team/project.git",
])("keeps Enterprise operations on the selected remote: %s", (remoteUrl) => {
  const graphql: GitHubApi.GitHubGraphQlInput[] = [];
  const rest: GitHubApi.GitHubRestInput[] = [];
  const api = {
    graphql: (input: GitHubApi.GitHubGraphQlInput) =>
      Effect.sync(() => {
        graphql.push(input);
        const pr = {
          ...node(42, "feature", "team"),
          url: "https://code.example.test/team/project/pull/42",
          isCrossRepository: false,
          headRepository: { name: "project", nameWithOwner: "team/project" },
        };
        return encodeJson({
          data: {
            repository:
              input.operation === "getPullRequest" ? { pullRequest: pr } : { h0: { nodes: [pr] } },
          },
        });
      }),
    rest: (input: GitHubApi.GitHubRestInput) =>
      Effect.sync(() => {
        rest.push(input);
        return restResponse({
          full_name: "team/project",
          html_url: `https://${input.host}/team/project`,
          ssh_url: `git@${input.host}:team/project.git`,
          default_branch: "main",
        });
      }),
  };
  const { layer, git } = harness({
    remotes: remotesOutput(
      ["origin", "git@github.com:team/project.git"],
      ["enterprise", remoteUrl],
    ),
    api,
  });
  return Effect.gen(function* () {
    const provider = yield* GitHubSourceControlProvider.make;
    const fs = yield* FileSystem.FileSystem;
    const bodyFile = yield* fs.makeTempFileScoped({ suffix: ".md" });
    yield* fs.writeFileString(bodyFile, "Enterprise PR");
    const input = {
      cwd: "/repo",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("github"),
          name: "GitHub Self-Hosted",
          baseUrl: "https://code.example.test",
        },
        remoteName: "enterprise",
        remoteUrl,
      },
    };
    for (const state of ["open", "closed"] as const) {
      const prs = yield* provider.listChangeRequests({
        ...input,
        state,
        headSelector: "feature",
      });
      assert.strictEqual(prs[0]?.url, "https://code.example.test/team/project/pull/42");
    }
    yield* provider.getChangeRequest({ ...input, reference: "42" });
    yield* provider.getChangeRequest({ ...input, reference: "feature" });
    yield* provider.createChangeRequest({
      ...input,
      baseRefName: "main",
      headSelector: "feature",
      title: "PR",
      bodyFile,
    });
    assert.strictEqual(yield* provider.getDefaultBranch(input), "main");
    yield* provider.checkoutChangeRequest({ ...input, reference: "42" });
    yield* provider.getRepositoryCloneUrls({ ...input, repository: "team/other" });
    yield* provider.getRepositoryCloneUrls({ ...input, repository: "github.com/team/explicit" });
    assert.strictEqual(graphql.length, 5);
    for (const request of graphql) {
      assert.strictEqual(request.host, "code.example.test");
      assert.strictEqual(request.variables?.owner, "team");
      assert.strictEqual(request.variables?.name, "project");
    }
    assert.deepStrictEqual(
      rest.map(({ host, path }) => [host, path]),
      [
        ["code.example.test", "repos/team/project/pulls"],
        ["code.example.test", "repos/team/project"],
        ["code.example.test", "repos/team/other"],
        ["github.com", "repos/team/explicit"],
      ],
    );
    assert.deepStrictEqual(git.find(([name]) => name === "createBranch")?.[1], {
      cwd: "/repo",
      branch: "feature",
      startPoint: "refs/remotes/enterprise/feature",
    });
    assert.deepStrictEqual(git.find(([name]) => name === "fetchRemoteTrackingBranch")?.[1], {
      cwd: "/repo",
      remoteName: "enterprise",
      remoteBranch: "feature",
    });
  }).pipe(Effect.provide(layer), Effect.provideService(HostProcess.Environment, {}), Effect.scoped);
});

it.effect.each([
  { host: "github.com", resolved: "", envRepository: "", expected: "acme/web" },
  { host: "code.example.test", resolved: "", envRepository: "", expected: "acme/web" },
  {
    host: "github.com",
    resolved: "remote.origin.gh-resolved base",
    envRepository: "",
    expected: "me/web",
  },
  {
    host: "code.example.test",
    resolved: "remote.origin.gh-resolved base",
    envRepository: "",
    expected: "me/web",
  },
  {
    host: "github.com",
    resolved: "remote.upstream.gh-resolved acme/other",
    envRepository: "",
    expected: "acme/other",
  },
  {
    host: "code.example.test",
    resolved: "remote.upstream.gh-resolved acme/other",
    envRepository: "",
    expected: "acme/other",
  },
  { host: "github.com", resolved: "", envRepository: "chosen/repo", expected: "chosen/repo" },
  {
    host: "code.example.test",
    resolved: "",
    envRepository: "chosen/repo",
    expected: "chosen/repo",
  },
])(
  "preserves repository precedence on $host: $resolved $envRepository",
  ({ host, resolved, envRepository, expected }) => {
    const targets: string[] = [];
    const { layer } = harness({
      remotes: remotesOutput(
        ["origin", `git@${host}:me/web.git`],
        ["upstream", `git@${host}:acme/web.git`],
      ),
      resolved,
      api: {
        rest: (input) =>
          Effect.sync(() => {
            targets.push(`${input.host}/${input.path}`);
            return restResponse({
              full_name: expected,
              html_url: `https://${host}/${expected}`,
              ssh_url: `git@${host}:${expected}.git`,
              default_branch: "main",
            });
          }),
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitHubSourceControlProvider.make;
      const fs = yield* FileSystem.FileSystem;
      const bodyFile = yield* fs.makeTempFileScoped();
      yield* fs.writeFileString(bodyFile, "Body");
      const input = {
        cwd: "/repo",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("github"),
            name: "GitHub",
            baseUrl: `https://${host}`,
          },
          remoteName: "origin",
          remoteUrl: `git@${host}:me/web.git`,
        },
      };
      yield* provider.getDefaultBranch(input);
      yield* provider.createChangeRequest({
        ...input,
        baseRefName: "main",
        headSelector: "me:feature",
        title: "PR",
        bodyFile,
      });
      assert.deepStrictEqual(targets, [
        `${host}/repos/${expected}`,
        `${host}/repos/${expected}/pulls`,
      ]);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Environment, { GH_REPO: envRepository }),
      Effect.scoped,
    );
  },
);
