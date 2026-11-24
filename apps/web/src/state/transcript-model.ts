// What a session's transcript renders. Built from Session Protocol v1 events
// by state/transcript.ts. Usage events never become items: spend lives in
// Settings, never in a session.

import type { HtmlRenderReference } from "@caveman-app/shared/htmlRender";
import type { AccessMode, ChiefMoment, ToolThread, TurnFile, TurnFilesTotal } from "@caveman-app/session-protocol";
import type { WireRunner } from "./runner.ts";
import type { SessionMode } from "./grill.ts";
import type { ToolPart } from "./tool-actions.ts";
import type { GeneratedView } from "./generated.ts";

export type ToolStatus = "running" | "done" | "failed" | "denied";

/** The harness and model this item ran on, from turn.started (also during replay). Older fixtures may omit them. */
interface TurnAttribution {
  readonly engine?: string;
 /** The model id the turn started on ("claude-opus-5-5", "external tools/x-ai/grok-4.7"): the turn's "worked for" line names it. */
  readonly turnModel?: string;
}

/** What a turn ran on, from its turn.started: the harness, the model id and its effort (null where none was named). */
export interface TurnRun {
  readonly engine: string;
  readonly model: string;
  readonly effort: string | null;
}

export interface ToolItem extends TurnAttribution {
  readonly kind: "tool";
  readonly id: string;
  /** Verb in the past tense once done ("Read", "Edited", "Ran"), present while running; a command that did several things says them all ("Read a.ts, searched for retry"). */
  readonly verb: string;
  /** The subject in mono: a path, a command, a query; "" when the verb says it all. */
  readonly subject: string;
  /** While it runs or waits, what else the call does after its subject, in words ("running tests"). */
  readonly then?: string;
  /** What the call did, one part per thing (a shell command can read, search and test): the summary of a run counts these. */
  readonly parts: ReadonlyArray<ToolPart>;
  /** A shell command as the engine ran it, which its line opens to and an approval shows; null for any other tool. */
  readonly command: string | null;
  readonly status: ToolStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly added: number | null;
  readonly removed: number | null;
  readonly output: string;
  /** The engine's tool name ("Edit", "Write", "bash") and raw input/result: artifact extraction reads them. */
  readonly name: string;
  readonly input: unknown;
  readonly result: unknown;
  readonly icon: "search" | "read" | "edit" | "create" | "run" | "web" | "mcp" | "browser" | "agent" | "other";
  /** A web search's sources once it is done, or the page a read is on: what the row opens to. Only on web rows. */
  readonly sources?: ReadonlyArray<WebSource>;
  /** An edit that changed several files at once (a Codex patch), or moved one: each file, which the row opens to. */
  readonly files?: ReadonlyArray<EditedFile>;
  /**
   * One of the runtime's own tools on other threads (thread_send, thread_read, thread_launch, …): each thread it names
   * and what it said there, which the row opens to.
   */
  readonly threads?: ReadonlyArray<ThreadNote>;
}

/**
 * A thread one of the runtime's own tools named, and its words there: thread_send's message, a new thread's first
 * prompt, a delegated task. `thread` is null when the runtime did not know it; `text` null for a call that said nothing.
 */
export interface ThreadNote {
  readonly thread: ToolThread | null;
  readonly text: string | null;
}

/** One file of a multi-file edit (tool.started `files`): where it is now, where it was before a move, what happened. */
export interface EditedFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: "added" | "modified" | "deleted" | "renamed";
}

/** A page on the web, by its http(s) address and the title the engine gave it. */
export interface WebSource {
  readonly title: string | null;
  readonly url: string;
}

