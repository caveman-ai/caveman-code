// The Cloud-hosted client starting the chat New chat (or a confirmed link) asked for on a new Cloud
// computer: the pending start is the task's only copy until a workspace holds it.
import { document } from "./dom.test-support.ts";
import { createElement, Fragment } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import {
  adoptPendingStart,
  chooseRuntime,
  chosenRuntime,
  clearPendingStart,
  holdPendingStart,
  pendingStart,
  startLink,
  type CloudRuntime,
} from "../state/cloud.ts";
import { keptDraft } from "../state/composer-drafts.ts";
import { RuntimeFixture } from "../state/runtime.tsx";
import { CloudWaitLine } from "./CloudWaitLine.tsx";
import { PendingCloudStart } from "./PendingCloudStart.tsx";
import { click, mount, settle } from "./dom.test-support.ts";

const task =
  "Refactor the billing webhook so retries are idempotent, then add tests for the duplicate-event path and update the runbook.";

afterEach(() => {
  clearPendingStart(sessionStorage);
  chooseRuntime(localStorage, null);
  vi.unstubAllGlobals();
});

function Where() {
  return createElement("output", { "data-where": "" }, useLocation().pathname);
}

const runtime = (n: number): CloudRuntime => ({
  id: `rt_${n}`,
  name: `Cloud ${n}`,
  computer_id: `cmp_${n}`,
  computer_name: `Cloud ${n}`,
  computer_driver: "kubernetes",
  last_seen_at: new Date().toISOString(),
});

/** The tab after a start in Cloud: the start held, and the reload onto the new computer's runtime. */
function hold(engine = "caveman") {
  holdPendingStart(sessionStorage, { computer_id: "cmp_1", repo: "acme/billing", engine, task });
  chooseRuntime(localStorage, runtime(1));
}

/** The page, connected to that runtime, whose workspace.create answers with `create`. */
async function open(
  create: (params: Record<string, unknown>) => Promise<unknown>,
  engines: ReadonlyArray<unknown> = [{ id: "caveman", auth: { state: "api_key" } }],
) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    call: (method: string, params: Record<string, unknown>) => {
      if (method !== "workspace.create") return Promise.resolve({});
      calls.push(params);
      return create(params);
    },
    on: () => () => undefined,
  };
  const value = {
    client,
    connection: "open",
    status: "connected",
    workspaces: [],
    projects: [],
    engines,
    settings: {},
    refresh: async () => undefined,
  } as never;
  const view = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(
          Fragment,
          null,
          createElement(PendingCloudStart),
          createElement(Where),
        ),
      }),
    ),
  );
  await settle();
  return { calls, ...view };
}

const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name);

/**
 * The app's wait for a chat started in Cloud (CloudWaitLine, what the front door's wait was), with the window on another
 * computer: Cloud lists the start's computer (cmp_1) and another (cmp_2), both up, and the window is on cmp_2. Answers
 * which computer the window is on after the wait's first look.
 */
async function afterWait(): Promise<string | undefined> {
  chooseRuntime(localStorage, runtime(2));
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
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/v1/code/runtimes")
      return Response.json({ runtimes: [runtime(1), runtime(2)] });
    if (url.startsWith("/api/v1/code/computers"))
      return Response.json({ cloud_computers: true, computers: [computer(1), computer(2)] });
    return Response.json({ error: { message: "not here" } }, { status: 404 });
  });
  const view = await mount(createElement(MemoryRouter, null, createElement(CloudWaitLine)));
  await settle();
  await settle();
  const on = chosenRuntime(localStorage)?.computer_id;
  await view.unmount();
  return on;
}

test("a Cloud start whose first workspace.create fails keeps the task, and Try again runs that same call", async () => {
  let refuse = true;
  hold();
  const { calls, unmount } = await open(() =>
    refuse ? Promise.reject(new Error("The clone was refused.")) : Promise.resolve({ id: "w_1" }),
  );
  expect(calls).toHaveLength(1);
  expect((calls[0]!.task as { text: string }).text).toBe(task);
  expect(document.querySelector("[role='alert']")?.textContent).toContain(
    "The chat didn't start: The clone was refused.",
  );
  // Nothing else holds the task: the dialog cleared its box and the page reloaded onto this computer.
  expect(pendingStart(sessionStorage)?.task).toBe(task);

  refuse = false;
  const again = button("Try again");
  expect(again, "Try again").toBeDefined();
  await click(again!);
  await settle();
  // The same call: had the first made the workspace after all, the runtime answers with it instead of making another.
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(document.querySelector("[data-where]")?.textContent).toBe("/w/w_1");
  expect(pendingStart(sessionStorage)).toBeNull();
  await unmount();
});

