// The version of a nightly desktop build: <next>-nightly.<YYYYMMDD>.<run> (.github/workflows/desktop-nightly.yml).
// <next> comes after the newest release this commit knows of, from the desktop-v* tags and from the release notes
// in releases/ (a release's notes are pushed to main before the release workflow runs, so a nightly built after
// a release commit but before its tag still counts it). A stable 0.4.2 gives 0.4.3, and a prerelease 0.5.0-rc.1
// gives 0.5.1. So a nightly sorts above every release whose code it may hold and below the release it leads to
// (0.4.3-nightly.* < 0.4.3), which is what lets a Mac switched back to Stable keep its nightly until a release
// holding all of its code ships (src/updates/updateChannels.ts). After a prerelease the next patch, not the
// prerelease's own version: 0.5.0-nightly.* would sort below 0.5.0-rc.1 and Stable would offer the rc over a
// nightly newer than it. Erring high only makes Stable wait longer. Untagged nightlies never count.
//   node apps/desktop/scripts/nightly-version.mjs <run> [YYYYMMDD]
//   node apps/desktop/scripts/nightly-version.mjs check <version> <latest-mac.yml|->
//        exit 1 unless <version> is a nightly newer than the one the feed file names (`-`: none published yet), so
//        the feed itself never goes back
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareSemverVersions, parseSemver } from "../../../packages/shared/src/semver.ts";

/**
 * The release a nightly leads to: the patch after the newest of the desktop-v* tags and the releases/<version>.md
 * notes (`notes`: their file names).
 */
export function nextRelease(tags, notes = []) {
  const versions = [
    ...tags
      .map((tag) => tag.trim())
      .filter((tag) => /^desktop-v\d/.test(tag))
      .map((tag) => tag.slice("desktop-v".length)),
    ...notes
      .map((name) => name.trim())
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3)),
  ]
    .filter((version) => parseSemver(version) !== null && !/-nightly\./.test(version))
    .sort(compareSemverVersions);
  const newest = versions.at(-1);
  if (newest === undefined) return "0.1.0";
  const { major, minor, patch } = parseSemver(newest);
  return `${major}.${minor}.${patch + 1}`;
}

export function nightlyVersion(tags, day, run, notes = []) {
  if (!/^\d{8}$/.test(day)) throw new Error(`the day is YYYYMMDD, not ${day}`);
  if (!/^[1-9]\d*$/.test(String(run)))
    throw new Error(`the run is a positive whole number, not ${run}`);
  return `${nextRelease(tags, notes)}-nightly.${day}.${run}`;
}

/** Whether `version` may replace the feed's current one (its latest-mac.yml text, or undefined when there is none). */
export function newerThanFeed(version, feed) {
  if (!/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(version)) return false;
  const published = feed === undefined ? undefined : /^version:\s*(\S+)\s*$/m.exec(feed)?.[1];
  return published === undefined || compareSemverVersions(version, published) > 0;
}

if (import.meta.main && process.argv[2] === "check") {
  const [, , , version, file] = process.argv;
  const { readFileSync } = await import("node:fs");
  const feed = file === "-" || file === undefined ? undefined : readFileSync(file, "utf8");
  if (!newerThanFeed(version ?? "", feed)) {
    console.error(
      `${version} is not a nightly newer than the feed's ${/^version:\s*(\S+)/m.exec(feed ?? "")?.[1] ?? "(none)"}`,
    );
    process.exit(1);
  }
  console.log(`${version} is newer than the feed's`);
} else if (import.meta.main) {
  const [run, day = new Date().toISOString().slice(0, 10).replaceAll("-", "")] =
    process.argv.slice(2);
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const tags = spawnSync("git", ["tag", "--list", "desktop-v*"], { cwd: root, encoding: "utf8" });
  if (tags.status !== 0) throw new Error(`git tag: ${tags.stderr}`);
  const notes = readdirSync(fileURLToPath(new URL("../../../releases", import.meta.url)));
  console.log(nightlyVersion(tags.stdout.split("\n").filter(Boolean), day, run, notes));
}
