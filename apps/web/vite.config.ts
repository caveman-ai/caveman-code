import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// base "./" so the desktop shell can serve the built client from disk.
export default defineConfig({
  base: "./",
 // The React Compiler, natively (oxc), 
  // themselves, so a streamed token or a pushed workspace re-renders only what reads it.
  plugins: [react({ compiler: true })],
  // The build's version, which runtime.hello sends as client_version (state/runtime.tsx): the release's, as the runtime's.
  define: { "import.meta.env.VITE_CAVEMAN_VERSION": JSON.stringify(process.env.CAVEMAN_APP_VERSION?.trim().replace(/^v/, "") ?? "") },
  server: { port: 5733, strictPort: false },
  build: {
    // Source maps only for a desktop release's crash reports: apps/desktop/scripts/package.mjs uploads them to Sentry
    // and deletes them, so a shipped client never carries them.
    sourcemap: process.env.CAVEMAN_SOURCEMAPS === "1" ? "hidden" : false,
    // Above 500 kB sit only two files Shiki loads on demand: its C++ grammar
    // (~790 kB) and the oniguruma wasm (~620 kB). Every chunk of ours is far below.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      // Two pages: the app, and the desktop's notch (apps/desktop src/notch.ts), a clear window that loads no app shell.
      input: { index: "index.html", notch: "notch.html" },
      output: {
        // Libraries every screen needs, in chunks of their own: the app's code
        // changes far more often than they do.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/ },
            { name: "effect", test: /node_modules[\\/]effect[\\/]/ },
          ],
        },
      },
    },
  },
  // `*.browser.test.*` run in Chromium (vitest.browser.config.ts, `pnpm test:browser`), never here.
  test: { environment: "node", include: ["src/**/*.test.ts"], exclude: ["src/**/*.browser.test.*"] },
});
