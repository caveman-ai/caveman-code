// The sync prompt through the real component (components/SyncPrompt.tsx): Turn on sync that the runtime refuses says
// why in the dialog and can be pressed again, and Not now writes nothing and closes it. It never opens by itself, in any
// session: these tests open it the way Getting started's step does.
import { alerts, buttons, click, container, settle } from "../lib/dom.test-support.ts";
import { ErrorCodes, type CloudStatus } from "@caveman-app/session-protocol";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { openSyncAsk, resetSyncAsk } from "../state/sync-ask.ts";
import { SyncPrompt } from "./SyncPrompt.tsx";

const ASK = { state: "connected", sync: { available: true, on: false, ask: true } } as CloudStatus;

/** `opened`: Getting started's step opened it; otherwise nothing asked for it. */
async function mountPrompt(refuses: string | null, opened = true) {
  resetSyncAsk();
  if (opened) openSyncAsk();
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "cloud.status") return Promise.resolve(ASK);
      if (method === "settings.set" && refuses !== null)
        return Promise.reject(
          new SessionProtocolError({
            code: ErrorCodes.invalid_state,
            message: refuses,
            data: { reason: "invalid_state" },
          }),
        );
      return Promise.resolve({});
    },
    on: () => () => undefined,
  };
  const value = {
    status: "connected",
    client,
    connection: 1,
    settings: null,
    engines: [],
    workspaces: [],
    projects: [],
    raw: new Map(),
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const host = container();
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(RuntimeFixture, { value, children: createElement(SyncPrompt) })),
  );
  await settle();
  return { calls, unmount: () => act(async () => root.unmount()) };
}

afterEach(() => {
  localStorage.clear();
  resetSyncAsk();
});

test("Turn on sync that the runtime refuses says why in the dialog, and can be pressed again", async () => {
  const why = "settings could not be saved";
  const prompt = await mountPrompt(why);
  expect(document.body.textContent).toContain("Your chats on every device");
  await click(buttons(document.body, "Turn on sync")[0]);
  expect(prompt.calls.find((c) => c.method === "settings.set")?.params).toMatchObject({
    settings: { sync_chats: true, remote_control: true },
  });
  expect(alerts(document.body)).toContain(why);
  expect(buttons(document.body, "Turn on sync")[0]!.disabled).toBe(false);
  await prompt.unmount();
});

test("nothing opens it by itself, whatever the launch or the first run's flag; Getting started's step does", async () => {
  // No first-run flag was ever written here (routes/FirstRun.tsx skips the first run where chats exist).
  expect(localStorage.getItem("caveman.firstRunDone")).toBeNull();
  const quiet = await mountPrompt(null, false);
  expect(document.body.textContent).not.toContain("Your chats on every device");
  expect(quiet.calls.some((c) => c.method === "settings.set")).toBe(false);
  expect(localStorage.getItem("caveman.syncAsk")).toBeNull();
  // The person asks for it (Getting started's step): it shows.
  await act(async () => openSyncAsk());
  expect(document.body.textContent).toContain("Your chats on every device");
  await quiet.unmount();
});

test("Not now writes no setting and closes the dialog; the step stays in Getting started", async () => {
  const prompt = await mountPrompt(null);
  await click(buttons(document.body, "Not now")[0]);
  expect(prompt.calls.some((c) => c.method === "settings.set")).toBe(false);
  expect(document.body.textContent).not.toContain("Your chats on every device");
  expect(localStorage.getItem("caveman.syncAsk")).toBeNull();
  await prompt.unmount();
});
