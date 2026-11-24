// The Session Protocol projector is the runtime's own worker, and one event's failure never stops every chat's journal.
// When the database refuses its write (full, read-only, an I/O error), the event goes again once the database takes
// writes, so nothing is lost. An event the projection itself cannot take, or whose rows break a constraint, is skipped,
// so it cannot stop the projector, now or at every start after.
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { CommandId, ThreadId } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  orchestratorOf,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

const root = tempRoot("sp-projector-recovery-");
/** What the runtime logged about its projector. */
const logged: Array<string> = [];
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
/** The runtime's own SqlClient: its one writer, which the projector commits on. */
let sql: SqlClient.SqlClient;
const captureSql = Layer.effectDiscard(
  Effect.gen(function* () {
    sql = yield* SqlClient.SqlClient;
  }),
);

beforeAll(async () => {
  config = await makeConfig();
  const projectorLog = Logger.make(({ message, cause }) => {
    const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
    if (text.includes("session protocol projector")) logged.push(`${text} ${Cause.pretty(cause)}`);
  });
  runtime = await startRuntime(config, "fake-claude", undefined, {
    provide: Layer.mergeAll(
      Logger.layer([projectorLog], { mergeWithExisting: true }),
      captureSql,
    ) as unknown as Layer.Layer<any>,
  });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const chat = (name: string) =>
  createReady(client, {
    request_id: name,
    repo: { path: makeRepo(root, { "README.md": `${name}\n` }) },
    engine: "claude-agent",
    options: { model: MODEL },
  });
const rename = (workspaceId: string, title: string) =>
  Effect.runPromise(
    orchestratorOf(runtime).dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`rename:${workspaceId}:${title}`),
      threadId: ThreadId.make(`caveman:${workspaceId}`),
      title,
    }),
  );
const titled = (workspaceId: string, title: string) =>
  until(
    async () => (await client.call("workspace.get", { workspace_id: workspaceId })).title === title,
    30_000,
  ).then(
    () => title,
    async () => (await client.call("workspace.get", { workspace_id: workspaceId })).title,
  );
const onDatabase = (statements: string) => {
  const db = new DatabaseSync(config.dbPath);
  try {
    db.exec(statements);
  } finally {
    db.close();
  }
};

test("an event the projection cannot take is skipped: every other chat keeps journaling", async () => {
  const broken = await chat("broken");
  const other = await chat("other");
  // The broken chat's projector state no longer parses: each of its events now fails in the projection, as an event
  // the projector's code cannot take would, every time.
  onDatabase(
    `UPDATE caveman_sp_thread_state SET state = '{' WHERE thread_id = 'caveman:${broken.id}'`,
  );
  await rename(broken.id, "Renamed while broken");
  await rename(other.id, "Still journaling");
  expect(await titled(other.id, "Still journaling")).toBe("Still journaling");
  expect(logged.some((line) => line.includes("skipped"))).toBe(true);
}, 120_000);

test("an event a rule of the database refuses is skipped: every other chat keeps journaling", async () => {
  const first = await chat("first");
  const second = await chat("second");
  const other = await chat("third");
  // These two chats may not share a title: a constraint only the second's rename breaks, however often it goes again.
  onDatabase(
    `CREATE UNIQUE INDEX one_title ON caveman_sp_workspaces (json_extract(workspace, '$.title')) WHERE thread_id IN ('caveman:${first.id}', 'caveman:${second.id}')`,
  );
  const before = logged.length;
  await rename(first.id, "Taken");
  await rename(second.id, "Taken");
  await rename(other.id, "Journaled past the refusal");
  expect(await titled(other.id, "Journaled past the refusal")).toBe("Journaled past the refusal");
  expect(await titled(first.id, "Taken")).toBe("Taken");
  expect((await client.call("workspace.get", { workspace_id: second.id })).title).not.toBe("Taken");
  expect(
    logged
      .slice(before)
      .some((line) => line.includes("skipped") && line.includes("UNIQUE constraint failed")),
  ).toBe(true);
  onDatabase("DROP INDEX one_title");
}, 120_000);

test("an event the database refused is journaled once it takes writes again, nothing lost", async () => {
  const w = await chat("full");
  const threadId = ThreadId.make(`caveman:${w.id}`);
  // The projector is held at its next event: its offset cannot move, so T3 commits the rename before the projector
  // can take it.
  onDatabase(`
    CREATE TRIGGER hold_projector_insert BEFORE INSERT ON caveman_sp_projector BEGIN SELECT RAISE(ABORT, 'projector held'); END;
    CREATE TRIGGER hold_projector_update BEFORE UPDATE ON caveman_sp_projector BEGIN SELECT RAISE(ABORT, 'projector held'); END;
  `);
  const held = logged.length;
  const title = `Renamed while the disk was full ${"x".repeat(64 * 1024)}`;
  await rename(w.id, title);
  await until(
    async () =>
      (await Effect.runPromise(orchestratorOf(runtime).getThreadShell(threadId)))?.title === title,
    30_000,
  );
  await until(() => logged.slice(held).some((line) => line.includes("projector held")), 30_000);
  // The disk fills: the database gets no page past those it has. The rename's own rows need many more; the offset's
  // one row is rewritten in place and still fits, so only the event's projection is refused.
  const { free, pageSize } = await Effect.runPromise(
    Effect.gen(function* () {
      yield* sql`PRAGMA incremental_vacuum`;
      const pages = (yield* sql<{ page_count: number }>`PRAGMA page_count`)[0]!.page_count;
      yield* sql.unsafe(`PRAGMA max_page_count = ${pages}`);
      const free = (yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`)[0]!
        .freelist_count;
      return {
        free,
        pageSize: (yield* sql<{ page_size: number }>`PRAGMA page_size`)[0]!.page_size,
      };
    }),
  );
  expect(free * pageSize).toBeLessThan(title.length);
  const full = logged.length;
  onDatabase(`DROP TRIGGER hold_projector_insert; DROP TRIGGER hold_projector_update;`);
  await until(
    () => logged.slice(full).some((line) => line.includes("database or disk is full")),
    60_000,
  );
  // Space is freed.
  await Effect.runPromise(sql.unsafe("PRAGMA max_page_count = 4294967294"));
  expect(await titled(w.id, title)).toBe(title);
  await rename(w.id, "Renamed after");
  expect(await titled(w.id, "Renamed after")).toBe("Renamed after");
}, 180_000);
