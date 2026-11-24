// Automations, as the desktop's page (apps/web/src/routes/automations/) shows in a phone's width: one thing at a time,
// the list or what it opened. The list leads with the frame's two sections as two words, Automations
// and Agents, the one you're on in ink; under Automations, Active and Paused, each row its state as one ring, its name
// and one line (what starts it, or the one thing wrong with it), and New automation last. Agents lists the agent files,
// each its engine and model, its name, its project and the version Caveman Cloud runs. What a row opens is a page of
// its own, slid in over the list (./AutomationPage.tsx, ./AgentPage.tsx), and what it names inside pushes another (an
// automation's agent, an agent's automation), Back taking you down one at a time to the list as you left it. What you
// do here (a run, a pause, a publish, a delete, a new one) is kept while the app runs (./automations-store.ts).
import { type ReactNode, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { pairedMac, projects } from "../../board/places";
import { Icon } from "../../components/Icon";
import { PixelIcon } from "../../components/Pixel";
import { Squish } from "../../components/Squish";
import { Shimmer } from "../../components/transcript/Shimmer";
import { BrandMark } from "../../components/ui/BrandMark";
import { Button } from "../../components/ui/Button";
import { PanelEmpty } from "../../components/ui/Empty";
import { EngineLogo, HARNESS_NAME, harnessId } from "../../components/ui/EngineLogo";
import { SearchField } from "../../components/ui/Field";
import { MenuButton, type MenuEntry } from "../../components/ui/Menu";
import { Row } from "../../components/ui/Row";
import { Segmented } from "../../components/ui/Segmented";
import { haptic } from "../../motion";
import { radius, useTheme } from "../../theme";
import { GlassButton } from "../../shell/TopBar";
import { openSearch } from "../../shell/ui";
import { ListPage } from "../Page";
import { AgentPage } from "./AgentPage";
import { activityOf, type AgentFile, type Automation, cloudOf, type Tone, toneOf, WHEN, type When } from "./automations-model";
import { agents, automations } from "./automations-store";
import { AutomationPage } from "./AutomationPage";
import { Pushed } from "./automation-parts";
import { ago, CARD_ROOM, Heading, LIST_X, Overlay, useNow } from "./parts";
import { keep } from "./keep";

// The sidebar's count reads the automations from here.
export { automations } from "./automations-store";

type Section = "automations" | "agents";

/** What the list has open, bottom to top: an automation by id, an agent by its project and name. */
type Opened = { kind: "automation"; id: string } | { kind: "agent"; project: string; name: string };

/** The row's state in one mark (List.tsx Ring): an open ring at rest, dashed when paused, the working ring while it runs. */
function Ring({ tone, paused }: { tone: Tone; paused: boolean }) {
  const { c } = useTheme();
  if (tone === "running") return <PixelIcon name="state-working" label="Running" />;
  return (
    <View
      accessibilityElementsHidden
      style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderStyle: paused ? "dashed" : "solid", borderColor: tone === "error" ? c.destructive : c.muted }}
    />
  );
}

/**
 * One automation in the list (List.tsx Row): its ring, its name, and one quiet line, red or amber when something's
 * wrong. `project`: its project's name leads the line once the list spans more than one.
 */
