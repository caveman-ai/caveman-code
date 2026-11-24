// The phone's living style page, like the desktop's #/style: every shared primitive on fixture data, in whichever
// theme the system is in, so a screen can be checked against it and it against the desktop's. The web build shows it
// at /?style; nothing in the app links to it.
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { FileChange } from "../../board/model";
import { Toggle } from "../../native/Toggle";
import { useTheme } from "../../theme";
import { Icon, type IconName } from "../Icon";
import { Mascot, PixelFolder, PixelIcon } from "../Pixel";
import { FileTypeMark } from "../transcript/FileTypeMark";
import { Markdown } from "../transcript/Markdown";
import { TurnChanges, TurnFooter } from "../transcript/TurnChanges";
import { Count, Dot, Tag } from "./Badge";
import { Button, IconButton } from "./Button";
import { ApprovalPair, CommandChip } from "./Choices";
import { EffortSlider } from "./Effort";
import { PageEmpty, PanelEmpty } from "./Empty";
import { SearchField } from "./Field";
import { EffortPip, EngineLogo, ModelName, RunnerBadge, RunnerEdge, SpeedBolt, VendorMark } from "./EngineLogo";
import { type MenuEntry, MenuButton, MenuList, MenuSurface } from "./Menu";
import { Row, Section } from "./Row";

const ADD: readonly MenuEntry[] = [
  { type: "heading", label: "Add" },
  { label: "Files", description: "Attach files from your phone", icon: <PixelIcon name="attach" /> },
  { label: "Images", description: "Screenshots and pictures", icon: <PixelIcon name="artifact-image" /> },
  { label: "Goal", description: "Set a goal to keep pursuing", icon: <PixelIcon name="goal" /> },
  { label: "Grill mode", description: "Answer its questions first, then build", icon: <PixelIcon name="grill-mode" /> },
  { type: "heading", label: "Plugins and Spaces" },
  { label: "acme-backend", description: "Migration skill, Datadog and Linear MCP", icon: <PixelIcon name="space" /> },
];

const CHAT: readonly MenuEntry[] = [
  { label: "Rename", icon: "rename", onPress: () => {} },
  { label: "Pin", icon: "pin", onPress: () => {} },
  { label: "Fork", icon: "fork", onPress: () => {} },
  {
    label: "Snooze",
    icon: "snooze",
    submenu: [
      { label: "An hour", onPress: () => {} },
      { label: "Tonight", description: "6 PM", onPress: () => {} },
      { label: "Tomorrow", description: "9 AM", onPress: () => {} },
    ],
  },
  { label: "Permissions", value: "Supervised", submenu: [{ label: "Supervised", checked: true, onPress: () => {} }, { label: "Auto-accept edits", onPress: () => {} }, { label: "Full access", onPress: () => {} }] },
  { type: "separator" },
  { label: "Archive", icon: "archive", onPress: () => {} },
  { label: "Delete", icon: "delete", destructive: true, onPress: () => {} },
];

const ENGINES = ["caveman", "claude-agent", "codex", "cursor", "opencode", "grok", "pi", "muse", "antigravity", "acp-other"];
const GLYPHS: readonly IconName[] = ["add", "search", "more", "close", "check", "chevronDown", "chevronRight", "copy", "rename", "pin", "archive", "delete", "share", "open", "fork", "sliders", "speed", "star", "home", "mic", "send", "stop"];
const PIXELS: readonly PixelIconName[] = ["chief", "review", "spaces", "automations", "settings", "search", "new", "state-needs-you", "state-working", "state-agents", "state-done", "state-failed", "state-queued", "state-sleeping", "computer-this-mac", "computer-cloud", "branch", "tool-run"];

/** An answer that uses every piece of markdown a chat writes: a heading, bold, code, a list, a fence, a table. */
const ANSWER =
  "### Runs follows the theme\n\nThe page now reads the app's tokens and starts **dark**. `RunRow` lifts one step on hover.\n\n- Status dots keep their meaning\n- All **8 tests** pass\n\n```tsx\nexport function RunRow({ run }: { run: Run }) {\n  return <Row label={run.name} />;\n}\n```\n\n| File | Change |\n| --- | --- |\n| RunsPage.tsx | +24 −9 |\n| runs.css | +5 −1 |";
const FILES: readonly FileChange[] = [
  { path: "src/runs/RunsPage.tsx", add: 24, del: 9 },
  { path: "src/styles/runs.css", add: 5, del: 1 },
  { path: "db/0042_usage_daily.sql", add: 64, del: 0 },
];

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 10, paddingVertical: 14 }}>
      <Text style={[t.heading, { paddingHorizontal: 4 }]}>{title}</Text>
      {children}
    </View>
  );
}

