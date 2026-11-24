// A board card says what it needs in one short line (workNote) and folds open to the whole report (WorkCard).
import type { ChiefItem } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("../../panes/store.ts", () => ({ windowTabs: {}, panes: {}, announce: () => undefined }));
vi.mock("../../panels/store.ts", () => ({
  openSurface: () => undefined,
  updateTab: () => undefined,
}));
vi.mock("../../panels/registry.ts", () => ({ defineSurface: () => undefined }));
vi.mock("../review/surface.tsx", () => ({}));
import type { WorkspaceView } from "../../state/model.ts";
import { WorkCard } from "./work.tsx";
import { lineParts, reportRows, workNote, type Work } from "./work-model.ts";

const t0 = "2026-11-08T09:00:00.000Z";
// The report CH-6 carried on the board (the screenshot that asked for this), as the runtime joins it.
const REPORT =
  "Status: blocked · PR: https://github.com/caveman-ai/caveman-code · Check: I merged main (361 commits) into the branch, which typechecks clean, and pushed it as 0c4ee05c. The new CI run is [42071020228](https://github.com/caveman-ai/caveman-code). Every red test there also fails on main, so I changed no tests. · Left: The checks can't go green until the separate fix for main lands. After that, CI on this branch needs a re-run.";
const item = (patch: Partial<ChiefItem> = {}): ChiefItem => ({
  id: "i1",
  number: 6,
  title: "Autonomy PR #34: signal bars + level-2 change sets",
  text: "note",
  state: "needs_you",
  rank: 1,
  pinned: false,
  project_ids: [],
  source: "composer",
  workspace_ids: [],
  created_at: t0,
  updated_at: t0,
  ...patch,
});
const work = (patch: Partial<ChiefItem> = {}, group: Work["group"] = "needs"): Work => ({
  item: item(patch),
  id: "CH-6",
  title: "Autonomy PR #34",
  group,
  waiting: null,
  chats: [] as WorkspaceView[],
  done: 0,
  changeSet: null,
});

describe("workNote", () => {
  test("a blocked report sums up as Blocked and the first sentence of what is left, with no urls", () => {
    const note = workNote(work({ detail: REPORT }), undefined)!;
    expect(note).toMatchObject({
      label: "Blocked",
      summary: "The checks can't go green until the separate fix for main lands.",
      more: true,
    });
    expect(note.rows!.map((r) => r.label)).toEqual(["PR", "Check", "Left"]);
  });

  test("a question report sums up as its question; without Left, Check stands in", () => {
    expect(
      workNote(
        work({ detail: "Status: question · Question: Which database? I'd pick Postgres." }),
        undefined,
      ),
    ).toMatchObject({ label: "Question", summary: "Which database?" });
    expect(
      workNote(
        work({ detail: "Status: blocked · Check: CI red, same failures as main." }),
        undefined,
      ),
    ).toMatchObject({ label: "Blocked", summary: "CI red, same failures as main." });
  });

  test("the Chief's own question beats the report, and unfolds to its recommendation", () => {
    const note = workNote(
      work({
        detail: REPORT,
        asked: { question: "Merge without CI?", recommended: "Wait for main.", asked_at: t0 },
      }),
      undefined,
    )!;
    expect(note).toMatchObject({ label: "Question", summary: "Merge without CI?" });
    expect(note.rows).toEqual([
      { label: "Question", value: "Merge without CI?" },
      { label: "Recommended", value: "Wait for main." },
    ]);
  });

  test("a plain line stays as it is; ready for review says what it waits on; work under way or done says nothing", () => {
    expect(workNote(work({ detail: "Checks are failing on #31." }), undefined)).toEqual({
      label: "Needs you",
      summary: "Checks are failing on #31.",
      more: false,
    });
    // A chat's question arrives as the question alone (chief/watch.ts): it still reads as a Question.
    expect(
      workNote(work({ detail: "Which database should it use? Postgres fits." }), undefined),
    ).toEqual({ label: "Question", summary: "Which database should it use?", more: true });
    expect(
      workNote(work({ state: "review" }, "review"), {
        number: 39,
        state: "open",
        checks: "passing",
        review: null,
      } as never),
    ).toEqual({ summary: "Waiting on your review of #39 · CI passing", more: false });
    expect(workNote(work({ state: "started" }, "working"), undefined)).toBeNull();
    expect(workNote(work({ state: "done", detail: "x" }, "done"), undefined)).toBeNull();
  });

  test("reportRows reads only a report, and keeps a field's own dots", () => {
    expect(reportRows("Which database?")).toBeNull();
    expect(reportRows("Status: review · PR: #39 · CI passing · Left: nothing")).toEqual([
      { label: "Status", value: "review" },
      { label: "PR", value: "#39 · CI passing" },
      { label: "Left", value: "nothing" },
    ]);
  });

  test("lineParts makes markdown links and bare urls into links, a pull request named by its number", () => {
    expect(
      lineParts(
        "run [42](https://x.dev/r/42). See https://github.com/caveman-ai/caveman-code",
      ),
    ).toEqual([
      { text: "run " },
      { text: "42", href: "https://x.dev/r/42" },
      { text: ". See " },
      {
        text: "caveman-code#34",
        href: "https://github.com/caveman-ai/caveman-code",
      },
      { text: "." },
    ]);
  });
});

describe("WorkCard", () => {
  const html = (open: boolean) =>
    renderToStaticMarkup(
      createElement(WorkCard, {
        work: work({ detail: REPORT }),
        moves: { openChat: () => undefined },
        open,
      }),
    );

  test("folded, it shows the summary behind a closed disclosure, and none of the report", () => {
    const folded = html(false);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain(
      "The checks can&#x27;t go green until the separate fix for main lands.",
    );
    expect(folded).not.toContain("https://github.com");
    expect(folded).not.toContain("0c4ee05c");
  });

  test("unfolded, it shows each field on its own row with its links as links", () => {
    const open = html(true);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain(">Check<");
    expect(open).toContain(">Left<");
    expect(open).toContain(
      'href="https://github.com/caveman-ai/caveman-code"',
    );
    expect(open).not.toContain("[42071020228]");
    expect(open).toContain("After that, CI on this branch needs a re-run.");
  });

  test("what proves it done is one muted line under its title, whole in its tooltip; no line without it", () => {
    const proof = "CI green on main for a week";
    const card = renderToStaticMarkup(
      createElement(WorkCard, {
        work: work({ done_when: proof }),
        moves: { openChat: () => undefined },
      }),
    );
    expect(card).toContain(`title="Done when ${proof}"`);
    expect(card).toContain(`>Done when ${proof}</span>`);
    expect(card.indexOf("Autonomy PR #34")).toBeLessThan(card.indexOf(`Done when ${proof}`));
    expect(html(false)).not.toContain("Done when");
    // Its ⋯ comes with the board's moves only: without them there is no menu to open.
    expect(card).not.toContain("options");
    const board = renderToStaticMarkup(
      createElement(WorkCard, {
        work: work({ done_when: proof }),
        moves: { openChat: () => undefined, act: () => undefined, mission: () => undefined },
      }),
    );
    expect(board).toContain('aria-label="CH-6 options"');
  });
});
