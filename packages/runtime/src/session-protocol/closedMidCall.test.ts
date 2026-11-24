// A call still under way when its connection closes (the tab closes, the phone loses signal) leaves nothing on that
// connection: the close ends what the connection holds, and a call that takes its place after the close would be
// held by a connection nothing ends. A terminal attach reading its scrollback adds no output target; a tool.watch
// reading the store leaves no subscription to the command's output.
import * as fs from "node:fs";

import type { OrchestrationV2CommandOutputFrame } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";

import { CommandOutputHub } from "../orchestration-v2/CommandOutputHub.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { liveOutboxes } from "./server.ts";
import type { Outbox } from "./outbox.ts";
import * as Store from "./store.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

/** upstream terminal manager stand-in: plays output the test writes; an attach's scrollback comes once the test lets it. */
const terminal = {
  opened: [] as Array<{ terminalId: string; threadId: string }>,
  listeners: new Set<(event: never) => Effect.Effect<void>>(),
  observing: 0,
  scrollback: Promise.resolve(),
  emit(data: string) {
    const { terminalId, threadId } = terminal.opened.at(-1)!;
    return Promise.all(
      [...terminal.listeners].map((l) =>
        Effect.runPromise(l({ type: "output", threadId, terminalId, data } as never)),
      ),
    );
  },
};
const layerTerminal = Layer.mock(TerminalManager.TerminalManager)({
  open: (input) =>
    Effect.sync(
      () => (
        terminal.opened.push({ terminalId: input.terminalId!, threadId: input.threadId }),
        {} as never
      ),
    ),
  write: () => Effect.void,
  close: () => Effect.void,
  subscribe: (listener) =>
    Effect.sync(
      () => (
        terminal.listeners.add(listener as never),
        () => terminal.listeners.delete(listener as never)
      ),
    ),
  observeStream: (_input, listener) =>
    Effect.sync(() => {
      terminal.observing++;
      void terminal.scrollback.then(() =>
        Effect.runPromise(listener({ type: "snapshot", snapshot: { history: "$ " } } as never)),
      );
      return () => undefined;
    }),
});

/** The hub stand-in: a command still running, whose output so far is a subscription's first frame; each subscription lives until its stream ends. */
const hub = { subscribed: new Set<string>(), ended: new Set<string>() };
const layerHub = Layer.mock(CommandOutputHub)({
  append: () => Effect.void,
  finish: () => Effect.void,
  subscribe: (target) =>
    Stream.unwrap(
      Effect.gen(function* () {
        hub.subscribed.add(target.itemId);
        const frames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
        yield* Queue.offer(frames, {
          kind: "replace",
          text: "listening on :3000\r\n",
          truncated: false,
          running: true,
        });
        return Stream.fromQueue(frames);
      }),
    ).pipe(Stream.ensuring(Effect.sync(() => hub.ended.add(target.itemId)))),
});

/** The store's own SqlClient, so a test can hold its one writer as a commit in progress does. */
let sqlClient: SqlClient.SqlClient | undefined;
const captureSql = Layer.effectDiscard(
  Effect.gen(function* () {
    sqlClient = yield* SqlClient.SqlClient;
  }),
).pipe(Layer.provide(Store.layer));

/** Holds the runtime's one SQLite writer, as another chat's commit does while it streams, until the returned release. */
async function holdWriter() {
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const done = Effect.runPromise(
    sqlClient!.withTransaction(Effect.promise(() => (entered(), released))),
  );
  await inside;
  return async () => {
    release();
    await done;
  };
}

const root = tempRoot("sp-closed-mid-call-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, {
    provide: Layer.mergeAll(layerTerminal, layerHub, captureSql) as never,
  });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A raw connection, and its outbox in the runtime with what is pushed there, kept even once it is closed. */
