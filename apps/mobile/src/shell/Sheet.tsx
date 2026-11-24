// Every sheet in the app, on one anatomy (DECISIONS.md; Cursor and Grok on iOS
// 26). Three sizes:
// - `large` (Search, Connect, Profile, Settings): opaque, the sheet grey (#1b1c1d, white in light) with a 1pt hairline
//   edge, full width, from the safe area's top to the foot of the screen, its top corners rounded 38, for what fills
//   the screen and holds a keyboard.
// - `medium` (Details, the pickers, the Chief's peek): glass that floats 8pt in from the left, right and bottom,
//   rounded 36 all round, as tall as what it holds.
// - `half` (the composer's Context, native IMG_5355): a medium sheet that opens at 55% of the screen whatever it
//   holds, and pulls up by its head to the full height, and back down again (two detents, as iOS's sheets have). Its grey is laid over the glass at 96% under a 40px blur, so it
//   still reads as glass at its edge while nothing behind it (a bright button, a bubble) shows through as a shape.
// Both have the same head: a grabber, then a 44pt glass X at (16,16), the title centred on that row at 17/600, and an
// optional glass action at the right. Under the head, rows are grouped lists: a grey section head, 50pt rows with a
// 20pt glyph slot, 17pt labels, and hairlines inset to the label's edge. The screen behind dims to half.
//
// It rises along a critically damped spring's path, landing in 380ms without the crawl a spring's tail adds, and
// follows your thumb down by its grabber and head, going when you let go past a third of it or flick; the dim, Escape
// (on the web) and Back (on Android) close it too. It goes in 240ms, easing in and out, or sooner on a flick, leaving
// at the flick's speed, and is gone from the screen as it lands. When it goes, focus
// goes back to what opened it (the Search circle, a chip), for VoiceOver and the keyboard alike, unless the screen
// under it changed while it was up (a result opened a chat). Only the head drags it,
// so a list inside scrolls. It makes room for the keyboard itself: a medium sheet rides up on it, a large one keeps
// its content above it. Reduce Transparency turns the medium glass solid (Floating.tsx).
//
// When a sheet leads somewhere, the sheet stays (stacked iOS sheets, ): a page pushed
// inside it (Settings' sections) and a sheet opened from it (Profile's Settings) are both pages on one frame. The frame
// never drops and rises again; it changes size in place when the next sheet stands at another height, along the same
// path it arrived on. Its head stays too, and changes in place: one glass circle at the left whose glyph turns from X to
// a back chevron as you go deeper and back at the root, the title cross-fading with a 12pt drift the way the page
// moves, and a glass action at the right that stays if both sides have one or scales in and out if only one does. The
// body underneath moves as a page push (PageStack.tsx). A swipe from the left carries the page under the finger and the
// head with it: the title coming back fades in as this one fades out, and the X comes back into the circle as the root
// does. Back pops one; the dim, a swipe down or the X at the root put the whole stack away; Escape and Android's Back
// pop one. For a moment after the head changes its circles take no taps, as iOS's bar buttons don't while a page
// moves, so a second tap on Back never closes what it meant to go back in. With Reduce Motion on, all of it
// cross-fades in place, the sheet arriving and going included.
//
// On a screen wider than a phone (the iPhone Duo unfolded) a sheet stands centred at most SHEET_MAX wide, as iPadOS's
// form sheets do, rather than stretching edge to edge.
import { Children, cloneElement, createContext, isValidElement, type ReactElement, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, BackHandler, findNodeHandle, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, ReduceMotion, type SharedValue, useAnimatedKeyboard, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SHEET_MAX } from "./layout";
import { scheduleOnRN } from "react-native-worklets";
import { liquidGlass } from "../components/Glass";
import { Frost, GlassCircle } from "../components/ui/Floating";
import { Icon, type IconName } from "../components/Icon";
import { lastPress, Squish } from "../components/Squish";
import { ease, haptic, release, useReducedMotion } from "../motion";
import { alpha, FLOAT_TYPE, layout, mono, useTheme } from "../theme";
import { type HeadSwipe, HeadSwipeContext, PageStack, useCarried } from "./PageStack";
import { ARRIVE_MS, DRIFT, FADE_MS, GLYPH_MS, LEAVE_MS, nextFrame, PUSH_MS, slow, TITLE_IN_DELAY, TITLE_MS, TITLE_OUT_MS } from "./sheetMotion";
import { coverBar, ui } from "./ui";

export type Detent = "large" | "medium" | "half";

/** A glass action at the head's right: a circle with a glyph, or a pill with a word ("Edit"). */
export interface HeadAction {
  icon?: IconName;
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
}

/** The way back from a page pushed inside a sheet: what a screen reader calls it, and what it does. */
export interface SheetBackTo {
  label: string;
  onPress: () => void;
  /** The title of the page it goes back to, and the line under it: they come in as a swipe back carries this page off. */
  title?: string;
  subtitle?: string;
}

/** A sheet opened from this one, drawn as a page on the same frame (the composer's Context leading into Connect). */
export interface PushedSheet {
  key: string;
  detent: Detent;
  element: ReactNode;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * `medium` floats on glass at its content's height; `half` floats at 55% and pulls up to full; `large` stands opaque
   * from the top.
   */
  detent?: Detent;
  title?: string;
  /** What the sheet is called where its head shows no title: a sheet opened over it says "Back to" this. */
  name?: string;
  /** A count or a state under the title, in plain grey ("7 connected"): words, never a button. */
  subtitle?: string;
  /** What sits at the right of the title row, drawn as it is (a count, a glass circle of its own). */
  accessory?: ReactNode;
  /** A glass action at the right that the head draws itself, so its glass stays put while the page under it changes. */
  action?: HeadAction;
  /** A page pushed inside the sheet: the X turns into a back chevron that does this. */
  back?: SheetBackTo;
  /** How deep the page shown is inside the sheet (0 its first): a deeper page's title arrives from the right. */
  depth?: number;
  /** What sits at the left in place of the X, drawn as it is. A SheetBack here is read as `back`. */
  leading?: ReactNode;
  /** A head of the sheet's own under the grabber, in place of the title row; dragging it moves the sheet too. */
  header?: ReactNode;
  /** A hairline under the head, once what's under it has scrolled. */
  divided?: boolean;
  /** The sheet's fill, where a sheet needs another than the sheet grey. */
  surface?: string;
  /** What a screen reader calls the X. */
  closeLabel?: string;
  /** Sheets opened from this one, on its frame, oldest first; `onPop` takes the last away. */
  pushed?: readonly PushedSheet[];
  onPop?: () => void;
  children: ReactNode;
}

// ---------------------------------------------------------------- the sheet on top

// The open sheets, oldest first: Escape and Android's Back go back one in the newest one, or close it at its root.
const stack: { current: () => void }[] = [];
const closeTop = () => {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.current();
  return true;
};
if (Platform.OS === "web" && typeof window !== "undefined") {
  // A text field keeps its keys to itself on the web (react-native-web stops them bubbling), so Escape typed in a
  // sheet's search is heard on the way down; anywhere else, on the way up. Once per press either way.
  const heard = new WeakSet<Event>();
  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || heard.has(e)) return;
    heard.add(e);
    if (closeTop()) e.preventDefault();
  };
  window.addEventListener("keydown", (e) => {
    const field = e.target as { tagName?: string } | null;
    if (field?.tagName === "INPUT" || field?.tagName === "TEXTAREA") onEscape(e);
  }, true);
  window.addEventListener("keydown", onEscape);
}
if (Platform.OS === "android") BackHandler.addEventListener("hardwareBackPress", closeTop);

