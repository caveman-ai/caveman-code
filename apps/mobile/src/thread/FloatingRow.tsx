// What floats 10pt over a chat's box (DECISIONS.md "Floating row"; Cursor 5348): everything in it glass and 44pt tall,
// on one line, and the screen keeps its room whether or not anything shows, so nothing under it moves as it comes and
// goes. At the left the status capsule, whose segments show only when they have something to say: "Working 1m 48s",
// the screen's only clock, then "2 of 3 working", counting only this chat's own subagents and opening the Agents
// sheet. When one of them needs you, the capsule is amber and names it ("Needs you · The composer", which opens it)
// beside "1 of 3 working", or "2 of 3 done" once none works; two or more read "2 agents need you", which opens the
// sheet on just those. In a subagent the left slot is the sibling strip (thread/SiblingStrip.tsx). Just after you
// answer an ask while others wait anywhere, the left slot says which is next ("Next · Deploy to production? › 1 of 2")
// until your next move in the chat. After the left slot, a pill for each of the agent's screens this chat has
// ("Browser", "Computer"; thread/Screens.tsx), the one it is using first with the blue live dot. At the right, the jump
// circle, only while you're scrolled up, with a dot when something new arrived under you.
//
// On a real computer's chat whose place does not simply run, the left slot says so first, in one line (live/words.ts
// noteOf): the place's one state word ("Asleep", "Paused until Monday · plan used up"), or a wait with its seconds
// ("Waking Cloud… 4s", "Moving to Cloud… 8s"). There is no button in it: sending is what wakes a place, and the chat's
// menu holds its two verbs. A line with more to say ("Cloud couldn't start. Trying again.") opens the chat's details.
// While the chat's own message says what it waits for, this says nothing: one wait, one line.
//
// A follow-up queued behind the running turn is the box's own first row, one glass with it (shell/composer/Queue.tsx):
// a tray of its own here, tucked behind the box, showed its corners as ears and doubled the shadow.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { Chat } from "../board/model";
import { Glass } from "../components/Glass";
import { Icon } from "../components/Icon";
import { Squish } from "../components/Squish";
import { shortTitle } from "../components/transcript/Parts";
import { LiveDot } from "../components/ui/Badge";
import { duration, ease, haptic, useReducedMotion } from "../motion";
import type { Note } from "../live/words";
import type { Queued } from "../store/sessions";
import { FLOAT_TYPE, alpha, layout, useTheme } from "../theme";
import { clockOf } from "./fold";
import { SiblingStrip } from "./SiblingStrip";
import { kidsWord } from "../live/seams";

const F = layout.float;

/** Ticks once a second while `on`. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** A glass capsule; its glass never fades. Amber is a ring and the words, never a fill: the glass stays glass. */
function Shell({ amber = false, children }: { amber?: boolean; children: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <Glass interactive style={{ height: F, borderRadius: F / 2, flexDirection: "row", alignItems: "center", flexShrink: 1, minWidth: 0 }}>
      {children}
      {amber ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: F / 2, borderWidth: 1, borderColor: alpha(c.warning, 0.55) }} /> : null}
    </Glass>
  );
}

/** One segment of a capsule: its own press, 44 tall. `keep`: it never gives way (a count), the other one does. */
function Segment({ label, onPress, keep = false, children }: { label: string; onPress?: () => void; keep?: boolean; children: React.ReactNode }) {
  const inner = <View style={{ height: F, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 }}>{children}</View>;
  const room = { flexShrink: keep ? 0 : 1, minWidth: 0 };
  if (!onPress) return <View accessible accessibilityLabel={label} style={room}>{inner}</View>;
  // The press sits inside a box that gives way, so a long name ellipsizes inside the capsule rather than past it.
  return (
    <View style={room}>
      <Squish label={label} onPress={onPress} depth={0.95} hitSlop={4}>
        {inner}
      </Squish>
    </View>
  );
}

const Divider = () => {
  const { c } = useTheme();
  return <View style={{ width: 1, height: 18, backgroundColor: alpha(c.text, 0.14) }} />;
};

/** This chat's children, as the capsule counts them. */
export interface Kids {
  total: number;
  working: number;
  /** The children that need you, oldest ask first. */
  asking: readonly Chat[];
}

