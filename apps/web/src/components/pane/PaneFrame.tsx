import { Button } from "@caveman-app/ui/components/button";
import type { Client, Result, Workspace } from "@caveman-app/session-protocol";
import { Conversation, type ConversationHandle } from "@caveman-app/ui/ai/conversation";
import { Queue } from "@caveman-app/ui/ai/queue";
import { ConfirmDialog } from "@caveman-app/ui/components/confirm-dialog";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import { Icon, Cancel01Icon, Target02Icon } from "@caveman-app/ui/icons/huge";
import { Activity, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStableCallback } from "@caveman-app/ui/lib/use-stable-callback";
import { useNavigate } from "react-router";
import { PrMark } from "../../routes/review/parts.tsx";
import { openPr } from "../../routes/review/surface.tsx";
import { buildPrompt, type AskReply } from "../../state/grill.ts";
import { Composer, useTurnChoice, type Attachment, type SubmitKind, type TurnChoice } from "../Composer.tsx";
import { usePublishOffer } from "./PublishOffer.tsx";
import { composeIn } from "../compose-event.ts";
import { ArtifactTemplateComposerProvider } from "../artifact-template-composer.tsx";
import { EngineSignInCard, needsEngineSignIn, useEngineThere } from "../cloud/EngineSignIn.tsx";
import { RecordSkillDialog } from "../RecordSkillDialog.tsx";
import { draftFromWire, relink } from "../thread-refs.ts";
import { promptEntries } from "../prompt-history.ts";
import { Transcript } from "../Transcript.tsx";
import { VendorMark } from "@caveman-app/ui/components/model-picker";
import { PickLabel, pickCopy, RunnerMark, RunnerModel } from "@caveman-app/ui/components/runner-badge";
import { childRunner, runnerFor } from "../../state/runner.ts";
import { EngineMark } from "../transcript/marks.tsx";
import { PanelMessage } from "../WorkspacePanels.tsx";
import { holds } from "./hold.ts";
import { FloatingScreen } from "../../panels/live/FloatingScreen.tsx";
import { SidePanel } from "../../panels/SidePanel.tsx";
import { runInTerminal } from "../../panels/terminal/run.ts";
import { getPanel, setPanelOpen } from "../../panels/store.ts";
import { useOpenSurface } from "../../panels/navigation.tsx";
import { beginDrag } from "../../panes/drag.ts";
import { announce, closePane, panes, useChatTab, useLayout, useWarmChat, windowTabs } from "../../panes/store.ts";
import { usePaneSlot } from "../../panes/slot.ts";
import { useShowChat } from "../../shell/show-chat.ts";
import { useTabNav } from "../../shell/tab-nav.ts";
import { useInbox } from "../../shell/InboxItems.tsx";
import { leaves, type Pane } from "../../panes/tree.ts";
import { NewChat } from "../../routes/NewChat.tsx";
import { agentsAtWork } from "../../state/now.ts";
import type { WorkspaceView } from "../../state/model.ts";
import { ChatClientScope, chatClientFor, prefetchSession, requestId, sameItems, submittedMessageId, useChatList, useEveryChatSelector, useRuntimeClient, useRuntimeSelector, useSession, useSessionReady, useSyncHub } from "../../state/runtime.tsx";
import { chatWorkspace, formerRoot, whereOf } from "../../state/sync/chats-view.ts";
import type { ChatListSnapshot } from "../../state/sync/chat-list.ts";
import type { ChatSummary } from "../../state/sync/wire.ts";
import { SyncLine } from "./SyncLine.tsx";
import { AnsweredElsewhere, answeredElsewhere } from "../../state/sync/sender.ts";
import { declineForRedirect, noteTarget, RedirectHeld, waitingApprovals } from "../../state/redirect.ts";
import { latency } from "../../state/sync/latency.ts";
import { usePeeked } from "../../state/peek.ts";
import { exportName, transcriptMarkdown } from "../../state/transcript-export.ts";
import { download } from "../../lib/download.ts";
import { PaneHeader } from "./PaneHeader.tsx";
import { CloudLoginNotice, ContinueHere, ContinueOnThisMac, HeldSettingsCard, MovedCard, MovesNotice, WhereItRuns } from "./Moves.tsx";
import { TabPane } from "./TabPane.tsx";
import { SourceLines, SourceNames, useChatSources } from "../sources/parts.tsx";
import { addableSources, sourceLine } from "../../state/sources.ts";
import { SetupProposalNotice } from "../environment/SetupProposalNotice.tsx";
import { WaitingOn } from "./WaitingOn.tsx";
import { queuedSender } from "./queue-sender.ts";
import { dropHandOff, handedOff } from "../../state/started-chat.ts";
import { settleShown } from "@caveman-app/ui/motion";

const STATUS: Record<Workspace["status"], { label: string; dot: string }> = {
  starting: { label: "Starting", dot: "bg-chart-1" },
  working: { label: "Running", dot: "bg-success" },
  needs_input: { label: "Needs you", dot: "bg-warning" },
  waiting: { label: "Waiting", dot: "border border-dashed border-muted-foreground" },
  idle: { label: "Done", dot: "bg-muted-foreground" },
  parked: { label: "Parked", dot: "border border-dashed border-muted-foreground" },
  archived: { label: "Archived", dot: "bg-muted-foreground" },
  failed: { label: "Failed", dot: "bg-destructive" },
};

/** The states the header's dot speaks for; the rest (done, waiting, parked) say nothing there. */
const DOTTED: ReadonlySet<Workspace["status"]> = new Set(["starting", "working", "needs_input", "failed"]);

/** A pane this wide shows the side panel beside the chat; narrower, it would float over it (SidePanel's NARROW_PANE). */
const WIDE_PANE = 580;
const NO_PATHS: ReadonlyArray<string> = [];

export interface PaneFrameProps {
  readonly pane: Pane;
  /** The composer target: the focused pane, or the only one. */
  readonly focused: boolean;
  readonly canSplit: boolean;
}

