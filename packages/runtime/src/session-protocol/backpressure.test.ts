// A client that stops reading (a laptop lid, a slow relay) while a command prints megabytes and the
// workspace list churns: the runtime's queue for it stays bounded (outbox.ts), and once it reads again
// it ends up with the terminal's real screen and the latest workspace state. A chat's backlog that waits
// for such a client keeps nothing of the other chats meanwhile.
import * as fs from "node:fs";

import { connect } from "@caveman-app/session-protocol";
import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";

import * as TerminalManager from "../terminal/Manager.ts";
import type { DraftEvent } from "./projector.ts";
import { liveOutboxes } from "./server.ts";
import * as Store from "./store.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

/** upstream terminal manager stand-in: plays output the test writes; its history is what term.attach returns. */
const terminal = {
  opened: [] as Array<{ terminalId: string; threadId: string }>,
  listeners: new Set<(event: never) => Effect.Effect<void>>(),
  history: "",
  emit(data: string) {
    const { terminalId, threadId } = terminal.opened.at(-1)!;
    return Promise.all([...terminal.listeners].map((l) => Effect.runPromise(l({ type: "output", threadId, terminalId, data } as never))));
  },
};
const layerTerminal = Layer.mock(TerminalManager.TerminalManager)({
  open: (input) => Effect.sync(() => (terminal.opened.push({ terminalId: input.terminalId!, threadId: input.threadId }), {} as never)),
  getShell: () => Effect.succeed("/bin/zsh"),
  write: () => Effect.void,
  close: () => Effect.void,
  subscribe: (listener) => Effect.sync(() => (terminal.listeners.add(listener as never), () => terminal.listeners.delete(listener as never))),
  observeStream: (_input, listener) => listener({ type: "snapshot", snapshot: { history: terminal.history } } as never).pipe(Effect.as(() => undefined)),
});

let sessions!: Store.SessionStore["Service"];
/** The route's own store (Store.layer is memoized: one instance), to journal a long chat directly. */
const grab = Layer.effectDiscard(
  Effect.gen(function* () {
    sessions = yield* Store.SessionStore;
  }),
).pipe(Layer.provide(Store.layer));

const root = tempRoot("sp-backpressure-");
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
const listenerWarnings: Array<string> = [];
const noteWarning = (warning: Error) => {
  if (warning.name === "MaxListenersExceededWarning") listenerWarnings.push(warning.message);
};

beforeAll(async () => {
  process.on("warning", noteWarning);
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: Layer.mergeAll(layerTerminal, grab) });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  process.off("warning", noteWarning);
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A raw client that can stop reading: its socket is paused, so the runtime's writes back up as for a stalled link. */
const slowClient = async (url: string, token: string) => {
  const ws = new WebSocket(url, ["caveman.session.v1"], { headers: { authorization: `Bearer ${token}` }, perMessageDeflate: false });
  const received: Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }> = [];
  const replies = new Map<number, (result: Record<string, unknown>) => void>();
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as (typeof received)[number];
    received.push(frame);
    if (frame.id !== undefined) replies.get(frame.id)?.(frame.result ?? {});
  });
  await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
  let next = 1;
  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = next++;
      replies.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  const socket = (ws as unknown as { _socket: import("node:net").Socket })._socket;
  return { ws, received, call, pause: () => socket.pause(), resume: () => socket.resume() };
};

