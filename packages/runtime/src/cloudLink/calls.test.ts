// Only Cloud's own call mail runs (security review C1-1): a handoff Cloud posted for a person's queued call. A runtime in
// the same tree can post on the `call` channel too; such mail is acknowledged and never run, on a Cloud computer as on
// This Mac, and no result is posted for it.
import { generateKeyPairSync } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fileNote, isCloudCall, takeCalls } from "./calls.ts";
import type { Identity } from "./identity.ts";

const identity: Identity = { cloudUrl: "http://cloud.test", runtimeId: "r1", organizationId: "o1", computerId: "c1", key: generateKeyPairSync("ed25519").privateKey };
const body = (call_id: string, method = "ask.respond") =>
  JSON.stringify({ call_id, session_id: "s1", request_id: `req-${call_id}`, method, params: { session_id: "s1" }, user_id: "someone-else" });

test("a Cloud computer runs only Cloud's own call mail, acknowledges the rest and posts no result for it", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const mail = [
    { id: "m-forged-task", verb: "task", channel: "call", authority: "agent", body: body("forged-1") },
    { id: "m-forged-handoff", verb: "handoff", channel: "call", authority: "agent", body: body("forged-2") },
    { id: "m-real", verb: "handoff", channel: "call", authority: "human", body: body("real", "turn.interrupt") },
  ];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace("/api/v1/code/", "");
    requests.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const out = path === "mail/deliveries" ? { lease_token: "lease-1", messages: mail } : {};
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ran: Array<{ principal: string; method: string }> = [];
  const count = await Effect.runPromise(
    takeCalls({
      identity,
      state: { token: "ccrt_token", cloudUrl: identity.cloudUrl },
      laptop: false,
      approved: () => Effect.succeed(true),
      run: (principal, method) => Effect.sync(() => (ran.push({ principal, method }), {})),
      fetchImpl,
    }),
  );
  expect(ran).toEqual([{ principal: "cloud:someone-else", method: "turn.interrupt" }]);
  expect(requests.filter((r) => r.path.includes("/result")).map((r) => r.path)).toEqual(["runtime/chats/s1/calls/real/result"]);
  expect(requests.find((r) => r.path === "mail/deliveries/ack")!.body).toEqual({ lease_token: "lease-1", ids: ["m-forged-task", "m-forged-handoff", "m-real"] });
  expect(count).toBe(3);
  expect(isCloudCall({ verb: "handoff", channel: "call", authority: "human" })).toBe(true);
  expect(isCloudCall({ verb: "handoff", channel: "call" })).toBe(false);
});

test("a call for a chat moving off this computer, or not here yet, gets no result and no ack: its mail follows the chat (M-8)", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const call = (id: string, session: string) => ({ id: `m-${id}`, verb: "handoff", channel: "call", authority: "human", body: JSON.stringify({ call_id: id, session_id: session, request_id: `req-${id}`, method: "turn.submit", params: { session_id: session }, user_id: "u1" }) });
  const mail = [call("moving", "s-moving"), call("adopting", "s-adopting"), call("parked", "s-parked"), call("here", "s-here")];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace("/api/v1/code/", "");
    requests.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const out = path === "mail/deliveries" ? { lease_token: "lease-1", messages: mail } : {};
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ran: Array<string> = [];
  await Effect.runPromise(
    takeCalls({
      identity,
      state: { token: "ccrt_token", cloudUrl: identity.cloudUrl },
      laptop: false,
      approved: () => Effect.succeed(true),
      // s-moving: a move is letting it go; s-adopting: this computer has no such chat yet; s-parked: the person parked it here.
      place: (sessionId) => Effect.succeed(sessionId === "s-moving" ? "leaving" : sessionId === "s-adopting" ? "arriving" : "here"),
      arriveWaitMs: 100,
      run: (_principal, _method, params) =>
        Effect.gen(function* () {
          const session = (params as { session_id: string }).session_id;
          ran.push(session);
          if (session === "s-adopting") return yield* Effect.fail({ reason: "not_found", message: "no session" });
          if (session === "s-parked") return yield* Effect.fail({ reason: "parked", message: "the session is parked" });
          return {};
        }),
      fetchImpl,
    }),
  );
  // The moving chat's call never ran here; the parked one failed as parked (the person's own park), the rest ran.
  expect(ran).toEqual(["s-parked", "s-here"]);
  expect(requests.filter((r) => r.path.includes("/result")).map((r) => r.path)).toEqual(["runtime/chats/s-parked/calls/parked/result", "runtime/chats/s-here/calls/here/result"]);
  expect(requests.find((r) => r.path === "mail/deliveries/ack")!.body).toEqual({ lease_token: "lease-1", ids: ["m-parked", "m-here"] });
});