function AutomationRow({ automation: a, project, onPress }: { automation: Automation; project: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const tone = toneOf(a);
  const last = a.runs[0];
  const state =
    tone === "running" ? (
      <Shimmer text="Running" style={[t.small, { color: c.text }]} />
    ) : tone === "warn" ? (
      // Amber is only ever "this waits on you": a run held off ("Not on main") is said in grey by its grey ring.
      <Text style={t.small}>{a.off?.label}</Text>
    ) : tone === "error" && last ? (
      <Text style={[t.small, { color: c.destructive }]}>Last run failed {ago(last.startedAt)}</Text>
    ) : (
      <Text numberOfLines={1} style={t.small}>
        {a.trigger}
        {a.more ? ` +${a.more}` : ""}
      </Text>
    );
  const line = project ? (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Text numberOfLines={1} style={[t.small, { flexShrink: 1 }]}>
        {a.project}
        <Text style={{ color: c.subtle }}>{"\u00a0·\u00a0"}</Text>
      </Text>
      {state}
    </View>
  ) : (
    state
  );
  return (
    <Row
      label={a.title}
      icon={<Ring tone={tone} paused={!a.enabled} />}
      meta={line}
      onPress={onPress}
      accessibilityLabel={`${a.title}, ${tone === "running" ? "running" : tone === "warn" ? a.off?.label : tone === "error" ? "last run failed" : a.trigger}${a.enabled ? "" : ", paused"}`}
      gap={12}
    />
  );
}

/** One agent file (AgentCardView): its engine and model on top, its name, then its project and the version Cloud runs. */
function AgentCard({ file: f, onPress }: { file: AgentFile; onPress: () => void }) {
  const { c, t } = useTheme();
  const engine = HARNESS_NAME[harnessId(f.engine)] ?? f.engine;
  const cloud = cloudOf(f);
  return (
    <Squish label={`${f.name}, ${engine} · ${f.model}, ${f.project}, ${cloud.label}`} onPress={onPress} depth={0.985} highlight style={{ paddingHorizontal: 10, paddingVertical: 9, borderRadius: radius.row, gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <EngineLogo engine={f.engine} size={14} />
        <Text numberOfLines={1} style={[t.small, { flex: 1 }]}>
          {engine} · {f.model}
        </Text>
      </View>
      <Text numberOfLines={1} style={[t.label, { fontWeight: "600" }]}>
        {f.name}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <BrandMark name="github" size={12} color={c.muted} />
        <Text numberOfLines={1} style={[t.small, { flex: 1 }]}>
          {f.project}
        </Text>
        <CloudState file={f} />
      </View>
    </Squish>
  );
}

/** The version Cloud runs, in words and a mark (Agents.tsx CloudState). */
function CloudState({ file }: { file: AgentFile }) {
  const { c, t } = useTheme();
  const cloud = cloudOf(file);
  const ink = cloud.tone === "none" || cloud.tone === "changed" ? c.muted : c.text;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {cloud.tone === "none" ? null : <PixelIcon name="computer-cloud" ink={ink} />}
      <Text style={[t.small, { color: ink, fontVariant: ["tabular-nums"] }]}>{cloud.label}</Text>
    </View>
  );
}

type Touch = "readonly" | "full" | "none";
type Whose = Automation["whose"];

/** New automation's quick choices, each a chip and a menu of its options (New.tsx CHECKOUT, WHOSE, CLASS_HINT). */
const TOUCH: Record<Touch, { chip: string; label: string; hint: string; icon: "tool-read" | "branch" | "tool-web" }> = {
  readonly: { chip: "Read-only", label: "Read-only copy", hint: "Reads, never changes", icon: "tool-read" },
  full: { chip: "Own branch", label: "Its own branch", hint: "Commits what it changes", icon: "branch" },
  none: { chip: "No repo", label: "No repo", hint: "For work on the web or in your tools", icon: "tool-web" },
};
const WHOSE: Record<Whose, { chip: string; label: string; hint: string; icon: "account" | "repo" }> = {
  me: { chip: "Just me", label: "Just me", hint: "Kept out of git, live at once", icon: "account" },
  project: { chip: "Everyone", label: "Everyone on the repo", hint: "Shared in git, live once merged", icon: "repo" },
};
const MODELS = { Auto: "Caveman Auto picks per turn", Fast: "Quick and cheap: triage, summaries", Base: "The everyday model", Frontier: "The strongest, for hard changes" } as const;
type ModelClass = keyof typeof MODELS;

/** The mark of when it runs (marks.tsx TriggerMark): GitHub's for its events, the bolt for a schedule or by hand. */
const whenMark = (w: When) => (w === "pull_request" || w === "issue" ? <BrandMark name="github" size={16} /> : <PixelIcon name="automations" />);

/** The composer's own chip (New.tsx Chip): a mark, grey words, and the chevron of the menu it opens. */
function Chip({ label, mark, words, entries, width = 300 }: { label: string; mark: ReactNode; words: string; entries: readonly MenuEntry[]; width?: number }) {
  const { c, t } = useTheme();
  return (
    <MenuButton label={`${label}: ${words}`} entries={entries} align="start" width={width}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingLeft: 8, paddingRight: 8, borderRadius: radius.row }}>
        {mark}
        <Text numberOfLines={1} style={[t.row, { fontSize: 15, color: c.muted, maxWidth: 170 }]}>
          {words}
        </Text>
        <Icon name="chevronDown" size={14} color={c.muted} />
      </View>
    </MenuButton>
  );
}

