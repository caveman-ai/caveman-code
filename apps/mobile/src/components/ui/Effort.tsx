// Effort, how hard the model thinks before it acts, as a slider at the foot of the model sheet (the desktop's
// EffortSlider, packages/ui/src/components/effort.tsx, STYLE.md 11; "make effort a slider as
// well with a lightning icon next to it"), for a finger. Over the track, "Effort" in grey and the level's name in ink;
// at the head's right, "Make default" while the chat's effort or speed isn't where its model starts. The track is in
// the panel's colour with a hairline, its filled part the quiet control grey up to the thumb, a 3pt stop per level the
// model offers, and under its two ends the lowest and the highest level's names. The thumb is a notched block in ink
// (the identity layer's one touch on the control) that glides stop to stop on the snap curve; a drag jumps stop to stop
// under the finger with a selection tick each step, a tap lands on the nearest. Past the ceiling the name, the thumb
// and those stops take the tier: Max red, Ultracode purple. Where the model starts is a hollow square in place of its
// stop while the thumb is elsewhere.
//
// Beside the track, the bolt (the desktop's SpeedToggle): a quiet circle with the bolt in grey at standard, filled in
// `speed` while a faster speed is on, two bolts at the fastest of two; a tap goes to the next speed and back to
// standard after the fastest. A model with one speed shows it too, dimmed and inert (the founder asked for the bolt
// beside the slider; the desktop hides it there).
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { nextSpeed, speedLabel, STANDARD } from "../../board/catalog";
import { duration, ease, haptic, press, release } from "../../motion";
import { alpha, useTheme } from "../../theme";
import { effortColor, effortLabel, SpeedBolt } from "./EngineLogo";

/** Room between the track's ends and the first and last stop: half the thumb and a little air. */
const PAD = 14;
const THUMB_W = 14;
const THUMB_H = 22;
const TRACK_H = 34;
/** The bolt's circle as drawn, and as pressed. */
const BOLT = 36;
const HIT = 44;

/** A block with its corners stepped in by 2 (pixel.css px-notch-2), and a darker band along its foot. */
function Thumb({ color }: { color: string }) {
  const notch = `M2 0H${THUMB_W - 2}V2H${THUMB_W}V${THUMB_H - 2}H${THUMB_W - 2}V${THUMB_H}H2V${THUMB_H - 2}H0V2H2Z`;
  return (
    <Svg width={THUMB_W} height={THUMB_H} viewBox={`0 0 ${THUMB_W} ${THUMB_H}`}>
      <Path d={notch} fill={color} />
      <Path d={`M2 ${THUMB_H - 2}H${THUMB_W - 2}V${THUMB_H}H2Z`} fill="#0d0914" fillOpacity={0.28} />
    </Svg>
  );
}

/** A model's speeds beside its effort: the faster tiers it offers, the chat's, and a way to change it. */
export interface SpeedProps {
  speeds: readonly string[];
  value: string | undefined;
  onChange: (speed: string) => void;
}

/**
 * The bolt (speed.tsx SpeedToggle): drawn as a 36pt circle and pressed at 44. Off, a grey outline on the quiet fill;
 * on, filled in `speed` on a wash of it, two bolts at the fastest of two or more. A tap goes to the next speed.
 */
