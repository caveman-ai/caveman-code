// The direct path's client (src/direct.ts) against an in-process fake runtime. The relay is a WebSocket to it; the
// "data channel" a fake RTCPeerConnection opens is a second WebSocket to it that speaks the direct wire (directWire.ts),
// so these tests drive the hand-overs, the call failover and the dedupe without native WebRTC. The real channel, the
// real runtime and the device check run in packages/runtime src/cloudLink/direct.integration.test.ts.
import { getEventListeners } from "node:events";
import { createServer } from "node:net";
// Fake timers leave node:timers/promises alone, so until() keeps polling while a test runs the client's clock.
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { connectDirect, type DirectClient, type DirectOptions } from "../src/direct.ts";
import { DirectReader, directMessages, directPing } from "../src/directWire.ts";
import { CallNotSent, memoryOutbox, outboxAt, type ConnectionState, type ConnectOptions, type Handshake, type Outbox, type OutboxEntry, type SubscriptionState } from "../src/index.ts";
import { fakeRtc, fakeRuntime } from "./directFakes.ts";

type FakeRuntime = Awaited<ReturnType<typeof fakeRuntime>>;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** When the running test started (performance.now(), not Date.now(): a test may run Date on a fake clock). */
let testStarted = 0;
beforeEach(() => void (testStarted = performance.now()));
/**
 * Waits for `check`, however long a loaded machine takes. It gives up only 5 s short of the repo's 60 s test timeout, a
 * hang detector: a wait that never ends then fails naming what it waited for, and stops polling.
 */
const until = async (check: () => boolean) => {
  while (!check()) {
    if (performance.now() - testStarted > 55_000) throw new Error(`still waiting, 55 s into the test, for ${String(check)}`);
    await sleep(5);
  }
};

async function setup(direct: Partial<DirectOptions> = {}, extra: { states?: ConnectionState[]; options?: ConnectOptions; runtime?: FakeRuntime } = {}) {
  const runtime = extra.runtime ?? (await fakeRuntime());
  cleanups.push(runtime.close);
  const rtc = fakeRtc(runtime.url);
  const paths: string[] = [];
  const outbox = memoryOutbox();
  const client = connectDirect(runtime.url, "secret", (state) => extra.states?.push(state), {
    outbox,
    ...extra.options,
    // The product's silence window: a short one judges a channel dead while a loaded machine is only slow. The silence
    // tests set theirs and move it on a fake clock.
    direct: { rtc: rtc.Rtc, iceServers: [], retryMs: () => 30, network: () => () => undefined, onPath: (p) => paths.push(p), ...direct },
  });
  cleanups.push(() => client.close());
  return { runtime, rtc, client, paths, outbox };
}

/** On the relay until `goDirect`: what the page sets up first lives on the relay's connection. */
async function relayFirst(extra: { states?: ConnectionState[]; options?: ConnectOptions; runtime?: FakeRuntime } = {}) {
  let allow = false;
  let changed: (online: boolean) => void = () => undefined;
  const s = await setup({ enabled: () => allow, network: (c) => ((changed = c), () => undefined) }, extra);
  await until(() => s.runtime.relay() !== undefined);
  const goDirect = async () => {
    allow = true;
    changed(true);
    await until(() => s.client.path() === "direct");
  };
  return { ...s, goDirect };
}

/**
 * A laptop's device check (device-approval.ts): nothing goes out on a socket before the runtime answers it, so a relay
 * that takes the socket and drops it (the laptop asleep) never carries a call.
 */
const deviceCheck: Handshake = async (link) => void (await link.call("device.hello", {}));

const outcomeOf = <T>(promise: Promise<T>) =>
  promise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );

/** Attaches to s1 and records every delivered cursor and subscription state. */
async function follow(client: DirectClient, from = 0) {
  const seen: number[] = [];
  const states: SubscriptionState[] = [];
  const sub = await client.attach("s1", from, (event) => seen.push(event.cursor), { onState: (s) => states.push(s) });
  return { seen, states, sub };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Direct-path retries for a test that takes the channel away: at once until `hold()`, so a first try that does not open
 * in time on a loaded machine is tried again, then not for a minute, so no new channel comes while the test looks.
 */
function holdRetries() {
  let held = false;
  return { retryMs: () => (held ? 60_000 : 30), hold: () => void (held = true) };
}

/**
 * The relay's sockets, made as the client makes its own: `heard()` once the client has heard each of them go (these
 * listeners run just before the client's).
 */
function relaySockets() {
  const made: Array<{ gone: boolean }> = [];
  const socket = (url: string, bearer: string) => {
    const ws = new (WebSocket as unknown as new (u: string, i: { headers: Record<string, string> }) => WebSocket)(url, { headers: { authorization: `Bearer ${bearer}` } });
    const mine = { gone: false };
    made.push(mine);
    for (const event of ["close", "error"]) ws.addEventListener(event, () => (mine.gone = true));
    return ws;
  };
  return { socket, heard: () => made.every((s) => s.gone) };
}

/**
 * The channel's liveness pings run on a fake clock (`setInterval` and `Date`; timeouts stay real): its silence window is
 * measured in the client's time, however slow the machine, and passes only as `quiet(ms)` moves it.
 */
function fakePingClock() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  cleanups.push(() => vi.useRealTimers());
  return { quiet: (ms: number) => vi.advanceTimersByTime(ms) };
}

test("comes up on the relay, then moves calls and a subscription to the direct path by cursor", async () => {
  const { runtime, client, paths, rtc } = await setup();
  for (let i = 0; i < 3; i++) runtime.append();
  const { seen, states } = await follow(client);
  await until(() => client.path() === "direct");
  expect(paths).toEqual(["direct"]);
  expect(runtime.offers).toHaveLength(1);
  // The offer went over the relay with the platform's SDP; the runtime's answer and candidates came back the same way.
  expect(runtime.offers[0]!.sdp).toBe("v=0 fake-offer");
  expect(rtc.peers[0]!.remote).toBe(`answer-for-${runtime.offers[0]!.id}`);
  expect(rtc.peers[0]!.config.iceServers).toEqual([]);
  // The subscription followed: the relay let go of it, the channel carries it.
  await until(() => runtime.direct()?.attached.has("s1") === true && runtime.relay()?.attached.has("s1") === false);
  runtime.append();
  await until(() => seen.length === 4);
  expect(seen).toEqual(range(1, 4));
  expect(states).not.toContain("reconnecting");
  expect(await client.call("engine.list", {})).toMatchObject({ via: "direct" });
});

test("the channel dies mid-stream: back to the relay with nothing lost or twice, then direct again", async () => {
  const { runtime, client, rtc, paths } = await setup();
  const { seen, states } = await follow(client);
  await until(() => client.path() === "direct" && runtime.direct()?.attached.has("s1") === true);
  // Events keep coming while the channel is cut and the subscription moves.
  const pump = setInterval(() => runtime.append(), 2);
  await until(() => seen.length >= 20);
  rtc.peers[0]!.channel!.kill();
  await until(() => client.path() === "relay");
  await until(() => seen.length >= 60);
  await until(() => client.path() === "direct");
  await until(() => seen.length >= 100);
  clearInterval(pump);
  await until(() => seen.length === runtime.journal.length);
  expect(seen).toEqual(range(1, runtime.journal.length));
  expect(paths).toEqual(["direct", "relay", "direct"]);
  // Subscribers never heard the hand-overs.
  expect(states).not.toContain("reconnecting");
  expect(rtc.peers).toHaveLength(2);
});

test("a mutating call cut off with its channel goes again on the relay, same request id, run once", async () => {
  const { runtime, client, rtc, outbox } = await setup();
  await until(() => client.path() === "direct");
  // The channel goes silent (its answers lost), then dies with the call out.
  runtime.state.silentDirect = true;
  const answer = client.call("turn.submit", { request_id: "r-1", session_id: "s1", kind: "followup", input: { text: "hi" } } as never);
  // While out on the channel it waits in the durable outbox, as a relayed one would.
  await until(() => outbox.entries.has("r-1"));
  rtc.peers[0]!.channel!.kill();
  await expect(answer).resolves.toEqual({ turn_id: "t-r-1", disposition: "started" });
  expect(runtime.executions).toEqual(["r-1"]);
  await until(() => !outbox.entries.has("r-1"));
});