interface Draft {
  title: string;
  prompt: string;
  project: string;
  when: When;
  model: ModelClass;
  touch: Touch;
  whose: Whose;
}
const BLANK: Draft = { title: "", prompt: "", project: projects.get()[0]?.name ?? "", when: "weekdays", model: "Auto", touch: "full", whose: "me" };

/** What New automation holds, kept while the app runs: closing the box loses nothing; Create clears it. */
const draft = keep<Draft>(() => BLANK);

/**
 * New automation (New.tsx), the desktop's floating chatbox as a sheet: its name on top and what it should do under
 * it, both borderless like the composer's own field, then one row of quick choices (the project, when it runs, the
 * model, what it may touch, whose it is) and Create.
 */
function NewSheet({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (d: Draft) => void }) {
  const { c, t } = useTheme();
  const d = draft.use();
  const set = (patch: Partial<Draft>) => draft.set((was) => ({ ...was, ...patch }));
  const field = { outlineStyle: "none" } as object;
  const one = <K extends string>(options: Record<K, { label: string; hint: string; icon: Parameters<typeof PixelIcon>[0]["name"] }>, value: K, pick: (k: K) => void): MenuEntry[] =>
    (Object.keys(options) as K[]).map((k) => ({ label: options[k].label, description: options[k].hint, under: true, icon: <PixelIcon name={options[k].icon} />, checked: k === value, onPress: () => pick(k) }));
  return (
    <Overlay open={open} onClose={onClose}>
      <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
          <TextInput
            value={d.title}
            onChangeText={(title) => set({ title })}
            placeholder="Automation title"
            placeholderTextColor={c.subtle}
            accessibilityLabel="Name"
            returnKeyType="next"
            style={[t.heading, { fontSize: 18, lineHeight: 26, fontWeight: "500", paddingVertical: 4, color: c.text }, field]}
          />
          <TextInput
            value={d.prompt}
            onChangeText={(prompt) => set({ prompt })}
            placeholder="Tell it what to do, e.g. read new issues and label each one by area"
            placeholderTextColor={c.subtle}
            accessibilityLabel="What it should do"
            multiline
            style={[t.body, { minHeight: 132, marginTop: 6, paddingVertical: 4, color: c.text, textAlignVertical: "top" }, field]}
          />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 2, paddingHorizontal: 12, paddingTop: 8 }}>
          <Chip
            label="Project"
            mark={<BrandMark name="github" size={14} />}
            words={d.project}
            entries={[{ type: "heading", label: "Project" }, ...projects.get().map((p) => ({ label: p.name, icon: p.github ? <BrandMark name="github" size={16} /> : <PixelIcon name="folder" />, checked: p.name === d.project, onPress: () => set({ project: p.name }) }))]}
            width={260}
          />
          <Chip
            label="When it runs"
            mark={whenMark(d.when)}
            words={WHEN[d.when].chip}
            entries={[
              { type: "heading", label: "On a schedule" },
              ...(["weekdays", "daily", "weekly"] as const).map((w) => ({ label: WHEN[w].label, checked: d.when === w, onPress: () => set({ when: w }) })),
              { type: "separator" },
              { type: "heading", label: "When on GitHub" },
              ...(["pull_request", "issue"] as const).map((w) => ({ label: WHEN[w].label, checked: d.when === w, onPress: () => set({ when: w }) })),
              { type: "separator" },
              { label: "By hand only", description: "Run now starts it", checked: d.when === "manual", onPress: () => set({ when: "manual" }) },
            ]}
          />
          <Chip
            label="Model"
            mark={<PixelIcon name="engine-caveman" />}
            words={d.model}
            entries={[
              { type: "heading", label: "Model" },
              ...(Object.keys(MODELS) as ModelClass[]).map((m) => ({ label: m, description: MODELS[m], under: true, checked: m === d.model, onPress: () => set({ model: m }) })),
            ]}
          />
          <Chip
            label="What it may touch"
            mark={<PixelIcon name={TOUCH[d.touch].icon} />}
            words={TOUCH[d.touch].chip}
            entries={[{ type: "heading", label: "What it may touch" }, ...one(TOUCH, d.touch, (touch) => set({ touch }))]}
          />
          <Chip label="Whose it is" mark={<PixelIcon name={WHOSE[d.whose].icon} />} words={WHOSE[d.whose].chip} entries={[{ type: "heading", label: "Whose it is" }, ...one(WHOSE, d.whose, (whose) => set({ whose }))]} />
        </View>
        <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 }}>
          <Button
            label="Create"
            variant="primary"
            stretch
            disabled={!d.title.trim()}
            onPress={() => {
              haptic.done();
              onCreate(d);
              draft.set(BLANK);
            }}
          />
        </View>
      </ScrollView>
    </Overlay>
  );
}


