"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Icon, ArrowRight01Icon, Tick02Icon } from "../icons/huge";
import { cn } from "../lib/cn";
import { menuCheck, menuDescription, menuHeading, menuItem, menuItemDestructive, menuList, menuSeparator, menuShortcut, menuSurface, useFadeEdges } from "./menu";
import { popperMotion } from "./motion";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/* A long menu scrolls inside the viewport, its edges fading, instead of
   running off it. */
const scrollable = "max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto overscroll-contain";

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 12, onScroll, ...props }, forwarded) => {
  const fade = useFadeEdges(forwarded);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={fade.ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        onScroll={(e) => (fade.onScroll(e), onScroll?.(e))}
        className={cn(menuSurface, menuList, "min-w-[200px]", scrollable, popperMotion, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { inset?: boolean; variant?: "default" | "destructive" }
>(({ className, inset, variant = "default", ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(menuItem, inset && "pl-8", variant === "destructive" && menuItemDestructive, className)}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

/* Many-of: a checkbox square in the icon slot, filled in ink when on. */
const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem ref={ref} className={cn(menuItem, className)} {...props}>
    <span className="grid size-4 shrink-0 place-items-center">
      <span className="grid size-3.5 place-items-center rounded-[4px] border border-input transition-colors duration-100 ease-snap group-data-[state=checked]/item:border-foreground group-data-[state=checked]/item:bg-foreground">
        <DropdownMenuPrimitive.ItemIndicator>
          <Icon icon={Tick02Icon} className="size-3 text-background animate-in zoom-in-75 duration-150 ease-snap" strokeWidth={3} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

/* One-of: the row as usual, a check at the right of the chosen one. */
const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem ref={ref} className={cn(menuItem, className)} {...props}>
    {children}
    <span className={menuCheck}>
      <DropdownMenuPrimitive.ItemIndicator>
        <Icon icon={Tick02Icon} className="size-3.5 text-foreground animate-in zoom-in-75 duration-150 ease-snap" strokeWidth={2} />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label ref={ref} className={cn(menuHeading, inset && "pl-8", className)} {...props} />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator ref={ref} className={cn(menuSeparator, className)} {...props} />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

function DropdownMenuShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn(menuShortcut, className)} {...props} />;
}

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean; value?: React.ReactNode }
>(({ className, inset, value, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger ref={ref} className={cn(menuItem, inset && "pl-8", className)} {...props}>
    {children}
    {/* What is picked inside, in grey before the chevron ("Sort  Updated at ›"): read without opening it. */}
    {value === undefined ? null : <span className={cn(menuDescription, "ml-auto pl-3")}>{value}</span>}
    <Icon icon={ArrowRight01Icon} className={cn("size-3.5 text-muted-foreground transition-transform duration-150 ease-snap group-data-[state=open]/item:translate-x-0.5", value === undefined && "ml-auto")} />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

/* Portaled so the parent's overflow and transform never clip it; the -7px
   offset (6px padding + 1px edge) lines its first row up with the trigger. */
const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, sideOffset = 4, alignOffset = -7, collisionPadding = 12, onScroll, ...props }, forwarded) => {
  const fade = useFadeEdges(forwarded);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        ref={fade.ref}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        onScroll={(e) => (fade.onScroll(e), onScroll?.(e))}
        className={cn(menuSurface, menuList, "min-w-[180px]", scrollable, popperMotion, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
