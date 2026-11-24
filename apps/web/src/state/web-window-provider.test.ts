// A browser window Caveman Cloud serves, whole: the real RuntimeProvider, SyncHub, chat list and Session Protocol
// client. Only the network is a fake: Cloud's person routes (who is signed in, the chat list and its stream, the
// computers, the runtimes) and the relay's sockets. What it must hold: signed in, the window is the app on Cloud's list
// with no runtime of its own; it quietly uses one that is on line and lets it go when the relay says it is not there;
// and it never asks Cloud to wake or run anything by itself.
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatSummary, RuntimeState } from "./sync/wire.ts";

vi.mock("./sync/kv.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sync/kv.ts")>();
  return { ...real, indexedDbKv: () => real.memoryKv() };
});
vi.mock("./sync/pages.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sync/pages.ts")>();
  return { ...real, thisPage: () => real.onlyPage() };
});

/** The relay: every socket a page asked for, by the runtime it names, and how the test ends one. */
const relay = vi.hoisted(() => ({
  sockets: [] as Array<{
    to: string;
    closeWith: (code: number, reason: string) => void;
    refuse: () => void;
    closed: boolean;
  }>,
}));
class RelaySocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(url: string) {
    const entry = {
      to: decodeURIComponent(/\/runtimes\/([^/?]+)/.exec(url)?.[1] ?? ""),
      closed: false,
      closeWith: (code: number, reason: string) => this.onclose?.({ code, reason }),
      refuse: () => this.onerror?.(),
    };
    relay.sockets.push(entry);
    this.close = () => {
      this.readyState = 3;
      entry.closed = true;
    };
  }
  send() {}
  close: () => void;
}

/** Caveman Cloud as this person's browser reaches it. */
const cloud = vi.hoisted(() => ({
  signedIn: true,
  chats: [] as unknown[],
  runtimes: [] as unknown[],
  /** GET computers' `cloud_computers`; null: Cloud cannot say (503). */
  cloudOn: true as boolean | null,
  /** GET runtimes, as the window's own list of what it may reach. */
  reachable: [] as unknown[],
  seq: 1,
  streams: [] as Array<(frame: string) => void>,
  /** Every request that is not a GET: what the window asked Cloud to do. */
  writes: [] as string[],
}));

const dom = vi.hoisted(() => {
  const store = new Map<string, string>();
  const make = (data: Map<string, string>) => ({
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  });
  const localStorage = make(store);
  const sessionStorage = make(new Map());
  const events = new EventTarget();
  Object.assign(globalThis, {
    localStorage,
    sessionStorage,
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
  return { localStorage, sessionStorage };
});

const { window: page, document } = parseHTML("<!doctype html><html><body></body></html>");
Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
const encoder = new TextEncoder();
Object.assign(globalThis, {
  document,
  HTMLIFrameElement: (page as unknown as Record<string, unknown>).HTMLIFrameElement,
  WebSocket: RelaySocket,
  fetch: async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    // Renewing the cookie asks nothing of a computer.
    if (url.endsWith("/api/v1/auth/refresh")) return json({}, 401);
    if (method !== "GET") cloud.writes.push(`${method} ${url}`);
    if (!cloud.signedIn) return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
    if (url.endsWith("/api/v1/auth/me")) return json({ user: { id: "u1", organization_id: "o1" } });
    if (url.includes("/api/v1/code/chats/stream")) {
      let write!: (frame: string) => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          write = (frame) => controller.enqueue(encoder.encode(frame));
          cloud.streams.push(write);
          write(": keepalive\n\n");
        },
      });
      init?.signal?.addEventListener(
        "abort",
        () => (cloud.streams = cloud.streams.filter((w) => w !== write)),
      );
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.includes("/api/v1/code/chats?"))
      return json({ chats: cloud.chats, runtimes: cloud.runtimes, seq: cloud.seq });
    if (url.includes("/api/v1/code/computers?mine=true"))
      return cloud.cloudOn === null
        ? json({}, 503)
        : json({ cloud_computers: cloud.cloudOn, computers: [] });
    if (url.endsWith("/api/v1/code/runtimes")) return json({ runtimes: cloud.reachable });
    if (method === "POST" && /\/api\/v1\/code\/computers\/[^/]+\/resume$/.test(url))
      return json({});
    return json({ error: { message: "not here" } }, 404);
  },
});

