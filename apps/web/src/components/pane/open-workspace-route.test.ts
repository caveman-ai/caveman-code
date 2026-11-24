import { alerts, buttons, click, container, settle } from "../../lib/dom.test-support.ts";
import type { Workspace } from "@caveman-app/session-protocol";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { expect, test, vi } from "vitest";
import type { RuntimeContextValue } from "../../state/runtime.tsx";

const chat = (id: string, parent: string | null = null) =>
  ({
    id,
    session_id: `s_${id}`,
    title: `Chat ${id}`,
    status: "idle",
    engine: "caveman",
    repo: { path: "/Users/me/acme/app" },
    base_ref: "main",
    branch: "main",
    created_at: "2026-11-06T10:00:00Z",
    updated_at: "2026-11-06T10:00:00Z",
    parent_workspace_id: parent,
    computer: { id: "mac", kind: "this_mac", label: "This Mac", status: "online" },
  }) as Workspace;

// Each test loads the whole pane stack afresh (a new window): more than the default 5 s on a cold transform.
const LOADS = 60_000;

const Lead = chat("lead");
const Other = chat("other");
const Child = chat("child", "lead");
const Fork = chat("fork");

/**
 * The window on Lead's chat, with AppShell's route-follow around the real PaneHost. Lead's engine delegated an agent
 * whose chat is Child, then its turn ended: Lead's transcript has the agent's row, and the turn to fork from.
 */
async function mountWindow({
  refresh = async () => undefined,
}: { refresh?: () => Promise<void> } = {}) {
  // A new window: the stores load again, on nothing saved.
  vi.resetModules();
  localStorage.clear();
  window.name = "";
  location.hash = "#/w/lead";
  const { TooltipProvider } = await import("@caveman-app/ui/components/tooltip");
  const { PaneHost } = await import("../../panes/PaneHost.tsx");
  const { panes, windowTabs } = await import("../../panes/store.ts");
  const { RuntimeFixture } = await import("../../state/runtime.tsx");
  const leadEvents = [
    {
      session_id: Lead.session_id,
      cursor: 1,
      at: "2026-11-06T10:01:00Z",
      item_id: "sub1",
      type: "subagent.started",
      payload: { title: "Review the auth module", workspace_id: Child.id },
    },
    {
      session_id: Lead.session_id,
      cursor: 2,
      at: "2026-11-06T10:02:00Z",
      item_id: "sub1",
      type: "subagent.done",
      payload: { status: "completed", summary: "Reviewed." },
    },
    {
      session_id: Lead.session_id,
      cursor: 3,
      at: "2026-11-06T10:03:00Z",
      turn_id: "t1",
      type: "turn.done",
      payload: { status: "completed" },
    },
  ];
  const client = {
    call: (method: string) => {
      if (method === "queue.list") return Promise.resolve({ turns: [] });
      if (method === "session.move.held") return Promise.resolve({ paths: [] });
      if (method === "editor.list") return Promise.resolve({ editors: [] });
      if (method === "secret.list") return Promise.resolve({ repository: "acme/app", secrets: [] });
      if (method === "session.fork") return Promise.resolve({ workspace: Fork });
      return Promise.resolve({});
    },
    on: () => () => undefined,
    subscribe: () => () => undefined,
    attach: async (sessionId: string, _cursor: number, onEvent: (e: unknown) => void) => {
      const events = sessionId === Lead.session_id ? leadEvents : [];
      for (const e of events) onEvent(e);
      return {
        session: { id: sessionId, head: events.length, mode: "default", access: "full" },
        detach: async () => undefined,
        epoch: () => 1,
      };
    },
  };
  const value = {
    status: "connected",
    error: null,
    client,
    identity: {},
    connection: 1,
    workspaces: [Lead, Other, Child].map((w) => ({
      ...w,
      repo: "acme/app",
      repoRef: w.repo,
      projectId: null,
    })),
    raw: new Map([Lead, Other, Child].map((w) => [w.id, w])),
    projects: [],
    engines: [
      {
        id: "caveman",
        label: "Caveman",
        auth: { state: "api_key" },
        capabilities: { fork: true },
        models: [],
      },
    ],
    settings: null,
    refresh,
    markSeen: () => undefined,
    adopt: () => undefined,
  } as unknown as RuntimeContextValue;

  // AppShell.tsx: windowTabs.follow(here) on every route change.
  function Shell() {
    const location = useLocation();
    const here = location.pathname + location.search;
    useLayoutEffect(() => windowTabs.follow(here), [here]);
    return createElement(PaneHost);
  }
  const router = createMemoryRouter([{ path: "/w/:workspaceId", element: createElement(Shell) }], {
    initialEntries: ["/w/lead"],
  });
  const host = container();
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(RuntimeFixture, {
        value,
        children: createElement(TooltipProvider, null, createElement(RouterProvider, { router })),
      }),
    ),
  );
  await settle();
  const route = () => router.state.location.pathname;
  const front = () => windowTabs.get().list.find((t) => t.id === windowTabs.get().active)!;
  const openChild = async () => {
    const row = [...host.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith("Open Review the auth module"),
    );
    expect(row, "the delegated agent's row in Lead's transcript").toBeDefined();
    await click(row);
    await settle();
  };
  const back = async () => {
    await act(async () => void (await w.router.navigate(-1)));
    await settle();
  };
  const w = {
    host,
    router,
    route,
    front,
    openChild,
    back,
    panes,
    windowTabs,
    unmount: () => act(async () => root.unmount()),
  };
  return w;
}

