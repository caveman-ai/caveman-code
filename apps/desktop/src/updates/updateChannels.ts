// ), apps/desktop/src/updates/updateChannels.ts and the channel helpers of
// packages/shared/src/cliRelease.ts @ 67eebaca23, cut to two channels on public feeds.
//
// Stable reads https://download.caveman.so/code/{mac,win}, the feed scripts/package.mjs writes into
// <resources>/app-update.yml. Nightly reads https://download.caveman.so/code/nightly/{mac,win}, the same
// path with nightly/ before the platform, built from main by .github/workflows/desktop-nightly.yml as
// <next>-nightly.<YYYYMMDD>.<run>. Each feed has its own latest-mac.yml / latest.yml, so electron-updater's
// own `channel` is never set (setting it also turns its downgrades on).
//
// Never older: an update must be newer than the running build and belong to the channel picked. A nightly
// sorts below the stable release of the same number (0.4.3-nightly.20261109.12 < 0.4.3), so a Mac switched
// back to Stable keeps its nightly until a newer stable ships: an older runtime never opens a database a
// nightly migrated.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compareSemverVersions, parseSemver } from "../../../../packages/shared/src/semver.ts";

export type UpdateChannel = "stable" | "nightly";
export const UPDATE_CHANNELS: ReadonlyArray<UpdateChannel> = ["stable", "nightly"];

const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.(\d{4})(\d{2})(\d{2})\.\d+$/;

export const isNightlyVersion = (version: string): boolean => NIGHTLY_VERSION.test(version);

/** The channel a build belongs to: its version says. */
export const channelOf = (version: string): UpdateChannel =>
  isNightlyVersion(version) ? "nightly" : "stable";

/** The UTC day a nightly was built, `YYYY-MM-DD`, from its version; undefined for any other. */
export const nightlyBuildDay = (version: string): string | undefined => {
  const day = NIGHTLY_VERSION.exec(version);
  return day ? `${day[1]}-${day[2]}-${day[3]}` : undefined;
};

/**
 * The feed for `channel`, from the stable feed in app-update.yml (or a test build's CAVEMAN_UPDATE_FEED_URL):
 * nightly/ goes before its last segment, `.../code/mac` -> `.../code/nightly/mac`.
 */
export const feedUrl = (channel: UpdateChannel, stableFeed: string): string => {
  const base = stableFeed.replace(/\/+$/, "");
  if (channel === "stable") return base;
  const cut = base.lastIndexOf("/");
  return `${base.slice(0, cut)}/nightly${base.slice(cut)}`;
};

/** Whether `version` may install over `appVersion` on `channel`: on that channel and strictly newer. */
export const offerable = (version: string, appVersion: string, channel: UpdateChannel): boolean =>
  parseSemver(version) !== null &&
  channelOf(version) === channel &&
  compareSemverVersions(version, appVersion) > 0;

/** The `url:` of a generic feed in app-update.yml; undefined when it has none. */
export const appUpdateFeed = (yaml: string): string | undefined => {
  const provider = /^provider:\s*(\S+)\s*$/m.exec(yaml)?.[1];
  const url = /^url:\s*(\S+)\s*$/m.exec(yaml)?.[1];
  return provider === "generic" && url && /^https?:\/\//.test(url) ? url : undefined;
};

/**
 * The channel the person picked (userData/update-channel.json), else the build's own: a nightly build follows
 * Nightly until someone picks Stable.
 */
export const readChannel = (file: string, appVersion: string): UpdateChannel => {
  try {
    const { channel } = JSON.parse(readFileSync(file, "utf8")) as { channel?: unknown };
    if (channel === "stable" || channel === "nightly") return channel;
  } catch {}
  return channelOf(appVersion);
};

export const writeChannel = (file: string, channel: UpdateChannel): void => {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ channel })}\n`);
};
