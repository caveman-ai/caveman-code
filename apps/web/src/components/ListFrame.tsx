// The list-and-page frame Automations and Agents share: the list column on the left, the open thing on the right, so
// picking another one never leaves the page. (Plugins is one full-width list; its pages use Page, Bar and Pane from
// here, without the column.) One 44px row runs across the top as a single nav bar, split at
// the column's edge: the sections over the list, the open thing's breadcrumb and verbs over the page. A phone shows one
// at a time: the list, or what it opened, whose breadcrumb leads back. Pages are built from these:
//
//   <ListFrame sections current listing column>  the column and the page
//     <Page bar={<Bar crumbs actions />} rail>     the page: its bar, its scroll, and the details rail at the right
//       <Pane>{…}</Pane>                           one centred column inside the scroll
//     <ListAdd> <ListGroup> <ListRow>              a list: + New, quiet groups, one line each
//     <Column search add>{<ColumnCard>}            a filtered list: a field and +, then cards
import { SearchField } from "@caveman-app/ui/components/input";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import {
  Icon,
  Add01Icon,
  ArrowRight01Icon,
  PanelRightIcon,
  type IconSvgElement,
} from "@caveman-app/ui/icons/huge";
import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { BarButton, SectionHeader, SurfaceEmpty } from "../panels/chrome.tsx";
import { PageBar, pageTitle } from "../shell/PageBar.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/** The height of the nav bar both halves share. */
const BAR = "h-11 shrink-0";

/**
 * The column and the page. `sections` name the column's views (Automations · Agents, Installed · Browse); `listing`
 * says only the list is open, which a phone shows instead of the page.
 */
export function ListFrame({
  label,
  icon,
  sections,
  current,
  listing,
  column,
  children,
}: {
  label: string;
  /** The page's sidebar icon, as its NavRow shows it (PageBar). */
  icon: PixelIconName;
  sections: ReadonlyArray<{ readonly id: string; readonly label: string; readonly to: string }>;
  current: string;
  listing: boolean;
  column: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={cn(
          "flex w-[272px] shrink-0 flex-col border-r border-border/70 max-[1180px]:w-[240px] max-md:w-full max-md:border-r-0",
          !listing && "max-md:hidden",
        )}
      >
        <PageBar icon={icon}>
          <nav aria-label={label} className="flex items-center gap-3">
            {sections.map((s) => (
              <Link
                key={s.id}
                to={s.to}
                aria-current={s.id === current ? "page" : undefined}
                className={cn(
                  pageTitle,
                  "rounded-sm outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-ring",
                  s.id === current
                    ? "text-foreground"
                    : "text-[hsl(var(--subtle-foreground))] hover:text-foreground",
                )}
              >
                {s.label}
              </Link>
            ))}
          </nav>
        </PageBar>
        {column}
      </aside>
      <div className={cn("flex min-w-0 flex-1 flex-col", listing && "max-md:hidden")}>
        {children}
      </div>
    </div>
  );
}

/**
 * j/k and the arrows walk a list's rows (`[data-row]`). On the window, so they work as the page opens; the arrows only
 * from inside the list.
 */
export function useRowWalk(listRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (
        target.closest(
          "input, textarea, select, [contenteditable], [role=menu], [role=dialog], [role=listbox], [role=tablist]",
        )
      )
        return;
      const step =
        e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
      if (!step || (e.key.startsWith("Arrow") && !listRef.current?.contains(target))) return;
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
      if (rows.length === 0) return;
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const row = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + step))];
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest" });
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listRef]);
}

/** Under this width the rail folds away and the page keeps the room; the bar's ▣ brings it back over the page. */
const RAIL_FROM = 820;

/**
 * The right side: its bar, the scroll, and (on an automation) the details rail. Another one opened starts at its top;
 * a tab or filter in the query keeps its place.
 */
