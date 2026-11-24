"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Icon, Cancel01Icon } from "../icons/huge";
import { cn } from "../lib/cn";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

// Last pointer-down anywhere in the app. A dialog opened by a click scales out
// of that point (the trigger) instead of the viewport center; keyboard-opened
// dialogs fall back to a centered origin.
let lastPointerDown: { x: number; y: number; t: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      lastPointerDown = { x: e.clientX, y: e.clientY, t: Date.now() };
    },
    true,
  );
}

/**
 * Ref for a hand-built dialog: scale out of the click that opened it, else the
 * centre. The box must be placed without transforms (inset + margin), so
 * offsetLeft/Top are where it comes to rest.
 */
function clickOrigin(node: HTMLElement | null) {
  if (!node) return;
  const p = lastPointerDown;
  node.style.transformOrigin = p && Date.now() - p.t <= 1500 ? `${p.x - node.offsetLeft}px ${p.y - node.offsetTop}px` : "50% 50%";
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150 motion-reduce:animate-none",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/* One shared size scale so every modal in the app lands on the same widths. */
const DIALOG_SIZES = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
  /* Full-bleed working surface — a trace, a diff, anything that needs the page's
   * own two-column layout inside an overlay. */
  wide: "max-w-6xl",
} as const;

type DialogSize = keyof typeof DIALOG_SIZES;

/**
 * The box every modal shares. One grid column that may shrink to the box
 * (`minmax(0,1fr)`): a grid track otherwise grows to its content's min-content
 * width, so one long unbroken line (a home path in Import your setup) pushed
 * the rows, their status and the footer's button out past the dialog's edge.
 */
export const DIALOG_CONTENT_CLASS =
  "dashboard-scope fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] grid-cols-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl glass p-5 text-popover-foreground";

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { size?: DialogSize }
>(({ className, children, size = "md", ...props }, ref) => {
  // On each open, anchor the scale animation to the click that opened it.
  // offsetWidth/Height read the untransformed layout box, so the final
  // centered position is (viewport - box) / 2 regardless of animation state.
  const setOrigin = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const p = lastPointerDown;
    if (!p || Date.now() - p.t > 1500) {
      node.style.transformOrigin = "50% 50%";
      return;
    }
    const left = (window.innerWidth - node.offsetWidth) / 2;
    const top = (window.innerHeight - node.offsetHeight) / 2;
    node.style.transformOrigin = `${p.x - left}px ${p.y - top}px`;
  }, []);

  const composedRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      setOrigin(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref, setOrigin],
  );

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={composedRef}
        className={cn(
          DIALOG_CONTENT_CLASS,
          "max-h-[85dvh] overflow-y-auto overscroll-contain",
          "data-[state=open]:animate-dialog-pop-in data-[state=closed]:animate-dialog-pop-out motion-reduce:animate-none",
          DIALOG_SIZES[size],
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-3.5 top-3.5 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-snap hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Icon icon={Cancel01Icon} className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 pr-8 text-left", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end", className)} {...props} />;
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-sm font-medium leading-snug", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-[13px] leading-relaxed text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  clickOrigin,
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
