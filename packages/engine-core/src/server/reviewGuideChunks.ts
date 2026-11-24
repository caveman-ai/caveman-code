/**
 * A single pass's diff cut into labelled chunks the model cites by id
 * (docs/, "Measured"). Returning line numbers made Haiku
 * read and count them: citing `C3` and quoting a fragment of one line cut its output by a third,
 * and code turns both back into ranges that land every time.
 *
 * @module textGeneration/reviewGuideChunks
 */
import type {
  PullRequestReviewGuideExcerpt,
  PullRequestReviewGuideNote,
} from "@caveman-app/protocol";

export interface ReviewGuideChunkLine {
  /** The raw diff line, marker first. */
  readonly text: string;
  /** Its line number on each side, null where it is not on that side. */
  readonly old: number | null;
  readonly new: number | null;
}

export interface ReviewGuideChunk {
  /** `C1..Cn` in diff order. */
  readonly id: string;
  readonly path: string;
  readonly lines: ReadonlyArray<ReviewGuideChunkLine>;
}

/** A chunk ends at a blank context line once it is this long. */
const CHUNK_LINES = 24;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const isChange = (line: ReviewGuideChunkLine) => line.text[0] === "+" || line.text[0] === "-";

/**
 * Cuts a unified diff (fixed a/ b/ prefixes) into chunks: per hunk, split after a blank context
 * line once a chunk has 24 lines. Only chunks that add or remove a line are kept.
 */
export function reviewGuideChunks(diff: string): ReadonlyArray<ReviewGuideChunk> {
  const cut: Array<{ path: string; lines: Array<ReviewGuideChunkLine> }> = [];
  let oldPath: string | null = null;
  let path: string | null = null;
  // Null outside a file's hunks, where `--- ` and `+++ ` lines are headers, not source.
  let lines: Array<ReviewGuideChunkLine> | null = null;
  let oldNo = 0;
  let newNo = 0;
  const close = () => {
    if (path !== null && lines !== null && lines.some(isChange)) cut.push({ path, lines });
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      close();
      [oldPath, path, lines] = [null, null, null];
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk !== null && path !== null) {
      close();
      [oldNo, newNo, lines] = [Number(hunk[1]), Number(hunk[2]), []];
    } else if (lines === null) {
      if (line.startsWith("--- ")) oldPath = line.startsWith("--- a/") ? line.slice(6) : null;
      // A deleted file's hunks sit under its old path, as the normalizer keys them.
      else if (line.startsWith("+++ ")) path = line.startsWith("+++ b/") ? line.slice(6) : oldPath;
    } else if (line.startsWith("+")) {
      lines.push({ text: line, old: null, new: newNo++ });
    } else if (line.startsWith("-")) {
      lines.push({ text: line, old: oldNo++, new: null });
    } else if (line.startsWith(" ")) {
      lines.push({ text: line, old: oldNo++, new: newNo++ });
      if (line.trim() === "" && lines.length >= CHUNK_LINES) {
        close();
        lines = [];
      }
    }
  }
  close();
  return cut.map((chunk, index) => ({ id: `C${index + 1}`, ...chunk }));
}

/** "old" only for a chunk that removes lines and adds none. */
const sideOf = (chunk: ReviewGuideChunk): "new" | "old" =>
  chunk.lines.some((line) => line.text[0] === "+") ? "new" : "old";

/** `[C3] path (new 8951-8958)`, then the chunk's raw diff lines; chunks apart by a blank line. */
export function renderReviewGuideChunks(chunks: ReadonlyArray<ReviewGuideChunk>): string {
  return chunks
    .map((chunk) => {
      const side = sideOf(chunk);
      const numbers = chunk.lines.flatMap((line) => (line[side] === null ? [] : [line[side]]));
      const range = `${side} ${numbers[0]}-${numbers.at(-1)}`;
      return `[${chunk.id}] ${chunk.path} (${range})\n${chunk.lines.map((line) => line.text).join("\n")}`;
    })
    .join("\n\n");
}

/**
 * A cited chunk as an excerpt: its changed lines on its side, padded by up to two context lines
 * inside the chunk.
 */
export function chunkExcerpt(chunk: ReviewGuideChunk, caption: string): PullRequestReviewGuideExcerpt {
  const side = sideOf(chunk);
  const onSide = chunk.lines.filter((line) => line[side] !== null);
  const first = onSide.findIndex(isChange);
  const last = onSide.findLastIndex(isChange);
  return {
    path: chunk.path,
    side,
    start: onSide[Math.max(0, first - 2)]![side]!,
    end: onSide[Math.min(onSide.length - 1, last + 2)]![side]!,
    caption,
  };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The line on the chunk's side whose text holds the quote, a changed one first; null for none. */
export function chunkQuoteLine(chunk: ReviewGuideChunk, quote: string): number | null {
  const wanted = squash(quote);
  if (wanted === "") return null;
  const side = sideOf(chunk);
  const hits = chunk.lines.filter(
    (line) => line[side] !== null && squash(line.text.slice(1)).includes(wanted),
  );
  return (hits.find(isChange) ?? hits[0])?.[side] ?? null;
}

interface ChunkStop {
  readonly chunks: ReadonlyArray<{ readonly id: string; readonly caption: string }>;
  readonly notes: ReadonlyArray<{
    readonly chunk: string;
    readonly quote: string;
    readonly title: string;
    readonly body: string;
  }>;
}

/**
 * A stop that cites chunks, as one with excerpts and line-anchored notes. A quote no line holds is
 * dropped. An unknown id stays as an excerpt that lands nowhere (path `?C9`), so the guide check
 * counts it among dropped excerpts, as it does a bad line range, and the normalizer then drops it.
 */
export function resolveChunkStop<S extends ChunkStop>(
  stop: S,
  chunks: ReadonlyArray<ReviewGuideChunk>,
): Omit<S, "chunks" | "notes"> & {
  excerpts: Array<PullRequestReviewGuideExcerpt>;
  notes: Array<PullRequestReviewGuideNote>;
} {
  // Tolerates "[C3]", "c3" and "3".
  const find = (id: string) => chunks.find((chunk) => chunk.id === `C${/\d+/.exec(id)?.[0]}`);
  const { chunks: cited, notes, ...rest } = stop;
  return {
    ...rest,
    excerpts: cited.flatMap(({ id, caption }) => {
      const chunk = find(id);
      return [chunk === undefined ? { path: `?${id}`, side: "new" as const, start: 1, end: 1, caption } : chunkExcerpt(chunk, caption)];
    }),
    notes: notes.flatMap(({ chunk: id, quote, title, body }) => {
      const chunk = find(id);
      const line = chunk === undefined ? null : chunkQuoteLine(chunk, quote);
      return chunk === undefined || line === null ? [] : [{ path: chunk.path, line, title, body }];
    }),
  };
}
