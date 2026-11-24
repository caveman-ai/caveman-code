// The Mac mail route (macMail.ts) on its own: a real SQLite store for its tables and the chat's journal, Cloud's mailbox
// stood in for at the module (what this Mac takes, what it sends back), and the rest of the runtime as fakes the test
// drives: which chats are here, what a queued turn does, and trust. For what a whole runtime cannot hold still long
// enough to see: a mail turn the lid hands on mid-way or the lease stop pauses (F-5), a removal landing while a mail is
// being queued (m-i), mail for a chat this Mac archived or no longer has (m-m), and mail signed ahead of this Mac's
// clock (m-n). The real-stack proof is agentMailAcrossMacs.e2e.test.ts; the runtime's own is macMail.integration.test.ts.
import { randomUUID } from "node:crypto";

import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import type { DeviceKey, SessionEvent } from "@caveman-app/session-protocol";
import { signAgentMail, type AgentMail } from "@caveman-app/session-protocol/mac-mail";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, expect, test, vi } from "vitest";

import type { Identity } from "../cloudLink/identity.ts";
import type { LinkState } from "../cloudLink/index.ts";
import type { TreeMail } from "../cloudLink/mail.ts";
import { testDevice } from "./devices.testkit.ts";
import { makeMacMailRoute, type MailPlace } from "./macMail.ts";
import type { SessionStore, WorkspaceRecord } from "./store.ts";
import { until } from "./testHarness.ts";

/** Cloud's mailbox for this Mac: mail waiting to be taken, and what this Mac sent (answers, status lines). */
const cloud = vi.hoisted(() => ({
  inbox: [] as Array<unknown>,
  sent: [] as Array<{ readonly mail: { readonly in_reply_to: string; readonly from_workspace_id: string; readonly from_title: string }; readonly body: string }>,
}));
vi.mock("../cloudLink/macMail.ts", () => ({
  takeMacMail: async () => {
    const messages = cloud.inbox.splice(0);
    return { lease: messages.length > 0 ? `lease-${Math.random()}` : null, messages };
  },
  ackMacMail: async () => undefined,
  renewMacMail: async (_identity: unknown, _state: unknown, _lease: string, ids: ReadonlyArray<string>) => ({ renewed: ids, lost: [] }),
  sendMacMail: async (_identity: unknown, _state: unknown, input: (typeof cloud.sent)[number]) => {
    cloud.sent.push(input);
    return {};
  },
  waitMacMail: () => new Promise((resolve) => setTimeout(resolve, 50)),
  macPeer: async () => undefined,
}));

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  cloud.inbox.length = 0;
  cloud.sent.length = 0;
  vi.useRealTimers();
});

const HELPER = "s-helper";
const WS_HELPER = "ws-helper";
const WS_ASKER = "ws-asker";

