// One chat's feed (DECISIONS.md O9, "Thread, exactly"; upstream ThreadFeed): a virtualized list of turns that opens at
// the latest one, already at its end, with "⌃ Earlier · 6 turns" above it; scrolling to the top pages earlier turns in
// without moving what you're reading. The list stays unseen until it has landed, so the first frame is the latest turn.
//
// Following the end is a latch the reader owns (thread/follow.ts). Only a hand lets go of it (a drag, a wheel, a key);
// the list moving by itself never does, so a fold closing or the browser clamping the offset as content shrinks keeps
// you at the end. Coming back within 4pt of the end, the jump circle or sending takes it back. While it holds, a turn
// you just sent glides up to sit 56pt under the bar, clear of its band, with room below it (LegendList's anchored end
// space), so the answer grows into the room without the list moving; that glide is the only thing moving the list
// while it runs. Once the turn outgrows the screen the list follows each new line with a short glide, never a jump.
// As a turn folds itself away, or anything else shrinks, the end is held hard in the same frame.
//
// A turn that finishes folds at once (thread/fold.ts, O4), unless the screen holds it: while a finger is down it waits
// for the finger to lift; if you are reading inside it (a hand let go of the end since it began, and it is on screen),
// it waits until you come back to the end or scroll it out of view. The jump circle's dot says something grew under
// you while you were away; it goes once you are back at the end. Opening a fold by hand keeps its "Worked for" line under
// your thumb. Fold choices made by hand are the chat's own (store/sessions.ts) and come back with it. A search hit
// inside the chat (its scroll anchor) pages its turn in, opens its fold, and lands it under the bar, flashing.
//
// The chat and the box at its foot move as one (shell/composer/place.ts). The room under the last line is only ever
// what the box needs at rest (`bottom`); as the keyboard or the box's `+` menu rises under the box, as the box opens
// and as it grows a line while you write, the whole list rides up with it, on the UI thread, frame for frame, by a
// transform. It rides only as far as the box rises past the empty room the chat already has over the box's resting
// top (`blank`): a short chat, or a turn just sent with room below it, doesn't move at all, and a long chat at its end
// rides up exactly with the box. That room is measured while the chat follows its end and held while a hand has let
// go of it, and while a hand drags the chat the ride holds still too, so the content moves with the finger alone.
// Swapping the keyboard for the menu moves nothing. On iOS a raised chat keeps as much room over its top, so its
// first lines still scroll into view. A drag on the chat puts the menu away, as it takes the keyboard down.
import { bootReady } from "../boot";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import Animated, { Easing, type SharedValue, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Chat, Item } from "../board/model";
import { Icon } from "../components/Icon";
import { Squish } from "../components/Squish";
import { ThreadRefContext, type ThreadRefs } from "../components/transcript/Markdown";
import { isCurrent, TurnView, type ViewNode } from "../components/Transcript";
import { shallow } from "../store/core";
import { setAnchor, setFold, useAnchor, useFolds } from "../store/sessions";
import { blankOf, putMenuAway, RIDE_MS, rideOf, useChatLift, useRise } from "../shell/composer/place";
import { BAR_HEIGHT } from "../shell/TopBar";
import { FOLD_MS } from "../thread/Collapse";
import { locate, planTurn, turnsOf, type TurnPlan } from "../thread/fold";
import { AT_END, awayOf, createFollow, holdOf, scrolled as scrolledBy, touch as handOn } from "../thread/follow";
import { rhythm, touch, useTheme } from "../theme";

export interface ThreadHandle {
  /** Back to the newest, following it again. */
  scrollToEnd: (animated?: boolean) => void;
}

interface Props {
  chat: Chat;
  /** A subagent's parent. */
  parent: Chat | null;
  /** This chat's own subagents. */
  kids: readonly Chat[];
  /** Room under the last line for what floats over the chat's foot (the box, the floating row, the dock). */
  bottom: number;
  /** The latest turn is over on the wire but its answer is still arriving on screen (thread/settle.ts). */
  settling?: boolean;
  /** The chat's ask as the one status function words it, for the amber line it leaves. */
  ask?: string | null;
  /** You scrolled up away from the end, or came back to it. */
  onScrolledUp: (up: boolean) => void;
  /** How far the list has scrolled, for the bar's edge (components/ProgressiveEdge.tsx). */
  edgeY?: SharedValue<number>;
  /** Something new arrived while you were scrolled up (and was seen once you came back). */
  onFresh: (fresh: boolean) => void;
  onOpenChat: (id: string) => void;
  onReview: () => void;
  onRetry: (text: string) => void;
  /** Sends a message that was not sent again, by its id in the chat. */
  onResend?: (item: string) => void;
  /** A chat named in its words: what it is, to draw its pill. */
  resolve: ThreadRefs["resolve"];
}

