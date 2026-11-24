import { assert, describe, it } from "@effect/vitest";
import type {
  OrchestrationV2CommandOutputFrame,
  TerminalAttachStreamEvent,
  TerminalEvent,
} from "@caveman-app/protocol";
import { createScrubber } from "@caveman-app/session-protocol";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  LIVE_OUTPUT_FLUSH_MS,
  scrubCommandOutput,
  scrubForClient,
  scrubTerminalEvents,
  sharedTerminalEvents,
} from "./ClientScrub.ts";

const SECRET = ("sk_" + "live_51NcQ7xZ9wTqLm3Rb8KvYp2Hd");
const scrubber = createScrubber([{ name: "STRIPE_SECRET_KEY", value: SECRET }]);

const running = (kind: "replace" | "append", text: string): OrchestrationV2CommandOutputFrame => ({
  kind,
  text,
  truncated: false,
  running: true,
});

/** The frames a client gets from `scrubCommandOutput` over a source the test feeds, and the text they add up to. */
const watch = Effect.gen(function* () {
  const source = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
  const frames: Array<OrchestrationV2CommandOutputFrame> = [];
  yield* scrubCommandOutput(Stream.fromQueue(source), Effect.succeed(scrubber)).pipe(
    Stream.runForEach((frame) => Effect.sync(() => void frames.push(frame))),
    Effect.forkScoped,
  );
  const settle = TestClock.adjust(0);
  return {
    frames,
    text: () => frames.map((frame) => frame.text).join(""),
    print: (frame: OrchestrationV2CommandOutputFrame) =>
      Queue.offer(source, frame).pipe(Effect.andThen(settle)),
    wait: (millis: number) => TestClock.adjust(millis),
  };
});

describe("live command output scrub", () => {
  it.effect("sends a held-back tail once the command has been quiet, not before", () =>
    Effect.gen(function* () {
      const row = yield* watch;
      // "s" could begin the stored value, so the scrub holds it.
      yield* row.print(running("replace", "Deploying to s"));
      assert.equal(row.text(), "Deploying to ");
      yield* row.wait(LIVE_OUTPUT_FLUSH_MS - 1);
      assert.equal(row.text(), "Deploying to ");
      yield* row.wait(1);
      assert.equal(row.text(), "Deploying to s");
      assert.deepEqual(row.frames.at(-1), running("append", "s"));
    }),
  );

  it.effect(
    "loses nothing that arrives while it waits, and still masks a value split across frames",
    () =>
      Effect.gen(function* () {
        const row = yield* watch;
        yield* row.print(running("replace", `key=${SECRET.slice(0, 12)}`));
        yield* row.wait(LIVE_OUTPUT_FLUSH_MS - 10);
        yield* row.print(running("append", `${SECRET.slice(12)} ok\n`));
        yield* row.wait(LIVE_OUTPUT_FLUSH_MS * 2);
        assert.equal(row.text(), "key=[secret:STRIPE_SECRET_KEY] ok\n");
      }),
  );

  it.effect("ends with the source, masking a value the last frame cut off", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame, Cause.Done>();
      const fiber = yield* scrubCommandOutput(
        Stream.fromQueue(source),
        Effect.succeed(scrubber),
      ).pipe(Stream.runCollect, Effect.forkScoped);
      yield* Queue.offer(source, running("replace", "a"));
      yield* Queue.offer(source, {
        kind: "append",
        text: ` ${SECRET.slice(0, 12)}`,
        truncated: false,
        running: false,
      });
      yield* Queue.end(source);
      const frames = yield* Fiber.join(fiber);
      assert.equal(frames.map((frame) => frame.text).join(""), "a [secret]");
      assert.isFalse(frames.at(-1)!.running);
    }),
  );
});

