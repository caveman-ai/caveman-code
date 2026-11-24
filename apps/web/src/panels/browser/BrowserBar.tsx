// ), apps/web/src/components/preview/PreviewChromeRow.tsx @ ab3a3cd1.
// The browser's chrome: back, forward and reload in one pill, the address
// field (the page's host and path at rest, the whole URL selected on focus,
// Esc reverts), the surface's own buttons, the More menu, and a 2px progress
// line on the bar's bottom edge while a page loads.

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { cn } from "@caveman-app/ui/lib/cn";
import { ease } from "@caveman-app/ui/motion";
import { Icon, ArrowLeft02Icon, ArrowRight02Icon, Copy01Icon, EraserIcon, LinkSquare02Icon, MoreHorizontalIcon, Refresh01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ariaChord, BarButton, BarGroup, formatChord, isComposing, SurfaceBar } from "../chrome.tsx";
import { asUrl } from "../launcher.tsx";

export interface BrowserBarProps {
  /** The page's URL; empty when there is none. */
  readonly url: string;
  readonly loading: boolean;
  readonly canBack: boolean;
  readonly canForward: boolean;
  /** Nothing to drive: the field and the buttons rest. */
  readonly disabled?: boolean;
  readonly placeholder?: string;
  /** Bumping it focuses the field and selects the URL (⌘L). */
  readonly focusNonce: number;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onReload: (hard: boolean) => void;
  readonly onSubmit: (url: string) => void;
  /** The page can open in this device's browser (http(s) only; anything else rests disabled). */
  readonly external: boolean;
  /** The surface's buttons between the field and More (screenshot, take over). */
  readonly actions?: ReactNode;
  /** The desktop's browser: clear its cookies and site data (the shell asks first). */
  readonly onClearData?: (() => void) | undefined;
}

export const CHORDS = { back: "mod+[", forward: "mod+]", reload: "mod+r", hardReload: "mod+shift+r", address: "mod+l" } as const;

/** "https://example.com/a?b" -> ["example.com", "/a?b"]; the trailing "/" of a bare host is dropped. */
export function splitUrl(url: string): [host: string, rest: string] {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return [url, ""];
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
    return [u.host, rest];
  } catch {
    return [url, ""];
  }
}