/** The first line's room under the bar: clear of its scroll-edge fade (components/ProgressiveEdge.tsx). */
const LEAD = 24;
/**
 * Where a turn you just sent, the jump circle's landing and a search hit put the top of what they bring: past the bar's
 * scroll-edge fade, with breathing room so the line you sent stays clear of the controls.
 */
const LAND = 56;
/** How many turns a page of "Earlier" brings in. */
const PAGE = 3;
/** Following a new line: a short glide, easing out. Bringing a turn you just sent up under the bar: a longer one. */
const FOLLOW_MS = 120;
const SEND_MS = 320;
/** The most a followed line moves the list in one frame. */
const FOLLOW_STEP = 8;
/** The room under the last line changing while the chat rides the box eases on the ride's own curve (place.ts RIDE_MS). */
const EASE_OUT = Easing.out(Easing.quad);
/** Growth under you is news (the jump circle's dot) once it has held this long. */
const FRESH_MS = 100;
/** Content paged in above you, or a fold you opened, isn't news for this long. */
const QUIET_MS = 600;
/** How long a sibling remembers where you were in it. */
const PLACE_MS = 10 * 60_000;

type Row = { kind: "earlier"; key: string; count: number } | { kind: "turn"; key: string; plan: TurnPlan; date: number | null; first: boolean; hold: boolean };

/** Where you were in a subagent, so switching between siblings comes back to it (each keeps its own place). */
const places = new Map<string, { from: number; scroll: number; at: number }>();

type Cached = { you: Item | null; items: readonly Item[]; latest: boolean; phase: Chat["phase"]; before: number | null; kids: readonly Chat[]; plan: TurnPlan };

