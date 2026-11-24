// A Chief's screen on the phone: its chat, folded the way a chat folds, with its own pixel character standing on the
// box so you always know which Chief you're talking to (docs/ "The Chief"; DECISIONS.md, "A Chief's
// chat"). Its bar leads with the sidebar's button where the sidebar opened it as the main panel's root, with a compose
// circle at the right for a new chat, or with Back where it was pushed (a chat named it), and a glass capsule holding
// its character, its name and what it watches ("marketing", "All workspaces"), as a chat's capsule says where it runs;
// the capsule opens its menu. Over the box floats one
// capsule at x 16 saying how its chats stand ("1 working · 1 ready"); a tap opens all of them in the agents sheet.
// Where the sidebar stands beside the panel (the iPhone Duo unfolded) its agents are its inspector instead, beside the
// chat, and a row there opens its chat over the Chief.
//
// An ask docks in the box's place, as in a chat, with the Chief standing on it (chief/Deck.tsx AskDock); once none is
// docked, a change ready to try sits on the box's top edge as one object with it, the Chief standing on it, and the
// capsule makes way (the card's "1 of 2" counts). A yes or a no takes its card away at once, its Undo in the shell's
// toast (chief/decide.ts), and the next ask comes forward; only a row in the agents sheet or a peek keeps its Undo
// where its buttons were.
// Once its own asks are answered, if others wait on another Chief or chat, the capsule says for a few seconds which is
// next, and a tap goes there with its ask docked. What it's doing shows in its thought bubble. The round
// button calls it: your words show large, it answers in speech bubbles, and what it brings up lands in the middle. A
// chat it names opens over it: Back returns here. Sheets open over all of it without moving anything under them.
//
// The calls and the words you "say" are scripted like the rest of the prototype; the seams are the board's
// (board/script.ts tellChief, allow, deny, send, endCall).
import type { MascotPose } from "@caveman-app/ui/mascot/poses";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { Text, useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Chief, chiefById, HOME_CHIEF } from "../board/model";
import { act as answerAsk } from "../asks/decide";
import * as script from "../board/script";
import type { Start } from "../board/script";
import { AgentsRow, ROW } from "../chief/Agents";
import { type AgentsFilter, AgentsList, AgentsSheet, agentsTitle } from "../chief/AgentsSheet";
import { askedBy, type Card, deckOf } from "../chief/cards";
import { ChiefChat } from "../chief/ChiefChat";
import { AskDock, ReadyCard } from "../chief/Deck";
import { decide, type Slot, usePending } from "../chief/decide";
import { Peek } from "../chief/Peek";
import { Perch, PERCH } from "../chief/Perch";
import { Stage } from "../chief/Stage";
import { spoken } from "../chief/turns";
import { workId } from "../chief/WorkMark";
import { askQuestion } from "../home/model";
import { Sprite, LOOK } from "../components/Sprite";
import { haptic } from "../motion";
import { openChat, openChief, showNewChat } from "../nav/ref";
import { type ScreenProps, useIsRoot } from "../nav/routes";
import { Composer, COMPOSER_LINE_HEIGHT } from "../shell/Composer";
import { useChatLift } from "../shell/composer/place";
import { endVoice, voice as voiceChat } from "../shell/composer/voice";
import { useDefaultPick } from "../shell/Sheets";
import { getChiefPick } from "../shell/chiefPicks";
import { notice, openSettings, review, useBoxAsked, useUi } from "../shell/ui";
import { InspectorFill, useShell } from "../shell/layout";
import { BarGroup, BAR_HEIGHT, GlassButton, TopBar } from "../shell/TopBar";
import { askQueue, chiefListOf, listOf } from "../store/select";
import { chiefScope, getDraft, markRead } from "../store/sessions";
import { store, useStore } from "../store/store";
import { holdAudio, setMicMuted, speak, stopSpeaking } from "../system/audio";
import { clearTalk, setTalk, talkNow, updateTalk } from "../system/talk";
import { alpha, useTheme } from "../theme";

// The script starts with the app; this makes sure of it wherever the app opens (it does nothing a second time).
script.ensureScript();

/** What you "say" on a call, turn by turn: the prototype's microphone. */
const CALL_LINES = ["What's left today?", "Show me what's ready", "Looks great, ship it"];
const WORD_MS = 240;
/** Quiet this long and the character dozes off. */
const DOZE_MS = 45_000;
/** How long the next ask waiting elsewhere stays in the capsule after you answer this Chief's last (a thread's). */
/** A touch this soon after Next appears is the thumb that answered, still in flight: it neither opens nor clears it. */
const NEXT_ARM_MS = 450;
/** How far over the chrome the chat fades out, so nothing reads behind the character. */
const FADE = 36;
/** How much of the character stands over the edge it's on (its feet sit 6 into it). */
const STANDS = PERCH - 6;