test("a reload while the first workspace.create is out asks for that same workspace again, never a second", async () => {
  hold();
  const first = await open(() => new Promise(() => undefined));
  const held = pendingStart(sessionStorage);
  expect(held?.task).toBe(task);
  await first.unmount();
  const reloaded = await open(() => Promise.resolve({ id: "w_1" }));
  expect(reloaded.calls).toHaveLength(1);
  expect(reloaded.calls[0]!.request_id).toBe(first.calls[0]!.request_id);
  expect(document.querySelector("[data-where]")?.textContent).toBe("/w/w_1");
  await reloaded.unmount();
});

test("a failed Cloud start the person discards is gone: a reload sends nothing, and the window waits for no computer", async () => {
  hold();
  const first = await open(() => Promise.reject(new Error("The clone was refused.")));
  const discard = button("Discard");
  expect(discard, "Discard").toBeDefined();
  await click(discard!);
  expect(pendingStart(sessionStorage)).toBeNull();
  expect(document.querySelector("[role='alert']")).toBeNull();
  await first.unmount();

  const reloaded = await open(() => Promise.resolve({ id: "w_1" }));
  expect(reloaded.calls).toEqual([]);
  expect(document.querySelector("[data-where]")?.textContent).toBe("/");
  await reloaded.unmount();
  expect(await afterWait()).toBe("cmp_2");
});

test("a failed Cloud start left as it is waits for the person: a reload asks again and sends nothing, and the window stays where it is", async () => {
  hold();
  const first = await open(() => Promise.reject(new Error("The clone was refused.")));
  await first.unmount();

  const reloaded = await open(() => Promise.resolve({ id: "w_1" }));
  expect(reloaded.calls).toEqual([]);
  expect(document.querySelector("[role='alert']")?.textContent).toContain(
    "The chat didn't start: The clone was refused.",
  );
  expect(pendingStart(sessionStorage)?.task).toBe(task);
  await reloaded.unmount();
  expect(await afterWait()).toBe("cmp_2");

  // A start still on its way is what the window waits for: it goes to that computer by itself.
  holdPendingStart(sessionStorage, {
    computer_id: "cmp_1",
    repo: "acme/billing",
    engine: "caveman",
    task,
  });
  expect(await afterWait()).toBe("cmp_1");
});

test("Try again sends the first call as it was, even when the engine signed in since", async () => {
  hold("claude-agent");
  const signedOut = [{ id: "claude-agent", auth: { state: "signed_out", accounts: [] } }];
  const first = await open(() => Promise.reject(new Error("The relay dropped.")), signedOut);
  // Claude Agent was not signed in on that computer: the task was to wait in the chat's box.
  expect(first.calls[0]!.task).toBeUndefined();
  await first.unmount();

  // The person signed Claude Agent in there, reloaded, and pressed Try again.
  const reloaded = await open(
    () => Promise.resolve({ id: "w_1" }),
    [{ id: "claude-agent", auth: { state: "signed_in", accounts: [] } }],
  );
  await click(button("Try again")!);
  await settle();
  expect(reloaded.calls).toEqual(first.calls);
  expect(keptDraft("chat:w_1")?.text).toBe(task);
  expect(document.querySelector("[data-where]")?.textContent).toBe("/w/w_1");
  await reloaded.unmount();
});