async function harness() {
  const runtime = ManagedRuntime.make(NodeSqliteClient.layer({ filename: ":memory:" }));
  cleanups.push(() => runtime.dispose());
  const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => runtime.runPromise(effect);
  const sql = await run(
    Effect.gen(function* () {
      return yield* SqlClient.SqlClient;
    }),
  );
  await run(sql`CREATE TABLE caveman_sp_events (session_id TEXT NOT NULL, cursor INTEGER NOT NULL, type TEXT NOT NULL, event TEXT NOT NULL)`);
  const events = await Effect.runPromise(PubSub.unbounded<SessionEvent>());
  const record = (sessionId: string, workspaceId: string, status = "idle") =>
    ({ session: { id: sessionId, head: 0, state: "live" }, workspace: { id: workspaceId, status, title: "Helper" }, internal: { threadId: `thread-${sessionId}` } }) as unknown as WorkspaceRecord;
  const records = new Map<string, WorkspaceRecord>([[HELPER, record(HELPER, "w-helper")]]);
  const synced = new Map<string, string>([[HELPER, WS_HELPER]]);
  const places = new Map<string, MailPlace>();
  const turns = new Map<string, { started: boolean; over: boolean }>();
  const dropped: Array<string> = [];
  const notes: Array<string> = [];
  const resuming = new Set<string>();
  /** What queuing a mail's turn does: answers its turn id (the test may hold it a while). */
  let queue: (requestId: string) => Promise<string> = async () => `turn-${randomUUID()}`;
  const store = {
    getBySession: (id: string) => Effect.succeed(records.get(id)),
    getByThread: (thread: string) => Effect.succeed([...records.values()].find((r) => r.internal.threadId === thread)),
    readEvents: (sessionId: string, after: number, through: number) =>
      sql<{ event: string }>`SELECT event FROM caveman_sp_events WHERE session_id = ${sessionId} AND cursor > ${after} AND cursor <= ${through} ORDER BY cursor`.pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((r) => JSON.parse(r.event) as SessionEvent)),
      ),
    events,
  } as unknown as SessionStore["Service"];
  const helperKey = await testDevice("Mac B agents");
  const route = await Effect.runPromise(
    makeMacMailRoute({
      sql,
      store,
      onComputer: false,
      agentsKey: helperKey,
      link: () => ({ identity: { organizationId: "org-1", userId: "user-1", cloudUrl: "http://cloud.invalid" } as unknown as Identity, state: {} as LinkState }),
      cloudWorkspaceOf: (r) => Effect.succeed(synced.get(r.session.id) ?? "ws-unknown"),
      syncedWorkspaceOf: (r) => Effect.succeed(synced.get(r.session.id)),
      place: (sessionId) => Effect.succeed(places.get(sessionId) ?? "here"),
      runOf: (_r, turnId) => Effect.succeed(turns.get(turnId)),
      dropQueued: (_r, turnId) => Effect.sync(() => void dropped.push(turnId)),
      modesOf: () => Effect.succeed({ runtimeMode: "full-access", interactionMode: "default" }),
      scrub: (text) => Effect.succeed(text),
      deliver: (_to, input) => Effect.promise(() => queue(input.requestId)),
      note: (_to, title, body) => Effect.sync(() => void notes.push(`${title}: ${body}`)),
      askedBy: () => Effect.void,
      resumesHere: (_sessionId, turnId) => Effect.succeed(resuming.has(turnId)),
    }),
  );
  // Mac A's agents key, vouched for by Mac A, which this Mac trusts until the test removes it.
  const askerKey = await testDevice("Mac A agents");
  const trust = new Set([askerKey.device_id]);
  let onTrust: () => void = () => undefined;
  route.trustWith(
    async (id) => (trust.has(id) ? { agents: { device_id: id, public_key: askerKey.public_key, vouched_by: { device_id: "mac-a", name: "Mac A" } } } : { agents: undefined }),
    () => true,
    (listener) => (onTrust = listener),
  );
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never)));
  await Effect.runPromise(route.run(scope).pipe(Effect.provideService(Scope.Scope, scope)));

  let cursor = 0;
  /** An event in the helper chat's journal, as the runtime writes and publishes one. */
  const journal = (type: string, turnId: string, payload: Record<string, unknown>, sessionId = HELPER) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const event = { session_id: sessionId, cursor: ++cursor, at: new Date().toISOString(), type, turn_id: turnId, payload } as unknown as SessionEvent;
        yield* sql`INSERT INTO caveman_sp_events (session_id, cursor, type, event) VALUES (${sessionId}, ${cursor}, ${type}, ${JSON.stringify(event)})`.pipe(Effect.orDie);
        yield* PubSub.publish(events, event);
      }),
    );
  let seq = 0;
  /** An ask from the chat "Asker" on Mac A, signed by its agents key, handed to this Mac for `sessionId`. */
  const ask = async (text: string, options: { readonly sessionId?: string; readonly to?: string; readonly at?: number; readonly key?: DeviceKey } = {}) => {
    const mail: AgentMail = await signAgentMail(
      options.key ?? askerKey,
      {
        organization_id: "org-1",
        user_id: "user-1",
        message_id: randomUUID(),
        from_workspace_id: WS_ASKER,
        from_title: "Asker",
        to_workspace_id: options.to ?? WS_HELPER,
        expects_reply: true,
        in_reply_to: "",
        runtime_mode: "full-access",
        interaction_mode: "default",
      },
      text,
      options.at,
    );
    const row: TreeMail = {
      id: randomUUID(),
      verb: "ask",
      authority: "agent",
      channel: "mac",
      from_workspace_id: WS_ASKER,
      to_workspace_id: options.to ?? WS_HELPER,
      body: text,
      wakes: true,
      reply_to: null,
      created_at: new Date().toISOString(),
      payload: { kind: "mac", mail, session_id: options.sessionId ?? HELPER, recipient_seq: ++seq, from_session_id: "s-asker" },
    };
    cloud.inbox.push(row);
    return mail.message_id;
  };
  const answersTo = (id: string) => cloud.sent.filter((s) => s.mail.in_reply_to === id);
  return { route, journal, ask, answersTo, records, synced, places, turns, dropped, notes, resuming, trust, record, onTrust: () => onTrust(), setQueue: (q: typeof queue) => (queue = q) };
}
type Harness = Awaited<ReturnType<typeof harness>>;

