// A turn's fold (DECISIONS.md O4), both ways on one curve: 240ms easing out with no overshoot, the height and the fade
// together. Opening first lays the body out unseen at no height, then grows it to what it measured, so a large fold
// never snaps open in one frame. Closing as a turn ends starts from exactly the height that keeps what follows the
// fold where it was: the answer moving out from under it (`drop`) and the "Worked for" line arriving above it (`lead`)
// are taken off in the same frame, so the answer never jumps. When that leaves nothing to shrink (one part folding
// into its own "Worked for" line), the body fades out where it stood, over the line, `over` points up so its words sit
// on the line's, a crossfade in place with nothing moving. Under Reduce Motion it is a cut. A fold that starts shut (a
// turn from history) draws nothing at all.
import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import { View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useReducedMotion } from "../motion";

export const FOLD_MS = 240;
/** Ease-out with no overshoot, as a bezier (the web's Reanimated takes only those). */
const OUT = Easing.bezier(0.33, 1, 0.68, 1);

/** What the fold is doing: at rest (its own height), growing to what it measured, shrinking away, or fading in place. */
type Phase = "rest" | "opening" | "closing" | "fading";

/**
 * `lead`: how much was just added above what follows the fold as it closed (its "Worked for" line, a gap that grew).
 * `drop`: how much of what it held just moved out to follow it (the answer). Both are taken off where it starts
 * shrinking from, so what follows stays exactly where it was.
 */
export function Collapse({ open, lead = 0, drop = 0, over = 0, children }: { open: boolean; lead?: number; drop?: number; /** Fading in place, how far up its foot sits from where the fold stands. */ over?: number; children: ReactNode }) {
  const still = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const measured = useRef(0);
  const phase = useRef<Phase>("rest");
  // -1 while it takes its own height; a number while it moves.
  const height = useSharedValue(-1);
  const fade = useSharedValue(1);

  // The frame it starts closing in, a plain cap holds it at its starting height until the animation has it.
  const was = useRef(open);
  const cap = useRef<number | null>(null);
  if (was.current && !open && mounted && !still && measured.current > 0) {
    const from = Math.max(0, measured.current - drop - lead);
    // Nothing to shrink: decided in this frame, so it never blinks out before it fades.
    if (from <= 0.5) phase.current = "fading";
    else cap.current = from;
  }
  was.current = open;

  const settle = () => {
    phase.current = "rest";
    height.value = -1;
  };
  const gone = () => {
    phase.current = "rest";
    setMounted(false);
  };
  const grow = (to: number) => {
    phase.current = "opening";
    fade.value = withTiming(1, { duration: FOLD_MS, easing: OUT });
    height.value = withTiming(to, { duration: FOLD_MS, easing: OUT }, (done) => {
      if (done) scheduleOnRN(settle);
    });
  };

  useEffect(() => {
    if (open) {
      cap.current = null;
      if (still) {
        phase.current = "rest";
        height.value = -1;
        fade.value = 1;
        setMounted(true);
        return;
      }
      if (!mounted) {
        // Laid out unseen at no height first; it grows once it knows how tall it is (onLayout).
        phase.current = "opening";
        height.value = 0;
        fade.value = 0;
        measured.current = 0;
        setMounted(true);
      } else if (phase.current === "fading") {
        // Opened again mid-fade: it stands where it was.
        cancelAnimation(fade);
        phase.current = "rest";
        fade.value = 1;
        height.value = -1;
        rerender();
      } else if (phase.current === "closing") {
        // Opened again mid-close: back out to what it was.
        cancelAnimation(height);
        grow(measured.current);
      }
      return;
    }
    if (!mounted) return;
    if (still || measured.current <= 0) {
      setMounted(false);
      return;
    }
    if (phase.current === "fading") {
      // Nothing to shrink: it fades where it stands, over what took its place, and goes.
      cancelAnimation(fade);
      fade.value = 1;
      fade.value = withTiming(0, { duration: FOLD_MS * 0.6, easing: OUT }, (done) => {
        if (done) scheduleOnRN(gone);
      });
      return;
    }
    phase.current = "closing";
    cancelAnimation(height);
    height.value = cap.current ?? measured.current;
    fade.value = withTiming(0, { duration: FOLD_MS * 0.6, easing: OUT });
    height.value = withTiming(0, { duration: FOLD_MS, easing: OUT }, (done) => {
      if (done) scheduleOnRN(gone);
    });
    // The animation has it from the next frame: the cap lets go.
    const raf = requestAnimationFrame(() => {
      cap.current = null;
      rerender();
    });
    return () => cancelAnimationFrame(raf);
    // `mounted` only gates what this does; the fold follows `open`.
  }, [open]);

  const style = useAnimatedStyle(() => (height.value < 0 ? { opacity: 1 } : { height: height.value, opacity: fade.value, overflow: "hidden" }));
  const fading = useAnimatedStyle(() => ({ opacity: fade.value }));
  if (!mounted) return null;
  if (phase.current === "fading") {
    return (
      <View style={{ height: 0 }}>
        <Animated.View pointerEvents="none" aria-hidden style={[{ position: "absolute", left: 0, right: 0, bottom: over }, fading]}>
          {children}
        </Animated.View>
      </View>
    );
  }
  return (
    <View style={cap.current !== null ? { height: cap.current, overflow: "hidden" } : undefined}>
      <Animated.View style={style}>
        <View
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            const first = phase.current === "opening" && measured.current === 0;
            // While it closes, its body (its answer gone out from under it) is not what it measured open.
            if (phase.current !== "closing") measured.current = h;
            if (first && h > 0) grow(h);
          }}
        >
          {children}
        </View>
      </Animated.View>
    </View>
  );
}
