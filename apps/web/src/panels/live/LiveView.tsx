// ), apps/web/src/browser/ServerBrowserSurface.tsx,
// apps/web/src/components/preview/AgentBrowserCursor.tsx and
// agentBrowserCursorLogic.ts @ ab3a3cd1.
//
// The live view of a remote screen (a LiveSource): frames drawn straight to
// a canvas, letterboxed; the agent's cursor; and the control hand-off. React
// renders on status changes only: frames, cursor moves and input never
// touch state.
//
//   const source = useMemo(() => computerSource(client, workspaceId), [client, workspaceId]);
//   const live = useLive(source, active, useRuntimeClient().connection);
//   <LiveView source={source} live={live} engine="Caveman" />

import { cn } from "@caveman-app/ui/lib/cn";
import { duration, ease } from "@caveman-app/ui/motion";
import { Icon, Cursor02Icon } from "@caveman-app/ui/icons/huge";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { isComposing, matchesChord } from "../chrome.tsx";
import { launcherSurfaces } from "../registry.ts";
import { toBox, toFrame, type Align, type Size } from "./fit.ts";
import { blobOf, modifiers, thumbButton, type Controller, type LiveFrame, type LivePointer, type LiveSource } from "./source.ts";

export type LiveStatus = "starting" | "live" | "unavailable" | "error";

export interface Live<S> {
  readonly status: LiveStatus;
  readonly state: S | null;
  readonly controller: Controller;
  /** This connection holds control; only it may send input. */
  readonly holding: boolean;
  /** The runtime refused this connection's input while it thought it held control: control moved elsewhere. */
  readonly moved: boolean;
  /** The current frame's size, once one has arrived; null while a browser is on no page. */
  readonly frame: Size | null;
  /** Why the last Take over failed, until the next try. */
  readonly controlError: string | null;
  readonly control: (controller: "user" | "agent") => void;
  readonly retry: () => void;
}

/** Frames a second while watching, and while driving (input wants a quick echo). */
const WATCH_FPS = 10;
const DRIVE_FPS = 30;
const CURSOR_ACTIVE_MS = 700;
const WHEEL_LINE_PX = 16;
const BUTTONS = ["left", "middle", "right"] as const;

/** The panel's own chords; with every surface's, they stay with the app while the user drives a remote screen. */
const PANEL_CHORDS = ["mod+alt+b", "mod+t", "mod+p"];

/** The app window is on screen. A minimized or hidden window streams nothing. */
const onVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const windowVisible = () => document.visibilityState === "visible";

