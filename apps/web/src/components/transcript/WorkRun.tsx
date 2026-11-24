// A run of thoughts and tool calls as AI Elements' Trace lines (tool
// icon, the verb from what the call did, the subject in mono, duration). What
// is done gets out of the way, as in Codex: the settled part of a run is one
// line ("Read 3 files, searched for retryPolicy, edited retry.go, ran tests
// +109 −12"; one call keeps its own line, "Tested ./..."), opening on request to
// every step. A shell command says what it did (state/tool-actions.ts) and
// opens to the command as it ran and its output. While the run is live, the
// step running now has its own line under the run's line, which says what the
// run has done so far; both change their words in place at a steady pace
// (2026-11-09). Only the step that is running animates, saying what it does
// ("Searching for retryPolicy"); a thought shows only while it streams, as its
// heading ("Locating the retry loop") or "Thinking", and once settled only
// inside the opened run. The files the run
// touched get no cards here: they are rows of the turn's Changes card (and
// chips in its answer). The screenshots its tools returned follow as
// thumbnails that open the chat's viewer, and the pages they showed
// (html_render) are drawn whole.
import { CodeBlock, codeBlockActionClass, CodeBlockActions, CodeBlockContent, CodeBlockLine } from "@caveman-app/ui/ai/code-block";
import { linkAction, urlTransform } from "@caveman-app/ui/ai/response";
import { DisclosureContent } from "@caveman-app/ui/ai/disclosure";
import { useConversation } from "@caveman-app/ui/ai/conversation";
import { Rolling } from "@caveman-app/ui/ai/rolling";
import { useSteady } from "@caveman-app/ui/lib/use-steady";
import { useStreamView } from "@caveman-app/ui/ai/stream-view";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceSubject, TraceTitle } from "@caveman-app/ui/ai/trace";
import { FileTypeIcon } from "@caveman-app/ui/icons/file-type";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon as HugeIcon, ArrowExpand01Icon, ArrowRight01Icon, BulbIcon, Image01Icon } from "@caveman-app/ui/icons/huge";
import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useStableCallback } from "@caveman-app/ui/lib/use-stable-callback";
import { FindCurrent } from "../find/useChatFind.ts";
import { ACTIONS, summarizeParts } from "../../state/tool-actions.ts";
import { fileArtifactId } from "../../state/transcript-artifacts.ts";
import type { Artifact, EditedFile, ThreadNote, ToolItem, WebSource } from "../../state/transcript-model.ts";
import { siteOf } from "../../state/transcript.ts";
import { ChatImages, isImage, useOpenImage } from "../gallery/Gallery.tsx";
import { GeneratedImages } from "../gallery/GeneratedImages.tsx";
import { HtmlPages } from "./HtmlPage.tsx";
import { isImageGeneration } from "../../state/image-generation.ts";
import { pageOf } from "../../state/html-render.ts";
import type { CardActions } from "./ArtifactCards.tsx";
import { Icon, TOOL_ICON } from "./marks.tsx";
import { LiveOutput } from "./LiveOutput.tsx";
import { CloudScheduleAllow } from "./CloudScheduleAllow.tsx";
import { LogMarkdown, LogText } from "./LogText.tsx";
import { ThreadPill, useOpenThread } from "./ThreadPill.tsx";
import { useChatWorkspace, useWorkspaceRoot } from "./root.ts";
import { workTools, type Row, type Thought, type WorkItem } from "./rows.ts";
import { HeldSteps } from "./held.ts";
import { SeenItems } from "./seen.ts";
import { detailKey, useWorkDetail, WorkDisclosuresContext } from "./work-disclosures.ts";
import { workspacePath, workspaceText } from "../../state/workspace-paths.ts";
import { useOpenSurface } from "../../panels/navigation.tsx";

/** The screenshots a run's tools returned: the strip under a run or a fold. */
export function runShots(tools: ReadonlyArray<ToolItem>, artifacts: ReadonlyArray<Artifact>): Artifact[] {
  const ids = new Set(tools.filter((t) => !isImageGeneration(t.name)).map((t) => t.id));
  return artifacts.filter((a) => ids.has(a.itemId) && isImage(a));
}

