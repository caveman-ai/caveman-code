import { expect, test } from "vitest";
import type { Workspace } from "@caveman-app/session-protocol";
import { builderPlace, onlyThese } from "./AgentsSurface.tsx";
import { builderRow, builderState, MARK } from "./states.ts";

test("a delegated agent that was stopped reads Stopped once at rest, one that failed Failed, never Done", () => {
  // Stop on the lead leaves the agent's workspace idle; its lead's transcript saw the run end stopped.
  expect(builderState("idle", "stopped")).toEqual({ label: "Stopped", mark: "failed" });
  expect(builderState("idle", "failed")).toEqual({ label: "Failed", mark: "failed" });
  expect(builderState("idle", "done")).toMatchObject({ label: "Done" });
  expect(builderState("idle", undefined)).toMatchObject({ label: "Done" });
  // While it works or asks, its own state says so, whatever an earlier run ended as.
  expect(builderState("working", "failed")).toMatchObject({ label: "Working" });
  expect(builderState("needs_input", "failed")).toMatchObject({ label: "Needs input" });
  expect(builderState("failed", undefined)).toMatchObject({ label: "Failed" });
});

test("a builder's row reads what its lead's runtime says became of it, each state with its own label and shape", () => {
  const now = new Date("2026-11-10T20:00:00");
  const until = new Date("2026-11-10T23:08:00");
  const clock = until.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const rows = [
    builderRow({ status: "working", builder: { state: "working" } }, undefined, now),
    builderRow({ status: "idle", builder: { state: "done" } }, undefined, now),
    builderRow({ status: "idle", builder: { state: "merged" } }, undefined, now),
    builderRow(
      { status: "idle", builder: { state: "left_out", why: "conflicts in a.ts" } },
      undefined,
      now,
    ),
    builderRow(
      {
        status: "idle",
        builder: { state: "paused", until: until.toISOString(), plan: "Claude plan" },
      },
      undefined,
      now,
    ),
    builderRow(
      { status: "failed", builder: { state: "failed", why: "its agent stopped" } },
      undefined,
      now,
    ),
  ];
  expect(rows.map((r) => r.label)).toEqual([
    "Working",
    "Done",
    "Merged",
    "Left out: conflicts in a.ts",
    `Paused until ${clock}`,
    "Failed: its agent stopped",
  ]);
  expect(clock).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/);
  expect(rows[4]!.hint).toBe("Claude plan used up");
  // Never colour alone: each of the six reads in a shape of its own but working's and done's dots, which differ in label.
  const shapes = rows.map((r) =>
    MARK[r.mark]
      .split(" ")
      .filter((c) => !/^(bg|border)-(success|warning|destructive|muted-foreground)$/.test(c))
      .join(" "),
  );
  expect(new Set(shapes).size).toBe(5);
  // A paused builder whose plan named no time, and a why the runtime left out.
  expect(builderRow({ status: "idle", builder: { state: "paused" } }, undefined, now).label).toBe(
    "Paused",
  );
  expect(builderRow({ status: "idle", builder: { state: "left_out" } }, undefined, now).label).toBe(
    "Left out",
  );
  // From a runtime before the field: as it read before (a stopped run at rest reads Stopped, not Done).
  expect(builderRow({ status: "idle" }, "stopped", now)).toEqual(builderState("idle", "stopped"));
  expect(builderRow({ status: "working" }, undefined, now)).toEqual({
    label: "Working",
    mark: "working",
  });
});

test("the result row's click lists only the builders left out, by id where given, else by title", () => {
  const all = [
    { id: "w-1", title: "Port the settings page" },
    { id: "w-2", title: "Port the inbox" },
    { id: "w-3", title: "Port the theme" },
  ];
  expect(onlyThese(all, undefined)).toBe(all);
  expect(onlyThese(all, { ids: ["w-2"], titles: ["Port the theme"] }).map((b) => b.id)).toEqual([
    "w-2",
    "w-3",
  ]);
});

test("where a builder runs names Cloud or another Mac, never a Cloud computer", () => {
  const on = (computer: Workspace["computer"]) => builderPlace({ computer });
  expect(
    on({ id: "this-mac", kind: "this_mac", label: "MacBook", status: "online" }),
  ).toBeUndefined();
  expect(on({ id: "c-9", kind: "caveman_cloud", label: "acme-web", status: "online" })).toBe(
    "Cloud",
  );
  expect(on({ id: "mac-2", kind: "this_mac", label: "Studio", status: "online" })).toBe("Studio");
});