type CallPhase = "ringing" | "hearing" | "waiting" | "speaking" | "listening";
/** What the lock screen says a call is doing, by its phase (system/talk.ts `state`). */
const CALL_SAYS: Record<CallPhase, string> = { ringing: "Calling…", hearing: "Listening", listening: "Listening", waiting: "Thinking", speaking: "Speaking" };
/** The breath after the Chief has said its answer aloud, before your next line. */
const AFTER_SAID_MS = 500;
interface Call {
  started: number;
  phase: CallPhase;
  turn: number;
  heard: string;
  muted: boolean;
}

interface Props {
  chief: Chief;
  start: Start;
  /** What waits on you on other Chiefs' boards: an amber dot on Back, or on the sidebar's button. */
  waiting: number;
  /** The main panel's root: the sidebar's button instead of Back, and a compose circle at the right. */
  root?: boolean;
  onBack: () => void;
  onNewChat: () => void;
  onOpen: (id: string) => void;
  onReview: (id: string) => void;
  /** Opens this Chief's settings (the desktop header's "Chief settings"); the menu leaves the row out without it. */
  onSettings?: () => void;
  /** Bump to call it from elsewhere (a Chief's menu's "Call Oona"). */
  callAsk?: number;
  /** Goes to another Chief in this one's place (its menu lists them), so Back still leads where it did. */
  onSwitch?: (id: string) => void;
  /** Goes to the next ask waiting elsewhere in this one's place: its Chief, or the chat when no Chief runs it. */
  onNext?: (to: { chief: string | null; chat: string }) => void;
}

/** The next ask waiting elsewhere, as the capsule offers it. */
interface Next {
  chief: string | null;
  chat: string;
  question: string;
  total: number;
}

const NO_COUNTS = { needs: 0, ready: 0, working: 0, total: 0 };

