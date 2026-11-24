import { beforeEach, expect, test, vi } from "vitest";
import { activateTab, canMoveTabTo, closeTab, closeTabs, getPanel, getTabs, hostChanged, moveTab, moveTabTo, openSurface, resetPanels, setPanelOpen, setTabHost, setTabIdentity, stepAside, toggleSurface, updateTab } from "./store.ts";

const W = "w1";
beforeEach(() => {
  resetPanels();
  setTabIdentity("diff", "one");
  setTabIdentity("file", (p) => p.path);
  setTabIdentity("terminal", "many");
});

test("opening the same thing activates its tab and bumps reveal; many-kinds get their own tab", () => {
  const a = openSurface(W, "file", { path: "src/a.ts" });
  openSurface(W, "diff", {});
  const again = openSurface(W, "file", { path: "src/a.ts", line: 40 });
  expect(again).toBe(a);
  const s = getPanel(W);
  expect(s.tabs.map((t) => t.id)).toEqual(["file:src/a.ts", "diff"]);
  expect(s.active).toBe(a);
  expect(s.tabs[0]!.reveal).toBe(1);
  expect(s.tabs[0]!.params).toEqual({ path: "src/a.ts", line: 40 });
  const t1 = openSurface(W, "terminal", {});
  const t2 = openSurface(W, "terminal", {});
  expect(t1).not.toBe(t2);
});

test("closing picks the right neighbour, else the left; the last close hides the panel", () => {
  const a = openSurface(W, "terminal", {});
  const b = openSurface(W, "terminal", {});
  const c = openSurface(W, "terminal", {});
  activateTab(W, b);
  closeTab(W, b);
  expect(getPanel(W).active).toBe(c);
  closeTab(W, c);
  expect(getPanel(W).active).toBe(a);
  closeTabs(W, () => true);
  expect(getPanel(W)).toMatchObject({ open: false, active: null, tabs: [] });
});

test("a quiet open flags the tab without stealing focus; activating clears it", () => {
  const mine = openSurface(W, "diff", {});
  const agent = openSurface(W, "terminal", {}, { focus: false });
  expect(getPanel(W).active).toBe(mine);
  expect(getPanel(W).tabs.find((t) => t.id === agent)!.attention).toBe(true);
  activateTab(W, agent);
  expect(getPanel(W).tabs.find((t) => t.id === agent)!.attention).toBe(false);
  // The tab in view never carries attention.
  updateTab(W, agent, { attention: true });
  expect(getPanel(W).tabs.find((t) => t.id === agent)!.attention).toBe(false);
});

test("opening a file replaces the bare tree tab; hiding keeps tabs; showing an empty panel opens a launcher", () => {
  setTabIdentity("files", "one");
  openSurface(W, "files", {});
  openSurface(W, "file", { path: "README.md" });
  expect(getPanel(W).tabs.map((t) => t.kind)).toEqual(["file"]);
  setPanelOpen(W, false);
  expect(getPanel(W).tabs).toHaveLength(1);
  resetPanels();
  setPanelOpen(W, true);
  expect(getPanel(W).tabs.map((t) => t.kind)).toEqual(["new"]);
});

test("moveTab reorders; unchanged state keeps its identity", () => {
  const a = openSurface(W, "terminal", {});
  const b = openSurface(W, "terminal", {});
  moveTab(W, b, 0);
  expect(getPanel(W).tabs.map((t) => t.id)).toEqual([b, a]);
  const before = getPanel(W);
  moveTab(W, b, 0);
  updateTab(W, "gone", { title: "x" });
  expect(getPanel(W)).toBe(before);
});

test("replace puts the opened tab in the launcher tab's place", () => {
  const a = openSurface(W, "terminal", {});
  const launcher = openSurface(W, "terminal", {});
  const b = openSurface(W, "diff", {});
  const file = openSurface(W, "file", { path: "x.md" }, { replace: launcher });
  expect(getPanel(W).tabs.map((t) => t.id)).toEqual([a, file, b]);
  expect(getPanel(W).active).toBe(file);
});

