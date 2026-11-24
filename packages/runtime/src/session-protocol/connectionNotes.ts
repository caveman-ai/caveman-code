// What Cloud's data plane said about a chat's model requests, in that chat (cloud-computers SPEC §4.1, CONTRACT §3).
// On a Cloud computer whose person's credentials stay outside it, the egress scrub hears the data plane's answers and
// the computer's connections keep them (cloudLink/modelConnections.ts); a Mac that runs on the person's connections
// hears its providers the same way. Here each becomes what the person reads, and what the chat does next:
// - a connection ran out, or its kind is switched off, and another serves: one note, naming what the chat runs on now
//   ("Claude plan used up until 11:08 PM. Running on your Anthropic key."). The engine has already carried on. A chat
//   started on a Mac with every connection used up says the same, and that it runs on this Mac's login;
// - nothing serves the engine: one note that says why and what happens next (nothing connected, a sign-in that
//   expired, a kind their admin turned off, a plan used up until a time). The chat then waits: it looks at the
//   person's list again, and as soon as something serves its engine (a plan or key connected from their Mac, a used-up
//   plan whose time has passed) it sends their last message again on the chat's own engine, by itself, once. Meanwhile,
//   once the refused turn has ended, a question before any Caveman credits are spent: yes sends their last message
//   again on the Caveman engine's credits model and ends the wait; no leaves the chat waiting.
// What waits is kept in memory only: a runtime that restarts (a Cloud computer that slept) forgets it, and the chat
// then stays as it is until the person sends again.
// Never an amount or a price: spend stays out of a session.
import { randomUUID } from "node:crypto";

import { CREDITS_DEFAULT_MODEL } from "@caveman-app/provider-caveman/server";
import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import type { LinkState } from "../cloudLink/index.ts";
import { macConnectionsOf } from "../cloudLink/macConnections.ts";
import {
  connectionsOf,
  kindOffNote,
  nothingServesNote,
  onDataPlaneAnswer,
  usedUpNote,
  type DataPlaneAnswer,
  type Place,
  type ServedEngine,
} from "../cloudLink/modelConnections.ts";
import { proxySession } from "../router/cavemanRouter.ts";
import type { DraftEvent } from "./projector.ts";
import { makeRuntimeAsks, type AskResponse } from "./runtimeAsks.ts";
import type * as Store from "./store.ts";
import type { WorkspaceRecord } from "./store.ts";

export const CREDITS_ASK_PREFIX = "credits:";
/** Whether an ask is the runtime's own question before Caveman credits are spent. */
export const isCreditsAsk = (askId: string) => askId.startsWith(CREDITS_ASK_PREFIX);
export const USE_CREDITS = "use_credits";
export const NOT_NOW = "not_now";
/** The question, as the card shows it. */
export const CREDITS_ASK: Extract<SessionEvent, { type: "ask.user" }>["payload"] = {
  kind: "approval",
  title: "Run this chat on Caveman credits?",
  detail: "It carries on with the Caveman agent and sends your last message again.",
  options: [
    { id: USE_CREDITS, label: "Use Caveman credits", decision: "allow" },
    { id: NOT_NOW, label: "Not now", decision: "deny" },
  ],
};

export class CreditsAskError extends Schema.TaggedError<CreditsAskError>()("CreditsAskError", {
  reason: Schema.Literals(["not_found", "invalid_state", "invalid_params"]),
  message: Schema.String,
}) {}

/** How long the question waits for the turn that was refused to end before it shows anyway. */
const TURN_END_MS = 60_000;
/** How often it looks. */
const TURN_LOOK = Schedule.spaced("100 millis");

/**
 * How long until a waiting chat looks at the person's list again, `waited` after it was last refused: every few
 * seconds while they may be connecting a plan right now (never faster than the list itself is read again), then slower.
 */
export const lookAfter = (waited: number) =>
  waited < 2 * 60_000 ? 5_000 : waited < 60 * 60_000 ? 30_000 : 5 * 60_000;
