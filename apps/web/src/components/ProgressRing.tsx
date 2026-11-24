// A 16px ring that fills clockwise from the top with a share used: the composer's context and the sidebar's plan week.
// The arc takes the current colour unless `arcClassName` tints it (amber, red); the faint track is the same colour.
// Decorative: whatever holds it says the share in words.
import { cn } from "@caveman-app/ui/lib/cn";

const C = 2 * Math.PI * 6;

export function ProgressRing({
  percent,
  arcClassName,
  className,
}: {
  percent: number;
  arcClassName?: string | undefined;
  className?: string | undefined;
}) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0 -rotate-90", className)} aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={`${(pct / 100) * C} ${C}`}
        className={cn(
          "transition-[stroke-dasharray] duration-300 ease-snap motion-reduce:transition-none",
          arcClassName,
        )}
      />
    </svg>
  );
}
