// Folds Session Protocol v1 events into the transcript the workspace renders.
// Events arrive in cursor order exactly once (the client dedupes), so apply()
// never needs to undo anything. `usage` events only add to the session's token
// count: spend lives in Settings -> Spend, never inside a session.

import type { AccessMode, SessionEvent, ToolThread, TurnFile, TurnFilesTotal } from "@caveman-app/session-protocol";
import { resolveCavemanMcpToolDefinition, type CavemanMcpToolDefinition } from "@caveman-app/shared/cavemanMcpToolPresentation";
import { compactDynamicToolOutput } from "@caveman-app/shared/toolOutput";
import { answerText, type SessionMode } from "./grill.ts";
import { isImageGeneration } from "./image-generation.ts";
import { nextCacheReport, type CacheReport } from "./cache-expiry.ts";
import { iconOf, isAction, isDesktopTool, lineOf, readCommand, readDesktop, type ToolPart } from "./tool-actions.ts";
import { extractArtifacts, isCreateTool } from "./transcript-artifacts.ts";
import type { AskQuestion, ChiefReaction, EditedFile, PlanStep, SessionView, ThreadNote, ToolItem, TranscriptItem, TurnRun, WebSource } from "./transcript-model.ts";
import { THIS_COMPUTER } from "../lib/platform.ts";
import { generatedOf } from "./generated.ts";
import { LID_NOTE_TITLE } from "./sleep-stop.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Item = Mutable<TranscriptItem> & { items?: Item[] };

export interface FileChangeView {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions: number;
  readonly deletions: number;
}

const OUTPUT_CAP = 64 * 1024;
/** An agent file in the chat's copy of the repo, repo-relative. */
const AGENT_FILE = /^\.caveman\/agents\/[^/]+\.md$/;



/** A notice outside any turn this close to a message of the person's was raised as it went out. */
const LOOSE_NOTICE_MS = 5000;

