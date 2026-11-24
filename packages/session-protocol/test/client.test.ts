// The client against an in-process fake runtime (tests only).
import { getEventListeners, once } from "node:events";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
// Fake timers leave node:timers/promises alone, so until() keeps polling while a test runs the client's clock.
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import {
  CallNotSent,
  CallTimeout,
  connect,
  LEGACY_RUNTIME,
  MIN_CLIENT_REVISION,
  PROTOCOL_REVISION,
  type RuntimeHello,
  versionSkew,
  type Client,
  type ConnectOptions,
  memoryOutbox,
  type OutboxEntry,
  OUTBOX_KEPT_AHEAD_MS,
  OUTBOX_MAX_AGE_MS,
  type SubscriptionState,
  type ConnectionState,
  ConnectionClosed,
  ErrorCodes,
  SessionProtocolError,
  type SessionEvent,
  SUBPROTOCOL,
  type TokenSource,
} from "../src/index.ts";

const at = "2026-10-14T12:00:00.000Z";
const session = {
  id: "s1",
  workspace_id: "w1",
  engine: "caveman",
  state: "live",
  head: 0,
  created_at: at,
  updated_at: at,
};
const delta = (cursor: number): SessionEvent => ({
  session_id: "s1",
  cursor,
  at,
  type: "message.delta",
  payload: { text: String(cursor) },
});

/** The bearer from the Authorization header or the browser subprotocol, and which one carried it. */
const bearerOf = (req: IncomingMessage): [string, "header" | "subprotocol"] | undefined => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return [header.slice(7), "header"];
  const offered = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const bearer = offered.find((p) => p.startsWith("base64url.bearer."));
  return bearer ? [Buffer.from(bearer.slice(17), "base64url").toString(), "subprotocol"] : undefined;
};

const fakeRuntime = async () => {
  const journal: SessionEvent[] = [];
  const attached = new Set<ServerSocket>();
  const tokens = new WeakMap<ServerSocket, string>();
  const valid = new Set(["secret"]);
  const attachCursors: number[] = [];
  const attachEpochs: Array<number | undefined> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const authVia: string[] = [];
  const submitted = new Map<string, { params: string; result: unknown }>();
  let submitExecutions = 0;
  let dropBeforeReplying = false;
  let refuseAttach: string | undefined;
  let legacy = false;
  /** runtime.hello's answer; undefined plays a runtime from before it (-32601), a refusal is sent as an error. */
  let helloAnswer: unknown;
  let epoch = 1;
  const muted = new Set<string>();
  /** Plays a laptop runtime behind the relay (S13): a challenge first, and nothing served before device.hello. */
  let challenge = false;
  /**
   * Kept across stop() and start(), and picked below every OS's ephemeral range (Linux's starts at 32768, macOS's and
   * Windows' at 49152): while this runtime is down, no outgoing connection and no port-0 server, in this file or one
   * running beside it, is handed its port. It listens on 127.0.0.1, where the clients dial it: on every address, another
   * process could listen on 127.0.0.1 at the same port (macOS allows both) and get every connection.
   */
  let port = 0;
  let wss: WebSocketServer;
  const notify = (ws: ServerSocket, event: SessionEvent) =>
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: event }));

  const start = async () => {
    for (;;) {
      const at = port || 10_000 + Math.floor(Math.random() * 22_000);
      wss = new WebSocketServer({
        host: "127.0.0.1",
        port: at,
        // ws selects the first offered subprotocol, which is the client's SUBPROTOCOL.
        verifyClient: ({ req }, done) => {
          const bearer = bearerOf(req);
          if (bearer && valid.has(bearer[0])) done(true);
          else done(false, 401, "Unauthorized");
        },
      });
      try {
        await once(wss, "listening");
        port = at;
        break;
      } catch (error) {
        // Taken when it first starts: another one.
        if (port !== 0 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    wss.on("connection", (ws, req) => {
      if (challenge) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "device.challenge", params: { nonce: "n-1", runtime_id: "rt-mac" } }));
      let hello = !challenge;
      const [token, via] = bearerOf(req)!;
      tokens.set(ws, token);
      authVia.push(`${via}:${ws.protocol}`);
      ws.on("close", () => attached.delete(ws));
      ws.on("message", (raw) => {
        const { id, method, params } = JSON.parse(String(raw));
        calls.push({ method, params });
        const reply = (body: object) => ws.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
        const fail = (reason: keyof typeof ErrorCodes) =>
          reply({ error: { code: ErrorCodes[reason], message: reason, data: { reason } } });
        if (!valid.has(tokens.get(ws)!)) return fail("unauthorized"); // expired mid-connection
        if (muted.has(method)) return; // a stuck handler: never answers
        if (method === "device.hello") {
          hello = params.signature === "signed:n-1";
          return reply({ result: { status: hello ? "approved" : "refused" } });
        }
        if (!hello) return fail("forbidden");
        if (method === "runtime.hello") {
          if (helloAnswer === undefined) return reply({ error: { code: -32601, message: `unknown method ${method}` } });
          if (typeof helloAnswer === "string") return fail(helloAnswer as keyof typeof ErrorCodes);
          return reply({ result: helloAnswer });
        }
        if (method === "session.attach") {
          if (refuseAttach) return fail(refuseAttach as keyof typeof ErrorCodes);
          attachCursors.push(params.cursor);
          attachEpochs.push(params.epoch);
          attached.add(ws);
          // §1: another epoch, or a cursor past the head, is a rewritten journal: replay all of it.
          const reset = !legacy && ((params.epoch !== undefined && params.epoch !== epoch) || params.cursor > journal.length);
          const from = reset ? 0 : params.cursor;
          reply({ result: { session: { ...session, head: journal.length }, ...(legacy ? {} : { epoch, reset }) } });
          // Backlog, deliberately starting two events early: the client must dedupe. Batched when asked,
          // in frames of two, unless this plays a runtime from before `batch`.
          const backlog = journal.slice(Math.max(0, from - 2));
          if (params.batch === true && !legacy) {
            for (let i = 0; i < backlog.length; i += 2) {
              ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session.events", params: { session_id: "s1", events: backlog.slice(i, i + 2) } }));
            }
          } else for (const event of backlog) notify(ws, event);
        } else if (method === "session.detach") {
          attached.delete(ws);
          reply({ result: {} });
        } else if (method === "turn.submit") {
          const seen = submitted.get(params.request_id);
          const { request_id: _, ...rest } = params;
          if (seen && seen.params !== JSON.stringify(rest)) return fail("request_id_conflict");
          if (!seen) {
            submitExecutions++;
            submitted.set(params.request_id, {
              params: JSON.stringify(rest),
              result: { turn_id: `t${submitExecutions}`, disposition: "started" },
            });
          }
          if (dropBeforeReplying) {
            dropBeforeReplying = false;
            return ws.terminate(); // the effect happened, the reply is lost
          }
          reply({ result: submitted.get(params.request_id)!.result });
        } else {
          reply({ result: {} });
        }
      });
    });
  };
  const stop = async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
  };
  await start();

  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    attachCursors,
    attachEpochs,
    epoch: () => epoch,
    challengeFirst: () => (challenge = true),
    /** A handler that never answers this method. */
    mute: (method: string) => muted.add(method),
    /**
     * The journal rewritten under a new epoch (a move back, a lost tail rebuilt from Cloud's copy): attached
     * connections get `session.ended` journal_reset, as §1 says.
     */
    rewrite(texts: string[]) {
      epoch++;
      journal.splice(0, journal.length, ...texts.map((text, i): SessionEvent => ({ ...delta(i + 1), type: "message.delta", payload: { text } })));
      for (const ws of attached) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session.ended", params: { session_id: "s1", error: { code: -32017, message: "journal_reset", data: { reason: "journal_reset" } } } }));
      }
      attached.clear();
    },
    /** The runtime ends the attachment itself with this reason. */
    endAttachments(reason: keyof typeof ErrorCodes) {
      for (const ws of attached) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session.ended", params: { session_id: "s1", error: { code: ErrorCodes[reason], message: reason, data: { reason } } } }));
      }
      attached.clear();
    },
    /** Loses the last n events (a lost WAL tail) without telling anyone. */
    loseTail: (n: number) => journal.splice(journal.length - n, n),
    calls,
    authVia,
    valid,
    executions: () => submitExecutions,
    dropNextReply: () => (dropBeforeReplying = true),
    refuseAttach: (reason: string | undefined) => (refuseAttach = reason),
    /** Plays a runtime from before `batch`: the backlog comes one session.event at a time. */
    beLegacy: () => (legacy = true),
    /** What runtime.hello answers from now on: a RuntimeHello, a refusal's reason, or undefined for -32601. */
    answerHello: (answer: unknown) => (helloAnswer = answer),
    append(text: string) {
      const event: SessionEvent = { ...delta(journal.length + 1), type: "message.delta", payload: { text } };
      journal.push(event);
      for (const ws of attached) notify(ws, event);
    },
    /** Write an event to the journal without delivering it live. */
    appendQuietly: () => journal.push(delta(journal.length + 1)),
    /** Send one event out of order, skipping the cursor in between. */
    sendRaw(event: SessionEvent) {
      for (const ws of attached) notify(ws, event);
    },
    sendFrame: (raw: string) => wss.clients.forEach((ws) => ws.send(raw)),
    dropConnections: () => wss.clients.forEach((ws) => ws.terminate()),
    stop,
    start,
    close: stop,
  };
};

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const setup = async (token: TokenSource = "secret", options?: ConnectOptions) => {
  const server = await fakeRuntime();
  const states: ConnectionState[] = [];
  const client: Client = connect(server.url, token, (state) => states.push(state), options);
  cleanups.push(() => client.close(), () => server.close());
  return { server, client, states };
};
/** When the running test started (performance.now(), not Date.now(): a test may run Date on the client's fake clock). */
let testStarted = 0;
beforeEach(() => void (testStarted = performance.now()));
/**
 * Waits for `check`, however long a loaded machine takes. It gives up only 5 s short of the repo's 60 s test timeout, a
 * hang detector: a wait that never ends then fails naming what it waited for, and stops polling.
 */
