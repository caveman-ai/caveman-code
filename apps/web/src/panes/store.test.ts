import { afterEach, describe, expect, test, vi } from "vitest";
import { EMPTY, findPane, insert, leaves, newPane, newTabPane, paneOf, show as showIn } from "./tree.ts";

type Store = typeof import("./store.ts");

/** A fresh store over a window whose localStorage holds `stored`, opened on `hash`; `desktop`: the desktop app's window. */
async function load(stored: Record<string, unknown> = {}, hash = "", name = "caveman-test", desktop = false): Promise<Store> {
  vi.resetModules();
  mem = new Map(Object.entries(stored).map(([k, v]) => [k, JSON.stringify(v)]));
  vi.stubGlobal("window", { name, addEventListener: (type: string, fn: () => void) => void (type === "pagehide" && (leave = fn)), ...(desktop ? { cavemanDesktop: {} } : {}) });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  });
  vi.stubGlobal("location", { hash });
  vi.stubGlobal("document", { querySelector: () => null });
  return import("./store.ts");
}

/** The stubbed localStorage of the last `load`, and the window's pagehide listener (the window closing). */
let mem = new Map<string, string>();
let leave: () => void = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Opening a chat as the sidebar does: into the tab in front, then the route goes there. */
const show = (s: Store, workspaceId: string) => {
  s.panes.show(workspaceId);
  s.windowTabs.follow(s.chatPath(workspaceId));
};
const paths = (s: Store) => s.windowTabs.get().list.map((t) => t.path);
const front = (s: Store) => s.windowTabs.get().list.find((t) => t.id === s.windowTabs.get().active)!;

test("a chat lives in one tab: opening it from anywhere brings that tab to the front, on its pane", async () => {
  const s = await load();
  show(s, "a");
  expect(s.windowTabs.openNewChat()).toBe("/new");
  expect(front(s).path).toBe("/new");
  s.panes.show("a");
  expect(front(s).id).toBe("t1");
  expect(front(s).path).toBe("/w/a");
  // The route landing on it does the same (a link, ⌘K, a notice).
  s.windowTabs.activateAt(2);
  s.windowTabs.follow("/w/a");
  expect(front(s).id).toBe("t1");
  // ⌘-click on an open chat goes to it, never a second copy.
  expect(s.windowTabs.openChat("a")).toBe("/w/a");
  expect(s.windowTabs.get().list).toHaveLength(2);
});

test("a New chat started over a full split opens in a tab of its own; the split stays as it was", async () => {
  const s = await load();
  show(s, "a");
  const one = s.panes.get();
  s.panes.set(insert(one, one.focused!, "right", newPane(one, "b")));
  const split = s.panes.get();
  s.windowTabs.follow("/new");
  s.panes.place("n");
  s.windowTabs.follow("/w/n");
  expect(paths(s)).toEqual(["/w/b", "/w/n"]);
  expect(front(s).id).toBe("t2");
  expect(s.windowTabs.get().list[0]!.layout).toBe(split);
});

test("⌘1..⌘8 go to that place, ⌘9 to the last; a place with no tab stays put; stepping wraps", async () => {
  const s = await load();
  show(s, "a");
  s.windowTabs.openChat("b");
  s.windowTabs.openChat("c");
  expect(s.windowTabs.activateAt(1)).toBe("/w/a");
  expect(s.windowTabs.activateAt(9)).toBe("/w/c");
  expect(s.windowTabs.activateAt(7)).toBeNull();
  expect(s.windowTabs.step(1)).toBe("/w/a");
  expect(s.windowTabs.step(-1)).toBe("/w/c");
});

test("New tab brings back a New chat tab nobody used rather than opening a second", async () => {
  const s = await load();
  s.windowTabs.openNewChat();
  s.windowTabs.activateAt(1);
  s.windowTabs.openNewChat();
  expect(paths(s)).toEqual(["/chief", "/new"]);
  expect(front(s).path).toBe("/new");
});

