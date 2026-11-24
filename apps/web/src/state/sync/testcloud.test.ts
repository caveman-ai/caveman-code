// The device's sync state against the runtime package's test Cloud (packages/runtime src/cloudLink/testCloud.ts),
// which holds Cloud's rules for the chat routes (CONTRACT §1-§3, S12): the list, its stream with seq resume and
// reset, the copy by epoch, idempotent calls and the call that waits for a sleeping Mac. Real HTTP and SSE, no fakes.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ChatFeed, type FeedState } from "./chat-feed.ts";
import { ChatListStore } from "./chat-list.ts";
import { cloudApi, type CloudApi } from "./cloud-api.ts";
import { until } from "./fakes.test-support.ts";
import { memoryKv } from "./kv.ts";
import { kvOutbox } from "./outbox.ts";
import { ChatSender, queuedLine } from "./sender.ts";
import { onlyPage } from "./pages.ts";

interface TestCloud {
  readonly url: string;
  readonly state: { readonly personToken: string; readonly chats: { retain: number } };
  enrollRuntime(options?: { kind?: "laptop" | "cloud"; name?: string }): { runtimeId: string; computerId: string; token: string };
  close(): Promise<void>;
}
// The test Cloud is Node code in another package: loaded at run time, outside this app's typecheck.
const TEST_CLOUD = "../../../../../packages/runtime/src/cloudLink/testCloud.ts";

let cloud: TestCloud;
const stores: ChatListStore[] = [];
beforeEach(async () => {
  const module = (await import(/* @vite-ignore */ new URL(TEST_CLOUD, import.meta.url).href)) as { startTestCloud: () => Promise<TestCloud> };
  cloud = await module.startTestCloud();
});
afterEach(async () => {
  for (const s of stores.splice(0)) s.stop();
  await cloud.close();
});

const personApi = (): CloudApi =>
  cloudApi({ base: cloud.url, headers: async () => ({ authorization: `Bearer ${cloud.state.personToken}` }), renew: async () => false, credentials: "omit" });

