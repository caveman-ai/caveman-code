// A runtime for model checks of the client (client.modelcheck.test.ts here; chat-feed.modelcheck.test.ts and
// sender.modelcheck.test.ts in apps/web/src/state/sync): the far end of every socket the real connect() opens through
// `factory`, playing server.ts's contract and nothing more. Nothing happens by itself: each socket opening or dropping, each answer, each commit and each rewrite is a
// step the checker picks. Frames reach the client one message event (macrotask) each, so the client's microtasks run
// between them as in a browser. By default every frame the runtime sent arrives before the next step; with
// `frames: "stepwise"` each frame waits on its socket and its arrival is a step of its own, so anything can happen
// between an attach answer and its backlog, or between two events. Event payloads say their (epoch, cursor), `e<epoch>.<cursor>`, so a delivery log
// shows a splice of two journals on sight.
import { VirtualTimers } from "@caveman-app/model-check";
import type { SessionEvent } from "../src/protocol.ts";
import type { SocketFactory } from "../src/client.ts";

export const SESSION = "s1";
const at = "2026-11-06T12:00:00.000Z";

export const tag = (event: SessionEvent): string =>
  String((event.payload as { text?: unknown }).text);
const journalEvent = (epoch: number, cursor: number): SessionEvent =>
  ({
    session_id: SESSION,
    cursor,
    at,
    type: "message.delta",
    payload: { text: `e${epoch}.${cursor}` },
  }) as SessionEvent;

export interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** Date.now() when the runtime read it: a session.attach older than the client's deadline was given up on. */
  readonly at: number;
}

/** What every client frame was, in arrival order: the wire log. */
export interface WireFrame {
  readonly socket: number;
  readonly method: string;
  readonly requestId?: string;
  readonly cursor?: number;
}

const OPEN = 1;
const CLOSED = 3;

export class ModelSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  /** Requests the runtime has read and not answered. */
  requests: Array<Request> = [];
  /**
   * server.ts keeps one attachment per (connection, session): the cursor it last sent, and the attach that started it
   * (`by`, as `describe` names it), which the client must know to tell its events from a let-go attachment's.
   * `withheld`: the relay lost the last event this attachment sent and nothing has gone out on it since, so the client
   * cannot know of the hole yet.
   */
  attachment: { last: number; by: string; withheld?: number } | undefined;
  /** frames: "stepwise": frames sent and not arrived yet, in order (a WebSocket keeps order), each with a label. */
  inbox: Array<{ readonly label: string; readonly frame: string }> = [];
  /** What each request was, by JSON-RPC id, so an answer's label names it. */
  private readonly asked = new Map<number, string>();
  readonly n: number;
  private readonly runtime: ModelRuntime;

  constructor(runtime: ModelRuntime, n: number) {
    this.runtime = runtime;
    this.n = n;
  }

  send(frame: string): void {
    if (this.readyState !== OPEN) throw new Error("send on a socket that is not open");
    const request: Request = { ...(JSON.parse(frame) as Omit<Request, "at">), at: Date.now() };
    this.asked.set(request.id, describe(request));
    this.runtime.read(this, request);
  }

  /** The client's own close: the close event follows as a task, as a browser's does. */
  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.attachment = undefined;
    this.requests = [];
    this.inbox = [];
    setTimeout(() => this.onclose?.({ code: 1005, reason: "" }), 0);
  }

  /** A frame from the runtime, as its own message event; one that lands after the socket closed is not read. */
  push(body: Record<string, any>): void {
    const frame = JSON.stringify({ jsonrpc: "2.0", ...body });
    if (this.runtime.stepwise) return void this.inbox.push({ label: this.label(body), frame });
    this.arrive(frame);
  }

  /** frames: "stepwise": the oldest frame on its way arrives (as its own message event). */
  deliverNext(): void {
    const next = this.inbox.shift();
    if (next) this.arrive(next.frame);
  }

  /** frames: "stepwise": every frame on its way arrives, in order, one message event each (a drain). */
  deliverAll(): number {
    const frames = this.inbox;
    this.inbox = [];
    for (const { frame } of frames) this.arrive(frame);
    return frames.length;
  }

  private arrive(frame: string): void {
    setTimeout(() => {
      if (this.readyState === OPEN) this.onmessage?.({ data: frame });
    }, 0);
  }

  private label(body: Record<string, any>): string {
    if (typeof body.id === "number")
      return `${body.error ? "the refusal" : "the answer"} to ${this.asked.get(body.id) ?? `request ${body.id}`}`;
    if (body.method === "session.events")
      return `session.events ${(body.params.events as Array<SessionEvent>).map(tag).join(" ")}`;
    if (body.method === "session.event") return `session.event ${tag(body.params as SessionEvent)}`;
    if (body.method === "session.ended")
      return `session.ended ${String(body.params.error?.data?.reason)}`;
    return String(body.method);
  }
}