test("a #start link's card shows what Start would run: the engine, its model, effort, speed and mode, the runs and the base branch", async () => {
  // Anyone can send this link: the most expensive model, at its fastest, four times over, from a branch of theirs.
  const link = startLink("https://app.caveman.so/code/", {
    computer_id: "cmp_1",
    repo: "acme/billing",
    base_ref: "release/2.1",
    engine: "claude-agent",
    task,
    runs: 4,
    options: { model: "claude-opus-4-1", effort: "max", speed: "fast", mode: "grill" },
  });
  adoptPendingStart({
    location: { hash: new URL(link).hash, pathname: "/code/", search: "" } as Location,
    history: { replaceState: () => undefined } as unknown as History,
    sessionStorage,
    localStorage,
  });
  chooseRuntime(localStorage, runtime(1));
  const claude = {
    id: "claude-agent",
    label: "Claude Agent",
    auth: { state: "signed_in", accounts: [] },
    models: [
      { id: "claude-opus-4-1", label: "Opus 4.1", efforts: ["high", "max"], speeds: ["fast"] },
    ],
  };
  const { calls, unmount } = await open(() => Promise.resolve({ id: "w_1" }), [claude]);
  onTestFinished(unmount);

  const card = document.querySelector("[role='dialog'][aria-label='Start this chat?']");
  expect(card, "the card").not.toBeNull();
  const rows = Object.fromEntries(
    [...card!.querySelectorAll("dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]),
  );
  // Where it runs is not on the card: that is Cloud, and Cloud names no machine.
  expect(rows).toEqual({
    Repository: "acme/billing",
    Branch: "release/2.1",
    Agent: "Claude Agent",
    Model: "Opus 4.1, max effort, fast speed",
    Mode: "Grill",
    Runs: "4",
    Message: task,
  });
  expect(card!.textContent).not.toContain("Cloud 1");
  expect(calls).toEqual([]);

  // What it said is what runs.
  await click(button("Start")!);
  await settle();
  expect(calls).toHaveLength(4);
  expect(calls[0]).toMatchObject({
    engine: "claude-agent",
    base_ref: "release/2.1",
    options: { model: "claude-opus-4-1", effort: "max", speed: "fast", mode: "grill" },
  });
});

test("a #start link's card for a pull request names neither runs nor a base branch: it starts one chat on the pull request's head", async () => {
  const link = startLink("https://app.caveman.so/code/", {
    computer_id: "cmp_1",
    repo: "acme/billing",
    base_ref: "main",
    engine: "opencode",
    task,
    runs: 2,
    pull_request: 42,
  });
  adoptPendingStart({
    location: { hash: new URL(link).hash, pathname: "/code/", search: "" } as Location,
    history: { replaceState: () => undefined } as unknown as History,
    sessionStorage,
    localStorage,
  });
  chooseRuntime(localStorage, runtime(1));
  // An engine this computer does not list: the card names it as the link does.
  const { calls, unmount } = await open(
    () => Promise.resolve({ id: "w_1" }),
    [{ id: "caveman", auth: { state: "api_key" } }],
  );
  onTestFinished(unmount);

  const card = document.querySelector("[role='dialog'][aria-label='Start this chat?']");
  const rows = Object.fromEntries(
    [...card!.querySelectorAll("dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]),
  );
  expect(rows).toEqual({
    Repository: "acme/billing",
    On: "Pull request #42",
    Agent: "opencode",
    Model: "Default",
    Message: task,
  });

  await click(button("Start")!);
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.base_ref).toBeUndefined();
});

test("a failed Cloud start is named in the app though the window is on no computer, and its task is kept until it is discarded", async () => {
  hold();
  const first = await open(() => Promise.reject(new Error("The clone was refused.")));
  await first.unmount();
  // The person left; the computer went to sleep, and the window let it go: it is on no runtime now. Nothing wakes it.
  chooseRuntime(localStorage, null);
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/v1/code/runtimes") return Response.json({ runtimes: [] });
    return Response.json({ error: { message: "not here" } }, { status: 404 });
  });
  const value = {
    client: null,
    connection: 0,
    status: "unconfigured",
    workspaces: [],
    projects: [],
    engines: [],
    settings: null,
    refresh: async () => undefined,
  } as never;
  const app = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeFixture, {
        value,
        children: createElement(
          Fragment,
          null,
          createElement(PendingCloudStart),
          createElement(CloudWaitLine),
        ),
      }),
    ),
  );
  await settle();
  await settle();
  const alert = [...document.querySelectorAll("[role='alert']")].find((a) =>
    a.textContent?.includes("didn't start"),
  );
  expect(alert?.textContent).toContain(
    "The chat on acme/billing didn't start: The clone was refused.",
  );
  // The machine it waits on is never named.
  expect(alert?.textContent).not.toContain("Cloud 1");
  expect(pendingStart(sessionStorage)?.task).toBe(task);
  // A failed start waits for the person, never for a computer: the window asked Cloud to wake nothing.
  expect(asked.filter((a) => a.startsWith("POST"))).toEqual([]);

  await click(button("Discard")!);
  await settle();
  expect(pendingStart(sessionStorage)).toBeNull();
  expect(
    [...document.querySelectorAll("[role='alert']")].some((a) =>
      a.textContent?.includes("didn't start"),
    ),
  ).toBe(false);
  await app.unmount();
});
