import * as React from "react";
import { cn } from "../lib/cn";
import { menuItemMotion } from "./motion";

/* ---------------------------------------------------------------------- */
/*  Menus — one vocabulary for every list that drops down                  */
/* ---------------------------------------------------------------------- */

/* Every list that drops down (STYLE.md 5): a 12px-radius glass popover (globals.css `.glass`), 6px of
   padding so the 6px-radius rows sit concentric inside it, 32px rows of
   [16px icon] label in white, description in grey, grey section headers, and
   a fade at the scroll edge. The active row is ink at low alpha, so it stays
   glass.
   dropdown-menu.tsx, select.tsx and popover.tsx build on these; the launcher
   and the pickers use them directly. ⌘K (shell/GoTo.tsx) and the composer's
   "+", "@" and "/" menu (ComposerAddMenu.tsx) take Arc's command bar
   instead (2026-11-09): taller rows, a mark on a tile that lifts on the
   selected row, and what Enter does at its right. */
export const menuSurface = "dashboard-scope glass z-50 overflow-hidden rounded-xl text-popover-foreground outline-none";
export const menuList = "p-1.5";
export const menuItem = [
  "group/item px-play-hover relative flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground outline-none",
  menuItemMotion,
  // The active row: Radix marks it data-highlighted, cmdk data-selected, our
  // own listboxes data-active; an open submenu trigger is data-state=open.
  "data-[highlighted]:bg-foreground/[0.07] data-[selected=true]:bg-foreground/[0.07] data-[active=true]:bg-foreground/[0.07] data-[state=open]:bg-foreground/[0.07]",
  // Radix uses an empty attribute when disabled; cmdk and ours use "true".
  "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[disabled='']:pointer-events-none data-[disabled='']:opacity-50",
  // Icons are 16px and grey, lifting to white on the active row (where a pixel
  // icon's toy also wakes, px-play-hover); one that sets
  // its own size or colour keeps it.
  "[&_svg]:shrink-0 [&_svg:not([class*='size-']):not(.px-art)]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
  "data-[highlighted]:[&_svg:not([class*='text-'])]:text-foreground data-[selected=true]:[&_svg:not([class*='text-'])]:text-foreground data-[active=true]:[&_svg:not([class*='text-'])]:text-foreground",
].join(" ");
export const menuItemDestructive =
  "text-destructive data-[highlighted]:bg-destructive/10 data-[active=true]:bg-destructive/10 [&_svg:not([class*='text-'])]:text-destructive data-[highlighted]:[&_svg:not([class*='text-'])]:text-destructive";
/* The grey half of "Label  Description": same line, truncates first. */
export const menuDescription = "min-w-0 truncate text-muted-foreground";
export const menuHeading = "px-2 pb-1 pt-2 text-[12px] text-muted-foreground";
/* cmdk renders group headings itself; style them through the group. */
export const menuGroup =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-muted-foreground";
export const menuHeader = "flex h-10 items-center gap-2 px-3 text-[13px]";
export const menuRule = "h-px bg-border";
/* A rule between rows inside the padded list: bleeds to the surface edge. */
export const menuSeparator = "-mx-1.5 my-1.5 h-px bg-border";
/* A key's name means nothing on a touch screen: there the hint goes. */
export const menuShortcut = "ml-auto shrink-0 pl-3 text-[12px] tabular-nums text-muted-foreground touch:hidden";
/* The trailing check on the chosen row of a one-of list (select, radio). */
export const menuCheck = "ml-auto flex size-4 shrink-0 items-center justify-center";
export const menuEmpty = "px-2 py-2 text-[13px] text-muted-foreground";

/**
 * Fades a scrolling list at whichever edge has more to show, never a hard
 * cut. Call on mount and on scroll.
 */
export function fadeEdges(el: HTMLElement | null) {
  if (!el) return;
  const top = el.scrollTop > 1;
  const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  el.style.maskImage =
    top || bottom ? `linear-gradient(to bottom, ${top ? "transparent, black 20px" : "black"}, ${bottom ? "black calc(100% - 24px), transparent" : "black"})` : "";
}

/** Ref + scroll handler that keep a list's edges faded; merges a forwarded ref. */
export function useFadeEdges<T extends HTMLElement>(forwarded?: React.ForwardedRef<T>) {
  const ref = React.useCallback(
    (el: T | null) => {
      // After layout, so the list knows its height.
      if (el) requestAnimationFrame(() => fadeEdges(el));
      if (typeof forwarded === "function") forwarded(el);
      else if (forwarded) forwarded.current = el;
    },
    [forwarded],
  );
  const onScroll = React.useCallback((e: React.UIEvent<T>) => fadeEdges(e.currentTarget), []);
  return { ref, onScroll };
}

export function Keycap({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        // A key's name means nothing on a touch screen, as in menuShortcut.
        // A little key: ink at low alpha (it sits on glass too), a hairline and a deeper bottom edge.
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-foreground/[0.06] px-1 font-sans text-[11px] leading-none text-muted-foreground touch:hidden",
        "shadow-[inset_0_0_0_0.5px_hsl(var(--foreground)/0.12),inset_0_-1px_0_hsl(var(--foreground)/0.1)] dark:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.06),inset_0_0_0_0.5px_hsl(var(--foreground)/0.1),inset_0_-1px_0_hsl(0_0%_0%/0.3)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
