import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, test } from "vitest";

import { lessonText, makeLessonStore, type Lesson, type LessonItem } from "./lessons.ts";
import { CHIEF_SCHEMA } from "./schema.ts";

const item = (text: string, project_ids: ReadonlyArray<string> = []): LessonItem => ({
  text,
  project_ids,
});
const lesson = (item_id: string, extra: Partial<Lesson> = {}): Omit<Lesson, "id"> => ({
  chief_id: "carl",
  item_id,
  kind: "removed",
  text: `They removed '${item_id}' from my board.`,
  at: "2026-11-17T09:00:00.000Z",
  ...extra,
});

describe("lessons from the person's corrections", () => {
  test("each kind says what they changed, from the Chief's side", () => {
    expect(lessonText("dropped_suggestion", item("Upgrade lodash"))).toBe(
      "They dropped my suggestion 'Upgrade lodash'.",
    );
    expect(
      lessonText("rewrote_after_draft", item("fix login on Safari only"), item("fix login")),
    ).toBe("They rewrote 'fix login' after I drafted it: 'fix login on Safari only'.");
    expect(
      lessonText("moved_projects", item("Docs pass", ["site"]), item("Docs pass", ["app"])),
    ).toBe("They moved 'Docs pass' from app to site.");
    expect(lessonText("removed", item("Weekly report"))).toBe(
      "They removed 'Weekly report' from my board.",
    );
    expect(lessonText("reordered", { ...item("Fix CI"), position: 1 })).toBe(
      "They put 'Fix CI' first.",
    );
    expect(lessonText("reordered", { ...item("Fix CI"), position: 3 })).toBe(
      "They put 'Fix CI' at position 3.",
    );
    expect(lessonText("reordered", item("Fix CI"))).toBe("They moved 'Fix CI' on my board.");
    expect(
      lessonText("dropped_suggestion", { ...item("a long note"), title: "Upgrade lodash" }),
    ).toBe("They dropped my suggestion 'Upgrade lodash'.");
    expect(
      lessonText("moved_projects", item("Docs\npass", ["app", "site"]), item("Docs pass")),
    ).toBe("They moved 'Docs pass' from no project to app + site.");
  });

  test("clips each quoted title or note to 160 characters, after flattening whitespace", () => {
    const long = "x".repeat(160);
    const clipped = `${"x".repeat(159)}…`;
    expect(lessonText("removed", item(long))).toContain(`'${long}'`);
    for (const kind of ["dropped_suggestion", "moved_projects", "removed", "reordered"] as const) {
      expect(lessonText(kind, item(`${long}\nmore`))).toContain(`'${clipped}'`);
      expect(lessonText(kind, { ...item("short"), title: `${long} more` })).toContain(
        `'${clipped}'`,
      );
    }
    expect(lessonText("rewrote_after_draft", item(`${long} new`), item(`${long} old`))).toBe(
      `They rewrote '${clipped}' after I drafted it: '${clipped}'.`,
    );
  });

  test("keeps only the newest 20 per Chief, newest first, including writes at the same time", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const statement of CHIEF_SCHEMA) yield* sql.unsafe(statement);
        const store = makeLessonStore(sql);
        yield* store.add(lesson("other", { chief_id: "other" }));
        for (let n = 0; n < 25; n++) yield* store.add(lesson(`i${n}`));
        yield* store.add(lesson("old", { at: "2026-11-16T09:00:00.000Z" }));
        return {
          own: yield* store.of("carl"),
          other: yield* store.of("other"),
          rows: yield* sql<{ n: number }>`SELECT count(*) AS n FROM chief_lessons`,
        };
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
    expect(result.own.map((l) => l.item_id)).toEqual(
      Array.from({ length: 20 }, (_, n) => `i${24 - n}`),
    );
    expect(result.other.map((l) => l.item_id)).toEqual(["other"]);
    expect(result.rows[0]?.n).toBe(21);
  });

  test("dedupes by Chief, item, kind and UTC day; a different kind or next day still teaches", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const statement of CHIEF_SCHEMA) yield* sql.unsafe(statement);
        const store = makeLessonStore(sql);
        yield* store.add(lesson("same"));
        yield* store.add(lesson("same", { text: "duplicate", at: "2026-11-17T23:59:59.999Z" }));
        yield* store.add(lesson("same", { kind: "reordered" }));
        yield* store.add(lesson("another"));
        yield* store.add(lesson("same", { at: "2026-11-18T00:00:00.000Z" }));
        yield* store.add(lesson("same", { chief_id: "other" }));
        return { own: yield* store.of("carl"), other: yield* store.of("other") };
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
    expect(result.own).toHaveLength(4);
    expect(result.own[0]?.at).toBe("2026-11-18T00:00:00.000Z");
    expect(result.own[1]).toMatchObject({ text: "duplicate", at: "2026-11-17T23:59:59.999Z" });
    expect(result.other).toHaveLength(1);
  });
});
