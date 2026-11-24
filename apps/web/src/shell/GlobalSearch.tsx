// Search and go to (⌘K, or the sidebar's Search, or the composer's /resume) on every screen: the shell
// and Settings alike. It used to live in the sidebar, so in Settings ⌘K did nothing.
import { useEffect, useRef, useState } from "react";
import { matchesChord } from "../panels/chrome.tsx";
import { chord, COMMAND_EVENT } from "../state/keybindings.ts";
import { GoTo } from "./GoTo.tsx";

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  // What had focus as search opened, and on which page: closing gives focus back to it. Radix gives it to the
  // dialog's trigger, and a shortcut is none, so it fell to the page and the keyboard started over from the top.
  const opener = useRef<{ readonly element: HTMLElement | null; readonly href: string } | null>(null);
  useEffect(() => {
    const show = () => {
      opener.current = { element: document.activeElement instanceof HTMLElement ? document.activeElement : null, href: window.location.href };
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (matchesChord(e, chord("app.search"))) {
        e.preventDefault();
        if (open) setOpen(false);
        else show();
      }
    };
    const onCommand = (e: Event) => (e as CustomEvent<string>).detail === "app.search" && !open && show();
    window.addEventListener("keydown", onKey);
    window.addEventListener(COMMAND_EVENT, onCommand);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(COMMAND_EVENT, onCommand);
    };
  }, [open]);
  // A row that went to another page, or opened something that took focus, leaves it there.
  const giveFocusBack = (e: Event) => {
    e.preventDefault();
    const from = opener.current;
    opener.current = null;
    const free = !document.activeElement || document.activeElement === document.body;
    if (free && from?.element?.isConnected && from.href === window.location.href) from.element.focus();
  };
  return <GoTo open={open} onOpenChange={setOpen} onCloseAutoFocus={giveFocusBack} />;
}