export function ChiefScreen({ chief, start, waiting, root = false, onBack, onNewChat, onOpen, onReview, onSettings, callAsk = 0, onSwitch, onNext }: Props) {
  const { c, t, dark } = useTheme();
  const insets = useSafeAreaInsets();
  // How far the chat has scrolled: the bar's edge comes in once something is under it.
  const edgeY = useSharedValue(0);
  const scope = chiefScope(chief.id);

  // Its chats as Home counts them: its own, never a subagent on its own, never one archived behind Undo.
  const rows = useStore((s) => listOf(s, { filter: "all", chief: chief.id }));
  const chats = useStore((s) => s.board.chats);
  const inbox = useStore((s) => s.inbox);
  const allSaid = useStore((s) => s.board.said);
  const said = useMemo(() => allSaid.filter((line) => line.chief === chief.id), [allSaid, chief.id]);
  const thinking = useStore((s) => s.board.thinking[chief.id] ?? null);
  const showingRef = useStore((s) => s.board.showing);
  const chiefs = useStore(chiefListOf);
  const counts = chiefs.find((r) => r.chief.id === chief.id) ?? NO_COUNTS;
  const showing = showingRef?.chief === chief.id ? (chats.find((ch) => ch.id === showingRef.id) ?? null) : null;
  const pending = usePending();

  const [typing, setTyping] = useState(false);
  const [hop, setHop] = useState(0);
  const [knock, setKnock] = useState(0);
  const [flash, setFlash] = useState<{ pose: MascotPose; look?: number } | null>(null);
  const [talking, setTalking] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const [call, setCall] = useState<Call | null>(null);
  const [saying, setSaying] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const [dockHeight, setDockHeight] = useState(0);
  const [next, setNext] = useState<Next | null>(null);
  const focused = useIsFocused();
  // The dock put away with a swipe down: the box is back, and the capsule says what waits until you dock it again.
  const [stowed, setStowed] = useState(false);
  // Share to Caveman landed here (ui.ts focusBoxOf): the dock steps away so the box, holding what came, takes the keyboard.
  const shareHere = useBoxAsked(scope);
  useEffect(() => {
    if (shareHere) setStowed(true);
  }, [shareHere]);
  // "Tell it what to do instead": the box is back over the ask, and what's sent from it turns the ask down and steers.
  const [instead, setInstead] = useState<Card | null>(null);
  const [focusAsk, setFocusAsk] = useState(0);
  const typed = useRef(false);
  // How tall the box stands over the safe edge at rest, the floating row riding on it included (Composer `onHeight`).
  const [boxHeight, setBoxHeight] = useState(COMPOSER_LINE_HEIGHT + ROW + 10);
  const [away, setAway] = useState(false);
  const [jump, setJump] = useState(0);
  // Its agents, all of them, on a sheet (a row's peek is pushed inside it); and a chat named on this screen, held, as a
  // peek of its own.
  const [agents, setSheetAgents] = useState<AgentsFilter | null>(null);
  // Its agents: beside the chat where the sidebar stands beside the panel (the inspector), else the sheet.
  const shell = useShell();
  const setAgents = (on: AgentsFilter | null) => (shell.split ? on && shell.setInspector(true) : setSheetAgents(on));
  const [peekId, setPeekId] = useState<string | null>(null);
  const peeked = peekId ? (chats.find((ch) => ch.id === peekId) ?? null) : null;

  // Leaving it counts as having read it up to now.
  useEffect(() => () => markRead(scope), [scope]);

  // ---------- the character's reactions ----------
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const act = (pose: MascotPose, ms: number, look?: number) => {
    clearTimeout(flashTimer.current);
    setFlash({ pose, look });
    flashTimer.current = setTimeout(() => setFlash(null), ms);
  };
  const lastEvent = useRef(Date.now());
  const stir = () => {
    lastEvent.current = Date.now();
    setAsleep(false);
  };
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - lastEvent.current > DOZE_MS) setAsleep(true);
    }, 5000);
    return () => {
      clearInterval(timer);
      clearTimeout(flashTimer.current);
    };
  }, []);

  // A new line in its chat: your note lands in its hands; its own words, it says.
  const lastLine = said.at(-1);
  useEffect(() => {
    if (!lastLine || Date.now() - lastLine.at > 2000) return;
    stir();
    if (lastLine.who === "you") {
      setHop((n) => n + 1);
      act("done", 900);
    } else if (lastLine.who === "chief" && !call) {
      setTalking(true);
      const timer = setTimeout(() => setTalking(false), Math.min(4000, lastLine.text.split(" ").length * 42 + 300));
      return () => clearTimeout(timer);
    }
  }, [lastLine?.id]);

  // A chat it just started pops into its capsule as it hops.
  const known = useRef(new Set(rows.map((r) => r.chat.id)));
  useEffect(() => {
    const fresh = rows.filter((r) => !known.current.has(r.chat.id));
    known.current = new Set(rows.map((r) => r.chat.id));
    if (fresh.length) {
      stir();
      setHop((n) => n + 1);
    }
  }, [rows]);

  // A tick when something comes to need you, as the capsule turns amber.
  const needsBefore = useRef(counts.needs);
  useEffect(() => {
    if (counts.needs > needsBefore.current) haptic.tick();
    needsBefore.current = counts.needs;
  }, [counts.needs]);

  // ---------- what waits on you ----------
  const deck = useMemo(() => deckOf(rows, chats, inbox, pending), [rows, chats, inbox, pending]);
  const asks = useMemo(() => deck.filter((card) => card.kind === "ask"), [deck]);
  const readies = useMemo(() => deck.filter((card) => card.kind === "ready"), [deck]);
  // An ask docks in the box's place unless you're on a call, telling it what to do instead, or put the dock away.
  const docked = !call && !instead && !stowed && asks.length > 0;
  // A change ready to try waits over the floating row once nothing is docked, and makes way while you write.
  const readyUp = !docked && !call && !typing && readies.length > 0;
  // With nothing left to dock, a put-away dock is forgotten; an ask answered elsewhere ends "instead".
  useEffect(() => {
    if (!asks.length) setStowed(false);
    if (instead && !asks.some((a) => a.chat.id === instead.chat.id)) setInstead(null);
  }, [asks, instead]);

  // Its own last ask answered (and landed) while others wait elsewhere: the one that has waited longest is offered
  // (store/select.ts askQueue, the order every list of asks uses), until your next move here or until you leave.
  const openAsks = asks.length;
  const hadOpen = useRef(openAsks);
  useEffect(() => {
    const answered = hadOpen.current > 0 && openAsks === 0;
    hadOpen.current = openAsks;
    // Only an answer given here: one given in a chat opened over it was offered its Next there, and coming back must
    // not offer it again.
    if (!answered || !focused) return;
    const elsewhere = askQueue(store.get()).filter((x) => x.row.chief !== chief.id && x.asker.phase === "needs");
    const first = elsewhere[0];
    if (!first) return;
    nextAt.current = Date.now();
    setNext({ chief: first.row.chief, chat: first.asker.id, question: askQuestion(first.asker), total: elsewhere.length });
  }, [openAsks]);
  // A move of yours here (a tap, a word) puts Next away, past its first moments; leaving takes it too.
  const nextAt = useRef(0);
  const dropNext = () => {
    if (Date.now() - nextAt.current < NEXT_ARM_MS) return;
    setNext((was) => (was ? null : was));
  };
  useEffect(() => {
    if (!focused) setNext(null);
  }, [focused]);

  // A new ask in front of you: the Chief hops and waves at it.
  const onShown = (key: string) => {
    if (!key) return;
    stir();
    setHop((n) => n + 1);
    act("wave", 650);
  };

  const answer = (card: Card, yes: boolean, from: Slot) => {
    stir();
    act(yes ? "done" : "idle", yes ? 1300 : 300);
    decide(card, yes, from);
  };

  // ---------- calls ----------
  // A call holds the app's audio session from its ring to its end (system/audio.ts): the microphone is live under the
  // scripted lines, the Chief's answers are said aloud, and with the phone locked or the app in the background it all
  // goes on. It is the conversation out loud the lock screen shows (system/talk.ts), whose Mute and End reach it here
  // even then. Its progress runs on timers, Date.now() and the store's own `watch`, never on a frame, since frames stop
  // in the background.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const after = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
  };
  const callRef = useRef(call);
  callRef.current = call;
  const sentAt = useRef(0);
  /** Which call this is: an answer heard or said after it ended (or a newer one began) is dropped. */
  const callNo = useRef(0);
  /** Lets go of the audio session the call holds. */
  const letGo = useRef<(() => void) | null>(null);
  /** Stops listening to the store for the Chief's answer. */
  const unhear = useRef<(() => void) | null>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  /** This call is the conversation out loud the lock screen shows. */
  const ours = () => {
    const talk = talkNow();
    return talk?.kind === "call" && talk.chief === chief.id;
  };
  /** The call moves on, here and on the lock screen. */
  const toPhase = (phase: CallPhase, patch?: Partial<Call>) => {
    setCall((c0) => c0 && { ...c0, ...patch, phase });
    if (ours() && talkNow()?.state !== CALL_SAYS[phase]) updateTalk({ state: CALL_SAYS[phase] });
  };

  const hearTurn = (turn: number) => {
    const now = callRef.current;
    if (!now) return;
    if (now.muted) {
      after(1000, () => hearTurn(turn));
      return;
    }
    const line = CALL_LINES[turn];
    if (!line) {
      toPhase("listening", { heard: "" });
      return;
    }
    const words = line.split(" ");
    toPhase("hearing", { turn, heard: "" });
    words.forEach((_, i) => after(400 + i * WORD_MS, () => setCall((c0) => c0 && { ...c0, heard: words.slice(0, i + 1).join(" ") })));
    after(400 + words.length * WORD_MS + 800, () => {
      if (!callRef.current) return;
      sentAt.current = Date.now();
      toPhase("waiting", { heard: "" });
      haptic.done();
      hearAnswer(turn);
      script.tellChief(chief.id, line, start);
    });
  };

  // Its answer arrives in its chat; on a call it says it. The store tells the moment it lands (a render waits for a
  // frame, and there are none in the background).
  const hearAnswer = (turn: number) => {
    const no = callNo.current;
    unhear.current?.();
    const check = () => {
      const line = store.get().board.said.findLast((l) => l.chief === chief.id && l.who === "chief" && l.at >= sentAt.current);
      if (!line) return;
      unhear.current?.();
      void sayAnswer(no, turn, line.text);
    };
    const stop = store.watch((next, prev) => {
      if (next.board.said !== prev.board.said) check();
    });
    unhear.current = () => {
      stop();
      unhear.current = null;
    };
    check();
  };
  // It says it aloud, its bubble up and its mouth moving for as long as the saying takes, then a breath, then your next
  // line. Where nothing says it (the web, no voice) the bubble stays as long as it takes to read, as it always did.
  const sayAnswer = async (no: number, turn: number, text: string) => {
    const words = spoken(text, store.get().board.chats);
    setSaying(words);
    toPhase("speaking");
    setTalking(true);
    const began = Date.now();
    const said = await speak(words);
    if (callNo.current !== no || !callRef.current) return;
    const left = (ms: number) => Math.max(0, ms - (Date.now() - began));
    const count = words.split(" ").length;
    if (said) setTalking(false);
    else after(left(Math.max(1400, count * 180)), () => setTalking(false));
    after(said ? AFTER_SAID_MS : left(Math.max(2800, count * 280)), () => {
      setSaying(null);
      hearTurn(turn + 1);
    });
  };

  useEffect(() => {
    if (!call) return;
    const timer = setInterval(() => setClock(Math.floor((Date.now() - call.started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [call?.started]);

  // Mute is yours: the microphone's level reads 0 and your next line waits, while the Chief can still finish talking.
  const muteCall = () => {
    const now = callRef.current;
    if (!now) return;
    const muted = !now.muted;
    callRef.current = { ...now, muted };
    setCall((c0) => c0 && { ...c0, muted });
    setMicMuted(muted);
    if (ours()) updateTalk({ muted });
  };
  const muteOutside = useRef(muteCall);
  muteOutside.current = muteCall;

  const startCall = () => {
    stir();
    setAgents(null);
    setPeekId(null);
    setClock(0);
    // One conversation out loud at a time: voice chat gives way to the call.
    if (voiceChat.get().on) endVoice();
    callNo.current += 1;
    const begun: Call = { started: Date.now(), phase: "ringing", turn: 0, heard: "", muted: false };
    callRef.current = begun;
    setCall(begun);
    letGo.current?.();
    letGo.current = holdAudio("call");
    setMicMuted(false);
    // The lock screen's Mute and End go through the refs, so they reach this call as it is when they're pressed.
    setTalk({ kind: "call", who: chief.name, chief: chief.id, since: begun.started, muted: false, state: CALL_SAYS.ringing }, { mute: () => muteOutside.current(), end: () => endOnLeave.current() });
    setKnock((n) => n + 1);
    after(1700, () => {
      setHop((n) => n + 1);
      hearTurn(0);
    });
  };
  // A call asked for from outside this screen (a Chief's menu) starts as the screen opens.
  useEffect(() => {
    if (callAsk > 0 && !callRef.current) startCall();
  }, [callAsk]);
  const endCall = () => {
    haptic.soft();
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    unhear.current?.();
    callNo.current += 1;
    // Read through the ref: an effect that ends it on leaving holds an older render's `call`.
    const now = callRef.current;
    if (now) script.endCall(chief.id, Math.max(1, Math.floor((Date.now() - now.started) / 1000)));
    callRef.current = null;
    setCall(null);
    setSaying(null);
    setTalking(false);
    if (now) {
      stopSpeaking();
      setMicMuted(false);
    }
    letGo.current?.();
    letGo.current = null;
    if (ours()) clearTalk();
    stir();
  };
  // A call lives on this screen and never runs on behind another. If something else comes over it anyway (Search, a
  // toast's Open, a notification), the call ends there and the shell says so, since you didn't end it yourself; going
  // Back ends it too, its line still kept in the chat. Locking the phone or leaving the app isn't another screen: the
  // screen keeps its focus and the call goes on.
  useEffect(() => {
    if (focused || !callRef.current) return;
    endCall();
    notice({ id: `call-${chief.id}-${Date.now()}`, text: `Call with ${chief.name} ended`, tone: "info", icon: "call" });
  }, [focused]);
  const endOnLeave = useRef(endCall);
  endOnLeave.current = endCall;
  useEffect(() => () => {
    if (callRef.current) endOnLeave.current();
  }, []);

  // ---------- what the character is doing ----------
  let pose: MascotPose = "idle";
  let look: number | undefined;
  if (flash) ({ pose, look } = flash);
  else if (call) {
    if (call.phase === "waiting" && thinking) pose = "thinking";
    else if (call.phase === "hearing" || call.phase === "listening") [pose, look] = ["look", LOOK.up];
  } else if (thinking) pose = "thinking";
  else if (typing || docked) [pose, look] = ["look", LOOK.down];
  else if (asleep) pose = "sleeping";

  // ---------- layout ----------
  const chromeTop = insets.top + BAR_HEIGHT;
  // The box (and the dock) stand 8 over the safe edge, as Composer places it.
  const base = Math.max(insets.bottom, 10);
  // What rides on the box while the Ready card is up: the floating row only when it has something the card doesn't say
  // (what's next, an ask put away, what it's thinking, the way back to the latest).
  const waitingAsk = !docked && !instead && !call && asks[0] ? asks[0] : null;
  const rowUp = !readyUp || !!next || !!waitingAsk || !!thinking || away;
  // The top of what rides on the resting box, from the screen's foot (`boxHeight` is the box with its row). The box
  // opening, rising with the keyboard and growing as you write isn't in it: the chat and the fade ride those with it.
  const rowTop = base + boxHeight;
  // The top of the dock's slot (the ask, or its Undo bar in the card's room), the Chief standing on it.
  const dockTop = base + 8 + dockHeight + STANDS;
  // What stands highest over the foot: the chat's end stays clear of it. On the Ready card the Chief stands on its top.
  const footTop = docked ? dockTop : readyUp && !rowUp ? rowTop + STANDS : rowTop;
  const chatBottom = footTop + 24;
  // The fade under the character rides up with the box, as the chat over it does (shell/composer/place.ts): over the
  // keyboard, the menu or the opened card, no words run behind the sprite either. Under it, down to the screen's foot,
  // it holds its last shade.
  const { height: screenH } = useWindowDimensions();
  const { lift: boxLift } = useChatLift(scope);
  const fadeRides = useAnimatedStyle(() => ({ transform: [{ translateY: -boxLift.value }] }));
  const sheetUp = agents !== null || peekId !== null;
  // The chats the dock and the Ready card show: the chat names them plainly instead of with a second pill.
  const shownIds = useMemo(
    () => [...(docked ? asks.flatMap((a) => [a.row.id, a.chat.id]) : []), ...(readyUp ? readies.map((r) => r.chat.id) : [])],
    [docked, asks, readyUp, readies],
  );
  // Where its chats run, as a chat's capsule says where it runs: the workspaces of exactly the chats it counts, named
  // up to two, else how many; "All workspaces" only when it runs every chat there is.
  const everyChat = useStore((s) => listOf(s, { filter: "all" }).length);
  const workspaces = useMemo(() => [...new Set(rows.map((r) => r.chat.repo))], [rows]);
  const watches =
    rows.length && rows.length === everyChat
      ? "All workspaces"
      : workspaces.length
        ? workspaces.length <= 2
          ? workspaces.join(" · ")
          : `${workspaces.length} workspaces`
        : chief.projects
          ? chief.projects.length === 1
            ? chief.projects[0]!
            : `${chief.projects.length} workspaces`
          : "All workspaces";
  // How you address it in a sentence: "Tell the Chief", "Call Oona".
  const named = chief.id === HOME_CHIEF ? "the Chief" : chief.name;
  const callLabel = call ? (call.phase === "ringing" ? `Calling ${chief.name}…` : `${chief.name} · ${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, "0")}`) : "";
  const quiet = (
    <View style={{ alignItems: "center", gap: 10, paddingBottom: 24 }}>
      <Sprite character={chief.character} tone={chief.tone} pose="sleeping" size={48} label={`${chief.name}, resting`} />
      <Text style={[t.body, { fontSize: 15, color: c.muted, textAlign: "center" }]}>{`All quiet. Tell ${named} what needs doing.`}</Text>
    </View>
  );
  const perch = <Perch chief={chief} pose={pose} look={look} saying={saying} talking={talking} hop={hop} knock={knock} />;

  return (
    <View style={{ flex: 1 }} {...(next ? { onTouchEnd: () => setTimeout(dropNext, 0), onPointerUp: () => setTimeout(dropNext, 0) } : null)}>
      <ChiefChat
        said={said}
        chats={chats}
        thinking={thinking}
        scope={scope}
        onOpen={onOpen}
        onPeek={setPeekId}
        top={chromeTop + 12}
        bottom={chatBottom}
 // On a call the chat stays readable behind the call, half strength,
        // a step further back while the Chief shows you a change; it takes no touches, so a tap meant for the call
        // never opens a chat.
        dim={call ? (showing ? 0.25 : 0.5) : 1}
        jump={jump}
        onAway={setAway}
        docked={shownIds}
        frozen={sheetUp}
        empty={quiet}
        edgeY={edgeY}
      />

      {/* The chat dims away under the character and its row, which aren't glass: no words run behind the sprite. */}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, right: 0, bottom: -screenH, height: footTop + FADE + screenH }, fadeRides]}>
        <LinearGradient
          colors={[alpha(c.panel, 0), c.panel, c.panel, alpha(c.panel, dark ? 0.7 : 0.6)]}
          locations={[0, FADE / (footTop + FADE), (FADE + ROW + 10) / (footTop + FADE), 1]}
          style={{ height: footTop + FADE }}
        />
        <View style={{ flex: 1, backgroundColor: alpha(c.panel, dark ? 0.7 : 0.6) }} />
      </Animated.View>

      {call ? (
        <Stage
          caption={call.phase === "hearing" ? call.heard : call.phase === "listening" ? "Listening" : call.muted ? "Muted" : ""}
          quiet={call.phase !== "hearing"}
          showing={showing}
          top={chromeTop}
          bottom={rowTop + 60}
        />
      ) : null}

      <TopBar
        root={root}
        onBack={onBack}
        scrollY={edgeY}
        waiting={waiting}
        title={chief.name}
        subtitle={watches}
        mark={<Sprite character={chief.character} tone={chief.tone} pose={thinking ? "working" : "idle"} size={24} animate={!!thinking} />}
        right={
          shell.split ? (
            <BarGroup>
              <GlassButton icon={shell.inspector ? "panelClose" : "panel"} label={shell.inspector ? "Close its agents" : "Its agents"} selected={shell.inspector} onPress={() => shell.setInspector(!shell.inspector)} />
              {root && (shell.rail || !shell.sidebar) ? <GlassButton icon="compose" label="New chat" onPress={onNewChat} /> : null}
            </BarGroup>
          ) : root ? (
            <GlassButton icon="compose" label="New chat" onPress={onNewChat} />
          ) : undefined
        }
        menu={{
          entries: [
            { label: "Show its agents", icon: "checklist", onPress: () => setAgents("all") },
            { label: `Call ${named}`, icon: "call", disabled: !!call, onPress: startCall },
            // The other Chiefs, each by its character with what waits on you there: one tap from one board to the next.
            ...(onSwitch && chiefs.length > 1
              ? [
                  { type: "separator" as const },
                  ...chiefs
                    .filter((r) => r.chief.id !== chief.id)
                    .map((r) => ({
                      label: r.chief.name,
                      icon: <Sprite character={r.chief.character} tone={r.chief.tone} size={24} animate={false} />,
                      value: r.needs ? `${r.needs} ${r.needs === 1 ? "needs" : "need"} you` : r.working ? `${r.working} working` : undefined,
                      onPress: () => onSwitch(r.chief.id),
                    })),
                ]
              : []),
            { type: "separator" },
            { label: "New chat", icon: "compose", onPress: onNewChat },
            ...(onSettings ? [{ label: `${chief.name} settings`, icon: "settings" as const, onPress: onSettings }] : []),
          ],
        }}
      />

      {docked ? (
        <AskDock
          asks={asks}
          bottom={base + 8}
          perch={perch}
          onDecide={(card, yes) => answer(card, yes, "ask")}
          onInstead={(card) => {
            typed.current = false;
            setInstead(card);
            setFocusAsk((n) => n + 1);
          }}
          onStow={() => {
            haptic.soft();
            setStowed(true);
          }}
          onOpen={(card) => onOpen(card.chat.id)}
          onPeek={(card) => setPeekId(card.row.id)}
          onShown={onShown}
          onHeight={setDockHeight}
        />
      ) : (
        <Composer
          key={`chief-${chief.id}`}
          draft={scope}
          placeholder={`Ask ${chief.id === HOME_CHIEF ? "the Chief" : chief.name}…`}
          speech="What needs me?"
          onSend={(text, images) => {
            stir();
            setAway(false);
            // From "Tell it what to do instead": the ask is turned down, and what you said steers that chat.
            if (instead) {
              // Your words are the answer, as a card's own field gives it, its Undo in the toast.
              if (!answerAsk(instead.chat.id, { kind: "deny", instead: text })) script.deny(instead.chat.id, text);
              setInstead(null);
            } else {
              // What it starts runs on its own model once you've picked one (the chip), else on the new chat's.
              script.tellChief(chief.id, text, { ...start, ...getChiefPick(chief.id) }, images);
            }
          }}
          chiefModel={chief.id}
          // Its `+` names its own chats; its settings are the desktop's ChiefBoxSettings: Permissions, the projects it
          // works in, then its own settings.
          chats={rows.map((r) => r.chat)}
          settingsAfter={
            onSettings
              ? [
                  { label: "Projects", value: chief.projects ? (chief.projects.length === 1 ? chief.projects[0] : `${chief.projects.length} projects`) : "Every project", onPress: onSettings },
                  { type: "separator" },
                  { label: `${chief.name} settings…`, onPress: onSettings },
                ]
              : undefined
          }
          onTyping={(on) => {
            if (on) {
              stir();
              typed.current = true;
            } else if (instead && typed.current && !getDraft(scope).trim()) setInstead(null);
            setTyping(on);
            if (on) dropNext();
          }}
          onHeight={setBoxHeight}
          focusAsk={instead ? focusAsk : 0}
          above={
            call ? null : (
              <View pointerEvents="box-none">
                {rowUp ? (
                  <View pointerEvents="box-none" style={readyUp ? { marginBottom: 10 } : null}>
                    <AgentsRow
                      counts={counts}
                      quiet={readyUp}
                      waiting={waitingAsk ? { name: askedBy(waitingAsk), onPress: () => setStowed(false) } : null}
                      instead={instead ? { name: instead.chat.id === instead.row.id ? instead.row.title : askedBy(instead), onCancel: () => setInstead(null) } : null}
                      thought={thinking}
                      next={
                        next && onNext
                          ? {
                              question: next.question,
                              index: 1,
                              total: next.total,
                              onPress: () => {
                                // It hears no tap in its first moments: that is the thumb that answered.
                                if (Date.now() - nextAt.current < NEXT_ARM_MS) return;
                                stir();
                                setNext(null);
                                onNext({ chief: next.chief, chat: next.chat });
                              },
                            }
                          : null
                      }
                      away={away}
                      onAgents={() => {
                        stir();
                        setAgents("all");
                      }}
                      onJump={() => setJump((n) => n + 1)}
                    />
                  </View>
                ) : null}
                {readyUp ? (
                  <ReadyCard
                    cards={readies}
                    perch={perch}
                    onDecide={(card, yes) => answer(card, yes, "ready")}
                    onOpen={(card) => onReview(card.chat.id)}
                  />
                ) : null}
              </View>
            )
          }
          perch={readyUp ? undefined : perch}
          call={{
            who: named,
            active: !!call,
            label: callLabel,
            muted: call?.muted ?? false,
            onStart: startCall,
            onMute: muteCall,
            onEnd: endCall,
          }}
        />
      )}

      {shell.split ? (
        <InspectorFill title={agentsTitle(chief)} active={focused}>
          <AgentsList rows={rows} chats={chats} filter="all" pending={pending} onPeek={onOpen} onDecide={(card, yes) => answer(card, yes, "sheet")} />
        </InspectorFill>
      ) : null}
      <AgentsSheet
        open={agents !== null && !shell.split}
        onClose={() => setSheetAgents(null)}
        chief={chief}
        rows={rows}
        chats={chats}
        filter={agents ?? "all"}
        pending={pending}
        onOpen={(id) => {
          setAgents(null);
          onOpen(id);
        }}
        onDecide={(card, yes) => answer(card, yes, "sheet")}
      />

      <Peek
        chat={peeked}
        chats={chats}
        number={peeked ? workId(peeked, rows.map((r) => r.chat)) : undefined}
        pending={pending}
        onClose={() => setPeekId(null)}
        onOpen={(id) => {
          setAgents(null);
          onOpen(id);
        }}
        onDecide={(card, yes) => answer(card, yes, "peek")}
      />
    </View>
  );
}

/**
 * The Chief's screen on the stack: its id from the route, and what a chat it starts runs on (the new chat's pick and
 * where new chats run). Its compose circle and its menu's New chat make a new chat the main panel's root.
 */
export function ChiefRoute({ route, navigation }: ScreenProps<"Chief">) {
  const { id, call } = route.params;
  const chief = chiefById(id);
  const fallback = useDefaultPick();
  const pick = useUi((s) => s.pick) ?? fallback;
  const repo = useUi((s) => s.where.repo);
  const waiting = useStore((s) => listOf(s, { filter: "needs" }).filter((r) => r.chief !== chief.id).length);
  const root = useIsRoot();
  return (
    <ChiefScreen
      key={chief.id}
      chief={chief}
      start={{ ...pick, repo }}
      waiting={waiting}
      root={root}
      onBack={() => navigation.goBack()}
      onNewChat={showNewChat}
      onOpen={openChat}
      onReview={review}
      onSettings={() => openSettings("chief")}
      callAsk={call ?? 0}
      // In this one's place, through the stack's rule (nav/moves.ts): a Chief or chat already under it is gone back to.
      onSwitch={(next) => openChief(next, { inPlace: true })}
      onNext={(to) => (to.chief ? openChief(to.chief, { inPlace: true }) : openChat(to.chat, { inPlace: true }))}
    />
  );
}
