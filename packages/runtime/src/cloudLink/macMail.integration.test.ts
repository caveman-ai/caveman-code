// Agent mail between a person's Macs (session-protocol/macMail.ts; RESEARCH-W2 decision 33; THREAT-MODEL T16-T21), end
// to end on the test Cloud: two runtimes' worth of This Mac, each with its own state, link, desktop key (its screen,
// played by the local client) and agents key (the desktop app's, handed over in memory), and the stand-in Claude CLI.
// A chat on Mac A asks a chat on Mac B as its agent's thread_send would (the MacMail service the MCP calls); B runs
// it as the chat's next turn and answers when that turn ends, and Cloud, a carrier that can replay, alter and forge
// mail, gets nothing run that A's vouched agents key did not sign, nor anything run twice or above A's chat's modes.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

import { agentsStatementFor, connect, signMove, signStop, type DeviceKey, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import { signAgentMail, type AgentMail } from "@caveman-app/session-protocol/mac-mail";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import { DevicesClock } from "../session-protocol/devices.ts";
import { MacMail } from "../session-protocol/macMail.ts";
import { allowedStream, removeStatement, testDevice } from "../session-protocol/devices.testkit.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { repoHash } from "./heartbeatRepos.ts";
import { CloudLinkState } from "./index.ts";
import { startTestCloud, type TestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const agentsPem = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();

/**
 * One of the person's Macs on `cloud`, with an agents key unless `agents` is false (a runtime without the desktop app).
 * `clock`: the Mac's wall clock for its device log (DevicesClock), so a test can make it wake from a sleep.
 */
async function mac(cloud: TestCloud, name: string, options: { readonly agents?: boolean; readonly clock?: () => number } = {}) {
  const config = { ...(await makeConfig()), ...(options.agents === false ? {} : { agentsKey: agentsPem() }) };
  const provide = Layer.mergeAll(Layer.succeed(CloudLinkState, {}), options.clock ? Layer.succeed(DevicesClock, options.clock) : Layer.empty) as unknown as Layer.Layer<any>;
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  cleanups.push(() => runtime.close());
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  const enrolled = await local.call("cloud.enroll", { request_id: `e-${name}`, cloud_url: cloud.url, token: cloud.state.personToken, name });
  await local.call("settings.set", { request_id: `rc-${name}`, settings: { remote_control: true, sync_chats: true } });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const relayOf = () => cloud.state.relays.filter((side) => cloud.state.tokens.get(side.token)?.runtimeId === enrolled.runtime_id);
  await until(() => relayOf().length > 0, 15_000);
  const macMail = Context.get(runtime.context as unknown as Context.Context<MacMail>, MacMail);
  return { name, runtime, local, relay: relayOf().at(-1)!, key: await testDevice(name, "mac"), macMail, runtimeId: enrolled.runtime_id };
}
type Mac = Awaited<ReturnType<typeof mac>>;

/** `on`'s screen allows `other`'s desktop key as a Mac, signed for the person's other Macs. */
const allowMac = (on: Mac, other: Mac) => allowedStream(on.relay, on.local, other.key, on.relay.open(), { signer: on.key });
const trusts = async (on: Mac, other: Mac) => (await on.local.call("device.list", {})).devices.some((d) => d.device_id === other.key.device_id);

/**
 * `on`'s screen vouches for its runtime's agents key with its desktop key (what the desktop app's page does by itself),
 * and the vouch reaches Cloud (`shared`: only then does that Mac send mail).
 */
async function vouch(on: Mac, options: { readonly shared?: boolean } = {}) {
  const { agents, name } = await on.local.call("device.agents", {});
  const statement = await agentsStatementFor(on.key, (await on.local.call("device.list", {})).family, agents!, name);
  const out = await on.local.call("device.vouch", { request_id: `vouch-${on.name}-${Date.now()}`, statement: statement! });
  if (options.shared !== false) await until(async () => (await on.local.call("device.agents", {})).shared === true, 15_000);
  return out;
}

/**
 * A chat on `on` in a repository on GitHub (so Cloud knows it), with its Cloud workspace id and its events. `synced`
 * false: a chat this Mac keeps to itself (sync off when it was made), which Cloud has never heard of.
 */
async function chat(cloud: TestCloud, on: Mac, title: string, access?: "ask" | "full", options: { readonly synced?: boolean; readonly pushable?: boolean } = {}) {
  const repo = makeRepo(tempRoot("mac-mail-"), { "README.md": `${title}\n` });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/mac-mail.git"], { cwd: repo });
  // `pushable`: GitHub is a bare repository here, so what pushes (a park's work in progress) lands.
  if (options.pushable) {
    const bare = tempRoot("mac-mail-github-");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["config", `url.file://${bare}.insteadOf`, "https://github.com/acme/mac-mail.git"], { cwd: repo });
  }
  const workspace: Workspace = await createReady(on.local, { request_id: `w-${title}`, repo: { path: repo }, title, engine: "claude-agent", options: { model: MODEL, ...(access ? { access } : {}) } });
  if (options.synced === false) {
    const events: Array<SessionEvent> = [];
    await on.local.attach(workspace.session_id, 0, (event) => events.push(event));
    return { workspace, cloudId: "", events, thread: `caveman:${workspace.id}` };
  }
  await until(() => cloud.state.chats.sessions.get(workspace.session_id)?.workspace_id !== undefined, 30_000);
  const events: Array<SessionEvent> = [];
  await on.local.attach(workspace.session_id, 0, (event) => events.push(event));
  return { workspace, cloudId: cloud.state.chats.sessions.get(workspace.session_id)!.workspace_id, events, thread: `caveman:${workspace.id}` };
}
type Chat = Awaited<ReturnType<typeof chat>>;

const said = (c: Chat, role: "user" | "assistant") => c.events.flatMap((e) => (e.type === "message.done" && (e.payload as { role: string }).role === role ? [(e.payload as { text: string }).text] : []));
const turnsDone = (c: Chat) => c.events.filter((e) => e.type === "turn.done").length;
const notes = (c: Chat) => c.events.flatMap((e) => (e.type === "notification" ? [e.payload as { title: string; body?: string }] : []));
const send = (from: Mac, input: { from: Chat; to: Chat; text: string; key: string; ask?: boolean; inReplyTo?: string; runtimeMode?: string }) =>
  Effect.runPromise(
    from.macMail.send({
      fromThreadId: input.from.thread,
      toThreadId: `mac:${input.to.cloudId}`,
      text: input.text,
      requestKey: input.key,
      ask: input.ask === true,
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      limits: { runtimeMode: input.runtimeMode ?? "full-access", interactionMode: "default" },
    }),
  );

test("a chat on one Mac asks a chat on another of the person's Macs; it runs as that chat's next turn and the answer comes back (decision 33)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const [a, b] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B")];
  await allowMac(a, b);
  await allowMac(b, a);
  await until(async () => (await trusts(a, b)) && (await trusts(b, a)), 15_000);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  const turnsB = turnsDone(onB);
  // (Each Mac's heartbeat names the repository it now has a checkout of, by hash: decision 30.)
  await until(() => cloud.state.heartbeats.some((h) => h.repos?.some((r) => r.remote_hash === repoHash("https://github.com/acme/mac-mail"))), 30_000);

  // Before Mac A's screen vouched for its agents key, A sends nothing: B would take it for a key no Mac vouched for.
  expect((await a.local.call("device.agents", {})).vouched).toBe(false);
  await expect(send(a, { from: onA, to: onB, text: "Before the vouch", key: "early" })).rejects.toMatchObject({ reason: "unavailable" });
  expect(cloud.state.tree.mail.some((m) => m.channel === "mac" && m.body === "Before the vouch")).toBe(false);

  // Vouched: an ask runs on B as the chat's next turn, wrapped as another agent's message, and B's chat names the asker.
  expect(await vouch(a)).toEqual({ vouched: true });
  expect(await vouch(b)).toEqual({ vouched: true });
  expect((await a.local.call("device.agents", {})).vouched).toBe(true);
  const sentAt = Date.now();
  const asked = await send(a, { from: onA, to: onB, text: "hold 2000 What does your README say?", key: "q1", ask: true });
  expect(asked?.id).toMatch(/^[0-9a-f-]{36}$/);
  await until(() => said(onB, "user").includes("hold 2000 What does your README say?") && turnsDone(onB) > turnsB, 60_000);
  const ranMs = Date.now() - sentAt;
  // From the asking chat on Mac A as Mac B knows that Mac (its screen allowed A's desktop key as "Mac A"), whatever
  // name A's runtime gives itself (its host's, here the same host as B's).
  const heard = onB.events.find((e) => e.type === "message.done" && (e.payload as { role: string; text: string }).text === "hold 2000 What does your README say?");
  expect((heard?.payload as { from?: { title: string } } | undefined)?.from?.title).toBe("Asker on Mac A");
  // While it ran, B's chat told Cloud whose mail it was running: the person's devices let A's chat speak for it.
  await until(() => cloud.state.chats.summaryPuts.some((p) => p.session_id === onB.workspace.session_id && p.asked_by === onA.workspace.session_id), 30_000);
  // Numbered among the mail to B's chat: its first.
  const carried = cloud.state.tree.mail.find((m) => m.channel === "mac" && m.request_id === `mac:${asked!.id}`)!;
  expect(carried).toMatchObject({ verb: "ask", from_workspace_id: onA.cloudId, to_workspace_id: onB.cloudId, payload: { recipient_seq: 1, session_id: onB.workspace.session_id, from_session_id: onA.workspace.session_id } });

  // The answer is the turn's last message, back to A's chat as its next turn; B's chat is its own again after.
  await until(() => said(onA, "user").some((t) => t.includes("smoke ok")), 60_000);
  const answer = cloud.state.tree.mail.find((m) => m.channel === "mac" && m.verb === "answer")!;
  expect((answer.payload as { mail: { in_reply_to: string; expects_reply: boolean } }).mail).toMatchObject({ in_reply_to: asked!.id, expects_reply: false });
  await until(async () => (await b.local.call("workspace.get", { workspace_id: onB.workspace.id })).asked_by_session_id === undefined, 30_000);
  // The chat that asked tells the person: it is never named as asked by anyone for its answer's turn.
  expect((await a.local.call("workspace.get", { workspace_id: onA.workspace.id })).asked_by_session_id).toBeUndefined();

  // Mail signed by a key none of the person's Macs vouched for (Cloud's own, a stolen phone's): not run, and the chat
  // says so, without its words.
  const { lease: _first, ...carriedFirst } = carried;
  const rogueMail = await signAgentMail(await testDevice("Rogue agents"), { ...(carried.payload as { mail: AgentMail }).mail, message_id: crypto.randomUUID() }, "From a rogue key");
  cloud.state.tree.mail.push({ ...carriedFirst, id: cloud.state.tree.nextId(), request_id: "forged:rogue", body: "From a rogue key", delivered: false, payload: { ...(carried.payload as object), mail: rogueMail, recipient_seq: 50 } });
  await until(() => notes(onB).some((n) => /none of your Macs this Mac trusts vouched for/.test(n.body ?? "")), 30_000);
  expect(said(onB, "user")).not.toContain("From a rogue key");
  expect(notes(onB).some((n) => (n.body ?? "").includes("From a rogue key"))).toBe(false);

  // Cloud hands the same mail out again: B runs it once.
  const before = turnsDone(onB);
  carried.delivered = false;
  delete carried.lease;
  await until(() => carried.delivered, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(turnsDone(onB)).toBe(before);
  expect(said(onB, "user").filter((t) => t === "hold 2000 What does your README say?")).toHaveLength(1);

  // Cloud changes a mail it carries (its body, or the modes it was signed with) or makes one up from a genuine one: B
  // runs none of them and takes them off Cloud's hands; the chat already had its note for refused mail this hour, so
  // these are only logged (one note an hour per chat), and no note ever holds a body.
  const genuine = carried.payload as { mail: Record<string, unknown> };
  const { lease: _lease, ...carriedOnce } = carried;
  const forge = (requestId: string, body: string, mail: Record<string, unknown>) => {
    const row = { ...carriedOnce, id: cloud.state.tree.nextId(), request_id: requestId, body, delivered: false, payload: { ...genuine, mail, recipient_seq: 90 + cloud.state.tree.mail.length } };
    cloud.state.tree.mail.push(row);
    return row;
  };
  const notesBeforeForgery = notes(onB).length;
  const forgeries = [
    forge("forged:body", "Rewritten by Cloud", genuine.mail),
    forge("forged:modes", carried.body, { ...genuine.mail, runtime_mode: "auto", message_id: "00000000-0000-4000-8000-000000000001" }),
    forge("forged:person", carried.body, { ...genuine.mail, user_id: "user-2", message_id: "00000000-0000-4000-8000-000000000002" }),
  ];
  await until(() => forgeries.every((row) => row.delivered), 30_000);
  expect(said(onB, "user")).not.toContain("Rewritten by Cloud");
  expect(said(onB, "user").filter((t) => t === "hold 2000 What does your README say?")).toHaveLength(1);
  expect(notes(onB).length).toBe(notesBeforeForgery);
  expect(notes(onB).some((n) => (n.body ?? "").includes("Rewritten by Cloud"))).toBe(false);

  // Cloud hands a genuine mail for the helper to another of Mac B's chats (its session, Cloud's word): not run there.
  const other = await chat(cloud, b, "Bystander");
  const misdelivered = (await send(a, { from: onA, to: onB, text: "Only for the helper", key: "misdelivered" }))!.id;
  const genuineRow = cloud.state.tree.mail.find((m) => m.request_id === `mac:${misdelivered}`)!;
  await until(() => genuineRow.delivered, 30_000);
  const { lease: _held, ...genuineOnce } = genuineRow;
  cloud.state.tree.mail.push({ ...genuineOnce, id: cloud.state.tree.nextId(), request_id: "forged:elsewhere", delivered: false, payload: { ...(genuineRow.payload as object), session_id: other.workspace.session_id, recipient_seq: 1 } });
  await until(() => notes(other).some((n) => /signed for another chat/.test(n.body ?? "")), 30_000);
  expect(said(other, "user")).not.toContain("Only for the helper");

 // Modes (upstream thread_send rule: nothing a chat writes reaches broader modes than its own). A chat on A that asks
  // for approvals mails B's chat, which runs with full access: B refuses it, and the asker gets a status line.
  const careful = await chat(cloud, a, "Careful", "ask");
  const narrow = await send(a, { from: careful, to: onB, text: "Run with less", key: "narrow", ask: true, runtimeMode: "approval-required" });
  await until(() => said(careful, "user").some((t) => t.startsWith("[refused]")), 60_000);
  expect(said(onB, "user")).not.toContain("Run with less");
  const refusal = cloud.state.tree.mail.find((m) => m.channel === "mac" && (m.payload as { mail: { in_reply_to: string } }).mail.in_reply_to === narrow!.id)!;
  expect(refusal.verb).toBe("answer");
  // The status line is signed with the replying chat's own modes (full access), never the asker's limits it refused.
  expect((refusal.payload as { mail: { runtime_mode: string } }).mail.runtime_mode).toBe("full-access");
  // A's full-access chat asks a chat on B that asks for approvals: it runs there (narrower), and its answer reaches A
  // only as word that it is there, never its words.
  const strict = await chat(cloud, b, "Strict", "ask");
  // (Cloud is one from before asked_by_session_id now: B's summaries go without it, and still land. The mail's turn
  // holds a moment, as the name is given only while it runs.)
  cloud.state.chats.askedByUnknown = true;
  const refusedBefore = cloud.state.chats.refused.length;
  const repliesBefore = said(onA, "user").length;
  await send(a, { from: onA, to: strict, text: "hold 3000 Summarize for me", key: "to-strict", ask: true });
  await until(() => said(strict, "user").includes("hold 3000 Summarize for me"), 60_000);
  await until(() => said(onA, "user").length > repliesBefore, 60_000);
  const undelivered = said(onA, "user").slice(repliesBefore).join("\n");
  expect(undelivered).toContain("can't be delivered to a chat with broader permissions");
  expect(undelivered).not.toContain("smoke ok");
  expect(cloud.state.chats.refused.slice(refusedBefore).some((r) => r.route === "summary" && /asked_by_session_id/.test(r.why))).toBe(true);
  await until(() => cloud.state.chats.summaries.get(strict.workspace.session_id)?.status === "idle" && turnsDone(strict) > 0, 30_000);
  cloud.state.chats.askedByUnknown = false;

  // Mac B removes Mac A on its screen: A's agents key stops counting there with it.
  await b.local.call("device.remove", { request_id: "rm-a", device_id: a.key.device_id, statement: await removeStatement(b.local, b.key, a.key.device_id) });
  const afterRemoval = (await send(a, { from: onA, to: onB, text: "After the removal", key: "after-removal" }))!.id;
  const removedRow = cloud.state.tree.mail.find((m) => m.request_id === `mac:${afterRemoval}`)!;
  await until(() => removedRow.delivered, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(said(onB, "user")).not.toContain("After the removal");
  console.log(`mac mail (test Cloud, lab-only): an ask from Mac A ran on Mac B's chat ${ranMs} ms after it was sent`);
}, 300_000);

