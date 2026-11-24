// One control connection to Cloud's relay (Caveman Cloud cloud/relay, "Relay
// wire"): every WebSocket message is binary, byte 0 the frame type, bytes
// 1..16 an opaque stream id, then the payload. The relay multiplexes each
// attached client onto a stream; this side hands each stream to a sink.
import WebSocket from "ws";

import { proxyFor, tunnelAgent } from "./envProxy.ts";

export const RELAY_SUBPROTOCOL = "caveman.relay.v1";
const OPEN = 1;
const TEXT = 2;
const BINARY = 3;
const CLOSE = 4;
const TOKEN = 5;
const HEADER = 17;
const ZERO_ID = Buffer.alloc(16);
/** The relay caps a message at 24 MiB; leave room for the header. */
const MAX_PAYLOAD = 24 * 1024 * 1024 + 1024;
/** The relay reads at most 24 MiB plus the header per message from the runtime, and ends the whole connection past that. */
export const RELAY_READ_LIMIT = 24 * 1024 * 1024 + HEADER;
/**
 * The runtime keeps the connection alive itself: it pings the relay every quarter of this, and whatever the relay says
 * (the pong, a ping of its own, a frame) is proof the relay is there. This long without any, the connection is dead
 * however open the socket looks (a sleeping laptop, an idle NAT). Measured on the monotonic clock: a wall clock stepped
 * back would hide the silence. The core's relay also pings every 25 s; the relay at Cloudflare's edge cannot ping at
 * all, and only answers.
 */
const SILENCE_MS = 60_000;
/**
 * Tells the relay at the edge that this runtime needs no ping from it. A runtime that waited to hear one (every release
 * before this) sends no such header, and the edge hands it to the core's relay.
 */
const KEEPALIVE_HEADER = "x-cave-relay-keepalive";
/** Above this many unsent bytes on the socket, a stream's send waits for the socket to drain. */
export const HIGH_WATER = 4 * 1024 * 1024;

/** What the relay verified about the client: ids come from Cloud's auth, never the client. */
export interface OpenInfo {
  readonly organization_id: string;
  readonly user_id: string;
  readonly subprotocol?: string;
}

export interface StreamSink {
  message(data: string | Uint8Array): void;
  /** The stream is over (the client left, or the connection dropped); nothing follows. */
  closed(reason: string): void;
}

export interface RelayStream {
  /** Resolves at once, or once the socket drains when it holds more than HIGH_WATER bytes. */
  send(data: string | Uint8Array): Promise<void>;
  /** Ends the stream (the relay closes the client 1000 with `reason`) and its sink. Idempotent. */
  close(reason?: string): void;
}

export type RelayEnd =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "replaced" }
  | { readonly kind: "lost"; readonly code: number; readonly reason: string };

export interface RelayConnection {
  /** Resolves when the connection is up; rejects if it ends first. */
  readonly opened: Promise<void>;
  /** Resolves once the connection is gone and every stream was told. */
  readonly ended: Promise<RelayEnd>;
  sendToken(token: string): void;
  isOpen(): boolean;
  close(): void;
  /** Ends the connection at once, without a close handshake (its peer may be gone): its streams are told it was lost. */
  drop(): void;
  streamCount(): number;
}

const frame = (type: number, id: Buffer, payload: Uint8Array | string = "") =>
  Buffer.concat([Buffer.from([type]), id, typeof payload === "string" ? Buffer.from(payload, "utf8") : payload]);

