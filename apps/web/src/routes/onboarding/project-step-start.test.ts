// The project step once a project is picked (ProjectStep.tsx): Start on the first suggestion is the view's one filled
// button, Show me around sits beside it as the secondary button, and the step says what new chats run with. With no engine
// to start a task on, Show me around stays the filled button.
import { buttons, click, render, settle } from "../dom.test-support.ts";
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import type { FirstRunEnd } from "./model.ts";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// Picking a project is the chooser's own; here the project is picked as the chooser's first press.
vi.mock("../../components/ProjectPicker.tsx", () => ({
  ProjectChooserPanel: (p: { onPicked: (project: unknown) => void }) =>
    createElement(
      "button",
      {
        onClick: () =>
          p.onPicked({ id: "p1", name: "app", path: "/app", repository: { host: "github.com" } }),
      },
      "Pick app",
    ),
}));
vi.mock("../../components/GazeMascot.tsx", () => ({ GazeMascot: () => null }));
vi.mock("../../panes/drag.ts", () => ({}));

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { ProjectStep } from "./ProjectStep.tsx";

// The page's key listeners (the footer's Enter) go through window; the test page sets only window.
Object.assign(globalThis, {
  addEventListener: window.addEventListener.bind(window),
  removeEventListener: window.removeEventListener.bind(window),
});

const engine = {
  id: "caveman",
  label: "Caveman",
  version: "1",
  auth: { state: "signed_in", accounts: [] },
} as unknown as EngineDescriptor;
const answers = (issues: unknown[]) => ({
  call: async (method: string) => {
    if (method === "setup.scan") return { items: [] };
    if (method === "environment.draft") return { config: "", evidence: [], secret_names: [] };
    if (method === "github.issues") return { issues };
    if (method === "github.status") return { login: "octocat", source: "gh" };
    if (method === "account.get") return { signed_in: false };
    if (method === "workspace.create") return { id: "w1" };
    return {};
  },
});

async function atProjectStep(
  engines: EngineDescriptor[],
  issues: unknown[] = [],
  onDone: (end: FirstRunEnd) => void = () => undefined,
) {
  const value = {
    status: "connected",
    client: answers(issues),
    engines,
    settings: null,
    projects: [],
    workspaces: [],
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const view = await render(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(ProjectStep, {
          onBack: () => undefined,
          onDone,
          onUnlock: () => undefined,
          plans: 0,
        }),
      }),
    ),
  );
  await settle(2);
  await click(buttons(view.host, "Pick app")[0]);
  await settle(4);
  return view.host;
}
/** The filled button is the kit's default variant, which the Button marks data-tone="lit"; secondary is "card", ghost none. */
const filled = (b: Element | undefined) => b?.getAttribute("data-tone") === "lit";
const secondary = (b: Element | undefined) => b?.getAttribute("data-tone") === "card";

test("Start on the first suggestion is the one filled button; Show me around is quieter", async () => {
  const host = await atProjectStep(
    [engine],
    [{ number: 7, title: "Crash on start", url: "https://x/7", assigned_to_me: true }],
  );
  const start = buttons(host, "Start");
  expect(start).toHaveLength(2); // the issue, and Explain how this repo fits together
  expect(filled(start[0])).toBe(true);
  expect(filled(start[1])).toBe(false);
  expect(filled(buttons(host, /Show me around/)[0])).toBe(false);
  expect(secondary(buttons(host, /Show me around/)[0])).toBe(true); // secondary, not ghost
  // Exactly one filled button in the view.
  expect([...host.querySelectorAll("button")].filter((b) => filled(b))).toHaveLength(1);
});

test("with no issues, Start on Explain is the first suggestion and the filled one", async () => {
  const host = await atProjectStep([engine]);
  const start = buttons(host, "Start");
  expect(start).toHaveLength(1);
  expect(filled(start[0])).toBe(true);
});

test("the step says what new chats run with, in the permissions picker's words", async () => {
  const host = await atProjectStep([engine]);
  expect(host.textContent).toContain(
    "New chats run on Full access: allow commands and edits without prompts.",
  );
});

test("with no engine there is no task to start, and Show me around is the filled button", async () => {
  const host = await atProjectStep([]);
  expect(buttons(host, "Start")).toHaveLength(0);
  expect(filled(buttons(host, /Show me around/)[0])).toBe(true);
});

test("Start ends the first run on the new chat, and Show me around on the project", async () => {
  const ends: FirstRunEnd[] = [];
  const host = await atProjectStep([engine], [], (end) => ends.push(end));
  await click(buttons(host, "Start")[0]);
  await settle(3);
  expect(ends).toEqual([{ chat: "w1" }]);
  const again: FirstRunEnd[] = [];
  const other = await atProjectStep([engine], [], (end) => again.push(end));
  await click(buttons(other, /Show me around/)[0]);
  await settle(2);
  expect(again).toEqual([{ project: "p1" }]);
});
