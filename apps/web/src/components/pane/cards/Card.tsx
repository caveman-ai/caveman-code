import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowRight01Icon, type IconSvgElement } from "@caveman-app/ui/icons/huge";
import { useId, useState, type ReactNode } from "react";

// The Overview's card shell and row, shared by the live cards (Now, Plan,
// Agents) and the session's details (PaneCardsView).

export function Card({
  title,
  summary,
  aside,
  defaultOpen = false,
  tone,
  children,
}: {
  title: string;
  /** Shown beside the title while the card is shut. */
  summary?: ReactNode;
  /** Shown beside the title open or shut. */
  aside?: ReactNode;
  defaultOpen?: boolean;
  /** `attention`: it waits on the person. */
  tone?: "attention";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={cn("rounded-xl border px-2 py-1.5 transition-colors duration-200", tone === "attention" ? "border-warning/45" : "border-border")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="group flex h-7 w-full items-center gap-1 rounded-md px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="text-[12px] font-medium text-muted-foreground group-hover:text-foreground">{title}</span>
        <Icon icon={ArrowRight01Icon} className={cn("size-3.5 text-muted-foreground transition-transform duration-150 ease-snap", open && "rotate-90")} />
        {aside || (summary && !open) ? (
          <span className="ml-auto flex min-w-0 items-center gap-2">
            {summary && !open ? summary : null}
            {aside}
          </span>
        ) : null}
      </button>
      <Fold open={open} id={id}>
        <div className="pb-0.5 pt-0.5">{children}</div>
      </Fold>
    </section>
  );
}

/** Opens on a 0fr -> 1fr grid row (styles.css .overview-fold); shut, its content is gone from the tab order. */
export function Fold({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return (
    <div id={id} className="overview-fold" data-open={open || undefined} inert={!open}>
      <div>{children}</div>
    </div>
  );
}

export function Row({ icon, label, meta, title, mono, metaInline }: { icon: IconSvgElement; label: string; meta?: string | undefined; title?: string; mono?: boolean; metaInline?: boolean }) {
  return (
    <div title={title} className="flex h-8 items-center gap-2 px-1 text-[13px]">
      <Icon icon={icon} className="size-4 shrink-0" />
      <span className={cn("shrink-0 truncate text-foreground", mono && "font-mono text-[12.5px]", metaInline ? "max-w-[50%]" : "max-w-[70%]")}>{label}</span>
      {meta ? <span className={cn("min-w-0 truncate text-[12px] text-muted-foreground", !metaInline && "ml-auto")}>{meta}</span> : null}
    </div>
  );
}
