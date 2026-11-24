import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CodeBlock } from "../ai/code-block";
import { highlightLines, languageFromPath, resolveLanguage, type GrammarState } from "../ai/highlight";
import { cn } from "../lib/cn";

// The side panel's file viewer: any size of file, line numbers, wrap, reveal.
// It sits inside ui-chat's CodeBlock (CODE_THEME, the one code palette) and
// tokenizes through ai/highlight.ts, the one Shiki. Plain text paints at once;
// a chunk's tokens swap in, colour only, as it nears the viewport, carrying
// the grammar state from the chunk above. Row styles: styles/markdown.css.

const CHUNK_LINES = 100;
const LINE_PX = 19; // CodeBlockContent's line height

export interface CodeViewProps {
  readonly code: string;
  /** Language id, alias or extension (`ts`, `go`); wins over `path`. */
  readonly language?: string | null | undefined;
  /** Picks the language when `language` is absent (`Dockerfile`, `src/a.rs`). */
  readonly path?: string | undefined;
  readonly lineNumbers?: boolean | undefined;
  /** Soft wrap; continuation lines hang under the code column. Off: horizontal scroll. */
  readonly wrap?: boolean | undefined;
  readonly startLine?: number | undefined;
  /** Lines (numbered from `startLine`) that stay marked. Pass a stable array. */
  readonly highlightLines?: ReadonlyArray<number> | undefined;
  /** Scrolls this line to ~1/3 from the top and flashes it; re-runs when it or the code changes. */
  readonly revealLine?: number | undefined;
  /** Give it a height (e.g. `h-full`) and it scrolls itself. */
  readonly className?: string | undefined;
}

interface Painted {
  readonly lines: ReadonlyArray<ReactNode[] | undefined>;
  /** The line texts each chunk's tokens were made from; a row only shows tokens that match it. */
  readonly text: ReadonlyArray<ReadonlyArray<string> | undefined>;
}
const NOTHING: Painted = { lines: [], text: [] };

interface Job {
  readonly lang: string;
  readonly codes: ReadonlyArray<string>;
  readonly lines: Array<ReactNode[] | undefined>;
  readonly states: Array<GrammarState | undefined>;
}

