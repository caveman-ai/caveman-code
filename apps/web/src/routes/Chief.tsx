import { Button } from "@caveman-app/ui/components/button";
import type { ChiefItem, ChiefProfile } from "@caveman-app/session-protocol";
import { Conversation, type ConversationHandle } from "@caveman-app/ui/ai/conversation";
import { Queue } from "@caveman-app/ui/ai/queue";
import { TooltipProvider } from "@caveman-app/ui/components/tooltip";
import { cn } from "@caveman-app/ui/lib/cn";
import { useStableCallback } from "@caveman-app/ui/lib/use-stable-callback";
import {
  Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  PreferenceHorizontalIcon,
  Tick02Icon,
} from "@caveman-app/ui/icons/huge";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { CallBox, CallButton, CallProblem, CallStage, RingMutedPill } from "../call/CallStage.tsx";
import { isPhone, usePhone } from "../lib/screen.ts";
import { callStageOn, clearError, useCall } from "../call/store.ts";
import { type Attachment, chiefPlaceholder, Composer } from "../components/Composer.tsx";
import type { DragPayload } from "../panes/drag.ts";
import { ChiefSprite } from "../components/ChiefSprite.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { formatChord, isComposing, isTypingTarget, SurfaceEmpty } from "../panels/chrome.tsx";
import { panes, recentChat, windowTabs } from "../panes/store.ts";
import { chiefMac, useChief } from "../state/chief.ts";
import { chooseRuntime } from "../state/cloud.ts";
import {
  arrivedJustNow,
  awayLine,
  chiefCards,
  chiefTool,
  itemNote,
  moveItem,
  queuedNotes,
  snapshotOf,
  trayEdit,
  trayEntry,
  trayMove,
  type BoardSnapshot,
  type CaptureMode,
} from "../state/chief-model.ts";
import type { WorkspaceView } from "../state/model.ts";
import {
  requestId,
  useChatList,
  useSession,
  useRuntimeClient,
  useRuntimeLink,
  useRuntimeSelector,
  useSyncHub,
  useWebWindow,
} from "../state/runtime.tsx";
import type { TranscriptItem } from "../state/transcript-model.ts";
import { Approvals } from "./automations/CloudParts.tsx";
import { Marker } from "@caveman-app/ui/ai/message";
import { NARROW_PANE, PanelToggle, SidePanel } from "../panels/SidePanel.tsx";
import { openSurface, getTabs } from "../panels/store.ts";
import { SmartViewToggle } from "../smart-view/SmartViewToggle.tsx";
import { useSmartView } from "../smart-view/useSmartView.ts";
import { chiefRefs } from "./chief/refs.tsx";
import { chiefAtWork, workKey } from "./chief/work-model.ts";
import {
  type Cleared,
  markCleared,
  readCleared,
  saveCleared,
  sectionKey as clearSectionKey,
  sinceCleared,
} from "./chief/sections.ts";
import { WaitingOn } from "../components/pane/WaitingOn.tsx";
import "./chief/work.tsx";
import {
  ChiefActionsProvider,
  ChiefToolCards,
  isChiefTool,
  type ChiefActions,
} from "./chief-cards.tsx";
import { MomentCard, type MomentItem } from "./chief/moments.tsx";
import { ChiefBoxSettings, ChiefPicker, ChiefSheet } from "./chief-sheet.tsx";
import { ChiefIntro, ChiefWelcome } from "./chief-welcome.tsx";
import { UnlockPlans } from "../components/UnlockPlans.tsx";
import { INLINE_OFFER_EVENT } from "../components/Offers.tsx";
import { offersUnlock } from "../components/unlock-model.ts";
import { funnelStep } from "../state/desktop.ts";
import { useAccount } from "./onboarding/data.ts";
import { MISSION_PARAM, useChiefGone, useChiefs } from "../state/chiefs.ts";
import { doneToday, stacksForInbox, type Stack, type StackId } from "./inbox-model.ts";
import { QueueRow, StackGroup, useFresh, useTick } from "./inbox-parts.tsx";
import { MacStep } from "../shell/NeedsMac.tsx";
import { SidebarMenuButton } from "../shell/SidebarToggle.tsx";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

const SEEN_KEY = "caveman.chief.seen";
/** A quiet stretch that earns the next message its own time stamp, as iMessage's do. */
const STAMP_GAP = 15 * 60_000;
const SPLIT_KEY = "caveman.chief.split";
const CLOSED_KEY = "caveman.chief.closed";

/**
 * The Chief: its conversation and its box, and beside them its own side panel, which always holds its Work (the
 * board as a List, a Board or a Library, chief/work.tsx). Everything opened from here opens as a tab: a chat in a
 * desk tab of its own, a review guide or a contract in the panel. The page is a pane of its own, so the Chief's bar
 * is the nav bar, not a chat's.
 *
 * Box: Enter, the Chief decides; ⌥Enter, queue only; ⌘Enter, start now (with ⌘Enter to send, each takes ⌘).
 */
