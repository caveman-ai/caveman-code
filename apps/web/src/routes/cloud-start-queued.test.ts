// A new chat in Cloud from the desktop app: the message never waits for the project's setup, and where Cloud holds
// the start the chat opens in the app, with no hand-off to a browser.
import { page, render, settle, window as win } from "./dom.test-support.ts";
import type { Client } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { act, createElement } from "react";
import { createHashRouter, RouterProvider } from "react-router";
import { expect, test } from "vitest";
import type { QueuedStart } from "../state/cloud.ts";
import { RuntimeFixture, SyncHubFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import type { SyncHub } from "../state/sync/hub.ts";
import { placedWorkspaceId } from "../state/sync/message-id.ts";
import { CloudStartRoute } from "./CloudStart.tsx";

const project = {
  id: "p1",
  name: "app",
  path: "/Users/me/app",
  repository: { host: "github.com", full_name: "acme/app" },
};
const PLACED = "0195A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B";
/** A project whose setup is still building: nothing is ready to start a computer from. */
const building = {
  state: "building",
  build: {
    id: "b1",
    status: "running",
    steps: [{ name: "clone", status: "running" }],
    log_tail: "",
  },
  secret_names: [],
  repo: "acme/app",
  source: "cloud",
  snapshot: null,
  config: null,
};

/** The desktop app on a runtime whose Cloud answers `made` to a start; `hub`: the app's list of the person's Cloud chats. */
async function desk(made: Record<string, unknown>, hub: SyncHub | null) {
  const creates: Array<Record<string, unknown>> = [];
  const client = {
    call: async (method: string, params: unknown) => {
      if (method === "cloud.status") return { account: { organization_name: "Acme" } };
      if (method === "secret.list") return { secrets: [], cloud_available: true };
      if (method === "environment.get")
        return {
          available: true,
          environment: building,
          setup_chat: null,
          fix: null,
          proposals: [],
        };
      if (method === "cloud.workspace.create") {
        creates.push(params as Record<string, unknown>);
        return {
          workspace_id: PLACED,
          computer_id: "c1",
          open_url: "https://caveman.example/code/",
          ...made,
        };
      }
      return {};
    },
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
  const router = createHashRouter(
    [
      { path: "new", Component: () => null },
      { path: "cloud/start", Component: CloudStartRoute },
      { path: "w/:workspaceId", Component: () => null },
    ],
    { window: win as unknown as Window },
  );
  const shell = createElement(TooltipProvider, null, createElement(RouterProvider, { router }));
  await render(
    createElement(RuntimeFixture, {
      value,
      children: hub ? createElement(SyncHubFixture, { hub, children: shell }) : shell,
    }),
  );
  await settle(6);
  return { creates, router };
}

test("the message goes while the project's setup still builds: nothing waits for it, and nobody presses Start now", async () => {
  page.reset("#/new");
  page.opened.length = 0;
  const { creates, router } = await desk({}, null);
  await act(
    async () =>
      void (await router.navigate("/cloud/start", {
        state: {
          project_id: "p1",
          text: "Fix the flaky login test",
          engine: "caveman",
          queue: true,
        },
      })),
  );
  await settle(6);
  // Cloud was asked at once. With no list of Cloud chats in this app, the start carries on in the Cloud-hosted client.
  expect(creates).toHaveLength(1);
  expect(creates[0]).not.toHaveProperty("start");
  expect(page.opened).toHaveLength(1);
  expect(document.body.textContent).toContain(
    "Started in Cloud without setup. Setup carries on for the next chat.",
  );
  expect(document.body.textContent).not.toMatch(/Start now|runs when it's ready|Setting up/);
  router.dispose();
});

test("where Cloud holds the start, the chat opens in the app with its message: no browser, no second step", async () => {
  page.reset("#/new");
  page.opened.length = 0;
  const started: QueuedStart[] = [];
  const hub = {
    hasCloud: () => true,
    startQueued: async (start: QueuedStart) => void started.push(start),
  } as unknown as SyncHub;
  const call = {
    id: "call-1",
    request_id: "x",
    method: "workspace.create",
    status: "queued",
    created_at: "2026-11-13T12:00:00.000Z",
  };
  const { creates, router } = await desk({ session_id: "ses-1", start: call }, hub);
  await act(
    async () =>
      void (await router.navigate("/cloud/start", {
        state: {
          project_id: "p1",
          text: "Fix the flaky login test",
          engine: "caveman",
          queue: true,
        },
      })),
  );
  await settle(8);
  // One ask of Cloud, carrying the chat's start under the request id its computer runs it by.
  expect(creates).toHaveLength(1);
  const sent = creates[0] as {
    request_id: string;
    start: { request_id: string; params: Record<string, unknown> };
  };
  expect(sent.start).toEqual({
    request_id: sent.request_id,
    params: {
      repo: { url: "https://github.com/acme/app" },
      engine: "caveman",
      task: { text: "Fix the flaky login test" },
    },
  });
  // The app shows the chat from here, under the id its computer will give it; nothing opens in a browser.
  const opened = await placedWorkspaceId(PLACED);
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({
    session_id: "ses-1",
    workspace_id: opened,
    open_url: "https://caveman.example/code/",
    start: {
      computer_id: "c1",
      workspace_id: PLACED,
      request_id: sent.request_id,
      task: "Fix the flaky login test",
    },
  });
  expect(page.opened).toEqual([]);
  expect(page.location.hash).toBe(`#/w/${opened}`);
  router.dispose();
});

test("an agent that must be connected first, or several runs, is not queued: it carries on in the Cloud-hosted client as before", async () => {
  page.reset("#/new");
  page.opened.length = 0;
  const hub = { hasCloud: () => true, startQueued: async () => undefined } as unknown as SyncHub;
  const { creates, router } = await desk({}, hub);
  await act(
    async () =>
      void (await router.navigate("/cloud/start", {
        state: { project_id: "p1", text: "Fix it", engine: "codex" },
      })),
  );
  await settle(6);
  expect(creates).toHaveLength(1);
  expect(creates[0]).not.toHaveProperty("start");
  expect(page.opened).toHaveLength(1);
  router.dispose();
});
