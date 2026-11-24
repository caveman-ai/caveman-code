// Asks as a stack of summary cards (SummaryCard.tsx), the one in front answerable and the next ones' edges showing
// behind it, as a Chief's deck holds them. The front card follows the thumb: right says yes (Allow, or the option it
// recommends), left says no (Deny) or, for a question, Later (the next card comes to the front; this one waits at the
// back); each ticks once it's far enough and flies off when let go there; where `onStow` is given, down puts the stack
// away. A swipe that starts in Back's strip along the screen's left edge is never the card's (components/edge.ts).
// Every swipe has its button: the pair, the options, the pager's ›. What you answer leaves at once (src/asks/decide.ts)
// and the next card comes forward from behind; its choices hear no tap for ARM_MS, so the second tap of a double tap
// never answers it.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { Chat, Need } from "../board/model";
import { yieldToBack } from "../components/edge";
import { Icon } from "../components/Icon";
import { Squish } from "../components/Squish";
import { ease, haptic, release } from "../motion";
import { useTheme } from "../theme";
import { ARM_MS, type Reply } from "./decide";
import { PAGE_CORNER, recommendedOf, SummaryCard, type SummaryCardProps, surfaceOf } from "./SummaryCard";
import { usePane } from "../shell/layout";

/** How far a swipe goes before it decides. */
const FAR = 110;
/** How far down a swipe puts the stack away. */
const STOW = 60;
/** A swipe's word, stamped on the card's corner. */
const stamp = { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4, overflow: "hidden" as const };
/** How much of each card behind shows, and how much narrower it is each side. */
const PEEK = 7;
const NARROW = 10;

export interface StackItem {
  /** Changes when the ask does: the card in front is a new one. */
  key: string;
  /** The chat that asks: the answer goes to it. */
  asker: Chat;
  /** The chat it shows under (the parent of a subagent that asks). */
  row: Chat;
  need: Need;
}

/** "‹ 1 of 3 ›": the arrows hit at 44 pt; › is Later's button. */
export function Pager({ index, count, onPage }: { index: number; count: number; onPage: (next: number) => void }) {
  const { c, t } = useTheme();
  const arrow = { width: 40, height: 44, alignItems: "center" as const, justifyContent: "center" as const };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginRight: -12, marginVertical: -11 }}>
      <Squish label="Previous ask" disabled={index === 0} depth={0.88} hitSlop={2} onPress={() => onPage(index - 1)} style={arrow}>
        <Icon name="chevronLeft" size={16} color={c.muted} />
      </Squish>
      <Text style={[t.meta, { color: c.muted }]}>
        {index + 1} of {count}
      </Text>
      <Squish label="Next ask" disabled={count < 2} depth={0.88} hitSlop={2} onPress={() => onPage(index + 1)} style={arrow}>
        <Icon name="chevronRight" size={16} color={c.muted} />
      </Squish>
    </View>
  );
}

/**
 * A card under the thumb: right and left decide (or page), down stows where it can. It arrives coming forward from the
 * card behind it (`from`: up where the stack rises over a dock, down where it lies in a page).
 */
