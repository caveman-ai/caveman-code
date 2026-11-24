// A chat's transcript as the phone shows it, built from the runtime's own events (Session Protocol SessionEvent, in
// cursor order): your messages, the engine's words as they stream, its tool calls folded into work groups, what it
// asks, where you stopped it. The phone's transcript is the board's (board/model.ts Item); this file makes the kinds a
// runtime's chat has, in shapes of its own so it has no import from the app and runs in the runtime's tests too.
// Where they meet the board (link.ts) the compiler checks they are the board's.
//
// Not shown, by rule or because the phone has no place for it yet: usage and cost (never in a session), reasoning
// (it only says "Thinking"), todos, context and compaction, a subagent's own nested events (its line in the work
// group stands for it), the chat's worktree being made (unless that fails), and a turn's changes (the review is the
// next data source, not this one).
import type { Params, SessionEvent } from "@caveman-app/session-protocol";

import { generatedLine } from "./builders.ts";

export type LiveStep = { tool: "search" | "read" | "edit" | "run"; text: string; detail?: string };

export type LiveItem =
  | {
      kind: "you";
      id: string;
      text: string;
      at: number;
      steer?: boolean;
      state?: "sending" | "sent" | "failed";
    }
  | { kind: "text"; id: string; text: string; at: number; phase?: "commentary" | "final" }
  | { kind: "work"; id: string; steps: readonly LiveStep[]; startedAt: number; endedAt?: number }
  | {
      kind: "ask";
      id: string;
      command: string;
      answer?: "allowed" | "denied";
      question?: string;
      /** The person answered and its computer has not heard yet: what the line says meanwhile. */ pending?: string;
    }
  | { kind: "agents"; id: string; children: readonly string[] }
  | {
      kind: "stop";
      id: string;
      at: number;
      /** The runtime does not say who stopped a turn, so its line never says "You". */ unowned: true;
    };

/** What a chat waits on the person for, as the board's Need: a command to allow, or direction with its options. */
export type LiveNeed =
  | { kind: "approval"; command: string; why?: string; summary: string; at: number }
  | {
      kind: "question";
      question: string;
      options: readonly { label: string; detail?: string; recommended?: boolean }[];
      summary: string;
      at: number;
    };

type AskPayload = Extract<SessionEvent, { type: "ask.user" }>["payload"];
export type AskAnswer = Params<"ask.respond">["response"];

/** The ask a chat is waiting on: its id for ask.respond, what the phone shows, and the ask as the engine sent it. */
export interface OpenAsk {
  readonly id: string;
  /** Null: only the Mac can answer it (a secret to add there, a custom tool's result). */
  readonly need: LiveNeed | null;
  /** One line for a row: the command, the question, or what the Mac must do. */
  readonly line: string;
  readonly payload: AskPayload;
}

/** What the person answered with, as the phone's screens say it (board/script.ts Reply). */
export type LiveReply =
  | { kind: "allow" }
  | { kind: "deny"; instead?: string }
  | { kind: "option"; option: { label: string } }
  | { kind: "told"; text: string };

const STEP_TOOL: Record<
  Extract<SessionEvent, { type: "tool.started" }>["payload"]["kind"],
  LiveStep["tool"]
> = {
  command: "run",
  read: "read",
  edit: "edit",
  search: "search",
  web: "search",
  mcp: "search",
  browser: "search",
  other: "search",
};

const firstLine = (text: string) =>
  text
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? "";
/** The first two sentences of what it said last: what an ask's card says it did so far. */
const said = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return (flat.match(/[^.!?]+[.!?]+/g) ?? [flat])
    .slice(0, 2)
    .map((sentence) => sentence.trim())
    .join(" ");
};

/**
 * One chat's transcript, fed its events in order. `items()` is a fresh array whenever something changed and the same
 * one otherwise, so a screen that holds it re-renders only then.
 */
export class LiveTranscript {
  /** Cursor of the last event applied; attach again from here. */
  cursor = 0;
  /** A turn is in flight. */
  running = false;
  /** When the turn in flight started (phone clock). */
  turnAt = 0;
  /** The model the latest turn ran on, once a turn said. */
  model: string | null = null;
  /** What it is doing now, while a turn runs: the tool at work, or "Thinking". */
  line = "Thinking";
  /** How the latest finished turn ended. */
  outcome: "completed" | "interrupted" | "failed" | null = null;
  ask: OpenAsk | null = null;