test("review fixes: replace index with a tab ahead, quiet file open re-picks active, showing clears attention, params merge", () => {
  setTabIdentity("files", "one");
  const f = openSurface(W, "file", { path: "f.ts" });
  const a = openSurface(W, "terminal", {});
  const launcher = openSurface(W, "terminal", {});
  const b = openSurface(W, "diff", {});
  openSurface(W, "file", { path: "f.ts" }, { replace: launcher });
  expect(getPanel(W).tabs.map((t) => t.id)).toEqual([a, f, b]);

  resetPanels();
  const tree = openSurface(W, "files", {});
  expect(getPanel(W).active).toBe(tree);
  const quiet = openSurface(W, "file", { path: "x.ts" }, { focus: false });
  expect(getPanel(W).active).toBe(quiet);

  resetPanels();
  openSurface(W, "terminal", {}, { focus: false });
  setPanelOpen(W, true);
  expect(getPanel(W).tabs[0]!.attention).toBe(false);

  resetPanels();
  setTabIdentity("terminal", (p) => p.command ?? "x");
  const t = openSurface(W, "terminal", { command: "pnpm dev" });
  updateTab(W, t, { params: { terminalId: "t9" } });
  const again = openSurface(W, "terminal", { command: "pnpm dev" });
  expect(again).toBe(t);
  expect(getPanel(W).tabs.find((x) => x.id === again)!.params).toEqual({ command: "pnpm dev", terminalId: "t9" });
  const before = getPanel(W);
  activateTab(W, again);
  expect(getPanel(W)).toBe(before);
});

test("re-opening a file without a line drops the old one", () => {
  const f = openSurface(W, "file", { path: "a.ts", line: 9 });
  openSurface(W, "file", { path: "a.ts" });
  expect(getPanel(W).tabs.find((t) => t.id === f)!.params).toEqual({ path: "a.ts" });
});

test("Changes opened without a turn shows them all again; a checkpoint's Changes picks its turn", () => {
  const d = openSurface(W, "diff", { turn: "checkpoint:2" });
  expect(getPanel(W).tabs.find((t) => t.id === d)!.params).toEqual({ turn: "checkpoint:2" });
  openSurface(W, "diff", {});
  expect(getPanel(W).tabs.find((t) => t.id === d)!.params).toEqual({});
  openSurface(W, "diff", { turn: "checkpoint:1" });
  openSurface(W, "diff", { path: "a.ts" });
  expect(getPanel(W).tabs.find((t) => t.id === d)!.params).toEqual({ path: "a.ts" });
});

test("Changes opened without a file doesn't scroll back to (and expand) the file a turn's row revealed", () => {
  const d = openSurface(W, "diff", { turn: "checkpoint:1", path: "src/x.ts" });
  // The scope menu's pick.
  openSurface(W, "diff", { turn: "checkpoint:2" });
  expect(getPanel(W).tabs.find((t) => t.id === d)!.params).toEqual({ turn: "checkpoint:2" });
  openSurface(W, "diff", { path: "src/x.ts" });
  // The pane's Changes card, "Show all changes", /diff.
  openSurface(W, "diff", {});
  expect(getPanel(W).tabs.find((t) => t.id === d)!.params).toEqual({});
});

test("a step's diff shows in the one Changes tab, and Changes opened any other way shows the checkout's again", () => {
  const d = openSurface(W, "diff", { item: "item-7" });
  expect(getPanel(W).tabs.find((t) => t.id === d)!.params).toEqual({ item: "item-7" });
  openSurface(W, "diff", { turn: "checkpoint:2" });
  expect(getPanel(W).tabs.find((t) => t.id === d)!.params).toEqual({ turn: "checkpoint:2" });
  openSurface(W, "diff", { item: "item-8" });
  openSurface(W, "diff", {});
  expect(getPanel(W).tabs.find((t) => t.id === d)!.params).toEqual({});
});

/** A split view that hosts the tabs in `hosted` (panes/store.ts plays this part in the app). */
function fakeHost() {
  const hosted = new Set<string>();
  const host = {
    hosted,
    reveal: vi.fn(),
    retarget: vi.fn((_: string, from: string, to: string) => {
      hosted.delete(from);
      hosted.add(to);
    }),
    host: (id: string) => {
      hosted.add(id);
      hostChanged();
    },
  };
  setTabHost({ hosts: (w, id) => w === W && hosted.has(id), reveal: host.reveal, retarget: host.retarget });
  return host;
}

test("a tab in a pane of its own leaves the strip: the panel goes on with its neighbour, and closes with none left", () => {
  const host = fakeHost();
  const a = openSurface(W, "terminal", {});
  const b = openSurface(W, "terminal", {});
  stepAside(W, b);
  host.host(b);
  expect(getPanel(W).tabs.map((t) => t.id)).toEqual([a]);
  expect(getPanel(W)).toMatchObject({ open: true, active: a });
  // Every tab is still the workspace's: its surface finds itself, and its pane can close back into the strip.
  expect(getTabs(W).map((t) => t.id)).toEqual([a, b]);
  stepAside(W, a);
  host.host(a);
  expect(getPanel(W)).toMatchObject({ open: false, tabs: [] });
  // Showing the panel with every tab in a pane opens a launcher in it.
  setPanelOpen(W, true);
  expect(getPanel(W).tabs.map((t) => t.kind)).toEqual(["new"]);
});

