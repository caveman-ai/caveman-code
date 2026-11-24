// The main window's half of the notch (docs/): it says what the notch shows and carries out what
// the person does on it, as it counts for the Dock badge (state/notifications.ts). The notch's own page only draws
// (Notch.tsx): it holds no runtime endpoint. Mounted once in the shell; it renders nothing.

import type { Client } from "@caveman-app/session-protocol/client";
import { useBody, useCompanion } from "@caveman-app/ui/mascot/cast";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { rowLine } from "../routes/inbox-model.ts";
import { useNow } from "../routes/settings/Connections.tsx";
import { announce, chatPath } from "../panes/store.ts";
import { useImage } from "../state/media.ts";
import { chatStatuses } from "../state/model.ts";
import {
  chatClientFor,
  requestId,
  useRuntimeClient,
  useRuntimeSelector,
  useSession,
  useSyncHub,
} from "../state/runtime.tsx";
import { hasNotch, setNotchOn, useNotchOn } from "./enabled.ts";
import {
  answerOf,
  askToken,
  cardChat,
  heldChats,
  cardKeys,
  LATER_MS,
  SETTLE_MS,
  settledWaits,
  sightings,
  notchChats,
  pressLedger,
  pressOf,
  previewOf,
  sameState,
  seenWaits,
  SHIP_TEXT,
  unseenWaits,
  waitedSince,
  waitKey,
  type NotchCard,
  type NotchState,
} from "./model.ts";

/** How the cast names a companion the person made (packages/ui mascot/cast.ts). */
const MADE = "custom:";

// ---------------------------------------------------------------------- feed

export function NotchFeed() {
  const on = useNotchOn();
  return hasNotch() && on ? <Feed /> : null;
}

const inFront = () => document.visibilityState === "visible" && document.hasFocus();

/** The app is in front: its window shows and holds the keys. */
function useInFront(): boolean {
  return useSyncExternalStore((listener) => {
    window.addEventListener("focus", listener);
    window.addEventListener("blur", listener);
    document.addEventListener("visibilitychange", listener);
    return () => {
      window.removeEventListener("focus", listener);
      window.removeEventListener("blur", listener);
      document.removeEventListener("visibilitychange", listener);
    };
  }, inFront);
}

