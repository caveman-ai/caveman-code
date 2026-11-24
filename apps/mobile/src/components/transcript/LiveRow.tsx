// The one live row that closes a running turn (DECISIONS.md "Live run", O5): the working caveman at 16pt, his rock
// tapping in place (he never hops), then one present-tense sentence on one line, so the row is always 32pt tall and
// never moves the screen. What the run has finished is said in the description grey ("…edited lines.ts"), the oldest
// clauses giving way first; only what it is doing now shimmers ("running the relay suite"). No line counts, no
// spinner, no clock (the status capsule holds the screen's only one), no stop button (the box has it). A parent
// waiting on its agents says how many ("Waiting on 2 agents"). A tap opens the steps the run has finished, above it. Under Reduce Motion the caveman holds still and the words
// don't shimmer; VoiceOver hears what it is doing at most every ten seconds.
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Text, type TextStyle, View } from "react-native";
import Animated, { interpolateColor, type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import type { Chat, Step, Tool } from "../../board/model";
import { enter, useLoop, useReducedMotion } from "../../motion";
import { type Clause, lower, sentenceOf } from "../../thread/fold";
import { useTheme } from "../../theme";
import { Sprite } from "../Sprite";
import { Squish } from "../Squish";
import { liveParts } from "./lines";
import { Chevron, usePartType } from "./Parts";
import { StepLine } from "./WorkRun";

/** VoiceOver hears the live row at most this often. */
const SPEAK_EVERY = 10_000;

/** What the run is doing now: its verb, what it works on (mono when it names code), what a command has printed. */
export interface Now {
  verb: string;
  subject: string;
  code: boolean;
  output: string;
}

/** A command's output that says it is over ("29/29 passed", "exit 1"), not how far it has got ("20/29"). */
const FINISHED = /\b(passed|failed|done|complete[d]?|finished|exit(ed)?(\s+\d+)?|ok)\b/i;

/**
 * What the run is doing now, in the present tense ("Running vitest transcript", "Editing Transcript.tsx"), or once a
 * command's result has landed, in the past ("Ran vitest transcript · 29/29 passed").
 */
export function nowOf(line: string, tool: Tool): Now {
  const live = liveParts(line, tool);
  if (live.kind === "command") return { verb: FINISHED.test(live.output) ? "Ran" : "Running", subject: live.subject, code: true, output: live.output };
  if (live.kind === "tool") return { verb: live.verb, subject: live.subject, code: live.code, output: "" };
  return { verb: live.verb || "Thinking", subject: "", code: false, output: "" };
}

/** The same, as plain words: "Running vitest transcript · 20/29". */
export const nowWords = (now: Now) => `${now.verb}${now.subject ? ` ${now.subject}` : ""}${now.output ? ` · ${now.output}` : ""}`;

/** What the run is doing now, as words (a board row's live line). */
export const nowClause = (line: string, tool: Tool): string => nowWords(nowOf(line, tool));

/** The desktop's shimmer sweep (Shimmer.tsx): once every 1.8s, a band about a quarter of the clause wide. */
const SWEEP_MS = 1800;
const BAND = 0.26;

/** One word of the current clause: lit from the grey toward ink as the band passes over it. */
function LitWord({ text, at, clock, style, ink }: { text: string; at: number; clock: SharedValue<number>; style: TextStyle; ink: string }) {
  const from = (style.color as string) ?? ink;
  const lit = useAnimatedStyle(() => {
    const centre = -0.34 + clock.value * 1.68;
    const near = Math.max(0, 1 - Math.abs(at - centre) / BAND);
    return { color: interpolateColor(near, [0, 1], [from, ink]) };
  });
  return <Animated.Text style={[style, lit]}>{text}</Animated.Text>;
}

/** A word of the sentence and how it reads: the finished part in its tiers, the current clause lit. */
type Piece = { text: string; style: TextStyle; lit?: number };

/** About how wide the live row's words set: 15pt prose, 14pt mono. */
const width = (text: string, code = false) => text.length * (code ? 8.45 : 7.3);

/** How wide the current clause sets: its words in prose, what it works on in mono when that names code. */
const nowWidth = (now: Now) => width(`${now.verb} `) + (now.subject ? width(now.subject, now.code) : 0) + (now.output ? width(` · ${now.output}`) : 0);

/**
 * Which finished clauses fit beside the current one on the row's one line: the latest ones, those before them dropped
 * ("…edited lines.ts, editing Transcript.tsx"). When none fits, the current clause has the line to itself, with no
 * "…": what it finished is a tap away, above it.
 */
export function fitLive(done: readonly Clause[], now: Now, room: number): { done: Clause[]; cut: boolean } {
  if (room <= 0) return { done: [...done], cut: false };
  let used = nowWidth(now) + (done.length ? width(", ") : 0);
  const kept: Clause[] = [];
  for (let i = done.length - 1; i >= 0; i--) {
    const cl = done[i]!;
    const w = width(`${cl.verb}${cl.measure ? " " : ""}, `) + (cl.measure ? width(cl.measure, cl.code) : 0);
    if (used + w + (i > 0 ? width("…") : 0) > room) break;
    used += w;
    kept.unshift(cl);
  }
  return { done: kept, cut: kept.length > 0 && kept.length < done.length };
}

/**
 * The sentence on one line, so the row never changes height (O5: it never moves the screen): what it finished in the
 * description grey, the latest clauses first to stay, then only the current clause lit. Every path and command is mono
 * 14, the current clause's too, lit as it shimmers. No line counts: green and red stay on the Changes pill and the
 * Ready rows.
 */
function Sentence({ done: all, now }: { done: readonly Clause[]; now: Now }) {
  const { c } = useTheme();
  const type = usePartType();
  const still = useReducedMotion();
  const clock = useLoop(SWEEP_MS, !still);
  const [room, setRoom] = useState(0);
  const { done, cut } = fitLive(all, now, room);
  const pieces: Piece[] = [];
  const words = (text: string, style: TextStyle) => {
    for (const w of text.split(/(?<=\s)/)) if (w) pieces.push({ text: w, style });
  };
  if (cut) pieces.push({ text: "…", style: type.line });
  done.forEach((clause, i) => {
    words(`${i || cut ? lower(clause.verb) : clause.verb}${clause.measure ? " " : ""}`, type.line);
    if (clause.measure) words(clause.measure, clause.code ? { ...type.line, ...type.code } : { ...type.line, ...type.measure });
    pieces.push({ text: ", ", style: type.line });
  });
  // The current clause, its words lit in turn as the band passes along it.
  const verb = done.length ? lower(now.verb) : now.verb;
  const runs: { text: string; style: TextStyle }[] = [{ text: verb, style: type.line }];
  if (now.subject) runs.push({ text: ` ${now.subject}`, style: now.code ? { ...type.line, ...type.code } : type.line });
  if (now.output) runs.push({ text: ` · ${now.output}`, style: type.line });
  const total = runs.reduce((n, r) => n + r.text.length, 0);
  let offset = 0;
  for (const run of runs) {
    for (const w of run.text.split(/(?<=\s)/).filter(Boolean)) {
      pieces.push({ text: w, style: run.style, lit: (offset + w.length / 2) / Math.max(1, total) });
      offset += w.length;
    }
  }
  // One line of running text, its words nested runs, so the spaces between them hold.
  return (
    <View onLayout={(e) => setRoom(e.nativeEvent.layout.width)} style={{ flex: 1, minWidth: 0, height: 20, overflow: "hidden" }}>
      <Text numberOfLines={1} style={type.line}>
        {pieces.map((p, i) =>
          p.lit !== undefined && !still ? (
            <LitWord key={i} text={p.text} at={p.lit} clock={clock} style={p.style} ink={c.text} />
          ) : (
            <Text key={i} style={p.style}>
              {p.text}
            </Text>
          ),
        )}
      </Text>
    </View>
  );
}

/** The live row is this tall, whatever it says. */
export const LIVE_ROW = 32;

export function LiveRow({ steps, line, tool, kids = [] }: { steps: readonly Step[]; line: string; tool: Tool; /** This chat's own subagents: a parent waiting on them says how many. */ kids?: readonly Chat[] }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const done = steps.length ? sentenceOf(steps).clauses : [];
  // A line that only says again the step just finished ("Read audit-state.md, reading audit-state.md") is stale: the
  // engine has moved past it and not said what's next yet.
  const out = kids.filter((k) => k.phase === "working" || k.phase === "needs").length;
  const waiting = /^waiting on (its|the|\d+) agents?/i.test(line.trim());
  const now0: Now = waiting ? { verb: out ? `Waiting on ${out} ${out === 1 ? "agent" : "agents"}` : "Bringing its agents' work together", subject: "", code: false, output: "" } : nowOf(line, tool);
  const said0 = nowWords(now0);
  const last = done.at(-1);
  const stale = !!last?.measure && said0.toLowerCase().endsWith(last.measure.toLowerCase()) && said0.slice(0, 3).toLowerCase() === last.verb.slice(0, 3).toLowerCase();
  const nowParts: Now = stale ? { verb: "Thinking", subject: "", code: false, output: "" } : now0;
  const now = nowWords(nowParts);
  const said = done.length ? `${now}, after: ${done.map((cl) => `${cl.verb} ${cl.measure}`).join(", ")}` : now;

  // Spoken at most every ten seconds, so a screen reader isn't talked over by every step.
  const spoke = useRef(0);
  useEffect(() => {
    if (Date.now() - spoke.current < SPEAK_EVERY) return;
    spoke.current = Date.now();
    AccessibilityInfo.announceForAccessibility(now);
  }, [now]);

  const row = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: LIVE_ROW }}>
      <View style={{ width: 16, height: 20, alignItems: "center", justifyContent: "center" }}>
        <Sprite character="caveman" tone="medium-light" pose="working" size={16} />
      </View>
      <Sentence done={done} now={nowParts} />
      {steps.length ? (
        <View style={{ height: 20, justifyContent: "center" }}>
          <Chevron open={open} />
        </View>
      ) : null}
    </View>
  );
  return (
    <View>
      {open ? (
        <Animated.View entering={enter.fade} style={{ marginLeft: 7, paddingLeft: 16, borderLeftWidth: 1, borderLeftColor: c.hairline, marginBottom: 2 }}>
          {steps.map((step, i) => (
            <StepLine key={`${i}-${step.text}`} step={step} />
          ))}
        </Animated.View>
      ) : null}
      {steps.length ? (
        <Squish label={`Working: ${said}. ${open ? "Hide" : "Show"} the steps`} depth={0.985} onPress={() => setOpen(!open)} style={{ width: "100%", height: LIVE_ROW, justifyContent: "center" }}>
          {row}
        </Squish>
      ) : (
        <View accessible accessibilityLabel={`Working: ${said}`}>
          {row}
        </View>
      )}
    </View>
  );
}
