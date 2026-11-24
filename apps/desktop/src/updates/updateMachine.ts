// ), apps/desktop/src/updates/updateMachine.ts @ 67eebaca23.
// The updater's state as pure transitions, one per thing electron-updater (or the person) does, so every path is
// tested without Electron. Ours downloads in the background as soon as an update is found, so upstream "available"
// folds into "downloading", and "ready" is upstream "downloaded": on macOS only once Squirrel.Mac took the download
// (src/updates/DesktopUpdates.ts).
import { channelOf, offerable, type UpdateChannel } from "./updateChannels.ts";

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "current"
  | "downloading"
  | "ready"
  | "error";

/** One build's notes from its feed (src/updates/releaseNotes.ts). */
export interface ReleaseNote {
  readonly version: string;
  readonly items: ReadonlyArray<string>;
  /** `YYYY-MM-DD` or an ISO time; null when the feed has none. */
  readonly releasedAt: string | null;
}

export interface UpdateState {
  readonly status: UpdateStatus;
  /** This app's version. */
  readonly version: string;
  /** The channel picked in Settings > General. */
  readonly channel: UpdateChannel;
  /** The channel this build came from: a nightly on Stable stays until a newer stable ships. */
  readonly buildChannel: UpdateChannel;
  /** The newer version found, downloading or downloaded. */
  readonly next: string | null;
  /** 0-100 while downloading. */
  readonly percent: number | null;
  /** Why updates are off, what went wrong, or why a ready update cannot install now. */
  readonly message: string | null;
  readonly failed: "check" | "download" | "install" | null;
  readonly checkedAt: string | null;
  /** The offered build's notes from its feed. */
  readonly notes: ReadonlyArray<ReleaseNote>;
  /** The last install, to this version, did not take (the app reopened as the same version). */
  readonly notApplied: string | null;
}

export const initialUpdateState = (
  version: string,
  channel: UpdateChannel,
  disabledReason: string | null,
  notApplied: string | null = null,
): UpdateState => ({
  status: disabledReason === null ? "idle" : "disabled",
  version,
  channel,
  buildChannel: channelOf(version),
  next: null,
  percent: null,
  message: disabledReason,
  failed: null,
  checkedAt: null,
  notes: [],
  notApplied,
});

const settled = { percent: null, message: null, failed: null } as const;

export const onCheckStart = (state: UpdateState, at: string): UpdateState => ({
  ...state,
  ...settled,
  status: "checking",
  next: null,
  notes: [],
  checkedAt: at,
});

export const onCheckFailure = (state: UpdateState, message: string, at: string): UpdateState => ({
  ...state,
  ...settled,
  status: "error",
  message,
  failed: "check",
  checkedAt: at,
});

/** A newer build on the channel: the download starts at once. */
export const onUpdateAvailable = (
  state: UpdateState,
  version: string,
  at: string,
  notes: ReadonlyArray<ReleaseNote> = [],
): UpdateState => ({
  ...state,
  ...settled,
  status: "downloading",
  next: version,
  percent: 0,
  notes,
  checkedAt: at,
});

export const onNoUpdate = (state: UpdateState, at: string): UpdateState => ({
  ...state,
  ...settled,
  status: "current",
  next: null,
  notes: [],
  checkedAt: at,
});

export const onDownloadProgress = (state: UpdateState, percent: number): UpdateState => ({
  ...state,
  ...settled,
  status: "downloading",
  percent: Math.max(0, Math.min(100, Math.floor(percent))),
});

/** The update will install on the next quit, or now on Restart to Update. */
export const onDownloaded = (state: UpdateState, version: string): UpdateState => ({
  ...state,
  ...settled,
  status: "ready",
  next: version,
  percent: 100,
});

/** The next check downloads it again; `next` stays so Settings can name what failed. */
export const onDownloadFailure = (state: UpdateState, message: string): UpdateState => ({
  ...state,
  ...settled,
  status: "error",
  message,
  failed: "download",
});

/** Restart to Update did not quit: the download is still there for the next quit or another try. */
export const onInstallFailure = (state: UpdateState, message: string): UpdateState => ({
  ...state,
  status: "ready",
  message,
  failed: "install",
});

/**
 * Another channel picked. A check under way runs again on it (DesktopUpdates). A download or a downloaded update the
 * new channel still offers stays; one it would not offer stops (the caller cancels the download, and keeps an
 * installer it already has from installing at quit), except an update Squirrel.Mac already took (`canUnstage`
 * false): that one installs when the app quits, and says so. It is newer than this build either way, never older.
 */
export const onChannelChange = (
  state: UpdateState,
  channel: UpdateChannel,
  canUnstage = true,
): UpdateState => {
  if (state.status === "disabled" || state.status === "checking") return { ...state, channel };
  if (state.status === "downloading" || state.status === "ready") {
    if (state.next !== null && offerable(state.next, state.version, channel))
      return { ...state, channel, message: null };
    if (state.status === "ready" && !canUnstage)
      return { ...state, channel, message: stagedOffChannel(state.next) };
  }
  return { ...state, ...settled, channel, status: "idle", next: null, notes: [] };
};

/** A ready update the channel picked would not offer, which installs at quit all the same (macOS). */
export const stagedOffChannel = (next: string | null): string =>
  `${next ?? "An update"} was already downloaded and installs when you quit.`;

/** What an install leaves behind (userData/update-install.json) until the app starts again. */
export interface InstallRecord {
  readonly from: string;
  readonly to: string;
}

/** The version an install meant to reach when the app reopened as the version it left; null when it took. */
export const notAppliedVersion = (record: InstallRecord, appVersion: string): string | null =>
  record.from === appVersion && record.to !== appVersion ? record.to : null;