test("only This Mac's own screen sees or vouches for its agents key, for that key only; a Mac without the desktop app sends no mail", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const [a, plain] = [await mac(cloud, "Mac A"), await mac(cloud, "Headless Mac", { agents: false })];
  const phone = await testDevice("iPhone, Safari");
  const relayed = await allowedStream(a.relay, a.local, phone);
  expect((await relayed.call("device.agents", {})).error).toMatchObject({ data: { reason: "forbidden" } });
  const { agents, name } = await a.local.call("device.agents", {});
  const family = (await a.local.call("device.list", {})).family;
  const statement = (await agentsStatementFor(a.key, family, agents!, name))!;
  expect((await relayed.call("device.vouch", { request_id: "v-relay", statement })).error).toMatchObject({ data: { reason: "forbidden" } });
  // A vouch for another key, or under another name, is not this runtime's.
  const other = await testDevice("Other agents");
  const wrongKey = (await agentsStatementFor(a.key, family, { device_id: other.device_id, public_key: other.public_key }, name))!;
  await expect(a.local.call("device.vouch", { request_id: "v-wrong", statement: wrongKey })).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });
  const wrongName = (await agentsStatementFor(a.key, family, agents!, "Someone else's Mac"))!;
  await expect(a.local.call("device.vouch", { request_id: "v-name", statement: wrongName })).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });
  // A phone's key vouches for nothing (only a Mac's desktop key signs one).
  expect(await agentsStatementFor(phone as DeviceKey, family, agents!, name)).toBeUndefined();
  expect(await a.local.call("device.vouch", { request_id: "v-ok", statement })).toEqual({ vouched: true });
  await until(() => cloud.state.devices.rows.some((r) => (r.statement as { kind?: string; device_id?: string }).kind === "agents" && (r.statement as { device_id?: string }).device_id === agents!.device_id), 15_000);

  // The headless runtime has no agents key: nothing to vouch for, and its chats send no mail between Macs.
  expect(await plain.local.call("device.agents", {})).toMatchObject({ vouched: false });
  expect((await plain.local.call("device.agents", {})).agents).toBeUndefined();
  const [from, to] = [await chat(cloud, plain, "Headless chat"), await chat(cloud, a, "On A")];
  await expect(send(plain, { from, to, text: "hi", key: "headless" })).rejects.toMatchObject({ reason: "unavailable" });
}, 240_000);

