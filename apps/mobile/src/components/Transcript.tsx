// A chat's turns, as Codex leaves them and Cursor draws them (DECISIONS.md "Thread, exactly"; the plan is
// thread/fold.ts). Your words in a raised bubble at the right. A finished turn is that, one quiet "Worked for 2m 38s ›"
// line with its hairline running out to the right, the final answer in the prose grey, what it changed as one pill
// and, on the latest turn, copy, share, retry and the time. A steer stays in view with when you sent it, splitting
// the work into a line before it and a line after. A turn still running, stopped, failed or waiting on you shows its
// parts in order, one grey sentence each, and a running one ends in exactly one live row. The fold closes the moment a
// turn ends, unless the screen holds it open (a finger down, or you scrolled up into the run): thread/Collapse.tsx.
//
// Rhythm comes from theme.ts `rhythm`, between what you see rather than between boxes: each line's own room above and
// below its words is taken off the gap, so 28 from your bubble to the first line means 28 between the words.
// Nothing replays: what was there when the chat opened sits still, and an answer streams only while it arrives.
import { type ComponentRef, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Keyboard, Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import type { Chat, SentImage } from "../board/model";
import { toolOf } from "../board/model";
import { Pictures } from "../photos/Pictures";
import { PhotoViewer } from "../photos/Viewer";
import { counts } from "../live/words";
import { ease, enter, haptic, useReducedMotion } from "../motion";
import { Collapse } from "../thread/Collapse";
import { type Body, bodyOf, type Kept, liveSteps, steeredAt, type TurnPlan } from "../thread/fold";
import { usePaced } from "../thread/pace";
import { leaveArriving, reportArriving } from "../thread/settle";
import { alpha, rhythm, touch, useTheme, weight } from "../theme";
import { Icon } from "./Icon";
import { Squish } from "./Squish";
import { LiveRow } from "./transcript/LiveRow";
import { bubbleFolds } from "./transcript/lines";
import { Markdown } from "./transcript/Markdown";
import { holdBack } from "./transcript/markdown-parse";
import { AskLine, DateLine, ReportedLine, Roster, RunParts, StopLine, WorkedLine } from "./transcript/Parts";
import { ActionRow, ChangesPill } from "./transcript/TurnEnd";
import { VendorMark } from "./ui/EngineLogo";
import { type Anchor, Menu, useAnchor } from "./ui/Menu";

/** A drawn view, to measure where it is. */
export type ViewNode = ComponentRef<typeof View>;

// ---------------------------------------------------------------- your words

/**
 * A message the person just sent glides up out of the composer into its place, on the same clock as the list's glide
 * that brings it under the bar (screens/Thread.tsx SEND_MS), so the two read as one move.
 */
const RISE_MAX = 420;
const RISE_MS = 320;

/** A folded message shows this many lines (lines.ts LONG_LINES) at its 22pt leading. */
const FOLD_HEIGHT = 8 * 22;
const FOLD_FADE = 28;

/**
 * Your words in a bubble on the raised fill (radius 20, 16 on 22 in full ink, at most 80% wide). A long one folds, its
 * words fading out at the foot, with "Show full message" under it; a press and hold copies it, and VoiceOver offers
 * Copy as an action. `rise`: it was just sent, so it glides up from the composer, with everything that belongs to it
 * (its caption never arrives before it). `above` sits over it at the right (a subagent's "From Parent ›"); `caption`
 * under it, holding its line ("Steered at 1m 30s"). `sending`: "Sending" under it until the engine has it, drawn in
 * the room the turn already keeps under the bubble, so it fades out without moving anything. `steered` is the plain
 * "Steered" caption, for the Chief's chat. `images`: the pictures that went with it, over the words (photos/Pictures.tsx),
 * each opening the viewer; pictures sent alone have no bubble under them.
 */
export function YouBubble({ text, images, rise = false, steered = false, caption, above, sending = false }: { text: string; images?: readonly SentImage[]; rise?: boolean; steered?: boolean; caption?: ReactNode; above?: ReactNode; sending?: boolean }) {
  const { c, t } = useTheme();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const { ref, measure } = useAnchor();
  // Folded by its length, or by its measured height once it was measured at a real width (lines.ts bubbleFolds): a
  // layout pass at a passing, narrow width never folds a short message into a column.
  const [natural, setNatural] = useState<{ height: number; width: number } | null>(null);
  const [room, setRoom] = useState(0);
  // The widest its words can be: 80% of the row, less the bubble's 14pt sides.
  const long = bubbleFolds(text, natural, room * 0.8 - 28, FOLD_HEIGHT);
  const folded = long && !open;
  const lift = useSharedValue(rise ? 160 : 0);
  const shown = useSharedValue(rise ? 0 : 1);
  useEffect(() => {
    if (!rise) return;
    lift.value = withTiming(0, { duration: RISE_MS, easing: ease.snap });
    shown.value = withTiming(1, { duration: RISE_MS, easing: ease.fade });
  }, [rise, lift, shown]);
  const rising = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ translateY: Math.min(RISE_MAX, lift.value) }] }));
  const copy = () => void Clipboard.setStringAsync(text);
  const under = caption ?? (steered ? <Caption text="Steered" /> : null);
  const pictures = images?.length ? images : null;
  const words = text.length > 0 || !pictures;
  return (
    <Animated.View style={[{ alignItems: "flex-end" }, rising]} onLayout={(e) => setRoom(e.nativeEvent.layout.width)}>
      {above ? <View style={{ marginBottom: 6, maxWidth: "80%" }}>{above}</View> : null}
      {pictures ? (
        <View style={{ marginBottom: words ? 4 : 0 }}>
          <Pictures
            images={pictures}
            room={room * 0.8}
            onOpen={(i) => {
              // The keyboard would stand over the viewer.
              Keyboard.dismiss();
              setViewing(i);
            }}
          />
          <PhotoViewer images={pictures} index={viewing} onClose={() => setViewing(null)} />
        </View>
      ) : null}
      {words ? (
        <View ref={ref} collapsable={false} style={{ maxWidth: "80%", backgroundColor: c.raised, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 }}>
          <Pressable
            accessibilityHint="Press and hold to copy"
            accessibilityActions={[{ name: "copy", label: "Copy" }]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === "copy") copy();
            }}
            delayLongPress={350}
            onLongPress={async () => {
              haptic.tick();
              setMenu(await measure());
            }}
          >
            <View style={folded ? { maxHeight: FOLD_HEIGHT, overflow: "hidden" } : undefined}>
              <Text
                onLayout={(e) => {
                  const { height, width } = e.nativeEvent.layout;
                  if (__DEV__ && width + 28 < 40 && text.trim().length > 2) console.warn(`YouBubble measured ${Math.round(width + 28)}pt wide for ${text.length} characters`);
                  setNatural({ height, width });
                }}
                style={[t.body, { lineHeight: 22 }]}
              >
                {text}
              </Text>
              {folded ? <LinearGradient pointerEvents="none" colors={[alpha(c.raised, 0), c.raised]} style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: FOLD_FADE }} /> : null}
            </View>
          </Pressable>
        </View>
      ) : null}
      {long ? (
        <Squish label={open ? "Show less" : "Show full message"} depth={0.97} highlight hitSlop={8} onPress={() => setOpen(!open)} style={{ height: 28, paddingHorizontal: 6, marginTop: 2, borderRadius: 8, justifyContent: "center" }}>
          <Text style={t.small}>{open ? "Show less" : "Show full message"}</Text>
        </Squish>
      ) : null}
      {under ? <View style={{ marginTop: rhythm.steerCaption }}>{under}</View> : null}
      {under ? null : <Sending on={sending} />}
      <Menu open={menu !== null} onClose={() => setMenu(null)} anchor={menu} align="end" width={220} entries={[{ label: "Copy", icon: "copy", onPress: copy }]} />
    </Animated.View>
  );
}

