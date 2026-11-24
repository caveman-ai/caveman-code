// Artifacts (STYLE.md section 11), on the shape of AI SDK Elements' Artifact
// (header, title, actions, content), restyled to the deck. In a transcript an
// artifact is an ArtifactCard: the whole card is one button with a 20px badge
// (an artifact Hugeicon on a rounded tile), the name in white, one grey meta
// line, an optional preview (mini diff, thumbnail), and a chevron that nudges
// 2px right on hover. In the side panel it is an Artifact frame.
import { Icon, ArrowRight01Icon } from "../icons/huge";
import * as React from "react";
import { cn } from "../lib/cn";

/** The type badge: a 16px Hugeicon on a 20px rounded tile. */
export function ArtifactBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="artifact-badge"
      aria-hidden="true"
      className={cn("grid size-5 shrink-0 place-items-center rounded bg-secondary text-muted-foreground [&_svg]:size-4", className)}
      {...props}
    />
  );
}

export function ArtifactCard({
  badge,
  title,
  meta,
  preview,
  current = false,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "title"> & {
  badge: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  /** Shown under the title row: a mini diff, a thumbnail. */
  preview?: React.ReactNode;
  /** Open in the side panel right now. */
  current?: boolean;
}) {
  return (
    <button
      type="button"
      data-slot="artifact-card"
      data-current={current || undefined}
      className={cn(
        "group/artifact flex w-full min-w-0 max-w-[480px] flex-col overflow-hidden rounded-lg border border-border bg-card text-left outline-none",
        "transition-[border-color,background-color] duration-75 hover:border-input hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
        "data-[current]:border-muted-foreground/50 data-[current]:bg-accent/40",
        className,
      )}
      {...props}
    >
      <span className="flex h-10 w-full min-w-0 items-center gap-2.5 px-2.5">
        <ArtifactBadge>{badge}</ArtifactBadge>
        <span className="min-w-0 truncate text-[13px] text-foreground">{title}</span>
        {meta ? <span className="min-w-0 shrink truncate text-[12px] tabular-nums text-muted-foreground">{meta}</span> : null}
        <Icon
          icon={ArrowRight01Icon}
          className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap group-hover/artifact:translate-x-0.5 group-hover/artifact:text-foreground group-focus-visible/artifact:translate-x-0.5"
        />
      </span>
      {preview ? <span className="block w-full min-w-0 border-t border-border">{preview}</span> : null}
    </button>
  );
}

/** A few +/- lines under a file card. Colour plus a marker: never colour alone. */
export function ArtifactDiffPreview({ lines, more = 0 }: { lines: ReadonlyArray<string>; more?: number }) {
  return (
    <span className="block py-1 font-mono text-[11.5px] leading-[18px]">
      {lines.map((l, i) => {
        const add = l.startsWith("+");
        return (
          <span key={i} className={cn("flex min-w-0 gap-2 px-2.5", add ? "bg-success/[0.08]" : "bg-destructive/[0.08]")}>
            <span aria-hidden className={cn("w-2 shrink-0 select-none", add ? "text-success" : "text-destructive")}>
              {add ? "+" : "−"}
            </span>
            <span className="sr-only">{add ? "added" : "removed"}</span>
            <span className="min-w-0 truncate whitespace-pre text-secondary-foreground">{l.slice(1) || " "}</span>
          </span>
        );
      })}
      {more > 0 ? <span className="block px-2.5 pt-0.5 font-sans text-[11px] text-[hsl(var(--subtle-foreground))]">{more} more changed lines</span> : null}
    </span>
  );
}

// ------------------------------------------------------------- panel frame

export function Artifact({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="artifact" className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)} {...props} />;
}

export function ArtifactHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="artifact-header" className={cn("flex h-11 shrink-0 items-center gap-2 border-b border-border pl-2 pr-1.5", className)} {...props} />;
}

export function ArtifactTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="artifact-title" className={cn("flex min-w-0 items-center gap-2 text-[13px] text-foreground", className)} {...props} />;
}

export function ArtifactDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="artifact-description" className={cn("min-w-0 truncate text-[12px] tabular-nums text-muted-foreground", className)} {...props} />;
}

export function ArtifactActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="artifact-actions" className={cn("ml-auto flex shrink-0 items-center gap-0.5", className)} {...props} />;
}

/** An icon button in the header. `label` names it for screen readers and the tooltip. */
export const ArtifactAction = React.forwardRef<HTMLButtonElement, React.ComponentProps<"button"> & { label: string; pressed?: boolean }>(function ArtifactAction(
  { label, pressed, className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        "grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:text-foreground [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
});

export function ArtifactContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="artifact-content" className={cn("min-h-0 flex-1 overflow-auto", className)} {...props} />;
}