/** A chat stops looking this long after it was last refused; one that waits for a used-up plan, not before that plan's time. */
export const GIVE_UP_MS = 24 * 60 * 60_000;
/** How long after a used-up plan's time the chat looks: clocks differ by a moment, and Cloud's decides. */
const RESET_MARGIN_MS = 2_000;
/** How long past a used-up plan's time a chat that waits for it still looks. */
const RESET_GRACE_MS = 10 * 60_000;
/** A message is sent again by itself at most this often: a list that says ready while requests are refused never loops. */
export const MAX_SENDS = 3;
/** After a message sent again was refused again, the chat first looks this much later (by how often it was sent). */
const AGAIN_MS = [0, 60_000, 5 * 60_000];
/** A message of the person's journaled this long after the last refusal was heard is not the one that was refused. */
const SENT_AFTER_MS = 2_000;

/** Sends `text` as a chat's next turn on the chat's own engine. */
export type SendAgain = (
  record: WorkspaceRecord,
  text: string,
) => Effect.Effect<unknown, { readonly message: string }>;

const senders = new WeakMap<LinkState, SendAgain>();
/**
 * How a chat that waited sends the person's last message again, for the runtime whose link `link` is. Said by the
 * runtime's composition root once its handlers exist (session-protocol/server.ts): turn.submit is theirs, and these
 * notes are made while they still are. Without it nothing waits, and no note says a chat carries on.
 */
export const carryOnWith = (link: LinkState, send: SendAgain) => void senders.set(link, send);

/** A chat nothing serves, waiting for something that does. */
interface Waiting {
  readonly engine: ServedEngine;
  /** For the Caveman engine: the provider whose key its model runs on. */
  readonly provider: string | undefined;
  /** When the chat was last refused. */
  readonly heard: number;
  /** When a used-up connection that would serve it resets, where a time is known. */
  readonly until: number | undefined;
  /** It is not looked at before: after a message sent again was refused again. */
  readonly notBefore: number;
  /** What its note said, so a turn's many refusals say it once. */
  readonly noted: string;
}

