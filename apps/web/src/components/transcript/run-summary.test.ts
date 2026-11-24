// A live run names its current step; a completed run summarizes finished work.
// A held call never reads as finished before approval.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { ToolPart } from "../../state/tool-actions.ts";
import type { ToolItem } from "../../state/transcript-model.ts";
import { WorkRun } from "./WorkRun.tsx";
import { HeldSteps } from "./held.ts";

// WorkRun names threads as their pills do; the window's pane store is browser-only and unrelated here.
vi.mock("../../panes/store.ts", () => ({ panes: {} }));

const at = "2026-10-26T08:00:00.000Z";
const tool = (id: string, status: ToolItem["status"], verb: string, subject: string, parts: ReadonlyArray<ToolPart>, added: number | null = null): ToolItem => ({
  kind: "tool",
  id,
  verb,
  subject,
  parts,
  command: null,
  status,
  startedAt: at,
  finishedAt: status === "running" ? null : "2026-10-26T08:00:01.000Z",
  added,
  removed: null,
  output: "",
  name: "Bash",
  input: {},
  result: null,
  icon: "edit",
});

const summaryLine = (items: ReadonlyArray<ToolItem>, held: string[] = []) => lines(items, held)[0] ?? "";
// Every line the run shows: its own line first, then (live) the line of the step running now.
const lines = (items: ReadonlyArray<ToolItem>, held: string[] = [], active = true) => {
  const html = renderToStaticMarkup(createElement(HeldSteps.Provider, { value: new Set(held) }, createElement(WorkRun, { items, artifacts: [], active })));
  return [...html.matchAll(/data-slot="trace-title"[^>]*>(.*?)<\/span>/g)].map((m) => m[1]!);
};

test("a live run says what it has done on its line and what it does on the line under it; a held call never reads as running", () => {
  const read = tool("t1", "done", "Read", "tasks.js", [{ action: "read", subject: "tasks.js" }]);
  const edit = tool("t2", "done", "Edited", "tasks.js", [{ action: "edit", subject: "tasks.js" }], 5);
  const pending = tool("t3", "running", "Writing", "tasks.test.js", [{ action: "write", subject: "tasks.test.js" }, { action: "test", subject: "" }], 10);
  const [run, now] = lines([read, edit, pending]);
  expect(run).toContain("Read tasks.js");
  expect(run).toContain("edited tasks.js");
  expect(run).not.toContain("Writing");
  expect(now).toContain("Writing");
  expect(now).toContain("tasks.test.js");
  expect(`${run}${now}`).not.toContain("wrote");
  expect(`${run}${now}`).not.toContain("ran tests");
  const [, waiting] = lines([read, edit, pending], [pending.id]);
  expect(waiting).toContain("Waiting for approval");
  expect(waiting).not.toContain("Writing");
  // Between steps the latest keeps the line under the run's, so the run never shrinks and regrows.
  const [between, latest] = lines([read, edit]);
  expect(between).toContain("Read");
  expect(between).not.toContain("edited");
  expect(latest).toContain("Edited");
  // Settled, the run is its one line.
  const settled = lines([read, edit], [], false);
  expect(settled).toHaveLength(1);
  expect(settled[0]).toContain("Read tasks.js");
  expect(settled[0]).toContain("edited tasks.js");
});

test("a denied call did nothing: its action is not in the summary", () => {
  const read = tool("t1", "done", "Read", "tasks.js", [{ action: "read", subject: "tasks.js" }]);
  const denied = tool("t2", "denied", "Write", "tasks.js", [{ action: "write", subject: "tasks.js" }]);
  const ran = tool("t3", "done", "Ran", "tests", [{ action: "test", subject: "" }]);
  expect(summaryLine([read, denied, ran])).not.toContain("wrote");
});

test("with nothing finished yet, the run's line is its first step as it goes", () => {
  const a = tool("t1", "running", "Writing", "a.js", [{ action: "write", subject: "a.js" }]);
  const b = tool("t2", "running", "Writing", "b.js", [{ action: "write", subject: "b.js" }]);
  expect(summaryLine([a, b])).toContain("Writing");
});

test("a run that changed files wears the pencil, even when the change was a step of a command that also ran tests", () => {
  const leadIcon = (items: ReadonlyArray<ToolItem>) =>
    renderToStaticMarkup(createElement(WorkRun, { items, artifacts: [], active: false })).match(/data-slot="trace-icon".*?<\/span>/)?.[0];
  const list = { ...tool("t1", "done", "Listed", "", [{ action: "list", subject: "" }]), icon: "search" as const };
  const both = { ...tool("t2", "done", "Wrote", "tasks.test.js", [{ action: "write", subject: "tasks.test.js" }, { action: "test", subject: "" }]), icon: "run" as const };
  const edited = tool("t3", "done", "Edited", "tasks.js", [{ action: "edit", subject: "tasks.js" }]);
  expect(leadIcon([list, both])).toBe(leadIcon([list, edited]));
  expect(leadIcon([list, both])).not.toBe(leadIcon([list, { ...list, id: "t4" }]));
});
