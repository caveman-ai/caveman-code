// What a window opens on (FirstRun.tsx FirstRunGate). The desktop app keeps its first run exactly: nothing kept from an
// earlier launch shows it from the first paint, with the account required in a packaged app, and a runtime's own page
// with no link asks for one. A browser window Caveman Cloud serves has neither and no front door: signed out it is one
// line and one button; signed in it is the app, with or without a runtime, and nothing asks which computer.
import { render, settle } from "./dom.test-support.ts";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

// The first run's screens and what sits over the shell are not what this decides: each is a mark here.
vi.mock("./onboarding/Onboarding.tsx", () => ({
  Onboarding: (p: { signIn: string }) =>
    createElement("section", { "data-first-run": p.signIn }, "First run"),
}));
vi.mock("../whats-new/WhatsNew.tsx", () => ({ WhatsNew: () => null }));
vi.mock("../shell/RuntimeLinkNotice.tsx", () => ({ RuntimeLinkNotice: () => null }));
vi.mock("../shell/UsageNotice.tsx", () => ({ UsageNotice: () => null }));
vi.mock("../components/LatencyOverlay.tsx", () => ({ LatencyOverlay: () => null }));
vi.mock("../shell/GlobalSearch.tsx", () => ({ GlobalSearch: () => null }));
vi.mock("../shell/ShortcutHelp.tsx", () => ({ ShortcutHelp: () => null }));
vi.mock("../shell/WorkspaceFocus.tsx", () => ({ WorkspaceFocus: () => null }));
vi.mock("../shell/Tour.tsx", () => ({ Tour: () => null }));
vi.mock("../components/Offers.tsx", () => ({ Offers: () => null }));
vi.mock("../state/notifications.ts", () => ({
  useNeedsYouTitle: () => undefined,
  useWorkspaceNotifications: () => undefined,
}));

import {
  RuntimeFixture,
  WebWindowFixture,
  type RuntimeContextValue,
  type WebWindowValue,
} from "../state/runtime.tsx";
import { chatPlaces, webWindow } from "../state/sync/web-window.ts";
import { FirstRunGate } from "./FirstRun.tsx";

afterEach(() => {
  delete (window as { cavemanDesktop?: unknown }).cavemanDesktop;
  localStorage.clear();
});

const runtime = (over: Partial<RuntimeContextValue>): RuntimeContextValue =>
  ({
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
    ...over,
  }) as RuntimeContextValue;
const chats = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
  })) as unknown as RuntimeContextValue["workspaces"];
const web = (signedIn: boolean | null, list: Parameters<typeof webWindow>[1]): WebWindowValue => ({
  window: webWindow(signedIn, list),
  places: chatPlaces(null, true),
  home: null,
  mac: { kind: "none" },
  usePlace: () => undefined,
});
const LIVE = { status: "live" as const, ready: true };

/** The gate over the app (a mark), at `path`: what the window shows, as words. */
async function opens(
  value: RuntimeContextValue,
  window_: WebWindowValue | null = null,
  path = "/new",
): Promise<string> {
  const app = createElement(
    Routes,
    null,
    createElement(
      Route,
      { element: createElement(FirstRunGate) },
      createElement(Route, {
        path: "*",
        element: createElement("main", { "data-app": "" }, "The app"),
      }),
    ),
  );
  const inRuntime: ReactNode = createElement(RuntimeFixture, {
    value,
    children: window_ ? createElement(WebWindowFixture, { value: window_, children: app }) : app,
  });
  const view = await render(createElement(MemoryRouter, { initialEntries: [path] }, inRuntime));
  await settle(3);
  const said = view.host.textContent ?? "";
  const firstRun = view.host.querySelector("[data-first-run]")?.getAttribute("data-first-run");
  await view.unmount();
  return firstRun ? `first run, sign-in ${firstRun}` : said.replace(/\s+/g, " ").trim();
}

test("the desktop app's first run is as it was: shown while its runtime starts with nothing kept, the account required when packaged", async () => {
  const w = window as { cavemanDesktop?: unknown };
  w.cavemanDesktop = { runtime: { url: "ws://127.0.0.1:1", token: "t" }, packaged: true };
  // Nothing kept from an earlier launch: the first run from the first paint, never the empty shell.
  expect(await opens(runtime({ status: "connecting" }))).toBe("first run, sign-in required");
  expect(await opens(runtime({ status: "connected" }))).toBe("first run, sign-in required");
  // A development build may skip the account.
  w.cavemanDesktop = { runtime: { url: "ws://127.0.0.1:1", token: "t" } };
  expect(await opens(runtime({ status: "connected" }))).toBe("first run, sign-in optional");
  // Chats kept or listed: the app. Settings stays reachable from the first run. Once finished here, it stays finished.
  expect(await opens(runtime({ status: "connected", workspaces: chats(2) }))).toBe("The app");
  expect(await opens(runtime({ status: "connected" }), null, "/settings/models")).toBe("The app");
  localStorage.setItem("caveman.firstRunDone", "1");
  expect(await opens(runtime({ status: "connected" }))).toBe("The app");
});

test("a runtime's own page with no link asks for one, as before; with one and no chats it shows the first run", async () => {
  expect(await opens(runtime({ status: "unconfigured" }))).toContain("Connect to Caveman Code");
  expect(await opens(runtime({ status: "connected" }))).toBe("first run, sign-in optional");
  expect(await opens(runtime({ status: "connecting" }))).toBe("The app");
});

test("a browser window with nobody signed in is one line and one button, in plain words", async () => {
  const said = await opens(runtime({ status: "unconfigured" }), web(false, null));
  expect(said).toBe("Caveman CodeSign in to see your chats.Sign in");
  expect(said).not.toMatch(/Caveman need|Pick a computer|runtime/);
});

test("a browser window signed in is the app: no door, no connect screen and no first run, with or without a runtime", async () => {
  const nothing = { ...LIVE, chats: { size: 0 } };
  // A first visit: no chat, no computer. The app, which opens on New chat (panes/store.ts homePath).
  expect(await opens(runtime({ status: "unconfigured" }), web(true, nothing))).toBe("The app");
  // Every place asleep, chats in Cloud's list.
  expect(
    await opens(
      runtime({ status: "unconfigured", workspaces: chats(3) }),
      web(true, { ...LIVE, chats: { size: 3 } }),
    ),
  ).toBe("The app");
  // On a runtime with no chats (a Mac that let this browser in): the app, never that Mac's first run.
  expect(await opens(runtime({ status: "connected" }), web(true, nothing))).toBe("The app");
  // A relay that refused, a runtime in trouble: the app stays.
  expect(
    await opens(runtime({ status: "error", error: "The relay closed." }), web(true, nothing)),
  ).toBe("The app");
  // Cloud cannot be reached, with nothing kept on this device: still the app, which says so in its sidebar.
  expect(
    await opens(
      runtime({ status: "unconfigured" }),
      web(true, { status: "reconnecting", ready: false, chats: { size: 0 } }),
    ),
  ).toBe("The app");
});

test("a browser window shows nothing of anyone's until Cloud has said who is signed in", async () => {
  expect(await opens(runtime({ status: "unconfigured" }), web(null, null))).toBe("");
  expect(
    await opens(
      runtime({ status: "unconfigured" }),
      web(true, { status: "loading", ready: false, chats: { size: 0 } }),
    ),
  ).toBe("");
});

test("a window with nothing kept opens on the Chief; a browser window Cloud serves, on New chat", async () => {
  const { homePath } = await import("../panes/store.ts");
  expect(homePath(false)).toBe("/chief");
  expect(homePath(true)).toBe("/new");
});
