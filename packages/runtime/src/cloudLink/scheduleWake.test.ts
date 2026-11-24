import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeScheduleWake } from "./scheduleWake.ts";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");

const harness = (refuse: ReadonlySet<string> = new Set()) => {
  const puts: Array<{ workspace: string; at: string | null }> = [];
  let next: number | undefined;
  let workspaces: ReadonlyArray<string> = ["ws-builder", "ws-chat"];
  const wake = makeScheduleWake({
    next: Effect.sync(() => next),
    workspaces: Effect.sync(() => workspaces),
    put: (workspace, at) =>
      refuse.has(workspace)
        ? Effect.fail("cave_code_workspace_archived")
        : Effect.sync(() => void puts.push({ workspace, at })),
    now: () => NOW,
  });
  return {
    puts,
    wake,
    setNext: (value: number | undefined) => void (next = value),
    setWorkspaces: (value: ReadonlyArray<string>) => void (workspaces = value),
  };
};

describe("a Cloud computer's wake time for its schedules", () => {
  it.effect("says the earliest next run once, and again only when it changes", () =>
    Effect.gen(function* () {
      const h = harness();
      h.setNext(NOW + 20 * 60_000);
      yield* h.wake;
      yield* h.wake;
      expect(h.puts).toEqual([{ workspace: "ws-builder", at: "2026-11-06T12:20:00.000Z" }]);
      h.setNext(NOW + 60 * 60_000);
      yield* h.wake;
      expect(h.puts.at(-1)).toEqual({ workspace: "ws-builder", at: "2026-11-06T13:00:00.000Z" });
    }),
  );

  it.effect(
    "says nothing while nothing is scheduled, and clears the time once nothing is left",
    () =>
      Effect.gen(function* () {
        const h = harness();
        yield* h.wake;
        expect(h.puts).toEqual([]);
        h.setNext(NOW + 60_000);
        yield* h.wake;
        h.setNext(undefined);
        yield* h.wake;
        expect(h.puts.at(-1)).toEqual({ workspace: "ws-builder", at: null });
      }),
  );

  it.effect("never asks to be woken for what is due now: the runtime is awake and running it", () =>
    Effect.gen(function* () {
      const h = harness();
      h.setNext(NOW - 1_000);
      yield* h.wake;
      expect(h.puts).toEqual([]);
    }),
  );

  it.effect(
    "moves to another workspace when the first refuses, and keeps the one that took it",
    () =>
      Effect.gen(function* () {
        const h = harness(new Set(["ws-builder"]));
        h.setNext(NOW + 60_000);
        yield* h.wake;
        expect(h.puts).toEqual([{ workspace: "ws-chat", at: "2026-11-06T12:01:00.000Z" }]);
        h.setWorkspaces(["ws-other", "ws-chat"]);
        h.setNext(NOW + 120_000);
        yield* h.wake;
        expect(h.puts.at(-1)).toEqual({ workspace: "ws-chat", at: "2026-11-06T12:02:00.000Z" });
      }),
  );
});
