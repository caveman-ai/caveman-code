// ), apps/server/src/git/refreshPushedPullRequests.ts @ ab3a3cd1.
import type { GitRunStackedActionInput, GitRunStackedActionResult } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";

import * as OrchestratorV2 from "../orchestration-v2/Orchestrator.ts";
import { isSessionProtocolProject } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";

export const refreshPushedPullRequests = Effect.fn("refreshPushedPullRequests")(
  function* (
    input: Pick<GitRunStackedActionInput, "cwd" | "threadId" | "projectId">,
    result: Pick<GitRunStackedActionResult, "push">,
  ) {
    if (result.push.status !== "pushed") return;
    const pullRequests = yield* PullRequestService.PullRequestService;
    if (input.threadId !== undefined) {
      const engine = yield* OrchestratorV2.OrchestratorV2;
      const thread = yield* engine.getThreadShell(input.threadId);
      if (thread !== null) {
        yield* pullRequests.refreshAfterTurn(thread.projectId);
        return;
      }
    }
    if (input.projectId !== undefined) {
      yield* pullRequests.refreshAfterTurn(input.projectId);
      return;
    }
    const projects = yield* (yield* ProjectStore.ProjectStoreV2).listShells();
    yield* Effect.forEach(
 // Ours: Caveman Code's projects are not upstream to refresh.
      projects.filter(
        (project) => project.workspaceRoot === input.cwd && !isSessionProtocolProject(project.id),
      ),
      (project) => pullRequests.refreshAfterTurn(project.id),
      { discard: true },
    );
  },
  Effect.ignore({ log: true }),
);
