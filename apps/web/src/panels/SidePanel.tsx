// The side panel beside a session: its tabs (drag to reorder, pull one out of
// the strip to give it a pane of its own or move it to another panel,
// middle-click or ⌘W to close, right-click for more) and the `+` launcher in a bar the
// height of the chat's header, so the two read as one nav bar split at the
// panel's edge; a resize edge; the active surface below. The chat's header
// shows and hides it (PanelToggle). Mount one per pane:
//
//   <div data-pane className="relative flex">   // the pane: positioned, a row
//     <ChatColumn className="min-w-0 flex-1" />
//     <SidePanel workspace={workspace} />
//   </div>
//
// Layout , apps/web/src/components/
// RightPanelTabs.tsx, preview/PreviewPanelShell.tsx @ ab3a3cd1): only the
// active surface is mounted, except kinds marked keepAlive (terminals,
// pages), which stay mounted and hidden once visited. Resizing writes the
// width straight to the element and commits it once on release. Expanded,
// and in a narrow pane, the panel covers the pane, its bar standing in for
// the chat's header.

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Add01Icon, ArrowShrink02Icon, Cancel01Icon, PanelRightIcon } from "@caveman-app/ui/icons/huge";
import type { Workspace } from "@caveman-app/session-protocol";
import { Component, memo, Suspense, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { useRuntimeClient } from "../state/runtime.tsx";
import { BarButton, IS_DESKTOP, IS_MAC, isComposing, isTypingTarget, launchChord, matchesChord } from "./chrome.tsx";
import { chord } from "../state/keybindings.ts";
import { LauncherPopover } from "./launcher.tsx";
import { AttentionDot } from "./AttentionDot.tsx";
import { allSurfaces, launcherSurfaces, movable, portable, surfaceDef, tabTitle } from "./registry.ts";
import { activateTab, canMoveTabTo, closeTabs, getPanel, getTabs, moveTab, setMaximized, setPanelOpen, setPanelWidth, toggleSurface, usePanel, type SurfaceParams, type Tab } from "./store.ts";
import { SurfaceHost } from "./SurfaceHost.tsx";
import { useInUse } from "./live/float.ts";
import { LiveDot } from "./live/LiveDot.tsx";
import "./surfaces.tsx";
import { isStaleChunk } from "../lib/stale-chunk.ts";
import { PanelWorkspace, usePanelWorkspace } from "./workspace.ts";
import { useFileRefActions } from "./files/FileChip.tsx";
import { FileMenuItems } from "./files/FileMenu.tsx";
import { isPhone, usePhone } from "../lib/screen.ts";
import { liftDrag, registerDropTarget, type DragPayload } from "../panes/drag.ts";
import { ownsFocus } from "../panes/focus.ts";
import { panes, windowTabs } from "../panes/store.ts";
import { useTabNav } from "../shell/tab-nav.ts";
import { arriveMotion } from "@caveman-app/ui/motion";

const MIN_WIDTH = 280;
/** Room a tab with its name needs; with less a tab for each, the ones not in front fold to their icons. */
const TAB_ROOM = 120;
/** The chat keeps at least this much of the pane. */
const MIN_CHAT = 300;
/** Below this pane width the panel floats over the chat instead of sharing the row. */
export const NARROW_PANE = MIN_WIDTH + MIN_CHAT;
/** Until the person resizes it; a surface can ask for its own (SurfaceDef.defaultWidth). */
const DEFAULT_WIDTH = "clamp(280px, 44%, 820px)";
/** A tab pulled this far up or down, or out past either end of the panel's bar, leaves the strip: a drag to a pane, a panel or the window's tabs. */
const TEAR_PX = 24;

/** What dragging one of a panel's tabs carries (panes/drag.ts). */
export function tabPayload(workspaceId: string, tab: Tab, fromPaneId: string | null, detail = ""): DragPayload {
  return { workspaceId, title: tabTitle(tab), meta: surfaceDef(tab.kind)?.label ?? "", detail, fromPaneId, tab: { workspaceId, id: tab.id } };
}

function paneOf(el: HTMLElement | null): HTMLElement | null {
  return (el?.closest("[data-pane]") as HTMLElement | null) ?? el?.parentElement ?? null;
}

/** After a close or hide, focus lands on the active tab, else the pane's panel switch, unless something else already took it. */
function refocus(host: HTMLElement | null, workspaceId: string) {
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const s = getPanel(workspaceId);
    const target = s.open && s.active ? host?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(s.active)}"]`) : paneOf(host)?.querySelector<HTMLElement>("[data-panel-toggle]");
    target?.focus();
  });
}