/** "3:00 PM" today, else "Oct 24, 3:00 PM"; nothing for a time that does not parse. */
export function resetTime(iso: string | undefined, now = new Date()): string | undefined {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  const date = new Date(at);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

export class SessionModel {
  private root: Item[] = [];
  private index = new Map<string, Item>();
  /** The list each item sits in (the root, or a subagent's steps): a long chat's every tool.output and delta finds its
   * row without walking the whole transcript. */
  private where = new Map<string, Item[]>();
  /**
   * The runtime's own tools (delegate_task, thread_send, …) by item: said in words, never as `mcp__caveman-code__…`,
   * with the threads their tool.started named.
   */
  private ownTools = new Map<string, { readonly def: CavemanMcpToolDefinition; readonly threads: ReadonlyArray<ToolThread> | undefined }>();
  /** A delegated agent's card by the task id its delegate_task call returned (subagent.started `task_id`). */
  private delegated = new Map<string, string>();
  /** A settled delegate_task row by the task id it returned, until its agent's card takes its place. */
  private delegations = new Map<string, string>();
  private running = false;
  /** Stops sent from this device and not yet settled, by request id. */
  private stopping = new Set<string>();
  /** Attribution follows turn.started even in backlog replay, not the chat's currently selected engine. */
  private engine: string | undefined;
  /** The last park was a move to there; the session.resumed after it is the move itself, already said. */
  private movedTo: "cloud" | "this_mac" | null = null;
  private movedFrom: string | null = null;
  /** The notice of the last session.parked: a move that did not go through rewrites it. */
  private parkedNotice: string | null = null;
  /** The runtime's "Paused when the lid closed" note, seen since the turn began: the stop that follows came from sleep. */
  private lidNote = false;
  private plan: PlanStep[] = [];
  /**
   * Notes said on a call (voice.turn handoff) whose own message has not come yet, their text by board item: that one
   * message is the spoken turn's, never a second bubble.
   */
  private handedOff = new Map<string, string>();
  /** The cursor each call started at (voice.call): only a message that came after it can be one of its notes. */
  private callStarts = new Map<string, number>();
  private files: FileChangeView[] = [];
  private diffVersion = 0;
  private queueVersion = 0;
  private cursor = -1;
  private context: SessionView["context"] = null;
  private tokens = 0;
  /** Cache timing only; no prices leave the usage event. */
  cacheReport: CacheReport | null = null;
  private goal: SessionView["goal"] = null;
  private forkedAt = 0;
  private mode: SessionMode = "default";
  /** The session's permissions: from session.attach, then each live turn.started that names them. */
  private access: AccessMode | undefined;
  private turn: SessionView["turn"] = null;
  /** The running turn's model (turn.started), unset when it named none: what its items are attributed to. */
  private turnModel: string | undefined;
  /** What the last turn ran on: a turn that starts on another model or effort gets a divider before its message. */
  private lastRun: TurnRun | null = null;
  /** The attach head: turn.started at or before it is backlog replay and says nothing about the mode now. */
  private modeAt = -1;
  /** The cursor that created each item: session.restored drops what came after its `at`. */
  private born = new Map<string, number>();
  private artifacts: SessionView["artifacts"] = [];
  /** checkpoint.created, in order, with the turn it ended and its cursor (session.restored drops the later ones). */
  private checkpoints: Array<{ readonly turnId: string | undefined; readonly id: string; readonly cursor: number; readonly files?: ReadonlyArray<TurnFile>; readonly filesTotal?: TurnFilesTotal }> = [];
  /** checkpoint.resolved: how each turn's changes were settled (its Changes card closed). */
  private resolved = new Map<string, "kept" | "undone">();
  /** Each turn's turn_end item, so a checkpoint reported after its turn.done still reaches the row. */
  private turnEnds = new Map<string, string>();
  /** Notices the runtime raised outside any turn (no turn_id), with when: one raised as a message went out sits under it. */
  private loose = new Map<string, number>();
  /**
   * A Chief's reactions on the person's messages, by message id, each with its cursor, oldest first: the last one shows.
   * session.restored drops the later ones, so the one before them shows again.
   */
  private reactions = new Map<string, Array<{ readonly emoji: ChiefReaction; readonly cursor: number }>>();
  /** The last reaction on each message, as the view reads them: a new map only when one changes, so rows re-render only then. */
  private reacted: ReadonlyMap<string, ChiefReaction> = new Map();
  private cached: SessionView | null = null;

  get lastCursor(): number {
    return this.cursor;
  }

  /** The event that first created an item, independent of its displayed position and timestamp. */
  itemCursor(id: string): number | undefined {
    return this.born.get(id);
  }

  /** From session.attach: where a fork's own turns begin. */
  setForkedAt(cursor: number): void {
    if (cursor === this.forkedAt) return;
    this.forkedAt = cursor;
    this.cached = null;
  }

  /** From session.attach (Session.moved_from). */
  setMovedFrom(runtimeId: string | null): void {
    if (runtimeId === this.movedFrom) return;
    this.movedFrom = runtimeId;
    this.cached = null;
  }

  /**
   * The session's mode: from session.attach with its head (later live
   * turn.started keep it current), or set locally after a turn.submit.
   */
  /** From session.attach (Session.access), or set locally after a turn.submit that picked them. */
  setAccess(access: AccessMode | undefined): void {
    if (access === undefined || access === this.access) return;
    this.access = access;
    this.cached = null;
  }

  setMode(mode: SessionMode, head?: number): void {
    if (head !== undefined) this.modeAt = head;
    if (mode === this.mode) return;
    this.mode = mode;
    this.cached = null;
  }

  get changes(): ReadonlyArray<FileChangeView> {
    return this.files;
  }

  apply(event: SessionEvent): void {
    if (event.cursor <= this.cursor) return;
    this.cursor = event.cursor;
    this.cached = null;
    this.cacheReport = nextCacheReport(this.cacheReport, event);
    const id = event.item_id ?? `${event.type}:${event.cursor}`;
    const container = this.containerFor(event.parent_item_id);
    switch (event.type) {
      case "turn.started":
        this.running = true;
        this.lidNote = false;
        this.engine = event.payload.engine;
        if (event.cursor > this.modeAt) {
          this.mode = event.payload.mode ?? this.mode;
          this.access = event.payload.access ?? this.access;
        }
        this.turnModel = event.payload.model || undefined;
        if (event.payload.model) this.switched(id, { engine: event.payload.engine, model: event.payload.model, effort: event.payload.effort ?? null });
        if (event.payload.model) this.turn = { model: event.payload.model, effort: event.payload.effort ?? null, ...(event.payload.speed ? { speed: event.payload.speed } : {}), ...(event.payload.account_id ? { account_id: event.payload.account_id } : {}) };
        return;
      case "grill.finished":
        this.push(container, { kind: "grill_finished", id, docPath: event.payload.doc_path, summary: event.payload.summary });
        return;
      case "message.delta": {
        const item = this.ensure(container, id, () => ({ kind: "assistant", id, text: "", streaming: true, at: event.at }));
        if (item.kind === "assistant" || item.kind === "reasoning") this.replace(container, { ...item, text: item.text + event.payload.text, streaming: true });
        return;
      }
      case "message.done": {
        const p = event.payload;
        const attachments = p.attachments?.length ? { attachments: p.attachments } : {};
        if (p.role === "user") {
          const scheduled = p.scheduled_task ? { scheduled: { taskId: p.scheduled_task.task_id, title: p.scheduled_task.title ?? null } } : {};
          // Written by the runtime for the agent: one row, never the person's bubble (state/generated.ts).
          const made = generatedOf(p);
          const user: Item = { kind: "user", id, text: p.text, at: event.at, delivery: p.delivery ?? "message", ...attachments, ...(p.from ? { from: p.from } : {}), ...scheduled, ...(made ? { generated: made } : {}) };
          const known = this.index.get(id);
          // The echo of a message sent from here (echo()) becomes the runtime's, where it already sits.
          if (known?.kind === "user" && known.pending) {
            this.replace(this.containerOf(id), user);
            this.born.set(id, this.cursor);
          }
          if (known) return;
          // A note the person said on a call: its spoken turn already shows the words, handed to the Chief.
          if (!p.from && !p.scheduled_task && this.noteSaid(p.text)) return;
          // "Compression off: proxy unavailable" comes as the message is sent, before its turn starts: it reads under the
          // message it was raised for, not above it as if it were about the turn before.
          let at = container.length;
          const sent = Date.parse(event.at);
          if (container === this.root && user.delivery !== "steer") {
            while (at > 0 && Math.abs(sent - (this.loose.get(container[at - 1]!.id) ?? Number.NaN)) < LOOSE_NOTICE_MS) at--;
          }
          if (at === container.length) this.push(container, user);
          else {
            container.splice(at, 0, user);
            this.index.set(id, user);
            this.where.set(id, container);
            if (!this.born.has(id)) this.born.set(id, this.cursor);
          }
          return;
        }
        const item = this.ensure(container, id, () => ({ kind: "assistant", id, text: "", streaming: false, at: event.at }));
        if (item.kind === "assistant") this.replace(container, { ...item, text: p.text, streaming: false, ...attachments });
        return;
      }
      case "reasoning.delta": {
        const rid = `${id}:reasoning`;
        const item = this.ensure(container, rid, () => ({ kind: "reasoning", id: rid, text: "", streaming: true }));
        if (item.kind === "reasoning") this.replace(container, { ...item, text: item.text + event.payload.text });
        return;
      }
      case "tool.started": {
        const p = event.payload;
        const { parts, command } = toolParts(id, p);
 // A patch over several files (Codex), or a move: each file, which the row names and opens (upstream #22541).
        const files = editedFiles(p);
 // The runtime's own tools, in any engine's spelling: "Delegating a child task", , all
        // in plain words (the subject's code face is for paths and commands). An action tool (preview_act,
        // queue, …) reads as the action its input names; the names before the merge still read the same.
        // The desktop tool reads as what it did in which app ("Clicked in Safari"), never as a runtime tool's label.
        const def = isDesktopTool(p.name) ? null : resolveCavemanMcpToolDefinition(p.name, p.input);
        if (def) this.ownTools.set(id, { def, threads: p.threads });
        const own = def ? ownRow(def, 1, p.input, p.threads) : null;
        const line = own ? { verb: own.verb, subject: "" } : lineOf(parts, false);
        // Its own words, its threads and its mark; the run's summary says its done line.
        const ownParts = own ? { parts: own.parts, icon: own.icon, ...(own.threads ? { threads: own.threads } : {}) } : null;
        // Again for a row already showing: an engine that shows a call as it starts sends its input once it is
        // whole. The row takes the command or file it now names and keeps its status, start and output.
        const shown = this.index.get(id);
        if (shown?.kind === "tool") {
          // A running row says it again from the whole input, its `then` included; a settled one keeps its line.
          const { then: _, ...was } = shown;
          this.replace(this.containerOf(id), {
            ...(shown.status === "running" ? { ...was, ...line } : shown),
            parts,
            command,
            ...(p.kind === "web" ? { sources: webStartSources(p.input) } : {}),
            ...(files ? { files } : {}),
            name: p.name,
            input: p.input,
            icon: iconOf(parts),
            ...ownParts,
          });
          return;
        }
        this.ensure(container, id, () => ({
          kind: "tool",
          id,
          ...line,
          parts,
          command,
          ...(p.kind === "web" ? { sources: webStartSources(p.input) } : {}),
          ...(files ? { files } : {}),
          status: "running",
          startedAt: event.at,
          finishedAt: null,
          added: null,
          removed: null,
          output: "",
          name: p.name,
          input: p.input,
          result: null,
          icon: iconOf(parts),
          ...ownParts,
        }));
        return;
      }
      case "tool.output": {
        const item = this.index.get(id);
        if (item?.kind !== "tool") return;
        const output = (item.output + event.payload.text).slice(-OUTPUT_CAP);
        this.replace(this.containerOf(id), { ...item, output });
        return;
      }
      case "tool.done": {
        const item = this.index.get(id);
        if (item?.kind !== "tool") return;
        const p = event.payload;
        const tool = this.ownTools.get(id);
 // A delegated task's card says it all (upstream): its row goes once the card is there.
        const task = tool?.def.summaryAction === "delegate" && p.status === "completed" ? resultTaskId(p.result) : undefined;
        if (task !== undefined && this.delegated.has(task)) {
          this.drop(id);
          return;
        }
        if (task !== undefined) this.delegations.set(task, id);
        // What it made (a new thread) names it from now on; else the threads it named as it started.
        const own = tool ? ownRow(tool.def, p.status === "completed" ? 2 : 0, item.input, p.threads?.length ? p.threads : tool.threads) : null;
        const line = isImageGeneration(item.name) && p.status !== "completed"
          ? { verb: p.status === "declined" ? "Cancelled image generation" : "Image generation failed", subject: "" }
          : own ? { verb: own.verb, subject: "" } : lineOf(item.parts, true);
        const counts = lineCounts(p.result);
        // Settled, its line is the done line alone: what it would go on to do (`then`) is said or not done.
        const { then: _, ...was } = item;
        this.replace(this.containerOf(id), {
          ...was,
          ...line,
          status: p.status === "completed" ? "done" : p.status === "declined" ? "denied" : "failed",
          finishedAt: event.at,
          added: counts?.added ?? item.added,
          removed: counts?.removed ?? item.removed,
          output: p.error ? `${item.output}${item.output ? "\n" : ""}${p.error}` : item.output,
          result: p.result ?? null,
          // A search's sources come with its end; a page read keeps the page it started on unless the engine says where it landed.
          ...(item.sources ? { sources: webDoneSources(item, p.result) } : {}),
          ...(own ? { parts: own.parts, ...(own.threads ? { threads: own.threads } : {}) } : {}),
        });
        return;
      }
      case "plan.updated": {
        // Todos: one list per id, updated where it first showed. Sessions from
        // before grill mode replaced plan mode still hold kind "proposed"; drop those.
        if ((event.payload.kind as string) !== "todos") return;
        const steps = event.payload.steps.map((s) => ({ text: s.text, status: s.status }));
        this.plan = steps;
        const pid = `${id}:plan`;
        if (this.index.get(pid)) this.replace(this.containerOf(pid), { kind: "plan", id: pid, steps });
        else this.push(container, { kind: "plan", id: pid, steps });
        return;
      }
      case "diff.changed":
        this.files = event.payload.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions }));
        this.diffVersion++;
        return;
      case "ask.user": {
        const p = event.payload;
        const option = (o: { id: string; label: string; description?: string; decision?: "allow" | "deny"; preview?: string }) => ({
          id: o.id,
          label: o.label,
          description: o.description ?? null,
          ...(o.decision ? { decision: o.decision } : {}),
          ...(o.preview?.trim() ? { preview: o.preview } : {}),
        });
        if (p.kind === "approval") {
          const tool = p.tool_item_id ? this.index.get(p.tool_item_id) : undefined;
          this.push(container, {
            kind: "ask",
            id,
            askKind: "approval",
            prompt: p.detail && p.detail !== p.title ? `${p.title}\n${p.detail}` : p.title,
            options: p.options.map(option),
            resolution: null,
            questions: [],
            round: null,
            answers: null,
            // A command exactly as it would run, never as its line paraphrases it.
            ...(tool?.kind === "tool" && (tool.command ?? tool.subject) ? { waitsOn: { icon: tool.command !== null ? "run" : tool.icon, subject: tool.command ?? tool.subject } } : {}),
            ...(p.tool_item_id ? { toolItemId: p.tool_item_id } : {}),
            ...(p.reason && p.reason !== p.title && p.reason !== p.detail ? { reason: p.reason } : {}),
            ...(p.full_access_override ? { fullAccessOverride: p.full_access_override } : {}),
 // Its deny takes the person's note, which the agent that asked reads (upstream #23657).
            ...(p.accepts_feedback === true && p.options.some((o) => o.decision === "deny") ? { acceptsFeedback: true as const } : {}),
          });
        } else if (p.kind === "secret") {
          this.push(container, {
            kind: "ask",
            id,
            askKind: "secret",
            prompt: p.reason,
            options: [],
            resolution: null,
            questions: [],
            round: null,
            answers: null,
            secret: { name: p.name, repo: p.repo },
          });
        } else if (p.kind === "tool") {
          this.push(container, {
            kind: "ask",
            id,
            askKind: "tool",
            prompt: p.description ? `${p.name}: ${p.description}` : p.name,
            options: [],
            resolution: null,
            questions: [],
            round: null,
            answers: null,
            tool: { name: p.name, input: JSON.stringify(p.input ?? {}, null, 2) },
          });
        } else {
          const questions: AskQuestion[] = p.questions.map((q) => ({
            id: q.id,
            prompt: q.prompt,
            detail: q.detail || null,
            options: q.options.map(option),
            recommended: q.options.find((o) => o.id === q.recommended)?.id ?? null,
            multiSelect: q.multi_select,
          }));
          this.push(container, {
            kind: "ask",
            id,
            askKind: "question",
            prompt: questions.map((q) => q.prompt).filter(Boolean).join("\n\n"),
            options: questions[0]?.options ?? [],
            resolution: null,
            questions,
            round: p.round ?? null,
            answers: null,
          });
        }
        return;
      }
      case "ask.resolved": {
        const item = this.index.get(id);
        if (item?.kind !== "ask") return;
        const r = event.payload.response;
        const answers =
          event.payload.outcome === "answered" && r?.kind === "question" ? r.answers.map((a) => ({ questionId: a.question_id, optionIds: a.option_ids, text: a.text ?? null })) : null;
        const label = (questionId: string, optionId: string) =>
          (item.questions.find((q) => q.id === questionId)?.options ?? item.options).find((o) => o.id === optionId)?.label ?? optionId;
        const resolution =
          event.payload.outcome !== "answered"
            ? event.payload.outcome
            : r?.kind === "approval"
              ? (item.options.find((o) => o.id === r.option_id)?.label ?? r.option_id)
              : r?.kind === "secret"
                ? r.provided
                  ? "Saved"
                  : "Declined"
              : r?.kind === "tool"
                ? r.is_error
                  ? "Sent as an error"
                  : "Result sent"
              : answers
                ? answers.map((a) => answerText(a, (oid) => label(a.questionId, oid))).join("; ")
                : "answered";
        this.replace(this.containerOf(id), { ...item, resolution, answers });
        return;
      }
      case "subagent.started": {
        const task = event.payload.task_id;
        // Its delegate_task row, already settled: the card takes its place in the transcript, not the end of it.
        const row = task === undefined ? undefined : this.delegations.get(task);
        const at = row === undefined ? -1 : container.findIndex((x) => x.id === row);
        if (task !== undefined) {
          this.delegated.set(task, id);
          if (row !== undefined) this.drop(row);
          this.delegations.delete(task);
        }
        const card: TranscriptItem = {
          kind: "subagent",
          id,
          title: event.payload.title,
          workspaceId: event.payload.workspace_id ?? null,
          agent: event.payload.agent ?? null,
          runner: event.payload.runner ?? null,
          summary: null,
          status: "running",
          startedAt: event.at,
          finishedAt: null,
          items: [],
        };
        this.push(container, card, at);
        return;
      }
      case "subagent.done": {
        const item = this.index.get(id);
        if (item?.kind !== "subagent") return;
        const status = event.payload.status === "completed" ? "done" : event.payload.status === "interrupted" ? "stopped" : "failed";
        this.replace(this.containerOf(id), { ...item, status, summary: event.payload.summary ?? null, finishedAt: event.at });
        return;
      }
      case "turn.done":
        this.running = false;
        this.stopping.clear();
        this.settleStreaming(this.root);
        {
          const taken = event.turn_id ? this.checkpoints.findLast((c) => c.turnId === event.turn_id) : undefined;
          this.push(this.root, { kind: "turn_end", id: `turn_end:${event.cursor}`, outcome: event.payload.status, ...(event.payload.status === "interrupted" && this.lidNote ? { stoppedBy: "sleep" as const } : {}), at: event.at, cursor: event.cursor, ...(taken ? this.turnChanges(taken) : {}) });
          this.lidNote = false;
          if (event.turn_id) this.turnEnds.set(event.turn_id, `turn_end:${event.cursor}`);
        }
        if (event.payload.error) this.push(this.root, { kind: "notice", id: `turn_error:${event.cursor}`, tone: "error", text: event.payload.error });
        return;
      case "session.parked":
        this.running = false;
        this.movedTo = event.payload.reason === "move" ? (event.payload.to ?? null) : null;
        this.parkedNotice = id;
        this.push(this.root, { kind: "notice", id, tone: "info", text: parkedText(event.payload, event.at) });
        return;
      case "session.resumed": {
        // A move this computer started that did not go through: its "Moved to …" line says so instead, and why.
        const failed = event.payload.move_failed;
        const parked = this.parkedNotice;
        this.parkedNotice = null;
        if (failed) {
          const notice = { kind: "notice" as const, tone: "warning" as const, text: `Didn't move: ${failed.replace(/\.$/, "")}. It carries on here.` };
          if (parked && this.index.has(parked)) this.replace(this.root, { ...notice, id: parked });
          else this.push(this.root, { ...notice, id });
        } else if (this.movedTo === null) this.push(this.root, { kind: "notice", id, tone: "info", text: "Session resumed." });
        this.movedTo = null;
        return;
      }
      case "engine.status": {
        const p = event.payload;
        if (p.rate_limit?.limited) {
          const until = resetTime(p.rate_limit.resets_at);
          // The Caveman engine's limits are the person's Caveman plan and credits: it says which, and leads to them.
          const words = p.message?.replace(/\s+/g, " ").trim().slice(0, 300);
          const text = words ? `${words}${until ? ` Resets ${until}.` : ""}` : `Rate limited${until ? ` until ${until}` : ""}.`;
          this.push(this.root, { kind: "notice", id, tone: "warning", text, ...(p.engine === "caveman" ? { action: "account" as const } : {}) });
        } else if (p.message) {
          this.push(this.root, { kind: "notice", id, tone: "info", text: p.message });
        }
        return;
      }
      case "notification": {
        // A Chief's reaction is a badge on the person's message (the messenger's bubble), never a row of its own.
        const moment = event.payload.moment;
        if (moment?.kind === "reaction") {
          if (moment.message_id && moment.emoji) this.react(moment.message_id, moment.emoji, event.cursor);
          return;
        }
        if (event.payload.memory) {
          this.push(container, { kind: "memory", id, action: event.payload.memory.kind, notes: event.payload.memory.notes, at: event.at });
          return;
        }
        if (event.payload.title === LID_NOTE_TITLE) this.lidNote = true;
        const text = event.payload.body ? `${event.payload.title}\n${event.payload.body}` : event.payload.title;
        this.push(container, moment ? { kind: "moment", id, at: event.at, moment, text } : { kind: "notice", id, tone: event.payload.level, text });
        if (!event.turn_id) this.loose.set(id, Date.parse(event.at));
        return;
      }
      case "error": {
        const retry = event.payload.retry;
        if (!retry) {
          this.push(this.root, { kind: "notice", id, tone: "error", text: event.payload.message });
          return;
        }
        // One line per failing call: each attempt updates it.
        const next = { kind: "retry" as const, id, attempt: retry.attempt, max: retry.max_attempts ?? null, message: event.payload.message };
        if (this.index.get(id)?.kind === "retry") this.replace(this.containerOf(id), next);
        else this.push(this.root, next);
        return;
      }
      case "context.updated":
        this.context = { used: event.payload.used_tokens, window: event.payload.window_tokens };
        return;
      case "compaction.started":
        this.ensure(container, id, () => ({ kind: "compaction", id, status: "running", before: null, after: null, at: event.at }));
        return;
      case "compaction.done": {
        const p = event.payload;
        const item = this.ensure(container, id, () => ({ kind: "compaction", id, status: "running", before: null, after: null, at: event.at }));
        if (item.kind === "compaction") {
          this.replace(this.containerOf(id), { ...item, status: p.status === "completed" ? "done" : "failed", before: p.before_tokens ?? null, after: p.after_tokens ?? null, at: event.at });
        }
        return;
      }
      case "voice.call":
        if (event.payload.state === "started") this.callStarts.set(event.payload.call_id, event.cursor);
        this.push(this.root, { kind: "call", id, state: event.payload.state, durationMs: event.payload.duration_ms ?? null, reason: event.payload.reason ?? null, at: event.at });
        return;
      case "voice.turn": {
        const p = event.payload;
        if (p.handoff) {
          // Its note may already be here as a message of the person's, sent during this call: the spoken turn says it once.
          const since = this.callStarts.get(p.call_id) ?? Number.POSITIVE_INFINITY;
          const text = p.handoff.text;
          const note = this.root.findLastIndex((i) => i.kind === "user" && i.text === text && !i.from && !i.scheduled && !i.pending && (this.born.get(i.id) ?? -1) > since);
          if (note >= 0) {
            const [gone] = this.root.splice(note, 1);
            this.index.delete(gone!.id);
            this.where.delete(gone!.id);
            this.born.delete(gone!.id);
          } else this.handedOff.set(p.handoff.item_id, text);
          // Words already shown, handed off a moment later: that turn says so.
          if (p.text === "") {
            const said = this.root.findLastIndex((i) => i.kind === "spoken" && i.role === "person");
            if (said >= 0) this.replace(this.root, { ...(this.root[said] as Extract<Item, { kind: "spoken" }>), handoff: true });
            return;
          }
        }
        if (p.text !== "") this.push(this.root, { kind: "spoken", id, role: p.role, text: p.text, handoff: p.handoff !== undefined, at: event.at });
        return;
      }
      case "model.routed":
        // A line only when the model changes from this thread's (or builder's) last route.
        if (container.findLast((i) => i.kind === "route")?.model === event.payload.model) return;
        this.push(container, { kind: "route", id, model: event.payload.model, at: event.at });
        return;
      case "session.restored": {
        const at = event.payload.at;
        const keep = (list: Item[]): Item[] =>
          list.filter((item) => {
            const live = (this.born.get(item.id) ?? 0) <= at;
            if (!live) {
              this.index.delete(item.id);
              this.born.delete(item.id);
            }
            else if (item.items) item.items = keep(item.items);
            return live;
          });
        this.root = keep(this.root);
        // keep() made new lists: say again where each item sits.
        this.where.clear();
        const note = (list: Item[]) => {
          for (const item of list) {
            this.where.set(item.id, list);
            if (item.items) note(item.items);
          }
        };
        note(this.root);
        this.checkpoints = this.checkpoints.filter((c) => c.cursor <= at);
        if ([...this.reactions.values()].some((all) => all.at(-1)!.cursor > at)) {
          this.reactions = new Map([...this.reactions].flatMap(([message, all]) => {
            const kept = all.filter((r) => r.cursor <= at);
            return kept.length > 0 ? [[message, kept] as const] : [];
          }));
          this.showReactions();
        }
        this.running = false;
        this.lastRun = null;
        this.push(this.root, { kind: "restored", id, branchWorkspaceId: event.payload.branch_workspace_id ?? null });
        return;
      }
      case "goal.updated":
        this.goal = event.payload.objective === null ? null : { objective: event.payload.objective, native: event.payload.native };
        this.push(this.root, { kind: "notice", id, tone: "info", text: event.payload.objective === null ? "Goal cleared." : `Goal: ${event.payload.objective}` });
        return;
      case "queue.updated":
        this.queueVersion++;
        return;
      case "usage":
        // Tokens only; the payload's cost never reaches a view.
        this.tokens += event.payload.input_tokens + event.payload.output_tokens + event.payload.cache_read_tokens + event.payload.cache_write_tokens;
        return;
      case "checkpoint.created": {
        if (this.checkpoints.some((c) => c.id === event.payload.checkpoint_id)) return;
        const taken = { turnId: event.turn_id ?? undefined, id: event.payload.checkpoint_id, cursor: event.cursor, ...(event.payload.files ? { files: event.payload.files } : {}), ...(event.payload.files_total ? { filesTotal: event.payload.files_total } : {}) };
        this.checkpoints.push(taken);
        // The runtime reports it before turn.done; one that comes after still reaches its row.
        const endId = event.turn_id ? this.turnEnds.get(event.turn_id) : undefined;
        const end = endId ? this.index.get(endId) : undefined;
        if (end?.kind === "turn_end" && !end.checkpoint) this.replace(this.root, { ...end, ...this.turnChanges(taken) });
        return;
      }
      case "checkpoint.resolved": {
        this.resolved.set(event.payload.checkpoint_id, event.payload.resolution);
        const taken = this.checkpoints.find((c) => c.id === event.payload.checkpoint_id);
        const endId = taken?.turnId ? this.turnEnds.get(taken.turnId) : undefined;
        const end = endId ? this.index.get(endId) : undefined;
        if (end?.kind === "turn_end") this.replace(this.root, { ...end, resolved: event.payload.resolution });
        return;
      }
    }
  }

  /** A Chief's reaction on the person's message `message`: it takes the place of any earlier one there. */
  private react(message: string, emoji: ChiefReaction, cursor: number): void {
    const all = this.reactions.get(message) ?? [];
    const was = all.at(-1)?.emoji;
    this.reactions.set(message, [...all, { emoji, cursor }]);
    if (was !== emoji) this.showReactions();
  }

  private showReactions(): void {
    this.reacted = new Map([...this.reactions].map(([message, all]) => [message, all.at(-1)!.emoji]));
  }

  /** What a turn_end carries of its checkpoint: the id, the files the turn changed (and their total), and how they were settled. */
  private turnChanges(taken: (typeof this.checkpoints)[number]): Pick<Extract<TranscriptItem, { kind: "turn_end" }>, "checkpoint" | "files" | "filesTotal" | "resolved"> {
    const resolved = this.resolved.get(taken.id);
    return { checkpoint: taken.id, ...(taken.files ? { files: taken.files } : {}), ...(taken.filesTotal ? { filesTotal: taken.filesTotal } : {}), ...(resolved ? { resolved } : {}) };
  }

  /**
   * The person's message as it is sent, before turn.submit answers: the transcript shows it at once. `id` is the
   * runtime's id for it (submittedMessageId), so its message.done takes this row's place.
   */
  echo(id: string, text: string): void {
    if (this.index.has(id)) return;
    // The follow-up Continue sends after a sleep stop reads as its quiet row from the start, not as a long bubble.
    const generated = generatedOf({ text });
    this.push(this.root, { kind: "user", id, text, at: new Date().toISOString(), delivery: "message", pending: true, ...(generated ? { generated } : {}) });
    this.cached = null;
  }

  /**
   * A send queued in Caveman Cloud for a computer this device could not reach (state/sync/hub.ts): shown as the person's
   * message, dimmed, with `status` under it (null: no longer queued). Its message.done replaces it like any echo, so
   * it never shows twice. Nothing for an id the transcript already holds as the runtime's.
   */
  queued(id: string, text: string, status: string | null): boolean {
    const known = this.index.get(id);
    if (known && (known.kind !== "user" || !known.pending)) return false;
    if (!known) {
      if (status === null) return false;
      this.push(this.root, { kind: "user", id, text, at: new Date().toISOString(), delivery: "message", pending: true, queued: status });
    } else if ((known as { queued?: string }).queued === (status ?? undefined)) return false;
    else {
      const next: Item = { ...known };
      if (status === null) delete (next as { queued?: string }).queued;
      else (next as { queued?: string }).queued = status;
      this.replace(this.containerOf(id), next);
    }
    this.cached = null;
    return true;
  }

  /**
   * A stop this device just sent (request id `id`): the running turn says it is stopping at once, until its turn.done
   * (which settles every stop) or the stop is refused (unstop).
   */
  stop(id: string): void {
    if (!this.running || this.stopping.has(id)) return;
    this.stopping.add(id);
    this.cached = null;
  }

  unstop(id: string): void {
    if (this.stopping.delete(id)) this.cached = null;
  }

  /** A send that failed, or went to the queue instead: its echo goes. */
  unecho(id: string): void {
    const item = this.index.get(id);
    if (item?.kind !== "user" || !item.pending) return;
    this.drop(id);
  }

  /** An item another one took the place of: gone from its list. */
  private drop(id: string): void {
    const item = this.index.get(id);
    if (item === undefined) return;
    const list = this.containerOf(id);
    list.splice(list.indexOf(item), 1);
    this.index.delete(id);
    this.where.delete(id);
    this.born.delete(id);
    this.cached = null;
  }

  snapshot(): SessionView {
    if (this.cached) return this.cached;
    const pendingAsk = findPendingAsk(this.root);
    const items = this.root.map(freeze);
    this.cached = {
      items,
      running: this.running,
      ...(this.running && this.stopping.size > 0 ? { stopping: true } : {}),
      plan: this.plan,
      pendingAsk,
      changedFiles: this.files.length,
      agentFiles: this.files.filter((f) => f.status !== "deleted" && AGENT_FILE.test(f.path)).map((f) => f.path),
      diffVersion: this.diffVersion,
      queueVersion: this.queueVersion,
      cursor: this.cursor,
      artifacts: (this.artifacts = extractArtifacts(items, this.artifacts)),
      context: this.context,
      tokens: this.tokens,
      goal: this.goal,
      forkedAt: this.forkedAt,
      mode: this.mode,
      ...(this.access ? { access: this.access } : {}),
      turn: this.turn,
      ...(this.running && this.turnModel ? { turnModel: this.turnModel } : {}),
      checkpoints: this.checkpoints.map((c) => ({ id: c.id, own: c.cursor > this.forkedAt })),
      movedTo: this.movedTo,
      movedFrom: this.movedFrom,
      reactions: this.reacted,
    };
    return this.cached;
  }

  /**
   * A turn starting on another model or effort than the last: a switch item before the message that opened it (the
   * person's last message since the last turn ended), else at the end. The first turn, or one on the same, adds none.
   */
  private switched(id: string, run: TurnRun): void {
    const from = this.lastRun;
    this.lastRun = run;
    if (!from || (from.engine === run.engine && from.model === run.model && from.effort === run.effort)) return;
    const item: Item = { kind: "switch", id: `switch:${id}`, from, to: run };
    if (this.index.has(item.id)) return;
    const end = this.root.findLastIndex((i) => i.kind === "turn_end" || i.kind === "restored");
    const opened = this.root.findLastIndex((i, at) => at > end && i.kind === "user" && i.delivery !== "steer");
    if (opened < 0) return this.push(this.root, item);
    this.root.splice(opened, 0, item);
    this.index.set(item.id, item);
    this.where.set(item.id, this.root);
    this.born.set(item.id, this.cursor);
  }

  private containerFor(parentItemId: string | undefined): Item[] {
    if (!parentItemId) return this.root;
    const parent = this.index.get(parentItemId);
    return parent?.kind === "subagent" && parent.items ? parent.items : this.root;
  }

  /** A message with these words is the one a spoken note is waiting for: that note no longer waits. */
  private noteSaid(text: string): boolean {
    for (const [item, said] of this.handedOff) {
      if (said !== text) continue;
      this.handedOff.delete(item);
      return true;
    }
    return false;
  }

  private containerOf(id: string): Item[] {
    return this.where.get(id) ?? this.root;
  }

  private ensure(container: Item[], id: string, make: () => TranscriptItem): Item {
    const existing = this.index.get(id);
    if (existing) return existing;
    const item = make() as Item;
    this.push(container, item);
    return item;
  }

  /** Adds an item at the end of its list, or at `at` (a card in the place of the row it replaces). */
  private push(container: Item[], item: TranscriptItem, at = -1): void {
    // Only the engine's side gets a speaker identity; user messages and standalone markers do not.
    const attributed = item.kind !== "user" && item.kind !== "switch" && item.kind !== "notice" && item.kind !== "memory" && item.kind !== "restored" && item.kind !== "grill_finished";
    const model = attributed ? this.turnModel : undefined;
    const it = (attributed && this.engine ? { ...item, engine: this.engine, ...(model ? { turnModel: model } : {}) } : item) as Item;
    // The protocol has no reasoning.done: a thought is over once the next item lands beside it (not before it).
    const prev = at >= 0 ? undefined : container.at(-1);
    if (prev?.kind === "reasoning" && prev.streaming) this.replace(container, { ...prev, streaming: false });
    if (it.kind === "subagent" && !it.items) it.items = [];
    if (at >= 0) container.splice(at, 0, it);
    else container.push(it);
    this.index.set(it.id, it);
    this.where.set(it.id, container);
    if (!this.born.has(it.id)) this.born.set(it.id, this.cursor);
  }

  private replace(container: Item[], next: TranscriptItem): void {
    // From the end: what changes is nearly always the newest row (a streaming answer, a running tool).
    const i = container.findLastIndex((x) => x.id === next.id);
    const prev = this.index.get(next.id);
    const it = { ...(next as Item), ...(prev?.engine ? { engine: prev.engine } : {}), ...(prev?.turnModel ? { turnModel: prev.turnModel } : {}), ...(prev?.items ? { items: prev.items } : {}) } as Item;
    if (i >= 0) container[i] = it;
    this.index.set(it.id, it);
  }

  private settleStreaming(list: Item[]): void {
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      if ((item.kind === "assistant" || item.kind === "reasoning") && item.streaming) this.replace(list, { ...item, streaming: false });
      // A turn that ended mid-compaction (interrupted) never finished it.
      if (item.kind === "compaction" && item.status === "running") this.replace(list, { ...item, status: "failed" });
      if (item.items) this.settleStreaming(item.items);
    }
  }
}

