// What floats over the page, in one size (DECISIONS.md: "one control size (44) for everything floating"): a glass
// circle (a sheet's X, its back, a header action), a glass pill (a sheet's "7 connected", a toast), and the surface
// they sit on. Glass only on what floats; a row, a tile or a card is flat. When the system asks for less transparency
// or more contrast, every one of them turns opaque, the popover grey with its edge (#1c1c1e in dark), so a label
// never sits on a blur it can't be read over.
import { type ReactNode, useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform, type StyleProp, Text, View, type ViewStyle } from "react-native";
import { FLOAT_TYPE, alpha, layout, useTheme } from "../../theme";
import { Glass } from "../Glass";
import { Icon, type IconName } from "../Icon";
import { Squish } from "../Squish";

// ---------------------------------------------------------------- Reduce Transparency, Increase Contrast

let opaque = false;
const listeners = new Set<() => void>();
const flip = (next: boolean) => {
  if (next === opaque) return;
  opaque = next;
  for (const listener of listeners) listener();
};
const asked = { transparency: false, contrast: false };
const settle = () => flip(asked.transparency || asked.contrast);

if (Platform.OS === "ios") {
  // "Reduce Transparency" and "Increase Contrast" (darker system colours) both ask for solid chrome.
  AccessibilityInfo.isReduceTransparencyEnabled()
    .then((on) => {
      asked.transparency = on;
      settle();
    })
    .catch(() => {});
  AccessibilityInfo.isDarkerSystemColorsEnabled?.()
    .then((on) => {
      asked.contrast = on;
      settle();
    })
    .catch(() => {});
  AccessibilityInfo.addEventListener("reduceTransparencyChanged", (on) => {
    asked.transparency = on;
    settle();
  });
  AccessibilityInfo.addEventListener("darkerSystemColorsChanged", (on) => {
    asked.contrast = on;
    settle();
  });
}
// The web build has no such switch; `?opaque` stands in for it, to check the fallback by eye.
if (Platform.OS === "web" && typeof location !== "undefined" && new URLSearchParams(location.search).has("opaque")) opaque = true;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** True when glass should be solid: Reduce Transparency or Increase Contrast is on. */
export const useSolidChrome = () => useSyncExternalStore(subscribe, () => opaque, () => opaque);

/** The solid surface glass falls back to: the popover grey a step lifted (#1c1c1e in dark), with its edge. */
export function useSolidSurface(): ViewStyle {
  const { c, dark } = useTheme();
  return { backgroundColor: dark ? "#1c1c1e" : c.popover, borderWidth: 1, borderColor: c.edge };
}

// ---------------------------------------------------------------- surfaces

/** Glass, or the solid surface when the system asks for it. Never fade it or its parents (Glass.tsx). */
export function Frost({ style, children, interactive = false }: { style?: StyleProp<ViewStyle>; children?: ReactNode; interactive?: boolean }) {
  const solid = useSolidChrome();
  const surface = useSolidSurface();
  if (solid) return <View style={[surface, style]}>{children}</View>;
  return (
    <Glass interactive={interactive} style={style}>
      {children}
    </Glass>
  );
}

const F = layout.float;

/**
 * A 44pt glass circle with a glyph (or any child): a sheet's X and back, an action at a header's right. It gives under
 * the finger by scale, so the glass never fades.
 */
export function GlassCircle({ icon, label, onPress, children, size = 20, disabled }: { icon?: IconName; label: string; onPress?: () => void; children?: ReactNode; /** The glyph's size: 20 for an X, 22 for a back chevron. */ size?: number; disabled?: boolean }) {
  const { c } = useTheme();
  return (
    <Squish label={label} onPress={onPress} disabled={disabled} depth={0.88} hitSlop={4}>
      <Frost interactive style={{ width: F, height: F, borderRadius: F / 2, alignItems: "center", justifyContent: "center" }}>
        {icon ? <Icon name={icon} size={size} color={c.text} /> : null}
        {children}
      </Frost>
    </Squish>
  );
}

const CHIP = 36;

/**
 * The fill of a control that sits inside a sheet rather than floating over a screen: a search field, a chosen chip,
 * a segmented control's ground. The control grey, lifted a step in dark so it reads on a sheet's grey as native
 * field does (IMG_5347); flat, with no edge, no shadow and no glass (DECISIONS.md: glass only on what floats).
 */
export function useInSheetFill(): string {
  const { c, dark } = useTheme();
  return dark ? alpha(c.text, 0.09) : c.control;
}

/**
 * A scope or category chip (native Search, Grok's Connect): 36pt tall with a 44pt reach. The chosen one is filled
 * with its words at full ink; the rest are plain grey words with no ring, so a row of them never reads as a row of
 * buttons. `round` holds a mark instead of words (a Chief's character): bare while not chosen, on a filled 36pt circle
 * when chosen. Its label is what VoiceOver says. Its size never changes with the choice, so the row never shifts under
 * the thumb. Never glass: chips sit inside a sheet.
 */
export function ScopeChip({ label, said, on, onPress, round = false, children }: { label: string; said?: string; on: boolean; onPress: () => void; round?: boolean; children?: ReactNode }) {
  const { c, t } = useTheme();
  const fill = useInSheetFill();
  const shape: ViewStyle = round
    ? { width: CHIP, height: CHIP, borderRadius: CHIP / 2, alignItems: "center", justifyContent: "center" }
    : { height: CHIP, borderRadius: CHIP / 2, paddingHorizontal: 13, justifyContent: "center" };
  const inside = children ?? (
    <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.row, { fontSize: 15, lineHeight: 20, color: on ? c.text : c.muted, fontWeight: on ? "500" : "400" }]}>
      {label}
    </Text>
  );
  return (
    <Squish label={said ?? label} onPress={onPress} depth={0.94} hitSlop={4} selected={on} role="tab">
      <View style={[shape, on ? { backgroundColor: fill } : null]}>{inside}</View>
    </Squish>
  );
}