/** Chats a pane showed lately stay rendered, hidden: switching back to one only shows it again. */
const KEEP_VIEWS = 4;
/**
 * How long a switch keeps the chat on screen while the next one's history loads (upstream paint-only timeline): the
 * loading line's own delay (panes.css), so a chat that loads in that time arrives whole, in one frame, with no empty
 * pane before it; one slower shows with its loading line at once.
 */
const HOLD_MS = 400;

/** One pane of the split view: a whole workspace session, a side-panel tab of its own, or a picker when empty. */
export const PaneFrame = memo(function PaneFrame({ pane, focused, canSplit }: PaneFrameProps) {
  return pane.tab ? <TabPane pane={pane} tab={pane.tab} focused={focused} /> : <ChatFrame pane={pane} focused={focused} canSplit={canSplit} />;
});

const ChatFrame = memo(function ChatFrame({ pane, focused, canSplit }: PaneFrameProps) {
  const { client } = useRuntimeClient();
  const current = pane.workspaceId;
  // Most recent first. React's Activity keeps the hidden ones' DOM and state; their effects (shortcuts, markSeen)
  // stop while hidden and come back when shown, and their sessions stay attached a while (runtime.tsx LIVE_UNSEEN).
  const [kept, setKept] = useState<ReadonlyArray<string>>(current ? [current] : []);
  if (current && kept[0] !== current) setKept([current, ...kept.filter((id) => id !== current)].slice(0, KEEP_VIEWS));
  // An archived chat search opened is not in the live list: read it as it was found.
  const found = usePeeked(current);
  // The chat under the pointer in the sidebar renders here too, hidden, at React's offscreen priority: its click only
  // shows it (same key, same instance).
  const warm = useWarmChat();
  const shown = focused && warm !== null && !kept.includes(warm) ? [...kept, warm] : kept;
  // Only the workspaces this pane shows: a push about any other chat re-renders none of them.
  const ids = current ? [current, ...shown] : shown;
  const picked = useRuntimeSelector((v) => ids.map((id) => v.raw.get(id)), sameItems);
  // A chat that runs on another computer (Cloud's list says where): shown here as it is there, read and steered
  // through the sync hub, whether or not this window's runtime ever had it (a chat the lid moved keeps its place).
  const hub = useSyncHub();
  const list = useChatList(hub);
  const elsewhere = (id: string, local: Workspace | undefined): Workspace | undefined => {
    const chat = list ? (local ? list.chats.get(local.session_id) : byWorkspace(list).get(id)) : undefined;
    // The window's own runtime's record of its own chat wins; without one (a web tab whose Mac sleeps), Cloud's list.
    if (!list || !chat || (local && chat.runtime_id === hub?.homeRuntimeId())) return undefined;
    const lead = chat.parent_session_id ? list.chats.get(chat.parent_session_id)?.workspace_id : undefined;
    return chatWorkspace(chat, whereOf(chat, list.runtimes, hub?.homeRuntimeId() ?? null), local, lead);
  };
  const workspace = current ? (elsewhere(current, picked[0]) ?? picked[0] ?? found) : undefined;
  const clientOf = (w: Workspace | undefined) => (hub && w && hub.throughHub(w.session_id) ? chatClientFor(hub, w.session_id) : null);
  const currentClient = clientOf(workspace) ?? client;
  const sessionId = workspace?.session_id ?? null;
  // The chat switched to loads now, while it is still hidden behind the one on screen (its own view attaches once shown).
  const ready = useSessionReady(currentClient, sessionId);
  useEffect(() => prefetchSession(currentClient, sessionId), [currentClient, sessionId]);
  // A switch inside a pane on screen keeps the chat there until the next one's history is in, up to HOLD_MS (hold.ts):
  // it changes in one frame, never through an empty pane. A pane coming on screen (from the Chief, another tab) shows
  // its chat at once: there is nothing on screen to hold.
  const onScreen = useOnScreen();
  const [showing, setShowing] = useState(current);
  const [waited, setWaited] = useState<string | null>(null);
  const holding = holds({ onScreen, current, showing, ready, waited, kept });
  if (showing !== current && !holding) setShowing(current);
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setWaited(current), HOLD_MS);
    return () => clearTimeout(timer);
  }, [holding, current]);
  const visible = holding ? showing : current;
  if (!current) return <EmptyPane pane={pane} focused={focused} />;
  if (!workspace) return client || list ? <Notice pane={pane} text="This chat is not on any of your computers." /> : <Notice pane={pane} text="Not connected to a runtime." />;
  return shown.map((id) => {
    const local = id === current ? picked[0] : picked[ids.indexOf(id)];
    const w = id === current ? workspace : (elsewhere(id, local) ?? local);
    const remote = clientOf(w);
    const c = remote ?? client;
    if (!w || !c) return id === current ? <Notice key={id} pane={pane} text="Not connected to a runtime." /> : null;
    const view = <SessionPane pane={pane} workspace={w} client={c} focused={focused && id === visible} held={id !== current} late={id === current && waited === current} canSplit={canSplit} />;
    return (
      <Activity key={id} mode={id === visible ? "visible" : "hidden"}>
        {remote ? <ChatClientScope client={remote}>{view}</ChatClientScope> : view}
      </Activity>
    );
  });
});

/** Whether this pane is on screen: false while its tab, or the split view behind the Chief, is hidden (Activity). */
function useOnScreen(): boolean {
  const [on, setOn] = useState(false);
  useLayoutEffect(() => {
    setOn(true);
    return () => setOn(false);
  }, []);
  return on;
}

const workspaceIndex = new WeakMap<ChatListSnapshot, ReadonlyMap<string, ChatSummary>>();
/** Cloud's list by workspace id (a route names a workspace), once per version of the list. */
function byWorkspace(list: ChatListSnapshot): ReadonlyMap<string, ChatSummary> {
  let index = workspaceIndex.get(list);
  if (!index) workspaceIndex.set(list, (index = new Map([...list.chats.values()].map((c) => [c.workspace_id, c]))));
  return index;
}

