import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, nativeImage: {}, screen: {}, shell: {}, systemPreferences: {} }));
const { accessibilityName, appBundle, stepOf } = await import("../src/computerGuide.ts");

describe("the computer use guide", () => {
  const none = { accessibility: false, screen_recording: false };
  it("walks the missing permissions in order and is done when macOS reports them", () => {
    const both = ["accessibility", "screen_recording"] as const;
    expect(stepOf(both, none, new Set())).toBe("accessibility");
    expect(stepOf(both, { accessibility: true, screen_recording: false }, new Set())).toBe("screen_recording");
    expect(stepOf(both, { accessibility: true, screen_recording: true }, new Set())).toBe("done");
  });

  it("Screen Recording the person added but macOS still reports off waits on a reopen; Accessibility never does", () => {
    const both = ["accessibility", "screen_recording"] as const;
    expect(stepOf(both, { accessibility: true, screen_recording: false }, new Set(["screen_recording"]))).toBe("reopen");
    expect(stepOf(both, none, new Set(["accessibility"]))).toBe("accessibility");
  });

  it("names the list as macOS does, and drags the app bundle", () => {
    expect(accessibilityName("26.4.0")).toBe("Accessibility");
    expect(accessibilityName("27.0.0")).toBe("Device Control and Data Access");
    expect(appBundle("/Applications/Caveman Code.app/Contents/MacOS/Caveman Code")).toBe("/Applications/Caveman Code.app");
    expect(appBundle("/usr/local/bin/node")).toBeUndefined();
  });
});
