// Pages pushed inside a sheet, iOS's way (stacked iOS sheets): a deeper page slides in from the right over the
// one it came from, which moves a third of the way left beneath it; Back reverses it. A swipe from the left carries the
// top page under your finger with the one beneath coming back, and past a third (or a flick) finishes the pop at the
// finger's speed. The sheet's head is not in here: it stays where it is and changes in place (Sheet.tsx SheetHeader),
// and during a swipe it follows the finger too (HeadSwipe below). Settings' sections, Connect's pages and the sheets
// the shell pushes over each other (Sheet.tsx SheetFrame) all move on this one stack. With Reduce Motion on, pages
// cross-fade and nothing slides.
//
// One number says where the stack is: `pos`, the top page's index, fractional while a page moves. Every page draws
// itself from how far it is from it, so a push, a pop and a swipe are the same motion run by different hands.
import { LinearGradient } from "expo-linear-gradient";
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Keyboard, type LayoutChangeEvent, Platform, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { type DerivedValue, Easing, ReduceMotion, type SharedValue, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ease, useReducedMotion } from "../motion";
import { useTheme } from "../theme";
import { FADE_MS, nextFrame, PUSH_MS, slow, slowness } from "./sheetMotion";

/** How far the page beneath sits to the left while one is pushed over it, as a part of the width. */
const UNDER = 0.3;
/** The shade along a moving page's left edge, so it reads as lying over the one beneath: deeper in dark, a breath in light. */
const SHADE = 18;
/** How far below a fitted page its ground and shade reach while it moves: past the foot of any sheet. */
const REACH = 4000;
/** A flicked page goes the rest of the way easing out from the finger's speed. */
const FLUNG = Easing.out(Easing.quad);

/**
 * What a sheet's frame (Sheet.tsx) hands the stacks inside it, so its head follows a swipe back under the finger rather
 * than changing only once it is let go: how far the top page has been carried (0 where it was, 1 gone), and word as a
 * swipe starts and as it settles, gone back or not. `end(true)` comes just before the stack's own `onBack`.
 */
export interface HeadSwipe {
  progress: SharedValue<number>;
  start: () => void;
  end: (back: boolean) => void;
}
export const HeadSwipeContext = createContext<HeadSwipe | null>(null);

/**
 * Whether a swipe is carrying a page of the stack (`now`), or let one go a moment ago (`recently`): the row a swipe
 * began on doesn't stay lit under the finger, and doesn't open as the finger lifts. A native gesture cancels the row's
 * touch itself; this covers the web build too.
 */
export interface Carried {
  now: boolean;
  recently: () => boolean;
}
const CarriedContext = createContext<Carried>({ now: false, recently: () => false });
export const useCarried = () => useContext(CarriedContext);

interface Props {
  /** The pages, root first, each by a key that stays the same while it is up. */
  pages: readonly string[];
  /** Draws a page. `index` is its place in the stack, or -1 for a kept page that isn't up. */
  render: (key: string, index: number) => ReactNode;
  /** Takes the top page away: what a swipe from the left does once it is let go past a third, or flicked. */
  onBack: () => void;
  /** What a page moves on, so the page under it never shows through while it slides. */
  ground: string;
  /** Pages drawn but hidden while they aren't up, so they keep their state between visits. */
  keep?: readonly string[];
  /** The swipe back is off: a stack inside the top page takes it, or there is nothing to go back to. */
  swipe?: boolean;
  /** A page that stands at its own height at the stack's top (a medium sheet's), rather than filling it. */
  fit?: (key: string) => boolean;
  /** A fitted page's height, told as it lays out. */
  onHeight?: (key: string, height: number) => void;
  /** The tallest a fitted page may stand; it scrolls inside that. */
  maxHeight?: SharedValue<number> | DerivedValue<number>;
  /** A swipe started carrying the page (true) or let it go (false): a row it began on must not open. */
  onCarry?: (on: boolean) => void;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => b[i] === k);
const extends_ = (longer: readonly string[], shorter: readonly string[]) => longer.length > shorter.length && shorter.every((k, i) => longer[i] === k);

