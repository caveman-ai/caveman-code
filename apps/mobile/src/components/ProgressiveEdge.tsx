// Quiet scroll edges behind floating controls. Glass owns their separation from the page; these short,
// lightly dimmed ramps soften content only as it passes underneath (DECISIONS.md, Home 7 and Thread top bar).
// The top tail appears after scrolling; the bottom band fades out when the last line clears the composer.
// Web and iOS share the same strengths through EdgeBlur; Android and Reduce Transparency only dim.
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, { interpolate, type SharedValue, useAnimatedStyle, useDerivedValue, useSharedValue } from "react-native-reanimated";
import { alpha, useTheme } from "../theme";
import { EdgeBlur } from "./EdgeBlur";
import { samples, smooth } from "./edgeRamp";
import { usePane } from "../shell/layout";

/** LinearGradient wants at least two stops in its type; every band here has many. */
type Stops<T> = readonly [T, T, ...T[]];

/** The edge's measures, in points. */
export const EDGE = {
  /** The fade starts at the bar's foot, without an opaque strip below it. */
  past: 0,
  /** Then the dim eases out over this. */
  tail: 20,
  /** Maximum dim behind either bar; glass supplies the rest of the separation. */
  dim: 0.35,
  /** The band starts this far over the highest piece at the foot. */
  over: 12,
  /** On Home and the lists, the chat bar's band reaches this far over it. */
  reach: 32,
  /** A page's last line rests this far over the chat bar at the end of its scroll; the band is gone by then. */
  rest: 24,
} as const;

/** The strongest blur under a bar, and behind the chat bar, in CSS px. */
const TOP_BLUR = 4;
const BOTTOM_BLUR = 2;
/** The blur eases out slightly before the dim. */
const LEAD = 0.85;

/** A dim, as gradient stops down a box: `dim(y)` sampled every few points. */
function dimStops(height: number, dim: (y: number) => number, panel: string) {
  const ys = samples(height, 4);
  return {
    colors: ys.map((y) => alpha(panel, Number(dim(y).toFixed(3)))) as unknown as Stops<string>,
    locations: ys.map((y) => y / Math.max(1, height)) as unknown as Stops<number>,
  };
}

/**
 * The band under a bar. `bottom` is the bar's foot from the screen's top (the status bar, the bar, and anything that
 * hangs under it). `scrollY`, when the screen has one, brings the tail in over the first 20 pt of scroll.
 */
export function TopEdge({ bottom, scrollY }: { bottom: number; scrollY?: SharedValue<number> }) {
  const { c } = useTheme();
  const foot = bottom + EDGE.past;
  const total = foot + EDGE.tail;
  const box: ViewStyle = { position: "absolute", top: 0, left: 0, right: 0, height: total };
  const amount = useDerivedValue(() => (scrollY ? interpolate(scrollY.value, [0, 20], [0, 1], "clamp") : 1));
  const tail = useAnimatedStyle(() => ({ opacity: amount.value }));
  const into = (y: number) => (y - foot) / EDGE.tail;
  const dim = (y: number) => (y <= foot ? EDGE.dim : EDGE.dim * (1 - smooth(into(y))));
  const blur = (y: number) => (y <= foot ? 1 : 1 - smooth(into(y) / LEAD));
  const stops = dimStops(total, dim, c.panel);
  // Keep the extra blur near the scroll edge; the controls already have their own glass.
  const from = Math.max(0, foot - 8);
  return (
    <View pointerEvents="none" style={box}>
      <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: from, height: total - from }}>
        <EdgeBlur height={total - from} at={(y) => blur(y + from)} strongest={TOP_BLUR} amount={amount} />
      </View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, tail]}>
        <LinearGradient pointerEvents="none" colors={stops.colors} locations={stops.locations} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </View>
  );
}

/**
 * Where a scrolling page's last real line is on screen, for BottomEdge's `contentBottom`: where that line ends in the
 * content, less the scroll, plus where the scroller starts. A ScrollView feeds `onContentSizeChange` (the content's
 * height less `pad`, the room it keeps clear for the chat bar); a list feeds `onEnd` the y its foot starts at. Feed
 * `scrollY` the offset. Until the end is known it counts as off the screen, so the band starts out whole.
 */
export function useContentEnd(pad: number, top = 0) {
  const scrollY = useSharedValue(0);
  const at = useSharedValue(-1);
  const end = useDerivedValue(() => (at.value >= 0 ? top + at.value - scrollY.value : 1e6));
  return {
    end,
    scrollY,
    onContentSizeChange: (_w: number, h: number) => {
      at.value = Math.max(0, h - pad);
    },
    onEnd: (y: number) => {
      at.value = Math.max(0, y);
    },
  };
}

/**
 * The band behind what floats at the foot, measured up from the screen's bottom edge: `floor`, the chat bar's (or the
 * dock's) top edge; `top`, the highest floating piece's top (the floating row, the queued card), or `floor` when
 * nothing rides on the bar; `reach`, how far over `top` the band starts (12 pt, or 32 over the chat bar on Home and
 * the lists). The ramp runs from there to `floor`, whatever floats between. `contentBottom`, the page's last line from
 * the screen's top (useContentEnd), fades the band out as that line comes clear of the bar; `hold` (0 to 1) keeps it
 * whole, as while the box is open as a card.
 */
export function BottomEdge({
  floor,
  top = floor,
  reach = EDGE.over,
  style,
  contentBottom,
  hold,
}: {
  floor: number;
  top?: number;
  reach?: number;
  style?: ViewStyle;
  contentBottom?: SharedValue<number>;
  hold?: SharedValue<number>;
}) {
  const { c } = useTheme();
  const { height: screenH } = usePane();
  const height = Math.max(floor, top) + reach;
  // The ramp ends at the bar's top edge, then holds its light dim under the glass.
  const ramp = Math.max(1, height - floor);
  const dim = (y: number) => EDGE.dim * smooth(y / ramp);
  const blur = (y: number) => smooth(y / ramp);
  const stops = dimStops(height, dim, c.panel);
  // The bar's top edge on screen, and how much of the band is called for: none while the page's last line is 24 pt
  // or more over it, whole once that line reaches it.
  const barTop = screenH - floor;
  const amount = useDerivedValue(() => {
    const held = hold ? hold.value : 0;
    if (!contentBottom) return 1;
    return Math.max(interpolate(contentBottom.value, [barTop - EDGE.rest, barTop], [0, 1], "clamp"), held);
  });
  const shown = useAnimatedStyle(() => ({ opacity: amount.value }));
  return (
    <View pointerEvents="none" style={[{ position: "absolute", left: 0, right: 0, bottom: 0, height }, style]}>
      <EdgeBlur height={height} at={blur} strongest={BOTTOM_BLUR} amount={amount} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, shown]}>
        <LinearGradient pointerEvents="none" colors={stops.colors} locations={stops.locations} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </View>
  );
}