/** What the sheet around a body is: its size and its fill, so a fade inside it can match. */
const SheetContext = createContext<{ detent: Detent; fill: string } | null>(null);
/** The sheet a body sits in, or null outside one. */
export const useSheet = () => useContext(SheetContext);

/** A sheet's fill at a size: the large sheet's opaque grey, or the grey a medium sheet's glass and wash read as. */
export function useSheetFill(detent: Detent) {
  const { c, dark } = useTheme();
  return detent === "large" ? c.popover : dark ? "#1c1c1e" : c.popover;
}

/** What opened a sheet, and on which screen: on the web the element that had focus, else the last thing pressed. */
interface Trigger {
  node: unknown;
  screen: string;
}
const screenKey = () => {
  const f = ui.get().focused;
  return f ? `${f.name}:${f.id ?? ""}` : "";
};
function triggerNow(): Trigger {
  const web = Platform.OS === "web" && typeof document !== "undefined" ? document.activeElement : null;
  return { node: web && web !== document.body ? web : lastPress.node, screen: screenKey() };
}
/** Focus back on what opened the sheet, if it is still on the screen it was on. */
function giveBack(trigger: Trigger | null) {
  if (!trigger?.node || trigger.screen !== screenKey()) return;
  if (Platform.OS === "web") {
    const el = trigger.node as { isConnected?: boolean; focus?: (o?: object) => void };
    if (el.isConnected) setTimeout(() => el.focus?.({ preventScroll: true }), 0);
    return;
  }
  const handle = findNodeHandle(trigger.node as Parameters<typeof findNodeHandle>[0]);
  if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
}

/** Focus on a title that just arrived, for VoiceOver and the keyboard: where you are after a push or a pop. */
function focusTitle(node: unknown) {
  if (!node) return;
  if (Platform.OS === "web") {
    const el = node as { setAttribute?: (k: string, v: string) => void; hasAttribute?: (k: string) => boolean; focus?: (o?: object) => void };
    if (!el.hasAttribute?.("tabindex")) el.setAttribute?.("tabindex", "-1");
    el.focus?.({ preventScroll: true });
    return;
  }
  const handle = findNodeHandle(node as Parameters<typeof findNodeHandle>[0]);
  if (handle) setTimeout(() => AccessibilityInfo.setAccessibilityFocus(handle), 60);
}

/** The large sheet's top on a screen with no safe area (the web build): enough to show it is a sheet. */
const MIN_TOP = 16;
const MEDIUM_RADIUS = 36;
/** The head's height before it has been measured: its 16pt top, the 44pt circle and 12pt under it, and the hairline. */
const HEAD = 73;
/**
 * How a sheet arrives: the path of a critically damped spring (x = 1 - (1 + at)e^-at), scaled to land exactly at its
 * end. A spring left to run creeps its last few points for a quarter second; this one is still moving at about 3pt a
 * frame when it lands, so it settles rather than crawls. A frame changing size between two sheets moves on it too.
 */
const ARRIVE_A = 6;
const ARRIVE_END = 1 - (1 + ARRIVE_A) * Math.exp(-ARRIVE_A);
const arrive = (x: number) => {
  "worklet";
  return (1 - (1 + ARRIVE_A * x) * Math.exp(-ARRIVE_A * x)) / ARRIVE_END;
};
/** How it goes: 240ms easing in and out, so it is gone within 300ms of Escape; a flick leaves sooner, at its speed. */
const leave = Easing.bezier(0.4, 0, 0.6, 1);
/**
 * The frame changing size between two sheets, or as its page grows: a critically damped spring on about the arrival's
 * path. A page telling a new height while the frame moves turns it there with the speed it has, where a timing would
 * start again from rest (or a direct write would jump).
 */
const sizing = () => {
  const w = 18 / slow(1);
  return { mass: 1, stiffness: w * w, damping: 2 * w, overshootClamping: true, reduceMotion: ReduceMotion.Never };
};
const WEB = Platform.OS === "web";
/** The medium sheet's wash blurs what it lets through, on the web (iOS blurs in its glass). */
const WASH_BLUR = (Platform.OS === "web" ? { backdropFilter: "blur(40px)", WebkitBackdropFilter: "blur(40px)" } : {}) as object;

// ---------------------------------------------------------------- a sheet, alone or as a page

/** What a page tells the frame it sits on about its head. */
interface HeadSpec {
  title?: string;
  name?: string;
  subtitle?: string;
  accessory?: ReactNode;
  action?: HeadAction;
  back?: SheetBackTo;
  leading?: ReactNode;
  header?: ReactNode;
  depth?: number;
  divided?: boolean;
  surface?: string;
  closeLabel: string;
  onClose: () => void;
}

/** The page a sheet is drawn as: its key and place on the frame, whether it is up, and where it tells its head. */
interface Slot {
  key: string;
  index: number;
  live: boolean;
  detent: Detent;
  publish: (key: string, spec: HeadSpec) => void;
}
const SlotContext = createContext<Slot | null>(null);

/** The page this sheet is on its frame (0 the first; -1 not up), or null for a sheet that isn't on one. */
export function useSheetPage(): { index: number } | null {
  const slot = useContext(SlotContext);
  return slot ? { index: slot.index } : null;
}

/**
 * A sheet. On its own (a screen's sheet) it stands on a frame of its own, with any sheets it opens as pages over it;
 * on a frame that holds several (the shell's, Overlays.tsx) it is one page of the stack, its head drawn by the frame.
 */
export function Sheet(props: Props) {
  const slot = useContext(SlotContext);
  return slot ? <PageSheet slot={slot} {...props} /> : <LoneSheet {...props} />;
}

function LoneSheet(props: Props) {
  const { open, onClose, detent = "medium", pushed, onPop } = props;
  const keys = open ? ["self", ...(pushed ?? []).map((p) => p.key)] : [];
  // A sheet popped off this one keeps drawing what it last drew while it slides away.
  const last = useRef(new Map<string, PushedSheet>()).current;
  for (const p of pushed ?? []) last.set(p.key, p);
  const page = (key: string) => (key === "self" ? { detent, element: <Sheet {...props} /> } : (pushed?.find((p) => p.key === key) ?? last.get(key) ?? { detent, element: null }));
  return <SheetFrame stack={keys} page={page} onDismiss={onClose} onPop={onPop ?? noop} />;
}
const noop = () => {};

function PageSheet({ slot, onClose, title, name, subtitle, accessory, action, back, depth, leading, header, divided, surface, closeLabel = "Close", children }: Props & { slot: Slot }) {
  const { c, dark } = useTheme();
  // Told every render, before the screen paints: the head shows what this page says now.
  useLayoutEffect(() => slot.publish(slot.key, { title, name, subtitle, accessory, action, back, depth, leading, header, divided, surface, closeLabel, onClose }));
  if (!slot.live) return null;
  // A medium sheet is glass; what fades inside it fades to the grey its frost and its solid fallback read as.
  const fill = surface ?? (slot.detent === "large" ? c.popover : dark ? "#1c1c1e" : c.popover);
  return (
    <SheetContext.Provider value={{ detent: slot.detent, fill }}>
      {/* A sheet inside this one's body is a sheet of its own, not another page. */}
      <SlotContext.Provider value={null}>{children}</SlotContext.Provider>
    </SheetContext.Provider>
  );
}

