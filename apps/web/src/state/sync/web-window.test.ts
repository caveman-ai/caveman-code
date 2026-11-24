// A browser window Caveman Cloud serves has no runtime of its own (web-window.ts): its sidebar is Cloud's list of every
// chat, an open chat rides the pool and follows its computer across a wake, and nothing here wakes a computer but a
// send. The hub, the list and the feeds are the real ones; Cloud and the runtimes behind the relay are the fakes.
import type { SessionEvent } from "@caveman-app/session-protocol";
import type { ConnectionState } from "@caveman-app/session-protocol/client";
import { afterEach, expect, test } from "vitest";
import type { CloudRuntime } from "../cloud.ts";
import type { ChatListSnapshot } from "./chat-list.ts";
import { mergeChats } from "./chats-view.ts";
import {
  fakeCloud,
  fakeRuntimeClient,
  idbOrderedKv,
  runtime,
  summary,
  until,
} from "./fakes.test-support.ts";
import { SyncHub } from "./hub.ts";
import { memoryKv } from "./kv.ts";
import { sourceLine } from "./lines.ts";
import { onlyPage } from "./pages.ts";
import {
  asCloudRuntime,
  chatPlaces,
  CLOUD_OFF_LINE,
  followed,
  MAC_HERE_LINE,
  quietHome,
  waitLine,
  webWindow,
} from "./web-window.ts";
import type { RuntimeState } from "./wire.ts";

const hubs: SyncHub[] = [];
afterEach(() => {
  for (const h of hubs.splice(0)) h.stop();
});

/** A web window: no runtime of its own, Cloud's list, and fake runtimes behind the relay's pool. */
const webWindowOn = (
  cloud: ReturnType<typeof fakeCloud>,
  runtimes: Record<string, ReturnType<typeof fakeRuntimeClient>>,
) => {
  const opened: string[] = [];
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: idbOrderedKv(memoryKv()),
    home: () => ({ runtimeId: null, client: null }),
    endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "" }),
    connect: ((url: string, _token: unknown, onState?: (s: ConnectionState) => void) => {
      const id = url.split("/").pop()!;
      opened.push(id);
      queueMicrotask(() => onState?.("open"));
      return runtimes[id]!.client;
    }) as never,
  });
  hubs.push(hub);
  hub.start();
  return { hub, opened };
};
const view = () => {
  const shown: number[] = [];
  return {
    shown,
    sink: {
      reset: () => void (shown.length = 0),
      apply: (e: SessionEvent) => void shown.push(e.cursor),
    },
  };
};
const list = (runtimes: RuntimeState[]): Pick<ChatListSnapshot, "runtimes"> => ({
  runtimes: new Map(runtimes.map((r) => [r.runtime_id, r])),
});
const never = () => false;
const always = () => true;

test("a web window with no runtime of its own lists every chat from Cloud, on a Mac and in Cloud, one row each", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-studio", { kind: "laptop", name: "Studio", computer_id: "c-studio" }));
  cloud.runtime(runtime("rt-web", { name: "acme-web", computer_id: "c-web" }));
  cloud.runtime(
    runtime("rt-api", {
      name: "acme-api",
      computer_id: "c-api",
      online: false,
      computer_state: "suspended",
    }),
  );
  cloud.put(
    summary("s-mac", {
      runtime_id: "rt-studio",
      computer_id: "c-studio",
      where: { kind: "laptop", name: "Studio" },
      repo: "acme/web",
    }),
  );
  cloud.put(
    summary("s-web", {
      runtime_id: "rt-web",
      computer_id: "c-web",
      where: { kind: "cloud", name: "acme-web" },
      repo: "acme/web",
    }),
  );
  cloud.put(
    summary("s-api", {
      runtime_id: "rt-api",
      computer_id: "c-api",
      where: { kind: "cloud", name: "acme-api" },
      repo: "acme/api",
    }),
  );
  // The Chief, a setup chat and an automation's have their own pages.
  cloud.put(
    summary("s-chief", { runtime_id: "rt-studio", computer_id: "c-studio", kind: "chief" }),
  );
  const { hub, opened } = webWindowOn(cloud, {});
  await until(() => hub.list?.get().chats.size === 4);
  const rows = mergeChats([], hub.list!.get(), hub.homeRuntimeId());
  expect(rows.map((r) => [r.sessionId, r.computer.kind, r.synced?.where.kind, r.asleep])).toEqual([
    ["s-mac", "laptop", "laptop", false],
    ["s-web", "caveman_cloud", "cloud", false],
    ["s-api", "caveman_cloud", "cloud", true],
  ]);
  // Every row is read through the hub: there is no runtime here to read it from.
  expect(rows.every((r) => r.synced?.remote === true && hub.throughHub(r.sessionId!))).toBe(true);
  // Listing them opened no connection and woke nothing.
  expect(opened).toEqual([]);
  expect(cloud.wakeHints).toEqual([]);
  expect(cloud.resumes).toEqual([]);
});

