// News from the board, as native phone app says it: a 44 pt glass pill for three seconds that never covers a title,
// a mark or a control. Where the bar's centre is empty (Home at rest, a list before its large title collapses) it sits
// in the bar row itself, between the left circle and the first right one, 8 pt from each, and says the state as its
// glyph and the subject in words ("✓ Dark mode for Runs"; VoiceOver hears "Ready: Dark mode for Runs"), so it never
// lands on the flame and "Caveman" or a list's large title. Where the centre holds something (a chat's title capsule,
// Home's collapsed "Caveman" or its needs capsule) it drops to 8 pt under the bar at the full width, x 16 to 386, with
// the state word too ("Ready · Dark mode for Runs"). It drops in from above and goes back up the same way, by moving
// and never by fading, since glass renders wrong under opacity. Its words lead with what happened, then what it
// happened to, so a long title is the part that gives way: a green check and "Ready · Dark mode for Runs". Done news
// buzzes; the rest is silent. A toast that can be acted on (Undo after an answer to an ask, a Ship it, an Archive)
// carries Undo at its right, a 44 pt text button in ink, and holds a little longer; the board's news waits behind it
// rather than knock the Undo out of reach. News about a chat is itself the way there: the whole pill opens it. News
// about the chat on screen (or its parent or subagents) isn't said at all: you're looking at it. While a sheet is up
// the board's news waits for it to close; the shell's own notices show at once. VoiceOver hears every one.
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform, Pressable, Text, View } from "react-native";
import Animated, { Keyframe } from "react-native-reanimated";
import type { Toast as News } from "../board/model";
import { ease, haptic } from "../motion";
import { FLOAT_TYPE, layout, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";
import { store } from "../store/store";
import { PixelIcon } from "./Pixel";
import { Squish } from "./Squish";
import { Frost } from "./ui/Floating";

const HOLD_MS = 3000;
/** How long Undo stays in reach. */
export const UNDO_MS = 5000;

/** News of the shell's own (Archive, with its Undo), beside the board's. */
export interface Notice extends Omit<News, "id"> {
  id: string;
  /** Its own glyph, where the news is yours rather than the Chief's (Archive's box). */
  icon?: IconName;
  action?: { label: string; onPress: () => void };
  /** News about a chat: the capsule itself opens it. */
  open?: () => void;
  /** How long it stays, when not the default (Mark all seen's Undo, 4 s). */
  ms?: number;
  /**
   * What it happened to, after `text` says what happened ("Allowed", "vercel deploy"): one line at the full width, and
   * in the bar row, where an Undo leaves little room, a second smaller line under the verb rather than a cut word.
   */
  detail?: string;
}

/** Where the capsule sits: its row's top, and the room it keeps clear at either side for the bar's circles. */
export interface ToastSlot {
  top: number;
  left: number;
  right: number;
  /** In the bar row, between its circles: the state is the glyph alone and the subject has the words. */
  inBar?: boolean;
}

// Whether a toast is showing right now (`toastVisible`, `useToastShowing`), for anything that would sit where it drops.
let up = false;
const watchers = new Set<() => void>();
function setUp(next: boolean) {
  if (next === up) return;
  up = next;
  for (const watch of watchers) watch();
}
const watch = (listener: () => void) => {
  watchers.add(listener);
  return () => void watchers.delete(listener);
};
/**
 * What the bar on top holds in its centre: nothing (Home at rest, a list before its title collapses), where news can
 * sit in the bar row itself; and how many circles stand at its right, which the news stops short of.
 */
export interface BarCentre {
  empty: boolean;
  right: number;
}
let centre: BarCentre = { empty: false, right: 1 };
const centreWatchers = new Set<() => void>();
const watchCentre = (listener: () => void) => {
  centreWatchers.add(listener);
  return () => void centreWatchers.delete(listener);
};
/** The bar on top's centre, for where the toast sits (shell/Overlays.tsx). */
export const useBarCentre = () => useSyncExternalStore(watchCentre, () => centre, () => centre);
/** A bar says what its centre holds while its screen is the one on top (shell/TopBar.tsx). */
export function useReportBarCentre(empty: boolean, right: number) {
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused || (centre.empty === empty && centre.right === right)) return;
    centre = { empty, right };
    for (const watch of centreWatchers) watch();
  }, [focused, empty, right]);
}

/** True while a toast is showing. */
export const toastVisible = () => up;
export const useToastShowing = () => useSyncExternalStore(watch, () => up, () => up);

// It drops into the row from above and goes back up: moved, never faded (the glass would render wrong).
const drop = new Keyframe({
  0: { transform: [{ translateY: -72 }, { scale: 0.92 }] },
  100: { transform: [{ translateY: 0 }, { scale: 1 }], easing: ease.snap },
}).duration(320);
const lift = new Keyframe({
  0: { transform: [{ translateY: 0 }, { scale: 1 }] },
  100: { transform: [{ translateY: -72 }, { scale: 0.96 }], easing: ease.snap },
}).duration(200);

