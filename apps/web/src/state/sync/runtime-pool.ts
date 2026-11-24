// The device's connections to runtimes (S6): at most one per runtime, opened when a chat on it is in view or a call
// needs it, closed two minutes after the last user lets go. The web reaches every runtime through Cloud's relay on the
// session cookie; the desktop reaches This Mac on loopback and Cloud computers through the relay with a short-lived
// token from its own runtime. Watching costs a computer nothing: its activity is turns and calls, not sockets (S7).
import { ConnectionClosed, connect as defaultConnect, type Client, type ConnectionState, type ConnectOptions, type Handshake, type Outbox, type TokenSource } from "@caveman-app/session-protocol/client";
import type { RuntimeHello } from "@caveman-app/session-protocol";
import { connectDirect, pathOf, type DirectOptions } from "@caveman-app/session-protocol/direct";

export interface PoolEndpoint {
  readonly url: string;
  readonly token: TokenSource;
}

/** How a runtime's link is doing, as far as this device can tell. */
export type LinkState = "connecting" | "open" | "unreachable" | "unauthorized";

export interface RuntimePoolOptions {
  /** Where a runtime is reached from this device; null when it cannot be (no Cloud sign-in on this device). */
  readonly endpoint: (runtimeId: string) => PoolEndpoint | null;
  /** Each runtime's durable outbox (outbox.ts), so calls in flight survive a reload. */
  readonly outbox?: (runtimeId: string) => Outbox;
  readonly onRestored?: (runtimeId: string) => ConnectOptions["onRestored"];
  /** Whether a call to `runtimeId` that went out with no answer may go out again (ConnectOptions.resend). */
  readonly resend?: (runtimeId: string) => ConnectOptions["resend"];
  /** A runtime's first exchange on each socket (device approval on a laptop runtime, S13). */
  readonly handshake?: (runtimeId: string) => Handshake | undefined;
  /** How long a connection nobody holds stays open. */
  readonly idleMs?: number;
  /** Test seam: GONE_MS. */
  readonly goneMs?: number;
  readonly connect?: typeof defaultConnect;
  /**
   * How to try a direct path to `runtimeId` (a WebRTC data channel to a laptop's runtime, S14); undefined: relay only.
   * Asked as the connection opens; the connection then switches paths by itself (session-protocol direct.ts).
   */
  readonly direct?: (runtimeId: string) => DirectOptions | undefined;
}

interface Conn {
  readonly client: Client;
  holders: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  link: LinkState;
}

export const IDLE_MS = 2 * 60 * 1000;
/**
 * A runtime the relay said it cannot reach, with nobody holding its connection, is not tried again for this long
 * (unless Cloud's list says something new of it first, revive): never a reconnect every few seconds to a computer
 * that is gone (K16).
 */
export const GONE_MS = 60 * 1000;

export class RuntimePool {
  private readonly conns = new Map<string, Conn>();
  /** Runtimes dropped as unreachable while nobody held them, and until when they read so (GONE_MS). */
  private readonly gone = new Map<string, number>();
  /** Every "open" a pooled connection reported, numbered across the pool, and each runtime's latest. */
  private opens = 0;
  private readonly lastOpen = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  private readonly options: RuntimePoolOptions;

  constructor(options: RuntimePoolOptions) {
    this.options = options;
  }

  /** A connection to `runtimeId` held until `release`; null when this device cannot reach it. */
  acquire(runtimeId: string): { readonly client: Client; readonly release: () => void } | null {
    const conn = this.open(runtimeId);
    if (!conn) return null;
    conn.holders++;
    clearTimeout(conn.idle);
    conn.idle = undefined;
    let released = false;
    return {
      client: conn.client,
      release: () => {
        if (released) return;
        released = true;
        if (--conn.holders > 0 || this.conns.get(runtimeId) !== conn) return;
        // Nobody wants a connection that only retries: it goes now, not two minutes on.
        if (conn.link === "unreachable") return this.dropGone(runtimeId, conn);
        conn.idle = setTimeout(() => this.drop(runtimeId, conn), this.options.idleMs ?? IDLE_MS);
      },
    };
  }

  /** Runs `use` on a held connection (a call that needs the runtime), letting go when it settles. */
  async with<T>(runtimeId: string, use: (client: Client) => Promise<T>): Promise<T> {
    const held = this.acquire(runtimeId);
    if (!held) throw new Error("This device cannot reach that computer.");
    try {
      return await use(held.client);
    } finally {
      held.release();
    }
  }

  link(runtimeId: string): LinkState | undefined {
    const conn = this.conns.get(runtimeId);
    if (conn) return conn.link;
    const until = this.gone.get(runtimeId);
    if (until === undefined) return undefined;
    if (Date.now() < until) return "unreachable";
    this.gone.delete(runtimeId);
    return undefined;
  }

