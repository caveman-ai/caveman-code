// Small marks a row ends on, as the desktop draws them (apps/web/src/shell/Sidebar.tsx NavRow and SectionHeader,
// model-picker.tsx's Default tag, globals.css .tag). Amber appears only where something waits on the person.
import { Text, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import type { Phase } from "../../board/model";
import { useLoop, useReducedMotion } from "../../motion";
import { alpha, useTheme } from "../../theme";
import { PixelIcon } from "../Pixel";

/**
 * The agent is using this screen right now (the desktop's LiveDot): a dot in the one blue, "here", with a ring pulsing
 * out of it every 1.6 s. Reduce Motion keeps the dot.
 */
export function LiveDot({ size = 7 }: { size?: number }) {
  const { c } = useTheme();
  const still = useReducedMotion();
  const clock = useLoop(1600, !still);
  const ring = useAnimatedStyle(() => ({ opacity: 0.7 * (1 - clock.value), transform: [{ scale: 1 + 2 * clock.value }] }));
  const dot = { position: "absolute", width: size, height: size, borderRadius: size / 2, backgroundColor: c.target } as const;
  return (
    <View accessibilityRole="image" accessibilityLabel="In use by the agent" pointerEvents="none" style={{ width: size, height: size }}>
      {still ? null : <Animated.View style={[dot, ring]} />}
      <View style={dot} />
    </View>
  );
}

/**
 * A count. `urgent` (Review's "2 ask for your review"): amber figures on an amber wash in a small rounded square, the
 * one count that is on you. Otherwise a plain tabular figure in the tertiary grey (a section's size, a filter's tally).
 * Nothing at zero.
 */
export function Count({ n, urgent = false, label }: { n: number; urgent?: boolean; label?: string }) {
  const { c, t } = useTheme();
  if (!n) return null;
  if (!urgent)
    return (
      <Text accessibilityLabel={label} style={[t.meta, { fontWeight: "500" }]}>
        {n}
      </Text>
    );
  return (
    <View accessibilityLabel={label ?? `${n} need you`} style={{ minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 6, backgroundColor: alpha(c.warning, 0.15), alignItems: "center", justifyContent: "center" }}>
      <Text style={[t.micro, { color: c.warning }]}>{n}</Text>
    </View>
  );
}

/**
 * The amber dot: something here waits on you, with no number to read (a Chief, the menu button). 8pt and round. A chat
 * row's own needs-you mark is the pixel `state-needs-you` (PixelIcon), the desktop's StatusMark; this is the plain dot
 * beside a name. `color` for the one other use, a live dot in the one blue or the success green of "connected".
 */
export function Dot({ label, color, size = 8 }: { label?: string; color?: string; size?: number }) {
  const { c } = useTheme();
  return <View accessibilityRole={label ? "image" : undefined} accessibilityLabel={label} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? c.warning }} />;
}

/**
 * A tag: short words on a quiet fill with an edge (globals.css .tag). `blue` is the model picker's Default and the
 * team's scope; `green` a sign-in that works; `yellow` what isn't set up yet ("Not connected", "Not trusted");
 * `purple` a project's scope; `neutral` the deck's pill (the control grey, the hairline, the secondary ink).
 */
export function Tag({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "blue" | "green" | "yellow" | "purple" }) {
  const { c, t, dark } = useTheme();
  const looks = {
    neutral: { fill: c.control, edge: dark ? c.field : c.hairline, ink: c.soft },
    blue: { fill: c.tag, edge: c.tagEdge, ink: c.tagInk },
    green: { fill: c.tagGreen, edge: c.tagGreenEdge, ink: c.tagGreenInk },
    yellow: { fill: c.tagYellow, edge: c.tagYellowEdge, ink: c.tagYellowInk },
    purple: { fill: c.tagPurple, edge: c.tagPurpleEdge, ink: c.tagPurpleInk },
  };
  const look = looks[tone];
  return (
    <View style={{ height: 20, paddingHorizontal: 6, borderRadius: 5, borderWidth: 1, borderColor: look.edge, backgroundColor: look.fill, alignItems: "center", justifyContent: "center" }}>
      <Text numberOfLines={1} style={[t.micro, { color: look.ink }]}>
        {label}
      </Text>
    </View>
  );
}

/** The words a state mark stands for, said by a screen reader and printed beside it in a row's meta line. */
export const STATE_WORD: Readonly<Record<Phase, string>> = { needs: "Needs you", working: "Working", ready: "Ready", done: "Done" };

/**
 * A chat's state at a row's start, in the same pixel family as Home's tiles and every list's rows (shell/rows/ChatRow
 * RowMark): the amber ask while it needs you, the green check when it is ready, the working ring turning while it works,
 * a dim dot once it is over. One concept never wears two icon families. The words in the row say the same, so colour
 * is never the only sign.
 */
export function StateDot({ phase, label = STATE_WORD[phase] }: { phase: Phase; label?: string }) {
  const { c } = useTheme();
  const mark =
    phase === "needs" ? <PixelIcon name="state-needs-you" ink={c.warning} /> : phase === "working" ? <PixelIcon name="state-working" /> : phase === "ready" ? <PixelIcon name="state-done" /> : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: alpha(c.text, 0.18) }} />;
  return (
    <View accessibilityRole="image" accessibilityLabel={label} style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
      {mark}
    </View>
  );
}