/**
 * What folded rows still show (a finished turn's fold, a step behind the working line): the screenshots their tools
 * returned and the pictures their replies carry, in the order they came; their generated images and pages; and the
 * pull requests their replies named. Null when there is nothing to show.
 */
export function foldShows(rows: ReadonlyArray<Row>, artifacts: ReadonlyArray<Artifact>): { tools: ToolItem[]; shots: Artifact[]; prs: Artifact[] } | null {
  const tools = rows.flatMap((r) => (r.kind === "work" ? workTools(r.items) : []));
  const ran = new Set(tools.filter((t) => !isImageGeneration(t.name)).map((t) => t.id));
  const said = new Set(rows.flatMap((r) => (r.kind === "item" && r.item.kind === "assistant" ? [r.item.id] : [])));
  const shots = artifacts.filter((a) => (ran.has(a.itemId) && isImage(a)) || (said.has(a.itemId) && a.kind === "image"));
  const prs = artifacts.filter((a) => said.has(a.itemId) && a.kind === "pr");
  const made = tools.some((t) => isImageGeneration(t.name) || pageOf(t) !== undefined);
  return shots.length > 0 || prs.length > 0 || made ? { tools, shots, prs } : null;
}

/** How a transcript keeps a run open or closed across renders and the turn ending (Transcript's Items). */
export interface RunDisclosure {
  /** The run's row: what the person chose for it is kept by this id, so it outlives the turn folding it in. */
  id?: string | undefined;
  /** Opened (true) or closed (false) by hand; undefined starts collapsed. */
  opened?: boolean | undefined;
  onDisclose?: ((id: string, open: boolean) => void) | undefined;
}

