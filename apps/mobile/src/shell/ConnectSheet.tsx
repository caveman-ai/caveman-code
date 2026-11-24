// Connect, from Home's second circle and the composer's Plugins (which, like /plugins, open it on its plugins) (Grok's "Connect apps", IMG_5335,
// and native MCP servers): one large sheet for everything an agent can reach. "7 connected" sits under the title in
// plain grey, a count and not a button; the chips under the head (All, Connected, then the categories) narrow the
// list. Then "Suggested for your repos" (the section says why, so its rows don't each explain themselves), Your
// plugins, MCP servers, and more to connect. A row is two lines at most: the vendor's real mark in one ink on a 40pt
// tile, its name, one line of 30 characters at most (so it is never cut beside its button), and at the right a
// Connect or Sign in button, or, once connected, a grey check with nothing to press. A tap on a row pushes its page in
// the same sheet (PageStack.tsx), with why it was suggested, what it brings and the way to turn it off; "See all" pushes
// the plugins the same way, the head staying put and its X turning into the back chevron. A glass search floats at the
// list's foot.
//
// The plugins and servers are the Plugins page's own (screens/pages/plugins-model.ts), so a plugin connected here is
// on there and in the composer's + at once; the apps are the prototype's stand-in for Cloud's connector catalog.
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, ScrollView, Text, View } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { BrandMark } from "../components/ui/BrandMark";
import { Button } from "../components/ui/Button";
import { PageEmpty } from "../components/ui/Empty";
import { SearchField } from "../components/ui/Field";
import { ScopeChip } from "../components/ui/Floating";
import { haptic } from "../motion";
import { keep } from "../screens/pages/keep";
import { type Logo, type Plugin, pluginStore, type Server } from "../screens/pages/plugins-model";
import { alpha, useTheme } from "../theme";
import { PageStack } from "./PageStack";
import { Sheet, SheetGroup, SheetLabel, SheetRow, useSheetPage } from "./Sheet";
import { useUi } from "./ui";

// ---------------------------------------------------------------- what can be connected

const CATEGORIES = ["Code", "Productivity", "Data", "Design", "Writing"] as const;
type Category = (typeof CATEGORIES)[number];
/** `plugins`: every plugin, yours then the rest ("See all", Profile's and the box's Plugins, /plugins). */
type Filter = "all" | "connected" | "plugins" | Category;

/** Modes are the box's, never something to connect: Grill me is chosen in the + sheet's Modes. */
const MODES = new Set(["grill-me"]);

/** The plugins' own categories, folded into the sheet's few. */
const FOLD: Record<string, Category> = { Code: "Code", Monitoring: "Code", Planning: "Productivity", Workflow: "Productivity", Writing: "Writing", Design: "Design", Data: "Data" };

/** An app from the connector catalog: what Cloud would offer, scripted. */
interface App {
  id: string;
  name: string;
  line: string;
  about: string;
  category: Category;
  logo: Logo;
  /** Why it is suggested, if it is. */
  reason?: string;
  connected: boolean;
  /** It needs you to sign in on its own page before it connects. */
  signIn?: boolean;
}

const APPS: readonly App[] = [
  { id: "vercel", name: "Vercel", line: "Preview links and deploy logs", about: "Each change gets its preview link in the chat, and a failed deploy brings its build log with it.", category: "Code", logo: { brand: "vercel" }, reason: "Because Oona runs vercel deploy", connected: false },
  { id: "slack", name: "Slack", line: "Threads in, summaries out", about: "Start a chat from a thread, and post what an agent finished back to the channel it came from.", category: "Productivity", logo: { brand: "slack" }, reason: "Because Oona works on marketing", connected: false, signIn: true },
  { id: "notion", name: "Notion", line: "Specs and notes as context", about: "Brings a page and the pages it links into a chat, so an agent builds from the spec you wrote.", category: "Productivity", logo: { brand: "notion" }, connected: true },
  { id: "drive", name: "Google Drive", line: "Docs and sheets as context", about: "Reads the docs and sheets you share with it, nothing else.", category: "Productivity", logo: { brand: "googledrive" }, connected: false, signIn: true },
  { id: "supabase", name: "Supabase", line: "Your tables and their logs", about: "Reads the schema and logs of the projects you pick; writes only through a migration you approve.", category: "Data", logo: { brand: "supabase" }, reason: "Because you use Postgres", connected: false },
  { id: "snowflake", name: "Snowflake", line: "Ask the warehouse questions", about: "Runs read-only queries on the warehouse you connect, with the query shown before it runs.", category: "Data", logo: { brand: "snowflake" }, connected: false, signIn: true },
];

