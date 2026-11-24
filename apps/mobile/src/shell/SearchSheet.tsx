// Search, from Home's glass circle and a pull down on Home (native, home-C s4): a large sheet that opens with the
// keyboard up and something to show before you type, what needs you and then what moved last. Under the field, scope
// chips: All, each Chief by its character alone (VoiceOver says whose), a rule, then each workspace. As you type, the
// places whose names start with what you typed come first (a Chief as its character row with its live line, a
// workspace, a device), then every chat that matches by title, by where it is, or by something said in it (store/
// select.ts search), most urgent first, under a count, then what the Chiefs said in their own chats: their prose and an
// Update's counting sentence, never the chats they name (a pill or a roll call's row is a reference to a chat, found
// as that chat), and never a line whose only match is the title of a chat already listed. A chat's row is
// the list's two lines (state, title, "Needs you · workspace · age", never more than three parts, DECISIONS O7) and,
// for a match inside it, a third with the words around it, the hit at full ink. Opening a match inside a chat or a
// Chief's chat lands on that message: its id goes to the scroll anchor (store/sessions.ts setAnchor), which the
// thread and the Chief open on.
import { StackActions } from "@react-navigation/native";
import { type ReactNode, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { type Chat, type Chief, CHIEFS, chiefById, chiefOf, type Phase, PROJECTS, type Said } from "../board/model";
import { blocksOf, tallyOf } from "../chief/turns";
import { DeviceGlyph, PixelIcon } from "../components/Pixel";
import { Sprite } from "../components/Sprite";
import { StateWord } from "./rows/StateWord";
import { STATE_WORD, StateDot } from "../components/ui/Badge";
import { PageEmpty } from "../components/ui/Empty";
import { SearchField } from "../components/ui/Field";
import { ScopeChip } from "../components/ui/Floating";
import { DeviceLine, deviceGlyph, deviceWords } from "../home/DeviceRows";
import { LiveLine } from "../home/LiveLine";
import { type ChiefCard, useChiefCards, useMinute } from "../home/model";
import { Portrait } from "../home/Portrait";
import { WorkspaceLine } from "../home/WorkspaceRows";
import { haptic } from "../motion";
import { navigationRef, showChat, showChief, showRow } from "../nav/ref";
import { closeSidebar } from "./drawer";
import { type Ask, askOf, type DeviceRow, type SearchHit, URGENCY, useAskQueue, useDevices, useRows, useSearch, useWorkspaces, type WorkspaceRow } from "../store/select";
import { chiefScope, setAnchor } from "../store/sessions";
import { useStore } from "../store/store";
import { alpha, layout, mono, useTheme, weight } from "../theme";
import { rowAge, useInbox } from "./inbox";
import { Sheet, SheetLabel } from "./Sheet";

/** How many matches a search draws: past this, another word narrows faster than scrolling would. */
const SHOWN = 60;
/** How many lines from the Chiefs' chats it draws, newest first. */
const SAID_SHOWN = 20;

type Scope = { kind: "all" } | { kind: "chief"; id: string } | { kind: "workspace"; name: string };
const ALL: Scope = { kind: "all" };
const sameScope = (a: Scope, b: Scope) => a.kind === b.kind && (a.kind !== "chief" || a.id === (b as typeof a).id) && (a.kind !== "workspace" || a.name === (b as typeof a).name);

/** The words of a query, for marking them where they appear. */
const wordsOf = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/**
 * A place's name starts with what was typed: the whole name, or one of its words ("cloud" finds Caveman Cloud,
 * "mac" finds Julius's MacBook Pro). A name that is exactly the query ranks first.
 */
function startsWith(name: string, words: readonly string[]): 0 | 1 | null {
  const whole = name.toLowerCase();
  if (whole === words.join(" ")) return 0;
  const parts = whole.split(/[\s\-_/.']+/).filter(Boolean);
  return words.every((w) => whole.startsWith(w) || parts.some((p) => p.startsWith(w))) ? 1 : null;
}

/** `text` cut into runs, the runs that are one of `words` marked. */
function runs(text: string, words: readonly string[]): { text: string; hit: boolean }[] {
  if (!words.length) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const w of words) for (let at = lower.indexOf(w); at >= 0; at = lower.indexOf(w, at + w.length)) marked.fill(true, at, at + w.length);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && last.hit === marked[i]) last.text += text[i];
    else out.push({ text: text[i]!, hit: marked[i]! });
  }
  return out;
}

