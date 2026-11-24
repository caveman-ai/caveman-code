/**
 * One live turn against a real provider through the production path: the key
 * goes into the runtime's secret store, no engine overrides, the harness on the
 * loadout the model gets. Paid, so it runs only with CAVEMAN_LIVE_ENGINE=1 and
 * CAVEMAN_LIVE_OPENAI_KEY_FILE pointing at a file holding an OpenAI key. The key
 * is never printed. CAVEMAN_LIVE_OUT names a file that receives the turn summary.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@caveman-app/protocol";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CavemanSettings } from "../settings.ts";
import { makeCavemanAdapterV2 } from "./adapter.ts";
import { setCavemanKey } from "./credentials.ts";
import { cavemanHarnessRoot } from "./journal.ts";

const live = process.env.CAVEMAN_LIVE_ENGINE === "1";
const MODEL = process.env.CAVEMAN_LIVE_MODEL ?? "openai/gpt-5-nano";
const INSTANCE_ID = ProviderInstanceId.make("caveman");
const THREAD_ID = ThreadId.make("thread-caveman-live");
const workspace = mkdtempSync(join(tmpdir(), "caveman-live-ws-"));
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});
const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  TestProviderHost.layer({ cwd: workspace }).pipe(Layer.provide(NodeServices.layer)),
);

describe.skipIf(!live)("CavemanAdapterV2 live", () => {
  it.live(
    "runs one real turn with a command on the stored key",
    () =>
      Effect.gen(function* () {
        const keyFile = process.env.CAVEMAN_LIVE_OPENAI_KEY_FILE;
        assert.ok(keyFile, "CAVEMAN_LIVE_OPENAI_KEY_FILE is required");
        yield* setCavemanKey(INSTANCE_ID, "openai", readFileSync(keyFile!, "utf8").trim());
        const selection = { instanceId: INSTANCE_ID, model: MODEL };
        // Production defaults.
        const settings = Schema.decodeSync(CavemanSettings)({});
        const adapter = yield* makeCavemanAdapterV2({ instanceId: INSTANCE_ID, settings });
        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("provider-session-caveman-live"),
          modelSelection: selection,
          runtimePolicy,
        });
        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => seen.push(event)).pipe(Effect.andThen(Queue.offer(emitted, event)))),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({ threadId: THREAD_ID, modelSelection: selection, runtimePolicy });
        const now = yield* DateTime.now;
        const runId = RunId.make(`run:${THREAD_ID}:1`);
        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: THREAD_ID,
            projectId: "project:live:caveman" as OrchestrationV2AppThread["projectId"],
            title: "Caveman live",
            providerInstanceId: INSTANCE_ID,
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId: THREAD_ID,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
          rootNodeId: NodeId.make(`node:${runId}:root`),
          providerThread,
          message: {
            messageId: "message:live:1" as never,
            text: "Run the shell command `echo caveman-live-ok`, then reply with one short sentence that quotes its output.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: selection,
          runtimePolicy,
        });
        let terminal: ProviderAdapter.ProviderAdapterV2Event;
        while ((terminal = yield* Queue.take(emitted)).type !== "turn.terminal");

        const latest = new Map<string, unknown>();
        for (const event of seen) if (event.type === "turn_item.updated") latest.set(event.turnItem.id, event.turnItem);
        const items = [...latest.values()] as Array<Record<string, unknown>>;
        const turn = seen.flatMap((event) => (event.type === "provider_turn.updated" ? [event.providerTurn] : [])).at(-1)!;
        const host = yield* ProviderHost.ProviderHost;
        // The run's conversation checkpoint, as the journal keeps it.
        const head = turn.nativeTurnRef?.nativeId;
        const checkpoint = head === undefined ? undefined : (JSON.parse(readFileSync(join(cavemanHarnessRoot(host.paths.stateDir), `${head}.json`), "utf8")) as { loadout: string; messages: Array<unknown> });
        const summary = JSON.stringify(
            {
              model: MODEL,
              terminal: terminal.type === "turn.terminal" ? { status: terminal.status, failure: terminal.failure } : null,
              items: items.map((item) => ({
                type: item.type,
                status: item.status,
                ...(item.type === "command_execution" ? { input: item.input, exitCode: item.exitCode, output: item.output } : {}),
                ...(item.type === "assistant_message" || item.type === "reasoning" ? { text: item.text } : {}),
              })),
              tokenUsage: turn.tokenUsage,
              spend: turn.turnTokenUsage,
              nativeTurnRef: head,
              loadout: checkpoint?.loadout,
              journaledMessages: checkpoint?.messages.length,
            },
            null,
            2,
          );
        console.log(summary);
        if (process.env.CAVEMAN_LIVE_OUT) writeFileSync(process.env.CAVEMAN_LIVE_OUT, `${summary}\n`);
        assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
        const command = items.find((item) => item.type === "command_execution");
        assert.match(String(command?.output), /caveman-live-ok/);
        assert.ok((checkpoint?.messages.length ?? 0) >= 4, "the run is journaled");
        assert.ok((turn.turnTokenUsage?.inputTokens ?? 0) > 0, "the turn's spend is recorded");
      }).pipe(Effect.scoped, Effect.provide(layer)),
    180_000,
  );
});
