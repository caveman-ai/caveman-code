// ), apps/server/src/provider/CodexThreadRevert.test.ts @ ab3a3cd1.
import { assert, it } from "@effect/vitest";
import * as CodexClient from "@caveman-app/codex-app-server/client";
import * as CodexReplay from "@caveman-app/codex-app-server/replay";
import * as Effect from "effect/Effect";

import { revertCodexThread, revertCodexThreadFrom } from "./CodexThreadRevert.ts";

const page = (
  id: number,
  cursor: string | null,
  limit: number,
  turns: string[],
  nextCursor: string | null,
) => [
  {
    type: "expect_outbound" as const,
    frame: {
      id,
      method: "thread/turns/list",
      params: {
        threadId: "thread",
        cursor,
        limit,
        sortDirection: "desc",
        itemsView: "summary",
      },
    },
  },
  {
    type: "emit_inbound" as const,
    frame: {
      id,
      result: {
        data: turns.map((id) => ({ id, items: [], status: "completed", error: null })),
        nextCursor,
      },
    },
  },
];

it.effect("finds the revert boundary across pages of newest-first turns", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    // The final request reaches the server with the third-newest turn, not a turn on the first page.
    assert.equal(result.message, "boundary reached");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-pages",
        entries: [
          ...page(1, null, 3, ["newest", "middle"], "older"),
          ...page(2, "older", 1, ["boundary"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 3,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "boundary" },
            },
          },
          {
            type: "emit_inbound",
            frame: { id: 3, error: { code: -32603, message: "boundary reached" } },
          },
        ],
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("rejects repeated cursors instead of looping or reverting incomplete history", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    assert.equal(result.message, "Thread history pagination repeated a cursor.");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-loop",
        entries: [...page(1, null, 3, ["newest"], "again"), ...page(2, "again", 2, [], "again")],
      }),
    ),
    Effect.scoped,
  ),
);

const replyWithError = (id: number, method: string, params: object, message: string) => [
  { type: "expect_outbound" as const, frame: { id, method, params } },
  { type: "emit_inbound" as const, frame: { id, error: { code: -32603, message } } },
];

it.effect("reads past the newest turns to the first dropped turn Codex still holds", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadFrom(client, "thread", {
      firstTurnId: "dropped",
      turnCount: 2,
    }).pipe(Effect.flip);
    assert.equal(result.message, "reverted before the dropped turn");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-from-unrecorded",
        entries: [
          // A turn the app never recorded as finished sits newer than the boundary.
          ...page(1, null, 2, ["unrecorded", "newest"], "older"),
          ...page(2, "older", 100, ["dropped", "kept"], null),
          ...replyWithError(
            3,
            "thread/revert",
            { threadId: "thread", beforeTurnId: "dropped" },
            "reverted before the dropped turn",
          ),
        ],
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("leaves the thread alone once an earlier attempt reverted the first dropped turn", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadFrom(client, "thread", {
      firstTurnId: "dropped",
      turnCount: 3,
    }).pipe(Effect.flip);
    assert.equal(result.message, "read without reverting");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-from-retried",
        entries: [
          ...page(1, null, 3, ["kept"], null),
          ...replyWithError(
            2,
            "thread/read",
            { threadId: "thread", includeTurns: false },
            "read without reverting",
          ),
        ],
      }),
    ),
    Effect.scoped,
  ),
);
