import * as React from "react";
import { cn } from "../lib/cn";
import { skeletonMotion } from "./motion";

/** Static, decorative geometry. The enclosing loading region announces status. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" data-skeleton="" className={cn("rounded-md bg-muted", skeletonMotion, className)} {...props} />;
}

export { Skeleton };