test("opening a chat connects through the pool, and it follows its computer across a wake to the runtime it woke as", async () => {
  const cloud = fakeCloud();
  const first = fakeRuntimeClient();
  const woken = fakeRuntimeClient();
  cloud.runtime(runtime("rt-1", { computer_id: "c-web", seq: 1 }));
  cloud.put(
    summary("s1", { runtime_id: "rt-1", computer_id: "c-web", head: 2, synced_through: 2 }),
  );
  first.append("s1");
  first.append("s1");
  cloud.copy("s1", 1, first.journal("s1").events.slice());
  const { hub, opened } = webWindowOn(cloud, { "rt-1": first, "rt-2": woken });
  await until(() => hub.summary("s1") !== undefined);
  const v = view();
  const states: string[] = [];
  hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
  await until(() => v.shown.length === 2);
  expect(opened).toEqual(["rt-1"]);

  // It falls asleep: read from Cloud's copy, and the chat says so. Nothing is woken for the open chat.
  cloud.runtime(
    runtime("rt-1", { computer_id: "c-web", online: false, computer_state: "suspended", seq: 2 }),
  );
  await until(() => states.at(-1) === "copy");
  const where = mergeChats([], hub.list!.get(), null)[0]!.synced!.where;
  expect(sourceLine({ kind: "copy", through: 2 }, where)).toBe("Asleep. Sending wakes it.");
  expect(cloud.wakeHints).toEqual([]);

  // Cloud wakes it under a new runtime id (CONTRACT 5.3): the open chat carries on there, and so does its next send.
  for (const e of first.journal("s1").events) woken.journal("s1").events.push(e);
  woken.append("s1");
  cloud.runtime(runtime("rt-2", { computer_id: "c-web", seq: 3 }));
  await until(() => v.shown.length === 3);
  expect(v.shown).toEqual([1, 2, 3]);
  expect(opened).toEqual(["rt-1", "rt-2"]);
  await hub.clientFor("s1").call("turn.submit", {
    request_id: "r1",
    session_id: "s1",
    kind: "followup",
    input: { text: "go on" },
    options: {},
  } as never);
  expect(woken.calls.map((c) => c.method)).toEqual(["turn.submit"]);
  expect(cloud.posted).toEqual([]);
});

test("a send to a chat whose place is asleep wakes it once, and the chat then says it is waking", async () => {
  const cloud = fakeCloud();
  cloud.runtime(
    runtime("rt-1", { computer_id: "c-web", online: false, computer_state: "suspended" }),
  );
  cloud.put(summary("s1", { runtime_id: "rt-1", computer_id: "c-web" }));
  const { hub, opened } = webWindowOn(cloud, {});
  await until(() => hub.summary("s1") !== undefined);
  hub.openFeed("s1", view().sink, () => undefined);
  await hub.clientFor("s1").call("turn.submit", {
    request_id: "r1",
    session_id: "s1",
    kind: "followup",
    input: { text: "go on" },
    options: {},
  } as never);
  // One call in Cloud's queue, which wakes the computer for it; no hint beside, no connection tried.
  expect(cloud.queued()).toEqual(["s1/r1"]);
  expect(cloud.wakeHints).toEqual([]);
  expect(cloud.resumes).toEqual([]);
  expect(opened).toEqual([]);
  const queued = hub.queuedCalls("s1");
  expect(queued.map((q) => q.call.status)).toEqual(["queued"]);
  // Since when it wakes, for the line's seconds.
  expect(hub.wakingSince("s1")).toBe(Date.parse(queued[0]!.call.created_at));
  expect(waitLine("Waking Cloud", 1_000, 5_400)).toBe("Waking Cloud… 4s");
});

