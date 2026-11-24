// The Session Protocol client (session-protocol client.ts) against a real runtime when a chat's journal is rewritten
// (CONTRACT §1): a live subscription drops what it delivered and replays the new epoch, a cache from an old epoch is
// reset before anything is shown, and a durable outbox's send after a reload runs once. Nothing stale survives.
import * as fs from "node:fs";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { connect, memoryOutbox } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import type { DraftEvent } from "./projector.ts";
import * as Store from "./store.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const root = tempRoot("sp-client-epoch-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let sessions!: Store.SessionStore["Service"];
/** The route's own store (one instance: Store.layer is memoized), for writing and rewriting journals as the runtime does. */
class Grab extends Context.Service<Grab, { readonly ok: true }>()("test/clientEpoch/Grab") {}
const grab = Layer.effect(
  Grab,
  Effect.gen(function* () {
    sessions = yield* Store.SessionStore;
    return Grab.of({ ok: true });
  }),
).pipe(Layer.provide(Store.layer)) as Layer.Layer<Grab>;

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: grab });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);
const note = (title: string): DraftEvent => ({ at: new Date().toISOString(), type: "notification", payload: { level: "info", title } }) as DraftEvent;

async function chatWithEvents(title: string, n: number) {
  const repo = makeRepo(root, { "README.md": `${title}\n` });
  const workspace = await createReady(client, { request_id: `w-${title}`, repo: { path: repo }, title, engine: "claude-agent", options: { model: MODEL } });
  for (let i = 0; i < n; i++) await run(sessions.append(workspace.session_id, () => Effect.succeed({ events: [note(`${title} ${i}`)], value: undefined })));
  const head = (await run(sessions.getBySession(workspace.session_id)))!.session.head;
  return { workspace, head };
}


const rewrite = (sessionId: string, keep: number, title: string) =>
  run(
    sessions.transact(
      Effect.gen(function* () {
        yield* sessions.sql`DELETE FROM caveman_sp_events WHERE session_id = ${sessionId} AND cursor > ${keep}`;
        const record = (yield* sessions.getBySession(sessionId))!;
        const rewound = { ...record, session: { ...record.session, head: keep } };
        yield* sessions.putWorkspace(rewound);
        const { events, record: next } = yield* sessions.appendInTx(rewound, [note(title)]);
        return { value: next, published: events, changed: [], epochs: [{ session_id: sessionId, epoch: sessions.epochOf(sessionId) + 1 }] };
      }) as never,
    ),
  );
const titleOf = (e: SessionEvent) => (e.type === "notification" ? (e.payload as { title: string }).title : e.type);

test("a live subscription whose journal is rewritten drops what it showed and shows the new journal, nothing stale", async () => {
  const { workspace, head } = await chatWithEvents("live", 3);
  const shown: SessionEvent[] = [];
  const resets: number[] = [];
  const sub = await client.attach(workspace.session_id, 0, (e) => shown.push(e), { onReset: (epoch) => (resets.push(epoch), (shown.length = 0)) });
  await until(() => shown.length === head);
  expect(sub.epoch?.()).toBe(1);
  // The other computer's journal: one event fewer, then its own.
  await rewrite(workspace.session_id, head - 1, "from the other computer");
  await until(() => resets.length === 1 && shown.at(-1) !== undefined && titleOf(shown.at(-1)!) === "from the other computer");
  expect(resets).toEqual([2]);
  expect(shown.map((e) => e.cursor)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
  expect(shown.map(titleOf)).not.toContain(`live 2`);
  expect(sub.epoch?.()).toBe(2);
  await sub.detach();
});

test("a cache from an old epoch is reset on attach, before anything of it is shown again", async () => {
  const { workspace, head } = await chatWithEvents("cached", 2);
  await rewrite(workspace.session_id, head - 1, "rewritten");
  const shown: SessionEvent[] = [];
  const resets: number[] = [];
  // A device that cached cursors 1..head of epoch 1.
  const sub = await client.attach(workspace.session_id, head, (e) => shown.push(e), { epoch: 1, onReset: (epoch) => resets.push(epoch) });
  await until(() => shown.length === head);
  expect(resets).toEqual([2]);
  expect(titleOf(shown.at(-1)!)).toBe("rewritten");
  await sub.detach();
});

test("a send left in a closed page's outbox runs once when the next page opens", async () => {
  const { workspace } = await chatWithEvents("outbox", 1);
  const outbox = memoryOutbox();
  // The first page sends a rename while its link is down (nothing listens there), and closes.
  const first = connect("ws://127.0.0.1:9/session/v1", runtime.token, undefined, { outbox });
  const lost = first.call("workspace.rename", { request_id: "rename-once", workspace_id: workspace.id, title: "Renamed after reload" });
  await until(() => outbox.entries.size === 1);
  first.close();
  await lost.catch(() => undefined);
  const restored: unknown[] = [];
  const second = connect(runtime.url, runtime.token, undefined, { outbox, onRestored: (_entry, outcome) => restored.push(outcome) });
  try {
    await until(() => restored.length === 1);
    expect(restored[0]).toMatchObject({ result: { title: "Renamed after reload" } });
    await until(() => outbox.entries.size === 0);
    // Sent again by hand with the same request id: the runtime's receipt answers, nothing runs twice.
    await expect(second.call("workspace.rename", { request_id: "rename-once", workspace_id: workspace.id, title: "Renamed after reload" })).resolves.toMatchObject({ title: "Renamed after reload" });
    const listed = (await second.call("workspace.list", {})).workspaces.find((w) => w.id === workspace.id)!;
    expect(listed.title).toBe("Renamed after reload");
  } finally {
    second.close();
  }
});
