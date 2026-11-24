// The moments of a Chief's conversation (docs/chief.md "Its screen"): what the chats on its board do that the person
// reads, found in code from each chat's own events and written into the Chief's session as cards (a notification's
// `moment`), each once, with no model turn. Workers stay as they are: a plan is read from what a chat already does
// (its first edit after a stretch of reading), never asked of it. The model runs only where a moment needs a decision
// (watch.ts wakes): a question it may answer, a failure it may fix, a result to explain.
import type { ChiefMoment, SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import type { DraftEvent } from "../session-protocol/projector.ts";
import type { SessionStore, WorkspaceRecord } from "../session-protocol/store.ts";

/** A stretch of reading before a chat's first edit: at least this many read or search tools. */
export const PLAN_READS = 3;
/** What a plan card quotes of the chat's words at most. */
const PLAN_CHARS = 600;
/** What a needs-you card says of its question or wait at most. */
const ASK_CHARS = 400;

type ToolStarted = Extract<SessionEvent, { type: "tool.started" }>["payload"];
type AskUser = Extract<SessionEvent, { type: "ask.user" }>["payload"];

/** A command that only looks (Codex reads through its shell): printing, listing or searching files, or git history. */
const READING_COMMAND =
  /^\s*(?:cd\s+\S+\s*&&\s*)?(?:cat|rg|grep|sed\s+-n|head|tail|less|ls|find|fd|nl|wc|tree|git\s+(?:log|show|diff|status|grep|blame))\b/;

/** Whether a tool call reads: a read or search tool, or a command that only looks. */
export const reads = (tool: Pick<ToolStarted, "kind" | "title" | "input">) => {
  if (tool.kind === "read" || tool.kind === "search") return true;
  if (tool.kind !== "command") return false;
  const input = tool.input as { readonly command?: unknown } | null | undefined;
  const command =
    typeof input?.command === "string"
      ? input.command
      : Array.isArray(input?.command)
        ? input.command.join(" ")
        : tool.title;
  return READING_COMMAND.test(command);
};

const flat = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The plan a chat showed at its first edit (the edit at `cursor` or one before it): the words it wrote just before it
 * (its latest answer with text), when at least PLAN_READS reading calls came first. Read from its journal, so a first
 * edit the watcher never handled (journaled just before a quit) is still found at the chat's next one.
 */
export const planAt = (
  store: Pick<SessionStore["Service"], "sql">,
  chat: WorkspaceRecord,
  cursor: number,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const calls = yield* store.sql<{
      cursor: number;
      id: string | null;
      kind: string | null;
      title: string | null;
      input: string | null;
    }>`SELECT cursor, json_extract(event, '$.item_id') AS id,
        json_extract(event, '$.payload.kind') AS kind, json_extract(event, '$.payload.title') AS title, json_extract(event, '$.payload.input') AS input
      FROM caveman_sp_events WHERE session_id = ${chat.session.id} AND type = 'tool.started' AND cursor <= ${cursor} ORDER BY cursor`;
    // An engine may start one call twice (its input arriving late): each call counts once, by its id, where it began.
    const seen = new Map<
      string,
      {
        readonly cursor: number;
        readonly kind: string;
        readonly title: string;
        readonly input: unknown;
      }
    >();
    for (const row of calls) {
      if (row.id === null || row.kind === null) continue;
      const input =
        row.input === null
          ? undefined
          : (() => {
              try {
                return JSON.parse(row.input) as unknown;
              } catch {
                return row.input;
              }
            })();
      seen.set(row.id, {
        cursor: seen.get(row.id)?.cursor ?? row.cursor,
        kind: row.kind,
        title: row.title ?? "",
        input,
      });
    }
    const edits = [...seen.values()]
      .filter((call) => call.kind === "edit")
      .map((call) => call.cursor);
    if (edits.length === 0) return undefined;
    const first = Math.min(...edits);
    const reading = [...seen.values()].filter(
      (call) =>
        call.cursor < first &&
        reads({ kind: call.kind as ToolStarted["kind"], title: call.title, input: call.input }),
    ).length;
    if (reading < PLAN_READS) return undefined;
    const [words] = yield* store.sql<{
      text: string | null;
    }>`SELECT json_extract(event, '$.payload.text') AS text FROM caveman_sp_events
      WHERE session_id = ${chat.session.id} AND type = 'message.done' AND json_extract(event, '$.payload.role') = 'assistant' AND cursor < ${first}
        AND trim(coalesce(json_extract(event, '$.payload.text'), '')) != '' ORDER BY cursor DESC LIMIT 1`;
    return words?.text ? flat(words.text, PLAN_CHARS) : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** A needs-you moment's words and card: the question (and the option the chat recommends), or what it waits on. */
export const needsYou = (ask: AskUser, askId: string): Pick<ChiefMoment, "text" | "ask"> => {
  if (ask.kind === "question") {
    const first = ask.questions[0];
    const recommended = first?.options.find((o) => o.id === first.recommended);
    // One click answers one question: none for several (it would answer only the first) or a grill round.
    const one = first !== undefined && ask.questions.length === 1 && ask.round === undefined;
    return {
      text: flat(first?.prompt ?? "It asks a question.", ASK_CHARS),
      ask: {
        id: askId,
        kind: "question",
        ...(one ? { question_id: first.id } : {}),
        ...(one && recommended
          ? { recommended: { option_id: recommended.id, label: recommended.label } }
          : {}),
      },
    };
  }
  const text =
    ask.kind === "approval"
      ? `Approve: ${ask.title}`
      : ask.kind === "secret"
        ? `The secret ${ask.name}: ${ask.reason}`
        : `Your app to run ${ask.name}`;
  return { text: flat(text, ASK_CHARS), ask: { id: askId, kind: ask.kind } };
};

/** A needs-you moment for a question a chat asked in its report (Status: question) rather than on a card: its words. */
export const askedIn = (question: string): Pick<ChiefMoment, "text"> => ({
  text: flat(question, ASK_CHARS),
});

/** The line a client without moments shows for one (its notification's title); `chat` names a news moment's routine. */
export const momentTitle = (moment: ChiefMoment, chat: string) =>
  moment.kind === "reaction"
    ? `Reacted ${moment.emoji ?? ""}`.trim()
    : moment.kind === "started"
      ? `Started ${chat}`
      : moment.kind === "plan"
        ? `${chat}: its plan`
        : moment.kind === "needs_you"
          ? `${chat} needs you`
          : moment.kind === "result"
            ? `${chat} finished`
            : `${chat} found something`;

/**
 * Writes a moment into a Chief's session (as its notification) unless it is there already: a chat's started and plan
 * once, its needs_you once per card (a question asked in words, once per wording), its result once per item it works on
 * (a rebase or a fixed check after it is the same request), a routine's news once per run. Checked inside the append's
 * transaction, so two writers never post one twice. Reactions compare only the latest emoji on that message: changing
 * it writes a new moment, changing it back does too. True when it wrote it.
 */
export const writeMoment = (
  store: Pick<SessionStore["Service"], "sql" | "append">,
  chief: WorkspaceRecord,
  moment: ChiefMoment,
  title: string,
) =>
  store
    .append(chief.session.id, () =>
      Effect.gen(function* () {
        if (moment.kind === "reaction") {
          const [latest] = yield* store.sql<{
            emoji: string | null;
          }>`SELECT json_extract(event, '$.payload.moment.emoji') AS emoji
            FROM caveman_sp_events WHERE session_id = ${chief.session.id} AND type = 'notification'
              AND json_extract(event, '$.payload.moment.kind') = 'reaction'
              AND json_extract(event, '$.payload.moment.message_id') = ${moment.message_id ?? null}
            ORDER BY cursor DESC LIMIT 1`.pipe(Effect.orDie);
          if (latest !== undefined && latest.emoji === moment.emoji)
            return { events: [], value: false };
        } else {
          const item = moment.kind === "result" ? (moment.item_id ?? null) : null;
          // A question asked in words has no card id: its words tell one from the next.
          const words =
            moment.kind === "needs_you" && moment.ask === undefined ? (moment.text ?? "") : null;
          const [there] = yield* store.sql<{
            n: number;
          }>`SELECT count(*) AS n FROM caveman_sp_events WHERE session_id = ${chief.session.id} AND type = 'notification'
          AND json_extract(event, '$.payload.moment.kind') = ${moment.kind}
          AND json_extract(event, '$.payload.moment.workspace_id') IS ${moment.workspace_id ?? null}
          AND (${moment.ask?.id ?? null} IS NULL OR json_extract(event, '$.payload.moment.ask.id') = ${moment.ask?.id ?? null})
          AND (${item} IS NULL OR json_extract(event, '$.payload.moment.item_id') = ${item})
          AND (${words} IS NULL OR (json_extract(event, '$.payload.moment.ask') IS NULL AND json_extract(event, '$.payload.moment.text') = ${words}))
          AND (${moment.routine?.run_id ?? null} IS NULL OR json_extract(event, '$.payload.moment.routine.run_id') = ${moment.routine?.run_id ?? null})`.pipe(
            Effect.orElseSucceed(() => [{ n: 0 }]),
          );
          if ((there?.n ?? 0) > 0) return { events: [], value: false };
        }
        const event = {
          at: new Date().toISOString(),
          type: "notification",
          payload: { level: "info", title, moment },
        } as DraftEvent;
        return { events: [event], value: true };
      }),
    )
    .pipe(Effect.map((r) => r.value));
