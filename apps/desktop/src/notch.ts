// The notch (docs/): a black island at the top centre of the screen, over every window and every
// full-screen app, that marks the chats at work and morphs down by itself when one needs the person. On a MacBook it
// grows out of the screen's own notch; on any other display it is a small pill in the menu bar. It is a display for
// the main window, as the Dock badge is: that page says what it shows (apps/web src/notch/NotchFeed.tsx) and carries
// out what the person does on it, so no runtime endpoint or token reaches the notch's own page (apps/web notch.html).
//
// The window never changes size: it is as big as the notch gets, clear, and lets clicks through everywhere but the
// shape the page draws, which says when the pointer is over it. The page morphs the shape; main only places the
// window and tells the page what the screen's own notch measures.
import { BrowserWindow, Menu, screen } from "electron";
import { execFile } from "node:child_process";

import { NOTCH_AWAY_CHANNEL, NOTCH_STATE_CHANNEL } from "./ipc.ts";
import { RECOVERY_DELAY_MS, RendererRecovery } from "./rendererRecovery.ts";

/** The window: as wide and as tall as the open notch gets (apps/web src/notch/Notch.tsx fits inside it). */
export const NOTCH_WIDTH = 440;
export const NOTCH_HEIGHT = 560;
/** While the pointer is on the shape, how often main checks that it is still over the window. */
const WATCH_MS = 200;
/** The displays changed: how long they must hold still before the notch is placed again. */
const CHANGE_MS = 400;

interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The screen's own notch, in points; null on a display that has none. */
export interface HardwareNotch {
  readonly width: number;
  readonly height: number;
}

/** The window's place on a display: against its top edge, over the menu bar, centred. */
export const notchFrame = (bounds: Area): Area => ({
  x: bounds.x + Math.round((bounds.width - NOTCH_WIDTH) / 2),
  y: bounds.y,
  width: NOTCH_WIDTH,
  height: NOTCH_HEIGHT,
});

export const pointInside = (p: { readonly x: number; readonly y: number }, r: Area): boolean =>
  p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

// The main screen's notch as AppKit measures it: the safe area's top inset is its height, and what the two strips
// beside it leave of the screen's width is its width. Electron's `screen` knows neither.
const MEASURE = `ObjC.import("AppKit"); var s = $.NSScreen.screens.objectAtIndex(0); JSON.stringify({ width: s.frame.size.width, top: s.safeAreaInsets.top, left: s.auxiliaryTopLeftArea.size.width, right: s.auxiliaryTopRightArea.size.width })`;

/** What `MEASURE` printed, as the notch it describes: null without one, or when the answer is not a notch's. */
export function hardwareNotchOf(printed: string): HardwareNotch | null {
  try {
    const { width, top, left, right } = JSON.parse(printed) as Record<string, unknown>;
    if (
      typeof width !== "number" ||
      typeof top !== "number" ||
      typeof left !== "number" ||
      typeof right !== "number"
    )
      return null;
    const across = Math.round(width - left - right);
    return top > 0 && left > 0 && right > 0 && across > 0 && across < width / 2
      ? { width: across, height: Math.round(top) }
      : null;
  } catch {
    return null;
  }
}

/**
 * A notch nobody could measure (osascript failed): a built-in display whose menu bar is taller than a plain one has
 * one. Its width is a guess on the wide side, so what sits beside it never hides under it.
 */
export function guessedNotch(display: {
  readonly internal: boolean;
  readonly bounds: Area;
  readonly workArea: Area;
}): HardwareNotch | null {
  const bar = display.workArea.y - display.bounds.y;
  return display.internal && bar >= 30 ? { width: 204, height: bar - 1 } : null;
}

const measureNotch = (): Promise<HardwareNotch | null | undefined> =>
  new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MEASURE],
      { timeout: 5_000 },
      (error, stdout) => resolve(error ? undefined : hardwareNotchOf(stdout)),
    );
  });

export type NotchAction =
  /** Bring the app forward, on a chat when one is named. */
  | { readonly type: "open"; readonly id?: string }
  /** A card's key: `key` is the action's id as the page named it (apps/web src/notch/model.ts). */
  | { readonly type: "press"; readonly id: string; readonly key: string }
  /** The card's arrows: show this chat that waits on the card instead. */
  | { readonly type: "show"; readonly id: string }
  /** Put the notch away (Settings > General brings it back). */
  | { readonly type: "hide" };

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

/** What the notch's page may ask for, checked: anything else is dropped. */
export function notchAction(raw: unknown): NotchAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type, id, key } = raw as { type?: unknown; id?: unknown; key?: unknown };
  if (type === "open") return id === undefined ? { type } : text(id) ? { type, id } : null;
  if (type === "press") return text(id) && text(key) ? { type, id, key } : null;
  if (type === "show") return text(id) ? { type, id } : null;
  return type === "hide" ? { type } : null;
}

export class NotchWindow {
  private win: BrowserWindow | null = null;
  /** What the app last said it shows; null while it is put away. */
  private shown: unknown = null;
  /** The main screen's own notch: undefined until measured. */
  private hardware: HardwareNotch | null | undefined;
  private listening = false;
  private watching: NodeJS.Timeout | undefined;
  private changing: NodeJS.Timeout | undefined;
  private readonly recovery = new RendererRecovery();
  /** Its page died too often in a few minutes: no new window until the notch is put away and shown again. */
  private broken = false;
  private readonly url: string;
  private readonly preload: string;
  private readonly log: (line: string) => void;
  private readonly act: (action: NotchAction) => void;
  private readonly measure: () => Promise<HardwareNotch | null | undefined>;

