// A chat on the stack (DECISIONS.md "Thread, exactly"): its feed (Thread.tsx), the bar over it, and at its foot the box
// with the floating row riding on it, or, while the chat waits on you, the approval docked in the box's place.
//
// The bar: back (an amber dot when something elsewhere needs you), the two-line glass capsule (who runs it, the title,
// "workspace · device") that opens Details, and ··· with native menu. As the main panel's root (the sidebar or a jump
// opened it), the sidebar's button takes Back's place and a compose circle at the right starts a new chat, as Claude's
// phone app has it; the capsule then opens the menu, Details first in it. A subagent's bar is hard-edged with its title
// plain, its task captioned "From Parent ›", and the sibling strip leads its floating row (up to the parent, across to
// its siblings, each replacing this screen); while an ask is docked the strip steps away and the dock's own grey line
// ("Audit the phone app › the composer") goes up instead. Back returns to the parent where you left it, since the
// parent stays mounted under it on the stack.
//
// A turn is over when its answer has arrived on screen, not when the engine says so (thread/settle.ts): until then the
// capsule keeps its clock and the box still says "Steer the work…". Answering an ask while others wait anywhere puts
// the next one in the floating row for a few seconds, so a backlog is one tap per ask.
//
// Everything about this chat is decided here: sending (a follow-up, or a steer while it works), stopping, Allow and
// Deny (a yes behind Undo), "Tell it what to do instead", the queue, Rename in the capsule's place, Pin, Copy, Share,
// Mark unread and Archive with Undo. Nothing of another chat's floats over this one's foot: its news is the toast in
// the bar's slot, and a review opened from here rises from where this screen says the box stands.
import { useIsFocused } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Share, Text, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Chat, deviceById } from "../board/model";
import { askQuestion, askWords } from "../home/model";
import { act } from "../asks/decide";
import * as script from "../board/script";
import { BottomEdge, EDGE } from "../components/ProgressiveEdge";
import { shortTitle } from "../components/transcript/Parts";
import { Button } from "../components/ui/Button";
import { VendorMark } from "../components/ui/EngineLogo";
import type { MenuEntry } from "../components/ui/Menu";
import { openChat, showNewChat } from "../nav/ref";
import { type ScreenProps, useIsRoot } from "../nav/routes";
import { Composer, COMPOSER_HEIGHT, type Mode } from "../shell/Composer";
import { useInbox } from "../shell/inbox";
import { triggerOf, useChatPick, useListed } from "../shell/Sheets";
import { Details } from "../shell/DetailsSheet";
import { InspectorFill, useShell } from "../shell/layout";
import { BarGroup, GlassButton, TopBar } from "../shell/TopBar";
import { archive, openDetails, openModel, review, setFloating, useBoxAsked } from "../shell/ui";
import { shallow } from "../store/core";
import { askQueue, chatOf, childrenOf, useChat, useParent, useRows } from "../store/select";
import { getDraft, setDraft, unqueue, useQueue } from "../store/sessions";
import { store, useStore } from "../store/store";
import { AgentsSheet } from "../thread/AgentsSheet";
import { AskDock } from "../thread/AskDock";
import { canTryAgain, discardStart, useNote, useRunChoices } from "../live/link";
import { didNotStart } from "../live/start";
import { FloatingRow, kidsOf, type NextAsk, rowShows } from "../thread/FloatingRow";
import { ScreenGlyph, ScreenSheet, screenMenu, withScreens } from "../thread/Screens";
import type { Screen } from "../live/protocol";
import { screensOf } from "../live/scripted";
import { turnsOf } from "../thread/fold";
import { useSettling } from "../thread/settle";
import { layout, mono, useTheme } from "../theme";
import { PixelIcon } from "../components/Pixel";
import { Thread, type ThreadHandle } from "./Thread";

const NO_CHATS: readonly Chat[] = [];

