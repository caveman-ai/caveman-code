// A pull request's guide, pushed over the stack (the desktop's PrPage, apps/web/src/routes/review/PrPage.tsx, read on
// a phone): long-form reading, so a screen of its own rather than a sheet, and the same screen from every way in (a
// chat's Changes pill, a Chief's Ready card, Review's rows, the Ready list's shelf).
//
// Top to bottom: the title block (where it lives and its number, the title, branch into base, how its checks stand,
// its size and age, and who made it: the agent and its Chief, or the teammate who asks you); Guide | Files; then the
// guide (review/Tour.tsx) or every hunk in the guide's order (review/Files.tsx). The bar takes the title once the block
// scrolls under it, and while you read the chapters its capsule says where you are ("3 of 6 · Quiet hours hold all but
// approvals") and opens the contents: where you are lives in the bar, so only the decision floats over the code. Its
// ··· holds Wrap lines, the other tab, the contents and the chat. The decision waits at the foot (review/Foot.tsx).
//
// Moving around keeps your place: each tab remembers where you were in it; "L39 ›" opens Files on line 39 itself (the
// file unfolded, the line lit) and a capsule takes you back to the chapter you came from; "1 open thread" goes to the
// thread's own card. Asking never leaves the guide (review/ask.ts): the answer comes back in the sheet you asked from
// and stays under its chapter. Marks (read chapters, viewed parts) are kept per head, on disk.
import { useIsFocused } from "@react-navigation/native";
import { openChat as openChatScreen } from "../nav/ref";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance, Text, View } from "react-native";
import Animated, { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Chat, chiefById, ENGINE_NAME } from "../board/model";
import * as script from "../board/script";
import { Icon, type IconName } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { BottomEdge } from "../components/ProgressiveEdge";
import { Sprite } from "../components/Sprite";
import { Squish } from "../components/Squish";
import { PageEmpty } from "../components/ui/Empty";
import { EngineLogo } from "../components/ui/EngineLogo";
import { Frost } from "../components/ui/Floating";
import type { MenuEntry } from "../components/ui/Menu";
import { Segmented } from "../components/ui/Segmented";
import { enter, exit, haptic, useReducedMotion } from "../motion";
import type { ScreenProps } from "../nav/routes";
import { Page } from "../screens/Page";
import { age, Avatar, Overlay, useNow } from "../screens/pages/parts";
import { ME, type Pr, prKey, queueOf, repoName, reviews as sentReviews, type Sent, sendReview, settled, settlePr } from "../screens/pages/review-model";
import { useDefaultPick } from "../shell/Sheets";
import { useInbox } from "../shell/inbox";
import { BAR_HEIGHT, TopBar } from "../shell/TopBar";
import { startChat } from "../shell/ui";
import { useRows } from "../store/select";
import { alpha, FLOAT_TYPE, layout, mono, useTheme } from "../theme";
import { askAgent } from "./ask";
import { CodeContext, type CodeSettings, type Focus, isResolved, type LineAt, type Threads } from "./Code";
import { hunksOf } from "./diff";
import { FilesView, type Part, partsOf, sectionsOf } from "./Files";
import { AnswerSheet, askerOf, type Compose, ComposeSheet, Foot, LineSheet, MergeSheet, type Unread } from "./Foot";
import { PUSH_BACK } from "./guides";
import { findPr, useReview } from "./lookup";
import { agentTask, CALL_WORD, DEFAULT_SHORT_LINES, guideLines, isShortChange, isSkimStop, pad, type Passage, type PrGuideAttention, type PrGuideStop, sizeLabel, steerText } from "./model";
import { CallWord } from "./parts";
import { marksKey, reply, resolve, setRead, setViewed, startThread, useAsked, useRead, useReplies, useResolved, useStarted, useViewed } from "./state";
import { GuideBody, Tldr, verbsFor, whereOf } from "./Tour";
import { writeGuide } from "./write";
import { usePane } from "../shell/layout";

type Tab = "guide" | "files";

const STATE_ICON: Record<Pr["state"], IconName> = { open: "pullRequest", draft: "pullRequestDraft", merged: "merge", closed: "pullRequestClosed" };
const STATE_WORD: Record<Pr["state"], string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

/** What pushing back on a call most likely says, when the writer left no words of its own for it. */
const PUSH_BACK_KIND: Record<PrGuideAttention["kind"], string> = {
  risk: "Take this risk out before it merges.",
  contract: "Version this so a later change can't break what's already out there.",
  tradeoff: "Take the other side of this trade-off.",
  product: "Make this call the other way.",
  accessibility: "Don't rely on this alone: give everyone another way to get it.",
};