const until = async (check: () => boolean) => {
  while (!check()) {
    if (performance.now() - testStarted > 55_000) throw new Error(`still waiting, 55 s into the test, for ${String(check)}`);
    await sleep(10);
  }
};
/**
 * Runs the client's timers on a fake clock: `runUntil` moves it 10 ms at a time, each step only once the client's last
 * attempt has ended on the real network, so its retries and deadlines are measured in its own time, however slow the
 * machine.
 */
const clientClock = (states: ConnectionState[]) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  cleanups.unshift(() => vi.useRealTimers()); // before anything is closed
  const count = (...of: ConnectionState[]) => states.filter((s) => of.includes(s)).length;
  return {
    count,
    runUntil: async (done: () => boolean) => {
      for (;;) {
        await until(() => count("closed", "open") === count("connecting"));
        if (done()) return;
        vi.advanceTimersByTime(10);
        await sleep(1);
      }
    },
  };
};

test.each([
  "not json", "null", "[]", "42",
  '{"jsonrpc":"2.0","method":"session.events","params":{}}',
  '{"jsonrpc":"2.0","method":"session.events","params":{"events":[null]}}',
  '{"jsonrpc":"2.0","method":"session.event","params":null}',
  '{"jsonrpc":"2.0","method":"session.event","params":{"session_id":"s1","cursor":1}}',
])("malformed inbound frame does not crash or advance a subscription: %s", async (raw) => {
  const { server, client } = await setup();
  const seen: number[] = [];
  const sub = await client.attach("s1", 0, (event) => seen.push(event.cursor));
  server.sendFrame(raw);
  server.append("still alive");
  await until(() => seen.length === 1);
  expect(seen).toEqual([1]);
  expect(sub.cursor()).toBe(1);
  await expect(client.call("engine.list", {})).resolves.toEqual({});
});

test("reconnect resumes from the last cursor with no loss or duplication", async () => {
  const { server, client } = await setup();
  ["a", "b", "c"].forEach(server.append);
  const seen: number[] = [];
  const sub = await client.attach("s1", 0, (event) => seen.push(event.cursor));
  expect(sub.session.id).toBe("s1");
  await until(() => seen.length === 3);

  server.dropConnections();
  server.append("d"); // written while the client is away
  server.append("e");
  await until(() => seen.length === 5);
  server.append("f"); // live again
  await until(() => seen.length === 6);

  expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  expect(sub.cursor()).toBe(6);
  expect(server.attachCursors).toEqual([0, 3]);
  expect(server.authVia[0]).toBe("header:"); // Node sends a header, never ?token=
});

test("the backlog arrives batched, or one event at a time from a runtime from before batch", async () => {
  for (const legacy of [false, true]) {
    const { server, client } = await setup();
    if (legacy) server.beLegacy();
    ["a", "b", "c", "d", "e"].forEach(server.append);
    const seen: number[] = [];
    await client.attach("s1", 2, (event) => seen.push(event.cursor));
    await until(() => seen.length === 3);
    server.append("f");
    await until(() => seen.length === 4);
    expect(seen).toEqual([3, 4, 5, 6]);
    expect(server.calls.find((c) => c.method === "session.attach")?.params).toMatchObject({ cursor: 2, batch: true });
  }
});

test("the client comes back after the runtime is down for a while (Node fires only `error`)", async () => {
  const { server, client, states } = await setup();
  server.append("a");
  const seen: number[] = [];
  await client.attach("s1", 0, (event) => seen.push(event.cursor));
  await until(() => seen.length === 1);

  await server.stop();
  const answer = client.call("engine.list", {}); // asked while the runtime is down
  server.appendQuietly(); // written during the outage
  server.appendQuietly();
  await sleep(700); // several refused attempts
  await server.start();

  await expect(answer).resolves.toEqual({});
  await until(() => seen.length === 3);
  expect(seen).toEqual([1, 2, 3]);
  expect(states.filter((s) => s === "open").length).toBe(2);
});

test("a runtime on this computer that is still starting is reached as soon as it listens", async () => {
  const server = await fakeRuntime();
  await server.stop(); // its port waits for start()
  const states: ConnectionState[] = [];
  const clock = clientClock(states);
  const client = connect(server.url, "secret", (state) => states.push(state));
  cleanups.push(() => client.close(), () => server.close());
  const answer = client.call("engine.list", {});
  const started = Date.now();
  await clock.runUntil(() => Date.now() - started >= 800); // past the attempts a backing-off client makes at 0, 250 and 750 ms
  const listening = Date.now();
  await server.start();
  await clock.runUntil(() => states.includes("open"));
  await answer;
  // A backed-off client would try again at 1750 ms, 950 ms after the runtime listened.
  expect(Date.now() - listening).toBeLessThanOrEqual(50);
});

test("a gap in the stream makes the client re-attach instead of skipping", async () => {
  const { server, client } = await setup();
  server.append("a");
  const seen: number[] = [];
  await client.attach("s1", 0, (event) => seen.push(event.cursor));
  await until(() => seen.length === 1);

  server.append("b"); // cursor 2, delivered
  server.sendRaw(delta(4));
  await until(() => server.attachCursors.length === 2);
  server.append("c");
  await until(() => seen.length === 3);
  expect(seen).toEqual([1, 2, 3]);
  expect(server.attachCursors).toEqual([0, 2]);
});

test("a hole the runtime never fills ends the subscription instead of stalling or storming", async () => {
  const { server, client } = await setup();
  server.append("a");
  const seen: number[] = [];
  const errors: SessionProtocolError[] = [];
  await client.attach("s1", 0, (event) => seen.push(event.cursor), (error) => errors.push(error));
  await until(() => seen.length === 1);

  // Cursor 2 is missing for good. Every re-attach replays [1] only, and the next live event leaves the hole again: it is
  // sent once the runtime has the re-attach, since holes that come while one is out are one hole.
  for (let holes = 1; holes <= 5 && errors.length === 0; holes++) {
    server.sendRaw(delta(3));
    await until(() => server.attachCursors.length > holes || errors.length > 0);
  }
  expect(errors).toHaveLength(1);
  expect(errors[0]!.error.data?.reason).toBe("internal");
  expect(seen).toEqual([1]);
  expect(server.attachCursors.length).toBeLessThanOrEqual(5);
  await until(() => server.calls.some((c) => c.method === "session.detach"));
});

test("a refused re-attach ends the subscription with the reason", async () => {
  const { server, client } = await setup();
  server.append("a");
  const errors: SessionProtocolError[] = [];
  await client.attach("s1", 0, () => undefined, (error) => errors.push(error));
  server.refuseAttach("lease_lost"); // the session moved to another computer
  server.dropConnections();
  await until(() => errors.length === 1);
  expect(errors[0]!.error.data?.reason).toBe("lease_lost");
  // Ended means ended: no further re-attach on the next reconnect.
  const attaches = server.calls.filter((c) => c.method === "session.attach").length;
  server.dropConnections();
  await client.call("engine.list", {});
  expect(server.calls.filter((c) => c.method === "session.attach").length).toBe(attaches);
});

