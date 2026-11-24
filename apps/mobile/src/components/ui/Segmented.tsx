// The one segmented control on the phone, for every choice of one among a few (the model sheet's Effort and Speed,
// Automations | Agents, Light or dark, where a project is): a `control` capsule, radius 22, of equal-width 44pt
// segments, the chosen one on a lifted capsule with its words in `text`, the rest 15/500 in `muted`. The lifted
// capsule slides to what you tap on the deck's snap curve. Past four options it wraps into rows of three (Claude's
// six efforts read 3 + 3), each row sharing its width, and never scrolls sideways, so every word is whole. A segment
// may lead with its mark (Add a project's folder and GitHub), in the same ink as its words.
//
// The track is `control` laid as a tint of ink, so it reads the same on a settings card (`raised`) as on the sheet or
// the page. The lift is a step lighter than the track in dark and the card's white over it in light, with a soft
// shadow there: `raised` sits within a few levels of `control` in both themes, so it would not show as a thumb.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { duration, ease, haptic } from "../../motion";
import { alpha, useTheme, weight } from "../../theme";

/** A segment's mark, or one drawn for its state: `on` while chosen, `ink` the colour its words are in. */
export type SegmentMark = ReactNode | ((state: { on: boolean; ink: string }) => ReactNode);

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: SegmentMark;
}

/** A segment's height: a thumb's target. */
const SEGMENT = 44;
/** How far the lift sits in from its segment's edge. */
const INSET = 3;
/** How many segments fit on one row before the control wraps; past it, rows of three. */
const ONE_ROW = 4;
const PER_ROW = 3;

/** The rows the options fall into: one row up to four, else rows of three. */
function rowsOf<T>(options: readonly T[]): T[][] {
  if (options.length <= ONE_ROW) return [options.slice()];
  const rows: T[][] = [];
  for (let i = 0; i < options.length; i += PER_ROW) rows.push(options.slice(i, i + PER_ROW));
  return rows;
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: readonly SegmentOption<T>[]; value: T; onChange: (value: T) => void; /** What VoiceOver calls the group ("Effort"). */ label: string }) {
  const { c, dark } = useTheme();
  const rows = rowsOf(options);
  const [width, setWidth] = useState(0);
  // Where the chosen segment is: its row, and its place and count in that row.
  let row = 0;
  let col = 0;
  rows.forEach((r, i) => {
    const j = r.findIndex((o) => o.value === value);
    if (j >= 0) {
      row = i;
      col = j;
    }
  });
  const cols = rows[row]?.length ?? 1;
  const chosen = options.some((o) => o.value === value);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const w = useSharedValue(0);
  const placed = useRef(false);
  useEffect(() => {
    if (!width) return;
    const cell = width / cols;
    const to = { x: col * cell + INSET, y: row * SEGMENT + INSET, w: cell - INSET * 2 };
    // It stands where it belongs the first time it is drawn, and slides from then on.
    if (!placed.current) {
      placed.current = true;
      x.value = to.x;
      y.value = to.y;
      w.value = to.w;
      return;
    }
    const how = { duration: duration.base, easing: ease.snap };
    x.value = withTiming(to.x, how);
    y.value = withTiming(to.y, how);
    w.value = withTiming(to.w, how);
  }, [width, row, col, cols, x, y, w]);
  const lift = useAnimatedStyle(() => ({ width: w.value, transform: [{ translateX: x.value }, { translateY: y.value }] }));

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ borderRadius: SEGMENT / 2, backgroundColor: alpha(c.text, dark ? 0.07 : 0.065) }}
    >
      {width && chosen ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: 0,
              top: 0,
              height: SEGMENT - INSET * 2,
              borderRadius: (SEGMENT - INSET * 2) / 2,
              backgroundColor: dark ? alpha(c.text, 0.12) : c.card,
              shadowColor: "#000",
              shadowOpacity: dark ? 0 : 0.1,
              shadowRadius: 3,
              shadowOffset: { width: 0, height: 1 },
            },
            lift,
          ]}
        />
      ) : null}
      {rows.map((r, i) => (
        <View key={i} style={{ flexDirection: "row" }}>
          {r.map((o) => (
            <Segment key={o.value} label={o.label} icon={o.icon} group={label} on={o.value === value} onPress={() => onChange(o.value)} />
          ))}
        </View>
      ))}
    </View>
  );
}

function Segment({ label, icon, group, on, onPress }: { label: string; icon?: SegmentMark; group: string; on: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  const ink = on || held ? c.text : c.muted;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${group}: ${label}`}
      accessibilityState={{ checked: on }}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        if (on) return;
        haptic.tick();
        onPress();
      }}
      style={[{ flex: 1, flexBasis: 0, minWidth: 0, height: SEGMENT, flexDirection: "row", gap: 8, paddingHorizontal: 8, alignItems: "center", justifyContent: "center" }, { outlineStyle: "none" } as object]}
    >
      {typeof icon === "function" ? icon({ on, ink }) : (icon ?? null)}
      <Text numberOfLines={1} style={[t.row, { fontSize: 15, lineHeight: 20, fontWeight: weight.medium, color: ink }]}>
        {label}
      </Text>
    </Pressable>
  );
}
