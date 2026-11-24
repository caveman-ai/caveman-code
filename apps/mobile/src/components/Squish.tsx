// Anything you can press: it gives under the finger and settles back to size when you let go, without a bounce (the
// desktop's buttons sink to 0.98 and come straight back). A row also lights the deck's hover surface while held, the
// way the desktop's rows light on hover. Disabled is half ink, as the desktop dims it; don't disable a Squish that
// holds a Glass, since Liquid Glass renders wrong under opacity.
import { type ReactNode, useRef, useState } from "react";
import { type HostInstance, Pressable, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { haptic, press, release } from "../motion";
import { useTheme } from "../theme";

/** The last thing pressed, so a sheet it opens can give it focus back when it closes (shell/Sheet.tsx). */
export const lastPress: { node: unknown } = { node: null };

interface Props {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  /** What the long press does, for a screen reader, which offers it as an action. */
  longLabel?: string;
  label: string;
  style?: StyleProp<ViewStyle>;
  /** How far it gives: 0.985 for rows, 0.97 for buttons and cards, 0.9 for a small round button. */
  depth?: number;
  /** Light the hover surface while held (rows). */
  highlight?: boolean;
  hitSlop?: number;
  disabled?: boolean;
  selected?: boolean;
  role?: "button" | "link" | "tab";
}

export function Squish({ children, onPress, onLongPress, longLabel, label, style, depth = 0.96, highlight = false, hitSlop, disabled, selected, role = "button" }: Props) {
  const { c } = useTheme();
  const scale = useSharedValue(1);
  const [held, setHeld] = useState(false);
  const self = useRef<HostInstance>(null);
  const pressed = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      ref={self}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      accessibilityActions={onLongPress && longLabel ? [{ name: "longpress", label: longLabel }] : undefined}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "longpress") onLongPress?.();
      }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPressIn={() => {
        scale.value = withSpring(depth, press);
        if (highlight) setHeld(true);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, release);
        if (highlight) setHeld(false);
      }}
      onLongPress={onLongPress}
      onPress={() => {
        haptic.tap();
        lastPress.node = self.current;
        onPress?.();
      }}
    >
      <Animated.View style={[style, held ? { backgroundColor: c.raised } : null, disabled ? { opacity: 0.5 } : null, pressed]}>{children}</Animated.View>
    </Pressable>
  );
}
