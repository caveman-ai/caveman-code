// The Guide: the pull request explained before its code. Overview and a before/after of the behaviour at the top,
// then numbered stops in reading order, each a short caveman-terse "what → why" on the left with only the code that
// carries it on the right. The one call a maintainer must make at a stop stands out; mechanical files fold into one
// skim line at the end. A rail of ticks at the left edge shows where you are and what you have read.
//
// A short change (Settings > Review, `review_short_lines`) gets no tour: the diff fits on a screen, so the guide is
// its TL;DR (above the tabs), the one call if it has one, the author's words, and the whole diff right here, from the
// first frame. Under a tour the author's words fold to one line (AuthorNote.tsx).
import type { PrDetail, PrGuide, PrGuideResult, PrGuideStop } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { Keycap } from "@caveman-app/ui/components/menu";
import { cn } from "@caveman-app/ui/lib/cn";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import { Icon, ArrowDown01Icon, ArrowRight01Icon, ArrowUpRight01Icon, CornerDownRightIcon, PreferenceHorizontalIcon } from "@caveman-app/ui/icons/huge";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { SectionHeader } from "../../panels/chrome.tsx";
import { KeptLimitLink } from "../../components/cloud/KeptLimitLink.tsx";
import type { DiffFile } from "../../panels/diff/parsePatch.ts";
import { rowAge } from "../../state/model.ts";
import { AuthorNote } from "./AuthorNote.tsx";
import { ExcerptView } from "./Excerpt.tsx";
import { PixelCheck } from "./PixelCheck.tsx";
import { isSkimStop, splitPath, type Passage } from "./model.ts";
import { GuideLines, Prose, Stat } from "./parts.tsx";
import { reveal } from "./scroll.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

const CALL_WORD: Record<NonNullable<PrGuideStop["attention"]>["kind"], string> = {
  tradeoff: "Trade-off",
  contract: "Contract",
  product: "Product call",
  risk: "Risk taken",
  accessibility: "Accessibility",
};

const pad = (n: number) => String(n).padStart(2, "0");

export interface GuideProps {
  readonly detail: PrDetail;
  readonly guide: PrGuideResult | undefined;
  readonly guideError: string | undefined;
  readonly files: ReadonlyMap<string, DiffFile>;
  readonly diffLoading: boolean;
  /** The person's read marks, by stop index, for the guide's head. */
  readonly read: ReadonlySet<number>;
  readonly onRead: (stop: number, read: boolean) => void;
  readonly onGenerate: () => void;
  /** Post the guide as a comment on the pull request, or rewrite the one this person posted. */
  readonly onPost: () => Promise<void>;
  readonly onOpenFile: (path: string, line?: number, side?: "new" | "old") => void;
  /** Starts an agent on a stop's question; a refusal shows under the stop's questions. */
  readonly onAsk: (passage: Passage, question: string) => Promise<unknown>;
  /** tldr: a short change, drawn as its call and `diff`; tour: the stops (review/model.ts guideDepth). */
  readonly depth: "tldr" | "tour";
  /** Changed lines of code and tests, and the short-change limit they are held to. */
  readonly lines: number;
  readonly limit: number;
  /** The whole diff, as Files draws it, for a short change. */
  readonly diff: ReactNode;
  /** Write the full tour for a short change; `tourAsked` once pressed, until the tour lands. */
  readonly onWriteTour: () => void;
  readonly tourAsked: boolean;
}

export function Guide(props: GuideProps) {
  if (props.depth === "tldr") return <Short {...props} />;
  const { detail, guide: result } = props;
  // A TL;DR alone (the chat's, on a long change) is not a tour: the tour is on its way.
  const guide = result?.guide && (result.guide.depth ?? "tour") === "tour" ? result.guide : null;
  const stale = Boolean(guide && result?.head_sha && guide.head_sha !== result.head_sha);
  return (
    <div className="pb-24">
      {guide ? (
        <>
          {stale ? <StaleLine guide={guide} running={Boolean(result?.running)} onGenerate={props.onGenerate} /> : null}
          <Tour {...props} tour={guide} />
        </>
      ) : (
        <Pending {...props} />
      )}
      <span className="sr-only" aria-live="polite">
        {result?.running ? "Writing the guide" : guide ? `Guide ready, ${guide.stops.length} stops` : ""}
      </span>
      {guide && result ? <WriterLine guide={guide} result={result} onGenerate={props.onGenerate} onPost={props.onPost} /> : null}
      {guide ? <AuthorNote pr={detail} mode="folded" className="mt-6 border-t border-border/60 pt-4" /> : null}
    </div>
  );
}

