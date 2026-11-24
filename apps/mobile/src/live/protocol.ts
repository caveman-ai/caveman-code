// The agent's browser and computer as Session Protocol carries them (packages/session-protocol/src/protocol.ts, the
// browser.* and computer.* methods and notifications), field for field, and the LiveSource the desktop's live view
// draws from (apps/web/src/panels/live/source.ts). The phone has no runtime client yet, so it mirrors these instead of
// importing them; everything that shows a screen (the floating row's pills, the title's long press, the screen sheet)
// is written only against them. The script's sources stand in for the runtime (live/scripted.ts); a client's
// `browserSource(client, workspaceId)` and `computerSource(...)` drop in where they are.

import type { DrawnScreen } from "../board/model";
import type { PageState } from "./pages";

export type Screen = "browser" | "computer";

/** Who drives the screen: the agent, a person (on some connection), or nobody yet. */
export type Controller = "agent" | "user" | "none";

/** `browser.state`: sent on navigation, load and a change of controller. */
export interface BrowserState {
  workspace_id: string;
  url: string;
  title: string;
  loading: boolean;
  can_go_back: boolean;
  can_go_forward: boolean;
  controller: Controller;
  /** The agent opened a page and asked to show it. */
  reveal?: true;
  /** The agent just used its browser (every few seconds while it keeps at it). */
  active?: true;
}

/**
 * `computer.state`: a Cloud computer's desktop, or on a Mac the window of the app the chat's agent used last (agent-
 * desktop), at its size. On a Mac, Take over pauses the agent and brings its app forward there, and `computer.input` is
 * unsupported: the person uses that Mac's own mouse.
 */
export interface ComputerState {
  workspace_id: string;
  controller: Controller;
  width: number;
  height: number;
  /** This Mac: the app the frames show. Absent on a Cloud computer and before any. */
  app?: { name: string; bundle_id?: string };
  /** The agent started on the desktop. */
  reveal?: true;
  /** The agent just acted on the desktop (every few seconds while it keeps at it). */
  active?: true;
}

export type ScreenState = BrowserState | ComputerState;

/** `browser.pointer` / `computer.pointer`: the agent's cursor as it acts, in frame pixels; `seq` orders them. */
export interface LivePointer {
  workspace_id: string;
  x: number;
  y: number;
  phase: "move" | "click" | "type";
  seq: number;
}

/** One event of `browser.input` / `computer.input`, in frame pixels; `modifiers` is CDP's bitmask (alt 1, ctrl 2, meta 4, shift 8). */
export type InputEvent =
  | { type: "pointer"; action: "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right"; modifiers: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number; modifiers: number }
  | { type: "key"; action: "down" | "up"; key: string; code: string; modifiers: number }
  | { type: "text"; text: string };

/** `browser.frame` / `computer.frame`: the screen as an image (base64), at its own size. */
export interface ImageFrame {
  workspace_id: string;
  mime_type: string;
  data: string;
  width: number;
  height: number;
}

/** The script's frame: the drawing that stands in for the image, in the state the page is in. */
export interface DrawnFrame {
  workspace_id: string;
  drawn: DrawnScreen;
  page: PageState;
  width: number;
  height: number;
}

export type LiveFrame = ImageFrame | DrawnFrame;

/** One of the agent's screens a view can watch and drive (the desktop's LiveSource, with the last frame kept). */
export interface LiveSource<S extends ScreenState = ScreenState> {
  readonly screen: Screen;
  /** The last state the runtime sent, null before the first. */
  readonly state: S | null;
  /** The last frame, null before the first. */
  readonly frame: LiveFrame | null;
  /**
   * `*.screencast` on while any holder wants frames, at the fastest rate one asks for. Resolves "unavailable" when the
   * runtime can't stream this screen (a Mac has no desktop to stream).
   */
  start(holder: object, maxFps: number): Promise<"live" | "unavailable">;
  /** Let go of the frames; when the last holder lets go the screencast stops. */
  stop(holder: object): void;
  onFrame(listener: (frame: LiveFrame) => void): () => void;
  onState(listener: (state: S) => void): () => void;
  onPointer(listener: (pointer: LivePointer) => void): () => void;
  /** `*.control`: take the screen (`user`) or hand it back (`agent`). Resolves to who drives now. */
  control(controller: "user" | "agent"): Promise<Controller>;
  /** `*.input`, refused by the runtime unless this connection holds the screen. */
  input(...events: InputEvent[]): void;
}