/**
 * One of the runtime's own tools as its row says it. A tool on other threads names them by title ("Sent to Fix
 * login"; a new thread or a delegated task by its input's title until the runtime names it), opens to what it said
 * there and wears the agent mark; a preview tool wears the browser's. Any other reads as its words ("Listed
 * scheduled tasks"). `phase` picks the verb: 0 a call that did not go through, 1 running, 2 done. Its one part is
 * its done line (or what it tried, for one that did not go through), which a run's summary says.
 */
function ownRow(def: CavemanMcpToolDefinition, phase: 0 | 1 | 2, input: unknown, named: ReadonlyArray<ToolThread> | undefined) {
  const threads = def.named ? threadNotes(def, input, named) : [];
  const titles = threads.flatMap((n) => (n.thread ? [n.thread.title] : []));
  const say = (at: 0 | 1 | 2) => (def.named && titles.length > 0 ? `${def.named[at]} ${titleList(titles)}` : `${def.labels[at]} ${def.labels[3]}`);
  const icon: ToolItem["icon"] = def.named ? "agent" : def.icon === "browser" ? "browser" : "mcp";
  // A call that did not go through says so in the summary too: "tried to send to Fix checkout", never "sent".
  const action = say(0);
  const parts: ToolPart[] = [{ action: "caveman", subject: phase === 0 ? `Tried to ${action.charAt(0).toLowerCase()}${action.slice(1)}` : say(2) }];
  return { verb: say(phase), parts, icon, ...(threads.length > 0 ? { threads } : {}) };
}

