import { cn } from "@caveman-app/ui/lib/cn";
import { Activity, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavigationType, Outlet, useLocation, useMatch, useNavigate, useNavigationType, useParams } from "react-router";
import { enter, settleEntrances } from "@caveman-app/ui/motion";
import { callChief, useChiefs } from "../state/chiefs.ts";
import { IncomingCall, NowShowing } from "../call/CallStage.tsx";
import { usePhone } from "../lib/screen.ts";
import { showingKey, showingTarget } from "../call/showing.ts";
import { useCall } from "../call/store.ts";
import { openSurface } from "../panels/store.ts";
import { CLOUD_HOSTED, useRuntimeSelector, useWebWindow } from "../state/runtime.tsx";
import { macPageOf, NeedsMac } from "./NeedsMac.tsx";
import { CloudWaitLine } from "./CloudWaitLine.tsx";
import { PendingCloudStart } from "./PendingCloudStart.tsx";
import { QueuedStarts } from "./QueuedStarts.tsx";
import { DeviceRequestPrompt, DeviceWaiting } from "../components/Devices.tsx";
import { SyncOffer } from "../components/SyncOffer.tsx";
import { SyncPrompt } from "../components/SyncPrompt.tsx";
import { NotchFeed } from "../notch/NotchFeed.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { SidebarToggle, toggleSidebarKeepingFocus } from "./SidebarToggle.tsx";
import { IS_DESKTOP, isComposing, matchesChord } from "../panels/chrome.tsx";
import { PANES_PATH, windowTabs } from "../panes/store.ts";
import { chord } from "../state/keybindings.ts";
import { useSidebarLayout } from "../state/sidebar-layout.ts";
import { TabStrip, useTabKeys } from "./TabStrip.tsx";
import { useHistoryKeys } from "./HistoryNav.tsx";

type PaneHostModule = typeof import("../panes/PaneHost.tsx");
let paneHost: PaneHostModule | null = null;
const loadPaneHost = () => import("../panes/PaneHost.tsx").then((m) => (paneHost = m));

/** The path with its dynamic segments blanked: which page, not which chat or record. */
function routeOf(pathname: string, params: Readonly<Record<string, string | undefined>>): string {
  const values = new Set(Object.values(params).filter((value): value is string => !!value));
  return pathname
    .split("/")
    .map((segment) => (values.has(decodeURIComponent(segment)) ? "*" : segment))
    .join("/");
}

/** The frame: a near-black shell, the sidebar, and the inset panel (8px top, right and bottom). A phone has the panel edge
 * to edge and the sidebar as a drawer over it (Sidebar.tsx). */
