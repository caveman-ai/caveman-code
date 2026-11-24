// Adapted from shadcn/ui Trace (registry/base-nova/ui/trace.tsx, MIT, 2026-10
// AI Elements). Tailwind 3.4 + deck tokens; the Base UI Collapsible became a
// plain button with aria-expanded so the line stays one tab stop. Icons are
// slots: the app passes Hugeicons (STYLE.md section 7).
import { Icon, ArrowRight01Icon } from "../icons/huge";
import * as React from "react";
import { cn } from "../lib/cn";
import { DisclosureContent } from "./disclosure";

type TraceStatus = "running" | "error" | "pending";

const StatusContext = React.createContext<TraceStatus | undefined>(undefined);

/** A list of lines for the steps an agent takes: tools, reasoning, plans, subagents. */
export function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="trace" className={cn("flex w-full min-w-0 flex-col gap-0.5", className)} {...props} />;
}

/** One step: icon, title (verb + subject), optional description. */
export function TraceLine({ className, status, ...props }: React.ComponentProps<"span"> & { status?: TraceStatus | undefined }) {
  return (
    <StatusContext.Provider value={status}>
      <span
        data-slot="trace-line"
        data-status={status}
        className={cn(
          "flex h-7 w-fit max-w-full min-w-0 items-center gap-2 text-[13px] text-muted-foreground",
          "data-[status=error]:text-destructive data-[status=pending]:text-[hsl(var(--subtle-foreground))]",
          className,
        )}
        {...props}
      />
    </StatusContext.Provider>
  );
}

export function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&>svg:not([class*='size-'])]:size-4", className)}
      {...props}
    />
  );
}

/** The verb in the tier's grey, the subject (`<TraceSubject>`) in mono. Shimmers while running. */
export function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  const status = React.useContext(StatusContext);
  return <span data-slot="trace-title" className={cn("min-w-0 truncate", status === "running" && "lucy-shimmer", className)} {...props} />;
}

export function TraceSubject({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-subject" className={cn("font-mono text-[12px] text-secondary-foreground", className)} {...props} />;
}

export function TraceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-description" className={cn("shrink-0 text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]", className)} {...props} />;
}

type CollapsibleState = { open: boolean; setOpen: (open: boolean) => void; contentId: string };
const CollapsibleContext = React.createContext<CollapsibleState | null>(null);

/** A line that expands. Uncontrolled unless `open` + `onOpenChange` are passed. */
export function TraceCollapsible({
  className,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<"div"> & { open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [inner, setInner] = React.useState(defaultOpen);
  const open = openProp ?? inner;
  const contentId = React.useId();
  const state = React.useMemo<CollapsibleState>(
    () => ({
      open,
      contentId,
      setOpen: (next) => {
        setInner(next);
        onOpenChange?.(next);
      },
    }),
    [open, contentId, onOpenChange],
  );
  return (
    <CollapsibleContext.Provider value={state}>
      <div data-slot="trace-collapsible" data-open={open || undefined} className={cn("flex w-full min-w-0 flex-col", className)} {...props} />
    </CollapsibleContext.Provider>
  );
}

export function TraceCollapsibleTrigger({ className, children, onClick, ...props }: React.ComponentProps<"button">) {
  const state = React.useContext(CollapsibleContext);
  return (
    <button
      type="button"
      data-slot="trace-collapsible-trigger"
      aria-expanded={state?.open ?? false}
      aria-controls={state?.contentId}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) state?.setOpen(!state.open);
      }}
      className={cn(
        "group/trace-trigger flex w-fit max-w-full min-w-0 items-center gap-1 rounded-md pr-1 text-left text-muted-foreground outline-none transition-colors duration-75",
        "hover:text-foreground [&:hover_[data-slot=trace-line]]:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        "has-[[data-status=error]]:text-destructive",
        className,
      )}
      {...props}
    >
      {children}
      <Icon
        icon={ArrowRight01Icon}
        // Faint at rest (70%: 3.7:1, an icon's 3:1 with room), so a line that opens looks like one; full on hover, focus and while open.
        className="size-3.5 shrink-0 opacity-70 transition-[transform,opacity] duration-150 ease-snap group-hover/trace-trigger:opacity-100 group-focus-visible/trace-trigger:opacity-100 group-aria-expanded/trace-trigger:rotate-90 group-aria-expanded/trace-trigger:opacity-100"
      />
    </button>
  );
}

export function TraceCollapsibleContent({ className, children, ...props }: React.ComponentProps<"div">) {
  const state = React.useContext(CollapsibleContext);
  return (
    <DisclosureContent
      open={state?.open ?? false}
      id={state?.contentId}
      data-slot="trace-collapsible-content"
      className="min-w-0"
      innerClassName="min-w-0 text-[13px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
      {...props}
    >
      <div className={cn("mb-1 ml-[7px] mt-0.5 border-l border-border pl-4", className)}>
        {children}
      </div>
    </DisclosureContent>
  );
}