export interface RuntimeSnapshot {
  readonly epoch: number;
  readonly journal: number;
  readonly sockets: ReadonlyArray<{
    readonly state: "connecting" | "open";
    readonly attached: number | null;
    /** The attach that started that attachment (`ModelSocket.attachment.by`). */
    readonly attachedBy: string | null;
    /** The cursor of a lost event that is still the last thing this socket's attachment sent (see `attachment`). */
    readonly withheld: number | null;
    readonly requests: ReadonlyArray<string>;
    /** frames: "stepwise": frames on their way to the client. */
    readonly inbox: ReadonlyArray<string>;
  }>;
  readonly ran: ReadonlyArray<string>;
  readonly moving: string | null;
}

export class ModelRuntime {
  epoch = 1;
  journal: Array<SessionEvent> = [];
  readonly sockets: Array<ModelSocket> = [];
  /** server.ts `once`: a mutating call's first answer, by request id. A receipt is read before anything else. */
  readonly receipts = new Map<string, unknown>();
  /** Request ids in the order the runtime ran them. */
  readonly ran: Array<string> = [];
  readonly wire: Array<WireFrame> = [];
  /** The chat is moving away (CHAOS-15): attaches and calls without a receipt are refused with this reason. */
  moving: "lease_lost" | "not_found" | null = null;
  /** The next this many token() calls throw, as DesktopCloudToken.get does while This Mac's runtime is away. */
  tokenFailures = 0;
  /** Called on every client frame, before the runtime reads it (a test's wire-log check). */
  onFrame: ((frame: WireFrame) => void) | undefined;
  /** Each frame's arrival is a step of its own (see the top of this file). */
  readonly stepwise: boolean;

  constructor(events = 1, options: { readonly frames?: "settle" | "stepwise" } = {}) {
    this.stepwise = options.frames === "stepwise";
    for (let cursor = 1; cursor <= events; cursor++)
      this.journal.push(journalEvent(this.epoch, cursor));
  }

  readonly factory: SocketFactory = () => {
    const socket = new ModelSocket(this, this.sockets.length + 1);
    this.sockets.push(socket);
    return socket as unknown as WebSocket;
  };

  readonly token = async (): Promise<string> => {
    if (this.tokenFailures > 0) {
      this.tokenFailures--;
      throw new Error("cloud.client_token did not answer");
    }
    return "token";
  };

  /** Sockets not closed, oldest first. */
  live(): Array<ModelSocket> {
    return this.sockets.filter((socket) => socket.readyState !== CLOSED);
  }

  connecting(): ModelSocket | undefined {
    return this.live().find((socket) => socket.readyState === 0);
  }

  /** Every socket's frames on their way arrive (frames: "stepwise"; a drain). The number of frames. */
  deliverAll(): number {
    return this.live().reduce((sum, socket) => sum + socket.deliverAll(), 0);
  }

  open(socket: ModelSocket): void {
    socket.readyState = OPEN;
    socket.onopen?.({});
  }

  /** The link goes (or the attempt is refused): the close event, then the client's onLost. */
  drop(socket: ModelSocket): void {
    const wasOpen = socket.readyState === OPEN;
    socket.readyState = CLOSED;
    socket.attachment = undefined;
    socket.requests = [];
    socket.inbox = [];
    if (wasOpen) socket.onclose?.({ code: 1006, reason: "" });
    else socket.onerror?.({});
  }

  read(socket: ModelSocket, request: Request): void {
    const frame: WireFrame = {
      socket: socket.n,
      method: request.method,
      ...(typeof request.params?.request_id === "string"
        ? { requestId: request.params.request_id }
        : {}),
      ...(typeof request.params?.cursor === "number" ? { cursor: request.params.cursor } : {}),
    };
    this.onFrame?.(frame);
    this.wire.push(frame);
    socket.requests.push(request);
  }

  /**
   * Answers one request as server.ts does. `lost`: the runtime ran it and the link went before the answer arrived.
   * `unauthorized`: the socket's token expired since it opened.
   */
  answer(socket: ModelSocket, request: Request, how: "ok" | "lost" | "unauthorized" = "ok"): void {
    socket.requests = socket.requests.filter((r) => r !== request);
    const { id, method, params } = request;
    const fail = (reason: string) =>
      socket.push({ id, error: { code: -32010, message: reason, data: { reason } } });
    if (how === "unauthorized") return fail("unauthorized");
    if (method === "session.attach") return this.attach(socket, request);
    if (method === "session.detach") {
      socket.attachment = undefined;
      return socket.push({ id, result: {} });
    }
    const requestId = typeof params.request_id === "string" ? params.request_id : undefined;
    if (requestId === undefined) return socket.push({ id, result: {} });
    let result = this.receipts.get(requestId);
    if (result === undefined) {
      if (this.moving) return fail(this.moving);
      result = { turn_id: `turn-${requestId}`, disposition: "started" };
      this.receipts.set(requestId, result);
      this.ran.push(requestId);
    }
    if (how === "lost") return this.drop(socket);
    socket.push({ id, result });
  }

