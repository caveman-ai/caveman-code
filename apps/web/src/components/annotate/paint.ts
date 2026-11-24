// Draws marks (model.ts) on a canvas: the one painter for what is seen while
// drawing and for the copy that is saved, so the two never differ. The context
// is scaled to the picture's own pixels by the caller.

import { arrowHead, copyScale, halo, LINE, type Mark, type Point, type TextMark } from "./model.ts";

/** The words' face: the system's, as the textarea they are typed in. */
export const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const FONT_WEIGHT = 600;
const fontOf = (size: number) => `${FONT_WEIGHT} ${size}px ${FONT_FAMILY}`;
/** The halo around words, in their font size. */
export const HALO = 1 / 8;

export function paintMark(ctx: CanvasRenderingContext2D, mark: Mark): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = mark.color;
  ctx.fillStyle = mark.color;
  switch (mark.kind) {
    case "pen":
      pen(ctx, mark.points, mark.width);
      break;
    case "rect":
      ctx.lineWidth = mark.width;
      ctx.strokeRect(Math.min(mark.from[0], mark.to[0]), Math.min(mark.from[1], mark.to[1]), Math.abs(mark.to[0] - mark.from[0]), Math.abs(mark.to[1] - mark.from[1]));
      break;
    case "ellipse":
      ctx.lineWidth = mark.width;
      ctx.beginPath();
      ctx.ellipse((mark.from[0] + mark.to[0]) / 2, (mark.from[1] + mark.to[1]) / 2, Math.abs(mark.to[0] - mark.from[0]) / 2, Math.abs(mark.to[1] - mark.from[1]) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "line":
      ctx.lineWidth = mark.width;
      segment(ctx, mark.from, mark.to);
      break;
    case "arrow": {
      const { neck, wings } = arrowHead(mark.from, mark.to, mark.width);
      ctx.lineWidth = mark.width;
      segment(ctx, mark.from, neck);
      ctx.beginPath();
      ctx.moveTo(mark.to[0], mark.to[1]);
      ctx.lineTo(wings[0][0], wings[0][1]);
      ctx.lineTo(wings[1][0], wings[1][1]);
      ctx.closePath();
      ctx.fill();
      // The same stroke rounds the head's corners like the shaft's ends.
      ctx.lineWidth = mark.width / 2;
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.font = fontOf(mark.size);
      ctx.textBaseline = "middle";
      ctx.lineWidth = mark.size * HALO;
      ctx.strokeStyle = halo(mark.color);
      const height = mark.size * LINE;
      mark.text.split("\n").forEach((line, i) => {
        const y = mark.at[1] + i * height + height / 2;
        ctx.strokeText(line, mark.at[0], y);
        ctx.fillText(line, mark.at[0], y);
      });
      break;
    }
  }
  ctx.restore();
}

function segment(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
}

/** A hand-drawn line through its points, curved through their midpoints so it has no corners; one point is a dot. */
function pen(ctx: CanvasRenderingContext2D, points: ReadonlyArray<Point>, width: number): void {
  const first = points[0];
  if (!first) return;
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(first[0], first[1], width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  const last = points[points.length - 1]!;
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

let ruler: CanvasRenderingContext2D | null = null;

/** The box some words take, in the picture's pixels: where a click takes them up again, and how big their field is. */
export function textBox(mark: Pick<TextMark, "at" | "size" | "text">): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
  ruler ??= document.createElement("canvas").getContext("2d");
  const lines = mark.text.split("\n");
  let w = 0;
  if (ruler) {
    ruler.font = fontOf(mark.size);
    for (const line of lines) w = Math.max(w, ruler.measureText(line).width);
  }
  return { x: mark.at[0], y: mark.at[1], w, h: lines.length * mark.size * LINE };
}

/** Past this a PNG is saved as a JPEG instead: a message takes 10 MB a file. */
const MAX_PNG_BYTES = 8 << 20;

/**
 * The picture (an image, or a video's frame now) with the marks drawn in. `shown` is the scale it was marked up at:
 * the copy is as many pixels as the marks need to read as they did (model.ts copyScale).
 */
export async function renderMarked(source: CanvasImageSource, w: number, h: number, marks: ReadonlyArray<Mark>, shown: number): Promise<Blob> {
  const k = copyScale(w, h, shown);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw the picture.");
  ctx.scale(canvas.width / w, canvas.height / h);
  ctx.drawImage(source, 0, 0, w, h);
  for (const mark of marks) paintMark(ctx, mark);
  const png = await encode(canvas, "image/png");
  if (png.size <= MAX_PNG_BYTES) return png;
  // A JPEG keeps nothing clear. What was clear goes black, as it showed on the stage the marks were drawn over:
  // an ink picked to read there still reads in the copy.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return encode(canvas, "image/jpeg");
}

function encode(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg"): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture couldn't be saved."))), type, 0.9));
}
