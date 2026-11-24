// Session Protocol browser.* on upstream server browser (preview/ServerBrowser):
// one headless tab per workspace (a T3 preview session on the workspace's
// thread: the one the agent last asked to show, else the newest), one viewer
// per connection and workspace. Frames, control and the agent's cursor come
// from the viewer; URL and history from the preview manager's events. When
// the agent opens a page and asks to show it, every connection hears so
// (browser.state with reveal) and viewers follow it to that tab; while the
// agent keeps using its browser, every connection hears that too (browser.state
// with active, at most every few seconds per workspace). Navigating
// or taking control acts as the user, which upstream SessionControl puts ahead of
// the agent until control is handed back or the connection drops. A page's
// dialog rides on browser.state, and the person holding control answers it
// with browser.input. When the watched tab closes (the agent's preview_close, the
// idle sweep), a window streaming it moves to the workspace's tab that is left,
// or hears the browser is empty (about:blank) and streams the next tab opened.
import { ThreadId, type PreviewSessionSnapshot } from "@caveman-app/protocol";
import type { NotificationParams, Params } from "@caveman-app/session-protocol";
import { normalizePreviewUrl } from "@caveman-app/shared/preview";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as PreviewManager from "../preview/Manager.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import { ProtocolError } from "./handlers.ts";
import type { WorkspaceRecord } from "./store.ts";

type Controller = "agent" | "user" | "none";
type Dialog = NonNullable<NotificationParams<"browser.state">["dialog"]>;
const DIALOG_TYPES = ["alert", "confirm", "prompt", "beforeunload"] as const;
/** upstream page dialog as browser.state carries it; Chromium has no other kinds. */
const toDialog = (dialog: { readonly type: string; readonly message: string; readonly defaultValue: string }): Dialog => ({
  type: DIALOG_TYPES.find((type) => type === dialog.type) ?? "alert",
  message: dialog.message,
  default_value: dialog.defaultValue,
});

interface Viewer {
  readonly scope: Scope.Closeable;
  readonly handle: ServerBrowser.ServerBrowserViewer;
  readonly threadId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  /** Attached with canOperate; a passive viewer never takes control (T3 auto-takes on attach). */
  readonly operate: boolean;
  streaming: boolean;
  minFrameMs: number;
  lastFrameAt: number;
  controller: Controller;
  /** The page's dialog waiting for an answer, as the tab last told this viewer. */
  dialog: Dialog | undefined;
  /** Page CSS size. Frames are reported in it whatever the JPEG's size, so input arrives in CSS pixels. */
  viewport: { width: number; height: number } | undefined;
  /** The newest frame, sent at once or on the trailing edge of a throttle, and again when a screencast turns on. */
  latest: Uint8Array | undefined;
  pending: boolean;
  /** A trailing-edge send is scheduled. */
  waiting: boolean;
}

/** Width and height from a JPEG's start-of-frame marker. */
export const jpegSize = (data: Uint8Array): { width: number; height: number } | undefined => {
  let i = 2;
  while (i + 8 < data.length && data[i] === 0xff) {
    const marker = data[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (data[i + 5]! << 8) | data[i + 6]!, width: (data[i + 7]! << 8) | data[i + 8]! };
    }
    i += 2 + ((data[i + 2]! << 8) | data[i + 3]!);
  }
  return undefined;
};

const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;
/** A client behind this many unsent messages gets the newest frame once it catches up. */
const MAX_FRAME_BACKLOG = 8;
const BACKLOG_RETRY_MS = 100;
/** browser.state `active` goes out at most this often per workspace; clients keep the browser shown as in use for longer. */
export const ACTIVE_NOTICE_MS = 3_000;

const fail = (reason: string, message: string, extra: { capability?: string; retryAfterMs?: number } = {}) =>
  Effect.fail(new ProtocolError({ reason, message, ...extra }));

export interface BrowserConnection {
  readonly id: string;
  readonly outbox: { size(): number };
}