  /** server.ts session.attach: the answer (epoch, reset), then the backlog batched, then live events. */
  private attach(socket: ModelSocket, request: Request): void {
    const { id, params } = request;
    if (this.moving)
      return socket.push({
        id,
        error: { code: -32010, message: this.moving, data: { reason: this.moving } },
      });
    const cursor = params.cursor as number;
    const epoch = params.epoch as number | undefined;
    const head = this.journal.length;
    const reset = (epoch !== undefined && epoch !== this.epoch) || cursor > head;
    socket.push({
      id,
      result: {
        session: {
          id: SESSION,
          workspace_id: "w1",
          engine: "caveman",
          state: "live",
          head,
          created_at: at,
          updated_at: at,
        },
        epoch: this.epoch,
        reset,
      },
    });
    const from = reset ? 0 : cursor;
    const backlog = this.journal.slice(from);
    if (backlog.length > 0)
      socket.push({ method: "session.events", params: { session_id: SESSION, events: backlog } });
    socket.attachment = { last: from + backlog.length, by: describe(request) };
  }

  /** A commit: every attachment that is caught up sends it. `relay: "lost"` plays a relay that loses the frame. */
  commit(relay: "once" | "lost" = "once"): void {
    const event = journalEvent(this.epoch, this.journal.length + 1);
    this.journal.push(event);
    for (const socket of this.live()) {
      if (!socket.attachment || socket.attachment.last !== event.cursor - 1) continue;
      socket.attachment.last = event.cursor;
      if (relay === "lost") {
        socket.attachment.withheld = event.cursor;
        continue;
      }
      // This event reaches the client after the lost one: it shows the hole.
      delete socket.attachment.withheld;
      socket.push({ method: "session.event", params: event });
    }
  }

  /** The journal is rewritten under a new epoch (a move, a lost tail): every attachment ends with journal_reset. */
  rewrite(events: number): void {
    this.epoch++;
    this.journal = Array.from({ length: events }, (_, i) => journalEvent(this.epoch, i + 1));
    this.end("journal_reset");
  }

  /** The runtime ends every attachment itself (session.ended): journal_reset, lease_lost, parked. */
  end(reason: string): void {
    for (const socket of this.live()) {
      if (!socket.attachment) continue;
      socket.attachment = undefined;
      socket.push({
        method: "session.ended",
        params: { session_id: SESSION, error: { code: -32011, message: reason, data: { reason } } },
      });
    }
  }

  snapshot(): RuntimeSnapshot {
    return {
      epoch: this.epoch,
      journal: this.journal.length,
      sockets: this.live().map((socket) => ({
        state: socket.readyState === OPEN ? "open" : "connecting",
        attached: socket.attachment?.last ?? null,
        attachedBy: socket.attachment?.by ?? null,
        withheld: socket.attachment?.withheld ?? null,
        requests: socket.requests.map(describe),
        inbox: socket.inbox.map((frame) => frame.label),
      })),
      ran: [...this.ran],
      moving: this.moving,
    };
  }
}

/** A request as a step names it: `session.attach from 2`, `turn.submit r1`, `session.detach`. */
export const describe = (request: Request): string => {
  if (request.method === "session.attach")
    return `session.attach from ${String(request.params.cursor)}${request.params.epoch !== undefined ? ` (epoch ${String(request.params.epoch)})` : ""}`;
  if (typeof request.params?.request_id === "string")
    return `${request.method} ${request.params.request_id}`;
  return request.method;
};

export interface Step {
  readonly name: string;
  readonly run: () => void;
}