export function ChiefRoute() {
  const { chiefId } = useParams();
  const chief = useChief(chiefId);
  /** What this Chief is called wherever the page names it; a runtime from before names calls it "the Chief". */
  const name = chief.profile?.name ?? "the Chief";
  // ?settings opens its settings sheet (a Chief just made lands here so it can be named).
  const [search, setSearch] = useSearchParams();
  const sheet = search.has("settings");
  /** `section`: where the sheet opens (?settings=projects scrolls to Projects; =name puts you in the name). */
  const setSheet = (open: boolean, section = "") =>
    setSearch(
      (p) => {
        const next = new URLSearchParams(p);
        if (open) next.set("settings", section);
        else next.delete("settings");
        return next;
      },
      { replace: true },
    );
  const { client, status } = useRuntimeClient();
  const everyChat = useRuntimeSelector((v) => v.workspaces);
  const projects = useRuntimeSelector((v) => v.projects);
  // A Chief kept to some projects sees only their chats (its profile's project_ids; none listed is every project).
  const scope = chief.profile?.project_ids;
  const workspaces = useMemo(
    () =>
      scope && scope.length > 0
        ? everyChat.filter((w) => w.projectId !== null && scope.includes(w.projectId))
        : everyChat,
    [everyChat, scope],
  );
  const settings = useRuntimeSelector((v) => v.settings);
  const navigate = useNavigate();
  // The home Chief lives at /chief, whatever link led here (a search hit names its workspace); a Chief that was
  // removed (here or in another window) leaves its page for home.
  const gone = useChiefGone(chiefId);
  useEffect(() => {
    if (chiefId && chief.profile?.home)
      navigate(
        { pathname: "/chief", search: search.size > 0 ? `?${search.toString()}` : "" },
        { replace: true },
      );
    else if (gone) navigate("/chief", { replace: true });
  }, [chiefId, chief.profile?.home, gone]);
  const [notice, setNotice] = useState<{ text: string; error: boolean; undo?: () => void } | null>(
    null,
  );
  const noticeTimer = useRef(0);
  const composer = useRef<HTMLDivElement>(null);
  const conversation = useRef<ConversationHandle>(null);
  useTick(30_000);

  const stacks = stacksForInbox(workspaces, null);
  const done = doneToday(workspaces, stacks);
  const board: Stack[] = done ? [...stacks, done] : stacks;
  // What waits in the box's tray: the board's Queue lives in the Work tab, so the notes you queued stay in view here.
  const queued = queuedNotes(chief.items);
  const away = useAwayLine(workspaces, status === "connected");

  const say = (text: string, error = false, undo?: () => void) => {
    window.clearTimeout(noticeTimer.current);
    setNotice({ text, error, ...(undo ? { undo } : {}) });
    noticeTimer.current = window.setTimeout(
      () => setNotice(null),
      error ? 6000 : undo ? 5000 : 2400,
    );
  };
  const failed = (what: string) => (e: unknown) =>
    say(`${what}: ${e instanceof Error ? e.message : String(e)}`, true);
  const focusBox = () => composer.current?.querySelector("textarea")?.focus();
  // A chat opens in a desk tab of its own; one already open brings its tab forward.
  const open = (id: string) => navigate(windowTabs.openChat(id));

  // Images go with the note, inline, as a chat's turn sends them; the runtime keeps them where every chat's live.
  // The chat the person last had on screen rides along as `showing`, so a note about "that"/"this" names its chat and
  // project to the Chief (the typed-note answer to a call's showing: line).
  const capture = async (
    text: string,
    mode: CaptureMode,
    attachments: ReadonlyArray<Attachment> = [],
  ) => {
    if (!client) throw new Error("Not connected to a runtime");
    // A note sent brings the view to it, as a chat's send does: it rises to the top and the answer fills in below. A
    // queued note only joins the board (no turn in the conversation), so the view stays where it is.
    if (mode !== "queue") conversation.current?.arrive();
    const showing = recentChat(windowTabs.get());
    await client.call("chief.capture", {
      request_id: requestId(),
      text,
      source: "composer",
      mode,
      ...(chief.profile ? { chief_id: chief.profile.id } : {}),
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      ...(showing ? { showing: { workspace_id: showing } } : {}),
    });
  };
  // A chat dragged onto the box joins this Chief's board (chief.attach).
  const attachChat = (chat: DragPayload) => {
    if (!client) return;
    client
      .call("chief.attach", {
        request_id: requestId(),
        workspace_id: chat.workspaceId,
        ...(chief.profile ? { chief_id: chief.profile.id } : {}),
      })
      .then(
        () => say(`Added ${chat.title} to ${name}'s board`),
        failed(`Did not add ${chat.title}`),
      );
  };
  const start = (item: ChiefItem) =>
    client
      ?.call("chief.start", { request_id: requestId(), item_ids: [item.id] })
      // Without a key the item is only marked: the Chief starts it once it has one (runtime chief/handlers.ts chief.start).
      .then(
        () =>
          say(
            chief.availability === "no_key"
              ? `Starts once ${name} has a key: ${item.title ?? item.text}`
              : `Starting ${item.title ?? item.text}`,
          ),
        failed("Did not start"),
      );
  const drop = (item: ChiefItem) => {
    if (!client) return;
    const back = item.state === "proposed" || item.state === "blocked" ? "queued" : null;
    chief.setItems(
      chief.items.map((i) => (i.id === item.id ? { ...i, state: "dropped" as const } : i)),
    );
    client
      .call("chief.items.update", { request_id: requestId(), item_id: item.id, state: "dropped" })
      .then(
        () =>
          say(`Dropped ${item.title ?? item.text}`, false, () => {
            setNotice(null);
            void client
              .call("chief.items.update", {
                request_id: requestId(),
                item_id: item.id,
                state: back ?? "queued",
              })
              .catch(failed("Did not bring it back"));
          }),
        failed("Did not drop it"),
      );
  };
  const move = (id: string, before: string | null) => {
    if (!client) return;
    chief.setItems(moveItem(chief.items, id, before));
    client
      .call("chief.items.reorder", { request_id: requestId(), item_id: id, before_item_id: before })
      .catch(failed("Did not move it"));
  };
  const edit = (id: string, text: string) => {
    if (!client) return;
    chief.setItems(chief.items.map((i) => (i.id === id ? { ...i, text } : i)));
    client
      .call("chief.items.update", { request_id: requestId(), item_id: id, text })
      .catch(failed("Did not change it"));
  };

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const actions = useMemo<Omit<ChiefActions, "answered">>(
    () => ({
      workspaces,
      items: chief.items,
      name: chief.profile?.name ?? "Chief",
      projectName,
      open,
      startAll: async (ids) => {
        if (!client || ids.length === 0) return;
        await client.call("chief.start", { request_id: requestId(), item_ids: [...ids] });
      },
      dismiss: (id) => {
        const item = chief.items.find((i) => i.id === id);
        if (item) drop(item);
      },
      setProjects: async (id, project_ids) => {
        if (!client) throw new Error("Not connected");
        chief.setItems(
          chief.items.map((i) => (i.id === id ? { ...i, project_ids: [...project_ids] } : i)),
        );
        await client.call("chief.items.update", {
          request_id: requestId(),
          item_id: id,
          project_ids: [...project_ids],
        });
      },
      reply: (text) => capture(text, "decide").catch(failed("Did not send")),
      undo: async (id, vid) => {
        if (!client) throw new Error("Not connected");
        const { versions } = await client.call("memory.history", { id });
        if (versions[0]?.vid !== vid) return "changed";
        await client.call("memory.undo", { request_id: requestId(), id });
        return "undone";
      },
    }),
    [workspaces, chief.items, projects, client, chief.profile?.name],
  );

  // Escape, anywhere on the page outside a text field, comes back to the box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.key !== "Escape" ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        isComposing(e)
      )
        return;
      const target = e.target as HTMLElement | null;
      if (
        isTypingTarget(target) ||
        target?.closest('[role="menu"], [role="dialog"], [role="listbox"], [data-side-panel]')
      )
        return;
      focusBox();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Its panel always has its Work, a Work tab never closed (pinned). It is added, not opened: the conversation has the
  // page, as a messenger's does, and the panel's toggle opens the Work.
  const panelId = chief.workspace?.id ?? null;
  useEffect(() => {
    if (!panelId || getTabs(panelId).some((t) => t.kind === "chief-work")) return;
    openSurface(panelId, "chief-work", { chief_id: chiefId }, { focus: false, quiet: true });
  }, [panelId, chiefId]);

  // While it thinks, the box says you guide it (the sidebar's row says Working at the same moment).
  const chiefsList = useChiefs();
  const thinking = chief.profile !== null && chiefsList.working.has(chief.profile.id);
  const placeholder = chiefPlaceholder(
    chief.availability === "no_key",
    chief.profile?.name,
    thinking,
  );
  // In a narrow window the panel floats (SidePanel's NARROW_PANE) over the conversation only: the bar above and the
  // box below stay in reach, so the Chief can always be written to, Work open or not.
  const pane = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth < NARROW_PANE);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const panel = chief.workspace ? <SidePanel workspace={chief.workspace} launcher={false} /> : null;
  // Smart View: what this Chief opens beside its chat, placed by the rules (smart-view/).
  useSmartView(chief.profile?.id ?? panelId, panelId, narrow || isPhone());
  // What a move did, with its Undo: right above the box, gone after a moment.
  const noticeCard = notice ? (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-full z-10 flex justify-center px-6 pb-2"
    >
      <div
        className={cn(
          "pointer-events-auto flex max-w-[560px] items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-[13px] shadow-overlay",
          notice.error ? "text-destructive" : "text-foreground",
        )}
      >
        {notice.error ? null : (
          <Icon icon={Tick02Icon} className="size-3.5 shrink-0" strokeWidth={2} />
        )}
        <span className="truncate">{notice.text}</span>
        {notice.undo ? (
          <Button variant="ghost" size="sm" onClick={notice.undo}>
            Undo
          </Button>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
      <div ref={pane} data-pane className="relative flex min-h-0 flex-1">
        <section aria-label={name} className="relative flex min-w-0 flex-1 flex-col">
          <ChiefPane
            chief={chief}
            chiefId={chiefId}
            away={away}
            actions={actions}
            capture={capture}
            queue={
              queued.length === 0 ? undefined : (
                <Queue
                  items={queued.map((i) => trayEntry(i, chief.items))}
                  onEdit={(id, text) => {
                    const item = queued.find((i) => i.id === id);
                    const words = item ? trayEdit(item, text) : null;
                    if (words !== null) edit(id, words);
                  }}
                  onRemove={(id) => {
                    const item = queued.find((i) => i.id === id);
                    if (item) drop(item);
                  }}
                  onMove={(id, before) => move(id, trayMove(chief.items, id, before))}
                />
              )
            }
            attachChat={attachChat}
            placeholder={placeholder}
            composer={composer}
            conversation={conversation}
            overlay={narrow ? panel : null}
            notice={noticeCard}
            picker={<ChiefPicker chief={chief} onError={(text) => say(text, true)} />}
            onSettings={() => setSheet(true)}
            onProjects={() => setSheet(true, "projects")}
            onRing={() =>
              setSearch(
                (p) => {
                  const next = new URLSearchParams(p);
                  next.set("call", "");
                  return next;
                },
                { replace: true },
              )
            }
            ringing={search.has("call") && chief.status === "ready"}
            onRang={() =>
              setSearch(
                (p) => {
                  const next = new URLSearchParams(p);
                  next.delete("call");
                  return next;
                },
                { replace: true },
              )
            }
          />
          <span role="status" className="sr-only">
            {notice?.text}
          </span>
        </section>
        {narrow ? null : panel}
      </div>
      <ChiefSheet
        chief={chief}
        open={sheet && chief.status === "ready"}
        onOpenChange={(open) => setSheet(open)}
        naming={search.get("settings") === "name"}
        atProjects={search.get("settings") === "projects"}
      />
    </TooltipProvider>
  );
}

/** The Chief's bar, its conversation and its box. Its Work is in the side panel beside it. */
function ChiefPane({
  chief,
  chiefId,
  away,
  actions,
  capture,
  queue,
  attachChat,
  placeholder,
  composer,
  conversation,
  picker,
  onSettings,
  onProjects,
  onRing,
  ringing,
  onRang,
  overlay,
  notice,
}: {
  chief: ReturnType<typeof useChief>;
  /** Which Chief (the route's), absent for the home Chief. */
  chiefId: string | undefined;
  /** The side panel when it floats (a narrow window): over the conversation, never the bar or the box. */
  overlay: ReactNode;
  /** The notice above the box (what a move did, with its Undo). */
  notice: ReactNode;
  /** The Chief's model picker, where a chat's sits. */
  picker: ReactNode;
  /** Opens its settings sheet; onProjects, at its Projects. */
  onSettings: () => void;
  onProjects: () => void;
  /** Rings it, as Call in its ⋯ menu does. */
  onRing: () => void;
  /** ?call: Call from its ⋯ menu, pressed once the page is up. */
  ringing: boolean;
  onRang: () => void;
  away: string | null;
  actions: Omit<ChiefActions, "answered">;
  capture: (text: string, mode: CaptureMode, attachments: Attachment[]) => Promise<void>;
  /** The notes queued to wait, in the box's tray (edit, reorder, drop), whatever is running. */
  queue: ReactNode;
  /** A chat dropped on the box joins this Chief's board. */
  attachChat: (chat: DragPayload) => void;
  placeholder: string;
  composer: React.RefObject<HTMLDivElement | null>;
  /** The conversation's handle: a note sent brings the view to it. */
  conversation: React.RefObject<ConversationHandle | null>;
}) {
  const link = useRuntimeLink();
  const ws = chief.workspace;
  const { view, model, epoch, historyVersion } = useSession(ws?.session_id ?? null);
  const { scope: runtimeScope } = useRuntimeClient();
  const call = useCall();
  const small = usePhone();
  const onCall = callStageOn(call, chief.profile);
  const items = view?.items ?? [];
  const answered = useMemo(() => answeredAsks(items), [items]);
  const value = useMemo(() => ({ ...actions, answered }), [actions, answered]);
  const navigate = useNavigate();
  // Its replies carry its character and name, not the engine's.
  const profile = chief.profile;
  const speaker = useMemo(
    () => (profile ? { name: profile.name, avatar: profile.avatar } : null),
    [profile?.name, profile?.avatar.character, profile?.avatar.tone],
  );
  const draftKey = profile && !profile.home ? `chief:${profile.id}` : "chief";
  // No key or credits: where a plan would run the Chief, the note offers it (counted on its own).
  const noKey = chief.availability === "no_key";
  const { account } = useAccount(noKey);
  const offer = noKey && offersUnlock(account);
  const [unlocking, setUnlocking] = useState(false);
  // On screen only on the welcome (an empty board); the corner card waits meanwhile (components/Offers.tsx).
  const offerShown = offer && chief.status === "ready" && Boolean(ws) && items.length === 0;
  useEffect(() => {
    if (!offerShown) return;
    funnelStep("offer_chief_shown");
    window.dispatchEvent(new CustomEvent(INLINE_OFFER_EVENT, { detail: true }));
    return () => void window.dispatchEvent(new CustomEvent(INLINE_OFFER_EVENT, { detail: false }));
  }, [offerShown]);
  // One place to type: the box has focus when the page opens.
  useEffect(() => composer.current?.querySelector("textarea")?.focus(), [ws?.id]);
  // What it names in its replies ([[12]], #1415) as links to that work, and its separators: a new day, and where you
  // left off (the last time you left this Chief's page, read once as it opens so the line stays put while you read).
  const prefix = workKey(profile);
  // Known once the Chief is: read before its profile came, a named Chief's place was the home one's.
  const readKey = chief.status === "ready" ? `caveman.chief.read.${profile?.id ?? "home"}` : null;
  const readAts = useRef(new Map<string, string | null>());
  if (readKey !== null && !readAts.current.has(readKey))
    readAts.current.set(readKey, localStorage.getItem(readKey));
  const readAt = readKey === null ? null : (readAts.current.get(readKey) ?? null);
  useEffect(() => {
    if (readKey === null) return;
    const save = () => localStorage.setItem(readKey, new Date().toISOString());
    const onVisibility = () => document.visibilityState === "hidden" && save();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", save);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [readKey]);
  // What its chats did since you last looked comes as one group under "While you were away", in place of "New".
  const awayMoments = readAt !== null && items.some((i) => i.kind === "moment" && i.at > readAt);
  // /clear: the page starts a fresh section headed with when, the earlier conversation one click away (chief/sections.ts).
  const sectionKey = clearSectionKey(runtimeScope, profile?.id ?? ws?.id, ws?.session_id);
  const savedClear = useMemo(() => readCleared(sectionKey, epoch), [sectionKey, epoch]);
  const [section, setSection] = useState<{ key: string; mark: Cleared; earlier: boolean } | null>(
    null,
  );
  // A runtime or Chief switch reads its own mark during render, before any history can paint.
  const local =
    section?.key === sectionKey &&
    (epoch === undefined || section.mark.epoch === undefined || epoch === section.mark.epoch)
      ? section
      : null;
  const cleared = local?.mark ?? savedClear;
  const showEarlier = local?.earlier ?? false;
  // Bind a legacy mark once metadata arrives; a later journal rewrite must not reuse its cursor.
  useEffect(() => {
    if (!sectionKey || !cleared || epoch === undefined || cleared.epoch !== undefined) return;
    const mark = { ...cleared, epoch };
    saveCleared(sectionKey, mark);
    setSection({ key: sectionKey, mark, earlier: showEarlier });
  }, [sectionKey, cleared, epoch, showEarlier]);
  const clear = useStableCallback(() => {
    if (!sectionKey || !view) return;
    setSection({
      key: sectionKey,
      mark: markCleared(sectionKey, items, view.cursor, undefined, epoch),
      earlier: false,
    });
  });
  const shown = useMemo(
    () => (showEarlier ? items : sinceCleared(items, cleared, model)),
    [items, cleared, showEarlier, model],
  );
  // A chat with a visible result card shows its screenshots and preview there, not again under the reply that names it.
  const cardedKey = shown
    .flatMap((i) =>
      i.kind === "moment" && i.moment.kind === "result" && i.moment.workspace_id
        ? [i.moment.workspace_id]
        : [],
    )
    .join(" ");
  const carded = useMemo(() => new Set(cardedKey === "" ? [] : cardedKey.split(" ")), [cardedKey]);
  // Each link reads the board itself, so a reply from this morning shows where its work stands now.
  const refs = useMemo(
    () => (ws ? chiefRefs({ prefix, panel: ws.id, chiefId, carded }) : undefined),
    [prefix, ws?.id, chiefId, carded],
  );
  // Between messages, as iMessage stamps them: a new day, or a quiet stretch of STAMP_GAP, gets "Today 06:04" centred
  // over what comes next; where you left off, "New" (or "While you were away") on its hairline.
  const divider = useCallback(
    (at: string, prevAt: string | undefined) => {
      // Under the fresh section's heading the first message needs no stamp of its own when it is the same day.
      const prev = prevAt ?? (cleared && !showEarlier ? cleared.at : undefined);
      const stamp =
        prev === undefined ||
        new Date(at).toDateString() !== new Date(prev).toDateString() ||
        Date.parse(at) - Date.parse(prev) >= STAMP_GAP;
      const fresh = readAt !== null && prev !== undefined && prev <= readAt && at > readAt;
      if (!stamp && !fresh) return null;
      return (
        <div className="flex flex-col gap-4 pb-1 pt-5">
          {stamp ? (
            <p className="text-center text-[11.5px] text-muted-foreground">
              <b className="font-semibold">{dayLabel(at)}</b> {timeLabel(at)}
            </p>
          ) : null}
          {fresh ? (
            <Marker
              variant="separator"
              className="gap-3.5 text-[12.5px] [color:color-mix(in_oklab,hsl(var(--target))_70%,hsl(var(--foreground)))]"
            >
              {awayMoments ? "While you were away" : "New"}
            </Marker>
          ) : null}
        </div>
      );
    },
    [readAt, awayMoments, cleared, showEarlier],
  );
  // Each chat's latest needs-you card: the ones before it were answered, whatever its chat waits on now.
  const askedKey = JSON.stringify(
    items.flatMap((i) =>
      i.kind === "moment" && i.moment.kind === "needs_you" && i.moment.workspace_id
        ? [[i.moment.workspace_id, i.id]]
        : [],
    ),
  );
  const lastAsked = useMemo(
    () => new Map(JSON.parse(askedKey) as Array<[string, string]>),
    [askedKey],
  );
  const moments = useCallback(
    (item: MomentItem) => {
      const m = item.moment;
      const superseded =
        m.kind === "needs_you" &&
        m.workspace_id !== undefined &&
        lastAsked.get(m.workspace_id) !== item.id;
      return ws ? (
        <MomentCard item={item} chiefWorkspaceId={ws.id} superseded={superseded} />
      ) : null;
    },
    [ws?.id, lastAsked],
  );
  // The work that waits on you and the work under way, one click from its list.
  const atWork = chiefAtWork(chief.items, actions.workspaces);
  const showWork = () =>
    ws && openSurface(ws.id, "chief-work", { chief_id: chiefId, view: "list" });

  let body: ReactNode;
  if (chief.status === "elsewhere") body = <ChiefElsewhere />;
  else if (chief.status === "absent")
    body = (
      <Centered>
        <EmptyState pose="sleeping" title="No Chief on this runtime yet">
          Update Caveman Code to turn it on. The board on the right already shows every chat.
        </EmptyState>
      </Centered>
    );
  else if (chief.status === "error")
    body = (
      <Centered>
        <EmptyState pose="error" title={`Can't reach ${chief.profile?.name ?? "the Chief"}`}>
          {/* A refused link closes the client: its "client closed" says nothing the notice above doesn't say better. */}
          {link.refused
            ? "This link was turned down. Use the new one the runtime printed."
            : chief.error}
        </EmptyState>
      </Centered>
    );
  else if (chief.status === "loading" || !ws) body = <div className="flex-1" />;
  else if (items.length === 0)
    body = (
      <>
        {cleared ? (
          <div className="px-6 pt-6">
            <SectionHeading at={cleared.at} />
          </div>
        ) : null}
        <ChiefWelcome
          name={profile?.name ?? "Chief"}
          avatar={profile?.avatar ?? null}
          role={profile?.role}
          scope={profile?.project_ids ?? []}
          onPick={(mission) => capture(mission.note, "decide", [])}
          noKey={noKey}
          onAddKey={() => navigate("/settings/models")}
          onUnlock={
            offer
              ? () => {
                  funnelStep("offer_chief_unlock");
                  setUnlocking(true);
                }
              : undefined
          }
        />
        <UnlockPlans open={unlocking} onOpenChange={setUnlocking} />
      </>
    );
  else
    body = (
      <ChiefActionsProvider value={value}>
        <Conversation
          handle={conversation}
          className="pane-conversation min-h-0 flex-1"
          contentClassName="pl-14 pr-6 pt-2 max-md:px-4"
        >
          <div className="mx-auto max-w-[760px] pb-6">
            {cleared && !showEarlier ? (
              <div className="pb-1 pt-6">
                <SectionHeading
                  at={cleared.at}
                  {...(shown.length < items.length
                    ? {
                        onShowEarlier: () => {
                          if (sectionKey && cleared)
                            setSection({ key: sectionKey, mark: cleared, earlier: true });
                        },
                      }
                    : {})}
                />
              </div>
            ) : null}
 {/* Its greeting heads the conversation from its very start, the card folded (the compact layout). */}
            {!cleared || showEarlier ? (
              <ChiefIntro
                name={profile?.name ?? "Chief"}
                avatar={profile?.avatar ?? null}
                role={profile?.role}
                scope={profile?.project_ids ?? []}
              />
            ) : null}
            <Transcript
              items={shown}
              historyVersion={historyVersion}
              engine="caveman"
              engineLabel="Chief"
              engineIsCaveman
              {...(speaker ? { speaker } : {})}
              running={view?.running ?? false}
              onAnswer={() => undefined}
              cavemanVersion={null}
              sessionId={ws.session_id}
              toolCards={(tools) =>
                tools.every(isChiefTool) ? <ChiefToolCards tools={tools} /> : null
              }
              // What it did is in its words; only what waits on you (a question, chats to start) stays out of the fold.
              keepCards={(tools) =>
                tools.every(isChiefTool) &&
                chiefCards(tools).some((c) => c.kind === "ask" || c.kind === "suggested")
              }
              momentCards={moments}
              workedLines
              messenger
              {...(view ? { reactions: view.reactions } : {})}
              divider={divider}
              {...(refs ? { inlineRefs: refs } : {})}
            />
          </div>
        </Conversation>
      </ChiefActionsProvider>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
 {/* A messenger's bar (compact Bots, bot): who it is in a pill at the top's centre, which opens its settings;
          what it does is said in its conversation and its sidebar row, not here. */}
      <header className="chief-head relative flex h-11 shrink-0 items-center gap-2.5 pl-4 pr-3">
        <SidebarMenuButton />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex h-full items-center justify-center">
          <button
            type="button"
            onClick={chief.status === "ready" ? onSettings : undefined}
            aria-label={`${chief.profile?.name ?? "Chief"}, settings`}
            className="pointer-events-auto flex h-8 max-w-[40%] items-center gap-1.5 rounded-full bg-secondary pl-1.5 pr-3.5 outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            {chief.profile ? (
              <span className="-my-1 flex">
                <ChiefSprite
                  avatar={chief.profile.avatar}
                  pose={view?.running ? "working" : "idle"}
                  animate={view?.running === true}
                />
              </span>
            ) : (
              <Glyph name="chief" className="text-muted-foreground" />
            )}
            <h1 className="min-w-0 truncate text-[13px] font-medium">
              {chief.profile?.name ?? "Chief"}
            </h1>
          </button>
        </div>
        {away ? (
          <p className="relative ml-auto min-w-0 max-w-[30%] truncate text-right text-[13px] text-muted-foreground max-md:hidden">
            {away}
          </p>
        ) : null}
        <span
          className={cn(
            "relative flex shrink-0 items-center gap-1",
            !away && "ml-auto",
            "max-md:ml-auto",
          )}
        >
          {/* Its rings muted: until when, what arrived quietly, one click to unmute. */}
          <RingMutedPill />
          {chief.availability === "no_key" && items.length > 0 ? (
            <button
              type="button"
              onClick={() => navigate("/settings/models")}
              className="shrink-0 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Capture only: add a key
            </button>
          ) : null}
          {chief.status === "ready" ? (
            <button
              type="button"
              aria-label={`${chief.profile?.name ?? "Chief"} settings`}
              title="Settings"
              onClick={onSettings}
              className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={PreferenceHorizontalIcon} className="size-4" />
            </button>
          ) : null}
          {chief.status === "ready" ? <SmartViewToggle /> : null}
          {ws ? <PanelToggle workspaceId={ws.id} /> : null}
        </span>
      </header>
      {/* The conversation takes what is left and scrolls; the floating panel covers only it. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {body}
        {overlay}
      </div>
      {chief.status === "absent" || chief.status === "elsewhere" ? null : (
        // Under a chat the composer shares the conversation's centre (its pl-14 pr-6 gutters, less 16px a side) and is 32px
        // wider than its 760px column: 16px past each edge, as in every chat (PaneFrame). Over the welcome, centred
        // between the sidebar and the rail, it is centred as the welcome is. It never shrinks: however long the
        // conversation, the box keeps its height and the conversation scrolls.
        <div
          ref={composer}
          className={cn(
            "relative w-full shrink-0 pb-4 max-md:px-2 max-md:pb-2",
            items.length > 0 || cleared ? "pl-10 pr-2" : "px-4",
          )}
        >
          {notice}
          <div className="mx-auto max-w-[792px]">
            <CallProblem
              state={call}
              onKey={() => navigate("/settings/chief")}
              onDismiss={() => chief.client && clearError(chief.client)}
            />
            {onCall ? (
              // The box becomes the call; on a phone the call takes the whole screen.
              small ? (
                <CallStage state={call} {...(chief.profile ? { name: chief.profile.name } : {})} />
              ) : (
                <CallBox state={call} {...(chief.profile ? { name: chief.profile.name } : {})} />
              )
            ) : (
              <Composer
                // One box per Chief: switching Chiefs reuses this page, and a box kept across them would carry one's draft into the other's.
                key={draftKey}
                draftKey={draftKey}
                {...(chief.profile ? { captureTo: chief.profile.name } : {})}
                running={false}
                engineLabel="Chief"
                canSteer={false}
                onSubmit={async () => undefined}
                onInterrupt={async () => undefined}
                onCapture={capture}
                onClear={sectionKey && view ? clear : "Wait for the Chief to load before clearing."}
                queue={queue}
                // What waits on you and what works, on the box's top edge with the queue, as a chat's agents are.
                strip={
                  atWork.length > 0 ? (
                    <WaitingOn agents={atWork} noun={["task", "tasks"]} onOpen={showWork} />
                  ) : undefined
                }
                onAttachChat={{
                  label: `Add to ${chief.profile?.name ?? "the Chief"}`,
                  attach: attachChat,
                }}
                placeholder={placeholder}
                captureAccessory={picker}
                captureSettings={
                  chief.status === "ready" ? (
                    <ChiefBoxSettings
                      chief={chief}
                      onSettings={onSettings}
                      onProjects={onProjects}
                    />
                  ) : null
                }
                captureCall={
                  <CallButton
                    voice={chief.voice}
                    onNeedsKey={() => navigate("/settings/chief")}
                    {...(chief.profile
                      ? { chief: { id: chief.profile.id, name: chief.profile.name } }
                      : {})}
                    ring={ringing}
                    onRang={onRang}
                  />
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A fresh section's heading (/clear): its day and time, and while the earlier conversation is out of view, the way back. */
function SectionHeading({ at, onShowEarlier }: { at: string; onShowEarlier?: () => void }) {
  return (
    <Marker variant="separator" className="gap-3 [color:hsl(var(--subtle-foreground))]">
      <span>
        <b className="font-medium text-muted-foreground">{dayLabel(at)}</b> {dateLabel(at)},{" "}
        {timeLabel(at)}
      </span>
      {onShowEarlier ? (
        <button
          type="button"
          onClick={onShowEarlier}
          className="shrink-0 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Show earlier
        </button>
      ) : null}
    </Marker>
  );
}

/** A day separator's word: Today, Yesterday, else the weekday. */
function dayLabel(at: string): string {
  const day = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "long" });
}

/** And its date beside it, quieter: "Wed 28 Oct". */
const dateLabel = (at: string): string =>
  new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** And the time, for a fresh section: "14:32" or "2:32 PM", as the person's clock reads. */
const timeLabel = (at: string): string =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function Centered({ children }: { children: ReactNode }) {
  return <div className="grid min-h-0 flex-1 place-items-center px-6">{children}</div>;
}

/** The Chief's asks you have already answered: a message of yours came after them. */
function answeredAsks(items: ReadonlyArray<TranscriptItem>): ReadonlySet<string> {
  const lastUser = items.findLastIndex((i) => i.kind === "user");
  const out = new Set<string>();
  items.forEach((it, i) => {
    if (i < lastUser && it.kind === "tool" && chiefTool(it.name) === "ask") out.add(it.id);
  });
  return out;
}

/**
 * "While you were away: …": the board as you left it (saved when you leave
 * the page or the app goes to the background) against the board now.
 */
function useAwayLine(workspaces: ReadonlyArray<WorkspaceView>, ready: boolean): string | null {
  const [line, setLine] = useState<string | null>(null);
  const latest = useRef(workspaces);
  latest.current = workspaces;
  const ran = useRef(false);
  useEffect(() => {
    if (!ready || ran.current) return;
    ran.current = true;
    setLine(awayLine(readSeen(), workspaces));
  }, [ready, workspaces]);
  useEffect(() => {
    const save = () => localStorage.setItem(SEEN_KEY, JSON.stringify(snapshotOf(latest.current)));
    const onVisibility = () => {
      if (document.visibilityState === "hidden") save();
      else setLine((now) => awayLine(readSeen(), latest.current) ?? now);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", save);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", save);
      if (ran.current) save();
    };
  }, []);
  return line;
}

function readSeen(): BoardSnapshot | null {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null") as BoardSnapshot | null;
    return v && typeof v.at === "string" && v.states && typeof v.states === "object" ? v : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- the board

export function Board({
  stacks,
  queue,
  items,
  onOpen,
  onStart,
  onDrop,
  onMove,
  onBox,
  approvals,
  name = "the Chief",
}: {
  /** Automation runs stopped at an approval gate, on this Mac and on Cloud, above the chats. */
  approvals?: ReactNode;
  /** The Chief whose board it is, by name. */
  name?: string;
  stacks: ReadonlyArray<Stack>;
  queue: ReadonlyArray<ChiefItem>;
  items: ReadonlyArray<ChiefItem>;
  onOpen: (workspaceId: string) => void;
  onStart: (item: ChiefItem) => void;
  onDrop: (item: ChiefItem) => void;
  onMove: (id: string, before: string | null) => void;
  onBox: () => void;
}) {
  const [closed, setClosed] = useState<ReadonlySet<StackId>>(() => readClosed());
  const [split, setSplit] = useState(readSplit);
  const top = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const running = stacks.reduce((n, s) => n + s.rows.length, 0);
  // The header counts chats still in play; Done today sits under it but is finished.
  const live = running - (stacks.find((s) => s.id === "done")?.rows.length ?? 0);
  // Running takes what it needs, up to the remembered split when the Queue holds something too; the Queue sits right
  // under it and takes the rest. An empty half is one line, and free room is only ever at the rail's foot, never a band between.
  const both = running > 0 && queue.length > 0;
  const toggle = (id: StackId) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
      return next;
    });
  const firstRow = stacks.find((s) => s.rows.length > 0)?.rows[0]?.workspace.id;

  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <div
        ref={top}
        className="flex min-h-0 flex-[0_1_auto] flex-col"
        style={both ? { maxHeight: `${split * 100}%` } : undefined}
      >
        <RailHeader label="Running" count={live} />
        {approvals}
        {running > 0 ? (
          <div className="min-h-0 flex-auto overflow-y-auto pb-2">
            {stacks.map((s) => (
              <StackGroup
                key={s.id}
                stack={s}
                closed={!s.decision && closed.has(s.id)}
                onToggle={s.decision ? null : () => toggle(s.id)}
              >
                {s.rows.map((r) => (
                  <QueueRow
                    key={r.workspace.id}
                    row={r}
                    stack={s.id}
                    open={false}
                    tabStop={r.workspace.id === firstRow}
                    fresh={false}
                    spend={undefined}
                    onOpen={() => onOpen(r.workspace.id)}
                  />
                ))}
              </StackGroup>
            ))}
          </div>
        ) : (
          <SurfaceEmpty title="No chats yet" className="flex-none py-6">
            The ones {name} starts, and yours, show here.
          </SurfaceEmpty>
        )}
      </div>
      {both ? (
        <RowSplitter host={top} box={box} onChange={setSplit} />
      ) : (
        <div className="border-t border-border" />
      )}
      <section aria-label="Queue" className="flex min-h-[88px] flex-1 flex-col">
        <RailHeader
          label="Queue"
          count={queue.length}
          suggested={queue.filter((i) => i.state === "proposed").length}
        />
        {queue.length > 0 ? (
          <QueueList
            items={queue}
            board={items}
            onStart={onStart}
            onDrop={onDrop}
            onMove={onMove}
            onEscape={onBox}
          />
        ) : (
          <SurfaceEmpty title="Nothing waiting" className="flex-none py-6">
            {formatChord("alt+enter")} in the box queues a note without starting it.
          </SurfaceEmpty>
        )}
      </section>
    </div>
  );
}

