// The File tab's ⌘S, mounted with React DOM: a save pressed while another is still being written waits for it, so
// the file ends as last typed and the Save button says Saving… until the last write answers.
import { document, fire } from "../../testing/dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { FileTab } from "./FileTab.tsx";
import { SCHEMA_LINE } from "./model.ts";
import type { Automation } from "./model.ts";

const PATH = ".caveman/local/automations/nightly.yaml";
const nightly = {
  id: "file:p1:me:nightly",
  path: PATH,
  project_id: "p1",
  source: "file",
  scope: "me",
  title: "Nightly",
  enabled: true,
} as unknown as Automation;
const ON_DISK = `${SCHEMA_LINE}\nsteps:\n  sweep:\n    prompt: Sweep.\n`;

const unmounts: Array<() => void> = [];
afterEach(() => unmounts.splice(0).forEach((u) => u()));

/** The tab over a runtime that writes the file only when the test says, in whatever order it says. */
async function mount() {
  const disk = { text: ON_DISK };
  const writes: Array<{ text: string; land: () => void }> = [];
  let writing = 0;
  let most = 0;
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      if (method === "automation.file_read") return { text: disk.text };
      if (method === "agent.types") return { types: [] };
      if (method === "automation.check") return { diagnostics: [] };
      if (method === "automation.file_write") {
        most = Math.max(most, ++writing);
        const text = params.text as string;
        return new Promise((resolve) =>
          writes.push({ text, land: () => ((disk.text = text), writing--, resolve({})) }),
        );
      }
      return new Promise(() => undefined);
    },
    on: () => () => undefined,
  };
  const value = {
    status: "connected",
    client,
    connection: 1,
    projects: [],
    engines: [],
    settings: null,
    workspaces: [],
  } as unknown as RuntimeContextValue;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(RuntimeFixture, {
          value,
          children: createElement(FileTab, { automation: nightly, explanation: undefined }),
        }),
      ),
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  await settle();
  const editor = () => host.querySelector("textarea")!;
  const type = async (text: string) => {
    const setValue = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(editor()),
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(editor(), text);
      fire(editor(), "input");
    });
  };
  const commandS = () =>
    act(
      async () =>
        void fire(editor(), "keydown", {
          key: "s",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        }),
    );
  const saveButton = () =>
    [...host.querySelectorAll("button")].find((b) =>
      /^(Save|Saved|Saving…)$/.test(b.textContent ?? ""),
    )!.textContent;
  return { disk, writes, most: () => most, type, commandS, settle, saveButton };
}

test("⌘S pressed again while the first save is still written leaves the file as last typed", async () => {
  const tab = await mount();
  const first = `${ON_DISK}    model: fast\n`;
  const second = `${first}    retries: 2\n`;
  await tab.type(first);
  await tab.commandS();
  await tab.type(second);
  await tab.commandS();
  // The runtime answers the newest write it holds first, as two overlapping writes may finish.
  const whileWritten: string[] = [];
  while (tab.writes.length > 0) {
    tab.writes.pop()!.land();
    await tab.settle();
    if (tab.writes.length > 0) whileWritten.push(tab.saveButton()!);
  }
  expect(tab.disk.text).toBe(second);
  expect(tab.most()).toBe(1);
  expect(whileWritten.every((label) => label === "Saving…")).toBe(true);
  expect(tab.saveButton()).toBe("Saved");
});
