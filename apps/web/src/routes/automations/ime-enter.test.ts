// The keys that end an IME conversion (Japanese, Chinese, Korean) are part of typing. In an automation's fields its
// Enter writes, moves on from or leaves nothing, its Escape throws nothing away, and in the file it adds no line; a
// plain Enter still does each. Chromium and Electron send that Enter with isComposing; Safari fires compositionend
// first, so its Enter has isComposing false and keyCode 229 (chrome.tsx isComposing).
import { IME, press, render, settle, type, window } from "../dom.test-support.ts";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { LineField } from "./Detail.tsx";
import { CodeEditor } from "./FileTab.tsx";
import { SettingsForm } from "./Form.tsx";
import { NewAutomation } from "./New.tsx";

const FILE = `version: 1
description: Labelled issues get a first look
on:
  github:
    event: issues.labeled
    label: caveman
steps:
  triage:
    prompt: Read the issue and say what it needs.
  note:
    run: git notes add -m "triaged"
`;

const runtime = {
  status: "connected",
  error: null,
  client: null,
  identity: {},
  connection: 1,
  workspaces: [],
  raw: new Map(),
  projects: [],
  engines: [],
  settings: null,
  refresh: async () => undefined,
} as unknown as RuntimeContextValue;

/** The Settings tab's form over `FILE`; `written` is every text it wrote back. */
async function form() {
  const written: string[] = [];
  const view = await render(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value: runtime,
        children: createElement(SettingsForm, {
          text: FILE,
          onText: (t: string) => void written.push(t),
          scope: "project",
          problems: [],
        }),
      }),
    ),
  );
  return { written, host: view.host };
}

test("a GitHub trigger's labels: the Enter of a conversion writes none; a plain Enter writes every label typed", async () => {
  const { written, host } = await form();
  const field = host.querySelector<HTMLInputElement>(
    'input[aria-label="Labels, separated by commas"]',
  )!;
  await type(field, "caveman, バグ");
  for (const ime of IME) await press(field, "Enter", { ime });
  expect(written).toEqual([]);

  await type(field, "caveman, バグ報告");
  await press(field, "Enter");
  expect(written).toHaveLength(1);
  expect(written[0]).toMatch(/label: \[\s*caveman,\s*バグ報告\s*\]/);
});

test("a step's command: the Enter of a conversion writes nothing and its Escape keeps the draft; a plain Enter writes it", async () => {
  const { written, host } = await form();
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="note's command"]`)!;
  await type(field, 'git notes add -m "トリアージ"');
  for (const ime of IME) {
    await press(field, "Enter", { ime });
    await press(field, "Escape", { ime });
  }
  expect(written).toEqual([]);
  expect(field.value, "the command as typed").toBe('git notes add -m "トリアージ"');

  await type(field, 'git notes add -m "トリアージ済み"');
  await press(field, "Enter");
  expect(written).toHaveLength(1);
  expect(written[0]).toContain('git notes add -m "トリアージ済み"');
});

const focused: Element[] = [];
const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
const hadFocus = Object.getOwnPropertyDescriptor(proto, "focus");
afterEach(() => {
  focused.length = 0;
  if (hadFocus) Object.defineProperty(proto, "focus", hadFocus);
  else delete proto.focus;
});

test("a new automation's name: the Enter of a conversion keeps the name being typed; a plain Enter moves on to what it does", async () => {
  Object.defineProperty(proto, "focus", {
    configurable: true,
    writable: true,
    value: function (this: Element) {
      focused.push(this);
    },
  });
  await render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/automations?new=1"] },
      createElement(RuntimeFixture, { value: runtime, children: createElement(NewAutomation) }),
    ),
  );
  await settle();
  const name = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  const prompt = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="What it should do"]',
  )!;
  expect(name, "the box").not.toBeNull();
  await type(name, "東京の");
  focused.length = 0;
  for (const ime of IME) await press(name, "Enter", { ime });
  expect(focused).toEqual([]);

  await type(name, "東京の朝刊");
  await press(name, "Enter");
  expect(focused).toEqual([prompt]);
});

test("an automation's one line: the Enter of a conversion leaves it being typed; a plain Enter is done with it", async () => {
  const view = await render(
    createElement(LineField, {
      value: "毎朝",
      onChange: () => undefined,
      placeholder: "Say what it does in one line",
    }),
  );
  const field = view.host.querySelector("textarea")!;
  let blurs = 0;
  field.addEventListener("blur", () => blurs++);
  for (const ime of IME) await press(field, "Enter", { ime });
  expect(blurs).toBe(0);

  await press(field, "Enter");
  expect(blurs).toBe(1);
});

test("the file: the Enter of a conversion adds no line; a plain Enter adds one at the line's indent", async () => {
  const doc = document as unknown as { execCommand?: unknown };
  const had = doc.execCommand;
  // No editing commands here: insert() falls back to writing the value, as a browser without insertText does.
  doc.execCommand = () => false;
  try {
    const edits: string[] = [];
    const text = "steps:\n  triage:\n    prompt: 課題を読む";
    const view = await render(
      createElement(CodeEditor, {
        path: ".caveman/automations/triage.yaml",
        value: text,
        onChange: (t: string) => void edits.push(t),
        diagnostics: [],
        onSave: () => undefined,
      }),
    );
    const area = view.host.querySelector("textarea")!;
    await type(area, text);
    edits.length = 0;
    area.selectionStart = area.selectionEnd = text.length;
    for (const ime of IME) await press(area, "Enter", { ime });
    expect(edits).toEqual([]);

    await press(area, "Enter");
    expect(edits).toEqual([`${text}\n    `]);
  } finally {
    doc.execCommand = had;
  }
});
