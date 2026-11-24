import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

/*
 * One button family. The default and secondary buttons are keys, the send
 * key's material (globals.css `.key`): lit from above, they sink a pixel when
 * pressed. A pixel nav icon inside (<NavIcon>) is a toy: it wakes on hover
 * and goes off when pressed (pixel.css "Toys"). Hierarchy, loudest first:
 *   default      THE action of a view: the white key
 *   secondary    the card key, the New chat button: one step above whatever
 *                it sits on (ink at low alpha, so it reads on shell, panel
 *                and card alike)
 *   ghost        quiet verbs in toolbars and rows: grey until hovered
 *   link         inline text
 * `outline` is the secondary card too (kept so call sites read naturally).
 */
/* A wide key barely shrinks as it sinks; the composer's 32px keys go to 0.96. */
const key = "key [--key-press:0.98]";
const card = cn(key, "bg-foreground/[0.05] text-foreground hover:bg-foreground/[0.09] data-[state=open]:bg-foreground/[0.09] dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.11] dark:data-[state=open]:bg-foreground/[0.11]");
/* What isn't a key shrinks a little when pressed. */
const press = "active:scale-[0.98] data-[state=open]:active:scale-100 motion-reduce:active:scale-100";
/* No drop shadow under a button (STYLE.md 5): in dark, only a lit top edge. */
const raised = "dark:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.05)]";

const buttonVariants = cva(
  [
    "px-play-hover inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-[13px] font-medium outline-none",
    "transition-[color,background-color,border-color,box-shadow,opacity,transform,filter] duration-100 ease-snap",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-']):not(.px-art)]:size-4 [&_.px-nav-icon]:transition-transform active:[&_.px-nav-icon]:translate-y-px",
  ].join(" "),
  {
    variants: {
      variant: {
        default: key,
        secondary: card,
        outline: card,
        ghost: press + " text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
        destructive: cn(press, "bg-destructive text-destructive-foreground hover:bg-destructive/90", raised),
        "destructive-outline": press + " border border-destructive/45 bg-transparent text-destructive hover:border-destructive/70 hover:bg-destructive/10",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 rounded-md px-2.5 text-[12.5px]",
        lg: "h-9 px-4",
        icon: "size-8",
        "icon-sm": "size-7 rounded-md",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

/** The key tone a variant wears (globals.css `.key`); the others are no key. */
function toneOf(variant: ButtonProps["variant"]): "lit" | "card" | undefined {
  if (variant === "default" || variant == null) return "lit";
  if (variant === "secondary" || variant === "outline") return "card";
  return undefined;
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} data-tone={toneOf(variant)} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