/** The words around a match at `at`, cut at words, the match apart so it can be marked. */
function snippetAround(text: string, at: number, length: number): NonNullable<SearchHit["snippet"]> {
  const start = Math.max(0, at - 36);
  const end = Math.min(text.length, at + length + 64);
  const before = start > 0 ? `…${text.slice(start, at).replace(/^\S*\s/, "")}` : text.slice(0, at);
  const after = text.slice(at + length, end) + (end < text.length ? "…" : "");
  return { before, match: text.slice(at, at + length), after };
}

/**
 * A Chief's line as search reads it, the way its chat shows it: its prose with each chat it names by title, and each
 * roll call by its counting sentence ("One needs you, two are running."). `own` is where the words are its own: not
 * a chat's title (a pill is a reference to a chat, which search finds as that chat), and not a roll call's rows, which
 * are left out altogether.
 */
function indexed(text: string, chats: readonly Chat[], titleOf: (id: string) => string): { text: string; own: [number, number][] } {
  let out = "";
  const own: [number, number][] = [];
  const put = (part: string, mine: boolean) => {
    if (!part) return;
    if (mine) own.push([out.length, out.length + part.length]);
    out += part;
  };
  for (const block of blocksOf(text)) {
    if (out) put(" ", true);
    if (block.kind === "roster") {
      put(tallyOf(block.ids, chats), true);
      continue;
    }
    const prose = block.text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
    for (const part of prose.split(/(\[\[[\w-]+\]\])/)) {
      const ref = /^\[\[([\w-]+)\]\]$/.exec(part);
      put(ref ? titleOf(ref[1]!) : part, !ref);
    }
  }
  return { text: out, own };
}

/**
 * Where each word of the query is said in a Chief's own words, outside `taken` (the titles of chats already listed):
 * the first such place for each, or null when a word is said only in a chat's name.
 */
function ownMatches(text: string, own: readonly [number, number][], taken: readonly [number, number][], words: readonly string[]): number[] | null {
  const lower = text.toLowerCase();
  const inside = (spans: readonly [number, number][], at: number, end: number) => spans.some(([a, b]) => at >= a && end <= b);
  const out: number[] = [];
  for (const w of words) {
    let found = -1;
    for (let at = lower.indexOf(w); at >= 0; at = lower.indexOf(w, at + 1))
      if (inside(own, at, at + w.length) && !inside(taken, at, at + w.length)) {
        found = at;
        break;
      }
    if (found < 0) return null;
    out.push(found);
  }
  return out;
}

/** A line from a Chief's chat that says every word, with where it was said. */
interface SaidHit {
  line: Said;
  chief: Chief;
  snippet: NonNullable<SearchHit["snippet"]>;
}

