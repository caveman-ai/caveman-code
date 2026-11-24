// The chat transcript, on AI Elements (packages/ui/src/ai): the user's words
// in a Bubble, the engine's answer as streamed markdown (Response) under its
// speaker mark, tool runs, reasoning and builders as Trace lines, and every
// artifact (code, tables, images, file edits, command output, PRs) as
// something that opens in the side panel. Files the answer names (a link, or
// a path in inline code) open in the file viewer; the files a turn changed end
// it as one Changes card (transcript/TurnChanges.tsx). Grill rounds and their
// finish are cards (transcript/GrillCards.tsx). The message rail rides the left edge.
import { AnsweredElsewhere } from "../state/sync/sender.ts";
import type { ChiefAvatar } from "@caveman-app/session-protocol";
import { ChiefSprite } from "./ChiefSprite.tsx";
import { Button } from "@caveman-app/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@caveman-app/ui/components/tooltip";
import { useConversation } from "@caveman-app/ui/ai/conversation";
import { ConfirmationPager } from "@caveman-app/ui/ai/confirmation";
import { Bubble, Marker, Message, MessageContent, MessageFooter, MessageHeader } from "@caveman-app/ui/ai/message";
import { inlineCodeClass, Response, selectInlineCode, type ResponseTarget, type ResponseTargetKind } from "@caveman-app/ui/ai/response";
import { DisclosureContent, PreviewContent } from "@caveman-app/ui/ai/disclosure";
import { Rolling } from "@caveman-app/ui/ai/rolling";
import { useSteady } from "@caveman-app/ui/lib/use-steady";
import { lineKey, stepLine, THINKING, type StepLine } from "./transcript/step-line.ts";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceSubject, TraceTitle } from "@caveman-app/ui/ai/trace";
import { clock } from "../call/clock.ts";
import { cn } from "@caveman-app/ui/lib/cn";
import { ease } from "@caveman-app/ui/motion";
import { parseThreadReferences } from "@caveman-app/session-protocol/references";
import { Icon as HugeIcon, UserGroupIcon, AlarmClockIcon, AlertCircleIcon, ArrowDown01Icon, ArrowRight01Icon, Call02Icon, CallEnd01Icon, Mic02Icon, Tick02Icon, CrownIcon, FoldVerticalIcon, RefreshCwIcon, Route01Icon, BulbIcon } from "@caveman-app/ui/icons/huge";
import { Component, createContext, Fragment, memo, startTransition, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useStableCallback } from "@caveman-app/ui/lib/use-stable-callback";
import { textDirection } from "@caveman-app/ui/ai/text-direction";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router";
import type { AskReply } from "../state/grill.ts";
import { extractArtifacts, turnEdits, type FileArtifact } from "../state/transcript-artifacts.ts";
import type { Artifact, ChiefReaction, ToolItem, TranscriptItem, TurnRun } from "../state/transcript-model.ts";
import { effortLabel } from "@caveman-app/ui/components/effort";
import { editorClick, CodePath, FileChip, FileRefsContext, useFileRefActions } from "../panels/files/FileChip.tsx";
import { usePanel } from "../panels/store.ts";
import { SurfaceNavigation, useOpenFile, useOpenSurface } from "../panels/navigation.tsx";
import { pressRun } from "../panels/terminal/run.ts";
import { announce } from "../panes/store.ts";
import { loadedTurn, useRuntimeClient, useRuntimeSelector, useSession } from "../state/runtime.tsx";
import { reportProblem, threadExcerpt } from "../state/bug-report.ts";
import type { Workspace } from "@caveman-app/session-protocol";
import { clock as agentClock, firstLine, latestStep } from "../state/now.ts";
import { rowLine } from "../routes/inbox-model.ts";
import { useSkills } from "../state/composer-sources.ts";
import { skillMentions, skillToken } from "./composer-complete.ts";
import { findArtifact, publishArtifacts } from "./artifacts/store.ts";
import "./artifacts/surface.tsx";
import { MessageRail, scrollParent, type RailMessage } from "./message-rail/MessageRail.tsx";
import { compact } from "./pane/cards/PaneCardsView.tsx";
import { ChatGallery, ChatImages } from "./gallery/Gallery.tsx";
import { GeneratedImages } from "./gallery/GeneratedImages.tsx";
import { isImageGeneration } from "../state/image-generation.ts";
import { HtmlPages } from "./transcript/HtmlPage.tsx";
import { ArtifactCards } from "./transcript/ArtifactCards.tsx";
import { GrillFinishCard, RoundCard } from "./transcript/GrillCards.tsx";
import { InlineMedia } from "./transcript/InlineMedia.tsx";
import { ThreadPill } from "./transcript/ThreadPill.tsx";
import { MemoryRow } from "./transcript/MemoryRow.tsx";
import { artifactIcon, EngineMark, Icon, TOOL_ICON } from "./transcript/marks.tsx";
import { EngineLogo, RunnerModel, shortModel, type Runner } from "@caveman-app/ui/components/runner-badge";
import { childRunner, runnerFor } from "../state/runner.ts";
import { setLiveSteps, useLiveSteps } from "../state/live-steps.ts";
import { SecretAskCard } from "./secrets/SecretAskCard.tsx";
import { duration, expandHeld, foldLines, joinWatched, liveSteps, openTurn, rowItems, rows, turnHeads, turnLine, turnModel, waitLine, workedFor, workTools, type Row, type SubagentItem, type TurnHead } from "./transcript/rows.ts";
import { HeldSteps } from "./transcript/held.ts";
import { BubbleTail, MessengerContext, MessengerReactions, MessengerName, MessengerRow, MessengerTyping, ReactionBadge } from "./transcript/messenger.tsx";
import { SeenItems, seenItems } from "./transcript/seen.ts";
import { idleFolds, useSettledWork } from "./transcript/settled-work.ts";
import { detailKey, hasOpenWork, WorkDisclosuresContext } from "./transcript/work-disclosures.ts";
import { StreamView, useStreamView } from "@caveman-app/ui/ai/stream-view";
import { placeOf, readPlace, rememberPlace } from "./transcript/place.ts";
import { ROOM_REACH, TURN_ANCHOR } from "@caveman-app/ui/ai/conversation";
import { VendorMark } from "@caveman-app/ui/components/model-picker";
import { foldShows, runShots, STEADY_MS, WorkRun } from "./transcript/WorkRun.tsx";
import { holdsSubagent, rowsHoldSubagent, taken, useRevealedSubagent } from "./transcript/reveal-subagent.ts";
import { draftFromWire, pieces } from "./thread-refs.ts";
import { isAbsolutePath, sameArtifacts, withWorkspacePaths, workspaceText } from "../state/workspace-paths.ts";
import type { ChatSources } from "../state/sources.ts";
import { chatLink } from "./transcript/links.ts";
import { prFromUrl } from "../routes/review/model.ts";
import { openPr } from "../routes/review/surface.tsx";
import { resultHead, type GeneratedView } from "../state/generated.ts";
import { continueNote, lidStoppedEnds, lidStops, noLidStops, pressContinue, SLEEP_STOP_LABEL, subscribeLidStops, type ContinueState } from "../state/sleep-stop.ts";
import { turnScopes, type TurnCheckpoints } from "../panels/diff/turn-scope.ts";
import { MARK, SUBAGENT_STATE, type Mark } from "../panels/agents/states.ts";
import { FindBar } from "./find/FindBar.tsx";
import { occurrences } from "./find/chat-find.ts";
import { FindCurrent, FindQuery, rowHolds, useChatFind } from "./find/useChatFind.ts";
import { ownsFocus } from "../panes/focus.ts";
import { QuoteSelection } from "./transcript/QuoteSelection.tsx";
import { TurnChanges, TurnFooter, UndoneLine } from "./transcript/TurnChanges.tsx";
import { ChatWorkspaceProvider, useChatWorkspace, useWorkspaceRoot, WorkspaceRootProvider } from "./transcript/root.ts";
import { useArtifactTemplateComposer } from "./artifact-template-composer.tsx";
import { usePhone } from "../lib/screen.ts";

export interface TranscriptProps {
  readonly items: ReadonlyArray<TranscriptItem>;
  /** The feed delivered historical events, including delayed reattach backlog. */
  readonly historyVersion?: number;
  readonly engineLabel: string;
  readonly engineIsCaveman: boolean;
  readonly running: boolean;
  /** A stop is on its way (optimistic): the working line says Stopping. */
  readonly stopping?: boolean;
  /** Answers an ask whole (ask.respond): an approval's option, or every question of a round. */
  readonly onAnswer: (askId: string, reply: AskReply) => Promise<void> | void;
  readonly cavemanVersion: ((itemId: string) => Promise<string>) | null;
  /** The engine id, for its mark. Defaults from engineIsCaveman / engineLabel. */
  readonly engine?: string;
  /**
   * The model the open turn's line names before the engine has said anything: a started turn's own (none for Auto,
   * never the last turn's), else the one the person's message went to.
   */
  readonly model?: string | undefined;
  /** Who answers instead of the engine: a Chief, by its pixel character and name, on every one of its turns. */
  readonly speaker?: { readonly name: string; readonly avatar: ChiefAvatar | null };
  /** Enables the message rail (bookmarks are per session) and publishes artifacts for the side panel. */
  readonly sessionId?: string;
  /** Artifacts open in this workspace's side panel (the "artifact" surface) unless onOpenArtifact is given. */
  readonly workspaceId?: string;
  /** The chat's own folder (Workspace.root_path): file paths inside it show and open relative to it. */
  readonly root?: string | null | undefined;
  /**
   * Without a `root`, the checkout a chat this Mac moved away had here (chats-view.ts formerRoot): its earlier turns'
   * paths inside it read relative to the chat's folder too. No full path is ever copied from it.
   */
  readonly formerRoot?: string | null | undefined;
  /** SessionView.artifacts; extracted from `items` when absent. */
  readonly artifacts?: ReadonlyArray<Artifact>;
  readonly onOpenArtifact?: (artifactId: string) => void;
  /** The artifact open in the side panel, marked on its card. */
  readonly openArtifactId?: string | null;
  /** Restore files and transcript to the turn.done at this cursor (session.restore); no Checkpoint action without it. */
  readonly onRestore?: ((cursor: number) => void) | null;
  /** Turns at or before this cursor offer no restore (a fork's copied turns). */
  readonly restoreAfter?: number;
  /** Edit a message of the person's: restore to the turn.done before it and give its words back to the box. */
  readonly onEditFrom?: ((cursor: number, text: string, images: boolean) => void) | null;
  /** A new chat continuing from the turn.done at this cursor (session.fork); no Fork action without it. */
  readonly onFork?: ((cursor: number) => void) | null;
  /** Opens a workspace (the branch a restore kept). */
  readonly onOpenWorkspace?: ((workspaceId: string) => void) | null;
  /** Grill mode's Build it: a default-mode turn that builds from the decisions doc. No button without it. */
  readonly onBuild?: ((docPath: string) => Promise<void> | void) | null;
  /**
   * Continue, on the stop marker of a turn the computer's sleep stopped (state/sleep-stop.ts): sends this follow-up in
   * the chat. Without it the marker still says the stop came from sleep, with no button.
   */
  readonly onContinue?: ((note: string) => Promise<unknown> | void) | null;
  /** A run of tool calls as cards of the caller's own (the Chief's); null keeps the normal tool lines. */
  readonly toolCards?: (tools: ReadonlyArray<ToolItem>) => ReactNode;
  /** Which of those runs stay in view once their turn ends (what needs the person); the rest fold. Absent: all of them. */
  readonly keepCards?: (tools: ReadonlyArray<ToolItem>) => boolean;
  /** A chat's moment as the caller's card (the Chief's); without it a moment is its notification's line, as a notice. */
  readonly momentCards?: (moment: Extract<TranscriptItem, { kind: "moment" }>) => ReactNode;
  /** References the caller's agent writes in its replies (the Chief's [[12]]): each match shows as `render` draws it. */
  readonly inlineRefs?: InlineRefs;
  /**
   * Each finished turn of the `speaker` opens with how long it worked ("Worked 9s") in place of its mark, its steps and
   * information lines folded under it.
   */
  readonly workedLines?: boolean;
  /**
   * The `speaker`'s conversation as a messenger draws it (components/transcript/messenger.tsx): its replies as a chat's
   * are, its name over each run and its character beside the run's last row, three dots while it works.
   */
  readonly messenger?: boolean;
  /** The `speaker`'s reactions on the person's messages (SessionView.reactions): a messenger draws each on that bubble. */
  readonly reactions?: ReadonlyMap<string, ChiefReaction>;
  /** Between two rows, by when each began: a separator the caller draws (a new day, where you left off), or null. */
  readonly divider?: (at: string, prevAt: string | undefined) => ReactNode;
  /** A chat in several sources (sources/parts.tsx useChatSources): a turn's Changes card lists its files under their source. */
  readonly sources?: ChatSources | null;
  /** The chat's project, which a source's pull request is read through. */
  readonly projectId?: string | null;
}

export interface InlineRefs {
  /** One reference, without anchors or flags: /\[\[\d+\]\]/. */
  readonly pattern: RegExp;
  readonly render: (ref: string) => ReactNode;
  /** What a finished reply shows under its words for the references in it (the Chief's work: screenshots, a preview chip). */
  readonly after?: (text: string, at: string) => ReactNode;
}
/** The caller's inline references, for the replies deep in the tree. */
const InlineRefsContext = createContext<InlineRefs | null>(null);

/** What rows deep in the tree (asks inside builders, checkpoints) reach without threading props. */
interface TranscriptActions {
  readonly restore: ((cursor: number) => void) | null;
  readonly restoreAfter: number;
  readonly fork: ((cursor: number) => void) | null;
  readonly openWorkspace: ((workspaceId: string) => void) | null;
  /** Pending asks in transcript order; only `pending[index]` shows, with a pager when there are several. */
  readonly pending: ReadonlyArray<string>;
  readonly index: number;
  readonly onPage: (index: number) => void;
  /** Opens a workspace file in the side panel's file viewer, at a line when given. */
  readonly openFile: ((path: string, line?: number) => void) | null;
  readonly build: ((docPath: string) => Promise<void> | void) | null;
  /** The session (else workspace) this transcript shows: keys state that outlives a mount, like Build it's. */
  readonly scope: string;
  /** Opens the Changes tab on one finished turn, by the checkpoint it ended at, at one of its files when given. */
  readonly openChanges: ((checkpoint: string, path?: string) => void) | null;
  /** The checkpoints whose turn the Changes tab can diff on its own (turnScope), space-separated. */
  readonly turnChanges: string;
  readonly editFrom: ((cursor: number, text: string, images: boolean) => void) | null;
  /** The workspace whose files rows read (doc card previews) and whose terminal runs an answer's command. */
  readonly workspaceId: string | null;
  /** Runs a shell block's command in that terminal (pressRun); null without a workspace. */
  readonly run: ((command: string) => void) | null;
 /** The turn_end whose Changes card shows: the latest one, once the session has settled (compact card is the turn's result). */
  readonly cardTurn: string | null;
  /** Keep or Undo a turn's changes (checkpoint.keep / checkpoint.undo); null without a session to ask. */
  readonly settle: ((checkpoint: string, action: "keep" | "undo") => Promise<unknown>) | null;
  /** Opens "Report a problem" on an error this chat shows, with the chat's ids and its end (state/bug-report.ts). */
  readonly report: ((text: string) => void) | null;
  /** The sources of a chat in several, and its project; null for a chat in one source. */
  readonly sources: ChatSources | null;
  readonly projectId: string | null;
  /** The turn_end that offers Continue (the latest, once the chat has settled), and what it sends; null when none does. */
  readonly continueTurn: string | null;
  readonly continueFrom: ((endId: string) => Promise<unknown> | void) | null;
  /** The turn_ends the chat's lids stopped, space-separated (lidStoppedEnds). */
  readonly sleptEnds: string;
}
const Actions = createContext<TranscriptActions>({
  restore: null,
  restoreAfter: 0,
  fork: null,
  openWorkspace: null,
  pending: [],
  index: 0,
  onPage: () => undefined,
  openFile: null,
  build: null,
  scope: "",
  openChanges: null,
  turnChanges: "",
  editFrom: null,
  workspaceId: null,
  run: null,
  cardTurn: null,
  settle: null,
  report: null,
  sources: null,
  projectId: null,
  continueTurn: null,
  continueFrom: null,
  sleptEnds: "",
});

function pendingAsks(items: ReadonlyArray<TranscriptItem>, out: string[] = []): string[] {
  for (const item of items) {
    if (item.kind === "ask" && item.resolution === null) out.push(item.id);
    if (item.kind === "subagent") pendingAsks(item.items, out);
  }
  return out;
}

/** An item's recorded harness wins; old items without attribution retain the caller's identity. */
function engineIdentity(recorded: string | undefined, fallback: Pick<TranscriptProps, "engine" | "engineLabel" | "engineIsCaveman">, engines: ReadonlyArray<{ readonly id: string; readonly label: string }>) {
  const engine = fallback.engine ?? (fallback.engineIsCaveman ? "caveman" : fallback.engineLabel.toLowerCase().replace(/\s+/g, "-"));
  if (recorded === undefined) return { engine, engineLabel: fallback.engineLabel, engineIsCaveman: fallback.engineIsCaveman };
  const label = engines.find((e) => e.id === recorded)?.label ?? (recorded === engine ? fallback.engineLabel : recorded === "claude-agent" ? "Claude Agent" : recorded === "codex" ? "Codex" : recorded === "caveman" ? "Caveman" : recorded);
  return { engine: recorded, engineLabel: label, engineIsCaveman: recorded === "caveman" };
}

