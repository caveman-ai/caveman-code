// The Chiefs' watcher: follows the chats they started and moves their items on the board the
// moment something happens (needs you, ready for review, done). The app watches and the model decides
//: what the person reads of a chat (it started, its plan, what it needs, its result) is
// found here, in code, and written into its Chief's conversation as a moment (chief/moments.ts), with no model
// turn. A Chief is woken only where a decision is its own (wakes): a question card it may answer, a failure it
// may fix, a result to explain in a line or two and a diagram. Everything else (a chat still working, checks
// running, a merge, a state that flipped with no result) wakes nobody: the board shows it. A wake goes once per
// quiet spell, never while its Chief is in a turn (those changes go together once it ends), with one
// <chat_update> line per chat worth it, as it stands then: its report (prompt.ts crewContract), files changed,
// pull request and where it stands, and the question card it waits on. A note typed to a Chief meanwhile carries
// the updates it has not heard (drain), in that turn. It also wakes a Chief when one of its scheduled items is
// due, and moves items as their chats' pull requests move (chief/pullRequests.ts). Forked once with the Session
// Protocol route (session-protocol/index.ts).
import type { ChiefMoment, SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";

import type { SessionStore, WorkspaceRecord } from "../session-protocol/store.ts";
import { chatFacts } from "./about.ts";
import * as Board from "./Board.ts";
import { askedIn, needsYou, planAt } from "./moments.ts";
import { chatUpdate, type QuestionCard, reportOf, type ReportStatus } from "./prompt.ts";
import { proofLine } from "./proof.ts";
import { followPullRequests } from "./pullRequests.ts";
import type { BoardStore } from "./store.ts";

/** Changes this close together wake the Chief once. */
export const WAKE_DEBOUNCE_MS = 3_000;
/** A run of changes never holds the wake longer than this (while its Chief is between turns). */
const WAKE_MAX_HOLD_MS = 15_000;
/** A woken Chief counts as in a turn this long with none started: its wake may wait in its delivery queue. */
const WAKE_SETTLE_MS = 20_000;
/** How often due items are looked for. ponytail: a poll; a timer per item if minutes of lag ever matter. */
const SCHEDULE_TICK_MS = 10_000;

/** chatUpdate appends playbook pointers after its closing tag; keep each once, after all updates. */
const updateLines = (updates: ReadonlyArray<{ readonly line: string }>): ReadonlyArray<string> => {
  const pointers = new Set<string>();
  const lines = updates.map(({ line }) => {
    const end = line.lastIndexOf("</chat_update>") + "</chat_update>".length;
    const tail = line
      .slice(end)
      .split("\n")
      .filter((part) => {
        if (!part.startsWith("Read the ") || !/\bplaybooks?\b/.test(part)) return true;
        pointers.add(part);
        return false;
      })
      .join("\n");
    return line.slice(0, end) + tail;
  });
  return [...lines, ...pointers];
};

export interface WatcherContext {
  readonly store: SessionStore["Service"];
  readonly board: BoardStore;
  /**
   * Tells one Chief (by id) what changed on its board. `heard` runs once the wake reached it (its turn is in, or over
   * today's limit its line), so no relaunch tells it the same again.
   */
  readonly wake: (
    chiefId: string,
    summary: string,
    text: string,
    heard?: Effect.Effect<void>,
  ) => Effect.Effect<void, unknown>;
  /** Items held on capacity or the cap, started now that a slot may be free. */
  readonly readmit: Effect.Effect<void, unknown>;
  /** A Chief's history was summarized. */
  readonly onCompaction: (chiefId: string) => Effect.Effect<void>;
  /** A chat read outside content: its report taints the Chief it reports to (chief/tools.ts remember). */
  readonly tainted: (record: WorkspaceRecord) => Effect.Effect<boolean>;
  readonly markTainted: (chiefId: string) => Effect.Effect<void>;
  /** Run on every schedule tick (notes that never reached the Chief). */
  readonly tick: Effect.Effect<void>;
  /**
   * Writes a moment of a chat on its board into this Chief's conversation, unless it is there already
   * (moments.ts writeMoment); `chat` is the chat's title.
   */
  readonly moment: (
    chiefId: string,
    moment: ChiefMoment,
    chat: string,
  ) => Effect.Effect<void, unknown>;
  /** A chat on a board finished a turn with this answer: its screenshots go onto its item (chief/proof.ts). */
  readonly captureProof?: (
    record: WorkspaceRecord,
    itemId: string,
    turnId: string | undefined,
    answer: string,
  ) => Effect.Effect<void, unknown>;
}

/** Files the chat's latest diff changes. */
const filesChanged = (store: SessionStore["Service"], record: WorkspaceRecord) =>
  store.sql<{
    event: string;
  }>`SELECT event FROM caveman_sp_events WHERE session_id = ${record.session.id} AND type = 'diff.changed'
    ORDER BY cursor DESC LIMIT 1`.pipe(
    Effect.map(([diff]) =>
      diff === undefined
        ? 0
        : (JSON.parse(diff.event) as Extract<SessionEvent, { type: "diff.changed" }>).payload.files
            .length,
    ),
    Effect.orElseSucceed(() => 0),
  );

/** A turn's final words: its last assistant message with text. A report is read from these, never from an earlier turn. */
const answerOf = (
  store: SessionStore["Service"],
  record: WorkspaceRecord,
  turnId: string | undefined,
) =>
  turnId === undefined
    ? Effect.succeed(undefined)
    : store.sql<{
        text: string | null;
      }>`SELECT json_extract(event, '$.payload.text') AS text FROM caveman_sp_events WHERE session_id = ${record.session.id}
        AND type = 'message.done' AND json_extract(event, '$.turn_id') = ${turnId} AND json_extract(event, '$.payload.role') = 'assistant'
        AND trim(coalesce(json_extract(event, '$.payload.text'), '')) != '' ORDER BY cursor DESC LIMIT 1`.pipe(
        Effect.map(([row]) => row?.text ?? undefined),
        Effect.orElseSucceed(() => undefined),
      );
/** The chat's latest finished turn, by id. */
const lastTurn = (store: SessionStore["Service"], record: WorkspaceRecord) =>
  store.sql<{
    turn: string | null;
  }>`SELECT json_extract(event, '$.turn_id') AS turn FROM caveman_sp_events WHERE session_id = ${record.session.id}
    AND type = 'turn.done' ORDER BY cursor DESC LIMIT 1`.pipe(
    Effect.map(([row]) => row?.turn ?? undefined),
    Effect.orElseSucceed(() => undefined),
  );

/** The ask a chat waits on now (its newest ask.user with no ask.resolved), if any. */
export const openAsk = (store: SessionStore["Service"], record: WorkspaceRecord) =>
  Effect.gen(function* () {
    const [row] = yield* store.sql<{
      event: string;
    }>`SELECT a.event FROM caveman_sp_events a WHERE a.session_id = ${record.session.id} AND a.type = 'ask.user'
      AND NOT EXISTS (SELECT 1 FROM caveman_sp_events r WHERE r.session_id = a.session_id AND r.type = 'ask.resolved'
        AND json_extract(r.event, '$.item_id') = json_extract(a.event, '$.item_id'))
      ORDER BY a.cursor DESC LIMIT 1`;
    if (row === undefined) return undefined;
    const event = JSON.parse(row.event) as Extract<SessionEvent, { type: "ask.user" }>;
    return event.item_id === undefined ? undefined : { id: event.item_id, ask: event.payload };
  }).pipe(Effect.orElseSucceed(() => undefined));

/** What the person alone answers, when a chat waits on it: an approval, a secret request, a grill round. */
export const personOnly = (
  open: { readonly ask: Extract<SessionEvent, { type: "ask.user" }>["payload"] } | undefined,
) =>
  open === undefined
    ? undefined
    : open.ask.kind === "approval"
      ? `Waits for the person to approve: ${open.ask.title}`
      : open.ask.kind === "secret"
        ? `Waits for the person to store the secret ${open.ask.name}`
        : open.ask.kind === "tool"
          ? `Waits for the person's app to run ${open.ask.name}`
          : open.ask.round !== undefined
            ? `Waits for the person to answer a grill round: ${open.ask.questions[0]?.prompt ?? "its questions"}`
            : undefined;

/** A question card a Chief may answer (chat_answer): a plain question, never a grill round, an approval or a secret. */
export const questionCard = (
  open:
    | { readonly id: string; readonly ask: Extract<SessionEvent, { type: "ask.user" }>["payload"] }
    | undefined,
): QuestionCard | undefined =>
  open === undefined || open.ask.kind !== "question" || open.ask.round !== undefined
    ? undefined
    : {
        id: open.id,
        questions: open.ask.questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          options: q.options.map((o) => ({ id: o.id, label: o.label })),
          allow_text: q.allow_text,
          multi_select: q.multi_select,
        })),
      };

