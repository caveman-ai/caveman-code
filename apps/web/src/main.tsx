import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Navigate } from "react-router";
// The DOM one: a navigation that asks for flushSync (a chat New chat just started) commits in one frame.
import { RouterProvider } from "react-router/dom";
import { AppShell } from "./shell/AppShell.tsx";
import { FirstRunGate } from "./routes/FirstRun.tsx";
import { AppearanceSync, applyAppearance, cachedAppearance } from "./state/appearance.ts";
import { CompanionsSync } from "./state/companions.ts";
import { KeybindingsSync } from "./state/keybindings.ts";
import { reportPageErrors } from "./state/desktop.ts";
import { reportCaughtError, startCrashReports } from "./state/crashReports.ts";
import { CLOUD_HOSTED, RuntimeProvider } from "./state/runtime.tsx";
import { ReportProblemHost } from "./shell/ReportProblem.tsx";
import { AppErrorBoundary, RouteError } from "./shell/RouteError.tsx";
import { IS_MAC } from "./lib/platform.ts";
import { windowTabs } from "./panes/store.ts";
import { installConfirmationKeys } from "./shell/confirmation-keys.ts";
import "./styles.css";

// html[data-desktop]: the macOS desktop window is translucent behind the shell (styles.css); Windows' is solid.
if (window.cavemanDesktop && IS_MAC) document.documentElement.dataset.desktop = "";
// html[data-wco]: Windows draws the window's caption buttons over the title band (styles.css), except in full screen.
const captionButtons = (navigator as Navigator & { windowControlsOverlay?: EventTarget & { readonly visible: boolean } }).windowControlsOverlay;
if (window.cavemanDesktop && captionButtons) {
  const follow = () => document.documentElement.toggleAttribute("data-wco", captionButtons.visible);
  follow();
  captionButtons.addEventListener("geometrychange", follow);
}
// Paint in this device's last theme and sizes before the runtime answers.
applyAppearance(cachedAppearance());

