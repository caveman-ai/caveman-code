import { describe, expect, it } from "vitest";
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
  type UpdateState,
} from "../src/updates/updateMachine.ts";

const AT = "2026-11-09T12:00:00.000Z";
const idle = initialUpdateState("0.4.2", "stable", null);

describe("the update state machine", () => {
  it("starts idle, or disabled with the reason", () => {
    expect(idle).toMatchObject({
      status: "idle",
      version: "0.4.2",
      channel: "stable",
      buildChannel: "stable",
      next: null,
      message: null,
      notApplied: null,
    });
    expect(
      initialUpdateState(
        "0.4.3-nightly.20261109.12",
        "stable",
        "Updates are off in development builds.",
      ),
    ).toMatchObject({
      status: "disabled",
      buildChannel: "nightly",
      message: "Updates are off in development builds.",
    });
  });

  it("runs check, found, progress, downloaded", () => {
    const checking = onCheckStart(idle, AT);
    expect(checking).toMatchObject({ status: "checking", checkedAt: AT, next: null });
    const found = onUpdateAvailable(checking, "0.4.3", AT, [
      { version: "0.4.3", items: ["Faster"], releasedAt: null },
    ]);
    expect(found).toMatchObject({ status: "downloading", next: "0.4.3", percent: 0 });
    expect(onDownloadProgress(found, 57.9).percent).toBe(57);
    expect(onDownloadProgress(found, 140).percent).toBe(100);
    expect(onDownloadProgress(found, -3).percent).toBe(0);
    const ready = onDownloaded(onDownloadProgress(found, 99), "0.4.3");
    expect(ready).toMatchObject({
      status: "ready",
      next: "0.4.3",
      percent: 100,
      failed: null,
      message: null,
    });
    expect(ready.notes).toHaveLength(1);
  });

  it("clears an offer when the next check finds nothing", () => {
    const found = onUpdateAvailable(onCheckStart(idle, AT), "0.4.3", AT, [
      { version: "0.4.3", items: ["x"], releasedAt: null },
    ]);
    expect(onNoUpdate(found, AT)).toMatchObject({
      status: "current",
      next: null,
      notes: [],
      percent: null,
    });
  });

  it("names what failed, and a later check clears it", () => {
    const failed = onCheckFailure(onCheckStart(idle, AT), "offline", AT);
    expect(failed).toMatchObject({ status: "error", failed: "check", message: "offline" });
    expect(onCheckStart(failed, AT)).toMatchObject({
      status: "checking",
      failed: null,
      message: null,
    });
    const download = onDownloadFailure(onUpdateAvailable(idle, "0.4.3", AT), "checksum");
    expect(download).toMatchObject({
      status: "error",
      failed: "download",
      next: "0.4.3",
      percent: null,
    });
  });

  it("keeps a ready update ready when its install does not start", () => {
    const ready = onDownloaded(onUpdateAvailable(idle, "0.4.3", AT), "0.4.3");
    expect(onInstallFailure(ready, "No installer")).toMatchObject({
      status: "ready",
      next: "0.4.3",
      failed: "install",
      message: "No installer",
    });
  });

  it("on a channel switch keeps what that channel offers, and starts anything else over", () => {
    const current: UpdateState = onNoUpdate(onCheckStart(idle, AT), AT);
    expect(onChannelChange(current, "nightly")).toMatchObject({
      status: "idle",
      channel: "nightly",
      next: null,
    });
    // Nightly offers only nightlies: a stable download stops, and the Nightly feed's newer build follows.
    const downloading = onUpdateAvailable(idle, "0.4.3", AT);
    expect(onChannelChange(downloading, "nightly")).toMatchObject({
      status: "idle",
      channel: "nightly",
      next: null,
    });
    // A check under way runs again on the new channel.
    expect(onChannelChange(onCheckStart(idle, AT), "nightly")).toMatchObject({
      status: "checking",
      channel: "nightly",
    });
    const failed = onCheckFailure(idle, "offline", AT);
    expect(onChannelChange(failed, "nightly")).toMatchObject({
      status: "idle",
      failed: null,
      message: null,
    });
    const off = initialUpdateState("0.4.2", "stable", "off");
    expect(onChannelChange(off, "nightly")).toMatchObject({
      status: "disabled",
      channel: "nightly",
      message: "off",
    });
  });

  it("on another channel, stops a download or a ready update that channel would not offer", () => {
    const nightly = onUpdateAvailable(idle, "0.4.3-nightly.20261109.4", AT);
    const onNightly = { ...nightly, channel: "nightly" as const };
    // Downloading a nightly, the person goes back to Stable: the download stops (the caller cancels it).
    expect(onChannelChange(onNightly, "stable")).toMatchObject({
      status: "idle",
      channel: "stable",
      next: null,
    });
    const ready = onDownloaded(onNightly, "0.4.3-nightly.20261109.4");
    // Windows: the installer is dropped and kept from installing at quit.
    expect(onChannelChange(ready, "stable")).toMatchObject({ status: "idle", next: null });
    // macOS: Squirrel.Mac already holds it and installs it at quit, so Settings says that.
    expect(onChannelChange(ready, "stable", false)).toMatchObject({
      status: "ready",
      channel: "stable",
      next: "0.4.3-nightly.20261109.4",
      message: "0.4.3-nightly.20261109.4 was already downloaded and installs when you quit.",
    });
    // Back on Nightly, it is an ordinary ready update again.
    expect(
      onChannelChange(onChannelChange(ready, "stable", false), "nightly", false),
    ).toMatchObject({
      status: "ready",
      message: null,
    });
  });

  it("reads an install that did not take from the record it left", () => {
    expect(notAppliedVersion({ from: "0.4.2", to: "0.4.3" }, "0.4.2")).toBe("0.4.3");
    expect(notAppliedVersion({ from: "0.4.2", to: "0.4.3" }, "0.4.3")).toBeNull();
    expect(notAppliedVersion({ from: "0.4.1", to: "0.4.2" }, "0.4.2")).toBeNull();
  });
});