export function WorkRun({
  items,
  artifacts,
  onOpen,
  openId,
  cards = true,
  generated = true,
  active = false,
  ...disclosure
}: {
  items: ReadonlyArray<WorkItem>;
  artifacts: ReadonlyArray<Artifact>;
  cards?: boolean;
  generated?: boolean;
  /** The live turn's current run: its summary names the currently running step. */
  active?: boolean;
} & RunDisclosure &
  CardActions) {
  return (
    <div className="py-0.5">
      <RunSteps items={items} active={active} artifacts={artifacts} onOpen={onOpen} {...disclosure} />
      {cards ? (
        <ChatImages images={runShots(workTools(items), artifacts)} />
      ) : null}
      {generated ? (
        <>
          <GeneratedImages tools={workTools(items)} artifacts={artifacts} />
          <HtmlPages tools={workTools(items)} onOpen={onOpen} openId={openId} />
        </>
      ) : null}
    </div>
  );
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How often a live run's lines may change what they say: a burst of calls reads as steady lines, not a flicker. */
export const STEADY_MS = 260;

/**
 * A run's steps. One step is its own line. Several are one line, the run's summary, with the steps under it. While
 * the run is live, the step running now has its own line under the summary, which says what the run has done; between
 * steps the latest one keeps that line, so the run never shrinks and regrows (, "sum + current step
 * is way better"). An opened output keeps the group open as more calls arrive. Explicit choices survive completion
 * and remounting inside a turn fold.
 */
function RunSteps({
  id,
  items: arrived,
  active,
  opened,
  onDisclose,
  artifacts,
  onOpen,
}: { items: ReadonlyArray<WorkItem>; active: boolean; artifacts: ReadonlyArray<Artifact>; onOpen?: ((id: string) => void) | undefined } & RunDisclosure) {
  // The latest state always lands within STEADY_MS; an ended run shows exactly how it ended.
  const items = useSteady(arrived, active ? STEADY_MS : 0);
  const contentId = useId();
  const seen = useContext(SeenItems);
  const conversation = useConversation();
  // The transcript keeps what the person chose (onDisclose); a run shown on its own (a lone step, a test) keeps it here.
  const [own, setOwn] = useState<boolean | undefined>(undefined);
  const kept = id !== undefined && onDisclose !== undefined;
  const byHand = kept ? opened : own;
  const details = useContext(WorkDisclosuresContext);
  const openedDetail = items.some((item) => details?.choices.get(detailKey(item.id)) === true);
  const choose = useStableCallback((open: boolean) => (id !== undefined && onDisclose ? onDisclose(id, open) : setOwn(open)));
  // Find in chat stepped to one of these steps: the run opens to show it.
  const found = useContext(FindCurrent);
  const holdsFound = found !== null && items.some((i) => i.id === found);
  // A step an approval holds stops the run on the person: its line rests rather than shimmers.
  const held = useContext(HeldSteps);
  useEffect(() => {
    if (holdsFound) choose(true);
  }, [holdsFound, choose]);
  // Work is a quiet summary until the reader asks for its steps, live or settled.
  const open = byHand ?? openedDetail;
  const away = byHand === undefined && !open;
  const root = useWorkspaceRoot();
  // A thought is readable on request, including after it settles.
  const steps = items.filter((i) => i.kind === "tool" || i.streaming || byHand === true || details?.choices.get(detailKey(i.id)) === true);
  if (steps.length === 0) return null;
  if (steps.length === 1 && byHand !== true) {
    return (
      <Trace>
        <WorkStep id={steps[0]!.id} live={active}>
          <Step item={steps[0]!} artifacts={artifacts} onOpen={onOpen} />
        </WorkStep>
      </Trace>
    );
  }
  const tools = workTools(items);
  // The step running now (or, between steps, the latest one) keeps a line of its own while the run is live.
  const current = active ? (steps.findLast((i) => (i.kind === "tool" ? i.status === "running" : i.streaming)) ?? steps.at(-1)) : undefined;
  const done = tools.filter((t) => t !== current);
  // Running/held steps use the present tense; only finished calls contribute to completed summaries and counts.
  // A denied call did nothing and contributes neither actions nor lines.
  const finished = done.filter((t) => t.status === "done" || t.status === "failed");
  const added = finished.reduce((n, t) => n + (t.added ?? 0), 0);
  const removed = finished.reduce((n, t) => n + (t.removed ?? 0), 0);
  // A run that changed files wears the pencil, even when the change was one step of a command that also ran something.
  const changes = (t: ToolItem) => t.parts.some((p) => ACTIONS[p.action].icon === "edit" || ACTIONS[p.action].icon === "create");
  const shown = current ? done : tools;
  const lead = shown.find((t) => t.icon === "edit" || t.icon === "create") ?? shown.find(changes) ?? shown[0];
  const leadIcon = lead && changes(lead) && lead.icon !== "create" ? "edit" : lead?.icon;
  const words = (t: ToolItem) => (
    <>
      {held.has(t.id) ? "Waiting for approval" : workspaceText(t.verb, root)} <TraceSubject>{workspaceText(t.subject, root)}</TraceSubject>
    </>
  );
  // The run's line: what it has done. Live, the step under it says what it does; settled, the line is the run.
  const title = current
    ? finished.length > 1
      ? workspaceText(summarize(finished), root)
      : finished.length === 1
        ? words(finished[0]!)
        : done.length
          ? words(done[0]!)
          : "Thinking"
    : tools.length > 1 && finished.length
      ? workspaceText(summarize(finished), root)
      : tools.length
        ? words(tools[0]!)
        : "Thinking";
  return (
    <Trace data-work-disclosure="">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          // What opens grows under the pointer before the view follows on.
          conversation.hold();
          choose(!open);
        }}
        className="group/trace-trigger flex w-fit max-w-full min-w-0 items-center gap-1 rounded-md pr-1 text-left text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&:hover_[data-slot=trace-line]]:text-foreground"
      >
        <TraceLine>
          <TraceIcon>{leadIcon ? <Icon icon={TOOL_ICON[leadIcon]} /> : <Icon icon={BulbIcon} />}</TraceIcon>
          <TraceTitle>{title}</TraceTitle>
          {added || removed ? (
            <span className="flex shrink-0 gap-1.5 font-mono text-[12px] tabular-nums">
              <span className="text-diff-add-ink">+{added}</span>
              <span className="text-diff-del-ink">−{removed}</span>
            </span>
          ) : null}
        </TraceLine>
        <HugeIcon
          icon={ArrowRight01Icon}
          className={cn(
            "size-3.5 shrink-0 transition-[transform,opacity] duration-150 ease-snap group-hover/trace-trigger:opacity-100 group-focus-visible/trace-trigger:opacity-100 group-aria-expanded/trace-trigger:rotate-90",
            "opacity-70 group-aria-expanded/trace-trigger:opacity-100",
          )}
        />
      </button>
      <DisclosureContent id={contentId} className="work-body" open={open} immediate={away}>
        <Trace className="ml-[7px] mt-0.5 border-l border-border pb-1 pl-4">
          {items
            .filter((item) => item !== current)
            .map((item) => (
              <WorkStep key={item.id} id={item.id} live={active}>
                <Step item={item} artifacts={artifacts} onOpen={onOpen} />
              </WorkStep>
            ))}
        </Trace>
      </DisclosureContent>
      {current ? (
        // The step running now says what it does in place: the next one rolls in over it, in the same height.
        <Rolling id={current.id} enter={seen.isNew(current.id)}>
          <WorkStep id={current.id} live={false}>
            <Step item={current} artifacts={artifacts} onOpen={onOpen} />
          </WorkStep>
        </Rolling>
      ) : null}
    </Trace>
  );
}

