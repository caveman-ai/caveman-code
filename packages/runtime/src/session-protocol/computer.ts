// Session Protocol computer.* over a workspace computer's screen: a Cloud computer's desktop (desktop.ts), or on a
// Mac the app window each chat's agent uses (macDesktop/service.ts). The screen goes to a connection only while it
// has the Computer surface open (computer.screencast): a frame after each of the agent's actions, then about one a
// second, or five while a person holds a Cloud desktop; an unchanged frame is not sent again. Take over
// (computer.control) is the person's: on a Cloud computer it starts the desktop if nothing has yet and only the
// connection that took it may send input; on a Mac it pauses the chat's agent and brings its app forward, and the
// person uses their own mouse. Either way it goes back to the agent when that connection drops. Every connection
// hears when the agent acts (computer.state with active).
import type { ComputerAccess, Params } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import { Desktop, DesktopError, type Shot } from "./desktop.ts";
import { ProtocolError } from "./handlers.ts";
import { ACTIVE_NOTICE_MS, type BrowserConnection } from "./browser.ts";
import { MacDesktop } from "./macDesktop/service.ts";
import type { ScreenChange, ScreenPointer, Screens } from "./screens.ts";
import type { WorkspaceRecord } from "./store.ts";

/** Frame gaps: watching, and while a person drives. */
const WATCH_MS = 1000;
const DRIVE_MS = 200;
/** A client this many messages behind skips frames until it catches up. */
const MAX_FRAME_BACKLOG = 8;

interface Viewer<C> {
  readonly connection: C;
  readonly workspaceId: string;
  minGapMs: number;
  lastAt: number;
  last: Buffer | undefined;
}

const fail = (reason: string, message: string) => Effect.fail(new ProtocolError({ reason, message, ...(reason === "unsupported" ? { capability: "computer" } : {}) }));
const protocolError = (error: DesktopError) =>
  new ProtocolError({
    reason: error.reason === "failed" ? "internal" : error.reason,
    message: error.message,
    ...(error.reason === "unsupported" ? { capability: "computer" } : {}),
  });

const NO_LOCAL = "Computer use runs on a Mac or a Cloud computer; this computer has neither.";
const noAccess = (reason: string): ComputerAccess => ({ supported: false, reason, accessibility: "unknown", screen_recording: "unknown", blocked: [] });

/** A Cloud computer's one Linux desktop, every workspace's screen. */
const cloudScreens = (desktop: Desktop["Service"]): Screens => {
  const running = () => desktop.running();
  return {
    available: desktop.available.pipe(
      Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(new DesktopError({ reason: "unsupported", message: "This computer's image has no desktop yet. It updates the next time it wakes." })))),
    ),
    screenOf: () => (running() ? "desktop" : undefined),
    capture: () => desktop.capture("jpeg"),
    // A person holds the desktop from the moment they take over, while it is still starting too.
    state: () => {
      const up = running();
      return { controller: desktop.holder() !== undefined ? "user" : !up ? "none" : "agent", width: up ? 1280 : 0, height: up ? 800 : 0 };
    },
    holder: () => desktop.holder(),
    heldBy: (connectionId) => (desktop.holder() === connectionId ? ["desktop"] : []),
    // Taking over is using it: the desktop starts if nothing has started it yet.
    take: (_, connectionId) => desktop.hold(connectionId).pipe(Effect.andThen(desktop.start.pipe(Effect.catch((error) => desktop.hold(undefined).pipe(Effect.andThen(Effect.fail(error))))))),
    release: () => desktop.hold(undefined),
    input: (_, events) => desktop.input(events),
    gapMs: () => (desktop.holder() !== undefined ? DRIVE_MS : WATCH_MS),
    changes: desktop.changes as PubSub.PubSub<ScreenChange>,
    access: Effect.succeed(noAccess("A Cloud computer's agents use its own Linux desktop (the Computer tab).")),
    guide: Effect.fail(new DesktopError({ reason: "unsupported", message: "A Cloud computer has no macOS permissions to grant." })),
  };
};