describe("a read sent to a client", () => {
  it("masks every string it holds, keys too, and keeps what the wire encoder needs", () => {
    const at = DateTime.makeUnsafe("2026-11-06T00:00:00.000Z");
    const read = {
      item: {
        output: `KEY=${SECRET}`,
        startedAt: at,
        exitCode: 0,
        tags: ["ok", SECRET],
        [SECRET]: null,
      },
      untouched: { title: "Deploy", at },
    };
    const sent = scrubForClient(scrubber, read);
    assert.deepEqual(sent.item.tags, ["ok", "[secret:STRIPE_SECRET_KEY]"]);
    assert.equal(sent.item.output, "KEY=[secret:STRIPE_SECRET_KEY]");
    assert.deepEqual(Object.keys(sent.item), [
      "output",
      "startedAt",
      "exitCode",
      "tags",
      "[secret:STRIPE_SECRET_KEY]",
    ]);
    assert.strictEqual(sent.item.startedAt, at);
    assert.strictEqual(sent.untouched, read.untouched);
    assert.notInclude(JSON.stringify(sent), SECRET);
  });

  it("keeps every string within the length it had, losing mask names before any text", () => {
    const password = "Pw9x!secr3tZ";
    const long = ("sk_" + "test_51NzQx2LkP0aB9cD8eF7gH6iJ5kL4mN3oP2qR1sT0u");
    const short = createScrubber([
      { name: "POSTGRES_PASSWORD", value: password },
      { name: "STRIPE_SECRET_KEY", value: long },
    ]);
    // The long value's mask is shorter than it, which leaves room for the short value's name.
    assert.equal(
      scrubForClient(short, `${long} then ${password}`),
      "[secret:STRIPE_SECRET_KEY] then [secret:POSTGRES_PASSWORD]",
    );
    // Not for two: the last mask loses its name, and only it.
    const tight = `${long} a ${password} b ${password} c…`;
    const sent = scrubForClient(short, { message: tight, [tight]: true });
    assert.equal(
      sent.message,
      "[secret:STRIPE_SECRET_KEY] a [secret:POSTGRES_PASSWORD] b [secret] c…",
    );
    assert.isAtMost(sent.message.length, tight.length);
    assert.deepEqual(Object.keys(sent), ["message", sent.message]);
    assert.equal(scrubForClient(short, `${password}${password}`), "[secret][secret]");
  });

  it("masks a value the runtime's cut fell inside, and only at a cut", () => {
    assert.equal(scrubForClient(scrubber, `failed: ${SECRET.slice(0, 20)}…`), "failed: [secret]…");
    assert.equal(
      scrubForClient(scrubber, `KEY=${SECRET.slice(0, 9)}\n… output truncated for transport`),
      "KEY=[secret]\n… output truncated for transport",
    );
    // Too short to be a value's start a viewer could use, as a terminal's pause shows it.
    assert.equal(scrubForClient(scrubber, `${SECRET.slice(0, 7)}…`), `${SECRET.slice(0, 7)}…`);
    // A text that was not cut ends where it ends.
    assert.equal(
      scrubForClient(scrubber, `prefix ${SECRET.slice(0, 20)}`),
      `prefix ${SECRET.slice(0, 20)}`,
    );
    const whole = { message: `done: ${SECRET} …` };
    assert.equal(scrubForClient(scrubber, whole).message, "done: [secret:STRIPE_SECRET_KEY] …");
  });

  it("is the same value when nothing in it is a secret", () => {
    const read = { matches: [{ snippet: "nothing to hide", at: DateTime.makeUnsafe(0) }] };
    assert.strictEqual(scrubForClient(scrubber, read), read);
  });
});

const terminal = { threadId: "thread-1", terminalId: "default" };
const snapshot = (history: string): Extract<TerminalAttachStreamEvent, { type: "snapshot" }> => ({
  type: "snapshot",
  snapshot: {
    ...terminal,
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 1,
    history,
    exitCode: null,
    exitSignal: null,
    label: "zsh",
    updatedAt: "2026-11-06T00:00:00.000Z",
  },
});
const output = (data: string): Extract<TerminalAttachStreamEvent, { type: "output" }> => ({
  type: "output",
  ...terminal,
  data,
});

/** What a terminal client draws from `scrubTerminalEvents` over events the test feeds. */
const attach = Effect.gen(function* () {
  const source = yield* Queue.unbounded<TerminalAttachStreamEvent>();
  const events: Array<TerminalAttachStreamEvent> = [];
  yield* scrubTerminalEvents(Stream.fromQueue(source), Effect.succeed(scrubber)).pipe(
    Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
    Effect.forkScoped,
  );
  return {
    events,
    screen: () =>
      events
        .map((event) =>
          event.type === "snapshot"
            ? event.snapshot.history
            : event.type === "output"
              ? event.data
              : "",
        )
        .join(""),
    send: (event: TerminalAttachStreamEvent) =>
      Queue.offer(source, event).pipe(Effect.andThen(TestClock.adjust(0))),
  };
});