export function kidsOf(kids: readonly Chat[]): Kids {
  return {
    total: kids.length,
    working: kids.filter((k) => k.phase === "working").length,
    asking: kids.filter((k) => k.phase === "needs").sort((a, b) => a.updatedAt - b.updatedAt),
  };
}

/** The status capsule; null when it has nothing to say. */
function Status({ since, kids, onAgents, onChild }: { since: number | null; kids: Kids; onAgents: (filter: "needs" | null) => void; onChild: (id: string) => void }) {
  const { c, t } = useTheme();
  const asking = kids.asking[0] ?? null;
  // No clock while it is amber: what needs you is the news.
  const now = useNow(since !== null && !asking);
  const label = { ...t.button, fontSize: 15, lineHeight: 20, color: c.muted };
  // The capsule turns amber the moment a child needs you, with a tick.
  const was = useRef(asking?.id ?? null);
  useEffect(() => {
    if (asking && asking.id !== was.current) haptic.tick();
    was.current = asking?.id ?? null;
  }, [asking]);

  // One that needs you is neither working nor done: "2 of 3 done" beside its "Needs you", never "3 agents done".
  const done = kids.total - kids.working - kids.asking.length;
  const agents = kids.total ? (kids.working ? `${kids.working} of ${kids.total} working` : done < kids.total ? `${done} of ${kids.total} done` : `${kids.total} agents done`) : null;
  if (asking) {
    const many = kids.asking.length > 1;
    const words = many ? `${kids.asking.length} ${kidsWord(kids.asking.length)} need you` : `Needs you · ${shortTitle(asking.title)}`;
    return (
      <Shell amber>
        <Segment label={many ? `${words}. Show them` : `Needs you: ${asking.title}. Open it`} onPress={() => (many ? onAgents("needs") : onChild(asking.id))}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.warning }} />
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[label, { color: c.warning, flexShrink: 1 }]}>
            {words}
          </Text>
        </Segment>
        {!many && agents ? (
          <>
            <Divider />
            <Segment label={`${agents}. Show the ${kidsWord(2)}`} onPress={() => onAgents(null)} keep>
              <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[label, { color: c.soft }]}>
                {agents}
              </Text>
            </Segment>
          </>
        ) : null}
      </Shell>
    );
  }
  const clock = since !== null ? clockOf(now - since) : null;
  if (!clock && !agents) return null;
  const words = [clock ? `Working ${clock}` : null, agents].filter(Boolean).join(", ");
  return (
    <Shell>
      <Segment label={agents ? `${words}. Show the ${kidsWord(2)}` : words} onPress={agents ? () => onAgents(null) : undefined}>
        {clock ? (
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={label}>
            Working <Text style={{ fontVariant: ["tabular-nums"], color: c.subtle }}>{clock}</Text>
          </Text>
        ) : null}
        {clock && agents ? <Divider /> : null}
        {agents ? (
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[label, { color: c.soft }]}>
            {agents}
          </Text>
        ) : null}
      </Segment>
    </Shell>
  );
}

/** What the open chat says of where it runs, and where a tap on it goes when it has more to say. */
export interface Away {
  note: Note;
  /** More about the line (what went wrong): the chat's details say it. */
  onWhy: () => void;
}

/** The chat's place in one line: its state word, or a wait with its seconds. A tap only where there is more to read. */
function NoteCapsule({ away }: { away: Away }) {
  const { c, t } = useTheme();
  const { note } = away;
  const counting = note.since !== undefined;
  const now = useNow(counting);
  const label = { ...t.button, fontSize: 15, lineHeight: 20, color: c.muted };
  const clock = note.since !== undefined ? clockOf(now - note.since) : null;
  const words = (
    <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[label, { flexShrink: 1 }]}>
      {note.words}
      {clock ? <Text style={{ fontVariant: ["tabular-nums"], color: c.subtle }}>{` ${clock}`}</Text> : null}
    </Text>
  );
  const spoken = clock ? `${note.words}, ${clock}` : note.words;
  return (
    <Shell>
      {note.detail ? (
        <Segment label={`${spoken.replace(/\.$/, "")}. See why`} onPress={away.onWhy}>
          {words}
          <Icon name="chevronRight" size={14} color={c.subtle} />
        </Segment>
      ) : (
        <Segment label={spoken}>{words}</Segment>
      )}
    </Shell>
  );
}

