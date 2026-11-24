// The Chief's chat, folded the way a chat folds (DECISIONS.md, "A Chief's chat"; thread-C s4). Each note of yours is a
// turn: your bubble, then, when it said something on the way, "Worked for 1m 20s ›" with the turn's one hairline
// running out beside it (as a thread draws it: no line when there's nothing under it), then its answer. The chats it
// started for you ("Started 3 chats ⌄") stay in view, outside the fold, until every one of them is done. News it brings
// up on its own sits under an "Update · 12:04" head, so it never reads as part of the answer above it. Two lines more
// than half an hour apart get a centred date line.
//
// It stays calm however long the morning was (Codex's way; the founder's "zen"): you land on the latest Update or turn
// and what came after it, and everything before waits under "⌃ Earlier · N updates". A newer Update folds the older
// ones away. An Update counts in one plain sentence ("One needs you, three are running.") and names its chats as rows
// under it, the way "Started 3 chats" does; "X is ready to try" after a roll call that already shows X as Ready is left
// out. The gaps are the chat's rhythm (theme.ts `rhythm`), the same as a thread's.
//
// A chat it names in its words ([[id]]) is the work-link pill at most once a sentence and once a screen: a chat already
// shown (a roster's row, the dock, or earlier) is named in its own ink at 500 with its engine mark, still a tap away,
// so a paragraph never turns into a wall of blue. A roster's rows are never pills: each is a row in ink. A tap pushes that chat over the Chief, so Back returns here; a long
// press peeks. Its newest words arrive a word at a time.
//
// While a sheet is up over it, the chat holds still: the room at its foot doesn't change under the sheet, and when the
// sheet goes it is where it was (or at the end, if it was at the end).
//
// It moves with the box at its foot as one, as a chat's feed does (screens/Thread.tsx, shell/composer/place.ts): the
// room at its foot is only what the resting box needs, and as the keyboard or the `+` menu rises under the box, or the
// card opens and grows, the whole chat rides up with it on the UI thread, as far as the box rises past the empty room
// under its last line. A short chat doesn't move; a long one at its end rides up exactly with the box.
import * as Clipboard from "expo-clipboard";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, Platform, Pressable, ScrollView, type ScrollViewInstance, Text, View } from "react-native";
import Animated, { Easing, type SharedValue, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import type { Chat, Said } from "../board/model";
import { Glass } from "../components/Glass";
import { Icon } from "../components/Icon";
import { Squish } from "../components/Squish";
import { YouBubble } from "../components/Transcript";
import { Shimmer } from "../components/transcript/Shimmer";
import { AnchorFlash } from "../components/ui/AnchorFlash";
import { IconButton } from "../components/ui/Button";
import { GoneLink, WorkLink } from "../components/ui/WorkLink";
import { duration as ms, ease, enter, haptic, layout as glide } from "../motion";
import { blankOf, RIDE_MS, rideOf, useChatLift, useRise } from "../shell/composer/place";
import { setAnchor, setFold, useAnchor, useFolds } from "../store/sessions";
import { phaseOf } from "../store/select";
import { rhythm, useTheme } from "../theme";
import { Mention, Roster } from "./Roster";
import { blocksOf, clockOf, dateLine, duration, earlierLabel, echoOf, GAP_MS, pillsOf, rosterIds, type Segment, segmentsOf, spoken, startedBy, tallyOf, windowStart } from "./turns";

/** A note this new rises from the box when it first shows. */
const RISE_MS = 1500;
const WORD_MS = 42;
/** A chat it started counts as done once it is ready or done. */
const SETTLED = new Set(["ready", "done"]);
/** Scrolled further than this from the end, you're reading back: new lines don't pull you down. */
const AWAY = 120;
/** The room under the last line changing while the chat rides the box eases on the ride's own curve (place.ts RIDE_MS). */
const EASE_OUT = Easing.out(Easing.quad);

/**
 * Which of its lines answered a note of yours, seen as its thought bubble went (its news can land while it thinks, and
 * is not the answer). Kept for the session; the runtime's lines will carry their turn instead.
 */
const ANSWERS = new Map<number, number>();

/** How many of a line's words have arrived by now, so reopening the screen never replays it. */
function useArrived(count: number, at: number) {
  const now = () => Math.min(count, Math.floor((Date.now() - at) / WORD_MS));
  const [shown, setShown] = useState(now);
  useEffect(() => {
    if (shown >= count) return;
    const timer = setInterval(() => {
      const next = now();
      setShown(next);
      if (next >= count) clearInterval(timer);
    }, WORD_MS);
    return () => clearInterval(timer);
    // `now` reads only count and at.
  }, [count, at]);
  return shown;
}

type Part = { word: string } | { ref: string };

const partsOf = (text: string): Part[] =>
  text.split(/(\[\[[\w-]+\]\])/).flatMap((part): Part[] => {
    const ref = /^\[\[([\w-]+)\]\]$/.exec(part);
    return ref
      ? [{ ref: ref[1] as string }]
      : part
          .split(/(\s+)/)
          .filter(Boolean)
          .map((word) => ({ word }));
  });

type Item = { kind: "prose"; text: string; parts: Part[]; tally?: string[] } | { kind: "roster"; ids: string[] };

/** A line's blocks as drawn: each roll call's count ends the words before it (or stands alone), then its rows. */
function itemsOf(text: string): Item[] {
  const out: Item[] = [];
  for (const block of blocksOf(text)) {
    if (block.kind === "prose") {
      out.push({ ...block, parts: partsOf(block.text) });
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === "prose" && !last.tally) last.tally = block.ids;
    else out.push({ kind: "prose", text: "", parts: [], tally: block.ids });
    out.push(block);
  }
  return out;
}

/**
 * One line of the Chief's: its words, then any roll call, counted at the end of the words and named in roster rows.
 * `pills` says, for each chat its words name in order, whether it gets the pill or is named plainly (turns.ts pillsOf).
 */
function ChiefLine({ line, chats, pills, onOpen, onPeek }: { line: Said; chats: readonly Chat[]; pills?: readonly boolean[]; onOpen: (id: string) => void; onPeek: (id: string) => void }) {
  const { t } = useTheme();
  const items = useMemo(() => itemsOf(line.text), [line.text]);
  // Words, named chats, a roll call's count and its rows, in order; each counts as one as it arrives.
  const units = items.reduce((n, b) => n + (b.kind === "prose" ? b.parts.filter((p) => !("word" in p) || !/^\s+$/.test(p.word)).length + (b.tally ? 1 : 0) : b.ids.length), 0);
  const arrived = useArrived(units, line.at);
  let seen = 0;
  let refAt = 0;
  return (
    <View style={{ gap: 8 }}>
      {items.map((block, bi) => {
        if (seen >= arrived) return null;
        if (block.kind === "roster") {
          const rows = block.ids.slice(0, arrived - seen).flatMap((id) => {
            const chat = chats.find((ch) => ch.id === id);
            return chat ? [chat] : [];
          });
          seen += block.ids.length;
          return rows.length ? <Roster key={bi} chats={rows} board={chats} open bare onOpen={onOpen} onPeek={onPeek} /> : null;
        }
        // The count is read now, from where its chats stand, so it never disagrees with its rows.
        const tally = block.tally ? tallyOf(block.tally, chats) : null;
        // A screen reader hears the words as one sentence; the chats they name are its actions (open, or peek).
        const named = [...new Set(block.parts.flatMap((p) => ("ref" in p ? [p.ref] : [])))].flatMap((id) => {
          const chat = chats.find((ch) => ch.id === id);
          return chat ? [chat] : [];
        });
        const words = block.parts.map((part, i) => {
          const space = "word" in part && /^\s+$/.test(part.word);
          if (!space) seen += 1;
          if (seen > arrived) return null;
          if ("word" in part) return part.word;
          const pill = pills?.[refAt] ?? true;
          refAt += 1;
          const chat = chats.find((ch) => ch.id === part.ref);
          if (!chat) return <GoneLink key={i} inline />;
          return pill ? <WorkLink key={i} chat={chat} onOpen={onOpen} onPeek={onPeek} inline /> : <Mention key={i} chat={chat} onOpen={onOpen} onPeek={onPeek} inline />;
        });
        if (tally) seen += 1;
        return (
          <Text
            key={bi}
            accessibilityLabel={[spoken(block.text, chats), tally].filter(Boolean).join(" ")}
            accessibilityActions={named.flatMap((chat) => [
              { name: `open:${chat.id}`, label: `Open ${chat.title}` },
              { name: `peek:${chat.id}`, label: `Peek at ${chat.title}` },
            ])}
            onAccessibilityAction={(e) => {
              const [verb, id] = e.nativeEvent.actionName.split(":");
              if (id) (verb === "peek" ? onPeek : onOpen)(id);
            }}
            style={t.prose}
          >
            {words}
            {tally && seen <= arrived ? `${block.parts.length ? " " : ""}${tally}` : null}
          </Text>
        );
      })}
    </View>
  );
}

/** "Worked for 2m 38s ›" with the turn's one hairline running out to the right on the same line. */
function TurnLine({ ms: took, open, onToggle }: { ms: number; open: boolean; onToggle: () => void }) {
  const { c, t } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 24 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Worked for ${duration(took)}. ${open ? "Hide" : "Show"} what it said on the way`}
        hitSlop={12}
        onPress={() => {
          haptic.tick();
          onToggle();
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        <Text style={[t.body, { fontSize: 15, lineHeight: 20, color: c.muted }]}>
          Worked for <Text style={{ fontVariant: ["tabular-nums"] }}>{duration(took)}</Text>
        </Text>
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevronRight" size={14} color={c.muted} />
        </View>
      </Pressable>
      <View style={{ flex: 1, height: 1, backgroundColor: c.hairline }} />
    </View>
  );
}

/** A turn under way, where its "Worked for" will stand: the desktop's shimmering "Working for", then its clock. */
function Working({ since }: { since: number }) {
  const { c, t } = useTheme();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const style = [t.body, { fontSize: 15, lineHeight: 20, color: c.muted }];
  return (
    <Animated.View entering={enter.fade} accessibilityRole="text" accessibilityLabel="Working" style={{ flexDirection: "row", minHeight: 24, alignItems: "center" }}>
      <Shimmer text="Working for" style={style} />
      <Text style={[style, { fontVariant: ["tabular-nums"] }]}> {duration(now - since)}</Text>
    </Animated.View>
  );
}

/** A centred quiet line: a date between lines far apart, or where a call ended. */
function Centred({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 18 }}>
      {children}
    </View>
  );
}

/** "Update · 12:04": news it brought up on its own, at the same quiet weight as "Worked for". */
function UpdateHead({ at, time }: { at: number; time: boolean }) {
  const { c, t } = useTheme();
  return (
    <Text accessibilityRole="header" style={[t.body, { fontSize: 15, lineHeight: 20, color: c.muted }]}>
      Update
      {time ? <Text style={{ color: c.subtle, fontVariant: ["tabular-nums"] }}> · {clockOf(at)}</Text> : null}
    </Text>
  );
}

/** Copy, then the time: on the latest answer only (DECISIONS.md, "Action row"). */
function Actions({ text, at }: { text: string; at: number }) {
  const { c, t } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginLeft: -12, marginTop: rhythm.changesToActions - 10 }}>
      <IconButton
        icon="copy"
        label="Copy"
        size={18}
        color={c.subtle}
        onPress={() => {
          haptic.tick();
          void Clipboard.setStringAsync(text);
        }}
      />
      <Text style={[t.meta, { marginLeft: 2 }]}>{clockOf(at)}</Text>
    </View>
  );
}

/** "⌃ Earlier · 6 updates": a flat centred text button at the top of what's loaded. */
function Earlier({ label, onPress }: { label: string; onPress: () => void }) {
  const { c, t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${label} from earlier`}
      onPress={() => {
        haptic.tick();
        onPress();
      }}
      // Its words sit where the first line would (16 to 24 under the bar); the 44pt target reaches up past them.
      style={({ pressed }) => ({ flexDirection: "row", alignSelf: "center", alignItems: "center", gap: 6, minHeight: 44, marginTop: -12, paddingHorizontal: 12, opacity: pressed ? 0.6 : 1 })}
    >
      <Icon name="chevronUp" size={14} color={c.muted} />
      <Text style={[t.body, { fontSize: 15, lineHeight: 20, color: c.muted }]}>Earlier · {label}</Text>
    </Pressable>
  );
}

