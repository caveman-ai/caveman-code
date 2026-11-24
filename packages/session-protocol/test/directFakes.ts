// Test support for the direct path (src/direct.ts): a fake runtime that serves one chat ("s1") over a relay
// WebSocket and over "data channels", and a fake RTCPeerConnection whose channel is a WebSocket to it speaking the
// direct wire (directWire.ts). Used by test/direct.test.ts and apps/web's pool and hub tests.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket as NodeSocket, WebSocketServer, type WebSocket as ServerSocket } from "ws";

import type { RtcChannel, RtcPeer, RtcPeerConstructor } from "../src/direct.ts";
import { DirectReader, directMessages } from "../src/directWire.ts";
import { ErrorCodes, type SessionEvent } from "../src/index.ts";

const at = "2026-10-21T12:00:00.000Z";

export interface Conn {
  readonly ws: ServerSocket;
  readonly path: "relay" | "direct";
  readonly attached: Set<string>;
  /** What this connection set up, as server.ts keeps it per connection: terminals it opened or attached, commands it watches, screencasts. */
  readonly terminals: Set<string>;
  readonly watches: Set<string>;
  readonly screencasts: Set<string>;
  send(frame: string): void;
}

/**
 * A runtime that serves one chat ("s1"), turn.submit with request-id dedupe, direct.offer when `offers`, and the
 * connection-scoped calls (terminals, command watches, screencasts) kept per connection.
 */