/**
 * `news`: the board's. `notice`: the shell's own. `mute`: the Chief whose screen is showing; it says its own news in
 * its chat, so its toasts are skipped. `hold`: a sheet is up, so the board's news waits. `onOpen` opens the chat a
 * piece of news is about; `here` is the chat on screen, which needs no Open. `slot` is the row it sits in.
 */
export function Toast({ news, notice = null, mute, hold = false, onOpen, here = null, slot }: { news: News | null; notice?: Notice | null; mute: string | null; hold?: boolean; onOpen?: (chat: string) => void; here?: string | null; slot: ToastSlot }) {
  const { c, t } = useTheme();
  const [shown, setShown] = useState<Notice | null>(null);
  const held = useRef<Notice | null>(null);
  const opener = useRef({ onOpen, here });
  opener.current = { onOpen, here };
  // What shows now, for the board's news to see whether it would knock an Undo out of reach.
  const showing = useRef<Notice | null>(null);
  showing.current = shown;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = (next: Notice) => {
    setShown(next);
    if (next.tone === "done") haptic.done();
    // iOS has no live regions: the toast is said out loud instead.
    const words = next.detail ? `${next.text} ${next.detail}` : next.text;
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(next.action ? `${words}. ${next.action.label} is in the toast` : words);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown((now) => (now?.id === next.id ? null : now)), next.ms ?? (next.action ? UNDO_MS : HOLD_MS));
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // Keyed on the news alone: leaving a Chief's screen must not replay what it already said.
  useEffect(() => {
    if (!news || (news.chief && news.chief === mute)) return;
    const { onOpen: open, here: on } = opener.current;
    const chat = news.chat;
    // The chat on screen says its own news, and so does its family: a subagent's news shows in its parent's chat.
    if (chat && on && related(chat, on)) return;
    const next: Notice = { ...news, id: `board-${news.id}`, open: chat && open ? () => open(chat) : undefined };
    // While a sheet is up, or an Undo is still in reach (an answer, an archive), the news waits its turn.
    if (hold || showing.current?.action) {
      held.current = next;
      return;
    }
    show(next);
  }, [news]);
  // A sheet coming up puts away the board's news that's showing.
  useEffect(() => {
    if (hold) setShown((now) => (now?.id.startsWith("board-") ? null : now));
  }, [hold]);
  // What waited shows once the sheet has gone and the toast is free.
  useEffect(() => {
    if (shown || hold) return;
    const next = held.current;
    if (!next) return;
    held.current = null;
    show(next);
  }, [shown, hold]);
  useEffect(() => {
    if (notice) show(notice);
  }, [notice]);
  useEffect(() => setUp(!!shown), [shown]);
  useEffect(() => () => setUp(false), []);

  const h = layout.float;
  // An answer's toast in the bar row: its verb and object over two lines, Undo beside them, and no room for a glyph.
  const tight = !!(slot.inBar && shown?.action && shown.detail);
  return (
    <View pointerEvents="box-none" accessibilityLiveRegion="polite" style={{ position: "absolute", top: slot.top, left: slot.left, right: slot.right, height: h }}>
      {shown ? (
        <Animated.View key={shown.id} entering={drop} exiting={lift} pointerEvents={shown.action || shown.open ? "auto" : "none"}>
          {/* It always sits over a title (the bar's capsule, a sheet's name), so under its glass rim it is nearly solid:
              the words beneath must not smear through its own. A toast with an action is not itself pressable, so its
              Undo is never a button inside a button; the Undo is a 44 pt text button. */}
          {(() => {
            const pill = (
              <Frost style={{ height: h, borderRadius: h / 2, alignSelf: "center", maxWidth: "100%" }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: h, borderRadius: h / 2, paddingLeft: tight ? 18 : 14, paddingRight: shown.action ? 4 : 16 }}>
                  {/* A finish shows the green pixel check; your own news has its glyph; anything else is the Chief's word. */}
                  {/* Never squeezed by long words (the web lets an svg shrink in a row). In the bar row an Undo leaves
                      room for the verb and its object only, and the verb says what the glyph would. */}
                  {tight ? null : (
                    <View style={{ flexShrink: 0 }}>
                      {shown.tone === "done" ? <PixelIcon name="state-done" label="Done" /> : shown.icon ? <Icon name={shown.icon} size={18} color={c.soft} /> : <PixelIcon name="chief" />}
                    </View>
                  )}
                  {shown.detail ? <Said text={shown.text} detail={shown.detail} short={!!slot.inBar} /> : <Words text={shown.text} about={!!shown.chat} short={!!slot.inBar} />}
                  {shown.action ? (
                    // A 44 pt text button in ink, as the resolved line's Undo (ui/Choices.tsx): no capsule inside
                    // the capsule.
                    <Squish
                      label={shown.action.label}
                      depth={0.95}
                      onPress={() => {
                        shown.action?.onPress();
                        setShown(null);
                      }}
                      style={{ height: h, minWidth: 44, paddingHorizontal: tight ? 10 : 12, alignItems: "center", justifyContent: "center" }}
                    >
                      <Text style={[t.button, { fontSize: 15, lineHeight: 20, fontWeight: "600", color: c.text }]}>{shown.action.label}</Text>
                    </Squish>
                  ) : null}
                </View>
              </Frost>
            );
            if (shown.action) return pill;
            return (
              <Pressable
                disabled={!shown.open}
                accessibilityRole={shown.open ? "button" : undefined}
                accessibilityLabel={spoken(shown.text, !!shown.chat)}
                accessibilityHint={shown.open ? "Opens the chat" : undefined}
                onPress={() => {
                  shown.open?.();
                  setShown(null);
                }}
              >
                {pill}
              </Pressable>
            );
          })()}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** News about a chat, said word first: "Dark mode for Runs is ready" is "Ready · Dark mode for Runs". */
export function wordFirst(text: string): { word: string; subject: string } | null {
  const ready = /^(.+?)\s+is ready$/.exec(text);
  if (ready) return { word: "Ready", subject: ready[1]! };
  const done = /^(.+?)\s+is done$/.exec(text);
  if (done) return { word: "Done", subject: done[1]! };
  const merged = /^(.+?)\s+merged$/.exec(text);
  if (merged) return { word: "Merged", subject: merged[1]! };
  const needs = /^(.+?)\s+needs you$/.exec(text);
  if (needs) return { word: "Needs you", subject: needs[1]! };
  return null;
}

/**
 * The toast's words. News about something leads with what happened and gives its subject's end to an ellipsis, on
 * one line ("Ready · Dark mode for R…"). A notice that explains ("Ada can't be made here yet. Make it on your Mac.")
 * may take a second, smaller line rather than lose its point.
 */
function Words({ text, about, short = false }: { text: string; /** News about a chat, said as what happened and its title. */ about: boolean; /** In the bar row: the glyph says the state, the words only the subject. */ short?: boolean }) {
  const { c, t } = useTheme();
  const style = [t.label, { fontSize: 15, lineHeight: 20 }];
  const split = about ? wordFirst(text) : null;
  if (split && short) {
    return (
      <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} accessibilityLabel={`${split.word}: ${split.subject}`} style={[style, { flexShrink: 1, color: c.text, fontWeight: "400" }]}>
        {split.subject}
      </Text>
    );
  }
  if (!split) {
    return (
      <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.93} style={[style, { flexShrink: 1 }, text.length > 26 ? { fontSize: 14, lineHeight: 17 } : null]}>
        {text}
      </Text>
    );
  }
  return (
    <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[style, { flexShrink: 1 }]}>
      {split.word}
      <Text style={{ color: c.muted, fontWeight: "400" }}>{` · ${split.subject}`}</Text>
    </Text>
  );
}