export function Transcript(props: TranscriptProps) {
  const openSurface = useOpenSurface();
  const openFileSurface = useOpenFile();
  const revealSurface = useContext(SurfaceNavigation);
  const { items, sessionId } = props;
  const engines = useRuntimeSelector((v) => v.engines);
  const box = useRef<HTMLDivElement>(null);
  const root = props.root ?? props.formerRoot ?? null;
  // Engines name files by absolute path; fs.read and the reader take them relative to the chat's folder.
  // A streamed token changes `items`, not the artifacts: the rows keep the list they had, so only the streaming row renders.
  const nextArtifacts = useMemo(() => withWorkspacePaths(props.artifacts ?? extractArtifacts(items), root), [props.artifacts, items, root]);
  const [keptArtifacts, setKeptArtifacts] = useState(nextArtifacts);
  const artifacts = sameArtifacts(keptArtifacts, nextArtifacts) ? keptArtifacts : nextArtifacts;
  if (artifacts !== keptArtifacts) setKeptArtifacts(artifacts);
  useEffect(() => {
    if (sessionId) publishArtifacts(sessionId, artifacts);
  }, [sessionId, artifacts]);
  // The rail keeps one list while its messages and previews read the same: a streamed token re-renders no rail.
  const nextRail = useMemo(() => railMessages(items), [items]);
  const [keptRail, setKeptRail] = useState(nextRail);
  const rail = sameRail(keptRail, nextRail) ? keptRail : nextRail;
  if (rail !== keptRail) setKeptRail(rail);
  const revealRef = useRef<((id: string) => void) | null>(null);
  const { height: railHeight, inset: railInset } = useScrollerBox(box);
  const phone = usePhone();
  // ⌘F: a chat's own find, over rows the window has not mounted yet too.
  const find = useChatFind({ box, items, reveal: revealRef, enabled: Boolean(sessionId), sessionId });
  // A screen reader hears a turn end in the chat it is in, as it happens (never the history a chat opens with).
  const ends = items.filter((i) => i.kind === "turn_end").length;
  const heard = useRef(ends);
  useEffect(() => {
    if (ends <= heard.current) {
      heard.current = ends;
      return;
    }
    heard.current = ends;
    const el = box.current;
    if (!sessionId || !el || el.closest("[data-side-panel]") || !ownsFocus(el)) return;
    const at = items.findLastIndex((i) => i.kind === "turn_end");
    const end = items[at];
    // A chat's history replays after it opens: only a turn that ended just now is news (a stamp from the future is not).
    if (end?.kind !== "turn_end" || Math.abs(Date.now() - Date.parse(end.at)) >= 4000) return;
    const error = items.slice(at + 1).find((i) => i.kind === "notice" && i.tone === "error");
    announce(turnAnnouncement(end.outcome, engineIdentity(end.engine, props, engines).engineLabel, error?.kind === "notice" ? error.text : null));
  }, [ends, items, sessionId, props.engine, props.engineLabel, props.engineIsCaveman, engines]);
  // Stable callbacks: a streaming snapshot re-renders the list each frame, but only the items that changed.
  const onAnswer = useStableCallback<Parameters<TranscriptProps["onAnswer"]>, ReturnType<TranscriptProps["onAnswer"]>>((id, a) => props.onAnswer(id, a));
  const { workspaceId } = props;
  const sources = props.sources ?? null;
  const projectId = props.projectId ?? null;
  const canOpen = Boolean(props.onOpenArtifact || workspaceId);
  const openArtifact = useStableCallback((artifactId: string) => {
    if (props.onOpenArtifact) props.onOpenArtifact(artifactId);
    else if (workspaceId) openSurface(workspaceId, "artifact", { artifactId });
  });
  const onOpenArtifact = canOpen ? openArtifact : undefined;
  const panel = usePanel(workspaceId ?? "");
  const tab = panel.open ? panel.tabs.find((t) => t.id === panel.active) : undefined;
  const openArtifactId = props.openArtifactId ?? (tab?.kind === "artifact" ? ((tab.params as { artifactId?: string }).artifactId ?? null) : null);
  // Files an answer names: a bare name prefers the files this chat touched.
  const touched = useStableCallback(() => artifacts.flatMap((x) => (x.kind === "file" ? [x.path] : [])));
  const refs = useFileRefActions(workspaceId ?? null, root, touched, props.root ?? null);
  const askCaveman = useStableCallback((id: string) => props.cavemanVersion!(id));
  const cavemanVersion = props.cavemanVersion ? askCaveman : null;
  const pendingKey = pendingAsks(items).join(" ");
  const [page, setPage] = useState(0);
  const canRestore = Boolean(props.onRestore);
  const canEdit = Boolean(props.onEditFrom);
  const canFork = Boolean(props.onFork);
  const canOpen2 = Boolean(props.onOpenWorkspace);
  const canBuild = Boolean(props.onBuild);
  const restoreAfter = props.restoreAfter ?? 0;
  const turnChanges = useMemo(() => turnScopes(turnCheckpoints(items, restoreAfter)).map((t) => t.to).join(" "), [items, restoreAfter]);
  const restore = useStableCallback((cursor: number) => props.onRestore?.(cursor));
  const fork = useStableCallback((cursor: number) => props.onFork?.(cursor));
  const openWorkspace = useStableCallback((id: string) => props.onOpenWorkspace?.(id));
  const build = useStableCallback((docPath: string) => props.onBuild?.(docPath));
  const editFrom = useStableCallback((cursor: number, text: string, images: boolean) => props.onEditFrom?.(cursor, text, images));
  const { client } = useRuntimeClient();
  const latestEnd = items.findLast((i) => i.kind === "turn_end")?.id ?? null;
  const cardTurn = props.running ? null : latestEnd;
  const settle = useStableCallback((checkpoint: string, action: "keep" | "undo") =>
    client!.call(action === "keep" ? "checkpoint.keep" : "checkpoint.undo", { request_id: crypto.randomUUID(), session_id: sessionId!, checkpoint_id: checkpoint }),
  );
  const canSettle = Boolean(client && sessionId);
  // Stable, reading the latest rows when pressed.
  const continueFrom = useStableCallback((endId: string) => {
    const note = continueNote(items, endId);
    return note === undefined ? undefined : props.onContinue?.(note);
  });
  const continueTurn = props.onContinue && !props.running ? latestEnd : null;
  // The turns the chat's lids stopped (the lid outcomes this device kept): one per lid, never a stop of the person's own.
  const lids = useSyncExternalStore(subscribeLidStops, lidStops, noLidStops);
  const scope = sessionId ?? workspaceId ?? "";
  const sleptEnds = useMemo(() => [...lidStoppedEnds(items, lids[scope])].join(" "), [items, lids, scope]);
  // The one button beside an error: the chat's ids and its end go to the preview, where the person decides what is sent.
  const report = useStableCallback((text: string) =>
    reportProblem({
      surface: "chat",
      error: { name: "TurnFailed", message: text },
      ...(props.engine ? { providerId: props.engine } : {}),
      ...(sessionId ? { threadId: sessionId } : {}),
      threadExcerpt: threadExcerpt(items),
    }),
  );
  // Stable, reading the client when pressed: a reconnect re-renders no reply.
  const run = useStableCallback((command: string) => {
    if (!workspaceId) return;
    revealSurface?.(workspaceId);
    pressRun(client, workspaceId, command);
  });
  const actions = useMemo<TranscriptActions>(() => {
    const pending = pendingKey ? pendingKey.split(" ") : [];
    return {
      restore: canRestore ? restore : null,
      restoreAfter,
      fork: canFork ? fork : null,
      openWorkspace: canOpen2 ? openWorkspace : null,
      pending,
      index: Math.min(page, Math.max(0, pending.length - 1)),
      onPage: setPage,
      openFile: workspaceId ? (path, line) => openFileSurface(workspaceId, path, line) : null,
      build: canBuild ? build : null,
      scope,
      openChanges: workspaceId ? (turn, path) => openSurface(workspaceId, "diff", path ? { turn, path } : { turn }) : null,
      turnChanges,
      editFrom: canEdit ? editFrom : null,
      workspaceId: workspaceId ?? null,
      run: workspaceId ? run : null,
      cardTurn,
      settle: canSettle ? settle : null,
      report,
      sources,
      projectId,
      continueTurn,
      continueFrom: props.onContinue ? continueFrom : null,
      sleptEnds,
    };
  }, [sleptEnds, scope, continueTurn, continueFrom, props.onContinue, pendingKey, page, canRestore, canFork, restoreAfter, canOpen2, workspaceId, canBuild, turnChanges, canEdit, restore, fork, openWorkspace, build, editFrom, run, cardTurn, canSettle, settle, report, sources, projectId, openSurface, openFileSurface]);
  // Only a messenger draws its speaker's reactions, each on the person's bubble it answers.
  const speakerName = props.speaker?.name ?? null;
  const reactions = useMemo(
    () => (props.messenger && props.reactions && props.reactions.size > 0 ? { by: props.reactions, name: speakerName } : null),
    [props.messenger, props.reactions, speakerName],
  );
  return (
    <StreamView revision={props.historyVersion ?? 0}>
    <Actions.Provider value={actions}>
    <WorkspaceRootProvider value={root}>
    <ChatWorkspaceProvider value={props.workspaceId ?? null}>
    <FileRefsContext.Provider value={refs}>
    <FindQuery.Provider value={find.open ? find.query.trim() : ""}>
    <FindCurrent.Provider value={find.open ? find.current : null}>
    <ChatGallery artifacts={artifacts} workspaceId={props.workspaceId ?? null}>
    <InlineRefsContext.Provider value={props.inlineRefs ?? null}>
    <MessengerReactions.Provider value={reactions}>
    <div ref={box} className="relative">
      {find.open ? (
        // Sticky at the top right of the chat; takes no height of its own.
        <div className="pointer-events-none sticky z-30 flex h-0 justify-end [overflow-anchor:none]" style={{ top: "calc(var(--pane-top, 0px) + 8px)" }}>
          <FindBar query={find.query} index={find.index} total={find.total} onQuery={find.setQuery} onStep={find.step} onClose={find.close} focusKey={find.focusKey} />
        </div>
      ) : null}
      {sessionId && props.workspaceId ? <QuoteSelection box={box} workspaceId={props.workspaceId} /> : null}
      {/* The rail is for a pointer: a phone scrolls, and its chat has no gutter for it. */}
      {sessionId && rail.length > 1 && !phone ? (
        // Never the scroller's anchor: the rail is the first thing in the chat and always in view, so the browser held
        // the view to it, which never moves, and nothing growing above the view was ever taken up: rows laid out for
        // the first time, pictures loading and folds opening all pushed what was being read down the screen.
        // Its bottom reaches through the conversation's room under the latest turn (ROOM_REACH), so the rail stays in view.
        <div {...{ [ROOM_REACH]: "" }} className="absolute bottom-0 top-0 z-20 w-9 [overflow-anchor:none]" style={{ left: 8 - railInset }}>
          <div className="sticky flex items-center" style={{ top: "var(--pane-top, 0px)", height: railHeight ? `calc(${railHeight - 24}px - var(--pane-top, 0px))` : 0 }}>
            <MessageRail messages={rail} sessionId={sessionId} root={box} reveal={revealRef} />
          </div>
        </div>
      ) : null}
      {/* What the rows read, not every prop: a parent's fresh callbacks re-render no rows. */}
      <Items
        key={sessionId}
        place={sessionId}
        items={items}
        engineLabel={props.engineLabel}
        engineIsCaveman={props.engineIsCaveman}
        {...(props.engine !== undefined ? { engine: props.engine } : {})}
        {...(props.model !== undefined ? { model: props.model } : {})}
        {...(props.speaker ? { speaker: props.speaker } : {})}
        running={props.running}
        {...(props.stopping ? { stopping: true } : {})}
        {...(props.model ? { model: props.model } : {})}
        {...(props.toolCards ? { toolCards: props.toolCards } : {})}
        {...(props.keepCards ? { keepCards: props.keepCards } : {})}
        {...(props.momentCards ? { momentCards: props.momentCards } : {})}
        {...(props.restoreAfter !== undefined ? { restoreAfter: props.restoreAfter } : {})}
        artifacts={artifacts}
        onAnswer={onAnswer}
        cavemanVersion={cavemanVersion}
        openArtifactId={openArtifactId}
        revealRef={revealRef}
        {...(onOpenArtifact ? { onOpenArtifact } : {})}
        {...(props.workedLines ? { workedLines: true } : {})}
        {...(props.messenger ? { messenger: true } : {})}
        {...(props.divider ? { divider: props.divider } : {})}
      />
    </div>
    </MessengerReactions.Provider>
    </InlineRefsContext.Provider>
    </ChatGallery>
    </FindCurrent.Provider>
    </FindQuery.Provider>
    </FileRefsContext.Provider>
    </ChatWorkspaceProvider>
    </WorkspaceRootProvider>
    </Actions.Provider>
    </StreamView>
  );
}

/**
 * The message rail's marks: the person's messages, each with the reply after it. A send still queued in Caveman Cloud
 * (dimmed, waiting for its computer) is not a message of the chat yet, so it makes no mark: a chat of one message and
 * a queued one shows no rail.
 */
export function railMessages(items: ReadonlyArray<TranscriptItem>): RailMessage[] {
  const out: RailMessage[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== "user" || item.queued !== undefined) continue;
    let reply = "";
    for (let j = i + 1; j < items.length && items[j]!.kind !== "user"; j++) {
      const r = items[j]!;
      if (r.kind === "assistant" && r.text.trim()) {
        reply = replyPreview(r);
        break;
      }
    }
    const known = railEntries.get(item);
    const entry = known?.reply === reply ? known : { id: item.id, text: known?.text ?? draftFromWire(item.text).text, reply };
    railEntries.set(item, entry);
    out.push(entry);
  }
  return out;
}
const railEntries = new WeakMap<TranscriptItem, RailMessage>();

/** The rail card's three clamped lines of a reply: its first words, made once per version of the reply. */
const REPLY_PREVIEW = 400;
const replyPreviews = new WeakMap<TranscriptItem, string>();
function replyPreview(item: Extract<TranscriptItem, { kind: "assistant" }>): string {
  let reply = replyPreviews.get(item);
  if (reply !== undefined) return reply;
  reply = item.text
    .slice(0, REPLY_PREVIEW * 5)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|]+|^\s*[-+]\s|\s-{2,}\s/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REPLY_PREVIEW);
  replyPreviews.set(item, reply);
  return reply;
}

function sameRail(a: ReadonlyArray<RailMessage>, b: ReadonlyArray<RailMessage>): boolean {
  return a === b || (a.length === b.length && a.every((m, i) => m === b[i]));
}

/**
 * The scroll container's height, so the rail can stick to the reading area, and how far the
 * transcript column sits in from its left edge, so the rail can hug the pane's edge however wide
 * the pane is (the column centres itself).
 */
function useScrollerBox(root: React.RefObject<HTMLElement | null>): { height: number; inset: number } {
  const [box, setBox] = useState({ height: 0, inset: 0 });
  useLayoutEffect(() => {
    const el = root.current;
    const scroller = el ? scrollParent(el) : null;
    if (!el || !scroller) return;
    const measure = () => {
      const inset = Math.round(el.getBoundingClientRect().left - scroller.getBoundingClientRect().left);
      setBox((b) => (b.height === scroller.clientHeight && b.inset === inset ? b : { height: scroller.clientHeight, inset }));
    };
    // The observer's first report comes after the frame's layout: measuring here would force one before it.
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    ro.observe(el);
    return () => ro.disconnect();
  }, [root]);
  return box;
}

