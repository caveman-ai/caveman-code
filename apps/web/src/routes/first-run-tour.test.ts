// The tour after the first run (FirstRun.tsx, shell/tour-state.ts): it never runs on its own. Start on a first task opens
// its chat and Skip for now opens New chat, with no tour then or later and nothing left pending; only Show me around
// starts it. The tour itself loads only when it is asked for.
import { buttons, click, render, settle } from "./dom.test-support.ts";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import type { FirstRunEnd } from "./onboarding/model.ts";

// The first run's screens: one button for each way it can end.
vi.mock("./onboarding/Onboarding.tsx", () => ({
  Onboarding: (p: { onDone: (end: FirstRunEnd) => void }) =>
    createElement(
      "section",
      null,
      createElement("button", { onClick: () => p.onDone({ chat: "w1" }) }, "Start"),
      createElement("button", { onClick: () => p.onDone({ project: "p1" }) }, "Show me around"),
      createElement("button", { onClick: () => p.onDone(null) }, "Skip for now"),
    ),
}));
vi.mock("../whats-new/WhatsNew.tsx", () => ({ WhatsNew: () => null }));
vi.mock("../shell/RuntimeLinkNotice.tsx", () => ({ RuntimeLinkNotice: () => null }));
vi.mock("../shell/UsageNotice.tsx", () => ({ UsageNotice: () => null }));
vi.mock("../components/LatencyOverlay.tsx", () => ({ LatencyOverlay: () => null }));
vi.mock("../shell/GlobalSearch.tsx", () => ({ GlobalSearch: () => null }));
vi.mock("../shell/ShortcutHelp.tsx", () => ({ ShortcutHelp: () => null }));
vi.mock("../shell/WorkspaceFocus.tsx", () => ({ WorkspaceFocus: () => null }));
vi.mock("../components/Offers.tsx", () => ({ Offers: () => null }));
vi.mock("../state/notifications.ts", () => ({
  useNeedsYouTitle: () => undefined,
  useWorkspaceNotifications: () => undefined,
}));
// The tour is a mark here, and how often it was loaded is counted: the real one is not what this decides.
const loaded = vi.hoisted(() => ({ tour: 0 }));
vi.mock("../shell/Tour.tsx", () => {
  loaded.tour++;
  return { Tour: () => createElement("div", { "data-tour-mark": "" }) };
});

import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { tourPending } from "../shell/tour-state.ts";
import { FirstRunGate } from "./FirstRun.tsx";

afterEach(() => {
  delete (window as { cavemanDesktop?: unknown }).cavemanDesktop;
  localStorage.clear();
});

const runtime = {
  status: "connected",
  error: null,
  client: null,
  connection: 1,
  workspaces: [],
  raw: new Map(),
  projects: [],
  engines: [],
  settings: null,
  refresh: async () => undefined,
  markSeen: () => undefined,
} as unknown as RuntimeContextValue;

/** A page in the app: its path, and a button to go to the Chief. */
function Page(): ReactNode {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return createElement(
    "main",
    { "data-at": pathname },
    createElement("button", { onClick: () => navigate("/chief") }, "Go to the Chief"),
  );
}

async function firstRun() {
  (window as { cavemanDesktop?: unknown }).cavemanDesktop = {
    runtime: { url: "ws://127.0.0.1:1", token: "t" },
  };
  const app = createElement(
    Routes,
    null,
    createElement(
      Route,
      { element: createElement(FirstRunGate) },
      createElement(Route, { path: "*", element: createElement(Page) }),
    ),
  );
  const view = await render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/"] },
      createElement(RuntimeFixture, { value: runtime, children: app }),
    ),
  );
  await settle(2);
  return view;
}
const tourShown = (host: HTMLElement) => host.querySelector("[data-tour-mark]") !== null;

test("Start on a first task opens its chat; the tour does not run then or later, and nothing is left pending", async () => {
  const started = vi.fn();
  window.addEventListener("caveman:tour", started);
  const { host } = await firstRun();
  expect(loaded.tour).toBe(0); // the tour is not loaded for the first run
  await click(buttons(host, "Start")[0]);
  await settle(3);
  // The chat is open; the tour was not started, is not on screen and is not kept for later.
  expect(host.querySelector("[data-at]")?.getAttribute("data-at")).toBe("/w/w1");
  expect(started).not.toHaveBeenCalled();
  expect(tourShown(host)).toBe(false);
  expect(tourPending()).toBe(false);
  expect(localStorage.getItem("caveman.firstRunDone")).toBe("1");
  // The next visit to the Chief does not open it either, and the tour is still not loaded.
  await click(buttons(host, "Go to the Chief")[0]);
  await settle(3);
  expect(tourShown(host)).toBe(false);
  expect(tourPending()).toBe(false);
  expect(loaded.tour).toBe(0);
  window.removeEventListener("caveman:tour", started);
});

test("Show me around starts the tour on the project's Chief", async () => {
  const started = vi.fn();
  window.addEventListener("caveman:tour", started);
  const { host } = await firstRun();
  await click(buttons(host, "Show me around")[0]);
  await settle(3);
  expect(started).toHaveBeenCalledTimes(1);
  expect(host.querySelector("[data-at]")?.getAttribute("data-at")).toBe("/chief");
  expect(tourShown(host)).toBe(true);
  window.removeEventListener("caveman:tour", started);
});

test("Skip for now opens New chat with no tour", async () => {
  const started = vi.fn();
  window.addEventListener("caveman:tour", started);
  const { host } = await firstRun();
  await click(buttons(host, "Skip for now")[0]);
  await settle(3);
  expect(started).not.toHaveBeenCalled();
  expect(host.querySelector("[data-at]")?.getAttribute("data-at")).toBe("/new");
  expect(tourShown(host)).toBe(false);
  expect(tourPending()).toBe(false);
  window.removeEventListener("caveman:tour", started);
});
