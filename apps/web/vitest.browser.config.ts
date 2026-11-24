// The browser suite (`pnpm test:browser`): `*.browser.test.*` in Playwright's Chromium, through Vitest's browser
// mode, . Apart from `vitest run` (vite.config.ts), so the unit suite stays as fast.
// The app's own Vite config (the React Compiler, PostCSS and Tailwind) builds what the tests render.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import app from "./vite.config.ts";

export default defineConfig({
  ...app,
  // The desktop serves the build from disk ("./"); the test server serves from its root.
  base: "/",
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.{ts,tsx}"],
    setupFiles: ["./test/browser-setup.ts"],
    // One file at a time: every file's iframe shares the test server's origin, so its localStorage and IndexedDB, and
    // mountApp clears both when a test starts and ends. Files run side by side wiped each other's runtime link and
    // Smart View memory mid-mount (a Chief's side panel opened on a chat it could not find).
    fileParallelism: false,
    // Each test mounts the whole app; a loaded CI machine needs more than the 5 s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // `expect.poll` (scroll offsets and the like) asks for this long; `expect.element` waits until the test's own deadline.
    expect: { poll: { timeout: 8_000 } },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      // A laptop window: the sidebar, the chat and the composer lay out as people see them.
      viewport: { width: 1400, height: 900 },
      screenshotFailures: false,
      commands: {
        // Proof screenshots stay outside the checkout, including when the app runs in Vitest's iframe.
        saveProof: async ({ frame }, name: string) => {
          const folder = join(tmpdir(), "caveman-browser-proof");
          await mkdir(folder, { recursive: true });
          const path = join(folder, `${name.replace(/[^a-z0-9-]/gi, "-")}.png`);
          await (await frame()).locator("body").screenshot({ path });
          return path;
        },
        // Playwright's mouse outlives each test, so whatever mounts under its last position starts hovered.
 // test/browser-setup.ts parks it off the page before each test (upstream resetPointer).
        resetPointer: async ({ page }) => {
          await page.mouse.move(-1, -1);
        },
        // A pointer that goes to a place in the test's own page and presses where it is, with nothing aimed at or
        // waited for: whatever is under it takes the press, as it would a person's (src/notch/Notch.browser.test.tsx).
        // `steps`: the moves it takes to get there (a hand makes many; one is a pointer that turns up somewhere).
        pointerTo: async ({ page, frame }, x: number, y: number, steps = 4) => {
          const box = await (await (await frame()).frameElement()).boundingBox();
          await page.mouse.move((box?.x ?? 0) + x, (box?.y ?? 0) + y, { steps });
        },
        holdPointer: async ({ page }) => {
          await page.mouse.down();
        },
        releasePointer: async ({ page }) => {
          await page.mouse.up();
        },
        press: async ({ page }) => {
          await page.mouse.down();
          await page.mouse.up();
        },
      },
    },
  },
});
