// The split view's layout: a tree of rows and columns whose leaves are panes,
// one workspace session each, or one side-panel tab moved out of its panel.
// Pure functions only; store.ts keeps the live copy, drag.ts and PaneHost.tsx
// read the geometry.

export type Edge = "left" | "right" | "top" | "bottom";
/** A pane's corner: the new pane takes a quarter (see `insert`). */
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type Zone = Edge | Corner | "center";

export const CORNERS: ReadonlyArray<Corner> = ["top-left", "top-right", "bottom-left", "bottom-right"];
const EDGES: ReadonlyArray<Edge> = ["left", "right", "top", "bottom"];

export const isCorner = (zone: Zone): zone is Corner => zone.includes("-");

/** A corner's two edges: above or below, and which side. */
export function cornerEdges(corner: Corner): readonly ["top" | "bottom", "left" | "right"] {
  const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  return [v, h];
}
export type Dir = "row" | "column";

/** A side-panel tab, by the workspace whose panel holds it (panels/store.ts) and its id there. */
export interface TabRef {
  readonly workspaceId: string;
  readonly id: string;
}

/** One session on screen, or one side-panel tab. A session's side panel (tabs, width) is the workspace's, in panels/store.ts. */
export interface Pane {
  readonly kind: "pane";
  readonly id: string;
  /** null: an empty pane waiting for a workspace (after ⌘\ or a closed workspace), or a tab's pane. */
  readonly workspaceId: string | null;
  /**
   * A tab moved out of a side panel (a terminal, a browser, a pull request): the pane shows it, and its panel's strip
   * leaves it out. The tab stays its workspace's (what it runs in, its title, its terminal), so closing the pane only
   * puts it back. Its `workspaceId` is null: the pane is no chat.
   */
  readonly tab?: TabRef;
}

export interface Split {
  readonly kind: "split";
  readonly id: string;
  readonly dir: Dir;
  readonly children: ReadonlyArray<Node>;
  /** Fractions of the split, one per child, summing to 1. */
  readonly sizes: ReadonlyArray<number>;
}

export type Node = Pane | Split;