test("opening a tab that is in a pane shows its pane, not the panel", () => {
  const host = fakeHost();
  const a = openSurface(W, "file", { path: "a.ts" });
  const b = openSurface(W, "file", { path: "b.ts" });
  host.host(a);
  expect(openSurface(W, "file", { path: "a.ts", line: 9 })).toBe(a);
  expect(host.reveal).toHaveBeenCalledWith(W, a);
  expect(getPanel(W).active).toBe(b);
  expect(getTabs(W).find((t) => t.id === a)!.params).toEqual({ path: "a.ts", line: 9 });
  activateTab(W, a);
  expect(host.reveal).toHaveBeenCalledTimes(2);
  // Quietly (an agent's open): no pane comes forward.
  openSurface(W, "file", { path: "a.ts" }, { focus: false });
  expect(host.reveal).toHaveBeenCalledTimes(2);
});

test("a tab that replaces one in a pane takes its pane; the panel stays as it was", () => {
  const host = fakeHost();
  setPanelOpen(W, false);
  const f = openSurface(W, "file", { path: "a.ts" }, { focus: false });
  host.host(f);
  const g = openSurface(W, "file", { path: "b.ts" }, { replace: f });
  expect(host.retarget).toHaveBeenCalledWith(W, f, g);
  expect(getTabs(W).map((t) => t.id)).toEqual([g]);
  expect(getPanel(W)).toMatchObject({ open: false, tabs: [] });
  expect(host.reveal).not.toHaveBeenCalled();
});

test("closing the strip's tabs leaves the ones in panes alone", () => {
  const host = fakeHost();
  const a = openSurface(W, "terminal", {});
  const b = openSurface(W, "terminal", {});
  host.host(a);
  const strip = getPanel(W).tabs;
  expect(strip.map((t) => t.id)).toEqual([b]);
  closeTabs(W, (t) => strip.includes(t));
  expect(getTabs(W).map((t) => t.id)).toEqual([a]);
});

test("a tab moves to another workspace's panel with its params and title, in front there", () => {
  const pr = openSurface(W, "file", { path: "README.md" });
  updateTab(W, pr, { title: "Read me" });
  const moved = moveTabTo(W, pr, "w2");
  expect(getTabs(W)).toEqual([]);
  expect(getPanel("w2")).toMatchObject({ open: true, active: moved });
  expect(getTabs("w2")[0]).toMatchObject({ kind: "file", params: { path: "README.md" }, title: "Read me" });
});

test("a tab doesn't move to a panel whose workspace shows the same thing in a pane of its own", () => {
  const host = fakeHost();
  // The same file in both workspaces; the one in W is in a pane (the fake host hosts W's tabs only).
  const inPane = openSurface(W, "file", { path: "PR.md" });
  host.host(inPane);
  const there = openSurface("w2", "file", { path: "PR.md" });
  expect(canMoveTabTo("w2", there, W)).toBe(false);
  expect(moveTabTo("w2", there, W)).toBeNull();
  expect(getTabs("w2").map((t) => t.id)).toEqual([there]);
  expect(host.reveal).not.toHaveBeenCalled();
  // A copy only in W's strip: the move lands on it, and W's panel shows it.
  host.hosted.delete(inPane);
  hostChanged();
  expect(canMoveTabTo("w2", there, W)).toBe(true);
  expect(moveTabTo("w2", there, W)).toBe(inPane);
  expect(getTabs("w2")).toEqual([]);
  expect(getPanel(W).active).toBe(inPane);
});

test("a kind's key shows its tab in a pane of its own rather than opening another", () => {
  const host = fakeHost();
  const term = openSurface(W, "terminal", {});
  const file = openSurface(W, "file", { path: "a.ts" });
  host.host(term);
  toggleSurface(W, "terminal");
  expect(host.reveal).toHaveBeenCalledWith(W, term);
  expect(getTabs(W).filter((t) => t.kind === "terminal")).toHaveLength(1);
  expect(getPanel(W).active).toBe(file);
  // One in the strip still wins, and pressing again hides the panel.
  const strip = openSurface(W, "terminal", {});
  activateTab(W, file);
  toggleSurface(W, "terminal");
  expect(getPanel(W)).toMatchObject({ open: true, active: strip });
  toggleSurface(W, "terminal");
  expect(getPanel(W).open).toBe(false);
});