/**
 * The next ask waiting anywhere, after you answer one: "Next · Add a package? › 1 of 2", the longest-waiting first
 * (store/select.ts askQueue). It stays until your next move in the chat (a scroll, a word typed, a tap) or until you
 * leave, never on a timer, so it is never gone just as the thumb arrives.
 */
export interface NextAsk {
  id: string;
  question: string;
  /** Its place among all that wait, oldest first. */
  index: number;
  total: number;
}

/** Next hears no tap this long after it appears: it comes up where the sibling strip was, under a thumb in flight. */
const NEXT_ARM_MS = 450;

function NextCapsule({ next, onPress }: { next: NextAsk; onPress: () => void }) {
  const { c, t } = useTheme();
  const still = useReducedMotion();
  const label = { ...t.button, fontSize: 15, lineHeight: 20 };
  const since = useRef(Date.now());
  // Its words fade in over 150 ms; the glass under them never fades.
  const shown = useSharedValue(still ? 1 : 0);
  useEffect(() => {
    shown.value = still ? 1 : withTiming(1, { duration: 150, easing: ease.snap });
  }, [shown, still]);
  const words = useAnimatedStyle(() => ({ opacity: shown.value }));
  return (
    <Shell>
      <Segment
        label={`Next: ${next.question}, ${next.index} of ${next.total}. Open it`}
        onPress={() => {
          if (Date.now() - since.current < NEXT_ARM_MS) return;
          onPress();
        }}
      >
        {/* Only the question gives way; "1 of 2" is always whole, on the one line. */}
        <Animated.View style={[{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, minWidth: 0 }, words]}>
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[label, { color: c.text, flexShrink: 1, minWidth: 0 }]}>
            Next · {next.question}
          </Text>
          <Icon name="chevronRight" size={14} color={c.subtle} />
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[label, { color: c.muted, flexShrink: 0, fontVariant: ["tabular-nums"] }]}>
            {next.index} of {next.total}
          </Text>
        </Animated.View>
      </Segment>
    </Shell>
  );
}

/** One of the agent's screens the chat has, as the row shows it (thread/Screens.tsx). */
export interface ScreenPill {
  screen: "browser" | "computer";
  /** The agent is using it now. */
  live: boolean;
  /** Its glyph, for when the row is too full for its word. */
  glyph: ReactNode;
}

const SCREEN_WORD = { browser: "Browser", computer: "Computer" } as const;

/**
 * A screen the agent opened, in glass that says which: "Browser", "Computer". The one it is using leads in full ink
 * with the blue dot pulsing; one it used and left is grey, and gives its word up for its glyph when the row is full.
 * Either opens the screen.
 */
function ScreenCapsule({ pill, compact, onPress }: { pill: ScreenPill; compact: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const word = SCREEN_WORD[pill.screen];
  const label = { ...t.button, fontSize: 15, lineHeight: 20, color: pill.live ? c.text : c.muted };
  return (
    <Squish label={pill.live ? `${word}: the agent is using it. Watch it` : `${word}: the agent used it. Open it`} onPress={onPress} depth={0.95} hitSlop={4}>
      <Glass interactive style={{ height: F, minWidth: F, borderRadius: F / 2, paddingHorizontal: compact ? 0 : 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }}>
        {pill.live ? <LiveDot /> : null}
        {compact ? (
          pill.glyph
        ) : (
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={label}>
            {word}
          </Text>
        )}
      </Glass>
    </Squish>
  );
}

/** Back to the newest, only while you're scrolled up: it scales in and out (glass never fades), a dot when it's new. */
function JumpCircle({ shown, dot, onPress }: { shown: boolean; dot: "new" | "needs" | null; onPress: () => void }) {
  const { c } = useTheme();
  const still = useReducedMotion();
  const grown = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    grown.value = still ? (shown ? 1 : 0) : withTiming(shown ? 1 : 0, { duration: shown ? duration.base : 140, easing: ease.snap });
  }, [shown, grown, still]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: grown.value }] }));
  return (
    <Animated.View pointerEvents={shown ? "auto" : "none"} aria-hidden={!shown} style={style}>
      <Squish label={dot === "needs" ? "Needs you: scroll to it" : dot ? "Scroll to what's new" : "Scroll to the newest"} onPress={onPress} depth={0.88} hitSlop={4}>
        <Glass interactive style={{ width: F, height: F, borderRadius: F / 2, alignItems: "center", justifyContent: "center" }}>
          <Icon name="chevronDown" size={22} color={c.text} />
        </Glass>
      </Squish>
      {dot ? <View pointerEvents="none" style={{ position: "absolute", top: 4, right: 4, width: 10, height: 10, borderRadius: 5, backgroundColor: dot === "needs" ? c.warning : c.text, borderWidth: 2, borderColor: c.panel }} /> : null}
    </Animated.View>
  );
}

