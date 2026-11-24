import { expect, test } from "vitest";
import { computerNoun, osOf, revealLabelFor } from "./platform.ts";

test("reads the OS from Chromium's client hints, navigator.platform or the user agent", () => {
  expect(osOf({ platform: "MacIntel" })).toBe("mac");
  expect(osOf({ platform: "iPad" })).toBe("mac");
  expect(osOf({ userAgentData: { platform: "macOS" }, platform: "" })).toBe("mac");
  expect(osOf({ userAgentData: { platform: "Windows" }, platform: "Win32" })).toBe("windows");
  expect(osOf({ platform: "Win32" })).toBe("windows");
  // A browser that reports nothing in navigator.platform still names Windows in its user agent.
  expect(osOf({ platform: "", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" })).toBe("windows");
  expect(osOf({ userAgentData: { platform: "Linux" }, platform: "Linux x86_64" })).toBe("linux");
  expect(osOf({ platform: "" })).toBe("other");
  expect(osOf(undefined)).toBe("other");
});

test("names the computer and its file manager as the OS does", () => {
  expect([computerNoun("mac"), computerNoun("windows"), computerNoun("linux")]).toEqual(["Mac", "PC", "computer"]);
  expect([revealLabelFor("mac"), revealLabelFor("windows"), revealLabelFor("linux")]).toEqual(["Reveal in Finder", "Show in File Explorer", "Show in file manager"]);
});
