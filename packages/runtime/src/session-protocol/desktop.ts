// The Linux desktop on a Cloud computer (Caveman Cloud DESIGN E8-E9, 2026-10-18):
// Xvfb :99 in the tools container, started on first use through the tools exec
// channel (cloudLink/tools.ts), captured with ImageMagick's `import` and
// driven with xdotool, all as the tools uid. One shell in tools serves every
// command, so a frame or a click starts no process here. Xvfb and openbox run in
// a session of their own: the shell can end (a command hung, the runtime
// restarted) and the next one finds the same screen and windows. The computer
// sleeping ends them.
// The `computer` MCP tool acts through `act`; computer.* (computer.ts) shows
// frames to people and lets one of them take over through `input`.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { toolsCommand, toolsRun, toolsSocket } from "../cloudLink/tools.ts";

export const DISPLAY = ":99";
/** The screen, and so the screenshot: coordinates need no scaling for any engine. */
export const SCREEN = { width: 1280, height: 800 } as const;
/** How long an action's effect gets to paint before its screenshot. */
const SETTLE_MS = 500;
const START_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 20_000;
/** What a hung command answers; the shell is then restarted, never retried with the same input. */
const HUNG = "the desktop did not answer";
/** Characters per typed line: under gVisor xdotool types about 12 a second into a window, so a line takes some 4 s of the timeout. */
const TYPE_CHUNK = 50;

export class DesktopError extends Schema.TaggedError<DesktopError>()("DesktopError", {
  reason: Schema.Literals(["unsupported", "user_in_control", "invalid_params", "failed"]),
  message: Schema.String,
}) {}

const fail = (reason: DesktopError["reason"], message: string) => Effect.fail(new DesktopError({ reason, message }));

export interface Shot {
  readonly mimeType: "image/png" | "image/jpeg";
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

export const ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "scroll",
  "type",
  "key",
  "wait",
  "cursor_position",
] as const;

/** The `computer` tool's input: Anthropic's action names, coordinates in screenshot pixels. */
export interface ComputerAction {
  readonly action: (typeof ACTIONS)[number];
  readonly coordinate?: ReadonlyArray<number> | undefined;
  readonly start_coordinate?: ReadonlyArray<number> | undefined;
  readonly text?: string | undefined;
  readonly scroll_direction?: "up" | "down" | "left" | "right" | undefined;
  readonly scroll_amount?: number | undefined;
  readonly duration?: number | undefined;
}

/** A person's input while they hold the desktop (Session Protocol InputEvent), in screen pixels. */
export type DesktopInput =
  | { readonly type: "pointer"; readonly action: "move" | "down" | "up"; readonly x: number; readonly y: number; readonly button?: "left" | "middle" | "right" | undefined; readonly modifiers: number }
  | { readonly type: "wheel"; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number; readonly modifiers: number }
  | { readonly type: "key"; readonly action: "down" | "up"; readonly key: string; readonly code: string; readonly modifiers: number }
  | { readonly type: "text"; readonly text: string };

export type DesktopChange =
  /** Started, stopped, or taken over / handed back. */
  | { readonly type: "state" }
  /** The agent acted: the screen after it, and where its pointer went. */
  | { readonly type: "acted"; readonly threadId: string; readonly shot: Shot; readonly pointer?: { readonly x: number; readonly y: number; readonly phase: "move" | "click" | "type" } };

export class Desktop extends Context.Service<
  Desktop,
  {
    /** On a Cloud computer whose image has the desktop (Xvfb, xdotool, ImageMagick). Asked once. */
    readonly available: Effect.Effect<boolean>;
    readonly running: () => boolean;
    /** Starts Xvfb (and openbox, when the image has it) on first use; a start in flight is shared. */
    readonly start: Effect.Effect<void, DesktopError>;
    /** The screen now. Starts nothing. */
    readonly capture: (format: "png" | "jpeg") => Effect.Effect<Shot, DesktopError>;
    /** One action of the `computer` tool, as `threadId`'s agent; the screen after it (none for cursor_position). */
    readonly act: (threadId: string, input: ComputerAction) => Effect.Effect<{ readonly shot?: Shot; readonly cursor?: { readonly x: number; readonly y: number } }, DesktopError>;
    /** Input from the person holding the desktop. */
    readonly input: (events: ReadonlyArray<DesktopInput>) => Effect.Effect<void, DesktopError>;
    /** The connection that took over, while a person holds the desktop. */
    readonly holder: () => string | undefined;
    readonly hold: (connectionId: string | undefined) => Effect.Effect<void>;
    readonly changes: PubSub.PubSub<DesktopChange>;
  }