/** The runtime's and the network's steps open now, with unique names; `budget` caps the ones that cost a bound. */
export const runtimeSteps = (
  runtime: ModelRuntime,
  budget: {
    readonly drops: boolean;
    readonly lostAnswers?: boolean;
    readonly unauthorized?: boolean;
    readonly answers?: (request: Request) => boolean;
  },
): Array<Step> => {
  const steps: Array<Step> = [];
  const connecting = runtime.connecting();
  if (connecting) steps.push({ name: "socket opens", run: () => runtime.open(connecting) });
  for (const socket of runtime.live()) {
    if (socket.readyState !== OPEN) continue;
    if (budget.drops)
      steps.push({ name: `link drops (socket ${socket.n})`, run: () => runtime.drop(socket) });
    const arriving = socket.inbox[0];
    if (arriving)
      steps.push({
        name: `${arriving.label} arrives (socket ${socket.n})`,
        run: () => socket.deliverNext(),
      });
    const seen = new Map<string, number>();
    for (const request of socket.requests) {
      if (budget.answers && !budget.answers(request)) continue;
      const mutating = typeof request.params?.request_id === "string";
      // server.ts laneOf: a chat's mutating calls on one connection run one after another, in arrival order. Its
      // attaches and detaches are answered in arrival order there too; here only where a check's `answers` says so.
      if (
        mutating &&
        socket.requests.some((r) => r.id < request.id && typeof r.params?.request_id === "string")
      )
        continue;
      const base = describe(request);
      const nth = (seen.get(base) ?? 0) + 1;
      seen.set(base, nth);
      const name = `runtime answers ${base}${nth > 1 ? ` #${nth}` : ""} (socket ${socket.n})`;
      steps.push({ name, run: () => runtime.answer(socket, request) });
      if (mutating && budget.lostAnswers)
        steps.push({
          name: `${name}, the answer is lost`,
          run: () => runtime.answer(socket, request, "lost"),
        });
      if (budget.unauthorized && request.method !== "session.attach")
        steps.push({
          name: `${name}: unauthorized`,
          run: () => runtime.answer(socket, request, "unauthorized"),
        });
    }
  }
  return steps;
};

/** The delivery contract read off one log: null when it holds, else what broke. */
export const contiguityBreak = (log: ReadonlyArray<string>): string | null => {
  let epoch: number | undefined;
  let cursor = 0;
  for (const entry of log) {
    const reset = /^reset (\d+)$/.exec(entry);
    if (reset) {
      epoch = Number(reset[1]);
      cursor = 0;
      continue;
    }
    const [, e, c] = /^e(\d+)\.(\d+)$/.exec(entry)!;
    if (epoch !== undefined && Number(e) !== epoch)
      return `${entry} delivered into epoch ${epoch} without a reset`;
    if (Number(c) !== cursor + 1) return `${entry} delivered after cursor ${cursor}`;
    epoch = Number(e);
    cursor = Number(c);
  }
  return null;
};

export const position = (
  log: ReadonlyArray<string>,
): { epoch: number | undefined; cursor: number } => {
  let epoch: number | undefined;
  let cursor = 0;
  for (const entry of log) {
    const reset = /^reset (\d+)$/.exec(entry);
    if (reset) [epoch, cursor] = [Number(reset[1]), 0];
    else [epoch, cursor] = /^e(\d+)\.(\d+)$/.exec(entry)!.slice(1).map(Number) as [number, number];
  }
  return { epoch, cursor };
};

/**
 * VirtualTimers on the globals, remembering each timer's delay so a step can tell a 30 s attach deadline apart, and
 * which timers repeat (`intervals`: a direct channel's pinger). `start`: the clock's first reading (default 0).
 */
export const installClock = (start = 0) => {
  const timers = new VirtualTimers(start);
  const restoreTimers = timers.install();
  const delays = new Map<number, number>();
  const intervals = new Set<number>();
  const virtual = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, delay = 0, ...args: Array<unknown>) => {
    const id = (virtual as unknown as (f: () => void, d: number, ...a: Array<unknown>) => number)(
      fn,
      delay,
      ...args,
    );
    delays.set(id, delay);
    return id;
  }) as typeof setTimeout;
  const repeating = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void, delay = 0, ...args: Array<unknown>) => {
    const id = (repeating as unknown as (f: () => void, d: number, ...a: Array<unknown>) => number)(
      fn,
      delay,
      ...args,
    );
    intervals.add(id);
    return id;
  }) as typeof setInterval;
  const nextDelay = () => {
    const next = timers.pending()[0];
    return next === undefined ? undefined : delays.get(next.id);
  };
  return { timers, nextDelay, delays, intervals, restore: restoreTimers };
};

/**
 * CLIENT_DELIVERY_FULL=1: every check, finding runs included, takes its larger bound (.claude/skills/client-delivery/
 * SKILL.md, "Run it"). Unset, as in each package's normal `vitest run`, they take the smaller one, and the three files
 * together run in about a minute.
 */
export const FULL =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .CLIENT_DELIVERY_FULL === "1";

/** client.ts ATTACH_TIMEOUT_MS. */
export const ATTACH_DEADLINE_MS = 30_000;
export const abandoned = (request: Request) =>
  request.method === "session.attach" && Date.now() - request.at >= ATTACH_DEADLINE_MS;
