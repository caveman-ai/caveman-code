import { Icon, PanelLeftCloseIcon, PanelLeftOpenIcon, type IconSvgElement } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { usePhone } from "../lib/screen.ts";
import { ariaChord, formatChord } from "../panels/chrome.tsx";
import { chord, useKeybindings } from "../state/keybindings.ts";
import { useNeedsYou } from "../state/notifications.ts";
import { setSidebarDrawer, toggleSidebar } from "../state/sidebar-layout.ts";

/**
 * ⌘B and the sidebar's own button: tucks the sidebar away or brings it back. Focus that was in the sidebar or on
 * the toggle (each unmounts) moves to the button that undoes it, so the keyboard never lands on the page.
 */
export function toggleSidebarKeepingFocus(): void {
  const active = document.activeElement;
  const inside = active !== null && active !== document.body && active.closest("[data-sidebar], [data-sidebar-toggle]") !== null;
  toggleSidebar();
  if (inside) requestAnimationFrame(focusSidebarToggle);
}

/** Focuses the toggle on screen, never the one in the tucked-away sidebar, which waits off the screen and inert. */
export function focusSidebarToggle(): void {
  [...document.querySelectorAll<HTMLElement>("[data-sidebar-toggle]")].find((el) => el.closest("[inert]") === null)?.focus();
}

/**
 * The title band's 28px icon buttons, the sidebar's toggle and Back and Forward beside it (HistoryNav.tsx): a still fill
 * on hover, and a click presses the button in (75 ms) and lets it settle back (150 ms on ease-snap).
 */
export const TITLE_BUTTON = cn(
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none",
  "[transition:color_75ms,background-color_75ms,transform_150ms_var(--ease-snap)] active:[transition-duration:75ms]",
  "enabled:hover:bg-sidebar-accent/60 enabled:hover:text-sidebar-accent-foreground enabled:active:scale-[0.9]",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
);

/**
 * The button that tucks the sidebar away or brings it back, named with the bound key. It sits at the start of the
 * title band, so it never moves: in the sidebar's own band while it shows (Sidebar.tsx); tucked away, the sidebar is
 * gone and it heads the tab strip (TabStrip.tsx), or in a browser the band above the panel (AppShell.tsx). The
 * sidebar sliding out for a look (SidebarFlyout) heads with "Show sidebar", which keeps it.
 */
export function SidebarToggle({ hidden, className }: { hidden: boolean; className?: string }) {
  const keys = useKeybindings();
  const toggle = keys["app.toggleSidebar"] ?? chord("app.toggleSidebar");
  const label = hidden ? "Show sidebar" : "Hide sidebar";
  return (
    <button
      type="button"
      data-sidebar-toggle
      aria-label={label}
      aria-keyshortcuts={ariaChord(toggle)}
      title={`${label} (${formatChord(toggle)})`}
      onClick={toggleSidebarKeepingFocus}
      className={cn(
        "px-nav px-play-hover max-md:size-9",
        TITLE_BUTTON,
        "[--px-accent:currentColor] hover:[--px-accent:initial] focus-visible:[--px-accent:initial]",
        className,
      )}
    >
      <Icon icon={hidden ? PanelLeftOpenIcon : PanelLeftCloseIcon} className="size-4" />
    </button>
  );
}

/** The phone app's menu mark (apps/mobile Icon `menu`): two lines, the lower one shorter. */
const MENU: IconSvgElement = [["path", { d: "M4 9h16M4 15h10", stroke: "currentColor", strokeLinecap: "round", key: "0" }]];

/**
 * On a phone, the first thing in a page's header: opens the sidebar's drawer. An amber dot says a chat needs you, from
 * any screen, as on the phone app's menu button. Nothing on a wider screen, where the sidebar or its toggle shows.
 */
export function SidebarMenuButton({ className }: { className?: string }) {
  return usePhone() ? <MenuButton className={className} /> : null;
}

function MenuButton({ className }: { className?: string | undefined }) {
  const needsYou = useNeedsYou();
  return (
    <button
      type="button"
      data-tour="menu"
      aria-label={needsYou > 0 ? `Open the sidebar, ${needsYou} need${needsYou === 1 ? "s" : ""} you` : "Open the sidebar"}
      onClick={() => setSidebarDrawer(true)}
      className={cn(
        "relative -ml-2 grid size-10 shrink-0 place-items-center rounded-lg text-foreground outline-none transition-[background-color,transform] duration-75 ease-snap",
        "active:scale-[0.94] active:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
    >
      <Icon icon={MENU} className="size-[22px]" />
      {needsYou > 0 ? <span aria-hidden className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-warning ring-2 ring-background" /> : null}
    </button>
  );
}