test("the runtime a web window quietly uses: a Mac that let this browser in, else a running Cloud computer, else none", () => {
  const studio = runtime("rt-studio", {
    kind: "laptop",
    name: "Studio",
    last_seen_at: "2026-11-10T10:00:00.000Z",
  });
  const web = runtime("rt-web", { computer_id: "c-web", last_seen_at: "2026-11-10T09:00:00.000Z" });
  const api = runtime("rt-api", { computer_id: "c-api", last_seen_at: "2026-11-10T11:00:00.000Z" });
  // A Mac that has not allowed this browser is never used by itself: it asks when one of its chats is opened.
  expect(quietHome(list([studio, web]), null, never)).toBe("rt-web");
  expect(quietHome(list([studio, web]), null, always)).toBe("rt-studio");
  // The one it has stays while it is on line; a Mac that comes back does not take the window over.
  expect(quietHome(list([studio, web, api]), "rt-web", always)).toBe("rt-web");
  expect(quietHome(list([studio, { ...web, online: false }, api]), "rt-web", never)).toBe("rt-api");
  // Asleep, deleted or refused by the relay: never one of those, so nothing is woken for the window.
  expect(
    quietHome(list([{ ...web, online: false, computer_state: "suspended" }]), "rt-web", always),
  ).toBeNull();
  expect(quietHome(list([{ ...web, computer_state: "deleted" }]), null, always)).toBeNull();
  expect(quietHome(list([web, api]), null, always, new Set(["rt-api"]))).toBe("rt-web");
  // A Cloud computer that woke under a new id: its newest runtime on line, never the one it left.
  const woken = runtime("rt-web-2", {
    computer_id: "c-web",
    seq: 9,
    last_seen_at: "2026-11-10T12:00:00.000Z",
  });
  expect(quietHome(list([{ ...web, seq: 3 }, woken]), null, never)).toBe("rt-web-2");
  expect(quietHome(list([]), null, always)).toBeNull();
  expect(quietHome(null, "rt-web", always)).toBeNull();
});

test("a window put on a Cloud computer follows it to the runtime it woke as; a Mac's runtime is its enrolment", () => {
  const chosen: CloudRuntime = {
    id: "rt-1",
    name: "acme-web",
    computer_id: "c-web",
    computer_name: "acme-web",
    computer_driver: "boat",
    last_seen_at: null,
  };
  const asleep = runtime("rt-1", { computer_id: "c-web", online: false, seq: 4 });
  const woken = runtime("rt-2", { computer_id: "c-web", seq: 5, name: "acme-web" });
  expect(followed(chosen, list([asleep]))).toBeUndefined();
  expect(followed(chosen, list([asleep, woken]))).toMatchObject({
    id: "rt-2",
    computer_id: "c-web",
    computer_driver: "boat",
  });
  expect(followed({ ...chosen, id: "rt-2" }, list([asleep, woken]))).toBeUndefined();
  const mac = asCloudRuntime(
    runtime("rt-studio", { kind: "laptop", name: "Studio", computer_id: "c-studio" }),
  );
  expect(mac).toMatchObject({ id: "rt-studio", name: "Studio", computer_driver: "local" });
  expect(
    followed(mac, list([runtime("rt-other", { kind: "laptop", computer_id: "c-studio" })])),
  ).toBeUndefined();
});

test("where a new chat can run: Cloud, or a Mac that is on line by its name; with neither, one sentence each on what to do", () => {
  const studio = runtime("rt-studio", { kind: "laptop", name: "Studio", computer_id: "c-studio" });
  const air = runtime("rt-air", {
    kind: "laptop",
    name: "Air",
    computer_id: "c-air",
    online: false,
  });
  const box = runtime("rt-web", { name: "acme-web" });
  // A Cloud computer is never a place by name: Cloud is one place.
  expect(chatPlaces(list([studio, air, box]), true)).toEqual({
    places: [
      { kind: "cloud", name: "Cloud" },
      { kind: "mac", name: "Studio", runtimeId: "rt-studio", computerId: "c-studio" },
    ],
    cloud: "on",
    lines: [],
  });
  expect(chatPlaces(list([air]), true).places).toEqual([{ kind: "cloud", name: "Cloud" }]);
  // Cloud off for the organization, a Mac on line: the Mac alone, and nothing to explain.
  expect(chatPlaces(list([studio]), false)).toMatchObject({
    places: [{ kind: "mac", name: "Studio" }],
    cloud: "off",
    lines: [],
  });
  // Cloud off and no Mac on line: it says so, and what to do.
  expect(chatPlaces(list([air]), false)).toEqual({
    places: [],
    cloud: "off",
    lines: [CLOUD_OFF_LINE, MAC_HERE_LINE],
  });
  expect(CLOUD_OFF_LINE).toBe("Cloud is off. Ask your admin.");
  expect(MAC_HERE_LINE).toBe(
    "To use your Mac here, turn on Settings > Remote control in Caveman Code on it.",
  );
  // Until Cloud has said, nothing is claimed either way.
  expect(chatPlaces(null, null)).toEqual({ places: [], cloud: null, lines: [] });
});

