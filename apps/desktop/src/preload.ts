// ), apps/desktop/src/preload.ts @ ab3a3cd1.
// Sandboxed, context-isolated preload. It exposes exactly what the web client
// reads, as typed in src/bridge.ts (CavemanDesktop; the exposed object `satisfies` it): window.cavemanDesktop.runtime, plus
// onCloseRequest/closeWindow so ⌘W closes a side panel tab before the window,
// pickFolder and pathForFile (a folder dropped on the sidebar) for Add project, updates, the `caveman-code` command and the
// crash/onboarding counts choice for Settings > General, and the capture
// shortcut for Settings > Chief, the side panel browser's partition, the
// Dock badge for notices posted while the app was away, the image
// viewer's open and share, whether this is the packaged app, what the
// lid did while the Mac slept (onLidOutcome), and on a Mac the notch: what
// it shows and what the person did on it.
// Dropped from T3: Clerk, previews, snapshots, SSH, window controls.
//
// Also Sentry's renderer bridge (window.__SENTRY_IPC__): the page's crash reports go to the main process, which scrubs
// and gates them with its own (src/crashReports.ts). It sends nothing unless the page starts its reporter, which it
// does only when crashReports.enabled() says so.
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import "@sentry/electron/preload";
import { BROWSER_PARTITION } from "./browser.ts";
import type { CavemanDesktop } from "./bridge.ts";
import { createCloseRouter, type CloseHandler } from "./closeRouter.ts";
import {
  BADGE_CHANNEL,
  BUG_REPORT_DONE_CHANNEL,
  BUG_REPORT_PREPARE_CHANNEL,
  BUG_REPORT_QUEUE_CHANNEL,
  BUG_REPORT_SCREENSHOT_CHANNEL,
  BROWSER_CLEAR_CHANNEL,
  HTML_PREVIEW_CREATE_CHANNEL,
  HTML_PREVIEW_RELEASE_CHANNEL,
  CAPTURE_SHORTCUT_CHANNEL,
  CAPTURE_STATUS_CHANNEL,
  CLI_INSTALL_CHANNEL,
  CLI_STATUS_CHANNEL,
  CLOSE_REQUEST_CHANNEL,
  CLOSE_WINDOW_CHANNEL,
  FULLSCREEN_CHANNEL,
  LID_OUTCOME_CHANNEL,
  GUEST_KEY_CHANNEL,
  GUEST_SHORTCUTS_CHANNEL,
  THEME_CHANNEL,
  ZOOM_CHANNEL,
  OPEN_TERMINAL_CHANNEL,
  PACKAGED_ARG,
  MEDIA_OPEN_CHANNEL,
  MEDIA_READ_CHANNEL,
  MEDIA_SHARE_CHANNEL,
  DEVICE_DESCRIBE_CHANNEL,
  DEVICE_SIGN_CHANNEL,
  PICK_FOLDER_CHANNEL,
  POWER_GET_CHANNEL,
  MIC_STATUS_CHANNEL,
  MIC_ASK_CHANNEL,
  MIC_SETTINGS_CHANNEL,
  POWER_SET_CHANNEL,
  REVEAL_FOLDER_CHANNEL,
  RUNTIME_CHANNEL,
  SHOW_WINDOW_CHANNEL,
  TELEMETRY_CHOICE_CHANNEL,
  TELEMETRY_CRASH_CHANNEL,
  TELEMETRY_DISCLOSED_CHANNEL,
  CRASH_REPORTS_CHANNEL,
  TELEMETRY_SET_CHANNEL,
  TELEMETRY_STEP_CHANNEL,
  UPDATES_CHECK_CHANNEL,
  UPDATES_INSTALL_CHANNEL,
  UPDATES_RUNTIME_CHANNEL,
  UPDATES_SET_CHANNEL_CHANNEL,
  UPDATES_STATE_CHANNEL,
  COMPUTER_GUIDE_ACTION_CHANNEL,
  COMPUTER_GUIDE_OPEN_CHANNEL,
  NOTCH_ACTION_CHANNEL,
  NOTCH_FEED_CHANNEL,
} from "./ipc.ts";

