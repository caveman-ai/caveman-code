// The capture window's preload (src/capture.ts): send a note, close, and hear
// when the window was shown. No runtime endpoint or token reaches this page.
import { contextBridge, ipcRenderer } from "electron";
import { CAPTURE_CLOSE_CHANNEL, CAPTURE_SHOWN_CHANNEL, CAPTURE_SUBMIT_CHANNEL } from "./ipc.ts";

contextBridge.exposeInMainWorld("cavemanCapture", {
  /** Resolves to {} once the note is on the Queue, or {error}. */
  send: (text: string, mode: "decide" | "queue") => ipcRenderer.invoke(CAPTURE_SUBMIT_CHANNEL, String(text), mode === "queue" ? "queue" : "decide") as Promise<{ error?: string }>,
  close: () => ipcRenderer.send(CAPTURE_CLOSE_CHANNEL),
  onShown: (handler: () => void) => {
    ipcRenderer.on(CAPTURE_SHOWN_CHANNEL, () => handler());
  },
});
