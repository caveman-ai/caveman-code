// ), apps/server/src/orchestration-v2/CommandOutputHub.test.ts @ a5d97921f6.
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnItemId,
} from "@caveman-app/protocol";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  normalizeTerminalOutput,
  TERMINAL_OUTPUT_TAIL_CHARS,
  type TerminalOutputState,
} from "@caveman-app/shared/terminalOutput";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { createScrubber } from "@caveman-app/session-protocol";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeCommandOutputScrub } from "../session-protocol/secrets.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStoreWithV1.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerTest = Layer.mergeAll(
  layerTestEventSink,
  IdAllocator.layer,
  CommandOutputHub.layer.pipe(Layer.provide(Layer.merge(layerTestEventSink, layerTestStores))),
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const ITEM_ID = TurnItemId.make("turn-item:command");

/** What a client holds after applying frames, using the same shared normalizer. */
function applyFrame(
  state: TerminalOutputState,
  frame: OrchestrationV2CommandOutputFrame,
): TerminalOutputState {
  return frame.kind === "replace"
    ? appendTerminalOutput({ ...EMPTY_TERMINAL_OUTPUT, truncated: frame.truncated }, frame.text)
    : appendTerminalOutput(state, frame.text);
}

const seedThread = Effect.gen(function* () {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const projectId = yield* idAllocator.allocate.project({ fixtureName: "command-output" });
  const threadId = yield* idAllocator.allocate.thread({ fixtureName: "command-output", projectId });
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Command output",
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    branchPullRequest: null,
    activeOrderKey: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* eventSink.write({
    events: [
      {
        id: yield* idAllocator.allocate.event({ threadId }),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  return threadId;
});

const writeCommandItem = (
  threadId: ThreadId,
  fields: Pick<
    Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
    "status" | "output" | "exitCode"
  >,
) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const settled = fields.status !== "running";
    const item: OrchestrationV2TurnItem = {
      id: ITEM_ID,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      title: null,
      startedAt: now,
      completedAt: settled ? now : null,
      updatedAt: now,
      type: "command_execution",
      input: "yes | head -n 1000000",
      ...fields,
    };
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "turn-item.updated",
          threadId,
          driver: CODEX_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: item,
        },
      ],
    });
  });

/** Collect frames into a queue so the test takes them one receipt at a time. */
const subscribeFrames = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const hub = yield* CommandOutputHub.CommandOutputHub;
    const frames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame | "ended">();
    yield* hub.subscribe({ threadId, itemId: ITEM_ID }).pipe(
      Stream.runForEach((frame) => Queue.offer(frames, frame)),
      Effect.andThen(Queue.offer(frames, "ended")),
      Effect.forkScoped,
    );
    return frames;
  });

const takeFrame = (frames: Queue.Queue<OrchestrationV2CommandOutputFrame | "ended">) =>
  Queue.take(frames).pipe(
    Effect.flatMap((frame) =>
      frame === "ended" ? Effect.die("command output stream ended early") : Effect.succeed(frame),
    ),
  );

const layer = it.layer(layerTest);