export function CodeView({
  code,
  language,
  path,
  lineNumbers = true,
  wrap = false,
  startLine = 1,
  highlightLines: marks,
  revealLine,
  className,
}: CodeViewProps) {
  const lang = resolveLanguage(language ?? (path ? languageFromPath(path) : null));
  const { chunks, count, maxCols } = useMemo(() => splitChunks(code), [code]);
  const [painted, setPainted] = useState<Painted>(NOTHING);
  const job = useRef<Job | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const marked = useMemo(() => new Set(marks), [marks]);

  useEffect(() => {
    const root = rootRef.current;
    if (!lang || !root) return;
    const codes = chunks.map((lines) => lines.join("\n"));
    const lines: Job["lines"] = [];
    const states: Job["states"] = [];
    const text: Array<ReadonlyArray<string> | undefined> = [];
    // Keep the unchanged leading chunks (a file that grew or changed further down).
    const before = job.current;
    for (let k = 0; before?.lang === lang && before.codes[k] === codes[k] && before.lines[k]; k++) {
      lines[k] = before.lines[k];
      states[k] = before.states[k];
      text[k] = chunks[k];
    }
    job.current = { lang, codes, lines, states };

    // ponytail: a chunk reached by a jump (revealLine, a fast scroll) starts
    // from the grammar's root state when the chunk above has no tokens yet, so
    // a block comment or string spanning that boundary can mis-colour it.
    // Upgrade: tokenize forward from the nearest known state in idle time.
    const wanted = new Set<number>();
    let busy = false;
    let stopped = false;
    const pump = async () => {
      if (busy) return;
      busy = true;
      while (!stopped && wanted.size > 0) {
        const k = Math.min(...wanted);
        wanted.delete(k);
        if (lines[k]) continue;
        const chunk = await highlightLines(codes[k]!, lang, states[k - 1]).catch(() => null);
        if (stopped) return;
        if (!chunk) break; // Shiki failed to load: stay plain
        lines[k] = chunk.lines;
        states[k] = chunk.state;
        text[k] = chunks[k];
        setPainted({ lines: lines.slice(), text: text.slice() });
        await new Promise((resolve) => setTimeout(resolve, 0)); // let the frame paint
      }
      busy = false;
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const k = Number((entry.target as HTMLElement).dataset.chunk);
          wanted.add(k);
          if (k + 1 < codes.length) wanted.add(k + 1); // the next chunk inherits this one's state
        }
        void pump();
      },
      // Rooted at the scroller so the margin prefetches inside nested panes too.
      { root: scrollParent(root), rootMargin: "400px 0px" },
    );
    for (const el of root.querySelectorAll("[data-chunk]")) io.observe(el);
    return () => {
      stopped = true;
      io.disconnect();
    };
  }, [chunks, lang]);

  useEffect(() => {
    const root = rootRef.current;
    const row = revealLine === undefined ? null : root?.querySelector<HTMLElement>(`[data-n="${revealLine}"]`);
    if (!root || !row) return;
    if (root.scrollHeight > root.clientHeight) {
      root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 3;
    } else {
      row.scrollIntoView({ block: "center" });
    }
    row.classList.remove("cv-flash");
    void row.offsetWidth; // restart the animation when the same line is revealed again
    row.classList.add("cv-flash");
  }, [revealLine, chunks]);

  const gutter = lineNumbers ? `${String(startLine + count - 1).length}ch` : "0px";
  return (
    <CodeBlock className={cn("rounded-none border-0 bg-transparent", className)}>
      <div
        ref={rootRef}
        className={cn("cv min-h-0 flex-1 overflow-auto py-2.5 font-mono leading-[19px]", wrap && "cv-wrap", !lineNumbers && "cv-plain")}
        style={{ "--cv-gutter": gutter } as CSSProperties}
      >
        <div className="cv-body" style={wrap ? undefined : { minWidth: `calc(${maxCols}ch + var(--cv-gutter) + 44px)` }}>
          {chunks.map((lines, k) => {
            const own = lang ? painted.lines[k] : undefined;
            return (
              <Chunk
                key={k}
                index={k}
                first={startLine + k * CHUNK_LINES}
                lines={lines}
                tokens={own}
                tokenText={own ? painted.text[k] : undefined}
                marked={marked}
              />
            );
          })}
        </div>
      </div>
    </CodeBlock>
  );
}

interface ChunkProps {
  readonly index: number;
  readonly first: number;
  readonly lines: ReadonlyArray<string>;
  readonly tokens: ReactNode[] | undefined;
  readonly tokenText: ReadonlyArray<string> | undefined;
  readonly marked: ReadonlySet<number>;
}

// content-visibility skips layout and paint for chunks out of view; the
// intrinsic height keeps the scrollbar exact until a chunk is first laid out.
const Chunk = memo(function Chunk({ index, first, lines, tokens, tokenText, marked }: ChunkProps) {
  return (
    <div data-chunk={index} className="cv-chunk" style={{ containIntrinsicHeight: `auto ${lines.length * LINE_PX}px` }}>
      {lines.map((text, i) => {
        const n = first + i;
        const line = tokens && tokenText?.[i] === text ? tokens[i] : undefined;
        return (
          <div key={i} data-n={n} className={marked.has(n) ? "cv-line cv-mark" : "cv-line"}>
            <span className="cv-code">{line ?? text}</span>
          </div>
        );
      })}
    </div>
  );
}, (before, after) =>
  before.index === after.index &&
  before.first === after.first &&
  before.marked === after.marked &&
  before.tokens === after.tokens &&
  sameText(before.lines, after.lines) &&
  sameText(before.tokenText, after.tokenText),
);

// A refreshed file splits into new arrays even when most chunks did not
// change. Compare at most one chunk's text before rebuilding its line nodes.
function sameText(a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((line, i) => line === b[i]));
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

function splitChunks(code: string): { chunks: string[][]; count: number; maxCols: number } {
  const lines = code.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // a final newline is not a line
  let maxCols = 0;
  for (const line of lines) if (line.length > maxCols) maxCols = line.length;
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) chunks.push(lines.slice(i, i + CHUNK_LINES));
  return { chunks, count: lines.length, maxCols };
}