const lastAt = (seg: Segment) => (seg.kind === "exchange" ? (seg.reply?.at ?? seg.note.at) : seg.kind === "update" ? (seg.lines.at(-1)?.at ?? seg.at) : seg.at);

/** An Update's lines worth drawing: "X is ready to try" goes when a roll call above it in the same Update shows X. */
function linesOf(seg: Extract<Segment, { kind: "update" }>): Said[] {
  const called = new Set<string>();
  return seg.lines.filter((l) => {
    const echo = echoOf(l.text);
    if (echo && called.has(echo)) return false;
    for (const id of rosterIds(l.text)) called.add(id);
    return true;
  });
}

interface Props {
  said: readonly Said[];
  chats: readonly Chat[];
  /** What it's working out right now (its thought bubble), if anything. */
  thinking: string | null;
  /** Where its folds are kept (store/sessions.ts chiefScope). */
  scope: string;
  onOpen: (id: string) => void;
  onPeek: (id: string) => void;
  top: number;
  bottom: number;
  /** Faded back while something else is in front of it (a call): it takes no touches then. */
  dim: number;
  /** Bump to go to the latest line. */
  jump: number;
  /** Told when you scroll back from the latest line, and when you come back to it. */
  onAway: (away: boolean) => void;
  /** The chats the dock and the Ready card show: named plainly in the words, never as a second pill. */
  docked?: readonly string[];
  /** A sheet is up over it: it holds still, and comes back where it was. */
  frozen?: boolean;
  /** What shows when it has said nothing yet. */
  empty?: ReactNode;
  /** How far it has scrolled, for the bar's edge (components/ProgressiveEdge.tsx). */
  edgeY?: SharedValue<number>;
}

