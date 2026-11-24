// ), apps/desktop/src/main.ts @ ab3a3cd1.
// Also from app/DesktopApp.ts, window/DesktopWindow.ts and
// window/DesktopApplicationMenu.ts, without upstream Effect layer graph: one
// window, one local runtime.
// Dropped from T3: Clerk and T3 Connect, mobile pairing, SSH/WSL/Tailscale
// backends, previews and snapshots, legacy localStorage migration. Updates,
// the CLI launcher, startup recovery and telemetry are smaller cuts
// (updates/, cli.ts, startupRecovery.ts, telemetry.ts).
import { execFile, spawn } from "node:child_process";
import { createPublicKey, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { connect } from "@caveman-app/session-protocol/client";
import { APP_SCHEME, APP_URL, isOwnFrame, micOnly, serveAsset } from "./assets.ts";
import { HtmlPreviews, HTML_PREVIEW_HOST } from "./htmlPreview.ts";
import { BROWSER_PARTITION, GUEST_PERMISSIONS, guestWindowOpenAction, isGuestUrl, mayAttach, POPUP_WINDOW_OPTIONS } from "./browser.ts";
import { CaptureWindow, DEFAULT_CAPTURE_SHORTCUT } from "./capture.ts";
import { ComputerGuide } from "./computerGuide.ts";
import { notchAction, NotchWindow, type NotchAction } from "./notch.ts";
import { isCloseChord, windowCloseAction } from "./closeRouter.ts";
import { folderToOpen, terminalCommand } from "./folders.ts";
import { chordOfInput, forwardedChords } from "./guestKeys.ts";
import { contextMenuTemplate } from "./contextMenu.ts";
import { addToUserPath, cliStatus, installOnPath, registryUserPath, userPathStatus, writeLauncher } from "./cli.ts";
import { badgeCount } from "./badge.ts";
import {
  BADGE_CHANNEL,
  BROWSER_CLEAR_CHANNEL,
  BUG_REPORT_DONE_CHANNEL,
  BUG_REPORT_PREPARE_CHANNEL,
  BUG_REPORT_QUEUE_CHANNEL,
  BUG_REPORT_SCREENSHOT_CHANNEL,
  HTML_PREVIEW_CREATE_CHANNEL,
  HTML_PREVIEW_RELEASE_CHANNEL,
  CAPTURE_CLOSE_CHANNEL,
  CAPTURE_SHORTCUT_CHANNEL,
  CAPTURE_STATUS_CHANNEL,
  CAPTURE_SUBMIT_CHANNEL,
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
  MEDIA_OPEN_CHANNEL,
  MEDIA_READ_CHANNEL,
  MEDIA_SHARE_CHANNEL,
  DEVICE_DESCRIBE_CHANNEL,
  DEVICE_SIGN_CHANNEL,
  PACKAGED_ARG,
  PICK_FOLDER_CHANNEL,
  POWER_GET_CHANNEL,
  MIC_STATUS_CHANNEL,
  MIC_ASK_CHANNEL,
  MIC_SETTINGS_CHANNEL,
  POWER_SET_CHANNEL,
  REVEAL_FOLDER_CHANNEL,
  RUNTIME_CHANNEL,
  SHOW_WINDOW_CHANNEL,
  CRASH_REPORTS_CHANNEL,
  TELEMETRY_CHOICE_CHANNEL,
  TELEMETRY_CRASH_CHANNEL,
  TELEMETRY_DISCLOSED_CHANNEL,
  TELEMETRY_SET_CHANNEL,
  TELEMETRY_STEP_CHANNEL,
  UPDATES_CHECK_CHANNEL,
  UPDATES_INSTALL_CHANNEL,
  UPDATES_RUNTIME_CHANNEL,
  UPDATES_SET_CHANNEL_CHANNEL,
  UPDATES_STATE_CHANNEL,
  COMPUTER_GUIDE_ACTION_CHANNEL,
  COMPUTER_GUIDE_DRAG_CHANNEL,
  COMPUTER_GUIDE_OPEN_CHANNEL,
  NOTCH_ACT_CHANNEL,
  NOTCH_ACTION_CHANNEL,
  NOTCH_FEED_CHANNEL,
  NOTCH_MENU_CHANNEL,
  NOTCH_OVER_CHANNEL,
  NOTCH_READY_CHANNEL,
} from "./ipc.ts";
import { routeFromDeepLink } from "./links.ts";
import { DesktopBugReports, desktopEnvironment, runtimeStateDir } from "./bugReport.ts";
import {
  bundleOf,
  conflictMessage,
  conflictOf,
  diskImageMounts,
  installerToEject,
  MOVE_QUESTION,
  plistString,
  readMoveRecord,
  shouldOfferMove,
  writeMoveRecord,
} from "./moveToApplications.ts";
import { openPicture, readWebMedia, sharePicture } from "./media.ts";
import { assertNoSigusr1Inspector, bundledNode, requestInspector, runtimeCommand, RuntimeSupervisor, versionSkew } from "./runtime.ts";
import { holdAwake, KEEP_AWAKE_POLL_MS, KeepAwake, readKeepAwake, WorkingSet, writeKeepAwake } from "./keepAwake.ts";
import { DesktopAgentsKey } from "./agentsKey.ts";
import { DesktopDeviceKey, macName } from "./deviceKey.ts";
import { closeLid, lidReport } from "./lid.ts";
import { askBeforeQuit, onQuitSignal, quitQuestion, stopAsking, workingHere } from "./quitGuard.ts";
import { runtimeClient, type RuntimeClient } from "./runtimeClient.ts";
import { Telemetry, type AskTurns } from "./telemetry.ts";
import type { CrashReports } from "./crashReports.ts";
import { StartupRecovery } from "./startupRecovery.ts";
import { Updates } from "./updates/DesktopUpdates.ts";
import { channelOf } from "./updates/updateChannels.ts";
import { RECOVERY_DELAY_MS, RendererRecovery } from "./rendererRecovery.ts";
import { RotatingLog } from "./rotatingLog.ts";
import { initialBounds, MIN_SIZE, readWindowState, SAVE_DELAY_MS, sameState, writeWindowState, type WindowState } from "./windowState.ts";

// Before anything spawns: Windows looks for a bare command name (`git`, `node` in development) in the current directory
// before PATH. Off for this process and the shells it starts (packages/shared/src/exeSearch.ts, which tests it).
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";

const SMOKE = process.argv.includes("--smoke-test");
const MAC = process.platform === "darwin";
const WINDOWS = process.platform === "win32";
// Builds made without --release carry Resources/test-build (scripts/package.mjs):
// they, development and the smoke test take the test overrides below.
const TEST_BUILD = !app.isPackaged || SMOKE || existsSync(join(process.resourcesPath, "test-build"));
const REPO_ROOT = resolve(__dirname, "../../..");
// A smoke run never touches a keychain. Its HOME is a temp dir with no login keychain, so the first safeStorage seal
// (the device key Settings > General shows, the agents key) would wait on macOS's prompt to make one, which a headless
// run never answers, with main's thread blocked and the app never quitting. Chromium's mock keychain instead: the keys
// are still made, sealed and read back. Before `ready`, when safeStorage first reads its key.
if (SMOKE && MAC) app.commandLine.appendSwitch("use-mock-keychain");

// Must run before `ready`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

// Dev and packaged builds keep separate profiles (and single-instance locks).
if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", join(app.getPath("appData"), "Caveman Code (Dev)"));
}
// Windows groups the taskbar button and attributes notifications by this id; the installer's shortcut carries the
// same one (electron-builder's appId, scripts/package.mjs). Ported from upstream DesktopAppIdentity.
if (WINDOWS) app.setAppUserModelId("so.caveman.code");

const logDir = join(app.getPath("userData"), "logs");
mkdirSync(logDir, { recursive: true });
const logFile = new RotatingLog(logDir);
const log = (line: string) => {
  console.log(line);
  logFile.write(`${new Date().toISOString()} ${line}\n`);
};

// Native crashes leave a minidump in the crashDumps dir. Crash reports (src/crashReports.ts), where they are on, send it
// at the next start or as the process goes; elsewhere it stays for a person to send. Before any window or child starts.
crashReporter.start({ uploadToServer: false });
// Packaged builds send; development and the smoke test only when pointed at a receiver.
const telemetryUrl = TEST_BUILD ? process.env.CAVEMAN_TELEMETRY_URL : undefined;
/** How often turn stats are asked for and sent (a test build may ask sooner, to watch them arrive). */
const TURN_STATS_EVERY_MS = (TEST_BUILD && Number(process.env.CAVEMAN_TURN_STATS_MS)) || 60_000;
/** The runtime's settings.cloud_url, once the runtime is up (set below): telemetry goes where that Cloud says. */
let cloudInUse: (() => Promise<string | undefined>) | undefined;
const telemetry = new Telemetry({
  file: join(app.getPath("userData"), "telemetry.json"),
  version: app.getVersion(),
  log,
  url: telemetryUrl,
  dryRun: !telemetryUrl && (!app.isPackaged || SMOKE),
  cloud: () => (cloudInUse ? cloudInUse() : Promise.reject(new Error("no runtime yet"))),
});
/** Set by scripts/build.mjs from CAVEMAN_CRASH_DSN (the release workflows'); absent from source and in tests. */
declare const __CAVEMAN_CRASH_DSN__: string | undefined;
/**
 * Caveman's crash service for this build; a test build may name its own receiver instead, and the smoke test of a
 * release build reports only to one it names. None: no crash reports.
 */