/** An ask that runs as the helper chat's turn `turnId`, says `partial`, and is at work. */
async function running(h: Harness, text: string, turnId: string, partial: string) {
  h.setQueue(async () => turnId);
  const id = await h.ask(text);
  h.turns.set(turnId, { started: true, over: false });
  await h.journal("turn.started", turnId, { engine: "claude-agent" });
  await h.journal("message.done", turnId, { role: "user", text, from: { title: "Asker on Mac A" } });
  await h.journal("message.done", turnId, { role: "assistant", text: partial });
  // Queued: the route keeps its row once deliver answered.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return id;
}

test("a mail turn the lid hands on mid-way is never answered with its stop's words: its asker hears it carries on elsewhere, once (F-5)", async () => {
  const h = await harness();
  const asked = await running(h, "Migrate the 7 tables", "t-lid", "Migrated 3 of 7 tables so far");
  // The lid marks the chat's mail before its park stops the turn; the stop's turn.done reaches the route's own look too.
  await Effect.runPromise(h.route.carry(HELPER, true));
  h.turns.set("t-lid", { started: true, over: true });
  await h.journal("turn.done", "t-lid", { status: "interrupted" });
  await Effect.runPromise(h.route.letGo(HELPER));
  await until(() => h.answersTo(asked).length > 0, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(h.answersTo(asked)).toHaveLength(1);
  const answer = h.answersTo(asked)[0]!.body;
  expect(answer).toMatch(/^\[no answer\] That chat's Mac closed its lid in the middle of this mail's turn/);
  expect(answer).toContain("rather than sending this again");
  expect(answer).not.toContain("Migrated 3 of 7");

  // A turn stopped with no handoff of it (Stop, a move by hand): its stop's words are its answer, as before.
  const stopped = await running(h, "Count the rows", "t-stop", "Counted 2 of 9");
  h.turns.set("t-stop", { started: true, over: true });
  await h.journal("turn.done", "t-stop", { status: "interrupted" });
  await until(() => h.answersTo(stopped).length > 0, 10_000);
  expect(h.answersTo(stopped)[0]!.body).toBe("[interrupted] Counted 2 of 9");
}, 60_000);

test("a mail turn the lease stop pauses to carry on here is answered by the turn that carries it on, never '[interrupted]' (F-5)", async () => {
  const h = await harness();
  const asked = await running(h, "Migrate the 7 tables", "t-offline", "Migrated 3 of 7 tables so far");
  // Caveman out of reach: the turn stops, marked to carry on by itself once it answers (decision 26).
  h.resuming.add("t-offline");
  h.turns.set("t-offline", { started: true, over: true });
  await h.journal("turn.done", "t-offline", { status: "interrupted" });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(h.answersTo(asked)).toEqual([]);
  // Back online: the turn carries on as another turn, and its own last words are the answer.
  h.resuming.delete("t-offline");
  h.turns.set("t-resumed", { started: true, over: false });
  await h.journal("turn.started", "t-resumed", { engine: "claude-agent" });
  await Effect.runPromise(h.route.continueTurn(HELPER, "t-offline", "t-resumed"));
  await h.journal("message.done", "t-resumed", { role: "assistant", text: "All 7 tables migrated." });
  h.turns.set("t-resumed", { started: true, over: true });
  await h.journal("turn.done", "t-resumed", { status: "completed" });
  await until(() => h.answersTo(asked).length > 0, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(h.answersTo(asked).map((a) => a.body)).toEqual(["All 7 tables migrated."]);
}, 60_000);

test("a Mac removed while its mail is being queued: the mail leaves the queue at once, not a sweep later (m-i)", async () => {
  const h = await harness();
  let removedAt = 0;
  // Queuing takes a moment, and the sending Mac is removed (another of the person's Macs, say) right then.
  h.setQueue(async () => {
    h.trust.clear();
    removedAt = Date.now();
    h.onTrust();
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.turns.set("t-doomed", { started: false, over: false });
    return "t-doomed";
  });
  const asked = await h.ask("Queued as its Mac goes");
  await until(() => h.dropped.includes("t-doomed"), 10_000);
  expect(Date.now() - removedAt).toBeLessThan(10_000);
  await until(() => h.answersTo(asked).length > 0, 10_000);
  expect(h.answersTo(asked)[0]!.body).toMatch(/^\[not run\] The Mac that sent this was removed/);
}, 60_000);

test("an ask for a chat this Mac archived, or no longer has, never runs and its asker hears so; one Cloud points elsewhere hears nothing (m-m)", async () => {
  const h = await harness();
  h.records.set("s-archived", h.record("s-archived", "w-archived", "archived"));
  h.synced.set("s-archived", "ws-archived");
  const archived = await h.ask("For the archived chat", { sessionId: "s-archived", to: "ws-archived" });
  await until(() => h.answersTo(archived).length > 0, 10_000);
  expect(h.answersTo(archived)[0]).toMatchObject({ body: "[not run] That chat is archived on its Mac, so it did not take this mail.", mail: { from_workspace_id: "ws-archived" } });
  // Cloud hands a mail signed for another chat to the archived one: it runs nowhere, and no line goes in its name.
  const misrouted = await h.ask("Signed for someone else", { sessionId: "s-archived", to: "ws-other" });
  // A chat this Mac does not have: it waits for an adopt a while, then its asker hears, as the chat it was signed for.
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.now());
  const gone = await h.ask("For a chat that left", { sessionId: "s-gone", to: "ws-gone" });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(h.answersTo(gone)).toEqual([]);
  vi.setSystemTime(Date.now() + 3 * 60_000);
  await until(() => h.answersTo(gone).length > 0, 15_000);
  expect(h.answersTo(gone)[0]).toMatchObject({
    body: "[not run] That chat is no longer on the Mac Caveman sent this to, so it did not take this mail.",
    mail: { from_workspace_id: "ws-gone", from_title: "A chat no longer on this Mac" },
  });
  expect(h.answersTo(misrouted)).toEqual([]);
  // Forged (a key no Mac this Mac trusts vouched for): nothing goes back for it either.
  const forged = await h.ask("Forged", { sessionId: "s-archived", to: "ws-archived", key: await testDevice("Cloud's own key") });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(h.answersTo(forged)).toEqual([]);
}, 60_000);

test("mail signed ahead of this Mac's clock is refused as such, never as 'more than a day old' (m-n)", async () => {
  const h = await harness();
  const asked = await h.ask("From a Mac whose clock runs fast", { at: Date.now() + 10 * 60_000 });
  await until(() => h.answersTo(asked).length > 0, 10_000);
  expect(h.answersTo(asked)[0]!.body).toBe("[not run] This mail's time was more than 5 minutes ahead of the receiving Mac's clock, so it was not run: check the date and time on both Macs.");
  expect(h.notes.some((n) => n.includes("more than 5 minutes ahead of this Mac's clock") && n.includes("check the date and time on both Macs"))).toBe(true);
  expect(h.notes.some((n) => n.includes("more than a day"))).toBe(false);
  // An old one still reads as old.
  const old = await h.ask("From yesterday", { at: Date.now() - 25 * 60 * 60_000 });
  await until(() => h.answersTo(old).length > 0, 10_000);
  expect(h.answersTo(old)[0]!.body).toBe("[not run] This mail waited more than a day, so it was not run.");
}, 60_000);
