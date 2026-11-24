// A Chief's face where Home lists it (DECISIONS.md "Home, exactly" 4). In a row, the whole character stands on a
// `raised` plate with stepped corners (pixel.css .px-notch), inset at least one sprite cell all round, so nothing it
// holds (the Chief's club, Oona's bone, Grug's staff) is ever cut at the plate's edge. In a face stack, just the head,
// on a plate lightly tinted by the character. Every sprite cell lands on whole device pixels, and never a smooth
// radius that would clip a pixel head. The pose is a still; poses are a second cue at most and a portrait never moves
// (DECISIONS.md, "Sprites that hop").
import type { CastCharacter, MascotPose, SkinTone } from "@caveman-app/ui/mascot/poses";
import { PixelRatio, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Sprite } from "../components/Sprite";
import { useTheme } from "../theme";

/** Which part of the 24-cell body shows: head and shoulders (a row's portrait), or the whole head (a face in a stack). */
const CROPS = {
  portrait: { x: 3, y: 1, cells: 18, notch: 2 },
  head: { x: 5, y: 2, cells: 14, notch: 1 },
} as const;

// The plate takes a little of each character's own colour, dark on the deck and pale on light, so faces in a row
// stay told apart without a chip of colour that could read as a state.
const PLATES: Partial<Record<CastCharacter, readonly [string, string]>> = {
  caveman: ["#33281f", "#efe4d6"],
  cavewoman: ["#35231d", "#f1e2da"],
  elder: ["#252a34", "#e2e7ee"],
  kid: ["#2f2a1e", "#efe9d5"],
};
const SPARE: readonly (readonly [string, string])[] = [
  ["#232b2a", "#dfebe8"],
  ["#2a2433", "#e8e3f0"],
  ["#2d2a22", "#ece7da"],
  ["#22282f", "#e0e6ec"],
];
function plateOf(character: CastCharacter): readonly [string, string] {
  const known = PLATES[character];
  if (known) return known;
  let h = 0;
  for (const ch of character) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SPARE[h % SPARE.length]!;
}

/** A square of `n` cells with `k`-cell stepped corners, as a path. */
function notched(n: number, k: number, inset = 0): string {
  const a = inset;
  const b = n - inset;
  if (k === 1) return `M${a + 1} ${a}H${b - 1}V${a + 1}H${b}V${b - 1}H${b - 1}V${b}H${a + 1}V${b - 1}H${a}V${a + 1}H${a + 1}Z`;
  return `M${a + 2} ${a}H${b - 2}V${a + 1}H${b - 1}V${a + 2}H${b}V${b - 2}H${b - 1}V${b - 1}H${b - 2}V${b}H${a + 2}V${b - 1}H${a + 1}V${b - 2}H${a}V${a + 2}H${a + 1}V${a + 1}H${a + 2}Z`;
}

/** The corners a notch knocks out, as a path, painted in what the portrait sits on. */
function corners(n: number, k: number): string {
  const cell = (x: number, y: number) => `M${x} ${y}h1v1h-1z`;
  const at = k === 1 ? [[0, 0]] : [[0, 0], [1, 0], [0, 1]];
  return at.flatMap(([x, y]) => [cell(x!, y!), cell(n - 1 - x!, y!), cell(x!, n - 1 - y!), cell(n - 1 - x!, n - 1 - y!)]).join("");
}

/** A square of `s` device pixels with corners stepped twice by `u`, as a path. */
function notchedPx(s: number, u: number): string {
  const a = u;
  const b = 2 * u;
  return `M${b} 0H${s - b}V${a}H${s - a}V${b}H${s}V${s - b}H${s - a}V${s - a}H${s - b}V${s}H${b}V${s - a}H${a}V${s - b}H0V${b}H${a}V${a}H${b}Z`;
}

/**
 * The whole character on its plate: the plate fills the box asked for, the sprite takes the largest whole number of
 * device pixels a cell that still leaves a cell of plate all round, centred on whole pixels.
 */
function Plated({ character, tone, size, pose, label }: { character: CastCharacter; tone: SkinTone; size: number; pose: MascotPose; label?: string }) {
  const { c } = useTheme();
  const scale = PixelRatio.get();
  const box = Math.round(size * scale);
  const cell = Math.max(1, Math.floor(box / 26));
  const sprite = cell * 24;
  const at = Math.floor((box - sprite) / 2) / scale;
  return (
    <View accessible={!!label} accessibilityRole={label ? "image" : undefined} accessibilityLabel={label} aria-hidden={!label} style={{ width: box / scale, height: box / scale }}>
      <Svg width={box / scale} height={box / scale} viewBox={`0 0 ${box} ${box}`} style={{ position: "absolute" }}>
        <Path d={notchedPx(box, cell)} fill={c.raised} />
      </Svg>
      <View style={{ position: "absolute", left: at, top: at }}>
        <Sprite character={character} tone={tone} pose={pose} size={sprite / scale} animate={false} />
      </View>
    </View>
  );
}

export function Portrait({
  character,
  tone,
  size = 48,
  crop = "portrait",
  ground,
  ring = 0,
  pose = "idle",
  label,
}: {
  character: CastCharacter;
  tone: SkinTone;
  size?: number;
  crop?: keyof typeof CROPS;
  /** What it sits on: the knocked-out corners and the ring are painted in it. */
  ground?: string;
  /** A band of `ground` around it, in points, where faces overlap in a stack. */
  ring?: number;
  pose?: MascotPose;
  label?: string;
}) {
  const { c, dark } = useTheme();
  if (crop === "portrait" && !ring) return <Plated character={character} tone={tone} size={size} pose={pose} label={label} />;
  const { x, y, cells, notch } = CROPS[crop];
  const scale = PixelRatio.get();
  // One sprite cell, in points: a whole number of device pixels.
  const cell = Math.max(1, Math.round((size * scale) / cells)) / scale;
  const box = cell * cells;
  const floor = ground ?? c.panel;
  const [darkPlate, lightPlate] = plateOf(character);
  const outer = box + ring * 2;
  return (
    <View accessible={!!label} accessibilityRole={label ? "image" : undefined} accessibilityLabel={label} aria-hidden={!label} style={{ width: outer, height: outer }}>
      {ring ? (
        <Svg width={outer} height={outer} viewBox={`0 0 ${outer / cell} ${outer / cell}`} style={{ position: "absolute" }}>
          <Path d={notched(outer / cell, notch)} fill={floor} />
        </Svg>
      ) : null}
      <View style={{ position: "absolute", left: ring, top: ring, width: box, height: box, overflow: "hidden" }}>
        <Svg width={box} height={box} viewBox={`0 0 ${cells} ${cells}`} style={{ position: "absolute" }}>
          <Path d={notched(cells, notch)} fill={dark ? darkPlate : lightPlate} />
        </Svg>
        <View style={{ position: "absolute", left: -x * cell, top: -y * cell }}>
          <Sprite character={character} tone={tone} pose={pose} size={cell * 24} animate={false} />
        </View>
        <Svg width={box} height={box} viewBox={`0 0 ${cells} ${cells}`} style={{ position: "absolute" }} pointerEvents="none">
          <Path d={corners(cells, notch)} fill={floor} />
        </Svg>
      </View>
    </View>
  );
}
