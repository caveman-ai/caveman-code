// ), apps/server/src/provider/CodexThreadRevert.ts @ ab3a3cd1.
import type * as CodexSchema from "@caveman-app/codex-app-server/schema";
import type * as CodexClient from "@caveman-app/codex-app-server/client";
import * as CodexErrors from "@caveman-app/codex-app-server/errors";
import * as Effect from "effect/Effect";

/** Codex 0.156 replaces count-based rollback with a boundary in paginated history. */
export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  numTurns: number,
) {
  let remaining = numTurns;
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (remaining > 0) {
    if (visited.has(cursor)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: Math.min(remaining, 100),
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      beforeTurnId = turn.id;
      if (--remaining === 0) break;
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) break;
  }
  return beforeTurnId === undefined
    ? yield* client.request("thread/read", { threadId, includeTurns: false })
    : yield* client.request("thread/revert", { threadId, beforeTurnId });
});

/**
 * Reverts the thread before `firstTurnId`, the oldest turn a rollback drops, which Codex should
 * list as the `turnCount`-th newest. When that turn is gone, an earlier attempt of the same
 * rollback already reverted it, so the thread is left alone; a count from the head would cut the
 * turns that attempt kept.
 */
export const revertCodexThreadFrom = Effect.fn("revertCodexThreadFrom")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  boundary: { readonly firstTurnId: string; readonly turnCount: number },
) {
  let listed = 0;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (true) {
    if (visited.has(cursor)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
    visited.add(cursor);
    // Codex can hold turns the app never recorded as finished; they sit newer than the boundary
    // and push it further back, so the walk reads on past where the boundary should be.
    const expected = boundary.turnCount - listed;
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: expected > 0 ? Math.min(expected, 100) : 100,
      sortDirection: "desc",
      itemsView: "summary",
    });
    if (page.data.some((turn) => turn.id === boundary.firstTurnId)) {
      return yield* client.request("thread/revert", {
        threadId,
        beforeTurnId: boundary.firstTurnId,
      });
    }
    listed += page.data.length;
    cursor = page.nextCursor ?? null;
    if (cursor === null) {
      return yield* client.request("thread/read", { threadId, includeTurns: false });
    }
  }
});