/** How long a caption's words take to fade out, or to change. */
const CAPTION_MS = 150;

/**
 * "Sending" under a bubble until the engine has it: laid over the room the turn keeps under your words (28pt to its
 * first line), never in the flow, so nothing moves when it goes. It fades out over 150ms.
 */
function Sending({ on }: { on: boolean }) {
  const { t } = useTheme();
  const [kept, setKept] = useState(on);
  const ink = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    if (on) {
      setKept(true);
      ink.value = 1;
      return;
    }
    ink.value = withTiming(0, { duration: CAPTION_MS, easing: ease.fade });
    const timer = setTimeout(() => setKept(false), CAPTION_MS + 20);
    return () => clearTimeout(timer);
  }, [on, ink]);
  const style = useAnimatedStyle(() => ({ opacity: ink.value }));
  if (!kept) return null;
  return (
    <Animated.View pointerEvents="none" aria-hidden={!on} style={[{ position: "absolute", top: "100%", right: 0, marginTop: rhythm.steerCaption }, style]}>
      <Text style={[t.meta, { paddingRight: 4 }]}>Sending</Text>
    </Animated.View>
  );
}

/**
 * What a message that has not run yet waits for, under it, in the one line the chat gives a wait: "Waking Cloud… 4s"
 * with its seconds, "Studio is asleep. Running in Cloud.", "Sends when Studio wakes". Nothing else on screen says
 * "Sending" or "Working" meanwhile.
 */