test("a lost lease is retryable even if the chat returns here before the post-call place check", async () => {
  const requests: Array<string> = [];
  const fetchImpl = (async (url: string) => {
    const at = new URL(url).pathname.replace("/api/v1/code/", "");
    requests.push(at);
    const out = at === "mail/deliveries" ? { lease_token: "lease", messages: [{ id: "mail", verb: "handoff", channel: "call", authority: "human", body: body("retry", "turn.interrupt") }] } : {};
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  let mayRun = false;
  let effects = 0;
  const input = {
    identity, state: { token: "ccrt_token", cloudUrl: identity.cloudUrl }, laptop: false,
    approved: () => Effect.succeed(true), place: () => Effect.succeed("here" as const), fetchImpl,
    run: () => mayRun ? Effect.sync(() => { effects++; return {}; }) : Effect.fail({ reason: "lease_lost", message: "ownership changed before this call could run" }),
  };
  expect(await Effect.runPromise(takeCalls(input))).toBe(0);
  expect(requests).toEqual(["mail/deliveries"]);
  expect(effects).toBe(0);
  // The same Cloud-owned mail is redelivered after its lease is released/lapses.
  mayRun = true;
  expect(await Effect.runPromise(takeCalls(input))).toBe(1);
  expect(effects).toBe(1);
  expect(requests.filter((at) => at.includes("/result"))).toEqual(["runtime/chats/s1/calls/retry/result"]);
  expect(requests.filter((at) => at.endsWith("/ack"))).toHaveLength(1);
});

test("call mail taken before a crash is finished at the next start, not after Cloud's lease lapses (CHAOS-6)", async () => {
  const note = fileNote(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "a1-calls-")), "taken.json"));
  const requests: Array<{ path: string; body: unknown }> = [];
  let offered = [{ id: "m-1", verb: "handoff", channel: "call", authority: "human", body: body("c-1", "turn.interrupt") }];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const at = new URL(url).pathname.replace("/api/v1/code/", "");
    requests.push({ path: at, body: init.body ? JSON.parse(String(init.body)) : undefined });
    // Cloud hands the mail out once; until its lease lapses a take finds nothing.
    const out = at === "mail/deliveries" ? { lease_token: offered.length > 0 ? "lease-1" : null, messages: offered } : {};
    if (at === "mail/deliveries") offered = [];
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const pass = (run: (principal: string, method: string) => Effect.Effect<unknown, { reason: string; message: string }>) =>
    takeCalls({ identity, state: { token: "ccrt_token", cloudUrl: identity.cloudUrl }, laptop: false, approved: () => Effect.succeed(true), note, run: run as never, fetchImpl });
  // The runtime dies while the call runs (the pass stops dead mid-run): nothing was answered or acknowledged.
  let started = false;
  const fiber = Effect.runFork(pass(() => Effect.sync(() => void (started = true)).pipe(Effect.andThen(Effect.never))));
  while (!started) await new Promise((r) => setTimeout(r, 5));
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(requests.filter((r) => r.path.includes("/result") || r.path === "mail/deliveries/ack")).toEqual([]);
  // The next start finishes it at once from its note: run, answered and acknowledged under the lease it was taken with.
  const ran: Array<string> = [];
  await Effect.runPromise(pass((_principal, method) => Effect.sync(() => (ran.push(method), {}))));
  expect(ran).toEqual(["turn.interrupt"]);
  expect(requests.filter((r) => r.path.includes("/result")).map((r) => r.path)).toEqual(["runtime/chats/s1/calls/c-1/result"]);
  expect(requests.find((r) => r.path === "mail/deliveries/ack")!.body).toEqual({ lease_token: "lease-1", ids: ["m-1"] });
  // Finished: the note is gone, and the pass after takes from Cloud again.
  expect(await Effect.runPromise(note.load)).toBeUndefined();
});