export function SearchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>(ALL);
  // It opens empty on All each time, however it was last put away.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setScope(ALL);
    }
  }
  const words = wordsOf(query);
  const typed = words.length > 0;
  const found = useSearch(query);
  // What waits on you, the longest-waiting first: the Needs you list's order and Next's (store/select.ts askQueue).
  const queue = useAskQueue();
  const rows = useRows();
  const chats = useStore((s) => s.board.chats);
  const said = useStore((s) => s.board.said);
  const inbox = useInbox(
    useMemo(() => rows.map((r) => r.chat), [rows]),
    null,
  );
  const cards = useChiefCards();
  const workspaces = useWorkspaces();
  const devices = useDevices();
  const now = useMinute();

  const inScope = (chat: Chat) => (scope.kind === "chief" ? chiefOf(chat) === scope.id : scope.kind === "workspace" ? chat.repo === scope.name : true);
  // Most urgent first; within a state, the order search gave (titles before places before messages).
  const hits = useMemo(() => found.filter((h) => inScope(h.chat)).sort((a, b) => URGENCY[a.phase] - URGENCY[b.phase]), [found, scope]);
  const waiting = useMemo(() => queue.map((a) => a.row).filter((r) => inScope(r.chat)), [queue, scope]);
  const recent = useMemo(
    () =>
      rows
        .filter((r) => r.phase !== "needs" && inScope(r.chat))
        .slice()
        .sort((a, b) => b.chat.updatedAt - a.chat.updatedAt)
        .slice(0, 8),
    [rows, scope],
  );

  // Places whose names start with what was typed: a Chief, a workspace or a device is somewhere to go, above the chats.
  const rank = <T,>(list: readonly T[], name: (x: T) => string) =>
    list
      .map((x) => ({ x, r: startsWith(name(x), words) }))
      .filter((p): p is { x: T; r: 0 | 1 } => p.r !== null)
      .sort((a, b) => a.r - b.r)
      .map((p) => p.x);
  const placing = typed && scope.kind === "all";
  const chiefHits = placing ? rank(cards.filter((card): card is ChiefCard & { chief: Chief } => card.chief !== null), (card) => card.chief.name) : [];
  const placeHits = placing ? rank(workspaces, (w) => w.name) : [];
  const deviceHits = placing ? rank(devices, (d) => d.device.name) : [];
  const places = useMemo(() => [...new Set<string>([...PROJECTS, ...workspaces.map((w) => w.name)])], [workspaces]);

  // What the Chiefs said, and what you said to them, as their chats read it: a chat they name reads by its title, a roll
  // call by its counting sentence. Only their own words are searched: a chat named in a line is found as that chat,
  // and a line that says a word only in the title of a chat already listed above adds nothing to it.
  const saidHits = useMemo((): SaidHit[] => {
    if (!typed || scope.kind === "workspace") return [];
    const titleOf = (id: string) => {
      const chat = chats.find((c) => c.id === id);
      return chat ? inbox.title(chat) : id;
    };
    const listed = hits.slice(0, SHOWN).map((h) => inbox.title(h.chat).toLowerCase()).filter(Boolean);
    const out: SaidHit[] = [];
    for (let i = said.length - 1; i >= 0 && out.length < SAID_SHOWN; i--) {
      const line = said[i]!;
      if (line.who === "call" || (scope.kind === "chief" && line.chief !== scope.id)) continue;
      const { text, own } = indexed(line.text, chats, titleOf);
      const lower = text.toLowerCase();
      const taken: [number, number][] = [];
      for (const title of listed) for (let at = lower.indexOf(title); at >= 0; at = lower.indexOf(title, at + 1)) taken.push([at, at + title.length]);
      const at = ownMatches(text, own, taken, words);
      if (!at) continue;
      // The snippet centres on the longest word, where the line itself says it.
      const longest = words.reduce((best, w, j) => (w.length > words[best]!.length ? j : best), 0);
      out.push({ line, chief: chiefById(line.chief), snippet: snippetAround(text, at[longest]!, words[longest]!.length) });
    }
    return out;
  }, [typed, query, scope, said, chats, inbox.title, hits]);

  const leave = () => {
    onClose();
    setQuery("");
    setScope(ALL);
  };
  const go = (chat: Chat, hit?: SearchHit) => {
    // A match inside the chat lands on its message: the thread opens on its scroll anchor.
    if (hit?.itemId) setAnchor(chat.id, { row: hit.itemId, offset: 0 });
    leave();
    // A hit on a message opens the chat it was said in; a chat whose subagent asks opens on that ask. Either is a jump,
    // so it becomes the main panel's root, as the sidebar opens it.
    if (hit?.itemId) showChat(chat.id);
    else showRow(chat.id);
  };
  const goChief = (id: string, line?: Said) => {
    // A line from its chat lands on that line: the Chief opens on its scroll anchor.
    if (line) setAnchor(chiefScope(id), { row: `said:${line.id}`, offset: 0 });
    leave();
    showChief(id);
  };
  const push = (route: "Workspace" | "Agents", params: { id: string } | { filter: "all"; device: string }) => {
    leave();
    // A place's page is pushed over the panel, which comes back from beside the sidebar to show it.
    closeSidebar();
    if (navigationRef.isReady()) navigationRef.dispatch(StackActions.push(route, params));
  };
  const parentTitle = (chat: Chat) => {
    const parent = chat.parent ? chats.find((c) => c.id === chat.parent) : undefined;
    return parent ? inbox.title(parent) : null;
  };
  // The one ask (store/select.ts askOf): the same question as Home, the lists and the Chief, then the command.
  const askFor = (chat: Chat, phase: Phase): Ask | null => {
    if (phase !== "needs") return null;
    const ask = askOf(chat, chats);
    return ask.command ? ask : null;
  };

  const row = (chat: Chat, phase: Phase, i: number, hit?: SearchHit) => (
    <Hit
      key={`${chat.id}-${hit?.itemId ?? hit?.field ?? ""}`}
      divided={i > 0}
      phase={phase}
      title={inbox.title(chat)}
      place={chat.parent ? `in ${parentTitle(chat) ?? "its parent"}` : chat.repo}
      words={words}
      hit={hit}
      ask={askFor(chat, phase)}
      age={rowAge(chat.updatedAt, inbox.now)}
      onPress={() => go(chat, hit)}
    />
  );

  const anyPlace = chiefHits.length + placeHits.length + deviceHits.length > 0;
  let placeIndex = 0;

  return (
    <Sheet open={open} onClose={leave} detent="large" title="Search" closeLabel="Close search">
      <View style={{ paddingHorizontal: 16 }}>
        <SearchField
          variant="capsule"
          value={query}
          onChangeText={setQuery}
          placeholder="Agents, workspaces, messages"
          accessibilityLabel="Search agents, workspaces and messages"
          autoFocus={open}
          // Return opens what's on top: the Chief, workspace or device whose name it is, else the first chat.
          onSubmitEditing={() => {
            if (chiefHits[0]) goChief(chiefHits[0].chief.id);
            else if (placeHits[0]) push("Workspace", { id: placeHits[0].name });
            else if (deviceHits[0]) push("Agents", { filter: "all", device: deviceHits[0].device.id });
            else if (hits[0]) go(hits[0].chat, hits[0]);
            else if (saidHits[0]) goChief(saidHits[0].chief.id, saidHits[0].line);
          }}
        />
      </View>
      <Scopes scope={scope} onScope={setScope} chiefs={CHIEFS} workspaces={places} />
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
        {typed ? (
          <>
            {chiefHits.map((card) => (
              <ChiefPlace key={card.chief.id} card={card} chief={card.chief} words={words} now={now} divided={placeIndex++ > 0} onPress={() => goChief(card.chief.id)} />
            ))}
            {placeHits.map((w) => (
              <WorkspacePlace key={w.name} w={w} words={words} divided={placeIndex++ > 0} onPress={() => push("Workspace", { id: w.name })} />
            ))}
            {deviceHits.map((d) => (
              <DevicePlace key={d.device.id} d={d} words={words} now={now} divided={placeIndex++ > 0} onPress={() => push("Agents", { filter: "all", device: d.device.id })} />
            ))}
            {hits.length ? (
              <>
                <Count n={hits.length} noun="chat" first={!anyPlace} />
                {hits.slice(0, SHOWN).map((h, i) => row(h.chat, h.phase, i, h))}
                {hits.length > SHOWN ? <More n={hits.length - SHOWN} /> : null}
              </>
            ) : null}
            {saidHits.length ? (
              <>
                <Count n={saidHits.length} noun="message from a Chief" plural="messages from Chiefs" first={!anyPlace && !hits.length} />
                {saidHits.map((h, i) => (
                  <SaidRow key={h.line.id} hit={h} age={rowAge(h.line.at, inbox.now)} divided={i > 0} onPress={() => goChief(h.chief.id, h.line)} />
                ))}
              </>
            ) : null}
            {!anyPlace && !hits.length && !saidHits.length ? (
              <View style={{ paddingTop: 40 }}>
                <PageEmpty title={`Nothing matches “${query.trim()}”`} line={scope.kind === "all" ? "Try fewer words, or one from the chat itself." : `Only ${scope.kind === "chief" ? `${CHIEFS.find((x) => x.id === scope.id)?.name ?? "this Chief"}'s chats are` : `${scope.name} is`} searched. Try All.`} />
              </View>
            ) : null}
          </>
        ) : (
          <>
            {waiting.length ? <SheetLabel first>Needs you</SheetLabel> : null}
            {waiting.map((r, i) => row(r.chat, r.phase, i))}
            {recent.length ? <SheetLabel first={!waiting.length}>Recent</SheetLabel> : null}
            {recent.map((r, i) => row(r.chat, r.phase, i))}
            {!waiting.length && !recent.length ? (
              <View style={{ paddingTop: 40 }}>
                <PageEmpty title="Nothing here yet" line="Chats show up here as soon as they start." />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

/** "4 chats", over the matches; room above it when places came first. */
function Count({ n, noun, plural = `${noun}s`, first }: { n: number; noun: string; plural?: string; first: boolean }) {
  const { t } = useTheme();
  return (
    <View style={{ height: 30, justifyContent: "center", marginHorizontal: 20, marginTop: first ? 0 : 16 }}>
      <Text accessibilityRole="header" style={t.meta}>
        {n} {n === 1 ? noun : plural}
      </Text>
    </View>
  );
}

/** Past the matches it draws: how many more, and the quicker way to them. */
function More({ n }: { n: number }) {
  const { t } = useTheme();
  return <Text style={[t.meta, { textAlign: "center", paddingVertical: 20 }]}>{n} more. Add a word, or pick a Chief or workspace above.</Text>;
}

// ---------------------------------------------------------------- scopes

/** A chip ticks as it's picked. */
const Chip = (props: Parameters<typeof ScopeChip>[0]) => (
  <ScopeChip
    {...props}
    onPress={() => {
      haptic.tick();
      props.onPress();
    }}
  />
);

function Scopes({ scope, onScope, chiefs, workspaces }: { scope: Scope; onScope: (s: Scope) => void; chiefs: readonly Chief[]; workspaces: readonly string[] }) {
  const { c } = useTheme();
  // A chip picked again lets go of it.
  const pick = (next: Scope) => onScope(sameScope(next, scope) ? ALL : next);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, flexShrink: 0, marginTop: 2, marginBottom: 2 }} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, gap: 8, alignItems: "center" }}>
      <Chip label="All" on={scope.kind === "all"} onPress={() => onScope(ALL)} />
      {chiefs.map((chief) => (
        <Chip key={chief.id} label={`${chief.name}'s chats`} on={scope.kind === "chief" && scope.id === chief.id} onPress={() => pick({ kind: "chief", id: chief.id })} round>
          <Sprite character={chief.character} tone={chief.tone} size={24} animate={false} />
        </Chip>
      ))}
      <View style={{ width: 1, height: 20, marginHorizontal: 2, backgroundColor: alpha(c.text, 0.12) }} />
      {workspaces.map((name) => (
        <Chip key={name} label={name} said={`Only ${name}`} on={scope.kind === "workspace" && scope.name === name} onPress={() => pick({ kind: "workspace", name })} />
      ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------- rows

/** The title's words, the query's words in it at 600 and full ink. */
function Marked({ text, words, style }: { text: string; words: readonly string[]; style: object }) {
  const { c } = useTheme();
  return (
    <Text numberOfLines={1} style={style}>
      {runs(text, words).map((r, i) =>
        r.hit ? (
          <Text key={i} style={{ fontWeight: "600", color: c.text }}>
            {r.text}
          </Text>
        ) : (
          r.text
        ),
      )}
    </Text>
  );
}

/** A match inside something said: the words before, the hit at full ink, the words after. */
function Snippet({ snippet }: { snippet: NonNullable<SearchHit["snippet"]> }) {
  const { c, t } = useTheme();
  return (
    <Text numberOfLines={1} style={[t.small, { fontSize: 14, lineHeight: 19, marginTop: 3 }]}>
      {snippet.before}
      <Text style={{ fontWeight: "600", color: c.text }}>{snippet.match}</Text>
      {snippet.after}
    </Text>
  );
}

/**
 * One chat: its state at the start, the title, the meta line in three parts at most (the state word, where it is,
 * its age; amber only for Needs you), and a snippet: the words around a match inside it, or, for an ask, the command
 * it waits on in mono.
 */
function Hit({ phase, title, place, words, hit, ask, age, divided, onPress }: { phase: Phase; title: string; place: string; words: readonly string[]; hit?: SearchHit; ask: Ask | null; age: string; divided: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const snippet = hit?.snippet;
  const said = [title, STATE_WORD[phase], place, age, snippet ? `${snippet.before}${snippet.match}${snippet.after}` : ask ? `${ask.question}${ask.by ? `, ${ask.by}` : ""}, ${ask.command}` : null].filter(Boolean).join(", ");
  return (
    <Row divided={divided} onPress={onPress} label={said} hint={hit?.itemId ? "Opens the chat on this message" : "Opens the chat"}>
      <View style={{ width: 20, height: 21, alignItems: "center", justifyContent: "center" }}>
        <StateDot phase={phase} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Marked text={title} words={hit?.field === "title" ? words : []} style={[t.row, { fontSize: 16, lineHeight: 21 }]} />
        <Text numberOfLines={1} style={[t.meta, { marginTop: 2 }]}>
          <StateWord phase={phase} />
          {` · ${place} · ${age}`}
        </Text>
        {snippet ? (
          <Snippet snippet={snippet} />
        ) : ask ? (
          <Text numberOfLines={1} style={[t.small, { fontSize: 14, lineHeight: 19, marginTop: 3 }]}>
            {ask.question}
            {ask.by ? <Text style={{ color: c.subtle }}> · {ask.by}</Text> : null}
          </Text>
        ) : null}
      </View>
    </Row>
  );
}

/** Something said in a Chief's chat: who said it, "In Oona's chat · 2m", and the words around the hit. */
function SaidRow({ hit, age, divided, onPress }: { hit: SaidHit; age: string; divided: boolean; onPress: () => void }) {
  const { t } = useTheme();
  const who = hit.line.who === "you" ? "You" : hit.chief.name;
  const where = `In ${hit.chief.name}'s chat`;
  const { before, match, after } = hit.snippet;
  return (
    <Row divided={divided} onPress={onPress} label={`${who}, ${where}, ${age}, ${before}${match}${after}`} hint="Opens the Chief on this message">
      <View style={{ width: 20, height: 21, alignItems: "center", justifyContent: "center" }}>
        <Sprite character={hit.chief.character} tone={hit.chief.tone} size={24} animate={false} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[t.row, { fontSize: 16, lineHeight: 21 }]}>
          {who}
        </Text>
        <Text numberOfLines={1} style={[t.meta, { marginTop: 2 }]}>
          {`${where} · ${age}`}
        </Text>
        <Snippet snippet={hit.snippet} />
      </View>
    </Row>
  );
}

/** A Chief whose name was typed: its character row, as Home draws it (portrait, name, live line, age). */
function ChiefPlace({ card, chief, words, now, divided, onPress }: { card: ChiefCard; chief: Chief; words: readonly string[]; now: number; divided: boolean; onPress: () => void }) {
  const { c, t } = useTheme();
  const [held, setHeld] = useState(false);
  const age = card.at ? rowAge(card.at, now) : null;
  const state = card.needs ? `${card.needs} ${card.needs === 1 ? "needs" : "need"} you` : card.ready ? `${card.ready} ready` : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[chief.name, state, card.line].filter(Boolean).join(", ")}
      accessibilityHint={`Opens ${chief.name}`}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onPress();
      }}
      style={[{ flexDirection: "row", alignItems: "center", gap: 12, height: layout.row.chief, paddingHorizontal: 20, backgroundColor: held ? alpha(c.text, 0.05) : undefined }, { outlineStyle: "none" } as object]}
    >
      {divided ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 20 + 48 + 12, right: 20, height: 1, backgroundColor: c.hairline }} /> : null}
      <Portrait character={chief.character} tone={chief.tone} size={48} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}>
          <Marked text={chief.name} words={words} style={[t.label, { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: weight.medium, letterSpacing: -0.2 }]} />
          {age ? <Text style={t.meta}>{age}</Text> : null}
        </View>
        <LiveLine text={card.line} live={card.live} style={[t.row, { fontSize: 15, lineHeight: 20, color: card.needs ? c.soft : c.muted }]} />
      </View>
    </Pressable>
  );
}