/**
 * What a chat it started just did, by its session's event. Status alone can't tell a failed turn: it shows idle. A
 * finished turn whose answer reports question or blocked (crewContract) waits on a decision, whatever it changed.
 */
const outcomeOf = (
  ctx: Pick<WatcherContext, "store">,
  record: WorkspaceRecord,
  event: SessionEvent,
) =>
  Effect.gen(function* () {
    const store = ctx.store;
    if (event.type === "turn.started") return { kind: "working" } as const;
    // Its question card was answered (by the person or its Chief): it works on. A cancelled one ends with its turn.
    if (event.type === "ask.resolved")
      return event.payload.outcome === "answered" ? ({ kind: "working" } as const) : undefined;
    if (event.type === "ask.user") {
      const ask = event.payload;
      const detail =
        ask.kind === "approval"
          ? ask.title
          : ask.kind === "question"
            ? (ask.questions[0]?.prompt ?? "It asks a question")
            : ask.kind === "tool"
              ? `It needs your app to run ${ask.name}`
              : `It needs the secret ${ask.name}`;
      return { kind: "needs_you", detail } as const;
    }
    if (event.type !== "turn.done") return undefined;
    if (event.payload.status === "failed")
      return { kind: "needs_you", detail: event.payload.error ?? "Its turn failed." } as const;
    if (event.payload.status === "interrupted")
      return { kind: "needs_you", detail: "Stopped before it finished." } as const;
    const report = reportOf(yield* answerOf(store, record, event.turn_id));
    if (report?.status === "question")
      return { kind: "needs_you", detail: report.question ?? report.text } as const;
    if (report?.status === "blocked") return { kind: "needs_you", detail: report.text } as const;
    return (yield* filesChanged(store, record)) > 0 || report?.status === "review"
      ? ({ kind: "review" } as const)
      : ({ kind: "done" } as const);
  });

