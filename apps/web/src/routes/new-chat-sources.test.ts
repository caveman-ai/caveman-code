// New chat in a project with several repositories: the bar names the ones the chat works in (all until one is
// unticked, the pick remembered per project), workspace.create names them only when more than the project's own is
// ticked, Cloud is always pickable and leaves a ticked folder out (the pill says so; nothing asks the person to
// untick), and a Cloud start carries the other repositories as checkouts and every repository as its sources. A
// project with one repository sends what it always did.
import { page, press, render, settle } from "./dom.test-support.ts";
import type { Client } from "@caveman-app/session-protocol/client";
import type { Project, ProjectSource } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, test, vi } from "vitest";
import type { SourcePick, Where } from "./new-chat-bar.tsx";

const seen: { props: Record<string, unknown> | null } = { props: null };
// The real bar over the box; its props are read to tick sources and set where it runs through its own callbacks.
vi.mock("./new-chat-bar.tsx", async (importOriginal) => {
  const real = await importOriginal<typeof import("./new-chat-bar.tsx")>();
  const NewChatBar = (props: Record<string, unknown>) => {
    seen.props = props;
    return createElement(real.NewChatBar as never, props as never);
  };
  return { ...real, NewChatBar };
});

const { RuntimeFixture } = await import("../state/runtime.tsx");
const { keepDraft, flushDrafts } = await import("../state/composer-drafts.ts");
const { adoptPendingStart, pendingStart, pendingStartParams } = await import("../state/cloud.ts");
const { NewChatRoute } = await import("./NewChat.tsx");
const { CloudStartRoute } = await import("./CloudStart.tsx");

const link = (full_name: string) => ({
  host: "github.com",
  full_name,
  web_url: `https://github.com/${full_name}`,
  clone_url: `https://github.com/${full_name}.git`,
});
const SOURCES: ReadonlyArray<ProjectSource> = [
  { kind: "repo", name: "app", repository: link("acme/app"), path: "/Users/me/app" },
  { kind: "repo", name: "web", repository: link("acme/web") },
  { kind: "folder", name: "notes", path: "/Users/me/notes" },
];
const several = {
  id: "p1",
  name: "app",
  path: "/Users/me/app",
  repository: link("acme/app"),
  sources: SOURCES,
} as Project;
const one = {
  id: "p2",
  name: "solo",
  path: "/Users/me/solo",
  repository: link("acme/solo"),
} as Project;
const engines = [
  {
    id: "claude-agent",
    label: "Claude Agent",
    auth: { state: "signed_in", accounts: [] },
    capabilities: { images: true },
    access_modes: ["ask", "auto"],
    models: [
      { id: "claude-sonnet", label: "Sonnet", efforts: ["low", "high"], default_effort: "low" },
    ],
  },
];

async function newChat(project: Project) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "environment.get")
        return {
          available: true,
          environment: {
            state: "ready",
            build: null,
            secret_names: [],
            repo: "acme/app",
            config: "",
            source: "cloud",
            snapshot: null,
          },
          setup_chat: null,
          fix: null,
        };
      if (method === "secret.list") return { secrets: [], cloud_available: true };
      if (method === "secret.env_files") return { files: [] };
      if (method === "cloud.status") return { account: { organization_name: "Acme" } };
      if (method === "cloud.workspace.create")
        return {
          workspace_id: "cw1",
          computer_id: "c1",
          open_url: "https://caveman.example/code/",
        };
      if (method === "workspace.create")
        return {
          id: "w1",
          title: "t",
          session_id: "s1",
          repo: { path: project.path },
          base_ref: "main",
          branch: "caveman/x",
          engine: "claude-agent",
          status: "working",
          computer: { id: "this_mac", kind: "this_mac", label: "This Mac", status: "online" },
          created_at: "2026-11-09T10:00:00Z",
          updated_at: "2026-11-09T10:00:00Z",
        };
      return {};
    },
    on: () => () => undefined,
    subscribe: () => () => undefined,
  } as unknown as Client;
  const value = {
    status: "connected",
    error: null,
    client,
    identity: { computerName: "Mac" },
    connection: 1,
    workspaces: [],
    raw: new Map(),
    projects: [project],
    engines,
    settings: { default_engine: "claude-agent", engines: {}, model_defaults: {} },
    refresh: async () => undefined,
    markSeen: () => undefined,
  } as never;
  keepDraft("new-chat", { text: "Rename the endpoint everywhere", refs: [] });
  flushDrafts();
  const shown = await render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: "/new", search: `?project=${project.id}` }] },
        createElement(RuntimeFixture, {
          value,
          children: createElement(
            Routes,
            null,
            createElement(Route, { path: "/new", element: createElement(NewChatRoute) }),
            createElement(Route, { path: "/cloud/start", element: createElement(CloudStartRoute) }),
            createElement(Route, { path: "/w/:id", element: null }),
          ),
        }),
      ),
    ),
  );
  await settle(2);
  const { act } = await import("react");
  const bar = () =>
    seen.props as {
      where: Where;
      onWhere: (where: Where) => void;
      cloud: { chip: string; disabled?: string };
      sources?: SourcePick;
    };
  const tick = (name: string) => act(async () => bar().sources!.onToggle(name));
  const runOn = (where: Where) => act(async () => bar().onWhere(where));
  const send = async () => {
    await press(shown.host.querySelector("textarea"), "Enter");
    await settle(6);
  };
  const created = () => calls.filter((c) => c.method === "workspace.create").map((c) => c.params);
  return { shown, calls, bar, tick, runOn, send, created };
}

