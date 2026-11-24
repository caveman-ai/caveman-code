// A markdown file as a document to read: the side panel's reader for specs,
// plans and READMEs. The same pipeline and elements as the chat (Markdown),
// set at reading scale (markdown.css, `.md-doc`) in a centred column; YAML
// front matter as a small properties block; and the outline as a rail of
// ticks at the left edge that follows the reader (Claude's document view is
// the reference): the section in view is lit, and hovering or focusing the
// rail opens the full outline to jump.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Markdown, markdownOutline, setTaskChecked, type MarkdownProps, type OutlineEntry } from "./Markdown";

export interface MarkdownDocumentProps extends Pick<MarkdownProps, "onLink" | "inlineCode" | "image" | "onRun"> {
  readonly source: string;
  /** The file's new text when the reader ticks a task-list box; without it the boxes are read-only. */
  readonly onChange?: ((next: string) => void) | undefined;
  readonly className?: string | undefined;
}

export function MarkdownDocument({ source, onLink, inlineCode, image, onRun, onChange, className }: MarkdownDocumentProps) {
  const { meta, body } = useMemo(() => frontMatter(source), [source]);
  const scroller = useRef<HTMLDivElement | null>(null);
  return (
    <div className={cn("relative flex min-h-0 flex-1 [&:has(>[data-document-outline])>div>article]:pl-12", className)}>
      <div ref={scroller} data-slot="document" className="min-h-0 flex-1 overflow-y-auto [&_[id^=md-]]:scroll-mt-6">
        {/* The rail sits in the left margin: the column keeps clear of it however narrow the panel. */}
        <article className="mx-auto w-full max-w-[760px] pb-24 pl-8 pt-8 pr-8">
          {meta.length ? <Properties entries={meta} /> : null}
          <Markdown
            source={body}
            cacheOutline
            onLink={onLink}
            inlineCode={inlineCode}
            image={image}
            onRun={onRun}
            // The front matter stays as written: only the body's box changes.
            onToggleTask={onChange ? (i, checked) => {
              const next = setTaskChecked(body, i, checked);
              if (next !== null) onChange(source.slice(0, source.length - body.length) + next);
            } : undefined}
            className="md-doc"
          />
        </article>
      </div>
      <DocumentOutline source={body} scroller={scroller} />
    </div>
  );
}

function DocumentOutline({ source, scroller }: { source: string; scroller: React.RefObject<HTMLDivElement | null> }) {
  // Render after the body: its heading pass has already populated the bounded outline cache. The
  // reader still parses independently if that entry was too large to keep or is not available yet.
  const outline = useMemo(() => markdownOutline(source), [source]);
  const active = useActiveHeading(scroller, outline);
  const jump = (id: string) =>
    scroller.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  return outline.length > 1 ? <OutlineRail outline={outline} active={active} onJump={jump} /> : null;
}

// ── Front matter ──────────────────────────────────────────────────────────

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Leading YAML front matter, split off: top-level `key: value` pairs, a
 * nested block or list kept as written. Not YAML in full; enough to show it
 * instead of a stray rule and a heading made of keys.
 */
