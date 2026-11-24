import { cn } from "@caveman-app/ui/lib/cn";
import { Activity, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { PaneFrame } from "../components/pane/PaneFrame.tsx";
import { matchesChord } from "../panels/chrome.tsx";
import { chord } from "../state/keybindings.ts";
import { useRuntimeGetter } from "../state/runtime.tsx";
import { useTabNav } from "../shell/tab-nav.ts";
import { registerDropTarget } from "./drag.ts";
import { PaneSlotContext, type PaneSlot } from "./slot.ts";
import { announce, chatPath, KEEP_TABS, panes, splitPath, useLanded, useLayout, useTabs, windowTabs, type Tab } from "./store.ts";
import { byCreation, cycle, findPane, findSplit, geometry, leaves, MAX_PANES, newPane, paneOf, resizeAt, setSizes, splitAt, squeezed, type Direction, type Divider, type Layout, type Pane, type Rect } from "./tree.ts";
import "./panes.css";

/**
 * The `w/:workspaceId` route: the split view of the tab in front. The URL names
 * the focused pane's workspace; opening one from the sidebar loads it into the
 * focused pane. Panes render as siblings in creation order, absolutely placed,
 * so a split, move or resize never remounts a session or its terminal. The tabs
 * used last stay rendered, hidden (React Activity), so going back to one only
 * shows it again; they keep one order whatever the strip's, so reordering tabs
 * never moves a pane in the DOM (a side panel's browser would reload).
 */
export function PaneHost() {
  const { workspaceId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const go = useTabNav();
  // Titles for what it announces, read when it speaks: a push re-renders no pane.
  const runtime = useRuntimeGetter();
  const layout = useLayout();
  const tabs = useTabs();
  const landed = useLanded();
  const host = useRef<HTMLDivElement>(null);
  const titleOf = (p: Pane | null) => (p?.workspaceId ? (runtime().raw.get(p.workspaceId)?.title ?? "a workspace") : p?.tab ? "a side-panel tab" : "the empty pane");

  useLayoutEffect(() => {
    if (workspaceId) panes.show(workspaceId);
  }, [workspaceId, location.key]);

  // The URL follows focus (replace, so focusing panes never floods history). A tab switch has already gone where
  // that tab was; its first render here is never a focus change.
  const focusedWorkspace = findPane(layout, layout.focused)?.workspaceId ?? null;
  const empty = layout.root === null;
  const shownTab = useRef(tabs.active);
  useEffect(() => {
    const switched = shownTab.current !== tabs.active;
    shownTab.current = tabs.active;
    if (switched) return;
    const now = panes.get();
    const ws = findPane(now, now.focused)?.workspaceId;
    // Its last pane closed: the tab goes with it (the only tab left shows the Chief instead).
    if (!now.root) navigate(windowTabs.close((t) => t.id === tabs.active) ?? "/chief", { replace: true });
    else if (ws && ws !== workspaceId) navigate(chatPath(ws), { replace: true });
    // A side-panel tab's pane in focus names no chat: the route says the panes, so no chat's route takes focus back from
    // it (a reload, a link). An empty pane keeps the chat's route while that chat is still here.
    else if (!ws && (findPane(now, now.focused)?.tab || !workspaceId || !paneOf(now, workspaceId))) {
      const to = splitPath(now);
      if (to !== location.pathname) navigate(to, { replace: true });
    }
  }, [focusedWorkspace, empty, workspaceId, tabs.active]);

  // Split right / down, next / previous pane, a pane by direction, zoom, equal sizes, close (Settings > Keyboard; ⌘D,
  // ⌘⇧D, ⌥⌘] / ⌥⌘[, ⌥⌘ and an arrow, ⌥⌘F, ⌥⌘=, ⌥⌘W by default).
  useEffect(() => {
    const focusInto = (id: string, before = "") => {
      const order = leaves(panes.get().root);
      const el = host.current?.querySelector(`[data-tab-layer="${windowTabs.get().active}"] [data-pane-id="${id}"]`);
      // The slot also holds chats it showed before, hidden (PaneFrame's KEEP_VIEWS): focus goes into the one on screen.
      [...(el?.querySelectorAll<HTMLElement>("textarea, [data-pane-autofocus], button") ?? [])].find((c) => c.checkVisibility())?.focus({ preventScroll: true });
      announce(`${before}Pane ${order.findIndex((p) => p.id === id) + 1} of ${order.length}: ${titleOf(findPane(panes.get(), id))}.`);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const down = matchesChord(e, chord("app.splitDown"));
      const step = matchesChord(e, chord("app.nextPane")) ? 1 : matchesChord(e, chord("app.previousPane")) ? -1 : 0;
      const toward = (["left", "right", "up", "down"] as const).find((d) => matchesChord(e, chord(DIRECTION_COMMANDS[d])));
      if (down || matchesChord(e, chord("app.splitRight"))) {
        e.preventDefault();
        const zone = down ? "bottom" : "right";
        if (panes.split(zone)) announce(`Split ${zone === "right" ? "right" : "down"}. Type to start a new chat in the new pane, or pick one to open.`);
        else announce(leaves(panes.get().root).length >= MAX_PANES ? `Split view holds ${MAX_PANES} panes at most.` : "This pane is too small to split that way.");
      } else if (step !== 0) {
        e.preventDefault();
        const id = cycle(panes.get(), step);
        if (id) {
          panes.focus(id);
          focusInto(id);
        }
      } else if (toward) {
        e.preventDefault();
        const id = panes.focusToward(toward);
        if (id) focusInto(id);
        else if (leaves(panes.get().root).length > 1) announce(`No pane ${toward === "up" ? "above" : toward === "down" ? "below" : `to the ${toward}`}.`);
      } else if (matchesChord(e, chord("app.zoomPane"))) {
        e.preventDefault();
        if (leaves(panes.get().root).length < 2) return announce("Zoom fills the tab with one pane of a split; this tab shows one.");
        panes.toggleZoom();
        announce(panes.get().zoomed ? "Pane zoomed to fill the tab." : "All panes back.");
      } else if (matchesChord(e, chord("app.equalizePanes"))) {
        e.preventDefault();
        panes.equalize();
        announce("Every pane the same size.");
      } else if (matchesChord(e, chord("app.closePane"))) {
        e.preventDefault();
        const id = panes.get().focused;
        if (!id) return;
        const title = titleOf(findPane(panes.get(), id));
        const to = panes.close(id);
        if (to !== null) return void (go(to), announce(`Closed ${title} and its tab.`));
        const next = panes.get().focused;
        if (next) focusInto(next, `Closed ${title}. `);
        else announce(`Closed ${title}. No panes left.`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runtime, go]);

  const kept = new Set(tabs.recent.slice(0, KEEP_TABS));
  const shown = tabs.list.filter((t) => kept.has(t.id) && t.layout.root !== null).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return (
    <div ref={host} data-pane-host="" className="relative min-h-0 flex-1">
      {shown.map((t) => (
        <Activity key={t.id} mode={t.id === tabs.active ? "visible" : "hidden"}>
          <TabPanes tab={t} host={host} landed={t.id === tabs.active ? landed : null} />
        </Activity>
      ))}
    </div>
  );
}

/** One tab's split view: its panes and the lines between them. */
function TabPanes({ tab, host, landed }: { tab: Tab; host: React.RefObject<HTMLDivElement | null>; landed: { id: string; n: number } | null }) {
  const layout = tab.layout;
  const slots = useRef(new Map<string, HTMLDivElement>()).current;
  const lines = useRef(new Map<string, HTMLDivElement>()).current;

  /** Writes a layout's geometry straight to the DOM (divider drags, per frame). */
  const apply = (l: Layout) => {
    const g = geometry(l.root);
    for (const [id, r] of g.panes) {
      const el = slots.get(id);
      if (el) Object.assign(el.style, place(r));
    }
    for (const d of g.dividers) {
      const el = lines.get(`${d.splitId}:${d.index}`);
      if (el) Object.assign(el.style, linePlace(d));
    }
  };

  const layer = useRef<HTMLDivElement>(null);
  const size = useSize(layer);
  const g = geometry(layout.root);
  const order = leaves(layout.root).sort(byCreation);
  const multi = order.length > 1;
  // Zoomed, or a window too small for the split: the focused pane alone fills the tab, the others kept mounted behind.
  const squeeze = multi && size !== null && squeezed(layout, size.w, size.h);
  const solo = multi && (layout.zoomed || squeeze) ? layout.focused : null;
  // Whether a pane can split either way: under the cap, and every pane it shrinks keeps its minimum.
  const room = (id: string) => order.length < MAX_PANES && (size === null || (["right", "bottom"] as const).some((z) => splitAt(layout, id, z, newPane(layout, null), size.w, size.h) !== layout));
  return (
    <div ref={layer} data-tab-layer={tab.id} className="absolute inset-0">
      {order.map((p) => (
        <Slot
          key={p.id}
          pane={p}
          rect={solo === null ? g.panes.get(p.id)! : FULL}
          hidden={solo !== null && solo !== p.id}
          zoomed={solo === p.id}
          focused={!multi || layout.focused === p.id}
          canSplit={room(p.id)}
          slot={solo === p.id ? (squeeze ? SQUEEZED[order.length] : ZOOMED[order.length])! : (PLAIN[order.length] ?? PLAIN[1]!)}
          landed={landed?.id === p.id ? landed.n : 0}
          slots={slots}
          index={leaves(layout.root).indexOf(p) + 1}
          count={order.length}
        />
      ))}
      {solo !== null ? null : g.dividers.map((d) => (
        <DividerLine key={`${d.splitId}:${d.index}`} d={d} layout={layout} host={host} lines={lines} apply={apply} />
      ))}
    </div>
  );
}

function Slot({ pane, rect, hidden, zoomed, focused, canSplit, slot, landed, slots, index, count }: { pane: Pane; rect: Rect; hidden: boolean; zoomed: boolean; focused: boolean; canSplit: boolean; slot: PaneSlot; landed: number; slots: Map<string, HTMLDivElement>; index: number; count: number }) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = el.current!;
    slots.set(pane.id, node);
    const off = registerDropTarget(node, { kind: "pane", paneId: pane.id });
    return () => {
      off();
      slots.delete(pane.id);
    };
  }, [pane.id]);
  return (
    <div
      ref={el}
      role="region"
      aria-label={count > 1 ? `Pane ${index} of ${count}${zoomed ? ", zoomed" : ""}` : "Workspace"}
      aria-current={focused ? "true" : undefined}
      aria-hidden={hidden || undefined}
      inert={hidden}
      data-pane-id={pane.id}
      data-zoomed={zoomed || undefined}
      className={cn("pane-slot panel-card absolute overflow-hidden", landed > 0 && "pane-enter", hidden && "invisible")}
      style={place(rect)}
      onPointerDownCapture={() => panes.focus(pane.id)}
      onFocusCapture={() => panes.focus(pane.id)}
    >
      <PaneSlotContext.Provider value={slot}>
        <PaneFrame pane={pane} focused={focused} canSplit={canSplit} />
      </PaneSlotContext.Provider>
      {landed > 0 ? <div key={landed} aria-hidden className="pane-landed pointer-events-none absolute inset-[3px] z-30 rounded-[10px]" /> : null}
    </div>
  );
}

const STEP = 0.02;

function DividerLine({ d, layout, host, lines, apply }: { d: Divider; layout: Layout; host: React.RefObject<HTMLDivElement | null>; lines: Map<string, HTMLDivElement>; apply: (l: Layout) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const key = `${d.splitId}:${d.index}`;
  useLayoutEffect(() => {
    lines.set(key, el.current!);
    return () => void lines.delete(key);
  }, [key]);
  const row = d.dir === "row";

  /** The split, its length in px, and where it starts on screen. */
  const measure = () => {
    const box = host.current!.getBoundingClientRect();
    const split = findSplit(panes.get().root, d.splitId)!;
    const len = row ? d.box.w * box.width : d.box.h * box.height;
    const start = row ? box.left + d.box.x * box.width : box.top + d.box.y * box.height;
    return { split, len, start };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const { split, len, start } = measure();
    const base = panes.get();
    const node = e.currentTarget;
    try {
      node.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone: the listeners below still end the drag.
    }
    node.dataset.active = "";
    document.documentElement.dataset.paneResize = "";
    let pos = row ? e.clientX : e.clientY;
    let sizes = split.sizes;
    let raf = 0;
    const frame = () => {
      raf = 0;
      sizes = resizeAt(split, d.index, (pos - start) / len, len);
      apply(setSizes(base, split.id, sizes));
    };
    const move = (ev: globalThis.PointerEvent) => {
      pos = row ? ev.clientX : ev.clientY;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      delete node.dataset.active;
      delete document.documentElement.dataset.paneResize;
      // One React commit at the end: the frames above never re-render.
      panes.set(setSizes(panes.get(), split.id, sizes));
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const { split, len } = measure();
    const before = split.sizes.slice(0, d.index).reduce((a, b) => a + b, 0);
    const at = before + split.sizes[d.index]!;
    const step = e.shiftKey ? STEP * 5 : STEP;
    const [less, more] = row ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    let to: number;
    if (e.key === less) to = at - step;
    else if (e.key === more) to = at + step;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = 1;
    else return;
    e.preventDefault();
    panes.set(setSizes(panes.get(), split.id, resizeAt(split, d.index, to, len)));
  };

  const split = findSplit(layout.root, d.splitId);
  const value = split ? Math.round((split.sizes.slice(0, d.index + 1).reduce((a, b) => a + b, 0)) * 100) : 50;
  return (
    <div
      ref={el}
      role="separator"
      tabIndex={0}
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={row ? "Resize the panes left and right of this line; double-click for equal sizes" : "Resize the panes above and below this line; double-click for equal sizes"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      // A double-click gives the panes along this line equal shares.
      onDoubleClick={() => panes.equalize(d.splitId)}
      className={cn("pane-divider absolute z-10", row ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize")}
      style={linePlace(d)}
    />
  );
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

// One value per pane count, so a pane's frame re-renders only when its slot changes.
const counts = Array.from({ length: MAX_PANES + 1 }, (_, n) => n);
const PLAIN: ReadonlyArray<PaneSlot> = counts.map((count) => ({ count, solo: null }));
const ZOOMED: ReadonlyArray<PaneSlot> = counts.map((count) => ({ count, solo: "zoomed" }));
const SQUEEZED: ReadonlyArray<PaneSlot> = counts.map((count) => ({ count, solo: "squeezed" }));

const DIRECTION_COMMANDS = { left: "app.focusPaneLeft", right: "app.focusPaneRight", up: "app.focusPaneUp", down: "app.focusPaneDown" } as const satisfies Record<Direction, string>;

/** A tab layer's size in px (the pane host's), kept as the window resizes: whether the split still fits (tree.squeezed). */
function useSize(ref: React.RefObject<HTMLDivElement | null>): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setSize((s) => (s && s.w === width && s.h === height ? s : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Half the gap between two panes: each pane's card stops this far short of a line it shares with another. */
const HALF_GAP = 4;
/** Where a rect's edge sits on the host's: an edge there touches no other pane. */
const EDGE = 1e-6;

function place(r: Rect) {
  const left = r.x > EDGE ? HALF_GAP : 0;
  const top = r.y > EDGE ? HALF_GAP : 0;
  const right = r.x + r.w < 1 - EDGE ? HALF_GAP : 0;
  const bottom = r.y + r.h < 1 - EDGE ? HALF_GAP : 0;
  return {
    left: `calc(${r.x * 100}% + ${left}px)`,
    top: `calc(${r.y * 100}% + ${top}px)`,
    width: `calc(${r.w * 100}% - ${left + right}px)`,
    height: `calc(${r.h * 100}% - ${top + bottom}px)`,
  };
}

/** A divider fills the gap between its panes, so the whole gap drags. */
function linePlace(d: Divider) {
  return d.dir === "row"
    ? { left: `calc(${d.at * 100}% - ${HALF_GAP}px)`, top: `${d.box.y * 100}%`, height: `${d.box.h * 100}%` }
    : { top: `calc(${d.at * 100}% - ${HALF_GAP}px)`, left: `${d.box.x * 100}%`, width: `${d.box.w * 100}%` };
}
