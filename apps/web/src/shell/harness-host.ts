// The harness pages (new-chat.browser.tsx, web-window.browser.tsx) assert "Download for Mac", which a browser shows
// only on a Mac (state/sync/web-window.ts canGetMacHere). So they run as a Mac whatever computer opens them; add
// ?host=real to use this computer's own answer instead. Import this first: modules read the platform as they load.
/** Whether this page stands in for a Mac (the default). */
export const AS_MAC =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("host") !== "real";
if (AS_MAC) {
  const as: Record<string, unknown> = {
    platform: "MacIntel",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    userAgentData: { platform: "macOS" },
    maxTouchPoints: 0,
  };
  for (const [key, value] of Object.entries(as))
    Object.defineProperty(navigator, key, { get: () => value, configurable: true });
}
