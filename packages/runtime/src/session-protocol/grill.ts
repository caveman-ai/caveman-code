// Grill mode's rounds and finish (README: Grill mode). A round is an ask.user
// the runtime journals itself, not an engine request: the grill MCP tool
// (mcp/toolkits/grill) posts it and waits for its ask.resolved, which
// ask.respond, an interrupted turn (projector.ts) or the tool call ending writes.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import { containedPath } from "./lifecycle.ts";
import type { DraftEvent } from "./projector.ts";
import { makeRuntimeAsks, type AskResponse, type AskUserEvent } from "./runtimeAsks.ts";
import * as Store from "./store.ts";
import type { WorkspaceRecord } from "./store.ts";

export interface GrillQuestion {
  readonly title: string;
  readonly body: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string | undefined }>;
  /** Index into `options`. */
  readonly recommended: number;
  /** The options are not exclusive: the user may pick several. */
  readonly multi_select?: boolean | undefined;
}

export interface GrillAnswer {
  readonly title: string;
  /** The chosen options' labels and the user's own words, joined with ", ". */
  readonly answer: string;
  readonly took_recommendation: boolean;
}

/** What the agent reads when a grill tool fails. */
export class GrillError extends Schema.TaggedError<GrillError>()("GrillError", { message: Schema.String }) {}

/** Why ask.respond refused a grill answer (handlers.ts maps it to a ProtocolError). */
export class GrillRespondError extends Schema.TaggedError<GrillRespondError>()("GrillRespondError", {
  reason: Schema.Literals(["not_found", "invalid_state", "invalid_params"]),
  message: Schema.String,
}) {}

export const GRILL_ASK_PREFIX = "grill:";
export const isGrillAsk = (askId: string) => askId.startsWith(GRILL_ASK_PREFIX);

type QuestionAsk = Extract<AskUserEvent["payload"], { kind: "question" }>;
type QuestionResponse = Extract<AskResponse, { kind: "question" }>;

const fail = (message: string) => Effect.fail(new GrillError({ message }));
const now = () => new Date().toISOString();

export class Grill extends Context.Service<
  Grill,
  {
    /** Posts a round for the thread's running turn and waits for the user's answers. */
    readonly round: (threadId: string, questions: ReadonlyArray<GrillQuestion>) => Effect.Effect<ReadonlyArray<GrillAnswer>, GrillError>;
    /** grill.finished: the decisions doc is written. */
    readonly finish: (threadId: string, input: { readonly doc_path: string; readonly summary: string }) => Effect.Effect<{ readonly doc_path: string }, GrillError>;
    /** ask.respond for a grill round. */
    readonly respond: (record: WorkspaceRecord, askId: string, response: AskResponse) => Effect.Effect<void, GrillRespondError>;
    /** Cancels the session's open rounds; their tool calls read that the user did not answer. */
    readonly cancelOpen: (record: WorkspaceRecord) => Effect.Effect<void>;
  }
>()("caveman/session-protocol/Grill") {}

