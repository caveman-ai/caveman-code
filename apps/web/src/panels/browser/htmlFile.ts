// HTML files are documents, not URLs for the client's filesystem. Read them
// from the workspace computer and render without the app's origin or tokens.
export const isHtmlFile = (path: string): boolean => /\.html?$/i.test(path);

/** Keep relative URLs from resolving against the app, and block API calls.
 * Inline interaction, embedded images, and public HTTPS libraries still work.
 * The iframe also MUST omit allow-same-origin (CSP meta cannot sandbox). */
export const HTML_FILE_SANDBOX = "allow-scripts allow-downloads";
export function htmlFileDocument(html: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  // Sandboxed blob documents have an opaque origin: some browsers refuse
  // native fragment navigation to their blob URL. Scroll locally instead,
  // without giving the document the app's origin or navigating its frame.
  const anchors = `<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href^="#"]');if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var h=a.getAttribute('href');if(h==='#'){e.preventDefault();window.scrollTo(0,0);return}try{var id=decodeURIComponent(h.slice(1)),t=document.getElementById(id)||document.getElementsByName(id)[0];if(t){e.preventDefault();t.scrollIntoView()}}catch{}});</script>`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${anchors}${html}`;
}

export type HtmlRead = { readonly status: "loading" } | { readonly status: "ready"; readonly html: string } | { readonly status: "error"; readonly message: string };
/** `fresh`: the first read, Reload, Retry, the file opened again. `again`: an agent edit or a reconnect. */
export type HtmlReadEvent = { readonly read: "fresh" | "again" } | { readonly html: string } | { readonly error: string };

const LOADING: HtmlRead = { status: "loading" };

/**
 * The preview's state as a read starts and answers. A read `again` keeps what is shown while it reads, and the same
 * bytes keep the very state, so the page (its scroll, inputs and script state) is not rebuilt.
 */
export function htmlRead(state: HtmlRead, event: HtmlReadEvent): HtmlRead {
  if ("read" in event) return event.read === "fresh" ? LOADING : state;
  if ("html" in event) return state.status === "ready" && state.html === event.html ? state : { status: "ready", html: event.html };
  return { status: "error", message: event.error };
}