function Feed() {
  const bridge = window.cavemanDesktop!.notch!;
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const markSeen = useRuntimeSelector((v) => v.markSeen);
  const inbox = useRuntimeSelector((v) => v.inbox);
  const { client } = useRuntimeClient();
  const hub = useSyncHub();
  const navigate = useNavigate();
  const statuses = useMemo(() => chatStatuses(workspaces), [workspaces]);
  // Read again each minute, so a turn that ended long enough ago leaves the notch without waiting for another event.
  const now = useNow();
  const chats = useMemo(() => notchChats(workspaces, statuses, now), [workspaces, statuses, now]);

  // A wait that comes while the app is in front marks the notch and never opens it: the person is in the app, where
  // the chat list shows it. The notch speaks up only for what comes while they are in another app.
  const front = useInFront();
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const seenNow = seenWaits(
    seen,
    chats.waiting,
    front ? chats.waiting.map((c) => c.workspace.id) : null,
  );
  if (seenNow !== seen) setSeen(seenNow);
  // Only a wait that came while this window ran is news: one from before is marked, never announced, however late
  // its chat reaches the list (the runtime's first answer, a chat on another computer).
  const [startedAt] = useState(() => Date.now());
  const fresh = useMemo(
    () =>
      unseenWaits(
        // As instants, not text: a time from another computer may be written another way.
        chats.waiting.filter((c) => Date.parse(waitedSince(c)) >= startedAt),
        seenNow,
      ),
    [chats, seenNow, startedAt],
  );
  // A wait counts once it has held SETTLE_MS: before that it neither takes the card nor opens the notch.
  const [since, setSince] = useState<ReadonlyMap<string, number>>(() => new Map());
  const sinceNow = sightings(since, fresh, Date.now());
  if (sinceNow !== since) setSince(sinceNow);
  const [settleTick, setSettleTick] = useState(0);
  const unseen = useMemo(
    () => settledWaits(fresh, sinceNow, Date.now()),
    // settleTick: read the clock again once the next wait has held.
    [fresh, sinceNow, settleTick],
  );
  useEffect(() => {
    const due = fresh
      .filter((key) => !unseen.includes(key))
      .map((key) => (sinceNow.get(key) ?? 0) + SETTLE_MS - Date.now());
    if (due.length === 0) return;
    // A little past the soonest, so the clock has surely reached it.
    const timer = window.setTimeout(
      () => setSettleTick((n) => n + 1),
      Math.max(0, Math.min(...due)) + 20,
    );
    return () => window.clearTimeout(timer);
  }, [fresh, sinceNow, unseen]);

  // The card shows the chat the notch last opened for, so a turn that just ended shows what it built; the card's
  // arrows page to another. Nothing on first sight: what waited when the app started is not announced.
  const [heard, setHeard] = useState<ReadonlyArray<string>>(() => unseen);
  const [shown, setShown] = useState<string | null>(null);
  if (heard.join("\n") !== unseen.join("\n")) {
    const came = unseen.find((key) => !heard.includes(key));
    setHeard(unseen);
    const chat = came ? chats.waiting.find((c) => waitKey(c) === came) : undefined;
    if (chat) setShown(chat.workspace.id);
  }

  // A chat on another computer is reached through its own client: its files, its ask and its next turn are there.
  const clientOf = (sessionId: string | null) =>
    hub && sessionId && hub.throughHub(sessionId) ? chatClientFor(hub, sessionId) : client;

  // What the notch shows: a wait that has not held yet is left out, from the card and the mark alike.
  const shownChats = useMemo(
    () => heldChats(chats, new Set(fresh.filter((key) => !unseen.includes(key)))),
    [chats, fresh, unseen],
  );
  // The card's chat, read from its session for what it asks and what it built.
  const place = cardChat(shownChats.waiting, shown);
  const top = place?.chat ?? null;
  const { view } = useSession(top?.workspace.sessionId ?? null);
  const image = usePreview(
    view,
    top?.workspace.id ?? null,
    clientOf(top?.workspace.sessionId ?? null),
  );
  const ask = view?.pendingAsk ?? null;
  // A companion the person made is drawn from the runtime's folder, which the notch's page cannot read: it goes along.
  const pick = useCompanion().character;
  const body = useBody(pick);
  const made = useMemo(
    () => (pick.startsWith(MADE) && body ? { id: pick.slice(MADE.length), body } : null),
    [pick, body],
  );
  // A press that did not go through, said on its chat's card while that chat still waits as it did (waitKey).
  const [trouble, setTrouble] = useState<{
    readonly wait: string;
    readonly text: string;
    readonly n: number;
  } | null>(null);
  const failures = useRef(0);
  /** Each chat's latest press: a failure that comes back for an older one is no news (`fail` below). */
  const ledger = useRef(pressLedger());
  const state = useMemo<NotchState>(() => {
    // An approval's command, exactly as it would run; its prompt only when that says more than the command does.
    const command = top?.status.id === "approve" ? (ask?.waitsOn?.subject ?? null) : null;
    const said = top
      ? top.status.action
        ? (ask?.prompt ?? top.status.detail)
        : rowLine(top.workspace, view).text
      : null;
    const card: NotchCard | null =
      top && place
        ? {
            id: top.workspace.id,
            title: top.workspace.title,
            status: top.status,
            line: said && said !== command ? said : null,
            command,
            image,
            keys: cardKeys(top.workspace, top.status, ask),
            ask: ask ? askToken(ask.id) : null,
            trouble: trouble?.wait === waitKey(top) ? { text: trouble.text, n: trouble.n } : null,
            index: place.index,
            count: shownChats.waiting.length,
            prev: place.prev,
            next: place.next,
          }
        : null;
    return {
      agents: shownChats.marked.map((c) => ({
        id: c.workspace.id,
        title: c.workspace.title,
        status: c.status,
      })),
      card,
      unseen,
      made,
    };
  }, [shownChats, place, top, view, ask, image, unseen, made, trouble]);

  const sent = useRef<NotchState | null>(null);
  useEffect(() => {
    if (sameState(sent.current, state)) return;
    sent.current = state;
    bridge.feed(state);
  }, [bridge, state]);
  // Hidden, or the shell gone (first run, the connect screen): the notch goes too.
  useEffect(() => () => bridge.feed(null), [bridge]);

  // The ask the card shows now: a key answers this one and no other.
  const asking = top && ask ? { workspaceId: top.workspace.id, ask } : null;
  const waiting = shownChats.waiting;
  const onAction = useEffectEvent((raw: unknown) => {
    const action = raw as { type?: unknown; id?: unknown; key?: unknown };
    if (action.type === "hide") return setNotchOn(false);
    // The card's arrows: another chat that waits.
    if (action.type === "show") return setShown(typeof action.id === "string" ? action.id : null);
    const w =
      typeof action.id === "string" ? workspaces.find((x) => x.id === action.id) : undefined;
    const go = () => {
      // The shell showed the window for an open; a key that opens the chat asks for it here.
      window.cavemanDesktop?.showWindow?.();
      window.focus();
      if (w) navigate(chatPath(w.id));
    };
    if (action.type === "open") return go();
    if (action.type !== "press" || typeof action.key !== "string" || !w) return;
    setTrouble(null);
    // The notch folds as it is pressed: a press that does not go through says so on the chat's card, which comes back
    // to show it, with its keys to try again and the card to open the chat (Notch.tsx opens for it).
    const chatWait = waiting.find((c) => c.workspace.id === w.id);
    const latest = ledger.current.press(w.id);
    const fail = (e: unknown) => {
      // The person pressed this chat's card again since: that press is the one in flight, or done, and this failure
      // from before it must not bring the card back over it.
      if (!latest()) return;
      const text = e instanceof Error ? e.message : String(e);
      announce(text);
      if (!chatWait) return;
      failures.current += 1;
      setTrouble({ wait: waitKey(chatWait), text, n: failures.current });
      setShown(w.id);
    };
    const press = pressOf(action.key);
    if (press.do === "open") return go();
    if (press.do === "seen") return markSeen(w.id);
    if (press.do === "later") {
      if (!inbox) return fail("This runtime is too old to snooze: update it.");
      return void inbox(w.id, {
        do: "snooze",
        until: new Date(Date.now() + LATER_MS).toISOString(),
      }).catch(fail);
    }
    const sessionId = w.sessionId;
    const chat = clientOf(sessionId);
    if (!chat || !sessionId) return fail("Not connected to this chat's computer.");
    if (press.do === "answer") {
      // The key names the ask it was drawn for and its option by place: answered elsewhere since, or another ask took
      // its place, and nothing is sent.
      const response = asking?.workspaceId === w.id ? answerOf(asking.ask, press) : null;
      if (!asking || !response)
        return fail("It changed before your answer arrived: nothing was sent.");
      void chat
        .call("ask.respond", {
          request_id: requestId(),
          session_id: sessionId,
          ask_id: asking.ask.id,
          response,
        })
        .catch(fail);
    } else
      void chat
        .call("turn.submit", {
          request_id: requestId(),
          session_id: sessionId,
          kind: "followup",
          input: { text: SHIP_TEXT },
        })
        .then(() => markSeen(w.id), fail);
  });
  useEffect(() => bridge.onAction(onAction), [bridge]);
  return null;
}