export const make = Effect.gen(function* () {
  const store = yield* Store.SessionStore;

  const { withState, askEvent, resolvedOutcome, close, runningTurn } = makeRuntimeAsks(store);

  const recordOf = (threadId: string) =>
    store.getByThread(threadId).pipe(
      Effect.flatMap((record) => (record ? Effect.succeed(record) : fail("Grill tools work only in a Caveman Code session."))),
      Effect.filterOrElse(
        (record) => record.session.mode === "grill",
        // A retried round after the user left grill mode: building now would run in the old turn.
        () => fail("The user left grill mode. Stop now and wait for their next message; do not start building."),
      ),
    );

  const round = (threadId: string, questions: ReadonlyArray<GrillQuestion>, runId?: string) =>
    Effect.gen(function* () {
      if (questions.length === 0) return yield* fail("A round needs at least one question.");
      for (const q of questions) {
        if (q.options.length < 2 || q.options.length > 5) return yield* fail(`"${q.title}" needs 2 to 5 options.`);
        if (!Number.isInteger(q.recommended) || q.recommended < 0 || q.recommended >= q.options.length) {
          return yield* fail(`"${q.title}": recommended must be an option index from 0 to ${q.options.length - 1}.`);
        }
      }
      const record = yield* recordOf(threadId);
      const askId = `${GRILL_ASK_PREFIX}${randomUUID()}`;
      // Subscribe before the ask is journaled, so its answer cannot slip past.
      const sub = yield* PubSub.subscribe(store.events);
      const ask = yield* withState(record, (state) => {
        state.grillRound = (state.grillRound ?? 0) + 1;
        state.asks[askId] = "open";
        const payload: QuestionAsk = {
          kind: "question",
          round: state.grillRound,
          questions: questions.map((q, i) => ({
            id: `q${i + 1}`,
            prompt: q.title,
            detail: q.body,
            options: q.options.map((option, j) => ({ id: `o${j + 1}`, label: option.label, ...(option.description ? { description: option.description } : {}) })),
            recommended: `o${q.recommended + 1}`,
            multi_select: q.multi_select === true,
            allow_text: true,
          })),
        };
        const draft = { at: now(), type: "ask.user", item_id: askId, ...(runId ? { turn_id: runId } : {}), payload } as DraftEvent;
        return { value: draft, drafts: [draft] };
      });
      const resolved = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(sub);
          if (event.type === "ask.resolved" && event.item_id === askId) return event;
        }
      }).pipe(
        // The tool call ended without an answer (the engine gave up or the turn stopped).
        Effect.onInterrupt(() => close(record, ask, "cancelled").pipe(Effect.asVoid)),
      );
      if (resolved.payload.outcome !== "answered" || resolved.payload.response?.kind !== "question") {
        return yield* fail(`The user did not answer this round (${resolved.payload.outcome}). Stop and wait for them.`);
      }
      const answers = resolved.payload.response.answers;
      return questions.map((q, i): GrillAnswer => {
        const given = answers.find((a) => a.question_id === `q${i + 1}`);
        const text = given?.text?.trim();
        // Option ids are o1..on (posted above); respond checked they are this question's.
        const picked = (given?.option_ids ?? []).map((id) => Number(id.slice(1)) - 1);
        return {
          title: q.title,
          answer: [...picked.map((j) => q.options[j]?.label ?? ""), ...(text ? [text] : [])].join(", "),
          took_recommendation: !text && picked.length === 1 && picked[0] === q.recommended,
        };
      });
    }).pipe(Effect.scoped);

  return Grill.of({
    round: (threadId, questions) =>
      // The round belongs to the thread's running turn.
      store.getByThread(threadId).pipe(
        Effect.flatMap((record) => (record === undefined ? Effect.succeed(undefined) : runningTurn(threadId))),
        Effect.flatMap((runId) => round(threadId, questions, runId)),
      ),
    finish: (threadId, input) =>
      Effect.gen(function* () {
        const record = yield* recordOf(threadId);
        const worktree = record.internal.worktreePath;
        // Real paths, so symlinks and macOS's /var vs /private/var name the same file.
        const file = worktree && fs.existsSync(worktree) ? containedPath(worktree, input.doc_path) : undefined;
        if (!worktree || !file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
          return yield* fail("doc_path must be the decisions doc you wrote, a file inside the workspace.");
        }
        // Relative to the worktree with `/` on the wire, as the client splits it (and as git names files), on Windows too.
        const docPath = path.relative(fs.realpathSync(worktree), file).split(path.sep).join("/");
        yield* store.append(record.session.id, () =>
          Effect.succeed({ events: [{ at: now(), type: "grill.finished", payload: { doc_path: docPath, summary: input.summary } } as DraftEvent], value: undefined }),
        );
        return { doc_path: docPath };
      }),
    respond: (record, askId, response) =>
      Effect.gen(function* () {
        const ask = yield* askEvent(record.session.id, askId);
        if (ask === undefined || ask.payload.kind !== "question") return yield* new GrillRespondError({ reason: "not_found", message: `no ask ${askId}` });
        if (response.kind !== "question") return yield* new GrillRespondError({ reason: "invalid_params", message: "a grill round takes a question response" });
        const ids = new Set(ask.payload.questions.map((q) => q.id));
        for (const answer of (response as QuestionResponse).answers) {
          const question = ask.payload.questions.find((q) => q.id === answer.question_id);
          if (!question) return yield* new GrillRespondError({ reason: "invalid_params", message: `no question ${answer.question_id} in this round` });
          if (answer.option_ids.some((id) => !question.options.some((o) => o.id === id)) || new Set(answer.option_ids).size !== answer.option_ids.length) {
            return yield* new GrillRespondError({ reason: "invalid_params", message: `${answer.question_id} takes its own option ids` });
          }
          if (answer.option_ids.length > 1 && !question.multi_select) {
            return yield* new GrillRespondError({ reason: "invalid_params", message: `${answer.question_id} takes one option` });
          }
          if (answer.option_ids.length === 0 && !answer.text?.trim()) {
            return yield* new GrillRespondError({ reason: "invalid_params", message: `${answer.question_id} needs an option or text` });
          }
          ids.delete(answer.question_id);
        }
        if (ids.size > 0) return yield* new GrillRespondError({ reason: "invalid_params", message: `answer every question of the round (missing ${[...ids].join(", ")})` });
        const answered = yield* close(record, ask, "answered", response);
        if (!answered) {
          const outcome = yield* resolvedOutcome(record.session.id, askId);
          return yield* new GrillRespondError({
            reason: "invalid_state",
            message: outcome === "cancelled" ? "this round was cancelled (the user wrote instead, or the turn stopped)" : "this ask was already answered",
          });
        }
      }),
    cancelOpen: (record) =>
      withState(record, (state) => {
        const turnId = Object.entries(state.runs).find(([, run]) => run.started && !run.done)?.[0];
        const open = Object.keys(state.asks).filter((id) => isGrillAsk(id) && state.asks[id] === "open");
        for (const id of open) state.asks[id] = "resolved";
        const drafts = open.map(
          (id) => ({ at: now(), type: "ask.resolved", item_id: id, ...(turnId ? { turn_id: turnId } : {}), payload: { outcome: "cancelled" } }) as DraftEvent,
        );
        return { value: undefined, drafts };
      }),
  });
});

export const layer = Layer.effect(Grill, make).pipe(Layer.provide(Store.layer));
