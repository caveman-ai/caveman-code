// A tab's attention mark (store.ts Tab.attention): a quiet dot for something that changed, and for something put
// there for the person that they didn't open (a Chief's Smart View) a blue one whose ring pulses softly until they
// look. The one blue (packages/ui STYLE.md, `--target`): "here". Reduced motion keeps the dot.
import { cn } from "@caveman-app/ui/lib/cn";
import "./attention.css";

export function AttentionDot({ attention, className }: { attention: boolean | "pulse"; className?: string }) {
  if (attention === "pulse") {
    return (
      <span role="img" aria-label="New, not seen yet" data-attention="pulse" className={cn("pointer-events-none size-1.5 rounded-full bg-target", className)}>
        <span aria-hidden className="attention-ring block size-full rounded-full bg-target" />
      </span>
    );
  }
  return <span role="img" aria-label="New activity" className={cn("size-1.5 rounded-full bg-foreground", className)} />;
}
