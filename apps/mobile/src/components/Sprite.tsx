// A Chief's pixel character: any of the mascot cast (packages/ui/src/mascot/cast.ts), in any pose, in its skin tone,
// as the desktop draws it. Held frames, never tweens; under Reduce Motion it holds frame 0. 32 points is 4 device
// pixels a cell on a 3x phone, so it stays crisp at the size it sits on the box.
import { useBody } from "@caveman-app/ui/mascot/cast";
import { type CastCharacter, MASCOT_POSES, type MascotPose, type SkinTone } from "@caveman-app/ui/mascot/poses";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useReducedMotion } from "../motion";

/** pixel.css's identity palette (--id-*), resolved to hex: React Native has no CSS variables. */
export const PALETTE: Record<string, string> = {
  outline: "#0d0914",
  hair: "#2c1912",
  "hair-hi": "#58341e",
  tunic: "#eb9e3d",
  "tunic-shade": "#aa6128",
  bead: "#4add80",
  wood: "#8b4530",
  "wood-hi": "#d07c4f",
  glint: "#fedbb7",
  bone: "#ebe2cc",
  ginger: "#8a3b22",
  "ginger-hi": "#c0592b",
  fur: "#8d5636",
  "fur-hi": "#b67a48",
  dino: "#7f66c9",
  "dino-shade": "#574394",
  "dino-light": "#a690e8",
  teal: "#3f9286",
  "teal-shade": "#2b645c",
  "teal-light": "#75c7b7",
  slate: "#676f89",
  "slate-shade": "#464d62",
  "slate-light": "#98a2bd",
  sand: "#cdb07a",
  "sand-shade": "#9b7e50",
  pink: "#da8b8b",
  "rock-deep": "#181816",
  "rock-dark": "#2c2a26",
  "rock-mid": "#6b6964",
  rock: "#8a877f",
  "rock-light": "#c2beb4",
};

/** pixel.css's `.px-skin-*` ramps; medium-light is the one in :root. */
export const SKIN: Record<SkinTone, Record<string, string>> = {
  light: { skin: "#f7d4b6", "skin-shade": "#e0a37f", "skin-edge": "#a3634b", "skin-light": "#fff0e1" },
  "medium-light": { skin: "#f1b582", "skin-shade": "#d07c4f", "skin-edge": "#8b4530", "skin-light": "#fedbb7" },
  medium: { skin: "#d39563", "skin-shade": "#b06d3f", "skin-edge": "#74401f", "skin-light": "#e9b684" },
  "medium-dark": { skin: "#a5683f", "skin-shade": "#82492a", "skin-edge": "#55301a", "skin-light": "#c48a5c" },
  dark: { skin: "#80593f", "skin-shade": "#654430", "skin-edge": "#41291a", "skin-light": "#a07a5e" },
};

/** The look pose's stills, by direction (poses.ts: centre, then N, NE, E, SE, S, SW, W, NW). */
export const LOOK = { ahead: 0, up: 1, down: 5, left: 7, right: 3 } as const;

interface Props {
  character: CastCharacter;
  tone: SkinTone;
  pose?: MascotPose;
  /** Which still the look pose shows (LOOK). */
  look?: number;
  size?: number;
  label?: string;
  /** False holds frame 0, as a mark in a list does. */
  animate?: boolean;
}

export function Sprite({ character, tone, pose = "idle", look = 0, size = 32, label, animate = true }: Props) {
  const body = useBody(character);
  const still = useReducedMotion() || !animate;
  const { frames, fps, loop, still: picked } = MASCOT_POSES[pose];
  const [frame, setFrame] = useState(0);
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    setFrame(0);
    if (still || picked || frames < 2) return;
    const timer = setInterval(() => setFrame((f) => (loop ? (f + 1) % frames : Math.min(f + 1, frames - 1))), 1000 / fps);
    return () => clearInterval(timer);
  }, [pose, character, still, picked, frames, fps, loop]);

  // Idle blinks now and then: the shut-eye layer for a moment, a held step.
  useEffect(() => {
    if (still || pose !== "idle") return;
    let off: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      setBlink(true);
      off = setTimeout(() => setBlink(false), 150);
    }, 4300);
    return () => {
      clearInterval(timer);
      if (off) clearTimeout(off);
    };
  }, [pose, still]);

  const sheet = body?.[pose];
  const colors = { ...PALETTE, ...SKIN[tone] };
  // A new pose renders once before its frame resets; an old frame past the new pose's last would draw nothing.
  const shown = picked ? look : frame < frames ? frame : 0;
  const fill = (token: string) => colors[token] ?? colors.outline;
  return (
    <View accessible={!!label} accessibilityRole={label ? "image" : undefined} accessibilityLabel={label} aria-hidden={!label} style={{ width: size, height: size }}>
      {sheet ? (
        <Svg width={size} height={size} viewBox={`${shown * 24} 0 24 24`}>
          {sheet.paths.map(([token, d]) => (
            <Path key={token} d={d} fill={fill(token)} />
          ))}
          {blink && sheet.blink ? sheet.blink.map(([token, d]) => <Path key={`blink-${token}`} d={d} fill={fill(token)} />) : null}
        </Svg>
      ) : null}
    </View>
  );
}
