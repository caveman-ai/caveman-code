// New chat is the one place a chat starts, and it asks nothing about agents: Send asks for a plain chat on this Mac
// and in Cloud (how the work is split is the chat's agent's to decide as it goes), the task can start as several
// chats (runs), and a start link from an app that still named a number of builders is taken without it. What Cloud
// still needs is said under the box before Send.
import { buttons, page, press, render, settle } from "./dom.test-support.ts";
import type { Client } from "@caveman-app/session-protocol/client";
import type { EngineDescriptor, Project, ProjectSource } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, test, vi } from "vitest";
import { thisComputer } from "../lib/platform.ts";
import type { Where } from "./new-chat-bar.tsx";

const seen: { props: Record<string, unknown> | null } = { props: null };
// The real bar over the box; its props are read to set where it runs and the runs through its own callbacks.
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
const { adoptPendingStart, pendingStart, pendingStartParams, startLink } =
  await import("../state/cloud.ts");
const { NewChatRoute } = await import("./NewChat.tsx");
const { CloudStartRoute } = await import("./CloudStart.tsx");

const NO_MONEY = /[$€£]\s?\d|\d\s?(?:usd|dollars?|cents?)\b|\bcost\b|\bspent\b|\bcredits?\b/i;
const link = (full_name: string) => ({
  host: "github.com",
  full_name,
  web_url: `https://github.com/${full_name}`,
  clone_url: `https://github.com/${full_name}.git`,
});
const solo = {
  id: "p1",
  name: "app",
  path: "/Users/me/app",
  repository: link("acme/app"),
} as Project;
const SOURCES: ReadonlyArray<ProjectSource> = [
  { kind: "repo", name: "app", repository: link("acme/app"), path: "/Users/me/app" },
  { kind: "repo", name: "web", repository: link("acme/web") },
];
const several = { ...solo, id: "p2", sources: SOURCES } as Project;
const model = [
  { id: "claude-sonnet", label: "Sonnet", efforts: ["low", "high"], default_effort: "low" },
];
const agent = (id: string, label: string, auth: Record<string, unknown> = {}) =>
  ({
    id,
    label,
    auth: { state: "signed_in", accounts: [], ...auth },
    capabilities: { images: true },
    access_modes: ["ask", "auto"],
    models: model,
  }) as unknown as EngineDescriptor;
const CLAUDE = agent("claude-agent", "Claude Agent");

async function newChat({
  project = solo,
  engines = [CLAUDE],
  settings = {},
}: {
  project?: Project;
  engines?: EngineDescriptor[];
  settings?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let made = 0;
  const client = {
    call: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "environment.get")
        return Promise.resolve({
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
        });
      if (method === "secret.list") return Promise.resolve({ secrets: [], cloud_available: true });
      if (method === "secret.env_files") return Promise.resolve({ files: [] });
      if (method === "cloud.status")
        return Promise.resolve({ account: { organization_name: "Acme" } });
      if (method === "cloud.workspace.create")
        return Promise.resolve({
          workspace_id: "0b6f2c1e-7a55-4d0e-9d2a-3f1c2b4a5d6e",
          computer_id: "c1",
          open_url: "https://caveman.example/code/",
        });
      if (method === "workspace.create")
        return Promise.resolve({
          id: `w${++made}`,
          title: "t",
          session_id: `s${made}`,
          repo: { path: project.path },
          base_ref: "main",
          branch: "caveman/x",
          engine: "claude-agent",
          status: "working",
          computer: { id: "this_mac", kind: "this_mac", label: "This Mac", status: "online" },
          created_at: "2026-11-10T10:00:00Z",
          updated_at: "2026-11-10T10:00:00Z",
        });
      return Promise.resolve({});
    },
    on: () => () => undefined,
    subscribe: () => () => undefined,
  } as unknown as Client;
  const value = {
    status: "connected",
    error: null,
    client,
    identity: { computerName: "This Mac" },
    connection: 1,
    workspaces: [],
    raw: new Map(),
    projects: [project],
    engines,
    settings: { default_engine: engines[0]!.id, engines: {}, model_defaults: {}, ...settings },
    refresh: async () => undefined,
    markSeen: () => undefined,
  } as never;
  keepDraft("new-chat", { text: "Port every settings page to the new rows", refs: [] });
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
      runs?: { value: number; onChange: (runs: number) => void };
    };
  const said = () => (shown.host.textContent ?? "").replace(/\s+/g, " ");
  const runOn = (where: Where) => act(async () => bar().onWhere(where));
  const send = async () => {
    await press(shown.host.querySelector("textarea"), "Enter");
    await settle(6);
  };
  const sent = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);
  return { shown, calls, bar, said, runOn, send, sent, act };
}

test("New chat asks nothing about agents: no field, no estimate, and Send asks for a plain chat", async () => {
  const chat = await newChat();
  expect(chat.shown.host.querySelector("input[name='builders']")).toBeNull();
  expect("builders" in chat.bar()).toBe(false);
  expect(chat.said()).not.toMatch(/builders?|at once|Estimating/i);
  expect(chat.said()).not.toMatch(NO_MONEY);
  // Nothing stands between the person and Send.
  expect(document.querySelector("[data-confirmation]")).toBeNull();
  expect(buttons(document.body, /^Start/)).toEqual([]);

  await chat.send();

  expect(document.querySelector("[data-confirmation]")).toBeNull();
  expect(chat.sent("workspace.create")).toHaveLength(1);
  expect(chat.sent("workspace.create")[0]).toMatchObject({
    repo: { path: "/Users/me/app" },
    engine: "claude-agent",
    task: { text: "Port every settings page to the new rows" },
  });
  expect("builders" in chat.sent("workspace.create")[0]!).toBe(false);
  expect(chat.calls.some((c) => c.method === "builders.estimate")).toBe(false);
});

