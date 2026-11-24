// The pieces every surface's chrome is made of, so the browser bar, the file
// header and the diff toolbar read as one family: a 40px bar under the tab
// strip, 28px icon buttons with a tooltip that names the action and its
// keys, grouped pills, keycaps, and one quiet empty state.

import { Keycap } from "@caveman-app/ui/components/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@caveman-app/ui/components/tooltip";
import { cn } from "@caveman-app/ui/lib/cn";
import { isComposing } from "@caveman-app/ui/lib/ime";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { chord } from "../state/keybindings.ts";
import { arriveMotion } from "@caveman-app/ui/motion";
import { IS_MAC } from "../lib/platform.ts";
import { Icon, type IconSvgElement } from "@caveman-app/ui/icons/huge";

export { IS_MAC, isComposing, Keycap };

/** In a browser tab ⌘T and ⌘W belong to the browser and never reach the page; only the desktop app gets them. */
export const IS_DESKTOP = typeof window !== "undefined" && window.cavemanDesktop !== undefined;
/** Opens the side panel's launcher: ⌘P (Settings > Keyboard can change it). ⌘T is the window's new tab. */
export const launchChord = (): string => chord("app.openFile");

/** Keys a Mac draws as a glyph: "mod+enter" reads ⌘↵ there, Ctrl+Enter elsewhere. */
const MAC_ORDER = ["⌃", "⌥", "⇧", "⌘"];
const MAC_KEYS: Readonly<Record<string, string>> = { enter: "↵", up: "↑", down: "↓", left: "←", right: "→", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", backspace: "⌫", escape: "Esc" };

/** "mod+shift+t" -> "⌘⇧T" on a Mac, "Ctrl+Shift+T" elsewhere. */
export function formatChord(chord: string, mac: boolean = IS_MAC): string {
  const parts = chord.endsWith("++") ? [...chord.slice(0, -2).split("+").filter(Boolean), "+"] : chord.split("+");
  const key = parts.pop()!;
  const name = (mac ? MAC_KEYS[key] : undefined) ?? (key === "`" ? "`" : key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1));
  const mods = parts.map((m) => (mac ? { mod: "⌘", meta: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" } : { mod: "Ctrl", meta: "Win", ctrl: "Ctrl", alt: "Alt", shift: "Shift" })[m] ?? m);
  // A Mac's menus order them ⌃⌥⇧⌘ whatever order the chord names them in.
  if (mac) mods.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  return mac ? [...mods, name].join("") : [...mods, name].join("+");
}

/**
 * Keys a Mac shows here as written ("⌘↩"), formatChord's form of `chord` elsewhere ("Ctrl+Enter"): for text that
 * writes its keys out, so a Mac reads exactly what it did.
 */
export const keysText = (mac: string, chord: string): string => (IS_MAC ? mac : formatChord(chord, false));

/** "mod+shift+t" -> "Meta+Shift+T" on a Mac, "Control+Shift+T" elsewhere: the aria-keyshortcuts form, never the ⌘ glyphs. */
export function ariaChord(chord: string, mac: boolean = IS_MAC): string {
  if (chord === "?") return "?";
  const parts = chord.endsWith("++") ? [...chord.slice(0, -2).split("+").filter(Boolean), "+"] : chord.split("+");
  const key = parts.pop()!;
  const names: Readonly<Record<string, string>> = { mod: mac ? "Meta" : "Control", meta: "Meta", ctrl: "Control", alt: "Alt", shift: "Shift" };
  return [...parts.map((m) => names[m] ?? m), key === "space" ? "Space" : key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1)].join("+");
}

const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
  ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", space: "Space",
};

/** True when the event is exactly this chord ("mod" is ⌘ on a Mac, Ctrl elsewhere; "?" is the ? key however it is typed). */
export function matchesChord(e: KeyboardEvent, chord: string, mac: boolean = IS_MAC): boolean {
  if (chord === "?") return e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey;
  // Off the Mac, AltGr arrives as Ctrl+Alt and types characters ("~", "[" and "]" on German and Spanish layouts):
  // never a chord.
  if (!mac && e.ctrlKey && e.altKey && e.getModifierState?.("AltGraph")) return false;
  const parts = chord.split("+");
  // "mod++": the key is "+".
  const key = chord.endsWith("++") ? (parts.splice(-2), "+") : parts.pop()!;
  const want = new Set(parts.map((m) => (m === "mod" ? (mac ? "meta" : "ctrl") : m)));
  if (e.metaKey !== want.has("meta") || e.ctrlKey !== want.has("ctrl") || e.altKey !== want.has("alt") || e.shiftKey !== want.has("shift")) return false;
  // `code` survives Alt and Shift changing `key` ("mod+alt+b" gives "∫" on a Mac, "mod+shift+\\" gives "|").
  if (key.length === 1 && /[a-z0-9]/i.test(key)) return e.code === (/\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`);
  const code = PUNCTUATION_CODES[key];
  return code !== undefined ? e.code === code : e.key.toLowerCase() === key.toLowerCase();
}

/** Typing contexts swallow single-key and editing shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.closest(".xterm") !== null);
}

/** The 40px row under the tab strip that holds a surface's controls. */
export function SurfaceBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex h-10 shrink-0 items-center gap-1 border-b border-border px-2", className)}>{children}</div>;
}

/** Buttons that belong together (back, forward, reload) in one quiet pill. */
export function BarGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex items-center rounded-lg bg-secondary/60 p-0.5", className)}>{children}</div>;
}

export interface BarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** The action's name: the tooltip and the accessible label. */
  readonly label: string;
  readonly chord?: string;
  /** A toggle that is on. */
  readonly pressed?: boolean;
  readonly size?: "sm" | "md";
}

/** A 28px (24px small) icon button with a tooltip naming the action and its keys. */
export const BarButton = forwardRef<HTMLButtonElement, BarButtonProps>(function BarButton({ label, chord, pressed, size = "md", className, children, ...rest }, ref) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
          className={cn(
            "grid shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 ease-snap",
            "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
            "[&_svg]:size-4 [&_svg]:shrink-0",
            size === "md" ? "size-7 max-md:size-9" : "size-6",
            pressed && "bg-accent text-foreground",
            className,
          )}
          {...rest}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        {label}
        {chord ? <span className="text-muted-foreground">{formatChord(chord)}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
});

/**
 * The one small section title, over a group of rows, a card or a rail's facts ("Tools", "Paused", "Details"): 12px,
 * regular, muted grey, sentence case, with a count after it in the subtle grey. The side panels, Review, Plugins and
 * Automations all use it; only Settings' cards keep their 14px title. The caller sets the inset.
 */
export function SectionHeader({ children, count, as: Heading = "h3", className }: { children: ReactNode; count?: number; as?: "h2" | "h3" | "h4"; className?: string }) {
  return (
    <Heading className={cn("flex items-center gap-1.5 px-1 pb-2 text-xs font-normal text-muted-foreground", className)}>
      {children}
      {count !== undefined ? <span className="tabular-nums text-[hsl(var(--subtle-foreground))]">{count}</span> : null}
    </Heading>
  );
}

/**
 * The panel and list empty state (compact panel empty, monoPanelParts.tsx): an optional 16px Hugeicon at 55% ink,
 * a 13px title, one quieter line on what will appear here and how, and an action under it (QuietButton). Centred in
 * its box with room around it; it arrives (fades in) when a read lands on nothing or fails. An error keeps the same
 * shape: the title says what failed, the line what to do. A whole page with nothing uses EmptyState instead.
 */
export function SurfaceEmpty({ icon, title, children, action, className }: { icon?: IconSvgElement; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center", arriveMotion, className)}>
      {icon ? <Icon icon={icon} className="mb-3 size-4 text-foreground/55" /> : null}
      <p className="max-w-[300px] text-balance text-[13px] font-medium leading-5 text-foreground/85">{title}</p>
      {children ? <div className="mt-1 max-w-[300px] text-balance text-[12.5px] leading-[18px] text-[hsl(var(--subtle-foreground))]">{children}</div> : null}
      {action ? <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** A quiet secondary button for empty states and banners. */
export function QuietButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2.5 text-[12.5px] font-medium text-foreground outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5",
        className,
      )}
      {...rest}
    />
  );
}
