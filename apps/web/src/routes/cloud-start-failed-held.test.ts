// A Cloud start whose first workspace.create failed is the only copy of the task the person typed until they try it
// again or discard it (PendingCloudStart). The Cloud-hosted client names it on whichever computer the tab is on, and
// no other start in Cloud (the front door's New, Review's Ask) takes its place.
import { buttons, click, render, settle } from "./dom.test-support.ts";
import type { PrDetail } from "@caveman-app/session-protocol";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../state/runtime.tsx", async (real) => ({
  ...(await real<object>()),
  CLOUD_HOSTED: true,
}));

import { PendingCloudStart } from "../shell/PendingCloudStart.tsx";
import {
  chooseRuntime,
  chosenRuntime,
  clearPendingStart,
  holdPendingStart,
  pendingStart,
  startCloudComputer,
  type CloudRuntime,
} from "../state/cloud.ts";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { useSpawnAgent } from "./review/Ask.tsx";

const task =
  "Refactor the billing webhook so retries are idempotent, then add tests for the duplicate-event path and update the runbook.";

afterEach(() => {
  clearPendingStart(sessionStorage);
  chooseRuntime(localStorage, null);
  vi.unstubAllGlobals();
});

const runtime = (n: number): CloudRuntime => ({
  id: `rt_${n}`,
  name: `Cloud ${n}`,
  computer_id: `cmp_${n}`,
  computer_name: `Cloud ${n}`,
  computer_driver: "kubernetes",
  last_seen_at: new Date().toISOString(),
});
const computer = (n: number) => ({
  id: `cmp_${n}`,
  name: `Cloud ${n}`,
  driver: "kubernetes",
  size: "4cpu-16gb",
  desired_state: "running",
  observed_state: "running",
  observed_reason: "",
  updated_at: new Date().toISOString(),
});

/** The page connected to the runtime this tab chose, whose workspace.create answers with `create`; `children` beside PendingCloudStart. */
function page(create: () => Promise<unknown>, ...children: Parameters<typeof createElement>[0][]) {
  const client = {
    call: (method: string) => {
      if (method === "workspace.create") return create();
      if (method === "cloud.status")
        return Promise.resolve({ capabilities: { pull_requests: false, compression: false } });
      return Promise.resolve({});
    },
    on: () => () => undefined,
  };
  const engines = [
    {
      id: "caveman",
      label: "Caveman",
      capabilities: {},
      access_modes: ["auto"],
      auth: { state: "api_key", accounts: [] },
      models: [],
    },
  ];
  const value = {
    client,
    connection: 1,
    status: "connected",
    error: null,
    identity: {},
    workspaces: [],
    raw: new Map(),
    projects: [],
    engines,
    settings: { default_engine: "caveman", engines: {}, model_defaults: {} },
    refresh: async () => undefined,
    markSeen: () => undefined,
  } as unknown as RuntimeContextValue;
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(
          TooltipProvider,
          null,
          createElement(PendingCloudStart),
          ...children.map((c, i) => createElement(c as never, { key: i })),
        ),
      }),
    ),
  );
}

/** The person's task, started on a new Cloud computer (cmp_1), whose first workspace.create there was refused. */
async function failedOnCloud1() {
  holdPendingStart(sessionStorage, {
    computer_id: "cmp_1",
    repo: "acme/billing",
    engine: "caveman",
    task,
  });
  chooseRuntime(localStorage, runtime(1));
  const shown = await page(() => Promise.reject(new Error("The clone was refused.")));
  await settle(2);
  expect(pendingStart(sessionStorage)).toMatchObject({ task, failed: "The clone was refused." });
  await shown.unmount();
}

/** Cloud on this origin: the person's computers and runtimes, and every new Cloud workspace asked for (`made`). */
function cloud() {
  const made: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/code/runtimes")
      return Response.json({ runtimes: [runtime(1), runtime(2)] });
    if (url.startsWith("/api/v1/code/computers"))
      return Response.json({ cloud_computers: true, computers: [computer(1), computer(2)] });
    if (url === "/api/v1/code/workspaces" && init?.method === "POST") {
      made.push(JSON.parse(String(init.body)));
      return Response.json({ id: "cw_9", computer_id: "cmp_9" });
    }
    return Response.json({ error: { message: "not here" } }, { status: 404 });
  });
  return made;
}

