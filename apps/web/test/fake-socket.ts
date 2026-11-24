// The one fake layer under the app: a WebSocket that never leaves the page. `ws://runtime.test/` reaches the scripted
// runtime (session-peer.ts); every other URL (Vitest's own channel, should it reconnect) gets the real WebSocket.
// Everything above it is the app's own: @caveman-app/session-protocol's client, RuntimeProvider, the sync hub.
import { SUBPROTOCOL } from "@caveman-app/session-protocol/client";

export const RUNTIME_URL = "ws://runtime.test/";

/** The far end of a fake socket: the scripted runtime. */
export interface SocketPeer {
  opened(socket: FakeSocket): void;
  received(socket: FakeSocket, frame: string): void;
  closed(socket: FakeSocket): void;
}

const RealWebSocket = globalThis.WebSocket;

/**
 * What the session-protocol client reads of a browser WebSocket: readyState, send, close and the four handlers. Frames
 * cross in a later task, in order, as they would over a socket: a reply never lands inside the call that sent it.
 */
export class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  protocol = "";
  readyState = FakeSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  /** The bearer the client offered beside the subprotocol (base64url), decoded. */
  readonly bearer: string;
  private readonly peer: SocketPeer;

  constructor(url: string, protocols: string | string[] | undefined, peer: SocketPeer) {
    super();
    this.url = url;
    this.peer = peer;
    const offered = typeof protocols === "string" ? [protocols] : (protocols ?? []);
    const bearer = offered.find((p) => p.startsWith("base64url.bearer."));
    this.bearer = bearer ? atob(bearer.slice(17).replace(/-/g, "+").replace(/_/g, "/")) : "";
    setTimeout(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.protocol = offered.includes(SUBPROTOCOL) ? SUBPROTOCOL : "";
      this.peer.opened(this);
      this.fire("open", new Event("open"));
    }, 0);
  }

  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN)
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    const frame = String(data);
    setTimeout(() => {
      if (this.readyState === FakeSocket.OPEN) this.peer.received(this, frame);
    }, 0);
  }

  /** From the runtime's side: one frame to the client. */
  deliver(frame: string): void {
    setTimeout(() => {
      if (this.readyState === FakeSocket.OPEN)
        this.fire("message", new MessageEvent("message", { data: frame }));
    }, 0);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.peer.closed(this);
    setTimeout(
      () => this.fire("close", new CloseEvent("close", { code, reason, wasClean: code === 1000 })),
      0,
    );
  }

  private fire(type: "open" | "message" | "close", event: Event): void {
    this.dispatchEvent(event);
    if (type === "open") this.onopen?.(event);
    else if (type === "message") this.onmessage?.(event as MessageEvent);
    else this.onclose?.(event as CloseEvent);
  }
}

/** Routes `ws://runtime.test/` to `peer` until the returned function runs. */
export function routeRuntimeSocket(peer: SocketPeer): () => void {
  const Routed = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const href = String(url);
    if (new URL(href).host === new URL(RUNTIME_URL).host)
      return new FakeSocket(href, protocols, peer);
    return new RealWebSocket(href, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(Routed, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  globalThis.WebSocket = Routed;
  return () => {
    globalThis.WebSocket = RealWebSocket;
  };
}
