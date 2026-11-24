// Drag a workspace (a sidebar row or a pane header) onto the main area to
// split it, or a side-panel tab out of its strip to give it a pane of its own
// (or into another panel). Pointer events with capture, no HTML5 drag images. Pointer moves
// only store the position; one requestAnimationFrame writes the floating
// preview's transform and hit-tests drop targets against rects measured once
// (again only after a scroll or resize). React re-renders when the target
// changes, never per move.

import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { isHosted } from "../panels/store.ts";
import { announce, panes } from "./store.ts";
import { close, findPane, fits, geometry, insert, isCorner, leaves, move, newPane, newTabPane, paneOf, resolveZone, zoneAt, type Layout, type TabRef, type Zone } from "./tree.ts";

export interface DragPayload {
  readonly workspaceId: string;
  readonly title: string;
  /** One mono line under the title: repo and branch. */
  readonly meta: string;
  /** One grey line: engine and state. */
  readonly detail: string;
  /** Set when a pane header is dragged: the drop moves that pane. */
  readonly fromPaneId: string | null;
  /**
   * A side-panel tab, from its panel's strip or (with `fromPaneId`) a pane of its own: it drops on panes and panels,
   * never into a message, a pin or a Chief. `workspaceId` is then the tab's workspace.
   */
  readonly tab?: TabRef;
  /**
   * A group of chats (the sidebar by topic), dragged by its heading: it drops only where the sidebar arranges
   * (`arrange`), never on a pane, a message or a Chief. `workspaceId` is then empty and `title` the topic.
   */
  readonly topic?: string;
}

/** Where a drop lands among the sidebar's arranged rows: above one, below it, or into its group. */
export type ArrangePlace = "before" | "after" | "into";

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type DropTarget =
  | {
      readonly kind: "pane";
      readonly paneId: string;
      /** Where the pointer is (a corner held as one, so it sticks); `lands` is what the drop does there (tree.resolveZone). */
      readonly zone: Zone;
      readonly lands: Zone;
      readonly box: Box;
      readonly open: boolean;
    }
  | { readonly kind: "pin"; readonly box: Box; readonly onDrop: (payload: DragPayload) => void }
  | { readonly kind: "strip"; readonly box: Box; readonly onDrop: (payload: DragPayload) => void }
  | { readonly kind: "main"; readonly box: Box }
  | { readonly kind: "composer"; readonly id: string; readonly box: Box; readonly onDrop: (payload: DragPayload) => void; readonly label?: string }
  | { readonly kind: "chief"; readonly id: string; readonly name: string; readonly box: Box; readonly onDrop: (payload: DragPayload) => void }
  | { readonly kind: "panel"; readonly label: string; readonly box: Box; readonly onDrop: (payload: DragPayload) => void }
  | { readonly kind: "arrange"; readonly key: string; readonly place: ArrangePlace; readonly box: Box; readonly onDrop: (payload: DragPayload, place: ArrangePlace) => void };

export interface DragState {
  readonly payload: DragPayload | null;
  readonly target: DropTarget | null;
}

type TargetInfo =
  | { readonly kind: "pane"; readonly paneId: string }
  /** The sidebar's Pinned section: pins the dropped chat on the runtime. */
  | { readonly kind: "pin"; readonly onDrop: (payload: DragPayload) => void }
  /** The tab strip: the chat opens in a tab of its own; a pane dragged by its header leaves its split for one. */
  | { readonly kind: "strip"; readonly onDrop: (payload: DragPayload) => void }
  /** A message box: a dropped chat becomes a reference in it. `workspaceId` is the thread it writes to (never referenced in itself). */
  | {
      readonly kind: "composer";
      readonly id: string;
      readonly workspaceId: string | null;
      readonly onDrop: (payload: DragPayload) => void;
      /** What a drop does there, when it is not a reference (the Chief's box: "Add to Ugg"). */
      readonly label?: string;
    }
  /** A Chief in the sidebar: the dropped chat joins its board (chief.attach). */
  | { readonly kind: "chief"; readonly id: string; readonly name: string; readonly onDrop: (payload: DragPayload) => void }
  /**
   * A side panel's tab strip (`workspaceId`'s panel): a side-panel tab joins it. `accepts` names what a drop does there;
   * null passes the drop to the pane underneath, except for a tab over its own strip, which drops nowhere.
   */
  | { readonly kind: "panel"; readonly workspaceId: string; readonly accepts: (payload: DragPayload) => string | null; readonly onDrop: (payload: DragPayload) => void }
  /**
   * A row of the sidebar by topic (`key`: "c:<chat id>" or "g:<topic>"): a drop lands above or below it, or, where it
   * takes one (`into`: a group's heading, a loose chat), into it, its middle half. A group lands only above or below,
   * never on its own heading or chats (`group`: the group a row is in).
   */
  | { readonly kind: "arrange"; readonly key: string; readonly into: boolean; readonly group?: string; readonly onDrop: (payload: DragPayload, place: ArrangePlace) => void };

