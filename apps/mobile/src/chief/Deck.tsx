// What waits on a yes or a no on a Chief's screen, in two places, both built like the thread's approval dock
// (DECISIONS.md "Approval dock"; Codex and Claude dock their asks over the box).
//
// What its chats ask docks in the composer's place as a stack of summary cards the Chief stands on (src/asks/Stack.tsx):
// the card in front says who asks (its engine's mark and the chat; a tap opens it, a hold peeks), what it did so far,
// and what it needs in bold, then Deny | Allow, or the options for a question, with "Tell it what to do instead" (or
// "Tell it something else…"), which brings the box back so what you send from it answers. The edges of the next cards
// show over it, and "‹ 1 of 2 ›" pages through them. Swipe right to allow (or take what it recommends), left to deny
// (a question: Later, the next card forward); swipe down to put the stack away (the floating capsule then says "Needs
// you" in amber, and a tap docks it again). An answer leaves the stack at once, its Undo in the shell's toast
// (src/asks/decide.ts), and the next card comes forward from behind, deaf for 450 ms.
//
// A change ready to try, once no ask is docked, sits on the box's top edge as one object with it: an opaque card the
// box's width, its top corners rounded 24 and its foot tucked behind the box, so their outline is one. "Ready to
// ship", its title, "+38 −12 · workspace" and Later | Ship it; the Chief stands on its top edge, and its "1 of 2" is
// the count, so the floating capsule makes way while it's up. Ship it and Later leave at once too, their Undo in the
// toast (chief/decide.ts); the pair is deaf for 450 ms after a card arrives or pages.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { totals } from "../board/model";
import { yieldToBack } from "../components/edge";
import { Icon } from "../components/Icon";
import { Squish } from "../components/Squish";
import { ease, haptic, release } from "../motion";
import { BOX } from "../shell/composer/state";
import { overlayShadow, useTheme } from "../theme";
import { unseenReady } from "../store/select";
import { useStore } from "../store/store";
import { Stack, type StackItem } from "../asks/Stack";
import { type Card, cardKey } from "./cards";
import { IconButton } from "../components/ui/Button";
import { ARM_MS, Counts, Pair } from "./parts";
import { PERCH_LEFT } from "./Perch";
import { usePane } from "../shell/layout";

export type { Card } from "./cards";

/** How far a swipe goes before it decides. */
const FAR = 110;
/** How far down a swipe puts the dock away. */
const STOW = 60;
/** The dock's and the card's corner: the approval dock's. */
const CORNER = 24;
/** Not yet: the pair counts no tap until its card has arrived. */
const NEVER = Number.MAX_SAFE_INTEGER;
/** How far the Ready card's foot runs behind the box: all of it, so its foot's outline is the box's. */
const TUCK = BOX.rest;

/** "‹ 1 of 2 ›": the arrows hit at 44pt; paging re-arms the pair. */
function Pager({
  index,
  count,
  noun,
  onPage,
}: {
  index: number;
  count: number;
  noun: string;
  onPage: (next: number) => void;
}) {
  const { c, t } = useTheme();
  const arrow = {
    width: 40,
    height: 44,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", marginRight: -12, marginVertical: -11 }}
    >
      <Squish
        label={`Previous ${noun}`}
        disabled={index === 0}
        depth={0.88}
        hitSlop={2}
        onPress={() => onPage(index - 1)}
        style={arrow}
      >
        <Icon name="chevronLeft" size={16} color={c.muted} />
      </Squish>
      <Text style={[t.meta, { color: c.muted }]}>
        {index + 1} of {count}
      </Text>
      <Squish
        label={`Next ${noun}`}
        disabled={index >= count - 1}
        depth={0.88}
        hitSlop={2}
        onPress={() => onPage(index + 1)}
        style={arrow}
      >
        <Icon name="chevronRight" size={16} color={c.muted} />
      </Squish>
    </View>
  );
}

