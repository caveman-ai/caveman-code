// The sidebar behind the main panel, and the panel that slides aside to show it ("a simple
// depthful sidebar like this that lives behind the main panel and the main panel has some shadow", after compact phone
// app). Nothing slides over the sidebar: it lies on the `shell` ground, full screen, and the panel (the stack, every
// screen in it) moves right until only a sliver of it stays in view at the right edge, its own top-left button still
// showing. It only slides: it never changes size or shape on the way.
// Once it moves it wears the phone's own rounded corners and casts a soft shadow onto the sidebar; in dark, where a
// shadow can't read on near-black, a hairline along its edge says where it ends. The sidebar doesn't move at all: it
// is simply there behind. At rest, nothing about the panel is any different from a plain screen.
//
// One number says where it is: `p`, 0 shut and 1 open, past 1 while a finger pulls it beyond the end. A drag, a tap on
// the button and a restore at launch all move that number, so the button and the finger are the same motion. It
// moves on a quick critically damped spring (SLIDE: about 300 ms, never past the end) that takes the finger's speed
// when let go and turns mid-flight when touched again; with Reduce Motion on, a short ease.
//
// The gestures:
// - On a root screen (the stack's first: a new chat, a chat or a Chief the sidebar opened), a rightward drag on the
//   panel brings the sidebar out under the finger, rubber-banding past the end. Content's own horizontal gestures win:
//   a row's swipe, a card's Allow and Deny and the thread's dock activate sooner (their 12 to 14 against this 18), and
//   a horizontal scroller (a code block, a chip row) takes the touch natively before it gets that far.
// - On a pushed screen the left edge is Back's (components/edge.ts) and this pan is off altogether.
// - While open the panel is inert: a cover over it closes on a tap, and a leftward drag on it (or on the sidebar)
//   carries it shut under the finger.
//
// Whether it is open, and how the sidebar sorts its chats, is shell/drawer.ts, read from disk before the first frame:
// left open, the app opens with the sidebar already out, without moving.
//
// Where two columns fit (the iPhone Duo unfolded, shell/layout.tsx) the same two layers stand side by side: the sidebar
// stays where it lies, and the panel stands beside it instead of over it, inset 8 from the screen's edges with the
// desktop frame's corner and hairline (apps/web/src/shell/AppShell.tsx). Tucking the sidebar away slides the panel
// left over it, the phone's own motion; bringing it back slides the panel off it again. On its side the rail stands at
// the trailing edge for the screen's own circles, where iOS 27 puts the Duo's bar buttons, and the inspector opens
// inside the panel at its right behind a hairline, as the desktop's side panel does. Where all three don't fit the
// inspector grows by exactly what the panel's left edge gives, so the screen between them keeps its width. Inside the
// panel the screen sees no safe-area insets (the panel already sits inside them) and its own column's size (usePane),
// so its bar, its pages and its box lay out as they do on a phone. The stack keeps its place in the tree in both
// shapes, so unfolding the phone keeps the chat where it was, a draft in its box and a Chief's call going.
import { type ReactNode, useContext, useEffect, useSyncExternalStore } from "react";
import { BackHandler, Keyboard, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { cancelAnimation, interpolate, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { panelLeft } from "../components/edge";
import { Icon } from "../components/Icon";
import { Squish } from "../components/Squish";
import { duration, ease, useReducedMotion } from "../motion";
import { Sidebar } from "../sidebar/Sidebar";
import { alpha, useTheme } from "../theme";
import { closeSidebar, drawer, openSidebar, SIDEBAR_SLIVER, useDrawer } from "./drawer";
import { GAP, PaneContext, RAIL_TOP, RailContext, SlotsContext, useShell, useSlot } from "./layout";

/**
 * The panel's corner once it moves: about the phone's own, so it reads as the screen itself sliding away. It is there
 * from the first point of travel, not grown on the way, so the panel's shape never changes while you watch it.
 */
const RADIUS = 44;
/** How far the shadow and the edge take to come in: the first few points of travel, so they never pop. */
const FADE_IN = 24;
/** The slide: critically damped, quick, clamped at the end, so it lands without a wobble. */
const SLIDE = { stiffness: 420, damping: 41, mass: 1, overshootClamping: true } as const;
/** How far a drag must go right before it moves the panel: past what a row's swipe (14) or a card's (12) needs. */
const OPEN_SLOP = 18;
/** How far past the end a finger can pull the panel at most, however far it goes. */
const STRETCH = 64;
/** A flick at this speed (points a second) decides the way, wherever it was let go. */
const FLICK = 500;
/** Reduce Motion: the panel eases there over this long, nothing overshooting. */
const STILL_MS = 220;
/** The panel's corner beside a sidebar that stays: the desktop frame's rounded-xl at a finger's scale. */
const CORNER = 20;
/** The inspector's head: what it shows, and its ✕. */
const HEAD = 52;
const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

// ---------------------------------------------------------------- whether the panel shows its root

let atRoot = true;
const hearers = new Set<() => void>();

/** The navigator says whether the panel shows the stack's first screen, where a drag right opens the sidebar. */
export function setPanelAtRoot(root: boolean) {
  if (root === atRoot) return;
  atRoot = root;
  for (const hear of [...hearers]) hear();
}

const usePanelAtRoot = () =>
  useSyncExternalStore(
    (hear) => {
      hearers.add(hear);
      return () => void hearers.delete(hear);
    },
    () => atRoot,
  );

// ---------------------------------------------------------------- motion

/** Past the end, the panel follows less and less (iOS's rubber band), never more than STRETCH beyond it. */
function stretch(over: number) {
  "worklet";
  return (1 - 1 / ((over * 0.55) / STRETCH + 1)) * STRETCH;
}

/** Where the panel stands, in points, for a finger `at` points from shut. */
function follow(at: number, span: number) {
  "worklet";
  if (at <= 0) return 0;
  return at > span ? span + stretch(at - span) : at;
}

/** Puts the keyboard away as the sidebar comes out: what you were typing waits as its draft. */
function putKeyboardAway() {
  Keyboard.dismiss();
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  const el = document.activeElement as (HTMLElement & { blur?: () => void }) | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) el.blur?.();
}

export function Drawer({ children }: { children: ReactNode }) {
  const { c, t, dark } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const shell = useShell();
  const { split } = shell;
  // The phone's slide; beside a sidebar that stays there is nothing to slide.
  const open = useDrawer((s) => s.open) && !split;
  const root = usePanelAtRoot();
  const still = useReducedMotion();
  // How far the panel travels: all of the screen but the sliver that stays in view.
  const span = Math.max(1, width - SIDEBAR_SLIVER);

  // Read from the store itself, not the hook, so a sidebar left open is open on the very first frame, unmoved.
  const p = useSharedValue(drawer.get().open ? 1 : 0);
  // Where the panel is headed, 0 or 1: a drag that let go already sent it, at its own speed, so the store catching up
  // must not start it again from rest.
  const aim = useSharedValue(drawer.get().open ? 1 : 0);
  const from = useSharedValue(0);

  useEffect(() => {
    const to = open ? 1 : 0;
    if (open) putKeyboardAway();
    if (aim.value === to) return;
    aim.value = to;
    p.value = still ? withTiming(to, { duration: STILL_MS, easing: ease.snap, reduceMotion: ReduceMotion.Never }) : withSpring(to, { ...SLIDE, reduceMotion: ReduceMotion.Never });
  }, [open, still, aim, p]);

  // Unfolded, the phone's slide puts itself away, so folding shut again shows the panel, not the sidebar over it.
  useEffect(() => {
    if (!split) return;
    closeSidebar();
    cancelAnimation(p);
    p.value = 0;
    aim.value = 0;
  }, [split, p, aim]);

  // Android's back button puts the sidebar away before it goes back anywhere.
  useEffect(() => {
    if (!open || Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeSidebar();
      return true;
    });
    return () => sub.remove();
  }, [open]);

  /** Let go: where it settles, by the flick if there was one, else by which half it is in, at the finger's speed. */
  const settle = (velocityX: number) => {
    "worklet";
    const to = velocityX > FLICK ? 1 : velocityX < -FLICK ? 0 : p.value > 0.5 ? 1 : 0;
    aim.value = to;
    p.value = still
      ? withTiming(to, { duration: STILL_MS, easing: ease.snap, reduceMotion: ReduceMotion.Never })
      : withSpring(to, { ...SLIDE, velocity: velocityX / span, reduceMotion: ReduceMotion.Never });
    scheduleOnRN(to ? openSidebar : closeSidebar);
  };

  // A root screen's drag right brings the sidebar out.
  const openPan = usePanGesture({
    enabled: root && !open && !split,
    activeOffsetX: OPEN_SLOP,
    failOffsetX: -12,
    failOffsetY: [-14, 14],
    onActivate: () => {
      "worklet";
      cancelAnimation(p);
      from.value = p.value * span;
      scheduleOnRN(putKeyboardAway);
    },
    onUpdate: (e) => {
      "worklet";
      p.value = follow(from.value + e.translationX, span) / span;
    },
    onDeactivate: (e) => {
      "worklet";
      settle(e.velocityX);
    },
  });

  // While open, a drag on the panel's sliver or the sidebar carries it, shut under a leftward finger.
  const closePan = usePanGesture({
    enabled: open && !split,
    activeOffsetX: [-16, 16],
    failOffsetY: [-14, 14],
    onActivate: () => {
      "worklet";
      cancelAnimation(p);
      from.value = p.value * span;
    },
    onUpdate: (e) => {
      "worklet";
      p.value = follow(from.value + e.translationX, span) / span;
    },
    onDeactivate: (e) => {
      "worklet";
      settle(e.velocityX);
    },
  });

  // ---------- side by side
  const slots = useContextSlots();
  const inspector = useSlot(slots.inspector);
  const railCircles = useSlot(slots.rail);
  const room = shell.side - GAP;
  const sidebarAt = useSharedValue(shell.sidebar ? 1 : 0);
  const inspectorAt = useSharedValue(shell.inspector ? 1 : 0);
  useEffect(() => {
    const curve = { duration: still ? 0 : duration.slow, easing: ease.swift, reduceMotion: ReduceMotion.Never };
    sidebarAt.value = withTiming(shell.sidebar ? 1 : 0, curve);
    inspectorAt.value = withTiming(shell.inspector ? 1 : 0, curve);
  }, [shell.sidebar, shell.inspector, still, sidebarAt, inspectorAt]);
  // Back's strip runs along the panel's own left edge (components/edge.ts).
  useEffect(() => {
    panelLeft.value = shell.panel.left;
  }, [shell.panel.left]);
  const { top, bottom, right } = shell.panel;
  const from0 = insets.left + GAP;

  // On a phone, only a slide: the same size and the same corners the whole way. Side by side, it stands inset beside
  // the sidebar, its left edge moving as the sidebar tucks away and comes back.
  const panel = useAnimatedStyle(() => {
    if (split) return { top, bottom, right, left: from0 + room * sidebarAt.value, borderRadius: CORNER, transform: [{ translateX: 0 }] };
    const at = p.value * span;
    return { top: 0, bottom: 0, right: 0, left: 0, borderRadius: at > 0.5 ? RADIUS : 0, transform: [{ translateX: at }] };
  }, [split, top, bottom, right, from0, room, span]);
  // The shadow is its own layer under the panel, so it can fade in without anything over the panel's glass fading.
  const shade = useAnimatedStyle(() => {
    const at = p.value * span;
    return { opacity: interpolate(at, [0, FADE_IN], [0, 1], "clamp"), borderRadius: RADIUS, transform: [{ translateX: at }] };
  });
  const edge = useAnimatedStyle(() => {
    if (split) return { opacity: 1, borderRadius: CORNER };
    const at = p.value * span;
    return { opacity: interpolate(at, [0, FADE_IN], [0, 1], "clamp"), borderRadius: at > 0.5 ? RADIUS : 0 };
  }, [split, span]);
  // The screen's column gives the inspector its room, as the panel's left edge gives it to the panel.
  const screenColumn = useAnimatedStyle(() => ({ marginRight: split ? room * inspectorAt.value : 0 }), [split, room]);
  const inspectorColumn = useAnimatedStyle(() => ({ width: room * inspectorAt.value }), [room]);
  const inspectorFace = useAnimatedStyle(() => ({ opacity: inspectorAt.value }));

  // iOS's own shadow; elsewhere a box shadow (an Android elevation would lift the layer over the panel it lies under).
  const shadow =
    Platform.OS === "ios"
      ? { shadowColor: "#000", shadowOpacity: dark ? 0.7 : 0.16, shadowRadius: dark ? 32 : 28, shadowOffset: { width: 0, height: 0 } }
      : ({ boxShadow: dark ? "0px 0px 40px rgba(0, 0, 0, 0.7)" : "0px 0px 36px rgba(0, 0, 0, 0.14)" } as object);

  return (
    <GestureDetector gesture={closePan}>
      <View style={{ flex: 1, overflow: "hidden", backgroundColor: c.shell }}>
        <Animated.View
          pointerEvents={open || shell.sidebar ? "auto" : "none"}
          accessibilityElementsHidden={!(open || shell.sidebar)}
          importantForAccessibility={open || shell.sidebar ? "auto" : "no-hide-descendants"}
          aria-hidden={!(open || shell.sidebar)}
          style={[{ position: "absolute", top: 0, bottom: 0, backgroundColor: c.shell }, split ? { left: insets.left, width: shell.side } : { left: 0, right: 0 }]}
        >
          <Sidebar />
        </Animated.View>

        {split ? null : <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.panel, borderCurve: "continuous" }, shadow, shade]} />}
        <GestureDetector gesture={openPan}>
          <Animated.View style={[{ position: "absolute", overflow: "hidden", backgroundColor: c.panel, borderCurve: "continuous" }, panel]}>
            <Animated.View style={[{ flex: 1 }, screenColumn]} accessibilityElementsHidden={open} importantForAccessibility={open ? "no-hide-descendants" : "auto"} aria-hidden={open}>
              <SafeAreaInsetsContext.Provider value={split ? NO_INSETS : insets}>
                <PaneContext.Provider value={split ? shell.pane : null}>{children}</PaneContext.Provider>
              </SafeAreaInsetsContext.Provider>
            </Animated.View>
            {/* Where the panel ends, on a ground a shadow can't darken: a hairline along its rounded edge. */}
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderWidth: split ? 0.5 : 1, borderColor: split ? c.hairline : dark ? alpha("#ffffff", 0.09) : alpha("#000000", 0.05), borderCurve: "continuous" }, edge]} />
            {open ? <Pressable accessibilityRole="button" accessibilityLabel="Close the sidebar" onPress={closeSidebar} style={StyleSheet.absoluteFill} /> : null}
            {split ? (
              <Animated.View aria-hidden={!shell.inspector} pointerEvents={shell.inspector ? "auto" : "none"} style={[{ position: "absolute", top: 0, right: 0, bottom: 0, overflow: "hidden" }, inspectorColumn]}>
                <Animated.View style={[{ width: room, flex: 1, borderLeftWidth: 1, borderLeftColor: c.hairline }, inspectorFace]}>
                  {inspector ? (
                    <>
                      {/* The side panel's head: what it shows, and its ✕ (the desktop's tab strip, one tab). */}
                      <View style={{ flexDirection: "row", alignItems: "center", height: HEAD, paddingLeft: 16, paddingRight: 4, borderBottomWidth: 1, borderBottomColor: c.hairline }}>
                        <Text accessibilityRole="header" numberOfLines={1} style={[t.label, { flex: 1, fontWeight: "600" }]}>
                          {inspector.title}
                        </Text>
                        <Squish label={`Close ${inspector.title}`} onPress={() => shell.setInspector(false)} depth={0.85} style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" }}>
                          <Icon name="close" size={18} color={c.muted} />
                        </Squish>
                      </View>
                      <SafeAreaInsetsContext.Provider value={NO_INSETS}>
                        <PaneContext.Provider value={{ width: room, height: shell.pane.height - HEAD }}>
                          <View style={{ flex: 1, paddingTop: 20 }}>{inspector.body}</View>
                        </PaneContext.Provider>
                      </SafeAreaInsetsContext.Provider>
                    </>
                  ) : null}
                </Animated.View>
              </Animated.View>
            ) : null}
          </Animated.View>
        </GestureDetector>

        {split && shell.rail ? (
          // The rail: the screen's own circles, standing in a column under the system's corner.
          <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: shell.rail, paddingTop: insets.top + RAIL_TOP, paddingBottom: bottom, alignItems: "center" }}>
            <RailContext.Provider value>{railCircles}</RailContext.Provider>
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

function useContextSlots() {
  const slots = useContext(SlotsContext);
  if (!slots) throw new Error("The drawer stands inside the shell's slots (App.tsx)");
  return slots;
}