describe("live terminal scrub", () => {
  it.effect("catches a value the scrollback ends inside, even across a pause", () =>
    Effect.gen(function* () {
      const client = yield* attach;
      yield* client.send(snapshot(`$ echo $KEY\r\n${SECRET.slice(0, 10)}`));
      yield* TestClock.adjust(LIVE_OUTPUT_FLUSH_MS * 4);
      yield* client.send(output(`${SECRET.slice(10)}\r\n$ `));
      assert.equal(client.screen(), "$ echo $KEY\r\n[secret:STRIPE_SECRET_KEY]\r\n$ ");
    }),
  );

  it.effect("shows a short held echo once the terminal pauses", () =>
    Effect.gen(function* () {
      const client = yield* attach;
      yield* client.send(snapshot("$ "));
      // A typed "s" could begin the value; it shows once the terminal is quiet.
      yield* client.send(output("s"));
      assert.equal(client.screen(), "$ ");
      yield* TestClock.adjust(LIVE_OUTPUT_FLUSH_MS);
      assert.equal(client.screen(), "$ s");
    }),
  );

  it.effect("masks a value the exit cut off, before the exit", () =>
    Effect.gen(function* () {
      const client = yield* attach;
      yield* client.send(snapshot(""));
      yield* client.send(output(`token ${SECRET.slice(0, 12)}`));
      yield* client.send({ type: "exited", ...terminal, exitCode: 1, exitSignal: null });
      assert.equal(client.screen(), "token [secret]");
      assert.deepEqual(
        client.events.map((event) => event.type),
        ["snapshot", "output", "output", "exited"],
      );
    }),
  );

  it.effect("keeps every event's sequence, in order, while it holds text back", () =>
    Effect.gen(function* () {
      const client = yield* attach;
      yield* client.send({
        ...snapshot("$ "),
        snapshot: { ...snapshot("$ ").snapshot, sequence: 1 },
      });
      yield* client.send({ ...output("ok "), sequence: 2 });
      // All of it could begin the value.
      yield* client.send({ ...output(SECRET.slice(0, 4)), sequence: 3 });
      yield* client.send({ ...output(`${SECRET.slice(4)} done`), sequence: 4 });
      assert.deepEqual(
        client.events.flatMap((event) =>
          event.type === "output" ? [[event.sequence, event.data]] : [],
        ),
        [
          [2, "ok "],
          [3, ""],
          [4, "[secret:STRIPE_SECRET_KEY] done"],
        ],
      );
      // What a pause lets out is the rest of an event already sent, not a new one.
      yield* client.send({ ...output(" s"), sequence: 5 });
      yield* TestClock.adjust(LIVE_OUTPUT_FLUSH_MS);
      assert.deepEqual(client.events.at(-1), output("s"));
    }),
  );

  it.effect("starts over after a clear", () =>
    Effect.gen(function* () {
      const client = yield* attach;
      yield* client.send(snapshot(`x ${SECRET.slice(0, 12)}`));
      yield* client.send({ type: "cleared", ...terminal });
      yield* client.send(output("fresh\r\n"));
      assert.equal(client.screen(), "x fresh\r\n");
    }),
  );
});

describe("every terminal's events, scrubbed once for every client", () => {
  /** What TerminalManager.subscribe would hand its listeners, and clients that follow all terminals from when they join. */
  const shared = Effect.gen(function* () {
    const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const subscribe = yield* sharedTerminalEvents(
      (listener) =>
        Effect.sync(() => (listeners.add(listener), () => void listeners.delete(listener))),
      Effect.succeed(scrubber),
    );
    return {
      print: (data: string) =>
        Effect.forEach([...listeners], (listener) => listener(output(data)), {
          discard: true,
        }).pipe(Effect.andThen(TestClock.adjust(0))),
      join: Effect.gen(function* () {
        const events: Array<TerminalEvent> = [];
        yield* Effect.acquireRelease(
          subscribe((event) => Effect.sync(() => void events.push(event))),
          (stop) => Effect.sync(stop),
        );
        return () => events.map((event) => (event.type === "output" ? event.data : "")).join("");
      }),
    };
  });

  it.effect("masks a value for a client that joined between the two reads that split it", () =>
    Effect.gen(function* () {
      const terminals = yield* shared;
      const early = yield* terminals.join;
      yield* terminals.print(`$ env\r\nSTRIPE_SECRET_KEY=${SECRET.slice(0, 12)}`);
      yield* TestClock.adjust(LIVE_OUTPUT_FLUSH_MS * 4);
      const late = yield* terminals.join;
      yield* terminals.print(`${SECRET.slice(12)}\r\n$ `);
      assert.equal(early(), "$ env\r\nSTRIPE_SECRET_KEY=[secret:STRIPE_SECRET_KEY]\r\n$ ");
      assert.equal(late(), "[secret:STRIPE_SECRET_KEY]\r\n$ ");
    }),
  );

  it.effect(
    "sends a short held echo to every client once the terminal pauses, a client that joined meanwhile too",
    () =>
      Effect.gen(function* () {
        const terminals = yield* shared;
        const early = yield* terminals.join;
        yield* terminals.print("$ s");
        const late = yield* terminals.join;
        assert.equal(early(), "$ ");
        yield* TestClock.adjust(LIVE_OUTPUT_FLUSH_MS);
        assert.equal(early(), "$ s");
        assert.equal(late(), "s");
      }),
  );
});
