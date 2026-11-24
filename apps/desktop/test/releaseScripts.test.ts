import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs scripts without type declarations
import { serveUpdates, servedFile } from "../scripts/mock-update-server.mjs";
// @ts-expect-error plain .mjs scripts without type declarations
import { newerThanFeed, nextRelease, nightlyVersion } from "../scripts/nightly-version.mjs";
import { channelOf, offerable } from "../src/updates/updateChannels.ts";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

describe("nightly versions", () => {
  it("lead to the patch after the newest tag or release note", () => {
    expect(nextRelease(["desktop-v0.4.1", "desktop-v0.4.2", "desktop-v0.3.9"])).toBe("0.4.3");
    expect(nextRelease([])).toBe("0.1.0");
    expect(
      nextRelease(["desktop-v0.4.2", "desktop-v0.4.3-nightly.20261109.1", "v9.9.9-junk"]),
    ).toBe("0.4.3");
    // A release staged but not yet tagged: its notes are on main, so the nightly after it sorts above it.
    expect(nextRelease(["desktop-v0.4.2"], ["README.md", "0.4.2.md", "0.4.3.md"])).toBe("0.4.4");
    expect(
      offerable("0.4.3", nightlyVersion(["desktop-v0.4.2"], "20261110", 7, ["0.4.3.md"]), "stable"),
    ).toBe(false);
  });

  it("sort above a prerelease, so Stable never offers it over a nightly that may hold newer code", () => {
    expect(nextRelease(["desktop-v0.4.2", "desktop-v0.5.0-rc.1"])).toBe("0.5.1");
    expect(nextRelease(["desktop-v0.1.0-beta.1"])).toBe("0.1.1");
    const nightly = nightlyVersion(["desktop-v0.5.0-rc.1"], "20261110", 3);
    expect(offerable("0.5.0-rc.1", nightly, "stable")).toBe(false);
    expect(offerable("0.5.0", nightly, "stable")).toBe(false);
    expect(offerable("0.5.1", nightly, "stable")).toBe(true);
  });

  it("are <next>-nightly.<YYYYMMDD>.<run>, on the Nightly channel, above the last release and below the next", () => {
    const version = nightlyVersion(["desktop-v0.4.2"], "20261109", 12);
    expect(version).toBe("0.4.3-nightly.20261109.12");
    expect(channelOf(version)).toBe("nightly");
    expect(offerable(version, "0.4.2", "nightly")).toBe(true);
    expect(offerable("0.4.3", version, "stable")).toBe(true);
    expect(offerable("0.4.2", version, "stable")).toBe(false);
    expect(() => nightlyVersion([], "2026-11-09", 1)).toThrow(/YYYYMMDD/);
    expect(() => nightlyVersion([], "20261109", 0)).toThrow(/positive/);
  });

  it("are published only above the nightly the feed serves, so the feed never goes back", () => {
    const feed = "version: 0.4.3-nightly.20261109.12\nfiles:\n  - url: x.zip\n";
    expect(newerThanFeed("0.4.3-nightly.20261110.13", feed)).toBe(true);
    expect(newerThanFeed("0.4.3-nightly.20261109.12", feed)).toBe(false);
    expect(newerThanFeed("0.1.0-nightly.20261110.13", feed)).toBe(false);
    expect(newerThanFeed("0.4.3-nightly.20261110.13", undefined)).toBe(true);
    expect(newerThanFeed("0.4.4", undefined)).toBe(false);
  });
});

describe("nightly notes", () => {
  const notes = (version: string) =>
    spawnSync(process.execPath, [join(scripts, "release-notes.mjs"), "nightly", version], {
      encoding: "utf8",
    });
  it("are the feat, fix and perf subjects since the last release, then where it was built from", () => {
    const run = notes("0.4.3-nightly.20261109.12");
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(lines.at(-1)).toMatch(/^Built from [0-9a-f]{10} on main, \d+ changes since /);
    for (const line of lines.slice(0, -2)) expect(line).toMatch(/^- /);
    // Whole, however many changes there are (a pipe on macOS cut it at 64 KB), and the newest 50 at most.
    expect(lines.slice(0, -2).length).toBeLessThanOrEqual(50);
  });
  it("are only for nightly versions; a stable release still needs its written notes", () => {
    expect(notes("0.4.3").status).toBe(2);
  });
});

describe("the mock update server", () => {
  const layout = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "caveman-mock-feed-")));
    const root = join(base, "root");
    mkdirSync(join(root, "code", "nightly", "mac"), { recursive: true });
    writeFileSync(
      join(root, "code", "nightly", "mac", "latest-mac.yml"),
      "version: 0.4.3-nightly.20261109.12\n",
    );
    writeFileSync(join(base, "secret.txt"), "nope\n");
    symlinkSync(join(base, "secret.txt"), join(root, "code", "escape.yml"));
    return { root, base };
  };

  it("serves files inside its root, never outside it, encoded or through a link", () => {
    const { root } = layout();
    expect(servedFile(root, "/code/nightly/mac/latest-mac.yml?noCache=1")).toBe(
      join(root, "code", "nightly", "mac", "latest-mac.yml"),
    );
    expect(servedFile(root, "/%2e%2e/secret.txt")).toBeUndefined();
    expect(servedFile(root, "/../secret.txt")).toBeUndefined();
    expect(servedFile(root, "/code/escape.yml")).toBeUndefined();
    expect(servedFile(root, "/code")).toBeUndefined();
    expect(servedFile(root, "/%E0%A4%A")).toBeUndefined();
    expect(servedFile(root, "/code/x%00.yml")).toBeUndefined();
  });

  it("answers over HTTP as the feed does", async () => {
    const { root } = layout();
    const server = await serveUpdates(root, 0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const feed = await fetch(`${base}/code/nightly/mac/latest-mac.yml`);
      expect(feed.status).toBe(200);
      expect(await feed.text()).toBe("version: 0.4.3-nightly.20261109.12\n");
      expect((await fetch(`${base}/%2e%2e/secret.txt`)).status).toBe(404);
      expect((await fetch(`${base}/code/escape.yml`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
