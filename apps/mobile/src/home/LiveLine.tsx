// One line of words that may be live: a Chief's current work on Home, a chat's at-work line. While it runs, a light
// sweeps across it once every 1.8 s (the desktop's .lucy-shimmer); it keeps its ellipsis, because the lit copy is the
// same line drawn again in full ink inside windows that travel over it. Three windows share one centre, each wider
// and fainter than the last, so the light fades at its edges instead of cutting. Under Reduce Motion, or when it isn't
// live, it is plain text and nothing loops.
import { useState } from "react";
import { type StyleProp, StyleSheet, Text, type TextStyle, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { useLoop, useReducedMotion } from "../motion";
import { useTheme } from "../theme";

const SWEEP_MS = 1800;
/** The brightest window's width, as a share of the line; the others are this many times wider, and this faint. */
const BAND = 0.14;
const LAYERS = [
  { scale: 3, opacity: 0.22 },
  { scale: 2, opacity: 0.32 },
  { scale: 1, opacity: 0.5 },
] as const;

function Light({ text, style, lit, clock, width, band, travel }: { text: string; style: StyleProp<TextStyle>; lit: string; clock: SharedValue<number>; width: number; band: number; travel: number }) {
  // The window's centre goes from just before the line to just past it; the copy inside moves back by as much, so its
  // glyphs stay on top of the grey ones.
  const window = useAnimatedStyle(() => ({ transform: [{ translateX: -travel / 2 + clock.value * (width + travel) - band / 2 }] }));
  const copy = useAnimatedStyle(() => ({ transform: [{ translateX: travel / 2 - clock.value * (width + travel) + band / 2 }] }));
  return (
    <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, left: 0, width: band, overflow: "hidden" }, window]}>
      <Animated.View style={[{ width }, copy]}>
        <Text numberOfLines={1} style={[style, { color: lit }]}>
          {text}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

export function LiveLine({ text, style, live = false, lit }: { text: string; style: StyleProp<TextStyle>; live?: boolean; /** The light's ink; full text ink by default. */ lit?: string }) {
  const { c } = useTheme();
  const still = useReducedMotion();
  const on = live && !still;
  const clock = useLoop(SWEEP_MS, on);
  const [width, setWidth] = useState(0);
  const band = Math.max(28, width * BAND);
  const travel = band * LAYERS[0].scale;
  return (
    // Measured always: a line that goes live later must already know its width (the web only reports a resize).
    <View style={{ flexShrink: 1, minWidth: 0 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Text numberOfLines={1} style={style}>
        {text}
      </Text>
      {on && width > 0 ? (
        <View pointerEvents="none" aria-hidden style={[StyleSheet.absoluteFill, { overflow: "hidden" }]}>
          {LAYERS.map((layer) => (
            <View key={layer.scale} style={[StyleSheet.absoluteFill, { opacity: layer.opacity }]}>
              <Light text={text} style={style} lit={lit ?? c.text} clock={clock} width={width} band={band * layer.scale} travel={travel} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
