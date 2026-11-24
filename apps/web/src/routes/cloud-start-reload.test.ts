// A new chat on Cloud starts once. Its task rides in the history entry (New chat navigates to #/cloud/start with it),
// which a reload or Back to the entry brings back: the page then says the chat started, and makes no second Cloud
// computer and opens no second start link for the same task.
import { page, render, settle, window as win } from "./dom.test-support.ts";
import type { Client } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { act, createElement } from "react";
import { createHashRouter, RouterProvider } from "react-router";
import { expect, test } from "vitest";
import { startLink } from "../state/cloud.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { CloudStartRoute } from "./CloudStart.tsx";

const project = {
  id: "p1",
  name: "app",
  path: "/Users/me/app",
  repository: { host: "github.com", full_name: "acme/app" },
};
const environment = {
  state: "ready",
  build: null,
  secret_names: [],
  repo: "acme/app",
  source: "repo",
  snapshot: null,
  config: null,
};

/**
 * Cloud as This Mac's runtime reaches it; a create answers once `made` settles. The runtime runs a create once per
 * request_id and a retry joins it, as server.ts once() does: `creates` is what Cloud was asked to make.
 */
function cloud(made: Promise<unknown> = Promise.resolve()) {
  const creates: unknown[] = [];
  const runs = new Map<string, Promise<unknown>>();
  const runtime = async (method: string, params: unknown) => {
    if (method === "cloud.status") return { account: { organization_name: "Acme" } };
    if (method === "secret.list") return { secrets: [], cloud_available: true };
    if (method === "environment.get")
      return { available: true, environment, setup_chat: null, fix: null, proposals: [] };
    if (method === "cloud.workspace.create") {
      const id = (params as { request_id: string }).request_id;
      let run = runs.get(id);
      if (run === undefined) {
        const n = creates.push(params);
        run = made.then(() => ({
          workspace_id: `w${n}`,
          computer_id: `c${n}`,
          open_url: "https://caveman.example/code/",
        }));
        runs.set(id, run);
      }
      return run;
    }
    return {};
  };
  const routes = [
    { path: "new", Component: () => null },
    { path: "cloud/start", Component: CloudStartRoute },
  ];
  // A page load: a fresh router reads the address and history.state the window kept. `unload` ends it as a reload does:
  // the runtime goes on with what it was asked, and no answer reaches the page that asked.
  const boot = async () => {
    let live = true;
    const client = {
      call: (method: string, params: unknown) =>
        runtime(method, params).then((answer) => (live ? answer : new Promise(() => undefined))),
      on: () => () => undefined,
    } as unknown as Client;
    const value = {
      status: "connected",
      error: null,
      client,
      identity: {},
      connection: 1,
      workspaces: [],
      raw: new Map(),
      projects: [project],
      engines: [],
      settings: null,
      refresh: async () => undefined,
      markSeen: () => undefined,
    } as unknown as RuntimeContextValue;
    const router = createHashRouter(routes, { window: win as unknown as Window });
    const shown = await render(
      createElement(RuntimeFixture, {
        value,
        children: createElement(TooltipProvider, null, createElement(RouterProvider, { router })),
      }),
    );
    await settle(6);
    const unload = async () => {
      live = false;
      await shown.unmount();
      router.dispose();
    };
    return { router, shown, unload };
  };
  return { creates, boot };
}
const task = { project_id: "p1", text: "Fix the flaky login test", engine: "caveman" };

test("a reload after a Cloud start shows it started and makes no second Cloud computer for the same task", async () => {
  page.reset("#/new");
  page.opened.length = 0;
  const { creates, boot } = cloud();

  // New chat, Environment Cloud, Send (NewChat.tsx).
  const first = await boot();
  await act(async () => void (await first.router.navigate("/cloud/start", { state: task })));
  await settle(6);
  expect(creates).toHaveLength(1);
  expect(page.opened).toHaveLength(1);
  expect(document.body.textContent).toContain("Started in Cloud.");

  // View > Reload: the URL and history.state stay, the page's own state goes.
  await first.unload();
  expect(page.location.hash).toBe("#/cloud/start");
  const second = await boot();

  expect(creates).toHaveLength(1);
  expect(page.opened).toHaveLength(1);
  expect(document.body.textContent).toContain("Started in Cloud.");
  second.router.dispose();
});

test("a reload while Cloud is still making the computer opens that computer's chat once and makes no second one", async () => {
  page.reset("#/new");
  page.opened.length = 0;
  let answer = () => undefined as void;
  const { creates, boot } = cloud(new Promise<void>((resolve) => (answer = resolve)));
  const first = await boot();
  await act(async () => void (await first.router.navigate("/cloud/start", { state: task })));
  await settle(3);
  expect(creates).toHaveLength(1);

  // Cmd+R (or the update notice's Reload) while Cloud makes the computer; Cloud answers after the page came back.
  await first.unload();
  expect(page.location.hash).toBe("#/cloud/start");
  const second = await boot();
  answer();
  await settle(6);

  expect(creates).toHaveLength(1);
  // The link names the workspace Cloud placed, so the chat started from it takes up that placement.
  expect(page.opened).toEqual([
    startLink("https://caveman.example/code/", {
      computer_id: "c1",
      workspace_id: "w1",
      repo: "acme/app",
      engine: "caveman",
      task: task.text,
    }),
  ]);
  expect(document.body.textContent).toContain("Started in Cloud.");
  await second.unload();
});

test("Back to a Cloud start left while its computer was being made shows it started and makes no second one", async () => {
  page.reset("#/new");
  page.opened.length = 0;
  let answer = () => undefined as void;
  const { creates, boot } = cloud(new Promise<void>((resolve) => (answer = resolve)));
  const app = await boot();
  await act(async () => void (await app.router.navigate("/cloud/start", { state: task })));
  await settle(3);
  expect(creates).toHaveLength(1);

  // The person goes elsewhere while Cloud makes the computer; it answers after.
  await act(async () => void (await app.router.navigate("/new")));
  answer();
  await settle(3);
  expect(page.opened).toHaveLength(1);

  await act(async () => void (await app.router.navigate(-1)));
  await settle(6);
  expect(page.location.hash).toBe("#/cloud/start");
  expect(creates).toHaveLength(1);
  expect(page.opened).toHaveLength(1);
  expect(document.body.textContent).toContain("Started in Cloud.");
  app.router.dispose();
});