/** How a changed chat's state reads in the wake's line: "Docs typo needs you". */
const STATE_WORD: Readonly<Record<string, string>> = {
  needs_you: "needs you",
  review: "for review",
  done: "done",
};
const STATE_ORDER = ["needs_you", "review", "done"];
const shortTitle = (title: string) => {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
};
/** "Docs typo", "Docs typo and Cloud typo", "A, B and C", "A, B and 4 more". */
const names = (titles: ReadonlyArray<string>) => {
  const shown = titles.slice(0, 3).map(shortTitle);
  const more = titles.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length <= 1
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
};

/**
 * The line the Chief's transcript shows for a wake: how many chats changed, then each by name with where it stands,
 * grouped by state (what needs the person first). One line, however many chats one wake carries.
 */
export const wakeSummary = (
  chats: ReadonlyArray<{ readonly title: string; readonly state: string }>,
) => {
  const byState = new Map<string, Array<string>>();
  for (const chat of chats)
    byState.set(chat.state, [...(byState.get(chat.state) ?? []), chat.title]);
  const states = [...byState.keys()].sort(
    (a, b) => (STATE_ORDER.indexOf(a) + 1 || 99) - (STATE_ORDER.indexOf(b) + 1 || 99),
  );
  const parts = states.map(
    (state) => `${names(byState.get(state)!)} ${STATE_WORD[state] ?? state.replaceAll("_", " ")}`,
  );
  return `${chats.length} chat${chats.length === 1 ? "" : "s"} changed${parts.length === 0 ? "" : `: ${parts.join(" · ")}`}`;
};

/**
 * A finished turn is a result when its chat has changes (its branch's diff), a pull request, or reported review or done.
 * Its Chief explains it once per chat and item (store.ts narrated): later turns of the same request, a rebase or a
 * fixed check, are not news.
 */
export const isResult = (facts: {
  readonly files: number;
  readonly pullRequest: boolean;
  readonly report?: ReportStatus | undefined;
}) => facts.files > 0 || facts.pullRequest || facts.report === "review" || facts.report === "done";

/**
 * Whether a changed chat wakes its Chief, and what it would be told as a key (the same key again is nothing new). Only
 * where a decision is the model's: a question card it may answer; a failure it may fix (a failed, stopped or blocked
 * turn, a question asked in words, a pull request closed, red or with changes requested); a result to explain, once
 * per chat and item (`result`: its item). What only the person answers (an approval, a secret, a grill round) is their card's.
 * A chat still working, checks running, a merge and a state that flipped with no result wake nobody: the board shows them.
 */
export const wakes = (facts: {
  readonly state: string;
  readonly askId?: string | undefined;
  readonly personOnly?: string | undefined;
  readonly detail?: string | undefined;
  readonly prState?: string | undefined;
  readonly result?: string | undefined;
}) => {
  if (facts.askId !== undefined) return { wake: true, key: `ask:${facts.askId}` };
  if (facts.result !== undefined) return { wake: true, key: `result:${facts.result}` };
  if (facts.state === "needs_you")
    return {
      wake: facts.personOnly === undefined,
      key: `needs:${facts.personOnly ?? facts.detail ?? ""}|${facts.prState ?? ""}`,
    };
  return { wake: false, key: `${facts.state}|${facts.prState ?? ""}` };
};

/** One changed chat as its Chief hears it: its update line, what the transcript's line says of it, and whether it wakes. */
interface Update {
  readonly chiefId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly state: string;
  readonly line: string;
  /** What `wakes` compared against what its Chief last heard of this chat. */
  readonly key: string;
  readonly gate: "wake" | "drop";
  /** The chat's hold this line answers (store.ts markHeld): heard once the line reaches its Chief. */
  readonly held: number;
  /** The item and turn whose result its Chief is to explain: once heard, never again (store.ts markNarrated). */
  readonly narrate?: { readonly itemId: string; readonly turnId: string };
}
/**
 * A chat whose Chief has not heard its change yet: since when, whether it wakes its Chief whatever its level
 * (chief.attach), and its latest hold on disk.
 */
interface Pending {
  readonly since: number;
  readonly force?: boolean;
  readonly held: number;
}