/** "Fix login", "Fix login and Fix checkout", "3 threads". */
const titleList = (titles: ReadonlyArray<string>): string => (titles.length > 2 ? `${titles.length} threads` : titles.join(" and "));

/**
 * The threads one of the runtime's own tools named, each with what it said there: create_threads' new threads with
 * their own first prompts, in the order it asked for them; else its one thread (the runtime's name for it, or a new
 * thread's or a delegated task's title from its input) with its message or task.
 */
function threadNotes(def: CavemanMcpToolDefinition, input: unknown, named: ReadonlyArray<ToolThread> | undefined): ThreadNote[] {
  const i = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  if (Array.isArray(i.threads)) {
    const asked = i.threads.map((t: unknown) => (t !== null && typeof t === "object" ? (t as Record<string, unknown>) : {}));
    const made = named !== undefined && named.length === asked.length ? named : undefined;
    return asked.map((t, k) => {
      const title = text(t.title);
      return { thread: made?.[k] ?? (title === null ? null : { title }), text: text(t.prompt) };
    });
  }
  const said = text(i.message) ?? text(i.task);
  const title = def.summaryAction === "thread-create" || def.summaryAction === "delegate" ? text(i.title) : null;
  const threads = named !== undefined && named.length > 0 ? named : title === null ? [] : [{ title }];
  if (threads.length === 0) return said === null ? [] : [{ thread: null, text: said }];
  return threads.map((thread, k) => ({ thread, text: k === 0 ? said : null }));
}