export function StylePage() {
  const { c, t } = useTheme();
  const insets = useSafeAreaInsets();
  const [on, setOn] = useState(true);
  const [effort, setEffort] = useState("high");
  const [query, setQuery] = useState("");
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.panel }} contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 80, paddingHorizontal: 16 }}>
      <Block title="Type">
        <Text style={t.display}>What should we build?</Text>
        <Text style={t.largeTitle}>Page title, 24 on 30 at 600</Text>
        <Text style={t.title}>Section title, 18 at 600</Text>
        <Text style={t.heading}>Sheet or empty title, 17 at 600</Text>
        <Text style={t.prose}>
          Answer prose, 16 on 26 at 80% ink. The agent explains <Text style={{ color: c.text, fontWeight: "600" }}>what it changed</Text> and why.
        </Text>
        <Text style={t.row}>A row, a menu label, 16</Text>
        <Text style={t.label}>A leading label, 15 at 500</Text>
        <Text style={t.small}>A description under a row, 13 grey</Text>
        <Text style={t.section}>Section heading, 13 at 500, tertiary</Text>
        <Text style={t.meta}>2m · meta, 13 tertiary, tabular</Text>
        <Text style={t.code}>apps/web/src/routes/StyleGuide.tsx · caveman/split-view</Text>
      </Block>

      <Block title="Colour">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(["shell", "panel", "card", "popover", "raised", "control", "hairline", "field", "text", "prose", "muted", "subtle", "warning", "success", "destructive", "link", "target", "primary", "added", "removed", "effortMax", "effortUltra", "speed"] as const).map((k) => (
            <View key={k} style={{ width: 82, gap: 4 }}>
              <View style={{ height: 28, borderRadius: 6, backgroundColor: c[k], borderWidth: 1, borderColor: c.hairline }} />
              <Text style={t.meta}>{k}</Text>
            </View>
          ))}
        </View>
      </Block>

      <Block title="Menu">
        <MenuSurface width={320}>
          <MenuList entries={ADD} />
        </MenuSurface>
        <MenuSurface width={300}>
          <MenuList entries={CHAT} />
        </MenuSurface>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <MenuButton label="Chat options" entries={CHAT} align="start">
            <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
              <Icon name="more" size={22} />
            </View>
          </MenuButton>
          <Text style={t.small}>Opens the menu over the page</Text>
        </View>
      </Block>

      <Block title="Rows and sections">
        <View style={{ backgroundColor: c.shell, borderRadius: 12, padding: 6 }}>
          <Row surface="shell" icon={<PixelIcon name="review" />} label="Review" trailing={<Count n={2} urgent />} onPress={() => {}} />
          <Row surface="shell" icon={<PixelIcon name="spaces" />} label="Plugins" onPress={() => {}} />
          <Section label="Chiefs" first>
            <IconButton icon="add" label="New Chief" size={18} />
          </Section>
          <Row surface="shell" icon={<PixelIcon name="chief" />} label="Chief" trailing={<Dot label="2 need you" />} onPress={() => {}} />
          <Section label="Projects" count={2} open onToggle={() => {}} />
          <Row surface="shell" icon={<PixelFolder open />} label="caveman-code" tone="unread" onPress={() => {}} />
          <Row surface="shell" indent={22} label="Push for the Chief" tone="unread" trailing={<PixelIcon name="state-working" />} onPress={() => {}} />
          <Row surface="shell" indent={22} label="Dark mode for Runs" tone="unread" selected trailing={<PixelIcon name="state-done" />} onPress={() => {}} />
          <Row surface="shell" indent={22} label="Chief rail redesign" tone="read" onPress={() => {}} />
          <Row surface="shell" indent={22} label="Usage table migration" tone="unread" trailing={<PixelIcon name="state-needs-you" label="Needs you" />} onPress={() => {}} />
          <Row surface="shell" icon={<PixelFolder open={false} />} label="Caveman Cloud" onPress={() => {}} />
          <Section label="Needs you" count={1} />
          <Row surface="shell" label="Usage table migration" meta="Run a migration on staging? · Caveman Cloud · 4m" trailing={<PixelIcon name="state-needs-you" />} onPress={() => {}} />
        </View>
        <Row icon={<Icon name="settings" color={c.muted} />} label="Appearance" description="System" chevron onPress={() => {}} />
      </Block>

      <Block title="Effort">
        <MenuSurface>
          <EffortSlider levels={["low", "medium", "high", "xhigh", "max", "ultracode"]} value={effort} start="high" onChange={setEffort} onSave={() => {}} />
        </MenuSurface>
      </Block>

      <Block title="Engine logos">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
          {ENGINES.map((e) => (
            <EngineLogo key={e} engine={e} size={16} label={e} />
          ))}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
          {ENGINES.map((e) => (
            <EngineLogo key={e} engine={e} size={32} />
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
          <VendorMark engine="caveman" model="anthropic/claude-opus-5-5" />
          <VendorMark engine="caveman" model="google/gemini-3" />
          <VendorMark engine="caveman" model="deepseek/v4" />
          <VendorMark engine="caveman" model="Auto" />
        </View>
        <ModelName engine="claude-agent" model="claude-opus-5-5" label="Claude Opus 5.5" effort="high" />
        <ModelName engine="codex" model="gpt-6.1" label="GPT-6.1 Sol" effort="max" fast="fast" />
        <ModelName engine="claude-agent" model="claude-opus-5-5" label="Claude Opus 5.5" effort="ultracode" fast="fastest" />
        <ModelName engine="caveman" label="Auto" />
        <RunnerBadge runner={{ engine: "claude-agent", modelLabel: "Claude Opus 5.5", tag: "jb", effort: "high" }} />
        <RunnerBadge runner={{ engine: "codex", model: "gpt-6.1-sol", effort: "max" }} size="header" />
        <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
          {["low", "medium", "high", "xhigh", "max", "ultracode"].map((e) => (
            <EffortPip key={e} effort={e} />
          ))}
          <SpeedBolt on={false} />
          <SpeedBolt on />
          <SpeedBolt on double />
        </View>
        <RunnerEdge engine="codex" running style={{ borderRadius: 12, borderWidth: 1, borderColor: c.hairline, backgroundColor: c.card, padding: 14, paddingLeft: 18 }}>
          <Text style={t.label}>Find every caller of retry.Schedule</Text>
          <RunnerBadge runner={{ engine: "codex", model: "gpt-6.1-sol", effort: "high" }} />
        </RunnerEdge>
      </Block>

      <Block title="Badges">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <Count n={3} urgent />
          <Count n={12} />
          <Dot label="Needs you" />
          <Dot color={c.target} label="Live" />
          <Tag label="Default" tone="blue" />
          <Tag label="Signed in" tone="green" />
          <Tag label="Not connected" tone="yellow" />
          <Tag label="Project" tone="purple" />
          <Tag label="jb" />
        </View>
      </Block>

      <Block title="Buttons and controls">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button label="New chat" icon="add" variant="primary" />
          <Button label="Add note" icon="add" />
          <Button label="Settings" variant="ghost" />
          <Button label="Remove" variant="destructive" />
          <Button label="Small" size="small" />
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Toggle label="Demo" value={on} onChange={setOn} />
          <Toggle label="Demo off" value={!on} onChange={(v) => setOn(!v)} />
          <Toggle label="Demo disabled" value={on} onChange={setOn} disabled />
        </View>
        {/* The one ask, as every screen draws it: its question, the command chip, then Deny | Allow. */}
        <View style={{ borderRadius: 24, borderWidth: 1, borderColor: c.edge, backgroundColor: c.card, padding: 16, gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <EngineLogo engine="claude-agent" />
            <Text style={[t.heading, { fontSize: 17, lineHeight: 22 }]}>Run the webhook tests?</Text>
          </View>
          <CommandChip command="pnpm --filter @caveman-app/cloud test webhooks" />
          <ApprovalPair command="pnpm --filter @caveman-app/cloud test webhooks" onAllow={() => {}} onDeny={() => {}} />
          <ApprovalPair size="inline" allow="Ship it" deny="Later" onAllow={() => {}} onDeny={() => {}} />
        </View>
      </Block>

      <Block title="Fields">
        <SearchField value={query} onChangeText={setQuery} placeholder="Search chats" />
        <MenuSurface>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search models" variant="line" />
        </MenuSurface>
      </Block>

      <Block title="Empty states">
        <PageEmpty title="No automations yet" line="Automations run a chat on a schedule or when something happens. Make one from any chat." action={<Button label="New automation" icon="add" size="small" />} />
        <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.hairline }}>
          <PanelEmpty icon="artifact-diff" title="No changes yet" line="What this chat changes in its project shows here." action={<Button label="Open the project" size="small" />} />
        </View>
      </Block>

      <Block title="Transcript">
        <Markdown text={ANSWER} />
        <TurnChanges files={FILES} onReview={() => {}} />
        <TurnFooter text={ANSWER} at={Date.now() - 4 * 60_000} />
        <CommandChip command="pnpm db:migrate --env staging" line />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
          {["a.ts", "a.tsx", "a.js", "a.css", "a.sql", "a.md", "a.json", "a.go", "a.sh", "a.txt"].map((f) => (
            <FileTypeMark key={f} path={f} />
          ))}
        </View>
      </Block>

      <Block title="Icons">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
          {GLYPHS.map((g) => (
            <Icon key={g} name={g} color={c.muted} />
          ))}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
          {PIXELS.map((p) => (
            <PixelIcon key={p} name={p} />
          ))}
        </View>
        <Mascot size={72} />
      </Block>
    </ScrollView>
  );
}