/** A page's slot, kept the same object while its place doesn't change, so the frame re-rendering never re-renders it. */
function Slotted({ slotKey, index, detent, publish, children }: { slotKey: string; index: number; detent: Detent; publish: Slot["publish"]; children: ReactNode }) {
  const value = useMemo(() => ({ key: slotKey, index, live: index >= 0, detent, publish }), [slotKey, index, detent, publish]);
  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>;
}

/** A tiny signal: the head re-renders whenever a page tells it something, and nothing else does. */
function useSignal() {
  return useMemo(() => {
    let version = 0;
    const listeners = new Set<() => void>();
    return {
      emit: () => {
        version += 1;
        for (const l of listeners) l();
      },
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      version: () => version,
    };
  }, []);
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => b[i] === k);

interface FrameProps {
  /** The pages up, root first, by key; empty when the sheet is put away. */
  stack: readonly string[];
  /** A page by its key: the size its sheet stands at, and what it draws. */
  page: (key: string) => { detent: Detent; element: ReactNode };
  /** Pages kept drawn, hidden, while they aren't up, so they keep their state; the frame stays mounted for them. */
  keep?: readonly string[];
  /** The dim, a swipe down: every page goes. */
  onDismiss: () => void;
  /** Back from a page opened over another. */
  onPop: () => void;
}

/**
 * The one frame a stack of sheets stands on: the dim, the sheet's surface at the top page's size, its head, and the
 * pages moving under it. The shell's sheets share one (Overlays.tsx), so Profile leading to Settings is a push, never a
 * sheet dropping and another rising; a sheet on its own is a frame of one.
 */
