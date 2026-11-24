// What a browser window shows for a page the person's Mac answers (the Chief, Plugins, Automations) while it has no
// computer behind it: the page's own bar, then where the thing is and the one step that brings it here (founder
// 2026-11-12: with those rows hidden and nothing said, the web "feels like stuff just doesn't work"). After Caveman
// Cloud's first-run empty states (its EmptyHero): what the page is for, where it sits in the chain that feeds it, and
// the next action first. In our own look: the page-level empty state (STYLE.md section 4).
import { Button } from "@caveman-app/ui/components/button";
import { Icon, ArrowRight01Icon } from "@caveman-app/ui/icons/huge";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import { arriveMotion } from "@caveman-app/ui/motion";
import type { ReactNode } from "react";
import { emptyLine, emptyTitle, MascotOnFloor } from "../components/EmptyState.tsx";
import { useWebWindow, type WebWindowValue } from "../state/runtime.tsx";
import { DOWNLOAD_URL, macNext, type MacHere, type MacNext } from "../state/sync/web-window.ts";
import { PageBar } from "./PageBar.tsx";

export type MacPage = "chief" | "plugins" | "automations";

const PAGES: Record<
  MacPage,
  { readonly icon: PixelIconName; readonly name: string; readonly title: string }
> = {
  chief: { icon: "chief", name: "Chief", title: "Your Chief is on your Mac" },
  plugins: { icon: "spaces", name: "Plugins", title: "Your plugins are on your Mac" },
  automations: {
    icon: "automations",
    name: "Automations",
    title: "Your automations are on your Mac",
  },
};

/** The page of the sidebar a path opens that only a computer answers; null for every page a browser window draws itself. */
export function macPageOf(pathname: string): MacPage | null {
  const section = pathname.split("/")[1];
  return section === "chief" || section === "plugins" || section === "automations" ? section : null;
}

export function NeedsMac({ page }: { page: MacPage }) {
  const web = useWebWindow();
  if (!web) return null;
  const { icon, name } = PAGES[page];
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <PageBar icon={icon} title={name} />
      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 pb-14">
        <MacStep page={page} web={web} />
      </div>
    </div>
  );
}

/**
 * Where the page's thing is and the one step that brings it to this browser. Also the Chief's own page in a window
 * that uses a Cloud computer (routes/Chief.tsx): no Chief is made there, so it waits on the Mac the same way.
 */
export function MacStep({
  page,
  web,
}: {
  page: MacPage;
  web: Pick<WebWindowValue, "mac" | "usePlace">;
}) {
  const { name, title } = PAGES[page];
  const next = macNext(web.mac);
  return (
    <div className={cn("flex flex-col items-center text-center", arriveMotion)}>
      <MascotOnFloor
        pose={web.mac.kind === "waiting" || web.mac.kind === "ask" ? "idle" : "sleeping"}
        scale={2}
      />
      <h2 className={cn("mt-4", emptyTitle)}>{title}</h2>
      {next ? <p className={cn("mt-1", emptyLine)}>{next.line}</p> : null}
      <Chain mac={web.mac} page={name} />
      <NextAction next={next} web={web} />
    </div>
  );
}

/** The step's button, where this browser can take it. */
export function NextAction({
  next,
  web,
  size = "sm",
}: {
  next: MacNext | null;
  web: Pick<WebWindowValue, "usePlace">;
  size?: "sm" | "default";
}): ReactNode {
  const action = next?.action;
  if (!action) return null;
  return (
    <div className="mt-4">
      {action.kind === "download" ? (
        <Button asChild size={size}>
          <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
            {action.label}
          </a>
        </Button>
      ) : (
        // oxlint-disable-next-line react/hooks -- usePlace is the window's own method, not a React hook.
        <Button type="button" size={size} onClick={() => web.usePlace(action.place)}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** Where the page sits: the Mac that feeds it, as it stands now, then the page. */
function Chain({ mac, page }: { mac: MacHere; page: string }) {
  const chip =
    "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[12px] leading-none";
  const missing = mac.kind === "none" || mac.kind === "asleep";
  const state =
    mac.kind === "none"
      ? "not set up yet"
      : mac.kind === "asleep"
        ? "not on line"
        : mac.kind === "waiting"
          ? "asking you"
          : mac.kind === "refused"
            ? "did not allow this browser"
            : "on line";
  return (
    <div role="group" aria-label="Where this comes from" className="mt-4 flex items-center gap-1.5">
      <span
        title={state[0]!.toUpperCase() + state.slice(1)}
        className={cn(
          chip,
          "text-muted-foreground",
          missing ? "border-dashed border-border" : "border-border",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            missing
              ? "border border-dashed border-muted-foreground"
              : mac.kind === "waiting"
                ? "animate-pulse bg-warning motion-reduce:animate-none"
                : mac.kind === "refused"
                  ? "bg-destructive"
                  : "bg-success",
          )}
        />
        {mac.kind === "none" ? "Your Mac" : mac.name}
        <span className="sr-only">, {state}</span>
      </span>
      <Icon icon={ArrowRight01Icon} className="size-3 text-[hsl(var(--subtle-foreground))]" />
      <span aria-current="page" className={cn(chip, "border-foreground/25 text-foreground")}>
        {page}
      </span>
    </div>
  );
}