test("closing the tab in front brings its right neighbour, else the left; the last never closes; ⌘⇧T puts it back", async () => {
  const s = await load();
  show(s, "a");
  s.windowTabs.openChat("b");
  s.windowTabs.openChat("c");
  s.windowTabs.activateAt(2);
  expect(s.windowTabs.close((t) => t.id === front(s).id)).toBe("/w/c");
  expect(s.windowTabs.close((t) => t.id === front(s).id)).toBe("/w/a");
  expect(s.windowTabs.close(() => true)).toBeNull();
  expect(paths(s)).toEqual(["/w/a"]);
  expect(s.windowTabs.reopen()).toBe("/w/c");
  expect(s.windowTabs.reopen()).toBe("/w/b");
  expect(paths(s)).toEqual(["/w/a", "/w/b", "/w/c"]);
  // A chat opened elsewhere while its tab was closed stays where it is now.
  s.windowTabs.close((t) => t.path === "/w/c");
  s.windowTabs.activateAt(1);
  show(s, "c");
  expect(s.windowTabs.reopen()).toBe("/new");
  expect(s.windowTabs.get().list.filter((t) => paneOf(t.layout, "c"))).toHaveLength(1);
});

test("dropping a chat open in another tab moves it here; a tab it was all of closes", async () => {
  const s = await load();
  show(s, "a");
  s.windowTabs.openChat("b");
  const target = paneOf(s.panes.get(), "b")!;
  s.panes.drop("a", null, target.id, "right");
  expect(s.windowTabs.get().list).toHaveLength(1);
  expect(leaves(s.panes.get().root).map((p) => p.workspaceId)).toEqual(["b", "a"]);
});

test("a pane dragged onto the strip leaves its split for a tab of its own", async () => {
  const s = await load();
  show(s, "a");
  s.panes.drop("b", null, paneOf(s.panes.get(), "a")!.id, "right");
  expect(s.windowTabs.splitOff(paneOf(s.panes.get(), "b")!.id)).toBe("/w/b");
  expect(s.windowTabs.get().list.map((t) => leaves(t.layout.root).map((p) => p.workspaceId))).toEqual([["a"], ["b"]]);
  // A lone pane is already a tab of its own.
  expect(s.windowTabs.splitOff(paneOf(s.panes.get(), "b")!.id)).toBeNull();
});

test("the route on screen is the tab in front's; Settings never becomes one", async () => {
  const s = await load();
  s.windowTabs.follow("/automations");
  s.windowTabs.follow("/settings/keyboard");
  s.windowTabs.follow("/");
  expect(front(s).path).toBe("/automations");
});

test("stored tabs come back; damaged ones drop out and a chat stored in two tabs keeps the first", async () => {
  const pane = (id: string, workspaceId: string) => ({ kind: "pane", id, workspaceId });
  const s = await load({
    "caveman.tabs.test": {
      tabs: [
        { id: "t1", path: "/w/a", layout: { root: pane("p1", "a"), focused: "p1" } },
        { id: "bad", path: "/w/x", layout: null },
        { id: "t3", path: "/settings/general", layout: null },
        { id: "t4", path: "/w/a", layout: { root: { kind: "split", id: "s1", dir: "row", children: [pane("p1", "a"), pane("p2", "b")], sizes: [0.5, 0.5] }, focused: "p1" } },
      ],
      active: "t4",
    },
  });
  expect(s.windowTabs.get().list.map((t) => t.id)).toEqual(["t1", "t4"]);
  // t4 lost "a" to t1, so it shows the chat it still holds.
  expect(front(s).path).toBe("/w/b");
  expect(leaves(front(s).layout.root).map((p) => p.workspaceId)).toEqual(["b"]);
});

test("a window from before tabs keeps its split as its first tab; a launch on no route comes back on the tab in front", async () => {
  const legacy = { root: { kind: "pane", id: "p1", workspaceId: "a" }, focused: "p1" };
  const s = await load({ "caveman.panes.test": legacy });
  expect(paths(s)).toEqual(["/w/a"]);
  expect(s.windowTabs.launchPath()).toBe("/w/a");
  const linked = await load({ "caveman.panes.test": legacy }, "#/automations");
  expect(linked.windowTabs.launchPath()).toBeNull();
});

