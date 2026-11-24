// Android and the web: the desktop's switch drawn as it draws it (switch.tsx): on, the monochrome primary track with
// a thumb in its ink; off, the field grey with a grey thumb, inset 2pt on every side, the thumb gliding across on the
// snap curve. React Native's own switch draws its thumb past a thinner track on the web, so it isn't used. Disabled,
// it dims to half, as the desktop's does. iOS uses Toggle.ios.tsx.
import { useEffect } from "react";
import { Pressable } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { duration, ease, haptic } from "../motion";
import { useTheme } from "../theme";

const W = 40;
const H = 24;
const INSET = 2;
const THUMB = H - INSET * 2;

export function Toggle({ value, onChange, label, disabled = false }: { value: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  const { c } = useTheme();
  const at = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    at.value = withTiming(value ? 1 : 0, { duration: duration.base, easing: ease.snap });
  }, [value, at]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: at.value * (W - THUMB - INSET * 2) }] }));
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      hitSlop={10}
      onPress={() => {
        haptic.tick();
        onChange(!value);
      }}
      style={{ width: W, height: H, borderRadius: H / 2, padding: INSET, backgroundColor: value ? c.primary : c.field, opacity: disabled ? 0.5 : 1 }}
    >
      <Animated.View style={[{ width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: value ? c.onPrimary : c.muted }, slide]} />
    </Pressable>
  );
}