const appStore = keep(() => APPS);

/** One row's worth of anything that connects. */
interface Entry {
  key: string;
  kind: "plugin" | "server" | "app";
  name: string;
  line: string;
  about: string;
  category: Category | null;
  logo: Logo | "server";
  reason?: string;
  state: "connected" | "available" | "sign-in";
  /** What it brings, for its page. */
  brings: { label: string; value: string }[];
  by: string;
}

/**
 * A plugin's line as a row here says it: 30 characters at most, so it is never cut beside its button (its own line,
 * longer, is the Plugins page's).
 */
const SHORT: Record<string, string> = {
  "release-notes": "What changed, from your PRs",
  github: "PRs, issues and checks",
  "security-review": "Checks commands for secrets",
  prettier: "Formats each file it edits",
  linear: "Issues in and out of chats",
  sentry: "Errors that start a chat",
  figma: "Frames and comments as context",
};

/** Why a plugin you haven't added is worth it, from what you already use. */
const REASON: Record<string, string> = { "release-notes": "Because you merge on GitHub", sentry: "Because you use GitHub" };

const pluginEntry = (p: Plugin): Entry => ({
  key: `plugin:${p.id}`,
  kind: "plugin",
  name: p.name,
  line: SHORT[p.id] ?? p.line,
  about: p.about,
  category: FOLD[p.category] ?? null,
  logo: p.logo,
  reason: !p.installed ? REASON[p.id] : undefined,
  state: p.installed && p.enabled ? (p.needsConnect ? "sign-in" : "connected") : "available",
  brings: [
    p.skills.length ? { label: p.skills.length === 1 ? "Skill" : "Skills", value: p.skills.join(", ") } : null,
    p.servers.length ? { label: p.servers.length === 1 ? "MCP server" : "MCP servers", value: p.servers.join(", ") } : null,
    p.hooks.length ? { label: p.hooks.length === 1 ? "Hook" : "Hooks", value: `${p.hooks.length}` } : null,
  ].filter((b): b is { label: string; value: string } => b !== null),
  by: p.developer,
});

const serverEntry = (s: Server): Entry => ({
  key: `server:${s.name}`,
  kind: "server",
  name: s.name,
  // What it runs (a command, an address) is too long for a row beside its button: its page says it, under Runs.
  line: `${s.source} · ${s.tools.length} ${s.tools.length === 1 ? "tool" : "tools"}`,
  about: `${s.source}. Its tools: ${s.tools.join(", ")}.`,
  category: "Data",
  logo: "server",
  state: s.status === "needs_sign_in" ? "sign-in" : s.enabled ? "connected" : "available",
  brings: [{ label: "Tools", value: s.tools.join(", ") }, { label: "Runs", value: s.detail }],
  by: s.source,
});

const appEntry = (a: App): Entry => ({
  key: `app:${a.id}`,
  kind: "app",
  name: a.name,
  line: a.line,
  about: a.about,
  category: a.category,
  logo: a.logo,
  reason: a.reason,
  state: a.connected ? "connected" : a.signIn ? "sign-in" : "available",
  brings: [{ label: "Reaches", value: a.line }],
  by: a.name,
});

/** How many things are connected: plugins on and signed in, servers on, apps connected. */
export function connectedCount(plugins: readonly Plugin[], servers: readonly Server[] = pluginStore.get().servers, apps: readonly App[] = appStore.get()) {
  return plugins.filter((p) => p.installed && p.enabled && !p.needsConnect).length + servers.filter((s) => s.enabled && s.status !== "needs_sign_in").length + apps.filter((a) => a.connected).length;
}

