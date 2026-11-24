// A new chat in Cloud from the desktop app carries the one-time offer to use a subscription there: it shows
// beside the start, the message goes whatever is answered or nothing is, and an answered offer is not shown again.
import { buttons, click, page, render, settle, window as win } from "./dom.test-support.ts";
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { act, createElement } from "react";
import { createHashRouter, RouterProvider } from "react-router";
import { afterEach, expect, test } from "vitest";
import { resetCloudOffer } from "../state/cloud-offer.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { forgetConnects } from "./settings/Connections.tsx";
import { PLANS } from "./settings/connections-model.ts";
import { CloudStartRoute } from "./CloudStart.tsx";

const project = {
  id: "p1",
  name: "app",
  path: "/Users/me/app",
  repository: { host: "github.com", full_name: "acme/app" },
};
const TITLE = "Use your Claude subscription here too?";
/** Claude on this Mac's own login, which one approval would carry to Cloud. */
const claude = {
  id: "claude-agent",
  label: "Claude Agent",
  auth: {
    state: "signed_in",
    everywhere: "available",
    accounts: [{ id: PLANS["claude-agent"].own, active: true, label: "Plan", kind: "login" }],
  },
} as unknown as EngineDescriptor;

async function desk(engines: ReadonlyArray<EngineDescriptor>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "cloud.status") return { account: { organization_name: "Acme" } };
      if (method === "secret.list") return { secrets: [], cloud_available: true };
      if (method === "environment.get")
        return {
          available: true,
          environment: {
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
          },
          setup_chat: null,
          fix: null,
          proposals: [],
        };
      if (method === "cloud.workspace.create")
        return {
          workspace_id: "0195A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B",
          computer_id: "c1",
          open_url: "https://caveman.example/code/",
        };
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
    engines,
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
  } as unknown as RuntimeContextValue;
  const router = createHashRouter(
    [
      { path: "new", Component: () => null },
      { path: "cloud/start", Component: CloudStartRoute },
    ],
    { window: win as unknown as Window },
  );
  await render(
    createElement(RuntimeFixture, {
      value,
      children: createElement(TooltipProvider, null, createElement(RouterProvider, { router })),
    }),
  );
  await settle(6);
  await act(
    async () =>
      void (await router.navigate("/cloud/start", {
        state: { project_id: "p1", text: "Fix the flaky login test", engine: "claude-agent" },
      })),
  );
  await settle(6);
  return { calls, router };
}

afterEach(() => {
  localStorage.clear();
  resetCloudOffer();
  forgetConnects();
});

test("the first Cloud chat shows the offer beside the start, and the message goes without an answer", async () => {
  page.reset("#/new");
  page.opened.length = 0;
  const { calls, router } = await desk([claude]);
  expect(document.body.textContent).toContain(TITLE);
  expect(calls.filter((c) => c.method === "cloud.workspace.create")).toHaveLength(1);
  expect(page.opened).toHaveLength(1);
  expect(calls.some((c) => c.method === "engine.account.add")).toBe(false);
  router.dispose();
});

test("Yes on the offer starts the approval and the offer does not come back on the next Cloud chat", async () => {
  page.reset("#/new");
  page.opened.length = 0;
  const first = await desk([claude]);
  await click(buttons(document.body, "Yes")[0]);
  expect(first.calls.find((c) => c.method === "engine.account.add")?.params).toMatchObject({
    engine: "claude-agent",
    everywhere: true,
  });
  first.router.dispose();
  resetCloudOffer();
  const next = await desk([claude]);
  expect(document.body.textContent).not.toContain(TITLE);
  next.router.dispose();
});

test("a Cloud chat where there is no plan login to carry over shows no offer", async () => {
  page.reset("#/new");
  page.opened.length = 0;
  const { router } = await desk([]);
  expect(document.body.textContent).not.toContain("here too?");
  router.dispose();
});
