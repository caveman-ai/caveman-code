// One file of the Changes surface, drawn using compact styling, MIT,
// src/features/source-control/ui/UnifiedDiffView.tsx @ 26465c6): a sticky 36px frosted header (collapse, file mark,
// name then its folder, +n −m, open the file) over syntax-coloured rows; a changed line is tinted at 10% of the diff
// ink with a 3px bar at its edge, never a solid block, and the words that changed inside it a step deeper (compact
// Review's word marks). One number per row, on the side the row lives on. Off-screen files skip layout and
// paint (`content-visibility: auto`), sized meanwhile from their row count,
// so a 5,000-line diff scrolls like a short one. A file past the first
// screenful builds its rows only once scrolled near (then keeps them): a
// 100-file change opens at the cost of its first few files. Rows are parsed
// once per file object; a large file starts collapsed behind "Show N lines".

import { cn } from "@caveman-app/ui/lib/cn";
import { textDirection } from "@caveman-app/ui/ai/text-direction";
import { CODE_THEME } from "@caveman-app/ui/ai/code-block";
import { languageFromPath, useHighlightedCode } from "@caveman-app/ui/ai/highlight";
import { FileTypeIcon } from "@caveman-app/ui/icons/file-type";
import { Icon, ArrowDataTransferHorizontalIcon, ArrowRight01Icon, FileTextIcon } from "@caveman-app/ui/icons/huge";
import { isValidElement, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { commentKey, type LineComment } from "./comments.ts";
import { intraline, type Span } from "./intraline.ts";
import type { MoveMark } from "./moves.ts";
import { BarButton } from "../chrome.tsx";
import { LARGE_LINES, linesOf, maxLineNo, patchLines, type DiffFile, type DiffLine } from "./parsePatch.ts";

const ROW_PX = 20;
const HEADER_PX = 36;
/** Past this many rows a file's lines stay plain: tokenizing runs on the main thread (highlight.ts). */
const HIGHLIGHT_MAX_ROWS = 2000;
/** How far beyond the Changes scroller's edges a file builds its rows. */
const NEAR_PX = 1500;

/**
 * Each side's lines through the shared highlighter (packages/ui/src/ai/highlight.ts): the old side is context and
 * removed lines, the new side context and added ones, so a line is coloured in the grammar of the file it came from.
 * One node per diff line, in order; plain text until the language loads, or for a file too long to tokenize.
 */
function useDiffHighlight(lines: ReadonlyArray<DiffLine>, path: string): ReadonlyArray<ReactNode> {
  const language = lines.length > HIGHLIGHT_MAX_ROWS ? null : languageFromPath(path);
  const sides = useMemo(() => {
    const before: string[] = [];
    const after: string[] = [];
    for (const l of lines) {
      if (l.kind === "del" || l.kind === "ctx") before.push(l.text);
      if (l.kind === "add" || l.kind === "ctx") after.push(l.text);
    }
    return { before: before.join("\n"), after: after.join("\n") };
  }, [lines]);
  const before = useHighlightedCode(sides.before, language);
  const after = useHighlightedCode(sides.after, language);
  return useMemo(() => {
    let b = 0;
    let a = 0;
    return lines.map((l) => {
      if (l.kind === "hunk") return l.text;
      if (l.kind === "del") return before[b++] ?? l.text;
      if (l.kind === "ctx") b++;
      return after[a++] ?? l.text;
    });
  }, [lines, before, after]);
}

export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return { dir: at < 0 ? "" : path.slice(0, at + 1), name: path.slice(at + 1) };
}

