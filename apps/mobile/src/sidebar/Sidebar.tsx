// The sidebar behind the main panel (shell/drawer.ts), for clean mobile navigation, 2026-11-07: "a simple
// depthful sidebar like this that lives behind the main panel"). At the top you, the queue's hourglass and Search;
// then the Chiefs, the ones you opened last first; then the chats, by project (Pinned, a folder per project, Recent)
// or, with the hourglass lit, as the queue: upstream standard sidebar, sorted by state into shelves.
//
// Signed in to Caveman, it is the person's own: every chat of theirs on every computer in one list, by project, each
// row saying where it runs as a small mark (the Mac's name, or "Cloud") with that place's one state word when it does
// not simply run. Nothing of the scripted world's stands beside them: no scripted name, pull requests, automations or
// Chiefs, and no Recent shelf repeating the same rows. Signed out there, the list is empty beside "Sign in to Caveman".
//
// It is drawn full
// height behind the panel, whose sliver covers its right SIDEBAR_SLIVER points, so everything here lays out in the
// width left of it; where it stands beside the panel instead (the Duo unfolded, shell/layout.tsx), in its own column.
// Every fold, dropdown and the mode are the drawer's, kept on disk, so the sidebar opens as you left it; the Chiefs'
// order is kept beside it (sidebar/recent.ts).
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useMemo, useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut, interpolate, LayoutAnimationConfig, LinearTransition, type SharedValue, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass } from "../components/Glass";
import { Icon } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { Squish } from "../components/Squish";
import { duration, ease } from "../motion";
import { showChat, showChief, showNewChat, showPlace } from "../nav/ref";
import { usePullListWhile } from "../pulls/live";
import { PullRows } from "../pulls/PullRows";
import { openGuide } from "../review/lookup";
import { closeSidebar, drawer, openSidebar, setSidebarMode, SIDEBAR_SLIVER, toggleExpanded, useDrawer } from "../shell/drawer";
import { useShell } from "../shell/layout";
import { useMe } from "../shell/me";
import * as script from "../board/script";
import { type Anchor, Menu } from "../components/ui/Menu";
import { ChatPeek, chatEntries } from "../shell/ChatParts";
import { useInbox } from "../shell/inbox";
import { archive, openNewChief, openProfile, openSearch, openSettings, useUi } from "../shell/ui";
import { useStore } from "../store/store";
import { useChiefList } from "../store/select";
import { alpha, layout, useTheme, weight } from "../theme";
import { useFailingAutomations, useFolds, useHere, useMinute, useSideChats, useWaitingPrs } from "./data";
import { chiefsView, CUT, cutOff, type Folds, type Here, isHere, projectsView, queueView, type Section, type SectionKind, type SideChat, toggledFold } from "./model";
import { Agents, ChatRow, type ChiefLine, ChiefRow, HeadGlyph, MoreRow, NewChiefRow, PlaceRow, type RowActions, SectionHead, ShowMoreChiefs, TEXT_X } from "./parts";
import { opened, useOpened } from "./recent";

/** The header's row, under the status bar: the 44 pt circles with room around them. */
const HEADER = 60;

const arrive = FadeIn.duration(duration.fast).easing(ease.snap);
const leave = FadeOut.duration(120).easing(ease.snap);
const move = LinearTransition.duration(duration.fast).easing(ease.snap);

/** Folds a section, or opens it; one that starts shut (a quiet project) opens against that. */
const toggle = (key: string, startsShut = false) => drawer.dispatch((s) => ({ ...s, ...toggledFold(s, key, startsShut) }));

// What a row does. Each way into the main panel closes the sidebar (nav/ref.ts show…).
/** The row held down and where it stands: its menu hangs from it (HoldMenu). One at a time, for the whole sidebar. */
let showHold: ((held: { id: string; at: Anchor } | null) => void) | null = null;