/**
 * Close tabs the way the user means it: each surface ends what it owns, then the store drops them. `which` reads the
 * strip as it shows (indexes included): a tab in a pane of its own is the pane's to close.
 */
export function useCloseTabs(workspaceId: string, strip = true) {
  const { client } = useRuntimeClient();
  return (which: (tab: Tab, index: number, tabs: ReadonlyArray<Tab>) => boolean) => {
    const tabs = strip ? getPanel(workspaceId).tabs : getTabs(workspaceId);
    const shut = new Set(tabs.filter((tab, i) => which(tab, i, tabs)));
    for (const tab of shut) surfaceDef(tab.kind)?.onClose?.({ client, workspaceId, tab: tab as never });
    closeTabs(workspaceId, (t) => shut.has(t));
  };
}

/**
 * `workspace`: the chat the pane shows, as it shows it (PaneFrame reads a chat on another computer from Cloud's list);
 * its surfaces read it, not this window's own list. `launcher` false: no `+` (a Chief has no files, shell or browser to open).
 */
export function SidePanel({ workspace, launcher: canLaunch = true }: { workspace: Workspace; launcher?: boolean }) {
  const workspaceId = workspace.id;
  const panel = usePanel(workspaceId);
  const host = useRef<HTMLElement>(null);
  const [launcher, setLauncher] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const closeOwned = useCloseTabs(workspaceId);
  // A pinned tab (the Chief's Work) is never closed, whatever asked.
  const close: typeof closeOwned = (which) => {
    closeOwned((t, i, tabs) => !surfaceDef(t.kind)?.pinned && which(t, i, tabs));
    refocus(host.current, workspaceId);
  };
  // The desktop's close request outlives renders; it must call today's close (today's client).
  const closeRef = useRef(close);
  closeRef.current = close;
  const hide = () => {
    setPanelOpen(workspaceId, false);
    refocus(host.current, workspaceId);
  };

  // Visited keep-alive tabs stay mounted; closed tabs drop out.
  const alive = useRef(new Set<string>());
  if (panel.active) alive.current.add(panel.active);
  for (const id of alive.current) if (!panel.tabs.some((t) => t.id === id && (t.id === panel.active || surfaceDef(t.kind)?.keepAlive))) alive.current.delete(id);
  const mounted = panel.tabs.filter((t) => alive.current.has(t.id));

  // On a phone the panel covers its chat, so a chat shows itself first: a panel left open (earlier, or by another
  // visit) waits behind it until asked for.
  useEffect(() => {
    if (isPhone()) setPanelOpen(workspaceId, false);
  }, [workspaceId]);

  useLayoutEffect(() => {
    const pane = paneOf(host.current);
    if (!pane) return;
    const measure = () => setNarrow(pane.clientWidth < NARROW_PANE);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  const { client } = useRuntimeClient();
  useEffect(() => {
    if (!client) return;
    const stops = allSurfaces().flatMap((d) => (d.watch ? [d.watch({ client, workspaceId })] : []));
    return () => stops.forEach((stop) => stop());
  }, [client, workspaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isComposing(e) || !ownsFocus(host.current)) return;
      // Off the Mac "mod" is Ctrl, which a shell needs (Ctrl+W deletes a word): the terminal keeps its keys.
      if (!IS_MAC && (e.target as Element | null)?.closest?.(".xterm") && !matchesChord(e, chord("app.terminal"))) return;
      const s = getPanel(workspaceId);
      if (matchesChord(e, chord("app.sidePanel"))) {
        e.preventDefault();
        if (s.open) hide();
        else setPanelOpen(workspaceId, true);
      } else if (matchesChord(e, chord("app.openFile"))) {
        e.preventDefault();
        if (!s.open) setPanelOpen(workspaceId, true);
        setLauncher(true);
      } else if (e.key === "Escape" && s.maximized && !isTypingTarget(e.target) && host.current?.contains(document.activeElement)) {
        setMaximized(workspaceId, false);
      } else {
        const def = launcherSurfaces().find((d) => d.chord && d.kind !== "files" && matchesChord(e, d.chord));
        if (!def) return;
        e.preventDefault();
        toggleSurface(workspaceId, def.kind);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [workspaceId]);

  // ⌘W never reaches a page (the desktop shell takes it, a browser keeps it). The desktop asks first:
  // the pane in use closes its active tab, as in T3; with nothing open there, the window closes.
  useEffect(
    () =>
      window.cavemanDesktop?.onCloseRequest?.(() => {
        const s = getPanel(workspaceId);
        if (!s.open || !s.active || !ownsFocus(host.current)) return false;
        const id = s.active;
        closeRef.current((t) => t.id === id);
        return true;
      }),
    [workspaceId],
  );

  const floating = panel.maximized || narrow;
  const activeKind = panel.tabs.find((t) => t.id === panel.active)?.kind;
  const defaultWidth = (activeKind && surfaceDef(activeKind)?.defaultWidth) || DEFAULT_WIDTH;
  return (
    <PanelWorkspace.Provider value={workspace}>
      <TooltipProvider delayDuration={500} skipDelayDuration={300}>
        <section
          ref={host}
          aria-label="Side panel"
          data-side-panel=""
          data-focus-area="panel"
          style={floating ? undefined : { width: panel.width ? `${panel.width}px` : defaultWidth, maxWidth: `calc(100% - ${MIN_CHAT}px)`, minWidth: MIN_WIDTH }}
          className={cn(
            // A class, not the hidden attribute: `flex` would override [hidden].
            panel.open ? "flex" : "hidden",
            "z-20 min-h-0 flex-col bg-background",
 // Opening fades it in where it stands, no slide.
            "animate-in fade-in-0 duration-200 ease-snap motion-reduce:animate-none",
            // Expanded or in a narrow pane it covers the pane, the chat's header included: its own bar has the way back.
            floating ? "absolute inset-0" : "relative shrink-0 border-l border-border",
          )}
        >
          {!floating ? <ResizeEdge host={host} workspaceId={workspaceId} /> : null}
          <TabStrip workspaceId={workspaceId} launcher={launcher} setLauncher={setLauncher} close={close} hide={hide} floating={floating} canLaunch={canLaunch} />
          <div className="relative min-h-0 flex-1">
            {mounted.map((tab) => (
              // Switching tabs fades the surface in, no travel: the tab strip already showed where you went (STYLE.md §8).
              <div key={tab.id} role="tabpanel" id={`panel-${tab.id}`} aria-label={tabTitle(tab)} className={cn("absolute inset-0 flex-col", arriveMotion, tab.id === panel.active ? "flex" : "hidden")}>
                <SurfaceHost workspaceId={workspaceId} tab={tab} active={panel.open && tab.id === panel.active} />
              </div>
            ))}
          </div>
        </section>
      </TooltipProvider>
    </PanelWorkspace.Provider>
  );
}

// ---------------------------------------------------------------- resizing

function ResizeEdge({ host, workspaceId }: { host: React.RefObject<HTMLElement | null>; workspaceId: string }) {
  const [dragging, setDragging] = useState(false);
  const bounds = () => {
    const pane = paneOf(host.current);
    return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, (pane?.clientWidth ?? 1200) - MIN_CHAT) };
  };
  const clamp = (w: number) => {
    const { min, max } = bounds();
    return Math.min(max, Math.max(min, w));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      tabIndex={0}
      onPointerDown={(e) => {
        const el = host.current;
        if (e.button !== 0 || !el) return;
        e.preventDefault();
        const startX = e.clientX;
        const startW = el.getBoundingClientRect().width;
        let width = startW;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        setDragging(true);
        document.body.style.cursor = "col-resize";
        const move = (ev: PointerEvent) => {
          width = clamp(startW + (startX - ev.clientX));
          el.style.width = `${width}px`;
        };
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
          target.removeEventListener("pointercancel", up);
          target.removeEventListener("lostpointercapture", up);
          document.body.style.cursor = "";
          setDragging(false);
          if (width !== startW) setPanelWidth(workspaceId, width);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
        // Hiding the panel mid-drag drops the capture without a pointerup.
        target.addEventListener("lostpointercapture", up);
      }}
      onDoubleClick={() => setPanelWidth(workspaceId, null)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const w = host.current?.getBoundingClientRect().width ?? 0;
        setPanelWidth(workspaceId, clamp(w + (e.key === "ArrowLeft" ? 24 : -24)));
      }}
      className="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize outline-none"
    >
      <div className={cn("absolute inset-y-0 left-1 w-px transition-colors duration-150", dragging ? "bg-foreground/40" : "bg-transparent group-hover:bg-foreground/20 group-focus-visible:bg-ring")} />
    </div>
  );
}