const ROW: Record<DiffLine["kind"], string> = {
  add: "bg-diff-add-ink/[0.10] shadow-[inset_3px_0_0_hsl(var(--diff-add)/0.55)]",
  del: "bg-diff-del-ink/[0.10] shadow-[inset_3px_0_0_hsl(var(--diff-del)/0.55)]",
  ctx: "",
  hunk: "border-y border-foreground/[0.06] bg-foreground/[0.025] text-[11px] text-[hsl(var(--subtle-foreground))]",
};
/** Moved code is neither new nor gone: a grey tint and bar, the sign kept but quiet. */
const MOVED_ROW = "bg-foreground/[0.035] shadow-[inset_3px_0_0_hsl(var(--muted-foreground)/0.45)]";
/** The words that changed inside a changed line: the row's ink a step deeper. */
const MARK: Record<"add" | "del", string> = { add: "bg-diff-add-ink/[0.26]", del: "bg-diff-del-ink/[0.26]" };
const SIGN_TONE: Record<DiffLine["kind"], string> = { add: "text-diff-add-ink", del: "text-diff-del-ink", ctx: "", hunk: "" };
const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: "", hunk: "" };

export const FileDiff = memo(function FileDiff({
  file,
  collapsed,
  wrap,
  onToggle,
  onOpen,
  onMenu,
  review,
  eager,
  shownPath,
}: {
  file: DiffFile;
  /** The path its header shows, when not the file's own: inside its source, for a chat in several (state/sources.ts). */
  shownPath?: string | undefined;
  collapsed: boolean;
  /** In the first screenful: rows from the first render, not once scrolled near. */
  eager: boolean;
  wrap: boolean;
  /** Set the file's collapsed state. */
  onToggle: (path: string, collapsed: boolean) => void;
  onOpen: (path: string) => void;
  /** Right-click on the header: the file's menu (Open in the editor, Reveal in Finder, its path). */
  onMenu?: ((file: DiffFile, event: MouseEvent) => void) | undefined;
  /** Line comments: this file's, the line being written on (its key), and what a row's + does. */
  review?: Review | undefined;
}) {
  const lines = collapsed ? null : linesOf(file);
  const size = patchLines(file);
  const { dir, name } = splitPath(shownPath ?? file.path);
  // What the shown path leaves off the front (its source's name) comes off a moved file's old path too.
  const lead = shownPath !== undefined && file.path.endsWith(shownPath) ? file.path.slice(0, file.path.length - shownPath.length) : "";
  const oldPath = file.old_path && lead && file.old_path.startsWith(lead) ? file.old_path.slice(lead.length) : file.old_path;
  const [near, setNear] = useState(eager);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = box.current;
    if (near || !lines || !el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), {
      root: el.closest("[data-diff-scroller]"),
      rootMargin: `${NEAR_PX}px 0px`,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [near, lines]);

  return (
    <section
      ref={box}
      data-diff-path={file.path}
      className="border-b border-foreground/[0.06] [content-visibility:auto]"
      style={{ containIntrinsicSize: `auto ${HEADER_PX + (lines ? Math.max(1, lines.length) * ROW_PX : 0)}px` }}
    >
      <header onContextMenu={onMenu ? (e) => onMenu(file, e) : undefined} className={cn("sticky top-0 z-10 flex h-9 items-center gap-1 bg-background/85 pr-1.5 backdrop-blur-xl transition-colors duration-100 hover:bg-foreground/[0.03]", !collapsed && "border-b border-foreground/[0.06]")}>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => onToggle(file.path, !collapsed)}
          title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon icon={ArrowRight01Icon} className={cn("size-3.5 shrink-0 text-[hsl(var(--subtle-foreground))] transition-transform duration-150 ease-snap", !collapsed && "rotate-90")} />
          <FileTypeIcon path={file.path} className="ml-0.5 size-[15px]" />
 {/* The name first, then its folder, which gives way first (compact file header). */}
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={cn("max-w-full shrink-0 truncate text-[12px] font-medium text-foreground/90", file.status === "deleted" && "line-through decoration-foreground/40")}>{name}</span>
            <span className="min-w-0 truncate text-[11px] text-[hsl(var(--subtle-foreground))]">
              {oldPath ? <span>{oldPath} → </span> : null}
              {dir.replace(/\/$/, "")}
            </span>
          </span>
        </button>
        {collapsed && size > LARGE_LINES ? (
          <button
            type="button"
            onClick={() => onToggle(file.path, false)}
            className="h-6 shrink-0 rounded-md px-1.5 text-[12px] tabular-nums text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            Show {size.toLocaleString()} lines
          </button>
        ) : null}
        <span className="flex shrink-0 gap-1.5 pl-1 text-[11px] font-semibold tabular-nums">
          {file.additions > 0 ? <span className="text-diff-add-ink">+{file.additions}</span> : null}
          {file.deletions > 0 ? <span className="text-diff-del-ink">−{file.deletions}</span> : null}
        </span>
        {file.status !== "deleted" ? (
          <BarButton size="sm" label="Open file" onClick={() => onOpen(file.path)}>
            <Icon icon={FileTextIcon} />
          </BarButton>
        ) : (
          // Keeps the counts in line with the files that have the button.
          <span aria-hidden className="size-6 shrink-0" />
        )}
      </header>

      {!lines ? null : lines.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-muted-foreground">{file.status === "deleted" ? "File deleted." : "Binary file, or only its mode changed."}</p>
      ) : !near ? (
        <div style={{ height: lines.length * ROW_PX }} />
      ) : (
        <DiffRows file={file} lines={lines} wrap={wrap} review={review} />
      )}
    </section>
  );
});