layer("CommandOutputHub", (it) => {
  it.effect(
    "a late subscriber gets the running tail, then live appends, then the final output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* CommandOutputHub.CommandOutputHub;
          const threadId = yield* seedThread;
          yield* writeCommandItem(threadId, { status: "running" });
          // Output that arrived before anyone looked, ending mid-escape and mid-redraw.
          yield* hub.append({
            threadId,
            itemId: ITEM_ID,
            chunk: "\u001b[32mbuilding\u001b[0m\n10%",
          });
          yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "\r55%\u001b[3" });

          const frames = yield* subscribeFrames(threadId);
          const first = yield* takeFrame(frames);
          assert.equal(first.kind, "replace");
          assert.isTrue(first.running);
          let client = applyFrame(EMPTY_TERMINAL_OUTPUT, first);
          assert.equal(client.text, "\u001b[0;32mbuilding\u001b[0m\n55%");

          // Chunks that land between frames arrive together in one append.
          yield* TestClock.adjust("1 second");
          yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "1m" });
          yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "\r100%\u001b[0m\ndone\n" });
          const append = yield* takeFrame(frames);
          assert.equal(append.kind, "append");
          client = applyFrame(client, append);
          assert.equal(
            client.text,
            normalizeTerminalOutput(
              "\u001b[32mbuilding\u001b[0m\n10%\r55%\u001b[31m\r100%\u001b[0m\ndone\n",
            ).text,
          );

          // The persisted item settles the row; its output is what the client keeps.
          yield* TestClock.adjust("1 second");
          yield* writeCommandItem(threadId, {
            status: "completed",
            exitCode: 0,
            output: "building\n100%\ndone\n",
          });
          const final = yield* takeFrame(frames);
          assert.deepEqual(final, {
            kind: "replace",
            text: "building\n100%\ndone\n",
            truncated: false,
            running: false,
          });
          assert.equal(yield* Queue.take(frames), "ended");
        }),
      ),
  );

  it.effect("a row that is not a known command fails instead of waiting forever", () =>
    Effect.gen(function* () {
      const hub = yield* CommandOutputHub.CommandOutputHub;
      const threadId = yield* seedThread;
      const error = yield* hub
        .subscribe({ threadId, itemId: ITEM_ID })
        .pipe(Stream.runDrain, Effect.flip);
      assert.equal(error._tag, "OrchestrationV2CommandOutputError");
      assert.equal(error.message, "No such command.");
    }),
  );

  it.effect("a viewer whose command was evicted for newer ones is resynced, not appended to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* CommandOutputHub.CommandOutputHub;
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, { status: "running" });
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "abc" });
        const frames = yield* subscribeFrames(threadId);
        let client = applyFrame(EMPTY_TERMINAL_OUTPUT, yield* takeFrame(frames));
        assert.equal(client.text, "abc");
        // 64 newer commands push this one's tail out of the hub.
        for (let index = 0; index < 64; index += 1) {
          yield* hub.append({
            threadId,
            itemId: TurnItemId.make(`turn-item:other-${index}`),
            chunk: "x",
          });
        }
        yield* TestClock.adjust("1 second");
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "\rX" });
        const next = yield* takeFrame(frames);
        assert.equal(next.kind, "replace");
        client = applyFrame(client, next);
        assert.equal(client.text, "X");
      }),
    ),
  );

  it.effect("every viewer of one command reconstructs the same text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* CommandOutputHub.CommandOutputHub;
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, { status: "running" });
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "first\n" });
        const viewers = [yield* subscribeFrames(threadId), yield* subscribeFrames(threadId)];
        const states = [EMPTY_TERMINAL_OUTPUT, EMPTY_TERMINAL_OUTPUT];
        for (const [index, frames] of viewers.entries()) {
          states[index] = applyFrame(states[index]!, yield* takeFrame(frames));
        }
        yield* TestClock.adjust("1 second");
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "second\r\nthird" });
        for (const [index, frames] of viewers.entries()) {
          states[index] = applyFrame(states[index]!, yield* takeFrame(frames));
        }
        assert.equal(states[0]!.text, "first\nsecond\nthird");
        assert.equal(states[1]!.text, states[0]!.text);
      }),
    ),
  );

  it.effect("a flood is sent as bounded tails at a slower rate, not as every chunk", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* CommandOutputHub.CommandOutputHub;
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, { status: "running" });
        const stamped = yield* Queue.unbounded<{
          readonly frame: OrchestrationV2CommandOutputFrame;
          readonly at: number;
        }>();
        yield* hub.subscribe({ threadId, itemId: ITEM_ID }).pipe(
          Stream.runForEach((frame) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((at) => Queue.offer(stamped, { frame, at })),
            ),
          ),
          Effect.forkScoped,
        );
        let client = applyFrame(EMPTY_TERMINAL_OUTPUT, (yield* Queue.take(stamped)).frame);
        yield* TestClock.adjust("1 second");

        // `yes | head -n 1000000`: 2 MB in 4 KB chunks, 64 KB every 100 ms.
        const chunk = "y\n".repeat(2_048);
        const sent: Array<{
          readonly frame: OrchestrationV2CommandOutputFrame;
          readonly at: number;
        }> = [];
        const drain = Effect.gen(function* () {
          for (const entry of yield* Queue.clear(stamped)) {
            sent.push(entry);
            client = applyFrame(client, entry.frame);
          }
        });
        for (let tick = 0; tick < 32; tick += 1) {
          for (let index = 0; index < 16; index += 1) {
            yield* hub.append({ threadId, itemId: ITEM_ID, chunk });
          }
          yield* TestClock.adjust(CommandOutputHub.COMMAND_OUTPUT_FRAME_INTERVAL_MS);
          yield* drain;
        }
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "tail\n" });
        yield* TestClock.adjust("1 second");
        yield* drain;

        const bytes = sent.reduce((total, { frame }) => total + frame.text.length, 0);
        // 3.2 s of flooding: a frame per chunk would be 512 frames and 2 MB.
        assert.isAtMost(sent.length, 10);
        assert.isAtMost(bytes, 10 * TERMINAL_OUTPUT_TAIL_CHARS);
        // A replace also carries the fixed lines the tail hides behind the window, at most a second tail.
        for (const { frame } of sent) {
          assert.isAtMost(frame.text.length, 2 * TERMINAL_OUTPUT_TAIL_CHARS);
        }
        for (let index = 1; index < sent.length; index += 1) {
          if (sent[index - 1]!.frame.kind === "replace") {
            assert.isAtLeast(
              sent[index]!.at - sent[index - 1]!.at,
              CommandOutputHub.COMMAND_OUTPUT_REPLACE_INTERVAL_MS,
            );
          }
        }
        assert.isTrue(client.truncated);
        assert.isTrue(client.text.endsWith("y\ny\ntail\n"));
        assert.isAtMost(client.text.length, TERMINAL_OUTPUT_TAIL_CHARS);
      }),
    ),
  );

  it.effect("a finished command sends only its bounded final output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* seedThread;
        const huge = Array.from({ length: 400_000 }, (_, index) => `line ${index}`).join("\n");
        yield* writeCommandItem(threadId, { status: "failed", exitCode: 1, output: huge });
        const frames = yield* subscribeFrames(threadId);
        const final = yield* takeFrame(frames);
        assert.equal(final.kind, "replace");
        assert.isFalse(final.running);
        assert.isTrue(final.truncated);
        assert.isAtMost(final.text.length, TERMINAL_OUTPUT_TAIL_CHARS);
        assert.isTrue(final.text.endsWith("line 399999"));
        assert.equal(yield* Queue.take(frames), "ended");
      }),
    ),
  );

  it.effect("a finished command whose output is one huge line still shows its tail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* seedThread;
        const line = "x".repeat(TERMINAL_OUTPUT_TAIL_CHARS * 8);
        yield* writeCommandItem(threadId, {
          status: "completed",
          exitCode: 0,
          output: `${line}\n`,
        });
        const frames = yield* subscribeFrames(threadId);
        const final = yield* takeFrame(frames);
        assert.equal(final.kind, "replace");
        assert.isTrue(final.truncated);
        assert.isTrue(final.text.includes("xxxx"));
        assert.isAtMost(final.text.length, TERMINAL_OUTPUT_TAIL_CHARS);
      }),
    ),
  );

  // Session Protocol's tool.watch and /ws subscribeCommandOutput scrub the hub's frames this way.
  it.effect.each([
    { row: "a running command's tail", style: "" },
    { row: "a running command's coloured tail", style: "\u001b[31m" },
    { row: "a finished command's output", style: "" },
  ])(
    "a viewer never sees the part of a secret the window of $row starts inside",
    ({ row, style }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* CommandOutputHub.CommandOutputHub;
          const threadId = yield* seedThread;
          const value = "sk-live-4f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d";
          const scrub = makeCommandOutputScrub(() => createScrubber([{ name: "API_KEY", value }]));
          // One line longer than the window, as a minified JSON dump prints it: the window starts inside the key.
          const lead = row === "a finished command's output" ? 300_000 : 1_000;
          const output = `${style}${"x".repeat(lead)}${value}${"y".repeat(TERMINAL_OUTPUT_TAIL_CHARS - value.length + 10)}`;
          if (row === "a finished command's output") {
            yield* writeCommandItem(threadId, { status: "completed", exitCode: 0, output });
          } else {
            yield* writeCommandItem(threadId, { status: "running" });
            for (let at = 0; at < output.length; at += 4096) {
              yield* hub.append({ threadId, itemId: ITEM_ID, chunk: output.slice(at, at + 4096) });
            }
          }
          const frames = yield* subscribeFrames(threadId);
          const first = yield* takeFrame(frames);
          assert.equal(first.kind, "replace");
          assert.isTrue(first.truncated);
          // Without its scrub the window begins with the rest of the key.
          assert.notInclude(first.text, value.slice(0, 10));
          assert.include(first.text.slice(0, 40), value.slice(-20));
          const shown = scrub(first).text + (first.running ? scrub.idle() : "");
          for (let at = 0; at + 8 <= value.length; at++) {
            assert.notInclude(shown, value.slice(at, at + 8));
          }
          assert.isTrue(
            shown.startsWith(`${first.text.startsWith("\u001b") ? "\u001b[0;31m" : ""}[secret]y`),
          );
          assert.include(shown, "y".repeat(TERMINAL_OUTPUT_TAIL_CHARS - value.length));
        }),
      ),
  );

  it.effect("an old Claude row's raw Bash result shows as its stdout and stderr", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, {
          status: "completed",
          exitCode: 0,
          output: '{"stdout":"built","stderr":"1 warning","interrupted":false}',
        });
        const frames = yield* subscribeFrames(threadId);
        const final = yield* takeFrame(frames);
        assert.equal(final.text, "built\n1 warning");
      }),
    ),
  );

  it.effect("providers that only report output in item snapshots still stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, { status: "running", output: "step 1\n" });
        const frames = yield* subscribeFrames(threadId);
        assert.equal((yield* takeFrame(frames)).text, "step 1\n");
        yield* TestClock.adjust("1 second");
        yield* writeCommandItem(threadId, { status: "running", output: "step 1\nstep 2\n" });
        const update = yield* takeFrame(frames);
        assert.deepEqual(update, {
          kind: "replace",
          text: "step 1\nstep 2\n",
          truncated: false,
          running: true,
        });
      }),
    ),
  );

  it.effect("an interrupted command ends the stream with the output it printed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* CommandOutputHub.CommandOutputHub;
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, { status: "running" });
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "waiting for server\n" });
        const frames = yield* subscribeFrames(threadId);
        yield* takeFrame(frames);
        yield* TestClock.adjust("1 second");
        // Some providers stop a command without reporting its output. The session
        // manager releases the live tail before the settled item is persisted.
        yield* hub.finish({ threadId, itemId: ITEM_ID });
        yield* writeCommandItem(threadId, { status: "interrupted" });
        const final = yield* takeFrame(frames);
        assert.deepEqual(final, {
          kind: "replace",
          text: "waiting for server\n",
          truncated: false,
          running: false,
        });
        assert.equal(yield* Queue.take(frames), "ended");
      }),
    ),
  );
});
