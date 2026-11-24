"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "../lib/cn";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    ref={ref}
    className={cn(
      "group peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 ease-snap",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
      // The track is a groove: a soft inner shade under its top edge.
      "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input shadow-[inset_0_1px_2px_hsl(0_0%_0%/0.18)]",
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        // A raised thumb (a drop and a lit top) that stretches toward where it would go while held, as macOS's does.
        "pointer-events-none block h-4 w-4 rounded-full bg-muted-foreground ring-0 transition-[transform,background-color,width] duration-200 ease-snap data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0",
        "shadow-[inset_0_1px_0_hsl(0_0%_100%/0.25),0_0_0_0.5px_hsl(0_0%_0%/0.12),0_1px_2px_hsl(0_0%_0%/0.3)]",
        "group-active:w-5 data-[state=checked]:group-active:translate-x-3 group-disabled:group-active:w-4 group-disabled:data-[state=checked]:group-active:translate-x-4 motion-reduce:transition-none",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