test("a new window takes over the tabs of the window closed last, and a month-old one is let go", async () => {
  const first = await load({}, "", "caveman-one");
  show(first, "a");
  first.windowTabs.openChat("b");
  await Promise.resolve();
  leave();
  const stored = Object.fromEntries([...mem].map(([k, v]) => [k, JSON.parse(v)]));
  const old = { tabs: [{ id: "t1", path: "/w/z", layout: null }], active: "t1", closedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 };
  const next = await load({ ...stored, "caveman.tabs.old": old }, "", "");
  expect(paths(next)).toEqual(["/w/a", "/w/b"]);
  await Promise.resolve();
  expect(mem.has("caveman.tabs.old")).toBe(false);
  // Taken over: no longer marked, so another new window starts fresh.
  expect(JSON.parse(mem.get("caveman.tabs.one")!).closedAt).toBeUndefined();
});

test("the desktop app's next launch takes over the tabs of a window that ended without pagehide (a shutdown, a force quit, a crash)", async () => {
  const first = await load({}, "", "caveman-one", true);
  show(first, "a");
  first.windowTabs.openChat("b");
  await Promise.resolve();
  // The process ends: pagehide never runs, so nothing marks the tabs closed.
  const stored = Object.fromEntries([...mem].map(([k, v]) => [k, JSON.parse(v)]));
  const next = await load(stored, "", "", true);
  expect(paths(next)).toEqual(["/w/a", "/w/b"]);
  // A browser's new tab leaves them: the tab that wrote them may still be open.
  const tab = await load(stored, "", "");
  expect(paths(tab)).toEqual(["/chief"]);
});

test("the tabs of windows that ended without pagehide are let go after a month, as closed ones are", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let stored: Record<string, unknown> = {};
  for (let i = 0; i < 3; i++) {
    const s = await load(stored, "", "");
    show(s, `c${i}`);
    await Promise.resolve();
    stored = Object.fromEntries([...mem].map(([k, v]) => [k, JSON.parse(v)]));
    vi.setSystemTime(Date.now() + 40 * 24 * 60 * 60 * 1000);
  }
  await load(stored, "", "");
  await Promise.resolve();
  expect([...mem.keys()].filter((k) => k.startsWith("caveman.tabs."))).toHaveLength(1);
});

test("a browser tab left open for a month without a change keeps its tabs when another tab opens", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval"] });
  const open = await load({}, "", "caveman-open");
  show(open, "a");
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(40 * 24 * 60 * 60 * 1000);
  // Another tab opens on the same localStorage: it lets go only of windows that are gone.
  await load(Object.fromEntries([...mem].map(([k, v]) => [k, JSON.parse(v)])), "", "");
  await Promise.resolve();
  expect(mem.get("caveman.tabs.open"), "the open tab's tabs").toBeDefined();
  expect(JSON.parse(mem.get("caveman.tabs.open")!).tabs.map((t: { path: string }) => t.path)).toEqual(["/w/a"]);
});

test("tabs saved before windows recorded when they saved stay in a browser, whose tab may be open, and go in the desktop app", async () => {
  const older = { "caveman.tabs.older": { tabs: [{ id: "t1", path: "/w/z", layout: null }], active: "t1", closed: [] } };
  const tab = await load(older, "", "");
  await Promise.resolve();
  expect(paths(tab)).toEqual(["/chief"]);
  expect(mem.has("caveman.tabs.older")).toBe(true);
  const app = await load(older, "", "", true);
  await Promise.resolve();
  expect(paths(app)).toEqual(["/chief"]);
  expect(mem.has("caveman.tabs.older")).toBe(false);
});

test("closing a tab's last pane closes the tab as it was: ⌘⇧T brings the chat back, after a reload too", async () => {
  const s = await load();
  show(s, "a");
  s.windowTabs.openChat("b");
  const pane = s.panes.get().focused!;
  expect(s.panes.close(pane)).toBe("/w/a");
  expect(paths(s)).toEqual(["/w/a"]);
  await Promise.resolve();
  const reloaded = await load(Object.fromEntries([...mem].map(([k, v]) => [k, JSON.parse(v)])));
  expect(reloaded.windowTabs.reopen()).toBe("/w/b");
  expect(paths(reloaded)).toEqual(["/w/a", "/w/b"]);
});

test("opening a chat from the sidebar never replaces one in a full split; an empty pane takes it", async () => {
  const s = await load();
  show(s, "a");
  const one = s.panes.get();
  s.panes.set(insert(one, one.focused!, "right", newPane(one, null)));
  show(s, "b");
  expect(leaves(s.panes.get().root).map((p) => p.workspaceId)).toEqual(["a", "b"]);
  show(s, "c");
  expect(paths(s)).toEqual(["/w/b", "/w/c"]);
  expect(leaves(s.windowTabs.get().list[0]!.layout.root).map((p) => p.workspaceId)).toEqual(["a", "b"]);
});

/** t1 in front: [p1: a, p2: empty] (⌘D's pane, its New chat box); t2 behind: [p1: x, p2: y]. Pane ids repeat across tabs. */
async function emptyPaneBesideAnotherSplit() {
  const s = await load();
  show(s, "a");
  const one = s.panes.get();
  s.panes.set(insert(one, one.focused!, "right", newPane(one, null)));
  const x = showIn(EMPTY, "x");
  s.windowTabs.open("/w/x", insert(x, "p1", "right", newPane(x, "y")));
  s.windowTabs.activate("t1");
  return s;
}
const chatsIn = (s: Store, id: string) => leaves(s.windowTabs.get().list.find((t) => t.id === id)!.layout.root).map((p) => [p.id, p.workspaceId]);

test("a chat sent from an empty pane lands in that pane, even when the person went to another tab while it was made", async () => {
  const s = await emptyPaneBesideAnotherSplit();
  // New chat in t1's p2 sends (and notes its tab); while workspace.create runs the person presses ⌘2.
  const tab = s.windowTabs.get().active;
  s.windowTabs.activateAt(2);
  const landed = s.panes.fill("p2", "fresh", tab);
  // t2's chats stay on screen, and t2 stays in front.
  expect(chatsIn(s, "t2")).toEqual([["p1", "x"], ["p2", "y"]]);
  expect(front(s).id).toBe("t2");
  // Back in t1, the new chat is in the pane it was typed in, focused.
  expect(chatsIn(s, "t1")).toEqual([["p1", "a"], ["p2", "fresh"]]);
  expect(landed).toBe(true);
  expect(s.windowTabs.activate("t1")).toBe("/w/fresh");
  expect(s.panes.get().focused).toBe("p2");
});

test("a chat whose empty pane closed while it was made is not put anywhere by the pane, and no tab focuses a pane that is gone", async () => {
  const s = await emptyPaneBesideAnotherSplit();
  const tab = s.windowTabs.get().active;
  s.panes.close("p2");
  const landed = s.panes.fill("p2", "fresh", tab);
  for (const t of s.windowTabs.get().list) expect(findPane(t.layout, t.layout.focused), `${t.id} focuses ${t.layout.focused}`).not.toBeNull();
  expect(chatsIn(s, "t1")).toEqual([["p1", "a"]]);
  // The caller opens it as any new chat (New chat's route): the pane answers that it took nothing.
  expect(landed).toBe(false);
  // A pane filled with another chat meanwhile keeps it.
  const again = await emptyPaneBesideAnotherSplit();
  again.panes.fill("p2", "picked");
  again.panes.fill("p2", "fresh", "t1");
  expect(chatsIn(again, "t1")).toEqual([["p1", "a"], ["p2", "picked"]]);
});

test("the note's showing chat is the last chat on screen behind the tab in front, never the tab in front itself", async () => {
  const s = await load();
  // Nothing opened yet: no chat was on screen.
  expect(s.recentChat(s.windowTabs.get())).toBeNull();
  // A chat, then the Chief page in front: the chat is what was on screen behind it.
  s.windowTabs.openChat("ws-9");
  s.windowTabs.open("/chief");
  expect(s.windowTabs.get().active).not.toBe(s.windowTabs.get().recent[1]);
  expect(s.recentChat(s.windowTabs.get())).toBe("ws-9");
  // The chat itself in front, with only pages behind it: nothing to attach (never the tab in front).
  s.windowTabs.activate(s.windowTabs.get().list.find((t) => t.path === "/w/ws-9")!.id);
  expect(s.recentChat(s.windowTabs.get())).toBeNull();
  // A newer chat in front over the Chief: the newer one is what was on screen.
  s.windowTabs.openChat("ws-42");
  s.windowTabs.open("/chief");
  expect(s.recentChat(s.windowTabs.get())).toBe("ws-42");
});

