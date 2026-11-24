// Files: every line of the change, read in the guide's order (sections.ts). Each stop of the tour is a section with
// its title and explanation, then its files; a file whose hunks several stops explain is split, each piece saying
// which it is ("1 of 3"). An outline down the left side holds the sections, their files and what is left to read.
//
// Reviewing is one place for the hand (compact Review's Viewed): every file's header ends in the same Viewed box, and
// ticking it folds the file and brings the next unread file's header to where the box was, so a reviewer reads, ticks,
// reads, ticks without moving the pointer. v does the same for the file in view, j/k step through files, [ and ]
// through sections.
//
// Around each change, the unchanged lines open on demand (pr.file, read once a reader asks); code that moved shows as
// a move (moves.ts); a clicked name lights up everywhere it appears and says where it is defined (SymbolNav.tsx);
// the host's line threads sit under their lines with replies, a resolve and a fix.
import type { PrDetail, PrDiscussionItem, PrGuideStop } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@caveman-app/ui/components/dropdown-menu";
import { FileTypeIcon } from "@caveman-app/ui/icons/file-type";
import { cn } from "@caveman-app/ui/lib/cn";
import {
  Icon,
  ArrowDownFromLineIcon,
  ArrowRight01Icon,
  ArrowUpDownIcon,
  ArrowUpFromLineIcon,
  Comment01Icon,
  Copy01Icon,
  CornerDownRightIcon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  Tick02Icon,
} from "@caveman-app/ui/icons/huge";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { commentKey, type LineComment } from "../../panels/diff/comments.ts";
import { DiffRows, type Review } from "../../panels/diff/FileDiff.tsx";
import { fileLines, hunksOf } from "../../panels/diff/hunks.ts";
import { findMoves, type MoveMark } from "../../panels/diff/moves.ts";
import { LARGE_LINES, patchLines, type DiffFile, type DiffLine } from "../../panels/diff/parsePatch.ts";
import { useReviewOffers, useReviewSource } from "./source.ts";
import { usePrFile } from "./data.ts";
import { ThreadCard } from "./Discussion.tsx";
import { fileKind, prKey, splitPath, type Passage, type PrAddress } from "./model.ts";
import { GuideLines, Prose, Stat } from "./parts.tsx";
import { hunkOwners, linesLeft, markPart, partAt, partRows, partsOf, partViewed, sectionsOf, type Bar, type Expansion, type Part, type Section } from "./sections.ts";
import { SymbolNav } from "./SymbolNav.tsx";

type Thread = Extract<PrDiscussionItem, { type: "thread" }>;

/** Section headers stick at the top of the page's scroller; file headers stick under them. */
const SECTION_PX = 48;
/** The narrowest Files that holds the outline beside the code (a side panel stays code-only). */
const OUTLINE_ROOM_PX = 1020;
/** Lines one press of a gap's arrows opens. */
const STEP = 10;
/** Files in the first screenful build their rows at once; later ones as they scroll near. */
const EAGER_ROWS = 400;
const NEAR_PX = 1500;

export interface FilesProps {
  readonly detail: PrDetail;
  readonly address: PrAddress;
  /** The push the patch on screen was read at (data.ts filesReadAt): part marks and file reads are kept per push. */
  readonly head: string;
  /** The diff's revision: a file's unchanged lines are read at the push its patch was. */
  readonly revision: string | undefined;
  readonly files: ReadonlyArray<DiffFile>;
  readonly omitted: ReadonlyArray<string>;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly threads: ReadonlyArray<PrDiscussionItem>;
  /** The tour's stops, when there is a tour: the sections follow them. */
  readonly stops: ReadonlyArray<PrGuideStop> | null;
  /** A file (and line) to bring into view: the guide's "open file", a comment, a symbol. */
  readonly focus: { path: string; line?: number | undefined; side?: "new" | "old" | undefined } | null;
  /** Inside a short change's guide: the files in one column, no sections, no outline, no keys. */
  readonly inline?: boolean;
  readonly canComment: boolean;
  readonly onViewed: (path: string, viewed: boolean) => Promise<unknown>;
  readonly onComment: (anchor: Omit<LineComment, "text">, body: string) => Promise<unknown>;
  readonly onReply: (thread: Thread, body: string) => Promise<unknown>;
  readonly onResolve: (thread: Thread, resolved: boolean) => Promise<unknown>;
  readonly onFix: (passage: Passage, text: string) => Promise<unknown>;
  /** The host's page of a file at the head, at a line. */
  readonly fileUrl: (path: string, line?: number) => string;
  /** The host's page of a file at any commit (a symbol found on the base branch), at a line. */
  readonly blobUrl: (commit: string, path: string, line: number) => string;
  /** Read a stop in the guide. */
  readonly onOpenStop?: ((stop: number) => void) | undefined;
}

