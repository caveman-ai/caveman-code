import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import type { TerminalEvent } from "@caveman-app/protocol";
import * as PtyAdapter from "@caveman-app/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";

const layer = Layer.mergeAll(ProcessRunner.layer, NodePtyAdapter.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const input = { threadId: "lifecycle", terminalId: "action", cwd: process.cwd() };

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "terminal-lifecycle-" });
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir,
    ptyAdapter,
    shellResolver: () => "/bin/sh",
    env: { ...process.env, ENV: "" },
    processKillGraceMs: 10,
    subprocessPollIntervalMs: 60_000,
    // Isolate launch classification from process-table races. The PTYs themselves are real.
    subprocessInspector: () => Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
  });
  const events: TerminalEvent[] = [];
  const exits = yield* Queue.unbounded<void>();
  const unsubscribe = yield* manager.subscribe((event) => {
    events.push(event);
    return event.type === "exited" ? Queue.offer(exits, undefined).pipe(Effect.asVoid) : Effect.void;
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  return { manager, events, exits };
});

it.live("runs the requested command again when reopening an exited action terminal", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const { manager, events, exits } = yield* makeFixture;
    yield* manager.open({ ...input, command: "printf first-action" });
    yield* Queue.take(exits).pipe(Effect.timeout("3 seconds"));
    events.length = 0;
    yield* manager.open({ ...input, command: "printf second-action" });
    yield* Queue.take(exits).pipe(Effect.timeout("3 seconds"));
    const output = events.filter((event) => event.type === "output").map((event) => event.data).join("");
    expect(output).toContain("second-action");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("allows closeIdle to close the plain shell replacing an action on restart", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const { manager, events } = yield* makeFixture;
    yield* manager.open({ ...input, command: "exec /bin/sleep 30" });
    const restarted = yield* manager.restart({ ...input, cols: 80, rows: 24 });
    expect(restarted.status).toBe("running");
    yield* manager.closeIdle({ threadId: input.threadId });
    expect(events.some((event) => event.type === "closed")).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
