// The board follows the pull requests of the chats the Chiefs started, so an item with a pull request never looks
// stuck: merged moves it to done; closed without merging, failing checks or changes requested flag it as needing the
// person (Board.pullRequest). It adds no host reads of its own: the runtime already keeps each chat's pull request
// current (session-protocol/pullRequests.ts: upstream batched sync of linked pull requests, with its backoff, and the
// branch lookup), and publishes the workspace only when the pull request changed, so this hears only real changes.
// A change that moves the item to done or needs_you, or makes a review item's pull request ready (Board.pullRequestNews),
// is handed to the watcher (watch.ts), which wakes the Chief once for it with the rest of that quiet spell's changes,
// as its update level lets it (chief/updates.ts); an unchanged poll wakes nobody.
import type { Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import type { SessionStore } from "../session-protocol/store.ts";
import * as Board from "./Board.ts";
import type { BoardStore } from "./store.ts";

export interface PullRequestFollowerContext {
  readonly store: Pick<SessionStore["Service"], "workspaceChanges" | "getWorkspace">;
  readonly board: Pick<BoardStore, "update" | "itemOfWorkspace" | "all">;
  /** A chat whose item moved for its pull request: its Chief hears it with the watcher's next wake. */
  readonly changed: (workspaceId: string) => Effect.Effect<void>;
  /**
   * Where the item's chats stand (watch.ts): the others, and this one while it still works. A merge closes the item
   * only once they are all done.
   */
  readonly chats?: (item: Board.Item, workspaceId: string) => Effect.Effect<ReadonlyArray<Board.Outcome>>;
}

/** One chat's pull request onto its item, if it has one. True when its Chief should hear of it (Board.pullRequestNews). */
export const applyPullRequest = (ctx: Pick<PullRequestFollowerContext, "board" | "chats">, workspace: Workspace) =>
  Effect.gen(function* () {
    const pr = workspace.pull_request;
    if (workspace.kind !== undefined || pr === undefined) return false;
    const itemId = yield* ctx.board.itemOfWorkspace(workspace.id);
    if (itemId === undefined) return false;
    return yield* ctx.board.update("pull_request", (items) =>
      Effect.gen(function* () {
        const item = items.find((i) => i.id === itemId);
        if (item === undefined) return { write: [], value: false };
        const chats = pr.state === "merged" && ctx.chats !== undefined ? yield* ctx.chats(item, workspace.id) : [];
        const next = Board.pullRequest(item, pr, new Date().toISOString(), chats);
        return next === item ? { write: [], value: false } : { write: [next], value: Board.pullRequestNews(item, next) };
      }),
    );
  });

/**
 * Runs for the route's life: first every running item's chats as they stand (a pull request merged while the runtime
 * was down moves its item now), then each workspace the runtime publishes. Subscribed before the catch-up, so nothing
 * in between is missed.
 */
export const followPullRequests = (ctx: PullRequestFollowerContext) =>
  Effect.gen(function* () {
    const sub = yield* PubSub.subscribe(ctx.store.workspaceChanges);
    const apply = (workspace: Workspace) =>
      applyPullRequest(ctx, workspace).pipe(
        Effect.flatMap((news) => (news ? ctx.changed(workspace.id) : Effect.void)),
        Effect.catchCause((cause) => Effect.logWarning("chief: pull request not followed", cause)),
      );
    for (const item of yield* ctx.board.all) {
      if (!Board.RUNNING_STATES.has(item.state)) continue;
      for (const id of item.workspace_ids) {
        const record = yield* ctx.store.getWorkspace(id);
        if (record !== undefined) yield* apply(record.workspace);
      }
    }
    while (true) yield* apply(yield* PubSub.take(sub));
  }).pipe(Effect.scoped);