const actions: RowActions = {
  // A parent whose subagent asks opens on that ask, its parent in under it (nav/ref.ts openRow).
  onOpen: (row) => showChat(row.opens),
  // The pull request's guide, pushed over the main panel as Review's rows push it (review/lookup.ts openGuide).
  onGuide: (row) => {
    closeSidebar();
    openGuide(row.id);
  },
  onAgents: (row) => toggleExpanded(`agents:${row.id}`),
  onHold: (row, at) => showHold?.({ id: row.id, at }),
};

/**
 * A chat's menu on a hold: the list rows' own
 * (shell/ChatParts.tsx chatEntries: pin, done, snooze, read, archive) under Open and its guide, with the chat's peek
 * on top, hung from the row as a list row's is.
 */
function HoldMenu() {
  const [held, setHeld] = useState<{ id: string; at: Anchor } | null>(null);
  useEffect(() => {
    showHold = setHeld;
    return () => {
      if (showHold === setHeld) showHold = null;
    };
  }, []);
  const chats = useStore((s) => s.board.chats);
  const inbox = useInbox(chats, null);
  const chat = held ? chats.find((c) => c.id === held.id) : undefined;
  if (!held || !chat) return null;
  const close = () => setHeld(null);
  const hasGuide = chat.phase === "ready" && !!chat.moment;
  return (
    <Menu
      open
      onClose={close}
      anchor={held.at}
      width={Math.min(300, held.at.width)}
      header={<ChatPeek chat={chat} inbox={inbox} />}
      entries={[
        { label: "Open", icon: "open", onPress: () => showChat(chat.id) },
        ...(hasGuide
          ? [
              {
                label: "Open the guide",
                icon: "pullRequest" as const,
                onPress: () => {
                  closeSidebar();
                  openGuide(chat.id);
                },
              },
            ]
          : []),
        { type: "separator" as const },
        ...chatEntries(chat, inbox, { pin: (pinned) => script.pin(chat.id, pinned), archive: () => archive(chat.id) }),
      ]}
    />
  );
}

// ---------------------------------------------------------------- the header

/** Your initial on the raised grey in a glass circle, as Home's bar drew it, and your name: Profile. */
function You() {
  const { c, t } = useTheme();
  const me = useMe();
  // On your own board you are your Caveman account, by its email; signed out there, nobody is named, and the one
  // row under it says what to do ("Sign in to Caveman"), so this says only whose app it is.
  const ME = { name: me.name || "Caveman", initial: me.initial, organization: me.organization };
  return (
    <Squish
      label={`${ME.name}: ${me.scripted ? "profile, automations and settings" : "profile and settings"}`}
      onPress={() => {
        closeSidebar();
        openProfile();
      }}
      depth={0.97}
      // Never wider than its room, so a narrower sidebar (the Duo's column) shortens the name rather than running it
      // under the circles.
      style={{ flexDirection: "row", alignItems: "center", gap: 10, maxWidth: "100%" }}
    >
      <Glass interactive style={{ width: layout.float, height: layout.float, borderRadius: layout.float / 2, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.raised, alignItems: "center", justifyContent: "center" }}>
          {ME.initial ? <Text style={[t.label, { fontSize: 16, lineHeight: 20, fontWeight: weight.semibold }]}>{ME.initial}</Text> : <Icon name="lock" size={18} color={c.muted} />}
        </View>
      </Glass>
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[t.label, { fontSize: 16, lineHeight: 21, fontWeight: weight.semibold }]}>
          {ME.name}
        </Text>
        {ME.organization ? (
          <Text numberOfLines={1} style={[t.small, { color: c.subtle }]}>
            {ME.organization}
          </Text>
        ) : null}
      </View>
    </Squish>
  );
}

/** How the hourglass shows it is on: an ink disc with the glyph cut out of it, or a tint under a filled glyph. */
const LIT: "ink" | "tint" = "tint";

