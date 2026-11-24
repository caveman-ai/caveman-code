import { SourceControlProviderKind } from "@caveman-app/protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as GitHubApi from "@caveman-app/source-control-github/server/GitHubApi";
import * as GitHubSourceControlProvider from "@caveman-app/source-control-github/server/GitHubSourceControlProvider";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The provider over the server's own host and git driver; only GitHub itself is scripted. */
const layer = Layer.mergeAll(
  Layer.mock(GitHubApi.GitHubApi)({
    graphql: () =>
      Effect.succeed(
        encodeJson({
          data: {
            repository: {
              pullRequest: {
                number: 7,
                title: "Big change",
                url: "https://github.com/acme/web/pull/7",
                baseRefName: "main",
                headRefName: "feature/x",
                state: "OPEN",
                isCrossRepository: false,
                updatedAt: "2026-01-02T00:00:00Z",
                headRepository: { name: "web", nameWithOwner: "acme/web" },
                headRepositoryOwner: { login: "acme" },
              },
            },
          },
        }),
      ),
  }),
  ServerSourceControlHost.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
    Layer.provide(VcsProcess.layer),
    Layer.provideMerge(
      GitVcsDriver.layer.pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "github-pr-checkout-test-" }),
        ),
      ),
    ),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/** The remote the runtime resolved the provider from. */
const context = {
  provider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  remoteName: "origin",
  remoteUrl: "git@github.com:acme/web.git",
};

/**
 * A clone whose `feature/x` is the pull request as it was, while its remote holds a newer head
 * that rewrites a.txt, m.slow and z.txt. m.slow's smudge filter holds the fast-forward after
 * a.txt is rewritten, the way an LFS download or a huge tree does, until the test opens the gate.
 */
const behindPullRequest = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "github-pr-checkout-" });
  const remote = pathService.join(root, "remote.git");
  const cwd = pathService.join(root, "work");
  const git = (dir: string, ...args: ReadonlyArray<string>) =>
    driver
      .execute({ operation: "test.git", cwd: dir, args, timeoutMs: 10_000 })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const write = (name: string, text: string) =>
    fileSystem.writeFileString(pathService.join(cwd, name), text);
  yield* git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  yield* git(root, "clone", "--quiet", remote, cwd);
  yield* git(cwd, "config", "user.email", "test@test.com");
  yield* git(cwd, "config", "user.name", "Test");
  yield* git(cwd, "config", "filter.slow.clean", "cat");
  yield* git(cwd, "config", "filter.slow.smudge", "cat");
  yield* write(".gitattributes", "*.slow filter=slow\n");
  for (const name of ["a.txt", "m.slow", "z.txt"]) yield* write(name, "before\n");
  yield* git(cwd, "add", ".");
  yield* git(cwd, "commit", "--quiet", "-m", "main");
  yield* git(cwd, "switch", "--quiet", "-c", "feature/x");
  for (const name of ["a.txt", "m.slow", "z.txt"]) yield* write(name, "after\n");
  yield* git(cwd, "commit", "--quiet", "-am", "pull request");
  const head = yield* git(cwd, "rev-parse", "HEAD");
  yield* git(cwd, "push", "--quiet", "origin", "main", "feature/x");
  yield* git(cwd, "switch", "--quiet", "main");
  yield* git(cwd, "branch", "--quiet", "-f", "feature/x", "main");
  yield* git(
    cwd,
    "config",
    "filter.slow.smudge",
    "touch .git/smudging; while [ ! -f .git/gate ]; do sleep 0.05; done; cat",
  );
  const smudging = Effect.gen(function* () {
    while (!(yield* fileSystem.exists(pathService.join(cwd, ".git/smudging")))) {
      yield* TestClock.withLive(Effect.sleep("20 millis"));
    }
  });
  const openGate = fileSystem.writeFileString(pathService.join(cwd, ".git/gate"), "");
  const state = Effect.all({
    branch: git(cwd, "branch", "--show-current"),
    head: git(cwd, "rev-parse", "HEAD"),
    status: git(cwd, "status", "--porcelain"),
  });
  return { cwd, head, smudging, openGate, state };
});

const checkout = (cwd: string) =>
  GitHubSourceControlProvider.make.pipe(
    Effect.flatMap((provider) => provider.checkoutChangeRequest({ cwd, reference: "7", context })),
    Effect.provideService(HostProcess.Environment, {}),
  );

it.layer(layer)("GitHub pull request checkout on the server's git", (it) => {
  it.effect(
    "finishes a slow fast-forward of an existing pull request branch instead of leaving it half moved",
    () =>
      Effect.gen(function* () {
        const repo = yield* behindPullRequest;

        const moving = yield* checkout(repo.cwd).pipe(Effect.result, Effect.forkScoped);
        yield* repo.smudging;
        yield* TestClock.adjust("10 minutes");
        yield* repo.openGate;
        const checkedOut = yield* Fiber.join(moving);

        assert.deepStrictEqual(
          {
            checkedOut: Result.isSuccess(checkedOut) ? "checked out" : checkedOut.failure.detail,
            ...(yield* repo.state),
          },
          { checkedOut: "checked out", branch: "feature/x", head: repo.head, status: "" },
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "finishes a fast-forward its caller abandons instead of leaving the checkout half moved",
    () =>
      Effect.gen(function* () {
        const repo = yield* behindPullRequest;

        const moving = yield* checkout(repo.cwd).pipe(Effect.forkScoped);
        yield* repo.smudging;
        // As a client that disconnects while its request moves the checkout.
        const interrupting = yield* Fiber.interrupt(moving).pipe(Effect.forkScoped);
        // An interrupt returns once the move has ended; a killed git gets time to die first.
        yield* TestClock.withLive(
          Fiber.await(interrupting).pipe(Effect.timeoutOption("2 seconds")),
        );
        yield* repo.openGate;
        yield* Fiber.join(interrupting);

        const { head, status } = yield* repo.state;
        assert.deepStrictEqual({ head, status }, { head: repo.head, status: "" });
      }).pipe(Effect.scoped),
  );
});