const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Streams `source` while `active` and the app window is visible; hiding either, or unmounting, stops the stream and
 * hands back a screen this connection holds (with `holdWhenHidden`, a hidden window keeps it: on This Mac taking over
 * brings the agent's app forward over this window, and the person is using it). `connection` is the runtime's reconnect counter (useRuntimeClient().connection). The runtime forgets a dropped connection's
 * screencast and control, so each new connection starts the stream again, and a screen the user held shows the agent
 * driving until the runtime's next state says otherwise. Listeners need no restart: the client keeps them across sockets.
 */
/** A browser's state on no page; a computer's state never is. */
const onNoPage = (state: object | null): boolean => state !== null && "url" in state && state.url === "about:blank";

export function useLive<S extends { readonly controller: Controller }>(
  source: LiveSource<S> | null,
  active: boolean,
  connection: number,
  { holdWhenHidden = false }: { readonly holdWhenHidden?: boolean } = {},
): Live<S> {
  const [state, setState] = useState<S | null>(() => source?.state ?? null);
  const [status, setStatus] = useState<LiveStatus>("starting");
  const [frame, setFrame] = useState<Size | null>(null);
  const [holding, setHolding] = useState(false);
  // What control() answered, until the runtime's next state says otherwise.
  const [answered, setAnswered] = useState<Controller | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [moved, setMoved] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const visible = useSyncExternalStore(onVisibility, windowVisible, () => true);
  const streaming = visible && active;
  // While this view may hold the screen: losing it hands the screen back.
  const holds = active && (visible || holdWhenHidden);
  // This view's hold on the source's frames, which other views of the same screen share.
  const holder = useRef({}).current;
  const holdingRef = useRef(holding);
  holdingRef.current = holding;
  const statusRef = useRef(status);
  statusRef.current = status;
  const seenConnection = useRef(connection);

  useEffect(() => {
    if (!source) return;
    setState(source.state);
    let size: Size | null = null;
    // A browser on no page (a fresh tab, or the agent closed its own) streams a white page. Its frames don't count, and the
    // view stays hidden until the next page's own first frame, never showing the page before it.
    let blank = onNoPage(source.state);
    const offs = [
      source.onState((s) => {
        setState(s);
        blank = onNoPage(s);
        if (blank) {
          size = null;
          setFrame(null);
        }
        setAnswered(null);
        if (s.controller !== "user") {
          setHolding(false);
          setMoved(false);
        }
        // The screen came up after the runtime said it couldn't stream it: ask again.
        if (statusRef.current === "unavailable") setAttempt((n) => n + 1);
      }),
      source.onFrame((f) => {
        if (blank || (size?.width === f.width && size.height === f.height)) return;
        size = { width: f.width, height: f.height };
        setFrame(size);
      }),
      source.onControlLost(() => {
        setHolding(false);
        setAnswered(null);
        setMoved(true);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [source]);

  useEffect(() => {
    if (seenConnection.current === connection) return;
    seenConnection.current = connection;
    if (!holdingRef.current) return;
    setHolding(false);
    setAnswered("agent");
  }, [connection]);

  const fps = holding ? DRIVE_FPS : WATCH_FPS;
  useEffect(() => {
    // Connection 0: the socket hasn't opened yet; the first open starts the stream.
    if (!source || !streaming || connection === 0) return;
    let current = true;
    setStatus((s) => (s === "live" ? s : "starting"));
    source.start(holder, fps).then(
      (r) => current && setStatus(r),
      () => current && setStatus("error"),
    );
    return () => {
      current = false;
    };
  }, [source, streaming, fps, attempt, connection]);

  useEffect(() => {
    if (!source || !streaming) return;
    return () => source.stop(holder);
  }, [source, streaming]);

  useEffect(() => {
    if (!source || !holds) return;
    return () => {
      // A hidden tab or window never keeps the agent waiting.
      if (!holdingRef.current) return;
      setHolding(false);
      setAnswered("agent");
      void source.control("agent").catch(() => undefined);
    };
  }, [source, holds]);

  const control = useCallback(
    (want: "user" | "agent") => {
      if (!source) return;
      setMoved(false);
      setControlError(null);
      setAnswered(want);
      setHolding(want === "user");
      source.control(want).then(
        (now) => {
          setAnswered(now);
          setHolding(want === "user" && now === "user");
        },
        (error: unknown) => {
          setAnswered(null);
          setHolding(false);
          if (want === "user") setControlError(error instanceof Error ? error.message : "The runtime refused.");
        },
      );
    },
    [source],
  );
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const controller = answered ?? state?.controller ?? "none";
  return { status, state, controller, holding, moved: moved && controller === "user" && !holding, frame, controlError, control, retry };
}

export interface LiveViewProps {
  readonly source: LiveSource;
  readonly live: Live<unknown>;
 /** Who the agent is: the native label and the hand-off pill ("Caveman"). */
  readonly engine: string;
  /** `contain` letterboxes the frame into the view; `actual` shows it 1:1 and scrolls. */
  readonly fit?: "contain" | "actual";
  /** Where a letterboxed frame sits: `top` for a page under its chrome, `center` for a screen. */
  readonly align?: Align;
  /** The surface's own chords (the browser's ⌘L, ⌘R): like the panel's, they stay with the app while the user drives. */
  readonly chords?: ReadonlyArray<string>;
  /** Covers the view until the first frame arrives, and while a browser is on no page. The view stays mounted beneath it so that frame is drawn. */
  readonly placeholder?: ReactNode;
  /** False leaves out who is driving and Take over: a view that only watches (the screen floating over the chat). */
  readonly handoff?: boolean;
  /** False never sends pointer or keys: on This Mac the person takes over with their own mouse, on the app itself. */
  readonly interactive?: boolean;
  /** What the agent is using, for the hand-off pill ("Safari"); the source's noun by default. */
  readonly using?: string;
  /** Shown over the screen, such as the page's own dialog. */
  readonly overlay?: ReactNode;
  /** A mouse's Back or Forward button over the view: the screen's own history (the agent's browser), as its bar's buttons. */
  readonly onHistory?: (action: "back" | "forward") => void;
  readonly className?: string;
}

export function LiveView({ source, live, engine, fit = "contain", align = "center", chords = [], placeholder, handoff = true, interactive = true, using, overlay, onHistory, className }: LiveViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const ping = useRef<HTMLSpanElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  /** Frame pixel space: the size of the frame on the canvas. */
  const frameSize = useRef<Size | null>(null);
  const stageSize = useRef<Size>({ width: 0, height: 0 });
  const lastPointer = useRef<LivePointer | null>(null);
  const cursorIdle = useRef(true);
  const buttons = useRef(0);

  const driving = live.holding && live.controller === "user";
  // Only a view that forwards input relays the person's pointer and keys while they drive.
  const relaying = driving && interactive;
  const drivingRef = useRef(relaying);
  drivingRef.current = relaying;
  const humanRef = useRef(live.controller === "user");
  humanRef.current = live.controller === "user";
  const noun = source.noun;
  // 1:1 frames fill their stage exactly; only a letterboxed frame has an alignment.
  const at = fit === "contain" ? align : "center";
  const atRef = useRef(at);
  atRef.current = at;

  const placeCursor = useCallback(() => {
    const p = lastPointer.current;
    const frame = frameSize.current;
    const el = cursor.current;
    if (!p || !frame || !el) return;
    const pos = toBox(p, stageSize.current, frame, atRef.current);
    el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
    el.style.visibility = "visible";
  }, []);

  // Frames: one decode at a time, off the main path; a frame that arrives mid-decode waits, and only the newest one does.
  // A browser on no page draws nothing and clears what it showed: the view stays hidden then (useLive), and the next
  // page's first frame shows it empty until that frame paints, never the closed page or the blank one's white.
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let stopped = false;
    let busy = false;
    let waiting: LiveFrame | null = null;
    const blank = () => onNoPage(source.state);
    const clear = () => ctx.clearRect(0, 0, el.width, el.height);
    const paint = (f: LiveFrame) => {
      busy = true;
      createImageBitmap(blobOf(f))
        .then((bitmap) => {
          if (!stopped && blank()) clear();
          else if (!stopped) {
            if (el.width !== f.width || el.height !== f.height) {
              el.width = f.width;
              el.height = f.height;
            }
            ctx.drawImage(bitmap, 0, 0, f.width, f.height);
            const first = frameSize.current === null;
            if (first || frameSize.current!.width !== f.width || frameSize.current!.height !== f.height) {
              frameSize.current = { width: f.width, height: f.height };
              placeCursor();
            }
          }
          bitmap.close();
        })
        // A frame that fails to decode is skipped; the next one repaints.
        .catch(() => undefined)
        .finally(() => {
          busy = false;
          const next = waiting;
          waiting = null;
          if (next && !stopped) paint(next);
        });
    };
    const offs = [
      source.onFrame((f) => {
        if (blank()) waiting = null;
        else if (busy) waiting = f;
        else paint(f);
      }),
      source.onState(() => {
        if (blank()) clear();
      }),
    ];
    return () => {
      stopped = true;
      offs.forEach((off) => off());
    };
  }, [source, placeCursor]);

  // The agent's cursor: moved by writing its transform, faded once the agent stops acting.
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    const off = source.onPointer((p) => {
      lastPointer.current = p;
      const el = cursor.current;
      if (!el) return;
      placeCursor();
      el.style.opacity = "1";
      cursorIdle.current = false;
      clearTimeout(idle);
      idle = setTimeout(() => {
        cursorIdle.current = true;
        el.style.opacity = humanRef.current ? "0.18" : "0.35";
      }, CURSOR_ACTIVE_MS);
      if (p.phase === "click" && !reducedMotion()) {
        ping.current?.animate(
          [
            { transform: "scale(0.4)", opacity: 0.55 },
            { transform: "scale(2.4)", opacity: 0 },
          ],
          { duration: duration.scene, easing: ease.snap },
        );
      }
    });
    return () => {
      off();
      clearTimeout(idle);
    };
  }, [source, placeCursor]);

  useEffect(() => {
    if (cursorIdle.current && cursor.current?.style.visibility === "visible") cursor.current.style.opacity = live.controller === "user" ? "0.18" : "0.35";
  }, [live.controller]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      stageSize.current = { width: entry.contentRect.width, height: entry.contentRect.height };
      placeCursor();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [placeCursor]);

  /** A client point in frame pixels, or null outside the frame (unless clamped, for drags). */
  const pointAt = useCallback((e: { clientX: number; clientY: number }, clamp: boolean) => {
    const el = canvas.current;
    const frame = frameSize.current;
    if (!el || !frame) return null;
    const r = el.getBoundingClientRect();
    return toFrame({ x: e.clientX - r.left, y: e.clientY - r.top }, r, frame, atRef.current, clamp);
  }, []);

  // Registered natively: React's wheel listener is passive and can't keep the panel from scrolling.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!drivingRef.current) return;
      const p = pointAt(e, false);
      if (!p) return;
      e.preventDefault();
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? (frameSize.current?.height ?? 0) : 1;
      source.input({ type: "wheel", ...p, dx: e.deltaX * unit, dy: e.deltaY * unit, modifiers: modifiers(e) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [source, pointAt]);

  // Focus stays on the control that took over; a click on the screen (or Tab) puts the keyboard on the page.
  useEffect(() => {
    if (!driving) buttons.current = 0;
  }, [driving]);

  const onPointer = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drivingRef.current || e.pointerType === "touch") return;
    // Thumb buttons page the screen's history (onThumb), never reach the page as clicks.
    if (thumbButton(e.button) !== null) return;
    const held = buttons.current !== 0;
    const mods = modifiers(e);
    if (e.type === "pointerdown") {
      const button = BUTTONS[e.button];
      const p = pointAt(e, false);
      if (!button || !p) return;
      keys.current?.focus({ preventScroll: true });
      e.currentTarget.setPointerCapture(e.pointerId);
      buttons.current = e.buttons;
      source.input({ type: "pointer", action: "down", ...p, button, modifiers: mods });
    } else if (e.type === "pointerup" || e.type === "pointercancel") {
      const p = pointAt(e, true);
      if (!held || !p) return;
      buttons.current = e.type === "pointercancel" ? 0 : e.buttons;
      source.input({ type: "pointer", action: "up", ...p, button: BUTTONS[e.button] ?? "left", modifiers: mods });
    } else {
      const p = pointAt(e, held);
      if (!p) return;
      const button = e.buttons & 1 ? "left" : e.buttons & 2 ? "right" : e.buttons & 4 ? "middle" : null;
      source.input({ type: "pointer", action: "move", ...p, ...(button ? { button } : {}), modifiers: mods });
    }
  };

  const onKey = (action: "down" | "up") => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!drivingRef.current) return;
    // IME and dictation deliver text through composition and input events.
    if (isComposing(e) || e.key === "Process" || e.key === "Unidentified") return;
    // Plain Escape and Tab belong to the page; Shift+Escape returns to the app.
    if (e.key === "Escape" && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (action === "down") e.currentTarget.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // Paste arrives as a paste event carrying this device's clipboard.
      if (e.key.toLowerCase() === "v") return;
      // The app's chords (handled already, or the panel's, a surface's, this surface's) pass through and never reach the page.
      const n = e.nativeEvent;
      if (n.defaultPrevented || [...PANEL_CHORDS, ...launcherSurfaces().flatMap((d) => (d.chord ? [d.chord] : [])), ...chords].some((c) => matchesChord(n, c))) return;
    }
    // Every other key, chords included, is the page's alone: no local find bar, save dialog or bookmark.
    source.input({ type: "key", action, key: e.key, code: e.code, modifiers: modifiers(e) });
    e.preventDefault();
    e.stopPropagation();
  };

  // Chromium runs a thumb button's back or forward on mouseup in this document, which would move the app's own router
 // (the chat pane behind the screen). Cancel it; over the agent's browser it pages that browser instead (upstream #22522).
  const onThumb = (e: MouseEvent<HTMLDivElement>) => {
    const action = thumbButton(e.button);
    if (action === null) return;
    e.preventDefault();
    onHistory?.(action);
  };

  const sendText = (text: string) => {
    if (drivingRef.current && text) source.input({ type: "text", text });
  };

  const someoneElse = live.controller === "user" && !live.holding;
  const label = driving ? `The agent's ${noun}, you're in control` : live.controller === "agent" ? `The agent's ${noun}, ${engine} is using it` : `The agent's ${noun}`;

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)} onMouseUp={onThumb}>
      <div className={cn("flex min-h-0 flex-1 bg-muted", fit === "actual" ? "overflow-auto" : "overflow-hidden")}>
        <div ref={stage} className={cn("relative shrink-0", fit === "contain" ? "size-full" : "m-auto")} style={fit === "actual" && live.frame ? { width: live.frame.width, height: live.frame.height } : undefined}>
          <canvas
            ref={canvas}
            role="img"
            aria-label={label}
            className={cn("block size-full object-contain outline-none", at === "top" && "object-top", !live.frame && "invisible", "cursor-default", relaying && "touch-none")}
            onPointerDown={onPointer}
            onPointerMove={onPointer}
            onPointerUp={onPointer}
            onPointerCancel={onPointer}
            // Keeps focus in the keyboard target and stops native selection.
            onMouseDown={(e) => relaying && e.preventDefault()}
            onContextMenu={(e) => relaying && e.preventDefault()}
          />
          <div ref={cursor} aria-hidden className="pointer-events-none absolute left-0 top-0 z-10 transition-[transform,opacity] duration-150 ease-out" style={{ visibility: "hidden", opacity: 0 }}>
            <span ref={ping} className="absolute -left-2 -top-2 size-4 rounded-full bg-foreground opacity-0 mix-blend-difference" />
            {/* Dark arrow, light outline, like the system cursor: it reads on light pages and dark ones. */}
            <Icon icon={Cursor02Icon} className="relative size-[18px] -translate-x-[3px] -translate-y-[3px] fill-background text-foreground drop-shadow-md" strokeWidth={1.5} />
            <span className="absolute left-3 top-[15px] whitespace-nowrap rounded-full bg-background px-1.5 text-[11px] font-medium leading-4 text-foreground shadow-md ring-1 ring-foreground/20">{engine}</span>
          </div>
        </div>
      </div>

      {/* The keyboard target while driving: pinned top-left so focusing it never scrolls. */}
      <textarea
        ref={keys}
        aria-label={noun === "browser" ? "Browser page" : "Computer screen"}
        aria-description="Shift+Escape returns to the app."
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        tabIndex={relaying ? 0 : -1}
        disabled={!relaying}
        className="sr-only left-0 top-0"
        onKeyDown={onKey("down")}
        onKeyUp={onKey("up")}
        onInput={(e) => {
          if ((e.nativeEvent as globalThis.InputEvent).isComposing) return;
          sendText(e.currentTarget.value);
          e.currentTarget.value = "";
        }}
        onCompositionEnd={(e) => {
          sendText(e.data);
          e.currentTarget.value = "";
        }}
        onPaste={(e) => {
          e.preventDefault();
          sendText(e.clipboardData.getData("text/plain"));
        }}
        // The textarea is a relay; copying it would copy nothing useful.
        onCopy={(e) => e.preventDefault()}
        onCut={(e) => e.preventDefault()}
      />

      {driving ? <div aria-hidden className="pointer-events-none absolute inset-0 z-10 ring-1 ring-inset ring-ring" /> : null}

      {overlay}

      {handoff && live.frame && (live.controller === "agent" || live.controller === "user") ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
          {/* One element whatever its text, so the button keeps focus across take over and hand back. */}
          <div
            role="status"
            className="pointer-events-auto flex h-8 min-w-0 max-w-full items-center gap-2.5 rounded-full border border-border bg-popover/90 pl-3 pr-1 text-[12.5px] shadow-overlay backdrop-blur-md animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-snap"
          >
            <span className="min-w-0 truncate text-muted-foreground">
              {driving ? (
                <>
                  <span className="text-foreground">You're in control.</span> {/* What a person does here, the agent's uid can read: the browser's profile, the desktop's keyboard. */}
                  {!interactive ? `${engine} waits until you hand back.` : noun === "browser" ? "Sign-ins here are the agent's too." : "The agent can see what you type."}
                </>
              ) : someoneElse ? (
                live.moved ? (
                  "Control moved elsewhere"
                ) : (
                  "In control from another window"
                )
              ) : (
                <>
                  <span className="text-foreground">{engine}</span> is using {using ?? `the ${noun}`}
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => live.control(driving ? "agent" : "user")}
              className="h-6 shrink-0 rounded-full bg-secondary px-2.5 text-[12px] font-medium text-foreground outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              {driving ? "Hand back" : "Take over"}
            </button>
          </div>
        </div>
      ) : null}

      {placeholder && !live.frame ? <div className="absolute inset-0 z-30 flex flex-col bg-background">{placeholder}</div> : null}
    </div>
  );
}