  constructor(
    url: string,
    preload: string,
    log: (line: string) => void,
    act: (action: NotchAction) => void,
    measure: () => Promise<HardwareNotch | null | undefined> = measureNotch,
  ) {
    this.url = url;
    this.preload = preload;
    this.log = log;
    this.act = act;
    this.measure = measure;
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  /** The notch's own page sent this, and nothing else did. */
  owns(sender: Electron.WebContents): boolean {
    return this.win !== null && !this.win.isDestroyed() && sender === this.win.webContents;
  }

  /** What it shows from now on; null puts it away. */
  feed(state: unknown): void {
    const was = this.shown;
    this.shown = state ?? null;
    if (this.shown === null) {
      if (was !== null) this.log("notch: put away");
      this.broken = false;
      this.win?.hide();
      return;
    }
    if (this.broken) return;
    const made = this.win === null;
    this.win ??= this.create();
    this.send();
    // Only settling places the window and shows it: one made anew (its page had died) needs that as a first word does.
    if (was === null || made) void this.settle("shown");
    if (!this.listening) {
      // A display plugged in, unplugged or resized, or the lid shut on a desk: the main screen and its notch may have
      // changed. These come in bursts (a Dock sliding in and out moves the work area many times a second), so the
      // last of a burst is the one acted on; a work area that moved alone changes only the menu bar's height.
      this.listening = true;
      const after = (what: () => void) => {
        clearTimeout(this.changing);
        this.changing = setTimeout(what, CHANGE_MS);
      };
      const again = () => after(() => void this.settle("moved"));
      screen.on("display-metrics-changed", (_event, _display, changed) =>
        changed.every((metric) => metric === "workArea") ? after(() => this.send()) : again(),
      );
      screen.on("display-added", again);
      screen.on("display-removed", again);
    }
  }

  /** Its page listens now (a first load, or a reload): say what it shows. */
  ready(): void {
    this.send();
  }

  /**
   * The pointer is over the shape the page draws, or off it: off it, the window lets every click through. While it is
   * on, main watches that it stays over the window: a pointer that leaves in one move sends the page no last event,
   * and the window would keep taking the clicks meant for what is under it.
   */
  over(on: unknown): void {
    this.win?.setIgnoreMouseEvents(on !== true, { forward: true });
    clearInterval(this.watching);
    if (on !== true) return;
    this.watching = setInterval(() => {
      const win = this.win;
      if (!win || win.isDestroyed()) return clearInterval(this.watching);
      if (pointInside(screen.getCursorScreenPoint(), win.getBounds())) return;
      clearInterval(this.watching);
      win.setIgnoreMouseEvents(true, { forward: true });
      win.webContents.send(NOTCH_AWAY_CHANNEL);
    }, WATCH_MS);
  }

  /** The right-click menu: the one place the notch is put away from. */
  menu(): void {
    if (!this.win) return;
    Menu.buildFromTemplate([
      { label: "Open Caveman Code", click: () => this.act({ type: "open" }) },
      { type: "separator" },
      { label: "Hide the Notch", click: () => this.act({ type: "hide" }) },
    ]).popup({ window: this.win });
  }

  /** Measures the main screen's notch, then puts the window on that screen's top edge and shows it. */
  private async settle(why: string): Promise<void> {
    const measured = await this.measure();
    const display = screen.getPrimaryDisplay();
    this.hardware = measured === undefined ? guessedNotch(display) : measured;
    const win = this.win;
    if (!win || win.isDestroyed() || this.shown === null) return;
    win.setBounds(notchFrame(display.bounds));
    this.send();
    if (!win.isVisible()) win.showInactive();
    this.log(
      `notch: ${why} (${this.hardware ? `the screen's notch is ${this.hardware.width}x${this.hardware.height}` : "no notch on this screen"}${measured === undefined ? ", guessed" : ""})`,
    );
  }

  private send(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || this.shown === null || this.hardware === undefined) return;
    const display = screen.getPrimaryDisplay();
    win.webContents.send(NOTCH_STATE_CHANNEL, {
      state: this.shown,
      hardware: this.hardware,
      bar: Math.max(0, display.workArea.y - display.bounds.y),
    });
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: NOTCH_WIDTH,
      height: NOTCH_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Over the menu bar, against the screen's top edge: macOS keeps a window it may constrain below the bar.
      enableLargerThanScreen: true,
      // A non-activating panel: it floats over every app, full-screen ones too, and never pulls the main window forward.
      type: "panel",
      title: "Caveman Code Notch",
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        // Its page shares the app's origin, and Chromium zooms an origin as one: ⌘+ in the app would scale a shape
        // that is drawn to the point against the screen's notch, in a window that does not grow. Isolated, it keeps
        // its own zoom, which nothing sets (the menu zooms the window with the keys, never this one). Not "disabled":
        // set here, that mode is lost when the page loads (Electron 44), and the page zooms with the app.
        zoomMode: "isolated",
      },
    });
    // Above the menu bar, whose band it sits in beside the screen's own notch.
    win.setAlwaysOnTop(true, "main-menu", 3);
    // skipTransformProcessType: a panel needs no trip through an accessory app, which would hide the Dock icon a moment.
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    // Clear everywhere until the page says the pointer is on its shape.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.on("closed", () => {
      if (this.win === win) this.win = null;
      clearInterval(this.watching);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // A page that died goes, and a new window takes its place a moment later, a few times at most
    // (src/rendererRecovery.ts): never a loop for a page that dies at every start.
    win.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || win.isDestroyed()) return;
      const action = this.recovery.next(details.reason, Date.now());
      this.log(`notch: page gone (${details.reason}, exit ${details.exitCode}): ${action}`);
      win.destroy();
      if (action === "give-up") this.broken = true;
      else if (action === "reload")
        setTimeout(() => this.win === null && this.feed(this.shown), RECOVERY_DELAY_MS);
    });
    void win.loadURL(this.url);
    return win;
  }
}