/** An OPEN frame's payload, or undefined when it is not OpenInfo's JSON: the relay is not trusted to drive This Mac (S13). */
const openInfoOf = (payload: Buffer): OpenInfo | undefined => {
  let info: unknown;
  try {
    info = JSON.parse(payload.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof info !== "object" || info === null) return undefined;
  const { organization_id, user_id, subprotocol } = info as Record<string, unknown>;
  return typeof organization_id === "string" && typeof user_id === "string" && (subprotocol === undefined || typeof subprotocol === "string") ? (info as OpenInfo) : undefined;
};

/** 4401: the token was refused or expired; 4409: a newer connection of this runtime took over. */
const endOf = (code: number, reason: string): RelayEnd =>
  code === 4401 ? { kind: "unauthorized" } : code === 4409 ? { kind: "replaced" } : { kind: "lost", code, reason };

export function dialRelay(options: {
  readonly url: string;
  readonly token: string;
  readonly onOpen: (stream: RelayStream, info: OpenInfo) => StreamSink;
  readonly log: (message: string) => void;
  /** With nothing heard from the relay for this long the connection is ended; it is pinged every quarter of it (default 60 s). */
  readonly silenceMs?: number;
}): RelayConnection {
  // A computer whose egress goes through the install's proxy dials the relay through it too.
  const proxy = proxyFor(new URL(options.url));
  const ws = new WebSocket(options.url, [RELAY_SUBPROTOCOL], {
    headers: { authorization: `Bearer ${options.token}`, [KEEPALIVE_HEADER]: "ping" },
    ...(proxy === undefined ? {} : { agent: tunnelAgent(proxy, new URL(options.url)) }),
    maxPayload: MAX_PAYLOAD,
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
  });
  // The sink is unset while onOpen runs (it may close the stream at once).
  const streams = new Map<string, { sink: StreamSink | undefined; ended: boolean }>();
  let settle: (end: RelayEnd) => void = () => {};
  const ended = new Promise<RelayEnd>((resolve) => (settle = resolve));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    void ended.then(() => reject(new Error("the relay connection ended before it opened")));
  });
  opened.catch(() => {});

  const silenceMs = options.silenceMs ?? SILENCE_MS;
  let lastHeard = performance.now();
  const heard = () => (lastHeard = performance.now());
  ws.on("open", heard);
  ws.on("ping", heard);
  ws.on("pong", heard);
  const watchdog = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (performance.now() - lastHeard <= silenceMs) return ws.ping();
    options.log(`relay connection silent for ${Math.round((performance.now() - lastHeard) / 1000)} s; reconnecting`);
    ws.terminate();
  }, silenceMs / 4);
  watchdog.unref();
  void ended.then(() => clearInterval(watchdog));

  const endAll = (reason: string) => {
    for (const entry of streams.values()) {
      entry.ended = true;
      entry.sink?.closed(reason);
    }
    streams.clear();
  };

  const handle = (id: Buffer): RelayStream => {
    const key = id.toString("hex");
    const stream: RelayStream = {
      send: (data) =>
        new Promise<void>((resolve) => {
          const entry = streams.get(key);
          if (entry === undefined || entry.ended || ws.readyState !== WebSocket.OPEN) return resolve();
          const message = frame(typeof data === "string" ? TEXT : BINARY, id, data);
          // One message past the relay's limit would drop every client of this runtime: end only this stream.
          if (message.length > RELAY_READ_LIMIT) {
            options.log(`relay stream closed: a ${message.length}-byte message is over the relay's limit`);
            stream.close("a reply was too large for the relay");
            return resolve();
          }
          const busy = ws.bufferedAmount > HIGH_WATER;
          ws.send(message, { binary: true }, () => busy && resolve());
          if (!busy) resolve();
        }),
      close: (reason = "") => {
        const entry = streams.get(key);
        if (entry === undefined) return;
        streams.delete(key);
        entry.ended = true;
        // The relay passes at most 123 bytes of a close reason to the client.
        if (ws.readyState === WebSocket.OPEN) ws.send(frame(CLOSE, id, Buffer.from(reason, "utf8").subarray(0, 123)), { binary: true });
        // The relay never echoes a close the runtime sent: end this side's reader too.
        entry.sink?.closed(reason || "the runtime closed the stream");
      },
    };
    return stream;
  };

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    heard();
    if (!isBinary || data.length < HEADER) return;
    const type = data[0]!;
    const id = Buffer.from(data.subarray(1, HEADER));
    const key = id.toString("hex");
    const payload = data.subarray(HEADER);
    if (type === OPEN) {
      const info = openInfoOf(payload);
      if (info === undefined) return ws.send(frame(CLOSE, id, "bad open frame"), { binary: true });
      const entry: { sink: StreamSink | undefined; ended: boolean } = { sink: undefined, ended: false };
      streams.set(key, entry);
      entry.sink = options.onOpen(handle(id), info);
      return;
    }
    const entry = streams.get(key);
    if (entry === undefined) return;
    if (type === TEXT) entry.sink?.message(payload.toString("utf8"));
    else if (type === BINARY) entry.sink?.message(new Uint8Array(payload));
    else if (type === CLOSE) {
      streams.delete(key);
      entry.ended = true;
      entry.sink?.closed(payload.toString("utf8") || "the client left");
    }
    // Other types are the relay's own (forward compatible): ignored.
  });

  // A refused upgrade (401 for a token the relay will not take) never opens.
  ws.on("unexpected-response", (_request, response) => {
    const status = response.statusCode ?? 0;
    response.resume();
    ws.terminate();
    endAll("relay connection lost");
    settle(status === 401 ? { kind: "unauthorized" } : { kind: "lost", code: status, reason: `relay answered ${status}` });
  });
  ws.on("error", (error) => options.log(`relay connection error: ${error.message}`));
  ws.on("close", (code, reason) => {
    endAll("relay connection lost");
    settle(endOf(code, reason.toString("utf8")));
  });

  return {
    opened,
    ended,
    sendToken: (token) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame(TOKEN, ZERO_ID, token), { binary: true });
    },
    isOpen: () => ws.readyState === WebSocket.OPEN,
    close: () => {
      const reason = "runtime stopped its Cloud link";
      if (ws.readyState === WebSocket.OPEN) for (const key of streams.keys()) ws.send(frame(CLOSE, Buffer.from(key, "hex"), reason), { binary: true });
      endAll(reason);
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000, reason);
    },
    drop: () => ws.terminate(),
    streamCount: () => streams.size,
  };
}