  private list: LiveItem[] = [];
  /** The cursor each item first showed at, for session.restored. */
  private born = new Map<string, number>();
  private cached: readonly LiveItem[] | null = null;
  /** Each running or finished tool's place: its work group's id and its step's index there. */
  private steps = new Map<string, { group: string; index: number }>();
  /** Each tool's command, when it has one: what an approval of it shows. */
  private commands = new Map<string, string>();
  /** Each ask as the engine sent it, to read its answer by (ask.resolved names option ids). */
  private asks = new Map<string, AskPayload>();
  /** What became of each ask, as its computer said: "answered", or it ended with no answer ("cancelled", "expired"). */
  private outcomes = new Map<string, string>();
  /** The turn in flight lost an ask to its computer restarting: its end is not the person's Stop. */
  private lapsed = false;
  /** The turn in flight lost an ask nobody answered: what it asked to run was not run, and nobody said no to it. */
  private unanswered = false;
  /** Your messages shown here that the chat's own journal has not said yet: being sent, kept in Cloud for its computer, or not sent. */
  private own = new Set<string>();
  /** The stop line of the turn that ended last, while what follows may still say nobody stopped it. */
  private lastStop: string | null = null;

  items(): readonly LiveItem[] {
    // What the journal has not said yet comes after everything it has: it is the latest thing, whatever was replayed.
    return (this.cached ??=
      this.own.size === 0
        ? [...this.list]
        : [
            ...this.list.filter((item) => !this.own.has(item.id)),
            ...this.list.filter((item) => this.own.has(item.id)),
          ]);
  }

  /**
   * The journal was rewritten (the chat moved, or lost its tail): everything held is dropped; events follow from 1.
   * Not what the person typed and the journal never said: a message that is still on its way, or was not sent, stays.
   */
  reset(): void {
    const kept = this.list.filter(
      (item) => item.kind === "you" && (item.state === "failed" || this.own.has(item.id)),
    );
    this.cursor = 0;
    this.running = false;
    this.model = null;
    this.line = "Thinking";
    this.outcome = null;
    this.ask = null;
    this.list = kept;
    this.born.clear();
    this.steps.clear();
    this.commands.clear();
    this.asks.clear();
    this.outcomes.clear();
    this.lapsed = false;
    this.unanswered = false;
    this.lastStop = null;
    this.cached = null;
  }

  /** What its computer said became of an ask: "answered", "cancelled", "expired"; undefined while it has not said. */
  outcomeOf(ask: string): string | undefined {
    return this.outcomes.get(ask);
  }

  /** Your message as it is sent, before the runtime has it: shown at once, "Sending" under it. `id` is the runtime's id for it. */
  echo(id: string, text: string, steer: boolean, at: number): void {
    if (this.find(id) >= 0) return;
    this.push({ kind: "you", id, text, at, state: "sending", ...(steer ? { steer: true } : {}) });
    this.own.add(id);
  }

  /** Your messages the journal has not said yet: what goes with the chat when another computer takes it. */
  unsaid(): readonly Extract<LiveItem, { kind: "you" }>[] {
    return this.list.filter(
      (item): item is Extract<LiveItem, { kind: "you" }> =>
        item.kind === "you" && (this.own.has(item.id) || item.state === "failed"),
    );
  }

  /** Messages typed while another computer held the chat (its `unsaid`): they stand here as they stood there. */
  take(items: readonly Extract<LiveItem, { kind: "you" }>[]): void {
    for (const item of items) {
      if (this.find(item.id) >= 0) continue;
      this.push(item);
      this.own.add(item.id);
    }
  }

  /** The runtime took the message (turn.submit answered): "Sending" goes, whether or not its event has come yet. */
  sent(id: string): void {
    const at = this.find(id);
    const item = this.list[at];
    if (item?.kind === "you" && item.state === "sending") this.put(at, { ...item, state: "sent" });
  }

  /** A send that was refused: what was typed stays where it is, marked as not sent, until it is sent again or taken back. */
  fail(id: string): void {
    const at = this.find(id);
    const item = this.list[at];
    if (item?.kind === "you" && item.state === "sending")
      this.put(at, { ...item, state: "failed" });
  }

  /** A message that was not sent, by its id; undefined when there is none such. */
  failed(id: string): Extract<LiveItem, { kind: "you" }> | undefined {
    const item = this.list[this.find(id)];
    return item?.kind === "you" && item.state === "failed" ? item : undefined;
  }

  /** A message that was not sent is sent again or let go: its mark goes, the new send's own echo takes its place. */
  unecho(id: string): void {
    const at = this.find(id);
    const item = this.list[at];
    if (item?.kind !== "you" || (item.state !== "sending" && item.state !== "failed")) return;
    this.list.splice(at, 1);
    this.own.delete(id);
    this.cached = null;
  }

