// The one description of `window.cavemanDesktop`: what the desktop shell's preload (src/preload.ts) exposes to the page.
// preload.ts builds its object `satisfies CavemanDesktop`, and apps/web types its `window.cavemanDesktop` with it, so
// the two cannot drift. Types only, with no Electron or Node imports: the web client imports it as `import type`
// (package.json "exports" ./bridge), and nothing here may reach a bundle.
//
// Every member is always present in the desktop app. Only `notch` is absent (a Mac's only). The page's own browser has no
// `window.cavemanDesktop` at all, so code checks the bridge, not its members.

import type { BugReportPrepared, BugReportRecord } from "@caveman-app/session-protocol";
import type { DevicePublicKey } from "@caveman-app/session-protocol/devices";

/** Stable gets releases; Nightly a build from main every day (src/updates/updateChannels.ts). */
export type UpdateChannel = "stable" | "nightly";

/** One build's notes from its update feed: a nightly's commit subjects, a release's short list. */
export interface UpdateReleaseNote {
  readonly version: string;
  readonly items: ReadonlyArray<string>;
  readonly releasedAt: string | null;
}

/** The desktop updater's state (src/updates/updateMachine.ts). Fields past `message` are absent before channels. */
export interface UpdateState {
  readonly status: "disabled" | "idle" | "checking" | "current" | "downloading" | "ready" | "error";
  /** This app's version. */
  readonly version: string;
  /** The newer version found, downloading or downloaded. */
  readonly next?: string | null;
  /** Why updates are off, what went wrong, or why a ready update cannot install now. */
  readonly message?: string | null;
  /** The channel picked here. */
  readonly channel?: UpdateChannel;
  /** The channel this build came from: a Nightly build on Stable stays until a newer Stable is out. */
  readonly buildChannel?: UpdateChannel;
  /** 0-100 while downloading. */
  readonly percent?: number | null;
  readonly failed?: "check" | "download" | "install" | null;
  readonly notes?: ReadonlyArray<UpdateReleaseNote>;
  /** The last install, to this version, did not take. */
  readonly notApplied?: string | null;
}

/** The runtime `caveman-code` started in a terminal, which the app uses but never stops; null when it uses its own. */
export interface AttachedRuntime {
  readonly pid: number;
  /** Its build version, null when it does not say. */
  readonly version: string | null;
  readonly appVersion: string;
  /** Another build than the app's: both versions known and different. */
  readonly skew: boolean;
}

export interface CliStatus {
  readonly launcher: string | null;
  readonly onPath: boolean;
  /** The link on PATH (macOS), or the launcher's folder that goes on the user's PATH (Windows). */
  readonly link: string;
  /** Absent from desktop builds before Windows: a link. */
  readonly via?: "link" | "user-path";
  readonly conflict: boolean;
  readonly error?: string;
}

export interface TelemetryChoice {
  readonly enabled: boolean;
  readonly envOff: boolean;
  /** A development build or the smoke test: nothing is sent either way. */
  readonly dryRun: boolean;
  /** A line naming turn stats has shown (onboarding, Settings or the one-time notice); absent from older desktops. */
  readonly turnsDisclosed?: boolean;
  /** A line naming crash reports has shown (the same three places); absent from older desktops. */
  readonly reportsDisclosed?: boolean;
}

/** Crash reports (src/crashReports.ts). */
export interface DesktopCrashReports {
  /** True once the desktop sends crash reports: the page then starts its own reporter, which reports through it. */
  enabled(): Promise<boolean>;
}

export interface DesktopUpdates {
  state(): Promise<UpdateState | null>;
  check(): Promise<UpdateState | null>;
  install(): void;
  /** Resolves to the state after the switch (it checks the new channel at once). */
  setChannel(channel: UpdateChannel): Promise<UpdateState | null>;
  attachedRuntime(): Promise<AttachedRuntime | null>;
}

export interface DesktopCli {
  status(): Promise<CliStatus | null>;
  install(): Promise<CliStatus | null>;
}

/** The global capture shortcut (src/capture.ts): what is bound, and whether macOS let us have it. */
export interface CaptureShortcutState {
  readonly accelerator: string;
  readonly registered: boolean;
}

export interface DesktopCapture {
  status(): Promise<CaptureShortcutState | null>;
  /** Bind another shortcut; the old one stays if this one is taken. */
  setShortcut(accelerator: string): Promise<CaptureShortcutState | null>;
}

/** Settings > General: keep this Mac from idle sleep while chats work (src/keepAwake.ts). */
export interface PowerState {
  readonly keepAwake: boolean;
  /** Holding idle sleep off right now: the setting is on and a chat works. */
  readonly holding: boolean;
}

export interface DesktopPower {
  get(): Promise<PowerState | null>;
  set(on: boolean): Promise<PowerState | null>;
}

