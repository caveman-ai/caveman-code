// Back and Forward in the desktop app's title band, beside the sidebar's toggle: the tab in front's own history
// (panes/store.ts windowTabs.go), as a browser tab's. ⌘[ and ⌘] (Settings > Keyboard) and a mouse's side buttons do
// the same from anywhere in the window but where something has a Back of its own (useHistoryKeys). A browser window
// has its own buttons, so nothing here shows there.
import { Icon, ArrowLeft02Icon, ArrowRight02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { duration, ease } from "@caveman-app/ui/motion";
import { useEffect, useEffectEvent } from "react";
import { useNavigate } from "react-router";
import {
  ariaChord,
  formatChord,
  IS_DESKTOP,
  isComposing,
  matchesChord,
} from "../panels/chrome.tsx";
import { thumbButton } from "../panels/live/source.ts";
import { useCanGo, windowTabs } from "../panes/store.ts";
import { chord, useKeybindings } from "../state/keybindings.ts";
import { TITLE_BUTTON } from "./SidebarToggle.tsx";
import { useTabNav } from "./tab-nav.ts";

const WAYS = {
  back: {
    by: -1,
    command: "app.back",
    label: "Back",
    icon: ArrowLeft02Icon,
    nudge: "group-hover/step:-translate-x-0.5",
  },
  forward: {
    by: 1,
    command: "app.forward",
    label: "Forward",
    icon: ArrowRight02Icon,
    nudge: "group-hover/step:translate-x-0.5",
  },
} as const;
type Way = keyof typeof WAYS;

/** Back and Forward, after the sidebar's toggle (Sidebar.tsx, TabStrip.tsx), so they keep one place as it does. */
export function HistoryNav({ className }: { className?: string }) {
  if (!IS_DESKTOP) return null;
  return (
    <div className={cn("flex shrink-0 items-center", className)}>
      <StepButton way="back" />
      <StepButton way="forward" />
    </div>
  );
}

/** The toggle's button. Its arrow leans 2px the way it goes on hover; with nowhere to go it dims and stays still. */
function StepButton({ way }: { way: Way }) {
  const { by, command, label, icon, nudge } = WAYS[way];
  const go = useTabNav();
  const can = useCanGo(by);
  const keys = useKeybindings()[command] ?? chord(command);
  return (
    <button
      type="button"
      data-history={way}
      disabled={!can}
      aria-label={label}
      aria-keyshortcuts={ariaChord(keys)}
      title={`${label} (${formatChord(keys)})`}
      onClick={() => go(windowTabs.go(by))}
      className={cn("group/step", TITLE_BUTTON, "disabled:text-muted-foreground/35")}
    >
      <Icon
        icon={icon}
        className={cn("size-4 transition-transform duration-150 ease-snap", can && nudge)}
      />
    </button>
  );
}

/**
 * The button on screen for `way` plays the press a click gives it, so a key or a side button lands as visibly. Never
 * the one in a tucked-away sidebar, which waits off the screen and inert.
 */
function press(way: Way): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const button = [...document.querySelectorAll<HTMLElement>(`[data-history="${way}"]`)].find(
    (el) => el.closest("[inert]") === null && el.checkVisibility(),
  );
  if (!button) return;
  const timing = { duration: duration.fast, easing: ease.snap };
  button.animate([{ transform: "scale(0.9)" }, { transform: "none" }], timing);
  button.firstElementChild?.animate(
    [{ transform: `translateX(${WAYS[way].by * 3}px)` }, { transform: "none" }],
    timing,
  );
}

/**
 * ⌘[ and ⌘] from anywhere in the window, a text field included, and a mouse's back and forward buttons. Where focus
 * has a Back of its own, that one goes first: the side panel's browser steps its page (BrowserSurface takes the keys
 * before they reach the window), the agent's live browser takes the mouse's buttons (LiveView), and a terminal keeps
 * its keys (Ctrl+[ is Escape there). Settings shows over the tab,
 * never as a step in it: Back leaves it for the tab's page, as Back to app does.
 */
export function useHistoryKeys(onSettings: boolean): void {
  const go = useTabNav();
  const navigate = useNavigate();
  const step = useEffectEvent((way: Way) => {
    if (onSettings) return void (way === "back" && navigate(windowTabs.frontPath()));
    const path = windowTabs.go(WAYS[way].by);
    if (path === null) return;
    go(path);
    press(way);
  });
  useEffect(() => {
    if (!IS_DESKTOP) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.repeat ||
        isComposing(e) ||
        (e.target instanceof Element && e.target.closest(".xterm"))
      )
        return;
      const way = matchesChord(e, chord("app.back"))
        ? "back"
        : matchesChord(e, chord("app.forward"))
          ? "forward"
          : null;
      if (!way) return;
      e.preventDefault();
      step(way);
    };
    // Cancelling Chromium's own back or forward on these buttons, which would walk the window's history instead.
    const onMouse = (e: MouseEvent) => {
      const way = thumbButton(e.button);
      if (e.defaultPrevented || !way) return;
      e.preventDefault();
      step(way);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, []);
}
