// A web tab Cloud serves: the window's own runtime client keeps its unanswered calls in this device's store, so a send
// made just before a reload goes out after it, however the computer was picked. A Cloud computer's wait under its
// computer id, as its runtime id changes at every wake; a Mac's under its runtime id (sync/outbox.ts runtimeOutbox).
// The real RuntimeProvider, SyncHub, Session Protocol client and outbox; only the socket, Cloud's /api/v1/auth/me and
// /api/v1/code/runtimes, and IndexedDB are fakes.
import type { Client } from "@caveman-app/session-protocol/client";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";
import type { Kv } from "./sync/kv.ts";

// IndexedDB outlives a reload: one device store for every page life.
const device = vi.hoisted(() => ({
  kv: null as null | (Kv & { data: Map<string, unknown> }),
  scans: [] as string[],
}));
vi.mock("./sync/kv.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sync/kv.ts")>();
  const { idbOrderedKv } = await import("./sync/fakes.test-support.ts");
  return {
    ...real,
    indexedDbKv: () => {
      if (device.kv) return device.kv;
      const kv = real.memoryKv();
      const scan = kv.scan.bind(kv);
      // Which outbox each client loads: the prefixes it scans.
      kv.scan = ((prefix: string) => (device.scans.push(prefix), scan(prefix))) as typeof kv.scan;
      // Each read and write applied as IndexedDB applies it: a moment later, in the order made.
      return (device.kv = idbOrderedKv(kv));
    },
  };
});

// A reload here unmounts the page in this process, where its Web Lock would outlive it: each page life is open until
// the next one, which takes over what it left (sync/pages.ts).
const pages = vi.hoisted(() => ({ open: new Set<string>(), made: 0 }));
vi.mock("./sync/pages.ts", () => ({
  thisPage: () => {
    const id = `page-${pages.made++}`;
    pages.open.add(id);
    return {
      id,
      ready: Promise.resolve(),
      owns: () => true,
      alive: async (other: string) => pages.open.has(other),
      watch: () => undefined,
      onGone: () => () => undefined,
      exclusive: (_name: string, take: () => Promise<unknown>) => take(),
    };
  },
}));

const relay = vi.hoisted(() => ({
  up: false,
  /** Runtime ids Cloud revoked when their computer stopped: the relay refuses the upgrade. */
  refused: new Set<string>(),
  sent: [] as Array<{ method?: string; params?: { request_id?: string }; to: string }>,
}));
/** What Cloud's runtime list answers; null: Cloud cannot be reached for it. */
const cloud = vi.hoisted(() => ({ runtimes: null as null | ReadonlyArray<object> }));
class RelaySocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  /** The runtime this socket asks the relay for. */
  private readonly to: string;
  constructor(url: string) {
    this.to = /\/runtimes\/([^/?]+)/.exec(url)?.[1] ?? "";
    if (relay.refused.has(this.to)) setTimeout(() => this.onerror?.(), 5);
    else if (relay.up)
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      }, 5);
  }
  send(frame: string) {
    relay.sent.push({ ...JSON.parse(frame), to: this.to });
  }
  close() {
    this.readyState = 3;
  }
}

const dom = vi.hoisted(() => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  const events = new EventTarget();
  Object.assign(globalThis, {
    localStorage,
    location: {
      href: "https://cloud.test/code/",
      protocol: "https:",
      host: "cloud.test",
      hostname: "cloud.test",
      pathname: "/code/",
      search: "",
      hash: "",
      origin: "https://cloud.test",
    },
    history: { replaceState: () => undefined },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    IS_REACT_ACT_ENVIRONMENT: false,
  });
  Object.assign(globalThis, { window: globalThis });
  return { localStorage };
});