function WaitCaption({ wait }: { wait: { words: string; since: number } }) {
  const { c, t } = useTheme();
  // Only a wait that is under way counts its seconds: a message kept for later does not.
  const timed = counts(wait.words);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timed, wait.since]);
  const seconds = Math.max(0, Math.floor((now - wait.since) / 1000));
  const clock = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return (
    <Text accessibilityLiveRegion="polite" style={[t.meta, { paddingRight: 4, textAlign: "right" }]}>
      {wait.words}
      {timed ? <Text style={{ fontVariant: ["tabular-nums"], color: c.subtle }}>{` ${clock}`}</Text> : null}
    </Text>
  );
}

/**
 * Under a message that was refused: it stays where you typed it, marked "Not sent", with the one thing to do about
 * it, "Send again", as a full-size target. Without `onPress` (a chat that did not start, whose Try again and Discard
 * stand at its foot) it says only that it was not sent.
 */
function NotSent({ onPress }: { onPress?: (() => void) | undefined }) {
  const { c, t } = useTheme();
  if (!onPress) return <Text style={[t.meta, { paddingRight: 4, textAlign: "right", color: c.destructive }]}>Not sent</Text>;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end" }}>
      <Text style={[t.meta, { color: c.destructive }]}>Not sent · </Text>
      <Squish label="Not sent. Send again" depth={0.97} highlight hitSlop={14} onPress={onPress} style={{ paddingRight: 4 }}>
        <Text style={[t.meta, { color: c.text, fontWeight: weight.medium }]}>Send again</Text>
      </Squish>
    </View>
  );
}

/** A caption whose words change ("Sending", then "Steered at 23m 15s"): the old words fade out as the new fade in. */
export function SwapCaption({ text }: { text: string }) {
  const { t } = useTheme();
  const [words, setWords] = useState({ now: text, was: null as string | null });
  const fresh = useSharedValue(1);
  useEffect(() => {
    if (text === words.now) return;
    setWords({ now: text, was: words.now });
    fresh.value = 0;
    fresh.value = withTiming(1, { duration: CAPTION_MS, easing: ease.fade });
    const timer = setTimeout(() => setWords((w) => ({ now: w.now, was: null })), CAPTION_MS + 20);
    return () => clearTimeout(timer);
    // Only a change of words starts a swap.
  }, [text]);
  const inStyle = useAnimatedStyle(() => ({ opacity: fresh.value }));
  const outStyle = useAnimatedStyle(() => ({ opacity: 1 - fresh.value }));
  return (
    <View>
      <Animated.Text style={[t.meta, { paddingRight: 4, textAlign: "right" }, inStyle]}>{words.now}</Animated.Text>
      {words.was !== null ? (
        <Animated.Text aria-hidden style={[t.meta, { position: "absolute", right: 0, top: 0, paddingRight: 4 }, outStyle]}>
          {words.was}
        </Animated.Text>
      ) : null}
    </View>
  );
}