test("a chat in a project with several sources works in all of them, and says so to workspace.create", async () => {
  localStorage.clear();
  const chat = await newChat(several);
  expect(chat.bar().sources!.all.map((s) => s.name)).toEqual(["app", "web", "notes"]);
  expect(chat.bar().sources!.ticked.map((s) => s.name)).toEqual(["app", "web", "notes"]);
  // The pill names them; it never says "All sources".
  expect(chat.shown.host.textContent).toContain("app, web, notes");
  expect(chat.shown.host.textContent).not.toContain("All sources");

  await chat.send();

  expect(chat.created()).toHaveLength(1);
  expect(chat.created()[0]).toMatchObject({
    repo: { path: "/Users/me/app" },
    sources: ["app", "web", "notes"],
  });
});

test("unticked down to the project's own source, the chat is asked for as before sources; the pick is remembered", async () => {
  localStorage.clear();
  const chat = await newChat(several);
  await chat.tick("web");
  await chat.tick("notes");
  // The project's own source is always in.
  await chat.tick("app");
  expect(chat.bar().sources!.ticked.map((s) => s.name)).toEqual(["app"]);
  expect(chat.shown.host.querySelector("[aria-label='Works in app']")?.textContent).toBe("app");
  expect(chat.shown.host.textContent).not.toContain("app only");

  await chat.send();

  expect(chat.created()).toHaveLength(1);
  expect("sources" in chat.created()[0]!).toBe(false);

  // The next New chat in this project opens on the same pick.
  const again = await newChat(several);
  expect(again.bar().sources!.ticked.map((s) => s.name)).toEqual(["app"]);
  await again.tick("web");
  expect(again.bar().sources!.ticked.map((s) => s.name)).toEqual(["app", "web"]);
});

test("Cloud is pickable with a folder ticked: the folder is left out, the pill says so, and the tick is the person's again on this Mac", async () => {
  localStorage.clear();
  page.opened.length = 0;
  const chat = await newChat(several);
  await chat.runOn("cloud");
  // Picked, not refused; nothing tells the person to untick anything.
  expect(chat.bar().where).toBe("cloud");
  expect(chat.bar().cloud.disabled).toBeUndefined();
  expect(chat.bar().cloud.chip).toBe("Cloud · without notes");
  expect(chat.shown.host.textContent).not.toMatch(/Untick|stays here/);
  // The chat works in the two repositories there; the folder's tick is kept, marked as left out.
  expect(chat.shown.host.querySelector("[aria-label='Works in app, web']")).not.toBeNull();
  expect(chat.bar().sources!.ticked.map((s) => s.name)).toEqual(["app", "web", "notes"]);
  expect(chat.bar().sources!.leftOut).toEqual(["notes"]);

  // Back on this Mac it works in all three again, with nothing ticked anew.
  await chat.runOn("this_mac");
  expect(chat.bar().sources!.leftOut).toEqual([]);
  expect(chat.shown.host.querySelector("[aria-label='Works in app, web, notes']")).not.toBeNull();

  await chat.runOn("cloud");
  await chat.send();

  const made = chat.calls.filter((c) => c.method === "cloud.workspace.create");
  expect(made).toHaveLength(1);
  expect(made[0]!.params).toMatchObject({ repo: "acme/app", checkouts: [{ repo: "acme/web" }] });
  expect(chat.created()).toEqual([]);
  // The pick the person made is remembered as they made it: the folder was never unticked for them.
  expect(localStorage.getItem("caveman.newChat.sourcesLeftOut")).toBeNull();
});