/** Two of the person's Macs that allowed each other on their screens and vouched for their agents keys. */
async function family(cloud: TestCloud, options: { readonly clockB?: () => number } = {}) {
  const [a, b] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B", options.clockB ? { clock: options.clockB } : {})];
  await allowMac(a, b);
  await allowMac(b, a);
  await until(async () => (await trusts(a, b)) && (await trusts(b, a)), 15_000);
  expect(await vouch(a)).toEqual({ vouched: true });
  expect(await vouch(b)).toEqual({ vouched: true });
  return { a, b };
}
const answersTo = (cloud: TestCloud, id: string) => cloud.state.tree.mail.filter((m) => m.channel === "mac" && (m.payload as { mail: { in_reply_to: string } }).mail.in_reply_to === id);
const askedBy = async (on: Mac, c: Chat) => (await on.local.call("workspace.get", { workspace_id: c.workspace.id })).asked_by_session_id;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an ask settles once however it ends: the agent replied itself, it was taken out of the queue, or the asker is gone; the chat is its own again after", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];

  // 1. B's agent answers with thread_send(inReplyTo) while the turn the ask started runs: that is the answer, the
  // turn's end sends no second one, and B's chat is its own again once the turn ends.
  const turns = turnsDone(onB);
  const asked = (await send(a, { from: onA, to: onB, text: "hold 6000 What is two plus two?", key: "self", ask: true }))!.id;
  await until(() => said(onB, "user").includes("hold 6000 What is two plus two?"), 60_000);
  await until(async () => (await askedBy(b, onB)) === onA.workspace.session_id, 30_000);
  await send(b, { from: onB, to: onA, text: "four, said the agent", key: "self-reply", inReplyTo: asked });
  await until(() => turnsDone(onB) > turns, 60_000);
  await until(async () => (await askedBy(b, onB)) === undefined, 30_000);
  await until(() => said(onA, "user").includes("four, said the agent"), 60_000);
  await sleep(3_000);
  expect(answersTo(cloud, asked)).toHaveLength(1);

  // 2. An ask queued behind the person's own turn on B, taken out of the queue there: it never runs, and the asker
  // hears so. While it waits, the person's own turn is the person's: B's chat names no one as asking for it.
  await b.local.call("turn.submit", { request_id: "busy", session_id: onB.workspace.session_id, kind: "followup", input: { text: "hold 60000 the person's own work" } });
  await until(() => said(onB, "user").includes("hold 60000 the person's own work"), 30_000);
  const queuedAsk = (await send(a, { from: onA, to: onB, text: "Queued ask", key: "queued", ask: true }))!.id;
  let queued: string | undefined;
  await until(async () => (queued = (await b.local.call("queue.list", { session_id: onB.workspace.session_id })).turns.find((t) => t.text === "Queued ask")?.turn_id) !== undefined, 60_000);
  await sleep(1_000);
  expect(await askedBy(b, onB)).toBeUndefined();
  await b.local.call("queue.remove", { request_id: "rm-ask", session_id: onB.workspace.session_id, turn_id: queued! });
  await until(() => said(onA, "user").some((t) => t.startsWith("[not run]") && t.includes("taken out of that chat's queue")), 90_000);
  await until(async () => (await askedBy(b, onB)) === undefined, 30_000);
  expect(answersTo(cloud, queuedAsk)).toHaveLength(1);
  expect(said(onB, "user")).not.toContain("Queued ask");
  await b.local.call("turn.interrupt", { request_id: "stop-busy", session_id: onB.workspace.session_id });

  // 3. The asking chat is archived while B runs its ask: Cloud refuses the answer for good, so it goes once, not on
  // every pass, and B's chat is its own again.
  const leaver = await chat(cloud, a, "Leaver");
  const leaving = (await send(a, { from: leaver, to: onB, text: "hold 8000 Answer the one who left", key: "leaver", ask: true }))!.id;
  await until(() => said(onB, "user").includes("hold 8000 Answer the one who left"), 90_000);
  await a.local.call("workspace.archive", { request_id: "archive-leaver", workspace_id: leaver.workspace.id });
  await until(() => [...cloud.state.chats.summaries.entries()].some(([id, s]) => id === leaver.workspace.session_id && s.archived === true), 30_000);
  await until(() => cloud.state.mac.sends.some((x) => (x.body.mail as { in_reply_to?: string } | undefined)?.in_reply_to === leaving && x.status === 409), 90_000);
  await until(async () => (await askedBy(b, onB)) === undefined, 30_000);
  // A look later (the sweep runs every 30 s) sends nothing more.
  await sleep(35_000);
  expect(cloud.state.mac.sends.filter((x) => (x.body.mail as { in_reply_to?: string } | undefined)?.in_reply_to === leaving)).toHaveLength(1);
}, 420_000);

