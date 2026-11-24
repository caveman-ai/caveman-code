// The agent's screens on the phone speak Session Protocol's browser.* and computer.* ("make sure
// this works very properly w the whole agent-browser and computer setup"): the script's sources must say what a
// runtime would (state with controller and active, pointer moves and clicks while watched), refuse input until the
// person takes the screen, hand it back, and let go of it when the turn ends; a Cloud computer streams its desktop and
// a Mac the app its agent used (agent-desktop), whose Take over pauses the agent but takes no input from the phone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/persist", () => ({
  KEYS: { board: "board", inbox: "inbox", sessions: "sessions", boot: "boot" },
  read: () => null,
  write: () => {},
  flush: () => {},
  remove: () => {},
  clearPersisted: () => {},
  onLeave: () => () => {},
  FRESH: false,
}));

import { resetStore, store } from "../store/store";
import { THEME } from "./pages";
import type { DrawnFrame, LivePointer } from "./protocol";
import { screensOf, sourceFor, takesInput } from "./scripted";

const chat = (id: string) => store.get().board.chats.find((c) => c.id === id)!;
const tap = (x: number, y: number) =>
  [
    { type: "pointer", action: "down", x, y, button: "left", modifiers: 0 },
    { type: "pointer", action: "up", x, y, button: "left", modifiers: 0 },
  ] as const;
const themeAt = { x: THEME.x + THEME.w / 2, y: THEME.y + THEME.h / 2 };

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});
afterEach(() => vi.useRealTimers());

describe("the agent's screens, as a runtime would report them", () => {
  it("reads a chat's browser as browser.state, in use while the agent works in it", () => {
    expect(sourceFor("dark-runs", "browser").state).toMatchObject({ workspace_id: "dark-runs", url: "http://localhost:5173/runs", controller: "agent", active: true });
    expect(screensOf(chat("dark-runs"))).toEqual([{ screen: "browser", live: true }]);
  });

  it("moves and clicks the agent's cursor while someone watches, and the page changes under it", async () => {
    const source = sourceFor("dark-runs", "browser");
    const pointers: LivePointer[] = [];
    const frames: DrawnFrame[] = [];
    const offs = [source.onPointer((p) => pointers.push(p)), source.onFrame((f) => frames.push(f as DrawnFrame))];
    const holder = {};
    expect(await source.start(holder, 10)).toBe("live");
    const before = (source.frame as DrawnFrame).page.dark;
    vi.advanceTimersByTime(3000);
    expect(pointers.map((p) => p.phase)).toEqual(["move", "move", "click"]);
    expect(pointers.map((p) => p.seq)).toEqual([...pointers.map((p) => p.seq)].sort((a, b) => a - b));
    expect(frames.at(-1)!.page.dark).toBe(!before);
    source.stop(holder);
    offs.forEach((off) => off());
  });

  it("refuses your input until you take the screen, then the agent waits and your tap lands", async () => {
    const source = sourceFor("dark-runs", "browser");
    const holder = {};
    await source.start(holder, 30);
    const before = (source.frame as DrawnFrame).page.dark;
    source.input(...tap(themeAt.x, themeAt.y));
    expect((source.frame as DrawnFrame).page.dark).toBe(before);

    expect(await source.control("user")).toBe("user");
    expect(source.state?.controller).toBe("user");
    const pointers: LivePointer[] = [];
    const off = source.onPointer((p) => pointers.push(p));
    vi.advanceTimersByTime(5000);
    expect(pointers).toEqual([]);
    source.input(...tap(themeAt.x, themeAt.y));
    expect((source.frame as DrawnFrame).page.dark).toBe(!before);

    expect(await source.control("agent")).toBe("agent");
    off();
    source.stop(holder);
  });

  it("lets go when the turn ends: nobody drives, and the screen stays to look at", () => {
    const source = sourceFor("dark-runs", "browser");
    const off = source.onState(() => {});
    store.dispatch({ type: "update", id: "dark-runs", patch: { phase: "ready" } });
    expect(chat("dark-runs").using).toBeUndefined();
    expect(source.state).toMatchObject({ controller: "none" });
    expect(source.state).not.toHaveProperty("active");
    expect(screensOf(chat("dark-runs"))).toEqual([{ screen: "browser", live: false }]);
    off();
  });

  it("shows a Mac's computer as the app the agent used, which Take over pauses but the phone can't drive", async () => {
    const mac = sourceFor("push", "computer");
    const holder = {};
    expect(await mac.start(holder, 10)).toBe("live");
    expect(mac.state).toMatchObject({ controller: "none", app: { name: "Simulator" } });
    expect(takesInput(chat("push"), "computer")).toBe(false);
    expect(await mac.control("user")).toBe("user");
    const before = mac.frame;
    mac.input(...tap(200, 214));
    expect(mac.frame).toBe(before);
    await mac.control("agent");
    mac.stop(holder);
  });

  it("has no computer before the agent uses one, and lists the screen in use first", async () => {
    expect(await sourceFor("dark-runs", "computer").start({}, 10)).toBe("unavailable");
    expect(takesInput(chat("onboarding"), "computer")).toBe(true);
    const desktop = sourceFor("onboarding", "computer");
    const holder = {};
    expect(await desktop.start(holder, 10)).toBe("live");
    expect(desktop.state).toMatchObject({ width: 960, height: 600, controller: "agent", active: true });
    desktop.stop(holder);
    expect(screensOf(chat("onboarding"))).toEqual([
      { screen: "computer", live: true },
      { screen: "browser", live: false },
    ]);
  });
});
