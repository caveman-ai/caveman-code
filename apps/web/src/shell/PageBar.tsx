// The bar over a page of the sidebar's own (Review, Plugins, Automations): one 44px band with the page's sidebar icon
// and its name, as the Chief's bar, so moving between them changes the words and nothing else.
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import type { ReactNode } from "react";
import { SidebarMenuButton } from "./SidebarToggle.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/** A page's name in its bar: 14px at 500, the chat header's size. Links standing in for it (Automations, Agents) use it too. */
export const pageTitle = "text-[14px] font-medium";

/**
 * The phone's menu button, the page's sidebar icon (the same `icon` its NavRow shows), its name, then what the page puts
 * after it. `title` is left out when the children name the page themselves.
 */
export function PageBar({ icon, title, children, className }: { icon: PixelIconName; title?: string; children?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex h-11 shrink-0 items-center gap-2.5 pl-4 pr-3", className)}>
      <SidebarMenuButton />
      <Glyph name={icon} className="text-muted-foreground" />
      {title ? <h1 className={cn("shrink-0", pageTitle)}>{title}</h1> : null}
      {children}
    </header>
  );
}
