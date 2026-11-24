// The notch itself (docs/, STYLE.md section 11): one black island hanging from the top centre of
// the screen. At rest it is the screen's own notch with an ear either side (a small pill where the screen has none):
// the companion on the left, the chats' mark on the right. Pointed at, or when a chat comes to need the person, it
// morphs down into the open notch: the chat that waits (what it asks or said, what it built, its keys), and nothing
// else; with no chat waiting it stays folded. It draws what it is told and reports what was done on it; it holds no runtime (state arrives
// from the main window, NotchFeed.tsx, through the desktop shell).
//
// The shape never lays out while it morphs: the band and the open notch's body are both there at their own size, and
// one clip-path travels between the two boxes, with the two inverse corners that join it to the top edge riding along.

import { Button } from "@caveman-app/ui/components/button";
import { ArrowLeft01Icon, ArrowRight01Icon, Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { setMadeCompanions } from "@caveman-app/ui/mascot/cast";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import type { MascotPose } from "@caveman-app/ui/mascot/poses";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { StatusMark } from "../components/StatusMark.tsx";
import { ARM_MS, ARMED, armed, disarmed, pointed, settled, type Guard } from "./guard.ts";
import { OPEN_KEY, type NotchAgent, type NotchCard, type NotchState } from "./model.ts";

/** What the desktop shell gives the notch's page (apps/desktop src/notch-preload.ts). */
export interface NotchBridge {
  onState(handler: (feed: NotchFeedState) => void): void;
  /** The pointer left the window in one move, with no last event to say so. */
  onAway(handler: () => void): void;
  act(
    action:
      | { type: "open"; id?: string }
      | { type: "press"; id: string; key: string }
      | { type: "show"; id: string },
  ): void;
  /** The pointer is over the shape, or off it: off it, the window lets clicks through. */
  over(on: boolean): void;
  menu(): void;
}

export interface NotchFeedState {
  readonly state: NotchState;
  /** The screen's own notch, in points: the island grows out of it. Null on a display that has none. */
  readonly hardware: { readonly width: number; readonly height: number } | null;
  /** The menu bar's height: a pill on a display with no notch is as tall. */
  readonly bar: number;
}

/** An ear beside the screen's notch: the companion's 24 pixels and 8 each side. */
const EAR = 40;
/** The pill on a display with no notch is at least this tall. */
const PILL_HEIGHT = 28;
const REST_RADIUS = 10;
const OPEN_WIDTH = 380;
const OPEN_RADIUS = 24;
/** The inverse corners that join the shape to the top edge, as the screen's own notch has (notch.css draws them this size). */
const FILLET = 8;
/** A pointer passing under the notch on its way to the menu bar opens nothing; one that rests does. */
const OPEN_AFTER_MS = 90;
const SHUT_AFTER_MS = 280;
/** Opened by a chat that needs the person, it stays this long, then folds back to its mark. */
const HOLD_MS = 12_000;

interface Box {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

/**
 * The island at rest and open. At rest: the screen's notch with an ear either side; with no notch, the companion's
 * ear, and a second for the mark once a chat is live. Open: the same band, and the body under it.
 */
export function notchBoxes(
  hardware: NotchFeedState["hardware"],
  bar: number,
  marked: boolean,
  body: number,
): { readonly rest: Box; readonly open: Box } {
  const band = hardware?.height ?? Math.max(bar, PILL_HEIGHT);
  const rest = hardware ? hardware.width + 2 * EAR : marked ? 2 * EAR : EAR;
  return {
    rest: { width: rest, height: band, radius: REST_RADIUS },
    open: { width: OPEN_WIDTH, height: band + body, radius: OPEN_RADIUS },
  };
}

/** What the companion does in its ear: it waves when a chat waits, works while one works, and sleeps otherwise. */
export function earPose(state: NotchState): MascotPose {
  if (state.card)
    return state.card.status.id === "failed"
      ? "error"
      : state.card.status.id === "done"
        ? "done"
        : "wave";
  return state.agents.length > 0 ? "working" : "sleeping";
}

const AT_REST: ReadonlySet<string> = new Set(["failed", "done", "stopped"]);

/**
 * The right ear: the most pressing chat's mark, and how many chats share it once there are two (two need you, three
 * at work). Null with no chat to mark.
 */
export function earMark(
  agents: ReadonlyArray<NotchAgent>,
): { readonly agent: NotchAgent; readonly count: number } | null {
  const first = agents[0];
  if (!first) return null;
  const kind = (a: NotchAgent) =>
    a.status.action ? "needs" : AT_REST.has(a.status.id) ? "rest" : "work";
  return { agent: first, count: agents.filter((a) => kind(a) === kind(first)).length };
}

const NOTHING: NotchState = { agents: [], card: null, unseen: [] };

/** A finger or a pen: a contact that lands, not a pointer that rests. */
const isContact = (type: string | undefined): boolean => type === "touch" || type === "pen";

export function Notch({ bridge, forceOpen = false }: { bridge: NotchBridge; forceOpen?: boolean }) {
  const [feed, setFeed] = useState<NotchFeedState | null>(null);
  /** Pointed at, or opened by a chat: it shows only while it has a card to show (`open` below). */
  const [wants, setOpen] = useState(forceOpen);
  const [size, setSize] = useState({ width: 0, body: 0 });
  /** Counts the waits that opened it: the companion waves again for each. */
  const [waves, setWaves] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const over = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  /** Where the pointer last was, once the shell said it had left without a move. */
  const gone = useRef<{ x: number; y: number } | null>(null);
  /** The unseen waits as last told, null before the first word; and those it is open for now. */
  const told = useRef<ReadonlySet<string> | null>(null);
  const openFor = useRef<ReadonlyArray<string>>([]);
  /** The card and the made companion as last told, as text: a word that changes neither changes nothing under the pointer. */
  const toldCard = useRef<string | null>(null);
  const toldMade = useRef<string | null>(null);
  /** The card's failure count as last told: a new failure, even the same one again, opens the notch to show it. */
  const toldTrouble = useRef<number | null>(null);
  /**
   * When it takes a press (guard.ts). Held outside React's state: a press is judged as it lands, against what the app
   * last said, not against what was last drawn.
   */
  const guard = useRef<Guard>(ARMED);
  /**
   * The same for drawing: the body takes nothing until what changed has been there long enough to be seen (`live`),
   * and its keys take no mouse until the pointer has moved since (`held`), so a key never lights under a resting
   * pointer. The keyboard, an assistive technology, a finger or a pen are not a resting pointer: they reach the keys
   * once `live` (`act`, and the body's own tap below).
   */
  const [live, setLive] = useState(true);
  const [held, setHeld] = useState(false);
  const arming = useRef(0);

  const state = feed?.state ?? NOTHING;
  // The open notch is the card alone: with no chat waiting there is nothing to open to.
  const open = wants && state.card !== null;
  const mark = earMark(state.agents);
  const boxes = notchBoxes(feed?.hardware ?? null, feed?.bar ?? 0, mark !== null, size.body);
  const box = open ? boxes.open : boxes.rest;
  const side = (size.width - box.width) / 2;

  const plan = useEffectEvent((next: boolean, after: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next || forceOpen), after);
  });
  /** Is the pointer on the shape as it stands? Says so to the shell when that changes, and opens or shuts on it. */
  const follow = useEffectEvent(() => {
    const p = pointer.current;
    const on = p !== null && p.x >= side && p.x <= side + box.width && p.y <= box.height;
    if (on === over.current) return;
    over.current = on;
    bridge.over(on);
    plan(on, on ? OPEN_AFTER_MS : SHUT_AFTER_MS);
  });

  const sync = useEffectEvent(() => {
    const next = settled(guard.current, performance.now());
    if (next !== live) setLive(next);
    if (guard.current.moved === held) setHeld(!guard.current.moved);
  });
  /**
   * A word from the app: what the notch shows from now on. Every word is weighed as it arrives, before anything is
   * drawn: a press that lands between this and the next frame is already judged against it.
   */
  const hear = useEffectEvent((next: NotchFeedState) => {
    // A companion the person made comes drawn with the state (model.ts `made`), and the cast takes it when it
    // changed. With none, the cast is told so: the caveman stands in, never an empty ear.
    const made = next.state.made ?? null;
    const madeText = JSON.stringify(made);
    if (madeText !== toldMade.current) {
      toldMade.current = madeText;
      setMadeCompanions(made ? [{ id: made.id, name: "", line: "", body: made.body }] : []);
    }

    // A chat came to need the person: open, hold, then fold back unless the pointer is on it. Only a wait that was
    // not here before opens it: one that is left when a newer one goes was announced already. Never on first sight
    // (the app just opened): what waited before is marked in the ear.
    const before = told.current;
    const unseen = new Set(next.state.unseen);
    told.current = unseen;
    const fresh = before ? next.state.unseen.filter((key) => !before.has(key)) : [];
    // What it opened for was answered or seen elsewhere: it folds now, not when its hold runs out.
    if (openFor.current.length > 0 && !openFor.current.some((key) => unseen.has(key))) {
      openFor.current = [];
      if (!over.current) plan(false, SHUT_AFTER_MS);
    }

    // It opens by itself, or its card changes (another chat's, other keys, a picture that pushes the keys down): the
    // pointer may be at work in another app right where a key now stands. No press counts until the person has had
    // time to see it and has moved the pointer since (guard.ts).
    // Consent is to what is drawn: any change to the card (its chat, its ask, its keys and their order, its arrows, a
    // line that moves the keys) rearms it, the person's own paging included. Paging stands beside the card, so the
    // pointer comes from the arrow to a key: a move, and the moment it takes, is all a paged card asks.
    const nextCard = next.state.card;
    const cardText = JSON.stringify(nextCard);
    const changed = cardText !== toldCard.current;
    toldCard.current = cardText;
    if (changed) disarm();

    // A press that did not go through: the card comes back to say so, with its keys to try again.
    const trouble = nextCard?.trouble?.n ?? null;
    const failed = trouble !== null && trouble !== toldTrouble.current;
    toldTrouble.current = trouble;

    setFeed(next);
    // The app says a wait has come only once it has held (model.ts SETTLE_MS): it opens at once. A failure opens it
    // too, and both may come in one word: neither may swallow the other.
    if (fresh.length === 0 && !failed) return;
    if (!open) disarm();
    // A failure holds it open its whole time, even if the wait that came with it is answered elsewhere meanwhile.
    openFor.current = failed ? [] : fresh;
    if (fresh.length > 0) setWaves((n) => n + 1);
    setOpen(true);
    if (!over.current) plan(false, HOLD_MS);
  });
  /** Its keys take no press until the person has seen what changed and moved the pointer (guard.ts). */
  const disarm = useEffectEvent(() => {
    guard.current = disarmed(performance.now(), pointer.current);
    setLive(false);
    setHeld(true);
    window.clearTimeout(arming.current);
    // A little past the wait, so the clock has surely reached it.
    arming.current = window.setTimeout(() => sync(), ARM_MS + 20);
  });

  useEffect(() => {
    bridge.onState((next) => hear(next));
    bridge.onAway(() => {
      // The page still believes the pointer is where it last moved, and replays a move there whenever the shape
      // changes under it (as it does when it folds): a move at that very spot is not the pointer coming back.
      gone.current = pointer.current;
      pointer.current = null;
      follow();
    });
  }, [bridge]);

  // The window's width and the body's height, measured: the clip travels to the body.
  useLayoutEffect(() => {
    const measure = () =>
      setSize((was) => {
        const next = {
          width: root.current?.clientWidth ?? 0,
          body: bodyRef.current?.offsetHeight ?? 0,
        };
        return next.width === was.width && next.body === was.body ? was : next;
      });
    measure();
    const watch = new ResizeObserver(measure);
    for (const el of [root.current, bodyRef.current]) if (el) watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // The shape may have changed under a still pointer (it folded, or grew): where the pointer is, is asked again
  // after every render.
  useEffect(() => follow());

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const move = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const now = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (gone.current && gone.current.x === now.x && gone.current.y === now.y) return;
      gone.current = null;
      pointer.current = now;
      guard.current = pointed(guard.current, now);
      sync();
      follow();
    };
    const leave = () => {
      pointer.current = null;
      follow();
    };
    window.addEventListener("mousemove", move);
    document.documentElement.addEventListener("mouseleave", leave);
    return () => {
      window.removeEventListener("mousemove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
      window.clearTimeout(timer.current);
      window.clearTimeout(arming.current);
    };
  }, []);

  /**
   * When the last finger or pen came down, and which: a contact that began before the card it lifts on had been seen
   * (it landed on the card before, and the card changed under it) is no press on what it lifts on.
   */
  const contact = useRef<{ readonly id: number; readonly at: number } | null>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (isContact(e.pointerType)) contact.current = { id: e.pointerId, at: performance.now() };
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, []);
  /** The contact `id` came down on the card as it stands, once it had been there long enough to be seen. */
  const landedOnSeen = (id: number): boolean =>
    contact.current?.id === id && settled(guard.current, contact.current.at);
  /**
   * A press that is meant where it lands: the keyboard or an assistive technology (a click with no pointer, detail 0),
   * or a finger or a pen that came down on the card as it stands. Not a mouse, which may rest where a key has just
   * appeared.
   */
  const deliberate = (e: ReactMouseEvent): boolean => {
    const native = e.nativeEvent as Partial<PointerEvent>;
    if (isContact(native.pointerType))
      return native.pointerId !== undefined && landedOnSeen(native.pointerId);
    return e.detail === 0;
  };

  // Anything done on it folds it at once: the next chat that waits never lands its keys under a second click.
  const act = (action: Parameters<NotchBridge["act"]>[0], e: ReactMouseEvent) => {
    // A press it did not earn: it opened or changed by itself, and the pointer has not been moved to it since.
    if (!armed(guard.current, performance.now(), deliberate(e))) return;
    bridge.act(action);
    window.clearTimeout(timer.current);
    setOpen(forceOpen);
  };
  const openChat = (e: ReactMouseEvent, id?: string) =>
    act(id ? { type: "open", id } : { type: "open" }, e);
  // The card's arrows page to another chat that waits, and leave the notch open.
  const show = (id: string, e: ReactMouseEvent) => {
    if (!armed(guard.current, performance.now(), deliberate(e))) return;
    bridge.act({ type: "show", id });
  };
  // A finger or a pen on a held key: the key takes no pointer while held (it must not light under a resting mouse),
  // so the tap lands on the body, which presses the key it landed on once the card has been there long enough.
  const tap = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isContact(e.pointerType) || !held || !live || !landedOnSeen(e.pointerId)) return;
    const key = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")].find((b) => {
      const r = b.getBoundingClientRect();
      return (
        e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom
      );
    });
    key?.click();
  };

  const card = state.card;
  const pose = earPose(state);
  const band = boxes.rest.height;
  const clip = `inset(0px ${Math.max(0, side)}px calc(100% - ${box.height}px) ${Math.max(0, side)}px round 0px 0px ${box.radius}px ${box.radius}px)`;
  const waits = state.agents.filter((a) => a.status.action).length;
  const label =
    waits > 0
      ? `${waits} ${waits === 1 ? "chat needs" : "chats need"} you`
      : state.agents.length > 0
        ? `${state.agents.length} ${state.agents.length === 1 ? "chat" : "chats"} at work`
        : "No chats at work";

  return (
    <div
      ref={root}
      className="notch text-[13px] leading-5 text-foreground"
      data-open={open || undefined}
      data-ready={(feed !== null && size.width > 0) || undefined}
    >
      <div
        className="notch-shape"
        style={{ clipPath: clip }}
        onContextMenu={(e) => {
          e.preventDefault();
          bridge.menu();
        }}
      >
        {/* The band: the screen's notch, with an ear either side. It keeps its place while the notch opens under it. */}
        <button
          type="button"
          tabIndex={-1}
          aria-label={`${label}. Open Caveman Code`}
          className="notch-band"
          style={{ width: boxes.rest.width, height: band }}
          onClick={(e) => openChat(e)}
        >
          <span className="notch-ear">
            {/* A new wait waves again; a still pose holds its first frame. */}
            <Mascot key={waves} pose={pose} animate={pose !== "sleeping"} />
          </span>
          {feed?.hardware ? <span style={{ width: feed.hardware.width }} /> : null}
          {mark || feed?.hardware ? (
            <span className="notch-ear gap-[3px]">
              {mark ? <StatusMark status={mark.agent.status} compact /> : null}
              {mark && mark.count > 1 ? (
                <span className="text-[11px] font-medium leading-none tabular-nums">
                  {mark.count}
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
        <div
          ref={bodyRef}
          className="notch-open"
          style={{ top: band, width: OPEN_WIDTH }}
          inert={!open || !live}
          data-notch-held={held || undefined}
          onPointerUp={tap}
        >
          {/* A key that only opens the chat asks the shell to bring the window forward; any other is the app's to carry out. */}
          {card ? (
            <Card
              key={card.id}
              card={card}
              onShow={show}
              onOpen={(e) => openChat(e, card.id)}
              onPress={(key, e) =>
                key === OPEN_KEY
                  ? openChat(e, card.id)
                  : act({ type: "press", id: card.id, key }, e)
              }
            />
          ) : null}
        </div>
      </div>
      <i
        className="notch-fillet"
        data-at="left"
        style={{ transform: `translateX(${side - FILLET}px)` }}
      />
      <i
        className="notch-fillet"
        data-at="right"
        style={{ transform: `translateX(${side + box.width}px)` }}
      />
    </div>
  );
}

function Card({
  card,
  onOpen,
  onPress,
  onShow,
}: {
  card: NotchCard;
  onOpen: (e: ReactMouseEvent) => void;
  onPress: (key: string, e: ReactMouseEvent) => void;
  onShow: (id: string, e: ReactMouseEvent) => void;
}) {
  const [tall, setTall] = useState(false);
  const paging = card.count > 1;
  return (
    <section className={cn("relative pb-3.5 pt-1.5", paging ? "px-8" : "px-3.5")}>
      {/* The other chats that wait, one press away: an arrow either side, in the card's margin, never over its keys. */}
      {paging ? (
        <>
          <Pager side="prev" to={card.prev} onShow={onShow} />
          <Pager side="next" to={card.next} onShow={onShow} />
        </>
      ) : null}
      <button
        type="button"
        tabIndex={-1}
        onClick={onOpen}
        className="block w-full rounded-md text-left outline-none"
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{card.title}</span>
          {paging ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {card.index + 1}/{card.count}
            </span>
          ) : null}
        </span>
        {card.line ? (
          <span className="line-clamp-2 text-[12.5px] leading-[18px] text-muted-foreground">
            {card.line}
          </span>
        ) : null}
      </button>
      {card.command ? (
        <code className="mt-2 block truncate rounded-md bg-white/[0.07] px-2 py-1 font-mono text-[12px] leading-[18px]">
          {card.command}
        </code>
      ) : null}
      {card.image ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={onOpen}
          aria-label={`Open ${card.title}`}
          className="notch-preview mt-2.5"
        >
          <img
            src={card.image}
            alt=""
            draggable={false}
            data-tall={tall || undefined}
            onLoad={(e) => setTall(e.currentTarget.naturalHeight > e.currentTarget.naturalWidth)}
          />
        </button>
      ) : null}
      {card.trouble ? (
        <p role="alert" className="mt-2 line-clamp-2 text-[12px] leading-[18px] text-destructive">
          {card.trouble.text}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        {card.keys.map((k) => (
          <Button
            key={k.id}
            tabIndex={-1}
            variant={k.tone === "lit" ? "default" : "secondary"}
            className="min-w-0 flex-1 px-2"
            onClick={(e) => onPress(k.id, e)}
          >
            <span className="truncate">{k.label}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}

function Pager({
  side,
  to,
  onShow,
}: {
  side: "prev" | "next";
  to: string | null;
  onShow: (id: string, e: ReactMouseEvent) => void;
}) {
  return (
    <Button
      tabIndex={-1}
      variant="ghost"
      size="icon-sm"
      aria-label={side === "prev" ? "Previous chat" : "Next chat"}
      disabled={to === null}
      className={cn(
        "absolute top-1/2 size-6 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-30",
        side === "prev" ? "left-1" : "right-1",
      )}
      onClick={(e) => to && onShow(to, e)}
    >
      <Icon icon={side === "prev" ? ArrowLeft01Icon : ArrowRight01Icon} className="size-4" />
    </Button>
  );
}
