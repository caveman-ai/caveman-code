// The Chief's capture window: a global shortcut (Settings > Chief, default
// Control+Alt+Space) opens a one-line box over whatever app is in front.
// Enter sends the note for the Chief to sort, ⌥Enter queues it as is,
// Escape or clicking away hides it. The page is a static capture.html (no app
// bundle, no workspace poll); the note goes to the runtime as chief.capture
// through the main process, never from the page.
import { BrowserWindow, globalShortcut, screen } from "electron";
import { CAPTURE_SHOWN_CHANNEL } from "./ipc.ts";

export const DEFAULT_CAPTURE_SHORTCUT = "Control+Alt+Space";
const WIDTH = 640;
const HEIGHT = 112;

export interface CaptureShortcutState {
  readonly accelerator: string;
  readonly registered: boolean;
}

/** register() throws on a malformed accelerator; that counts as taken. */
export type Register = (accelerator: string, callback: () => void) => boolean;

/**
 * Binds the shortcut. A new chord replaces the old only once it registers: if
 * another app has it, the old one keeps working and the state says so. When
 * nothing was bound yet, the state names the chord that could not be had.
 */
export class CaptureShortcut {
  private bound: string | null = null;
  private wanted: string | null = null;
  private readonly register: Register;
  private readonly unregister: (accelerator: string) => void;
  private readonly onPress: () => void;
  private readonly log: (line: string) => void;
  constructor(register: Register, unregister: (accelerator: string) => void, onPress: () => void, log: (line: string) => void) {
    this.register = register;
    this.unregister = unregister;
    this.onPress = onPress;
    this.log = log;
  }

  get state(): CaptureShortcutState {
    return { accelerator: this.bound ?? this.wanted ?? DEFAULT_CAPTURE_SHORTCUT, registered: this.bound !== null };
  }

  bind(accelerator: string): CaptureShortcutState {
    if (accelerator === this.bound) return this.state;
    const tryRegister = (a: string) => {
      try {
        return this.register(a, this.onPress);
      } catch {
        return false;
      }
    };
    const old = this.bound;
    if (old) this.unregister(old);
    if (tryRegister(accelerator)) {
      this.bound = accelerator;
      this.wanted = null;
      this.log(`capture: shortcut ${accelerator} registered`);
    } else {
      this.log(`capture: shortcut ${accelerator} could not be registered (another app has it, or it is not a valid accelerator)`);
      this.bound = old && tryRegister(old) ? old : null;
      if (!this.bound) this.wanted = accelerator;
    }
    return this.state;
  }
}

export class CaptureWindow {
  private win: BrowserWindow | null = null;
  private readonly url: string;
  private readonly preload: string;
  private readonly log: (line: string) => void;
  readonly shortcut: CaptureShortcut;

  constructor(url: string, preload: string, log: (line: string) => void) {
    this.url = url;
    this.preload = preload;
    this.log = log;
    this.shortcut = new CaptureShortcut(
      (a, cb) => globalShortcut.register(a, cb),
      (a) => globalShortcut.unregister(a),
      () => this.toggle(),
      log,
    );
  }

  /** The shortcut again while the box has focus hides it, like Spotlight. */
  toggle(): void {
    if (this.win?.isVisible() && this.win.isFocused()) this.hide();
    else this.show();
  }

  show(): BrowserWindow {
    const win = (this.win ??= this.create());
    // On the screen the pointer is on, a quarter of the way down, centred.
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds({ x: Math.round(workArea.x + (workArea.width - WIDTH) / 2), y: Math.round(workArea.y + workArea.height / 4), width: WIDTH, height: HEIGHT });
    win.show();
    win.focus();
    win.webContents.send(CAPTURE_SHOWN_CHANNEL);
    return win;
  }

  hide(): void {
    this.win?.hide();
  }

  /** The window as it is now, for the smoke test's picture. */
  get window(): BrowserWindow | null {
    return this.win;
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // A non-activating panel: it floats over full-screen apps and never pulls the main window forward.
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      backgroundColor: "#121213",
      title: "Capture for the Chief",
      webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on("blur", () => win.hide());
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // Electron keeps a window whose renderer died (crashed, killed for memory), and showing it again shows no page:
    // it goes, and the next shortcut makes a new one. Never a reload loop for a page that dies at every start.
    win.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || win.isDestroyed()) return;
      this.log(`capture: page gone (${details.reason}, exit ${details.exitCode})`);
      win.destroy();
    });
    void win.loadURL(this.url);
    return win;
  }
}