/**
 * A card that follows the thumb: right says yes, left says no, each ticking once it's far enough and flying off when
 * let go there; down (where `onStow` is given) puts it away. It arrives rising, and arms its pair once it has.
 */
function useSwipeCard({
  onDecide,
  onStow,
  armedAt,
}: {
  onDecide: (yes: boolean) => void;
  onStow?: () => void;
  armedAt: { current: number };
}) {
  const { width: screen } = usePane();
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const shown = useSharedValue(0);
  const past = useSharedValue(0);
  // 0 until the thumb has picked a way, then 1 across, 2 down.
  const axis = useSharedValue(0);
  const arm = () => {
    if (armedAt.current === NEVER) armedAt.current = Date.now() + ARM_MS;
  };
  useEffect(() => {
    armedAt.current = NEVER;
    shown.value = withTiming(1, { duration: 260, easing: ease.snap }, (done) => {
      if (done) scheduleOnRN(arm);
    });
    // A frame that never comes (a tab in the background) still arms it.
    const timer = setTimeout(arm, 400);
    return () => clearTimeout(timer);
  }, [shown]);

  const stowable = !!onStow;
  const stow = () => onStow?.();
  const pan = usePanGesture({
    activeOffsetX: [-12, 12],
    activeOffsetY: stowable ? [-10000, 14] : [-10000, 10000],
    // A swipe from the screen's left edge is Back's, never the card's (components/edge.ts).
    onBegin: (e) => {
      "worklet";
      yieldToBack(e);
    },
    onUpdate: (e) => {
      "worklet";
      if (axis.value === 0)
        axis.value = Math.abs(e.translationX) >= Math.abs(e.translationY) ? 1 : 2;
      if (axis.value === 2) {
        y.value = Math.max(0, e.translationY);
        return;
      }
      x.value = e.translationX;
      const far = Math.abs(e.translationX) > FAR ? 1 : 0;
      if (far !== past.value) {
        past.value = far;
        scheduleOnRN(haptic.tick);
      }
    },
    onDeactivate: (e) => {
      "worklet";
      if (axis.value === 2) {
        if (e.translationY > STOW || e.velocityY > 800)
          y.value = withTiming(
            260,
            { duration: 200, easing: Easing.in(Easing.quad) },
            (done) => done && scheduleOnRN(stow),
          );
        else y.value = withSpring(0, release);
      } else if (Math.abs(e.translationX) > FAR || Math.abs(e.velocityX) > 900) {
        const yes = e.translationX > 0 || (e.translationX === 0 && e.velocityX > 0);
        x.value = withTiming(
          (yes ? 1 : -1) * (screen + 40),
          { duration: 220, easing: Easing.bezier(0.55, 0, 1, 0.45) },
          (done) => done && scheduleOnRN(onDecide, yes),
        );
      } else x.value = withSpring(0, { ...release, velocity: e.velocityX });
      axis.value = 0;
      past.value = 0;
    },
  });
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, shown.value * 2),
    transform: [
      { translateX: x.value },
      { translateY: y.value + (1 - shown.value) * 40 },
      { rotate: `${x.value / 40}deg` },
    ],
  }));
  const yesHint = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [16, FAR], [0, 1], Extrapolation.CLAMP),
  }));
  const noHint = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [-FAR, -16], [1, 0], Extrapolation.CLAMP),
  }));
  return { pan, style, yesHint, noHint };
}

/** What a swipe will do, on the edge that stays on screen as the card goes its way. */
function Hints({
  yes,
  no,
  yesHint,
  noHint,
}: {
  yes: string;
  no: string;
  yesHint: object;
  noHint: object;
}) {
  const { c, t } = useTheme();
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[{ position: "absolute", top: 12, left: 16 }, yesHint]}
      >
        <Text style={[t.button, { color: c.success }]}>{yes}</Text>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[{ position: "absolute", top: 12, right: 16 }, noHint]}
      >
        <Text style={[t.button, { color: c.muted }]}>{no}</Text>
      </Animated.View>
    </>
  );
}

