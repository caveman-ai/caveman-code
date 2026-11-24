// ), apps/desktop/src/app/DesktopStartupRecovery.ts @ 67eebaca23.
// When the runtime cannot start, a small window of its own says why and what to do, instead of a page that says
// "Reconnecting" forever: a newer build when the updater has one, the build that last started here, or the newest
// download; Try again, Report a problem, Copy details, Show logs, Quit. Two failures open it:
// - the runtime kept exiting as it started (src/runtime.ts MAX_FAST_RESTARTS), with the last error it wrote;
// - the runtime refused its database because a newer build wrote it (src/runtime.ts DATABASE_NEWER_EXIT_CODE), with
//   what it said. An older build cannot help there, and nothing is deleted or moved: the person's chats wait for a
//   build that knows them.
// The page is plain HTML with JavaScript off; its buttons are links to ACTION_ORIGIN, which will-navigate cancels
// and runs. Dropped from T3: the managed-policy offer and the GitHub releases page (our builds are on
// download.caveman.so).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, clipboard, nativeTheme, shell } from "electron";
import { compareSemverVersions } from "../../../packages/shared/src/semver.ts";
import { channelOf, type UpdateChannel } from "./updates/updateChannels.ts";
import type { UpdateState } from "./updates/updateMachine.ts";

const ACTION_ORIGIN = "https://startup-recovery.invalid";
const ACTIONS = ["update", "download", "retry", "report", "copy", "logs", "quit"] as const;
type Action = (typeof ACTIONS)[number];
export const LAST_STARTED_FILE = "last-started-version";

export type StartupFailure =
  /** It kept exiting as it started; `detail` is the last error line it wrote. */
  | { readonly kind: "keeps-stopping"; readonly detail: string | undefined }
  /** It refused its database, which a newer build wrote; `detail` is what it said. */
  | { readonly kind: "refused-data"; readonly detail: string };

export type RecoveryOffer =
  | { readonly kind: "checking" }
  | { readonly kind: "update"; readonly version: string }
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number | null }
  /** The build that last started on this computer, to download again. */
  | { readonly kind: "reinstall"; readonly version: string }
  /** The newest build on the channel, from download.caveman.so. */
  | { readonly kind: "download" };

/** The problem report this window opens in the app's window (src/main.ts openReport, apps/web shell/ReportProblem.tsx). */
export interface FailureReport {
  readonly surface: "runtime";
  readonly error: { readonly name: string; readonly message: string };
}

export const failureReport = (failure: StartupFailure): FailureReport =>
  failure.kind === "refused-data"
    ? {
        surface: "runtime",
        error: {
          name: "DatabaseNewerThanRuntime",
          message: `The runtime refused data a newer build wrote: ${failure.detail}`,
        },
      }
    : {
        surface: "runtime",
        error: {
          name: "RuntimeKeepsStopping",
          message: failure.detail
            ? `The runtime kept stopping while starting: ${failure.detail}`
            : "The runtime kept stopping while starting.",
        },
      };

/**
 * upstream resolveStartupRecoveryOffer: a newer build first, then (only when the runtime kept stopping) the last build
 * that started here when it is newer than this one, then the newest download. Never an older build: a runtime that
 * keeps stopping has usually migrated the data already, which an older one can't open. A version whose install
 * already failed to take is not offered again: it would loop through install and relaunch.
 */
export const recoveryOffer = (
  failure: StartupFailure,
  update: UpdateState,
  lastStarted: string | null,
): RecoveryOffer => {
  if (update.status === "downloading" && update.next !== null)
    return { kind: "downloading", version: update.next, percent: update.percent };
  if (update.status === "ready" && update.next !== null && update.next !== update.notApplied)
    return { kind: "update", version: update.next };
  if (update.status === "idle" || update.status === "checking") return { kind: "checking" };
  if (
    failure.kind === "keeps-stopping" &&
    lastStarted !== null &&
    compareSemverVersions(lastStarted, update.version) > 0
  )
    return { kind: "reinstall", version: lastStarted };
  return { kind: "download" };
};