/** The page an opened thing gets, by what it is, or nothing once it is gone (deleted under you). */
function OpenedPage({ opened, list, files, now, onBack, push, replace, onNotify }: { opened: Opened; list: readonly Automation[]; files: readonly AgentFile[]; now: number; onBack: () => void; push: (o: Opened) => void; replace: (o: Opened) => void; onNotify?: (text: string) => void }) {
  if (opened.kind === "automation") {
    const a = list.find((x) => x.id === opened.id);
    if (!a) return null;
    return (
      <AutomationPage
        automation={a}
        now={now}
        onBack={onBack}
        onOpen={(id) => replace({ kind: "automation", id })}
        onOpenAgent={(name) => push({ kind: "agent", project: a.project, name })}
        onNotify={onNotify}
      />
    );
  }
  const f = files.find((x) => x.name === opened.name && x.project === opened.project);
  if (!f) return null;
  return <AgentPage file={f} activity={activityOf(f, list)} now={now} onBack={onBack} onOpenAutomation={(id) => push({ kind: "automation", id })} onNotify={onNotify} />;
}

/**
 * `below`: room kept under the last row for what floats over the page's foot (the moment's card, by default). `onNotify`: the
 * app's toast, for what an action leaves no other mark of (a path copied, a file deleted).
 */