const runtime = await import("./runtime.tsx");
const { chooseRuntime, chosenRuntime, holdPendingStart } = await import("./cloud.ts");
const { noteDeviceStatus } = await import("./device-approval.ts");
type Value = ReturnType<typeof runtime.useRuntime>;
type Web = NonNullable<ReturnType<typeof runtime.useWebWindow>>;

const at = "2026-11-10T09:00:00.000Z";
const rt = (runtime_id: string, over: Partial<RuntimeState> = {}): RuntimeState => ({
  runtime_id,
  computer_id: `c-${runtime_id}`,
  kind: "cloud",
  name: runtime_id,
  online: true,
  last_seen_at: at,
  ...over,
});
const chat = (session_id: string, over: Partial<ChatSummary> = {}): ChatSummary => ({
  session_id,
  workspace_id: `w-${session_id}`,
  runtime_id: "rt-web",
  computer_id: "c-rt-web",
  where: { kind: "cloud", name: "acme-web" },
  title: `Chat ${session_id}`,
  engine: "caveman",
  repo: "acme/web",
  branch: "main",
  kind: "chat",
  status: "idle",
  last_activity_at: at,
  epoch: 1,
  head: 0,
  synced_through: 0,
  archived: false,
  person: { seen_cursor: 0, pinned: false },
  calls: [],
  seq: 1,
  ...over,
});
/** Cloud says something new of a runtime, on every open stream. */
const say = (state: RuntimeState) => {
  cloud.runtimes = [
    ...(cloud.runtimes as RuntimeState[]).filter((r) => r.runtime_id !== state.runtime_id),
    state,
  ];
  cloud.seq++;
  for (const write of cloud.streams)
    write(`id: ${cloud.seq}\nevent: runtime\ndata: ${JSON.stringify(state)}\n\n`);
};

const waitFor = async (cond: () => boolean, what = "") => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond(), what).toBe(true);
};
const quiet = (ms = 120) => new Promise((r) => setTimeout(r, ms));

let unmount: (() => void) | null = null;
function open() {
  const seen: { value: Value | null; web: Web | null; client: unknown } = {
    value: null,
    web: null,
    client: null,
  };
  function Capture() {
    seen.value = runtime.useRuntime();
    seen.web = runtime.useWebWindow();
    seen.client = runtime.useRuntimeClient().client;
    return null;
  }
  const root = createRoot(document.createElement("div") as unknown as Element);
  root.render(createElement(runtime.RuntimeProvider, null, createElement(Capture)));
  unmount = () => root.unmount();
  return seen;
}
/** The sockets still open, by the runtime each names. */
const openTo = () => relay.sockets.filter((s) => !s.closed).map((s) => s.to);

beforeEach(() => {
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  relay.sockets.length = 0;
  Object.assign(cloud, {
    signedIn: true,
    chats: [],
    runtimes: [],
    cloudOn: true,
    reachable: [],
    seq: 1,
    streams: [],
    writes: [],
  });
});
afterEach(() => {
  unmount?.();
  unmount = null;
});