/** A build's installer on download.caveman.so: the newest on the channel, or one version's. */
export const downloadUrl = (
  channel: UpdateChannel,
  platform: NodeJS.Platform,
  arch: string,
  version?: string,
): string => {
  const at = version === undefined ? "" : `${version}-`;
  const root = `https://download.caveman.so/code/${channel === "nightly" ? "nightly/" : ""}`;
  return platform === "win32"
    ? `${root}win/Caveman-Code-Setup-${at}x64.exe`
    : `${root}mac/Caveman-Code-${at}${arch === "x64" ? "x64" : "arm64"}.dmg`;
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const link = (action: Action, label: string, primary = false) =>
  `<a class="button${primary ? " primary" : ""}" href="${ACTION_ORIGIN}/${action}">${escapeHtml(label)}</a>`;

const describeOffer = (offer: RecoveryOffer): { text: string; action: string } => {
  switch (offer.kind) {
    case "checking":
      return { text: "Looking for a newer version…", action: "" };
    case "update":
      return {
        text: `Caveman Code ${offer.version} is downloaded and may fix this.`,
        action: link("update", `Restart to ${offer.version}`, true),
      };
    case "downloading":
      return {
        text: `Downloading Caveman Code ${offer.version}${offer.percent === null ? "" : ` (${Math.floor(offer.percent / 10) * 10}%)`}. It can install as soon as it is done.`,
        action: "",
      };
    case "reinstall":
      return {
        text: `Caveman Code ${offer.version} started on this computer before. Download it and install it to go back.`,
        action: link("download", `Download ${offer.version}`, true),
      };
    case "download":
      return {
        text: "Download the newest Caveman Code and install it over this one.",
        action: link("download", "Download the newest", true),
      };
  }
};

export const recoveryHtml = (input: {
  appVersion: string;
  failure: StartupFailure;
  offer: RecoveryOffer;
  logDir: string;
}): string => {
  const { failure, offer } = input;
  const refused = failure.kind === "refused-data";
  const title = refused
    ? "Your chats were opened by a newer Caveman Code"
    : "Caveman Code's runtime keeps stopping";
  const why = refused
    ? "A newer version of Caveman Code last opened your chats and settings, and this one can't read what it saved. Nothing was changed or deleted: they open again in a version at least as new."
    : "It stopped several times in a row while starting, so Caveman Code stopped restarting it. Your chats are kept and come back once it runs.";
  const detail = failure.detail?.trim() || "It wrote no error.";
  const { text, action } = describeOffer(offer);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--bg:#f5f5f5;--fg:#18181b;--muted:#71717a;--line:rgba(0,0,0,.1);--raised:#fff;--code:rgba(0,0,0,.04);--hi:rgba(255,255,255,.6)}
@media (prefers-color-scheme:dark){:root{--bg:#09090a;--fg:#e4e4e7;--muted:#a1a1aa;--line:rgba(255,255,255,.08);--raised:#18181b;--code:rgba(255,255,255,.04);--hi:rgba(255,255,255,.05)}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg)}
body{font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;padding:28px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}
h1{font-size:15px;font-weight:600;margin:0}p{margin:0}.muted{color:var(--muted);font-size:12px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.button{color:var(--fg);text-decoration:none;background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:5px 12px;font-weight:500;box-shadow:inset 0 1px 0 var(--hi),0 1px 1px rgba(0,0,0,.25);transition:background-color 75ms}
.button:hover{background:var(--line)}
.button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
pre{flex:1;min-height:60px;margin:0;overflow:auto;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px;font:11.5px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(why)}</p>
<p>${escapeHtml(text)}</p>
<div class="actions">${action}${refused ? "" : link("retry", "Try again")}${link("report", "Report a problem")}${link("copy", "Copy details")}${link("logs", "Show logs")}${link("quit", "Quit")}</div>
<pre>${escapeHtml(detail)}</pre>
<p class="muted">Caveman Code ${escapeHtml(input.appVersion)}. Logs: ${escapeHtml(input.logDir)}</p>
</body></html>`;
};

export interface RecoveryUpdates {
  readonly current: UpdateState;
  onChange(listener: (state: UpdateState) => void): () => void;
  check(): Promise<unknown>;
}

export interface RecoveryOptions {
  readonly appVersion: string;
  readonly dataDir: string;
  readonly logDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly updates: RecoveryUpdates;
  readonly log: (line: string) => void;
  /** Restart to Update, as Settings does it. */
  readonly install: () => void;
  /** Start the runtime again (src/runtime.ts retry). */
  readonly retry: () => void;
  /** Open the problem report in the app's window; this window comes back once it closes (reportClosed). */
  readonly report: (report: FailureReport) => void;
  readonly quit: () => void;
}

export class StartupRecovery {
  private window: BrowserWindow | undefined;
  private failure: StartupFailure | undefined;
  private rendered = "";
  /** Stepped aside for a problem report from its Report a problem. */
  private reporting = false;
  /** Looked for a newer build since this failure opened. */
  private checked = false;
  private readonly lastStarted: string | null;
  private readonly options: RecoveryOptions;

  constructor(options: RecoveryOptions) {
    this.options = options;
    let last: string | null = null;
    try {
      last = readFileSync(join(options.dataDir, LAST_STARTED_FILE), "utf8").trim() || null;
    } catch {}
    this.lastStarted = last;
    options.updates.onChange(() => {
      this.checkOnce();
      this.render();
    });
  }

  get showing(): StartupFailure | undefined {
    return this.failure;
  }

  private get offer(): RecoveryOffer | undefined {
    return (
      this.failure && recoveryOffer(this.failure, this.options.updates.current, this.lastStarted)
    );
  }

  /** The runtime answered: this version starts here. */
  started(): void {
    this.close();
    if (this.lastStarted === this.options.appVersion) return;
    try {
      writeFileSync(join(this.options.dataDir, LAST_STARTED_FILE), `${this.options.appVersion}\n`);
    } catch (error) {
      this.options.log(
        `recovery: could not record the version that started: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  show(failure: StartupFailure): void {
    this.failure = failure;
    this.options.log(`recovery: showing (${failure.kind})`);
    this.checkOnce();
    this.reveal();
  }

  /**
   * A newer build may fix it: look now rather than at the next timed check, once per failure. A runtime that refuses
   * at once can fail before the updater has started; then it looks as soon as the updater is up.
   */
  private checkOnce(): void {
    if (
      this.checked ||
      this.failure === undefined ||
      this.options.updates.current.status === "disabled"
    )
      return;
    this.checked = true;
    void this.options.updates.check().catch(() => undefined);
  }

  /** Brings the window back (the Dock icon) while a failure is open. */
  reveal(): void {
    if (this.failure === undefined) return;
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 600,
      height: 460,
      minWidth: 420,
      minHeight: 320,
      show: false,
      title: "Caveman Code can't start",
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#09090a" : "#f5f5f5",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const action = ACTIONS.find((name) => url === `${ACTION_ORIGIN}/${name}`);
      if (action !== undefined) this.run(action);
    });
    win.once("ready-to-show", () => !win.isDestroyed() && win.show());
    win.once("closed", () => {
      if (this.window === win) this.window = undefined;
      this.rendered = "";
    });
    this.window = win;
    this.render();
  }

  /** The problem report it opened closed: back to the choices, unless the runtime started meanwhile. */
  reportClosed(): void {
    if (!this.reporting) return;
    this.reporting = false;
    this.reveal();
  }

  close(): void {
    this.failure = undefined;
    this.reporting = false;
    this.checked = false;
    const win = this.window;
    this.window = undefined;
    this.rendered = "";
    if (win && !win.isDestroyed()) win.close();
  }

  private render(): void {
    const win = this.window;
    const offer = this.offer;
    if (!win || win.isDestroyed() || !this.failure || !offer) return;
    const html = recoveryHtml({
      appVersion: this.options.appVersion,
      failure: this.failure,
      offer,
      logDir: this.options.logDir,
    });
    if (html === this.rendered) return;
    this.rendered = html;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  private run(action: Action): void {
    const offer = this.offer;
    const failure = this.failure;
    if (!offer || !failure) return;
    this.options.log(`recovery: ${action}`);
    // A nightly build links Nightly's newest whatever channel is picked: Stable's is older by construction.
    const { channel, buildChannel } = this.options.updates.current;
    const newest = buildChannel === "nightly" ? "nightly" : channel;
    switch (action) {
      case "update":
        if (offer.kind === "update") this.options.install();
        return;
      case "download":
        if (offer.kind === "reinstall")
          void shell.openExternal(
            downloadUrl(
              channelOf(offer.version),
              this.options.platform,
              this.options.arch,
              offer.version,
            ),
          );
        else if (offer.kind === "download")
          void shell.openExternal(downloadUrl(newest, this.options.platform, this.options.arch));
        return;
      case "retry":
        this.close();
        this.options.retry();
        return;
      case "report":
        // As the dialog this window replaced did: the report opens over the app's window, and closing it asks again.
        this.reporting = true;
        this.window?.hide();
        this.options.report(failureReport(failure));
        return;
      case "copy":
        clipboard.writeText(
          `Caveman Code ${this.options.appVersion} (${this.options.platform} ${this.options.arch}) could not start its runtime: ${failure.kind}.\n\n${failure.detail ?? "It wrote no error."}`,
        );
        return;
      case "logs":
        void shell.openPath(this.options.logDir);
        return;
      case "quit":
        this.options.quit();
        return;
    }
  }
}
