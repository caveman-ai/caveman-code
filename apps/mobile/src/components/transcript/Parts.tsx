// The lines a turn is made of, between your words and its answer (DECISIONS.md "Thread, exactly"): each part of the
// work as one grey 15pt sentence led by its pixel tool glyph, the verb in the description grey, what it measures in
// the tertiary grey (mono when it names code), a failure in the destructive red; "›" opens it to its steps, each one
// folded again to its command and output. Around them: the one quiet "Worked for 2m 38s ›" line that a finished turn
// folds under (its hairline running out to the right on the last one), the amber "Waiting for you" an open ask leaves
// (the command it waits on is printed once, on the card docked over the box: store/asked.ts), the stop line, the date
// line, and the roster of chats a turn started (a thread's subagents, a Chief's chats: one roster).
import { useEffect, useState } from "react";
import { Pressable, Text, type TextStyle, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { Chat, Phase, Step } from "../../board/model";
import { deviceById } from "../../board/model";
import { duration as motion, ease, enter, haptic } from "../../motion";
import { heldBack } from "../../store/asked";
import { memoLast } from "../../store/core";
import { useStore } from "../../store/store";
import { type Clause, dateLine, lower, partsOf, type Sentence, sentenceOf, stoppedAfter, workedFor } from "../../thread/fold";
import { alpha, mono, touch, useTheme } from "../../theme";
import { Icon } from "../Icon";
import { PixelIcon, ToolMark } from "../Pixel";
import { Squish } from "../Squish";
import { EngineLogo } from "../ui/EngineLogo";
import { StepLine } from "./WorkRun";

/** A part's type: 15 on 20, regular. */
export function usePartType() {
  const { c } = useTheme();
  return {
    line: { fontSize: 15, lineHeight: 20, fontWeight: "400", color: c.muted } as TextStyle,
    measure: { color: c.subtle } as TextStyle,
    code: { fontFamily: mono, fontSize: 14, color: c.subtle } as TextStyle,
  };
}

/** The chevron a line that opens wears: turning down as it opens (150ms on the snap curve). A glyph, not glass. */
export function Chevron({ open, color }: { open: boolean; color?: string }) {
  const { c } = useTheme();
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.value = withTiming(open ? 1 : 0, { duration: motion.fast, easing: ease.snap });
  }, [open, turn]);
  const turned = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 90}deg` }] }));
  return (
    <Animated.View style={turned}>
      <Icon name="chevronRight" size={14} color={color ?? c.subtle} />
    </Animated.View>
  );
}

/** Lines added and removed, in the diff inks; a zero says nothing. */
export function Counts({ added, removed, size = 13 }: { added: number; removed: number; size?: number }) {
  const { c } = useTheme();
  const style: TextStyle = { fontFamily: mono, fontSize: size, fontVariant: ["tabular-nums"] };
  return (
    <>
      {added ? <Text style={[style, { color: c.added }]}>{` +${added}`}</Text> : null}
      {removed ? <Text style={[style, { color: c.removed }]}>{` −${removed}`}</Text> : null}
    </>
  );
}

/**
 * The clauses of a sentence as nested runs, the first verb capitalised and the rest lower case. No line counts: the
 * green and red stay on the Changes pill and the Ready rows, so a sentence reads in its two greys. `cut` leads with
 * "…": the clauses before these were dropped to make room.
 */
export function ClauseRuns({ clauses, from = 0, cut = false }: { clauses: readonly Clause[]; from?: number; cut?: boolean }) {
  const type = usePartType();
  return (
    <>
      {cut ? "…" : null}
      {clauses.map((clause, i) => (
        <Text key={i}>
          {i + from > 0 && !(cut && i === 0) ? ", " : ""}
          {i + from > 0 ? lower(clause.verb) : clause.verb}
          {clause.measure ? " " : ""}
          {clause.measure ? <Text style={clause.code ? type.code : type.measure}>{clause.measure}</Text> : null}
        </Text>
      ))}
    </>
  );
}

/** About how wide a run of 15pt prose (or 14pt mono) sets, for fitting a sentence before it is drawn. */
const proseWidth = (text: string) => text.length * 7.3;
const monoWidth = (text: string) => text.length * 8.45;

/** How wide a clause sets, with the ", " before it. */
export function clauseWidth(clause: Clause, lead: boolean): number {
  return proseWidth(`${lead ? "" : ", "}${clause.verb}${clause.measure ? " " : ""}`) + (clause.measure ? (clause.code ? monoWidth : proseWidth)(clause.measure) : 0);
}

/** A path with its folders elided, the file kept whole: "apps/mobile/src/chief/ChiefChat.tsx" reads "…/ChiefChat.tsx". */
export const elideFolders = (path: string) => (path.includes("/") ? `…/${path.slice(path.lastIndexOf("/") + 1)}` : path);

/**
 * A sentence fitted to `room` points over `lines` lines: whole when it fits; else its leading clauses dropped first
 * ("…ran the test 50 times"), and if the one clause left still doesn't fit, its path's folders elided ("…/ChiefChat.tsx").
 * `tail` is the room the end of the line keeps for itself (" · 3 failed"), which is never given up.
 */
export function fitClauses(clauses: readonly Clause[], room: number, lines: number, tail = 0): { clauses: Clause[]; cut: boolean } {
  if (room <= 0 || !clauses.length) return { clauses: [...clauses], cut: false };
  // A line never breaks exactly at its edge: keep a word's slack for each wrap.
  const budget = room * lines - (lines - 1) * (40 + tail) - tail;
  const width = (list: readonly Clause[], cut: boolean) => (cut ? proseWidth("…") : 0) + list.reduce((w, cl, i) => w + clauseWidth(cl, i === 0 && !cut), 0);
  if (width(clauses, false) <= budget) return { clauses: [...clauses], cut: false };
  for (let from = 1; from < clauses.length; from++) {
    const rest = clauses.slice(from);
    if (width(rest, true) <= budget) return { clauses: rest, cut: true };
  }
  const last = clauses.at(-1)!;
  const elided = last.code ? { ...last, measure: elideFolders(last.measure) } : last;
  return { clauses: [elided], cut: clauses.length > 1 };
}

/** What a sentence says, read aloud. */
export const sentenceWords = (s: Sentence) =>
  s.clauses.map((cl, i) => `${i ? lower(cl.verb) : cl.verb}${cl.measure ? ` ${cl.measure}` : ""}`).join(", ") + (s.failed ? `, ${s.failed} failed` : "");

/** One line: a 16pt glyph, the words, and at the end what it opens to. Drawn 32 tall, 44 to hit when it opens. */
function Line({ icon, children, open, label, onPress }: { icon: React.ReactNode; children: React.ReactNode; open?: boolean; label: string; onPress?: () => void }) {
  const body = (
    // 6 above and below the words however many lines they take, so a two-line part keeps the same room as one.
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingVertical: 6, maxWidth: "100%" }}>
      <View style={{ width: 16, alignItems: "center" }}>{icon}</View>
      <View style={{ flexShrink: 1, minWidth: 0 }}>{children}</View>
      {onPress ? <Chevron open={!!open} /> : null}
    </View>
  );
  if (!onPress) return <View accessible accessibilityLabel={label}>{body}</View>;
  return (
    <Squish label={`${label}. ${open ? "Hide" : "Show"} the steps`} depth={0.985} hitSlop={6} onPress={onPress} style={{ alignSelf: "flex-start", maxWidth: "100%", minHeight: touch - 12, justifyContent: "center" }}>
      {body}
    </Squish>
  );
}

/** The steps a part opens to, on a hairline rail: each one its own line, opening again to its command and output. */
function Steps({ steps }: { steps: readonly Step[] }) {
  const { c } = useTheme();
  return (
    <Animated.View entering={enter.fade} style={{ marginLeft: 7, paddingLeft: 16, borderLeftWidth: 1, borderLeftColor: c.hairline, marginBottom: 4 }}>
      {steps.map((step, i) => (
        <StepLine key={`${i}-${step.text}`} step={step} />
      ))}
    </Animated.View>
  );
}

/** The room a part's words have: the column, less the glyph (16 + 8) and the chevron (8 + 14). */
const PART_CHROME = 46;

/**
 * One part of the work: "Explored 3 files, edited lines.ts ›", opening to its steps. It may run to two lines before it
 * gives way (`lines`), and then it drops its leading clauses first ("…ran the test 50 times · 3 failed"), keeps a
 * file's name whole and elides only its folders. The failure is never the part that gets cut. In the turn that is
 * running or settling it keeps to one line, a 32pt row like the live row and the "Worked for" line it folds into, so
 * the answer under it never moves as the turn folds; two lines are for a fold you opened.
 */
export function PartLine({ steps, lines = 2 }: { steps: readonly Step[]; lines?: 1 | 2 }) {
  const { c } = useTheme();
  const type = usePartType();
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState(0);
  const sentence = sentenceOf(steps);
  const failure = sentence.failed ? ` · ${sentence.failed} failed` : "";
  const fitted = fitClauses(sentence.clauses, room - PART_CHROME, lines, proseWidth(failure));
  return (
    <View onLayout={(e) => setRoom(e.nativeEvent.layout.width)}>
      <Line icon={<ToolMark tool={sentence.lead} />} label={sentenceWords(sentence)} open={open} onPress={() => setOpen(!open)}>
        <Text numberOfLines={lines} style={type.line}>
          <ClauseRuns clauses={fitted.clauses} cut={fitted.cut} from={fitted.cut ? 1 : 0} />
          {/* No-break spaces: "· 3 failed" stays whole on one line, with the word before it. */}
          {sentence.failed ? (
            <Text>
              {"\u00a0·\u00a0"}
              <Text style={{ color: c.destructive, fontWeight: "500" }}>{`${sentence.failed}\u00a0failed`}</Text>
            </Text>
          ) : null}
        </Text>
      </Line>
      {open ? <Steps steps={steps} /> : null}
    </View>
  );
}

/** The steps open approvals hold back (store/asked.ts), worked out once for each change to the board's chats. */
const held = memoLast(heldBack);

/**
 * A run, as its parts: a failure starts a new one. While an approval waits on the very command the run's last step
 * says, that step is left out (store/asked.ts): the card docked over the box is the one place the command is printed,
 * and the step comes back the moment the ask is answered.
 */
export function RunParts({ steps, lines = 2 }: { steps: readonly Step[]; lines?: 1 | 2 }) {
  const last = steps.at(-1);
  // A yes or a no, so a part draws again only when an ask for its own step comes or goes.
  const holds = useStore((s) => last !== undefined && held(s.board.chats).has(last));
  return (
    <>
      {partsOf(holds ? steps.slice(0, -1) : steps).map((part, i) => (
        <PartLine key={i} steps={part} lines={lines} />
      ))}
    </>
  );
}

/**
 * What an ask leaves in the transcript. While it waits, one amber line, "Waiting for you", and nothing more: the card
 * docked over the box asks the question and prints the command, once. `pending`: you answered and its computer has
 * not heard yet, so the line says exactly that ("Allow queued · waking Cloud"), as quiet as an answered one. Answered,
 * a grey step like any other, carrying the command ("Allowed pnpm db:migrate --env staging").
 */
export function AskLine({
  command,
  answer,
  pending,
}: {
  command: string;
  answer?: "allowed" | "denied";
  /** You answered, and the answer has not reached its computer: what the line reads meanwhile. */
  pending?: string;
  /** No longer said here (the card says it). Kept so the transcript that still hands it over compiles. */
  ask?: string | null;
}) {
  const { c } = useTheme();
  const type = usePartType();
  if (!answer && pending) {
    return (
      <Line icon={<ToolMark tool="run" />} label={pending}>
        <Text numberOfLines={1} style={type.line}>
          {pending}
        </Text>
      </Line>
    );
  }
  if (!answer) {
    return (
      <Line icon={<PixelIcon name="state-needs-you" ink={c.warning} />} label="Waiting for you">
        <Text numberOfLines={1} style={[type.line, { color: c.warning, fontWeight: "500" }]}>
          Waiting for you
        </Text>
      </Line>
    );
  }
  const verb = answer === "allowed" ? "Allowed" : "Denied";
  return (
    <Line icon={<ToolMark tool="run" />} label={`${verb} ${command}`}>
      <Text numberOfLines={1} style={type.line}>
        {verb} <Text style={type.code}>{command}</Text>
      </Text>
    </Line>
  );
}

/** Where you stopped it: a small square and "You stopped after 41s". */
export function StopLine({ after, unowned }: { after: number | null; /** Nobody is known to have stopped it (a computer's chat). */ unowned?: boolean | undefined }) {
  const { c } = useTheme();
  const type = usePartType();
  const words = stoppedAfter(after, unowned);
  return (
    <Line icon={<View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: c.muted }} />} label={words}>
      <Text style={type.line}>{words}</Text>
    </Line>
  );
}

/**
 * The line a finished turn folds under: "Worked for 2m 38s ›" at 15 in the description grey. The last one's hairline
 * runs out to the right on the same line; the one before a steer has none.
 */
export function WorkedLine({ ms, open, rule, onToggle }: { ms: number | null; open: boolean; rule: boolean; onToggle: () => void }) {
  const { c } = useTheme();
  const type = usePartType();
  const words = workedFor(ms);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Squish label={`${words}. ${open ? "Hide" : "Show"} the work`} depth={0.985} hitSlop={4} onPress={onToggle} style={{ minHeight: touch, flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={[type.line, { fontVariant: ["tabular-nums"] }]}>{words}</Text>
        <Chevron open={open} color={c.muted} />
      </Squish>
      {rule ? <View style={{ flex: 1, height: 1, backgroundColor: c.hairline }} /> : null}
    </View>
  );
}

/** A centred date line between messages more than 30 minutes apart: 13 in the tertiary grey. */
export function DateLine({ at }: { at: number }) {
  const { t } = useTheme();
  return (
    <Text accessibilityRole="header" style={[t.meta, { textAlign: "center", fontSize: 13, lineHeight: 18 }]}>
      {dateLine(at)}
    </Text>
  );
}

/** A device worth naming beside a roster row: not where the rest run, or away. */
function placeOf(chat: Chat, usual: string | undefined): string | null {
  const d = deviceById(chat.device);
  if (d.status === "asleep" || d.status === "offline") return `${d.name} · ${d.status}`;
  return usual && chat.device !== usual ? d.name : null;
}

interface RosterProps {
  /** The chats, in the order they were started. */
  children: readonly Chat[];
  onOpen: (id: string) => void;
  /** A hold peeks at the chat without leaving (a Chief's screen). */
  onPeek?: (id: string) => void;
  /** Where the rest run (a thread's own device): a row on it doesn't say where it runs. */
  device?: string;
  /** Or, per chat, where its workspace's chats usually run (a Chief's chats span workspaces). */
  usualOf?: (chat: Chat) => string | undefined;
  /** How each stands, its subagents' asks included; by default its own phase. */
  phaseOf?: (chat: Chat) => Phase;
  /** "agent" (a thread's subagents, named without the parent's lead-in) or "chat" (a Chief's, by their own titles). */
  noun?: "agent" | "chat";
  /** No head: a sentence above already counts them (a Chief's Update). */
  bare?: boolean;
  /** Its rows show; with `onToggle`, the head folds them away. */
  open?: boolean;
  onToggle?: () => void;
}

/**
 * The chats a turn started, as one roster for a thread's subagents and a Chief's chats (Orca's: it outlives the fold
 * until every one is done): a quiet head ("Started 3 agents", "Started 5 chats"), then the chats hung on a thread, the
 * desktop sidebar's folder rule ("add like a thread thing like in the projects sidebar in the
 * desktop to when agents are spawned in a chief and make it more condensed"): a hairline from under the head's glyph
 * down to the last row's middle, and one tight row each, the whole row its tap: how it stands as its pixel mark, the
 * title at 15/500 in ink (the blue pill is for a chat named in prose), what it is doing now or where it runs in the
 * tertiary grey, "Needs you" in amber when it asks, and its engine's mark at the end.
 */
export function Roster({ children, onOpen, onPeek, device, usualOf, phaseOf, noun = "agent", bare = false, open = true, onToggle }: RosterProps) {
  const type = usePartType();
  const { c } = useTheme();
  if (!children.length) return null;
  const head = `Started ${children.length} ${children.length === 1 ? noun : `${noun}s`}`;
  const headLine = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingVertical: 6 }}>
      <View style={{ width: 16, alignItems: "center" }}>
        {/* In its ink alone: the subagent's warm tunic never leads a roster over the amber of needs-you. */}
        <PixelIcon name="tool-subagent" mono />
      </View>
      <Text style={type.line}>{head}</Text>
      {onToggle ? <Chevron open={open} /> : null}
    </View>
  );
  return (
    <View>
      {bare ? null : onToggle ? (
        <Squish
          label={`${head}. ${open ? "Hide" : "Show"} them`}
          depth={0.985}
          hitSlop={6}
          onPress={onToggle}
          style={{ alignSelf: "flex-start", minHeight: touch - 12, justifyContent: "center" }}
        >
          {headLine}
        </Squish>
      ) : (
        <View accessible accessibilityRole="header" accessibilityLabel={head}>
          {headLine}
        </View>
      )}
      {open ? (
        <Animated.View entering={bare ? undefined : enter.fade} style={{ paddingLeft: THREAD_IN, paddingBottom: 2 }}>
          {/* The thread: from under the head's glyph (or the top, with no head) to the last row's middle. */}
          <View pointerEvents="none" style={{ position: "absolute", left: 7.5, top: bare ? 4 : -4, bottom: THREAD_ROW / 2 + 2, width: 1, backgroundColor: alpha(c.muted, 0.32) }} />
          {children.map((chat) => (
            <RosterRow
              key={chat.id}
              chat={chat}
              title={noun === "chat" ? chat.title : shortTitle(chat.title)}
              phase={phaseOf ? phaseOf(chat) : chat.phase}
              place={placeOf(chat, usualOf ? usualOf(chat) : device)}
              onOpen={onOpen}
              onPeek={onPeek}
            />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** A row on the roster's thread: the desktop sidebar's tight pitch, the touch reaching 44 through its slop. */
const THREAD_ROW = 34;
/** How far the rows stand in from the thread's edge: the mark just right of the hairline. */
const THREAD_IN = 22;

/** One roster row on the thread, the whole of it a tap that opens the chat (and a hold that peeks, where offered). */
function RosterRow({ chat, title, phase, place, onOpen, onPeek }: { chat: Chat; title: string; phase: Phase; place: string | null; onOpen: (id: string) => void; onPeek?: (id: string) => void }) {
  const { c } = useTheme();
  const [held, setHeld] = useState(false);
  const word = phase === "needs" ? "Needs you" : phase === "working" ? "Working" : phase === "ready" ? "Ready" : "Done";
  // What it is doing right now while it works, else where it runs when that is worth saying.
  const doing = phase === "working" && chat.line ? chat.line : null;
  // A builder on a real computer says what became of it once it is not at work, in that state's one colour:
  // "Merged", "Left out: conflicts in a.ts", "Paused until 11:08 PM", "Failed: its agent stopped".
  const fate = chat.fate && !doing ? chat.fate : null;
  const aside = doing ?? fate?.words ?? place;
  const asideInk = fate?.tone === "bad" ? c.destructive : fate?.tone === "warn" ? c.warning : c.subtle;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={[title, fate?.words ?? word, doing, place ? `on ${place}` : null].filter(Boolean).join(", ")}
      accessibilityHint={onPeek ? "Opens the chat. Hold to peek at it." : "Opens the chat."}
      accessibilityActions={onPeek ? [{ name: "peek", label: "Peek" }] : undefined}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === "peek" && onPeek?.(chat.id)}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onOpen(chat.id);
      }}
      onLongPress={
        onPeek
          ? () => {
              haptic.soft();
              onPeek(chat.id);
            }
          : undefined
      }
      delayLongPress={350}
      hitSlop={{ top: 5, bottom: 5 }}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, height: THREAD_ROW, marginHorizontal: -6, paddingHorizontal: 6, borderRadius: 8, backgroundColor: held ? alpha(c.text, 0.05) : undefined }}
    >
      <View style={{ width: 16, alignItems: "center" }}>
        {phase === "needs" ? (
          <PixelIcon name="state-needs-you" ink={c.warning} />
        ) : phase === "working" ? (
          <PixelIcon name="state-working" />
        ) : fate?.tone === "bad" ? (
          // A builder that failed, was left out or is paused is not done: it wears no check.
          <PixelIcon name="state-failed" ink={c.destructive} />
        ) : fate?.tone === "warn" ? (
          <PixelIcon name="state-stopped" ink={c.warning} />
        ) : (
          <PixelIcon name="state-done" />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, lineHeight: 20, fontWeight: "500", color: phase === "done" ? c.muted : c.text }}>
          {title}
        </Text>
        {phase === "needs" ? <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: "500", color: c.warning }}>Needs you</Text> : null}
        {aside && phase !== "needs" ? (
          // It takes only the room the title leaves: it gives way before the title does.
          <Text numberOfLines={1} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, fontSize: 13, lineHeight: 18, color: asideInk }}>
            {aside}
          </Text>
        ) : null}
      </View>
      <EngineLogo engine={chat.engine} size={13} />
    </Pressable>
  );
}

/** A subagent's title without its parent's lead-in ("Audit: the thread" reads "The thread" under the audit). */
export function shortTitle(title: string): string {
  const rest = title.replace(/^[^:]{1,24}:\s+/, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** A subagent's turn ends by handing its answer back: a plain grey line, not a link. */
export function ReportedLine({ to, mark }: { to: string; /** The parent's engine mark, as its "From" caption wears it. */ mark?: React.ReactNode }) {
  const type = usePartType();
  return (
    <Line icon={mark ?? <PixelIcon name="tool-subagent" mono />} label={`Reported back to ${to}`}>
      <Text numberOfLines={1} style={type.line}>
        Reported back to {to}
      </Text>
    </Line>
  );
}