test("signed in with every place asleep: the window is the app on Cloud's list, with no runtime of its own, and wakes nothing", async () => {
  expect(runtime.CLOUD_HOSTED).toBe(true);
  cloud.runtimes = [
    rt("rt-studio", { kind: "laptop", name: "Studio", online: false }),
    rt("rt-web", { online: false, computer_state: "suspended" }),
  ];
  cloud.chats = [
    chat("s-mac", {
      runtime_id: "rt-studio",
      computer_id: "c-rt-studio",
      where: { kind: "laptop", name: "Studio" },
    }),
    chat("s-web"),
    chat("s-recent", {
      last_activity_at: new Date().toISOString(),
      status: "needs_you",
      needs_you: { kind: "approval", summary: "Deploy?" },
    }),
  ];
  const seen = open();
  await waitFor(() => seen.value?.workspaces.length === 3, "every chat listed");
  expect(seen.web?.window).toEqual({ kind: "app", failed: false, nothingYet: false });
  expect(seen.value!.workspaces.map((w) => [w.sessionId, w.computer.kind, w.asleep])).toEqual([
    ["s-mac", "laptop", false],
    ["s-web", "caveman_cloud", true],
    ["s-recent", "caveman_cloud", true],
  ]);
  // No computer is this window's: nothing to connect to, and nothing asked of one.
  expect({ status: seen.value!.status, client: seen.client, home: seen.web!.home }).toEqual({
    status: "unconfigured",
    client: null,
    home: null,
  });
  await waitFor(() => seen.web?.places.cloud === "on");
  expect(seen.web!.places).toEqual({
    places: [{ kind: "cloud", name: "Cloud" }],
    cloud: "on",
    lines: [],
  });
  // An open window, a chat that needs the person, one active a moment ago: none of it wakes a computer.
  await quiet(200);
  expect(relay.sockets).toEqual([]);
  expect(cloud.writes).toEqual([]);
  expect(chosenRuntime(localStorage)).toBeNull();
});

test("a Cloud computer that is running: the window quietly uses it; when the relay says it is not there, it lets go and wakes nothing", async () => {
  cloud.runtimes = [rt("rt-web")];
  cloud.chats = [chat("s-web")];
  const seen = open();
  await waitFor(() => openTo().includes("rt-web"), "connected through the relay");
  // The window names its home in the render after the socket opens.
  await waitFor(() => seen.web?.home != null, "the window names the computer it uses");
  expect(seen.web!.home).toEqual({ kind: "cloud", name: "Cloud" });
  expect(seen.value!.identity.computerName).toBe("Cloud");
  // Nobody picked it and nothing is stored: a reload decides again.
  expect(chosenRuntime(localStorage)).toBeNull();

  // It went to sleep under the window: the relay has no such runtime (4404), before Cloud's list says so.
  relay.sockets.find((s) => s.to === "rt-web")!.closeWith(4404, "runtime not connected");
  await waitFor(() => seen.client === null, "let go");
  expect(seen.web!.home).toBeNull();
  expect(seen.value!.status).toBe("unconfigured");
  // The app stays, on Cloud's list.
  expect(seen.web!.window.kind).toBe("app");
  expect(seen.value!.workspaces.map((w) => w.sessionId)).toEqual(["s-web"]);
  await quiet(200);
  expect(openTo()).toEqual([]);
  expect(cloud.writes).toEqual([]);

  // Cloud says it sleeps; later it wakes for a send under a new runtime id: the window uses that, by itself.
  say(rt("rt-web", { online: false, computer_state: "suspended", seq: 4 }));
  await quiet(60);
  expect(openTo()).toEqual([]);
  say(rt("rt-web-2", { computer_id: "c-rt-web", seq: 5 }));
  await waitFor(
    () => openTo().includes("rt-web-2"),
    "followed its computer to the runtime it woke as",
  );
  await waitFor(() => seen.web?.home != null, "the window names the computer again");
  expect(seen.web!.home).toEqual({ kind: "cloud", name: "Cloud" });
  expect(cloud.writes).toEqual([]);
});

test("a Mac on line that has not allowed this browser is never used by itself; once it has, it is, by its own name", async () => {
  cloud.runtimes = [rt("rt-studio", { kind: "laptop", name: "Studio" })];
  cloud.chats = [
    chat("s-mac", {
      runtime_id: "rt-studio",
      computer_id: "c-rt-studio",
      where: { kind: "laptop", name: "Studio" },
    }),
  ];
  const seen = open();
  await waitFor(() => seen.value?.workspaces.length === 1);
  await waitFor(() => seen.web?.places.cloud === "on");
  // A new chat can run on it, by name; the window itself stays off it, so the Mac asks nothing until it is needed.
  expect(seen.web!.places.places).toEqual([
    { kind: "cloud", name: "Cloud" },
    { kind: "mac", name: "Studio", runtimeId: "rt-studio", computerId: "c-rt-studio" },
  ]);
  await quiet(150);
  expect(relay.sockets).toEqual([]);
  expect(seen.web!.home).toBeNull();

  // The person opened one of its chats and allowed this browser on the Mac (device-approval.ts hears it).
  noteDeviceStatus("rt-studio", { status: "approved", runtime_name: "Studio" } as never);
  await waitFor(() => openTo().includes("rt-studio"), "the Mac is the window's runtime now");
  expect(seen.web!.home).toEqual({ kind: "mac", name: "Studio" });
  expect(seen.value!.identity.computerName).toBe("Studio");
  expect(cloud.writes).toEqual([]);
});