/**
 * A half's title, at the height of the Chief's own header so the two read as one bar: sentence case, its count
 * beside it, and what you can do on the right. `suggested`: how many wait on you (proposed); the word pops when
 * that rises, so a Suggested chat is seen even when the Queue sits low in the rail.
 */
function RailHeader({
  label,
  count,
  suggested = 0,
  children,
}: {
  label: string;
  count: number;
  suggested?: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 pl-4 pr-2.5">
      <h2 className="text-[13px] font-medium text-foreground">{label}</h2>
      {count > 0 ? (
        <span className="text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]">
          {count}
        </span>
      ) : null}
      {suggested > 0 ? (
        <span
          key={suggested}
          className="chief-badge-in flex items-center gap-1.5 text-[12px] text-warning"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          {suggested} suggested
        </span>
      ) : null}
      <span className="ml-auto flex items-center">{children}</span>
    </div>
  );
}

function readClosed(): ReadonlySet<StackId> {
  try {
    const v = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '["done"]') as unknown;
    return new Set(Array.isArray(v) ? (v.filter((x) => typeof x === "string") as StackId[]) : []);
  } catch {
    return new Set();
  }
}

const readSplit = () => {
  const v = Number(localStorage.getItem(SPLIT_KEY));
  return v >= 0.15 && v <= 0.85 ? v : 0.5;
};