/** The task a delegate_task call returned: its result's `taskId`, inside whatever MCP envelope the engine kept. */
const resultTaskId = (result: unknown): string | undefined => compactDynamicToolOutput(result)?.taskId;

/**
 * What a tool call did and, for a shell command, the command: the kind the runtime sent, refined where the call
 * says more (a command read step by step, Write creating a file, a web call fetching an address or searching).
 */
function toolParts(id: string, p: { readonly name: string; readonly title: string; readonly kind: string; readonly input: unknown }): { parts: ToolPart[]; command: string | null } {
  const input = p.input !== null && typeof p.input === "object" ? (p.input as Record<string, unknown>) : {};
  if (isImageGeneration(p.name)) return { parts: [{ action: "image_generation", subject: "" }], command: null };
  if (id.startsWith("worktree:") && p.name === "worktree") return { parts: [{ action: "worktree", subject: worktreeBranch(p.input) ?? p.title }], command: null };
  if (isDesktopTool(p.name)) return { parts: [readDesktop(p.input)], command: null };
  const subject = toolSubject(p.name, p.title, p.input);
  if (p.name === "view_image") return { parts: [{ action: "image_view", subject }], command: null };
  // The Caveman engine's bash on a command it left running: its subject is that command.
  const bash = p.name === "bash" && typeof input.action === "string" ? `bash:${input.action}` : "";
  if (isAction(bash)) return { parts: [{ action: bash, subject }], command: subject || null };
  if (p.kind === "command") {
    const command = typeof input.command === "string" && input.command.trim() ? input.command : p.title;
    return { parts: readCommand(command), command };
  }
  const files = editedFiles(p);
  if (files) return { parts: files.map(editPart), command: null };
  if (p.kind === "edit" && isCreateTool(p.name)) return { parts: [{ action: "create", subject }], command: null };
  // A page read (the runtime's web_fetch, titled by its site, its address in the input) says the site; a search, its query.
  if (p.kind === "web") {
    const url = webUrl(input.url) ?? webUrl(subject);
    if (url !== null || p.name === "web_fetch") return { parts: [{ action: "web", subject: url === null ? subject : siteOf(url) }], command: null };
    // A search says its query; one that never said it (an ACP agent's, titled by its label) searched the web.
    const query = Array.isArray(input.queries) && typeof input.queries[0] === "string" ? input.queries[0].trim() : subject;
    return { parts: [{ action: "web_search", subject: /^web search$/i.test(query) ? "" : query }], command: null };
  }
  return { parts: [{ action: isAction(p.kind) ? p.kind : "other", subject }], command: null };
}