test("mail from a Mac removed after it queued never runs: it leaves the queue at once, and its sender hears only that it was removed (A-4)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  // The person's own long turn runs on B, and two asks from A (a stolen Mac, say) queue behind it.
  await b.local.call("turn.submit", { request_id: "busy", session_id: onB.workspace.session_id, kind: "followup", input: { text: "hold 60000 the person's own work" } });
  await until(() => said(onB, "user").includes("hold 60000 the person's own work"), 30_000);
  const queuedTexts = () => b.local.call("queue.list", { session_id: onB.workspace.session_id }).then((q) => q.turns.map((t) => t.text));
  const first = (await send(a, { from: onA, to: onB, text: "Queued from a Mac about to go", key: "doomed", ask: true }))!.id;
  const second = (await send(a, { from: onA, to: onB, text: "A note queued too", key: "doomed-note" }))!.id;
  await until(async () => (await queuedTexts()).includes("Queued from a Mac about to go") && (await queuedTexts()).includes("A note queued too"), 60_000);
  // B's screen removes A: what A queued leaves B's queue at once, without waiting for the person's turn to end.
  const removedAt = Date.now();
  await b.local.call("device.remove", { request_id: "rm-a", device_id: a.key.device_id, statement: await removeStatement(b.local, b.key, a.key.device_id) });
  await until(async () => !(await queuedTexts()).some((t) => t === "Queued from a Mac about to go" || t === "A note queued too"), 30_000);
  console.log(`mac mail (test Cloud, lab-only): a removed Mac's queued mail left the queue ${Date.now() - removedAt} ms after the removal`);
  // The ask's sender hears it did not run, and why; the note owed no answer, and gets none.
  await until(() => said(onA, "user").some((t) => t.startsWith("[not run]") && t.includes("was removed")), 60_000);
  expect(answersTo(cloud, first)).toHaveLength(1);
  expect(answersTo(cloud, second)).toHaveLength(0);
  // The person's turn ends: nothing A sent runs after it.
  await b.local.call("turn.interrupt", { request_id: "stop-busy", session_id: onB.workspace.session_id });
  await until(async () => (await b.local.call("workspace.get", { workspace_id: onB.workspace.id })).status === "idle", 30_000);
  await sleep(3_000);
  expect(said(onB, "user")).not.toContain("Queued from a Mac about to go");
  expect(said(onB, "user")).not.toContain("A note queued too");
}, 300_000);