  apply(event: SessionEvent, now = Date.now()): void {
    if (event.cursor <= this.cursor) return;
    this.cursor = event.cursor;
    // A native subagent's own events: its line in the parent's work group stands for it.
    if (event.parent_item_id !== undefined) return;
    const id = event.item_id ?? `${event.type}:${event.cursor}`;
    // Never ahead of the phone's clock (a Mac's clock a little fast): words stream in from `at`.
    const at = Math.min(Date.parse(event.at) || now, now);
    switch (event.type) {
      case "turn.started":
        this.running = true;
        this.turnAt = at;
        this.lapsed = false;
        this.unanswered = false;
        this.lastStop = null;
        this.outcome = null;
        this.line = "Thinking";
        if (event.payload.model) this.model = event.payload.model;
        return;
      case "model.routed":
        this.model = event.payload.model;
        return;
      case "reasoning.delta":
        this.line = "Thinking";
        return;
      case "message.delta": {
        this.closeWork(at);
        const index = this.find(id);
        const item = this.list[index];
        if (item?.kind === "text")
          this.put(index, { ...item, text: item.text + event.payload.text });
        else if (!item) this.push({ kind: "text", id, text: event.payload.text, at });
        this.line = "Writing";
        return;
      }
      case "message.done": {
        const p = event.payload;
        const index = this.find(id);
        const known = this.list[index];
        if (p.role === "assistant") {
          this.closeWork(at);
          if (known?.kind === "text") this.put(index, { ...known, text: p.text });
          else if (!known) this.push({ kind: "text", id, text: p.text, at });
          return;
        }
        // What the runtime wrote for the agent (a builder's result, its builders' one result, the word to carry on) is
        // one quiet line: never the instructions the agent was given, and never the person's own message.
        const generated = generatedLine(p);
        if (generated !== null) {
          if (!known) this.push({ kind: "text", id, text: generated, at, phase: "commentary" });
          return;
        }
        // Another agent's message (a lead's brief, mail from another chat) is not yours: it reads as said to the chat.
        if (p.from) {
          if (!known)
            this.push({
              kind: "text",
              id,
              text: `From ${p.from.title}: ${p.text}`,
              at,
              phase: "commentary",
            });
          return;
        }
        const you: LiveItem = {
          kind: "you",
          id,
          text: p.text,
          at: known?.kind === "you" ? known.at : at,
          state: "sent",
          ...(p.delivery === "steer" ? { steer: true } : {}),
        };
        // The echo of a message sent from here becomes the runtime's: where it sits, or after what was replayed over
        // it while it waited (the journal says it now, so that is its place).
        if (known && this.own.delete(id)) {
          this.list.splice(index, 1);
          this.push(you);
        } else if (known) this.put(index, you);
        else this.push(you);
        return;
      }
      case "tool.started": {
        const p = event.payload;
        // The chat's own setup (its worktree, made before its first turn) is not the agent's work: only its failure shows.
        if (id.startsWith("worktree:")) return;
        const command = (p.input as { command?: unknown } | null)?.command;
        if (typeof command === "string" && command !== "") this.commands.set(id, command);
        const step: LiveStep = { tool: STEP_TOOL[p.kind] ?? "search", text: p.title || p.name };
        this.line = step.text;
        const place = this.steps.get(id);
        // Again for a step already showing: an engine sends a call's input once it is whole.
        if (place) return this.step(place, () => step);
        const last = this.list.at(-1);
        if (last?.kind === "work" && last.endedAt === undefined) {
          this.steps.set(id, { group: last.id, index: last.steps.length });
          this.put(this.list.length - 1, { ...last, steps: [...last.steps, step] });
        } else {
          // A group left open above something else (the ask its last call waited on) ends where the next begins.
          this.closeWork(at);
          const group = `work:${event.cursor}`;
          this.steps.set(id, { group, index: 0 });
          this.push({ kind: "work", id: group, steps: [step], startedAt: at });
        }
        return;
      }
      case "tool.done": {
        const place = this.steps.get(id);
        const p = event.payload;
        if (p.status === "completed") return;
        if (id.startsWith("worktree:"))
          return this.push({
            kind: "text",
            id,
            text: firstLine(p.error ?? "") || "This chat could not be set up.",
            at,
          });
        if (!place) return;
        // A failure is never buried: its step says so. One whose ask nobody answered was not denied by anyone.
        return this.step(place, (step) => ({
          ...step,
          detail:
            p.status === "declined"
              ? this.unanswered
                ? "Not run"
                : "Denied"
              : firstLine(p.error ?? "") || "Failed",
        }));
      }
      case "subagent.started": {
        const child = event.payload.workspace_id;
        // A delegated agent has a chat of its own: the roster links to it. A native one is a line of work.
        if (child === undefined) {
          const last = this.list.at(-1);
          const step: LiveStep = { tool: "search", text: `Started ${event.payload.title}` };
          if (last?.kind === "work" && last.endedAt === undefined)
            return this.put(this.list.length - 1, { ...last, steps: [...last.steps, step] });
          this.closeWork(at);
          this.push({ kind: "work", id: `work:${event.cursor}`, steps: [step], startedAt: at });
          return;
        }
        const last = this.list.at(-1);
        if (last?.kind === "agents")
          this.put(this.list.length - 1, { ...last, children: [...last.children, child] });
        else this.push({ kind: "agents", id, children: [child] });
        return;
      }
      case "ask.user": {
        const p = event.payload;
        this.asks.set(id, p);
        const summary = said(
          this.list.findLast((i): i is Extract<LiveItem, { kind: "text" }> => i.kind === "text")
            ?.text ?? "",
        );
        if (p.kind === "approval") {
          const command =
            (p.tool_item_id ? this.commands.get(p.tool_item_id) : undefined) ?? p.detail ?? p.title;
          const why =
            p.reason && p.reason !== p.title && p.reason !== command ? p.reason : undefined;
          this.ask = {
            id,
            payload: p,
            line: command,
            need: { kind: "approval", command, ...(why ? { why } : {}), summary, at },
          };
          this.push({ kind: "ask", id, command });
        } else if (p.kind === "question" && p.questions.length > 0) {
          const [first] = p.questions;
          // One question shows its options; several read as one, answered in your own words.
          const question =
            p.questions.length === 1
              ? first!.prompt
              : p.questions.map((q, i) => `${i + 1}. ${q.prompt}`).join("\n");
          const options =
            p.questions.length === 1 && !first!.multi_select
              ? first!.options.map((o) => ({
                  label: o.label,
                  ...(o.description ? { detail: o.description } : {}),
                  ...(o.id === first!.recommended ? { recommended: true } : {}),
                }))
              : [];
          this.ask = {
            id,
            payload: p,
            line: firstLine(question),
            need: { kind: "question", question, options, summary, at },
          };
          this.push({ kind: "ask", id, command: "", question });
        } else {
          const line =
            p.kind === "secret" ? `Needs ${p.name}: add it on your Mac` : "Waiting on your Mac";
          this.ask = { id, payload: p, line, need: null };
          this.push({ kind: "ask", id, command: "", question: line });
        }
        return;
      }
      case "ask.resolved": {
        const index = this.find(id);
        const item = this.list[index];
        if (this.ask?.id === id) this.ask = null;
        this.outcomes.set(id, event.payload.outcome);
        if (event.payload.outcome === "expired") this.lapsed = true;
        if (event.payload.outcome !== "answered") this.unanswered = true;
        if (item?.kind !== "ask") return;
        const r = event.payload.response;
        const asked = this.asks.get(id);
        // Nobody answered it (the turn was stopped, or its computer went to sleep or restarted with the ask open): it
        // goes, never as a no the person did not give. What ended the turn says the rest.
        if (event.payload.outcome !== "answered") {
          this.list.splice(index, 1);
          this.cached = null;
          return;
        }
        if (asked?.kind === "approval") {
          const allowed =
            event.payload.outcome === "answered" &&
            r?.kind === "approval" &&
            asked.options.find((o) => o.id === r.option_id)?.decision === "allow";
          return this.put(index, { ...item, answer: allowed ? "allowed" : "denied" });
        }
        // A question, once answered, gives way to the answer, said as your message.
        this.list.splice(index, 1);
        this.cached = null;
        if (
          event.payload.outcome !== "answered" ||
          r?.kind !== "question" ||
          asked?.kind !== "question"
        )
          return;
        const words = r.answers
          .map((a) =>
            [
              ...a.option_ids.map(
                (option) =>
                  asked.questions
                    .find((q) => q.id === a.question_id)
                    ?.options.find((o) => o.id === option)?.label ?? option,
              ),
              ...(a.text ? [a.text] : []),
            ].join(", "),
          )
          .filter((text, i, all) => text !== "" && all.indexOf(text) === i);
        if (words.length > 0)
          this.push({ kind: "you", id: `${id}:answer`, text: words.join("\n"), at, state: "sent" });
        return;
      }
      case "turn.done": {
        this.running = false;
        this.closeWork(at);
        this.ask = null;
        this.outcome = event.payload.status;
        // A turn that moved to another computer carries on there, and one its computer restarted under was cut: nobody
        // stopped either.
        if (
          event.payload.status === "interrupted" &&
          event.payload.reason !== "moved" &&
          !this.lapsed
        ) {
          this.push({ kind: "stop", id, at, unowned: true });
          this.lastStop = id;
        }
        if (event.payload.status === "failed")
          this.push({ kind: "text", id, text: event.payload.error || "The turn failed.", at });
        return;
      }
      case "notification": {
        // The runtime's own word that the turn stopped so its computer could sleep (it writes no reason on the turn's
        // end): nobody stopped it, and it carries on when the computer wakes.
        const at = this.lastStop === null ? -1 : this.find(this.lastStop);
        if (at >= 0 && /^Paused while this computer sleeps/.test(event.payload.title)) {
          this.list.splice(at, 1);
          this.cached = null;
        }
        this.lastStop = null;
        return;
      }
      case "error":
        // One the engine is retrying is not the end of anything.
        if (event.payload.retry) this.line = "Trying again";
        else if (!this.running) this.push({ kind: "text", id, text: event.payload.message, at });
        return;
      case "session.restored": {
        // Files and transcript went back to the turn that ended at `at`: what came after goes.
        const keep = event.payload.at;
        this.list = this.list.filter((item) => (this.born.get(item.id) ?? 0) <= keep);
        this.cached = null;
        this.ask = null;
        this.running = false;
        return;
      }
      default:
        return;
    }
  }

