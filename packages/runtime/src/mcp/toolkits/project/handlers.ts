// ), apps/server/src/mcp/toolkits/project/handlers.ts @ ab3a3cd1.
import {
  CommandId,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@caveman-app/protocol";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : error._tag === "ProjectOwnedBySessionsError"
          ? error.message
          : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/**
 * An existing checkout a launch may bind: one of the project's own git
 * worktrees. Without this check a launch could point an agent at any directory
 * on the machine.
 */
const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  if (!worktrees.includes(yield* real(worktreePath)))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "worktreePath must be one of the project's git worktrees. worktree_list shows them.",
    });
});

/** A fixed-length id, so a long key fits in the scratch folder name derived from it. */
const launchCommandId = Effect.fn("mcp.launchCommandId")(function* (
  namespace: string,
  key: string,
) {
  const crypto = yield* Digest.Digest;
  // @effect-diagnostics-next-line preferSchemaOverJson:off - a JSON pair keeps the caller apart from the key.
  const bytes = new TextEncoder().encode(JSON.stringify([namespace, key]));
  const digest = yield* crypto.digest(Digest.sha256, bytes).pipe(Effect.mapError(unavailable));
  return CommandId.make(`mcp:launch:${Hex.encode(digest)}`);
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
// The launch's attachment claim reads the new thread's history from the projection store,
// which the server provides to this layer (the tool's declared dependencies stay as they are).
export const layer = McpToolAccess.toLayer(
  ProjectToolkit,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return {
      thread_launch: McpToolAccess.startsThreads(
        (input) => input,
        (input, { runtimeMode, interactionMode }) =>
          Effect.gen(function* () {
            const context = yield* readCaller();
            const { caller, scope } = context;
            // A retry with the same key replays the first launch: the ids derive
            // from the caller and the key, and the launch service replays a
            // command it already accepted.
            const commandId =
              input.clientRequestId === undefined
                ? yield* newCommandId()
                : yield* launchCommandId(scope.requestNamespace, input.clientRequestId);
            const threadId = ThreadId.make(commandId);
            const messageId = MessageId.make(commandId);
            const attachments = input.attachments ?? [];
            if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "A new thread accepts only pending attachment uploads.",
              });
            if (
              input.scratch === true &&
              (input.projectId !== undefined || input.workspaceStrategy !== undefined)
            )
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
              });
            const projectId =
              input.scratch === true
                ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
                    Effect.flatMap((folders) => folders.ensureScratchProject),
                    Effect.mapError(
                      (error) =>
                        new OrchestratorMcpFailure({
                          code: "orchestration_error",
                          message: error.message,
                        }),
                    ),
                  )).projectId
                : yield* resolveProjectId(context, input.projectId);
            const readProject = Project.ProjectService.pipe(
              Effect.flatMap((projects) => projects.getById(projectId)),
              Effect.mapError(unavailable),
              Effect.map(Option.getOrUndefined),
            );
            // A retry of an accepted launch replays it: it keeps the model it started
            // with and skips the checks only a new launch needs, which the project
            // may no longer pass, such as a base branch deleted since.
            const launched =
              input.clientRequestId === undefined
                ? null
                : yield* context.threads
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(unavailable));
            const launchedModel =
              launched === null || launched.deletedAt !== null
                ? undefined
                : launched.modelSelection;
            const replaying = launchedModel !== undefined;
            if (!replaying && input.workspaceStrategy?.type === "existing_worktree") {
              const project = yield* readProject;
              if (project === undefined)
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "The project was not found.",
                });
              yield* assertProjectWorktree(
                project.workspaceRoot,
                input.workspaceStrategy.worktreePath,
              );
            }
            // A launch is accepted before its worktree is provisioned, so a base
            // ref that cannot resolve is refused while the agent can still act on it.
            const strategy = input.workspaceStrategy;
            if (!replaying && strategy?.type === "worktree")
              yield* ThreadLaunch.ThreadLaunchService.pipe(
                Effect.flatMap((launches) =>
                  launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
                ),
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: `${error.message} No thread was created. Pass a branch, tag, or commit that exists there${
                        strategy.startFromOrigin === true
                          ? "; the project has no usable remote to fetch it from."
                          : ", or set startFromOrigin:true if it exists only on a remote."
                      }`,
                    }),
                ),
              );
            const modelSelection =
              input.modelSelection ??
              launchedModel ??
              caller?.modelSelection ??
              (yield* readProject)?.defaultModelSelection ??
              undefined;
            if (modelSelection === undefined)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
              });
            // An inherited mode the provider doesn't offer steps down to one it does; it would
            // otherwise run Supervised and stall on approvals. An explicit one is refused.
            let startedRuntimeMode = runtimeMode;
            if (!replaying) {
              const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
              startedRuntimeMode = yield* resolveRuntimeMode(runtimeMode, input.runtimeMode, {
                modelSelection,
                supportedRuntimeModes: providers.find(
                  (provider) => provider.instanceId === modelSelection.instanceId,
                )?.supportedRuntimeModes,
              });
            }
            const result = yield* ThreadMessageIntake.launchThread({
              commandId,
              threadId,
              projectId,
              title: input.title,
              modelSelection,
              runtimeMode: startedRuntimeMode,
              interactionMode,
              workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
              ...(input.message === undefined && attachments.length === 0
                ? {}
                : {
                    initialMessage: {
                      messageId,
                      ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                      text: input.message ?? "",
                      attachments,
                    },
                  }),
              createdBy: "agent",
              creationSource: "mcp",
            }).pipe(
              Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
              Effect.mapError((error) => {
                if (error._tag === "AttachmentClaimError") {
                  return new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  });
                }
                if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
                  return new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: error.message,
                  });
                }
                return unavailable();
              }),
            );
            const thread = result.projection.thread;
            const run = result.projection.runs.find((run) => run.userMessageId === messageId);
            return {
              threadId: thread.id,
              projectId: thread.projectId,
              modelSelection: thread.modelSelection,
              runId: run?.id ?? null,
              status: run?.status ?? null,
            };
          }),
      ),
      project_list: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const projects = yield* access;
          const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
          const rows = snapshot.projects.filter((project) => project.deletedAt === null);
          const start = input.cursor ?? 0,
            end = start + (input.limit ?? 20);
          return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
        }),
      ),
      project_read: McpToolAccess.reads((input) =>
        Effect.gen(function* () {
          const projects = yield* access;
          const result = yield* projects
            .getById(input.projectId)
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(result))
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          return result.value;
        }),
      ),
      project_create: McpToolAccess.writesEnvironment(({ workspaceRoot, ...input }) =>
        Effect.gen(function* () {
          const projects = yield* Project.ProjectService;
          if (workspaceRoot === undefined) {
            // Project creation records no model default (only an update does), so
            // reject what this mode would otherwise drop silently.
            if (
              input.scripts !== undefined ||
              input.createWorkspaceRootIfMissing !== undefined ||
              input.defaultModelSelection !== undefined
            )
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with project_update.",
              });
            const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
            const created = yield* folders.createNamedProject({ name: input.title }).pipe(
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            );
            const project = yield* projects.getById(created.projectId).pipe(
              Effect.mapError(unavailable),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(unavailable()),
                  onSome: Effect.succeed,
                }),
              ),
            );
            return {
              ...project,
              ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
            };
          }
          const commandId = yield* newCommandId();
          return yield* projects
            .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
            .pipe(Effect.mapError(projectFailure));
        }),
      ),
      project_update: McpToolAccess.writesEnvironment((input) =>
        Effect.gen(function* () {
          const projects = yield* Project.ProjectService;
          return yield* projects
            .update({ ...input, commandId: yield* newCommandId() })
            .pipe(Effect.mapError(projectFailure));
        }),
      ),
      project_delete: McpToolAccess.writesEnvironment((input) =>
        Effect.gen(function* () {
          const projects = yield* Project.ProjectService;
          return yield* projects
            .delete({ ...input, commandId: yield* newCommandId() })
            .pipe(Effect.mapError(projectFailure));
        }),
      ),
      project_clone: McpToolAccess.writesEnvironment((input) =>
        Effect.gen(function* () {
          const repositories = yield* Repositories.SourceControlRepositoryService;
          return yield* repositories.cloneRepository(input).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.detail,
                }),
            ),
          );
        }),
      ),
    };
  }),
);