describe("side-panel tabs in the split view", () => {
  /** The store and the side panels it hosts tabs for (the same module instance as the store's). */
  async function loadBoth(stored: Record<string, unknown> = {}) {
    const s = await load(stored);
    const panels = await import("../panels/store.ts");
    vi.stubGlobal("location", { hash: "", replace: vi.fn() });
    return { s, panels };
  }
  const shows = (s: Store) => leaves(s.panes.get().root).map((p) => p.workspaceId ?? `tab:${p.tab?.id}`);

  test("a tab dropped on a pane gets one of its own beside it, out of its panel's strip; the pane closing puts it back", async () => {
    const { s, panels } = await loadBoth();
    show(s, "a");
    const term = panels.openSurface("a", "terminal", {});
    const other = panels.openSurface("a", "terminal", {});
    panels.activateTab("a", term);
    s.panes.dropTab({ workspaceId: "a", id: term }, null, paneOf(s.panes.get(), "a")!.id, "bottom");
    expect(shows(s)).toEqual(["a", `tab:${term}`]);
    expect(panels.getPanel("a").tabs.map((t) => t.id)).toEqual([other]);
    expect(panels.getPanel("a").active).toBe(other);
    // Closing the pane (not the tab) only puts it back: nothing it owns ends.
    s.panes.close(leaves(s.panes.get().root).find((p) => p.tab)!.id);
    expect(panels.getPanel("a").tabs.map((t) => t.id)).toEqual([term, other]);
  });

  test("Back to the side panel shows it in front there; its chat's pane stays", async () => {
    const { s, panels } = await loadBoth();
    show(s, "a");
    const term = panels.openSurface("a", "terminal", {});
    s.panes.dropTab({ workspaceId: "a", id: term }, null, paneOf(s.panes.get(), "a")!.id, "right");
    expect(panels.getPanel("a").open).toBe(false);
    expect(s.panes.dock(leaves(s.panes.get().root).find((p) => p.tab)!.id)).toBeNull();
    expect(shows(s)).toEqual(["a"]);
    expect(panels.getPanel("a")).toMatchObject({ open: true, active: term });
  });

  test("a tab of its own lives at /panes; closing that tab puts it back, and ⌘⇧T takes it out again", async () => {
    const { s, panels } = await loadBoth();
    show(s, "a");
    const pr = panels.openSurface("a", "file", { path: "pr.md" });
    expect(s.windowTabs.openTab({ workspaceId: "a", id: pr })).toBe("/panes");
    expect(front(s).path).toBe("/panes");
    expect(panels.getPanel("a")).toMatchObject({ open: false, tabs: [] });
    s.windowTabs.close((t) => t.id === front(s).id);
    expect(panels.getPanel("a").tabs.map((t) => t.id)).toEqual([pr]);
    // Quietly: the panel doesn't open by itself.
    expect(panels.getPanel("a").open).toBe(false);
    expect(s.windowTabs.reopen()).toBe("/panes");
    expect(panels.getPanel("a").tabs).toEqual([]);
  });

  test("a tab shown in a tab behind moves to the one in front when dropped there; the tab it was all of closes", async () => {
    const { s, panels } = await loadBoth();
    show(s, "a");
    const pr = panels.openSurface("a", "file", { path: "pr.md" });
    s.windowTabs.openTab({ workspaceId: "a", id: pr });
    s.windowTabs.activateAt(1);
    s.panes.dropTab({ workspaceId: "a", id: pr }, null, paneOf(s.panes.get(), "a")!.id, "right");
    expect(paths(s)).toEqual(["/w/a"]);
    expect(shows(s)).toEqual(["a", `tab:${pr}`]);
  });

  test("a chat dropped on a tab's pane takes a pane of its own there; the tab goes back to its panel", async () => {
    const { s, panels } = await loadBoth();
    show(s, "a");
    const pr = panels.openSurface("a", "file", { path: "pr.md" });
    s.windowTabs.openTab({ workspaceId: "a", id: pr });
    const target = leaves(s.panes.get().root)[0]!;
    s.panes.drop("b", null, target.id, "center");
    expect(shows(s)).toEqual(["b"]);
    expect(panels.getPanel("a").tabs.map((t) => t.id)).toEqual([pr]);
  });

  test("Open in split view goes beside its chat; asked again, its pane comes forward", async () => {
    const { s, panels } = await loadBoth();
    show(s, "a");
    const t = panels.openSurface("a", "terminal", {});
    expect(s.panes.hostTab({ workspaceId: "a", id: t })).toBeNull();
    expect(shows(s)).toEqual(["a", `tab:${t}`]);
    s.panes.focus(paneOf(s.panes.get(), "a")!.id);
    expect(s.panes.hostTab({ workspaceId: "a", id: t })).toBeNull();
    expect(s.panes.get().focused).toBe(leaves(s.panes.get().root).find((p) => p.tab)!.id);
    expect(shows(s)).toEqual(["a", `tab:${t}`]);
  });

  /** The split in front, full: nine chats. */
  const fill = (s: Store) => {
    show(s, "c1");
    for (let i = 2; i <= 9; i++) {
      const l = s.panes.get();
      s.panes.set(insert(l, l.focused!, i % 2 ? "right" : "bottom", newPane(l, `c${i}`)));
    }
    expect(leaves(s.panes.get().root)).toHaveLength(9);
  };

  test("in a browser, Open in split view with no room leaves the tab in its panel: no window tab it can't reach", async () => {
    const { s, panels } = await loadBoth();
    // The screen-reader line it speaks (announce).
    const live = { textContent: "", className: "", setAttribute: () => undefined };
    vi.stubGlobal("document", { querySelector: () => null, createElement: () => live, body: { append: () => undefined } });
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => f());
    fill(s);
    const t = panels.openSurface("c1", "terminal", {});
    const ref = { workspaceId: "c1", id: t };
    expect(s.panes.canHostTab(ref)).toBe(false);
    expect(s.panes.hostTab(ref)).toBeNull();
    expect(live.textContent).toBe("No room in the split view. Close or zoom a pane first.");
    expect(s.windowTabs.get().list).toHaveLength(1);
    expect(panels.isHosted("c1", t)).toBe(false);
    expect(panels.getPanel("c1")).toMatchObject({ open: true, active: t });
  });

  test("in the desktop app, Open in split view with no room gives the tab a window tab of its own", async () => {
    const { s, panels } = await loadBoth();
    fill(s);
    vi.stubGlobal("window", { ...globalThis.window, cavemanDesktop: {} });
    const t = panels.openSurface("c1", "terminal", {});
    const ref = { workspaceId: "c1", id: t };
    expect(s.panes.canHostTab(ref)).toBe(true);
    expect(s.panes.hostTab(ref)).toBe("/panes");
    expect(paths(s)).toEqual(["/w/c1", "/panes"]);
    expect(panels.isHosted("c1", t)).toBe(true);
  });

  test("a focused tab's pane is the panes' route, so no chat's route takes focus back from it", async () => {
    const { s, panels } = await loadBoth();
    show(s, "a");
    const t = panels.openSurface("a", "terminal", {});
    s.panes.hostTab({ workspaceId: "a", id: t });
    expect(s.splitPath(s.panes.get())).toBe("/panes");
    // The chat focused again: its route.
    s.panes.focus(paneOf(s.panes.get(), "a")!.id);
    expect(s.splitPath(s.panes.get())).toBe("/w/a");
    // Open in split view from a page (the Chief): the tab's pane comes into focus and the route says the panes.
    s.panes.dock(leaves(s.panes.get().root).find((p) => p.tab)!.id);
    s.windowTabs.follow("/chief");
    expect(s.panes.hostTab({ workspaceId: "a", id: t })).toBe("/panes");
  });

  test("Back goes to the panes' route only while the split still focuses a side-panel tab: never a step that shows nothing", async () => {
    const { s, panels } = await loadBoth();
    show(s, "a");
    const t = panels.openSurface("a", "terminal", {});
    s.panes.hostTab({ workspaceId: "a", id: t });
    s.windowTabs.follow("/panes", "replace");
    // A page over the split, then Back: the terminal is still in focus there.
    s.windowTabs.follow("/automations");
    expect(s.windowTabs.go(-1)).toBe("/panes");
    // The chat beside it, opened from the sidebar: the split no longer focuses the terminal, so Back passes the panes.
    show(s, "a");
    expect(s.windowTabs.go(-1)).toBe("/chief");
  });

  test("a split behind whose side-panel tab was in focus still says which chat was on screen (recentChat)", async () => {
    const { s, panels } = await loadBoth();
    show(s, "a");
    const t = panels.openSurface("a", "terminal", {});
    s.panes.hostTab({ workspaceId: "a", id: t });
    s.windowTabs.follow("/panes");
    s.windowTabs.open("/chief");
    expect(s.recentChat(s.windowTabs.get())).toBe("a");
  });

  test("tabs in panes are stored with the window's tabs; one stored twice stays in the first", async () => {
    const pane = newTabPane({ root: null, focused: null }, { workspaceId: "a", id: "x" });
    const layout = { root: pane, focused: pane.id };
    const { s, panels } = await loadBoth({ "caveman.tabs.test": { tabs: [{ id: "t1", path: "/panes", layout }, { id: "t2", path: "/panes", layout }], active: "t1" } });
    expect(paths(s)).toEqual(["/panes", "/new"]);
    expect(panels.isHosted("a", "x")).toBe(true);
  });
});