/** A workspace whose name was typed: the repo glyph, its name, and Home's line ("2 need you · 11 agents"). */
function WorkspacePlace({ w, words, divided, onPress }: { w: WorkspaceRow; words: readonly string[]; divided: boolean; onPress: () => void }) {
  const { t } = useTheme();
  const state = w.needs ? `${w.needs} ${w.needs === 1 ? "needs" : "need"} you` : w.ready ? `${w.ready} ready` : w.working ? `${w.working} working` : null;
  return (
    <Row divided={divided} onPress={onPress} label={[w.name, "workspace", state, `${w.total} ${w.total === 1 ? "agent" : "agents"}`].filter(Boolean).join(", ")} hint="Opens the workspace">
      <View style={{ width: 20, height: 21, alignItems: "center", justifyContent: "center" }}>
        <PixelIcon name="repo" size={20} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Marked text={w.name} words={words} style={[t.row, { fontSize: 16, lineHeight: 21 }]} />
        <WorkspaceLine w={w} />
      </View>
    </Row>
  );
}

/** A device whose name was typed: its computer glyph, its name, and Home's line ("Online · 4 running"). */
function DevicePlace({ d, words, now, divided, onPress }: { d: DeviceRow; words: readonly string[]; now: number; divided: boolean; onPress: () => void }) {
  const { t } = useTheme();
  const said = deviceWords(d, now);
  return (
    <Row divided={divided} onPress={onPress} label={[d.device.name, said.lead, ...said.rest, said.needs].filter(Boolean).join(", ")} hint="Opens its chats">
      <View style={{ width: 20, height: 21, alignItems: "center", justifyContent: "center" }}>
        <DeviceGlyph device={d.device} size={20} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Marked text={d.device.name} words={words} style={[t.row, { fontSize: 16, lineHeight: 21 }]} />
        <DeviceLine d={d} now={now} />
      </View>
    </Row>
  );
}

/** A result's row: 20pt in, the mark's 20pt slot, the words from 52, a hairline from there between rows. */
function Row({ divided, onPress, label, hint, children }: { divided: boolean; onPress: () => void; label: string; hint: string; children: ReactNode }) {
  const { c } = useTheme();
  const [held, setHeld] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPressIn={() => setHeld(true)}
      onPressOut={() => setHeld(false)}
      onPress={() => {
        haptic.tick();
        onPress();
      }}
      style={[{ flexDirection: "row", gap: 12, paddingHorizontal: 20, paddingTop: 13, paddingBottom: 14, backgroundColor: held ? alpha(c.text, 0.05) : undefined }, { outlineStyle: "none" } as object]}
    >
      {divided ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 52, right: 20, height: 1, backgroundColor: c.hairline }} /> : null}
      {children}
    </Pressable>
  );
}
