import { describe, expect, it } from "vitest";
import {
  close,
  cycle,
  EMPTY,
  equalize,
  focus,
  fromJSON,
  neighbor,
  settle,
  squeezed,
  toggleZoom,
  findSplit,
  fits,
  geometry,
  insert,
  leaves,
  MAX_PANES,
  move,
  newPane,
  newTabPane,
  paneKey,
  parse,
  place,
  resizeAt,
  serialize,
  openWorkspaceIds,
  show,
  splitAt,
  tabPaneOf,
  zoneAt,
  CORNER_PX,
  STICK_PX,
  type Layout,
  type Split,
} from "./tree.ts";

const ws = (layout: Layout) => leaves(layout.root).map((p) => p.workspaceId);
const open = (...ids: string[]) => ids.reduce((l, id, i) => (i === 0 ? show(l, id) : insert(l, l.focused!, "right", newPane(l, id))), EMPTY);

describe("pane tree", () => {
  it("opens the first pane from the route and reuses the focused pane after that", () => {
    const one = show(EMPTY, "a");
    expect(ws(one)).toEqual(["a"]);
    const two = show(one, "b");
    expect(ws(two)).toEqual(["b"]);
    expect(two.focused).toBe(one.focused);
  });

  it("focuses an open workspace instead of duplicating it", () => {
    const l = open("a", "b");
    const a = leaves(l.root)[0]!;
    const again = show(l, "a");
    expect(ws(again)).toEqual(["a", "b"]);
    expect(again.focused).toBe(a.id);
    expect(openWorkspaceIds(again)).toEqual(["a", "b"]);
  });

  it("lists the open workspaces in pane order, skipping empty panes, and follows opens and closes", () => {
    expect(openWorkspaceIds(EMPTY)).toEqual([]);
    const two = open("a", "b");
    expect(openWorkspaceIds(two)).toEqual(["a", "b"]);
    // ⌘\: an empty pane waiting for a workspace shows nothing as open.
    const withEmpty = insert(two, two.focused!, "bottom", newPane(two, null));
    expect(openWorkspaceIds(withEmpty)).toEqual(["a", "b"]);
    // Loading a workspace into the focused pane swaps what is open.
    const swapped = show(two, "c");
    expect(openWorkspaceIds(swapped)).toEqual(["a", "c"]);
    // Closing its pane takes it off the list.
    const closed = close(two, leaves(two.root)[0]!.id);
    expect(openWorkspaceIds(closed)).toEqual(["b"]);
  });

  it("splits right, left, down and up", () => {
    const base = show(EMPTY, "a");
    const id = base.focused!;
    expect(ws(insert(base, id, "right", newPane(base, "b")))).toEqual(["a", "b"]);
    expect(ws(insert(base, id, "left", newPane(base, "b")))).toEqual(["b", "a"]);
    const down = insert(base, id, "bottom", newPane(base, "b"));
    expect(down.root).toMatchObject({ kind: "split", dir: "column" });
    expect(ws(down)).toEqual(["a", "b"]);
    expect(ws(insert(base, id, "top", newPane(base, "b")))).toEqual(["b", "a"]);
    expect(down.focused).toBe(leaves(down.root)[1]!.id);
  });

  it("flattens same-direction splits so three across are one row", () => {
    const l = open("a", "b", "c");
    expect(l.root).toMatchObject({ kind: "split", dir: "row" });
    expect((l.root as Split).children).toHaveLength(3);
    expect((l.root as Split).sizes.reduce((x, y) => x + y)).toBeCloseTo(1);
  });

  it("keeps an even row even (thirds) and halves the target in an uneven one", () => {
    const thirds = open("a", "b", "c");
    expect((thirds.root as Split).sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
    const uneven: Layout = { ...open("a", "b"), root: { ...(open("a", "b").root as Split), sizes: [0.7, 0.3] } };
    const l = insert(uneven, leaves(uneven.root)[0]!.id, "right", newPane(uneven, "c"));
    expect((l.root as Split).sizes).toEqual([0.35, 0.35, 0.3]);
  });

  it("builds an even 3×3 grid and caps it at MAX_PANES; the centre still replaces", () => {
    let l = open("a", "b", "c");
    for (const top of leaves(l.root)) {
      for (const ws of [`${top.workspaceId}2`, `${top.workspaceId}3`]) l = insert(l, top.id, "bottom", newPane(l, ws));
    }
    expect(leaves(l.root)).toHaveLength(MAX_PANES);
    for (const r of geometry(l.root).panes.values()) {
      expect(r.w).toBeCloseTo(1 / 3);
      expect(r.h).toBeCloseTo(1 / 3);
    }
    const full = insert(l, l.focused!, "right", newPane(l, "z"));
    expect(full).toBe(l);
    l = insert(l, l.focused!, "center", { ...newPane(l, "z"), id: l.focused! });
    expect(ws(l)).toContain("z");
    expect(parse(serialize(l))).toEqual(l);
  });

  it("splits only when every pane it shrinks stays above the minimum", () => {
    const two = open("a", "b");
    const target = leaves(two.root)[1]!.id;
    // 1200px across: thirds are 400px, quarters would be 300px.
    const three = splitAt(two, target, "right", newPane(two, "c"), 1200, 800);
    expect(leaves(three.root)).toHaveLength(3);
    expect(splitAt(three, three.focused!, "right", newPane(three, "d"), 1200, 800)).toBe(three);
    // 800px tall: halves are 400px; 300px tall would leave 150px.
    expect(leaves(splitAt(three, three.focused!, "bottom", newPane(three, "d"), 1200, 800).root)).toHaveLength(4);
    expect(splitAt(three, three.focused!, "bottom", newPane(three, "d"), 1200, 300)).toBe(three);
    // A pane already under the minimum (a smaller window) does not block a split elsewhere.
    expect(fits(three, three, 600, 300)).toBe(true);
  });

  it("places a new chat without taking or squeezing another chat's pane", () => {
    // One pane: it loads there, like opening any chat.
    const one = show(EMPTY, "a");
    expect(ws(place(one, "n")!)).toEqual(["n"]);
    // An empty pane takes it, even when it is not focused.
    const withEmpty = insert(one, one.focused!, "right", newPane(one, null));
    const filled = place({ ...withEmpty, focused: leaves(withEmpty.root)[0]!.id }, "n")!;
    expect(ws(filled)).toEqual(["a", "n"]);
    expect(filled.focused).toBe(leaves(withEmpty.root)[1]!.id);
    // Two chats: no room it may take; it gets a tab of its own.
    const two = open("a", "b");
    expect(place(two, "n")).toBeNull();
    // Already open: just focus it.
    expect(place(two, "a")).toEqual({ ...two, focused: leaves(two.root)[0]!.id });
  });

  it("closes a pane, collapses its split and focuses a neighbour", () => {
    const base = show(EMPTY, "a");
    const two = insert(base, base.focused!, "bottom", newPane(base, "b"));
    const three = insert(two, two.focused!, "right", newPane(two, "c"));
    expect(three.root).toMatchObject({ kind: "split", dir: "column" });
    const closed = close(three, three.focused!);
    expect(ws(closed)).toEqual(["a", "b"]);
    expect(closed.root).toMatchObject({ kind: "split", dir: "column" });
    expect(closed.focused).toBe(leaves(closed.root)[1]!.id);
    const last = close(close(closed, closed.focused!), leaves(closed.root)[0]!.id);
    expect(last.root).toBeNull();
  });

  it("moves a pane by id (so it stays mounted) and swaps on the centre", () => {
    const l = open("a", "b", "c");
    const [a, , c] = leaves(l.root);
    const moved = move(l, c!.id, a!.id, "bottom");
    expect(leaves(moved.root).find((p) => p.workspaceId === "c")!.id).toBe(c!.id);
    expect(moved.root).toMatchObject({ kind: "split", dir: "row" });
    const swapped = move(l, a!.id, c!.id, "center");
    expect(ws(swapped)).toEqual(["c", "b", "a"]);
    expect(move(l, a!.id, a!.id, "left")).toBe(l);
  });

  it("lays panes and dividers out in fractions of the host", () => {
    const base = show(EMPTY, "a");
    const two = insert(base, base.focused!, "right", newPane(base, "b"));
    const three = insert(two, two.focused!, "bottom", newPane(two, "c"));
    const g = geometry(three.root);
    const [a, b, c] = leaves(three.root);
    expect(g.panes.get(a!.id)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(g.panes.get(b!.id)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(g.panes.get(c!.id)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(g.dividers.map((d) => [d.dir, d.at])).toEqual([
      ["row", 0.5],
      ["column", 0.5],
    ]);
  });

  it("resizes within both neighbours' minimum sizes", () => {
    const l = open("a", "b");
    const split = l.root as Split;
    expect(resizeAt(split, 0, 0.7, 1600)).toEqual([0.7, expect.closeTo(0.3)]);
    // 360px minimum on 1000px: the line stops at 0.36 and 0.64.
    expect(resizeAt(split, 0, 0.05, 1000)[0]).toBeCloseTo(0.36);
    expect(resizeAt(split, 0, 0.99, 1000)[0]).toBeCloseTo(0.64);
    expect(findSplit(l.root, split.id)).toBe(split);
  });

  it("cycles focus in reading order", () => {
    const l = open("a", "b", "c");
    const [a, b, c] = leaves(l.root);
    expect(l.focused).toBe(c!.id);
    expect(cycle(l, 1)).toBe(a!.id);
    expect(cycle({ ...l, focused: a!.id }, 1)).toBe(b!.id);
    expect(cycle({ ...l, focused: a!.id }, -1)).toBe(c!.id);
  });

  it("round-trips through storage and rejects anything malformed", () => {
    const base = show(EMPTY, "a");
    const l = insert(base, base.focused!, "bottom", newPane(base, "b"));
    expect(parse(serialize(l))).toEqual(l);
    expect(parse(null)).toBe(EMPTY);
    expect(parse("{")).toBe(EMPTY);
    expect(parse(JSON.stringify({ root: { kind: "pane", id: "x" } }))).toBe(EMPTY);
    const dup = { root: { kind: "split", id: "s1", dir: "row", sizes: [1, 1], children: [leaves(l.root)[0], leaves(l.root)[0]] } };
    expect(parse(JSON.stringify(dup))).toBe(EMPTY);
    const full = open("a", "b", "c", "d", "e", "f", "g", "h", "i");
    const over = { root: { kind: "split", id: "s9", dir: "column", sizes: [1, 1], children: [full.root, { kind: "pane", id: "p99", workspaceId: "j" }] } };
    expect(parse(JSON.stringify(over))).toBe(EMPTY);
    // A stale focus falls back to the first pane; sizes renormalise.
    const stale = parse(JSON.stringify({ root: { kind: "split", id: "s1", dir: "row", sizes: [3, 1], children: [{ kind: "pane", id: "p1", workspaceId: "a" }, { kind: "pane", id: "p2", workspaceId: null }] }, focused: "p7" }));
    expect(stale.focused).toBe("p1");
    expect((stale.root as Split).sizes).toEqual([0.75, 0.25]);
  });
});

describe("drop zones", () => {
  const rect = { left: 100, top: 50, width: 1000, height: 800 };
  const any = () => true;

  it("picks the nearest edge inside the band and the centre elsewhere", () => {
    expect(zoneAt(rect, 120, 450, any)).toBe("left");
    expect(zoneAt(rect, 1090, 450, any)).toBe("right");
    expect(zoneAt(rect, 600, 60, any)).toBe("top");
    expect(zoneAt(rect, 600, 700, any)).toBe("bottom");
    expect(zoneAt(rect, 600, 450, any)).toBe("center");
  });

  it("gives each corner a square of at most CORNER_PX, the edges the rest of their band", () => {
    expect(zoneAt(rect, 110, 60, any)).toBe("top-left");
    expect(zoneAt(rect, 1090, 60, any)).toBe("top-right");
    expect(zoneAt(rect, 110, 840, any)).toBe("bottom-left");
    expect(zoneAt(rect, 1090, 840, any)).toBe("bottom-right");
    // Just past the square, the edge it is nearest.
    expect(zoneAt(rect, 100 + CORNER_PX + 2, 60, any)).toBe("top");
    expect(zoneAt(rect, 1090, 50 + CORNER_PX + 2, any)).toBe("right");
    // A small pane's corner is a share of its band (30% of 300px: 90px), so its edges keep room.
    const small = { left: 0, top: 0, width: 300, height: 200 };
    expect(zoneAt(small, 95, 10, any)).toBe("top");
    expect(zoneAt(small, 95, 10, any, "top-left")).toBe("top-left");
  });

  it("holds the zone the pointer is in a few px past its line", () => {
    const line = 100 + CORNER_PX;
    expect(zoneAt(rect, line + STICK_PX / 2, 60, any)).toBe("top");
    expect(zoneAt(rect, line + STICK_PX / 2, 60, any, "top-left")).toBe("top-left");
    expect(zoneAt(rect, line + STICK_PX + 1, 60, any, "top-left")).toBe("top");
    // Coming along an edge, the corner takes over only STICK_PX inside its square, on either edge.
    expect(zoneAt(rect, line - 3, 60, any, "top")).toBe("top");
    expect(zoneAt(rect, line - STICK_PX - 1, 60, any, "top")).toBe("top-left");
    const below = 50 + CORNER_PX;
    expect(zoneAt(rect, 1090, below - 3, any, "right")).toBe("right");
    expect(zoneAt(rect, 1090, below - STICK_PX - 1, any, "right")).toBe("top-right");
    // Edge and centre: 30% of 1000px wide is the line at x=400.
    expect(zoneAt(rect, 404, 450, any, "left")).toBe("left");
    expect(zoneAt(rect, 396, 450, any, "center")).toBe("center");
    expect(zoneAt(rect, 396, 450, any)).toBe("left");
  });

  it("puts a pane alone in a quarter, beside an empty pane, and keeps the other half", () => {
    const one = show(EMPTY, "a");
    const a = one.focused!;
    const l = insert(one, a, "top-right", newPane(one, "b"));
    const g = geometry(l.root).panes;
    const [pa, pb, pe] = leaves(l.root);
    expect([pa!.workspaceId, pb!.workspaceId, pe!.workspaceId]).toEqual(["a", "b", null]);
    expect(g.get(a)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(g.get(pb!.id)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(g.get(pe!.id)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(l.focused).toBe(pb!.id);
    expect(new Set(leaves(l.root).map((p) => p.id)).size).toBe(3);
    const bl = insert(one, a, "bottom-left", newPane(one, "b"));
    expect(geometry(bl.root).panes.get(leaves(bl.root).find((p) => p.workspaceId === "b")!.id)).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("splits a pane in a split across it: a quarter of the view from halves, a grid one drop at a time", () => {
    const two = open("a", "b");
    const [pa, pb] = leaves(two.root).map((p) => p.id);
    // a | b: b's top-right corner puts c above b, a's bottom-left puts d below a.
    const three = insert(two, pb!, "top-right", newPane(two, "c"));
    expect(geometry(three.root).panes.get(leaves(three.root).find((p) => p.workspaceId === "c")!.id)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    const four = insert(three, pa!, "bottom-left", newPane(three, "d"));
    const g = geometry(four.root).panes;
    expect(g.get(leaves(four.root).find((p) => p.workspaceId === "d")!.id)).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(leaves(four.root).every((p) => g.get(p.id)!.w === 0.5 && g.get(p.id)!.h === 0.5)).toBe(true);
  });

  it("moves a pane into a corner without reusing its id for the empty one", () => {
    const two = open("a", "b");
    const [pa, pb] = leaves(two.root).map((p) => p.id);
    const l = move(two, pb!, pa!, "bottom-right");
    const ids = leaves(l.root).map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
    expect(geometry(l.root).panes.get(pb!)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(parse(serialize(l)).root).not.toBeNull();
  });

  it("falls back to the centre on an edge the layout refuses", () => {
    expect(zoneAt(rect, 120, 450, () => false)).toBe("center");
    const sideways = (z: string) => z === "left" || z === "right";
    expect(zoneAt(rect, 600, 790, sideways)).toBe("center");
    expect(zoneAt(rect, 1090, 790, sideways)).toBe("right");
  });

  it("moves focus by direction, back to the pane it came from when several share the edge", () => {
    // a | (b over c): right from a goes to whichever of b and c was focused last.
    const two = open("a", "b");
    const b = leaves(two.root)[1]!.id;
    const grid = insert(two, b, "bottom", newPane(two, "c"));
    const [pa, , pc] = leaves(grid.root).map((p) => p.id);
    let l = settle(grid, focus(grid, pc!));
    l = settle(l, focus(l, pa!));
    expect(neighbor(l, "right")).toBe(pc);
    expect(neighbor(l, "left")).toBeNull();
    l = settle(l, focus(l, b));
    expect(neighbor(l, "down")).toBe(pc);
    expect(neighbor(l, "left")).toBe(pa);
    expect(neighbor(l, "up")).toBeNull();
  });

  it("closing the focused pane goes back to the one focused before it", () => {
    const three = open("a", "b", "c");
    const [pa, pb, pc] = leaves(three.root).map((p) => p.id);
    // Focus a, then click c's close button (the click focuses c first): a comes back, not b.
    let l = settle(three, focus(three, pa!));
    l = settle(l, focus(l, pc!));
    expect(settle(l, close(l, pc!)).focused).toBe(pa);
    expect(settle(l, close(l, pb!)).focused).toBe(pc);
  });

  it("zoom holds while focus and panes stay put, and ends when either changes", () => {
    const two = open("a", "b");
    expect(toggleZoom(show(EMPTY, "a")).zoomed).toBeFalsy();
    const zoomed = settle(two, toggleZoom(two));
    expect(zoomed.zoomed).toBe(true);
    expect(settle(zoomed, toggleZoom(zoomed)).zoomed).toBeFalsy();
    expect(settle(zoomed, focus(zoomed, leaves(two.root)[0]!.id)).zoomed).toBeFalsy();
    expect(settle(zoomed, insert(zoomed, zoomed.focused!, "bottom", newPane(zoomed, "c"))).zoomed).toBeFalsy();
    expect(settle(zoomed, equalize(zoomed)).zoomed).toBe(true);
  });

  it("equalizes one split or all of them", () => {
    const two = open("a", "b");
    const split = two.root as Split;
    const uneven = { ...two, root: { ...split, sizes: [0.8, 0.2] } };
    expect((equalize(uneven).root as Split).sizes).toEqual([0.5, 0.5]);
    expect((equalize(uneven, "nope").root as Split).sizes).toEqual([0.8, 0.2]);
    // Nested: a | (b over c), each split uneven.
    const b = leaves(two.root)[1]!.id;
    const grid = insert(two, b, "bottom", newPane(two, "c"));
    const outer = grid.root as Split;
    const inner = outer.children[1] as Split;
    const skewed = { ...grid, root: { ...outer, sizes: [0.7, 0.3], children: [outer.children[0]!, { ...inner, sizes: [0.9, 0.1] }] } };
    const even = equalize(skewed).root as Split;
    expect(even.sizes).toEqual([0.5, 0.5]);
    expect((even.children[1] as Split).sizes).toEqual([0.5, 0.5]);
    const onlyInner = equalize(skewed, inner.id).root as Split;
    expect(onlyInner.sizes).toEqual([0.7, 0.3]);
    expect((onlyInner.children[1] as Split).sizes).toEqual([0.5, 0.5]);
  });

  it("knows a window too small for its split", () => {
    const three = open("a", "b", "c");
    expect(squeezed(three, 1400, 900)).toBe(false);
    expect(squeezed(three, 700, 900)).toBe(true);
    expect(squeezed(show(EMPTY, "a"), 200, 100)).toBe(true);
  });

  it("reads a damaged layout without repeated ids or the same chat twice", () => {
    const pane = (id: string, workspaceId: string) => ({ kind: "pane", id, workspaceId });
    const dupSplit = { kind: "split", id: "s1", dir: "row", sizes: [0.5, 0.5], children: [pane("p1", "a"), { kind: "split", id: "s1", dir: "column", sizes: [0.5, 0.5], children: [pane("p2", "b"), pane("p3", "c")] }] };
    expect(fromJSON({ root: dupSplit, focused: "p1" })).toEqual(EMPTY);
    const twice = fromJSON({ root: { kind: "split", id: "s1", dir: "row", sizes: [0.5, 0.5], children: [pane("p1", "a"), pane("p2", "a")] }, focused: "p2", zoomed: true, recent: ["p1", "p9"] });
    expect(ws(twice)).toEqual(["a"]);
    expect(twice.focused).toBe("p1");
    expect(twice.zoomed).toBeFalsy();
  });
});

describe("side-panel tabs in panes", () => {
  const shows = (layout: Layout) => leaves(layout.root).map((p) => p.workspaceId ?? `tab:${p.tab?.id}`);
  const term = { workspaceId: "a", id: "terminal:1" };

  it("is no empty pane and no chat: a chat never loads into it", () => {
    const one = show(EMPTY, "a");
    const split = insert(one, one.focused!, "bottom", newTabPane(one, term));
    expect(tabPaneOf(split, term)?.id).toBe(split.focused);
    expect(openWorkspaceIds(split)).toEqual(["a"]);
    // A new chat over chat + tab: every pane is in use, so it gets a tab of its own.
    expect(place(split, "b")).toBeNull();
    // The route asks for a chat while the tab's pane is focused: the chat pane takes it, the tab stays.
    expect(shows(show(split, "b"))).toEqual(["b", "tab:terminal:1"]);
  });

  it("opens a chat beside a split of only tabs, and in the focused tab's place when nine fill it", () => {
    const pane = newTabPane(EMPTY, term);
    const only: Layout = { root: pane, focused: pane.id };
    expect(shows(show(only, "c"))).toEqual(["c", "tab:terminal:1"]);
    let full = only;
    for (let i = 2; i <= MAX_PANES; i++) full = insert(full, full.focused!, i % 2 ? "right" : "bottom", newTabPane(full, { workspaceId: "a", id: `t${i}` }));
    expect(leaves(full.root)).toHaveLength(MAX_PANES);
    const next = show(full, "c");
    expect(leaves(next.root)).toHaveLength(MAX_PANES);
    expect(openWorkspaceIds(next)).toEqual(["c"]);
  });

  it("round-trips through storage; the same tab twice keeps the first", () => {
    const one = show(EMPTY, "a");
    const split = insert(one, one.focused!, "right", newTabPane(one, term));
    expect(shows(parse(serialize(split)))).toEqual(["a", "tab:terminal:1"]);
    const twice = insert(split, split.focused!, "right", newTabPane(split, term));
    expect(shows(fromJSON(JSON.parse(serialize(twice))))).toEqual(["a", "tab:terminal:1"]);
    // A chat and a tab of the same workspace are different things.
    expect(paneKey(leaves(split.root)[0]!)).not.toBe(paneKey(leaves(split.root)[1]!));
  });
});
