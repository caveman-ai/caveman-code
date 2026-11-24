// @effect-diagnostics nodeBuiltinImport:off - the heap is read through node:v8 and node:vm.
// What a terminal stream keeps while it waits for its thread, and what it sends once it has it (upstream #18429).
import * as v8 from "node:v8";
import * as vm from "node:vm";

import { assert, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, type TerminalAttachStreamEvent } from "@caveman-app/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { type FakePtyProcess, terminalsOnFakePty } from "../testkit/fakePty.ts";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
/** Bytes the heap holds once everything unreferenced is gone. */
const retained = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};
const MiB = 1024 * 1024;

const terminal = { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID };
const open = (terminalId: string) => ({
  ...terminal,
  terminalId,
  cwd: process.cwd(),
  cols: 80,
  rows: 24,
});

it.live(
  "a stream waiting for its thread's lock holds none of the output its snapshot will carry",
  () =>
    Effect.gen(function* () {
      const { pty, manager } = yield* terminalsOnFakePty({ historyByteLimit: 64 * 1024 });
      yield* manager.open(open(DEFAULT_TERMINAL_ID));
      const shell: FakePtyProcess = pty.processes[0]!;
      // Another terminal of the thread starting holds the thread's lock until its shell spawns.
      const hold = {
        spawning: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      pty.hold = hold;
      const starting = yield* manager
        .open(open("other"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(hold.spawning);
      const received: Array<TerminalAttachStreamEvent> = [];
      const observing = yield* manager
        .observeStream(terminal, (event) => Effect.sync(() => void received.push(event)))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.sleep("20 millis");

      // A noisy program prints 48 MiB while the stream waits.
      const before = retained();
      const printed = yield* Deferred.make<void>();
      const stopWatching = yield* manager.subscribe((event) =>
        event.type === "output" && event.data.endsWith("last\n")
          ? Deferred.succeed(printed, undefined)
          : Effect.void,
      );
      for (let i = 0; i < 48; i++) shell.print(`${i}`.padEnd(MiB - 1, "x") + "\n");
      shell.print("last\n");
      yield* Deferred.await(printed);
      stopWatching();
      const whileWaiting = retained() - before;

      yield* Deferred.succeed(hold.release, undefined);
      yield* Fiber.join(starting);
      const stop = yield* Fiber.join(observing);
      const whileFollowing = retained() - before;
      stop();

      assert.deepEqual(
        received.map((event) => event.type),
        ["snapshot"],
      );
      assert.isTrue(
        received[0]?.type === "snapshot" && received[0].snapshot.history.endsWith("last\n"),
      );
      assert.isBelow(whileWaiting / MiB, 8);
      assert.isBelow(whileFollowing / MiB, 8);
    }),
);

it.live("an output already in a stream's snapshot is not sent again after it", () =>
  Effect.gen(function* () {
    const { pty, manager } = yield* terminalsOnFakePty();
    yield* manager.open(open(DEFAULT_TERMINAL_ID));
    const shell = pty.processes[0]!;
    // An earlier listener holds the fan-out of one output, which history already has, until the stream has its snapshot.
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const stopHolding = yield* manager.subscribe((event) =>
      event.type === "output" && event.data === "in flight\n"
        ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    );
    shell.print("in flight\n");
    yield* Deferred.await(reached);
    const received: Array<TerminalAttachStreamEvent> = [];
    const after = yield* Deferred.make<void>();
    const stop = yield* manager.observeStream(terminal, (event) =>
      Effect.sync(() => void received.push(event)).pipe(
        Effect.andThen(
          event.type === "output" && event.data === "after\n"
            ? Deferred.succeed(after, undefined)
            : Effect.void,
        ),
      ),
    );
    yield* Deferred.succeed(release, undefined);
    shell.print("after\n");
    yield* Deferred.await(after);
    stop();
    stopHolding();

    assert.deepEqual(
      received.map((event) =>
        event.type === "snapshot"
          ? event.snapshot.history
          : event.type === "output"
            ? event.data
            : event.type,
      ),
      ["in flight\n", "after\n"],
    );
  }),
);
