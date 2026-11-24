// Images in engine markdown, read the same way by the renderer (response.tsx)
// and the app's artifact model, so a message's gallery holds exactly the
// images its text stops drawing. Inline images only (`![alt](src "title")`);
// fenced code and inline code spans are not images.
import { fenceAfter, type Fence } from "./fence.ts";

/** An image whose destination CommonMark would refuse: unbracketed, with spaces (and balanced parentheses). */
const LOOSE = /!\[([^\]\n]*)\]\(\s*((?:[^()<>\n]|\([^()<>\n]*\))+?\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico))\s*(\s"[^"\n]*")?\)/gi;
const IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^<>\n]+)>|([^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*))(?:\s+"[^"\n]*")?\s*\)/g;

export interface MarkdownImage {
  readonly alt: string;
  readonly src: string;
  /** 1-based source line. */
  readonly line: number;
  /** Offset of the image in its line, so two on one line stay apart. */
  readonly column: number;
}

/**
 * Agents write paths with spaces (`![after](/Users/me/My App/after.png)`),
 * which CommonMark reads as text. Such a destination gets wrapped in <> so it
 * renders as the image it is. Line count and every other byte stay put.
 */
export function normalizeImageLinks(md: string): string {
  if (!md.includes("![")) return md;
  let changed = false;
  const lines = md.split("\n");
  eachProseLine(lines, (line, i) => {
    if (!line.includes("![")) return;
    const next = line.replace(LOOSE, (whole: string, alt: string, path: string, title: string | undefined, at: number) => {
      if (!/\s/.test(path) || inCode(line, at)) return whole;
      return `![${alt}](<${path.trim()}>${title ?? ""})`;
    });
    if (next !== line) {
      lines[i] = next;
      changed = true;
    }
  });
  return changed ? lines.join("\n") : md;
}

/** Every inline image in markdown, in source order: pictures only, not the audio, video or other files `![]()` names. Pass text through normalizeImageLinks first. */
export function markdownImages(md: string): MarkdownImage[] {
  const out: MarkdownImage[] = [];
  if (!md.includes("![")) return out;
  eachProseLine(md.split("\n"), (line, i) => {
    for (const m of line.matchAll(IMAGE)) {
      if (inCode(line, m.index)) continue;
      const src = (m[2] ?? m[3] ?? "").trim();
      if (src && sourceKind(src) === "image") out.push({ alt: m[1] ?? "", src, line: i + 1, column: m.index });
    }
  });
  return out;
}

const AUDIO = /\.(mp3|wav|m4a|aac|oga|ogg|opus|flac|aiff?|weba)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|ogv)$/i;
const PICTURE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;

/**
 * What an image destination holds, by its name (T3 #21363): audio and video play where the answer puts them, and
 * any other named file (`![report](out/report.pdf)`) is a file to open. A picture, a data: image, and a web address
 * whose name says nothing (an image service's) draw as pictures.
 */
export function sourceKind(src: string): "image" | "audio" | "video" | "file" {
  const s = src.trim().replace(/^<(.*)>$/, "$1");
  if (/^data:/i.test(s)) return /^data:audio\//i.test(s) ? "audio" : /^data:video\//i.test(s) ? "video" : "image";
  const path = s.split(/[?#]/, 1)[0] ?? "";
  if (AUDIO.test(path)) return "audio";
  if (VIDEO.test(path)) return "video";
  if (PICTURE.test(path) || /^https?:/i.test(s)) return "image";
  return /\.[a-z0-9]{1,10}$/i.test(path.split(/[\\/]/).pop() ?? "") ? "file" : "image";
}

/** Lines outside fenced code blocks. */
function eachProseLine(lines: string[], visit: (line: string, index: number) => void): void {
  let fence: Fence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const open = fence;
    fence = fenceAfter(open, lines[i]!);
    if (!open && !fence) visit(lines[i]!, i);
  }
}

/** Inside an inline code span: an odd number of backticks before it on the line. */
function inCode(line: string, at: number): boolean {
  let ticks = 0;
  for (let i = 0; i < at; i++) if (line[i] === "`") ticks++;
  return ticks % 2 === 1;
}
