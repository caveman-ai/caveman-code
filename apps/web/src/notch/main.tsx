// The notch's page (notch.html): the desktop's clear window on the screen's top edge (apps/desktop src/notch.ts). It
// draws what the shell hands it through its preload and nothing else: no runtime, no router, no app shell. Opened in a
// browser it has no shell, and shows fixture states over a stand-in desktop (demo.ts).
import { createRoot } from "react-dom/client";
import "../styles.css";
import "./notch.css";
import { Notch, type NotchBridge } from "./Notch.tsx";

declare global {
  interface Window {
    /** The notch's preload bridge (apps/desktop src/notch-preload.ts). */
    cavemanNotch?: NotchBridge;
  }
}

const mount = (bridge: NotchBridge, forceOpen = false) =>
  createRoot(document.getElementById("root")!).render(
    <Notch bridge={bridge} forceOpen={forceOpen} />,
  );

if (window.cavemanNotch) mount(window.cavemanNotch);
else
  void import("./demo.ts").then(({ demo }) => mount(...demo(new URLSearchParams(location.search))));