test("Back and Forward walk the tab's own steps, as a browser tab's; a redirect or a pane's focus is no step", async () => {
  const s = await load();
  s.windowTabs.follow("/automations");
  s.windowTabs.follow("/plugins");
  // /inbox lands on the Chief by a redirect: one step, named for where it landed.
  s.windowTabs.follow("/inbox");
  s.windowTabs.follow("/chief", "replace");
  expect(s.windowTabs.canGo(1)).toBe(false);
  expect(s.windowTabs.go(-1)).toBe("/plugins");
  expect(s.windowTabs.go(-1)).toBe("/automations");
  expect(front(s).path).toBe("/automations");
  expect(s.windowTabs.go(1)).toBe("/plugins");
  // Going somewhere new drops what was ahead.
  s.windowTabs.follow("/review");
  expect(s.windowTabs.canGo(1)).toBe(false);
  expect(s.windowTabs.go(-1)).toBe("/plugins");
  expect(s.windowTabs.go(-1)).toBe("/automations");
  // Back where the tab began: nothing further.
  expect(s.windowTabs.go(-1)).toBe("/chief");
  expect(s.windowTabs.go(-1)).toBeNull();
  expect(s.windowTabs.canGo(-1)).toBe(false);
});

test("each tab keeps its own Back; a tab switch is no step in either", async () => {
  const s = await load();
  s.windowTabs.follow("/automations");
  s.windowTabs.openNewChat();
  s.windowTabs.follow("/plugins");
  expect(s.windowTabs.go(-1)).toBe("/new");
  expect(s.windowTabs.canGo(-1)).toBe(false);
  s.windowTabs.follow(s.windowTabs.activateAt(1)!, "replace");
  expect(s.windowTabs.go(-1)).toBe("/chief");
});

