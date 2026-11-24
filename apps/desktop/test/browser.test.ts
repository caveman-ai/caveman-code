import { describe, expect, it } from "vitest";
import { BROWSER_PARTITION, GUEST_PERMISSIONS, guestWindowOpenAction, isGuestUrl, mayAttach, POPUP_WINDOW_OPTIONS } from "../src/browser.ts";

describe("side panel browser guests", () => {
  it("attach only in the browser's partition, on a web address", () => {
    expect(mayAttach({ partition: BROWSER_PARTITION, src: "https://github.com/" })).toBe(true);
    expect(mayAttach({ partition: BROWSER_PARTITION, src: "http://localhost:5173/" })).toBe(true);
    expect(mayAttach({ partition: BROWSER_PARTITION, src: "about:blank" })).toBe(true);
    expect(mayAttach({ src: "https://github.com/" })).toBe(false);
    expect(mayAttach({ partition: "persist:other", src: "https://github.com/" })).toBe(false);
    expect(mayAttach({ partition: BROWSER_PARTITION })).toBe(false);
    for (const src of ["file:///etc/passwd", "caveman-code://app/", "javascript:alert(1)", "data:text/html,x"]) {
      expect(mayAttach({ partition: BROWSER_PARTITION, src })).toBe(false);
    }
  });
  it("never navigate off the web", () => {
    expect(isGuestUrl("https://example.com/a")).toBe(true);
    expect(isGuestUrl("file:///Users")).toBe(false);
    expect(isGuestUrl("caveman-code://app/settings")).toBe(false);
  });
  it("give a scripted popup (OAuth sign-in) a real, hardened window; links load in the tab", () => {
    expect(guestWindowOpenAction({ url: "https://accounts.example.com/authorize", disposition: "new-window" })).toBe("popup");
    expect(guestWindowOpenAction({ url: "http://localhost:3000/a", disposition: "foreground-tab" })).toBe("navigate");
    expect(guestWindowOpenAction({ url: "http://localhost:3000/a", disposition: "background-tab" })).toBe("navigate");
    for (const url of ["", "about:blank", "caveman-code://app/", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(guestWindowOpenAction({ url, disposition: "new-window" })).toBe("deny");
    }
    expect(POPUP_WINDOW_OPTIONS.webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });
    expect("preload" in POPUP_WINDOW_OPTIONS.webPreferences).toBe(false);
  });
  it("let a page copy, go full screen in its panel, lock the pointer and reach loopback, and nothing else", () => {
    expect([...GUEST_PERMISSIONS].sort()).toEqual(["clipboard-sanitized-write", "fullscreen", "loopback-network", "pointerLock"]);
    for (const p of ["notifications", "media", "geolocation", "openExternal", "clipboard-read", "clipboard-write", "local-network", "local-network-access", "keyboardLock"]) {
      expect(GUEST_PERMISSIONS.has(p)).toBe(false);
    }
  });
});