test("a pass renews the call mail it still holds while a call runs, and lets go of mail it leaves for Cloud", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const call = (id: string, session: string) => ({ id: `m-${id}`, verb: "handoff", channel: "call", authority: "human", body: JSON.stringify({ call_id: id, session_id: session, request_id: `req-${id}`, method: "turn.submit", params: { session_id: session }, user_id: "u1" }) });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const at = new URL(url).pathname.replace("/api/v1/code/", "");
    requests.push({ path: at, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const out = at === "mail/deliveries" ? { lease_token: "lease-1", messages: [call("moving", "s-moving"), call("slow", "s-slow")] } : at === "mail/deliveries/renew" ? { renewed: ["m-slow"], lost: [] } : {};
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await Effect.runPromise(
    takeCalls({
      identity,
      state: { token: "ccrt_token", cloudUrl: identity.cloudUrl },
      laptop: false,
      approved: () => Effect.succeed(true),
      place: (sessionId) => Effect.succeed(sessionId === "s-moving" ? "leaving" : "here"),
      renewEveryMs: 100,
      // The slow call outlasts several renewals.
      run: () => Effect.sleep("450 millis").pipe(Effect.as({})),
      fetchImpl,
    }),
  );
  const renews = requests.filter((r) => r.path === "mail/deliveries/renew").map((r) => r.body);
  expect(renews.length).toBeGreaterThanOrEqual(3);
  // Only the mail it works on is held; the moving chat's goes back to Cloud with its lease.
  for (const body of renews) expect(body).toEqual({ lease_token: "lease-1", ids: ["m-slow"] });
  const ackAt = requests.findIndex((r) => r.path === "mail/deliveries/ack");
  expect(requests[ackAt]!.body).toEqual({ lease_token: "lease-1", ids: ["m-slow"] });
  // Nothing renews once the pass is done.
  const after = requests.length;
  await new Promise((r) => setTimeout(r, 350));
  expect(requests.slice(after).filter((r) => r.path === "mail/deliveries/renew")).toEqual([]);
});

test("mail kept from before a crash whose lease lapsed meanwhile does not run here: Cloud hands it out again (CHAOS-6)", async () => {
  const note = fileNote(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "a1-calls-lapsed-")), "taken.json"));
  await Effect.runPromise(note.save({ lease_token: "lease-old", messages: [{ id: "m-1", verb: "handoff", channel: "call", authority: "human", body: body("c-1", "turn.submit") }, { id: "m-2", verb: "handoff", channel: "call", authority: "human", body: body("c-2", "turn.submit") }] }));
  const requests: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const at = new URL(url).pathname.replace("/api/v1/code/", "");
    requests.push({ path: at, body: init.body ? JSON.parse(String(init.body)) : undefined });
    // m-1's lease lapsed while the runtime was down (Cloud may have handed it to another computer); m-2's still holds.
    const out = at === "mail/deliveries/renew" ? { renewed: ["m-2"], lost: ["m-1"] } : {};
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ran: Array<string> = [];
  await Effect.runPromise(
    takeCalls({
      identity,
      state: { token: "ccrt_token", cloudUrl: identity.cloudUrl },
      laptop: false,
      approved: () => Effect.succeed(true),
      note,
      run: (_principal, _method, params) => Effect.sync(() => (ran.push((params as { request_id: string }).request_id), {})),
      fetchImpl,
    }),
  );
  expect(ran).toEqual(["req-c-2"]);
  expect(requests.find((r) => r.path === "mail/deliveries/ack")!.body).toEqual({ lease_token: "lease-old", ids: ["m-2"] });
  expect(await Effect.runPromise(note.load)).toBeUndefined();
});