export interface Layout {
  readonly root: Node | null;
  readonly focused: string | null;
  /** The focused pane fills the tab, the others kept mounted behind it. Ends when focus moves or the panes change. */
  readonly zoomed?: boolean;
  /** Panes focused before this one, most recent first: where focus goes back to when one closes or ties a move. */
  readonly recent?: ReadonlyArray<string>;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * A 3×3 grid at most. Every split must also leave each pane it shrinks above
 * its minimum (360px chat + composer, 240px tall; see `fits`), so a smaller
 * screen stops sooner.
 */
export const MAX_PANES = 9;
export const MIN_PANE_W = 360;
export const MIN_PANE_H = 240;

export const EMPTY: Layout = { root: null, focused: null };

// ------------------------------------------------------------------ reading

export function leaves(node: Node | null): Pane[] {
  if (!node) return [];
  if (node.kind === "pane") return [node];
  return node.children.flatMap(leaves);
}

export function findPane(layout: Layout, id: string | null): Pane | null {
  return leaves(layout.root).find((p) => p.id === id) ?? null;
}

/** The workspaces on screen, in pane order: what History marks as open. An empty pane shows none. */
export function openWorkspaceIds(layout: Layout): ReadonlyArray<string> {
  const ids: string[] = [];
  for (const pane of leaves(layout.root)) if (pane.workspaceId !== null && !ids.includes(pane.workspaceId)) ids.push(pane.workspaceId);
  return ids;
}

export function paneOf(layout: Layout, workspaceId: string): Pane | null {
  return leaves(layout.root).find((p) => p.workspaceId === workspaceId) ?? null;
}

/** The pane showing a side-panel tab, if any. */
export function tabPaneOf(layout: Layout, ref: TabRef): Pane | null {
  return leaves(layout.root).find((p) => p.tab?.workspaceId === ref.workspaceId && p.tab.id === ref.id) ?? null;
}

/** Waiting for a workspace: no chat, no tab. */
export const isEmptyPane = (p: Pane): boolean => p.workspaceId === null && !p.tab;

function nextId(layout: Layout, prefix: "p" | "s"): string {
  let max = 0;
  const walk = (n: Node | null) => {
    if (!n) return;
    const m = n.id.startsWith(prefix) ? Number(n.id.slice(1)) : NaN;
    if (Number.isFinite(m)) max = Math.max(max, m);
    if (n.kind === "split") n.children.forEach(walk);
  };
  walk(layout.root);
  return `${prefix}${max + 1}`;
}

/** Creation order: panes render in it so a split never moves a mounted pane in the DOM. */
export function byCreation(a: Pane, b: Pane): number {
  return Number(a.id.slice(1)) - Number(b.id.slice(1));
}

export function newPane(layout: Layout, workspaceId: string | null): Pane {
  return { kind: "pane", id: nextId(layout, "p"), workspaceId };
}

export function newTabPane(layout: Layout, tab: TabRef): Pane {
  return { kind: "pane", id: nextId(layout, "p"), workspaceId: null, tab: { workspaceId: tab.workspaceId, id: tab.id } };
}

// ------------------------------------------------------------------ editing

function mapNode(node: Node, fn: (n: Node) => Node | null): Node | null {
  const self = fn(node);
  if (self !== node || node.kind === "pane") return self;
  const kids: Node[] = [];
  const sizes: number[] = [];
  let changed = false;
  node.children.forEach((child, i) => {
    const next = mapNode(child, fn);
    if (next !== child) changed = true;
    if (next) {
      kids.push(next);
      sizes.push(node.sizes[i]!);
    }
  });
  if (!changed) return node;
  return normalize({ ...node, children: kids, sizes });
}

/** Drops empty splits, unwraps single children, flattens a child split that runs the same way. */
function normalize(split: Split): Node | null {
  if (split.children.length === 0) return null;
  if (split.children.length === 1) return split.children[0]!;
  const kids: Node[] = [];
  const sizes: number[] = [];
  const total = split.sizes.reduce((a, b) => a + b, 0) || 1;
  split.children.forEach((child, i) => {
    const share = split.sizes[i]! / total;
    if (child.kind === "split" && child.dir === split.dir) {
      child.children.forEach((g, j) => {
        kids.push(g);
        sizes.push(share * child.sizes[j]!);
      });
    } else {
      kids.push(child);
      sizes.push(share);
    }
  });
  return { ...split, children: kids, sizes };
}

export function updatePane(layout: Layout, id: string, patch: Partial<Omit<Pane, "kind" | "id">>): Layout {
  if (!layout.root) return layout;
  const root = mapNode(layout.root, (n) => (n.kind === "pane" && n.id === id ? { ...n, ...patch } : n));
  return { ...layout, root };
}

export function focus(layout: Layout, id: string): Layout {
  return layout.focused === id || !findPane(layout, id) ? layout : { ...layout, focused: id };
}

function parentOf(node: Node | null, id: string): Split | null {
  if (!node || node.kind === "pane") return null;
  if (node.children.some((c) => c.id === id)) return node;
  for (const c of node.children) {
    const s = parentOf(c, id);
    if (s) return s;
  }
  return null;
}

/**
 * What a drop on `zone` of `targetId` does: a corner of a pane in a split is
 * the edge across its split (above or below in a row, the side in a column);
 * only a pane alone keeps its corner (a quarter). Every other zone is itself.
 */
export function resolveZone(layout: Layout, targetId: string, zone: Zone): Zone {
  if (!isCorner(zone)) return zone;
  const parent = parentOf(layout.root, targetId);
  if (!parent) return zone;
  const [v, h] = cornerEdges(zone);
  return parent.dir === "row" ? v : h;
}

/**
 * Puts `pane` beside `targetId` on the `zone` side (or in its place for
 * "center"). When the target's row (or column) already runs that way in equal
 * shares, every member gets an equal share again, so splitting right twice
 * makes thirds; otherwise the target gives up half of its own space.
 *
 * A corner gives `pane` a quarter. A target that stands in a row (a column of
 * it) splits across that row, above or below, and one in a column splits to
 * the side: the quarter of the area it shares, and a grid built one drop at a
 * time. A target alone fills the view: it keeps the far half and `pane` takes
 * the corner's quarter, beside an empty pane that waits for a chat (as ⌘D's
 * does), since a tree has no L-shaped pane.
 */
export function insert(layout: Layout, targetId: string, zone: Zone, pane: Pane): Layout {
  if (!layout.root) return { root: pane, focused: pane.id };
  if (!findPane(layout, targetId)) return layout;
  const resolved = resolveZone(layout, targetId, zone);
  if (resolved !== zone) return insert(layout, targetId, resolved, pane);
  if (isCorner(zone)) {
    const [v, h] = cornerEdges(zone);
    const target = layout.root;
    // The pane may be one moved (move closed it first): the empty one's id is past both.
    const n = Math.max(Number(nextId(layout, "p").slice(1)), Number(pane.id.slice(1)) + 1);
    const empty: Pane = { kind: "pane", id: `p${n}`, workspaceId: null };
    const s = Number(nextId(layout, "s").slice(1));
    const side: Split = { kind: "split", id: `s${s + 1}`, dir: "column", children: v === "top" ? [pane, empty] : [empty, pane], sizes: [0.5, 0.5] };
    const root: Split = { kind: "split", id: `s${s}`, dir: "row", children: h === "left" ? [side, target] : [target, side], sizes: [0.5, 0.5] };
    return { root, focused: pane.id };
  }
  if (zone === "center") {
    const root = mapNode(layout.root, (n) => (n.id === targetId ? pane : n));
    return { root, focused: pane.id };
  }
  if (leaves(layout.root).length >= MAX_PANES) return layout;
  const dir: Dir = zone === "left" || zone === "right" ? "row" : "column";
  const before = zone === "left" || zone === "top";
  const parent = parentOf(layout.root, targetId);
  const even = parent?.dir === dir && parent.sizes.every((s) => Math.abs(s - parent.sizes[0]!) < 0.005);
  const sid = nextId(layout, "s");
  const root = mapNode(layout.root, (n) => {
    if (n.id !== targetId) return n;
    const split: Split = { kind: "split", id: sid, dir, children: before ? [pane, n] : [n, pane], sizes: [0.5, 0.5] };
    return split;
  });
  // mapNode normalizes the parent: a split inside a split of the same
  // direction flattens, so three side by side are one row of three.
  const next: Layout = { root, focused: pane.id };
  if (!even) return next;
  const n = parent.children.length + 1;
  return setSizes(next, parent.id, Array.from({ length: n }, () => 1 / n));
}

/**
 * Whether `next` keeps every pane it made smaller at or above the minimum, in
 * a host of `w` × `h` px. A pane the change did not shrink passes even when
 * it is already under (the window got smaller since).
 */
export function fits(before: Layout, next: Layout, w: number, h: number): boolean {
  const was = geometry(before.root).panes;
  for (const [id, r] of geometry(next.root).panes) {
    const old = was.get(id);
    if (r.w * w < MIN_PANE_W - 0.5 && (!old || r.w < old.w - 1e-6)) return false;
    if (r.h * h < MIN_PANE_H - 0.5 && (!old || r.h < old.h - 1e-6)) return false;
  }
  return true;
}

/** `insert` on an edge, kept only if it fits a `w` × `h` px host; otherwise the layout unchanged. */
export function splitAt(layout: Layout, targetId: string, zone: Exclude<Zone, "center">, pane: Pane, w: number, h: number): Layout {
  const next = insert(layout, targetId, zone, pane);
  return next !== layout && fits(layout, next, w, h) ? next : layout;
}

/**
 * The route asked for a workspace: focus its pane if one shows it, else load
 * it into the focused pane, else open the first pane. A tab's pane is never
 * taken: the chat goes to the pane focused last that holds no tab, and with
 * only tabs on screen it opens beside the focused one.
 */
export function show(layout: Layout, workspaceId: string): Layout {
  const open = paneOf(layout, workspaceId);
  if (open) return focus(layout, open.id);
  const all = leaves(layout.root);
  const focusedPane = findPane(layout, layout.focused);
  const target = [focusedPane, ...(layout.recent ?? []).map((id) => findPane(layout, id)), ...all].find((p) => p && !p.tab) ?? null;
  if (!target) {
    const pane = newPane(layout, workspaceId);
    const beside = focusedPane ?? all[0];
    if (!beside) return { root: pane, focused: pane.id };
    // Nine tabs already: the focused one gives its place (it goes back to its panel).
    const next = insert(layout, beside.id, "left", pane);
    return next === layout ? insert(layout, beside.id, "center", pane) : next;
  }
  return { ...updatePane(layout, target.id, { workspaceId }), focused: target.id };
}

/**
 * A chat the user just started. It never takes the place of another chat in a split, nor squeezes in beside them:
 * an empty pane takes it (the focused one first); one pane on screen, or none, loads it there, as opening any chat
 * does. A split with every pane in use: null, and it gets a tab of its own.
 */
export function place(layout: Layout, workspaceId: string): Layout | null {
  if (paneOf(layout, workspaceId)) return show(layout, workspaceId);
  const all = leaves(layout.root);
  const empty = [findPane(layout, layout.focused), ...all].find((p) => p && isEmptyPane(p));
  if (empty) return { ...updatePane(layout, empty.id, { workspaceId }), focused: empty.id };
  return all.length > 1 ? null : show(layout, workspaceId);
}

/** Closes a pane. Closing the focused one goes back to the pane focused before it (else its neighbour). */
export function close(layout: Layout, id: string): Layout {
  const order = leaves(layout.root);
  const at = order.findIndex((p) => p.id === id);
  if (at < 0 || !layout.root) return layout;
  const root = mapNode(layout.root, (n) => (n.id === id ? null : n));
  const rest = order.filter((p) => p.id !== id);
  const back = layout.recent?.find((r) => r !== id && rest.some((p) => p.id === r));
  const focused = layout.focused === id ? (back ?? rest[Math.max(0, at - 1)]?.id ?? null) : layout.focused;
  return { root, focused, recent: (layout.recent ?? []).filter((r) => r !== id && r !== focused) };
}

/**
 * What every change to a tab's layout passes through: a focus change remembers the pane it left (`recent`), and
 * zoom ends when focus moves or a pane comes or goes, so a zoomed pane is always the focused one.
 */
export function settle(prev: Layout, next: Layout): Layout {
  if (next === prev) return next;
  const ids = new Set(leaves(next.root).map((p) => p.id));
  const moved = next.focused !== prev.focused;
  const panesChanged = ids.size !== leaves(prev.root).length || leaves(prev.root).some((p) => !ids.has(p.id));
  const base = moved && prev.focused ? [prev.focused, ...(next.recent ?? prev.recent ?? [])] : (next.recent ?? prev.recent ?? []);
  const recent = [...new Set(base)].filter((r) => r !== next.focused && ids.has(r)).slice(0, MAX_PANES);
  const zoomed = !!next.zoomed && !moved && !panesChanged && ids.size > 1;
  return { root: next.root, focused: next.focused, ...(zoomed ? { zoomed } : {}), ...(recent.length ? { recent } : {}) };
}

/** Zoom on or off: the focused pane alone fills the tab. A lone pane has nothing to zoom over. */
export function toggleZoom(layout: Layout): Layout {
  if (leaves(layout.root).length < 2 || !layout.focused) return layout;
  return { ...layout, zoomed: !layout.zoomed };
}

/** Every split in equal shares, or only `splitId` (a divider's double-click). */
export function equalize(layout: Layout, splitId?: string): Layout {
  const even = (n: Node): Node => {
    if (n.kind === "pane") return n;
    const children = n.children.map(even);
    const sizes = splitId === undefined || n.id === splitId ? n.children.map(() => 1 / n.children.length) : n.sizes;
    return { ...n, children, sizes };
  };
  return layout.root ? { ...layout, root: even(layout.root) } : layout;
}

/** Moves a mounted pane (keeps its id, so it stays mounted). Centre swaps the two. */
export function move(layout: Layout, id: string, targetId: string, zone: Zone): Layout {
  const pane = findPane(layout, id);
  const target = findPane(layout, targetId);
  if (!pane || !target || id === targetId || !layout.root) return layout;
  if (zone === "center") {
    const root = mapNode(layout.root, (n) => (n.id === id ? target : n.id === targetId ? pane : n));
    return { root, focused: id };
  }
  const without = close(layout, id);
  return insert(without, targetId, zone, pane);
}

export function setSizes(layout: Layout, splitId: string, sizes: ReadonlyArray<number>): Layout {
  if (!layout.root) return layout;
  const root = mapNode(layout.root, (n) => (n.id === splitId && n.kind === "split" ? { ...n, sizes } : n));
  return { ...layout, root };
}

// ----------------------------------------------------------------- geometry

export interface Divider {
  readonly splitId: string;
  /** Between child `index` and `index + 1`. */
  readonly index: number;
  readonly dir: Dir;
  /** The split's own box, in fractions of the host. */
  readonly box: Rect;
  /** Where the line sits along the split's axis, as a fraction of the host. */
  readonly at: number;
}

export interface Geometry {
  readonly panes: Map<string, Rect>;
  readonly dividers: Divider[];
}

export function geometry(root: Node | null): Geometry {
  const panes = new Map<string, Rect>();
  const dividers: Divider[] = [];
  const walk = (n: Node, box: Rect) => {
    if (n.kind === "pane") {
      panes.set(n.id, box);
      return;
    }
    let offset = 0;
    n.children.forEach((child, i) => {
      const share = n.sizes[i]!;
      const r: Rect =
        n.dir === "row"
          ? { x: box.x + offset * box.w, y: box.y, w: share * box.w, h: box.h }
          : { x: box.x, y: box.y + offset * box.h, w: box.w, h: share * box.h };
      walk(child, r);
      offset += share;
      if (i < n.children.length - 1) {
        dividers.push({ splitId: n.id, index: i, dir: n.dir, box, at: n.dir === "row" ? box.x + offset * box.w : box.y + offset * box.h });
      }
    });
  };
  if (root) walk(root, { x: 0, y: 0, w: 1, h: 1 });
  return { panes, dividers };
}

/** The smallest a node can be along an axis, in px. */
export function minSize(node: Node, axis: "w" | "h"): number {
  if (node.kind === "pane") return axis === "w" ? MIN_PANE_W : MIN_PANE_H;
  const along = (node.dir === "row") === (axis === "w");
  const mins = node.children.map((c) => minSize(c, axis));
  return along ? mins.reduce((a, b) => a + b, 0) : Math.max(...mins);
}

/**
 * Moves the line between child `index` and `index + 1` of `split` to
 * `fraction` (of the split's own length), keeping both neighbours at or above
 * their minimum. `lengthPx` is the split's length along its axis.
 */
export function resizeAt(split: Split, index: number, fraction: number, lengthPx: number): number[] {
  const sizes = [...split.sizes];
  const start = sizes.slice(0, index).reduce((a, b) => a + b, 0);
  const pair = sizes[index]! + sizes[index + 1]!;
  const axis = split.dir === "row" ? "w" : "h";
  const minA = minSize(split.children[index]!, axis) / lengthPx;
  const minB = minSize(split.children[index + 1]!, axis) / lengthPx;
  const lo = start + Math.min(minA, pair / 2);
  const hi = start + pair - Math.min(minB, pair / 2);
  const at = Math.min(hi, Math.max(lo, fraction));
  sizes[index] = at - start;
  sizes[index + 1] = pair - (at - start);
  return sizes;
}

export function findSplit(node: Node | null, id: string): Split | null {
  if (!node || node.kind === "pane") return null;
  if (node.id === id) return node;
  for (const c of node.children) {
    const s = findSplit(c, id);
    if (s) return s;
  }
  return null;
}

/** How deep an edge's zone reaches into its pane, as a share of the pane. */
const EDGE_BAND = 0.3;
/** A corner's zone: a square this many px a side at most (a share of the edge band on a small pane). */
export const CORNER_PX = 128;
/** The zone under the pointer holds it this many px past its line, so a hand resting on a line never flickers. */
export const STICK_PX = 8;

/**
 * Which drop zone a point is in. `rect` is the pane's box in px. A corner wins
 * inside a square at most `CORNER_PX` a side: a fixed size, as easy to hit on
 * a wide pane as on a small one, and never more of the edge than it needs.
 * Elsewhere the nearest edge wins inside a band of 30% of the pane; the
 * middle is "center". `current`, the zone the pointer was in, holds it
 * `STICK_PX` further. A zone `canSplit` refuses (the layout is full, or a pane
 * would end up under its minimum) gives way: a corner to its edges, an edge
 * to "center".
 */
export function zoneAt(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  canSplit: (zone: Exclude<Zone, "center">) => boolean,
  current: Zone | null = null,
): Zone {
  const d: Record<Edge, number> = { left: x - rect.left, right: rect.left + rect.width - x, top: y - rect.top, bottom: rect.top + rect.height - y };
  const hold = (zone: Zone) => (zone === current ? STICK_PX : 0);
  const cw = Math.min(rect.width * EDGE_BAND, CORNER_PX);
  const ch = Math.min(rect.height * EDGE_BAND, CORNER_PX);
  // A corner is held as the others are; from any other zone it is entered STICK_PX deep, so the edge the pointer
  // came along holds its line too (corners are tried before edges).
  const corner = (c: Corner) => (c === current ? STICK_PX : current ? -STICK_PX : 0);
  // The one it is in first: held, it may overlap a neighbour's square on a small pane.
  const corners = current && isCorner(current) ? [current, ...CORNERS.filter((c) => c !== current)] : CORNERS;
  for (const c of corners) {
    const [v, h] = cornerEdges(c);
    if (d[h] < cw + corner(c) && d[v] < ch + corner(c) && canSplit(c)) return c;
  }
  // Leaving the middle takes STICK_PX more as well.
  const off = current === "center" ? STICK_PX : 0;
  let best: Zone = "center";
  let bestD = Infinity;
  for (const edge of EDGES) {
    const length = edge === "left" || edge === "right" ? rect.width : rect.height;
    const share = (d[edge] - hold(edge) + off) / length;
    if (share < EDGE_BAND && share < bestD && canSplit(edge)) {
      best = edge;
      bestD = share;
    }
  }
  return best;
}

/** Next or previous pane in reading order, wrapping; with none focused, the first or the last. */
export function cycle(layout: Layout, step: 1 | -1): string | null {
  const order = leaves(layout.root);
  if (order.length === 0) return null;
  const at = order.findIndex((p) => p.id === layout.focused);
  if (at < 0) return order[step === 1 ? 0 : order.length - 1]!.id;
  return order[(at + step + order.length) % order.length]!.id;
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * The pane beside the focused one in `dir`: it shares that edge and overlaps it across. Several do: the one focused
 * most recently (so right then left comes back), then the widest overlap. At the window's edge: null.
 */
export function neighbor(layout: Layout, dir: Direction): string | null {
  const g = geometry(layout.root).panes;
  const from = layout.focused ? g.get(layout.focused) : undefined;
  if (!from) return null;
  const eps = 1e-6;
  const across = dir === "left" || dir === "right";
  const rank = (id: string) => {
    const i = layout.recent?.indexOf(id) ?? -1;
    return i < 0 ? Infinity : i;
  };
  let best: { id: string; rank: number; overlap: number } | null = null;
  for (const [id, r] of g) {
    if (id === layout.focused) continue;
    const touches =
      dir === "left" ? Math.abs(r.x + r.w - from.x) < eps : dir === "right" ? Math.abs(from.x + from.w - r.x) < eps : dir === "up" ? Math.abs(r.y + r.h - from.y) < eps : Math.abs(from.y + from.h - r.y) < eps;
    const overlap = across ? Math.min(r.y + r.h, from.y + from.h) - Math.max(r.y, from.y) : Math.min(r.x + r.w, from.x + from.w) - Math.max(r.x, from.x);
    if (!touches || overlap <= eps) continue;
    const c = { id, rank: rank(id), overlap };
    if (!best || c.rank < best.rank || (c.rank === best.rank && c.overlap > best.overlap + eps)) best = c;
  }
  return best?.id ?? null;
}

/**
 * Whether the window has grown too small for the split: some pane is well under its minimum (a layout made on a
 * bigger screen, or the window shrunk since). The focused pane then fills the tab until there is room again.
 */
export function squeezed(layout: Layout, w: number, h: number): boolean {
  for (const r of geometry(layout.root).panes.values()) if (r.w * w < MIN_PANE_W * 0.75 || r.h * h < MIN_PANE_H * 0.75) return true;
  return false;
}

// -------------------------------------------------------------- persistence

function parseNode(v: unknown, depth: number, ids: Set<string>): Node | null {
  if (!v || typeof v !== "object" || depth > 8) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || ids.has(o.id)) return null;
  ids.add(o.id);
  if (o.kind === "pane" && /^p\d+$/.test(o.id)) {
    const t = o.tab as Record<string, unknown> | null | undefined;
    if (t && typeof t === "object" && typeof t.workspaceId === "string" && typeof t.id === "string") return { kind: "pane", id: o.id, workspaceId: null, tab: { workspaceId: t.workspaceId, id: t.id } };
    return { kind: "pane", id: o.id, workspaceId: typeof o.workspaceId === "string" ? o.workspaceId : null };
  }
  if (o.kind === "split" && /^s\d+$/.test(o.id) && (o.dir === "row" || o.dir === "column") && Array.isArray(o.children) && Array.isArray(o.sizes)) {
    const children = o.children.map((c) => parseNode(c, depth + 1, ids));
    const sizes = o.sizes.map(Number);
    if (children.some((c) => c === null) || sizes.length !== children.length || sizes.some((s) => !(s > 0))) return null;
    const total = sizes.reduce((a, b) => a + b, 0);
    return normalize({ kind: "split", id: o.id, dir: o.dir, children: children as Node[], sizes: sizes.map((s) => s / total) });
  }
  return null;
}

/** Reads a stored layout; anything malformed, duplicated or over the cap is an empty layout. */
export function parse(json: string | null): Layout {
  if (!json) return EMPTY;
  try {
    return fromJSON(JSON.parse(json));
  } catch {
    return EMPTY;
  }
}

/** `parse` for a layout already read from JSON (one tab's, in the window's stored tabs). */
export function fromJSON(value: unknown): Layout {
  if (!value || typeof value !== "object") return EMPTY;
  const o = value as { root?: unknown; focused?: unknown; zoomed?: unknown; recent?: unknown };
  const root = parseNode(o.root, 0, new Set());
  const all = leaves(root);
  if (!root || all.length > MAX_PANES) return EMPTY;
  // A chat or a tab twice in one layout (a damaged copy): the second pane goes.
  const seen = new Set<string>();
  let layout: Layout = { root, focused: typeof o.focused === "string" && all.some((p) => p.id === o.focused) ? o.focused : all[0]!.id };
  for (const p of all) {
    const key = paneKey(p);
    if (key && seen.has(key)) layout = close(layout, p.id);
    else if (key) seen.add(key);
  }
  const recent = Array.isArray(o.recent) ? o.recent.filter((r): r is string => typeof r === "string") : [];
  return settle(layout, { ...layout, zoomed: o.zoomed === true, recent });
}

/** What a pane shows, as one string (a chat's id, or a tab's workspace and id); null for an empty pane. One of each per window. */
export function paneKey(p: Pane): string | null {
  return p.tab ? tabKey(p.tab) : p.workspaceId;
}

export const tabKey = (ref: TabRef): string => `tab\n${ref.workspaceId}\n${ref.id}`;

export function serialize(layout: Layout): string {
  return JSON.stringify(layout);
}