test("a withdrawable call cut off with its channel while the relay is down too leaves in its window: unanswered, out of the outbox", async () => {
  // The client hears the relay go before the channel (the hand-over finds no socket), or after it (the hand-over goes out
  // on a relay socket that is dead already): either way its window counts from the moment it has no path left.
  for (const relayHeardFirst of [true, false]) {
    const relay = relaySockets();
    const retries = holdRetries();
    // A device check, so a relay that takes the socket and drops it never carries the call again.
    const { runtime, client, rtc, outbox } = await setup({ retryMs: retries.retryMs }, { options: { handshake: deviceCheck, socket: relay.socket } });
    await until(() => client.path() === "direct");
    runtime.state.silentDirect = true;
    let outcome: unknown = "pending";
    void client.call("turn.submit", { request_id: "r-1", session_id: "s1", kind: "followup", input: { text: "hi" } } as never, { unsentAfterMs: 300 }).then(
      () => (outcome = "answered"),
      (e: unknown) => (outcome = e),
    );
    await until(() => outbox.entries.has("r-1"));
    // The window runs on a fake clock, so it is measured in the client's time, however slow the machine.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    cleanups.push(() => vi.useRealTimers());
    retries.hold();
    const relayGoes = async () => {
      runtime.state.relayDown = true;
      runtime.dropRelay();
      await until(relay.heard);
    };
    if (relayHeardFirst) await relayGoes();
    else runtime.state.holdRelaySubmits = true; // the relay's socket is dead already: nothing on it is answered
    rtc.peers.at(-1)!.channel!.kill();
    await until(() => client.path() === "relay");
    if (!relayHeardFirst) await relayGoes();
    // The relay cannot carry it: it may go another way, under its request id (it went out on the channel, so it may have run).
    vi.advanceTimersByTime(290);
    await sleep(10);
    expect(outcome).toBe("pending");
    expect(outbox.entries.has("r-1")).toBe(true);
    vi.advanceTimersByTime(20);
    await sleep(10);
    expect(outcome).toBeInstanceOf(CallNotSent);
    expect((outcome as CallNotSent).reason).toBe("unanswered");
    expect(outbox.entries.has("r-1")).toBe(false);
    vi.useRealTimers();
  }
});

test("closing takes a withdrawable call back wherever it is: CallNotSent, out of the outbox", async () => {
  const { runtime, client, outbox } = await setup();
  await until(() => client.path() === "direct");
  runtime.state.silentDirect = true;
  const answer = client.call("turn.submit", { request_id: "r-1", session_id: "s1", kind: "followup", input: { text: "hi" } } as never, { unsentAfterMs: 5_000 }).then(
    () => null,
    (e: unknown) => e,
  );
  await until(() => outbox.entries.has("r-1"));
  client.close();
  const error = await answer;
  expect(error).toBeInstanceOf(CallNotSent);
  expect((error as CallNotSent).reason).toBe("unanswered");
  await until(() => !outbox.entries.has("r-1"));
});

test("a send cut off with its channel goes again on the relay only as a resend would: the chat moved meanwhile, so it never runs late", async () => {
  let moved = false;
  const asked: Array<Pick<OutboxEntry, "request_id" | "at">> = [];
  const clock = fakePingClock();
  const { runtime, client } = await setup({ silenceMs: 600 }, { options: { resend: (entry) => (asked.push({ request_id: entry.request_id, at: entry.at }), !moved), handshake: deviceCheck } });
  await until(() => client.path() === "direct");
  // The lid closes: the channel goes silent with the send out on it, and the relay cannot reach the laptop either.
  runtime.state.silentDirect = true;
  const madeAt = Date.now();
  const answer = outcomeOf(client.call("turn.submit", { request_id: "r-late", session_id: "s1", kind: "followup", input: { text: "hi" } } as never));
  // On the page's outbox clock (outboxAt), which may run a few ms past the wall clock: a time handed out at the
  // hand-over would be past this one.
  const madeBy = outboxAt();
  await new Promise((r) => setTimeout(r, 50));
  runtime.state.relayDown = true;
  runtime.dropRelay();
  clock.quiet(800); // past the silence window
  expect(client.path()).toBe("relay");
  // The chat moves to another computer while the laptop sleeps; then it wakes.
  moved = true;
  runtime.state.silentDirect = false;
  runtime.state.relayDown = false;
  expect(await answer).toEqual({ error: new CallNotSent("turn.submit", "stale") });
  expect(runtime.executions).toEqual([]);
  // Asked once, about the send as it was made (its age counts from then, not from the hand-over).
  expect(asked.map((a) => a.request_id)).toEqual(["r-late"]);
  expect(asked[0]!.at).toBeGreaterThanOrEqual(madeAt);
  expect(asked[0]!.at).toBeLessThan(madeBy);
});

test("sends out on the relay when it goes, an earlier page's too, go again on the channel only as a resend would", async () => {
  const runtime = await fakeRuntime();
  runtime.state.holdRelaySubmits = true;
  let moved = false;
  const asked: string[] = [];
  const restored: unknown[] = [];
  const left = { request_id: "left", method: "turn.submit" as const, params: { request_id: "left", session_id: "s1", kind: "followup", input: { text: "before the reload" } }, at: Date.now() - 1_000 };
  const outbox = memoryOutbox();
  await outbox.put(left);
  const { client, goDirect } = await relayFirst({
    runtime,
    options: { outbox, resend: (entry) => (asked.push(entry.request_id), !moved), onRestored: (_entry, outcome) => restored.push(outcome), handshake: deviceCheck },
  });
  const answer = outcomeOf(client.call("turn.submit", { request_id: "a", session_id: "s1", kind: "followup", input: { text: "1" } } as never));
  await new Promise((r) => setTimeout(r, 50));
  await goDirect();
  // Both are out on the relay, unanswered, when the chat moves and the relay goes.
  moved = true;
  runtime.state.relayDown = true;
  runtime.dropRelay();
  expect(await answer).toEqual({ error: new CallNotSent("turn.submit", "stale") });
  await until(() => restored.length === 1);
  expect(restored).toEqual([{ error: new CallNotSent("turn.submit", "stale") }]);
  expect(runtime.executions).toEqual([]);
  // The relay asked about the earlier page's send before it went out there, and about "a" as the channel took it over
  // (its copy there is taken back, so the relay never sends it again); the channel asked about both.
  expect(asked).toEqual(["left", "a", "left", "a"]);
  await until(() => outbox.entries.size === 0);
});

test("a mutating call never overtakes an earlier one still out on the relay", async () => {
  let allow = false;
  let changed: (online: boolean) => void = () => undefined;
  const { runtime, client } = await setup({ enabled: () => allow, network: (c) => ((changed = c), () => undefined) });
  runtime.state.holdRelaySubmits = true;
  const first = client.call("turn.submit", { request_id: "a", session_id: "s1", kind: "followup", input: { text: "1" } } as never);
  await until(() => runtime.relay() !== undefined);
  await new Promise((r) => setTimeout(r, 30));
  // The direct path comes up while "a" is still out on the relay.
  allow = true;
  changed(true);
  await until(() => client.path() === "direct");
  const second = client.call("turn.submit", { request_id: "b", session_id: "s1", kind: "followup", input: { text: "2" } } as never);
  await new Promise((r) => setTimeout(r, 50));
  // "b" waits behind "a" on the relay; the channel would have run it first.
  expect(runtime.executions).toEqual([]);
  runtime.release();
  await Promise.all([first, second]);
  expect(runtime.executions).toEqual(["a", "b"]);
  // With nothing out on the relay, the next goes straight over the channel.
  runtime.state.holdRelaySubmits = true;
  await client.call("turn.submit", { request_id: "c", session_id: "s1", kind: "followup", input: { text: "3" } } as never);
  expect(runtime.executions).toEqual(["a", "b", "c"]);
});

test("a notification every connection gets arrives once, not once per path", async () => {
  const { runtime, client } = await setup();
  await until(() => client.path() === "direct");
  const got: unknown[] = [];
  client.on("workspace.changed", (w) => got.push(w));
  await new Promise((r) => setTimeout(r, 20));
  runtime.broadcast("workspace.changed", { id: "w1", title: "one" });
  runtime.broadcast("workspace.changed", { id: "w1", title: "two" });
  await until(() => got.length >= 2);
  await new Promise((r) => setTimeout(r, 100)); // a copy over the other path would be in too
  expect(got).toEqual([
    { id: "w1", title: "one" },
    { id: "w1", title: "two" },
  ]);
});

/** Runs `act`, then waits for the first copy of what it sends and a moment more, so a second copy would be in too. */
async function delivered(count: () => number, act: () => void) {
  act();
  await until(() => count() > 0);
  await new Promise((r) => setTimeout(r, 100));
}

