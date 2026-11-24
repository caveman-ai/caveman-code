import * as React from "react";
import { cn } from "../lib/cn";
import { NavIcon } from "../icons/NavButton";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-8 w-full rounded-md border border-input bg-control px-2.5 py-1 text-[13px] transition-colors",
        "placeholder:text-[hsl(var(--subtle-foreground))]",
        "focus-visible:outline-none focus-visible:border-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "file:border-0 file:bg-transparent file:text-[13px] file:font-medium",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

/*
 * The one search box: the field above with the pixel lens at its left, which
 * peeks left-right on hover like the sidebar's Search. Accents stay ink until
 * then, so at rest it is as quiet as any field.
 */
const SearchField = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { containerClassName?: string }>(
  ({ className, containerClassName, ...props }, ref) => (
    <div
      className={cn(
        "px-play-hover relative flex min-w-0 items-center text-muted-foreground [--px-accent:currentColor] focus-within:text-foreground focus-within:[--px-accent:initial] hover:[--px-accent:initial]",
        containerClassName,
      )}
    >
      <NavIcon name="search" className="pointer-events-none absolute left-2 transition-colors duration-100" />
      <Input ref={ref} type="search" className={cn("pl-8 text-foreground hover:border-ring/60 [&::-webkit-search-cancel-button]:appearance-none", className)} {...props} />
    </div>
  ),
);
SearchField.displayName = "SearchField";

export { Input, SearchField };
