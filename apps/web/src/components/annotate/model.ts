// What a person draws on a picture before it goes to the agent: a pen line, a
// box, an ellipse, an arrow, a line or a few words. Marks are kept in the
// picture's own pixels, so the copy that is saved is drawn exactly as it was
// seen: at the picture's own size, larger for one shown enlarged, smaller for
// one too large for a canvas (copyScale). Nothing here touches the DOM
// (paint.ts draws, Annotator.tsx is the surface).

export type Point = readonly [x: number, y: number];
export type ShapeKind = "rect" | "ellipse" | "arrow" | "line";
export type Tool = "pen" | ShapeKind | "text";

export type TextMark = { readonly kind: "text"; readonly color: string; readonly size: number; readonly at: Point; readonly text: string };
export type Mark =
  | { readonly kind: "pen"; readonly color: string; readonly width: number; readonly points: ReadonlyArray<Point> }
  | { readonly kind: ShapeKind; readonly color: string; readonly width: number; readonly from: Point; readonly to: Point }
  | TextMark;

/** The inks, red first: what a marked-up screenshot is read in. Orange is the Caveman's tunic. */
export const INKS = [
  { label: "Red", value: "#e5484d" },
  { label: "Orange", value: "#eb9e3d" },
  { label: "Yellow", value: "#f5d90a" },
  { label: "Green", value: "#3dbb6b" },
  { label: "Blue", value: "#4c8dff" },
  { label: "White", value: "#ffffff" },
  { label: "Black", value: "#111111" },
] as const;

/** Line weights, in pixels as shown; a mark keeps them in the picture's pixels (shown / scale). */
export const WEIGHTS = [
  { label: "Thin", stroke: 2, text: 14 },
  { label: "Medium", stroke: 4, text: 18 },
  { label: "Thick", stroke: 7, text: 26 },
] as const;

export const SHAPES: ReadonlyArray<{ readonly kind: ShapeKind; readonly label: string; readonly key: string }> = [
  { kind: "rect", label: "Rectangle", key: "R" },
  { kind: "ellipse", label: "Ellipse", key: "O" },
  { kind: "arrow", label: "Arrow", key: "A" },
  { kind: "line", label: "Line", key: "L" },
];

/** The tool a bare key picks. */
export function toolForKey(key: string): Tool | null {
  const k = key.toUpperCase();
  if (k === "P") return "pen";
  if (k === "T") return "text";
  return SHAPES.find((s) => s.key === k)?.kind ?? null;
}

/** A line of text's height, in its font size. */
export const LINE = 1.25;

/**
 * A copy's way back, kept beside it: the picture it was drawn on (an image as
 * it came, a video's frame as it stood) and the marks. Opened again, the marks
 * are still marks, to change or take off; without them it is the picture as it
 * was.
 */
export interface Drawn {
  readonly original: Blob;
  /** The picture's own file name; a copy drawn on it again is named after it, not after itself. */
  readonly name: string;
  readonly marks: ReadonlyArray<Mark>;
}

// ------------------------------------------------------------------- history

/** Every step taken, so each can be taken back and put back. */
export interface History {
  readonly past: ReadonlyArray<ReadonlyArray<Mark>>;
  readonly marks: ReadonlyArray<Mark>;
  readonly future: ReadonlyArray<ReadonlyArray<Mark>>;
}

export const EMPTY: History = { past: [], marks: [], future: [] };

/** `marks` is what the picture carries now; the same marks are no step. */
export function commit(h: History, marks: ReadonlyArray<Mark>): History {
  return marks === h.marks ? h : { past: [...h.past, h.marks], marks, future: [] };
}

export function undo(h: History): History {
  const last = h.past.at(-1);
  return last ? { past: h.past.slice(0, -1), marks: last, future: [h.marks, ...h.future] } : h;
}

export function redo(h: History): History {
  const [next, ...rest] = h.future;
  return next ? { past: [...h.past, h.marks], marks: next, future: rest } : h;
}

// ---------------------------------------------------------------------- text