function Tour(props: GuideProps & { tour: PrGuide }) {
  const { tour: guide, detail } = props;
  const stops = guide.stops;
  const main = useMemo(() => stops.map((stop, i) => ({ stop, i })).filter(({ stop }) => !isSkimStop(stop)), [stops]);
  const skim = useMemo(() => stops.map((stop, i) => ({ stop, i })).filter(({ stop }) => isSkimStop(stop)), [stops]);
  const [current, setCurrent] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  // The stop in view: the last whose top passed a third of the way down the scroller.
  useEffect(() => {
    const el = root.current;
    const scroller = el?.closest<HTMLElement>("[data-review-scroller]");
    if (!el || !scroller) return;
    const update = () => {
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let at = 0;
      for (const node of el.querySelectorAll<HTMLElement>("[data-stop]")) if (node.getBoundingClientRect().top <= line) at = Number(node.dataset.stop);
      setCurrent(at);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [stops]);

  const jump = (i: number) => reveal(document.getElementById(`stop-${i}`));

  // j / k walk the stops, r marks the one in view read (and moves on).
  const keys = useRef({ current, read: props.read, onRead: props.onRead });
  keys.current = { current, read: props.read, onRead: props.onRead };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable], [role=dialog], [role=menu]")) return;
      if (!window.getSelection()?.isCollapsed) return;
      const { current: at, read, onRead } = keys.current;
      if (e.key === "j") jump(Math.min(stops.length - 1, at + 1));
      else if (e.key === "k") jump(Math.max(0, at - 1));
      else if (e.key === "r") onRead(at, !read.has(at));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stops.length]);

  return (
    <div ref={root} className="relative">
      <Rail stops={stops} current={current} read={props.read} onJump={jump} />
      <section className="grid gap-x-10 gap-y-5 pb-10 min-[1180px]:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        <div data-passage="the guide's overview">
          <h2 className="text-[15px] font-semibold text-foreground">What changes</h2>
          {guide.overview ? (
            <GuideLines text={guide.overview} className="mt-2 text-[14px] leading-[1.6] text-foreground/75" />
          ) : null}
          <ol className="mt-4 space-y-1">
            {main.map(({ stop, i }) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => jump(i)}
                  className="group flex w-full items-baseline gap-2.5 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className={cn("font-mono text-[11.5px] tabular-nums", props.read.has(i) ? "text-success" : "text-[hsl(var(--subtle-foreground))]")}>{pad(i + 1)}</span>
                  <span className="text-[13.5px] leading-5 text-foreground/85 underline-offset-2 group-hover:text-foreground group-hover:underline">{stop.title}</span>
                  {stop.attention ? <span className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-warning" title="Has a call for you" /> : null}
                </button>
              </li>
            ))}
            {skim.length > 0 ? (
              <li className="pl-[30px] text-[12.5px] text-muted-foreground">+ {skim.reduce((n, { stop }) => n + stop.files.length, 0)} files to skim</li>
            ) : null}
          </ol>
        </div>
        {guide.before_after && guide.before_after.rows.length > 0 ? (
          <BeforeAfter before={guide.before_after} detail={detail} onJump={(stop) => jump(stop - 1)} />
        ) : null}
      </section>

      {main.map(({ stop, i }) => (
        <Stop key={i} index={i} total={stops.length} stop={stop} {...props} />
      ))}

      {skim.length > 0 ? <Skim items={skim} {...props} /> : null}
      <Done read={props.read.size} total={stops.length} />
    </div>
  );
}