export interface PlanStep {
  readonly text: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface AskOptionView {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  /** An approval's option: whether it lets the step run. */
  readonly decision?: "allow" | "deny";
  /** A question's option: what it looks like, to compare the options by (a mockup, a snippet), as plain text. */
  readonly preview?: string;
}

/** One question of an ask. A grill round holds several, each with the engine's recommended option. */
export interface AskQuestion {
  readonly id: string;
  /** The question's title. */
  readonly prompt: string;
  /** Markdown under the title. */
  readonly detail: string | null;
  readonly options: ReadonlyArray<AskOptionView>;
  readonly recommended: string | null;
  /** The options are not exclusive: the user may pick several. */
  readonly multiSelect: boolean;
}

/** How one question was answered: its options, the user's own words, or both. */
export interface AskAnswer {
  readonly questionId: string;
  readonly optionIds: ReadonlyArray<string>;
  readonly text: string | null;
}

export interface AttachmentView {
  readonly type: "image" | "file";
  readonly name: string;
  readonly mime_type: string;
  readonly data: string;
  /** A stored image too large for `data` (empty): read by this id (attachment.read). */
  readonly id?: string;
}

/** An image src for a stored attachment that came by id, not bytes: media.ts reads it with attachment.read. */
export const ATTACHMENT_SRC = "caveman-attachment:";
export const attachmentSrc = (id: string) => `${ATTACHMENT_SRC}${id}`;

export type TranscriptItem = TurnAttribution & (
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly at: string;
      readonly delivery: "message" | "steer" | "followup" | "queue";
      readonly attachments?: ReadonlyArray<AttachmentView>;
      /** Shown as it was sent, before the runtime's message.done (which takes its place, same id). */
      readonly pending?: true;
      /** Pending and queued in Caveman Cloud for a computer that is asleep or out of reach: its one status line. */
      readonly queued?: string;
      /**
       * Another thread's agent wrote it, not the person. No workspace_id: a thread with no workspace to open (a delegated child).
       * `agent`: an outside agent wrote it through `caveman-code mcp`, and `title` is its name.
       */
      readonly from?: { readonly workspace_id?: string; readonly title: string; readonly agent?: true };
      /** A scheduled task sent it on its schedule, not the person typing it; its title while the task is known. */
      readonly scheduled?: { readonly taskId: string; readonly title: string | null };
      /**
       * The runtime wrote it for the agent (message.done `generated`, or a bracket line of older history): drawn as
       * one quiet row of the chat, or a lead's builders' result row, never as the person's bubble or its text.
       */
      readonly generated?: GeneratedView;
    }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string; readonly streaming: boolean; readonly at: string; readonly attachments?: ReadonlyArray<AttachmentView> }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string; readonly streaming: boolean }
  | ToolItem
  /** The engine's todos (plan.updated), updated in place. */
  | { readonly kind: "plan"; readonly id: string; readonly steps: ReadonlyArray<PlanStep> }
  | {
      readonly kind: "ask";
      readonly id: string;
      readonly askKind: "question" | "approval" | "secret" | "tool";
      /** askKind "secret": the variable the agent needs and the repository that stores it. */
      readonly secret?: { readonly name: string; readonly repo: { readonly path: string } | { readonly url: string } };
      /** askKind "tool": the custom tool the agent called and its input, whose result the person writes back. */
      readonly tool?: { readonly name: string; readonly input: string };
      /** An approval's tool call (tool_item_id): what Allow lets run or change, a command exactly as it would run. */
      readonly waitsOn?: { readonly icon: ToolItem["icon"]; readonly subject: string };
      /** An approval's tool call by id: the step it holds, which waits on the person instead of working until answered. */
      readonly toolItemId?: string;
      /** An approval: why the engine asks, in its own words, when that adds to the prompt. */
      readonly reason?: string;
      /** An approval in full access: why it reached the person anyway (an ask rule, or the engine's own check). */
      readonly fullAccessOverride?: "ask_rule" | "engine_check";
      /** An approval whose deny can carry a note to the agent that asked (Claude Agent's): the card offers one. */
      readonly acceptsFeedback?: true;
      readonly prompt: string;
      /** An approval's options, or the first question's. */
      readonly options: ReadonlyArray<AskOptionView>;
      readonly resolution: string | null;
      /** Every question (none for approvals); one ask.respond answers them all. */
      readonly questions: ReadonlyArray<AskQuestion>;
      /** Grill mode: the round, from 1. Null for any other ask. */
      readonly round: number | null;
      /** Each question's answer once answered; null until then, and when cancelled or expired. */
      readonly answers: ReadonlyArray<AskAnswer> | null;
    }
  /** grill.finished: the decisions doc is written; the user can build from it. */
  | { readonly kind: "grill_finished"; readonly id: string; readonly docPath: string; readonly summary: string }
  | {
      readonly kind: "subagent";
      readonly id: string;
      readonly title: string;
      /** A delegated agent's own workspace (its transcript, asks and diff); null for an engine's native subagent. */
      readonly workspaceId: string | null;
      /** The engine it runs on. */
      readonly agent: string | null;
      /** Who runs it (SubagentRunner): harness, login, model, effort and how it was picked; null from runtimes that send none. */
      readonly runner: WireRunner | null;
      /** Its result once done. */
      readonly summary: string | null;
      /** `stopped`: cut off (a Stop, or a cancel) rather than failed. */
      readonly status: "running" | "done" | "failed" | "stopped";
      readonly startedAt: string;
      readonly finishedAt: string | null;
      readonly items: ReadonlyArray<TranscriptItem>;
    }
  /** A state line; `action: "account"` leads to Settings > Account (a Caveman plan or credits limit). */
  | { readonly kind: "notice"; readonly id: string; readonly tone: "info" | "warning" | "error"; readonly text: string; readonly action?: "account" }
  /**
   * A moment of a chat on a Chief's board (notification.moment), which the Chief's screen draws as its card. `text`:
   * the notification's own line, what any other screen shows of it, as a notice.
   */
  | { readonly kind: "moment"; readonly id: string; readonly at: string; readonly moment: ChiefMoment; readonly text: string }
  /** A memory change or recall (notification.memory): what the person said to keep, an agent's draft, or notes pushed to the agent. */
  | {
      readonly kind: "memory";
      readonly id: string;
      readonly action: "remembered" | "saved" | "recalled";
      readonly notes: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      readonly at: string;
    }
  /** The engine shrinking its context; tokens before and after once known. */
  | { readonly kind: "compaction"; readonly id: string; readonly status: "running" | "done" | "failed"; readonly before: number | null; readonly after: number | null; readonly at: string }
  /**
   * The person moved the chat to another model or effort between turns: a divider before the message that runs on
   * it ("Opus 5.5 Extra High → Sonnet 5.5 Medium"). Each side is what its turn.started named.
   */
  | { readonly kind: "switch"; readonly id: string; readonly from: TurnRun; readonly to: TurnRun }
  /** The router moved the engine to another model (only shown when the model changes). */
  | { readonly kind: "route"; readonly id: string; readonly model: string; readonly at: string }
  /** A call with the Chief started or ended (voice.call). */
  | { readonly kind: "call"; readonly id: string; readonly state: "started" | "ended"; readonly durationMs: number | null; readonly reason: string | null; readonly at: string }
  /**
   * A turn of a call (voice.turn): what the person said, or the voice. `handoff`: the person's words went to the
   * Chief as their note (whose own message then never shows a second time).
   */
  | { readonly kind: "spoken"; readonly id: string; readonly role: "person" | "voice"; readonly text: string; readonly handoff: boolean; readonly at: string }
  /** The engine retrying a failed call; the turn goes on. */
  | { readonly kind: "retry"; readonly id: string; readonly attempt: number; readonly max: number | null; readonly message: string }
  | {
      readonly kind: "turn_end";
      readonly id: string;
      readonly outcome: "completed" | "interrupted" | "failed";
      /** The runtime stopped the turn because the computer slept or the lid closed (its "Paused when the lid closed" note, just before the stop). */
      readonly stoppedBy?: "sleep";
      readonly at: string;
      /** The turn.done's cursor: session.restore and session.fork start there. */
      readonly cursor: number;
      /** The checkpoint the runtime took as the turn ended (checkpoint.created): the Changes tab diffs one turn from it. */
      readonly checkpoint?: string;
      /** What the turn itself changed, with line counts (checkpoint.created); absent from checkpoints recorded before. */
      readonly files?: ReadonlyArray<TurnFile>;
      /** Every file the turn changed, when `files` is only its first 200 (a vendored or generated tree). */
      readonly filesTotal?: TurnFilesTotal;
      /** The turn's changes were kept or undone (checkpoint.resolved): its Changes card is closed. */
      readonly resolved?: "kept" | "undone";
    }
  /** session.restored: the later turns were dropped here; they live on in the branch workspace. */
  | { readonly kind: "restored"; readonly id: string; readonly branchWorkspaceId: string | null }
);

