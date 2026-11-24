// ), apps/server/src/pullRequest/PullRequestReviewGuideService.test.ts @ ab3a3cd1.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import {
  ProjectId,
  ProviderInstanceId,
  GitCommandError,
  type PullRequestActivity,
  type PullRequestActor,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestStack,
  type PullRequestRef,
  type ServerProvider,
  TextGenerationError,
  ThreadId,
} from "@caveman-app/protocol";
import type { ReviewGuideGenerationInput } from "@caveman-app/engine-core/server/textGeneration";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestReviewGuides from "../persistence/PullRequestReviewGuides.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as PullRequestReviewGuideService from "./PullRequestReviewGuideService.ts";
import * as PullRequestService from "./PullRequestService.ts";
import { readGuideComment, renderGuideComment } from "./pullRequestReviewGuideComment.ts";

const projectId = ProjectId.make("project-1");
/** The test project is a checkout of the repository its pull requests come from. */
const ACME_APP = {
  canonicalKey: "github.com/acme/app",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/app.git",
  },
  provider: "github",
  displayName: "acme/app",
  owner: "acme",
  name: "app",
};

const reference: PullRequestRef = {
  projectId,
  host: "github.com",
  repository: "acme/app",
  number: 7,
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });

/**
 * A remote whose `main` has moved on past where the change's base branch left it, with the
 * change stacked on that base branch. A guide for the change must see only its own commit.
 */
const makeRepositories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-guide-" });
  const remote = `${root}/remote`;
  const workspace = `${root}/workspace`;
  yield* fs.makeDirectory(remote);
  yield* git(remote, ["init", "--quiet", "--initial-branch=main"]);
  yield* git(remote, ["config", "user.email", "test@example.com"]);
  yield* git(remote, ["config", "user.name", "Test"]);
  const commit = (path: string, message: string, contents = message, body?: string) =>
    fs
      .writeFileString(`${remote}/${path}`, contents)
      .pipe(
        Effect.andThen(git(remote, ["add", path])),
        Effect.andThen(git(remote, ["commit", "--quiet", "-m", message, ...(body === undefined ? [] : ["-m", body])])),
        Effect.andThen(git(remote, ["rev-parse", "HEAD"])),
      );
  // Every test's commits are its own: the tests share one store, and two repositories made alike in the same second
  // would have the same heads, so one test's guide would be another's.
  yield* commit("base.txt", "base", "base", root);
  yield* git(remote, ["checkout", "--quiet", "-b", "stack-base"]);
  const lowerSha = yield* commit("lower.txt", "lower layer");
  yield* git(remote, ["checkout", "--quiet", "-b", "feature"]);
  // Ten lines, so an excerpt reaching past them has something to be clamped to.
  const headSha = yield* commit(
    "feature.txt",
    "the change",
    Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n",
  );
  // A layer above the change, which uses what the change adds.
  yield* git(remote, ["checkout", "--quiet", "-b", "upper"]);
  const upperSha = yield* commit("upper.txt", "upper layer");
  yield* git(remote, ["checkout", "--quiet", "main"]);
  yield* commit("unrelated.txt", "main moved on");
  yield* git(root, ["clone", "--quiet", remote, workspace]);
  return { root, remote, workspace, headSha, lowerSha, upperSha };
});

const detail = (workspaceRoot: string, headSha: string): PullRequestDetail =>
  ({
    number: 7,
    title: "Add the feature",
    body: "Adds the feature.",
    baseBranch: "stack-base",
    headBranch: "feature",
    headSha,
    workspaceRoot,
  }) as PullRequestDetail;

const activity: PullRequestActivity = {
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
};

const DEPENDABOT: PullRequestActor = { login: "dependabot", name: null, avatarUrl: null, isBot: true };

/** The change as the middle layer of three; the top layer's head is not on any fetched branch. */
const stack = (repositories: {
  readonly headSha: string;
  readonly lowerSha: string;
  readonly upperSha: string;
}): PullRequestStack => ({
  id: "stack",
  number: 1,
  url: "https://example.com/stack/1",
  base: "main",
  layers: [
    {
      number: 6,
      title: "Lower",
      headSha: repositories.lowerSha,
      headBranch: "stack-base",
      state: "open",
    },
    {
      number: 7,
      title: "Add the feature",
      headSha: repositories.headSha,
      headBranch: "feature",
      state: "open",
    },
    {
      number: 8,
      title: "Upper",
      headSha: repositories.upperSha.slice(0, 12),
      headBranch: "upper",
      state: "open",
    },
    { number: 9, title: "Unpushed", headSha: "f".repeat(40), headBranch: "gone", state: "open" },
  ],
});

const makeLayer = (input: {
  readonly root: string;
  readonly remote: string;
  readonly workspace: string;
  readonly headSha: string;
  readonly lowerSha: string;
  readonly upperSha: string;
  readonly generate: TextGeneration.TextGeneration["Service"]["generateReviewGuide"];
  /** Completed when a run stores its guide, which is the last thing a run does but forget it. */
  readonly stored: Deferred.Deferred<void>;
  /** The server's beta switch; on unless a test is about it being off. */
  readonly enabled?: boolean;
  /** The head the host reports now, for a test that pushes between runs. */
  readonly currentHead?: Ref.Ref<string>;
  /** The project's own repository; defaults to the one the test reference names. */
  readonly identity?: typeof ACME_APP;
  /** The single-pass budget; 0 (the default here) sends every change to the checkout tier. */
  readonly singlePassDiffBytes?: number | undefined;
  /** The pull request's title, for a test about the template tier. */
  readonly title?: string | undefined;
  /** Who opened the pull request; nobody the host names unless a test is about the template tier. */
  readonly author?: PullRequestActor | undefined;
  /** Whether the writers can read a checkout; they can unless a test is about one that cannot. */
  readonly readsCheckout?: boolean | undefined;
  /** The single-pass budget as the setting gives it, in KB; set, the test budget above is not. */
  readonly singlePassKb?: number | undefined;
  /** A short change's lines; 0 (the default here) writes every change's tour, as the tests before it expect. */
  readonly shortLines?: number | undefined;
  /** The settings a test is about, over the ones above. */
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0] | undefined;
  /** The providers here, for a test that steps a writer up. */
  readonly providers?: ReadonlyArray<ServerProvider> | undefined;
  /** Runs at each activity read, the first thing a claimed run does, for a test that holds a run there. */
  readonly onActivity?: Effect.Effect<void> | undefined;
  /** The host's answers a test is about (the guide comment's conversation and writes), over the ones above. */
  readonly host?: Partial<PullRequestService.PullRequestService["Service"]> | undefined;
}) =>
  PullRequestReviewGuideService.makeLayer(
    input.singlePassKb === undefined ? { singlePassDiffBytes: input.singlePassDiffBytes ?? 0 } : {},
  ).pipe(
    Layer.provide(
      Layer.effect(
        PullRequestReviewGuides.PullRequestReviewGuideRepository,
        Effect.gen(function* () {
          const repository = yield* PullRequestReviewGuides.PullRequestReviewGuideRepository;
          return {
            get: repository.get,
            put: (key, guide) =>
              repository
                .put(key, guide)
                .pipe(Effect.tap(() => Deferred.succeed(input.stored, undefined))),
          } satisfies PullRequestReviewGuides.PullRequestReviewGuideRepository["Service"];
        }),
      ).pipe(Layer.provide(PullRequestReviewGuides.layer)),
    ),
    Layer.provide(
      Layer.succeed(PullRequestService.PullRequestService, {
        detail: () =>
          (input.currentHead === undefined
            ? Effect.succeed(input.headSha)
            : Ref.get(input.currentHead)
          ).pipe(
            Effect.map((head) => ({
              ...detail(input.workspace, head),
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.author === undefined ? {} : { author: input.author }),
            })),
          ),
        activity: () => (input.onActivity ?? Effect.void).pipe(Effect.as(activity)),
        invalidate: () => Effect.void,
        stack: () => Effect.succeed(stack(input)),
        ...input.host,
      } as unknown as PullRequestService.PullRequestService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProjectService.ProjectService, {
        getShell: () =>
          Effect.succeedSome({
            id: projectId,
            workspaceRoot: input.workspace,
            repositoryIdentity: {
              ...(input.identity ?? ACME_APP),
              locator: { ...ACME_APP.locator, remoteUrl: input.remote },
            },
          }),
      } as unknown as ProjectService.ProjectService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed(input.providers ?? []),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
    ),
    Layer.provide(
      Layer.succeed(TextGeneration.TextGeneration, {
        generateReviewGuide: input.generate,
        canReadCheckout: () => Effect.succeed(input.readsCheckout ?? true),
      } as unknown as TextGeneration.TextGeneration["Service"]),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        reviewGuidesEnabled: input.enabled ?? true,
        reviewGuideShortLines: input.shortLines ?? 0,
        ...(input.singlePassKb === undefined ? {} : { reviewGuideSinglePassKb: input.singlePassKb }),
        ...input.settings,
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.root, { prefix: "t3-review-guide-config-" })),
  );

