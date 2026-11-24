// Liquid Glass where the system has it (iOS 26+). Elsewhere, one frost for everything that floats (theme.ts
// `glass.float`): the page blurred and lifted in colour under a grey fill with a hairline edge, so the bar's circles,
// the capsules, the queued card and the chat bar all read as one material. The web blurs with backdrop-filter, an
// older iPhone with expo-blur; Android, whose blur is still experimental, gets the opaque surface. Apple's glass
// renders wrong under opacity, so nothing fades a Glass or its parents: fade what sits on top of it instead.
//
// With Reduce Transparency or Increase Contrast on, every glass is the opaque grey with a 1 px edge (DECISIONS.md
// Home 9), and it changes the moment either setting does.
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { type ReactNode, useEffect, useState } from "react";
import { AccessibilityInfo, Platform, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { glass, useTheme } from "../theme";

const liquid = isLiquidGlassAvailable();
/** True where the system draws Liquid Glass, which renders wrong under opacity: what appears on it scales, never fades. */
export const liquidGlass = liquid;
const frosted = Platform.OS !== "android";
const web = Platform.OS === "web";

/** Kept for callers that still name one: every floating piece now wears the same frost. */
export type GlassMaterial = "regular" | "chrome";

/** Whether the system asks for less transparency or more contrast, kept current while the app runs. */
const asked = { transparency: false, contrast: false };
let solid = false;
const hearers = new Set<(on: boolean) => void>();
function heard(which: keyof typeof asked, on: boolean) {
  asked[which] = on;
  solid = asked.transparency || asked.contrast;
  for (const hear of hearers) hear(solid);
}
if (Platform.OS === "ios") {
  void AccessibilityInfo.isReduceTransparencyEnabled()
    .then((on) => heard("transparency", on))
    .catch(() => {});
  void AccessibilityInfo.isDarkerSystemColorsEnabled()
    .then((on) => heard("contrast", on))
    .catch(() => {});
  AccessibilityInfo.addEventListener("reduceTransparencyChanged", (on) => heard("transparency", on));
  AccessibilityInfo.addEventListener("darkerSystemColorsChanged", (on) => heard("contrast", on));
}

/** For the web build in development: what Increase Contrast would do (`__cc.solidGlass(true)`). */
export function setSolidGlass(on: boolean) {
  heard("contrast", on);
}
if (__DEV__) {
  const g = globalThis as { __cc?: Record<string, unknown> };
  g.__cc = { ...g.__cc, solidGlass: setSolidGlass };
}

/** True while Reduce Transparency or Increase Contrast is on: glass draws as an opaque surface. */
export function useSolidGlass() {
  const [on, setOn] = useState(solid);
  useEffect(() => {
    setOn(solid);
    hearers.add(setOn);
    return () => void hearers.delete(setOn);
  }, []);
  return on;
}

export function Glass({ style, children, interactive = false }: { style?: StyleProp<ViewStyle>; children?: ReactNode; interactive?: boolean; /** Ignored: one material for everything floating. */ material?: GlassMaterial }) {
  const { dark, scheme } = useTheme();
  const opaque = useSolidGlass();
  const g = glass.float;
  const tone = dark ? "dark" : "light";
  if (opaque) return <View style={[{ backgroundColor: g.solid[tone], borderWidth: 1, borderColor: g.solidEdge[tone] }, style]}>{children}</View>;
  if (liquid) {
    return (
      <GlassView glassEffectStyle="regular" colorScheme={scheme} isInteractive={interactive} style={style}>
        {children}
      </GlassView>
    );
  }
  // The edge is drawn inside the shape's 44 pt, never outside it; light glass also lifts off white with a soft drop.
  const edge: ViewStyle = { borderWidth: 1, borderColor: g.edge[tone] };
  const lift: ViewStyle = dark ? {} : { shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } };
  if (!frosted) return <View style={[{ backgroundColor: dark ? "#2a2a2d" : "#f6f6f6" }, edge, lift, style]}>{children}</View>;
  if (web) {
    const filter = `blur(${g.blur}px) saturate(${g.saturate})`;
    return <View style={[{ backgroundColor: g.fill[tone], backdropFilter: filter, WebkitBackdropFilter: filter } as ViewStyle, edge, lift, style]}>{children}</View>;
  }
  // The blur and the fill are clipped to the shape inside it, stacked under the contents (a positioned layer would
  // otherwise paint over a bare icon).
  const radius = StyleSheet.flatten(style)?.borderRadius;
  return (
    <View style={[edge, lift, style, { zIndex: 0 }]}>
      <BlurView intensity={dark ? 60 : 70} tint={dark ? "dark" : "light"} style={[StyleSheet.absoluteFill, { zIndex: -1, borderRadius: radius, overflow: "hidden" }]} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: -1, borderRadius: radius, backgroundColor: g.fill[tone] }]} />
      {children}
    </View>
  );
}
