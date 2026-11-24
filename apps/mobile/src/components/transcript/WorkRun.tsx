// A run of tool calls as the desktop's trace lines (apps/web/src/components/transcript/WorkRun.tsx, packages/ui/src/ai/
// trace.tsx): the pixel tool mark, the verb in grey, the subject in mono, the lines it added and removed, and a quiet
// note at the right. One step is its own line. Several fold into one line that says what the run did ("Searched for
// usage_events, read 3 files, ran the rollup tests +64 ›"), opening to every step under a hairline rail. While the run
// is the live one its steps stay open in a short window pinned to the newest, each arriving one rising in, and the step
// still going shimmers with its clock; a command shows what it has printed so far under its line. A run you watched
// stays as you saw it when the agent moves on; a tap opens or closes it for good. A step that ran a command or read
// files opens to the command as it ran and its output, or the files, as links.
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, type TextStyle, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { Step } from "../../board/model";
import { duration, ease, enter } from "../../motion";
import { alpha, mono, useTheme } from "../../theme";
import { Icon } from "../Icon";
import { PixelIcon, ToolMark } from "../Pixel";
import { Squish } from "../Squish";
import { CodeShell } from "./CodeBlock";
import { clock, type Counts, type LiveParts, leadTool, runCounts, stepParts, summarize } from "./lines";
import { Shimmer } from "./Shimmer";

/**
 * A step arriving while you watch fades into its slot (stream.css step-in). Not a custom Keyframe: on the web those pin
 * the element where it first landed once they end, which strands a step when the window moves under it.
 */
const stepIn = enter.fade;

/** How many steps the live window keeps in view (stream.css .work-live, min(11rem, 40vh)). */
const WINDOW = 5;

/** The trace line's type: the desktop's 13px grey at phone scale. */
export function useTrace() {
  const { c, t } = useTheme();
  return {
    line: { ...t.label, fontWeight: "400", color: c.muted } as TextStyle,
    subject: { fontFamily: mono, fontSize: 13, color: c.soft } as TextStyle,
    note: t.meta as TextStyle,
  };
}

export function CountsText({ counts }: { counts: Counts }) {
  const { c } = useTheme();
  const style: TextStyle = { fontFamily: mono, fontSize: 12, fontVariant: ["tabular-nums"] };
  return (
    <View style={{ flexDirection: "row", gap: 6, flexShrink: 0 }}>
      {counts.added || !counts.removed ? <Text style={[style, { color: c.added }]}>+{counts.added}</Text> : null}
      {counts.removed ? <Text style={[style, { color: c.removed }]}>−{counts.removed}</Text> : null}
    </View>
  );
}

/**
 * The chevron a line that opens wears: faint at rest, full while open, turning down when open over 150ms on the snap
 * curve (the trace trigger's rotate-90). It is a glyph, not glass, so it may fade.
 */
export function Disclosure({ open, hidden = false }: { open: boolean; hidden?: boolean }) {
  const { c } = useTheme();
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.value = withTiming(open ? 1 : 0, { duration: duration.fast, easing: ease.snap });
  }, [open, turn]);
  const turned = useAnimatedStyle(() => ({ opacity: 0.7 + turn.value * 0.3, transform: [{ rotate: `${turn.value * 90}deg` }] }));
  if (hidden) return null;
  return (
    <Animated.View style={turned}>
      <Icon name="chevronRight" size={14} color={c.muted} />
    </Animated.View>
  );
}

/** One line: icon, title, counts, note. `pressable` lines are 44pt to hit while drawn 32pt tall. */
function Line({ icon, title, counts, note, chevron, label, onPress }: { icon: ReactNode; title: ReactNode; counts?: Counts | null; note?: ReactNode; chevron?: ReactNode; label?: string; onPress?: () => void }) {
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, maxWidth: "100%" }}>
      {icon ? <View style={{ width: 16, alignItems: "center" }}>{icon}</View> : null}
      <View style={{ flexShrink: 1, minWidth: 0 }}>{title}</View>
      {counts ? <CountsText counts={counts} /> : null}
      {note}
      {chevron}
    </View>
  );
  if (!onPress) return body;
  return (
    <Squish
      label={label ?? ""}
      depth={0.985}
      hitSlop={6}
      onPress={onPress}
      style={{ alignSelf: "flex-start", maxWidth: "100%" }}
    >
      {body}
    </Squish>
  );
}

