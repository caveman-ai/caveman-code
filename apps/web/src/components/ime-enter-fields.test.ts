// The keys that end an IME conversion (Japanese, Chinese, Korean) are part of typing: in a search, a project field or
// a secrets sheet, its Enter picks, adds or saves nothing, and its Escape closes nothing. Chromium and Electron send
// them with isComposing; Safari fires compositionend first, so its Enter has isComposing false and keyCode 229
// (chrome.tsx isComposing).
import { document } from "../shell/dom.test-support.ts";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement, createRef, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { FileTree } from "../panels/files/FileTree.tsx";
import { RuntimeFixture } from "../state/runtime.tsx";
import { keydown, mount, settle, type } from "../shell/dom.test-support.ts";
import { FindBar } from "./find/FindBar.tsx";
import { ProjectChooserPanel } from "./ProjectPicker.tsx";
import { EnvImportSheet } from "./secrets/ComposerSecrets.tsx";
import { SecretSheet } from "./secrets/SecretSheet.tsx";

const SAFARI_IME_ENTER = { key: "Enter", keyCode: 229, isComposing: false };
const CHROME_IME_ENTER = { key: "Enter", keyCode: 229, isComposing: true };
const CHROME_IME_ESCAPE = { key: "Escape", keyCode: 229, isComposing: true };
const ENTER = { key: "Enter", keyCode: 13, isComposing: false };
const IME_KEYS = [CHROME_IME_ENTER, SAFARI_IME_ENTER, CHROME_IME_ESCAPE];
const named = (k: typeof ENTER) =>
  `${k.key} ${k.isComposing ? "while composing" : "ending a composition"}`;

const mounted: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount();
});

/** `element` on a page connected to a runtime whose `call` answers with `answer`; `calls` are the calls it got. */
async function page(
  element: ReactElement,
  answer: (method: string, params: Record<string, unknown>) => unknown = () => undefined,
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      return answer(method, params);
    },
    on: () => () => undefined,
  };
  const value = {
    status: "connected",
    error: null,
    client,
    connection: 1,
    identity: {
      userName: "Ada",
      computerName: "This Mac",
      computerWord: "this Mac",
      computerOnline: true,
    },
    workspaces: [],
    raw: new Map(),
    projects: [{ id: "p1", name: "acme", path: "/code/acme" }],
    engines: [],
    settings: null,
    refresh: async () => undefined,
  } as never;
  mounted.push(
    (
      await mount(
        createElement(
          MemoryRouter,
          null,
          createElement(
            TooltipProvider,
            null,
            createElement(RuntimeFixture, { value, children: element }),
          ),
        ),
      )
    ).unmount,
  );
  await settle();
  return { calls };
}

test("choosing a project: the Enter of a conversion picks no row; a plain Enter does", async () => {
  const picked: string[] = [];
  await page(
    createElement(ProjectChooserPanel, {
      hasProjects: true,
      inputRef: createRef<HTMLInputElement>(),
      onPicked: (p: { name: string }) => picked.push(p.name),
    }),
    () => ({ candidates: [], clone_dir: "" }),
  );
  const field = document.querySelector<HTMLInputElement>("input")!;
  for (const ime of IME_KEYS) {
    await keydown(field, ime);
    expect(picked, named(ime)).toEqual([]);
  }
  await keydown(field, ENTER);
  expect(picked).toEqual(["acme"]);
});

test("adding a folder by its path: the Enter of a conversion adds nothing; a plain Enter adds the whole path", async () => {
  const view = await page(
    createElement(ProjectChooserPanel, {
      hasProjects: false,
      inputRef: createRef<HTMLInputElement>(),
      onPicked: () => undefined,
    }),
    (method) =>
      method === "project.create"
        ? { id: "p2", name: "東京", path: "/code/東京" }
        : { candidates: [], clone_dir: "" },
  );
  const field = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await type(field, "~/code/東京");
  for (const ime of IME_KEYS) {
    await keydown(field, ime);
    expect(
      view.calls.filter(([m]) => m === "project.create"),
      named(ime),
    ).toEqual([]);
  }
  await type(field, "~/code/東京のアプリ");
  await keydown(field, ENTER);
  await settle();
  expect(view.calls.filter(([m]) => m === "project.create").map(([, p]) => p.path)).toEqual([
    "~/code/東京のアプリ",
  ]);
});

