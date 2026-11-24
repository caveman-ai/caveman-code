import { cn } from "@caveman-app/ui/lib/cn";
import type { ReactNode } from "react";
import { IS_DESKTOP } from "../panels/chrome.tsx";

/**
 * The desktop app's title bar (apps/desktop hides the native one): a 40px band
 * that drags the window and clears the macOS traffic lights at its left. Its
 * buttons and links still click. Nothing in a browser.
 */
export function TitleBar({ className, children }: { className?: string; children?: ReactNode }) {
  if (!IS_DESKTOP) return null;
  return <div className={cn("title-bar flex h-10 shrink-0 items-center", className)}>{children}</div>;
}

/**
 * Above an inset panel (its frame has `.panel-frame`): the 8px that drag the window, or on Windows the whole 40px
 * band, where the window's minimize, maximize and close buttons sit (html[data-wco], styles.css).
 */
export function PanelTitleBar() {
  if (!IS_DESKTOP) return null;
  return <div className="title-bar panel-title-bar absolute inset-x-0 top-0 h-2" />;
}