const runtime = ipcRenderer.sendSync(RUNTIME_CHANNEL) as { url: string; token: string } | null;
const closeWindow = () => ipcRenderer.send(CLOSE_WINDOW_CHANNEL);
const close = createCloseRouter(closeWindow);
/** The main process answers an error message or null; the page gets a rejection or nothing. */
const settle = (answer: unknown) => {
  if (typeof answer === "string") throw new Error(answer);
};
ipcRenderer.on(CLOSE_REQUEST_CHANNEL, () => close.request());
// html[data-fullscreen]: the title bar drops the traffic lights' inset (apps/web styles.css).
ipcRenderer.on(FULLSCREEN_CHANNEL, (_event, on: unknown) => document.documentElement.toggleAttribute("data-fullscreen", on === true));
// An app chord pressed in a side-panel browser page (src/guestKeys.ts): replayed on that page's <webview>, so it
// bubbles to its browser bar's chords and to the app's window listeners as a key press here would.
type GuestKey = { guest: number; key: string; code: string; meta: boolean; control: boolean; alt: boolean; shift: boolean };
ipcRenderer.on(GUEST_KEY_CHANNEL, (_event, k: GuestKey) => {
  const init = { key: k.key, code: k.code, metaKey: k.meta, ctrlKey: k.control, altKey: k.alt, shiftKey: k.shift, bubbles: true, cancelable: true, composed: true };
  // data-guest-id: set by the page once the guest is ready (apps/web panels/browser/BrowserSurface.tsx).
  const view = Number.isInteger(k.guest) ? document.querySelector(`webview[data-guest-id="${k.guest}"]`) : null;
  (view ?? document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", init));
});

// ⌘+ and ⌘- scale the page, but a Mac's traffic lights keep their size and place. The page's title band clears
// them by `--zoom` (apps/web styles.css) and main moves them to the band's middle, so neither drifts onto the other.
// A zoom change resizes the page's viewport, so resize catches it.
let zoom = 0;
const followZoom = () => {
  const next = webFrame.getZoomFactor();
  if (next === zoom) return;
  zoom = next;
  document.documentElement.style.setProperty("--zoom", String(next));
  ipcRenderer.send(ZOOM_CHANNEL, next);
};
window.addEventListener("resize", followZoom);
window.addEventListener("DOMContentLoaded", followZoom);

contextBridge.exposeInMainWorld("cavemanDesktop", {
  htmlPreview: {
    create: (html: string) => ipcRenderer.invoke(HTML_PREVIEW_CREATE_CHANNEL, html) as Promise<string | null>,
    release: (url: string) => ipcRenderer.send(HTML_PREVIEW_RELEASE_CHANNEL, url),
  },
  runtime,
  /** A packaged app that is not the smoke test: onboarding requires a Cloud sign-in only here (development and E2E skip it). */
  packaged: process.argv.includes(PACKAGED_ARG),
  /** Return true from the handler when the page took ⌘W (e.g. closed a tab). */
  onCloseRequest: (handler: CloseHandler) => close.register(handler),
  /**
   * The Mac woke after the lid moved chats to Cloud (`moving`) or stopped their turns (`paused`), sent only when one
   * of them is above 0 (src/lid.ts lidReport), with the stopped chats' session ids (`chats`) and when the lid closed
   * (`at`, ms). Returns the unsubscribe.
   */
  onLidOutcome: (handler: (outcome: { moving: number; paused: number; chats?: string[]; at?: number }) => void) => {
    const listener = (_event: unknown, outcome: { moving?: unknown; paused?: unknown; chats?: unknown; at?: unknown } | null) => {
      const chats = Array.isArray(outcome?.chats) ? outcome.chats.filter((c): c is string => typeof c === "string") : [];
      const at = Number(outcome?.at);
      handler({ moving: Number(outcome?.moving) || 0, paused: Number(outcome?.paused) || 0, ...(chats.length > 0 ? { chats } : {}), ...(Number.isFinite(at) && at > 0 ? { at } : {}) });
    };
    ipcRenderer.on(LID_OUTCOME_CHANNEL, listener);
    return () => void ipcRenderer.removeListener(LID_OUTCOME_CHANNEL, listener);
  },
  closeWindow,
  setTheme: (theme: string) => ipcRenderer.send(THEME_CHANNEL, String(theme)),
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL) as Promise<string | null>,
  /** Computer use's guide panel over System Settings (src/computerGuide.ts), for one permission or the missing ones. */
  computerGuide: {
    open: (permission?: "accessibility" | "screen_recording") => ipcRenderer.send(COMPUTER_GUIDE_OPEN_CHANNEL, permission ?? null),
    /** macOS applies Screen Recording once the app reopens. */
    reopen: () => ipcRenderer.send(COMPUTER_GUIDE_ACTION_CHANNEL, "reopen"),
  },
  /** Where a dropped file or folder lives on disk ("" for one that is not on disk): a folder dropped on the sidebar is added as a project. */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  /** A project's folder or a chat's worktree, in Finder or a new Terminal window (src/folders.ts). */
  revealFolder: (path: string) => ipcRenderer.send(REVEAL_FOLDER_CHANNEL, String(path)),
  openTerminal: (path: string) => ipcRenderer.send(OPEN_TERMINAL_CHANNEL, String(path)),
  /** The Dock badge: sessions that posted a notice while the app was away (apps/web state/notifications.ts). */
  setBadge: (count: number) => ipcRenderer.send(BADGE_CHANNEL, Number(count)),
  /** Brings the window back from closed (hidden) and to the front: a page's window.focus() cannot. */
  showWindow: () => ipcRenderer.send(SHOW_WINDOW_CHANNEL),
  /** The app's bound chords: pressed in a side-panel browser page, they come back here as key presses. */
  setGuestShortcuts: (chords: string[]) => ipcRenderer.send(GUEST_SHORTCUTS_CHANNEL, Array.isArray(chords) ? chords.map(String) : []),
  updates: {
    state: () => ipcRenderer.invoke(UPDATES_STATE_CHANNEL),
    check: () => ipcRenderer.invoke(UPDATES_CHECK_CHANNEL),
    install: () => ipcRenderer.send(UPDATES_INSTALL_CHANNEL),
    setChannel: (channel: string) => ipcRenderer.invoke(UPDATES_SET_CHANNEL_CHANNEL, String(channel)),
    attachedRuntime: () => ipcRenderer.invoke(UPDATES_RUNTIME_CHANNEL),
  },
  cli: {
    status: () => ipcRenderer.invoke(CLI_STATUS_CHANNEL),
    install: () => ipcRenderer.invoke(CLI_INSTALL_CHANNEL),
  },
  /** This app's device key for driving another Mac through Caveman Cloud (src/deviceKey.ts): main signs, the key stays sealed there. */
  device: {
    describe: () => ipcRenderer.invoke(DEVICE_DESCRIBE_CHANNEL),
    sign: async (data: Uint8Array) => new Uint8Array(await ipcRenderer.invoke(DEVICE_SIGN_CHANNEL, data)),
  },
  /** Settings > General: keep this Mac from idle sleep while chats work (src/keepAwake.ts). */
  power: {
    get: () => ipcRenderer.invoke(POWER_GET_CHANNEL),
    set: (on: boolean) => ipcRenderer.invoke(POWER_SET_CHANNEL, on === true),
  },
  /** Calls with the Chief and talking to type: the microphone's macOS permission ("granted", "denied", "not-determined"...), asked once. */
  microphone: {
    status: () => ipcRenderer.invoke(MIC_STATUS_CHANNEL) as Promise<string>,
    ask: () => ipcRenderer.invoke(MIC_ASK_CHANNEL) as Promise<boolean>,
    openSettings: () => ipcRenderer.send(MIC_SETTINGS_CHANNEL),
  },
  capture: {
    status: () => ipcRenderer.invoke(CAPTURE_STATUS_CHANNEL),
    setShortcut: (accelerator: string) => ipcRenderer.invoke(CAPTURE_SHORTCUT_CHANNEL, String(accelerator)),
  },
  media: {
    canShare: process.platform === "darwin",
    open: async (name: string, png: ArrayBuffer) => settle(await ipcRenderer.invoke(MEDIA_OPEN_CHANNEL, String(name), png)),
    share: async (name: string, png: ArrayBuffer) => settle(await ipcRenderer.invoke(MEDIA_SHARE_CHANNEL, String(name), png)),
    /** A web image's bytes, read by the shell when the page's own fetch is refused (CORS, CSP); null on a network failure. */
    read: (url: string) => ipcRenderer.invoke(MEDIA_READ_CHANNEL, String(url)),
  },
  telemetry: {
    choice: () => ipcRenderer.invoke(TELEMETRY_CHOICE_CHANNEL),
    set: (enabled: boolean) => ipcRenderer.invoke(TELEMETRY_SET_CHANNEL, enabled === true),
    step: (name: string) => ipcRenderer.send(TELEMETRY_STEP_CHANNEL, String(name)),
    crash: (name: string) => ipcRenderer.send(TELEMETRY_CRASH_CHANNEL, String(name)),
    disclosed: () => ipcRenderer.send(TELEMETRY_DISCLOSED_CHANNEL),
  },
  /** Crash reports (src/crashReports.ts): true once the main process sends them, so the page starts its reporter. */
  crashReports: {
    enabled: (): Promise<boolean> => ipcRenderer.invoke(CRASH_REPORTS_CHANNEL),
  },
  /**
   * Problem reports (src/bugReport.ts): a PNG of this window, or null; and, while the runtime cannot run, a report
   * prepared from this app's logs and queued for the runtime's next start (shapes as bug_report.prepare and send).
   */
  bugReport: {
    screenshot: () => ipcRenderer.invoke(BUG_REPORT_SCREENSHOT_CHANNEL) as Promise<ArrayBuffer | null>,
    prepare: (input: unknown) => ipcRenderer.invoke(BUG_REPORT_PREPARE_CHANNEL, input),
    queue: (input: unknown) => ipcRenderer.invoke(BUG_REPORT_QUEUE_CHANNEL, input),
    done: () => ipcRenderer.send(BUG_REPORT_DONE_CHANNEL),
  },
  // The notch at the top of the screen (src/notch.ts), a Mac's only: this page says what it shows, or null to put it away,
  // and hears what the person did on it. Returns the unsubscribe.
  ...(process.platform === "darwin"
    ? {
        notch: {
          feed: (state: unknown) => ipcRenderer.send(NOTCH_FEED_CHANNEL, state ?? null),
          onAction: (handler: (action: unknown) => void) => {
            const listener = (_event: unknown, action: unknown) => handler(action);
            ipcRenderer.on(NOTCH_ACTION_CHANNEL, listener);
            return () => void ipcRenderer.removeListener(NOTCH_ACTION_CHANNEL, listener);
          },
        },
      }
    : {}),
  /** The side panel's local browser renders a <webview> in this partition (src/browser.ts). */
  browser: {
    partition: BROWSER_PARTITION,
    /** Asks, then clears that partition's cookies, site data and cache; true when cleared. */
    clearData: () => ipcRenderer.invoke(BROWSER_CLEAR_CHANNEL) as Promise<boolean>,
  },
} satisfies CavemanDesktop);