function Items({
  items,
  engineLabel,
  engineIsCaveman,
  engine: engineProp,
  model: modelProp,
  speaker,
  running,
  stopping = false,
  onAnswer,
  cavemanVersion,
  artifacts,
  onOpenArtifact,
  openArtifactId,
  revealRef,
  toolCards,
  keepCards,
  momentCards,
  restoreAfter = 0,
  nested = false,
  workedLines = false,
  messenger = false,
  divider,
  place,
}: TranscriptProps & {
  artifacts: ReadonlyArray<Artifact>;
  revealRef?: React.MutableRefObject<((id: string) => void) | null>;
  /** A subagent's steps under its row: the row already says who speaks, and its parent's turn carries its changes. */
  nested?: boolean;
  /** The chat whose reader's place these rows keep (place.ts): its session. */
  place?: string | undefined;
}) {
  const engines = useRuntimeSelector((v) => v.engines);
  const identity = (recorded: string | undefined) => engineIdentity(recorded, { ...(engineProp !== undefined ? { engine: engineProp } : {}), engineLabel, engineIsCaveman }, engines);
  // What the chat held when it opened is history; only what arrives while it is open plays in (seen.ts).
  // A subagent's steps share their chat's register.
  const parentSeen = useContext(SeenItems);
  const ownSeen = useMemo(() => seenItems(), []);
  const view = useStreamView();
  const previousView = useRef(view);
  if (!nested) {
    if (previousView.current !== view) ownSeen.catchUp(items);
    else ownSeen.open(items);
  }
  previousView.current = view;
  // The caller's cards (the Chief's) stay in view, or those it keeps; the Chief's information lines fold with its steps.
  const claims = useMemo(() => keepCards ?? (toolCards ? (tools: ReadonlyArray<ToolItem>) => toolCards(tools) != null : undefined), [keepCards, toolCards]);
  // What the person opened or closed by hand, by row id (a run of steps, a turn's "Worked" fold): it holds through the
 // turn ending, which folds its rows together. upstream MessagesTimeline keeps its disclosures by id the same way.
  const [byHand, setByHand] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const { atEnd, letGo, hold } = useConversation();
  // Opened by hand while nothing streams, the row stays where it was clicked and what it opens grows below it: a chat
 // following its end pulled the clicked line up out of view (upstream #29166). While the turn runs the end keeps leading.
  const disclose = useStableCallback((id: string, open: boolean) => {
    if (open && !running) letGo();
    setByHand((m) => (m.get(id) === open ? m : new Map(m).set(id, open)));
  });
  const workDisclosures = useMemo(() => ({ choices: byHand, choose: disclose }), [byHand, disclose]);
  // Chief cards stay visible. A thought opened by hand remains readable after its stream ends.
  const folded = useMemo(() => rows(items, claims, workedLines, (key) => byHand.get(key) === true), [items, claims, workedLines, byHand]);
  // The steps the person watched stay the rows they watched as the turn ends: at the end, they close in place and fold
  // (useSettledWork); scrolled up, they fold once out of sight. Explicit disclosure choices keep the reader's work open.
  const [watching, setWatching] = useState<ReadonlySet<string>>(() => new Set());
  // Watched turns closing in place, by their fold's id: their rows shut, then the fold takes their place.
  const [closing, setClosing] = useState<ReadonlySet<string>>(() => new Set());
  // Steps of the running turn the person hid with something opened inside: hiding them closed that work's parent, so
  // it no longer holds the turn open when it ends (the choice inside stays, for when the steps show again).
  const [shelved, setShelved] = useState<ReadonlySet<string>>(() => new Set());
  const { rows: all, held: unfolded } = useMemo(() => expandHeld(folded, (fold) => byHand.get(fold.id) === undefined && (watching.has(fold.id) || fold.rows.some((row) => !shelved.has(row.id) && hasOpenWork(row, byHand)))), [folded, watching, shelved, byHand]);
  // Each finished turn's line: its model and its whole time ("Grok 4.7 worked for 43s").
  const heads = useMemo(() => turnHeads(all), [all]);
  // The latest turn's start, which the conversation's end brings to the top (Conversation's room): the person's last
  // message that began a turn. A steer stays inside its turn and a send still queued in Cloud is not in the chat yet.
  const anchorId = useMemo(
    () => (nested ? null : (all.findLast((r) => r.kind === "item" && r.item.kind === "user" && r.item.delivery !== "steer" && r.item.queued === undefined)?.id ?? null)),
    [all, nested],
  );
  // A long session mounts only its last rows; older ones mount a chunk at a time as the reader nears the top,
  // so opening a 1000-turn session never commits thousands of rows at once. A rail jump far above them mounts the
  // rows at its target on their own (the head); the rows between the head and the tail (the gap) mount a chunk at a
  // time as the reader scrolls to them, and the head joins the tail when the gap is gone.
 // ponytail: rows stay mounted once loaded; full virtualization (upstream @legendapp/list) if readers page through thousands.
  // A chat opened again where its reader left it (place.ts) mounts the rows from there on, or that row's own chunk.
  const [opening] = useState(() => {
    const at = !nested && place ? placeOf(place) : undefined;
    return { at, window: openingWindow(at ? all.findIndex((row) => row.id === at.row) : -1, all.length) };
  });
  const [shown, setShown] = useState(opening.window.shown);
  const [head, setHead] = useState<Head | null>(opening.window.head);
  // Rows arriving at the end (a live turn) or folding together there (a turn ending) move the tail, never the top: the
  // window keeps its first row. Counted from the end alone, each new row unmounted the oldest one, and the reader
  // scrolled up saw the chat drop a row's height and take it back a frame later as the sentinel mounted it again.
  const [rowCount, setRowCount] = useState(all.length);
  if (all.length !== rowCount) {
    setRowCount(all.length);
    const next = holdWindow(head, shown, rowCount, all.length);
    setHead(next.head);
    setShown(next.shown);
  }
  const from = Math.max(0, all.length - shown);
  const start = head?.a ?? from;
  const list = from === 0 ? all : all.slice(from);
  const box = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const gap = useRef<HTMLDivElement>(null);
  // Rows about to mount above the view: the commit that mounts them keeps the reader's view where it is (HoldView).
  const holding = useRef(false);
  const scroller = useCallback(() => (box.current ? scrollParent(box.current) : null), []);
  // Older rows render in a transition: React builds them between frames, so a reader scrolling up keeps every frame
  // while a chunk of history (its markdown, its code) is on the way, where one blocking commit froze the scroll.
  const older = useCallback(() => {
    holding.current = true;
    startTransition(() => {
      if (head) setHead({ a: Math.max(0, head.a - CHUNK_ROWS), b: head.b });
      else setShown((n) => n + CHUNK_ROWS);
    });
  }, [head]);
  // Fill from the side currently being read, not the last scroll direction: a rail jump can cross the
  // gap in either direction. Growing the other side would move the target out from under the reader.
  const newer = useCallback(() => {
    const el = gap.current;
    const scroller = el ? scrollParent(el) : null;
    if (!head || !el || !scroller) return;
    const fromTail = el.getBoundingClientRect().top <= scroller.getBoundingClientRect().top;
    if (fromTail) holding.current = true;
    const next = fillGap(head, from, all.length, fromTail);
    startTransition(() => {
      setHead(next.head);
      setShown(next.shown);
    });
  }, [head, from, all.length]);
  useEffect(() => {
    const el = top.current;
    if (!el || start === 0) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && older(), { root: scrollParent(el), rootMargin: `${MOUNT_AHEAD_PX}px 0px 0px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [start, older]);
  useEffect(() => {
    const el = gap.current;
    if (!el || !head) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && newer(), { root: scrollParent(el), rootMargin: `${MOUNT_AHEAD_PX}px 0px ${MOUNT_AHEAD_PX}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [head, newer]);
  // A row out of view is skipped by the browser at a guessed height (content-visibility); laid out for the first time
  // as it scrolled into view, it grew under the reader's eyes and pushed what they were reading down by hundreds of
  // pixels, each row, all the way up a chat's history. The browser's own lead (its margin around the page) does not
  // reach inside a scroller, so rows near the view are laid out here, while still out of it: there the browser's
  // scroll anchoring takes their growth, and nothing on screen moves. Far from the view they are skipped again, at
  // the height they were.
  const windowKey = `${start}:${from}:${head?.b ?? ""}`;
  useEffect(() => {
    const rowsBox = box.current;
    const root = rowsBox ? scrollParent(rowsBox) : null;
    if (!rowsBox || !root || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) (entry.target as HTMLElement).style.contentVisibility = entry.isIntersecting ? "visible" : "";
      },
      { root, rootMargin: `${LAYOUT_AHEAD_PX}px 0px` },
    );
    for (const row of rowsBox.children) if (row.hasAttribute("data-row")) io.observe(row);
    return () => io.disconnect();
    // Again when the window moves or a row comes or goes at the end: every row mounted is watched.
  }, [windowKey, all.length]);
  // The rail asks for a message that is not mounted yet: mount it and the rows after it (one short commit).
  useEffect(() => {
    if (!revealRef) return;
    revealRef.current = (id: string) => {
      // A top-level row, or the "Worked for" fold that holds it (find in chat steps into folds).
      const at = all.findIndex((row) => rowHolds(row, id));
      // Mounted already, in the tail or the head: find asks again on every change to the chat, and starting the head
      // over at its row would unmount the rows the reader has scrolled up into above it.
      if (at < 0 || at >= from || (head && at >= head.a && at < head.b)) return;
      const next = jumpWindow(at, from, all.length);
      setHead(next.head);
      setShown(next.shown);
    };
  }, [revealRef, all, from, head]);
  const last = items.at(-1);
  // A line that animates on its own (a running tool or builder, streaming text, a compaction, a retry) stands in for the "Working" mascot.
  // A running tool can sit above its live output, screenshots or the turn's doc cards, so the turn's live end still
  // says "Working" under it. A subagent's line says Working itself; streaming text, a compaction and a retry are the live end.
 // An open ask stops the turn on the person (compact "Waiting for approval"): the header says so, the step it holds
  // waits rather than ticks (HeldSteps), and its card is the live end. The held ids as a string keep the set stable
  // while the rest of the turn streams, so the step lines that read it re-render only when an ask comes or goes.
  const waitingOn = items.findLast((i): i is Extract<TranscriptItem, { kind: "ask" }> => i.kind === "ask" && i.resolution === null);
  const heldKey = items.flatMap((i) => (i.kind === "ask" && i.resolution === null && i.toolItemId ? [i.toolItemId] : [])).join("\n");
  const held = useMemo<ReadonlySet<string>>(() => new Set(heldKey ? heldKey.split("\n") : []), [heldKey]);
  const stepping = items.some((i) => i.kind === "tool" && i.status === "running" && !held.has(i.id));
  const busy =
    stepping ||
    last?.kind === "retry" ||
    items.some((i) => ((i.kind === "assistant" || i.kind === "reasoning") && i.streaming) || (i.kind === "compaction" && i.status === "running") || (i.kind === "subagent" && i.status === "running"));
  // A finished grill offers Build it until the user says something after it.
  const lastUser = items.findLastIndex((i) => i.kind === "user");
  // Each finished turn's checkpoint copies that turn's answer.
  const answers = useMemo(() => turnAnswers(items), [items]);
  // Each finished turn's own edits: its Changes card when no checkpoint saw them.
  const turnFiles = useMemo(() => turnEdits(items, artifacts), [items, artifacts]);
  // Each message of the person's that can be edited: the turn.done a restore goes back to.
  const edits = useMemo(() => editPoints(items, restoreAfter), [items, restoreAfter]);
  // The open turn opens with "Working for 12s" (Codex's header) in place of the speaker mark; it becomes the turn's
  // "Worked for" fold when it ends. Its file cards wait for that fold.
  const liveAt = running ? openTurn(all) : -1;
  const liveRows = useMemo(() => new Set(liveAt < 0 ? [] : all.slice(liveAt).map((r) => r.id)), [all, liveAt]);
  const liveHead = liveAt < 0 ? undefined : all.slice(liveAt).find((r) => r.speaker)?.id;
  const opener = liveAt > 0 ? all[liveAt - 1] : undefined;
  const liveSince = opener?.kind === "item" && opener.item.kind === "user" ? opener.item.at : null;
  const liveWho = useMemo(() => (liveAt < 0 ? null : turnModel(all.slice(liveAt).flatMap(rowItems))), [all, liveAt]);
  // A messenger's runs (messenger.tsx): the rows between two of the person's messages are one run of the speaker's,
  // named over its first row, its character beside its last. While it works, the live end is the run's last row.
  const runs = useMemo(() => {
    if (!messenger || nested) return null;
    const starts = new Set<string>();
    const ends = new Set<string>();
    let after = true;
    let lastOwn: string | null = null;
    for (const row of all) {
      // Its folded steps draw nothing here (renderRow): what it did shows as its cards, its moments and its board.
      if (row.kind === "fold") continue;
      if (row.kind === "item" && row.item.kind === "user" && !row.item.generated) {
        if (lastOwn !== null) ends.add(lastOwn);
        lastOwn = null;
        after = true;
        continue;
      }
      if (after) starts.add(row.id);
      after = false;
      // A turn's footer (its copy and time) sits under the run: the character stands at the last thing it said.
      if (!(row.kind === "item" && row.item.kind === "turn_end")) lastOwn = row.id;
    }
    if (lastOwn !== null && !running) ends.add(lastOwn);
    return { starts, ends, open: lastOwn === null };
  }, [messenger, nested, all, running]);
  // The open turn's steps (liveSteps): behind its "Working for" line until the person opens them; the choice holds
  // for the turns after (live-steps.ts), so someone who likes to watch sees every step and someone who doesn't, none.
  const stepsOpen = useLiveSteps();
  const steps = useMemo(() => (liveAt < 0 || nested ? NO_ROWS : liveSteps(all.slice(liveAt), claims, workedLines)), [all, liveAt, nested, claims, workedLines]);
  // Find in chat stepped to something behind the folded line: that step shows while it is the match, and the
  // person's choice to keep steps folded stands (as a finished turn's fold opens for a match, Fold below).
  const found = useContext(FindCurrent);
  const hidden = useMemo(() => {
    if (stepsOpen || !steps.size) return NO_ROWS;
    const holder = found ? all.find((r) => steps.has(r.id) && rowHolds(r, found)) : undefined;
    if (!holder) return steps;
    const rest = new Set(steps);
    rest.delete(holder.id);
    return rest;
  }, [stepsOpen, steps, found, all]);
  // What a hidden step still shows: its pictures, pages and pull requests, as under a finished turn's fold.
  const stepPictures = (row: Row) => foldShows([row], artifacts);
  // The live end's words. Steps shown: "Working" while one runs, "Thinking" between them. Steps hidden: the kind of
  // work running now with what it is on ("Exploring note2.md", step-line.ts), so the turn reads as it goes; nothing
  // while its reply streams or an ask waits.
  const root = useWorkspaceRoot();
  const runningStep = items.findLast((i): i is ToolItem => i.kind === "tool" && i.status === "running" && !held.has(i.id));
  const liveStep = !stopping && !waitingOn && stepping && hidden.size > 0 ? runningStep : undefined;
  const liveWord = stopping
    ? "Stopping"
    : waitingOn
      ? null
      : stepping
        ? liveStep ? "step" : "Working"
        : !busy || (hidden.size > 0 && items.some((i) => i.kind === "reasoning" && i.streaming) && !items.some((i) => i.kind === "assistant" && i.streaming))
          ? "Thinking"
          : null;
  // Which line says it decides the motion: the same kind fills in place (the next file it reads), a new one rolls in.
  const shownLine = useRef<StepLine | null>(null);
  const raw: StepLine | null = liveWord === null ? null : liveStep ? stepLine(liveStep, shownLine.current, root) : liveWord === "Thinking" ? THINKING : { id: liveWord, words: liveWord };
  const stable = useRef(raw);
  if (lineKey(stable.current) !== lineKey(raw)) stable.current = raw;
  // Said at a steady pace, and in place (Rolling below): a step's words stay through the short gap before the next
  // step instead of flickering to "Thinking" and back; "Thinking" shows only once the quiet is real.
  const saying = useSteady(stable.current, STEADY_MS, (from, to) => (to?.id === THINKING.id && from !== null && from.id !== THINKING.id ? THINKING_AFTER_MS : 0));
  shownLine.current = saying;
  // Nothing shows between the working line and the live end: the two read as one block, the step line 8px under.
  // A hidden step's pictures still show (stepPictures), and the live end goes under them.
  const bare = liveAt >= 0 && hidden.size > 0 && all.slice(liveAt).every((r) => hidden.has(r.id) && !stepPictures(r));
  // The live turn's current run: the last row, or a run with a step still going.
  const lastRow = all.at(-1);
  const activeRun = (row: Extract<Row, { kind: "work" }>) => liveRows.has(row.id) && (row === lastRow || row.items.some((i) => (i.kind === "tool" ? i.status === "running" : i.streaming)));
  // Steps the person never saw are never watched: with them hidden, the turn folds the moment it ends, as it ran.
  // Only steps on screen are watched: a turn whose steps the person never saw folds the moment it ends, as it ran.
  const seenSteps = useMemo(() => (nested ? new Set([...liveRows].filter((id) => !hidden.has(id))) : new Set([...steps].filter((id) => !hidden.has(id)))), [nested, liveRows, steps, hidden]);
  const joining = joinWatched(folded, watching, (row) => !hidden.has(row.id) && activeRun(row), seenSteps);
  const unseen = hidden.size ? [...watching].filter((id) => hidden.has(id)) : [];
  if (joining.length || unseen.length)
    setWatching((was) => {
      const next = new Set([...was, ...joining]);
      for (const id of unseen) next.delete(id);
      return next;
    });
  const liveList = liveAt < 0 ? [] : all.slice(liveAt);
  const shelve = liveList.filter((r) => hidden.has(r.id) && !shelved.has(r.id) && hasOpenWork(r, byHand)).map((r) => r.id);
  const unshelve = liveList.filter((r) => shelved.has(r.id) && !hidden.has(r.id)).map((r) => r.id);
  if (shelve.length || unshelve.length)
    setShelved((was) => {
      const next = new Set([...was, ...shelve]);
      for (const id of unshelve) next.delete(id);
      return next;
    });
  // Something watched has left the view (rows `from` to `to`): it folds, out of sight. Over the top of the view, the
  // rows in view keep their place: the view moves by how far the row after them moved, in the chat's own coordinates,
  // so a row the browser is skipping (content-visibility) moves nothing yet. Following the end, the end holds them.
  // Opened again where the reader left it: the view goes back to that row before the first paint, let go of the end
  // (the conversation keeps a view its rows placed). One they were following opens at its end, as any chat does. Rows
  // lay out over the next frames (content-visibility sizes them as they come into view, older rows mount above), so the
 // row is held at its place every frame for RESTORE_MS, as upstream restore reconciles its row, unless the reader moves.
  // Meanwhile every row lays out at its real size (no content-visibility guess): rows sized as they neared the view
  // moved the row a little each frame. Each one's size is remembered meanwhile (`contain-intrinsic-size: auto`), so once
  // settled, a row the browser skips keeps the size it was seen at and nothing moves.
  const restoring = useRef(false);
  const [settling, setSettling] = useState(opening.at !== undefined);
  useLayoutEffect(() => {
    const at = opening.at;
    const rowsBox = box.current;
    const scroller = rowsBox ? scrollParent(rowsBox) : null;
    if (!at) return;
    if (!rowsBox || !scroller || !rowsBox.querySelector(`:scope > [data-row="${CSS.escape(at.row)}"]`)) return setSettling(false);
    letGo();
    restoring.current = true;
    setSettling(true);
    /** Moves the view so the row stands at its place. */
    const hold = () => {
      const row = rowsBox.querySelector(`:scope > [data-row="${CSS.escape(at.row)}"]`);
      const off = row ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - at.offset : 0;
      if (Math.abs(off) >= 1) scroller.scrollTop += off;
    };
    hold();
    const started = performance.now();
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
      setSettling(false);
      for (const type of MOVES) scroller.removeEventListener(type, stop);
    };
    const tick = () => {
      hold();
      if (performance.now() - started > RESTORE_MS) stop();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    for (const type of MOVES) scroller.addEventListener(type, stop, { passive: true });
    return stop;
  }, []);
  // Where the reader is, kept past this view (a chat its pane stops keeping rendered): read once their scrolling has
  // settled, not on the frame it lands (rows coming into view are still the size content-visibility guessed then), and
  // forgotten while they follow the end. A hidden chat (display: none) has no place to read, and a view still being put
  // back has none of its own yet.
  const following = useRef(atEnd);
  useLayoutEffect(() => {
    const was = following.current;
    following.current = atEnd;
    if (atEnd && !was && place && !nested) rememberPlace(place, null);
  }, [atEnd, place, nested]);
  useEffect(() => {
    const rowsBox = box.current;
    const scroller = rowsBox ? scrollParent(rowsBox) : null;
    if (nested || !place || !rowsBox || !scroller) return;
    let timer = 0;
    const save = () => {
      if (following.current || restoring.current || scroller.clientHeight === 0) return;
      const rows = [...rowsBox.querySelectorAll<HTMLElement>(":scope > [data-row]")].map((el) => ({ id: el.dataset.row!, el }));
      rememberPlace(place, readPlace(scroller, rows));
    };
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, PLACE_SETTLE_MS);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [place, nested]);
  const release = useStableCallback((ids: ReadonlyArray<string>, from: HTMLElement, above: boolean, to: HTMLElement = from) => {
    const scroller = scrollParent(from);
    let outer = to.closest("[data-row]");
    for (let up = outer?.parentElement?.closest("[data-row]"); up; up = up.parentElement?.closest("[data-row]")) outer = up;
    const next = outer?.nextElementSibling;
    const at = (el: Element) => el.getBoundingClientRect().top + (scroller?.scrollTop ?? 0);
    const before = above && !atEnd && scroller && next ? { top: scroller.scrollTop, next: at(next) } : null;
    flushSync(() => {
      setWatching((was) => {
        const left = new Set(was);
        for (const id of ids) left.delete(id);
        return left;
      });
      setClosing((was) => (ids.some((id) => was.has(id)) ? new Set([...was].filter((id) => !ids.includes(id))) : was));
    });
    if (before && scroller && next?.isConnected) scroller.scrollTop = before.top + (at(next) - before.next);
  });
  // A turn the person watched end is its rows until all of them have left the view, one way: then it folds. Rows that
  // straddle the view (the first above it, the last below) stay. Only its first and last rows need watching for that.
  const unfoldedKey = unfolded.map((f) => `${f.id}:${f.rows[0]}:${f.rows.at(-1)}`).join("|");
  const idle = useMemo(() => idleFolds(folded, unfolded, byHand), [folded, unfolded, byHand]);
  const close = useStableCallback((ids: ReadonlyArray<string>) => setClosing((was) => (ids.every((id) => was.has(id)) ? was : new Set([...was, ...ids]))));
  useSettledWork({ box, folds: idle, enabled: !running && atEnd && !waitingOn, onClose: close, onFold: release });
  useEffect(() => {
    const rowsBox = box.current;
    const root = rowsBox ? scrollParent(rowsBox) : null;
    if (!rowsBox || !root || !unfoldedKey) return;
    const row = (id: string | undefined) => (id === undefined ? null : rowsBox.querySelector<HTMLElement>(`:scope > [data-row="${CSS.escape(id)}"]`));
    const observers = unfolded.flatMap((fold) => {
      const first = row(fold.rows[0]);
      const last = row(fold.rows.at(-1));
      if (!first || !last) return [];
      const seen = new Map<Element, IntersectionObserverEntry>();
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) seen.set(entry.target, entry);
          const a = seen.get(first);
          const b = seen.get(last);
          if (!a || !b || a.isIntersecting || b.isIntersecting || !a.rootBounds?.height || !b.rootBounds) return;
          const above = b.boundingClientRect.bottom <= b.rootBounds.top;
          if (!above && a.boundingClientRect.top < a.rootBounds.bottom) return;
          io.disconnect();
          release([fold.id, ...fold.rows], first, above, last);
        },
        { root },
      );
      io.observe(first);
      if (last !== first) io.observe(last);
      return [io];
    });
    return () => observers.forEach((io) => io.disconnect());
    // Keyed by the spans, not the array: a streamed token makes a new array of the same spans.
  }, [unfoldedKey, release]);
  // The first row of a held turn heads it: its line folds the turn by hand.
  const unfoldedHeads = useMemo(() => new Map(unfolded.map((f) => [f.rows[0]!, f.id])), [unfolded]);
  // Each held row's fold: held rows draw as the live steps did (same structure, so nothing remounts) and close with it.
  const heldIn = useMemo(() => new Map(unfolded.flatMap((f) => f.rows.map((id) => [id, f.id] as const))), [unfolded]);
  // A fold's rows render inside it, opened by hand: each run whole, and the screenshots once, under the fold's line.
  const body = (row: Row, inFold: boolean): ReactNode => {
    if (row.kind === "fold")
      return (
        <Fold
          row={row}
          head={nested ? undefined : heads.get(row.id)}
          plain={workedLines && !nested}
          who={identity(rowItems(row)[0]?.engine)}
          opened={byHand.get(row.id) === true}
          onDisclose={disclose}
          artifacts={artifacts}
          onOpen={onOpenArtifact}
          openId={openArtifactId}
        >
          {row.rows.map((r) => (
            <div key={r.id}>{body(r, true)}</div>
          ))}
        </Fold>
      );
    if (row.kind === "agents")
      return (
        <SubagentGroup
          items={row.items}
          {...identity(row.items[0]!.engine)}
          onAnswer={onAnswer}
          artifacts={artifacts}
          onOpenArtifact={onOpenArtifact}
          openArtifactId={openArtifactId}
        />
      );
    if (row.kind === "work") {
      const cards = toolCards?.(workTools(row.items));
      if (cards != null) {
        const thoughts = row.items.filter((i) => i.kind === "reasoning");
        return (
          <>
            {thoughts.length ? <Work items={thoughts} artifacts={artifacts} onOpen={onOpenArtifact} openId={openArtifactId} /> : null}
            {cards}
          </>
        );
      }
      // Its screenshots show under it as they come, so none land at the turn's end; in a fold, under the fold's line.
      return (
        <Work
          id={row.id}
          items={row.items}
          artifacts={artifacts}
          onOpen={onOpenArtifact}
          openId={openArtifactId}
          cards={!inFold}
          generated={!inFold}
          active={!inFold && activeRun(row)}
          // A fold opened by hand opens its runs too: one click shows every step.
          opened={byHand.get(row.id) ?? (inFold && workTools(row.items).length > 1 ? true : undefined)}
          onDisclose={disclose}
        />
      );
    }
    if (row.item.kind === "moment" && momentCards) return momentCards(row.item);
    return (
      <Item
        item={row.item}
        live={running && row.item === last}
        {...identity(row.item.engine)}
        onAnswer={onAnswer}
        cavemanVersion={cavemanVersion}
        artifacts={artifacts}
        onOpenArtifact={onOpenArtifact}
        openArtifactId={openArtifactId}
        built={row.item.kind === "grill_finished" && items.indexOf(row.item) < lastUser}
        {...(row.item.kind === "turn_end" && answers.has(row.item.id) ? { answer: answers.get(row.item.id)! } : {})}
        {...(row.item.kind === "turn_end" && turnFiles.has(row.item.id) ? { edited: turnFiles.get(row.item.id)! } : {})}
        {...(row.item.kind === "user" && edits.has(row.item.id) ? { editAt: edits.get(row.item.id)! } : {})}
        // A reply folded into "Worked for": its pictures and pull requests show under the fold's line, once.
        cards={!inFold}
      />
    );
  };
  // A fold is its turn's header; the open turn's first row carries "Working for"; any other turn's first row, the speaker mark.
  const header = (row: Row): ReactNode => {
    // A messenger names who speaks once, over the run; its live end is the dots (below), not a working line.
    if (runs) return runs.starts.has(row.id) && speaker ? <MessengerName name={speaker.name} /> : null;
    if (!row.speaker || nested || row.kind === "fold") return null;
    if (liveRows.has(row.id)) {
      if (row.id !== liveHead) return null;
      const who = identity(liveWho?.engine);
      return (
        <WorkingFor
          since={liveSince}
          engine={who.engine}
          label={who.engineLabel}
          model={liveWho?.model ?? modelProp}
          waiting={waitingOn?.askKind}
          plain={workedLines}
          {...(steps.size
            ? {
                open: stepsOpen,
                onToggle: () => {
                  // The steps open under the line before the view follows on: the line stays where it was clicked.
                  hold();
                  setLiveSteps(!stepsOpen);
                },
              }
            : {})}
        />
      );
    }
    // A turn the person watched end, still the rows they watched: its line stands where "working for" stood, and folds it.
    const holding = unfoldedHeads.get(row.id);
    if (holding !== undefined) {
      const head = heads.get(row.id);
      const open = !closing.has(holding);
      return <FoldHead plain={workedLines} head={head} who={identity(rowItems(row)[0]?.engine)} ms={head?.ms ?? null} open={open} onToggle={() => disclose(holding, !open)} />;
    }
    if (speaker && workedLines) {
      // How long the turn worked, as its fold reads; a turn the Chief started itself (a wake) has no start to count from.
      // A turn that spoke before its work folded says nothing here: each fold below says its own time (rows.ts).
      const ms = heads.get(row.id)?.ms ?? null;
      return ms === null || heads.get(row.id)?.folds ? null : (
        <p className="mb-2.5 mt-5 text-[13.5px] text-muted-foreground">
          <WorkedLine ms={ms} />
        </p>
      );
    }
    if (speaker)
      return (
        <MessageHeader>
          {/* The 24px body in the header's 20px line, its feet on the baseline. */}
          <span className="-my-1 -ml-1 flex">
            <ChiefSprite avatar={speaker.avatar} pose="idle" />
          </span>
          <span className="font-medium text-foreground/80">{speaker.name}</span>
        </MessageHeader>
      );
    const first = row.kind === "item" ? row.item : row.items[0];
    const who = identity(first?.engine);
    // A finished turn opens with who ran it and for how long; one with nothing folded is the line alone.
    const head = heads.get(row.id);
    if (head)
      return (
        <div className={TURN_LINE}>
          <TurnTitle engine={who.engine} label={who.engineLabel} model={head.model} ms={head.ms} />
        </div>
      );
    return <MessageHeader><EngineMark engine={who.engine} /><span>{who.engineLabel}</span></MessageHeader>;
  };
  // The caller's separators go between rows, by when each began (a row with no timed item takes its neighbour's).
  const startedAt = useMemo(() => {
    const at = new Map<string, { at: string | undefined; prev: string | undefined }>();
    let last: string | undefined;
    for (const row of all) {
      const first = rowItems(row).find((i) => "at" in i && typeof i.at === "string") as { at: string } | undefined;
      at.set(row.id, { at: first?.at ?? last, prev: last });
      last = first?.at ?? last;
    }
    return at;
  }, [all]);
  const renderRow = (row: Row, edge: boolean) => {
    // A messenger keeps a finished turn's steps out of the conversation, with no "Worked" line (runs, above), unless
    // Find in chat is on one of them, and no footer under a reply: its time stamps sit between messages instead. A turn
    // that stopped or failed still says so, as TurnEnd's marker does.
    if (runs && row.kind === "fold" && !(found && rowHolds(row, found))) return null;
    if (runs && row.kind === "item" && row.item.kind === "turn_end") {
      if (row.item.outcome === "completed") return null;
      return (
        <div key={row.id} data-row={row.id} data-row-kind="turn_end">
          <Marker variant="separator" className={cn("py-2", row.item.outcome === "failed" && "text-destructive")}>
            {row.item.outcome === "interrupted" ? "Stopped" : "The turn failed"}
          </Marker>
        </div>
      );
    }
    // A messenger's hidden step is nothing on screen but its pictures (a screenshot, a generated image, as under a
    // finished turn's fold), and its name over its run's first row.
    if (runs && hidden.has(row.id)) {
      const tools = row.kind === "work" ? workTools(row.items) : [];
      const shots = tools.length ? runShots(tools, artifacts) : [];
      const pictures = shots.length > 0 || tools.some((t) => isImageGeneration(t.name));
      if (row.id !== liveHead && !pictures && !runs?.starts.has(row.id)) return null;
      return (
        <div key={row.id} data-row={row.id} className={cn((row.id === liveHead || runs?.starts.has(row.id)) && "pt-3")}>
          {runs ? (
            <MessengerRow avatar={speaker?.avatar ?? null} end={false} working={false}>
              {header(row)}
              {pictures ? (
                <>
                  <ChatImages images={shots} />
                  <GeneratedImages tools={tools} artifacts={artifacts} />
                </>
              ) : null}
            </MessengerRow>
          ) : (
            <>
              {row.id === liveHead ? header(row) : null}
              {pictures ? (
                <>
                  <ChatImages images={shots} />
                  <GeneratedImages tools={tools} artifacts={artifacts} />
                </>
              ) : null}
            </>
          )}
        </div>
      );
    }
    const when = startedAt.get(row.id);
    const divide = divider && when?.at && !nested ? divider(when.at, when.prev) : null;
    // A step of the running turn can sit behind its "Working for" line (liveSteps), and the steps of a turn the person
    // watched end close as it ends (useSettledWork). Shut, a step is nothing on screen but its pictures (as under a
    // finished turn's fold), and its row takes its gap with it (styles.css, data-shut); the first one heading the turn
    // keeps its line. Its body opens and closes in the shared disclosure, so showing or hiding the steps is one smooth
 // move, never a pop, and a held step is
    // drawn the same way as the live one it was, so the turn ending remounts nothing.
    const heldBy = heldIn.get(row.id);
    if (steps.has(row.id) || heldBy !== undefined) {
      const shut = hidden.has(row.id) || (heldBy !== undefined && closing.has(heldBy));
      const pictures = shut ? stepPictures(row) : null;
      return (
        <div
          key={row.id}
          data-row={row.id}
          data-row-kind={row.kind === "item" ? row.item.kind : row.kind}
          data-step-row=""
          data-shut={(shut && row.id !== liveHead && !unfoldedHeads.has(row.id) && !pictures) || undefined}
          className={cn(row.speaker && "pt-3", !edge && !shut && "[content-visibility:auto] [contain-intrinsic-size:auto_96px]")}
        >
          {shut ? null : divide}
          {runs ? (
            <MessengerRow avatar={speaker?.avatar ?? null} end={false} working={false}>
              {header(row)}
              <DisclosureContent open={!shut}>{body(row, false)}</DisclosureContent>
            </MessengerRow>
          ) : (
            <>
              {header(row)}
              <DisclosureContent open={!shut}>{body(row, false)}</DisclosureContent>
            </>
          )}
          {pictures ? (
            <>
              <ChatImages images={pictures.shots} />
              <GeneratedImages tools={pictures.tools} artifacts={artifacts} />
              <HtmlPages tools={pictures.tools} onOpen={onOpenArtifact} openId={openArtifactId} />
              <ArtifactCards artifacts={pictures.prs} onOpen={onOpenArtifact} openId={openArtifactId} />
            </>
          ) : null}
        </div>
      );
    }
    return (
      <div
        key={row.id}
        // Rows out of view skip style, layout and paint: a 300-turn session lays out only what is on screen.
        // The live end (asks, streaming text) is left alone.
        data-row={row.id}
        data-row-kind={row.kind === "item" ? row.item.kind : row.kind}
        data-steering={row.kind === "item" && row.item.kind === "user" && row.item.delivery === "steer" || undefined}
        {...(row.id === anchorId ? { [TURN_ANCHOR]: "" } : {})}
        className={cn(row.speaker && "pt-3", runs?.starts.has(row.id) && "pt-3", !edge && "[contain-intrinsic-size:auto_96px]", !edge && !settling && "[content-visibility:auto]")}
      >
        {divide}
        {runs && !(row.kind === "item" && row.item.kind === "user" && !row.item.generated) ? (
          <MessengerRow avatar={speaker?.avatar ?? null} end={runs.ends.has(row.id)} working={false}>
            {header(row)}
            {body(row, false)}
          </MessengerRow>
        ) : (
          <>
            {header(row)}
            {body(row, false)}
          </>
        )}
      </div>
    );
  };
  const compacting = running && !busy && last?.kind === "user" && /^\/compact(\s|$)/i.test(last.text.trim());
  // The person's message has gone and nothing of the turn is back yet (sent just now, or found already working).
  const awaiting = !compacting && !nested && (running || (last?.kind === "user" && last.pending && last.queued === undefined)) && !busy && last?.kind === "user" ? last : null;
  const awaitingWho = identity(undefined);
  return (
    // Its own rows only: a subagent's steps nested under them are a chat's, never a messenger's.
    <MessengerContext.Provider value={runs !== null}>
    <SeenItems.Provider value={nested ? parentSeen : ownSeen}>
    <HeldSteps.Provider value={held}>
    <WorkDisclosuresContext.Provider value={workDisclosures}>
    <HoldView window={windowKey} holding={holding} scroller={scroller} />
    <div ref={box} data-transcript-rows data-nested={nested || undefined} className={cn("transcript-rows flex flex-col", nested ? "gap-1" : "gap-2")}>
      {start > 0 ? <div ref={top} aria-hidden className="h-px" /> : null}
      {/* One keyed list (head, gap, tail), so the head joining the tail keeps its rows mounted. */}
      {[
        ...(head ? all.slice(head.a, head.b).map((row) => renderRow(row, false)) : []),
        ...(head ? [<div key="transcript-gap" ref={gap} data-transcript-gap={!nested || undefined} aria-hidden className="h-px" />] : []),
        ...list.map((row, i) => renderRow(row, i >= list.length - 6)),
      ]}
      {compacting ? (
        // A /compact turn: some engines report nothing until it is done.
        <Compaction item={PENDING_COMPACTION} />
      ) : null}
      {awaiting && runs ? (
        // A messenger: its name and the dots, where its first words will be.
        <div className="pt-3">
          <MessengerRow avatar={speaker?.avatar ?? null} end working>
            {speaker ? <MessengerName name={speaker.name} /> : null}
            <MessengerTyping label={stopping ? "Stopping" : "Working"} />
          </MessengerRow>
        </div>
      ) : awaiting ? (
        // Nothing back yet: the turn's own line, "<logo> Opus 5.5 working for 2s", laid out as the open turn's first
        // row carries it (a step's, a reply's or a fold's row: 4px over its header, styles.css), so the first step or
        // word lands under it in place and the line never moves.
        <div className="pt-1">
          <WorkingFor since={awaiting.at} engine={awaitingWho.engine} label={awaitingWho.engineLabel} model={modelProp} plain={workedLines} />
          {stopping ? (
            <div className="mt-1 flex h-7 items-center text-[13px] text-muted-foreground">
              <span className="lucy-shimmer">Stopping</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {compacting || awaiting ? null : running && runs ? (
        // A messenger's live end: its character, the dots and what it is doing, under its last words.
        <div data-live-end className={cn("min-w-0", runs.open && "pt-3")}>
          <MessengerRow avatar={speaker?.avatar ?? null} end working>
            {runs.open && speaker ? <MessengerName name={speaker.name} /> : null}
            <MessengerTyping label={saying?.words ?? "Working"} />
          </MessengerRow>
        </div>
      ) : running ? (
        // The header already says "Working for", often scrolled away: Codex's quiet status line keeps the live end
        // saying so, "Working" while a step runs, "Thinking" between steps. Its line stays while a reply streams, empty,
        // and is the footer's height (TurnFooter, mt-1 h-7): a reply starting, a reply ending and the turn ending swap
        // what fills it, so the chat never shrinks a line and regrows it (no bounce at the live end).
        <div data-live-end data-bare={bare || undefined} className={cn("flex h-7 min-w-0 items-center text-[13px] text-muted-foreground", bare ? "-mt-[18px]" : "mt-1")}>
          {saying ? (
            <Rolling id={saying.id} className="min-w-0 flex-1">
              {/* Its mark in the engine mark's column and its words under the working line's: two lines, one block. */}
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">
                  {saying.icon ? <Icon icon={TOOL_ICON[saying.icon]} /> : <Icon icon={BulbIcon} />}
                </span>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className={cn("lucy-shimmer truncate", saying.detail ? "shrink-0" : "min-w-0")}>{saying.words}</span>
                  {saying.detail ? (
                    <span key={saying.detail} className="stream-detail min-w-0 truncate text-[hsl(var(--subtle-foreground))]">
                      {saying.detail}
                    </span>
                  ) : null}
                </span>
              </span>
            </Rolling>
          ) : null}
        </div>
      ) : null}
    </div>
    </WorkDisclosuresContext.Provider>
    </HeldSteps.Provider>
    </SeenItems.Provider>
    </MessengerContext.Provider>
  );
}

const NO_ROWS: ReadonlySet<string> = new Set();
/** A finished turn's line ("Opus 5.5 worked for 17s", "Worked for 8s"): Codex's divider runs on from its words. */
const TURN_LINE = "transcript-turn-head mb-2 flex min-h-7 items-center after:ml-2 after:h-px after:flex-1 after:bg-border/60 after:content-['']";
/** How long a step's words stay at the live end once it ends before "Thinking" replaces them. */
const THINKING_AFTER_MS = 900;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A work run re-renders only when one of its steps (or the artifacts) changed. */
const Work = memo(
  WorkRun,
  (a, b) =>
    a.artifacts === b.artifacts &&
    a.onOpen === b.onOpen &&
    a.openId === b.openId &&
    a.cards === b.cards &&
    a.generated === b.generated &&
    a.active === b.active &&
    a.id === b.id &&
    a.opened === b.opened &&
    a.onDisclose === b.onDisclose &&
    a.items.length === b.items.length &&
    a.items.every((t, i) => t === b.items[i]),
);

/**
 * The open turn's header, ticking and shimmering: "<logo> Grok 4.7 working for 36s" over a hairline, where its
 * "worked for" line will be. The line settles in place when the turn ends, the clock where it stopped. While the
 * engine waits on the person it stands still and says so: "Opus 5.5 waiting for your approval".
 */
const WorkingFor = memo(function WorkingFor({
  since,
  engine,
  label,
  model,
  waiting,
  plain = false,
  open = false,
  onToggle,
}: {
  since: string | null;
  engine: string;
  label: string;
  model: string | undefined;
  waiting?: Extract<TranscriptItem, { kind: "ask" }>["askKind"] | undefined;
  /** The Chief's quiet head, "Working 7s", where its "Worked 7s" will stand. */
  plain?: boolean;
  /** Whether the turn's steps show under the line. */
  open?: boolean;
  /** With steps to show: the line shows or hides them, as a finished turn's fold line does. */
  onToggle?: (() => void) | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (waiting) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);
  const ms = since ? now - Date.parse(since) : NaN;
  const line = plain ? (
    <span className="text-[13.5px]">
      <span className="lucy-shimmer">Working</span>
      {Number.isFinite(ms) && ms >= 0 ? <span className="tabular-nums text-[hsl(var(--subtle-foreground))]"> {duration(ms)}</span> : null}
    </span>
  ) : (
    <TurnTitle engine={engine} label={label} model={model} ms={Number.isFinite(ms) && ms >= 0 ? ms : null} live waiting={waiting} />
  );
  return (
    <div role="status" className={plain ? "mb-2.5 mt-5 flex items-center text-muted-foreground" : open ? "transcript-turn-head mb-3 flex min-h-8 items-center border-b border-border/60 pb-2" : "transcript-turn-head mb-2 flex min-h-6 items-center"}>
      {onToggle ? (
        <button
          type="button"
          aria-expanded={open}
          title={open ? "Hide the steps" : "Show the steps"}
          onClick={onToggle}
          className="group/trace-trigger flex w-fit max-w-full min-w-0 items-center gap-1 rounded-md pr-1 text-left text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {line}
          <HugeIcon icon={ArrowRight01Icon} className="size-3.5 shrink-0 transition-transform duration-150 ease-snap group-aria-expanded/trace-trigger:rotate-90" />
        </button>
      ) : (
        line
      )}
    </div>
  );
});

/**
 * Who a turn's lines name: the model's short name ("Opus 5.5"), the harness's ("Claude Agent") where no model is
 * known. Auto is not a model: a turn the router ran without saying where reads as its harness. The turn line and
 * the turn's approval card say the same name, so one agent never reads as two.
 */
function useTurnWho(engine: string, label: string, model: string | undefined): { named: string | undefined; who: string } {
  const engines = useRuntimeSelector((v) => v.engines);
  const named = model && !/(^|\/)auto$/i.test(model) ? model : undefined;
  const modelLabel = named ? engines.find((e) => e.id === engine)?.models?.find((m) => m.id === named)?.label : undefined;
  return { named, who: named ? shortModel(modelLabel, named) || label : label };
}

/** Who ran a turn and for how long: the model's mark and "Grok 4.7 worked for 43s"; the harness's name where no model is known. */
// Memo: each finished turn's header sits in the list a streamed token re-renders, with the same props.
const TurnTitle = memo(function TurnTitle({
  engine,
  label,
  model,
  ms,
  live = false,
  waiting,
}: {
  engine: string;
  label: string;
  model: string | undefined;
  ms: number | null;
  live?: boolean;
  /** The open turn's ask with no answer yet: the line says what it waits on, in the needs-input state's colour, still. */
  waiting?: Extract<TranscriptItem, { kind: "ask" }>["askKind"] | undefined;
}) {
  const { named, who } = useTurnWho(engine, label, model);
  return (
    <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
      {/* The mark names the harness; the line names the model. */}
      <span role="img" aria-label={label} className="inline-flex shrink-0">
        <VendorMark engine={engine} model={named ?? ""} size={14} />
      </span>
      {live && waiting ? (
        <span className="min-w-0 truncate">
          {who ? `${who} ` : null}
          <span className="text-[hsl(var(--warning))]">{who ? waitLine(waiting) : waitLine(waiting).replace(/^w/, "W")}</span>
        </span>
      ) : (
        <span className={cn("min-w-0 truncate tabular-nums", live && "lucy-shimmer")}>{turnLine(who, ms, live)}</span>
      )}
    </span>
  );
});

/** "Worked 24s", the time quieter than the word; "Worked" with no clock. */
function WorkedLine({ ms }: { ms: number | null }) {
  return (
    <>
      Worked{ms === null ? null : <span className="text-[hsl(var(--subtle-foreground))]"> {duration(ms)}</span>}
    </>
  );
}

/**
 * A finished turn's work as one line over a hairline, "<logo> Grok 4.7 worked for 43s ›" at the head of its
 * turn ("Worked for 12s ›" further down), opening in place to the turn as it ran; its screenshots stay in view
 * under it, and the files it changed are the turn's Changes card. A turn the person watched end is not one yet:
 * it stays the rows they watched (expandHeld) until it leaves view or settles after reader inactivity.
 */
function Fold({
  row,
  head,
  plain = false,
  who,
  opened,
  onDisclose,
  artifacts,
  onOpen,
  openId,
  children,
}: {
  row: Extract<Row, { kind: "fold" }>;
  head: TurnHead | undefined;
  /** The Chief's quiet head, "Worked 9s", with no rule or engine under the conversation. */
  plain?: boolean;
  who: { engine: string; engineLabel: string };
  /** Opened by hand (the transcript keeps it by the fold's id). */
  opened: boolean;
  onDisclose: (id: string, open: boolean) => void;
  artifacts: ReadonlyArray<Artifact>;
  onOpen?: ((id: string) => void) | undefined;
  openId?: string | null | undefined;
  children: ReactNode;
}) {
  // What it showed stays in view under its line: its tools' screenshots, pages and images, its replies' pictures and pull requests.
  const shows = useMemo(() => foldShows(row.rows, artifacts), [row.rows, artifacts]);
  const contentId = useId();
  const disclose = useStableCallback((open: boolean) => onDisclose(row.id, open));
  // A native subagent opened from the sidebar may be folded in here: the fold opens for it.
  const wanted = useRevealedSubagent();
  const holdsWanted = wanted !== null && rowsHoldSubagent(row.rows, wanted);
  // Find in chat stepped to an answer folded in here: the fold opens for it.
  const found = useContext(FindCurrent);
  const holdsFound = found !== null && row.rows.some((r) => rowHolds(r, found));
  useEffect(() => {
    if (holdsWanted || holdsFound) disclose(true);
  }, [holdsWanted, holdsFound, disclose]);
  return (
    <div data-work-disclosure="">
      <FoldHead
        plain={plain}
        head={head}
        who={who}
        ms={row.ms}
        open={opened}
        contentId={contentId}
        onToggle={() => {
          disclose(!opened);
        }}
      />
      <DisclosureContent id={contentId} open={opened}>
        <div className="flex flex-col gap-1 text-foreground">{children}</div>
      </DisclosureContent>
      {shows ? (
        <>
          <ChatImages images={shows.shots} />
          <GeneratedImages tools={shows.tools} artifacts={artifacts} />
          <HtmlPages tools={shows.tools} onOpen={onOpen} openId={openId} />
          <ArtifactCards artifacts={shows.prs} onOpen={onOpen} openId={openId} />
        </>
      ) : null}
    </div>
  );
}

/**
 * A fold's line, laid out as the open turn's "working for" line it takes the place of: "<logo> Grok 4.7 worked for
 * 43s ›" over a hairline ("Worked for 12s ›" further down its turn; the Chief's quiet "Worked 9s"). It opens or
 * folds the turn's work.
 */
function FoldHead({
  plain,
  head,
  who,
  ms,
  open,
  contentId,
  onToggle,
}: {
  plain: boolean;
  head: TurnHead | undefined;
  who: { engine: string; engineLabel: string };
  ms: number | null;
  open: boolean;
  contentId?: string;
  onToggle: () => void;
}) {
  return (
    <div className={plain ? "mb-3 mt-4 flex items-center" : TURN_LINE}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onToggle}
        className="group/trace-trigger flex w-fit max-w-full min-w-0 items-center gap-1 rounded-md pr-1 text-left text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&:hover_span]:text-foreground"
      >
        {plain ? (
          <span className="text-[13.5px]">
            <WorkedLine ms={head?.ms ?? ms} />
          </span>
        ) : head ? (
          <TurnTitle engine={who.engine} label={who.engineLabel} model={head.model} ms={head.ms} />
        ) : (
          <span className="text-[13px]">{workedFor(ms)}</span>
        )}
        <HugeIcon
          icon={ArrowRight01Icon}
          className={cn("shrink-0 transition-transform duration-150 ease-snap group-aria-expanded/trace-trigger:rotate-90", plain ? "size-3 opacity-0 group-hover/trace-trigger:opacity-100 group-aria-expanded/trace-trigger:opacity-100" : "size-3.5")}
        />
      </button>
    </div>
  );
}

const Item = memo(function Item({
  item,
  live,
  engine,
  engineLabel,
  engineIsCaveman,
  onAnswer,
  cavemanVersion,
  artifacts,
  onOpenArtifact,
  openArtifactId,
  built,
  answer,
  edited,
  editAt,
  cards = true,
}: {
  item: TranscriptItem;
  /** The last item while the session runs. */
  live: boolean;
  engine: string;
  engineLabel: string;
  engineIsCaveman: boolean;
  onAnswer: TranscriptProps["onAnswer"];
  cavemanVersion: TranscriptProps["cavemanVersion"];
  artifacts: ReadonlyArray<Artifact>;
  onOpenArtifact: TranscriptProps["onOpenArtifact"];
  openArtifactId: TranscriptProps["openArtifactId"];
  /** A grill_finished the user already answered (Build it or anything else). */
  built: boolean;
  /** A turn_end's turn's last answer, which its checkpoint copies. */
  answer?: string;
  /** A turn_end's turn's own edits, merged per file. */
  edited?: ReadonlyArray<FileArtifact>;
  /** A message of the person's: the turn.done Edit restores to. */
  editAt?: number;
  /** A reply draws its screenshots and pull requests; in a fold, the fold draws them under its line instead. */
  cards?: boolean;
}) {
  const mine = (kinds: ReadonlyArray<Artifact["kind"]>) => artifacts.filter((a) => a.itemId === item.id && kinds.includes(a.kind));
  switch (item.kind) {
    case "user":
      // The runtime wrote it for the agent: one quiet row (or the builders' result row), never the person's bubble.
      return item.generated ? <GeneratedRow made={item.generated} /> : <UserMessage item={item} images={mine(["image"])} editAt={editAt} />;
    case "assistant":
      return (
        <AssistantMessage
          item={item}
          cavemanVersion={cavemanVersion}
          artifacts={artifacts}
          onOpenArtifact={onOpenArtifact}
          extra={
            cards ? (
              <>
                {/* The reply's screenshots (its proof of UI work), small: the text draws none of them. */}
                <ChatImages images={mine(["image"])} />
                <ArtifactCards artifacts={mine(["pr"])} onOpen={onOpenArtifact} openId={openArtifactId} />
              </>
            ) : null
          }
        />
      );
    case "reasoning":
    case "tool":
      // rows() files these into work runs; a lone one renders the same way.
      return <WorkRun items={[item]} artifacts={artifacts} onOpen={onOpenArtifact} openId={openArtifactId} />;
    case "plan":
      return <PlanSteps steps={item.steps} />;
    case "ask":
      return <PagedAsk ask={item} engine={engine} engineLabel={engineLabel} engineIsCaveman={engineIsCaveman} onAnswer={onAnswer} />;
    case "grill_finished":
      return <GrillFinish item={item} built={built} />;
    case "subagent":
      // rows() files these into groups; a lone one renders the same way.
      return (
        <SubagentGroup items={[item]} engine={engine} engineLabel={engineLabel} engineIsCaveman={engineIsCaveman} onAnswer={onAnswer} artifacts={artifacts} onOpenArtifact={onOpenArtifact} openArtifactId={openArtifactId} />
      );
    case "moment":
      return <Item item={{ kind: "notice", id: item.id, tone: "info", text: item.text }} live={live} engine={engine} engineLabel={engineLabel} engineIsCaveman={engineIsCaveman} onAnswer={onAnswer} cavemanVersion={cavemanVersion} artifacts={artifacts} onOpenArtifact={onOpenArtifact} openArtifactId={openArtifactId} built={built} />;
    case "notice":
      // A warning or an error is a box, something to act on; information (compression off, a model switched) is a quiet
      // line in the trace's place, so it never outranks the turn it sits in.
      return item.tone === "info" && !item.action ? (
        <div role="status" className="flex min-h-7 items-start gap-2 py-1 text-[13px] leading-5 text-muted-foreground">
          <HugeIcon icon={AlertCircleIcon} className="mt-[3px] size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{item.text}</span>
        </div>
      ) : (
        <div
          role={item.tone === "error" ? "alert" : "status"}
          className={cn(
            "my-1 flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]",
            item.tone === "error" ? "border-destructive/40 text-destructive" : item.tone === "warning" ? "border-warning/40 text-warning" : "border-border text-muted-foreground",
          )}
        >
          <HugeIcon icon={AlertCircleIcon} className="mt-[3px] size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{item.text}</span>
          {item.action === "account" ? (
            <Link to="/settings/plan" className="shrink-0 rounded font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              Top up or change plan
            </Link>
          ) : item.tone === "error" ? (
            <NoticeReport text={item.text} />
          ) : null}
        </div>
      );
    case "memory":
      return <MemoryRow item={item} />;
    case "turn_end":
      return <TurnEnd item={item} answer={answer} edited={edited} onOpen={onOpenArtifact} />;
    case "restored":
      return <Restored branch={item.branchWorkspaceId} />;
    case "compaction":
      return <Compaction item={item} />;
    case "route":
      return <Route item={item} />;
    case "switch":
      return <Switch item={item} />;
    case "call":
      return <CallLine item={item} />;
    case "spoken":
      return <Spoken item={item} />;
    case "retry":
      return <Retry item={item} live={live} />;
  }
});

/** Sent text with each thread reference (a t3-context link) and each `$skill` this runtime has as its pill. */
/** A pasted log or a long brief: folded to a few lines until the person opens it (upstream limits). */
const LONG_USER_CHARS = 600;
const LONG_USER_LINES = 8;
export const foldsUserMessage = (text: string): boolean => text.trim().length > LONG_USER_CHARS || text.trim().split("\n").length > LONG_USER_LINES;
const FOLDED_FADE = "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)";

/** How far a sent message travels at most: from a composer far below a short chat, a long glide reads as lag. */
const RISE_MAX_PX = 420;
/** When the rest of the turn starts to show: the glide is front-loaded, so it has all but landed by then. */
const RISE_REVEAL_MS = 280;

/**
 * compact prompt rise: a message the person just sent
 * (the optimistic echo, then the runtime's copy under the same id) glides up out of the composer into its place on
 * ease-snap, 560ms, fading in over the first 420ms; nothing overshoots or scales.
 * What comes after it in the turn (its "working for" line, the first steps, the answer) waits unseen while it rises,
 * then fades up into place (stream.css [data-prompt-rise]). It starts a frame late, hidden, so the chat's
 * follow-the-end scroll has already moved it to where it lands. One read back from history is simply there (STYLE.md §8).
 */
function usePromptRise(landing: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const view = useStreamView();
  const played = useRef(false);
  useLayoutEffect(() => {
    if (played.current) return;
    played.current = true;
    const el = ref.current;
    if (!landing || !el || reducedMotion()) return;
    el.style.opacity = "0";
    const row = el.closest<HTMLElement>("[data-transcript-rows] > *");
    row?.setAttribute("data-prompt-rise", "rising");
    let running: Animation[] = [];
    const timers = [
      setTimeout(() => row?.setAttribute("data-prompt-rise", "revealing"), RISE_REVEAL_MS),
      setTimeout(() => row?.removeAttribute("data-prompt-rise"), RISE_REVEAL_MS + 400),
    ];
    const frame = requestAnimationFrame(() => {
      el.style.removeProperty("opacity");
      let pane = el.parentElement;
      while (pane && !pane.querySelector("[data-composer]")) pane = pane.parentElement;
      const composer = pane?.querySelector<HTMLElement>("[data-composer]");
      const travel = composer ? Math.min(RISE_MAX_PX, composer.getBoundingClientRect().top - el.getBoundingClientRect().top) : 0;
      const from = travel > 8 ? travel : 10;
      running = [
        el.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration: 560, easing: ease.snap }),
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: "ease-out" }),
      ];
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const t of timers) clearTimeout(t);
      for (const a of running) a.cancel();
      el.style.removeProperty("opacity");
      row?.removeAttribute("data-prompt-rise");
    };
    // A snapshot/Activity resume cancels the entrance and never arms it again.
  }, [view]);
  return ref;
}

