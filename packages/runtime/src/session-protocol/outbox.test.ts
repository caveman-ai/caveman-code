import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";

import { Outbox } from "./outbox.ts";

const frames = (outbox: Outbox) => {
  const out: Array<{ method?: string; params?: { terminal_id?: string; data?: string; id?: string; title?: string }; id?: number }> = [];
  while (outbox.size() > 0) out.push(JSON.parse(Effect.runSync(outbox.take)));
  return out;
};

test("a chatty terminal behind a stalled client stays bounded, then the client converges through term.resync", () => {
  const outbox = new Outbox({ max: 16 * 1024 * 1024, terminalMax: 256 * 1024 });
  // What the terminal printed, as the runtime's history keeps it; the client re-attaches for it after a resync.
  let history = "";
  const line = (i: number) => `line ${String(i).padStart(7, "0")} ${"x".repeat(80)}\r\n`;
  let i = 0;
  for (; i < 200_000; i++) {
    history += line(i);
    outbox.pushTerminalOutput("t1", line(i));
    expect(outbox.stats().bytes).toBeLessThanOrEqual(256 * 1024 + 4096);
  }
  // 20 MB printed while the client read nothing: one terminal's worth waited at most, then a single resync.
  expect(history.length).toBeGreaterThan(18_000_000);
  expect(outbox.stats().peakBytes).toBeLessThan(300 * 1024);
  expect(outbox.stats().resyncs).toBe(1);

  // The client reads again: a resync, which it answers with term.attach (the server resumes the terminal then).
  let screen = "";
  for (const frame of frames(outbox)) {
    if (frame.method === "term.output") screen += frame.params!.data;
    if (frame.method === "term.resync") {
      screen = history;
      outbox.resumeTerminal("t1");
    }
  }
  for (; i < 200_010; i++) {
    history += line(i);
    outbox.pushTerminalOutput("t1", line(i));
  }
  for (const frame of frames(outbox)) if (frame.method === "term.output") screen += frame.params!.data;
  expect(screen).toBe(history);
});

test("output of one terminal waiting is one frame; an exit ends it and keeps its place", () => {
  const outbox = new Outbox();
  for (let i = 0; i < 1000; i++) outbox.pushTerminalOutput("t1", `${i}\n`);
  outbox.pushTerminalFrame("t1", JSON.stringify({ jsonrpc: "2.0", method: "term.exit", params: { terminal_id: "t1", exit_code: 0 } }));
  outbox.pushTerminalOutput("t2", "other\n");
  const sent = frames(outbox);
  expect(sent.map((f) => f.method)).toEqual(["term.output", "term.exit", "term.output"]);
  expect(sent[0]!.params!.data).toBe(Array.from({ length: 1000 }, (_, i) => `${i}\n`).join(""));
  expect(outbox.stats().merged).toBe(999);
});

test("a pushed state waiting is replaced by the newer one; replies and events keep their order", () => {
  const outbox = new Outbox();
  outbox.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  for (let n = 0; n < 500; n++) {
    outbox.pushLatest("workspace:w1", JSON.stringify({ jsonrpc: "2.0", method: "workspace.changed", params: { id: "w1", title: `title ${n}` } }));
    outbox.pushLatest("workspace:w2", JSON.stringify({ jsonrpc: "2.0", method: "workspace.changed", params: { id: "w2", title: `other ${n}` } }));
  }
  outbox.push(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }));
  const sent = frames(outbox);
  expect(sent.map((f) => f.id ?? `${f.params!.id}:${f.params!.title}`)).toEqual([1, "w1:title 499", "w2:other 499", 2]);
  expect(outbox.stats().bytes).toBe(0);
});

