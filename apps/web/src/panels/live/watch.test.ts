import type { Client } from "@caveman-app/session-protocol/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { watchAgentBrowser } from "../browser/watch.ts";
import { activateTab, getPanel, resetPanels, setPanelOpen, setTabIdentity } from "../store.ts";
import { closeFloatingScreen, getFloatingScreen, isInUse, LIVE_MS, resetFloatingScreens } from "./float.ts";
import { watchComputer } from "./watch.ts";

/** A client that only delivers notifications; `emit` plays the runtime. */
function fakeClient() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const client = {
    on: (name: string, h: (p: unknown) => void) => {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(h);
      return () => set.delete(h);
    },
  } as unknown as Client;
  const emit = (name: string, params: object) => handlers.get(name)?.forEach((h) => h(params));
  const listening = () => [...handlers.values()].reduce((n, s) => n + s.size, 0);
  return { client, emit, listening };
}

beforeEach(() => {
  resetPanels();
  resetFloatingScreens();
  setTabIdentity("browser", (p) => (p.backend === "agent" ? "agent" : "page"));
  setTabIdentity("computer", "one");
});
afterEach(() => {
  vi.useRealTimers();
});

test("the agent's first browser activity opens its tab once, quietly; other workspaces don't count", () => {
  const { client, emit, listening } = fakeClient();
  const stop = watchAgentBrowser({ client, workspaceId: "w1" });
  emit("browser.pointer", { workspace_id: "w2", x: 1, y: 1, phase: "move", seq: 1 });
  expect(getPanel("w1").tabs).toEqual([]);
  emit("browser.pointer", { workspace_id: "w1", x: 1, y: 1, phase: "move", seq: 2 });
  emit("browser.state", { workspace_id: "w1", url: "http://localhost:3000/", title: "App", loading: false, can_go_back: false, can_go_forward: false, controller: "agent" });
  const panel = getPanel("w1");
  expect(panel.open).toBe(false);
  expect(panel.tabs).toMatchObject([{ id: "browser:agent", kind: "browser", params: { backend: "agent" }, attention: true, reveal: 0 }]);
  stop();
  expect(listening()).toBe(0);
});

test("the computer's first frame or state opens the Computer tab once", () => {
  const { client, emit, listening } = fakeClient();
  const stop = watchComputer({ client, workspaceId: "w1" });
  emit("computer.state", { workspace_id: "w1", controller: "agent", width: 1280, height: 800 });
  emit("computer.frame", { workspace_id: "w1", mime_type: "image/jpeg", data: "", width: 1280, height: 800 });
  expect(getPanel("w1").tabs).toMatchObject([{ id: "computer", attention: true, reveal: 0 }]);
  stop();
  expect(listening()).toBe(0);
});

const PAGE = { workspace_id: "w1", url: "http://localhost:3000/", title: "App", loading: false, can_go_back: false, can_go_forward: false, controller: "agent" } as const;
const SCREEN = { workspace_id: "w1", controller: "agent", width: 1280, height: 800 } as const;

test("the agent showing a page floats its browser over the chat; closing lasts until it shows one again", () => {
  const { client, emit } = fakeClient();
  const stop = watchAgentBrowser({ client, workspaceId: "w1" });
  // A navigation a watching window hears floats nothing; the agent's preview_open (reveal) does, in its own chat only.
  emit("browser.state", PAGE);
  expect(getFloatingScreen("w1")).toBeNull();
  emit("browser.state", { ...PAGE, reveal: true });
  expect(getFloatingScreen("w1")).toBe("browser");
  expect(getFloatingScreen("w2")).toBeNull();
  closeFloatingScreen("w1");
  emit("browser.state", { ...PAGE, title: "Next" });
  expect(getFloatingScreen("w1")).toBeNull();
  emit("browser.state", { ...PAGE, reveal: true });
  expect(getFloatingScreen("w1")).toBe("browser");
  stop();
});

test("a screen the side panel is showing doesn't float; with the panel closed it does", () => {
  const { client, emit } = fakeClient();
  const stop = watchComputer({ client, workspaceId: "w1" });
  emit("computer.state", SCREEN);
  activateTab("w1", "computer");
  emit("computer.state", { ...SCREEN, reveal: true });
  expect(getFloatingScreen("w1")).toBeNull();
  setPanelOpen("w1", false);
  // Watched in the side panel, it is put away: using it floats nothing; asking to show it again does.
  emit("computer.state", { ...SCREEN, active: true });
  expect(getFloatingScreen("w1")).toBeNull();
  expect(isInUse("w1", "computer")).toBe(true);
  emit("computer.state", { ...SCREEN, reveal: true });
  expect(getFloatingScreen("w1")).toBe("computer");
  stop();
});

test("the agent using its browser floats it without asking; closing lasts until it asks to show a page", () => {
  const { client, emit } = fakeClient();
  const stop = watchAgentBrowser({ client, workspaceId: "w1" });
  emit("browser.state", { ...PAGE, active: true });
  expect(getFloatingScreen("w1")).toBe("browser");
  expect(isInUse("w1", "browser")).toBe(true);
  expect(isInUse("w2", "browser")).toBe(false);
  closeFloatingScreen("w1");
  emit("browser.state", { ...PAGE, active: true });
  expect(getFloatingScreen("w1")).toBeNull();
  // Still in use: the tab and the header's button say so.
  expect(isInUse("w1", "browser")).toBe(true);
  emit("browser.state", { ...PAGE, reveal: true });
  expect(getFloatingScreen("w1")).toBe("browser");
  stop();
});

test("in use lapses a while after the agent's last use, and at once when its turn ends", () => {
  vi.useFakeTimers();
  const { client, emit } = fakeClient();
  const stop = watchAgentBrowser({ client, workspaceId: "w1" });
  emit("browser.state", { ...PAGE, active: true });
  vi.advanceTimersByTime(LIVE_MS - 1000);
  emit("browser.state", { ...PAGE, active: true });
  vi.advanceTimersByTime(LIVE_MS - 1000);
  expect(isInUse("w1", "browser")).toBe(true);
  vi.advanceTimersByTime(1000);
  expect(isInUse("w1", "browser")).toBe(false);
  emit("browser.state", { ...PAGE, active: true });
  emit("workspace.changed", { id: "w2", status: "idle" });
  expect(isInUse("w1", "browser")).toBe(true);
  emit("workspace.changed", { id: "w1", status: "idle" });
  expect(isInUse("w1", "browser")).toBe(false);
  stop();
});

test("using one screen doesn't take the float from the other; asking to show it does", () => {
  const browser = fakeClient();
  const computer = fakeClient();
  const stops = [watchAgentBrowser({ client: browser.client, workspaceId: "w1" }), watchComputer({ client: computer.client, workspaceId: "w1" })];
  browser.emit("browser.state", { ...PAGE, reveal: true });
  computer.emit("computer.state", { ...SCREEN, active: true });
  expect(getFloatingScreen("w1")).toBe("browser");
  expect(isInUse("w1", "computer")).toBe(true);
  computer.emit("computer.state", { ...SCREEN, active: true, reveal: true });
  expect(getFloatingScreen("w1")).toBe("computer");
  stops.forEach((stop) => stop());
});
