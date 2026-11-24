import * as React from "react";
import { Icon, type IconSvgElement } from "../icons/huge";
import { cn } from "../lib/cn";

/** The deck's titled card (Shopify's): one flat 14px surface, the 13px muted
 *  title and its quiet controls on the first row, the content under it. No
 *  shell around a second card — one surface, one hairline. */
export function Panel({ title, icon, actions, children, className, bodyClassName, actionsClassName, titleAs: Title = "h2", ...props }: {
  title: React.ReactNode;
  icon?: IconSvgElement | undefined;
  /** Quiet controls at the right of the title row; the icon sits there when absent. */
  actions?: React.ReactNode;
  bodyClassName?: string | undefined;
  /** A control that must scroll rather than widen the card passes `min-w-0 shrink`. */
  actionsClassName?: string | undefined;
  /** Stat tiles are not sections; their label stays out of the heading outline. */
  titleAs?: "h2" | "h3" | "span";
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  return <section className={cn("group/card flex min-w-0 flex-col rounded-[14px] border border-border bg-card text-card-foreground shadow-elevated", className)} {...props}>
    {/* Crowded controls wrap to a second line instead of widening the card. */}
    <header className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-4 pb-1 pt-2.5">
      <Title data-image-title className="min-w-0 text-[13px] font-medium text-muted-foreground [overflow-wrap:anywhere]">{title}</Title>
      <div data-image-hide className={cn("ml-auto flex max-w-full shrink-0 items-center gap-1.5 text-xs text-muted-foreground", actionsClassName)}>
        {actions ?? (icon ? <Icon icon={icon} className="size-4" /> : null)}
      </div>
    </header>
    <div className={cn("min-w-0 flex-1", bodyClassName)}>{children}</div>
  </section>;
}
