// One excerpt of a guide stop: the lines that carry the stop's idea, cut from the pull request's patch, coloured by
// the shared highlighter, with the stop's notes under the lines they explain. Every row says where it is
// (data-path/-line/-side) so a highlighted passage can be commented on or handed to an agent.
import type { PrGuideStop } from "@caveman-app/session-protocol";
import { languageFromPath, useHighlightedCode } from "@caveman-app/ui/ai/highlight";
import { CODE_THEME } from "@caveman-app/ui/ai/code-block";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowUpRight01Icon } from "@caveman-app/ui/icons/huge";
import { memo, useMemo } from "react";
import { withMarks } from "../../panels/diff/FileDiff.tsx";
import { intraline } from "../../panels/diff/intraline.ts";
import { linesOf, type DiffFile, type DiffLine } from "../../panels/diff/parsePatch.ts";
import { excerptRows, splitPath } from "./model.ts";
import { Prose } from "./parts.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

type Excerpt = PrGuideStop["excerpts"][number];
type Note = PrGuideStop["notes"][number];

// The Files rows' inks (FileDiff.tsx): a 10% tint and a 3px bar, the changed words a step deeper.
const ROW = {
  add: "bg-diff-add-ink/[0.10] shadow-[inset_3px_0_0_hsl(var(--diff-add)/0.55)]",
  del: "bg-diff-del-ink/[0.10] shadow-[inset_3px_0_0_hsl(var(--diff-del)/0.55)]",
  ctx: "",
  hunk: "",
} as const;
const MARK = { add: "bg-diff-add-ink/[0.26]", del: "bg-diff-del-ink/[0.26]" } as const;
const SIGN = { add: "+", del: "−", ctx: "", hunk: "" } as const;

export const ExcerptView = memo(function ExcerptView({
  excerpt,
  file,
  notes,
  loading,
  onOpenFile,
}: {
  excerpt: Excerpt;
  /** Undefined while the diff loads, or when the host left the file out. */
  file: DiffFile | undefined;
  notes: ReadonlyArray<Note>;
  loading: boolean;
  onOpenFile: (path: string, line?: number, side?: "new" | "old") => void;
}) {
  const rows = useMemo(() => (file ? excerptRows(linesOf(file), excerpt.side, excerpt.start, excerpt.end) : []), [file, excerpt]);
  const { dir, name } = splitPath(excerpt.path);
  const where = `${excerpt.path}:${excerpt.start}-${excerpt.end}${excerpt.side === "old" ? " (removed lines)" : ""}`;

  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-card/30" data-passage={where}>
      <figcaption className="flex h-9 items-center gap-2 border-b border-border/70 pl-3 pr-1.5">
        <span className="shrink-0 font-mono text-[12.5px] text-foreground">{name}</span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-[hsl(var(--subtle-foreground))]">{dir}</span>
        {excerpt.caption ? <span className="ml-1 min-w-0 truncate text-[12.5px] text-muted-foreground">{excerpt.caption}</span> : null}
        <button
          type="button"
          onClick={() => onOpenFile(excerpt.path, excerpt.start, excerpt.side)}
          className="ml-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          L{excerpt.start}
          <Icon icon={ArrowUpRight01Icon} className="size-3.5" />
        </button>
      </figcaption>
      {rows.length === 0 ? (
        loading ? (
          <div className="space-y-2 px-4 py-3" aria-busy>
            {Array.from({ length: Math.min(8, excerpt.end - excerpt.start + 1) }, (_, i) => (
              <div key={i} className="h-3 rounded bg-foreground/[0.05]" style={{ width: `${40 + ((i * 37) % 50)}%` }} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-3 text-[12.5px] text-muted-foreground">These lines aren't in the diff GitHub sent. Open the file to read them.</p>
        )
      ) : (
        <CodeRows rows={rows} path={excerpt.path} notes={notes} />
      )}
    </figure>
  );
});

/**
 * Diff rows as a reader sees them: coloured by the shared highlighter, line numbers on the side each row lives on, a
 * note under the line it explains. A block that is all new (or all removed) code drops the tint and signs for one rule
 * down its side; a wall of green reads worse than plain code.
 */
export function CodeRows({ rows, path, notes = [], className }: { rows: ReadonlyArray<DiffLine>; path: string; notes?: ReadonlyArray<Note>; className?: string }) {
  const code = useHighlightedCode(rows.map((r) => r.text).join("\n"), languageFromPath(path));
  const marks = useMemo(() => intraline(rows), [rows]);
  const only = rows.length > 0 && rows.every((r) => r.kind === rows[0]!.kind) ? rows[0]!.kind : null;
  return (
    <div
      style={CODE_THEME}
      className={cn(
        "overflow-x-auto py-1.5 font-mono text-[12.5px] leading-5 [scrollbar-width:thin]",
        only === "add" && "shadow-[inset_3px_0_0_hsl(var(--diff-add)/0.55)]",
        only === "del" && "shadow-[inset_3px_0_0_hsl(var(--diff-del)/0.55)]",
        className,
      )}
    >
      <div className="min-w-max">
        {rows.map((row, i) => {
          const n = row.kind === "del" ? row.oldNo : row.newNo;
          const side = row.kind === "del" ? "old" : "new";
          const here = n === null ? [] : notes.filter((note) => note.path === path && note.line === n);
          return (
            <div key={i}>
              <div className={cn("flex pr-4", here.length > 0 ? "bg-foreground/[0.06]" : !only && ROW[row.kind])} data-path={path} data-line={n ?? undefined} data-side={side}>
                <span className="w-12 shrink-0 select-none pr-3 text-right tabular-nums text-[hsl(var(--subtle-foreground))]">{n}</span>
                {only ? null : <span className={cn("w-4 shrink-0 select-none", row.kind === "add" ? "text-diff-add-ink" : "text-diff-del-ink")}>{SIGN[row.kind]}</span>}
                <span data-code className={cn("whitespace-pre", only === "del" && "opacity-70")}>
                  {marks.has(i) && (row.kind === "add" || row.kind === "del") ? withMarks(code[i] ?? row.text, marks.get(i)!, MARK[row.kind]) : (code[i] ?? row.text)}
                </span>
              </div>
              {here.map((note, k) => (
                // A callout, not code: sans, its own surface, the bust saying who explains.
                <aside key={k} className="my-2 ml-12 mr-4 flex max-w-[560px] gap-2.5 whitespace-normal rounded-lg bg-popover px-3 py-2.5 font-sans shadow-[0_0_0_1px_hsl(var(--border)),0_2px_6px_hsl(0_0%_0%/0.18)]">
                  <Glyph name="engine-caveman" className="mt-px shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold leading-5 text-foreground">{note.title}</p>
                    {note.body ? <Prose text={note.body} className="mt-0.5 block text-[13px] leading-[1.55] text-muted-foreground" /> : null}
                  </div>
                </aside>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