test("Back steps over a chat that has moved to another tab, and never pulls it out", async () => {
  const s = await load();
  show(s, "a");
  show(s, "b");
  s.windowTabs.follow("/automations");
  // "a" opens in a tab of its own; the first tab's Back passes it and lands on the Chief it began on.
  s.windowTabs.openChat("a");
  s.windowTabs.activateAt(1);
  expect(s.windowTabs.go(-1)).toBe("/w/b");
  expect(s.windowTabs.go(-1)).toBe("/chief");
  expect(s.windowTabs.get().list.map((t) => t.path)).toEqual(["/chief", "/w/a"]);
  // Forward passes it too.
  expect(s.windowTabs.go(1)).toBe("/w/b");
  expect(s.windowTabs.go(1)).toBe("/automations");
});

test("Back steps over a chat a full split has no room for, so it never spills into a tab of its own", async () => {
  const s = await load();
  show(s, "a");
  // "b" takes the one pane's place, then the split fills beside it: no room for "a" without a new tab.
  show(s, "b");
  s.panes.drop("c", null, paneOf(s.panes.get(), "b")!.id, "right");
  s.windowTabs.follow("/w/c", "replace");
  expect(s.windowTabs.go(-1)).toBe("/chief");
  // Forward passes it too, back to the split as it was (PaneHost shows the chat the route names).
  expect(s.windowTabs.go(1)).toBe("/w/c");
  s.panes.show("c");
  expect(s.windowTabs.get().list).toHaveLength(1);
  expect(leaves(front(s).layout.root).map((p) => p.workspaceId)).toEqual(["b", "c"]);
  // A pane closes, and "a" fits again.
  s.panes.close(paneOf(s.panes.get(), "c")!.id);
  s.windowTabs.follow("/w/b", "replace");
  expect(s.windowTabs.canGo(-1)).toBe(true);
  expect(s.windowTabs.go(-1)).toBe("/w/a");
});