function UserMessage({ item, images, editAt }: { item: Extract<TranscriptItem, { kind: "user" }>; images: ReadonlyArray<Artifact>; editAt?: number | undefined }) {
  const [landing] = useState(() => isFresh(item.at));
  const rise = usePromptRise(landing);
 // Another thread's agent wrote this (upstream #23135), or a scheduled task sent it (#22638): one line, its first, until
  // opened; a find match inside opens it.
  const sender = item.from ? `the message from ${item.from.title}` : item.scheduled ? `the scheduled prompt${item.scheduled.title ? ` ${item.scheduled.title}` : ""}` : null;
  const [open, setOpen] = useState(false);
  const query = useContext(FindQuery);
  const found = useMemo(() => sender !== null && query !== "" && occurrences(item.text, query).length > 0, [sender, query, item.text]);
  const folded = sender !== null && !open && !found;
  return (
    <Message ref={rise} from="user" data-user-message={item.id} className={cn("scroll-mt-4", folded ? "py-1" : "py-0")}>
      {item.delivery === "steer" ? <MessageHeader className="h-auto justify-end text-[11px]">You added · this turn</MessageHeader> : null}
      {sender !== null ? (
        // Said so above the bubble (outlined for an agent's), never as the person's own words.
        <MessageHeader className="max-w-full pr-1">
          {item.from ? (
            <>
              <span className="shrink-0">From</span>
              {/* One line: a long title gives way before the preview does. */}
              <span className="min-w-0 max-w-64 shrink truncate whitespace-nowrap">
                {item.from.agent ? (
                  // An outside agent (caveman-code mcp) wrote this: its name, and no thread to open.
                  <>
                    <span className="text-secondary-foreground">{item.from.title}</span> · outside agent
                  </>
                ) : (
                  <ThreadPill {...(item.from.workspace_id ? { workspaceId: item.from.workspace_id } : {})} title={item.from.title} />
                )}
              </span>
            </>
          ) : (
            <span className="flex shrink-0 items-center gap-1">
              <HugeIcon icon={AlarmClockIcon} className="size-3.5" />
              Scheduled{item.scheduled?.title ? <span className="max-w-48 truncate text-foreground">{item.scheduled.title}</span> : null}
            </span>
          )}
          <button
            type="button"
            aria-expanded={!folded}
            aria-label={`${folded ? "Open" : "Fold"} ${sender}`}
            onClick={() => setOpen(folded)}
            className="-my-1 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {folded ? <span className="min-w-0 truncate text-foreground/80">{agentMessagePreview(item.text)}</span> : null}
            <HugeIcon icon={folded ? ArrowRight01Icon : ArrowDown01Icon} className="size-3 shrink-0" />
          </button>
        </MessageHeader>
      ) : null}
      {folded ? null : (
        <>
          <ChatImages images={images} align="end" />
          <UserBubble item={item} editAt={editAt} />
        </>
      )}
    </Message>
  );
}

