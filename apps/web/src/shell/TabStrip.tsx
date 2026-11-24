// The window's tabs (the desktop app): a strip in the band above the panel, where the window drags. A tab is what fills
// the panel (a chat, a split of chats, a page) and stays as it was while another tab is in front (panes/store.ts).
// ⌘1..⌘8 go to a tab, ⌘9 to the last, ⌃⇥ / ⌃⇧⇥ step, ⌘T opens one, ⌘W closes it, ⌘⇧T brings the last one back.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { Icon, Add01Icon, Cancel01Icon } from "@caveman-app/ui/icons/huge";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import { ease } from "@caveman-app/ui/motion";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { useLocation } from "react-router";
import { StatusMark } from "../components/StatusMark.tsx";
import { EngineMark } from "../components/transcript/marks.tsx";
import { ariaChord, formatChord, IS_DESKTOP, IS_MAC, isComposing, matchesChord } from "../panels/chrome.tsx";
import { surfaceDef, tabTitle } from "../panels/registry.ts";
import { useTabsOf } from "../panels/store.ts";
import { registerDropTarget } from "../panes/drag.ts";
import { chatOf, closePane, isSplitPath, panes, useTabs, windowTabs, type Tab } from "../panes/store.ts";
import { SplitMap } from "../components/pane/SplitMap.tsx";
import { findPane, leaves, openWorkspaceIds, type Pane } from "../panes/tree.ts";
import { useChiefs } from "../state/chiefs.ts";
import { chord, useKeybindings } from "../state/keybindings.ts";
import { chatStatus, type WorkspaceView } from "../state/model.ts";
import { sameItems, useRuntimeSelector } from "../state/runtime.tsx";
import { useSidebarLayout } from "../state/sidebar-layout.ts";
import { SidebarToggle } from "./SidebarToggle.tsx";
import { HistoryNav } from "./HistoryNav.tsx";
import { tabDigit, tabNumber, useTabNav } from "./tab-nav.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/** Holding ⌘ this long shows each tab's number (and nothing renders: a class on <html>, styles.css). */
const KEYS_AFTER_MS = 400;
/** A press that moves this far is a drag, not a click. */
const DRAG_PX = 4;

/**
 * The tab keys, from anywhere in the window, a text field included (AppShell, outside the shell's Activity, so they
 * work from Settings too). A key something else took first (the model picker's ⌘1..⌘9) stays its own.
 */
export function useTabKeys(): void {
  const go = useTabNav();
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (!IS_DESKTOP) return;
    const mod = IS_MAC ? "Meta" : "Control";
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      root.removeAttribute("data-tab-keys");
    };
    const onKey = (e: KeyboardEvent) => {
      // ⌘ alone, held: the numbers show. Any other key hides them (⌘K is not a tab key).
      if (e.key === mod && !e.repeat && !e.altKey && !e.shiftKey) {
        clearTimeout(timer);
        timer = setTimeout(() => root.setAttribute("data-tab-keys", ""), KEYS_AFTER_MS);
      } else if (e.key !== mod) hide();
      if (e.defaultPrevented || e.repeat || isComposing(e)) return;
      const n = tabDigit(e);
      const run =
        n !== null
          ? () => windowTabs.activateAt(n)
          : matchesChord(e, chord("app.nextTab"))
            ? () => windowTabs.step(1)
            : matchesChord(e, chord("app.previousTab"))
              ? () => windowTabs.step(-1)
              : matchesChord(e, chord("app.newTab"))
                ? windowTabs.openNewChat
                : matchesChord(e, chord("app.reopenTab"))
                  ? windowTabs.reopen
                  : null;
      if (!run) return;
      e.preventDefault();
      goRef.current(run());
    };
    const onUp = (e: KeyboardEvent) => e.key === mod && hide();
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", hide);
    };
  }, []);
}