>()("caveman/session-protocol/Desktop") {}

/** One shell argument. */
export const quote = (value: string | number) => {
  const text = String(value);
  // A line is one command: nothing may carry a line break into it.
  if (/[\r\n\0]/.test(text)) throw new Error("a desktop command argument has a line break");
  return `'${text.replaceAll("'", `'\\''`)}'`;
};
const xdotool = (args: ReadonlyArray<string | number>) => ["xdotool", ...args].map(quote).join(" ");
/**
 * Types `text` exactly, line breaks included: it reaches xdotool on stdin (`--file -`), never as an argument.
 * Long text goes as several lines, so no one line runs past the command timeout, each with its own bound: a stuck
 * xdotool fails the line and the shell stays.
 */
const typeLines = (text: string) => {
  const chars = [...text];
  const lines: Array<string> = [];
  for (let at = 0; at < chars.length; at += TYPE_CHUNK) {
    const chunk = chars.slice(at, at + TYPE_CHUNK).join("");
    lines.push(`printf %s ${quote(Buffer.from(chunk).toString("base64"))} | base64 -d | timeout 15 xdotool type --delay 12 --file -`);
  }
  return lines;
};
/** xdotool's own commands: as a `key` argument, any of them (in any case) starts that command, `exec` included. */
const XDOTOOL_COMMANDS = new Set(
  "getactivewindow getwindowfocus getwindowname getwindowclassname getwindowpid getwindowgeometry getdisplaygeometry search selectwindow help version behave behave_screen_edge click getmouselocation key keydown keyup mousedown mousemove mousemove_relative mouseup set_window type windowactivate windowfocus windowkill windowclose windowquit windowmap windowminimize windowmove windowraise windowlower windowreparent windowsize windowstate windowunmap set_num_desktops get_num_desktops set_desktop get_desktop set_desktop_for_window get_desktop_for_window get_desktop_viewport set_desktop_viewport exec sleep".split(" "),
);
/** `key`'s text as keysym chords (`ctrl+s Return`); anything else is refused, so nothing but keys reaches xdotool. */
const keyChords = (text: string) => {
  const keys = text.split(/\s+/).filter(Boolean);
  const bad = keys.find((key) => !/^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/.test(key) || XDOTOOL_COMMANDS.has(key.toLowerCase()));
  if (keys.length === 0 || bad !== undefined) {
    throw new DesktopError({ reason: "invalid_params", message: `key takes keysym names joined by + (ctrl+s, Return, alt+F4), not ${JSON.stringify(bad ?? text)}` });
  }
  return keys;
};
const shotCommand = (format: "png" | "jpeg") => `import -silent -window root ${format === "jpeg" ? "-quality 70 jpeg:-" : "png:-"}`;

// Answers each command line with "<exit code> <bytes>\n" then that many bytes: its
// stdout, or its stderr when it failed. stdin is the command stream, so no command reads it.
// UTF-8, or xdotool stops at the first character past ASCII (the image sets no locale). Chrome still drops one
// that isn't on the keyboard map: xdotool maps it for a moment, and Chrome reads the map too late.
const SHELL = `export DISPLAY=${DISPLAY} LC_ALL=C.UTF-8
x=
for b in Xvfb xdotool import; do command -v "$b" >/dev/null 2>&1 || { echo "missing $b"; exit 0; }; done
if ! xdotool getdisplaygeometry >/dev/null 2>&1; then
  # Nothing answers on the display, so a lock left there is stale (a killed Xvfb, maybe not yet reaped).
  rm -f /tmp/.X${DISPLAY.slice(1)}-lock /tmp/.X11-unix/X${DISPLAY.slice(1)}
  # -dumbSched: under gVisor, xdotool typing into a redrawing Chrome stalled for good after a few hundred characters
  # in 6 of 7 runs with the smart scheduler, and typed 3,000 whole in 2 of 2 without it (kind, runsc 20261005.0).
  # -r: no autorepeat. A busy node can hold xdotool between a key's press and release past the repeat delay, and
  # Xvfb then typed it again (3,002 characters for 3,000 under load); a person's held key repeats in their browser.
  setsid Xvfb ${DISPLAY} -screen 0 ${SCREEN.width}x${SCREEN.height}x24 -nolisten tcp -dumbSched -r >/tmp/caveman-xvfb.log 2>&1 &
  x=$!
  i=0
  until xdotool getdisplaygeometry >/dev/null 2>&1; do
    i=$((i+1)); if [ "$i" -gt 200 ]; then echo "failed $(tail -n 3 /tmp/caveman-xvfb.log | tr '\\n' ' ')"; exit 0; fi; sleep 0.1
  done
  if command -v openbox >/dev/null 2>&1; then setsid openbox >/dev/null 2>&1 & fi
else
  # The screen an earlier shell started: its X server's pid is in its lock file.
  read -r x </tmp/.X${DISPLAY.slice(1)}-lock 2>/dev/null || x=
fi
echo ready
o=$(mktemp) && e=$(mktemp) || exit 1
trap 'rm -f "$o" "$e"' EXIT
while IFS= read -r line; do
  # The X server died (a crash, out of memory), reaped or not: end, so the next use starts a fresh one.
  if [ -n "$x" ]; then s=; read -r _ _ s _ </proc/$x/stat 2>/dev/null; case "$s" in ""|Z|X) exit 0 ;; esac; fi
  eval "$line" </dev/null >"$o" 2>"$e"; c=$?
  if [ "$c" -ne 0 ]; then cat "$e" >"$o"; fi
  printf '%s %s\\n' "$c" "$(wc -c <"$o" | tr -d ' ')"
  cat "$o"