test("runs: the task starts as that many chats, each asked for once", async () => {
  const twice = await newChat();
  expect(twice.bar().runs?.value).toBe(1);
  await twice.act(async () => twice.bar().runs!.onChange(2));
  await twice.send();
  const made = twice.sent("workspace.create");
  expect(made).toHaveLength(2);
  // Two chats, each asked for once: never one request sent twice.
  expect(new Set(made.map((p) => p.request_id)).size).toBe(2);
  expect(made.every((p) => !("builders" in p))).toBe(true);
});

test("Cloud starts a plain chat too: its link names no number, and the chat made there is asked for without one", async () => {
  page.opened.length = 0;
  const chat = await newChat();
  await chat.runOn("cloud");
  expect(chat.shown.host.querySelector("input[name='builders']")).toBeNull();
  expect(chat.said()).not.toMatch(/builders?|at once/i);

  await chat.send();

  expect(chat.sent("cloud.workspace.create")).toHaveLength(1);
  expect(chat.sent("workspace.create")).toEqual([]);
  expect(page.opened).toHaveLength(1);
  // The Cloud-hosted client takes the link and starts the chat there (PendingCloudStart).
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
  expect("builders" in pendingStart(storage)!).toBe(false);
  const params = pendingStartParams(pendingStart(storage)!, "r1", true);
  expect(params).toMatchObject({
    repo: { url: "https://github.com/acme/app" },
    task: { text: "Port every settings page to the new rows" },
  });
  expect("builders" in params).toBe(false);
});

test("a start link that names builders (an app from before) is taken without them", () => {
  const adopt = (start: Record<string, unknown>) => {
    const session = new Map<string, string>();
    const storage = {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    };
    const hash = new URL(
      startLink("https://caveman.example/code/", {
        computer_id: "c1",
        repo: "acme/app",
        engine: "caveman",
        task: "hi",
        ...start,
      } as never),
    ).hash;
    adoptPendingStart({
      location: { hash, pathname: "/code/", search: "" },
      history: { replaceState: () => undefined },
      sessionStorage: storage,
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    } as unknown as Parameters<typeof adoptPendingStart>[0]);
    return pendingStart(storage)!;
  };
  for (const named of [30, 64, 0, "30", null]) {
    const start = adopt({ builders: named });
    expect("builders" in start, String(named)).toBe(false);
    expect("builders" in pendingStartParams(start, "r1", true), String(named)).toBe(false);
  }
  // The rest of the link is kept as it was.
  expect(adopt({ builders: 30, runs: 2 })).toMatchObject({ repo: "acme/app", task: "hi", runs: 2 });
});

test("Cloud for an agent with no plan connected there: one line with its button under the box, before Send", async () => {
  const own = {
    id: "claudeAgent:default",
    label: "ada@acme.dev",
    kind: "login",
    active: true,
    where: "this_mac",
  };
  const chat = await newChat({
    engines: [agent("claude-agent", "Claude Agent", { everywhere: "available", accounts: [own] })],
  });
  // On this Mac its own login runs it: nothing to say.
  expect(chat.said()).not.toContain("isn't connected");
  await chat.runOn("cloud");
  expect(chat.said()).toContain("Claude isn't connected for Cloud.");
  const connect = [...chat.shown.host.querySelectorAll("button")].find(
    (b) => b.textContent === "Connect Claude",
  );
  expect(connect, "Connect Claude").toBeDefined();
  expect(chat.sent("cloud.workspace.create")).toEqual([]);
  // One click starts the sign-in on this Mac, in the browser: nothing leaves New chat, and Cloud stays picked.
  expect(chat.shown.host.querySelector('a[href="/settings/models"]')).toBeNull();
  await chat.act(async () => connect!.click());
  await settle(2);
  expect(chat.sent("engine.account.add")).toEqual([
    expect.objectContaining({ engine: "claude-agent", everywhere: true }),
  ]);
  expect(chat.bar().where).toBe("cloud");
  // Back on this Mac the line goes.
  await chat.runOn("this_mac");
  expect(chat.said()).not.toContain("isn't connected");
});

test("Cloud for an agent that does not run there says so before Send, and a send keeps the message", async () => {
  page.opened.length = 0;
  const chat = await newChat({ engines: [agent("cursor", "Cursor")] });
  await chat.runOn("cloud");
  expect(chat.said()).toContain(
    "Cursor doesn't run in Cloud. Pick Claude Agent, Codex or Caveman.",
  );
  await chat.send();
  expect(chat.sent("cloud.workspace.create")).toEqual([]);
  expect(page.opened).toEqual([]);
  expect(chat.shown.host.querySelector("textarea")?.value).toBe(
    "Port every settings page to the new rows",
  );
});

test("with chats kept going in Cloud, a second repository says before Send that the chat stays on this Mac", async () => {
  localStorage.clear();
  const on = await newChat({
    project: several,
    settings: { sync_chats: true, move_to_cloud: true },
  });
  // The computer as the app names it on the OS the test runs on: "this Mac", "this PC", "this computer".
  expect(on.said()).toContain(`Chats in several repositories stay on ${thisComputer}.`);
  // Started in Cloud it is there already: nothing to say.
  await on.runOn("cloud");
  expect(on.said()).not.toContain("Chats in several repositories");
  await on.shown.unmount();

  // The setting off, or one repository: nothing to say.
  const off = await newChat({ project: several });
  expect(off.said()).not.toContain("Chats in several repositories");
  await off.shown.unmount();
  const one = await newChat({ project: solo, settings: { sync_chats: true, move_to_cloud: true } });
  expect(one.said()).not.toContain("Chats in several repositories");
});