/** A multi-file edit's files (tool.started `files`), or undefined for any other call. */
function editedFiles(p: { readonly kind: string; readonly files?: ReadonlyArray<{ readonly path: string; readonly old_path?: string; readonly status: EditedFile["status"] }> }): EditedFile[] | undefined {
  if (p.kind !== "edit" || !p.files || p.files.length === 0) return undefined;
  return p.files.map((f) => ({ path: f.path, oldPath: f.old_path ?? null, status: f.status }));
}

/** What a patch did to one file, as a line says it: created, deleted, moved (from → to) or edited. */
function editPart(file: EditedFile): ToolPart {
  if (file.status === "added") return { action: "create", subject: file.path };
  if (file.status === "deleted") return { action: "delete", subject: file.path };
  if (file.status === "renamed" && file.oldPath !== null) return { action: "move", subject: `${file.oldPath} → ${file.path}` };
  return { action: "edit", subject: file.path };
}

/** The runtime's own tool names, whose titles are the subject already (a command line, a path, a pattern). */
const PLAIN_TITLES = new Set(["command", "edit", "search", "web_search"]);

/**
 * What a tool line names after its verb: the runtime's title without the tool's own name in front
 * (Claude's Read arrives titled "Read /path", which read "Read Read /path"), else the file, pattern,
 * command or address the call took when the title is only the name.
 */
