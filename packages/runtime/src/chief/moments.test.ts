import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import type { ChiefMoment } from "@caveman-app/session-protocol";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vitest";

import type { DraftEvent } from "../session-protocol/projector.ts";
import type { SessionStore, WorkspaceRecord } from "../session-protocol/store.ts";
import { askedIn, needsYou, writeMoment } from "./moments.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const chief = {
  workspace: { id: "chief-1", kind: "chief" },
  session: { id: "s-chief" },
} as unknown as WorkspaceRecord;

/** writeMoment on a real events table: `append` journals what its build returns, in one transaction, as the store does. */
const writing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(
    `CREATE TABLE caveman_sp_events (session_id TEXT NOT NULL, cursor INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY (session_id, cursor))`,
  );
  let cursor = 0;
  const append = <A>(
    sessionId: string,
    build: (
      record: WorkspaceRecord,
    ) => Effect.Effect<{ readonly events: ReadonlyArray<DraftEvent>; readonly value: A }>,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const built = yield* build(chief);
        for (const event of built.events) {
          cursor += 1;
          yield* sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (${sessionId}, ${cursor}, ${event.type}, ${event.at}, ${JSON.stringify({ ...event, session_id: sessionId, cursor })})`;
        }
        return { events: [], value: built.value };
      }),
    );
  const store = { sql, append } as unknown as SessionStore["Service"];
  return (moment: ChiefMoment) => writeMoment(store, chief, moment, "title").pipe(Effect.orDie);
});

describe("writeMoment", () => {
  it.effect("keeps the latest reaction per message, skipping only an unchanged emoji", () =>
    Effect.gen(function* () {
      const write = yield* writing;
      const first = { kind: "reaction", message_id: "message-1", emoji: "👍" } as const;
      expect(yield* write(first)).toBe(true);
      expect(yield* write(first)).toBe(false);
      expect(yield* write({ ...first, emoji: "✅" })).toBe(true);
      expect(yield* write({ ...first, emoji: "✅" })).toBe(false);
      expect(yield* write({ ...first, message_id: "message-2", emoji: "✅" })).toBe(true);
      // Changing back still writes, even though an older reaction used this emoji.
      expect(yield* write(first)).toBe(true);
      expect(yield* write({ ...first, message_id: "message-2", emoji: "✅" })).toBe(false);
    }).pipe(Effect.provide(sqlite)),
  );
  it.effect(
    "writes each moment once: started per chat, a card per ask, a worded question per wording, a result per item",
    () =>
      Effect.gen(function* () {
        const write = yield* writing;
        expect(yield* write({ kind: "started", workspace_id: "w1" })).toBe(true);
        expect(yield* write({ kind: "started", workspace_id: "w1" })).toBe(false);
        expect(yield* write({ kind: "started", workspace_id: "w2" })).toBe(true);

        const card = {
          kind: "needs_you",
          workspace_id: "w1",
          text: "Comma or semicolon?",
          ask: { id: "ask-1", kind: "question" },
        } as const;
        expect(yield* write(card)).toBe(true);
        expect(yield* write(card)).toBe(false);
        expect(yield* write({ ...card, ask: { id: "ask-2", kind: "question" } })).toBe(true);

        // A question asked in its report: no card id, so its words tell it apart, and a card's same words are no match.
        const worded = {
          kind: "needs_you",
          workspace_id: "w1",
          ...askedIn("Comma or semicolon?"),
        } as const;
        expect(yield* write(worded)).toBe(true);
        expect(yield* write(worded)).toBe(false);
        expect(yield* write({ ...worded, ...askedIn("Quote every field?") })).toBe(true);

        expect(yield* write({ kind: "result", workspace_id: "w1", item_id: "i1" })).toBe(true);
        expect(yield* write({ kind: "result", workspace_id: "w1", item_id: "i1" })).toBe(false);
        expect(yield* write({ kind: "result", workspace_id: "w1", item_id: "i2" })).toBe(true);
      }).pipe(Effect.provide(sqlite)),
  );
});

describe("needsYou", () => {
  const question = (id: string, prompt: string) => ({
    id,
    prompt,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    recommended: "a",
    allow_text: false,
    multi_select: false,
  });
  it("offers the recommended answer for one question, and none for several, which one click would answer in part", () => {
    expect(
      needsYou({ kind: "question", questions: [question("q1", "Which database?")] }, "ask-1"),
    ).toEqual({
      text: "Which database?",
      ask: {
        id: "ask-1",
        kind: "question",
        question_id: "q1",
        recommended: { option_id: "a", label: "A" },
      },
    });
    expect(
      needsYou(
        {
          kind: "question",
          questions: [question("q1", "Which database?"), question("q2", "Which region?")],
        },
        "ask-2",
      ),
    ).toEqual({
      text: "Which database?",
      ask: { id: "ask-2", kind: "question" },
    });
  });
});