/** Everything that connects, as rows, and the way to flip each one. */
function useEntries() {
  const { plugins, servers } = pluginStore.use();
  const apps = appStore.use();
  const entries = useMemo(() => [...plugins.filter((p) => !MODES.has(p.id)).map(pluginEntry), ...servers.map(serverEntry), ...apps.map(appEntry)], [plugins, servers, apps]);
  const set = (entry: Entry, on: boolean) => {
    const [kind, id] = [entry.kind, entry.key.slice(entry.key.indexOf(":") + 1)];
    if (kind === "plugin") pluginStore.set((was) => ({ ...was, plugins: was.plugins.map((p) => (p.id === id ? { ...p, installed: on || p.installed, enabled: on, needsConnect: on ? false : p.needsConnect } : p)) }));
    else if (kind === "server") pluginStore.set((was) => ({ ...was, servers: was.servers.map((s) => (s.name === id ? { ...s, enabled: on, status: on ? "connected" : s.status } : s)) }));
    else appStore.set((was) => was.map((a) => (a.id === id ? { ...a, connected: on } : a)));
  };
  return { entries, set, connected: connectedCount(plugins, servers, apps) };
}

/** What heads the suggestions: why they are there, said once for all of them. */
const SUGGESTED = "Suggested for your repos";

/** The sections for a view: Suggested, your plugins, MCP servers, then the rest to connect. */
function place(entries: readonly Entry[], filter: Filter, q: string): { label: string; keys: string[] }[] {
  const shown = entries.filter((e) => (filter === "all" ? true : filter === "connected" ? e.state === "connected" : filter === "plugins" ? e.kind === "plugin" : e.category === filter) && (!q || `${e.name} ${e.line} ${e.by}`.toLowerCase().includes(q)));
  const keys = (list: readonly Entry[]) => list.map((e) => e.key);
  if (filter === "plugins")
    return [
      { label: "Your plugins", keys: keys(shown.filter((e) => e.state !== "available")) },
      { label: "More plugins", keys: keys(shown.filter((e) => e.state === "available")) },
    ];
  if (q || filter === "connected") return [{ label: filter === "connected" && !q ? "Connected" : `${shown.length} ${shown.length === 1 ? "result" : "results"}`, keys: keys(shown) }];
  const suggested = shown.filter((e) => e.state !== "connected" && e.reason && e.kind !== "server");
  const taken = new Set(keys(suggested));
  return [
    { label: SUGGESTED, keys: keys(suggested) },
    { label: "Your plugins", keys: keys(shown.filter((e) => e.kind === "plugin" && e.state !== "available")) },
    { label: "MCP servers", keys: keys(shown.filter((e) => e.kind === "server")) },
    { label: "Apps", keys: keys(shown.filter((e) => e.kind === "app" && !taken.has(e.key))) },
    { label: "More plugins", keys: keys(shown.filter((e) => e.kind === "plugin" && e.state === "available" && !taken.has(e.key))) },
  ];
}

// ---------------------------------------------------------------- the sheet

/** The root view of everything, the plugins alone ("See all", or asked for), and a connection's page ("page:<key>"). */
const ALL = "all";
const PLUGINS = "plugins";
const PAGE = "page:";

