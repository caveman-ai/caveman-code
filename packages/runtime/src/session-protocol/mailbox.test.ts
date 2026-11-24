// The local mailbox within one runtime, between a lead and the builder its
// engine delegated (delegate_task): note without waking, ask that wakes, wait
// as a pure read, claims and handoff.
import * as fs from "node:fs";

import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createReady, delegateFrom, makeConfig, makeRepo, MODEL, orchestratorOf, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-mail-");
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );

test("note, ask, wait, claim, release and handoff", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const lead = await createReady(client, { request_id: "lead", repo: { path: repo }, title: "Lead", engine: "claude-agent", options: { model: MODEL }, task: { text: "slow: split the work" } });
  const plain = await createReady(client, { request_id: "plain", repo: { path: repo }, title: "Plain", engine: "claude-agent", options: { model: MODEL } });
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (e) => leadEvents.push(e));

  // The lead's engine delegates a builder: a workspace under the lead, on the lead's branch.
  await delegateFrom(orchestratorOf(runtime), lead, "Write the parser", "Parser");
  let builder: Workspace | undefined;
  await until(async () => (builder = (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces[0]) !== undefined);
  expect(builder).toMatchObject({ parent_workspace_id: lead.id, base_ref: lead.branch, title: "Parser" });
  // The brief is the builder's first message, and it started a turn there: the lead's words, never the person's.
  const builderEvents: Array<SessionEvent> = [];
  await client.attach(builder!.session_id, 0, (e) => builderEvents.push(e));
  await until(() => builderEvents.some((e) => e.type === "message.done"));
  expect(builderEvents.find((e) => e.type === "message.done")).toMatchObject({ payload: { role: "user", text: "Write the parser", from: { workspace_id: lead.id, title: "Lead" } } });
  // Both settle: the builder's result wakes the lead, which answers.
  await until(async () => (await client.call("workspace.get", { workspace_id: builder!.id })).status === "idle", 30_000);
  await until(async () => (await client.call("workspace.get", { workspace_id: lead.id })).status === "idle", 30_000);
  const leadTurns = () => leadEvents.filter((e) => e.type === "turn.started").length;
  const settled = leadTurns();

  // A note informs without waking.
  const note = await client.call("mail.note", { request_id: "n1", session_id: builder!.session_id, to_workspace_id: lead.id, body: "found the grammar" });
  expect(note).toMatchObject({ verb: "note", authority: "agent", wakes: false, from_workspace_id: builder!.id });
  await until(() => leadEvents.some((e) => e.type === "notification" && e.payload.mail?.id === note.id));
  expect(leadTurns()).toBe(settled);

  // wait is a pure read: the note is there every time, and nothing wakes yet.
  const first = await client.call("mail.wait", { session_id: lead.session_id, workspace_ids: [plain.id], timeout_ms: 300 });
  expect(first.messages.map((m) => m.id)).toEqual([note.id]);
  expect(first.timed_out).toBe(true);
  const again = await client.call("mail.wait", { session_id: lead.session_id, workspace_ids: [plain.id], timeout_ms: 100 });
  expect(again.messages.map((m) => m.id)).toEqual([note.id]);

  // An ask wakes: wait returns at once, and the ask starts a turn in the lead.
  const waiting = client.call("mail.wait", { session_id: lead.session_id, after: note.id, workspace_ids: [plain.id], timeout_ms: 10_000 });
  const ask = await client.call("mail.ask", { request_id: "a1", session_id: builder!.session_id, to_workspace_id: lead.id, body: "LL(1) or PEG?" });
  const woke = await waiting;
  expect(woke.messages.map((m) => m.id)).toEqual([ask.id]);
  expect(woke.timed_out).toBe(false);
  await until(() => leadEvents.some((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text.includes("LL(1) or PEG?")));
  // Mail is the sending agent's words: it carries `from`, so memory never counts it as the person's.
  expect(leadEvents.find((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text.includes("LL(1) or PEG?"))).toMatchObject({
    payload: { from: { workspace_id: builder!.id, title: "Parser" } },
  });

  // A reply to an ask wakes the asker even as a note.
  const reply = await client.call("mail.note", { request_id: "r1", session_id: lead.session_id, to_workspace_id: builder!.id, body: "PEG", reply_to: ask.id });
  expect(reply.wakes).toBe(true);
  expect(await reason(client.call("mail.note", { request_id: "r2", session_id: lead.session_id, to_workspace_id: builder!.id, body: "x", reply_to: "mail-none" }))).toBe("not_found");

  // Claims: granted once, the other side sees the conflict, release frees it.
  const mine = await client.call("mail.claim", { request_id: "c1", session_id: lead.session_id, paths: ["src/parser.ts"] });
  expect(mine).toEqual({ claims: [{ path: "src/parser.ts", workspace_id: lead.id }], conflicts: [] });
  const theirs = await client.call("mail.claim", { request_id: "c2", session_id: builder!.session_id, paths: ["src/parser.ts", "src/lexer.ts"] });
  expect(theirs.claims).toEqual([{ path: "src/lexer.ts", workspace_id: builder!.id }]);
  expect(theirs.conflicts).toEqual([{ path: "src/parser.ts", workspace_id: lead.id }]);
  expect(await client.call("mail.release", { request_id: "c3", session_id: lead.session_id, paths: ["src/parser.ts"] })).toEqual({ released: ["src/parser.ts"] });
  const later = await client.call("mail.claim", { request_id: "c4", session_id: builder!.session_id, paths: ["src/parser.ts"] });
  expect(later.conflicts).toEqual([]);

  // wait on children returns once every child has finished its turn.
  await until(async () => (await client.call("workspace.get", { workspace_id: builder!.id })).status !== "working");
  const done = await client.call("mail.wait", { session_id: lead.session_id, after: ask.id, timeout_ms: 10_000 });
  expect(done.finished.map((w) => w.id)).toEqual([builder!.id]);
  expect(done.timed_out).toBe(false);

  // Handoff to a person keeps the session here and says so.
  const handed = await client.call("mail.handoff", { request_id: "h1", session_id: plain.session_id, brief: "please review", user_id: "teammate" });
  expect(handed.id).toBe(plain.session_id);
  // Handoff to another computer parks the session with the reason.
  const plainEvents: Array<SessionEvent> = [];
  await client.attach(plain.session_id, 0, (e) => plainEvents.push(e));
  const parked = await client.call("mail.handoff", { request_id: "h2", session_id: plain.session_id, brief: "continue in the cloud", computer_id: "cloud-1" });
  expect(parked.state).toBe("parked");
  await until(() => plainEvents.some((e) => e.type === "session.parked"));
  expect(plainEvents.find((e) => e.type === "session.parked")?.payload).toEqual({ reason: "handoff" });
  expect(await reason(client.call("turn.submit", { request_id: "t-parked", session_id: plain.session_id, kind: "followup", input: { text: "hi" } }))).toBe("parked");
  const resumed = await client.call("session.resume", { request_id: "h3", session_id: plain.session_id });
  expect(resumed.state).toBe("live");
  expect(resumed.lease?.computer_id).toBe("this-mac");
});