/** A 44 pt glass circle; `lit`, while its mode is on, it lights up and its glyph fills. */
function Circle({ icon, label, onPress, lit }: { icon: "hourglass" | "search"; label: string; onPress: () => void; lit?: boolean }) {
  const { c, dark } = useTheme();
  const disc = LIT === "ink" ? c.primary : alpha(c.text, dark ? 0.2 : 0.12);
  return (
    <Squish label={label} onPress={onPress} depth={0.88} hitSlop={4} selected={lit}>
      <Glass interactive style={{ width: layout.float, height: layout.float, borderRadius: layout.float / 2, alignItems: "center", justifyContent: "center" }}>
        {lit ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: layout.float / 2, backgroundColor: disc }} /> : null}
        {/* Over the disc: on the web a positioned layer paints over a bare glyph (components/Glass.tsx). */}
        <View style={{ zIndex: 1 }}>
          <Icon name={icon} size={icon === "hourglass" ? 20 : 22} color={lit && LIT === "ink" ? c.onPrimary : c.text} filled={lit} />
        </View>
      </Glass>
    </Squish>
  );
}

function Header({ top, scrolled }: { top: number; scrolled: SharedValue<number> }) {
  const { c } = useTheme();
  const queue = useDrawer((s) => s.mode === "queue");
  // The list scrolls under the header: the shell's own ground under the circles, then a short fade once something is under it.
  const tail = useAnimatedStyle(() => ({ opacity: interpolate(scrolled.value, [0, 16], [0, 1], "clamp") }));
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: top + HEADER, backgroundColor: c.shell }} />
      <Animated.View pointerEvents="none" style={[{ position: "absolute", top: top + HEADER, left: 0, right: 0, height: 28 }, tail]}>
        <LinearGradient colors={[c.shell, alpha(c.shell, 0)]} style={{ flex: 1 }} />
      </Animated.View>
      <View pointerEvents="box-none" style={{ marginTop: top, height: HEADER, flexDirection: "row", alignItems: "center", paddingLeft: 14, paddingRight: 12, gap: layout.floatGap }}>
        {/* The row's own width, so a long name (an account's email) is cut with an ellipsis before the circles. */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <You />
        </View>
        <Circle icon="hourglass" label="Queue" lit={queue} onPress={() => setSidebarMode(queue ? "projects" : "queue")} />
        <Circle
          icon="search"
          label="Search"
          onPress={() => {
            closeSidebar();
            openSearch();
          }}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- the places at the top

/**
 * The places at the top, compact search ("add top sections like this for pr review +
 * automations"): Pull requests with the reviews that wait on you, Automations with the runs that failed.
 */
function Places() {
  const prs = useWaitingPrs();
  const failing = useFailingAutomations();
  const on = useUi((u) => u.focused?.name);
  return (
    <View>
      <PlaceRow icon="pullRequest" label="Pull requests" here={on === "Review"} count={prs} urgent spoken={`${prs} ${prs === 1 ? "waits" : "wait"} on your review`} onPress={() => showPlace("Review")} />
      <PlaceRow icon="clock" label="Automations" here={on === "Automations"} count={failing} spoken={`${failing} failed`} onPress={() => showPlace("Automations")} />
    </View>
  );
}

// ---------------------------------------------------------------- the Chiefs

function Chiefs({ here, folds }: { here: Here; folds: Folds }) {
  const list = useChiefList();
  const lastOpened = useOpened();
  const all = folds.expanded.includes("chiefs");
  const lines: ChiefLine[] = useMemo(() => list.map((r) => ({ id: r.chief.id, name: r.chief.name, character: r.chief.character, tone: r.chief.tone, needs: r.needs, working: r.working, ready: r.ready })), [list]);
  const { shown, hidden } = chiefsView(lines, lastOpened, all, here.chief);
 // The Chiefs stand with the places at the top ("the chiefs still feel like regular chats ...
  // move them more up into the automations type of part"): no heading, each a place with its face; three, then the
  // dropdown, which holds the rest and New Chief.
  return (
    <Animated.View layout={move}>
      {shown.map((chief) => (
        <Animated.View key={chief.id} entering={arrive} layout={move}>
          <ChiefRow chief={chief} here={here.chief === chief.id} onPress={showChief} />
        </Animated.View>
      ))}
 {/* New Chief waits in the dropdown with the rest. */}
      {all ? (
        <Animated.View entering={arrive} exiting={leave}>
          <NewChiefRow
            onPress={() => {
              closeSidebar();
              openNewChief();
            }}
          />
        </Animated.View>
      ) : null}
      <ShowMoreChiefs hidden={hidden} open={all} onPress={() => toggleExpanded("chiefs")} />
    </Animated.View>
  );
}

// ---------------------------------------------------------------- the chats

/** A section's head glyph: a folder per project, the compact layout, the queue's own marks. */
function glyphOf(section: Section) {
  switch (section.kind) {
    case "pinned":
      return <HeadGlyph name="pin" />;
    case "project":
      return <HeadGlyph name="folder" />;
    case "recent":
      return <HeadGlyph name="clock" />;
 // The queue's shelves are named by their words alone.
    case "queue":
    case "working":
    case "snoozed":
    case "settled":
      return null;
  }
}

/** A chat's row and, when its group is open, its subagents under it. */
function RowWithAgents({ row, here, folds, queue, now, shelf }: { row: SideChat; here: Here; folds: Folds; queue: boolean; now: number; shelf: SectionKind }) {
  // Recent repeats rows its projects show already, so a parent opens its subagents in its own folder, not twice.
  const flat = shelf === "recent";
  const open = !flat && row.agents.length > 0 && folds.expanded.includes(`agents:${row.id}`);
  const moreKey = `more:agents:${row.id}`;
  const all = folds.expanded.includes(moreKey);
  const { shown, hidden } = open ? cutOff(row.agents, CUT.agents, all, here.chat) : { shown: [] as readonly SideChat[], hidden: 0 };
  return (
    <Animated.View entering={arrive} layout={move}>
      <ChatRow row={row} here={isHere(row, here, open)} agentsOpen={open} queue={queue} now={now} shelf={shelf} flat={flat} actions={actions} />
      {open ? (
        <Animated.View entering={arrive} exiting={leave}>
          <Agents hidden={hidden} all={all && row.agents.length > CUT.agents} onMore={() => toggleExpanded(moreKey)}>
            {shown.map((agent) => (
              <ChatRow key={agent.id} row={agent} here={here.chat === agent.id} agentsOpen={false} queue={false} now={now} sub actions={actions} />
            ))}
          </Agents>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

function SectionView({ section, here, folds, queue, now }: { section: Section; here: Here; folds: Folds; queue: boolean; now: number }) {
  // What waits on you never folds away.
  const foldable = section.kind !== "queue";
  const count = queue && section.kind !== "pinned" ? section.total : undefined;
  const fewer = section.all && section.cut !== null && section.total > section.cut;
  return (
    <Animated.View layout={move} style={{ marginTop: 18 }}>
      <SectionHead glyph={glyphOf(section)} title={section.title} count={count} shut={section.shut} onToggle={foldable ? () => toggle(section.key, section.startsShut) : undefined} />
      {section.shut ? null : (
        <Animated.View entering={arrive} exiting={leave}>
          {section.rows.map((row) => (
            <RowWithAgents key={row.id} row={row} here={here} folds={folds} queue={queue} now={now} shelf={section.kind} />
          ))}
          {section.hidden > 0 || fewer ? <MoreRow label={fewer ? "Show fewer" : "Load more"} spoken={fewer ? `Show fewer in ${section.title}` : `Load ${section.hidden} more in ${section.title}`} onPress={() => toggleExpanded(section.key)} /> : null}
        </Animated.View>
      )}
    </Animated.View>
  );
}

function Chats({ here, folds }: { here: Here; folds: Folds }) {
  const { c, t } = useTheme();
  const now = useMinute();
  const mode = useDrawer((s) => s.mode);
  const rows = useSideChats(here.chat, now);
  const queue = mode === "queue";
  const me = useMe();
  // The queue is where what waits on you is listed, so the pull requests that wait on your review are there too, under
  // the chats that ask: read from Cloud each time the sidebar opens on its queue, never in the background.
  const open = useDrawer((s) => s.open);
  const waiting = usePullListWhile(queue && me.signedIn, open);
  // On your own board each chat stands once, under its project: no Recent shelf repeats the rows above it.
  const sections = useMemo(() => (queue ? queueView(rows, folds, here) : projectsView(rows, folds, here, now).filter((s) => me.scripted || s.kind !== "recent")), [queue, rows, folds, here, now, me.scripted]);
  // Signed out on your own board: nothing of anybody's is listed, and the one row signs you in.
  if (!me.scripted && !me.signedIn) return <PlaceRow icon="lock" label="Sign in to Caveman" onPress={() => (closeSidebar(), openSettings("account"))} />;
  if (!rows.length && waiting.kind === "none") return <Text style={[t.row, { paddingLeft: TEXT_X, paddingTop: 16, color: c.muted }]}>No chats yet</Text>;
  return (
    // A switch of mode fades the list in whole; inside, only a row that is new arrives.
    <Animated.View key={mode} entering={arrive}>
      <LayoutAnimationConfig skipEntering>
        {sections.map((section) => (
          <SectionView key={section.key} section={section} here={here} folds={folds} queue={queue} now={now} />
        ))}
        <PullRows view={waiting} first={sections.length === 0} onOpen={closeSidebar} />
      </LayoutAnimationConfig>
    </Animated.View>
  );
}

// In development the sidebar's state sits beside the store's on `globalThis.__cc` (board/useBoard.ts): `__cc.sidebar
// .open()`, `.mode("queue")`, `.get()`, so a check can show it over any screen without a swipe.
if (__DEV__) {
  const g = globalThis as { __cc?: Record<string, unknown> };
  g.__cc = { ...g.__cc, sidebar: { get: drawer.get, open: openSidebar, close: closeSidebar, mode: setSidebarMode, opened: () => opened.get() } };
}

// ---------------------------------------------------------------- the sidebar

export function Sidebar() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const shell = useShell();
  const here = useHere();
  const folds = useFolds();
  const scripted = useMe().scripted;
  const scrolled = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrolled.value = e.contentOffset.y;
  });
  return (
    <View style={{ flex: 1, backgroundColor: c.shell }}>
      <View style={{ flex: 1, width: shell.split ? shell.side : width - SIDEBAR_SLIVER }}>
        <LayoutAnimationConfig skipEntering>
          <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: insets.top + HEADER + 2, paddingBottom: Math.max(insets.bottom, 12) + layout.float + 32 }}>
            {/* The scripted world's pull requests, automations and Chiefs stand only on the scripted board. */}
            {scripted ? <Places /> : null}
            {scripted ? <Chiefs here={here} folds={folds} /> : null}
            <Chats here={here} folds={folds} />
          </Animated.ScrollView>
        </LayoutAnimationConfig>
        <Header top={insets.top} scrolled={scrolled} />
        <NewChat bottom={insets.bottom} />
        <HoldMenu />
      </View>
    </View>
  );
}

/**
 * A new chat, one tap from anywhere in the sidebar ("a very easy button to the bottom left with a
 * pencil or new chat icon w like a box and say Chat ... w liquid glass"): a glass capsule at the bottom left, the
 * compose glyph and "Chat", over a short fade so the rows under it give way.
 */
function NewChat({ bottom }: { bottom: number }) {
  const { c, t } = useTheme();
  const foot = Math.max(bottom, 12) + 8;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: foot + layout.float + 24 }}>
      <LinearGradient pointerEvents="none" colors={[alpha(c.shell, 0), c.shell]} locations={[0, 0.55]} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} />
      <View pointerEvents="box-none" style={{ position: "absolute", left: 14, bottom: foot }}>
        <Squish label="New chat" onPress={showNewChat} depth={0.92} hitSlop={4}>
          <Glass interactive style={{ height: layout.float, borderRadius: layout.float / 2, paddingLeft: 14, paddingRight: 18, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="compose" size={19} color={c.text} />
            <Text style={[t.label, { fontSize: 16, lineHeight: 20 }]}>Chat</Text>
          </Glass>
        </Squish>
      </View>
    </View>
  );
}