const layerBase = Layer.mergeAll(
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-guide-git-" })),
    Layer.provideMerge(VcsProcess.layer),
  ),
  SqlitePersistence.layerMemory,
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

type Repositories = Effect.Success<typeof makeRepositories>;

const awaitRunFailure = (
  service: PullRequestReviewGuideService.PullRequestReviewGuideService["Service"],
  input: PullRequestRef,
) =>
  service.get(input).pipe(
    Effect.flatMap((result) =>
      result.run?._tag === "Failed"
        ? Effect.succeed(result.run.detail)
        : Effect.fail("still running" as const),
    ),
    Effect.retry(Schedule.spaced("20 millis")),
  );

/** A workspace cloned with only `main`, so the change's head is not there until fetched. */
const startSingleBranchRun = (input: {
  readonly repositoryName: string;
  readonly reportedHead: (repositories: Repositories) => string;
  readonly refuseCommitFetch: boolean;
  readonly prepare: (
    repositories: Repositories,
    workspace: string,
  ) => Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver>;
  /** Runs inside the head branch's fetch, after the service asked for it and before git runs. */
  readonly onBranchFetch?:
    | ((
        repositories: Repositories,
      ) => Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver>)
    | undefined;
}) =>
  Effect.gen(function* () {
    const repositories = yield* makeRepositories;
    const workspace = `${repositories.root}/single-branch`;
    yield* git(repositories.root, [
      "clone",
      "--quiet",
      "--no-local",
      "--single-branch",
      "--branch",
      "main",
      `${repositories.root}/remote`,
      workspace,
    ]);
    yield* input.prepare(repositories, workspace);
    const reportedHead = input.reportedHead(repositories);
    const stored = yield* Deferred.make<void>();
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fetchedRefs: Array<string> = [];
    const observed: Array<{ cwd: string; head: string; changed: string }> = [];
    const onBranchFetch = input.onBranchFetch;
    const observedDriver = {
      ...driver,
      execute: (call: GitVcsDriver.ExecuteGitInput) =>
        Effect.gen(function* () {
          const ref = call.args.at(-1);
          if (call.args[0] !== "fetch" || ref === undefined) return yield* driver.execute(call);
          fetchedRefs.push(ref);
          if (input.refuseCommitFetch && ref === repositories.headSha) {
            return yield* new GitCommandError({
              operation: call.operation,
              command: "git",
              cwd: call.cwd,
              detail: "The test remote refuses fetches by commit.",
              exitCode: 128,
            });
          }
          if (ref === "refs/heads/feature" && onBranchFetch !== undefined) {
            yield* onBranchFetch(repositories).pipe(
              Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
            );
          }
          return yield* driver.execute(call);
        }),
    };
    const readCheckout = (cwd: string, args: ReadonlyArray<string>) =>
      driver
        .execute({ operation: "test.readCheckout", cwd, args })
        .pipe(Effect.map((result) => result.stdout.trim()));
    const context = yield* Layer.build(
      makeLayer({
        ...repositories,
        headSha: reportedHead,
        workspace,
        stored,
        identity: {
          ...ACME_APP,
          canonicalKey: `github.com/acme/${input.repositoryName}`,
          displayName: `acme/${input.repositoryName}`,
          name: input.repositoryName,
        },
        generate: (generation) =>
          Effect.gen(function* () {
            observed.push({
              cwd: generation.cwd,
              head: yield* readCheckout(generation.cwd, ["rev-parse", "HEAD"]),
              changed: yield* readCheckout(generation.cwd, [
                "diff",
                "--name-only",
                `${generation.baseCommit}...HEAD`,
              ]),
            });
            return { stops: [] };
          }).pipe(Effect.orDie),
      }).pipe(Layer.provide(Layer.succeed(GitVcsDriver.GitVcsDriver, observedDriver))),
    );
    const service = Context.get(
      context,
      PullRequestReviewGuideService.PullRequestReviewGuideService,
    );
    const guideReference = { ...reference, repository: `acme/${input.repositoryName}` };
    yield* service.generate(guideReference);
    return {
      repositories,
      reportedHead,
      service,
      reference: guideReference,
      stored,
      fetchedRefs,
      observed,
    };
  });