/** A file or an address in a step's log, as a link (LogText.tsx): underlined in a faint version of its colour. */
function LogLink({ text }: { text: string }) {
  const { c } = useTheme();
  return <Text style={{ textDecorationLine: "underline", textDecorationColor: alpha(c.muted, 0.35) }}>{text}</Text>;
}

/** An opened step shows this many lines of what its command printed (DECISIONS.md: command plus up to ~12 lines). */
const OUTPUT_LINES = 12;
const lineCount = (text: string) => text.split("\n").length;
const clipped = (text: string) => text.split("\n").slice(0, OUTPUT_LINES).join("\n");

/** What an opened step shows, on the rail: the command and its output in the code shell, or the files it read. */
function StepLog({ log }: { log: NonNullable<ReturnType<typeof stepParts>["log"]> }) {
  const { c, t } = useTheme();
  if (log.files) {
    return (
      <View style={{ paddingVertical: 4, gap: 2 }}>
        {log.files.map((file) => (
          <Text key={file} numberOfLines={1} style={[t.code, { color: c.soft }]}>
            <LogLink text={file} />
          </Text>
        ))}
      </View>
    );
  }
  return (
    <View style={{ paddingVertical: 4 }}>
      <CodeShell>
        <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: log.output ? 1 : 0, borderBottomColor: c.hairline }}>
          <Text selectable style={[t.code, { color: c.muted }]}>
            {log.command}
          </Text>
        </View>
        {log.output ? (
          <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text selectable style={[t.code, { color: alpha(c.text, 0.9) }]}>
              {clipped(log.output)}
            </Text>
            {lineCount(log.output) > OUTPUT_LINES ? <Text style={[t.meta, { marginTop: 4 }]}>{lineCount(log.output) - OUTPUT_LINES} more lines</Text> : null}
          </View>
        ) : null}
      </CodeShell>
    </View>
  );
}

/** A finished step's line, opening to its log when it has one. */
export function StepLine({ step }: { step: Step }) {
  const { c } = useTheme();
  const trace = useTrace();
  const [open, setOpen] = useState(false);
  const parts = stepParts(step);
  const title = (
    <Text numberOfLines={1} style={trace.line}>
      {parts.verb}
      {parts.subject ? " " : ""}
      {parts.subject ? <Text style={parts.code ? trace.subject : undefined}>{parts.subject}</Text> : null}
    </Text>
  );
  const note = parts.note ? (
    <Text numberOfLines={1} style={[trace.note, { flexShrink: 1 }]}>
      {parts.note}
    </Text>
  ) : null;
  if (!parts.log) return <Line icon={<ToolMark tool={step.tool} />} title={title} counts={parts.counts} note={note} />;
  return (
    <View>
      <Line icon={<ToolMark tool={step.tool} />} title={title} counts={parts.counts} note={note} chevron={<Disclosure open={open} />} label={`${step.text}. ${open ? "Hide" : "Show"} the ${parts.log.files ? "files" : "output"}`} onPress={() => setOpen(!open)} />
      {open ? (
        <Animated.View entering={enter.fade} style={{ marginLeft: 7, paddingLeft: 16, borderLeftWidth: 1, borderLeftColor: c.hairline, marginBottom: 4 }}>
          <StepLog log={parts.log} />
        </Animated.View>
      ) : null}
    </View>
  );
}

/** How long the live line has said what it says: the running step's clock, from when it changed. */
function useSince(text: string) {
  const since = useRef({ text, at: Date.now() });
  if (since.current.text !== text) since.current = { text, at: Date.now() };
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return Date.now() - since.current.at;
}