test("a chat a full split has no room for opens in a tab of its own, and the tab it came from keeps its Back and Forward", async () => {
  const s = await load();
  show(s, "a");
  s.panes.drop("b", null, paneOf(s.panes.get(), "a")!.id, "right");
  s.windowTabs.follow(s.splitPath(s.panes.get()), "replace");
  s.windowTabs.follow("/automations");
  const split = s.windowTabs.go(-1)!;
  // A link to "c": the route lands first (AppShell), then the split view opens it (PaneHost), in a tab of its own.
  s.windowTabs.follow("/w/c");
  s.panes.show("c");
  expect(paths(s)).toEqual([split, "/w/c"]);
  s.windowTabs.activateAt(1);
  expect(s.windowTabs.go(1)).toBe("/automations");
  expect(s.windowTabs.go(-1)).toBe(split);
  expect(s.windowTabs.go(-1)).toBe("/chief");
});

// The split view (PaneHost) and the route (AppShell) each hear of a chat opened; in the app the split view's effect runs
// first, and the result is the same either way.
for (const splitViewFirst of [true, false]) {
  test(`a page over a full split keeps its step when a chat with no room there opens in a tab of its own (${splitViewFirst ? "split view" : "route"} first)`, async () => {
    const s = await load();
    show(s, "a");
    s.panes.drop("b", null, paneOf(s.panes.get(), "a")!.id, "right");
    const split = s.splitPath(s.panes.get());
    s.windowTabs.follow(split, "replace");
    s.windowTabs.follow("/automations");
    if (splitViewFirst) {
      s.panes.show("c");
      s.windowTabs.follow("/w/c");
    } else {
      s.windowTabs.follow("/w/c");
      s.panes.show("c");
    }
    expect(paths(s)).toEqual([split, "/w/c"]);
    s.windowTabs.activateAt(1);
    expect(s.windowTabs.go(-1)).toBe("/automations");
    expect(s.windowTabs.go(1)).toBe(split);
  });
}

test("a tab's Back comes back with it: across a relaunch, and with ⌘⇧T", async () => {
  const first = await load({}, "", "caveman-one");
  first.windowTabs.follow("/automations");
  first.windowTabs.follow("/plugins");
  first.windowTabs.openNewChat();
  first.windowTabs.follow("/review");
  first.windowTabs.close((t) => t.id === "t2");
  expect(first.windowTabs.go(-1)).toBe("/automations");
  await Promise.resolve();
  leave();
  const stored = Object.fromEntries([...mem].map(([k, v]) => [k, JSON.parse(v)]));
  const next = await load(stored, "", "");
  expect(front(next).path).toBe("/automations");
  expect(next.windowTabs.go(1)).toBe("/plugins");
  expect(next.windowTabs.go(-1)).toBe("/automations");
  expect(next.windowTabs.reopen()).toBe("/review");
  expect(next.windowTabs.go(-1)).toBe("/new");
});
