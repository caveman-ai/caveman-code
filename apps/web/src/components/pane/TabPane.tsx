// A side-panel tab in a pane of its own (panes/tree.ts Pane.tab): a terminal below its chat, a pull request beside
// it, a browser filling a tab. A bar like a chat's header (the tab's name drags the pane; back to its panel; close),
// and the tab's surface under it, talking to the tab's own workspace. The tab stays its panel's: closing it here
// ends it as closing it there does, and putting it back only moves it.

import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Cancel01Icon, PanelRightIcon } from "@caveman-app/ui/icons/huge";
import { memo, useEffect, useRef, type ReactNode } from "react";
import { BarButton, SurfaceEmpty } from "../../panels/chrome.tsx";
import { useSurfaceDef, tabTitle } from "../../panels/registry.ts";
import { tabPayload, useCloseTabs } from "../../panels/SidePanel.tsx";
import { useTab } from "../../panels/store.ts";
import { SurfaceHost } from "../../panels/SurfaceHost.tsx";
import { beginDrag } from "../../panes/drag.ts";
import { ownsFocus } from "../../panes/focus.ts";
import { announce, panes } from "../../panes/store.ts";
import type { Pane, TabRef } from "../../panes/tree.ts";
import { useTabNav } from "../../shell/tab-nav.ts";
import { SidebarMenuButton } from "../../shell/SidebarToggle.tsx";
import { useChiefs } from "../../state/chiefs.ts";
import { chatClientFor, ChatClientScope, useChatList, useRuntimeClient, useRuntimeSelector, useSyncHub } from "../../state/runtime.tsx";
import { chatElsewhere } from "../../state/sync/chats-view.ts";

export const TabPane = memo(function TabPane({ pane, tab: ref, focused }: { pane: Pane; tab: TabRef; focused: boolean }) {
  const tab = useTab(ref.workspaceId, ref.id);
  const go = useTabNav();
  // Closed from somewhere else (its chat's panel, an agent): its pane goes too.
  useEffect(() => {
    if (tab) return;
    go(panes.close(pane.id));
    announce("The tab in this pane closed; so did the pane.");
  }, [tab === null]);

  // The tab's surfaces talk to its chat's own computer, found as the chat's pane finds it (PaneFrame): this runtime's
  // record, or Cloud's list for a chat on another computer, then through the hub.
  const local = useRuntimeSelector((v) => v.raw.get(ref.workspaceId));
  const hub = useSyncHub();
  const list = useChatList(hub);
  const workspace = chatElsewhere(list, hub?.homeRuntimeId() ?? null, ref.workspaceId, local) ?? local;
  const remote = hub && workspace && hub.throughHub(workspace.session_id) ? chatClientFor(hub, workspace.session_id) : null;
  // Its surfaces wait, as the chat's pane does, until it is known where the chat runs: else they would talk to this
  // window's runtime about a chat on another computer. A Chief is never in the chat list; one of this window's Chiefs
  // runs here. With no Chiefs listed (a runtime from before chief.list, a Cloud computer the tab fell back to), no tab
  // passes as a Chief's.
  const { client } = useRuntimeClient();
  const chiefs = useChiefs();
  const known = workspace !== undefined || chiefs.chiefs.some((c) => c.id === ref.workspaceId);
  // Chiefs stay "loading" with no runtime to ask, so only a connected window waits on them.
  const finding = (hub !== null && !list) || (client !== null && chiefs.status === "loading");
  const notice = known ? null : finding ? "Finding where this chat runs…" : client || list ? "This chat is not on any of your computers." : "Not connected to a runtime.";
  if (!tab) return null;
  const body = (
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
      <TabPaneView pane={pane} tab={ref} focused={focused} owner={workspace?.title ?? null} notice={notice} />
    </TooltipProvider>
  );
  return remote ? <ChatClientScope client={remote}>{body}</ChatClientScope> : body;
});

function TabPaneView({ pane, tab: ref, focused, owner, notice }: { pane: Pane; tab: TabRef; focused: boolean; owner: string | null; notice: string | null }) {
  const tab = useTab(ref.workspaceId, ref.id)!;
  const def = useSurfaceDef(tab.kind);
  const go = useTabNav();
  const root = useRef<HTMLDivElement>(null);
  const close = useCloseTabs(ref.workspaceId, false);
  // What closing means here: the tab ends (a terminal's process with it), and its pane closes after it.
  const closeTab = () => close((t) => t.id === ref.id);
  const closeRef = useRef(closeTab);
  closeRef.current = closeTab;
  const back = () => {
    go(panes.dock(pane.id));
    announce(`${tabTitle(tab)} is back in ${owner ? `${owner}'s` : "its"} side panel.`);
  };

  // ⌘W in this pane closes its tab, as it does in a side panel.
  useEffect(
    () =>
      window.cavemanDesktop?.onCloseRequest?.(() => {
        if (!ownsFocus(root.current)) return false;
        closeRef.current();
        return true;
      }),
    [],
  );

  const SurfaceIcon = def?.icon;
  const Bar = def?.bar;
  const title = tabTitle(tab);
  return (
    // data-pane: shortcuts and measurements scope to it, as they do to a chat's pane.
    <div ref={root} data-pane="" data-tab-pane={tab.kind} className="relative flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-0.5 pl-2 pr-1.5">
        <SidebarMenuButton className="ml-0" />
        {/* The pane's name is its drag handle; the buttons beside it are its keyboard way back and out. */}
        <div
          data-tab-handle=""
          title={owner ? `${title} · ${owner}. Drag to move this pane.` : `${title}. Drag to move this pane.`}
          onPointerDown={(e) => beginDrag(e, tabPayload(ref.workspaceId, tab, pane.id, owner ?? ""))}
          className="flex h-8 min-w-0 max-w-[70%] shrink cursor-grab items-center gap-1.5 rounded-md px-2 hover:bg-accent active:cursor-grabbing"
        >
          {SurfaceIcon ? <SurfaceIcon className="size-4 shrink-0 text-muted-foreground" /> : null}
          <span className={cn("min-w-0 truncate text-[14px] font-medium transition-colors duration-75", focused ? "text-foreground" : "text-muted-foreground")}>{title}</span>
          {owner ? <span className="min-w-0 shrink-[2] truncate text-[12px] text-muted-foreground">{owner}</span> : null}
        </div>
        <span className="min-w-2 flex-1" />
        {Bar ? <BarSlot>{<Bar workspaceId={ref.workspaceId} tab={tab as never} active />}</BarSlot> : null}
        <BarButton label="Back to the side panel" onClick={back}>
          <Icon icon={PanelRightIcon} />
        </BarButton>
        <BarButton label={`Close ${title}`} onClick={closeTab}>
          <Icon icon={Cancel01Icon} />
        </BarButton>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col border-t border-border">
        {notice ? <SurfaceEmpty title={tabTitle(tab)}>{notice}</SurfaceEmpty> : <SurfaceHost workspaceId={ref.workspaceId} tab={tab} active />}
      </div>
    </div>
  );
}

function BarSlot({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-0.5 pr-1">{children}</div>;
}