/**
 * The line between Running and the Queue: drag it (or ↑/↓ on it) to give one
 * half more room, double-click for half and half. Remembered on this device.
 * SidePanel's ResizeEdge, turned to rows: the pointer writes Running's
 * height cap straight to the element, React hears only the result.
 */
function RowSplitter({
  host,
  box,
  onChange,
}: {
  host: React.RefObject<HTMLElement | null>;
  box: React.RefObject<HTMLElement | null>;
  onChange: (split: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const save = (split: number) => {
    const v = Math.min(0.85, Math.max(0.15, split));
    localStorage.setItem(SPLIT_KEY, String(v));
    onChange(v);
    return v;
  };
  const share = (px: number) => px / (box.current?.clientHeight || 1);
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize Running and Queue"
      tabIndex={0}
      onPointerDown={(e) => {
        const el = host.current;
        const total = box.current?.clientHeight ?? 0;
        if (e.button !== 0 || !el || !total) return;
        e.preventDefault();
        const startY = e.clientY;
        const startH = el.getBoundingClientRect().height;
        let h = startH;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        setDragging(true);
        document.body.style.cursor = "row-resize";
        const move = (ev: PointerEvent) => {
          h = Math.min(total * 0.85, Math.max(total * 0.15, startH + ev.clientY - startY));
          el.style.maxHeight = `${h}px`;
        };
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
          target.removeEventListener("pointercancel", up);
          target.removeEventListener("lostpointercapture", up);
          document.body.style.cursor = "";
          setDragging(false);
          // The same value React renders next, so the cap holds even when the split did not change.
          if (h !== startH) el.style.maxHeight = `${save(h / total) * 100}%`;
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
        target.addEventListener("lostpointercapture", up);
      }}
      onDoubleClick={() => save(0.5)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const h = host.current?.getBoundingClientRect().height ?? 0;
        save(share(h + (e.key === "ArrowUp" ? -24 : 24)));
      }}
      className="group relative z-10 h-px shrink-0 cursor-row-resize bg-border outline-none"
    >
      <div
        className={cn(
          "absolute inset-x-0 -top-1 h-2 transition-colors duration-150",
          "group-focus-visible:bg-ring/40",
        )}
      />
      <div
        className={cn(
          "absolute inset-x-0 top-0 h-px transition-colors duration-150",
          dragging ? "bg-foreground/40" : "group-hover:bg-foreground/20",
        )}
      />
    </div>
  );
}