function useSwipe({ onSwipe, onStow, can, from }: { onSwipe: (yes: boolean) => void; onStow?: () => void; can: { yes: boolean; no: boolean }; from: "up" | "down" }) {
  // When the thumb last dragged the card: the web ends a drag with a click on what lay under it, which must not open
  // the chat the swipe just answered (a phone's gesture handler cancels that touch itself).
  const dragged = useRef(0);
  const drag = () => {
    dragged.current = Date.now();
  };
  const { width: screen } = usePane();
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const shown = useSharedValue(0);
  const past = useSharedValue(0);
  // 0 until the thumb has picked a way, then 1 across, 2 down.
  const axis = useSharedValue(0);
  const stowable = !!onStow;
  const stow = () => onStow?.();
  // Which ways it can go, where the thumb's worklet reads them as they change.
  const yesOk = useSharedValue(can.yes);
  const noOk = useSharedValue(can.no);
  useEffect(() => {
    yesOk.value = can.yes;
    noOk.value = can.no;
  }, [can.yes, can.no, yesOk, noOk]);
  const pan = usePanGesture({
    activeOffsetX: [-12, 12],
    // Down puts it away where it can; elsewhere a mostly vertical drag is the page's scroll, never the card's.
    activeOffsetY: stowable ? [-10000, 14] : [-10000, 10000],
    failOffsetY: stowable ? [-10000, 10000] : [-12, 12],
    // A swipe from the screen's left edge is Back's, never the card's (components/edge.ts).
    onBegin: (e) => {
      "worklet";
      yieldToBack(e);
    },
    onUpdate: (e) => {
      "worklet";
      if (axis.value === 0) {
        axis.value = Math.abs(e.translationX) >= Math.abs(e.translationY) ? 1 : 2;
        scheduleOnRN(drag);
      }
      if (axis.value === 2) {
        y.value = Math.max(0, e.translationY);
        return;
      }
      // A way it can't go gives a little and comes back.
      const allowed = (e.translationX > 0 && yesOk.value) || (e.translationX < 0 && noOk.value);
      x.value = allowed ? e.translationX : e.translationX * 0.2;
      const far = allowed && Math.abs(e.translationX) > FAR ? 1 : 0;
      if (far !== past.value) {
        past.value = far;
        scheduleOnRN(haptic.tick);
      }
    },
    onDeactivate: (e) => {
      "worklet";
      scheduleOnRN(drag);
      if (axis.value === 2) {
        if (e.translationY > STOW || e.velocityY > 800) y.value = withTiming(260, { duration: 200, easing: Easing.in(Easing.quad) }, (done) => done && scheduleOnRN(stow));
        else y.value = withSpring(0, release);
      } else {
        const yes = e.translationX > 0 || (e.translationX === 0 && e.velocityX > 0);
        const going = (Math.abs(e.translationX) > FAR || Math.abs(e.velocityX) > 900) && (yes ? yesOk.value : noOk.value);
        if (going) x.value = withTiming((yes ? 1 : -1) * (screen + 40), { duration: 220, easing: Easing.bezier(0.55, 0, 1, 0.45) }, (done) => done && scheduleOnRN(onSwipe, yes));
        else x.value = withSpring(0, { ...release, velocity: e.velocityX });
      }
      axis.value = 0;
      past.value = 0;
    },
  });
  const lift = from === "up" ? -PEEK : PEEK;
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, 0.4 + shown.value),
    transform: [{ translateX: x.value }, { translateY: y.value + (1 - shown.value) * lift }, { scale: 0.96 + 0.04 * shown.value }, { rotate: `${x.value / 40}deg` }],
  }));
  // The stamp is solid well before the swipe decides, so it never shows the words under it through itself.
  const yesHint = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [12, 48], [0, 1], Extrapolation.CLAMP) }));
  const noHint = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [-48, -12], [1, 0], Extrapolation.CLAMP) }));
  /** A new card in front: it comes forward from behind, and stands where the last one was taken from. */
  const arrive = () => {
    x.value = 0;
    y.value = 0;
    shown.value = 0;
    shown.value = withTiming(1, { duration: 240, easing: ease.snap });
  };
  /** A swipe that answered nothing (answered elsewhere a moment before): the card comes back. */
  const back = () => {
    x.value = withSpring(0, release);
    y.value = withSpring(0, release);
  };
  /** Whether a tap now is a tap, not the end of a drag. */
  const still = () => Date.now() - dragged.current > 400;
  return { pan, style, yesHint, noHint, arrive, back, still };
}

