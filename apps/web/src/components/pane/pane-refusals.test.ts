import { alerts, buttons, click, container, settle } from "../../lib/dom.test-support.ts";
import { ErrorCodes, type CloudStatus, type Workspace } from "@caveman-app/session-protocol";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../../state/runtime.tsx";
import { PaneFrame } from "./PaneFrame.tsx";

// What the desktop's reportPageErrors would count as a crash.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeAll(() => void process.on("unhandledRejection", onUnhandled));
afterAll(() => void process.off("unhandledRejection", onUnhandled));
beforeEach(() => void (unhandled.length = 0));

const chat = (id: string, over: Partial<Workspace> = {}) =>
  ({
    id,
    session_id: `s_${id}`,
    title: `Chat ${id}`,
    status: "idle",
    engine: "caveman",
    repo: { path: "/Users/me/acme/app" },
    base_ref: "main",
    branch: "main",
    created_at: "2026-11-06T10:00:00Z",
    updated_at: "2026-11-06T10:00:00Z",
    parent_workspace_id: null,
    computer: { id: "mac", kind: "this_mac", label: "This Mac", status: "online" },
    ...over,
  }) as Workspace;

/** A chat's pane on a runtime that refuses `method` with `why`; `cloud` is what cloud.status answers. */
async function mountPane(
  workspace: Workspace,
  method: string,
  why: string,
  cloud: Partial<CloudStatus> = { state: "connected" } as Partial<CloudStatus>,
) {
  const calls: string[] = [];
  const client = {
    call: (m: string) => {
      calls.push(m);
      if (m === method)
        return Promise.reject(
          new SessionProtocolError({
            code: ErrorCodes.invalid_state,
            message: why,
            data: { reason: "invalid_state" },
          }),
        );
      if (m === "queue.list") return Promise.resolve({ turns: [] });
      if (m === "editor.list") return Promise.resolve({ editors: [], reveal: false });
      if (m === "session.move.held") return Promise.resolve({ paths: [] });
      if (m === "cloud.status") return Promise.resolve(cloud);
      if (m === "secret.list") return Promise.resolve({ repository: "acme/app", secrets: [] });
      return Promise.resolve({});
    },
    on: () => () => undefined,
    subscribe: () => () => undefined,
    attach: async (sessionId: string) => ({
      session: { id: sessionId, state: workspace.status === "parked" ? "parked" : "live" },
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
    workspaces: [{ ...workspace, repo: "acme/app", repoRef: workspace.repo, projectId: null }],
    raw: new Map([[workspace.id, workspace]]),
    projects: [],
    engines: [
      { id: "caveman", label: "Caveman", auth: { state: "api_key" }, capabilities: {}, models: [] },
    ],
    settings: null,
    refresh: async () => undefined,
    markSeen: () => undefined,
    adopt: () => undefined,
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
  const fromMenu = async (item: string) => {
    await click(buttons(host, workspace.title)[0]);
    await click(
      [...document.querySelectorAll("[role='menuitem']")].find(
        (b) => b.textContent?.trim() === item,
      ),
    );
    await settle();
  };
  return { host, calls, fromMenu, unmount: () => act(async () => root.unmount()) };
}

const reasons = () => unhandled.map((e) => (e instanceof Error ? e.message : String(e)));

test("Resume on a parked chat that the runtime refuses says why in the pane", async () => {
  const why = "Sign in to Caveman first (Settings, Remote control)";
  const pane = await mountPane(chat("A", { status: "parked" }), "session.resume", why);
  expect(pane.host.textContent).toContain("Asleep");
  await click(buttons(pane.host, "Resume")[0]);
  expect(pane.calls).toContain("session.resume");
  expect.soft(alerts(pane.host)).toContain(why);
  expect.soft(reasons()).toEqual([]);
  await pane.unmount();
});

test("Archive from the title menu that the runtime refuses says why in the pane", async () => {
  const why = "git worktree remove failed: the worktree is locked";
  const pane = await mountPane(chat("B"), "workspace.archive", why);
  await pane.fromMenu("Archive");
  expect(pane.calls).toContain("workspace.archive");
  expect.soft(alerts(pane.host)).toContain(why);
  expect.soft(reasons()).toEqual([]);
  await pane.unmount();
});

test("Restore from the title menu that the runtime refuses says why in the pane", async () => {
  const why = "the project's folder is gone";
  const pane = await mountPane(chat("C", { status: "archived" }), "workspace.restore", why);
  await pane.fromMenu("Restore");
  expect(pane.calls).toContain("workspace.restore");
  expect.soft(alerts(pane.host)).toContain(why);
  expect.soft(reasons()).toEqual([]);
  await pane.unmount();
});

test("an archived chat's title menu offers Restore and no Pin: the runtime takes no pin on it until it is back", async () => {
  const pane = await mountPane(
    chat("F", { status: "archived" }),
    "workspace.inbox",
    "This chat is archived",
  );
  await click(buttons(pane.host, "Chat F")[0]);
  const items = [...document.querySelectorAll("[role='menuitem']")].map((b) =>
    b.textContent?.trim(),
  );
  expect(items).toContain("Restore");
  expect(items.filter((item) => /Pin|Unpin/.test(item ?? ""))).toEqual([]);
  await pane.unmount();
});

test("the lid-move notice's Keep on that the runtime refuses says why, and can be answered again", async () => {
  const why = "settings could not be saved";
  const pane = await mountPane(chat("E"), "settings.set", why, {
    state: "connected",
    moves: "ask",
  } as Partial<CloudStatus>);
  expect(pane.host.textContent).toContain("Moves to Cloud when the lid closes");
  await click(buttons(pane.host, "Keep on")[0]);
  expect(pane.calls).toContain("settings.set");
  expect.soft(alerts(pane.host)).toContain(why);
  expect(buttons(pane.host, "Keep on")[0]!.disabled).toBe(false);
  expect.soft(reasons()).toEqual([]);
  await pane.unmount();
});
