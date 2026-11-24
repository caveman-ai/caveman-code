// The chat header's way to the agent's browser or computer while the agent
// uses it and it isn't in view (not floating, not the side panel's tab): the
// screen's glyph with the blue live dot. A click opens it in the side panel,
// where you can watch or take over. Gone when the agent stops using it.

import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { BarButton } from "../chrome.tsx";
import { surfaceDef } from "../registry.ts";
import { openSurface, usePanel } from "../store.ts";
import { panelShows, useFloatingScreen, useInUse } from "./float.ts";
import { LiveDot } from "./LiveDot.tsx";

export function InUseButton({ workspaceId }: { workspaceId: string }) {
  const browsing = useInUse(workspaceId, "browser");
  const onComputer = useInUse(workspaceId, "computer");
  const floating = useFloatingScreen(workspaceId);
  const panel = usePanel(workspaceId);
  const screen = (["browser", "computer"] as const).find((s) => (s === "browser" ? browsing : onComputer) && floating !== s && !panelShows(panel, s));
  const Glyph = screen ? surfaceDef(screen)?.icon : undefined;
  if (!screen || !Glyph) return null;
  return (
    <TooltipProvider delayDuration={500}>
      <BarButton
        label={screen === "browser" ? "The agent is browsing: open its browser" : "The agent is on its computer: open the screen"}
        className="relative text-foreground animate-in fade-in-0 duration-200 ease-snap motion-reduce:animate-none"
        onClick={() => (screen === "browser" ? openSurface(workspaceId, "browser", { backend: "agent" }) : openSurface(workspaceId, "computer", {}))}
      >
        <Glyph className="size-4" />
        <LiveDot className="absolute right-1 top-1" />
      </BarButton>
    </TooltipProvider>
  );
}
