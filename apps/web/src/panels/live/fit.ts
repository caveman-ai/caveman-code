// ), apps/web/src/browser/ServerBrowserSurface.tsx @ ab3a3cd1
// (pagePoint, placeAgentCursor). Where a streamed frame sits in its box under
// `object-fit: contain`, and the two mappings between box points and frame
// pixels: the user's pointer goes one way, the agent's cursor the other.

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** `center` letterboxes on both sides (a screen); `top` pins the frame under the chrome (a page), as `object-position: top`. */
export type Align = "center" | "top";

/** The frame's offset inside the box and its scale (box px per frame px). */
export function contain(box: Size, frame: Size, align: Align = "center"): { readonly x: number; readonly y: number; readonly scale: number } {
  const scale = frame.width > 0 && frame.height > 0 ? Math.min(box.width / frame.width, box.height / frame.height) : 0;
  return { x: (box.width - frame.width * scale) / 2, y: align === "top" ? 0 : (box.height - frame.height * scale) / 2, scale };
}

/** A box point (px from its top-left) in frame pixels. Null in the letterbox bars, unless `clamp` pins it to the frame's edge. */
export function toFrame(p: Point, box: Size, frame: Size, align: Align = "center", clamp = false): Point | null {
  const fit = contain(box, frame, align);
  if (!(fit.scale > 0)) return null;
  const x = (p.x - fit.x) / fit.scale;
  const y = (p.y - fit.y) / fit.scale;
  const inside = x >= 0 && y >= 0 && x <= frame.width && y <= frame.height;
  if (!inside && !clamp) return null;
  return { x: Math.min(Math.max(x, 0), frame.width), y: Math.min(Math.max(y, 0), frame.height) };
}

/** Frame pixels to a box point: the inverse of `toFrame`. */
export function toBox(p: Point, box: Size, frame: Size, align: Align = "center"): Point {
  const fit = contain(box, frame, align);
  return { x: fit.x + p.x * fit.scale, y: fit.y + p.y * fit.scale };
}