test("an answer nobody asked for is mail like any other: into a broader chat it starts nothing, and an ask takes one answer", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  // A's chat runs with full access; B's asks for approvals.
  const [wide, strict] = [await chat(cloud, a, "Wide"), await chat(cloud, b, "Strict", "ask")];
  const turnsA = turnsDone(wide);
  // B's narrow chat makes up an answer to an ask A's chat never sent: refused, nothing runs on A.
  const notesBefore = notes(wide).length;
  await send(b, { from: strict, to: wide, text: "Unasked answer", key: "unasked", inReplyTo: "00000000-0000-4000-8000-00000000abcd", runtimeMode: "approval-required" });
  await until(() => notes(wide).slice(notesBefore).some((n) => /broader permissions than the chat that sent it/.test(n.body ?? "")), 30_000);
  expect(said(wide, "user").some((t) => t.includes("Unasked answer") || t.includes("answered, but"))).toBe(false);
  expect(turnsDone(wide)).toBe(turnsA);

 // A's chat asks B's: the answer comes as word that it is there (upstream rule); a second answer to the same ask does not.
  const asked = (await send(a, { from: wide, to: strict, text: "Summarize for me", key: "ask-strict", ask: true }))!.id;
  await until(() => said(wide, "user").some((t) => t.includes("can't be delivered to a chat with broader permissions")), 90_000);
  const delivered = said(wide, "user").length;
  // Refused as mail into a broader chat (its note already given this hour, so only logged): taken, and nothing runs.
  const second = (await send(b, { from: strict, to: wide, text: "Second answer", key: "second", inReplyTo: asked, runtimeMode: "approval-required" }))!.id;
  const secondRow = cloud.state.tree.mail.find((m) => m.request_id === `mac:${second}`)!;
  await until(() => secondRow.delivered, 30_000);
  await sleep(2_000);
  expect(said(wide, "user")).toHaveLength(delivered);
}, 240_000);

test("mail this Mac cannot run yet stays its own and runs as soon as it can: a log not read since it woke holds it, then it runs at once", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  let skew = 0;
  const { a, b } = await family(cloud, { clockB: () => Date.now() + skew });
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  // Mac B "wakes" an hour later and its log does not answer: its trust is not fresh, so nothing it would run waits on it.
  cloud.state.devices.hold = (runtimeId) => runtimeId === b.runtimeId;
  skew = 60 * 60_000;
  await send(a, { from: onA, to: onB, text: "After the wake", key: "wake" });
  const row = () => cloud.state.tree.mail.find((m) => m.channel === "mac" && m.body === "After the wake");
  await until(() => row()?.lease !== undefined, 30_000);
  // Held by Mac B, its lease kept, while the log is not read.
  await until(() => cloud.state.mac.renews.some((r) => r.ids.includes(row()!.id)), 30_000);
  expect(said(onB, "user")).not.toContain("After the wake");
  expect(row()!.delivered).toBe(false);
  // The log answers again: the mail runs at once, not when a lease lapses.
  const back = Date.now();
  cloud.state.devices.hold = undefined;
  await until(() => said(onB, "user").includes("After the wake"), 60_000);
  const ranMs = Date.now() - back;
  expect(ranMs).toBeLessThan(15_000);
  console.log(`mac mail (test Cloud, lab-only): held mail ran ${ranMs} ms after Mac B's log answered again`);
}, 240_000);

test("receiving mail never registers a chat with Cloud: mail Cloud points at a chat this Mac keeps to itself does not run there", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  // A genuine mail, delivered while Mac B still syncs its chats: once sync is off, B's next pass takes Helper out of
  // Cloud too, and mail for a chat B no longer shares does not run (the same rule this test proves for Kept here).
  const genuine = (await send(a, { from: onA, to: onB, text: "For the helper", key: "helper" }))!.id;
  const genuineRow = cloud.state.tree.mail.find((m) => m.request_id === `mac:${genuine}`)!;
  await until(() => genuineRow.delivered, 30_000);
  await b.local.call("settings.set", { request_id: "sync-off", settings: { sync_chats: false } });
  const own = await chat(cloud, b, "Kept here", undefined, { synced: false });
  const { lease: _held, ...genuineOnce } = genuineRow;
  cloud.state.tree.mail.push({ ...genuineOnce, id: cloud.state.tree.nextId(), request_id: "forged:kept", delivered: false, payload: { ...(genuineRow.payload as object), session_id: own.workspace.session_id, recipient_seq: 7 } });
  await sleep(8_000);
  expect(cloud.state.tree.registrations.has(own.workspace.session_id)).toBe(false);
  expect(said(own, "user")).not.toContain("For the helper");
}, 180_000);

