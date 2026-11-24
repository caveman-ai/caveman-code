import { container, settle } from "../../lib/dom.test-support.ts";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { openSurface } from "../../panels/store.ts";
import { expect, test, vi } from "vitest";
import { ChatFeed, type FeedSink, type FeedState } from "../../state/sync/chat-feed.ts";
import type { ChatListSnapshot } from "../../state/sync/chat-list.ts";
import { runtime, summary } from "../../state/sync/fakes.test-support.ts";

// The window's sync hub: Cloud's list of the person's chats, and a client for each chat on another computer.
const at = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock("../../state/runtime.tsx", async (real) => ({
  ...(await real<object>()),
  useSyncHub: () => at.hub,
}));

import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { PaneFrame } from "./PaneFrame.tsx";
// The side panel loads these lazily: loaded here, a surface opened in a test renders within a few settles.
import "../../panels/agents/AgentsSurface.tsx";
import "./cards/index.tsx";

// Radix's Switch (the Overview's remote row) looks for its form: the test page's window has the class, the global scope not.
(globalThis as Record<string, unknown>).HTMLFormElement ??= (
  window as unknown as Record<string, unknown>
).HTMLFormElement;

const HOME = "rt-mac";
// A chat on a Cloud computer that this window's runtime never held: its turn delegated a builder, then ended. The
// builder still works there (the person gave it more to do in its own chat). Cloud's list has both, the builder under
// its lead (parent_session_id).
const Lead = summary("s-lead", { workspace_id: "w-lead", title: "Upgrade to Go 1.26" });
const Builder = summary("s-builder", {
  workspace_id: "w-builder",
  title: "Port the CLI",
  kind: "builder",
  parent_session_id: "s-lead",
  status: "working",
});
const snapshot: ChatListSnapshot = {
  status: "live",
  chats: new Map([Lead, Builder].map((c) => [c.session_id, c])),
  runtimes: new Map([["rt-cloud-1", runtime("rt-cloud-1")]]),
  seq: 2,
  ready: true,
};