test("a transient re-attach failure is retried with backoff", async () => {
  const { server, client } = await setup();
  server.append("a");
  const seen: number[] = [];
  const errors: unknown[] = [];
  await client.attach("s1", 0, (event) => seen.push(event.cursor), (e) => errors.push(e));
  await until(() => seen.length === 1);
  server.refuseAttach("internal");
  server.dropConnections();
  server.append("b");
  await sleep(400);
  server.refuseAttach(undefined);
  await until(() => seen.length === 2);
  expect(errors).toEqual([]);
});

test("two subscriptions to one session: each gets every event, one detach leaves the other", async () => {
  const { server, client } = await setup();
  ["a", "b"].forEach(server.append);
  const a: number[] = [];
  const b: number[] = [];
  const subA = await client.attach("s1", 0, (event) => a.push(event.cursor));
  await until(() => a.length === 2);
  const subB = await client.attach("s1", 0, (event) => b.push(event.cursor));
  await until(() => b.length === 2);
  await subA.detach();
  expect(server.calls.some((c) => c.method === "session.detach")).toBe(false);
  server.append("c");
  await until(() => b.length === 3);
  expect(a).toEqual([1, 2]);
  expect(b).toEqual([1, 2, 3]);
  await subB.detach();
  expect(server.calls.filter((c) => c.method === "session.detach").length).toBe(1);
});

test("a mutating call whose reply was lost runs once and resolves after reconnect", async () => {
  const { server, client } = await setup();
  const params = {
    request_id: "r-1",
    session_id: "s1",
    kind: "followup" as const,
    input: { text: "now add tests" },
  };
  server.dropNextReply();
  await expect(client.call("turn.submit", params)).resolves.toEqual({
    turn_id: "t1",
    disposition: "started",
  });
  expect(server.executions()).toBe(1);

  const conflict = client.call("turn.submit", { ...params, input: { text: "something else" } });
  await expect(conflict).rejects.toBeInstanceOf(SessionProtocolError);
  await expect(conflict).rejects.toMatchObject({ error: { data: { reason: "request_id_conflict" } } });
  expect(server.executions()).toBe(1);
});

test("a 401 upgrade or an unauthorized reply gets a fresh token from the token function", async () => {
  let current = "stale";
  let asked = 0;
  const { server, client } = await setup(() => (asked++, current));
  const first = client.call("engine.list", {}); // the upgrade with "stale" is refused with 401
  await sleep(100);
  current = "secret";
  await expect(first).resolves.toEqual({});
  expect(asked).toBeGreaterThanOrEqual(2);

  // The token expires mid-connection: the call is resent once on a fresh one.
  server.valid.clear();
  server.valid.add("fresh");
  current = "fresh";
  await expect(client.call("engine.list", {})).resolves.toEqual({});
});

test("unauthorized surfaces when there is no fresh token", async () => {
  // A fixed token that expires mid-connection.
  const { server, client, states } = await setup("secret");
  await client.call("engine.list", {});
  server.valid.clear();
  const call = client.call("engine.list", {});
  await expect(call).rejects.toMatchObject({ error: { code: ErrorCodes.unauthorized, data: { reason: "unauthorized" } } });
  expect(states).toContain("unauthorized");

  // A token function that throws (signed out of Cloud).
  const states2: ConnectionState[] = [];
  const signedOut = connect(server.url, () => Promise.reject(new Error("signed out")), (s) => states2.push(s));
  cleanups.push(() => signedOut.close());
  await expect(signedOut.call("engine.list", {})).rejects.toMatchObject({
    error: { code: ErrorCodes.unauthorized, data: { reason: "unauthorized" } },
  });
  expect(states2).toContain("unauthorized");
});

test("browsers carry the token in a subprotocol, and screencasts come back after a reconnect", async () => {
  const g = globalThis as { window?: unknown };
  g.window = globalThis; // take the browser branch
  cleanups.push(() => delete g.window);
  const { server, client } = await setup();
  await client.call("browser.screencast", { workspace_id: "w1", enabled: true, max_fps: 4 });
  expect(server.authVia).toEqual([`subprotocol:${SUBPROTOCOL}`]);

  server.dropConnections();
  const screencasts = () => server.calls.filter((c) => c.method === "browser.screencast");
  await until(() => screencasts().length === 2);
  expect(screencasts()[1]!.params).toEqual({ workspace_id: "w1", enabled: true, max_fps: 4 });

  await client.call("browser.screencast", { workspace_id: "w1", enabled: false });
  server.dropConnections();
  await until(() => server.authVia.length === 3);
  await client.call("engine.list", {});
  expect(screencasts().length).toBe(3); // the disabled one stays off
});

test("a client that leaves screencasts to its caller turns none back on after a reconnect", async () => {
  const { server, client, states } = await setup("secret", { restoreScreencasts: false });
  await client.call("browser.screencast", { workspace_id: "w1", enabled: true, max_fps: 4 });
  server.dropConnections();
  await until(() => states.filter((s) => s === "open").length === 2);
  await client.call("engine.list", {});
  expect(server.calls.filter((c) => c.method === "browser.screencast")).toHaveLength(1);
});

test("an attempt the runtime never answers is dropped and retried", async () => {
  // Accepts TCP and never answers the upgrade, like a runtime whose routes are not installed yet.
  const held: Socket[] = [];
  const tcp = createTcpServer((socket) => void held.push(socket));
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const client = connect(`ws://127.0.0.1:${(tcp.address() as AddressInfo).port}/session/v1`, "secret");
  cleanups.push(() => client.close(), () => { for (const s of held) s.destroy(); tcp.close(); });
  await until(() => held.length >= 2);
});