// Chats that do not sync are not Cloud's (devices.ts): an agent's send from one never registers it with Cloud (its
// title, repository and branches) on the agent's word alone. The send is refused, naming the setting.
test("sending mail never registers a chat with Cloud either: from a chat that does not sync the send is refused, naming the setting", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const onB = await chat(cloud, b, "Helper");
  // A chat that synced while copying was on, and has a copy in Cloud.
  const before = await chat(cloud, a, "Synced once");
  await a.local.call("settings.set", { request_id: "sync-off", settings: { sync_chats: false } });
  const own = await chat(cloud, a, "Kept here", undefined, { synced: false });
  const refused = await send(a, { from: own, to: onB, text: "Hello from a chat kept here", key: "kept" }).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  expect(refused?.message).toMatch(/\(Settings, Computers\)/);
  expect(cloud.state.tree.registrations.has(own.workspace.session_id)).toBe(false);
  // Copying off: nothing goes through Cloud from the chat that synced before either (m-l).
  const sentBefore = cloud.state.mac.sends.length;
  const refusedToo = await send(a, { from: before, to: onB, text: "Hello from a chat that synced once", key: "synced-once" }).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  expect(refusedToo?.message).toMatch(/\(Settings, Computers\)/);
  expect(cloud.state.mac.sends.length).toBe(sentBefore);
  await sleep(3_000);
  expect(said(onB, "user")).not.toContain("Hello from a chat kept here");
  expect(said(onB, "user")).not.toContain("Hello from a chat that synced once");
}, 180_000);

/** The cursor of the last event a chat's stream gave so far. */
const headOf = (c: Chat) => c.events.at(-1)?.cursor ?? 0;
const startedAfter = (c: Chat, cursor: number) => c.events.some((e) => e.type === "turn.started" && e.cursor > cursor);

test("an ask's answer is its own turn's words, never a turn it queued behind; an ask a move leaves behind tells its asker before the chat goes", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];

  // 1. The person's own turn on B answers with words of theirs; an ask from A queues behind it, starts once it ended,
  // and is stopped before it says anything. Its answer says it was stopped, and holds none of the person's words.
  await b.local.call("turn.submit", { request_id: "private", session_id: onB.workspace.session_id, kind: "followup", input: { text: "hold 5000 PRIVATE notes of the person" } });
  await until(() => said(onB, "user").includes("hold 5000 PRIVATE notes of the person"), 30_000);
  const quiet = (await send(a, { from: onA, to: onB, text: "hold 60000 a question it never answers", key: "quiet", ask: true }))!.id;
  await until(() => said(onB, "assistant").some((t) => t.includes("PRIVATE")), 60_000);
  const privateDone = headOf(onB);
  await until(() => startedAfter(onB, privateDone), 60_000);
  await sleep(1_000);
  await b.local.call("turn.interrupt", { request_id: "stop-quiet", session_id: onB.workspace.session_id });
  await until(() => answersTo(cloud, quiet).length === 1, 60_000);
  const answer = answersTo(cloud, quiet)[0]!;
  expect(answer.body).toMatch(/^\[interrupted\]/);
  expect(answer.body).not.toContain("PRIVATE");
  await until(() => said(onA, "user").some((t) => t.startsWith("[interrupted]")), 60_000);
  expect(said(onA, "user").some((t) => t.includes("PRIVATE"))).toBe(false);

  // 2. The person's long turn on B, an ask from A queued behind it, and the chat moves to a Cloud computer. B settles
  // the ask as it lets the chat go, while Cloud still has the chat on B (after the move Cloud takes no reply from B for
  // it): A hears it did not run, and it is out of the queue the chat left.
  await b.local.call("settings.set", { request_id: "moves-on", settings: { move_to_cloud: true } });
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  cloud.state.environments.computers = true;
  const box = cloud.enrollRuntime({ kind: "cloud" });
  await b.local.call("turn.submit", { request_id: "long", session_id: onB.workspace.session_id, kind: "followup", input: { text: "hold 60000 the person's long work" } });
  await until(() => said(onB, "user").includes("hold 60000 the person's long work"), 30_000);
  const behind = (await send(a, { from: onA, to: onB, text: "Behind the long work", key: "behind", ask: true }))!.id;
  await until(async () => (await b.local.call("queue.list", { session_id: onB.workspace.session_id })).turns.some((t) => t.text === "Behind the long work"), 60_000);
  await b.local.call("session.move", { request_id: "away", session_id: onB.workspace.session_id, to: { computer_id: box.computerId } });
  await until(() => cloud.state.chats.sessions.get(onB.workspace.session_id)?.computer_id === box.computerId, 60_000);
  await until(() => said(onA, "user").some((t) => t.startsWith("[not run]") && t.includes("was moving to another computer") && t.includes("send it again")), 60_000);
  const sent = cloud.state.mac.sends.filter((x) => (x.body.mail as { in_reply_to?: string } | undefined)?.in_reply_to === behind);
  expect(sent.map((x) => x.status)).toEqual([200]);
  expect(answersTo(cloud, behind)).toHaveLength(1);
  // Taken out of the queue it left: it runs nowhere, even should the chat come back.
  expect(said(onB, "user")).not.toContain("Behind the long work");
}, 300_000);

