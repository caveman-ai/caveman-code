// The identity layer (STYLE.md 1-2), drawn from the kit's own pixel set (packages/ui/src/icons/glyphs.ts) and
// mascot sprites, so a state, a folder or the caveman looks the same on the phone as on the desktop. Whole cells, held
// frames, still under Reduce Motion. Pixel art is crisp only when each cell is a whole number of the screen's pixels,
// so any size is drawn at the nearest size that is (16 on every iPhone; ask for 16 or 32) and centred in the box
// asked for. Engines are logos, not pixels, except Caveman's bust and an ACP agent's tile: see ui/EngineLogo.tsx.
import { CHECK_LAND_MS, DONE_CHECK, DONE_CHECK_WIDTH, DONE_DISC, PLAIN_CHECK, PLAIN_CHECK_WIDTH } from "@caveman-app/ui/icons/check";
import { FOLDER, GLYPHS, appearFrames, glyphPaths, STATE_STRIPS } from "@caveman-app/ui/icons/glyphs";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { MASCOT_SPRITES } from "@caveman-app/ui/mascot/sprites";
import { type ReactNode, useEffect, useState } from "react";
import { PixelRatio, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import type { Tool } from "../board/model";
import { useReducedMotion } from "../motion";
import { useTheme } from "../theme";

/** glyphs.ts PIXEL_PALETTE resolved to hex: React Native has no CSS variables. w, v and x follow the theme. */
const TINT: Record<string, string> = {
  k: "#0d0914",
  h: "#2c1912",
  H: "#58341e",
  s: "#f1b582",
  S: "#d07c4f",
  l: "#fedbb7",
  t: "#eb9e3d",
  T: "#aa6128",
  c: "#cc785c",
  p: "#d9dbdd",
  a: "#4fadd8",
};
/** Ink's tints (PixelIcon.tsx): shade, dim, faint. */
const INK_OPACITY: Record<string, number> = { ":": 0.4, "+": 0.7, "'": 0.16 };
/** The mascot in one ink: its hair in the glyphs' dim tier, its shades in their shade tier (INK_OPACITY). */
const MONO_TIER: Record<string, number> = { hair: 0.4, "hair-hi": 0.4, "skin-shade": 0.7, "skin-edge": 0.7, "tunic-shade": 0.7, wood: 0.7 };
/** pixel.css --id-* resolved to hex. */
const MASCOT: Record<string, string> = {
  outline: "#0d0914",
  hair: "#2c1912",
  "hair-hi": "#58341e",
  skin: "#f1b582",
  "skin-shade": "#d07c4f",
  "skin-edge": "#8b4530",
  tunic: "#eb9e3d",
  "tunic-shade": "#aa6128",
  bead: "#4add80",
  wood: "#8b4530",
  "wood-hi": "#d07c4f",
  glint: "#fedbb7",
  "rock-dark": "#2c2a26",
  "rock-mid": "#6b6964",
  rock: "#8a877f",
  "rock-light": "#c2beb4",
};

const cache = new WeakMap<string[], ReturnType<typeof glyphPaths>>();
function paths(grid: string[]) {
  let drawn = cache.get(grid);
  if (!drawn) {
    drawn = glyphPaths(grid);
    cache.set(grid, drawn);
  }
  return drawn;
}

type Strip = { frames: string[][]; fps: number; play: "loop" | "once" };
const strips = STATE_STRIPS as Partial<Record<PixelIconName, Strip>>;

/**
 * A glyph's still drawing. Working is the desktop's ring at rest (glyphs.ts STATE_STRIPS: eight 2x2 dots, the comet's
 * first frame), so a quiet tile, Reduce Motion or a mark that doesn't animate still reads as the spinner it is.
 */
export const stillGrid = (name: Exclude<PixelIconName, "engine-caveman">): string[] => GLYPHS[name];

/** The nearest size to `size` at which a grid of `cells` lands every cell on whole screen pixels. */
export function crisp(size: number, cells = 16) {
  const scale = PixelRatio.get();
  return (Math.max(1, Math.round((size * scale) / cells)) * cells) / scale;
}

/** Steps through `count` frames at `fps`, looping or holding the last; under Reduce Motion it holds `rest`. */
function useFrames(count: number, fps: number, loop: boolean, rest = 0) {
  const still = useReducedMotion();
  const [frame, setFrame] = useState(still ? rest : 0);
  useEffect(() => {
    if (count < 2 || still) return;
    setFrame(0);
    const timer = setInterval(() => setFrame((f) => (loop ? (f + 1) % count : Math.min(f + 1, count - 1))), 1000 / fps);
    return () => clearInterval(timer);
  }, [count, fps, loop, still]);
  return still ? rest : frame;
}

/**
 * The accessibility lives on a View: react-native-svg would hand native-only props to the DOM on the web. The art is
 * drawn at its crisp size, centred in the `size` box the layout asked for.
 */
function Art({ size, label, viewBox = "0 0 16 16", children, cells = 16 }: { size: number; label: string | undefined; viewBox?: string; children: ReactNode; cells?: number }) {
  const drawn = crisp(size, cells);
  return (
    <View accessible={!!label} accessibilityRole={label ? "image" : undefined} accessibilityLabel={label} aria-hidden={!label} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={drawn} height={drawn} viewBox={viewBox} style={{ flexShrink: 0 }}>
        {children}
      </Svg>
    </View>
  );
}

function Grid({ grid, ink, mono = false }: { grid: string[]; ink: string; /** Every cell in the ink: no warm or green accent. */ mono?: boolean }) {
  const { c } = useTheme();
  const tint = (char: string) => (mono ? ink : char === "w" ? c.warning : char === "v" ? c.success : char === "x" ? c.destructive : (TINT[char] ?? ink));
  return paths(grid).map(({ char, d }) => <Path key={char} d={d} fill={tint(char)} fillOpacity={INK_OPACITY[char] ?? 1} />);
}

/**
 * A pixel icon from names.ts. Its ink (the drawing's outline) follows `ink`, by default the description grey, as the
 * desktop's icons sit in `text-muted-foreground`; give the label's colour where the row lights it. A state that loops
 * (the working ring, its agents) turns while it shows unless `animate` is off.
 */
export function PixelIcon({ name, size = 16, ink, label, animate = true, mono = false }: { name: PixelIconName; size?: number; ink?: string; label?: string; animate?: boolean; /** A glyph that isn't a state (a mode, a Chief's crown in Settings) drawn in its ink alone: amber is only ever needs-you. */ mono?: boolean }) {
  const { c } = useTheme();
  const strip = strips[name];
  const loops = animate && strip?.play === "loop";
  const frame = useFrames(loops ? strip.frames.length : 0, strip?.fps ?? 1, true, -1);
  // The checks are real icons, not pixels (check.ts). Returned after the hooks above, so a mark that turns from the
  // working ring into the done check in place keeps its hooks in order.
  if (name === "state-done" || name === "state-connected") return <Check name={name} size={size} ink={ink} mono={mono} label={label} />;
  if (name === "engine-caveman") {
    // The Caveman engine is the mascot's bust (PixelIcon.tsx): frame 0 of its idle sheet, still.
    return (
      <Art size={size} label={label}>
        {MASCOT_SPRITES.bust.idle.paths.map(([token, d]) => (
          // `mono`: one ink, as vendor marks are on the phone, in the glyphs' own tiers (hair dim, shade at 70%); the
          // outline drops out, so the face still reads.
          <Path key={token} d={d} fill={mono ? (token === "outline" ? "transparent" : (ink ?? c.muted)) : (MASCOT[token] ?? ink ?? c.muted)} fillOpacity={mono ? MONO_TIER[token] ?? 1 : 1} />
        ))}
      </Art>
    );
  }
  // The ring's comets (Working's one with its tail, a lead's agents' two) turn in full ink, not their row's grey, so a
  // head reads against its faint ring, as the desktop's StatusMark draws them.
  const lit = loops && (name === "state-working" || name === "state-agents") ? c.text : (ink ?? c.muted);
  const grid = loops ? (strip.frames[frame] ?? stillGrid(name)) : stillGrid(name);
  return (
    <Art size={size} label={label}>
      <Grid grid={grid} ink={lit} mono={mono} />
    </Art>
  );
}

/**
 * A chat's state landing (StatusMark): `stopped` and `done` play their strip once, from mount, and rest on the last
 * frame. Mount it with a new `key` when the status changes on screen; on a row's first paint show the still
 * PixelIcon instead, so nothing replays.
 */
export function StateMark({ name, size = 16, label }: { name: "state-stopped" | "state-done" | "state-connected" | "state-compacted" | "state-routed"; size?: number; label?: string }) {
  const strip = strips[name]!;
  const frame = useFrames(strip.frames.length, strip.fps, false, strip.frames.length - 1);
  const { c } = useTheme();
  // A finish or a connection lands as the check it rests as, not the pixel strip that ended on the old drawing.
  if (name === "state-done" || name === "state-connected") return <Check name={name} size={size} label={label} land />;
  return (
    <Art size={size} label={label}>
      <Grid grid={strip.frames[frame] ?? GLYPHS[name]} ink={c.muted} />
    </Art>
  );
}

/** A glyph arriving where another stood: it dithers in over four held frames, a quarter of its pixels at a time. */
export function PixelAppear({ name, size = 16, ink, label }: { name: Exclude<PixelIconName, "engine-caveman">; size?: number; ink?: string; label?: string }) {
  const [frames] = useState(() => appearFrames(GLYPHS[name]));
  const frame = useFrames(frames.length, 16, false, frames.length - 1);
  const { c } = useTheme();
  if (name === "state-done" || name === "state-connected") return <Check name={name} size={size} ink={ink} label={label} land />;
  return (
    <Art size={size} label={label}>
      <Grid grid={frames[frame]!} ink={ink ?? c.muted} />
    </Art>
  );
}

/**
 * A project's folder in the sidebar (PixelFolder): shut, its front lifting while the row is held, open on its shaded
 * inside while the project is open.
 */
export function PixelFolder({ open, held = false, size = 16, ink }: { open: boolean; held?: boolean; size?: number; ink?: string }) {
  const { c } = useTheme();
  const grid = FOLDER[open ? 2 : held ? 1 : 0]!;
  return (
    <Art size={size} label={undefined}>
      <Grid grid={grid} ink={ink ?? c.muted} />
    </Art>
  );
}

// ---------------------------------------------------------------- the phone's own glyphs

/**
 * Glyphs the phone needs that the kit's set doesn't draw yet, in the same family (STYLE.md 7: 16x16, ink and shade, a
 * 1 px margin), so a row never mixes a pixel glyph with a vector one for the same role (DECISIONS.md "One concept, one
 * glyph"): a desktop Mac (Studio, a Mac mini), the Notifications bell, and the + sheet's Photos, Camera and Another chat.
 */
const PHONE_GLYPHS = {
  // A Mac mini or a Studio: a low, flat box with its front slot, never a screen (a screen read as a tablet or a TV).
  desktop: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    ".##############.",
    ".#............#.",
    ".#............#.",
    ".#............#.",
    ".#.......####.#.",
    ".##############.",
    "..::........::..",
    "................",
    "................",
    "................",
  ],
  // Plan: three ticked lines, so it never reads as Goal's target beside it.
  checklist: [
    "................",
    "................",
    "....#...........",
    ".#.#....#######.",
    "..#.............",
    "................",
    "................",
    "....#...........",
    ".#.#....#######.",
    "..#.............",
    "................",
    "................",
    "....#...........",
    ".#.#....#######.",
    "..#.............",
    "................",
  ],
  bell: [
    "................",
    ".......##.......",
    "......####......",
    ".....#....#.....",
    "....#......#....",
    "....#......#....",
    "....#......#....",
    "....#......#....",
    "...#........#...",
    "...#........#...",
    "..############..",
    "................",
    "......####......",
    ".......##.......",
    "................",
    "................",
  ],
  photo: [
    "................",
    "................",
    "..############..",
    "..#..........#..",
    "..#.......##.#..",
    "..#.......##.#..",
    "..#..........#..",
    "..#....#.....#..",
    "..#...###....#..",
    "..#..#####.#.#..",
    "..#.#######::#..",
    "..#..........#..",
    "..############..",
    "................",
    "................",
    "................",
  ],
  camera: [
    "................",
    "................",
    "................",
    ".....####.......",
    "..############..",
    "..#..........#..",
    "..#...####...#..",
    "..#..#....#..#..",
    "..#..#....#..#..",
    "..#..#....#..#..",
    "..#...####...#..",
    "..#..........#..",
    "..############..",
    "................",
    "................",
    "................",
  ],
  chat: [
    "................",
    "................",
    "..############..",
    "..#..........#..",
    "..#..::::::..#..",
    "..#..........#..",
    "..#..::::....#..",
    "..#..........#..",
    "..#..........#..",
    "..#####..#####..",
    "......#.#.......",
    "......##........",
    "................",
    "................",
    "................",
    "................",
  ],
} as const satisfies Record<string, readonly string[]>;

