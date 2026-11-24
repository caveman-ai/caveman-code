// A session journal's identity (CONTRACT §1): cursors within an epoch. A client whose events are another epoch's, or
// run past the head (a lost tail), is told `reset` and gets the journal again from cursor 1; a live attachment whose
// journal is rewritten ends with journal_reset before any event of the new one reaches it.
import * as fs from "node:fs";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";

import type { DraftEvent } from "./projector.ts";
import * as Store from "./store.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const root = tempRoot("sp-epoch-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let sessions!: Store.SessionStore["Service"];
/** The route's own store (one instance: Store.layer is memoized), for writing and rewriting journals as the runtime does. */
class Grab extends Context.Service<Grab, { readonly ok: true }>()("test/journalEpoch/Grab") {}
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

/** A raw Session Protocol client: every frame it got, and calls answered by id. */
async function rawClient() {
  const ws = new WebSocket(runtime.url, ["caveman.session.v1"], { headers: { authorization: `Bearer ${runtime.token()}` } });
  const frames: Array<{ id?: number; method?: string; params?: any; result?: any; error?: any }> = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
  let next = 1;
  const call = async (method: string, params: unknown) => {
    const id = next++;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await until(() => frames.some((f) => f.id === id));
    return frames.find((f) => f.id === id)!;
  };
  /** Events of `session` delivered after frame index `from`, in order. */
  const events = (session: string, from = 0) =>
    frames.slice(from).flatMap((f) =>
      f.method === "session.event" && f.params.session_id === session ? [f.params as SessionEvent] : f.method === "session.events" && f.params.session_id === session ? (f.params.events as Array<SessionEvent>) : [],
    );
  return { ws, frames, call, events };
}

async function chatWithEvents(title: string, n: number) {
  const repo = makeRepo(root, { "README.md": `${title}\n` });
  const workspace = await createReady(client, { request_id: `w-${title}`, repo: { path: repo }, title, engine: "claude-agent", options: { model: MODEL } });
  for (let i = 0; i < n; i++) await run(sessions.append(workspace.session_id, () => Effect.succeed({ events: [note(`${title} ${i}`)], value: undefined })));
  const head = (await run(sessions.getBySession(workspace.session_id)))!.session.head;
  return { workspace, head };
}

test("a client past the head or on another epoch is told reset and replays from the start; one in step is not", async () => {
  const { workspace, head } = await chatWithEvents("past head", 3);
  const raw = await rawClient();
  try {
    // A cursor past the head: this runtime lost a tail the client saw.
    const past = await raw.call("session.attach", { session_id: workspace.session_id, cursor: head + 5, epoch: 1, batch: true });
    expect(past.result).toMatchObject({ epoch: 1, reset: true, session: { head } });
    await until(() => raw.events(workspace.session_id).length === head);
    expect(raw.events(workspace.session_id).map((e) => e.cursor)).toEqual(Array.from({ length: head }, (_, i) => i + 1));

    // In step: nothing is replayed, and nothing is reset.
    const mark = raw.frames.length;
    const same = await raw.call("session.attach", { session_id: workspace.session_id, cursor: head, epoch: 1 });
    expect(same.result).toMatchObject({ epoch: 1, reset: false });
    // Another epoch's events: dropped and replayed.
    const other = await raw.call("session.attach", { session_id: workspace.session_id, cursor: 2, epoch: 7 });
    expect(other.result).toMatchObject({ epoch: 1, reset: true });
    await until(() => raw.events(workspace.session_id, mark).length === head);
    expect(raw.events(workspace.session_id, mark)[0]!.cursor).toBe(1);
  } finally {
    raw.ws.close();
  }
});

test("a rewritten journal ends a live attachment with journal_reset before its new events; attaching again resets", async () => {
  const { workspace, head } = await chatWithEvents("rewrite", 2);
  const raw = await rawClient();
  try {
    expect((await raw.call("session.attach", { session_id: workspace.session_id, cursor: head, epoch: 1 })).result).toMatchObject({ epoch: 1, reset: false });
    // The journal is rewritten (as an adopt or a rebuild from Cloud's copy does): one event fewer, then a new one.
    await run(
      sessions.transact(
        Effect.gen(function* () {
          yield* sessions.sql`DELETE FROM caveman_sp_events WHERE session_id = ${workspace.session_id} AND cursor = ${head}`;
          const record = (yield* sessions.getBySession(workspace.session_id))!;
          const rewound = { ...record, session: { ...record.session, head: head - 1 } };
          yield* sessions.putWorkspace(rewound);
          const { events, record: next } = yield* sessions.appendInTx(rewound, [note("from the other computer")]);
          return { value: next, published: events, changed: [], epochs: [{ session_id: workspace.session_id, epoch: 2 }] };
        }) as never,
      ),
    );
    await until(() => raw.frames.some((f) => f.method === "session.ended"));
    const ended = raw.frames.find((f) => f.method === "session.ended")!;
    expect(ended.params).toMatchObject({ session_id: workspace.session_id, error: { code: -32017, data: { reason: "journal_reset" } } });
    // Nothing of the new journal reached the old attachment.
    expect(raw.events(workspace.session_id).some((e) => e.type === "notification" && (e.payload as { title: string }).title === "from the other computer")).toBe(false);

    const again = await raw.call("session.attach", { session_id: workspace.session_id, cursor: head, epoch: 1, batch: true });
    expect(again.result).toMatchObject({ epoch: 2, reset: true });
    await until(() => raw.events(workspace.session_id).some((e) => e.type === "notification" && (e.payload as { title: string }).title === "from the other computer"));
    const listed = (await client.call("workspace.list", {})).workspaces.find((w) => w.id === workspace.id)!;
    expect(listed).toMatchObject({ epoch: 2, head, synced_through: null });
    // A rewrite with no event after it ends an attachment too.
    await raw.call("session.attach", { session_id: workspace.session_id, cursor: head, epoch: 2 });
    const before = raw.frames.filter((f) => f.method === "session.ended").length;
    await run(sessions.transact(Effect.succeed({ value: undefined, published: [], changed: [], epochs: [{ session_id: workspace.session_id, epoch: 3 }] })));
    await until(() => raw.frames.filter((f) => f.method === "session.ended").length === before + 1);
    expect(sessions.epochOf(workspace.session_id)).toBe(3);
  } finally {
    raw.ws.close();
  }
});