const { window: page, document } = parseHTML("<!doctype html><html><body></body></html>");
Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
Object.assign(globalThis, {
  document,
  HTMLIFrameElement: (page as unknown as Record<string, unknown>).HTMLIFrameElement,
  WebSocket: RelaySocket,
  fetch: async (input: unknown) => {
    const answer = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (String(input).endsWith("/api/v1/auth/me"))
      return answer({ user: { id: "u1", organization_id: "o1" } });
    if (String(input).endsWith("/api/v1/code/runtimes") && cloud.runtimes)
      return answer({ runtimes: cloud.runtimes });
    return new Response("unavailable", { status: 503 });
  },
});
const runtime = await import("./runtime.tsx");
const { chooseRuntime, chosenRuntime } = await import("./cloud.ts");
type SyncHub = import("./sync/hub.ts").SyncHub;

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

function pageLife() {
  const seen: { client: Client | null; hub: SyncHub | null } = { client: null, hub: null };
  function Capture() {
    seen.client = runtime.useRuntimeClient().client;
    seen.hub = runtime.useSyncHub();
    return null;
  }
  const root = createRoot(document.createElement("div") as unknown as Element);
  root.render(createElement(runtime.RuntimeProvider, null, createElement(Capture)));
  return {
    seen,
    reload: () => {
      root.unmount();
      pages.open.clear();
    },
  };
}

// A Cloud computer, the runtime it wakes as next (Cloud mints a new runtime id at every wake), and a Mac.
const B = {
  id: "rt-B",
  name: "B",
  computer_id: "c-B",
  computer_name: "B",
  computer_driver: "fly",
  last_seen_at: null,
};
const B_WOKEN = { ...B, id: "rt-B2" };
const MAC = {
  id: "rt-M",
  name: "M",
  computer_id: "c-M",
  computer_name: "M",
  computer_driver: "local",
  last_seen_at: null,
};
const turn = (requestId: string) => ({
  request_id: requestId,
  session_id: `s-${requestId}`,
  kind: "followup",
  input: { text: "hello" },
  options: {},
});
const send = (client: Client, requestId: string) =>
  void client.call("turn.submit", turn(requestId) as never).catch(() => undefined);
/** Where the device's store keeps a waiting call, below the signed-in person's part. */
const stored = (requestId: string) =>
  [...device.kv!.data.keys()]
    .filter((k) => k.endsWith(`/${requestId}`))
    .map((k) => k.replace("person/o1%3Au1/", ""));

/**
 * The second page life, the relay back: the turn.submits it sends and to which runtime, and the outboxes its home
 * clients loaded. It waits for the first turn.submit, then a moment more for any second one.
 */