export function toolSubject(name: string, title: string, input: unknown): string {
  const t = title.trim();
  const rest = !PLAIN_TITLES.has(name) && name !== "" && t.startsWith(`${name} `) ? t.slice(name.length + 1).trim() : t;
  if (rest !== "" && rest !== name) return rest;
  const i = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const key of ["file_path", "path", "filePath", "notebook_path", "pattern", "command", "url", "query"]) {
    const v = i[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return rest;
}

/** The branch a new chat's worktree row names (its input: path, branch, base_ref). */
function worktreeBranch(input: unknown): string | undefined {
  const branch = input !== null && typeof input === "object" ? (input as { branch?: unknown }).branch : undefined;
  return typeof branch === "string" && branch !== "" ? branch : undefined;
}

function freeze(item: Item): TranscriptItem {
  if (item.kind === "subagent") return { ...item, items: (item.items ?? []).map(freeze) } as TranscriptItem;
  return item as TranscriptItem;
}

function findPendingAsk(list: ReadonlyArray<Item>): Extract<TranscriptItem, { kind: "ask" }> | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]!;
    if (item.kind === "ask" && item.resolution === null) return item as Extract<TranscriptItem, { kind: "ask" }>;
    if (item.items) {
      const nested = findPendingAsk(item.items);
      if (nested) return nested;
    }
  }
  return null;
}

