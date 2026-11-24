// One agent file, opened (apps/web/src/routes/automations/Agents.tsx AgentPane, as a phone reads it): a page of its
// own, as everything opened on a phone is, built like its automation's so the two read as one family. Its project
// over its name, what it does, and where it runs in one line: the version Caveman Cloud runs, changed here since, or
// here only. Then what it has been doing, newest first, as the runs list does it (each automation's run that used it
// opens that automation; a chat says which). Then how it is set up: the engine and the model with their logos, its
// file, the words it decides on; what it may do, a row a tool with its mark (a connector wears its vendor's logo in
// colour); and its instructions, in the chat's own type. Publish stands at the foot while there is something to send.
import * as Clipboard from "expo-clipboard";
import { Fragment, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, Text, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { PixelIcon } from "../../components/Pixel";
import { EngineText } from "../../components/Transcript";
import { BrandMark } from "../../components/ui/BrandMark";
import { EngineLogo, HARNESS_NAME, harnessId } from "../../components/ui/EngineLogo";
import type { MenuEntry } from "../../components/ui/Menu";
import { layout, useTheme } from "../../theme";
import { TopBar } from "../../shell/TopBar";
import { Page } from "../Page";
import { type Activity, type AgentFile, type AgentTool, cloudOf } from "./automations-model";
import { publish } from "./automations-store";
import { FactRow, FilePath, Foot, FootPill, FootState, PageHead, Rule, RunnerLine, RunRow, SectionHead, StatusDot, TITLE_PAST } from "./automation-parts";
import { age, took } from "./parts";

/** How many things it did show before "Show all". */
const SHOWN = 4;

const TOOL_MARK = { read: "tool-read", search: "tool-search", edit: "tool-edit", run: "tool-run", web: "tool-web", mcp: "tool-mcp" } as const;

/** A tool's mark: a connector its vendor's logo in colour, the rest the transcript's own pixel glyphs. */
function ToolIcon({ tool }: { tool: AgentTool }) {
  if (tool.brand) return <BrandMark name={tool.brand} size={16} />;
  return <PixelIcon name={TOOL_MARK[tool.kind]} />;
}

/** Where it runs, in one line: Cloud's version and whether the file here is the same, under its name. */
function CloudLine({ file: f }: { file: AgentFile }) {
  const { c, t } = useTheme();
  const cloud = cloudOf(f);
  const [word, rest, color] =
    cloud.tone === "same"
      ? [`${cloud.label} on Cloud`, "The same file as here", c.success]
      : cloud.tone === "changed"
        ? ["Changed here", `Cloud runs v${f.cloud.version}`, c.warning]
        : ["Here only", "Not on Cloud yet", c.subtle];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
      <StatusDot color={color} hollow={cloud.tone === "none"} />
      <Text numberOfLines={1} style={[t.row, { fontSize: 15, flexShrink: 1 }]}>
        <Text style={{ fontWeight: "500" }}>{word}</Text>
        <Text style={{ color: c.muted }}> · {rest}</Text>
      </Text>
    </View>
  );
}

/** "Review new pull requests · 3m 12s": where it did it and how long it took. */
const activityMeta = (x: Activity, now: number) => [x.via, x.took !== undefined ? took(x.took) : x.status === "running" ? took(now - x.at) : null].filter(Boolean).join(" · ");

