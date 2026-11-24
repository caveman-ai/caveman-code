// Workspace.activity.awaiting: a chat whose turn ended still waits on work that will wake it (a delegated agent,
// background work its agent marked with background_wait, a pull request it watches). T3 decides that on the thread
// shell (ProjectionStore's pendingBackgroundTasks, held by backgroundWorkHoldsCompletion); the projector folds the
// same inputs from the thread's own events into its state, and decides with the same shared functions, so a replay
// from any offset gives the answer the live projection gave.
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadPullRequestLink,
} from "@caveman-app/protocol";
import { ProviderThreadId, RunId } from "@caveman-app/protocol";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
  pendingBackgroundTurnItems,
  type PendingBackgroundWorkTask,
} from "@caveman-app/shared/orchestrationV2PendingBackgroundWork";
import { latestUnheldRun } from "@caveman-app/shared/orchestrationV2ThreadError";
import {
  threadPullRequestKeyOf,
  threadPullRequestsOf,
} from "@caveman-app/shared/threadPullRequests";

import { isQueuedProviderThreadPlaceholder } from "../orchestration-v2/ProjectionStore.ts";
import type { ThreadState } from "./projector.ts";

type DeriveInput = Parameters<typeof derivePendingBackgroundWork>[0];
type PullRequest = NonNullable<DeriveInput["pullRequests"]>[number];

/** A background turn item still at work: what the derivation reads of it. */
interface BackgroundItem {
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly runId: string | null;
  readonly nativeId?: string;
  readonly persistent?: true;
  readonly monitor?: true;
}

/** The thread's background work as its events left it (ThreadState.background). */
export interface BackgroundState {
  /** The thread's active provider thread (activeProviderThreadId): only its roster counts once one is known. */
  provider?: string | null;
  /** Each provider thread's background roster on this thread, while it has one. */
  rosters?: Record<
    string,
    ReadonlyArray<Pick<PendingBackgroundWorkTask, "taskId" | "kind" | "awaited">>
  >;
  /** Background turn items still at work, by item id. */
  items?: Record<string, BackgroundItem>;
  /** The thread's pull request links, by key. */
  pullRequests?: Record<string, PullRequest>;
}

const pullRequestOf = (link: ThreadPullRequestLink): PullRequest => ({
  host: link.host,
  repository: link.repository,
  number: link.number,
  url: link.url,
  source: link.source,
  snapshot: link.snapshot === null ? null : { state: link.snapshot.state },
  ...(link.watch === undefined ? {} : { watch: link.watch }),
});

const keyedPullRequests = (
  links: ReadonlyArray<ThreadPullRequestLink>,
): Record<string, PullRequest> =>
  Object.fromEntries(links.map((link) => [threadPullRequestKeyOf(link), pullRequestOf(link)]));

/**
 * Folds one event of the thread into `state.background`, as upstream projection applies it (ProjectionStore
 * applyToProjection): provider threads carry their roster and become the active one, background turn items come and
 * go with their status, whole-thread events carry its pull requests and a link update replaces the link it names.
 */
export function foldBackground(state: ThreadState, event: OrchestrationV2DomainEvent): void {
  const background = (state.background ??= {});
  switch (event.type) {
    case "provider-thread.updated": {
      const thread = event.payload;
      const rosters = (background.rosters ??= {});
      // Handed to another thread: it is that thread's now.
      if (thread.appThreadId !== event.threadId) {
        delete rosters[thread.id];
        break;
      }
      if (!isQueuedProviderThreadPlaceholder(thread)) background.provider = thread.id;
      const tasks = thread.pendingBackgroundTasks ?? [];
      if (tasks.length === 0) delete rosters[thread.id];
      else
        rosters[thread.id] = tasks.map((task) => ({
          taskId: task.taskId,
          kind: task.kind,
          ...(task.awaited === undefined ? {} : { awaited: task.awaited }),
        }));
      break;
    }
    case "turn-item.updated": {
      const item = event.payload;
      const items = (background.items ??= {});
      if (pendingBackgroundTurnItems({ turnItems: [item] }).length === 0) {
        delete items[item.id];
        break;
      }
      const nativeId = item.nativeItemRef?.nativeId;
      const input = "input" in item ? (item.input as unknown) : undefined;
      items[item.id] = {
        type: item.type,
        status: item.status,
        runId: item.runId,
        ...(typeof nativeId === "string" && nativeId.length > 0 ? { nativeId } : {}),
        ...(input !== null && typeof input === "object" && Reflect.get(input, "persistent") === true
          ? { persistent: true as const }
          : {}),
        ...("monitor" in item && item.monitor === true ? { monitor: true as const } : {}),
      };
      break;
    }
    case "thread.created":
      background.provider = event.payload.activeProviderThreadId;
      background.pullRequests = keyedPullRequests(threadPullRequestsOf(event.payload));
      break;
    case "thread.pull-request-link-updated": {
      const key = threadPullRequestKeyOf(event.payload);
      if (background.pullRequests?.[key] !== undefined)
        background.pullRequests[key] = pullRequestOf(event.payload);
      break;
    }
    default:
      // Every other thread event carries the whole thread; the stored active provider thread stands (withRunWrittenThreadFields).
      if (event.type.startsWith("thread.")) {
        background.pullRequests = keyedPullRequests(
          threadPullRequestsOf(event.payload as Parameters<typeof threadPullRequestsOf>[0]),
        );
      }
  }
}

/** Whether the thread's latest run settled while background work it holds completion for still runs. */
export function awaitingOf(state: ThreadState): boolean {
  const background = state.background;
  if (background === undefined) return false;
  // Runs keep the order they started in; one remembered without its ordinal goes by that order.
  const runs = Object.entries(state.runs).map(([id, run], index) => ({
    id: RunId.make(id),
    ordinal: run.ordinal ?? index,
    status: run.status as OrchestrationV2Run["status"],
    ...(run.held ? { queueHeld: true } : {}),
  }));
  const tasks = derivePendingBackgroundWork({
    latestRun: latestUnheldRun(runs),
    providerThreads: Object.entries(background.rosters ?? {}).map(
      ([id, pendingBackgroundTasks]) => ({ id: ProviderThreadId.make(id), pendingBackgroundTasks }),
    ),
    turnItems: Object.entries(background.items ?? {}).map(([id, item]) => ({
      id,
      type: item.type,
      status: item.status,
      title: null,
      runId: item.runId,
      nativeItemRef: { nativeId: item.nativeId ?? null },
      ...(item.persistent ? { input: { persistent: true } } : {}),
      ...(item.monitor ? { monitor: true } : {}),
    })),
    activeProviderThreadId: background.provider ?? null,
    runs,
    pullRequests: Object.values(background.pullRequests ?? {}),
  });
  return backgroundWorkHoldsCompletion(tasks);
}