export function ConnectSheet({ open, onClose, at: given }: { open: boolean; onClose: () => void; /** Opens on its plugins, whatever the shell asked (the composer's Plugins). */ at?: "plugins" }) {
  const { c } = useTheme();
  const { entries, set, connected } = useEntries();
  const asked = useUi((s) => s.connectAt);
  const at = given ?? asked;
  // Opened on its plugins over another sheet (the composer's Plugins), the plugins are its first page and Back goes
  // back to that sheet; opened on its own onto them, everything waits beneath, as "See all" leaves it.
  const over = (useSheetPage()?.index ?? 0) > 0;
  const first = (): string[] => (at === "plugins" ? (over ? [PLUGINS] : [ALL, PLUGINS]) : [ALL]);
  const [pages, setPages] = useState<string[]>(first);
  const [chip, setChip] = useState<Filter>("all");
  // A connect takes a moment, as signing in would: the row says so until it lands.
  const [busy, setBusy] = useState<Record<string, true>>({});
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Each time it opens it starts on All (or the plugins it was asked for), with its sections settled afresh, however
  // it was last put away (another sheet can take its place without its X being pressed).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPages(first());
      setChip("all");
    }
  }
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const push = (key: string) => setPages((was) => [...was, key]);
  const back = () => {
    haptic.tick();
    setPages((was) => (was.length > 1 ? was.slice(0, -1) : was));
  };
  const connect = (entry: Entry) => {
    haptic.tap();
    setBusy((b) => ({ ...b, [entry.key]: true }));
    timers.current.push(
      setTimeout(
        () => {
          set(entry, true);
          setBusy(({ [entry.key]: _, ...rest }) => rest);
          haptic.done();
          if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(`${entry.name} connected`);
        },
        entry.state === "sign-in" ? 1400 : 700,
      ),
    );
  };
  const disconnect = (entry: Entry) => {
    haptic.thud();
    set(entry, false);
  };

  const titleOf = (key: string) => (key === ALL ? "Connect" : key === PLUGINS ? "Plugins" : (entries.find((e) => e.key === key.slice(PAGE.length))?.name ?? "Connect"));
  const top = pages[pages.length - 1] ?? ALL;
  const under = pages[pages.length - 2];
  const page = (key: string) => {
    if (key.startsWith(PAGE)) {
      const opened = entries.find((e) => e.key === key.slice(PAGE.length));
      return opened ? <Detail entry={opened} busy={!!busy[opened.key]} onConnect={() => connect(opened)} onDisconnect={() => disconnect(opened)} /> : null;
    }
    return (
      <ConnectList
        entries={entries}
        filter={key === PLUGINS ? "plugins" : chip}
        onFilter={key === PLUGINS ? undefined : setChip}
        busy={busy}
        onOpen={(e) => push(`${PAGE}${e.key}`)}
        onConnect={connect}
        onSeeAll={key === ALL ? () => push(PLUGINS) : undefined}
      />
    );
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      detent="large"
      // A connection's page has its name under its logo, so its head has no title.
      title={top.startsWith(PAGE) ? undefined : titleOf(top)}
      subtitle={top === ALL ? `${connected} connected` : undefined}
      closeLabel="Close Connect"
      back={under ? { label: `Back to ${titleOf(under)}`, onPress: back, title: under.startsWith(PAGE) ? undefined : titleOf(under), subtitle: under === ALL ? `${connected} connected` : undefined } : undefined}
      depth={pages.length - 1}
    >
      <PageStack pages={pages} render={page} onBack={back} ground={c.popover} />
    </Sheet>
  );
}

/** A list of what connects: the chips (on All), the sections, and a glass search floating at its foot. */
function ConnectList({
  entries,
  filter,
  onFilter,
  busy,
  onOpen,
  onConnect,
  onSeeAll,
}: {
  entries: readonly Entry[];
  filter: Filter;
  /** The chips under the head narrow the list; the plugins view is one kind already, so it has none. */
  onFilter?: (f: Filter) => void;
  busy: Record<string, true>;
  onOpen: (entry: Entry) => void;
  onConnect: (entry: Entry) => void;
  /** Your plugins leads to all of them, pushed in this same sheet. */
  onSeeAll?: () => void;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const [query, setQuery] = useState("");
  const placed = useRef<{ view: string; groups: { label: string; keys: string[] }[] } | null>(null);

  const q = query.trim().toLowerCase();
  // Which section each row sits in is settled when the view is (a filter, a search), not when a row connects: a row
  // you just connected stays under your thumb with its button turned to Connected.
  const view = `${filter}|${q}`;
  if (!placed.current || placed.current.view !== view) placed.current = { view, groups: place(entries, filter, q) };
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const groups = placed.current.groups.map((g) => ({ label: g.label, list: g.keys.flatMap((k) => byKey.get(k) ?? []) }));
  const empty = groups.every((g) => !g.list.length);
  const foot = useAnimatedStyle(() => ({ bottom: keyboard.height.value > 0 ? 8 : Math.max(insets.bottom, 8) + 8 }));
  const room = 44 + Math.max(insets.bottom, 8) + 40;

  return (
    <View style={{ flex: 1 }}>
      {/* Room above and below the chips, so a chosen chip's shadow isn't cut by the scroller. */}
      {onFilter ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0, marginTop: -10, marginBottom: -2 }} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, gap: 8, alignItems: "center" }}>
          {(["all", "connected", ...CATEGORIES] as const).map((f) => (
            <ScopeChip
              key={f}
              label={f === "all" ? "All" : f === "connected" ? "Connected" : f}
              on={filter === f}
              onPress={() => {
                haptic.tick();
                onFilter(f);
              }}
            />
          ))}
        </ScrollView>
      ) : null}
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: room }}>
        {groups
          .filter((g) => g.list.length)
          .map((g, i) => (
            <View key={g.label}>
              <SheetLabel
                first={i === 0}
                right={
                  g.label === "Your plugins" && onSeeAll && filter === "all" ? (
                    <Button
                      label="See all"
                      variant="ghost"
                      size="small"
                      accessibilityLabel="See all plugins"
                      onPress={() => {
                        haptic.tick();
                        onSeeAll();
                      }}
                    />
                  ) : undefined
                }
              >
                {g.label}
              </SheetLabel>
              {g.list.map((e, j) => (
                <ConnectRow key={e.key} entry={e} divided={j > 0} busy={!!busy[e.key]} onOpen={() => onOpen(e)} onConnect={() => onConnect(e)} />
              ))}
            </View>
          ))}
        {empty ? (
          <View style={{ paddingTop: 48 }}>
            <PageEmpty title={q ? `Nothing called “${query.trim()}”` : "Nothing here yet"} line={q ? "Try its company's name, or what it does." : "Connect something from All, and it shows here."} />
          </View>
        ) : null}
      </ScrollView>
      {/* The rows go soft under the search, so the glass reads over them. */}
      <LinearGradient pointerEvents="none" colors={[alpha(c.popover, 0), alpha(c.popover, 0.9)]} style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: room + 8 }} />
      <Animated.View style={[{ position: "absolute", left: 16, right: 16 }, foot]}>
        <SearchField variant="capsule" glass value={query} onChangeText={setQuery} placeholder="Search apps, plugins and servers" accessibilityLabel="Search apps, plugins and MCP servers" />
      </Animated.View>
    </View>
  );
}

