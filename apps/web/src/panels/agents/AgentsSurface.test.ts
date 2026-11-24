// The side panel's Agents tab: a chat's lead and the agents it started, wherever the chat runs, which computer each runs on, and
// where each one's Stop goes. Stop is clicked in a mounted tab (linkedom); the rest is read from a static render.
import { document as doc } from "../../testing/dom.ts";
import type { Workspace } from "@caveman-app/session-protocol";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatListSnapshot } from "../../state/sync/chat-list.ts";
import type { SyncHub } from "../../state/sync/hub.ts";
import type { ChatSummary, RuntimeState } from "../../state/sync/wire.ts";

// A session has no server snapshot; the sync hub holds the Cloud list the test gives.
const at = vi.hoisted(() => ({ hub: null as unknown }));
vi.mock("../../state/runtime.tsx", async (real) => ({
  ...(await real<object>()),
  useSession: () => ({ view: null, model: null, historyVersion: 0, feed: null }),
  useSyncHub: () => at.hub,
}));

import {
  ChatClientScope,
  chatClientFor,
  RuntimeFixture,
  type RuntimeContextValue,
} from "../../state/runtime.tsx";
import { chatWorkspace, whereOf } from "../../state/sync/chats-view.ts";
import { PanelWorkspace } from "../workspace.ts";
import AgentsSurface from "./AgentsSurface.tsx";

const HOME = "rt-home";
const here = { id: "this-mac", kind: "this_mac", label: "MacBook", status: "online" } as const;
const workspace = (
  id: string,
  computer: Workspace["computer"],
  more: Partial<Workspace> = {},
): Workspace =>
  ({
    id,
    session_id: `S-${id}`,
    title: id,
    status: "idle",
    engine: "caveman",
    repo: { url: "" },
    base_ref: "",
    branch: "",
    created_at: "2026-11-07T10:00:00Z",
    updated_at: "2026-11-07T10:05:00Z",
    computer,
    ...more,
  }) as Workspace;

const cloudRuntime: RuntimeState = {
  runtime_id: "rt-cloud",
  computer_id: "cc-1",
  kind: "cloud",
  name: "Cloud computer",
  online: true,
  last_seen_at: "2026-11-07T10:05:00Z",
};
const summary = (id: string, more: Partial<ChatSummary> = {}): ChatSummary => ({
  session_id: `S-${id}`,
  workspace_id: id,
  runtime_id: "rt-cloud",
  computer_id: "cc-1",
  where: { kind: "cloud", name: "Cloud computer", online: true },
  title: id,
  engine: "caveman",
  kind: "chat",
  status: "idle",
  last_activity_at: "2026-11-07T10:05:00Z",
  epoch: 1,
  head: 1,
  synced_through: 1,
  archived: false,
  person: { seen_cursor: 1, pinned: false },
  calls: [],
  seq: 1,
  ...more,
});
const cloudList = (chats: ReadonlyArray<ChatSummary>): ChatListSnapshot =>
  ({
    status: "live",
    chats: new Map(chats.map((c) => [c.session_id, c])),
    runtimes: new Map([[cloudRuntime.runtime_id, cloudRuntime]]),
    seq: 1,
    ready: true,
  }) as ChatListSnapshot;
/** The workspace PaneFrame gives the side panel for a chat on another computer (Cloud's list). */
const shownFromCloud = (chat: ChatSummary, list: ChatListSnapshot) =>
  chatWorkspace(chat, whereOf(chat, list.runtimes, HOME));

/** Every call the test's clients were sent: by the window's own runtime ("window"), or by the chat client for a session. */
const sent: Array<{ readonly via: string; readonly method: string; readonly session_id: unknown }> =
  [];
const clientNamed = (via: string) => ({
  call: async (method: string, params: { readonly session_id?: unknown }) =>
    void sent.push({ via, method, session_id: params.session_id }),
  attach: async () => ({ unsubscribe: () => undefined }),
  on: () => () => undefined,
  close: () => undefined,
});
/** The desktop's sync hub over Cloud's `list`: a chat on another runtime goes through the hub, by its own session (hub.ts throughHub, clientFor). */
const hubOver = (list: ChatListSnapshot) =>
  ({
    homeRuntimeId: () => HOME,
    list: { subscribe: () => () => undefined, get: () => list },
    throughHub: (sessionId: string) => (list.chats.get(sessionId)?.runtime_id ?? HOME) !== HOME,
    clientFor: clientNamed,
    connectionFor: () => 0,
    subscribe: () => () => undefined,
  }) as unknown as SyncHub;

/** The side panel's Agents tab showing `shown`, with this window's runtime holding `raw` and Cloud's `list`; `through`: the session whose chat client the pane talks through. */
function agentsTree(
  shown: Workspace,
  raw: ReadonlyArray<Workspace>,
  list: ChatListSnapshot | null,
  through?: string,
) {
  const hub = list ? hubOver(list) : null;
  at.hub = hub;
  const value = {
    status: "connected",
    client: clientNamed("window"),
    connection: 0,
    workspaces: [],
    raw: new Map(raw.map((w) => [w.id, w])),
    projects: [],
    engines: [],
    settings: null,
  } as unknown as RuntimeContextValue;
  const surface = createElement(AgentsSurface, {
    workspaceId: shown.id,
    active: false,
    tab: { id: "T-1", kind: "agents", params: {}, reveal: 0 },
  } as never);
  const panel = createElement(PanelWorkspace.Provider, { value: shown }, surface);
  // PaneFrame: a chat that goes through the hub has its pane, side panel and all, in that chat's client scope.
  const scoped: ReactNode =
    hub && through
      ? createElement(ChatClientScope, { client: chatClientFor(hub, through), children: panel })
      : panel;
  return createElement(
    MemoryRouter,
    null,
    createElement(RuntimeFixture, { value, children: scoped }),
  );
}
const agentsTab = (
  shown: Workspace,
  raw: ReadonlyArray<Workspace>,
  list: ChatListSnapshot | null = null,
): string => renderToStaticMarkup(agentsTree(shown, raw, list));