export interface SessionView {
  readonly items: ReadonlyArray<TranscriptItem>;
  readonly running: boolean;
  /** A stop this device sent is on its way (optimistic, S14): the turn shows as stopping until it ends. */
  readonly stopping?: boolean;
  readonly plan: ReadonlyArray<PlanStep>;
  readonly pendingAsk: Extract<TranscriptItem, { kind: "ask" }> | null;
  readonly changedFiles: number;
  /** Agent files (`.caveman/agents/*.md`) this chat added or changed: what the composer offers to publish to Cloud. */
  readonly agentFiles?: ReadonlyArray<string>;
  /** Bumps on every diff.changed, so the Changes tab reloads only then. */
  readonly diffVersion: number;
  /** Bumps on every queue.updated (any client changed the queue), so the queue strip re-reads. */
  readonly queueVersion: number;
  readonly cursor: number;
  /** Everything the transcript produced that opens in the side panel, in transcript order. */
  readonly artifacts: ReadonlyArray<Artifact>;
  /** The engine's context window use (context.updated); null until the engine reports it. */
  readonly context: { readonly used: number; readonly window: number } | null;
  /** Tokens the session's usage events counted (input, output, cache): tokens only, never a price. */
  readonly tokens: number;
  /** The session goal (goal.updated); null when none. */
  readonly goal: { readonly objective: string; readonly native: boolean } | null;
  /** A fork's last copied cursor (Session.forked_from): those turns ran in its source and restore only there. 0 otherwise. */
  readonly forkedAt: number;
  /** Grill mode is sticky per session; the composer starts from it. */
  readonly mode: SessionMode;
  /** The session's permissions; the composer's chip shows them. */
  readonly access?: AccessMode;
  /** The model, effort and login the latest turn started on (turn.started), for who-runs-it marks; null until one names a model. */
  readonly turn: { readonly model: string; readonly effort: string | null; readonly speed?: string; readonly account_id?: string } | null;
  /** The running turn's own model, as its turn.started named it; absent while none runs or when it named none (Auto). */
  readonly turnModel?: string;
  /**
   * Each finished turn's checkpoint (checkpoint.created), oldest first. `own`: taken in this session; a fork's copied
   * turns name checkpoints of the chat it came from, which this session's fs.diff can't read.
   */
  readonly checkpoints: ReadonlyArray<{ readonly id: string; readonly own: boolean }>;
  /** Moves: where the chat went when it last moved away from this computer; null while it is here. */
  readonly movedTo: "cloud" | "this_mac" | null;
  /** Moves: the runtime it moved here from (Session.moved_from); Continue on This Mac sends it back. */
  readonly movedFrom: string | null;
  /**
   * A Chief's reactions (a `reaction` moment), by the person's message they answer (its message.done item id): the
   * latest per message. No row of their own; the messenger draws each as a badge on that bubble.
   */
  readonly reactions: ReadonlyMap<string, ChiefReaction>;
}