export function Page({
  bar,
  rail,
  children,
}: {
  bar: ReactNode;
  rail?: ReactNode;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const scroller = useRef<HTMLElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  const [peek, setPeek] = useState(false);
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [pathname]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setWide(el.clientWidth >= RAIL_FROM);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <div className={cn(BAR, "flex items-center gap-1 pl-5 pr-3")}>
        {bar}
        {rail && !wide ? (
          <BarButton
            label={peek ? "Hide details" : "Show details"}
            pressed={peek}
            onClick={() => setPeek((p) => !p)}
          >
            <Icon icon={PanelRightIcon} />
          </BarButton>
        ) : null}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <main
          ref={scroller}
          data-frame-scroller
          className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          {children}
        </main>
        {rail && (wide || peek) ? (
          <aside
            aria-label="Details"
            className={cn(
              "w-[288px] shrink-0 overflow-y-auto border-l border-border/70 [scrollbar-gutter:stable]",
              !wide &&
                "absolute inset-y-0 right-0 z-20 bg-background shadow-overlay animate-in fade-in-0 slide-in-from-right-2 duration-150 ease-snap motion-reduce:animate-none",
            )}
          >
            {rail}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** The bar: where you are on the left ("Automations › morning-status"), the verbs on the right. */
export function Bar({
  crumbs,
  actions,
}: {
  crumbs: ReadonlyArray<{ label: ReactNode; to?: string | undefined }>;
  actions?: ReactNode;
}) {
  return (
    <>
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span
              key={i}
              className={cn("flex items-center gap-1.5", last ? "min-w-0" : "shrink-0")}
            >
              {i > 0 ? (
                <Icon
                  icon={ArrowRight01Icon}
                  aria-hidden
                  className="size-3 shrink-0 text-[hsl(var(--subtle-foreground))]"
                  strokeWidth={2}
                />
              ) : null}
              {c.to && !last ? (
                <Link
                  to={c.to}
                  className="truncate rounded-sm text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn(
                    "truncate",
                    last ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {c.label}
                </span>
              )}
            </span>
          );
        })}
      </nav>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </>
  );
}

/** The right side's column: centred, 760px at most, where a thread or a form reads best. */
export function Pane({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[760px] px-10 pb-24 pt-8 max-[1180px]:px-7 max-md:px-4 max-md:pt-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A pane's heading: its title, a line under it, and its verbs at the right. */
export function PaneHeader({
  title,
  lead,
  actions,
}: {
  title: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-[20px] font-semibold leading-8 tracking-[-0.01em] text-foreground">
          {title}
        </h1>
        {lead ? (
          <p className="mt-0.5 text-[13.5px] leading-[21px] text-muted-foreground">{lead}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2 pt-0.5">{actions}</div> : null}
    </header>
  );
}

// ------------------------------------------------------------ the details rail

/** A group of the rail: a quiet heading, then its rows. */
export function RailSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("px-5 pt-6", className)}>
      <SectionHeader as="h2" className="px-0 pb-1.5">
        {title}
      </SectionHeader>
      {children}
    </section>
  );
}

/** One fact: what it is at the left, its value at the right, on one line. */
export function RailRow({
  label,
  children,
  title,
}: {
  label: string;
  children: ReactNode;
  title?: string | undefined;
}) {
  return (
    <div
      className="flex min-h-8 items-center justify-between gap-4 py-1 text-[13px] leading-5"
      title={title}
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1.5 text-right text-foreground">
        {children}
      </span>
    </div>
  );
}

// ------------------------------------------------------------ the Automations list

/** "+ New automation": the first row of the list, the sidebar's own row. */
export function ListAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13.5px] text-foreground outline-none transition-colors duration-75 hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="grid w-4 place-items-center">
        <Icon icon={Add01Icon} className="size-4 text-muted-foreground" />
      </span>
      {label}
    </button>
  );
}

/** A quiet group in the list ("Active", "Paused"), its rows under it; `count` sits beside its title. */
export function ListGroup({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | undefined;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="pt-4">
      <SectionHeader as="h2" {...(count === undefined ? {} : { count })} className="px-2 pb-1">
        {title}
      </SectionHeader>
      {children}
    </section>
  );
}

/**
 * One automation in the list: its state as one glyph, its name, and one quiet line under it. `selected`: the one open
 * on the right.
 */
export function ListRow({
  to,
  selected,
  glyph,
  title,
  line,
  onPointerEnter,
  onFocus,
}: {
  to: string;
  selected: boolean;
  glyph: ReactNode;
  title: ReactNode;
  line: ReactNode;
  onPointerEnter?: () => void;
  onFocus?: () => void;
}) {
  return (
    <Link
      to={to}
      data-row
      aria-current={selected ? "page" : undefined}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      className={cn(
        "mb-px flex items-start gap-2.5 rounded-md px-2 py-[7px] outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
      )}
    >
      <span className="grid h-5 w-4 shrink-0 place-items-center">{glyph}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] leading-5 text-foreground">{title}</span>
        <span className="block truncate text-[12.5px] leading-[18px] text-muted-foreground">
          {line}
        </span>
      </span>
    </Link>
  );
}

// ------------------------------------------------------------ the Agents list