const IDLE: DragState = { payload: null, target: null };
const THRESHOLD = 4;

const targets = new Map<HTMLElement, TargetInfo>();
let state: DragState = IDLE;
const listeners = new Set<() => void>();
let floating: HTMLElement | null = null;

let pending: { x0: number; y0: number; pointerId: number; source: HTMLElement; payload: DragPayload } | null = null;
let active = false;
let x = 0;
let y = 0;
let raf = 0;
let dirty = true;
let rects: Array<{ info: TargetInfo | { kind: "main" }; box: DOMRect }> = [];
/** The split view's box (PaneHost), measured with the rects; null off the w/ route. */
let host: DOMRect | null = null;

function set(next: DragState) {
  if (next.payload !== state.payload) dirty = true;
  state = next;
  listeners.forEach((l) => l());
}

export function useDrag(): DragState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** A pane, the Pinned section, the tab strip or a composer takes drops while mounted. */
export function registerDropTarget(el: HTMLElement, info: TargetInfo): () => void {
  targets.set(el, info);
  dirty = true;
  return () => {
    targets.delete(el);
    dirty = true;
  };
}

/** The floating preview: its transform is written here, outside React. */
export function setFloating(el: HTMLElement | null): void {
  floating = el;
  if (el) el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/**
 * Takes over a drag already under way somewhere else (a side panel's tab, reordering in its strip, pulled out of it):
 * it is a drag from here on. `source` holds the pointer.
 */
export function liftDrag(e: { readonly clientX: number; readonly clientY: number; readonly pointerId: number }, source: HTMLElement, payload: DragPayload): void {
  if (pending) return;
  pending = { x0: e.clientX, y0: e.clientY, pointerId: e.pointerId, source, payload };
  x = e.clientX;
  y = e.clientY;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", cancel);
  activate();
  if (!raf) raf = requestAnimationFrame(frame);
}

/** Call from onPointerDown on a drag source. A click still clicks: the drag starts after 4px. */
export function beginDrag(e: ReactPointerEvent<HTMLElement>, payload: DragPayload): void {
  if (e.button !== 0 || e.pointerType === "touch" || pending) return;
  // No text selection starts from the source while the pointer is down.
  e.preventDefault();
  pending = { x0: e.clientX, y0: e.clientY, pointerId: e.pointerId, source: e.currentTarget, payload };
  x = e.clientX;
  y = e.clientY;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", cancel);
}

function onMove(e: PointerEvent) {
  if (!pending || e.pointerId !== pending.pointerId) return;
  x = e.clientX;
  y = e.clientY;
  if (!active) {
    if (Math.abs(x - pending.x0) + Math.abs(y - pending.y0) < THRESHOLD) return;
    activate();
  }
  if (!raf) raf = requestAnimationFrame(frame);
}

function activate() {
  const p = pending!;
  active = true;
  try {
    p.source.setPointerCapture(p.pointerId);
  } catch {
    // The pointer may already be gone; the window listeners still see it.
  }
  p.source.dataset.dragSource = "";
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", markDirty, { capture: true, passive: true });
  window.addEventListener("resize", markDirty);
  window.addEventListener("blur", cancel);
  set({ payload: p.payload, target: null });
  announce(
    p.payload.tab
      ? `Dragging ${p.payload.title}. Drop on a pane edge for a pane of its own, on a side panel's tabs to move it there, on the tabs for a tab of its own. Escape cancels.`
      : `Dragging ${p.payload.title}. Drop on a pane edge to split, on its middle to replace it, on the tabs for a tab of its own, on a message box to reference it. Escape cancels.`,
  );
}

function markDirty() {
  dirty = true;
  if (active && !raf) raf = requestAnimationFrame(frame);
}

function measure() {
  // A pane hidden behind a zoomed one (inert) takes no drop.
  rects = [...targets].filter(([el]) => !el.closest("[inert]")).map(([el, info]) => ({ info, box: el.getBoundingClientRect() }));
  host = document.querySelector("[data-pane-host]")?.getBoundingClientRect() ?? null;
  // No panes on screen (Inbox, Runs): the whole main area opens the workspace.
  if (![...targets.values()].some((t) => t.kind === "pane")) {
    const main = document.querySelector("main");
    if (main) rects.push({ info: { kind: "main" }, box: main.getBoundingClientRect() });
  }
  // A composer and a side panel's strip sit inside their pane: they are tried first, so each wins its own rect.
  const inner = (kind: string) => Number(kind === "composer" || kind === "panel");
  rects.sort((a, b) => inner(b.info.kind) - inner(a.info.kind));
  dirty = false;
}

function hit(): DropTarget | null {
  const payload = state.payload;
  if (!payload) return null;
  for (const { info, box } of rects) {
    if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) continue;
    // A group drops only where the sidebar arranges.
    if (payload.topic !== undefined && info.kind !== "arrange") continue;
    if (info.kind === "arrange") {
      if (payload.fromPaneId || payload.tab) continue;
      if (info.key === (payload.topic !== undefined ? `g:${payload.topic}` : `c:${payload.workspaceId}`)) return null;
      if (payload.topic !== undefined && info.group === payload.topic) return null;
      const at = (y - box.top) / box.height;
      const place: ArrangePlace = info.into && payload.topic === undefined ? (at < 0.25 ? "before" : at > 0.75 ? "after" : "into") : at < 0.5 ? "before" : "after";
      return { kind: "arrange", key: info.key, place, box, onDrop: info.onDrop };
    }
    if (info.kind === "panel") {
      // A chat over a panel, or a tab another panel can't take (a terminal over another chat's): the pane underneath
      // decides. A tab back over its own strip goes nowhere, so letting go where it came from changes nothing.
      if (!payload.tab) continue;
      const label = info.accepts(payload);
      if (label) return { kind: "panel", label, box, onDrop: info.onDrop };
      if (payload.tab.workspaceId === info.workspaceId && !payload.fromPaneId) return null;
      continue;
    }
    if (info.kind === "composer") {
      // Moving a pane or a side-panel tab, or a thread over its own box: the pane underneath decides.
      if (payload.fromPaneId || payload.tab || payload.workspaceId === info.workspaceId) continue;
      return { kind: "composer", id: info.id, box, onDrop: info.onDrop, ...(info.label ? { label: info.label } : {}) };
    }
    if (info.kind === "chief") return payload.fromPaneId || payload.tab ? null : { kind: "chief", id: info.id, name: info.name, box, onDrop: info.onDrop };
    if (info.kind === "pin") return payload.fromPaneId || payload.tab ? null : { kind: "pin", box, onDrop: info.onDrop };
    if (info.kind === "strip") return { kind: "strip", box, onDrop: info.onDrop };
    // A page's main area takes a tab only when the split view behind it has room for it (panes.hostTab).
    if (info.kind === "main") return payload.tab && !panes.canHostTab(payload.tab) ? null : { kind: "main", box };
    if (info.paneId === payload.fromPaneId) return null;
    const layout = panes.get();
    const open = payload.fromPaneId || payload.tab ? null : paneOf(layout, payload.workspaceId);
    if (open) {
      // Already on screen: the drop goes to that pane, wherever the pointer is.
      const at = rects.find((r) => r.info.kind === "pane" && r.info.paneId === open.id);
      return at ? { kind: "pane", paneId: open.id, zone: "center", lands: "center", box: at.box, open: true } : null;
    }
    // Each edge is tried as the real change (an insert, or a move for a pane
    // header): an edge that would crush a pane is refused, and the outline is
    // exactly where the pane lands.
    const pane = payload.fromPaneId ? findPane(layout, payload.fromPaneId) : payload.tab ? newTabPane(layout, payload.tab) : newPane(layout, payload.workspaceId);
    if (!pane) return null;
    const result = (zone: Exclude<Zone, "center">): Layout | null => {
      const next = payload.fromPaneId ? move(layout, pane.id, info.paneId, zone) : insert(layout, info.paneId, zone, pane);
      return next !== layout && host && fits(layout, next, host.width, host.height) ? next : null;
    };
    // The zone it is in now holds a few px past its line (tree.STICK_PX): a hand at rest on a line never flickers.
    const was = state.target?.kind === "pane" && state.target.paneId === info.paneId ? state.target.zone : null;
    const zone = zoneAt(box, x, y, (z) => result(z) !== null, was);
    if (zone === "center" || !host) return { kind: "pane", paneId: info.paneId, zone: "center", lands: "center", box, open: false };
    const r = geometry(result(zone)!.root).panes.get(pane.id)!;
    const landing = { left: host.left + r.x * host.width, top: host.top + r.y * host.height, width: r.w * host.width, height: r.h * host.height };
    // What the zone does there; a moved pane leaves its place first (tree.move).
    const lands = resolveZone(payload.fromPaneId ? close(layout, pane.id) : layout, info.paneId, zone);
    return { kind: "pane", paneId: info.paneId, zone, lands, box: landing, open: false };
  }
  return null;
}

