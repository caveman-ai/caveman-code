// The test Cloud's chat sync (CONTRACT §1-§3, S12) holds Cloud's rules, so the lanes that test against it (clients,
// moves, builders, the chaos harness) meet the refusals the real routes give: epoch and gap fences on segments, a
// person seeing only their own chats, idempotent calls, the stream's resume and reset, and the lid's handoff.
import { gzipSync } from "node:zlib";
import { request } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestCloud, type TestCloud } from "./testCloud.ts";

let cloud: TestCloud;
beforeEach(async () => {
  cloud = await startTestCloud();
});
afterEach(async () => {
  await cloud.close();
});

it("a cancelled upload leaves no unhandled body-read rejection", async () => {
  const upload = request(`${cloud.url}/cancelled-upload`, { method: "PUT" });
  upload.on("error", () => {});
  const closed = new Promise<void>((resolve) => upload.once("close", resolve));
  upload.write("partial body");
  await vi.waitFor(() => expect(cloud.state.seen.some((r) => r.path === "/cancelled-upload")).toBe(true));
  upload.destroy();
  await closed;
  const response = await fetch(`${cloud.url}/after-cancel`);
  expect(response.status).toBe(404);
  await response.arrayBuffer();
});

const call = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${cloud.url}/api/v1/code/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as Record<string, any>) };
};

const summary = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  workspace_id: `ws-${sessionId}`,
  title: "Fix the login page",
  engine: "caveman",
  repo: "acme/web",
  branch: "caveman/fix-login",
  kind: "chat",
  status: "idle",
  last_activity_at: new Date().toISOString(),
  epoch: 1,
  head: 0,
  archived: false,
  ...extra,
});

const event = (cursor: number, type = "message.done") => ({
  cursor,
  type,
  at: new Date(1_700_000_000_000 + cursor).toISOString(),
  event: { session_id: "s1", cursor, at: new Date(1_700_000_000_000 + cursor).toISOString(), type, payload: { role: "assistant", text: `event ${cursor}` } },
});

/** The runtime registers a chat that moves (RegisterSession, follow): only those move (M-4). */
const follow = (token: string, sessionId: string) => call(token, "PUT", `runtime/sessions/${sessionId}`, { title: "Fix the login page", repo: "acme/web", base_branch: "main", branch: "caveman/fix-login", engine: "caveman", follow: true });

/** A runtime that copies one segment of `from..through` at `epoch` and counts it. */
async function copy(token: string, sessionId: string, from: number, through: number, epoch = 1, boundary = true) {
  const index = (await call(token, "GET", `runtime/sessions/${sessionId}/journal`)).body!;
  const lease = await call(token, "PUT", `runtime/sessions/${sessionId}/journal`, { cursor_seq: index.cursor_seq, segments: index.segments, size_bytes: index.size_bytes });
  expect(lease.status).toBe(200);
  const n = lease.body!.segments as number;
  const events = Array.from({ length: through - from + 1 }, (_, i) => event(from + i));
  const body = gzipSync(JSON.stringify({ v: 2, epoch, from, through, boundary, runtime_id: "r", after: from - 1, repo: "acme/web", record: {}, events, display: [], engine: null, wip: null }));
  const put = await call(token, "PUT", `runtime/sessions/${sessionId}/journal/segments/${n}`, body, { "x-caveman-lease": lease.body!.lease_token, "content-type": "application/octet-stream" });
  if (put.status !== 204) return put;
  return call(token, "PUT", `runtime/sessions/${sessionId}/journal`, { lease_token: lease.body!.lease_token, cursor_seq: through, segments: n + 1, size_bytes: body.length });
}