async function afterReload() {
  relay.up = true;
  device.scans.length = 0;
  const second = pageLife();
  await waitFor(
    () =>
      second.seen.client !== null &&
      second.seen.hub?.hasCloud() === true &&
      relay.sent.some((f) => f.method === "turn.submit"),
  );
  await new Promise((r) => setTimeout(r, 200));
  second.reload();
  return {
    resent: relay.sent
      .filter((f) => f.method === "turn.submit")
      .map((f) => `${f.params?.request_id} to ${f.to}`),
    loaded: [...new Set(device.scans.filter((p) => /outbox\/(computer|runtime)\//.test(p)))],
  };
}

beforeEach(() => {
  relay.up = false;
  relay.refused.clear();
  cloud.runtimes = null;
  relay.sent.length = 0;
  device.scans.length = 0;
  device.kv?.data.clear();
  dom.localStorage.clear();
});

test("a send left unanswered on a computer picked before the page opened goes out after a reload", async () => {
  expect(runtime.CLOUD_HOSTED).toBe(true);
  chooseRuntime(localStorage, B);
  const first = pageLife();
  await waitFor(() => first.seen.client !== null && first.seen.hub?.hasCloud() === true);
  // The relay is down: the send waits in the home client's outbox.
  send(first.seen.client!, "req-0");
  await waitFor(() => stored("req-0").length === 1);
  // B is a Cloud computer: the send waits under its computer.
  expect(stored("req-0")).toEqual(["outbox/computer/c-B/req-0"]);
  first.reload();
  expect(await afterReload()).toEqual({
    resent: ["req-0 to rt-B"],
    loaded: ["person/o1%3Au1/outbox/computer/c-B/", "person/o1%3Au1/outbox/runtime/rt-B/"],
  });
});

test("a send left unanswered on a computer picked in place goes out after a reload", async () => {
  // First visit, nothing picked: Cloud says who is signed in, then the person picks computer B in place.
  const first = pageLife();
  await waitFor(() => first.seen.hub?.hasCloud() === true);
  chooseRuntime(localStorage, B);
  await waitFor(() => first.seen.client !== null);
  send(first.seen.client!, "req-1");
  await waitFor(() => stored("req-1").length === 1);
  expect(stored("req-1")).toEqual(["outbox/computer/c-B/req-1"]);
  first.reload();
  // B is the chosen computer when the next page opens, before Cloud has said who is signed in.
  expect(await afterReload()).toEqual({
    resent: ["req-1 to rt-B"],
    loaded: ["person/o1%3Au1/outbox/computer/c-B/", "person/o1%3Au1/outbox/runtime/rt-B/"],
  });
});

test("a send left unanswered on a Cloud computer that woke under a new runtime id before the reload goes out to the runtime it woke as", async () => {
  chooseRuntime(localStorage, B);
  const first = pageLife();
  await waitFor(() => first.seen.client !== null && first.seen.hub?.hasCloud() === true);
  send(first.seen.client!, "req-2");
  await waitFor(() => stored("req-2").length === 1);
  first.reload();
  // The computer slept and woke: Cloud revoked the runtime id this tab remembers and lists the one it runs as now.
  relay.refused.add(B.id);
  cloud.runtimes = [B_WOKEN];
  const after = await afterReload();
  // The tab opened on the id it remembered, was refused, and found its computer again by computer id: the send it kept
  // under that computer went out once, to the runtime the computer woke as.
  expect(chosenRuntime(localStorage)).toMatchObject({ id: "rt-B2", computer_id: "c-B" });
  expect(after.resent).toEqual(["req-2 to rt-B2"]);
  expect(after.loaded).toEqual([
    "person/o1%3Au1/outbox/computer/c-B/",
    "person/o1%3Au1/outbox/runtime/rt-B/",
    "person/o1%3Au1/outbox/runtime/rt-B2/",
  ]);
});

test("a send a page from before computers kept theirs left under a Cloud computer's runtime id goes out after a reload too", async () => {
  chooseRuntime(localStorage, B);
  const first = pageLife();
  await waitFor(() => first.seen.client !== null && first.seen.hub?.hasCloud() === true);
  first.reload();
  device.kv!.data.set("person/o1%3Au1/outbox/runtime/rt-B/req-3", {
    request_id: "req-3",
    method: "turn.submit",
    params: turn("req-3"),
    at: Date.now(),
    page: "page-gone",
  });
  expect((await afterReload()).resent).toEqual(["req-3 to rt-B"]);
});

test("a send left unanswered on a Mac waits under its runtime id, which is its enrolment, and the next page takes it from there", async () => {
  chooseRuntime(localStorage, MAC);
  const first = pageLife();
  await waitFor(() => first.seen.client !== null && first.seen.hub?.hasCloud() === true);
  send(first.seen.client!, "req-4");
  await waitFor(() => stored("req-4").length === 1);
  expect(stored("req-4")).toEqual(["outbox/runtime/rt-M/req-4"]);
  const put = device.kv!.data.get("person/o1%3Au1/outbox/runtime/rt-M/req-4") as { page: string };
  first.reload();
  // A Mac allows each device before it takes a call from it (S13), and no Mac answers here: nothing goes out. The next
  // page loads the Mac's outbox, and only that one, and the send is its own to send from then on.
  relay.up = true;
  device.scans.length = 0;
  const second = pageLife();
  await waitFor(
    () =>
      (device.kv!.data.get("person/o1%3Au1/outbox/runtime/rt-M/req-4") as { page: string }).page !==
      put.page,
  );
  second.reload();
  expect([...new Set(device.scans.filter((p) => /outbox\/(computer|runtime)\//.test(p)))]).toEqual([
    "person/o1%3Au1/outbox/runtime/rt-M/",
  ]);
  expect(stored("req-4")).toEqual(["outbox/runtime/rt-M/req-4"]);
});