// ---------------------------------------------------------------- rows

const TILE = 40;

/**
 * A logo on the one tile every connection wears (GitHub's): 40pt, the raised grey, a hairline edge, rounded 10, and the
 * vendor's real mark at 22 in its own colours (the black-and-white ones in the text's ink). Caveman's own wear
 * their pixel drawing, a vendor with no mark to copy the pixel Plugins glyph, and an MCP server the connector glyph.
 */
function LogoTile({ logo, size = TILE }: { logo: Entry["logo"]; size?: number }) {
  const { c } = useTheme();
  const big = size > TILE;
  const tile = { width: size, height: size, borderRadius: big ? 16 : 10, borderWidth: 1, borderColor: c.hairline, backgroundColor: c.raised, alignItems: "center" as const, justifyContent: "center" as const };
  const mark = logo === "server" ? <PixelIcon name="tool-mcp" size={big ? 32 : 22} ink={c.text} /> : "brand" in logo ? <BrandMark name={logo.brand} size={big ? 34 : 22} color={c.text} /> : <PixelIcon name={"pixel" in logo ? logo.pixel : "spaces"} size={big ? 32 : 22} ink={c.text} />;
  return <View style={tile}>{mark}</View>;
}

/** Connect or Sign in, filled, on a row that isn't connected; Connecting… while it lands; a grey check once it has. */
function Action({ entry, busy, onConnect }: { entry: Entry; busy: boolean; onConnect: () => void }) {
  const { c } = useTheme();
  if (busy) return <Button label={entry.state === "sign-in" ? "Signing in…" : "Connecting…"} size="small" variant="ghost" disabled accessibilityLabel={`Connecting ${entry.name}`} />;
  if (entry.state !== "connected") return <Button label={entry.state === "sign-in" ? "Sign in" : "Connect"} size="small" onPress={onConnect} accessibilityLabel={`${entry.state === "sign-in" ? "Sign in to" : "Connect"} ${entry.name}`} />;
  return (
    <View accessible accessibilityLabel={`${entry.name} is connected`} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
      <Icon name="check" size={20} stroke={2} color={c.muted} />
    </View>
  );
}

