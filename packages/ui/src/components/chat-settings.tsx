import type * as React from "react";
import { cn } from "../lib/cn";
import { DropdownMenu, DropdownMenuContent, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { Icon, PreferenceHorizontalIcon } from "../icons/huge";

/*
 * A chat's settings behind one button (, after native agent
 * menu): the sliders after `+` on the composer's bottom bar. Each row is a
 * setting's name, its value in grey and a chevron, its choices beside it: where
 * a new chat runs, what the engine may do without asking. No icons on the
 * rows; the choices keep theirs.
 */

export function ChatSettings({
  children,
  open,
  onOpenChange,
  onClosed,
}: {
  /** SettingRows. */
  children: React.ReactNode;
  /** Opened from outside (the composer's /permissions); left out, the menu keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Closed: focus goes here instead of back to the button (the composer's message box). */
  onClosed?: () => void;
}) {
  return (
    <DropdownMenu {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label="Chat settings"
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75",
              // Open by aria-expanded: the tooltip's data-state overrides the menu's on the shared button.
              "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground",
            )}
          >
            <Icon icon={PreferenceHorizontalIcon} className="size-4" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Chat settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[280px]"
        {...(onClosed ? { onCloseAutoFocus: (e: Event) => (e.preventDefault(), onClosed()) } : {})}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One setting: "Permissions  Full access ›", its choices opening beside it. */
export function SettingRow({
  label,
  value,
  mark,
  children,
  open,
  onOpenChange,
  className,
}: {
  label: string;
  /** The current choice, in grey; truncates before the label does. */
  value: string;
  /** A status dot before the value (Cloud setting up). */
  mark?: React.ReactNode;
  /** The choices. */
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The choices' surface (its width). */
  className?: string;
}) {
  return (
    <DropdownMenuSub {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <DropdownMenuSubTrigger>
        <span className="shrink-0">{label}</span>
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-muted-foreground">
          {mark}
          <span className="truncate">{value}</span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={className}>{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
