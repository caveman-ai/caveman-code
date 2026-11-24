import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appUpdateFeed,
  channelOf,
  feedUrl,
  isNightlyVersion,
  nightlyBuildDay,
  offerable,
  readChannel,
  writeChannel,
} from "../src/updates/updateChannels.ts";

describe("update channels", () => {
  it("tell a nightly by its version", () => {
    expect(isNightlyVersion("0.4.3-nightly.20261109.12")).toBe(true);
    expect(channelOf("0.4.3-nightly.20261109.12")).toBe("nightly");
    expect(channelOf("0.4.3")).toBe("stable");
    // Anything else that is not the nightly scheme updates as stable: a hand-made prerelease, a beta.
    expect(channelOf("0.4.3-beta.1")).toBe("stable");
    expect(channelOf("0.4.3-nightly.2026119.1")).toBe("stable");
    expect(nightlyBuildDay("0.4.3-nightly.20261109.12")).toBe("2026-11-09");
    expect(nightlyBuildDay("0.4.3")).toBeUndefined();
  });

  it("put the nightly feed beside the stable one, for the public feeds and a test feed alike", () => {
    expect(feedUrl("stable", "https://download.caveman.so/code/mac")).toBe(
      "https://download.caveman.so/code/mac",
    );
    expect(feedUrl("nightly", "https://download.caveman.so/code/mac")).toBe(
      "https://download.caveman.so/code/nightly/mac",
    );
    expect(feedUrl("nightly", "https://download.caveman.so/code/win/")).toBe(
      "https://download.caveman.so/code/nightly/win",
    );
    expect(feedUrl("nightly", "http://127.0.0.1:3000/code/mac")).toBe(
      "http://127.0.0.1:3000/code/nightly/mac",
    );
  });

  it("offer only a newer build on the channel picked: never an older one, whichever way the switch went", () => {
    // Stable to Nightly: the newest nightly, when it is newer.
    expect(offerable("0.4.3-nightly.20261109.12", "0.4.2", "nightly")).toBe(true);
    expect(offerable("0.4.2-nightly.20261001.3", "0.4.2", "nightly")).toBe(false);
    // Nightly to Stable: an older stable never installs; the stable of the same number does.
    expect(offerable("0.4.2", "0.4.3-nightly.20261109.12", "stable")).toBe(false);
    expect(offerable("0.4.3", "0.4.3-nightly.20261109.12", "stable")).toBe(true);
    expect(offerable("0.5.0", "0.4.3-nightly.20261109.12", "stable")).toBe(true);
    // Nightlies order by day, then run.
    expect(offerable("0.4.3-nightly.20261110.1", "0.4.3-nightly.20261109.12", "nightly")).toBe(
      true,
    );
    expect(offerable("0.4.3-nightly.20261109.13", "0.4.3-nightly.20261109.12", "nightly")).toBe(
      true,
    );
    expect(offerable("0.4.3-nightly.20261108.99", "0.4.3-nightly.20261109.12", "nightly")).toBe(
      false,
    );
    // The same build, another channel's build, and nonsense.
    expect(offerable("0.4.2", "0.4.2", "stable")).toBe(false);
    expect(offerable("0.5.0", "0.4.2", "nightly")).toBe(false);
    expect(offerable("latest", "0.4.2", "stable")).toBe(false);
  });

  it("read the generic feed app-update.yml names", () => {
    expect(
      appUpdateFeed(
        "provider: generic\nurl: https://download.caveman.so/code/mac\nupdaterCacheDirName: x\n",
      ),
    ).toBe("https://download.caveman.so/code/mac");
    expect(appUpdateFeed("provider: github\nowner: x\n")).toBeUndefined();
    expect(appUpdateFeed("provider: generic\nurl: file:///etc\n")).toBeUndefined();
  });

  it("keep the channel picked, else follow the build's own", () => {
    const dir = mkdtempSync(join(tmpdir(), "caveman-channel-"));
    const file = join(dir, "nested", "update-channel.json");
    expect(readChannel(file, "0.4.2")).toBe("stable");
    expect(readChannel(file, "0.4.3-nightly.20261109.12")).toBe("nightly");
    writeChannel(file, "stable");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ channel: "stable" });
    expect(readChannel(file, "0.4.3-nightly.20261109.12")).toBe("stable");
    writeFileSync(file, "{not json");
    expect(readChannel(file, "0.4.2")).toBe("stable");
    writeFileSync(file, JSON.stringify({ channel: "beta" }));
    expect(readChannel(file, "0.4.3-nightly.20261109.12")).toBe("nightly");
  });
});