/** Ticks at the left edge, one per stop: the one in view bright and long, read ones green, a call amber. */
function Rail({ stops, current, read, onJump }: { stops: ReadonlyArray<PrGuideStop>; current: number; read: ReadonlySet<number>; onJump: (i: number) => void }) {
  if (stops.length < 2) return null;
  return (
    <nav aria-label="Stops" className="pointer-events-none absolute inset-y-0 -left-9 hidden w-6 min-[900px]:block">
      <div className="pointer-events-auto sticky top-[38%] flex flex-col gap-[7px]">
        {stops.map((stop, i) => (
          <button
            key={i}
            type="button"
            title={`${pad(i + 1)} ${stop.title}`}
            aria-label={`Stop ${i + 1}: ${stop.title}`}
            aria-current={i === current ? "step" : undefined}
            onClick={() => onJump(i)}
            className="group flex h-2 items-center outline-none"
          >
            <span
              className={cn(
                "block h-[2px] transition-[width,background-color] duration-200 ease-snap",
                i === current ? "w-4 bg-foreground" : "w-2.5 group-hover:w-4",
                i !== current && (read.has(i) ? "bg-success/80" : stop.attention ? "bg-warning/80" : "bg-muted-foreground/45 group-hover:bg-muted-foreground"),
              )}
            />
          </button>
        ))}
      </div>
    </nav>
  );
}