test("an ask running in a chat the lid hands to a Cloud computer mid-turn: its asker hears the turn carries on there, never its stop as the answer (F-5)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // Cloud runs Cloud computers, and has a Claude Agent login there (the lid's checks), from before the Macs ask.
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  cloud.state.environments.computers = true;
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  await b.local.call("settings.set", { request_id: "moves-on", settings: { move_to_cloud: true } });
  const box = cloud.enrollRuntime({ kind: "cloud" });
  // A's ask runs on B as its chat's turn, and is at work when B's lid closes.
  const asked = (await send(a, { from: onA, to: onB, text: "hold 60000 Migrate the 7 tables", key: "lid-ask", ask: true }))!.id;
  await until(() => said(onB, "user").includes("hold 60000 Migrate the 7 tables"), 60_000);
  await until(async () => (await askedBy(b, onB)) === onA.workspace.session_id, 30_000);
  const out = await b.local.call("cloud.suspend", { request_id: "lid-b", budget_ms: 5_000 });
  expect(out).toMatchObject({ handed_off: [onB.workspace.session_id] });
  await until(() => cloud.state.chats.sessions.get(onB.workspace.session_id)?.computer_id === box.computerId, 60_000);
  // The turn goes on on the Cloud computer, which sends no mail between Macs: A hears that, once, and not its stop.
  await until(() => answersTo(cloud, asked).length > 0, 60_000);
  await sleep(2_000);
  expect(answersTo(cloud, asked)).toHaveLength(1);
  expect(answersTo(cloud, asked)[0]!.body).toMatch(/^\[no answer\] That chat's Mac closed its lid in the middle of this mail's turn/);
  await until(() => said(onA, "user").some((t) => t.startsWith("[no answer]") && t.includes("rather than sending this again")), 60_000);
  expect(said(onA, "user").some((t) => t.startsWith("[interrupted]"))).toBe(false);
}, 300_000);

test("an ask running in a chat that loses Caveman is answered by the turn that carries it on once Caveman answers, never '[interrupted]' (F-5, decision 26)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  await b.local.call("settings.set", { request_id: "moves-on", settings: { move_to_cloud: true } });
  const asked = (await send(a, { from: onA, to: onB, text: "hold 600000 Migrate the 7 tables", key: "offline-ask", ask: true }))!.id;
  await until(() => said(onB, "user").includes("hold 600000 Migrate the 7 tables"), 60_000);
  await until(() => cloud.state.chats.sessions.get(onB.workspace.session_id)?.lease !== null, 30_000);
  // The network goes: within its lease the turn stops on B, to carry on by itself once Caveman answers.
  cloud.state.unreachable = true;
  await until(() => notes(onB).some((n) => n.title === "Lost the connection to Caveman"), 120_000);
  await until(async () => (await b.local.call("workspace.get", { workspace_id: onB.workspace.id })).status === "idle", 60_000);
  await sleep(3_000);
  cloud.state.unreachable = false;
  await until(() => notes(onB).some((n) => n.title === "Back online, continuing"), 90_000);
  // The answer is the words of the turn that carried it on, once.
  await until(() => answersTo(cloud, asked).length > 0, 90_000);
  await sleep(3_000);
  expect(answersTo(cloud, asked)).toHaveLength(1);
  const answer = answersTo(cloud, asked)[0]!.body;
  expect(answer).toMatch(/^smoke ok: /);
  expect(answer).toContain("lost its connection to Caveman");
  await until(() => said(onA, "user").some((t) => t.startsWith("smoke ok: ") && t.includes("lost its connection to Caveman")), 60_000);
  expect(said(onA, "user").some((t) => t.startsWith("[interrupted]"))).toBe(false);
}, 420_000);

test("mail for a chat paused on its Mac is refused at once with a status line, and the reader goes back to Cloud's long wait", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper", undefined, { pushable: true })];
  await b.local.call("session.park", { request_id: "pause", session_id: onB.workspace.session_id });
  const asked = (await send(a, { from: onA, to: onB, text: "Are you there?", key: "paused", ask: true }))!.id;
  await until(() => said(onA, "user").some((t) => t.startsWith("[not run]") && t.includes("paused")), 60_000);
  const row = cloud.state.tree.mail.find((m) => m.request_id === `mac:${asked}`)!;
  await until(() => row.delivered, 30_000);
  expect(said(onB, "user")).not.toContain("Are you there?");
  // Nothing held: B waits on Cloud's long poll, never a take every 2 s.
  const computerB = cloud.state.runtimes.get(b.runtimeId)!.computerId;
  const takesByB = () => cloud.state.mac.takes.filter((c) => c === computerB).length;
  const before = takesByB();
  await sleep(12_000);
  expect(takesByB() - before).toBeLessThanOrEqual(1);
}, 180_000);

test("a flood of mail from keys no Mac vouched for costs a chat one note an hour, and holds no genuine mail up", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  const first = (await send(a, { from: onA, to: onB, text: "First, genuine", key: "first" }))!.id;
  await until(() => said(onB, "user").includes("First, genuine"), 60_000);
  const template = cloud.state.tree.mail.find((m) => m.request_id === `mac:${first}`)!;
  const genuine = (template.payload as { mail: AgentMail }).mail;
  const { lease: _lease, ...once } = template;
  const notesBefore = notes(onB).length;
  // 40 well-signed by fresh keys none of the person's Macs vouched for, and 10 that do not verify, numbered before the next genuine one.
  const forged: Array<{ delivered: boolean }> = [];
  for (let i = 0; i < 50; i++) {
    const body = `forged ${i}`;
    const mail = i < 40 ? await signAgentMail(await testDevice(`rogue ${i}`), { ...genuine, message_id: crypto.randomUUID() }, body) : { ...genuine, message_id: crypto.randomUUID(), signature: "" };
    const row = { ...once, id: cloud.state.tree.nextId(), request_id: `forged:${i}`, body, delivered: false, payload: { ...(template.payload as object), mail, recipient_seq: 2 + i } };
    cloud.state.tree.mail.push(row);
    forged.push(row);
  }
  const sentAt = Date.now();
  await send(a, { from: onA, to: onB, text: "Second, genuine", key: "second" });
  await until(() => said(onB, "user").includes("Second, genuine"), 60_000);
  const ranMs = Date.now() - sentAt;
  await until(() => forged.every((row) => row.delivered), 30_000);
  expect(notes(onB).length - notesBefore).toBe(1);
  expect(notes(onB).some((n) => /forged/.test(n.body ?? ""))).toBe(false);
  expect(said(onB, "user").some((t) => t.startsWith("forged"))).toBe(false);
  expect(ranMs).toBeLessThan(20_000);
  console.log(`mac mail (test Cloud, lab-only): a genuine mail behind 50 forged ones ran ${ranMs} ms after it was sent`);
}, 240_000);

