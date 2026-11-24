// The Enter that commits an IME conversion (Japanese, Chinese, Korean) is part of typing: it never runs ⌘K's row or
// ends a rename. Chromium and Electron send it with isComposing; Safari fires compositionend first, so its keydown has
// isComposing false and keyCode 229 (chrome.tsx isComposing).
import { document } from "./dom.test-support.ts";
import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { RuntimeContext, RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { GoTo } from "./GoTo.tsx";
import { PaneHeader } from "../components/pane/PaneHeader.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { click, keydown, mount } from "./dom.test-support.ts";

const SAFARI_IME_ENTER = { key: "Enter", keyCode: 229, isComposing: false };
const CHROME_IME_ENTER = { key: "Enter", keyCode: 229, isComposing: true };
const CHROME_IME_ESCAPE = { key: "Escape", keyCode: 229, isComposing: true };
const ENTER = { key: "Enter", keyCode: 13, isComposing: false };
const MENU_KEY = { key: "ContextMenu", keyCode: 93, isComposing: false };

const runtime = {
  client: null,
  engines: [],
  workspaces: [],
  projects: [],
  settings: null,
  saveSettings: async () => undefined,
  raw: new Map(),
  editors: [],
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;
const page = (element: ReactElement) =>
  mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeContext.Provider, { value: runtime }, element),
    ),
  );

test("⌘K: the Enter that commits a conversion runs no row, in Chrome or Safari; a plain Enter does", async () => {
  const closes: boolean[] = [];
  const view = await page(
    createElement(GoTo, {
      open: true,
      onOpenChange: (open: boolean) => closes.push(open),
      onCloseAutoFocus: () => undefined,
    }),
  );
  const input = document.querySelector('input[role="combobox"]')!;
  expect(document.querySelectorAll('[role="option"]').length, "rows to pick").toBeGreaterThan(0);
  await keydown(input, CHROME_IME_ENTER);
  expect(closes, "Chrome's composing Enter").toEqual([]);
  await keydown(input, SAFARI_IME_ENTER);
  expect(closes, "Safari's composition-commit Enter").toEqual([]);
  await keydown(input, ENTER);
  expect(closes).toEqual([false]);
  await view.unmount();
});

test("renaming a chat in its header: the Enter or Escape of a conversion keeps the rename open; a plain Enter saves", async () => {
  const renames: string[] = [];
  const noop = () => undefined;
  const view = await page(
    createElement(PaneHeader, {
      workspaceId: "w1",
      title: "old name",
      status: null,
      focused: true,
      canSplit: false,
      pinned: false,
      archived: false,
      onTogglePin: noop,
      onRename: (t: string) => renames.push(t),
      onArchive: noop,
      onRestore: noop,
      onRun: noop,
      onDragStart: noop,
    }),
  );
  await click(
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("old name"))!,
  );
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((m) =>
      m.textContent?.includes("Rename"),
    ) as HTMLElement,
  );
  const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Chat name"]');
  expect(field(), "the rename field").not.toBeNull();
  // 東京 confirmed, the rest of the name still to type.
  field()!.value = "東京";
  // Typed, as the rename field saves only what the person typed (rename-field.ts).
  field()!.dataset.typed = "";
  for (const ime of [CHROME_IME_ENTER, SAFARI_IME_ENTER, CHROME_IME_ESCAPE]) {
    await keydown(field()!, ime);
    expect(
      renames,
      `${ime.key} ${ime.isComposing ? "while composing" : "ending a composition"}`,
    ).toEqual([]);
    expect(field(), "the rename stays open").not.toBeNull();
    expect(field()!.value).toBe("東京");
  }
  field()!.value = "東京のプロジェクト";
  // Typed, as the rename field saves only what the person typed (rename-field.ts).
  field()!.dataset.typed = "";
  await keydown(field()!, ENTER);
  expect(renames).toEqual(["東京のプロジェクト"]);
  await view.unmount();
});

/** The sidebar with one project, acme, holding one chat, say hi; `calls` are the runtime calls it made. */
async function sidebar() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const now = new Date().toISOString();
  const chat = {
    id: "w1",
    title: "say hi",
    state: "completed",
    asleep: false,
    parentId: null,
    projectId: "p1",
    repo: "acme",
    createdAt: now,
    updatedAt: now,
    engine: { id: "caveman", label: "Caveman" },
    computer: { kind: "this_mac", label: "This Mac" },
    sessionId: "s1",
    branch: "main",
  };
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "workspace.rename" || method === "project.update") return {};
      throw new Error(`${method} is not part of this test`);
    },
    on: () => () => undefined,
  };
  const value = {
    status: "connected",
    error: null,
    client,
    identity: { userName: "Ada" },
    workspaces: [chat],
    raw: new Map(),
    projects: [{ id: "p1", name: "acme", path: "/code/acme" }],
    engines: [],
    settings: null,
    refresh: async () => undefined,
    connection: 1,
    markSeen: () => undefined,
  } as unknown as RuntimeContextValue;
  const view = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, { value, children: createElement(Sidebar) }),
    ),
  );
  const renamed = () =>
    calls
      .filter(([method]) => method === "workspace.rename" || method === "project.update")
      .map(([, params]) => (params.title ?? params.name) as string);
  return { renamed, ...view };
}

/**
 * Opens a row's menu and chooses Rename: the row's name field. A chat's menu opens from its ⋯ (`chat`, the trigger's
 * label); a project's from the menu key on its row (`project`, the row's data-peek), as it has no ⋯.
 */
async function rename(
  menu: { readonly chat: string } | { readonly project: string },
  field: string,
): Promise<() => HTMLInputElement | null> {
  if ("chat" in menu)
    await keydown(document.querySelector(`button[aria-label="${menu.chat}"]`)!, ENTER);
  else await keydown(document.querySelector(`[data-peek="${menu.project}"]`)!, MENU_KEY);
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((m) =>
      m.textContent?.includes("Rename"),
    ) as HTMLElement,
  );
  const input = () => document.querySelector<HTMLInputElement>(`input[aria-label="${field}"]`);
  expect(input(), `the ${field} field`).not.toBeNull();
  return input;
}

test("renaming a chat or a project in the sidebar: the Enter or Escape of a conversion keeps the rename open; a plain Enter saves", async () => {
  for (const [menu, label, typed] of [
    [{ chat: "say hi options" }, "Chat name", "東京のプロジェクト"],
    [{ project: "project:p1" }, "Project name", "北京のアプリ"],
  ] as const) {
    const { renamed, unmount } = await sidebar();
    const field = await rename(menu, label);
    field()!.value = typed.slice(0, 2);
    // Typed, as the rename field saves only what the person typed (rename-field.ts).
    field()!.dataset.typed = "";
    for (const ime of [CHROME_IME_ENTER, SAFARI_IME_ENTER, CHROME_IME_ESCAPE]) {
      await keydown(field()!, ime);
      expect(
        renamed(),
        `${label}: ${ime.key} ${ime.isComposing ? "while composing" : "ending a composition"}`,
      ).toEqual([]);
      expect(field(), `${label}: the rename stays open`).not.toBeNull();
      expect(field()!.value).toBe(typed.slice(0, 2));
    }
    field()!.value = typed;
    // Typed, as the rename field saves only what the person typed (rename-field.ts).
    field()!.dataset.typed = "";
    await keydown(field()!, ENTER);
    expect(renamed()).toEqual([typed]);
    await unmount();
  }
});
