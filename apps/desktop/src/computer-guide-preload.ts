// The computer use guide panel's preload (src/computerGuide.ts): the step to draw, the person's choices, and the
// tile's drag. No runtime endpoint or token reaches this page.
import { contextBridge, ipcRenderer } from "electron";
import { COMPUTER_GUIDE_ACTION_CHANNEL, COMPUTER_GUIDE_DRAG_CHANNEL, COMPUTER_GUIDE_STATE_CHANNEL } from "./ipc.ts";

contextBridge.exposeInMainWorld("cavemanGuide", {
  onState: (handler: (state: unknown) => void) => {
    ipcRenderer.on(COMPUTER_GUIDE_STATE_CHANNEL, (_event, state: unknown) => handler(state));
  },
  action: (action: "added" | "close" | "reopen" | "settings") => ipcRenderer.send(COMPUTER_GUIDE_ACTION_CHANNEL, String(action)),
  drag: () => ipcRenderer.send(COMPUTER_GUIDE_DRAG_CHANNEL),
});
