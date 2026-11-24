// The relay wire as the runtime reads it, against a relay on loopback: the relay is not trusted to drive This Mac
// (THREAT-MODEL.md), so what it writes is checked before anything acts on it.
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, expect, test, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { dialRelay, RELAY_SUBPROTOCOL, type OpenInfo } from "./relay.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const frame = (type: number, id: Buffer, payload: string) =>
  Buffer.concat([Buffer.from([type]), id, Buffer.from(payload, "utf8")]);

// Audit security-3#4: an OPEN whose payload was JSON but no OpenInfo (`null`) reached onOpen, whose first read of
// info.organization_id threw inside ws's message listener and ended the runtime.
test("an OPEN whose payload is not the relay's OpenInfo is refused at the wire, and the connection keeps serving", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, handleProtocols: () => RELAY_SUBPROTOCOL });
  const peer = new Promise<WebSocket>((resolve) => wss.once("connection", resolve));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (wss.close(), server.close(() => resolve()))));
  const infos: Array<OpenInfo> = [];
  const connection = dialRelay({
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/relay/v1`,
    token: "ccrt_test",
    onOpen: (_stream, info) => (infos.push(info), { message: () => {}, closed: () => {} }),
    log: () => {},
  });
  cleanups.push(() => connection.close());
  await connection.opened;
  const relay = await peer;
  const closes: Array<string> = [];
  relay.on(
    "message",
    (data: Buffer) => data[0] === 4 && closes.push(data.subarray(17).toString("utf8")),
  );

  const bad = [
    "null",
    "5",
    '"org"',
    "[]",
    "{}",
    '{"organization_id":"org-1"}',
    '{"organization_id":"org-1","user_id":7}',
    '{"organization_id":"org-1","user_id":"u","subprotocol":1}',
  ];
  for (const payload of bad) relay.send(frame(1, randomBytes(16), payload));
  const good = { organization_id: "org-1", user_id: "user-1", subprotocol: "caveman.session.v1" };
  relay.send(frame(1, randomBytes(16), JSON.stringify(good)));
  await expect.poll(() => infos.length + closes.length).toBe(bad.length + 1);

  expect(infos).toEqual([good]);
  expect(closes).toEqual(bad.map(() => "bad open frame"));
  expect(connection.streamCount()).toBe(1);
});

const SILENCE_MS = 400;

/**
 * A relay on loopback whose liveness the test sets: `answers` the runtime's pings with a pong, pings on its own every
 * `pingMs` (0: never, as the relay at Cloudflare's edge), sends a frame every `frameMs` (0: none).
 */
async function relayOf(life: { answers: boolean; pingMs: number; frameMs: number }) {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    autoPong: false,
    handleProtocols: () => RELAY_SUBPROTOCOL,
  });
  const seen = { pings: 0, keepalive: undefined as string | Array<string> | undefined };
  wss.on("connection", (ws, request) => {
    seen.keepalive = request.headers["x-cave-relay-keepalive"];
    ws.on("ping", (data) => {
      seen.pings++;
      if (life.answers) ws.pong(data);
    });
    const tick = setInterval(
      () => {
        if (life.pingMs > 0) ws.ping();
        if (life.frameMs > 0) ws.send(frame(9, randomBytes(16), ""));
      },
      life.pingMs || life.frameMs || 1_000,
    );
    ws.on("close", () => clearInterval(tick));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (wss.close(), server.close(() => resolve()))));
  const logs: Array<string> = [];
  const connection = dialRelay({
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/relay/v1`,
    token: "ccrt_test",
    onOpen: () => ({ message: () => {}, closed: () => {} }),
    log: (line) => logs.push(line),
    silenceMs: SILENCE_MS,
  });
  cleanups.push(() => connection.drop());
  await connection.opened;
  return { connection, seen, logs, life };
}

/** How long from now until the runtime has dropped the relay. */
const droppedAfter = async (connection: { ended: Promise<unknown> }) => {
  const at = performance.now();
  await connection.ended;
  return performance.now() - at;
};

test.each([
  [
    "never pings but answers the runtime's, as the one at the edge does",
    { answers: true, pingMs: 0, frameMs: 0 },
  ],
  ["pings and never answers", { answers: false, pingMs: 100, frameMs: 0 }],
  ["only sends frames", { answers: false, pingMs: 0, frameMs: 100 }],
])(
  "a relay that %s is kept: the runtime pings it on its own clock and takes any sign of it",
  async (_relay, life) => {
    const { connection, seen } = await relayOf(life);
    let ended = false;
    void connection.ended.then(() => (ended = true));
    await new Promise((resolve) => setTimeout(resolve, 5 * SILENCE_MS));
    expect(ended).toBe(false);
    expect(connection.isOpen()).toBe(true);
    // Told on the upgrade that it need not ping, and pinged every quarter of the silence allowed.
    expect(seen.keepalive).toBe("ping");
    expect(seen.pings).toBeGreaterThanOrEqual(15);
  },
);

test("a relay that goes silent is dropped within a quarter past the silence allowed", async () => {
  const { connection, logs, life } = await relayOf({ answers: true, pingMs: 0, frameMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 2 * SILENCE_MS));
  expect(connection.isOpen()).toBe(true);
  life.answers = false;
  const took = await droppedAfter(connection);
  await expect(connection.ended).resolves.toMatchObject({ kind: "lost" });
  expect(took).toBeGreaterThan(SILENCE_MS * 0.75);
  expect(took).toBeLessThan(SILENCE_MS * 1.25 + 250);
  expect(logs.join("\n")).toMatch(/relay connection silent/);
});

test("a wall clock stepped back hides no silence: the relay is dropped as soon", async () => {
  const { connection, life } = await relayOf({ answers: true, pingMs: 0, frameMs: 0 });
  life.answers = false;
  // An hour back, and further back at every reading: by the wall clock no time ever passes.
  const real = Date.now.bind(Date);
  let back = 3_600_000;
  const stepped = vi.spyOn(Date, "now").mockImplementation(() => real() - (back += 60_000));
  cleanups.push(() => stepped.mockRestore());
  const took = await droppedAfter(connection);
  expect(took).toBeGreaterThan(SILENCE_MS * 0.75);
  expect(took).toBeLessThan(SILENCE_MS * 1.25 + 250);
});
