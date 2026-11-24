// The change itself, small enough to hold: the Runs page the dark-mode chat built. On a connected runtime this is the
// chat's preview (its branch's dev server or screenshots); here it is drawn, so you can flip the theme and feel it.
// The page is drawn in the deck's own values, light and dark (theme.ts), its status dots in the deck's success and
// destructive and the working grey, so "status dots keep their meaning in both themes" is true of the drawing too.
import { View } from "react-native";
import Animated, { interpolateColor, type SharedValue, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { mono } from "../theme";

export const RUNS = [
  { name: "nightly-evals", state: "passed", time: "2m 14s", dot: "passed" },
  { name: "relay-soak", state: "failed", time: "41s", dot: "failed" },
  { name: "usage-backfill", state: "running", time: "6m", dot: "running" },
  { name: "docs-build", state: "passed", time: "1m 02s", dot: "passed" },
] as const;

/** The deck's panel, card, ink, grey and hairline, and its state colours (theme.ts), for each theme the page can take. */
export const LIGHT = { page: "#ffffff", row: "#f5f5f5", text: "#1f1f21", muted: "#5c5c5e", line: "#e7e7e7", passed: "#218349", failed: "#ca2b30", running: "#5c5c5e" };
export const DARK = { page: "#121213", row: "#1a1a1b", text: "#e3e4e6", muted: "#959597", line: "#232426", passed: "#3fcf7b", failed: "#e36369", running: "#959597" };

function Row({ run, dark, small }: { run: (typeof RUNS)[number]; dark: SharedValue<number>; small: boolean }) {
  const row = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(dark.value, [0, 1], [LIGHT.row, DARK.row]) }));
  const name = useAnimatedStyle(() => ({ color: interpolateColor(dark.value, [0, 1], [LIGHT.text, DARK.text]) }));
  const meta = useAnimatedStyle(() => ({ color: interpolateColor(dark.value, [0, 1], [LIGHT.muted, DARK.muted]) }));
  const dot = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(dark.value, [0, 1], [LIGHT[run.dot], DARK[run.dot]]) }));
  const size = small ? 7 : 13;
  return (
    <Animated.View style={[{ flexDirection: "row", alignItems: "center", gap: small ? 4 : 10, paddingHorizontal: small ? 5 : 12, paddingVertical: small ? 4 : 10, borderRadius: small ? 3 : 6 }, row]}>
      <Animated.View style={[{ width: small ? 4 : 7, height: small ? 4 : 7, borderRadius: 4 }, dot]} />
      <Animated.Text numberOfLines={1} style={[{ flex: 1, fontSize: size, fontWeight: "600" }, name]}>
        {run.name}
      </Animated.Text>
      {small ? null : <Animated.Text style={[{ fontSize: 12 }, meta]}>{run.state}</Animated.Text>}
      <Animated.Text style={[{ fontSize: small ? 6 : 12, fontFamily: mono, minWidth: small ? 0 : 52, textAlign: "right" }, meta]}>{run.time}</Animated.Text>
    </Animated.View>
  );
}

/** `dark`: 0 light, 1 dark, anything between while it animates. Without one the preview is dark and still. */
export function RunsPreview({ dark, small = false }: { dark?: SharedValue<number>; small?: boolean }) {
  const still = useSharedValue(1);
  const theme = dark ?? still;
  const page = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(theme.value, [0, 1], [LIGHT.page, DARK.page]),
    borderColor: interpolateColor(theme.value, [0, 1], [LIGHT.line, DARK.line]),
  }));
  const title = useAnimatedStyle(() => ({ color: interpolateColor(theme.value, [0, 1], [LIGHT.text, DARK.text]) }));
  const count = useAnimatedStyle(() => ({ color: interpolateColor(theme.value, [0, 1], [LIGHT.muted, DARK.muted]) }));
  return (
    <Animated.View style={[{ borderWidth: 1, borderRadius: small ? 6 : 12, padding: small ? 6 : 14, gap: small ? 3 : 6, overflow: "hidden" }, page]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: small ? 1 : 4 }}>
        <Animated.Text style={[{ fontSize: small ? 9 : 20, fontWeight: "600", letterSpacing: -0.3 }, title]}>Runs</Animated.Text>
        {small ? null : <Animated.Text style={[{ fontSize: 12 }, count]}>4 today</Animated.Text>}
      </View>
      {RUNS.map((run) => (
        <Row key={run.name} run={run} dark={theme} small={small} />
      ))}
    </Animated.View>
  );
}
