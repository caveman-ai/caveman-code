import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

/** One visual vocabulary for labels, filters, status and overflow counts. */
export const tagVariants = cva("tag", {
  variants: {
    tone: {
      neutral: "tag-neutral",
      blue: "tag-blue",
      green: "tag-green",
      mint: "tag-mint",
      yellow: "tag-yellow",
      orange: "tag-orange",
      purple: "tag-purple",
      red: "tag-red",
    },
    size: { sm: "tag-sm", md: "tag-md" },
  },
  defaultVariants: { tone: "neutral", size: "sm" },
});

export type TagTone = NonNullable<VariantProps<typeof tagVariants>["tone"]>;

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof tagVariants> {
  /** Adopt a link or disclosure button without nesting interactive elements. */
  asChild?: boolean;
}

export const Tag = React.forwardRef<HTMLSpanElement, TagProps>(
  ({ className, tone, size, asChild = false, children, title, ...props }, ref) => {
    const Component = asChild ? Slot : "span";
    return (
      <Component ref={ref} className={cn(tagVariants({ tone, size }), className)} title={title ?? (typeof children === "string" ? children : undefined)} {...props}>
        {asChild ? children : <span className="tag-label">{children}</span>}
      </Component>
    );
  },
);
Tag.displayName = "Tag";

/** Stable category identity, separate from chart ranking and success state. */
export function categoryTagTone(value: string): TagTone {
  const tones = ["blue", "purple", "orange", "yellow"] as const;
  let hash = 0;
  for (const char of value) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return tones[hash % tones.length]!;
}
