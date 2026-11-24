import { useSidebarOrder, type SidebarOrder } from "./sidebar-order.ts";
import { ChiefsSection } from "./ChiefList.tsx";
import { iconButton } from "./sidebar-style.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { Keycap } from "@caveman-app/ui/components/menu";
import { EngineLogo, RunnerMark, runnerAccent, shortModel, type Runner } from "@caveman-app/ui/components/runner-badge";
import { BrandMark } from "@caveman-app/ui/icons/brand";
import { NavButton, NavIcon } from "@caveman-app/ui/icons/NavButton";
import { COMPUTER_KIND_ICON, type PixelIconName } from "@caveman-app/ui/icons/names";
import type { MergedView } from "../state/sync/chats-view.ts";
import { StateMark } from "@caveman-app/ui/icons/PixelIcon";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Add01Icon, BellDotIcon, ArrowUpRight01Icon, AlarmClockIcon, AlarmClockOffIcon, Archive02Icon, ArchiveRestoreIcon, ArrowRight01Icon, ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon, Copy01Icon, Delete02Icon, Folder01Icon, FolderOpenIcon, GitBranchIcon, DashboardSquare01Icon, UserGroupIcon, GitForkIcon, GitPullRequestIcon, LinkSquare02Icon, ListFilterIcon, Moon02Icon, MoreHorizontalIcon, Notification01Icon, PencilEdit02Icon, PinIcon, PinOffIcon, Search01Icon, SquareTerminalIcon, Tick02Icon, Undo02Icon } from "@caveman-app/ui/icons/huge";
import { Image01Icon } from "@caveman-app/ui/icons/huge";
import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { NavLink, useLocation, useMatch, useNavigate, useParams, useSearchParams } from "react-router";
import { CallPill } from "../call/CallStage.tsx";
import { useCall } from "../call/store.ts";
import { StatusMark } from "../components/StatusMark.tsx";
import { ProjectLogo } from "../components/ProjectLogo.tsx";
import { ProjectLogoDialog } from "../components/ProjectLogoPicker.tsx";
import { PinnedSection } from "../components/pane/PinnedSection.tsx";
import { SplitMap } from "../components/pane/SplitMap.tsx";
import { useAddProject, useProjectCreate } from "../components/ProjectPicker.tsx";
import { carriesProject, droppedName, droppedProjects, importedLine, type DroppedProject } from "./drop-project.ts";
import { beginDrag, registerDropTarget, type ArrangePlace, type DragPayload } from "../panes/drag.ts";
import { DragLayer } from "../panes/DragLayer.tsx";
import { announce, chatPath, panes, useChatHome, useChatTab, useOpenWorkspaces, useTabs, warmChat, windowTabs } from "../panes/store.ts";
import { leaves, paneOf } from "../panes/tree.ts";
import { useShowChat } from "./show-chat.ts";
import { useTabNav, wantsNewTab } from "./tab-nav.ts";
import type { InboxAction, Project, Workspace } from "@caveman-app/session-protocol";
import { archivesAt, chatLife, pinnedChats, queueSections, tidyable, waitsOnYou, wakeLabel, type QueueSections } from "../state/inbox-state.ts";
import { useArchivedChats } from "../state/archived.ts";
import { peek } from "../state/peek.ts";
import { useSaveSettings } from "../routes/settings/rows.tsx";
import { CustomSnoozeDialog, InboxItems, useInbox } from "./InboxItems.tsx";
import { agentLive, unmergedWork, agentRows, archivedProjects, chatPlace, chatStatus, chatStatuses, engineLine, filterFolders, filterProjectsLabel, firstStatus, folderRowsShown, folderShowMore, foldersForSidebar, topicView, topicRowLife, carryMarks, shareMarks, moveKeys, chatKey, chatStage, groupKey, handOverPlan, renameGroup, type ChatLife, type ClosedGroup, type TopicGroupItem, type TopicMarks, type TopicRow, liveAndDone, passesFilter, recentAgents, rowAge, storedFilterProjects, toggleFilterProject, type AgentRow, type ChatFilter, type ChatStatus, type ChildView, type FolderCutoff, type RepositoryView, type SidebarFolder, type SidebarRow, type WorkspaceView } from "../state/model.ts";
import { openSurface } from "../panels/store.ts";
import { menuPoint } from "../panels/files/FileMenu.tsx";
import { useChief } from "../state/chief.ts";
import { Button } from "@caveman-app/ui/components/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@caveman-app/ui/components/popover";
import { projectWaitsOnYou } from "../state/chief-model.ts";
import { callChief, MISSION_PARAM, useChiefs } from "../state/chiefs.ts";
import { ChiefSprite } from "../components/ChiefSprite.tsx";
import type { ChiefProfile } from "@caveman-app/session-protocol";
import { chatClientFor, CLOUD_HOSTED, loadedTurn, prefetchSession, requestId, sameItems, useRuntimeClient, useRuntimeSelector, useSyncHub, useWebWindow } from "../state/runtime.tsx";
import { LIST_FAILED_LINE } from "../state/sync/web-window.ts";
import { childRunner, runnerFor } from "../state/runner.ts";
import { useUpdateReady } from "../state/desktop.ts";
import { ariaChord, formatChord, IS_DESKTOP, isComposing, QuietButton, SurfaceEmpty } from "../panels/chrome.tsx";
import { markTyped, renamedTo } from "../components/rename-field.ts";
import { REVEAL_LABEL } from "../lib/platform.ts";
import { usePhone } from "../lib/screen.ts";
import { useLongPress } from "../lib/long-press.ts";
import { GettingStarted } from "./GettingStarted.tsx";
import { opensForChild, foldOpen, manyLine, manyLive } from "./builder-fold.ts";
import { GetAPlanRow, PlanRing, usePlanMeter } from "./PlanMeter.tsx";
import { SidebarPeek } from "./SidebarPeek.tsx";
import { TidyItem, TidyNotice, useTidy, useTidyGone, useTidyMark } from "./Tidy.tsx";
import { focusSidebarToggle, SidebarToggle } from "./SidebarToggle.tsx";
import { HistoryNav } from "./HistoryNav.tsx";
import { TitleBar } from "./TitleBar.tsx";
import { useQueue } from "../routes/review/data.ts";
import { needsYou, prPath } from "../routes/review/model.ts";
import { ChatPrMarks } from "../routes/review/parts.tsx";
import { chord, runShortcut, useKeybindings } from "../state/keybindings.ts";
import { keyedSidebarTop, keyedSidebarWidth, setSidebarDrawer, setSidebarWidth, settleSidebarTop, SIDEBAR_TOP, SIDEBAR_WIDTH, sidebarTopStops, snapSidebarTop, useSidebarDrawer, useSidebarLayout } from "../state/sidebar-layout.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

export function Sidebar() {
  const layout = useSidebarLayout();
  if (usePhone()) return <SidebarDrawer />;
  // Tucked away, it is gone from beside the page: the way back heads the band above the panel (SidebarToggle.tsx), and
  // resting on the window's left edge slides it out over the page for a look.
  return layout.hidden ? <SidebarFlyout width={layout.width} /> : <SidebarPanel width={layout.width} />;
}

/** Rest on the window's left edge this long and the tucked-away sidebar slides out; leave it and it goes this long after. */
const FLYOUT_OPEN_MS = 200;
const FLYOUT_CLOSE_MS = 300;

/** What it opened that is still in use keeps the fly-out out: a menu, a dialog, or a name being typed in it. */
function flyoutHeld(flyout: HTMLElement | null): boolean {
  if (document.querySelector('[role="menu"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return true;
  const active = document.activeElement;
  return flyout !== null && active !== null && flyout.contains(active) && active.matches('input, textarea, [contenteditable="true"]');
}

/**
 * The sidebar tucked away (⌘B), for a look: the pointer resting on the 8px at the window's left edge, under the title
 * band, slides it out over the page at its own width; the pointer going elsewhere on the page puts it away, as does
 * Escape. Its toggle keeps it out for good (Show sidebar). Like the phone's drawer it stays mounted, off the screen and
 * inert while away, so a look is one transform and keeps its scroll and open folders.
 * Pointer moves tell where the pointer is, not enter and leave: a move inside a menu or card it opened passes through
 * it (React bubbles through portals), and a pointer that has not moved since it came out is still on it.
 */
function SidebarFlyout({ width }: { width: number }) {
  const [open, setOpen] = useState(false);
  const flyout = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The last pointer move that passed through it: the window's own listener, which hears every move after it, tells.
  const moved = useRef<Event | null>(null);
  const wait = (ms: number, then: () => void) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(then, ms);
  };
  const putAway = () => {
    clearTimeout(timer.current);
    if (flyoutHeld(flyout.current)) return wait(FLYOUT_CLOSE_MS, putAway);
    // Focus in it falls to the page once it goes inert: the way back takes it, once its own toggle is inert too.
    const focused = flyout.current?.contains(document.activeElement) ?? false;
    setOpen(false);
    if (focused) requestAnimationFrame(focusSidebarToggle);
  };
  useEffect(() => {
    if (!open) return;
    const onMove = (e: globalThis.PointerEvent) => {
      if (e.pointerType === "touch") return;
      if (moved.current === e) clearTimeout(timer.current);
      else wait(FLYOUT_CLOSE_MS, putAway);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !flyoutHeld(flyout.current)) putAway();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <div
        aria-hidden
        data-sidebar-edge=""
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch" && e.buttons === 0) wait(FLYOUT_OPEN_MS, () => setOpen(true));
        }}
        onPointerLeave={() => {
          if (!open) clearTimeout(timer.current);
        }}
        className="fixed bottom-0 left-0 top-10 z-40 w-2"
      />
      <div
        ref={flyout}
        inert={!open}
        onPointerMove={(e) => (moved.current = e.nativeEvent)}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex border-r-[0.5px] border-border bg-sidebar transition-[transform,box-shadow] motion-reduce:transition-none",
          open ? "translate-x-0 shadow-overlay duration-300 ease-drawer" : "pointer-events-none -translate-x-full duration-200 ease-snap",
        )}
      >
        <SidebarPanel width={width} flyout />
      </div>
    </>
  );
}

/**
 * On a phone, the sidebar is a drawer over the page, as wide as the phone app's (the screen less 64px, at most 360).
 * A page's menu button opens it (SidebarMenuButton); the scrim, Escape, its Hide button, a thumb pushing it back to the
 * left and whatever it opens shut it.
 * It stays mounted, slid off the screen and inert while shut: opening it is one transform, not a whole sidebar built
 * again, and it keeps its scroll and open folders, as the phone app's does.
 */
function SidebarDrawer() {
  const open = useSidebarDrawer();
  // Every navigation is a new location, its key alone is not: an address changed by hand comes back "default".
  const location = useLocation();
  useEffect(() => setSidebarDrawer(false), [location]);
  const drawer = useRef<HTMLDivElement>(null);
  const swipe = useSwipeAway(drawer, () => setSidebarDrawer(false));
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.current?.focus({ preventScroll: true });
    // A menu open inside the drawer takes its own Escape first (Radix marks it handled).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setSidebarDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected && drawer.current?.contains(document.activeElement)) opener.focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <>
      <div
        aria-hidden
        onClick={() => setSidebarDrawer(false)}
        className={cn("fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 ease-snap motion-reduce:transition-none", open ? "opacity-100" : "pointer-events-none opacity-0")}
      />
      <div
        ref={drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        tabIndex={-1}
        inert={!open}
        {...swipe}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[min(calc(100vw-64px),360px)] touch-pan-y bg-sidebar outline-none transition-transform duration-300 ease-drawer motion-reduce:transition-none",
          "pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)]",
          open ? "translate-x-0 shadow-overlay" : "-translate-x-full",
        )}
      >
        <SidebarPanel />
      </div>
    </>
  );
}

/**
 * A drawer a thumb pushes back where it came from: a sideways drag to the left moves it with the finger; let go past a
 * third of its width, or with a flick, and `onAway` shuts it, sliding on from where the finger left it; short of that it
 * slides back. A drag that starts up or down is a scroll and is left alone (touch-pan-y keeps those for the browser).
 * While the finger holds it the drawer's own transform waits; letting go hands it back, so its transition does the rest.
 */
function useSwipeAway(panel: RefObject<HTMLElement | null>, onAway: () => void) {
  const drag = useRef<{ id: number; x: number; y: number; t: number; dx: number; sideways: boolean | null } | null>(null);
  const release = () => {
    const el = panel.current;
    if (!el) return;
    el.style.transition = "";
    el.style.transform = "";
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, sideways: null };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      const el = panel.current;
      if (!d || d.id !== e.pointerId || !el) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (d.sideways === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        d.sideways = Math.abs(dx) > Math.abs(dy) && dx < 0;
        if (!d.sideways) return void (drag.current = null);
      }
      d.dx = Math.min(0, dx);
      el.style.transition = "none";
      el.style.transform = `translateX(${d.dx}px)`;
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      drag.current = null;
      const el = panel.current;
      if (!d?.sideways || !el) return;
      const flick = d.dx / Math.max(1, e.timeStamp - d.t) < -0.5;
      release();
      if (d.dx < -el.offsetWidth / 3 || flick) onAway();
    },
    onPointerCancel: () => {
      const d = drag.current;
      drag.current = null;
      if (d?.sideways) release();
    },
  };
}

/**
 * The sidebar's right edge: drag it, or focus it and use the arrow keys (Shift for bigger steps, Home and End for the
 * bounds); a double click puts the default back. A drag writes the width straight to the sidebar and saves it on
 * release, so its rows never re-render per pointer move.
 */
function ResizeEdge({ width, aside }: { width: number; aside: RefObject<HTMLElement | null> }) {
  const drag = useRef<{ x: number; width: number; now: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onKeyDown={(e) => {
        const next = keyedSidebarWidth(width, e.key, e.shiftKey);
        if (next === null) return;
        e.preventDefault();
        setSidebarWidth(next);
      }}
      onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH.default)}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width, now: width };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !aside.current) return;
        d.now = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, d.width + e.clientX - d.x)));
        aside.current.style.width = `${d.now}px`;
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && d.now !== width) setSidebarWidth(d.now);
      }}
      onPointerCancel={() => {
        drag.current = null;
        if (aside.current) aside.current.style.width = `${width}px`;
      }}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:rounded-full after:transition-colors hover:after:bg-border focus-visible:after:bg-ring"
    />
  );
}

/**
 * Add a project by dropping it on the sidebar: in the desktop app, which can read where it lives, a folder or file
 * from Finder or another editor (a file adds the folder it is in); anywhere, a GitHub link. Then the chats Claude Code
 * and Codex had there come in too (project.import_chats). Each goes through project.create, as Add project's
 * dialog does, one at a time; the first that fails stops the rest and says why. `note` is the line under the
 * heading while it adds or after it failed.
 */