export function Files(props: FilesProps) {
  const { detail, address, head, revision, files, omitted, loading, error, threads, stops, focus, inline = false, onViewed } = props;
  const root = useRef<HTMLDivElement>(null);
  const roomy = useWidth(root) >= OUTLINE_ROOM_PX;
  const sections = useMemo(() => (inline ? sectionsOf(files, null) : sectionsOf(files, stops)), [files, stops, inline]);
  const parts = useMemo(() => partsOf(sections), [sections]);
  const owners = useMemo(() => hunkOwners(parts), [parts]);
  const moves = useMemo(() => findMoves(files), [files]);
  // From Cloud a file's viewed mark is this device's (GitHub keeps it in GraphQL only), and nothing past a patch is read.
  const offers = useReviewOffers();

  // Viewed: the host's marks, what this page just sent ahead of the host's answer, and split files' parts here.
  const [sent, setSent] = useState<ReadonlyMap<string, boolean>>(new Map());
  const hostViewed = useMemo(() => {
    const set = new Set(detail.files.filter((f) => f.viewed).map((f) => f.path));
    for (const [path, v] of sent) v ? set.add(path) : set.delete(path);
    return set;
  }, [detail.files, sent]);
  useEffect(() => setSent(new Map()), [detail.files]);
  const [local, setLocal] = useLocalSet(`caveman.review.parts.${prKey(address)}@${head}`);
  const viewed = useCallback((p: Part) => partViewed(p, hostViewed, local), [hostViewed, local]);
  const left = linesLeft(parts, viewed);
  const viewedCount = parts.filter(viewed).length;

  // Folded: what the reader chose, else viewed files, generated files and very long ones.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isFolded = (p: Part) => chosen.get(p.key) ?? (viewed(p) || fileKind(p.file.path) === "generated" || patchLines(p.file) > LARGE_LINES);
  const fold = useCallback((key: string, folded: boolean) => setChosen((c) => new Map(c).set(key, folded)), []);

  // Ticking Viewed folds the part and puts the next unread part's header where this one's was.
  const anchor = useRef<{ after: string; y: number } | null>(null);
  const setViewed = useCallback(
    (part: Part, next: boolean, header?: HTMLElement | null) => {
      const change = offers.viewed ? markPart(part, next, parts, hostViewed, local) : { local: toggled(local, part.key, next), host: null };
      setLocal(change.local);
      if (change.host) {
        const { path, viewed: v } = change.host;
        setSent((s) => new Map(s).set(path, v));
        void onViewed(path, v).catch(() => setSent((s) => new Map(s).set(path, !v)));
      }
      fold(part.key, next);
      if (next && header) anchor.current = { after: part.key, y: header.getBoundingClientRect().top };
    },
    [parts, hostViewed, local, setLocal, onViewed, fold, offers.viewed],
  );
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    const at = parts.findIndex((p) => p.key === a.after);
    const next = parts.slice(at + 1).find((p) => !viewed(p));
    const el = next ? headOf(next.key) : null;
    const scroller = root.current?.closest<HTMLElement>("[data-review-scroller]");
    if (!el || !scroller) return;
    scroller.scrollTop += el.getBoundingClientRect().top - a.y;
  });

  // The part and section in view: the last whose header has reached the sticky line.
  const [current, setCurrent] = useState<{ part: string | null; section: string | null }>({ part: null, section: null });
  useEffect(() => {
    const scroller = root.current?.closest<HTMLElement>("[data-review-scroller]");
    if (!scroller || inline) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = scroller.getBoundingClientRect().top + SECTION_PX + 48;
      let part: string | null = null;
      let section: string | null = null;
      for (const el of root.current?.querySelectorAll<HTMLElement>("[data-part-key]") ?? []) if (el.getBoundingClientRect().top <= line) part = el.dataset.partKey ?? null;
      for (const el of root.current?.querySelectorAll<HTMLElement>("[data-section-id]") ?? []) if (el.getBoundingClientRect().top <= line) section = el.dataset.sectionId ?? null;
      setCurrent((c) => (c.part === part && c.section === section ? c : { part, section }));
    };
    const onScroll = () => (frame ||= requestAnimationFrame(update));
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [inline, sections]);

  /**
   * Bring a part's header to the sticky line (and open it), or a line of it to the middle. Files far down build their
   * rows only once near, and files above settle their heights as they paint, so this steps until the target holds
   * still (a few frames), then marks the line. A newer jump cancels an older one.
   */
  const jump = useRef(0);
  const goTo = useCallback(
    (part: Part, line?: { n: number; side: "new" | "old" }) => {
      fold(part.key, false);
      const scroller = root.current?.closest<HTMLElement>("[data-review-scroller]");
      const id = ++jump.current;
      let tries = 0;
      const step = () => {
        if (id !== jump.current || !scroller || tries++ > 40) return;
        const head = headOf(part.key);
        if (!head) return void requestAnimationFrame(step);
        const frame = scroller.getBoundingClientRect();
        const row = line ? document.getElementById(partId(part.key))?.querySelector<HTMLElement>(`[data-side="${line.side}"][data-line="${line.n}"]`) : null;
        const off = row
          ? row.getBoundingClientRect().top - frame.top - frame.height / 2
          : // Until its rows are built, the part's header comes first: that brings it near.
            head.getBoundingClientRect().top - frame.top - (inline ? 0 : SECTION_PX);
        if (Math.abs(off) > 2 || (line && !row)) {
          scroller.scrollTop += off;
          requestAnimationFrame(step);
        } else if (row) flash(row);
      };
      requestAnimationFrame(step);
    },
    [fold, inline],
  );

  // Sent here from elsewhere (the guide, a comment, a symbol): open the part that holds the line and show it.
  // Each focus is shown once: a tour landing later (new sections) must not pull the page back to it.
  const shown = useRef<FilesProps["focus"]>(null);
  useEffect(() => {
    if (!focus || focus === shown.current || parts.length === 0) return;
    const part = partAt(parts, focus.path, focus.line, focus.side);
    if (!part) return;
    shown.current = focus;
    // The row exists once the part has built its rows; a frame for the unfold, one for the rows.
    const t = setTimeout(() => goTo(part, focus.line ? { n: focus.line, side: focus.side ?? "new" } : undefined), 60);
    return () => clearTimeout(t);
  }, [focus, parts, goTo]);

  // j / k files, [ / ] sections, v viewed (then the next file), o fold.
  const keys = useRef({ parts, sections, current, viewed, setViewed, goTo, isFolded, fold });
  keys.current = { parts, sections, current, viewed, setViewed, goTo, isFolded, fold };
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable], [role=dialog], [role=menu]")) return;
      if (!window.getSelection()?.isCollapsed) return;
      const k = keys.current;
      const at = Math.max(0, k.parts.findIndex((p) => p.key === k.current.part));
      const here = k.parts[at];
      if (e.key === "j" || e.key === "k") {
        const next = k.parts[e.key === "j" ? Math.min(k.parts.length - 1, k.current.part ? at + 1 : 0) : Math.max(0, at - 1)];
        if (next) k.goTo(next);
      } else if (e.key === "]" || e.key === "[") {
        const s = Math.max(0, k.sections.findIndex((x) => x.id === k.current.section));
        const target = k.sections[e.key === "]" ? Math.min(k.sections.length - 1, k.current.section ? s + 1 : 0) : Math.max(0, s - 1)];
        if (target?.parts[0]) k.goTo(target.parts[0]);
      } else if (e.key === "v" && here) k.setViewed(here, !k.viewed(here), headOf(here.key));
      else if (e.key === "o" && here) k.fold(here.key, !k.isFolded(here));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline]);

  // Host threads by the line they sit on.
  const threadsAt = useMemo(() => {
    const at = new Map<string, Thread[]>();
    for (const t of threads) {
      if (t.type !== "thread" || !t.line || t.outdated) continue;
      const key = commentKey({ path: t.path, side: t.side, line: t.line });
      at.set(key, [...(at.get(key) ?? []), t]);
    }
    return at;
  }, [threads]);
  const [drafting, setDrafting] = useState<string | null>(null);
  // The page's handlers change every render; the rows read them through a ref so a scroll never re-draws every line.
  const calls = useRef(props);
  calls.current = props;
  const review = useMemo<Review>(
    () => ({
      comments: [...threadsAt.keys()].map((key) => {
        const [path, side, line] = key.split("\0");
        return { path: path!, side: side as "new" | "old", line: Number(line), code: "", text: "" };
      }),
      drafting,
      onStart: (a) => {
        if (calls.current.canComment) setDrafting(commentKey(a));
      },
      onCancel: () => setDrafting(null),
      // A failed comment keeps its box open with the words in it.
      onSave: (a, text) => void calls.current.onComment(a, text).then(() => setDrafting(null), () => undefined),
      renderNotes: (a) => (
        <div className="space-y-2 border-y border-border/70 bg-background/60 px-3 py-2.5">
          {(threadsAt.get(commentKey(a)) ?? []).map((t) => (
            <div key={t.id} className="max-w-[760px]">
              <ThreadCard
                t={t}
                url={calls.current.detail.url}
                now={Date.now()}
                canComment={calls.current.canComment}
                onReply={(...args) => calls.current.onReply(...args)}
                onResolve={(...args) => calls.current.onResolve(...args)}
                onFix={(...args) => calls.current.onFix(...args)}
                inline
              />
            </div>
          ))}
        </div>
      ),
    }),
    [threadsAt, drafting],
  );
  const fileUrl = useCallback((path: string, line?: number) => calls.current.fileUrl(path, line), []);
  const onMove = useCallback(
    (to: MoveMark["to"]) => {
      const part = partAt(parts, to.path, to.line, to.side);
      if (part) goTo(part, { n: to.line, side: to.side });
    },
    [parts, goTo],
  );

  if (files.length === 0)
    return <p className={cn("text-[13px] text-muted-foreground", inline ? "py-4" : "py-10")}>{error ?? (loading ? "Reading the diff…" : "No file changes.")}</p>;

  let rowsBefore = 0;
  const body = (section: Section) =>
    section.parts.map((p) => {
      const folded = isFolded(p);
      const eager = rowsBefore < EAGER_ROWS;
      if (!folded) rowsBefore += patchLines(p.file);
      return (
        <PartView
          key={p.key}
          part={p}
          owners={owners.get(p.file) ?? []}
          sections={sections}
          address={address}
          head={head}
          revision={revision}
          folded={folded}
          eager={eager}
          viewed={viewed(p)}
          sticky={inline ? 0 : SECTION_PX}
          threads={countThreads(threadsAt, p)}
          review={review}
          moves={moves}
          onMove={onMove}
          onFold={fold}
          onViewed={setViewed}
          onGoTo={goTo}
          fileUrl={fileUrl}
        />
      );
    });

  return (
    <div ref={root} className={cn("flex gap-8", !inline && "pb-24")}>
      {inline || !roomy ? null : (
        <Outline sections={sections} viewed={viewed} current={current} left={left} viewedCount={viewedCount} total={parts.length} stops={stops} onGoTo={goTo} onOpenStop={props.onOpenStop} />
      )}
      <div className="min-w-0 flex-1">
        <SymbolNav
          off={!offers.symbols}
          root={root}
          files={files}
          address={address}
          head={head}
          blobUrl={props.blobUrl}
          onGoTo={(path, line, side) => {
            const part = partAt(parts, path, line, side);
            if (part) goTo(part, { n: line, side });
          }}
        >
          {inline
            ? sections.map((s) => <div key={s.id}>{body(s)}</div>)
            : sections.map((s, i) => (
                <section key={s.id} id={sectionId(s.id)} data-section-id={s.id} className={cn(i > 0 && "mt-10")}>
                  <SectionHead section={s} viewed={viewed} left={left} stops={stops} onOpenStop={props.onOpenStop} />
                  {s.summary ? <Explanation section={s} stops={stops} onOpenStop={props.onOpenStop} /> : null}
                  <div className="pt-3">{body(s)}</div>
                </section>
              ))}
        </SymbolNav>
        {omitted.length > 0 ? <p className="pt-3 text-[12.5px] text-muted-foreground">Too large for GitHub to send: {omitted.join(", ")}</p> : null}
        {inline ? null : <Finish left={left} viewedCount={viewedCount} total={parts.length} />}
      </div>
    </div>
  );
}

