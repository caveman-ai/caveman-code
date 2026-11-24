import { Icon, Add01Icon, AlertCircleIcon, Tick02Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useState } from "react";

/** Where a connection stands: to make, a sign-in open in the browser, made, or the sign-in failed. */
export type ConnectState = "add" | "waiting" | "connected" | "failed";

/**
 * Whether `on` turned true while this component was on screen: a landing plays then, never on first paint
 * (StatusMark's rule). Stays true once it has.
 */
export function useLanded(on: boolean): boolean {
  const [seen, setSeen] = useState(on);
  const [landed, setLanded] = useState(false);
  if (seen !== on) {
    setSeen(on);
    if (on) setLanded(true);
  }
  return landed;
}

/**
 * A connection's mark, the same wherever one is made (a Plugins row, the install dialog's sign-in, a plugin's
 * Connect list): the plus; the plus blinking while the sign-in is open in the browser (it waits on the person,
 * so not the working ring); the check; the failed mark. Chrome, so Hugeicons. `land`: the check pops in where the
 * plus stood; pass useLanded's answer. Ink follows the text colour, so a parent's `text-success` keeps the check
 * green at rest. Reduced motion shows each still.
 */
export function ConnectMark({ state, land = false, scale = 1, className }: { state: ConnectState; land?: boolean; scale?: 1 | 2 | 3; className?: string }) {
  const icon = state === "connected" ? Tick02Icon : state === "failed" ? AlertCircleIcon : Add01Icon;
  return (
    <Icon
      icon={icon}
      className={cn(
        SIZE[scale],
        "shrink-0",
        state === "waiting" && "px-blink-loop",
        state === "connected" && land && "animate-in fade-in-0 zoom-in-50 duration-200 ease-snap motion-reduce:animate-none",
        className,
      )}
    />
  );
}

const SIZE = { 1: "size-4", 2: "size-8", 3: "size-12" } as const;
