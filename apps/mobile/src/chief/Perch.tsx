// The Chief on its box: its own pixel character standing on the box's top edge just left of the mic, so you always know
// whose chat this is (DECISIONS.md, "A Chief's chat"; the 2026-10-31 approved design). It stands there on the composer
// and, while an ask is docked in the composer's place, on the dock: the same spot either way, its feet on the edge,
// clear of the status capsule at the left and the jump circle at the right, so the capsule sits at x 16 as it does in
// every chat and no thumb meant for it lands on the character. It reacts to what happens: it hops when it catches your
// note or brings an ask up, knocks twice when a call rings, bobs while it talks, and dozes when nothing has happened
// for a while. Its hops happen only here, on its own screen. What it's doing shows in a thought bubble that trails back
// to its head (Thought, drawn in the floating row where its agents capsule rests); on a call, what it says shows in a
// speech bubble over its head. The bubbles are chrome that floats: they come in with a hair of scale and go with a
// fade, never a bounce; only the character itself hops.
import type { MascotPose } from "@caveman-app/ui/mascot/poses";
import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { Chief } from "../board/model";
import { Sprite } from "../components/Sprite";
import { enter, exit, useReducedMotion } from "../motion";
import { BOX } from "../shell/composer/state";
import { layout, radius, useTheme } from "../theme";
import { usePane } from "../shell/layout";

/** 48 points is 6 device pixels a cell on a 3x phone (the sprite is 24 cells), so it stays crisp and stands as tall as the capsule beside it. */
export const PERCH = 48;
/** Where the composer's perch slot puts it: 30 from the box's left edge (Composer.tsx `perch`). The dock's slot is the same. */
export const PERCH_LEFT = 30;
/** From the box's right edge to the mic's left: the round button, the mic and the gaps between them (composer/state.ts BOX). */
const MIC_FROM_RIGHT = BOX.pad + BOX.circle + BOX.gap + BOX.circle;
/** Room between the character and the mic. */
const BESIDE_MIC = 4;

/** Where the character stands, from the box's left edge, on a box this wide: just left of the mic. */
export const perchX = (box: number) => box - MIC_FROM_RIGHT - BESIDE_MIC - PERCH;
/** How much of the floating row the character's spot keeps clear, from the row's right edge (its left side included). */
export const perchRoom = (box: number) => box - perchX(box) + 8;
/** How wide the box (and the dock, and the floating row) is on a screen this wide. */
export const boxWidth = (screen: number) => screen - layout.inset * 2;

interface Props {
  chief: Chief;
  pose: MascotPose;
  look?: number;
  /** Its speech bubble, on a call. */
  saying: string | null;
  talking: boolean;
  /** Bump to make it hop once. */
  hop: number;
  /** Bump to make it knock twice (a call ringing). */
  knock: number;
}

function Ripple({ delay }: { delay: number }) {
  const { c } = useTheme();
  const grow = useSharedValue(0);
  useEffect(() => {
    grow.value = withSequence(
      withTiming(0, { duration: delay }),
      withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }),
    );
  }, [delay, grow]);
  const style = useAnimatedStyle(() => ({
    opacity: grow.value === 0 ? 0 : 0.7 * (1 - grow.value),
    transform: [{ scale: 0.8 + grow.value * 1.9 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          left: -4,
          top: -4,
          width: PERCH + 8,
          height: PERCH + 8,
          borderRadius: (PERCH + 8) / 2,
          borderWidth: 1.5,
          borderColor: c.text,
        },
        style,
      ]}
    />
  );
}

/** A floating cloud's fill: the raised grey, with an edge in light where it would vanish on white without one. */
function useCloud() {
  const { c, dark } = useTheme();
  return {
    backgroundColor: c.raised,
    ...(dark ? null : { borderWidth: 1, borderColor: c.hairline }),
  };
}

/**
 * Its thought bubble: what it's doing, in a few words, with two small puffs trailing back to its head at the right. It
 * takes the floating row's place while it shows, so it never sits on the capsule or under an ask.
 */