const partId = (key: string) => `part-${key.replace(/[^a-zA-Z0-9]/g, "-")}`;
const sectionId = (id: string) => `section-${id}`;
const headOf = (key: string) => document.getElementById(partId(key))?.querySelector<HTMLElement>("[data-part-head]") ?? null;

/** A row a jump landed on glows for a moment, so the eye finds it. */
function flash(el: HTMLElement) {
  el.animate([{ boxShadow: "inset 0 0 0 999px hsl(var(--foreground) / 0.12)" }, { boxShadow: "inset 0 0 0 999px hsl(var(--foreground) / 0)" }], { duration: 1200, easing: "ease-out" });
}

function countThreads(at: ReadonlyMap<string, ReadonlyArray<Thread>>, part: Part): number {
  const hunks = hunksOf(part.file);
  let n = 0;
  for (const k of part.hunks)
    for (const r of hunks[k]!.rows) {
      const line = r.kind === "del" ? r.oldNo : r.newNo;
      if (line !== null) n += at.get(commentKey({ path: part.file.path, side: r.kind === "del" ? "old" : "new", line }))?.filter((t) => !t.resolved).length ?? 0;
    }
  return n;
}

/** An element's width, kept current as it resizes. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** A set kept in this browser under `key` (a split file's viewed parts, per head). */
function useLocalSet(key: string): [ReadonlySet<string>, (next: ReadonlySet<string>) => void] {
  const read = () => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  };
  const [value, setValue] = useState<ReadonlySet<string>>(read);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `read` is rebuilt each render; the key names what it reads.
  useEffect(() => setValue(read()), [key]);
  const set = useCallback(
    (next: ReadonlySet<string>) => {
      setValue(next);
      if (next.size === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify([...next]));
    },
    [key],
  );
  return [value, set];
}

