// The box at the foot of every screen, one component for all of them (docs/ Home
// 7 and 8, Thread "Composer"; the founder's Cursor shots 5339, 5340, 5345, 5346, 5354). Its variants are the screens'
// boxes: Home's (and a list's, a workspace's), which starts a chat; a chat's, which follows up and steers; a
// subagent's, which has no voice chat; and a Chief's, whose round button calls it and whose model chip says what it
// starts its chats on.
//
// At rest it is a 56pt glass capsule 8pt above the home indicator: `+`, the field's one line, the mic and the round
// button. Focused, it grows in place into a card of the same width and corner, 12pt over the keyboard: a grabber
// (drag it up and the card stands as tall as the screen allows, for a long message; down, it comes back, and down again
// puts the box away; it takes a finger from a little over the card's edge down to the field, "its
// very hard to grab the top handle of the chat box when typing to expand it"), where a new chat runs (ContextRow), the
// field, attachments, and a toolbar of `+`,
// the model, the mic and the round button. Height grows on the morph spring and the controls never move: `+`, the mic
// and the round button sit 10pt in from the bottom corners in both shapes, so only the field travels. On Home the
// screen dims behind the card; in a chat it doesn't, so the work stays in view.
//
// At rest a draft shows whole, up to three lines, then "…", so a half-written steer never reads as finished; the
// capsule grows up for it and the controls stay at its foot. Pressing it puts the caret at the end. In a chat, what's
// queued behind the turn is the box's own first row, over a hairline, one glass with it (composer/Queue.tsx).
//
// In a chat the keyboard leaves little room, so the card there is only as tall as what it holds (one line and the
// toolbar, about 110), and while it's up what rides on the box (the floating row: the Working capsule, the jump
// circle) steps away; it comes back when the keyboard goes. The queued row folds into a "2 queued" chip in the toolbar
// that opens it inside the card, and stop stays the round button.
//
// The round button is a small state machine (composer/state.ts): voice chat while empty, send once there are words,
// steer while a turn runs (held, or through VoiceOver, it queues for after the turn instead, or stops), stop while a
// turn runs and the field is empty, and a neutral beat after each send so a double tap never stops what it started.
// The mic dictates: the mic and the round button fold into a ✕ and a timer pill, the words being heard show in italic
// grey in the field, and the field stays yours to type in (composer/Dictation.tsx). When it ends with words, the card
// stays open on them with the caret at their end, to read and correct before sending (Cursor, Codex); it folds only on
// blur, send or ✕. Voice chat is the app's session; the
// box grows into its bar in place, one glass piece, and hang-up gives the box back (composer/VoiceBar.tsx, voice.ts), so
// it carries on into the chat a spoken ask starts.
//
// `+` opens its menu in the keyboard's place (composer/ContextPanel.tsx, place.ts): it rises at the keyboard's own
// height and the box rides on it as on the keyboard, so the chat over the box lifts the same way and stays in view.
// With the keyboard up the menu is already standing under it as it goes, and handing back to the keyboard it holds its
// place until the keyboard is all the way up, so swapping the one for the other moves nothing. While it is up `+`
// turns into its ✕.
//
// The chat over the box moves with it as one (place.ts). The box on the focused screen works out on the UI thread, every
// frame, how far its top stands over where it rests (the keyboard or the menu under it, the card opening and growing a
// line as you write, never the card pulled tall, which covers the chat) and hands that to its own chat, which rides it
// with a transform. What it tells the screen (`onHeight`, `onEdge`) is where it rests, so the room at the chat's foot
// stays put while you write; only what stays at rest changes it (a queued follow-up's row, what rides on the box).
//
// What isn't drawn isn't there: the card's grabber, toolbar chips and Home's dimming are hidden from VoiceOver while
// the box is at rest, and on the web `inert` as well, so Tab never lands on them; they come back as it opens. On the web
// a mousedown on the box's own controls never takes the focus from the field, so the card can't fold under the pointer
// before the click lands.
//
// The field keeps one place in the tree whatever the box is doing, so it never loses the keyboard mid-word. Liquid Glass
// renders wrong under opacity, so nothing fades the glass or what holds it; only what sits on it fades.
import { useIsFocused } from "@react-navigation/native";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type HostInstance, Keyboard, Platform, Pressable, StyleSheet, type TextInputInstance, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, type SharedValue, useAnimatedKeyboard, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import type { Device, SentImage } from "../board/model";
import * as script from "../board/script";
import { Glass } from "../components/Glass";
import { BottomEdge, EDGE } from "../components/ProgressiveEdge";
import { PixelIcon } from "../components/Pixel";
import { type Anchor, Menu, type MenuEntry, useAnchor } from "../components/ui/Menu";
import { duration, ease, haptic, morph, release } from "../motion";
import { chatOf } from "../store/select";
import { chiefScope, getDraft, NEW_CHAT, type Queued, setBoxAccess, useDraft, useQueue } from "../store/sessions";
import { useStore } from "../store/store";
import { alpha, layout, useFontScale, useTheme } from "../theme";
import { pickPhotos, takePhoto } from "../photos/pick";
import { PhotoViewer } from "../photos/Viewer";
import { AttachmentStrip } from "./composer/Thumbs";
import { attach, clearAttached, fromSent, toSent, useAttached } from "./composer/attached";
import { ContextRow } from "./composer/ContextRow";
import { ContextPanel } from "./composer/ContextPanel";
import { type CircleAction, MicButton, ModeChip, ModelChip, PlusButton, PrimaryButton } from "./composer/Controls";
import { DictationPill } from "./composer/Dictation";
import { Field, FIELD, FIELD_SCALE } from "./composer/Field";
import { QueueChip, QueueRow, QueueTray, trayHeight } from "./composer/Queue";
import { useHearing } from "./composer/hearing";
import { fieldFocus, lastKeyboard, useKeyboardState, WEB_KEYBOARD } from "./composer/keyboard";
import { claimLift, clearRise, liftOf, menuHeight, onPutMenuAway, PLACE_MS, releaseLift, riseOf, setRise } from "./composer/place";
import { type Access, type Attach, type ChatRef, GOAL, type Mode, settingsEntries } from "./composer/menus";
import { BOX, cardHeight, type Primary, primaryLabel, resolvePlaceholder, resolvePrimary, SETTLE_MS, type Variant } from "./composer/state";
import { CallRow, VoiceRow } from "./composer/VoiceBar";
import { useVoiceChat, type VoiceReport } from "./composer/useVoiceChat";
import { endVoice, startVoice, toggleMute } from "./composer/voice";
import { useSettings } from "./settings/store";
import { slow } from "./sheetMotion";
import { triggerOf, useChiefPick } from "./Sheets";
import { openModel, openSettings, tookBoxFocus, useUi } from "./ui";
import { usePane } from "./layout";

export type { ChatRef, Mode } from "./composer/menus";
export type Voice = VoiceReport;
export type { Variant } from "./composer/state";