export const makeBrowser = <C extends BrowserConnection>(options: {
  readonly recordByWorkspace: (id: string) => Effect.Effect<WorkspaceRecord, ProtocolError>;
  /** The Session Protocol workspace an engine thread belongs to, if any. */
  readonly workspaceOfThread: (threadId: string) => Effect.Effect<string | undefined>;
  readonly notify: (connection: C, method: string, params: unknown) => unknown;
  /** Every open connection, for the state that tells a client the agent is showing its browser. */
  readonly connections: () => Iterable<C>;
}) =>
  Effect.gen(function* () {
    const browser = yield* Effect.serviceOption(ServerBrowser.ServerBrowser);
    const manager = yield* Effect.serviceOption(PreviewManager.PreviewManager);
    const scope = yield* Effect.scope;
    const viewers = new Map<string, { connection: C; viewer: Viewer }>();
    /** Connections that closed: a call still in flight for one must not leave a viewer behind. */
    const closed = new WeakSet<C>();
    // ponytail: one lock for every attach; per-viewer locks if many windows attach at once.
    const attachLock = yield* Semaphore.make(1);
    const openLock = yield* Semaphore.make(1);
    /** The latest preview snapshot per thread and tab, for browser.state. */
    const snapshots = new Map<string, PreviewSessionSnapshot>();
    /** The tab the agent last asked to show, per thread. */
    const shown = new Map<string, string>();
    /** Connections streaming a workspace whose every tab closed, by key: the next tab opened there streams to them. */
    const waiting = new Map<string, { connection: C; workspaceId: string; minFrameMs: number }>();
    const key = (connectionId: string, workspaceId: string) => `${connectionId}\0${workspaceId}`;
    const tabKey = (threadId: string, tabId: string) => `${threadId}\0${tabId}`;

    const services = Effect.gen(function* () {
      if (Option.isNone(browser) || Option.isNone(manager)) {
        return yield* fail("unsupported", "this runtime has no browser", { capability: "browser" });
      }
      return { browser: browser.value, manager: manager.value };
    });

    /** A tab's state; only a viewer of the tab hears its dialog. */
    const stateOf = (workspaceId: string, threadId: string, tabId: string, controller: Controller, dialog?: Dialog) => {
      const snapshot = snapshots.get(tabKey(threadId, tabId));
      const nav = snapshot?.navStatus;
      return {
        workspace_id: workspaceId,
        url: nav && nav._tag !== "Idle" ? nav.url : "about:blank",
        title: nav && nav._tag !== "Idle" ? nav.title : "",
        loading: nav?._tag === "Loading",
        can_go_back: snapshot?.canGoBack ?? false,
        can_go_forward: snapshot?.canGoForward ?? false,
        controller,
        ...(dialog ? { dialog } : {}),
      };
    };
    const viewerState = (viewer: Viewer) => stateOf(viewer.workspaceId, viewer.threadId, viewer.tabId, viewer.controller, viewer.dialog);
    const pushState = (connection: C, viewer: Viewer) => options.notify(connection, "browser.state", viewerState(viewer));

    // URL, title, loading and history follow the manager's events; a fresh reveal (the agent's preview_open) is told to every connection.
    if (Option.isSome(manager)) {
      yield* manager.value.subscribeEvents.pipe(
        Effect.flatMap((sub) =>
          Effect.forever(
            PubSub.take(sub).pipe(
              Effect.flatMap((event) => {
                const at = tabKey(event.threadId, event.tabId);
                if (event.type === "closed") {
                  snapshots.delete(at);
                  if (shown.get(event.threadId) === event.tabId) shown.delete(event.threadId);
                  return Effect.void;
                }
                if (event.type === "failed") return Effect.void;
                const ask = event.snapshot.runtime === "server" ? event.snapshot.revealRequest : undefined;
                const fresh = ask !== undefined && ask.id !== snapshots.get(at)?.revealRequest?.id;
                snapshots.set(at, event.snapshot);
                for (const { connection, viewer } of viewers.values()) {
                  if (tabKey(viewer.threadId, viewer.tabId) === at) pushState(connection, viewer);
                }
                if (fresh) return reveal(event.threadId, event.tabId).pipe(Effect.forkIn(scope), Effect.asVoid);
                return event.snapshot.runtime === "server" && waiting.size > 0 ? resumeWaiting(event.threadId).pipe(Effect.forkIn(scope), Effect.asVoid) : Effect.void;
              }),
            ),
          ),
        ),
        Effect.forkIn(scope),
      );
    }

    // The agent using its browser is told to every connection, at most once per ACTIVE_NOTICE_MS per workspace. A window
    // watching the workspace hears the tab it watches, never yanked to another; the rest hear the tab the agent used.
    if (Option.isSome(browser)) {
      const noticed = new Map<string, number>();
      yield* PubSub.subscribe(browser.value.agentActivity).pipe(
        Effect.flatMap((sub) =>
          Effect.forever(
            PubSub.take(sub).pipe(
              Effect.flatMap(({ threadId, tabId }) =>
                Effect.gen(function* () {
                  const workspaceId = yield* options.workspaceOfThread(threadId);
                  const now = Date.now();
                  if (workspaceId === undefined || now - (noticed.get(workspaceId) ?? -Infinity) < ACTIVE_NOTICE_MS) return;
                  noticed.set(workspaceId, now);
                  for (const connection of options.connections()) {
                    const viewer = viewers.get(key(connection.id, workspaceId))?.viewer;
                    const state = viewer ? viewerState(viewer) : stateOf(workspaceId, threadId, tabId, controllerOf(workspaceId));
                    options.notify(connection, "browser.state", { ...state, active: true });
                  }
                }),
              ),
            ),
          ),
        ),
        Effect.forkIn(scope),
      );
    }

    /** The workspace's server tab, never `except` (a tab that just closed, which the manager may still list). */
    const serverTab = (record: WorkspaceRecord, except?: string) =>
      Effect.gen(function* () {
        const { manager } = yield* services;
        const { sessions } = yield* manager.list({ threadId: ThreadId.make(record.internal.threadId) });
        const server = sessions.filter((s) => s.runtime === "server" && s.tabId !== except);
        return server.find((s) => s.tabId === shown.get(record.internal.threadId)) ?? server.at(-1);
      });
    const existingTab = (record: WorkspaceRecord) => serverTab(record).pipe(Effect.map((tab) => tab?.tabId));

    /** Which tab a viewer takes: `except` never (a tab that just closed); `existing` fails rather than open one. */
    interface Target {
      readonly url?: string;
      readonly except?: string;
      readonly existing?: boolean;
    }

    /** The workspace's server tab, opened (at `url`, else empty) when it has none, unless only an existing one will do. */
    const tabFor = (record: WorkspaceRecord, { url, except, existing: only }: Target = {}) =>
      openLock.withPermits(1)(Effect.gen(function* () {
        const { manager } = yield* services;
        const threadId = ThreadId.make(record.internal.threadId);
        const existing = yield* serverTab(record, except);
        if (existing === undefined && only) return yield* fail("not_found", "the workspace has no browser tab");
        const snapshot = existing ?? (yield* manager.open({ threadId, runtime: "server", ...(url ? { url: yield* normalized(url) } : {}) }).pipe(
          Effect.mapError((error) => new ProtocolError({ reason: "invalid_params", message: error.message })),
        ));
        snapshots.set(tabKey(snapshot.threadId, snapshot.tabId), snapshot);
        return { tabId: snapshot.tabId, opened: existing === undefined };
      }));

    /**
     * Sends the newest frame now, or once max_fps or the client's backlog allows,
     * so the last change on a page that then stops repainting always arrives.
     */
    const flush = (connection: C, viewer: Viewer): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (!viewer.streaming || !viewer.pending || viewer.waiting || !viewer.latest) return Effect.void;
        const wait = Math.max(viewer.lastFrameAt + viewer.minFrameMs - Date.now(), connection.outbox.size() > MAX_FRAME_BACKLOG ? BACKLOG_RETRY_MS : 0);
        if (wait > 0) {
          viewer.waiting = true;
          return Effect.sleep(wait).pipe(
            Effect.andThen(Effect.suspend(() => ((viewer.waiting = false), flush(connection, viewer)))),
            Effect.forkIn(viewer.scope),
            Effect.asVoid,
          );
        }
        viewer.pending = false;
        viewer.lastFrameAt = Date.now();
        const size = viewer.viewport ?? jpegSize(viewer.latest) ?? { width: 0, height: 0 };
        options.notify(connection, "browser.frame", {
          workspace_id: viewer.workspaceId,
          mime_type: "image/jpeg",
          data: Buffer.from(viewer.latest).toString("base64"),
          width: size.width,
          height: size.height,
        });
        return Effect.void;
      });

    const pump = (connection: C, viewer: Viewer) =>
      Effect.forever(
        Queue.take(viewer.handle.output).pipe(
          Effect.flatMap((out) => {
            switch (out._tag) {
              case "frame":
                // Acked at once either way, so Chromium keeps the newest frame coming.
                viewer.latest = out.data;
                viewer.pending = true;
                return flush(connection, viewer).pipe(Effect.andThen(out.ack));
              case "viewport":
                return Effect.sync(() => void (viewer.viewport = { width: out.width, height: out.height }));
              case "control":
                return Effect.sync(() => {
                  viewer.controller = out.controller === "you" || out.controller === "another-viewer" ? "user" : "agent";
                  viewer.dialog = out.dialog ? toDialog(out.dialog) : undefined;
                  pushState(connection, viewer);
                });
              case "pointer":
                return Effect.sync(() => {
                  if (viewer.streaming) options.notify(connection, "browser.pointer", { workspace_id: viewer.workspaceId, x: out.x, y: out.y, phase: out.phase, seq: out.sequence });
                });
              // Closing the viewer's scope ends this pump, so both run outside it.
              case "gone":
                return follow(connection, viewer).pipe(Effect.forkIn(scope), Effect.asVoid);
              case "reconnect":
                return reattach(connection, viewer).pipe(Effect.forkIn(scope), Effect.asVoid);
              default:
                return Effect.void;
            }
          }),
        ),
      );

    /** A new viewer of the workspace's tab (the same one after a reconnect, the shown one after a reveal), streaming as the old one did. */
    const reattach = (connection: C, viewer: Viewer): Effect.Effect<void> =>
      options.recordByWorkspace(viewer.workspaceId).pipe(
        Effect.flatMap((record) =>
          drop(connection.id, viewer.workspaceId).pipe(
            Effect.andThen(viewerFor(connection, record, viewer.operate)),
            Effect.tap((next) => {
              next.streaming = viewer.streaming;
              next.minFrameMs = viewer.minFrameMs;
              return flush(connection, next);
            }),
          ),
        ),
        Effect.ignore,
      );

    /** Streams `viewer` to its connection: its state and a frame now, then each new frame. */
    const stream = (connection: C, viewer: Viewer, minFrameMs: number) =>
      Effect.suspend(() => {
        viewer.streaming = true;
        viewer.minFrameMs = minFrameMs;
 // Live view rule: the current state and a frame now. A new viewer's first frame is upstream still
        // (an idle page never repaints); a viewer that already had one sends the newest it holds.
        pushState(connection, viewer);
        viewer.pending = true;
        viewer.lastFrameAt = 0;
        return flush(connection, viewer);
      });

    /**
     * Attaches a waiting window to the workspace's existing tab (never `except`, never a new one) and streams it. A window
     * that stopped its screencast during the attach no longer wants frames: the viewer it got goes, unless it took control.
     */
    const attachWaiting = (connection: C, record: WorkspaceRecord, except?: string) =>
      Effect.gen(function* () {
        const viewer = yield* viewerFor(connection, record, false, { existing: true, ...(except === undefined ? {} : { except }) });
        if (viewer.streaming) return yield* stream(connection, viewer, viewer.minFrameMs);
        if (!viewer.handle.controlling()) yield* drop(connection.id, record.workspace.id);
      });

    /**
     * The viewer's tab closed (the agent's preview_close, the idle sweep, a crash). A window streaming it moves to the
     * workspace's tab that is left. With none, or when that tab won't attach, it hears the browser is empty, rather than
     * keeping the closed page's last frame, and the next tab opened there streams to it.
     */
    const follow = (connection: C, viewer: Viewer): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* drop(connection.id, viewer.workspaceId);
        if (closed.has(connection)) return;
        const at = key(connection.id, viewer.workspaceId);
        // Waiting before any lookup: a tab opened meanwhile (a reveal's resumeWaiting) finds this window. closeConnection
        // clears it from here on.
        if (viewer.streaming) waiting.set(at, { connection, workspaceId: viewer.workspaceId, minFrameMs: viewer.minFrameMs });
        const record = yield* options.recordByWorkspace(viewer.workspaceId);
        // The tab left, never a new one; none, or one that won't attach (gone too, its browser down), leaves the window waiting.
        if (waiting.has(at) && Option.isSome(yield* attachWaiting(connection, record, viewer.tabId).pipe(Effect.option))) return;
        // Closed during the lookups, or a tab that opened meanwhile already streams here.
        if (closed.has(connection) || viewers.has(at)) return;
        options.notify(connection, "browser.state", { workspace_id: viewer.workspaceId, url: "about:blank", title: "", loading: false, can_go_back: false, can_go_forward: false, controller: "none" });
      }).pipe(Effect.ignore);

    /** A tab of the thread opened or changed: the windows waiting on its workspace stream it. */
    const resumeWaiting = (threadId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const workspaceId = yield* options.workspaceOfThread(threadId);
        const ready = [...waiting.values()].filter((entry) => entry.workspaceId === workspaceId);
        if (workspaceId === undefined || ready.length === 0) return;
        const record = yield* options.recordByWorkspace(workspaceId);
        // Waiting never opens a tab of its own: after a late event of a closed tab there is still nothing to stream.
        yield* Effect.forEach(
          ready,
          (entry) => (waiting.has(key(entry.connection.id, entry.workspaceId)) ? attachWaiting(entry.connection, record).pipe(Effect.ignore) : Effect.void),
          { discard: true },
        );
      }).pipe(Effect.ignore);

    /**
     * The agent opened a page and asked to show it: that tab becomes the workspace's, windows watching another tab follow
     * it (unless a person drives the one they hold), and every connection gets its state with reveal.
     */
    const reveal = (threadId: string, tabId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const workspaceId = yield* options.workspaceOfThread(threadId);
        if (workspaceId === undefined) return;
        shown.set(threadId, tabId);
        const away = [...viewers.values()].filter(({ viewer }) => viewer.workspaceId === workspaceId && viewer.tabId !== tabId && !viewer.handle.controlling());
        yield* Effect.forEach(away, ({ connection, viewer }) => reattach(connection, viewer), { discard: true });
        yield* resumeWaiting(threadId);
        for (const connection of options.connections()) {
          const viewer = viewers.get(key(connection.id, workspaceId))?.viewer;
          const state = viewer?.tabId === tabId ? viewerState(viewer) : stateOf(workspaceId, threadId, tabId, controllerOf(workspaceId));
          options.notify(connection, "browser.state", { ...state, reveal: true });
        }
      });

    /**
     * Hands the tab a viewer message without waiting for the page, as T3 keeps reading a viewer's socket: input can wait
     * on a page dialog whose answer comes as later input on this connection, and its calls run in order. The tab still
     * takes messages in the order they are sent.
     */
    const send = (viewer: Viewer, message: Record<string, unknown>) =>
      viewer.handle.input(message).pipe(Effect.forkIn(viewer.scope, { startImmediately: true }), Effect.asVoid);

    const drop = (connectionId: string, workspaceId: string) =>
      Effect.suspend(() => {
        const entry = viewers.get(key(connectionId, workspaceId));
        if (!entry) return Effect.void;
        viewers.delete(key(connectionId, workspaceId));
        return Scope.close(entry.viewer.scope, Exit.void);
      });

    /**
     * This connection's viewer of the workspace's tab; `operate` re-attaches a passive one. A connection waiting for a
     * tab (`waiting`) streams the one it gets.
     */
    const viewerFor = (connection: C, record: WorkspaceRecord, operate: boolean, target: Target = {}): Effect.Effect<Viewer, ProtocolError> =>
      attachLock.withPermits(1)(Effect.gen(function* () {
        const { browser } = yield* services;
        const { tabId } = yield* tabFor(record, target);
        const at = key(connection.id, record.workspace.id);
        const current = viewers.get(at)?.viewer;
        if (current && current.tabId === tabId && (current.operate || !operate)) return current;
        const streaming = current?.streaming ?? false;
        const minFrameMs = current?.minFrameMs ?? 0;
        if (current) yield* drop(connection.id, record.workspace.id);
        const viewerScope = yield* Scope.fork(scope);
        const handle = yield* browser
          .attachViewer({ threadId: record.internal.threadId, tabId, maxWidth: 1920, maxHeight: 1080, quality: 70, canOperate: operate })
          .pipe(
            Scope.provide(viewerScope),
            Effect.catchTags({
              ServerBrowserTabNotFoundError: (error) => Scope.close(viewerScope, Exit.void).pipe(Effect.andThen(fail("not_found", error.message))),
              ServerBrowserLaunchError: (error) => Scope.close(viewerScope, Exit.void).pipe(Effect.andThen(launchFailure(error, "start"))),
            }),
          );
        const viewer: Viewer = {
          scope: viewerScope,
          handle,
          threadId: record.internal.threadId,
          tabId,
          workspaceId: record.workspace.id,
          operate,
          streaming,
          minFrameMs,
          lastFrameAt: 0,
          controller: "agent",
          dialog: undefined,
          viewport: undefined,
          latest: undefined,
          pending: false,
          waiting: false,
        };
        yield* pump(connection, viewer).pipe(Effect.forkIn(viewerScope));
        // The connection closed while this attached (handlers outlive it): drop the viewer, and any control it took.
        if (closed.has(connection)) {
          yield* Scope.close(viewerScope, Exit.void);
          return yield* fail("invalid_state", "the connection closed");
        }
        // A window still waiting once the attach succeeds streams this tab; a failed attach leaves it waiting, and one that
        // stopped its screencast meanwhile already left.
        const wanted = current ? undefined : waiting.get(at);
        if (wanted) {
          viewer.streaming = true;
          viewer.minFrameMs = wanted.minFrameMs;
        }
        waiting.delete(at);
        viewers.set(at, { connection, viewer });
        return viewer;
      }));

    /** Takes control for this connection (the user acting); fails when another connection holds it. */
    const takeControl = (connection: C, record: WorkspaceRecord, url?: string) =>
      Effect.gen(function* () {
        const viewer = yield* viewerFor(connection, record, true, url ? { url } : {});
        if (!viewer.handle.controlling()) yield* send(viewer, { type: "takeControl" });
        // Dropped while taking (connection closed, viewer replaced): T3 already let go of it, so hand control back.
        if (viewers.get(key(connection.id, viewer.workspaceId))?.viewer !== viewer) {
          yield* send(viewer, { type: "releaseControl" });
          return yield* fail("invalid_state", "this browser view closed");
        }
        if (!viewer.handle.controlling()) return yield* fail("user_in_control", "another window controls this browser");
        return viewer;
      });

    /** A user holds the tab only through some window's viewer. */
    const controllerOf = (workspaceId: string): Controller =>
      [...viewers.values()].some((entry) => entry.viewer.workspaceId === workspaceId && entry.viewer.handle.controlling()) ? "user" : "agent";

    const live = (workspaceId: string) =>
      options.recordByWorkspace(workspaceId).pipe(
        Effect.flatMap((record) =>
          record.workspace.status === "archived" ? fail("invalid_state", "the workspace is archived") : Effect.succeed(record),
        ),
      );

    const handlers = {
      "browser.screencast": (p: Params<"browser.screencast">, connection: C) =>
        Effect.gen(function* () {
          const record = yield* live(p.workspace_id);
          if (!p.enabled) {
            waiting.delete(key(connection.id, record.workspace.id));
            const entry = viewers.get(key(connection.id, record.workspace.id));
            if (entry?.viewer.handle.controlling()) entry.viewer.streaming = false;
            else yield* drop(connection.id, record.workspace.id);
            return {};
          }
          yield* stream(connection, yield* viewerFor(connection, record, false), p.max_fps ? 1000 / p.max_fps : 0);
          return {};
        }),
      "browser.navigate": (p: Params<"browser.navigate">, connection: C) =>
        Effect.gen(function* () {
          const record = yield* live(p.workspace_id);
          yield* services;
          const url = yield* normalized(p.url);
          const { opened } = yield* tabFor(record, { url });
          if (opened) return {};
          const viewer = yield* takeControl(connection, record);
          yield* send(viewer, { type: "navigate", url });
          return {};
        }),
      "browser.history": (p: Params<"browser.history">, connection: C) =>
        Effect.gen(function* () {
          const viewer = yield* takeControl(connection, yield* live(p.workspace_id));
          yield* send(
            viewer,
            p.action === "reload" ? { type: "reload", ignoreCache: p.ignore_cache === true } : { type: "history", delta: p.action === "back" ? -1 : 1 },
          );
          return {};
        }),
      "browser.control": (p: Params<"browser.control">, connection: C) =>
        Effect.gen(function* () {
          const record = yield* live(p.workspace_id);
          if (p.controller === "user") {
            yield* takeControl(connection, record);
            return { controller: "user" as const };
          }
          const viewer = viewers.get(key(connection.id, record.workspace.id))?.viewer;
          if (viewer?.handle.controlling()) {
            yield* send(viewer, { type: "releaseControl" });
            if (!viewer.streaming) yield* drop(connection.id, record.workspace.id);
          }
          return { controller: controllerOf(record.workspace.id) };
        }),
      "browser.input": (p: Params<"browser.input">, connection: C) =>
        Effect.gen(function* () {
          const record = yield* live(p.workspace_id);
          const viewer = viewers.get(key(connection.id, record.workspace.id))?.viewer;
          if (!viewer?.handle.controlling()) return yield* fail("invalid_state", "take control with browser.control first");
          yield* Effect.forEach(p.events, (event) => send(viewer, toViewerInput(event)), { discard: true });
          return {};
        }),
      "browser.snapshot": (p: Params<"browser.snapshot">) =>
        Effect.gen(function* () {
          const record = yield* live(p.workspace_id);
          const { browser } = yield* services;
          // A read: it never opens a tab (or starts the browser) for a workspace that has none.
          const tabId = yield* existingTab(record);
          if (!tabId) return yield* fail("not_found", "this workspace has no browser tab");
          const shot = yield* browser.snapshot({ threadId: record.internal.threadId, tabId }).pipe(
            Effect.catchTags({
              ServerBrowserTabNotFoundError: (error) => fail("not_found", error.message),
              ServerBrowserLaunchError: (error) => launchFailure(error, "take a snapshot"),
            }),
          );
          return {
            url: shot.url,
            title: shot.title,
            image: { mime_type: shot.screenshot.mimeType, data: shot.screenshot.data },
            refs: typeof shot.accessibilityTree === "string" ? shot.accessibilityTree : JSON.stringify(shot.accessibilityTree),
          };
        }),
    };

    /**
     * Control returns to the agent when the connection that took it drops. Marking it closed and
     * listing its viewers happen in one step, so an attach in flight either sees the mark or is listed.
     */
    const closeConnection = (connection: C) =>
      Effect.suspend(() => {
        closed.add(connection);
        for (const [at, entry] of waiting) if (entry.connection === connection) waiting.delete(at);
        const mine = [...viewers.values()].filter((entry) => entry.connection === connection);
        return Effect.forEach(mine, (entry) => drop(connection.id, entry.viewer.workspaceId), { discard: true });
      });

    /** An archived workspace's tab closes with it. */
    const closeWorkspace = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        for (const [at, entry] of waiting) if (entry.workspaceId === record.workspace.id) waiting.delete(at);
        for (const entry of [...viewers.values()]) if (entry.viewer.workspaceId === record.workspace.id) yield* drop(entry.connection.id, entry.viewer.workspaceId);
        if (Option.isNone(manager)) return;
        const threadId = ThreadId.make(record.internal.threadId);
        const { sessions } = yield* manager.value.list({ threadId });
        for (const session of sessions) yield* manager.value.close({ threadId, tabId: session.tabId }).pipe(Effect.ignore);
      });

    return { handlers, closeConnection, closeWorkspace };
  });

const normalized = (url: string) =>
  Effect.try({
    try: () => normalizePreviewUrl(url),
    catch: () => new ProtocolError({ reason: "invalid_params", message: `not a web address: ${url}` }),
  });

/** Caveman Code's words for a launch failure (upstream own text names T3); upstream detail goes to the log. */
const launchFailure = (error: ServerBrowser.ServerBrowserLaunchError, doing: string) => {
  const tag = (error.cause as { readonly _tag?: unknown } | undefined)?._tag;
  const installing = tag === "PreviewBrowserInstallingError";
  const message = installing
    ? "The browser is still installing (about 100 MB); try again shortly."
    : tag === "PreviewBrowserUnsupportedError"
      ? "The browser is not available on this computer."
      : `The browser could not ${doing}; try again.`;
  return Effect.logWarning("server browser failed", { detail: error.cause instanceof Error ? error.cause.message : error.message }).pipe(
    Effect.andThen(fail("internal", message, installing ? { retryAfterMs: 30_000 } : {})),
  );
};

/** A Session Protocol input event as upstream viewer message; frames are reported in CSS pixels, so coordinates pass through. */
const toViewerInput = (event: Params<"browser.input">["events"][number]): Record<string, unknown> => {
  switch (event.type) {
    case "pointer": {
      const button = event.button ?? (event.action === "move" ? undefined : "left");
      return {
        type: "mouse",
        action: event.action,
        x: event.x,
        y: event.y,
        button: button ?? "none",
        buttons: button && event.action !== "up" ? BUTTON_BITS[button] : 0,
        modifiers: event.modifiers,
      };
    }
    case "wheel":
      return { type: "wheel", x: event.x, y: event.y, deltaX: event.dx, deltaY: event.dy, modifiers: event.modifiers };
    case "key": {
      // Printable keys without ctrl/meta type their character, as a keyboard does.
      const text = event.key === "Enter" ? "\r" : event.key.length === 1 && (event.modifiers & 6) === 0 ? event.key : undefined;
      return { type: "key", action: event.action, key: event.key, code: event.code, modifiers: event.modifiers, ...(text && event.action === "down" ? { text } : {}) };
    }
    case "text":
      return { type: "text", text: event.text };
    case "dialog":
      return { type: "dialog", accept: event.accept, ...(event.text === undefined ? {} : { promptText: event.text }) };
  }
};