test("a terminal attached on the relay before the switch is followed and let go of there, and attached again it prints once", async () => {
  const states: ConnectionState[] = [];
  const { runtime, client, goDirect } = await relayFirst({ states });
  const got: string[] = [];
  client.on("term.output", (p) => got.push(p.data));
  await client.call("term.attach", { terminal_id: "t1" });
  await goDirect();
  // The switch says nothing: the page keeps what it set up on the relay.
  expect(states.filter((s) => s === "open")).toHaveLength(1);
  // Attached again where it is (after term.resync), it stays on that connection only.
  await client.call("term.attach", { terminal_id: "t1" });
  expect(runtime.holding((c) => c.terminals.has("t1"))).toEqual(["relay"]);
  // The person closes the tab: the connection that had it lets go.
  await client.call("term.detach", { terminal_id: "t1" });
  expect(runtime.holding((c) => c.terminals.has("t1"))).toEqual([]);
  // And opens it again.
  await client.call("term.attach", { terminal_id: "t1" });
  await delivered(() => got.length, () => runtime.termOutput("t1", "hello\r\n"));
  expect(got).toEqual(["hello\r\n"]);
});

test("a command started on the relay before the switch prints once in the tab that attaches after it", async () => {
  const { runtime, client, goDirect } = await relayFirst();
  const got: string[] = [];
  client.on("term.output", (p) => got.push(p.data));
  const { terminal_id } = await client.call("term.open", { request_id: "o1", workspace_id: "w1", cols: 120, rows: 30, command: "npm run dev" });
  await goDirect();
  // The run's tab is shown later and attaches.
  await client.call("term.attach", { terminal_id });
  await delivered(() => got.length, () => runtime.termOutput(terminal_id, "ready\r\n"));
  expect(got).toEqual(["ready\r\n"]);
  await client.call("term.detach", { terminal_id });
  expect(runtime.holding((c) => c.terminals.has(terminal_id))).toEqual([]);
});

test("a terminal on the relay prints once after the switch while its chat follows the channel through the same client", async () => {
  const { runtime, client, goDirect } = await relayFirst();
  const got: string[] = [];
  client.on("term.output", (p) => got.push(p.data));
  // The chat view and the terminal tab share the client.
  await follow(client);
  const { terminal_id } = await client.call("term.open", { request_id: "o1", workspace_id: "w1", cols: 80, rows: 24 });
  await client.call("term.attach", { terminal_id });
  await goDirect();
  await until(() => runtime.direct()?.attached.has("s1") === true && runtime.relay()?.attached.has("s1") === false);
  // The runtime sends it to the relay's connection, which opened it, and to the channel's, which follows its chat.
  await delivered(() => got.length, () => runtime.termOutput(terminal_id, "$ ls\r\n"));
  expect(got).toEqual(["$ ls\r\n"]);
});

test("a command watched on the relay before the switch is unwatched there, and watched again it streams once", async () => {
  const { runtime, client, goDirect } = await relayFirst();
  const got: string[] = [];
  client.on("tool.live", (p) => got.push(p.text));
  const watched = { workspace_id: "w1", item_id: "i1" };
  await client.call("tool.watch", watched);
  await goDirect();
  // Scrolled off screen, and back.
  await client.call("tool.unwatch", watched);
  expect(runtime.holding((c) => c.watches.size > 0)).toEqual([]);
  await client.call("tool.watch", watched);
  await delivered(() => got.length, () => runtime.toolLive("w1", "i1", "line 1\n"));
  expect(got).toEqual(["line 1\n"]);
});

test("a screencast turned on over the relay before the switch is turned off there, and a relay reconnect does not turn it back on", async () => {
  const { runtime, client, goDirect } = await relayFirst();
  await client.call("browser.screencast", { workspace_id: "w1", enabled: true, max_fps: 10 });
  await goDirect();
  // Faster while the person drives: the same screencast, not a second one.
  await client.call("browser.screencast", { workspace_id: "w1", enabled: true, max_fps: 30 });
  expect(runtime.holding((c) => c.screencasts.has("w1"))).toEqual(["relay"]);
  await client.call("browser.screencast", { workspace_id: "w1", enabled: false });
  expect(runtime.holding((c) => c.screencasts.has("w1"))).toEqual([]);
  const before = runtime.relay();
  runtime.dropRelay();
  await until(() => runtime.relay() !== undefined && runtime.relay() !== before);
  await new Promise((r) => setTimeout(r, 300));
  expect(runtime.holding((c) => c.screencasts.has("w1"))).toEqual([]);
});

test("a screencast on the relay when it restarts under the channel is on again on the channel alone, where the page sets it up too, and stops there", async () => {
  const states: ConnectionState[] = [];
  const { runtime, client, goDirect } = await relayFirst({ states });
  const cast = (enabled: boolean) => client.call("browser.screencast", { workspace_id: "w1", enabled, ...(enabled ? { max_fps: 10 } : {}) });
  await cast(true);
  await goDirect();
  const before = runtime.relay();
  runtime.dropRelay();
  // "open": the view starts its screencast again, on the channel that carries everything now.
  await until(() => states.filter((s) => s === "open").length === 2);
  await cast(true);
  await until(() => runtime.relay() !== undefined && runtime.relay() !== before);
  await new Promise((r) => setTimeout(r, 300));
  expect(runtime.holding((c) => c.screencasts.has("w1"))).toEqual(["direct"]);
  // The person closes the view.
  await cast(false);
  expect(runtime.holding((c) => c.screencasts.has("w1"))).toEqual([]);
  const again = runtime.relay();
  runtime.dropRelay();
  await until(() => runtime.relay() !== undefined && runtime.relay() !== again);
  await new Promise((r) => setTimeout(r, 300));
  expect(runtime.holding((c) => c.screencasts.has("w1"))).toEqual([]);
});

// A pooled client (a chat on another laptop, shown under the home connection's counter) is never set up again on its
// own "open": a screencast comes back only if the client turns it back on, as a relay client does after a reconnect.
const casting = (runtime: FakeRuntime) => runtime.holding((c) => c.screencasts.has("w1"));
const screencast = (client: DirectClient, enabled: boolean) => client.call("browser.screencast", { workspace_id: "w1", enabled, ...(enabled ? { max_fps: 10 } : {}) });

test("a screencast on the relay comes back on after the relay reconnects, with nothing setting it up again, and stays off once stopped", async () => {
  const { runtime, client } = await relayFirst();
  await screencast(client, true);
  const before = runtime.relay();
  runtime.dropRelay();
  await until(() => runtime.relay() !== undefined && runtime.relay() !== before);
  await until(() => casting(runtime).length > 0);
  await new Promise((r) => setTimeout(r, 300)); // a second one set up again would be in by now
  expect(casting(runtime)).toEqual(["relay"]);
  await screencast(client, false);
  expect(casting(runtime)).toEqual([]);
  const again = runtime.relay();
  runtime.dropRelay();
  await until(() => runtime.relay() !== undefined && runtime.relay() !== again);
  await new Promise((r) => setTimeout(r, 300));
  expect(casting(runtime)).toEqual([]);
});

test("a screencast on the relay when the relay restarts under the channel comes back on the channel alone, with nothing setting it up again", async () => {
  // A device check, so a relay that takes the socket and drops it never reads as open.
  const { runtime, client, goDirect } = await relayFirst({ options: { handshake: deviceCheck } });
  await screencast(client, true);
  await goDirect();
  // Cloud's relay stays down a while: the channel carries the screencast meanwhile.
  runtime.state.relayDown = true;
  runtime.dropRelay();
  await until(() => runtime.relay() === undefined);
  await until(() => casting(runtime).length > 0);
  await new Promise((r) => setTimeout(r, 300)); // a second one set up again would be in by now
  expect(casting(runtime)).toEqual(["direct"]);
  // Back: the relay's new connection gets none of its own.
  runtime.state.relayDown = false;
  await until(() => runtime.relay() !== undefined);
  await new Promise((r) => setTimeout(r, 300));
  expect(casting(runtime)).toEqual(["direct"]);
  await screencast(client, false);
  expect(casting(runtime)).toEqual([]);
});

test("a screencast on the channel when it dies comes back on the relay, with nothing setting it up again", async () => {
  const retries = holdRetries();
  const { runtime, client, rtc } = await setup({ retryMs: retries.retryMs });
  await until(() => client.path() === "direct");
  await screencast(client, true);
  expect(casting(runtime)).toEqual(["direct"]);
  retries.hold();
  rtc.peers.at(-1)!.channel!.kill();
  await until(() => client.path() === "relay" && runtime.direct() === undefined);
  await until(() => casting(runtime).length > 0);
  await new Promise((r) => setTimeout(r, 300)); // a second one set up again would be in by now
  expect(casting(runtime)).toEqual(["relay"]);
  await screencast(client, false);
  expect(casting(runtime)).toEqual([]);
});