test("replaced states release their payloads even while the writer is stalled", () => {
  const outbox = new Outbox({ max: 64 * 1024, terminalMax: 16 * 1024 });
  outbox.push(JSON.stringify({ id: 1 }));
  // Inspect retained storage, not just stats: dropped entries must not keep every old payload alive.
  const retained = () => (outbox as unknown as { queue: Array<{ frame?: string }> }).queue;
  for (let n = 0; n < 20_000; n++) {
    outbox.pushLatest("workspace:w1", JSON.stringify({ params: { id: "w1", title: `${n}:${"x".repeat(4096)}` } }));
    if (n === 10_000) outbox.push(JSON.stringify({ id: 2 }));
  }
  expect(outbox.overflowed).toBe(false);
  expect(retained().length).toBeLessThan(2048);
  expect(retained().reduce((bytes, entry) => bytes + (entry?.frame?.length ?? 0), 0)).toBeLessThan(64 * 1024);
  const sent = frames(outbox);
  expect(sent.map((frame) => frame.id ?? frame.params!.title!.split(":")[0])).toEqual([1, 2, "19999"]);
  expect(outbox.stats().bytes).toBe(0);
});

test("a drain waiter appending during resync cannot make compaction skip terminal output", async () => {
  const outbox = new Outbox();
  for (let n = 0; n < 700; n++) outbox.pushLatest("first", JSON.stringify({ id: 1 }));
  outbox.pushTerminalOutput("t1", "A".repeat(128 * 1024));
  outbox.pushTerminalFrame("t1", JSON.stringify({ method: "term.exit" }));
  outbox.pushTerminalOutput("t1", "B".repeat(128 * 1024));
  for (let n = 0; n < 322; n++) outbox.pushLatest("second", JSON.stringify({ id: 2 }));
  const paced = Effect.runFork(outbox.awaitBelow(256 * 1024).pipe(
    Effect.andThen(Effect.sync(() => outbox.push(JSON.stringify({ id: 3 })))),
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(paced.pollUnsafe()).toBeUndefined();
  outbox.pushTerminalOutput("t1", "C".repeat(32 * 1024));
  await Effect.runPromise(Fiber.join(paced));
  const sent = frames(outbox);
  expect(sent.filter((frame) => frame.method === "term.output")).toEqual([]);
  expect(sent.filter((frame) => frame.method === "term.resync")).toHaveLength(1);
  expect(outbox.stats().bytes).toBe(0);
});

test("past the limit the outbox says so once; a paced producer waits until it drains", async () => {
  const outbox = new Outbox({ max: 10_000, terminalMax: 4_000 });
  let overflows = 0;
  outbox.onOverflow = () => overflows++;
  for (let n = 0; n < 50; n++) outbox.push("x".repeat(1_000));
  expect(overflows).toBe(1);
  expect(outbox.overflowed).toBe(true);

  const paced = Effect.runFork(outbox.awaitBelow(5_000));
  await new Promise((r) => setTimeout(r, 10));
  expect(paced.pollUnsafe()).toBeUndefined();
  while (outbox.stats().bytes > 5_000) Effect.runSync(outbox.take);
  await Effect.runPromise(Fiber.join(paced));
  outbox.close();
  expect(outbox.stats().bytes).toBe(0);
});

test("one maximum media reply fits the default finite queue, while two waiting replies overflow", () => {
  const outbox = new Outbox();
  const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { mime_type: "image/png", data: Buffer.alloc(16 * 1024 * 1024).toString("base64") } });
  outbox.push(frame);
  expect(outbox.overflowed).toBe(false);
  expect(outbox.stats().bytes).toBeLessThan(outbox.limits.max);
  outbox.push(frame);
  expect(outbox.overflowed).toBe(true); // Server pacing must prevent this, never disable the limit.
});

test("a client that keeps up is never resynced, however much a terminal prints", async () => {
  const outbox = new Outbox({ max: 1024 * 1024, terminalMax: 64 * 1024 });
  let received = 0;
  const reader = Effect.runFork(Effect.forever(Effect.map(outbox.take, (frame) => (received += JSON.parse(frame).params.data.length))));
  await new Promise((r) => setTimeout(r, 5));
  // Output arrives as the pty delivers it, between which the writer runs.
  for (let n = 0; n < 10_000; n++) {
    outbox.pushTerminalOutput("t1", "x".repeat(1_000));
    if (n % 16 === 15) await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 5));
  expect(received).toBe(10_000_000);
  expect(outbox.stats().resyncs).toBe(0);
  await Effect.runPromise(Fiber.interrupt(reader));
});