const crashDsn = (TEST_BUILD && process.env.CAVEMAN_CRASH_DSN?.trim()) || (!SMOKE && typeof __CAVEMAN_CRASH_DSN__ === "string" ? __CAVEMAN_CRASH_DSN__ : "") || undefined;
/** Where the runtime this app starts writes its crash reports, for the app to send (src/crashReports.ts). */
const crashSpool = join(app.getPath("userData"), "crash-reports");
let crashReports: CrashReports | undefined;
/** Crash reports loading (they load once the app is ready, and only where they could go); undefined: not started. */
let crashReportsStarting: Promise<CrashReports | undefined> | undefined;
const startCrashReports = () => {
  if (crashDsn === undefined || crashReportsStarting !== undefined || !telemetry.crashReportsPossible) return;
  crashReportsStarting = Promise.resolve()
    // Bundled on its own (scripts/build.mjs): Sentry is read from disk only here.
    .then(() => require(join(__dirname, "crash-reports.cjs")) as typeof import("./crashReports.ts"))
    .then(({ startCrashReports: start }) =>
      start({
        dsn: crashDsn,
        version: app.getVersion(),
        channel: BUILD_CHANNEL,
        gate: () => telemetry.crashGate(),
        onChange: (listener) => telemetry.onChange(listener),
        anonymousId: () => telemetry.anonymousId,
        spoolDir: crashSpool,
        homeDir: homedir(),
        userName: (() => {
          try {
            return userInfo().username;
          } catch {
            return undefined;
          }
        })(),
        log,
      }),
    )
    .then(
      (started) => (crashReports = started),
      (error: unknown) => (log(`crash reports: could not start: ${error instanceof Error ? error.message : String(error)}`), undefined),
    );
};
// The monitor counts, and reports, without changing what Electron does with the error.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  log(`main: ${origin}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  const kind = origin === "unhandledRejection" ? "main_rejection" : "main_exception";
  telemetry.crash(kind, error instanceof Error ? error.name : undefined);
  crashReports?.capture(error, kind);
});
const updates = new Updates(log, app.getPath("userData"));
/** Restart to Update the way Settings does it, the runtime stopped first; set once the app is ready (below). */
let restartToUpdate: () => void = () => void updates.install();

// Moved by mistake (src/moveToApplications.ts): a packaged Mac app outside Applications asks to move there before its
// window, and before its runtime, which a move would only stop again. Back in Applications, it ejects the installer
// it moved from.
const moveFile = join(app.getPath("userData"), "move-to-applications.json");
const moveRecord = MAC && app.isPackaged ? readMoveRecord(moveFile) : {};
const offerMove = shouldOfferMove({
  platform: process.platform,
  packaged: app.isPackaged,
  smoke: SMOKE,
  inApplications: MAC && app.isInApplicationsFolder(),
  version: app.getVersion(),
  record: moveRecord,
});
const execFileAsync = promisify(execFile);
/** A string from an app bundle's Info.plist; null when unreadable or absent. */
const bundleString = (bundle: string, key: string): string | null => {
  try {
    return plistString(readFileSync(join(bundle, "Contents/Info.plist"), "utf8"), key);
  } catch {
    return null;
  }
};

// Tests swap the entry. A packaged build honours that only in --smoke-test,
// and still runs it the packaged way, so the smoke covers the real spawn.
const runtimeEntry =
  (!app.isPackaged || SMOKE ? process.env.CAVEMAN_RUNTIME_ENTRY : undefined) ??
  (app.isPackaged ? join(process.resourcesPath, "runtime", "bin.mjs") : join(REPO_ROOT, "packages/runtime/src/bin.ts"));
// Packaged: the Node shipped beside the bundle (scripts/package.mjs; node.exe
// on Windows), so the Electron binary never acts as Node and its runAsNode
// fuse stays off. Development: the system Node 22, whose ABI matches node-pty
// in node_modules.
const runtimeNode = app.isPackaged ? bundledNode(process.resourcesPath) : "node";
// Packaged on macOS: the runtime's start as prepared bytecode (src/serverCompileCache.ts). Never on Windows, where
// Node's compile cache stays off (its synchronous writes slowed the start by seconds), and never for a test's entry.
const compileCachePreload = app.isPackaged && !WINDOWS && runtimeEntry === join(process.resourcesPath, "runtime", "bin.mjs") ? join(process.resourcesPath, "runtime", "serverCompileCache.mjs") : undefined;

// Packaged: the one copy of the web client, inside the runtime bundle, which
// also serves it at / for a browser link from `caveman code`.
const webDir = app.isPackaged ? join(process.resourcesPath, "runtime", "client") : join(REPO_ROOT, "apps/web/dist");
let mainWindow: BrowserWindow | null = null;
/** Main's own calls to its runtime, on one kept socket (src/runtimeClient.ts); set once the runtime has started. */
let runtime: RuntimeClient | null = null;
let capture: CaptureWindow | null = null;
let notch: NotchWindow | null = null;
let pendingRoute: string | null = null;
// Set once the scheme handler and IPC exist; a window opened before then loads nothing.
let booted = false;
// Set when the app quits (or the updater quits it): the window closes for real.
let quitting = false;
// The app's chords a side-panel browser page hands back (src/guestKeys.ts); the page sends its bound ones.
let guestChords = forwardedChords([]);

const setRoute = (win: BrowserWindow, route: string) => void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#${route}`)}`);

/**
 * A page still loading takes the route once it has loaded (did-finish-load below). Only the page's own load counts, as
 * in upstream dispatchRendererEvent: isLoading is also true while an iframe in it loads (the side panel's HTML preview),
 * and no did-finish-load follows that.
 */
function navigate(route: string): void {
  const win = showWindow();
  if (win.webContents.isLoadingMainFrame()) {
    pendingRoute = route;
    return;
  }
  setRoute(win, route);
}

/**
 * Help > What's New: over whatever is open, as ⌘K opens it (the client's "caveman:whats-new" event,
 * apps/web whats-new/WhatsNew.tsx). A window still loading takes the /whats-new route, which opens it over the Chief.
 */
function openWhatsNew(): void {
  const win = showWindow();
  if (win.webContents.isLoadingMainFrame()) return navigate("/whats-new");
  void win.webContents.executeJavaScript(`window.dispatchEvent(new Event("caveman:whats-new"))`);
}

/**
 * What a report (and the runtime's) says it came from: the build that runs, which its version names. A stable build
 * following the Nightly update channel says "stable" until a nightly installs over it.
 */
const BUILD_CHANNEL = app.isPackaged ? (TEST_BUILD ? "test" : channelOf(app.getVersion())) : "dev";
/** The runtime's home: the dev profile keeps its own; packaged shares the runtime default with `caveman code`. */
const runtimeHome = app.isPackaged ? undefined : join(app.getPath("userData"), "runtime");
/** A report to open once the page has loaded (the page also reads it on mount: its listener may not exist yet). */
let pendingReport: unknown = null;

/**
 * Help > Report a Problem…, and the button of the crash questions and the startup recovery window: the page's report
 * over whatever is open (apps/web shell/ReportProblem.tsx listens for "caveman:report-problem"). Nothing is gathered
 * or sent until the person reads the preview there and presses Send.
 */
function openReport(detail: { surface: string; error?: { name?: string; message: string } }): void {
  const win = showWindow();
  // The main frame only, as navigate(): an iframe in the page (an agent's report.html) may load for a long time.
  if (win.webContents.isLoadingMainFrame()) {
    pendingReport = detail;
    return;
  }
  sendReport(win, detail);
}

function sendReport(win: BrowserWindow, detail: unknown): void {
  const json = JSON.stringify(detail);
  void win.webContents.executeJavaScript(`window.cavemanPendingReport = ${json}; window.dispatchEvent(new CustomEvent("caveman:report-problem", { detail: ${json} }))`);
}

function openDeepLink(raw: string): void {
  const route = routeFromDeepLink(raw);
  if (route === null) return;
  if (booted) navigate(route);
  else pendingRoute = route;
}