  private find(id: string): number {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i]!.id === id) return i;
    return -1;
  }

  private push(item: LiveItem): void {
    this.list.push(item);
    if (!this.born.has(item.id)) this.born.set(item.id, this.cursor);
    this.cached = null;
  }

  private put(index: number, item: LiveItem): void {
    this.list[index] = item;
    this.cached = null;
  }

  private step(
    place: { group: string; index: number },
    change: (step: LiveStep) => LiveStep,
  ): void {
    const index = this.find(place.group);
    const group = this.list[index];
    if (group?.kind !== "work") return;
    this.put(index, {
      ...group,
      steps: group.steps.map((step, i) => (i === place.index ? change(step) : step)),
    });
  }

  /**
   * The open work group ends: words follow it, or the turn is over. Only the latest group can be open, and it need not
   * be the last item (an ask sits under the call that waits on it).
   */
  private closeWork(at: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const group = this.list[i]!;
      if (group.kind !== "work") continue;
      if (group.endedAt === undefined) this.put(i, { ...group, endedAt: at });
      return;
    }
  }
}

/**
 * The ask.respond answer for what the person said to an open ask, or null when the phone cannot answer it (one only
 * the Mac can). An approval hears Allow or Deny, and words of your own as a no with what to do instead (handed to the
 * agent where the engine takes a note); a question hears one of its options or your words, and a bare yes takes the
 * one it recommends. Several questions at once are each answered with your words.
 */
