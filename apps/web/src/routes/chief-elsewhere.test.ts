// The Chief's page in a browser window that uses a Cloud computer, where no Chief is made: the person's Chief is on
// their Mac. Until that Mac is ready for this browser the page shows the step that gets it there, the same one
// Plugins and Automations show with no computer (shell/NeedsMac.tsx), never a line that only says to open the app.
import { afterEach, expect, test, vi } from "vitest";
import { click, mount } from "./chief-browser.fixture.ts";
import { createElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { RuntimeFixture, WebWindowFixture } from "../state/runtime.tsx";
import { DOWNLOAD_URL, type MacHere } from "../state/sync/web-window.ts";
import { ChiefRoute } from "./Chief.tsx";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.unstubAllGlobals();
});

const STUDIO = {
  kind: "mac",
  name: "Studio",
  runtimeId: "rt-studio",
  computerId: "c-studio",
} as const;

/** The Chief's page as a window on a Cloud computer draws it, with the person's Mac as this browser stands with it. */
async function chiefOnCloud(mac: MacHere) {
  const calls: string[] = [];
  const client = {
    call: (method: string) => {
      calls.push(method);
      return new Promise(() => undefined);
    },
    on: () => () => undefined,
    subscribe: () => () => undefined,
  };
  const runtime = {
    status: "connected",
    error: null,
    client,
    identity: {},
    connection: 1,
    // A Cloud computer the window uses: the person's Chief is never read (or made) there.
    chiefHere: false,
    workspaces: [],
    raw: new Map(),
    projects: [],
    engines: [],
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
  };
  const usePlace = vi.fn();
  const web = {
    window: { kind: "app", failed: false, nothingYet: false },
    places: { places: [], lines: [] },
    home: { kind: "cloud", name: "Cloud" },
    mac,
    usePlace,
  };
  const view = await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ["/chief"] },
      createElement(RuntimeFixture, {
        value: runtime as never,
        children: createElement(WebWindowFixture, {
          value: web as never,
          children: createElement(
            Routes,
            null,
            createElement(Route, { path: "/chief", element: createElement(ChiefRoute) }),
          ),
        }),
      }),
    ),
  );
  cleanups.push(view.unmount);
  const said = () => (view.container.textContent ?? "").replace(/\s+/g, " ");
  const button = (label: string) =>
    [...view.container.querySelectorAll("button, a")].find((b) => b.textContent?.trim() === label);
  return { said, button, usePlace, calls };
}

test("no Mac signed in: the page says where the Chief is and offers the Mac app, and asks the Cloud computer for no Chief", async () => {
  // The download is a Mac's (web-window.ts canGetMacHere); a browser on any other computer is told so instead.
  vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh", maxTouchPoints: 0 });
  const page = await chiefOnCloud({ kind: "none" });
  expect(page.said()).toContain("Your Chief is on your Mac");
  expect(page.said()).toContain(
    "Get Caveman Code for Mac, then sign in with this account and turn on sync.",
  );
  expect(page.button("Download for Mac")?.getAttribute("href")).toBe(DOWNLOAD_URL);
  expect(page.said()).not.toContain("Talk to it on");
  // No Chief is read, made or written to on a Cloud computer, and with none there is no box to write in.
  expect(page.calls.filter((m) => m.startsWith("chief."))).toEqual([]);
  expect(page.button("Send")).toBeUndefined();
});

test("a Mac on line that never met this browser: one button connects to it, and the Mac then asks", async () => {
  const page = await chiefOnCloud({ kind: "ask", name: "Studio", place: STUDIO });
  expect(page.said()).toContain("Studio asks you once to allow this browser.");
  await click(page.button("Connect to Studio")!);
  expect(page.usePlace).toHaveBeenCalledWith(STUDIO);
});

test("a Mac that is asking, asleep or refusing says what to do there, with nothing to press here", async () => {
  const waiting = await chiefOnCloud({ kind: "waiting", name: "Studio", code: "TQ4-K9P" });
  expect(waiting.said()).toContain(
    "On Studio, choose Allow, and check it shows TQ4-K9P. You only do this once.",
  );
  expect(waiting.button("Connect to Studio")).toBeUndefined();
  const asleep = await chiefOnCloud({ kind: "asleep", name: "Studio" });
  expect(asleep.said()).toContain(
    "Studio isn't on line. Open Caveman Code there and keep sync on.",
  );
  expect(asleep.said()).not.toContain("Talk to it on");
});

test("a Mac that let this browser in: the page keeps its own way over, and names no step", async () => {
  const page = await chiefOnCloud({ kind: "ready", name: "Studio" });
  expect(page.said()).toContain("Your Chief is on your Mac");
  expect(page.said()).toContain("This tab is talking to a Cloud computer, which has no Chief.");
  expect(page.said()).not.toContain("Download for Mac");
});