const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export const Thread = forwardRef<ThreadHandle, Props>(function Thread({ chat, parent, kids, bottom, settling = false, ask = null, onScrolledUp, edgeY, onFresh, onOpenChat, onReview, onRetry, onResend, resolve }, ref) {
  const { c, t } = useTheme();
  const insets = useSafeAreaInsets();
  const list = useRef<LegendListRef>(null);
  const top = insets.top + BAR_HEIGHT + LEAD;
  const land = insets.top + BAR_HEIGHT + LAND;

  // ---------- the turns, planned once each: a turn whose items didn't change keeps its plan ----------
  // While its answer settles, the latest turn still reads as working.
  const phase: Chat["phase"] = settling ? "working" : chat.phase;
  const cache = useRef(new Map<string, Cached>());
  const plans = useMemo(() => {
    const childPhase = (id: string) => kids.find((k) => k.id === id)?.phase ?? null;
    const turns = turnsOf(chat.items);
    const next = new Map<string, Cached>();
    let before: number | null = null;
    const out = turns.map((turn, i) => {
      const latest = i === turns.length - 1;
      const was = cache.current.get(turn.key);
      const rosters = turn.items.some((it) => it.kind === "agents");
      // Your words count too: the ack that replaces them ("Sending" gone) re-plans the turn. A steer is in its items.
      const same = !!was && was.you === turn.you && was.latest === latest && (!latest || was.phase === phase) && was.before === before && shallow(was.items, turn.items) && (!rosters || was.kids === kids);
      const plan = same ? was.plan : planTurn(turn, { latest, chat: { phase }, childPhase, before });
      next.set(turn.key, { you: turn.you, items: turn.items, latest, phase, before, kids, plan });
      before = plan.end ?? plan.start ?? before;
      return plan;
    });
    cache.current = next;
    return out;
  }, [chat.items, phase, kids]);

  // ---------- what's loaded: the latest turn, and pages of earlier ones as you ask ----------
  const saved = useRef(chat.parent ? places.get(chat.id) : undefined);
  if (saved.current && Date.now() - saved.current.at > PLACE_MS) saved.current = undefined;
  const [start, setStart] = useState(() => saved.current?.from ?? Math.max(0, plans.length - 1));
  const from = Math.min(start, Math.max(0, plans.length - 1));
  const scrolled = useRef(false);
  // Paged in by you (Earlier, or scrolling to the top): stay where you are, not at the end.
  const paged = useRef(false);
  /** When content last came in above you: its growth isn't news. */
  const quietUntil = useRef(0);
  const pageIn = useCallback(() => {
    paged.current = true;
    quietUntil.current = clock() + QUIET_MS;
    setStart((s) => Math.max(0, s - PAGE));
  }, []);
  // A latest turn too short to fill the screen brings the turns before it in, one at a time, as it opens: no empty
  // screen with "Earlier" floating in the middle of it. Only while the chat opens; after that, only you page in.
  const opened = useRef(Date.now());
  const fill = useCallback(() => {
    if (Date.now() - opened.current > 2000 || scrolled.current || saved.current) return;
    const state = list.current?.getState();
    if (!state) return;
    let rows = 0;
    for (const size of state.sizes.values()) rows += size;
    if (rows + top + bottom >= state.scrollLength - 24) return;
    quietUntil.current = clock() + QUIET_MS;
    setStart((s) => Math.max(0, s - 1));
  }, [top, bottom]);

  // ---------- what was there when it opened sits still ----------
  const [firstPaint] = useState(() => new Set(chat.items.map((i) => i.id)));
  const isNew = useCallback((id: string) => !firstPaint.has(id), [firstPaint]);

  // ---------- following the end ----------
  const latch = useRef(createFollow(!saved.current)).current;
  const away = useRef(false);
  /** What this screen last scrolled to itself: a scroll that lands there is ours. */
  const expected = useRef(0);
  /** Where the list is, as last set or seen. */
  const at = useRef(0);
  const glider = useRef<number | null>(null);
  /** The glide that brings a turn you sent up under the bar is running: it alone moves the list until it lands. */
  const sending = useRef(false);
  /** Until then the end is held hard (a fold closing on its own). */
  const pinUntil = useRef(0);
  /** Until then nothing takes the end back (a fold you opened or shut is keeping its line under your thumb). */
  const keepUntil = useRef(0);
  /** The room LegendList keeps under a sent turn: no distance from the end at all. */
  const anchoredSpace = useRef(0);
  /** A finger is down on the list, or a drag is moving it (a phone's). */
  const touching = useRef(false);
  const dragging = useRef(false);

  // ---------- riding the box: the list moves up with it, past the empty room under the last line ----------
  const { lift: boxLift, hold: holdRide, release: releaseRide } = useChatLift(chat.id);
  /** The empty room between the last row and the box's resting top, at the end (place.ts blankOf), on the UI thread. */
  const blank = useSharedValue(0);
  /** That room as last measured, and as the chat rides over it now (an ease under way counts as there). */
  const blankAt = useRef(0);
  const blankShown = useRef(0);
  /**
   * The room under the last line, measured again while the chat follows its end (and once as it opens); while a hand
   * has let go of the end it holds, so the list never moves on its own under a reader. Changing while the chat rides
   * the box, it eases rather than hops. Under a turn you just sent the send glide brings it in instead, frame for frame
   * with the list (`glide`), so the chat comes down off the box as one with the turn going up.
   */
  const measureBlank = useCallback(
    (first = false) => {
      if (!latch.following && !first) return;
      const st = list.current?.getState();
      if (!st || st.scrollLength <= 0) return;
      const next = blankOf(anchoredSpace.current, st.scrollLength, st.contentLength);
      blankAt.current = next;
      if (sending.current || Math.abs(next - blankShown.current) < 0.5) return;
      blankShown.current = next;
      scheduleOnUI(() => {
        "worklet";
        const riding = rideOf(boxLift.value, blank.value) > 0.5 || rideOf(boxLift.value, next) > 0.5;
        blank.value = riding ? withTiming(next, { duration: RIDE_MS, easing: EASE_OUT }) : next;
      });
    },
    [latch, blank, boxLift],
  );
  /**
   * The room the chat rides over, set now (the send glide's frames). A browser scrolls the list the moment it is told,
   * while Reanimated draws a value set here at its next pass, a frame later once anything has animated; so on the web
   * that pass runs now, and the ride lands in the frame its scroll does.
   */
  const rideOver = useCallback(
    (room: number) => {
      blankShown.current = room;
      blank.value = room;
      if (Platform.OS === "web") (globalThis as { __mapperRun?: () => void }).__mapperRun?.();
    },
    [blank],
  );
  const raised = useAnimatedStyle(() => ({ transform: [{ translateY: -rideOf(boxLift.value, blank.value) }] }));
  // The bar's edge reads how far the chat has gone up under it: scrolled, and raised with the box.
  const scrollY = useSharedValue(0);
  useAnimatedReaction(
    () => scrollY.value + rideOf(boxLift.value, blank.value),
    (y) => {
      if (edgeY) edgeY.value = y;
    },
    [edgeY],
  );
  // On iOS a raised chat keeps the room it rides up by over its top (as React last knew it), so its first lines still
  // scroll into view under the bar. Only a chat that fills its screen: a shorter one would rest pushed down into it.
  const rise = useRise(chat.id);
  /** The box's lift once it has got where it is going, for the send glide to share out with the list (`glide`). */
  const settled = useRef(rise);
  settled.current = rise;
  const reachTop = (() => {
    if (Platform.OS !== "ios" || rise <= 0) return 0;
    const st = list.current?.getState();
    if (!st || st.contentLength < st.scrollLength - 0.5) return 0;
    return Math.max(0, rise - anchoredSpace.current);
  })();

  const setOffset = useCallback((y: number) => {
    const to = Math.max(0, y);
    expected.current = to;
    at.current = to;
    void list.current?.scrollToOffset({ offset: to, animated: false });
  }, []);
  const stopGlide = useCallback(() => {
    if (glider.current !== null) cancelAnimationFrame(glider.current);
    glider.current = null;
    sending.current = false;
  }, []);
  /** The list's end, and where it is now, by what it holds. */
  const endOf = () => {
    const st = list.current?.getState();
    if (!st) return null;
    const end = Math.max(0, st.contentLength - st.scrollLength);
    return { end, now: end - st.distanceFromEnd, distance: st.distanceFromEnd };
  };
  /** Straight to the end, this frame. Never while a sent turn's glide runs: it is the one moving the list. */
  const pin = useCallback(() => {
    if (sending.current) return;
    stopGlide();
    const e = endOf();
    if (e && e.distance > 0.5) setOffset(e.end);
  }, [setOffset, stopGlide]);
  /**
   * To the end over `ms`, easing out, aiming each frame at where the end is by then, never turning back. Following
   * new lines it never moves more than FOLLOW_STEP a frame, so the line you're reading never hops; bringing a turn
   * you sent up under the bar (SEND_MS) has no such limit, and nothing else moves the list until it lands.
   *
   * Bringing a sent turn up while the chat rides the box, the glide moves the two together: how far the list has gone
   * up is its scroll and its ride over the box at once, and that glides one way, to where the end and the ride will be
   * once the room under the turn has opened; the ride eases off by the same share and the scroll takes the rest. So the
   * turn goes up under the bar in one motion, whichever of the list's size and that room it hears of first.
   */
  const glide = useCallback(
    (ms = FOLLOW_MS) => {
      const send = ms !== FOLLOW_MS;
      // A follow waits for the send glide; it picks up whatever arrived meanwhile once that lands.
      if (sending.current && !send) return;
      const e0 = endOf();
      if (!e0 || (!send && e0.distance <= 0.5)) return;
      stopGlide();
      sending.current = send;
      // The box's lift, and how far the chat rides it now: a follow leaves the ride to the box and measureBlank.
      const lift = send ? settled.current : 0;
      const ride0 = send ? rideOf(lift, blankShown.current) : 0;
      // How far the list has gone up: its scroll and its ride together.
      const from0 = e0.now + ride0;
      const cap = send ? Number.POSITIVE_INFINITY : FOLLOW_STEP;
      const began = clock();
      let y = from0;
      expected.current = e0.now;
      const step = () => {
        // A hand on the list (a drag, a wheel) lets go of the end, and the glide with it.
        if (!latch.following) {
          glider.current = null;
          sending.current = false;
          return;
        }
        const end = endOf()?.end ?? y;
        const rideTo = send ? rideOf(lift, blankAt.current) : 0;
        const to = end + rideTo;
        const k = Math.min(1, (clock() - began) / ms);
        const share = 1 - (1 - k) * (1 - k);
        const eased = from0 + (to - from0) * share;
        // One way only: toward the end as it stands now, never back.
        const next = to >= y ? Math.min(y + cap, Math.max(y, eased)) : to;
        y = next;
        // The ride eases off by the same share; the scroll takes the rest, within the list's reach.
        const ride = rideTo + (ride0 - rideTo) * (1 - share);
        const scroll = Math.min(Math.max(0, y - ride), end);
        setOffset(scroll);
        if (send) rideOver(y - scroll > 0.5 ? lift - (y - scroll) : Math.max(lift, blankAt.current));
        if (k < 1 || Math.abs(to - y) > 0.5) {
          glider.current = requestAnimationFrame(step);
          return;
        }
        // Landed: anything that arrived on the last frame is taken up too, the same way.
        if (send) rideOver(blankAt.current);
        glider.current = null;
        sending.current = false;
        requestAnimationFrame(() => {
          const now = endOf();
          if (latch.following && glider.current === null && now && now.distance > 0.5) again.current(FOLLOW_MS);
        });
      };
      glider.current = requestAnimationFrame(step);
    },
    [setOffset, stopGlide, rideOver, latch],
  );
  const again = useRef(glide);
  again.current = glide;
  /** More arrived, or something at the foot changed: keep up, if you are following. */
  const keepUp = useCallback(
    (ms = FOLLOW_MS) => {
      if (!latch.following || clock() < keepUntil.current || sending.current) return;
      if (clock() < pinUntil.current) pin();
      else glide(ms);
    },
    [glide, pin, latch],
  );

  const setAway = useCallback(
    (next: boolean) => {
      if (next === away.current) return;
      away.current = next;
      onScrolledUp(next);
      if (!next) onFresh(false);
    },
    [onScrolledUp, onFresh],
  );
  /** Away from the end, measured from the last real row's foot: the room under a sent turn doesn't count. */
  const checkAway = useCallback(
    (distance?: number) => {
      const d = distance ?? endOf()?.distance;
      if (d === undefined) return;
      setAway(!latch.following && awayOf(d, anchoredSpace.current));
    },
    [setAway, latch],
  );

  // Something grew under you while you were away: the jump circle's dot, once it has held a moment.
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const grewUnder = useCallback(() => {
    if (freshTimer.current || clock() < quietUntil.current || clock() < keepUntil.current) return;
    freshTimer.current = setTimeout(() => {
      freshTimer.current = null;
      if (!latch.following && away.current) onFresh(true);
    }, FRESH_MS);
  }, [onFresh, latch]);
  useEffect(() => () => void (freshTimer.current && clearTimeout(freshTimer.current)), []);

  // The list says when what it holds grows or shrinks, the room under a sent turn, and its footer. Each changes the
  // empty room under the last line too, which the chat rides the box over.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const st = list.current?.getState();
    if (!st) return;
    let total = st.contentLength;
    const sized = (next: number) => {
      const grew = next > total + 0.5;
      const shrank = next < total - 0.5;
      total = next;
      if (latch.following) {
        // Shrinking (a fold closing, room going) holds the end hard, this frame; growing glides to it.
        if (shrank) pin();
        else keepUp();
        measureBlank();
        return;
      }
      checkAway();
      if (grew) grewUnder();
    };
    const anchoredSized = (next: number) => {
      anchoredSpace.current = next;
      if (latch.following) keepUp();
      else checkAway();
      measureBlank();
    };
    // What stands over the foot growing (the footer) is the end moving too: held hard, it isn't news.
    const footer = () => {
      if (latch.following) pin();
      measureBlank();
    };
    const offs = [st.listen("totalSize", () => sized(list.current?.getState().contentLength ?? total)), st.listen("anchoredEndSpaceSize", anchoredSized), st.listen("footerSize", footer)];
    return () => offs.forEach((off) => off());
  }, [keepUp, pin, checkAway, grewUnder, measureBlank, latch, ready]);
  useEffect(() => () => stopGlide(), [stopGlide]);
  // What stands over the foot at rest changed (the dock, a queued follow-up, what rides on the box): following, the
  // list moves with it in the same frame, so the last line keeps its place over the foot's band; then once more when
  // the list has taken the new room in. The box opening, rising and growing never changes it: the chat rides those.
  const lastBottom = useRef(bottom);
  useLayoutEffect(() => {
    const delta = bottom - lastBottom.current;
    lastBottom.current = bottom;
    if (!latch.following || sending.current || !delta) return;
    if (delta > 0) setOffset(at.current + delta);
    const raf = requestAnimationFrame(() => latch.following && pin());
    return () => cancelAnimationFrame(raf);
  }, [bottom, pin, setOffset, latch]);

  // ---------- a turn you just sent sits under the bar, with room below it ----------
  const latest = plans.at(-1) ?? null;
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const lastKey = useRef(latest?.key ?? null);
  /** When the latest turn began on this screen: reading inside it holds its fold only if a hand let go since. */
  const began = useRef({ key: latest?.key ?? null, at: clock() });
  if (latest && began.current.key !== latest.key) began.current = { key: latest.key, at: clock() };
  // From the render that brings the turn in, the send glide owns the list and the room under it: what the list says as
  // it takes the turn in (its new size, the room under it) waits for that glide rather than moving the chat first.
  if (latest && latest.key !== lastKey.current && latch.following) sending.current = true;
  useEffect(() => {
    if (!latest || latest.key === lastKey.current) return;
    lastKey.current = latest.key;
    if (latch.following) {
      setAnchorKey(latest.key);
      // Whatever the list was doing (a follow, a fold's hold, the foot changing as the box takes the send) gives way
      // to the one glide up, from now. A chat riding the box comes down off it on the same glide, as the room the turn
      // keeps under itself opens.
      stopGlide();
      sending.current = true;
      requestAnimationFrame(() => {
        sending.current = false;
        if (latch.following) glide(SEND_MS);
      });
    }
  }, [latest?.key, glide, stopGlide, latch]);

  // ---------- folds ----------
  const folds = useFolds(chat.id);
  const onFold = useCallback(
    (key: string, open: boolean, header: ViewNode | null) => {
      // Opened or shut by hand: the line you tapped stays under your thumb, and the end isn't taken back meanwhile.
      stopGlide();
      handOn(latch, clock(), 0, true);
      keepUntil.current = clock() + FOLD_MS + 240;
      if (!header) {
        setFold(chat.id, key, open ? true : null);
        return;
      }
      header.measureInWindow((_x, y0) => {
        setFold(chat.id, key, open ? true : null);
        const until = clock() + FOLD_MS + 200;
        const hold = () => {
          header.measureInWindow((_x2, y) => {
            const e = endOf();
            if (e && Math.abs(y - y0) > 0.5) setOffset(e.now + (y - y0));
            if (clock() < until) requestAnimationFrame(hold);
            else {
              const now = endOf();
              if (now && now.distance <= AT_END) latch.following = true;
            }
          });
        };
        requestAnimationFrame(hold);
      });
    },
    [chat.id, setOffset, stopGlide, latch],
  );
  const onFolding = useCallback(() => {
    pinUntil.current = clock() + FOLD_MS + 200;
  }, []);

  // ---------- holding a fold that just finished: a finger down, or reading inside the turn ----------
  const held = useRef<{ key: string; until: "release" | "view" } | null>(null);
  const [, rerender] = useState(0);
  const inView = (key: string) => {
    const st = list.current?.getState();
    const pos = st?.positionByKey(key);
    const size = st?.sizes.get(key);
    if (!st || pos === undefined || !size) return false;
    return pos < st.scroll + st.scrollLength && pos + size > st.scroll;
  };
  const seen = useRef<{ key: string; state: TurnPlan["state"] } | null>(latest ? { key: latest.key, state: latest.state } : null);
  if (latest) {
    const was = seen.current;
    // Decided as the turn ends, in the same frame, so it never folds and then springs open again.
    if (was && was.key === latest.key && (was.state === "live" || was.state === "waiting") && latest.state === "finished") {
      const until = holdOf(latch, { touching: touching.current, began: began.current.at, inView: inView(latest.key) });
      if (until) held.current = { key: latest.key, until };
    }
    seen.current = { key: latest.key, state: latest.state };
  }
  const letGo = () => {
    held.current = null;
    rerender((n) => n + 1);
  };
  const lift = () => {
    touching.current = false;
    const hold = held.current;
    if (hold?.until !== "release") return;
    // Still reading inside it once the finger lifts: it waits on.
    if (holdOf(latch, { touching: false, began: began.current.at, inView: inView(hold.key) })) held.current = { key: hold.key, until: "view" };
    else letGo();
  };

  // ---------- a search hit inside the chat ----------
  const anchor = useAnchor(chat.id);
  const [flashId, setFlashId] = useState<string | null>(null);
  const landed = useRef(false);
  const hitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!anchor || !ready) return;
    const hit = locate(plans, anchor.row);
    if (!hit) {
      setAnchor(chat.id, null);
      return;
    }
    stopGlide();
    latch.following = false;
    paged.current = true;
    scrolled.current = true;
    quietUntil.current = clock() + 1800;
    landed.current = false;
    hitKey.current = hit.key;
    setStart((s) => Math.min(s, hit.index));
    for (const key of hit.folds) setFold(chat.id, key, true);
    setFlashId(anchor.row);
    // A turn the list hasn't drawn yet is scrolled to first, so it draws; the hit itself lands once it has.
    const nudge = setTimeout(() => {
      if (landed.current) return;
      const index = list.current?.getState().indexByKey(hit.key) ?? -1;
      if (index >= 0) void list.current?.scrollToIndex({ index, animated: false });
    }, 120);
    const clear = setTimeout(() => {
      setFlashId(null);
      setAnchor(chat.id, null);
    }, 1800);
    return () => {
      clearTimeout(nudge);
      clearTimeout(clear);
    };
    // Once per anchor, when the list is ready for it.
  }, [anchor?.row, ready]);
  const onFlashView = useCallback(
    (view: ViewNode) => {
      if (landed.current) return;
      landed.current = true;
      // Under the bar, once what paged in above it has settled: placed, then checked once more.
      const place = () =>
        view.measureInWindow((_x, y) => {
          const e = endOf();
          if (e) setOffset(e.now + (y - land));
          // Away from the end now: the jump circle shows. Its dot is only for what grows under you.
          latch.following = false;
          checkAway();
        });
      requestAnimationFrame(() => requestAnimationFrame(place));
      setTimeout(place, 260);
    },
    [land, checkAway, setOffset, latch],
  );
  const flash = useMemo(() => (flashId ? { id: flashId, onView: onFlashView } : null), [flashId, onFlashView]);

  useImperativeHandle(ref, () => ({
    scrollToEnd: (animated = true) => {
      latch.following = true;
      keepUntil.current = 0;
      setAway(false);
      if (animated) glide(SEND_MS);
      else pin();
    },
  }));

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (from > 0) out.push({ kind: "earlier", key: "earlier", count: from });
    plans.slice(from).forEach((plan, i) => {
      const first = i === 0;
      // The first turn loaded says when it was; the rest only when 30 minutes passed.
      const date = plan.date ?? (first && plan.you ? plan.start : null);
      out.push({ kind: "turn", key: plan.key, plan, date, first: first && from === 0, hold: held.current?.key === plan.key });
    });
    return out;
    // `held` is read as it stands each time the plans or the window move, or the hold lifts.
  }, [plans, from, held.current]);

  // The turn you sent sits with its bubble LAND under the bar, clear of the bar's band.
  const anchorIndex = anchorKey ? rows.findIndex((r) => r.key === anchorKey) : -1;
  const anchorRow = anchorIndex >= 0 ? rows[anchorIndex] : undefined;
  const anchorOffset = anchorRow?.kind === "turn" ? land - (anchorRow.first ? 0 : anchorRow.date !== null ? rhythm.dateAbove : rhythm.turnGap) : 0;
  const anchored = useMemo(() => (anchorIndex >= 0 ? { anchorIndex, anchorOffset } : undefined), [anchorIndex, anchorOffset]);

  // ---------- the latest turn shrinking at the end (its fold closing): the end holds in the same frame ----------
  // The list learns a row's new size a frame late, so a fold closing at the end would lift the answer and drop it
  // back on alternate frames. On the web a ResizeObserver hears the turn shrink after layout and before paint, and
  // the list moves with it then; a sent turn's room (anchored end space) already holds its bubble, so not there.
  const latestNode = useRef<{ node: Element; observer: ResizeObserver } | null>(null);
  const watchLatest = useCallback(
    (view: ViewNode | null) => {
      const node = Platform.OS === "web" ? (view as unknown as Element | null) : null;
      if (latestNode.current?.node === node) return;
      latestNode.current?.observer.disconnect();
      latestNode.current = null;
      if (!node || typeof ResizeObserver === "undefined") return;
      let height = node.getBoundingClientRect().height;
      const observer = new ResizeObserver(() => {
        const next = node.getBoundingClientRect().height;
        const delta = next - height;
        height = next;
        if (delta > -0.5 || !latch.following || sending.current || anchoredSpace.current >= 1) return;
        const scroller = list.current?.getScrollableNode() as unknown as HTMLElement | undefined;
        if (!scroller) return;
        // From where the list stood before it shrank, not where it is now: if the list has already taken the new
        // size in (and the browser clamped the offset), this is where it already is.
        const want = Math.max(0, at.current + delta);
        if (Math.abs(scroller.scrollTop - want) > 0.5) scroller.scrollTop = want;
        at.current = want;
        expected.current = want;
      });
      observer.observe(node);
      latestNode.current = { node, observer };
    },
    [latch],
  );
  useEffect(() => () => latestNode.current?.observer.disconnect(), []);

  const refs = useMemo<ThreadRefs>(() => ({ resolve, open: onOpenChat }), [resolve, onOpenChat]);
  const extra = useMemo(() => ({ folds, kids, parent, line: chat.line, phase: chat.phase, moment: chat.moment, settling, ask, flash }), [folds, kids, parent, chat.line, chat.phase, chat.moment, settling, ask, flash]);

  const renderItem = ({ item }: { item: Row }) => {
    if (item.kind === "earlier") {
      return (
        <View style={{ alignItems: "center", paddingHorizontal: 16 }}>
          <Squish label={`Show earlier, ${item.count} ${item.count === 1 ? "turn" : "turns"}`} depth={0.97} onPress={pageIn} style={{ height: touch, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12 }}>
            <Icon name="chevronUp" size={14} color={c.muted} />
            <Text style={[t.body, { fontSize: 15, lineHeight: 20, color: c.muted }]}>
              Earlier · {item.count} {item.count === 1 ? "turn" : "turns"}
            </Text>
          </Squish>
        </View>
      );
    }
    const live = item.plan.state === "live";
    return (
      <View ref={item.plan.latest ? watchLatest : undefined} style={{ paddingHorizontal: 16 }}>
        <TurnView
          plan={item.plan}
          // A chat that only waits (its place waking, its Mac asleep) has no live row: its message says what it waits for.
          line={live && !(item.plan.latest && chat.wait) ? chat.line : null}
          wait={item.plan.latest ? (chat.wait ?? null) : null}
          onResend={onResend}
          settling={live && item.plan.latest && settling}
          current={isCurrent(chat, item.plan)}
          folds={folds}
          onFold={onFold}
          onFolding={onFolding}
          hold={item.hold}
          isNew={isNew}
          date={item.date}
          first={item.first}
          parent={parent}
          kids={kids}
          device={chat.device}
          ask={item.plan.latest ? ask : null}
          flash={flash}
          onOpenChat={onOpenChat}
          onReview={onReview}
          onRetry={onRetry}
        />
      </View>
    );
  };

  // Where you were in a subagent, kept as you leave it.
  const windowFrom = useRef(from);
  windowFrom.current = from;
  useEffect(
    () => () => {
      const st = list.current?.getState();
      if (!chat.parent || !st) return;
      if (latch.following) places.delete(chat.id);
      else places.set(chat.id, { from: windowFrom.current, scroll: st.scroll, at: Date.now() });
    },
    [chat.id, chat.parent],
  );

  const show = useCallback(() => {
    fill();
    const place = saved.current;
    if (place) setOffset(place.scroll);
    requestAnimationFrame(() => {
      measureBlank(true);
      setReady(true);
    });
  }, [fill, setOffset, measureBlank]);
  // Its latest turn has landed: a launch that opened here lets its cover go (src/boot.ts), after the frame that shows it.
  useEffect(() => {
    if (ready) requestAnimationFrame(bootReady);
  }, [ready]);
  // Never left unseen: if the list doesn't say it is ready, it shows anyway.
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 700);
    return () => clearTimeout(timer);
  }, []);

  const web = Platform.OS === "web";
  /** A hand on the list lets go of the end at once, before its first scroll event (or with it, once it moves away). */
  const letGoOfEnd = (up = false) => {
    stopGlide();
    keepUntil.current = 0;
    scrolled.current = true;
    handOn(latch, clock(), endOf()?.distance ?? 0, up);
  };
  return (
    <ThreadRefContext.Provider value={refs}>
      <View
        style={{ flex: 1, opacity: ready ? 1 : 0 }}
        onTouchStart={() => {
          touching.current = true;
        }}
        onTouchMove={() => {
          if (touching.current) latch.handAt = clock();
        }}
        onTouchEnd={() => {
          lift();
          releaseRide();
        }}
        onTouchCancel={() => {
          lift();
          releaseRide();
        }}
        {...(web
          ? {
              onPointerDown: () => (touching.current = true),
              onPointerUp: lift,
              onPointerCancel: lift,
              // A wheel turned up lets go of the end before the list has scrolled.
              onWheel: (e: { nativeEvent?: { deltaY?: number }; deltaY?: number }) => {
                const dy = e.nativeEvent?.deltaY ?? e.deltaY ?? 0;
                if (dy < 0) letGoOfEnd(true);
                else if (dy > 0) latch.handAt = clock();
              },
            }
          : null)}
      >
        <Animated.View style={[{ flex: 1 }, raised]}>
          <LegendList<Row>
            ref={list}
            style={{ flex: 1 }}
            data={rows}
            keyExtractor={(r) => r.key}
            renderItem={renderItem}
            extraData={extra}
            // A turn folded to its answer is about this tall; the Earlier row is exactly a touch row. A sent turn's glide
            // aims at the end as measured each frame, so an estimate never sets where it lands. (Per-kind estimates
            // through getItemType were tried: a row changing kind as it folds makes the list jump to its top.)
            estimatedItemSize={220}
            estimatedHeaderSize={top}
            getFixedItemSize={(r) => (r.kind === "earlier" ? touch : undefined)}
            recycleItems={false}
            // A chat shorter than the screen reads from the top, as Codex and Claude open one: your words under the bar,
            // the room below them. Longer ones open at their end.
            initialScrollAtEnd={!saved.current}
            anchoredEndSpace={anchored}
            maintainVisibleContentPosition={{ data: true, size: true }}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onUserScroll={() => letGoOfEnd()}
            {...(web
              ? null
              : {
                  // A phone's drag is a hand on the list from its start to its end, and its momentum after.
                  // While it drags, the chat holds its ride, so the box going down (the menu put away, the keyboard
                  // following the finger) never moves the content under it; let go, it eases back onto the box.
                  onScrollBeginDrag: () => {
                    dragging.current = true;
                    holdRide();
                    letGoOfEnd();
                    putMenuAway();
                  },
                  onScrollEndDrag: () => {
                    dragging.current = false;
                    latch.handAt = clock();
                    releaseRide();
                  },
                  onMomentumScrollEnd: () => {
                    latch.handAt = clock();
                  },
                })}
            onStartReached={() => {
              // Paged in only once you've scrolled yourself: a chat that opens short doesn't load its past by itself.
              if (scrolled.current && from > 0) pageIn();
            }}
            onStartReachedThreshold={0.15}
            onReady={show}
            onItemSizeChanged={fill}
            onLayout={() => measureBlank()}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              const y = contentOffset.y;
              scrollY.value = y;
              const distance = contentSize.height - (y + layoutMeasurement.height);
              at.current = y;
              // Within 2pt of where the screen put it (a glide, a pin): ours, whatever else is going on.
              const ours = Math.abs(y - expected.current) <= 2;
              if (dragging.current || touching.current) latch.handAt = clock();
              scrolledBy(latch, { now: clock(), distance, ours, hold: keepUntil.current });
              checkAway(distance);
              measureBlank();
              // A turn held open while you read inside it folds once you're back at the end, or it is out of view.
              const hold = held.current;
              if (hold?.until === "view" && (latch.following || !inView(hold.key))) letGo();
            }}
            // The web's list hands unknown props to its div, which has no keyboard to manage.
            {...(web ? null : { keyboardDismissMode: "interactive" as const, keyboardShouldPersistTaps: "handled" as const })}
            {...(Platform.OS === "ios" ? { contentInset: { top: reachTop } } : null)}
            ListHeaderComponent={<View style={{ height: top }} />}
            ListFooterComponent={<View style={{ height: bottom }} />}
          />
        </Animated.View>
      </View>
    </ThreadRefContext.Provider>
  );
});