/**
 * A new live step fades/rises 4px over 150ms. Every step is immediately in layout;
 * no animation queue can hide a running command or approval. History and remounts
 * sit still. The entrance is removed after it settles so it cannot replay.
 */
function WorkStep({ id, live, children }: { id: string; live: boolean; children: ReactNode }) {
  const seen = useContext(SeenItems);
  const view = useStreamView();
  const [arrivedIn] = useState(view);
  const [entering, setEntering] = useState(() => live && !reducedMotion() && seen.isNew(id));
  useEffect(() => seen.add(id), [seen, id]);
  // CSS animations may be suppressed by a live reduced-motion change or by a
  // hidden pane; never leave its entrance armed for a later visit.
  useEffect(() => {
    if (!entering) return;
    const timer = window.setTimeout(() => setEntering(false), 150);
    return () => window.clearTimeout(timer);
  }, [entering]);
  return (
    <div
      className="work-step"
      data-entering={(entering && arrivedIn === view) || undefined}
      onAnimationEnd={(e) => {
        if (e.animationName === "step-in" && e.target === e.currentTarget) setEntering(false);
      }}
    >
      {children}
    </div>
  );
}

function Step({ item, artifacts, onOpen }: { item: WorkItem; artifacts: ReadonlyArray<Artifact>; onOpen?: ((id: string) => void) | undefined }) {
  if (item.kind === "reasoning") return <ThoughtLine thought={item} />;
  return <ToolLine tool={item} terminal={artifacts.find((a) => a.itemId === item.id && a.kind === "terminal")} image={artifacts.find((a) => a.itemId === item.id && isImage(a))} onOpen={onOpen} />;
}

/** "Read 3 files, searched for retryPolicy, ran tests": what every call did, each kind once, in order of first appearance. */
export function summarize(tools: ReadonlyArray<ToolItem>): string {
  return summarizeParts(tools.flatMap((t) => t.parts));
}

/** A reasoning summary's latest heading ("**Locating the retry loop**"): what Codex shows while it thinks. */
export function thoughtTitle(text: string): string | null {
  const heads = [...text.matchAll(/^\s*\*\*([^*\n]+)\*\*\s*$/gm)];
  return heads.at(-1)?.[1]?.trim() || null;
}

