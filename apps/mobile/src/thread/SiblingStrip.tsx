// The way up and across a parent's subagents, in a subagent's floating row (DECISIONS.md Gaps, "The sibling tab strip";
// the founder's "easy navigation from subagents to parent agents" and "liquid glass tabs above the search bar to
// manage the subagents and go back"). At the left, always in view, a 44pt glass circle up to the parent: "↑" over its
// engine mark, mirroring the jump circle at the right. Between them one 44pt chip per sibling, scrolling sideways: its
// state as a glyph (an amber dot needs you, the turning ring works, a green check is ready or done) and its name
// without the parent's lead-in or a leading article ("State", "Thread", "Composer"). The one you're in is lit, a `text`
// fill at 12% in full ink (Search's "All" chip), the rest glass in the description grey; the fill slides to the chip
// you pick. An end with more chips past it fades out rather than cutting a word in half, and the strip moves only when
// the chips overflow, keeping the one you're in whole with a little of each neighbour showing. A sibling replaces this
// screen, so the stack stays Home, parent, child and Back still lands on the parent where you left it; the strip
// remembers where it was scrolled and which chip was lit, so the next screen's strip starts there and slides on.
import { type ComponentRef, useLayoutEffect, useRef, useState } from "react";
import { Platform, ScrollView, Text, View, type ViewStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { Chat } from "../board/model";
import { Glass } from "../components/Glass";
import { Icon } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { shortTitle } from "../components/transcript/Parts";
import { VendorMark } from "../components/ui/EngineLogo";
import { useReducedMotion } from "../motion";
import { alpha, FLOAT_TYPE, layout, useTheme } from "../theme";

const F = layout.float;
const GAP = layout.floatGap;
/** A chip's name stops about here (13 characters at 15pt). */
const TITLE_MAX = 104;
/** How much of each neighbour stays in view beside the chip you're in. */
const PEEK = 24;
/** The fade at an end with more chips past it. */
const FADE = 16;
/** The lit fill sliding to the chip you picked. */
const SLIDE_MS = 200;
const OUT = Easing.bezier(0.33, 1, 0.68, 1);

const STATE_WORD: Record<Chat["phase"], string> = { needs: "needs you", working: "working", ready: "ready", done: "done" };

/** Where each parent's strip was scrolled and which chip was lit, so the next sibling's screen picks it up. */
const memory = new Map<string, { x: number; fill: { x: number; w: number } | null }>();

/** A sibling's name: no parent lead-in ("Audit: the thread"), no leading article: "Thread". */
export function siblingName(title: string): string {
  const rest = shortTitle(title).replace(/^(the|a|an)\s+/i, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** A sibling's state: an amber dot, the turning ring, a green check. */
function StateMark({ phase }: { phase: Chat["phase"] }) {
  const { c } = useTheme();
  const still = useReducedMotion();
  if (phase === "needs") return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.warning }} />;
  if (phase === "working") return <PixelIcon name="state-working" size={16} animate={!still} />;
  return <Icon name="check" size={13} stroke={2.25} color={c.success} />;
}

function Chip({ label, selected, onPress, onLayout, children }: { label: string; selected: boolean; onPress: () => void; onLayout: (x: number, w: number) => void; children: React.ReactNode }) {
  const body = <View style={{ height: F, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 }}>{children}</View>;
  return (
    <View onLayout={(e) => onLayout(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}>
      <Squish label={label} selected={selected} onPress={onPress} depth={0.95} hitSlop={2}>
        {/* The one you're in stands on the lit fill under the strip, not on glass: it is where you are. */}
        {selected ? body : <Glass interactive style={{ height: F, borderRadius: F / 2 }}>{body}</Glass>}
      </Squish>
    </View>
  );
}

/** Up to the parent: a glass circle, "↑" over its engine mark. */
function ParentCircle({ parent, onPress }: { parent: Chat; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Squish label={`Parent: ${parent.title}`} onPress={onPress} depth={0.88} hitSlop={4}>
      <Glass interactive style={{ width: F, height: F, borderRadius: F / 2, alignItems: "center", justifyContent: "center", gap: 1 }}>
        <Icon name="parent" size={16} color={c.text} />
        <VendorMark engine={parent.engine} model={parent.model} size={12} />
      </Glass>
    </Squish>
  );
}

/** On the web, the ends that have more past them fade out instead of cutting a chip off. */
function fades(start: boolean, end: boolean): ViewStyle | null {
  if (Platform.OS !== "web" || (!start && !end)) return null;
  const mask = `linear-gradient(to right, ${start ? `transparent 0, #000 ${FADE}px` : "#000 0"}, ${end ? `#000 calc(100% - ${FADE}px), transparent 100%` : "#000 100%"})`;
  return { maskImage: mask, WebkitMaskImage: mask } as ViewStyle;
}

export function SiblingStrip({ parent, siblings, current, onParent, onSibling }: { parent: Chat; siblings: readonly Chat[]; current: string; onParent: () => void; onSibling: (id: string) => void }) {
  const { c, t } = useTheme();
  const still = useReducedMotion();
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const spots = useRef(new Map<string, { x: number; w: number }>());
  const room = useRef(0);
  const wide = useRef(0);
  const [kept] = useState(() => memory.get(parent.id));
  const offset = useRef(kept?.x ?? 0);
  const [ends, setEnds] = useState({ start: offset.current > 0.5, end: false });
  const fillX = useSharedValue(kept?.fill?.x ?? 0);
  const fillW = useSharedValue(kept?.fill?.w ?? 0);
  const lit = useRef<string | null>(null);
  const word = { ...t.button, fontSize: 15, lineHeight: 20, maxWidth: TITLE_MAX };

  const remember = () => {
    const was = memory.get(parent.id);
    memory.set(parent.id, { x: offset.current, fill: was?.fill ?? null });
  };
  const edges = () => {
    const next = { start: offset.current > 0.5, end: offset.current + room.current < wide.current - 0.5 };
    setEnds((was) => (was.start === next.start && was.end === next.end ? was : next));
  };
  const scrollTo = (x: number, animated: boolean) => {
    offset.current = x;
    scroller.current?.scrollTo({ x, animated });
    edges();
    remember();
  };

  // Where it was on the screen before: set before the first paint, so it never shows at the start and then snaps.
  useLayoutEffect(() => {
    if (!kept?.x) return;
    const node = Platform.OS === "web" ? (scroller.current?.getScrollableNode?.() as unknown as HTMLElement | undefined) : undefined;
    if (node) node.scrollLeft = kept.x;
    else scroller.current?.scrollTo({ x: kept.x, animated: false });
    // Once, as it mounts.
  }, []);

  /** The chip you're in, whole, with some of each neighbour; only when the chips overflow, and only as far as that takes. */
  const reveal = (animated: boolean) => {
    const spot = spots.current.get(current);
    if (!spot || !room.current || !wide.current) return;
    if (wide.current <= room.current + 0.5) {
      if (offset.current > 0.5) scrollTo(0, animated);
      else edges();
      return;
    }
    const index = siblings.findIndex((k) => k.id === current);
    const from = index > 0 ? spot.x - GAP - PEEK : 0;
    const to = index < siblings.length - 1 ? spot.x + spot.w + GAP + PEEK : wide.current;
    let x = offset.current;
    if (x > from) x = from;
    if (x + room.current < to) x = to - room.current;
    x = Math.max(0, Math.min(x, wide.current - room.current));
    if (Math.abs(x - offset.current) > 0.5) scrollTo(x, animated && !still);
    else edges();
  };
  /** The lit fill onto the chip you're in: sliding from where it was lit before, or there at once the first time. */
  const light = () => {
    const spot = spots.current.get(current);
    if (!spot || lit.current === current) return;
    const first = lit.current === null;
    lit.current = current;
    if ((first && !kept?.fill) || still) {
      fillX.value = spot.x;
      fillW.value = spot.w;
    } else {
      fillX.value = withTiming(spot.x, { duration: SLIDE_MS, easing: OUT });
      fillW.value = withTiming(spot.w, { duration: SLIDE_MS, easing: OUT });
    }
    memory.set(parent.id, { x: offset.current, fill: { x: spot.x, w: spot.w } });
  };
  const fill = useAnimatedStyle(() => ({ left: fillX.value, width: fillW.value, opacity: fillW.value > 0 ? 1 : 0 }));

  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: GAP }}>
      <ParentCircle parent={parent} onPress={onParent} />
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e) => {
          offset.current = e.nativeEvent.contentOffset.x;
          edges();
          remember();
        }}
        onLayout={(e) => {
          room.current = e.nativeEvent.layout.width;
          reveal(true);
        }}
        onContentSizeChange={(w) => {
          wide.current = w;
          reveal(true);
        }}
        style={[{ flexGrow: 1, flexShrink: 1, minWidth: 0 }, fades(ends.start, ends.end)]}
        contentContainerStyle={{ gap: GAP, alignItems: "center" }}
      >
        <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, height: F, borderRadius: F / 2, backgroundColor: alpha(c.text, 0.12) }, fill]} />
        {siblings.map((kid) => {
          const here = kid.id === current;
          const name = siblingName(kid.title);
          return (
            <Chip
              key={kid.id}
              label={`${name}, ${STATE_WORD[kid.phase]}${here ? ", you're here" : ""}`}
              selected={here}
              onPress={() => (here ? undefined : onSibling(kid.id))}
              onLayout={(x, w) => {
                spots.current.set(kid.id, { x, w });
                if (here) {
                  light();
                  reveal(true);
                }
              }}
            >
              <StateMark phase={kid.phase} />
              <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[word, { color: here ? c.text : c.muted }]}>
                {name}
              </Text>
            </Chip>
          );
        })}
      </ScrollView>
    </View>
  );
}