export function answerFor(ask: OpenAsk, reply: LiveReply): AskAnswer | null {
  const p = ask.payload;
  const words =
    reply.kind === "told"
      ? reply.text
      : reply.kind === "deny"
        ? reply.instead
        : reply.kind === "option"
          ? reply.option.label
          : undefined;
  if (p.kind === "approval") {
    const option = p.options.find(
      (o) => o.decision === (reply.kind === "allow" ? "allow" : "deny"),
    );
    if (!option) return null;
    return {
      kind: "approval",
      option_id: option.id,
      ...(reply.kind !== "allow" && p.accepts_feedback === true && words
        ? { feedback: words }
        : {}),
    };
  }
  if (p.kind !== "question") return null;
  return {
    kind: "question",
    answers: p.questions.map((q) => {
      const picked =
        reply.kind === "option"
          ? q.options.find((o) => o.label === reply.option.label)
          : reply.kind === "allow"
            ? (q.options.find((o) => o.id === q.recommended) ?? q.options[0])
            : undefined;
      if (picked) return { question_id: q.id, option_ids: [picked.id] };
      return {
        question_id: q.id,
        option_ids: [],
        text:
          words ?? (reply.kind === "allow" ? "Go ahead" : "Neither. Leave it as it is for now."),
      };
    }),
  };
}