// Hash routing: the desktop shell serves this build from disk. Each screen
// loads on first visit, so the shell paints without the transcript, composer,
// settings and Chief code.
const router = createHashRouter([
  // The living style page loads on demand: it carries demo data the app never needs.
  { path: "style", lazy: () => import("./routes/StyleGuide.tsx").then((m) => ({ Component: m.StyleGuideRoute })) },
  {
    element: <FirstRunGate />,
    // A screen that threw while drawing: say so, with Reload and the report button, instead of a blank window.
    errorElement: <RouteError />,
    // The first screen's code is still loading (a few ms from disk): paint nothing rather than a flash.
    HydrateFallback: () => null,
    children: [
      // A call on its own for a phone: the name and one button, no shell (routes/Call.tsx).
      { path: "call", lazy: () => import("./routes/Call.tsx").then((m) => ({ Component: m.CallRoute })) },
      {
        element: <AppShell />,
        children: [
          // A launch comes back on the tab in front (AppShell); the Chief is home otherwise. The Inbox folded into its board.
          // A browser window Caveman Cloud serves opens on New chat: the Chief lives on a Mac, and a first visit has no chat.
          { index: true, element: <Navigate to={windowTabs.launchPath() ?? (CLOUD_HOSTED ? "/new" : "/chief")} replace /> },
          { path: "new", lazy: () => import("./routes/NewChat.tsx").then((m) => ({ Component: m.NewChatRoute })) },
          { path: "cloud/start", lazy: () => import("./routes/CloudStart.tsx").then((m) => ({ Component: m.CloudStartRoute })) },
          { path: "chief", lazy: () => import("./routes/Chief.tsx").then((m) => ({ Component: m.ChiefRoute })) },
          // Another of your Chiefs (chief.list): its id is its workspace's.
          { path: "chief/:chiefId", lazy: () => import("./routes/Chief.tsx").then((m) => ({ Component: m.ChiefRoute })) },
          { path: "chief/board", lazy: () => import("./routes/Board.tsx").then((m) => ({ Component: m.BoardRoute })) },
          { path: "chief/:chiefId/board", lazy: () => import("./routes/Board.tsx").then((m) => ({ Component: m.BoardRoute })) },
          { path: "inbox", element: <Navigate to="/chief" replace /> },
          { path: "runs", element: <Navigate to="/chief" replace /> },
          // Help > What's New: the Chief, with What's new open over it (whats-new/WhatsNew.tsx).
          { path: "whats-new", element: <Navigate to="/chief" replace state={{ whatsNew: true }} /> },
          // Help > Show the Tour: the Chief, with the tour over it (shell/Tour.tsx).
          { path: "tour", lazy: () => import("./shell/Tour.tsx").then((m) => ({ Component: m.TourRoute })) },
          // One list with a switch per thing; a row opens its page (routes/Plugins.tsx).
          {
            path: "plugins",
            lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.PluginsLayout })),
            children: [
              { index: true, lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.IndexRoute })) },
              { path: "agent/:agent", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.AgentRoute })) },
              { path: "mcp/:name", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.ServerRoute })) },
              { path: "skill", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.SkillRoute })) },
              { path: "rule", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.RuleRoute })) },
              { path: "p/:id", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.PluginRoute })) },
              { path: "browse/:source?", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.BrowseRoute })) },
              // The tabs this page had (/plugins/caveman, /plugins/mcp, …), /plugins/from/<marketplace>, /plugins/manage/<tab>.
              { path: "from/:marketplace", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.OldTabRoute })) },
              { path: "manage/:tab?", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.OldTabRoute })) },
              { path: ":tab", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.OldTabRoute })) },
            ],
          },
          // Memory shows in the chat when it acts; its notes list lives in Settings › Memory.
          { path: "memory", element: <Navigate to="/settings/memory" replace /> },
          // The list stays on the left while the right side changes (routes/Automations.tsx).
          {
            path: "automations",
            lazy: () => import("./routes/Automations.tsx").then((m) => ({ Component: m.AutomationsLayout })),
            children: [
              { index: true, lazy: () => import("./routes/Automations.tsx").then((m) => ({ Component: m.IndexRoute })) },
              // New automation floats over the page; the templates are its Use template.
              { path: "new", element: <Navigate to="/automations?new=1" replace /> },
              { path: "templates", element: <Navigate to="/automations?new=template" replace /> },
              { path: ":id", lazy: () => import("./routes/Automations.tsx").then((m) => ({ Component: m.AutomationRoute })) },
              { path: ":id/runs/:runId", lazy: () => import("./routes/Automations.tsx").then((m) => ({ Component: m.AutomationRoute })) },
              { path: ":id/settings", lazy: () => import("./routes/Automations.tsx").then((m) => ({ Component: m.SettingsRoute })) },
            ],
          },
          { path: "automations/agents/:projectId?/:name?", lazy: () => import("./routes/Automations.tsx").then((m) => ({ Component: m.AgentsRoute })) },
          { path: "review", lazy: () => import("./routes/Review.tsx").then((m) => ({ Component: m.ReviewRoute })) },
          { path: "review/:projectId/:number", lazy: () => import("./routes/Review.tsx").then((m) => ({ Component: m.PrRoute })) },
          // Customize and Spaces became Plugins.
          { path: "customize/:tab?", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.OldTabRedirect })) },
          { path: "spaces/:tab?", lazy: () => import("./routes/Plugins.tsx").then((m) => ({ Component: m.OldTabRedirect })) },
          // The split view itself lives in the shell (AppShell), kept rendered while other pages show.
          { path: "w/:workspaceId", Component: () => null },
          // The split view with no chat in it: side-panel tabs in panes of their own (panes/store.ts PANES_PATH).
          { path: "panes", Component: () => null },
          // Settings takes the whole window; the shell stays rendered behind it, hidden (AppShell).
          { path: "settings/:section", lazy: () => import("./routes/Settings.tsx").then((m) => ({ Component: m.SettingsRoute })) },
          // General on a wide window; on a phone, the list of sections (routes/Settings.tsx).
          { path: "settings", lazy: () => import("./routes/Settings.tsx").then((m) => ({ Component: m.SettingsRoute })) },
        ],
      },
    ],
  },
]);

// Never run inside a frame: a page in the side panel's browser could navigate
// its frame to the app's origin and then reach `parent` as the app.
if (window.top !== window.self) throw new Error("Caveman Code does not run inside a frame.");

// Desktop app: uncaught page errors count as crashes, by error name only; where the desktop sends crash reports they
// go as reports too, with their stack (state/crashReports.ts).
reportPageErrors();
startCrashReports();

// Before any screen adds its own key listeners: inside a confirmation the app's shortcuts wait.
installConfirmationKeys();

createRoot(document.getElementById("root")!, {
  // A screen whose error boundary caught it: logged as React does by default, and reported where crash reports are on.
  onCaughtError: (error, info) => {
    console.error(error);
    reportCaughtError(error, info.componentStack);
  },
}).render(
  <StrictMode>
    {/* What throws above the router (the runtime provider, what it works out from Cloud's list) says so, never a blank window. */}
    <AppErrorBoundary>
      <RuntimeProvider>
        <AppearanceSync />
        <KeybindingsSync />
        <CompanionsSync />
        {/* One tooltip provider for the app (the pick labels and every other Radix tooltip); panels may still nest their own delays. */}
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          {/* "Report a problem" over every screen, onboarding and the connect screen included (shell/ReportProblem.tsx). */}
          <ReportProblemHost />
        </TooltipProvider>
      </RuntimeProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