export async function fakeRuntime() {
  const journal: SessionEvent[] = [];
  /** The journal's epoch: a rewrite bumps it (CONTRACT §1). */
  let epoch = 1;
  const conns = new Set<Conn>();
  const submitted = new Map<string, unknown>();
  const executions: string[] = [];
  /** Every call the runtime read, with the path it came on. */
  const received: Array<{ readonly path: "relay" | "direct"; readonly method: string }> = [];
  /**
   * Who drives each screen (`browser\0w1`, `computer\0w1`): the connection that took control, as browser.ts and
   * computer.ts keep it, until it hands back or drops. Input and page moves are taken only from it.
   */
  const screens = new Map<string, Conn>();
  const driven: Array<{ method: string; path: "relay" | "direct" }> = [];
  const offers: Array<{ id: string; sdp: string }> = [];
  const state = {
    offers: true as boolean | "unsupported",
    /** Hold turn.submit answers on the relay until released (a slow relay). */
    holdRelaySubmits: false,
    /** The same on direct connections. */
    holdDirectSubmits: false,
    /** Answer nothing on direct connections, pings included (a stranded channel). */
    silentDirect: false,
    /** Turn every relay connection away (Caveman Cloud's relay is down). */
    relayDown: false,
  };
  const held: Array<() => void> = [];
  // On 127.0.0.1, where the clients dial it. Listening on every address, it could be handed a port another process holds
  // on 127.0.0.1 (macOS allows both), and every connection would go to that process instead.
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  wss.on("connection", (ws, req) => {
    const path = req.headers["x-path"] === "direct" ? "direct" : "relay";
    if (path === "relay" && state.relayDown) return ws.terminate();
    const reader = new DirectReader();
    const conn: Conn = {
      ws,
      path,
      attached: new Set(),
      terminals: new Set(),
      watches: new Set(),
      screencasts: new Set(),
      send: (frame) => {
        if (path === "relay") return ws.send(frame);
        for (const message of directMessages(frame, 1024)) ws.send(message, { binary: typeof message !== "string" });
      },
    };
    conns.add(conn);
    ws.on("close", () => {
      conns.delete(conn);
      for (const [screen, holder] of screens) if (holder === conn) screens.delete(screen);
    });
    ws.on("message", (raw, binary) => {
      let text: string;
      if (path === "direct") {
        if (state.silentDirect) return;
        const input = reader.read(binary ? new Uint8Array(raw as Buffer) : String(raw));
        if (input.kind === "ping") return ws.send(input.reply, { binary: true });
        if (input.kind !== "frame") return;
        text = input.text;
      } else text = String(raw);
      const { id, method, params } = JSON.parse(text);
      received.push({ path, method });
      const reply = (body: object) => conn.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
      const fail = (reason: keyof typeof ErrorCodes) => reply({ error: { code: ErrorCodes[reason], message: reason, data: { reason } } });
      if (method === "session.attach") {
        conn.attached.add(params.session_id);
        // Another epoch, or a cursor past the head: a rewritten journal, replayed from the start.
        const reset = (params.epoch !== undefined && params.epoch !== epoch) || params.cursor > journal.length;
        reply({ result: { session: { id: "s1", workspace_id: "w1", engine: "caveman", state: "live", head: journal.length, created_at: at, updated_at: at }, epoch, reset } });
        // From two before the cursor: the client dedupes.
        for (const event of journal.slice(reset ? 0 : Math.max(0, params.cursor - 2))) conn.send(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: event }));
        return;
      }
      if (method === "session.detach") {
        conn.attached.delete(params.session_id);
        return reply({ result: {} });
      }
      if (method === "turn.submit") {
        const answer = () => {
          if (!submitted.has(params.request_id)) {
            executions.push(params.request_id);
            submitted.set(params.request_id, { turn_id: `t-${params.request_id}`, disposition: "started" });
          }
          reply({ result: submitted.get(params.request_id) });
        };
        if (path === "relay" ? state.holdRelaySubmits : state.holdDirectSubmits) return void held.push(answer);
        return answer();
      }
      if (method === "direct.offer") {
        if (state.offers === "unsupported") return fail("unsupported");
        offers.push(params);
        return reply({ result: { sdp: `answer-for-${params.id}` } });
      }
      if (method === "direct.candidate") return reply({ result: {} });
      if (method === "engine.list") return reply({ result: { engines: [], via: path } });
      if (method === "term.open") {
        const terminal_id = `term-${params.request_id}`;
        conn.terminals.add(terminal_id);
        return reply({ result: { terminal_id } });
      }
      if (method === "term.attach") {
        conn.terminals.add(params.terminal_id);
        return reply({ result: { scrollback: "", cols: 80, rows: 24, exited: false } });
      }
      const screen = /^(browser|computer)\.(control|input|navigate|history)$/.exec(method);
      if (screen) {
        const key = `${screen[1]}\0${params.workspace_id}`;
        const holder = screens.get(key);
        if (screen[2] === "input") {
          // browser.ts refuses input from a connection whose viewer does not control; computer.ts names who does.
          if (holder !== conn) return fail(holder && screen[1] === "computer" ? "user_in_control" : "invalid_state");
        } else if (screen[2] === "control" && params.controller === "agent") {
          if (holder === conn) screens.delete(key);
          return reply({ result: { controller: screens.has(key) ? "user" : "agent" } });
        } else {
          // Taking control, or moving the page (which takes it): refused while another connection drives.
          if (holder !== undefined && holder !== conn) return fail("user_in_control");
          screens.set(key, conn);
        }
        driven.push({ method, path });
        return reply({ result: screen[2] === "control" ? { controller: "user" } : {} });
      }
      if (method === "term.detach") conn.terminals.delete(params.terminal_id);
      if (method === "tool.watch") conn.watches.add(`${params.workspace_id}\0${params.item_id}`);
      if (method === "tool.unwatch") conn.watches.delete(`${params.workspace_id}\0${params.item_id}`);
      if (method === "browser.screencast") conn.screencasts[params.enabled ? "add" : "delete"](params.workspace_id);
      return reply({ result: {} });
    });
  });
  return {
    url,
    state,
    offers,
    executions,
    received,
    /** Every screen call the runtime took (control, input, page moves), with the path it came on. */
    driven,
    /** The path of the connection driving a screen (`browser\0w1`), if any. */
    driving: (screen: string) => screens.get(screen)?.path,
    conns,
    journal,
    release: () => {
      for (const answer of held.splice(0)) answer();
    },
    /** Appends one event to s1 and pushes it to every attached connection. */
    append: () => {
      const event: SessionEvent = { session_id: "s1", cursor: journal.length + 1, at, type: "message.delta", payload: { text: String(journal.length + 1) } } as SessionEvent;
      journal.push(event);
      for (const conn of conns) if (conn.attached.has("s1")) conn.send(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: event }));
    },
    /** The journal is rewritten (a move, a lost tail): a new epoch with `events` events; every attachment ends. */
    rewrite: (events: number) => {
      epoch++;
      journal.length = 0;
      for (let i = 1; i <= events; i++) journal.push({ session_id: "s1", cursor: i, at, type: "message.delta", payload: { text: `e${epoch}.${i}` } } as SessionEvent);
      const ended = { session_id: "s1", error: { code: ErrorCodes.journal_reset, message: "rewritten", data: { reason: "journal_reset" } } };
      for (const conn of conns) {
        if (!conn.attached.delete("s1")) continue;
        conn.send(JSON.stringify({ jsonrpc: "2.0", method: "session.ended", params: ended }));
      }
    },
    epoch: () => epoch,
    broadcast: (method: string, params: unknown) => {
      for (const conn of conns) conn.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    /**
     * A terminal prints: to every connection that opened or attached it and every one attached to its workspace's chat,
     * as server.ts's terminalTargets sends it (every terminal here is w1's, whose chat is s1).
     */
    termOutput: (terminal_id: string, data: string) => {
      for (const conn of conns) {
        if (!conn.terminals.has(terminal_id) && !conn.attached.has("s1")) continue;
        conn.send(JSON.stringify({ jsonrpc: "2.0", method: "term.output", params: { terminal_id, data } }));
      }
    },
    /** A running command prints: to every connection watching it. */
    toolLive: (workspace_id: string, item_id: string, text: string) => {
      for (const conn of conns) {
        if (!conn.watches.has(`${workspace_id}\0${item_id}`)) continue;
        conn.send(JSON.stringify({ jsonrpc: "2.0", method: "tool.live", params: { workspace_id, item_id, kind: "append", text, truncated: false, running: true } }));
      }
    },
    /** Which paths hold what `has` names (a terminal, a watch, a screencast), one entry per connection. */
    holding: (has: (conn: Conn) => boolean) => [...conns].filter(has).map((c) => c.path).sort(),
    direct: () => [...conns].find((c) => c.path === "direct"),
    /** Drops every relay connection (with relayDown, none comes back). */
    dropRelay: () => {
      for (const conn of conns) if (conn.path === "relay") conn.ws.terminate();
    },
    relay: () => [...conns].find((c) => c.path === "relay"),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

/** An RTCPeerConnection whose data channel is a WebSocket to the fake runtime, opened once the answer is applied. */
export function fakeRtc(url: string) {
  const peers: FakePeer[] = [];
  class FakeChannel implements RtcChannel {
    readyState = "connecting";
    binaryType = "blob";
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onmessage: ((event: { readonly data: unknown }) => void) | null = null;
    ws: NodeSocket | null = null;
    open() {
      const ws = new NodeSocket(url, { headers: { "x-path": "direct", authorization: "Bearer none" } });
      this.ws = ws;
      ws.on("open", () => {
        this.readyState = "open";
        this.onopen?.();
      });
      ws.on("message", (data, binary) => {
        const buf = data as Buffer;
        this.onmessage?.({ data: binary ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : String(data) });
      });
      ws.on("close", () => {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        this.onclose?.();
      });
      ws.on("error", () => undefined);
    }
    send(data: string | Uint8Array) {
      this.ws?.send(data, { binary: typeof data !== "string" });
    }
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.ws?.terminate();
    }
    /** The network under it goes (the test's kill switch). */
    kill() {
      this.ws?.terminate();
    }
  }
  class FakePeer implements RtcPeer {
    channel: FakeChannel | null = null;
    localDescription: { sdp: string } | null = null;
    connectionState = "new";
    sctp = { maxMessageSize: 1024 };
    remote: string | null = null;
    candidates: string[] = [];
    onicecandidate: RtcPeer["onicecandidate"] = null;
    onconnectionstatechange: (() => void) | null = null;
    readonly config: { iceServers: Array<{ urls: string | Array<string> }> };
    constructor(config: { iceServers: Array<{ urls: string | Array<string> }> }) {
      this.config = config;
      peers.push(this);
    }
    createDataChannel() {
      this.channel = new FakeChannel();
      return this.channel;
    }
    async createOffer() {
      return { sdp: "v=0 fake-offer", type: "offer" };
    }
    async setLocalDescription(description: { sdp?: string }) {
      this.localDescription = { sdp: description.sdp ?? "" };
      setTimeout(() => this.onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host", sdpMid: "0" } }), 1);
    }
    async setRemoteDescription(description: { sdp: string }) {
      this.remote = description.sdp;
      this.connectionState = "connected";
      this.channel?.open();
    }
    async addIceCandidate(candidate: { candidate: string }) {
      this.candidates.push(candidate.candidate);
    }
    close() {
      this.connectionState = "closed";
      this.channel?.close();
    }
  }
  return { Rtc: FakePeer as unknown as RtcPeerConstructor, peers };
}
