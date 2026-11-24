// Where a search landed: the `control` tint behind what it found for 1.2s (held 0.9s, then fading over 0.3s), the
// thread's own landing (components/Transcript.tsx Flash) for anything else a search opens on, a line in a Chief's
// chat. It wraps its child whether lit or not, so lighting it never mounts the child again.
import { type ReactNode, useEffect } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { ease } from "../../motion";
import { useTheme } from "../../theme";

/** How long the tint holds before it fades, and how long it fades: 1.2s in all. */
const HOLD_MS = 900;
const FADE_MS = 300;

export function AnchorFlash({ on, children }: { /** Lights it, once each time it turns true. */ on: boolean; children: ReactNode }) {
  const { c } = useTheme();
  const tint = useSharedValue(0);
  useEffect(() => {
    if (!on) return;
    tint.value = 1;
    tint.value = withDelay(HOLD_MS, withTiming(0, { duration: FADE_MS, easing: ease.fade }));
  }, [on, tint]);
  const style = useAnimatedStyle(() => ({ opacity: tint.value }));
  return (
    <View>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", top: -6, bottom: -6, left: -8, right: -8, borderRadius: 10, backgroundColor: c.control }, style]} />
      {children}
    </View>
  );
}