export function AutomationsScreen({ below = CARD_ROOM, onNotify, onBack }: { below?: number; onNotify?: (text: string) => void; /** The stack's Back: the list wears the list shell (screens/Page.tsx ListPage). */ onBack: () => void }) {
  const { c } = useTheme();
  const list = automations.use();
  const files = agents.use();
  // A running run's clock reads by the second; otherwise ages only need the quarter minute.
  const now = useNow(list.some((a) => a.runs[0]?.status === "running") ? 1000 : 15_000);
  const [section, setSection] = useState<Section>("automations");
  const [stack, setStack] = useState<readonly Opened[]>([]);
  const [creating, setCreating] = useState(false);
  const [agentQuery, setAgentQuery] = useState("");

  const push = (o: Opened) => setStack((s) => [...s, o]);
  const pop = () => setStack((s) => s.slice(0, -1));
  const replace = (o: Opened) => setStack((s) => [...s.slice(0, -1), o]);

  const manyProjects = new Set(list.map((a) => a.project)).size > 1;
  const active = list.filter((a) => a.enabled);
  const paused = list.filter((a) => !a.enabled);
  const q = agentQuery.trim().toLowerCase();
  const shownAgents = files.filter((f) => !q || `${f.name} ${f.description} ${f.model}`.toLowerCase().includes(q));
  const covered = stack.length > 0;

  return (
    <View style={{ flex: 1 }}>
      {/* The list stays where you left it under what it opened, hidden from VoiceOver while covered. */}
      <View style={{ flex: 1 }} importantForAccessibility={covered ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={covered}>
        <ListPage
          title="Automations"
          line={section === "automations" ? (active.length ? `${active.length} active` : undefined) : `${files.length} agents`}
          onBack={onBack}
          below={below}
          right={<GlassButton icon="search" label="Search" onPress={openSearch} />}
          top={
            <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
              <Segmented
                label="Automations and agents"
                value={section}
                onChange={setSection}
                options={[
                  { value: "automations", label: "Automations" },
                  { value: "agents", label: "Agents" },
                ]}
              />
            </View>
          }
        >
          {section === "automations" ? (
            // The lists' one column: heads and glyph boxes at x 16 (6 here, 10 in each row), words at 48.
            <View style={{ paddingHorizontal: LIST_X - 10, paddingTop: 4 }}>
              {list.length === 0 ? (
                <PanelEmpty
                  icon="automations"
                  title="No automations yet"
                  line="Make one that runs on a schedule or when something happens."
                  action={<Button label="New automation" size="small" onPress={() => setCreating(true)} />}
                />
              ) : null}
              {active.length ? <Heading label="Active" /> : null}
              {active.map((a) => (
                <AutomationRow key={a.id} automation={a} project={manyProjects} onPress={() => push({ kind: "automation", id: a.id })} />
              ))}
              {paused.length ? <Heading label="Paused" /> : null}
              {paused.map((a) => (
                <AutomationRow key={a.id} automation={a} project={manyProjects} onPress={() => push({ kind: "automation", id: a.id })} />
              ))}
              {/* The way to make one is the list's last row, as New Chief is under the Chiefs. */}
              {list.length ? <Row label="New automation" icon={<Icon name="add" size={18} color={c.muted} />} gap={12} onPress={() => setCreating(true)} /> : null}
            </View>
          ) : (
            <View style={{ paddingHorizontal: 8, paddingTop: 4 }}>
              <View style={{ paddingHorizontal: 8, marginBottom: 6 }}>
                <SearchField value={agentQuery} onChangeText={setAgentQuery} placeholder="Filter agents" />
              </View>
              {shownAgents.length ? (
                shownAgents.map((f) => <AgentCard key={`${f.project}:${f.name}`} file={f} onPress={() => push({ kind: "agent", project: f.project, name: f.name })} />)
              ) : (
                <PanelEmpty
                  icon="tool-subagent"
                  title={q ? "No match" : "No agents yet"}
                  line={q ? `No agent matches “${agentQuery.trim()}”.` : "An agent is one Markdown file in .caveman/agents. Describe one and Caveman writes it."}
                />
              )}
            </View>
          )}
          <NewSheet
            open={creating}
            onClose={() => setCreating(false)}
            onCreate={(d) => {
              const id = `new-${Date.now()}`;
              const slug = d.title
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "");
              const next = WHEN[d.when].next;
              automations.set((all) => [
                {
                  id,
                  title: d.title.trim(),
                  description: "",
                  project: d.project,
                  path: `.caveman/automations/${slug || "automation"}.md`,
                  engine: "caveman",
                  model: d.model,
                  enabled: true,
                  trigger: WHEN[d.when].chip,
                  whose: d.whose,
                  // Your Mac runs what you make here; with none this phone drives, a Cloud computer does.
                  where: pairedMac() ? "mac" : "cloud",
                  nextRunAt: next ? next(Date.now()) : undefined,
                  prompt: d.prompt.trim(),
                  runs: [],
                },
                ...all,
              ]);
              setCreating(false);
              push({ kind: "automation", id });
            }}
          />
        </ListPage>
      </View>
      {stack.map((o, i) => {
        const top = i === stack.length - 1;
        return (
          <Pushed key={o.kind === "automation" ? `a:${o.id}:${i}` : `g:${o.project}:${o.name}:${i}`} onBack={pop}>
            <View style={{ flex: 1 }} importantForAccessibility={top ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!top}>
              <OpenedPage opened={o} list={list} files={files} now={now} onBack={pop} push={push} replace={replace} onNotify={onNotify} />
            </View>
          </Pushed>
        );
      })}
    </View>
  );
}
