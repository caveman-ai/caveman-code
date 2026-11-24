// The app as main.tsx builds it (RuntimeProvider, the syncs, the tooltip provider, the hash router with FirstRunGate
// and AppShell), connected to a scripted runtime instead of a real one. main.tsx itself cannot be imported here: it
// mounts on import and refuses to run in a frame, which is where Vitest runs tests. So the routes people reach from
// the shell are listed again below, each loading the same route module main.tsx does; keep them in step.
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Navigate, RouterProvider } from "react-router";
import { expect, onTestFinished } from "vitest";
import { AppShell } from "../src/shell/AppShell.tsx";
import { FirstRunGate } from "../src/routes/FirstRun.tsx";
import { AppearanceSync, applyAppearance, cachedAppearance } from "../src/state/appearance.ts";
import { CompanionsSync } from "../src/state/companions.ts";
import { KeybindingsSync } from "../src/state/keybindings.ts";
import { flushDrafts } from "../src/state/composer-drafts.ts";
import { RuntimeProvider, useSyncHub } from "../src/state/runtime.tsx";
import type { SyncHub } from "../src/state/sync/hub.ts";
import "../src/styles.css";
import { RUNTIME_URL, routeRuntimeSocket } from "./fake-socket.ts";
import { runtimeFixture, type RuntimeFixture } from "./fixtures.ts";
import { SessionPeer } from "./session-peer.ts";

/** Keep the mounted hub so teardown can await its final transcript writes after React cleanup. */
function CaptureHub({ keep }: { keep: (hub: SyncHub) => void }) {
  const hub = useSyncHub();
  useEffect(() => {
    if (hub) keep(hub);
  }, [hub, keep]);
  return null;
}

function routes() {
  return [
    {
      element: <FirstRunGate />,
      HydrateFallback: () => null,
      children: [
        {
          element: <AppShell />,
          children: [
            { index: true, element: <Navigate to="/chief" replace /> },
            {
              path: "new",
              lazy: () =>
                import("../src/routes/NewChat.tsx").then((m) => ({ Component: m.NewChatRoute })),
            },
            {
              path: "chief",
              lazy: () =>
                import("../src/routes/Chief.tsx").then((m) => ({ Component: m.ChiefRoute })),
            },
            {
              path: "chief/:chiefId",
              lazy: () =>
                import("../src/routes/Chief.tsx").then((m) => ({ Component: m.ChiefRoute })),
            },
            {
              path: "chief/board",
              lazy: () =>
                import("../src/routes/Board.tsx").then((m) => ({ Component: m.BoardRoute })),
            },
            {
              path: "chief/:chiefId/board",
              lazy: () =>
                import("../src/routes/Board.tsx").then((m) => ({ Component: m.BoardRoute })),
            },
            { path: "w/:workspaceId", Component: () => null },
            { path: "panes", Component: () => null },
            {
              path: "settings/:section",
              lazy: () =>
                import("../src/routes/Settings.tsx").then((m) => ({ Component: m.SettingsRoute })),
            },
            {
              path: "settings",
              lazy: () =>
                import("../src/routes/Settings.tsx").then((m) => ({ Component: m.SettingsRoute })),
            },
          ],
        },
      ],
    },
  ];
}

/** The IndexedDB store the sync hub keeps (calls waiting for an answer, cached chats): emptied so no test inherits one. */
async function clearDeviceStore(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("caveman-sync", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").clear();
      tx.oncomplete = () => (db.close(), resolve());
      tx.onerror = () => (db.close(), reject(tx.error));
    };
  });
}

/**
 * Mounts the whole app at `path` against a scripted runtime made from `fixture`, and returns that runtime. The app
 * unmounts when the test ends, and the test fails if either side broke the protocol on the way.
 */
export async function mountApp(
  path: string,
  fixture: RuntimeFixture = runtimeFixture(),
  /** What the page kept from an earlier visit (where the person left off), by localStorage key. */
  storage: Readonly<Record<string, string>> = {},
  options: { setup?: (peer: SessionPeer) => void; runtimeUrl?: string; keepStorage?: boolean } = {},
): Promise<{ readonly peer: SessionPeer; readonly unmount: () => Promise<void> }> {
  const peer = new SessionPeer(fixture);
  options.setup?.(peer);
  if (!options.keepStorage) localStorage.clear();
  await clearDeviceStore();
  // A returning person: past the first-run welcome, with This Mac's runtime link stored as a `caveman code` link leaves it.
  localStorage.setItem("caveman.firstRunDone", "1");
  localStorage.setItem(
    "caveman.runtime",
    JSON.stringify({ url: options.runtimeUrl ?? RUNTIME_URL, token: "browser-test" }),
  );
  for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  const unroute = routeRuntimeSocket(peer);
  applyAppearance(cachedAppearance());
  window.location.hash = `#${path}`;
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const hubs = new Set<SyncHub>();
  const keepHub = (hub: SyncHub) => {
    hubs.add(hub);
  };
  const root = createRoot(container);
  const router = createHashRouter(routes());
  root.render(
    <StrictMode>
      <RuntimeProvider>
        <CaptureHub keep={keepHub} />
        <AppearanceSync />
        <KeybindingsSync />
        <CompanionsSync />
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </RuntimeProvider>
    </StrictMode>,
  );
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
    await Promise.all([...hubs].map((hub) => hub.stop()));
    router.dispose();
    container.remove();
    for (const socket of [...peer.sockets]) socket.close();
    unroute();
  };
  onTestFinished(async () => {
    await unmount();
    // What the app keeps for the page's life outlives this mount: a send still out when the client closed comes back
    // into its box's draft (composer-drafts.ts) a task later. Written out and wiped, so the next test starts empty.
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushDrafts();
    localStorage.clear();
    expect(
      peer.violations,
      "Session Protocol broken between the app and the scripted runtime",
    ).toEqual([]);
  });
  return { peer, unmount };
}