/** The box at rest from the home indicator's safe edge to its top: the 56pt capsule, 8pt up. */
export const COMPOSER_HEIGHT = BOX.rest + BOX.lift;
/** What a screen leaves clear under its content for the box, above the safe edge. */
export const COMPOSER_ROOM = COMPOSER_HEIGHT + 24;
/** A Chief's box: the same capsule as every other (it once had its own one-line shape). */
export const COMPOSER_LINE_HEIGHT = COMPOSER_HEIGHT;

/** Where a new chat runs, for the card's context row. */
export interface WhereRow {
  repo: string;
  branch: string;
  device: Device;
  /** Opens the Where sheet, leading with the projects (the workspace's chip) or the computers (the computer's). */
  onPress: (focus?: "repo" | "computer") => void;
  /** The screen's own workspace: only the computer changes. */
  fixed?: boolean;
}

interface Props {
  /** A new chat's ask ("Start a chat in marketing"); a chat's and a Chief's box say their own (composer/state.ts). */
  placeholder: string;
  /** What the prototype hears when you dictate or talk. */
  speech: string;
  /**
   * What you sent: the words (empty when it is pictures alone) and the pictures attached, in the order attached (none
   * from voice chat). A screen that sends words only may leave `images` off.
   */
  onSend: (text: string, images?: readonly SentImage[]) => void;
  /** Which box this is; by default read from `draft` and `call` (a chat with a parent is a subagent's). */
  variant?: Variant;
  /** Dim the screen behind the focused card (Home and the lists do; a chat doesn't). Defaults to a new chat's box. */
  dim?: boolean;
  /** Where a new chat runs, shown at the card's top. */
  where?: WhereRow;
  /** The screen's mode (Plan, Grill me, Goal), when the screen keeps it; a Chief's box has none. */
  mode?: Mode | null;
  onClearMode?: () => void;
  /** `+` turns a mode on or off. Without it the box keeps its mode itself and lets a goal go when it sends. */
  onMode?: (mode: Mode | null) => void;
  /**
   * `+`'s Files. Without it the board says they come with a runtime. Photos and Camera are the box's own: the system's
   * picker and the camera attach to it (photos/pick.ts).
   */
  onFiles?: (kind: Attach) => void;
  /** Kept for the screens that still pass it; recording a skill lives on the desktop. */
  onSkill?: () => void;
  /** Chats `+` offers to name. */
  chats?: readonly ChatRef[];
  /** The chat this box belongs to, left out of those. */
  self?: string;
  /**
   * Where the words in the box are kept: a chat's id, "new", "workspace:<name>" or "chief:<id>" (store/sessions.ts).
   * They wait there when you leave and come back, a relaunch included; a chat's queue is kept with it and sent when its
   * turn ends, whether or not the chat is open. Attachments are kept by the same scope.
   */
  draft?: string;
  /** The model this chat runs on, as the card's model chip; pressing it opens the picker. */
  model?: { engine: string; model: string; label?: string; effort?: string; fast?: "fast" | "fastest"; accessibilityLabel?: string; onPress: () => void };
  /**
   * A Chief's box: the Chief whose model the chip shows, what it starts its chats on (Sheets.tsx useChiefPick); the chip
   * opens the model sheet for that Chief.
   */
  chiefModel?: string;
  /** The chat's settings above Permissions, in the `+` menu. */
  settings?: readonly MenuEntry[];
  /** The chat's settings under Permissions (a Chief's projects, a rule, then its own settings). */
  settingsAfter?: readonly MenuEntry[];
  /** A turn is running: words steer it, the empty box's round button stops it, a hold queues for after. */
  running?: boolean;
  onStop?: () => void;
  /** What rides on the box, 10pt over its top edge and moving with it: a chat's floating row, a Chief's character. */
  above?: ReactNode;
  /** No longer drawn: voice chat is a bar over the box on every screen. */
  orb?: boolean;
  /** Bump to start voice chat from outside. */
  voiceAsk?: number;
  /** Bump to put the caret in the field from outside (a chat's "Tell it what to do instead"). */
  focusAsk?: number;
  onVoice?: (voice: Voice) => void;
  /** What sits on the box's top edge, at the left: a Chief's character and its bubbles. */
  perch?: ReactNode;
  /** A Chief's box: the round button calls, and while a call is on the box shows it. */
  call?: Call;
  /** Told when you start writing (the field takes the keyboard, or holds words) and when you stop. */
  onTyping?: (typing: boolean) => void;
  /**
   * Told how tall the box stands above the home indicator's safe edge at rest, with what rides on it then (`above`):
   * what floats over the box rests on it, and a chat's end stays clear of it. It holds still as the box opens, rises
   * with the keyboard and grows while you write; its own chat rides those with it instead (place.ts claimLift).
   */
  onHeight?: (height: number) => void;
  /** Told how far over the screen's foot the band behind the resting box begins (its top plus its reach). */
  onEdge?: (band: number) => void;
  /**
   * Where the page's last real line is, from the screen's top (ProgressiveEdge useContentEnd): the band behind the box
   * shows only while content runs under it. Without it the band is always whole (a chat keeps its own).
   */
  contentEnd?: SharedValue<number>;
}

export interface Call {
  /** Who picks up: "the Chief", "Oona". */
  who: string;
  active: boolean;
  /** "Calling…", then the call's clock. */
  label: string;
  muted: boolean;
  onStart: () => void;
  onMute: () => void;
  onEnd: () => void;
}

/** Words joined the way a person adds to what they wrote: one space between. */
const join = (a: string, b: string) => (a && b ? `${a.replace(/\s+$/, "")} ${b}` : a || b);

const WEB = Platform.OS === "web";
/**
 * The keyboard's height on the UI thread. A browser has no keyboard to rise over, so on the web it is the stand-in
 * development can raise (composer/keyboard.ts: `__cc.keyboard.show()`, or `?keyboard` to follow the field).
 */
const WEB_KEYS = WEB_KEYBOARD;
const useKeyboard = WEB_KEYS ? () => WEB_KEYS : useAnimatedKeyboard;
/** The menu rises and falls on the keyboard's curve (in development `__cc.ui.slow(8)` slows it with the sheets). */
const PLACE_EASE = Easing.bezier(0.2, 0.8, 0.2, 1);

/** A pulled-tall card's top stands this far under the status bar. */
const TALL_GAP = 12;
/** The grabber's grip reaches this far over the card's top edge, so a thumb doesn't have to land on the bar itself. */
const GRIP_OVER = 14;
/** How far a drag on the grabber goes, or how fast, before it decides: taller, back, or away. */
const PULL = 40;
const FLING = 600;
/** Past where it can go, the card follows the finger less and less, never more than this. */
const GIVE = 40;

/**
 * How much taller a drag on the grabber makes the card (less than 0: shorter). Up, a card follows the finger to its
 * tallest and gives a little past it; down, a tall card comes down with the finger (a card that isn't tall moves down
 * whole instead, toward put away).
 */