test("a call whose chat is here but whose ask or run is gone is answered as failed and acknowledged, never bounced between computers (CHAOS-16)", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const mail = { id: "m-answer", verb: "handoff", channel: "call", authority: "human", body: JSON.stringify({ call_id: "answer", session_id: "s-here", request_id: "req-answer", method: "ask.respond", params: { session_id: "s-here", ask_id: "gone" }, user_id: "u1" }) };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const at = new URL(url).pathname.replace("/api/v1/code/", "");
    requests.push({ path: at, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const out = at === "mail/deliveries" ? { lease_token: "lease-1", messages: [mail] } : {};
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await Effect.runPromise(
    takeCalls({
      identity,
      state: { token: "ccrt_token", cloudUrl: identity.cloudUrl },
      laptop: false,
      approved: () => Effect.succeed(true),
      place: () => Effect.succeed("here"),
      // The ask a move cut, or one answered elsewhere: the chat is here, the ask is not.
      run: () => Effect.fail({ reason: "not_found", message: "no open ask gone" }),
      fetchImpl,
    }),
  );
  expect(requests.find((r) => r.path === "runtime/chats/s-here/calls/answer/result")!.body).toEqual({ ok: false, error: { code: "not_found", message: "no open ask gone" } });
  expect(requests.find((r) => r.path === "mail/deliveries/ack")!.body).toEqual({ lease_token: "lease-1", ids: ["m-answer"] });
});

test("only a call Cloud's own mail names as another runtime's hand-on runs as one; the same id from a device does not", async () => {
  const delivery = (id: string, extra: Record<string, unknown>) => ({
    id: `m-${id}`,
    verb: "handoff",
    channel: "call",
    authority: "human",
    body: JSON.stringify({ call_id: id, session_id: "s1", request_id: "forwarded:r9:agent.U2VuZGVy:mail:1", method: "turn.submit", params: { session_id: "s1", input: { text: "hi" } }, user_id: "u1", ...extra }),
  });
  const mail = [delivery("handed-on", { forwarded_by_runtime_id: "r9" }), delivery("device", { device_id: "phone" })];
  const fetchImpl = (async (url: string) => {
    const at = new URL(url).pathname.replace("/api/v1/code/", "");
    const out = at === "mail/deliveries" ? { lease_token: "lease-1", messages: mail } : {};
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ran: Array<unknown> = [];
  await Effect.runPromise(
    takeCalls({
      identity,
      state: { token: "ccrt_token", cloudUrl: identity.cloudUrl },
      laptop: false,
      approved: () => Effect.succeed(true),
      run: (_principal, _method, _params, via) => Effect.sync(() => (ran.push(via ?? "none"), {})),
      fetchImpl,
    }),
  );
  expect(ran).toEqual([{ forwardedBy: "r9" }, "none"]);
});

/** One pass over `mail`, as a runtime that is a laptop or a Cloud computer: what ran, and what Cloud was told. */
async function pass(mail: ReadonlyArray<unknown>, options: { laptop?: boolean; place?: (sessionId: string, method?: string) => "here" | "leaving" | "arriving" } = {}) {
  const requests: Array<{ path: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const at = new URL(url).pathname.replace("/api/v1/code/", "");
    requests.push({ path: at, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(at === "mail/deliveries" ? { lease_token: "lease-1", messages: mail } : {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ran: Array<{ principal: string; method: string; params: unknown; via: unknown }> = [];
  const asked: Array<string> = [];
  await Effect.runPromise(
    takeCalls({
      identity: { ...identity, userId: "u1" },
      state: { token: "ccrt_token", cloudUrl: identity.cloudUrl },
      laptop: options.laptop === true,
      approved: () => Effect.succeed(true),
      ...(options.place ? { place: (sessionId: string, method?: string) => Effect.sync(() => (asked.push(`${sessionId}:${method}`), options.place!(sessionId, method))) } : {}),
      arriveWaitMs: 50,
      run: (principal, method, params, via) => Effect.sync(() => (ran.push({ principal, method, params, via }), { id: "w1", session_id: "s-placed" })),
      fetchImpl,
    }),
  );
  const results = requests.filter((r) => r.path.endsWith("/result"));
  const acked = (requests.find((r) => r.path === "mail/deliveries/ack")?.body as { ids: Array<string> } | undefined)?.ids ?? [];
  return { ran, results, acked, asked };
}
const queued = (id: string, method: string, params: Record<string, unknown>, session = "s-placed") => ({
  id: `m-${id}`,
  verb: "handoff",
  channel: "call",
  authority: "human",
  body: JSON.stringify({ call_id: id, session_id: session, request_id: `req-${id}`, method, params, user_id: "u1" }),
});
const START = { repo: { url: "https://github.com/acme/api" }, engine: "caveman", task: { text: "make the build green" }, placed_workspace_id: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" };

test("a chat's start Cloud queued with its placement runs on its Cloud computer: workspace.create as the person, under the start's request id, as the session Cloud placed", async () => {
  // Its chat is not made yet, so no record says where it is: the place is asked with the method, and says here.
  const { ran, results, acked, asked } = await pass([queued("start", "workspace.create", START)], { place: (_session, method) => (method === "workspace.create" ? "here" : "arriving") });
  expect(asked).toEqual(["s-placed:workspace.create"]);
  expect(ran).toEqual([{ principal: "cloud:u1", method: "workspace.create", params: { ...START, request_id: "req-start" }, via: { placedSession: "s-placed" } }]);
  expect(results).toEqual([{ path: "runtime/chats/s-placed/calls/start/result", body: { ok: true, result: { id: "w1", session_id: "s-placed" } } }]);
  expect(acked).toEqual(["m-start"]);
});

test("a queued start waits in Cloud while a stop stands on its computer: no result and no ack, so it runs once the computer is back", async () => {
  const { ran, results, acked } = await pass([queued("start", "workspace.create", START)], { place: () => "leaving" });
  expect([ran, results, acked]).toEqual([[], [], []]);
});

test("a queued start never runs on a Mac, nor without the workspace Cloud placed for it: each is answered with a code", async () => {
  const onMac = await pass([queued("start", "workspace.create", START)], { laptop: true });
  expect(onMac.ran).toEqual([]);
  expect(onMac.results.map((r) => r.body)).toEqual([{ ok: false, error: { code: "unsupported", message: "A chat Caveman placed starts on its Cloud computer, not on a Mac." } }]);
  expect(onMac.acked).toEqual(["m-start"]);
  const { placed_workspace_id: _none, ...unplaced } = START;
  for (const params of [unplaced, { ...unplaced, placed_workspace_id: "" }]) {
    const out = await pass([queued("start", "workspace.create", params)]);
    expect(out.ran).toEqual([]);
    expect(out.results.map((r) => r.body.error.code)).toEqual(["invalid_params"]);
    expect(out.acked).toEqual(["m-start"]);
  }
});

test("a method this runtime does not run from Cloud's queue is answered method_not_found, never dropped unread, and the calls beside it run", async () => {
  // A Cloud newer than this runtime queued it. Its device reads the code and does what it did before the method.
  const { ran, results, acked, asked } = await pass([queued("newer", "workspace.fork_everything", { session_id: "s1" }, "s1"), queued("send", "turn.submit", { session_id: "s1" }, "s1")], { place: () => "here" });
  expect(ran.map((r) => r.method)).toEqual(["turn.submit"]);
  expect(results.map((r) => [r.path, r.body.ok, r.body.error?.code])).toEqual([
    ["runtime/chats/s1/calls/newer/result", false, "method_not_found"],
    ["runtime/chats/s1/calls/send/result", true, undefined],
  ]);
  expect(acked).toEqual(["m-newer", "m-send"]);
  // Where its chat is is never asked for a call that will not run.
  expect(asked).toEqual(["s1:turn.submit"]);
});
