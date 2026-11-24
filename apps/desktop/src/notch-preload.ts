// The notch's preload (src/notch.ts): hear what it shows, say what the person did on it, and tell main where the
// pointer is so the rest of its window lets clicks through. No runtime endpoint or token reaches this page.
import { contextBridge, ipcRenderer } from "electron";
import {
  NOTCH_ACT_CHANNEL,
  NOTCH_AWAY_CHANNEL,
  NOTCH_MENU_CHANNEL,
  NOTCH_OVER_CHANNEL,
  NOTCH_READY_CHANNEL,
  NOTCH_STATE_CHANNEL,
} from "./ipc.ts";

contextBridge.exposeInMainWorld("cavemanNotch", {
  /** What the notch shows, now and at every change. */
  onState: (handler: (state: unknown) => void) => {
    ipcRenderer.on(NOTCH_STATE_CHANNEL, (_event, state: unknown) => handler(state));
    ipcRenderer.send(NOTCH_READY_CHANNEL);
  },
  /** The pointer left the window in one move (no event said so): main noticed. */
  onAway: (handler: () => void) => {
    ipcRenderer.on(NOTCH_AWAY_CHANNEL, () => handler());
  },
  act: (action: unknown) => ipcRenderer.send(NOTCH_ACT_CHANNEL, action),
  over: (on: boolean) => ipcRenderer.send(NOTCH_OVER_CHANNEL, on === true),
  menu: () => ipcRenderer.send(NOTCH_MENU_CHANNEL),
});
