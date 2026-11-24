// A chat answered before Workspace.activity.last_reply gets its latest answer once, at the next start: its own
// agent's newest message.done, scrubbed of secret values, never a subagent's, never the person's words.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll, expect, test } from "vitest";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as Store from "./store.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-last-reply-"));
const dbPath = path.join(dir, "state.sqlite");
const secrets = {
  scrubber: Effect.succeed({
    scrub: (text: string) => text.replaceAll("sk-live-123", "[secret:STRIPE_KEY]"),
    scrubDeep: <A>(value: A) => value,
  }),
};
const open = () =>
  ManagedRuntime.make(
    Store.layer.pipe(
      Layer.provide(Layer.succeed(ProjectSecrets, secrets as never)),
      Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
      Layer.provide(NodeServices.layer),
    ) as Layer.Layer<Store.SessionStore>,
  );

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a chat answered before last_reply gets its own agent's newest answer, scrubbed, once at the next start", async () => {
  const first = open();
  await first.runPromise(
    Effect.gen(function* () {
      const store = yield* Store.SessionStore;
      const chat = (id: string) =>
        ({
          workspace: {
            id,
            title: id,
            status: "idle",
            session_id: `s-${id}`,
            created_at: "2026-11-01T00:00:00Z",
            updated_at: "2026-11-01T00:00:00Z",
            activity: { last_outcome: "completed" },
          },
          session: { id: `s-${id}`, head: 0 },
          internal: { threadId: `t-${id}` },
        }) as unknown as Store.WorkspaceRecord;
      yield* store.putWorkspace(chat("w1"));
      yield* store.putWorkspace(chat("w2"));
      const event = (
        session: string,
        cursor: number,
        role: string,
        text: string,
        parent?: string,
      ) =>
        store.sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (${session}, ${cursor}, 'message.done', '2026-11-01T00:00:00Z',
          ${JSON.stringify({ session_id: session, cursor, type: "message.done", at: "2026-11-01T00:00:00Z", payload: { role, text }, ...(parent ? { parent_item_id: parent } : {}) })})`.pipe(
          Effect.orDie,
        );
      yield* event("s-w1", 1, "assistant", "First answer");
      yield* event("s-w1", 2, "assistant", "**Charged** the card with sk-live-123");
      yield* event("s-w1", 3, "assistant", "A subagent's summary", "sub1");
      yield* event("s-w1", 4, "user", "thanks");
      yield* event("s-w2", 1, "user", "hello");
      // As a runtime from before last_reply left it: the backfill not yet run.
      yield* store.sql`DELETE FROM caveman_sp_kv WHERE key = 'activity.last_reply'`.pipe(
        Effect.orDie,
      );
    }),
  );
  await first.dispose();

  const second = open();
  const [w1, w2] = await second.runPromise(
    Effect.gen(function* () {
      const store = yield* Store.SessionStore;
      return [yield* store.getWorkspace("w1"), yield* store.getWorkspace("w2")] as const;
    }),
  );
  await second.dispose();
  expect(w1?.workspace.activity).toEqual({
    last_outcome: "completed",
    last_reply: "Charged the card with [secret:STRIPE_KEY]",
  });
  // Never answered: nothing to say.
  expect(w2?.workspace.activity).toEqual({ last_outcome: "completed" });
});