export interface FloatingRowProps {
  /** When the running turn began: the capsule's clock. Null while nothing runs. */
  since: number | null;
  kids: Kids;
  /** A subagent's parent and its children (this one among them): the sibling strip leads the row. */
  family?: { parent: Chat; siblings: readonly Chat[]; current: string } | null;
  /** For a few seconds after you answer an ask: the next one waiting anywhere. */
  next?: NextAsk | null;
  /** A real computer's chat whose place does not simply run: its one line leads the row. */
  away?: Away | null;
  /** Scrolled up: the jump circle shows. */
  scrolledUp: boolean;
  /** What the jump circle's dot says. */
  dot: "new" | "needs" | null;
  /** The agent's screens this chat has, the one in use first: each a pill after the left slot. */
  screens?: readonly ScreenPill[];
  onScreen?: (screen: ScreenPill["screen"]) => void;
  queued: readonly Queued[];
  /** No longer drawn here: the box draws what's queued as its own first row. */
  tray?: boolean;
  onAgents: (filter: "needs" | null) => void;
  onChild: (id: string) => void;
  onParent: () => void;
  onSibling?: (id: string) => void;
  onNext?: (id: string) => void;
  onJump: () => void;
  onEditQueued: (q: Queued) => void;
  onRemoveQueued: (q: Queued) => void;
}

/** Whether anything in the row shows; the screen keeps its room either way. */
export const rowShows = (p: Pick<FloatingRowProps, "since" | "kids" | "family" | "scrolledUp" | "queued" | "next" | "screens" | "away">) =>
  p.since !== null || p.kids.total > 0 || !!p.family || p.scrolledUp || p.queued.length > 0 || !!p.next || !!p.screens?.length || !!p.away;

export function FloatingRow(p: FloatingRowProps) {
  const left = p.next ? (
    <NextCapsule next={p.next} onPress={() => p.onNext?.(p.next!.id)} />
  ) : p.away ? (
    <NoteCapsule away={p.away} />
  ) : p.family ? (
    <SiblingStrip parent={p.family.parent} siblings={p.family.siblings} current={p.family.current} onParent={p.onParent} onSibling={(id) => p.onSibling?.(id)} />
  ) : (
    <Status since={p.since} kids={p.kids} onAgents={p.onAgents} onChild={p.onChild} />
  );
  const screens = p.screens ?? [];
  // A screen left idle gives its word up for its glyph when it shares the row (the left slot says something, or the
  // jump circle is up), so the clock and the screen in use keep theirs whole.
  const full = p.since !== null || p.kids.total > 0 || !!p.family || !!p.next || !!p.away || p.scrolledUp;
  return (
    <View pointerEvents="box-none">
      <View pointerEvents="box-none" style={{ height: F, flexDirection: "row", alignItems: "center", gap: layout.floatGap }}>
        {/* The left slot has the row to itself until the jump circle shows, which then sits beside it. */}
        <View pointerEvents="box-none" style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: layout.floatGap, marginRight: p.scrolledUp ? F + layout.floatGap : 0 }}>
          {left}
          {/* The agent's screens after it, never giving way: the one in use first, the ones it left at the end. */}
          {screens.map((pill) => (
            <View key={pill.screen} style={{ flexShrink: 0 }}>
              <ScreenCapsule pill={pill} compact={full && !pill.live} onPress={() => p.onScreen?.(pill.screen)} />
            </View>
          ))}
        </View>
        <View pointerEvents="box-none" style={{ position: "absolute", right: 0, top: 0 }}>
          <JumpCircle shown={p.scrolledUp} dot={p.dot} onPress={p.onJump} />
        </View>
      </View>
    </View>
  );
}
