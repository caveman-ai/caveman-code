// The first visit's card in a browser window (components/WebStartCard.tsx, state/sync/web-window.ts startCard), the
// free way in the Unlock sheet (components/UnlockPlans.tsx FreeWayRow) and the sync switch in Settings
// (routes/settings/SyncChats.tsx): a card on the page, never a pop-up, and honest about which computers have the app.
import { buttons, click, container, settle } from "../lib/dom.test-support.ts";
import type { CloudStatus } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { syncSwitch, SyncChatsSettings } from "../routes/settings/SyncChats.tsx";
import {
  RuntimeFixture,
  type RuntimeContextValue,
  type WebWindowValue,
} from "../state/runtime.tsx";
import { DOWNLOAD_URL, MAC_ONLY_LINE, type MacHere } from "../state/sync/web-window.ts";
import { FreeWayRow } from "./UnlockPlans.tsx";
import { WebStartCard } from "./WebStartCard.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const links = (root: ParentNode) => [...root.querySelectorAll("a")];
const text = (root: ParentNode) => (root.textContent ?? "").replace(/\s+/g, " ");

async function render(node: ReturnType<typeof createElement>) {
  const host = container();
  const root = createRoot(host);
  await act(async () => root.render(node));
  await settle();
  return { host, unmount: () => act(async () => root.unmount()) };
}

const runtime = (client: unknown) =>
  ({
    status: "connected",
    client,
    connection: 1,
    settings: null,
    engines: [],
    workspaces: [],
    projects: [],
    raw: new Map(),
    refresh: async () => undefined,
  }) as unknown as RuntimeContextValue;

const web = (nothingYet: boolean, mac: MacHere): WebWindowValue =>
  ({
    window: { kind: "app", failed: false, nothingYet },
    places: { places: [], cloud: "on", lines: [] },
    home: null,
    mac,
    usePlace: () => undefined,
  }) as unknown as WebWindowValue;

test("a first visit with no Mac: the card is on the page with the free download and the quiet sync line, and no dialog", async () => {
  // Cloud's account cannot be read here: the card stands on what the window knows.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh", maxTouchPoints: 0 });
  const view = await render(
    createElement(RuntimeFixture, {
      value: runtime({ call: () => new Promise(() => undefined), on: () => () => undefined }),
      children: createElement(WebStartCard, { web: web(true, { kind: "none" }) }),
    }),
  );
  const said = text(view.host);
  expect(said).toContain("Ways to start");
  expect(said).toContain("Run it free on your computer");
  expect(said).toContain("Run it in Cloud");
  expect(said).toContain("Turn on sync on your Mac to see your chats here");
  expect(
    links(view.host)
      .find((a) => a.textContent?.trim() === "Download for Mac")
      ?.getAttribute("href"),
  ).toBe(DOWNLOAD_URL);
  // A card, not a pop-up.
  expect(document.querySelector("[role='dialog']")).toBeNull();
  await view.unmount();
});

test("the card is on a computer that is not a Mac too: it says Mac only today and offers no download", async () => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows NT 10.0" });
  const view = await render(
    createElement(RuntimeFixture, {
      value: runtime({ call: () => new Promise(() => undefined), on: () => () => undefined }),
      children: createElement(WebStartCard, { web: web(true, { kind: "none" }) }),
    }),
  );
  expect(text(view.host)).toContain(MAC_ONLY_LINE);
  expect(links(view.host)).toEqual([]);
  expect(buttons(view.host, "Download for Mac")).toEqual([]);
  await view.unmount();
});

test("no card, and no line about sync, once the window has a chat or a Mac on line", async () => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  for (const mac of [{ kind: "none" }, { kind: "ready", name: "Studio" }] as const) {
    const view = await render(
      createElement(RuntimeFixture, {
        value: runtime({ call: () => new Promise(() => undefined), on: () => () => undefined }),
        children: createElement(WebStartCard, { web: web(mac.kind !== "none", mac) }),
      }),
    );
    expect(text(view.host)).toBe("");
    await view.unmount();
  }
  // The desktop app has no web window: nothing at all.
  const desktop = await render(
    createElement(RuntimeFixture, {
      value: runtime({ call: () => new Promise(() => undefined), on: () => () => undefined }),
      children: createElement(WebStartCard, { web: null }),
    }),
  );
  expect(text(desktop.host)).toBe("");
  await desktop.unmount();
});

test("the free way beside the plans: a download on a Mac, the plain line elsewhere", async () => {
  const mac = await render(createElement(FreeWayRow, { canMac: true }));
  expect(text(mac.host)).toContain("Run it free on your computer");
  expect(links(mac.host)[0]?.getAttribute("href")).toBe(DOWNLOAD_URL);
  expect(links(mac.host)[0]?.textContent?.trim()).toBe("Download for Mac");
  await mac.unmount();
  const other = await render(createElement(FreeWayRow, { canMac: false }));
  expect(text(other.host)).toContain("Run it free on your computer");
  expect(text(other.host)).toContain(MAC_ONLY_LINE);
  expect(links(other.host)).toEqual([]);
  await other.unmount();
});

const status = (sync: CloudStatus["sync"]) =>
  ({ state: "connected", ...(sync ? { sync } : {}) }) as CloudStatus;

test("the sync switch: shown only where Caveman offers sync, off until turned on", () => {
  expect(syncSwitch(null)).toBeNull();
  expect(syncSwitch(status(undefined))).toBeNull();
  expect(syncSwitch(status({ available: false, on: false }))).toBeNull();
  expect(syncSwitch(status({ available: true, on: false, ask: true }))).toEqual({ on: false });
  expect(syncSwitch(status({ available: true, on: true }))).toEqual({ on: true });
});

test("turning the switch on writes sync and remote control together, as the prompt's Turn on sync does", async () => {
  // Radix's switch asks whether it sits in a form; the test browser (linkedom) has no such class.
  vi.stubGlobal("HTMLFormElement", class {});
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(
        method === "cloud.status" ? status({ available: true, on: false }) : {},
      );
    },
    on: () => () => undefined,
  };
  const view = await render(
    createElement(RuntimeFixture, {
      value: runtime(client),
      children: createElement(SyncChatsSettings),
    }),
  );
  expect(text(view.host)).toContain("Sync chats");
  const toggle = view.host.querySelector("[role='switch']");
  expect(toggle?.getAttribute("aria-checked")).toBe("false");
  await click(toggle);
  expect(calls.find((c) => c.method === "settings.set")?.params).toMatchObject({
    settings: { sync_chats: true, remote_control: true },
  });
  await view.unmount();
  // Signed out, or a Cloud that keeps no copy: no row to switch.
  const none = await render(
    createElement(RuntimeFixture, {
      value: runtime({ call: () => Promise.resolve(status(undefined)), on: () => () => undefined }),
      children: createElement(SyncChatsSettings),
    }),
  );
  expect(text(none.host)).toBe("");
  await none.unmount();
});