export function SpeedToggle({ speeds, value, onChange }: SpeedProps) {
  const { c, dark } = useTheme();
  const scale = useSharedValue(1);
  const pressed = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
 // A model with one speed still shows the bolt beside its effort ("a lightning icon next to
  // it"), quiet and inert, so the slider always reads as the desktop's pair; it says why it doesn't change.
  if (!speeds.length) {
    return (
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel="Speed: Standard"
        accessibilityHint="This model runs at one speed"
        accessibilityState={{ disabled: true }}
        style={{ width: BOLT, height: BOLT, borderRadius: BOLT / 2, alignItems: "center", justifyContent: "center", backgroundColor: alpha(c.text, dark ? 0.05 : 0.035), opacity: 0.55 }}
      >
        <SpeedBolt on={false} size={17} />
      </View>
    );
  }
  const faster = value !== undefined && value !== STANDARD && speeds.includes(value) ? value : undefined;
  const on = faster !== undefined;
  const fastest = faster !== undefined && speeds.length > 1 && speeds.indexOf(faster) === speeds.length - 1;
  const next = nextSpeed(speeds, value);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Speed: ${speedLabel(faster ?? STANDARD)}`}
      accessibilityHint={`Changes it to ${speedLabel(next)}`}
      accessibilityState={{ selected: on }}
      style={{ width: HIT, height: HIT, margin: -(HIT - BOLT) / 2, alignItems: "center", justifyContent: "center" }}
      onPressIn={() => {
        scale.value = withSpring(0.9, press);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, release);
      }}
      onPress={() => {
        haptic.tick();
        onChange(next);
      }}
    >
      <Animated.View style={[{ width: BOLT, height: BOLT, borderRadius: BOLT / 2, alignItems: "center", justifyContent: "center", backgroundColor: on ? alpha(c.speed, dark ? 0.16 : 0.14) : alpha(c.text, dark ? 0.085 : 0.055) }, pressed]}>
        <SpeedBolt on={on} double={fastest} size={17} />
      </Animated.View>
    </Pressable>
  );
}

export function EffortSlider({
  levels,
  value,
  start,
  onChange,
  onSave,
  saveLabel,
  speed,
}: {
  levels: readonly string[];
  value: string;
  /** The level the model starts at. */
  start?: string;
  onChange: (level: string) => void;
  /** While the chat isn't where its model starts: "Make default" at the head's right makes it the start. */
  onSave?: () => void;
  saveLabel?: string;
  /** The bolt beside the track, on a model with a faster speed. */
  speed?: SpeedProps;
}) {
  const { c, t, dark } = useTheme();
  const n = levels.length;
  const index = Math.max(0, levels.indexOf(value));
  const [width, setWidth] = useState(0);
  const at = (i: number) => (n > 1 ? i / (n - 1) : 0.5);
  const p = useSharedValue(at(index));
  const span = useSharedValue(0);
  useEffect(() => {
    p.value = withTiming(at(index), { duration: duration.fast, easing: ease.snap });
  }, [index, n, p]);

  const pick = (x: number) => {
    const i = Math.round(Math.min(1, Math.max(0, (x - PAD) / Math.max(1, width - PAD * 2))) * (n - 1));
    if (levels[i] !== value) {
      haptic.tick();
      onChange(levels[i]!);
    }
  };
  const pan = usePanGesture({
    minDistance: 0,
    onBegin: (e) => {
      "worklet";
      scheduleOnRN(pick, e.x);
    },
    onUpdate: (e) => {
      "worklet";
      scheduleOnRN(pick, e.x);
    },
  });

  // The fill ends at the thumb's far edge, and over the last step it closes the rest of the track, so the highest level
 // is a full bar with no sliver of track left past the thumb ("make sure the effort slider fully
  // closes on the highest mode ... no gap leftover").
  const fill = useAnimatedStyle(() => {
    const last = n > 1 ? 1 - 1 / (n - 1) : 0;
    const closing = Math.min(1, Math.max(0, (p.value - last) / Math.max(0.0001, 1 - last)));
    return { width: PAD + THUMB_W / 2 + p.value * span.value + closing * (PAD - THUMB_W / 2 + 2) };
  }, [n]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: PAD - THUMB_W / 2 + p.value * span.value }] }));
  if (n < 2) return null;
  const level = levels[index]!;
  const tier = effortColor(level, c);
  const bolt = !!speed;

  return (
    <View>
      {/* The head: what it is and where it stands, and the way to keep it. */}
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 28, gap: 8 }}>
        <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.subtle }]}>Effort</Text>
        <Text numberOfLines={1} style={[t.row, { flexShrink: 1, fontSize: 15, lineHeight: 20, fontWeight: "600", color: tier ?? c.text }]}>
          {effortLabel(level)}
        </Text>
        <View style={{ flex: 1 }} />
        {onSave ? (
          <Pressable accessibilityRole="button" accessibilityLabel={saveLabel ?? `Make ${effortLabel(level)} the default`} hitSlop={10} onPress={onSave} style={{ minHeight: 28, justifyContent: "center" }}>
            <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.muted }]}>Make default</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: HIT, marginTop: 4 }}>
        <GestureDetector gesture={pan}>
          <View
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Effort"
            accessibilityValue={{ min: 0, max: n - 1, now: index, text: effortLabel(level) }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(e) => {
              const next = index + (e.nativeEvent.actionName === "increment" ? 1 : -1);
              if (levels[next]) onChange(levels[next]!);
            }}
            onLayout={(e) => {
              setWidth(e.nativeEvent.layout.width);
              span.value = e.nativeEvent.layout.width - PAD * 2;
            }}
            style={{ flex: 1, height: TRACK_H, borderRadius: 9, backgroundColor: c.panel, borderWidth: 1, borderColor: c.hairline, justifyContent: "center" }}
          >
            <Animated.View style={[{ position: "absolute", left: -1, top: -1, bottom: -1, borderRadius: 9, backgroundColor: c.control, borderWidth: 1, borderColor: dark ? c.field : alpha(c.text, 0.14) }, fill]} />
            {width
              ? levels.map((stop, i) => {
                  const x = PAD + at(i) * (width - PAD * 2) - 1;
                  const ink = effortColor(stop, c);
                  return stop === start && stop !== level ? (
                    <View key={stop} style={{ position: "absolute", left: x - 3.5 + 1.5, width: 7, height: 7, borderWidth: 1, borderColor: ink ?? c.muted }} />
                  ) : (
                    <View key={stop} style={{ position: "absolute", left: x, width: 3, height: 3, backgroundColor: ink ?? alpha(c.muted, 0.8) }} />
                  );
                })
              : null}
            <Animated.View pointerEvents="none" style={[{ position: "absolute", left: -1, top: (TRACK_H - THUMB_H) / 2 - 1 }, thumb]}>
              <Thumb color={tier ?? c.text} />
            </Animated.View>
          </View>
        </GestureDetector>
        {bolt ? <SpeedToggle {...speed} /> : null}
      </View>

      {/* The two ends, named under the track's own ends (the bolt's room kept clear). */}
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", marginTop: 2, marginRight: bolt ? BOLT + 12 : 0 }}>
        <Text numberOfLines={1} style={[t.meta, { flex: 1 }]}>
          {effortLabel(levels[0]!)}
        </Text>
        <Text numberOfLines={1} style={[t.meta, { flex: 1, textAlign: "right" }]}>
          {effortLabel(levels[n - 1]!)}
        </Text>
      </View>
    </View>
  );
}
