// A row you can swipe, as Mail's (and the Chief's cards') grammar has it: right to settle it, left for the rest (pin,
// snooze, archive). A short swipe opens the actions under the row; a long one does the first of them on its own. Every
// action is also a button once open, a VoiceOver custom action on the row, and an entry in the row's long-press menu,
// so nothing is reachable by gesture alone. One row is open at a time, and a tap anywhere on it closes it.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type AccessibilityActionEvent, Pressable, Text, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { interpolate, type SharedValue, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { yieldToBack } from "../../components/edge";
import { Icon, type IconName } from "../../components/Icon";
import { haptic, release } from "../../motion";
import { useTheme } from "../../theme";
import { usePane } from "../layout";

export interface SwipeAction {
  key: string;
  label: string;
  icon: IconName;
  /** The fill behind it, and its ink. */
  fill: string;
  ink: string;
  onPress: () => void;
}

/** Each action's width once the row is open. */
const SLOT = 76;
/** Past this share of the row's width, letting go does the first action on that side. */
const FULL = 0.55;

// The open row's way to close, so opening another closes it.
let openRow: (() => void) | null = null;


function Slot({ action, side, x, full, count, index }: { action: SwipeAction; side: "leading" | "trailing"; x: SharedValue<number>; /** Past this, letting go does the first action. */ full: number; count: number; index: number }) {
  const { t } = useTheme();
  // Each slot takes its share of the space the row has uncovered, so a long pull widens the first one under the thumb.
  const style = useAnimatedStyle(() => {
    const open = side === "leading" ? Math.max(0, x.value) : Math.max(0, -x.value);
    const past = open > full;
    const share = past ? (index === 0 ? open : 0) : open / count;
    const offset = past ? 0 : (open / count) * index;
    return side === "leading" ? { left: offset, width: share } : { right: offset, width: share };
  });
  return (
    <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, overflow: "hidden", backgroundColor: action.fill }, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={action.label}
        onPress={() => {
          haptic.tap();
          action.onPress();
        }}
        style={{ flex: 1, minWidth: SLOT, alignItems: "center", justifyContent: "center", gap: 4, alignSelf: side === "leading" ? "flex-end" : "flex-start" }}
      >
        <Icon name={action.icon} size={20} color={action.ink} />
        <Text numberOfLines={1} style={[t.micro, { color: action.ink }]}>
          {action.label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/**
 * `children` gets `tappable`: whether a tap on the row should be let through. Not while the row is open, nor just after
 * a swipe, when the finger that lifted was dragging (the web's Pressable doesn't hear that the pan took the touch).
 */
export function SwipeRow({ leading = [], trailing = [], children }: { leading?: readonly SwipeAction[]; trailing?: readonly SwipeAction[]; children: (tappable: () => boolean) => ReactNode }) {
  const { width } = usePane();
  const x = useSharedValue(0);
  const from = useSharedValue(0);
  // While it is open, a tap on the row closes it instead of opening the chat.
  const [open, setOpen] = useState(false);
  // One stable way to close it (another row opening calls it), which always runs this render's closing.
  const closing = useRef(() => {});
  const close = useRef(() => closing.current()).current;
  useEffect(() => () => {
    if (openRow === close) openRow = null;
  }, [close]);

  const swiped = useRef(0);
  // The actions under the row exist only while it is being swiped or is open: a long list keeps none, and VoiceOver
  // reaches them through the row's own actions instead.
  const [engaged, setEngaged] = useState(false);
  const letGo = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Once the row is back in place, its actions go.
  const disengage = () => {
    if (letGo.current) clearTimeout(letGo.current);
    letGo.current = setTimeout(() => setEngaged(false), 400);
  };
  const opened = () => {
    if (letGo.current) clearTimeout(letGo.current);
    setEngaged(true);
    swiped.current = Date.now();
    if (openRow && openRow !== close) openRow();
    openRow = close;
  };
  closing.current = () => {
    x.value = withSpring(0, release);
    setOpen(false);
    disengage();
  };
  const settled = (isOpen: boolean) => {
    swiped.current = Date.now();
    setOpen(isOpen);
    if (!isOpen) disengage();
  };

  const tappable = () => !open && Date.now() - swiped.current > 350;
  const fire = (side: "leading" | "trailing") => {
    const action = side === "leading" ? leading[0] : trailing[trailing.length - 1];
    if (!action) return;
    haptic.thud();
    action.onPress();
  };
  const tick = () => haptic.tick();

  const maxLead = leading.length * SLOT;
  const maxTrail = trailing.length * SLOT;
  // A long pull is well past the open actions, however many there are.
  const full = Math.max(width * FULL, Math.max(maxLead, maxTrail) + 56);
  const pan = usePanGesture({
    activeOffsetX: [-14, 14],
    failOffsetY: [-10, 10],
    // A swipe from the screen's left edge is Back's, never the row's (components/edge.ts).
    onBegin: (e) => {
      "worklet";
      yieldToBack(e);
    },
    onActivate: () => {
      "worklet";
      from.value = x.value;
      scheduleOnRN(opened);
    },
    onUpdate: (e) => {
      "worklet";
      let next = from.value + e.translationX;
      // No actions on a side: it gives a little and comes back.
      if (next > 0 && !maxLead) next = Math.sqrt(next) * 2;
      if (next < 0 && !maxTrail) next = -Math.sqrt(-next) * 2;
      const was = Math.abs(x.value) > full;
      x.value = next;
      if (was !== Math.abs(next) > full) scheduleOnRN(tick);
    },
    onDeactivate: (e) => {
      "worklet";
      const v = x.value;
      if (v > full && maxLead) {
        x.value = withSpring(0, release);
        scheduleOnRN(settled, false);
        scheduleOnRN(fire, "leading");
        return;
      }
      if (v < -full && maxTrail) {
        x.value = withSpring(0, release);
        scheduleOnRN(settled, false);
        scheduleOnRN(fire, "trailing");
        return;
      }
      const flung = e.velocityX;
      const target = v > 0 ? (v > maxLead / 2 || flung > 600 ? maxLead : 0) : v < -maxTrail / 2 || flung < -600 ? -maxTrail : 0;
      x.value = withSpring(target, { ...release, velocity: flung });
      scheduleOnRN(settled, target !== 0);
    },
  });

  const row = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const shade = useAnimatedStyle(() => ({ opacity: interpolate(Math.abs(x.value), [0, 24], [0, 1], "clamp") }));
  const all = [...leading, ...trailing];
  const onAction = (e: AccessibilityActionEvent) => all.find((a) => a.key === e.nativeEvent.actionName)?.onPress();

  return (
    <View accessibilityActions={all.map((a) => ({ name: a.key, label: a.label }))} onAccessibilityAction={onAction} style={{ overflow: "hidden" }}>
      {engaged ? (
        <Animated.View
          pointerEvents="box-none"
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? "auto" : "no-hide-descendants"}
          style={[{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }, shade]}
        >
          {leading.map((a, i) => (
            <Slot key={a.key} action={{ ...a, onPress: () => (close(), a.onPress()) }} side="leading" x={x} full={full} count={leading.length} index={i} />
          ))}
          {trailing.map((a, i) => (
            <Slot key={a.key} action={{ ...a, onPress: () => (close(), a.onPress()) }} side="trailing" x={x} full={full} count={trailing.length} index={trailing.length - 1 - i} />
          ))}
        </Animated.View>
      ) : null}
      <GestureDetector gesture={pan}>
        <Animated.View style={row}>
          {children(tappable)}
          {open ? <Pressable accessibilityLabel="Close actions" onPress={close} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }} /> : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