export function ChiefChat({ said, chats, thinking, scope, onOpen, onPeek, top, bottom, dim, jump, onAway, docked = [], frozen = false, empty, edgeY }: Props) {
  const { c, t } = useTheme();
  const scroll = useRef<ScrollViewInstance>(null);
  const away = useRef(false);
  const scrollY = useRef(0);
  // How far the view is from the very end: 0 when it shows the last line.
  const endGap = useRef(0);
  const folds = useFolds(scope);
  // What came before the latest turn opens for this visit only: you land on the latest turn every time (DECISIONS O9).
  const [earlier, setEarlier] = useState(false);

  // The note it's on: your last, while its thought bubble is up and no answer has been seen for it.
  const note = said.findLast((line) => line.who === "you");
  const working = thinking && note && !ANSWERS.has(note.id) ? note.id : null;
 // A note you send brings you back to the end to see it land and its answer come, even from reading back (upstream
  // ChatView on a send).
  const sent = useRef(note?.id);
  useEffect(() => {
    if (note?.id === sent.current) return;
    sent.current = note?.id;
    if (!away.current || frozen) return;
    away.current = false;
    onAway(false);
    scroll.current?.scrollToEnd({ animated: true });
  }, [note?.id]);
  // Its turn ends as its thought bubble goes: the line it says then is its answer to your last note.
  const was = useRef(working);
  const [marked, mark] = useState(0);
  useEffect(() => {
    if (was.current !== null && working === null) {
      const answer = said.findLast((line) => line.who === "chief");
      if (answer && answer.at >= (note?.at ?? 0) && !ANSWERS.has(was.current)) {
        ANSWERS.set(was.current, answer.id);
        mark((n) => n + 1);
      }
    }
    was.current = working;
  }, [working, said, note]);

  const segments = useMemo(() => segmentsOf(said, ANSWERS, working), [said, working, marked]);

  // A search hit lands here (shell/SearchSheet.tsx sets the scope's anchor to "said:<id>"): the turn or Update that
  // holds the line pages in if it is before the window, opens if the line is folded in it, and is scrolled to once; the
  // line itself is lit for 1.2s, as a thread lights its hit.
  const anchor = useAnchor(scope);
  const landing = useRef<string | null>(null);
  // The line it landed on, lit with the thread's 1.2s tint (components/ui/AnchorFlash.tsx).
  const [flashed, setFlashed] = useState<number | null>(null);
  const unflash = useRef<ReturnType<typeof setTimeout>>(undefined);
  const target = useMemo(() => {
    const id = anchor?.row.startsWith("said:") ? Number(anchor.row.slice(5)) : NaN;
    if (Number.isNaN(id)) return null;
    const index = segments.findIndex((seg) => (seg.kind === "exchange" ? seg.note.id === id || seg.reply?.id === id || seg.between.some((l) => l.id === id) : seg.kind === "update" ? seg.lines.some((l) => l.id === id) : seg.line.id === id));
    const seg = segments[index];
    return seg ? { index, key: seg.key, id, folded: seg.kind === "exchange" && seg.between.some((l) => l.id === id) } : null;
  }, [anchor?.row, segments]);
  useEffect(() => {
    if (!target) return;
    landing.current = target.key;
    // It stops following the end at once, so nothing scrolls it there before the line has landed.
    first.current = false;
    away.current = true;
    onAway(true);
    if (target.folded) setFold(scope, `turn:${target.key}`, true);
    if (target.index < windowStart(segments, working)) setEarlier(true);
    setFlashed(target.id);
    clearTimeout(unflash.current);
    unflash.current = setTimeout(() => setFlashed(null), 1800);
    setAnchor(scope, null);
  }, [target?.key]);
  const land = (key: string) =>
    landing.current === key
      ? {
          onLayout: (e: { nativeEvent: { layout: { y: number } } }) => {
            if (landing.current !== key) return;
            landing.current = null;
            // Just under the bar that floats over the top of the chat.
            const y = Math.max(0, e.nativeEvent.layout.y - top - 12);
            requestAnimationFrame(() => scroll.current?.scrollTo({ y, animated: false }));
          },
        }
      : null;

  const from = earlier ? 0 : windowStart(segments, working);
  const shown = segments.slice(from);
  // The action row goes under the latest answer only while nothing has come after it.
  const latest = segments.at(-1)?.kind === "exchange" ? segments.at(-1) : null;

  const settledAll = (seg: Extract<Segment, { kind: "exchange" }>) => startedBy(seg, chats).every((ch) => SETTLED.has(phaseOf(ch, chats)));
  const turnOpen = (key: string) => folds[`turn:${key}`] === true;
  const toggle = (key: string) => setFold(scope, `turn:${key}`, turnOpen(key) ? null : true);
  const rosterOpen = (key: string) => folds[`kids:${key}`] !== false;

  // Which named chats get the pill, top to bottom as the screen shows them, so each chat shows once. In each part, its
  // rosters claim their chats first (a row is where a chat stands); the words around them, and any chat the dock or the
  // Ready card shows, name them plainly; after that, once a sentence for a chat not yet on the screen.
  const plan = useMemo(() => {
    const pilled = new Set<string>();
    const lines = new Map<number, boolean[]>();
    for (const seg of shown) {
      if (seg.kind === "call") continue;
      const rosters: [string, string[]][] = [];
      const words: Said[] = [];
      const add = (l: Said) => {
        const ids = rosterIds(l.text);
        if (ids.length) rosters.push([`l${l.id}`, ids]);
        words.push(l);
      };
      if (seg.kind === "update") linesOf(seg).forEach(add);
      else {
        const open = turnOpen(seg.key);
        const started = startedBy(seg, chats);
        if (started.length && (open || !settledAll(seg))) rosters.push([`kids:${seg.key}`, started.map((ch) => ch.id)]);
        [...(open ? seg.between : []), ...(seg.reply ? [seg.reply] : [])].forEach(add);
      }
      for (const [, ids] of rosters) for (const id of ids) pilled.add(id);
      const onScreen = new Set([...pilled, ...docked]);
      for (const l of words) {
        const before = new Set(onScreen);
        lines.set(l.id, pillsOf(l.text, onScreen));
        for (const id of onScreen) if (!before.has(id)) pilled.add(id);
      }
    }
    return { lines };
  }, [shown.map((s) => s.key).join(), said, chats, folds, docked.join()]);
  const line = (l: Said) => (
    <AnchorFlash on={l.id === flashed}>
      <ChiefLine line={l} chats={chats} pills={plan.lines.get(l.id)} onOpen={onOpen} onPeek={onPeek} />
    </AnchorFlash>
  );

  // It fades back, and forward again, on the swift curve rather than jumping (it holds no Glass, so it may fade).
  const fade = useAnimatedStyle(() => ({ opacity: withTiming(dim, { duration: ms.base, easing: ease.swift }) }), [dim]);

  // Under a sheet it holds still: the room at its foot stays what it was, and it doesn't follow new lines down.
  const held = useRef<{ bottom: number; y: number; atEnd: boolean } | null>(null);
  if (frozen && !held.current) held.current = { bottom, y: scrollY.current, atEnd: endGap.current < 2 };
  const pad = frozen && held.current ? held.current.bottom : bottom;
  const toEnd = (animated: boolean) => scroll.current?.scrollToEnd({ animated });
  useEffect(() => {
    if (frozen) return;
    const was = held.current;
    held.current = null;
    if (!was) return;
    // Back where it was, to the point: at the very end if it was there (what landed under the sheet comes into view),
    // else the same spot.
    requestAnimationFrame(() => (was.atEnd ? toEnd(false) : scroll.current?.scrollTo({ y: was.y, animated: false })));
  }, [frozen]);
  // Room at the foot changed (an ask docked, the box grew): the last line stays in view above it.
  useEffect(() => {
    if (!away.current && !frozen) setTimeout(() => toEnd(true), 30);
  }, [pad]);
  useEffect(() => {
    if (!jump) return;
    away.current = false;
    onAway(false);
    toEnd(true);
  }, [jump]);

  // ---------- riding the box (shell/composer/place.ts) ----------
  const { lift: boxLift, hold: holdRide, release: releaseRide } = useChatLift(scope);
  /** The empty room between the last line and the box's resting top, at the end, on the UI thread. */
  const blank = useSharedValue(0);
  const blankAt = useRef(0);
  // The chat's height without the room at its foot, which is added as it stands now: a browser hears nothing when only
  // that room changes (its ScrollView measures what is inside its padding).
  const sizes = useRef({ view: 0, inner: 0 });
  const padNow = useRef(pad);
  padNow.current = pad;
  /** Measured again while you are at the end and nothing covers it; reading back, or under a sheet, it holds. */
  const measureBlank = () => {
    const { view, inner } = sizes.current;
    if (away.current || frozen || view <= 0) return;
    const next = blankOf(0, view, inner + padNow.current);
    if (Math.abs(next - blankAt.current) < 0.5) return;
    blankAt.current = next;
    scheduleOnUI(() => {
      "worklet";
      const riding = rideOf(boxLift.value, blank.value) > 0.5 || rideOf(boxLift.value, next) > 0.5;
      blank.value = riding ? withTiming(next, { duration: RIDE_MS, easing: EASE_OUT }) : next;
    });
  };
  const raised = useAnimatedStyle(() => ({ transform: [{ translateY: -rideOf(boxLift.value, blank.value) }] }));
  // The bar's edge reads how far the chat has gone up under it: scrolled, and raised with the box.
  const scrolledY = useSharedValue(0);
  useAnimatedReaction(
    () => scrolledY.value + rideOf(boxLift.value, blank.value),
    (y) => {
      if (edgeY) edgeY.value = y;
    },
    [edgeY],
  );
  // On iOS a raised chat keeps the room it rides up by over its top, so its first lines still scroll into view under
  // the bar; only one that fills its screen, as a shorter one would rest pushed down into that room.
  const rise = useRise(scope);
  const reachTop = Platform.OS === "ios" && sizes.current.inner + pad >= sizes.current.view ? rise : 0;

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    if (frozen) return;
    scrolledY.value = contentOffset.y;
    scrollY.current = contentOffset.y;
    endGap.current = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const now = endGap.current > AWAY;
    if (now !== away.current) {
      away.current = now;
      onAway(now);
    }
    sizes.current = { ...sizes.current, view: layoutMeasurement.height };
    measureBlank();
  };
  // The room at its foot changed (an ask docked, the box back): the room under the last line with it.
  useEffect(() => {
    measureBlank();
  }, [pad]);
  const first = useRef(true);

  return (
    // Faded back, it is out of reach too: a link that barely shows can't be opened or held under a call.
    <Animated.View pointerEvents={dim < 1 ? "none" : "auto"} style={[{ flex: 1 }, fade, raised]}>
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        // It starts at the top, as a thread does: a short chat opens under the bar, never pinned to the foot with an empty
        // band over it. Once it runs past the screen it follows its end (onContentSizeChange).
        contentContainerStyle={{ paddingTop: top, paddingBottom: pad, paddingHorizontal: 16 }}
        onContentSizeChange={(_w, h) => {
          sizes.current = { ...sizes.current, inner: h - pad };
          if (first.current) {
            first.current = false;
            toEnd(false);
          } else if (!away.current && !frozen) toEnd(true);
          measureBlank();
        }}
        onLayout={(e) => {
          sizes.current = { ...sizes.current, view: e.nativeEvent.layout.height };
          measureBlank();
        }}
        onScroll={onScroll}
        scrollEventThrottle={64}
        // While a hand drags it (a phone's), it holds its ride, so the keyboard following the finger down never moves
        // the content under it; let go, it eases back onto the box.
        {...(Platform.OS === "web" ? null : { onScrollBeginDrag: holdRide, onScrollEndDrag: releaseRide, onTouchEnd: releaseRide, onTouchCancel: releaseRide })}
        {...(Platform.OS === "ios" ? { contentInset: { top: reachTop } } : null)}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {!said.length && empty ? empty : null}
        {from > 0 ? <Earlier label={earlierLabel(segments.slice(0, from))} onPress={() => setEarlier(true)} /> : null}
        {shown.map((seg, i) => {
          const prev = i === 0 ? null : shown[i - 1]!;
          // The window opens with when it was; after that, a date line only across a gap of half an hour or more.
          const dated = !prev || seg.at - lastAt(prev) > GAP_MS;
          const head = dated ? (
            <View style={{ marginTop: prev || from > 0 ? rhythm.dateAbove : 0, marginBottom: rhythm.dateBelow }}>
              <Centred label={dateLine(seg.at)}>
                <Text style={t.meta}>{dateLine(seg.at)}</Text>
              </Centred>
            </View>
          ) : null;
          const gap = dated ? 0 : rhythm.turnGap;

          if (seg.kind === "call")
            return (
              <Animated.View key={seg.key} entering={enter.fade} layout={glide} style={{ marginTop: gap }} {...land(seg.key)}>
                {head}
                <Centred label={seg.line.text}>
                  <Icon name="call" size={14} color={c.subtle} />
                  <Text style={t.meta}>{seg.line.text}</Text>
                </Centred>
              </Animated.View>
            );

          if (seg.kind === "update")
            return (
              <Animated.View key={seg.key} entering={enter.fade} layout={glide} style={{ marginTop: gap }} {...land(seg.key)}>
                {head}
                <UpdateHead at={seg.at} time={!dated} />
                {linesOf(seg).map((l, j) => (
                  <View key={l.id} style={{ marginTop: j === 0 ? rhythm.headerToProse + 4 : rhythm.paragraph }}>
                    {line(l)}
                  </View>
                ))}
              </Animated.View>
            );

          const started = startedBy(seg, chats);
          const settled = settledAll(seg);
          const folded = [...seg.between.map((l) => ({ key: `l${l.id}`, node: line(l) })), ...(started.length && settled ? [{ key: "kids", node: <Roster chats={started} board={chats} open onOpen={onOpen} onPeek={onPeek} /> }] : [])];
          const open = turnOpen(seg.key);
          const isLatest = seg === latest;
          const live = seg.note.id === working;
          // As a thread draws it: a "Worked for" line only when something is folded under it.
          const turnLine = seg.reply && folded.length ? <TurnLine ms={seg.reply.at - seg.note.at} open={open} onToggle={() => toggle(seg.key)} /> : live ? <Working since={seg.note.at} /> : null;
          return (
            <Animated.View key={seg.key} layout={glide} style={{ marginTop: gap }} {...land(seg.key)}>
              {head}
              <YouBubble text={seg.note.text} images={seg.note.images} rise={Date.now() - seg.note.at < RISE_MS} />
              {turnLine ? <View style={{ marginTop: rhythm.bubbleToTurn }}>{turnLine}</View> : null}
              {open && folded.length ? (
                <Animated.View entering={enter.fade} style={{ marginTop: rhythm.turnToAnswer, gap: rhythm.paragraph }}>
                  {folded.map((f) => (
                    <View key={f.key}>{f.node}</View>
                  ))}
                </Animated.View>
              ) : null}
              {started.length && !settled ? (
                <View style={{ marginTop: turnLine ? rhythm.turnToAnswer : rhythm.bubbleToTurn }}>
                  <Roster chats={started} board={chats} open={rosterOpen(seg.key)} onToggle={() => setFold(scope, `kids:${seg.key}`, rosterOpen(seg.key) ? false : null)} onOpen={onOpen} onPeek={onPeek} />
                </View>
              ) : null}
              {seg.reply ? (
                <Animated.View entering={enter.fade} style={{ marginTop: turnLine || (started.length && !settled) ? rhythm.turnToAnswer : rhythm.bubbleToTurn }}>
                  {line(seg.reply)}
                  {isLatest ? <Actions text={spoken(seg.reply.text, chats)} at={seg.reply.at} /> : null}
                </Animated.View>
              ) : null}
            </Animated.View>
          );
        })}
      </ScrollView>
    </Animated.View>
  );
}
