// Auto-update from the public feeds (src/updates/updateChannels.ts): Stable at https://download.caveman.so/code/mac
// or /code/win (scripts/package.mjs writes it into <resources>/app-update.yml; .github/workflows/desktop-release.yml
// stages a build there and desktop-publish.yml makes it the one installed apps fetch), Nightly at /code/nightly/mac
// or /code/nightly/win (.github/workflows/desktop-nightly.yml). The feeds are public files, so a check carries no
// login and no token.
// ), apps/desktop/src/updates/DesktopUpdates.ts @ 67eebaca23, without its Effect services:
// the state moves through updateMachine.ts, an update is offered only when it is on the channel picked and newer
// than this build (never older, whichever channel), found updates download in the background, and they install on
// the next quit or on "Restart to Update". macOS installs through Squirrel.Mac; Windows runs the NSIS installer
// electron-updater downloaded (and, in a signed build, checked against this app's publisher) silently, then
// reopens the app. Dropped from T3: the managed policy (this app has no managed settings), Linux packages, the
// backend pool's stop and restart around an install (main.ts stops the runtime), remote installs.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, autoUpdater as squirrel } from "electron";
import {
  autoUpdater,
  CancellationToken,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater";
import { normalizeReleaseNotes } from "./releaseNotes.ts";
import {
  appUpdateFeed,
  feedUrl,
  offerable,
  readChannel,
  UPDATE_CHANNELS,
  writeChannel,
  type UpdateChannel,
} from "./updateChannels.ts";
import {
  initialUpdateState,
  notAppliedVersion,
  onChannelChange,
  onCheckFailure,
  onCheckStart,
  onDownloaded,
  onDownloadFailure,
  onDownloadProgress,
  onInstallFailure,
  onNoUpdate,
  onUpdateAvailable,
  stagedOffChannel,
  type InstallRecord,
  type UpdateState,
} from "./updateMachine.ts";

export type { UpdateState } from "./updateMachine.ts";

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
export const CHANNEL_FILE = "update-channel.json";
export const INSTALL_RECORD_FILE = "update-install.json";

/** Error text safe for logs and Settings: first line only, anything token-shaped removed. */
export const redact = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .split("\n")[0]!
    .replace(/\b(gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "<token>")
    .replace(/(authorization|token)(["':=\s]+)[^\s,"']+/gi, "$1$2<redacted>")
    .slice(0, 300);

/** Ported from upstream getAutoUpdateDisabledReason: why this build does not update itself, or null. */
export const updateDisabledReason = (build: {
  packaged: boolean;
  smoke: boolean;
  feed: string | undefined;
}): string | null => {
  if (!build.packaged) return "Updates are off in development builds.";
  if (build.smoke) return "Updates are off in the smoke test.";
  if (build.feed === undefined)
    return "This build was made on this computer and has no update feed.";
  return null;
};

const readInstallRecord = (file: string): InstallRecord | undefined => {
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as Partial<InstallRecord>;
    return typeof record.from === "string" && typeof record.to === "string"
      ? { from: record.from, to: record.to }
      : undefined;
  } catch {
    return undefined;
  }
};

export class Updates {
  private state: UpdateState;
  private timer: NodeJS.Timeout | undefined;
  private readonly log: (line: string) => void;
  private readonly channelFile: string;
  private readonly installFile: string;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  /** The stable feed (app-update.yml's, or a test build's); the nightly one is derived from it. */
  private stableFeed: string | undefined;
  /** The channel changed while a check ran: check again on the new one once it ends. */
  private recheck = false;
  private loggedPercent = -1;
  /**
   * Set by main.ts: Restart to Update (or Squirrel.Mac) is quitting the app to install. It runs synchronously,
   * before the app's own before-quit, which must then let the quit through: cancelling it to stop the runtime
 * first breaks the native updater's install and relaunch on macOS (upstream, app/DesktopLifecycle.ts).
   */
  onQuitForUpdate: () => void = () => undefined;
  /**
   * Set by main.ts: why a ready update must not install now, or undefined. On Windows the installer replaces the app's
   * files, its node.exe among them, and cannot while a runtime this app did not start runs it (`caveman-code` in a
   * terminal); NSIS can then report success over a half-replaced install. Restart to Update refuses and install on
   * quit is skipped while it says so; the update stays ready for when it no longer does.
   */
  installBlocked: () => string | undefined = () => undefined;
  /** The download under way: the version, its cancel, and its end (resolved or not). */
  private download:
    | { version: string; token: CancellationToken; done: Promise<unknown> }
    | undefined;
  /**
   * Windows: an installer electron-updater holds that the channel picked would not offer. Kept from installing at
   * quit (electron-updater would run whatever it last downloaded) until a channel offers it again.
   */
  private keptFromQuit: string | null = null;

  /** `dataDir`: where the channel picked and the last install's record live (the app's userData). */
  constructor(log: (line: string) => void, dataDir: string) {
    this.log = log;
    this.channelFile = join(dataDir, CHANNEL_FILE);
    this.installFile = join(dataDir, INSTALL_RECORD_FILE);
    this.state = initialUpdateState(
      app.getVersion(),
      readChannel(this.channelFile, app.getVersion()),
      "Updates start once the app has opened.",
    );
  }

  get current(): UpdateState {
    const blocked = this.state.status === "ready" ? this.installBlocked() : undefined;
    return blocked ? { ...this.state, message: blocked } : this.state;
  }

  /** Every state change, until the returned function is called (the startup recovery window follows it). */
  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private set(next: UpdateState) {
    const before = this.state;
    this.state = next;
    const progress =
      next.status === "downloading" &&
      next.percent !== null &&
      next.percent >= this.loggedPercent + 25;
    if (progress) this.loggedPercent = next.percent! - (next.percent! % 25);
    if (next.status !== "downloading") this.loggedPercent = -1;
    if (
      progress ||
      before.status !== next.status ||
      before.next !== next.next ||
      before.message !== next.message ||
      before.channel !== next.channel
    )
      this.log(
        `updates: ${next.status} on ${next.channel}${next.next ? ` ${next.next}` : ""}${next.status === "downloading" && next.percent !== null ? ` ${next.percent}%` : ""}${next.message ? ` (${next.message})` : ""}`,
      );
    for (const listener of this.listeners) listener(this.current);
  }

  private get now(): string {
    return new Date().toISOString();
  }

  /**
   * Packaged builds with a feed only; never development or the smoke test.
   * `testFeed`: another generic feed instead of the public one (the update test; main.ts
   * passes CAVEMAN_UPDATE_FEED_URL only to builds made without --release). Nightly is it with nightly/ added.
   */
  start(smoke: boolean, testFeed?: string): void {
    const version = app.getVersion();
    // Only a packaged app has resources of its own (test/main.test.ts runs main.ts on plain Node, which has none).
    const yml = app.isPackaged ? join(process.resourcesPath, "app-update.yml") : undefined;
    this.stableFeed =
      testFeed ??
      (yml !== undefined && existsSync(yml) ? appUpdateFeed(readFileSync(yml, "utf8")) : undefined);
    const record = readInstallRecord(this.installFile);
    const notApplied = record ? notAppliedVersion(record, version) : null;
    if (record && notApplied === null) rmSync(this.installFile, { force: true });
    if (notApplied !== null)
      this.log(`updates: the install of ${notApplied} did not take; this is still ${version}`);
    const disabled = updateDisabledReason({
      packaged: app.isPackaged,
      smoke,
      feed: this.stableFeed,
    });
    this.set(initialUpdateState(version, this.state.channel, disabled, notApplied));
    if (disabled !== null) return;
    autoUpdater.logger = null;
    // Found updates are judged first (offerable) and only then downloaded: autoDownload would fetch any newer
    // build the feed names, whatever its channel.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // electron-updater may offer an older build only when told to; never.
    autoUpdater.allowDowngrade = false;
    // An Intel build on Apple Silicon moves to the arm64 build, whose blocks share nothing with this one's.
    if (app.runningUnderARM64Translation) autoUpdater.disableDifferentialDownload = true;
    this.useFeed(this.state.channel);
    autoUpdater.on("update-available", (info: UpdateInfo) => this.found(info));
    autoUpdater.on("update-not-available", () => this.set(onNoUpdate(this.state, this.now)));
    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      if (this.state.status === "downloading")
        this.set(onDownloadProgress(this.state, progress.percent));
    });
    // On macOS electron-updater says "downloaded" before Squirrel.Mac has checked the new app's signature
    // against this one's; only Squirrel's own event means a restart will install it. Elsewhere there is no
 // such step: electron-updater's own event is the ready installer (upstream DesktopUpdates does the same).
    if (process.platform === "darwin") {
      autoUpdater.on("update-downloaded", () => {
        if (this.state.status === "downloading") this.set(onDownloadProgress(this.state, 100));
      });
      // Squirrel.Mac took it and installs it at quit, whatever channel is picked by now: say so when that changed.
      squirrel.on("update-downloaded", () => {
        const staged = this.download?.version ?? this.state.next ?? version;
        const ready = onDownloaded(this.state, staged);
        this.set(
          offerable(staged, version, this.state.channel)
            ? ready
            : { ...ready, message: stagedOffChannel(staged) },
        );
      });
    } else {
      autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
        if (!offerable(info.version, version, this.state.channel)) {
          this.keptFromQuit = info.version;
          this.log(
            `updates: not installing ${info.version}: not a newer ${this.state.channel} build`,
          );
          return;
        }
        this.keptFromQuit = null;
        this.set(onDownloaded(this.state, info.version));
      });
    }
    // Squirrel.Mac emits it, and electron-updater emits it on the same emitter for the NSIS installer.
    squirrel.on("before-quit-for-update", () => {
      this.log("updates: quitting to install");
      this.onQuitForUpdate();
    });
    autoUpdater.on("error", (error: unknown) => this.failed(redact(error)));
    // electron-updater installs on quit from its own `quit` listener, added when a download finishes and so after this
    // one, which reads autoInstallOnAppQuit then: `app.exit()` emits `quit` too, never before-quit or will-quit.
    app.on("quit", () => {
      const blocked = this.installBlocked();
      autoUpdater.autoInstallOnAppQuit = blocked === undefined && this.keptFromQuit === null;
      if (this.state.status !== "ready") return;
      if (blocked) this.log(`updates: not installing on quit (${blocked})`);
      else this.recordInstall();
    });
    this.timer = setTimeout(() => void this.check(), FIRST_CHECK_MS);
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }

  private useFeed(channel: UpdateChannel) {
    if (this.stableFeed === undefined) return;
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl(channel, this.stableFeed) });
  }

  /** A build the feed offers: downloaded only when it is on the channel picked and newer than this one. */
  private found(info: UpdateInfo) {
    const { version, channel } = this.state;
    if (!offerable(info.version, version, channel)) {
      this.log(
        `updates: not offering ${info.version}: not a newer ${channel} build than ${version}`,
      );
      this.set(onNoUpdate(this.state, this.now));
      return;
    }
    this.set(
      onUpdateAvailable(
        this.state,
        info.version,
        this.now,
        normalizeReleaseNotes(info.releaseNotes, info.version, channel, info.releaseDate),
      ),
    );
    const token = new CancellationToken();
    const done = autoUpdater.downloadUpdate(token).catch((error: unknown) => {
      // A channel switch cancelled it (setChannel); that is no failure.
      if (!token.cancelled) this.failed(redact(error));
    });
    this.download = { version: info.version, token, done };
  }

  /** electron-updater's error (or a rejected call): whatever was under way failed. */
  private failed(message: string) {
    const { status } = this.state;
    if (status === "checking") this.set(onCheckFailure(this.state, message, this.now));
    else if (status === "downloading") this.set(onDownloadFailure(this.state, message));
    else if (status === "ready") this.set(onInstallFailure(this.state, message));
    else this.log(`updates: ${message}`);
  }

  private recordInstall() {
    const to = this.state.next;
    if (to === null) return;
    try {
      writeFileSync(
        this.installFile,
        `${JSON.stringify({ from: this.state.version, to } satisfies InstallRecord)}\n`,
      );
    } catch (error) {
      this.log(`updates: could not record the install: ${redact(error)}`);
    }
  }

  async check(): Promise<UpdateState> {
    clearTimeout(this.timer);
    const { status } = this.state;
    if (
      status === "disabled" ||
      status === "checking" ||
      status === "downloading" ||
      status === "ready"
    )
      return this.current;
    this.set(onCheckStart(this.state, this.now));
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // electron-updater also emits "error"; set it here when it did not.
      if (this.state.status === "checking")
        this.set(onCheckFailure(this.state, redact(error), this.now));
    }
    if (this.recheck) {
      this.recheck = false;
      return this.check();
    }
    return this.current;
  }

  /**
   * Settings > General's channel. Saved for the next start, and checked at once: switching to Stable from a nightly
   * finds nothing until a stable release newer than this build ships (never older).
   */
  async setChannel(channel: UpdateChannel): Promise<UpdateState> {
    if (!UPDATE_CHANNELS.includes(channel) || channel === this.state.channel) return this.current;
    try {
      writeChannel(this.channelFile, channel);
    } catch (error) {
      this.log(`updates: could not save the channel: ${redact(error)}`);
      return this.current;
    }
    const before = this.state;
    // Squirrel.Mac can't give back an update it took; electron-updater's installer can be kept from running.
    this.set(onChannelChange(this.state, channel, process.platform !== "darwin"));
    if (before.status === "disabled") return this.current;
    if (before.status === "downloading" && this.state.status !== "downloading" && this.download) {
      this.download.token.cancel();
      // A new check would otherwise join the cancelled download (electron-updater returns the one under way).
      await this.download.done;
    }
    if (before.status === "ready" && this.state.status !== "ready") this.keptFromQuit = before.next;
    if (this.keptFromQuit !== null && offerable(this.keptFromQuit, this.state.version, channel))
      this.keptFromQuit = null;
    this.useFeed(channel);
    if (before.status === "checking") this.recheck = true;
    return this.state.status === "idle" ? this.check() : this.current;
  }

  /**
   * Quits, installs the downloaded update and reopens the app. Resolves false when it will not quit: no update ready,
   * installBlocked, or (Windows) electron-updater found no installer to run; the app then carries on.
   */
  async install(): Promise<boolean> {
    if (this.state.status !== "ready" || this.installBlocked() !== undefined) return false;
    this.recordInstall();
    if (process.platform === "darwin") {
      autoUpdater.quitAndInstall();
      return true;
    }
    // Windows: the installer runs silently, then reopens the app. electron-updater emits before-quit-for-update and
    // quits on the next turn once it started the installer, and does neither when it could not (it emits "error").
    let quitting = false;
    const quits = () => (quitting = true);
    squirrel.once("before-quit-for-update", quits);
    autoUpdater.quitAndInstall(true, true);
    await new Promise((resolve) => setImmediate(resolve));
    squirrel.off("before-quit-for-update", quits);
    if (!quitting) {
      this.log("updates: the installer did not start; staying open");
      rmSync(this.installFile, { force: true });
      if (this.state.failed !== "install")
        this.set(onInstallFailure(this.state, "The installer did not start."));
    }
    return quitting;
  }
}
