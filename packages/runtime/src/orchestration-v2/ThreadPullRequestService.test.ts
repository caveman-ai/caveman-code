// ), apps/server/src/orchestration-v2/ThreadPullRequestService.test.ts @ ab3a3cd1.
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@caveman-app/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { projectIdFor } from "./ProjectCommands.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

describe("ThreadPullRequestServiceV2 project guard", () => {
  it.effect("discovers a repository from a project shell without enrichment", () =>
    Effect.gen(function* () {
      const project: OrchestrationProjectShell = {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        repositoryIdentity: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      let resolvedRoot: string | null = null;
      const result = yield* ThreadPullRequestService.resolveProjectForPullRequestDiscovery(
        project,
        {
          resolve: (root) => {
            resolvedRoot = root;
            return Effect.succeed({
              canonicalKey: "github.com/pingdotgg/t3code",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:pingdotgg/t3code.git",
              },
              provider: "github" as const,
              displayName: "pingdotgg/t3code",
              owner: "pingdotgg",
              name: "t3code",
            });
          },
        },
      );
      expect(resolvedRoot).toBe("/workspace/project");
      expect(result.repository).toBe("pingdotgg/t3code");
      expect(result.project.repositoryIdentity?.canonicalKey).toBe("github.com/pingdotgg/t3code");
    }),
  );

  it.effect("refreshes the cached repository identity only when asked", () =>
    Effect.gen(function* () {
      const project: OrchestrationProjectShell = {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        repositoryIdentity: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const refreshes: Array<boolean | undefined> = [];
      const resolver = {
        resolve: (_root: string, options?: { readonly refresh?: boolean }) => {
          refreshes.push(options?.refresh);
          return Effect.succeed(null);
        },
      };
      yield* ThreadPullRequestService.resolveProjectForPullRequestDiscovery(project, resolver);
      yield* ThreadPullRequestService.resolveProjectForPullRequestDiscovery(project, resolver, {
        refresh: true,
      });
      expect(refreshes).toEqual([false, true]);
    }),
  );

  it("rejects a pull-request result when the project root changes before dispatch", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/replaced",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(false);
  });

  it("rejects a pull-request result when the project was deleted before dispatch", () => {
    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        Option.none<Pick<OrchestrationProjectShell, "workspaceRoot">>(),
        "/workspace/original",
      ),
    ).toBe(false);
  });

  it("accepts a pull-request result while the project root is unchanged", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/original",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(true);
  });
});