/** "The composer" as it reads after "Audit the phone app ›". */
const lowerFirst = (words: string) => (/^[A-Z][a-z]/.test(words) ? words.charAt(0).toLowerCase() + words.slice(1) : words);

/** The asks a chat waits on, oldest first. */
const asksOf = (chat: Chat) => chat.items.filter((i): i is Extract<Chat["items"][number], { kind: "ask" }> => i.kind === "ask" && !i.answer && !i.pending).map((i) => i.command);

/** A touch this soon after Next appears is the thumb that answered, still in flight: it neither opens nor clears it. */
const NEXT_ARM_MS = 450;

/**
 * When the running turn began: the floating capsule's clock. Time it spent waiting on you isn't work, so a turn that
 * went on after an approval counts from when it went on. `settling`: its answer is still arriving, so it still runs.
 */
function sinceOf(chat: Chat, settling = false): number | null {
  if (chat.phase !== "working" && !settling) return null;
  const turn = turnsOf(chat.items).at(-1);
  const resumed = turn?.items.some((i) => i.kind === "ask" && i.answer) ? turn.items.findLast((i) => i.kind === "work" && !i.endedAt) : undefined;
  if (resumed?.kind === "work") return resumed.startedAt;
  return turn?.you?.at ?? chat.startedAt;
}