// ------------------------------------------------------------------- the Queue

const ITEM_ICON: Record<
  ChiefItem["state"],
  "state-queued" | "state-sleeping" | "state-needs-input"
> = {
  unsorted: "state-queued",
  queued: "state-queued",
  proposed: "state-needs-input",
  blocked: "state-queued",
  scheduled: "state-sleeping",
  started: "state-queued",
  review: "state-queued",
  needs_you: "state-needs-input",
  done: "state-queued",
  dropped: "state-queued",
};

/**
 * The Queue as a list you reorder: drag an item (SidePanel's tab drag, on the
 * Y axis) or ⌥↑/⌥↓ on it (the per-session Queue's keys and onMove contract:
 * move `id` before `beforeId`, null to the end). ↑/↓ walk, ⌘Enter starts, E drops.
 */
function QueueList({
  items,
  board,
  onStart,
  onDrop,
  onMove,
  onEscape,
}: {
  items: ReadonlyArray<ChiefItem>;
  board: ReadonlyArray<ChiefItem>;
  onStart: (item: ChiefItem) => void;
  onDrop: (item: ChiefItem) => void;
  onMove: (id: string, beforeId: string | null) => void;
  onEscape: () => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<{
    id: string;
    from: number;
    startY: number;
    els: HTMLElement[];
    rects: DOMRect[] | null;
    target: number;
  } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const tabStop = items.some((i) => i.id === focused) ? focused : items[0]?.id;

  const els = () => [...(list.current?.querySelectorAll<HTMLElement>("[data-item]") ?? [])];
  const focusAt = (i: number) => els()[Math.max(0, Math.min(items.length - 1, i))]?.focus();
  /** Move by one place: up goes before the previous item; down before the one after the next (or to the end). */
  const step = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    onMove(items[i]!.id, dir === -1 ? items[j]!.id : (items[i + 2]?.id ?? null));
    requestAnimationFrame(() => focusAt(j));
  };

  const reset = (all: HTMLElement[]) => {
    for (const el of all) {
      el.style.transition = "transform 150ms var(--ease-snap)";
      el.style.transform = "";
      el.style.zIndex = "";
    }
    setTimeout(() => all.forEach((el) => (el.style.transition = "")), 160);
  };

  return (
    <ol
      ref={list}
      aria-label="Queue items"
      className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2"
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = e.clientY - d.startY;
        if (!d.rects) {
          if (Math.abs(dy) < 5) return;
          d.rects = d.els.map((el) => el.getBoundingClientRect());
        }
        const me = d.rects[d.from]!;
        const gap =
          d.rects.length > 1 ? Math.max(0, (d.rects[1]!.top - d.rects[0]!.bottom) | 0) : 0;
        const center = me.top + me.height / 2 + dy;
        let target = 0;
        d.rects.forEach((r, j) => {
          if (j !== d.from && center > r.top + r.height / 2) target++;
        });
        d.target = target;
        d.els.forEach((el, j) => {
          if (j === d.from) {
            el.style.transition = "none";
            el.style.transform = `translateY(${dy}px)`;
            el.style.zIndex = "1";
            return;
          }
          const shift =
            d.from < target && j > d.from && j <= target
              ? -(me.height + gap)
              : d.from > target && j >= target && j < d.from
                ? me.height + gap
                : 0;
          el.style.transition = "transform 150ms var(--ease-snap)";
          el.style.transform = shift ? `translateY(${shift}px)` : "";
        });
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (!d?.rects) return;
        reset(d.els);
        if (d.target === d.from) return;
        onMove(d.id, d.target > d.from ? (items[d.target + 1]?.id ?? null) : items[d.target]!.id);
      }}
      onPointerCancel={() => {
        const d = drag.current;
        drag.current = null;
        if (d?.rects) reset(d.els);
      }}
    >
      {items.map((item, i) => (
        <QueueItem
          key={item.id}
          item={item}
          i={i}
          note={itemNote(item, board)}
          tabStop={item.id === tabStop}
          onFocus={() => setFocused(item.id)}
          els={els}
          drag={drag}
          step={step}
          focusAt={focusAt}
          count={items.length}
          onStart={onStart}
          onDrop={onDrop}
          onEscape={onEscape}
        />
      ))}
    </ol>
  );
}