export function SheetFrame({ stack: keys, page, keep, onDismiss, onPop }: FrameProps) {
  const { c, dark } = useTheme();
  const still = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { height: screen, width: across } = useWindowDimensions();
  // Wider than a phone, the sheet stands centred at a form sheet's width.
  const wide = Math.max(0, Math.round((across - SHEET_MAX) / 2));
  const keyboard = useAnimatedKeyboard();
  const open = keys.length > 0;
  // While it goes it keeps drawing the pages it had.
  const [last, setLast] = useState(keys);
  if (open && !same(last, keys)) setLast(keys);
  const shown = open ? keys : last;
  const topKey = shown[shown.length - 1] ?? "";
  const detent: Detent = topKey ? page(topKey).detent : "medium";
  const large = detent === "large";
  const half = detent === "half";
  const glassy = shown.some((k) => page(k).detent !== "large");

  const [mounted, setMounted] = useState(open);
  const present = useSharedValue(0);
  const drag = useSharedValue(0);
  const top = Math.max(insets.top, MIN_TOP);
  const gap = layout.sheet.float;
  const foot = Math.max(14, insets.bottom - gap);
  // A half sheet's two heights, and how far it has grown from the lower to the higher (0 to 1).
  const lowH = Math.round((screen - top - gap) * 0.55);
  const highH = screen - top - gap * 2;
  const span = Math.max(1, highH - lowH);
  const grow = useSharedValue(0);
  const grewFrom = useSharedValue(0);
  const isHalf = useSharedValue(half);
  // How large the frame is (0 floating medium glass, 1 standing large and opaque), and how tall it wants to be.
  const big = useSharedValue(large ? 1 : 0);
  const tall = useSharedValue(screen);
  const headH = useSharedValue(HEAD);
  const headNow = useRef(HEAD);
  // The speed of the flick that closed it, in pt/s, so it leaves at that speed; 0 when something else closed it.
  const flung = useSharedValue(0);
  // A medium page's own height, as it last laid out; the frame stands at it.
  const heights = useRef(new Map<string, number>()).current;
  // Where the frame's height is headed. A page telling it a height it is already on its way to changes nothing (a kept
  // page shown again, a page re-laid out as the frame narrows); one telling it another turns it there in flight.
  const target = useRef<number | null>(null);
  // Opening, a medium sheet is still below the screen until its page has said how tall it is: it takes that at once.
  const opening = useRef(false);
  // What opened it, noted as it opens (before a field inside takes focus), given focus again as it goes.
  const trigger = useRef<Trigger | null>(null);
  const wasOpen = useRef(false);
  // Each time it opens is a fresh session: the head starts from what the first page says, with nothing to change from.
  const session = useRef(0);
  const specs = useRef(new Map<string, HeadSpec>()).current;
  if (open && !wasOpen.current) {
    trigger.current = triggerNow();
    session.current += 1;
    specs.clear();
    opening.current = true;
  }
  wasOpen.current = open;

  const targetOf = (key: string): number | null => {
    const d = page(key).detent;
    if (d === "large") return screen - top;
    if (d === "half") return lowH;
    const body = heights.get(key);
    return body === undefined ? null : headNow.current + body + foot;
  };
  const resize = (to: number, atOnce = false) => {
    if (!atOnce && target.current !== null && Math.abs(target.current - to) < 1) return;
    target.current = to;
    if (atOnce) tall.value = to;
    else tall.value = still ? withTiming(to, { duration: slow(FADE_MS), easing: ease.snap, reduceMotion: ReduceMotion.Never }) : withSpring(to, sizing());
  };

  useEffect(() => {
    if (open) {
      setMounted(true);
      drag.value = 0;
      grow.value = 0;
      flung.value = 0;
      big.value = large ? 1 : 0;
      isHalf.value = half;
      // A medium sheet waits for its page to say how tall it is (offscreen, below, until then).
      const to = targetOf(topKey);
      target.current = to;
      tall.value = to ?? screen;
      // With Reduce Motion on it fades in where it stands; otherwise it rises.
      present.value = still
        ? withTiming(1, { duration: slow(FADE_MS), easing: ease.snap, reduceMotion: ReduceMotion.Never })
        : nextFrame(withTiming(1, { duration: slow(ARRIVE_MS), easing: arrive }));
    } else {
      // The web hands the keyboard back at once; VoiceOver once the sheet, which holds it modal, is gone.
      if (Platform.OS === "web") giveBack(trigger.current);
      // A flick hands its speed on: easing out from it, the time it takes to cover the way at that speed, never longer
      // than an unhurried close.
      const away = Math.min(tall.value, screen) + 40;
      const quick = flung.value > 0 ? Math.max(160, Math.min(LEAVE_MS, (2 * away * 1000) / flung.value)) : 0;
      if (still)
        present.value = withTiming(0, { duration: slow(FADE_MS), easing: ease.snap, reduceMotion: ReduceMotion.Never }, (finished) => {
          if (finished) scheduleOnRN(setMounted, false);
        });
      else
        present.value = withTiming(0, { duration: slow(quick || LEAVE_MS), easing: quick ? Easing.out(Easing.quad) : leave }, (finished) => {
          if (finished) scheduleOnRN(setMounted, false);
        });
    }
    // Only opening and closing start this; the page on top changing is the next effect's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (mounted || Platform.OS === "web" || !trigger.current) return;
    giveBack(trigger.current);
    trigger.current = null;
  }, [mounted]);

  // Another sheet on top: the frame stays and changes size in place, along the path it arrived on.
  const lastTop = useRef(topKey);
  useLayoutEffect(() => {
    const from = lastTop.current;
    lastTop.current = topKey;
    if (from === topKey || !open || !from) return;
    opening.current = false;
    isHalf.value = half;
    // A half sheet pulled up hands on the height it was pulled to.
    if (grow.value > 0) {
      tall.value = tall.value + grow.value * span;
      target.current = tall.value;
      grow.value = 0;
    }
    big.value = still ? withTiming(large ? 1 : 0, { duration: slow(FADE_MS), easing: ease.snap, reduceMotion: ReduceMotion.Never }) : withSpring(large ? 1 : 0, sizing());
    // A medium page not laid out yet says its height as it does (onPageHeight), and the frame goes there then.
    const to = targetOf(topKey);
    if (to !== null) resize(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the page on top changing starts this.
  }, [topKey]);

  const onPageHeight = (key: string, h: number) => {
    heights.set(key, h);
    if (key !== lastTop.current || page(key).detent !== "medium") return;
    resize(headNow.current + h + foot, opening.current);
    opening.current = false;
  };

  // The head: what the page on top says, re-drawn whenever any page tells it something.
  const signal = useSignal();
  // Only a page up tells the head anything. A kept page, hidden, forgets what it said: shown again, it would say it
  // with what it showed last time (Settings' list where it now opens on a section), and the head would change twice.
  const upNow = useRef(shown);
  upNow.current = shown;
  const publish = useCallback(
    (key: string, spec: HeadSpec) => {
      if (!upNow.current.includes(key)) return void specs.delete(key);
      specs.set(key, spec);
      signal.emit();
    },
    [specs, signal],
  );
  // The top page has a way back of its own (a section in Settings): its own stack takes the swipe.
  const [nested, setNested] = useState(false);
  // What the circle at the left does now: Escape and Android's Back do the same.
  const leftAction = useRef<() => void>(onDismiss);
  // A swipe back in any stack on this frame, the frame's own or one inside its top page: the head follows it.
  const progress = useSharedValue(0);
  const hands = useRef<SwipeHands | null>(null);
  const headSwipe = useMemo<HeadSwipe>(() => ({ progress, start: () => hands.current?.start(), end: (back) => hands.current?.end(back) }), [progress]);

  const dismiss = () => {
    haptic.soft();
    onDismiss();
  };
  const escape = useRef({ current: () => leftAction.current() });
  useEffect(() => {
    if (!open) return;
    const entry = escape.current;
    stack.push(entry);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);

  // A large sheet covers the bar: the shell's toast moves into its head row while it's up.
  useEffect(() => {
    if (!open || !large) return;
    coverBar(true);
    return () => coverBar(false);
  }, [open, large]);

  const room = (l: number, kb: number) => {
    "worklet";
    const medium = screen - top - gap - (kb ? kb + gap : gap);
    return medium + (screen - top - medium) * l;
  };
  const pan = usePanGesture({
    activeOffsetY: [-6, 6],
    onActivate: () => {
      "worklet";
      grewFrom.value = grow.value;
    },
    onUpdate: (e) => {
      "worklet";
      if (isHalf.value) {
        // Up grows it to its full height, then gives a little; down shrinks it to half, then follows the finger.
        const g = grewFrom.value - e.translationY / span;
        grow.value = Math.min(1, Math.max(0, g));
        drag.value = g > 1 ? -Math.sqrt((g - 1) * span) * 2 : g < 0 ? -g * span : 0;
        return;
      }
      // Down follows the finger; up gives a little and stops, like the sheet is held at its top.
      drag.value = e.translationY > 0 ? e.translationY : -Math.sqrt(-e.translationY) * 2;
    },
    onDeactivate: (e) => {
      "worklet";
      if (isHalf.value) {
        if (drag.value > lowH / 3 || (grewFrom.value === 0 && grow.value === 0 && e.velocityY > 900)) {
          flung.value = Math.max(0, e.velocityY);
          scheduleOnRN(dismiss);
          return;
        }
        // A flick decides; otherwise it settles at whichever height it is past a third of the way to.
        const up = e.velocityY < -500 || (e.velocityY < 500 && grow.value > (grewFrom.value > 0.5 ? 0.66 : 0.33));
        grow.value = withSpring(up ? 1 : 0, release);
        drag.value = withSpring(0, release);
        return;
      }
      const h = Math.min(tall.value, room(big.value, Math.max(0, keyboard.height.value)));
      if (e.translationY > h / 3 || e.velocityY > 900) {
        flung.value = Math.max(0, e.velocityY);
        scheduleOnRN(dismiss);
      } else drag.value = withSpring(0, release);
    },
  });

  // The frame: floating 8pt in on glass at the page's height, or standing from the top, or anywhere between while it
  // changes from one to the other. A medium sheet rides up on the keyboard; a large one keeps its content above it. Its
  // shadow falls under a floating sheet and over the screen above a standing one, turning over as it changes size.
  const shadow = dark ? 0.45 : 0.16;
  const frame = useAnimatedStyle(() => {
    const l = big.value;
    const kb = Math.max(0, keyboard.height.value);
    const h = Math.min(tall.value + grow.value * span, room(l, kb));
    const inset = gap * (1 - l);
    const y = 8 - 14 * l;
    const rise = still ? 0 : (1 - present.value) * (h + 40);
    const opacity = still ? present.value : 1;
    if (WEB)
      return {
        left: inset + wide,
        right: inset + wide,
        bottom: (gap + kb) * (1 - l),
        height: h,
        paddingBottom: kb * l,
        opacity,
        transform: [{ translateY: rise + drag.value }],
        boxShadow: `0px ${y}px 28px rgba(0, 0, 0, ${shadow})`,
      };
    return {
      left: inset + wide,
      right: inset + wide,
      bottom: (gap + kb) * (1 - l),
      height: h,
      paddingBottom: kb * l,
      opacity,
      transform: [{ translateY: rise + drag.value }],
      shadowOffset: { width: 0, height: y },
    };
  });
  const corners = useAnimatedStyle(() => {
    const l = big.value;
    const topR = MEDIUM_RADIUS + (layout.sheet.radius - MEDIUM_RADIUS) * l;
    return { borderTopLeftRadius: topR, borderTopRightRadius: topR, borderBottomLeftRadius: MEDIUM_RADIUS * (1 - l), borderBottomRightRadius: MEDIUM_RADIUS * (1 - l) };
  });
  const solid = useAnimatedStyle(() => ({ opacity: big.value }));
  const footing = useAnimatedStyle(() => ({ height: foot * (1 - big.value) }));
  const dim = useAnimatedStyle(() => {
    const h = Math.max(1, Math.min(tall.value, screen));
    return { opacity: present.value * (dark ? 0.5 : 0.3) * (1 - Math.min(1, Math.max(0, drag.value) / h)) };
  });
  // The tallest a medium page may stand: the room over the keyboard, less the head and the foot.
  const pageRoom = useDerivedValue(() => room(0, Math.max(0, keyboard.height.value)) - headH.value - foot);

  // The shell's frame stays mounted for the sheets it keeps; a sheet on its own goes when it's away.
  if (!mounted && !keep) return null;
  const fill = large ? c.popover : dark ? "#1c1c1e" : c.popover;
  const surface = specs.get(topKey)?.surface;
  const solidFill = surface ?? c.popover;
  const renderPage = (key: string, index: number) => {
    const p = page(key);
    return (
      <Slotted slotKey={key} index={index} detent={p.detent} publish={publish}>
        {p.element}
      </Slotted>
    );
  };
  return (
    <View style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }, mounted ? null : { display: "none" }]} pointerEvents={open ? "box-none" : "none"}>
      <Animated.View style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.scrim }, dim]}>
        <Pressable accessibilityLabel="Close" style={[{ flex: 1 }, { outlineStyle: "none" } as object]} onPress={dismiss} />
      </Animated.View>
      <Animated.View accessibilityViewIsModal style={[{ position: "absolute" }, WEB ? null : { shadowColor: "#000", shadowOpacity: shadow, shadowRadius: 28 }, frame]}>
        <Animated.View style={[{ flex: 1, overflow: "hidden" }, corners]}>
          {glassy ? (
            <>
              <Frost style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: MEDIUM_RADIUS }} />
              {/* A wash of its grey over the glass at 96%, under a 40px blur where the browser draws one: rows of words
                  need a calm ground, so what's behind only tints it and never shows a shape (a bright Allow, a bubble,
                  the box's round button at its foot). */}
              <View pointerEvents="none" style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: alpha(dark ? "#1c1c1e" : c.popover, 0.96) }, WASH_BLUR]} />
            </>
          ) : null}
          {/* The large sheet's opaque grey: it fades in over the glass as a medium sheet grows into a large one. */}
          <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: solidFill }, solid]} />
          <HeadSwipeContext.Provider value={headSwipe}>
            <Head
              key={session.current}
              keys={shown}
              specs={specs}
              signal={signal}
              pan={pan}
              onPop={onPop}
              onNested={setNested}
              leftAction={leftAction}
              progress={progress}
              hands={hands}
              onHeight={(h) => {
                // Hidden, the head measures nothing; shown, a medium sheet stands at its page plus this.
                if (!h || h === headNow.current) return;
                headNow.current = h;
                headH.value = h;
                const body = heights.get(lastTop.current);
                if (body !== undefined && page(lastTop.current).detent === "medium") resize(h + body + foot, opening.current);
              }}
            />
            <View style={{ flex: 1 }}>
              <PageStack
                pages={mounted ? shown : []}
                keep={keep}
                render={renderPage}
                onBack={onPop}
                ground={fill}
                swipe={!nested}
                fit={(key) => page(key).detent === "medium"}
                onHeight={onPageHeight}
                maxHeight={pageRoom}
              />
            </View>
          </HeadSwipeContext.Provider>
          <Animated.View style={footing} />
          {/* Its hairline edge, over the pages so one sliding never covers it: the large sheet's top reads against
              whatever screen it covers, the dim or not. */}
          <Animated.View
            pointerEvents="none"
            style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, borderColor: c.edge }, corners, solid]}
          />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/** The grabber, 36x5 and 6pt from the sheet's top, drawn over the head so it takes no room. */
