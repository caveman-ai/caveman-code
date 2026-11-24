// The launch's own cover: the web build's flame on the app's panel (index.web.ts), and on a phone the splash. It stays
// over the app until the screen it opened on has drawn what it opens to (a chat's latest turn landed in its list,
// Home or a page laid out), then crossfades out over 120 ms, so a launch never shows an empty frame between the flame
// and the chat. Said once; anything after the first call is ignored.
let done = false;

/** The screen the launch opened on has drawn: the cover goes. */
export function bootReady() {
  if (done) return;
  done = true;
  (globalThis as { __ccReady?: () => void }).__ccReady?.();
}