function QueueItem({
  item,
  i,
  note,
  tabStop,
  onFocus,
  els,
  drag,
  step,
  focusAt,
  count,
  onStart,
  onDrop,
  onEscape,
}: {
  item: ChiefItem;
  i: number;
  note: string | null;
  tabStop: boolean;
  onFocus: () => void;
  els: () => HTMLElement[];
  drag: React.MutableRefObject<{
    id: string;
    from: number;
    startY: number;
    els: HTMLElement[];
    rects: DOMRect[] | null;
    target: number;
  } | null>;
  step: (i: number, dir: -1 | 1) => void;
  focusAt: (i: number) => void;
  count: number;
  onStart: (item: ChiefItem) => void;
  onDrop: (item: ChiefItem) => void;
  onEscape: () => void;
}) {
  // A Suggested chat that just landed glows once in the rail too (inbox.css), the same way the card does in the transcript.
  const { fresh, seen } = useFresh(item.state === "proposed" && arrivedJustNow(item.updated_at));
  return (
    <li
      data-item={item.id}
      data-fresh={fresh || undefined}
      onPointerEnter={seen}
      tabIndex={tabStop ? 0 : -1}
      aria-label={item.title ?? item.text}
      onFocus={() => {
        seen();
        onFocus();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        drag.current = {
          id: item.id,
          from: i,
          startY: e.clientY,
          els: els(),
          rects: null,
          target: i,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || isComposing(e)) return;
        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown"))
          step(i, e.key === "ArrowUp" ? -1 : 1);
        else if (e.key === "ArrowDown" || e.key === "ArrowUp")
          focusAt(i + (e.key === "ArrowDown" ? 1 : -1));
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onStart(item);
        else if (e.key.toLowerCase() === "e" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          onDrop(item);
          focusAt(i + 1 < count ? i : i - 1);
        } else if (e.key === "Escape") onEscape();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      className={cn(
        "group relative flex min-h-8 cursor-grab touch-none select-none items-start gap-2.5 rounded-md bg-background px-2 py-1.5 outline-none transition-[color,background-color,box-shadow] duration-75 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing",
        fresh && "chief-suggested-in chief-fresh duration-300",
      )}
    >
 {/* Suggested items wait on you: minimal unread dot, amber. Everything else keeps a quiet glyph. */}
      {item.state === "proposed" ? (
        <span aria-hidden className="grid size-4 h-5 shrink-0 place-items-center">
          <span className="size-1.5 rounded-full bg-warning" />
        </span>
      ) : (
        <Glyph
          name={ITEM_ICON[item.state]}
          className="mt-0.5 shrink-0 text-[hsl(var(--subtle-foreground))]"
        />
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[13px] leading-5",
            item.state === "unsorted" ? "text-foreground/70" : "text-foreground",
          )}
          title={item.text}
        >
          {item.title ?? item.text}
        </span>
        {note ? (
          <span
            className={cn(
              "block truncate text-[12px] leading-4",
              item.state === "proposed"
                ? "text-muted-foreground"
                : "text-[hsl(var(--subtle-foreground))]",
            )}
          >
            {note}
          </span>
        ) : null}
      </span>
      {item.pinned ? (
        <Glyph
          name="bookmark"
          label="Pinned: it stays where you put it"
          className="mt-0.5 shrink-0 text-muted-foreground group-hover:hidden group-focus-visible:hidden"
        />
      ) : null}
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-visible:flex">
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onStart(item)}
          className="h-6 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground"
        >
          Start
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Drop"
          title="Drop (E)"
          onClick={() => onDrop(item)}
          className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground"
        >
          <Icon icon={Cancel01Icon} className="size-3.5" />
        </button>
      </span>
    </li>
  );
}

/**
 * A web tab with nothing picked talks to a Cloud computer, where no Chief is made (K2): the person's Chief is on their
 * Mac. Until that Mac is ready for this browser the page shows the step that gets it there, as every page the Mac
 * answers does (shell/NeedsMac.tsx); then one button picks it for this tab (no reload). The board beside still shows
 * every chat.
 */
function ChiefElsewhere() {
  const web = useWebWindow();
  const list = useChatList(useSyncHub());
  const mac = chiefMac(list?.runtimes.values() ?? []);
  if (web && web.mac.kind !== "ready")
    return (
      <Centered>
        <MacStep page="chief" web={web} />
      </Centered>
    );
  return (
    <Centered>
      <EmptyState
        pose="sleeping"
        title="Your Chief is on your Mac"
        action={
          mac ? (
            <Button type="button" size="sm" onClick={() => chooseRuntime(localStorage, mac)}>
              Talk to it on {mac.name}
            </Button>
          ) : undefined
        }
      >
        {mac
          ? "This tab is talking to a Cloud computer, which has no Chief."
          : "This tab is talking to a Cloud computer, which has no Chief. Open Caveman Code on your Mac to start it."}
      </EmptyState>
    </Centered>
  );
}
