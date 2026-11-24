// What computer.* (computer.ts) streams and hands over: a Cloud computer's one Linux desktop (desktop.ts), or on a
// Mac the app window each chat's agent uses (macDesktop/service.ts). Types only, so neither backend imports the other.
import type { ComputerAccess, Params } from "@caveman-app/session-protocol";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";

import type { DesktopError, Shot } from "./desktop.ts";

/** Where the agent's pointer went: screen pixels (a Cloud desktop), or a fraction of the app window (a Mac). */
export type ScreenPointer =
  | { readonly x: number; readonly y: number; readonly phase: "move" | "click" | "type" }
  | { readonly fx: number; readonly fy: number; readonly phase: "move" | "click" | "type" };

export type ScreenChange =
  /** Started, stopped, taken over or handed back: one workspace's screen, or (no workspaceId) every one. */
  | { readonly type: "state"; readonly workspaceId?: string }
  /** The agent acted: the screen after it when the backend has it already, and where its pointer went. */
  | { readonly type: "acted"; readonly threadId: string; readonly shot?: Shot; readonly pointer?: ScreenPointer }
  /** Show the person where to allow Caveman Code (the desktop app's guide panel), for one permission or both. */
  | { readonly type: "guide"; readonly permission?: "accessibility" | "screen_recording" };

export interface ScreenState {
  readonly controller: "user" | "agent" | "none";
  readonly width: number;
  readonly height: number;
  readonly app?: { readonly name: string; readonly bundle_id?: string };
}

/** One computer's screens. A Cloud computer has one for every workspace; a Mac one per chat (the app it uses). */
export interface Screens {
  /** Fails with the reason when this computer can't show a screen at all. */
  readonly available: Effect.Effect<void, DesktopError>;
  /** The screen a workspace shows now, a key workspaces showing the same one share; undefined while there is none. */
  readonly screenOf: (workspaceId: string) => string | undefined;
  readonly capture: (workspaceId: string) => Effect.Effect<Shot, DesktopError>;
  readonly state: (workspaceId: string) => ScreenState;
  readonly holder: (workspaceId: string) => string | undefined;
  /** The workspaces whose screen a connection holds. */
  readonly heldBy: (connectionId: string) => ReadonlyArray<string>;
  /** The person takes the screen for `connectionId`. */
  readonly take: (workspaceId: string, connectionId: string) => Effect.Effect<void, DesktopError>;
  /** Hands it back to the agent. */
  readonly release: (workspaceId: string) => Effect.Effect<void>;
  readonly input: (workspaceId: string, events: Params<"computer.input">["events"]) => Effect.Effect<void, DesktopError>;
  /** How long between frames while someone watches. */
  readonly gapMs: (workspaceId: string) => number;
  readonly changes: PubSub.PubSub<ScreenChange>;
  /** computer.access, and opening System Settings for it. */
  readonly access: Effect.Effect<ComputerAccess>;
  readonly guide: Effect.Effect<void, DesktopError>;
}
