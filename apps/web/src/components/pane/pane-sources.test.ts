// A chat in several sources of its project: its header names them, each with its own pull request; its title menu
// lists them and adds the project's others (workspace.add_source), and a refusal shows in the runtime's own words.
// A chat in one source of a project with one source shows none of it.
import { alerts, buttons, click, container, settle } from "../../lib/dom.test-support.ts";
import {
  ErrorCodes,
  type Project,
  type ProjectSource,
  type Workspace,
} from "@caveman-app/session-protocol";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { PaneFrame } from "./PaneFrame.tsx";

const link = (full_name: string) => ({
  host: "github.com",
  full_name,
  web_url: `https://github.com/${full_name}`,
  clone_url: `https://github.com/${full_name}.git`,
});
const SOURCES: ReadonlyArray<ProjectSource> = [
  { kind: "repo", name: "api", repository: link("acme/api"), path: "/Users/me/acme/api" },
  { kind: "repo", name: "web", repository: link("acme/web") },
  { kind: "folder", name: "notes", path: "/Users/me/notes" },
];
const several = {
  id: "p1",
  name: "acme",
  path: "/Users/me/acme/api",
  repository: link("acme/api"),
  sources: SOURCES,
} as Project;
const solo = {
  id: "p2",
  name: "solo",
  path: "/Users/me/solo",
  repository: link("acme/solo"),
} as Project;
const pr = (number: number, state: "open" | "draft" = "open") => ({
  number,
  url: `https://github.com/acme/x/pull/${number}`,
  state,
});

const chat = (id: string, over: Partial<Workspace> = {}) =>
  ({
    id,
    session_id: `s_${id}`,
    title: `Chat ${id}`,
    status: "idle",
    engine: "caveman",
    repo: { path: "/Users/me/acme/api" },
    base_ref: "main",
    branch: "caveman/rename",
    project_id: "p1",
    created_at: "2026-11-06T10:00:00Z",
    updated_at: "2026-11-06T10:00:00Z",
    parent_workspace_id: null,
    computer: { id: "mac", kind: "this_mac", label: "This Mac", status: "online" },
    ...over,
  }) as Workspace;
const WEB_CHECKOUT = {
  name: "web",
  repo: { url: "https://github.com/acme/web.git" },
  repository: link("acme/web"),
  base_ref: "main",
  branch: "caveman/rename",
  pull_request: pr(57, "draft"),
};
const IN_TWO = chat("T", { source: "api", pull_request: pr(128), checkouts: [WEB_CHECKOUT] });