test("New chat on a Mac puts the window there, and Cloud lets it go again", async () => {
  cloud.runtimes = [rt("rt-studio", { kind: "laptop", name: "Studio" })];
  const seen = open();
  await waitFor(() => seen.web?.places.places.length === 2);
  seen.web!.usePlace(seen.web!.places.places[1]!);
  await waitFor(() => openTo().includes("rt-studio"));
  expect(chosenRuntime(localStorage)).toMatchObject({ id: "rt-studio", computer_driver: "local" });
  seen.web!.usePlace(seen.web!.places.places[0]!);
  await waitFor(() => openTo().length === 0);
  expect(chosenRuntime(localStorage)).toBeNull();
});

test("a window put on a Cloud computer that then sleeps lets it go and wakes nothing; with a chat started for it, it asks Cloud for it", async () => {
  const box = {
    id: "rt-web",
    name: "acme-web",
    computer_id: "c-rt-web",
    computer_name: "acme-web",
    computer_driver: "boat",
    last_seen_at: at,
  };
  // A reload: the window was on this computer, which has gone to sleep since.
  chooseRuntime(localStorage, box);
  cloud.runtimes = [rt("rt-web", { online: false, computer_state: "suspended" })];
  cloud.chats = [chat("s-web")];
  const seen = open();
  await waitFor(() => relay.sockets.some((s) => s.to === "rt-web"));
  relay.sockets.find((s) => s.to === "rt-web")!.refuse();
  await waitFor(() => chosenRuntime(localStorage) === null, "let go of the computer that sleeps");
  await waitFor(() => seen.client === null);
  await quiet(150);
  expect(cloud.writes).toEqual([]);
  expect(seen.web!.window.kind).toBe("app");
  unmount?.();

  // The same, but the person started a chat there and it has yet to run: a start is a send, and sending wakes.
  relay.sockets.length = 0;
  chooseRuntime(localStorage, box);
  holdPendingStart(sessionStorage, {
    computer_id: "c-rt-web",
    repo: "acme/web",
    engine: "caveman",
    task: "Fix the login page",
  });
  open();
  await waitFor(() => relay.sockets.some((s) => s.to === "rt-web"));
  relay.sockets.find((s) => s.to === "rt-web")!.closeWith(4404, "runtime not connected");
  await waitFor(() => cloud.writes.length === 1, "asked Cloud for the started chat's computer");
  expect(cloud.writes).toEqual(["POST /api/v1/code/computers/c-rt-web/resume"]);
  expect(chosenRuntime(localStorage)?.id).toBe("rt-web");
});

test("signed out: the window says so and asks for nothing else; Cloud off with no Mac on line: one sentence each on what to do", async () => {
  cloud.signedIn = false;
  const out = open();
  await waitFor(() => out.web?.window.kind === "signed_out");
  expect(out.value!.workspaces).toEqual([]);
  expect(relay.sockets).toEqual([]);
  unmount?.();

  Object.assign(cloud, {
    signedIn: true,
    cloudOn: false,
    runtimes: [rt("rt-studio", { kind: "laptop", name: "Studio", online: false })],
  });
  const off = open();
  await waitFor(() => off.web?.places.cloud === "off");
  expect(off.web!.window).toEqual({ kind: "app", failed: false, nothingYet: true });
  expect(off.web!.places).toEqual({
    places: [],
    cloud: "off",
    lines: [
      "Cloud is off. Ask your admin.",
      "To use your Mac here, turn on Settings > Remote control in Caveman Code on it.",
    ],
  });
  expect(cloud.writes).toEqual([]);
});
