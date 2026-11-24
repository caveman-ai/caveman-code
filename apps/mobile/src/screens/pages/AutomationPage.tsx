// One automation, opened (apps/web/src/routes/automations/Detail.tsx, as a phone reads it: GitHub's workflow page and
// native agent page, one thing at a time). Its project over its name, what it does, who runs it (the engine's logo in
// its own colours, its name, the model), and its state in one line: Active and when it runs next, its newest run
// failed, Paused, or what keeps its triggers off, with the way to fix that. Then its runs as a CI list: each its mark,
// what it did or what went wrong, what started it, how long it took and on which model, its age; the newest open under
// its row as that run's own thread in short (why it failed and the one fix, its steps, its closing words), any other
// one tap away. Then how it is set up (what starts it, the agent its step runs, where, whose), what it was told to do,
// and where its file lives. Run now and Pause stand at the foot, in reach of a thumb; the bar's ··· holds the rest.
// Never a cost: spend lives in Settings.
import * as Clipboard from "expo-clipboard";
import { Fragment, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance, Text, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import * as script from "../../board/script";
import { toolOf } from "../../board/model";
import { runsOnName } from "../../board/places";
import { Icon } from "../../components/Icon";
import { PixelIcon } from "../../components/Pixel";
import { EngineText } from "../../components/Transcript";
import { liveParts } from "../../components/transcript/lines";
import { RunSteps } from "../../components/transcript/WorkRun";
import { BrandMark } from "../../components/ui/BrandMark";
import { Button } from "../../components/ui/Button";
import { EngineLogo } from "../../components/ui/EngineLogo";
import type { MenuEntry } from "../../components/ui/Menu";
import { openChat } from "../../nav/ref";
import { layout, useTheme } from "../../theme";
import { TopBar } from "../../shell/TopBar";
import { Page } from "../Page";
import { type Automation, deleteWords, openRunOf, type Run, runHeadline, statusOf, statusRest, triggerKind } from "./automations-model";
import { automations, cancelRun, runNow, setEnabled } from "./automations-store";
import { FactRow, FilePath, Foot, FootCircle, FootPill, Output, PageHead, Rule, RunnerLine, RunRow, SectionHead, StatusDot, TITLE_PAST, WORDS_X } from "./automation-parts";
import { age, Confirm, took } from "./parts";

/** How many runs the list shows before "Show all". */
const RUNS_SHOWN = 5;

/** The file's own name, its folder left to Copy path. */
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The line under its name, unless it only says the name again (Detail.tsx). */
const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The state in one line: a dot in its colour, the word in ink, then when it runs next (or why it doesn't) in grey. */
function StatusLine({ automation: a, onOpenPr }: { automation: Automation; onOpenPr: () => void }) {
  const { c, t } = useTheme();
  const status = statusOf(a);
  const color = status.tone === "muted" ? c.subtle : c[status.tone];
  return (
    <View style={{ marginTop: 8, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StatusDot color={color} hollow={!a.enabled} />
        <Text numberOfLines={1} style={[t.row, { fontSize: 15, flexShrink: 1 }]}>
          <Text style={{ fontWeight: "500" }}>{status.word}</Text>
          <Text style={{ color: c.muted }}> · {statusRest(a)}</Text>
        </Text>
      </View>
      {status.note ? (
        <View style={{ gap: 10 }}>
          <Text style={[t.small, { fontSize: 14, lineHeight: 20 }]}>{status.note}</Text>
          {a.whose === "project" ? <Button label="Open a pull request" icon="pullRequest" onPress={onOpenPr} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** "#476 opened · 3m 12s · Sonnet 5.5": what started a run, how long it took (or has taken), on which model. */
function runMeta(r: Run, now: number): string {
  const long = r.took ?? (r.status === "running" ? now - r.startedAt : undefined);
  return [r.who, long !== undefined ? took(long) : null, r.model].filter(Boolean).join(" · ");
}

/**
 * An open run's body, its thread in short. Failed: why, in its step's own words, what it printed, and the one thing
 * that fixes it, which starts a chat to do it, beside Run again. Running: its steps as they come and Cancel run.
 * Ended: its steps folded to one line and its closing words.
 */
function RunBody({ automation: a, run: r, now, onFix, onRunAgain }: { automation: Automation; run: Run; now: number; onFix: (prompt: string) => void; onRunAgain: () => void }) {
  const { c, t } = useTheme();
  const [asking, setAsking] = useState(false);
  const live = r.status === "running";
  return (
    <>
      {r.why ? (
        <View style={{ gap: 10 }}>
          <Text style={[t.body, { fontSize: 15, lineHeight: 22 }]}>
            <Text style={{ color: c.destructive }}>
              {r.why.reason}
              {r.why.step ? ` in ${r.why.step}` : ""}.
            </Text>
            {r.why.words ? <Text style={{ color: c.muted }}> {r.why.words}</Text> : null}
          </Text>
          {r.why.output ? <Output text={r.why.output} /> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 }}>
            {r.why.fix ? <Button label={r.why.fix.label} icon={<EngineLogo engine={a.engine} size={16} />} onPress={() => onFix(r.why!.fix!.prompt)} accessibilityLabel={`${r.why.fix.label}: starts a chat in ${a.project} that does it`} /> : null}
            <Button label="Run again" icon="retry" variant="ghost" onPress={onRunAgain} />
          </View>
        </View>
      ) : null}
      {r.steps.length || live ? <RunSteps steps={r.steps} live={r.live ? liveParts(r.live, toolOf(r.live)) : null} active={live} /> : null}
      {r.summary ? <EngineText text={r.summary} at={0} /> : null}
      {r.status === "cancelled" ? <Text style={[t.small, { fontSize: 14 }]}>Cancelled after {took(r.took ?? now - r.startedAt)}. What it did stays; its branch and commits are where it left them.</Text> : null}
      {live ? (
        <View style={{ marginLeft: -16 }}>
          <Button label="Cancel run" icon="stop" variant="ghost" onPress={() => setAsking(true)} />
        </View>
      ) : null}
      <Confirm
        open={asking}
        onClose={() => setAsking(false)}
        title="Cancel this run?"
        line="Its steps stop and what it hasn't applied is dropped. The branch and what it committed stay."
        confirm="Cancel run"
        cancel="Keep it running"
        onConfirm={() => cancelRun(a, r)}
      />
    </>
  );
}

export function AutomationPage({
  automation: a,
  now,
  onBack,
  onOpen,
  onOpenAgent,
  onNotify,
}: {
  automation: Automation;
  now: number;
  onBack: () => void;
  /** Opens another automation in this one's place (its copy, once duplicated). */
  onOpen: (id: string) => void;
  /** Pushes the agent its step runs. */
  onOpenAgent: (name: string) => void;
  onNotify?: (text: string) => void;
}) {
  const { c, t } = useTheme();
  const scroller = useRef<ScrollViewInstance>(null);
  const runsY = useRef(0);
  const edgeY = useSharedValue(0);
  const [past, setPast] = useState(false);
  // undefined: the newest is open; null: you folded it; an id: the one you opened.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [all, setAll] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const open = openRunOf(a.runs, picked);
  const line = a.description && words(a.description) !== words(a.title) ? a.description : null;
  const status = statusOf(a);
  const kind = triggerKind(a.trigger);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const now = e.nativeEvent.contentOffset.y > TITLE_PAST;
    if (now !== past) setPast(now);
  };

  const start = () => {
    const id = runNow(a);
    setPicked(id);
    // The run lands at the top of its list: bring the list into view if you had read past it.
    scroller.current?.scrollTo({ y: Math.max(0, runsY.current - 120), animated: true });
  };
  const fix = (prompt: string) => {
    const id = script.start(prompt, { engine: a.engine, model: a.model, effort: "high", repo: a.project });
    openChat(id);
  };
  const openPr = () => onNotify?.(`Opened a pull request with ${fileName(a.path)}. Its triggers turn on once it merges.`);

  const more: MenuEntry[] = [
    {
      label: "Duplicate",
      icon: <PixelIcon name="tool-create" />,
      onPress: () => {
        const copy = { ...a, id: `${a.id}-copy-${Date.now()}`, title: `${a.title} copy`, path: a.path.replace(/\.md$/, "-copy.md"), runs: [] };
        // The copy opens in this one's place, as the desktop's does, and says the file it wrote.
        automations.set((list) => [...list, copy]);
        onOpen(copy.id);
        onNotify?.(`Wrote ${copy.path}.`);
      },
    },
    {
      label: "Copy path",
      icon: <PixelIcon name="artifact-link" />,
      onPress: () => {
        void Clipboard.setStringAsync(a.path).catch(() => {});
        onNotify?.("Path copied");
      },
    },
    ...(a.whose === "project" && a.off ? [{ label: "Open a pull request", icon: <PixelIcon name="artifact-pr" />, onPress: openPr }] : []),
    { type: "separator" },
    // After the menu has gone, so the sheet doesn't rise under it.
    { label: "Delete", icon: <PixelIcon name="state-failed" ink={c.destructive} />, destructive: true, onPress: () => setTimeout(() => setDeleting(true), 150) },
  ];
  const remove = () => {
    automations.set((list) => list.filter((x) => x.id !== a.id));
    onNotify?.(deleteWords(a).done);
    onBack();
  };

  const runs = all ? a.runs : a.runs.slice(0, RUNS_SHOWN);
  const first = a.enabled && a.nextRunAt && !a.off ? `Its first run is ${statusRest(a).replace(/^Next run /, "")}, or press Run now.` : "Press Run now to try it.";

  return (
    <View style={{ flex: 1 }}>
      <Page ref={scroller} scrollY={edgeY} onScroll={onScroll} contentContainerStyle={{ paddingTop: 0 }}>
        <PageHead project={a.project} title={a.title} line={line ?? undefined}>
          <RunnerLine engine={a.engine} model={a.model} />
          <StatusLine automation={a} onOpenPr={openPr} />
        </PageHead>

        <View onLayout={(e) => (runsY.current = e.nativeEvent.layout.y)}>
          <SectionHead label="Runs" count={a.runs.length || undefined} />
        </View>
        {a.runs.length === 0 ? (
          <Text style={[t.small, { fontSize: 15, lineHeight: 22, paddingHorizontal: layout.inset, paddingTop: 4 }]}>No runs yet. {first}</Text>
        ) : (
          runs.map((r, i) => (
            <Fragment key={r.id}>
              {i ? <Rule /> : null}
              <RunRow status={r.status} title={runHeadline(r)} meta={runMeta(r, now)} at={age(r.startedAt, now)} open={r.id === open} onPress={() => setPicked(r.id === open ? null : r.id)}>
                <RunBody automation={a} run={r} now={now} onFix={fix} onRunAgain={start} />
              </RunRow>
            </Fragment>
          ))
        )}
        {a.runs.length > RUNS_SHOWN ? (
          <View style={{ paddingLeft: WORDS_X - 16 }}>
            <Button label={all ? "Show fewer" : `Show all ${a.runs.length}`} variant="ghost" onPress={() => setAll((x) => !x)} />
          </View>
        ) : null}

        <SectionHead label="Setup" />
        <FactRow
          icon={kind === "github" ? <BrandMark name="github" size={16} /> : kind === "schedule" ? <Icon name="clock" size={17} color={c.muted} /> : <PixelIcon name="automations" />}
          label={kind === "github" ? "GitHub" : kind === "schedule" ? "Schedule" : "Trigger"}
          value={a.more ? `${a.trigger} +${a.more}` : a.trigger}
        />
        {a.agent ? (
          <>
            <Rule />
            <FactRow icon={<PixelIcon name="tool-subagent" />} label="Agent" value={a.agent} onPress={() => onOpenAgent(a.agent!)} accessibilityLabel={`Agent, ${a.agent}. Opens it`} />
          </>
        ) : null}
        <Rule />
        <FactRow icon={<PixelIcon name={a.where === "cloud" ? "computer-cloud" : "computer-this-mac"} />} label="Runs on" value={runsOnName(a.where)} />
        <Rule />
        <FactRow icon={<PixelIcon name={a.whose === "project" ? "repo" : "account"} />} label="Whose" value={a.whose === "project" ? "Everyone on the repo" : "Just me"} />

        <SectionHead label="Instructions" />
        <Text selectable style={[t.prose, { fontSize: 15, lineHeight: 24, paddingHorizontal: layout.inset, paddingTop: 2 }]}>
          {a.prompt.trim() || "No instructions yet. Edit its file to write them."}
        </Text>
        <FilePath path={a.path} />
      </Page>

      <Foot>
        {a.enabled ? (
          <FootCircle icon="pause" label="Pause: its triggers stop until you resume it" onPress={() => setEnabled(a, false)} />
        ) : (
          <FootPill label="Resume" primary={false} flex={false} onPress={() => setEnabled(a, true)} />
        )}
        <FootPill label="Run now" icon={<Icon name="play" size={17} color={c.onPrimary} />} onPress={start} />
      </Foot>

      <TopBar onBack={onBack} scrollY={edgeY} title={past ? a.title : undefined} subtitle={past ? status.word : undefined} mark={past ? <EngineLogo engine={a.engine} size={16} /> : undefined} menu={{ entries: more }} />
      <Confirm open={deleting} onClose={() => setDeleting(false)} title={`Delete ${a.title}?`} line={deleteWords(a).confirm} confirm="Delete" onConfirm={remove} />
    </View>
  );
}
