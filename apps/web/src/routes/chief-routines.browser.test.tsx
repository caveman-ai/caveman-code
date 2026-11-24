// A Chief's routines, in Chromium against the scripted runtime: the Routines section heads its Work panel's List and
// Board with each of its project's routines (an automation with a `chief` output), its schedule and last day, and what
// its last run found; Pause, Run now and Edit act on it from the row. A routine's news run is a card in the
// conversation that names it.
import type { ChiefMoment, ChiefRoutine, Result } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountApp } from "../../test/app.tsx";
import { AT, chief, PROJECT, runtimeFixture, workspace } from "../../test/fixtures.ts";

const APP = chief("c-app", "app", {
  project_id: PROJECT.id,
  project_ids: [PROJECT.id],
  project_default: true,
});
type Automation = Result<"automation.list">["automations"][number];
const BUGS = `file:${PROJECT.id}:me:launch-bugs`;

const automation = (id: string, title: string, over: Partial<Automation> = {}): Automation => ({
  id,
  title,
  prompt: "",
  enabled: true,
  trigger: { type: "file", kinds: ["schedule"], words: ["Every day at 09:00, until Sun Nov 15"] },
  project_id: PROJECT.id,
  engine: "caveman",
  model: "auto",
  next_run_at: null,
  last_run_at: AT,
  last_status: "succeeded",
  last_error: null,
  run_count: 3,
  source: "file",
  scope: "me",
  path: `.caveman/local/automations/${title}.yaml`,
  ...over,
});

const report: ChiefRoutine = {
  automation_id: BUGS,
  project_id: PROJECT.id,
  name: "launch-bugs",
  run_id: "run-3",
  ran_at: AT,
  status: "succeeded",
  decision: "news",
  summary: "2 new bugs: the login loop (#51) and a blank invoice (#52).",
};
const news: ChiefMoment = {
  kind: "news",
  text: report.summary,
  routine: { automation_id: BUGS, name: "launch-bugs", run_id: "run-3" },
};

async function openWork(bugs: Partial<Automation> = {}, more: Automation[] = []) {
  const mounted = await mountApp(
    "/chief/c-app",
    runtimeFixture({
      chiefs: [APP],
      workspaces: [workspace("c-app", { kind: "chief", title: "app" })],
      events: {
        "c-app": [
          {
            type: "notification",
            item_id: "m-news",
            at: AT,
            payload: { level: "info", title: "launch-bugs found something", moment: news },
          },
        ],
      },
      board: { items: [], change_sets: [], routines: [report] },
      automations: [
        automation(BUGS, "launch-bugs", {
          routine: { step: "look", schedule: "Every day at 09:00", until: "2026-11-15" },
          ...bugs,
        }),
        // Not a routine: no chief output.
        automation(`file:${PROJECT.id}:me:nightly`, "nightly"),
        // Another project's routine.
        automation("file:p-other:me:other-bugs", "other-bugs", {
          project_id: "p-other",
          routine: { step: "look" },
        }),
        ...more,
      ],
    }),
  );
  // The Work panel is there but closed, as a messenger opens (Chief.tsx): its toggle opens it, unless an earlier test
  // left it open.
  const toggle = page.getByRole("button", { name: /^(Show|Hide) panel$/ }).first();
  await expect.element(toggle).toBeVisible();
  if (toggle.element().getAttribute("aria-label") === "Show panel") await toggle.click();
  await expect.element(page.getByRole("button", { name: /^Routines \d/ })).toBeVisible();
  return mounted;
}