test("what the window shows: signed out, loading, nothing yet, and a list that cannot load over what it last had", () => {
  const chats = (size: number) => ({ size });
  expect(webWindow(null, null)).toEqual({ kind: "loading" });
  expect(webWindow(false, null)).toEqual({ kind: "signed_out" });
  // Cloud ended the sign-in while the window was open.
  expect(webWindow(true, { status: "signed_out", ready: true, chats: chats(3) })).toEqual({
    kind: "signed_out",
  });
  expect(webWindow(true, null)).toEqual({ kind: "loading" });
  expect(webWindow(true, { status: "loading", ready: false, chats: chats(0) })).toEqual({
    kind: "loading",
  });
  // A first visit: no chat anywhere.
  expect(webWindow(true, { status: "live", ready: true, chats: chats(0) })).toEqual({
    kind: "app",
    failed: false,
    nothingYet: true,
  });
  expect(webWindow(true, { status: "live", ready: true, chats: chats(2) })).toEqual({
    kind: "app",
    failed: false,
    nothingYet: false,
  });
  // Cloud cannot be reached: the app stays, on what this device kept, and says it is trying again.
  expect(webWindow(true, { status: "reconnecting", ready: true, chats: chats(2) })).toEqual({
    kind: "app",
    failed: true,
    nothingYet: false,
  });
  expect(webWindow(true, { status: "reconnecting", ready: false, chats: chats(0) })).toEqual({
    kind: "app",
    failed: true,
    nothingYet: false,
  });
});

test("a list that cannot load is asked for again by itself, and the window says so meanwhile", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("s1"));
  cloud.setDown(true);
  const { hub } = webWindowOn(cloud, {});
  await until(() => hub.list?.get().status === "reconnecting");
  expect(webWindow(true, hub.list!.get())).toEqual({
    kind: "app",
    failed: true,
    nothingYet: false,
  });
  // Cloud is back: nobody pressed anything.
  cloud.setDown(false);
  await until(() => hub.list?.get().status === "live", 10_000);
  expect(webWindow(true, hub.list!.get())).toEqual({
    kind: "app",
    failed: false,
    nothingYet: false,
  });
  expect(cloud.lists()).toBeGreaterThanOrEqual(1);
});

test("a chat in Cloud that Cloud names no runtime for is asleep: its computer's runtime ended with its sleep", async () => {
  const cloud = fakeCloud();
  // The computer slept: its runtime is gone from Cloud's list, and the chat's row names none (or the one that ended).
  cloud.put(
    summary("s-none", {
      runtime_id: null as unknown as string,
      computer_id: "c-web",
      where: { kind: "cloud", name: "acme-web" },
    }),
  );
  cloud.put(
    summary("s-ended", {
      runtime_id: "rt-ended",
      computer_id: "c-web",
      where: { kind: "cloud", name: "acme-web" },
    }),
  );
  // A Mac that is off line is not "asleep" in Cloud's sense: its line says the Mac is asleep, by name.
  cloud.put(
    summary("s-mac", {
      runtime_id: "rt-off",
      computer_id: "c-studio",
      where: { kind: "laptop", name: "Studio" },
    }),
  );
  const { hub, opened } = webWindowOn(cloud, {});
  await until(() => hub.list?.get().chats.size === 3);
  const rows = mergeChats([], hub.list!.get(), hub.homeRuntimeId());
  expect(Object.fromEntries(rows.map((r) => [r.sessionId, r.asleep]))).toEqual({
    "s-none": true,
    "s-ended": true,
    "s-mac": false,
  });
  // Its chat says so in one line, with no machine's name in it.
  expect(
    sourceLine(
      { kind: "copy", through: 2 },
      rows.find((r) => r.sessionId === "s-none")!.synced!.where,
    ),
  ).toBe("Asleep. Sending wakes it.");
  expect(opened).toEqual([]);
  expect(cloud.wakeHints).toEqual([]);
});
