// The edges' blur on a phone (ProgressiveEdge.tsx): a real blur that ramps in, the system's own (expo-blur) seen
// through an alpha mask (masked-view's MaskedView over a LinearGradient), both in Expo Go. Two layers, a light one
// handed in early over a long stretch and a stronger one later, so the page softens before it darkens and the blur
// grows as the ramp does rather than one blur fading in over the sharp page. How much is called for (`amount`, the
// band coming in as content arrives under it) turns the blur's own intensity, never an opacity: a visual effect under
// a parent's opacity draws wrong. Android's blur is still experimental and Reduce Transparency asks for none, so there
// the band only dims.
import MaskedViewClass from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { Platform, StyleSheet, type ViewProps } from "react-native";
import Animated, { type SharedValue, useAnimatedProps } from "react-native-reanimated";
import { useTheme } from "../theme";
import { samples, windowed } from "./edgeRamp";
import { useSolidGlass } from "./Glass";

export interface EdgeBlurProps {
  /** The box's height; the blur fills it. */
  height: number;
  /** How whole the blur is `y` pt down from the box's top: 0 none, 1 whole. */
  at: (y: number) => number;
  /** The strongest blur, in CSS px (the web's measure; here it sets the system blur's intensity). */
  strongest: number;
  /** 0 to 1: how much of it is called for, as the band comes in. */
  amount?: SharedValue<number>;
}

const AnimatedBlur = Animated.createAnimatedComponent(BlurView);
/** Its published class type predates React 19's JSX types; this is the shape it takes. */
const MaskedView = MaskedViewClass as unknown as ComponentType<ViewProps & { maskElement: ReactElement; children?: ReactNode }>;

/** Each layer's share of the strongest, and where in the ramp's strength it hands in. */
const LAYERS = [
  { share: 0.4, lo: 0.15, hi: 0.6 },
  { share: 1, lo: 0.4, hi: 1 },
] as const;

/** The system blur's intensity (1 to 100) for the strongest blur in CSS px: 8 px is about 40. */
const intensityOf = (px: number) => Math.min(90, Math.max(1, px * 5));

/** LinearGradient wants at least two stops in its type; a mask here has many. */
type Stops<T> = readonly [T, T, ...T[]];

function Layer({ height, at, full, lo, hi, amount, tint }: { height: number; at: (y: number) => number; full: number; lo: number; hi: number; amount?: SharedValue<number>; tint: "dark" | "light" }) {
  const props = useAnimatedProps(() => ({ intensity: Math.max(1, full * (amount ? amount.value : 1)) }));
  const ys = samples(height, 6);
  const colors = ys.map((y) => `rgba(0,0,0,${windowed(at(y), lo, hi).toFixed(3)})`) as unknown as Stops<string>;
  const locations = ys.map((y) => y / height) as unknown as Stops<number>;
  return (
    <MaskedView pointerEvents="none" style={StyleSheet.absoluteFill} maskElement={<LinearGradient pointerEvents="none" colors={colors} locations={locations} style={StyleSheet.absoluteFill} />}>
      <AnimatedBlur pointerEvents="none" animatedProps={props} tint={tint} style={StyleSheet.absoluteFill} />
    </MaskedView>
  );
}

export function EdgeBlur({ height, at, strongest, amount }: EdgeBlurProps) {
  const { dark } = useTheme();
  const opaque = useSolidGlass();
  if (Platform.OS !== "ios" || opaque || height <= 0) return null;
  const full = intensityOf(strongest);
  return (
    <>
      {LAYERS.map(({ share, lo, hi }) => (
        <Layer key={share} height={height} at={at} full={full * share} lo={lo} hi={hi} amount={amount} tint={dark ? "dark" : "light"} />
      ))}
    </>
  );
}