/** The list column: a filter field with its tools and +, then the cards, scrolling under the field. */
export const Column = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQuery: (q: string) => void;
    placeholder: string;
    /** + : what it makes ("New agent"), and where it goes. */
    add: { label: string; to: string };
    /** Icon tools beside the field (a filter menu). */
    tools?: ReactNode;
    label: string;
    busy?: boolean;
    listRef?: React.Ref<HTMLElement>;
    children: ReactNode;
  }
>(function Column(
  { query, onQuery, placeholder, add, tools, label, busy, listRef, children },
  ref,
) {
  const navigate = useNavigate();
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 pl-2 pr-2">
        <SearchField
          ref={ref}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (onQuery(""), e.currentTarget.blur())}
          placeholder={placeholder}
          aria-label={placeholder}
          containerClassName="min-w-0 flex-1"
          className="border-transparent bg-transparent hover:border-transparent focus-visible:border-transparent"
        />
        {tools}
        <BarButton label={add.label} onClick={() => navigate(add.to)}>
          <Icon icon={Add01Icon} />
        </BarButton>
      </div>
      <nav
        ref={listRef}
        aria-label={label}
        aria-busy={busy}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2 [scrollbar-gutter:stable]"
      >
        {children}
      </nav>
    </>
  );
});

/**
 * One card in the column. The whole card opens it (a link stretched over it, named by its title and described by the
 * lines above and below); `control` (a switch) and anything with its own tooltip sit above the link. `selected`: the
 * one open on the right.
 */
export function ColumnCard({
  to,
  selected,
  top,
  title,
  bottom,
  control,
  onPointerEnter,
  onFocus,
}: {
  to: string;
  selected: boolean;
  top: ReactNode;
  title: ReactNode;
  bottom: ReactNode;
  control?: ReactNode;
  onPointerEnter?: () => void;
  onFocus?: () => void;
}) {
  const id = useId();
  return (
    <div
      onPointerEnter={onPointerEnter}
      className={cn(
        "group relative mb-0.5 rounded-md px-2.5 py-2 transition-colors duration-75",
        selected ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.05]",
      )}
    >
      <span className="flex min-h-5 items-center gap-2 text-[12px] text-muted-foreground">
        <span id={`${id}-top`} className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          {top}
        </span>
        {control ? <span className="relative z-10 -my-0.5 flex shrink-0">{control}</span> : null}
      </span>
      <Link
        to={to}
        data-row
        aria-describedby={`${id}-top ${id}-bottom`}
        aria-current={selected ? "page" : undefined}
        onFocus={onFocus}
        className="mt-0.5 block truncate text-[13px] font-semibold leading-5 text-foreground outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring"
      >
        {title}
      </Link>
      <span
        id={`${id}-bottom`}
        className="mt-0.5 flex min-w-0 items-center gap-3 text-[12px] text-muted-foreground"
      >
        {bottom}
      </span>
    </div>
  );
}

/** Rows' shapes while the list is read. */
export function ColumnSkeleton({ n = 4 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} aria-hidden className="mb-px flex items-start gap-2.5 px-2 py-[9px]">
          <span className="mt-0.5 size-3.5 shrink-0 rounded-full bg-foreground/[0.06]" />
          <span className="min-w-0 flex-1">
            <span
              className="block h-3 rounded bg-foreground/[0.08]"
              style={{ width: `${68 - i * 9}%` }}
            />
            <span className="mt-2 block h-2.5 w-1/2 rounded bg-foreground/[0.05]" />
          </span>
        </div>
      ))}
    </>
  );
}

/** Nothing in the column yet: the panel-level empty state (SurfaceEmpty), with the column's icon and one line on where to start. */
export function ColumnEmpty({
  icon,
  title,
  children,
  action,
}: {
  icon?: IconSvgElement;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <SurfaceEmpty
      {...(icon ? { icon } : {})}
      title={title}
      action={action}
      className="flex-none pt-16"
    >
      {children}
    </SurfaceEmpty>
  );
}

/** The middle of an empty page: its mark, one line on what goes here, and the ways to start. */
export function PageEmpty({
  icon,
  title,
  children,
  actions,
}: {
  icon: PixelIconName;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-8 pb-16 text-center">
      <Glyph name={icon} scale={2} className="mb-4 text-muted-foreground" />
      <h1 className="text-[15px] font-semibold text-foreground">{title}</h1>
      <p className="mt-1.5 max-w-[340px] text-balance text-[13.5px] leading-[21px] text-muted-foreground">
        {children}
      </p>
      {actions ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