export type PhoneGlyphName = keyof typeof PHONE_GLYPHS;

/** A mode's glyph (Plan, Grill me, Goal) in its ink alone: Plan is the phone's checklist, the rest the kit's own. */
export function ModeGlyph({ name, ink }: { name: PixelIconName; ink?: string }) {
  if (name === "plan") return <PhoneGlyph name="checklist" ink={ink} />;
  return <PixelIcon name={name} ink={ink} mono />;
}

/** One of the phone's own pixel glyphs, drawn and inked as PixelIcon draws the kit's. */
export function PhoneGlyph({ name, size = 16, ink, label }: { name: PhoneGlyphName; size?: number; ink?: string; label?: string }) {
  const { c } = useTheme();
  return (
    <Art size={size} label={label}>
      <Grid grid={[...PHONE_GLYPHS[name]]} ink={ink ?? c.muted} />
    </Art>
  );
}

/**
 * A device by what it is, one glyph a kind everywhere it shows (Home, Search, its list's head, the box's context row,
 * Peek): the laptop for a MacBook, the desktop for a Mac mini or Studio, the cloud for a Cloud computer.
 */
export function DeviceGlyph({ device, size = 16, ink }: { device: { kind: "mac" | "cloud"; form?: "laptop" | "desktop" }; size?: number; ink?: string }) {
  if (device.kind === "cloud") return <PixelIcon name="computer-cloud" size={size} ink={ink} />;
  if (device.form === "desktop") return <PhoneGlyph name="desktop" size={size} ink={ink} />;
  return <PixelIcon name="computer-this-mac" size={size} ink={ink} />;
}