// Runs drive real git, which the test clock does not advance, so waits use real time.
it.layer(layerBase, { excludeTestServices: true })("PullRequestReviewGuideService", (it) => {
  it.effect.each([
    {
      name: "a short head already fetched",
      shortHash: true,
      prepare: "fetch-feature",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: [],
    },
    {
      name: "a short head on its branch",
      shortHash: true,
      prepare: "none",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: ["refs/heads/feature"],
    },
    {
      name: "a short head whose branch moves during the fetch",
      shortHash: true,
      prepare: "none",
      pushDuringFetch: true,
      refuseCommitFetch: true,
      expectedFetches: ["refs/heads/feature"],
    },
    {
      name: "a full head served by commit",
      shortHash: false,
      prepare: "none",
      pushDuringFetch: false,
      refuseCommitFetch: false,
      expectedFetches: ["<head>"],
    },
    {
      name: "a full head on its branch",
      shortHash: false,
      prepare: "none",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: ["<head>", "refs/heads/feature"],
    },
    {
      name: "a full head only on its pull ref",
      shortHash: false,
      prepare: "refs/pull/7/head",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: ["<head>", "refs/heads/feature", "refs/pull/7/head"],
    },
    {
      name: "a full head only on its merge request ref",
      shortHash: false,
      prepare: "refs/merge-requests/7/head",
      pushDuringFetch: false,
      refuseCommitFetch: true,
      expectedFetches: [
        "<head>",
        "refs/heads/feature",
        "refs/pull/7/head",
        "refs/merge-requests/7/head",
      ],
    },
  ])(
    "writes a guide for the reported commit: $name",
    ({ shortHash, prepare, pushDuringFetch, refuseCommitFetch, expectedFetches }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* startSingleBranchRun({
            repositoryName: "fetched-head",
            reportedHead: (repositories) =>
              shortHash ? repositories.headSha.slice(0, 12) : repositories.headSha,
            refuseCommitFetch,
            prepare: (repositories, workspace) => {
              const remote = `${repositories.root}/remote`;
              if (prepare === "fetch-feature") {
                return git(workspace, ["fetch", "--quiet", "origin", "feature"]).pipe(
                  Effect.asVoid,
                );
              }
              if (prepare === "none") return Effect.void;
              return git(remote, ["update-ref", prepare, repositories.headSha]).pipe(
                Effect.andThen(
                  git(remote, ["update-ref", "refs/heads/feature", repositories.lowerSha]),
                ),
                Effect.asVoid,
              );
            },
            onBranchFetch: pushDuringFetch
              ? (repositories) => {
                  const remote = `${repositories.root}/remote`;
                  return git(remote, ["checkout", "--quiet", "feature"]).pipe(
                    Effect.andThen(
                      git(remote, [
                        "commit",
                        "--quiet",
                        "--allow-empty",
                        "-m",
                        "push during fetch",
                      ]),
                    ),
                    Effect.asVoid,
                  );
                }
              : undefined,
          });
          yield* Effect.raceFirst(
            Deferred.await(run.stored),
            awaitRunFailure(run.service, run.reference).pipe(
              Effect.flatMap((detail) => Effect.die(`run failed: ${detail}`)),
            ),
          );
          const { headSha } = run.repositories;
          const result = yield* run.service.get(run.reference);
          assert.strictEqual(result.guide?.headSha, run.reportedHead);
          assert.deepStrictEqual(result.guide?.stops[0]?.files, [{ path: "feature.txt" }]);
          assert.deepStrictEqual(run.observed, [
            { cwd: run.observed[0]?.cwd, head: headSha, changed: "feature.txt" },
          ]);
          const headRefs = new Set([
            headSha,
            run.reportedHead,
            "refs/heads/feature",
            "refs/pull/7/head",
            "refs/merge-requests/7/head",
          ]);
          assert.deepStrictEqual(
            run.fetchedRefs.filter((ref) => headRefs.has(ref)),
            expectedFetches.map((ref) => (ref === "<head>" ? headSha : ref)),
          );
          const fs = yield* FileSystem.FileSystem;
          assert.isFalse(yield* fs.exists(run.observed[0]?.cwd ?? ""));
        }),
      ),
  );

  it.effect.each([
    {
      name: "a branch named like the short head",
      reportedHead: (repositories: Repositories) => repositories.headSha.slice(0, 12),
      shadow: "branch",
      expected: ["a branch or tag rather than the commit"],
    },
    {
      name: "a tag named like the short head",
      reportedHead: (repositories: Repositories) => repositories.headSha.slice(0, 12),
      shadow: "tag",
      expected: ["a branch or tag rather than the commit"],
    },
    {
      name: "a head that is not a commit hash",
      reportedHead: (repositories: Repositories) =>
        `--upload-pack=touch ${repositories.root}/injected`,
      shadow: "none",
      expected: ["not a commit hash"],
    },
    {
      name: "a head no source has",
      reportedHead: () => "e".repeat(40),
      shadow: "none",
      expected: [
        "local objects:",
        "the commit:",
        "branch feature:",
        "refs/pull/7/head:",
        "refs/merge-requests/7/head:",
      ],
    },
  ])("refuses to write a guide for $name", ({ reportedHead, shadow, expected }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const run = yield* startSingleBranchRun({
          repositoryName: "refused-head",
          reportedHead,
          refuseCommitFetch: false,
          prepare: (repositories, workspace) =>
            git(workspace, ["fetch", "--quiet", "origin", "feature"]).pipe(
              Effect.andThen(
                shadow === "none"
                  ? Effect.void
                  : git(workspace, [shadow, repositories.headSha.slice(0, 12), "HEAD"]),
              ),
              Effect.asVoid,
            ),
        });
        const detail = yield* Effect.raceFirst(
          awaitRunFailure(run.service, run.reference),
          Deferred.await(run.stored).pipe(Effect.andThen(Effect.die("a guide was written"))),
        );
        for (const part of expected) assert.include(detail, part);
        assert.deepStrictEqual(run.observed, []);
        assert.isFalse(run.fetchedRefs.some((ref) => ref.startsWith("-")));
        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(`${run.repositories.root}/injected`));
      }),
    ),
  );

  it.effect("briefs the change against its own base in a checkout it then removes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const seen = yield* Deferred.make<{
          readonly input: ReviewGuideGenerationInput;
          readonly changed: string;
          readonly head: string;
          readonly upper: string;
        }>();
        const finish = yield* Deferred.make<void>();
        // The fake model reads the checkout with the same driver, captured so it needs nothing.
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const readCheckout = (cwd: string, args: ReadonlyArray<string>) =>
          git(cwd, args).pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
            Effect.orDie,
          );
        const stored = yield* Deferred.make<void>();

        // Built in this test's scope: runs are forked into the service's scope and must outlive
        // the call that obtains the service.
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            generate: (input) =>
              Effect.gen(function* () {
                const changed = yield* readCheckout(input.cwd, [
                  "diff",
                  "--name-only",
                  `${input.baseCommit}...HEAD`,
                ]);
                const head = yield* readCheckout(input.cwd, ["rev-parse", "HEAD"]);
                // Another layer's head is readable from the checkout, to check a seam.
                const upper = yield* readCheckout(input.cwd, [
                  "show",
                  `${repositories.upperSha}:upper.txt`,
                ]);
                yield* Deferred.succeed(seen, { input, changed, head, upper });
                yield* Deferred.await(finish);
                // Written the way a model gets it wrong: an excerpt past the end of the file, a
                // note outside what is left of it, and a changed file left off the tour.
                return {
                  stops: [
                    {
                      title: "The feature",
                      summary: "The change.",
                      attention: null,
                      excerpts: [
                        { path: "feature.txt", side: "new", start: 4, end: 40, caption: "" },
                      ],
                      files: [],
                      notes: [
                        { path: "feature.txt", line: 5, title: "Kept", body: "Inside." },
                        { path: "feature.txt", line: 30, title: "Dropped", body: "Outside." },
                      ],
                      questions: [],
                    },
                  ],
                };
              }),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );

        // Generate returns while the run is still reading the change.
        const started = yield* service.generate(reference);
        assert.strictEqual(started.run?._tag, "Running");
        assert.strictEqual(started.guide, null);
        assert.isTrue(started.started);

        // A run that fails before reaching the model reports why rather than leaving this waiting.
        const failedRun = service.get(reference).pipe(
          Effect.flatMap((result) =>
            result.run?._tag === "Failed"
              ? Effect.die(`run failed: ${result.run.detail}`)
              : Effect.fail("still running" as const),
          ),
          Effect.retry(Schedule.spaced("20 millis")),
        );
        const observed = yield* Effect.raceFirst(Deferred.await(seen), failedRun);
        assert.strictEqual(observed.head, repositories.headSha);
        assert.strictEqual(observed.changed, "feature.txt");
        assert.strictEqual(observed.input.baseBranch, "stack-base");
        // The stack comes along, bottom first; a layer whose head could not be fetched is named
        // without one.
        assert.deepStrictEqual(observed.input.stack, [
          { number: 6, title: "Lower", state: "open", headSha: repositories.lowerSha },
          { number: 7, title: "Add the feature", state: "open", headSha: repositories.headSha },
          { number: 8, title: "Upper", state: "open", headSha: repositories.upperSha },
          { number: 9, title: "Unpushed", state: "open", headSha: null },
        ]);
        assert.strictEqual(observed.upper, "upper layer");

        // A second press while running joins the run instead of starting another.
        const joined = yield* service.generate(reference);
        assert.strictEqual(joined.run, started.run);
        assert.isFalse(joined.started);

        yield* Deferred.succeed(finish, undefined);
        yield* Deferred.await(stored);
        const finished = yield* service.get(reference);
        assert.strictEqual(finished.guide?.headSha, repositories.headSha);
        const guide = finished.guide;
        assert.isNotNull(guide);
        const [story] = guide.stops;
        assert.deepStrictEqual(story?.excerpts, [
          { path: "feature.txt", side: "new", start: 4, end: 10, caption: "" },
        ]);
        assert.deepStrictEqual(
          story?.notes.map((note) => note.title),
          ["Kept"],
        );
        // lower.txt is below the change's base, so it is neither in the change nor on the tour.
        assert.strictEqual(guide.stops.length, 1);

        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(observed.input.cwd));
        const worktrees = yield* git(repositories.workspace, ["worktree", "list", "--porcelain"]);
        assert.notInclude(worktrees, observed.input.cwd);
      }),
    ),
  );

  it.effect("measures only the PR change using the renamed verified remote's fetch URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const fork = `${repositories.root}/fork`;
        yield* git(repositories.root, ["clone", "--quiet", repositories.remote, fork]);
        yield* git(fork, ["branch", "stack-base", "main~1"]);
        // The cached identity still names origin, which now belongs to the stale fork.
        yield* git(repositories.workspace, ["remote", "rename", "origin", "upstream"]);
        yield* git(repositories.workspace, ["remote", "add", "origin", fork]);
        yield* git(repositories.workspace, [
          "config",
          `url.${repositories.remote}.insteadOf`,
          "review-upstream:",
        ]);
        yield* git(repositories.workspace, ["remote", "set-url", "upstream", "review-upstream:"]);
        const changed = yield* Deferred.make<string>();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const stored = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            generate: (input) =>
              git(input.cwd, ["diff", "--name-only", `${input.baseCommit}...HEAD`]).pipe(
                Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
                Effect.orDie,
                Effect.flatMap((names) => Deferred.succeed(changed, names)),
                Effect.as({ stops: [] }),
              ),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        yield* service.generate(reference);
        assert.strictEqual(yield* Deferred.await(changed), "feature.txt");
        yield* Deferred.await(stored);
        const result = yield* service.get(reference);
        assert.strictEqual(result.guide?.headSha, repositories.headSha);
        assert.deepStrictEqual(result.guide?.stops[0]?.files, [{ path: "feature.txt" }]);
      }),
    ),
  );

  it.effect("keeps excerpts despite the checkout's diff driver and a failing hook", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${repositories.workspace}/.git/info/attributes`,
          "feature.txt diff=blank\n",
        );
        yield* git(repositories.workspace, ["config", "diff.blank.textconv", "true"]);
        const hook = `${repositories.workspace}/.git/hooks/post-checkout`;
        yield* fs.writeFileString(hook, "#!/bin/sh\nexit 1\n");
        yield* fs.chmod(hook, 0o755);
        const stored = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            generate: () =>
              Effect.succeed({
                stops: [
                  {
                    title: "The feature",
                    summary: "The change.",
                    attention: null,
                    excerpts: [{ path: "feature.txt", side: "new", start: 1, end: 3, caption: "" }],
                    files: [],
                    notes: [],
                    questions: [],
                  },
                ],
              }),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        yield* service.generate(reference);
        // A run the hook broke reports why rather than leaving this waiting.
        yield* Effect.raceFirst(
          Deferred.await(stored),
          service.get(reference).pipe(
            Effect.flatMap((result) =>
              result.run?._tag === "Failed"
                ? Effect.die(`run failed: ${result.run.detail}`)
                : Effect.fail("still running" as const),
            ),
            Effect.retry(Schedule.spaced("20 millis")),
          ),
        );
        const result = yield* service.get(reference);
        assert.deepStrictEqual(result.guide?.stops[0]?.excerpts, [
          { path: "feature.txt", side: "new", start: 1, end: 3, caption: "" },
        ]);
      }),
    ),
  );

  it.effect("refuses generation when the verified remote disappeared despite a usable origin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const fork = `${repositories.root}/fork`;
        yield* git(repositories.root, ["clone", "--quiet", repositories.remote, fork]);
        yield* git(fork, ["branch", "stack-base", repositories.lowerSha]);
        yield* git(repositories.workspace, ["remote", "set-url", "origin", fork]);
        const started = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        const stored = yield* Deferred.make<void>();
        const generated = yield* Ref.make(false);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            generate: () => Ref.set(generated, true).pipe(Effect.as({ stops: [] })),
          }).pipe(
            Layer.provide(
              Layer.succeed(GitVcsDriver.GitVcsDriver, {
                ...driver,
                execute: (call) =>
                  Effect.withFiber((fiber) =>
                    Deferred.succeed(started, fiber).pipe(Effect.andThen(driver.execute(call))),
                  ),
              }),
            ),
          ),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        const before = yield* service.get(reference);
        yield* service.generate(reference);
        // Join the background run so its failure is visible without polling service state.
        yield* Fiber.await(yield* Deferred.await(started));
        const result = yield* service.get(reference);
        assert.strictEqual(result.run?._tag, "Failed");
        assert.include(
          result.run?._tag === "Failed" ? result.run.detail : "",
          "no longer has a remote for the pull request's repository",
        );
        assert.deepStrictEqual(result.guide, before.guide);
        assert.isFalse(yield* Deferred.isDone(stored));
        assert.isFalse(yield* Ref.get(generated));
      }),
    ),
  );

  it.effect("refuses to write a guide while the server has review guides off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const stored = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            enabled: false,
            generate: () => Effect.die("a guide must not be written while the beta is off"),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        const result = yield* Effect.flip(service.generate(reference));
        assert.include(result.message, "Review guides are off");
      }),
    ),
  );

  it.effect(
    "keeps a newer run's guide when an older run for the same pull request finishes late",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repositories = yield* makeRepositories;
          const stored = yield* Deferred.make<void>();
          const currentHead = yield* Ref.make(repositories.headSha);
          // The old run waits on this; the new one answers at once.
          const releaseOld = yield* Deferred.make<void>();
          const oldStarted = yield* Deferred.make<void>();
          const answer = (title: string) => ({
            stops: [
              {
                title,
                summary: "",
                attention: null,
                excerpts: [],
                files: [],
                notes: [],
                questions: [],
              },
            ],
          });
          const context = yield* Layer.build(
            makeLayer({
              ...repositories,
              stored,
              currentHead,
              generate: (input) =>
                input.cwd.length > 0 && input.baseCommit.length > 0
                  ? Ref.get(currentHead).pipe(
                      Effect.flatMap((head) =>
                        head === repositories.headSha
                          ? Deferred.succeed(oldStarted, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseOld)),
                              Effect.as(answer("old head")),
                            )
                          : Effect.succeed(answer("new head")),
                      ),
                    )
                  : Effect.die("unreachable"),
            }),
          );
          const service = Context.get(
            context,
            PullRequestReviewGuideService.PullRequestReviewGuideService,
          );

          yield* service.generate(reference);
          const firstFailed = service.get(reference).pipe(
            Effect.flatMap((result) =>
              result.run?._tag === "Failed"
                ? Effect.die(`first run failed: ${result.run.detail}`)
                : Effect.fail("still running" as const),
            ),
            Effect.retry(Schedule.spaced("20 millis")),
          );
          yield* Effect.raceFirst(Deferred.await(oldStarted), firstFailed);
          // A push: the host reports the upper layer's commit as the head now, and a new run starts.
          yield* Ref.set(currentHead, repositories.upperSha);
          const second = yield* service.generate(reference);
          assert.strictEqual(second.run?._tag, "Running");
          assert.strictEqual(second.run?.headSha, repositories.upperSha);
          // A run that fails reports why rather than leaving this waiting.
          const failedRun = service.get(reference).pipe(
            Effect.flatMap((result) =>
              result.run?._tag === "Failed"
                ? Effect.die(`run failed: ${result.run.detail}`)
                : Effect.fail("still running" as const),
            ),
            Effect.retry(Schedule.spaced("20 millis")),
          );
          yield* Effect.raceFirst(Deferred.await(stored), failedRun);

          // The old run finishes last. Its guide is for a head nobody is looking at any more.
          yield* Deferred.succeed(releaseOld, undefined);
          const settled = yield* service.get(reference).pipe(
            Effect.filterOrFail(
              (result) => result.run === null,
              () => "still running" as const,
            ),
            Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }),
          );
          assert.strictEqual(settled.guide?.headSha, repositories.upperSha);
          // Give the late run every chance to write over the newer guide; it must not.
          yield* Effect.sleep("200 millis");
          const after = yield* service.get(reference);
          assert.isNull(after.run);
          assert.strictEqual(after.guide?.headSha, repositories.upperSha);
          assert.strictEqual(after.guide?.stops[0]?.title, "new head");
        }),
      ),
  );

  it.effect("refuses a pull request from a repository the project is not a checkout of", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const stored = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          makeLayer({
            ...repositories,
            stored,
            identity: {
              ...ACME_APP,
              canonicalKey: "github.com/acme/other",
              displayName: "acme/other",
              name: "other",
            },
            generate: () =>
              Effect.die("a guide must not be written from another repository's checkout"),
          }),
        );
        const service = Context.get(
          context,
          PullRequestReviewGuideService.PullRequestReviewGuideService,
        );
        const result = yield* Effect.flip(service.generate(reference));
        assert.include(result.message, "in another repository");
      }),
    ),
  );

  /** A guide that passes the check: one stop on feature.txt with before/after/why. */
  const shapedGuide = (summary: string) => ({
    tldr: "Adds the feature.",
    overview: "what: adds the feature\nwhy: needed",
    beforeAfter: { title: "Feature", rows: [{ op: "+" as const, depth: 0, text: "feature" }] },
    stops: [
      {
        title: "Feature lands",
        summary,
        attention: null,
        excerpts: [{ path: "feature.txt", side: "new" as const, start: 1, end: 5, caption: "" }],
        files: [],
        notes: [],
        questions: [],
      },
    ],
  });

  const runToStored = (input: {
    readonly repositories: Repositories;
    readonly singlePassDiffBytes?: number;
    readonly title?: string;
    readonly author?: PullRequestActor;
    readonly generate: TextGeneration.TextGeneration["Service"]["generateReviewGuide"];
    readonly shortLines?: number;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly providers?: ReadonlyArray<ServerProvider>;
    /** Its own pull request, for a test that runs more than one. */
    readonly reference?: PullRequestRef;
    readonly full?: boolean;
  }) =>
    Effect.gen(function* () {
      const stored = yield* Deferred.make<void>();
      const ref = input.reference ?? reference;
      const context = yield* Layer.build(
        makeLayer({
          ...input.repositories,
          stored,
          singlePassDiffBytes: input.singlePassDiffBytes,
          title: input.title,
          author: input.author,
          generate: input.generate,
          shortLines: input.shortLines,
          settings: input.settings,
          providers: input.providers,
        }),
      );
      const service = Context.get(context, PullRequestReviewGuideService.PullRequestReviewGuideService);
      yield* service.generate(ref, { full: input.full === true });
      const failed = awaitRunFailure(service, ref).pipe(
        Effect.flatMap((detail) => Effect.die(`run failed: ${detail}`)),
      );
      yield* Effect.raceFirst(Deferred.await(stored), failed);
      return (yield* service.get(ref)).guide!;
    });

  it.effect("writes a small change in one pass over the diff, with no checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const calls: Array<ReviewGuideGenerationInput> = [];
        const guide = yield* runToStored({
          repositories,
          singlePassDiffBytes: 48 * 1024,
          generate: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return shapedGuide("before: no feature\nafter: feature.txt\nwhy: users asked");
            }),
        });
        assert.strictEqual(calls.length, 1);
        const [call] = calls;
        assert.strictEqual(call?.cwd, repositories.workspace);
        assert.include(call?.diff ?? "", "+++ b/feature.txt");
        assert.include(call?.changeMap ?? "", "code feature.txt +10 -0");
        assert.deepStrictEqual(guide.writer, { tier: "single-pass" });
        assert.strictEqual(guide.tldr, "Adds the feature.");
        const worktrees = yield* git(repositories.workspace, ["worktree", "list", "--porcelain"]);
        // Only the workspace itself: no checkout was added.
        assert.strictEqual(worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
      }),
    ),
  );

  it.effect("escalates a single pass that misses the check to the checkout, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const calls: Array<ReviewGuideGenerationInput> = [];
        const guide = yield* runToStored({
          repositories,
          singlePassDiffBytes: 48 * 1024,
          generate: (input) =>
            Effect.sync(() => {
              calls.push(input);
              // The single pass writes prose summaries; the checkout run writes the shape.
              return input.diff !== undefined
                ? shapedGuide("It adds a feature.")
                : shapedGuide("before: none\nafter: feature\nwhy: asked");
            }),
        });
        assert.strictEqual(calls.length, 2);
        assert.isDefined(calls[0]?.diff);
        assert.isUndefined(calls[1]?.diff);
        assert.notStrictEqual(calls[1]?.cwd, repositories.workspace);
        assert.include(calls[1]?.changeMap ?? "", "feature.txt");
        assert.deepStrictEqual(calls[1]?.modelSelection, calls[0]?.modelSelection);
        assert.deepStrictEqual(guide.writer, { tier: "checkout" });
      }),
    ),
  );

  it.effect("writes a dependency bump from a template, with no model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const guide = yield* runToStored({
          repositories,
          title: "Bump vite from 5.1.0 to 6.0.0",
          author: DEPENDABOT,
          generate: () => Effect.die("a template guide runs no model"),
        });
        assert.deepStrictEqual(guide.writer, { tier: "template" });
        assert.include(guide.tldr ?? "", "Bumps vite from 5.1.0 to 6.0.0.");
        assert.strictEqual(guide.stops.length, 1);
        assert.strictEqual(guide.stops[0]?.attention?.kind, "risk");
        assert.deepStrictEqual(
          guide.stops[0]?.files.map((file) => file.path),
          ["feature.txt"],
        );
      }),
    ),
  );

  it.effect("has a model write a person's change whose title only looks like a dependency bump", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const person: PullRequestActor = { login: "julius", name: "Julius", avatarUrl: null };
        const calls: Array<ReviewGuideGenerationInput> = [];
        const guide = yield* runToStored({
          repositories,
          singlePassDiffBytes: 48 * 1024,
          title: "Bump timeout from 30 to 60",
          author: person,
          generate: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return shapedGuide("before: 30\nafter: 60\nwhy: slow hosts");
            }),
        });
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(guide.writer, { tier: "single-pass" });
        assert.notInclude(guide.tldr ?? "", "dependency bot");

        // Nor is it stored as a template ahead of the reader.
        const prewarmed = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          title: "Update the release script to publish packages",
          author: person,
          generate: () => Effect.die("no writer was given"),
        });
        const ownReference = { ...reference, number: 7016 };
        assert.strictEqual(yield* prewarmed.prewarm(ownReference, []), "needs-model");
        assert.isNull((yield* prewarmed.get(ownReference)).guide);
      }),
    ),
  );

  const buildService = (input: Parameters<typeof makeLayer>[0]) =>
    Layer.build(makeLayer(input)).pipe(
      Effect.map((context) =>
        Context.get(context, PullRequestReviewGuideService.PullRequestReviewGuideService),
      ),
    );
  const writer = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };

  it.effect("prewarms nothing beside a person's run, and a person joins a prewarm at once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const service = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          generate: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(shapedGuide("before: none\nafter: feature\nwhy: asked")),
            ),
        });
        // A person's run is going: a prewarm writes nothing beside it.
        yield* service.generate(reference);
        yield* Deferred.await(started);
        assert.strictEqual(yield* service.prewarm(reference, [writer]), "skipped");
        yield* Deferred.succeed(release, undefined);
        yield* service.get(reference).pipe(
          Effect.filterOrFail((result) => result.run === null && result.guide !== null, () => "running"),
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }),
        );
        // A guide for this head is stored: nothing left to prewarm.
        assert.strictEqual(yield* service.prewarm(reference, [writer]), "skipped");
      }),
    ),
  );

  it.effect("a person opening a pull request joins its prewarm run without waiting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        // Its own number: a guide another test stored for an identical head (same-second commits) would answer it.
        const ownReference = { ...reference, number: 7001 };
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const calls: Array<ReviewGuideGenerationInput> = [];
        const service = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          generate: (input) =>
            Effect.sync(() => calls.push(input)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(shapedGuide("before: none\nafter: feature\nwhy: asked")),
            ),
        });
        const prewarm = yield* Effect.forkScoped(service.prewarm(ownReference, [writer]));
        yield* Deferred.await(started);
        // The prewarm's model is still writing; the person's press answers at once and joins it.
        const pressed = yield* service.generate(ownReference).pipe(Effect.timeout("2 seconds"));
        assert.isFalse(pressed.started);
        assert.strictEqual(pressed.run?._tag, "Running");
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual(yield* Fiber.join(prewarm), "checkout");
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0]?.modelSelection, writer);
        const result = yield* service.get(ownReference);
        assert.strictEqual(result.guide?.headSha, repositories.headSha);
        assert.isNull(result.run);
      }),
    ),
  );

  it.effect("a person who joins a prewarm that had no writer still gets a guide", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const ownReference = { ...reference, number: 7017 };
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const calls: Array<ReviewGuideGenerationInput> = [];
        let activityReads = 0;
        const service = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          // The prewarm's first read looks for a guide comment to adopt, before it claims the run; hold the run's own.
          onActivity: Effect.suspend(() =>
            ++activityReads === 1 ? Effect.void : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
          generate: (input) =>
            Effect.sync(() => calls.push(input)).pipe(
              Effect.as(shapedGuide("before: none\nafter: feature\nwhy: asked")),
            ),
        });
        // A pass while every subscription is busy: no writer, so only a template could be written.
        const prewarm = yield* Effect.forkScoped(service.prewarm(ownReference, []));
        yield* Deferred.await(entered);
        const pressed = yield* service.generate(ownReference);
        assert.isFalse(pressed.started);
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual(yield* Fiber.join(prewarm), "needs-model");
        const after = yield* service.get(ownReference).pipe(
          Effect.filterOrFail((result) => result.run?._tag !== "Running", () => "running"),
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }),
        );
        assert.strictEqual(after.guide?.headSha, repositories.headSha);
        assert.isNull(after.run);
        assert.strictEqual(calls.length, 1);
      }),
    ),
  );

  it.effect("a person who joins a prewarm whose writer fails gets their own writers, or a failure they see", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const flash = { instanceId: ProviderInstanceId.make("caveman"), model: "caveman/deepseek/deepseek-flash" };
        const tried: Array<string> = [];
        const pressedDuring = (ownReference: PullRequestRef, othersFail: boolean) =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const service = yield* buildService({
              ...repositories,
              stored: yield* Deferred.make<void>(),
              generate: (input) =>
                Effect.sync(() => tried.push(input.modelSelection.model)).pipe(
                  Effect.andThen(
                    input.modelSelection.model === flash.model
                      ? Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(
                            Effect.fail(
                              new TextGenerationError({ operation: "generateReviewGuide", detail: "rate limited" }),
                            ),
                          ),
                        )
                      : othersFail
                        ? Effect.fail(
                            new TextGenerationError({ operation: "generateReviewGuide", detail: "signed out" }),
                          )
                        : Effect.succeed(shapedGuide("before: none\nafter: feature\nwhy: asked")),
                  ),
                ),
            });
            // A linked prewarm on the cheapest writer only.
            const prewarm = yield* Effect.forkScoped(service.prewarm(ownReference, [flash]));
            yield* Deferred.await(entered);
            assert.isFalse((yield* service.generate(ownReference)).started);
            yield* Deferred.succeed(release, undefined);
            assert.strictEqual(yield* Fiber.join(prewarm), "failed");
            return yield* service.get(ownReference).pipe(
              Effect.filterOrFail((result) => result.run?._tag !== "Running", () => "running"),
              Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }),
            );
          });

        const written = yield* pressedDuring({ ...reference, number: 7018 }, false);
        assert.strictEqual(written.guide?.headSha, repositories.headSha);
        assert.isNull(written.run);
        assert.notStrictEqual(tried.at(-1), flash.model);

        const failed = yield* pressedDuring({ ...reference, number: 7019 }, true);
        assert.isNull(failed.guide);
        assert.strictEqual(failed.run?._tag, "Failed");
      }),
    ),
  );

  it.effect("prewarms a template at once and leaves a change that needs a model for later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        // Its own number: a guide another test stored for an identical head (same-second commits) would answer it.
        const ownReference = { ...reference, number: 7002 };
        const bump = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          title: "Bump vite from 5.1.0 to 6.0.0",
          author: DEPENDABOT,
          generate: () => Effect.die("a template guide runs no model"),
        });
        assert.strictEqual(yield* bump.prewarm(ownReference, []), "template");
        assert.deepStrictEqual((yield* bump.get(ownReference)).guide?.writer, { tier: "template" });

        const repositories2 = yield* makeRepositories;
        const code = yield* buildService({
          ...repositories2,
          stored: yield* Deferred.make<void>(),
          generate: () => Effect.die("no writer was given"),
        });
        // Another pull request: guides are stored per key, and the bump's is stored already.
        const other = { ...reference, number: reference.number + 100 };
        assert.strictEqual(yield* code.prewarm(other, []), "needs-model");
        const after = yield* code.get(other);
        assert.isNull(after.guide);
        // Nothing a reader sees, and the next pass does not fetch it again without a writer.
        assert.isNull(after.run);
        assert.strictEqual(yield* code.prewarm(other, []), "skipped");
      }),
    ),
  );

  it.effect("records a failed prewarm for no reader and does not retry that head", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        // Its own number: a guide another test stored for an identical head (same-second commits) would answer it.
        const ownReference = { ...reference, number: 7003 };
        let calls = 0;
        const service = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          generate: () =>
            Effect.suspend(() => {
              calls += 1;
              return Effect.fail(new TextGenerationError({ operation: "generateReviewGuide", detail: "rate limited" }));
            }),
        });
        assert.strictEqual(yield* service.prewarm(ownReference, [writer]), "failed");
        assert.isNull((yield* service.get(ownReference)).run);
        assert.strictEqual(yield* service.prewarm(ownReference, [writer]), "skipped");
        assert.strictEqual(calls, 1);
      }),
    ),
  );

  it("tries a prewarm's writers in order and never steps up to a bigger model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        // Its own number: a guide another test stored for an identical head would answer it.
        const ownReference = { ...reference, number: 7004 };
        const flash = { instanceId: ProviderInstanceId.make("caveman"), model: "caveman/deepseek/deepseek-flash" };
        const tried: Array<string> = [];
        const stored = yield* Deferred.make<void>();
        const service = yield* buildService({
          ...repositories,
          stored,
          generate: (input) =>
            Effect.suspend(() => {
              tried.push(input.modelSelection.model);
              return input.modelSelection.model === flash.model
                ? Effect.fail(new TextGenerationError({ operation: "generateReviewGuide", detail: "credits spent" }))
                : Effect.succeed(shapedGuide("It adds a feature."));
            }),
        });
        // The checkout run's guide misses the check (no before/after/why), which for a person's run
        // would step Haiku up to Sonnet; a prewarm keeps it.
        assert.strictEqual(yield* service.prewarm(ownReference, [flash, writer]), "checkout");
        assert.deepStrictEqual(tried, [flash.model, writer.model]);
        assert.deepStrictEqual((yield* service.get(ownReference)).guide?.modelSelection, writer);
      }),
    ),
  );

  it("writes a change too large for one pass in a wider one on a writer that cannot read a checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const ownReference = { ...reference, number: 7005 };
        const calls: Array<ReviewGuideGenerationInput> = [];
        const service = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          // A zero single-pass budget sends the change to the checkout tier.
          singlePassDiffBytes: 0,
          readsCheckout: false,
          generate: (input) =>
            Effect.sync(() => {
              calls.push(input);
              // Misses the check: a writer that reads a checkout would escalate to one.
              return shapedGuide("It adds a feature.");
            }),
        });
        const flash = { instanceId: ProviderInstanceId.make("cursor"), model: "claude-haiku-5-5" };
        assert.strictEqual(yield* service.prewarm(ownReference, [flash]), "single-pass");
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0]?.cwd, repositories.workspace);
        assert.include(calls[0]?.diff ?? "", "+++ b/feature.txt");
        const worktrees = yield* git(repositories.workspace, ["worktree", "list", "--porcelain"]);
        assert.strictEqual(worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
      }),
    ),
  );

  it.effect("reads the single-pass budget from settings when no test budget is set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const ownReference = { ...reference, number: 7006 };
        const calls: Array<ReviewGuideGenerationInput> = [];
        const service = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          singlePassKb: 8,
          generate: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return shapedGuide("before: none\nafter: feature\nwhy: asked");
            }),
        });
        // A 10-line change fits 8 KB: one pass over the diff, no checkout.
        assert.strictEqual(yield* service.prewarm(ownReference, [writer]), "single-pass");
        assert.include(calls[0]?.diff ?? "", "+++ b/feature.txt");
        assert.strictEqual(calls[0]?.depth, "tour");
      }),
    ),
  );

  it.effect("keeps a person's first guide with step up off in settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sonnet = "claude-sonnet-5-5";
        const claude = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated", type: "max" },
          models: [{ slug: writer.model }, { slug: sonnet }],
        } as unknown as ServerProvider;
        const tried = (stepUp: boolean, number: number) =>
          Effect.gen(function* () {
            const repositories = yield* makeRepositories;
            const models: Array<string> = [];
            const guide = yield* runToStored({
              repositories,
              settings: { reviewGuideStepUp: stepUp, reviewGuideModelSelection: writer },
              providers: [claude],
              reference: { ...reference, number },
              generate: (input) =>
                Effect.sync(() => {
                  models.push(input.modelSelection.model);
                  // Misses the check (no before/after/why): a person's checkout run steps up on it.
                  return shapedGuide("It adds a feature.");
                }),
            });
            return { models, guide };
          });
        const on = yield* tried(true, 7007);
        assert.deepStrictEqual(on.models, [writer.model, sonnet]);
        const off = yield* tried(false, 7008);
        assert.deepStrictEqual(off.models, [writer.model]);
        assert.deepStrictEqual(off.guide.writer, { tier: "checkout" });
      }),
    ),
  );

  it.effect("writes a short change's TL;DR in one call with no tour, and its tour when asked for the full one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const calls: Array<ReviewGuideGenerationInput> = [];
        const generate: TextGeneration.TextGeneration["Service"]["generateReviewGuide"] = (input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.depth === "tldr"
              ? { depth: "tldr" as const, tldr: "Adds the feature, so users get it.", stops: [] }
              : shapedGuide("before: none\nafter: feature\nwhy: asked");
          });
        // feature.txt adds 10 lines: short under the default 30.
        const tldr = yield* runToStored({ repositories, shortLines: 30, reference: { ...reference, number: 7009 }, generate });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0]?.depth, "tldr");
        assert.include(calls[0]?.diff ?? "", "+line 1");
        assert.strictEqual(tldr.depth, "tldr");
        assert.deepStrictEqual(tldr.writer, { tier: "single-pass" });
        assert.strictEqual(tldr.tldr, "Adds the feature, so users get it.");
        // No closing stop for the files: the diff shows them.
        assert.deepStrictEqual(tldr.stops, []);

        const tour = yield* runToStored({
          repositories,
          shortLines: 30,
          reference: { ...reference, number: 7010 },
          full: true,
          generate,
        });
        // The test budget is 0, so the tour reads the checkout.
        assert.isUndefined(calls[1]?.diff);
        assert.notStrictEqual(calls[1]?.depth, "tldr");
        assert.strictEqual(tour.depth, "tour");
        assert.strictEqual(tour.stops.length, 1);
      }),
    ),
  );

  const chat = { tldr: "Adds the feature so users can try it.", threadId: ThreadId.make("caveman:chat-1") };

  it.effect("stores the chat's TL;DR for the head, never over a model's guide, and only with it on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const ownReference = { ...reference, number: 7011 };
        const service = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          generate: () => Effect.die("the chat wrote it"),
        });
        assert.isTrue(yield* service.fromChat(ownReference, { ...chat, modelSelection: writer }));
        const stored = (yield* service.get(ownReference)).guide!;
        assert.deepStrictEqual(
          { ...stored, generatedAt: "" },
          {
            headSha: repositories.headSha,
            generatedAt: "",
            modelSelection: writer,
            writer: { tier: "chat" },
            depth: "tldr",
            tldr: chat.tldr,
            stops: [],
            threadId: chat.threadId,
          },
        );
        // A second word from the chat replaces its first.
        assert.isTrue(yield* service.fromChat(ownReference, { ...chat, tldr: "Adds the feature." }));
        assert.strictEqual((yield* service.get(ownReference)).guide?.tldr, "Adds the feature.");

        const off = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          settings: { reviewGuideChatTldr: false },
          generate: () => Effect.die("the chat wrote it"),
        });
        assert.isFalse(yield* off.fromChat({ ...reference, number: 7012 }, chat));
        assert.isNull((yield* off.get({ ...reference, number: 7012 })).guide);

        // A template's guide for this head stands.
        const bump = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          title: "Bump vite from 5.1.0 to 6.0.0",
          author: DEPENDABOT,
          generate: () => Effect.die("a template guide runs no model"),
        });
        const bumped = { ...reference, number: 7013 };
        assert.strictEqual(yield* bump.prewarm(bumped, []), "template");
        assert.isFalse(yield* bump.fromChat(bumped, chat));
        assert.deepStrictEqual((yield* bump.get(bumped)).guide?.writer, { tier: "template" });
      }),
    ),
  );

  it.effect("prewarms nothing more for a short change the chat wrote a TL;DR for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const ownReference = { ...reference, number: 7014 };
        const service = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          shortLines: 30,
          generate: () => Effect.die("the chat's TL;DR is the guide"),
        });
        yield* service.fromChat(ownReference, { ...chat, modelSelection: writer });
        assert.strictEqual(yield* service.prewarm(ownReference, [writer]), "chat");
        // Not fetched again on the next pass.
        assert.strictEqual(yield* service.prewarm(ownReference, [writer]), "skipped");
        assert.deepStrictEqual((yield* service.get(ownReference)).guide?.writer, { tier: "chat" });
      }),
    ),
  );

  it.effect("tours a long change the chat wrote a TL;DR for, checking that TL;DR against the diff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const ownReference = { ...reference, number: 7015 };
        const calls: Array<ReviewGuideGenerationInput> = [];
        const stored = yield* Deferred.make<void>();
        const service = yield* buildService({
          ...repositories,
          stored,
          // feature.txt's 10 lines are past 5: long.
          shortLines: 5,
          generate: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return shapedGuide("before: none\nafter: feature\nwhy: asked");
            }),
        });
        yield* service.fromChat(ownReference, { ...chat, modelSelection: writer });
        assert.strictEqual(yield* service.prewarm(ownReference, [writer]), "checkout");
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0]?.chatTldr, chat.tldr);
        assert.strictEqual(calls[0]?.depth, undefined);
        const guide = (yield* service.get(ownReference)).guide!;
        assert.deepStrictEqual(guide.writer, { tier: "checkout" });
        assert.strictEqual(guide.depth, "tour");
        assert.notProperty(guide, "threadId");
        // The tour is stored for this head: nothing left to prewarm.
        assert.strictEqual(yield* service.prewarm(ownReference, [writer]), "skipped");
      }),
    ),
  );

  /**
   * A GitHub pull request whose conversation the test reads back: `viewer` signed in, `author` opened it, and its
   * comments start as `comments`. Posting and editing land in the same list, so a second post can see the first.
   */
  const githubHost = (input: {
    readonly workspace: string;
    readonly headSha: string;
    readonly viewer: string;
    readonly author: string;
    readonly comments?: ReadonlyArray<PullRequestComment>;
  }) =>
    Effect.gen(function* () {
      const comments = yield* Ref.make<ReadonlyArray<PullRequestComment>>(input.comments ?? []);
      const writes = yield* Ref.make<ReadonlyArray<"comment" | "updateComment">>([]);
      const patch = yield* git(input.workspace, ["diff", "origin/stack-base", input.headSha]).pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      const host: Partial<PullRequestService.PullRequestService["Service"]> = {
        detail: () =>
          Effect.succeed({
            ...detail(input.workspace, input.headSha),
            provider: "github",
            url: "https://github.com/acme/app/pull/7",
            viewer: input.viewer,
            author: { login: input.author, name: null, avatarUrl: null },
            viewerPermissions: { comment: true, actions: [], resolve: true, verdicts: [], requestReviewers: false },
          } as unknown as PullRequestDetail),
        activity: () => Ref.get(comments).pipe(Effect.map((list) => ({ ...activity, comments: list, commentCount: list.length }))),
        diff: () => Effect.succeed({ patch: `${patch}\n`, truncated: false, nextCursor: null }),
        comment: ({ body }) =>
          Ref.update(writes, (list) => [...list, "comment" as const]).pipe(
            Effect.andThen(
              Ref.update(comments, (list) => [
                ...list,
                {
                  id: `c${list.length + 1}`,
                  kind: "issue-comment" as const,
                  author: { login: input.viewer, name: null, avatarUrl: null },
                  body,
                  createdAt: "2026-11-05T10:00:00.000Z",
                  url: `https://github.com/acme/app/pull/7#issuecomment-${list.length + 1}`,
                  path: null,
                  reviewState: null,
                },
              ]),
            ),
          ),
        updateComment: ({ commentId, body }) =>
          Ref.update(writes, (list) => [...list, "updateComment" as const]).pipe(
            Effect.andThen(Ref.update(comments, (list) => list.map((c) => (c.id === commentId ? { ...c, body } : c)))),
          ),
      };
      return { host, comments, writes };
    });

  /** The run's guide stored, or the test failing with why the run did not store one. */
  const landed = (
    service: PullRequestReviewGuideService.PullRequestReviewGuideService["Service"],
    stored: Deferred.Deferred<void>,
  ) =>
    Effect.raceFirst(
      Deferred.await(stored),
      awaitRunFailure(service, reference).pipe(Effect.flatMap((detail) => Effect.die(`run failed: ${detail}`))),
    );

  it.effect("posts the guide on the pull request a chat opened, then edits that comment as the guide is rewritten", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const { host, comments, writes } = yield* githubHost({ ...repositories, viewer: "alice", author: "alice" });
        let summary = "before: no feature\nafter: feature.txt\nwhy: users asked";
        const stored = yield* Deferred.make<void>();
        const service = yield* buildService({
          ...repositories,
          stored,
          host,
          generate: () => Effect.sync(() => shapedGuide(summary)),
        });
        yield* service.generate(reference);
        yield* landed(service, stored);
        const result = yield* service.post(reference, "link");
        const [posted] = yield* Ref.get(comments);
        assert.deepStrictEqual(yield* Ref.get(writes), ["comment"]);
        assert.include(posted?.body ?? "", "### Review guide");
        // feature.txt is all new, so its excerpt is drawn as plain text, not as additions.
        assert.include(posted?.body ?? "", "```txt\nline 1\nline 2");
        assert.deepStrictEqual(readGuideComment(posted?.body ?? "")?.headSha, repositories.headSha);
        assert.deepStrictEqual(result.comment, { url: posted!.url!, headSha: repositories.headSha, mine: true });
        assert.isTrue(result.canPost);
        // Posting what is already there writes nothing.
        yield* service.post(reference, "press");
        assert.deepStrictEqual(yield* Ref.get(writes), ["comment"]);
        // A rewrite edits the same comment, in the background.
        summary = "before: nothing\nafter: the feature, rewritten\nwhy: clearer";
        yield* service.generate(reference);
        yield* Ref.get(writes).pipe(
          Effect.flatMap((list) => (list.length === 2 ? Effect.succeed(list) : Effect.fail("not yet" as const))),
          Effect.retry(Schedule.spaced("20 millis")),
        );
        const after = yield* Ref.get(comments);
        assert.deepStrictEqual(yield* Ref.get(writes), ["comment", "updateComment"]);
        assert.strictEqual(after.length, 1);
        assert.include(after[0]?.body ?? "", "the feature, rewritten");
      }),
    ),
  );

  it.effect("posts nothing unasked on someone else's pull request, nor with posting off, and a press posts once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const { host, writes } = yield* githubHost({ ...repositories, viewer: "bob", author: "alice" });
        const stored = yield* Deferred.make<void>();
        const service = yield* buildService({
          ...repositories,
          stored,
          host,
          generate: () => Effect.succeed(shapedGuide("before: none\nafter: feature\nwhy: asked")),
        });
        yield* service.generate(reference);
        yield* landed(service, stored);
        yield* service.post(reference, "link");
        assert.deepStrictEqual(yield* Ref.get(writes), []);
        yield* service.post(reference, "press");
        yield* service.post(reference, "press");
        assert.deepStrictEqual(yield* Ref.get(writes), ["comment"]);

        const own = yield* githubHost({ ...repositories, viewer: "alice", author: "alice" });
        const off = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          host: own.host,
          settings: { reviewGuidePost: false },
          generate: () => Effect.succeed(shapedGuide("before: none\nafter: feature\nwhy: asked")),
        });
        yield* off.post(reference, "link");
        assert.deepStrictEqual(yield* Ref.get(own.writes), []);
      }),
    ),
  );

  it.effect("reads the guide its author posted for this head instead of writing one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = yield* makeRepositories;
        const theirs = renderGuideComment(
          {
            headSha: repositories.headSha,
            generatedAt: "2026-11-05T09:00:00.000Z",
            modelSelection: writer,
            writer: { tier: "single-pass" },
            depth: "tour",
            ...shapedGuide("before: none\nafter: feature\nwhy: asked"),
          },
          { url: "https://github.com/acme/app/pull/7", label: "Claude Haiku 5.5 · single pass", patches: new Map() },
        );
        const comment = (login: string): PullRequestComment => ({
          id: login,
          kind: "issue-comment",
          author: { login, name: null, avatarUrl: null },
          body: theirs,
          createdAt: "2026-11-05T09:00:00.000Z",
          url: `https://github.com/acme/app/pull/7#issuecomment-${login}`,
          path: null,
          reviewState: null,
        });
        let calls = 0;
        const service = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          host: (yield* githubHost({ ...repositories, viewer: "bob", author: "alice", comments: [comment("mallory"), comment("alice")] })).host,
          generate: () => Effect.sync(() => (calls++, shapedGuide("written here"))),
        });
        assert.strictEqual(yield* service.prewarm(reference, [writer]), "adopted");
        const result = yield* service.get(reference);
        assert.strictEqual(calls, 0);
        assert.deepStrictEqual(result.guide?.posted, {
          login: "alice",
          url: "https://github.com/acme/app/pull/7#issuecomment-alice",
          label: "Claude Haiku 5.5 · single pass",
        });
        assert.strictEqual(result.guide?.tldr, "Adds the feature.");
        assert.deepStrictEqual(result.guide?.stops[0]?.excerpts, [{ path: "feature.txt", side: "new", start: 1, end: 5, caption: "" }]);
        assert.deepStrictEqual(result.comment, { url: "https://github.com/acme/app/pull/7#issuecomment-alice", headSha: repositories.headSha, mine: false });

        // A stranger's comment is shown, never read as the guide.
        const strangers = yield* buildService({
          ...repositories,
          stored: yield* Deferred.make<void>(),
          host: (yield* githubHost({ ...repositories, viewer: "bob", author: "alice", comments: [comment("mallory")] })).host,
          generate: () => Effect.die("not this test"),
        });
        const shown = yield* strangers.get({ ...reference, number: 7020 });
        assert.isNull(shown.guide);
        assert.strictEqual(shown.comment?.mine, false);
      }),
    ),
  );

  it("records a guide run's tokens, with dollars only on an API key", () => {
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };
    const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 0.01 };
    const claude = (auth: object) => ({ driver: "claudeAgent", auth: { status: "authenticated", ...auth } }) as never;
    const max = PullRequestReviewGuideService.reviewGuideSpendUsage(selection, claude({ type: "max" }), usage);
    assert.deepStrictEqual(max, {
      engine: "claude-agent",
      bucket: "review-guide",
      model: "claude-haiku-5-5",
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 40,
      cost: null,
      billing: "plan",
    });
    const login = PullRequestReviewGuideService.reviewGuideSpendUsage(selection, claude({}), usage);
    assert.strictEqual(login.cost, null);
    assert.notProperty(login, "billing");
    const key = PullRequestReviewGuideService.reviewGuideSpendUsage(selection, claude({ type: "apiKey" }), usage);
    assert.deepStrictEqual(key.cost, { usd: 0.01, basis: "list_price" });
    assert.propertyVal(key, "billing", "api_key");
  });
});