test("a stalled client's queue stays bounded through a chatty command and a burst of workspace changes; reading again, it converges", async () => {
  const repo = makeRepo(root, { "README.md": "slow\n" });
  const w = await createReady(client, { request_id: "bp-w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const { terminal_id } = await client.call("term.open", { request_id: "bp-t", workspace_id: w.id, cols: 120, rows: 30, command: "make" });

  const slow = await slowClient(runtime.url, runtime.token());
  await slow.call("term.attach", { terminal_id });
  slow.pause();

  // 24 MB of build output in 32 KB writes, and a burst of renames, while the client reads nothing.
  const line = (i: number) => `[${String(i).padStart(7, "0")}] compiling src/module_${i % 97}/file_${i}.ts ${"·".repeat(40)}\r\n`;
  let printed = "";
  let peak = 0;
  const sample = () => {
    for (const outbox of liveOutboxes) peak = Math.max(peak, outbox.stats().peakBytes);
  };
  // The stall reaches the runtime's queue once the socket holds 512 KB unsent (the queue then resyncs the terminal);
  // the OS's buffers still take some more, as much as they grow to. The renames start 2 MB after that.
  let behindAt = -1;
  let i = 0;
  let renames = 0;
  for (let chunk = 0; chunk < 768; chunk++) {
    let data = "";
    while (data.length < 32 * 1024) data += line(i++);
    printed += data;
    await terminal.emit(data);
    if (behindAt < 0 && [...liveOutboxes].some((outbox) => outbox.stats().resyncs > 0)) behindAt = chunk;
    if (behindAt >= 0 && chunk >= behindAt + 64 && chunk % 2 === 0) {
      renames += 1;
      await client.call("workspace.rename", { request_id: `bp-r${chunk}`, workspace_id: w.id, title: `build ${chunk}` });
    }
    sample();
  }
  await client.call("workspace.rename", { request_id: "bp-final", workspace_id: w.id, title: "build done" });
  sample();
  expect(printed.length).toBeGreaterThan(24_000_000);
  expect(renames).toBeGreaterThan(100);
  // What waited for the stalled client never passed one terminal's limit plus a few small frames.
  expect(peak).toBeLessThan(512 * 1024);

  // The runtime keeps the terminal's recent screen, as the real manager does; the client reads again.
  terminal.history = printed.slice(-200_000);
  slow.resume();
  await until(() => slow.received.some((f) => f.method === "term.resync" && f.params?.terminal_id === terminal_id), 20_000);
  const reattached = await slow.call("term.attach", { terminal_id });
  let screen = String(reattached.scrollback);
  const after = slow.received.length;
  await terminal.emit("DONE\r\n");
  // The secret scrubber may hold a tail back until output pauses: wait for all of it.
  const output = () =>
    slow.received
      .slice(after)
      .filter((f) => f.method === "term.output" && f.params?.terminal_id === terminal_id)
      .map((f) => String(f.params!.data))
      .join("");
  await until(() => output().endsWith("DONE\r\n"), 10_000);
  screen += output();
  expect(screen).toBe(terminal.history + "DONE\r\n");

  // Each rename changes the workspace twice: of those hundreds of changes, the stalled client was sent the latest
  // and the few the OS's buffers still took (27 of 670 on macOS).
  await until(() => slow.received.filter((f) => f.method === "workspace.changed").at(-1)?.params?.title === "build done", 10_000);
  const changes = slow.received.filter((f) => f.method === "workspace.changed" && f.params?.id === w.id);
  // Not on Windows: its loopback grows a paused reader's buffers by megabytes (about 1 MB more within 3 s on
  // windows-2025, and still growing), so the renames wait in the OS's buffers rather than the runtime's queue and
  // there is nothing for the queue to merge. The queue's own bound is the peak asserted above.
  if (process.platform !== "win32") expect(changes.length).toBeLessThan(renames / 4);
  slow.ws.close();
  expect(listenerWarnings).toEqual([]);
}, 180_000);

const note = (title: string): DraftEvent => ({ at: new Date().toISOString(), type: "notification", payload: { level: "info", title } }) as DraftEvent;
/** Journals `n` notifications to a chat, as the runtime commits a turn's events. */
async function journal(sessionId: string, n: number, title: (i: number) => string) {
  for (let i = 0; i < n; i += 500) {
    const events = Array.from({ length: Math.min(500, n - i) }, (_, k) => note(title(i + k)));
    await Effect.runPromise(sessions.append(sessionId, () => Effect.succeed({ events, value: undefined })));
  }
}

// Every client attaches with batch (client.ts): the backlog goes out a page of the journal at a time, the next once the
// client took most of the last. A device that stops reading holds that backlog back while the other chats work on.
test("a chat's backlog waiting on a stalled client holds none of the other chats' events, and then finishes whole", async () => {
  const chat = (title: string) => createReady(client, { request_id: `bp-${title}`, repo: { path: makeRepo(root, { "README.md": `${title}\n` }) }, title, engine: "claude-agent", options: { model: MODEL } });
  const long = await chat("long");
  const other = await chat("other");
  // Past one page (2,000 events): the first page alone is some 8 MB.
  await journal(long.session_id, 3_000, (i) => `long ${i} ${"x".repeat(4_000)}`);
  /** Committed events some subscription has not taken yet. */
  const retained = () => Effect.runPromise(PubSub.size(sessions.events));
  await until(async () => (await retained()) === 0);

  const slow = await slowClient(runtime.url, runtime.token());
  void slow.call("session.attach", { session_id: long.session_id, cursor: 0, batch: true });
  slow.pause();
  // The backlog pauses: past its 2 MiB, the rest of the first page waits for the client, and stays.
  const behind = () => [...liveOutboxes].find((outbox) => outbox.stats().bytes > 2 * 1024 * 1024);
  await until(() => behind() !== undefined, 30_000);
  let waiting = -1;
  await until(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const now = behind()?.stats().bytes ?? -1;
    const steady = now === waiting;
    waiting = now;
    return steady;
  }, 30_000);

  // Meanwhile the long chat goes on a little, and another chat a lot.
  await journal(long.session_id, 5, (i) => `during ${i}`);
  await journal(other.session_id, 2_000, (i) => `other ${i}`);
  await until(async () => (await retained()) === 0, 5_000).catch(() => undefined);
  expect(await retained()).toBe(0);

  // Reading again, the client gets the long chat whole and in order, what came during the stall included.
  const head = (await Effect.runPromise(sessions.getBySession(long.session_id)))!.session.head;
  slow.resume();
  const heard = () =>
    slow.received
      .filter((f) => (f.method === "session.event" || f.method === "session.events") && (f.params as { session_id: string }).session_id === long.session_id)
      .flatMap((f) => (f.method === "session.event" ? [f.params as unknown as SessionEvent] : ((f.params as { events: Array<SessionEvent> }).events)));
  await until(() => heard().at(-1)?.cursor === head, 60_000);
  expect(heard().map((e) => e.cursor)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
  expect(heard().filter((e) => e.type === "notification" && (e.payload as { title: string }).title.startsWith("during ")).length).toBe(5);
  slow.ws.close();
}, 180_000);