async function droppingClient() {
  const before = new Set(liveOutboxes);
  const ws = new WebSocket(runtime.url, ["caveman.session.v1"], {
    headers: { authorization: `Bearer ${runtime.token()}` },
  });
  const frames: Array<{ id?: number }> = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
  await until(() => [...liveOutboxes].some((outbox) => !before.has(outbox)));
  const outbox: Outbox = [...liveOutboxes].find((candidate) => !before.has(candidate))!;
  const pushed = {
    replies: [] as Array<unknown>,
    methods: [] as Array<string>,
    terminalOutput: [] as Array<string>,
  };
  const push = outbox.push.bind(outbox);
  outbox.push = (frame: string) => {
    const message = JSON.parse(frame) as { id?: unknown; method?: string };
    if (message.id !== undefined) pushed.replies.push(message.id);
    if (message.method !== undefined) pushed.methods.push(message.method);
    push(frame);
  };
  const pushTerminalOutput = outbox.pushTerminalOutput.bind(outbox);
  outbox.pushTerminalOutput = (terminalId: string, data: string) => {
    pushed.terminalOutput.push(data);
    pushTerminalOutput(terminalId, data);
  };
  let next = 1;
  const send = (method: string, params: unknown) => {
    const id = next++;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  };
  const answer = async (id: number) => {
    await until(() => frames.some((f) => f.id === id));
    return frames.find((f) => f.id === id)!;
  };
  /** Closes the socket and waits until the runtime let the connection go (its outbox goes last). */
  const close = async () => {
    ws.close();
    await until(() => !liveOutboxes.has(outbox));
  };
  return { send, answer, close, pushed };
}

test("a terminal attach still reading the scrollback when its connection closes sends that connection none of the terminal's output", async () => {
  const w = await createReady(client, {
    request_id: "cm-w",
    repo: { path: makeRepo(root, { "README.md": "dev\n" }) },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const output: Array<string> = [];
  client.on("term.output", (p) => output.push(p.data));
  // A long-lived terminal (a dev server) the other window opened.
  const { terminal_id } = await client.call("term.open", {
    request_id: "cm-t",
    workspace_id: w.id,
    cols: 80,
    rows: 24,
    command: "npm run dev",
  });

  const dropped = await droppingClient();
  let readScrollback!: () => void;
  terminal.scrollback = new Promise<void>((resolve) => (readScrollback = resolve));
  const observing = terminal.observing;
  const attach = dropped.send("term.attach", { terminal_id });
  await until(() => terminal.observing > observing);
  await dropped.close();
  readScrollback();
  // Answered, to nobody: the attach has done all it will.
  await until(() => dropped.pushed.replies.includes(attach));

  await terminal.emit("ready on :3000\r\n");
  await until(() => output.join("").endsWith("ready on :3000\r\n"));
  expect(dropped.pushed.terminalOutput).toEqual([]);
});

test("a tool.watch still reading the store when its connection closes leaves no subscription to the command's output", async () => {
  const w = await createReady(client, {
    request_id: "cm-w2",
    repo: { path: makeRepo(root, { "README.md": "watch\n" }) },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const dropped = await droppingClient();
  const release = await holdWriter();
  // The row of a running dev server opens: the watch reads the chat from the store, behind another chat's commit.
  const watch = dropped.send("tool.watch", { workspace_id: w.id, item_id: "cmd-dev" });
  // Another chat's detach waits on nothing: once it is answered, the runtime has read the watch before it.
  await dropped.answer(dropped.send("session.detach", { session_id: "s-elsewhere" }));
  await dropped.close();
  await release();
  // Answered, to nobody: the watch has done all it will.
  await until(() => dropped.pushed.replies.includes(watch));
  expect({
    subscribed: hub.subscribed.has("cmd-dev") && !hub.ended.has("cmd-dev"),
    toolLive: dropped.pushed.methods.filter((method) => method === "tool.live").length,
  }).toEqual({ subscribed: false, toolLive: 0 });
});