test("a screencast on the relay when it goes before the channel opens comes back on that channel, with nothing setting it up again", async () => {
  let letThrough!: () => void;
  const checked = new Promise<void>((resolve) => (letThrough = resolve));
  const handshake: Handshake = async (link) => {
    const { via } = (await link.call("engine.list", {})) as { via: string };
    if (via === "direct") await checked;
  };
  const states: ConnectionState[] = [];
  let allow = false;
  let changed: (online: boolean) => void = () => undefined;
  const { runtime, client } = await setup({ enabled: () => allow, network: (c) => ((changed = c), () => undefined) }, { states, options: { handshake } });
  await until(() => runtime.relay() !== undefined);
  await screencast(client, true);
  allow = true;
  changed(true);
  await until(() => runtime.direct() !== undefined);
  runtime.state.relayDown = true;
  runtime.dropRelay();
  await until(() => states.at(-1) === "connecting");
  letThrough();
  await until(() => client.path() === "direct");
  await until(() => runtime.relay() === undefined && casting(runtime).length > 0);
  await new Promise((r) => setTimeout(r, 300)); // a second one set up again would be in by now
  expect(casting(runtime)).toEqual(["direct"]);
});

test("what the relay held goes with it when no channel carries yet: one that opens while the relay is down carries it set up again", async () => {
  let letThrough!: () => void;
  const checked = new Promise<void>((resolve) => (letThrough = resolve));
  // A device check on every socket; the channel's waits until the test lets it through.
  const handshake: Handshake = async (link) => {
    const { via } = (await link.call("engine.list", {})) as { via: string };
    if (via === "direct") await checked;
  };
  const states: ConnectionState[] = [];
  let allow = false;
  let changed: (online: boolean) => void = () => undefined;
  const { runtime, client } = await setup({ enabled: () => allow, network: (c) => ((changed = c), () => undefined) }, { states, options: { handshake } });
  await until(() => runtime.relay() !== undefined);
  await client.call("term.attach", { terminal_id: "t1" });
  allow = true;
  changed(true);
  // Cloud's relay goes while the channel is still in its device check.
  await until(() => runtime.direct() !== undefined);
  runtime.state.relayDown = true;
  runtime.dropRelay();
  await until(() => states.at(-1) === "connecting");
  letThrough();
  await until(() => client.path() === "direct");
  expect(states.at(-1)).toBe("open");
  // "open": the tab attaches again, on the path that is up.
  const attached = await outcomeOf(client.call("term.attach", { terminal_id: "t1" }));
  expect(runtime.holding((c) => c.terminals.has("t1"))).toEqual(["direct"]);
  expect(attached).toMatchObject({ result: { exited: false } });
});

/**
 * A relay that goes while the channel is still in its device check (`letThrough` passes it): what the page asks for
 * meanwhile waits on the relay's client, and moves to the channel once it opens.
 */
async function channelOpensWhileRelayIsDown(options: ConnectOptions = {}) {
  let letThrough!: () => void;
  const checked = new Promise<void>((resolve) => (letThrough = resolve));
  let waiting = false;
  const handshake: Handshake = async (link) => {
    const { via } = (await link.call("engine.list", {})) as { via: string };
    if (via !== "direct") return;
    waiting = true;
    await checked;
  };
  const states: ConnectionState[] = [];
  let allow = false;
  let changed: (online: boolean) => void = () => undefined;
  const s = await setup({ enabled: () => allow, network: (c) => ((changed = c), () => undefined) }, { states, options: { ...options, handshake } });
  await until(() => s.runtime.relay() !== undefined);
  allow = true;
  changed(true);
  await until(() => waiting);
  s.runtime.state.relayDown = true;
  s.runtime.dropRelay();
  await until(() => states.at(-1) === "connecting");
  return { ...s, states, letThrough };
}

test("a watch and a terminal asked for while the relay is down live on the channel alone, also once the relay is back", async () => {
  const { runtime, client, letThrough } = await channelOpensWhileRelayIsDown();
  const got: string[] = [];
  client.on("tool.live", (p) => got.push(p.text));
  const watched = { workspace_id: "w1", item_id: "i1" };
  const watch = client.call("tool.watch", watched);
  const attach = client.call("term.attach", { terminal_id: "t1" });
  letThrough();
  await Promise.all([watch, attach]);
  expect(client.path()).toBe("direct");
  // Cloud's relay comes back.
  runtime.state.relayDown = false;
  await until(() => runtime.relay() !== undefined);
  await new Promise((r) => setTimeout(r, 300));
  expect(runtime.holding((c) => c.watches.size > 0)).toEqual(["direct"]);
  expect(runtime.holding((c) => c.terminals.has("t1"))).toEqual(["direct"]);
  await delivered(() => got.length, () => runtime.toolLive("w1", "i1", "line 1\n"));
  expect(got).toEqual(["line 1\n"]);
  // Scrolled away and the tab closed: nothing is left watching or attached anywhere.
  await client.call("tool.unwatch", watched);
  await client.call("term.detach", { terminal_id: "t1" });
  expect(runtime.holding((c) => c.watches.size > 0 || c.terminals.size > 0)).toEqual([]);
});

test("a send made while the relay is down goes out once, on the channel: back on a relay after the chat moved, it is not sent again", async () => {
  let moved = false;
  const { runtime, client, letThrough, outbox } = await channelOpensWhileRelayIsDown({ resend: () => !moved });
  const answer = outcomeOf(client.call("turn.submit", { request_id: "r-1", session_id: "s1", kind: "followup", input: { text: "hi" } } as never));
  await until(() => outbox.entries.has("r-1"));
  // The channel opens and carries it, then strands before its answer comes back.
  runtime.state.silentDirect = true;
  letThrough();
  await until(() => client.path() === "direct");
  await until(() => client.path() === "relay");
  // The chat moves to another computer meanwhile; then the relay and the laptop are back.
  moved = true;
  runtime.state.silentDirect = false;
  runtime.state.relayDown = false;
  expect(await answer).toEqual({ error: new CallNotSent("turn.submit", "stale") });
  await new Promise((r) => setTimeout(r, 300));
  expect(runtime.executions).toEqual([]);
  await until(() => outbox.entries.size === 0);
});

test("a signal that outlives its calls keeps no listener for one that settled, on the relay or taken over by the channel", async () => {
  const shared = new AbortController();
  const submit = (client: DirectClient, request_id: string) =>
    client.call("turn.submit", { request_id, session_id: "s1", kind: "followup", input: { text: request_id } } as never, { signal: shared.signal, unsentAfterMs: 60_000 });
  // Waiting on the relay's client while the relay is down, then carried by the channel as it opens.
  const { client, letThrough } = await channelOpensWhileRelayIsDown();
  const moved = submit(client, "r-1");
  letThrough();
  await moved;
  expect(client.path()).toBe("direct");
  // Answered on the relay.
  const { client: onRelay } = await relayFirst();
  await submit(onRelay, "r-2");
  expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);
});

test("a send kept in the outbox as the client closed stays there for the next page, though its caller takes it back later", async () => {
  let land!: () => void;
  const landed = new Promise<void>((resolve) => (land = resolve));
  const entries = memoryOutbox();
  const asked: string[] = [];
  // A durable store whose write lands only once let: the client closes while its relay client writes.
  const outbox = { ...entries, put: async (entry: OutboxEntry) => (asked.push(entry.request_id), landed.then(() => entries.put(entry))) };
  const { client } = await relayFirst({ options: { outbox } });
  const back = new AbortController();
  const outcome = outcomeOf(client.call("turn.submit", { request_id: "r-1", session_id: "s1", kind: "followup", input: { text: "hi" } } as never, { signal: back.signal }));
  await until(() => asked.includes("r-1"));
  client.close();
  land();
  expect(await outcome).toEqual({ error: new Error("client closed") });
  // Long after: the call is over here, and the next page resends it from the outbox.
  back.abort();
  await new Promise((r) => setTimeout(r, 50));
  expect([...entries.entries.keys()]).toEqual(["r-1"]);
});

test("a send moved to the channel while the relay's client still writes it to the outbox keeps its entry until answered", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const entries = memoryOutbox();
  // A durable store: the write of the send's entry lands only once released.
  const outbox = { ...entries, put: async (entry: OutboxEntry) => (entry.request_id === "r-1" ? slow.then(() => entries.put(entry)) : entries.put(entry)) };
  const { runtime, client, letThrough } = await channelOpensWhileRelayIsDown({ outbox });
  runtime.state.holdDirectSubmits = true;
  const answer = outcomeOf(client.call("turn.submit", { request_id: "r-1", session_id: "s1", kind: "followup", input: { text: "hi" } } as never));
  letThrough();
  await until(() => client.path() === "direct");
  release();
  await new Promise((r) => setTimeout(r, 50));
  // Out on the channel with no answer yet: a reload now would send it again from the outbox.
  expect([...entries.entries.keys()]).toEqual(["r-1"]);
  runtime.release();
  expect(await answer).toEqual({ result: { turn_id: "t-r-1", disposition: "started" } });
  expect(runtime.executions).toEqual(["r-1"]);
  await until(() => entries.entries.size === 0);
});