const failedAlert = () =>
  [...document.querySelectorAll("[role='alert']")].find((a) =>
    a.textContent?.includes("acme/billing didn't start"),
  );

test("a new start in Cloud from another computer makes nothing over a failed start's task, and says why", async () => {
  await failedOnCloud1();
  // The person opened another computer and started the next chat in Cloud from there.
  const made = cloud();
  chooseRuntime(localStorage, runtime(2));

  await expect(startCloudComputer("acme/status", sessionStorage)).rejects.toThrow(
    "Your chat on acme/billing didn't start. Try it again or discard it first.",
  );

  expect(made, "a place in Cloud made over the failed start").toEqual([]);
  expect(pendingStart(sessionStorage)).toMatchObject({
    computer_id: "cmp_1",
    task,
    failed: "The clone was refused.",
  });
});

test("a failed Cloud start is named on whichever computer the tab is on, opens its computer, where Try again is", async () => {
  await failedOnCloud1();
  cloud();
  chooseRuntime(localStorage, runtime(2));
  await page(() => new Promise(() => undefined));
  await settle(3);
  expect(failedAlert()?.textContent ?? "", "the failed start, named on Cloud 2").toContain(
    "The chat on acme/billing didn't start: The clone was refused.",
  );
  // It names no machine: Open goes to where the start waits.
  expect(failedAlert()?.textContent).not.toContain("Cloud 1");

  await click(buttons(failedAlert()!, "Open")[0]);
  await settle(2);
  expect(chosenRuntime(localStorage)?.computer_id).toBe("cmp_1");
  expect(buttons(document.body, "Try again")).toHaveLength(1);
  expect(pendingStart(sessionStorage)).toMatchObject({ task, failed: "The clone was refused." });
});

test("a failed Cloud start discarded on another computer is gone, and the next start in Cloud is made", async () => {
  await failedOnCloud1();
  const made = cloud();
  chooseRuntime(localStorage, runtime(2));
  const before = await page(() => new Promise(() => undefined));
  await settle(3);
  expect(failedAlert(), "the failed start, named on Cloud 2").toBeDefined();
  await click(buttons(failedAlert()!, "Discard")[0]);
  await settle();
  expect(pendingStart(sessionStorage)).toBeNull();
  expect(failedAlert()).toBeUndefined();
  expect(chosenRuntime(localStorage)?.computer_id).toBe("cmp_2");
  await before.unmount();

  await startCloudComputer("acme/status", sessionStorage);
  expect(made).toHaveLength(1);
  expect(pendingStart(sessionStorage)).toMatchObject({ computer_id: "cmp_9", repo: "acme/status" });
});

test("Review's Ask on a new Cloud computer makes none over a failed start's task", async () => {
  await failedOnCloud1();
  const made = cloud();
  chooseRuntime(localStorage, runtime(2));
  const detail = {
    project_id: "p1",
    repo: "acme/widgets",
    host: "github.com",
    number: 7,
    title: "Bump the parser",
    url: "https://github.com/acme/widgets/pull/7",
    head_branch: "bump",
    base_branch: "main",
  } as PrDetail;
  let spawn: ReturnType<typeof useSpawnAgent>["spawn"] | undefined;
  function Probe() {
    spawn = useSpawnAgent(detail, { kind: "new" }).spawn;
    return null;
  }
  await page(() => new Promise(() => undefined), Probe);
  await settle(2);
  await expect(spawn!("ask", "Why this parser?")).rejects.toThrow(/acme\/billing didn't start/);
  expect(made).toEqual([]);
  expect(pendingStart(sessionStorage)).toMatchObject({
    computer_id: "cmp_1",
    task,
    failed: "The clone was refused.",
  });
});