export function frontMatter(source: string): { meta: Array<[string, string]>; body: string } {
  const m = FENCE.exec(source);
  if (!m) return { meta: [], body: source };
  const meta: Array<[string, string]> = [];
  for (const line of m[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (pair) meta.push([pair[1]!, unquote(pair[2]!.trim())]);
    else if (meta.length && line.trim()) {
      const last = meta[meta.length - 1]!;
      const item = line.trim().replace(/^-\s+/, "");
      last[1] = last[1] ? `${last[1]}${/^\s*-\s/.test(line) ? ", " : " "}${unquote(item)}` : unquote(item);
    }
  }
  return { meta, body: source.slice(m[0].length) };
}

function unquote(v: string): string {
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v.replace(/^[>|][-+]?$/, "");
}

function Properties({ entries }: { entries: ReadonlyArray<[string, string]> }) {
  return (
    <dl className="mb-8 grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border px-4 py-3 text-[13px]">
      {entries.map(([k, v], i) => (
        <div key={`${k}:${i}`} className="contents">
          <dt className="font-mono text-[12px] leading-5 text-muted-foreground">{k}</dt>
          <dd className="min-w-0 leading-5 text-foreground [overflow-wrap:anywhere]">{v || <span className="text-muted-foreground">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Outline ───────────────────────────────────────────────────────────────

/** The heading the reader is in: the last one at or above a line just under the top of the view. */
function useActiveHeading(scroller: React.RefObject<HTMLDivElement | null>, outline: ReadonlyArray<OutlineEntry>): string | null {
  const [active, setActive] = useState<string | null>(outline[0]?.id ?? null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !outline.length) return;
    // Cache only headings reached while measuring this mounted revision. Opening near the top
    // stays cheap, and later scrolls measure positions without searching the DOM again.
    const headings = new Map<string, Element | null>();
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = el.getBoundingClientRect().top + 72;
      let current = outline[0]!.id;
      for (const h of outline) {
        let node = headings.get(h.id);
        if (node === undefined) {
          node = el.querySelector(`#${CSS.escape(h.id)}`);
          headings.set(h.id, node);
        }
        if (!node) continue;
        if (node.getBoundingClientRect().top > line) break;
        current = h.id;
      }
      // At the very end the last sections may never reach the line: the bottom lights the last.
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2 && el.scrollTop > 0) current = outline[outline.length - 1]!.id;
      setActive(current);
    };
    const onScroll = () => (frame ||= requestAnimationFrame(measure));
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [scroller, outline]);
  return active;
}

/**
 * Ticks, one per heading, longer for higher levels; the one in view lit.
 * Hover, focus or a click opens the outline over the page: every heading,
 * the current one marked, a click jumps. Escape or leaving closes it.
 */
function OutlineRail({ outline, active, onJump }: { outline: ReadonlyArray<OutlineEntry>; active: string | null; onJump: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const top = Math.min(...outline.map((h) => h.depth));
  const show = () => {
    if (leave.current) clearTimeout(leave.current);
    setOpen(true);
  };
  const hide = () => {
    if (leave.current) clearTimeout(leave.current);
    leave.current = setTimeout(() => setOpen(false), 160);
  };
  useEffect(() => () => void (leave.current && clearTimeout(leave.current)), []);
  // Opened from the keyboard: focus the current entry, so arrows start where the reader is.
  const openFromKeyboard = () => {
    setOpen(true);
    requestAnimationFrame(() => (list.current?.querySelector<HTMLButtonElement>("[aria-current=true]") ?? list.current?.querySelector<HTMLButtonElement>("button"))?.focus());
  };
  const indent = (h: OutlineEntry) => Math.min(h.depth - top, 3);
  // A long outline packs its ticks tighter, so the whole document fits the rail.
  const pitch = Math.max(3, Math.min(7, Math.floor(400 / outline.length)));
  const ticks: ReactNode = outline.map((h, i) => (
    <span key={`${h.id}:${i}`} className="flex shrink-0 items-center" style={{ height: pitch, paddingLeft: indent(h) * 3 }}>
      <span className={cn("h-[2px] rounded-full transition-colors duration-150", h.id === active ? "bg-foreground" : "bg-muted-foreground/35")} style={{ width: 16 - indent(h) * 3 }} />
    </span>
  ));
  return (
    <nav data-document-outline="" aria-label="Outline" className="absolute left-3 top-8 z-20" onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-label={`Outline, ${outline.length} sections`}
        onClick={() => (open ? setOpen(false) : openFromKeyboard())}
        className="flex max-h-[min(60vh,420px)] flex-col overflow-hidden rounded-md px-1.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {ticks}
      </button>
      {open ? (
        <div
          ref={list}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
            const i = rows.indexOf(document.activeElement as HTMLButtonElement);
            rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
            e.preventDefault();
          }}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== trigger.current && setOpen(false)}
          className="absolute -left-1 -top-1.5 w-[300px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-overlay animate-in fade-in-0 zoom-in-[0.98] duration-150 ease-snap"
        >
          <div className="max-h-[min(60vh,440px)] overflow-y-auto overscroll-contain">
            {outline.map((h, i) => (
              <button
                key={`${h.id}:${i}`}
                type="button"
                aria-current={h.id === active}
                onClick={(e: MouseEvent) => {
                  onJump(h.id);
                  if (e.detail === 0) setOpen(false); // from the keyboard: back to reading
                }}
                className={cn(
                  "group/row flex h-8 w-full items-center gap-2.5 rounded-md pr-2 text-left text-[13px] outline-none transition-colors duration-75 hover:bg-accent focus-visible:bg-accent",
                  h.id === active ? "bg-accent text-foreground" : indent(h) === 0 ? "text-foreground" : "text-muted-foreground hover:text-foreground focus-visible:text-foreground",
                )}
                style={{ paddingLeft: 8 + indent(h) * 12 }}
              >
                <span aria-hidden className={cn("h-[2px] shrink-0 rounded-full", h.id === active ? "bg-foreground" : "bg-muted-foreground/40")} style={{ width: 14 - indent(h) * 3 }} />
                <span className="truncate">{h.text}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </nav>
  );
}