/** Reopens where it was left (src/windowState.ts). */
function trackWindowState(win: BrowserWindow, file: string, saved: WindowState | null): void {
  let last = saved;
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed() || win.isMinimized()) return;
    // Maximized or full screen: keep the size it returns to.
    const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    const next = { bounds, maximized: win.isMaximized() };
    if (sameState(last, next)) return;
    try {
      writeWindowState(file, next);
      last = next;
    } catch (error) {
      log(`window: could not save its state: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  };
  win.on("resize", later);
  win.on("move", later);
  win.on("maximize", later);
  win.on("unmaximize", later);
  win.on("close", save);
}

/** The title band's height (apps/web shell/TitleBar.tsx): the traffic lights centre on it, Windows' caption buttons fill it. */
const TITLE_BAND = 40;

/**
 * Off macOS: Windows' minimize, maximize and close buttons drawn over the page's title band, on a clear background
 * (the page's band shows through; T3 found #00000000 drawn wrong on Linux), their glyphs in the theme's foreground.
 * Ported from upstream DesktopWindow.
 */
const captionButtons = () => ({ color: "#01000000", symbolColor: nativeTheme.shouldUseDarkColors ? "#e4e4e7" : "#27272a", height: TITLE_BAND });
/** Off macOS, the window's own colour before the page paints: the shell's (packages/ui --sidebar), no material behind it. */
const solidBackground = () => (nativeTheme.shouldUseDarkColors ? "#09090a" : "#f5f5f5");

function createWindow(): BrowserWindow {
  const stateFile = join(app.getPath("userData"), "window-state.json");
  const saved = SMOKE ? null : readWindowState(stateFile);
  const devIcon = join(__dirname, "../resources/icon.png");
  const win = new BrowserWindow({
    ...initialBounds(saved, screen.getAllDisplays().map((d) => d.bounds)),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: "Caveman Code",
    // No title bar: the page draws its own (apps/web shell/TitleBar.tsx) and the
    // traffic lights sit in it, centred on its 40px band.
    titleBarStyle: "hidden",
    ...(MAC
      ? {
          trafficLightPosition: { x: 16, y: 13 },
          // The macOS sidebar material behind a transparent window; the page's shell
          // lets a little of it through (apps/web styles.css). It follows
          // nativeTheme, which the page sets from Settings > Appearance.
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
        }
      : {
          titleBarOverlay: captionButtons(),
          backgroundColor: solidBackground(),
          // The menu bar stays out of the way; Alt shows it.
          autoHideMenuBar: true,
          // A packaged app's window takes the executable's icon; development has only the PNG.
          ...(!app.isPackaged && existsSync(devIcon) ? { icon: devIcon } : {}),
        }),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      // The preload's `packaged` (src/ipc.ts PACKAGED_ARG).
      additionalArguments: app.isPackaged && !SMOKE ? [PACKAGED_ARG] : [],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The side panel's browser (src/browser.ts); will-attach-webview below decides what each one gets.
      webviewTag: true,
      // A browser page's full screen (a video's) fills its panel, not the whole Mac: both sides opt out, as in T3.
      disableHtmlFullscreenWindowResize: true,
    },
  });
 // Ported from upstream DesktopWindow: whatever the page asks for, a guest is sandboxed, without Node or a preload.
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!mayAttach(params)) return event.preventDefault();
    delete webPreferences.preload;
    webPreferences.sandbox = true;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.webSecurity = true;
    webPreferences.disableHtmlFullscreenWindowResize = true;
  });
  if (!SMOKE) trackWindowState(win, stateFile, saved);
  // The caption buttons and the window's colour follow the theme the page picks (Settings > Appearance).
  if (!MAC) {
    const followTheme = () => {
      if (win.isDestroyed()) return;
      win.setTitleBarOverlay(captionButtons());
      win.setBackgroundColor(solidBackground());
    };
    nativeTheme.on("updated", followTheme);
    win.once("closed", () => nativeTheme.off("updated", followTheme));
  }
  win.once("ready-to-show", () => {
    if (SMOKE) return;
    // maximize() also shows the window, so not before its first paint.
    if (saved?.maximized) win.maximize();
    win.show();
  });
  // Full screen hides the traffic lights; the title bar gives their room back.
  const sendFullScreen = () => win.webContents.send(FULLSCREEN_CHANNEL, win.isFullScreen());
  win.on("enter-full-screen", sendFullScreen);
  win.on("leave-full-screen", sendFullScreen);
  win.webContents.on("did-finish-load", () => {
    sendFullScreen();
    if (pendingReport !== null) {
      // Not openReport(): Electron still says the page is loading while it reports the load finished.
      sendReport(win, pendingReport);
      pendingReport = null;
    }
    if (pendingRoute === null) return;
    const route = pendingRoute;
    pendingRoute = null;
    // Not navigate(): Electron still says the page is loading while it reports the load finished.
    setRoute(win, route);
  });
 // Ported from upstream DesktopWebLinks: links leave the app for the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(APP_URL)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  // ⌘W goes to the page first (T3 forwards these chords the same way): the
  // side panel closes its active tab; the page asks to close the window
  // when nothing there takes it.
  win.webContents.on("before-input-event", (event, input) => {
    if (!isCloseChord(input, process.platform)) return;
    event.preventDefault();
    win.webContents.send(CLOSE_REQUEST_CHANNEL);
  });
  // macOS: closing the window keeps the app and its runtime running, and now the page too, so a session that needs
  // you or finished still posts its notice and badges the Dock, and the window comes back as it was. Elsewhere it
  // quits the app, by way of the question before a quit (before-quit below): Cancel keeps the window.
  win.on("close", (event) => {
    const action = windowCloseAction({ platform: process.platform, quitting, smoke: SMOKE, fullScreen: win.isFullScreen() });
    if (action === "close") return;
    event.preventDefault();
    if (action === "quit") return app.quit();
    if (action === "hide") return win.hide();
    win.once("leave-full-screen", () => win.hide());
    win.setFullScreen(false);
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // The notch shows what this window's page says: without the page it has nothing to show.
    notch?.feed(null);
  });
  // A crashed page reloads where it was, a few times; then the person decides (src/rendererRecovery.ts).
  const recovery = new RendererRecovery();
  const reload = () => {
    if (win.isDestroyed()) return;
    const url = win.webContents.getURL();
    void win.loadURL(isOwnFrame(url) ? url : APP_URL);
  };
  win.webContents.on("render-process-gone", (_event, details) => {
    if (quitting || win.isDestroyed()) return;
    const action = recovery.next(details.reason, Date.now());
    log(`window: page gone (${details.reason}, exit ${details.exitCode}): ${action}`);
    if (action === "reload") setTimeout(reload, RECOVERY_DELAY_MS);
    else if (action === "give-up" && !SMOKE)
      void dialog
        .showMessageBox(win, {
          type: "error",
          message: "Caveman Code's window keeps stopping",
          detail: "It stopped several times in a few minutes. Your chats are safe: they live in the runtime, which is still running.",
          buttons: ["Reload", "Report a Problem…", "Show Logs", "Close"],
          defaultId: 0,
          cancelId: 3,
        })
        .then(({ response }) => {
          if (response === 0) reload();
          else if (response === 1) {
            reload();
            openReport({ surface: "other", error: { name: "WindowGone", message: `The window stopped several times in a few minutes (${details.reason}, exit ${details.exitCode}).` } });
          } else if (response === 2) void shell.openPath(logDir);
        });
  });
  void win.loadURL(APP_URL);
  return win;
}

/** Every window and side-panel page gets the right-click menu (src/contextMenu.ts). */
function installContextMenu(contents: WebContents): void {
  contents.on("context-menu", (_event, params) => {
    const history = contents.navigationHistory;
    const template = contextMenuTemplate(
      params,
      {
        edit: (command) => contents[command](),
        replaceMisspelling: (word) => contents.replaceMisspelling(word),
        learnSpelling: (word) => contents.session.addWordToSpellCheckerDictionary(word),
        copyText: (text) => clipboard.writeText(text),
        copyImageAt: (x, y) => contents.copyImageAt(x, y),
        openExternal: (url) => void shell.openExternal(url),
      },
      contents.getType() === "webview"
        ? {
            canGoBack: history.canGoBack(),
            canGoForward: history.canGoForward(),
            back: () => history.goBack(),
            forward: () => history.goForward(),
            reload: () => contents.reload(),
            inspect: (x, y) => contents.inspectElement(x, y),
          }
        : undefined,
    );
    if (template.length === 0) return;
    const win = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
    Menu.buildFromTemplate(template).popup({ ...(win ? { window: win } : {}), ...(params.frame ? { frame: params.frame } : {}) });
  });
}

function showWindow(): BrowserWindow {
  mainWindow ??= createWindow();
  if (!SMOKE) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  return mainWindow;
}

function buildMenu(): void {
  const go = (label: string, route: string, key?: string): MenuItemConstructorOptions => ({
    label,
    ...(key ? { accelerator: `CmdOrCtrl+${key}` } : {}),
    click: () => navigate(route),
  });
  const checkForUpdates: MenuItemConstructorOptions = { label: "Check for Updates…", click: () => (navigate("/settings/general"), void updates.check()) };
  const settings: MenuItemConstructorOptions = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => navigate("/settings") };
  const installCli: MenuItemConstructorOptions = { label: "Install Command Line Tool…", click: () => navigate("/settings/general") };
  const close: MenuItemConstructorOptions = {
    // Shown as ⌘W but not registered: the chord reaches the page first.
    label: "Close",
    accelerator: "CmdOrCtrl+W",
    registerAccelerator: false,
    click: (_item, win) => (win as BrowserWindow | undefined)?.webContents.send(CLOSE_REQUEST_CHANNEL),
  };
  const macMenus: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        checkForUpdates,
        { type: "separator" },
        settings,
        installCli,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "File", submenu: [go("New Chat", "/new", "N"), { type: "separator" }, close] },
  ];
  // Windows has no app menu (the menu bar hides behind Alt there, autoHideMenuBar): its items move to File and Help.
  const otherMenus: MenuItemConstructorOptions[] = [
    { label: "File", submenu: [go("New Chat", "/new", "N"), { type: "separator" }, settings, installCli, { type: "separator" }, close, { role: "quit", label: "Exit" }] },
  ];
  const helpItems: MenuItemConstructorOptions[] = [
    { label: "What's New", click: openWhatsNew },
    go("Show the Tour", "/tour"),
    { label: "Show Logs", click: () => void shell.openPath(logDir) },
    { label: "Report a Problem…", click: () => openReport({ surface: "other" }) },
    ...(MAC ? [] : [{ type: "separator" as const }, checkForUpdates, { role: "about" as const, label: "About Caveman Code" }]),
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(MAC ? macMenus : otherMenus),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    // ⌘1..⌘9 are the window's tabs (the page takes them, apps/web shell/TabStrip.tsx): these go without keys.
    { label: "Go", submenu: [go("Chief", "/chief"), go("Plugins", "/plugins"), go("Automations", "/automations")] },
    { role: "windowMenu" },
    { role: "help", submenu: helpItems },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // Right-click the Dock icon: start something without finding the window first.
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      { label: "New Chat", click: () => navigate("/new") },
      { label: "Capture for the Chief…", click: () => capture?.show() },
      { label: "Chief", click: () => navigate("/chief") },
    ]),
  );
}

// Run in the page, after the preload: the same bridge, token and subprotocol
// auth the client uses (packages/session-protocol README, Auth).
const RENDERER_PROBE = `new Promise((resolve, reject) => {
  const bridge = window.cavemanDesktop;
  if (!bridge) return reject(new Error("window.cavemanDesktop is missing"));
  const bearer = btoa(bridge.runtime.token).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");
  const ws = new WebSocket(bridge.runtime.url, ["caveman.session.v1", "base64url.bearer." + bearer]);
  ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.list", params: {} }));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    ws.close();
    if (msg.error) return reject(new Error(msg.error.message));
    resolve({ origin: location.origin, title: document.title, rendered: document.getElementById("root")?.childElementCount ?? 0, protocol: ws.protocol, engines: msg.result.engines.map((e) => e.id) });
  };
  ws.onerror = () => reject(new Error("WebSocket to " + bridge.runtime.url + " failed"));
})`;

/** The preloads the windows load (scripts/build.mjs); a packaged app missing one has a window with no bridge. */
const PRELOADS = ["preload.cjs", "capture-preload.cjs", "computer-guide-preload.cjs", "notch-preload.cjs"];

async function smokeTest(win: BrowserWindow, supervisor: RuntimeSupervisor): Promise<void> {
  const missing = PRELOADS.filter((name) => !existsSync(join(__dirname, name)));
  if (missing.length) throw new Error(`missing from the app: ${missing.map((name) => join(__dirname, name)).join(", ")}`);
  log(`SMOKE preloads: ${PRELOADS.join(", ")} present`);
  const engines = await supervisor.waitReady(30_000);
  log(`SMOKE main: runtime pid=${supervisor.pid ?? `${supervisor.attachedPid} (attached)`} answered engine.list on ${supervisor.endpoint.url}: [${engines.map((e) => e.id).join(", ")}]`);
  // --disable-sigusr1: SIGUSR1 must neither open an inspector (smoke-test.mjs fails on
  // "Debugger listening") nor stop the runtime. Windows has no SIGUSR1: requestInspector
  // asks through process._debugProcess, its way in.
  const pid = supervisor.pid;
  if (pid === undefined) {
    // Attached to a runtime this app did not start: never signal it (an old one would open an
    // inspector); check from its runtime record's pid that it runs with the flag.
    const owner = supervisor.attachedPid;
    if (owner === undefined) throw new Error("no runtime pid to check: no child of this app and no attached runtime");
    assertNoSigusr1Inspector(owner);
    log(`SMOKE sigusr1: attached runtime pid=${owner} runs with --disable-sigusr1 (not signalled: this app did not start it)`);
  } else {
    const delivered = requestInspector(pid);
    await new Promise((r) => setTimeout(r, 1_000));
    await supervisor.waitReady(5_000);
    if (supervisor.pid !== pid) throw new Error(`SIGUSR1 stopped the runtime (pid ${pid} is now ${supervisor.pid})`);
    log(`SMOKE sigusr1: runtime pid=${pid} still answers, no inspector${delivered ? "" : " (it has no debug handler to run)"}`);
    // The runtime this app started holds the agents key sealed here, from its first start's descriptor: its chats can
    // sign mail to the person's other Macs.
    const client = connect(supervisor.endpoint.url, supervisor.endpoint.token);
    const held = await client.call("device.agents", {}).finally(() => client.close());
    const pem = existsSync(AGENTS_KEY_FILE) ? agentsKey.pem() : undefined;
    if (pem === undefined) throw new Error(`no agents key sealed in ${AGENTS_KEY_FILE}`);
    const sealed = createPublicKey(pem).export({ format: "jwk" });
    if (held.agents === undefined || held.agents.public_key.x !== sealed.x || held.agents.public_key.y !== sealed.y)
      throw new Error("the runtime does not hold this Mac's sealed agents key: its chats would sign no mail to the person's other Macs");
    log(`SMOKE agents key: the runtime holds the key sealed in agents-key.bin (device ${held.agents.device_id})`);
  }
  if (win.webContents.isLoading()) await once(win.webContents, "did-finish-load");
  const probe = (await win.webContents.executeJavaScript(RENDERER_PROBE)) as Record<string, unknown>;
  log(`SMOKE renderer: ${JSON.stringify(probe)}`);
  // Exercise the real preload, IPC, protocol response and production app CSP.
  // Vite-only checks miss CSP inheritance from blob/srcDoc documents.
  const htmlProbe = await win.webContents.executeJavaScript(`(async () => {
    const html = '<!doctype html><script>let isolated=false;try{void parent.localStorage}catch{isolated=true}parent.postMessage({kind:"html-preview-smoke",scripts:true,isolated,bridge:typeof window.cavemanDesktop},"*")<\\/script>';
    const url = await window.cavemanDesktop.htmlPreview.create(html);
    if (!url || url.startsWith('caveman-code://app/')) throw new Error('HTML did not get an isolated document URL');
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-scripts allow-downloads';
    frame.src = url;
    return new Promise((resolve, reject) => {
      const done = () => { frame.remove(); window.removeEventListener('message', message); clearTimeout(timer); window.cavemanDesktop.htmlPreview.release(url); };
      const message = (event) => {
        if (event.source !== frame.contentWindow || event.data?.kind !== 'html-preview-smoke') return;
        const result = event.data;
        done();
        if (!result.scripts || !result.isolated || result.bridge !== 'undefined') reject(new Error('HTML preview escaped isolation: '+JSON.stringify(result)));
        else resolve(result);
      };
      const timer = setTimeout(() => { done(); reject(new Error('HTML preview script was blocked or failed to load')); }, 5000);
      window.addEventListener('message', message);
      document.body.append(frame);
    });
  })()`);
  log(`SMOKE HTML preview: ${JSON.stringify(htmlProbe)}`);
  // CAVEMAN_SMOKE_ROUTE (smoke only) pictures another screen, for example /settings/general.
  const route = process.env.CAVEMAN_SMOKE_ROUTE;
  if (route?.startsWith("/")) {
    // Tall enough for a whole Settings page; the smoke window is never shown.
    win.setContentSize(1280, 1500);
    // The smoke profile is new: past the first-run welcome to the screen asked for.
    await win.webContents.executeJavaScript(`localStorage.setItem("caveman.firstRunDone", "1"); location.hash = ${JSON.stringify(`#${route}`)}; location.reload()`);
    await once(win.webContents, "did-finish-load");
    // CAVEMAN_SMOKE_SHORTCUT (smoke only): binds another capture shortcut through the page's bridge, as Settings > Chief does.
    const chord = process.env.CAVEMAN_SMOKE_SHORTCUT;
    if (chord) log(`SMOKE shortcut: ${JSON.stringify(await win.webContents.executeJavaScript(`window.cavemanDesktop.capture.setShortcut(${JSON.stringify(chord)})`))}`);
  }
  // Let the client finish its first refresh, then keep a picture of it.
  await new Promise((r) => setTimeout(r, 1_500));
  const shot = join(app.getPath("userData"), "smoke.png");
  writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  log(`SMOKE screenshot: ${shot}`);
  const windowShot = process.env.CAVEMAN_SMOKE_WINDOW;
  if (windowShot && !MAC) await smokeCaptionButtons(win, windowShot);
  // CAVEMAN_SMOKE_CAPTURE (smoke only): the capture window as the shortcut opens it, the note typed and sent with a real
  // Enter through its own preload and IPC, then the runtime's board must hold it. Only the OS keypress is not exercised.
  const note = process.env.CAVEMAN_SMOKE_CAPTURE;
  if (note && capture) {
    const box = capture.show();
    if (box.webContents.isLoading()) await once(box.webContents, "did-finish-load");
    box.webContents.focus();
    await box.webContents.executeJavaScript(`document.querySelector("textarea").focus()`);
    await box.webContents.insertText(note);
    await new Promise((r) => setTimeout(r, 300));
    const capShot = join(app.getPath("userData"), "smoke-capture.png");
    writeFileSync(capShot, (await box.webContents.capturePage()).toPNG());
    log(`SMOKE capture screenshot: ${capShot} (shortcut ${JSON.stringify(capture.shortcut.state)})`);
    box.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    box.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    const client = connect(supervisor.endpoint.url, supervisor.endpoint.token);
    try {
      const deadline = Date.now() + 10_000;
      let landed: { state: string; source: string } | undefined;
      while (!landed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        landed = (await client.call("chief.items.list", {})).items.find((i) => i.text === note.trim() && i.source === "capture");
      }
      if (!landed) throw new Error("the captured note never reached the Chief's board");
      log(`SMOKE capture: the note landed on the board (state ${landed.state}, source ${landed.source}); window ${box.isVisible() ? "still open" : "hidden"}`);
    } finally {
      client.close();
    }
  }
}

/** A real click at a point on the screen (DIP), as a person's mouse makes it: Windows only, through user32 in PowerShell. */
const clickScreen = (point: { x: number; y: number }) =>
  new Promise<void>((resolve, reject) => {
    const { x, y } = screen.dipToScreenPoint(point);
    const user32 =
      "[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);";
    const script = [
      `Add-Type -Namespace CavemanSmoke -Name Mouse -MemberDefinition '${user32}'`,
      `[void][CavemanSmoke.Mouse]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}); Start-Sleep -Milliseconds 200`,
      "[CavemanSmoke.Mouse]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 80",
      "[CavemanSmoke.Mouse]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero)",
    ].join("\n");
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the click exited ${code}`))));
  });

