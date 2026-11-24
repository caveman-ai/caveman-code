// AI Elements Confirmation (shadcn ai-elements, MIT), adapted: the paging
// header over pending approvals, so several asks read as one card with
// "2 of 3" and arrows instead of a stack of cards.
import { Icon, ArrowLeft01Icon, ArrowRight01Icon } from "../icons/huge";

import { cn } from "../lib/cn";

export function ConfirmationPager({
  index,
  count,
  onPage,
  className,
}: {
  /** Zero-based. */
  index: number;
  count: number;
  onPage: (index: number) => void;
  className?: string;
}) {
  if (count < 2) return null;
  const button = "grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30";
  return (
    <div role="group" aria-label="Pending requests" className={cn("flex items-center gap-1 text-[12px] tabular-nums text-muted-foreground", className)}>
      <button type="button" aria-label="Previous request" disabled={index === 0} onClick={() => onPage(index - 1)} className={button}>
        <Icon icon={ArrowLeft01Icon} className="size-3.5" />
      </button>
      <span aria-live="polite">
        {index + 1} of {count}
      </span>
      <button type="button" aria-label="Next request" disabled={index === count - 1} onClick={() => onPage(index + 1)} className={button}>
        <Icon icon={ArrowRight01Icon} className="size-3.5" />
      </button>
    </div>
  );
}