test("a slow but healthy handshake still opens: the attempt cap grows", async () => {
  // Answers every upgrade after 3.5 s, longer than the first 3 s cap.
  const http = createHttpServer();
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => SUBPROTOCOL });
  http.on("upgrade", (req, socket, head) => {
    setTimeout(() => {
      if (!socket.destroyed) wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", () => undefined));
    }, 3_500);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const states: ConnectionState[] = [];
  const client = connect(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/session/v1`, "secret", (s) => states.push(s));
  cleanups.push(() => client.close(), () => { wss.close(); http.closeAllConnections(); http.close(); });
  await until(() => states.includes("open"));
});

test("an empty token sends no bearer (a same-origin cookie authenticates) and relay close codes reach onState", async () => {
  const g = globalThis as { window?: unknown };
  g.window = globalThis; // the browser branch
  cleanups.push(() => delete g.window);
  const offered: string[] = [];
  const codes = [4404, 4401];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });
  cleanups.push(() => wss.close());
  wss.on("connection", (ws, req) => {
    offered.push(String(req.headers["sec-websocket-protocol"]));
    const code = codes.shift();
    if (code !== undefined) ws.close(code, code === 4401 ? "sign in again" : "runtime not connected");
  });
  await once(wss, "listening");
  const states: Array<[ConnectionState, number | undefined]> = [];
  const client = connect(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, "", (state, error) =>
    states.push([state, error instanceof ConnectionClosed ? error.code : undefined]),
  );
  cleanups.push(() => client.close());
  await until(() => offered.length === 3 && states.some(([s]) => s === "open"));
  expect(offered).toEqual([SUBPROTOCOL, SUBPROTOCOL, SUBPROTOCOL]);
  expect(states.filter(([, code]) => code !== undefined)).toEqual([
    ["closed", 4404],
    ["unauthorized", 4401],
  ]);
});

test("a refused upgrade reaches onState as 1006", async () => {
  const server = createHttpServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => server.close());
  const codes: number[] = [];
  const client = connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, "t", (state, error) => {
    if (state === "closed" && error instanceof ConnectionClosed) codes.push(error.code);
  });
  cleanups.push(() => client.close());
  await until(() => codes.length >= 1);
  expect(codes[0]).toBe(1006);
});

test("a call made as the connection says open goes out once", async () => {
  const server = await fakeRuntime();
  let opens = 0;
  const client: Client = connect(server.url, "secret", (state) => {
    if (state !== "open") return;
    // runtime.tsx refreshes its lists on every "open"; connectDirect's channel client attaches each chat on its first.
    void client.call("engine.list", {});
    if (++opens === 1) void client.attach("s1", 0, () => undefined);
  });
  cleanups.push(() => client.close(), () => server.close());
  await until(() => server.calls.length >= 2);
  server.dropConnections();
  await until(() => opens === 2);
  await client.call("workspace.list", {});
  // The second socket's attach is the client's own re-attach of s1.
  expect(server.calls.map((c) => c.method).filter((m) => m !== "runtime.hello")).toEqual(["engine.list", "session.attach", "engine.list", "session.attach", "workspace.list"]);
});

// ------------------------------------------------------------ epochs (§1)

test("a rewritten journal (journal_reset) drops what the client holds and replays the new epoch from the start", async () => {
  const { server, client } = await setup();
  ["a", "b", "c"].forEach(server.append);
  const seen: string[] = [];
  const resets: number[] = [];
  const ended: unknown[] = [];
  const sub = await client.attach("s1", 0, (event) => seen.push(`${event.cursor}:${(event.payload as { text: string }).text}`), {
    onReset: (epoch) => {
      resets.push(epoch);
      seen.length = 0;
    },
    onError: (error) => ended.push(error),
  });
  await until(() => seen.length === 3);
  expect(sub.epoch?.()).toBe(1);

  server.rewrite(["x", "y"]); // the chat came back from Cloud: cursors 1..2 are different events now
  await until(() => seen.length === 2);
  expect(resets).toEqual([2]);
  expect(seen).toEqual(["1:x", "2:y"]);
  expect(sub.epoch?.()).toBe(2);
  // It re-attached on the epoch it had, and the runtime said reset.
  expect(server.attachEpochs.at(-1)).toBe(1);
  server.append("z");
  await until(() => seen.length === 3);
  expect(seen[2]).toBe("3:z");
  expect(ended).toEqual([]);
});

test("attaching with a cache from an old epoch resets before anything is delivered", async () => {
  const { server, client } = await setup();
  server.rewrite(["x", "y", "z"]); // epoch 2
  const seen: number[] = [];
  const resets: number[] = [];
  // A cache that held cursors 1..5 of epoch 1.
  await client.attach("s1", 5, (event) => seen.push(event.cursor), { epoch: 1, onReset: (epoch) => resets.push(epoch) });
  await until(() => seen.length === 3);
  expect(resets).toEqual([2]);
  expect(seen).toEqual([1, 2, 3]);
  expect(server.attachEpochs).toEqual([1]);
});

test("a cursor past the head (a lost tail) resets even on a runtime from before epochs", async () => {
  const { server, client } = await setup();
  server.beLegacy();
  ["a", "b", "c", "d", "e"].forEach(server.append);
  const seen: number[] = [];
  const resets: number[] = [];
  await client.attach("s1", 0, (event) => seen.push(event.cursor), { onReset: (epoch) => (resets.push(epoch), (seen.length = 0)) });
  await until(() => seen.length === 5);
  server.loseTail(3); // the runtime lost cursors 3..5 and writes new ones there
  server.dropConnections();
  await sleep(50);
  server.append("c2");
  await until(() => seen.length === 3);
  expect(resets).toEqual([0]);
  expect(seen).toEqual([1, 2, 3]);
});

test("the runtime ending a subscription for another reason ends it with that reason", async () => {
  const { server, client } = await setup();
  server.append("a");
  const ended: SessionProtocolError[] = [];
  const seen: number[] = [];
  await client.attach("s1", 0, (event) => seen.push(event.cursor), { onError: (error) => ended.push(error) });
  await until(() => seen.length === 1);
  server.endAttachments("lease_lost");
  await until(() => ended.length === 1);
  expect(ended[0]!.error.data?.reason).toBe("lease_lost");
  // Ended means ended: a reconnect does not quietly attach it again.
  const attaches = server.attachCursors.length;
  server.dropConnections();
  await sleep(600);
  expect(server.attachCursors.length).toBe(attaches);
});

test("a subscription says when it is reconnecting and when it is live again", async () => {
  const { server, client } = await setup();
  server.append("a");
  const states: SubscriptionState[] = [];
  const seen: number[] = [];
  await client.attach("s1", 0, (event) => seen.push(event.cursor), { onState: (state) => states.push(state) });
  expect(states).toEqual(["live"]);
  await server.stop();
  await until(() => states.at(-1) === "reconnecting");
  await server.start();
  await until(() => states.at(-1) === "live");
  expect(states).toEqual(["live", "reconnecting", "live"]);
});

// ------------------------------------------------------------ deadlines

test("a call the runtime never answers fails with a clear error instead of hanging", async () => {
  const { server, client, states } = await setup();
  server.mute("workspace.list");
  await until(() => states.includes("open"));
  // Its deadline runs on a fake clock, so it is measured in the client's time, however slow the machine.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  cleanups.unshift(() => vi.useRealTimers());
  let error: unknown;
  void client.call("workspace.list", {}, { timeoutMs: 200 }).catch((e: unknown) => (error = e));
  await until(() => server.calls.some((c) => c.method === "workspace.list"));
  vi.advanceTimersByTime(200);
  await sleep(0);
  vi.useRealTimers();
  expect(error).toBeInstanceOf(CallTimeout);
  expect((error as CallTimeout).message).toBe("The runtime did not answer workspace.list within 0 s.");
  // The connection is still good for the next call.
  await expect(client.call("engine.list", {})).resolves.toEqual({});
});

test("a call's deadline does not run while the link is down", async () => {
  const { server, client, states } = await setup();
  await client.call("engine.list", {});
  const clock = clientClock(states);
  const up = states.length;
  await server.stop();
  await clock.runUntil(() => states.length > up); // the client noticed, and tries again
  const answer = client.call("engine.list", {}, { timeoutMs: 300 });
  const down = Date.now();
  await clock.runUntil(() => Date.now() - down >= 500); // longer than the deadline, with no socket to send on
  await server.start();
  await clock.runUntil(() => clock.count("open") === 2);
  await expect(answer).resolves.toEqual({});
});

// ------------------------------------------------------------ the outbox

const submit = (request_id: string, text: string) => ({ request_id, session_id: "s1", kind: "followup" as const, input: { text } });

test("a send left in the outbox by a closed page goes out once when the next page opens", async () => {
  const outbox = memoryOutbox();
  // The first page: its runtime is unreachable, the person sends, the page closes.
  const dead = connect("ws://127.0.0.1:9/rpc", "secret", undefined, { outbox });
  const lost = dead.call("turn.submit", submit("r1", "hello"));
  await until(() => outbox.entries.size === 1);
  dead.close();
  await expect(lost).rejects.toThrow("client closed");
  expect(outbox.entries.has("r1")).toBe(true);

  const restored: Array<[OutboxEntry, unknown]> = [];
  const { server } = await setup("secret", { outbox, onRestored: (entry, outcome) => restored.push([entry, outcome]) });
  await until(() => restored.length === 1);
  expect(server.executions()).toBe(1);
  expect(restored[0]![1]).toEqual({ result: { turn_id: "t1", disposition: "started" } });
  expect(outbox.entries.size).toBe(0);
});

test("a send whose answer was lost when the page closed runs once after reload", async () => {
  const outbox = memoryOutbox();
  const { server, client } = await setup("secret", { outbox });
  server.dropNextReply(); // it runs, the socket dies before the answer
  const first = client.call("turn.submit", submit("r1", "hello"));
  await until(() => server.executions() === 1);
  client.close(); // the page goes away before the client reconnects
  await expect(first).rejects.toThrow("client closed");
  expect(outbox.entries.has("r1")).toBe(true);

  const restored: unknown[] = [];
  const again = connect(server.url, "secret", undefined, { outbox, onRestored: (_entry, outcome) => restored.push(outcome) });
  cleanups.push(() => again.close());
  await until(() => restored.length === 1);
  expect(restored[0]).toEqual({ result: { turn_id: "t1", disposition: "started" } });
  expect(server.executions()).toBe(1);
  expect(server.calls.filter((c) => c.method === "turn.submit")).toHaveLength(2);
  expect(outbox.entries.size).toBe(0);
});

test("calls an earlier page left go out first, then new ones, in the order they were made", async () => {
  const outbox = memoryOutbox();
  await outbox.put({ request_id: "old-1", method: "turn.submit", params: submit("old-1", "first"), at: Date.now() - 2_000 });
  await outbox.put({ request_id: "old-2", method: "turn.interrupt", params: { request_id: "old-2", session_id: "s1" }, at: Date.now() - 1_000 });
  // Slow storage: the first new call takes longest to persist, and must still go out first.
  const delays = [80, 0, 30];
  const slow = { ...outbox, put: async (entry: OutboxEntry) => (await sleep(delays.shift() ?? 0), outbox.put(entry)) };
  const { server, client } = await setup("secret", { outbox: slow });
  await Promise.all([
    client.call("turn.submit", submit("new-1", "second")),
    client.call("turn.interrupt", { request_id: "new-2", session_id: "s1" }),
    client.call("turn.submit", submit("new-3", "third")),
  ]);
  await until(() => server.calls.filter((c) => "request_id" in (c.params ?? {})).length >= 5);
  expect(server.calls.filter((c) => "request_id" in (c.params ?? {})).map((c) => c.params.request_id)).toEqual(["old-1", "old-2", "new-1", "new-2", "new-3"]);
  expect(outbox.entries.size).toBe(0);
});

test("two calls made in the same millisecond go out in the order made after a reload, though the store lists equal times by request id", async () => {
  const outbox = memoryOutbox();
  // The device's store (outbox.ts kvOutbox) reads entries in key order and sorts them by `at`.
  const store = { ...outbox, load: async () => [...outbox.entries.values()].sort((a, b) => a.at - b.at || (a.request_id < b.request_id ? -1 : 1)) };
  const dead = connect("ws://127.0.0.1:9/rpc", "secret", undefined, { outbox: store });
  const now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  const calls = [dead.call("turn.submit", submit("zz-send", "fix the tests")), dead.call("turn.interrupt", { request_id: "aa-stop", session_id: "s1" })];
  Date.now = realNow;
  for (const call of calls) call.catch(() => undefined);
  await until(() => outbox.entries.size === 2);
  dead.close();

  const { server } = await setup("secret", { outbox: store });
  await until(() => outbox.entries.size === 0);
  expect(server.calls.filter((c) => "request_id" in (c.params ?? {})).map((c) => c.params.request_id)).toEqual(["zz-send", "aa-stop"]);
});

test("a call that went out elsewhere keeps the time it was made, and a call made after it is stamped past that time", async () => {
  const outbox = memoryOutbox();
  const dead = connect("ws://127.0.0.1:9/rpc", "secret", undefined, { outbox });
  // Made on a clock that ran ahead of this one (another page's, or a burst of calls in one millisecond).
  const made = Date.now() + 1_000;
  const calls = [dead.call("turn.submit", submit("handed", "fix the tests"), { wentOut: { at: made } }), dead.call("turn.interrupt", { request_id: "after", session_id: "s1" })];
  for (const call of calls) call.catch(() => undefined);
  await until(() => outbox.entries.size === 2);
  dead.close();
  expect(outbox.entries.get("handed")!.at).toBe(made);
  expect(outbox.entries.get("after")!.at).toBeGreaterThan(made);
});

test("a call that went out elsewhere with a time far ahead of this clock moves the outbox clock no further than about now", async () => {
  const outbox = memoryOutbox();
  const dead = connect("ws://127.0.0.1:9/rpc", "secret", undefined, { outbox });
  // A clock that was ten days fast when the call was made, or a damaged entry.
  const made = Date.now() + 10 * 24 * 60 * 60_000;
  const calls = [dead.call("turn.submit", submit("ahead", "fix the tests"), { wentOut: { at: made } }), dead.call("turn.interrupt", { request_id: "next", session_id: "s1" })];
  for (const call of calls) call.catch(() => undefined);
  await until(() => outbox.entries.size === 2);
  dead.close();
  expect(outbox.entries.get("ahead")!.at).toBe(made);
  expect(outbox.entries.get("next")!.at).toBeLessThanOrEqual(Date.now() + OUTBOX_KEPT_AHEAD_MS + 1);
});

test("two clients that write one outbox, as connectDirect and its relay client do, stamp their calls on one clock", async () => {
  const outbox = memoryOutbox();
  // The device's store (outbox.ts kvOutbox) reads entries in key order and sorts them by `at`.
  const store = { ...outbox, load: async () => [...outbox.entries.values()].sort((a, b) => a.at - b.at || (a.request_id < b.request_id ? -1 : 1)) };
  const first = connect("ws://127.0.0.1:9/rpc", "secret", undefined, { outbox: store });
  const second = connect("ws://127.0.0.1:9/rpc", "secret", undefined, { outbox: store });
  const now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  const calls = [
    first.call("turn.submit", submit("zz-1", "one")),
    first.call("turn.submit", submit("zz-2", "two")),
    second.call("turn.interrupt", { request_id: "aa-3", session_id: "s1" }),
  ];
  Date.now = realNow;
  for (const call of calls) call.catch(() => undefined);
  await until(() => outbox.entries.size === 3);
  first.close();
  second.close();
  expect((await store.load()).map((e) => e.request_id)).toEqual(["zz-1", "zz-2", "aa-3"]);
});

test("a mutating call says when the outbox holds it, before it goes out", async () => {
  const outbox = memoryOutbox();
  const happened: string[] = [];
  const { client } = await setup("secret", { outbox: { ...outbox, put: async (entry) => (await sleep(20), await outbox.put(entry), void happened.push(`stored ${entry.request_id}`)) } });
  await client.call("turn.submit", submit("r1", "hello"), { onKept: () => void happened.push("onKept"), onSent: () => happened.push("onSent") });
  expect(happened).toEqual(["stored r1", "onKept", "onSent"]);
  // A read is never kept, so it never says so.
  let kept = false;
  await client.call("engine.list", {}, { onKept: () => void (kept = true) });
  expect(kept).toBe(false);
});

test("a call goes out only once what its onKept keeps is kept", async () => {
  const outbox = memoryOutbox();
  const happened: string[] = [];
  const { client } = await setup("secret", { outbox });
  // The socket is open (a read went and came back), so a call not held by its onKept would go out at once.
  await client.call("engine.list", {});
  await client.call("turn.submit", submit("r1", "hello"), { onKept: async () => (await sleep(20), void happened.push("kept by the caller")), onSent: () => happened.push("onSent") });
  expect(happened).toEqual(["kept by the caller", "onSent"]);
  // One that fails to keep its own still goes out.
  await client.call("turn.submit", submit("r2", "again"), { onKept: async () => Promise.reject(new Error("store full")), onSent: () => happened.push("onSent r2") });
  expect(happened.at(-1)).toBe("onSent r2");
});

test("entries the outbox takes over after it was read (a page that has gone since left them) go out as restored ones", async () => {
  const outbox = memoryOutbox();
  let hand!: (entries: ReadonlyArray<OutboxEntry>) => void;
  const restored: string[] = [];
  const { server } = await setup("secret", {
    outbox: { ...outbox, taken: (listener) => ((hand = listener), () => undefined) },
    onRestored: (entry, outcome) => restored.push(`${entry.request_id} ${"result" in outcome ? "answered" : "failed"}`),
  });
  await sleep(50);
  expect(server.executions()).toBe(0);
  const entry: OutboxEntry = { request_id: "left", method: "turn.submit", params: submit("left", "from the page that went"), at: Date.now() };
  await outbox.put(entry);
  hand([entry]);
  await until(() => restored.length === 1);
  expect(restored).toEqual(["left answered"]);
  expect(server.executions()).toBe(1);
});

test("a client whose outbox no longer answers for its calls (the page lost its lock) sends none of them, and takes none over once closed", async () => {
  const outbox = memoryOutbox();
  let ours = true;
  let hand!: (entries: ReadonlyArray<OutboxEntry>) => boolean | void;
  const { client, server } = await setup("secret", { outbox: { ...outbox, ours: () => ours, taken: (listener) => ((hand = listener), () => undefined) } });
  await client.call("engine.list", {});
  ours = false;
  void client.call("turn.submit", submit("r1", "hello")).catch(() => undefined);
  await sleep(100);
  expect(server.executions()).toBe(0);
  // Reads still go: only what the outbox keeps waits.
  await client.call("engine.list", {});
  client.close();
  expect(hand([{ request_id: "left", method: "turn.submit", params: submit("left", "x"), at: Date.now() }])).toBe(false);
});

test("an outbox entry older than the runtime remembers request ids is not resent", async () => {
  const outbox = memoryOutbox();
  await outbox.put({ request_id: "stale", method: "turn.submit", params: submit("stale", "old"), at: Date.now() - OUTBOX_MAX_AGE_MS - 1 });
  const restored: unknown[] = [];
  const { server } = await setup("secret", { outbox, onRestored: (_entry, outcome) => restored.push(outcome) });
  await until(() => restored.length === 1);
  expect(restored[0]).toMatchObject({ error: expect.any(Error) });
  await sleep(100);
  expect(server.executions()).toBe(0);
  expect(outbox.entries.size).toBe(0);
});

test("a credential or typed text an earlier version left in the outbox is deleted at load and never sent again", async () => {
  // Versions from before outboxKeeps wrote every mutating call to the device's IndexedDB, in plain text.
  const outbox = memoryOutbox();
  await outbox.put({ request_id: "old-secret", method: "secret.set", params: { request_id: "old-secret", repo: { path: "/w" }, secrets: [{ name: "API_TOKEN", value: ("sk-" + "proj-SECRET-VALUE") }] }, at: Date.now() - 2_000 });
  await outbox.put({ request_id: "old-keys", method: "term.write", params: { request_id: "old-keys", terminal_id: "t1", data: "hunter2-sudo-password\r" }, at: Date.now() - 1_000 });
  await outbox.put({ request_id: "r1", method: "turn.submit", params: submit("r1", "hello"), at: Date.now() });
  // The runtime is out of reach after the upgrade: nothing the outbox holds is answered.
  const server = await fakeRuntime();
  await server.stop();
  const restored: Array<[string, unknown]> = [];
  const client = connect(server.url, "secret", undefined, { outbox, onRestored: (entry, outcome) => restored.push([entry.request_id, outcome]) });
  cleanups.push(() => client.close(), () => server.close());
  await expect.poll(() => [...outbox.entries.keys()]).toEqual(["r1"]);
  expect(restored).toEqual([
    ["old-secret", { error: expect.any(Error) }],
    ["old-keys", { error: expect.any(Error) }],
  ]);

  await server.start();
  await until(() => restored.length === 3);
  expect(restored[2]).toEqual(["r1", { result: { turn_id: "t1", disposition: "started" } }]);
  expect(server.calls.filter((c) => typeof c.params?.request_id === "string").map((c) => c.method)).toEqual(["turn.submit"]);
});

test("an answered call leaves the outbox, a refused one too", async () => {
  const outbox = memoryOutbox();
  const { client } = await setup("secret", { outbox });
  await client.call("turn.submit", submit("r1", "hello"));
  await expect(client.call("turn.submit", submit("r1", "changed"))).rejects.toBeInstanceOf(SessionProtocolError);
  await until(() => outbox.entries.size === 0);
});

test("a call carrying a credential or typed text never lands in the durable outbox, and still goes out across a reconnect", async () => {
  // The app's outbox is the device's IndexedDB: what is put there stays in plain text until it is answered.
  const outbox = memoryOutbox();
  const stored: OutboxEntry[] = [];
  const { server, client } = await setup("secret", { outbox: { ...outbox, put: async (entry) => (stored.push(entry), outbox.put(entry)) } });
  await client.call("engine.list", {});
  await server.stop();
  const secrets = {
    project: ("sk-" + "proj-SECRET-VALUE-1"),
    apiKey: ("sk-" + "ant-api03-PROVIDER-KEY-2"),
    grant: "ghp_MCP_CREDENTIAL_3",
    enroll: "cloud-access-token-4",
    webKey: "BSA-WEB-SEARCH-KEY-5",
    voice: "xi-VOICE-KEY-6",
    build: "BUILD-SECRET-7",
    sudo: "hunter2-sudo-password\r",
    pasted: "hunter2-pasted-into-a-page",
    typed: "hunter2-typed-on-a-cloud-desktop",
  };
  const calls = [
    client.call("secret.set", { request_id: "c1", repo: { path: "/w" }, secrets: [{ name: "API_TOKEN", value: secrets.project }] }),
    client.call("engine.account.add", { request_id: "c2", engine: "caveman", provider: "anthropic", key: secrets.apiKey }),
    client.call("credential.grant", { request_id: "c3", marketplace: "personal", name: "github", value: secrets.grant }),
    client.call("cloud.enroll", { request_id: "c4", cloud_url: "https://cloud.test", token: secrets.enroll }),
    client.call("web.keys.set", { request_id: "c5", provider: "brave", key: secrets.webKey }),
    client.call("chief.voice.key", { request_id: "c6", engine: "elevenlabs", key: secrets.voice }),
    client.call("environment.build_secret.set", { request_id: "c7", project_id: "p1", name: "NPM_TOKEN", value: secrets.build }),
    client.call("term.write", { request_id: "c8", terminal_id: "t1", data: secrets.sudo }),
    client.call("browser.input", { request_id: "c9", workspace_id: "w1", events: [{ type: "text", text: secrets.pasted }] }),
    client.call("computer.input", { request_id: "c10", workspace_id: "w1", events: [{ type: "text", text: secrets.typed }] }),
    client.call("turn.submit", submit("r1", "hello")),
  ];
  await until(() => stored.some((entry) => entry.request_id === "r1"));
  const kept = JSON.stringify(stored);
  expect(Object.entries(secrets).filter(([, value]) => kept.includes(JSON.stringify(value).slice(1, -1))).map(([what]) => what)).toEqual([]);
  expect(stored.map((entry) => entry.request_id)).toEqual(["r1"]);
  await server.start();
  await Promise.all(calls);
  const sent = server.calls.filter((c) => typeof c.params?.request_id === "string").map((c) => c.params.request_id);
  expect(sent).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "r1"]);
});

/** The desktop's token for a Cloud computer, minted by This Mac's runtime: it throws while that runtime or Cloud is away. */
const mintedToken = (failures: { left: number }) => async () => {
  if (failures.left <= 0) return "secret";
  failures.left--;
  throw new Error("cloud.client_token did not answer");
};

test("a send that went out waits in the outbox while the token function fails, and its resend runs once", async () => {
  const outbox = memoryOutbox();
  const failures = { left: 0 };
  const { server, client, states } = await setup(mintedToken(failures), { outbox });
  await client.call("engine.list", {});
  failures.left = 1;
  server.dropNextReply(); // it runs, the socket dies before the answer, and the next attempt gets no token
  await expect(client.call("turn.submit", submit("r1", "deploy it"))).resolves.toEqual({ turn_id: "t1", disposition: "started" });
  expect(states).toContain("unauthorized");
  expect(server.executions()).toBe(1);
  expect(server.calls.filter((c) => c.method === "turn.submit")).toHaveLength(2);
  expect(outbox.entries.size).toBe(0);
});

test("a send an earlier page left waits while the token function fails, and goes out once it gives a token", async () => {
  const outbox = memoryOutbox();
  await outbox.put({ request_id: "r0", method: "turn.submit", params: submit("r0", "before the reload"), at: Date.now() });
  const restored: unknown[] = [];
  const { server } = await setup(mintedToken({ left: 3 }), { outbox, onRestored: (_entry, outcome) => restored.push(outcome) });
  await until(() => restored.length === 1);
  expect(restored).toEqual([{ result: { turn_id: "t1", disposition: "started" } }]);
  expect(server.executions()).toBe(1);
  expect(outbox.entries.size).toBe(0);
});

test("a withdrawable send that never went out leaves as unsent while the token function fails, so it can go another way", async () => {
  const outbox = memoryOutbox();
  const { server, client } = await setup(mintedToken({ left: Infinity }), { outbox });
  const error = await client.call("turn.submit", submit("r1", "hello"), { unsentAfterMs: 300 }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CallNotSent);
  expect((error as CallNotSent).reason).toBe("unsent");
  expect(outbox.entries.size).toBe(0);
  expect(server.executions()).toBe(0);
});

test("a send that does not go out in time is withdrawn: out of the outbox, never sent when the runtime comes back", async () => {
  const outbox = memoryOutbox();
  const { server, client, states } = await setup("secret", { outbox });
  const sent: string[] = [];
  await until(() => states.includes("open"));
  await client.call("turn.submit", submit("r0", "while up"), { unsentAfterMs: 200, onSent: () => sent.push("r0") });
  expect(sent).toEqual(["r0"]);
  // Its window runs on the client's clock, so it is measured in the client's time, however slow the machine.
  const clock = clientClock(states);
  const up = states.length;
  await server.stop();
  await clock.runUntil(() => states.length > up); // the client noticed, and tries again in 500 ms
  let outcome: unknown = "pending";
  void client.call("turn.submit", submit("r1", "while down"), { unsentAfterMs: 200, onSent: () => sent.push("r1") }).then(
    () => (outcome = "answered"),
    (e: unknown) => (outcome = e),
  );
  const made = Date.now();
  await clock.runUntil(() => Date.now() - made >= 190);
  expect(outcome).toBe("pending");
  expect(outbox.entries.has("r1")).toBe(true);
  await clock.runUntil(() => Date.now() - made >= 210);
  expect(outcome).toBeInstanceOf(CallNotSent);
  expect((outcome as CallNotSent).reason).toBe("unsent");
  expect(outbox.entries.size).toBe(0);
  await server.start();
  await clock.runUntil(() => clock.count("open") === 2);
  await client.call("engine.list", {});
  await sleep(100);
  expect(server.calls.filter((c) => c.method === "turn.submit").map((c) => c.params.request_id)).toEqual(["r0"]);
  expect(sent).toEqual(["r0"]);
});

test("a watch or terminal attach taken back while the runtime is away is not sent when it comes back", async () => {
  const { server, client, states } = await setup();
  await client.call("engine.list", {});
  await server.stop();
  // A retry since the link was open: each one says "connecting", then "closed" once the stopped port refuses it, and
  // stays closed through its backoff, so a poll can miss "connecting" as the latest state on a loaded machine.
  await until(() => states.lastIndexOf("connecting") > states.lastIndexOf("open"));
  const back = new AbortController();
  const watch = client.call("tool.watch", { workspace_id: "w1", item_id: "i1" }, { signal: back.signal }).then(
    () => null,
    (e: unknown) => e,
  );
  const attach = client.call("term.attach", { terminal_id: "t1" });
  back.abort();
  await server.start();
  await attach;
  expect(server.calls.map((c) => c.method).filter((m) => m !== "engine.list" && m !== "runtime.hello")).toEqual(["term.attach"]);
  const error = await watch;
  expect(error).toBeInstanceOf(CallNotSent);
  expect((error as CallNotSent).reason).toBe("unsent");
});

test("a signal that outlives its calls keeps no listener for one that settled", async () => {
  const { client, states } = await setup();
  await until(() => states.includes("open"));
  const shared = new AbortController();
  await client.call("tool.watch", { workspace_id: "w1", item_id: "i1" }, { signal: shared.signal });
  const submit = (request_id: string, more: { unsentAfterMs?: number } = {}) =>
    client.call("turn.submit", { request_id, session_id: "s1", kind: "followup", input: { text: request_id } } as never, { signal: shared.signal, ...more });
  await submit("r-1");
  await submit("r-2", { unsentAfterMs: 60_000 });
  expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);
});

test("a send kept in the outbox as its client closed stays there for the next client, though its caller takes it back later", async () => {
  let land!: () => void;
  const landed = new Promise<void>((resolve) => (land = resolve));
  const entries = memoryOutbox();
  const asked: string[] = [];
  // A durable store whose write lands only once let: the client closes while it writes.
  const outbox = { ...entries, put: async (entry: OutboxEntry) => (asked.push(entry.request_id), landed.then(() => entries.put(entry))) };
  const { client, states } = await setup("secret", { outbox });
  await until(() => states.includes("open"));
  const back = new AbortController();
  const outcome = client.call("turn.submit", { request_id: "r-1", session_id: "s1", kind: "followup", input: { text: "hi" } } as never, { signal: back.signal }).then(
    () => null,
    (e: unknown) => e,
  );
  await until(() => asked.includes("r-1"));
  client.close();
  land();
  expect(await outcome).toEqual(new Error("client closed"));
  // Long after: the call is over here, and the next client resends it from the outbox.
  back.abort();
  await sleep(50);
  expect([...entries.entries.keys()]).toEqual(["r-1"]);
});

test("a withdrawable send that went out and lost its socket goes out again on one that opens in time, and runs once", async () => {
  const outbox = memoryOutbox();
  const { server, client, states } = await setup("secret", { outbox });
  await until(() => states.includes("open"));
  // On the client's clock, the reconnect 250 ms after the loss is in time however slow the machine.
  const clock = clientClock(states);
  server.dropNextReply(); // it runs, the socket dies before the answer
  const answer = client.call("turn.submit", submit("r1", "hello"), { unsentAfterMs: 2_000 });
  await until(() => server.executions() === 1);
  await server.stop();
  await server.start();
  await clock.runUntil(() => clock.count("open") === 2);
  await expect(answer).resolves.toEqual({ turn_id: "t1", disposition: "started" });
  expect(server.executions()).toBe(1);
});

test("a withdrawable send that went out and lost its socket for as long as it may wait to go out leaves: unanswered, out of the outbox, never resent", async () => {
  const outbox = memoryOutbox();
  const { server, client, states } = await setup("secret", { outbox });
  // A subscription hears the socket go when the client does: the send's window starts then.
  const link: SubscriptionState[] = [];
  await client.attach("s1", 0, () => undefined, { onState: (state) => link.push(state) });
  // The window runs on the client's clock, so it is measured in the client's time, however slow the machine.
  const clock = clientClock(states);
  server.dropNextReply(); // it runs, the socket dies before the answer
  let outcome: unknown = "pending";
  void client.call("turn.submit", submit("r1", "hello"), { unsentAfterMs: 600 }).then(
    () => (outcome = "answered"),
    (e: unknown) => (outcome = e),
  );
  await until(() => link.at(-1) === "reconnecting");
  await server.stop();
  const lost = Date.now();
  // A refused reconnect 250 ms in does not start it again.
  await clock.runUntil(() => Date.now() - lost >= 590);
  expect(outcome).toBe("pending");
  expect(outbox.entries.has("r1")).toBe(true);
  await clock.runUntil(() => Date.now() - lost >= 610);
  expect(outcome).toBeInstanceOf(CallNotSent);
  expect((outcome as CallNotSent).reason).toBe("unanswered");
  expect(outbox.entries.has("r1")).toBe(false);
  await server.start();
  await clock.runUntil(() => clock.count("open") === 2);
  await client.call("engine.list", {});
  await sleep(100);
  expect(server.calls.filter((c) => c.method === "turn.submit").map((c) => c.params.request_id)).toEqual(["r1"]);
});

test("a withdrawable call still unanswered when its client closes leaves the outbox: unanswered, or stale when `resend` says no", async () => {
  for (const resend of [true, false]) {
    const outbox = memoryOutbox();
    const { server, client, states } = await setup("secret", { outbox, resend: () => resend });
    await until(() => states.includes("open"));
    server.mute("turn.submit");
    const answer = client.call("turn.submit", submit("r1", "hello"), { unsentAfterMs: 5_000 }).then(
      () => null,
      (e: unknown) => e,
    );
    await until(() => server.calls.some((c) => c.method === "turn.submit"));
    // The pool lets the connection go (its runtime is gone, or two idle minutes passed).
    client.close();
    const error = await answer;
    expect(error).toBeInstanceOf(CallNotSent);
    expect((error as CallNotSent).reason).toBe(resend ? "unanswered" : "stale");
    expect(outbox.entries.size).toBe(0);
  }
});

test("a call that went out is not sent again once `resend` says no: after a dropped socket, or after a reload", async () => {
  const outbox = memoryOutbox();
  await outbox.put({ request_id: "old", method: "turn.submit", params: submit("old", "before the reload"), at: Date.now(), epoch: 1 });
  const asked: Array<[string, number | undefined]> = [];
  const restored: unknown[] = [];
  const { server, client } = await setup("secret", {
    outbox,
    resend: (entry) => (asked.push([entry.request_id, entry.epoch]), false),
    onRestored: (_entry, outcome) => restored.push(outcome),
  });
  await until(() => restored.length === 1);
  expect(restored[0]).toEqual({ error: new CallNotSent("turn.submit", "stale") });
  server.dropNextReply();
  const answer = client.call("turn.submit", submit("r1", "hello"), { epoch: 2 });
  await until(() => server.executions() === 1);
  const error = await answer.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CallNotSent);
  expect((error as CallNotSent).reason).toBe("stale");
  expect(asked).toEqual([
    ["old", 1],
    ["r1", 2],
  ]);
  expect(server.calls.filter((c) => c.method === "turn.submit").map((c) => c.params.request_id)).toEqual(["r1"]);
  expect(outbox.entries.size).toBe(0);
});

test("a call that went out on another connection goes out here only as a resend would, asked about with the time it was made", async () => {
  for (const allow of [true, false]) {
    const outbox = memoryOutbox();
    const asked: Array<[string, number]> = [];
    const { server, client } = await setup("secret", { outbox, resend: (entry) => (asked.push([entry.request_id, entry.at]), allow) });
    const sent: string[] = [];
    const madeAt = Date.now() - 60_000;
    const outcome = await client.call("turn.submit", submit("r1", "hello"), { wentOut: { at: madeAt }, onSent: () => sent.push("r1") }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    expect(asked).toEqual([["r1", madeAt]]);
    expect(outcome).toEqual(allow ? { result: { turn_id: "t1", disposition: "started" } } : { error: new CallNotSent("turn.submit", "stale") });
    expect(server.executions()).toBe(allow ? 1 : 0);
    // Its caller heard it go out the first time, on the other connection.
    expect(sent).toEqual([]);
    expect(outbox.entries.size).toBe(0);
  }
});

test("a withdrawable call that went out on another connection and finds no socket here leaves as unanswered, never unsent", async () => {
  const outbox = memoryOutbox();
  const { server, client } = await setup("secret", { outbox });
  await server.stop();
  await sleep(50);
  const error = await client.call("turn.submit", submit("r1", "hello"), { wentOut: { at: Date.now() }, unsentAfterMs: 200 }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CallNotSent);
  expect((error as CallNotSent).reason).toBe("unanswered");
  expect(outbox.entries.size).toBe(0);
});

// ------------------------------------------------------------ handshake (S13)

test("a handshake runs first on every socket, and calls made meanwhile wait for it", async () => {
  const server = await fakeRuntime();
  server.challengeFirst();
  const states: ConnectionState[] = [];
  let hellos = 0;
  const client = connect(server.url, "secret", (s) => states.push(s), {
    handshake: async (link) => {
      const { nonce } = (await link.next("device.challenge")) as { nonce: string };
      hellos++;
      const answer = (await link.call("device.hello", { device_id: "d1", signature: `signed:${nonce}` })) as { status: string };
      if (answer.status !== "approved") throw new Error(`device ${answer.status}`);
    },
  });
  cleanups.push(() => client.close(), () => server.close());
  await expect(client.call("workspace.list", {})).resolves.toEqual({});
  // runtime.hello goes after the handshake (a laptop answers nothing before it) and before anything else.
  expect(server.calls.map((c) => c.method)).toEqual(["device.hello", "runtime.hello", "workspace.list"]);
  server.dropConnections();
  await expect(client.call("engine.list", {})).resolves.toEqual({});
  expect(hellos).toBe(2);
  expect(server.calls.map((c) => c.method).slice(3)).toEqual(["device.hello", "runtime.hello", "engine.list"]);
});

test("a refused handshake drops the socket, says unauthorized and tries again", async () => {
  const server = await fakeRuntime();
  server.challengeFirst();
  const states: Array<[ConnectionState, string | undefined]> = [];
  let signature = "wrong";
  const client = connect(server.url, "secret", (s, e) => states.push([s, e?.message]), {
    handshake: async (link) => {
      await link.next("device.challenge");
      const answer = (await link.call("device.hello", { device_id: "d1", signature })) as { status: string };
      if (answer.status !== "approved") throw new Error(`device ${answer.status}`);
    },
  });
  cleanups.push(() => client.close(), () => server.close());
  const answer = client.call("workspace.list", {});
  await until(() => states.some(([s, m]) => s === "unauthorized" && m === "device refused"));
  expect(server.calls.map((c) => c.method)).not.toContain("workspace.list");
  signature = "signed:n-1";
  await expect(answer).resolves.toEqual({});
});

test("the fake runtime keeps its loopback port across a restart, where nothing else is handed it or can take it", async () => {
  const server = await fakeRuntime();
  cleanups.push(() => server.close());
  const port = Number(new URL(server.url).port);
  // Below every ephemeral range: while it is down, no port-0 server and no outgoing connection is handed it.
  expect(port).toBeLessThan(32_768);
  await server.stop();
  await server.start();
  expect(server.url).toBe(`ws://127.0.0.1:${port}/rpc`);
  // And no other listener takes the connections the clients make to it on 127.0.0.1.
  const intruder = createTcpServer();
  const bound = await new Promise<string>((resolve) => {
    intruder.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    intruder.listen(port, "127.0.0.1", () => resolve("bound"));
  });
  intruder.close();
  expect(bound).toBe("EADDRINUSE");
});

// ------------------------------------------------------------ another transport (S14 lane P)

test("a socket factory carries the connection instead of a WebSocket to the URL, reconnects included", async () => {
  const server = await fakeRuntime();
  const made: string[] = [];
  // Stands in for a data channel: here, a WebSocket to the same runtime, opened by the factory.
  const client = connect("direct://rt-laptop", "secret", undefined, {
    socket: (url, bearer) => {
      made.push(`${url}|${bearer}`);
      return new (WebSocket as unknown as new (u: string, i: { headers: Record<string, string> }) => WebSocket)(server.url, { headers: { authorization: `Bearer ${bearer}` } });
    },
  });
  cleanups.push(() => client.close(), () => server.close());
  await expect(client.call("engine.list", {})).resolves.toEqual({});
  server.dropConnections();
  await expect(client.call("engine.list", {})).resolves.toEqual({});
  expect(made.length).toBeGreaterThanOrEqual(2);
  expect(made[0]).toBe("direct://rt-laptop|secret");
});

// ------------------------------------------------------------------ runtime.hello (README: Versioning)

const runtimeAt = (version: string, protocol_revision: number, min_client_revision = MIN_CLIENT_REVISION): RuntimeHello => ({ version, protocol_revision, min_client_revision, capabilities: [] });

test("a runtime from before runtime.hello (-32601) reads as revision 0, and every call works as before", async () => {
  const { server, client } = await setup("secret", { clientVersion: "0.5.0" });
  const heard: RuntimeHello[] = [];
  client.onHello((hello) => heard.push(hello));
  await expect(client.call("engine.list", {})).resolves.toEqual({});
  await until(() => client.hello() !== undefined);
  expect(client.hello()).toEqual(LEGACY_RUNTIME);
  expect(heard).toEqual([LEGACY_RUNTIME]);
  // An old runtime works with this client: nothing to say.
  expect(versionSkew(client.hello()!)).toBeNull();
  // The client said which build and revision it is, first thing on the socket.
  expect(server.calls[0]).toEqual({ method: "runtime.hello", params: { client_version: "0.5.0", protocol_revision: PROTOCOL_REVISION } });
});

test("a runtime's answer is kept per connection and asked again on each: an update in between is heard", async () => {
  const { server, client } = await setup();
  server.answerHello(runtimeAt("0.4.2", PROTOCOL_REVISION));
  const heard: string[] = [];
  client.onHello((hello) => heard.push(hello.version));
  await client.call("engine.list", {});
  await until(() => client.hello()?.version === "0.4.2");
  // The computer restarted on a newer image: the next connection says so.
  server.answerHello(runtimeAt("0.5.0-nightly.20261110.1", PROTOCOL_REVISION + 1));
  server.dropConnections();
  await client.call("engine.list", {});
  await until(() => client.hello()?.version === "0.5.0-nightly.20261110.1");
  expect(heard).toEqual(["0.4.2", "0.5.0-nightly.20261110.1"]);
  expect(server.calls.filter((c) => c.method === "runtime.hello")).toHaveLength(2);
  // Never resent with the outbox or the calls in flight: one per socket.
  expect(server.calls.map((c) => c.method).filter((m) => m === "runtime.hello" || m === "engine.list")).toEqual(["runtime.hello", "engine.list", "runtime.hello", "engine.list"]);
});

test("a refused or malformed answer says nothing about the runtime and stops nothing", async () => {
  const refused = await setup();
  // An outside agent's connection whose gate turns it away, say.
  refused.server.answerHello("forbidden");
  await expect(refused.client.call("engine.list", {})).resolves.toEqual({});
  const malformed = await setup();
  malformed.server.answerHello({ version: 3, protocol_revision: -1 });
  await expect(malformed.client.call("engine.list", {})).resolves.toEqual({});
  await sleep(50);
  expect(refused.client.hello()).toBeUndefined();
  expect(malformed.client.hello()).toBeUndefined();
});

test("skew between old and new pairs: a newer runtime that needs a newer client, an older one this client can't use", () => {
  // Today every pair works: an old runtime, one at this revision, a newer one that still serves this client.
  for (const hello of [LEGACY_RUNTIME, runtimeAt("0.4.2", PROTOCOL_REVISION), runtimeAt("0.6.0", PROTOCOL_REVISION + 3)]) expect(versionSkew(hello)).toBeNull();
  // A nightly Mac runtime that needs clients of its own revision, under an older web build.
  expect(versionSkew(runtimeAt("0.6.0-nightly.20261201.1", PROTOCOL_REVISION + 1, PROTOCOL_REVISION + 1))).toBe("client_older");
  // A client that needs revision 2 (MIN_RUNTIME_REVISION raised), and a Cloud computer still on revision 1, or older.
  const client = { revision: 2, minRuntime: 2 };
  expect(versionSkew(runtimeAt("0.4.2", 1), client)).toBe("runtime_older");
  expect(versionSkew(LEGACY_RUNTIME, client)).toBe("runtime_older");
  expect(versionSkew(runtimeAt("0.5.0", 2, 2), client)).toBeNull();
});
