// Dictating into the field (Cursor 5346): the mic and the round button fold into one pill, "■ 0:07 ▮▮▮▮▮", a stop square,
// the time since it started and five ink level bars, with a ✕ circle before it. The words being heard show in italic
// grey inside the field after what's there (Composer.tsx), and the field stays yours to type in. Tapping the pill stops
// and keeps the words; ✕ stops and drops what it heard, leaving the field as it was (holding the pill, or VoiceOver's
// other action on it, does the same). Dictation only ever edits the draft; it never sends.
//
// The pill and ✕ sit on the glass in the quiet circle grey, not as glass of their own: glass on glass is the panel's
// red flag. Both are pressed at 44 (Controls.tsx). While the pill is up it holds the app's audio session for dictation
// (system/audio.ts), so the microphone is live and its bars follow your voice; the words are still the prototype's.
import { useEffect, useState } from "react";
import { type AccessibilityActionEvent, Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon } from "../../components/Icon";
import { enter, exit, haptic, press, release } from "../../motion";
import { holdAudio, useMicLevel } from "../../system/audio";
import { sans, useTheme } from "../../theme";
import { Circle, HIT, Levels, useCircleFill } from "./Controls";
import { BOX } from "./state";

/** Seconds since `since`, ticking once a second. */
function useClock(since: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

export const clockOf = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function DictationPill({ since, hearing, onStop, onDrop }: { since: number; hearing: boolean; onStop: () => void; onDrop: () => void }) {
  const { c } = useTheme();
  const fill = useCircleFill();
  const seconds = useClock(since);
  // The microphone is on for as long as the pill is up.
  useEffect(() => holdAudio("dictation"), []);
  const mic = useMicLevel();
  const scale = useSharedValue(1);
  const pressed = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "drop") onDrop();
    else onStop();
  };
  return (
    <Animated.View entering={enter.fade} exiting={exit.gone} style={{ flexDirection: "row", alignItems: "center", gap: BOX.gap }}>
      <Circle label="Discard what was heard" onPress={onDrop} fill={fill.mic}>
        <Icon name="close" size={16} stroke={2} color={c.muted} />
      </Circle>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Dictating, ${clockOf(seconds)}. Stop and keep the words`}
        accessibilityActions={[{ name: "activate" }, { name: "drop", label: "Stop and drop what was heard" }]}
        onAccessibilityAction={onAction}
        style={{ height: HIT, marginVertical: -(HIT - BOX.circle) / 2, justifyContent: "center" }}
        onPressIn={() => {
          scale.value = withSpring(0.95, press);
        }}
        onPressOut={() => {
          scale.value = withSpring(1, release);
        }}
        onLongPress={() => {
          haptic.thud();
          onDrop();
        }}
        onPress={() => {
          haptic.tap();
          onStop();
        }}
      >
        <Animated.View style={[{ flexDirection: "row", alignItems: "center", gap: 10, height: BOX.circle, paddingLeft: 14, paddingRight: 14, borderRadius: BOX.circle / 2, backgroundColor: fill.plus }, pressed]}>
          <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: c.muted }} />
          <Text style={{ fontFamily: sans, fontSize: 15, lineHeight: 20, color: c.soft, fontVariant: ["tabular-nums"], minWidth: 30 }}>{clockOf(seconds)}</Text>
          <Levels live loud={hearing} level={mic} ink={c.soft} height={13} floor={0.62} />
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}