/** The strip. The band it sits in drags the window; the tabs and + click. Nothing in a browser, which has its own tabs. */
export function TabStrip() {
  const tabs = useTabs();
  const go = useTabNav();
  const goRef = useRef(go);
  goRef.current = go;
  const keys = useKeybindings();
  const strip = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragged = useRef(false);

  // ⌘W, innermost first: the side panel's tab (SidePanel registers later, so it is asked first), Settings over the
  // tabs, the focused pane of a split, the tab, then the window.
  const location = useLocation();
  const route = useRef(location.pathname);
  route.current = location.pathname;
  useEffect(
    () =>
      window.cavemanDesktop?.onCloseRequest?.(() => {
        if (/^\/settings(\/|$)/.test(route.current)) {
          goRef.current(windowTabs.frontPath());
          return true;
        }
        const layout = panes.get();
        if (isSplitPath(route.current) && leaves(layout.root).length > 1 && layout.focused) {
          goRef.current(closePane(layout.focused, null));
          return true;
        }
        const t = windowTabs.get();
        if (t.list.length < 2) return false;
        goRef.current(windowTabs.close((x) => x.id === t.active));
        return true;
      }),
    [],
  );

  // A chat or a side-panel tab dropped here opens in a tab of its own; a pane dragged by its header leaves its split for one.
  useLayoutEffect(
    () =>
      registerDropTarget(strip.current!, {
        kind: "strip",
        onDrop: (p) => goRef.current(p.fromPaneId ? windowTabs.splitOff(p.fromPaneId) : p.tab ? windowTabs.openTab(p.tab) : windowTabs.openChat(p.workspaceId)),
      }),
    [],
  );

  // The tab in front stays in view, and the edges fade while there is more to scroll to.
  useLayoutEffect(() => {
    list.current?.querySelector(`[data-tab-id="${tabs.active}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabs.active, tabs.list.length]);
  useLayoutEffect(() => {
    const el = list.current!;
    const edges = () => {
      el.toggleAttribute("data-fade-start", el.scrollLeft > 1);
      el.toggleAttribute("data-fade-end", el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    edges();
    const seen = new ResizeObserver(edges);
    seen.observe(el);
    el.addEventListener("scroll", edges, { passive: true });
    return () => {
      seen.disconnect();
      el.removeEventListener("scroll", edges);
    };
  }, [tabs.list.length]);

  /**
   * Drags a tab along the strip: it follows the pointer (a transform, written per frame outside React), the others
   * make room as it passes their middle, and it settles where it lands. Window listeners, not pointer capture: React
   * moves tabs in the DOM as they reorder, which would drop a capture.
   */
  const beginDrag = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const el = e.currentTarget;
    const x0 = e.clientX;
    const left0 = el.offsetLeft;
    let x = x0;
    let moving = false;
    let raf = 0;
    const tabEls = () => [...list.current!.querySelectorAll<HTMLElement>("[data-tab-id]")];
    const frame = () => {
      raf = 0;
      const centre = left0 + (x - x0) + el.offsetWidth / 2;
      const others = tabEls().filter((t) => t !== el);
      const to = others.filter((t) => t.offsetLeft + t.offsetWidth / 2 < centre).length;
      if (to !== windowTabs.get().list.findIndex((t) => t.id === id)) {
        // The others slide to their new places (FLIP, on the compositor) instead of jumping.
        const before = new Map(others.map((t) => [t, t.offsetLeft]));
        flushSync(() => windowTabs.move(id, to));
        for (const [t, was] of before) {
          const d = was - t.offsetLeft;
          if (d !== 0) t.animate([{ transform: `translateX(${d}px)` }, { transform: "none" }], { duration: 160, easing: ease.decelerate });
        }
      }
      el.style.transform = `translateX(${x - x0 - (el.offsetLeft - left0)}px)`;
    };
    const move = (ev: PointerEvent) => {
      x = ev.clientX;
      if (!moving) {
        if (Math.abs(x - x0) < DRAG_PX) return;
        moving = true;
        dragged.current = true;
        el.dataset.dragging = "";
        // The tab you pick up comes to the front, as a click would.
        goRef.current(windowTabs.activate(id));
      }
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (raf) cancelAnimationFrame(raf);
      if (!moving) return;
      delete el.dataset.dragging;
      const rest = el.style.transform;
      el.style.transform = "";
      if (rest) el.animate([{ transform: rest }, { transform: "none" }], { duration: 140, easing: ease.decelerate });
      // The click that ends a drag is not a click on the tab.
      setTimeout(() => (dragged.current = false), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const count = tabs.list.length;
  const at = menu ? tabs.list.findIndex((t) => t.id === menu.id) : -1;
  const newTab = keys["app.newTab"] ?? chord("app.newTab");
  const sidebarHidden = useSidebarLayout().hidden;
  return (
    <div ref={strip} data-sidebar-hidden={sidebarHidden || undefined} className="tab-strip window-drag absolute inset-x-0 top-0 flex h-10 items-center gap-0.5 pr-2">
      {/* The sidebar tucked away: its way back heads the tabs, where the sidebar's own toggle sat (styles.css), and
          Back and Forward after it, where they sat beside it. */}
      {sidebarHidden ? (
        <>
          <SidebarToggle hidden className="ml-1" />
          <HistoryNav className="mr-0.5" />
        </>
      ) : null}
      <div ref={list} role="tablist" aria-label="Tabs" className="tab-list flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {tabs.list.map((tab, i) => (
          <TabItem
            key={tab.id}
            tab={tab}
            number={tabNumber(i, count)}
            active={tab.id === tabs.active}
            closable={count > 1}
            onActivate={() => !dragged.current && go(windowTabs.activate(tab.id))}
            onClose={() => go(windowTabs.close((t) => t.id === tab.id))}
            onStep={(by) => {
              const next = tabs.list[(i + by + count) % count]!;
              go(windowTabs.activate(next.id));
              requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)?.focus());
            }}
            onMenu={(x, y) => setMenu({ id: tab.id, x, y })}
            onDragStart={(e) => beginDrag(e, tab.id)}
          />
        ))}
      </div>
      <button
        type="button"
        aria-label="New tab"
        aria-keyshortcuts={ariaChord(newTab)}
        title={`New tab (${formatChord(newTab)})`}
        onClick={() => go(windowTabs.openNewChat())}
        className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors duration-75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon icon={Add01Icon} className="size-4" />
      </button>
      <DropdownMenu open={menu !== null} onOpenChange={(o) => !o && setMenu(null)} modal={false}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={menu ? { left: menu.x, top: menu.y } : { left: -9999, top: -9999 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={2} className="w-[230px]">
          <DropdownMenuItem onSelect={() => go(windowTabs.openNewChat())}>
            New tab <DropdownMenuShortcut>{formatChord(newTab)}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={count < 2} onSelect={() => menu && go(windowTabs.close((t) => t.id === menu.id))}>
            Close tab <DropdownMenuShortcut>{formatChord("mod+w")}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={count < 2}
            onSelect={() => {
              if (!menu) return;
              const shown = windowTabs.activate(menu.id);
              go(windowTabs.close((t) => t.id !== menu.id) ?? shown);
            }}
          >
            Close other tabs
          </DropdownMenuItem>
          <DropdownMenuItem disabled={at < 0 || at >= count - 1} onSelect={() => go(windowTabs.close((_, i) => i > at))}>
            Close tabs to the right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!windowTabs.canReopen()} onSelect={() => go(windowTabs.reopen())}>
            Reopen closed tab <DropdownMenuShortcut>{formatChord(keys["app.reopenTab"] ?? chord("app.reopenTab"))}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface TabItemProps {
  readonly tab: Tab;
  /** ⌘ and this number go here (shown while ⌘ is held); null past the eighth, the last aside. */
  readonly number: number | null;
  readonly active: boolean;
  readonly closable: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onStep: (by: 1 | -1) => void;
  readonly onMenu: (x: number, y: number) => void;
  readonly onDragStart: (e: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * One tab: its mark (a chat's status, a split's map, a page's icon, a side-panel tab's icon), its title fading at the
 * edge rather than cut, and on hover its ✕. Reads only its own chats and tabs: a push about any other chat re-renders no tab.
 */
const TabItem = memo(function TabItem({ tab, number, active, closable, onActivate, onClose, onStep, onMenu, onDragStart }: TabItemProps) {
  const ws = chatOf(tab.path);
  const split = isSplitPath(tab.path);
  const ids = split ? openWorkspaceIds(tab.layout) : NO_IDS;
  const views = useRuntimeSelector((v) => ids.map((id) => viewIndex(v.workspaces).get(id)), sameItems);
  const page = usePage(split ? null : tab.path);
  const shownPanes = split ? leaves(tab.layout.root) : NO_PANES;
  // The side-panel tabs in its panes, by name.
  const refs = useMemo(() => shownPanes.flatMap((p) => (p.tab ? [p.tab] : [])), [tab.layout, split]);
  const hosted = useTabsOf(refs);
  const focusedPane = split ? findPane(tab.layout, tab.layout.focused) : null;
  const focusedId = split ? (focusedPane?.workspaceId ?? ws) : null;
  const focused = focusedId === null ? undefined : views[ids.indexOf(focusedId)];
  // With no chat to name it, a tab is named by the side-panel tab in focus.
  const named = ws === null && split ? (hosted[refs.findIndex((r) => r === focusedPane?.tab)] ?? hosted.find(Boolean) ?? null) : null;
  const NamedIcon = named ? surfaceDef(named.kind)?.icon : undefined;
  const statuses = views.map((w) => (w ? chatStatus(w) : null));
  const status = focused ? chatStatus(focused) : null;
  const title = !split ? page.label : named ? tabTitle(named) : (focused?.title ?? "Chat");
  const more = shownPanes.length - 1;
  const attention = statuses.some((s) => s?.action) || views.some((w) => w?.unread);
  const names = [...views.map((w) => w?.title ?? "Chat"), ...hosted.map((t) => (t ? tabTitle(t) : "Tab"))];
  const tooltip = [!split ? page.label : names.join(" · "), number ? formatChord(`mod+${number}`) : null].filter(Boolean).join("  ");
  const mark =
    !split ? (
      <Glyph name={page.icon} />
    ) : shownPanes.length > 1 ? (
      <SplitMap layout={tab.layout} lit={tab.layout.focused} statuses={new Map(ids.map((id, i) => [id, statuses[i] ?? null]))} />
    ) : NamedIcon ? (
      <NamedIcon className="size-4" />
    ) : status ? (
      <StatusMark status={status} compact />
    ) : focused ? (
      <EngineMark engine={focused.engine.id} className="size-4" />
    ) : (
      <Glyph name="new" />
    );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      onStep(e.key === "ArrowRight" ? 1 : -1);
    } else if ((e.key === "Delete" || e.key === "Backspace") && closable) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-tab-id={tab.id}
      title={tooltip}
      aria-keyshortcuts={number ? ariaChord(`mod+${number}`) : undefined}
      onPointerDown={onDragStart}
      onClick={onActivate}
      onAuxClick={(e) => {
        if (e.button !== 1 || !closable) return;
        e.preventDefault();
        onClose();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onKeyDown={onKeyDown}
      className={cn(
        "tab group/tab relative flex h-7 w-[200px] min-w-[88px] shrink cursor-default select-none items-center gap-2 rounded-lg pl-2 pr-2 text-[13px] outline-none",
        "transition-[background-color,color,box-shadow] duration-75 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active
          ? "bg-background font-medium text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_0_0.5px_hsl(var(--border))]"
          : cn("text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground", attention && "text-sidebar-accent-foreground"),
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center">{mark}</span>
      {/* Long titles fade out at the edge instead of ending in an ellipsis; more so under the ✕ or the number. */}
      <span className="tab-title min-w-0 flex-1 overflow-hidden whitespace-nowrap">
        {title}
        {more > 0 ? <span className="pl-1.5 font-normal tabular-nums text-muted-foreground">+{more}</span> : null}
      </span>
      {number ? (
        <kbd aria-hidden className="tab-key pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[5px] px-1 font-sans text-[11px] leading-4 text-muted-foreground opacity-0">
          {formatChord(`mod+${number}`)}
        </kbd>
      ) : null}
      {closable ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "tab-close absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-75",
            "hover:bg-accent hover:text-foreground group-hover/tab:opacity-100",
          )}
        >
          <Icon icon={Cancel01Icon} className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
});

const NO_IDS: ReadonlyArray<string> = [];
const NO_PANES: ReadonlyArray<Pane> = [];

const indexes = new WeakMap<ReadonlyArray<WorkspaceView>, ReadonlyMap<string, WorkspaceView>>();
/** The chat list by id, made once per version of the list for every tab to read. */
function viewIndex(list: ReadonlyArray<WorkspaceView>): ReadonlyMap<string, WorkspaceView> {
  let index = indexes.get(list);
  if (!index) indexes.set(list, (index = new Map(list.map((w) => [w.id, w]))));
  return index;
}

/** A page tab's name and icon, from its route. */
function usePage(path: string | null): { label: string; icon: PixelIconName } {
  const chiefs = useChiefs();
  if (path === null) return { label: "", icon: "new" };
  const [route] = path.split("?");
  const parts = route!.split("/").filter(Boolean);
  switch (parts[0]) {
    case "new":
      return { label: "New chat", icon: "new" };
    case "chief": {
      const board = parts.at(-1) === "board";
      const id = parts[1] && parts[1] !== "board" ? decodeURIComponent(parts[1]) : null;
      const chief = chiefs.chiefs.find((c) => (id ? c.id === id : c.home));
      return { label: board ? `${chief?.name ?? "Chief"} · Board` : chief?.name ?? "Chief", icon: "chief" };
    }
    case "automations":
      return { label: "Automations", icon: "automations" };
    case "plugins":
      return { label: "Plugins", icon: "spaces" };
    case "review":
      return { label: parts[2] ? `PR #${parts[2]}` : "Review", icon: "review" };
    case "cloud":
      return { label: "Starting on Cloud", icon: "computer-cloud" };
    default:
      return { label: "Caveman", icon: "new" };
  }
}
