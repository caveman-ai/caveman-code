// Recommended: the head of the Caveman marketplace as a row of large cards above its tiles (GitHub Copilot's
// Editor's picks). Each card is a raised tile (styles.css `.pick-card`): an ASCII dither in the plugin's brand colour
// around its logo (dither.ts), its name over two lines on what it does, and the Install key with its category beside it.
// Three across, scrolled a page at a time by the arrows; the picks keep their place when one is installed.
import { Button } from "@caveman-app/ui/components/button";
import {
  Icon,
  Add01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Tick02Icon,
} from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import { ConnectMark } from "../../components/ConnectMark.tsx";
import type { PluginSummary } from "./api.ts";
import { subtitle } from "./filter.ts";
import { pluginPath } from "./installed.ts";
import { ditherField } from "./dither.ts";
import { displayName, whiteOn } from "./model.ts";
import { PluginLogo } from "./PluginLogo.tsx";

/** How many of the catalog's plugins, in its order, are picks: three pages of three. */
export const PICKS = 9;

const GAP = 16;
/** Room inside the scroller for the cards' edges and hover lift, which its overflow would otherwise clip. */
const PAD = 12;

export function Recommended({
  plugins,
  busy,
  where,
  onInstall,
}: {
  plugins: ReadonlyArray<PluginSummary>;
  busy: (p: PluginSummary) => boolean;
  where: string | undefined;
  onInstall: (p: PluginSummary) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    setEnds({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }, []);
  // The row mounts once the marketplace has loaded: measured, and re-measured as it resizes, from then on.
  const scroller = useCallback(
    (el: HTMLDivElement | null) => {
      row.current = el;
      if (!el) return;
      measure();
      const seen = new ResizeObserver(measure);
      seen.observe(el);
      return () => seen.disconnect();
    },
    [measure],
  );
  const page = (dir: 1 | -1) => {
    const el = row.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({
      left: dir * (el.clientWidth - 2 * PAD + GAP),
      behavior: reduce ? "auto" : "smooth",
    });
  };

  if (plugins.length === 0) return null;
  return (
    <section aria-label="Recommended" className="pt-6">
      <div className="flex items-end gap-3 pb-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-medium leading-6 text-foreground">Recommended</h2>
          <p className="text-[13.5px] leading-5 text-muted-foreground">
            Good first plugins for your agents.
          </p>
        </div>
        {ends.start && ends.end ? null : (
          <span className="flex shrink-0 items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Previous"
              disabled={ends.start}
              onClick={() => page(-1)}
            >
              <Icon icon={ArrowLeft01Icon} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Next"
              disabled={ends.end}
              onClick={() => page(1)}
            >
              <Icon icon={ArrowRight01Icon} />
            </Button>
          </span>
        )}
      </div>
      <div
        ref={scroller}
        onScroll={measure}
        className="-mx-3 -mb-3 -mt-3 grid snap-x snap-mandatory scroll-px-3 grid-flow-col overflow-x-auto px-3 pb-3 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ gap: GAP, gridAutoColumns: `max(280px, calc((100% - ${2 * GAP}px) / 3))` }}
      >
        {plugins.map((p) => (
          <Pick key={p.id} plugin={p} busy={busy(p)} where={where} onInstall={() => onInstall(p)} />
        ))}
      </div>
    </section>
  );
}

/** The banner's dither: wider than any card, centred on it, so the logo sits in its hole at every width. */
const COLS = 110;
const ROWS = 21;
/** The logo (64px, eight lines) and a line and a half around it. */
const HOLE = 5.5;

/** One pick: the banner, the name and what it does, and Install (or where it stands once here). The card opens it. */
function Pick({
  plugin: p,
  busy,
  where,
  onInstall,
}: {
  plugin: PluginSummary;
  busy: boolean;
  where: string | undefined;
  onInstall: () => void;
}) {
  const name = displayName(p);
  const { brand_color, brand_color_dark, category } = p.interface;
  const field = useMemo(() => ditherField(p.id, COLS, ROWS, HOLE), [p.id]);
  // The ink in each theme: the brand colour, darkened where it is too light for the light theme (Hugging Face's
  // yellow) and lightened where it is too dark for the dark one (Notion's black), unless the manifest gives a variant.
  const brand = brand_color ?? "hsl(var(--muted-foreground))";
  const deep = brand_color === undefined || whiteOn(brand_color);
  const ink = {
    "--pick": deep ? brand : `color-mix(in oklab, ${brand} 60%, black)`,
    "--pick-dark": brand_color_dark ?? (deep ? `color-mix(in oklab, ${brand} 45%, white)` : brand),
  } as CSSProperties;
  return (
    <article className="pick-card group relative flex min-w-0 snap-start flex-col overflow-hidden rounded-2xl">
      <div
        style={ink}
        className="relative grid h-[168px] place-items-center overflow-hidden border-b border-foreground/[0.06] bg-[color-mix(in_srgb,var(--pick)_6%,transparent)] dark:bg-[color-mix(in_srgb,var(--pick-dark)_5%,transparent)]"
      >
        <pre
          aria-hidden
          className="pick-dither pointer-events-none absolute left-1/2 top-0 m-0 -translate-x-1/2 select-none font-mono text-[8px] leading-[8px] text-[var(--pick)] dark:text-[var(--pick-dark)]"
        >
          {field}
        </pre>
        <PluginLogo plugin={p} size="lg" className="pick-logo relative size-16 rounded-[18px]" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-4 pt-4">
        <Link
          to={`${pluginPath(p.id)}?in=browse`}
          className="truncate text-[15px] font-medium leading-6 text-foreground outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          {name}
        </Link>
        <p className="mt-1 line-clamp-2 min-h-10 text-[13.5px] leading-5 text-muted-foreground">
          {p.description ?? subtitle(p)}
        </p>
        <div className="mt-4 flex h-8 items-center gap-3">
          {p.required ? (
            <span
              className="relative z-10 text-[13px] text-muted-foreground"
              title="Your team requires it"
            >
              Required
            </span>
          ) : p.installed ? (
            <span className="relative z-10 flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Icon icon={Tick02Icon} className="size-4" />
              Installed
            </span>
          ) : (
            <button
              type="button"
              data-tone="card"
              aria-disabled={busy || undefined}
              aria-label={`Install ${name}${where ? ` for ${where}` : ""}`}
              title={where ? `Install for ${where}` : undefined}
              onClick={busy ? undefined : onInstall}
              className={cn(
                "composer-key relative z-10 flex h-8 items-center gap-1.5 rounded-[10px] pl-2.5 pr-3.5 text-[13px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
                busy && "text-muted-foreground",
              )}
            >
              {busy ? (
                <ConnectMark state="waiting" />
              ) : (
                <Icon icon={Add01Icon} className="size-4" />
              )}
              Install
            </button>
          )}
          {category ? (
            <span className="ml-auto truncate text-[12px] text-[hsl(var(--subtle-foreground))]">
              {category}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}
