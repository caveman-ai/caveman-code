// Computer use's guide panel (docs/): a small panel that floats beside System
// Settings while the person allows Caveman Code, after agent-desktop's own guide, in the Caveman look (the page is
// apps/web/public/computer-guide.html). It opens System Settings at the permission it is on, shows the Caveman
// cursor dragging Caveman Code into the list, and lets the person drag the app itself: the tile starts a native drag
// of Caveman Code.app, which the list takes. It moves to the next permission the moment macOS reports this one, and
// "I added it" covers a grant macOS hasn't reported: Screen Recording is applied only once the app reopens, so the
// panel then offers to reopen it. The permissions are this app's own (systemPreferences), which is what macOS grants
// the runtime and agent-desktop under it.
import { app, BrowserWindow, nativeImage, screen, shell, systemPreferences } from "electron";
import { release } from "node:os";

import { COMPUTER_GUIDE_STATE_CHANNEL } from "./ipc.ts";

export type Permission = "accessibility" | "screen_recording";

export interface GuideState {
  readonly step: Permission | "reopen" | "done";
  /** 1-based, of `total`: the permissions this guide is walking through. */
  readonly index: number;
  readonly total: number;
  /** What macOS calls the Accessibility list: "Device Control and Data Access" from macOS 27. */
  readonly accessibilityName: string;
}

const WIDTH = 396;
const HEIGHT = 516;
const POLL_MS = 1_000;
/** "You're set" stays this long, then the panel goes. */
const DONE_MS = 2_400;
const ORDER: ReadonlyArray<Permission> = ["accessibility", "screen_recording"];
const PANES: Readonly<Record<Permission, string>> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen_recording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

/** Darwin 26 is macOS 26; Darwin 27, macOS 27, which renamed the Accessibility list. */
export const accessibilityName = (darwin: string = release()): string => (Number.parseInt(darwin, 10) >= 27 ? "Device Control and Data Access" : "Accessibility");

/** The app bundle a person drags into the list: Caveman Code.app (Electron.app in development). */
export const appBundle = (execPath: string = process.execPath): string | undefined => {
  const at = execPath.indexOf(".app/");
  return at < 0 ? undefined : execPath.slice(0, at + 4);
};

export interface Granted {
  readonly accessibility: boolean;
  readonly screen_recording: boolean;
}

/** This app's own grants, as macOS reports them now. */
export const granted = (): Granted => ({
  accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  screen_recording: systemPreferences.getMediaAccessStatus("screen") === "granted",
});

/**
 * The step a guide over `wanted` is on: the first permission not granted, "reopen" once the person said they added
 * Screen Recording that macOS still reports off, else "done".
 */
export const stepOf = (wanted: ReadonlyArray<Permission>, now: Granted, added: ReadonlySet<Permission>): GuideState["step"] => {
  for (const permission of wanted) {
    if (now[permission]) continue;
    return permission === "screen_recording" && added.has(permission) ? "reopen" : permission;
  }
  return "done";
};

export class ComputerGuide {
  private win: BrowserWindow | null = null;
  private timer: NodeJS.Timeout | undefined;
  private closing: NodeJS.Timeout | undefined;
  private wanted: ReadonlyArray<Permission> = ORDER;
  private readonly added = new Set<Permission>();
  private last: GuideState["step"] | undefined;
  private readonly url: string;
  private readonly preload: string;
  private readonly icon: string;
  private readonly log: (line: string) => void;
  private readonly read: () => Granted;

  constructor(url: string, preload: string, icon: string, log: (line: string) => void, read: () => Granted = granted) {
    this.url = url;
    this.preload = preload;
    this.icon = icon;
    this.log = log;
    this.read = read;
  }

  /** Shows the panel for `permission`, or for every permission still missing. */
  open(permission?: Permission): void {
    if (process.platform !== "darwin") return;
    const now = this.read();
    const missing = ORDER.filter((p) => !now[p]);
    this.wanted = permission ? [permission] : missing.length > 0 ? missing : ORDER;
    this.added.clear();
    this.last = undefined;
    clearTimeout(this.closing);
    const win = this.win ?? this.create();
    this.place(win);
    win.showInactive();
    this.tick(true);
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(false), POLL_MS);
    this.log(`computer guide: open for ${this.wanted.join(", ")}`);
  }

  /** The person's choice on the panel. */
  action(action: unknown): void {
    if (action === "close") return this.hide();
    if (action === "settings") return this.openSettings(this.current());
    if (action === "added") {
      const step = this.current();
      if (step === "accessibility" || step === "screen_recording") this.added.add(step);
      return this.tick(false);
    }
    if (action === "reopen") {
      this.log("computer guide: reopening the app for Screen Recording");
      this.hide();
      app.relaunch();
      app.quit();
    }
  }

  /** A native drag of the app bundle, from the tile: System Settings' list takes it. */
  drag(sender: Electron.WebContents): void {
    const file = appBundle();
    if (file === undefined) return;
    const icon = nativeImage.createFromPath(this.icon).resize({ width: 64, height: 64 });
    sender.startDrag({ file, icon });
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  private current() {
    return stepOf(this.wanted, this.read(), this.added);
  }

  private tick(first: boolean): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const step = this.current();
    const index = step === "accessibility" || step === "screen_recording" ? this.wanted.indexOf(step) + 1 : this.wanted.length;
    if (step !== this.last) {
      // Each permission's own pane, as the panel reaches it: the first, and the next once macOS reports one.
      if (step === "accessibility" || step === "screen_recording") this.openSettings(step);
      if (step === "done") this.closing = setTimeout(() => this.hide(), DONE_MS);
      this.last = step;
    }
    if (first || win.webContents.isLoading()) win.webContents.once("did-finish-load", () => this.send(step, index));
    this.send(step, index);
  }

  private send(step: GuideState["step"], index: number) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const state: GuideState = { step, index: Math.max(index, 1), total: this.wanted.length, accessibilityName: accessibilityName() };
    win.webContents.send(COMPUTER_GUIDE_STATE_CHANNEL, state);
  }

  private openSettings(step: GuideState["step"]) {
    if (step === "accessibility" || step === "screen_recording") void shell.openExternal(PANES[step]);
  }

  private hide(): void {
    clearInterval(this.timer);
    clearTimeout(this.closing);
    this.timer = undefined;
    this.win?.hide();
  }

  /** Beside System Settings: the right edge of the screen the pointer is on, halfway down. */
  private place(win: BrowserWindow) {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setPosition(Math.round(area.x + area.width - WIDTH - 28), Math.round(area.y + (area.height - HEIGHT) / 2));
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // A non-activating panel: it floats over System Settings and never pulls the main window forward.
      type: "panel",
      title: "Allow Caveman Code",
      webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on("closed", () => {
      if (this.win === win) this.win = null;
      clearInterval(this.timer);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    void win.loadURL(this.url);
    this.win = win;
    return win;
  }
}
