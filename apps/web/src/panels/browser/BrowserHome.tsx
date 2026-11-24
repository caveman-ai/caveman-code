// ), apps/web/src/components/preview/PreviewEmptyState.tsx,
// PreviewLocalServerCard.tsx, PreviewRecentUrlCard.tsx, PreviewUnreachable.tsx
// and apps/web/src/components/ui/discovery-list.tsx @ ab3a3cd1.
// What a browser tab shows with no page (the computer's local servers and the
// recently used pages), and when a page can't be reached.

import { Button } from "@caveman-app/ui/components/button";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, Cancel01Icon, RadioTowerIcon, Globe02Icon, BrowserIcon } from "@caveman-app/ui/icons/huge";
import { useState, type ReactNode } from "react";
import { QuietButton, SectionHeader, SurfaceEmpty } from "../chrome.tsx";
import { useLocalServers } from "../NewTabSurface.tsx";
import { splitUrl } from "./BrowserBar.tsx";
import { forget, recents as readRecents, type Recent } from "./recents.ts";

const listRow = "flex h-12 w-full items-center gap-3 px-3 text-left outline-none transition-colors duration-75 hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** Two lines (a server: its process over its address), or one (a page: its title beside its address). */
function Row({ icon, title, description, onOpen, onRemove, first }: { icon: ReactNode; title: string; description: string; onOpen: () => void; onRemove?: () => void; first: boolean }) {
  return (
    <div className={cn("group relative", !first && "border-t border-border")}>
      <button type="button" onClick={onOpen} className={cn(listRow, onRemove && "h-10 pr-11")}>
        {icon}
        <span className={cn("min-w-0", onRemove && "flex flex-1 items-baseline gap-2")}>
          {/* The label keeps its width; the address truncates first. */}
          <span className={cn("truncate text-[13px] text-foreground", onRemove ? "max-w-full shrink-0" : "block")}>{title}</span>
          {description ? <span className={cn("min-w-0 truncate font-mono text-[12px] text-muted-foreground", !onRemove && "block")}>{description}</span> : null}
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${title} from recently used`}
          onClick={onRemove}
          className="absolute right-2.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity duration-75 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        >
          <Icon icon={Cancel01Icon} className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** The empty tab: live local servers first, then the pages this workspace visited. */
export function BrowserHome({ workspaceId, onOpen, hint }: { workspaceId: string; onOpen: (url: string) => void; hint: string }) {
  const servers = useLocalServers(workspaceId);
  const [recents, setRecents] = useState<ReadonlyArray<Recent>>(() => readRecents(workspaceId));

  if (servers.length === 0 && recents.length === 0) return <SurfaceEmpty icon={Globe02Icon} title="No page yet">{hint}</SurfaceEmpty>;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[560px] space-y-8 px-6 pb-10 pt-8">
        {servers.length > 0 ? (
          <section>
            <SectionHeader>Local servers</SectionHeader>
            <div className="overflow-hidden rounded-lg border border-border">
              {servers.map((s, i) => (
                <Row key={s.url} first={i === 0} icon={<Icon icon={RadioTowerIcon} className="size-4 shrink-0 text-muted-foreground" />} title={s.name} description={splitUrl(s.url).join("")} onOpen={() => onOpen(s.url)} />
              ))}
            </div>
          </section>
        ) : null}
        {recents.length > 0 ? (
          <section>
            <SectionHeader>Recently used</SectionHeader>
            <div className="overflow-hidden rounded-lg border border-border">
              {recents.map((r, i) => {
                const [host, rest] = splitUrl(r.url);
                return (
                  <Row
                    key={r.url}
                    first={i === 0}
                    icon={<Icon icon={BrowserIcon} className="size-4 text-muted-foreground" />}
                    title={r.title || host}
                    description={r.title ? host + rest : rest}
                    onOpen={() => onOpen(r.url)}
                    onRemove={() => setRecents(forget(workspaceId, r.url))}
                  />
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export type Unreached = "refused" | "timeout" | "not_web";

/** Chromium's "This site can't be reached", on the deck. An address that isn't http(s) gets one quiet line instead: reloading can't help it. */
export function Unreachable({ url, error, why, onReload }: { url: string; error: string; why: Unreached; onReload: () => void }) {
  const [details, setDetails] = useState(false);
  const [host] = splitUrl(url);
  if (why === "not_web") return <SurfaceEmpty title="This address can't open here">Only http and https pages open in this browser.</SurfaceEmpty>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[460px] flex-col px-8 pb-10 pt-[14vh]">
        <ErrorIcon className="mb-5 size-10 text-[hsl(var(--subtle-foreground))]" />
        <h2 className="text-[15px] font-semibold text-foreground">This site can't be reached</h2>
        <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
          <span className="text-foreground">{host}</span> {why === "timeout" ? "took too long to respond." : "refused to connect."}
        </p>
        {details ? (
          <div className="mt-5 rounded-lg border border-border bg-secondary/40 p-3 text-[13px] leading-5">
            <p className="text-foreground">Try:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              <li>Checking that the dev server is running</li>
              <li>Checking the port in the address</li>
              <li>Opening it in your own browser</li>
            </ul>
            <p className="mt-2.5 break-all font-mono text-[11px] text-[hsl(var(--subtle-foreground))]">{error}</p>
          </div>
        ) : null}
        <div className="mt-6 flex items-center gap-2">
          <QuietButton aria-expanded={details} onClick={() => setDetails((d) => !d)}>
            {details ? "Hide details" : "Details"}
          </QuietButton>
          <div className="flex-1" />
          <Button size="sm" onClick={onReload}>
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}

function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className={className}>
      <path d="M16 12 L48 12 L48 52 L16 52 Z" />
      <path d="M22 22 L42 22 M22 30 L36 30 M22 38 L40 38" strokeLinecap="round" />
      <path d="M52 8 L12 56" strokeLinecap="round" />
    </svg>
  );
}