function BeforeAfter({ before, detail, onJump }: { before: NonNullable<PrGuide["before_after"]>; detail: PrDetail; onJump: (stop: number) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="self-start overflow-hidden rounded-xl border border-border bg-card/30" data-passage={`the before/after of “${before.title}”`}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-10 w-full items-center gap-2 border-b border-border/70 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <Icon icon={ArrowDown01Icon} className={cn("size-3.5 text-muted-foreground transition-transform duration-150", !open && "-rotate-90")} />
        <span className="text-[13.5px] font-medium text-foreground">Before / after</span>
        <Stat additions={detail.additions} deletions={detail.deletions} atLeast={detail.diff_stat_truncated === true} className="ml-auto" />
      </button>
      {open ? (
        <div className="px-3 pb-3 pt-2.5">
          <Prose text={before.title} className="block px-1 pb-2 text-[12.5px] text-muted-foreground" />
          <div className="font-mono text-[12.5px] leading-[22px]">
            {before.rows.map((row, i) => (
              <div
                key={i}
                className={cn(
                  "flex items-center gap-2 rounded-[3px] pr-1",
                  row.op === "+" && "bg-success/[0.09]",
                  row.op === "-" && "bg-destructive/[0.09]",
                )}
              >
                <span className={cn("w-4 shrink-0 select-none text-center", row.op === "+" ? "text-success" : row.op === "-" ? "text-destructive" : "")}>{row.op === "-" ? "−" : row.op.trim()}</span>
                <span className={cn("min-w-0 flex-1 truncate", row.op === "-" ? "text-muted-foreground" : "text-foreground/90")} style={{ paddingLeft: row.depth * 16 }} title={row.text}>
                  {row.text}
                </span>
                {row.stop ? (
                  <button type="button" onClick={() => onJump(row.stop!)} title={`Stop ${row.stop}`} className="shrink-0 rounded px-1 text-[11px] tabular-nums text-[hsl(var(--subtle-foreground))] outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    {pad(row.stop)}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Stop({ index, total, stop, files, diffLoading, read, onRead, onOpenFile, onAsk }: GuideProps & { index: number; total: number; stop: PrGuideStop }) {
  const where = `guide stop ${index + 1} “${stop.title}”`;
  const isRead = read.has(index);
  const [asking, setAsking] = useState(false);
  /** Why the last question's agent did not start, as it was thrown: a refusal at the kept-computer limit links past it. */
  const [error, setError] = useState<unknown>(null);
  const ask = async (question: string) => {
    if (asking) return;
    setAsking(true);
    setError(null);
    try {
      await onAsk({ where, quote: stop.summary }, question);
    } catch (e) {
      setError(e);
    } finally {
      setAsking(false);
    }
  };
  return (
    <article id={`stop-${index}`} data-stop={index} className="grid scroll-mt-4 gap-x-10 gap-y-4 border-t border-border/60 py-9 min-[1180px]:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
      <div className="self-start min-[1180px]:sticky min-[1180px]:top-5" data-passage={where}>
        <div className="flex h-6 items-center gap-3 text-[12px] text-muted-foreground">
          <span className="font-mono tabular-nums">
            {pad(index + 1)} / {pad(total)}
          </span>
          {isRead ? <span className="text-success">read</span> : null}
        </div>
        <h3 className={cn("mt-1.5 text-[17px] font-semibold leading-6 tracking-[-0.01em]", isRead ? "text-foreground/60" : "text-foreground")}>{stop.title}</h3>
        <GuideLines text={stop.summary} className="mt-2.5 text-[14px] leading-[1.6] text-foreground/75" />
        {stop.attention ? <CallBox attention={stop.attention} className="mt-5" /> : null}
        {stop.files.length > 0 ? <FileList files={stop.files} detail={files} onOpenFile={onOpenFile} /> : null}
        {stop.questions.length > 0 ? (
          <div className="mt-4 space-y-0.5">
            {stop.questions.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => void ask(q)}
                disabled={asking}
                title="Ask an agent"
                className="group flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-[13px] leading-5 text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={CornerDownRightIcon} className="mt-[3px] size-3.5 shrink-0" />
                <Prose text={q} className="flex-1" />
                <span className="shrink-0 text-[11.5px] opacity-0 transition-opacity duration-75 group-hover:opacity-100">Ask</span>
              </button>
            ))}
            {error !== null ? (
              <div role="alert" className="flex flex-col gap-1 px-1.5 pt-1 text-[12px]">
                <p className="text-destructive">{error instanceof Error ? error.message : String(error)}</p>
                <KeptLimitLink error={error} />
              </div>
            ) : null}
          </div>
        ) : null}
        <ReadButton read={isRead} last={index === total - 1} onToggle={() => onRead(index, !isRead)} />
      </div>
      <div className="min-w-0 space-y-3">
        {stop.excerpts.map((excerpt, i) => (
          <ExcerptView key={i} excerpt={excerpt} file={files.get(excerpt.path)} notes={stop.notes} loading={diffLoading} onOpenFile={onOpenFile} />
        ))}
      </div>
    </article>
  );
}

/** The one call a maintainer should make here: what kind of judgment, and the note. */
function CallBox({ attention, className }: { attention: NonNullable<PrGuideStop["attention"]>; className?: string }) {
  return (
    <div className={cn("flex gap-3 rounded-lg bg-warning/[0.08] px-3.5 py-3", className)}>
      <Glyph name="state-needs-input" className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-5 text-foreground">
          Your call <span className="font-normal text-muted-foreground">· {CALL_WORD[attention.kind]}</span>
        </p>
        <Prose text={attention.note} className="mt-1 block text-[13.5px] leading-[1.55] text-foreground/85" />
      </div>
    </div>
  );
}

/**
 * A short change: no stops, no rail, no read marks. Its call if it has one, one quiet line on why there is no tour
 * (with the way to ask for one), what the author wrote, held low, then the diff. The diff never waits on the TL;DR,
 * which lands above the tabs.
 */
function Short({ detail, guide: result, guideError, lines, limit, diff, onGenerate, onPost, onWriteTour, tourAsked }: GuideProps) {
  const guide = result?.guide ?? null;
  const running = Boolean(result?.running);
  const stale = Boolean(guide && result?.head_sha && guide.head_sha !== result.head_sha);
  const failed = !running ? (result?.failed ?? (guide ? undefined : guideError)) : undefined;
  return (
    <div className="pb-24">
      {stale ? <StaleLine guide={guide!} running={running} onGenerate={onGenerate} /> : null}
      {guide?.attention ? <CallBox attention={guide.attention} className="mb-5 max-w-[880px]" /> : null}
      <div className="mb-3 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
        <LinesMeter lines={lines} limit={limit} />
        <span>
          <span className="tabular-nums text-foreground/90">{lines}</span> {lines === 1 ? "line" : "lines"} of code and tests, so the diff is the guide
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={onWriteTour} disabled={running}>
            {tourAsked && running ? <span className="lucy-shimmer">Writing the tour…</span> : "Write the full tour"}
          </Button>
          <Button size="icon-sm" variant="secondary" asChild title="Review settings">
            <Link to="/settings/review" aria-label="Review settings">
              <Icon icon={PreferenceHorizontalIcon} className="size-3.5" />
            </Link>
          </Button>
        </span>
      </div>
      {failed ? (
        <p className="mb-3 flex items-center gap-3 rounded-lg bg-destructive/[0.06] px-3 py-2 text-[13px] text-destructive ring-1 ring-inset ring-destructive/20">
          <span className="min-w-0 flex-1">No TL;DR: {failed}</span>
          <Button size="sm" variant="secondary" onClick={onGenerate}>
            Try again
          </Button>
        </p>
      ) : null}
      <AuthorNote pr={detail} mode="brief" className="mb-6 mt-2" />
      {diff}
      {guide && result ? <WriterLine guide={guide} result={result} onGenerate={onGenerate} onPost={onPost} /> : null}
    </div>
  );
}

/** How much of the short-change limit this change uses: a hairline track, filled to its share. */
function LinesMeter({ lines, limit }: { lines: number; limit: number }) {
  return (
    <span
      role="meter"
      aria-label="Lines of the short-change limit"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={lines}
      aria-valuetext={`${lines} of ${limit} lines`}
      title={`${lines} of ${limit} lines: past ${limit}, a change gets the full tour`}
      className="relative h-1 w-14 overflow-hidden rounded-full bg-muted"
    >
      <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/70" style={{ width: `${Math.min(100, (lines / Math.max(1, limit)) * 100)}%` }} />
    </span>
  );
}

/**
 * The end of a stop: one big target that marks it read (the check draws itself) and moves on to the next stop.
 * Pressed again, it takes the mark back. R does the same for the stop in view.
 */
function ReadButton({ read, last, onToggle }: { read: boolean; last: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={read}
      onClick={onToggle}
      className={cn(
        "group mt-6 flex h-12 w-full items-center gap-3 rounded-xl border pl-2 pr-3 text-left outline-none transition-[background-color,border-color,color] duration-100",
        "focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px",
        read ? "border-success/35 bg-success/[0.08] text-success hover:bg-success/[0.12]" : "border-border bg-card/40 text-muted-foreground hover:border-foreground/25 hover:bg-accent hover:text-foreground",
      )}
    >
      <PixelCheck checked={read} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className={cn("text-[13.5px] font-semibold", read ? "text-success" : "text-foreground")}>{read ? "Read" : "Mark read"}</span>
        <span className="truncate text-[12px] text-muted-foreground">{read ? "Click to take it back" : last ? "Last stop" : "Then on to the next stop"}</span>
      </span>
      <Keycap className="bg-transparent">R</Keycap>
    </button>
  );
}

function FileList({ files, detail, onOpenFile }: { files: PrGuideStop["files"]; detail: ReadonlyMap<string, DiffFile>; onOpenFile: (path: string) => void }) {
  return (
    <ul className="mt-4 space-y-px">
      {files.map((f) => {
        const { dir, name } = splitPath(f.path);
        const d = detail.get(f.path);
        return (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => onOpenFile(f.path)}
              title={f.path}
              className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-75 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="shrink-0 font-mono text-[12.5px] text-foreground/90">{name}</span>
              <span className="min-w-0 truncate font-mono text-[11.5px] text-[hsl(var(--subtle-foreground))]">{f.note ? "" : dir}</span>
              {f.note ? <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{f.note}</span> : <span className="flex-1" />}
              {d ? <Stat additions={d.additions} deletions={d.deletions} /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Mechanical stops: one line each, opened on demand. */
function Skim({ items, files, onOpenFile, read, onRead }: GuideProps & { items: ReadonlyArray<{ stop: PrGuideStop; i: number }> }) {
  return (
    <section className="border-t border-border/60 py-6" aria-label="Skim">
      <SectionHeader className="px-0">Skim: checked, nothing to judge</SectionHeader>
      {items.map(({ stop, i }) => (
        <SkimRow key={i} index={i} stop={stop} files={files} onOpenFile={onOpenFile} isRead={read.has(i)} onRead={(v) => onRead(i, v)} />
      ))}
    </section>
  );
}

function SkimRow({ index, stop, files, onOpenFile, isRead, onRead }: { index: number; stop: PrGuideStop; files: ReadonlyMap<string, DiffFile>; onOpenFile: (path: string) => void; isRead: boolean; onRead: (v: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const adds = stop.files.reduce((n, f) => n + (files.get(f.path)?.additions ?? 0), 0);
  const dels = stop.files.reduce((n, f) => n + (files.get(f.path)?.deletions ?? 0), 0);
  return (
    <div id={`stop-${index}`} data-stop={index} className="scroll-mt-4" data-passage={`guide stop ${index + 1} “${stop.title}”`}>
      <div className="flex min-h-9 items-center gap-2 rounded-lg px-1.5 hover:bg-accent/40">
        <button
          type="button"
          role="checkbox"
          aria-checked={isRead}
          aria-label={`Mark “${stop.title}” read`}
          onClick={() => onRead(!isRead)}
          className="group -m-1 grid place-items-center rounded-md p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:translate-y-px"
        >
          <PixelCheck checked={isRead} scale={1} />
        </button>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Icon icon={ArrowRight01Icon} className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
          <span className={cn("min-w-0 truncate text-[13.5px]", isRead ? "text-muted-foreground" : "text-foreground")}>{stop.title}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground">{stop.files.length === 1 ? "1 file" : `${stop.files.length} files`}</span>
          <Stat additions={adds} deletions={dels} className="ml-auto" />
        </button>
      </div>
      {open ? (
        <div className="pb-3 pl-[46px] pr-2">
          <GuideLines text={stop.summary} className="text-[13px] leading-5 text-muted-foreground" />
          <FileList files={stop.files} detail={files} onOpenFile={onOpenFile} />
        </div>
      ) : null}
    </div>
  );
}

function Done({ read, total }: { read: number; total: number }) {
  if (total === 0) return null;
  const all = read >= total;
  return (
    <div className="flex items-center gap-3 border-t border-border/60 pt-8 text-[13px] text-muted-foreground">
      {all ? <Mascot pose="done" scale={2} /> : null}
      <span>{all ? "All stops read. Your call now: approve, ask, or send it back." : `${read} of ${total} stops read.`}</span>
      <span className="ml-auto hidden text-[12px] text-[hsl(var(--subtle-foreground))] min-[900px]:inline">j k stops · r read · select text to ask</span>
    </div>
  );
}

function StaleLine({ guide, running, onGenerate }: { guide: PrGuide; running: boolean; onGenerate: () => void }) {
  return (
    <div className="mb-6 flex items-center gap-3 rounded-lg bg-foreground/[0.04] px-3 py-2 text-[13px] text-muted-foreground ring-1 ring-inset ring-foreground/10">
      <span className="size-1.5 rounded-full bg-warning" aria-hidden />
      <span className="flex-1">
        Written for <span className="font-mono text-[12px] text-foreground/80">{guide.head_sha.slice(0, 7)}</span>; new commits since.
      </span>
      <Button size="sm" variant="secondary" onClick={onGenerate} disabled={running}>
        {running ? "Rewriting…" : "Rewrite guide"}
      </Button>
    </div>
  );
}

/** No guide yet: the run's state where the tour will be, and the author's own words and the files to read meanwhile. */
function Pending({ detail, guide, guideError, onGenerate, files, onOpenFile }: GuideProps) {
  const running = Boolean(guide?.running);
  const failed = guide?.failed;
  let status: ReactNode;
  if (guideError && !running)
    status = (
      <PendingLine pose="error" title="No guide yet" line={guideError}>
        {guide ? (
          <Button size="sm" variant="secondary" onClick={onGenerate}>
            Try again
          </Button>
        ) : null}
      </PendingLine>
    );
  else if (failed)
    status = (
      <PendingLine pose="error" title="Guide failed" line={failed}>
        <Button size="sm" variant="secondary" onClick={onGenerate}>
          Try again
        </Button>
      </PendingLine>
    );
  else
    status = (
      <PendingLine pose="working" title={running ? "Caveman is reading the change…" : "Starting the guide…"} line={`${detail.files.length > 0 ? `${detail.files.length} ${detail.files.length === 1 ? "file" : "files"}. ` : ""}Written once per push; a big change takes a minute or two.`} shimmer />
    );
  return (
    <div className="space-y-8">
      {status}
      <AuthorNote pr={detail} mode="open" />
      {detail.files.length > 0 ? (
        <section>
          <SectionHeader as="h2" className="px-0">
            Files
          </SectionHeader>
          <FileList files={detail.files.map((f) => ({ path: f.path }))} detail={files.size > 0 ? files : new Map(detail.files.map((f) => [f.path, { ...f, patch: "" }]))} onOpenFile={onOpenFile} />
        </section>
      ) : null}
    </div>
  );
}

function PendingLine({ pose, title, line, shimmer, children }: { pose: "working" | "error"; title: string; line: string; shimmer?: boolean; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-dashed border-border px-4 py-3.5">
      <Mascot pose={pose} scale={2} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-[14px] font-medium text-foreground", shimmer && "lucy-shimmer")}>{title}</p>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{line}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * Who wrote the guide (model and tier, or the chat that opened the pull request), when, for which head; Rewrite asks
 * for a fresh one (a model run), Settings goes to Settings > Review.
 */
function WriterLine({ guide, result, onGenerate, onPost }: { guide: PrGuide; result: PrGuideResult; onGenerate: () => void; onPost: () => Promise<void> }) {
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const running = Boolean(result.running);
  const age = rowAge(guide.generated_at, Date.now());
  const what = guide.depth === "tldr" ? "TL;DR" : "Guide";
  const link = "rounded px-1 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring";
  const comment = result.comment;
  // The guide on the pull request: this one, or one this person posted for an older push that this one replaces.
  const atHead = !result.head_sha || guide.head_sha === result.head_sha;
  const behind = Boolean(comment?.mine && comment.head_sha !== guide.head_sha);
  const postable = Boolean(result.can_post) && atHead && !guide.posted_by && (!comment || behind);
  const post = () => {
    setPosting(true);
    setPostError(null);
    onPost()
      .catch((error: unknown) => setPostError(error instanceof Error ? error.message : String(error)))
      .finally(() => setPosting(false));
  };
  return (
    <p className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[hsl(var(--subtle-foreground))]">
      <span>
        {what} by {guide.model ?? (guide.by === "chat" ? "the chat that opened it" : "a model")}
        {guide.posted_by ? ` · posted by ${guide.posted_by}` : ""} · {age === "now" ? "just now" : `${age} ago`} · for{" "}
        <span className="font-mono">{guide.head_sha.slice(0, 7)}</span>
      </span>
      {guide.by === "chat" && guide.workspace_id ? (
        <Link to={`/w/${encodeURIComponent(guide.workspace_id)}`} className={link}>
          Open the chat
        </Link>
      ) : null}
      {comment ? (
        <a href={comment.url} target="_blank" rel="noreferrer" className={cn(link, "inline-flex items-center gap-0.5")} title="The guide as a comment on the pull request">
          On GitHub
          <Icon icon={ArrowUpRight01Icon} className="size-3" />
        </a>
      ) : null}
      {postable ? (
        <button
          type="button"
          onClick={post}
          disabled={posting}
          className={cn(link, "disabled:opacity-50")}
          title="Reviewers read it on the pull request, no Caveman Code needed"
        >
          {posting ? (behind ? "Updating…" : "Posting…") : behind ? "Update on GitHub" : "Post to GitHub"}
        </button>
      ) : null}
      <button type="button" onClick={onGenerate} disabled={running} className={cn(link, "disabled:opacity-50")}>
        {running ? "Rewriting…" : "Rewrite"}
      </button>
      <Link to="/settings/review" className={link}>
        Settings
      </Link>
      {postError ? (
        <span role="alert" className="basis-full text-destructive">
          Couldn't post it: {postError}
        </span>
      ) : null}
    </p>
  );
}