export function PageStack({ pages, render, onBack, ground, keep, swipe = true, fit, onHeight, maxHeight, onCarry }: Props) {
  const still = useReducedMotion();
  const head = useContext(HeadSwipeContext);
  const outer = useCarried();
  const [width, setWidth] = useState(0);
  const top = pages.length - 1;
  const pos = useSharedValue(top);
  // Each page's outermost view, by key: on the web, where focus is can be asked of it.
  const nodes = useRef(new Map<string, unknown>()).current;

  // A popped page stays drawn while it slides away; it is let go once it has.
  const [seen, setSeen] = useState(pages);
  const [leaving, setLeaving] = useState<readonly string[]>([]);
  if (!same(seen, pages)) {
    setSeen(pages);
    // Put away altogether, nothing slides: the sheet itself is going (or has gone).
    setLeaving(pages.length && extends_(seen, pages) ? seen.slice(pages.length) : []);
  }

  // A field in a page going under (a search, the keyboard up) lets go as the next page comes: typing must never reach a
  // page you can no longer see. A field the new page focuses itself keeps its focus.
  const letGo = (now: readonly string[]) => {
    if (Platform.OS !== "web") return Keyboard.dismiss();
    if (typeof document === "undefined") return;
    const el = document.activeElement as (HTMLElement & { blur?: () => void }) | null;
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
    const up = nodes.get(now[now.length - 1] ?? "") as { contains?: (n: unknown) => boolean } | undefined;
    if (up?.contains?.(el)) return;
    el.blur?.();
  };

  const was = useRef(pages);
  useLayoutEffect(() => {
    const before = was.current;
    was.current = pages;
    if (same(before, pages)) return;
    // A sheet opening on its pages, or going with them, moves as a sheet; only a page coming or going inside it pushes.
    if (!before.length || !pages.length) {
      pos.value = top;
      setLeaving([]);
      return;
    }
    const timing = { duration: slow(still ? FADE_MS : PUSH_MS), easing: ease.drawer, reduceMotion: ReduceMotion.Never };
    if (extends_(pages, before)) {
      letGo(pages);
      // From just under the new page, or from wherever a pop it interrupts had got to.
      pos.value = Math.max(top - 1, Math.min(pos.value, top));
      pos.value = nextFrame(withTiming(top, timing));
    } else if (extends_(before, pages)) {
      letGo(pages);
      pos.value = nextFrame(
        withTiming(top, timing, (done) => {
          if (done) scheduleOnRN(setLeaving, []);
        }),
      );
    } else {
      pos.value = top;
      setLeaving([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- letGo is rebuilt each render; the pages it lets go are a dependency.
  }, [pages, pos, top, still]);

  // The swipe's hands: rows told it is carrying, the head told it started and how it settled.
  const [carried, setCarried] = useState(false);
  const carriedAt = useRef(0);
  const carry = (on: boolean) => {
    // A touch that never became a swipe ends too; only a page that was carried holds its rows a moment longer.
    if (on) carriedAt.current = Number.POSITIVE_INFINITY;
    else if (carriedAt.current === Number.POSITIVE_INFINITY) carriedAt.current = Date.now();
    setCarried(on);
    onCarry?.(on);
  };
  const carriedNow = useMemo<Carried>(() => ({ now: carried || outer.now, recently: () => Date.now() - carriedAt.current < 250 || outer.recently() }), [carried, outer]);
  const begin = () => {
    head?.start();
    carry(true);
  };
  const settle = (back: boolean) => {
    head?.end(back);
    if (back) onBack();
  };

  const hidden = (keep ?? []).filter((k) => !pages.includes(k) && !leaving.includes(k));
  const going = leaving.filter((k) => !pages.includes(k));
  const drawn = [...hidden, ...pages, ...going];
  const measure = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <CarriedContext.Provider value={carriedNow}>
      <View style={{ flex: 1, overflow: "hidden" }} onLayout={measure}>
        {drawn.map((key) => {
          const at = pages.indexOf(key);
          const index = at >= 0 ? at : going.includes(key) ? pages.length + going.indexOf(key) : -1;
          return (
            <Layer
              key={key}
              index={index}
              top={top}
              pos={pos}
              width={width}
              still={still}
              ground={ground}
              fitted={!!fit?.(key)}
              maxHeight={maxHeight}
              onHeight={onHeight ? (h) => onHeight(key, h) : undefined}
              swipe={swipe && index === top && top > 0}
              progress={head?.progress}
              onBegin={begin}
              onSettle={settle}
              onLift={() => carry(false)}
              nodeRef={(n) => {
                if (n) nodes.set(key, n);
                else nodes.delete(key);
              }}
            >
              {render(key, index)}
            </Layer>
          );
        })}
      </View>
    </CarriedContext.Provider>
  );
}

interface LayerProps {
  index: number;
  top: number;
  pos: SharedValue<number>;
  width: number;
  still: boolean;
  ground: string;
  fitted: boolean;
  maxHeight?: SharedValue<number> | DerivedValue<number>;
  onHeight?: (height: number) => void;
  swipe: boolean;
  /** The frame's head's share of the swipe: how far the page is carried, 0 to 1. */
  progress?: SharedValue<number>;
  onBegin: () => void;
  onSettle: (back: boolean) => void;
  onLift: () => void;
  nodeRef: (node: unknown) => void;
  children: ReactNode;
}

function Layer({ index, top, pos, width, still, ground, fitted, maxHeight, onHeight, swipe, progress, onBegin, onSettle, onLift, nodeRef, children }: LayerProps) {
  const { dark } = useTheme();
  const up = index === top;
  const kept = index < 0;
  const w = width || 400;

  const move = useAnimatedStyle(() => {
    const d = index - pos.value;
    if (still) return { opacity: d >= 1 || d <= -1 ? 0 : 1 - Math.abs(d), transform: [{ translateX: 0 }] };
    // Coming in from the right, or lying a third of the way left under the page above.
    const x = d > 0 ? Math.min(1, d) * w : Math.max(-1, d) * UNDER * w;
    return { opacity: d >= 1 || d <= -1 ? 0 : 1, transform: [{ translateX: x }] };
  });
  // Moving, a page needs its own ground to hide the one under it; at rest it lies on the sheet's own (glass shows
  // through a medium sheet's). A page shorter than the one under it carries its ground to the foot of the stack.
  const grounded = useAnimatedStyle(() => {
    const d = index - pos.value;
    return { opacity: !still && d > 0.001 && d < 1 ? 1 : 0 };
  });
  const shade = useAnimatedStyle(() => {
    const d = index - pos.value;
    return { opacity: !still && d > 0.001 && d < 1 ? 1 : 0 };
  });
  const cap = useAnimatedStyle(() => (maxHeight ? { maxHeight: Math.max(0, maxHeight.value) } : {}));

  const pan = usePanGesture({
    enabled: swipe,
    activeOffsetX: [-10_000, 14],
    failOffsetY: [-12, 12],
    onActivate: () => {
      "worklet";
      if (progress) progress.value = 0;
      scheduleOnRN(onBegin);
    },
    onFinalize: () => {
      "worklet";
      scheduleOnRN(onLift);
    },
    onUpdate: (e) => {
      "worklet";
      const q = Math.min(1, Math.max(0, e.translationX / w));
      pos.value = top - q;
      if (progress) progress.value = q;
    },
    onDeactivate: (e) => {
      "worklet";
      const q = Math.min(1, Math.max(0, e.translationX / w));
      // Past a third, or flicked toward the right; a flick back to the left keeps the page wherever it was let go.
      const back = (e.translationX > w / 3 || e.velocityX > 600) && e.velocityX > -300;
      // The rest of the way at the finger's own speed (an ease-out starts at twice its average), or, let go still, at
      // an unhurried pace.
      const rest = (back ? 1 - q : q) * w;
      const speed = back ? e.velocityX : -e.velocityX;
      const flung = speed > 200;
      const ms = (flung ? Math.max(120, Math.min(320, (2 * rest * 1000) / speed)) : back ? 260 : 240) * slowness.value;
      const timing = { duration: ms, easing: flung ? FLUNG : ease.drawer, reduceMotion: ReduceMotion.Never };
      if (progress) progress.value = withTiming(back ? 1 : 0, timing);
      pos.value = withTiming(back ? top - 1 : top, timing, (done) => {
        // Taken over (another swipe, a push), it settles nowhere: whatever took it over says where the stack is.
        if (done) scheduleOnRN(onSettle, back);
      });
    },
  });

  // One shape whatever the page is doing, kept or up, so moving between them never remounts what it holds.
  const frame = fitted ? { position: "absolute" as const, top: 0, left: 0, right: 0 } : { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 };
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        ref={nodeRef}
        pointerEvents={up ? "auto" : "none"}
        aria-hidden={!up}
        // Always handed one, since the web only watches a view's size if it had a handler as it mounted; a kept page,
        // hidden, has no height worth telling.
        onLayout={(e) => {
          if (!kept) onHeight?.(e.nativeEvent.layout.height);
        }}
        style={[frame, fitted ? { flexShrink: 1 } : null, move, fitted ? cap : null, kept ? { display: "none" } : null]}
      >
        <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, bottom: fitted ? -REACH : 0, left: 0, right: 0, backgroundColor: ground }, grounded]} />
        <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, bottom: fitted ? -REACH : 0, left: -SHADE, width: SHADE }, shade]}>
          <LinearGradient colors={["rgba(0,0,0,0)", dark ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.06)"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
        </Animated.View>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