export function GuideRoute({ route, navigation }: ScreenProps<"Guide">) {
  const { id } = route.params;
  const rows = useRows();
  const chats = useMemo(() => rows.map((r) => r.chat), [rows]);
  const sent = sentReviews.use();
  const done = settled.use();
  const now = useNow(30_000);
  const prs = useMemo(() => queueOf(chats, sent, now), [chats, sent, now, done]); // eslint-disable-line react-hooks/exhaustive-deps -- a settled pull request changes the queue without changing these.
  const found = findPr(prs, id);
  // A chat's pull request leaves the queue the moment its chat goes back to work (asked to change, merging): the
  // screen keeps what it showed while it goes, and says the chat is at work.
  const last = useRef(found);
  // The queue is made again on every board change; the same pull request stays the same object, so the guide under
  // it (memo) draws again only when something it shows changed.
  if (found && (!last.current || signature(found) !== signature(last.current))) last.current = found;
  const pr = last.current;
  const chat = pr?.chat ? (chats.find((c) => c.id === pr.chat) ?? null) : null;
  // Reading its guide is looking at the chat: it leaves the Ready counts, as opening the chat does.
  useInbox(chats, chat?.phase === "ready" ? chat.id : null);
  if (!pr) {
    return (
      <View style={{ flex: 1 }}>
        <View style={{ paddingTop: 200 }}>
          <PageEmpty title="Nothing to review here" line="This pull request isn't open in any of your projects now." />
        </View>
        <TopBar onBack={() => navigation.goBack()} />
      </View>
    );
  }
  const working = !found && !!chat && chat.phase !== "ready" && chat.phase !== "done";
  return <GuideScreen key={prKey(pr)} pr={pr} chat={chat} working={working} sent={sent[prKey(pr)] ?? NO_SENT} navigation={navigation} />;
}

const NO_SENT: readonly Sent[] = [];

/** What a guide shows of a pull request, as one string: it draws again when this changes. */
const signature = (pr: Pr) => [prKey(pr), pr.head, pr.state, pr.checks, pr.checksLine, pr.review, pr.asksYou, pr.title, pr.tldr, pr.body, pr.branch].join("|");

/** The title block (PrPage's): where it lives, the title, branch into base, checks, size and age, and who made it. */
function TitleBlock({ pr, threads, onThreads }: { pr: Pr; /** Open review threads, which a tap opens where they are. */ threads: number; onThreads: () => void }) {
  const { c, t } = useTheme();
  const tone = pr.state === "open" ? c.success : pr.state === "merged" ? alpha(c.text, 0.75) : pr.state === "closed" ? c.destructive : c.muted;
  const add = pr.files.reduce((n, f) => n + f.add, 0);
  const del = pr.files.reduce((n, f) => n + f.del, 0);
  const checksTone = pr.checks === "passing" ? c.success : pr.checks === "failing" ? c.destructive : c.muted;
  const chief = pr.agent?.chief ? chiefById(pr.agent.chief) : null;
  const size = sizeLabel(guideLines(pr.files));
  return (
    <View style={{ paddingHorizontal: 16, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={STATE_ICON[pr.state]} size={15} stroke={2} color={tone} />
        <Text style={[t.small, { color: tone, fontWeight: "500" }]}>{STATE_WORD[pr.state]}</Text>
        <Text numberOfLines={1} style={[t.small, { flexShrink: 1 }]}>
          · {repoName(pr.repo)}
        </Text>
        <Text style={[t.small, { color: c.subtle, flexShrink: 0 }]}>#{pr.number}</Text>
      </View>
      <Text accessibilityRole="header" style={t.largeTitle}>
        {pr.title}
      </Text>
      <Text numberOfLines={1} ellipsizeMode="middle" style={{ fontFamily: mono, fontSize: 13, lineHeight: 18, color: c.muted }}>
        {pr.branch} <Text style={{ color: c.subtle }}>→</Text> {pr.base}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14, rowGap: 6, marginTop: 8 }}>
        {pr.checksLine ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {pr.checks === "pending" ? <PixelIcon name="state-working" size={14} label="Checks running" /> : <Icon name={pr.checks === "failing" ? "close" : "check"} size={14} stroke={2.25} color={checksTone} />}
            <Text style={[t.small, { color: pr.checks === "failing" ? c.destructive : c.muted }]}>{pr.checksLine}</Text>
          </View>
        ) : null}
        {pr.files.length ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ paddingHorizontal: 6, height: 18, borderRadius: 5, justifyContent: "center", backgroundColor: alpha(c.text, 0.08) }}>
              <Text accessibilityLabel={`Size ${size}`} style={{ fontSize: 11, lineHeight: 14, fontWeight: "600", color: c.soft }}>
                {size}
              </Text>
            </View>
            <Text style={[t.small, { fontVariant: ["tabular-nums"] }]}>
              {add ? <Text style={{ color: c.added }}>+{add}</Text> : null}
              {add && del ? " " : null}
              {del ? <Text style={{ color: c.removed }}>−{del}</Text> : null}
              {` · ${pr.files.length} ${pr.files.length === 1 ? "file" : "files"}`}
            </Text>
          </View>
        ) : null}
        <Text style={t.small}>
          {pr.commits} {pr.commits === 1 ? "commit" : "commits"} · opened {age(pr.openedAt)} ago
        </Text>
        {threads ? (
          <Squish label={`${threads} open ${threads === 1 ? "thread" : "threads"}. Go to it`} depth={0.95} hitSlop={10} onPress={onThreads} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Icon name="comment" size={14} color={c.muted} />
            <Text style={[t.small, { textDecorationLine: "underline", textDecorationColor: alpha(c.muted, 0.4) }]}>
              {threads} open {threads === 1 ? "thread" : "threads"}
            </Text>
          </Squish>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4, marginTop: 2, minHeight: 24 }}>
        {pr.agent ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <EngineLogo engine={pr.agent.engine} size={15} />
              <Text style={[t.small, { color: c.soft }]}>
                {ENGINE_NAME[pr.agent.engine]} <Text style={{ color: c.muted }}>{pr.agent.model}</Text>
              </Text>
            </View>
            {chief ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={t.small}>· started by</Text>
                <Sprite character={chief.character} tone={chief.tone} size={18} animate={false} label={chief.name} />
                <Text style={[t.small, { color: c.soft }]}>{chief.name}</Text>
              </View>
            ) : null}
          </>
        ) : (
          <>
            <Avatar login={pr.author} size={18} />
            <Text style={[t.small, { color: c.soft }]}>{pr.author === ME ? "You" : pr.author}</Text>
            {pr.asksYou && pr.state === "open" ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.warning, marginLeft: 2 }} />
                <Text style={t.small}>asks for your review</Text>
              </View>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