/**
 * A message the runtime wrote for the agent (state/generated.ts), as a quiet trace line: "Port the settings page
 * finished", its sender's pill first when the line does not name it. A lead's builders' result is that line too:
 * "28 of 30 merged · 2 left out" opens the Agents tab on the builders left out, and each pull request's number opens
 * it (beside this chat when its project is here); with none, why, on the line under it.
 */
function GeneratedRow({ made }: { made: GeneratedView }) {
  const openSurface = useOpenSurface();
  const { workspaceId } = useContext(Actions);
  const projects = useRuntimeSelector((v) => v.projects);
  const navigate = useNavigate();
  const chat = useChatWorkspace();
  const result = made.result;
  if (!result) {
    return (
      <Trace className="py-0.5" data-generated="">
        <TraceLine className="h-auto min-h-7 py-1">
          <TraceIcon>
            <HugeIcon icon={made.fromChat || made.legacy ? UserGroupIcon : AlertCircleIcon} />
          </TraceIcon>
          <span className="min-w-0 truncate">
            {made.sender ? <ThreadPill {...(made.sender.workspaceId ? { workspaceId: made.sender.workspaceId } : {})} title={made.sender.title} /> : null}
            {made.line}
          </span>
        </TraceLine>
      </Trace>
    );
  }
  const openLeftOut = () => {
    if (!workspaceId) return;
    const ids = result.leftOut.flatMap((b) => (b.workspaceId ? [b.workspaceId] : []));
    const titles = result.leftOut.filter((b) => !b.workspaceId).map((b) => b.title);
    openSurface(workspaceId, "agents", ids.length + titles.length > 0 ? { only: { ids, titles } } : { only: undefined });
  };
  return (
    <Trace className="py-0.5" data-generated="" data-builders-result="">
      <TraceLine className="h-auto min-h-7 flex-wrap gap-x-2 gap-y-0 py-1">
        <TraceIcon>
          <HugeIcon icon={UserGroupIcon} />
        </TraceIcon>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <button
            type="button"
            onClick={openLeftOut}
            disabled={!workspaceId}
            title={result.leftOutCount > 0 ? "Show the agents left out" : "Show the agents"}
            className="min-w-0 rounded-md text-left text-foreground/90 outline-none transition-colors duration-75 hover:text-foreground hover:underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring disabled:no-underline"
          >
            {resultHead(result)}
          </button>
          <span aria-hidden>·</span>
          {result.pullRequests.length === 0 ? (
            <span>no pull request</span>
          ) : (
            <span className="tabular-nums">
              PR{" "}
              {result.pullRequests.map((pr, i) => (
                <Fragment key={pr.url}>
                  {i > 0 ? ", " : null}
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    title={pr.repo ? `${pr.repo} #${pr.number}` : `Pull request #${pr.number}`}
                    onClick={(e) => {
                      const address = prFromUrl(pr.url, projects);
                      if (!address || editorClick(e)) return;
                      e.preventDefault();
                      openPr(navigate, chat, address, openSurface);
                    }}
                    className="rounded-sm text-foreground/90 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    #{pr.number}
                  </a>
                </Fragment>
              ))}
            </span>
          )}
        </span>
      </TraceLine>
      {result.pullRequests.length === 0 && result.problem ? <p className="pb-1 pl-6 text-[13px] leading-5 text-muted-foreground">{result.problem}</p> : null}
    </Trace>
  );
}

