// Bundles the main process and the sandboxed preload to CommonJS, as upstream
// apps/desktop/vite.config.ts pack step does (esbuild here, not vp pack).
// Also the runtime's compile-cache preload (src/serverCompileCache.ts), an ES
// module the runtime's own Node loads from <resources>/runtime, never from the
// app's asar.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const shared = {
  absWorkingDir: desktopDir,
  outdir: "dist-electron",
  bundle: true,
  platform: "node",
  target: "node24",
  banner: { js: "/*! Includes code from T3 Code (MIT), see THIRD_PARTY_NOTICES.md */" },
  logLevel: "warning",
};

await build({
  ...shared,
  // crash-reports: Sentry (src/crashReports.ts) in a file of its own, which main.ts requires only where crash reports
  // start, so the main bundle every launch parses does not carry it.
  entryPoints: { main: "src/main.ts", preload: "src/preload.ts", "capture-preload": "src/capture-preload.ts", "computer-guide-preload": "src/computer-guide-preload.ts", "notch-preload": "src/notch-preload.ts", "crash-reports": "src/crashReports.ts" },
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
  // Caveman's crash service (src/crashReports.ts): the release workflows set it; a build without it reports nothing.
  define: { __CAVEMAN_CRASH_DSN__: JSON.stringify(process.env.CAVEMAN_CRASH_DSN?.trim() ?? "") },
});
await build({
  ...shared,
  entryPoints: { serverCompileCache: "src/serverCompileCache.ts" },
  outExtension: { ".js": ".mjs" },
  format: "esm",
});
console.log("built apps/desktop/dist-electron/{main,preload,capture-preload,computer-guide-preload,notch-preload,crash-reports}.cjs and serverCompileCache.mjs");