test("sends queued on the relay's client behind a slow outbox write keep their entries once the channel carries them", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const entries = memoryOutbox();
  const asked: string[] = [];
  // A durable store whose first write lands only once released: the relay's client sends nothing behind it until then.
  const outbox = {
    ...entries,
    put: async (entry: OutboxEntry) => {
      asked.push(entry.request_id);
      return entry.request_id === "r-0" ? slow.then(() => entries.put(entry)) : entries.put(entry);
    },
  };
  const { runtime, client, letThrough } = await channelOpensWhileRelayIsDown({ outbox });
  runtime.state.holdDirectSubmits = true;
  const submit = (request_id: string) =>
    outcomeOf(client.call("turn.submit", { request_id, session_id: "s1", kind: "followup", input: { text: request_id } } as never));
  const answers = [submit("r-0"), submit("r-1")];
  await until(() => asked.includes("r-0"));
  // r-1 waits on the relay's client behind r-0, never yet written.
  await new Promise((r) => setTimeout(r, 50));
  letThrough();
  await until(() => client.path() === "direct");
  release();
  await new Promise((r) => setTimeout(r, 50));
  // Both out on the channel with no answer yet: a reload now sends each again from the outbox.
  expect([...entries.entries.keys()].sort()).toEqual(["r-0", "r-1"]);
  runtime.release();
  expect(await Promise.all(answers)).toEqual([
    { result: { turn_id: "t-r-0", disposition: "started" } },
    { result: { turn_id: "t-r-1", disposition: "started" } },
  ]);
  expect(runtime.executions).toEqual(["r-0", "r-1"]);
  await until(() => entries.entries.size === 0);
});

test("what the channel held goes with it: set up again after the hand-over, it lives on the relay", async () => {
  const retries = holdRetries();
  const { runtime, client, rtc } = await setup({ retryMs: retries.retryMs });
  await until(() => client.path() === "direct");
  const got: string[] = [];
  client.on("term.output", (p) => got.push(p.data));
  await client.call("term.attach", { terminal_id: "t1" });
  expect(runtime.holding((c) => c.terminals.has("t1"))).toEqual(["direct"]);
  retries.hold();
  rtc.peers.at(-1)!.channel!.kill();
  await until(() => client.path() === "relay");
  // "open" again: the tab lets go (of nothing left) and attaches on the path that is up.
  await client.call("term.detach", { terminal_id: "t1" });
  await client.call("term.attach", { terminal_id: "t1" });
  await until(() => runtime.direct() === undefined);
  expect(runtime.holding((c) => c.terminals.has("t1"))).toEqual(["relay"]);
  await delivered(() => got.length, () => runtime.termOutput("t1", "back\r\n"));
  expect(got).toEqual(["back\r\n"]);
});

test("the person driving the browser over the relay keeps driving it after the switch: clicks, typing and page moves go where they took control", async () => {
  const states: ConnectionState[] = [];
  const { runtime, client, goDirect } = await relayFirst({ states });
  const ws = { workspace_id: "w1" };
  await screencast(client, true);
  await expect(client.call("browser.control", { request_id: "c1", ...ws, controller: "user" })).resolves.toEqual({ controller: "user" });
  await goDirect();
  // The switch says nothing, so the view still shows the person in control.
  expect(states.filter((s) => s === "open")).toHaveLength(1);
  const click = { type: "pointer", action: "down", x: 10, y: 20, modifiers: 0 } as const;
  expect(await outcomeOf(client.call("browser.input", { request_id: "i1", ...ws, events: [click] }))).toEqual({ result: {} });
  expect(await outcomeOf(client.call("browser.navigate", { request_id: "n1", ...ws, url: "http://localhost:3000/next" }))).toEqual({ result: {} });
  expect(await outcomeOf(client.call("browser.history", { request_id: "h1", ...ws, action: "back" }))).toEqual({ result: {} });
  expect(runtime.driven).toEqual([
    { method: "browser.control", path: "relay" },
    { method: "browser.input", path: "relay" },
    { method: "browser.navigate", path: "relay" },
    { method: "browser.history", path: "relay" },
  ]);
  // Handed back where it was taken; taken again, it lives on the path calls take now.
  await expect(client.call("browser.control", { request_id: "c2", ...ws, controller: "agent" })).resolves.toEqual({ controller: "agent" });
  expect(runtime.driving("browser\0w1")).toBeUndefined();
  await client.call("browser.control", { request_id: "c3", ...ws, controller: "user" });
  expect(await outcomeOf(client.call("browser.input", { request_id: "i2", ...ws, events: [click] }))).toEqual({ result: {} });
  expect(runtime.driven.slice(-2)).toEqual([
    { method: "browser.control", path: "direct" },
    { method: "browser.input", path: "direct" },
  ]);
});

test("the person driving the desktop over the relay keeps driving it after the switch", async () => {
  const { runtime, client, goDirect } = await relayFirst();
  const ws = { workspace_id: "w1" };
  await client.call("computer.control", { request_id: "c1", ...ws, controller: "user" });
  await goDirect();
  const key = { type: "key", action: "down", key: "a", code: "KeyA", modifiers: 0 } as const;
  expect(await outcomeOf(client.call("computer.input", { request_id: "i1", ...ws, events: [key] }))).toEqual({ result: {} });
  await expect(client.call("computer.control", { request_id: "c2", ...ws, controller: "agent" })).resolves.toEqual({ controller: "agent" });
  expect(runtime.driven.map((d) => d.path)).toEqual(["relay", "relay"]);
  expect(runtime.driving("computer\0w1")).toBeUndefined();
});

test("a runtime that offers no direct path is not asked again on that connection", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  runtime.state.offers = "unsupported";
  const rtc = fakeRtc(runtime.url);
  const client = connectDirect(runtime.url, "secret", undefined, { direct: { rtc: rtc.Rtc, retryMs: () => 10, network: () => () => undefined } });
  cleanups.push(() => client.close());
  await expect(client.call("engine.list", {})).resolves.toMatchObject({ via: "relay" });
  await until(() => rtc.peers[0]?.connectionState === "closed");
  await new Promise((r) => setTimeout(r, 150)); // retried every 10 ms, another offer would be out by now
  expect(rtc.peers).toHaveLength(1);
  expect(client.path()).toBe("relay");
});

test("a channel that stops answering is dropped within its silence window and the relay takes over", async () => {
  const clock = fakePingClock();
  const retries = holdRetries();
  const { runtime, client, paths } = await setup({ silenceMs: 600, retryMs: retries.retryMs });
  const { seen } = await follow(client);
  await until(() => client.path() === "direct" && runtime.direct()?.attached.has("s1") === true);
  retries.hold();
  runtime.state.silentDirect = true;
  // A stranded channel: frames go nowhere and no pong comes back. Pings go every 200 ms of quiet; past 600 ms it is dead.
  clock.quiet(600);
  expect(client.path()).toBe("direct");
  clock.quiet(200);
  expect(client.path()).toBe("relay");
  runtime.append();
  await until(() => seen.length === 1);
  expect(paths).toEqual(["direct", "relay"]);
});

test("the relay goes down while the channel is up: everything keeps going over the channel", async () => {
  const states: ConnectionState[] = [];
  const { runtime, client } = await setup({}, { states });
  const { seen, states: subStates } = await follow(client);
  await until(() => client.path() === "direct" && runtime.direct()?.attached.has("s1") === true);
  runtime.state.relayDown = true;
  runtime.dropRelay();
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 5; i++) runtime.append();
  await until(() => seen.length === 5);
  await expect(client.call("turn.submit", { request_id: "while-down", session_id: "s1", kind: "followup", input: { text: "x" } } as never)).resolves.toMatchObject({ disposition: "started" });
  expect(client.path()).toBe("direct");
  expect(subStates).not.toContain("reconnecting");
  // The connection never read as down: only "open" again, for surfaces to set up what lived on the relay.
  expect(states.filter((s) => s !== "open" && s !== "connecting")).toEqual([]);
  expect(states.at(-1)).toBe("open");
});

test("a network change tries the direct path again at once, without waiting out the backoff", async () => {
  let changed: (online: boolean) => void = () => undefined;
  const retries = holdRetries();
  const { runtime, client, rtc } = await setup({ retryMs: retries.retryMs, network: (c) => ((changed = c), () => undefined) });
  await until(() => client.path() === "direct");
  const tried = rtc.peers.length;
  const offered = runtime.offers.length;
  // The channel dies; the next try is a minute away.
  retries.hold();
  rtc.peers.at(-1)!.channel!.kill();
  await until(() => client.path() === "relay");
  await new Promise((r) => setTimeout(r, 100));
  expect(rtc.peers).toHaveLength(tried);
  // Offline: nothing is tried. Back online (or a new network): at once.
  changed(false);
  await new Promise((r) => setTimeout(r, 50));
  expect(rtc.peers).toHaveLength(tried);
  changed(true);
  await until(() => client.path() === "direct");
  expect(rtc.peers).toHaveLength(tried + 1);
  expect(runtime.offers).toHaveLength(offered + 1);
});