function Grabber() {
  const { c, dark } = useTheme();
  return <View pointerEvents="none" style={{ position: "absolute", top: 6, alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: dark ? "#4a4a4d" : alpha(c.text, 0.18), zIndex: 1 }} />;
}

/** A SheetBack handed in as `leading`, read as the way back it is, so the head can turn its X into it in place. */
function backOf(leading: ReactNode): SheetBackTo | undefined {
  if (!isValidElement(leading) || leading.type !== SheetBack) return undefined;
  return (leading as ReactElement<SheetBackTo>).props;
}

/** What the frame's swipe tells its head: a swipe started carrying the top page, and how it settled. */
interface SwipeHands {
  start: () => void;
  end: (back: boolean) => void;
}

/** The frame's head: the page on top's title row, with the way back to the page under it when it has none of its own. */
function Head({
  keys,
  specs,
  signal,
  pan,
  onPop,
  onNested,
  leftAction,
  progress,
  hands,
  onHeight,
}: {
  keys: readonly string[];
  specs: Map<string, HeadSpec>;
  signal: ReturnType<typeof useSignal>;
  pan: ReturnType<typeof usePanGesture>;
  onPop: () => void;
  onNested: (on: boolean) => void;
  leftAction: { current: () => void };
  progress: SharedValue<number>;
  hands: { current: SwipeHands | null };
  onHeight: (h: number) => void;
}) {
  const { c } = useTheme();
  useSyncExternalStore(signal.subscribe, signal.version, signal.version);
  // A sheet just opened over another tells its head what it shows a moment after it first draws: until it has, the
  // head keeps showing what it showed, so it changes in place rather than being drawn afresh.
  const shown = useRef<{ index: number; key: string; spec: HeadSpec } | null>(null);
  let index = keys.length - 1;
  let key = keys[index] ?? "";
  let spec = specs.get(key);
  if (spec) shown.current = { index, key, spec };
  else if (shown.current) ({ index, key, spec } = shown.current);
  const under = index > 0 ? specs.get(keys[index - 1] ?? "") : undefined;
  const own = spec?.back ?? backOf(spec?.leading);
  const back = own ?? (index > 0 ? { label: `Back to ${under?.title ?? under?.name ?? "the last sheet"}`, onPress: onPop } : undefined);
  const nested = !!own;
  useEffect(() => onNested(nested), [nested, onNested]);
  // A sheet opened over another is a level deeper than any page inside the one under it.
  const level = Math.max(0, index) * 100 + (spec?.depth ?? (own ? 1 : 0));
  const place = `${index}|${key}|${level}`;

  // A swipe back carrying the top page: the head follows the finger. Let go past its point, the head is already showing
  // the page it lands on, so when the stack gets there the head stays as it is rather than changing again.
  const [dragging, setDragging] = useState(false);
  const landedFrom = useRef<string | null>(null);
  const landed = landedFrom.current !== null && landedFrom.current !== place;
  const drag = dragging && !landed;
  hands.current = {
    start: () => {
      landedFrom.current = null;
      setDragging(true);
    },
    end: (gone) => {
      if (!gone) return setDragging(false);
      landedFrom.current = place;
      // Should the stack not go back after all, the head comes back to where it is.
      setTimeout(() => {
        if (landedFrom.current !== place) return;
        landedFrom.current = null;
        setDragging(false);
      }, 500);
    },
  };

  // For a moment after the head changes, its circles take no taps (iOS's bar buttons don't while a page moves): a
  // second tap on Back would land on a glyph that has just turned, closing the sheet where it meant to go back once.
  const busyUntil = useRef(0);
  const lastPlace = useRef(place);
  useLayoutEffect(() => {
    if (lastPlace.current === place) return;
    lastPlace.current = place;
    busyUntil.current = landed ? 0 : Date.now() + slow(PUSH_MS);
    if (!landed) return;
    landedFrom.current = null;
    setDragging(false);
    // Only the place changing starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);
  const guard = (run: () => void) => () => {
    if (Date.now() >= busyUntil.current) run();
  };

  const close = () => {
    haptic.soft();
    spec?.onClose();
  };
  leftAction.current = guard(back ? back.onPress : close);
  const action = spec?.action ? { ...spec.action, onPress: guard(spec.action.onPress) } : undefined;
  // What the head shows once the swipe has taken this page away: the page under it inside this sheet, or the sheet
  // under this one, and whether its circle is a way back too.
  const coming: Omit<Coming, "progress"> | undefined = !drag
    ? undefined
    : own
      ? { title: own.title, subtitle: own.subtitle, back: (spec?.depth ?? 1) - 1 > 0 || index > 0 }
      : index > 0
        ? { title: under?.title, subtitle: under?.subtitle, back: !!(under?.back ?? backOf(under?.leading)) || index > 1 }
        : undefined;
  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false} onLayout={(e) => onHeight(e.nativeEvent.layout.height)}>
        <Grabber />
        {!spec ? (
          <View style={{ height: HEAD }} />
        ) : spec.header ? (
          spec.header
        ) : (
          // The way back and the title drag the sheet down like its grabber does; a hairline under them once the page
          // scrolls under.
          <View style={{ borderBottomWidth: 1, borderBottomColor: spec.divided ? c.hairline : "transparent" }}>
            <SheetHeader
              title={spec.title}
              subtitle={spec.subtitle}
              accessory={spec.accessory}
              action={action}
              back={back ? { ...back, onPress: guard(back.onPress) } : undefined}
              leading={own ? undefined : spec.leading}
              onClose={guard(close)}
              closeLabel={spec.closeLabel}
              depth={level}
              page={key}
              swipe={coming ? { progress, ...coming } : undefined}
              instant={landed}
            />
          </View>
        )}
      </View>
    </GestureDetector>
  );
}

