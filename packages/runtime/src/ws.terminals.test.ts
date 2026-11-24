// /ws terminal streams read over a real socket by a client that stops reading: a laptop asleep, a half-open socket.
import { assert, it } from "@effect/vitest";
import {
  AuthTerminalOperateScope,
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
} from "@caveman-app/protocol";
import { createScrubber } from "@caveman-app/session-protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { terminalsOnFakePty } from "./testkit/fakePty.ts";
import { serveWs, wsClient } from "./testkit/wsServer.ts";

const MiB = 1024 * 1024;

it.live(
  "a terminal client that stops reading costs the runtime a bounded amount, then catches up from a fresh snapshot",
  () =>
    Effect.gen(function* () {
      const { pty, manager, services } = yield* terminalsOnFakePty({ historyLineLimit: 5 });
      const rpc = yield* wsClient(
        yield* serveWs({
          scopes: [AuthTerminalOperateScope],
          scrubber: createScrubber([]),
          services,
        }),
      );
      let published = 0;
      const stopCounting = yield* manager.subscribe((event) =>
        Effect.sync(() => {
          if (event.type === "output") published += event.data.length;
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopCounting));

      // The client reads the snapshot, then stops reading until it wakes.
      const awake = yield* Deferred.make<void>();
      const received: Array<TerminalAttachStreamEvent> = [];
      yield* rpc["terminal.attach"]({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: process.cwd(),
        cols: 100,
        rows: 24,
      }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => received.push(event)).pipe(
            Effect.andThen((count) => (count === 1 ? Deferred.await(awake) : Effect.void)),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Effect.suspend(() =>
        received.length > 0 ? Effect.void : Effect.fail("no snapshot yet"),
      ).pipe(Effect.retry(Schedule.spaced("10 millis")), Effect.timeout("5 seconds"));

      // A noisy dev server prints 32 MiB while the client sleeps.
      const total = 32 * MiB;
      const lineBytes = 64 * 1024;
      const line = (n: number) => `${n}`.padEnd(lineBytes - 1, "x") + "\n";
      for (let n = 0; n * lineBytes < total; n += 1) {
        pty.processes[0]!.print(line(n));
        if (n % 16 === 0) yield* Effect.sleep("1 millis");
      }
      while (published < total) yield* Effect.sleep("5 millis");

      // It wakes and reads until it shows the terminal's last line.
      const caughtUp = () => {
        const latest = received.at(-1);
        const text =
          latest?.type === "snapshot"
            ? latest.snapshot.history
            : latest?.type === "output"
              ? latest.data
              : "";
        return text.endsWith(line(total / lineBytes - 1));
      };
      yield* Deferred.succeed(awake, undefined);
      yield* Effect.suspend(() =>
        caughtUp() ? Effect.void : Effect.fail("still catching up"),
      ).pipe(Effect.retry(Schedule.spaced("50 millis")), Effect.timeout("60 seconds"));

      const outputBytes = received.reduce(
        (bytes, event) => bytes + (event.type === "output" ? event.data.length : 0),
        0,
      );
      // The runtime kept 8 MiB for a client that stopped reading, not everything the terminal printed...
      assert.isAtMost(outputBytes, 10 * MiB);
      // ...and the client caught up from a fresh snapshot, not by replaying the backlog.
      assert.isAbove(
        received.findLastIndex((event) => event.type === "snapshot"),
        0,
      );
    }),
  { timeout: 120_000 },
);