/**
 * CAVEMAN_SMOKE_WINDOW=<file.png> (smoke only, off macOS): shows the window, pictures it as the screen has it, with
 * the caption buttons Windows draws over the page's title band (capturePage has the page alone), then clicks its
 * maximize button with the real mouse: the window must maximize, and the same button restore it.
 */
async function smokeCaptionButtons(win: BrowserWindow, out: string): Promise<void> {
  // On the screen as a person would have it: within its work area (CAVEMAN_SMOKE_ROUTE makes it 1500px tall).
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  win.setBounds({ ...workArea, width: Math.min(win.getBounds().width, workArea.width), height: Math.min(win.getBounds().height, workArea.height) });
  win.show();
  win.moveTop();
  await new Promise((r) => setTimeout(r, 1_500));
  // The title band the page may use: the caption buttons fill the rest of its row, at the right.
  const readBand = async () =>
    (await win.webContents.executeJavaScript(
      `(() => { const o = navigator.windowControlsOverlay; if (!o || !o.visible) return null; const r = o.getTitlebarAreaRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, page: window.innerWidth }; })()`,
    )) as { x: number; y: number; width: number; height: number; page: number } | null;
  const band = await readBand();
  if (!band) throw new Error("the window draws no caption buttons (navigator.windowControlsOverlay is not visible)");
  log(`SMOKE caption buttons: ${band.page - band.x - band.width}x${band.height} px at the right of the ${band.page} px page (its title band: ${JSON.stringify(band)})`);
  const [width, height] = win.getSize() as [number, number];
  const picture = (await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width, height } })).find((s) => s.id === win.getMediaSourceId());
  if (!picture || picture.thumbnail.isEmpty()) throw new Error("could not picture the window");
  writeFileSync(out, picture.thumbnail.toPNG());
  log(`SMOKE window screenshot: ${out}`);
  for (const want of [true, false]) {
    // Minimize, maximize, close from the left: the middle one's centre, wherever the window is now.
    const now = (await readBand()) ?? band;
    const content = win.getContentBounds();
    const left = now.x + now.width;
    await clickScreen({ x: content.x + left + (now.page - left) / 2, y: content.y + now.y + now.height / 2 });
    const deadline = Date.now() + 5_000;
    while (win.isMaximized() !== want && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (win.isMaximized() !== want) throw new Error(`clicking the maximize button did not ${want ? "maximize" : "restore"} the window`);
    log(`SMOKE caption buttons: a click on the maximize button ${want ? "maximized" : "restored"} the window`);
  }
}

/** This Mac's agents key, sealed in the profile (src/agentsKey.ts): its runtime gets it on the bootstrap descriptor only. */
const AGENTS_KEY_FILE = join(app.getPath("userData"), "agents-key.bin");
const agentsKey = new DesktopAgentsKey(AGENTS_KEY_FILE, safeStorage);

/**
 * Spawns the runtime (src/runtime.ts) once this is the one instance, beside Electron's own start-up rather than after
 * app.whenReady: its first answer comes that much sooner. Nothing here needs Electron ready (showErrorBox may run
 * before it; the startup recovery window waits for it).
 */
