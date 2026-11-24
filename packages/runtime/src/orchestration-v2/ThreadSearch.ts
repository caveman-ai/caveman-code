// ), apps/server/src/orchestration-v2/ThreadSearch.ts @ ab3a3cd1.
import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";

import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";

/** Carries no query text: search input is user content. */
export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const SearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
  /** Message ids, as a JSON array, that matched only on a secret's value. */
  excluded: Schema.String,
});
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  messageId: Schema.String,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
const ThreadMatchesRequest = Schema.Struct({
  pattern: Schema.String,
  /** Thread ids, as a JSON array. */
  threadIds: Schema.String,
  excluded: Schema.String,
});
const ThreadMatchRow = Schema.Struct({ messageId: Schema.String, matchText: Schema.String });

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** At most 240 characters, centred near the first match. */
function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

/**
 * Searches the finished user and assistant messages of active V2 threads in
 * active projects, as their readers see them: with every repository's secret
 * values masked. Legacy V1 transcripts that have not been imported yet are
 * not searched.
 */
export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ProjectSecrets;

  // One best match per thread: user messages outrank assistant ones, then the
  // newest message wins. Threads order by match kind, then recency.
  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ pattern, limit, excluded }) => sql`
      WITH candidate AS (
        SELECT
          threads.thread_id,
          threads.project_id,
          messages.role,
          json_extract(messages.payload_json, '$.text') AS match_text,
          messages.created_at AS message_created_at,
          messages.message_id,
          threads.updated_at AS thread_updated_at
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
          AND messages.message_id NOT IN (SELECT value FROM json_each(${excluded}))
      ),
      ranked AS (
        SELECT
          thread_id,
          project_id,
          role AS source,
          message_id,
          match_text,
          message_created_at,
          CASE role WHEN 'user' THEN 0 ELSE 1 END AS match_rank,
          thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE role WHEN 'user' THEN 0 ELSE 1 END ASC,
              message_created_at DESC,
              message_id ASC
          ) AS thread_match_rank
        FROM candidate
      )
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        source,
        message_id AS "messageId",
        match_text AS "matchText",
        message_created_at AS "messageCreatedAt"
      FROM ranked
      WHERE thread_match_rank = 1
      ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC
      LIMIT ${limit}
    `,
  });

  // Every message of the given threads that the search matches.
  const threadMatches = SqlSchema.findAll({
    Request: ThreadMatchesRequest,
    Result: ThreadMatchRow,
    execute: ({ pattern, threadIds, excluded }) => sql`
      SELECT
        messages.message_id AS "messageId",
        json_extract(messages.payload_json, '$.text') AS "matchText"
      FROM orchestration_v2_projection_messages AS messages
      WHERE messages.thread_id IN (SELECT value FROM json_each(${threadIds}))
        AND messages.streaming = 0
        AND messages.role IN ('user', 'assistant')
        AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
        AND messages.message_id NOT IN (SELECT value FROM json_each(${excluded}))
    `,
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      // The store keeps messages as they were sent, and a message can hold a value stored as a secret after it. A
      // match is a match on the text with every value masked: a thread that matched only on a value would confirm a
      // guessed piece of it, however masked its snippet. Such messages are left out and the search runs again, so
      // their threads still match on any other message.
      const scrubber = yield* secrets.scrubber;
      const needle = foldAsciiCase(input.query);
      const pattern = `%${escapeLikePattern(input.query)}%`;
      const matchesOnlyOnValues = (text: string) =>
        !foldAsciiCase(scrubber.scrub(text)).includes(needle);
      // The scan reads every message, so run it on the reader worker rather than the event loop.
      const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        sql.withTransaction(effect).pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(
            (cause) =>
              new ThreadSearchError({
                operation: Schema.isSchemaError(cause) ? "decode" : "query",
                cause,
              }),
          ),
        );
      const excluded: Array<string> = [];
      while (true) {
        const rows = yield* read(
          searchRows({ pattern, limit: input.limit ?? 50, excluded: JSON.stringify(excluded) }),
        );
        const masked = rows.map((row) => ({ row, text: scrubber.scrub(row.matchText) }));
        const onValues = masked.filter(({ text }) => !foldAsciiCase(text).includes(needle));
        if (onValues.length > 0) {
          // Leaving out one message per thread per scan cost a scan of every message for each paste of a value in a
          // thread. Every message of these threads that matches only on a value goes at once, so none of them comes
          // back as a thread's best match.
          const inThreads = yield* read(
            threadMatches({
              pattern,
              threadIds: JSON.stringify(onValues.map(({ row }) => row.threadId)),
              excluded: JSON.stringify(excluded),
            }),
          );
          excluded.push(
            ...inThreads
              .filter((row) => matchesOnlyOnValues(row.matchText))
              .map((row) => row.messageId),
          );
          continue;
        }
        return {
          matches: masked.map(({ row, text }) => ({
            threadId: row.threadId,
            projectId: row.projectId,
            source: row.source,
            // Cut from the masked text, so a value is never cut in two at the snippet's edge.
            snippet: buildSearchSnippet(text, input.query),
            messageCreatedAt: row.messageCreatedAt,
          })),
        };
      }
    },
  );

  return ThreadSearch.of({ search });
});

export const layer = Layer.effect(ThreadSearch, make);
