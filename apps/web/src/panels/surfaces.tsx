// The built-in surface kinds. Each component loads on first use, so a pane
// that never opens a terminal never downloads xterm. Import this module once
// (SidePanel does) before rendering tabs.

import { Icon, Add01Icon, type IconSvgElement, DashboardSquare01Icon, BrowserIcon, SquareTerminalIcon, PlayIcon, Folder01Icon, File01Icon, GitCompareIcon, UserGroupIcon, LaptopIcon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { loadable } from "../lib/loadable.ts";
import { chord } from "../state/keybindings.ts";
import { requestId } from "../state/runtime.tsx";
import { watchAgentBrowser } from "./browser/watch.ts";
import { watchComputer } from "./live/watch.ts";
import { defineSurface, type SurfaceProps } from "./registry.ts";
import { updateTab } from "./store.ts";
import "../routes/review/surface.tsx";
import { baseName } from "../lib/paths.ts";

// One lazy component for the tree and every file: one chunk. Each tab mounts its own instance, so tree state lives per workspace, not in the component.
const FileSurface = loadable(() => import("./files/FileSurface.tsx"));

// Hugeicons, the same glyphs the pane's cards and the transcript use for these concepts (packages/ui STYLE.md section 7).
const glyph = (icon: IconSvgElement) =>
  function SurfaceIcon({ className }: { className?: string }) {
    return <Icon icon={icon} className={cn("size-4", className)} />;
  };

const host = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
};

// The pane's cards come from the split-view lane (apps/web/src/components/pane/cards).
// Until that module exists, the Overview kind isn't offered.
const paneCards = import.meta.glob<{ PaneCards: React.ComponentType<{ workspaceId: string; active: boolean; agent?: string | undefined; onAgentShown?: () => void }> }>("../components/pane/cards/index.tsx");
const loadPaneCards = Object.values(paneCards)[0];
if (loadPaneCards) {
  const PaneCards = loadable(() => loadPaneCards().then((m) => ({ default: m.PaneCards })));
  defineSurface({
    kind: "overview",
    label: "Overview",
    description: "Environment, changes and agents at work",
    icon: glyph(DashboardSquare01Icon),
    identity: "one",
    title: () => "Overview",
    // A column of cards: it needs a third of the pane, not the half a file or a page does.
    defaultWidth: "clamp(280px, 30%, 380px)",
    component: ({ workspaceId, active, tab }: SurfaceProps<"overview">) => (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneCards workspaceId={workspaceId} active={active} agent={tab.params.agent} onAgentShown={() => updateTab(workspaceId, tab.id, { params: { agent: undefined } })} />
      </div>
    ),
  });
}

defineSurface({
  kind: "browser",
  label: "Browser",
  description: "Preview a page or watch the agent's browser",
  icon: glyph(BrowserIcon),
  get chord() {
    return chord("app.browser");
  },
  // The runtime has one agent browser per workspace: one tab. Pages the user opens get a tab each.
  identity: (p) => (p.path ? `html:${p.path}` : p.backend === "agent" ? "agent" : crypto.randomUUID().slice(0, 8)),
  title: (tab) => (tab.params.path ? baseName(tab.params.path) : tab.params.url ? host(tab.params.url) : tab.params.backend === "agent" ? "Agent browser" : "Browser"),
  component: loadable(() => import("./browser/BrowserSurface.tsx")),
  keepAlive: true,
  watch: watchAgentBrowser,
});

defineSurface({
  kind: "terminal",
  label: "Terminal",
  description: "Run a command in the workspace",
  icon: glyph(SquareTerminalIcon),
  get chord() {
    return chord("app.terminal");
  },
  // A command (the Run button's) has one tab: pressing Run again (terminal/run.ts) ends the last run and shows the new one in it.
  identity: (p) => (p.command ? `run:${p.command}` : crypto.randomUUID().slice(0, 8)),
  title: (tab) => tab.params.command ?? "Terminal",
  component: loadable(() => import("./terminal/TerminalSurface.tsx")),
  keepAlive: true,
  onClose: ({ client, tab }) => {
    if (client && tab.params.terminalId) void client.call("term.close", { request_id: requestId(), terminal_id: tab.params.terminalId }).catch(() => undefined);
  },
});

defineSurface({
  kind: "actions",
  label: "Actions",
  description: "The project's commands, one click away",
  icon: glyph(PlayIcon),
  identity: "one",
  title: () => "Actions",
  defaultWidth: "clamp(300px, 32%, 420px)",
  component: loadable(() => import("./actions/ActionsSurface.tsx")),
});

defineSurface({
  kind: "files",
  label: "Files",
  description: "Browse and search the workspace",
  icon: glyph(Folder01Icon),
  get chord() {
    return chord("app.openFile");
  },
  identity: "one",
  title: () => "Files",
  component: FileSurface,
});

defineSurface({
  kind: "file",
  label: "File",
  icon: glyph(File01Icon),
  identity: (p) => p.path,
  title: (tab) => baseName(tab.params.path),
  component: FileSurface,
  launcher: false,
});

defineSurface({
  kind: "diff",
  label: "Changes",
  description: "What the agent changed",
  icon: glyph(GitCompareIcon),
  get chord() {
    return chord("app.changes");
  },
  identity: "one",
  title: () => "Changes",
  component: loadable(() => import("./diff/DiffSurface.tsx")),
});

defineSurface({
  kind: "agents",
  label: "Agents",
  description: "Agents at work",
  icon: glyph(UserGroupIcon),
  identity: "one",
  title: () => "Agents",
  component: loadable(() => import("./agents/AgentsSurface.tsx")),
});

defineSurface({
  kind: "computer",
  label: "Computer",
  description: "Watch or take over the agent's screen",
  icon: glyph(LaptopIcon),
  identity: "one",
  title: () => "Computer",
  component: loadable(() => import("./live/ComputerSurface.tsx")),
  keepAlive: true,
  watch: watchComputer,
});

defineSurface({
  kind: "new",
  label: "New tab",
  icon: ({ className }: { className?: string }) => <Icon icon={Add01Icon} className={className} />,
  get chord() {
    return chord("app.openFile");
  },
  title: () => "New tab",
  component: loadable(() => import("./NewTabSurface.tsx")),
  launcher: false,
});