/** The way back to the chapter you left for Files, in glass over the foot. */
function BackCapsule({ label, bottom, onPress }: { label: string; bottom: number; onPress: () => void }) {
  const { c, t } = useTheme();
  return (
    <Animated.View entering={enter.fade} exiting={exit.gone} pointerEvents="box-none" style={{ position: "absolute", left: layout.inset, right: layout.inset, bottom, alignItems: "flex-start" }}>
      <Squish label={label} depth={0.95} onPress={onPress}>
        <Frost interactive style={{ height: layout.float, borderRadius: layout.float / 2, paddingLeft: 12, paddingRight: 16, flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 340 }}>
          <Icon name="chevronLeft" size={16} color={c.text} />
          <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.label, { flexShrink: 1, fontSize: 15, color: c.text }]}>
            {label}
          </Text>
        </Frost>
      </Squish>
    </Animated.View>
  );
}

interface ScreenArgs {
  pr: Pr;
  chat: Chat | null;
  working: boolean;
  sent: readonly Sent[];
  navigation: ScreenProps<"Guide">["navigation"];
}

const GuideScreen = memo(function GuideScreen({ pr, chat, working, sent, navigation }: ScreenArgs) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenH } = usePane();
  const still = useReducedMotion();
  const focused = useIsFocused();
  const pick = useDefaultPick();
  const review = useReview(pr);
  const guide = review.result.guide;
  const tour = guide && (guide.depth ?? "tour") === "tour" ? guide : null;
  const stops = tour?.stops ?? NO_STOPS;
  const key = marksKey(pr);
  const read = useRead(key);
  const viewed = useViewed(key);
  const asked = useAsked(prKey(pr));
  const replies = useReplies();
  const resolved = useResolved();
  const started = useStarted(prKey(pr));
  const [tab, setTab] = useState<Tab>("guide");
  const [wrap, setWrap] = useState(true);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [line, setLine] = useState<LineAt | null>(null);
  const [merging, setMerging] = useState(false);
  const [contents, setContents] = useState(false);
  const [footH, setFootH] = useState(0);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [backTo, setBackTo] = useState<{ stop: number; y: number } | null>(null);

  const scroll = useRef<ScrollViewInstance>(null);
  const scrollY = useSharedValue(0);
  // Where the tab's content starts in the page, and where the guide's body and Files start inside it.
  const bodyY = useRef(0);
  const innerY = useRef(0);
  const stopY = useRef(new Map<number, number>());
  const partY = useRef(new Map<string, number>());
  const titleBottom = useRef(140);
  const tabY = useRef<Record<Tab, number | null>>({ guide: null, files: null });
  const [past, setPast] = useState(false);
  const [current, setCurrent] = useState(-1);

  const paths = useMemo(() => pr.files.map((f) => f.path), [pr.files]);
  const sections = useMemo(() => sectionsOf(tour, paths, review.files), [tour, paths, review.files]);
  const parts = useMemo(() => partsOf(sections), [sections]);
  const short = isShortChange(guideLines(pr.files), DEFAULT_SHORT_LINES);
  const open = pr.state === "open" || pr.state === "draft";

  // A pull request with no guide for its head gets one written as you open it: a chat's own TL;DR
  // stands in only for a short change, which needs no tour.
  useEffect(() => {
    if (!open || tour || review.result.running) return;
    if (guide && (guide.depth === "tldr" ? short : true)) return;
    writeGuide(pr, [...review.files.values()]);
  }, [open, tour, guide, short, review]); // eslint-disable-line react-hooks/exhaustive-deps -- `review` stands for `pr`; write once per change in these, not per render.

  const barBottom = insets.top + BAR_HEIGHT;
  const footBottom = Math.max(insets.bottom, 10);
  const backBottom = footBottom + (open ? footH : 0) + layout.rowAbove;
  const showBack = focused && tab === "files" && !!backTo;

  const where = (y: number) => {
    const nextPast = y > titleBottom.current - barBottom;
    if (nextPast !== past) setPast(nextPast);
    if (tab !== "guide" || !tour) return current !== -1 && setCurrent(-1);
    const mark = y + screenH / 3;
    let at = -1;
    for (const [i, top] of [...stopY.current.entries()].sort((a, b) => a[1] - b[1])) if (bodyY.current + innerY.current + top <= mark) at = i;
    if (at !== current) setCurrent(at);
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => where(e.nativeEvent.contentOffset.y);

  const scrollTo = (y: number, animated = !still) => scroll.current?.scrollTo({ y: Math.max(0, y - barBottom - 8), animated });
  /** Shows the other tab where you were in it last (or at its top), then does `then`. */
  const switchTab = (next: Tab, then?: () => void) => {
    if (next === tab) {
      then?.();
      return;
    }
    tabY.current[tab] = scrollY.value;
    setTab(next);
    if (next === "guide") setBackTo(null);
    setTimeout(() => {
      const was = tabY.current[next];
      if (then) then();
      else if (was !== null) scroll.current?.scrollTo({ y: was, animated: false });
      else if (scrollY.value > titleBottom.current) scroll.current?.scrollTo({ y: titleBottom.current - barBottom + 4, animated: false });
    }, 140);
  };
  const jump = (i: number) =>
    switchTab("guide", () => {
      const top = stopY.current.get(i);
      if (top !== undefined) scrollTo(bodyY.current + innerY.current + top + 8);
    });
  const toPart = (id: string) => {
    const top = partY.current.get(id);
    if (top !== undefined) scrollTo(bodyY.current + innerY.current + top);
  };
  /** The part of Files a line is in. */
  const partWith = (path: string, n?: number, side: "new" | "old" = "new"): Part | undefined => {
    const mine = parts.filter((p) => p.path === path);
    if (n === undefined) return mine[0];
    const file = review.files.get(path);
    if (!file) return mine[0];
    const hunks = hunksOf(file);
    return mine.find((p) => p.hunks.some((h) => hunks[h]?.rows.some((r) => (side === "new" ? r.newNo : r.oldNo) === n))) ?? mine[0];
  };
  const openFile = (path: string, n?: number, side: "new" | "old" = "new") => {
    haptic.tick();
    const part = partWith(path, n, side);
    if (part && viewed.has(part.id)) setViewed(key, [part.id], false);
    if (tab === "guide" && current >= 0) setBackTo({ stop: current, y: scrollY.value });
    switchTab("files", () => {
      if (n !== undefined) setFocus({ kind: "line", path, line: n, side, nonce: Date.now() });
      else if (part) toPart(part.id);
    });
  };
  const onFound = useRef((y: number) => {});
  onFound.current = (y: number) => {
    const target = barBottom + (screenH - barBottom) * 0.28;
    scroll.current?.scrollTo({ y: Math.max(0, scrollY.value + y - target), animated: !still });
  };
  const onLine = useRef((at: LineAt) => {});
  onLine.current = (at: LineAt) => setLine(at);
  const code: CodeSettings = useMemo(() => ({ wrap, focus, onFound: (y) => onFound.current(y), onLine: (at) => onLine.current(at) }), [wrap, focus]);

  const markRead = (i: number, on: boolean) => {
    setRead(key, i, on);
    if (!on || !tour) return;
    // On to the next chapter not yet read, a beat after the tick lands (PrPage.tsx's 450 ms); past the last, back to
    // the first one left.
    const left = (k: number) => k !== i && !read.has(k) && !isSkimStop(tour.stops[k]!);
    const next = tour.stops.findIndex((_, k) => k > i && left(k));
    const again = next >= 0 ? next : tour.stops.findIndex((_, k) => left(k));
    if (again >= 0) setTimeout(() => jump(again), 450);
  };

  const onViewed = (part: Part, on: boolean, fromEnd: boolean) => {
    const at = partY.current.get(part.id);
    setViewed(key, [part.id], on);
    if (!on) return;
    // Ticked at its end: the part folds, so its head comes back to where you are, and the next one left comes up.
    const next = parts.slice(parts.indexOf(part) + 1).find((p) => !viewed.has(p.id));
    setTimeout(() => {
      if (next) toPart(next.id);
      else if (fromEnd && at !== undefined) scrollTo(bodyY.current + innerY.current + at);
    }, 90);
  };

  const threadList = useMemo(() => [...review.threads, ...started], [review.threads, started]);
  const threads: Threads = useMemo(
    () => ({
      list: threadList,
      replies,
      resolved,
      onReply: (th) => setCompose({ mode: "reply", thread: th.id, text: "", passage: { where: `the thread on ${th.path.split("/").pop()}:${th.line}`, quote: th.comments.map((m) => m.body).join("\n") } }),
      onResolve: (th, on) => resolve(th.id, on),
    }),
    [threadList, replies, resolved],
  );
  const openThreads = threadList.filter((th) => !isResolved(th, resolved));
  /** A thread, where it is: the chapter whose code shows its line, else its part of Files; the card lights. */
  const toThread = (id?: string) => {
    const th = id ? threadList.find((x) => x.id === id) : openThreads[0];
    if (!th) return;
    const inGuide = tour?.stops.some((s) => s.excerpts.some((e) => e.path === th.path && e.side === th.side && th.line >= e.start && th.line <= e.end));
    if (!inGuide) {
      const part = partWith(th.path, th.line, th.side);
      if (part && viewed.has(part.id)) setViewed(key, [part.id], false);
    }
    switchTab(inGuide ? "guide" : "files", () => setFocus({ kind: "thread", id: th.id, nonce: Date.now() }));
  };

  /** The chapter you're reading, as a passage an ask or a push back is about. */
  const here = (i: number | null): { stop: number | null; passage?: Passage } => {
    const stop = i !== null && i >= 0 ? stops[i] : undefined;
    return stop && i !== null ? { stop: i, passage: { where: whereOf(i, stop), quote: stop.summary } } : { stop: null };
  };
  const pushBackOn = (stop: PrGuideStop | null, attention: PrGuideAttention | undefined | null) => {
    const own = stop ? PUSH_BACK[stop.title] : undefined;
    return [own, attention ? PUSH_BACK_KIND[attention.kind] : undefined, "Add a test that would catch this.", "Keep it smaller: split it into its own pull request."].filter((s): s is string => !!s);
  };
  const onCompose = (mode: Compose["mode"]) => {
    const at = tab === "guide" && current >= 0 ? current : null;
    const { stop, passage } = here(at);
    const s = stop !== null ? (stops[stop] ?? null) : null;
    if (mode === "ask") setCompose({ mode, text: "", stop, passage, suggestions: s ? s.questions.filter((q) => !asked.some((a) => a.question === q)) : [] });
    else setCompose({ mode, text: "", stop, passage, suggestions: pushBackOn(s, s ? s.attention : guide?.attention) });
  };
  const onPushBack = (i: number | null) => {
    const { stop, passage } = here(i);
    const s = stop !== null ? (stops[stop] ?? null) : null;
    const attention = s ? s.attention : guide?.attention;
    const says = pushBackOn(s, attention);
    setCompose({ mode: "changes", text: says[0] ?? "", stop, passage: passage ?? (attention ? { where: `the guide's call, “${CALL_WORD[attention.kind]}”`, quote: attention.note } : undefined), suggestions: says.slice(1) });
  };
  const ask = (stop: number | null, passage: Passage | undefined, question: string, at?: { path: string; line: number }) => {
    haptic.tick();
    setAnswer(askAgent({ pr, review, chat, stop, passage, question, line: at }));
  };

  const send = (sent: Compose) => {
    setCompose(null);
    if (sent.mode === "reply" && sent.thread) return reply(sent.thread, sent.text);
    if (sent.mode === "comment" && sent.line) {
      startThread(prKey(pr), { id: `mine-${Date.now().toString(36)}`, path: sent.line.path, line: sent.line.line, side: "new", resolved: false, comments: [{ author: ME, body: sent.text, at: Date.now() }] });
      sendReview(pr, { verdict: "comment", body: sent.text, at: Date.now() });
      script.notify(`Commented on #${pr.number}`, "done");
      return;
    }
    if (sent.mode === "ask") {
      // Answer only, whoever's it is: the answer comes back here, in the sheet you asked from.
      setTimeout(() => ask(sent.stop ?? null, sent.passage, sent.text, sent.line), 320);
      return;
    }
    if (chat && pr.state !== "draft") {
      // Back to the chat that made it, as your words: it changes this same branch and brings it back, and the guide
      // waits, saying so, until it does. Whatever the words are, it is a change: nothing here reads as "ship it".
      script.send(chat.id, steerText(sent.text, sent.passage), "fix");
      script.notify(`Sent back · #${pr.number}`, "done");
      return;
    }
    if (!pr.mine && pr.state !== "draft") {
      sendReview(pr, { verdict: "request_changes", body: sent.passage ? `${sent.text}\n\n(About ${sent.passage.where}.)` : sent.text, at: Date.now() });
      script.notify(`Asked for changes on #${pr.number}`, "done");
      return;
    }
    // Your own draft with no chat on it: an agent starts on its branch, told the pull request and the passage.
    const id = startChat(agentTask({ pr: { number: pr.number, title: pr.title, repo: pr.repo, branch: pr.branch }, mode: "fix", passage: sent.passage, text: sent.text }), pick, repoName(pr.repo));
    navigation.push("Thread", { id });
  };

  const merge = () => {
    if (chat) {
      script.send(chat.id, "Ship it");
      script.notify(`Merging #${pr.number} · CI is running`, "info");
    } else {
      settlePr(pr, "merged");
      script.notify(`Merged #${pr.number}`, "done");
    }
    navigation.goBack();
  };

  const unread: Unread = {
    read: stops.filter((_, i) => read.has(i)).length,
    total: stops.length,
    calls: stops
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s.attention && !read.has(i))
      .map(({ s, i }) => ({ stop: i, kind: s.attention!.kind, note: s.attention!.note }))
      .sort((a, b) => Number(b.kind === "risk") - Number(a.kind === "risk") || a.stop - b.stop),
    unseen: !tour && viewed.size === 0 && !short,
  };

  // The chat that made it is usually the screen you came from: the stack's rule goes back to it rather than pushing a
  // second copy over the guide.
  const openChat = chat ? () => openChatScreen(chat.id) : undefined;
  const menu: MenuEntry[] = [
    { label: "Wrap long lines", toggled: wrap, onPress: () => setWrap(!wrap) },
    { label: tab === "guide" ? "Files" : "Guide", icon: tab === "guide" ? "diff" : "checklist", onPress: () => switchTab(tab === "guide" ? "files" : "guide") },
    ...(tour ? ([{ label: "Contents", icon: "menu", onPress: () => setContents(true) }] as MenuEntry[]) : []),
    ...(openChat ? ([{ type: "separator" }, { label: "Open the chat", icon: "open", onPress: openChat }] as MenuEntry[]) : []),
  ];

  const tldr = guide?.tldr ?? pr.tldr;
  const bottomRoom = (open ? footH + footBottom : footBottom) + layout.float + 32;
  const inChapters = tab === "guide" && !!tour && current >= 0;
  const asker = askerOf(pr);
  const shownAnswer = answer ? (asked.find((a) => a.id === answer) ?? null) : null;
  const viewedParts = parts.filter((p) => viewed.has(p.id)).length;

  return (
    <CodeContext.Provider value={code}>
      <View
        style={{ flex: 1 }}
        onAccessibilityEscape={() => navigation.goBack()}
        onMagicTap={() => {
          if (open && pr.mine && !working && pr.state === "open") setMerging(true);
        }}
      >
        {/* The bar comes first, so VoiceOver reaches Back before the guide; it still draws over the page. */}
        <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: barBottom, zIndex: 3 }}>
          <TopBar
            onBack={() => navigation.goBack()}
            scrollY={scrollY}
            title={past ? pr.title : undefined}
            subtitle={past ? (inChapters ? `${current + 1} of ${stops.length} · ${stops[current]?.title ?? ""}` : `#${pr.number} · ${repoName(pr.repo)}`) : undefined}
            mark={past ? <Icon name={STATE_ICON[pr.state]} size={16} stroke={2} color={pr.state === "open" ? c.success : c.muted} /> : undefined}
            onTitle={tour ? () => setContents(true) : undefined}
            menu={{ entries: menu }}
          />
        </View>
        <Page ref={scroll} scrollY={scrollY} onScroll={onScroll} contentContainerStyle={{ paddingBottom: bottomRoom }}>
          <View onLayout={(e) => (titleBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
            <TitleBlock pr={pr} threads={openThreads.length} onThreads={() => toThread()} />
          </View>
          <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
            <Segmented<Tab>
              label="Guide or files"
              value={tab}
              onChange={(next) => switchTab(next)}
              options={[
                { value: "guide", label: tour ? `Guide · ${unread.read}/${stops.length}` : "Guide" },
                { value: "files", label: `Files · ${parts.length > paths.length ? `${viewedParts}/${parts.length}` : paths.length}` },
              ]}
            />
          </View>
          <View onLayout={(e) => (bodyY.current = e.nativeEvent.layout.y)} style={{ paddingTop: 20 }}>
            {tab === "guide" ? (
              <>
                {tldr ? (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 24 }}>
                    <Tldr text={tldr} by={guide?.by} />
                  </View>
                ) : null}
                <View onLayout={(e) => (innerY.current = e.nativeEvent.layout.y)}>
                  <GuideBody
                    pr={pr}
                    chat={chat}
                    review={review}
                    read={read}
                    onRead={markRead}
                    onOpenFile={openFile}
                    onAsk={(stop, passage, question) => ask(stop, passage, question)}
                    onJump={jump}
                    onPlace={(i, y) => stopY.current.set(i, y)}
                    onOpenChat={openChat}
                    onPushBack={onPushBack}
                    onRewrite={() => writeGuide(pr, [...review.files.values()])}
                    asked={asked}
                    onOpenAnswer={setAnswer}
                    sent={sent}
                    onThread={toThread}
                    threads={threads}
                  />
                </View>
              </>
            ) : (
              <View onLayout={(e) => (innerY.current = e.nativeEvent.layout.y)}>
                <FilesView sections={sections} files={review.files} viewed={viewed} threads={threads} onViewed={onViewed} onOpenStop={jump} onPlace={(id, y) => partY.current.set(id, y)} verbs={verbsFor(pr)} />
              </View>
            )}
          </View>
        </Page>
        {open ? <BottomEdge floor={footBottom + footH} top={footBottom + footH + layout.rowAbove + (showBack ? layout.float : 0)} /> : null}
        {showBack && backTo ? (
          <BackCapsule
            label={`Back to chapter ${backTo.stop + 1}`}
            bottom={backBottom}
            onPress={() => {
              const y = backTo.y;
              setBackTo(null);
              tabY.current.guide = y;
              switchTab("guide");
            }}
          />
        ) : null}
        <Foot
          pr={pr}
          sent={sent}
          working={working}
          bottom={footBottom}
          onHeight={setFootH}
          onCompose={onCompose}
          onMerge={() => setMerging(true)}
          onOpenChat={openChat}
          onApprove={() => {
            sendReview(pr, { verdict: "approve", body: "", at: Date.now() });
            script.notify(`Approved #${pr.number}`, "done");
          }}
          onReady={() => {
            settlePr(pr, "ready");
            script.notify(`#${pr.number} is ready for review`, "done");
          }}
        />
        <ContentsSheet
          open={contents}
          onClose={() => setContents(false)}
          pr={pr}
          stops={stops}
          read={read}
          current={current}
          files={parts.length}
          onJump={(i) => (setContents(false), setTimeout(() => jump(i), 260))}
          onFiles={() => (setContents(false), switchTab("files"))}
          onTop={() => (setContents(false), switchTab("guide", () => scroll.current?.scrollTo({ y: titleBottom.current - barBottom + 4, animated: !still })))}
        />
        <ComposeSheet pr={pr} compose={compose} onClose={() => setCompose(null)} onSend={send} />
        <AnswerSheet
          asked={shownAnswer}
          asker={asker}
          onClose={() => setAnswer(null)}
          onOpenChat={
            openChat
              ? () => {
                  setAnswer(null);
                  setTimeout(openChat, 300);
                }
              : undefined
          }
          onAskMore={() => {
            const was = shownAnswer;
            setAnswer(null);
            setTimeout(() => {
              const { stop, passage } = here(was?.stop ?? null);
              setCompose({ mode: "ask", text: "", stop, passage });
            }, 360);
          }}
        />
        <LineSheet
          line={line}
          pr={pr}
          onClose={() => setLine(null)}
          onAsk={() => {
            const at = line!;
            setLine(null);
            const stop = tour?.stops.findIndex((s) => s.excerpts.some((e) => e.path === at.path && e.side === at.side && at.line >= e.start && at.line <= e.end)) ?? -1;
            setTimeout(() => setCompose({ mode: "ask", text: "", stop: stop >= 0 ? stop : null, line: { path: at.path, line: at.line }, passage: { where: `${at.path}:${at.line}`, quote: at.text.trim() }, suggestions: [`What does line ${at.line} do?`, "Why is it written this way?"] }), 360);
          }}
          onChange={() => {
            const at = line!;
            setLine(null);
            setTimeout(() => setCompose({ mode: "changes", text: "", stop: null, line: { path: at.path, line: at.line }, passage: { where: `${at.path}:${at.line}`, quote: at.text.trim() } }), 360);
          }}
          onComment={
            !pr.mine && open
              ? () => {
                  const at = line!;
                  setLine(null);
                  setTimeout(() => setCompose({ mode: "comment", text: "", line: { path: at.path, line: at.line }, passage: { where: `${at.path.split("/").pop()}:${at.line}`, quote: at.text.trim() } }), 360);
                }
              : undefined
          }
        />
        <MergeSheet pr={pr} open={merging} unread={unread} onClose={() => setMerging(false)} onMerge={merge} onRead={(i) => (setMerging(false), setTimeout(() => jump(i), 300))} />
        <Text accessibilityLiveRegion="polite" style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}>
          {tour ? `Guide ready, ${stops.length} chapters, by ${guide?.model ?? "a model"}` : review.result.running ? "Caveman is reading the change" : ""}
        </Text>
      </View>
    </CodeContext.Provider>
  );
});

