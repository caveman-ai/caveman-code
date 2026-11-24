import * as React from "react";
import { Tag, tagVariants, type TagProps, type TagTone } from "./tag";

/** Semantic compatibility layer; geometry and palette belong to Tag. */
const BADGE_TONE = {
  default: "neutral", secondary: "neutral", outline: "neutral", muted: "neutral",
  success: "mint", warning: "yellow", info: "blue", destructive: "red",
} as const satisfies Record<string, TagTone>;

type BadgeVariant = keyof typeof BADGE_TONE;
export interface BadgeProps extends TagProps { variant?: BadgeVariant | null | undefined; }

export function badgeVariants({ variant = "default", className }: { variant?: BadgeVariant | null | undefined; className?: string } = {}) {
  return tagVariants({ tone: BADGE_TONE[variant ?? "default"], className });
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant = "default", tone, ...props }, ref) => (
    <Tag ref={ref} tone={tone ?? BADGE_TONE[variant ?? "default"]} {...props} />
  ),
);
Badge.displayName = "Badge";