const runtimeCall = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const binary = body instanceof Uint8Array;
  const response = await fetch(`${cloud.url}/api/v1/code/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !binary ? { "content-type": "application/json" } : {}), ...headers },
    ...(body === undefined ? {} : { body: binary ? (body as BodyInit) : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>) };
};

const summary = (session: string, extra: Record<string, unknown> = {}) => ({
  workspace_id: `ws-${session}`,
  title: `Chat ${session}`,
  engine: "caveman",
  repo: "acme/web",
  branch: "caveman/fix",
  kind: "chat",
  status: "idle",
  last_activity_at: new Date().toISOString(),
  epoch: 1,
  head: 0,
  archived: false,
  ...extra,
});

const gzip = async (text: string) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

/** The runtime copies events from..through of `session` to Cloud as one segment, as the copy outbox does. */
async function copy(token: string, session: string, from: number, through: number, release = true) {
  const index = (await runtimeCall(token, "GET", `runtime/sessions/${session}/journal`)).body!;
  const lease = (await runtimeCall(token, "PUT", `runtime/sessions/${session}/journal`, { cursor_seq: index.cursor_seq, segments: index.segments, size_bytes: index.size_bytes })).body!;
  const events = Array.from({ length: through - from + 1 }, (_, i) => {
    const cursor = from + i;
    const at = new Date(1_700_000_000_000 + cursor).toISOString();
    return { cursor, type: "message.delta", at, event: { session_id: session, cursor, at, type: "message.delta", payload: { text: `event ${cursor}` } } };
  });
  const body = await gzip(JSON.stringify({ v: 2, epoch: 1, from, through, boundary: true, runtime_id: "r", after: from - 1, repo: "acme/web", record: {}, events, display: [], engine: null, wip: null }));
  const n = lease.segments as number;
  const put = await runtimeCall(token, "PUT", `runtime/sessions/${session}/journal/segments/${n}`, body, { "x-caveman-lease": String(lease.lease_token), "content-type": "application/octet-stream" });
  expect(put.status).toBe(204);
  await runtimeCall(token, "PUT", `runtime/sessions/${session}/journal`, { lease_token: lease.lease_token, cursor_seq: through, segments: n + 1, size_bytes: body.length, ...(release ? { release: true } : {}) });
}

test("the list follows Cloud: chats on This Mac and two Cloud computers, live changes, and a reset after a long absence", { timeout: 30_000 }, async () => {
  const mac = cloud.enrollRuntime({ name: "Julius's MacBook" });
  const api1 = cloud.enrollRuntime({ kind: "cloud", name: "api-box" });
  const web = cloud.enrollRuntime({ kind: "cloud", name: "web-box" });
  await runtimeCall(mac.token, "PUT", "runtime/chats/s-mac", summary("s-mac"));
  await runtimeCall(api1.token, "PUT", "runtime/chats/s-api", summary("s-api"));
  await runtimeCall(web.token, "PUT", "runtime/chats/s-web", summary("s-web"));
  const kv = memoryKv();
  const store = new ChatListStore({ api: personApi(), kv, retryMs: () => 10 });
  stores.push(store);
  void store.start();
  await until(() => store.get().status === "live" && store.get().chats.size === 3, 5_000);
  expect(store.get().chats.get("s-api")).toMatchObject({ where: { kind: "cloud", name: "api-box" }, runtime_id: api1.runtimeId });
  expect(store.get().chats.get("s-mac")).toMatchObject({ where: { kind: "laptop", name: "Julius's MacBook" } });

  await runtimeCall(api1.token, "PUT", "runtime/chats/s-api", summary("s-api", { status: "working", head: 4 }));
  await until(() => store.get().chats.get("s-api")?.status === "working", 5_000);

  // The device goes away; Cloud keeps only the last change; two more happen.
  await store.flush();
  store.stop();
  cloud.state.chats.retain = 1;
  await runtimeCall(web.token, "PUT", "runtime/chats/s-web", summary("s-web", { title: "Renamed" }));
  await runtimeCall(mac.token, "PUT", "runtime/chats/s-mac", summary("s-mac", { status: "needs_you", needs_you: { kind: "approval", summary: "Run it?" } }));
  const again = new ChatListStore({ api: personApi(), kv, retryMs: () => 10 });
  stores.push(again);
  void again.start();
  await until(() => again.get().status === "live" && again.get().chats.get("s-web")?.title === "Renamed" && again.get().chats.get("s-mac")?.status === "needs_you", 5_000);
  expect(again.get().seq).toBeGreaterThan(0);
});

test("a chat on a sleeping computer is read from Cloud's copy, page by page", async () => {
  const box = cloud.enrollRuntime({ kind: "cloud", name: "web-box" });
  await runtimeCall(box.token, "PUT", "runtime/chats/s1", summary("s1", { head: 5 }));
  await copy(box.token, "s1", 1, 3);
  await copy(box.token, "s1", 4, 5);
  const shown: number[] = [];
  const states: FeedState[] = [];
  const api = personApi();
  const feed = new ChatFeed({
    sessionId: "s1",
    sink: { reset: () => void (shown.length = 0), apply: (e: SessionEvent) => void shown.push(e.cursor) },
    copy: (epoch, after) => api.events("s1", epoch, after, 2),
    epochHint: () => 1,
    onState: (s) => states.push(s),
  });
  feed.use({ kind: "copy" });
  await until(() => states.at(-1)?.kind === "copy", 5_000);
  expect(shown).toEqual([1, 2, 3, 4, 5]);
  expect(states.at(-1)).toEqual({ kind: "copy", through: 5 });
  feed.close();
});

test("a send queued in Cloud is one call per request id, and one to a sleeping Mac's chat says it is queued", async () => {
  const mac = cloud.enrollRuntime();
  const box = cloud.enrollRuntime({ kind: "cloud" });
  await runtimeCall(box.token, "PUT", "runtime/chats/s-box", summary("s-box"));
  await runtimeCall(mac.token, "PUT", "runtime/chats/s-mac", summary("s-mac"));
  // Registered to move, as the Mac does for a chat of a GitHub repository: only such a chat moves to a Cloud computer.
  await runtimeCall(mac.token, "PUT", "runtime/sessions/s-mac", { title: "Fix login", repo: "acme/web", base_branch: "main", branch: "caveman/fix", engine: "caveman", follow: true });
  await copy(mac.token, "s-mac", 1, 1, false); // the Mac still holds the chat's lease as it sleeps
  const sender = new ChatSender({ api: personApi(), outbox: kvOutbox(memoryKv(), "cloud", onlyPage()) });
  const params = { request_id: "r1", session_id: "s-box", kind: "followup", input: { text: "hi" } };
  const first = await sender.send("s-box", "turn.submit", params, { via: "cloud" });
  const second = await sender.send("s-box", "turn.submit", params, { via: "cloud" });
  expect(first.via === "cloud" && second.via === "cloud" && first.call.id === second.call.id).toBe(true);
  const asleep = await sender.send("s-mac", "turn.submit", { ...params, request_id: "r2", session_id: "s-mac" }, { via: "cloud" });
  expect(asleep.via === "cloud" && asleep.call).toMatchObject({ status: "queued", waiting: { reason: "laptop_asleep" } });
  expect(asleep.via === "cloud" ? queuedLine(asleep.call, { name: "Julius's MacBook", cloud: false }) : null).toBe("Waiting for Julius's MacBook");
});
