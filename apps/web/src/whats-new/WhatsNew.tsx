// What's new: the release notes in releases/ (notes.ts), bundled into the
// client. Opens once after an update with every release since this device last
// looked; ⌘K, Settings > General and Help > What's New open it any time, over
// whatever is open (OPEN_EVENT; the desktop's Help menu dispatches it too, and
// takes /whats-new only while the window is still loading).
import { Button } from "@caveman-app/ui/components/button";
import * as Dialog from "@radix-ui/react-dialog";
import { clickOrigin } from "@caveman-app/ui/components/dialog";
import { cn } from "@caveman-app/ui/lib/cn";
import { Markdown } from "@caveman-app/ui/markdown/Markdown";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import { modalMotion, overlayMotion } from "@caveman-app/ui/motion";
import { Icon, ArrowUpRight01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { EmptyState } from "../components/EmptyState.tsx";
import { parseRelease, shownReleases, unseenReleases, type Release } from "./notes.ts";

const SEEN_KEY = "caveman.whatsNewSeen";
// apps/desktop/src/main.ts openWhatsNew dispatches the same name.
const OPEN_EVENT = "caveman:whats-new";
/** Let the app paint and settle before the notes come up after an update. */
const AUTO_OPEN_DELAY_MS = 1_200;

/** Opens What's new from anywhere (⌘K's row, Settings). */
export const showWhatsNew = () => window.dispatchEvent(new Event(OPEN_EVENT));

// A file that fails to parse is skipped here; notes.test.ts fails CI on it first.
const ALL: Release[] = Object.entries(import.meta.glob<string>("../../../../releases/*.md", { query: "?raw", import: "default", eager: true })).flatMap(([path, source]) => {
  if (path.endsWith("/README.md")) return [];
  try {
    return [parseRelease(path, source)];
  } catch (error) {
    console.error(error);
    return [];
  }
});

const formatDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** This app's version on the desktop; null in a browser; undefined while asking. */
function useAppVersion(): string | null | undefined {
  const [version, setVersion] = useState<string | null | undefined>(window.cavemanDesktop?.updates ? undefined : null);
  useEffect(() => {
    const updates = window.cavemanDesktop?.updates;
    if (!updates) return;
    updates.state().then(
      (s) => setVersion(s?.version ?? null),
      () => setVersion(null),
    );
  }, []);
  return version;
}

export function WhatsNew() {
  const appVersion = useAppVersion();
  const shown = useMemo(() => (appVersion === undefined ? [] : shownReleases(ALL, appVersion, import.meta.env.DEV)), [appVersion]);
  const [open, setOpen] = useState(false);
  // The versions that were new when it opened: they keep their dot until it closes.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [at, setAt] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  const show = (newest: ReadonlyArray<Release>) => {
    setFresh(new Set(newest.map((r) => r.version)));
    setAt(newest[0]?.version ?? shown[0]?.version ?? null);
    setOpen(true);
  };
  const showRef = useRef(show);
  showRef.current = show;
  const unseen = () => unseenReleases(shown, localStorage.getItem(SEEN_KEY));

  // After an update: open once with what is new. A first launch had no last time.
  useEffect(() => {
    if (appVersion === undefined) return;
    if (localStorage.getItem(SEEN_KEY) === null) {
      localStorage.setItem(SEEN_KEY, shown[0]?.version ?? "0.0.0");
      return;
    }
    if (!unseenReleases(shown, localStorage.getItem(SEEN_KEY)).length) return;
    // Ask again when it fires: ⌘K may have opened and closed it meanwhile.
    const timer = setTimeout(() => {
      const newest = unseenReleases(shown, localStorage.getItem(SEEN_KEY));
      if (newest.length) showRef.current(newest);
    }, AUTO_OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [appVersion, shown]);

  useEffect(() => {
    const onOpen = () => showRef.current(unseenReleases(shown, localStorage.getItem(SEEN_KEY)));
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [shown]);

  // /whats-new (Help > What's New while the window loads, or a caveman-code:// link) lands on the Chief with this flag.
  useEffect(() => {
    if (!(location.state as { whatsNew?: boolean } | null)?.whatsNew || appVersion === undefined) return;
    showRef.current(unseen());
    navigate(location.pathname, { replace: true, state: null });
  }, [location, appVersion]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) return;
    if (shown[0]) localStorage.setItem(SEEN_KEY, shown[0].version);
  };

  const release = shown.find((r) => r.version === at) ?? shown[0];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={`fixed inset-0 z-50 bg-black/60 ${overlayMotion}`} />
        <Dialog.Content
          ref={clickOrigin}
          // Focus the dialog, not its first button: no ring on a rail row nobody reached by keyboard.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
          className={`dashboard-scope fixed inset-0 z-50 m-auto flex h-[min(640px,calc(100dvh-4rem))] w-[min(880px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-overlay outline-none ${modalMotion}`}
        >
          {release ? (
            <>
              <ReleaseRail releases={shown} fresh={fresh} at={release.version} onPick={setAt} />
              <ReleaseView key={release.version} release={release} fresh={fresh.has(release.version)} onDone={() => onOpenChange(false)} />
            </>
          ) : (
            <NothingYet onDone={() => onOpenChange(false)} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ReleaseRail({ releases, fresh, at, onPick }: { releases: ReadonlyArray<Release>; fresh: ReadonlySet<string>; at: string; onPick: (version: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = releases.findIndex((r) => r.version === at) + (e.key === "ArrowDown" ? 1 : -1);
    const next = releases[Math.max(0, Math.min(releases.length - 1, i))]!;
    onPick(next.version);
    list.current?.querySelector<HTMLElement>(`[data-version="${CSS.escape(next.version)}"]`)?.focus();
  };
  return (
    <nav aria-label="Releases" className="flex w-[216px] shrink-0 flex-col border-r border-border bg-background/40">
      <div className="px-4 pb-3 pt-5">
        <Dialog.Title className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground">What's new</Dialog.Title>
        <Dialog.Description className="mt-2 text-[12px] leading-snug text-muted-foreground">
          {fresh.size ? `${fresh.size === 1 ? "One update" : `${fresh.size} updates`} since you last looked` : "Every release, newest first"}
        </Dialog.Description>
      </div>
      <div ref={list} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-3 [mask-image:linear-gradient(to_bottom,#000_calc(100%-24px),transparent)]">
        {releases.map((r) => {
          const active = r.version === at;
          const isNew = fresh.has(r.version);
          return (
            <button
              key={r.version}
              type="button"
              data-version={r.version}
              aria-current={active ? "true" : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => onPick(r.version)}
              className={cn(
                "group flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors duration-75 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                active && "bg-accent hover:bg-accent",
              )}
            >
              <span className="flex items-center gap-2">
                <span className={cn("font-mono text-[13px] tabular-nums", active || isNew ? "text-foreground" : "text-muted-foreground")}>{r.version}</span>
                {isNew ? <span aria-label="new" className="size-1.5 rounded-full bg-foreground" /> : null}
                <span className="ml-auto text-[12px] text-[hsl(var(--subtle-foreground))]">{formatDate(r.date)}</span>
              </span>
              <span className={cn("truncate text-[12px]", active ? "text-muted-foreground" : "text-[hsl(var(--subtle-foreground))]")}>{r.title}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

const enter = "animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-snap fill-mode-both motion-reduce:animate-none";

function ReleaseView({ release, fresh, onDone }: { release: Release; fresh: boolean; onDone: () => void }) {
  const links = [
    release.blog ? { href: release.blog, label: "Read the post" } : null,
    release.x ? { href: release.x, label: "On X" } : null,
  ].filter((l) => l !== null);
  return (
    <article className="flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,#000_calc(100%-32px),transparent)]">
        <header className="relative overflow-hidden border-b border-border px-8 pb-6 pt-8">
          <div className="relative flex items-end gap-5">
            {/* The mascot stands on a patch of dithered floor; nothing else sits on it. */}
            <div className="relative shrink-0">
              <div aria-hidden className="px-dither-50 absolute -inset-x-2 -bottom-1 h-2 text-[hsl(var(--subtle-foreground))]" />
              <Mascot pose="done" scale={3} className="relative" />
            </div>
            <div className={cn("min-w-0 pb-1", enter)}>
              <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className="font-mono tabular-nums text-foreground">v{release.version}</span>
                <span aria-hidden>·</span>
                <time dateTime={release.date}>{formatDate(release.date)}</time>
                {fresh ? <span className="rounded-full border border-border px-1.5 text-[11px] leading-[18px] text-foreground">New</span> : null}
                {release.draft ? <span className="rounded-full border border-dashed border-border px-1.5 text-[11px] leading-[18px]">Draft, development only</span> : null}
              </p>
              <h2 className="mt-1.5 text-[20px] font-semibold leading-tight tracking-[-0.01em] text-foreground">{release.title}</h2>
            </div>
          </div>
        </header>
        <div className="px-8 pb-10 pt-6">
          {release.intro ? (
            <div className={enter} style={{ animationDelay: "40ms" }}>
              <Markdown source={release.intro} className="text-muted-foreground" />
            </div>
          ) : null}
          <ol className={cn("flex flex-col", release.intro && "mt-6")}>
            {release.sections.map((s, i) => (
              <li
                key={s.heading}
                className={cn("grid grid-cols-[32px_1fr] gap-x-2 border-t border-border/70 py-5 first:border-t-0 first:pt-0", enter)}
                style={{ animationDelay: `${80 + i * 45}ms` }}
              >
                <span aria-hidden className="pt-px font-mono text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <h3 className="text-[14px] font-medium leading-snug text-foreground">{s.heading}</h3>
                  <Markdown source={s.body} className="mt-1.5 text-[13px] leading-[1.6] text-muted-foreground" />
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <footer className="flex h-14 shrink-0 items-center gap-2 border-t border-border px-5">
        {links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-[13px] text-foreground transition-colors duration-75 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {l.label}
            <Icon icon={ArrowUpRight01Icon} className="size-4 text-muted-foreground transition-transform duration-150 ease-snap group-hover:-translate-y-px group-hover:translate-x-px" />
          </a>
        ))}
        <Button
          type="button"
          onClick={onDone}
          className="ml-auto"
        >
          Got it
        </Button>
      </footer>
    </article>
  );
}

/** No release notes in this build yet: the page-level empty state, with a way out for a pointer as well as Escape. */
export function NothingYet({ onDone }: { onDone: () => void }) {
  return (
    <div className="grid flex-1 place-items-center px-8">
      <EmptyState
        pose="sleeping"
        title="Nothing yet"
        titleAs={Dialog.Title}
        lineAs={Dialog.Description}
        action={
          <Button type="button" size="sm" variant="secondary" onClick={onDone}>
            Close
          </Button>
        }
      >
        What changed in each release shows up here after an update.
      </EmptyState>
    </div>
  );
}