/** A web row's first sources: the page a read opens (its address), none yet for a search. Marks the row as a web row. */
function webStartSources(input: unknown): WebSource[] {
  const url = webUrl(input !== null && typeof input === "object" ? (input as { url?: unknown }).url : undefined);
  return url === null ? [] : [{ title: null, url }];
}

/** A web row's sources once done: a search's results, or the page a read landed on (only one), else what it had. */
function webDoneSources(item: ToolItem, result: unknown): ReadonlyArray<WebSource> {
  const found = webSources(result).slice(0, item.parts[0]?.action === "web" ? 1 : undefined);
  return found.length > 0 ? found : (item.sources ?? []);
}

/** An http(s) address, trimmed, or null: the only links a web row opens. */
function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  try {
    return new URL(url).host === "" ? null : url;
  } catch {
    return null;
  }
}

/** The site a page is on: its host, without a leading www. */
export const siteOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./i, "");
  } catch {
    return url;
  }
};

/** A web row's result as sources: each http(s) address once, with its title. Older sessions also carry page text and other links; both stay out. */
function webSources(result: unknown): WebSource[] {
  if (!Array.isArray(result)) return [];
  const seen = new Set<string>();
  return result.flatMap((r) => {
    const fields = r !== null && typeof r === "object" ? (r as { url?: unknown; title?: unknown }) : {};
    const url = webUrl(fields.url);
    if (url === null || seen.has(url)) return [];
    seen.add(url);
    const title = typeof fields.title === "string" && fields.title.trim() !== "" ? fields.title.trim() : null;
    return [{ title, url }];
  });
}

function lineCounts(result: unknown): { added: number | null; removed: number | null } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const added = typeof r.additions === "number" ? r.additions : null;
  const removed = typeof r.deletions === "number" ? r.deletions : null;
  return added === null && removed === null ? null : { added, removed };
}

type Parked = Extract<SessionEvent, { type: "session.parked" }>["payload"];

function parkedText({ reason, to, cause, name }: Parked, at: string): string {
  switch (reason) {
    case "move": {
      // Moves: one line where the chat went and why; another of the person's Macs by its name.
      const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      if (to === "this_mac") return `Moved to ${name || THIS_COMPUTER} at ${time}.`;
      if (to !== "cloud") return "Parked to move to another computer.";
      if (cause === "lid") return `Moved to Cloud when the lid closed at ${time}.`;
      if (cause === "asleep") return `Moved to Cloud at ${time} while ${THIS_COMPUTER} slept.`;
      return `Moved to Cloud at ${time}.`;
    }
    case "suspend":
      return "Parked: the computer is suspended.";
    case "handoff":
      return "Handed off.";
    case "user":
      return "Parked.";
  }
}