// ------------------------------------------------------------------- preview

/** Twice the card's 352 points, for a sharp picture on a Retina screen. */
const PREVIEW_WIDTH = 704;
/** A long page shows its top: at most this tall once scaled. */
const PREVIEW_HEIGHT = 880;

/**
 * The picture a card shows, small enough to hand across to the notch: an https image goes as its address (the notch
 * loads it itself); anything read from the chat's computer is drawn down and sent as a data: address. Null until it
 * is ready, and when the chat's latest turn showed none.
 */
function usePreview(
  view: Parameters<typeof previewOf>[0],
  workspaceId: string | null,
  chat: Client | null,
): string | null {
  const shot = useMemo(() => previewOf(view), [view]);
  // Read through the chat's own client: this window's runtime does not hold a file on another computer.
  const { state } = useImage(shot?.src ?? "", workspaceId, shot?.itemId ?? "", shot !== null, chat);
  const url = shot && state.status === "ready" ? state.url : null;
  const [small, setSmall] = useState<{ readonly url: string; readonly data: string | null } | null>(
    null,
  );
  useEffect(() => {
    if (!url) return;
    let live = true;
    void shrink(url).then(
      (data) => live && setSmall({ url, data }),
      () => live && setSmall({ url, data: null }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return url && small?.url === url ? small.data : null;
}

async function shrink(url: string): Promise<string | null> {
  if (/^https?:/i.test(url)) return url;
  const img = new Image();
  img.src = url;
  await img.decode();
  if (!img.naturalWidth || !img.naturalHeight) return null;
  const scale = Math.min(1, PREVIEW_WIDTH / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.min(Math.round(img.naturalHeight * scale), PREVIEW_HEIGHT);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, Math.round(img.naturalHeight * scale));
  return canvas.toDataURL("image/webp", 0.86);
}