const NO_STOPS: readonly PrGuideStop[] = [];

/** The tour's contents (the desktop's rail and its numbered list, as a sheet): every chapter, read or not, to jump to. */
function ContentsSheet({ open, onClose, pr, stops, read, current, files, onJump, onFiles, onTop }: { open: boolean; onClose: () => void; pr: Pr; stops: readonly PrGuideStop[]; read: ReadonlySet<number>; current: number; files: number; onJump: (i: number) => void; onFiles: () => void; onTop: () => void }) {
  const { c, t } = useTheme();
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, minHeight: 50, paddingHorizontal: 20, paddingVertical: 6 };
  return (
    <Overlay open={open} onClose={onClose} title="Contents">
      <View style={{ paddingBottom: 8 }}>
        <Squish label="The TL;DR and your calls, at the top" depth={0.99} highlight onPress={onTop} style={row}>
          <View style={{ width: 24, alignItems: "center" }}>
            <PixelIcon name="engine-caveman" size={16} />
          </View>
          <Text style={[t.row, { flex: 1 }]}>TL;DR and your calls</Text>
        </Squish>
        {stops.map((stop, i) => (
          <Squish key={i} label={`Chapter ${i + 1}, ${stop.title}${read.has(i) ? ", read" : ""}${stop.attention ? `, ${CALL_WORD[stop.attention.kind]}` : ""}`} depth={0.99} highlight selected={i === current} onPress={() => onJump(i)} style={[row, i === current ? { backgroundColor: alpha(c.text, 0.05) } : null]}>
            <View style={{ width: 24, alignItems: "center" }}>{read.has(i) ? <PixelIcon name="state-done" size={16} /> : <Text style={{ fontFamily: mono, fontSize: 13, color: c.subtle }}>{pad(i + 1)}</Text>}</View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[t.row, { color: read.has(i) ? c.muted : c.text }]}>{stop.title}</Text>
              {stop.attention ? <CallWord kind={stop.attention.kind} /> : null}
            </View>
          </Squish>
        ))}
        <View style={{ height: 1, backgroundColor: c.hairline, marginVertical: 6, marginLeft: 56 }} />
        <Squish label={`Files, ${pr.files.length}`} depth={0.99} highlight onPress={onFiles} style={row}>
          <View style={{ width: 24, alignItems: "center" }}>
            <Icon name="diff" size={18} color={c.muted} />
          </View>
          <Text style={[t.row, { flex: 1 }]}>Files</Text>
          <Text style={t.meta}>{files > pr.files.length ? `${pr.files.length} files, ${files} parts` : pr.files.length}</Text>
        </Squish>
      </View>
    </Overlay>
  );
}