test("a Cloud start carries the other repositories as checkouts, and names every repository to the Cloud computer's chat", async () => {
  localStorage.clear();
  page.opened.length = 0;
  const chat = await newChat(several);
  await chat.tick("notes");
  await chat.runOn("cloud");
  expect(chat.bar().where).toBe("cloud");
  expect(chat.bar().cloud.disabled).toBeUndefined();

  await chat.send();

  const made = chat.calls.filter((c) => c.method === "cloud.workspace.create");
  expect(made).toHaveLength(1);
  expect(made[0]!.params).toMatchObject({ repo: "acme/app", checkouts: [{ repo: "acme/web" }] });
  expect(chat.created()).toEqual([]);
  expect(page.opened).toHaveLength(1);
  // The Cloud-hosted client takes the link and starts the chat on the computer (PendingCloudStart).
  const session = new Map<string, string>();
  const storage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  };
  adoptPendingStart({
    location: { hash: new URL(page.opened[0]!).hash, pathname: "/code/", search: "" },
    history: { replaceState: () => undefined },
    sessionStorage: storage,
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  } as unknown as Parameters<typeof adoptPendingStart>[0]);
  expect(pendingStartParams(pendingStart(storage)!, "r1", true)).toMatchObject({
    repo: { url: "https://github.com/acme/app" },
    sources: ["acme/app", "acme/web"],
    task: { text: "Rename the endpoint everywhere" },
  });
});

test("a project with one source has no sources control and sends what it always did, on this computer and to Cloud", async () => {
  localStorage.clear();
  page.opened.length = 0;
  const chat = await newChat(one);
  expect(chat.bar().sources).toBeUndefined();
  expect(chat.shown.host.textContent).not.toContain("All sources");
  await chat.send();
  expect(chat.created()).toHaveLength(1);
  expect("sources" in chat.created()[0]!).toBe(false);

  const cloud = await newChat(one);
  await cloud.runOn("cloud");
  await cloud.send();
  const made = cloud.calls.filter((c) => c.method === "cloud.workspace.create");
  expect(made).toHaveLength(1);
  expect("checkouts" in made[0]!.params).toBe(false);
  const session = new Map<string, string>();
  const storage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  };
  adoptPendingStart({
    location: { hash: new URL(page.opened[0]!).hash, pathname: "/code/", search: "" },
    history: { replaceState: () => undefined },
    sessionStorage: storage,
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  } as unknown as Parameters<typeof adoptPendingStart>[0]);
  expect("sources" in pendingStartParams(pendingStart(storage)!, "r1", true)).toBe(false);
});

test("a start link carries only repositories by owner/name as its sources, and a few of them", () => {
  const adopt = (start: Record<string, unknown>) => {
    const session = new Map<string, string>();
    const storage = {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    };
    const hash = `#start=${btoa(
      JSON.stringify({
        computer_id: "c1",
        repo: "acme/app",
        engine: "caveman",
        task: "hi",
        ...start,
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}`;
    adoptPendingStart({
      location: { hash, pathname: "/code/", search: "" },
      history: { replaceState: () => undefined },
      sessionStorage: storage,
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    } as unknown as Parameters<typeof adoptPendingStart>[0]);
    return pendingStart(storage);
  };
  expect(adopt({ sources: ["acme/app", "acme/web"] })?.sources).toEqual(["acme/app", "acme/web"]);
  // A path, a URL or anything else a link might smuggle in is dropped; one name alone is a chat in one repository.
  expect(
    adopt({ sources: ["acme/app", "/etc/passwd", "https://evil.example/x", 7] })?.sources,
  ).toBeUndefined();
  expect(adopt({ sources: "acme/app" })?.sources).toBeUndefined();
  expect(
    adopt({ sources: Array.from({ length: 40 }, (_, i) => `acme/r${i}`) })?.sources,
  ).toHaveLength(16);
  // A pull request's chat is in its repository alone.
  expect(
    "sources" in
      pendingStartParams(
        { ...adopt({ sources: ["acme/app", "acme/web"] })!, pull_request: 4 },
        "r1",
        true,
      ),
  ).toBe(false);
});