export function ThreadScreen({ route, navigation }: ScreenProps<"Thread">) {
  const { id } = route.params;
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  const focused = useIsFocused();
  const root = useIsRoot();
  const chat = useChat(id);
  const parent = useParent(id);
  const kids = useStore((s) => childrenOf(s, id), shallow);
  // A subagent's siblings (itself among them), for the strip that leads its floating row.
  const siblings = useStore((s) => (parent ? childrenOf(s, parent.id) : NO_CHATS), shallow);
  const settling = useSettling(chat);
  const archived = useStore((s) => !!s.inbox.archived[id]);
  // The open chat is read while it shows (shell/inbox.ts).
  const seen = useMemo(() => (chat ? [chat] : []), [chat]);
  const inbox = useInbox(seen, focused ? id : null);
  // On the person's own board the chip names the model as the chat's place lists it.
  const listed = useListed(id);
  const pick = useChatPick(chat, listed.engines);
  // What waits on you in other chats (this one's family left out): the dot on Back.
  const waiting = useStore((s) => askQueue(s).filter((a) => a.row.chat.id !== id && a.row.chat.id !== chatOf(s, id)?.parent).length);
  const rows = useRows();
  const feed = useRef<ThreadHandle>(null);
  const [renaming, setRenaming] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agentsFilter, setAgentsFilter] = useState<"needs" | null>(null);
  // The agent's browser or computer, open in its sheet over the chat.
  const [watching, setWatching] = useState<Screen | null>(null);
  const [next, setNext] = useState<NextAsk | null>(null);
  // When Next came up: it stays until your next move here (a scroll, a word, a tap), past its first moments.
  const nextAt = useRef(0);
  const dropNext = useCallback(() => {
    if (Date.now() - nextAt.current < NEXT_ARM_MS) return;
    setNext((was) => (was ? null : was));
  }, []);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [fresh, setFresh] = useState(false);
  // "Tell it what to do instead": the box comes back over the ask, and what's sent from it steers.
  const [instead, setInstead] = useState(false);
  const [focusAsk, setFocusAsk] = useState(0);
  const typed = useRef(false);
  // Share to Caveman put what came in this box while the chat waits on you (ui.ts focusBoxOf): the dock steps aside
  // until it is sent or the box is emptied, and sending it is a message, never the ask's answer.
  const [held, setHeld] = useState(false);
  const shareHere = useBoxAsked(id);
  useEffect(() => {
    if (shareHere) setHeld(true);
  }, [shareHere]);
  // How tall what stands over the foot at rest is: the resting box with its row (Composer's `onHeight`), or the dock and
  // its row. The box opening, rising and growing as you write isn't in it: the chat rides those with the box (Thread.tsx).
  const [boxHeight, setBoxHeight] = useState(COMPOSER_HEIGHT);
  // Where the band behind the resting box begins, over the screen's foot (Composer's `onEdge`).
  const [band, setBand] = useState<number | null>(null);
  // How far the feed has scrolled: the bar's edge comes in once something is under it.
  const edgeY = useSharedValue(0);
  const [dockHeight, setDockHeight] = useState(0);
  const [voicing, setVoicing] = useState(false);
  const [writing, setWriting] = useState(false);
  const { queued } = useQueue(id);
  // A real computer's chat: the one line about where it runs, unless its own message already says what it waits
  // for; and its two verbs, Run in Cloud and Run on a Mac of yours, for the menu.
  const waits = chat?.wait !== undefined;
  const note = useNote(id, waits);
  const runs = useRunChoices(id);

  // An archived chat (or one the board let go) leaves the screen it was on.
  useEffect(() => {
    if (!focused || (chat && !archived)) return;
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.replace("Home");
  }, [focused, chat, archived, navigation]);

  const asks = chat ? asksOf(chat) : [];
  const docked = asks.length > 0 && !instead && !held;
  // The floating row's room is kept whether or not anything in it shows, so the end never moves as it comes and goes.
  const rowOn = !!chat;
  // Once its ask is answered, the box is just the box again; and if others wait anywhere, the next one is offered.
  const asked = useRef(asks.length);
  useEffect(() => {
    if (!asks.length) setInstead(false);
    const answered = asked.current > 0 && asks.length === 0;
    asked.current = asks.length;
    // Only an answer given here: one given while another screen covers this one (a Chief's dock, the toast's Undo)
    // was answered there, and that screen offers the next.
    if (!answered || !focused) return;
    const family = new Set([id, chat?.parent ?? "", ...kids.map((k) => k.id)]);
    // The one order every list of asks uses: the longest-waiting first (store/select.ts askQueue).
    const waiting = askQueue(store.get()).filter((a) => !family.has(a.row.chat.id) && !family.has(a.asker.id) && a.asker.phase === "needs");
    const first = waiting[0];
    if (!first) return;
    nextAt.current = Date.now();
    setNext({ id: first.asker.id, question: askQuestion(first.asker), index: 1, total: waiting.length });
  }, [asks.length]);
  // Leaving the chat takes Next with it, and puts its screen away.
  useEffect(() => {
    if (focused) return;
    setNext(null);
    setWatching(null);
  }, [focused]);

  // What stands over the foot: the box, or the dock.
  const foot = Math.max(insets.bottom, 0);
  // The dock stands 8 over the foot, with the floating row 10 over it when there is one.
  const standing = docked ? 8 + dockHeight + (rowOn ? layout.float + layout.rowAbove : 0) : boxHeight;
  const rest = foot + standing + 12;
  // Where a review opened from this chat rises from (shell/Overlays.tsx), and whether the box is busy.
  const busy = voicing || writing || agentsOpen || watching !== null;
  useEffect(() => {
    setFloating(route.key, focused ? { rest, except: id, busy } : null);
  }, [route.key, focused, rest, id, busy]);
  useEffect(() => () => setFloating(route.key, null), [route.key]);

  const chats = useMemo(() => rows.map((r) => ({ id: r.chat.id, title: inbox.title(r.chat), engine: r.chat.engine, repo: r.chat.repo })), [rows, inbox.title]);
  const resolve = useCallback((ref: string) => {
    const named = rows.find((r) => r.chat.id === ref)?.chat ?? kids.find((k) => k.id === ref);
    return named ? { title: inbox.title(named), engine: named.engine } : null;
  }, [rows, kids, inbox.title]);

  // Its subagents open through the stack's one rule (nav/moves.ts), as every chat does: a second tap in the same frame
  // finds the first one's screen on top already and does nothing.
  const openChild = useCallback((child: string) => openChat(child), []);
  // Came here from the parent: back to it, where you left it. Came some other way (search, a push): it takes this
  // screen's place, so Back still goes where you came from.
  const parentId = parent?.id;
  const toParent = useCallback(() => {
    if (parentId) openChat(parentId, { inPlace: true });
  }, [parentId]);
  // "From Audit the phone app ›" over its first message goes up as the strip's arrow does, never the parent pushed
  // again over its own subagent.
  const onOpenChat = useCallback((ref: string) => (ref === parentId ? toParent() : openChat(ref)), [parentId, toParent]);
  const onReview = useCallback(() => review(id), [id]);
  const onRetry = useCallback((text: string) => {
    script.send(id, text, "followup");
    setTimeout(() => feed.current?.scrollToEnd(), 60);
  }, [id]);
  const onScrolledUp = useCallback(
    (up: boolean) => {
      setScrolledUp(up);
      if (up) dropNext();
    },
    [dropNext],
  );
  const onFresh = useCallback((next: boolean) => setFresh(next), []);

  const openSibling = useCallback((child: string) => openChat(child, { inPlace: true }), []);
  const shell = useShell();
  // One element per chat, so streaming words into the transcript doesn't redraw the inspector beside it.
  const inspectorBody = useMemo(() => (chat ? <DetailsFor id={chat.id} /> : null), [chat?.id]);

  if (!chat || !pick) return <View style={{ flex: 1 }} />;
  const shown = triggerOf(pick, listed.engines);
  const title = inbox.title(chat);
  const device = deviceById(chat.device);
  const where = `${chat.repo} · ${device.name}`;
  const answer = chat.items.findLast((i): i is Extract<Chat["items"][number], { kind: "text" }> => i.kind === "text")?.text ?? "";
  const plainAnswer = answer.replace(/\*\*|`|\[\[|\]\]/g, "");
  const link = `caveman://chat/${chat.id}`;
  // Its details: beside the chat where the sidebar stands beside the panel (the inspector), else the sheet.
  const details = () => (shell.split ? shell.setInspector(true) : openDetails(chat.id));
  const toggleDetails = () => shell.setInspector(!shell.inspector);

 // The ··· menu, native (5352): details, rename, mark unread; pin, copy, share; how the answer was; archive.
  const menu: MenuEntry[] = [
    { label: "View details", icon: "info", onPress: details },
    // Where it runs, the other way: a row that cannot work says why beside it and takes no press.
    ...runs.map((choice): MenuEntry => ({ label: choice.label, icon: choice.label === "Run in Cloud" ? <PixelIcon name="computer-cloud" /> : <PixelIcon name="computer-this-mac" />, ...(choice.why ? { description: choice.why, under: true, disabled: true } : { onPress: choice.run }) })),
    // After the menu has closed, so its handing focus back isn't taken for the field's blur.
    { label: "Rename", icon: "rename", onPress: () => setTimeout(() => setRenaming(true), 200) },
    { label: "Mark unread", icon: "markUnread", onPress: () => inbox.markUnread(chat.id) },
    { type: "separator" },
    { label: chat.pinned ? "Unpin" : "Pin", icon: chat.pinned ? "unpin" : "pin", onPress: () => script.pin(chat.id, !chat.pinned) },
    {
      label: "Copy",
      icon: "copy",
      submenu: [
        { label: "The last answer", icon: "copy", disabled: !plainAnswer, onPress: () => void Clipboard.setStringAsync(plainAnswer) },
        { label: "Link to the chat", icon: "link", onPress: () => void Clipboard.setStringAsync(link) },
        { label: "Title", icon: "rename", onPress: () => void Clipboard.setStringAsync(title) },
      ],
    },
    { label: "Share", icon: "share", onPress: () => void Share.share({ message: `${title} · ${chat.repo}\n${link}` }).catch(() => {}) },
    { type: "separator" },
    { label: "Good answer", icon: "thumbsUp", onPress: () => script.notify("Thanks. It's noted with the chat") },
    { label: "Bad answer", icon: "thumbsDown", onPress: () => script.notify("Noted. Tell it what to change in the box") },
    { type: "separator" },
    { label: "Archive", icon: "archive", disabled: chat.phase === "working", onPress: () => archive(chat.id) },
  ];

  // Nothing works while the chat only waits (its place waking, its Mac asleep, still being started): no clock, no
  // Stop, and the box is the plain one.
  const since = waits ? null : sinceOf(chat, settling);
  const kidState = kidsOf(kids);
  const running = (chat.phase === "working" || settling) && !waits;
  // A chat that did not start has nothing to follow up on: its message says "Not sent", the line under it says why,
  // and Try again and Discard stand where the box would.
  const unstarted = didNotStart(chat);
  const rowProps = {
    since,
    kids: kidState,
    // While an ask is docked the strip steps away, as the capsule's needs-you does: the dock says who asks, and
    // its line goes up to the parent. It comes back once the ask is answered and its Undo has gone.
    family: parent && !docked ? { parent, siblings, current: chat.id } : null,
    next,
    away: note && !note.block ? { note, onWhy: details } : null,
    scrolledUp,
    // A dot on the jump circle: something new under you, amber when it is an ask.
    dot: scrolledUp ? (asks.length ? ("needs" as const) : fresh ? ("new" as const) : null) : null,
    // The agent's browser and computer, as pills after the status: the one it is using first.
    screens: screensOf(chat).map((s) => ({ ...s, glyph: <ScreenGlyph chat={chat} screen={s.screen} ink={c.muted} /> })),
    onScreen: setWatching,
    queued,
    onAgents: (filter: "needs" | null) => {
      setAgentsFilter(filter);
      setAgentsOpen(true);
    },
    onChild: openChild,
    onParent: toParent,
    onSibling: openSibling,
    // The next ask takes this screen's place, its approval docked; Back still goes where it went.
    onNext: (next: string) => {
      setNext(null);
      openChat(next, { inPlace: true });
    },
    onJump: () => {
      setFresh(false);
      feed.current?.scrollToEnd();
    },
    onEditQueued: (q: { id: string; text: string }) => {
      unqueue(chat.id, q.id);
      const now = getDraft(chat.id).trim();
      setDraft(chat.id, now ? `${now} ${q.text}` : q.text);
    },
    onRemoveQueued: (q: { id: string }) => unqueue(chat.id, q.id),
  };
  const row = <FloatingRow {...rowProps} tray={!docked} />;
  // What scrolls under the foot can't be read beside or between its glass: the box draws the one band behind itself and
  // what rides on it (components/ProgressiveEdge.tsx); the dock, which takes the box's place, gets the same band here.
  const dockFloor = foot + 8 + dockHeight;
  const dockTop = dockFloor + (rowShows(rowProps) ? layout.float + layout.rowAbove : 0);
  // The chat's last line stands 8 over where that band begins, measured from the highest piece at the foot at rest (the
  // box, the queued tray, the floating row, the dock), so the live row is never under it: 8 from its 32pt row, whose
  // words keep 6 more inside it. It holds still while you write: the box tells only where it rests, and the chat rides
  // up with it from there, never dropping under the band as the row steps away for the card (place.ts liftOf).
  const bottom = (docked ? dockTop + EDGE.over : (band ?? foot + standing + EDGE.over)) + 8 + 6;

  return (
    // A tap anywhere in the chat is a move of yours: Next, offered after an answer, gives way to it (a beat later, so
    // a tap on Next itself opens it first).
    <View style={{ flex: 1 }} {...(next ? { onTouchEnd: () => setTimeout(dropNext, 0), onPointerUp: () => setTimeout(dropNext, 0) } : null)}>
      <Thread
        ref={feed}
        chat={chat}
        parent={parent}
        kids={kids}
        bottom={bottom}
        settling={settling}
        ask={chat.phase === "needs" ? askWords(chat) : null}
        onScrolledUp={onScrolledUp}
        edgeY={edgeY}
        onFresh={onFresh}
        onOpenChat={onOpenChat}
        onReview={onReview}
        onRetry={onRetry}
        // A chat that did not start is tried again at its foot, never from its message.
        onResend={unstarted ? undefined : (item) => script.resend(chat.id, item)}
        resolve={resolve}
      />
      {note?.block ? <AllowNotice words={note.words} code={note.code} /> : null}
      <TopBar
        root={root}
        onBack={() => navigation.goBack()}
        waiting={waiting}
        title={title}
        subtitle={parent ? undefined : where}
        // Who runs it, before the title: its model's vendor mark (the Caveman engine's own models wear its bust).
        mark={<VendorMark engine={shown.engine} model={shown.model} size={18} />}
        onTitle={shell.split ? toggleDetails : root ? undefined : () => openDetails(chat.id)}
        // Held: the chat's own menu, with the agent's browser and computer added over it, one tap from watching either.
        hold={{ label: "Show the chat's menu with the agent's browser and computer", ...withScreens(screenMenu(chat, setWatching), menu) }}
        right={
          shell.split ? (
            <BarGroup>
              <GlassButton icon={shell.inspector ? "panelClose" : "panel"} label={shell.inspector ? "Close details" : "Details"} selected={shell.inspector} onPress={toggleDetails} />
              {/* The sidebar's own Chat is beside it; in the rail there's room for both. */}
              {root && (shell.rail || !shell.sidebar) ? <GlassButton icon="compose" label="New chat" onPress={showNewChat} /> : null}
            </BarGroup>
          ) : root ? (
            <GlassButton icon="compose" label="New chat" onPress={showNewChat} />
          ) : undefined
        }
        edge={parent ? "hard" : "fade"}
        scrollY={edgeY}
        menu={{ entries: menu }}
        editing={renaming}
        onRename={(next) => {
          setRenaming(false);
          if (next) inbox.rename(chat.id, next);
        }}
      />
      {shell.split ? (
        <InspectorFill title="Details" active={focused}>
          {inspectorBody}
        </InspectorFill>
      ) : null}
      {docked ? <BottomEdge floor={dockFloor} top={dockTop} /> : null}
      {docked ? (
        <>
          {row ? <View pointerEvents="box-none" style={{ position: "absolute", left: layout.inset, right: layout.inset, bottom: foot + 8 + dockHeight + layout.rowAbove }}>{row}</View> : null}
          <AskDock
            asks={asks}
            question={chat.phase === "needs" ? askQuestion(chat) : undefined}
            source={parent ? { engine: chat.engine, words: `${parent.title} › ${lowerFirst(shortTitle(chat.title))}`, onOpen: toParent } : null}
            bottom={foot + 8}
            onHeight={setDockHeight}
            onDecide={(yes) => {
              if (yes) script.allow(chat.id);
              else script.deny(chat.id);
            }}
            onInstead={() => {
              typed.current = false;
              setInstead(true);
              setFocusAsk((n) => n + 1);
            }}
          />
        </>
      ) : unstarted ? (
        <StartFoot
          bottom={foot + 8}
          // Offered only where a second try can work (live/link.ts canTryAgain).
          onAgain={canTryAgain(chat.id) ? () => script.resend(chat.id, `${chat.id}:first`) : undefined}
          onDiscard={() => discardStart(chat.id)}
        />
      ) : (
        <Composer
          draft={chat.id}
          placeholder="Follow up…"
          speech={chat.phase === "ready" ? "Looks great, ship it" : chat.phase === "done" ? "Pick this back up and add a test for it" : "Also cover the timeout case while you're in there"}
          onSend={(text, images) => {
            // From "Tell it what to do instead" (or "something else"): what you said is the answer, as a card's own field
            // gives it (an approval turned down with it, a question answered with it), its Undo in the toast.
            if (instead && asks.length) {
              if (!act(chat.id, { kind: "deny", instead: text })) script.deny(chat.id, text);
              setInstead(false);
            } else script.send(chat.id, text, undefined, images);
            setHeld(false);
            // A goal is set by what's sent; grill mode holds until it's left, as on the desktop.
            setMode((m) => (m?.icon === "goal" ? null : m));
            setFresh(false);
            setTimeout(() => feed.current?.scrollToEnd(), 60);
          }}
          mode={mode}
          onClearMode={() => setMode(null)}
          onMode={setMode}
          chats={chats}
          self={chat.id}
          model={{ ...shown, onPress: () => openModel(chat.id) }}
          // While a turn runs, words steer it, a hold queues them for after, and the empty box's round button stops it.
          running={running}
          onStop={() => script.stop(chat.id)}
          above={row}
          onVoice={(v) => setVoicing(v.mode !== "off")}
          onTyping={(on) => {
            setWriting(on);
            if (on) dropNext();
            // Left "instead" without saying anything: the ask docks again.
            if (on) typed.current = true;
            else if (instead && typed.current && !getDraft(chat.id).trim()) setInstead(false);
            // A share emptied out of the box: the ask docks again.
            if (!on && held && !getDraft(chat.id).trim()) setHeld(false);
          }}
          onHeight={setBoxHeight}
          onEdge={setBand}
          focusAsk={instead ? focusAsk : 0}
        />
      )}
      <AgentsSheet open={agentsOpen} onClose={() => setAgentsOpen(false)} kids={kids} onOpen={openChild} filter={agentsFilter} />
      <ScreenSheet chat={chat} screen={watching} onClose={() => setWatching(null)} />
    </View>
  );
}

