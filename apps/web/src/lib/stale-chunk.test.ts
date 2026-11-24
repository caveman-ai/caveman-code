import { expect, test } from "vitest";
import { isStaleChunk } from "./stale-chunk.ts";

test("a chunk the browser can no longer fetch is told apart from a surface's own error", () => {
  // Chrome, Safari, Firefox, and Vite's CSS preload.
  expect(isStaleChunk(new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1:47251/assets/TerminalSurface-D7JoNa94.js"))).toBe(true);
  expect(isStaleChunk(new TypeError("Importing a module script failed."))).toBe(true);
  expect(isStaleChunk(new TypeError("error loading dynamically imported module: app://assets/Files-1.js"))).toBe(true);
  expect(isStaleChunk(new Error("Unable to preload CSS for /assets/TerminalSurface-9RQJ1adl.css"))).toBe(true);
  expect(isStaleChunk(new Error("Cannot read properties of undefined (reading 'path')"))).toBe(false);
  expect(isStaleChunk("params do not match fs.read")).toBe(false);
});
