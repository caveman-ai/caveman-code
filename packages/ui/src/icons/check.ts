// The two checks, drawn as real icons rather than pixels ("the pixelated checkmark everywhere in
// caveman code looks awful, can we make it feel more like a real icon w way better visual alignment"). The rest of the
// state family stays pixel art; a check is the one mark people read at a glance, and at 16 px its pixel steps read as
// noise. One geometry for the desktop (PixelIcon.tsx) and the phone (apps/mobile Pixel.tsx), on the same 16 box as
// every pixel glyph, so the swap moves nothing.
//
// Done: a filled disc with a white check, as iOS draws checkmark.circle.fill. The disc is 12.5 across, the ring
// spinner's own span (its dots run 2 to 14), so a turn finishing doesn't change size. The check's box is centred on
// the disc's centre a quarter point low: a check's weight sits in its long stroke, and dead centre reads high.
// Connected: the bare check, the same stroke at a 16 box's full width.

/** The done disc: centre and radius on the 16 grid. */
export const DONE_DISC = { cx: 8, cy: 8, r: 6.25 } as const;

/** The check inside the disc: short leg down to the corner, long leg up to the right. */
export const DONE_CHECK = "M5.3 8.2 L7.2 10.05 L10.75 6.35";

/** Its stroke: about an eighth of the disc, as SF's own. */
export const DONE_CHECK_WIDTH = 1.6;

/** The bare check (connected, signed in), nearly corner to corner. */
export const PLAIN_CHECK = "M3.4 8.35 L6.45 11.3 L12.6 5.05";

export const PLAIN_CHECK_WIDTH = 1.75;

/** How long the done mark takes to land, and the plain check to draw (ms). */
export const CHECK_LAND_MS = 320;
