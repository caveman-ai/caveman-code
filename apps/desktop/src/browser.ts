// The side panel's browser on the desktop is an Electron <webview>: a page of
// its own, not a frame, so sites that refuse framing (X-Frame-Options,
// frame-ancestors) still open. Electron-free, so main and preload share it
// and it tests without Electron. The wiring is in main.ts.

/** Every guest lives here: its cookies and storage stay apart from the app's. */
export const BROWSER_PARTITION = "persist:caveman-browser";

/**
 * What a guest page may have: copying (a site's Copy button), full screen inside its panel (a video's), pointer lock (a
 * game's or a 3D view's; Esc gives the pointer back) and loopback access. Loopback requests already succeed in Electron
 * 44, but sign-in widgets that ask `navigator.permissions` first read "denied" and give up; the runtime on loopback
 * still wants its bearer token. ).
 */
export const GUEST_PERMISSIONS: ReadonlySet<string> = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock", "loopback-network"]);

/** The only addresses a guest attaches on, or navigates to. */
export const isGuestUrl = (url: string): boolean => /^https?:\/\//i.test(url) || url === "about:blank";

/** A <webview> may attach only in the browser's partition, on a web address. */
export const mayAttach = (params: { partition?: string; src?: string }): boolean =>
  params.partition === BROWSER_PARTITION && isGuestUrl(params.src ?? "");

/**
 * What a guest's window.open does (upstream previewWindowOpenAction, preview/Manager.ts, MIT, 13aa882c22). A
 * scripted popup ("new-window": window.open with features, as OAuth SDKs open sign-in) gets a real window, hardened
 * and in this partition: denying it makes window.open() return null, which SDKs report as a blocked popup, and
 * loading it in the tab instead destroys the opener the popup posts its result back to. A link with target=_blank
 * loads in the tab. A blank popup and anything off the web are refused.
 */
export function guestWindowOpenAction(details: { readonly url: string; readonly disposition: string }): "popup" | "navigate" | "deny" {
  if (details.url === "" || details.url === "about:blank" || !isGuestUrl(details.url)) return "deny";
  return details.disposition === "new-window" ? "popup" : "navigate";
}

/** A popup's window: sandboxed and isolated, with no preload and no <webview> of its own. */
export const POPUP_WINDOW_OPTIONS = {
  width: 520,
  height: 680,
  autoHideMenuBar: true,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
} as const;