done
`;

interface Reply {
  readonly code: number;
  readonly body: Buffer;
}

/** The shell in tools: one command line in, one reply out, in order. */
class Shell {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffered: Buffer = Buffer.alloc(0);
  private waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
  private first: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  exited = false;
  readonly ready: Promise<string>;

  constructor(child: ChildProcessWithoutNullStreams, onExit: () => void) {
    this.child = child;
    this.ready = new Promise((resolve, reject) => (this.first = { resolve, reject }));
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
      this.pump();
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    child.stdin.on("error", () => {});
    child.on("close", () => {
      this.exited = true;
      const error = new Error(`the desktop stopped${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`);
      this.first?.reject(error);
      this.waiter?.reject(error);
      this.first = this.waiter = undefined;
      onExit();
    });
  }

  private pump(): void {
    const newline = this.buffered.indexOf(10);
    if (newline < 0) return;
    if (this.first) {
      const line = this.buffered.subarray(0, newline).toString();
      this.buffered = this.buffered.subarray(newline + 1);
      this.first.resolve(line);
      this.first = undefined;
      return this.pump();
    }
    if (!this.waiter) return;
    const [code, size] = this.buffered.subarray(0, newline).toString().split(" ").map(Number);
    if (this.buffered.length < newline + 1 + size!) return;
    const body = Buffer.from(this.buffered.subarray(newline + 1, newline + 1 + size!));
    this.buffered = this.buffered.subarray(newline + 1 + size!);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter.resolve({ code: code!, body });
  }

  /** Callers take turns (the service's lock): one command in flight. */
  run(line: string): Promise<Reply> {
    if (this.exited) return Promise.reject(new Error("the desktop stopped"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(HUNG));
        this.stop();
      }, COMMAND_TIMEOUT_MS);
      this.waiter = {
        resolve: (reply) => (clearTimeout(timer), resolve(reply)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      };
      this.child.stdin.write(`${line}\n`);
      this.pump();
    });
  }

  /**
   * Ends this shell and whatever command it runs (the exec channel signals its process group); Xvfb and the
   * windows are in sessions of their own and stay. Dead at once, so a late reply can't answer the next command.
   */
  stop() {
    if (this.exited) return;
    this.exited = true;
    const error = new Error("the desktop stopped");
    this.first?.reject(error);
    this.waiter?.reject(error);
    this.first = this.waiter = undefined;
    this.child.kill("SIGTERM");
  }
}

const BUTTONS = { left: 1, middle: 2, right: 3 } as const;
const CLICKS = { left_click: [1, 1], right_click: [3, 1], middle_click: [2, 1], double_click: [1, 2], triple_click: [1, 3] } as const;
const WHEEL = { up: 4, down: 5, left: 6, right: 7 } as const;
/** Pixels of wheel delta per wheel click (a click scrolls about three lines). */
const WHEEL_STEP = 50;
/** Modifier bitmask as in CDP (alt 1, ctrl 2, meta 4, shift 8), as xdotool names them. */
const MODIFIERS = [
  [1, "alt"],
  [2, "ctrl"],
  [4, "super"],
  [8, "shift"],
] as const;
const modifierNames = (bits: number) => MODIFIERS.filter(([bit]) => bits & bit).map(([, name]) => name);

/** DOM `key` values that are not characters, as X keysyms. */
const NAMED_KEYS: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  CapsLock: "Caps_Lock",
  ContextMenu: "Menu",
};
/** DOM `code` values of the punctuation keys, for chords like ctrl+/ (US layout). */
const CODE_KEYS: Record<string, string> = {
  Space: "space",
  Comma: "comma",
  Period: "period",
  Slash: "slash",
  Semicolon: "semicolon",
  Quote: "apostrophe",
  BracketLeft: "bracketleft",
  BracketRight: "bracketright",
  Backslash: "backslash",
  Minus: "minus",
  Equal: "equal",
  Backquote: "grave",
};
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "OS"]);

/** The keysym a chord presses, from the physical key; undefined for a key the desktop has no name for. */
const chordKey = (key: string, code: string) =>
  NAMED_KEYS[key] ?? (/^F\d{1,2}$/.test(key) ? key : /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : CODE_KEYS[code]);

const point = (x: number, y: number) => [Math.round(Math.min(Math.max(x, 0), SCREEN.width - 1)), Math.round(Math.min(Math.max(y, 0), SCREEN.height - 1))] as const;

/** A batch of a person's input as command lines (xdotool chains and typed text), in order. */
export const inputLines = (events: ReadonlyArray<DesktopInput>): Array<string> => {
  const lines: Array<string> = [];
  let chain: Array<string | number> = [];
  const flush = () => {
    if (chain.length > 0) lines.push(xdotool(chain));
    chain = [];
  };
  for (const event of events) {
    switch (event.type) {
      case "pointer": {
        const mods = modifierNames(event.modifiers);
        chain.push("mousemove", ...point(event.x, event.y));
        if (event.action === "move") break;
        const button = BUTTONS[event.button ?? "left"];
        // Held only around the press, as X reads modifier state at the click (shift+click, ctrl+click).
        if (event.action === "down") chain.push(...mods.flatMap((m) => ["keydown", m]), "mousedown", button, ...mods.flatMap((m) => ["keyup", m]));
        else chain.push("mouseup", button);
        break;
      }
      case "wheel": {
        chain.push("mousemove", ...point(event.x, event.y));
        for (const [delta, back, forward] of [
          [event.dy, WHEEL.up, WHEEL.down],
          [event.dx, WHEEL.left, WHEEL.right],
        ] as const) {
          if (delta === 0) continue;
          chain.push("click", "--repeat", Math.min(10, Math.max(1, Math.round(Math.abs(delta) / WHEEL_STEP))), delta < 0 ? back : forward);
        }
        break;
      }
      case "key": {
        // A press is a whole keystroke: X repeats nothing, and the browser sends a down per repeat.
        if (event.action === "up" || MODIFIER_KEYS.has(event.key)) break;
        const chords = event.modifiers & 7;
        if ([...event.key].length === 1 && chords === 0) {
          // The character as typed (shift and layout already applied).
          flush();
          lines.push(...typeLines(event.key));
          break;
        }
        const name = chordKey(event.key, event.code);
        if (!name) break;
        chain.push("key", "--clearmodifiers", [...modifierNames(event.modifiers), name].join("+"));
        break;
      }
      case "text":
        flush();
        if (event.text) lines.push(...typeLines(event.text));
        break;
    }
  }
  flush();
  return lines;
};

const coordinate = (value: ReadonlyArray<number> | undefined, name: string) => {
  if (value === undefined) return undefined;
  const [x, y] = value;
  if (value.length !== 2 || !Number.isInteger(x) || !Number.isInteger(y) || x! < 0 || y! < 0 || x! >= SCREEN.width || y! >= SCREEN.height) {
    throw new DesktopError({ reason: "invalid_params", message: `${name} must be [x, y] on the ${SCREEN.width}x${SCREEN.height} screen` });
  }
  return [x!, y!] as const;
};

/** One `computer` action as command lines, plus where the agent's pointer goes; throws DesktopError on bad input. */
export const actionLines = (input: ComputerAction): { lines: Array<string>; pointer?: { x: number; y: number; phase: "move" | "click" | "type" } } => {
  const at = coordinate(input.coordinate, "coordinate");
  const moveTo = at ? ["mousemove", ...at] : [];
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined || value === "") throw new DesktopError({ reason: "invalid_params", message: `${input.action} needs ${what}` });
    return value;
  };
  const pointer = (phase: "move" | "click") => (at ? { pointer: { x: at[0], y: at[1], phase } } : {});
  switch (input.action) {
    case "screenshot":
    case "wait":
    case "cursor_position":
      return { lines: [] };
    case "mouse_move":
      need(at, "coordinate");
      return { lines: [xdotool(moveTo)], ...pointer("move") };
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const [button, count] = CLICKS[input.action];
      return { lines: [xdotool([...moveTo, "click", "--repeat", count, "--delay", 80, button])], ...pointer("click") };
    }
    case "left_click_drag": {
      const from = need(coordinate(input.start_coordinate, "start_coordinate"), "start_coordinate");
      const to = need(at, "coordinate");
      return {
        lines: [xdotool(["mousemove", ...from, "mousedown", 1, "sleep", 0.1, "mousemove", ...to, "sleep", 0.1, "mouseup", 1])],
        pointer: { x: to[0], y: to[1], phase: "click" },
      };
    }
    case "scroll": {
      const direction = need(input.scroll_direction, "scroll_direction");
      const amount = Math.min(Math.max(Math.round(input.scroll_amount ?? 3), 1), 30);
      return { lines: [xdotool([...moveTo, "click", "--repeat", amount, WHEEL[direction]])], ...pointer("move") };
    }
    case "type":
      return { lines: typeLines(need(input.text, "text")) };
    case "key":
      return { lines: [xdotool(["key", "--clearmodifiers", "--delay", 50, ...keyChords(need(input.text, "text"))])] };
  }
};

const make = (socket: string | undefined) =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<DesktopChange>();
    const lock = yield* Semaphore.make(1);
    const startLock = yield* Semaphore.make(1);
    let shell: Shell | undefined;
    let holder: string | undefined;

    const notOnComputer = fail("unsupported", "The desktop is on Cloud computers; this computer has none.");
    const running = () => shell !== undefined && !shell.exited;

    const start: Effect.Effect<void, DesktopError> = socket === undefined
      ? notOnComputer
      : startLock.withPermits(1)(
          Effect.suspend(() => {
            if (running()) return Effect.void;
            return Effect.tryPromise({
              try: async () => {
                const routed = toolsCommand(socket, "sh", ["-c", SHELL], "/", { DISPLAY }, {});
                const child = spawn(routed.command, routed.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...routed.env } });
                const next = new Shell(child, () => {
                  if (shell !== next) return;
                  shell = undefined;
                  holder = undefined;
                  PubSub.publishUnsafe(changes, { type: "state" });
                });
                const timer = setTimeout(() => next.stop(), START_TIMEOUT_MS);
                const first = await next.ready.finally(() => clearTimeout(timer));
                if (first === "ready") return next;
                next.stop();
                if (first.startsWith("missing ")) {
                  throw new DesktopError({ reason: "unsupported", message: `This computer's image has no desktop yet (no ${first.slice(8)}).` });
                }
                throw new DesktopError({ reason: "failed", message: `The desktop didn't start: ${first.replace(/^failed /, "")}` });
              },
              catch: (error) => (error instanceof DesktopError ? error : new DesktopError({ reason: "failed", message: `The desktop didn't start: ${String((error as Error).message ?? error)}` })),
            }).pipe(
              Effect.flatMap((next) => {
                shell = next;
                return PubSub.publish(changes, { type: "state" });
              }),
              Effect.asVoid,
            );
          }),
        );

    /** Runs command lines in order; the first that fails ends the batch. */
    const run = (lines: ReadonlyArray<string>) =>
      lock.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            let last: Reply = { code: 0, body: Buffer.alloc(0) };
            for (const line of lines) {
              if (!shell || shell.exited) throw new Error("the desktop is not running");
              last = await shell.run(line);
              if (last.code !== 0) throw new Error(last.body.toString().trim().slice(0, 300) || `exit ${last.code}`);
            }
            return last.body;
          },
          catch: (error) => new DesktopError({ reason: "failed", message: `The desktop command failed: ${(error as Error).message}` }),
        }),
      );

    const capture = (format: "png" | "jpeg"): Effect.Effect<Shot, DesktopError> =>
      run([shotCommand(format)]).pipe(
        Effect.map((data) => ({ mimeType: format === "png" ? ("image/png" as const) : ("image/jpeg" as const), data, width: SCREEN.width, height: SCREEN.height })),
      );

    const act = (threadId: string, input: ComputerAction) =>
      Effect.gen(function* () {
        const planned = yield* Effect.try({
          try: () => actionLines(input),
          catch: (error) => (error instanceof DesktopError ? error : new DesktopError({ reason: "invalid_params", message: String(error) })),
        });
        // A person who took over keeps the desktop: the agent may look, not act.
        if (holder !== undefined && planned.lines.length > 0) {
          return yield* fail("user_in_control", "A person took over the desktop. Wait for them to hand it back, then take a screenshot.");
        }
        const attempt = Effect.gen(function* () {
          yield* start;
          if (input.action === "cursor_position") {
            const out = (yield* run([xdotool(["getmouselocation", "--shell"])])).toString();
            const x = Number(/X=(\d+)/.exec(out)?.[1] ?? 0);
            const y = Number(/Y=(\d+)/.exec(out)?.[1] ?? 0);
            return { cursor: { x, y } };
          }
          if (input.action === "wait") yield* Effect.sleep(Math.min(Math.max(input.duration ?? 1, 0), 60) * 1000);
          if (planned.lines.length > 0) {
            yield* run(planned.lines);
            yield* Effect.sleep(SETTLE_MS);
          }
          const shot = yield* capture("png");
          yield* PubSub.publish(changes, { type: "acted", threadId, shot, ...(planned.pointer ? { pointer: planned.pointer } : {}) });
          return { shot };
        });
        // A desktop that died under the action (its X server crashed) starts again, once. A command that hung
        // is not run again: it may have half typed. The next action gets a new shell on the same screen.
        return yield* attempt.pipe(Effect.catch((error) => (running() || error.message.includes(HUNG) ? Effect.fail(error) : attempt)));
      });

    const input = (events: ReadonlyArray<DesktopInput>) =>
      Effect.suspend(() => {
        const lines = inputLines(events);
        return lines.length === 0 ? Effect.void : run(lines).pipe(Effect.asVoid);
      });

    yield* Effect.addFinalizer(() => Effect.sync(() => shell?.stop()));

    // A yes is kept; a no is asked again (tools may still be starting).
    let found = false;
    const available = socket === undefined
      ? Effect.succeed(false)
      : Effect.suspend(() =>
          found || running()
            ? Effect.succeed(true)
            : Effect.promise(() => toolsRun(socket, "/", ["sh", "-c", "command -v Xvfb && command -v xdotool && command -v import"])).pipe(
                Effect.map((probe) => (found = probe.code === 0)),
              ),
        );

    return Desktop.of({
      available,
      running,
      start,
      capture: (format) => (running() ? capture(format) : fail("failed", "the desktop is not running")),
      act: (threadId, action) => (socket === undefined ? notOnComputer : act(threadId, action)),
      input: (events) => (running() ? input(events) : fail("failed", "the desktop is not running")),
      holder: () => holder,
      hold: (connectionId) =>
        Effect.suspend(() => {
          if (holder === connectionId) return Effect.void;
          holder = connectionId;
          return PubSub.publish(changes, { type: "state" }).pipe(Effect.asVoid);
        }),
      changes,
    });
  });

/** The desktop, on a Cloud computer; elsewhere every start fails as unsupported. */
export const layerFor = (socket: string | undefined) => Layer.effect(Desktop, make(socket));
export const layer = Layer.unwrap(Effect.sync(() => layerFor(toolsSocket())));