test("the relay goes down with a send still out on it: the send goes again on the channel and later ones do not wait", async () => {
  let allow = false;
  let changed: (online: boolean) => void = () => undefined;
  const { runtime, client } = await setup({ enabled: () => allow, network: (c) => ((changed = c), () => undefined) });
  runtime.state.holdRelaySubmits = true;
  const first = client.call("turn.submit", { request_id: "a", session_id: "s1", kind: "followup", input: { text: "1" } } as never);
  await until(() => runtime.relay() !== undefined);
  await new Promise((r) => setTimeout(r, 30));
  allow = true;
  changed(true);
  await until(() => client.path() === "direct");
  // A deploy takes the relay down while "a" waits on it.
  runtime.state.relayDown = true;
  runtime.dropRelay();
  await expect(first).resolves.toEqual({ turn_id: "t-a", disposition: "started" });
  const second = await client.call("turn.submit", { request_id: "b", session_id: "s1", kind: "followup", input: { text: "2" } } as never);
  expect(second).toEqual({ turn_id: "t-b", disposition: "started" });
  expect(runtime.executions).toEqual(["a", "b"]);
});

test("a send an earlier page left in the outbox is not overtaken on the channel, and is reported once", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  runtime.state.holdRelaySubmits = true;
  const outbox = memoryOutbox();
  const left = { request_id: "left", method: "turn.submit" as const, params: { request_id: "left", session_id: "s1", kind: "followup", input: { text: "before the reload" } }, at: Date.now() - 1_000 };
  await outbox.put(left);
  const rtc = fakeRtc(runtime.url);
  const restored: string[] = [];
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox,
    onRestored: (entry) => restored.push(entry.request_id),
    direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  const next = client.call("turn.submit", { request_id: "next", session_id: "s1", kind: "followup", input: { text: "after" } } as never);
  await new Promise((r) => setTimeout(r, 50));
  // "next" waits behind "left" on the relay: the channel would have run it first.
  expect(runtime.executions).toEqual([]);
  runtime.release();
  await next;
  await until(() => restored.length === 1);
  expect(runtime.executions).toEqual(["left", "next"]);
  expect(restored).toEqual(["left"]);
});

test("a send the outbox takes over later (a page that has gone since left it) is not overtaken on the channel either", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  runtime.state.holdRelaySubmits = true;
  const outbox = memoryOutbox();
  const listeners = new Set<(entries: ReadonlyArray<OutboxEntry>) => void>();
  const rtc = fakeRtc(runtime.url);
  const restored: string[] = [];
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox: { ...outbox, taken: (listener) => (listeners.add(listener), () => void listeners.delete(listener)) },
    onRestored: (entry) => restored.push(entry.request_id),
    direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined, silenceMs: 600 },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  // Another page of the device made it and went: this one takes it over, and the relay client sends it again.
  const left = { request_id: "left", method: "turn.submit" as const, params: { request_id: "left", session_id: "s1", kind: "followup", input: { text: "from the page that went" } }, at: Date.now() - 1_000 };
  await outbox.put(left);
  for (const listener of listeners) listener([left]);
  await new Promise((r) => setTimeout(r, 30));
  const next = client.call("turn.submit", { request_id: "next", session_id: "s1", kind: "followup", input: { text: "after" } } as never);
  await new Promise((r) => setTimeout(r, 50));
  // "next" waits behind "left" on the relay: the channel would have run it first.
  expect(runtime.executions).toEqual([]);
  runtime.release();
  await next;
  await until(() => restored.length === 1);
  expect(runtime.executions).toEqual(["left", "next"]);
});

test("a call its outbox no longer answers for (the page lost its lock) goes out on neither path", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  let ours = true;
  const rtc = fakeRtc(runtime.url);
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox: { ...memoryOutbox(), ours: () => ours },
    direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined, silenceMs: 600 },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  ours = false;
  void client.call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "x" } } as never).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 100));
  expect(runtime.executions).toEqual([]);
});

/**
 * The device's store as the web's outbox.ts keeps it, for the pages that open on it: each entry names the page that
 * wrote it. A page that lost its lock (`lose`) deletes none of the entries it wrote before, rewrites one only while it
 * is still under its name (another page may hold it now), and keeps a call it never wrote under its name; a page that
 * loads takes over what a page that lost its lock left. `writes` lists each write a page made.
 */
function deviceStore() {
  const kept = new Map<string, OutboxEntry & { readonly page: string }>();
  const lost = new Set<string>();
  const page = (name: string, read?: Promise<void>) => {
    const owns = () => !lost.has(name);
    const mine = new Set<string>();
    const writes: string[] = [];
    const outbox: Outbox = {
      load: async () => {
        await read;
        if (!owns()) return [];
        const taken = [...kept.values()].filter((e) => e.page === name || lost.has(e.page));
        for (const e of taken) {
          mine.add(e.request_id);
          kept.set(e.request_id, { ...e, page: name });
        }
        return taken.map(({ page: _page, ...entry }) => entry).sort((a, b) => a.at - b.at);
      },
      ours: owns,
      put: async (entry) => {
        if (!owns() && mine.has(entry.request_id) && kept.get(entry.request_id)?.page !== name) return;
        mine.add(entry.request_id);
        writes.push(entry.request_id);
        kept.set(entry.request_id, { ...entry, page: name });
      },
      delete: async (request_id) => {
        if (!owns()) return;
        mine.delete(request_id);
        kept.delete(request_id);
      },
    };
    return { outbox, writes, lose: () => void lost.add(name) };
  };
  return { kept, page };
}

/** A Cloud computer's client: it offers no direct path, so every call takes the relay. */
const relayOnly = (runtime: FakeRuntime, outbox: Outbox, restored?: string[]) => {
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox,
    ...(restored ? { onRestored: (entry: OutboxEntry) => restored.push(entry.request_id) } : {}),
    direct: { rtc: fakeRtc(runtime.url).Rtc, enabled: () => false, iceServers: [], network: () => () => undefined },
  });
  cleanups.push(() => client.close());
  return client;
};

const submit = (client: DirectClient, request_id: string) =>
  void client.call("turn.submit", { request_id, session_id: "s1", kind: "followup", input: { text: request_id } } as never).catch(() => undefined);

/**
 * Waits for `check` as `until` does (its hang detector the only limit, never a clock budget), and goes on either way:
 * the assertion after it says what was missing.
 */
const awhile = (check: () => boolean) => until(check).catch(() => undefined);

test("a send made on a page that lost its lock, through a client on the relay alone (a Cloud computer), is kept under its name for the next page", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  const store = deviceStore();
  const page = store.page("a");
  const client = relayOnly(runtime, page.outbox);
  await until(() => runtime.relay() !== undefined);
  page.lose();
  submit(client, "new-1");
  await awhile(() => store.kept.has("new-1"));
  expect(page.writes, "kept for the next page").toEqual(["new-1"]);
  expect(store.kept.get("new-1")?.page).toBe("a");
  expect(runtime.executions).toEqual([]);
});

test("a send made on a page that lost its lock, through a client on the relay alone, runs once after the page loads anew", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  const store = deviceStore();
  const lostPage = store.page("a");
  const before = relayOnly(runtime, lostPage.outbox);
  await until(() => runtime.relay() !== undefined);
  // The page lost its lock (Safari's back/forward cache) and waits to load anew; the person sends meanwhile.
  lostPage.lose();
  submit(before, "typed");
  await new Promise((r) => setTimeout(r, 100));
  expect(runtime.executions).toEqual([]);
  before.close();
  const restored: string[] = [];
  relayOnly(runtime, store.page("b").outbox, restored);
  await awhile(() => restored.length > 0);
  expect(runtime.executions, "the send made before the reload runs once").toEqual(["typed"]);
  expect(restored).toEqual(["typed"]);
  await until(() => !store.kept.has("typed"));
});