function grownBy(drag: number, card: number, reach: number, tall: boolean): number {
  "worklet";
  if (drag >= 0) return tall ? -Math.min(drag, Math.max(0, card - 120)) : 0;
  const up = -drag;
  const room = Math.max(0, reach - card);
  if (up <= room) return up;
  return room + (1 - 1 / (((up - room) * 0.55) / GIVE + 1)) * GIVE;
}

/**
 * On the web, what the box hides is `inert` too: aria-hidden alone left its buttons in the tab order. Set after every
 * render, so a group that mounts later is caught; elsewhere VoiceOver's hiding is enough.
 */
type Attrs = { setAttribute?: (name: string, value: string) => void; removeAttribute?: (name: string) => void };
function useInert(hidden: boolean) {
  const ref = useRef<HostInstance>(null);
  useEffect(() => {
    const el = ref.current as unknown as Attrs | null;
    if (!WEB || !el) return;
    if (hidden) el.setAttribute?.("inert", "");
    else el.removeAttribute?.("inert");
  });
  return ref;
}

/** On the web a mousedown on the box's own controls keeps the focus in the field (the field's own mousedown is left be). */
const keepFocus = WEB
  ? ({
      onMouseDown: (e: { target: unknown; preventDefault: () => void }) => {
        const at = e.target as { closest?: (selector: string) => unknown };
        if (!at.closest?.("textarea, input")) e.preventDefault();
      },
    } as object)
  : null;

/** A neutral beat after a send: true for SETTLE_MS, then false. */
function useSettle(): [boolean, () => void] {
  const [until, setUntil] = useState(0);
  useEffect(() => {
    if (!until) return;
    const id = setTimeout(() => setUntil(0), Math.max(0, until - Date.now()));
    return () => clearTimeout(id);
  }, [until]);
  return [until > 0, () => setUntil(Date.now() + SETTLE_MS)];
}

