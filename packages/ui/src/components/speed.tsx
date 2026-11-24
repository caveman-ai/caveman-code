import * as React from "react";
import { FlashIcon, Icon } from "../icons/huge";
import { cn } from "../lib/cn";

/*
 * Speed: how fast the model answers. A bolt at the end of the model
 * picker's foot, only on a model with a faster tier than standard: Claude Agent's fast mode, Codex's Fast and
 * Ultrafast. A click goes to the next speed, back to standard after the fastest. Off, the bolt is a grey outline; on,
 * it is filled in amber (`--speed`), with a second bolt behind it at the fastest of two or more. The model chip shows
 * the same mark while a faster speed is on, and nothing at standard.
 */

export const STANDARD_SPEED = "standard";

const LABELS: Record<string, string> = { standard: "Standard", fast: "Fast", ultrafast: "Ultrafast" };

export function speedLabel(speed: string): string {
  return LABELS[speed] ?? speed.charAt(0).toUpperCase() + speed.slice(1);
}

/** The speed to use on a model: the wanted one if offered, else the fallback if offered, else standard; none without speeds. */
export function pickSpeed(speeds: readonly string[] | undefined, wanted?: string, fallback?: string): string | undefined {
  if (!speeds?.length) return undefined;
  const offered = (s: string | undefined): s is string => s !== undefined && (s === STANDARD_SPEED || speeds.includes(s));
  return offered(wanted) ? wanted : offered(fallback) ? fallback : STANDARD_SPEED;
}

/** The speed after `current`: standard, each faster one in turn, then standard again. */
export function nextSpeed(speeds: readonly string[], current: string | undefined): string {
  const order = [STANDARD_SPEED, ...speeds];
  return order[(Math.max(0, order.indexOf(current ?? STANDARD_SPEED)) + 1) % order.length]!;
}

/** Chrome text in the speed's colour: the bolt in the picker's foot and on the model chip. */
export const SPEED_TEXT = "text-[hsl(var(--speed))]";

/** The bolt for a speed past standard: one, or two at the fastest of two or more. Nothing at standard. */
export function SpeedMark({ speeds, speed, className }: { speeds: readonly string[]; speed: string | undefined; className?: string }) {
  if (!speed || speed === STANDARD_SPEED) return null;
  const fastest = speeds.length > 1 && speeds.indexOf(speed) === speeds.length - 1;
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center", SPEED_TEXT, className)}>
      {fastest ? <Icon icon={FlashIcon} className="-mr-1.5 size-3.5 fill-current opacity-55" /> : null}
      <Icon icon={FlashIcon} className="size-3.5 fill-current" />
    </span>
  );
}

/** The bolt button: the speed now, a click for the next. Focus stays where it was (the picker's search). */
export function SpeedToggle({ speeds, value, onChange, className }: { speeds: readonly string[]; value: string | undefined; onChange: (speed: string) => void; className?: string | undefined }) {
  if (speeds.length === 0) return null;
  const on = value !== undefined && value !== STANDARD_SPEED;
  const label = `Speed: ${speedLabel(value ?? STANDARD_SPEED)}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onChange(nextSpeed(speeds, value))}
      className={cn(
        "grid h-6 min-w-6 shrink-0 place-items-center rounded-md px-1 outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        on ? SPEED_TEXT : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {on ? <SpeedMark speeds={speeds} speed={value} /> : <Icon icon={FlashIcon} className="size-3.5" />}
    </button>
  );
}