test("a send made while its page held its lock, whose turn in the lane comes after the page lost it, is kept for the next page", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  const store = deviceStore();
  let read!: () => void;
  const page = store.page("a", new Promise<void>((r) => (read = r)));
  const before = relayOnly(runtime, page.outbox);
  await until(() => runtime.relay() !== undefined);
  // Made as the page starts, while its outbox is still being read; then the page goes into the back/forward cache.
  submit(before, "early");
  await new Promise((r) => setTimeout(r, 20));
  page.lose();
  read();
  await awhile(() => store.kept.has("early"));
  expect(page.writes, "kept for the next page").toEqual(["early"]);
  expect(runtime.executions).toEqual([]);
  before.close();
  relayOnly(runtime, store.page("b").outbox);
  await awhile(() => runtime.executions.length > 0);
  expect(runtime.executions).toEqual(["early"]);
});

test("a send out on the channel when its page lost its lock, taken over and answered by another page, is neither sent nor written back when the channel dies", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  const store = deviceStore();
  const page = store.page("a");
  const rtc = fakeRtc(runtime.url);
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox: page.outbox,
    direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined, silenceMs: 60_000 },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  runtime.state.silentDirect = true; // the channel carries it and answers nothing: it stays out there
  submit(client, "r-1");
  await until(() => store.kept.has("r-1"));
  page.lose();
  // Another page of the device takes it over, sends it on its relay and deletes it once answered.
  relayOnly(runtime, store.page("b").outbox);
  await until(() => runtime.executions.length === 1 && !store.kept.has("r-1"));
  // The lost page's channel dies: the call goes back to its relay, which neither sends it nor writes it back.
  rtc.peers[0]!.channel!.kill();
  await until(() => client.path() === "relay");
  await new Promise((r) => setTimeout(r, 300));
  expect(page.writes).toEqual(["r-1"]);
  expect(store.kept.has("r-1")).toBe(false);
  expect(runtime.executions).toEqual(["r-1"]);
});

test("a send from before the reload, out on the relay when its page loses its lock and then the relay goes, does not go again on the channel", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  runtime.state.holdRelaySubmits = true;
  let ours = true;
  const outbox = { ...memoryOutbox(), ours: () => ours };
  await outbox.put({ request_id: "left", method: "turn.submit", params: { request_id: "left", session_id: "s1", kind: "followup", input: { text: "x" } }, at: Date.now() - 1_000 });
  const rtc = fakeRtc(runtime.url);
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox,
    direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined, silenceMs: 600 },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  await new Promise((r) => setTimeout(r, 50));
  // The page lost its lock (another page may be sending "left" now), then the relay went.
  ours = false;
  runtime.state.relayDown = true;
  runtime.dropRelay();
  // The relay client says it lost the relay as it tries again (after its backoff).
  await new Promise((r) => setTimeout(r, 1_500));
  expect(runtime.executions).toEqual([]);
});

test("a send out on the relay when its page lost its lock stays there, unsent, when the relay goes and comes back", async () => {
  let ours = true;
  const outbox = { ...memoryOutbox(), ours: () => ours };
  const { runtime, client, goDirect } = await relayFirst({ options: { outbox } });
  runtime.state.holdRelaySubmits = true; // out on the relay, unanswered
  submit(client, "r-1");
  await until(() => runtime.received.some((r) => r.path === "relay" && r.method === "turn.submit"));
  await goDirect();
  // The page lost its lock, then the relay went: the channel takes nothing over from a lost page, so the relay client
  // keeps its copy, and it is the outbox's `ours` that holds that copy back once the relay is back.
  ours = false;
  runtime.state.holdRelaySubmits = false;
  runtime.state.relayDown = true;
  runtime.dropRelay();
  await until(() => runtime.relay() === undefined);
  runtime.state.relayDown = false;
  await until(() => runtime.relay() !== undefined);
  await new Promise((r) => setTimeout(r, 300));
  expect(runtime.received.filter((r) => r.method === "turn.submit")).toEqual([{ path: "relay", method: "turn.submit" }]);
  expect(runtime.executions).toEqual([]);
  expect([...outbox.entries.keys()], "kept for the next page").toEqual(["r-1"]);
});

test("a send from before the reload, still out on the relay when the relay goes, finishes on the channel, reported once", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  runtime.state.holdRelaySubmits = true;
  const outbox = memoryOutbox();
  await outbox.put({ request_id: "left", method: "turn.submit", params: { request_id: "left", session_id: "s1", kind: "followup", input: { text: "x" } }, at: Date.now() - 1_000 });
  const rtc = fakeRtc(runtime.url);
  const restored: Array<{ id: string; ok: boolean }> = [];
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox,
    onRestored: (entry, outcome) => restored.push({ id: entry.request_id, ok: "result" in outcome }),
    direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  runtime.state.relayDown = true;
  runtime.dropRelay();
  await until(() => restored.length === 1);
  expect(restored).toEqual([{ id: "left", ok: true }]);
  expect(runtime.executions).toEqual(["left"]);
  await until(() => !outbox.entries.has("left"));
  // The relay coming back answers it again from its receipt: not reported twice.
  runtime.state.relayDown = false;
  await new Promise((r) => setTimeout(r, 600));
  expect(restored).toHaveLength(1);
});

test("typed text an earlier version left in the outbox never goes out on the channel, though the relay's read of the outbox failed", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  const stored = memoryOutbox();
  await stored.put({ request_id: "old-keys", method: "term.write", params: { request_id: "old-keys", terminal_id: "t1", data: "hunter2\r" }, at: Date.now() - 1_000 });
  // connectDirect reads the outbox first, then its relay client does; that second read fails (a store that errs once),
  // so the relay client neither deletes the entry nor reports it.
  let loads = 0;
  const outbox: Outbox = { ...stored, load: () => (++loads === 1 ? stored.load() : Promise.reject(new Error("the store could not be read"))) };
  const rtc = fakeRtc(runtime.url);
  const client = connectDirect(runtime.url, "secret", undefined, { outbox, direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined, silenceMs: 600 } });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  await client.call("turn.submit", { request_id: "while-both", session_id: "s1", kind: "followup", input: { text: "a" } } as never);
  runtime.state.relayDown = true;
  runtime.dropRelay();
  await until(() => runtime.relay() === undefined);
  await client.call("turn.submit", { request_id: "relay-gone", session_id: "s1", kind: "followup", input: { text: "b" } } as never);
  expect(loads).toBe(2);
  // Nothing held the new sends back on the relay, and the old keystrokes reached the runtime by no path.
  expect(runtime.received.filter((r) => r.method === "turn.submit" || r.method === "term.write")).toEqual([
    { path: "direct", method: "turn.submit" },
    { path: "direct", method: "turn.submit" },
  ]);
});

test("typed text an earlier version left, handed over later from a page that went, never goes out on the channel while the relay client still reads the outbox", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  const stored = memoryOutbox();
  const listeners = new Set<(entries: ReadonlyArray<OutboxEntry>) => void>();
  // connectDirect reads the outbox first, then its relay client does; that second read is slow, so until it ends the
  // relay client neither deletes nor reports what the outbox hands over.
  let loads = 0;
  let readEnds!: () => void;
  const slowRead = new Promise<void>((r) => (readEnds = r));
  const outbox: Outbox = {
    ...stored,
    load: async () => (++loads === 1 ? stored.load() : (await slowRead, stored.load())),
    taken: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
  };
  const rtc = fakeRtc(runtime.url);
  const client = connectDirect(runtime.url, "secret", undefined, { outbox, direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined } });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  // A page an older version left it to went, and this one takes it over.
  const oldKeys: OutboxEntry = { request_id: "old-keys", method: "term.write", params: { request_id: "old-keys", terminal_id: "t1", data: "hunter2\r" }, at: Date.now() - 1_000 };
  await stored.put(oldKeys);
  for (const listener of listeners) listener([oldKeys]);
  runtime.state.relayDown = true;
  runtime.dropRelay();
  await until(() => runtime.relay() === undefined);
  await client.call("turn.submit", { request_id: "relay-gone", session_id: "s1", kind: "followup", input: { text: "b" } } as never);
  readEnds();
  // The relay client deletes it once its read ends; the old keystrokes reached the runtime by no path.
  await until(() => !stored.entries.has("old-keys"));
  expect(loads).toBe(2);
  expect(runtime.received.filter((r) => r.method === "turn.submit" || r.method === "term.write")).toEqual([{ path: "direct", method: "turn.submit" }]);
});

test("two calls made in the same millisecond on the channel are kept in the order made, though the store lists equal times by request id", async () => {
  const { runtime, client, outbox } = await setup();
  await until(() => client.path() === "direct");
  runtime.state.silentDirect = true; // answers lost, so each call stays out and in the outbox
  const now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  const calls = [
    client.call("turn.submit", { request_id: "zz-send", session_id: "s1", kind: "followup", input: { text: "fix the tests" } } as never),
    client.call("turn.interrupt", { request_id: "aa-stop", session_id: "s1" }),
  ];
  Date.now = realNow;
  for (const call of calls) call.catch(() => undefined);
  await until(() => outbox.entries.size === 2);
  // As the device's store (outbox.ts kvOutbox) reads them after a reload: by `at`, then by key.
  const reloaded = [...outbox.entries.values()].sort((a, b) => a.at - b.at || (a.request_id < b.request_id ? -1 : 1));
  expect(reloaded.map((e) => e.request_id)).toEqual(["zz-send", "aa-stop"]);
});

