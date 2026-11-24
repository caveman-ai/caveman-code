import { useSyncExternalStore } from "react";

/** The app's theme, from `html.dark`, live. Dark on the server and in tests without a document. */
export function useDark(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mo = new MutationObserver(notify);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      return () => mo.disconnect();
    },
    () => document.documentElement.classList.contains("dark"),
    () => true,
  );
}