/** Words being typed: a new mark (`index` null) or the one at `index`, taken up again. */
export interface TextEdit {
  readonly index: number | null;
  readonly color: string;
  readonly size: number;
  readonly at: Point;
  readonly text: string;
}

/** The marks once the typing ends: the words added or changed; words emptied are a mark removed. */
export function withText(marks: ReadonlyArray<Mark>, edit: TextEdit): ReadonlyArray<Mark> {
  const text = edit.text.replace(/\s+$/, "");
  const mark: TextMark | null = text.trim() ? { kind: "text", color: edit.color, size: edit.size, at: edit.at, text } : null;
  if (edit.index === null) return mark ? [...marks, mark] : marks;
  const old = marks[edit.index];
  if (!old) return marks;
  if (!mark) return marks.filter((_, i) => i !== edit.index);
  if (old.kind === "text" && old.text === mark.text) return marks;
  return marks.map((m, i) => (i === edit.index ? mark : m));
}

// ------------------------------------------------------------------ geometry

/** Narrower than this, as shown, a picture is too small to draw on. */
const MIN_SHOWN_WIDTH = 320;

/**
 * How large a picture shows in the stage. Whole, when it can be worked on
 * whole (a small one grows, up to 3x); a full-page capture, which would show
 * as a sliver, takes the stage's width instead (at no more than its own size)
 * and scrolls.
 */
export function fitScale(w: number, h: number, stageW: number, stageH: number): number {
  if (w <= 0 || h <= 0 || stageW <= 0 || stageH <= 0) return 1;
  const whole = Math.min(stageW / w, stageH / h, 3);
  return w * whole < MIN_SHOWN_WIDTH ? Math.max(whole, Math.min(stageW / w, 1)) : whole;
}

/** A canvas this large draws on every browser (iOS stops near 16.7 million pixels). */
export const MAX_PIXELS = 16_000_000;

/**
 * How many of its pixels a copy gets for each of the picture's. A picture
 * shown enlarged (a small crop, at up to 3x) had its marks sized for that:
 * words 18px tall on screen are 6px in a 300 x 150 picture's own pixels. So
 * the copy is drawn at the next whole multiple, where they read as they did;
 * a picture too large for a canvas is drawn smaller instead.
 */
export function copyScale(w: number, h: number, shown: number): number {
  return Math.min(shown > 1 ? Math.ceil(shown) : 1, Math.sqrt(MAX_PIXELS / (w * h)));
}

/** A shape dragged less than `min` is a click, not a shape. */
export function isSlip(from: Point, to: Point, min: number): boolean {
  return Math.hypot(to[0] - from[0], to[1] - from[1]) < min;
}

/** An arrow's head: where its shaft ends, and the triangle from there to the tip. */
export function arrowHead(from: Point, to: Point, width: number): { readonly neck: Point; readonly wings: readonly [Point, Point] } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  // Never longer than most of the arrow, so a short one still reads as an arrow.
  const head = Math.min(width * 4.5, length * 0.7);
  const ux = dx / length;
  const uy = dy / length;
  const neck: Point = [to[0] - ux * head, to[1] - uy * head];
  const half = head * 0.5;
  return { neck, wings: [[neck[0] - uy * half, neck[1] + ux * half], [neck[0] + uy * half, neck[1] - ux * half]] };
}

/** The outline that keeps words readable on any picture: dark around a light ink, light around the rest. */
export function halo(color: string): string {
  const n = Number.parseInt(color.slice(1), 16);
  const luma = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luma > 0.6 ? "rgba(0, 0, 0, 0.6)" : "rgba(255, 255, 255, 0.9)";
}

// ---------------------------------------------------------------------- name

/** The copy's file name: "shot.png" marked up is "shot-annotated.png"; a video's frame nobody drew on is "clip-frame.png". */
export function copyName(name: string, marked: boolean, mime: string): string {
  const stem = name.replace(/\.[a-z\d]{1,10}$/i, "").replace(/-(annotated|frame)$/, "") || "image";
  return `${stem}-${marked ? "annotated" : "frame"}.${mime === "image/jpeg" ? "jpg" : "png"}`;
}

/** A video's clock: 1:07.4. */
export function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const tenths = Math.floor(s * 10);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}