describe("test Cloud chat sync", () => {
  it("lists a person's own chats only, and a runtime of another computer cannot write them", async () => {
    const mac = cloud.enrollRuntime();
    const theirs = cloud.enrollRuntime({ person: "user-2" });
    expect((await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"))).status).toBe(200);
    const other = cloud.state.chats.addPerson("user-2");
    expect((await call(cloud.state.personToken, "GET", "chats")).body!.chats.map((c: { session_id: string }) => c.session_id)).toEqual(["s1"]);
    expect((await call(other, "GET", "chats")).body!.chats).toEqual([]);
    expect((await call(other, "GET", "chats/s1/events")).status).toBe(404);
    expect((await call(other, "POST", "chats/s1/calls", { request_id: "r1", method: "turn.submit", params: {} })).status).toBe(404);
    expect((await call(theirs.token, "PUT", "runtime/chats/s1", summary("s1"))).body!.error.code).toBe("cave_code_session_elsewhere");
    expect((await call(mac.token, "PUT", "runtime/chats", { chats: [] })).status).toBe(400);
  });

  it("refuses a segment of another epoch or one that leaves a gap, and serves the copy by epoch", async () => {
    const mac = cloud.enrollRuntime();
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"));
    expect((await copy(mac.token, "s1", 1, 3)).status).toBe(200);
    expect((await copy(mac.token, "s1", 5, 6)).body!.error.code).toBe("cave_code_journal_gap");
    expect((await copy(mac.token, "s1", 4, 5, 2)).body!.error.code).toBe("cave_code_journal_epoch");
    expect((await copy(mac.token, "s1", 4, 5)).status).toBe(200);
    const read = await call(cloud.state.personToken, "GET", "chats/s1/events?epoch=1&after=1&limit=2");
    expect(read.body).toMatchObject({ epoch: 1, through: 5, more: true });
    expect(read.body!.events.map((e: { cursor: number }) => e.cursor)).toEqual([2, 3]);
    expect((await call(cloud.state.personToken, "GET", "chats/s1/events?epoch=7")).body).toMatchObject({ epoch: 1, events: [], reset: true });
    const list = await call(cloud.state.personToken, "GET", "chats");
    expect(list.body!.chats[0]).toMatchObject({ synced_through: 5, epoch: 1 });
  });

  it("resumes the stream after a seq, resets past the retained window and sends live changes", async () => {
    const mac = cloud.enrollRuntime();
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"));
    const seq = (await call(cloud.state.personToken, "GET", "chats")).body!.seq as number;
    await call(mac.token, "PUT", "runtime/chats/s2", summary("s2"));
    const controller = new AbortController();
    const response = await fetch(`${cloud.url}/api/v1/code/chats/stream?after=${seq}`, { headers: { authorization: `Bearer ${cloud.state.personToken}` }, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };
    await until("s2");
    expect(text).not.toContain('"session_id":"s1"');
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { status: "working" }));
    await until('"status":"working"');
    controller.abort();
    cloud.state.chats.retain = 1;
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"));
    await call(mac.token, "PUT", "runtime/chats/s2", summary("s2"));
    const stale = await fetch(`${cloud.url}/api/v1/code/chats/stream?after=1`, { headers: { authorization: `Bearer ${cloud.state.personToken}` } });
    const staleReader = stale.body!.getReader();
    let first = "";
    while (!first.includes("event:")) first += new TextDecoder().decode((await staleReader.read()).value);
    expect(first.startsWith(": ok")).toBe(true);
    expect(first).toContain("event: reset");
  });

  it("queues a chat's start with its placement (CONTRACT §6.8): once per person and request id, with Cloud's own placed workspace, read by its person before any summary, and failed at an acknowledgement with no answer", async () => {
    const box = cloud.enrollRuntime({ kind: "cloud" });
    const mac = cloud.enrollRuntime();
    const person = cloud.state.personToken;
    const ask = (start?: unknown, token = person, route = "workspaces") => call(token, "POST", route, { title: "Fix the build", repo: "acme/web", engine: "caveman", computer: { kind: "cloud" }, ...(start === undefined ? {} : { start }) });
    const params = { repo: { url: "https://github.com/acme/web" }, engine: "caveman", task: { text: "make the build green" } };

    // Without a start: placed and no more, and the answer names neither session nor call.
    const plain = await ask();
    expect(plain.status).toBe(201);
    expect(Object.keys(plain.body!).sort()).toEqual(["computer_id", "id"]);

    // With it: the session, the call, and the mail to the computer Cloud placed the chat on, naming Cloud's own workspace.
    const placed = await ask({ request_id: "start-1", params: { ...params, placed_workspace_id: plain.body!.id } });
    expect(placed.body).toMatchObject({ computer_id: box.computerId, start: { request_id: "start-1", method: "workspace.create", status: "queued" } });
    const { id: workspace, session_id: session } = placed.body as { id: string; session_id: string };
    expect((await call(person, "GET", `chats/${session}/calls/start-1`)).body).toMatchObject({ status: "queued", method: "workspace.create" });
    expect((await call(person, "GET", `chats/${session}/events`)).body).toMatchObject({ events: [], more: false });
    expect((await call(person, "GET", "chats")).body!.chats).toEqual([]);
    const taken = (await call(box.token, "POST", "mail/deliveries?channel=call", {})).body!;
    expect(taken.messages).toHaveLength(1);
    expect(JSON.parse(taken.messages[0].body)).toMatchObject({ session_id: session, request_id: "start-1", method: "workspace.create", user_id: "user-1", params: { ...params, placed_workspace_id: workspace } });

    // The same start again, from the person or from their Mac's runtime, is the first; other params are another start.
    expect((await ask({ request_id: "start-1", params })).body).toMatchObject({ id: workspace, session_id: session, start: { status: "delivered" } });
    expect((await ask({ request_id: "start-1", params }, mac.token, "runtime/workspaces")).body).toMatchObject({ id: workspace, session_id: session });
    expect((await ask({ request_id: "start-1", params: { ...params, engine: "codex" } })).body!.error.code).toBe("cave_code_request_id_conflict");
    expect([...cloud.state.chats.calls.values()]).toHaveLength(1);

    // What a start never is: on no Cloud computer, naming a computer, or queued by a device for a chat.
    expect((await call(person, "POST", "workspaces", { title: "x", repo: "acme/web", engine: "caveman", start: { request_id: "start-2", params } })).body!.error.code).toBe("cave_code_start_not_placed");
    expect((await ask({ request_id: "start-2", params: { ...params, computer_id: box.computerId } })).status).toBe(400);
    expect((await ask({ request_id: "", params })).status).toBe(400);
    expect((await call(person, "POST", `chats/${session}/calls`, { request_id: "start-3", method: "workspace.create", params })).body!.error.code).toBe("cave_code_call_method");

    // A runtime from before queued starts acknowledges mail it cannot read and answers nothing: the call fails then.
    expect((await call(box.token, "POST", "mail/deliveries/ack", { lease_token: taken.lease_token, ids: [taken.messages[0].id] })).body!.delivered).toHaveLength(1);
    expect((await call(person, "GET", `chats/${session}/calls/start-1`)).body).toMatchObject({ status: "failed", error: { code: "cave_code_call_unanswered" } });

    // A Cloud from before queued starts refuses the field as its strict decoder does, and places the same chat without it.
    cloud.state.chats.startUnknown = true;
    expect((await ask({ request_id: "start-4", params })).body).toMatchObject({ error: { code: "cave_bad_request", message: "Invalid JSON." } });
    expect(Object.keys((await ask()).body!).sort()).toEqual(["computer_id", "id"]);
  });

  it("queues calls once per request id, delivers them as mail to the chat's computer and keeps the first result", async () => {
    const mac = cloud.enrollRuntime();
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(box.token, "PUT", "runtime/chats/s1", summary("s1"));
    const person = cloud.state.personToken;
    const first = await call(person, "POST", "chats/s1/calls", { request_id: "r1", method: "turn.submit", params: { input: { text: "hi" } } });
    expect(first.status).toBe(202);
    expect((await call(person, "POST", "chats/s1/calls", { request_id: "r1", method: "turn.submit", params: { input: { text: "hi" } } })).body!.id).toBe(first.body!.id);
    expect((await call(person, "POST", "chats/s1/calls", { request_id: "r1", method: "turn.submit", params: { input: { text: "other" } } })).body!.error.code).toBe("cave_code_request_id_conflict");
    expect((await call(person, "POST", "chats/s1/calls", { request_id: "r2", method: "workspace.archive", params: {} })).body!.error.code).toBe("cave_code_call_method");
    // Only the chat's own computer takes it.
    expect((await call(mac.token, "POST", "mail/deliveries?channel=call", {})).body!.messages).toEqual([]);
    const waited = await call(box.token, "GET", "mail/wait?channel=call&timeout_ms=1000");
    expect(waited.body).toMatchObject({ timed_out: false });
    const taken = await call(box.token, "POST", "mail/deliveries?channel=call", {});
    expect(taken.body!.messages).toHaveLength(1);
    expect(JSON.parse(taken.body!.messages[0].body)).toMatchObject({ call_id: first.body!.id, session_id: "s1", request_id: "r1", method: "turn.submit", user_id: "user-1" });
    expect((await call(person, "GET", "chats/s1/calls/r1")).body!.status).toBe("delivered");
    await call(box.token, "POST", `runtime/chats/s1/calls/${first.body!.id}/result`, { ok: true, result: { turn_id: "t1" } });
    await call(box.token, "POST", `runtime/chats/s1/calls/${first.body!.id}/result`, { ok: false, error: { code: "x", message: "late" } });
    expect((await call(person, "GET", "chats/s1/calls/r1")).body).toMatchObject({ status: "done", result: { turn_id: "t1" } });
  });

  it("leases a call's mail for 30 s, renews it for the token that holds it, and hands it out again once the lease lapses (CHAOS-6)", async () => {
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(box.token, "PUT", "runtime/chats/s1", summary("s1"));
    const person = cloud.state.personToken;
    await call(person, "POST", "chats/s1/calls", { request_id: "r1", method: "turn.submit", params: { input: { text: "hi" } } });
    const taken = (await call(box.token, "POST", "mail/deliveries?channel=call", {})).body!;
    const id = taken.messages[0].id as string;
    const row = [...cloud.state.chats.calls.values()].find((c) => c.request_id === "r1")!;
    const firstTake = row.taken_at!;
    expect(Date.parse(taken.lease_expires_at) - Date.now()).toBeGreaterThan(25_000);
    expect(Date.parse(taken.lease_expires_at) - Date.now()).toBeLessThanOrEqual(30_000);
    // Held: no other take finds it. Renewed by its token; another token's renew loses it; a bad body is refused.
    expect((await call(box.token, "POST", "mail/deliveries?channel=call", {})).body!.messages).toEqual([]);
    cloud.state.skewMs = 20_000;
    const renewed = await call(box.token, "POST", "mail/deliveries/renew", { lease_token: taken.lease_token, ids: [id] });
    expect(renewed.body).toMatchObject({ renewed: [id], lost: [] });
    expect(Date.parse(renewed.body!.lease_expires_at) - Date.now()).toBeGreaterThan(45_000);
    expect((await call(box.token, "POST", "mail/deliveries/renew", { lease_token: "another", ids: [id] })).body).toMatchObject({ renewed: [], lost: [id] });
    expect((await call(box.token, "POST", "mail/deliveries/renew", { lease_token: taken.lease_token, ids: [] })).status).toBe(400);
    // Its holder went quiet: 30 s after the last renew it is handed out again, and the old token can no longer renew it.
    cloud.state.skewMs = 51_000;
    const again = (await call(box.token, "POST", "mail/deliveries?channel=call", {})).body!;
    expect(again.messages.map((m: { id: string }) => m.id)).toEqual([id]);
    // When it last reached a runtime (the chaos order check reads it): the take that lapsed says nothing.
    expect(row.taken_at! - firstTake).toBeGreaterThanOrEqual(51_000);
    expect((await call(box.token, "POST", "mail/deliveries/renew", { lease_token: taken.lease_token, ids: [id] })).body).toMatchObject({ renewed: [], lost: [id] });
  });

  it("takes input forwarded by the source of the chat's last move, once per request id, and refuses anyone else (CHAOS-14)", async () => {
    const mac = cloud.enrollRuntime();
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { status: "working" }));
    await follow(mac.token, "s1");
    await copy(mac.token, "s1", 1, 2);
    const forward = (token: string, request_id: string, extra: Record<string, unknown> = {}) =>
      call(token, "POST", "runtime/chats/s1/calls", { request_id, method: "turn.submit", params: { session_id: "s1", kind: "followup", input: { text: `said ${request_id}`, ...extra } } });
    // Before any move nobody is its source.
    expect((await forward(mac.token, "f0")).body!.error.code).toBe("cave_code_not_source");
    expect((await call(mac.token, "POST", "runtime/sessions/s1/handoff", { through: 2, reason: "lid" })).body).toMatchObject({ moved: true });
    const first = await forward(mac.token, "f1");
    expect(first.status).toBe(202);
    const queued = [...cloud.state.chats.calls.values()].find((c) => c.request_id === "f1")!;
    expect(queued).toMatchObject({ person: "user-1", method: "turn.submit", forwarded_by_runtime_id: mac.runtimeId });
    // Once per request id, with a device's call under the same id too.
    expect((await forward(mac.token, "f1")).body!.id).toBe(first.body!.id);
    expect((await call(cloud.state.personToken, "POST", "chats/s1/calls", { request_id: "f1", method: "turn.submit", params: { session_id: "s1", kind: "followup", input: { text: "said f1 again" } } })).body!.id).toBe(first.body!.id);
    // Only the computer the move left; text only; strict.
    expect((await forward(box.token, "f2")).body!.error.code).toBe("cave_code_not_source");
    expect((await forward(mac.token, "f3", { attachments: [{ name: "a.png" }] })).body!.error.code).toBe("cave_code_forward_attachments");
    expect((await call(mac.token, "POST", "runtime/chats/s1/calls", { request_id: "f5", method: "turn.interrupt", params: { session_id: "s1" } })).body!.error.code).toBe("cave_code_call_method");
    expect((await call(mac.token, "POST", "runtime/chats/s1/calls", { request_id: "f4", method: "turn.submit", params: {}, extra: true })).status).toBe(400);
    // At most 20 per move.
    for (let i = 0; i < 19; i++) expect((await forward(mac.token, `n${i}`)).status).toBe(202);
    expect((await forward(mac.token, "over")).body!.error.code).toBe("cave_code_too_many_forwards");
    // Said again it is the same call, and does not count.
    expect((await forward(mac.token, "n0")).status).toBe(202);
    // The chat moved on since (a later epoch): its old source may no longer forward.
    cloud.state.chats.sessions.get("s1")!.epoch += 1;
    expect((await forward(mac.token, "late")).body!.error.code).toBe("cave_code_moved_again");
    // A forward said again answers its call even after the chat moved on.
    expect((await forward(mac.token, "f1")).body!.id).toBe(first.body!.id);
    // Its call mail says who forwarded it, and carries no device.
    const mail = cloud.state.sessions.mail.find((m) => m.channel === "call" && JSON.parse(m.body ?? "{}").request_id === "f1");
    expect(JSON.parse(mail!.body!)).toMatchObject({ request_id: "f1", forwarded_by_runtime_id: mac.runtimeId });
    expect(JSON.parse(mail!.body!).device).toBeUndefined();
  });

  it("a forward to a chat on another Mac fails there unsigned, and a request id past 200 bytes is refused, a forward's or a person's", async () => {
    const mac = cloud.enrollRuntime();
    const box = cloud.enrollRuntime({ kind: "cloud" });
    const other = cloud.enrollRuntime({ name: "Mac B" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { status: "working" }));
    await follow(mac.token, "s1");
    await copy(mac.token, "s1", 1, 2);
    expect((await call(mac.token, "POST", "runtime/sessions/s1/handoff", { through: 2, reason: "lid" })).body).toMatchObject({ moved: true });
    // The Cloud computer moves it on to Mac B, which is up and accepts.
    cloud.state.chats.lastHeartbeat.set(other.runtimeId, Date.now() + 60 * 60_000);
    const moving = call(box.token, "POST", "runtime/sessions/s1/move", { to: { computer_id: other.computerId }, reason: "user" });
    let offered: string | undefined;
    for (const until = Date.now() + 5_000; offered === undefined && Date.now() < until; await new Promise((r) => setTimeout(r, 20)))
      offered = [...cloud.state.chats.moves.values()].find((m) => m.session_id === "s1" && m.target === other.computerId)?.move_id;
    expect((await call(other.token, "POST", `runtime/moves/${offered}`, { phase: "accept", ok: true })).status).toBe(204);
    expect((await moving).body).toMatchObject({ computer_id: other.computerId });
    const forward = (request_id: string) => call(box.token, "POST", "runtime/chats/s1/calls", { request_id, method: "turn.submit", params: { session_id: "s1", kind: "followup", input: { text: "handed on" } } });
    // Cloud takes it; Mac B refuses it, as no device signed it.
    expect((await forward("f1")).status).toBe(202);
    expect([...cloud.state.chats.calls.values()].find((c) => c.request_id === "f1")).toMatchObject({ status: "failed", error: { code: "device_not_approved" } });
    expect((await forward("x".repeat(201))).body).toMatchObject({ error: { code: "cave_bad_request" } });
    expect((await forward("x".repeat(200))).status).toBe(202);
    expect((await call(cloud.state.personToken, "POST", "chats/s1/calls", { request_id: "é".repeat(101), method: "turn.submit", params: { input: { text: "hi" } } })).body).toMatchObject({ error: { code: "cave_bad_request" } });
  });

  it("the lid's handoff moves a working chat to a Cloud computer at once, under a new epoch", async () => {
    const mac = cloud.enrollRuntime();
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { status: "working" }));
    await follow(mac.token, "s1");
    await copy(mac.token, "s1", 1, 2);
    const handoff = await call(mac.token, "POST", "runtime/sessions/s1/handoff", { through: 2, reason: "lid" });
    expect(handoff.body).toMatchObject({ session_id: "s1", released: true, moved: true, computer_id: box.computerId, runtime_id: box.runtimeId });
    // Said again (the answer was lost on the way): the same answer.
    expect((await call(mac.token, "POST", "runtime/sessions/s1/handoff", { through: 2, reason: "lid" })).body).toMatchObject({ moved: true, computer_id: box.computerId });
    expect((await call(box.token, "GET", "runtime/sessions/s1/journal")).body).toMatchObject({ epoch: 2, cursor_seq: 2, lease_runtime_id: null });
    const mail = (await call(box.token, "POST", "mail/deliveries?channel=move", {})).body!.messages;
    expect(JSON.parse(mail[0].body)).toMatchObject({ action: "adopt", session_id: "s1", reason: "lid", from_runtime_id: mac.runtimeId });
    // The laptop no longer holds it.
    expect((await call(mac.token, "GET", "runtime/sessions/s1/journal")).body!.error.code).toBe("cave_code_session_elsewhere");
  });

  it("a call to a chat whose laptop sleeps waits for its lease, then moves it to a Cloud computer", async () => {
    const mac = cloud.enrollRuntime();
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"));
    await follow(mac.token, "s1");
    await copy(mac.token, "s1", 1, 1);
    await call(mac.token, "PUT", "runtime/chats/s2", summary("s2", { repo: undefined }));
    const person = cloud.state.personToken;
    const queued = await call(person, "POST", "chats/s1/calls", { request_id: "r1", method: "turn.submit", params: {} });
    expect(queued.body!.waiting).toMatchObject({ reason: "laptop_asleep" });
    expect((await call(person, "POST", "chats/s2/calls", { request_id: "r2", method: "turn.submit", params: {} })).body!.waiting).toMatchObject({ reason: "not_movable" });
    cloud.state.skewMs = 2 * 60_000; // the lease lapses
    // Moved as every move is (two-phase): Cloud accepts for a computer with no runtime up, then routes the call there.
    await call(person, "GET", "chats/s1/calls/r1");
    const moved = await call(person, "GET", "chats/s1/calls/r1");
    expect(moved.body!.waiting).toBeUndefined();
    const mail = (await call(box.token, "POST", "mail/deliveries", {})).body!.messages.map((m: { channel: string }) => m.channel);
    expect(mail).toEqual(["move", "call"]);
  });

  it("a sleeping Mac's chat goes only to a Cloud computer that accepts it; while none has room, its call waits", async () => {
    const mac = cloud.enrollRuntime();
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"));
    await follow(mac.token, "s1");
    await copy(mac.token, "s1", 1, 1);
    const person = cloud.state.personToken;
    await call(person, "POST", "chats/s1/calls", { request_id: "r1", method: "turn.submit", params: {} });
    cloud.state.skewMs = 2 * 60_000; // the lease lapses
    // The box's runtime is up: Cloud asks it first.
    const offer = async () => {
      await call(box.token, "POST", "runtime/heartbeat", { active: true });
      await call(person, "GET", "chats/s1/calls/r1");
      for (let i = 0; i < 50; i++) {
        const asked = (await call(box.token, "POST", "mail/deliveries?channel=move", {})).body!.messages.map((m: { body: string }) => JSON.parse(m.body));
        if (asked.length > 0) return asked[0] as { action: string; move_id: string; session_id: string };
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("no accept mail");
    };
    const full = await offer();
    expect(full).toMatchObject({ action: "accept", session_id: "s1", reason: "asleep" });
    expect((await call(box.token, "POST", `runtime/moves/${full.move_id}`, { phase: "accept", ok: false, code: "cave_code_computer_full", message: "That Cloud computer already runs another chat." })).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Refused: the chat stays with its Mac, and the call says why it waits.
    expect(cloud.state.chats.sessions.get("s1")!.computer_id).toBe(mac.computerId);
    expect((await call(person, "GET", "chats/s1/calls/r1")).body!.waiting).toMatchObject({ reason: "laptop_asleep", detail: expect.stringMatching(/busy/) });
    expect((await call(box.token, "POST", "mail/deliveries?channel=move", {})).body!.messages).toEqual([]);
    // Offered again a little later; this time the box has room.
    cloud.state.skewMs += 6_000;
    const room = await offer();
    expect(room.move_id).not.toBe(full.move_id);
    await call(box.token, "POST", `runtime/moves/${room.move_id}`, { phase: "accept", ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cloud.state.chats.sessions.get("s1")!.computer_id).toBe(box.computerId);
    expect((await call(person, "GET", "chats/s1/calls/r1")).body!.waiting).toBeUndefined();
    const mail = (await call(box.token, "POST", "mail/deliveries", {})).body!.messages.map((m: { channel: string; body: string }) => [m.channel, JSON.parse(m.body).action ?? JSON.parse(m.body).method]);
    expect(mail).toEqual([["move", "adopt"], ["call", "turn.submit"]]);
  });

  it("a person's move mails an awake owner and moves an asleep one's chat itself", async () => {
    const mac = cloud.enrollRuntime();
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"));
    await follow(mac.token, "s1");
    await copy(mac.token, "s1", 1, 1);
    await call(mac.token, "PUT", "runtime/sessions/s1/journal", { lease_token: cloud.state.chats.sessions.get("s1")!.lease!.token, cursor_seq: 1, segments: 1, size_bytes: 1, release: true });
    await call(mac.token, "POST", "runtime/heartbeat", { active: false });
    const asked = await call(cloud.state.personToken, "POST", "chats/s1/move", { to: "cloud" });
    expect(asked).toEqual({ status: 202, body: { pending: true, computer_id: mac.computerId } });
    // As C1 mails it (MoveMail): where the person sent it (to_cloud or to_computer_id), never a runtime; This Mac checks the signature.
    const mail = JSON.parse((await call(mac.token, "POST", "mail/deliveries?channel=move", {})).body!.messages[0].body);
    expect(mail).toEqual({ action: "move", session_id: "s1", reason: "user", to_cloud: true, to: "cloud", user_id: "user-1" });
    cloud.state.skewMs = 2 * 60_000; // the Mac went quiet
    expect((await call(cloud.state.personToken, "POST", "chats/s1/move", { to: "cloud" })).body).toEqual({ pending: false, computer_id: box.computerId });
    expect(cloud.state.chats.sessions.get("s1")).toMatchObject({ computer_id: box.computerId, epoch: 2 });
  });

  // As Cloud's LidHandoff: a move its move-check did not reserve goes through moveLocked, whose targetComputer refuses a
  // Cloud computer without a login for the chat's engine there. The lid leaves a check its budget cut to this refusal.
  it("the lid's handoff of a working Claude Agent chat its check did not reserve is refused without a Cloud login, as the move-check refuses it", async () => {
    const mac = cloud.enrollRuntime();
    cloud.enrollRuntime({ kind: "cloud" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { engine: "claude-agent", status: "working" }));
    await call(mac.token, "PUT", "runtime/sessions/s1", { title: "Fix the login page", repo: "acme/web", base_branch: "main", branch: "caveman/fix-login", engine: "claude-agent", follow: true });
    await copy(mac.token, "s1", 1, 2);
    const refusal = { code: "cave_code_engine_login_needed", message: "Add your Anthropic key for Cloud computers, or sign Claude in on one." };
    expect((await call(mac.token, "POST", "runtime/sessions/s1/move-check", { to: "cloud", offer: false })).body!.error).toMatchObject(refusal);
    expect((await call(mac.token, "POST", "runtime/sessions/s1/handoff", { through: 2, reason: "lid" })).body).toMatchObject({ released: true, moved: false, refused: refusal });
    expect(cloud.state.chats.sessions.get("s1")).toMatchObject({ computer_id: mac.computerId, epoch: 1 });
    // With a key for Cloud computers it moves.
    cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
    expect((await call(mac.token, "POST", "runtime/sessions/s1/handoff", { through: 2, reason: "lid" })).body).toMatchObject({ moved: true });
  });

  it("a Claude Agent chat's move to another of the person's Macs asks no Cloud login (chats_offers.go: a laptop target skips the login lane)", async () => {
    const mac = cloud.enrollRuntime({ name: "Mac A" });
    const other = cloud.enrollRuntime({ name: "Mac B" });
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { engine: "claude-agent" }));
    await call(mac.token, "PUT", "runtime/sessions/s1", { title: "Fix the login page", repo: "acme/web", base_branch: "main", branch: "caveman/fix-login", engine: "claude-agent", follow: true });
    await copy(mac.token, "s1", 1, 1);
    await call(other.token, "POST", "runtime/heartbeat", { active: true });
    // No Cloud login for Claude: a Cloud computer is refused it, the other Mac is not.
    expect((await call(mac.token, "POST", "runtime/sessions/s1/move-check", { to: { computer_id: box.computerId }, offer: false })).body!.error.code).toBe("cave_code_engine_login_needed");
    // Only asked: where it would go, as Cloud's dryCheck says it, and nothing offered.
    expect(await call(mac.token, "POST", "runtime/sessions/s1/move-check", { to: { computer_id: other.computerId }, offer: false })).toEqual({ status: 200, body: { login: null, computer_id: other.computerId, to_kind: "laptop" } });
    // The Mac answers for its own engine's login when it is asked to accept (handlers acceptMove), not Cloud.
    const checked = call(mac.token, "POST", "runtime/sessions/s1/move-check", { to: { computer_id: other.computerId }, request_id: "r1" });
    let accept: { action: string; move_id: string; engine: string } | undefined;
    for (let i = 0; i < 100 && accept === undefined; i++) {
      accept = (await call(other.token, "POST", "mail/deliveries?channel=move", {})).body!.messages.map((m: { body: string }) => JSON.parse(m.body)).find((m: { action: string }) => m.action === "accept");
      if (accept === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(accept).toMatchObject({ action: "accept", engine: "claude-agent" });
    await call(other.token, "POST", `runtime/moves/${accept!.move_id}`, { phase: "accept", ok: true });
    expect((await checked).body).toMatchObject({ login: null, computer_id: other.computerId, to_kind: "laptop" });
    // And its computers list names the person's Macs, as Cloud's does (the source names where its chat went by it).
    cloud.state.environments.computers = true;
    const listed = (await call(mac.token, "GET", "runtime/computers?mine=true")).body!.computers as Array<{ id: string; name: string; driver: string }>;
    expect(listed.map((c) => [c.id, c.name, c.driver]).sort()).toEqual(
      [
        [mac.computerId, "Mac A", "local"],
        [other.computerId, "Mac B", "local"],
        [box.computerId, "Cloud computer", "kubernetes"],
      ].sort(),
    );
  });

  it("a move to another of the person's Macs whose runtime is not up is refused before anything is offered (moves.go targetComputer)", async () => {
    const mac = cloud.enrollRuntime({ name: "Mac A" });
    const other = cloud.enrollRuntime({ name: "Mac B" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"));
    await follow(mac.token, "s1");
    await copy(mac.token, "s1", 1, 1);
    await call(mac.token, "POST", "runtime/heartbeat", { active: true });
    const toB = { to: { computer_id: other.computerId } };
    const silent = { code: "cave_code_target_silent", message: "The computer the chat would move to did not answer: try again, or move it elsewhere." };
    // Never heard, then going to sleep: the menu's check, the check that offers, the runtime's move and the person's move are all refused.
    for (const away of [undefined, { active: true, suspending: true }]) {
      if (away) await call(other.token, "POST", "runtime/heartbeat", away);
      for (const [token, route, body] of [
        [mac.token, "runtime/sessions/s1/move-check", { ...toB, offer: false }],
        [mac.token, "runtime/sessions/s1/move-check", { ...toB, request_id: "r1" }],
        [mac.token, "runtime/sessions/s1/move", toB],
        [cloud.state.personToken, "chats/s1/move", toB],
      ] as const) {
        const out = await call(token, "POST", route, body);
        expect([route, out.status, out.body!.error]).toMatchObject([route, 409, silent]);
      }
    }
    expect([...cloud.state.chats.moves.values()].filter((m) => m.target === other.computerId)).toEqual([]);
    expect((await call(other.token, "POST", "mail/deliveries?channel=move", {})).body!.messages).toEqual([]);
    expect(cloud.state.chats.sessions.get("s1")!.computer_id).toBe(mac.computerId);
    // Awake again: it is asked.
    await call(other.token, "POST", "runtime/heartbeat", { active: true });
    expect(await call(mac.token, "POST", "runtime/sessions/s1/move-check", { ...toB, offer: false })).toEqual({ status: 200, body: { login: null, computer_id: other.computerId, to_kind: "laptop" } });
  });

  it("a person's move of a chat to another Mac while the chat's own Mac is not up is refused; to Cloud it still moves (chats_moves.go MoveChat)", async () => {
    const mac = cloud.enrollRuntime({ name: "Mac A" });
    const other = cloud.enrollRuntime({ name: "Mac B" });
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"));
    await follow(mac.token, "s1");
    await copy(mac.token, "s1", 1, 1);
    await call(mac.token, "PUT", "runtime/sessions/s1/journal", { lease_token: cloud.state.chats.sessions.get("s1")!.lease!.token, cursor_seq: 1, segments: 1, size_bytes: 1, release: true });
    // Mac A went quiet with no lease; Mac B is up.
    await call(mac.token, "POST", "runtime/heartbeat", { active: false });
    cloud.state.skewMs = 2 * 60_000;
    await call(other.token, "POST", "runtime/heartbeat", { active: true });
    const out = await call(cloud.state.personToken, "POST", "chats/s1/move", { to: { computer_id: other.computerId }, request_id: "r1", device: { device_id: "phone", at: new Date().toISOString(), signature: "c2lnbmVk" } });
    expect([out.status, out.body!.error]).toEqual([
      409,
      { code: "cave_code_source_asleep", message: "The chat's Mac is not up: a chat moves to another Mac only from its own Mac while that Mac is up. Wake it, then move the chat again." },
    ]);
    expect([...cloud.state.chats.moves.values()].filter((m) => m.target === other.computerId)).toEqual([]);
    expect((await call(other.token, "POST", "mail/deliveries?channel=move", {})).body!.messages).toEqual([]);
    expect(cloud.state.chats.sessions.get("s1")!.computer_id).toBe(mac.computerId);
    expect((await call(cloud.state.personToken, "POST", "chats/s1/move", { to: "cloud" })).body).toEqual({ pending: false, computer_id: box.computerId });
  });

  it("a chat a Mac took from a Cloud computer made for it but could not adopt goes to another Cloud computer once that one is gone", async () => {
    const box = cloud.enrollRuntime({ kind: "cloud", name: "Box" });
    const mac = cloud.enrollRuntime({ name: "Mac A" });
    cloud.state.environments.computers = true;
    await call(box.token, "PUT", "runtime/chats/s1", summary("s1"));
    await follow(box.token, "s1");
    await copy(box.token, "s1", 1, 1);
    await call(box.token, "POST", "runtime/heartbeat", { active: true });
    await call(mac.token, "POST", "runtime/heartbeat", { active: true });
    const checked = call(box.token, "POST", "runtime/sessions/s1/move-check", { to: { computer_id: mac.computerId }, request_id: "r1" });
    let accept: { action: string; move_id: string } | undefined;
    for (let i = 0; i < 100 && accept === undefined; i++) {
      accept = (await call(mac.token, "POST", "mail/deliveries?channel=move", {})).body!.messages.map((m: { body: string }) => JSON.parse(m.body)).find((m: { action: string }) => m.action === "accept");
      if (accept === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await call(mac.token, "POST", `runtime/moves/${accept!.move_id}`, { phase: "accept", ok: true });
    expect((await checked).status).toBe(200);
    await call(box.token, "PUT", "runtime/sessions/s1/journal", { lease_token: cloud.state.chats.sessions.get("s1")!.lease!.token, cursor_seq: 1, segments: 1, size_bytes: 1, release: true });
    expect((await call(box.token, "POST", "runtime/sessions/s1/move", { to: { computer_id: mac.computerId }, move_id: accept!.move_id })).status).toBe(200);
    expect(cloud.state.chats.sessions.get("s1")!.computer_id).toBe(mac.computerId);
    // The computer made for the chat goes once the chat left it (C1 place), its runtime with it; the Mac cannot adopt.
    cloud.state.chats.computers.get(box.computerId)!.state = "deleted";
    cloud.state.skewMs = 2 * 60_000;
    await call(mac.token, "POST", "runtime/heartbeat", { active: true });
    expect((await call(mac.token, "POST", `runtime/moves/${accept!.move_id}`, { phase: "adopt", ok: false, code: "cave_code_adopt_failed", message: "no clone" })).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const now = cloud.state.chats.sessions.get("s1")!.computer_id;
    expect([now === box.computerId, now === mac.computerId, cloud.state.chats.computers.get(now)?.kind, cloud.state.chats.computers.get(now)?.state === "deleted"]).toEqual([false, false, "cloud", false]);
  });

  it("moves only a chat its runtime registered to move: a builder its summary registered is refused (M-4)", async () => {
    const mac = cloud.enrollRuntime();
    const box = cloud.enrollRuntime({ kind: "cloud" });
    await call(mac.token, "PUT", "runtime/chats/lead", summary("lead", { status: "working" }));
    await follow(mac.token, "lead");
    await copy(mac.token, "lead", 1, 2);
    await call(mac.token, "PUT", "runtime/chats/builder", summary("builder", { status: "working", kind: "builder", parent_session_id: "lead" }));
    await copy(mac.token, "builder", 1, 2);
    const kept = await call(mac.token, "POST", "runtime/sessions/builder/handoff", { through: 2, reason: "lid" });
    expect(kept.body).toMatchObject({ released: true, moved: false, refused: { code: "cave_code_session_not_movable" } });
    expect((await call(mac.token, "POST", "runtime/sessions/builder/move", { to: "cloud", reason: "user" })).body!.error.code).toBe("cave_code_session_not_movable");
    expect((await call(cloud.state.personToken, "POST", "chats/builder/move", { to: "cloud" })).body!.error.code).toBe("cave_code_session_not_movable");
    expect((await call(mac.token, "POST", "runtime/sessions/lead/handoff", { through: 2, reason: "lid" })).body).toMatchObject({ moved: true, computer_id: box.computerId });
    // Follow off clears it.
    await call(box.token, "PUT", "runtime/sessions/lead", { title: "t", repo: "acme/web", base_branch: "main", branch: "b", engine: "caveman", follow: false });
    expect(cloud.state.chats.sessions.get("lead")!.movable_flag).toBeUndefined();
  });

  it("tells every device where a chat can run and where it is going, as Cloud does: the runtime's word narrowed by Cloud's own, a move read against the person's computers and only while its runtime is heard, and a Cloud from before the fields takes none (CONTRACT §11)", async () => {
    const mac = cloud.enrollRuntime();
    const other = cloud.enrollRuntime({ name: "Studio" });
    const box = cloud.enrollRuntime({ kind: "cloud" });
    const theirs = cloud.enrollRuntime({ person: "user-2" });
    const person = cloud.state.personToken;
    const chatOf = async (id: string) => ((await call(person, "GET", "chats")).body!.chats as Array<Record<string, any>>).find((c) => c.session_id === id)!;
    const put = (id: string, extra: Record<string, unknown>) => call(mac.token, "PUT", `runtime/chats/${id}`, summary(id, extra));
    await call(mac.token, "POST", "runtime/heartbeat", { active: true });

    // A runtime from before the fields says none: a device reads none.
    expect((await put("s1", {})).status).toBe(200);
    for (const field of ["movable", "stays", "moving"]) expect(await chatOf("s1")).not.toHaveProperty(field);
    // Its runtime calls it movable, and Cloud has not registered it to move: it stays, in Cloud's own word.
    await put("s1", { movable: true });
    expect(await chatOf("s1")).toMatchObject({ movable: false, stays: { code: "not_saved" } });
    await follow(mac.token, "s1");
    expect(await chatOf("s1")).toMatchObject({ movable: true });
    expect(await chatOf("s1")).not.toHaveProperty("stays");
    // It stays, for the runtime's own code; with none said, "other". A code that is a sentence is refused, by name.
    await put("s1", { movable: false, stays: { code: "folder" } });
    expect(await chatOf("s1")).toMatchObject({ movable: false, stays: { code: "folder" } });
    await put("s1", { movable: false });
    expect(await chatOf("s1")).toMatchObject({ movable: false, stays: { code: "other" } });
    const sentence = await put("s1", { movable: false, stays: { code: "Folder chats stay on this Mac" } });
    expect([sentence.status, sentence.body!.error.message]).toEqual([400, expect.stringContaining("stays.code")]);

    // A move asked for when the turn ends: on the list, and the stream said so as it was written.
    const since = new Date(1_700_000_000_000).toISOString();
    await put("s1", { movable: true, status: "working", moving: { to: "cloud", waiting_turn: true, since } });
    expect((await chatOf("s1")).moving).toEqual({ to: "cloud", waiting_turn: true, since });
    // Where it goes is read against Cloud's own computers: another Mac of the person's by its id, a Cloud computer of
    // theirs as "cloud", a colleague's computer and one nobody has not at all; a place that is neither is refused.
    for (const [to, want] of [[other.computerId, other.computerId], [box.computerId, "cloud"], [theirs.computerId, undefined], ["0b1f6c1e-52f6-4f0e-8a51-6b7c8d9e0f1a", undefined]] as const) {
      expect((await put("s1", { movable: true, moving: { to, waiting_turn: false, since } })).status).toBe(200);
      expect((await chatOf("s1")).moving).toEqual(want === undefined ? undefined : { to: want, waiting_turn: false, since });
    }
    const nowhere = await put("s1", { movable: true, moving: { to: "the moon", waiting_turn: false, since } });
    expect([nowhere.status, nowhere.body!.error.message]).toEqual([400, expect.stringContaining("moving.to")]);
    // Its runtime goes quiet: the move it reported is gone with it (the heartbeat bounds it), and back once it is heard.
    await put("s1", { movable: true, moving: { to: "cloud", waiting_turn: true, since } });
    cloud.state.skewMs = 2 * 60_000;
    expect(await chatOf("s1")).not.toHaveProperty("moving");
    await call(mac.token, "POST", "runtime/heartbeat", { active: true });
    expect((await chatOf("s1")).moving).toMatchObject({ to: "cloud", waiting_turn: true });
    // Cloud's own move, whoever started it: to the Mac it goes to, by that Mac's id, and no longer waiting.
    cloud.state.chats.openMoves.set("s1", { to_computer_id: other.computerId, since });
    expect((await chatOf("s1")).moving).toEqual({ to: other.computerId, waiting_turn: false, since });
    cloud.state.chats.openMoves.delete("s1");
    // The move ended: the next summary says none.
    await put("s1", { movable: true });
    expect(await chatOf("s1")).not.toHaveProperty("moving");

    // A Cloud from before the three fields refuses a summary naming any (its strict decoder), and takes it without.
    cloud.state.chats.placeFactsUnknown = true;
    const refused = cloud.state.chats.refused.length;
    for (const extra of [{ movable: true }, { stays: { code: "folder" } }, { moving: { to: "cloud", waiting_turn: false, since } }]) {
      const answer = await put("s1", extra);
      expect([answer.status, answer.body!.error.message]).toEqual([400, "Invalid JSON."]);
    }
    expect(cloud.state.chats.refused).toHaveLength(refused + 3);
    expect((await put("s1", {})).status).toBe(200);
  });

  it("names one runtime a Cloud computer and none while it sleeps, says when a used-up plan resets, and gives a waiting call the code of why its chat stays (CONTRACT §11)", async () => {
    const mac = cloud.enrollRuntime();
    const box = cloud.enrollRuntime({ kind: "cloud" });
    const person = cloud.state.personToken;
    const list = async () => (await call(person, "GET", "chats")).body!;
    const chatOf = async (id: string) => ((await list()).chats as Array<Record<string, any>>).find((c) => c.session_id === id)!;
    const runtimesOf = async (computerId: string) => ((await list()).runtimes as Array<Record<string, any>>).filter((r) => r.computer_id === computerId).map((r) => r.runtime_id);
    await call(box.token, "POST", "runtime/heartbeat", { active: true });
    await call(box.token, "PUT", "runtime/chats/s1", summary("s1"));

    // Awake: its one runtime, on the list and on its chat. A second identity for the same computer (the next boot's)
    // that was never heard changes nothing.
    const next = cloud.enrollRuntime({ kind: "cloud", computerId: box.computerId });
    expect(await runtimesOf(box.computerId)).toEqual([box.runtimeId]);
    expect((await chatOf("s1")).runtime_id).toBe(box.runtimeId);
    expect(await chatOf("s1")).toMatchObject({ where: { kind: "cloud" } });
    expect((await chatOf("s1")).where).not.toHaveProperty("sleep_reason");
    // Asleep: no runtime anywhere, and the chat still names its computer. Asleep because the plan is used up: where
    // says so, and when the plan resets once Cloud knows; so does the computer's own row.
    const computer = cloud.state.chats.computers.get(box.computerId)!;
    computer.state = "suspended";
    expect(await runtimesOf(box.computerId)).toEqual([]);
    expect(await chatOf("s1")).toMatchObject({ runtime_id: null, computer_id: box.computerId });
    expect((await chatOf("s1")).where).not.toHaveProperty("sleep_reason");
    computer.sleep_reason = "usage";
    expect((await chatOf("s1")).where).toEqual({ kind: "cloud", name: "Cloud computer", sleep_reason: "usage" });
    computer.resets_at = "2026-11-14T09:00:00.000Z";
    expect((await chatOf("s1")).where).toEqual({ kind: "cloud", name: "Cloud computer", sleep_reason: "usage", resets_at: "2026-11-14T09:00:00.000Z" });
    expect(cloud.computersOf("user-1").find((c) => c.id === box.computerId)).toMatchObject({ sleep_reason: "usage", resets_at: "2026-11-14T09:00:00.000Z" });
    // Nothing of the plan but the reason and the time: no amount under any key of either answer.
    expect(JSON.stringify([await chatOf("s1"), cloud.computersOf("user-1")])).not.toMatch(/usd|micros|pct|percent|gib|minute|price|balance/i);
    // Woken on the next boot's identity: that one, once it is the one heard.
    computer.state = "running";
    delete computer.sleep_reason;
    await call(next.token, "POST", "runtime/heartbeat", { active: true });
    cloud.state.skewMs = 1_000;
    await call(next.token, "POST", "runtime/heartbeat", { active: true });
    expect(await runtimesOf(box.computerId)).toEqual([next.runtimeId]);
    expect((await chatOf("s1")).runtime_id).toBe(next.runtimeId);
    // A Mac's runtimes are listed as before.
    expect(await runtimesOf(mac.computerId)).toEqual([mac.runtimeId]);

    // A message for a chat on a sleeping Mac that cannot move waits, and says why as the chat's own stays code, or
    // Cloud's word when its runtime said none.
    await call(mac.token, "PUT", "runtime/chats/s2", summary("s2", { movable: false, stays: { code: "folder" } }));
    await call(mac.token, "PUT", "runtime/chats/s3", summary("s3"));
    const waits = async (id: string) => (await call(person, "POST", `chats/${id}/calls`, { request_id: `r-${id}`, method: "turn.submit", params: {} })).body!.waiting;
    expect(await waits("s2")).toMatchObject({ reason: "not_movable", code: "folder", detail: expect.any(String) });
    expect(await waits("s3")).toMatchObject({ reason: "not_movable", code: "not_saved" });
    expect((await chatOf("s2")).calls[0].waiting).toMatchObject({ reason: "not_movable", code: "folder" });
  });

  it("decodes as strictly as Cloud: an unknown field or a wrong type is a 400, on every chat route", async () => {
    const mac = cloud.enrollRuntime();
    const refused = cloud.state.chats.refused;
    expect((await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { colour: "blue" }))).status).toBe(400);
    expect((await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { head: "7" }))).status).toBe(400);
    expect((await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { needs_you: { kind: "question", summary: "?", extra: 1 } }))).status).toBe(400);
    expect((await call(mac.token, "PUT", "runtime/sessions/s1", { title: "t", repo: "acme/web", engine: "caveman", follow: true, model: "x" })).status).toBe(400);
    expect((await call(mac.token, "PUT", "runtime/chats", { chats: [summary("s1")], extra: true })).status).toBe(400);
    expect(refused.map((r) => r.route)).toEqual(["summary", "summary", "summary", "register", "summaries"]);
    expect((await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"))).body).toEqual({ session_id: "s1", seq: expect.any(Number) });
    expect((await call(mac.token, "POST", "runtime/sessions/s1/handoff", { through: 0, reason: "lid", budget_ms: 10 })).status).toBe(400);
    expect((await call(cloud.state.personToken, "PUT", "chats/s1/state", { seen_cursor: 1, colour: "red" })).status).toBe(400);
    expect((await call(cloud.state.personToken, "POST", "chats/s1/calls", { request_id: "r1", method: "turn.submit", params: {}, model: "x" })).status).toBe(400);
    expect((await call(cloud.state.personToken, "POST", "chats/s1/move", { to: { runtime_id: "r", computer_id: "c" } })).status).toBe(400);
  });

  it("answers a batch per chat (one refused never holds back the rest), and an archived chat is a chat, not gone", async () => {
    const mac = cloud.enrollRuntime();
    const theirs = cloud.enrollRuntime({ person: "user-2" });
    await call(theirs.token, "PUT", "runtime/chats/s9", summary("s9"));
    await call(mac.token, "PUT", "runtime/chats/s2", summary("s2"));
    const batch = await call(mac.token, "PUT", "runtime/chats", { chats: [summary("s1", { session_id: "s1" }), summary("s9", { session_id: "s9" }), summary("s2", { session_id: "s2", epoch: 4 })] });
    expect(batch.status).toBe(200);
    expect(batch.body!.chats).toEqual([
      { session_id: "s1", seq: expect.any(Number) },
      { session_id: "s9", error: { code: "cave_code_session_elsewhere", message: expect.any(String) } },
      { session_id: "s2", error: { code: "cave_code_journal_epoch", message: expect.any(String) } },
    ]);
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { archived: true }));
    const change = cloud.state.chats.changes.at(-1)!;
    expect(change).toMatchObject({ event: "chat", key: "s1" });
    expect((await call(cloud.state.personToken, "GET", "chats?archived=true")).body!.chats[0]).toMatchObject({ session_id: "s1", archived: true, runtime_id: mac.runtimeId, sync: true });
  });

  it("sync off keeps the session registered and starts its copy again from cursor 1; sync true brings it back", async () => {
    const mac = cloud.enrollRuntime();
    await call(mac.token, "PUT", "runtime/chats/s1", summary("s1"));
    await copy(mac.token, "s1", 1, 3);
    expect((await call(mac.token, "DELETE", "runtime/chats/s1")).status).toBe(204);
    expect(cloud.state.chats.changes.at(-1)).toMatchObject({ event: "gone", key: "s1" });
    expect((await call(mac.token, "GET", "runtime/sessions/s1/journal")).body).toMatchObject({ epoch: 1, cursor_seq: 0, segments: 0 });
    expect((await call(cloud.state.personToken, "GET", "chats")).body!.chats).toEqual([]);
    expect((await call(mac.token, "PUT", "runtime/chats/s1", summary("s1", { sync: true }))).status).toBe(200);
    expect((await call(cloud.state.personToken, "GET", "chats")).body!.chats[0]).toMatchObject({ session_id: "s1", sync: true });
    expect((await copy(mac.token, "s1", 1, 4)).status).toBe(200);
  });
});
