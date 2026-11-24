// Whether the notch shows (docs/): on until the person hides it, from its own right-click menu or
// Settings > General, kept on this device as the companion pick and the sidebar's switches are.
import { useSyncExternalStore } from "react";

const KEY = "caveman.notch";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const isOn = () => localStorage.getItem(KEY) !== "0";

export function setNotchOn(on: boolean): void {
  localStorage.setItem(KEY, on ? "1" : "0");
  listeners.forEach((l) => l());
}

export const useNotchOn = (): boolean => useSyncExternalStore(subscribe, isOn);

/** A desktop app that has a notch to show: a Mac's (apps/desktop src/preload.ts). */
export const hasNotch = (): boolean => window.cavemanDesktop?.notch !== undefined;