async function startRuntime(): Promise<{ supervisor: RuntimeSupervisor; hasEntry: boolean; recovery: StartupRecovery }> {
  const command = runtimeCommand(runtimeNode, runtimeEntry, homedir(), compileCachePreload && existsSync(compileCachePreload) ? compileCachePreload : undefined);
  // A problem report from the runtime carries this app's log (every runtime line lands there), version and channel.
  Object.assign(command.env, { CAVEMAN_DESKTOP_LOGS_DIR: logDir, CAVEMAN_APP_VERSION: app.getVersion(), CAVEMAN_BUILD_CHANNEL: BUILD_CHANNEL });
  // Its crash reports go into the spool for this app to send through its gate, never straight from the runtime: never
  // a DSN of its own from this app's environment (a test build's), and none at all where they cannot go.
  delete command.env.CAVEMAN_CRASH_DSN;
  delete command.env.CAVEMAN_CRASH_SPOOL;
  if (crashDsn !== undefined && telemetry.crashReportsPossible) Object.assign(command.env, { CAVEMAN_CRASH_DSN: crashDsn, CAVEMAN_CRASH_SPOOL: crashSpool });
  // When the runtime cannot start, its own window says why and what to do (src/startupRecovery.ts).
  const recovery = new StartupRecovery({
    appVersion: app.getVersion(),
    dataDir: app.getPath("userData"),
    logDir,
    platform: process.platform,
    arch: process.arch,
    updates,
    log,
    install: () => restartToUpdate(),
    retry: () => {
      supervisor.retry();
      supervisor.waitReady(60_000).then(() => ownRuntimeStarted(), () => undefined);
    },
    // The page prepares it from this app's logs while the runtime is down; closing it brings the window back.
    report: (report) => openReport(report),
    quit: () => app.quit(),
  });
  // Only this app's own runtime proves this version starts here: an attached `caveman-code` one answers too.
  const ownRuntimeStarted = () => {
    if (supervisor.attachedPid === undefined) recovery.started();
  };
  const supervisor: RuntimeSupervisor = await RuntimeSupervisor.create(command, log, {
    appVersion: app.getVersion(),
    // The dev profile keeps its own runtime state; packaged shares the runtime default with `caveman code`.
    stateDir: runtimeHome,
    // The key this Mac's chats sign mail to the person's other Macs with, sealed by the keychain (src/agentsKey.ts).
    // The keychain unseals nothing before `ready`, which comes while the runtime loads: its descriptor waits for it.
    agentsKey: agentsKey.forBootstrap(() => app.whenReady()),
    // As T3 does: say why, then quit, rather than restart into the same refusal.
    onStateDirOwned: () => {
      if (SMOKE) {
        log("SMOKE FAIL: runtime state dir is owned by another runtime");
        app.exit(1);
        return;
      }
      dialog.showErrorBox(
        "Caveman Code can't start its runtime",
        "Another Caveman Code runtime, for example one the caveman code command started, is using this data directory. Quit it and reopen Caveman Code.",
      );
      app.quit();
    },
    // The page took the endpoint when it loaded; give it the new one (the owner's, or ours again).
    onEndpointChanged: () => {
      runtime?.follow();
      mainWindow?.webContents.reload();
    },
    onUnexpectedExit: (code, signal) => {
      telemetry.crash("runtime_exit", signal ?? `exit_${code}`);
      crashReports?.runtimeExited(code, signal);
    },
    // It kept exiting at start: say so and let the person pick, rather than restart every 10 s while the page says
    // "Reconnecting" (src/runtime.ts MAX_FAST_RESTARTS).
    onGaveUp: (lastError) => {
      if (SMOKE) {
        log(`SMOKE FAIL: the runtime keeps exiting${lastError ? `: ${lastError}` : ""}`);
        app.exit(1);
        return;
      }
      void app.whenReady().then(() => recovery.show({ kind: "keeps-stopping", detail: lastError }));
    },
    // A newer build wrote its database: no restart helps and nothing is deleted; a newer build opens it.
    onRefusedData: (message) => {
      if (SMOKE) {
        log(`SMOKE FAIL: the runtime refused its data: ${message}`);
        app.exit(1);
        return;
      }
      void app.whenReady().then(() => recovery.show({ kind: "refused-data", detail: message }));
    },
  });
  const hasEntry = existsSync(runtimeEntry);
  // Started all the same: a damaged install's runtime keeps exiting, and the startup recovery window opens (onGaveUp).
  if (!hasEntry) log(`runtime: entry not found: ${runtimeEntry}`);
  supervisor.start();
  process.once("exit", () => supervisor.kill());
  return { supervisor, hasEntry, recovery };
}

/**
 * Asks to move to Applications; true when the app is moving (Electron copies it there, quits this copy and opens that
 * one), false to carry on from where it is. Not Now holds until the next version.
 */
async function askToMove(): Promise<boolean> {
  const version = app.getVersion();
  try {
    const icon = nativeImage.createFromPath(join(process.resourcesPath, "icon.icns"));
    const { response } = await dialog.showMessageBox({ ...MOVE_QUESTION, buttons: [...MOVE_QUESTION.buttons], ...(icon.isEmpty() ? {} : { icon }) });
    if (response !== MOVE_QUESTION.defaultId) {
      log("move: not now");
      writeMoveRecord(moveFile, { ...moveRecord, notNow: version });
      return false;
    }
    const from = bundleOf(process.execPath);
    // Before the move: the copy that opens in Applications reads it to eject the installer.
    writeMoveRecord(moveFile, { ...moveRecord, movedFrom: from });
    const destination = join("/Applications", basename(from));
    try {
      const moved = app.moveToApplicationsFolder({
        // Electron asks only when Applications has a copy already: replace it, unless it runs or is newer.
        conflictHandler: (type) => {
          const existing = bundleString(destination, "CFBundleShortVersionString");
          const conflict = conflictOf(type, existing, version);
          log(`move: Applications has ${existing ?? "a copy"} (${type}): ${conflict}`);
          const why = conflictMessage(conflict, existing, version);
          if (why) dialog.showMessageBoxSync({ type: "info", ...why, buttons: ["OK"] });
          return why === null;
        },
      });
      if (moved) {
        log(`move: from ${from} to ${destination}`);
        return true;
      }
    } catch (error) {
      log(`move: failed: ${error instanceof Error ? error.message : String(error)}`);
      await dialog.showMessageBox({
        type: "warning",
        message: "Caveman Code couldn't move itself to Applications.",
        detail: "Drag it from the installer window into Applications, then open it from there.",
        buttons: ["OK"],
      });
    }
    writeMoveRecord(moveFile, moveRecord);
  } catch (error) {
    log(`move: ${error instanceof Error ? error.message : String(error)}`);
  }
  return false;
}