  /**
   * The number of the latest "open" `runtimeId`'s connection reported, 0 before one: it changes whenever what was set up
   * on the connection (terminals, command watches, screencasts) is gone, so its holders set it up again. A direct
   * connection says "open" again, with no drop between, after a path that carried some of it went (direct.ts reopened).
   */
  lastOpened(runtimeId: string): number {
    return this.lastOpen.get(runtimeId) ?? 0;
  }

  /** Cloud's list said something new of `runtimeId` (it came on line, say): a runtime dropped as gone may be tried again. */
  revive(runtimeId: string): void {
    if (this.gone.delete(runtimeId)) for (const listener of this.listeners) listener();
  }

  /**
   * Drops the connections nobody holds to runtimes not in `named` (no chat in Cloud's list lives there any more, K16):
   * they would only idle, or retry a computer that is gone.
   */
  keepOnly(named: ReadonlySet<string>): void {
    for (const [id, conn] of this.conns) if (conn.holders === 0 && !named.has(id)) this.drop(id, conn);
  }

  /**
   * A direct channel carries `runtimeId`'s traffic now (S14): its connection switches between that and the relay by
   * itself (session-protocol direct.ts), so the client callers hold never changes.
   */
  isDirect(runtimeId: string): boolean {
    return pathOf(this.conns.get(runtimeId)?.client) === "direct";
  }

  /** `runtimeId`'s runtime.hello answer on its open connection, if it has answered (listeners hear each one). */
  hello(runtimeId: string): RuntimeHello | undefined {
    return this.conns.get(runtimeId)?.client.hello();
  }

  /** Runtimes with an open connection (tests, the debug line). */
  openRuntimes(): string[] {
    return [...this.conns.keys()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  closeAll(): void {
    for (const [id, conn] of this.conns) this.drop(id, conn);
  }

  private open(runtimeId: string): Conn | null {
    const known = this.conns.get(runtimeId);
    if (known) return known;
    const endpoint = this.options.endpoint(runtimeId);
    if (!endpoint) return null;
    const connect = this.options.connect ?? defaultConnect;
    const onRestored = this.options.onRestored?.(runtimeId);
    const handshake = this.options.handshake?.(runtimeId);
    const resend = this.options.resend?.(runtimeId);
    let conn: Conn | null = null;
    const onState = (state: ConnectionState, error?: Error) => {
      if (!conn || this.conns.get(runtimeId) !== conn) return;
      if (state === "open") this.lastOpen.set(runtimeId, ++this.opens);
      const next: LinkState =
        state === "open" ? "open" : state === "unauthorized" ? "unauthorized" : error instanceof ConnectionClosed && (error.code === 4404 || error.code === 1006) ? "unreachable" : state === "connecting" && conn.link !== "open" ? conn.link : "connecting";
      if (next === conn.link && state !== "open") return;
      conn.link = next;
      if (next === "unreachable" && conn.holders === 0) return this.dropGone(runtimeId, conn);
      for (const listener of this.listeners) listener();
    };
    const connectOptions: ConnectOptions = {
      ...(this.options.outbox ? { outbox: this.options.outbox(runtimeId) } : {}),
      ...(onRestored ? { onRestored } : {}),
      ...(handshake ? { handshake } : {}),
      ...(resend ? { resend } : {}),
    };
    const direct = this.options.connect ? undefined : this.options.direct?.(runtimeId);
    const client = direct
      ? connectDirect(endpoint.url, endpoint.token, onState, {
          ...connectOptions,
          direct: {
            ...direct,
            onPath: (path) => {
              direct.onPath?.(path);
              for (const listener of this.listeners) listener();
            },
          },
        })
      : connect(endpoint.url, endpoint.token, onState, connectOptions);
    conn = { client, holders: 0, idle: undefined, link: "connecting" };
    // Its version may change on a reconnect (a computer that woke on a new image): the window looks again (skew.ts).
    client.onHello(() => {
      if (this.conns.get(runtimeId) === conn) for (const listener of this.listeners) listener();
    });
    this.gone.delete(runtimeId);
    this.conns.set(runtimeId, conn);
    return conn;
  }

  /** Closes an unreachable connection nobody holds, so it stops retrying, and remembers the runtime as gone a while. */
  private dropGone(runtimeId: string, conn: Conn): void {
    this.gone.set(runtimeId, Date.now() + (this.options.goneMs ?? GONE_MS));
    this.drop(runtimeId, conn);
  }

  private drop(runtimeId: string, conn: Conn): void {
    if (this.conns.get(runtimeId) !== conn) return;
    clearTimeout(conn.idle);
    this.conns.delete(runtimeId);
    conn.client.close();
    for (const listener of this.listeners) listener();
  }
}