// ---------------------------------------------------------------- the head, changing in place

interface Layer<T> {
  key: number;
  value: T;
  leaving: boolean;
  first: boolean;
}

/**
 * What one slot of the head shows, as layers: the one up, and those on their way out while it arrives. A new `id` is a
 * new thing to show (another page's title); the same id with a new value is the same thing changing in place. `dir`
 * says which way the latest change went: 1 deeper, -1 back, 0 the same page saying something new (a plain fade).
 * `instant` puts the new one up at once with nothing leaving: a swipe has already shown it arriving.
 */
function useSwap<T>(id: string, place: string, level: number, value: T, instant = false) {
  const [s, setS] = useState(() => ({ id, place, level, n: 0, dir: 1, list: [{ key: 0, value, leaving: false, first: true }] as Layer<T>[] }));
  let now = s;
  if (s.id !== id) {
    const n = s.n + 1;
    const dir = place === s.place ? 0 : level < s.level ? -1 : 1;
    const list: Layer<T>[] = instant ? [{ key: n, value, leaving: false, first: true }] : [...s.list.map((l) => (l.leaving ? l : { ...l, leaving: true })), { key: n, value, leaving: false, first: false }];
    now = { id, place, level, n, dir, list };
    setS(now);
  }
  const done = useCallback((key: number) => setS((x) => ({ ...x, list: x.list.filter((l) => l.key !== key || !l.leaving) })), []);
  return { list: now.list.map((l) => (l.key === now.n ? { ...l, value } : l)), dir: now.dir, done };
}

/** A swipe back under way, as the head draws it: how far it has carried the page, and what it is bringing back. */
interface Coming {
  progress: SharedValue<number>;
  title?: string;
  subtitle?: string;
  /** The circle stays a way back where the swipe lands; false turns it back into the X as the finger moves. */
  back: boolean;
}

interface HeaderProps {
  title?: string;
  subtitle?: string;
  onClose: () => void;
  accessory?: ReactNode;
  action?: HeadAction;
  back?: SheetBackTo;
  leading?: ReactNode;
  closeLabel?: string;
  /** How deep what it shows is: deeper arrives from the right, shallower from the left. */
  depth?: number;
  /** What it shows, to tell another page from the same one changing; the title when not given. */
  page?: string;
  /** A swipe back carrying the page: the head follows the finger. */
  swipe?: Coming;
  /** What it shows now was already brought in by a swipe: it is up at once. */
  instant?: boolean;
}

/** The head's room either side of its title: the 16pt edge, a 44pt circle and the 8pt gap. */
const SIDE_ROOM = 16 + 44 + 8;

/**
 * Every sheet's head: a 44pt glass circle 16pt from the sheet's top and left, the X that closes it or, on a page pushed
 * inside it, the back chevron; the title centred on that row at 17/600 with an optional line under it at 15 in `muted`
 * ("7 connected"; the two fit the circle's 44pt); and an optional action at the right (Edit). The title stays centred
 * however wide the action is: both sides keep the same room.
 *
 * It changes in place, native way on iOS 26. The circle never moves and is never drawn twice: only its glyph changes,
 * X to chevron and back, a 160ms cross-fade from 0.7 of its size, each glyph mostly gone before the other is mostly
 * there. The title cross-fades, the old drifting 12pt toward the side the page leaves by and gone in 140ms while the new
 * arrives from 12pt the other way over 220ms, a moment later; reversed going back, and only a fade when the page stays
 * and says something new. A glass action on both sides keeps its glass and swaps what it says; one that comes or goes
 * scales from 0.8 as it fades. During a swipe back all of it follows the finger. With Reduce Motion on, only the fades
 * run.
 */
export function SheetHeader({ title, subtitle, onClose, accessory, action, back, leading, closeLabel = "Close", depth, page, swipe, instant = false }: HeaderProps) {
  const still = useReducedMotion();
  const way = back ?? backOf(leading);
  const own = leading && !way ? leading : null;
  const level = depth ?? (way ? 1 : 0);
  const at = `${page ?? ""}|${level}`;
  const titles = useSwap(`${at}|${title ?? ""}`, at, level, { title, subtitle }, instant);
  const right = useSwap(action ? "action" : accessory ? `accessory|${at}` : "none", at, level, { action, accessory });
  const [wide, setWide] = useState(0);
  // A page with no title (a connection's own page) hands where you are to the way back instead.
  const circle = useRef<unknown>(null);
  const was = useRef(at);
  useLayoutEffect(() => {
    if (was.current === at) return;
    was.current = at;
    if (!title && !instant) focusCircle(circle.current);
    // Only another page starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  return (
    <View onLayout={(e) => setWide(e.nativeEvent.layout.width)} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, gap: 8 }}>
      <View
        ref={(n: unknown) => {
          circle.current = n;
        }}
        collapsable={false}
        style={{ flex: 1, flexBasis: 0, alignItems: "flex-start" }}
      >
        {own ?? <LeftCircle back={way} onClose={onClose} closeLabel={closeLabel} still={still} instant={instant} carried={swipe && swipe.back !== !!way ? swipe.progress : undefined} />}
      </View>
      <View style={{ flexShrink: 1, alignItems: "center", minHeight: layout.float, justifyContent: "center" }}>
        {titles.list.map((l) => (
          <TitleLayer
            key={l.key}
            title={l.value.title}
            subtitle={l.value.subtitle}
            leaving={l.leaving}
            first={l.first}
            dir={titles.dir}
            still={still}
            carried={l.leaving ? undefined : swipe?.progress}
            onDone={() => titles.done(l.key)}
          />
        ))}
        {swipe?.title ? <ComingTitle title={swipe.title} subtitle={swipe.subtitle} progress={swipe.progress} still={still} room={wide ? wide - SIDE_ROOM * 2 : undefined} /> : null}
      </View>
      <View style={{ flex: 1, flexBasis: 0, alignItems: "flex-end", minHeight: layout.float, justifyContent: "center" }}>
        {right.list.map((l) => (
          <Pop key={l.key} leaving={l.leaving} first={l.first} still={still} onDone={() => right.done(l.key)}>
            {l.value.action ? <ActionButton action={l.value.action} level={level} still={still} /> : l.value.accessory}
          </Pop>
        ))}
      </View>
    </View>
  );
}

/** Focus on the way back, for a page that arrived with no title to go to: on the web its button, on iOS the circle. */
function focusCircle(node: unknown) {
  if (!node) return;
  if (Platform.OS === "web") {
    const el = node as { querySelector?: (s: string) => { focus?: (o?: object) => void } | null };
    el.querySelector?.('[role="button"]')?.focus?.({ preventScroll: true });
    return;
  }
  const handle = findNodeHandle(node as Parameters<typeof findNodeHandle>[0]);
  if (handle) setTimeout(() => AccessibilityInfo.setAccessibilityFocus(handle), 60);
}

/** How much of the X shows as the circle turns (0 the X, 1 the chevron): gone before half way, so the two never cross. */
const xInk = (k: number) => {
  "worklet";
  return Math.min(1, Math.max(0, (0.6 - k) / 0.6));
};
const chevronInk = (k: number) => {
  "worklet";
  return Math.min(1, Math.max(0, (k - 0.4) / 0.6));
};

