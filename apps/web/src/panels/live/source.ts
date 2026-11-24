// ), packages/client-runtime/src/preview/serverBrowserStream.ts @ ab3a3cd1
// (modifier bitmask, input coalesced per animation frame), moved onto Session
// Protocol's browser.* and computer.* methods.
//
// A LiveSource is one remote screen this client can watch and drive: the
// agent's browser, the workspace computer's desktop. <LiveView> draws any
// source, so a computer-use system plugs in by implementing this interface.

import { SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import type { NotificationParams, Params } from "@caveman-app/session-protocol/protocol";

/** Who drives the screen right now. */
export type Controller = NotificationParams<"browser.state">["controller"];
/** One pointer, wheel, key or text event, in frame pixels. */
export type InputEvent = Params<"browser.input">["events"][number];
export type LiveFrame = NotificationParams<"browser.frame">;
export type LivePointer = NotificationParams<"browser.pointer">;
export type BrowserState = NotificationParams<"browser.state">;
export type ComputerState = NotificationParams<"computer.state">;

export interface LiveSource<S extends { readonly controller: Controller } = { readonly controller: Controller }> {
  /** What the screen is, for labels: "browser", "computer". */
  readonly noun: string;
  /** The last state the runtime sent for this screen, null before the first. */
  readonly state: S | null;
  /**
   * Stream frames to this connection while any holder wants them, at the fastest rate one asks for (`maxFps` a
   * second); calling it again for the same holder changes its rate. Several views can watch one screen this way.
   * Resolves "unavailable" when the runtime or its computer can't stream this screen (`unsupported`); other errors reject.
   */
  start(holder: object, maxFps: number): Promise<"live" | "unavailable">;
  /** Let go of the frames; when the last holder lets go they stop and queued input drops. */
  stop(holder: object): void;
  onFrame(listener: (frame: LiveFrame) => void): () => void;
  onState(listener: (state: S) => void): () => void;
  /** The agent's cursor as it acts, for the overlay. */
  onPointer(listener: (pointer: LivePointer) => void): () => void;
  /** The runtime refused this connection's input (`user_in_control`, `forbidden`): another window or connection holds the screen now. */
  onControlLost(listener: () => void): () => void;
  /** Take the screen (`user`) or hand it back (`agent`). Resolves to who drives now. */
  control(controller: "user" | "agent"): Promise<Controller>;
  /** Queue input. It goes out once per animation frame as one batch with one request_id; runs of moves and of wheels coalesce. */
  input(...events: InputEvent[]): void;
}

/** A mouse's thumb buttons: `button` 3 is Back, 4 is Forward; any other button is null. */
export function thumbButton(button: number): "back" | "forward" | null {
  return button === 3 ? "back" : button === 4 ? "forward" : null;
}

/** CDP modifier bitmask, as the protocol wants it: alt 1, ctrl 2, meta 4, shift 8. */
export function modifiers(e: { readonly altKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** Append to a frame's batch: a move replaces the move before it, a wheel adds to the wheel before it. Order is kept. */
export function coalesce(queue: InputEvent[], e: InputEvent): void {
  const last = queue[queue.length - 1];
  if (last?.type === "pointer" && e.type === "pointer" && last.action === "move" && e.action === "move" && last.button === e.button && last.modifiers === e.modifiers) {
    queue[queue.length - 1] = e;
  } else if (last?.type === "wheel" && e.type === "wheel" && last.modifiers === e.modifiers) {
    queue[queue.length - 1] = { ...e, dx: last.dx + e.dx, dy: last.dy + e.dy };
  } else {
    queue.push(e);
  }
}

/** A frame or snapshot image as a Blob, for createImageBitmap or the clipboard. */
export function blobOf(image: { readonly mime_type: string; readonly data: string }): Blob {
  const bin = atob(image.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: image.mime_type });
}

/** A page's address as the live views name it: host and path. */
export function pageHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

export function isUnsupported(error: unknown): boolean {
  return error instanceof SessionProtocolError && error.error.data?.reason === "unsupported";
}

/** Input refused because this connection doesn't hold the screen (any more). */
export function isRefusal(error: unknown): boolean {
  const reason = error instanceof SessionProtocolError ? error.error.data?.reason : undefined;
  return reason === "user_in_control" || reason === "forbidden";
}

// One source per connection and screen, so the tab and the watcher share the last state.
const sources = new WeakMap<Client, Map<string, LiveSource<never>>>();

export function browserSource(client: Client, workspaceId: string): LiveSource<BrowserState> {
  return memo(client, workspaceId, "browser");
}

export function computerSource(client: Client, workspaceId: string): LiveSource<ComputerState> {
  return memo(client, workspaceId, "computer");
}

function memo<S extends { readonly controller: Controller }>(client: Client, workspaceId: string, noun: "browser" | "computer"): LiveSource<S> {
  let byKey = sources.get(client);
  if (!byKey) sources.set(client, (byKey = new Map()));
  const key = `${noun}:${workspaceId}`;
  const found = byKey.get(key);
  if (found) return found as unknown as LiveSource<S>;
  const made = create<S>(client, workspaceId, noun);
  byKey.set(key, made as unknown as LiveSource<never>);
  return made;
}

function create<S extends { readonly controller: Controller }>(client: Client, workspace_id: string, noun: "browser" | "computer"): LiveSource<S> {
  const frames = new Set<(f: LiveFrame) => void>();
  const states = new Set<(s: S) => void>();
  const pointers = new Set<(p: LivePointer) => void>();
  const losses = new Set<() => void>();
  let state: S | null = null;
  let offs: Array<() => void> = [];
  /** Who wants frames, and how many a second each. */
  const holders = new Map<object, number>();
  let queue: InputEvent[] = [];
  let raf = 0;
  const ours = (p: { workspace_id: string }) => p.workspace_id === workspace_id;

  // Subscribed on the runtime only while someone listens; the last state is kept across gaps.
  const listen = <T>(set: Set<(v: T) => void>, listener: (v: T) => void) => {
    if (frames.size + states.size + pointers.size === 0) {
      offs = [
        client.on(`${noun}.frame`, (f) => ours(f) && frames.forEach((l) => l(f))),
        client.on(`${noun}.state`, (s) => {
          if (!ours(s)) return;
          state = s as unknown as S;
          states.forEach((l) => l(state!));
        }),
        client.on(`${noun}.pointer`, (p) => ours(p) && pointers.forEach((l) => l(p))),
      ];
    }
    set.add(listener);
    return () => {
      if (!set.delete(listener) || frames.size + states.size + pointers.size > 0) return;
      offs.forEach((off) => off());
      offs = [];
    };
  };

  const flush = () => {
    raf = 0;
    const events = queue;
    queue = [];
    if (events.length === 0) return;
    // browser.state doesn't say which connection holds the screen; a refused batch is how this one learns it lost it.
    void client.call(`${noun}.input`, { request_id: crypto.randomUUID(), workspace_id, events }).catch((error: unknown) => {
      if (!isRefusal(error)) return;
      drop();
      losses.forEach((l) => l());
    });
  };
  const drop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    queue = [];
  };

  // The runtime streams one screencast per connection and screen, so every holder shares it at the fastest rate.
  const screencast = () =>
    client.call(`${noun}.screencast`, { workspace_id, enabled: true, max_fps: Math.max(...holders.values()) }).then(
      () => "live" as const,
      (error: unknown) => {
        if (isUnsupported(error)) return "unavailable" as const;
        throw error;
      },
    );

  return {
    noun,
    get state() {
      return state;
    },
    start: (holder, maxFps) => {
      holders.set(holder, maxFps);
      return screencast();
    },
    stop: (holder) => {
      if (!holders.delete(holder)) return;
      if (holders.size > 0) {
        void screencast().catch(() => undefined);
        return;
      }
      drop();
      void client.call(`${noun}.screencast`, { workspace_id, enabled: false }).catch(() => undefined);
    },
    onFrame: (l) => listen(frames, l),
    onState: (l) => listen(states, l),
    onPointer: (l) => listen(pointers, l),
    onControlLost: (l) => {
      losses.add(l);
      return () => losses.delete(l);
    },
    control: (controller) => {
      if (controller === "agent") drop();
      return client.call(`${noun}.control`, { request_id: crypto.randomUUID(), workspace_id, controller }).then((r) => r.controller);
    },
    input: (...events) => {
      for (const e of events) coalesce(queue, e);
      if (!raf && queue.length > 0) raf = requestAnimationFrame(flush);
    },
  };
}