export const makeWatcher = (ctx: WatcherContext) =>
  Effect.gen(function* () {
    /** A nudge: something in `pending` may be ready to go. */
    const changed = yield* Queue.unbounded<void>();
    const nudge = Queue.offer(changed, undefined).pipe(Effect.asVoid);
    /**
     * Chats that changed and whose Chief has not heard it yet, by their latest hold. Each goes as one line when its
     * Chief is woken (or in the next note to it), built then, so a chat that changed twice says where it stands now,
     * with its latest report. Kept with the chat on disk until the wake or note carrying it went (`heard`), so an update
     * the runtime quit before telling is told after the relaunch.
     */
    const pending = new Map<string, Pending>();
    /**
     * Chats that finished while a sibling on their item still works: the item did not move, so each waits for the move
     * that ends it and goes into `pending` with it, its own line beside the sibling's. Kept on disk too.
     */
    const finishedEarly = new Set<string>();
    for (const mark of yield* ctx.board.watchMarks) {
      if (mark.held > mark.heard)
        pending.set(mark.workspaceId, { since: Date.now(), held: mark.held });
      if (mark.early) finishedEarly.add(mark.workspaceId);
    }
    /** Its update waits for its Chief, on disk first. `force`: it wakes its Chief whatever its level. */
    const hold = (id: string, force = false) =>
      ctx.board.markHeld(id).pipe(
        Effect.map((held) => {
          const was = pending.get(id);
          pending.set(id, {
            since: was?.since ?? Date.now(),
            held: Math.max(held, was?.held ?? 0),
            ...(force || was?.force ? { force: true } : {}),
          });
        }),
      );
    // One write at a time, each of the set as it is then, so the last one written is its last change.
    const earlyWrites = yield* Semaphore.make(1);
    const keepEarly = (id: string) =>
      earlyWrites.withPermits(1)(
        Effect.suspend(() => ctx.board.markEarly(id, finishedEarly.has(id))),
      );
    /** Their item moved: the finishes they held for that move go to its Chief with it. */
    const release = (workspaceIds: ReadonlyArray<string>) =>
      Effect.forEach(
        workspaceIds,
        (id) =>
          finishedEarly.delete(id) ? hold(id).pipe(Effect.andThen(keepEarly(id))) : Effect.void,
        { discard: true },
      );
    /** What each chat's Chief last heard of it (wakes' key): the same again is nothing new. Forgotten once the chat is given new words. */
    const heardKey = new Map<string, string>();
    /** These updates reached their Chief: the results among them are explained. */
    const markHeard = (updates: ReadonlyArray<Update>) =>
      Effect.forEach(
        updates,
        (u) =>
          ctx.board
            .markHeard(u.workspaceId, u.held)
            .pipe(
              Effect.andThen(
                u.narrate === undefined
                  ? Effect.void
                  : ctx.board.markNarrated(u.workspaceId, u.narrate.itemId, u.narrate.turnId),
              ),
            ),
        {
          discard: true,
        },
      );
    /** Chats whose plan was read since this start (moments.ts planAt finds it at their first edit): once each. */
    const planRead = new Set<string>();
    /** A moment of this chat, written into its item's Chief's conversation (each once: moments.ts writeMoment). */
    const tell = (
      itemId: string,
      record: WorkspaceRecord,
      moment: Omit<ChiefMoment, "workspace_id" | "item_id">,
    ) =>
      Effect.gen(function* () {
        const item = yield* ctx.board.get(itemId);
        if (item?.chief_id === undefined) return;
        yield* ctx.moment(
          item.chief_id,
          { ...moment, workspace_id: record.workspace.id, item_id: itemId },
          record.workspace.title,
        );
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("chief: a moment was not written", cause)),
      );
    /** A chat on a board edits: at its first edit after a stretch of reading, what it wrote just before is its plan. */
    const planOf = (
      record: WorkspaceRecord,
      event: Extract<SessionEvent, { type: "tool.started" }>,
    ) =>
      Effect.gen(function* () {
        const itemId = yield* ctx.board.itemOfWorkspace(record.workspace.id);
        // Not on a board (yet): read again at its next edit.
        if (itemId === undefined) return;
        planRead.add(record.session.id);
        const plan = yield* planAt(ctx.store, record, event.cursor);
        if (plan !== undefined) yield* tell(itemId, record, { kind: "plan", text: plan });
      });
    /** Chiefs in a turn now (a turn.started of theirs seen, no turn.done since): their updates wait for it to end. */
    const running = new Set<string>();
    /** Chiefs woken, and when: the turn is on its way through the delivery queue, so it counts as running until it starts. */
    const woken = new Map<string, number>();
    const busy = (chiefId: string) =>
      running.has(chiefId) ||
      Date.now() - (woken.get(chiefId) ?? Number.NEGATIVE_INFINITY) < WAKE_SETTLE_MS;

    /**
     * Where each of these chats of an item stands, by its latest turn event (one yet to have its first turn works).
     * `self` is the chat whose change is being applied; any other that finished for review with its own pull request
     * merged is done.
     */
    const outcomesOf = (workspaceIds: ReadonlyArray<string>, self: string) =>
      Effect.gen(function* () {
        const outcomes: Array<Board.Outcome> = [];
        for (const workspaceId of workspaceIds) {
          const sibling = yield* ctx.store.getWorkspace(workspaceId);
          if (sibling === undefined) continue;
          const [row] = yield* ctx.store.sql<{
            event: string;
          }>`SELECT event FROM caveman_sp_events WHERE session_id = ${sibling.session.id}
            AND type IN ('turn.started', 'turn.done', 'ask.user', 'ask.resolved') ORDER BY cursor DESC LIMIT 1`.pipe(
            Effect.orDie,
          );
          // A newly created/held sibling has not had its first turn yet.
          const latest = (row === undefined
            ? undefined
            : yield* outcomeOf(ctx, sibling, JSON.parse(row.event) as SessionEvent)) ?? {
            kind: "working",
          };
          outcomes.push(
            workspaceId !== self &&
              latest.kind === "review" &&
              sibling.workspace.pull_request?.state === "merged"
              ? { kind: "done" }
              : latest,
          );
        }
        return outcomes;
      });

    const onEvent = (event: SessionEvent) =>
      Effect.gen(function* () {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.done" &&
          event.type !== "ask.user" &&
          event.type !== "ask.resolved" &&
          event.type !== "compaction.done" &&
          event.type !== "message.done" &&
          event.type !== "tool.started"
        )
          return;
        // Of a chat's tool calls only its edits are read, for its plan, and only until its first one was.
        if (
          event.type === "tool.started" &&
          (event.payload.kind !== "edit" || planRead.has(event.session_id))
        )
          return;
        const record = yield* ctx.store.getBySession(event.session_id);
        if (record === undefined) return;
        if (record.workspace.kind === "chief") {
          const chiefId = record.workspace.id;
          // In a turn: its chats' updates wait for it, and go together once it ends.
          if (event.type === "turn.started") {
            running.add(chiefId);
            woken.delete(chiefId);
          }
          if (event.type === "turn.done") {
            running.delete(chiefId);
            woken.delete(chiefId);
            if (pending.size > 0) yield* nudge;
          }
          // Its history was summarized: its next turn reads its whole board again.
          if (event.type === "compaction.done") yield* ctx.onCompaction(chiefId);
          // Another agent's message reached it (thread_send): outside words, as a tainted report is.
          if (
            event.type === "message.done" &&
            event.payload.role === "user" &&
            event.payload.from !== undefined
          )
            yield* ctx.markTainted(chiefId);
          return;
        }
        // New words for the chat (its Chief's steer, the person's message): whatever it reports next is news, even the same
        // result. A scheduled task's ping (a "check CI again" loop) is no new word.
        if (
          event.type === "message.done" &&
          event.payload.role === "user" &&
          event.payload.scheduled_task === undefined
        )
          heardKey.delete(record.workspace.id);
        if (event.type === "compaction.done" || event.type === "message.done") return;
        if (event.type === "tool.started") return yield* planOf(record, event);
        const itemId = yield* ctx.board.itemOfWorkspace(record.workspace.id);
        if (itemId === undefined) return;
        const outcome = yield* outcomeOf(ctx, record, event);
        if (outcome === undefined) return;
        // Before its Chief hears of it, so the update names its screenshots.
        if (
          event.type === "turn.done" &&
          event.payload.status === "completed" &&
          ctx.captureProof
        ) {
          const answer = yield* answerOf(ctx.store, record, event.turn_id);
          if (answer !== undefined)
            yield* ctx
              .captureProof(record, itemId, event.turn_id, answer)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("chief: screenshots not kept", cause),
                ),
              );
        }
        const moved = yield* ctx.board.update("watch", (items) =>
          Effect.gen(function* () {
            const item = items.find((i) => i.id === itemId);
            if (item === undefined) return { write: [], value: undefined };
            // An item owns all of its chats, not just the one whose event woke us. Re-read
            // their latest events (also on recovery), so the first finisher cannot close it
            // or hide a sibling's outstanding question or diff.
            const combined = Board.combine(
              yield* outcomesOf(item.workspace_ids, record.workspace.id),
              outcome,
            );
            const at = new Date().toISOString();
            let next = Board.watched(item, combined, at);
            // The chat its Chief asked the person about works again (answered in the chat, or sent the answer): settled.
            const asked = next.asked;
            if (
              asked?.workspace_id === record.workspace.id &&
              outcome.kind === "working" &&
              (event.type === "turn.started" ||
                asked.ask_id === undefined ||
                asked.ask_id === event.item_id)
            ) {
              next = Board.settle(next, at);
            }
            return next === item ? { write: [], value: undefined } : { write: [next], value: next };
          }),
        );
        // What the person reads of it, in its Chief's conversation: what it waits on, or its result.
        if (event.type === "ask.user" && event.item_id !== undefined)
          yield* tell(itemId, record, {
            kind: "needs_you",
            ...needsYou(event.payload, event.item_id),
          });
        if (event.type === "turn.done") {
          const report = reportOf(yield* answerOf(ctx.store, record, event.turn_id));
          // A question asked in its report, not on a card: the card shows its words; the person answers in a note or the chat.
          if (outcome.kind === "needs_you" && report?.status === "question")
            yield* tell(itemId, record, {
              kind: "needs_you",
              ...askedIn(report.question ?? report.text),
            });
          else if (
            outcome.kind !== "needs_you" &&
            isResult({
              files: yield* filesChanged(ctx.store, record),
              pullRequest: record.workspace.pull_request !== undefined,
              report: report?.status,
            })
          )
            yield* tell(itemId, record, { kind: "result" });
        }
        if (event.type === "turn.done")
          yield* ctx.readmit.pipe(
            Effect.catchCause((cause) => Effect.logWarning("chief: readmission failed", cause)),
          );
        if (outcome.kind === "working") {
          if (finishedEarly.delete(record.workspace.id)) yield* keepEarly(record.workspace.id);
        } else if (moved === undefined) {
          finishedEarly.add(record.workspace.id);
          yield* keepEarly(record.workspace.id);
        } else {
          yield* release(moved.workspace_ids);
          yield* hold(record.workspace.id);
          yield* nudge;
        }
        // Last: a quit before this replays the event at relaunch, and what it held is held again.
        yield* ctx.board.markApplied(record.workspace.id, event.cursor);
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("chief: watcher event not handled", cause)),
      );

    /** The Chief whose item holds this chat, with the item; undefined when none does any more (it tells no one). */
    const placed = (id: string) =>
      Effect.gen(function* () {
        const record = yield* ctx.store.getWorkspace(id);
        if (record === undefined) return undefined;
        const itemId = yield* ctx.board.itemOfWorkspace(id);
        const item = itemId === undefined ? undefined : yield* ctx.board.get(itemId);
        return item?.chief_id === undefined
          ? undefined
          : { record, item, itemId: itemId!, chiefId: item.chief_id };
      });

    /** One changed chat's update line, as it stands now, whether it wakes its Chief (wakes), and the hold it answers. */
    const updateOf = (
      { record, item, itemId, chiefId }: NonNullable<Effect.Success<ReturnType<typeof placed>>>,
      waiting: Pending,
    ) =>
      Effect.gen(function* () {
        if (yield* ctx.tainted(record)) yield* ctx.markTainted(chiefId);
        // What it waits on: a question card its Chief may answer, else an approval or a secret (the person's), else
        // its report; a failed or stopped turn with no report says its error line.
        const open = item.state === "needs_you" ? yield* openAsk(ctx.store, record) : undefined;
        const card = questionCard(open);
        // Its latest turn's own words: a turn that failed before writing any says its error line, never an older report.
        const answer = yield* answerOf(ctx.store, record, yield* lastTurn(ctx.store, record));
        const latest =
          personOnly(open) ??
          (item.state === "needs_you" && reportOf(answer) === undefined ? item.detail : answer);
        const files = yield* filesChanged(ctx.store, record);
        // No answer yet (a chat just put on its board): what it is for, so the Chief knows what a note about it means.
        const goal =
          latest === undefined && card === undefined
            ? (yield* chatFacts(ctx.store, record)).goal
            : undefined;
        const prState = record.workspace.pull_request
          ? Board.pullRequestStatus(record.workspace.pull_request)
          : undefined;
        const fields = {
          workspaceId: record.workspace.id,
          itemId,
          title: record.workspace.title,
          state: item.state,
          ...(latest === undefined ? {} : { latest }),
          ...(files > 0 ? { files } : {}),
          ...(record.workspace.pull_request && prState !== undefined
            ? { pr: record.workspace.pull_request.url, prState }
            : {}),
          ...(card ? { ask: card } : {}),
          ...(goal ? { goal } : {}),
          proof: proofLine(item, record.workspace.id),
        };
        // A result to explain, once per chat and item: a merge, a rebase or a fixed check after it is no news.
        const turn = yield* lastTurn(ctx.store, record);
        const result =
          turn !== undefined &&
          (item.state === "review" || item.state === "done") &&
          isResult({
            files,
            pullRequest: record.workspace.pull_request !== undefined,
            report: reportOf(answer)?.status,
          }) &&
          !(yield* ctx.board.narrated(record.workspace.id, itemId))
            ? turn
            : undefined;
        const { wake, key } = wakes({
          state: item.state,
          askId: card?.id,
          personOnly: personOnly(open),
          detail: item.detail,
          prState,
          result: result === undefined ? undefined : itemId,
        });
        const decided =
          waiting.force || (wake && key !== heardKey.get(record.workspace.id)) ? "wake" : "drop";
        const line = chatUpdate({
          ...fields,
          ...(result === undefined ? {} : { result: true, doneWhen: item.done_when }),
        });
        return {
          chiefId,
          workspaceId: record.workspace.id,
          title: record.workspace.title,
          state: item.state,
          line,
          key,
          gate: decided,
          held: waiting.held,
          ...(result === undefined || decided === "drop"
            ? {}
            : { narrate: { itemId, turnId: result } }),
        } satisfies Update;
      });

    /**
     * The pending updates of the Chiefs `take` says, built as they stand now and grouped by Chief, still in `pending`
     * (`claim` takes them out). A chat no Chief's item holds goes, and so does one with nothing new for its Chief.
     */
    const readUpdates = (take: (chiefId: string) => boolean) =>
      Effect.gen(function* () {
        const byChief = new Map<string, Array<Update>>();
        for (const [id, waiting] of [...pending]) {
          // Taken meanwhile by the other of flush and drain (they run on different fibers): never twice.
          if (pending.get(id) !== waiting) continue;
          const found = yield* placed(id);
          if (found === undefined) {
            pending.delete(id);
            if (finishedEarly.delete(id)) yield* keepEarly(id);
            yield* ctx.board.markHeard(id, waiting.held);
            continue;
          }
          if (!take(found.chiefId)) continue;
          const update = yield* updateOf(found, waiting);
          if (update.gate === "drop") {
            if (pending.get(id) === waiting) pending.delete(id);
            yield* ctx.board.markHeard(id, waiting.held);
            continue;
          }
          // Its line says where it stands now: an earlier finish of it is heard too.
          if (finishedEarly.delete(id)) yield* keepEarly(id);
          byChief.set(found.chiefId, [...(byChief.get(found.chiefId) ?? []), update]);
        }
        return byChief;
      });
    /**
     * Takes these updates out of `pending`, all at once (no yield in between), and records them as heard. One the other
     * of flush and drain took meanwhile (they run on different fibers) is left out: never twice.
     */
    const claim = (updates: ReadonlyArray<Update>) => {
      const mine = updates.filter((u) => pending.has(u.workspaceId));
      for (const u of mine) {
        pending.delete(u.workspaceId);
        heardKey.set(u.workspaceId, u.key);
      }
      return mine;
    };

    /** One wake per Chief not in a turn that has a chat worth waking it for; a Chief in a turn hears its when it ends. */
    const flush = Effect.gen(function* () {
      const byChief = yield* readUpdates((chiefId) => !busy(chiefId));
      for (const [chiefId, updates] of byChief) {
        if (!updates.some((u) => u.gate === "wake")) continue;
        const mine = claim(updates);
        if (mine.length === 0) continue;
        woken.set(chiefId, Date.now());
        yield* ctx
          .wake(chiefId, wakeSummary(mine), updateLines(mine).join("\n"), markHeard(mine))
          .pipe(Effect.catchCause((cause) => Effect.logWarning("chief: wake failed", cause)));
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("chief: wake failed", cause)));

    /**
     * The updates a Chief has not heard yet, for the note on its way to it now: they go in that turn, not after it.
     * `ids`: the chats they were for, held again (holdAgain) if the note never goes; `heard` once it went.
     */
    const drain = (chiefId: string) =>
      readUpdates((id) => id === chiefId).pipe(
        Effect.map((byChief) => {
          const updates = claim(byChief.get(chiefId) ?? []);
          return {
            lines: updateLines(updates),
            ids: updates.map((u) => u.workspaceId),
            heard: markHeard(updates),
          };
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("chief: updates not drained", cause).pipe(
            Effect.as({
              lines: [] as ReadonlyArray<string>,
              ids: [] as ReadonlyArray<string>,
              heard: Effect.void,
            }),
          ),
        ),
      );
    const holdAgain = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        for (const id of ids) {
          heardKey.delete(id);
          yield* hold(id);
        }
        if (ids.length > 0) yield* nudge;
      });

    const debounce = Effect.gen(function* () {
      while (true) {
        yield* Queue.take(changed);
        const started = Date.now();
        while (Date.now() - started < WAKE_MAX_HOLD_MS) {
          const next = yield* Queue.take(changed).pipe(
            Effect.timeoutOption(`${WAKE_DEBOUNCE_MS} millis`),
          );
          if (Option.isNone(next)) break;
        }
        yield* flush;
      }
    });

    /**
     * Due scheduled items go back on the Queue and wake their Chief; items blocked on capacity or the cap are retried,
     * since a slot or the cap can free with no chat ending (a raised limit, an abandoned sibling, a new day).
     */
    const schedule = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(`${SCHEDULE_TICK_MS} millis`);
        yield* ctx.tick.pipe(
          Effect.catchCause((cause) => Effect.logWarning("chief: catch-up failed", cause)),
        );
        // Updates held for a wake that never became a turn (no key, over the cap, the Chief gone) go once it settles.
        if (pending.size > 0) yield* nudge;
        const at = new Date().toISOString();
        const due = yield* ctx.board.update("due", (items) =>
          Effect.succeed({
            write: items
              .filter(
                (i) => i.state === "scheduled" && i.not_before !== undefined && i.not_before <= at,
              )
              .map((i) => Board.requeue(i, at)),
            value: items.filter(
              (i) => i.state === "scheduled" && i.not_before !== undefined && i.not_before <= at,
            ),
          }),
        );
        const dueBy = new Map<string, Array<(typeof due)[number]>>();
        for (const item of due)
          if (item.chief_id !== undefined)
            dueBy.set(item.chief_id, [...(dueBy.get(item.chief_id) ?? []), item]);
        for (const [chiefId, mine] of dueBy) {
          yield* ctx
            .wake(
              chiefId,
              `${mine.length} scheduled item${mine.length === 1 ? "" : "s"} due`,
              mine
                .map(
                  (i) =>
                    `<scheduled item="${i.id}">Due now (not before ${i.not_before}).</scheduled>`,
                )
                .join("\n"),
            )
            .pipe(Effect.ignore);
        }
        yield* ctx.readmit.pipe(Effect.ignore);
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("chief: scheduler stopped", cause)));

    /** A chat's latest turn event, if it had any turn. */
    const latestEvent = (workspaceId: string) =>
      Effect.gen(function* () {
        const record = yield* ctx.store.getWorkspace(workspaceId);
        if (record === undefined) return undefined;
        const [row] = yield* ctx.store.sql<{
          event: string;
        }>`SELECT event FROM caveman_sp_events WHERE session_id = ${record.session.id}
          AND type IN ('turn.started', 'turn.done', 'ask.user', 'ask.resolved') ORDER BY cursor DESC LIMIT 1`.pipe(
          Effect.orElseSucceed(() => []),
        );
        return row === undefined ? undefined : (JSON.parse(row.event) as SessionEvent);
      });
    /**
     * Items whose chats moved while the runtime was down: each chat's latest turn event the watcher has not moved its
     * item by (store.ts markApplied) is played through as if it had just happened; one it had is not, so its Chief is
     * not woken for it twice. What the Chiefs had yet to hear when it quit goes with the next wake. Subscribed first, so
     * nothing after it is missed.
     */
    const reconcile = Effect.gen(function* () {
      const applied = new Map(
        (yield* ctx.board.watchMarks).map((mark) => [mark.workspaceId, mark.applied]),
      );
      const latest: Array<SessionEvent> = [];
      for (const item of yield* ctx.board.all) {
        if (!Board.RUNNING_STATES.has(item.state)) continue;
        for (const workspaceId of item.workspace_ids) {
          const event = yield* latestEvent(workspaceId);
          if (event !== undefined && event.cursor > (applied.get(workspaceId) ?? 0))
            latest.push(event);
        }
      }
      for (const event of latest.sort((a, b) => a.at.localeCompare(b.at))) yield* onEvent(event);
      if (pending.size > 0) yield* nudge;
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("chief: reconcile failed", cause)));

    /**
     * A chat the person just added to a Chief's board (chief.attach): its item takes the state its latest turn says,
     * and its Chief is woken with the chat's update, as for one it started. `sending`: its Chief put it there to message
     * it (chat_send), so its next turn is on its way: a finished last turn is not replayed and nothing wakes the Chief;
     * a question or a turn still running is followed as ever.
     */
    const adopt = (workspaceId: string, sending = false) =>
      Effect.gen(function* () {
        const event = yield* latestEvent(workspaceId);
        if (event !== undefined && !(sending && event.type === "turn.done")) yield* onEvent(event);
        if (sending) return;
        // The person just put it on this board: its Chief hears it now, whatever its level.
        yield* hold(workspaceId, true);
        yield* nudge;
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("chief: adopting a chat failed", cause)),
      );

    const follow = Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(ctx.store.events);
      yield* reconcile;
      while (true) yield* onEvent(yield* PubSub.take(sub));
    }).pipe(Effect.scoped);

    /**
     * Each chat's pull request onto its item; what moved it to done or needs_you joins the next wake, with the finishes
     * its chats held for that move.
     */
    const pullRequests = followPullRequests({
      store: ctx.store,
      board: ctx.board,
      chats: (item, workspaceId) =>
        Effect.gen(function* () {
          const others = yield* outcomesOf(
            item.workspace_ids.filter((id) => id !== workspaceId),
            workspaceId,
          );
          // Merged under a chat still in its turn: what that turn leaves is yet to come.
          const record = yield* ctx.store.getWorkspace(workspaceId);
          const event = yield* latestEvent(workspaceId);
          const own =
            record === undefined || event === undefined
              ? undefined
              : yield* outcomeOf(ctx, record, event);
          return own?.kind === "working" ? [...others, own] : others;
        }),
      changed: (id) =>
        Effect.gen(function* () {
          const itemId = yield* ctx.board.itemOfWorkspace(id);
          const item = itemId === undefined ? undefined : yield* ctx.board.get(itemId);
          if (item !== undefined) yield* release(item.workspace_ids);
          yield* hold(id);
          yield* nudge;
        }),
    });

    /** `run`: fork it once, it runs for the route's life. */
    return {
      run: Effect.all([follow, debounce, schedule, pullRequests], {
        concurrency: "unbounded",
        discard: true,
      }),
      drain,
      holdAgain,
      adopt,
    };
  });