/** A quiet word under a bubble, right-aligned: 13 in the tertiary grey. */
export function Caption({ text }: { text: string }) {
  const { t } = useTheme();
  return <Text style={[t.meta, { paddingRight: 4 }]}>{text}</Text>;
}

/** Over a subagent's task: who sent it, "From [mark] Parent ›", which opens the parent. */
function FromParent({ parent, onOpen }: { parent: Chat; onOpen: () => void }) {
  const { c, t } = useTheme();
  return (
    <Squish label={`From ${parent.title}. Open it`} depth={0.97} hitSlop={10} onPress={onOpen} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 4 }}>
      <Text style={t.meta}>From</Text>
      <VendorMark engine={parent.engine} model={parent.model} size={14} />
      <Text numberOfLines={1} style={[t.meta, { color: c.muted, flexShrink: 1 }]}>
        {parent.title}
      </Text>
      <Icon name="chevronRight" size={12} color={c.subtle} />
    </Squish>
  );
}

// ---------------------------------------------------------------- the engine's words

/**
 * The engine's words: paced in on two gears from `at` (thread/pace.ts), each new word fading in on its own clock, the
 * settled paragraphs kept. `id` says when it starts and stops arriving (thread/settle.ts), so the turn it ends reads as
 * working until it has. `announce`: VoiceOver hears it once when it has all arrived (the turn's final answer).
 */