export interface StackProps {
  items: readonly StackItem[];
  /** In a page (`flat`: Home), or floating over the box (`float`: a Chief's deck). */
  surface: "flat" | "float";
  /** Lead each card with its Chief's face: across Chiefs. */
  showChief?: boolean;
  /** With `showChief`, the face as well as the name; false where the Chief stands on the stack (`perch`). */
  face?: boolean;
  /** Where the cards behind show: over the front one (a stack standing on the box) or under it (one lying in a page). */
  peek?: "up" | "down";
  onReply: (item: StackItem, reply: Reply) => void;
  onOpen: (item: StackItem) => void;
  onPeek?: (item: StackItem) => void;
  /** "Tell it something else…" brings back the box; absent, the card opens its own field. */
  onTell?: (item: StackItem) => void;
  /** Swiped down, or Later on the last card: the stack is put away (a Chief's deck: the box comes back). */
  onStow?: () => void;
  /** A swipe decided (right is yes): a screen that teaches the swipe can stop. */
  onSwiped?: (yes: boolean) => void;
  /** The card in front changed (a Chief hops at it). */
  onShown?: (key: string) => void;
  /** Its height changed, for what must stay clear of it. */
  onHeight?: (height: number) => void;
  /** Over the stack's top edge (a Chief standing on its deck). */
  perch?: ReactNode;
  /** The card's size: `deck` (who, the summary, the ask), `dock` (the thread's: the ask alone, the chat being above it) or `page` (the Queue's, with `fit`). */
  variant?: "deck" | "dock" | "page";
  /** The dock in a subagent: who asks, which opens the parent. */
  source?: SummaryCardProps["source"];
  /** Which card is in front, when the screen holds it (a pager of its own); absent, the stack keeps it. */
  index?: number;
  /** The card in front moved (the pager, a Later): where to, when the screen holds it. */
  onIndex?: (index: number) => void;
  /** Draw "‹ 1 of 3 ›" in the front card's header (default); false where the screen draws its own. */
  pager?: boolean;
  /**
   * Fit the height it is given (the Queue's one card at a time): the card stands at its own height, and when that is
   * more than the room, it gives way and scrolls inside.
   */
  fit?: boolean;
}

