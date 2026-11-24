// The direct path in this device's sync state (S14): the pool opens a laptop's runtime with a client that also tries a
// WebRTC data channel, reports which path it uses, and the hub's feeds and calls ride it without a reload. A Cloud
// computer gets the relay only. The fake runtime and RTCPeerConnection are the session-protocol package's
// (test/directFakes.ts); the switching itself is tested there and, with real WebRTC, in the runtime package.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";
import { fakeCloud, runtime, summary, until } from "./fakes.test-support.ts";
import { SyncHub } from "./hub.ts";
import { memoryKv } from "./kv.ts";
import { RuntimePool } from "./runtime-pool.ts";
import { onlyPage } from "./pages.ts";

interface FakeRuntime {
  readonly url: string;
  readonly offers: ReadonlyArray<unknown>;
  readonly journal: ReadonlyArray<SessionEvent>;
  append(): void;
  direct(): { attached: Set<string> } | undefined;
  close(): Promise<void>;
}
interface FakeRtc {
  readonly Rtc: unknown;
  readonly peers: Array<{ channel: { kill(): void } | null }>;
}
// Node test support in another package: loaded at run time, outside this app's typecheck.
const FAKES = "../../../../../packages/session-protocol/test/directFakes.ts";
const fakes = async () => (await import(/* @vite-ignore */ new URL(FAKES, import.meta.url).href)) as { fakeRuntime: () => Promise<FakeRuntime>; fakeRtc: (url: string) => FakeRtc };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("the pool tries a direct path to a laptop's runtime only, and says which path each uses", async () => {
  const { fakeRuntime, fakeRtc } = await fakes();
  const laptop = await fakeRuntime();
  const box = await fakeRuntime();
  cleanups.push(laptop.close, box.close);
  const rtc = fakeRtc(laptop.url);
  const urls: Record<string, string> = { "rt-laptop": laptop.url, "rt-box": box.url };
  const pool = new RuntimePool({
    endpoint: (id) => ({ url: urls[id]!, token: "t" }),
    direct: (id) => (id === "rt-laptop" ? { rtc: rtc.Rtc as never, iceServers: [], network: () => () => undefined, retryMs: () => 20 } : undefined),
  });
  cleanups.push(() => pool.closeAll());
  let changes = 0;
  pool.subscribe(() => changes++);
  pool.acquire("rt-laptop");
  pool.acquire("rt-box");
  await until(() => pool.isDirect("rt-laptop"));
  expect(pool.isDirect("rt-box")).toBe(false);
  expect(pool.link("rt-laptop")).toBe("open");
  expect(changes).toBeGreaterThan(0);
  expect(laptop.offers).toHaveLength(1);
  expect(box.offers).toHaveLength(0);
  // The channel drops: the pool says relay at once, and direct again once it comes back.
  const before = changes;
  rtc.peers[0]!.channel!.kill();
  await until(() => !pool.isDirect("rt-laptop"));
  expect(changes).toBeGreaterThan(before);
  await until(() => pool.isDirect("rt-laptop"));
});

test("the install's word on direct channels: none keeps every device on the relay; its STUN servers are the ones used", async () => {
  const { fakeRuntime, fakeRtc } = await fakes();
  const laptop = await fakeRuntime();
  cleanups.push(laptop.close);
  const window = async (direct: { enabled: boolean; stun_servers: string[] } | undefined) => {
    const rtc = fakeRtc(laptop.url);
    const cloud = fakeCloud();
    if (direct) cloud.advert.direct = direct;
    cloud.runtime(runtime("rt-laptop", { kind: "laptop" }));
    cloud.put(summary("s1", { runtime_id: "rt-laptop", where: { kind: "laptop", name: "Work MacBook" } }));
    const hub = new SyncHub({
      pages: onlyPage(),
      api: cloud.api,
      kv: memoryKv(),
      home: () => ({ runtimeId: "rt-phone", client: null }),
      endpoint: () => ({ url: laptop.url, token: "t" }),
      direct: { rtc: rtc.Rtc as never, network: () => () => undefined },
    });
    cleanups.push(() => hub.stop());
    hub.start();
    await until(() => hub.summary("s1") !== undefined);
    hub.openFeed("s1", { reset: () => undefined, apply: () => undefined }, () => undefined);
    return { hub, rtc };
  };
  // Relay only: no channel is ever tried.
  const off = await window({ enabled: false, stun_servers: [] });
  await until(() => off.hub.pool.link("rt-laptop") === "open");
  await new Promise((r) => setTimeout(r, 100));
  expect(off.rtc.peers).toHaveLength(0);
  expect(off.hub.directAllowed()).toBe(false);
  // The install's own STUN server.
  const own = await window({ enabled: true, stun_servers: ["stun:stun.install.test:3478"] });
  await until(() => own.hub.pool.isDirect("rt-laptop"));
  expect((own.rtc.peers[0] as unknown as { config: unknown }).config).toEqual({ iceServers: [{ urls: "stun:stun.install.test:3478" }] });
  // An install that says nothing: Google's public STUN.
  const silent = await window(undefined);
  await until(() => silent.hub.pool.isDirect("rt-laptop"));
  expect((silent.rtc.peers[0] as unknown as { config: unknown }).config).toEqual({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
});

test("a chat on a laptop opened on another device follows the direct path and the relay by cursor, nothing twice", async () => {
  const { fakeRuntime, fakeRtc } = await fakes();
  const laptop = await fakeRuntime();
  cleanups.push(laptop.close);
  const rtc = fakeRtc(laptop.url);
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-laptop", { kind: "laptop" }));
  cloud.put(summary("s1", { runtime_id: "rt-laptop", where: { kind: "laptop", name: "Work MacBook" } }));
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: memoryKv(),
    home: () => ({ runtimeId: "rt-phone", client: null }),
    endpoint: () => ({ url: laptop.url, token: "t" }),
    direct: { rtc: rtc.Rtc as never, iceServers: [], network: () => () => undefined, retryMs: () => 20 },
  });
  cleanups.push(() => hub.stop());
  hub.start();
  for (let i = 0; i < 3; i++) laptop.append();
  await until(() => hub.summary("s1") !== undefined);
  const shown: number[] = [];
  hub.openFeed("s1", { reset: () => void (shown.length = 0), apply: (e) => void shown.push(e.cursor) }, () => undefined);
  await until(() => shown.length === 3);
  await until(() => hub.pool.isDirect("rt-laptop") && laptop.direct()?.attached.has("s1") === true);
  expect(hub.viaFor("s1")).toBe("direct");
  // Calls take the channel too, through the same client the pane holds.
  expect(await hub.clientFor("s1").call("engine.list", {})).toMatchObject({ via: "direct" });
  const pump = setInterval(() => laptop.append(), 3);
  await until(() => shown.length >= 30);
  rtc.peers[0]!.channel!.kill();
  await until(() => !hub.pool.isDirect("rt-laptop"));
  expect(hub.viaFor("s1")).toBe("relay");
  await until(() => hub.pool.isDirect("rt-laptop"));
  await until(() => shown.length >= 90);
  clearInterval(pump);
  await until(() => shown.length === laptop.journal.length);
  expect(shown).toEqual(Array.from({ length: laptop.journal.length }, (_, i) => i + 1));
});