/**
 * What must happen on the person's Mac before this chat can be read here, in the chat's own place: the one sentence,
 * and under it the code to check on the Mac's dialog. It is asked once per Mac.
 */
function AllowNotice({ words, code }: { words: string; code?: string | undefined }) {
  const { c, t } = useTheme();
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }}>
      <View accessible accessibilityLiveRegion="polite" accessibilityLabel={code ? `${words} ${code.split("").join(" ")}` : words} style={{ alignItems: "center", gap: 12, backgroundColor: c.panel, borderRadius: 20, paddingHorizontal: 20, paddingVertical: 18 }}>
        <Text style={[t.body, { textAlign: "center", color: c.text }]}>{words}</Text>
        {code ? (
          <Text selectable style={[t.code, { fontFamily: mono, fontSize: 20, lineHeight: 26, letterSpacing: 1, color: c.text }]}>
            {code}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The box's place under a chat that did not start, as the web has it: Try again (the same chat, started again where
 * it stands) and Discard (its words go back to the New chat box). Try again is left out where it cannot work.
 */
function StartFoot({ bottom, onAgain, onDiscard }: { bottom: number; onAgain?: (() => void) | undefined; onDiscard: () => void }) {
  return (
    <View style={{ position: "absolute", left: layout.inset, right: layout.inset, bottom, height: 56, flexDirection: "row", alignItems: "center", gap: 8 }}>
      {onAgain ? (
        <View style={{ flex: 1 }}>
          <Button label="Try again" variant="primary" stretch onPress={onAgain} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Button label="Discard" stretch onPress={onDiscard} accessibilityLabel="Discard. Your message goes back to the New chat box" />
      </View>
    </View>
  );
}

/** A chat's details, read from the store by its id, for the inspector beside it. */
function DetailsFor({ id }: { id: string }) {
  const chat = useChat(id);
  return chat ? <Details chat={chat} /> : null;
}
