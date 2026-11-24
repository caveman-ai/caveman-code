import { cn } from "@caveman-app/ui/lib/cn";

/**
 * The agent is using this screen right now: a dot in the one blue ("here", where it works) with a ring pulsing out of
 * it, on the screen's tab and the chat header's live button. Reduced motion keeps the dot.
 */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span role="img" aria-label="In use by the agent" className={cn("pointer-events-none size-1.5 rounded-full bg-target", className)}>
      <span aria-hidden className="live-ring block size-full rounded-full bg-target" />
    </span>
  );
}