/** What happened and what to: "Allowed vercel deploy" on one line, or in the bar the verb over its object. */
function Said({ text, detail, short }: { text: string; detail: string; short: boolean }) {
  const { c, t } = useTheme();
  if (!short) {
    return (
      <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.label, { flexShrink: 1, fontSize: 15, lineHeight: 20 }]}>
        {text}
        <Text style={{ color: c.muted, fontWeight: "400" }}>{` ${detail}`}</Text>
      </Text>
    );
  }
  return (
    <View accessible accessibilityLabel={`${text} ${detail}`} style={{ flexShrink: 1, minWidth: 0 }}>
      <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.label, { fontSize: 15, lineHeight: 18 }]}>
        {text}
      </Text>
      <Text maxFontSizeMultiplier={FLOAT_TYPE} numberOfLines={1} style={[t.label, { fontSize: 13, lineHeight: 16, color: c.muted, fontWeight: "400" }]}>
        {detail}
      </Text>
    </View>
  );
}

/** What VoiceOver hears: news about a chat as "Ready: Dark mode for Runs", whatever the pill shows. */
function spoken(text: string, about: boolean): string {
  const split = about ? wordFirst(text) : null;
  return split ? `${split.word}: ${split.subject}` : text;
}

/** Two chats of one family: the same chat, a parent and its subagent, or two subagents of one parent. */
function related(a: string, b: string): boolean {
  if (a === b) return true;
  const chats = store.get().board.chats;
  const parentOf = (id: string) => chats.find((c) => c.id === id)?.parent ?? null;
  const pa = parentOf(a);
  const pb = parentOf(b);
  return pa === b || pb === a || (pa !== null && pa === pb);
}
