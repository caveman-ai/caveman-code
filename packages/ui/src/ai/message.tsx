// Adapted from shadcn/ui Message + Bubble + Marker (registry/base-nova/ui,
// MIT, 2026-10 AI Elements). One turn: a header (the speaker's mark and
// name), content, a footer for actions. The user's words sit in a Bubble on
// the right; the engine's answer is open prose on the left. Markers divide
// turns (stopped, failed, resumed). Deck tokens, Tailwind 3.4.
import * as React from "react";
import { cn } from "../lib/cn";

export function Message({ className, from = "assistant", ...props }: React.ComponentProps<"div"> & { from?: "user" | "assistant" }) {
  return <div data-slot="message" data-from={from} className={cn("group/message relative flex w-full min-w-0 flex-col gap-1.5", from === "user" && "items-end", className)} {...props} />;
}

export function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-header" className={cn("flex h-5 min-w-0 items-center gap-2 text-[12px] text-muted-foreground", className)} {...props} />;
}

export function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-content" className={cn("flex w-full min-w-0 flex-col gap-2 [overflow-wrap:anywhere]", className)} {...props} />;
}

export function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="message-footer" className={cn("flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground", className)} {...props} />;
}

/** The user's message. Right-aligned, a step above the panel. */
export function Bubble({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble"
      className={cn("w-fit min-w-0 max-w-[80%] whitespace-pre-wrap rounded-xl bg-secondary px-3.5 py-2 text-[14px] leading-[22px] text-foreground [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

/** A note between turns. `separator` draws hairlines on both sides. */
export function Marker({ className, variant = "default", ...props }: React.ComponentProps<"div"> & { variant?: "default" | "separator" }) {
  return (
    <div
      data-slot="marker"
      role="note"
      className={cn(
        "flex min-h-5 w-full items-center gap-2 text-[12px] text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
        variant === "separator" && "before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border",
        className,
      )}
      {...props}
    />
  );
}