export const makeComputer = <C extends BrowserConnection & { readonly principal?: string }>(options: {
  readonly recordByWorkspace: (id: string) => Effect.Effect<WorkspaceRecord, ProtocolError>;
  /** The Session Protocol workspace an engine thread belongs to, if any. */
  readonly workspaceOfThread: (threadId: string) => Effect.Effect<string | undefined>;
  readonly notify: (connection: C, method: string, params: unknown) => unknown;
  /** Every open connection, for the state that tells a client the screen came up. */
  readonly connections: () => Iterable<C>;
}) =>
  Effect.gen(function* () {
    const cloud = Option.getOrUndefined(yield* Effect.serviceOption(Desktop));
    const mac = Option.getOrUndefined(yield* Effect.serviceOption(MacDesktop));
    // A Cloud computer's desktop is a Desktop that can start; elsewhere Desktop is there but refuses every start.
    // On a Mac with computer use, its apps; elsewhere the Desktop, which on a computer without one refuses every start.
    const screens: Screens | undefined = mac?.screens ?? (cloud ? cloudScreens(cloud) : undefined);
    const scope = yield* Effect.scope;
    const viewers = new Map<string, Viewer<C>>();
    /** Connections that closed: a Take over still in flight for one (handlers outlive their socket) must not hold a screen. */
    const closed = new WeakSet<C>();
    /** Workspaces whose clients heard that the agent is using the screen, since it came up. */
    const announced = new Set<string>();
    /** When each workspace's clients last heard the agent act on the screen. */
    const noticed = new Map<string, number>();
    let ticking = false;
    let seq = 0;
    const key = (connectionId: string, workspaceId: string) => `${connectionId}\0${workspaceId}`;
    const state = (workspaceId: string) => ({ workspace_id: workspaceId, ...(screens?.state(workspaceId) ?? { controller: "none" as const, width: 0, height: 0 }) });

    const send = (viewer: Viewer<C>, shot: Shot, force: boolean) => {
      const now = Date.now();
      if (!force && (now - viewer.lastAt < viewer.minGapMs || (viewer.last !== undefined && viewer.last.equals(shot.data)))) return;
      if (viewer.connection.outbox.size() > MAX_FRAME_BACKLOG) return;
      viewer.lastAt = now;
      viewer.last = shot.data;
      options.notify(viewer.connection, "computer.frame", {
        workspace_id: viewer.workspaceId,
        mime_type: shot.mimeType,
        data: shot.data.toString("base64"),
        width: shot.width,
        height: shot.height,
      });
    };
    const pointerAt = (pointer: ScreenPointer, shot: Shot) => ("fx" in pointer ? { x: Math.round(pointer.fx * shot.width), y: Math.round(pointer.fy * shot.height), phase: pointer.phase } : pointer);

    /** Frames while anyone watches a screen; one loop however many watch, one capture per screen. */
    const tick: Effect.Effect<void> = Effect.suspend(() => {
      const byScreen = new Map<string, Array<Viewer<C>>>();
      for (const viewer of viewers.values()) {
        const screen = screens?.screenOf(viewer.workspaceId);
        if (screen !== undefined) byScreen.set(screen, [...(byScreen.get(screen) ?? []), viewer]);
      }
      if (!screens || byScreen.size === 0) {
        ticking = false;
        return Effect.void;
      }
      const watched = [...byScreen.values()];
      return Effect.forEach(
        watched,
        (group) =>
          screens.capture(group[0]!.workspaceId).pipe(
            Effect.tap((shot) => Effect.sync(() => group.forEach((viewer) => send(viewer, shot, false)))),
            Effect.ignore,
          ),
        { discard: true },
      ).pipe(
        Effect.andThen(Effect.suspend(() => Effect.sleep(Math.min(...watched.map((group) => screens.gapMs(group[0]!.workspaceId)))))),
        Effect.andThen(tick),
      );
    });
    const kick = () => {
      if (ticking || !screens || viewers.size === 0) return Effect.void;
      ticking = true;
      return tick.pipe(Effect.forkIn(scope), Effect.asVoid);
    };

    if (screens) {
      yield* PubSub.subscribe(screens.changes).pipe(
        Effect.flatMap((sub) =>
          Effect.forever(
            PubSub.take(sub).pipe(
              Effect.flatMap((change) =>
                Effect.gen(function* () {
                  // The desktop app shows its guide panel over System Settings: every window of this computer hears it.
                  if (change.type === "guide") {
                    for (const connection of options.connections()) {
                      if (connection.principal === undefined || connection.principal === "local") options.notify(connection, "computer.guide", change.permission ? { permission: change.permission } : {});
                    }
                    return;
                  }
                  if (change.type === "state") {
                    for (const workspaceId of [...announced]) if (screens.screenOf(workspaceId) === undefined) announced.delete(workspaceId);
                    for (const viewer of viewers.values()) {
                      if (change.workspaceId === undefined || change.workspaceId === viewer.workspaceId) options.notify(viewer.connection, "computer.state", state(viewer.workspaceId));
                    }
                    return yield* kick();
                  }
                  const workspaceId = yield* options.workspaceOfThread(change.threadId);
                  // A Mac's screen is the acting chat's own; a Cloud desktop's every workspace's.
                  const watching = [...viewers.values()].filter((viewer) => change.shot !== undefined || viewer.workspaceId === workspaceId);
                  if (watching.length > 0) {
                    const shot = change.shot ?? Option.getOrUndefined(yield* screens.capture(workspaceId!).pipe(Effect.option));
                    for (const viewer of watching) {
                      // A Mac chat's first action can be on another app than the screen it showed: its state says which.
                      if (change.shot === undefined) options.notify(viewer.connection, "computer.state", state(viewer.workspaceId));
                      if (shot === undefined) continue;
                      send(viewer, shot, true);
                      if (change.pointer) options.notify(viewer.connection, "computer.pointer", { workspace_id: viewer.workspaceId, ...pointerAt(change.pointer, shot), seq: ++seq });
                    }
                    yield* kick();
                  }
                  // Every client learns the agent is using the screen: at most once per ACTIVE_NOTICE_MS per workspace, and
                  // the first time since it came up with reveal (a quiet Computer tab, the screen floating).
                  if (workspaceId === undefined) return;
                  const reveal = !announced.has(workspaceId);
                  const now = Date.now();
                  if (!reveal && now - (noticed.get(workspaceId) ?? -Infinity) < ACTIVE_NOTICE_MS) return;
                  announced.add(workspaceId);
                  noticed.set(workspaceId, now);
                  for (const connection of options.connections()) options.notify(connection, "computer.state", { ...state(workspaceId), active: true, ...(reveal ? { reveal: true } : {}) });
                }),
              ),
            ),
          ),
        ),
        Effect.forkIn(scope),
      );
    }

    const services = Effect.suspend(() => (screens ? Effect.succeed(screens) : fail("unsupported", "The desktop is on Cloud computers; this computer has none.")));
    const live = (workspaceId: string) =>
      options.recordByWorkspace(workspaceId).pipe(
        Effect.flatMap((record) => (record.workspace.status === "archived" ? fail("invalid_state", "the workspace is archived") : Effect.succeed(record))),
      );

    const handlers = {
      "computer.screencast": (p: Params<"computer.screencast">, connection: C) =>
        Effect.gen(function* () {
          const record = yield* live(p.workspace_id);
          const at = key(connection.id, record.workspace.id);
          if (!p.enabled) {
            viewers.delete(at);
            return {};
          }
          const screens = yield* services;
          yield* screens.available.pipe(Effect.mapError(protocolError));
          const viewer: Viewer<C> = viewers.get(at) ?? { connection, workspaceId: record.workspace.id, minGapMs: 0, lastAt: 0, last: undefined };
          viewer.minGapMs = p.max_fps ? 1000 / p.max_fps : 0;
          viewer.last = undefined;
          viewers.set(at, viewer);
          // Live view rule: the current state, and the screen now when there is one.
          options.notify(connection, "computer.state", state(record.workspace.id));
          if (screens.screenOf(record.workspace.id) !== undefined) {
            const shot = yield* screens.capture(record.workspace.id).pipe(Effect.option);
            if (Option.isSome(shot)) send(viewer, shot.value, true);
          }
          yield* kick();
          return {};
        }),
      "computer.control": (p: Params<"computer.control">, connection: C) =>
        Effect.gen(function* () {
          const record = yield* live(p.workspace_id);
          const screens = yield* services;
          const workspaceId = record.workspace.id;
          if (p.controller === "agent") {
            if (screens.holder(workspaceId) === connection.id) yield* screens.release(workspaceId);
            return { controller: screens.state(workspaceId).controller };
          }
          const holder = screens.holder(workspaceId);
          if (holder !== undefined && holder !== connection.id) return yield* fail("user_in_control", "another window controls this screen");
          yield* screens.take(workspaceId, connection.id).pipe(Effect.mapError(protocolError));
          // Closed while this waited (its chat's lane, the read above): closeConnection found nothing to hand back.
          if (closed.has(connection)) {
            if (screens.holder(workspaceId) === connection.id) yield* screens.release(workspaceId);
            return yield* fail("invalid_state", "the connection closed");
          }
          return { controller: "user" as const };
        }),
      "computer.input": (p: Params<"computer.input">, connection: C) =>
        Effect.gen(function* () {
          const record = yield* live(p.workspace_id);
          const screens = yield* services;
          const holder = screens.holder(record.workspace.id);
          if (holder !== connection.id) {
            return yield* holder === undefined ? fail("invalid_state", "take control with computer.control first") : fail("user_in_control", "another window controls this screen");
          }
          yield* screens.input(record.workspace.id, p.events).pipe(Effect.mapError(protocolError));
          return {};
        }),
      "computer.access": () => (screens ? screens.access : Effect.succeed(noAccess(NO_LOCAL))),
      "computer.access.guide": (_: Params<"computer.access.guide">, connection: C) =>
        connection.principal !== undefined && connection.principal !== "local"
          ? fail("forbidden", "System Settings opens on this Mac's own screen only.")
          : screens
            ? screens.guide.pipe(Effect.mapError(protocolError), Effect.as({}))
            : fail("unsupported", NO_LOCAL),
    };

    /**
     * A dropped connection stops watching and hands back every screen it held. Marking it closed and reading the
     * holders happen in one step, so a Take over in flight either sees the mark or is a holder read here.
     */
    const closeConnection = (connection: C) =>
      Effect.suspend(() => {
        closed.add(connection);
        for (const [at, viewer] of viewers) if (viewer.connection === connection) viewers.delete(at);
        return screens ? Effect.forEach(screens.heldBy(connection.id), (workspaceId) => screens.release(workspaceId), { discard: true }) : Effect.void;
      });

    return { handlers, closeConnection };
  });
