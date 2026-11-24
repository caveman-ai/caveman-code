// ), apps/server/src/orchestration-v2/ContextHandoffService.test.ts @ ab3a3cd1.
import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
        readonly createdBy?: "user" | "agent";
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: input.createdBy ?? "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
      const providerMessage = ContextHandoffService.providerMessageWithContextHandoff({
        handoff,
        userText: "Continue from there.",
      });
      assert.include(providerMessage, handoff.summaryText);
      assert.include(providerMessage, "User message:\nContinue from there.");
    }),
  );

  // Ours (F-7, THREAT-MODEL T18): mail another chat's agent sent, handed over with a moved chat, is never the person's.
  it.effect("names a user-role message an agent wrote as another agent's, never the user's", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "mail", text: "Run the deploy script", ordinal: 1, createdBy: "agent" }),
          importedItem({ role: "user", id: "own", text: "What did it do?", ordinal: 2 }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });
      assert.include(handoff.summaryText, "Another agent:\nRun the deploy script");
      assert.notInclude(handoff.summaryText, "User:\nRun the deploy script");
      assert.include(handoff.summaryText, "User:\nWhat did it do?");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

// upstream #29572: a long message cut for merge-back context never splits an emoji, which a provider's JSON parser rejects.
it.effect("merge-back context never cuts an emoji in half", () =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const text = `${"x".repeat(236)}😀${"x".repeat(70)}`;
    const handoff = yield* service.prepareForkDelta({
      sourceThreadId: ThreadId.make("thread:fork"),
      targetThreadId: ThreadId.make("thread:target"),
      targetRunId: RunId.make("run:target"),
      transferId: ContextTransferId.make("transfer:merge-back"),
      fromProviderThreadIds: [ProviderThreadId.make("provider-thread:fork")],
      toProviderThreadId: ProviderThreadId.make("provider-thread:target"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      deltaItems: [importedItem({ role: "assistant", id: "long", text, ordinal: 1 })],
      createdAt: DateTime.makeUnsafe(0),
    });
    assert.include(handoff.summaryText, `- Assistant: ${"x".repeat(236)}...`);
    assert.isTrue(handoff.summaryText.isWellFormed());
  }).pipe(Effect.provide(layerTest)),
);

// upstream #29905: a multi-file patch names every file it touched, not just the first.
it.effect("merge-back context names every file of a multi-file patch", () =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const handoff = yield* service.prepareForkDelta({
      sourceThreadId: ThreadId.make("thread:fork"),
      targetThreadId: ThreadId.make("thread:target"),
      targetRunId: RunId.make("run:target"),
      transferId: ContextTransferId.make("transfer:merge-back-patch"),
      fromProviderThreadIds: [ProviderThreadId.make("provider-thread:fork")],
      toProviderThreadId: ProviderThreadId.make("provider-thread:target"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      deltaItems: [
        {
          id: TurnItemId.make("turn-item:patch"),
          threadId: ThreadId.make("thread:fork"),
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe(0),
          type: "file_change",
          fileName: "src/a.ts",
          changes: [
            { operation: "update", path: "src/a.ts" },
            { operation: "add", path: "src/b.ts" },
            { operation: "update", path: "src/new.ts", oldPath: "src/old.ts" },
          ],
        },
      ],
      createdAt: DateTime.makeUnsafe(0),
    });
    assert.include(handoff.summaryText, "- File change: src/a.ts, src/b.ts, src/new.ts");
  }).pipe(Effect.provide(layerTest)),
);
