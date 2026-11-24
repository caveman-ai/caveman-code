// A phone-sized window: narrower than Tailwind's `md` (768px), the width CSS
// targets with `max-md:`. There the sidebar is a drawer over the page, a page
// shows one column at a time, and a call takes the whole screen. The desktop
// app's windows are never this narrow (apps/desktop windowState MIN_SIZE).

import { useSyncExternalStore } from "react";

export const PHONE_QUERY = "(max-width: 767px)";

export const isPhone = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

function subscribe(listener: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia(PHONE_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}
