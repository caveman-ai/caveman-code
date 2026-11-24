/**
 * The mascot contract (STYLE.md "Mascot"). Lane ui-mascot implements
 * <Mascot {...MascotProps} /> and draws every pose; other lanes only render it.
 *
 * Two cuts of one character:
 * - bust: 16x16, head and shoulders. The app's face and the Caveman engine
 *   tile. Packages/provider-caveman embeds it as SVG paths: regenerate them in
 *   the same commit when the bust changes (LANE-RULES contract update).
 * - body: 24x24, the whole squat caveman with his club. Empty and first-run
 *   states, the working indicator, the subagent mark at 1x.
 *
 * Frames sit side by side in one strip (pixel.css `.px-strip`), frame 0 is the
 * still every pose shows under reduced motion.
 */

export type MascotPose =
  | "idle" // breathing, an occasional blink; the herd fidgets once a loop (an ear, a tail, a look round)
  | "working" // club taps the rock
  | "thinking" // hand at the beard, eyes up
  | "done" // club raised once, then holds
  | "sleeping" // slumped, a pixel "z" rises (launch video, last panel)
  | "error" // a "!" over the head (launch video, cave panel)
  | "wave" // first run, hello
  | "look"; // eyes on the pointer: a still per direction, picked with --px-frame (GazeMascot)

export type MascotCut = "bust" | "body";

/** The cast drawn in scripts/cast/*.py. */
export type CastCharacter =
  | "caveman"
  | "cavewoman"
  | "elder"
  | "kid"
  | "mammoth"
  | "sabertooth"
  | "wolf"
  | "bear"
  | "rhino"
  | "sloth"
  | "glyptodon"
  | "bison"
  | "elk"
  | "boar"
  | "beaver"
  | "owl"
  | "bat"
  | "dino"
  | "trike"
  | "ptero"
  | "petrock";
/**
 * Who plays the body (src/mascot/cast.ts): one of the cast, or a companion someone made
 * ("custom:<id>", a file of the runtime's companions folder). The bust is always the caveman: it is the app's face.
 */
export type MascotCharacter = CastCharacter | `custom:${string}`;

/** A skin ramp (pixel.css `.px-skin-*`); "medium-light" is the one in :root. */
export type SkinTone = "light" | "medium-light" | "medium" | "medium-dark" | "dark";

export const MASCOT_GRID: Record<MascotCut, { w: number; h: number }> = {
  bust: { w: 16, h: 16 },
  body: { w: 24, h: 24 },
};

/**
 * Frame budget per pose. fps stays in 4..8: pixel things move in held frames.
 * `loop: false` plays once and holds the last frame. `still`: the frames are
 * never played; the caller picks one with `--px-frame` (the idle blink stays).
 */
export const MASCOT_POSES: Record<MascotPose, { frames: number; fps: number; loop: boolean; still?: boolean }> = {
  // Two seconds: room for a breath and one fidget. A two-frame breath is held to fill it (caveman-avatar.py `breath`).
  idle: { frames: 8, fps: 4, loop: true },
  working: { frames: 4, fps: 8, loop: true },
  thinking: { frames: 2, fps: 3, loop: true },
  done: { frames: 3, fps: 8, loop: false },
  sleeping: { frames: 2, fps: 2, loop: true },
  error: { frames: 2, fps: 4, loop: true },
  wave: { frames: 4, fps: 8, loop: false },
  // Centre, then N, NE, E, SE, S, SW, W, NW. Derived from idle by the generator.
  look: { frames: 9, fps: 8, loop: false, still: true },
};

export type MascotProps = {
  pose?: MascotPose; // default "idle"
  cut?: MascotCut; // default "body"
  /** Integer scale only: bust 1x = 16px, body 1x = 24px. */
  scale?: 1 | 2 | 3 | 4 | 6 | 8;
  /** false shows frame 0 (default true). Reduced motion always shows frame 0. */
  animate?: boolean;
  /** Accessible name; omitted = decorative (aria-hidden). */
  label?: string;
  className?: string;
  /** Body only. Omitted = the companion picked in Settings. */
  character?: MascotCharacter;
  /** Body only. Omitted = the skin tone picked in Settings. */
  tone?: SkinTone;
};