/** An http(s) address: the only kind this browser opens, or hands to the system browser. */
export function isWeb(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function openExternal(url: string): void {
  if (isWeb(url)) window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * A tab for a page whose address arrives after a call (a checkout, Caveman Cloud's GitHub page): in a browser it opens
 * now, inside the click, since one opened after an await is blocked (the hosted client's calls go through the relay);
 * `go` points it there, or closes it when there is nothing to open. The desktop opens links in the system browser,
 * where nothing is blocked, so it waits for the address.
 */
export function openSoon(): (url: string | null | undefined) => void {
  const tab = window.cavemanDesktop ? null : window.open("about:blank", "_blank");
  return (url) => {
    if (!tab) return url ? openExternal(url) : undefined;
    if (!url || !isWeb(url)) return tab.close();
    tab.opener = null;
    tab.location.href = url;
  };
}

/** The bar's pills are round like its address field (Codex's browser chrome). */
export const PILL = "rounded-full";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function BrowserBar({ url, loading, canBack, canForward, disabled, placeholder = "Enter a URL", focusNonce, onBack, onForward, onReload, onSubmit, external, actions, onClearData }: BrowserBarProps) {
  const input = useRef<HTMLInputElement>(null);
  const progress = useRef<HTMLDivElement>(null);
  const justFocused = useRef(false);
  const [draft, setDraft] = useState(url);
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (focusNonce > 0) input.current?.focus();
  }, [focusNonce]);

  // Transform and opacity only: creep toward 90% while loading, then run out and fade.
  useEffect(() => {
    const el = progress.current;
    if (!el || !loading) return;
    if (reducedMotion()) {
      el.style.transform = "scaleX(0.9)";
      el.style.opacity = "1";
      return () => {
        el.style.transform = "";
        el.style.opacity = "";
      };
    }
    const creep = el.animate(
      [
        { transform: "scaleX(0.04)", opacity: 1 },
        { transform: "scaleX(0.9)", opacity: 1 },
      ],
      { duration: 5300, easing: ease.drawer, fill: "forwards" },
    );
    return () => {
      const from = getComputedStyle(el).transform;
      creep.cancel();
      el.animate(
        [
          { transform: from, opacity: 1 },
          { transform: "scaleX(1)", opacity: 1, offset: 0.45 },
          { transform: "scaleX(1)", opacity: 0 },
        ],
        { duration: 420, easing: "ease-out" },
      );
    };
  }, [loading]);

  const submit = () => {
    // Any dotted host is an address here: there is no search to fall back to.
    const next = asUrl(draft, true);
    if (!next) return setInvalid(true);
    onSubmit(next);
    input.current?.blur();
  };

  const [host, rest] = splitUrl(url);
  const canOpen = external && isWeb(url);
  return (
    <SurfaceBar className="relative gap-1.5">
      <BarGroup className={PILL}>
        <BarButton size="sm" className="rounded-full" label="Back" chord={CHORDS.back} disabled={disabled || !canBack} onClick={onBack}>
          <Icon icon={ArrowLeft02Icon} />
        </BarButton>
        <BarButton size="sm" className="rounded-full" label="Forward" chord={CHORDS.forward} disabled={disabled || !canForward} onClick={onForward}>
          <Icon icon={ArrowRight02Icon} />
        </BarButton>
        <BarButton size="sm" className="rounded-full" label={loading ? "Loading…" : "Reload"} chord={CHORDS.reload} disabled={disabled || !url} onClick={() => onReload(false)}>
          <Icon icon={Refresh01Icon} className={cn(loading && "animate-spin [animation-duration:900ms] motion-reduce:animate-none")} />
        </BarButton>
      </BarGroup>

      <div
        className={cn(
          "group/address relative flex h-7 min-w-0 flex-1 items-center rounded-full bg-secondary/50 transition-colors duration-75",
          !disabled && "hover:bg-secondary/80",
          focused && "bg-secondary ring-1 ring-inset ring-input",
          invalid && "ring-1 ring-inset ring-destructive/60",
        )}
      >
        <input
          ref={input}
          value={focused ? draft : url}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label="Address"
          aria-invalid={invalid || undefined}
          aria-keyshortcuts={ariaChord(CHORDS.address)}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(false);
          }}
          onFocus={(e) => {
            setDraft(url);
            setFocused(true);
            justFocused.current = true;
            e.currentTarget.select();
          }}
          // The click that focused the field would otherwise drop the selection on mouseup.
          onMouseUp={(e) => {
            if (!justFocused.current) return;
            justFocused.current = false;
            e.preventDefault();
          }}
          onBlur={() => {
            setFocused(false);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDraft(url);
              input.current?.blur();
            }
          }}
          className={cn(
            "h-full w-full min-w-0 rounded-full bg-transparent px-3.5 text-[13px] outline-none placeholder:text-muted-foreground disabled:cursor-default",
            focused ? "text-left text-foreground" : cn("text-center", url && "text-transparent"),
          )}
        />
        {!focused && url ? (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-8 right-8 flex items-center justify-center text-[13px]">
            <span className="truncate">
              <span className="text-foreground">{host}</span>
              <span className="text-muted-foreground">{rest}</span>
            </span>
          </span>
        ) : null}
        {canOpen && !focused ? (
          // Revealed on hover so a resting address reads as plain text.
          <span className="absolute right-0.5 flex opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover/address:opacity-100">
            <BarButton size="sm" label="Open in system browser" className="rounded-full" onClick={() => openExternal(url)}>
              <Icon icon={LinkSquare02Icon} className="!size-3.5" />
            </BarButton>
          </span>
        ) : null}
      </div>

      {actions}

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <BarButton label="More" className="rounded-full" disabled={disabled}>
            <Icon icon={MoreHorizontalIcon} />
          </BarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          <DropdownMenuItem disabled={!url} onSelect={() => onReload(true)}>
            <Icon icon={Refresh01Icon} className="text-muted-foreground" />
            Hard reload
            <span className="ml-auto pl-4 text-xs text-muted-foreground">{formatChord(CHORDS.hardReload)}</span>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!url} onSelect={() => void navigator.clipboard?.writeText(url).catch(() => undefined)}>
            <Icon icon={Copy01Icon} className="text-muted-foreground" />
            Copy URL
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canOpen} onSelect={() => openExternal(url)}>
            <Icon icon={LinkSquare02Icon} className="text-muted-foreground" />
            Open in system browser
          </DropdownMenuItem>
          {onClearData ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onClearData}>
                <Icon icon={EraserIcon} className="text-muted-foreground" />
                Clear cookies and site data…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <div ref={progress} aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 origin-left rounded-r-full bg-foreground/70 opacity-0" />
    </SurfaceBar>
  );
}
