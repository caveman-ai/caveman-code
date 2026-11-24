// Test-only: the chaos harness's world (DESIGN S11). Three real runtime processes (This Mac and two Cloud computers,
// chaos.runtime.ts) on the stand-in claude, the test Cloud (testCloud.ts) with its relay, and four devices, each running
// the web app's own sync state (apps/web/src/state/sync: Cloud's list, the runtime pool, chat feeds, the transcript
// cache and the sender, through SyncHub) in this process. Devices reach runtimes the way they do in the product: the
// desktop reaches This Mac on loopback, everything else goes through the relay (here a stand-in for its client side
// that routes by runtime id to the runtime's relay link), and the phone also opens WebRTC's direct path to the Mac.
// Every socket in between can be cut, every runtime can be killed with SIGKILL, stopped (asleep) and restarted on its
// own state dir. Observers (loopback subscriptions on every runtime, never cut) record what each journal committed,
// so invariants can tell a lost event from a replaced one.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  connect,
  deviceHandshake,
  queuedCallFields,
  signMove,
  type ChatSummary,
  type Client,
  type ConnectionState,
  type ConnectOptions,
  type DeviceKey,
  type Outbox,
  type RuntimeState,
  type SessionEvent,
  type SocketFactory,
  type TokenSource,
} from "@caveman-app/session-protocol";
import { connectDirect, type RtcPeerConstructor } from "@caveman-app/session-protocol/direct";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { WebSocketServer, type WebSocket } from "ws";

import { testDevice } from "../../session-protocol/devices.testkit.ts";
import { git, tempRoot, until } from "../../session-protocol/testHarness.ts";
import { readIdentity } from "../identity.ts";
import { linkDirOf } from "../index.ts";
import { decodeBundle, mergeBundles } from "../moves.ts";
import { startTestCloud, type RelaySide, type TestCloud } from "../testCloud.ts";
import { TOOLS_EXEC } from "../tools.ts";

const RUNTIME = fileURLToPath(new URL("./chaos.runtime.ts", import.meta.url));
/** The web app's sync state, loaded at run time: it is browser code outside this package's typecheck (DOM lib). */
const WEB_SYNC = new URL("../../../../../apps/web/src/state/sync/", import.meta.url);
export const PERSON = "user-1";
export const REPO = "acme/chaos";

// ------------------------------------------------------------------------------------------------ seeds and the log

/** mulberry32: a small seeded generator, so a seed replays the same choices. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: ReadonlyArray<T>): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof rng>;

/** What happened, in order, with times from the start: printed (the tail) with the seed when a run fails. */
export class Trace {
  readonly lines: Array<string> = [];
  private readonly start = Date.now();
  note(what: string): void {
    this.lines.push(`${((Date.now() - this.start) / 1000).toFixed(2).padStart(7)}s ${what}`);
  }
  tail(n = 60): string {
    return this.lines.slice(-n).join("\n");
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An event as every source must carry it: the fields a device shows, in a stable order. */
export function eventKey(event: SessionEvent | Record<string, unknown>): string {
  const e = event as Record<string, unknown>;
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]))
        : value;
  return createHash("sha256")
    .update(JSON.stringify(stable({ cursor: e.cursor, type: e.type, at: e.at, turn_id: e.turn_id, item_id: e.item_id, parent_item_id: e.parent_item_id, payload: e.payload })))
    .digest("hex")
    .slice(0, 16);
}

// ------------------------------------------------------------------------------------------------ sockets we can cut