/** Back in Applications after a move: ejects the installer it came from, quietly, then forgets where that was. */
async function ejectInstaller(): Promise<void> {
  const { movedFrom, ...rest } = moveRecord;
  if (movedFrom === undefined) return;
  try {
    const inApplications = app.isInApplicationsFolder();
    const mounts = inApplications ? diskImageMounts((await execFileAsync("hdiutil", ["info", "-plist"])).stdout) : [];
    const volume = installerToEject({
      inApplications,
      record: moveRecord,
      diskImageMounts: mounts,
      bundleIdOnVolume: bundleString(movedFrom, "CFBundleIdentifier"),
      bundleId: bundleString(bundleOf(process.execPath), "CFBundleIdentifier") ?? "so.caveman.code",
    });
    if (volume) {
      await execFileAsync("hdiutil", ["detach", "-quiet", volume]);
      log(`move: ejected ${volume}`);
    }
  } catch (error) {
    log(`move: could not eject the installer: ${error instanceof Error ? error.message : String(error)}`);
  }
  writeMoveRecord(moveFile, rest);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Asked first: a move quits this copy, so its runtime never starts.
  const moving = offerMove ? app.whenReady().then(askToMove) : Promise.resolve(false);
  const runtimeStarted = offerMove ? moving.then((yes) => (yes ? new Promise<never>(() => undefined) : startRuntime())) : startRuntime();
  cloudInUse = async () => {
    const { supervisor, hasEntry } = await runtimeStarted;
    if (!hasEntry) throw new Error("no runtime");
    await supervisor.waitReady(10_000);
    const client = connect(supervisor.endpoint.url, supervisor.endpoint.token);
    try {
      return (await client.call("settings.get", {})).cloud_url;
    } finally {
      client.close();
    }
  };
  // "System" in Settings > Appearance follows the OS: the page reads prefers-color-scheme.
  nativeTheme.themeSource = "system";
  app.on("open-url", (event, url) => {
    event.preventDefault();
    openDeepLink(url);
  });
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith(`${APP_SCHEME}://`));
    if (link) openDeepLink(link);
    else {
      if (booted) showWindow();
      // Windows has no Dock to click: opening the app again brings back a startup recovery window someone closed.
      void runtimeStarted.then(({ recovery }) => recovery.reveal(), () => undefined);
    }
  });
  // Windows (and Linux) start the app with the link as an argument; macOS sends open-url instead.
  if (!MAC) {
    const link = process.argv.find((arg) => arg.startsWith(`${APP_SCHEME}://`));
    if (link) openDeepLink(link);
  }

  void app.whenReady().then(async () => {
    if (await moving) return;
    if (MAC && app.isPackaged && !SMOKE) void ejectInstaller();
    // Not from a headless smoke run (scripts/smoke-test.mjs --packaged): it must never take the person's
    // caveman-code:// links for a build in a scratch directory.
    if (app.isPackaged && !SMOKE) app.setAsDefaultProtocolClient(APP_SCHEME);
    if (!app.isPackaged && process.platform === "darwin") app.dock?.setIcon(join(__dirname, "../resources/icon.png"));

    // Only our pages get permissions: clipboard writes, notifications (Settings: a session needs you or finished),
    // full screen (the image viewer's F), and the microphone alone for a call with the Chief: never the camera or
    // the screen. Electron grants everything by default.
    const allowed = new Set(["clipboard-sanitized-write", "notifications", "fullscreen"]);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
      callback(isOwnFrame(details.requestingUrl) && (allowed.has(permission) || (permission === "media" && micOnly(details)))),
    );
    session.defaultSession.setPermissionCheckHandler(
      (_wc, permission, _origin, details) => isOwnFrame(details.requestingUrl) && (allowed.has(permission) || (permission === "media" && details.mediaType === "audio")),
    );
    // Pages in the side panel's browser get only GUEST_PERMISSIONS (src/browser.ts): copying, full screen within
    // their panel (disableHtmlFullscreenWindowResize keeps the window as it is), pointer lock and loopback.
    const guests = session.fromPartition(BROWSER_PARTITION);
    guests.setPermissionRequestHandler((_wc, permission, callback) => callback(GUEST_PERMISSIONS.has(permission)));
    guests.setPermissionCheckHandler((_wc, permission) => GUEST_PERMISSIONS.has(permission));
    // Every window and guest gets the right-click menu. A guest stays on the web: a new window opens in the same
    // tab, and nothing leaves http(s).
    app.on("web-contents-created", (_event, contents) => {
      installContextMenu(contents);
      if (contents.getType() !== "webview") return;
      contents.setWindowOpenHandler((details) => {
        const action = guestWindowOpenAction(details);
        if (action === "popup") return { action: "allow", overrideBrowserWindowOptions: POPUP_WINDOW_OPTIONS };
        if (action === "navigate") void contents.loadURL(details.url).catch(() => undefined);
        return { action: "deny" };
      });
      // A sign-in popup (src/browser.ts) stays on the web, opens nothing further, and closes on ⌘W.
      contents.on("did-create-window", (popup) => {
        popup.webContents.setWindowOpenHandler(({ url }) => {
          if (isGuestUrl(url)) void popup.webContents.loadURL(url).catch(() => undefined);
          return { action: "deny" };
        });
        popup.webContents.on("will-navigate", (event, url) => {
          if (!isGuestUrl(url)) event.preventDefault();
        });
        popup.webContents.on("before-input-event", (event, input) => {
          if (!isCloseChord(input, process.platform)) return;
          event.preventDefault();
          popup.close();
        });
      });
      contents.on("will-navigate", (event, url) => {
        if (!isGuestUrl(url)) event.preventDefault();
      });
      // Keys typed in the page never reach the window's own before-input-event: ⌘W still closes the panel's tab, and
      // the app's chords go back to the app's page (src/guestKeys.ts).
      contents.on("before-input-event", (event, input) => {
        if (isCloseChord(input, process.platform)) {
          event.preventDefault();
          contents.hostWebContents?.send(CLOSE_REQUEST_CHANNEL);
          return;
        }
        const chord = chordOfInput(input, process.platform === "darwin");
        if (chord === null || !guestChords.has(chord)) return;
        event.preventDefault();
        if (input.isAutoRepeat) return;
        const { key, code, meta, control, alt, shift } = input;
        contents.hostWebContents?.send(GUEST_KEY_CHANNEL, { guest: contents.id, key, code, meta, control, alt, shift });
      });
    });

    // Crash reports load now, beside the window rather than before it, and again whenever telemetry turns on.
    startCrashReports();
    telemetry.onChange(startCrashReports);
    const { supervisor, hasEntry, recovery } = await runtimeStarted;
    runtime = runtimeClient(() => supervisor.endpoint, connect);
    const runtimeCall = runtime.call;
    if (telemetry.firstLaunch) telemetry.step("first_launch");
    // This version starts here (the recovery window's "go back" offer), and its window closes once it does.
    // Only this app's own runtime proves this version starts here: an attached `caveman-code` one answers too.
    if (hasEntry && !SMOKE)
      supervisor.waitReady(120_000).then(() => {
        if (supervisor.attachedPid === undefined) recovery.started();
      }, () => undefined);
    if (hasEntry && !SMOKE && !telemetry.sent("runtime_ready")) supervisor.waitReady(60_000).then(() => telemetry.step("runtime_ready"), () => undefined);
    // Turn stats, once a minute: Telemetry.turns asks the runtime only while it sends (src/telemetry.ts).
    if (hasEntry) {
      const askTurns: AskTurns = async (params) => {
        await supervisor.waitReady(10_000);
        return runtimeCall("telemetry.turns", params, 30_000);
      };
      setInterval(() => void telemetry.turns(askTurns), TURN_STATS_EVERY_MS);
    }
    app.on("render-process-gone", (_event, _contents, details) => {
      if (details.reason !== "clean-exit") telemetry.crash("renderer_gone", details.reason);
    });
    app.on("child-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit") telemetry.crash("child_gone", details.reason);
    });
    // `caveman-code` (`caveman-code.cmd` on Windows): kept current in the Caveman Code home; on PATH only when the
    // person asks, by a link on macOS and in the user's PATH on Windows.
    const launcher = app.isPackaged && !SMOKE ? writeLauncher(join(homedir(), ".caveman-code"), join(process.resourcesPath, "runtime"), log) : undefined;
    const userPath = WINDOWS ? registryUserPath() : undefined;
    updates.start(SMOKE, TEST_BUILD ? process.env.CAVEMAN_UPDATE_FEED_URL : undefined);

    ipcMain.on(THEME_CHANNEL, (event, theme: unknown) => {
      if (isOwnFrame(event.senderFrame?.url) && (theme === "system" || theme === "light" || theme === "dark")) nativeTheme.themeSource = theme;
    });
    // The page's 40px title band scales with its zoom; the lights (12pt, 16pt in) stay centred on it (preload.ts).
    ipcMain.on(ZOOM_CHANNEL, (event, zoom: unknown) => {
      if (!MAC || !isOwnFrame(event.senderFrame?.url) || typeof zoom !== "number" || !(zoom > 0)) return;
      BrowserWindow.fromWebContents(event.sender)?.setWindowButtonPosition({ x: 16, y: Math.max(0, Math.round(20 * zoom) - 7) });
    });
    ipcMain.on(CLOSE_WINDOW_CHANNEL, (event) => {
      if (!isOwnFrame(event.senderFrame?.url)) return;
      BrowserWindow.fromWebContents(event.sender)?.close();
    });
    // The browser's More menu: sites keep their sign-ins in the partition for good until the person clears them.
    ipcMain.handle(BROWSER_CLEAR_CHANNEL, async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!isOwnFrame(event.senderFrame?.url) || !win) return false;
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        message: "Clear the browser's cookies and site data?",
        detail: "Every site in the side panel's browser signs you out and forgets what it stored. Your chats are not touched.",
        buttons: ["Clear", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return false;
      const guests = session.fromPartition(BROWSER_PARTITION);
      await guests.clearStorageData();
      await guests.clearCache();
      log("browser: cleared cookies, site data and cache");
      return true;
    });
    ipcMain.on(GUEST_SHORTCUTS_CHANNEL, (event, chords: unknown) => {
      if (isOwnFrame(event.senderFrame?.url) && Array.isArray(chords)) guestChords = forwardedChords(chords);
    });
    // The Dock badge counts sessions that need a look while the app is away; using the app clears it. The Chief's
    // capture panel is not the app: it opens over whatever app is in front (src/capture.ts), and the page, which
    // counts, never hears of its focus.
    const usingTheApp = (win: BrowserWindow | null) => win !== null && win !== capture?.window && win !== notch?.window;
    ipcMain.on(BADGE_CHANNEL, (event, count: unknown) => {
      const next = isOwnFrame(event.senderFrame?.url) ? badgeCount(count, usingTheApp(BrowserWindow.getFocusedWindow())) : null;
      if (next !== null) app.setBadgeCount(next);
    });
    app.on("browser-window-focus", (_event, win) => {
      if (usingTheApp(win)) app.setBadgeCount(0);
    });
    // A notice clicked while the window was closed: the window only hid (createWindow), and window.focus() in the
    // page does not show it.
    ipcMain.on(SHOW_WINDOW_CHANNEL, (event) => {
      if (isOwnFrame(event.senderFrame?.url)) showWindow();
    });
    ipcMain.handle(PICK_FOLDER_CHANNEL, async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!isOwnFrame(event.senderFrame?.url) || !win) return null;
      const picked = await dialog.showOpenDialog(win, { title: "Add a project", buttonLabel: "Add Project", properties: ["openDirectory"] });
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    });
    // Reveal only selects in Finder; it never opens or runs what it shows (src/folders.ts).
    ipcMain.on(REVEAL_FOLDER_CHANNEL, (event, raw: unknown) => {
      const dir = isOwnFrame(event.senderFrame?.url) ? folderToOpen(raw) : null;
      if (dir) shell.showItemInFolder(dir);
    });
    ipcMain.on(OPEN_TERMINAL_CHANNEL, (event, raw: unknown) => {
      const dir = isOwnFrame(event.senderFrame?.url) ? folderToOpen(raw) : null;
      const terminal = dir ? terminalCommand(dir) : null;
      if (!terminal) return;
      // Detached: on Windows the Command Prompt that runs `start` gets no console window of its own to flash.
      const child = spawn(terminal.command, [...terminal.args], { cwd: terminal.cwd, stdio: "ignore", detached: true, windowsVerbatimArguments: terminal.verbatim });
      child.on("error", (error) => log(`terminal: could not open: ${error.message.split("\n")[0]}`));
      child.on("exit", (code) => code && log(`terminal: could not open: ${terminal.command} exited ${code}`));
      child.unref();
    });
    ipcMain.on(RUNTIME_CHANNEL, (event) => {
      // Only our own pages get the endpoint, never a frame from elsewhere.
      event.returnValue = isOwnFrame(event.senderFrame?.url) ? supervisor.endpoint : null;
    });
    const own = (event: { senderFrame?: { url: string } | null }) => isOwnFrame(event.senderFrame?.url);
    // Problem reports (src/bugReport.ts): the window as it looks, and the runtime-down path into its outbox.
    const desktopReports = new DesktopBugReports({ logDir, runtimeStateDir: runtimeStateDir(runtimeHome), env: desktopEnvironment(app.getVersion(), BUILD_CHANNEL) });
    ipcMain.handle(BUG_REPORT_SCREENSHOT_CHANNEL, async (event) => {
      if (!own(event)) return null;
      const image = await event.sender.capturePage();
      let png = image.toPNG();
      // Over the contract's 5 MB (a large Retina window): half the size, which keeps it readable.
      if (png.byteLength > 5 * 1024 * 1024) png = image.resize({ width: Math.round(image.getSize().width / 2) }).toPNG();
      return png.byteLength > 5 * 1024 * 1024 ? null : png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
    });
    ipcMain.handle(BUG_REPORT_PREPARE_CHANNEL, (event, input: unknown) => {
      if (!own(event)) throw new Error("Not from Caveman Code");
      return desktopReports.prepare(input);
    });
    ipcMain.handle(BUG_REPORT_QUEUE_CHANNEL, (event, input: unknown) => {
      if (!own(event)) throw new Error("Not from Caveman Code");
      const record = desktopReports.queue(input);
      log(`bug report ${record.report_id}: queued for the runtime's next start`);
      return record;
    });
    // A report the startup recovery window opened closed: its choices again (src/startupRecovery.ts).
    ipcMain.on(BUG_REPORT_DONE_CHANNEL, (event) => {
      if (own(event)) recovery.reportClosed();
    });
    const htmlPreviews = new HtmlPreviews();
    const htmlOwners = new Set<number>();
    ipcMain.handle(HTML_PREVIEW_CREATE_CHANNEL, (event, html: unknown) => {
      if (!own(event)) return null;
      const id = event.sender.id;
      if (!htmlOwners.has(id)) {
        htmlOwners.add(id);
        event.sender.once("destroyed", () => { htmlOwners.delete(id); htmlPreviews.clearOwner(id); });
      }
      return htmlPreviews.create(id, html);
    });
    ipcMain.on(HTML_PREVIEW_RELEASE_CHANNEL, (event, url: unknown) => {
      if (own(event)) htmlPreviews.release(event.sender.id, url);
    });
    ipcMain.handle(UPDATES_STATE_CHANNEL, (event) => (own(event) ? updates.current : null));
    ipcMain.handle(UPDATES_CHECK_CHANNEL, (event) => (own(event) ? updates.check() : null));
    ipcMain.handle(UPDATES_SET_CHANNEL_CHANNEL, (event, channel: unknown) =>
      own(event) && (channel === "stable" || channel === "nightly") ? updates.setChannel(channel) : null,
    );
    // Settings > General: the runtime `caveman-code` started in a terminal, which this app uses but never stops.
    ipcMain.handle(UPDATES_RUNTIME_CHANNEL, (event) => {
      if (!own(event) || supervisor.attachedPid === undefined) return null;
      const version = supervisor.attachedVersion ?? null;
      return { pid: supervisor.attachedPid, version, appVersion: app.getVersion(), skew: versionSkew(app.getVersion(), supervisor.attachedVersion) };
    });
    // Restart to update stops the runtime like any quit: it asks first while chats work (mayQuit, below). On Windows
    // the installer replaces the runtime's files as the app goes, and a running node.exe holds them: the runtime stops
    // before the updater quits the app, not after. One this app did not start it cannot stop (installBlocked).
    restartToUpdate = () => {
      const blocked = updates.current.status === "ready" ? updates.installBlocked() : undefined;
      if (blocked) {
        log(`updates: not installing (${blocked})`);
        const options = {
          type: "info" as const,
          message: blocked,
          detail: "Caveman Code is using the runtime caveman-code started in a terminal, and Windows can't replace its files while it runs. The update stays ready: once caveman-code has stopped, restart to update or quit.",
        };
        const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
        void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
        return;
      }
      void mayQuit()
        .catch(() => true)
        .then(async (go) => {
          if (!go) return;
          const stopped = WINDOWS && updates.current.status === "ready";
          if (stopped) {
            quitting = true;
            const exit = await supervisor.stop();
            log(`runtime: stopped for the update ${exit ? `code=${exit.code} signal=${exit.signal}` : "(was not running)"}`);
            runtimeStopped = true;
          }
          if ((await updates.install()) || !stopped) return;
          // The updater did not quit (no installer to run): the page needs its runtime back.
          quitting = false;
          runtimeStopped = false;
          supervisor.resume();
        });
    };
    ipcMain.on(UPDATES_INSTALL_CHANNEL, (event) => {
      if (own(event)) restartToUpdate();
    });
    ipcMain.handle(CLI_STATUS_CHANNEL, (event) => (!own(event) ? null : userPath ? userPathStatus(launcher, userPath) : cliStatus(launcher)));
    ipcMain.handle(CLI_INSTALL_CHANNEL, (event) => (!own(event) ? null : userPath ? addToUserPath(launcher, userPath) : installOnPath(launcher)));
    ipcMain.handle(TELEMETRY_CHOICE_CHANNEL, (event) => (own(event) ? telemetry.choice : null));
    ipcMain.handle(TELEMETRY_SET_CHANNEL, (event, enabled: unknown) => {
      if (!own(event)) return null;
      telemetry.setEnabled(enabled === true);
      return telemetry.choice;
    });
    ipcMain.on(TELEMETRY_STEP_CHANNEL, (event, name: unknown) => {
      if (own(event) && typeof name === "string") telemetry.step(name);
    });
    ipcMain.on(TELEMETRY_CRASH_CHANNEL, (event, name: unknown) => {
      if (own(event)) telemetry.crash("renderer_exception", name);
    });
    ipcMain.on(TELEMETRY_DISCLOSED_CHANNEL, (event) => {
      if (own(event)) telemetry.disclosed();
    });
    // The page starts its own reporter (over IPC to this one) only once this one has.
    ipcMain.handle(CRASH_REPORTS_CHANNEL, async (event) => own(event) && (await crashReportsStarting) !== undefined);
    protocol.handle(APP_SCHEME, (request) => new URL(request.url).host === HTML_PREVIEW_HOST ? htmlPreviews.serve(request) : serveAsset(request, webDir));
    buildMenu();
    booted = true;

    // The Chief's capture window: the shortcut from Settings > Chief once the runtime answers, else the default.
    capture = new CaptureWindow(`${APP_URL}capture.html`, join(__dirname, "capture-preload.cjs"), log);
    const captureNote = async (text: string, mode: "decide" | "queue") => {
      await runtimeCall("chief.capture", { request_id: randomUUID(), text, source: "capture", mode }, 10_000);
    };
    const shortcutFromSettings = async (): Promise<string> => {
      if (!hasEntry) return DEFAULT_CAPTURE_SHORTCUT;
      await supervisor.waitReady(60_000);
      return (await runtimeCall("settings.get", {}, 30_000)).chief_capture_shortcut ?? DEFAULT_CAPTURE_SHORTCUT;
    };
    const bindCapture = shortcutFromSettings().then(
      (accelerator) => capture?.shortcut.bind(accelerator),
      () => capture?.shortcut.bind(DEFAULT_CAPTURE_SHORTCUT),
    );
    ipcMain.handle(CAPTURE_STATUS_CHANNEL, async (event) => (own(event) ? (await bindCapture, capture?.shortcut.state ?? null) : null));
    ipcMain.handle(CAPTURE_SHORTCUT_CHANNEL, async (event, accelerator: unknown) => {
      if (!own(event) || typeof accelerator !== "string" || !accelerator) return null;
      await bindCapture;
      return capture?.shortcut.bind(accelerator) ?? null;
    });
    ipcMain.handle(CAPTURE_SUBMIT_CHANNEL, async (event, text: unknown, mode: unknown) => {
      if (!own(event)) return { error: "Not from Caveman Code" };
      if (typeof text !== "string" || !text.trim()) return { error: "Type a note first" };
      try {
        await captureNote(text.trim(), mode === "queue" ? "queue" : "decide");
        capture?.hide();
        return {};
      } catch (error) {
        log(`capture: ${error instanceof Error ? error.message : String(error)}`);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.on(CAPTURE_CLOSE_CHANNEL, (event) => {
      if (own(event)) capture?.hide();
    });
    // Computer use's guide over System Settings: opened by the main window (a chat's card, the Computer tab, Settings).
    const computerGuide = new ComputerGuide(
      `${APP_URL}computer-guide.html`,
      join(__dirname, "computer-guide-preload.cjs"),
      app.isPackaged ? join(process.resourcesPath, "icon.icns") : join(__dirname, "../resources/icon.png"),
      log,
    );
    ipcMain.on(COMPUTER_GUIDE_OPEN_CHANNEL, (event, permission: unknown) => {
      if (own(event)) computerGuide.open(permission === "accessibility" || permission === "screen_recording" ? permission : undefined);
    });
    ipcMain.on(COMPUTER_GUIDE_ACTION_CHANNEL, (event, action: unknown) => {
      if (own(event)) computerGuide.action(action);
    });
    ipcMain.on(COMPUTER_GUIDE_DRAG_CHANNEL, (event) => {
      if (own(event)) computerGuide.drag(event.sender);
    });
    // The notch (src/notch.ts), on a Mac: the main window's page says what it shows and carries out what the person does
    // on it; the notch's own page only draws, and says where the pointer is. Never in the smoke test.
    if (MAC && !SMOKE) {
      // Open brings the window back first: it may be closed (hidden), and only main can show it.
      const relay = (action: NotchAction) => {
        if (action.type === "open") showWindow();
        mainWindow?.webContents.send(NOTCH_ACTION_CHANNEL, action);
      };
      const tab = (notch = new NotchWindow(`${APP_URL}notch.html`, join(__dirname, "notch-preload.cjs"), log, relay));
      const fromNotch = (event: { sender: WebContents }) => tab.owns(event.sender);
      ipcMain.on(NOTCH_FEED_CHANNEL, (event, state: unknown) => {
        if (own(event) && event.sender === mainWindow?.webContents) tab.feed(state);
      });
      ipcMain.on(NOTCH_READY_CHANNEL, (event) => {
        if (fromNotch(event)) tab.ready();
      });
      ipcMain.on(NOTCH_OVER_CHANNEL, (event, on: unknown) => {
        if (fromNotch(event)) tab.over(on);
      });
      ipcMain.on(NOTCH_MENU_CHANNEL, (event) => {
        if (fromNotch(event)) tab.menu();
      });
      ipcMain.on(NOTCH_ACT_CHANNEL, (event, raw: unknown) => {
        const action = fromNotch(event) ? notchAction(raw) : null;
        if (action) relay(action);
      });
    }
    ipcMain.handle(MEDIA_OPEN_CHANNEL, (event, name: unknown, png: unknown) => (own(event) ? openPicture(name, png) : "Not from Caveman Code"));
    ipcMain.handle(MEDIA_SHARE_CHANNEL, (event, name: unknown, png: unknown) => (own(event) ? sharePicture(event, name, png) : "Not from Caveman Code"));
    // Copy, Share and Save on a web image the page shows but may not fetch(): the app's own pages only, http(s) only.
    ipcMain.handle(MEDIA_READ_CHANNEL, (event, url: unknown) => (own(event) ? readWebMedia(url, (u, init) => event.sender.session.fetch(u, init)) : null));
    // Driving another Mac through Caveman Cloud: this app's own device key, sealed by the keychain (src/deviceKey.ts).
    const deviceKey = new DesktopDeviceKey(join(app.getPath("userData"), "device-key.bin"), safeStorage, `Caveman Code on ${macName()}`);
    ipcMain.handle(DEVICE_DESCRIBE_CHANNEL, (event) => {
      if (!own(event)) throw new Error("Not from Caveman Code");
      if (!deviceKey.available()) throw new Error("this Mac's keychain cannot keep a device key");
      return deviceKey.describe();
    });
    ipcMain.handle(DEVICE_SIGN_CHANNEL, (event, data: unknown) => {
      if (!own(event) || !(data instanceof Uint8Array)) throw new Error("Not from Caveman Code");
      return deviceKey.sign(data);
    });
    app.on("will-quit", () => globalShortcut.unregisterAll());

    let runtimeStopped = false;
    // The updater owns this quit: never cancel it. SIGTERM lets the runtime (its own process group) shut down cleanly
    // after the app is gone.
    // Windows: attached to a runtime this app did not start (`caveman-code` in a terminal, maybe on this app's own
    // node.exe), which the installer would have to replace while it runs.
    updates.installBlocked = () => (WINDOWS && supervisor.attachedPid !== undefined ? "Quit caveman-code in your terminal to update." : undefined);
    updates.onQuitForUpdate = () => {
      // The updater closes the windows before before-quit: they must not just hide.
      quitting = true;
      runtimeStopped = true;
      supervisor.kill();
    };
    // Restart, shut down or log out: cancelling the quit that follows (to stop the runtime first, or to ask) would
    // interrupt the person's logout. Let it through as the updater's is: SIGTERM, and the runtime finishes shutting down
    // on its own (its own process group; it also exits when its stdin closes with the app). macOS says it is coming
    // ("shutdown") before it asks any app to quit, and another app can still cancel it, so nothing stops until that
    // quit comes. A quit can't say what asked for it: after a cancelled logout the next one goes without the question,
    // as Chromium's does.
    let shuttingDown = false;
    // The lid closes: working chats move to Cloud; one that cannot go (no Cloud login for Claude Agent or Codex) stops its turn (src/lid.ts).
    // On wake the runtime sees which of its chats Cloud took meanwhile and shows them there, and the page hears what
    // the lid did (cavemanDesktop.onLidOutcome) when a chat moved or stopped.
    const lid = lidReport((outcome) => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      win?.webContents.send(LID_OUTCOME_CHANNEL, outcome);
    });
    powerMonitor.on("suspend", () => {
      if (SMOKE || (supervisor.pid === undefined && supervisor.attachedPid === undefined)) return;
      const report = lid.sleeping();
      const client = connect(supervisor.endpoint.url, supervisor.endpoint.token);
      void closeLid(client, () => `lid:${randomUUID()}`)
        .then(
          (outcome) => {
            log(`power: the lid closed; ${outcome.moving} chat(s) moving to Cloud, ${outcome.paused} paused`);
            report(outcome);
          },
          (error) => log(`power: the lid closed; moving chats failed (${error instanceof Error ? error.message : String(error)})`),
        )
        .finally(() => client.close());
    });
    powerMonitor.on("resume", () => {
      log("power: woke up");
      lid.woke();
    });
    const systemQuits = () => {
      shuttingDown = true;
      quitting = true;
      runtimeStopped = true;
      supervisor.kill();
      log("quit: the system is shutting down or logging out");
    };
    powerMonitor.on("shutdown", () => {
      shuttingDown = true;
      log("quit: the system is about to shut down or log out");
    });
    // SIGINT/SIGTERM: no question (nobody is at the window to answer it); stop the runtime the usual way, then quit.
    // A signal asks the process to end, so a quit still unfinished 10 s later (a window that will not close) exits.
    onQuitSignal(process, process.platform, (signal) => {
      quitting = true;
      log(`quit: ${signal}`);
      void supervisor.stop().then((exit) => {
        log(`runtime: stopped ${exit ? `code=${exit.code} signal=${exit.signal}` : "(was not running)"}`);
        runtimeStopped = true;
        setTimeout(() => {
          log(`quit: still open 10 s after ${signal}; exiting`);
          app.exit(0);
        }, 10_000).unref();
        app.quit();
      });
    });
    const quitFile = join(app.getPath("userData"), "quit.json");
    const workingChats = async (): Promise<number> => workingHere((await runtimeCall("workspace.list", {}, 2_000)).workspaces);
    // Settings > General: idle sleep waits while chats work, when the person turned that on (src/keepAwake.ts).
    const powerFile = join(app.getPath("userData"), "power.json");
    const keepAwake = new KeepAwake(powerSaveBlocker);
    let keepAwakeOn = readKeepAwake(powerFile);
    // Another device drives this Mac (S13): the runtime says so under its keep_awake_remote setting.
    const remoteWanted = async (): Promise<boolean> => (await runtimeCall("device.awake", {}, 2_000)).wanted;
    // While idle sleep is held off, main looks again every KEEP_AWAKE_POLL_MS (the remote rule's window ends without an
    // event); at rest it asks nothing on a timer.
    let pollTimer: NodeJS.Timeout | undefined;
    const checkAwake = async () => {
      const was = keepAwake.holding;
      const [working, remote] = await Promise.all([keepAwakeOn ? workingChats().catch(() => 0) : 0, remoteWanted().catch(() => false)]);
      keepAwake.set(holdAwake({ quitting, keepAwakeOn, workingChats: working, remoteWanted: remote, onBattery: powerMonitor.isOnBatteryPower() }));
      if (keepAwake.holding !== was)
        log(`power: ${keepAwake.holding ? (remote && !(keepAwakeOn && working > 0) ? "keeping this Mac awake while another device drives it" : "keeping this Mac awake while chats work") : "idle sleep allowed again"}`);
      clearTimeout(pollTimer);
      pollTimer = keepAwake.holding && !SMOKE ? setTimeout(() => void checkAwake(), KEEP_AWAKE_POLL_MS).unref() : undefined;
    };
    // Unplugged or plugged in: the remote rule holds on power only, so look again at once.
    powerMonitor.on("on-battery", () => void checkAwake());
    powerMonitor.on("on-ac", () => void checkAwake());
    const powerState = () => ({ keepAwake: keepAwakeOn, holding: keepAwake.holding });
    // A chat starting or stopping here (a remote device's turn too) is when either rule can change: look then. Each
    // connection looks once as well, since a reconnect may have missed some.
    if (hasEntry && !SMOKE) {
      const working = new WorkingSet();
      runtime.on("workspace.changed", (chat) => {
        if (working.update(chat)) void checkAwake();
      });
      runtime.onConnected(() => {
        working.clear();
        void checkAwake();
      });
    }
    ipcMain.handle(POWER_GET_CHANNEL, (event) => (own(event) ? powerState() : null));
    // A call's microphone: macOS asks once (the usage string is in Info.plist); denied, the person turns it on in System Settings.
    ipcMain.handle(MIC_STATUS_CHANNEL, (event) => (own(event) ? (process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "granted") : "denied"));
    ipcMain.handle(MIC_ASK_CHANNEL, async (event) => (own(event) ? (process.platform === "darwin" ? systemPreferences.askForMediaAccess("microphone") : true) : false));
    ipcMain.on(MIC_SETTINGS_CHANNEL, (event) => {
      if (own(event) && process.platform === "darwin") void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    });
    ipcMain.handle(POWER_SET_CHANNEL, async (event, on: unknown) => {
      if (!own(event)) return null;
      keepAwakeOn = on === true;
      writeKeepAwake(powerFile, keepAwakeOn);
      await checkAwake();
      return powerState();
    });
    /** Quitting stops the chats working on this Mac (src/quitGuard.ts): ask first, unless nothing would stop. */
    const mayQuit = async (): Promise<boolean> => {
      // No child of this app (attached to another runtime, or none): quitting stops nothing.
      if (SMOKE || shuttingDown || supervisor.pid === undefined || !askBeforeQuit(quitFile)) return true;
      const working = await workingChats().catch(() => 0);
      if (working === 0) return true;
      const options = { type: "warning" as const, buttons: ["Quit", "Cancel"], defaultId: 0, cancelId: 1, checkboxLabel: "Don't ask again", ...quitQuestion(working) };
      const win = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined;
      const answer = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
      if (answer.response !== 0) return false;
      if (answer.checkboxChecked) stopAsking(quitFile);
      return true;
    };
    let quitAsked = false;
    app.on("before-quit", (event) => {
      if (shuttingDown && !runtimeStopped) systemQuits();
      if (runtimeStopped) {
        quitting = true;
        return;
      }
      event.preventDefault();
      if (quitAsked) return;
      quitAsked = true;
      // A question that cannot be asked never traps the app open.
      void mayQuit()
        .catch(() => true)
        .then(async (go) => {
          if (!go) {
            quitAsked = false;
            log("quit: cancelled, chats are still working");
            return;
          }
          quitting = true;
          const exit = await supervisor.stop();
          log(`runtime: stopped ${exit ? `code=${exit.code} signal=${exit.signal}` : "(was not running)"}`);
          runtimeStopped = true;
          app.quit();
        });
    });
    app.on("activate", () => {
      showWindow();
      recovery.reveal();
    });
    // macOS convention: closing the window keeps the app (and runtime) running; the window only hides (createWindow).
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin" || SMOKE) app.quit();
    });

    const win = showWindow();
    // Windows sends neither "shutdown" nor before-quit at log off or shut down; the window hears it, and the process
    // ends soon after. The runtime's stdin ends now, so its own shutdown starts first.
    if (WINDOWS) win.on("session-end", systemQuits);
    if (SMOKE) {
      const fail = (reason: string) => {
        log(`SMOKE FAIL: ${reason}`);
        void supervisor.stop().finally(() => app.exit(1));
      };
      if (!hasEntry) return fail(`runtime entry not found: ${runtimeEntry}`);
      const timer = setTimeout(() => fail("timed out"), 60_000);
      smokeTest(win, supervisor).then(
        () => {
          clearTimeout(timer);
          app.once("will-quit", () => log("SMOKE PASS"));
          app.quit();
        },
        (error: unknown) => {
          clearTimeout(timer);
          fail(error instanceof Error ? error.message : String(error));
        },
      );
    }
  });
}