describe("ThreadPullRequestServiceV2 reads", () => {
  const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");
  const threadShell = (id: string): OrchestrationV2ThreadShell => {
    const threadId = ThreadId.make(id);
    return {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      activeRunId: null,
      latestRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };

  it.effect.each([
    {
      worktree: "a linked worktree",
      existingPaths: ["/workspace/worktree", "/workspace/worktree/.git"],
      unreadablePaths: [],
      cwd: "/workspace/worktree",
    },
    // A folder that outlived its .git makes git fail with not_a_repository.
    {
      worktree: "a folder without .git",
      existingPaths: ["/workspace/worktree"],
      unreadablePaths: [],
      cwd: "/workspace/project",
    },
    {
      worktree: "a folder whose .git cannot be checked",
      existingPaths: ["/workspace/worktree"],
      unreadablePaths: ["/workspace/worktree/.git"],
      cwd: "/workspace/worktree",
    },
    {
      worktree: "a missing folder",
      existingPaths: [],
      unreadablePaths: [],
      cwd: "/workspace/project",
    },
  ] as const)(
    "looks up a branch whose worktree is $worktree in $cwd",
    ({ existingPaths, unreadablePaths, cwd }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const thread = {
            ...threadShell("worktree-thread"),
            branch: "feature/worktree",
            worktreePath: "/workspace/worktree",
          };
          const project: OrchestrationProjectShell = {
            id: thread.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const lookupCwds: Array<string> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSnapshot: () =>
                Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [thread],
                    archivedThreads: [],
                  }),
                ),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: (input) =>
                Effect.sync(() => {
                  lookupCwds.push(input.cwd);
                  return null;
                }),
            }),
            Layer.mock(PullRequestService.PullRequestService)({}),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({
              exists: (path) =>
                unreadablePaths.some((entry) => entry === path)
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "exists",
                        pathOrDescriptor: path,
                      }),
                    )
                  : Effect.succeed(existingPaths.some((entry) => entry === path)),
            }),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(Effect.provide(dependencies));

          expect(lookupCwds).toEqual([cwd]);
        }),
      ),
  );

  it.effect("leaves delegated child threads to their own refresh instead of the sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = {
          ...threadShell("parent-thread"),
          branch: "feature/parent",
          worktreePath: "/workspace/parent",
        };
        const child: OrchestrationV2ThreadShell = {
          ...threadShell("child-thread"),
          branch: "t3/reply-ok",
          worktreePath: "/workspace/child",
          lineage: {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: "subagent",
          },
        };
        const project: OrchestrationProjectShell = {
          id: parent.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const sweeps = yield* Queue.unbounded<void>();
        const childLookup = yield* Deferred.make<void>();
        const lookups: Array<{ readonly branch: string; readonly refresh: boolean }> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(domainEvents),
            getPullRequestSnapshot: ({ threadId }) =>
              threadId !== undefined
                ? Effect.succeed({
                    snapshotSequence: 1,
                    threads: [parent, child].filter((thread) => thread.id === threadId),
                  })
                : Queue.offer(sweeps, undefined).pipe(
                    Effect.as({ snapshotSequence: 1, threads: [parent, child] }),
                  ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (input, options) =>
              Effect.gen(function* () {
                const refresh = options?.refresh ?? false;
                lookups.push({ branch: input.branch, refresh });
                if (input.branch === child.branch && refresh) {
                  yield* Deferred.succeed(childLookup, undefined);
                }
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);

          // Startup backfill sweep, then one periodic sweep.
          yield* Queue.take(sweeps);
          yield* service.drain;
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          yield* service.drain;
          const sweepLookups = lookups.map((lookup) => lookup.branch).toSorted();

          // The child's own turn still discovers its pull request.
          yield* Queue.offer(domainEvents, {
            type: "checkpoint.captured",
            threadId: child.id,
          } as OrchestrationV2DomainEvent);
          yield* Deferred.await(childLookup);
          yield* service.drain;

          expect(sweepLookups).toEqual([parent.branch, parent.branch]);
          expect(lookups.slice(sweepLookups.length)).toEqual([
            { branch: child.branch, refresh: true },
          ]);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );

  it.effect.each([
    { state: "closed", sameBranch: false },
    { state: "merged", sameBranch: false },
    { state: "closed", sameBranch: true },
    { state: "merged", sameBranch: true },
  ] as const)(
    "restores a $state automatic PR only for its own branch (sameBranch=$sameBranch)",
    ({ state, sameBranch }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const savedReference = {
            projectId: ProjectId.make("project-1"),
            repository: "acme/project",
            number: 42,
            url: "https://github.com/acme/project/pull/42",
          };
          const thread = {
            ...threadShell("branch-pr-thread"),
            branch: "main",
            branchPullRequest: savedReference,
            linkedPullRequest: savedReference,
          };
          const project: OrchestrationProjectShell = {
            id: thread.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const commands: Array<OrchestrationV2ServerCommand> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSnapshot: () =>
                Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [thread],
                    archivedThreads: [],
                  }),
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 2, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeed(Option.some(project)),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () => Effect.succeed(null),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              summary: () =>
                Effect.succeed({
                  ...savedReference,
                  provider: SourceControlProviderKind.make("github"),
                  title: "Previous branch work",
                  state,
                  headBranch: sameBranch ? thread.branch : "feature/previous-work",
                  baseBranch: "release",
                  updatedAt: "2026-09-19T00:00:00.000Z",
                }),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: "github" as const,
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({}),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(Effect.provide(dependencies));

          if (sameBranch) {
            expect(commands).toEqual([]);
          } else {
            expect(commands).toHaveLength(1);
            expect(commands[0]).toMatchObject({
              type: "thread.pull-request.sync",
              threadId: thread.id,
              branchPullRequest: null,
            });
            expect(commands[0]).not.toHaveProperty("linkedPullRequest");
          }
        }),
      ),
  );

  it.effect("an event for one thread reads that thread's shell, not every thread's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = threadShell("updated-thread");
        const other = threadShell("other-thread");
        const activation = yield* Deferred.make<void>();
        const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        // Each read: the thread id for a one-thread read, or the full read's options.
        const reads = yield* Queue.unbounded<
          ThreadId | { readonly threadId?: ThreadId; readonly unsettledOnly?: boolean }
        >();
        const layerDependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromPubSub(events),
            getPullRequestSnapshot: (options) =>
              options.threadId !== undefined
                ? Queue.offer(reads, options.threadId).pipe(
                    Effect.as({
                      snapshotSequence: 1,
                      threads: [thread, other].filter(
                        (candidate) => candidate.id === options.threadId,
                      ),
                    }),
                  )
                : Queue.offer(reads, options).pipe(
                    Effect.as({ snapshotSequence: 1, threads: [thread, other] }),
                  ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([]),
          }),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );

        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          // Startup backfill reads every active thread.
          expect(yield* Queue.take(reads)).toEqual({ unsettledOnly: false });
          yield* service.drain;
          yield* PubSub.publish(events, {
            type: "thread.metadata-updated",
            id: EventId.make("event:metadata"),
            threadId: thread.id,
            occurredAt: NOW,
            payload: {
              createdBy: thread.createdBy,
              creationSource: thread.creationSource,
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              providerInstanceId: thread.providerInstanceId,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              activeProviderThreadId: thread.activeProviderThreadId,
              lineage: thread.lineage,
              forkedFrom: null,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
          expect(yield* Queue.take(reads)).toBe(thread.id);
          yield* service.drain;
          expect(yield* Queue.size(reads)).toBe(0);
        }).pipe(Effect.provide(layerDependencies));
      }),
    ),
  );

  // Ours: as before their projects existed, Caveman Code workspaces' threads are never looked up.
  it.effect("leaves the threads of Caveman Code projects out of discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectId = projectIdFor("/workspace/caveman");
        const workspace = { ...threadShell("caveman:workspace"), projectId, branch: "caveman/workspace" };
        const activation = yield* Deferred.make<void>();
        const reads = yield* Queue.unbounded<unknown>();
        const resolved: Array<string> = [];
        const layerDependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            getPullRequestSnapshot: (options) =>
              Queue.offer(reads, options).pipe(
                Effect.as({ snapshotSequence: 1, threads: [workspace] }),
              ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () =>
              Effect.succeed([
                {
                  id: projectId,
                  title: "caveman",
                  workspaceRoot: "/workspace/caveman",
                  defaultModelSelection: null,
                  scripts: [],
                  repositoryIdentity: null,
                  createdAt: "2026-08-01T00:00:00.000Z",
                  updatedAt: "2026-08-01T00:00:00.000Z",
                },
              ]),
          }),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: (root) => Effect.sync(() => (resolved.push(root), null)),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );

        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Queue.take(reads);
          yield* service.drain;
          expect(resolved).toEqual([]);
        }).pipe(Effect.provide(layerDependencies));
      }),
    ),
  );

  it.effect("periodic sweeps read only unsettled threads once backfill is done", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = {
          ...threadShell("settled-thread"),
          branch: "feature/settled",
          settledOverride: "settled" as const,
          settledAt: NOW,
        };
        const activation = yield* Deferred.make<void>();
        const reads = yield* Queue.unbounded<{
          readonly threadId?: ThreadId;
          readonly unsettledOnly?: boolean;
        }>();
        const layerDependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            getPullRequestSnapshot: (options) =>
              Queue.offer(reads, options).pipe(
                Effect.as({
                  snapshotSequence: 1,
                  // The fake honors unsettledOnly like the store does.
                  threads: options.unsettledOnly ? [] : [settled],
                }),
              ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([]),
          }),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );

        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          // Backfill finds the settled branch thread and must read it again.
          expect(yield* Queue.take(reads)).toEqual({ unsettledOnly: false });
          yield* service.drain;
          // Its project is gone, so backfill finishes it on the first pass.
          yield* TestClock.adjust("1 minute");
          expect(yield* Queue.take(reads)).toEqual({ unsettledOnly: true });
          yield* service.drain;
        }).pipe(Effect.provide(layerDependencies));
      }),
    ),
  );
});
