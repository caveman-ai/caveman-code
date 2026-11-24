import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundleOf,
  compareVersions,
  conflictMessage,
  conflictOf,
  diskImageMounts,
  installerToEject,
  MOVE_QUESTION,
  plistString,
  readMoveRecord,
  shouldOfferMove,
  volumeOf,
  writeMoveRecord,
} from "../src/moveToApplications.ts";

const offer = { platform: "darwin" as const, packaged: true, smoke: false, inApplications: false, version: "0.1.0", record: {} };
const APP = "/Volumes/Caveman Code/Caveman Code.app";

describe("move to Applications", () => {
  it("asks a packaged Mac app outside Applications, once per version, never in development, the smoke test or elsewhere", () => {
    expect(shouldOfferMove(offer)).toBe(true);
    expect(shouldOfferMove({ ...offer, inApplications: true })).toBe(false);
    expect(shouldOfferMove({ ...offer, packaged: false })).toBe(false);
    expect(shouldOfferMove({ ...offer, smoke: true })).toBe(false);
    expect(shouldOfferMove({ ...offer, platform: "win32" })).toBe(false);
    // Not Now holds for that version; the next one asks again.
    expect(shouldOfferMove({ ...offer, record: { notNow: "0.1.0" } })).toBe(false);
    expect(shouldOfferMove({ ...offer, version: "0.1.1", record: { notNow: "0.1.0" } })).toBe(true);
  });

  it("asks in the words of the spec, Move and Reopen first", () => {
    expect(MOVE_QUESTION.message).toBe("Move Caveman Code to Applications?");
    expect(MOVE_QUESTION.detail).toBe("It's running from the installer, where it can't update itself. Moving it takes a second, then it reopens.");
    expect(MOVE_QUESTION.buttons).toEqual(["Move and Reopen", "Not Now"]);
    expect([MOVE_QUESTION.defaultId, MOVE_QUESTION.cancelId]).toEqual([0, 1]);
  });

  it("finds the bundle and the volume it runs from", () => {
    expect(bundleOf(`${APP}/Contents/MacOS/Caveman Code`)).toBe(APP);
    expect(volumeOf(APP)).toBe("/Volumes/Caveman Code");
    expect(volumeOf("/Volumes/Caveman Code 1/Caveman Code.app")).toBe("/Volumes/Caveman Code 1");
    expect(volumeOf("/Users/me/Downloads/Caveman Code.app")).toBeNull();
    expect(volumeOf("/Volumes")).toBeNull();
    expect(volumeOf("/Volumes/../Users/me/Caveman Code.app")).toBeNull();
  });

  it("ejects the installer it moved from, once in Applications, only while that volume is a disk image with Caveman Code on it", () => {
    const eject = { inApplications: true, record: { movedFrom: APP }, diskImageMounts: ["/Volumes/Caveman Code"], bundleIdOnVolume: "so.caveman.code", bundleId: "so.caveman.code" };
    expect(installerToEject(eject)).toBe("/Volumes/Caveman Code");
    // Still outside Applications (Not Now, or the move failed): the installer stays.
    expect(installerToEject({ ...eject, inApplications: false })).toBeNull();
    // Already ejected (Electron's own detach, or the person), or an external drive rather than a disk image.
    expect(installerToEject({ ...eject, diskImageMounts: [] })).toBeNull();
    // Another app's disk image mounted at the same name since.
    expect(installerToEject({ ...eject, bundleIdOnVolume: "com.example.other" })).toBeNull();
    expect(installerToEject({ ...eject, bundleIdOnVolume: null })).toBeNull();
    // Moved from Downloads: Electron trashed the original; nothing to eject.
    expect(installerToEject({ ...eject, record: { movedFrom: "/Users/me/Downloads/Caveman Code.app" } })).toBeNull();
    expect(installerToEject({ ...eject, record: {} })).toBeNull();
  });

  it("reads hdiutil's mount points and an Info.plist's strings", () => {
    const info = `<?xml version="1.0"?><plist version="1.0"><dict><key>images</key><array><dict>
      <key>image-path</key><string>/Users/me/Downloads/Caveman-Code-arm64.dmg</string>
      <key>system-entities</key><array>
        <dict><key>content-hint</key><string>GUID_partition_scheme</string><key>dev-entry</key><string>/dev/disk8</string></dict>
        <dict><key>content-hint</key><string>Apple_HFS</string><key>dev-entry</key><string>/dev/disk8s1</string>
          <key>mount-point</key><string>/Volumes/Caveman Code</string></dict>
      </array></dict><dict><key>mount-point</key>
      <string>/Volumes/R&amp;D</string></dict></array></dict></plist>`;
    expect(diskImageMounts(info)).toEqual(["/Volumes/Caveman Code", "/Volumes/R&D"]);
    expect(diskImageMounts("")).toEqual([]);
    const plist = "<dict><key>CFBundleIdentifier</key>\n\t<string>so.caveman.code</string><key>CFBundleShortVersionString</key><string>0.1.0-beta.1</string></dict>";
    expect(plistString(plist, "CFBundleIdentifier")).toBe("so.caveman.code");
    expect(plistString(plist, "CFBundleShortVersionString")).toBe("0.1.0-beta.1");
    expect(plistString(plist, "CFBundleName")).toBeNull();
  });

  it("replaces an older or equal copy in Applications, and stops for a running or newer one, saying why", () => {
    expect(conflictOf("exists", "0.1.0", "0.1.1")).toBe("replace");
    expect(conflictOf("exists", "0.1.1", "0.1.1")).toBe("replace");
    expect(conflictOf("exists", null, "0.1.1")).toBe("replace");
    expect(conflictOf("exists", "0.2.0", "0.1.1")).toBe("newer");
    expect(conflictOf("existsAndRunning", "0.1.0", "0.1.1")).toBe("running");
    expect(conflictMessage("replace", "0.1.0", "0.1.1")).toBeNull();
    expect(conflictMessage("running", "0.1.0", "0.1.1")?.message).toBe("Caveman Code is already open from Applications.");
    expect(conflictMessage("newer", "0.2.0", "0.1.1")?.detail).toBe("Applications has 0.2.0; this installer has 0.1.1. Open Caveman Code from Applications instead.");
  });

  it("orders versions as semver does", () => {
    const sorted = ["0.1.0-beta.1", "0.1.0-beta.2", "0.1.0-beta.10", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.10.0", "1.0.0"];
    for (let i = 1; i < sorted.length; i++) expect(compareVersions(sorted[i]!, sorted[i - 1]!)).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
    expect(compareVersions("0.1.0-1", "0.1.0-beta")).toBeLessThan(0);
    expect(compareVersions("junk", "0.1.0")).toBeLessThan(0);
  });

  it("keeps the record in a small JSON, and removes the file when it is empty", () => {
    const file = join(mkdtempSync(join(tmpdir(), "caveman-move-")), "move-to-applications.json");
    expect(readMoveRecord(file)).toEqual({});
    writeFileSync(file, "{");
    expect(readMoveRecord(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ movedFrom: 7, notNow: "0.1.0" }));
    expect(readMoveRecord(file)).toEqual({ notNow: "0.1.0" });
    writeMoveRecord(file, { movedFrom: APP, notNow: "0.1.0" });
    expect(readMoveRecord(file)).toEqual({ movedFrom: APP, notNow: "0.1.0" });
    writeMoveRecord(file, {});
    expect(existsSync(file)).toBe(false);
  });
});