function useProjectDrop(onAdded: (project: { id: string }) => void) {
  const { client } = useRuntimeClient();
  const create = useProjectCreate(onAdded);
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The project whose chats are coming in, then what came in (for a few seconds).
  const [importing, setImporting] = useState<string | null>(null);
  const [told, setTold] = useState<string | null>(null);
  useEffect(() => {
    if (told === null) return;
    const t = setTimeout(() => setTold(null), 8_000);
    return () => clearTimeout(t);
  }, [told]);
  const pathFor = window.cavemanDesktop?.pathForFile;
  const readsPaths = pathFor !== undefined;
  const accept = (e: DragEvent<HTMLElement>) => {
    if (!carriesProject(e.dataTransfer.types, readsPaths)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setOver(true);
  };
  /**
   * Each project, then its past Claude Code and Codex chats (project.import_chats; a project added before brings in only
   * the ones it has not). A scan of a busy home can take a while: it may run up to ten minutes.
   */
  const addAll = async (found: DroppedProject[]) => {
    const running = create.busy ?? importing;
    if (running !== null) return setProblem(`Still adding ${running}. Drop it again when that's done.`);
    if (found.length === 0) return setProblem("That isn't a folder or a GitHub link.");
    setProblem(null);
    setTold(null);
    for (const params of found) {
      const project = await create.add(droppedName(params), params);
      if (!project || !client) return;
      setImporting(project.name);
      try {
        const result = await client.call("project.import_chats", { request_id: requestId(), project_id: project.id }, { timeoutMs: 10 * 60_000 });
        setTold(importedLine(project.name, result));
      } catch (e) {
        return setProblem(`${project.name} is added, but its chats could not be brought in: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setImporting(null);
      }
    }
  };
  const handlers = {
    onDragEnter: accept,
    onDragOver: accept,
    // Leaving for one of its own rows is still over the sidebar.
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!carriesProject(e.dataTransfer.types, readsPaths)) return;
      e.preventDefault();
      setOver(false);
      // Read now: the drop's contents are gone once this handler returns.
      const dt = e.dataTransfer;
      const files = pathFor ? [...dt.files].map(pathFor) : [];
      void addAll(droppedProjects(files, (type) => dt.getData(type), readsPaths));
    },
  };
  const failed = problem ?? create.error;
  const status = create.busy !== null ? `Adding ${create.busy}…` : importing !== null ? `Bringing in ${importing}'s chats from Claude Code and Codex…` : told;
  const note =
    status !== null ? (
      <p role="status" className="px-2 pb-1 text-[13px] leading-4 text-muted-foreground">
        {status}
      </p>
    ) : failed ? (
      <p role="alert" className="px-2 pb-1 text-[13px] leading-4 text-destructive">
        {failed}
      </p>
    ) : null;
  return { over, readsPaths, handlers, note };
}

/** Over the sidebar while a folder or link is held above it: the one blue "here" (STYLE.md 3), as a split view's drop zone. */
function ProjectDropZone() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-1 z-30 grid place-items-center rounded-xl bg-background/70 outline outline-2 outline-target backdrop-blur-[2px] animate-in fade-in-0 duration-100 ease-snap motion-reduce:animate-none">
      <span className="flex items-center gap-1.5 rounded-full bg-target-strong px-3 py-1 text-[12px] font-medium text-target-foreground shadow-overlay">
        <Icon icon={FolderOpenIcon} className="size-3.5" />
        Add as a project
      </span>
    </div>
  );
}

// New chat's keycap stays out of sight until the button is hovered or keyboard-focused.
const keycapOnHover = "opacity-0 transition-opacity duration-100";

/**
 * The sidebar open: `width` beside the page, dragged on its edge; none in the phone's drawer, which it fills. Out for
 * a look while tucked away (`flyout`), its toggle keeps it.
 */
function SidebarPanel({ width, flyout = false }: { width?: number; flyout?: boolean }) {
  const asideRef = useRef<HTMLElement>(null);
  const { client } = useRuntimeClient();
  const listed = useRuntimeSelector((v) => v.workspaces);
  // An automation's steps are not chats: the run view opens them. Nor are the chats Tidy is archiving, already gone.
  const tidied = useTidyGone();
  const workspaces = useMemo(() => listed.filter((w) => w.automationStep !== true && !tidied.has(w.id)), [listed, tidied]);
  const projects = useRuntimeSelector((v) => v.projects);
  const identity = useRuntimeSelector((v) => v.identity);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const { workspaceId } = useParams();
  const onNewChat = useMatch("/new") !== null;
  const navigate = useNavigate();
  const goTab = useTabNav();
  const pinnedIds = useMemo(() => new Set(pinnedChats(workspaces).map((w) => w.id)), [workspaces]);
  // Pinned workspaces live in their own section, not twice.
  const folders = useMemo(() => foldersForSidebar(projects, workspaces.filter((w) => !pinnedIds.has(w.id))), [projects, workspaces, pinnedIds]);
  const statuses = useMemo(() => chatStatuses(workspaces), [workspaces]);
  const statusStore = useStatusStore(statuses);
  // Every folder with its pinned chats too: the filter's project list, and which folder each chat lives in.
  const allFolders = useMemo(() => foldersForSidebar(projects, workspaces), [projects, workspaces]);
  // Each project's chats, its pinned ones too: what its folded row's amber dot reads.
  const boardRows = useMemo(() => new Map(allFolders.map((f) => [f.project.id, f.rows] as const)), [allFolders]);
  const homes = useMemo(() => new Map(allFolders.flatMap((f) => f.rows.flatMap((r) => [r.workspace, ...r.children].map((w) => [w.id, f.project.id] as const)))), [allFolders]);
  const [filter, setFilter] = useSidebarFilter();
  // A project that is gone (removed, or its last chat archived) no longer scopes anything; none picked is every one.
  const scopeKey = filter.projects.filter((id) => allFolders.some((f) => f.project.id === id)).join("\n");
  const scope = useMemo(() => (scopeKey === "" ? [] : scopeKey.split("\n")), [scopeKey]);
  const shownFolders = useMemo(() => filterFolders(folders, filter.show, scope, statuses), [folders, filter.show, scope, statuses]);
  const projectOrder = useSidebarOrder(shownFolders.map((f) => f.project.id), "caveman.projectOrder", folders.map((f) => f.project.id));
  const orderedFolders = projectOrder.order.flatMap((id) => shownFolders.find((f) => f.project.id === id) ?? []);
  const inScope = (w: WorkspaceView) => scope.length === 0 || scope.includes(homes.get(w.id) ?? "");
  const filtering = filter.show !== "all" || scope.length > 0;
  // The chats the filter shows, pinned ones too: Pinned and the queue list these, and the Queue bell reads them.
  const shownChats = useMemo(
    () => (filtering ? workspaces.filter((w) => (scope.length === 0 || scope.includes(homes.get(w.id) ?? "")) && passesFilter(filter.show, w, statuses.get(w.id) ?? null)) : workspaces),
    [filtering, workspaces, scope, homes, filter.show, statuses],
  );
  // The Queue bell's dot: one of those waits on the person, on the queue's clock so a snooze that ends lights it in
  // either view.
  const waiting = waitsOnYou(useQueueSections(shownChats, statuses).sections, statuses);
  // Archived projects with no folder left (no live chat outside Pinned): the fold under the folders.
  const archived = useMemo(() => archivedProjects(projects, folders), [projects, folders]);
  // Tidy takes the old chats of what the sidebar shows: a project filter narrows it, and an old chat is never one that
  // needs you, works or is unread. Never a chat open in a tab, the front one or another, nor one on another computer:
  // this window's runtime archives its own chats only.
  const tabs = useTabs();
  const onScreen = useMemo(() => tabs.list.flatMap((t) => leaves(t.layout.root).flatMap((p) => p.workspaceId ?? [])), [tabs]);
  const hub = useSyncHub();
  // Asked with the time the ⋯ menu opens (TidyItem), never one kept from an earlier render.
  const oldAt = (now: number) => (filter.show === "all" ? tidyable(workspaces, statuses, new Set([...onScreen, ...(workspaceId ? [workspaceId] : []), ...workspaces.filter((w) => hub && w.sessionId && hub.throughHub(w.sessionId)).map((w) => w.id)]), now).filter((w) => scope.length === 0 || scope.includes(homes.get(w.id) ?? "")) : []);
  const [closed, setOpen] = useClosedFolders();
  const [queue, setQueue] = useStoredFlag(QUEUE_KEY);
  // Focus mode: only New chat and the chats; what sits between them, above the divider, folds away.
  const [focus, setFocus] = useStoredFlag(FOCUS_KEY);
  const plan = usePlanMeter();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Projects being removed: their folders leave at once, and come back if the runtime refuses.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const add = useAddProject((p) => setOpen(p.id, true));
  const drop = useProjectDrop((p) => setOpen(p.id, true));
  // A browser window Caveman Cloud serves has no computer of its own: its chats are Cloud's list, and a project is
  // added only while the window has a runtime to add it to. Review, Plugins, Automations and the Chiefs stay in their
  // places either way: Review reads Cloud, and the rest say where they are and what brings them here (NeedsMac).
  const web = useWebWindow();
  const noRuntime = web !== null && client === null;
  const act = (call: Promise<unknown>, done?: string) => {
    setProblem(null);
    call
      .then(() => {
        if (done) announce(done);
        return refresh();
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  // Pin, archive and their undo are the project's own (project.update); archiving unpins, so it leaves the top.
  const organize = (project: { id: string; name: string }, change: { pinned?: boolean; archived?: boolean }, done: string) =>
    client && act(client.call("project.update", { request_id: requestId(), project_id: project.id, ...change }), done);
  // A folder taken away leaves at once, and comes back if the runtime refuses.
  const takeAway = (id: string, work: Promise<unknown>, done: string) => {
    const mark = (on: boolean) =>
      setRemoving((was) => {
        const next = new Set(was);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
    mark(true);
    setProblem(null);
    work
      .then(() => {
        announce(done);
        return refresh();
      })
      .catch((e: unknown) => {
        setProblem(e instanceof Error ? e.message : String(e));
        return refresh();
      })
      .finally(() => mark(false));
  };
  const chatCount = (n: number) => (n === 1 ? "1 chat" : `${n} chats`);
  // Remove takes its chats with it (archived first, each one back with Restore, which brings the project back too).
  const remove = (project: { id: string; name: string }, chats: number) => {
    if (!client) return;
    if (chats > 0) announce(`Archiving ${chatCount(chats)} and removing ${project.name}.`);
    takeAway(project.id, client.call("project.remove", { request_id: requestId(), project_id: project.id, ...(chats > 0 ? { archive_chats: true } : {}) }, { timeoutMs: 10 * 60_000 }), `Removed ${project.name}.`);
  };
  // A folder with no project behind it (foldersForSidebar's stand-in, "No repository" or a repo's name) is only its
  // chats: it goes when they are archived, one at a time as Remove project's are, pinned ones too, each back with Restore.
  // A chat on another computer is archived there, through the sync hub (as its row loads it); one that can't be (its
  // computer asleep) stays, the rest still go, and the problem line says how many stayed and why.
  const archiveChats = (folder: SidebarFolder) => {
    if (!client) return;
    const chats = (allFolders.find((f) => f.project.id === folder.project.id) ?? folder).rows.flatMap((r) => [r.workspace, ...r.children]);
    announce(`Archiving ${chatCount(chats.length)}.`);
    const work = (async () => {
      const failed: string[] = [];
      for (const w of chats) {
        const on = hub && w.sessionId && hub.throughHub(w.sessionId) ? chatClientFor(hub, w.sessionId) : client;
        await on.call("workspace.archive", { request_id: requestId(), workspace_id: w.id }).catch((e: unknown) => failed.push(e instanceof Error ? e.message : String(e)));
      }
      if (failed.length > 0) throw new Error(`${chatCount(failed.length)} of ${chats.length} stayed: ${failed[0]}`);
    })();
    takeAway(folder.project.id, work, `Archived ${chatCount(chats.length)}.`);
  };
  // Opening a workspace (from search, a link, a reload) opens its folder once; the user may shut it again.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceId || revealed.current === workspaceId) return;
    const home = folders.find((f) => f.rows.some((r) => r.workspace.id === workspaceId || r.children.some((c) => c.id === workspaceId)));
    if (!home) return;
    revealed.current = workspaceId;
    setOpen(home.project.id, true);
  }, [workspaceId, folders]);
  // Everything about the list in one menu beside its heading, in both views: add a project, what it shows, and Search.
  const chatsMenu = (
    <ChatsMenu
      filter={{ ...filter, projects: scope }}
      onChange={setFilter}
      folders={allFolders}
      counts={(f) => workspaces.filter((w) => w.state !== "archived" && inScope(w) && passesFilter(f, w, statuses.get(w.id) ?? null)).length}
      onAdd={noRuntime ? null : add.start}
      tidy={<TidyItem old={oldAt} />}
    />
  );
  // The computer it runs on is the name's tooltip; a browser window runs on none.
  const appName = (
    <span title={web ? undefined : identity.computerName} className="ml-2 min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em] text-sidebar-accent-foreground">
      Caveman <span className="font-normal text-muted-foreground">Code</span>
    </span>
  );
  return (
    <aside ref={asideRef} data-sidebar data-focus-area="sidebar" aria-label="Sidebar" style={{ width }} className={cn("relative flex shrink-0 flex-col text-sidebar-foreground", width === undefined && "min-w-0 flex-1")} {...drop.handlers}>
      {width === undefined ? null : <ResizeEdge width={width} aside={asideRef} />}
 {/* Hide sidebar, Back and Forward, then the app's name : beside the traffic lights in the
          desktop app's title band (Windows and full screen start it 12px in); in a browser, the same row heads the
          sidebar, without Back and Forward, which the browser has. */}
      {IS_DESKTOP ? (
        <TitleBar>
          <SidebarToggle hidden={flyout} />
          <HistoryNav className="ml-0.5" />
          {appName}
        </TitleBar>
      ) : (
        <div className="flex h-10 shrink-0 items-center px-3">
          <SidebarToggle hidden={flyout} />
          {appName}
        </div>
      )}

      <StatusContext.Provider value={statusStore}>
      {/* New chat stays whatever the hairline under the top does: the top folds and sizes under it. */}
      <div className="shrink-0 px-3 pb-3 pt-1">
        {/* One click to a new chat on the default engine; ⌘N from the desktop menu. ⌘-click: in a new tab (⌘T).
            The page changes in the click's own task (flushSync), not as a transition behind it: the chat it leaves would
            stay on screen meanwhile and take the first keys typed for the new one. */}
        <NavLink
          to="/new"
          data-tour="new-chat"
          onClick={(e) => {
            if (wantsNewTab(e)) {
              e.preventDefault();
              goTab(windowTabs.openNewChat());
              return;
            }
            // A modified click is the browser's own (a new window or tab).
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            // Already there, the entry is replaced, as NavLink's own click does: Back leaves New chat in one step.
            void navigate("/new", { flushSync: true, replace: onNewChat });
          }}
          className={cn(
            "group/new px-play-hover flex h-8 w-full items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 text-[13px] font-medium text-foreground outline-none",
            "shadow-[inset_0_1px_0_hsl(var(--foreground)/0.05),0_1px_2px_hsl(0_0%_0%/0.25)] transition-[background-color,transform] duration-100 ease-snap",
            "hover:bg-accent active:scale-[0.985] focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent",
          )}
        >
          <NavIcon name="new" />
          New chat
          {window.cavemanDesktop ? <Keycap className={cn("ml-auto bg-transparent", keycapOnHover, "group-hover/new:opacity-100 group-focus-visible/new:opacity-100")}>{formatChord("mod+n")}</Keycap> : null}
        </NavLink>
      </div>
      <SidebarTop focus={focus} onFocus={setFocus}>
        <nav data-tour="places" className="px-3 pb-2">
          <ReviewRow />
          <NavRow to="/plugins" icon="spaces" label="Plugins" />
          <NavRow to="/automations" icon="automations" label="Automations" />
        </nav>
        <div className="px-3 pb-2">
          <ChiefsSection workspaces={workspaces} />
        </div>
      </SidebarTop>
      {web?.window.kind === "app" ? <ListFailed failed={web.window.failed} /> : null}
      {/* What the list shows while a filter is on, over the chats it narrows. */}
      {filtering ? (
        <div className="shrink-0 px-3">
          <FilterLine
            show={filter.show}
            projects={filterProjectsLabel(allFolders.filter((f) => scope.includes(f.project.id)).map((f) => f.project.name))}
            onClear={() => setFilter({ ...filter, show: "all", projects: [] })}
          />
        </div>
      ) : null}

      {queue ? (
        <>
          <div className="shrink-0 px-3">
            <ChatsHeader queue onQueue={setQueue} waiting={waiting} byTopic={filter.group === "topic"}>
              {chatsMenu}
            </ChatsHeader>
          </div>
          {drop.note ? <div className="shrink-0 px-3">{drop.note}</div> : null}
          <Queue workspaces={shownChats} projects={projects} empty={filtering ? EMPTY[filter.show] : "No chats yet"} />
        </>
      ) : (
        // By topic, the column is a flex one: what is over (Done, Closed groups, Archived) sits at its foot, as the queue's.
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-3 pb-4 [scrollbar-width:none]", filter.group === "topic" && "flex flex-col")}>
          <PinnedSection workspaces={shownChats} renderRow={(w) => <WorkspaceRow workspace={w} />} />
          <section aria-label={filter.group === "topic" ? "Chats" : "Projects"} data-tour="projects" className={cn("mt-5 first:mt-0", filter.group === "topic" && "flex flex-1 flex-col")}>
            <ChatsHeader queue={false} onQueue={setQueue} waiting={waiting} byTopic={filter.group === "topic"}>
              {chatsMenu}
            </ChatsHeader>
            {problem ? (
              <p role="alert" className="px-2 pb-1 text-[13px] leading-4 text-destructive">
                {problem}
              </p>
            ) : null}
            {drop.note}
            {filtering && shownFolders.length === 0 ? (
              <SurfaceEmpty title={EMPTY[filter.show]} action={<QuietButton onClick={() => setFilter({ ...filter, show: "all", projects: [] })}>Show all chats</QuietButton>} className={SIDEBAR_EMPTY} />
            ) : folders.length === 0 && archived.length === 0 ? (
              noRuntime ? (
                // No runtime to add a project to: a chat started from New chat makes the first folder here.
                <SurfaceEmpty title="No chats yet" className={SIDEBAR_EMPTY} />
              ) : (
                <SurfaceEmpty title="No projects yet" action={<QuietButton onClick={add.start}>Add a project</QuietButton>} className={SIDEBAR_EMPTY}>
                  A folder or a GitHub repository{drop.readsPaths ? ", or drop one here" : ""}. Its chats show here.
                </SurfaceEmpty>
              )
            ) : filter.group === "topic" ? (
              <TopicList folders={shownFolders.filter((folder) => !removing.has(folder.project.id))} all={allFolders} closed={closed} setOpen={setOpen} projects={projects} />
            ) : (
              orderedFolders.filter((folder) => !removing.has(folder.project.id)).map((folder) => (
                <ProjectFolder
                  key={folder.project.id}
                  folder={folder}
                  arrange={projectOrder}
                  boardRows={boardRows.get(folder.project.id) ?? folder.rows}
                  open={!closed.has(folder.project.id)}
                  onToggle={() => setOpen(folder.project.id, closed.has(folder.project.id))}
                  onNewChat={() => navigate(`/new?project=${encodeURIComponent(folder.project.id)}`)}
                  renaming={renaming === folder.project.id}
                  onRename={(name) => {
                    setRenaming(null);
                    if (client && name && name !== folder.project.name) {
                      act(client.call("project.update", { request_id: requestId(), project_id: folder.project.id, name }));
                    }
                  }}
                  actions={
                    client && folder.project.path !== null
                      ? {
                          rename: () => setRenaming(folder.project.id),
                          copyPath: () => void navigator.clipboard.writeText(folder.project.path ?? ""),
                          // Every open chat in it, its pinned ones too (they sit in Pinned, not in the folder).
                          chats: allFolders.find((f) => f.project.id === folder.project.id)?.count ?? folder.count,
                          remove: (chats) => remove(folder.project, chats),
                          initGit: () => act(client.call("project.init_git", { request_id: requestId(), project_id: folder.project.id })),
                          pin: () =>
                            folder.project.pinnedAt
                              ? organize(folder.project, { pinned: false }, `Unpinned ${folder.project.name}.`)
                              : organize(folder.project, { pinned: true }, `Pinned ${folder.project.name} to the top.`),
                          archive: () =>
                            folder.project.archivedAt
                              ? organize(folder.project, { archived: false }, `Restored ${folder.project.name}.`)
                              : organize(folder.project, { archived: true, pinned: false }, `Archived ${folder.project.name}.`),
                        }
                      : null
                  }
                  standIn={
                    client && folder.project.path === null
                      ? { chats: allFolders.find((f) => f.project.id === folder.project.id)?.count ?? folder.count, archive: () => archiveChats(folder) }
                      : null
                  }
                />
              ))
            )}
            {!filtering && client && filter.group === "project" ? (
              <ArchivedProjects projects={archived} onRestore={(p) => organize(p, { archived: false }, `Restored ${p.name}.`)} />
            ) : null}
          </section>
        </div>
      )}
      </StatusContext.Provider>

      <TidyNotice />
      {/* Focus mode leaves the chats alone: no checklist or plan meter under them (a live call stays: it is going on). */}
      {focus ? null : <GettingStarted />}
      {/* A call goes on while you work elsewhere: back to it, mute or hang up from here. At the foot, so the nav
          above never moves when you leave the Chief's page. */}
      <ChiefCallPill />
      {/* Free leads to a plan over the account row; a plan's week is the ring in it. Nothing without a Caveman plan. */}
      {!focus && plan?.kind === "credits" ? <GetAPlanRow meter={plan} /> : null}
      <div className="flex h-[34px] items-center gap-1 pb-1 pl-3 pr-2">
        <NavLink
          to="/settings/account"
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-[13px] font-medium hover:bg-sidebar-accent/60"
        >
          <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[12px] font-semibold text-foreground">
            {identity.userName.slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate text-sidebar-accent-foreground/90">{identity.userName}</span>
          {identity.plan ? <span className="truncate">· {identity.plan}</span> : null}
        </NavLink>
        {!focus && plan?.kind === "windows" ? <PlanRing meter={plan} /> : null}
        <UpdatePill />
        <NavLink to="/settings" aria-label="Settings" className={iconButton}>
          <NavIcon name="settings" />
        </NavLink>
      </div>
      <SidebarPeek root={asideRef} workspaces={workspaces} folders={allFolders} statuses={statuses} />
      <DragLayer />
      {add.dialog}
      {drop.over ? <ProjectDropZone /> : null}
    </aside>
  );
}

/**
 * The call pill, naming the Chief on the call; hidden on that Chief's page, where the call has the box's place, unless
 * Mission control has the conversation's (the stage goes with it). Its way back to the call is that page, without it.
 */
export function ChiefCallPill() {
  const call = useCall();
  const chiefs = useChiefs();
  const navigate = useNavigate();
  const target = callChief(chiefs.chiefs, call.chiefId);
  const [search] = useSearchParams();
  const here = useMatch(target.path) !== null && !search.has(MISSION_PARAM);
  if (here) return null;
  return <CallPill {...(target.name ? { name: target.name } : {})} onOpen={() => navigate(target.path)} />;
}

/** Review: pull requests across the projects; the amber count is how many ask for your review. */
function ReviewRow() {
  const { client } = useRuntimeClient();
  const queue = useQueue(client);
  return <NavRow to="/review" icon="review" label="Review" count={needsYou(queue.value?.prs ?? [])} urgent />;
}

function NavRow({ to, icon, label, count, urgent, dot, className }: { to: string; icon: PixelIconName; label: string; count?: number; urgent?: boolean; dot?: boolean; className?: string }) {
  // ⌘-click opens the page in a tab of its own.
  const go = useTabNav();
  const inNewTab = (e: MouseEvent<HTMLElement>) => {
    if (!wantsNewTab(e)) return;
    e.preventDefault();
    go(windowTabs.openPage(to));
  };
  // A count that went up hops once (px-bump); the key restarts the hop on each rise.
  const last = useRef(count ?? 0);
  const rose = (count ?? 0) > last.current;
  useEffect(() => void (last.current = count ?? 0), [count]);
  // A dot says "something needs you" without a number to read; the count stays in its tooltip.
  const trailing = !count ? undefined : dot ? (
    <span key={rose ? count : "rest"} role="img" aria-label={`${count} need you`} title={`${count} need you`} className={cn(rose && "px-bump", "mr-1 size-2 rounded-full bg-warning")} />
  ) : (
    <span
      key={rose ? count : "rest"}
      className={cn(rose && "px-bump", urgent && "grid h-[18px] min-w-[18px] place-items-center rounded-[5px] bg-warning/15 px-1 text-[11.5px] font-medium tabular-nums text-warning")}
    >
      {count}
    </span>
  );
  return (
    <NavButton
      asChild
      icon={icon}
      trailing={trailing}
      className={cn("nav-row mb-px h-7 text-[13px] font-normal hover:bg-sidebar-accent/60", className)}
    >
      <NavLink to={to} onClick={inNewTab} onAuxClick={inNewTab}>
        {label}
      </NavLink>
    </NavButton>
  );
}

/** Set by the queue button's press: the header it mounts in the other view plays the change once (never on a launch). */
let turning = false;

/**
 * Above the chats: their heading (Projects, or Queue for the queue view), then the Queue bell and `children`, the
 * list's ⋯ menu, last on the row. The bell is a ghost key as the ⋯ is, filled while the queue shows; pressed, it sinks
 * and swings as the heading changes with the list. Its blue dot: a chat waits on the person (inbox-state.ts
 * waitsOnYou), shown only while the chats sit by project, since the queue puts those chats first.
 */
function ChatsHeader({ queue, onQueue, waiting, byTopic = false, children }: { queue: boolean; onQueue: (queue: boolean) => void; waiting: boolean; /** Grouped by topic: the heading names the chats, not their projects. */ byTopic?: boolean; children?: ReactNode }) {
  // The two views render their header in different places: the one that mounts after a press plays the change.
  const [turned] = useState(() => turning);
  useEffect(() => void (turning = false), []);
  const dot = waiting && !queue;
  return (
    <div className="flex h-8 items-center gap-0.5 pl-2">
      <h2 data-turned={turned || undefined} className="chats-heading flex-1 text-[12px] font-medium text-[hsl(var(--subtle-foreground))]">
        {queue ? "Queue" : byTopic ? "Chats" : "Projects"}
      </h2>
      <button
        type="button"
        aria-pressed={queue}
        aria-label={dot ? "Queue, a chat needs you" : "Queue"}
        data-tour="queue"
        title={queue ? (byTopic ? "Show chats by topic" : "Show chats by project") : "Show chats as a queue: what needs you first"}
        data-turned={turned || undefined}
        onClick={() => {
          turning = true;
          onQueue(!queue);
        }}
        className={cn(iconButton, "queue-bell size-7 text-muted-foreground", queue && "bg-sidebar-accent text-sidebar-accent-foreground")}
      >
        <Icon icon={dot ? BellDotIcon : Notification01Icon} className="size-4" />
      </button>
      {children}
    </div>
  );
}

const QUEUE_KEY = "caveman.sidebarQueue";
const FOCUS_KEY = "caveman.sidebarFocus";

/** A sidebar switch kept on this device ("1" or "0"), off until first set: the queue view, focus mode, folded Chiefs. */
function useStoredFlag(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => localStorage.getItem(key) === "1");
  const set = (next: boolean) => {
    localStorage.setItem(key, next ? "1" : "0");
    setOn(next);
  };
  return [on, set];
}

const TOP_KEY = "caveman.sidebarTop";

/** A row of the sidebar's top is at most this tall (its rows are 28 to 33px, a Chief's 44px); anything taller is a group of rows. */
const TOP_ROW = 48;

/**
 * Where the rows of the top end, in px from its top: each row's bottom edge, a row being anything up to a row tall (a
 * place) or a block with nothing inside it. Read from the page, so whatever the top holds is counted as it is.
 */
function topRowEdges(content: HTMLElement): number[] {
  const top = content.getBoundingClientRect().top;
  const edges: number[] = [];
  const walk = (el: Element) => {
    const box = el.getBoundingClientRect();
    if (box.height === 0) return;
    if (box.height <= TOP_ROW || el.children.length === 0) edges.push(box.bottom - top);
    else for (const child of el.children) walk(child);
  };
  for (const child of content.children) walk(child);
  return edges;
}

/** How tall the sidebar's top may be when it isn't folded, kept on this device: a height it scrolls within, or null for all of it. */
function useTopCap(): [number | null, (next: number | null) => void] {
  const [cap, setCap] = useState(() => {
    const stored = Math.round(Number(localStorage.getItem(TOP_KEY)));
    return stored >= SIDEBAR_TOP.fold ? stored : null;
  });
  const set = (next: number | null) => {
    if (next === null) localStorage.removeItem(TOP_KEY);
    else localStorage.setItem(TOP_KEY, String(next));
    setCap(next);
  };
  return [cap, set];
}

/**
 * What sits between New chat and the chats (the places, the Chiefs), then the hairline under it with a quiet
 * do-not-disturb toggle in the middle: the moon and an up arrow fold the top away so only New chat and the chats show
 * (focus mode). While it is on, the toggle lights up, the moon tips over and says "Focus", and its down arrow brings the
 * top back. The hairline, moon included, drags row by row, never stopping halfway through one: up, the chats grow and
 * the top keeps the rows left (three of five Chiefs, say), scrolling within them; under its first row it folds away as
 * the moon does; down, it comes back, up to all of it. A double click on the hairline shows all of it; focused, the
 * arrow keys move it a row, Home folds and End shows all. A drag writes the height straight to the top and saves it on
 * release, so the sidebar's rows never re-render per pointer move. Folded, the top is inert, so Tab never lands in what
 * isn't there.
 */
function SidebarTop({ focus, onFocus, children }: { focus: boolean; onFocus: (on: boolean) => void; children: ReactNode }) {
  const id = useId();
  const [cap, setCap] = useTopCap();
  // The height it folded from: the fold starts where a drag or a key left it, not at the cap.
  const [held, setHeld] = useState<number | null>(null);
  // All of it, as tall as its rows need.
  const [full, setFull] = useState(0);
  const fold = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = content.current!;
    const seen = new ResizeObserver(() => setFull(el.offsetHeight));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const shown = focus ? 0 : Math.min(cap ?? full, full);
  const limit = focus ? (held ?? cap) : cap;
  const drag = useRef<{ y: number; from: number; now: number; stops: number[] | null } | null>(null);
  const stops = () => sidebarTopStops(topRowEdges(content.current!), full);
  // A drag that began on the moon ends without a click on it: set when a drag lets go, until the click that follows
  // it (late after a touch) or the next press. A key's click (detail 0) is never one.
  const dragged = useRef(false);
  /** Leave the top at `height`, from `from` on screen now: written to the page first, so the render that follows finds it so. */
  const settle = (height: number, from: number) => {
    const el = box.current!;
    const next = settleSidebarTop(height, full);
    if (next === 0) {
      el.style.maxHeight = `${from}px`;
      setHeld(from);
      onFocus(true);
      return;
    }
    el.style.maxHeight = next === null ? "" : `${next}px`;
    setCap(next);
    onFocus(false);
  };
  // Half a pixel on a retina screen: present, never a band across the sidebar. Lit while the hairline is hovered or focused.
  const rule = (
    <span
      aria-hidden
      className="pointer-events-none h-px flex-1 origin-center scale-y-50 bg-border/70 transition-colors duration-100 group-hover/divider:bg-border group-has-[[role=separator]:focus-visible]/divider:bg-ring"
    />
  );
  return (
    <>
      {/* Folding runs its rows from 1fr to 0fr; the cap is the box's max height, which it scrolls within. */}
      <div
        ref={fold}
        id={id}
        inert={focus}
        className={cn("grid shrink-0 transition-[grid-template-rows] duration-200 ease-snap motion-reduce:transition-none", focus ? "grid-rows-[0fr]" : "grid-rows-[1fr]")}
      >
        <div ref={box} style={{ maxHeight: limit ?? undefined }} className="min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-width:none]">
          <div ref={content}>{children}</div>
        </div>
      </div>
      <div
        className="group/divider relative flex h-6 shrink-0 cursor-row-resize touch-none select-none items-center gap-1.5 px-3"
        onPointerDown={(e) => {
          dragged.current = false;
          if (e.button !== 0) return;
          // Held by what was pressed, so the moves come here wherever the pointer goes, and a press on the moon that
          // never moves is still its click.
          (e.target as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, from: shown, now: shown, stops: null };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dy = e.clientY - d.y;
          if (!d.stops) {
            if (Math.abs(dy) < 3) return;
            d.stops = stops();
            // Open, even folded, and follow the pointer row by row with no easing.
            fold.current!.style.gridTemplateRows = "1fr";
            fold.current!.style.transition = "none";
          }
          d.now = snapSidebarTop(d.from + dy, d.stops);
          box.current!.style.maxHeight = `${d.now}px`;
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (!d?.stops) return;
          dragged.current = true;
          fold.current!.style.gridTemplateRows = "";
          fold.current!.style.transition = "";
          settle(d.now, d.now);
        }}
        onPointerCancel={() => {
          const d = drag.current;
          drag.current = null;
          if (!d?.stops) return;
          fold.current!.style.gridTemplateRows = "";
          fold.current!.style.transition = "";
          box.current!.style.maxHeight = limit === null ? "" : `${limit}px`;
        }}
        onClickCapture={(e) => {
          if (!dragged.current || e.detail === 0) return;
          dragged.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Height above the chats"
          aria-controls={id}
          aria-valuemin={0}
          aria-valuemax={full}
          aria-valuenow={shown}
          tabIndex={0}
          title="Drag to resize, double-click to show all"
          onKeyDown={(e) => {
            const next = keyedSidebarTop(shown, stops(), e.key);
            if (next === null) return;
            e.preventDefault();
            settle(next, shown);
          }}
          onDoubleClick={() => settle(full, shown)}
          className="absolute inset-0 outline-none"
        />
        {rule}
        <button
          type="button"
          aria-expanded={!focus}
          aria-controls={id}
          aria-label={focus ? "Focus mode on: show everything" : "Focus mode: show only chats"}
          title={focus ? "Show everything" : "Focus mode: show only chats"}
          onClick={() => {
            setHeld(null);
            onFocus(!focus);
          }}
          className={cn(
            // Over the hairline's separator, which takes the drag and the keys around it.
            "relative flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium outline-none",
            "transition-[background-color,color,opacity,transform] duration-100 ease-snap active:scale-[0.96] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-ring",
            focus
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-[hsl(var(--subtle-foreground))] opacity-60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Icon icon={Moon02Icon} className={cn("size-3 transition-transform duration-300 ease-snap motion-reduce:transition-none", focus && "-rotate-[24deg]")} strokeWidth={2} />
          {focus ? <span className="leading-none">Focus</span> : null}
          <Icon icon={focus ? ArrowDown01Icon : ArrowUp01Icon} className="size-3" strokeWidth={2} />
        </button>
        {rule}
      </div>
    </>
  );
}

const FILTER_KEY = "caveman.sidebarFilter";

/**
 * The sidebar's filter, kept on this device: which chats it shows, from which projects (none: every one), and whether
 * they sit in their projects' folders or in groups by kind of work.
 */
interface SidebarFilter {
  readonly show: ChatFilter;
  readonly projects: ReadonlyArray<string>;
  readonly group: SidebarGrouping;
}

type SidebarGrouping = "project" | "topic";

const GROUPINGS: ReadonlyArray<{ readonly id: SidebarGrouping; readonly label: string }> = [
  { id: "project", label: "Project" },
  { id: "topic", label: "Topic" },
];

const SHOW: ReadonlyArray<{ readonly id: ChatFilter; readonly label: string }> = [
  { id: "all", label: "All chats" },
  { id: "needs", label: "Needs you" },
  { id: "working", label: "At work" },
  { id: "unread", label: "Unread" },
];

/** What an empty filtered sidebar says. */
const EMPTY: Record<ChatFilter, string> = {
  all: "No chats in this project yet",
  needs: "Nothing waits on you",
  working: "Nothing is at work",
  unread: "You have read everything",
};

/** The sidebar's empty states sit in the list, not centred in the column: no stretch, a little less room. */
const SIDEBAR_EMPTY = "flex-none px-2 py-6";

function useSidebarFilter(): [SidebarFilter, (next: SidebarFilter) => void] {
  const [filter, setFilterState] = useState<SidebarFilter>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null") as { show?: unknown; project?: unknown; projects?: unknown; group?: unknown } | null;
      const show = SHOW.find((o) => o.id === v?.show)?.id ?? "all";
      return { show, projects: storedFilterProjects(v), group: v?.group === "topic" ? "topic" : "project" };
    } catch {
      return { show: "all", projects: [], group: "project" };
    }
  });
  const set = (next: SidebarFilter) => {
    localStorage.setItem(FILTER_KEY, JSON.stringify(next));
    setFilterState(next);
  };
  return [filter, set];
}

/**
 * The ⋯ beside the chats' heading, read top to bottom as three groups split by rules, no headings: add a project
 * (compact two ways in, each opening the dialog on its own tab, ProjectPicker useAddProject); what the list shows,
 * each a row naming its pick in grey ("Show  Needs you ›"); then Search every chat, by what was said and done in it.
 * Group by puts the chats in their projects' folders or in groups by topic (TopicList).
 * Show is one-of with how many each would show; Projects scopes the list .tsx
 * project scope @ ab3a3cd1; several at once, #25284), ticked on and off with the menu left open. Lit while it filters.
 */
function ChatsMenu({
  filter,
  onChange,
  folders,
  counts,
  onAdd,
  tidy,
}: {
  filter: SidebarFilter;
  onChange: (next: SidebarFilter) => void;
  folders: ReadonlyArray<SidebarFolder>;
  counts: (show: ChatFilter) => number;
  /** Null where no runtime can take a project (a browser window with every place asleep): the rows are not drawn. */
  onAdd: ((tab: "folder" | "github", returnTo: HTMLElement | null) => void) | null;
  /** Tidy's row (Tidy.tsx TidyItem), under what the list shows. */
  tidy: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  // Search opens its own dialog once the menu has closed, so the closing menu can't take focus back from its field.
  const searching = useRef(false);
  // Search's chord as bound now (Settings > Keyboard can change it).
  const searchChord = useKeybindings()["app.search"] ?? chord("app.search");
  const on = filter.show !== "all" || filter.projects.length > 0;
  const show = SHOW.find((o) => o.id === filter.show)!.label;
  const projects = filterProjectsLabel(folders.filter((f) => filter.projects.includes(f.project.id)).map((f) => f.project.name)) ?? "Every project";
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        ref={trigger}
        aria-label={on ? "Chat list options, filtered" : "Chat list options"}
        title={onAdd ? "Add a project, filter or search" : "Filter or search"}
        className={cn(iconButton, "size-7 text-muted-foreground data-[state=open]:bg-sidebar-accent", on && "bg-sidebar-accent text-sidebar-accent-foreground")}
      >
        <Icon icon={MoreHorizontalIcon} className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[244px]"
        onCloseAutoFocus={(e) => {
          if (!searching.current) return;
          searching.current = false;
          e.preventDefault();
          // Focus back on ⋯ first, as the menu would give it: closing search brings it back there.
          trigger.current?.focus();
          runShortcut("app.search");
        }}
      >
        {onAdd ? (
          <>
            <DropdownMenuItem onSelect={() => onAdd("folder", trigger.current)}>
              <Icon icon={FolderOpenIcon} /> Add folder…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAdd("github", trigger.current)}>
              <BrandMark name="github" /> Add from GitHub…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger value={show}>
            <Icon icon={ListFilterIcon} /> Show
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[200px]">
            <DropdownMenuRadioGroup value={filter.show} onValueChange={(v) => onChange({ ...filter, show: SHOW.find((o) => o.id === v)?.id ?? "all" })}>
              {SHOW.map((o) => (
                <DropdownMenuRadioItem key={o.id} value={o.id}>
                  <span className="flex-1">{o.label}</span>
                  <span className="tabular-nums text-muted-foreground">{counts(o.id)}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger value={projects} disabled={folders.length === 0}>
            <Icon icon={Folder01Icon} /> Projects
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[232px]">
            <DropdownMenuCheckboxItem checked={filter.projects.length === 0} onCheckedChange={() => onChange({ ...filter, projects: [] })}>
              Every project
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {folders.map((f) => (
              <DropdownMenuCheckboxItem
                key={f.project.id}
                checked={filter.projects.includes(f.project.id)}
                // Several at once: ticking one leaves the menu open for the next.
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => onChange({ ...filter, projects: toggleFilterProject(filter.projects, f.project.id) })}
                title={f.project.path ?? f.project.name}
              >
                <span className="min-w-0 flex-1 truncate">{f.project.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger value={GROUPINGS.find((g) => g.id === filter.group)!.label}>
            <Icon icon={DashboardSquare01Icon} /> Group by
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[180px]">
            <DropdownMenuRadioGroup value={filter.group} onValueChange={(v) => onChange({ ...filter, group: GROUPINGS.find((g) => g.id === v)?.id ?? "project" })}>
              {GROUPINGS.map((g) => (
                <DropdownMenuRadioItem key={g.id} value={g.id}>
                  {g.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {tidy}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          aria-keyshortcuts={ariaChord(searchChord)}
          onSelect={() => {
            searching.current = true;
          }}
        >
          <Icon icon={Search01Icon} /> Search chats
          <DropdownMenuShortcut>{formatChord(searchChord)}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How long Cloud's list may be out of reach before the sidebar says so: a stream that drops and reopens says nothing. */
const LIST_FAILED_AFTER_MS = 4_000;

/**
 * Over the chats while Cloud's list cannot be read (state/sync/chat-list.ts asks again by itself, with a growing
 * wait): one line, over what this device last had. Its live region stays mounted so the line is read when it appears.
 */
export function ListFailed({ failed, after = LIST_FAILED_AFTER_MS }: { failed: boolean; after?: number }) {
  const [shown, setShown] = useState(failed && after <= 0);
  useEffect(() => {
    if (!failed) return setShown(false);
    if (after <= 0) return setShown(true);
    const timer = setTimeout(() => setShown(true), after);
    return () => clearTimeout(timer);
  }, [failed, after]);
  return (
    <div role="status" aria-live="polite" className={shown ? "shrink-0 px-5 pb-1 text-[12px] leading-4 text-muted-foreground" : "sr-only"}>
      {shown ? LIST_FAILED_LINE : null}
    </div>
  );
}

/** Under New chat while a filter is on: what the list shows, and the way back to every chat. */
function FilterLine({ show, projects, onClear }: { show: ChatFilter; projects: string | null; onClear: () => void }) {
  const what = SHOW.find((o) => o.id === show)!.label;
  const line = projects ? `${what} in ${projects}` : what;
  return (
    <div className="mt-1.5 flex h-6 items-center gap-1 pl-2.5 text-[12.5px] text-muted-foreground">
      {/* Two long project names run past the sidebar: the whole line is in its tooltip. */}
      <span className="min-w-0 flex-1 truncate" title={line}>
        {line}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear the filter"
        title="Show all chats"
        className="grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors duration-75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon icon={Cancel01Icon} className="size-3.5" />
      </button>
    </div>
  );
}

/** Now, moved on each minute so the queue's ages stay current on an idle sidebar. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The queue's shelves (inbox-state.ts queueSections) at a now moved each minute, so ages stay current on an idle
 * sidebar, and at the next snooze's wake: snooze times are to the second, so a chat comes back then, not up to a
 * minute later (T3).
 */
function useQueueSections(workspaces: ReadonlyArray<WorkspaceView>, statuses: ReadonlyMap<string, ChatStatus | null>): { sections: QueueSections; now: number } {
  const minute = useMinute();
  const [wakeTick, setWakeTick] = useState(0);
  const now = Math.max(minute, wakeTick);
  const sections = useMemo(() => queueSections(workspaces, statuses, now), [workspaces, statuses, now]);
  const nextWake = sections.snoozed[0]?.inbox?.snoozedUntil ?? null;
  useEffect(() => {
    if (!nextWake) return;
    const timer = setTimeout(() => setWakeTick(Date.now()), Math.max(0, Date.parse(nextWake) - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [nextWake]);
  return { sections, now };
}

type QueueProject = { readonly id: string; readonly name: string; readonly repository?: RepositoryView };

/**
 * The queue view (inbox-state.ts queueSections, ). A chat's section
 * says where it stands, and it moves down the list as it lives: Pinned on top; Needs you (it asks, or its turn failed
 * unseen); Working (its turn, its agents or a queued message, by when it started, so rows hold still); Ready for
 * review (its turn ended and nobody has called it done yet, whatever it left); Done (called done, by the person or
 * by an agent for them; each says how long ago, or counts down to its archive). Nothing leaves the open list until
 * it is called done or snoozed. Then the folded shelves, Snoozed and Archived (Restore brings one back). Done,
 * Snoozed and Archived sit at the column's foot, so a short live list never has them right under it. The Done shelf's header carries its rules: when a
 * done chat is archived, when a quiet one is marked done, and Archive all. On hover a row's status gives way to Done,
 * upstream settle; a right-click opens Snooze, Pin and the rest.
 */
function Queue({ workspaces, projects, empty }: { workspaces: ReadonlyArray<WorkspaceView>; projects: ReadonlyArray<QueueProject>; empty: string }) {
  const statuses = useAllStatuses();
  const { sections, now } = useQueueSections(workspaces, statuses);
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const archiveAfter = useRuntimeSelector((v) => v.settings?.inbox_archive_done_after_days);
  const actions = useQueueActions();
  // A folded shelf still shows the chat that is open (T3): sending a message moves it into Working, and it stays in view.
  const { workspaceId: openId } = useParams();
  const [menu, setMenu] = useState<{ x: number; y: number; workspace: WorkspaceView } | null>(null);
  const [customSnooze, setCustomSnooze] = useState<WorkspaceView | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameChosen = useRef(false);
  const row = (w: WorkspaceView, section: QueueSection) => (
    <QueueRow
      key={w.id}
      workspace={w}
      section={section}
      project={w.projectId ? byId.get(w.projectId) : undefined}
      now={now}
      archivesAt={section === "done" ? archivesAt(w, archiveAfter) : null}
      actions={actions}
      onMenu={actions ? (x, y) => setMenu({ x, y, workspace: w }) : undefined}
      renaming={renaming === w.id}
      onRenamed={(title) => {
        setRenaming(null);
        if (actions && title && title !== w.title) actions.rename(w, title);
      }}
    />
  );
  const { pinned, needs, working, review, snoozed, done } = sections;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4 [scrollbar-width:none]">
      {pinned.length + needs.length + working.length + review.length + snoozed.length + done.length === 0 ? <SurfaceEmpty title={empty} className={SIDEBAR_EMPTY} /> : null}
      {pinned.length > 0 ? (
        <section className={SECTION} aria-label="Pinned">
          <ShelfHeader label="Pinned" />
          {pinned.map((w) => row(w, "pinned"))}
        </section>
      ) : null}
      {/* What waits on the person never folds away. */}
      {needs.length > 0 ? (
        <section className={SECTION} aria-label="Needs you">
          <ShelfHeader label="Needs you" />
          {needs.map((w) => row(w, "needs"))}
        </section>
      ) : null}
 {/* Live work starts open (STYLE.md rule 8); Done and Snoozed start folded, as upstream settled and snoozed shelves. */}
      <Shelf id="working" label="Working" rows={working} openId={openId} renderRow={(w) => row(w, "working")} openAtFirst />
      <Shelf id="review" label="Ready for review" rows={review} openId={openId} renderRow={(w) => row(w, "review")} openAtFirst />
      {/* What is over sits at the foot of the column, however little is live above it. */}
      <div className="mt-auto pt-1">
        <Shelf id="done" label="Done" rows={done} openId={openId} renderRow={(w) => row(w, "done")} paged end={actions && done.length > 0 ? <DoneRules rows={done} /> : null} />
        <Shelf id="snoozed" label="Snoozed" rows={snoozed} openId={openId} renderRow={(w) => row(w, "snoozed")} />
        {actions ? <ArchivedShelf projects={byId} now={now} openId={openId} /> : null}
      </div>
      {actions ? (
        <DropdownMenu open={menu !== null} onOpenChange={(o) => !o && setMenu(null)} modal={false}>
          <DropdownMenuTrigger asChild>
            <span aria-hidden className="pointer-events-none fixed size-0" style={menu ? { left: menu.x, top: menu.y } : { left: -9999, top: -9999 }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={2} className="w-[210px]" onCloseAutoFocus={(e) => keepRenameFocus(e, renameChosen)}>
            {menu ? (
              <ChatMenuItems
                workspace={menu.workspace}
                onRename={() => {
                  renameChosen.current = true;
                  setRenaming(menu.workspace.id);
                }}
                onCustomSnooze={() => setCustomSnooze(menu.workspace)}
                onArchive={menu.workspace.state === "working" ? null : () => actions.archive(menu.workspace)}
              />
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {customSnooze ? <CustomSnoozeDialog workspace={customSnooze} open onOpenChange={(o) => !o && setCustomSnooze(null)} /> : null}
    </div>
  );
}

/** A queue section: its header's 32px carries the space between sections, as upstream shelves. */
const SECTION = "mt-1 first:mt-0";

type QueueSection = "pinned" | "needs" | "working" | "review" | "snoozed" | "done";

interface QueueActions {
  readonly inbox: (w: WorkspaceView, action: InboxAction) => void;
  readonly archive: (w: WorkspaceView) => void;
  readonly rename: (w: WorkspaceView, title: string) => void;
}

/** A row's one-click actions; null on a fixture runtime. A refusal is said aloud. */
function useQueueActions(): QueueActions | null {
  const inbox = useInbox();
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  if (!inbox || !client) return null;
  return {
    inbox: (w, action) => inbox(w.id, action),
    archive: (w) =>
      void client.call("workspace.archive", { request_id: requestId(), workspace_id: w.id }).then(
        () => (announce(`Archived ${w.title}.`), refresh()),
        (e: unknown) => announce(e instanceof Error ? e.message : String(e)),
      ),
    rename: (w, title) =>
      void client.call("workspace.rename", { request_id: requestId(), workspace_id: w.id, title }).then(refresh, (e: unknown) => announce(e instanceof Error ? e.message : String(e))),
  };
}

const CLOSED_KEY = "caveman.closedFolders";

/** Folders the user shut, by project id, kept on this device. Folders start open. */
function useClosedFolders(): [ReadonlySet<string>, (id: string, open: boolean) => void] {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]") as unknown;
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  });
  const setOpen = (id: string, open: boolean) =>
    setClosed((prev) => {
      if (prev.has(id) !== open) return prev;
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
      return next;
    });
  return [closed, setOpen];
}

const ARCHIVE_AFTER_DAYS = [1, 3, 7, 14, 30] as const;
const QUIET_DAYS = [1, 3, 7, 14] as const;
const inDays = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * The Done shelf's rules, on the shelf itself.
 * Its header says when a done chat is archived ("Auto-archive 7d") and opens the rules, the same settings as Settings >
 * General > Inbox: archive done chats after N days or never, mark a finished chat done after N quiet days or never,
 * and Archive all now, which asks first and then archives them as Tidy does: one after another, out of the list at once,
 * with Undo.
 */
function DoneRules({ rows }: { rows: ReadonlyArray<WorkspaceView> }) {
  const settings = useRuntimeSelector((v) => v.settings);
  const tidy = useTidy(rows);
  const save = useSaveSettings();
  const [asking, setAsking] = useState(false);
  const after = settings?.inbox_archive_done_after_days ?? null;
  const quiet = settings?.inbox_done_after_days ?? null;
  const n = rows.length;
  const choose = (value: string) => (value === "never" ? null : Number(value));
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={!settings}
          title={after === null ? "Done chats stay until you archive them" : `A done chat is archived ${inDays(after)} after it was marked done`}
          className="h-6 shrink-0 rounded-md px-1.5 text-[12px] font-normal tabular-nums text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=open]:text-foreground"
        >
          {after === null ? "Auto-archive off" : `Auto-archive ${after}d`}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[260px]">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger value={after === null ? "Never" : `After ${after}d`}>Archive done chats</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[200px]">
              <DropdownMenuRadioGroup value={after === null ? "never" : String(after)} onValueChange={(v) => void save({ inbox_archive_done_after_days: choose(v) })}>
                {ARCHIVE_AFTER_DAYS.map((d) => (
                  <DropdownMenuRadioItem key={d} value={String(d)}>
                    After {inDays(d)}
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuRadioItem value="never">Never</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            {/* A finished chat with nothing new for that long is marked done. */}
            <DropdownMenuSubTrigger value={quiet === null ? "Never" : `After ${quiet}d`}>Mark done when quiet</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[200px]">
              <DropdownMenuRadioGroup value={quiet === null ? "never" : String(quiet)} onValueChange={(v) => void save({ inbox_done_after_days: choose(v) })}>
                {QUIET_DAYS.map((d) => (
                  <DropdownMenuRadioItem key={d} value={String(d)}>
                    After {inDays(d)}
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuRadioItem value="never">Never</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!tidy || tidy.busy} onSelect={() => setAsking(true)}>
            <Icon icon={Archive02Icon} /> Archive all {n} now…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Archive ${n} done ${n === 1 ? "chat" : "chats"}?`}
        description="Their worktrees go; uncommitted work is kept on each branch, and Restore brings a chat back."
        confirmLabel="Archive all"
        onConfirm={() => {
          setAsking(false);
          tidy?.run();
        }}
      />
    </>
  );
}

/** A queue section's header, as a menu's (STYLE.md §5): 12px grey; a shelf's folds, its chevron after the count. */
function SectionHeader({ label, count, open, onToggle }: { label: string; count?: number; open?: boolean; onToggle?: () => void }) {
  const body = (
    <>
      <span>{label}</span>
      {count !== undefined ? <span className="tabular-nums text-[hsl(var(--subtle-foreground))]">{count}</span> : null}
      {onToggle ? <Icon icon={ArrowRight01Icon} className={cn("size-3 text-[hsl(var(--subtle-foreground))] transition-transform duration-150", open && "rotate-90")} strokeWidth={2} /> : null}
    </>
  );
  const look = "flex h-7 items-center gap-1.5 px-2 text-[12px] font-medium text-muted-foreground";
  return onToggle ? (
    <button type="button" aria-expanded={open} onClick={onToggle} className={cn(look, "min-w-0 flex-1 rounded-md text-left outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}>
      {body}
    </button>
  ) : (
    <h2 className={look}>{body}</h2>
  );
}

/**
 * A queue section's header, upstream (CollapsibleSectionHeader): its name, a hairline to the edge, the shelf's own control
 * (`end`), and on a shelf that folds the chevron, down while open. The whole header folds it; `end` sits above that.
 */
function ShelfHeader({ label, open, onToggle, end }: { label: string; open?: boolean; onToggle?: () => void; end?: ReactNode }) {
  return (
    <div className="relative flex h-8 items-center gap-2 px-2 text-[12px] font-medium text-[hsl(var(--subtle-foreground))] transition-colors duration-75 has-[>button:hover]:text-muted-foreground">
      {onToggle ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={label}
          onClick={onToggle}
          className="absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      ) : null}
      <h2 aria-hidden={onToggle ? true : undefined} className="pointer-events-none shrink-0">
        {label}
      </h2>
      <span aria-hidden className="pointer-events-none h-px min-w-2 flex-1 bg-border" />
      {end ? <span className="relative flex shrink-0 items-center">{end}</span> : null}
      {onToggle ? <Icon icon={ArrowDown01Icon} className={cn("pointer-events-none size-3 shrink-0 transition-transform duration-150", !open && "rotate-180")} strokeWidth={2} /> : null}
    </div>
  );
}

/** Done shows this many before "Show more", then pages by SHELF_PAGE (upstream settled tail). */
const SHELF_FIRST = 10;
const SHELF_PAGE = 25;

/**
 * A queue section that folds, the choice kept on this device (upstream shelves): Working and Ready for review start open,
 * Done, Snoozed and Archived folded (Done, opened, shows its first ten). Folded, a shelf still shows the chat that is
 * open (`openId`), so the chat in front of the person never vanishes behind a fold. A snoozed chat comes back when it
 * wakes; a done one with its next message, or with Undo; an archived one with Restore.
 */
function Shelf<T extends { readonly id: string }>({ id, label, rows, openId, renderRow, paged = false, openAtFirst = false, end }: { id: string; label: string; rows: ReadonlyArray<T>; openId?: string | undefined; renderRow: (row: T) => ReactNode; paged?: boolean; openAtFirst?: boolean; end?: ReactNode }) {
  const key = `caveman.queue.${id}Open`;
  const [open, setOpen] = useState(() => {
    const kept = localStorage.getItem(key);
    return kept === null ? openAtFirst : kept === "1";
  });
  const [count, setCount] = useState(SHELF_FIRST);
  if (rows.length === 0) return null;
  const toggle = () => {
    localStorage.setItem(key, open ? "0" : "1");
    setOpen(!open);
  };
  const page = paged ? rows.slice(0, count) : rows;
  // The open chat stays in view: alone while folded, and after the page when it sits past it.
  const past = open && openId !== undefined && !page.some((r) => r.id === openId) ? rows.filter((r) => r.id === openId) : [];
  const shown = open ? [...page, ...past] : rows.filter((r) => r.id === openId);
  return (
    <section className={SECTION} aria-label={label}>
      <ShelfHeader label={label} open={open} onToggle={toggle} end={end} />
      {shown.map(renderRow)}
      {open && rows.length > page.length + past.length ? (
        <button type="button" onClick={() => setCount(count + SHELF_PAGE)} className="flex h-8 items-center rounded-md px-2.5 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          Show {Math.min(SHELF_PAGE, rows.length - page.length - past.length)} more
        </button>
      ) : null}
    </section>
  );
}

/**
 * The Archived shelf, the end of a chat's way down the queue: archived by hand or by the Done shelf's rule, newest
 * first (state/archived.ts loads them; the live list leaves them out). A row opens its chat, which offers Restore
 * too; Restore on hover brings it back into the list with its uncommitted work. Every archived chat, with search, is
 * in Settings > Archived chats.
 */
function ArchivedShelf({ projects, now, openId }: { projects: ReadonlyMap<string, QueueProject>; now: number; openId: string | undefined }) {
  const { chats, restore } = useArchivedChats();
  const [busy, setBusy] = useState<string | null>(null);
  const bringBack = (w: Workspace) => {
    setBusy(w.id);
    restore(w.id).then(
      () => announce(`Restored ${w.title}.`),
      (e: unknown) => announce(e instanceof Error ? e.message : String(e)),
    ).finally(() => setBusy(null));
  };
  return (
    <Shelf
      id="archived"
      label="Archived"
      rows={chats ?? []}
      openId={openId}
      paged
      end={
        <NavLink to="/settings/archived" className="flex h-6 shrink-0 items-center rounded-md px-1.5 text-[12px] font-normal text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          See all
        </NavLink>
      }
      renderRow={(w) => <ArchivedRow key={w.id} workspace={w} project={w.project_id ? projects.get(w.project_id) : undefined} now={now} busy={busy === w.id} onRestore={() => bringBack(w)} />}
    />
  );
}

/** An archived chat's row: upstream slim row a step quieter, its project's name and when it was archived; Restore on hover. */
function ArchivedRow({ workspace, project, now, busy, onRestore }: { workspace: Workspace; project: QueueProject | undefined; now: number; busy: boolean; onRestore: () => void }) {
  const navigate = useNavigate();
  const { workspaceId } = useParams();
  const selected = workspaceId === workspace.id;
  const repo = "path" in workspace.repo ? workspace.repo.path : workspace.repo.url;
  const where = project?.name ?? repo.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? repo;
  return (
    <div data-peek={`chat:${workspace.id}`} className="group/row relative py-0.5">
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        title={where}
        onClick={() => {
          // Opened from here, as from search: its pane reads it from the peek until Restore puts it back in the live list.
          peek(workspace);
          panes.show(workspace.id);
          navigate(chatPath(workspace.id));
        }}
        className={cn(
          SLIM,
          "outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/row:pr-[96px] group-has-[:focus-visible]/row:pr-[96px]",
          // A step under a read chat's 65% ink, on the description tier, which keeps 4.5:1.
          selected ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "font-normal text-muted-foreground hover:bg-sidebar-accent/60",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{workspace.title}</span>
        <time
          dateTime={workspace.updated_at}
          title={`Archived ${new Date(workspace.updated_at).toLocaleString()}`}
          className="shrink-0 text-[12px] font-normal tabular-nums text-[hsl(var(--subtle-foreground))] group-hover/row:hidden group-has-[:focus-visible]/row:hidden"
        >
          {rowAge(workspace.updated_at, now)}
        </time>
      </button>
      <span className={cn(ROW_ACTIONS, "top-1/2 -translate-y-1/2")}>
        <button
          type="button"
          disabled={busy}
          aria-label={`Restore ${workspace.title}`}
          title="Restore: its worktree and uncommitted work come back"
          onClick={onRestore}
          className={ROW_ACTION}
        >
          <Icon icon={Undo02Icon} className="size-3.5" />
          {busy ? "Restoring…" : "Restore"}
        </button>
      </span>
    </div>
  );
}

/**
 * Archived projects, folded at the foot of the Projects list (the choice kept on this device, folded at first): the
 * projects archived from a folder's menu that have no live chat left outside Pinned, most recently archived first.
 * Restore brings one back to the list and the pickers, as it was. Archiving never touches its chats or files.
 */
function ArchivedProjects({ projects, onRestore }: { projects: ReadonlyArray<Project>; onRestore: (project: Project) => void }) {
  const key = "caveman.sidebar.archivedProjectsOpen";
  const [open, setOpen] = useState(() => localStorage.getItem(key) === "1");
  if (projects.length === 0) return null;
  const toggle = () => {
    localStorage.setItem(key, open ? "0" : "1");
    setOpen(!open);
  };
  return (
    <section aria-label="Archived projects" className="mt-2">
      <div className="flex items-center">
        <SectionHeader label="Archived projects" count={projects.length} open={open} onToggle={toggle} />
      </div>
      {open ? (
        <ul className="flex flex-col">
          {projects.map((p) => (
            <li key={p.id} className="group/row relative flex h-[32px] items-center gap-2 rounded-lg pl-2 pr-1 transition-colors duration-75 hover:bg-sidebar-accent/60">
              <ProjectLogo projectId={p.id} logo={p.logo} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground" title={p.path}>
                {p.name}
              </span>
              <time dateTime={p.archived_at} title={`Archived ${new Date(p.archived_at!).toLocaleString()}`} className="shrink-0 text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))] transition-opacity duration-75 group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0">
                {rowAge(p.archived_at!, Date.now())}
              </time>
              {/* Restore shows on hover, and stays reachable by Tab (focus shows it too). */}
              <span className="pointer-events-none absolute right-1 top-1 flex items-center opacity-0 transition-opacity duration-75 group-hover/row:pointer-events-auto group-hover/row:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100">
                <button
                  type="button"
                  aria-label={`Restore ${p.name}`}
                  title="Restore: back in the list and the pickers"
                  onClick={() => onRestore(p)}
                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon icon={Undo02Icon} className="size-3.5" />
                  Restore
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Chats a folder shows before "Show more", besides any later one still at work or waiting (`folderRowsShown`). */
const FOLDER_ROWS = 8;
/** Chats each "Show more" adds: a long project opens a step at a time, never all at once. */
const FOLDER_PAGE = 15;
/** Show more and Show less, side by side under a folder's chats. */
const FOLDER_FOOT = "h-full rounded-md text-left text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** What on a project's row takes focus back: its fold button. */
const rowControl = (row: HTMLElement | null) => row?.querySelector<HTMLElement>("[data-sidebar-row]") ?? null;

/** Whether a chat of the project (its pinned ones too) waits on the person. What a Chief needs shows on the Chief's row. */
function useProjectWaits(rows: ReadonlyArray<SidebarRow>): boolean {
  const statuses = useAllStatuses();
  return useMemo(() => projectWaitsOnYou(rows, (w) => (statuses.has(w.id) ? statuses.get(w.id)! : chatStatus(w))), [rows, statuses]);
}

/** What shows only while a project's row is hovered, has keyboard focus, or has its menu open. */
const ON_ROW = "group-hover:flex group-has-[:focus-visible]:flex group-has-[[data-state=open]]:flex";
/** What steps aside for them: hidden while the row is hovered, focused from the keyboard, or its menu is open. */
const ON_ROW_HIDE = "group-hover:hidden group-has-[:focus-visible]:hidden group-has-[[data-state=open]]:hidden";

function DragDots() {
  return <span aria-hidden className="sidebar-drag-dots">{Array.from({ length: 6 }, (_, i) => <span key={i} />)}</span>;
}

/**
 * A project row's chevron, as a tile in its mark's 28px slot: hovered (or focused, or its menu open), it takes the
 * logo's place, pointing right while folded and down while open ("a tile sort of chevron that
 * replaces the logo"). It folds the chats and never opens anything; the row's menu says the same (Hide chats).
 */
function FoldTile({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      data-tone="card"
      data-order-handle=""
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onClick={onToggle}
      className="key project-fold grid size-7 touch-none place-items-center rounded-[9px] text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-hidden className="project-fold-glyph" data-open={open}><span className="send-glyph" data-glyph="send"><span /><span /></span></span>
      <DragDots />
    </button>
  );
}

/** The sidebar's raised New chat key, shared by project and Chief rows. */
function NewChatKey({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title="New chat in this project" onClick={onClick}
      className={cn(
        "px-play-hover grid size-6 place-items-center rounded-[7px] border border-border bg-card text-foreground outline-none",
        "shadow-[inset_0_1px_0_hsl(var(--foreground)/0.05),0_1px_2px_hsl(0_0%_0%/0.25)]",
        "transition-[background-color,transform] duration-150 ease-snap hover:bg-accent active:scale-[0.94] focus-visible:ring-2 focus-visible:ring-ring",
      )}>
      <NavIcon name="new" />
    </button>
  );
}

/**
 * A project's row: its logo (else the pixel folder) in a 28px slot and its name; a click folds its chats. Projects have
 * no Chief of their own: Chiefs have their own section. The name fades out where the row's
 * marks begin (styles.css `.project-name`). On hover the chevron tile takes the logo's slot (styles.css
 * `.folder-body`) and + comes over the name's end; a right-click, or the menu key on the focused row, opens its menu.
 */
function ProjectFolder({
  folder,
  boardRows,
  open,
  onToggle,
  onNewChat,
  renaming,
  onRename,
  actions,
  standIn,
  arrange,
}: {
  arrange: SidebarOrder;
  folder: SidebarFolder;
  /** Every chat its board shows, the pinned ones too (they sit in Pinned, not in the folder). */
  boardRows: ReadonlyArray<SidebarRow>;
  open: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  renaming: boolean;
  onRename: (name: string) => void;
  /** Absent for a folder that is only a repo (no project to rename or remove). */
  actions: FolderActions | null;
  /** A folder that is only a repo or "No repository": its menu archives its chats, which takes the folder away. */
  standIn: StandInActions | null;
}) {
  const { project, rows } = folder;
  // Opened past its first rows by Show more: a cutoff (`folderShowMore`), or every chat; null is folded.
  const [opened, setOpened] = useState<"all" | FolderCutoff | null>(null);
  // Its menu (a right-click, or the menu key and Shift+F10 on the focused row): where in the row it opens.
  const [menu, setMenu] = useState<{ readonly open: boolean; readonly x: number; readonly y: number }>({ open: false, x: 0, y: 0 });
 // Shut, a folder says the most pressing thing among its chats (upstream project status, resolveProjectStatusIndicator).
  const statuses = useAllStatuses();
  const folded = useMemo(() => (opened === "all" ? { shown: [...rows], hidden: 0 } : folderRowsShown(rows, FOLDER_ROWS, statuses, opened ?? undefined)), [rows, statuses, opened]);
  const shown = folded.shown;
  // Show less once it shows more than its first rows; Show more while any are left.
  const canLess = opened !== null && rows.length > FOLDER_ROWS;
  // The button pressed can go (the last Show more, Show less): focus moves to the one beside it, not to <body>.
  const moreButton = useRef<HTMLButtonElement>(null);
  const lessButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef<"more" | "less" | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const showMore = (e: MouseEvent<HTMLButtonElement>) => {
    const next = folderShowMore(rows, shown, FOLDER_PAGE);
    if (next === "all" && e.currentTarget === document.activeElement) refocus.current = "less";
    setOpened(next);
  };
  const showLess = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.currentTarget === document.activeElement) refocus.current = "more";
    setOpened(null);
  };
  useLayoutEffect(() => {
    const want = refocus.current;
    refocus.current = null;
    if (want === "less") (lessButton.current ?? rowControl(row.current))?.focus();
    if (want === "more") (moreButton.current ?? rowControl(row.current))?.focus();
  }, [opened]);
  const rollup = firstStatus(rows.flatMap((r) => [r.workspace, ...r.children]).map((w) => (statuses?.has(w.id) ? statuses.get(w.id)! : chatStatus(w))));
  // A rename finished from the keyboard puts focus back on the row, not on <body>.
  const refocusFolder = useRef(false);
  useEffect(() => {
    if (renaming || !refocusFolder.current) return;
    refocusFolder.current = false;
    rowControl(row.current)?.focus();
  }, [renaming]);
  /** Its menu at `point` (in the window), kept as where in the row it is, so it opens there. */
  const openMenu = (point: { readonly x: number; readonly y: number }) => {
    const box = row.current!.getBoundingClientRect();
    setMenu({ open: true, x: point.x - box.left, y: point.y - box.top });
  };
  const name = `${project.name}${project.pinnedAt ? ", pinned" : ""}${project.archivedAt ? ", archived" : ""}`;
  // Logos stay bare; without one, the pixel folder.
  const mark = (
    <span className="project-mark grid size-7 shrink-0 place-items-center">
      <ProjectLogo projectId={project.id} logo={project.logo} open={open} className="text-sidebar-foreground" />
    </span>
  );
  // Shut, it says what its chats are at, else the amber dot while one waits on you.
  const shut = !open && rollup !== null && !rollup.action ? rollup : null;
  const waits = useProjectWaits(boardRows);
  // How far over the name's end the marks reach (styles.css .project-name): at rest, folded, its state or the dot
  // (16 + 2); hovered, New chat (24 + 2).
  const cut = { rest: shut || (waits && !open) ? 18 : 0, hover: 26 };
  return (
    // A little air under each project, as the reference parts them.
    <div className="mb-1">
      <div
        ref={(node) => { row.current = node; arrange.ref(project.id, node); }}
        data-order-name={project.name}
        data-order-id={project.id}
        data-arranging={arrange.dragging === project.id || undefined}
        data-order-drop={arrange.landing?.id === project.id ? arrange.landing.after ? "after" : "before" : undefined}
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={(e) => { if (!renaming) arrange.pointerDown(project.id, e); }}
        onClickCapture={(e) => arrange.clickCapture(project.id, e)}
        data-peek={renaming ? undefined : `project:${project.id}`}
        onContextMenu={(e) => {
          if ((!actions && !standIn) || renaming) return;
          e.preventDefault();
          openMenu(menuPoint(e));
        }}
        onKeyDown={(e) => {
          if (!renaming && arrange.keyDown(project.id, e)) return;
          if ((!actions && !standIn) || renaming || !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
          e.preventDefault();
          const box = row.current!.getBoundingClientRect();
          openMenu({ x: box.left, y: box.bottom });
        }}
        style={{ "--rest-cut": `${cut.rest}px`, "--hover-cut": `${cut.hover}px` } as CSSProperties}
        className="project-row sidebar-order-row group relative flex h-8 touch-pan-y select-none items-center rounded-lg"
      >
        {renaming ? (
          <div className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 pr-1">
            {mark}
            <input
              autoFocus
              defaultValue={project.name}
              aria-label="Project name"
              onFocus={(e) => e.currentTarget.select()}
              onChange={markTyped}
              onBlur={(e) => onRename(renamedTo(e.currentTarget, project.name) ?? project.name)}
              onKeyDown={(e) => {
                // An input method's Enter picks its candidate and its Escape cancels the composition: neither ends the rename.
                if (isComposing(e)) return;
                if (e.key === "Enter") {
                  refocusFolder.current = true;
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  refocusFolder.current = true;
                  e.currentTarget.value = project.name;
                  e.currentTarget.blur();
                }
              }}
              className="h-6 min-w-0 flex-1 rounded-md border border-ring/60 bg-background px-1.5 text-[13px] font-medium text-foreground outline-none"
            />
          </div>
        ) : (
          <>
            {/* The whole row folds its chats; what sits on it lets clicks through, but its buttons. */}
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              data-sidebar-row=""
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              aria-label={name}
              aria-description={waits ? "A chat here needs you" : undefined}
              className="absolute inset-0 rounded-lg outline-none transition-colors duration-75 group-hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
            <span aria-hidden className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 pl-2">
              <span className="relative grid size-7 shrink-0 place-items-center">
                {mark}
              </span>
              <span className={cn("project-name min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[13px] font-medium", project.archivedAt ? "text-muted-foreground" : "text-sidebar-accent-foreground/90")}>
                {project.name}
                {project.pinnedAt ? <Icon icon={PinIcon} className="ml-1.5 inline size-3 align-[-1px] text-[hsl(var(--subtle-foreground))]" /> : null}
                {project.archivedAt ? <span className="ml-1.5 text-[12px] font-normal text-[hsl(var(--subtle-foreground))]">Archived</span> : null}
              </span>
            </span>
            <div className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"><FoldTile open={open} label={`${open ? "Hide" : "Show"} ${project.name}'s chats`} onToggle={onToggle} /></div>
            <div className="relative flex shrink-0 items-center pr-1">
              {/* At rest, over the name's end, only while folded: its chats' state, else the amber dot while the project
                  waits on you, so what needs the person stays in sight. Unfolded, its chats show their own. Hovered (or focused, or its menu open),
                  New chat comes over it instead, the existing raised key. */}
              {shut || (waits && !open) ? (
                <div className={cn("pointer-events-none absolute right-full top-0 flex h-full items-center pr-0.5", ON_ROW_HIDE)}>
                  {shut ? (
                    <span className="flex">
                      <StatusMark status={shut} compact />
                    </span>
                  ) : (
                    <span aria-hidden data-waits="" className="grid size-4 place-items-center">
                      <span className="size-[6px] rounded-full bg-warning" />
                    </span>
                  )}
                </div>
              ) : null}
              <div className={cn("absolute right-full top-0 hidden h-full items-center gap-0.5 pr-0.5", ON_ROW)}>
                <NewChatKey label={`New chat in ${project.name}`} onClick={onNewChat} />
              </div>
            </div>
          </>
        )}
        {actions ? (
          <FolderMenu
            folder={folder}
            menu={menu}
            onOpenChange={(o) => setMenu((m) => ({ ...m, open: o }))}
            onClosed={() => rowControl(row.current)?.focus()}
            onNewChat={onNewChat}
            actions={actions}
            fold={{ open, toggle: onToggle }}
          />
        ) : standIn ? (
          <StandInMenu
            folder={folder}
            menu={menu}
            onOpenChange={(o) => setMenu((m) => ({ ...m, open: o }))}
            onClosed={() => rowControl(row.current)?.focus()}
            actions={standIn}
          />
        ) : null}
      </div>
      <div className="folder-body" data-open={open || undefined} inert={!open}>
        <div>
          <div className="ml-[21px] pl-[13px]">
            {/* The folder's rule: a hairline down its chats from under the row's mark, a row at a time so it parts around a
                pull request's glyph on it (prOnRule). Every row's words start at pl-2.5, under the project's name, glyph or not. */}
            {shown.map(({ workspace, children }, i) => (
              <div key={workspace.id} className="folder-row relative" style={{ "--i": i } as CSSProperties}>
                <span aria-hidden className="folder-rule" data-gap={prOnRule(workspace) || undefined} />
                <WorkspaceRow workspace={workspace} prOnRule />
                <Builders lead={workspace} builders={children} />
              </div>
            ))}
            {folded.hidden > 0 || canLess ? (
              <div className="folder-row folder-foot relative flex h-[30px] items-center gap-3 pl-2.5" style={{ "--i": shown.length } as CSSProperties}>
                <span aria-hidden className="folder-rule" />
                {folded.hidden > 0 ? (
                  <button ref={moreButton} type="button" onClick={showMore} className={FOLDER_FOOT}>
                    Show more
                  </button>
                ) : null}
                {canLess ? (
                  <button ref={lessButton} type="button" onClick={showLess} className={FOLDER_FOOT}>
                    Show less
                  </button>
                ) : null}
              </div>
            ) : null}
            {rows.length === 0 ? (
              <button
                type="button"
                onClick={onNewChat}
                className="folder-row flex h-[28px] w-full items-center gap-1.5 rounded-lg pl-2.5 text-left text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Icon icon={Add01Icon} className="size-3" />
                Start a chat
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

const TOPIC_ORDER_KEY = "caveman.topicOrder";
const TOPIC_MARKS_KEY = "caveman.topicMarks";

/**
 * The person's arrangement of the sidebar by topic, kept on this device: TopicItem keys, top to bottom. Set it, or
 * change it from what it is when the change lands (a rename's, once its chats have moved).
 */
function useTopicOrder(): [ReadonlyArray<string>, (next: ReadonlyArray<string> | ((was: ReadonlyArray<string>) => ReadonlyArray<string>)) => void] {
  const [order, setOrder] = useState<ReadonlyArray<string>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(TOPIC_ORDER_KEY) ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
    } catch {
      return [];
    }
  });
  const set = (next: ReadonlyArray<string> | ((was: ReadonlyArray<string>) => ReadonlyArray<string>)) =>
    setOrder((was) => {
      const value = typeof next === "function" ? next(was) : next;
      localStorage.setItem(TOPIC_ORDER_KEY, JSON.stringify(value));
      return value;
    });
  return [order, set];
}

/**
 * The person's marks on groups (TopicMarks), kept on this device by topic with the order: pinned, and reopened.
 * `mark` sets one; `share` gives a group being renamed its marks under both names while its chats move (shareMarks),
 * and `carry` settles them on the new name (carryMarks), or drops them (null) on an ungroup.
 */
function useTopicMarks(): {
  readonly marks: TopicMarks;
  readonly mark: (topic: string, which: keyof TopicMarks, on: boolean) => void;
  readonly share: (from: string, to: string) => void;
  readonly carry: (from: string, to: string | null) => void;
} {
  const read = (): TopicMarks => {
    try {
      const v = JSON.parse(localStorage.getItem(TOPIC_MARKS_KEY) ?? "{}") as { pinned?: unknown; kept?: unknown };
      const names = (x: unknown) => new Set(Array.isArray(x) ? x.filter((k): k is string => typeof k === "string") : []);
      return { pinned: names(v.pinned), kept: names(v.kept) };
    } catch {
      return { pinned: new Set(), kept: new Set() };
    }
  };
  const [marks, setMarks] = useState<TopicMarks>(read);
  // From the marks as they are when the change lands: a rename's comes once its chats have moved.
  const save = (change: (was: TopicMarks) => TopicMarks) =>
    setMarks((was) => {
      const next = change(was);
      localStorage.setItem(TOPIC_MARKS_KEY, JSON.stringify({ pinned: [...next.pinned], kept: [...next.kept] }));
      return next;
    });
  const toggled = (set: ReadonlySet<string>, topic: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(topic);
    else next.delete(topic);
    return next;
  };
  return {
    marks,
    mark: (topic, which, on) => save((was) => ({ ...was, [which]: toggled(was[which], topic, on) })),
    share: (from, to) => save((was) => shareMarks(was, from, to)),
    carry: (from, to) => save((was) => carryMarks(was, from, to)),
  };
}

/** A topic write that failed for some of its chats: those it did move, and the first failure's message. */
class TopicWriteFailed extends Error {
  readonly moved: ReadonlyArray<string>;
  constructor(moved: ReadonlyArray<string>, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.moved = moved;
  }
}

/** In the sidebar by topic: the groups a chat's Move to offers (open and closed, with their emoji), and how it moves a chat. Null anywhere else. */
const TopicMoves = createContext<{ readonly groups: ReadonlyArray<{ readonly topic: string; readonly icon: string | undefined }>; readonly move: (workspace: WorkspaceView, topic: string | null) => void } | null>(null);

/** Where a drop lands in the sidebar by topic: a chat's row (in `group`, null when loose) or a group's heading. */
interface TopicSpot {
  readonly key: string;
  readonly group: string | null;
  readonly heading: boolean;
  /** The loose chat under the drop, which a chat dropped into it joins in a new group. */
  readonly chat?: WorkspaceView;
}

/** What a group's own actions do (its heading, its ⋯, Closed groups): each acts on every chat in it, whatever the filter shows. */
interface GroupActions {
  readonly rename: (to: string) => void;
  readonly ungroup: () => void;
  readonly setIcon: (icon: string | null) => void;
  readonly pin: (on: boolean) => void;
  /** Marks every chat in it done, and every agent under them: it goes to Closed groups. */
  readonly close: () => void;
  /** Back in the list, kept open until closed again; its chats (and their agents) marked done are not done any more. */
  readonly reopen: () => void;
}

/**
 * The chats by topic, as Dia keeps tab groups, with the queue's lifecycle in them (model.ts topicView). A group shows
 * its live chats (needs you, working, ready for review) and folds its done and snoozed ones behind one line; when
 * nothing in it is live it closes, to Closed groups at the foot of the column, and it comes back in its old place when
 * a chat in it does: a new chat filed under its topic, a reply, a snooze ending. × closes one by hand (its chats marked
 * done, after asking when one still works or needs you); Reopen brings one back and keeps it open until it is closed
 * again; a pinned group sits on top and never closes. A loose chat that is over goes to the Done or Snoozed shelf. The
 * open chat holds where it stood when it was opened, so nothing moves under the person.
 *
 * The person arranges it all by dragging: groups and loose chats up and down (one order, kept on this device), a chat
 * into a group, out of it, or onto a loose chat to start a group of the two. A group's emoji opens a picker; its menu
 * renames, pins, picks a Chief and ungroups. The title writer names topics and their emoji, and leaves alone every chat
 * the person placed.
 */
function TopicList({
  folders,
  all,
  closed,
  setOpen,
  projects,
}: {
  folders: ReadonlyArray<SidebarFolder>;
  /** Every folder, the filter's hidden chats and Pinned ones too: what a whole group's action (rename, hand over) takes. */
  all: ReadonlyArray<SidebarFolder>;
  closed: ReadonlySet<string>;
  setOpen: (id: string, open: boolean) => void;
  /** The projects, for the Archived shelf's rows. */
  projects: ReadonlyArray<QueueProject>;
}) {
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const inbox = useRuntimeSelector((v) => v.inbox);
  const [order, setOrder] = useTopicOrder();
  const { marks, mark, share, carry } = useTopicMarks();
  // Where each chat stands, on the queue's clock: a snooze that ends brings its chat back on time.
  const statuses = useAllStatuses();
  const chats = useMemo(() => all.flatMap((f) => f.rows.flatMap((r) => [r.workspace, ...r.children])), [all]);
  const { now } = useQueueSections(chats, statuses);
  const statusOf = (w: WorkspaceView) => (statuses.has(w.id) ? statuses.get(w.id)! : chatStatus(w));
  const life = (w: WorkspaceView) => chatLife(w, now);
  // The open chat, and where its row stood when it was opened: it holds there until the person leaves it.
  const { workspaceId: openId } = useParams();
  const openChat = openId ? chats.find((c) => c.id === openId) : undefined;
  const [held, setHeld] = useState<{ readonly id: string; readonly life: ChatLife } | undefined>(undefined);
  if (openChat ? held?.id !== openChat.id : held !== undefined) setHeld(openChat ? { id: openChat.id, life: topicRowLife(folders, openChat.id, life) ?? life(openChat) } : undefined);
  const view = topicView(folders, order, life, marks, held?.id === openId ? held : undefined);
  const { items } = view;
  // Who manages each group, and whose board each chat is on (every Chief's items, the shared board).
  const chiefs = useChiefs();
  const board = useChief().allItems;
  const homeId = chiefs.chiefs.find((c) => c.home)?.id;
  const boardOf = useMemo(() => new Map(board.flatMap((item) => item.workspace_ids.map((id) => [id, item.chief_id ?? homeId ?? ""] as const))), [board, homeId]);
  const managerOf = (topic: string) => chiefs.chiefs.find((c) => c.topics?.includes(topic));
  // A group's members, whatever the filter shows of it.
  const everyRow = useMemo(() => all.flatMap((f) => f.rows.map((r): TopicRow => ({ ...r, project: f.project }))), [all]);
  const inGroup = (topic: string) => everyRow.filter((r) => r.workspace.topic === topic);
  const unpinned = (rows: ReadonlyArray<TopicRow>) => rows.filter((r) => !r.workspace.inbox?.pinnedAt);
  const say = (e: unknown) => announce(e instanceof Error ? e.message : String(e));
  const manage = (topic: string, chief: ChiefProfile | null, handOver: ReadonlyArray<string>) =>
    chiefs.manage(topic, chief, handOver).then(
      (handed) => {
        announce(chief === null ? `No Chief manages ${topic} now.` : `${chief.name} manages ${topic}${handed.length > 0 ? `, with ${handed.length} ${handed.length === 1 ? "chat" : "chats"} handed over` : ""}.`);
        refresh();
      },
      say,
    );
  const { shown } = view;
  const groups = [...items.flatMap((i) => (i.kind === "group" ? [{ topic: i.topic, icon: i.icon }] : [])), ...view.closed.map((g) => ({ topic: g.topic, icon: g.icon }))];
  const iconOf = (topic: string) => groups.find((g) => g.topic === topic)?.icon;
  // Every chat's write runs to its end; when any fails, it fails after a refresh (so what did move shows) with the chats
  // that moved (TopicWriteFailed): a rename gives up its old name only once every chat has the new one. `icon` left
  // out: the runtime keeps a chat's emoji while its topic's name stays.
  const setTopic = (ids: ReadonlyArray<string>, topic: string | null, icon?: string | null): Promise<void> =>
    client
      ? Promise.allSettled(ids.map((id) => client.call("workspace.topic", { request_id: requestId(), workspace_id: id, topic, ...(topic !== null && icon !== undefined ? { icon } : {}) }))).then(async (results) => {
          const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
          if (!failed) return refresh();
          await refresh().catch(() => undefined);
          throw new TopicWriteFailed(
            ids.filter((_, i) => results[i]!.status === "fulfilled"),
            failed.reason,
          );
        })
      : Promise.resolve();
  // Into a group: its emoji too.
  const join = (ids: ReadonlyArray<string>, topic: string | null) => setTopic(ids, topic, topic === null ? undefined : (iconOf(topic) ?? null));
  // Which group each chat is in, a closed one's too: a chat dragged out of Closed groups leaves its group.
  const groupOf = new Map<string, string | null>([
    ...items.flatMap((item): Array<[string, string | null]> => (item.kind === "group" ? [...item.rows, ...item.rest].map((r) => [r.workspace.id, item.topic]) : [[item.row.workspace.id, null]])),
    ...view.closed.flatMap((g) => g.rows.map((r): [string, string | null] => [r.workspace.id, g.topic])),
  ]);
  const members = (topic: string) => {
    const group = items.find((i) => i.kind === "group" && i.topic === topic);
    return group?.kind === "group" ? [...group.rows, ...group.rest].map((r) => chatKey(r.workspace.id)) : [];
  };
  const drop = (spot: TopicSpot) => (payload: DragPayload, place: ArrangePlace) => {
    if (payload.topic !== undefined) {
      // A group lands above or below an item, never inside another group: below a group is below its last chat.
      const anchor = spot.group === null ? spot.key : place === "before" ? groupKey(spot.group) : (members(spot.group).at(-1) ?? groupKey(spot.group));
      setOrder(moveKeys(order, shown, [groupKey(payload.topic), ...members(payload.topic)], anchor, place === "before" ? "before" : "after"));
      return;
    }
    const id = payload.workspaceId;
    const dragged = chatKey(id);
    if (place === "into" && spot.chat) {
      // Onto a loose chat: the two start a group, named (with its emoji) for the topic either already has, else for the
      // chat dropped on.
      const other = folders.flatMap((f) => f.rows).find((r) => r.workspace.id === id)?.workspace;
      const from = spot.chat.topic ? spot.chat : other?.topic ? other : undefined;
      const name = from?.topic ?? spot.chat.title.slice(0, 40);
      void setTopic([spot.chat.id, id], name, from?.topicIcon ?? null).catch(say);
      // The new group takes the chat's place, the dropped chat under it.
      const placed = moveKeys(order, shown, [groupKey(name)], spot.key, "before");
      setOrder(moveKeys(placed, shown, [dragged], spot.key, "after"));
      announce(`Grouped as ${name}.`);
      return;
    }
    // On a group's heading, its middle and lower part join the group (at its top); its upper edge lands above it, loose.
    const joins = spot.heading ? (place === "before" ? null : spot.group) : spot.group;
    if (joins !== (groupOf.get(id) ?? null)) void join([id], joins).catch(say);
    const first = spot.heading && joins !== null ? members(joins).find((k) => k !== dragged) : undefined;
    setOrder(first ? moveKeys(order, shown, [dragged], first, "before") : moveKeys(order, shown, [dragged], spot.key, place === "into" ? "after" : place));
  };
  // Every chat in `rows`, each lead and its agents, that `pick` takes, once each.
  const markAll = (rows: ReadonlyArray<TopicRow>, pick: (w: WorkspaceView) => boolean, action: InboxAction) => {
    const ids = [...new Set(rows.flatMap((r) => [r.workspace, ...r.children]).filter(pick).map((w) => w.id))];
    return inbox ? Promise.all(ids.map((id) => inbox(id, action))).then(refresh).catch(say) : Promise.resolve();
  };
  const actions = (topic: string, key: string): GroupActions => ({
    rename: (to) => {
      // Its Chief goes with it: the new name is that Chief's before its chats move (the same Chief on both sides
      // moves none off its board), and the old name is given up once they have. A name another Chief manages
      // is that Chief's group: refused, nothing moves. Its emoji goes with its chats. Its pin, reopened mark and place
      // hold under both names while its chats move (they land one at a time, pushed and polled), and settle on the new
      // name once all have it. If the rename fails, they go back to the old name alone when no chat moved; when some
      // did, the group is split, and both halves keep them.
      const plan = renameGroup(topic, to, managerOf);
      if ("taken" in plan) return announce(`${to} is ${plan.taken.name}'s group. Pick another name.`);
      const before = { pinned: marks.pinned.has(to), kept: marks.kept.has(to), placed: order.includes(groupKey(to)) };
      share(topic, to);
      setOrder((was) => {
        const base = was.length > 0 ? was : shown;
        return base.includes(groupKey(to)) ? base : base.flatMap((k) => (k === key ? [k, groupKey(to)] : [k]));
      });
      void (plan.take ? chiefs.manage(to, plan.take) : Promise.resolve([]))
        .then(() => setTopic(inGroup(topic).map((r) => r.workspace.id), to, iconOf(topic) ?? null))
        .then(
          () => {
            carry(topic, to);
            setOrder((was) => was.filter((k) => k !== key));
            return plan.release ? chiefs.manage(topic, null) : undefined;
          },
          (e: unknown) => {
            if (!(e instanceof TopicWriteFailed && e.moved.length > 0)) {
              mark(to, "pinned", before.pinned);
              mark(to, "kept", before.kept);
              if (!before.placed) setOrder((was) => was.filter((k) => k !== groupKey(to)));
            }
            throw e;
          },
        )
        .catch(say);
    },
    // Its marks go once its chats are loose.
    ungroup: () => void setTopic(inGroup(topic).map((r) => r.workspace.id), null).then(() => carry(topic, null), say),
    setIcon: (icon) => void setTopic(inGroup(topic).map((r) => r.workspace.id), topic, icon).catch(say),
    pin: (on) => mark(topic, "pinned", on),
    close: () => {
      mark(topic, "kept", false);
      // A pinned chat sits in Pinned, not in the group: closing the group leaves it pinned and live.
      void markAll(unpinned(inGroup(topic)), (w) => !w.inbox?.doneAt, { do: "done" });
      announce(`Closed ${topic}.`);
    },
    reopen: () => {
      mark(topic, "kept", true);
      void markAll(inGroup(topic), (w) => Boolean(w.inbox?.doneAt), { do: "reopen" });
      announce(`Reopened ${topic}.`);
    },
  });
  // What closing a group by hand would cut short: its chats still at work or waiting on the person.
  const busy = (topic: string) => unpinned(inGroup(topic)).filter((r) => [r.workspace, ...r.children].some((w) => ["needs", "working"].includes(chatStage(statusOf(w), w))));
  const row = (r: TopicRow, manager?: ChiefProfile) => (
    <>
      <WorkspaceRow workspace={r.workspace} chief={onBoard(chiefs.chiefs, boardOf, r.workspace.id, manager)} />
      <Builders lead={r.workspace} builders={r.children} />
    </>
  );
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const queueActions = useQueueActions();
  return (
    <TopicMoves.Provider value={{ groups, move: (w, topic) => void join([w.id], topic).catch(say) }}>
      {items.map((item) =>
        item.kind === "group" ? (
          <TopicGroup
            key={item.key}
            item={item}
            open={!closed.has(`topic:${item.topic}`)}
            onToggle={() => setOpen(`topic:${item.topic}`, closed.has(`topic:${item.topic}`))}
            drop={drop}
            members={inGroup(item.topic)}
            busy={() => busy(item.topic)}
            manager={managerOf(item.topic)}
            chiefs={chiefs.chiefs}
            boardOf={boardOf}
            openId={openId}
            onManage={(chief, handOver) => void manage(item.topic, chief, handOver)}
            actions={actions(item.topic, item.key)}
            row={row}
          />
        ) : (
          <ArrangeSlot key={item.key} spot={{ key: item.key, into: true, onDrop: drop({ key: item.key, group: null, heading: false, chat: item.row.workspace }) }}>
            {row(item.row)}
          </ArrangeSlot>
        ),
      )}
      {/* What is over sits at the foot of the column, as the queue's shelves do. */}
      <div className="mt-auto pt-3">
        <Shelf id="done" label="Done" rows={view.done.map((r) => ({ id: r.workspace.id, r }))} openId={openId} paged renderRow={({ r }) => <div key={r.workspace.id}>{row(r)}</div>} end={queueActions && view.done.length > 0 ? <DoneRules rows={view.done.map((r) => r.workspace)} /> : null} />
        <Shelf id="snoozed" label="Snoozed" rows={view.snoozed.map((r) => ({ id: r.workspace.id, r }))} openId={openId} renderRow={({ r }) => <div key={r.workspace.id}>{row(r)}</div>} />
        <Shelf
          id="closedGroups"
          label="Closed groups"
          rows={view.closed}
          openId={view.closed.find((g) => g.rows.some((r) => r.workspace.id === openId || r.children.some((c) => c.id === openId)))?.id}
          renderRow={(g) => <ClosedGroupRow key={g.id} group={g} now={now} openId={openId} actions={actions(g.topic, g.id)} row={row} />}
        />
        {queueActions ? <ArchivedShelf projects={byId} now={now} openId={openId} /> : null}
      </div>
    </TopicMoves.Provider>
  );
}

/** A row the sidebar by topic arranges: it takes drops (drag.ts `arrange`) for as long as it is mounted. */
function ArrangeSlot({ spot, className, style, children }: { spot: { readonly key: string; readonly into: boolean; readonly group?: string; readonly onDrop: (payload: DragPayload, place: ArrangePlace) => void }; className?: string; style?: CSSProperties; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  // The latest drop, without registering again on every render.
  const onDrop = useRef(spot.onDrop);
  onDrop.current = spot.onDrop;
  useEffect(() => registerDropTarget(el.current!, { kind: "arrange", key: spot.key, into: spot.into, ...(spot.group !== undefined ? { group: spot.group } : {}), onDrop: (payload, place) => onDrop.current(payload, place) }), [spot.key, spot.into, spot.group]);
  return (
    <div ref={el} className={className} style={style}>
      {children}
    </div>
  );
}

/** The emoji a group's picker offers; any other comes from the title writer or the system's emoji picker. */
const TOPIC_EMOJI = ["🧭", "🚀", "🔐", "🧪", "🐛", "📱", "💳", "📊", "🧱", "🎨", "⚙️", "🔌", "📦", "🗂️", "🧠", "💬", "📝", "🔍", "⚡", "🌐", "🛠️", "🧹", "📣", "🎯", "🏗️", "🔔", "🗺️", "🪨", "🦴", "🔥", "🌱", "🧩"] as const;

/**
 * A group's mark: its emoji, or a quiet square while it has none. Pressed, it opens the picker: a grid of emoji, a
 * field for any other (the system's picker types into it), and None.
 */
function TopicEmoji({ topic, icon, onPick }: { topic: string; icon: string | undefined; onPick: (icon: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (next: string | null) => {
    setOpen(false);
    if (next !== (icon ?? null)) onPick(next);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={icon ? `${topic}'s emoji, ${icon}. Change it` : `Pick an emoji for ${topic}`}
        title="Change the emoji"
        className="grid size-6 shrink-0 place-items-center rounded-md text-[15px] leading-none outline-none transition-colors duration-75 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent"
      >
        {icon ?? <Icon icon={DashboardSquare01Icon} className="size-3.5 text-muted-foreground" />}
      </PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={8} aria-label={`Emoji for ${topic}`} className="w-[232px] p-2">
        <div className="grid grid-cols-8 gap-0.5">
          {TOPIC_EMOJI.map((e) => (
            <button key={e} type="button" aria-label={e} aria-pressed={e === icon} onClick={() => pick(e)} className={cn("grid size-6 place-items-center rounded-md text-[15px] leading-none outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", e === icon && "bg-accent")}>
              {e}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <input
            aria-label="Any emoji"
            placeholder="Any emoji"
            maxLength={16}
            onKeyDown={(e) => {
              if (isComposing(e) || e.key !== "Enter") return;
              const typed = oneEmoji(e.currentTarget.value);
              if (typed) pick(typed);
            }}
            onInput={(e) => {
              // The system's picker types one emoji in: take it as it lands.
              const typed = oneEmoji(e.currentTarget.value);
              if (typed) pick(typed);
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring/60"
          />
          {icon ? (
            <QuietButton onClick={() => pick(null)} className="h-7 px-2 text-[12px]">
              None
            </QuietButton>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** `text` when it is exactly one emoji (a flag or a joined sequence counts as one), else null. */
function oneEmoji(text: string): string | null {
  const trimmed = text.trim();
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)];
  return graphemes.length === 1 && trimmed.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(trimmed) ? trimmed : null;
}

/**
 * A group, flat: its emoji, its name in bold a size up from its chats, and a chevron; under it its live chats one step
 * in, and its done and snoozed ones folded behind one line. No engine logos: every row would carry the same one. Its
 * heading folds it and drags it; on hover × closes it (not a pinned one) and ⋯ (or a right-click) opens Rename, Pin,
 * Managed by and Ungroup. Shut, it says the most pressing thing among its chats.
 */
function TopicGroup({
  item,
  open,
  onToggle,
  drop,
  members,
  busy,
  manager,
  chiefs,
  boardOf,
  openId,
  onManage,
  actions,
  row,
}: {
  item: TopicGroupItem;
  open: boolean;
  onToggle: () => void;
  drop: (spot: TopicSpot) => (payload: DragPayload, place: ArrangePlace) => void;
  /** Every chat in it, the ones the filter hides too: what a hand-over lists. */
  members: ReadonlyArray<TopicRow>;
  /** Its chats still at work or waiting on the person, asked for when × is pressed. */
  busy: () => ReadonlyArray<TopicRow>;
  /** The Chief that manages it (ChiefProfile.topics), if one does. */
  manager: ChiefProfile | undefined;
  chiefs: ReadonlyArray<ChiefProfile>;
  /** Whose board each chat is on, by chat. */
  boardOf: ReadonlyMap<string, string>;
  openId: string | undefined;
  onManage: (chief: ChiefProfile | null, handOver: ReadonlyArray<string>) => void;
  actions: GroupActions;
  row: (r: TopicRow, manager?: ChiefProfile) => ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  // Its done and snoozed chats, unfolded: kept on this device.
  const [restOpen, setRestOpen] = useStoredFlag(`caveman.topicRest.${item.topic}`);
  // Picking a Chief for a group that already holds chats it could take asks first: those too, or only new ones.
  const [asking, setAsking] = useState<{ readonly chief: ChiefProfile; readonly plan: ReturnType<typeof handOverPlan> } | null>(null);
  // × on a group with chats still at work or waiting on the person asks first, naming them.
  const [closing, setClosing] = useState<ReadonlyArray<TopicRow> | null>(null);
  // The question opens once the menu has closed (its onCloseAutoFocus), so the focus it hands back can't dismiss it.
  const ask = useRef<{ readonly chief: ChiefProfile; readonly plan: ReturnType<typeof handOverPlan> } | null>(null);
  const pick = (chief: ChiefProfile | null) => {
    if (chief === null || chief.id === manager?.id) return chief === null && manager !== undefined ? onManage(null, []) : undefined;
    const plan = handOverPlan(members, chief, boardOf);
    if (plan.handed.length === 0) return onManage(chief, []);
    ask.current = { chief, plan };
  };
  const close = () => {
    const live = busy();
    if (live.length === 0) return actions.close();
    setClosing(live);
  };
  const nameOf = (id: string) => chiefs.find((c) => c.id === id)?.name ?? "another Chief";
  const statuses = useAllStatuses();
  const rollup = firstStatus([...item.rows, ...item.rest].flatMap((r) => [r.workspace, ...r.children]).map((w) => (statuses?.has(w.id) ? statuses.get(w.id)! : chatStatus(w))));
  const isOpen = (r: TopicRow) => r.workspace.id === openId || r.children.some((c) => c.id === openId);
  // Folded, the open chat still shows under the line (the queue's shelves keep it the same way).
  const rest = restOpen ? item.rest : item.rest.filter(isOpen);
  const restLine = [item.done > 0 ? `${item.done} done` : "", item.snoozed > 0 ? `${item.snoozed} snoozed` : ""].filter(Boolean).join(" · ");
  const slot = (r: TopicRow, i: number) => (
    <ArrangeSlot
      key={r.workspace.id}
      className="folder-row pl-6"
      style={{ "--i": i } as CSSProperties}
      spot={{ key: chatKey(r.workspace.id), into: false, group: item.topic, onDrop: drop({ key: chatKey(r.workspace.id), group: item.topic, heading: false }) }}
    >
      {row(r, manager)}
    </ArrangeSlot>
  );
  return (
    <div className="relative mt-2 first:mt-0">
      <ArrangeSlot spot={{ key: item.key, into: true, onDrop: drop({ key: item.key, group: item.topic, heading: true }) }}>
        <div
          className="group/topic relative flex h-8 items-center gap-1 pl-1"
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(true);
          }}
        >
          <TopicEmoji topic={item.topic} icon={item.icon} onPick={actions.setIcon} />
          {renaming ? (
            <div className="flex h-full min-w-0 flex-1 items-center gap-2 pr-1">
              <input
                autoFocus
                defaultValue={item.topic}
                aria-label="Group name"
                maxLength={40}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  setRenaming(false);
                  const to = e.currentTarget.value.replace(/\s+/g, " ").trim();
                  if (to && to !== item.topic) actions.rename(to);
                }}
                onKeyDown={(e) => {
                  if (isComposing(e)) return;
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.currentTarget.value = item.topic;
                    e.currentTarget.blur();
                  }
                }}
                className="h-6 min-w-0 flex-1 rounded-md border border-ring/60 bg-background px-1.5 text-[13px] text-foreground outline-none"
              />
            </div>
          ) : (
            <button
              type="button"
              data-sidebar-row=""
              aria-expanded={open}
              onClick={onToggle}
              onPointerDown={(e) => beginDrag(e, { workspaceId: "", title: item.topic, meta: "", detail: `${item.rows.length + item.rest.length} chats`, fromPaneId: null, topic: item.topic })}
              className={cn(
                "flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-0.5 pr-1 text-left text-[14px] font-semibold text-sidebar-accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                item.pinned ? "group-hover/topic:pr-8" : "group-hover/topic:pr-14",
              )}
            >
              <span className="min-w-0 truncate">{item.topic}</span>
              <Icon icon={ArrowDown01Icon} className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap", !open && "-rotate-90")} strokeWidth={2} />
              {manager ? (
                <span title={`Managed by ${manager.name}`} className="flex min-w-0 shrink items-center gap-1 text-[12px] font-medium text-muted-foreground">
                  <ChiefSprite avatar={manager.avatar} className="size-3.5 shrink-0" />
                  <span className="truncate">{manager.name}</span>
                </span>
              ) : null}
              <span className="flex-1" />
              <span className="flex shrink-0 items-center gap-1.5 group-hover/topic:hidden">
                {item.pinned ? <Icon icon={PinIcon} aria-label="Pinned" className="size-3 text-[hsl(var(--subtle-foreground))]" /> : null}
                {!open && rollup ? <StatusMark status={rollup} compact /> : null}
              </span>
            </button>
          )}
          {!renaming ? (
            <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover/topic:opacity-100 has-[[data-state=open]]:opacity-100">
              {item.pinned ? null : (
                <button type="button" aria-label={`Close ${item.topic}`} title="Close: marks its chats done" onClick={close} className="grid size-6 place-items-center rounded-md text-sidebar-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <Icon icon={Cancel01Icon} className="size-3.5" />
                </button>
              )}
              <DropdownMenu open={menu} onOpenChange={setMenu}>
                <DropdownMenuTrigger
                  aria-label={`${item.topic} options`}
                  className="grid size-6 place-items-center rounded-md text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent"
                >
                  <Icon icon={MoreHorizontalIcon} className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-[236px]"
                  onCloseAutoFocus={(e) => {
                    if (!ask.current) return;
                    e.preventDefault();
                    setAsking(ask.current);
                    ask.current = null;
                  }}
                >
                  <DropdownMenuItem onSelect={() => setRenaming(true)}>
                    <Icon icon={PencilEdit02Icon} /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => actions.pin(!item.pinned)}>
                    <Icon icon={item.pinned ? PinOffIcon : PinIcon} /> {item.pinned ? "Unpin" : "Pin to the top"}
                  </DropdownMenuItem>
                  {chiefs.length > 0 ? (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger value={manager?.name ?? "No one"}>
                        <Icon icon={UserGroupIcon} /> Managed by
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-[180px]">
                        <DropdownMenuRadioGroup value={manager?.id ?? ""}>
                          <DropdownMenuRadioItem value="" onSelect={() => pick(null)}>
                            No one
                          </DropdownMenuRadioItem>
                          <DropdownMenuSeparator />
                          {chiefs.map((c) => (
                            <DropdownMenuRadioItem key={c.id} value={c.id} onSelect={() => pick(c)}>
                              <ChiefSprite avatar={c.avatar} className="size-4 shrink-0" />
                              <span className="min-w-0 truncate">{c.name}</span>
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : null}
                  <DropdownMenuItem onSelect={actions.ungroup}>
                    <Icon icon={Cancel01Icon} /> Ungroup
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          ) : null}
        </div>
      </ArrangeSlot>
      <div className="folder-body" data-open={open || undefined} inert={!open}>
        <div>
          {item.rows.map(slot)}
          {item.rest.length > 0 ? (
            <button
              type="button"
              aria-expanded={restOpen}
              onClick={() => setRestOpen(!restOpen)}
              className="ml-6 flex h-7 items-center gap-1 rounded-md pl-2.5 pr-2 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {restLine}
              <Icon icon={ArrowRight01Icon} className={cn("size-3 transition-transform duration-150", restOpen && "rotate-90")} strokeWidth={2} />
            </button>
          ) : null}
          {rest.length > 0 ? <div className="opacity-80">{rest.map((r, i) => slot(r, item.rows.length + i))}</div> : null}
        </div>
      </div>
      {asking ? <HandOver group={item.topic} chief={asking.chief} plan={asking.plan} nameOf={nameOf} onAnswer={(handOver) => (setAsking(null), onManage(asking.chief, handOver ? asking.plan.handed.map((r) => r.workspace.id) : []))} onCancel={() => setAsking(null)} /> : null}
      {closing ? <CloseGroup group={item.topic} live={closing} statusOf={(w) => (statuses?.has(w.id) ? statuses.get(w.id)! : chatStatus(w))} onClose={() => (setClosing(null), actions.close())} onCancel={() => setClosing(null)} /> : null}
    </div>
  );
}

/**
 * Asked when × would close a group that still has chats at work or waiting on the person: names them, and closing marks
 * every chat in it done (a chat still at work finishes its turn; its next message brings the group back). Beside the
 * sidebar, where the group stays in sight.
 */
function CloseGroup({ group, live, statusOf, onClose, onCancel }: { group: string; live: ReadonlyArray<TopicRow>; statusOf: (w: WorkspaceView) => ChatStatus | null; onClose: () => void; onCancel: () => void }) {
  return (
    <Popover open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <PopoverAnchor className="absolute right-0 top-1 h-7 w-px" />
      <PopoverContent side="right" align="start" sideOffset={14} aria-label={`Close ${group}`} className="w-[280px] p-3 text-[13px]">
        <div className="font-semibold text-foreground">Close {group}?</div>
        <p className="mb-2.5 mt-1.5 text-[12.5px] leading-[1.45] text-muted-foreground">Every chat in it is marked done. These are still going:</p>
        <ul className="mb-3 space-y-1 text-[12.5px]">
          {live.map((r) => {
            const status = statusOf(r.workspace);
            return (
              <li key={r.workspace.id} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-foreground">{r.workspace.title}</span>
                {status ? <StatusMark status={status} compact /> : null}
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end gap-2">
          <QuietButton onClick={onCancel}>Cancel</QuietButton>
          <Button type="button" size="sm" onClick={onClose}>
            Close group
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A group in Closed groups: its emoji, its name and how long since it was last active, a step quieter than an open
 * group. Pressed, it unfolds its chats under it (the open one shows while it is folded); Reopen on hover brings it back
 * into the list, in its old place.
 */
function ClosedGroupRow({ group, now, openId, actions, row }: { group: ClosedGroup; now: number; openId: string | undefined; actions: GroupActions; row: (r: TopicRow) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open ? group.rows : group.rows.filter((r) => r.workspace.id === openId || r.children.some((c) => c.id === openId));
  return (
    <div>
      <div className="group/row relative">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-[30px] w-full items-center gap-2 rounded-lg pl-1.5 pr-2 text-left text-[13px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/row:pr-[96px] group-has-[:focus-visible]/row:pr-[96px]"
        >
          <span aria-hidden className="grid size-6 shrink-0 place-items-center text-[14px] leading-none">
            {group.icon ?? <Icon icon={DashboardSquare01Icon} className="size-3.5" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{group.topic}</span>
          <span className="shrink-0 text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))] group-hover/row:hidden group-has-[:focus-visible]/row:hidden">
            {group.rows.length} · {rowAge(group.at, now)}
          </span>
        </button>
        <span className={cn(ROW_ACTIONS, "top-1/2 -translate-y-1/2")}>
          <button type="button" aria-label={`Reopen ${group.topic}`} title="Reopen: back in the list, open until you close it" onClick={actions.reopen} className={ROW_ACTION}>
            <Icon icon={Undo02Icon} className="size-3.5" />
            Reopen
          </button>
        </span>
      </div>
      {shown.map((r) => (
        <div key={r.workspace.id} className="pl-6 opacity-80">
          {row(r)}
        </div>
      ))}
    </div>
  );
}

/**
 * A chat's Chief mark in the sidebar by topic: whose board it is on. None on its group's own Chief's board (the group's
 * heading names that Chief), and a step back on another Chief's.
 */
function onBoard(chiefs: ReadonlyArray<ChiefProfile>, boardOf: ReadonlyMap<string, string>, workspaceId: string, manager: ChiefProfile | undefined): ChiefMark | undefined {
  const id = boardOf.get(workspaceId);
  const chief = id === undefined ? undefined : chiefs.find((c) => c.id === id);
  if (!chief || chief.id === manager?.id) return undefined;
  return { avatar: chief.avatar, name: chief.name, dim: manager !== undefined };
}

/** The Chief a row names: its board's (WorkspaceRow `chief`). */
interface ChiefMark {
  readonly avatar: ChiefProfile["avatar"];
  readonly name: string;
  /** On another Chief's board than its group's. */
  readonly dim: boolean;
}

/**
 * Asked once, when a Chief takes a group that already holds chats: those too ("Hand over N"), or only new ones. Says
 * what stays where before anything moves (handOverPlan, as the runtime decides it). Beside the sidebar, where the
 * group's rows stay in sight.
 */
function HandOver({ group, chief, plan, nameOf, onAnswer, onCancel }: { group: string; chief: ChiefProfile; plan: ReturnType<typeof handOverPlan>; nameOf: (id: string) => string; onAnswer: (handOver: boolean) => void; onCancel: () => void }) {
  const n = plan.handed.length;
  return (
    <Popover open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <PopoverAnchor className="absolute right-0 top-1 h-7 w-px" />
      <PopoverContent side="right" align="start" sideOffset={14} aria-label={`${chief.name} manages ${group}`} className="w-[300px] p-3 text-[13px]">
        <div className="font-semibold text-foreground">
          {chief.name} now manages {group}.
        </div>
        <p className="mb-2.5 mt-1.5 text-[12.5px] leading-[1.45] text-muted-foreground">New chats in this group go to {chief.name}. The ones already in it too?</p>
        <ul className="mb-3 space-y-0.5 text-[12.5px]">
          <li className="flex gap-2">
            <span className="shrink-0 text-foreground">
              {n} {n === 1 ? "chat" : "chats"}
            </span>
            <span className="text-muted-foreground">go to {chief.name}'s board</span>
          </li>
          {plan.kept.map(({ row, why, chiefId }) => (
            <li key={row.workspace.id} className="flex min-w-0 gap-2">
              <span className="min-w-0 max-w-[45%] shrink-0 truncate text-foreground">{row.workspace.title}</span>
              <span className="min-w-0 text-muted-foreground">{why === "board" ? `stays on ${nameOf(chiefId!)}'s board` : `stays yours: not in ${chief.name}'s projects`}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={() => onAnswer(false)}>
            Only new ones
          </Button>
          <Button type="button" size="sm" onClick={() => onAnswer(true)}>
            Hand over {n}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Move to: in the sidebar by topic, a chat's group, picked from the groups on screen, or No group. What the person picks
 * sticks; the title writer never moves it back.
 */
function MoveToTopic({ workspace }: { workspace: WorkspaceView }) {
  const moves = useContext(TopicMoves);
  if (!moves) return null;
  const current = workspace.topic && moves.groups.some((g) => g.topic === workspace.topic) ? workspace.topic : null;
  if (moves.groups.length === 0) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger value={current ?? "No group"}>
        <Icon icon={DashboardSquare01Icon} /> Move to
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[200px]">
        <DropdownMenuRadioGroup value={current ?? ""}>
          {moves.groups.map((g) => (
            <DropdownMenuRadioItem key={g.topic} value={g.topic} onSelect={() => moves.move(workspace, g.topic)}>
              {g.icon ? <span className="w-4 shrink-0 text-center text-[13px] leading-none">{g.icon}</span> : null}
              <span className="min-w-0 truncate">{g.topic}</span>
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="" onSelect={() => moves.move(workspace, null)}>
            No group
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * A lead's builders, delegated agents and native subagents under it, folded behind one line ("2
 * working · 9 done"). Open, it shows the agents still at work; the finished ones wait behind their
 * own "9 done" line at the foot of the rail, quieter, with no harness colour on their bends. The fold
 * starts shut, its line saying who works and who needs the user; both unfold by themselves when one
 * of their agents becomes the open chat, and once the user leaves this lead and its agents the fold
 * shuts again. A rail drops from the lead and bends into each row on a quarter squircle (`Rail`); it
 * runs on down the children, a level deeper for an agent's own agents. A native subagent (the
 * engine's own, inline in its chat's transcript) opens its own transcript in that chat's Overview.
 * An agent tree long done leaves the rail (`recentAgents`), the fold with it once none is left; the
 * lead's Agents panel still lists them all.
 */
// A list row: unchanged chats skip the re-render a push to another chat gives their folder.
const Builders = memo(function Builders({ lead, builders }: { lead: WorkspaceView; builders: ReadonlyArray<ChildView> }) {
  const { workspaceId } = useParams();
  const [now, setNow] = useState(Date.now);
  const { rows: agents, next } = useMemo(() => recentAgents(agentRows(lead, builders), now, workspaceId), [lead, builders, now, workspaceId]);
  // One timer, for the next tree to leave.
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 1_000);
    return () => clearTimeout(timer);
  }, [next]);
  const { live, done } = useMemo(() => liveAndDone(agents), [agents]);
  const viewingChild = builders.some((c) => c.id === workspaceId);
  const viewingDone = done.some((a) => a.kind === "chat" && a.id === workspaceId);
  const here = viewingChild || workspaceId === lead.id;
  // Shut by default; open by itself only when one of its agents is on screen. The person's own fold or unfold holds
  // until they leave this lead and its agents. One of them coming on screen opens it, and that holds too, so stepping
  // back to the lead keeps it open (builder-fold.ts).
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = foldOpen({ choice, live: live.length, viewingChild });
  const setOpen = (next: (o: boolean) => boolean) => setChoice(next(open));
  const [doneOpen, setDoneOpen] = useState(viewingDone);
  const childOpens = opensForChild(live.length, viewingChild);
  useEffect(() => {
    if (!here) setChoice(null);
    else if (childOpens) setChoice(true);
  }, [here, childOpens]);
  useEffect(() => {
    if (viewingDone) setDoneOpen(true);
    else if (!here) setDoneOpen(false);
  }, [viewingDone, here]);
  const engines = useRuntimeSelector((v) => v.engines);
  const { client } = useRuntimeClient();
  // Only its own agents' workspaces: a push about another chat re-renders no tree.
  const children = useRuntimeSelector((v) => agents.map((a) => (a.kind === "chat" ? v.raw.get(a.workspace.id) : undefined)), sameItems);
  if (agents.length === 0) return null;
  const runners = new Map(
    agents.map((a, i) => {
      if (a.kind === "subagent") return [a.id, runnerFor(engines, { engine: a.subagent.engine })];
      const turn = loadedTurn(client, a.workspace.sessionId);
      return [a.id, runnerFor(engines, { engine: a.workspace.engine.id, model: turn?.model, effort: turn?.effort, runner: childRunner(children[i]) })];
    }),
  );
  const all = [...runners.values()];
  // One logo per harness under this lead, in first-seen order: who is working, at a glance.
  const faces = all.filter((r, i) => all.findIndex((o) => o.engine === r.engine) === i).slice(0, 3);
  // A row names its login only when a sibling runs the same harness on another one.
  const shared = (r: Runner) => all.some((o) => o.engine === r.engine && o.tag !== r.tag);
  const working = live.filter((a) => (a.kind === "chat" ? a.workspace.state : a.subagent.state) === "working").length;
  const waiting = live.filter((a) => a.kind === "chat" && a.workspace.state === "needs_input").length;
  // The finished ones get a line of their own only when some are still at work; else they are all there is.
  const split = live.length > 0 && done.length > 0;
  const lines: ReadonlyArray<{ readonly depth: number }> = split ? [...live, { depth: 1 }, ...done] : agents;
  // Whether a later line sits at `depth` before the tree climbs above it: that level's rail runs on past line i.
  const continues = (i: number, depth: number) => {
    for (const b of lines.slice(i + 1)) {
      if (b.depth < depth) return false;
      if (b.depth === depth) return true;
    }
    return false;
  };
  const row = (agent: AgentRow, i: number, stagger: number) => {
    const runner = runners.get(agent.id)!;
    const finished = !agentLive(agent);
    return (
      <div key={agent.id} className="relative" style={{ paddingLeft: agent.depth * RAIL_STEP, "--i": stagger } as CSSProperties}>
        {Array.from({ length: agent.depth - 1 }, (_, d) => (continues(i, d + 1) ? <Rail key={d} depth={d + 1} through /> : null))}
        <Rail
          depth={agent.depth}
          last={!continues(i, agent.depth)}
          accent={finished ? undefined : runnerAccent(runner.engine)}
          className={agent.kind === "chat" && agent.id === workspaceId ? "opacity-60" : undefined}
        />
        {agent.kind === "chat" ? (
          <WorkspaceRow workspace={agent.workspace} runner={runner} runnerTag={shared(runner)} finished={finished} />
        ) : (
          <SubagentRow agent={agent} runner={runner} />
        )}
      </div>
    );
  };
  const summary = manyLive(live.length)
    ? manyLine(agents.length, working, waiting).map((part) => (part.endsWith(" working") ? <span key="working" className="lucy-shimmer">{part}</span> : part))
    : [
        working > 0 ? <span key="working" className="lucy-shimmer">{working} working</span> : null,
        waiting > 0 ? `${waiting} ${waiting === 1 ? "needs" : "need"} you` : null,
        split ? `${done.length} done` : null,
      ].filter((part) => part !== null);
  return (
    <div className="relative ml-[13px]" aria-label={`Agents of ${lead.title}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(foldLine, "group/rail")}
      >
        <Rail depth={1} last={!open} className="group-hover/rail:opacity-50" />
        <span aria-hidden className={cn("mr-0.5 flex shrink-0 items-center gap-0.5 transition-opacity duration-100 group-hover/rail:opacity-100", working === 0 && "opacity-50")}>
          {faces.map((r) => (
            <EngineLogo key={r.engine} engine={r.engine} size={12} />
          ))}
        </span>
        <span className="truncate">
          {summary.length > 0
            ? summary.flatMap((part, i) => (i === 0 ? [part] : [" · ", part]))
            : `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`}
        </span>
        <FoldChevron open={open} className="group-hover/rail:opacity-70 group-focus-visible/rail:opacity-70" />
      </button>
      <div className="agent-rows" data-open={open || undefined} inert={!open}>
        <div>
          {split ? (
            <>
              {live.map((agent, i) => row(agent, i, i))}
              <button
                type="button"
                aria-expanded={doneOpen}
                onClick={() => setDoneOpen((o) => !o)}
                className={cn(foldLine, "group/done")}
                style={{ "--i": live.length } as CSSProperties}
              >
                <Rail depth={1} last={!doneOpen} className="group-hover/done:opacity-50" />
                <span className="truncate">{done.length} done</span>
                <FoldChevron open={doneOpen} className="group-hover/done:opacity-70 group-focus-visible/done:opacity-70" />
              </button>
            </>
          ) : (
            agents.map((agent, i) => row(agent, i, i))
          )}
        </div>
      </div>
      {split ? (
        <div className="agent-rows" data-open={(open && doneOpen) || undefined} inert={!(open && doneOpen)}>
          <div>{done.map((agent, i) => row(agent, live.length + 1 + i, i))}</div>
        </div>
      ) : null}
    </div>
  );
}, (a, b) => a.lead === b.lead && sameItems(a.builders, b.builders));

/**
 * A fold's own line under a lead: its agents ("2 working · 9 done"), or the finished ones ("9 done"). Its rail runs
 * inside it. A footnote to the chat above, as short and quiet as any row gets, and below that row, never inside it, so
 * the chat's selection never reaches it.
 */
const foldLine =
  "relative flex h-5 w-full items-center gap-1 rounded-md pl-[18px] text-left text-[12px] text-[hsl(var(--subtle-foreground))] outline-none transition-colors duration-100 hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function FoldChevron({ open, className }: { open: boolean; className: string }) {
  return <Icon icon={ArrowRight01Icon} className={cn("size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-150 ease-snap", className, open && "rotate-90")} strokeWidth={2} />;
}

/**
 * A native subagent under its chat: the engine's logo, its title and whether it still works. It has no
 * chat of its own, so opening it opens its chat with the subagent's own transcript over that chat's
 * Overview (PaneCards), live while it works.
 */
function SubagentRow({ agent, runner }: { agent: Extract<AgentRow, { kind: "subagent" }>; runner: Runner }) {
  const navigate = useNavigate();
  const { subagent, workspaceId } = agent;
  const status = subagent.state === "working" ? "Working" : subagent.state === "failed" ? "Failed" : subagent.state === "stopped" ? "Stopped" : "Done";
  return (
    <button
      type="button"
      onClick={() => {
        panes.show(workspaceId);
        navigate(`/w/${workspaceId}`);
        openSurface(workspaceId, "overview", { agent: subagent.itemId });
      }}
      title={`${subagent.title} · ${status}`}
      data-sidebar-row=""
      aria-label={`${subagent.title}, subagent, ${status}`}
      className={cn(
        "chat-row agent-row group relative flex h-[26px] w-full items-center gap-2 rounded-lg pl-2 pr-2 text-left text-[12px] font-normal outline-none transition-colors duration-75 hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        subagent.state === "working" ? "text-secondary-foreground" : "text-muted-foreground",
      )}
    >
      <RunnerMark runner={runner} size={14} tag="none" className={cn("w-3.5", subagent.state !== "working" && "opacity-50")} />
      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]">{subagent.title}</span>
      {subagent.state === "working" ? (
        <span role="img" aria-label="Working" className="inline-flex">
          <StateMark name="state-working" animate />
        </span>
      ) : subagent.state === "failed" ? (
        <Glyph name="state-failed" label="Failed" />
      ) : null}
    </button>
  );
}

/** Horizontal step between agent levels; a level's rail runs down its left edge. */
const RAIL_STEP = 10;

/**
 * One level's rail in a row: straight `through` it, or bending into the row at its middle on a
 * quarter squircle (CSS `corner-shape`; a round bend where unsupported) and, unless `last`, also
 * running on down to the next row. The bend's box is exactly its radius tall, so all of its left
 * edge is curve and it meets the straight rail tangent, with no doubled hairline. Lines stay inside
 * their row, so they never cross a neighbour's hover or selection.
 */
function Rail({ depth, last = false, through = false, accent, className }: { depth: number; last?: boolean; through?: boolean; accent?: string | undefined; className?: string | undefined }) {
  const left = (depth - 1) * RAIL_STEP;
  const bend = "absolute top-[calc(50%-8px)] h-2 w-3.5 rounded-bl-[8px] border-b border-l [corner-shape:squircle]";
  return (
    <>
      {/* Opacity on the wrapper, not the lines: where the bend meets the rail the two overlap, and
          translucent lines would darken there. */}
      <span aria-hidden className={cn("pointer-events-none absolute inset-0 opacity-30 transition-opacity duration-100", className)}>
        <span className={cn("absolute top-0 w-0 border-l border-sidebar-foreground", last ? "h-[calc(50%-8px)]" : "bottom-0")} style={{ left }} />
        {through || accent ? null : <span className={cn(bend, "border-sidebar-foreground")} style={{ left }} />}
      </span>
      {/* A delegated agent's bend takes its harness accent: the rail says who runs each row. */}
      {accent && !through ? <span aria-hidden className={cn(bend, "pointer-events-none opacity-80")} style={{ left, borderColor: accent }} /> : null}
    </>
  );
}

interface FolderActions {
  readonly rename: () => void;
  readonly copyPath: () => void;
  /** Its open chats, pinned ones included: Remove archives them first. */
  readonly chats: number;
  readonly remove: (chats: number) => void;
  /** A plain folder (no_git) made a git repository: project.init_git. */
  readonly initGit: () => void;
  /** Pins it to the top of the list, or unpins it. */
  readonly pin: () => void;
  /** Archives it (it leaves the list and the pickers, its chats and files kept), or brings it back. */
  readonly archive: () => void;
}

/**
 * A project's menu, opened at a point in its row (the pointer, or under its start from the keyboard): the project's
 * actions, then its Chief's and Add a Chief, then where it lives, and last taking it away.
 */
function FolderMenu({
  folder,
  menu,
  onOpenChange,
  onClosed,
  onNewChat,
  actions,
  fold,
}: {
  folder: SidebarFolder;
  /** Open or not, and where in the row it opens. */
  menu: { readonly open: boolean; readonly x: number; readonly y: number };
  onOpenChange: (open: boolean) => void;
  /** Closed with nothing put in the row: focus goes back to the row. */
  onClosed: () => void;
  onNewChat: () => void;
  actions: FolderActions;
  /** Folded or not, and the switch: the row has no chevron, so the menu holds it. */
  fold: { readonly open: boolean; readonly toggle: () => void };
}) {
  const renaming = useRef(false);
  const [initAsking, setInitAsking] = useState(false);
  const [removeAsking, setRemoveAsking] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  const chats = actions.chats;
  return (
    <>
    <DropdownMenu open={menu.open} onOpenChange={onOpenChange}>
      {/* No button of its own: it opens where it was asked for, at the pointer or under the row's start. */}
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none absolute size-0" style={{ left: menu.x, top: menu.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        aria-label={`${folder.project.name} options`}
        className="w-[220px]"
        onCloseAutoFocus={(e) => {
          // Rename puts a field in the row and keeps focus there; anything else hands it back to the row.
          const keep = renaming.current;
          keepRenameFocus(e, renaming);
          if (!keep) {
            e.preventDefault();
            onClosed();
          }
        }}
      >
        <DropdownMenuItem onSelect={onNewChat}>
          <Icon icon={Add01Icon} /> New chat
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={fold.toggle}>
          <Icon icon={fold.open ? ArrowUp01Icon : ArrowDown01Icon} /> {fold.open ? "Hide chats" : "Show chats"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            renaming.current = true;
            actions.rename();
          }}
        >
          <Icon icon={PencilEdit02Icon} /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setLogoOpen(true)}>
          <Icon icon={Image01Icon} /> Logo…
        </DropdownMenuItem>
        {folder.project.no_git ? (
          <DropdownMenuItem onSelect={() => setInitAsking(true)} className="h-auto min-h-8 items-start py-1.5">
            <Icon icon={GitBranchIcon} className="mt-px" />
            <span>
              Initialize git
              <span className="block text-[12px] text-muted-foreground">New chats get their own branch</span>
            </span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {folder.project.archivedAt ? null : (
          <DropdownMenuItem onSelect={actions.pin}>
            {folder.project.pinnedAt ? (
              <>
                <Icon icon={PinOffIcon} /> Unpin project
              </>
            ) : (
              <>
                <Icon icon={PinIcon} /> Pin to top
              </>
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={actions.archive}>
          <Icon icon={folder.project.archivedAt ? ArchiveRestoreIcon : Archive02Icon} />
          {folder.project.archivedAt ? "Unarchive project" : "Archive project"}
        </DropdownMenuItem>
        {/* Where it lives, then (alone, last) taking it away. */}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={actions.copyPath}>
          <Icon icon={Copy01Icon} /> Copy path
        </DropdownMenuItem>
        <FolderItems path={folder.project.path} />
        {folder.project.repository ? (
          <DropdownMenuItem title={folder.project.repository.full_name} onSelect={() => window.open(folder.project.repository!.web_url, "_blank", "noopener")}>
            {folder.project.repository.host === "github.com" ? (
              <>
                <BrandMark name="github" /> Open on GitHub
              </>
            ) : (
              <>
                <Icon icon={LinkSquare02Icon} /> Open on {folder.project.repository.host}
              </>
            )}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {/* With chats in it, it asks first: they are archived with it. Without, there is nothing to lose. */}
        <DropdownMenuItem variant="destructive" onSelect={() => (chats > 0 ? setRemoveAsking(true) : actions.remove(0))} className="h-auto min-h-8 items-start py-1.5">
          <Icon icon={Delete02Icon} className="mt-px" />
          <span>
            Remove project
            <span className="block text-[12px] text-muted-foreground">{chats > 0 ? `Archives its ${chats === 1 ? "chat" : `${chats} chats`}` : "Its files stay where they are"}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <ConfirmDialog
      open={removeAsking}
      onOpenChange={setRemoveAsking}
      title={`Remove ${folder.project.name}?`}
      description={`Its ${chats === 1 ? "chat is" : `${chats} chats are`} archived first: a running turn stops, and uncommitted work is kept. Restoring a chat from Archived brings the project back. Its files stay where they are.`}
      confirmLabel={chats === 1 ? "Archive chat and remove" : "Archive chats and remove"}
      destructive
      onConfirm={() => {
        setRemoveAsking(false);
        actions.remove(chats);
      }}
    />
    <ProjectLogoDialog project={folder.project} open={logoOpen} onOpenChange={setLogoOpen} />
    <ConfirmDialog
      open={initAsking}
      onOpenChange={setInitAsking}
      title={`Make ${folder.project.name} a git repository?`}
      description="Runs git init in the folder and commits its files (anything a .gitignore there names stays out). New chats then work on their own branch in a worktree, with diffs, checkpoints and pull requests. Chats already running here stay in the folder."
      confirmLabel="Initialize git"
      onConfirm={() => {
        setInitAsking(false);
        actions.initGit();
      }}
    />
    </>
  );
}

interface StandInActions {
  /** Its open chats, pinned ones included. */
  readonly chats: number;
  readonly archive: () => void;
}

/** The menu of a folder with no project behind it: archiving its chats is all there is to do, and takes it away. */
function StandInMenu({
  folder,
  menu,
  onOpenChange,
  onClosed,
  actions,
}: {
  folder: SidebarFolder;
  /** Open or not, and where in the row it opens (FolderMenu's). */
  menu: { readonly open: boolean; readonly x: number; readonly y: number };
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
  actions: StandInActions;
}) {
  const [asking, setAsking] = useState(false);
  const { chats } = actions;
  const them = chats === 1 ? "the chat" : `the ${chats} chats`;
  return (
    <>
      <DropdownMenu open={menu.open} onOpenChange={onOpenChange}>
        {/* No button of its own, as FolderMenu: it opens where it was asked for. */}
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none absolute size-0" style={{ left: menu.x, top: menu.y }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={2}
          aria-label={`${folder.project.name} options`}
          className="w-[220px]"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onClosed();
          }}
        >
          <DropdownMenuItem onSelect={() => setAsking(true)} className="h-auto min-h-8 items-start py-1.5">
            <Icon icon={Archive02Icon} className="mt-px" />
            <span>
              {chats === 1 ? "Archive chat" : "Archive chats"}
              <span className="block text-[12px] text-muted-foreground">Removes this folder</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Archive ${them} in ${folder.project.name}?`}
        description={`The folder goes with ${chats === 1 ? "it" : "them"}. A running turn stops, and uncommitted work is kept. Restore brings a chat back from Archived.`}
        confirmLabel={chats === 1 ? "Archive chat" : "Archive chats"}
        onConfirm={() => {
          setAsking(false);
          actions.archive();
        }}
      />
    </>
  );
}

/**
 * A row menu closing: Rename puts a field in the row, so focus must stay there; anything else (Escape,
 * Pin, Fork) hands focus back to the menu's button, so a keyboard user keeps their place.
 */
export function keepRenameFocus(e: Pick<Event, "preventDefault">, renaming: { current: boolean }): void {
  if (renaming.current) e.preventDefault();
  renaming.current = false;
}

/**
 * What a chat row shows at its end: its status (model.ts chatStatus: an ask as one amber dot, a turn at
 * work with its clock or todos, a lead waiting on its agents, ready to build, failed, done and unread,
 * asleep), and where it runs only when that is somewhere else; a chat here ends quietly. Exported for its test.
 */
export function trailingFor(w: WorkspaceView, status: ChatStatus | null = chatStatus(w), web = CLOUD_HOSTED): ReactNode {
  // On This Mac, a parked chat that moved to Cloud and that Cloud's list has not spoken for yet: it runs
  // on there, it is not asleep. Once Cloud's list places it (synced.remote), its row says what its place is.
  if (status?.id === "asleep" && w.computer.kind === "caveman_cloud" && !web && !(w as MergedView).synced?.remote) return <Glyph name="computer-cloud" label="In Cloud" />;
  // A chat running on another computer (a Cloud computer, another Mac) keeps its row here; a small glyph says where.
  const away = awayMark(w, undefined, web);
  if (status && away)
    return (
      <span className="flex items-center gap-0.5">
        {away}
        <StatusMark status={status} animate />
      </span>
    );
  if (status) return <StatusMark status={status} animate />;
  // A delegated agent runs on its lead's computer; its logo says the rest (model and effort on hover).
  return w.parentId ? null : away;
}

/**
 * The mark of where a chat runs when that is not this computer: a cloud for Cloud (one place, never a machine's name),
 * a Mac's by its own name; null for a chat on this computer (every row would say it).
 */
function awayMark(w: WorkspaceView, className = "scale-75 opacity-60", web = CLOUD_HOSTED): ReactNode {
  const synced = (w as MergedView).synced;
  // In a browser window no chat is "here": the runtime the window quietly uses is one its person never chose
  // (state/sync/web-window.ts quietHome), so every chat says its place, as Cloud's list names it.
  if (web) {
    if (!synced) return null;
    const cloud = synced.where.kind === "cloud";
    return <Glyph name={COMPUTER_KIND_ICON[cloud ? "caveman_cloud" : "laptop"] ?? "computer-vpc"} label={cloud ? "In Cloud" : `On ${synced.where.name}`} className={className} />;
  }
  if (!synced?.remote) return null;
  const label = w.computer.kind === "caveman_cloud" ? "In Cloud" : `On ${w.computer.label}`;
  return <Glyph name={COMPUTER_KIND_ICON[w.computer.kind] ?? "computer-vpc"} label={label} className={className} />;
}

/** Every chat's status, worked out once per workspace list (SidebarPanel) for each row to read. */
/**
 * Every row's status, as a store the rows read one entry of: a push that changes one chat's status re-renders that
 * row, where a context would re-render them all. Statuses that read the same keep their object.
 */
interface StatusStore {
  readonly get: () => ReadonlyMap<string, ChatStatus | null>;
  readonly subscribe: (listener: () => void) => () => void;
}
const StatusContext = createContext<StatusStore | null>(null);
const NO_STATUSES: ReadonlyMap<string, ChatStatus | null> = new Map();
const noStatusSubscribe = () => () => undefined;
const noStatuses = () => NO_STATUSES;

function useStatusStore(statuses: ReadonlyMap<string, ChatStatus | null>): StatusStore {
  const [store] = useState(() => {
    let current = statuses;
    const listeners = new Set<() => void>();
    return {
      get: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      publish: (next: ReadonlyMap<string, ChatStatus | null>) => {
        const shared = new Map([...next].map(([id, status]) => [id, sameStatus(current.get(id), status) ? current.get(id)! : status]));
        if (shared.size === current.size && [...shared].every(([id, status]) => current.get(id) === status)) return;
        current = shared;
        for (const listener of listeners) listener();
      },
    };
  });
  useLayoutEffect(() => store.publish(statuses), [store, statuses]);
  return store;
}

function sameStatus(a: ChatStatus | null | undefined, b: ChatStatus | null): boolean {
  if (a === undefined) return false;
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.action === b.action &&
    a.since === b.since &&
    a.agents === b.agents &&
    a.progress?.done === b.progress?.done &&
    a.progress?.total === b.progress?.total
  );
}

function useAllStatuses(): ReadonlyMap<string, ChatStatus | null> {
  const store = useContext(StatusContext);
  return useSyncExternalStore(store?.subscribe ?? noStatusSubscribe, store?.get ?? noStatuses);
}

function useChatStatus(w: WorkspaceView): ChatStatus | null {
  const store = useContext(StatusContext);
  const status = useSyncExternalStore(store?.subscribe ?? noStatusSubscribe, () => (store ? store.get().get(w.id) : undefined));
  return status !== undefined ? status : chatStatus(w);
}

/** The row the pointer rests on, and how long it rests before its chat renders hidden in the pane (sweeping past renders none). */
let resting: string | null = null;
let restTimer: ReturnType<typeof setTimeout> | undefined;
const REST_MS = 80;

/**
 * What every chat row does: click opens it (or, when it is already open in a pane, focuses that
 * pane: panes.show never duplicates), dragging onto the main area opens it in split view. `open`
 * follows the panes live, so the Open mark appears and goes as sessions open and close.
 */
function useChatRow(workspace: WorkspaceView) {
  const { workspaceId } = useParams();
  const { client } = useRuntimeClient();
  const hub = useSyncHub();
  // A chat on another computer loads through the sync hub, even in a tab with no runtime of its own.
  const rowClient = () => (hub && workspace.sessionId && hub.throughHub(workspace.sessionId) ? chatClientFor(hub, workspace.sessionId) : client);
  const selected = workspaceId === workspace.id;
  const open = useOpenWorkspaces().includes(workspace.id);
  // The tab it is open in, while there are two or more; ⌘-click or a middle click opens it in a tab of its own.
  const tab = useChatTab(workspace.id);
  // Where it is open in a split: its tab's panes in miniature, its own lit (quieter while that tab is behind). A chat
  // alone in its tab shows none; one pane reads as a full-screen button.
  const home = useChatHome(workspace.id);
  const pane = home && paneOf(home.tab.layout, workspace.id);
  const where = home && pane && leaves(home.tab.layout.root).length > 1 ? <SplitMap layout={home.tab.layout} lit={pane.id} faint={!home.front} /> : null;
  const go = useTabNav();
  const showChat = useShowChat();
  const inNewTab = (e: MouseEvent<HTMLElement>) => {
    if (!wantsNewTab(e)) return false;
    e.preventDefault();
    go(windowTabs.openChat(workspace.id));
    return true;
  };
  const props = {
    type: "button" as const,
    "data-sidebar-row": "",
    // Tidy points at it: set back while its button is hovered, fading out once pressed (Tidy.tsx).
    "data-tidy": useTidyMark(workspace.id),
    "data-open": open || undefined,
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (inNewTab(e)) return;
      showChat(workspace.id);
    },
    onAuxClick: (e: MouseEvent<HTMLElement>) => void inNewTab(e),
    // The pointer on its way to a chat: its history loads now, so the click opens it whole; resting on the row, the chat
    // renders hidden in the pane, so the click only shows it. A pointer that moved onto the row, not a row that slid
    // under a still one (a push reordering the list): that renders no chat nobody reached for.
    onPointerMove: () => {
      if (resting === workspace.id) return;
      resting = workspace.id;
      // On another computer: its connection opens now, so the click finds it up (S14).
      if (workspace.sessionId) hub?.preconnect(workspace.sessionId);
      prefetchSession(rowClient(), workspace.sessionId, () => {
        clearTimeout(restTimer);
        restTimer = setTimeout(() => resting === workspace.id && warmChat.set(workspace.id), REST_MS);
      });
    },
    onPointerLeave: () => {
      if (resting === workspace.id) resting = null;
    },
    onFocus: () => {
      if (workspace.sessionId) hub?.preconnect(workspace.sessionId);
      prefetchSession(rowClient(), workspace.sessionId);
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) =>
      beginDrag(e, {
        workspaceId: workspace.id,
        title: workspace.title,
        meta: workspace.branch ? `${workspace.repo} · ${workspace.branch}` : workspace.repo,
        detail: `${engineLine(workspace, workspace.engine.label)} · ${workspace.computer.label}`,
        fromPaneId: null,
      }),
    "aria-current": selected ? ("page" as const) : undefined,
    "aria-description": open ? "Open in a pane" : tab > 0 ? `Open in tab ${tab}` : undefined,
  };
  // The focused pane's chat is selected; the split's others on screen with it are a step softer.
  const tone = cn(
    "outline-none [transition:color_75ms,background-color_75ms,opacity_150ms_var(--ease-snap)] data-[tidy=leaving]:opacity-0 data-[tidy=preview]:opacity-40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : open && workspaceId !== undefined ? "bg-sidebar-accent/35 hover:bg-sidebar-accent/60" : "hover:bg-sidebar-accent/60",
 // compact rows: a read chat sits back at 65% ink; unread or open lifts to full ink at medium, never semibold.
    workspace.unread || selected ? "font-medium text-sidebar-accent-foreground" : "font-normal text-foreground/65",
  );
  return { props, tone, where };
}

/** upstream slim row (36px): a settled or snoozed chat, one line. */
const SLIM = "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[14px]";
/** A row's actions on hover: in its status's place, at the row's right edge. */
const ROW_ACTIONS = "pointer-events-none absolute right-1.5 flex items-center opacity-0 transition-opacity duration-75 group-hover/row:pointer-events-auto group-hover/row:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100";
const ROW_ACTION = "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35";

/**
 * A queue row, upstream two sizes. Pinned, Needs you, Working and Ready for review are cards: the title, its pull
 * request's glyph and its status (or, on Ready for review, how long ago it moved); under them, in up to two lines,
 * what the chat says: the ask while it waits on you, else its latest answer (Workspace.activity.last_reply), else what
 * waits to land; and last, small, its project with a repo mark and, while it works, its spinner and clock. Done and Snoozed are slim (36px): where its work lives,
 * the title, its pull request, and at the end when it wakes, when it is archived (`archivesAt`, null while nothing
 * will) or how long ago it moved. On hover the status gives way to the actions, plain text as upstream: Done, which marks
 * it done (it drops to the Done shelf and comes back when something new happens), Wake on a snoozed chat, and on a
 * marked one Undo and Archive (its uncommitted work kept; Restore brings it back). A right-click (`onMenu`) opens the
 * rest.
 */
function QueueRow({ workspace, section, project, now, archivesAt, actions, onMenu, renaming, onRenamed }: { workspace: WorkspaceView; section: QueueSection; project: QueueProject | undefined; now: number; archivesAt: number | null; actions: QueueActions | null; onMenu: ((x: number, y: number) => void) | undefined; renaming: boolean; onRenamed: (title: string) => void }) {
  const { props, tone, where } = useChatRow(workspace);
  // On a touch screen, holding the row opens the menu a right-click opens.
  const hold = useLongPress((x, y) => onMenu?.(x, y));
  const status = useChatStatus(workspace);
  const place = chatPlace(workspace, project);
  const slim = section === "done" || section === "snoozed";
  // Only a real ask: Ready to build is an action too, but its line is canned, and the latest answer says more.
  const ask = status?.action && status.id !== "ready" && status.detail ? status.detail : null;
  const snoozedUntil = section === "snoozed" ? workspace.inbox?.snoozedUntil : null;
  // How long ago: on Ready for review since it finished; on Done since it was called done.
  const age = section === "review";
  const marked = section === "done";
  const doneAt = marked ? workspace.inbox?.doneAt : undefined;
  // What waits to land when no pull request pill says it.
  const toLand = section === "review" ? unmergedLine(unmergedWork(workspace)) : null;
  // Under a card's title: its latest answer, else (before its first) what waits to land.
  const said = workspace.reply ?? toLand;
  // A card's turn at work (its spinner, clock, todos or agents) rides small on the project line; other statuses keep the title's end.
  const running = !slim && (status?.id === "working" || status?.id === "agents" || status?.id === "waking");
  const act = (e: MouseEvent, run: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    run();
  };
  if (renaming) {
    // The menu's Rename edits the title in place, as a chat row's does; Escape keeps the old one.
    return (
      <div className={cn("flex items-center px-1 py-0.5", slim ? "h-10" : "h-[100px]")}>
        <input
          autoFocus
          defaultValue={workspace.title}
          aria-label="Chat name"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => onRenamed(e.currentTarget.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.value = workspace.title;
            if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-ring/60 bg-background px-1.5 text-[14px] text-foreground outline-none"
        />
      </div>
    );
  }
  const mark = place.on === "github" ? <BrandMark name="github" size={12} label="On GitHub" className="shrink-0 opacity-60" /> : awayMark(workspace, "-mx-0.5 shrink-0 scale-75 opacity-60");
  // At rest: where it is open in a split, then when it wakes, when it is archived, or its status. On hover, the actions.
  const rest = snoozedUntil ? (
    <span className="inline-flex items-center gap-1 text-[12px] font-normal tabular-nums text-muted-foreground" title={`Wakes ${new Date(snoozedUntil).toLocaleString()}`}>
      <Icon icon={AlarmClockIcon} className="size-3" />
      {wakeLabel(snoozedUntil, now)}
    </span>
  ) : archivesAt !== null ? (
    <span
      role="img"
      aria-label={`Archived in ${wakeLabel(new Date(archivesAt).toISOString(), now)}`}
      title={archivesAt > now ? `Archived ${new Date(archivesAt).toLocaleString()}` : "Archived within the hour"}
      className="inline-flex items-center gap-1 text-[12px] font-normal tabular-nums text-[hsl(var(--subtle-foreground))]"
    >
      <Icon icon={Archive02Icon} className="size-3" />
      {wakeLabel(new Date(archivesAt).toISOString(), now)}
    </span>
  ) : doneAt ? (
    <time dateTime={doneAt} title={`Done ${new Date(doneAt).toLocaleString()}`} className="text-[12px] font-normal tabular-nums text-[hsl(var(--subtle-foreground))]">
      {rowAge(doneAt, now)}
    </time>
  ) : status && !running && !slim ? (
    <StatusMark status={status} />
  ) : null;
  const hideOnHover = actions && "group-hover/row:hidden group-has-[:focus-visible]/row:hidden";
  const roomOnHover = actions && "group-hover/row:pr-[132px] group-has-[:focus-visible]/row:pr-[132px]";
  return (
    <div
      data-peek={`chat:${workspace.id}`}
      className="group/row relative py-0.5"
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      {...hold}
    >
      {slim ? (
        <button {...props} title={place.name} className={cn("group relative", SLIM, roomOnHover, tone)}>
          {/* The title first in the markup, so a row's name starts with it; the mark still draws first. */}
          <span className="min-w-0 flex-1 truncate">{workspace.title}</span>
          {mark ? <span className="-order-1 flex shrink-0 items-center">{mark}</span> : null}
          <ChatPrMarks workspace={workspace} projectId={workspace.projectId} />
          <span className={cn("flex shrink-0 items-center gap-1.5", hideOnHover)}>
            {where}
            {rest}
          </span>
        </button>
      ) : (
        <button {...props} className={cn("group relative flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left", tone)}>
          <span className={cn("flex h-5 w-full min-w-0 items-center gap-1.5", roomOnHover)}>
            <span className="min-w-0 flex-1 truncate text-[14px]">{workspace.title}</span>
            <ChatPrMarks workspace={workspace} projectId={workspace.projectId} />
            <span className={cn("flex shrink-0 items-center gap-1.5", hideOnHover)}>
              {where}
              {rest}
              {/* On Ready for review, how long ago it finished tells one that just finished from an old one. */}
              {age ? (
                <time dateTime={workspace.updatedAt} title={new Date(workspace.updatedAt).toLocaleString()} className="text-[12px] font-normal tabular-nums text-[hsl(var(--subtle-foreground))]">
                  {rowAge(workspace.updatedAt, now)}
                </time>
              ) : null}
            </span>
          </span>
          {/* What the chat says, not where it lives: the ask while it waits on you, else its latest answer. */}
          {ask || said ? (
            <span className={cn("line-clamp-2 w-full text-[13px] font-normal leading-[18px]", ask ? "text-muted-foreground" : "text-[hsl(var(--subtle-foreground))]")}>{ask ?? said}</span>
          ) : null}
          {/* Where its work lives, small under what it says: the GitHub mark for a GitHub repo, else the repo glyph. */}
          <span className="flex h-4 w-full min-w-0 items-center gap-1 text-[11.5px] font-normal text-[hsl(var(--subtle-foreground))]">
            {place.on === "github" ? <BrandMark name="github" size={11} className="shrink-0 opacity-70" /> : <Glyph name="repo" className="size-3 opacity-70" />}
            <span className="min-w-0 truncate">{place.name}</span>
            {running && status ? <StatusMark status={status} small className="ml-auto" /> : null}
          </span>
        </button>
      )}
      {actions ? (
        <span className={cn(ROW_ACTIONS, slim ? "top-1/2 -translate-y-1/2" : "top-[10px]")}>
          {marked ? (
            <>
              <button type="button" aria-label={`Not done: ${workspace.title}`} title="Not done" onClick={(e) => act(e, () => actions.inbox(workspace, { do: "reopen" }))} className={ROW_ACTION}>
                <Icon icon={Undo02Icon} className="size-3.5" />
                Undo
              </button>
              <button type="button" aria-label={`Archive ${workspace.title}`} title="Archive (Restore brings it back)" onClick={(e) => act(e, () => actions.archive(workspace))} className={ROW_ACTION}>
                <Icon icon={Archive02Icon} className="size-3.5" />
                Archive
              </button>
            </>
          ) : (
            <>
              {section === "snoozed" ? (
                <button type="button" aria-label={`Wake ${workspace.title} now`} title="Wake now" onClick={(e) => act(e, () => actions.inbox(workspace, { do: "wake" }))} className={ROW_ACTION}>
                  <Icon icon={AlarmClockOffIcon} className="size-3.5" />
                </button>
              ) : null}
              <button type="button" aria-label={`Done: ${workspace.title}`} title="Mark done" onClick={(e) => act(e, () => actions.inbox(workspace, { do: "done" }))} className={ROW_ACTION}>
                <Icon icon={Tick02Icon} className="size-3.5" strokeWidth={2} />
                Done
              </button>
            </>
          )}
        </span>
      ) : null}
    </div>
  );
}

/** "3 files, 2 commits": what a chat's worktree holds that its base does not; null when nothing. */
export function unmergedLine(u: WorkspaceView["unmerged"]): string | null {
  if (!u) return null;
  const parts = [u.files > 0 ? `${u.files} ${u.files === 1 ? "file" : "files"}` : null, u.commits > 0 ? `${u.commits} ${u.commits === 1 ? "commit" : "commits"}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Add to Chief: puts a chat you started on a Chief's board (chief.attach), so that Chief hears its updates and can
 * steer and answer it. One Chief: added at once; several: a submenu picks which. A chat on a board already says whose.
 * Mounted only while its menu is open.
 */
function AddToChief({ workspace }: { workspace: WorkspaceView }) {
  const chiefs = useChiefs();
  const board = useChief();
  if (chiefs.status !== "ready" || chiefs.chiefs.length === 0) return null;
  const on = board.items.find((i) => i.workspace_ids.includes(workspace.id));
  if (on) {
    const owner = chiefs.chiefs.find((c) => (on.chief_id === undefined ? c.home : c.id === on.chief_id));
    return (
      <DropdownMenuItem disabled>
        <ChiefSprite avatar={owner?.avatar ?? null} /> On {owner?.name ?? "a Chief"}'s board
      </DropdownMenuItem>
    );
  }
  const add = (chief: ChiefProfile) =>
    void chiefs.attachChat(chief, workspace.id).then(
      () => announce(`Added ${workspace.title} to ${chief.name}'s board.`),
      (e: unknown) => announce(`Not added: ${e instanceof Error ? e.message : String(e)}`),
    );
  const [only] = chiefs.chiefs;
  if (chiefs.chiefs.length === 1 && only)
    return (
      <DropdownMenuItem onSelect={() => add(only)}>
        <ChiefSprite avatar={only.avatar} /> Add to {only.name}
      </DropdownMenuItem>
    );
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon icon={Add01Icon} /> Add to Chief
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[180px]">
        {chiefs.chiefs.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => add(c)}>
            <ChiefSprite avatar={c.avatar} /> {c.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * A chat's menu, one list for every place a chat is right-clicked (the chat list's rows, the queue's, and a Chief's Work
 * list, under its Chat submenu), so they can't drift: Open in new tab, Rename, Review, Fork, Add to Chief, the inbox's Done/Snooze/Pin/Unread, Reveal and
 * Terminal, Archive. Each place owns only how a rename is edited and how (or whether) an archive is sent.
 */
export function ChatMenuItems({ workspace, onRename, onCustomSnooze, onArchive }: { workspace: WorkspaceView; onRename: (() => void) | null; onCustomSnooze: () => void; onArchive: (() => void) | null }) {
  const go = useTabNav();
  const navigate = useNavigate();
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  // This Mac only: the chat's worktree, for Reveal in Finder and Open in Terminal.
  const rootPath = useRuntimeSelector((v) => v.raw.get(workspace.id)?.root_path);
  // A chat in a plain folder has no checkout of its own to fork (Project.no_git: its branch is empty).
  const canFork = useRuntimeSelector((v) => v.engines.find((e) => e.id === workspace.engine.id)?.capabilities.fork === true) && workspace.sessionId !== null && workspace.branch !== "";
  return (
    <>
      {IS_DESKTOP ? (
        <>
          <DropdownMenuItem onSelect={() => go(windowTabs.openChat(workspace.id))}>
            <Icon icon={ArrowUpRight01Icon} /> Open in new tab
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      ) : null}
      {/* null: this place has no title to edit in place (the Chief's Work list). */}
      {onRename ? (
        <DropdownMenuItem onSelect={onRename}>
          <Icon icon={PencilEdit02Icon} /> Rename
        </DropdownMenuItem>
      ) : null}
      {workspace.sources && workspace.projectId ? (
        // A chat in several sources: one Review per pull request, named by its source.
        workspace.sources.map((s) =>
          s.pullRequest ? (
            <DropdownMenuItem key={s.name} onSelect={() => navigate(prPath({ project_id: workspace.projectId!, number: s.pullRequest!.number, repo: s.repo, host: s.host }))}>
              <Icon icon={GitPullRequestIcon} /> Review {s.name} #{s.pullRequest.number}
            </DropdownMenuItem>
          ) : null,
        )
      ) : workspace.pullRequest && workspace.projectId ? (
        <DropdownMenuItem onSelect={() => navigate(prPath({ project_id: workspace.projectId!, number: workspace.pullRequest!.number }))}>
          <Icon icon={GitPullRequestIcon} /> Review #{workspace.pullRequest.number}
        </DropdownMenuItem>
      ) : null}
      {canFork && client ? (
        <DropdownMenuItem
          onSelect={() =>
            void client.call("session.fork", { request_id: requestId(), session_id: workspace.sessionId! }).then((r) => {
              panes.show(r.workspace.id);
              navigate(`/w/${r.workspace.id}`);
              announce(`Forked into ${r.workspace.title}.`);
              refresh();
            }, (e: unknown) => announce(e instanceof Error ? e.message : String(e)))
          }
        >
          <Icon icon={GitForkIcon} /> Fork
        </DropdownMenuItem>
      ) : null}
      <AddToChief workspace={workspace} />
      <MoveToTopic workspace={workspace} />
      <DropdownMenuSeparator />
      <InboxItems workspace={workspace} onCustomSnooze={onCustomSnooze} />
      <FolderItems path={rootPath ?? null} separated />
      <DropdownMenuSeparator />
      {/* null: this place won't archive it now (the queue, while it works). */}
      <DropdownMenuItem disabled={!onArchive} onSelect={() => onArchive?.()}>
        <Icon icon={Archive02Icon} /> Archive
      </DropdownMenuItem>
    </>
  );
}

/**
 * A chat row: click opens it; right-click or its ⋯ opens Rename, Fork, Pin, Done, Snooze, Mark unread and Archive. Its
 * end shows its status (`trailingFor`). `finished`: an agent's chat whose work is over, a step quieter again.
 */
/**
 * A chat in a project folder with one pull request wears its glyph on the folder's rule, left of its title, like a
 * commit on a branch: its title keeps the row's whole width and the edge every title starts on. Several pull
 * requests (a chat in several sources) stay together at the row's end.
 */
function prOnRule(w: Pick<WorkspaceView, "pullRequest" | "sources">): boolean {
  return (w.sources ? w.sources.filter((s) => s.pullRequest).length : w.pullRequest ? 1 : 0) === 1;
}

const WorkspaceRow = memo(function WorkspaceRow({ workspace, runner, runnerTag = false, finished = false, chief, prOnRule: onRule = false }: { workspace: WorkspaceView; runner?: Runner | undefined; runnerTag?: boolean; finished?: boolean; /** The Chief whose board it is on, before its status (the sidebar by topic). */ chief?: ChiefMark | undefined; /** In a project folder: a lone pull request's glyph sits on the folder's rule (prOnRule). */ prOnRule?: boolean }) {
  const identity = useId();
  const ruled = onRule && prOnRule(workspace);
  const { props, tone, where } = useChatRow(workspace);
  const trailing = trailingFor(workspace, useChatStatus(workspace));
  const { client } = useRuntimeClient();
  const refresh = useRuntimeSelector((v) => v.refresh);
  const [menu, setMenu] = useState(false);
  // On a touch screen, holding the row opens its menu (a right-click with a mouse; iOS never sends one).
  const hold = useLongPress(() => client && setMenu(true));
  const [customSnooze, setCustomSnooze] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const renameChosen = useRef(false);
  // A rename finished from the keyboard (Enter or Escape) puts focus back on the row, not on <body>.
  const rowButton = useRef<HTMLButtonElement>(null);
  const refocusRow = useRef(false);
  useEffect(() => {
    if (renaming || !refocusRow.current) return;
    refocusRow.current = false;
    rowButton.current?.focus();
  }, [renaming]);
  const act = (call: Promise<unknown>) => void call.then(refresh, (e: unknown) => announce(e instanceof Error ? e.message : String(e)));
  if (renaming) {
    return (
      <div className={cn("chat-row flex items-center pl-1 pr-1", runner ? "agent-row h-[26px]" : "h-[30px]")}>
        <input
          autoFocus
          defaultValue={workspace.title}
          aria-label="Chat name"
          onFocus={(e) => e.currentTarget.select()}
          onChange={markTyped}
          onBlur={(e) => {
            setRenaming(false);
            const title = renamedTo(e.currentTarget, workspace.title);
            if (client && title) act(client.call("workspace.rename", { request_id: requestId(), workspace_id: workspace.id, title }));
          }}
          onKeyDown={(e) => {
            // An input method's Enter picks its candidate and its Escape cancels the composition: neither ends the rename.
            if (isComposing(e)) return;
            if (e.key === "Enter") {
              refocusRow.current = true;
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              refocusRow.current = true;
              e.currentTarget.value = workspace.title;
              e.currentTarget.blur();
            }
          }}
          className={cn("min-w-0 flex-1 rounded-md border border-ring/60 bg-background px-1.5 text-foreground outline-none", runner ? "h-full text-[12px]" : "h-7 text-[13px]")}
        />
      </div>
    );
  }
  return (
    <div
      data-peek={`chat:${workspace.id}`}
      className="group/chat relative"
      onContextMenu={(e) => {
        if (!client) return;
        e.preventDefault();
        setMenu(true);
      }}
      {...hold}
    >
      <button
        ref={rowButton}
        {...props}
        {...(runner ? { "aria-label": workspace.title, "aria-describedby": identity } : {})}
        className={cn(
          // pl-2.5: a chat's title starts on the sidebar's one text edge, with the nav rows', its project's and the Chief's.
          "chat-row group relative flex w-full items-center gap-2 rounded-lg pl-2.5 pr-2 text-left",
          tone,
          // A delegated agent's row is a step quieter than a chat's: shorter, smaller, regular, secondary (muted once it finished).
          runner ? cn("agent-row h-[26px] text-[12px] font-normal", props["aria-current"] ? "text-sidebar-accent-foreground" : finished ? "text-muted-foreground" : "text-secondary-foreground") : "h-[30px] text-[13px]",
        )}
      >
        {runner ? (
          <>
            <RunnerMark runner={runner} size={14} tag={runnerTag ? "beside" : "none"} className={cn(!runnerTag && "w-3.5", finished && !props["aria-current"] && "opacity-50")} />
            <span id={identity} hidden>
              {[runner.engineLabel ?? "Agent", runner.tag, shortModel(runner.modelLabel, runner.model), runner.effort && `${runner.effort} effort`].filter(Boolean).join(", ")}
            </span>
          </>
        ) : null}
        {/* Long titles fade out at the edge instead of ending in an ellipsis. */}
        <span className={cn("min-w-0 flex-1 overflow-hidden whitespace-nowrap", runner ? "[mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]" : "[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]")}>
          {workspace.title}
        </span>
        {/* Where it is open, its pull request's glyph, then its state; all step aside for the row's ⋯ on hover (the menu's Review opens the PR). */}
        {chief || where || trailing || (!ruled && (workspace.pullRequest || workspace.sources?.some((s) => s.pullRequest))) ? (
          <span className="flex shrink-0 items-center gap-1.5 text-sidebar-foreground transition-opacity duration-75 group-hover/chat:opacity-0 group-has-[[data-state=open]]/chat:opacity-0">
            {chief ? <ChiefSprite avatar={chief.avatar} label={`On ${chief.name}'s board`} className={cn("size-4 shrink-0", chief.dim && "opacity-50")} /> : null}
            {where}
            {ruled ? null : <ChatPrMarks workspace={workspace} projectId={null} />}
            {trailing}
          </span>
        ) : null}
      </button>
      {/* Centred on the folder's rule, 13px left of the row (the folder's pl-[13px]), outside the row's hover. */}
      {ruled ? <ChatPrMarks workspace={workspace} projectId={null} className="absolute -left-[21px] top-1/2 -translate-y-1/2" /> : null}
      {client ? (
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger
            aria-label={`${workspace.title} options`}
            className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-sidebar-foreground opacity-0 outline-none transition-opacity duration-75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/chat:opacity-100 data-[state=open]:bg-sidebar-accent data-[state=open]:opacity-100"
          >
            <Icon icon={MoreHorizontalIcon} className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[200px]" onCloseAutoFocus={(e) => keepRenameFocus(e, renameChosen)}>
            <ChatMenuItems
              workspace={workspace}
              onRename={() => {
                renameChosen.current = true;
                setRenaming(true);
              }}
              onCustomSnooze={() => setCustomSnooze(true)}
              onArchive={() => act(client.call("workspace.archive", { request_id: requestId(), workspace_id: workspace.id }))}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {customSnooze ? <CustomSnoozeDialog workspace={workspace} open onOpenChange={setCustomSnooze} /> : null}
    </div>
  );
});

/** A downloaded update, one click from installing (the desktop asks first while chats work). */
function UpdatePill() {
  const next = useUpdateReady();
  if (!next) return null;
  return (
    <button
      type="button"
      title={`Caveman Code ${next} is ready. Restart to install it.`}
      onClick={() => window.cavemanDesktop?.updates?.install()}
      className="h-6 shrink-0 rounded-full bg-primary px-2.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
    >
      Restart to update
    </button>
  );
}

/** The desktop's Reveal in Finder (File Explorer on Windows) and Open in Terminal, for a folder on this computer. */
function FolderItems({ path, separated = false }: { path: string | null; separated?: boolean }) {
  const desktop = window.cavemanDesktop;
  if (!path || !desktop?.revealFolder) return null;
  return (
    <>
      {/* Its own group where nothing else in the menu is about the folder; the rule goes with it, never left alone. */}
      {separated ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onSelect={() => desktop.revealFolder?.(path)}>
        <Icon icon={FolderOpenIcon} /> {REVEAL_LABEL}
      </DropdownMenuItem>
      {desktop.openTerminal ? (
        <DropdownMenuItem onSelect={() => desktop.openTerminal?.(path)}>
          <Icon icon={SquareTerminalIcon} /> Open in Terminal
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