export function AgentPage({
  file: f,
  activity,
  now,
  onBack,
  onOpenAutomation,
  onNotify,
}: {
  file: AgentFile;
  /** What it has been doing (automations-model.ts activityOf). */
  activity: readonly Activity[];
  now: number;
  onBack: () => void;
  /** Pushes the automation one of its runs belongs to. */
  onOpenAutomation: (id: string) => void;
  onNotify?: (text: string) => void;
}) {
  const { c, t } = useTheme();
  const edgeY = useSharedValue(0);
  const [past, setPast] = useState(false);
  const [all, setAll] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const cloud = cloudOf(f);
  const engine = HARNESS_NAME[harnessId(f.engine)] ?? f.engine;

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const now = e.nativeEvent.contentOffset.y > TITLE_PAST;
    if (now !== past) setPast(now);
  };

  const send = () => {
    if (!cloud.action) return;
    const version = `v${(f.cloud.version ?? 0) + 1}`;
    setSending(version);
    publish(f, () => {
      setSending(null);
      onNotify?.(`Published ${f.name} ${version} to Cloud`);
    });
  };

  const more: MenuEntry[] = [
    {
      label: "Copy path",
      icon: <PixelIcon name="artifact-link" />,
      onPress: () => {
        void Clipboard.setStringAsync(f.path).catch(() => {});
        onNotify?.("Path copied");
      },
    },
    ...(f.cloud.version ? [{ label: "Open in Platform", icon: <PixelIcon name="computer-cloud" />, onPress: () => onNotify?.(`Opening ${f.name} in Platform…`) }] : []),
  ];

  const shown = all ? activity : activity.slice(0, SHOWN);

  return (
    <View style={{ flex: 1 }}>
      <Page scrollY={edgeY} onScroll={onScroll} contentContainerStyle={{ paddingTop: 0 }}>
        <PageHead project={f.project} title={f.name} line={f.description || "No description yet: say what it does on the file's description line."}>
          <RunnerLine engine={f.engine} model={f.model} effort={f.effort} />
          <CloudLine file={f} />
        </PageHead>

        <SectionHead label="Recent activity" count={activity.length || undefined} />
        {activity.length === 0 ? (
          <Text style={[t.small, { fontSize: 15, lineHeight: 22, paddingHorizontal: layout.inset, paddingTop: 4 }]}>Not used yet. Name it in an automation's step or a chat, and what it does shows here.</Text>
        ) : (
          shown.map((x, i) => (
            <Fragment key={x.id}>
              {i ? <Rule /> : null}
              <RunRow status={x.status} title={x.title} meta={activityMeta(x, now)} at={age(x.at, now)} disclose={false} onPress={x.automation ? () => onOpenAutomation(x.automation!) : undefined} />
            </Fragment>
          ))
        )}
        {activity.length > SHOWN ? (
          <Text accessibilityRole="button" onPress={() => setAll((x) => !x)} style={[t.row, { fontSize: 15, color: c.muted, paddingLeft: layout.inset + 32, paddingVertical: 12 }]}>
            {all ? "Show fewer" : `Show all ${activity.length}`}
          </Text>
        ) : null}

        <SectionHead label="Tools" count={f.tools.length} />
        {f.tools.map((tool, i) => (
          <Fragment key={tool.label}>
            {i ? <Rule /> : null}
            <FactRow icon={<ToolIcon tool={tool} />} label={tool.label} value={tool.detail} path={tool.kind === "run" || tool.kind === "edit"} />
          </Fragment>
        ))}

        <SectionHead label="Instructions" />
        <View style={{ paddingHorizontal: layout.inset, paddingTop: 2, paddingBottom: 6 }}>
          <EngineText text={f.instructions} at={0} />
        </View>
        {f.decides?.length ? <FactRow icon={<PixelIcon name="branch" />} label="Decides" value={f.decides.join(", ")} path accessibilityLabel={`Decides: its last line ends on ${f.decides.join(", ")}`} /> : null}

        <FilePath path={f.path} />
      </Page>

      {cloud.action || sending ? (
        <Foot>
          {sending ? (
            <FootState mark={<PixelIcon name="state-working" />} words={`Publishing ${sending} to Cloud`} />
          ) : (
            <FootPill label={cloud.action!} primary={cloud.tone === "changed"} icon={<PixelIcon name="computer-cloud" ink={cloud.tone === "changed" ? c.onPrimary : c.text} />} onPress={send} />
          )}
        </Foot>
      ) : null}

      <TopBar onBack={onBack} scrollY={edgeY} title={past ? f.name : undefined} subtitle={past ? `${engine} · ${f.model}` : undefined} mark={past ? <EngineLogo engine={f.engine} size={16} /> : undefined} menu={{ entries: more }} />
    </View>
  );
}