/** A folded agent message's one line: its first line with words in it, markdown marks dropped. */
export function agentMessagePreview(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, "").replace(/[*_`]/g, "").trim();
}

function UserBubble({ item, editAt }: { item: Extract<TranscriptItem, { kind: "user" }>; editAt?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const { editFrom } = useContext(Actions);
  const long = foldsUserMessage(item.text);
  // A find match inside opens it, so the match is on the page.
  const query = useContext(FindQuery);
  const found = useMemo(() => long && query !== "" && occurrences(item.text, query).length > 0, [long, query, item.text]);
  const folded = long && !open && !found;
  // In a messenger (the Chief's), your words are the ink bubble at the right, the page's colour as their text, with its
  // tail; words from elsewhere (item.from) keep the outlined bubble and the page's ink.
  const messenger = useContext(MessengerContext);
  // Its speaker's reaction on these words (a messenger's only): a badge over the bubble's corner, never a row.
  const reactions = useContext(MessengerReactions);
  const reaction = messenger ? reactions?.by.get(item.id) : undefined;
  return (
    <>
      {/* Queued in Caveman Cloud for a computer that sleeps: the person's words as sent, dimmed until they run there. */}
      <Bubble className={cn("relative px-4 py-3 leading-6", !messenger && item.delivery === "steer" && "max-w-[76%] bg-secondary/60 py-2.5", messenger && "max-w-[72%] rounded-[18px] px-3 py-[7px] text-[14px] leading-[19px]", messenger && !item.from && "bg-[var(--bubble-mine)] text-background", item.from && "border border-border bg-transparent", item.queued !== undefined && "opacity-60")}>
        {messenger && !item.from ? <BubbleTail /> : null}
        {/* When it was sent, for screen readers: the turn's footer is where the eye finds the time, so hover pops none. */}
        <SentAt at={item.at} className="sr-only" />
        {/* Left of the bubble, on hover and on keyboard focus: Edit. No row of its own under every message. */}
        <span className="absolute right-full top-1/2 mr-1.5 flex -translate-y-1/2 items-center gap-0.5 whitespace-nowrap opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover/message:opacity-100">
          {editFrom && editAt !== undefined && !item.from ? (
            <button
              type="button"
              onClick={() => editFrom(editAt, item.text, (item.attachments?.length ?? 0) > 0)}
              className="h-6 select-none whitespace-nowrap rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Edit
            </button>
          ) : null}
        </span>
        {/* The words fade out, not the bubble. */}
 {/* The person's own words read in their direction: an Arabic or Hebrew message right to left (upstream #24050). */}
        <PreviewContent id={contentId} data-find-id={item.id} data-folded={folded ? "" : undefined} dir={textDirection(item.text)} collapsed={folded} collapsedRem={10} style={folded ? { maskImage: FOLDED_FADE, WebkitMaskImage: FOLDED_FADE } : undefined}>
          <ReferencedText text={item.text} />
        </PreviewContent>
        {/* After the words, so a screen reader hears the message, then who reacted to it. */}
        {reaction ? <ReactionBadge emoji={reaction} name={reactions?.name ?? null} /> : null}
      </Bubble>
      {item.queued !== undefined ? (
        <MessageFooter className="pr-1">
          <span role="status" data-queued-status="">
            {item.queued}
          </span>
        </MessageFooter>
      ) : null}
      {long || (item.delivery !== "message" && item.delivery !== "steer") ? (
        <MessageFooter className="gap-3 pr-1">
          {long ? (
            <button
              type="button"
              aria-expanded={!folded}
              aria-controls={contentId}
              onClick={() => setOpen(!open)}
              className="-my-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {folded ? "Show full message" : "Show less"}
            </button>
          ) : null}
          {item.delivery !== "message" && item.delivery !== "steer" ? <span>From queue</span> : null}
        </MessageFooter>
      ) : null}
    </>
  );
}

function ReferencedText({ text }: { text: string }) {
  const { client } = useRuntimeClient();
  const skills = useSkills(client);
  const refs = parseThreadReferences(text);
  // Only names of real skills: a `$HOME` or a secret's `$NAME` in prose stays prose.
  const tokens = useMemo(() => new Set(skills.flatMap((s) => s.engines.map((e) => skillToken(s, e)))), [skills]);
  const spans = [
    ...refs,
    ...skillMentions(text, tokens).filter((m) => !refs.some((r) => m.start < r.end && r.start < m.end)),
  ].sort((a, b) => a.start - b.start);
  if (spans.length === 0) return <>{text}</>;
  return (
    <>
      {pieces(text, spans).map((p) =>
        typeof p === "string" ? (
          p
        ) : "workspace_id" in p ? (
          <ThreadPill key={p.start} workspaceId={p.workspace_id} title={p.label} />
        ) : (
          <span key={p.start} className="thread-pill skill-pill mx-0.5" title={`The ${p.token} skill`}>
            <span className="thread-pill-at">/</span>
            {p.token}
          </span>
        ),
      )}
    </>
  );
}

function GrillFinish({ item, built }: { item: Extract<TranscriptItem, { kind: "grill_finished" }>; built: boolean }) {
  const { openFile, build, scope } = useContext(Actions);
  return <GrillFinishCard item={item} buildKey={`${scope}:${item.id}`} onOpen={openFile} onBuild={built ? null : build} />;
}

/** "Report" beside a chat's error: opens the preview; nothing is sent from here. */
function NoticeReport({ text }: { text: string }) {
  const { report } = useContext(Actions);
  if (!report) return null;
  return (
    <Button type="button" size="sm" variant="ghost" className="-my-1 shrink-0 text-foreground" onClick={() => report(text)}>
      Report
    </Button>
  );
}

/**
 * After each turn: the latest settled turn's Changes card when it changed files (TurnChanges, using compact styling), then
 * for a finished one its footer (copy, its changes, fork and restore when the engine can; a fork's copied turns offer
 * neither), else the line that says it stopped or failed. Edits no checkpoint saw get the same card from the turn's
 * own steps, without Undo and Keep: a row opens that edit in the side panel.
 */
function TurnEnd({
  item,
  answer,
  edited,
  onOpen,
}: {
  item: Extract<TranscriptItem, { kind: "turn_end" }>;
  answer?: string | undefined;
  edited?: ReadonlyArray<FileArtifact> | undefined;
  onOpen?: ((artifactId: string) => void) | undefined;
}) {
  const { restore, restoreAfter, fork, openChanges, turnChanges, cardTurn, settle, sources, projectId, workspaceId, continueTurn, continueFrom, sleptEnds } = useContext(Actions);
  // A stop the computer's sleep caused: the runtime's note in the chat, or the lid's outcome this device kept.
  const slept = item.outcome === "interrupted" && (item.stoppedBy === "sleep" || sleptEnds.split(" ").includes(item.id));
  const { checkpoint, files, filesTotal } = item;
  // A fork's copied turns offer neither fork nor restore; their answers still copy.
  const own = item.cursor > restoreAfter;
  const review = checkpoint && openChanges && turnChanges.split(" ").includes(checkpoint) ? (path?: string) => openChanges(checkpoint, path) : null;
  const changed = Boolean(files && files.length > 0);
  const card = Boolean(changed && own && checkpoint && settle && item.id === cardTurn && !item.resolved);
  // Edits no checkpoint saw: with one, those outside the chat's folder (inside it, what the checkpoint found is the
  // truth, an edit taken back included); without one, every edit the turn made.
  const unseen = changed ? [] : (edited ?? []).filter((a) => !checkpoint || isAbsolutePath(a.path));
  const listed = unseen.length > 0 && own && item.id === cardTurn;
  const shows = card || listed;
  // The card arrives a moment after the turn ends (checkpoint.created). Arriving while you watch, it opens in; already
  // there when the turn first showed (a chat opened, a row scrolled back in), it just sits there.
  const [cardAtMount] = useState(shows);
  // A new turn starting takes the card away (only the latest settled turn has one): it folds out rather than leaving
  // the chat a card's height shorter in one frame, which dropped everything above the new message.
  const [hadCard, setHadCard] = useState(shows);
  const [leaving, setLeaving] = useState(false);
  if (shows !== hadCard) {
    setHadCard(shows);
    setLeaving(!shows && !item.resolved && !reducedMotion());
  }
  const openEdit = (path?: string) => {
    const edit = path === undefined ? unseen[0] : unseen.find((a) => a.path === path);
    if (edit) onOpen?.(edit.id);
  };
  return (
    <>
      {item.outcome === "completed" ? null : (
        <Marker variant="separator" className={cn("py-2", item.outcome === "failed" && "text-destructive")}>
          {slept ? <SleepStop offer={continueFrom !== null && continueTurn === item.id ? () => continueFrom(item.id) : null} /> : item.outcome === "interrupted" ? "Stopped" : "The turn failed"}
        </Marker>
      )}
      {changed && (card || leaving) ? (
        <TurnChanges
          files={files!}
          total={filesTotal}
          enter={card && !cardAtMount}
          leaving={!card}
          onGone={() => setLeaving(false)}
          onKeep={() => settle!(checkpoint!, "keep")}
          onUndo={() => settle!(checkpoint!, "undo")}
          onReview={review}
          sources={sources}
          projectId={projectId}
          workspaceId={workspaceId}
        />
      ) : unseen.length > 0 && (listed || leaving) ? (
        <TurnChanges
          files={unseen.map((a) => ({ path: a.path, additions: a.added, deletions: a.removed }))}
          enter={listed && !cardAtMount}
          leaving={!listed}
          onGone={() => setLeaving(false)}
          onReview={onOpen ? openEdit : null}
          sources={sources}
          projectId={projectId}
          workspaceId={workspaceId}
        />
      ) : null}
      {item.resolved === "undone" && changed ? <UndoneLine count={filesTotal?.count ?? files!.length} /> : null}
      {item.outcome === "completed" ? (
        <TurnFooter
          answer={answer}
          at={item.at}
          onChanges={!card && changed && item.resolved !== "undone" && review ? () => review() : null}
          onFork={own && fork ? () => fork(item.cursor) : null}
          onRestore={own && restore ? () => restore(item.cursor) : null}
        />
      ) : null}
    </>
  );
}

/**
 * "Stopped when your computer slept", with Continue on the chat's latest turn: it sends the follow-up that tells the
 * agent what already ran and to carry on. The person decides; nothing continues on its own. The button goes once the
 * follow-up starts a turn (the marker is then no longer the latest).
 */
function SleepStop({ offer }: { offer: (() => Promise<unknown> | void) | null }) {
  // One follow-up per stop: presses while it sends, or after it went, do nothing (pressContinue).
  const state = useRef<ContinueState>("idle");
  const [shown, setShown] = useState<ContinueState>("idle");
  return (
    <span className="flex items-center gap-2" data-sleep-stop="">
      {SLEEP_STOP_LABEL}
      {offer ? (
        <Button type="button" size="sm" variant="ghost" className="-my-1 shrink-0 text-foreground" disabled={shown !== "idle"} onClick={() => void pressContinue(state, offer, setShown)}>
          Continue
        </Button>
      ) : null}
    </span>
  );
}

/** The checkpoints the transcript's turns ended at, oldest first; a fork's copied turns (at or before `forkedAt`) are not its own. */
export function turnCheckpoints(items: ReadonlyArray<TranscriptItem>, forkedAt: number): TurnCheckpoints {
  return items.flatMap((i) => (i.kind === "turn_end" && i.checkpoint ? [{ id: i.checkpoint, own: i.cursor > forkedAt }] : []));
}

/**
 * The messages of the person's that Edit can take back, each to the finished turn before it (session.restore needs a
 * turn.done): not the chat's first message, not one steered into a running turn, not a fork's copied turns.
 */
export function editPoints(items: ReadonlyArray<TranscriptItem>, forkedAt: number): Map<string, number> {
  const out = new Map<string, number>();
  let end: Extract<TranscriptItem, { kind: "turn_end" }> | null = null;
  for (const item of items) {
    if (item.kind === "turn_end") end = item;
    else if (item.kind === "restored") end = null;
    else if (item.kind === "user" && item.delivery !== "steer" && !item.from && !item.generated && end?.outcome === "completed" && end.cursor > forkedAt) out.set(item.id, end.cursor);
  }
  return out;
}

/** Each turn_end's turn's last answer (the last assistant text since the person's message before it). */
export function turnAnswers(items: ReadonlyArray<TranscriptItem>): Map<string, string> {
  const out = new Map<string, string>();
  let answer = "";
  for (const item of items) {
    if (item.kind === "user" && item.delivery !== "steer") answer = "";
    else if (item.kind === "assistant" && item.text.trim()) answer = item.text;
    else if (item.kind === "turn_end") {
      if (answer) out.set(item.id, answer);
      answer = "";
    }
  }
  return out;
}

/** The model or effort moved between turns: "Opus 5.5 Extra high → Sonnet 5.5 Medium", a rule either side. */
function Switch({ item }: { item: Extract<TranscriptItem, { kind: "switch" }> }) {
  const engines = useRuntimeSelector((v) => v.engines);
  const name = (run: TurnRun) => {
    const model = shortModel(engines.find((e) => e.id === run.engine)?.models?.find((m) => m.id === run.model)?.label, run.model);
    return run.effort ? `${model} ${effortLabel(run.effort)}` : model;
  };
  return (
    <Marker variant="separator" className="py-2">
      {name(item.from)} → {name(item.to)}
    </Marker>
  );
}

function Restored({ branch }: { branch: string | null }) {
  const { openWorkspace } = useContext(Actions);
  return (
    <Marker variant="separator" className="py-2">
      Restored to the turn above
      {branch && openWorkspace ? (
        <button type="button" onClick={() => openWorkspace(branch)} className="rounded px-1 text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          Open the later turns
        </button>
      ) : null}
    </Marker>
  );
}

/** Pending asks page: one card at the first one's place, "2 of 3" when several wait. */
function PagedAsk(props: Parameters<typeof AskCard>[0]) {
  const { pending, index, onPage } = useContext(Actions);
  const at = pending.indexOf(props.ask.id);
  if (at < 0) return <AskCard {...props} />;
  const shown = pending[index];
  if (props.ask.id !== shown) return null;
  return <AskCard {...props} pager={<ConfirmationPager index={index} count={pending.length} onPage={onPage} className="ml-auto" />} />;
}

// A screen and a bit: opening a chat lays out what is seen; the rows above mount as the reader scrolls toward them.
const FIRST_ROWS = 20;
/**
 * How many rows the window shows once the list went from `before` rows to `after`: as many more (or fewer) as it
 * changed by, so its first row stays put; a first screen when none of its rows are left (a restore dropped them).
 * An empty transcript has no first row to hold: history arriving after a slow attach starts with one screen too.
 */
export function holdTop(shown: number, before: number, after: number): number {
  if (before === 0) return Math.min(FIRST_ROWS, after);
  const next = shown + after - before;
  return next >= 1 ? next : Math.min(FIRST_ROWS, after);
}
/** The longest a chat opened where its reader left it keeps putting its view back while its rows lay out. */
const RESTORE_MS = 1000;
/** How long after the reader's last scroll their place is read: rows they scrolled to have laid out by then. */
const PLACE_SETTLE_MS = 150;
/** What the reader does that takes the view from a restore still under way. */
const MOVES = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
/** Older rows mounted per step as the reader scrolls up. */
const CHUNK_ROWS = 60;
/** How far above (or below) the view the next chunk starts to mount: it renders between frames, so it needs the lead. */
const MOUNT_AHEAD_PX = 2400;
/** How far from the view a row is laid out ahead of being seen: a few frames of the fastest scroll. */
const LAYOUT_AHEAD_PX = 1200;

/**
 * Keeps the reader's view where it is through the commit that mounts rows above it (`holding` says one is on the
 * way). The distance from the end is read just before that commit touches the DOM and put back just after, so it is
 * the view as it stands then: the rows render in a transition, and the reader goes on scrolling while they do. With
 * or without the browser's scroll anchoring.
 */
class HoldView extends Component<{ window: string; holding: { current: boolean }; scroller: () => HTMLElement | null }, object, number | null> {
  override getSnapshotBeforeUpdate(before: Readonly<{ window: string }>): number | null {
    if (before.window === this.props.window || !this.props.holding.current) return null;
    const scroller = this.props.scroller();
    return scroller ? scroller.scrollHeight - scroller.scrollTop : null;
  }
  override componentDidUpdate(before: Readonly<{ window: string }>, _state: object, kept: number | null): void {
    if (before.window !== this.props.window) this.props.holding.current = false;
    const scroller = kept === null ? null : this.props.scroller();
    if (scroller && kept !== null) scroller.scrollTop = scroller.scrollHeight - kept;
  }
  override render(): ReactNode {
    return null;
  }
}

/** Rows [a, b) mounted on their own after a rail jump (the head), ahead of the tail from `from` to the end. */
type Head = { readonly a: number; readonly b: number };
type Window = { readonly head: Head | null; readonly shown: number };

/** A rail jump to row `at`, above the tail: its own chunk, or the tail down to it when that is no bigger. */
export function jumpWindow(at: number, from: number, total: number): Window {
  return at + CHUNK_ROWS < from ? { head: { a: at, b: at + CHUNK_ROWS }, shown: total - from } : { head: null, shown: total - at };
}

/**
 * The window once the list went from `before` rows to `after`: the tail keeps its first row (holdTop), and a head the
 * tail now reaches joins it. A restore that drops every row the tail held starts the tail at a first screen, at or
 * above the head's end; kept apart, the two would mount the same rows twice.
 */
export function holdWindow(head: Head | null, shown: number, before: number, after: number): Window {
  const next = holdTop(shown, before, after);
  const from = Math.max(0, after - next);
  if (!head || from > head.b) return { head, shown: next };
  return { head: null, shown: after - Math.min(head.a, from) };
}

/** The rows a chat opens with: its last screen, or, opened again where its reader left it (row `at`), that row's too. */
export function openingWindow(at: number, total: number): Window {
  const from = Math.max(0, total - FIRST_ROWS);
  return at < 0 || at >= from ? { head: null, shown: FIRST_ROWS } : jumpWindow(at, from, total);
}

/** One chunk of the gap between the head and the tail, from the side the reader comes from; the last one joins them. */
export function fillGap(head: Head, from: number, total: number, up: boolean): Window {
  if (from - head.b <= CHUNK_ROWS) return { head: null, shown: total - head.a };
  return up ? { head, shown: total - from + CHUNK_ROWS } : { head: { a: head.a, b: head.b + CHUNK_ROWS }, shown: total - from };
}

function AssistantMessage({
  item,
  artifacts,
  onOpenArtifact,
  extra,
}: {
  item: Extract<TranscriptItem, { kind: "assistant" }>;
  cavemanVersion: TranscriptProps["cavemanVersion"];
  artifacts: ReadonlyArray<Artifact>;
  onOpenArtifact: TranscriptProps["onOpenArtifact"];
  extra: ReactNode;
}) {
  const openSurface = useOpenSurface();
  // Markdown open actions name a kind and a source line; the artifact model keys them the same way.
  const open = useStableCallback((t: ResponseTarget) => {
    const a = findArtifact(artifacts, item.id, t.kind, t.line);
    if (a) onOpenArtifact?.(a.id);
  });
  // A file the answer names (a link, a path in inline code) opens in the side panel's file viewer, ⌘-click in the
  // editor; Response keeps every other non-web link from navigating.
  const { openFile, workspaceId, run } = useContext(Actions);
  const onUseArtifactTemplate = useArtifactTemplateComposer();
  const folder = useWorkspaceRoot();
  const refs = useContext(FileRefsContext);
  const projects = useRuntimeSelector((v) => v.projects);
  const navigate = useNavigate();
  const chat = useChatWorkspace();
  const onLink = useCallback(
    (href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
      // A pull request on a project's host opens beside this chat (else in Review); ⌘-click keeps the host's page.
      const pr = prFromUrl(href, projects);
      if (pr && !editorClick(event)) {
        event.preventDefault();
        openPr(navigate, chat, pr, openSurface);
        return;
      }
      const target = chatLink(href, folder);
      if (target?.kind !== "file" || !openFile) return;
      event.preventDefault();
      const ref = { path: target.path, ...(target.line ? { line: target.line } : {}), ...(target.directory ? { directory: true } : {}) };
      if (refs?.edit && editorClick(event)) refs.edit(ref);
      else if (refs) refs.open(ref);
      else openFile(target.path, target.line);
    },
    [folder, openFile, refs, projects, navigate, chat, openSurface],
  );
  const live = refs !== null;
  // The caller's references (the Chief's [[12]]) go to Response as inline code, which draws them as the caller says.
  const inlineRefs = useContext(InlineRefsContext);
  const [text, isRef] = useMemo(() => {
    if (!inlineRefs) return [item.text, null] as const;
    const one = new RegExp(`^(?:${inlineRefs.pattern.source})$`);
    // Already in backticks, a reference gains a second pair, which markdown reads as the same code span.
    return [item.text.replace(new RegExp(inlineRefs.pattern.source, "g"), (ref) => `\`${ref}\``), (code: string) => one.test(code)] as const;
  }, [item.text, inlineRefs]);
  const inlineCode = useMemo(
    () =>
      live || isRef
        ? (code: string) => (isRef?.(code) ? inlineRefs!.render(code) : live ? <CodePath text={code} root={folder} workspaceId={workspaceId} /> : null)
        : undefined,
    [live, isRef, inlineRefs, folder, workspaceId],
  );
  const file = useMemo(() => (live ? (path: string, href: string) => <NamedFile path={path} href={href} root={folder} /> : undefined), [live, folder]);
  const media = useCallback((src: string, kind: "audio" | "video", alt: string) => <InlineMedia src={src} kind={kind} alt={alt} workspaceId={workspaceId ?? null} scope={item.id} />, [workspaceId, item.id]);
  // A reply that arrived while the chat was open plays in word by word; one from its history shows whole.
  const seen = useContext(SeenItems);
  const [fresh] = useState(() => seen.isNew(item.id));
  useEffect(() => seen.add(item.id), [seen, item.id]);
  return (
    <Message>
      <MessageContent data-find-id={item.id}>
        <Response onUseArtifactTemplate={onUseArtifactTemplate} onOpen={onOpenArtifact ? open : undefined} onLink={onLink} inlineCode={inlineCode} file={file} media={media} onRun={run ?? undefined} badge={badge} streaming={item.streaming} paced revealOnMount={fresh} hideImages>
          {text}
        </Response>
        {inlineRefs?.after && !item.streaming ? inlineRefs.after(item.text, item.at) : null}
        {extra}
      </MessageContent>
    </Message>
  );
}