describe("a Chief's routines", () => {
  test("the Routines section heads List and Board with the project's routines, their schedule, last day and last finding", async () => {
    await openWork();
    const band = page.getByRole("button", { name: /^Routines \d/ });
    await expect.element(band).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText("Every day at 09:00, until Sun Nov 15")).toBeVisible();
    await expect
      .element(
        page.getByText(/^2 new bugs: the login loop \(#51\) and a blank invoice \(#52\)\. · /),
      )
      .toBeVisible();
    await expect.element(page.getByText("nightly", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("other-bugs", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("radio", { name: "Board" }));
    await expect.element(page.getByRole("button", { name: /^Routines \d/ })).toBeVisible();
    await expect.element(page.getByText("Every day at 09:00, until Sun Nov 15")).toBeVisible();
  });

  test("Pause, Resume and Run now act from the row and stay on the Chief; Edit opens its file", async () => {
    const { peer } = await openWork();
    await userEvent.hover(page.getByRole("group", { name: /^launch-bugs, routine/ }));
    await userEvent.click(page.getByRole("button", { name: "Pause" }));
    // The row's tail (hidden under the pointer, where its buttons are) says Paused.
    await expect
      .element(
        page
          .getByRole("group", { name: /^launch-bugs, routine, paused:/ })
          .getByText("Paused", { exact: true }),
      )
      .toBeInTheDocument();
    await expect
      .poll(() =>
        peer
          .callsOf("automation.set_enabled")
          .some((c) => c.params.id === BUGS && !c.params.enabled),
      )
      .toBe(true);

    await userEvent.hover(page.getByRole("group", { name: /^launch-bugs, routine, paused/ }));
    await userEvent.click(page.getByRole("button", { name: "Resume" }));
    await expect
      .element(
        page
          .getByRole("group", { name: /^launch-bugs, routine:/ })
          .getByText("Every day at 09:00, until Sun Nov 15"),
      )
      .toBeInTheDocument();
    await expect
      .poll(() =>
        peer
          .callsOf("automation.set_enabled")
          .some((c) => c.params.id === BUGS && c.params.enabled),
      )
      .toBe(true);

    await userEvent.hover(page.getByRole("group", { name: /^launch-bugs, routine/ }));
    await userEvent.click(page.getByRole("button", { name: "Run now" }));
    await expect
      .poll(() => peer.callsOf("automation.run").some((c) => c.params.id === BUGS))
      .toBe(true);
    expect(window.location.hash).toBe("#/chief/c-app");

    await userEvent.hover(page.getByRole("group", { name: /^launch-bugs, routine/ }));
    await userEvent.click(page.getByRole("button", { name: "Edit" }));
    await expect
      .poll(() => window.location.hash)
      .toBe(`#/automations/${encodeURIComponent(BUGS)}/settings?tab=file`);
  });

  test("a news run is a card in the conversation that names its routine", async () => {
    await openWork();
    const card = () =>
      page.getByRole("log").element().querySelector('[data-moment="news"]')?.textContent ?? "";
    await expect.poll(card).toContain("Routinelaunch-bugsfound something");
    expect(card()).toContain("a blank invoice (#52)");
  });

  test("a routine a chat wrote waits for the person: its row says why, and Turn on is their yes", async () => {
    const { peer } = await openWork({
      triggers_off_reason: "Turn it on again: the file changed what it may do.",
    });
    const row = page.getByRole("group", { name: /^launch-bugs, routine: Turn it on again/ });
    await expect.element(row).toBeVisible();
    await userEvent.hover(row);
    await expect.element(page.getByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Turn on" }));
    await expect
      .poll(() =>
        peer
          .callsOf("automation.set_enabled")
          .some((c) => c.params.id === BUGS && c.params.enabled),
      )
      .toBe(true);
  });

  test("Run now on a routine that needs an input with no default opens its form, never a run without it", async () => {
    const { peer } = await openWork({
      inputs: [{ name: "tracker", description: "Where bugs are filed", required: true }],
    });
    await userEvent.hover(page.getByRole("group", { name: /^launch-bugs, routine/ }));
    await userEvent.click(page.getByRole("button", { name: "Run now" }));
    await expect
      .poll(() => window.location.hash)
      .toBe(`#/automations/${encodeURIComponent(BUGS)}?run=1`);
    expect(peer.callsOf("automation.run")).toEqual([]);
  });

  test("a Me routine a chat wrote in its worktree: listed, and Turn on adds its file to the project and turns it on", async () => {
    const branch = "caveman/chat-1a2b";
    const draft = `file:${PROJECT.id}@${branch}:me:new-bugs`;
    const { peer } = await openWork({}, [
      automation(draft, "new-bugs", {
        enabled: false,
        worktree: { branch, path: `/wt/${branch}` },
        routine: { step: "look", schedule: "Every day at 09:00" },
      }),
    ]);
    const row = page.getByRole("group", { name: /^new-bugs, routine, draft: A chat wrote it/ });
    await expect.element(row).toBeVisible();
    await userEvent.hover(row);
    await expect.element(row.getByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    await userEvent.click(row.getByRole("button", { name: "Turn on" }));
    // The draft's own text, read from its worktree, written into the project as a Me file.
    await expect
      .poll(() => peer.callsOf("automation.create").map((c) => c.params))
      .toEqual([
        expect.objectContaining({
          project_id: PROJECT.id,
          scope: "me",
          from: {
            name: "new-bugs",
            text: `# ${PROJECT.id}@${branch}:.caveman/local/automations/new-bugs.yaml\n`,
          },
        }),
      ]);
    await expect
      .element(page.getByRole("status").filter({ hasText: "new-bugs is on." }))
      .toBeVisible();
    await expect
      .element(
        page
          .getByRole("group", { name: /^new-bugs, routine: / })
          .getByText("Every day at 09:00, until Sun Nov 15"),
      )
      .toBeInTheDocument();
    expect(window.location.hash).toBe("#/chief/c-app");
  });

  test("Turn on never writes over a different file of that name in the project: it says so", async () => {
    const branch = "caveman/chat-3c4d";
    const { peer } = await openWork({}, [
      automation(`file:${PROJECT.id}@${branch}:me:launch-bugs`, "launch-bugs", {
        enabled: false,
        worktree: { branch, path: `/wt/${branch}` },
        routine: { step: "look" },
      }),
    ]);
    const row = page.getByRole("group", { name: /^launch-bugs, routine, draft/ });
    await userEvent.hover(row);
    await userEvent.click(row.getByRole("button", { name: "Turn on" }));
    await expect
      .element(
        page
          .getByRole("alert")
          .filter({ hasText: "This project has a different launch-bugs already." }),
      )
      .toBeVisible();
    expect(peer.callsOf("automation.create")).toEqual([]);
    expect(peer.callsOf("automation.file_read")).toEqual([]);
  });
});