export function EngineText({ id, text, at, announce = false }: { id?: string; text: string; at: number; announce?: boolean }) {
  const still = useReducedMotion();
  const { shown, streaming, fades } = usePaced(text, at, still);
  const was = useRef(streaming);
  useEffect(() => {
    if (was.current && !streaming && announce) AccessibilityInfo.announceForAccessibility(text.replace(/\*\*|`|\[\[|\]\]/g, ""));
    was.current = streaming;
  }, [streaming, announce, text]);
  useEffect(() => {
    if (id) reportArriving(id, streaming);
  }, [id, streaming]);
  useEffect(() => () => void (id && leaveArriving(id)), [id]);
  // A table row still arriving, or a table without its delimiter yet, waits rather than showing as raw "|".
  return <Markdown text={closeMarks(streaming ? holdBack(shown) : shown)} streaming={streaming} fades={fades} />;
}

/** Mid-stream, a bold or code mark may be open; close it so the half-word renders styled rather than as stars. */
function closeMarks(text: string) {
  let out = text;
  if ((out.match(/\*\*/g)?.length ?? 0) % 2) out += "**";
  if ((out.match(/```/g)?.length ?? 0) % 2) return out;
  if ((out.replace(/```/g, "").match(/`/g)?.length ?? 0) % 2) out += "`";
  if ((out.match(/\[\[/g)?.length ?? 0) > (out.match(/\]\]/g)?.length ?? 0)) out = out.replace(/\[\[[^\]]*$/, "");
  return out;
}

// ---------------------------------------------------------------- rhythm

type Kind = "bubble" | "worked" | "text" | "part" | "steer" | "live" | "roster" | "changes" | "actions" | "reported";

/** The room each kind of line keeps above and below its words (a 44pt hit row around a 20pt line keeps 12). */
const ROOM: Record<Kind, number> = { bubble: 0, worked: 12, text: 0, part: 6, steer: 0, live: 6, roster: 6, changes: 0, actions: 13, reported: 6 };

/** The space between two lines, as theme.ts `rhythm` measures it between their words. */
export function gap(prev: Kind | null, next: Kind): number {
  if (prev === null) return 0;
  let target: number;
  if (prev === "bubble") target = rhythm.bubbleToTurn;
  else if (next === "steer") target = rhythm.steerAbove;
  else if (prev === "steer") target = rhythm.steerBelow;
  else if (prev === "worked" && next === "text") target = rhythm.turnToAnswer;
  else if (next === "changes") target = rhythm.answerToChanges;
  else if (prev === "changes") target = rhythm.changesToActions;
  else if (next === "actions") target = rhythm.changesToActions;
  else if (prev === "text" && next === "text") target = rhythm.paragraph;
  // A roster is a block of its own: prose keeps a paragraph's room from it on either side.
  else if (prev === "roster" || next === "roster") target = rhythm.proseToHeader;
  // Prose after a part opens the next stretch of work (an engine says what it will do before it does it): a
  // paragraph's room, so a run of parts and commentary never reads cramped.
  else if (prev === "part" && next === "text") target = rhythm.proseToHeader;
  else if (next === "text") target = rhythm.headerToProse + 4;
  else if (prev === "text") target = rhythm.proseToHeader;
  else target = 0;
  return Math.max(0, target - ROOM[prev] - ROOM[next]);
}

const kindOf = (b: Body | Kept): Kind => (b.kind === "text" ? "text" : b.kind === "agents" ? "roster" : "part");

/**
 * The room above a line of a turn's body. The turn's answer right after a part keeps the room it keeps under its
 * "Worked for" line (14 between the words), so when the part folds into that line the answer doesn't move.
 */
const gapTo = (prev: Kind | null, b: Body | Kept, answer: TurnPlan["answer"]) =>
  prev === "part" && b.kind === "text" && b.item === answer ? Math.max(0, rhythm.turnToAnswer - ROOM.part - ROOM.text) : gap(prev, kindOf(b));

// ---------------------------------------------------------------- a turn

export interface TurnViewProps {
  plan: TurnPlan;
  /** The chat's live line, for the turn that is running (null for every other, so they don't draw again). */
  line: string | null;
  /**
   * The engine has finished this turn but its answer is still arriving on screen (thread/settle.ts): no live row, and
   * what closes the turn (its Changes pill, the action row) already holds its room, unseen, so nothing moves when it
   * shows.
   */
  settling: boolean;
  /** This turn's Changes are the ones waiting on you now: its pill opens them. */
  current: boolean;
  /** Folds opened by hand, by segment key (store/sessions.ts). */
  folds: Readonly<Record<string, boolean>>;
  /** A "Worked for" line was tapped: `header` is the line, so the screen can keep it under your thumb. */
  onFold: (key: string, open: boolean, header: ViewNode | null) => void;
  /** The fold is closing on its own as the turn ends: the screen holds the answer where it is meanwhile. */
  onFolding: () => void;
  /** The screen holds this finished turn open for now: a finger is down, or you are reading inside it. */
  hold: boolean;
  /** Items that weren't there when the chat opened: they fade (or rise) in. */
  isNew: (id: string) => boolean;
  /** A date line over it. */
  date: number | null;
  /** The first turn on screen: no room above it but the list's own. */
  first: boolean;
  /** A subagent's parent, for its task's caption and its "Reported back" line. */
  parent: Chat | null;
  /** This chat's own subagents, for a roster. */
  kids: readonly Chat[];
  /** Where this chat runs: a subagent on the same computer doesn't say so. */
  device: string;
  /** The chat's ask, as the one status function words it ("Run a migration on staging?"). */
  ask: string | null;
  /** An item a search landed on: it flashes, and tells the screen where it is. */
  flash: { id: string; onView: (view: ViewNode) => void } | null;
  onOpenChat: (id: string) => void;
  onReview: () => void;
  onRetry: (text: string) => void;
  /** What the latest message waits for, while it has not run yet (a real computer's chat): its own line says so. */
  wait?: { words: string; since: number } | null;
  /** Sends a message that was not sent again, by its id in the chat. */
  onResend?: (item: string) => void;
}

/** Whether a turn's Changes are the ones waiting on you now (the same moment, by what it says). */
export const isCurrent = (chat: Chat, plan: TurnPlan) =>
  chat.phase === "ready" && !!chat.moment && !!plan.changes && chat.moment.headline === plan.changes.headline && chat.moment.summary === plan.changes.summary;

/** How long the fold takes to close (thread/Collapse.tsx), and the beat after it before what closes the turn shows. */
const FOLD_MS = 240;
const AFTER_FOLD_MS = 120;

/**
 * Fades in from nothing once `shown`, `delay` after: its first painted frame is already at 0 (its own first style,
 * never an entering animation that paints a frame at full ink). Shown from the start (a turn from history), it is
 * just there, unless it is `fresh` (it came with a fold closing now). Under Reduce Motion it is a cut.
 */
function Arrive({ shown, fresh = false, delay = 0, children }: { shown: boolean; fresh?: boolean; delay?: number; children: ReactNode }) {
  const still = useReducedMotion();
  const ink = useSharedValue(shown && (!fresh || still) ? 1 : 0);
  useEffect(() => {
    if (!shown) {
      ink.value = 0;
      return;
    }
    if (ink.value >= 1) return;
    ink.value = still ? 1 : withDelay(delay, withTiming(1, { duration: 200, easing: ease.fade }));
  }, [shown, delay, still, ink]);
  const style = useAnimatedStyle(() => ({ opacity: ink.value }));
  return (
    <Animated.View pointerEvents={shown ? "auto" : "none"} aria-hidden={!shown} style={style}>
      {children}
    </Animated.View>
  );
}

/** A search hit inside the chat: the control tint behind it for 1.2s, fading off, and where it is, for the scroll. */
function Flash({ onView, children }: { onView: (view: ViewNode) => void; children: ReactNode }) {
  const { c } = useTheme();
  const ref = useRef<ViewNode>(null);
  const tint = useSharedValue(1);
  useEffect(() => {
    tint.value = withDelay(900, withTiming(0, { duration: 300, easing: ease.fade }));
  }, [tint]);
  const style = useAnimatedStyle(() => ({ opacity: tint.value }));
  return (
    <View ref={ref} collapsable={false} onLayout={() => ref.current && onView(ref.current)}>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", top: -6, bottom: -6, left: -8, right: -8, borderRadius: 10, backgroundColor: c.control }, style]} />
      {children}
    </View>
  );
}

export const TurnView = memo(function TurnView({ plan, line, settling, current, folds, onFold, onFolding, hold, isNew, date, first, parent, kids, device, ask, flash, onOpenChat, onReview, onRetry, wait = null, onResend }: TurnViewProps) {
  // A message that was refused stays in the thread with "Not sent · Send again" under it; nothing else closes its turn.
  const unsent = plan.you?.state === "failed";
  const finished = plan.folds && !hold;
  // The fold closes while this turn is on screen (it just ended, or the hold let go): its "Worked for" line fades in
  // as the work folds away, and the screen holds the answer still meanwhile.
  const wasOpen = useRef(!finished);
  const foldedNow = finished && wasOpen.current;
  useEffect(() => {
    if (finished && wasOpen.current) onFolding();
    wasOpen.current = !finished;
  }, [finished, onFolding]);
  const headers = useRef(new Map<string, ViewNode | null>());
  /** Each line of an open body, as tall as it stood with the room above it: what a closing fold starts from. */
  const sizes = useRef(new Map<string, number>());

  const rows: ReactNode[] = [];
  let prev: Kind | null = plan.you ? "bubble" : null;
  const push = (kind: Kind, key: string, node: ReactNode) => {
    rows.push(
      <View key={key} style={{ marginTop: gap(prev, kind) }}>
        {node}
      </View>,
    );
    prev = kind;
  };
  const flashing = (id: string, node: ReactNode) => (flash?.id === id ? <Flash onView={flash.onView}>{node}</Flash> : node);

  const lastSegment = plan.segments.at(-1);
  // The turn running or settling keeps each part to one 32pt line, so folding it into "Worked for" moves nothing (and
  // it fades out as one line). Two lines are for a fold opened by hand, and a turn left open (stopped, failed).
  const running = plan.latest && (plan.state === "live" || settling);
  for (const [n, seg] of plan.segments.entries()) {
    if (seg.steer) {
      push(
        "steer",
        seg.steer.id,
        flashing(
          seg.steer.id,
          <YouBubble
            text={seg.steer.text}
            images={seg.steer.images}
            rise={isNew(seg.steer.id)}
            caption={seg.steer.state === "failed" ? <NotSent onPress={onResend ? () => onResend(seg.steer!.id) : undefined} /> : <SwapCaption text={seg.steer.state === "sending" ? "Sending" : steeredAt(seg.steerAfter)} />}
          />,
        ),
      );
    }
    const foldable = finished && seg.folded.length > 0;
    const open = !finished || !!folds[seg.key];
    const lines: 1 | 2 = finished ? (folds[seg.key] ? 2 : 1) : running ? 1 : 2;
    const keptIds = new Set(finished ? seg.kept.map((k) => k.key) : []);
    const above = prev;
    if (foldable) {
      push(
        "worked",
        `${seg.key}:worked`,
        <Arrive shown fresh={foldedNow}>
          <View ref={(v) => void headers.current.set(seg.key, v)} collapsable={false}>
            <WorkedLine ms={seg.ms} open={open} rule={seg === lastSegment} onToggle={() => onFold(seg.key, !open, headers.current.get(seg.key) ?? null)} />
          </View>
        </Arrive>,
      );
    }
    // The fold's body: everything when the turn is open, what the fold holds when it is finished.
    const body = bodyOf(finished ? seg.folded : seg.items, plan.start, plan.liveRun).filter((b) => !keptIds.has(b.key) || !finished);
    if (body.length) {
      const inner: ReactNode[] = [];
      let innerPrev: Kind | null = prev;
      for (const b of body) {
        const kind = kindOf(b);
        const top = gapTo(innerPrev, b, plan.answer);
        inner.push(
          <Animated.View
            key={b.key}
            entering={isNew(b.key.split(":")[0] ?? b.key) && !plan.folds ? enter.fade : undefined}
            onLayout={(e) => void sizes.current.set(b.key, e.nativeEvent.layout.height + top)}
            style={{ marginTop: top }}
          >
            {flashing(b.key, <BodyLine b={b} lines={lines} kids={kids} device={device} ask={ask} onOpenChat={onOpenChat} announce={b.kind === "text" && b.item === plan.answer && isNew(b.item.id)} />)}
          </Animated.View>,
        );
        innerPrev = kind;
      }
      // Folding as the turn ends, the body starts shrinking from what the "Worked for" line and the new gaps just
      // added above what stays, so the answer under it doesn't move on the first frame.
      let lead = 0;
      if (foldedNow && foldable) {
        const live = bodyOf(seg.items, plan.start, null);
        const firstKept = live.findIndex((b) => keptIds.has(b.key));
        const lastLive = live[(firstKept < 0 ? live.length : firstKept) - 1];
        const first = seg.kept[0];
        const next: Kind | null = first ? kindOf(first) : plan.segments[n + 1] ? "steer" : null;
        const was = !lastLive || !next ? 0 : first ? gapTo(kindOf(lastLive), first, plan.answer) : gap(kindOf(lastLive), next);
        lead = touch + gap(above, "worked") + (next && lastLive ? (first ? gapTo("worked", first, plan.answer) : gap("worked", next)) - was : 0);
      }
      // What moved out from under it to stay in view (the answer), with the room it took there.
      const drop = foldedNow && foldable ? seg.kept.reduce((sum, k) => sum + (sizes.current.get(k.key) ?? 0), 0) : 0;
      rows.push(
        // Nothing left to shrink (one part folding into its "Worked for" line): the part fades out over the line,
        // its words on the line's, as the line fades in.
        <Collapse key={`${seg.key}:body`} open={open} lead={lead} drop={drop} over={ROOM.worked - ROOM.part}>
          {inner}
        </Collapse>,
      );
      if (open) prev = innerPrev;
    }
    if (finished) {
      for (const k of seg.kept) {
        push(kindOf(k), `kept:${k.key}`, flashing(k.key, <KeptLine k={k} kids={kids} device={device} onOpenChat={onOpenChat} announce={k.kind === "text" && k.item === plan.answer && isNew(k.item.id)} />));
      }
    }
  }

  if (plan.state === "live" && line !== null && !settling) {
    const run = plan.liveRun;
    push("live", "live", <LiveRow steps={liveSteps(run)} line={line ?? ""} tool={toolOf(line ?? "")} kids={kids} />);
  }

  // What closes the turn holds its room, unseen, while the answer settles, and shows a beat after the fold has closed.
  const settledEnd = plan.state !== "live" && plan.state !== "waiting";
  const closing = settledEnd || settling;
  const after = foldedNow || settling ? FOLD_MS + AFTER_FOLD_MS : 0;
  if (plan.changes && closing) {
    push(
      "changes",
      "changes",
      <Arrive shown={settledEnd} fresh={foldedNow} delay={after}>
        <ChangesPill files={plan.changes.files} onOpen={current ? onReview : undefined} />
      </Arrive>,
    );
  }
  if (plan.latest && closing && parent && (plan.state === "finished" || settling)) {
    push(
      "reported",
      "reported",
      <Arrive shown={settledEnd} fresh={foldedNow} delay={after}>
        <ReportedLine to={parent.title} mark={<VendorMark engine={parent.engine} model={parent.model} size={14} />} />
      </Arrive>,
    );
  }
  if (plan.latest && closing && !unsent) {
    push(
      "actions",
      "actions",
      <Arrive shown={settledEnd} fresh={foldedNow} delay={after}>
        <ActionRow text={plan.answer?.text ?? null} at={plan.answer?.at ?? plan.end} onRetry={parent || !plan.you ? undefined : () => onRetry(plan.you!.text)} />
      </Arrive>,
    );
  }

  // Under your own first message in a subagent: who handed it the task.
  const above = parent && first && plan.you ? <FromParent parent={parent} onOpen={() => onOpenChat(parent.id)} /> : undefined;
  // "Sending" until the engine has it; anything it did since says it did (an ack lost to a relaunch included).
  const heard = plan.answer !== null || plan.segments.some((seg) => seg.items.some((i) => i.kind === "text" || i.kind === "ask" || (i.kind === "work" && i.steps.length > 0)));
  const sending = plan.you?.state === "sending" && !heard;
  // What it waits for, where it has not run yet: said under the message, in the place "Sending" would stand.
  const waits = wait && plan.latest && plan.you && !unsent && !heard ? wait : null;
  const last: Kind = prev ?? "bubble";
  return (
    <View style={{ paddingTop: first ? 0 : date !== null ? rhythm.dateAbove : rhythm.turnGap, marginBottom: -ROOM[last] }}>
      {date !== null ? (
        <View style={{ marginBottom: rhythm.dateBelow }}>
          <DateLine at={date} />
        </View>
      ) : null}
      {plan.you
        ? flashing(
            plan.you.id,
            <YouBubble
              text={plan.you.text}
              images={plan.you.images}
              rise={isNew(plan.you.id)}
              above={above}
              sending={sending && !waits}
              caption={unsent ? <NotSent onPress={onResend ? () => onResend(plan.you!.id) : undefined} /> : waits ? <WaitCaption wait={waits} /> : undefined}
            />,
          )
        : null}
      {rows}
    </View>
  );
});

/** One line of an open turn's body. */
function BodyLine({ b, lines, kids, device, ask, onOpenChat, announce }: { b: Body; lines: 1 | 2; kids: readonly Chat[]; device: string; ask: string | null; onOpenChat: (id: string) => void; /** The turn's answer, arriving now: VoiceOver hears it once it has. */ announce: boolean }) {
  switch (b.kind) {
    case "text":
      return <EngineText id={b.item.id} text={b.item.text} at={b.item.at} announce={announce} />;
    case "part":
      return <RunParts steps={b.steps} lines={lines} />;
    case "ask":
      return <AskLine command={b.item.command} answer={b.item.answer} ask={ask} pending={b.item.pending} />;
    case "agents":
      return <Roster children={kids.filter((k) => b.item.children.includes(k.id))} onOpen={onOpenChat} device={device} />;
    case "stop":
      return <StopLine after={b.after} unowned={b.item.unowned} />;
  }
}

/** What stays out of a folded turn: its answer (or words already final), a roster still out. */
function KeptLine({ k, kids, device, onOpenChat, announce }: { k: Kept; kids: readonly Chat[]; device: string; onOpenChat: (id: string) => void; announce: boolean }) {
  if (k.kind === "agents") return <Roster children={kids.filter((kid) => k.item.children.includes(kid.id))} onOpen={onOpenChat} device={device} />;
  return <EngineText id={k.item.id} text={k.item.text} at={k.item.at} announce={announce} />;
}