const leadEvents = [
  {
    session_id: Lead.session_id,
    cursor: 1,
    at: "2026-11-06T10:01:00Z",
    item_id: "sub1",
    type: "subagent.started",
    payload: { title: "Port the CLI", workspace_id: Builder.workspace_id },
  },
  {
    session_id: Lead.session_id,
    cursor: 2,
    at: "2026-11-06T10:02:00Z",
    item_id: "sub1",
    type: "subagent.done",
    payload: { status: "completed", summary: "Ported." },
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

/** The chat's own computer, through the hub. */
const chatClient = {
  call: (method: string) => {
    if (method === "queue.list") return Promise.resolve({ turns: [] });
    if (method === "editor.list") return Promise.resolve({ editors: [], reveal: false });
    if (method === "session.move.held") return Promise.resolve({ paths: [] });
    if (method === "secret.list") return Promise.resolve({ repository: "acme/app", secrets: [] });
    if (method === "workspace.servers") return Promise.resolve({ servers: [] });
    // What the chat's engine runs on is its own computer's to say (EngineSignIn's useEngineThere).
    if (method === "engine.list") return Promise.resolve({ engines: [] });
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

const feeds = new Map<string, ChatFeed>();
at.hub = {
  // Each chat read from its own computer, as the hub's feed does.
  openFeed: (sessionId: string, sink: FeedSink, onState: (state: FeedState) => void) => {
    const feed = new ChatFeed({ sessionId, sink, onState });
    feed.use({ kind: "runtime", runtimeId: "rt-cloud-1", client: chatClient as never });
    feeds.set(sessionId, feed);
    return feed;
  },
  close: (sessionId: string) => {
    feeds.get(sessionId)?.close();
    feeds.delete(sessionId);
  },
  list: { get: () => snapshot, subscribe: () => () => undefined },
  homeRuntimeId: () => HOME,
  // The pooled connection to the chat's computer never reconnects here.
  connectionFor: () => 0,
  throughHub: (sessionId: string) => snapshot.chats.get(sessionId)?.runtime_id !== HOME,
  clientFor: () => chatClient,
  viaFor: () => "relay",
  wake: async () => undefined,
  // A hidden chat kept attached (state/unseen.ts) counts as not read; nothing to wake here.
  hide: () => undefined,
  show: () => undefined,
  summary: (sessionId: string) => snapshot.chats.get(sessionId),
  subscribe: () => () => undefined,
  queuedCalls: () => [],
  startOf: () => undefined,
  approvalFor: () => null,
};

/** The desktop window on `workspaceId`: its own runtime (This Mac) holds none of these chats. */
async function mountPane(workspaceId: string) {
  const home = {
    ...chatClient,
    attach: async (sessionId: string) => ({
      session: { id: sessionId, head: 0 },
      detach: async () => undefined,
      epoch: () => 1,
    }),
  };
  const value = {
    status: "connected",
    error: null,
    client: home,
    identity: {},
    connection: 1,
    workspaces: [],
    raw: new Map(),
    projects: [],
    engines: [
      { id: "caveman", label: "Caveman", auth: { state: "api_key" }, capabilities: {}, models: [] },
    ],
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
    adopt: () => undefined,
  } as unknown as RuntimeContextValue;
  const host = container();
  const root = createRoot(host);
  const pane = createElement(PaneFrame, {
    pane: { kind: "pane", id: "p1", workspaceId } as never,
    focused: true,
    canSplit: false,
  });
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(MemoryRouter, null, createElement(RuntimeFixture, { value, children: pane })),
      ),
    ),
  );
  await settle();
  /** The element `selector` names, once the pane shows it (the side panel's surfaces load lazily). */
  const shows = async (selector: string) => {
    for (let i = 0; i < 50 && !host.querySelector(selector); i++) await settle();
    return host.querySelector(selector);
  };
  return { host, shows, unmount: () => act(async () => root.unmount()) };
}

test("a chat on a Cloud computer whose builder still works after its turn: the box waits on it, and Stop covers it", async () => {
  const p = await mountPane(Lead.workspace_id);
  const waiting = [...p.host.querySelectorAll("button")]
    .map((b) => b.getAttribute("aria-label") ?? "")
    .filter((l) => l.startsWith("Waiting on"));
  expect(waiting).toEqual([expect.stringMatching(/^Waiting on 1 agent: Port the CLI/)]);
  expect(p.host.querySelector("button[aria-label='Stop']")).not.toBeNull();
  await p.unmount();
});

test("a builder on a Cloud computer names the chat that started it", async () => {
  const p = await mountPane(Builder.workspace_id);
  expect(p.host.querySelector(`button[title='Started by ${Lead.title}']`)).not.toBeNull();
  await p.unmount();
});

test("Agents in a chat on a Cloud computer lists its builder at work, with a Stop for it", async () => {
  openSurface(Lead.workspace_id, "agents", {});
  const p = await mountPane(Lead.workspace_id);
  expect(await p.shows("[data-side-panel] button[aria-label='Open Port the CLI']")).not.toBeNull();
  expect(
    p.host.querySelector("[data-side-panel] button[aria-label='Stop Port the CLI']"),
  ).not.toBeNull();
  await p.unmount();
});

test("Agents in a builder on a Cloud computer lists the chat that started it", async () => {
  openSurface(Builder.workspace_id, "agents", {});
  const p = await mountPane(Builder.workspace_id);
  expect(await p.shows(`[data-side-panel] button[aria-label='Open ${Lead.title}']`)).not.toBeNull();
  await p.unmount();
});

test("Overview in a chat on a Cloud computer shows its builder as at work", async () => {
  openSurface(Lead.workspace_id, "overview", {});
  const p = await mountPane(Lead.workspace_id);
  expect(
    (await p.shows("[data-side-panel] button[aria-label^='Open Port the CLI']"))?.getAttribute(
      "aria-label",
    ),
  ).toBe("Open Port the CLI: Working");
  await p.unmount();
});