const TOOL_ICON: Record<Tool, PixelIconName> = { search: "tool-search", read: "tool-read", edit: "tool-edit", run: "tool-run" };

/** A step's tool on a transcript line: a 16pt pixel glyph in the description grey. */
export function ToolMark({ tool, ink }: { tool: Tool; ink?: string }) {
  return <PixelIcon name={TOOL_ICON[tool]} ink={ink} />;
}

/**
 * The whole caveman with his club (the desktop's empty state): he waves once when he arrives, then idles, blinking
 * now and then. The sheet holds every frame side by side, so a frame is a window onto it. Give it 48, 72 or 96: a
 * 24-cell sprite is crisp at multiples of 24.
 */
export function Mascot({ size = 72, label = "Caveman" }: { size?: number; label?: string }) {
  const [waved, setWaved] = useState(false);
  const wave = useFrames(waved ? 0 : 4, 8, false, 0);
  const idle = useFrames(waved ? 2 : 0, 2, true);
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (waved) return;
    const timer = setTimeout(() => setWaved(true), 4 * 125 + 600);
    return () => clearTimeout(timer);
  }, [waved]);
  useEffect(() => {
    if (!waved) return;
    const timer = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 140);
    }, 3800);
    return () => clearInterval(timer);
  }, [waved]);
  const sheet = waved ? MASCOT_SPRITES.body.idle : MASCOT_SPRITES.body.wave;
  const frame = waved ? idle : wave;
  return (
    <Art size={size} label={label} viewBox={`${frame * 24} 0 24 24`} cells={24}>
      {sheet.paths.map(([token, d]) => (
        <Path key={token} d={d} fill={MASCOT[token] ?? "#0d0914"} />
      ))}
      {blink && sheet.blink ? sheet.blink.map(([token, d]) => <Path key={`blink-${token}`} d={d} fill={MASCOT[token] ?? "#0d0914"} />) : null}
    </Art>
  );
}