export const makeConnectionNotes = (input: {
  readonly store: Store.SessionStore["Service"];
  readonly link: LinkState;
  readonly note: (
    record: WorkspaceRecord,
    level: "info" | "warning",
    title: string,
    body?: string,
  ) => Effect.Effect<unknown>;
  /** Sends `text` as the chat's next turn on the Caveman engine's credits model. */
  readonly onCredits: (
    record: WorkspaceRecord,
    text: string,
    model: string,
  ) => Effect.Effect<unknown, { readonly message: string }>;
  /** Sends `text` again on the chat's own engine, once something serves it; absent, what `carryOnWith` said for `link`. */
  readonly onServed?: SendAgain;
  readonly now?: () => number;
}) =>
  Effect.gen(function* () {
    const { store } = input;
    const asks = makeRuntimeAsks(store);
    const run = Effect.runForkWith(yield* Effect.context<never>());
    const scope = yield* Effect.scope;
    const clock = input.now ?? Date.now;
    /** Each note once per chat: a connection that ran out says so again only for a new time. */
    const said = new Set<string>();
    /** The chat's open credits question, so a turn's many requests ask once. */
    const asking = new Map<string, string>();
    /** The chats that wait for something to serve their engine, by session. A newer refusal replaces the entry, and what watched the old one ends. */
    const waiting = new Map<string, Waiting>();
    /** The person's message a chat last sent again by itself, and how often. */
    const sent = new Map<
      string,
      { readonly cursor: number; readonly text: string; readonly times: number }
    >();

    /** This runtime's connections: a Cloud computer's under the rule, else this Mac's. */
    const connections = () =>
      connectionsOf(input.link) ?? macConnectionsOf(input.link)?.connections;
    const place = (): Place => (connectionsOf(input.link) === undefined ? "mac" : "cloud");
    const sender = () => input.onServed ?? senders.get(input.link);

    const recordOf = (session: string | undefined) =>
      session === undefined
        ? Effect.succeed(undefined)
        : store.listWorkspaces().pipe(
            Effect.map((records) =>
              records.find(
                (r) =>
                  proxySession(r.internal.threadId) === session || r.internal.threadId === session,
              ),
            ),
            Effect.orElseSucceed(() => undefined),
          );
    const once = (record: WorkspaceRecord, key: string) => {
      const full = `${record.session.id}\0${key}`;
      if (said.has(full)) return false;
      said.add(full);
      return true;
    };
    /** The person's last message: its text, where it is in the journal, and when it was journaled. */
    const lastMessage = (sessionId: string) =>
      store.sql<{
        cursor: number;
        text: string | null;
        at: string | null;
      }>`SELECT cursor, json_extract(event, '$.payload.text') AS text, json_extract(event, '$.at') AS at FROM caveman_sp_events
        WHERE session_id = ${sessionId} AND type = 'message.done' AND json_extract(event, '$.payload.role') = 'user'
          AND json_extract(event, '$.payload.from') IS NULL
        ORDER BY cursor DESC LIMIT 1`.pipe(
        Effect.map((rows) =>
          rows[0] === undefined || rows[0].text === null
            ? undefined
            : {
                cursor: rows[0].cursor,
                text: rows[0].text,
                at: rows[0].at === null ? Number.NaN : Date.parse(rows[0].at),
              },
        ),
        Effect.orElseSucceed(() => undefined),
      );
    /** How the turns that ended after `cursor` ended, in order. */
    const endedSince = (sessionId: string, cursor: number) =>
      store.sql<{
        status: string | null;
      }>`SELECT json_extract(event, '$.payload.status') AS status FROM caveman_sp_events
        WHERE session_id = ${sessionId} AND type = 'turn.done' AND cursor > ${cursor} ORDER BY cursor`.pipe(
        Effect.map((rows) => rows.map((row) => row.status)),
        Effect.orElseSucceed((): Array<string | null> => []),
      );

    /** The question `askId`, once the refused turn has ended: while it runs, the card would close with it. */
    const ask = (record: WorkspaceRecord, askId: string) =>
      Effect.gen(function* () {
        yield* Effect.repeat(asks.runningTurn(record.internal.threadId), {
          until: (turn) => turn === undefined,
          schedule: TURN_LOOK,
        }).pipe(Effect.timeoutOption(TURN_END_MS));
        // The chat carried on by itself meanwhile: nothing to ask.
        if (asking.get(record.session.id) !== askId) return;
        yield* asks.withState(record, (state) => {
          state.asks[askId] = "open";
          const event = {
            at: new Date().toISOString(),
            type: "ask.user",
            item_id: askId,
            payload: CREDITS_ASK,
          } as DraftEvent;
          return { value: undefined, drafts: [event] };
        });
      });

    /** The chat's open credits question closes as not answered: nothing is spent. */
    const closeAsk = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        const askId = asking.get(record.session.id);
        if (askId === undefined) return;
        asking.delete(record.session.id);
        const posted = yield* asks.askEvent(record.session.id, askId);
        if (posted !== undefined) yield* asks.close(record, posted, "cancelled");
      });

    /**
     * Something serves the waiting chat's engine: its last message goes again, on the chat's own engine. "later" while
     * a turn still runs (the refused one has not ended, or another runs: once it ends, how it ended decides) or this
     * Mac goes to sleep. The chat is left alone ("left") where it is gone or archived, runs another engine now, or
     * the person's last message is not one that was refused: a turn since ended well, they stopped it, or they sent it
     * after the last refusal.
     */
    const carryOn = (sessionId: string, wait: Waiting) =>
      Effect.gen(function* () {
        const send = sender();
        const record = yield* store.getBySession(sessionId);
        if (
          send === undefined ||
          record === undefined ||
          record.workspace.status === "archived" ||
          record.workspace.status === "parked" ||
          record.workspace.engine !== wait.engine
        )
          return "left" as const;
        if (input.link.suspending === true || input.link.parked !== undefined)
          return "later" as const;
        if ((yield* asks.runningTurn(record.internal.threadId)) !== undefined)
          return "later" as const;
        const last = yield* lastMessage(sessionId);
        if (last === undefined || last.text === "" || last.at > wait.heard + SENT_AFTER_MS)
          return "left" as const;
        const ended = yield* endedSince(sessionId, last.cursor);
        if (ended.at(-1) !== "failed" || ended.includes("completed")) return "left" as const;
        // From here the chat no longer waits: a refusal of what is sent now begins a wait of its own.
        waiting.delete(sessionId);
        yield* closeAsk(record);
        const before = sent.get(sessionId);
        sent.set(sessionId, {
          cursor: last.cursor,
          text: last.text,
          times:
            before !== undefined && before.text === last.text && last.cursor >= before.cursor
              ? before.times + 1
              : 1,
        });
        yield* send(record, last.text).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `A chat that waited for a plan or key did not carry on: ${error.message}`,
            ),
          ),
        );
        return "sent" as const;
      });

    /** Looks at the person's list for `wait`, at its pace and at a used-up plan's time, until something serves the chat or it gives up. */
    const watch = (sessionId: string, wait: Waiting) =>
      Effect.gen(function* () {
        while (waiting.get(sessionId) === wait) {
          const now = clock();
          if (
            now >=
            Math.max(
              wait.heard + GIVE_UP_MS,
              wait.until === undefined ? 0 : wait.until + RESET_GRACE_MS,
            )
          )
            break;
          const reset =
            wait.until === undefined
              ? Number.POSITIVE_INFINITY
              : wait.until + RESET_MARGIN_MS - now;
          yield* Effect.sleep(
            Math.max(
              Math.min(lookAfter(now - wait.heard), reset > 0 ? reset : Number.POSITIVE_INFINITY),
              wait.notBefore - now,
              0,
            ),
          );
          if (waiting.get(sessionId) !== wait) return;
          const serving = yield* Effect.tryPromise(
            async () => (await connections()?.serving(wait.engine, wait.provider)) ?? [],
          ).pipe(Effect.orElseSucceed(() => []));
          if (serving.length === 0) continue;
          if ((yield* carryOn(sessionId, wait)) !== "later") break;
        }
        if (waiting.get(sessionId) === wait) waiting.delete(sessionId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A chat that waits for a plan or key stopped looking", cause),
        ),
      );

    /**
     * Nothing serves the chat's engine: one note that says why and what happens next, the chat waits for something
     * that serves it, and the credits question follows once the turn has ended. A turn's many refused requests say it
     * once, wait once and ask once.
     */
    const refused = (
      record: WorkspaceRecord,
      answer: Extract<DataPlaneAnswer, { type: "no_connection" }>,
    ) =>
      Effect.gen(function* () {
        const sessionId = record.session.id;
        const { why } = answer;
        const until =
          why.reason === "used_up" && why.until !== undefined ? Date.parse(why.until) : undefined;
        // What was refused is the person's last message unless a turn ended well since it: then an agent's or a
        // schedule's message was, and nothing of theirs waits to be sent again.
        const last = yield* lastMessage(sessionId);
        const theirs =
          last !== undefined &&
          last.text !== "" &&
          !(yield* endedSince(sessionId, last.cursor)).includes("completed");
        // From here until the chat is marked as waiting and asking, nothing else runs: two requests refused at once say it once.
        const now = clock();
        const held = waiting.get(sessionId);
        // A message this chat already sent again by itself, refused again: it looks later each time, and a third time is the last.
        const before = sent.get(sessionId);
        const times =
          before !== undefined &&
          last !== undefined &&
          before.text === last.text &&
          last.cursor >= before.cursor
            ? before.times
            : 0;
        const waits =
          held !== undefined ||
          (theirs && sender() !== undefined && connections() !== undefined && times < MAX_SENDS);
        const key = [
          why.reason,
          why.reason === "none" ? "" : why.connection.id,
          why.reason === "used_up" ? (why.until ?? "") : "",
          answer.engine,
          answer.provider ?? "",
          waits,
        ].join("\0");
        const says = held === undefined ? waits || !asking.has(sessionId) : held.noted !== key;
        const wait: Waiting | undefined = waits
          ? {
              engine: answer.engine,
              provider: answer.provider,
              heard: now,
              until,
              notBefore: held?.notBefore ?? now + (AGAIN_MS[times] ?? 0),
              noted: key,
            }
          : undefined;
        if (wait !== undefined) waiting.set(sessionId, wait);
        const askId = asking.has(sessionId) ? undefined : `${CREDITS_ASK_PREFIX}${randomUUID()}`;
        if (askId !== undefined) asking.set(sessionId, askId);
        if (says) {
          // A Cloud that slept before the plan's time forgets the wait (it is kept in memory), so only a Mac says when
          // the chat carries on; in Cloud the note says until when, and the chat still carries on if Cloud is awake then.
          const words = nothingServesNote(answer, now, {
            place: place(),
            carriesOn: waits && place() === "mac",
          });
          yield* input.note(record, "warning", words.title, words.body);
        }
        if (wait !== undefined) yield* watch(sessionId, wait).pipe(Effect.forkIn(scope));
        if (askId !== undefined) yield* ask(record, askId);
      });

    const heard = (answer: DataPlaneAnswer) =>
      Effect.gen(function* () {
        const record = yield* recordOf(answer.session);
        // A request no chat made (a title, a commit message): nothing to say it in.
        if (record === undefined) return;
        if (answer.type === "used_up") {
          // Said again where the chat then runs on this Mac's login: that is news the first note did not carry.
          if (
            once(
              record,
              `used_up\0${answer.connection.id}\0${answer.until ?? ""}${answer.own === true ? "\0own" : ""}`,
            )
          )
            yield* input.note(record, "info", usedUpNote(answer, clock()));
          return;
        }
        if (answer.type === "kind_off") {
          if (once(record, `kind_off\0${answer.connection.kind}`))
            yield* input.note(record, "info", kindOffNote(answer));
          return;
        }
        yield* refused(record, answer);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A data plane answer did not reach its chat", cause),
        ),
      );

    const stop = onDataPlaneAnswer(input.link, (answer) => void run(heard(answer)));
    yield* Effect.addFinalizer(() => Effect.sync(stop));

    /** The person's answer: the card closes, and on yes their last message runs on Caveman credits. */
    const respond = (record: WorkspaceRecord, askId: string, response: AskResponse) =>
      Effect.gen(function* () {
        const posted = yield* asks.askEvent(record.session.id, askId);
        if (posted === undefined)
          return yield* new CreditsAskError({ reason: "not_found", message: `no ask ${askId}` });
        if (
          response.kind !== "approval" ||
          (response.option_id !== USE_CREDITS && response.option_id !== NOT_NOW)
        ) {
          return yield* new CreditsAskError({
            reason: "invalid_params",
            message: `option_id must be ${USE_CREDITS} or ${NOT_NOW}`,
          });
        }
        if (
          !(yield* asks.close(record, posted, "answered", {
            kind: "approval",
            option_id: response.option_id,
          }))
        ) {
          return yield* new CreditsAskError({
            reason: "invalid_state",
            message: "this ask was already answered",
          });
        }
        if (asking.get(record.session.id) === askId) asking.delete(record.session.id);
        if (response.option_id !== USE_CREDITS) return;
        // The chat runs on credits from here: it no longer waits for a plan, and its message is never sent twice.
        waiting.delete(record.session.id);
        const text = (yield* lastMessage(record.session.id))?.text;
        if (text === undefined || text === "")
          return yield* new CreditsAskError({
            reason: "invalid_state",
            message: "this chat has no message of yours to send again",
          });
        yield* input
          .onCredits(record, text, CREDITS_DEFAULT_MODEL)
          .pipe(
            Effect.mapError(
              (error) => new CreditsAskError({ reason: "invalid_state", message: error.message }),
            ),
          );
      });

    return { respond };
  });
