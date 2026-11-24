import { Slot, Slottable } from "@radix-ui/react-slot";
import * as React from "react";
import { cn } from "../lib/cn";
import { PixelIcon } from "./PixelIcon";
import type { PixelIconName } from "./names";

/**
 * A nav icon (STYLE.md "Special nav buttons"): the sidebar's main nav keeps
 * its pixel art, a toy (pixel.css "Toys") that wakes when
 * its `.px-play-hover` row is hovered or keyboard-focused; reduced motion
 * leaves it still. Everywhere else, chrome is a Hugeicon (Glyph).
 */
export function NavIcon({ name, className }: { name: PixelIconName; className?: string }) {
  return (
    <span className={cn("px-nav-icon", className)}>
      <PixelIcon name={name} />
    </span>
  );
}

/**
 * The sidebar's primary row. Rest: grey label and icon. Hover / focus: the
 * row fills and both come to foreground. Current page (`aria-current="page"`,
 * which react-router's NavLink sets): foreground label and icon, a pixel
 * tick in the left gutter (needs 8px of room left of the row).
 *
 *   <NavButton asChild icon="inbox"><NavLink to="/inbox">Inbox</NavLink></NavButton>
 */
export const navButtonClass = cn(
  "px-nav px-play-hover flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-sidebar-foreground outline-none",
  "transition-colors duration-75 ease-snap hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  "aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground",
  "[--px-accent:currentColor] hover:[--px-accent:initial] focus-visible:[--px-accent:initial] aria-[current=page]:[--px-accent:initial]",
);

type NavButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: PixelIconName;
  /** Render the child (a link) as the row, with the icon put before its text. */
  asChild?: boolean;
  /** Right-aligned meta, e.g. an unread count. */
  trailing?: React.ReactNode;
};

export const NavButton = React.forwardRef<HTMLButtonElement, NavButtonProps>(
  ({ icon, asChild, trailing, className, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp ref={ref} type={asChild ? undefined : "button"} className={cn(navButtonClass, className)} {...props}>
        <NavIcon name={icon} />
        <Slottable>{children}</Slottable>
        {trailing != null && <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{trailing}</span>}
      </Comp>
    );
  },
);
NavButton.displayName = "NavButton";