// --------------------------------------------------------------- tab strip

interface DragState {
  readonly tab: Tab;
  readonly from: number;
  readonly startX: number;
  readonly startY: number;
  /** The panel's bar, where reordering happens; past its ends the tab lifts out (to the panel beside it). */
  readonly left: number;
  readonly right: number;
  readonly els: HTMLElement[];
  rects: DOMRect[] | null;
  target: number;
}

function TabStrip({
  workspaceId,
  launcher,
  setLauncher,
  close,
  hide,
  floating,
  canLaunch,
}: {
  workspaceId: string;
  canLaunch: boolean;
  launcher: boolean;
  setLauncher: (open: boolean) => void;
  close: (which: (tab: Tab, index: number, tabs: ReadonlyArray<Tab>) => boolean) => void;
  hide: () => void;
  /** Covering the pane (expanded, or a narrow pane): the chat's header and its switch are under it. */
  floating: boolean;
}) {
  const panel = usePanel(workspaceId);
  const phone = usePhone();
  const go = useTabNav();
  const goRef = useRef(go);
  goRef.current = go;
  // The agent's browser and computer tabs pulse in the blue while it uses them.
  const browsing = useInUse(workspaceId, "browser");
  const onComputer = useInUse(workspaceId, "computer");
  const activeTab = panel.tabs.find((t) => t.id === panel.active);
  const ActiveBar = activeTab ? surfaceDef(activeTab.kind)?.bar : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const settle = useRef(false);
  const [edges, setEdges] = useState({ start: false, end: false });
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const el = bar.current!;
    const measure = () => setRoom(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The + and the bar's own padding take about one more tab's room.
  const folded = room < (panel.tabs.length + 1) * TAB_ROOM;

  // A tab dragged here: its own pane's tab comes back, and a pull request or a contract from another panel moves in.
  useLayoutEffect(
    () =>
      registerDropTarget(bar.current!, {
        kind: "panel",
        workspaceId,
        accepts: (p) => {
          if (!p.tab) return null;
          if (p.tab.workspaceId === workspaceId) return p.fromPaneId ? "Back to panel" : null;
          const tab = getTabs(p.tab.workspaceId).find((t) => t.id === p.tab!.id);
          return tab && portable(tab) && canMoveTabTo(p.tab.workspaceId, tab.id, workspaceId) ? "Move here" : null;
        },
        onDrop: (p) => {
          if (!p.tab) return;
          if (p.tab.workspaceId === workspaceId) goRef.current(p.fromPaneId ? panes.dock(p.fromPaneId) : null);
          else goRef.current(panes.moveToPanel(p.tab, p.fromPaneId, workspaceId));
        },
      }),
    [workspaceId],
  );

  // After a drop, the new order is in the DOM: drop the drag transforms in the same frame.
  useLayoutEffect(() => {
    if (!settle.current) return;
    settle.current = false;
    const els = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-tab-item]") ?? [])];
    for (const el of els) {
      el.style.transition = "none";
      el.style.transform = "";
      el.style.zIndex = "";
    }
    // Hand the colour transitions back once the snap has painted.
    requestAnimationFrame(() => els.forEach((el) => (el.style.transition = "")));
  }, [panel.tabs]);

  // Keep the active tab in view, also when the strip narrows (a resize, a split). The scroller's scroll-padding
  // keeps it clear of the edge fades.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const reveal = () => el.querySelector<HTMLElement>(`[data-tab-item="${CSS.escape(panel.active ?? "")}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const ro = new ResizeObserver(reveal);
    ro.observe(el);
    return () => ro.disconnect();
  }, [panel.active]);

  // Fade the strip's edges only where tabs run past them.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [panel.tabs.length]);

  const onPointerDown = (tab: Tab, index: number) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-tab-close]")) return;
    activateTab(workspaceId, tab.id);
    const els = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-tab-item]") ?? [])];
    const box = bar.current!.getBoundingClientRect();
    drag.current = { tab, from: index, startX: e.clientX, startY: e.clientY, left: box.left, right: box.right, els, rects: null, target: index };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    // Pulled out of the strip: the strip lets go, and it is a drag to a pane, a panel or the window's tabs.
    const out = Math.abs(e.clientY - d.startY) > TEAR_PX || e.clientX < d.left - TEAR_PX || e.clientX > d.right + TEAR_PX;
    if (out && e.pointerType !== "touch" && movable(d.tab)) {
      for (const el of d.els) {
        el.style.transition = "";
        el.style.transform = "";
        el.style.zIndex = "";
      }
      drag.current = null;
      liftDrag(e, e.currentTarget, tabPayload(workspaceId, d.tab, null));
      return;
    }
    if (!d.rects) {
      if (Math.abs(dx) < 5) return;
      d.rects = d.els.map((el) => el.getBoundingClientRect());
    }
    const me = d.rects[d.from]!;
    const gap = d.rects.length > 1 ? Math.max(0, (d.rects[1]!.left - d.rects[0]!.right) | 0) : 0;
    const center = me.left + me.width / 2 + dx;
    let target = 0;
    d.rects.forEach((r, j) => {
      if (j !== d.from && center > r.left + r.width / 2) target++;
    });
    d.target = target;
    d.els.forEach((el, j) => {
      if (j === d.from) {
        el.style.transition = "none";
        el.style.transform = `translateX(${dx}px)`;
        el.style.zIndex = "1";
        return;
      }
      const shift = d.from < target && j > d.from && j <= target ? -(me.width + gap) : d.from > target && j >= target && j < d.from ? me.width + gap : 0;
      el.style.transition = "transform 150ms var(--ease-snap)";
      el.style.transform = shift ? `translateX(${shift}px)` : "";
    });
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.rects) return;
    if (d.target === d.from) {
      for (const el of d.els) {
        el.style.transition = "transform 150ms var(--ease-snap)";
        el.style.transform = "";
        el.style.zIndex = "";
      }
      setTimeout(() => d.els.forEach((el) => (el.style.transition = "")), 160);
      return;
    }
    settle.current = true;
    // The strip leaves out the tabs in panes of their own: the tab goes before the same neighbour among all of them.
    const rest = getTabs(workspaceId).filter((t) => t.id !== d.tab.id);
    const shown = panel.tabs.filter((t) => t.id !== d.tab.id);
    const before = shown[d.target];
    moveTab(workspaceId, d.tab.id, before ? rest.indexOf(before) : rest.indexOf(shown.at(-1)!) + 1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && panel.active && (e.target as HTMLElement).getAttribute("role") === "tab") {
      e.preventDefault();
      const id = panel.active;
      close((t) => t.id === id);
      return;
    }
    const i = panel.tabs.findIndex((t) => t.id === panel.active);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? panel.tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const tab = panel.tabs[(next + panel.tabs.length) % panel.tabs.length];
    if (!tab) return;
    activateTab(workspaceId, tab.id);
    scroller.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(tab.id)}"]`)?.focus();
  };

  const mask = edges.start || edges.end ? `linear-gradient(to right, ${edges.start ? "transparent, #000 24px" : "#000"}, ${edges.end ? "#000 calc(100% - 24px), transparent" : "#000"})` : undefined;

  return (
    // The chat's header is h-11 too: side by side they are one bar, the panel's border running through it.
    <div ref={bar} className="flex h-11 shrink-0 items-center gap-1 pl-2 pr-1.5">
      <div
        ref={scroller}
        role="tablist"
        aria-label="Side panel tabs"
        onKeyDown={onKeyDown}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scroll-padding-inline:24px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {panel.tabs.map((tab, i) => {
          const def = surfaceDef(tab.kind);
          const SurfaceIcon = def?.icon;
          const active = tab.id === panel.active;
          const inUse = tab.kind === "computer" ? onComputer : tab.kind === "browser" && (tab.params as SurfaceParams["browser"]).backend === "agent" && browsing;
          const name = inUse ? `${tabTitle(tab)}, in use by the agent` : tabTitle(tab);
          return (
            // The item is presentational: the tab inside it is what assistive tech sees, and the close
            // button sits beside the tab (not in it), hidden from the tree; Delete closes the focused tab.
            <div
              key={tab.id}
              data-tab-item={tab.id}
              role="presentation"
              onPointerDown={onPointerDown(tab, i)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onLostPointerCapture={onPointerUp}
              onAuxClick={(e) => {
                if (e.button === 1) close((t) => t.id === tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                // The context-menu key (Shift+F10) reports no pointer: open the menu under the tab.
                const r = e.currentTarget.getBoundingClientRect();
                const keyboard = e.clientX === 0 && e.clientY === 0;
                setMenu({ x: keyboard ? r.left : e.clientX, y: keyboard ? r.bottom : e.clientY, tabId: tab.id });
              }}
              className={cn(
                "group relative flex h-7 max-w-[180px] shrink-0 cursor-default select-none items-center rounded-md text-[13px]",
                "transition-colors duration-200 ease-snap has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring",
                active ? "bg-foreground/[0.08] text-foreground" : "text-[hsl(var(--subtle-foreground))] hover:bg-foreground/[0.05] hover:text-foreground/85",
              )}
            >
              <div
                data-tab={tab.id}
                role="tab"
                aria-selected={active}
                aria-controls={`panel-${tab.id}`}
                aria-keyshortcuts="Delete"
                aria-label={name}
                title={name}
                tabIndex={active ? 0 : -1}
                className={cn("flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden pl-2 outline-none", active ? "pr-1" : folded ? "pr-2" : "pr-2.5")}
              >
                {/* A hovered tab that isn't in front trades its icon for its close button, so closing costs no width. Folded to
                    its icon, the icon is all there is to click or drag: it keeps it (middle-click, Delete and the menu close it). */}
                <span className={cn("relative grid size-4 shrink-0 place-items-center transition-opacity duration-100", !active && !def?.pinned && !folded && "group-hover:opacity-0")}>
                  {SurfaceIcon ? <SurfaceIcon className="size-4" /> : null}
                  {inUse ? (
                    <LiveDot className="absolute -right-0.5 -top-0.5 ring-2 ring-background" />
                  ) : tab.attention ? (
                    <AttentionDot attention={tab.attention} className="absolute -right-0.5 -top-0.5 ring-2 ring-background" />
                  ) : null}
                </span>
                {/* Every tab says what it is (a word reads faster than a row of icons), until the bar runs short. */}
                <span aria-hidden className={cn("min-w-0 truncate", !active && folded && "hidden")}>
                  {tabTitle(tab)}
                </span>
              </div>
              {def?.pinned || (folded && !active) ? null : <button
                type="button"
                data-tab-close=""
                tabIndex={-1}
                aria-hidden
                title={`Close ${tabTitle(tab)}`}
                onClick={() => close((t) => t.id === tab.id)}
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-opacity duration-75 hover:bg-foreground/10 hover:text-foreground",
                  // An inactive tab shows its close button over its icon on hover, so it costs no width.
                  active ? "mr-1" : "absolute left-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100",
                )}
              >
                <Icon icon={Cancel01Icon} className="size-3.5" />
              </button>}
            </div>
          );
        })}
      </div>

      {canLaunch ? (
        <LauncherPopover workspaceId={workspaceId} open={launcher} onOpenChange={setLauncher} onClosed={() => refocus(scroller.current, workspaceId)}>
          <BarButton label="Open" chord={launchChord()} pressed={launcher} onClick={() => setLauncher(!launcher)}>
            <Icon icon={Add01Icon} />
          </BarButton>
        </LauncherPopover>
      ) : null}

      {/* The active surface's own controls (the Work tab's List, Board, Library), then, over the chat, the way back. */}
      {ActiveBar && activeTab ? (
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
          <ActiveBar workspaceId={workspaceId} tab={activeTab as never} active />
        </div>
      ) : null}
      {floating ? (
        <div className={cn("flex shrink-0 items-center gap-0.5 pl-2", !(ActiveBar && activeTab) && "ml-auto")}>
          {panel.maximized ? (
            <BarButton label="Restore" onClick={() => setMaximized(workspaceId, false)}>
              <Icon icon={ArrowShrink02Icon} />
            </BarButton>
          ) : null}
          {/* On a phone the panel is a screen of its own over the chat: its way back is a plain close. */}
          {phone ? (
            <BarButton label="Close panel" onClick={hide}>
              <Icon icon={Cancel01Icon} />
            </BarButton>
          ) : (
            <BarButton label="Hide panel" chord={chord("app.sidePanel")} pressed onClick={hide}>
              <Icon icon={PanelRightIcon} />
            </BarButton>
          )}
        </div>
      ) : null}

      <DropdownMenu open={menu !== null} onOpenChange={(o) => !o && setMenu(null)} modal={false}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={menu ? { left: menu.x, top: menu.y } : { left: -9999, top: -9999 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={2} className="min-w-[180px]">
          {menu ? <TabMenuItems workspaceId={workspaceId} tabId={menu.tabId} tabs={panel.tabs} maximized={panel.maximized} close={close} go={go} done={() => setMenu(null)} /> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The workspace file a tab shows: a file at its current version, or an HTML page read from the workspace. */
function tabFile(tab: Tab): string | null {
  if (tab.kind === "file") {
    const p = tab.params as SurfaceParams["file"];
    return p.ref ? null : p.path;
  }
  if (tab.kind === "browser") return (tab.params as SurfaceParams["browser"]).path ?? null;
  return null;
}

function TabMenuItems({
  workspaceId,
  tabId,
  tabs,
  maximized,
  close,
  go,
  done,
}: {
  workspaceId: string;
  tabId: string;
  /** Closes the menu, once an action that waits for the host (Reveal in Finder) has its answer. */
  done: () => void;
  tabs: ReadonlyArray<Tab>;
  maximized: boolean;
  close: (which: (tab: Tab, index: number) => boolean) => void;
  go: (path: string | null) => void;
}) {
  const at = tabs.findIndex((t) => t.id === tabId);
  const tab = tabs[at];
  const ref = { workspaceId, id: tabId };
  const file = tab ? tabFile(tab) : null;
  const fileActions = useFileRefActions(workspaceId, usePanelWorkspace()?.root_path);
  return (
    <>
      {/* A file's tab (a file, an HTML page from the workspace): open it in the editor, Reveal in Finder, its path. */}
      {file && fileActions ? (
        <>
          <FileMenuItems actions={fileActions} target={{ path: file, exact: true }} onDone={done} open={false} />
          <DropdownMenuSeparator />
        </>
      ) : null}
      {/* The menu's way to do what a drag out of the strip does. */}
      {tab && movable(tab) ? (
        <>
          {panes.canHostTab(ref) ? (
            <DropdownMenuItem onSelect={() => go(panes.hostTab(ref))}>Open in split view</DropdownMenuItem>
          ) : (
            // A browser shows no window tabs to fall back on: a split with no room says so instead of hiding the tab.
            <DropdownMenuItem disabled>
              Open in split view <DropdownMenuShortcut>No room</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {IS_DESKTOP ? <DropdownMenuItem onSelect={() => go(windowTabs.openTab(ref))}>Open in new tab</DropdownMenuItem> : null}
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem onSelect={() => setMaximized(workspaceId, !maximized)}>{maximized ? "Restore panel" : "Expand panel"}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => close((t) => t.id === tabId)}>Close</DropdownMenuItem>
      <DropdownMenuItem disabled={tabs.length < 2} onSelect={() => close((t) => t.id !== tabId)}>
        Close others
      </DropdownMenuItem>
      <DropdownMenuItem disabled={at === tabs.length - 1} onSelect={() => close((_, i) => i > at)}>
        Close to the right
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => close(() => true)}>Close all</DropdownMenuItem>
    </>
  );
}

/** The chat header's switch for the side panel, lit while it shows; with nothing open yet, showing it opens the launcher. */
export function PanelToggle({ workspaceId }: { workspaceId: string }) {
  const panel = usePanel(workspaceId);
  return (
    <TooltipProvider delayDuration={500}>
      <BarButton
        label={panel.open ? "Hide panel" : "Show panel"}
        chord={chord("app.sidePanel")}
        pressed={panel.open}
        data-panel-toggle=""
        className="relative"
        onClick={() => setPanelOpen(workspaceId, !panel.open)}
      >
        <Icon icon={PanelRightIcon} />
        {!panel.open && panel.tabs.some((t) => t.attention) ? <AttentionDot attention={panel.tabs.some((t) => t.attention === "pulse") ? "pulse" : true} className="absolute right-1 top-1" /> : null}
      </BarButton>
    </TooltipProvider>
  );
}
