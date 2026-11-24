// New chat with Environment Cloud: the Cloud chat starts on the model and effort picked in the box, and files a start
// on Cloud cannot take stay in the box with the reason, never dropped while the send reads as done.
import { page, press, render, settle } from "./dom.test-support.ts";
import type { Client } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, test, vi } from "vitest";

const seen: { props: Record<string, unknown> | null } = { props: null };
// The real bar over the box; its props are read only to set where it runs and its branch through its own callbacks.
vi.mock("./new-chat-bar.tsx", async (importOriginal) => {
  const real = await importOriginal<typeof import("./new-chat-bar.tsx")>();
  const NewChatBar = (props: Record<string, unknown>) => {
    seen.props = props;
    return createElement(real.NewChatBar as never, props as never);
  };
  return { ...real, NewChatBar };
});

const { RuntimeFixture } = await import("../state/runtime.tsx");
const { keepDraft, flushDrafts, keepFiles, keptFiles } =
  await import("../state/composer-drafts.ts");
const { adoptPendingStart, pendingStart, pendingStartParams } = await import("../state/cloud.ts");
const { NewChatRoute } = await import("./NewChat.tsx");
const { CloudStartRoute } = await import("./CloudStart.tsx");

const project = {
  id: "p1",
  name: "app",
  path: "/Users/me/app",
  repository: { host: "github.com", full_name: "acme/app" },
};
const engines = [
  {
    id: "claude-agent",
    label: "Claude Agent",
    auth: { state: "signed_in", accounts: [] },
    capabilities: { images: true },
    access_modes: ["ask", "auto"],
    models: [
      { id: "claude-sonnet", label: "Sonnet", efforts: ["low", "high"], default_effort: "low" },
      { id: "claude-opus", label: "Opus", efforts: ["low", "high"], default_effort: "high" },
    ],
  },
];

async function newChat(branch?: string) {
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
  // Opus picked for this chat (another chat's "start a new chat on this model").
  const shown = await render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: "/new",
              search: "?project=p1",
              state: { pick: { engine: "claude-agent", model: "claude-opus" } },
            },
          ],
        },
        createElement(RuntimeFixture, {
          value,
          children: createElement(
            Routes,
            null,
            createElement(Route, { path: "/new", element: createElement(NewChatRoute) }),
            createElement(Route, { path: "/cloud/start", element: createElement(CloudStartRoute) }),
          ),
        }),
      ),
    ),
  );
  await settle(2);
  const bar = () =>
    seen.props as {
      onWhere: (where: "this_mac" | "cloud") => void;
      onBase: (branch: string | null) => void;
    };
  await settle();
  const { act } = await import("react");
  await act(async () => bar().onWhere("cloud"));
  if (branch) await act(async () => bar().onBase(branch));
  await settle();
  const send = async () => {
    await press(shown.host.querySelector("textarea"), "Enter");
    await settle(6);
  };
  return { shown, calls, send };
}

const shot = (name: string) => ({
  url: "data:image/png;base64,iVBORw0KGgo=",
  size: 8,
  attachment: { type: "image", name, mime_type: "image/png", data: "iVBORw0KGgo=" },
});

test("a New chat sent to Cloud with files attached keeps them and its message in the box, and says why", async () => {
  page.opened.length = 0;
  keepDraft("new-chat", { text: "Fix the header", refs: [] });
  flushDrafts();
  keepFiles("new-chat", [shot("before.png"), shot("after.png")]);
  const chat = await newChat();
  expect(chat.shown.host.querySelector("textarea")?.value).toBe("Fix the header");

  await chat.send();

  expect(chat.calls.filter((c) => c.method === "cloud.workspace.create")).toEqual([]);
  expect(page.opened).toEqual([]);
  expect(
    keptFiles<{ attachment: { name: string } }>("new-chat").map((f) => f.attachment.name),
  ).toEqual(["before.png", "after.png"]);
  expect(chat.shown.host.querySelector("textarea")?.value).toBe("Fix the header");
  expect(chat.shown.host.textContent).toContain("Files can't go with a chat started in Cloud");
  keepFiles("new-chat", []);
});

test("a New chat sent to Cloud starts its Cloud chat on the model and effort picked in the box, from the branch picked in its bar", async () => {
  page.opened.length = 0;
  keepDraft("new-chat", { text: "Fix the header", refs: [] });
  flushDrafts();
  const chat = await newChat("feat/launch-page");

  await chat.send();

  const made = chat.calls.filter((c) => c.method === "cloud.workspace.create");
  expect(made).toHaveLength(1);
  expect(made[0]!.params).toMatchObject({ base_branch: "feat/launch-page" });
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
  const params = pendingStartParams(pendingStart(storage)!, "r1", true);
  expect(params).toMatchObject({
    engine: "claude-agent",
    base_ref: "feat/launch-page",
    task: { text: "Fix the header" },
    options: { model: "claude-opus", effort: "high" },
  });
});