/**
 * The chat column and the workspace's side panel, sharing the pane's row (panels/SidePanel.tsx).
 * `pane` is null outside the split view (the inbox): no split or close controls.
 * `held`: its pane has switched to another chat, still loading; this one stays on screen meanwhile, taking no input.
 * `late`: shown after such a hold ran out, so its loading line shows at once (it has already been waited for).
 * `embeddedHeader`: the same chat inside a side-panel tab, with that surface's header and no nested side panel.
 */
export const SessionPane = memo(function SessionPane({ pane, workspace, client, focused, canSplit, held = false, late = false, embeddedHeader }: { pane: Pane | null; workspace: Workspace; client: Client; focused: boolean; canSplit: boolean; held?: boolean; late?: boolean; embeddedHeader?: ReactNode }) {
  const embedded = embeddedHeader !== undefined;
  const openSurface = useOpenSurface();
  const engines = useRuntimeSelector((v) => v.engines);
  const markSeen = useRuntimeSelector((v) => v.markSeen);
  const refresh = useRuntimeSelector((v) => v.refresh);
  const adopt = useRuntimeSelector((v) => v.adopt);
  const hub = useSyncHub();
  // The chats it started and the one that started it, on whichever computer they run: a push about any other chat
  // re-renders nothing here.
  const children = useEveryChatSelector(hub, (all) => [...all.values()].filter((w) => w.parent_workspace_id === workspace.id), sameItems);
  const lead = useEveryChatSelector(hub, (all) => (workspace.parent_workspace_id ? all.get(workspace.parent_workspace_id) : undefined));
  const repo = useRuntimeSelector((v) => v.workspaces.find((w) => w.id === workspace.id)?.repo ?? "");
  // A chat in several sources of its project: what they are (null for a chat in one, which reads none of this).
  const sources = useChatSources(workspace);
  const project = useRuntimeSelector((v) => (workspace.project_id ? v.projects.find((p) => p.id === workspace.project_id) : undefined));
  const navigate = useNavigate();
  const { view, context, model, echo, stop, feed, historyVersion } = useSession(workspace.session_id);
  // A chat New chat just started: its first message and working line stand where New chat showed them until the
  // history shows its turn under way, or says where its start stands (a Cloud start's "Queued · waking Cloud", its
  // failure) (state/started-chat.ts); history with only the message would drop the line.
  const [handed] = useState(() => handedOff(workspace.id));
  const caughtUp = view != null && (view.running || view.items.some((i) => i.kind !== "user" || i.queued !== undefined));
  const holding = handed !== undefined && !caughtUp;
  useEffect(() => {
    if (caughtUp) dropHandOff(workspace.id);
  }, [caughtUp, workspace.id]);
  // What the chat holds now, for a send that awaited something first (a redirect's declines).
  const viewNow = useRef(view);
  useLayoutEffect(() => {
    viewNow.current = view;
  }, [view]);
  // Pinned on the runtime (Workspace.inbox), as the sidebar shows it, a pin in flight included.
  const pinned = useRuntimeSelector((v) => Boolean(v.workspaces.find((w) => w.id === workspace.id)?.inbox?.pinnedAt));
  const inbox = useInbox();
  const root = useRef<HTMLDivElement>(null);
  // Switching chats paints a snapshot, including the first visit. Settle only
  // existing entrances; new output after this commit keeps its own animation.
  useLayoutEffect(() => settleShown(root.current!, 0), []);
  // --pane-top: the floating header's height as laid out (the header, plus the goal bar while a goal holds);
  // the conversation scrolls under it (panes.css). Set on the chat column, so a resize re-renders nothing. Set as the
  // header's ref attaches, before the conversation's layout effects run (it comes first in the column): a chat opened
  // where its reader left it places its view where its rows will stand (set after, it moved them all down a header).
  const header = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const set = () => el.parentElement?.style.setProperty("--pane-top", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => markSeen(workspace.id), [workspace.id, workspace.updated_at]);
 // The side panel opens only when the person opens it (it
  // kept popping up on its own). It follows the pane's width: a split that
  // makes the pane narrow hides the Overview cards (they would float over the
  // chat) and widening brings back what it hid. A file, artifact or any other
  // tab the user opened stays: it shrinks to the panel's minimum, then floats
  // over the chat.
  useLayoutEffect(() => {
    if (embedded) return;
    const el = root.current!;
    let wide: boolean | null = null;
    let hidden = false;
    const ro = new ResizeObserver(() => {
      const now = el.clientWidth >= WIDE_PANE;
      if (now === wide) return;
      wide = now;
      const s = getPanel(workspace.id);
      if (!now && s.open && !s.maximized && s.tabs.find((t) => t.id === s.active)?.kind === "overview") {
        setPanelOpen(workspace.id, false);
        hidden = true;
      } else if (now && hidden) {
        hidden = false;
        setPanelOpen(workspace.id, true);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [workspace.id, embedded]);

  const engine = engines.find((e) => e.id === workspace.engine);
  // What the engine runs on is the chat's own computer's to say (a Cloud chat's is not This Mac's).
  const engineThere = useEngineThere(workspace, engine);
  const engineLabel = engine?.label ?? workspace.engine;
  const isCaveman = workspace.engine === "caveman";

  // Queued follow-ups: re-read after our own calls, on queue.updated (another client's edits) and when a turn starts or ends.
  const [queue, setQueue] = useState<Result<"queue.list">["turns"]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const reloadQueue = useCallback(() => {
    client.call("queue.list", { session_id: workspace.session_id }).then((r) => setQueue(r.turns), () => undefined);
  }, [client, workspace.session_id]);
  const turnEnds = view?.items.filter((i) => i.kind === "turn_end").length ?? 0;
  useEffect(reloadQueue, [reloadQueue, view?.running, turnEnds, view?.queueVersion]);
  const act = (call: Promise<unknown>) =>
    call.then(
      () => setProblem(null),
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
    );
  const queueCall = (call: Promise<unknown>) => void act(call).finally(reloadQueue);
  // The box's queue, made again only when the queue changes: a streamed token re-renders this pane, and a fresh element
 // would re-render the (memo) composer with it (upstream #28564).
  const resumable = queue.some((t) => t.held) && !view?.running;
  const queueBox = useMemo(
    () =>
      queue.length === 0 ? undefined : (
        <Queue
          // Thread links read as "@Title"; an edit gets them back wherever that "@Title" still stands.
          items={queue.map((t) => ({ id: t.turn_id, text: draftFromWire(t.text).text, ...queuedSender(t) }))}
          onEdit={(id, text) => {
            const wire = queue.find((t) => t.turn_id === id)?.text ?? "";
            queueCall(client.call("queue.edit", { request_id: requestId(), session_id: workspace.session_id, turn_id: id, text: relink(text, draftFromWire(wire).refs) }));
          }}
          onRemove={(id) => queueCall(client.call("queue.remove", { request_id: requestId(), session_id: workspace.session_id, turn_id: id }))}
          onMove={(id, before) => queueCall(client.call("queue.reorder", { request_id: requestId(), session_id: workspace.session_id, turn_id: id, before_turn_id: before }))}
          {...(resumable ? { onResume: () => queueCall(client.call("queue.resume", { request_id: requestId(), session_id: workspace.session_id })) } : {})}
        />
      ),
    // queueCall only reports to this pane's setters and reloads the same queue: the first one does as well as a later one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, client, workspace.session_id, resumable],
  );

  const [restoreAt, setRestoreAt] = useState<number | null>(null);
  // Edit on a message of the person's: back to the turn before it, its words in the box (after a confirm, as Restore).
  const [editFrom, setEditFrom] = useState<{ readonly at: number; readonly wire: string; readonly images: boolean } | null>(null);
  /** Restore was confirmed: focus moves to the box as the dialog closes. */
  const restored = useRef(false);
  const [skillOpen, setSkillOpen] = useState(false);
  // A chat in a plain folder (Project.no_git, its branch empty) has no checkpoints to go back to, nor a checkout to fork.
  const inFolder = workspace.branch === "";
  const canRestore = engine?.capabilities.restore === true && !inFolder && !(view?.running ?? false) && workspace.status !== "archived" && workspace.status !== "parked";
  // /undo: back to the turn before the last, through the same confirmation as "Restore to here".
  const checkpoints = (view?.items ?? []).flatMap((i) => (i.kind === "turn_end" && i.cursor > (view?.forkedAt ?? 0) ? [i.cursor] : []));
  const undoTo = checkpoints.at(-2);
  const undoBlocked =
    engine?.capabilities.restore !== true
      ? `${engineLabel} can't take a turn back`
      : inFolder
        ? "This folder is not a git repository"
        : view?.running
        ? "Stop the turn first"
        : !canRestore
          ? "Not while the chat is archived or asleep"
          : undoTo === undefined
            ? "Nothing earlier to go back to"
            : null;
  const canFork = engine?.capabilities.fork === true && !inFolder && workspace.status !== "archived";
  const go = useTabNav();
  // Another chat opened from this one, as the sidebar opens it; PaneHost leaves a tab switch to its caller.
  const showChat = useShowChat();
  // A fork is a new chat from that turn, opened here.
  const fork = useStableCallback(async (at?: number) => {
    const res = await client.call("session.fork", { request_id: requestId(), session_id: workspace.session_id, ...(at === undefined ? {} : { at }) });
    if (adopt) adopt(res.workspace);
    else await refresh();
    showChat(res.workspace.id);
    announce(`Forked into ${res.workspace.title}.`);
  });
  // A lead whose turn ended while its delegated agents work: Stop (turn.interrupt) still stops them all.
  const agentsWorking = children.some((w) => ["starting", "working", "needs_input", "waiting"].includes(w.status));
  // The turn is over and its agents still work: the box says the chat waits on them, and it is not the person's turn.
  const atWork = useMemo(() => (view ? agentsAtWork(view.items, children) : []), [view, children]);
  const waitingOn = view && !view.running ? atWork : [];
  // An approval waits: the box stays usable, and what it sends declines it and redirects the agent; when it is the one
 // waiting and its deny takes a note, what it sends is that note, to the agent that asked (upstream #23657).
  const waiting = useMemo(() => (view?.running ? waitingApprovals(view.items) : []), [view]);
  const redirects = waiting.some((a) => a.denyId !== null);
  const notes = noteTarget(waiting, 0) !== null;
  // The chat wrote an agent file: its box offers to publish it to Cloud.
  const publishOffer = usePublishOffer(workspace.id, workspace.project_id ?? null, workspace.root_path ?? null, view?.agentFiles ?? NO_PATHS);
  const restore = async (at: number) => {
    const res = await client.call("session.restore", { request_id: requestId(), session_id: workspace.session_id, at });
    await refresh();
    announce(res.branch ? `Restored. The later turns are in ${res.branch.title}.` : "Restored.");
  };

  // What the composer has picked (model, effort, access, login, mode): Build it sends the same.
  const [choice, setChoice] = useState<TurnChoice>({});
  // The model this chat shows: the composer's pick, else its latest turn's, else (before one) its default, as the composer has it.
  const { model: shown } = useTurnChoice(workspace.engine, { access: view?.access, model: view?.turn?.model, effort: view?.turn?.effort, projectId: workspace.project_id });
  const turnModel = choice.model ?? shown?.id;
  // Who runs this chat: what the runtime says (a delegated agent's runner), else its latest turn, else the composer's pick.
  const runner = runnerFor(engines, { engine: workspace.engine, model: view?.turn?.model ?? turnModel, effort: view?.turn?.effort, runner: childRunner(workspace), account_id: view?.turn?.account_id });
  // Handlers the header, transcript and box keep across renders: a streamed token re-renders this pane, not them.
  const conversation = useRef<ConversationHandle>(null);
  const submit = useStableCallback(async (text: string, kind: SubmitKind, options: TurnChoice, attachments: Attachment[]) => {
 // Approvals waiting on the person: this message redirects the agent, so they are declined first (upstream #21503).
    const approvals = view?.running ? waitingApprovals(view.items) : [];
    // One waiting whose deny takes a note: the message is that note, read by the agent that asked, a subagent's call
    // included; the turn goes on and no new prompt goes out. Answered first elsewhere, it goes as a message after all.
    const note = kind === "queue" ? null : noteTarget(approvals, attachments.length);
    if (note !== null && text.trim() !== "") {
      try {
        await answer(note.askId, { kind: "approval", option_id: note.denyId, feedback: text.trim() });
        return;
      } catch (e) {
        if (!(e instanceof AnsweredElsewhere)) throw new RedirectHeld("Your note didn't reach the agent, and the approval still waits. Send it again.");
      }
    }
    if (approvals.length > 0) {
      await declineForRedirect(
        approvals,
        (askId, optionId) => answer(askId, { kind: "approval", option_id: optionId }),
        (e) => e instanceof AnsweredElsewhere,
        () => waitingApprovals(viewNow.current?.items ?? []),
      );
    }
    const request_id = requestId();
    // A message that starts a turn now (nothing running or queued) shows as it goes out, under the id the runtime gives
    // it; one that waits goes to the queue, as it always did.
    const echoId = echo && kind === "followup" && !view?.running && queue.length === 0 && attachments.length === 0 ? await submittedMessageId(workspace.session_id, request_id) : null;
    const takeBack = echoId ? echo!(echoId, text) : null;
    // A message that lands in the chat now (not one that waits its turn in the queue) brings the view to it.
    if (kind === "steer" || (!view?.running && queue.length === 0)) conversation.current?.arrive();
    let res;
    try {
      // Send to accepted (S14): measured per way it went (loopback, relay, direct, Cloud's queue).
      const sentAt = performance.now();
      res = await client.call("turn.submit", {
        request_id,
        session_id: workspace.session_id,
        kind,
        input: { text, ...(attachments.length ? { attachments } : {}) },
        options,
      });
      latency.record("send", hub ? hub.viaFor(workspace.session_id) : "loopback", performance.now() - sentAt);
    } catch (e) {
      takeBack?.();
      throw e;
    }
    if (res.disposition !== "started") takeBack?.();
    // The runtime keeps the mode from here on; show it now rather than at turn.started (a queued turn starts later).
    if (options.mode) model?.setMode(options.mode);
    if (options.access) model?.setAccess(options.access);
    if (res.disposition === "queued") reloadQueue();
  });
  // A chat whose engine stopped (the app restarted, or the chat idled out) starts it again as the person starts typing,
  // on what the box would send, so Send skips the engine's start-up (turn.prewarm: fire-and-forget, a no-op when the
  // engine is live; a runtime from before it says method_not_found). Asked again only when the picks change.
  const warmed = useRef<{ readonly key: string; readonly at: number } | null>(null);
  const warmEngine = useStableCallback(() => {
    if (view?.running || workspace.status === "archived") return;
    const key = JSON.stringify(choice);
    if (warmed.current?.key === key && Date.now() - warmed.current.at < 60_000) return;
    warmed.current = { key, at: Date.now() };
    void client.call("turn.prewarm", { request_id: requestId(), session_id: workspace.session_id, options: choice }).catch(() => undefined);
  });
  // Stop shows at once (S14) and settles by its request id: the turn's end clears it, a refusal takes it back.
  const interrupt = useStableCallback(async () => {
    const request_id = requestId();
    const takeBack = stop?.(request_id);
    try {
      await client.call("turn.interrupt", { request_id, session_id: workspace.session_id });
    } catch (e) {
      takeBack?.();
      throw e;
    }
  });
  const interruptFromBox = useStableCallback(() => act(interrupt()));
  // Focus in the box of a chat whose Cloud computer sleeps: wake it now, so it is up by the time the message goes (S14).
  const wakeOnFocus = useStableCallback(() => void hub?.wake(workspace.session_id, "typing"));
  const answer = useStableCallback(async (askId: string, response: AskReply) => {
    try {
      await client.call("ask.respond", { request_id: requestId(), session_id: workspace.session_id, ask_id: askId, response });
    } catch (e) {
      throw answeredElsewhere("ask.respond", e);
    }
  });
  // Build it: leave grill mode and build from the decisions doc, on what the composer picked (else the chat's own).
  // The card holds the button while the call is in flight and after it went through (one turn per click).
  const build = useStableCallback((docPath: string) => {
    const call = submit(buildPrompt(docPath), view?.running ? "queue" : "followup", { ...choice, mode: "default" }, []);
    void act(call);
    return call;
  });
  // Continue, on a turn the computer's sleep stopped (state/sleep-stop.ts): its note goes as a follow-up, on what the box would send.
  // A failed send is said in the pane and also reaches Continue, which comes back up to try again.
  const continueAfterSleep = useStableCallback((note: string) => {
    const call = submit(note, view?.running ? "queue" : "followup", { ...choice }, []);
    void act(call);
    return call;
  });
  const forkAt = useStableCallback((at: number) => void act(fork(at)));
  const forkLatest = useStableCallback(() => void act(fork()));
  const forkFromBox = useStableCallback(() => act(fork()));
  const editFromHere = useStableCallback((at: number, wire: string, images: boolean) => setEditFrom({ at, wire, images }));
  const split = useStableCallback((zone: "right" | "bottom") => {
    if (!pane) return;
    panes.focus(pane.id);
    announce(panes.split(zone) ? `Split ${zone === "right" ? "right" : "down"}. Type to start a new chat in the new pane, or pick one to open.` : "This pane is too small to split that way.");
  });
  // A delegated agent's chat, or the later turns a restore set aside.
  const openWorkspace = useStableCallback((id: string) => void act(refresh().then(() => showChat(id))));
  const close = useStableCallback(() => pane && go(closePane(pane.id, workspace.title)));
  const slot = usePaneSlot();
  const toggleZoom = useStableCallback(() => {
    if (!pane) return;
    panes.focus(pane.id);
    panes.toggleZoom();
  });
  const moveToTab = useStableCallback(() => pane && go(windowTabs.splitOff(pane.id)));
  const togglePin = useStableCallback(() => inbox?.(workspace.id, { do: pinned ? "unpin" : "pin" }));
  const rename = useStableCallback((title: string) => void act(client.call("workspace.rename", { request_id: requestId(), workspace_id: workspace.id, title }).then(refresh)));
  const openLead = useStableCallback(() => lead && showChat(lead.id));
  const archive = useStableCallback(() => void act(client.call("workspace.archive", { request_id: requestId(), workspace_id: workspace.id }).then(refresh)));
  const restoreChat = useStableCallback(() => void act(client.call("workspace.restore", { request_id: requestId(), workspace_id: workspace.id }).then(refresh)));
  const run = useStableCallback((command: string) => void act(runInTerminal(client, workspace.id, command)));
  const dragStart = useStableCallback((e: React.PointerEvent<HTMLElement>) =>
    beginDrag(e, {
      workspaceId: workspace.id,
      title: workspace.title,
      meta: repo && workspace.branch ? `${repo} · ${workspace.branch}` : repo || workspace.branch,
      detail: `${engineLabel} · ${STATUS[workspace.status].label}`,
      fromPaneId: pane?.id ?? null,
    }),
  );
  const goal = useStableCallback(async (objective: string) => {
    await client.call("goal.set", { request_id: requestId(), session_id: workspace.session_id, objective });
  });
  // The project's sources this chat does not work in yet: the title menu adds one (workspace.add_source). The
  // runtime's refusal (a turn running in a chat that was in one source, a source Cloud has not been given) shows as
  // it is, over the box.
  const addable = addableSources(project, workspace);
  const addSource = useStableCallback((source: string) =>
    void act(
      client.call("workspace.add_source", { request_id: requestId(), workspace_id: workspace.id, source }).then(async (next) => {
        if (adopt) adopt(next);
        else await refresh();
        announce(`${source} was added to this chat.`);
      }),
    ),
  );
  const recordSkill = useStableCallback(() => setSkillOpen(true));
  // Where the chat is, under its box. One element while nothing of it changes: a streamed token re-renders this pane,
  // not the box.
  const movedFrom = view?.movedFrom ?? null;
  const foot = useMemo(() => <WhereItRuns client={client} workspace={workspace} movedFrom={movedFrom} />, [client, workspace, movedFrom]);
  const exportChat = useStableCallback(() =>
    download(new Blob([transcriptMarkdown(workspace.title, engineLabel, view?.items ?? [])], { type: "text/markdown" }), exportName(workspace.title)),
  );
  const lastAnswer = useStableCallback(() => {
    const found = view?.items.findLast((i) => i.kind === "assistant" && i.text.trim() !== "");
    return found?.kind === "assistant" ? found.text : undefined;
  });
  const history = useStableCallback(() => promptEntries(view?.items ?? []));
  const undoLast = useStableCallback(() => {
    if (undoTo !== undefined) setRestoreAt(undoTo);
  });

  return (
    // data-pane: the side panel measures and scopes its shortcuts to this element.
    <div ref={root} data-pane={embedded ? undefined : ""} data-chat-session={workspace.id} inert={held || undefined} className="relative flex h-full bg-background">
      <ArtifactTemplateComposerProvider key={workspace.session_id}>
      <div className="pane-chat relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={header} className="absolute inset-x-0 top-0 z-10">
          {embedded ? embeddedHeader : <PaneHeader
            workspaceId={workspace.id}
            title={workspace.title}
            // The account's tag ("CS") is the composer's to show; the mark still names it to a screen reader.
            mark={workspace.engine === "caveman" ? <VendorMark engine={workspace.engine} model={turnModel ?? ""} /> : <RunnerMark runner={runner} size={18} tag="none" />}
            // Beside the title, only the out of the ordinary: the way back for a chat running elsewhere (where it runs
            // is the box's foot), its pull request, and for a chat in several sources their names, each with its own
            // pull request.
            meta={
              workspace.computer.kind !== "this_mac" || workspace.pull_request || sources ? (
                <>
                  {view?.movedFrom && workspace.computer.kind === "caveman_cloud" && workspace.status !== "parked" && workspace.status !== "archived" ? (
                    <ContinueOnThisMac client={client} workspace={workspace} movedFrom={view.movedFrom} />
                  ) : null}
                  {/* On another of the person's Macs, up: this Mac's screen pulls it here, signed by this Mac's key. */}
                  <ContinueHere workspace={workspace} />
                  {/* Its branch's pull request: a click reviews it in this chat's side panel. */}
                  {sources ? (
                    <SourceNames chat={sources} projectId={workspace.project_id ?? null} workspaceId={workspace.id} />
                  ) : workspace.pull_request ? (
                    <PrMark pr={workspace.pull_request} projectId={workspace.project_id ?? null} onOpen={(pr) => openPr(navigate, workspace.id, pr)} />
                  ) : null}
                </>
              ) : undefined
            }
            // What a click away says, at the top of the title menu: its sources, a delegated agent's model.
            where={
              sources || lead ? (
              <>
                {sources ? <SourceLines chat={sources} projectId={workspace.project_id ?? null} workspaceId={workspace.id} /> : null}
                {lead ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <RunnerModel runner={runner} className="shrink-0" />
                    {pickCopy(runner) ? (
                      <>
                        <span aria-hidden className="text-[hsl(var(--subtle-foreground))]">
                          ·
                        </span>
                        <PickLabel runner={runner} short />
                      </>
                    ) : null}
                  </span>
                ) : null}
              </>
              ) : undefined
            }
            addSources={addable.length > 0 ? { list: addable.map((s) => ({ name: s.name, line: sourceLine(s) })), onAdd: addSource } : undefined}
            status={DOTTED.has(workspace.status) ? STATUS[workspace.status] : null}
            focused={focused}
            canSplit={canSplit}
            pinned={pinned}
            archived={workspace.status === "archived"}
            onSplit={pane ? split : undefined}
            onClose={pane ? close : undefined}
            layout={pane && slot.count > 1 ? { count: slot.count, solo: slot.solo, onToggleZoom: toggleZoom, onMoveToTab: moveToTab } : undefined}
            onTogglePin={togglePin}
            onRename={rename}
            onFork={canFork && turnEnds > 0 ? forkLatest : undefined}
            lead={lead ? { title: lead.title, open: openLead } : undefined}
            onArchive={archive}
            onRestore={restoreChat}
            onRun={run}
            onDragStart={dragStart}
          />}
          {view?.goal ? (
            // The session goal (goal.set): under the header for as long as it holds.
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 text-[13px]">
              <Icon icon={Target02Icon} className="size-4 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">Goal</span>
              <span className="min-w-0 flex-1 truncate text-foreground" title={view.goal.objective}>
                {view.goal.objective}
              </span>
              <button
                type="button"
                onClick={() => void act(client.call("goal.set", { request_id: requestId(), session_id: workspace.session_id, objective: null }))}
                className="h-6 shrink-0 rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Clear
              </button>
            </div>
          ) : null}
        </div>
        {/* The agent's browser or computer, live in the corner while it works there. */}
        {embedded ? null : <FloatingScreen workspaceId={workspace.id} engine={engineLabel} />}
        {/* Follows the bottom while the reader is there, with a scroll-to-end button once they leave it ("Needs you" while an approval or question waits). The left gutter holds the message rail. */}
        <Conversation handle={conversation} data-focus-area="conversation" className="pane-conversation" contentClassName="pl-14 pr-6 pt-[calc(var(--pane-top)+12px)] max-md:px-4" waiting={view?.pendingAsk ? "Needs you" : undefined}>
          <div className="mx-auto max-w-[880px] pb-6">
            {view && !holding ? (
              <Transcript
                key="view"
                items={view.items}
                historyVersion={historyVersion}
                engine={workspace.engine}
                engineLabel={engineLabel}
                engineIsCaveman={isCaveman}
                running={view.running}
                {...(view.stopping ? { stopping: true } : {})}
                // A started turn names its own model, or none (Auto); before it starts, the one the message went to,
                // else the last turn's.
                model={view.running ? view.turnModel : (turnModel ?? view.turn?.model)}
                onAnswer={answer}
                onBuild={build}
                onContinue={workspace.status === "archived" ? null : continueAfterSleep}
                cavemanVersion={null}
                sessionId={workspace.session_id}
                workspaceId={workspace.id}
                root={workspace.root_path ?? null}
                formerRoot={formerRoot(workspace)}
                artifacts={view.artifacts}
                onRestore={canRestore ? setRestoreAt : null}
                onEditFrom={canRestore ? editFromHere : null}
                onFork={canFork ? forkAt : null}
                restoreAfter={view.forkedAt}
                onOpenWorkspace={openWorkspace}
                sources={sources}
                projectId={workspace.project_id ?? null}
              />
            ) : holding ? (
              <Transcript
                key="handed"
                items={[handed]}
                engine={workspace.engine}
                engineLabel={engineLabel}
                engineIsCaveman={isCaveman}
                running
                model={turnModel}
                onAnswer={answer}
                cavemanVersion={null}
                workspaceId={workspace.id}
                root={workspace.root_path ?? null}
              />
            ) : (
              // Shown only when the history is slow: a chat that loads at once never flashes it.
              <div className="pane-loading" data-late={late || undefined}>
                <PanelMessage>Loading the session…</PanelMessage>
              </div>
            )}
            {workspace.status === "parked" && view?.movedTo ? (
              <MovedCard client={client} workspace={workspace} to={view.movedTo} />
            ) : workspace.status === "parked" ? (
              // A parked session sleeps until it is resumed on a computer (session.resume).
              <div className="mt-6 flex items-end gap-4 rounded-xl border border-border bg-card px-4 py-3">
                <Mascot pose="sleeping" scale={2} />
                <div className="min-w-0 flex-1 pb-1">
                  <div className="text-[13px] text-foreground">Asleep</div>
                  <div className="text-[13px] text-muted-foreground">Parked on {workspace.computer.label}. Resume it to keep going.</div>
                </div>
                <Button
                  type="button"
                  onClick={() => void act(client.call("session.resume", { request_id: requestId(), session_id: workspace.session_id }).then(refresh))}
                  variant="secondary"
                  size="sm"
                  className="mb-1"
                >
                  Resume
                </Button>
              </div>
            ) : (
              <>
                <MovesNotice workspace={workspace} />
                <CloudLoginNotice client={client} workspace={workspace} />
                <HeldSettingsCard client={client} workspace={workspace} />
              </>
            )}
            <SyncLine workspaceId={workspace.id} sessionId={workspace.session_id} feed={feed} />
            {needsEngineSignIn(workspace, engineThere) ? <EngineSignInCard workspaceId={workspace.id} engine={engineThere} /> : null}
            <SetupProposalNotice workspaceId={workspace.id} projectId={workspace.project_id ?? null} />
          </div>
        </Conversation>
        {/* The composer shares the conversation's centre (its pl-14 pr-6 gutters, less 16px a side) and is 32px wider
            than its 880px column: 16px past each edge, never 32 on the left and none on the right. A phone has no
            message rail in the left gutter: 16px a side, the composer 8px from the screen's edges. */}
        <div data-focus-area="composer" className="w-full pb-4 pl-10 pr-2 max-md:px-2 max-md:pb-2" onInputCapture={warmEngine} onFocusCapture={wakeOnFocus}>
          <div className="mx-auto max-w-[912px]">
            {problem ? (
              <p role="alert" className="mb-2 flex items-center gap-2 px-1 text-[12.5px] text-destructive">
                <span className="min-w-0 flex-1 truncate" title={problem}>
                  {problem}
                </span>
                <button type="button" aria-label="Dismiss" onClick={() => setProblem(null)} className="grid size-5 place-items-center rounded text-muted-foreground hover:text-foreground">
                  <Icon icon={Cancel01Icon} className="size-3" strokeWidth={2} />
                </button>
              </p>
            ) : null}
            <Composer
              draftKey={`chat:${workspace.id}`}
              running={view?.running ?? false}
              agentsWorking={agentsWorking}
              strip={
                waitingOn.length > 0 ? (
                  <WaitingOn agents={waitingOn} onOpen={() => openSurface(workspace.id, "overview", {})} />
                ) : view && !view.running && !view.pendingAsk && publishOffer ? (
                  publishOffer
                ) : undefined
              }
              workspaceId={workspace.id}
              engineId={workspace.engine}
              engineLabel={engineLabel}
              canSteer={engine?.capabilities.steer ?? false}
              {...(redirects ? { placeholder: notes ? "Send a note to decline this request" : "Send a message to decline and redirect the agent" } : {})}
              onSubmit={submit}
              onChoice={setChoice}
              onInterrupt={interruptFromBox}
              context={context}
              tokens={view?.tokens}
              onGoal={goal}
              onRecordSkill={recordSkill}
              {...(canFork ? { onFork: forkFromBox } : {})}
              onUndo={undoBlocked ?? undoLast}
              onExport={exportChat}
              lastAnswer={lastAnswer}
              history={history}
              mode={view?.mode}
              access={view?.access}
              turn={view?.turn}
              accountId={view?.turn?.account_id}
              queue={queueBox}
              // chats of every engine Cloud runs move between computers, from here, mid-chat too.
              foot={foot}
            />
          </div>
        </div>
      </div>
      </ArtifactTemplateComposerProvider>
      {embedded ? null : <SidePanel workspace={workspace} />}
      <ConfirmDialog
        open={restoreAt !== null}
        onOpenChange={(open) => !open && setRestoreAt(null)}
        title="Restore to this turn?"
        description="Files and the conversation go back to this point. What came after, your own edits included, is kept as a new chat you can open."
        confirmLabel="Restore"
        onConfirm={() => {
          const at = restoreAt;
          restored.current = true;
          setRestoreAt(null);
          if (at !== null) void act(restore(at));
        }}
        // Restored, the turn whose button opened this is gone: focus goes to the chat's box, not the page.
        onCloseAutoFocus={(e) => {
          if (!restored.current) return;
          restored.current = false;
          e.preventDefault();
          root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        }}
      />
      <ConfirmDialog
        open={editFrom !== null}
        onOpenChange={(open) => !open && setEditFrom(null)}
        title="Edit this message?"
        description={`Files and the conversation go back to before it, and its words come back in the box to change and send. What came after is kept as a new chat you can open.${editFrom?.images ? " Its images don't come back; attach them again." : ""}`}
        confirmLabel="Edit"
        onConfirm={() => {
          const edit = editFrom;
          restored.current = true;
          setEditFrom(null);
          if (edit) void act(restore(edit.at).then(() => composeIn(workspace.id, edit.wire)));
        }}
        onCloseAutoFocus={(e) => {
          if (!restored.current) return;
          restored.current = false;
          e.preventDefault();
          root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        }}
      />
      <RecordSkillDialog client={client} sessionId={workspace.session_id} projectId={workspace.project_id} open={skillOpen} onOpenChange={setSkillOpen} />
    </div>
  );
});

/** An empty pane (after ⌘D, or when its workspace went away): a new chat that opens right here, or a chat to open instead. */
function EmptyPane({ pane, focused }: { pane: Pane; focused: boolean }) {
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const layout = useLayout();
  const open = new Set(leaves(layout.root).map((p) => p.workspaceId));
  const choices = workspaces.filter((w) => !open.has(w.id) && w.state !== "archived").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <NewChat pane={pane.id} autoFocus={focused} actions={<CloseButton id={pane.id} />}>
      {choices.length > 0 ? (
        <>
          <p className="mt-6 px-2 text-[12.5px] text-muted-foreground">Or open a chat here (or drag one from the sidebar)</p>
          <div className="mt-1 flex flex-col">
            {choices.slice(0, 8).map((w) => (
              <PickRow key={w.id} pane={pane} workspace={w} />
            ))}
          </div>
        </>
      ) : null}
    </NewChat>
  );
}

function Notice({ pane, text }: { pane: Pane; text: string }) {
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 pl-4 pr-1.5">
        <span className="flex-1" />
        <CloseButton id={pane.id} />
      </header>
      <PanelMessage>{text}</PanelMessage>
    </div>
  );
}

/** A chat the empty pane can open. One open in another tab says so: picking it moves it here (one home per chat). */
function PickRow({ pane, workspace: w }: { pane: Pane; workspace: WorkspaceView }) {
  const tab = useChatTab(w.id);
  return (
    <button
      type="button"
      onClick={() => {
        panes.fill(pane.id, w.id);
        announce(tab > 0 ? `Moved ${w.title} here from tab ${tab}.` : `Opened ${w.title}.`);
      }}
      className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <EngineMark engine={w.engine.id} />
      {/* A long title gives way first, ending inside the list, and the repo and engine keep a little room. */}
      <span className="min-w-0 truncate text-foreground">{w.title}</span>
      <span className="min-w-0 max-w-[40%] shrink-0 truncate text-muted-foreground">
        {tab > 0 ? `moves here from tab ${tab}` : `${w.repo} · ${w.engine.label}`}
      </span>
    </button>
  );
}

function CloseButton({ id }: { id: string }) {
  const go = useTabNav();
  return (
    <button
      type="button"
      aria-label="Close pane"
      title="Close pane"
      onClick={() => go(closePane(id, null))}
      className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <Icon icon={Cancel01Icon} className="size-4" />
    </button>
  );
}