function same(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "pane" && b.kind === "pane") return a.paneId === b.paneId && a.zone === b.zone && a.box.width === b.box.width && a.box.left === b.box.left && a.box.top === b.box.top;
  if (a.kind === "arrange" && b.kind === "arrange") return a.key === b.key && a.place === b.place;
  return a.box.left === b.box.left && a.box.top === b.box.top;
}

let flip = "";
let hint = "";

function frame() {
  raf = 0;
  if (!active) return;
  if (floating) {
    floating.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    // Near the right or bottom edge the preview hangs on the other side of the pointer.
    const f = `${x > window.innerWidth - 280 ? "x" : ""}${y > window.innerHeight - 140 ? "y" : ""}`;
    if (f !== flip) floating.dataset.flip = flip = f;
  }
  if (dirty) measure();
  const target = hit();
  if (!same(target, state.target)) set({ ...state, target });
  // The region's hint moves to the half the pointer is not in, so it never sits under the pill.
  const layer = floating?.parentElement;
  const h = target && x > target.box.left + target.box.width / 2 ? "left" : "right";
  if (layer && h !== hint) layer.dataset.hint = hint = h;
}

function onUp(e: PointerEvent) {
  if (!pending || e.pointerId !== pending.pointerId) return;
  if (active) {
    x = e.clientX;
    y = e.clientY;
    if (dirty) measure();
    drop(pending.payload, hit());
    swallowClick();
  }
  end();
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  announce("Drag cancelled.");
  cancel();
}

