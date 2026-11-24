// Corrections made by the person, kept for the Chief's next session without a model remembering them.
import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { Item } from "./Board.ts";

export type LessonKind =
  | "dropped_suggestion"
  | "rewrote_after_draft"
  | "moved_projects"
  | "removed"
  | "reordered";

export interface Lesson {
  readonly id: string;
  readonly chief_id: string;
  readonly item_id: string;
  readonly kind: LessonKind;
  readonly text: string;
  readonly at: string;
}

/** Project names in project_ids; position is one-based, among this Chief's open items. */
export type LessonItem = Pick<Item, "text" | "title" | "project_ids"> & {
  readonly position?: number;
};

const words = (text: string) => text.replace(/\s+/g, " ").trim();
const quoted = (text: string) => {
  const line = words(text);
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
};
const title = (item: LessonItem) => quoted(item.title ?? item.text);

/** The correction in the Chief's voice, from the item after the change and, when needed, before it. */
export const lessonText = (kind: LessonKind, item: LessonItem, before?: LessonItem): string => {
  switch (kind) {
    case "dropped_suggestion":
      return `They dropped my suggestion '${title(before ?? item)}'.`;
    case "rewrote_after_draft":
      return `They rewrote '${quoted((before ?? item).text)}' after I drafted it: '${quoted(item.text)}'.`;
    case "moved_projects":
      return `They moved '${title(item)}' from ${before?.project_ids.map(words).join(" + ") || "no project"} to ${item.project_ids.map(words).join(" + ") || "no project"}.`;
    case "removed":
      return `They removed '${title(item)}' from my board.`;
    case "reordered":
      return item.position === 1
        ? `They put '${title(item)}' first.`
        : item.position === undefined
          ? `They moved '${title(item)}' on my board.`
          : `They put '${title(item)}' at position ${item.position}.`;
  }
};

export const makeLessonStore = (sql: SqlClient.SqlClient) => {
  const add = (lesson: Omit<Lesson, "id"> & { readonly id?: string }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO chief_lessons (id, chief_id, item_id, kind, text, at)
          VALUES (${lesson.id ?? randomUUID()}, ${lesson.chief_id}, ${lesson.item_id}, ${lesson.kind}, ${lesson.text}, ${lesson.at})
          ON CONFLICT DO UPDATE SET text = excluded.text, at = excluded.at`;
          yield* sql`DELETE FROM chief_lessons WHERE chief_id = ${lesson.chief_id} AND id NOT IN
          (SELECT id FROM chief_lessons WHERE chief_id = ${lesson.chief_id} ORDER BY at DESC, rowid DESC LIMIT 20)`;
        }),
      )
      .pipe(Effect.orDie);
  const of = (chiefId: string) =>
    sql<Lesson>`SELECT id, chief_id, item_id, kind, text, at FROM chief_lessons WHERE chief_id = ${chiefId} ORDER BY at DESC, rowid DESC LIMIT 20`.pipe(
      Effect.orDie,
    );
  return { add, of };
};