/**
 * The two checks as real icons (packages/ui icons/check.ts), the desktop's geometry on the same 16 box as every glyph:
 * done is the success disc with a white check, as iOS draws checkmark.circle.fill; connected is the bare check in its
 * ink. Drawn at the size asked, not snapped to whole pixels: a curve has no cells to keep crisp. `land` grows it in
 * once from 60% with no overshoot; under Reduce Motion it is simply there.
 */
function Check({ name, size, ink, mono = false, label, land = false }: { name: "state-done" | "state-connected"; size: number; ink?: string; mono?: boolean; label?: string; land?: boolean }) {
  const { c } = useTheme();
  const still = useReducedMotion();
  const grown = useSharedValue(land && !still ? 0 : 1);
  useEffect(() => {
    if (land && !still) grown.value = withTiming(1, { duration: CHECK_LAND_MS, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
  }, [grown, land, still]);
  const style = useAnimatedStyle(() => ({ opacity: grown.value, transform: [{ scale: 0.6 + 0.4 * grown.value }] }));
  const line = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <View accessible={!!label} accessibilityRole={label ? "image" : undefined} accessibilityLabel={label} aria-hidden={!label} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={style}>
        <Svg width={size} height={size} viewBox="0 0 16 16">
          {name === "state-done" ? (
            <>
              <Circle cx={DONE_DISC.cx} cy={DONE_DISC.cy} r={DONE_DISC.r} fill={mono && ink ? ink : c.success} />
              <Path d={DONE_CHECK} stroke="#ffffff" strokeWidth={DONE_CHECK_WIDTH} {...line} />
            </>
          ) : (
            <Path d={PLAIN_CHECK} stroke={ink ?? c.muted} strokeWidth={PLAIN_CHECK_WIDTH} {...line} />
          )}
        </Svg>
      </Animated.View>
    </View>
  );
}