/** While it streams, one shimmering line: the thought's heading or "Thinking", no icon (Codex's status line). Settled, inside an opened run: "Thought" or its heading. Either opens to the whole text. */
function ThoughtLine({ thought }: { thought: Thought }) {
  const seen = useContext(SeenItems);
  const [fresh] = useState(() => seen.isNew(thought.id));
  const [open, setOpen] = useWorkDetail(thought.id);
  const { text, streaming } = thought;
  const title = thoughtTitle(text);
  const line = (
    <TraceLine status={streaming ? "running" : undefined}>
      {streaming ? null : (
        <TraceIcon>
          <Icon icon={BulbIcon} />
        </TraceIcon>
      )}
      <TraceTitle>{title ?? (streaming ? "Thinking" : "Thought")}</TraceTitle>
    </TraceLine>
  );
  if (!text.trim()) return line;
  return (
    <TraceCollapsible data-work-disclosure="" open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="max-h-80 overflow-y-auto text-[13px] leading-[20px]">
        <LogMarkdown text={text} streaming={streaming} fresh={fresh} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** The prompt of a schedule_task call that set a new schedule on Cloud (any engine's spelling of the tool's name). */
function cloudSchedulePrompt(tool: ToolItem): string | undefined {
  if (!/(^|__|\.)schedule_task$/.test(tool.name ?? "")) return undefined;
  const input = tool.input as { where?: unknown; prompt?: unknown; scheduledTaskId?: unknown } | null | undefined;
  return input?.where === "cloud" && input.scheduledTaskId === undefined && typeof input.prompt === "string" ? input.prompt : undefined;
}

function ToolLine({ tool, terminal, image, onOpen }: { tool: ToolItem; terminal: Artifact | undefined; image: Artifact | undefined; onOpen?: ((id: string) => void) | undefined }) {
  const openSurface = useOpenSurface();
  const [open, setOpen] = useWorkDetail(tool.id);
  // Held by an approval: the step has not started, it waits on the person (no shimmer, no clock).
  const held = useContext(HeldSteps).has(tool.id);
  const status = tool.status === "running" && !held ? "running" : tool.status === "failed" ? "error" : undefined;
  // A file inside the chat's folder reads relative to it, as the cards and the reader name it.
  const root = useWorkspaceRoot();
  const workspaceId = useChatWorkspace();
  const openImage = useOpenImage();
  const subject = workspaceText(tool.subject, root);
  // A command its line names as it ran needs no repeating; one it paraphrases opens to the command itself.
  const command = tool.command !== null && tool.command.trim() !== tool.subject ? tool.command.trim() : null;
  const line = (
    <TraceLine status={status}>
      <TraceIcon>
        <Icon icon={isImageGeneration(tool.name) ? Image01Icon : TOOL_ICON[tool.icon]} />
      </TraceIcon>
      <TraceTitle>
        {held ? "Waiting for approval" : workspaceText(tool.verb, root)}{" "}
        <span data-find-id={tool.id}>
          <TraceSubject>{subject}</TraceSubject>
        </span>
        {tool.then ? `, ${tool.then}` : null}
      </TraceTitle>
      {tool.added !== null || tool.removed ? (
        <span className="flex shrink-0 gap-1.5 font-mono text-[12px] tabular-nums">
          {tool.added !== null ? <span className="text-diff-add-ink">+{tool.added}</span> : null}
          {tool.removed ? <span className="text-diff-del-ink">−{tool.removed}</span> : null}
        </span>
      ) : null}
      {tool.status === "denied" ? <TraceDescription className="text-warning">denied</TraceDescription> : null}
      <TraceDescription>{tool.status === "running" ? held ? "waiting for you" : <Elapsed since={tool.startedAt} /> : duration(tool.startedAt, tool.finishedAt)}</TraceDescription>
    </TraceLine>
  );
  const output = tool.output.trim() !== "";
  const sources = tool.sources ?? [];
  const files = tool.files ?? [];
  // One of the runtime's own tools on other threads opens to what it said there; one that said nothing to the one
  // thread it named (a read, a wait) opens that thread.
  const notes = (tool.threads ?? []).filter((n) => n.text !== null);
  const only = tool.threads?.length === 1 ? tool.threads[0]!.thread : null;
  // Live logs share the output disclosure; they never unfold the transcript by themselves. A schedule set on Cloud
  // shows Allow under its line while it waits for the person.
  const cloudPrompt = cloudSchedulePrompt(tool);
  const live =
    tool.status === "running" && tool.name === "command" ? (
      <LiveOutput workspaceId={workspaceId} itemId={tool.id} />
    ) : tool.status === "done" && cloudPrompt !== undefined && workspaceId !== null ? (
      <CloudScheduleAllow workspaceId={workspaceId} prompt={cloudPrompt} />
    ) : null;
  if (!output && command === null && sources.length === 0 && files.length === 0 && notes.length === 0 && !live) {
    if (only?.workspace_id !== undefined) return <ThreadLine workspaceId={only.workspace_id} title={only.title}>{line}</ThreadLine>;
 // An edit opens what that one step recorded in Changes (upstream #26304), not the checkout's diff.
    if (tool.name === "edit" && workspaceId !== null && tool.status !== "running") {
      return <OpenLine title="Open this edit's diff" onClick={() => openSurface(workspaceId, "diff", { item: tool.id })}>{line}</OpenLine>;
    }
    // An image the agent looked at opens in the chat's viewer, as its thumbnail does.
    if (image && openImage) return <OpenLine title={`Open ${image.title}`} onClick={() => openImage(image.id)}>{line}</OpenLine>;
    return line;
  }
  return (
    <TraceCollapsible data-work-disclosure="" open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="pl-3 pr-0">
        {notes.length > 0 ? <ThreadNotes notes={notes} /> : null}
        {sources.length > 0 ? <WebSources sources={sources} page={tool.parts[0]?.action === "web"} /> : null}
        {files.length > 0 ? <EditFiles toolId={tool.id} files={files} root={root} onOpen={onOpen} /> : null}
        {output || command !== null ? (
          <CodeBlock size="sm" variant={tool.status === "failed" ? "destructive" : "default"}>
            {terminal && onOpen ? (
              <CodeBlockActions>
                <button type="button" aria-label="Open in side panel" title="Open in side panel" className={codeBlockActionClass} onClick={() => onOpen(terminal.id)}>
                  <HugeIcon icon={ArrowExpand01Icon} />
                </button>
              </CodeBlockActions>
            ) : null}
            {command !== null ? (
              <CodeBlockContent wrap language="bash" aria-label="Command" className={cn("max-h-40 text-muted-foreground", output && "border-b border-border")}>
                {command}
              </CodeBlockContent>
            ) : null}
            {output ? (
              <CodeBlockContent wrap className="max-h-72">
                <LogLines text={tool.output} />
              </CodeBlockContent>
            ) : null}
          </CodeBlock>
        ) : null}
        {live}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/**
 * What one of the runtime's own tools said to other threads: each thread as the chat it goes to ("To @Fix checkout",
 * as the receiving chat says "From @Lead") over its words.
 */
function ThreadNotes({ notes }: { notes: ReadonlyArray<ThreadNote> }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 pb-1">
      {notes.map((note, i) => (
        // A call's threads never reorder.
        // oxlint-disable-next-line react/no-array-index-key
        <div key={i} className="min-w-0">
          {note.thread ? (
            <div className="mb-1 truncate text-[12px] text-muted-foreground">
              To <ThreadPill workspaceId={note.thread.workspace_id} title={note.thread.title} />
            </div>
          ) : null}
          {note.text ? (
            <div className="max-h-72 overflow-y-auto">
              <LogMarkdown text={note.text} streaming={false} fresh={false} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The line of a call on one thread that said nothing there (a read, a wait): it opens that thread while this runtime has it. */
function ThreadLine({ workspaceId, title, children }: { workspaceId: string; title: string; children: ReactNode }) {
  const open = useOpenThread(workspaceId);
  return open ? <OpenLine title={`Open ${title}`} onClick={open}>{children}</OpenLine> : children;
}

/** A step's line that opens what it made or looked at. */
function OpenLine({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="group/trace-trigger flex w-fit max-w-full min-w-0 items-center gap-1 rounded-md pr-1 text-left text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&:hover_[data-slot=trace-line]]:text-foreground"
    >
      {children}
      <HugeIcon icon={ArrowExpand01Icon} aria-hidden className="size-3.5 shrink-0 opacity-0 transition-opacity duration-75 group-hover/trace-trigger:opacity-100 group-focus-visible/trace-trigger:opacity-100" />
    </button>
  );
}

/** A command's output line by line, as the code block draws plain text, with the addresses and files in it linked. */
function LogLines({ text }: { text: string }) {
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  // Lines never reorder: the output is cut the same way every time.
  // oxlint-disable-next-line react/no-array-index-key
  return lines.map((line, i) => <CodeBlockLine key={i}>{line ? <LogText text={line} /> : ""}</CodeBlockLine>);
}

function Elapsed({ since }: { since: string }) {
  const [, force] = useState(0);
  // A one-second tick while a tool runs; stops when the line unmounts.
  const tick = useRef(() => force((n) => n + 1));
  useEffect(() => {
    const id = setInterval(() => tick.current(), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{clock(Date.now() - Date.parse(since))}</>;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function duration(start: string, end: string | null): string {
  if (!end) return "";
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : clock(ms);
}

/**
 * What a web row opens to: a search's sources by title and site, or the page a read is on by its title and
 * address (its line already names the site); the full address on hover. Each opens in the browser as the
 * chat's links do, through the answer's own safe-URL rule.
 */
export function WebSources({ sources, page = false }: { sources: ReadonlyArray<WebSource>; page?: boolean }) {
  return (
    <ul aria-label={page ? "Page" : "Sources"} className="-ml-1 flex max-h-72 min-w-0 flex-col overflow-y-auto py-0.5">
      {sources.map((source) => {
        const href = urlTransform(source.url, "href");
        if (linkAction(href) !== "external") return null;
        return (
          <li key={source.url} className="flex min-w-0">
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              title={source.url}
              className={cn(
                "group/source flex min-w-0 max-w-full rounded-md px-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                // A page's address is what it opens to: the two-line row (title, then address) gives it the width.
                page ? "flex-col py-1 leading-5" : "h-6 items-center gap-2",
              )}
            >
              <span className="min-w-0 max-w-full truncate text-secondary-foreground decoration-muted-foreground/50 underline-offset-[3px] transition-colors duration-75 group-hover/source:text-foreground group-hover/source:underline">
                {source.title ?? address(source.url)}
              </span>
              {source.title ? (
                <span className={cn("text-[12px] text-[hsl(var(--subtle-foreground))]", page ? "min-w-0 max-w-full truncate" : "shrink-0")}>{page ? address(source.url) : siteOf(source.url)}</span>
              ) : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

const FILE_STATUS: Record<EditedFile["status"], string | null> = { added: "new", modified: null, deleted: "deleted", renamed: null };

/**
 * What a patch over several files opens to (a Codex patch, upstream #22541): every file it touched, in its order, with
 * what happened to it. A file it left opens in the side panel as the turn's Changes card opens one (its diff in
 * the chat's folder, or the file itself); a deleted one has nothing to open.
 */
export function EditFiles({
  toolId,
  files,
  root,
  onOpen,
}: {
  toolId: string;
  files: ReadonlyArray<EditedFile>;
  root: string | null | undefined;
  onOpen?: ((id: string) => void) | undefined;
}) {
  return (
    <ul aria-label="Files" className="-ml-1 flex max-h-72 min-w-0 flex-col overflow-y-auto py-0.5">
      {files.map((file, i) => {
        const path = workspacePath(file.path, root);
        const from = file.status === "renamed" && file.oldPath !== null ? workspacePath(file.oldPath, root) : null;
        const note = from !== null ? `from ${from}` : FILE_STATUS[file.status];
        const open = file.status !== "deleted" && onOpen ? () => onOpen(fileArtifactId(toolId, i)) : null;
        const body = (
          <>
            <FileTypeIcon path={file.path} className="size-[14px] shrink-0" />
            <span
              className={cn(
                "min-w-0 truncate font-mono text-[12.5px] text-secondary-foreground decoration-muted-foreground/50 underline-offset-[3px] transition-colors duration-75",
                open && "group-hover/file:text-foreground group-hover/file:underline",
                file.status === "deleted" && "line-through decoration-muted-foreground/60",
              )}
            >
              {path}
            </span>
            {note ? <span className="min-w-0 shrink truncate text-[12px] text-[hsl(var(--subtle-foreground))]">{note}</span> : null}
          </>
        );
        const row = "flex h-6 min-w-0 max-w-full items-center gap-2 rounded-md px-1 text-left";
        return (
          <li key={`${i}:${file.path}`} className="flex min-w-0">
            {open ? (
              <button type="button" title={`Open ${path}`} onClick={open} className={cn(row, "group/file outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}>
                {body}
              </button>
            ) : (
              <span title={file.status === "deleted" ? `${path} was deleted` : path} className={row}>
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** An address without its scheme or a bare trailing slash: what a page with no title reads as. */
function address(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}
