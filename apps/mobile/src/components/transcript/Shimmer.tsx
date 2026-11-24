// The desktop's working shimmer (globals.css .lucy-shimmer): a light that sweeps left to right across a grey label,
// once every 1.8s, while the agent works. CSS clips a gradient to the glyphs; React Native has no text clipping, so
// the light moves piece by piece instead, each lifting from the description grey to ink as the band passes over it:
// letter by letter on a word or two ("Working"), so it sweeps rather than blinks, and word by word on a longer line.
// Under Reduce Motion it holds still in the grey, as the desktop's does.
import { Text, type TextStyle, View } from "react-native";
import Animated, { interpolateColor, type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { useLoop, useReducedMotion } from "../../motion";
import { useTheme } from "../../theme";

const SWEEP_MS = 1800;
/** How wide the light is, as a share of the label (the gradient's 38% to 62% around its peak). */
const BAND = 0.26;

function Word({ text, at, clock, style, from, to, lift }: { text: string; at: number; clock: SharedValue<number>; style: TextStyle; from: string; to: string; lift: number }) {
  const lit = useAnimatedStyle(() => {
    // The band's centre travels from a third of the label before its start to as far past its end.
    const centre = -0.34 + clock.value * 1.68;
    const near = Math.max(0, 1 - Math.abs(at - centre) / BAND);
    return { color: interpolateColor(near * lift, [0, 1], [from, to]) };
  });
  return <Animated.Text style={[style, lit]}>{text}</Animated.Text>;
}

/**
 * A label that shimmers while `on`; off, it is plain text in its style's colour. `lift` is how far the light goes from
 * that colour toward ink at its peak: all the way on a live row, about half on a sidebar's working title, where a
 * dozen of them would otherwise flicker.
 */
export function Shimmer({ text, style, on = true, lift = 1 }: { text: string; style: TextStyle | TextStyle[]; on?: boolean; lift?: number }) {
  const { c } = useTheme();
  const still = useReducedMotion();
  const clock = useLoop(SWEEP_MS, on && !still);
  const merged = Object.assign({}, ...[style].flat()) as TextStyle;
  // Every piece keeps a line of its own height, so a descender ("g", "y") isn't cut by the clipped row.
  const flat: TextStyle = { ...merged, lineHeight: merged.lineHeight ?? Math.round((merged.fontSize ?? 14) * 1.4) };
  if (!on || still) return <Text style={flat}>{text}</Text>;
  // A short label sweeps by its letters; a long one by its words, which keeps a summary line to a few dozen pieces.
  const words = text.trim().split(/\s+/).length < 3 ? [...text] : text.split(/(\s+)/);
  const total = Math.max(1, text.length);
  let offset = 0;
  return (
    <View accessible accessibilityLabel={text} style={{ flexDirection: "row", flexWrap: "nowrap", flexShrink: 1, minWidth: 0, overflow: "hidden", paddingBottom: 2, marginBottom: -2 }}>
      {words.map((word, i) => {
        const at = (offset + word.length / 2) / total;
        offset += word.length;
        if (!word.trim()) return <Text key={i} style={flat}>{word.replace(/\s/g, " ")}</Text>;
        return <Word key={i} text={word} at={at} clock={clock} style={flat} from={(flat.color as string) ?? c.muted} to={c.text} lift={lift} />;
      })}
    </View>
  );
}