/** A file an answer's `![]()` names: its chip when it is in the chat's folder, found from its href as a link to it is (chatLink); else its path as code. */
function NamedFile({ path, href, root }: { path: string; href: string; root: string | null }) {
  const target = chatLink(href, root);
  return target?.kind === "file" ? <FileChip text={path} target={target} /> : <code className={inlineCodeClass} onDoubleClick={selectInlineCode}>{path}</code>;
}

const badge = (kind: ResponseTargetKind) => <Icon icon={artifactIcon(kind)} />;

/** A state line seen live animates as it lands; one loaded from history sits still. ponytail: compares the runtime's clock with this one, so a client more than 4s off a cloud computer mis-guesses; key it off the attach cursor if that shows up. */
const isFresh = (at: string) => Date.now() - Date.parse(at) < 4000;
const PENDING_COMPACTION = { kind: "compaction", id: "pending-compaction", status: "running", before: null, after: null, at: "" } as const;

/** The engine shrinking its context: the title shimmers while it runs. */
function Compaction({ item }: { item: Extract<TranscriptItem, { kind: "compaction" }> }) {
  const sizes = item.before !== null && item.after !== null ? `${compact(item.before)} → ${compact(item.after)} tokens` : null;
  return (
    <Trace className="py-0.5">
      <TraceLine status={item.status === "running" ? "running" : item.status === "failed" ? "error" : undefined}>
        <TraceIcon>
          <Icon icon={FoldVerticalIcon} />
        </TraceIcon>
        <TraceTitle>{item.status === "running" ? "Compacting context" : item.status === "done" ? "Compacted context" : "Compaction didn't finish"}</TraceTitle>
        {item.status === "done" && sizes ? <TraceDescription>{sizes}</TraceDescription> : null}
      </TraceLine>
    </Trace>
  );
}

/** The router moved the engine to another model: the line fades in as it lands. */
function Route({ item }: { item: Extract<TranscriptItem, { kind: "route" }> }) {
  const [landing] = useState(() => isFresh(item.at));
  return (
    <Trace className="py-0.5">
      <TraceLine className={cn(landing && "animate-in fade-in-0 duration-150 ease-snap motion-reduce:animate-none")}>
        <TraceIcon>
          <Icon icon={Route01Icon} />
        </TraceIcon>
        <TraceTitle>
          Routed to <TraceSubject>{item.model.slice(item.model.indexOf("/") + 1)}</TraceSubject>
        </TraceTitle>
      </TraceLine>
    </Trace>
  );
}

/** A call with the Chief starting or ending: a quiet line, as a route is. */
function CallLine({ item }: { item: Extract<TranscriptItem, { kind: "call" }> }) {
  return (
    <Trace className="py-1">
      <TraceLine>
        <TraceIcon>
          <HugeIcon icon={item.state === "started" ? Call02Icon : CallEnd01Icon} className="size-4" />
        </TraceIcon>
        <TraceTitle>{item.state === "started" ? "Call started" : "Call ended"}</TraceTitle>
        {item.state === "ended" && item.durationMs !== null ? <TraceDescription>{clock(item.durationMs)}</TraceDescription> : null}
      </TraceLine>
    </Trace>
  );
}

/** A turn of a call: the person's words in a bubble marked spoken, the voice's as the Chief's reply is set. */
function Spoken({ item }: { item: Extract<TranscriptItem, { kind: "spoken" }> }) {
  if (item.role === "voice")
    return (
      <div className="flex items-start gap-2 py-1.5 text-[14px] leading-[1.6] text-foreground">
        <HugeIcon icon={Call02Icon} aria-label="Said on the call" className="mt-[3px] size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0">{item.text}</p>
      </div>
    );
  return (
    <Message from="user" className="py-2">
      <Bubble className="flex items-start gap-2">
        <HugeIcon icon={Mic02Icon} aria-label="Said on the call" className="mt-[3px] size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{item.text}</span>
      </Bubble>
      {item.handoff ? (
        <MessageFooter className="pr-1 text-[12px] text-muted-foreground">
          <Icon icon={CrownIcon} />
          Handed to the Chief
        </MessageFooter>
      ) : null}
    </Message>
  );
}

/** The engine retrying a failed call: the title shimmers while it waits, then the line stays as a quiet record. */
function Retry({ item, live }: { item: Extract<TranscriptItem, { kind: "retry" }>; live: boolean }) {
  return (
    <Trace className="py-0.5">
      <TraceLine status={live ? "running" : undefined} title={item.message}>
        <TraceIcon>
          <Icon icon={RefreshCwIcon} />
        </TraceIcon>
        <TraceTitle>{live ? "Retrying" : "Retried"}</TraceTitle>
        <TraceDescription>{live ? `attempt ${item.attempt}${item.max ? ` of ${item.max}` : ""}` : `${item.attempt} ${item.attempt === 1 ? "time" : "times"}`}</TraceDescription>
      </TraceLine>
    </Trace>
  );
}

function PlanSteps({ steps }: { steps: ReadonlyArray<{ text: string; status: "pending" | "in_progress" | "completed" }> }) {
  return (
    <Trace className="py-1">
      {steps.map((s, i) => (
        <TraceLine key={i} status={s.status === "in_progress" ? "running" : s.status === "pending" ? "pending" : undefined} className="h-auto min-h-7 py-1">
          <TraceIcon>
            <span className={cn("grid size-3 place-items-center rounded-[3px] border", s.status === "completed" ? "border-foreground bg-foreground text-background" : "border-input")}>
              {s.status === "completed" ? <HugeIcon icon={Tick02Icon} strokeWidth={3} className="size-2" /> : null}
            </span>
          </TraceIcon>
          <TraceTitle className={cn("whitespace-normal", s.status === "completed" ? "text-muted-foreground" : "text-secondary-foreground")}>{s.text}</TraceTitle>
        </TraceLine>
      ))}
    </Trace>
  );
}

/** Groups the person opened or closed, by their first agent: rows remount as the window moves, the choice stays. */
const groupOpen = new Map<string, boolean>();

type AgentState = { readonly label: string; readonly mark: Mark };
const NEEDS: AgentState = { label: "Needs input", mark: "needs" };

/** An agent's state as its row marks it (a shape, never colour alone): a delegated one waits in its own chat. */
function agentState(item: SubagentItem, child: Workspace | undefined): AgentState {
  if (item.status === "running") return (item.workspaceId ? child?.status === "needs_input" : pendingAsks(item.items).length > 0) ? NEEDS : SUBAGENT_STATE.running;
  return SUBAGENT_STATE[item.status];
}

/** "1 needs you, 2 working, 1 done": how the group stands, those waiting on the person first. */
export function groupSummary(states: ReadonlyArray<AgentState>): string {
  const count = (mark: Mark) => states.filter((s) => s.mark === mark).length;
  return [
    [count("needs"), "needs you"],
    [count("working"), "working"],
    [count("done"), "done"],
    [count("failed"), states.some((s) => s.label === "Failed") ? "failed" : "stopped"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, what]) => `${n} ${what}`)
    .join(", ");
}

/** Epoch ms, ticking each second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** How long it has worked (to `now`) or took; null with no clock. */
function took(startedAt: string, finishedAt: string | null, now: number, live: boolean): string | null {
  const from = Date.parse(startedAt);
  const to = live ? now : finishedAt ? Date.parse(finishedAt) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) ? agentClock(Math.max(0, to - from)) : null;
}

type AgentProps = {
  engine: string;
  engineLabel: string;
  engineIsCaveman: boolean;
  onAnswer: TranscriptProps["onAnswer"];
  artifacts: ReadonlyArray<Artifact>;
  onOpenArtifact: TranscriptProps["onOpenArtifact"];
  openArtifactId: TranscriptProps["openArtifactId"];
};

/**
 * The subagents a turn started together (rows.ts), 
 * they stand, over one row per agent saying what it does this second. A delegated agent's row opens its chat;
 * an engine's own subagent opens its steps in place. The group stays in view once the turn ends, and a lone
 * agent is its row alone.
 */