test("a chat names the chat that asked only while that mail's own turn runs: never for the person's turn it queued behind, nor while its answer waits to go", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  // The person's own turn on B; an ask from A queues behind it: that turn is the person's, and names no one.
  await b.local.call("turn.submit", { request_id: "own", session_id: onB.workspace.session_id, kind: "followup", input: { text: "hold 6000 the person's own work" } });
  await until(() => said(onB, "user").includes("hold 6000 the person's own work"), 30_000);
  // Cloud refuses the answer for now, as for an asker the lid moved to a Cloud computer: it is kept and tried later.
  cloud.state.mac.refuse = (body) => ((body.mail as { in_reply_to?: string } | undefined)?.in_reply_to ? { status: 409, code: "cave_code_mac_mail_not_another_mac" } : undefined);
  const asked = (await send(a, { from: onA, to: onB, text: "hold 3000 Work on this", key: "q", ask: true }))!.id;
  await until(async () => (await b.local.call("queue.list", { session_id: onB.workspace.session_id })).turns.some((t) => t.text === "hold 3000 Work on this"), 60_000);
  await sleep(1_000);
  expect(await askedBy(b, onB)).toBeUndefined();
  // The mail's own turn runs: B's chat names the asker while it does.
  await until(async () => (await askedBy(b, onB)) === onA.workspace.session_id, 60_000);
  expect(said(onB, "user")).toContain("hold 3000 Work on this");
  // It ends; its answer is refused for now: the chat is its own again at once, not once the answer goes.
  await until(() => cloud.state.mac.sends.some((x) => (x.body.mail as { in_reply_to?: string } | undefined)?.in_reply_to === asked && x.status === 409), 60_000);
  await until(async () => (await askedBy(b, onB)) === undefined, 10_000);
  // The person's next turn there is theirs, though the answer still waits to go.
  await b.local.call("turn.submit", { request_id: "own-2", session_id: onB.workspace.session_id, kind: "followup", input: { text: "hold 3000 more of the person's work" } });
  await until(() => said(onB, "user").includes("hold 3000 more of the person's work"), 30_000);
  await sleep(1_000);
  expect(await askedBy(b, onB)).toBeUndefined();
  expect(cloud.state.mac.sends.filter((x) => (x.body.mail as { in_reply_to?: string } | undefined)?.in_reply_to === asked && x.status === 200)).toHaveLength(0);
}, 240_000);

test("a Mac sends no mail until Cloud has its agents key's vouch: the send is refused and nothing reaches the other Mac, then it runs", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const [a, b] = [await mac(cloud, "Mac A"), await mac(cloud, "Mac B")];
  await allowMac(a, b);
  await allowMac(b, a);
  await until(async () => (await trusts(a, b)) && (await trusts(b, a)), 15_000);
  await vouch(b);
  // Cloud does not take Mac A's vouch for now (busy, or the Mac offline a moment): it waits in A's outbox.
  cloud.state.devices.refuse = (raw) => ((raw as { kind?: string }).kind === "agents" ? { status: 503, code: "cave_unavailable", message: "busy" } : undefined);
  expect(await vouch(a, { shared: false })).toEqual({ vouched: true });
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  expect(await a.local.call("device.agents", {})).toMatchObject({ vouched: true, shared: false });
  // Sent now, Mac B would take it for a key no Mac vouched for and drop it for good: A refuses to send it.
  await expect(send(a, { from: onA, to: onB, text: "Too soon", key: "too-soon" })).rejects.toMatchObject({ reason: "unavailable", message: expect.stringMatching(/not vouched for/) });
  expect(cloud.state.tree.mail.some((m) => m.channel === "mac")).toBe(false);
  // Cloud takes it: A's mail goes, and B runs it.
  cloud.state.devices.refuse = undefined;
  await until(async () => (await a.local.call("device.agents", {})).shared === true, 90_000);
  await send(a, { from: onA, to: onB, text: "In time", key: "in-time" });
  await until(() => said(onB, "user").includes("In time"), 60_000);
  expect(notes(onB).some((n) => /vouched for/.test(n.body ?? ""))).toBe(false);
}, 240_000);

test("an ask a move left behind tells its asker what holds whether or not the move lands: Cloud refuses the move, the chat carries on here, and the ask stays out", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { a, b } = await family(cloud);
  const [onA, onB] = [await chat(cloud, a, "Asker"), await chat(cloud, b, "Helper")];
  await b.local.call("settings.set", { request_id: "moves-on", settings: { move_to_cloud: true } });
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  cloud.state.environments.computers = true;
  const box = cloud.enrollRuntime({ kind: "cloud" });
  await b.local.call("turn.submit", { request_id: "long", session_id: onB.workspace.session_id, kind: "followup", input: { text: "hold 60000 the person's long work" } });
  await until(() => said(onB, "user").includes("hold 60000 the person's long work"), 30_000);
  const behind = (await send(a, { from: onA, to: onB, text: "Behind the refused move", key: "behind-refused", ask: true }))!.id;
  await until(async () => (await b.local.call("queue.list", { session_id: onB.workspace.session_id })).turns.some((t) => t.text === "Behind the refused move"), 60_000);
  // Cloud refuses the move once the chat is parked and copied (its last step): it stays on Mac B.
  const computerB = cloud.state.runtimes.get(b.runtimeId)!.computerId;
  cloud.state.chats.refuseMoves.push({ computerId: computerB, status: 409, code: "cave_code_target_silent", message: "That computer is not answering." });
  const moved = await b.local.call("session.move", { request_id: "refused", session_id: onB.workspace.session_id, to: { computer_id: box.computerId } }).then(
    () => "moved",
    () => "refused",
  );
  expect(moved).toBe("refused");
  await until(async () => (await b.local.call("workspace.get", { workspace_id: onB.workspace.id })).status !== "parked", 30_000);
  expect(cloud.state.chats.sessions.get(onB.workspace.session_id)?.computer_id).toBe(computerB);
  // Its asker heard, before the move was known to land, words that hold either way: it was not run, send it again.
  await until(() => said(onA, "user").some((t) => t.startsWith("[not run]") && t.includes("was moving to another computer") && t.includes("send it again")), 60_000);
  expect(answersTo(cloud, behind)).toHaveLength(1);
  // And it is not run here after all, though the chat carries on here.
  await b.local.call("turn.submit", { request_id: "after", session_id: onB.workspace.session_id, kind: "followup", input: { text: "the person carries on" } });
  await until(() => said(onB, "user").includes("the person carries on"), 60_000);
  await sleep(2_000);
  expect(said(onB, "user")).not.toContain("Behind the refused move");
  expect(answersTo(cloud, behind)).toHaveLength(1);
}, 300_000);