/** What a Chief can react to the person's note with, in place of words. */
export type ChiefReaction = NonNullable<ChiefMoment["emoji"]>;

// ------------------------------------------------------------------ artifacts

interface ArtifactBase {
  /** Stable across snapshots: `<itemId>:<kind>[:<line>]`. */
  readonly id: string;
  /** The transcript item that holds it (scroll target). */
  readonly itemId: string;
  /** File name, language, command, PR number. */
  readonly title: string;
  /** One grey line: "48 lines", "+38 -12", "4 columns, 5 rows". */
  readonly meta: string;
}

export type Artifact = ArtifactBase &
  (
    | { readonly kind: "code"; readonly language: string | null; readonly code: string; readonly line: number }
    | { readonly kind: "table"; readonly header: ReadonlyArray<string>; readonly rows: ReadonlyArray<ReadonlyArray<string>>; readonly line: number }
    | { readonly kind: "image"; readonly src: string; readonly alt: string; readonly line: number | null }
    | { readonly kind: "browser"; readonly src: string; readonly alt: string }
    | { readonly kind: "pr"; readonly url: string; readonly repo: string; readonly number: number }
    | {
        readonly kind: "file";
        readonly path: string;
        readonly change: "edited" | "created";
        readonly added: number | null;
        readonly removed: number | null;
        /** Unified-style lines (" ", "+", "-", "@@") when the tool call carried them. */
        readonly diff: string | null;
        readonly status: ToolStatus;
      }
    | { readonly kind: "terminal"; readonly command: string; readonly output: string; readonly status: ToolStatus }
    /** A page an agent showed with `html_render`, by the runtime's reference to it. */
    | { readonly kind: "page"; readonly page: HtmlRenderReference }
  );

export type ArtifactKind = Artifact["kind"];