function SubagentGroup({ items, ...props }: { items: ReadonlyArray<SubagentItem> } & AgentProps) {
  const raw = useRuntimeSelector((v) => v.raw);
  const { pending, index } = useContext(Actions);
  const wanted = useRevealedSubagent();
  const id = items[0]!.id;
  const [open, setOpen] = useState(() => groupOpen.get(id) ?? true);
  const states = items.map((item) => agentState(item, item.workspaceId ? raw.get(item.workspaceId) : undefined));
  const live = items.some((i) => i.status === "running");
  const now = useNow(live);
  // What waits on the person, or a row the sidebar asked for, opens it.
  const shown = pending[index] !== undefined && items.some((i) => pendingAsks(i.items).includes(pending[index]!));
  const holds = shown || states.some((s) => s.mark === "needs") || (wanted !== null && holdsSubagent(items, wanted));
  const expanded = open || holds;
  const toggle = () => {
    groupOpen.set(id, !expanded);
    setOpen(!expanded);
  };
  const list = (
    <ul aria-label="Subagents" className={cn("flex flex-col gap-px rounded-lg border border-border bg-card/40 p-1", items.length > 1 && "mt-0.5")}>
      {items.map((item, i) => (
        <SubagentLine key={item.id} item={item} state={states[i]!} now={now} {...props} />
      ))}
    </ul>
  );
  if (items.length === 1) return <div className="my-1">{list}</div>;
  const starts = items.map((i) => i.startedAt);
  const ends = items.map((i) => i.finishedAt ?? "");
  const time = took(starts.reduce((a, b) => (a < b ? a : b)), live || ends.includes("") ? null : ends.reduce((a, b) => (a > b ? a : b)), now, live);
  const label = `${items.length} subagents`;
  const summary = groupSummary(states);
  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${label}: ${summary}`}
        onClick={toggle}
        className="group/agents flex w-full items-center gap-3 rounded-md py-1.5 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden className="flex shrink-0 items-center -space-x-1.5">
          {items.slice(0, 3).map((item) => (
            <AgentAvatar key={item.id} engine={item.runner?.engine ?? item.agent ?? props.engine} />
          ))}
          {items.length > 3 ? (
            <span className="grid size-6 place-items-center rounded-full bg-muted text-[10px] tabular-nums text-muted-foreground ring-2 ring-background">+{items.length - 3}</span>
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] leading-[18px] text-foreground">{label}</span>
          <span
            key={summary}
            className={cn(
              "block truncate text-[12px] leading-4 text-muted-foreground animate-in fade-in-0 duration-150 ease-snap motion-reduce:animate-none",
              states.some((s) => s.mark === "needs") && "text-[hsl(var(--warning))]",
            )}
          >
            {summary}
          </span>
        </span>
        {time ? <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{time}</span> : null}
        <HugeIcon
          icon={ArrowDown01Icon}
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap group-hover/agents:text-foreground", expanded && "rotate-180")}
        />
      </button>
      <DisclosureContent open={expanded}>{list}</DisclosureContent>
    </div>
  );
}

/** The harness logo in a round chip, as the group's stack and each row show it. */
function AgentAvatar({ engine, className }: { engine: string; className?: string }) {
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border border-border bg-muted ring-2 ring-background", className)}>
      <EngineLogo engine={engine} size={14} />
    </span>
  );
}

function SubagentLine(props: { item: SubagentItem; state: AgentState; now: number } & AgentProps) {
  return props.item.workspaceId !== null ? <DelegatedLine {...props} workspaceId={props.item.workspaceId} /> : <NativeLine {...props} />;
}

/**
 * One agent: who runs it (logo, and the login, model and effort on hover), its title and clock, and under them
 * what it does now, live, or what it ended on. `onOpen` makes the whole row its way in.
 */
function AgentLine({
  item,
  runner,
  state,
  line,
  time,
  onOpen,
  opens,
  open,
  children,
}: {
  item: SubagentItem;
  runner: Runner;
  state: AgentState;
  line: { readonly text: string; readonly live: boolean } | null;
  time: string | null;
  onOpen: (() => void) | null;
  /** Where a click goes: its own chat, or its steps here. */
  opens: "chat" | "steps";
  open?: boolean;
  children?: ReactNode;
}) {
  // A row seen arriving slides in; one loaded from history sits still.
  const [enter] = useState(() => item.status === "running" && isFresh(item.startedAt));
  const who = [runner.engineLabel ?? "Agent", runner.tag, shortModel(runner.modelLabel, runner.model), runner.effort && `${runner.effort} effort`].filter(Boolean).join(" · ");
  const text = line?.text || state.label;
  const body = (
    <>
      {/* Centred on its two lines (both truncate, so the row is always two lines tall). */}
      <span role="img" aria-label={who} title={who} className="flex">
        <AgentAvatar engine={runner.engine} className="size-7 ring-0" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-foreground">{item.title}</span>
          {opens === "chat" ? <RunnerModel runner={runner} aria-hidden className="shrink-0 text-[12px] leading-[18px] text-[hsl(var(--subtle-foreground))] max-sm:hidden" /> : null}
          {time ? (
            <span title={item.status === "running" ? "Working for" : "Took"} className="shrink-0 text-[12px] leading-[18px] tabular-nums text-muted-foreground">
              {time}
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 shrink-0", MARK[state.mark])} />
          <span
            key={text}
            className={cn(
              "min-w-0 truncate animate-in fade-in-0 duration-150 ease-snap motion-reduce:animate-none",
              state.mark === "needs" ? "text-[hsl(var(--warning))]" : state.mark === "failed" ? "text-destructive" : line?.live || (!line && state.mark === "working") ? "lucy-shimmer" : null,
            )}
          >
            {text}
          </span>
        </span>
      </span>
      {onOpen ? (
        opens === "chat" ? (
          <HugeIcon icon={ArrowRight01Icon} className="size-3.5 shrink-0 text-muted-foreground transition-[color,transform] duration-150 ease-snap group-hover/agent:translate-x-0.5 group-hover/agent:text-foreground" />
        ) : (
          <HugeIcon icon={ArrowRight01Icon} className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap group-hover/agent:text-foreground", open && "rotate-90")} />
        )
      ) : (
        <span aria-hidden className="w-3.5 shrink-0" />
      )}
    </>
  );
  const row = "group/agent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
  return (
    <li className={cn(enter && "animate-in fade-in-0 duration-150 ease-snap motion-reduce:animate-none")}>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          {...(opens === "steps" ? { "aria-expanded": open ?? false } : {})}
          aria-label={`${opens === "chat" ? "Open" : open ? "Hide the steps of" : "Show the steps of"} ${item.title}: ${state.label}${line ? `, ${line.text}` : ""}`}
          className={cn(row, "outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
        >
          {body}
        </button>
      ) : (
        <div className={row}>{body}</div>
      )}
      {children}
    </li>
  );
}

/**
 * An agent this engine delegated (delegate_task): a chat of its own under this one, so its work, asks and diff
 * live there and its row opens it. While it works the row listens to that chat (the store is shared with it, so
 * opening is instant) to say what it does now.
 */
function DelegatedLine({ item, state, now, artifacts, workspaceId, engine }: { item: SubagentItem; state: AgentState; now: number; workspaceId: string } & AgentProps) {
  const { openWorkspace } = useContext(Actions);
  const engines = useRuntimeSelector((v) => v.engines);
  const child = useRuntimeSelector((v) => v.raw.get(workspaceId));
  const childView = useRuntimeSelector((v) => v.workspaces.find((w) => w.id === workspaceId));
  const { client } = useRuntimeClient();
  const running = item.status === "running";
  const { view } = useSession(running ? (child?.session_id ?? null) : null);
  const turn = loadedTurn(client, child?.session_id);
  const runner = runnerFor(engines, { engine: child?.engine ?? item.agent ?? engine, model: turn?.model, effort: turn?.effort, runner: item.runner ?? childRunner(child) });
  const line = running ? (childView && view ? rowLine(childView, view) : null) : item.summary ? { text: firstLine(item.summary), live: false } : null;
  const images = artifacts.filter((a) => a.itemId === item.id);
  return (
    <AgentLine
      item={item}
      runner={runner}
      state={state}
      line={line}
      time={took(item.startedAt, item.finishedAt, now, running)}
      onOpen={openWorkspace ? () => openWorkspace(workspaceId) : null}
      opens="chat"
    >
      {/* Its proof, under its row. */}
      <ChatImages images={images} className="pb-1.5 pl-[46px] pr-2" />
    </AgentLine>
  );
}

/** An engine's own subagent (Claude's Agent tool): its steps open in place, under its row. */
function NativeLine({ item, state, now, engine, engineLabel, engineIsCaveman, onAnswer, artifacts, onOpenArtifact, openArtifactId }: { item: SubagentItem; state: AgentState; now: number } & AgentProps) {
  const engines = useRuntimeSelector((v) => v.engines);
  const [open, setOpen] = useState(false);
  const { pending, index } = useContext(Actions);
  // The shown pending ask must stay visible: an agent holding it stays open.
  const holdsAsk = pending[index] !== undefined && pendingAsks(item.items).includes(pending[index]!);
  // Opened from the sidebar: this row (or one inside it) opens, and this one scrolls into view.
  const wanted = useRevealedSubagent();
  const asked = wanted === item.id;
  const holdsWanted = wanted !== null && !asked && holdsSubagent(item.items, wanted);
  const ref = useRef<HTMLDivElement>(null);
  const { letGo } = useConversation();
  useEffect(() => {
    if (holdsWanted || (asked && item.items.length > 0)) setOpen(true);
    if (!asked) return;
    // The chat opens at its end and follows it; this row is above, so stop following before jumping to it.
    letGo();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    taken(item.id);
  }, [asked, holdsWanted, item.id, item.items.length, letGo]);
  const running = item.status === "running";
  const steps = item.items.filter((i) => i.kind === "tool").length;
  const step = running ? latestStep(item.items) : null;
  const line = step ? { text: step.text, live: step.live } : !running && item.summary ? { text: firstLine(item.summary), live: false } : !running && steps ? { text: `${steps} ${steps === 1 ? "step" : "steps"}`, live: false } : null;
  const expanded = holdsAsk || open;
  return (
    <AgentLine
      item={item}
      runner={runnerFor(engines, { engine: item.agent ?? engine, runner: item.runner })}
      state={state}
      line={line}
      time={took(item.startedAt, item.finishedAt, now, running)}
      onOpen={item.items.length > 0 ? () => setOpen(!expanded) : null}
      opens="steps"
      open={expanded}
    >
      <div ref={ref} className="scroll-mt-[calc(var(--pane-top,0px)+12px)]" />
      <DisclosureContent open={expanded && item.items.length > 0}>
        <div className="mb-1 ml-[22px] border-l border-border pl-[22px] pr-2 text-foreground">
          <Items
            items={item.items}
            engine={engine}
            engineLabel={engineLabel}
            engineIsCaveman={engineIsCaveman}
            running={false}
            nested
            onAnswer={onAnswer}
            cavemanVersion={null}
            artifacts={artifacts}
            {...(onOpenArtifact ? { onOpenArtifact } : {})}
            openArtifactId={openArtifactId ?? null}
          />
        </div>
      </DisclosureContent>
    </AgentLine>
  );
}

export function AskCard({
  ask,
  engine,
  engineLabel,
  engineIsCaveman,
  onAnswer,
  pager,
}: {
  ask: Extract<TranscriptItem, { kind: "ask" }>;
  engine?: string;
  engineLabel: string;
  engineIsCaveman: boolean;
  onAnswer: TranscriptProps["onAnswer"];
  /** ConfirmationPager when several asks wait. */
  pager?: ReactNode;
}) {
  // A question's own words, or an approval's note to the agent with its deny.
  const [text, setText] = useState("");
  // A long command or file under an approval shows its first lines until the person opens it whole.
  const [whole, setWhole] = useState(false);
  // The option whose preview shows: the one pointed at or focused last, else the first that has one.
  const [previewed, setPreviewed] = useState<string | null>(null);
  // The card names its agent as the turn line above it does ("Opus 5.5 wants approval"), never as a second actor.
  const { who } = useTurnWho(engine ?? (engineIsCaveman ? "caveman" : engineLabel.toLowerCase().replace(/\s+/g, "-")), engineLabel, ask.turnModel);
  // Clicks and keycaps count from ASK_ARM_MS after the card shows or the window comes forward (askTakes).
  const armedAt = useRef(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const arm = () => {
      armedAt.current = performance.now() + ASK_ARM_MS;
    };
    arm();
    window.addEventListener("focus", arm);
    return () => window.removeEventListener("focus", arm);
  }, [ask.id]);
  // "out" from the answer until the runtime's ask.resolved replaces the options; "failed" when ask.respond was refused.
  const [sending, setSending] = useState<"idle" | "out" | "failed" | "elsewhere">("idle");
  // Refused because someone answered it first (another device, another window): say so, not "try again".
  const refused = (e: unknown) => setSending(e instanceof AnsweredElsewhere ? "elsewhere" : "failed");
  // A screen reader hears an ask once, when it first waits on the person (a grill round says its own).
  const waiting = ask.resolution === null && ask.round === null;
  useEffect(() => {
    if (!waiting || announcedAsks.has(ask.id)) return;
    announcedAsks.add(ask.id);
    announce(askAnnouncement(ask, who));
  }, [waiting, ask, who]);
  if (ask.round !== null) return <RoundCard ask={ask} onAnswer={onAnswer} pager={pager} />;
  // Several questions (Claude's AskUserQuestion holds up to four): each shows its own options and every one is
  // answered, in one reply. The single-question card below answers only the first.
  if (ask.askKind === "question" && ask.questions.length > 1) {
    const mark = <EngineMark engine={engine ?? (engineIsCaveman ? "caveman" : engineLabel.toLowerCase().replace(/\s+/g, "-"))} />;
    return <RoundCard ask={ask} onAnswer={onAnswer} pager={pager} asker={{ mark, who }} />;
  }
  const resolved = ask.resolution !== null;
  const waitsOn = ask.waitsOn && !resolved && !ask.prompt.includes(ask.waitsOn.subject) ? ask.waitsOn : null;
  const fold = waitsOn ? foldLines(waitsOn.subject) : null;
  if (ask.askKind === "secret" && ask.secret) {
    return (
      <SecretAskCard
        name={ask.secret.name}
        repo={ask.secret.repo}
        reason={ask.prompt}
        resolution={ask.resolution}
        sending={sending}
        engineLabel={engineLabel}
        onProvided={(provided) => {
          setSending("out");
          Promise.resolve(onAnswer(ask.id, { kind: "secret", provided })).catch(refused);
        }}
        header={
          <div className="mb-2 flex items-center gap-2 text-[13px] text-muted-foreground">
            <EngineMark engine={engine ?? (engineIsCaveman ? "caveman" : engineLabel.toLowerCase().replace(/\s+/g, "-"))} />
            <span>
              <span className="text-foreground">{engineLabel}</span> needs a secret
            </span>
            {pager}
          </div>
        }
      />
    );
  }
  if (ask.askKind === "tool" && ask.tool) {
    return (
      <ToolAskCard
        ask={ask}
        tool={ask.tool}
        sending={sending}
        onSend={(content, isError) => {
          setSending("out");
          Promise.resolve(onAnswer(ask.id, { kind: "tool", content, is_error: isError })).catch(refused);
        }}
        engineLabel={engineLabel}
        header={
          <div className="mb-2 flex items-center gap-2 text-[13px] text-muted-foreground">
            <EngineMark engine={engine ?? (engineIsCaveman ? "caveman" : engineLabel.toLowerCase().replace(/\s+/g, "-"))} />
            <span>
              <span className="text-foreground">{engineLabel}</span> called <span className="font-mono text-foreground">{ask.tool.name}</span>
            </span>
            {pager}
          </div>
        }
      />
    );
  }
  const reply = (a: { optionId?: string; text?: string }): AskReply =>
    ask.askKind === "approval"
      ? { kind: "approval", option_id: a.optionId ?? "", ...(a.text ? { feedback: a.text } : {}) }
      : { kind: "question", answers: [{ question_id: ask.questions[0]?.id ?? ask.id, option_ids: a.optionId ? [a.optionId] : [], ...(a.text ? { text: a.text } : {}) }] };
 // Its deny can carry a note to the agent that asked (upstream #23657): the card offers a box for it.
  const deny = ask.askKind === "approval" && ask.acceptsFeedback ? ask.options.find((o) => o.decision === "deny") : undefined;
 // A question whose options show what they look like (Claude's previews, upstream #21932).
  const preview = ask.askKind === "question" ? (ask.options.find((o) => o.id === previewed && o.preview) ?? ask.options.find((o) => o.preview)) : undefined;
  // Answered, the options go: focus moves on to the chat's box instead of falling to the page.
  const answer = (from: HTMLElement, r: AskReply) => {
    if (!askTakes(performance.now(), armedAt.current, sending === "out")) return;
    setSending("out");
    const pane = from.closest("[data-pane]");
    if (pane?.contains(document.activeElement)) pane.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    Promise.resolve(onAnswer(ask.id, r)).catch(refused);
  };
  const lead = ask.askKind === "approval" ? ask.options.findIndex((o) => o.decision === "allow") : -1;
  // With focus in the card, the keycaps answer: a digit picks its option, ↑↓ move between them.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (resolved || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.target instanceof HTMLInputElement) return;
    const options = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-ask-option]")];
    const key = askKey(e.key, options.indexOf(e.target as HTMLButtonElement), ask.options.length);
    if (key === null) return;
    e.preventDefault();
    if (key.pick) answer(e.currentTarget, reply({ optionId: ask.options[key.index]!.id }));
    else options[key.index]?.focus();
  };
  return (
    <div onKeyDown={onKeyDown} className="my-2 rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center gap-2 text-[13px] text-muted-foreground">
        <EngineMark engine={engine ?? (engineIsCaveman ? "caveman" : engineLabel.toLowerCase().replace(/\s+/g, "-"))} />
        <span>
          <span className="text-foreground">{who}</span> {ask.askKind === "approval" ? "wants approval" : "asks"}
        </span>
        {pager}
      </div>
      <div dir={textDirection(ask.prompt)} className="mb-3 whitespace-pre-wrap text-[14px] leading-[22px] [overflow-wrap:anywhere]">{ask.prompt}</div>
      {!resolved && (ask.reason || ask.fullAccessOverride) ? (
 // Why it asks: the engine's own reason, and in full access why it asked at all (upstream #22546).
        <div className="-mt-2 mb-3 flex flex-col gap-0.5 text-[13px] text-muted-foreground">
          {ask.reason ? <span dir={textDirection(ask.reason)} className="select-text break-words">{ask.reason}</span> : null}
          {ask.fullAccessOverride ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="w-fit rounded-sm underline decoration-dotted underline-offset-2 outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  {FULL_ACCESS_QUESTION}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="start" className="max-w-[22rem] whitespace-normal">
                {fullAccessExplanation(ask.fullAccessOverride, engineLabel)}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {waitsOn ? (
        // What Allow lets run or change, when the engine's words don't already say it. A long one folds in its
        // middle: its first lines, how many sit between (a click opens it whole), and its last, where what it runs
        // usually is. Never cut off unannounced, never its end hidden.
        <div className="-mt-1 mb-3 rounded-md border border-border bg-secondary/60 px-2.5 py-1.5 text-muted-foreground">
          <div className="flex items-start gap-2">
            <Icon icon={TOOL_ICON[waitsOn.icon]} className="mt-0.5" />
            <div className="min-w-0 flex-1 font-mono text-[12.5px] leading-5 text-foreground">
              <code className="block whitespace-pre-wrap break-all">{fold && !whole ? fold.head : waitsOn.subject}</code>
              {fold ? (
                <button
                  type="button"
                  aria-expanded={whole}
                  onClick={() => setWhole(!whole)}
                  className="my-0.5 rounded-sm font-sans text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {whole ? "Show less" : `Show ${fold.hidden} more ${fold.hidden === 1 ? "line" : "lines"}`}
                </button>
              ) : null}
              {fold && !whole ? <code className="block whitespace-pre-wrap break-all">{fold.tail}</code> : null}
            </div>
          </div>
        </div>
      ) : null}
      {resolved && (ask.resolution === "expired" || ask.resolution === "cancelled") ? (
        // Nobody answered: a code cell's call whose cell ended, a Stop, or an hour with no answer (transcript.ts keeps the outcome).
        <div className="text-[13px] text-muted-foreground">{ask.resolution === "expired" ? "Not answered in time: the step that asked has ended." : "Cancelled before an answer."}</div>
      ) : resolved ? (
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <HugeIcon icon={Tick02Icon} className="size-3.5 text-success" />
          Answered: <span className="text-foreground">{ask.resolution}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {ask.options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              data-ask-option
              disabled={sending === "out"}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              onClick={(e) => answer(e.currentTarget, reply({ optionId: o.id }))}
              {...(o.preview ? { onPointerEnter: () => setPreviewed(o.id), onFocus: () => setPreviewed(o.id), "aria-describedby": `${ask.id}:preview` } : {})}
              className={cn(
                "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
                // The approval's way forward (its first Allow) sits raised, the secondary button's card; the rest stay outlined.
                i === lead ? "border-input bg-foreground/[0.08] hover:bg-foreground/[0.12]" : "border-border hover:border-input hover:bg-accent/50",
                // The option whose preview shows below is marked as the one it belongs to.
                preview?.id === o.id && "border-input",
              )}
            >
              <span className={cn("mt-px grid size-5 shrink-0 place-items-center rounded border font-mono text-[11px]", i === lead ? "border-foreground/25 text-foreground" : "border-border text-muted-foreground")}>{i + 1}</span>
              <span className="min-w-0" dir={textDirection(`${o.label} ${o.description ?? ""}`)}>
                <span className={cn("block text-[13px] text-foreground", i === lead && "font-medium")}>{o.label}</span>
                {o.description ? <span className="block text-[13px] text-muted-foreground">{o.description}</span> : null}
              </span>
            </button>
          ))}
          {preview?.preview ? (
            // What the pointed-at option looks like, as the engine wrote it (a mockup, a snippet): plain text, kept as laid out.
            // The option cards' edge (rounded-lg, px-3): one stack, one radius, one inset.
            <figure className="m-0 overflow-hidden rounded-lg border border-border bg-secondary/60">
              <figcaption className="border-b border-border/60 px-3 py-1 text-[12px] text-muted-foreground">
                Preview: <span className="text-foreground">{preview.label}</span>
              </figcaption>
              {/* Tight lines, so a mockup's box-drawing characters meet from one line to the next. */}
              <pre id={`${ask.id}:preview`} className="max-h-64 overflow-auto px-3 py-2 font-mono text-[12.5px] leading-[1.2] text-foreground">

                {preview.preview}
              </pre>
            </figure>
          ) : null}
          {deny ? (
            // Deny with a note: the agent that asked reads it as why, and goes on in the same turn.
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) answer(e.currentTarget, reply({ optionId: deny.id, text: text.trim() }));
              }}
              className="flex items-center gap-2"
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={`Or tell ${who} what to do instead…`}
                aria-label={`${deny.label} with a note to ${who}`}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-[13px] placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="submit" variant="secondary" disabled={!text.trim() || sending === "out"}>
                {deny.label}
              </Button>
            </form>
          ) : null}
          {ask.askKind === "question" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) answer(e.currentTarget, reply({ text: text.trim() }));
              }}
              className="flex items-center gap-2"
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Something else…"
                aria-label="Answer in your own words"
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-[13px] placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button
                type="submit"
                disabled={!text.trim() || sending === "out"}
              >
                Send
              </Button>
            </form>
          ) : null}
          {sending === "elsewhere" ? (
            <div role="status" className="text-[13px] text-muted-foreground">
              Answered on another device
            </div>
          ) : sending === "failed" ? (
            <div role="alert" className="text-[13px] text-destructive">
              Your answer didn't reach {engineLabel}. Pick again.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * A custom tool the agent called (its agent file's `tools`): the input it sent, and a box for the result the person
 * writes back, sent as the tool's answer or as its error.
 */
function ToolAskCard({
  ask,
  tool,
  sending,
  onSend,
  engineLabel,
  header,
}: {
  ask: Extract<TranscriptItem, { kind: "ask" }>;
  tool: { readonly name: string; readonly input: string };
  sending: "idle" | "out" | "failed" | "elsewhere";
  onSend: (content: string, isError: boolean) => void;
  engineLabel: string;
  header: ReactNode;
}) {
  const [result, setResult] = useState("");
  const resolved = ask.resolution !== null;
  const description = ask.prompt.startsWith(`${tool.name}: `) ? ask.prompt.slice(tool.name.length + 2) : null;
  return (
    <div className="my-2 rounded-xl border border-border bg-card p-4">
      {header}
      {description ? <div className="mb-2 whitespace-pre-wrap text-[14px] leading-[22px]">{description}</div> : null}
      <pre className="mb-3 max-h-48 overflow-auto rounded-md border border-border bg-secondary/60 px-2.5 py-1.5 font-mono text-[12.5px] leading-5 text-foreground">{tool.input}</pre>
      {resolved && (ask.resolution === "expired" || ask.resolution === "cancelled") ? (
        <div className="text-[13px] text-muted-foreground">Cancelled before a result.</div>
      ) : resolved ? (
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <HugeIcon icon={Tick02Icon} className="size-3.5 text-success" />
          <span className="text-foreground">{ask.resolution}</span>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSend(result, false);
          }}
          className="flex flex-col gap-2"
        >
          <textarea
            value={result}
            onChange={(e) => setResult(e.target.value)}
            rows={3}
            placeholder="What the tool returns"
            aria-label={`${tool.name}'s result`}
            className="min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-[12.5px] placeholder:text-[hsl(var(--subtle-foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={sending === "out"}>
              Send result
            </Button>
            <Button type="button" variant="ghost" disabled={sending === "out"} onClick={() => onSend(result || "The tool failed.", true)}>
              Send as error
            </Button>
          </div>
          {sending === "elsewhere" ? (
            <div role="status" className="text-[13px] text-muted-foreground">
              Answered on another device
            </div>
          ) : sending === "failed" ? (
            <div role="alert" className="text-[13px] text-destructive">
              The result didn't reach {engineLabel}. Send it again.
            </div>
          ) : null}
        </form>
      )}
    </div>
  );
}

export const FULL_ACCESS_QUESTION = "Why am I being asked this?";

/** Why an approval reached the person although the chat runs with full access. */
export function fullAccessExplanation(override: "ask_rule" | "engine_check", engineLabel: string): string {
  return override === "ask_rule"
    ? `Full access skips approvals, but an ask rule in ${engineLabel}'s own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts.`
    : `Full access skips approvals, but ${engineLabel} still stops for a few safety checks of its own that no setting can skip, such as a delete whose path it can't verify. Caveman Code can't turn these off, so check the request and approve it if it's what you expect.`;
}

/** How long after an ask card shows, or the window comes forward, before a click or keycap on it counts. */
export const ASK_ARM_MS = 350;

/**
 * Whether a click or keycap at `at` answers the ask. Not before `armedAt` (ASK_ARM_MS after the card showed or the
 * window came forward): when one ask is answered the next takes its place, so a double-click would answer both, and on
 * Windows and Linux the click that brings the window forward reaches the page. Not while this card's answer is out.
 */
export function askTakes(at: number, armedAt: number, sending: boolean): boolean {
  return !sending && at >= armedAt;
}

/** What a screen reader hears when a turn ends: done, stopped, or failed and why. */
export function turnAnnouncement(outcome: "completed" | "interrupted" | "failed", engineLabel: string, error: string | null): string {
  if (outcome === "completed") return `${engineLabel} finished.`;
  if (outcome === "interrupted") return `${engineLabel} stopped.`;
  return `The turn failed${error ? `: ${error.split("\n")[0]!.slice(0, 160)}` : "."}`;
}

/** Asks already read out, so a re-render or a reopened chat says each once. */
const announcedAsks = new Set<string>();

/** What a screen reader hears when an ask starts waiting: who asks, what for, and how to answer from the keyboard. */
export function askAnnouncement(ask: Pick<Extract<TranscriptItem, { kind: "ask" }>, "askKind" | "prompt" | "options" | "secret">, engineLabel: string): string {
  const first = ask.prompt.split("\n")[0]!.trim();
  if (ask.askKind === "secret") return `${engineLabel} needs a secret${ask.secret ? `: ${ask.secret.name}` : ""}.`;
  if (ask.askKind === "tool") return `${engineLabel} called ${first.split(":")[0]} and waits for its result.`;
  const what = ask.askKind === "approval" ? "wants approval" : "asks";
  const keys = ask.options.length > 0 && ask.options.length <= 9 ? ` Press 1 to ${ask.options.length} in the card to answer.` : "";
  return `${engineLabel} ${what}: ${first}.${keys}`;
}

/**
 * What a key does in an ask card whose option `at` has focus (-1: elsewhere in the card) among `n`:
 * a digit picks its option, ↑↓ move focus and wrap; null for any other key.
 */
export function askKey(key: string, at: number, n: number): { readonly index: number; readonly pick: boolean } | null {
  if (n === 0) return null;
  if (/^[1-9]$/.test(key) && Number(key) <= n) return { index: Number(key) - 1, pick: true };
  if (key === "ArrowDown") return { index: at < 0 || at >= n - 1 ? 0 : at + 1, pick: false };
  if (key === "ArrowUp") return { index: at <= 0 ? n - 1 : at - 1, pick: false };
  return null;
}

/** When a message was sent: the time today, else the day too ("Yesterday 14:02", "Mon 14:02", "Oct 12, 14:02"). */
export function sentAt(at: string, now = new Date()): string {
  const sent = new Date(at);
  if (Number.isNaN(sent.getTime())) return "";
  const time = sent.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Calendar days apart; rounding absorbs a DST hour.
  const ago = Math.round((day(now) - day(sent)) / 86_400_000);
  if (ago === 0) return time;
  if (ago === 1) return `Yesterday ${time}`;
  if (ago > 1 && ago < 7) return `${sent.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  const date = sent.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sent.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  return `${date}, ${time}`;
}

/** A message's sent time (`sentAt`), read out to screen readers; the turn footer shows the time on screen. */
function SentAt({ at, className }: { at: string; className?: string }) {
  const label = sentAt(at);
  if (!label) return null;
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()} className={cn("select-none whitespace-nowrap text-[12px] tabular-nums text-muted-foreground", className)}>
      {label}
    </time>
  );
}

export function relativeTime(at: string): string {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString();
}