export function Composer(props: Props) {
  const { placeholder, speech, onSend, mode = null, onClearMode, onMode, onFiles, chats = [], self, draft, model, settings, settingsAfter, running = false, onStop, above, voiceAsk = 0, onVoice, perch, call, onTyping, onHeight, where } = props;
  const { c, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = usePane();
  const fontScale = useFontScale();
  // The field's line grows with Dynamic Type, up to half again (FIELD_SCALE), and the box keeps it whole at rest.
  const line = Math.round(BOX.line * Math.min(Math.max(fontScale, 1), FIELD_SCALE));
  const keyboard = useKeyboard();
  const input = useRef<TextInputInstance>(null);
  const here = useIsFocused();

  // ---------- the model chip: the chat's, a new chat's, or what a Chief starts its chats on ----------
  const chiefId = props.chiefModel;
  const chiefPick = useChiefPick(chiefId);
  const chip = model ?? (chiefId ? { ...triggerOf(chiefPick), onPress: () => openModel(chiefScope(chiefId)) } : undefined);

  // ---------- which box ----------
  const isChild = useStore((s) => !!(draft && chatOf(s, draft)?.parent));
  const variant: Variant = props.variant ?? (call ? "chief" : !draft || draft === NEW_CHAT || draft.startsWith("workspace:") ? "new" : isChild ? "subagent" : "thread");
  const chief = variant === "chief";
  const dims = props.dim ?? variant === "new";
  const scope = draft ?? "own";

  // ---------- words ----------
  const [ownText, setOwnText] = useState("");
  const [keptText, setKeptText] = useDraft(draft ?? "");
  const text = draft ? keptText : ownText;
  const setText = draft ? setKeptText : setOwnText;
  const attached = useAttached(scope);

  // The mode is the screen's when it hands the box `onMode`, else the box's own.
  const [ownMode, setOwnMode] = useState<Mode | null>(null);
  const current = onMode ? mode : (ownMode ?? mode);
  const setMode = (next: Mode | null) => {
    if (onMode) onMode(next);
    else setOwnMode(next);
    if (!next) onClearMode?.();
  };

  // ---------- focus, and what holds the card open ----------
  const [focused, setFocused] = useState(false);
  const [context, setContext] = useState(false);
  const [pinned, setPinned] = useState(false);
  // The menu in the keyboard's place (composer/ContextPanel.tsx): how far it has risen on the UI thread (the box rides
  // on that and the keyboard alike), how tall it stands, whether it is drawn (up, or on its way down), and whether it is
  // handing back to the keyboard, holding its place until the keyboard stands over it.
  const keys = useKeyboardState();
  const menu = useSharedValue(0);
  const [menuH, setMenuH] = useState(() => menuHeight(lastKeyboard(), screenH));
  const [menuDrawn, setMenuDrawn] = useState(false);
  const [handing, setHanding] = useState(false);
  // Dictation just ended with words: the card holds open until the field takes the focus back (blur, send or ✕ fold it).
  const [held, setHeld] = useState(false);
  // Pulled up by its grabber: the card stands as tall as the screen allows until it is pulled back, sent or put away.
  const [tall, setTall] = useState(false);
  // Photos or Camera is up over the app (the system's picker), or an attachment is being seen whole (photos/Viewer.tsx):
  // the card holds open, the keyboard down, and the field takes the keyboard back when it's done.
  const [picking, setPicking] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const refocus = useRef(false);
  const blurredAt = useRef(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sheet = useUi((s) => s.sheet);

  // ---------- dictation ----------
  const [dictating, setDictating] = useState<number | null>(null);
  const dictation = useHearing(speech, dictating !== null, (said) => {
    setText((now) => join(now, said));
    setDictating(null);
    keepOpen();
  });
  const heard = dictating !== null ? dictation.heard : "";

  // ---------- voice chat (the app's session; the box on the focused screen listens) ----------
  const voice = useVoiceChat({ speech, listens: here && !chief, onSend, ask: voiceAsk, onVoice });

  const callActive = !!call?.active;
  // Voice chat is drawn in the box on the focused screen (a Chief's box calls instead).
  const voiceBar = voice.on && here && !chief;
  const talking = callActive || voiceBar;
  // Handing the menu back to the keyboard, the card stays open over the beat before the field has the focus again.
  const open = !talking && (focused || dictating !== null || context || pinned || held || handing || picking || (viewing !== null && attached.length > 0));
  const empty = !join(text, heard).trim() && !attached.length;
  // A sheet opened from the card (the model, Where) or the menu in the keyboard's place holds it open and you are still
  // writing; the field takes the keyboard back a beat after either goes, so a stop is told only once it has lasted,
  // never in that gap (a Chief would dock its ask again under you).
  const writing = focused || pinned || context || handing || picking || !empty;
  const typing = useRef(onTyping);
  typing.current = onTyping;
  useEffect(() => {
    if (writing) {
      typing.current?.(true);
      return;
    }
    const id = setTimeout(() => typing.current?.(false), 150);
    return () => clearTimeout(id);
  }, [writing]);

  // ---------- the round button ----------
  const [settling, settle] = useSettle();
  const primary = resolvePrimary({ empty, running, settling, variant, voiceOn: voice.on });
  const who = call?.who;

  // ---------- the queue (kept with the chat; the script sends it as the turn ends) ----------
  const inChat = variant === "thread" || variant === "subagent";
  const chatScope = inChat ? (draft ?? "") : "";
  const kept = useQueue(chatScope);
  const queued = kept.queued;
  // With the keyboard up in a chat, what rides on the box steps away and the queue is a chip in the card.
  const tucked = open && inChat;
  const [trayOpen, setTrayOpen] = useState(false);
  const tray = tucked && trayOpen ? trayHeight(queued.length) : 0;
  useEffect(() => {
    if (!tucked || !queued.length) setTrayOpen(false);
  }, [tucked, queued.length]);

  const send = (later = false) => {
    // The draft as the store has it, whatever the focus did on the way to this press.
    const words = join(draft ? getDraft(draft) : text, heard).trim();
    // The pictures go with the words, in the order attached; pictures alone go with no words at all.
    const images = toSent(attached);
    if (!words && !images.length) return;
    haptic.thud();
    setDictating(null);
    setHeld(false);
    if (later && chatScope) kept.add(words, images);
    else onSend(words, images);
    setText("");
    setTall(false);
    clearAttached(scope);
    // A goal is set by what's sent; Plan and Grill me hold until they're left.
    if (current?.icon === GOAL.icon) setMode(null);
    if (variant === "new") {
      // Sending pushes the new chat: the keyboard goes with this box.
      input.current?.blur();
      Keyboard.dismiss();
    } else if (!later) settle();
  };

  // ---------- the hold menu: steer, queue, stop ----------
  const sender = useAnchor();
  const [holdAt, setHoldAt] = useState<Anchor | null | "closed">("closed");
  const hold = () => {
    haptic.thud();
    void sender.measure().then(setHoldAt);
  };
  const holdEntries: MenuEntry[] = [
    { label: "Steer now", description: "It reads this before its next step", under: true, icon: "send", onPress: () => send() },
    { label: "Queue for after this turn", description: "Sends when this turn finishes", under: true, icon: <PixelIcon name="state-queued" ink={c.muted} />, onPress: () => send(true) },
    ...(onStop ? ([{ type: "separator" }, { label: "Stop the turn", icon: "stop", onPress: () => onStop() }] as MenuEntry[]) : []),
  ];
  const steerActions: CircleAction[] = [
    { name: "queue", label: "Queue for after this turn", run: () => send(true) },
    ...(onStop ? [{ name: "stop", label: "Stop the turn", run: () => onStop() }] : []),
  ];
  const pressPrimary = () => {
    switch (primary) {
      case "voice":
        haptic.thud();
        setDictating(null);
        startVoice();
        return;
      case "call":
        haptic.thud();
        call?.onStart();
        return;
      case "stop":
        haptic.thud();
        onStop?.();
        settle();
        return;
      case "send":
      case "steer":
        send();
        return;
      default:
        return;
    }
  };

  // ---------- focus handling ----------
  const focusField = () => setTimeout(() => input.current?.focus(), 60);
  const textNow = useRef(text);
  textNow.current = text;
  /** The caret into the field at the end of what's there: a press on the resting box, words just dictated. */
  const focusAtEnd = (after = 60) =>
    setTimeout(() => {
      const field = input.current as (TextInputInstance & { value?: string; setSelectionRange?: (start: number, end: number) => void }) | null;
      if (!field) return;
      field.focus();
      const end = (WEB ? field.value?.length : undefined) ?? textNow.current.length;
      if (WEB) field.setSelectionRange?.(end, end);
      else field.setSelection?.(end, end);
    }, after);
  /** Dictation ended with words: the card stays open on them, the caret at their end. */
  const keepOpen = () => {
    setHeld(true);
    focusAtEnd();
  };
  const focusAsk = props.focusAsk ?? 0;
  useEffect(() => {
    if (focusAsk > 0) focusField();
  }, [focusAsk]);
  // The keyboard leaves with its screen: a chat opened over this one (a link tapped with the keyboard up) never sits
  // on a keyboard that types into this field.
  useEffect(() => {
    if (here || !(focused || input.current?.isFocused())) return;
    input.current?.blur();
    Keyboard.dismiss();
  }, [here]);
  const hadFocus = () => focused || Date.now() - blurredAt.current < 400;
  const putAway = () => {
    if (dictating !== null) setText((now) => join(now, heard));
    setDictating(null);
    setPinned(false);
    setHeld(false);
    setPicking(false);
    if (context) {
      setContext(false);
      refocus.current = false;
      lowerMenu();
    }
    input.current?.blur();
    Keyboard.dismiss();
  };
  // A sheet opened from the card holds it open, keyboard down; when the sheet goes, the field takes the keyboard back.
  const fromCard = (openSheet: () => void) => {
    refocus.current = hadFocus();
    setPinned(true);
    Keyboard.dismiss();
    openSheet();
  };
  // A pick in a sheet opened from the card (a project or a computer in Where) hands you back to the box, the keyboard
  // up (ui.ts focusBox): as the sheet goes, the field takes the keyboard back, in the menu's place if the menu was up.
  const boxAsk = useUi((s) => s.boxFocus);
  const lastBoxAsk = useRef(boxAsk);
  useEffect(() => {
    if (boxAsk === lastBoxAsk.current) return;
    lastBoxAsk.current = boxAsk;
    if (!here) return;
    refocus.current = true;
    if (context) {
      setContext(false);
      setHanding(true);
    }
    if (!pinned) focusField();
  }, [boxAsk]);
  // This box asked for by its scope (ui.ts focusBoxOf: Share to Caveman put its words here and brought you to it): once
  // its screen is on top it takes the keyboard, the caret after what came, a beat after the sheet that asked has gone
  // (240ms, Sheet.tsx), so the one goes down before the other comes up.
  const boxFor = useUi((s) => s.boxFor);
  useEffect(() => {
    if (!here || !draft || boxFor !== draft) return;
    tookBoxFocus();
    focusAtEnd(300);
  }, [boxFor, here, draft]);
  useEffect(() => {
    if (sheet || !pinned || context) return;
    setPinned(false);
    if (refocus.current) focusField();
    refocus.current = false;
  }, [sheet, pinned, context]);

  /** The menu down to the screen's foot, the box riding down with it, and no longer drawn once it is there. */
  const lowerMenu = () => {
    setHanding(false);
    menu.value = withTiming(0, { duration: slow(PLACE_MS), easing: PLACE_EASE }, (done) => {
      if (done) scheduleOnRN(setMenuDrawn, false);
    });
  };
  const openContext = () => {
    refocus.current = hadFocus();
    // With the keyboard up the menu takes its exact height and stands under it at once, so the keyboard going shows it
    // and nothing moves; from rest it rises as the keyboard would, at the keyboard's last height.
    const swapping = keys.target > 0;
    const h = menuHeight(swapping ? keys.target : lastKeyboard(), screenH);
    setMenuH(h);
    setMenuDrawn(true);
    setHanding(false);
    menu.value = swapping ? h : withTiming(h, { duration: slow(PLACE_MS), easing: PLACE_EASE });
    Keyboard.dismiss();
    setContext(true);
  };
  const closeContext = () => {
    setContext(false);
    // Back to the keyboard if it was up: the menu holds its place until the keyboard stands over it.
    if (refocus.current) {
      setHanding(true);
      focusField();
    } else lowerMenu();
    refocus.current = false;
  };
  // Photos and Camera: the menu goes down with no keyboard in between and the system's picker covers the app; the card
  // holds open under it, and when it's done the field takes the keyboard, what was picked in the card over it.
  const pick = (kind: "Images" | "Camera") => {
    if (context) {
      setContext(false);
      refocus.current = false;
      lowerMenu();
    }
    setPicking(true);
    Keyboard.dismiss();
    void (kind === "Camera" ? takePhoto(scope) : pickPhotos(scope)).finally(() => {
      setPicking(false);
      focusField();
    });
  };
  // An attachment seen whole: the keyboard goes for the viewer (it would stand over it) and comes back after, unless
  // the menu is up in its place, which stays.
  const viewRefocus = useRef(false);
  const view = (index: number) => {
    viewRefocus.current = !context && hadFocus();
    setViewing(index);
    Keyboard.dismiss();
  };
  const unview = () => {
    setViewing(null);
    if (viewRefocus.current) focusField();
    viewRefocus.current = false;
  };
  // The keyboard is all the way up over the menu: the menu goes, unseen. If none comes (a hardware keyboard, a browser),
  // the menu goes down by itself.
  useEffect(() => {
    if (!handing) return;
    if (keys.up) {
      menu.value = 0;
      setHanding(false);
      setMenuDrawn(false);
      return;
    }
    const id = setTimeout(lowerMenu, keys.target > 0 ? 900 : 450);
    return () => clearTimeout(id);
  }, [handing, keys.up, keys.target]);
  // A screen pushed over this one takes the menu down with the keyboard.
  useEffect(() => {
    if (here || !(context || handing)) return;
    setContext(false);
    refocus.current = false;
    setHanding(false);
    menu.value = 0;
    setMenuDrawn(false);
  }, [here]);
  // Voice chat or a call takes the box over: the menu goes down under it.
  useEffect(() => {
    if (!talking || !context) return;
    setContext(false);
    refocus.current = false;
    lowerMenu();
  }, [talking]);
  // A drag on the chat puts the menu away, as it takes the keyboard down (screens/Thread.tsx).
  const menuUp = useRef(false);
  menuUp.current = context;
  useEffect(
    () =>
      onPutMenuAway(() => {
        if (!menuUp.current) return;
        setContext(false);
        refocus.current = false;
        lowerMenu();
      }),
    [],
  );

  const listen = () => {
    haptic.thud();
    if (dictating !== null) {
      setText((now) => join(now, heard));
      setDictating(null);
      if (join(text, heard).trim()) return keepOpen();
    } else setDictating(Date.now());
    // On the web the press takes the focus from the field; it goes back so typing carries on.
    if (Date.now() - blurredAt.current < 400) focusField();
  };
  // ✕ and the pill's own press tick; a hold thuds. Dropping leaves the field as it was.
  const dropHeard = () => {
    setDictating(null);
    if (Date.now() - blurredAt.current < 400) focusField();
  };
  const toggleTray = () => {
    setTrayOpen((on) => !on);
    if (Date.now() - blurredAt.current < 400) focusField();
  };
  // A queued message taken back into the field, after what's there, or dropped; either way the keyboard stays.
  const editQueued = (q: Queued) => {
    kept.remove(q.id);
    setText((now) => join(now, q.text));
    if (q.images?.length) attach(scope, fromSent(q.images));
    focusField();
  };
  const dropQueued = (q: Queued) => {
    kept.remove(q.id);
    if (Date.now() - blurredAt.current < 400) focusField();
  };
  const mention = (name: string) => {
    setText((now) => `${join(now, `@${name}`)} `);
    focusField();
  };

  // ---------- geometry ----------
  const boxW = screenW - layout.inset * 2;
  const fieldW = boxW - 32;
  const [words, setWords] = useState<number>(line);
  const row = !!where && !chief;
  const thumbs = attached.length > 0;
  const fit = cardHeight({ words, row, thumbs, tray, screen: screenH });
  // Pulled tall: from over the keyboard (or the menu in its place) to just under the status bar.
  const footNow = Math.max(Math.max(insets.bottom, 10) + BOX.lift, Math.max(keys.target, context || handing ? menuH : 0) + BOX.overKeyboard);
  const reachH = Math.max(fit, screenH - insets.top - TALL_GAP - footNow);
  const target = tall ? reachH : fit;
  // The field's top in the card; the queue, when it's opened, stands over it and pushes it down.
  const fieldTop = row ? BOX.fieldTopWithRow : BOX.fieldTop;
  const foot = BOX.pad + BOX.circle + 12 + (thumbs ? BOX.thumbs + 10 : 0);

  // What sits at the right at rest decides where the field's line ends.
  const showMic = !voice.on;
  const showPrimary = primary !== "none";
  const circles = (showMic ? 1 : 0) + (showPrimary ? 1 : 0);
  const restRight = circles ? BOX.pad + circles * BOX.circle + (circles - 1) * BOX.gap + BOX.gap : 16;
  const restLeft = BOX.pad + BOX.circle + BOX.gap;
  const restW = boxW - restLeft - restRight;
  // At rest a draft shows up to three lines (measured at the capsule's width), the capsule growing up for them.
  const [restWords, setRestWords] = useState<number>(line);
  const restText = !!text && !open && !talking;
  const restField = restText ? Math.min(Math.max(restWords, line), line * BOX.restLines) : line;
  // In a chat, the next queued follow-up is the resting box's first row.
  const row0 = inChat && queued.length > 0 ? BOX.tray : 0;
  const restBox = BOX.rest - line + restField + row0;

  const openness = useSharedValue(0);
  const card = useSharedValue<number>(target);
  // The card as tall as what it holds, never pulled tall: what the chat over it rides (a tall card covers the chat).
  const fitV = useSharedValue<number>(fit);
  const trayV = useSharedValue(tray);
  const restV = useSharedValue(restField);
  const rowV = useSharedValue(row0);
  const drag = useSharedValue(0);
  const tallV = useSharedValue(tall);
  const reach = useSharedValue(reachH);
  useEffect(() => {
    tallV.value = tall;
    reach.value = reachH;
  }, [tall, reachH, tallV, reach]);
  useEffect(() => {
    if (!open) setTall(false);
  }, [open]);
  useEffect(() => {
    openness.value = withSpring(open ? 1 : 0, { ...morph, overshootClamping: true });
  }, [open, openness]);
  useEffect(() => {
    card.value = withTiming(target, { duration: duration.fast, easing: ease.snap });
    trayV.value = withTiming(tray, { duration: duration.fast, easing: ease.snap });
  }, [target, card, tray, trayV]);
  // On the card's own curve, so while it isn't pulled tall the two are one height, frame for frame.
  useEffect(() => {
    fitV.value = withTiming(fit, { duration: duration.fast, easing: ease.snap });
  }, [fit, fitV]);
  useEffect(() => {
    restV.value = withTiming(restField, { duration: duration.fast, easing: ease.snap });
    rowV.value = withTiming(row0, { duration: duration.fast, easing: ease.snap });
  }, [restField, restV, row0, rowV]);

  const base = Math.max(insets.bottom, 10);
  // Over the keyboard or the menu in its place, whichever stands higher: in a swap they stand at the same height.
  const lift = useAnimatedStyle(() => ({ bottom: Math.max(base + BOX.lift, Math.max(keyboard.height.value, menu.value) + BOX.overKeyboard) }));
  // The scrim rides them too, so nothing reads in the strip between the card and the keys.
  const scrimLift = useAnimatedStyle(() => ({ bottom: Math.max(0, Math.max(keyboard.height.value, menu.value) - base + BOX.overKeyboard - BOX.lift) }));

  // At rest: the queued row, then the capsule around the draft's lines. Open: the card. The one shape morphs between.
  const boxStyle = useAnimatedStyle(() => {
    const rest = rowV.value + BOX.rest - line + restV.value;
    const now = card.value + grownBy(drag.value, card.value, reach.value, tallV.value);
    return { height: rest + (now - rest) * openness.value, transform: [{ translateY: tallV.value ? 0 : Math.max(0, drag.value) }] };
  });
  const fieldStyle = useAnimatedStyle(() => {
    const o = openness.value;
    const restTop = rowV.value + (BOX.rest - line) / 2;
    const top = fieldTop + trayV.value;
    return {
      left: restLeft + (16 - restLeft) * o,
      right: restRight + (16 - restRight) * o,
      top: restTop + (top - restTop) * o,
      height: restV.value + (card.value + grownBy(drag.value, card.value, reach.value, tallV.value) - top - foot - restV.value) * o,
    };
  });
  const rowStyle = useAnimatedStyle(() => ({ height: rowV.value * (1 - openness.value), opacity: 1 - openness.value }));
  // A resting draft is drawn as words that end in "…"; the field takes over as the card opens.
  const restShown = useAnimatedStyle(() => ({ opacity: 1 - openness.value }));
  const drafted = !!text;
  const inputShown = useAnimatedStyle(() => ({ opacity: drafted ? openness.value : 1 }));
  const trayStyle = useAnimatedStyle(() => ({ height: trayV.value }));
  const shown = useAnimatedStyle(() => ({ opacity: openness.value }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: openness.value * (dark ? 0.6 : 0.32) }));

  // The grabber: up makes the card tall, down brings a tall card back, and down again puts the box away. Let go, the
  // card keeps the height the finger left it at and carries on from there, so nothing snaps back first.
  const pan = usePanGesture({
    activeOffsetY: [-6, 6],
    onUpdate: (e) => {
      "worklet";
      drag.value = e.translationY;
    },
    onDeactivate: (e) => {
      "worklet";
      const up = e.translationY < -PULL || e.velocityY < -FLING;
      const down = e.translationY > PULL || e.velocityY > FLING;
      const wasTall = tallV.value;
      if ((up && !wasTall) || (down && wasTall)) {
        card.value = card.value + grownBy(drag.value, card.value, reach.value, wasTall);
        drag.value = 0;
        tallV.value = !wasTall;
        scheduleOnRN(setTall, !wasTall);
        scheduleOnRN(haptic.tick);
        return;
      }
      if (down) scheduleOnRN(putAway);
      drag.value = withSpring(0, release);
    },
  });

  // ---------- height, for the screen ----------
  const [aboveH, setAboveH] = useState(0);
  const riding = above && !tucked ? above : null;
  // How far over what rides on the box (or over the box, with nothing on it) the band behind them begins.
  const reachOf = (rides: boolean) => (rides ? EDGE.over : variant === "new" ? EDGE.reach : 20);
  // The box as it stands now, a card pulled tall counted as tall as what it holds, and what rides on it.
  const standing = BOX.lift + (open ? fit : restBox) + (riding ? aboveH + BOX.above : 0);
  // The one band behind everything at the foot (components/ProgressiveEdge.tsx), measured up from the safe edge's
  // foot: the box's top edge, the top of what rides on it, and how far over that it starts (on Home and the lists, 32
  // over the bar, so the page's last rows sink into it). It follows the box as it is now.
  const edge = { floor: base + BOX.lift + (open ? fit : restBox), top: base + standing, reach: reachOf(!!riding) };

  // What the screen is told is where the box rests: the capsule with its one line, a queued follow-up's row over it,
  // and what rides on it. A draft's further lines at rest are the box growing, as a new line in the card is, and its
  // chat rides them. It holds while the box is open, so nothing the card does reaches the room at the chat's foot.
  const restNow = BOX.rest + row0;
  const restHeld = useRef(restNow);
  if (!open) restHeld.current = restNow;
  const rest = restHeld.current;
  const rides = above ? aboveH + BOX.above : 0;
  const restStanding = BOX.lift + rest + rides;
  const restBand = base + restStanding + reachOf(!!above);
  // Opened in a chat, what rode on the box steps away and the band reaches less far over the card: the card grows into
  // the room that frees before its chat moves for it (the chat never drops for it either: place.ts liftOf).
  const openRides = above && !inChat ? rides : 0;
  const slack = Math.max(0, rides + reachOf(!!above) - (openRides + reachOf(!!above && !inChat)));
  const told = useRef(onHeight);
  told.current = onHeight;
  useEffect(() => {
    told.current?.(restStanding);
  }, [restStanding]);
  const toldEdge = useRef(props.onEdge);
  toldEdge.current = props.onEdge;
  useEffect(() => {
    toldEdge.current?.(restBand);
  }, [restBand]);

  // ---------- the chat over the box rides it (place.ts) ----------
  // How far the box's top stands over where it rests, on the UI thread: over the keyboard or the menu as the `lift`
  // style places it, and the box's height as `boxStyle` draws it, the grabber's pull left out.
  const owner = draft ?? "own";
  const restHeldV = useSharedValue(rest);
  const slackV = useSharedValue(slack);
  useEffect(() => {
    restHeldV.value = rest;
    slackV.value = slack;
  }, [rest, slack, restHeldV, slackV]);
  const liftNow = () => {
    "worklet";
    const o = openness.value;
    const resting = rowV.value + BOX.rest - line + restV.value;
    const now = Math.min(card.value + grownBy(drag.value, card.value, reach.value, tallV.value), fitV.value);
    return liftOf(Math.max(keyboard.height.value, menu.value), base, resting + (now - resting) * o, restHeldV.value, slackV.value * o);
  };
  // Worked out every frame as a derived value, so the chat riding it is worked out after it in the same frame.
  const boxLift = useDerivedValue(liftNow, [base, line]);
  // Only the box on the focused screen is heard, by its own chat; it lets go as it goes out of sight or away. Both in the
  // commit that does it, so the chat hears in the same frame as whatever takes the box's place (a docked ask's room).
  useLayoutEffect(() => {
    if (!here) return;
    claimLift(owner, boxLift);
    return () => releaseLift(owner, boxLift);
  }, [here, owner, boxLift]);
  // The same, as React has it once the box has got where it is going: iOS keeps that much room over a raised chat's top,
  // so its first lines can still be scrolled into view, and a turn sent from the box shares it out with the list as it
  // goes up under the bar (screens/Thread.tsx, chief/ChiefChat.tsx).
  const menuPlace = context || handing ? menuH : 0;
  const keyPlace = (focused || handing) && keys.target > 0 ? keys.target : 0;
  const rise = riseOf(Math.max(menuPlace, keyPlace), base) + Math.max(0, (open ? fit : restBox) - rest - (open ? slack : 0));
  useEffect(() => {
    if (here) setRise(owner, rise);
    else clearRise(owner);
  }, [here, rise, owner]);
  useEffect(() => () => clearRise(owner), [owner]);

  // ---------- what it says and offers ----------
  const hint = resolvePlaceholder({ variant, running, who, custom: variant === "new" ? placeholder || undefined : undefined, mode: current?.label, listening: dictating !== null && !heard });
  const [{ default_access: newChats }] = useSettings();
  // The pick outlives the box: a chat keeps its own (Chat.access, the next turn runs on it), and the new chat's, a
  // workspace's or a Chief's box keeps what the chats it starts take (store/sessions.ts setBoxAccess). A Chief's chats
  // take Settings' for new chats unless it says otherwise.
  const chatAccess = useStore((s) => (draft && inChat ? chatOf(s, draft)?.access : undefined));
  const boxAccess = useStore((s) => s.sessions[scope]?.access);
  const access: Access | null = (inChat ? chatAccess : boxAccess) ?? (chief ? null : newChats);
  const setAccess = (next: Access | null) => {
    if (draft && inChat) {
      if (next) script.setAccess(draft, next);
    } else setBoxAccess(scope, next);
  };
  const sheetSettings = settingsEntries({ rows: settings, after: settingsAfter, access, onAccess: setAccess, chief, newChats });
  // Who voice chat talks to: the workspace a new chat would start in, or this chat's.
  const chatRepo = useStore((s) => (draft && inChat ? chatOf(s, draft)?.repo : undefined));
  const voiceWhere = where?.repo ?? chatRepo;
  // What the card holds that the capsule doesn't: hidden from VoiceOver and the tab order while the box is at rest.
  const cardOnly = { "aria-hidden": !open, accessibilityElementsHidden: !open, importantForAccessibility: open ? ("auto" as const) : ("no-hide-descendants" as const) };
  const dimHidden = useInert(!open);
  const rowHidden = useInert(open);
  const contextHidden = useInert(!open);
  const trayHidden = useInert(!trayOpen);
  const thumbsHidden = useInert(!open);
  const chipsHidden = useInert(!open);

  const right = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: BOX.gap }}>
      {dictating !== null ? (
        <DictationPill since={dictating} hearing={dictation.hearing} onStop={listen} onDrop={dropHeard} />
      ) : (
        <>
          {showMic ? <MicButton onPress={listen} /> : null}
          {primary !== "none" ? (
            <View ref={sender.ref} collapsable={false}>
              <PrimaryButton
                primary={primary as Exclude<Primary, "none">}
                label={primary === "send" && chief ? `Send to ${who}` : primaryLabel(primary, who)}
                onPress={pressPrimary}
                onLongPress={primary === "steer" ? hold : undefined}
                actions={primary === "steer" ? steerActions : undefined}
              />
            </View>
          ) : null}
        </>
      )}
    </View>
  );

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {/* What scrolls under the box dims toward the foot, and under it, by the home indicator, is all but gone: a line
          there can't be read. The glass itself shows the rest through. */}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, right: 0, bottom: 0, height: edge.top + edge.reach }, scrimLift]}>
        <BottomEdge floor={edge.floor} top={edge.top} reach={edge.reach} contentBottom={props.contentEnd} hold={openness} />
      </Animated.View>

      {dims ? (
        <Animated.View ref={dimHidden} pointerEvents={open ? "auto" : "none"} {...cardOnly} style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }, dimStyle]}>
          <Pressable accessibilityLabel="Put the box away" focusable={open} style={{ flex: 1 }} onPress={putAway} />
        </Animated.View>
      ) : null}

      <Animated.View pointerEvents="box-none" style={[{ position: "absolute", left: layout.inset, right: layout.inset }, lift]}>
        {riding ? (
          <View pointerEvents="box-none" style={{ marginBottom: BOX.above }} onLayout={(e) => setAboveH(Math.round(e.nativeEvent.layout.height))}>
            {riding}
          </View>
        ) : null}

        <Animated.View style={boxStyle}>
          <Glass material="chrome" style={[StyleSheet.absoluteFill, { borderRadius: BOX.radius }]} />
          <View {...keepFocus} style={[StyleSheet.absoluteFill, { borderRadius: BOX.radius, overflow: "hidden" }]}>
            {/* Under everything, the whole box takes the keyboard, the caret at the end of what's there: the field's
                line is 22 tall, the capsule 56. */}
            <Pressable
              accessible={false}
              focusable={false}
              tabIndex={-1}
              aria-hidden
              importantForAccessibility="no-hide-descendants"
              disabled={talking}
              onPress={() => focusAtEnd(0)}
              style={StyleSheet.absoluteFill}
            />

            {/* In a chat at rest, the next queued follow-up: the box's first row, over a hairline inset 16. */}
            {row0 ? (
              <Animated.View
                ref={rowHidden}
                pointerEvents={open ? "none" : "box-none"}
                aria-hidden={open}
                accessibilityElementsHidden={open}
                importantForAccessibility={open ? "no-hide-descendants" : "auto"}
                style={[{ position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" }, rowStyle]}
              >
                <QueueRow queued={queued} onEdit={editQueued} onRemove={dropQueued} />
                <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: alpha(c.text, 0.1) }} />
              </Animated.View>
            ) : null}
            {row && where ? (
              <Animated.View ref={contextHidden} pointerEvents={open ? "box-none" : "none"} {...cardOnly} style={[{ position: "absolute", top: 24, left: 16, right: 16 }, shown]}>
                <ContextRow repo={where.repo} branch={where.branch} device={where.device} fixed={where.fixed} width={fieldW} onPress={(focus) => fromCard(() => where.onPress(focus))} />
              </Animated.View>
            ) : null}

            {tucked && queued.length ? (
              <Animated.View
                ref={trayHidden}
                pointerEvents={trayOpen ? "box-none" : "none"}
                aria-hidden={!trayOpen}
                accessibilityElementsHidden={!trayOpen}
                importantForAccessibility={trayOpen ? "auto" : "no-hide-descendants"}
                style={[{ position: "absolute", top: BOX.fieldTop - 6, left: 0, right: 0, overflow: "hidden" }, trayStyle, shown]}
              >
                <QueueTray queued={queued} onEdit={editQueued} onRemove={dropQueued} />
                <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: alpha(c.text, 0.1) }} />
              </Animated.View>
            ) : null}

            <Animated.View pointerEvents={talking ? "none" : "box-none"} aria-hidden={talking} style={[{ position: "absolute", overflow: "hidden" }, fieldStyle, talking ? { opacity: 0 } : null]}>
              {text ? (
                <Animated.Text
                  aria-hidden
                  pointerEvents="none"
                  numberOfLines={BOX.restLines}
                  maxFontSizeMultiplier={FIELD_SCALE}
                  onLayout={(e) => setRestWords(Math.round(e.nativeEvent.layout.height))}
                  style={[FIELD, { position: "absolute", top: 0, left: 0, width: restW, color: c.text }, restShown]}
                >
                  {text}
                </Animated.Text>
              ) : null}
              {/* The field never leaves this place in the tree; at rest under a draft it lets a press through to the box. */}
              <Animated.View pointerEvents={restText ? "none" : "auto"} style={[StyleSheet.absoluteFill, inputShown]}>
                <Field
                  input={input}
                  text={text}
                  onText={setText}
                  heard={heard}
                  placeholder={hint}
                  width={fieldW}
                  onWords={setWords}
                  onFocus={() => {
                    if (blurTimer.current) clearTimeout(blurTimer.current);
                    setFocused(true);
                    setHeld(false);
                    // Back from a picker that never said it was cancelled (a browser without the file input's cancel).
                    setPicking(false);
                    fieldFocus(true);
                    // The field taken while the menu is up: the keyboard comes back in its place, the menu holding it.
                    if (menuUp.current) {
                      setContext(false);
                      refocus.current = false;
                      setHanding(true);
                    }
                  }}
                  onBlur={() => {
                    blurredAt.current = Date.now();
                    setHeld(false);
                    fieldFocus(false);
                    // On the web the box's own controls keep the focus (keepFocus); should a press take it anyway, wait a
                    // beat, so the press can say whether the card stays.
                    if (blurTimer.current) clearTimeout(blurTimer.current);
                    blurTimer.current = setTimeout(() => setFocused(false), WEB ? 180 : 0);
                  }}
                  onEnter={(alt) => send(running && alt)}
                />
              </Animated.View>
            </Animated.View>

            {thumbs ? (
              <Animated.View ref={thumbsHidden} pointerEvents={open ? "auto" : "none"} {...cardOnly} style={[{ position: "absolute", left: 0, right: 0, bottom: BOX.pad + BOX.circle + 10 }, shown]}>
                <AttachmentStrip scope={scope} onOpen={view} />
              </Animated.View>
            ) : null}

            {callActive && call ? (
              <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: BOX.rest, flexDirection: "row" }}>
                <CallRow label={call.label} muted={call.muted} onMute={call.onMute} onEnd={call.onEnd} />
              </View>
            ) : voiceBar ? (
              <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: BOX.rest, flexDirection: "row" }}>
                <VoiceRow where={voiceWhere} heard={voice.heard} muted={voice.muted} answering={voice.phase === "answering"} onMute={toggleMute} onSettings={() => openSettings()} onEnd={endVoice} />
              </View>
            ) : (
              <View pointerEvents="box-none" style={{ position: "absolute", left: BOX.pad, right: BOX.pad, bottom: BOX.pad, height: BOX.circle, flexDirection: "row", alignItems: "center", gap: BOX.gap }}>
                <PlusButton label={chief ? "Name a chat, or this Chief's settings" : "Add context: photos, a mode, files, plugins"} count={open ? 0 : attached.length} open={context} onPress={() => (context ? closeContext() : openContext())} />
                <Animated.View ref={chipsHidden} pointerEvents={open ? "box-none" : "none"} {...cardOnly} style={[{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 }, shown]}>
                  {chip && (!chief || chiefId) ? <ModelChip {...chip} compact={dictating !== null || (tucked && queued.length > 0)} onPress={() => fromCard(chip.onPress)} /> : null}
                  {current && !chief ? <ModeChip icon={current.icon} label={current.label} onClear={() => setMode(null)} /> : null}
                  {tucked && queued.length ? <QueueChip count={queued.length} open={trayOpen} onPress={toggleTray} /> : null}
                </Animated.View>
                {right}
              </View>
            )}
          </View>
          {/* The grabber, over everything in the card: from GRIP_OVER above the card's edge down to where the context
              row, the queue or the field begins, so it never takes their presses. */}
          <GestureDetector gesture={pan}>
            <Animated.View
              pointerEvents={open ? "auto" : "none"}
              accessible={open}
              focusable={open}
              {...cardOnly}
              {...keepFocus}
              accessibilityRole="button"
              accessibilityLabel="Put the box away"
              accessibilityHint={tall ? "Drag down to make the box smaller" : "Drag up to make the box taller"}
              accessibilityActions={[{ name: "activate" }, { name: "magicTap" }, { name: tall ? "decrement" : "increment", label: tall ? "Make smaller" : "Make taller" }]}
              onAccessibilityAction={(e) => {
                const name = e.nativeEvent.actionName;
                if (name === "increment" || name === "decrement") setTall(name === "increment");
                else putAway();
              }}
              style={[{ position: "absolute", top: -GRIP_OVER, left: 0, right: 0, height: GRIP_OVER + (row || trayOpen ? 24 : BOX.fieldTop - 2), alignItems: "center" }, shown]}
            >
              <View style={{ marginTop: GRIP_OVER + 9, width: 36, height: 5, borderRadius: 3, backgroundColor: alpha(c.text, dark ? 0.16 : 0.18) }} />
            </Animated.View>
          </GestureDetector>
          {perch ? (
            <View pointerEvents="box-none" style={{ position: "absolute", left: 30, bottom: "100%", transform: [{ translateY: 6 }] }}>
              {perch}
            </View>
          ) : null}
        </Animated.View>
      </Animated.View>

      {menuDrawn ? (
        <ContextPanel
          open={context}
          height={menuH}
          risen={menu}
          foot={insets.bottom}
          onClose={closeContext}
          scope={scope}
          chief={chief}
          mode={current}
          onMode={setMode}
          onFiles={onFiles ?? (() => script.notify("Files attach once a runtime is connected"))}
          onPick={pick}
          chats={chats}
          self={self}
          onMention={mention}
          settings={sheetSettings}
        />
      ) : null}
      <Menu open={holdAt !== "closed"} onClose={() => setHoldAt("closed")} anchor={holdAt === "closed" ? null : holdAt} align="end" width={300} entries={holdEntries} />
      {attached.length ? <PhotoViewer images={attached} index={viewing} onClose={unview} /> : null}
    </View>
  );
}
