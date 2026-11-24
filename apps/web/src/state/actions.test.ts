import { expect, test } from "vitest";
import { actionIcon, actionId, latestRuns, runLength } from "./actions.ts";

test("each command's latest run, from its terminals", () => {
  const runs = latestRuns([
    { terminal_id: "t1", title: "pnpm test", command: "pnpm test", cwd: ".", created_at: "2026-10-18T10:00:00.000Z", exited: true, exit_code: 1, exited_at: "2026-10-18T10:00:04.000Z" },
    { terminal_id: "t2", title: "pnpm test", command: "pnpm test", cwd: ".", created_at: "2026-10-18T10:01:00.000Z", exited: true, exit_code: 0, exited_at: "2026-10-18T10:01:04.200Z" },
    { terminal_id: "t3", title: "pnpm dev", command: "pnpm dev", cwd: ".", created_at: "2026-10-18T10:02:00.000Z", exited: false },
    { terminal_id: "t4", title: "Terminal", cwd: ".", created_at: "2026-10-18T10:03:00.000Z", exited: false },
    { terminal_id: "t5", title: "sleep 9", command: "sleep 9", cwd: ".", created_at: "2026-10-18T10:04:00.000Z", exited: true, exit_code: 0, signal: "2", exited_at: "2026-10-18T10:04:01.000Z" },
  ]);
  expect(runs.get("pnpm test")).toEqual({ state: "passed", terminalId: "t2", startedAt: Date.parse("2026-10-18T10:01:00.000Z"), endedAt: Date.parse("2026-10-18T10:01:04.200Z"), code: 0 });
  expect(runs.get("pnpm dev")).toMatchObject({ state: "running", terminalId: "t3" });
  // Ctrl-C ends a run with code 0 and a signal: not a pass.
  expect(runs.get("sleep 9")).toMatchObject({ state: "failed", code: null });
  // A plain shell is no action's run.
  expect(runs.size).toBe(3);
});

test("a run's length reads short", () => {
  expect(runLength(4_200)).toBe("4.2s");
  expect(runLength(18_000)).toBe("18s");
  expect(runLength(125_000)).toBe("2m 05s");
  expect(runLength(3_780_000)).toBe("1h 3m");
});

test("a new action's id is free and fits script.<id>.run", () => {
  expect(actionId("Deploy preview", new Set())).toBe("deploy-preview");
  expect(actionId("Deploy preview", new Set(["deploy-preview", "deploy-preview-2"]))).toBe("deploy-preview-3");
  expect(actionId("db:migrate", new Set())).toBe("db-migrate");
  expect(actionId("🚀", new Set())).toBe("action");
  expect(actionId("a very long name for an action indeed", new Set())).toMatch(/^[a-z0-9][a-z0-9-]{0,23}$/);
});

test("an action without an icon gets one from its words", () => {
  expect(actionIcon({ name: "Test", command: "pnpm test" })).toBe("test");
  expect(actionIcon({ name: "Typecheck", command: "pnpm typecheck" })).toBe("lint");
  expect(actionIcon({ name: "db:migrate", command: "pnpm run db:migrate" })).toBe("configure");
  expect(actionIcon({ name: "Dev server", command: "pnpm dev" })).toBe("play");
  expect(actionIcon({ name: "Anything", command: "x", icon: "debug" })).toBe("debug");
});