export function AppShell() {
  // The split view (`w/:workspaceId`) mounts on the first chat opened, then stays rendered, hidden, while the Chief or
  // another page shows: coming back to a chat only shows it again.
  const onPanes = useMatch(PANES_PATH) !== null;
  const onChat = useMatch("/w/:workspaceId") !== null || onPanes;
  const onSettings = useMatch("/settings/*") !== null;
  const [chatsOpened, setChatsOpened] = useState(onChat);
  if (onChat && !chatsOpened) setChatsOpened(true);
  // A chat is what the person opens next: its code loads while the app is idle, not on the click. Held as a module, not
  // React.lazy: a Suspense boundary would hold the first chat back by React's reveal throttle (~300 ms).
  const [host, setHost] = useState<PaneHostModule | null>(paneHost);
  useEffect(() => {
    if (host) return;
    if (chatsOpened) return void loadPaneHost().then(setHost);
    const load = () => void loadPaneHost().then(setHost);
    const id = typeof requestIdleCallback === "function" ? requestIdleCallback(load, { timeout: 3000 }) : setTimeout(load, 200);
    return () => (typeof cancelIdleCallback === "function" ? cancelIdleCallback(id as number) : clearTimeout(id as ReturnType<typeof setTimeout>));
  }, [host, chatsOpened]);
  const location = useLocation();
  const navigate = useNavigate();
  // A call showing work: this screen goes there, whichever device holds the call (a phone on a walk shows it on the
  // Mac), and a strip says what it is. A phone-sized screen keeps the call's stage instead.
  const call = useCall();
  const showing = call.call?.showing ?? call.elsewhere?.showing;
  const small = usePhone();
  // A phone has the sidebar as a drawer, never tucked away beside the page.
  const sidebarHidden = useSidebarLayout().hidden && !small;
  const shownKey = showingKey(showing);
  const chiefs = useChiefs();
  const onCall = callChief(chiefs.chiefs, (call.call ?? call.elsewhere)?.chief_id);
  const onChief = useMatch(onCall.path) !== null;
  useEffect(() => {
    if (!showing || small) return;
    const target = showingTarget(showing);
    navigate(target.path);
    if (target.surface) openSurface(target.surface.workspaceId, target.surface.kind, target.surface.params);
    // Only a new thing to show opens it; the person may move around meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, small]);
  // ⌘B (Settings > Keyboard): the sidebar tucks away and comes back, from anywhere in the shell, a text field included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isComposing(e) || !matchesChord(e, chord("app.toggleSidebar"))) return;
      e.preventDefault();
      toggleSidebarKeepingFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The tabs: their keys from anywhere (Settings too), and the route on screen is the tab in front's. A window that
  // opened on no route (a launch) comes back on that tab as it was. Going somewhere is a step in the tab's own Back;
  // a redirect, a pane's focus, a tab switch, Back itself and the browser's own buttons only rename the step it is on.
  useTabKeys();
  useHistoryKeys(onSettings);
  const pushed = useNavigationType() === NavigationType.Push;
  const here = location.pathname + location.search;
  const launched = useRef(false);
  useLayoutEffect(() => {
    if (!launched.current) {
      launched.current = true;
      const back = windowTabs.launchPath();
      if (back && back !== here) return void navigate(back, { replace: true });
    }
    windowTabs.follow(here, pushed ? "push" : "replace");
  }, [here]);
  // Motion (STYLE.md §8). Opening the app — and coming back from Settings, which hides the shell — fades the sidebar and
  // the frame in, no travel; what the panel shows at once skips its own entrance. Played from script: the
  // sidebar swaps between rail and panel on ⌘B, and a class would replay on every toggle.
  const shellRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  useLayoutEffect(() => {
    const sidebar = shellRef.current?.querySelector("[data-sidebar]");
    if (sidebar) enter(sidebar, "shell");
    if (frameRef.current) enter(frameRef.current, "frame");
    opened.current = true;
    return panelRef.current ? settleEntrances(panelRef.current) : undefined;
  }, []);
  // A new page fades in the panel, 150ms, no travel. A chat is the exception: the chat view stays mounted (Activity),
  // so going back to one only shows it again, still, and a chat's first show plays nothing either (PaneFrame).
  // Another tab coming to the front is a switch, not a new page: it shows at once, like a browser's.
  const route = routeOf(location.pathname, useParams());
  const routeRef = useRef(route);
  const tabRef = useRef(windowTabs.get().active);
  useLayoutEffect(() => {
    const previous = routeRef.current;
    routeRef.current = route;
    const switched = tabRef.current !== windowTabs.get().active;
    tabRef.current = windowTabs.get().active;
    const panel = panelRef.current;
    if (opened.current) return void (opened.current = false);
    if (route === previous || !panel || onChat || switched) return;
    const settled = settleEntrances(panel);
    for (const child of panel.children) enter(child, "view", "route");
    return settled;
  }, [route]);
  // A browser window with no place to run a chat (Cloud off for the organization, no Mac on line) says so, and what
  // to do, over whatever page is open: never a list of machines that cannot be used.
  const web = useWebWindow();
  const noPlace = web?.places.lines ?? [];
  // With no computer behind it at all, a page the person's Mac answers (the Chief, Plugins, Automations) says where
  // it is and the next step instead of asking a runtime that is not there (shell/NeedsMac.tsx).
  const unconfigured = useRuntimeSelector((v) => v.status) === "unconfigured";
  const macPage = web !== null && unconfigured ? macPageOf(location.pathname) : null;
  const outlet = macPage ? <NeedsMac page={macPage} /> : <Outlet />;
  return (
    <>
    <Activity mode={onSettings ? "hidden" : "visible"}>
    <div ref={shellRef} className="window-shell dashboard-scope flex h-full bg-sidebar text-foreground max-md:bg-background">
      <Sidebar />
      <main ref={frameRef} className={cn("panel-frame relative flex min-w-0 flex-1 flex-col pb-2 pr-2 max-md:p-0", IS_DESKTOP || sidebarHidden ? "pt-10" : "pt-2", sidebarHidden && "pl-2")}>
        {/* The band above the panel drags the window; in the desktop app the tabs sit in it. In a browser it is there
            only while the sidebar is tucked away, to hold the way back. */}
        {IS_DESKTOP ? (
          <TabStrip />
        ) : sidebarHidden ? (
          <div className="absolute left-2 top-0 flex h-10 items-center">
            <SidebarToggle hidden />
          </div>
        ) : null}
        {/* A page is one inset card. The split view draws a card per pane instead (PaneHost), with the shell showing in
            the gaps between them. */}
        <div ref={panelRef} data-focus-area="page" className={cn("flex min-h-0 flex-1 flex-col", onChat ? "" : "panel-card overflow-hidden")}>
          {noPlace.length > 0 ? <NoPlace lines={noPlace} /> : null}
          {/* Once someone is settled, one quiet line offers sync for the web and the phone; never in a browser window. */}
          {CLOUD_HOSTED ? null : <SyncOffer />}
          {/* A chat started in Cloud from this window: one line while its place wakes, then it starts there and opens. */}
          {web ? <CloudWaitLine /> : null}
          {showing && !small ? <NowShowing showing={showing} caption={call.caption?.who === "chief" ? call.caption.text : null} onCall={onChief ? null : () => navigate(onCall.path)} /> : null}
          {chatsOpened && host ? (
            <Activity mode={onChat ? "visible" : "hidden"}>
              <host.PaneHost />
            </Activity>
          ) : null}
          {onSettings ? null : outlet}
        </div>
      </main>
      {/* The Chief ringing back, on any page. */}
      <IncomingCall />
      {CLOUD_HOSTED ? <PendingCloudStart /> : null}
      {/* A chat started in Cloud whose computer did not run its start from Cloud's queue: run as starts ran before it. */}
      <QueuedStarts />
      {/* Driving a Mac through Caveman Cloud: the line while it has not allowed this device; on the Mac, its question,
          and the one that comes before it: whether this Mac's chats sync at all. */}
      {CLOUD_HOSTED ? (
        <DeviceWaiting />
      ) : (
        <>
          <DeviceRequestPrompt />
          {/* Never with Settings open: the shell is put away then, and Settings is the one page the first run lets
              through (routes/FirstRun.tsx), so the question cannot come up before the first run is over. */}
          {onSettings ? null : <SyncPrompt />}
        </>
      )}
    </div>
    </Activity>
    {onSettings ? outlet : null}
    {/* The notch at the top of the screen (a Mac's desktop app): outside the Activity, so it keeps showing with Settings open. */}
    <NotchFeed />
    </>
  );
}

/** Why nothing can run from this window, one sentence each, and what to do (state/sync/web-window.ts chatPlaces). */
export function NoPlace({ lines }: { lines: ReadonlyArray<string> }) {
  return (
    <div role="status" className="flex shrink-0 flex-wrap gap-x-1.5 border-b border-border px-4 py-2 text-[13px] leading-5 text-muted-foreground">
      {lines.map((line, i) => (
        <span key={line} className={i === 0 ? "text-foreground" : undefined}>
          {line}
        </span>
      ))}
    </div>
  );
}
