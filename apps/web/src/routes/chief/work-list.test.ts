// The Work list as it renders: honest chips and sections, and each row's hover actions with their keys.
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
vi.mock("../../shell/Sidebar.tsx", () => ({
  ChatMenuItems: () => null,
  keepRenameFocus: () => undefined,
}));
vi.mock("../../shell/InboxItems.tsx", () => ({ CustomSnoozeDialog: () => null }));
vi.mock("../../state/runtime.tsx", () => ({
  requestId: () => "r",
  useRuntimeClient: () => ({ client: null }),
  useRuntimeSelector: () => [],
}));
import type { WorkspaceView } from "../../state/model.ts";
import { WorkList } from "./work.tsx";
import { workGroups } from "./work-model.ts";

const t0 = "2026-11-09T09:00:00.000Z";
const item = (id: string, number: number, title: string, patch: Partial<ChiefItem>): ChiefItem => ({
  id,
  number,
  title,
  text: title,
  state: "review",
  rank: number,
  pinned: false,
  project_ids: ["p"],
  source: "composer",
  workspace_ids: [`w-${id}`],
  created_at: t0,
  updated_at: t0,
  ...patch,
});
const chat = (id: string): WorkspaceView =>
  ({
    id,
    title: id,
    state: "completed",
    engine: { id: "claude", label: "Claude Agent" },
    computer: { kind: "this_mac", label: "This Mac" },
    projectId: "p",
    createdAt: t0,
    updatedAt: t0,
  }) as WorkspaceView;
const url = (n: number) => `https://github.com/caveman-ai/caveman-code`;
const mainRed = {
  base: "main",
  failing: ["test"],
  on_base: ["test"],
  base_state: "failing",
} as const;

describe("WorkList", () => {
  const items = [
    item("a", 26, "No chat limits for the Chief by default", {
      state: "needs_you",
      detail: "Checks are failing on #48.",
      pull_request: {
        number: 48,
        url: url(48),
        state: "open",
        checks: "failing",
        base_ci: mainRed,
      },
    }),
    item("b", 41, "Its own bug", {
      state: "needs_you",
      detail: "Checks are failing on #50.",
      pull_request: {
        number: 50,
        url: url(50),
        state: "open",
        checks: "failing",
        base_ci: { ...mainRed, failing: ["test", "lint"] },
      },
    }),
    item("c", 22, "Remove Mission Control", {
      pull_request: { number: 47, url: url(47), state: "open", checks: "passing" },
      done_when: "No route or menu still opens Mission Control",
    }),
    item("d", 9, "Main CI is red", { pull_request: { number: 39, url: url(39), state: "merged" } }),
  ];
  const groups = workGroups(
    items,
    items.map((i) => chat(`w-${i.id}`)),
    [],
    "CH",
  );
  const html = renderToStaticMarkup(
    createElement(WorkList, {
      groups,
      moves: {
        openChat: () => undefined,
        openDoc: () => undefined,
        start: () => undefined,
        act: () => undefined,
        attach: async () => undefined,
        mission: () => undefined,
        chiefWorkspaceId: "w-chief",
      },
    }),
  );

  test("rows blocked only by main sit under Ready to merge with the reason, never a bare CI failing", () => {
    expect(groups.map((g) => [g.group, g.work.map((w) => w.id)])).toEqual([
      ["needs", ["CH-41"]],
      ["ready", ["CH-26", "CH-22"]],
      ["done", ["CH-9"]],
    ]);
    expect(html).toContain("#48 · CI red on main · not this PR");
    expect(html).toContain("#50 · CI failing");
    expect(html).toContain("Needs your decision");
    expect(html).toContain("Ready to merge");
    // A merged pull request closed its item: it is in Done (folded), not in progress.
    expect(html).not.toContain("In progress");
  });

  test("each row offers its actions with their keys: merge when ready, re-run when red, and finishing it", () => {
    expect(html).toContain('aria-label="Merge"');
    expect(html).toContain('title="Merge… (M)"');
    expect(html).toContain('title="Re-run CI (R)"');
    expect(html).toContain('title="Mark done (D)"');
    expect(html).toContain('title="Drop (⌫)"');
    expect(html).toContain('title="Open pull request (P)"');
    expect(html).toContain('title="Open chat (O)"');
    // Every work row is focusable for its keys, and selectable.
    expect(html.match(/data-work-row=/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Select CH-26"');
  });

  test("a mission's done-when is one muted line under its title, whole in its tooltip and the row's name", () => {
    expect(html.match(/data-done-when=/g)).toHaveLength(1);
    expect(html).toContain('title="Done when No route or menu still opens Mission Control"');
    expect(html).toContain(">Done when No route or menu still opens Mission Control</span>");
    expect(html).toContain(
      "Remove Mission Control, Ready to merge. Done when No route or menu still opens Mission Control",
    );
  });
});