test("a credential out on the channel never lands in the durable outbox, and goes again on the relay when the channel dies", async () => {
  const { runtime, client, rtc, outbox } = await setup();
  await until(() => client.path() === "direct");
  runtime.state.silentDirect = true; // answers lost, so each call stays out
  const set = client.call("secret.set", { request_id: "r-secret", repo: { path: "/w" }, secrets: [{ name: "API_TOKEN", value: ("sk-" + "proj-SECRET-VALUE") }] });
  const sent = client.call("turn.submit", { request_id: "r-submit", session_id: "s1", kind: "followup", input: { text: "hi" } } as never);
  await until(() => outbox.entries.has("r-submit"));
  expect([...outbox.entries.keys()]).toEqual(["r-submit"]);
  rtc.peers[0]!.channel!.kill();
  await expect(set).resolves.toEqual({});
  await expect(sent).resolves.toEqual({ turn_id: "t-r-submit", disposition: "started" });
});

test("a rewritten journal while on the channel resets once, and a hand-over after it keeps the new epoch", async () => {
  const { runtime, client, rtc } = await setup();
  for (let i = 0; i < 5; i++) runtime.append();
  const seen: number[] = [];
  const resets: number[] = [];
  await client.attach("s1", 0, (e) => seen.push(e.cursor), { onReset: (epoch) => (resets.push(epoch), (seen.length = 0)) });
  await until(() => client.path() === "direct" && runtime.direct()?.attached.has("s1") === true && seen.length === 5);
  runtime.rewrite(3);
  await until(() => resets.length === 1 && seen.length === 3);
  expect(resets).toEqual([2]);
  rtc.peers[0]!.channel!.kill();
  await until(() => client.path() === "relay" && runtime.relay()?.attached.has("s1") === true);
  runtime.append();
  await until(() => seen.length === 4);
  await until(() => client.path() === "direct");
  runtime.append();
  await until(() => seen.length === 5);
  expect(seen).toEqual([1, 2, 3, 4, 5]);
  expect(resets).toEqual([2]);
});

test("the offer passes the STUN servers this device uses to the laptop, read before each try", async () => {
  let servers: Array<{ urls: string }> = [{ urls: "stun:install.example.test:3478" }];
  const { runtime, client, rtc } = await setup({ iceServers: () => servers, retryMs: () => 20 });
  await until(() => client.path() === "direct");
  expect(rtc.peers[0]!.config.iceServers).toEqual([{ urls: "stun:install.example.test:3478" }]);
  expect(runtime.offers[0]).toMatchObject({ ice_servers: ["stun:install.example.test:3478"] });
  servers = [];
  rtc.peers[0]!.channel!.kill();
  await until(() => rtc.peers.length === 2 && client.path() === "direct");
  expect(rtc.peers[1]!.config.iceServers).toEqual([]);
  expect(runtime.offers[1]).toMatchObject({ ice_servers: [] });
});

test("with the direct path disabled it never offers and stays on the relay", async () => {
  const { runtime, client, rtc } = await setup({ enabled: () => false });
  await expect(client.call("engine.list", {})).resolves.toMatchObject({ via: "relay" });
  await new Promise((r) => setTimeout(r, 100));
  expect(rtc.peers).toHaveLength(0);
  expect(runtime.offers).toHaveLength(0);
});

test("the wire: frames past one message go as fragments and come back whole, multi-byte text included", () => {
  const big = JSON.stringify({ text: "é🙂".repeat(5_000) + "x".repeat(70_000) });
  const parts = directMessages(big, 16 * 1024);
  expect(parts.length).toBeGreaterThan(5);
  expect(parts.every((p) => typeof p !== "string" && p.length <= 16 * 1024)).toBe(true);
  const reader = new DirectReader();
  const out = parts.map((p) => reader.read(p));
  expect(out.slice(0, -1).every((o) => o.kind === "partial")).toBe(true);
  expect(out.at(-1)).toEqual({ kind: "frame", text: big });
  expect(directMessages("small")).toEqual(["small"]);
  const ping = reader.read(directPing(12.5));
  expect(ping.kind).toBe("ping");
  expect(reader.read((ping as { reply: Uint8Array }).reply)).toEqual({ kind: "pong", stamp: 12.5 });
  expect(() => new DirectReader().read(new Uint8Array([9, 1, 2]))).toThrow();
});

test("the fake runtime owns its loopback port: no other listener takes the connections the clients make to it", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  // On macOS another process may listen on 127.0.0.1 at a port a wildcard server holds, and then gets every connection
  // the clients make (they dial 127.0.0.1).
  const intruder = createServer();
  const bound = await new Promise<string>((resolve) => {
    intruder.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    intruder.listen(Number(new URL(runtime.url).port), "127.0.0.1", () => resolve("bound"));
  });
  intruder.close();
  expect(bound).toBe("EADDRINUSE");
});

// A call already handed to the channel's client waits in that client's lane, here behind an earlier call's onKept (the
// sender's IndexedDB mark), when the page loses its lock.
test("nothing goes out on the channel from a page that lost its lock, though the channel's client had the call already", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  let ours = true;
  const inner = memoryOutbox();
  const rtc = fakeRtc(runtime.url);
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox: { ...inner, ours: () => ours, put: (e: OutboxEntry) => inner.put(e) },
    direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined, silenceMs: 60_000 },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  let kept!: () => void;
  const slow = new Promise<void>((resolve) => (kept = resolve));
  const send = (id: string, onKept: () => Promise<void>) =>
    void client.call("turn.submit", { request_id: id, session_id: "s1", kind: "followup", input: { text: id } } as never, { onKept }).catch(() => undefined);
  send("x1", () => slow);
  send("x2", async () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(runtime.executions).toEqual([]);
  // The platform takes the lock (or pagehide) as x1's mark is written.
  ours = false;
  kept();
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(runtime.executions, "a page that lost its lock sends nothing").toEqual([]);
});

// Found by the sender's model check (client-delivery, the lost-page runs, on a page that held its lock): the relay
// client kept a call the dying channel handed it anew, at the time of the hand-off, behind a call the person made after
// it whose entry the store already held, so a reload before the relay came back ran the two in the wrong order.
test("a call the channel had, never sent, keeps its place in the outbox when the channel dies with the relay down: a reload sends the calls in the order made", async () => {
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  const inner = memoryOutbox();
  // A slow store: x2's entry is written at once, but its client hears so only later.
  const late = new Promise<void>(() => undefined);
  const outbox: Outbox = {
    ...inner,
    put: async (entry) => {
      await inner.put(entry);
      if (entry.request_id === "x2") await late;
    },
  };
  const rtc = fakeRtc(runtime.url);
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox,
    direct: { rtc: rtc.Rtc, iceServers: [], network: () => () => undefined, silenceMs: 60_000, enabled: () => rtc.peers.length === 0 },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  const send = (id: string, options: { onKept?: () => Promise<void>; unsentAfterMs?: number } = {}) =>
    void client.call("turn.submit", { request_id: id, session_id: "s1", kind: "followup", input: { text: id } } as never, options).catch(() => undefined);
  // y1's onKept (the sender's mark, a slow store) holds the channel client's lane, so x1 waits behind it there; y1 is
  // let go unsent meanwhile.
  send("y1", { onKept: () => new Promise<void>(() => undefined), unsentAfterMs: 50 });
  send("x1");
  await until(() => inner.entries.has("x1"));
  // The relay goes and stays down: what goes to it waits in the outbox.
  runtime.state.relayDown = true;
  runtime.dropRelay();
  send("x2");
  await until(() => inner.entries.has("x2") && !inner.entries.has("y1"));
  const madeAt = inner.entries.get("x1")!.at;
  rtc.peers[0]!.channel!.kill();
  await until(() => client.path() === "relay");
  await sleep(100);
  expect(inner.entries.get("x1")?.at, "x1 keeps the time it was made").toBe(madeAt);
  // The page reloads: a new client on the outbox, the relay back.
  client.close();
  runtime.state.relayDown = false;
  const next = connectDirect(runtime.url, "secret", undefined, { outbox: inner });
  cleanups.push(() => next.close());
  await until(() => runtime.executions.includes("x1") && runtime.executions.includes("x2"));
  expect(runtime.executions, "the calls in the order made").toEqual(["x1", "x2"]);
});