interface DockProps {
  /** The open asks, oldest first. */
  asks: readonly Card[];
  /** From the screen's foot. */
  bottom: number;
  /** The Chief, standing on the stack's top edge. */
  perch: ReactNode;
  /** An answer: `card.reply` carries an option or your words, when it is more than a yes or a no. */
  onDecide: (card: Card, yes: boolean) => void;
  /** "Tell it what to do instead": the box comes back, and what's sent from it turns this ask down and steers. */
  onInstead: (card: Card) => void;
  /** Swiped down: the box comes back and the ask waits in the floating capsule. */
  onStow: () => void;
  onOpen: (card: Card) => void;
  onPeek: (card: Card) => void;
  /** Bump to say the shown ask changed for the screen (the Chief hops). */
  onShown?: (key: string) => void;
  /** How tall it stands, the Chief left out, so the chat's end stays clear of it. */
  onHeight: (height: number) => void;
}

/**
 * The ask dock: in the composer's place while something its chats ask waits on you, a stack of summary cards with the
 * Chief standing on it. An answer takes its card away at once (its Undo is the toast's), and the next comes forward.
 */
export function AskDock({
  asks,
  bottom,
  perch,
  onHeight,
  onDecide,
  onInstead,
  onStow,
  onOpen,
  onPeek,
  onShown,
}: DockProps) {
  const cards = asks.filter(
    (card): card is Card & { need: NonNullable<Card["need"]> } => !!card.need,
  );
  const items: StackItem[] = cards.map((card) => ({
    key: cardKey(card),
    asker: card.chat,
    row: card.row,
    need: card.need,
  }));
  const cardOf = (item: StackItem) => cards.find((card) => cardKey(card) === item.key);
  const told = useRef(onHeight);
  told.current = onHeight;
  if (!items.length) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, bottom }}>
      <Stack
        items={items}
        surface="float"
        peek="up"
        perch={<View style={{ marginLeft: PERCH_LEFT }}>{perch}</View>}
        onReply={(item, reply) => {
          const card = cardOf(item);
          if (card) onDecide({ ...card, reply }, reply.kind !== "deny");
        }}
        onOpen={(item) => {
          const card = cardOf(item);
          if (card) onOpen(card);
        }}
        onPeek={(item) => {
          const card = cardOf(item);
          if (card) onPeek(card);
        }}
        onTell={(item) => {
          const card = cardOf(item);
          if (card) onInstead(card);
        }}
        onStow={onStow}
        onShown={onShown}
        onHeight={(h) => told.current(h)}
      />
    </View>
  );
}

interface ReadyProps {
  /** The changes ready to try that aren't put off, newest decisions left out. */
  cards: readonly Card[];
  /** The Chief, standing on the card's top edge. */
  perch?: ReactNode;
  onDecide: (card: Card, yes: boolean) => void;
  onOpen: (card: Card) => void;
}

/**
 * "Ready to ship": a change to try, riding on the box (Composer `above`) so it sits on the box's top edge with no gap,
 * its foot behind the box, and the box's band (ProgressiveEdge BottomEdge) under it. Ship it and Later take it away at
 * once, their Undo in the toast.
 */
export function ReadyCard({ cards, perch, ...rest }: ReadyProps) {
  if (!cards.length) return null;
  return (
    // The box's own gap over its top, and the box's height, run behind the box.
    <View pointerEvents="box-none" style={{ marginBottom: -(BOX.above + TUCK) }}>
      {perch ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: PERCH_LEFT,
            bottom: "100%",
            transform: [{ translateY: 6 }],
          }}
        >
          {perch}
        </View>
      ) : null}
      <ReadyBody cards={cards} {...rest} />
    </View>
  );
}