function ConnectRow({ entry, divided, busy, onOpen, onConnect }: { entry: Entry; divided: boolean; busy: boolean; onOpen: () => void; onConnect: () => void }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  const line = entry.line;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: held ? alpha(c.text, 0.05) : undefined }}>
      {divided ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 20 + TILE + 12, right: 20, height: 1, backgroundColor: c.hairline }} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${entry.name}, ${line}, ${entry.state === "connected" ? "connected" : entry.state === "sign-in" ? "needs sign in" : "not connected"}`}
        accessibilityHint="Opens what it brings"
        onPressIn={() => setHeld(true)}
        onPressOut={() => setHeld(false)}
        onPress={() => {
          haptic.tick();
          onOpen();
        }}
        style={[{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 20, paddingVertical: 13 }, { outlineStyle: "none" } as object]}
      >
        <LogoTile logo={entry.logo} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={[t.row, { fontSize: 17, lineHeight: 22 }]}>
            {entry.name}
          </Text>
          <Text numberOfLines={1} style={[t.small, { fontSize: 14, lineHeight: 19, marginTop: 1 }]}>
            {line}
          </Text>
        </View>
      </Pressable>
      <View style={{ paddingLeft: 12, paddingRight: entry.state === "connected" && !busy ? 8 : 16 }}>
        <Action entry={entry} busy={busy} onConnect={onConnect} />
      </View>
    </View>
  );
}

/** One connection, opened in place: its tile, its name and line, the one way forward, then what it brings. */
function Detail({ entry, busy, onConnect, onDisconnect }: { entry: Entry; busy: boolean; onConnect: () => void; onDisconnect: () => void }) {
  const { c, t } = useTheme();
  const insets = useSafeAreaInsets();
  const on = entry.state === "connected";
  const kind = entry.kind === "server" ? "MCP server" : entry.kind === "plugin" ? "Plugin" : "App";
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
      <View style={{ alignItems: "center", paddingHorizontal: 24, paddingTop: 12 }}>
        <LogoTile logo={entry.logo} size={64} />
        <Text accessibilityRole="header" style={[t.title, { marginTop: 16, textAlign: "center" }]}>
          {entry.name}
        </Text>
        <Text style={[t.row, { fontSize: 15, lineHeight: 21, color: c.muted, marginTop: 4, textAlign: "center", maxWidth: 320 }]}>{entry.line}</Text>
        {entry.reason && !on ? <Text style={[t.meta, { marginTop: 6, textAlign: "center", maxWidth: 320 }]}>{entry.reason}</Text> : null}
        {/* Connected says so quietly; the way to turn it off waits at the foot. Otherwise the one way forward. */}
        {on ? (
          <View accessible accessibilityLabel="Connected" style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 14 }}>
            <Icon name="check" size={16} stroke={2.2} color={c.success} />
            <Text style={[t.row, { fontSize: 15, color: c.success }]}>Connected</Text>
          </View>
        ) : (
          <View style={{ marginTop: 20, alignSelf: "stretch" }}>
            {busy ? (
              <Button label={entry.state === "sign-in" ? "Signing in…" : "Connecting…"} variant="secondary" stretch disabled />
            ) : (
              <Button label={entry.state === "sign-in" ? `Sign in to ${entry.name}` : `Connect ${entry.name}`} variant="primary" stretch onPress={onConnect} />
            )}
          </View>
        )}
      </View>
      <SheetGroup label="About">
        <Paragraph>{entry.about}</Paragraph>
      </SheetGroup>
      <SheetGroup label="Details">
        <SheetRow label="Kind" value={kind} />
        <SheetRow label="From" value={entry.by} />
        {entry.category ? <SheetRow label="Category" value={entry.category} /> : null}
        {on ? null : <SheetRow label="Status" value={entry.state === "sign-in" ? "Needs sign in" : "Not connected"} />}
      </SheetGroup>
      {entry.brings.length ? (
        <SheetGroup label="What it brings">
          {entry.brings.map((b) => (
            <SheetRow key={b.label} label={b.label} detail={b.value} />
          ))}
        </SheetGroup>
      ) : null}
      {on ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 32 }}>
          <Button label={`Disconnect ${entry.name}`} variant="destructive" stretch onPress={onDisconnect} />
        </View>
      ) : null}
    </ScrollView>
  );
}

function Paragraph({ children }: { children: ReactNode }) {
  const { t } = useTheme();
  return <Text style={[t.prose, { paddingHorizontal: 20, paddingTop: 4 }]}>{children}</Text>;
}