async function mountPane(workspace: Workspace, refusal?: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adopted: Workspace[] = [];
  const client = {
    call: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "workspace.add_source") {
        if (refusal)
          return Promise.reject(
            new SessionProtocolError({
              code: ErrorCodes.invalid_state,
              message: refusal,
              data: { reason: "invalid_state" },
            }),
          );
        return Promise.resolve({
          ...workspace,
          source: "api",
          checkouts: [
            ...(workspace.checkouts ?? []),
            {
              name: params.source,
              repo: { path: "/x" },
              base_ref: "main",
              branch: workspace.branch,
            },
          ],
        });
      }
      if (method === "queue.list") return Promise.resolve({ turns: [] });
      if (method === "editor.list") return Promise.resolve({ editors: [], reveal: false });
      if (method === "session.move.held") return Promise.resolve({ paths: [] });
      if (method === "actions.list") return Promise.resolve({ actions: [] });
      if (method === "secret.list") return Promise.resolve({ repository: "acme/api", secrets: [] });
      return Promise.resolve({});
    },
    on: () => () => undefined,
    subscribe: () => () => undefined,
    attach: async (sessionId: string) => ({
      session: { id: sessionId, state: "live" },
      cursor: () => 0,
      detach: async () => undefined,
    }),
  };
  const value = {
    status: "connected",
    error: null,
    client,
    identity: {},
    connection: 1,
    workspaces: [
      {
        ...workspace,
        repo: "acme/api",
        repoRef: workspace.repo,
        projectId: workspace.project_id ?? null,
      },
    ],
    raw: new Map([[workspace.id, workspace]]),
    projects: [several, solo],
    engines: [
      { id: "caveman", label: "Caveman", auth: { state: "api_key" }, capabilities: {}, models: [] },
    ],
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
    adopt: (w: Workspace) => void adopted.push(w),
  } as unknown as RuntimeContextValue;
  const host = container();
  const root = createRoot(host);
  const pane = createElement(PaneFrame, {
    pane: { kind: "pane", id: "p1", workspaceId: workspace.id } as never,
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
  const openMenu = async () => {
    await click(buttons(host, workspace.title)[0]);
    return [...document.querySelectorAll("[role='menuitem']")];
  };
  const added = () => calls.filter((c) => c.method === "workspace.add_source").map((c) => c.params);
  return { host, calls, adopted, openMenu, added, unmount: () => act(async () => root.unmount()) };
}

const item = (items: Element[], text: string) =>
  items.find((i) => i.textContent?.trim().startsWith(text));

test("a chat in two sources names them beside its title, the primary first, each with its own pull request", async () => {
  const pane = await mountPane(IN_TWO);
  const names = pane.host.querySelector("[data-chat-sources]");
  expect(names?.textContent).toBe("apiweb");
  const marks = [...(names?.querySelectorAll("[role='img']") ?? [])].map((m) =>
    m.getAttribute("aria-label"),
  );
  expect(marks).toEqual(["api: pull request #128, open", "web: pull request #57, draft"]);
  // The title menu lists them at its top, and offers the project's one other source by name.
  const items = await pane.openMenu();
  expect(
    [...document.querySelectorAll("[data-chat-source]")].map((l) =>
      l.getAttribute("data-chat-source"),
    ),
  ).toEqual(["api", "web"]);
  expect(item(items, "Add notes")?.textContent).toContain("Folder");
  expect(item(items, "Add a source")).toBeUndefined();
  await pane.unmount();
});

test("Add from the title menu adds that source to the chat, and the chat shows it at once", async () => {
  const pane = await mountPane(IN_TWO);
  await click(item(await pane.openMenu(), "Add notes"));
  await settle();
  expect(pane.added()).toEqual([expect.objectContaining({ workspace_id: "T", source: "notes" })]);
  expect(pane.adopted.map((w) => w.checkouts?.map((c) => c.name))).toEqual([["web", "notes"]]);
  expect(alerts(pane.host)).toEqual([]);
  await pane.unmount();
});

test("a chat in one source of a project with several is offered the others, in a submenu when there are two or more", async () => {
  const pane = await mountPane(chat("O"));
  // In one source it shows no sources: only what it always did.
  expect(pane.host.querySelector("[data-chat-sources]")).toBeNull();
  const items = await pane.openMenu();
  expect(document.querySelector("[data-chat-source]")).toBeNull();
  expect(item(items, "Add a source")).toBeDefined();
  await pane.unmount();
});

test("the runtime's refusal to add a source shows in its own words", async () => {
  const why =
    "Stop the turn first: adding a source to a chat that works in one restarts its agent in the new folder.";
  const pane = await mountPane(IN_TWO, why);
  await click(item(await pane.openMenu(), "Add notes"));
  await settle();
  expect(pane.added()).toHaveLength(1);
  expect(alerts(pane.host)).toContain(why);
  expect(pane.adopted).toEqual([]);
  await pane.unmount();
});

test("a chat in a project with one source has nothing to add and names no sources", async () => {
  const pane = await mountPane(
    chat("S", { project_id: "p2", repo: { path: "/Users/me/solo" }, pull_request: pr(31) }),
  );
  expect(pane.host.querySelector("[data-chat-sources]")).toBeNull();
  // Its pull request is the one glyph it always was.
  expect(
    [...pane.host.querySelectorAll("header [role='img']")].map((m) => m.getAttribute("aria-label")),
  ).toContain("Pull request #31, open");
  const items = await pane.openMenu();
  expect(items.some((i) => i.textContent?.trim().startsWith("Add"))).toBe(false);
  expect(pane.calls.some((c) => c.method === "workspace.add_source")).toBe(false);
  await pane.unmount();
});