/** The step still going: it shimmers, counts its seconds, and a command shows its output so far under it. */
export function RunningLine({ live, raw }: { live: LiveParts; raw: string }) {
  const { c, t } = useTheme();
  const trace = useTrace();
  const elapsed = useSince(raw);
  if (live.kind === "thought") {
    return <Line icon={null} title={<Shimmer text={live.verb} style={trace.line} />} />;
  }
  const title = live.code ? `${live.verb} ` : `${live.verb} ${live.subject}`;
  return (
    <View>
      <Line
        icon={<ToolMark tool={live.tool} />}
        title={
          <View style={{ flexDirection: "row", alignItems: "baseline", minWidth: 0 }}>
            <Shimmer text={title.trimEnd()} style={trace.line} />
            {live.code ? (
              <Text numberOfLines={1} style={[trace.subject, { flexShrink: 1 }]}>
                {`\u00a0${live.subject}`}
              </Text>
            ) : null}
          </View>
        }
        counts={live.counts}
        note={<Text style={trace.note}>{clock(elapsed)}</Text>}
      />
      {live.output ? (
        <Animated.View key={live.output} entering={enter.fade} style={{ paddingLeft: 12, paddingBottom: 4 }}>
          <CodeShell>
            <Text accessibilityLabel="Output so far" numberOfLines={4} style={[t.code, { lineHeight: 19, color: c.muted, paddingHorizontal: 12, paddingVertical: 8 }]}>
              {live.output}
            </Text>
          </CodeShell>
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * A run's steps. `active`: the live run, open in its window. `opened`: open (or shut) by hand, for good; undefined, it
 * follows the run. `fresh`: steps that weren't there on first paint, which rise in.
 */
export function RunSteps({ steps, live, raw, active, opened, onDisclose, isFresh }: { steps: readonly Step[]; live?: LiveParts | null; raw?: string; active: boolean; opened?: boolean; onDisclose?: (open: boolean) => void; isFresh?: (key: string) => boolean }) {
  const { c } = useTheme();
  const trace = useTrace();
  const [own, setOwn] = useState<boolean | undefined>(undefined);
  const byHand = opened ?? own;
 // Watched at work, it stays as you saw it once the agent moves on; a run from history is folded.
  const [watched, setWatched] = useState(active);
  useEffect(() => {
    if (active) setWatched(true);
  }, [active]);
  const choose = (open: boolean) => (onDisclose ? onDisclose(open) : setOwn(open));
  const running = active && live ? live : null;
  const count = steps.length + (running && running.kind !== "thought" ? 1 : 0);
  if (count === 0) return running ? <RunningLine live={running} raw={raw ?? ""} /> : null;
  // Only the live run's arrivals rise in; a run opened, folded or remounted shows its steps still.
  const rise = (key: string) => (active && isFresh?.(key) ? stepIn : undefined);
  if (count === 1 && byHand !== true) {
    if (running && !steps.length) return <RunningLine live={running} raw={raw ?? ""} />;
    return (
      <>
        <Animated.View entering={rise(`0-${steps[0]!.text}`)}>
          <StepLine step={steps[0]!} />
        </Animated.View>
        {/* A thought after its one step: the live end, under the step it follows. */}
        {running?.kind === "thought" ? <RunningLine live={running} raw={raw ?? ""} /> : null}
      </>
    );
  }
  const open = byHand ?? (active || watched);
  const windowed = byHand === undefined && active;
  const shown = windowed ? steps.slice(-(running ? WINDOW - 1 : WINDOW)) : steps;
  const clipped = shown.length < steps.length;
  const lead = leadTool(steps) ?? running?.tool ?? null;
  const counts = runCounts(steps);
  const said = steps.length > 1 ? summarize(steps) : steps[0] ? steps[0].text : running?.verb ?? "Working";
  const title = <Shimmer text={said} style={trace.line} on={active && !!running} />;
  return (
    <View>
      <Line
        icon={lead ? <ToolMark tool={lead} /> : <PixelIcon name="state-working" animate={active && !!running} />}
        title={active && running ? title : <Text numberOfLines={1} style={trace.line}>{said}</Text>}
        counts={counts}
        chevron={<Disclosure open={open} hidden={windowed} />}
        label={`${said}. ${open ? "Hide" : "Show"} the steps`}
        onPress={() => choose(!open)}
      />
      {open ? (
        <Animated.View entering={byHand ? enter.fade : undefined} style={{ marginLeft: 7, marginTop: 2, paddingBottom: 4, paddingLeft: 16, borderLeftWidth: 1, borderLeftColor: c.hairline }}>
          {shown.map((step, i) => {
            const key = `${steps.length - shown.length + i}-${step.text}`;
            return (
              <Animated.View key={key} entering={rise(key)}>
                <StepLine step={step} />
              </Animated.View>
            );
          })}
          {running && running.kind !== "thought" ? (
            <Animated.View key="running">
              <RunningLine live={running} raw={raw ?? ""} />
            </Animated.View>
          ) : null}
          {clipped ? (
            // More above: the window's top edge fades into the page, as the desktop's mask does.
            <LinearGradient pointerEvents="none" colors={[c.panel, alpha(c.panel, 0)]} style={{ position: "absolute", top: 0, left: 0, right: 0, height: 24 }} />
          ) : null}
        </Animated.View>
      ) : null}
      {running?.kind === "thought" && open ? (
        <View style={{ marginLeft: 7, paddingLeft: 16, borderLeftWidth: 1, borderLeftColor: c.hairline }}>
          <RunningLine live={running} raw={raw ?? ""} />
        </View>
      ) : null}
    </View>
  );
}