// ------------------------------------------------------------------ outline

function Outline({
  sections,
  viewed,
  current,
  left,
  viewedCount,
  total,
  stops,
  onGoTo,
  onOpenStop,
}: {
  sections: ReadonlyArray<Section>;
  viewed: (p: Part) => boolean;
  current: { part: string | null; section: string | null };
  left: number;
  viewedCount: number;
  total: number;
  stops: ReadonlyArray<PrGuideStop> | null;
  onGoTo: (p: Part) => void;
  onOpenStop?: ((stop: number) => void) | undefined;
}) {
  return (
    <aside aria-label="Sections and files" className="sticky top-0 max-h-[calc(100vh-120px)] w-[272px] shrink-0 self-start overflow-y-auto pb-6 pt-1 [scrollbar-width:none]">
      <div className="flex items-center gap-2 px-2 pb-3 text-[12px] text-muted-foreground">
        <ProgressRing value={viewedCount} total={total} />
        <span className="tabular-nums">
          {viewedCount} of {total} viewed
        </span>
        <span className="ml-auto tabular-nums">{left > 0 ? `${left.toLocaleString()} lines left` : "All read"}</span>
      </div>
      <ol className="space-y-1">
        {sections.map((s) => (
          <OutlineSection key={s.id} section={s} viewed={viewed} current={current} stops={stops} onGoTo={onGoTo} onOpenStop={onOpenStop} />
        ))}
      </ol>
    </aside>
  );
}

/** Files an outline section lists before "+N more". */
const OUTLINE_FILES = 6;