/**
 * The one glass circle at the head's left: its glass stays, its glyph turns from X to a back chevron and back. During a
 * swipe back that lands on the first page, the glyph turns under the finger.
 */
function LeftCircle({ back, onClose, closeLabel, still, instant, carried }: { back?: SheetBackTo; onClose: () => void; closeLabel: string; still: boolean; instant: boolean; carried?: SharedValue<number> }) {
  const { c } = useTheme();
  const on = !!back;
  const turned = useSharedValue(on ? 1 : 0);
  const was = useRef(on);
  useLayoutEffect(() => {
    if (was.current === on) return;
    was.current = on;
    turned.value = instant ? (on ? 1 : 0) : nextFrame(withTiming(on ? 1 : 0, { duration: slow(GLYPH_MS), easing: ease.snap, reduceMotion: ReduceMotion.Never }));
    // Only the glyph changing starts this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  useAnimatedReaction(
    () => (carried ? carried.value : -1),
    (p) => {
      if (p < 0) return;
      turned.value = on ? 1 - p : p;
    },
    [carried, on],
  );
  const x = useAnimatedStyle(() => ({ opacity: xInk(turned.value), transform: [{ scale: still ? 1 : 0.7 + 0.3 * (1 - turned.value) }] }));
  const chevron = useAnimatedStyle(() => ({ opacity: chevronInk(turned.value), transform: [{ scale: still ? 1 : 0.7 + 0.3 * turned.value }] }));
  const glyph = { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, alignItems: "center" as const, justifyContent: "center" as const };
  return (
    <Squish label={back ? back.label : closeLabel} onPress={back ? back.onPress : onClose} depth={0.88} hitSlop={4}>
      <Frost interactive style={{ width: layout.float, height: layout.float, borderRadius: layout.float / 2 }}>
        <Animated.View pointerEvents="none" style={[glyph, x]}>
          <Icon name="close" size={20} color={c.text} />
        </Animated.View>
        <Animated.View pointerEvents="none" style={[glyph, chevron]}>
          <Icon name="chevronLeft" size={22} color={c.text} />
        </Animated.View>
      </Frost>
    </Squish>
  );
}

/** A title's words: 17/600, and the grey line under it. */
function TitleWords({ title, subtitle }: { title: string; subtitle?: string }) {
  const { c, t } = useTheme();
  return (
    <>
      <Text numberOfLines={1} style={[t.heading, { textAlign: "center", lineHeight: 22, letterSpacing: -0.2 }]}>
        {title}
      </Text>
      {subtitle ? (
        <Text numberOfLines={1} style={[t.row, { fontSize: 15, lineHeight: 20, color: c.muted, textAlign: "center", fontVariant: ["tabular-nums"] }]}>
          {subtitle}
        </Text>
      ) : null}
    </>
  );
}

/** Where a title on its way out, or one a swipe is bringing in, lies: over the one up, centred on it, taking no room. */
const OVER = { position: "absolute" as const, top: 0, bottom: 0, left: -400, right: -400, justifyContent: "center" as const, alignItems: "center" as const };

/**
 * One title in the head: arriving from 12pt the way the page came, or drifting off the other way as it fades. Carried
 * by a swipe back, it goes the way a pop takes it, as far as the finger has.
 */
function TitleLayer({ title, subtitle, leaving, first, dir, still, carried, onDone }: { title?: string; subtitle?: string; leaving: boolean; first: boolean; dir: number; still: boolean; carried?: SharedValue<number>; onDone: () => void }) {
  const here = useSharedValue(first ? 1 : 0);
  const node = useRef<unknown>(null);
  // How wide it stood while it was the title: going, it keeps that width, and where its words were cut (a point over,
  // since text measured to a fraction of a point and laid out again at that width can lose its last letter to an ellipsis).
  const wide = useRef(0);
  useLayoutEffect(() => {
    if (leaving)
      here.value = nextFrame(
        withTiming(0, { duration: slow(TITLE_OUT_MS), easing: ease.snap, reduceMotion: ReduceMotion.Never }, (done) => {
          if (done) scheduleOnRN(onDone);
        }),
      );
    else if (!first) here.value = nextFrame(withTiming(1, { duration: slow(TITLE_MS), easing: ease.snap, reduceMotion: ReduceMotion.Never }), slow(TITLE_IN_DELAY));
    // Only arriving and leaving start it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);
  // The new title is where you are now: VoiceOver and the keyboard go to it.
  useEffect(() => {
    if (!first && title) focusTitle(node.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the title arrives.
  }, []);
  const style = useAnimatedStyle(() => {
    const p = carried ? carried.value : 0;
    const x = still ? 0 : (1 - here.value) * DRIFT * (leaving ? -dir : dir) + DRIFT * p;
    return { opacity: here.value * Math.min(1, Math.max(0, 1 - p / 0.6)), transform: [{ translateX: x }] };
  });
  if (!title) return null;
  return (
    <Animated.View aria-hidden={leaving} pointerEvents={leaving ? "none" : "auto"} style={[leaving ? OVER : { alignItems: "center" }, style]}>
      <View
        ref={(n: unknown) => {
          node.current = n;
        }}
        accessible={!leaving}
        accessibilityRole="header"
        accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        onLayout={(e) => {
          if (!leaving) wide.current = e.nativeEvent.layout.width;
        }}
        style={[{ alignItems: "center" }, leaving && wide.current ? { width: Math.ceil(wide.current) + 1 } : null, { outlineStyle: "none" } as object]}
      >
        <TitleWords title={title} subtitle={subtitle} />
      </View>
    </Animated.View>
  );
}

/** The title a swipe back is bringing in, under the finger: it comes in from 12pt the leading side as the page goes. */
function ComingTitle({ title, subtitle, progress, still, room }: { title: string; subtitle?: string; progress: SharedValue<number>; still: boolean; room?: number }) {
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    return { opacity: Math.min(1, Math.max(0, (p - 0.3) / 0.7)), transform: [{ translateX: still ? 0 : -DRIFT * (1 - p) }] };
  });
  return (
    <Animated.View aria-hidden pointerEvents="none" style={[OVER, style]}>
      <View style={[{ alignItems: "center" }, room ? { maxWidth: room } : null]}>
        <TitleWords title={title} subtitle={subtitle} />
      </View>
    </Animated.View>
  );
}

/**
 * What comes and goes at the head's right: it scales from 0.8 as it fades in, and back as it goes. Liquid Glass renders
 * wrong under opacity, so there it only scales, from nothing, as iOS's own glass buttons do.
 */
function Pop({ leaving, first, still, onDone, children }: { leaving: boolean; first: boolean; still: boolean; onDone: () => void; children: ReactNode }) {
  const here = useSharedValue(first ? 1 : 0);
  useLayoutEffect(() => {
    const timing = { duration: slow(GLYPH_MS), easing: ease.snap, reduceMotion: ReduceMotion.Never };
    if (leaving)
      here.value = nextFrame(
        withTiming(0, timing, (done) => {
          if (done) scheduleOnRN(onDone);
        }),
      );
    else if (!first) here.value = nextFrame(withTiming(1, timing));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only arriving and leaving start it.
  }, [leaving]);
  const style = useAnimatedStyle(() => {
    if (liquidGlass) return { transform: [{ scale: still ? (here.value > 0.5 ? 1 : 0) : Math.max(0.01, here.value) }] };
    return { opacity: here.value, transform: [{ scale: still ? 1 : 0.8 + 0.2 * here.value }] };
  });
  if (!children) return null;
  return (
    <Animated.View pointerEvents={leaving ? "none" : "box-none"} aria-hidden={leaving} style={[leaving ? { position: "absolute", right: 0 } : null, style]}>
      {children}
    </Animated.View>
  );
}

/** The head's own glass action: its glass stays while what it says changes, the old word or glyph fading as the new comes. */
function ActionButton({ action, level, still }: { action: HeadAction; level: number; still: boolean }) {
  const { c, t } = useTheme();
  const words = !action.icon;
  const inside = useSwap(action.icon ?? action.label, "", level, action);
  return (
    <Squish label={action.accessibilityLabel ?? action.label} onPress={action.onPress} depth={words ? 0.94 : 0.88} hitSlop={4}>
      <Frost interactive style={[{ height: layout.float, borderRadius: layout.float / 2, alignItems: "center", justifyContent: "center" }, words ? { paddingHorizontal: 16 } : { width: layout.float }]}>
        {inside.list.map((l) => (
          <Swapped key={l.key} leaving={l.leaving} first={l.first} still={still} onDone={() => inside.done(l.key)}>
            {l.value.icon ? (
              <Icon name={l.value.icon} size={20} color={c.text} />
            ) : (
              <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.button, { color: c.soft }]}>
                {l.value.label}
              </Text>
            )}
          </Swapped>
        ))}
      </Frost>
    </Squish>
  );
}

