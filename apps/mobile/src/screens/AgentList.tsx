// A list of agents, pushed from a tile (Needs you, Working, Ready, All agents), a Chief's row, your own chats or a
// device: native list with Caveman's rows (shell/rows/ChatList.tsx). A large title says what it is and what narrows
// it; scrolled past, the bar's capsule takes the title. A list narrowed to one state names it once, in its title or
// its line, so its rows use line 2 for what is going on instead (ChatRow `named`). Needs you is a list of summary
// cards, the asks oldest first (src/asks/NeedsList.tsx): each says who asks, what it did so far and what it needs, and
// is answered in place, leaving at once with its Undo in the toast; Ready opens with the Review shelf; a device's list opens with the
// device and the way to bring it back. Subagents are never rows here: they are reached from their parent. Empty, a
// list's glyph is grey (no amber when nothing waits on you). The chat bar sits at the foot, as on Home.
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NeedsList } from "../asks/NeedsList";
import { chiefById, CHIEFS, deviceById } from "../board/model";
import { useContentEnd } from "../components/ProgressiveEdge";
import { Sprite } from "../components/Sprite";
import { Portrait } from "../home/Portrait";
import { openRow } from "../nav/ref";
import type { ScreenProps } from "../nav/routes";
import { COMPOSER_ROOM } from "../shell/Composer";
import { useInbox } from "../shell/inbox";
import { NewChatComposer } from "../shell/NewChatComposer";
import { ChatList } from "../shell/rows/ChatList";
import { DeviceHead, ListTitle, ReviewShelf } from "../shell/rows/ListTop";
import { GlassButton, TopBar } from "../shell/TopBar";
import { openSearch } from "../shell/ui";
import { type ListFilter, readyOf, useList } from "../store/select";
import { useStore } from "../store/store";

const TITLE: Record<ListFilter, string> = { needs: "Needs you", working: "Working", ready: "Ready", done: "Done", all: "All agents" };
const EMPTY: Record<ListFilter, string> = { needs: "Nothing waits on you", working: "Nothing is at work", ready: "Nothing new to try", done: "Nothing is done yet", all: "No agents yet" };
const EMPTY_LINE: Record<ListFilter, string> = {
  needs: "When an agent asks to run something or has a question, it shows here.",
  working: "What you start from the chat bar runs here.",
  ready: "Finished work you haven't looked at lands here.",
  done: "Chats you settle or merge rest here.",
  all: "Start one from the chat bar below.",
};
/** Your own chats, the ones no Chief runs (Home's "Your chats" row). */
const YOURS = "you";

export function AgentList({ route, navigation }: ScreenProps<"Agents">) {
  const q = route.params;
  const insets = useSafeAreaInsets();
  const yours = q.chief === YOURS;
  const listed = useList(yours ? { ...q, chief: undefined } : q);
  const rows = useMemo(() => (yours ? listed.filter((r) => r.chief === null || !CHIEFS.some((c) => c.id === r.chief)) : listed), [listed, yours]);
  const chats = useMemo(() => rows.map((r) => r.chat), [rows]);
  const inbox = useInbox(chats, null);
  const [past, setPast] = useState(false);
  // How far the list has scrolled (the bar's edge comes in once something is under it) and where its last row is (the
  // chat bar's band shows only while rows run under it). The last row rests 24 over the bar at the end.
  const bottom = Math.max(insets.bottom, 10) + COMPOSER_ROOM;
  const foot = useContentEnd(bottom);
  const edgeY = foot.scrollY;

  const chief = q.chief && !yours ? chiefById(q.chief) : null;
  const device = q.device ? deviceById(q.device) : null;
  // A Chief's or a device's list is titled by it; a tile's by its state.
  const title = yours ? "Your chats" : chief ? chief.name : device ? device.name : TITLE[q.filter];
  const narrowed = chief || device || yours ? (q.filter === "all" ? null : TITLE[q.filter]) : null;
  // Empty, the list says so in its own words below; "0 agents" over that would say it twice.
  // Ready counts what you haven't looked at, as every "ready" does; the seen ones still wait, folded under Seen.
  const seen = useStore((s) => s.inbox);
  const ready = q.filter === "ready" ? readyOf(rows, seen) : null;
  const count = ready && ready.seen ? `${ready.unseen} new · ${ready.seen} seen` : rows.length ? `${rows.length} ${rows.length === 1 ? "agent" : "agents"}` : null;
  const line = [narrowed, q.workspace, count, q.filter === "needs" && rows.length > 1 ? "oldest first" : null].filter(Boolean).join(" · ");
  const mark = chief ? <Portrait character={chief.character} tone={chief.tone} size={32} crop="head" /> : undefined;

  const needs = q.filter === "needs";
  return (
    <View style={{ flex: 1 }}>
      {needs ? (
        <NeedsList
          rows={rows}
          top={
            <>
              <ListTitle title={title} line={line} mark={mark} />
              {device ? <DeviceHead device={device} /> : null}
            </>
          }
          // A Chief's own list is all that Chief's: its face on every card would say nothing.
          showChief={!chief}
          // The whole list holds the pull requests too; one narrowed to a Chief, a project or a computer is its asks alone.
          pulls={!q.chief && !q.workspace && !q.device}
          empty={EMPTY.needs}
          emptyLine={EMPTY_LINE.needs}
          bottom={bottom}
          onOpen={openRow}
          onScrolled={setPast}
          scrollY={edgeY}
          onEnd={foot.onEnd}
        />
      ) : (
      <ChatList
        id={`agents:${q.filter}:${q.chief ?? ""}:${q.workspace ?? ""}:${q.device ?? ""}`}
        rows={rows}
        inbox={inbox}
        named={q.filter !== "all"}
        place={!q.workspace}
        device={q.device}
        top={(slot) => (
          <>
            <ListTitle title={title} line={line} mark={mark} action={slot} />
            {device ? <DeviceHead device={device} /> : null}
            {q.filter === "ready" && !device ? <ReviewShelf chats={chats} onOpen={() => navigation.push("Review")} /> : null}
          </>
        )}
        empty={EMPTY[q.filter]}
        emptyLine={EMPTY_LINE[q.filter]}
        emptyIcon={q.filter === "ready" ? "state-done" : q.filter === "working" ? "state-working" : "inbox"}
        bottom={bottom}
        onEnd={foot.onEnd}
        onOpen={openRow}
        onScrolled={setPast}
        scrollY={edgeY}
      />
      )}
      <TopBar
        onBack={() => navigation.goBack()}
        scrollY={edgeY}
        title={past ? title : undefined}
        subtitle={past ? line : undefined}
        mark={past && chief ? <Sprite character={chief.character} tone={chief.tone} size={24} animate={false} /> : undefined}
        right={<GlassButton icon="search" label="Search" onPress={openSearch} />}
      />
      <NewChatComposer placeholder="What should we build?" contentEnd={foot.end} />
    </View>
  );
}