let unmount = async () => undefined;
afterEach(async () => {
  await unmount();
  sent.length = 0;
});
/** The tab mounted, its effects running; `stop` clicks an agent's Stop by its title. */
async function mountTab(tree: ReturnType<typeof agentsTree>) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  unmount = async () => {
    unmount = async () => undefined;
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(tree));
  return {
    stop: async (title: string) => {
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="Stop ${title}"]`);
      expect(button, `a Stop on ${title}`).not.toBeNull();
      await act(async () => button!.click());
    },
  };
}
/** A section's rows, or what the tab shows instead when it has no such section. */
const section = (html: string, title: string) =>
  html.match(new RegExp(`>${title}</[^>]+>(.*?)</section>`))?.[1] ??
  `no ${title} section in: ${html.replace(/<[^>]+>/g, " ").trim()}`;
/** One agent's row in a section, by its title. */
const row = (rows: string, title: string) =>
  rows.split("</li>").find((r) => r.includes(`>${title}<`)) ?? `no row ${title}`;

test("a builder on a Cloud computer this window never held shows its lead", () => {
  const list = cloudList([
    summary("W-lead"),
    summary("W-builder", { kind: "builder", parent_session_id: "S-W-lead" }),
  ]);
  const html = agentsTab(shownFromCloud(list.chats.get("S-W-builder")!, list), [], list);
  expect(section(html, "Lead")).toContain(">W-lead<");
});

test("a lead on a Cloud computer this window never held lists its agents under one heading, not its archived ones", () => {
  const list = cloudList([
    summary("W-lead"),
    summary("W-tests", { kind: "builder", parent_session_id: "S-W-lead", status: "working" }),
    summary("W-docs", { kind: "builder", parent_session_id: "S-W-lead" }),
    summary("W-old", { kind: "builder", parent_session_id: "S-W-lead", archived: true }),
    summary("W-other", { kind: "builder", parent_session_id: "S-W-elsewhere" }),
  ]);
  const builders = section(
    agentsTab(shownFromCloud(list.chats.get("S-W-lead")!, list), [], list),
    "Agents",
  );
  // Where it runs is "Cloud", never the Cloud computer's own name.
  expect(row(builders, "W-tests")).toContain(">Cloud<");
  expect(row(builders, "W-tests")).not.toContain("Cloud computer");
  expect(builders).toContain(">W-docs<");
  expect(builders).not.toContain(">W-old<");
  expect(builders).not.toContain(">W-other<");
});

test("a builder this Mac moved to the person's other Mac says it runs there; one here names no computer", () => {
  const lead = workspace("W-lead", here);
  // markMovedAway for a move to another Mac (handlers.ts): this Mac's parked record, kind this_mac, the other Mac's id.
  const moved = workspace(
    "W-moved",
    { id: "mac-studio", kind: "this_mac", label: "Studio", status: "online" },
    { parent_workspace_id: "W-lead", status: "parked" },
  );
  const local = workspace("W-local", here, { parent_workspace_id: "W-lead" });
  const builders = section(agentsTab(lead, [lead, moved, local]), "Agents");
  expect(row(builders, "W-moved")).toContain(">Studio<");
  expect(row(builders, "W-local")).toContain("Done");
  expect(row(builders, "W-local")).not.toContain(">MacBook<");
});

test("Stop on a builder this Mac's lead moved to a Cloud computer stops it there, not this Mac's parked copy", async () => {
  const lead = workspace("W-lead", here, { status: "working" });
  // markMovedAway for a move to Cloud (handlers.ts): this Mac keeps a parked record; Cloud's list says it works there.
  const parked = workspace(
    "W-b",
    { id: "caveman-cloud", kind: "caveman_cloud", label: "Cloud computer", status: "online" },
    { parent_workspace_id: "W-lead", status: "parked" },
  );
  const list = cloudList([
    summary("W-b", { kind: "builder", parent_session_id: "S-W-lead", status: "working" }),
  ]);
  const tab = await mountTab(agentsTree(lead, [lead, parked], list));
  await tab.stop("W-b");
  expect(sent).toEqual([{ via: "S-W-b", method: "turn.interrupt", session_id: "S-W-b" }]);
});

test("in a lead on a Cloud computer, each builder's Stop goes to the computer that builder runs on", async () => {
  const list = cloudList([
    summary("W-lead", { status: "working" }),
    summary("W-cloud", { kind: "builder", parent_session_id: "S-W-lead", status: "working" }),
  ]);
  // A builder of that lead the person moved to this Mac, where this window's runtime runs it.
  const local = workspace("W-here", here, { parent_workspace_id: "W-lead", status: "working" });
  const tab = await mountTab(
    agentsTree(shownFromCloud(list.chats.get("S-W-lead")!, list), [local], list, "S-W-lead"),
  );
  await tab.stop("W-cloud");
  await tab.stop("W-here");
  expect(sent).toEqual([
    { via: "S-W-cloud", method: "turn.interrupt", session_id: "S-W-cloud" },
    { via: "window", method: "turn.interrupt", session_id: "S-W-here" },
  ]);
});