function cancel() {
  if (active) swallowClick();
  end();
}

function end() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", cancel);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", markDirty, true);
  window.removeEventListener("resize", markDirty);
  window.removeEventListener("blur", cancel);
  if (pending) {
    delete pending.source.dataset.dragSource;
    try {
      pending.source.releasePointerCapture(pending.pointerId);
    } catch {
      // Already released.
    }
  }
  pending = null;
  active = false;
  flip = "";
  hint = "";
  rects = [];
  host = null;
  if (state !== IDLE) set(IDLE);
}

/** The pointerup after a drag would click the source row; eat that one click. */
function swallowClick() {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, true), 0);
}

const SIDE: Record<Zone, string> = {
  left: "on the left",
  right: "on the right",
  top: "above",
  bottom: "below",
  "top-left": "in the top-left corner",
  "top-right": "in the top-right corner",
  "bottom-left": "in the bottom-left corner",
  "bottom-right": "in the bottom-right corner",
  center: "here",
};

function drop(payload: DragPayload, target: DropTarget | null) {
  if (!target) return announce("Dropped nowhere; nothing changed.");
  if (target.kind === "arrange") {
    target.onDrop(payload, target.place);
    return announce(`Moved ${payload.title}.`);
  }
  if (target.kind === "pin") {
    target.onDrop(payload);
    return announce(`Pinned ${payload.title}.`);
  }
  if (target.kind === "composer") {
    target.onDrop(payload);
    return announce(target.label ? `${target.label}: ${payload.title}.` : `Referenced ${payload.title} in the message.`);
  }
  if (target.kind === "chief") {
    target.onDrop(payload);
    return announce(`Added ${payload.title} to ${target.name}'s board.`);
  }
  if (target.kind === "strip") {
    target.onDrop(payload);
    return announce(`Opened ${payload.title} in a tab of its own.`);
  }
  if (target.kind === "panel") {
    target.onDrop(payload);
    return announce(`${target.label}: ${payload.title}.`);
  }
  if (target.kind === "main") {
    // No split view on screen (a page): a tab joins the one behind it, which comes back.
    if (payload.tab) {
      const to = panes.hostTab(payload.tab);
      if (to !== null) location.replace(`#${to}`);
      // Refused (no room, in a browser): hostTab said so.
      return isHosted(payload.tab.workspaceId, payload.tab.id) ? announce(`Opened ${payload.title} in split view.`) : undefined;
    }
    window.location.hash = `#/w/${encodeURIComponent(payload.workspaceId)}`;
    return announce(`Opened ${payload.title}.`);
  }
  if (target.open) {
    panes.focus(target.paneId);
    return announce(`${payload.title} is already open; focused its pane.`);
  }
  const before = panes.get();
  const replaced = findPane(before, target.paneId);
  if (payload.tab) panes.dropTab(payload.tab, payload.fromPaneId, target.paneId, target.zone);
  else panes.drop(payload.workspaceId, payload.fromPaneId, target.paneId, target.zone);
  const count = leaves(panes.get().root).length;
  // A quarter of the view leaves an empty pane beside it, for the next chat.
  const rest = isCorner(target.lands) ? ` The pane ${target.lands.startsWith("top") ? "below" : "above"} it waits for a chat.` : "";
  if (payload.fromPaneId) announce(target.zone === "center" ? `Swapped ${payload.title} with the other pane.` : `Moved ${payload.title} ${SIDE[target.lands]}.${rest}`);
  else if (target.zone === "center") announce(`Opened ${payload.title} in place of ${replaced?.workspaceId ? "the pane's session" : replaced?.tab ? "the pane's tab" : "the empty pane"}.`);
  else announce(`Opened ${payload.title} in split view ${SIDE[target.lands]}. ${count} panes.${rest}`);
}