function OutlineSection({
  section: s,
  viewed,
  current,
  stops,
  onGoTo,
  onOpenStop,
}: {
  section: Section;
  viewed: (p: Part) => boolean;
  current: { part: string | null; section: string | null };
  stops: ReadonlyArray<PrGuideStop> | null;
  onGoTo: (p: Part) => void;
  onOpenStop?: ((stop: number) => void) | undefined;
}) {
  const [all, setAll] = useState(false);
  const here = current.section === s.id;
  const adds = s.parts.reduce((n, p) => n + p.additions, 0);
  const dels = s.parts.reduce((n, p) => n + p.deletions, 0);
  const shown = all ? s.parts : s.parts.slice(0, OUTLINE_FILES);
  return (
    <li className={cn("rounded-xl px-2 py-2.5 transition-colors duration-150", here && "bg-foreground/[0.035]")}>
      <button type="button" onClick={() => s.parts[0] && onGoTo(s.parts[0])} className="flex w-full items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {s.stop !== null ? <StopBadge n={stopNumber(s)} small done={s.parts.every(viewed)} /> : null}
        <Prose text={s.title} className={cn("min-w-0 text-[13px] font-medium leading-5", s.parts.every(viewed) ? "text-muted-foreground" : "text-foreground")} />
      </button>
      <p className="mt-1 flex items-center gap-2 pl-[26px] text-[12px] text-muted-foreground">
        {s.parts.length === 1 ? "1 file" : `${s.parts.length} files`}
        <Stat additions={adds} deletions={dels} className="text-[11.5px]" />
        {s.attention ? <span className="size-1.5 rounded-full bg-warning" title="Has a call for you" /> : null}
      </p>
      <ul className="mt-1.5 space-y-px pl-[18px]">
        {shown.map((p) => {
          const { name, dir } = splitPath(p.file.path);
          const seen = viewed(p);
          return (
            <li key={p.key}>
              <button
                type="button"
                title={p.file.path}
                onClick={() => onGoTo(p)}
                aria-current={current.part === p.key ? "true" : undefined}
                className={cn(
                  "flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[12.5px] outline-none transition-colors duration-75 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                  current.part === p.key && "bg-accent/70",
                )}
              >
                <span className={cn("min-w-0 truncate", seen ? "text-[hsl(var(--subtle-foreground))] line-through decoration-foreground/25" : "text-foreground/90")}>{name}</span>
                {p.of > 1 ? <span className="shrink-0 tabular-nums text-[hsl(var(--subtle-foreground))]">({p.part}/{p.of})</span> : null}
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-[hsl(var(--subtle-foreground))]">{dir.replace(/\/$/, "")}</span>
                {seen ? <Icon icon={Tick02Icon} className="size-3 shrink-0 text-muted-foreground" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {s.parts.length > OUTLINE_FILES ? (
        <button type="button" onClick={() => setAll(!all)} className="ml-[26px] mt-0.5 rounded-md px-0 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
          {all ? "Fewer files" : `+${s.parts.length - OUTLINE_FILES} more ${s.parts.length - OUTLINE_FILES === 1 ? "file" : "files"}`}
        </button>
      ) : null}
      {s.stop !== null && onOpenStop ? (
        <button type="button" onClick={() => onOpenStop(s.stop!)} className="ml-[26px] mt-1.5 flex items-center gap-0.5 rounded-md text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:underline">
          Read in the guide
          <Icon icon={ArrowRight01Icon} className="size-3" />
        </button>
      ) : null}
    </li>
  );
}

/** The 1-based number the guide gives a stop (its place in the tour, skim stops included). */
const stopNumber = (s: Section) => (s.stop ?? 0) + 1;

/** A stop's number in a white disc, like the guide's: the tour's place, read at a glance. Done: a quiet tick. */
function StopBadge({ n, small = false, done = false }: { n: number; small?: boolean; done?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold tabular-nums transition-colors duration-200",
        small ? "mt-px size-[18px] text-[11px]" : "size-[22px] text-[12px]",
        done ? "bg-foreground/10 text-muted-foreground" : "bg-foreground text-background",
      )}
    >
      {done ? <Icon icon={Tick02Icon} className={small ? "size-3" : "size-3.5"} strokeWidth={2.25} /> : n}
    </span>
  );
}

/** How many of `total` are done, as a ring that fills clockwise. */
function ProgressRing({ value, total, size = 14 }: { value: number; total: number; size?: number }) {
  const r = (size - 2.5) / 2;
  const c = 2 * Math.PI * r;
  const share = total === 0 ? 0 : value / total;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--foreground) / 0.14)" strokeWidth={1.75} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={share >= 1 ? "hsl(var(--success))" : "hsl(var(--foreground) / 0.8)"}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeDasharray={`${c * share} ${c}`}
        className="transition-[stroke-dasharray] duration-300 ease-snap"
      />
    </svg>
  );
}

// ------------------------------------------------------------------ sections

function SectionHead({ section: s, viewed, left, stops, onOpenStop }: { section: Section; viewed: (p: Part) => boolean; left: number; stops: ReadonlyArray<PrGuideStop> | null; onOpenStop?: ((stop: number) => void) | undefined }) {
  const done = s.parts.filter(viewed).length;
  return (
    <header
      className="sticky top-0 z-20 -mx-1 flex items-center gap-3 bg-background/90 px-1 backdrop-blur-xl"
      style={{ height: SECTION_PX }}
      data-passage={s.stop !== null ? `guide stop ${s.stop + 1} “${s.title}”` : s.title}
    >
      {s.stop !== null ? <StopBadge n={stopNumber(s)} done={done === s.parts.length} /> : null}
      <h2 className={cn("min-w-0 truncate font-semibold tracking-[-0.01em]", s.stop !== null ? "text-[16px] text-foreground" : "text-[14px] text-foreground/85")}>
        {s.stop !== null && onOpenStop ? (
          <button type="button" onClick={() => onOpenStop(s.stop!)} title="Read this stop in the guide" className="max-w-full truncate rounded-md text-left outline-none underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            <Prose text={s.title} />
          </button>
        ) : (
          <Prose text={s.title} />
        )}
      </h2>
      {s.attention ? <span className="size-1.5 shrink-0 rounded-full bg-warning" title="Has a call for you" /> : null}
      <span className="ml-auto flex shrink-0 items-center gap-3 text-[12.5px] text-muted-foreground">
        <span className="flex items-center gap-1.5 tabular-nums" title={`${done} of ${s.parts.length} files in this section viewed`}>
          {done}/{s.parts.length}
          <ProgressRing value={done} total={s.parts.length} />
        </span>
        <span className="hidden tabular-nums text-[hsl(var(--subtle-foreground))] min-[900px]:inline">{left > 0 ? `${left.toLocaleString()} lines left` : "All read"}</span>
      </span>
    </header>
  );
}

