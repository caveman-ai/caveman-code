// The agent's browser or computer, live in a corner of the chat while it works
// (float.ts says which). It only watches: a click opens the screen in the side
// panel, where you can take over. Modelled on upstream floating preview
// (apps/web/src/components/preview/ThreadPreviewMiniPlayer.tsx @ 13aa882c22),
// without its drag and resize.

import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Cancel01Icon, PanelRightIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useMemo } from "react";
import { useRuntimeClient } from "../../state/runtime.tsx";
import { BarButton } from "../chrome.tsx";
import { openSurface, usePanel } from "../store.ts";
import { closeFloatingScreen, panelShows, useFloatingScreen, type Screen } from "./float.ts";
import { LiveView, useLive } from "./LiveView.tsx";
import { browserSource, computerSource, pageHost, type BrowserState, type ComputerState, type LiveSource } from "./source.ts";

export function FloatingScreen({ workspaceId, engine }: { workspaceId: string; engine: string }) {
  const screen = useFloatingScreen(workspaceId);
  const panel = usePanel(workspaceId);
  // The side panel showing the screen takes over from the float, for good.
  const shown = screen !== null && panelShows(panel, screen);
  useEffect(() => {
    if (shown) closeFloatingScreen(workspaceId);
  }, [shown, workspaceId]);
  if (screen === null || shown) return null;
  return <Floating key={screen} workspaceId={workspaceId} screen={screen} engine={engine} />;
}

function Floating({ workspaceId, screen, engine }: { workspaceId: string; screen: Screen; engine: string }) {
  const { client, connection } = useRuntimeClient();
  const source = useMemo<LiveSource<BrowserState | ComputerState> | null>(
    () => (client ? (screen === "browser" ? browserSource(client, workspaceId) : computerSource(client, workspaceId)) : null),
    [client, workspaceId, screen],
  );
  const live = useLive(source, true, connection);
  const page = live.state && "url" in live.state ? live.state : null;
  const where = page?.title || (page?.url && page.url !== "about:blank" ? pageHost(page.url) : "");
  const label = screen === "browser" ? "Agent browser" : "Computer";
  const expand = () => {
    closeFloatingScreen(workspaceId);
    openSurface(workspaceId, screen, screen === "browser" ? { backend: "agent" } : {});
  };
  if (!source) return null;

  return (
    <section
      aria-label={`${label}, live`}
      className="absolute right-3 top-[calc(var(--pane-top)+12px)] z-20 w-[min(320px,calc(100%-24px))] overflow-hidden rounded-xl border border-border bg-popover shadow-overlay animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-200 ease-snap motion-reduce:animate-none"
    >
      <div className="flex h-8 items-center gap-1.5 pl-3 pr-1">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", live.controller === "user" ? "bg-target" : live.controller === "agent" ? "bg-success" : "bg-muted-foreground/50")} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          <span className="text-foreground">{label}</span>
          {where ? ` · ${where}` : ""}
        </span>
        <BarButton label="Open in the side panel" size="sm" onClick={expand}>
          <Icon icon={PanelRightIcon} />
        </BarButton>
        <BarButton label="Close" size="sm" onClick={() => closeFloatingScreen(workspaceId)}>
          <Icon icon={Cancel01Icon} />
        </BarButton>
      </div>
      <div className="relative flex aspect-[16/10] border-t border-border">
        <LiveView
          source={source}
          live={live}
          engine={engine}
          align={screen === "browser" ? "top" : "center"}
          handoff={false}
          placeholder={<p className="m-auto text-[12px] text-muted-foreground">{live.status === "error" ? "The screen stopped streaming" : live.status === "unavailable" ? "No picture from this computer" : page?.url === "about:blank" ? "No page open" : "Connecting…"}</p>}
        />
        {/* The whole screen opens the side panel's view, where you can take over. */}
        <button type="button" aria-label={`Open the ${label.toLowerCase()} in the side panel`} onClick={expand} className="absolute inset-0 z-40 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />
      </div>
    </section>
  );
}