function ReadyBody({ cards, onDecide, onOpen }: Pick<ReadyProps, "cards" | "onDecide" | "onOpen">) {
  const { c, t, dark } = useTheme();
  // Opaque, one outline: its top corners the dock's, its foot the box's own corners, so behind the box the two edges
  // are one.
  const surface = {
    backgroundColor: c.card,
    borderTopLeftRadius: CORNER,
    borderTopRightRadius: CORNER,
    borderBottomLeftRadius: BOX.radius,
    borderBottomRightRadius: BOX.radius,
    borderWidth: 1,
    borderColor: c.edge,
    ...overlayShadow(dark),
  } as const;
  const [page, setPage] = useState(0);
  const index = Math.min(page, cards.length - 1);
  const card = cards[index] as Card;
  const key = cardKey(card);
  const armedAt = useRef(NEVER);
  const decide = (yes: boolean) => {
    if (yes) haptic.thud();
    else haptic.tap();
    onDecide(card, yes);
  };
  const { pan, style, yesHint, noHint } = useSwipeCard({ onDecide: decide, armedAt });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    armedAt.current = Date.now() + ARM_MS;
  }, [key]);
  const pageTo = (next: number) => {
    haptic.tick();
    setPage(Math.max(0, Math.min(cards.length - 1, next)));
  };
  const sum = card.chat.moment ? totals(card.chat.moment.files) : { add: 0, del: 0 };
  // Looked at already: still to ship, so the card stays, but it isn't new, and no "ready" count counts it.
  const seen = useStore(
    (s) => !unseenReady({ chat: card.chat, phase: "ready", chief: null }, s.inbox),
  );
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        accessibilityLabel={`Ready to ship: ${card.chat.title}`}
        accessibilityActions={[
          { name: "ship", label: "Ship it" },
          { name: "later", label: "Later" },
          ...(index < cards.length - 1 ? [{ name: "next", label: "Next change" }] : []),
          ...(index > 0 ? [{ name: "previous", label: "Previous change" }] : []),
        ]}
        onAccessibilityAction={(e) => {
          const name = e.nativeEvent.actionName;
          if (name === "ship") decide(true);
          else if (name === "later") decide(false);
          else if (name === "next") pageTo(index + 1);
          else if (name === "previous") pageTo(index - 1);
        }}
        style={[{ padding: 14, paddingTop: 10, paddingBottom: 14 + TUCK }, surface, style]}
      >
        <Hints yes="Ship" no="Later" yesHint={yesHint} noHint={noHint} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 }}>
          <Text style={[t.label, { flex: 1, color: c.muted }]}>
            {seen ? "Ready to ship · seen" : "Ready to ship"}
          </Text>
          {cards.length > 1 ? (
            <Pager index={index} count={cards.length} noun="change" onPage={pageTo} />
          ) : null}
        </View>
 {/* The change, and on its right a bare arrow that opens it ("a button ... on the right hand
            side that makes it more obvious it can be clicked", then "just like a subtle icon ... no depth nothing"): the
            hold menu's Open glyph in grey, no fill, no edge. The words open it too. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4 }}>
          <Pressable
            accessible={false}
            onPress={() => onOpen(card)}
            hitSlop={{ top: 6, bottom: 6 }}
            style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.6 : 1 })}
          >
            <Text
              numberOfLines={1}
              style={[t.heading, { fontSize: 17, lineHeight: 22, fontWeight: "600" }]}
            >
              {card.chat.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
              <Counts add={sum.add} del={sum.del} size={13} />
              <Text numberOfLines={1} style={[t.small, { flexShrink: 1, color: c.muted }]}>
                {sum.add || sum.del ? "· " : ""}
                {card.chat.repo}
              </Text>
            </View>
          </Pressable>
          <View style={{ marginRight: -10 }}>
            <IconButton
              icon="open"
              label={`Review ${card.chat.title}`}
              size={20}
              onPress={() => onOpen(card)}
            />
          </View>
        </View>
        <View style={{ marginTop: 12 }}>
          <Pair kind="ready" onDecide={decide} armedAt={armedAt} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}