/** The stop's explanation, two lines until opened (compact Review's "Read more"), and its call when it has one. */
function Explanation({ section: s, stops, onOpenStop }: { section: Section; stops: ReadonlyArray<PrGuideStop> | null; onOpenStop?: ((stop: number) => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const stop = s.stop !== null ? stops?.[s.stop] : undefined;
  const lines = (s.summary ?? "").split("\n").filter((l) => l.trim());
  const long = lines.length > 2 || (s.summary ?? "").length > 220 || Boolean(stop?.attention);
  return (
    <div className="relative mt-0.5 max-w-[880px] pl-[34px]">
      <div className={cn("space-y-1.5 text-[13.5px] leading-[1.6] text-foreground/75", !open && long && "max-h-[46px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_40%,transparent)]")}>
        <GuideLines text={s.summary ?? ""} />
        {stop?.attention ? (
          <p className="pt-1 text-foreground/85">
            <span className="mr-1.5 font-medium text-warning">Your call</span>
            <Prose text={stop.attention.note} />
          </p>
        ) : null}
      </div>
      {long ? (
        <div className={cn("flex items-center gap-1", open ? "mt-2" : "-mt-2 justify-center")}>
          <Button size="sm" variant="secondary" onClick={() => setOpen(!open)} className="h-6 rounded-full px-2.5 text-[12px]">
            {open ? "Show less" : "Read more"}
            <Icon icon={ArrowRight01Icon} className={cn("size-3 transition-transform duration-150", open ? "-rotate-90" : "rotate-90")} />
          </Button>
          {open && s.stop !== null && onOpenStop ? (
            <Button size="sm" variant="ghost" onClick={() => onOpenStop(s.stop!)} className="h-6 px-2 text-[12px]">
              Read in the guide
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Finish({ left, viewedCount, total }: { left: number; viewedCount: number; total: number }) {
  const all = viewedCount >= total;
  return (
    <div className="mt-10 flex items-center gap-3 border-t border-border/60 pt-6 text-[13px] text-muted-foreground">
      <ProgressRing value={viewedCount} total={total} size={16} />
      <span>{all ? "Every file viewed. Your call now: approve, ask, or send it back." : `${viewedCount} of ${total} files viewed, ${left.toLocaleString()} lines left.`}</span>
      <span className="ml-auto hidden text-[12px] text-[hsl(var(--subtle-foreground))] min-[900px]:inline">j k files · [ ] sections · v viewed · o fold · click a name to find it</span>
    </div>
  );
}

// ------------------------------------------------------------------ one part

const PartView = memo(function PartView({
  part,
  owners,
  sections,
  address,
  head,
  revision,
  folded,
  eager,
  viewed,
  sticky,
  threads,
  review,
  moves,
  onMove,
  onFold,
  onViewed,
  onGoTo,
  fileUrl,
}: {
  part: Part;
  owners: ReadonlyArray<Part | undefined>;
  sections: ReadonlyArray<Section>;
  address: PrAddress;
  head: string;
  revision: string | undefined;
  folded: boolean;
  eager: boolean;
  viewed: boolean;
  sticky: number;
  threads: number;
  review: Review;
  moves: ReadonlyMap<DiffLine, MoveMark>;
  onMove: (to: MoveMark["to"]) => void;
  onFold: (key: string, folded: boolean) => void;
  onViewed: (part: Part, viewed: boolean, header?: HTMLElement | null) => void;
  onGoTo: (part: Part) => void;
  fileUrl: (path: string, line?: number) => string;
}) {
  const { file } = part;
  const { client, offers } = useReviewSource(address);
  const headRef = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  // Unchanged lines opened per gap; the file is read the first time any is asked for.
  const [expanded, setExpanded] = useState<ReadonlyMap<number, Expansion>>(new Map());
  const [wanted, setWanted] = useState(false);
  const contents = usePrFile(client, address, head, revision, wanted ? file : null);
  const newLines = useMemo(() => (contents.value ? fileLines(contents.value.new) : null), [contents.value]);
  const { rows, bars } = useMemo(() => partRows(part, owners, expanded, newLines), [part, owners, expanded, newLines]);
  const [near, setNear] = useState(eager);
  useEffect(() => {
    const el = box.current;
    if (near || folded || !el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { root: el.closest("[data-review-scroller]"), rootMargin: `${NEAR_PX}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [near, folded]);

  // A press before the file is here waits for it, then opens what it asked for.
  const asked = useRef<((lines: ReadonlyArray<string>) => void) | null>(null);
  useEffect(() => {
    if (newLines && asked.current) {
      asked.current(newLines);
      asked.current = null;
    }
  }, [newLines]);
  const open = (gap: number, how: "up" | "down" | "all") => {
    const apply = () =>
      setExpanded((prev) => {
        const cur = prev.get(gap) ?? { top: 0, bottom: 0 };
        const next = how === "all" ? { top: Number.MAX_SAFE_INTEGER, bottom: 0 } : how === "down" ? { ...cur, top: cur.top + STEP } : { ...cur, bottom: cur.bottom + STEP };
        return new Map(prev).set(gap, next);
      });
    if (newLines) apply();
    else {
      asked.current = apply;
      setWanted(true);
    }
  };
  const openAll = () => {
    const all = () => setExpanded(new Map(Array.from({ length: hunksOf(file).length + 1 }, (_, k) => [k, { top: Number.MAX_SAFE_INTEGER, bottom: 0 }])));
    if (newLines) all();
    else {
      asked.current = all;
      setWanted(true);
    }
  };

  const { name, dir } = splitPath(file.path);
  const prose = /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(file.path);
  const firstLine = hunksOf(file)[part.hunks[0] ?? 0]?.newStart;
  return (
    <article
      ref={box}
      id={partId(part.key)}
      data-part-key={part.key}
      className={cn("mb-3 overflow-clip rounded-xl border bg-card/20 transition-colors duration-200 [content-visibility:auto]", viewed ? "border-border/60" : "border-border")}
      style={{ containIntrinsicSize: `auto ${40 + (folded ? 0 : rows.length * 20)}px` }}
      data-passage={`${file.path}${part.of > 1 ? ` (part ${part.part} of ${part.of})` : ""}`}
    >
      <div
        ref={headRef}
        data-part-head
        className={cn("group/head sticky z-10 flex h-10 cursor-default items-center gap-1 bg-background/90 pl-1.5 pr-1.5 backdrop-blur-xl", !folded && "border-b border-border/70")}
        style={{ top: sticky }}
        // The header's empty stretch folds too (GitHub's), never a click on one of its buttons.
        onClick={(e) => !(e.target as HTMLElement).closest("button, a, [role=menu]") && onFold(part.key, !folded)}
      >
        <button
          type="button"
          aria-expanded={!folded}
          onClick={() => onFold(part.key, !folded)}
          title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}
          className="flex h-8 min-w-0 items-center gap-2 rounded-md pl-1.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon icon={ArrowRight01Icon} className={cn("size-3.5 shrink-0 text-[hsl(var(--subtle-foreground))] transition-transform duration-150 ease-snap", !folded && "rotate-90")} />
          <FileTypeIcon path={file.path} className="size-[15px]" />
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={cn("max-w-full shrink-0 truncate text-[13px] font-medium", viewed ? "text-muted-foreground" : "text-foreground", file.status === "deleted" && "line-through decoration-foreground/40")}>{name}</span>
            <span className="min-w-0 truncate text-[12px] text-[hsl(var(--subtle-foreground))]">
              {file.old_path ? `${file.old_path} → ` : ""}
              {dir.replace(/\/$/, "")}
            </span>
          </span>
        </button>
        <CopyPath path={file.path} />
        {part.of > 1 ? <span className="shrink-0 px-1 text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]">({part.part} of {part.of})</span> : null}
        {file.status === "added" || file.status === "deleted" || file.status === "renamed" ? (
          <span className="shrink-0 rounded-[5px] px-1.5 text-[11px] text-muted-foreground ring-1 ring-inset ring-border">{file.status === "added" ? "New" : file.status === "deleted" ? "Deleted" : "Renamed"}</span>
        ) : null}
        <span className="flex-1" />
        {threads > 0 ? (
          <span className="flex shrink-0 items-center gap-1 px-1 text-[12px] tabular-nums text-warning" title={`${threads} open ${threads === 1 ? "thread" : "threads"}`}>
            <Icon icon={Comment01Icon} className="size-3.5" />
            {threads}
          </span>
        ) : null}
        <Stat additions={part.additions} deletions={part.deletions} className="px-1.5 text-[12px]" />
        <ViewedBox viewed={viewed} onChange={(v) => onViewed(part, v, headRef.current)} />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More for ${name}`} className="size-7 text-muted-foreground">
              <Icon icon={MoreHorizontalIcon} className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px]">
            {offers.expand && file.status !== "added" && file.status !== "deleted" && hunksOf(file).length > 0 ? (
              <DropdownMenuItem onSelect={() => (folded ? (onFold(part.key, false), openAll()) : openAll())}>
                <Icon icon={ArrowUpDownIcon} />
                Show the whole file
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onFold(part.key, !folded)}>
              <Icon icon={ArrowRight01Icon} className={cn(!folded && "rotate-90")} />
              {folded ? "Unfold" : "Fold"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(file.path).catch(() => undefined)}>
              <Icon icon={Copy01Icon} />
              Copy path
            </DropdownMenuItem>
            {file.status !== "deleted" ? (
              <DropdownMenuItem onSelect={() => window.open(fileUrl(file.path, firstLine), "_blank", "noreferrer")}>
                <Icon icon={LinkSquare02Icon} />
                Open on GitHub
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {folded ? null : hunksOf(file).length === 0 ? (
        <p className="px-4 py-3 text-[12.5px] text-muted-foreground">{file.patch ? "Nothing to show." : file.status === "renamed" ? "Renamed, its lines unchanged." : "Binary file, or too large for GitHub to show."}</p>
      ) : !near ? (
        <div style={{ height: rows.length * 20 }} />
      ) : (
        <DiffRows
          file={file}
          lines={rows}
          wrap={prose}
          review={review}
          moves={moves}
          onMove={onMove}
          className="text-[12.5px]"
          renderHunk={(row) => {
            const bar = bars.get(row);
            if (!bar) return null;
            return bar.kind === "gap" ? (
              <GapBar bar={bar} canOpen={offers.expand} loading={wanted && contents.loading && !newLines} error={wanted && !newLines ? contents.error : undefined} onOpen={(how) => open(bar.gap, how)} />
            ) : (
              <ElsewhereBar bar={bar} sections={sections} onGoTo={onGoTo} />
            );
          }}
        />
      )}
    </article>
  );
});

/** The file's Viewed box: the same size and place in every header, so the next file's box lands under the pointer. */
function ViewedBox({ viewed, onChange }: { viewed: boolean; onChange: (viewed: boolean) => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      role="checkbox"
      aria-checked={viewed}
      onClick={() => onChange(!viewed)}
      title={viewed ? "Viewed (v): click to read it again" : "Mark viewed (v): folds it and brings the next file here"}
      className={cn("w-[84px] shrink-0 justify-start gap-2 px-2 text-[12.5px]", viewed ? "text-foreground" : "text-muted-foreground")}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-[15px] shrink-0 place-items-center rounded-[4px] border transition-[background-color,border-color] duration-150 ease-snap",
          viewed ? "border-primary bg-primary text-primary-foreground" : "border-foreground/30 bg-transparent",
        )}
      >
        {viewed ? <Icon icon={Tick02Icon} className="size-3 animate-in zoom-in-50 duration-150 ease-snap" strokeWidth={2.5} /> : null}
      </span>
      Viewed
    </Button>
  );
}

function CopyPath({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Copy ${path}`}
      title="Copy path"
      onClick={() => void navigator.clipboard?.writeText(path).then(() => setDone(true), () => undefined)}
      className="size-6 shrink-0 text-[hsl(var(--subtle-foreground))] opacity-0 transition-opacity duration-100 focus-visible:opacity-100 group-hover/head:opacity-100"
    >
      <Icon icon={done ? Tick02Icon : Copy01Icon} className="size-3.5" />
    </Button>
  );
}

/** Unchanged lines between changes: open some downward, all, or some upward. */
/** `canOpen` false (from Cloud): the gap is only marked, with nothing to press. */
function GapBar({ bar, canOpen = true, loading, error, onOpen }: { bar: Extract<Bar, { kind: "gap" }>; canOpen?: boolean; loading: boolean; error: string | undefined; onOpen: (how: "up" | "down" | "all") => void }) {
  const small = bar.hidden !== null && bar.hidden <= STEP * 2;
  const link = "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground outline-none transition-colors duration-75 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none";
  const lines = (n: number) => `${n.toLocaleString()} ${n === 1 ? "line" : "lines"}`;
  return (
    <div className="flex h-8 items-center gap-1 border-y border-foreground/[0.05] bg-foreground/[0.025] pl-[calc(var(--ln)+12px)] pr-3 font-sans text-[12px]">
      {!canOpen ? null : error ? (
        <span className="truncate text-muted-foreground" title={error}>
          Couldn't read the file: {error}
        </span>
      ) : loading ? (
        <span className="lucy-shimmer text-muted-foreground">Reading the file…</span>
      ) : (
        <>
          {bar.edge !== "top" && !small ? (
            <button type="button" className={link} onClick={() => onOpen("down")}>
              <Icon icon={ArrowDownFromLineIcon} className="size-3.5" />
              {lines(STEP)}
            </button>
          ) : null}
          <button type="button" className={link} onClick={() => onOpen("all")}>
            <Icon icon={ArrowUpDownIcon} className="size-3.5" />
            {bar.hidden === null ? "The rest of the file" : `All ${lines(bar.hidden)}`}
          </button>
          {bar.edge !== "tail" && !small ? (
            <button type="button" className={link} onClick={() => onOpen("up")}>
              <Icon icon={ArrowUpFromLineIcon} className="size-3.5" />
              {lines(STEP)}
            </button>
          ) : null}
        </>
      )}
      {bar.context ? <span className="ml-auto min-w-0 truncate pl-4 font-mono text-[11.5px] text-[hsl(var(--subtle-foreground))]">{bar.context}</span> : null}
    </div>
  );
}

/** This file's other changes, which another section explains: say where, and go there. */
function ElsewhereBar({ bar, sections, onGoTo }: { bar: Extract<Bar, { kind: "elsewhere" }>; sections: ReadonlyArray<Section>; onGoTo: (part: Part) => void }) {
  const section = sections[bar.part.section];
  const where: ReactNode = section ? (
    <>
      {section.stop !== null ? <span className="tabular-nums">{section.stop + 1} · </span> : null}
      <Prose text={section.title} />
    </>
  ) : null;
  return (
    <button
      type="button"
      onClick={() => onGoTo(bar.part)}
      className="flex h-8 w-full items-center gap-2 border-y border-dashed border-foreground/[0.08] bg-transparent pl-[calc(var(--ln)+14px)] pr-3 text-left font-sans text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-foreground/[0.03] hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <Icon icon={CornerDownRightIcon} className="size-3.5 shrink-0" />
      <span className="shrink-0">
        {bar.changes === 1 ? "1 more change" : `${bar.changes} more changes`} in this file, under
      </span>
      <span className="min-w-0 truncate text-foreground/80">{where}</span>
      <span className="shrink-0 tabular-nums text-[hsl(var(--subtle-foreground))]">
        ({bar.part.part} of {bar.part.of})
      </span>
    </button>
  );
}

/** `set` with `key` in it, or not. */
function toggled(set: ReadonlySet<string>, key: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}