/** The stack itself: the card in front, and the edges of up to two behind it. */
export function Stack({ items, surface, showChief = false, face = true, peek = "down", onReply, onOpen, onPeek, onTell, onStow, onShown, onSwiped, onHeight, perch, variant = "deck", source, index: held, onIndex, pager = true, fit = false }: StackProps) {
  const { c, t, dark } = useTheme();
  const [own, setOwn] = useState(0);
  const page = held ?? own;
  const setPage = (next: number | ((was: number) => number)) => {
    const to = typeof next === "function" ? next(page) : next;
    if (held === undefined) setOwn(to);
    onIndex?.(to);
  };
  const [frontH, setFrontH] = useState(0);
  const index = Math.min(page, Math.max(0, items.length - 1));
  const item = items[index];
  const key = item?.key ?? "";
  const behind = Math.min(2, Math.max(0, items.length - 1));
  const recommended = item ? recommendedOf(item.need) : null;
  const question = item?.need.kind === "question";
  // A question's no is Later: the next card comes forward; on the last one, the stack is put away (or stays, with
  // nowhere to put it).
  const can = { yes: !!item && (!question || !!recommended), no: !!item && (!question || items.length > 1 || !!onStow) };
  const armedAt = useRef(0);

  const swipe = (yes: boolean) => {
    if (!item) return;
    onSwiped?.(yes);
    // Whatever the swipe does brings another card forward; if none came, the one that flew off comes back.
    const was = item.key;
    setTimeout(() => {
      if (front.current === was) back();
    }, 400);
    if (yes) {
      haptic.thud();
      onReply(item, question && recommended ? { kind: "option", option: recommended } : { kind: "allow" });
    } else if (question) {
      haptic.tap();
      if (items.length > 1) later();
      else onStow?.();
    } else {
      haptic.tap();
      onReply(item, { kind: "deny" });
    }
  };
  const { pan, style, yesHint, noHint, arrive, back, still } = useSwipe({ onSwipe: swipe, onStow, can, from: peek });
  const front = useRef(key);
  front.current = key;
  const later = () => setPage((p) => (p + 1) % Math.max(1, items.length));
  const pageTo = (next: number) => {
    haptic.tick();
    // Past the last, the first again: › is Later, and Later always has somewhere to go.
    setPage(((next % items.length) + items.length) % items.length);
  };

  // A new card in front: it comes forward, its choices wait ARM_MS, and the screen hears of it.
  const told = useRef(onShown);
  told.current = onShown;
  useEffect(() => {
    if (!key) return;
    armedAt.current = Date.now();
    arrive();
    told.current?.(key);
  }, [key]);
  const heard = useRef(onHeight);
  heard.current = onHeight;
  // The edges behind count, over or under: what stands on the stack stands on its highest edge.
  const height = frontH ? frontH + behind * PEEK : 0;
  useEffect(() => {
    if (height) heard.current?.(height);
  }, [height]);

  if (!item) return null;
  const plate = surfaceOf(surface, c, dark);
  const yesWord = question ? "Recommended" : "Allow";
  const noWord = question ? "Later" : "Deny";
  return (
    <View pointerEvents="box-none" style={{ flexShrink: fit ? 1 : undefined, minHeight: fit ? 0 : undefined, marginTop: peek === "up" ? behind * PEEK : 0, marginBottom: peek === "down" ? behind * PEEK : 0 }}>
      {perch ? (
        <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: "100%", transform: [{ translateY: peek === "up" ? 6 - behind * PEEK : 6 }] }}>
          {perch}
        </View>
      ) : null}
      {/* The cards behind: their edges only, each a little narrower, so the stack reads as a stack and says how deep. */}
      {frontH
        ? Array.from({ length: behind }, (_, i) => behind - i).map((n) => (
            <View
              key={n}
              pointerEvents="none"
              style={[
                plate,
                { position: "absolute", left: n * NARROW, right: n * NARROW, height: frontH, ...(peek === "up" ? { top: -n * PEEK } : { top: n * PEEK }) },
                // A plate behind is a step quieter than the card in front, in both themes.
                { backgroundColor: n === 2 ? c.panel : c.card, shadowOpacity: 0, elevation: 0 },
                variant === "page" ? { borderRadius: PAGE_CORNER } : null,
              ]}
            />
          ))
        : null}
      <GestureDetector gesture={pan}>
        <Animated.View key={key} onLayout={(e) => setFrontH(Math.round(e.nativeEvent.layout.height))} style={[fit ? { flexShrink: 1, minHeight: 0 } : null, style]}>
          {/* What a swipe will do, on the corner that stays on screen as the card goes its way: a stamp on the card's
              own grey, so the words under it never show through. */}
          <Animated.View pointerEvents="none" aria-hidden style={[{ position: "absolute", zIndex: 1, top: 10, left: 12 }, yesHint]}>
            <Text style={[t.button, stamp, { color: c.success, borderColor: c.success, backgroundColor: c.card }]}>{yesWord}</Text>
          </Animated.View>
          {can.no ? (
            <Animated.View pointerEvents="none" aria-hidden style={[{ position: "absolute", zIndex: 1, top: 10, right: 12 }, noHint]}>
              <Text style={[t.button, stamp, { color: c.muted, borderColor: c.field, backgroundColor: c.card }]}>{noWord}</Text>
            </Animated.View>
          ) : null}
          <SummaryCard
            asker={item.asker}
            row={item.row}
            need={item.need}
            variant={variant}
            surface={surface}
            source={source}
            showChief={showChief}
            face={face}
            armKey={key}
            armed={(since) => Date.now() - Math.max(since, armedAt.current) >= ARM_MS}
            onReply={(reply) => onReply(item, reply)}
            onOpen={() => still() && onOpen(item)}
            onPeek={onPeek ? () => onPeek(item) : undefined}
            onTell={onTell ? () => onTell(item) : undefined}
            pager={pager && items.length > 1 ? <Pager index={index} count={items.length} onPage={pageTo} /> : null}
          />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