/** The image viewer's way out of the app (src/media.ts): PNG bytes the shell checks and re-encodes. */
export interface DesktopMedia {
  /** macOS has a share menu; elsewhere the viewer offers no Share. */
  readonly canShare: boolean;
  /** Opens the image in the system's viewer (Preview on macOS). */
  open(name: string, png: ArrayBuffer): Promise<void>;
  /** The system share menu, at the pointer. */
  share(name: string, png: ArrayBuffer): Promise<void>;
  /** A web image's bytes, read by the shell outside the page's CORS and CSP; null on a network failure. */
  read(url: string): Promise<{
    readonly status: number;
    readonly mimeType: string;
    readonly data: Uint8Array;
  } | null>;
}

export interface DesktopTelemetry {
  choice(): Promise<TelemetryChoice | null>;
  set(enabled: boolean): Promise<TelemetryChoice | null>;
  step(name: string): void;
  crash(name: string): void;
  /** A line naming turn stats and crash reports is on screen: turns count, and crash reports may go, from now. */
  disclosed(): void;
}

/** Problem reports (src/bugReport.ts): a PNG of the window, and the report path while the runtime cannot run. */
export interface DesktopBugReport {
  screenshot(): Promise<ArrayBuffer | null>;
  prepare(input: unknown): Promise<BugReportPrepared>;
  queue(input: unknown): Promise<BugReportRecord>;
  done(): void;
}

/** This app's device key for driving another Mac through Caveman Cloud (src/deviceKey.ts): main signs, the key stays sealed there. */
export interface DesktopDeviceKey {
  describe(): Promise<{ readonly name: string; readonly public_key: DevicePublicKey }>;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** What preload.ts exposes as `window.cavemanDesktop`. */
export interface CavemanDesktop {
  /** The endpoint of the runtime this app started (or attached to); null when there is none. */
  readonly runtime: { url: string; token: string } | null;
  /** A packaged app that is not the smoke test: onboarding requires a Caveman sign-in only here. */
  readonly packaged: boolean;
  /** ⌘W: return true when the page took it (closed a tab); otherwise the window closes. Returns the unsubscribe. */
  onCloseRequest(handler: () => boolean): () => void;
  /** After the Mac woke: what closing the lid did with the chats working here (moved to Cloud, or paused). Returns the unsubscribe. */
  onLidOutcome(
    handler: (outcome: { moving: number; paused: number; chats?: string[]; at?: number }) => void,
  ): () => void;
  closeWindow(): void;
  /** Settings > Appearance's theme, for the window's translucent material. */
  setTheme(theme: "system" | "light" | "dark"): void;
  /** The native folder picker (Add project); null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Computer use's guide panel over System Settings (src/computerGuide.ts), for one permission or the missing ones, and reopening the app. */
  computerGuide: {
    open(permission?: "accessibility" | "screen_recording"): void;
    reopen(): void;
  };
  /** A dropped file's or folder's path on disk, "" when it has none (Electron's webUtils.getPathForFile). */
  pathForFile(file: File): string;
  /** A folder on this Mac in Finder (selected, never opened), or a new Terminal window there (src/folders.ts). */
  revealFolder(path: string): void;
  openTerminal(path: string): void;
  /** The Dock badge: sessions that posted a notice while the app was away; 0 clears it. */
  setBadge(count: number): void;
  /** Brings the desktop window back from closed and to the front (window.focus() cannot show a closed one). */
  showWindow(): void;
  /** The app's bound chords: pressed in a side-panel browser page, the desktop replays them on the page. */
  setGuestShortcuts(chords: string[]): void;
  /** Untrusted HTML has its own response origin and CSP, not the app's. */
  htmlPreview: { create(html: string): Promise<string | null>; release(url: string): void };
  updates: DesktopUpdates;
  cli: DesktopCli;
  device: DesktopDeviceKey;
  power: DesktopPower;
  /** Calls with the Chief and talking to type: the microphone's macOS permission ("granted", "denied", "not-determined"...), asked once. */
  microphone: { status(): Promise<string>; ask(): Promise<boolean>; openSettings(): void };
  capture: DesktopCapture;
  media: DesktopMedia;
  telemetry: DesktopTelemetry;
  crashReports: DesktopCrashReports;
  bugReport: DesktopBugReport;
  /** The notch at the top of the screen (src/notch.ts), a Mac's only: what it shows, or null to put it away, and what was done on it. Returns the unsubscribe. */
  notch?: { feed(state: unknown): void; onAction(handler: (action: unknown) => void): () => void };
  /** The side panel's local browser renders a <webview> in this partition (src/browser.ts). */
  browser: {
    partition: string;
    /** Asks, then clears that partition's cookies, site data and cache; true when cleared. */
    clearData(): Promise<boolean>;
  };
}