/** A TCP hop in front of a runtime's loopback port: a stable port across restarts, and every connection cuttable. */
export async function tcpPipe() {
  let target: number | undefined;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((inbound) => {
    if (target === undefined) return inbound.destroy();
    const outbound = net.connect(target, "127.0.0.1");
    sockets.add(inbound);
    sockets.add(outbound);
    inbound.pipe(outbound);
    outbound.pipe(inbound);
    const end = () => {
      inbound.destroy();
      outbound.destroy();
      sockets.delete(inbound);
      sockets.delete(outbound);
    };
    for (const s of [inbound, outbound]) {
      s.on("error", end);
      s.on("close", end);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/session/v1`,
    setTarget: (next: number | undefined) => void (target = next),
    /** Cuts every connection through it now (the client sees its socket die). */
    drop: () => {
      for (const s of sockets) s.destroy();
    },
    close: () => new Promise<void>((resolve) => (server.close(() => resolve()), [...sockets].forEach((s) => s.destroy()))),
  };
}
export type Pipe = Awaited<ReturnType<typeof tcpPipe>>;

/** A frame a device's page sent toward a runtime, as the relay got it (forwarded) or did not (lost on its way). */
export interface RelayFrame {
  readonly device: string;
  readonly page: number;
  readonly runtimeId: string;
  /** The frame's first 200 characters: plain JSON-RPC to a Cloud computer, sealed (device_frame) to a Mac after its handshake. */
  readonly head: string;
  readonly lost: boolean;
  readonly at: number;
}

/**
 * The relay's client side: a device's WebSocket to `/r/<runtimeId>/<device>/<page>` becomes one stream on that runtime's
 * live relay link (as Cloud's relay does), frames pass both ways; with no link up the socket closes 4404 (the runtime is
 * not connected), and a link that drops closes its streams the same way. Every hop is timed for the latency budgets.
 */
export async function relayFront(cloud: TestCloud, trace: Trace) {
  interface Stream {
    readonly socket: WebSocket;
    readonly side: RelaySide;
    readonly id: Buffer;
    readonly runtimeId: string;
    readonly device: string;
    readonly page: number;
  }
  const streams = new Set<Stream>();
  /** Pages whose frames are lost on their way from now on (lose), to one runtime or to any. */
  const losing: Array<{ readonly device: string; readonly page: number; readonly runtimeId?: string }> = [];
  /** The newest frames devices sent toward runtimes, forwarded or lost. */
  const frames: Array<RelayFrame> = [];
  const hooked = new WeakSet<RelaySide>();
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => (protocols.has("caveman.session.v1") ? "caveman.session.v1" : false),
    // A runtime Cloud revoked (a Cloud computer's identity from before its last stop, CONTRACT §5.3) is refused before
    // the socket opens, as Cloud's relay refuses it: a client reads that as 1006, and cannot read why.
    verifyClient: (info, done) => {
      const runtimeId = (info.req.url ?? "").split("/")[2] ?? "";
      if (cloud.state.runtimes.get(runtimeId)?.status !== "revoked") return done(true);
      refused.push(runtimeId);
      done(false, 404, "Not Found");
    },
  });
  /** Every attempt the relay refused before it opened, by the revoked runtime id it was for. */
  const refused: Array<string> = [];
  const sideOf = (runtimeId: string) =>
    [...cloud.state.relays].reverse().find((side) => side.ws.readyState === side.ws.OPEN && cloud.state.tokens.get(side.token)?.runtimeId === runtimeId);
  const hook = (side: RelaySide) => {
    if (hooked.has(side)) return;
    hooked.add(side);
    side.ws.on("message", (data: Buffer) => {
      const type = data[0];
      const id = data.subarray(1, 17);
      for (const s of streams) {
        if (s.side !== side || !s.id.equals(id)) continue;
        if (type === 2) s.socket.send(data.subarray(17).toString("utf8"));
        else if (type === 4) {
          streams.delete(s);
          s.socket.close(1000, data.subarray(17).toString("utf8"));
        }
      }
    });
    side.ws.on("close", () => {
      for (const s of streams) {
        if (s.side !== side) continue;
        streams.delete(s);
        s.socket.close(4404, "the runtime is not connected");
      }
    });
  };
  wss.on("connection", (socket, request) => {
    const [, , runtimeId = "", device = "", page = "0"] = (request.url ?? "").split("/");
    const side = sideOf(runtimeId);
    if (!side) return socket.close(4404, "the runtime is not connected");
    hook(side);
    const id = side.open({ user_id: PERSON });
    const stream: Stream = { socket, side, id, runtimeId, device, page: Number(page) };
    streams.add(stream);
    socket.on("message", (data) => {
      if (!streams.has(stream)) return;
      const frame = data.toString();
      const lost = losing.some((l) => l.device === device && l.page === stream.page && (l.runtimeId === undefined || l.runtimeId === runtimeId));
      frames.push({ device, page: stream.page, runtimeId, head: frame.slice(0, 200), lost, at: Date.now() });
      if (frames.length > 500) frames.shift();
      if (lost) {
        trace.note(`relay: a frame of ${device}'s page ${stream.page} to ${runtimeId.slice(0, 6)} lost on its way: ${frame.slice(0, 100)}`);
        return;
      }
      try {
        side.send(id, frame);
      } catch {
        socket.close(4404, "the runtime is not connected");
      }
    });
    socket.on("close", () => {
      if (!streams.delete(stream)) return;
      try {
        side.close(id, "the client left");
      } catch {
        // The link is gone already.
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    /** Where `device`'s page `page` (0 its first, one more per reload) reaches `runtimeId`. */
    url: (runtimeId: string, device: string, page = 0) => `ws://127.0.0.1:${port}/r/${runtimeId}/${device}/${page}`,
    /**
     * From now on the frames `device`'s page `page` sends (to `runtimeId`, or to any runtime) are lost on their way, as
     * when a page reloads with frames still in its sockets: the relay never forwards them. Its streams stay open, and
     * another page's frames pass.
     */
    lose: (device: string, page: number, runtimeId?: string) => {
      losing.push({ device, page, ...(runtimeId !== undefined ? { runtimeId } : {}) });
      trace.note(`fault: frames of ${device}'s page ${page}${runtimeId ? ` to ${runtimeId.slice(0, 6)}` : ""} are lost on their way from now on`);
    },
    /** The newest frames (up to 500) devices sent toward runtimes, forwarded or lost, oldest first. */
    frames: (): ReadonlyArray<RelayFrame> => frames,
    /** Cuts a device's relayed sockets (all, or to one runtime). */
    dropDevice: (device: string, runtimeId?: string) => {
      for (const s of [...streams]) if (s.device === device && (runtimeId === undefined || s.runtimeId === runtimeId)) s.socket.terminate();
      trace.note(`fault: relay sockets of ${device}${runtimeId ? ` to ${runtimeId.slice(0, 6)}` : ""} cut`);
    },
    /** Cuts a runtime's own relay link (Cloud side): it reconnects; its devices' streams close 4404. */
    dropRuntime: (runtimeId: string) => {
      for (const side of cloud.state.relays) if (side.ws.readyState === side.ws.OPEN && cloud.state.tokens.get(side.token)?.runtimeId === runtimeId) side.ws.terminate();
    },
    streams: () => [...streams].map((s) => ({ runtimeId: s.runtimeId, device: s.device, page: s.page })),
    /** The attempts refused before they opened (a revoked runtime id), oldest first. */
    refused: (): ReadonlyArray<string> => refused,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
export type RelayFront = Awaited<ReturnType<typeof relayFront>>;

// ------------------------------------------------------------------------------------------------ runtimes

export interface RuntimeInfo {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly pid: number;
}

/** One runtime process on its own state dir: started, killed, stopped (asleep) and woken by the harness only. */
export class RuntimeProc {
  child: ChildProcess | undefined;
  info: RuntimeInfo | undefined;
  /** The harness's own loopback client (observers, the person at the Mac): through a pipe the faults never cut. */
  admin: Client | undefined;
  runtimeId = "";
  computerId = "";
  asleep = false;
  /** Spawned and not yet serving. */
  starting = false;
  starts = 0;
  /** When this runtime was last down, asleep or starting: views may wait on it until then. */
  downAt = 0;
  private readonly out: string;
  readonly name: string;
  readonly role: "mac" | "cloud";
  readonly base: string;
  private readonly env: Record<string, string>;
  /** The desktop's loopback to This Mac (cut by faults) and the harness's own (never cut). */
  readonly desktopPipe: Pipe;
  readonly adminPipe: Pipe;
  private readonly trace: Trace;

  constructor(name: string, role: "mac" | "cloud", base: string, env: Record<string, string>, desktopPipe: Pipe, adminPipe: Pipe, trace: Trace) {
    this.name = name;
    this.role = role;
    this.base = base;
    this.env = env;
    this.desktopPipe = desktopPipe;
    this.adminPipe = adminPipe;
    this.trace = trace;
    this.out = path.join(base, "out.json");
  }

  get logFile(): string {
    return path.join(this.base, "runtime.log");
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.base, { recursive: true });
    fs.rmSync(this.out, { force: true });
    this.starting = true;
    const log = fs.openSync(this.logFile, "a");
    fs.writeSync(log, `\n---- start ${++this.starts} ${new Date().toISOString()}\n`);
    const child = spawn(process.execPath, ["--no-warnings", RUNTIME], {
      env: { ...process.env, ...this.env, CHAOS_BASE: this.base, CHAOS_OUT: this.out, CHAOS_ROLE: this.role, CHAOS_NAME: this.name, CHAOS_PARENT: String(process.pid), CLAUDE_CONFIG_DIR: path.join(this.base, "claude") },
      stdio: ["ignore", log, log],
    });
    fs.closeSync(log);
    this.child = child;
    await until(() => fs.existsSync(this.out) || child.exitCode !== null || child.signalCode !== null, 240_000);
    if (!fs.existsSync(this.out)) throw new Error(`the ${this.name} runtime exited: ${fs.readFileSync(this.logFile, "utf8").slice(-3000)}`);
    this.info = JSON.parse(fs.readFileSync(this.out, "utf8")) as RuntimeInfo;
    const identity = readIdentity(this.role === "mac" ? linkDirOf(this.info.stateDir) : this.env.CAVEMAN_CLOUD_LINK_DIR!);
    if (identity) {
      this.runtimeId = identity.runtimeId;
      this.computerId = identity.computerId;
    }
    this.desktopPipe.setTarget(this.info.port);
    this.adminPipe.setTarget(this.info.port);
    this.admin = connect(this.adminPipe.url, this.info.token);
    this.asleep = false;
    this.starting = false;
    this.downAt = Date.now();
    this.trace.note(`${this.name}: started (pid ${this.info.pid})`);
  }

  /** kill -9, mid-whatever: nothing flushes. */
  async kill(): Promise<void> {
    await this.end("SIGKILL");
  }

  /** A clean stop, as `systemctl stop` makes one (SIGTERM, 30 s to end by itself, then kill -9). Answers whether it ended by itself. */
  async term(): Promise<boolean> {
    return this.end("SIGTERM");
  }

  private async end(signal: "SIGKILL" | "SIGTERM"): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGCONT");
    child.kill(signal);
    const late = signal === "SIGTERM" ? setTimeout(() => child.kill("SIGKILL"), 30_000) : undefined;
    await exited;
    clearTimeout(late);
    const clean = signal === "SIGTERM" && child.signalCode === null;
    this.desktopPipe.setTarget(undefined);
    this.adminPipe.setTarget(undefined);
    this.desktopPipe.drop();
    this.adminPipe.drop();
    this.admin?.close();
    this.admin = undefined;
    this.trace.note(`${this.name}: ${clean ? "stopped (SIGTERM)" : "killed -9"}`);
    return clean;
  }

  /** The machine sleeps: the process stops where it stands. */
  stop(): void {
    this.child?.kill("SIGSTOP");
    this.asleep = true;
    this.trace.note(`${this.name}: asleep (SIGSTOP)`);
  }

  wake(): void {
    this.child?.kill("SIGCONT");
    this.asleep = false;
    this.downAt = Date.now();
    this.trace.note(`${this.name}: awake (SIGCONT)`);
  }

  /** A Cloud computer's checkout (CAVEMAN_WORKSPACE_ROOT). */
  get checkout(): string | undefined {
    return this.env.CAVEMAN_WORKSPACE_ROOT;
  }

  /** What a Cloud computer's volume holds: the runtime's state and the checkout. Its link identity is Cloud's, written again at every boot. */
  private volume(): Array<string> {
    return [this.base, ...(this.checkout === undefined ? [] : [this.checkout])];
  }

  /** The volume as it is now, copied aside (the runtime down): what a snapshot of it holds. */
  snapshotDisk(): string {
    const to = fs.mkdtempSync(`${this.base}-snapshot-`);
    this.volume().forEach((dir, i) => fs.cpSync(dir, path.join(to, String(i)), { recursive: true }));
    return to;
  }

  /**
   * The computer comes back on another volume (the runtime down): an earlier snapshot of this one (snapshotDisk), or an
   * empty one. What it held is moved aside, never read again.
   */
  replaceDisk(snapshot?: string): void {
    const lost = fs.mkdtempSync(`${this.base}-lost-`);
    this.volume().forEach((dir, i) => {
      fs.renameSync(dir, path.join(lost, String(i)));
      if (snapshot === undefined) fs.mkdirSync(dir, { recursive: true });
      else fs.cpSync(path.join(snapshot, String(i)), dir, { recursive: true });
    });
    this.trace.note(`${this.name}: its disk is ${snapshot === undefined ? "an empty one" : "an earlier snapshot of it"} now`);
  }

  /** Up and serving: not killed, not asleep, not starting. */
  up(): boolean {
    return this.alive() && !this.asleep && !this.starting;
  }

  alive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  async close(): Promise<void> {
    if (this.alive()) await this.kill();
  }

  /** The harness's call on this runtime, as the person at the Mac or an operator (loopback, local principal). */
  call: Client["call"] = (method, params, options) => {
    if (!this.admin) return Promise.reject(new Error(`${this.name} is not running`));
    return this.admin.call(method, params, options);
  };
}

// ------------------------------------------------------------------------------------------------ devices

/** The parts of the web app's SyncHub the harness drives (apps/web/src/state/sync/hub.ts). */
export interface Hub {
  list: { get(): { status: string; chats: ReadonlyMap<string, ChatSummary>; runtimes: ReadonlyMap<string, RuntimeState>; seq: number; ready: boolean }; subscribe(listener: () => void): () => void } | null;
  store(): Kv;
  resendable(runtimeId: string | null): NonNullable<ConnectOptions["resend"]>;
  pool: { link(runtimeId: string): string | undefined; isDirect(runtimeId: string): boolean; openRuntimes(): Array<string> };
  sender: unknown;
  start(): void;
  stop(): void;
  summary(sessionId: string): ChatSummary | undefined;
  homeRuntimeId(): string | null;
  throughHub(sessionId: string): boolean;
  reachable(runtimeId: string): boolean;
  viaFor(sessionId: string): string;
  clientFor(sessionId: string): Client;
  openFeed(sessionId: string, sink: FeedSink, onState: (state: FeedState) => void): Feed;
  close(sessionId: string): void;
  queuedCalls(sessionId: string): ReadonlyArray<{ call: { request_id: string; status: string } }>;
}
export interface FeedSink {
  reset(epoch: number): void;
  apply(event: SessionEvent): void;
  painted?(): void;
}
export type FeedState = { readonly kind: "loading" | "live" | "reconnecting" } | { readonly kind: "copy"; readonly through: number } | { readonly kind: "ended"; readonly reason: string; readonly message: string };
export interface Feed {
  position(): { readonly epoch: number | undefined; readonly cursor: number };
  current(): FeedState;
}
interface Kv {
  readonly data?: Map<string, unknown>;
  scan<T>(prefix: string): Promise<Array<[string, T]>>;
}
interface WebSync {
  SyncHub: new (options: Record<string, unknown>) => Hub;
  /** sender.ts UNSENT_MS: how long a call handed to a runtime may wait for its socket before it goes to Cloud's queue. */
  UNSENT_MS: number;
  cloudApi: (auth: Record<string, unknown>) => unknown;
  memoryKv: () => Kv;
  /** web outbox.ts runtimeOutbox: a Cloud computer's calls wait under its computer, a Mac's under its runtime. */
  runtimeOutbox: (kv: Kv, runtimeId: string | null, computerId: string | undefined, pages: Pages) => Outbox;
  registerDeviceHooks: (hooks: {
    callFields?: (call: QueuedCall) => Promise<Readonly<Record<string, unknown>>>;
    moveFields?: (move: { readonly session_id: string; readonly request_id: string; readonly to: "cloud" | { readonly computer_id: string } }) => Promise<Readonly<Record<string, unknown>>>;
  }) => void;
}
/** web pages.ts Pages: this page among the device's open ones. */
interface Pages {
  readonly id: string;
  readonly ready: Promise<void>;
  owns(): boolean;
  alive(id: string): Promise<boolean>;
  watch(id: string): void;
  onGone(listener: (id: string) => void): () => void;
  exclusive<T>(name: string, take: () => Promise<T>): Promise<T>;
}
interface QueuedCall {
  readonly session_id: string;
  readonly request_id: string;
  readonly method: string;
  readonly params: unknown;
}

let webSync: Promise<WebSync> | undefined;
export const loadWebSync = () =>
  (webSync ??= Promise.all(["hub.ts", "cloud-api.ts", "kv.ts", "outbox.ts", "device-hooks.ts", "sender.ts"].map((f) => import(/* @vite-ignore */ new URL(f, WEB_SYNC).href))).then(
    ([hub, api, kv, outbox, hooks, sender]) =>
      ({ SyncHub: hub.SyncHub, UNSENT_MS: sender.UNSENT_MS, cloudApi: api.cloudApi, memoryKv: kv.memoryKv, runtimeOutbox: outbox.runtimeOutbox, registerDeviceHooks: hooks.registerDeviceHooks }) as WebSync,
  ));

/** One chat open on a device: what the person sees, in order, and every state the view went through. */
export class View {
  /** The transcript shown now (cursor 1..n of `epoch`). */
  events: Array<SessionEvent> = [];
  /** Each run of events between resets, with the epoch they belong to (known once the feed says it). */
  readonly segments: Array<{ epoch: number | undefined; shown: Map<number, string> }> = [{ epoch: undefined, shown: new Map() }];
  resets = 0;
  state: FeedState = { kind: "loading" };
  stateSince = Date.now();
  readonly states: Array<string> = [];
  /** Shown out of order or twice: the feed must never do this. */
  readonly misorders: Array<string> = [];
  firstShownAt: number | undefined;
  feed: Feed | undefined;
  /** When each cursor reached the view (latency). */
  readonly arrivals = new Map<number, number>();

  readonly device: string;
  readonly sessionId: string;

  constructor(device: string, sessionId: string) {
    this.device = device;
    this.sessionId = sessionId;
  }

  sink(): FeedSink {
    return {
      reset: (epoch) => {
        this.events = [];
        this.resets++;
        this.arrivals.clear();
        this.segments.push({ epoch, shown: new Map() });
      },
      apply: (event) => {
        if (event.cursor !== this.events.length + 1) this.misorders.push(`cursor ${event.cursor} after ${this.events.length}`);
        this.events.push(event);
        this.firstShownAt ??= Date.now();
        this.arrivals.set(event.cursor, Date.now());
        const segment = this.segments.at(-1)!;
        segment.epoch ??= this.feed?.position().epoch;
        segment.shown.set(event.cursor, eventKey(event));
      },
    };
  }

  onState = (state: FeedState) => {
    this.state = state;
    this.stateSince = Date.now();
    this.states.push(state.kind === "ended" ? `ended:${state.reason}` : state.kind);
    const segment = this.segments.at(-1)!;
    segment.epoch ??= this.feed?.position().epoch;
  };

  epoch(): number | undefined {
    return this.feed?.position().epoch ?? this.segments.at(-1)?.epoch;
  }
}

export interface DeviceSpec {
  readonly name: string;
  readonly kind: "desktop" | "web" | "phone";
  /** The window's own runtime: This Mac on loopback (the desktop), a picked computer through the relay, or none. */
  readonly home: "mac" | "box-a" | null;
  /** The phone also opens the direct path (WebRTC) to This Mac. */
  readonly direct?: boolean;
}

/**
 * One page of a window, from its load until the window reloads. A dead page runs no code in a browser; here its objects
 * live on in this process, so everything it would still reach the world through refuses it: its Cloud requests never
 * leave, no socket or peer connection of its opens, and no frame leaves on those it had. Frames it sent before it died
 * may still arrive.
 */
interface Page {
  /** 0 for the window's first page, one more per reload. */
  readonly n: number;
  alive: boolean;
  /** What the dead page tried and was refused, noted in the trace once each. */
  readonly refused: Set<string>;
}

/** One device: the web app's real sync state for one window, its key-value store (IndexedDB) and its device key. */
export class Device {
  hub: Hub | undefined;
  homeClient: Client | null = null;
  readonly views = new Map<string, View>();
  /** The device's store (IndexedDB): a reload's new page gets it as the old page last wrote it. */
  kv: Kv;
  /** The page now open. */
  private current: Page = { n: 0, alive: true, refused: new Set() };
  /** Every runtime connection this device made, by URL, and the paths they took (relay, direct). */
  readonly paths: Array<string> = [];
  reloads = 0;
  /**
   * When this device's link to each runtime (by name) last opened, closed or failed to open (a socket, or a direct
   * channel): a call to that runtime may wait for its link until a while after then.
   */
  readonly linkChangedAt = new Map<string, number>();

  readonly spec: DeviceSpec;
  readonly key: DeviceKey;
  private readonly world: World;
  private readonly sync: WebSync;

  constructor(spec: DeviceSpec, key: DeviceKey, world: World, sync: WebSync) {
    this.spec = spec;
    this.key = key;
    this.world = world;
    this.sync = sync;
    this.kv = sync.memoryKv();
  }

  get name(): string {
    return this.spec.name;
  }

  /** The page now open: 0 the first, one more per reload (the relay knows each page's streams by it). */
  get page(): number {
    return this.current.n;
  }

  private homeRuntime(): RuntimeProc | undefined {
    return this.spec.home === "mac" ? this.world.mac : this.spec.home === "box-a" ? this.world.boxA : undefined;
  }

  /** A dead page tried to reach the world: refused, and said once in the trace. */
  private refuse(page: Page, what: string): void {
    if (page.refused.has(what)) return;
    page.refused.add(what);
    this.world.trace.note(`${this.name}'s page ${page.n} is gone: ${what} refused`);
  }

  /**
   * The page's sockets, opened as client.ts opens them in Node (the token in a header). Once the page is dead none
   * opens (the attempt never connects), and those it had send nothing more.
   */
  private sockets(page: Page): SocketFactory {
    return (url, bearer) => {
      const to = this.world.runtimes.find((r) => url.includes(`/r/${r.runtimeId}/`) || url === r.desktopPipe.url)?.name ?? url;
      if (!page.alive) {
        this.refuse(page, `a connection to ${to}`);
        const never = { readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null, send: () => undefined, close: () => void (never.readyState = 3) };
        return never as unknown as ReturnType<SocketFactory>;
      }
      const ws = new (globalThis.WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => ReturnType<SocketFactory>)(url, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      for (const change of ["open", "close", "error"]) ws.addEventListener(change, () => void this.linkChangedAt.set(to, Date.now()));
      const send = ws.send.bind(ws);
      ws.send = (data) => (page.alive ? send(data) : this.refuse(page, `a frame to ${to}`));
      return ws;
    };
  }

  /** How this device opens a runtime connection: its own handshake (its key) on every socket, the direct path to the Mac. */
  private connector(page: Page): (url: string, token: TokenSource, onState?: (state: ConnectionState, error?: Error) => void, options?: ConnectOptions) => Client {
    const socket = this.sockets(page);
    return (url, token, onState, options = {}) => {
      const runtimeId = /\/r\/([^/]+)\//.exec(url)?.[1];
      const runtime = this.world.runtimes.find((r) => r.runtimeId === runtimeId);
      const kind = runtime?.role === "mac" ? "laptop" : runtime ? "cloud" : undefined;
      const handshake = deviceHandshake({
        device: this.key,
        kind: () => kind,
        onStatus: (status) => {
          // The person at the Mac allows each of their devices once, on the Mac's own screen.
          if (status.status === "pending") void this.world.mac.call("device.allow", { request_id: `allow-${this.key.device_id}-${Date.now()}`, device_id: this.key.device_id }).catch(() => undefined);
        },
      });
      const merged: ConnectOptions = { ...options, handshake, socket };
      this.paths.push(`${runtime?.name ?? "?"}:${this.spec.direct && kind === "laptop" ? "direct+relay" : "relay"}`);
      if (this.spec.direct && kind === "laptop") {
        return connectDirect(url, token, onState, {
          ...merged,
          direct: { rtc: this.rtc(page, runtime!.name), iceServers: [], retryMs: () => 500, network: () => () => undefined, openTimeoutMs: 5_000 },
        });
      }
      return connect(url, token, onState, merged);
    };
  }

  /**
   * The platform's WebRTC (node-datachannel's), keeping each peer so a fault can cut the direct path. A dead page opens
   * no peer (as a platform without WebRTC: the relay alone), and its channels send nothing more.
   */
  readonly peers: Array<RTCPeerConnection> = [];
  private rtc(page: Page, to: string): RtcPeerConstructor {
    const peers = this.peers;
    const refuse = (what: string) => this.refuse(page, what);
    const changed = () => void this.linkChangedAt.set(to, Date.now());
    class Rtc extends RTCPeerConnection {
      constructor(config: ConstructorParameters<typeof RTCPeerConnection>[0]) {
        if (!page.alive) {
          refuse("a direct connection");
          throw new Error("the page is gone");
        }
        super(config);
        peers.push(this);
      }
      override createDataChannel(...args: Parameters<RTCPeerConnection["createDataChannel"]>): ReturnType<RTCPeerConnection["createDataChannel"]> {
        const channel = super.createDataChannel(...args);
        channel.addEventListener("open", changed);
        channel.addEventListener("close", changed);
        const send = channel.send.bind(channel);
        channel.send = (data) => (page.alive ? send(data) : refuse("a direct frame"));
        return channel;
      }
    }
    return Rtc as unknown as RtcPeerConstructor;
  }

  /** Cuts this device's direct channels (the Wi-Fi changed): it goes on over the relay, then upgrades again. */
  dropDirect(): number {
    // Direct channels go to laptops: This Mac.
    this.linkChangedAt.set(this.world.mac.name, Date.now());
    const open = this.peers.splice(0);
    for (const peer of open) peer.close();
    return open.length;
  }

  /** The window opens (or reloads): a new SyncHub on the same store, its open chats opened again. */
  async open(): Promise<void> {
    const world = this.world;
    const home = this.homeRuntime();
    const page: Page = (this.current = { n: this.reloads, alive: true, refused: new Set() });
    // A request the page makes after it died never leaves it.
    const headers = async () => (page.alive ? { authorization: `Bearer ${world.cloud.state.personToken}` } : new Promise<never>(() => undefined));
    const api = this.sync.cloudApi({ base: world.cloud.url, headers, renew: async () => false, credentials: "omit" });
    const relayUrl = (runtimeId: string) => world.relay.url(runtimeId, this.name, page.n);
    // The page's own link to its runtime: after a reload the device's homeClient is the next page's.
    let homeClient: Client | null = null;
    this.homeClient = null;
    // One page is open at a time here: the one before a reload is gone, and the next takes over what it left.
    const id = `${this.name}-page-${page.n}`;
    // A page is gone when the next one opens: what it left goes from that one's load.
    const pages: Pages = { id, ready: Promise.resolve(), owns: () => true, alive: async (other) => other === `${this.name}-page-${this.current.n}` && this.current.alive, watch: () => undefined, onGone: () => () => undefined, exclusive: (_name, take) => take() };
    this.hub = new this.sync.SyncHub({
      api,
      person: `${world.cloud.state.organizationId}:${PERSON}`,
      kv: this.kv,
      pages,
      // Any runtime Cloud ever knew has an address, as in the app: one it revoked is the relay's to refuse.
      endpoint: (runtimeId: string) => (world.runtimes.some((r) => r.runtimeId === runtimeId) || world.cloud.state.runtimes.has(runtimeId) ? { url: relayUrl(runtimeId), token: "" } : null),
      home: () => ({ runtimeId: home?.runtimeId ?? null, client: homeClient }),
      homeLocal: home?.role === "mac",
      connect: this.connector(page),
      direct: false,
    });
    // The window's own runtime, as runtime.tsx opens it: its calls wait in the person's store until answered.
    const homeOptions = home
      ? { outbox: this.sync.runtimeOutbox(this.hub.store(), home.runtimeId, home.role === "mac" ? undefined : home.computerId, pages), resend: this.hub.resendable(home.runtimeId) }
      : undefined;
    if (home?.role === "mac") {
      // The desktop: This Mac's runtime on loopback, as the local principal. The app hands its window the runtime's
      // token on every start (it changes when the runtime restarts).
      homeClient = connect(home.desktopPipe.url, () => home.info!.token, undefined, { ...homeOptions, socket: this.sockets(page) });
    } else if (home) {
      // A web tab that picked a Cloud computer: that computer through the relay.
      homeClient = this.connector(page)(relayUrl(home.runtimeId), "", undefined, homeOptions);
    }
    this.homeClient = homeClient;
    this.hub.start();
    for (const view of this.views.values()) this.attachView(view);
  }

  /** The window goes away mid-whatever (a reload): nothing flushes beyond what the store already holds. */
  close(): void {
    this.hub?.stop();
    this.homeClient?.close();
    this.homeClient = null;
  }

  /**
   * A reload: the page dies and runs no code of its own on the way out (no hub stop, no client close, no flush), so the
   * new page finds the store exactly as the old one last wrote it. The old page's objects live on in this process, so
   * they are stopped here, but against a store the new page never reads, and as a dead page (Page): they open nothing
   * and send nothing more. Answers the request ids in the outbox the new page starts from.
   */
  async reload(): Promise<Array<string>> {
    const kept = this.sync.memoryKv();
    for (const [key, value] of this.kv.data ?? []) kept.data!.set(key, structuredClone(value));
    const held = outboxIds(kept);
    this.current.alive = false;
    this.close();
    this.kv = kept;
    this.reloads++;
    // Each open chat starts again on the new page: from the device cache, then its source.
    for (const [sessionId, view] of this.views) {
      const fresh = new View(this.name, sessionId);
      fresh.resets = view.resets;
      this.views.set(sessionId, fresh);
      this.world.retired.push(view);
    }
    await this.open();
    return held;
  }

  view(sessionId: string): View {
    let view = this.views.get(sessionId);
    if (!view) {
      view = new View(this.name, sessionId);
      this.views.set(sessionId, view);
      this.attachView(view);
    }
    return view;
  }

  private attachView(view: View): void {
    view.feed = this.hub!.openFeed(view.sessionId, view.sink(), view.onState);
  }

  /** The client the pane uses for a chat: the window's own runtime's, or the hub's for a chat elsewhere. */
  clientFor(sessionId: string): Client {
    const hub = this.hub!;
    if (!hub.throughHub(sessionId) && this.homeClient && hub.summary(sessionId)?.runtime_id === this.homeRuntime()?.runtimeId) return this.homeClient;
    return hub.clientFor(sessionId);
  }

  /** Outbox entries this device holds now, in any part of its store (the page's calls in flight, Cloud's queue not yet confirmed). */
  async outboxEntries(): Promise<Array<string>> {
    return outboxIds(this.kv);
  }
}

/** The request ids of the outbox entries in a device's store, in any part of it. */
function outboxIds(kv: Kv): Array<string> {
  return [...(kv.data ?? new Map<string, unknown>()).entries()].filter(([k]) => k.includes("outbox/")).map(([, e]) => (e as { request_id: string }).request_id);
}

// ------------------------------------------------------------------------------------------------ the world

export interface WorldOptions {
  readonly trace: Trace;
  /** Logical Cloud runtime processes; two by default for the seeded chaos suite. */
  readonly cloudComputers?: number;
  /**
   * The Cloud computers run their git in a tools container (toolsExec.mjs over a Unix socket), as in production: what
   * a computer needs to clone into an empty checkout (K1).
   */
  readonly tools?: boolean;
}

/** Everything one chaos run needs, started once per file (runtimes take a few seconds each). */
export class World {
  cloud!: TestCloud;
  relay!: RelayFront;
  mac!: RuntimeProc;
  boxA!: RuntimeProc;
  boxB!: RuntimeProc;
  runtimes: Array<RuntimeProc> = [];
  devices: Array<Device> = [];
  /** Views a reload replaced: still checked for what they showed. */
  readonly retired: Array<View> = [];
  bare = "";
  macRepo = "";
  private sweep: ReturnType<typeof setInterval> | undefined;
  private readonly cleanups: Array<() => unknown> = [];
  readonly trace: Trace;
  private readonly cloudComputers: number;
  private readonly withTools: boolean;
  private toolsSocket: string | undefined;

  constructor(options: WorldOptions) {
    this.trace = options.trace;
    this.withTools = options.tools === true;
    this.cloudComputers = options.cloudComputers ?? 2;
    if (!Number.isInteger(this.cloudComputers) || this.cloudComputers < 2) throw new Error("the world needs at least two Cloud computers");
  }

  async start(): Promise<void> {
    const root = tempRoot("chaos-");
    this.cloud = await startTestCloud();
    this.cleanups.push(() => this.cloud.close());
    // Cloud computers on; the person's Claude Agent chats may run on any of their computers (a key in the vault).
    this.cloud.state.environments.computers = true;
    this.cloud.state.chats.engineLogins.set(PERSON, { "claude-agent": { vault_key: true, signed_in_on: [] } });
    this.relay = await relayFront(this.cloud, this.trace);
    this.cleanups.push(() => this.relay.close());
    // GitHub: one bare repository the git proxy serves the Cloud computers, which This Mac reaches directly.
    const gitRoot = path.join(root, "github");
    this.bare = path.join(gitRoot, `${REPO}.git`);
    fs.mkdirSync(path.dirname(this.bare), { recursive: true });
    git(gitRoot, "init", "-q", "--bare", "-b", "main", this.bare);
    this.cloud.state.gitBackend = gitRoot;
    const seed = path.join(root, "seed");
    git(root, "clone", "-q", this.bare, seed);
    fs.writeFileSync(path.join(seed, "README.md"), "chaos\n");
    git(seed, "add", ".");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    git(seed, "push", "-q", "origin", "HEAD:main");
    this.macRepo = path.join(root, "mac", "repo");
    fs.mkdirSync(path.dirname(this.macRepo), { recursive: true });
    git(path.dirname(this.macRepo), "clone", "-q", this.bare, this.macRepo);
    git(this.macRepo, "remote", "set-url", "origin", `https://github.com/${REPO}`);
    if (this.withTools) {
      const socket = path.join(tempRoot("chaos-tools-"), "tools.sock");
      const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, TOOLS_SIDE: "yes" }, stdio: "ignore" });
      this.cleanups.push(() => tools.kill());
      await until(() => fs.existsSync(socket), 10_000);
      this.toolsSocket = socket;
    }
    const pipes = async () => {
      const desktop = await tcpPipe();
      const admin = await tcpPipe();
      this.cleanups.push(() => desktop.close(), () => admin.close());
      return [desktop, admin] as const;
    };
    // This Mac reaches GitHub itself (here: the bare repository on disk).
    const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
    const macEnv = {
      CHAOS_CLOUD_URL: this.cloud.url,
      CHAOS_BEARER: this.cloud.state.personToken,
      GIT_CONFIG_COUNT: String(count + 1),
      [`GIT_CONFIG_KEY_${count}`]: `url.file://${this.bare}.insteadOf`,
      [`GIT_CONFIG_VALUE_${count}`]: `https://github.com/${REPO}`,
    };
    const [macDesktop, macAdmin] = await pipes();
    this.mac = new RuntimeProc("mac", "mac", path.join(root, "mac", "state"), macEnv, macDesktop, macAdmin, this.trace);
    this.boxA = await this.box(root, "box-a", await pipes());
    this.boxB = await this.box(root, "box-b", await pipes());
    const extraComputers = await Promise.all(Array.from({ length: this.cloudComputers - 2 }, async (_, i) => this.box(root, `box-${i + 3}`, await pipes())));
    this.runtimes = [this.mac, this.boxA, this.boxB, ...extraComputers];
    this.cleanups.push(() => Promise.all(this.runtimes.map((r) => r.close())));
    await Promise.all(this.runtimes.map((r) => r.start()));
    // The person keeps sync on (the prompt's Turn on sync, as SyncPrompt answers it where Cloud computers run): Remote control
    // and moves follow it.
    await this.mac.call("settings.set", { request_id: "chaos-sync-on", settings: { sync_chats: true, remote_control: true, move_to_cloud: true } });
    for (const r of this.runtimes) await until(async () => (await r.call("cloud.status", {})).state === "connected", 30_000);
    await until(() => this.runtimes.every((r) => this.relaySide(r.runtimeId) !== undefined), 30_000);
    // Cloud tells devices when a runtime comes and goes (C1's sweep), here every 250 ms.
    this.sweep = setInterval(() => this.cloud.sweepRuntimes(), 250);
    this.cleanups.push(() => clearInterval(this.sweep));
    this.trace.note(`world: mac ${this.mac.runtimeId.slice(0, 6)}, box-a ${this.boxA.runtimeId.slice(0, 6)}, box-b ${this.boxB.runtimeId.slice(0, 6)}`);
  }

  /** A Cloud computer as the computers service makes one: its identity, its link dir and its snapshot checkout. */
  private async box(root: string, name: string, [desktop, admin]: readonly [Pipe, Pipe]): Promise<RuntimeProc> {
    const { privateKey } = generateKeyPairSync("ed25519");
    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const runtimeId = randomUUID();
    const computerId = randomUUID();
    this.cloud.state.runtimes.set(runtimeId, { publicKey, computerId, lastIssued: 0, status: "active", person: PERSON });
    this.cloud.state.chats.computers.set(computerId, { kind: "cloud", name, person: PERSON, state: "running" });
    const linkDir = path.join(root, name, "link");
    fs.mkdirSync(linkDir, { recursive: true });
    fs.writeFileSync(path.join(linkDir, "runtime.json"), JSON.stringify({ cloud_url: this.cloud.url, runtime_id: runtimeId, organization_id: this.cloud.state.organizationId, computer_id: computerId, user_id: PERSON }));
    fs.writeFileSync(path.join(linkDir, "runtime.key"), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const checkout = path.join(root, name, "workspace");
    this.snapshotCheckout(checkout);
    // A computer of 8 vCPUs and 11 GiB: five chats (capacity.ts), four beside the first.
    const env = { CAVEMAN_CLOUD_LINK_DIR: linkDir, CAVEMAN_WORKSPACE_ROOT: checkout, CAVEMAN_COMPUTER_CPUS: "8", CAVEMAN_COMPUTER_MEMORY_GIB: "11", ...(this.toolsSocket === undefined ? {} : { CAVEMAN_RUNTIME_TOOLS_ADDRESS: this.toolsSocket }) };
    const proc = new RuntimeProc(name, "cloud", path.join(root, name, "state"), env, desktop, admin, this.trace);
    proc.runtimeId = runtimeId;
    proc.computerId = computerId;
    return proc;
  }

  /** A Cloud computer's checkout as its repository's snapshot has it: the repository at main, nothing of any chat. */
  private snapshotCheckout(checkout: string): void {
    git(path.dirname(checkout), "clone", "-q", this.bare, checkout);
    git(checkout, "remote", "set-url", "origin", `https://github.com/${REPO}`);
    git(checkout, "config", "user.email", "t@t");
    git(checkout, "config", "user.name", "t");
  }

  /**
   * A Cloud computer comes back on a new volume (the runtime down): its state gone, its checkout as the repository's
   * snapshot has it, or with `checkout: "empty"` an empty directory (no snapshot built yet, K1: the world needs `tools`).
   */
  newDisk(rt: RuntimeProc, checkout: "snapshot" | "empty" = "snapshot"): void {
    rt.replaceDisk();
    if (checkout === "snapshot") this.snapshotCheckout(rt.checkout!);
  }

  relaySide(runtimeId: string): RelaySide | undefined {
    return [...this.cloud.state.relays].reverse().find((side) => side.ws.readyState === side.ws.OPEN && this.cloud.state.tokens.get(side.token)?.runtimeId === runtimeId);
  }

  async addDevices(specs: ReadonlyArray<DeviceSpec>): Promise<void> {
    const sync = await loadWebSync();
    // As the app's installDeviceHooks: a call queued in Cloud carries the signature of the device that made it. The hooks
    // are one per page; here every device shares this process, so the call's request id (each device prefixes its own)
    // says whose key signs.
    const signer = (requestId: string) => this.devices.find((d) => requestId.startsWith(`${d.name}-`));
    sync.registerDeviceHooks({
      callFields: async (call) => {
        const device = signer(call.request_id);
        return device ? queuedCallFields(device.key, call) : {};
      },
      moveFields: async (move) => {
        const device = signer(move.request_id);
        return device ? { device: await signMove(device.key, move) } : {};
      },
    });
    for (const spec of specs) {
      const device = new Device(spec, await testDevice(spec.kind === "phone" ? "iPhone, Safari" : spec.kind === "web" ? `Chrome, ${spec.name}` : "Desktop"), this, sync);
      await device.open();
      this.devices.push(device);
    }
  }

  device(name: string): Device {
    return this.devices.find((d) => d.name === name)!;
  }

  runtimeOfComputer(computerId: string): RuntimeProc | undefined {
    return this.runtimes.find((r) => r.computerId === computerId);
  }

  runtimeById(runtimeId: string): RuntimeProc | undefined {
    return this.runtimes.find((r) => r.runtimeId === runtimeId);
  }

  /** The runtime that holds a chat now, as Cloud's move transaction last placed it. */
  ownerOf(sessionId: string): RuntimeProc | undefined {
    const session = this.cloud.state.chats.sessions.get(sessionId);
    return session ? this.runtimeOfComputer(session.computer_id) : undefined;
  }

  /** A runtime is asleep: SIGSTOP, and Cloud hears it gone (its relay link dropped, its heartbeats aged out). */
  sleepRuntime(rt: RuntimeProc): void {
    rt.stop();
    this.relay.dropRuntime(rt.runtimeId);
    this.cloud.state.chats.lastHeartbeat.delete(rt.runtimeId);
    const computer = this.cloud.state.chats.computers.get(rt.computerId);
    if (computer?.kind === "cloud") computer.state = "suspended";
  }

  /**
   * Cloud stops a Cloud computer (an idle sleep on boat): its runtime ends cleanly, as `systemctl stop` ends it, its
   * relay link and heartbeats go, and Cloud reads the computer as asleep.
   */
  async stopComputer(rt: RuntimeProc): Promise<void> {
    await rt.term();
    this.relay.dropRuntime(rt.runtimeId);
    this.cloud.state.chats.lastHeartbeat.delete(rt.runtimeId);
    const computer = this.cloud.state.chats.computers.get(rt.computerId);
    if (computer?.kind === "cloud") computer.state = "suspended";
    this.trace.note(`${rt.name}: stopped by Cloud (asleep)`);
  }

  /**
   * A stopped Cloud computer wakes as Cloud wakes one (CONTRACT §5.3): a new identity is minted for it, a new runtime
   * id and key on the same computer and disk, and the one it stopped under is refused from here on. Answers the new
   * runtime id, once its runtime is up and linked.
   */
  async wakeUnderNewIdentity(rt: RuntimeProc): Promise<string> {
    if (rt.role !== "cloud" || rt.checkout === undefined) throw new Error("only a Cloud computer is given a new identity at a wake");
    const before = rt.runtimeId;
    const known = this.cloud.state.runtimes.get(before)!;
    known.status = "revoked";
    for (const [token, record] of this.cloud.state.tokens) if (record.runtimeId === before) this.cloud.state.tokens.delete(token);
    const { privateKey } = generateKeyPairSync("ed25519");
    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const runtimeId = randomUUID();
    this.cloud.state.runtimes.set(runtimeId, { publicKey, computerId: rt.computerId, lastIssued: 0, status: "active", person: PERSON });
    const linkDir = path.join(path.dirname(rt.base), "link");
    fs.writeFileSync(path.join(linkDir, "runtime.json"), JSON.stringify({ cloud_url: this.cloud.url, runtime_id: runtimeId, organization_id: this.cloud.state.organizationId, computer_id: rt.computerId, user_id: PERSON }));
    fs.writeFileSync(path.join(linkDir, "runtime.key"), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const computer = this.cloud.state.chats.computers.get(rt.computerId);
    if (computer?.kind === "cloud") computer.state = "running";
    await rt.start();
    if (rt.runtimeId !== runtimeId) throw new Error(`${rt.name} started as ${rt.runtimeId}, not the identity minted for this wake`);
    await until(() => this.relaySide(runtimeId) !== undefined, 30_000);
    this.trace.note(`${rt.name}: woke as ${runtimeId.slice(0, 6)} (was ${before.slice(0, 6)}, refused from now on)`);
    return runtimeId;
  }

  /** A Mac gone quiet long enough that its chats' leases lapsed (90 s on Cloud's clock). */
  lapseLeases(rt: RuntimeProc): void {
    for (const session of this.cloud.state.chats.sessions.values()) if (session.lease?.runtime_id === rt.runtimeId) session.lease.expires_at = 0;
    this.trace.note(`${rt.name}: its leases lapse on Cloud's clock`);
  }

  /**
   * Awake again, and Cloud hears it at once: a nap shorter than Cloud's quiet window (2 minutes, moves.go) never looked
   * gone there, and after a longer one the overdue heartbeat goes out as the runtime wakes.
   */
  wakeRuntime(rt: RuntimeProc): void {
    const computer = this.cloud.state.chats.computers.get(rt.computerId);
    if (computer?.kind === "cloud") computer.state = "running";
    rt.wake();
    this.cloud.state.chats.lastHeartbeat.set(rt.runtimeId, Date.now() + this.cloud.state.skewMs);
  }

  async close(): Promise<void> {
    for (const device of this.devices) device.close();
    for (const cleanup of this.cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
  }
}

/** Every event of a chat on its runtime now, from the start, with the journal's epoch (the owner's truth). */
export async function journalOf(rt: RuntimeProc, sessionId: string): Promise<{ epoch: number; events: Array<SessionEvent> }> {
  const events: Array<SessionEvent> = [];
  const sub = await rt.admin!.attach(sessionId, 0, (e) => events.push(e));
  await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 15_000);
  const epoch = sub.epoch?.() ?? 1;
  await sub.detach();
  return { epoch, events: events.slice(0, sub.session.head) };
}

/**
 * Cloud's copy of a chat, put together as a computer that adopts it would: its events, the commit of its work in
 * progress, its turn checkpoints. `segments`: the copy as it stood with that many segments. `show` reads a file of the
 * work in progress, and `holds` says whether a commit came with the copy, both out of the copy's own git bundles in a
 * clone that has nothing but GitHub's commits.
 */
export function copyOfChat(world: World, sessionId: string, segments?: number) {
  const session = world.cloud.state.chats.sessions.get(sessionId);
  const counted = (session?.segments ?? []).slice(0, segments);
  if (counted.length === 0) return undefined;
  const bundle = mergeBundles(counted.map((segment) => decodeBundle(segment.raw)));
  let repo: string | undefined;
  const clone = () => {
    if (repo !== undefined) return repo;
    const dir = tempRoot("chaos-copy-");
    repo = path.join(dir, "copy.git");
    git(dir, "clone", "-q", "--bare", world.bare, repo);
    [...bundle.wip_bundles, ...bundle.checkpoint_bundles].forEach((raw, n) => {
      const file = path.join(dir, `${n}.bundle`);
      fs.writeFileSync(file, typeof raw === "string" ? Buffer.from(raw, "base64") : raw);
      git(repo!, "fetch", "-q", file, `+refs/*:refs/copy/${n}/*`);
    });
    return repo;
  };
  // Asked of git quietly: a file or commit the copy does not hold is an answer, not an error to print.
  const read = (...args: Array<string>) => {
    try {
      return execFileSync("git", args, { cwd: clone(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  };
  return {
    bundle,
    show: (rel: string) => (bundle.wip === null ? undefined : read("show", `${bundle.wip}:${rel}`)),
    holds: (commit: string) => read("cat-file", "-e", `${commit}^{commit}`) !== undefined,
  };
}

/**
 * What an OS crash under `synchronous=NORMAL` loses: the newest `commits` transactions in the database's write-ahead log,
 * across every table at once (the runtime runs SQLite in WAL mode, persistence/Sqlite.ts). Call it after kill -9, before
 * the restart: SQLite then recovers the log up to the last commit left. Answers how many commits it dropped.
 */
export function loseWalTail(dbPath: string, commits: number): number {
  const walPath = `${dbPath}-wal`;
  if (!fs.existsSync(walPath)) return 0;
  const wal = fs.readFileSync(walPath);
  if (wal.length < 32) return 0;
  const pageSize = wal.readUInt32BE(8);
  const salt = [wal.readUInt32BE(16), wal.readUInt32BE(20)];
  // Each frame: a 24-byte header (page, the database size after a commit or 0, the log's salts, checksums) and a page.
  const commitEnds: Array<number> = [];
  for (let at = 32; at + 24 + pageSize <= wal.length; at += 24 + pageSize) {
    // Frames of an earlier generation of the log (other salts) were never part of this one.
    if (wal.readUInt32BE(at + 8) !== salt[0] || wal.readUInt32BE(at + 12) !== salt[1]) break;
    if (wal.readUInt32BE(at + 4) !== 0) commitEnds.push(at + 24 + pageSize);
  }
  const dropped = Math.min(commits, commitEnds.length);
  if (dropped === 0) return 0;
  const keep = commitEnds.length - dropped;
  fs.truncateSync(walPath, keep > 0 ? commitEnds[keep - 1]! : 32);
  // The index of the log is rebuilt from the log itself on the next open.
  fs.rmSync(`${dbPath}-shm`, { force: true });
  return dropped;
}

/**
 * How the runtime's orchestrator placed the runs of the chat a run is in, while it runs: each run in its queue order
 * now (the projection's ordinal; a run created as ordinal:N sits elsewhere once queued-run.reorder moved it), with its
 * status, when it was requested and completed, and the start of its payload. `runIds`: runs in that chat (a journal
 * event's turn_id). Opened read-write for SELECTs only: a read-only connection does not see the runtime's WAL.
 */
export function dispatchLog(rt: RuntimeProc, runIds: ReadonlyArray<string>): string {
  if (!rt.info) return "(not running)";
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(rt.info.dbPath);
    const threads = new Set<string>();
    for (const runId of runIds) for (const row of db.prepare("SELECT thread_id FROM orchestration_v2_projection_runs WHERE run_id = ?").all(runId)) threads.add(String(row.thread_id));
    const lines: Array<string> = [];
    for (const thread of threads) {
      const runs = db.prepare("SELECT ordinal, run_id, status, requested_at, completed_at, substr(payload_json, 1, 260) AS payload FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal").all(thread);
      lines.push(`thread ${thread} runs, in queue order:`, ...runs.map((r) => `  ${r.ordinal} ${r.run_id} ${r.status} requested ${r.requested_at} completed ${r.completed_at ?? "-"} ${r.payload}`));
    }
    return lines.join("\n") || `(no run ${runIds.join(", ")} in its projection)`;
  } catch (error) {
    return `(unreadable: ${(error as Error).message})`;
  } finally {
    db?.close();
  }
}

/** Lines of a runtime's log that say something went wrong, for the failure print. */
export function logErrors(rt: RuntimeProc, n = 12): string {
  try {
    return fs
      .readFileSync(rt.logFile, "utf8")
      .split("\n")
      .filter((l) => /ERROR|WARN|Error|failed/.test(l))
      .slice(-n)
      .join("\n");
  } catch {
    return "";
  }
}

