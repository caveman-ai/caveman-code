// .ts at 67eebaca23 (the pointer reset); the page setup is ours.
import { beforeEach } from "vitest";
import { commands } from "vitest/browser";
import { forgetPlaces } from "../src/components/transcript/place.ts";

declare module "vitest/browser" {
  interface BrowserCommands {
    /** Screenshot the app frame to a temporary folder outside the checkout. */
    saveProof: (name: string) => Promise<string>;
    /** Defined in vitest.browser.config.ts: moves Playwright's mouse off the page. */
    resetPointer: () => Promise<void>;
    /** Defined there too: moves Playwright's mouse to a place in the test's page, in `steps` moves (4: as a hand would). */
    pointerTo: (x: number, y: number, steps?: number) => Promise<void>;
    /** Presses and lets go where the mouse is, without moving it. */
    press: () => Promise<void>;
    holdPointer: () => Promise<void>;
    releasePointer: () => Promise<void>;
  }
}

// As index.html serves the app.
document.documentElement.lang = "en";
document.documentElement.dataset.surface = "deck";
// The window's tabs (panes/store.ts) read the hash they launched on as their module loads: a window opened on a route
// stays on it, rather than coming back on the last tab (mountApp sets the route each test opens on).
window.location.hash = "#/new";

// Before each test, not after: a timed-out test keeps running and can move the mouse after its own afterEach.
// A test's chats start at their end: a place an earlier test left behind (its reading place is saved 150 ms after its
// scrolling settles, which a loaded machine reaches before that test ends) would reopen the same chat id there.
beforeEach(async () => {
  await commands.resetPointer();
  forgetPlaces();
});
