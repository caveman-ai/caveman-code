// The one quiet sync offer through the real component (components/SyncOffer.tsx): it says its one line, turning on
// writes the answer the sync dialog writes, dismissing writes the refusal, either is remembered for good, and it never
// shows in the first session, while a chat runs, or beside the sync dialog.
import { buttons, click, container, settle } from "../lib/dom.test-support.ts";
import type { CloudStatus } from "@caveman-app/session-protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { RuntimeFixture, type RuntimeContextValue } from "../state/runtime.tsx";
import { closeSyncAsk, openSyncAsk, resetSyncAsk } from "../state/sync-ask.ts";
import { resetSyncOffer } from "../state/sync-offer.ts";
import { SYNC_OFFER_TEXT, SyncOffer } from "./SyncOffer.tsx";

const KEY = "caveman.syncOffer";
const ASK = {
  state: "connected",
  sync: { available: true, on: false, ask: true },
} as unknown as CloudStatus;

interface Mount {
  readonly status?: CloudStatus;
  readonly workspaces?: ReadonlyArray<{ id: string; state: string; parentId?: string | null }>;
  readonly settings?: Record<string, unknown>;
}

async function mountOffer({ status = ASK, workspaces = [], settings = {} }: Mount = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    call: (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return Promise.resolve(method === "cloud.status" ? status : {});
    },
    on: () => () => undefined,
  };
  const views = workspaces.map((w) => ({ parentId: null, ...w }));
  const value = {
    status: "connected",
    client,
    connection: 1,
    settings,
    engines: [],
    workspaces: views,
    projects: [],
    raw: new Map(),
    refresh: async () => undefined,
  } as unknown as RuntimeContextValue;
  const host = container();
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(RuntimeFixture, {
        value,
        children: createElement(SyncOffer, { today: "2026-11-21" }),
      }),
    ),
  );
  await settle();
  return {
    calls,
    text: () => host.textContent ?? "",
    host,
    unmount: () => act(async () => root.unmount()),
  };
}

const chats = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `ws-${i}`, state: "completed" }));
const saved = () =>
  JSON.parse(localStorage.getItem(KEY) ?? "null") as {
    firstDay: string;
    chats: number;
    answer: string | null;
  } | null;
/** A device that has been here before this launch. */
const returning = (firstDay = "2026-11-20", chatsSeen = 0) => {
  localStorage.setItem(KEY, JSON.stringify({ firstDay, chats: chatsSeen, answer: null }));
  resetSyncOffer();
};

afterEach(() => {
  localStorage.clear();
  resetSyncOffer();
  resetSyncAsk();
});

test("the second day shows the one line, with turn on and dismiss, and writes nothing by itself", async () => {
  returning();
  const offer = await mountOffer();
  expect(offer.text()).toContain(SYNC_OFFER_TEXT);
  expect(SYNC_OFFER_TEXT).toBe("See your chats on your phone and the web: turn on sync.");
  expect(buttons(offer.host, "Turn on sync")).toHaveLength(1);
  expect(buttons(offer.host, "Dismiss")).toHaveLength(1);
  expect(offer.calls.filter((c) => c.method === "settings.set")).toEqual([]);
  await offer.unmount();
});

test("the first session never shows it, even with three chats; the next launch does", async () => {
  const first = await mountOffer({ workspaces: chats(5) });
  expect(first.text()).toBe("");
  expect(saved()).toMatchObject({ chats: 5, answer: null });
  await first.unmount();
  // The next launch: the device is known, and the third chat has been seen.
  resetSyncOffer();
  const next = await mountOffer({ workspaces: chats(5) });
  expect(next.text()).toContain(SYNC_OFFER_TEXT);
  await next.unmount();
});

test("the third chat settles a person on the first day, after the first session", async () => {
  returning("2026-11-21");
  const two = await mountOffer({ workspaces: chats(2) });
  expect(two.text()).toBe("");
  await two.unmount();
  const three = await mountOffer({ workspaces: chats(3) });
  expect(three.text()).toContain(SYNC_OFFER_TEXT);
  await three.unmount();
});

test("turn on writes the sync dialog's answer, and the line never comes again", async () => {
  returning();
  const offer = await mountOffer();
  await click(buttons(offer.host, "Turn on sync")[0]);
  expect(offer.calls.find((c) => c.method === "settings.set")?.params.settings).toEqual({
    sync_chats: true,
    remote_control: true,
  });
  expect(saved()?.answer).toBe("on");
  expect(offer.text()).toBe("");
  await offer.unmount();
  resetSyncOffer();
  const next = await mountOffer();
  expect(next.text()).toBe("");
  await next.unmount();
});

test("dismiss writes the refusal the Settings switch writes, and the line never comes again", async () => {
  returning();
  const offer = await mountOffer();
  await click(buttons(offer.host, "Dismiss")[0]);
  expect(offer.calls.find((c) => c.method === "settings.set")?.params.settings).toEqual({
    sync_chats: false,
    remote_control: false,
  });
  expect(saved()?.answer).toBe("off");
  expect(offer.text()).toBe("");
  await offer.unmount();
  resetSyncOffer();
  const next = await mountOffer();
  expect(next.text()).toBe("");
  await next.unmount();
});

test("never while a chat is running; it is there once the chat is done", async () => {
  returning();
  const busy = await mountOffer({ workspaces: [{ id: "ws-1", state: "working" }] });
  expect(busy.text()).toBe("");
  await busy.unmount();
  const idle = await mountOffer({ workspaces: [{ id: "ws-1", state: "completed" }] });
  expect(idle.text()).toContain(SYNC_OFFER_TEXT);
  await idle.unmount();
});

test("never where sync was answered anywhere: the setting, or a Caveman that no longer asks", async () => {
  returning();
  const set = await mountOffer({ settings: { sync_chats: false } });
  expect(set.text()).toBe("");
  await set.unmount();
  const answered = await mountOffer({
    status: { state: "connected", sync: { available: true, on: true } } as unknown as CloudStatus,
  });
  expect(answered.text()).toBe("");
  await answered.unmount();
});

test("never beside the sync dialog: it waits while Getting started's step has it open", async () => {
  returning();
  openSyncAsk();
  const offer = await mountOffer();
  expect(offer.text()).toBe("");
  await act(async () => closeSyncAsk());
  expect(offer.text()).toContain(SYNC_OFFER_TEXT);
  await offer.unmount();
});