/** A glyph or word inside a glass that stays: a cross-fade from 0.7 of its size. */
function Swapped({ leaving, first, still, onDone, children }: { leaving: boolean; first: boolean; still: boolean; onDone: () => void; children: ReactNode }) {
  const here = useSharedValue(first ? 1 : 0);
  useLayoutEffect(() => {
    const timing = { duration: slow(GLYPH_MS), easing: ease.snap, reduceMotion: ReduceMotion.Never };
    if (leaving)
      here.value = nextFrame(
        withTiming(0, timing, (done) => {
          if (done) scheduleOnRN(onDone);
        }),
      );
    else if (!first) here.value = nextFrame(withTiming(1, timing));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only arriving and leaving start it.
  }, [leaving]);
  const style = useAnimatedStyle(() => ({ opacity: here.value, transform: [{ scale: still ? 1 : 0.7 + 0.3 * here.value }] }));
  return (
    <Animated.View pointerEvents="none" style={[leaving ? { position: "absolute", top: 0, bottom: 0, left: -40, right: -40, alignItems: "center", justifyContent: "center" } : null, style]}>
      {children}
    </Animated.View>
  );
}

/** A back circle for a page pushed inside a sheet. Handed to a sheet as `leading`, the head turns its X into it in place. */
export function SheetBack({ label, onPress }: SheetBackTo) {
  return <GlassCircle icon="chevronLeft" label={label} onPress={onPress} size={22} />;
}

// ---------------------------------------------------------------- grouped rows

/** Where a row's words start: 20pt in, a 20pt glyph, 12pt to the label. Hairlines start here too. */
export const SHEET_TEXT_X = 52;

/** A group's head: 15pt in the tertiary grey, 24 above and 6 below (native "Mode", "Add", "Info"). */
export function SheetLabel({ children, first = false, right }: { children: string; first?: boolean; /** Something that acts on the group, at the right (a count, a refresh). */ right?: ReactNode }) {
  const { c, t } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: first ? 4 : 24, paddingBottom: 4, minHeight: 28 }}>
      <Text accessibilityRole="header" style={[t.row, { flex: 1, fontSize: 15, lineHeight: 20, color: c.subtle }]}>
        {children}
      </Text>
      {right}
    </View>
  );
}

/**
 * A group: an optional head, then rows with a hairline between each two, inset to where the words start. The rows are
 * SheetRows; anything else is drawn as it is.
 */
export function SheetGroup({ label, first, right, children }: { label?: string; first?: boolean; right?: ReactNode; children: ReactNode }) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View>
      {label ? (
        <SheetLabel first={first} right={right}>
          {label}
        </SheetLabel>
      ) : null}
      {rows.map((row, i) => (isValidElement(row) && row.type === SheetRow ? cloneElement(row as ReactElement<RowProps>, { divided: i > 0 }) : row))}
    </View>
  );
}

interface RowProps {
  icon?: ReactNode;
  label: string;
  /** A line under the label, in grey. */
  detail?: string;
  /** What sits at the right: a check, a switch, a button. */
  right?: ReactNode;
  /** A value in grey before the chevron ("Grok 4.7", "Desktop"). */
  value?: string;
  /** The row opens something. */
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  /** Can't be picked now; its detail says why. Its words go grey and its marks dim, as a menu's disabled row. */
  disabled?: boolean;
  /** Words dimmer than a label: a create row ("New Chief", "Add a project…"). */
  quiet?: boolean;
  /** What the row's marks draw, said to a screen reader ("Claude and Codex sessions here, used 2d ago"). */
  hint?: string;
  /** Set by SheetGroup: a hairline above it, inset to the words. */
  divided?: boolean;
  /** The label is code: a path, a branch, a command. */
  code?: boolean;
}

/**
 * A sheet's row: a 20pt glyph slot (a pixel icon, a logo, a sprite), the label at 17pt, a grey line under it, a value
 * or control at the right, 50pt at least. A held row lights full-bleed, as an iOS list's does.
 */
export function SheetRow({ icon, label, detail, right, value, chevron, onPress, onLongPress, selected, disabled, quiet, hint, divided, code }: RowProps) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  // A swipe back that began on the row carries the page, not the row: it doesn't stay lit, or open as the finger lifts.
  const carried = useCarried();
  const inset = icon ? SHEET_TEXT_X : 20;
  const pressable = (!!onPress || !!onLongPress) && !disabled;
  // A disabled row's words are the description grey, which still reads (5.7:1 on a sheet in dark, 6.7:1 in light);
  // only its glyph, its control and its chevron dim. Fading the whole row took its value to about 2.4:1.
  const dim = disabled ? 0.5 : 1;
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={[label, detail, value].filter(Boolean).join(", ")}
      accessibilityHint={hint}
      accessibilityState={{ selected, disabled }}
      disabled={!pressable}
      onPressIn={() => pressable && setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        if (carried.recently()) return;
        haptic.tick();
        onPress?.();
      }}
      onLongPress={onLongPress}
      style={[{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: layout.row.sheet, paddingHorizontal: 20, paddingVertical: detail ? 9 : 4, backgroundColor: held && !carried.now ? alpha(c.text, 0.06) : undefined }, { outlineStyle: "none" } as object]}
    >
      {divided ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: inset, right: 20, height: 1, backgroundColor: c.hairline }} /> : null}
      {icon ? <View style={{ width: 20, alignItems: "center", justifyContent: "center", opacity: dim }}>{icon}</View> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={[t.row, { fontSize: 17, lineHeight: 22, color: quiet || disabled ? c.muted : c.text }, code ? { fontFamily: mono, fontSize: 15 } : null]}>
          {label}
        </Text>
        {detail ? (
          <Text numberOfLines={2} style={[t.small, { fontSize: 14, lineHeight: 19 }]}>
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text numberOfLines={1} style={[t.row, { fontSize: 17, lineHeight: 22, color: c.muted, flexShrink: 1, maxWidth: "55%", textAlign: "right" }]}>
          {value}
        </Text>
      ) : null}
      {right && disabled ? <View style={{ opacity: dim }}>{right}</View> : right}
      {chevron ? <Icon name="chevronRight" size={16} color={disabled ? alpha(c.subtle, dim) : c.subtle} /> : null}
    </Pressable>
  );
}
