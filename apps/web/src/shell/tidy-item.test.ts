import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { RuntimeContext, type RuntimeContextValue } from "../state/runtime.tsx";
import type { WorkspaceView } from "../state/model.ts";
import { TidyItem } from "./Tidy.tsx";

// The row outside a menu: what it says, with no menu around it, nor the window's panes.
vi.mock("@caveman-app/ui/components/dropdown-menu", () => ({
  DropdownMenuItem: ({ children }: { children: ReactNode }) =>
    createElement("div", { role: "menuitem" }, children),
}));
vi.mock("../panes/store.ts", () => ({ announce: () => undefined }));

const runtime = {
  client: { call: async () => ({}) },
  engines: [],
  workspaces: [],
  raw: new Map(),
  editors: [],
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;
const open = (old: (now: number) => ReadonlyArray<WorkspaceView>) =>
  renderToStaticMarkup(
    createElement(RuntimeContext.Provider, { value: runtime }, createElement(TidyItem, { old })),
  );

afterEach(() => void vi.useRealTimers());

test("Tidy's row counts the old chats as of when its menu opens, not as of the sidebar's last change", () => {
  vi.useFakeTimers();
  // One chat goes quiet a day after 09:00: the same chats, asked at 08:00 and at 10:00 the next day.
  const turnsOld = Date.parse("2026-11-12T09:00:00Z");
  const old = vi.fn((now: number) => (now >= turnsOld ? [{ id: "quiet" } as WorkspaceView] : []));
  vi.setSystemTime(Date.parse("2026-11-12T08:00:00Z"));
  expect(open(old)).toContain("Nothing old");
  vi.setSystemTime(Date.parse("2026-11-12T10:00:00Z"));
  // The menu opens again over the same sidebar, with nothing else changed.
  expect(open(old)).toContain("1 old chat");
  expect(old.mock.calls.map(([now]) => new Date(now).toISOString())).toEqual([
    "2026-11-12T08:00:00.000Z",
    "2026-11-12T10:00:00.000Z",
  ]);
});