test(
  "opening a delegated agent's chat from a full split gives it a tab, and the route (and a reload) follows it there",
  async () => {
    const w = await mountWindow();
    const { panes, windowTabs } = w;
    const { insert, newPane, paneOf } = await import("../../panes/tree.ts");
    // Other beside Lead: a split with every pane in use, Lead's focused.
    await act(async () => {
      const l = panes.get();
      panes.set(insert(l, l.focused!, "right", newPane(l, "other")));
    });
    await settle();
    await act(async () => panes.focus(paneOf(panes.get(), "lead")!.id));
    await settle();
    expect(w.route()).toBe("/w/lead");

    await w.openChild();

    expect(windowTabs.get().list.map((t) => t.path)).toEqual(["/w/lead", "/w/child"]);
    expect(paneOf(w.front().layout, "child")).not.toBeNull();
    // The sidebar's selection reads the route: it must name the chat on screen.
    expect(w.route()).toBe("/w/child");

    // A reload comes back on the hash it had, and on the tab that was in front.
    await new Promise((r) => setTimeout(r, 0));
    await w.unmount();
    location.hash = `#${w.route()}`;
    vi.resetModules();
    const reloaded = await import("../../panes/store.ts");
    if (reloaded.windowTabs.launchPath() === null) reloaded.windowTabs.follow(w.route());
    const back = reloaded.windowTabs.get();
    expect(back.list.find((t) => t.id === back.active)!.path).toBe("/w/child");
  },
  LOADS,
);

test(
  "opening a delegated agent's chat that another tab shows brings that tab forward, and the route with it",
  async () => {
    const w = await mountWindow();
    const { windowTabs } = w;
    const lead = windowTabs.get().active;
    // Child in a tab of its own (⌘-click), then back to Lead's tab.
    await act(async () => void w.router.navigate(windowTabs.openChat("child"), { replace: true }));
    await settle();
    await act(async () => void w.router.navigate(windowTabs.activate(lead)!, { replace: true }));
    await settle();
    expect(w.route()).toBe("/w/lead");

    await w.openChild();

    expect(w.front().path).toBe("/w/child");
    expect(w.route()).toBe("/w/child");
    await w.unmount();
  },
  LOADS,
);

test(
  "a delegated agent's chat that cannot open says why in the lead's pane, and its click is no crash",
  async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // The runtime answers the refresh before the chat opens with an error (engine.list failing, a timeout, a closed client).
      const w = await mountWindow({
        refresh: () => Promise.reject(new Error("engine.list timed out")),
      });

      await w.openChild();
      await settle();

      expect(alerts(w.host)).toContain("engine.list timed out");
      expect(w.route()).toBe("/w/lead");
      // Desktop's reportPageErrors counts an unhandled rejection as a crash.
      expect(unhandled).toEqual([]);
      await w.unmount();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  },
  LOADS,
);

test(
  "a builder's lead link that brings the lead's tab forward leaves Back inside that tab",
  async () => {
    const w = await mountWindow();
    const { windowTabs } = w;
    const leadTab = windowTabs.get().active;
    // Child in a tab of its own (⌘-click on its row), Lead's chat in the first tab.
    await act(async () => void w.router.navigate(windowTabs.openChat("child"), { replace: true }));
    await settle();
    expect(w.route()).toBe("/w/child");

    await click(w.host.querySelector("button[title='Started by Chat lead']"));
    await settle();
    expect(w.front().id).toBe(leadTab);
    expect(w.route()).toBe("/w/lead");

    await w.back();
    expect(w.front().id).toBe(leadTab);
    await w.unmount();
  },
  LOADS,
);

test(
  "a fork from a full split gets a tab of its own, and Back stays inside that tab",
  async () => {
    const w = await mountWindow();
    const { panes, windowTabs } = w;
    const { insert, newPane, paneOf } = await import("../../panes/tree.ts");
    await act(async () => {
      const l = panes.get();
      panes.set(insert(l, l.focused!, "right", newPane(l, "other")));
    });
    await settle();
    await act(async () => panes.focus(paneOf(panes.get(), "lead")!.id));
    await settle();

    await click(buttons(w.host, "Chat lead")[0]);
    await click(
      [...document.querySelectorAll("[role='menuitem']")].find(
        (b) => b.textContent?.trim() === "Fork",
      ),
    );
    await settle();
    expect(windowTabs.get().list.map((t) => t.path)).toEqual(["/w/lead", "/w/fork"]);
    expect(w.front().path).toBe("/w/fork");
    expect(w.route()).toBe("/w/fork");

    await w.back();
    expect(w.front().path).toBe("/w/fork");
    await w.unmount();
  },
  LOADS,
);
