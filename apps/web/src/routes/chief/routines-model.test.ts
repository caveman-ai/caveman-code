import type { ChiefRoutine } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import type { Automation } from "../automations/model.ts";
import { foundWords, routineRows, whenWords } from "./routines-model.ts";

const AT = "2026-11-16T09:00:00.000Z";
const now = Date.parse(AT) + 5 * 60_000;
const automation = (id: string, over: Partial<Automation> = {}): Automation =>
  ({
    id,
    title: id,
    project_id: "p",
    enabled: true,
    routine: { step: "look", schedule: "Every 5 minutes" },
    ...over,
  }) as Automation;
/** An automation with no chief output. */
const plain = (id: string): Automation => {
  const { routine: _, ...rest } = automation(id);
  return rest as Automation;
};
const run = (id: string, over: Partial<ChiefRoutine> = {}): ChiefRoutine => ({
  automation_id: id,
  project_id: "p",
  name: id,
  run_id: `run-${id}`,
  ran_at: AT,
  status: "succeeded",
  decision: "news",
  summary: "Found 2 new bugs.\nThe login loop (#51).",
  ...over,
});

describe("routineRows", () => {
  test("the project's routines only, latest report first, never run last; Project drafts and plain automations stay out", () => {
    const rows = routineRows(
      [
        automation("never"),
        automation("old"),
        automation("new"),
        plain("plain"),
        automation("draft", { scope: "project", worktree: { branch: "b", path: "/w" } }),
        automation("elsewhere", { project_id: "q" }),
      ],
      [run("old", { ran_at: "2026-11-15T09:00:00.000Z" }), run("new")],
      { id: "c", project_id: "p" },
    );
    expect(rows.map((r) => r.automation.id)).toEqual(["new", "old", "never"]);
    expect(routineRows([automation("a")], [], undefined)).toEqual([]);
  });

  test("the routines whose reports go to this Chief, whatever its projects; with no word on that, its one project's", () => {
    const routines = [
      automation("mine", { routine: { step: "look", chief_id: "c" } }),
      automation("elsewhere", { project_id: "q", routine: { step: "look", chief_id: "c" } }),
      automation("theirs", { routine: { step: "look", chief_id: "d" } }),
    ];
    // A Chief in every project (no project_id) lists its own, in any project, and not another Chief's in its project.
    expect(
      routineRows(routines, [], { id: "c" })
        .map((r) => r.automation.id)
        .sort(),
    ).toEqual(["elsewhere", "mine"]);
    // A runtime that names no Chief on a routine: the Chief's one project's.
    expect(
      routineRows([automation("old")], [], { id: "c", project_id: "p" }).map(
        (r) => r.automation.id,
      ),
    ).toEqual(["old"]);
    expect(routineRows([automation("old")], [], { id: "c" })).toEqual([]);
  });

  test("a Me routine a chat wrote in its worktree is listed, with the runs it made by hand there, and waits for Turn on", () => {
    const draft = automation("file:p@caveman/chat-1:me:bugs", {
      title: "bugs",
      source: "file",
      scope: "me",
      enabled: false,
      worktree: { branch: "caveman/chat-1", path: "/w" },
    });
    const [row] = routineRows([draft], [run("file:p:me:bugs", { decision: "quiet" })], {
      id: "c",
      project_id: "p",
    });
    expect(row).toMatchObject({
      automation: { id: draft.id },
      last: { run_id: "run-file:p:me:bugs" },
    });
    expect(foundWords(row!, now)).toEqual({
      text: "A chat wrote it: Turn on adds it to this project",
      tone: "off",
    });
  });
});

describe("the row's words", () => {
  test("its schedule with its last day, and what its last run found", () => {
    // Its schedule as the Automations page says it, its last day included.
    expect(
      whenWords(
        automation("a", {
          trigger: {
            type: "file",
            kinds: ["schedule"],
            words: ["Every 5 minutes, until Sun Nov 22"],
          },
        }),
      ),
    ).toBe("Every 5 minutes, until Sun Nov 22");
    const row = { automation: automation("a"), last: run("a") };
    expect(foundWords(row, now)).toEqual({ text: "Found 2 new bugs. · 5m ago", tone: "news" });
    expect(foundWords({ ...row, last: run("a", { decision: "quiet", summary: "" }) }, now)).toEqual(
      { text: "Nothing new · 5m ago", tone: "quiet" },
    );
    expect(
      foundWords(
        { ...row, last: run("a", { status: "failed", summary: "look failed: exit 1" }) },
        now,
      ).tone,
    ).toBe("failed");
    expect(foundWords({ ...row, last: undefined }, now)).toEqual({
      text: "Not run yet",
      tone: "none",
    });
    // What keeps it from running comes before what it last found.
    expect(
      foundWords(
        { ...row, automation: automation("a", { source: "file", diagnostics: 1, errors: 1 }) },
        now,
      ),
    ).toEqual({ text: "1 error in its file: Edit to fix it", tone: "failed" });
  });
});
