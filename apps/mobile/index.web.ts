// The web build waits for CanvasKit (Skia's WebAssembly build, copied into public/ by `pnpm web`) before the app
// draws, since the orb and the moments are Skia. Native platforms start from index.ts.
//
// Until the app draws, the page is already the app's own panel (#121213 in dark, white in light) with the flame
// still in its middle, so a launch never flashes white; and focus rings show only for the keyboard (:focus-visible),
// never after a tap or an Escape.
import { registerRootComponent } from "expo";
import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/module/web";

/** The app's flame, 8x8 cells, drawn flat in ink while the app loads. */
const FLAME = ["00011000", "00111100", "00111100", "01100110", "01100110", "11000011", "01100110", "00111100"];

function bootScreen() {
  if (typeof document === "undefined") return;
  const style = document.createElement("style");
  style.textContent = [
    "html,body{background:#121213;color:#e3e4e6}",
    "@media (prefers-color-scheme: light){html,body{background:#ffffff;color:#1f1f21}}",
    ":focus:not(:focus-visible){outline:none !important}",
    // Escape closing a sheet opened by a tap hands focus back by script, which the browser counts as keyboard focus:
    // a ring shows only once the keyboard is moving focus (Tab, arrows), never because a sheet was put away.
    'html[data-modality="pointer"] :focus{outline:none !important}',
    // Opaque, the panel's own colour: it covers the app's first frames until the screen has drawn, then crossfades.
    "#cc-boot{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;background:#121213;transition:opacity 120ms ease-out;z-index:2147483647}",
    "@media (prefers-color-scheme: light){#cc-boot{background:#ffffff}}",
  ].join("\n");
  document.head.appendChild(style);
  const root = document.documentElement;
  root.dataset.modality = "pointer";
  window.addEventListener("pointerdown", () => (root.dataset.modality = "pointer"), true);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) root.dataset.modality = "keyboard";
    },
    true,
  );
  const cells = FLAME.flatMap((row, y) => [...row].map((on, x) => (on === "1" ? `<rect x="${x}" y="${y}" width="0.875" height="0.875"/>` : ""))).join("");
  const boot = document.createElement("div");
  boot.id = "cc-boot";
  boot.setAttribute("aria-hidden", "true");
  boot.innerHTML = `<svg width="32" height="32" viewBox="0 0 8 8" fill="currentColor" shape-rendering="crispEdges">${cells}</svg>`;
  document.body.appendChild(boot);
}

bootScreen();

// The cover's way out (src/boot.ts bootReady): a 120 ms fade on the next frame, then gone.
(globalThis as { __ccReady?: () => void }).__ccReady = () => {
  const boot = typeof document === "undefined" ? null : document.getElementById("cc-boot");
  if (!boot || boot.dataset.going) return;
  boot.dataset.going = "1";
  requestAnimationFrame(() => {
    boot.style.opacity = "0";
    setTimeout(() => boot.remove(), 140);
  });
};

LoadSkiaWeb({ locateFile: (file) => `/${file}` }).then(async () => {
  const { default: App } = await import("./src/App");
  registerRootComponent(App);
  // The flame stays until the screen it opened on says it has drawn (src/boot.ts), then crossfades out over 120 ms; if
  // nothing says so in 2 s, it goes anyway.
  setTimeout(() => (globalThis as { __ccReady?: () => void }).__ccReady?.(), 2000);
});