/**
 * A file's rows: one number per row at 30% ink (the old line's on a removed row, the new line's on the rest), the sign
 * in the diff ink, the code coloured by its language with its changed words marked. Hunk rows draw through
 * `renderHunk` where the caller has its own (Review's "Show N lines" bars), else as a quiet `@@` line.
 */
export function DiffRows({
  file,
  lines,
  wrap,
  review,
  moves,
  onMove,
  renderHunk,
  className,
}: {
  file: DiffFile;
  lines: ReadonlyArray<DiffLine>;
  wrap: boolean;
  review?: Review | undefined;
  /** Rows that moved, and what a click on a move's label does. */
  moves?: ReadonlyMap<DiffLine, MoveMark> | undefined;
  onMove?: ((to: MoveMark["to"]) => void) | undefined;
  renderHunk?: ((line: DiffLine, index: number) => ReactNode) | undefined;
  className?: string | undefined;
}) {
  const text = useDiffHighlight(lines, file.path);
  const marks = useMemo(() => intraline(lines), [lines]);
  return (
    // The number gutter holds three digits at least, so files under 1,000 lines share one code edge down a review
    // (8 lines and 20 lines no longer start their code a digit apart).
    <div className={cn("font-mono text-[12px] leading-5", !wrap && "overflow-x-auto overscroll-x-contain", className)} style={{ ...CODE_THEME, ["--ln" as string]: `${Math.max(3, String(maxLineNo(lines)).length)}ch` }}>
      <div className={cn(!wrap && "w-max min-w-full")}>
        {lines.map((l, i) => {
          if (l.kind === "hunk")
            return renderHunk ? (
              <div key={i}>{renderHunk(l, i)}</div>
            ) : (
              <div key={i} className={cn("truncate py-1 pl-[calc(var(--ln)+44px)] pr-3", ROW.hunk)}>
                {l.text}
              </div>
            );
          const moved = moves?.get(l);
          const spans = moved ? undefined : marks.get(i);
          const n = l.kind === "del" ? l.oldNo : l.newNo;
          return (
            <div key={i}>
              <div className={cn("group/row relative flex", moved ? MOVED_ROW : ROW[l.kind])} data-path={file.path} data-line={n ?? undefined} data-side={l.kind === "del" ? "old" : "new"}>
                <span aria-hidden className="w-[calc(var(--ln)+20px)] shrink-0 select-none pr-2.5 text-right text-[11px] tabular-nums text-[hsl(var(--subtle-foreground))]">
                  {n}
                </span>
                {review ? (
                  // The sign's cell turns into a + on hover: a comment on this line.
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Comment on line ${n}`}
                    onClick={() => review.onStart(anchorOf(file.path, l))}
                    className={cn("relative h-5 w-5 shrink-0 self-start select-none text-center outline-none", moved ? "text-muted-foreground" : SIGN_TONE[l.kind])}
                  >
                    <span className="group-hover/row:invisible">{SIGN[l.kind]}</span>
                    <span aria-hidden className="invisible absolute inset-0 m-auto grid size-4 place-items-center rounded bg-primary text-[11px] leading-none text-primary-foreground group-hover/row:visible">+</span>
                  </button>
                ) : (
                  <span className={cn("w-5 shrink-0 select-none text-center", moved ? "text-muted-foreground" : SIGN_TONE[l.kind])}>{SIGN[l.kind]}</span>
                )}
                {/* Wrapped, a line's further rows hang 2ch in, so they read as its continuation, never as a line of their own. */}
                <span data-code className={cn("min-w-0 flex-1 pr-6 text-[color:var(--shiki-foreground)]", wrap ? "whitespace-pre-wrap pl-[calc(0.25rem+2ch)] -indent-[2ch] [overflow-wrap:anywhere]" : "whitespace-pre pl-1")}>
                  {spans && (l.kind === "add" || l.kind === "del") ? withMarks(text[i], spans, MARK[l.kind]) : text[i]}
                </span>
                {moved?.first ? <MovedLabel mark={moved} side={l.kind === "del" ? "old" : "new"} onMove={onMove} /> : null}
              </div>
              {review ? <LineNotes review={review} anchor={anchorOf(file.path, l)} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The first row of a moved block says where the block went (or came from); a click goes there. */
function MovedLabel({ mark, side, onMove }: { mark: MoveMark; side: "old" | "new"; onMove?: ((to: MoveMark["to"]) => void) | undefined }) {
  const { name } = splitPath(mark.to.path);
  const label = `${side === "old" ? "Moved to" : "Moved from"} ${name}:${mark.to.line}`;
  return (
    <span className="sticky right-1.5 flex shrink-0 items-center self-center pl-2">
      <button
        type="button"
        title={`${label} (${mark.size} ${mark.size === 1 ? "line" : "lines"}, ${mark.to.path})`}
        onClick={() => onMove?.(mark.to)}
        disabled={!onMove}
        className="flex h-[18px] items-center gap-1 rounded-[5px] bg-background/90 px-1.5 font-sans text-[11px] text-muted-foreground shadow-[0_0_0_1px_hsl(var(--border))] outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:hover:text-muted-foreground"
      >
        <Icon icon={ArrowDataTransferHorizontalIcon} className="size-3" />
        {label}
      </button>
    </span>
  );
}

/**
 * The highlighter's line (strings and coloured spans) with the changed stretches marked: each token is cut where a
 * stretch starts or ends and keeps its colour on both sides of the cut.
 */
export function withMarks(line: ReactNode, spans: ReadonlyArray<Span>, mark: string): ReactNode {
  const segments: Array<{ text: string; style?: CSSProperties | undefined }> = [];
  const walk = (node: ReactNode, style?: CSSProperties) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") segments.push({ text: String(node), style });
    else if (Array.isArray(node)) for (const child of node) walk(child as ReactNode, style);
    else if (isValidElement<{ style?: CSSProperties; children?: ReactNode }>(node)) walk(node.props.children, node.props.style ?? style);
  };
  walk(line);
  const out: ReactNode[] = [];
  let pos = 0;
  let s = 0;
  segments.forEach((seg, k) => {
    let at = 0;
    while (at < seg.text.length) {
      while (s < spans.length && spans[s]![1] <= pos + at) s++;
      const span = spans[s];
      const inside = span !== undefined && span[0] <= pos + at;
      const stop = span === undefined ? seg.text.length : Math.min(seg.text.length, (inside ? span[1] : span[0]) - pos);
      const piece = seg.text.slice(at, stop);
      out.push(
        inside ? (
          <span key={`${k}-${at}`} className={mark} style={seg.style}>
            {piece}
          </span>
        ) : seg.style ? (
          <span key={`${k}-${at}`} style={seg.style}>
            {piece}
          </span>
        ) : (
          piece
        ),
      );
      at = stop;
    }
    pos += seg.text.length;
  });
  return out;
}

/** What the Changes tab passes a file for line comments. */
export interface Review {
  readonly comments: ReadonlyArray<LineComment>;
  /** The line being written on, by commentKey. */
  readonly drafting: string | null;
  readonly onStart: (anchor: Omit<LineComment, "text">) => void;
  readonly onSave: (anchor: Omit<LineComment, "text">, text: string) => void;
  readonly onCancel: () => void;
  /** Absent: comments that aren't the person's to remove (a pull request's, on its host). */
  readonly onRemove?: ((comment: LineComment) => void) | undefined;
  /** Draws a line's comments itself (a pull request's threads, with replies); `comments` then only says which lines have some. */
  readonly renderNotes?: ((anchor: Omit<LineComment, "text">, comments: ReadonlyArray<LineComment>) => ReactNode) | undefined;
}

const anchorOf = (path: string, l: DiffLine): Omit<LineComment, "text"> =>
  l.kind === "del" ? { path, side: "old", line: l.oldNo ?? 0, code: l.text } : { path, side: "new", line: l.newNo ?? 0, code: l.text };

/** Under a line: its comments, and the box while one is written on it. */
function LineNotes({ review, anchor }: { review: Review; anchor: Omit<LineComment, "text"> }) {
  const key = commentKey(anchor);
  const mine = review.comments.filter((c) => commentKey(c) === key);
  const drafting = review.drafting === key;
  if (mine.length === 0 && !drafting) return null;
  if (review.renderNotes)
    return (
      <div className="font-sans">
        {mine.length > 0 ? review.renderNotes(anchor, mine) : null}
        {drafting ? (
          <div className="border-y border-border bg-card px-3 py-2">
            <CommentBox onSave={(text) => review.onSave(anchor, text)} onCancel={review.onCancel} line={anchor.line} />
          </div>
        ) : null}
      </div>
    );
  return (
    <div className="border-y border-border bg-card px-3 py-2 font-sans">
      {mine.map((c, i) => (
        <div key={i} className="flex items-start gap-2 py-0.5 text-[13px] leading-5">
          <p dir={textDirection(c.text)} className="min-w-0 flex-1 whitespace-pre-wrap text-foreground">{c.text}</p>
          {review.onRemove ? (
            <button
              type="button"
              onClick={() => review.onRemove?.(c)}
              className="h-6 shrink-0 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      {drafting ? <CommentBox onSave={(text) => review.onSave(anchor, text)} onCancel={review.onCancel} line={anchor.line} /> : null}
    </div>
  );
}

function CommentBox({ onSave, onCancel, line }: { onSave: (text: string) => void; onCancel: () => void; line: number }) {
  const [text, setText] = useState("");
  const save = () => text.trim() && onSave(text.trim());
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        autoFocus
        value={text}
        rows={2}
 // Written in Arabic or Hebrew, the comment reads right to left as it is typed (upstream #24050).
        dir={textDirection(text) ?? "auto"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        aria-label={`Comment on line ${line}`}
        placeholder="What should change here?"
        className="min-h-[52px] w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] leading-5 text-foreground outline-none placeholder:text-[hsl(var(--subtle-foreground))] focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="h-7 rounded-md px-2.5 text-[12.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Cancel
        </button>
        <button
          type="button"
          disabled={!text.trim()}
          onClick={save}
          className="h-7 rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          Comment
        </button>
      </div>
    </div>
  );
}