export function Thought({ text }: { text: string }) {
  const { c, t } = useTheme();
  const cloud = useCloud();
  return (
    <Animated.View
      key={text}
      entering={enter.float}
      exiting={exit.gone}
      pointerEvents="none"
      style={{ alignSelf: "center", flexShrink: 1, transformOrigin: "100% 100%" } as object}
    >
      <View
        style={{
          position: "absolute",
          right: -15,
          bottom: 0,
          width: 5,
          height: 5,
          borderRadius: 3,
          ...cloud,
        }}
      />
      <View
        style={{
          position: "absolute",
          right: -10,
          bottom: 6,
          width: 8,
          height: 8,
          borderRadius: 4,
          ...cloud,
        }}
      />
      <View
        accessibilityLiveRegion="polite"
        style={{ ...cloud, borderRadius: radius.bubble, paddingHorizontal: 14, paddingVertical: 8 }}
      >
        <Text numberOfLines={1} style={[t.small, { fontSize: 14, lineHeight: 20, color: c.muted }]}>
          {text}…
        </Text>
      </View>
    </Animated.View>
  );
}

export function Perch({ chief, pose, look, saying, talking, hop, knock }: Props) {
  const { c, t } = useTheme();
  const { width } = usePane();
  const box = boxWidth(width);
  // The slot puts it at PERCH_LEFT; it walks over to its spot by the mic.
  const x = perchX(box) - PERCH_LEFT;
  // Its speech bubble ends at the box's right edge and grows to the left, its tail under the character's mouth.
  const right = box - perchX(box) - PERCH;
  const y = useSharedValue(0);
  const tilt = useSharedValue(0);
  const squash = useSharedValue(1);
  // Under Reduce Motion it stays put: no hops, knocks or bobbing; its poses still say what it's doing.
  const still = useReducedMotion();

  useEffect(() => {
    if (!hop || still) return;
    squash.value = withSequence(
      withTiming(0.86, { duration: 70 }),
      withSpring(1, { damping: 8, stiffness: 420 }),
    );
    y.value = withSequence(
      withTiming(-11, { duration: 150, easing: Easing.out(Easing.quad) }),
      withSpring(0, { damping: 9, stiffness: 380 }),
    );
  }, [hop, squash, y, still]);

  useEffect(() => {
    if (!knock || still) return;
    const rap = [
      withTiming(-10, { duration: 70 }),
      withTiming(8, { duration: 90 }),
      withTiming(0, { duration: 80 }),
    ];
    tilt.value = withSequence(...rap, withTiming(0, { duration: 180 }), ...rap);
  }, [knock, tilt, still]);

  useEffect(() => {
    if (talking && !still)
      y.value = withRepeat(
        withSequence(withTiming(-2, { duration: 140 }), withTiming(0, { duration: 160 })),
        -1,
      );
    else {
      cancelAnimation(y);
      y.value = withSpring(0);
    }
  }, [talking, y, still]);

  const body = useAnimatedStyle(() => ({
    transform: [
      { translateY: y.value },
      { rotate: `${tilt.value}deg` },
      { scaleY: squash.value },
      { scaleX: 2 - squash.value },
    ],
  }));

  return (
    <View pointerEvents="box-none" style={{ width: PERCH, height: PERCH, marginLeft: x }}>
      {knock && !still ? (
        <View key={knock} pointerEvents="none">
          <Ripple delay={0} />
          <Ripple delay={380} />
        </View>
      ) : null}
      <Animated.View pointerEvents="none" style={[{ transformOrigin: "50% 100%" } as object, body]}>
        <Sprite
          character={chief.character}
          tone={chief.tone}
          pose={pose}
          look={look}
          size={PERCH}
          label={chief.name}
        />
      </Animated.View>

      {saying ? (
        <Animated.View
          key={saying}
          entering={enter.float}
          exiting={exit.float}
          pointerEvents="none"
          style={
            {
              position: "absolute",
              right: -right,
              bottom: PERCH + 10,
              width: Math.min(300, box),
              alignItems: "flex-end",
              transformOrigin: "80% 100%",
            } as object
          }
        >
          <View
            accessibilityLiveRegion="polite"
            style={{
              backgroundColor: c.text,
              borderRadius: radius.bubble + 2,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Text
              style={[t.body, { color: c.panel, fontWeight: "500", fontSize: 15, lineHeight: 21 }]}
            >
              {saying}
            </Text>
          </View>
          <View
            style={{
              position: "absolute",
              right: right + PERCH / 2 - 6,
              bottom: -5,
              width: 12,
              height: 12,
              borderRadius: 2,
              backgroundColor: c.text,
              transform: [{ rotate: "45deg" }],
            }}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