test("caught secrets: the Enter of a conversion in a name saves nothing and its Escape drops nothing; a plain Enter saves", async () => {
  const saved: string[][] = [];
  const cancels: number[] = [];
  await page(
    createElement(SecretSheet, {
      entries: [{ name: "API_KEY", value: "sk-live-0123456789abcdef" }],
      existing: new Set<string>(),
      repoLabel: "acme",
      mode: "paste",
      busy: false,
      error: null,
      onSave: (e: Array<{ name: string }>) => saved.push(e.map((s) => s.name)),
      onCancel: () => cancels.push(1),
    }),
  );
  const name = document.querySelector<HTMLInputElement>("input")!;
  for (const ime of IME_KEYS) {
    await keydown(name, ime);
    expect([saved, cancels], named(ime)).toEqual([[], []]);
  }
  await keydown(name, ENTER);
  expect(saved).toEqual([["API_KEY"]]);
});

test("a .env's names, filtered: the Enter of a conversion stores nothing and its Escape closes nothing; a plain Enter stores", async () => {
  const imported: string[][] = [];
  const cancels: number[] = [];
  const names = Array.from({ length: 9 }, (_, i) => `KEY_${i}`);
  await page(
    createElement(EnvImportSheet, {
      file: { path: ".env", names },
      repoLabel: "acme",
      busy: false,
      error: null,
      onImport: (n: string[]) => imported.push(n),
      onCancel: () => cancels.push(1),
    }),
  );
  const filter = [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (i) => i.type !== "checkbox",
  )!;
  expect(filter, "the filter field").toBeDefined();
  for (const ime of IME_KEYS) {
    await keydown(filter, ime);
    expect([imported, cancels], named(ime)).toEqual([[], []]);
  }
  await keydown(filter, ENTER);
  expect(imported).toEqual([names]);
});

test("find in chat: the Enter of a conversion steps to no match and its Escape keeps the bar; a plain Enter steps", async () => {
  const steps: number[] = [];
  const closes: number[] = [];
  await page(
    createElement(FindBar, {
      query: "東京",
      index: 0,
      total: 3,
      onQuery: () => undefined,
      onStep: (d: number) => steps.push(d),
      onClose: () => closes.push(1),
      focusKey: 0,
    }),
  );
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Find in chat"]')!;
  for (const ime of IME_KEYS) {
    await keydown(field, ime);
    expect([steps, closes], named(ime)).toEqual([[], []]);
  }
  await keydown(field, ENTER);
  expect(steps).toEqual([1]);
});

test("searching files: the Enter of a conversion opens no file and its Escape keeps the search; a plain Enter opens the first match", async () => {
  const opened: string[] = [];
  const view = await page(
    createElement(FileTree, {
      workspaceId: "w-ime",
      selected: null,
      reveal: 0,
      version: 1,
      onOpen: (path: string) => opened.push(path),
    }),
    (method) =>
      method === "fs.search"
        ? { paths: ["notes/東京.md"], truncated: false }
        : { path: "", entries: [{ name: "notes", path: "notes", type: "dir" }], truncated: false },
  );
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  await type(field, "東京");
  // The search asks the runtime once typing pauses.
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await settle();
  expect(
    view.calls.some(([m]) => m === "fs.search"),
    "the search ran",
  ).toBe(true);
  for (const ime of IME_KEYS) {
    await keydown(field, ime);
    expect(opened, named(ime)).toEqual([]);
    expect(field.value, named(ime)).toBe("東京");
  }
  await keydown(field, ENTER);
  expect(opened).toEqual(["notes/東京.md"]);
});
