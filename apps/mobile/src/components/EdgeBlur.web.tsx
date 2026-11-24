// The edges' blur in a browser (ProgressiveEdge.tsx): four backdrop blurs stacked, an eighth, a quarter, a half and
// all of the strongest, each handed in by its own eased mask over a long stretch of the ramp and staying on past it.
// Stacked, they compound, so the blur grows as the ramp does and no line of text is sharp in one half and smeared in
// the other. Each layer fades itself: an opacity on a parent would cut the blurs off from the page behind them.
import { StyleSheet, type ViewStyle } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { cssMask, windowed } from "./edgeRamp";

export interface EdgeBlurProps {
  /** The box's height; the blur fills it. */
  height: number;
  /** How whole the blur is `y` pt down from the box's top: 0 none, 1 whole. */
  at: (y: number) => number;
  /** The strongest blur, in CSS px (the phone scales it to its own). */
  strongest: number;
  /** 0 to 1: how much of it is called for, as the band comes in. */
  amount?: SharedValue<number>;
}

/** Each layer's share of the strongest, and where in the ramp's strength it hands in. */
const LAYERS = [
  { share: 1 / 8, lo: 0.15, hi: 0.45 },
  { share: 1 / 4, lo: 0.3, hi: 0.6 },
  { share: 1 / 2, lo: 0.4, hi: 0.75 },
  { share: 1, lo: 0.6, hi: 1 },
] as const;

export function EdgeBlur({ height, at, strongest, amount }: EdgeBlurProps) {
  const shown = useAnimatedStyle(() => ({ opacity: amount ? amount.value : 1 }));
  if (height <= 0) return null;
  return (
    <>
      {LAYERS.map(({ share, lo, hi }) => {
        const px = Math.max(0.5, strongest * share);
        const mask = cssMask(height, (y) => windowed(at(y), lo, hi));
        const style = { backdropFilter: `blur(${px}px)`, WebkitBackdropFilter: `blur(${px}px)`, maskImage: mask, WebkitMaskImage: mask } as ViewStyle;
        return <Animated.View key={share} pointerEvents="none" style={[StyleSheet.absoluteFill, style, shown]} />;
      })}
    </>
  );
}
