// A Chief's name in its settings sheet saves on Enter or on leaving the field. The Enter that commits an IME
// conversion is still typing: Chromium and Electron send it with isComposing, Safari with keyCode 229 after
// compositionend (chrome.tsx isComposing). The sheet is the real ChiefSheet on a runtime that answers chief.list and
// records chief.update.
import { document, keydown, mount, settle, type } from "../shell/dom.test-support.ts";
import type { ChiefProfile } from "@caveman-app/session-protocol";
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { ChiefSheet } from "./chief-sheet.tsx";

// The sheet's permission picker as a plain box: Radix Select builds DocumentFragments linkedom can't construct.
vi.mock("@caveman-app/ui/components/select", async () => {
  const { createElement: h } = await import("react");
  const box = (p: { children?: ReactNode }) => h("div", null, p.children);
  return {
    Select: box,
    SelectTrigger: box,
    SelectValue: () => null,
    SelectContent: box,
    SelectItem: box,
  };
});

const SAFARI_IME_ENTER = { key: "Enter", keyCode: 229, isComposing: false };
const CHROME_IME_ENTER = { key: "Enter", keyCode: 229, isComposing: true };
const ENTER = { key: "Enter", keyCode: 13, isComposing: false };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const at = "2026-11-01T09:00:00.000Z";
const profile = {
  id: "c1",
  name: "Scout",
  home: false,
  avatar: null,
  soul: "",
  project_ids: [],
  access: null,
  created_at: at,
  updated_at: at,
} as unknown as ChiefProfile;

/** A just-made Chief's sheet, open on its name; `renames` are the names chief.update was sent. */
async function sheet() {
  const renames: string[] = [];
  const client = {
    call: async (method: string, params: { name?: string }) => {
      if (method === "chief.list") return { chiefs: [profile] };
      if (method === "chief.update") {
        if (params.name !== undefined) renames.push(params.name);
        return { chief: { ...profile, ...params } };
      }
      throw new Error(`${method} is not part of this test`);
    },
    on: () => () => undefined,
  };
  const runtime = {
    status: "connected",
    error: null,
    client,
    connection: 1,
    identity: {},
    workspaces: [],
    raw: new Map(),
    projects: [],
    engines: [],
    settings: null,
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const chief = { profile, picker: [], model: null, status: "ready" };
  const view = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value: runtime,
        children: createElement(ChiefSheet, {
          chief: chief as never,
          open: true,
          onOpenChange: () => undefined,
          naming: true,
        }),
      }),
    ),
  );
  cleanups.push(view.unmount);
  await settle();
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
  if (!field) throw new Error(`no name field in ${document.body.innerHTML}`);
  return { field, renames };
}

test("naming a Chief: the Enter that commits a conversion, in Chrome or Safari, saves nothing; a plain Enter saves the whole name", async () => {
  const { field, renames } = await sheet();
  // 東京 confirmed, the rest of the name still to type.
  await type(field, "東京");
  for (const ime of [CHROME_IME_ENTER, SAFARI_IME_ENTER]) {
    await keydown(field, ime);
    await settle();
    expect(
      renames,
      ime.isComposing ? "Chrome's composing Enter" : "Safari's composition-commit Enter",
    ).toEqual([]);
  }
  await type(field, "東京ボット");
  await keydown(field, ENTER);
  await settle();
  expect(renames).toEqual(["東京ボット"]);
});
