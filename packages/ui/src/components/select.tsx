"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Icon, ArrowDown01Icon, Tick02Icon } from "../icons/huge";
import { cn } from "../lib/cn";
import { menuCheck, menuHeading, menuItem, menuList, menuSeparator, menuSurface, useFadeEdges } from "./menu";
import { popperMotion } from "./motion";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-control px-2.5 text-[13px] text-foreground transition-colors duration-150 ease-snap",
      "hover:bg-accent data-[state=open]:border-ring data-[state=open]:bg-accent",
      // The chevron flips with the panel, on the same curve.
      "[&[data-state=open]_svg]:rotate-180",
      "placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none focus:border-ring disabled:cursor-not-allowed disabled:opacity-50",
      "[&>span]:line-clamp-1 data-[placeholder]:text-muted-foreground",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <Icon icon={ArrowDown01Icon} className="size-3.5 text-muted-foreground transition-transform duration-200 ease-snap" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

/* The list is the shared menu: same surface, rows and fade as a dropdown. */
const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", sideOffset = 6, collisionPadding = 12, ...props }, ref) => {
  const fade = useFadeEdges<HTMLDivElement>();
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(menuSurface, "relative max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[8rem]", popperMotion, className)}
        {...props}
      >
        <SelectPrimitive.Viewport
          ref={fade.ref}
          onScroll={fade.onScroll}
          className={cn(menuList, position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]")}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => <SelectPrimitive.Label ref={ref} className={cn(menuHeading, className)} {...props} />);
SelectLabel.displayName = SelectPrimitive.Label.displayName;

/* The chosen row carries a check at the right, like a radio item. */
const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={cn(menuItem, className)} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <span className={menuCheck}>
      <SelectPrimitive.ItemIndicator>
        <Icon icon={Tick02Icon} className="size-3.5 text-foreground animate-in zoom-in-75 duration-150 ease-snap" strokeWidth={2} />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => <SelectPrimitive.Separator ref={ref} className={cn(menuSeparator, className)} {...props} />);
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator };
