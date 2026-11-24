// Agent mail between a person's Macs (RESEARCH-W2 decision 33; session-protocol/macMail.ts) against a REAL local
// Caveman Cloud (control-api on Postgres, the relay on Valkey). Mac A runs the whole runtime as the desktop app starts it
// (bin.ts, its agents key handed over on the bootstrap descriptor only), its chats on a scripted model endpoint of the
// person's own; Macs B and C are real runtime processes on the real Caveman engine with a scripted model, their agents
// keys from a test file. Each Mac has its own state dir, link key and desktop key (a software P-256 key in place of the
// keychain one). The Macs allowed each other on their own screens in a cycle (C allowed A, B allowed C, A allowed B: B
// trusts A only through C), and each screen vouched for its runtime's agents key.
//
// A chat on Mac A sends mail as its agent does: its model calls thread_send(mac:<B's chat>, expectReply) from the
// Caveman engine's code tool, so the limits signed are that chat's real modes. Proven here: B runs the ask once as the
// chat's next turn, its answer wakes A's chat (times recorded, lab-only, with the load); Cloud handing a mail out again
// runs nothing twice; rows written straight into Cloud's mailbox (no signature, another key, the phone's browser key,
// another person's, the body rewritten, the modes widened) start nothing and leave at most one note (one an hour per
// chat), never their words; a chat that asks for approvals mailing a broader chat is refused with a status line back,
// signed with the replying chat's own modes; a pending approval on B stays pending under mail that queues behind it;
// no chat's computer changes for any of it; an ask queued behind a turn on B that Mac C pulls (stopping that turn)
// tells its asker it did not run, before the chat goes; an answer finds the asking chat on Mac C after C pulled it from
// A; and with B asleep (SIGSTOP) while Mac C removes Mac A, the mail A sent meanwhile waits on B for a fresh read of
// the log and is then refused; a vouch the removed Mac signed afterwards (written into Cloud's log) for a key of its
// own counts for nothing, and mail that key signs runs nowhere. No agents key is ever on disk in the clear in any Mac's
// state. B's chat names its asker "Asker on Mac A", Mac A by the name B knows it under.
//
// Skipped unless CAVEMAN_E2E_MAC_MAIL=1 with CAVEMAN_E2E_CLOUD_URL, CAVEMAN_E2E_RELAY_URL, CAVEMAN_E2E_EMAIL,
// CAVEMAN_E2E_PASSWORD and CAVEMAN_E2E_PSQL (as devicesAcrossMacs.e2e.test.ts). CAVEMAN_E2E_RESULTS names a file for
// the evidence.
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { agentsStatementFor, signMove, signStatement, signStop, type DeviceKey, type SessionEvent } from "@caveman-app/session-protocol";
import { signAgentMail, type AgentMail } from "@caveman-app/session-protocol/mac-mail";
import { afterAll, expect, test } from "vitest";

import { agentsKeyOf } from "../session-protocol/agentsKey.ts";
import { testDevice } from "../session-protocol/devices.testkit.ts";
import { tempRoot, until } from "../session-protocol/testHarness.ts";
import { agentsKeyFile, allowOnScreen, CLOUD, codeTool, deviceList, front, github, load, person, PSQL, RELAY, removeOnScreen, scriptedModel, sql, startBox, startDesktopMac, startMac, stopAll, trusts, type Mac } from "./macs.e2e.kit.ts";

afterAll(stopAll);

const MODEL = "anthropic/claude-haiku-4-5";
const results: Record<string, unknown> = {};
const save = () => process.env.CAVEMAN_E2E_RESULTS && fs.writeFileSync(process.env.CAVEMAN_E2E_RESULTS, JSON.stringify(results, null, 1));
const live = !!process.env.CAVEMAN_E2E_MAC_MAIL && !!CLOUD && !!RELAY && !!PSQL && !!process.env.CAVEMAN_E2E_EMAIL && !!process.env.CAVEMAN_E2E_PASSWORD;

/** What the test reads of any Mac, a desktop one (startDesktopMac) or a runtime process (startMac). */
type AnyMac = Pick<Mac, "name" | "client" | "key">;

/**
 * `on`'s screen vouches for its runtime's agents key with its desktop key, as the desktop app's page does by itself, and
 * the vouch reaches Cloud (`shared`: only then does that Mac send mail).
 */
async function vouch(on: AnyMac) {
  const { agents, name } = await on.client.call("device.agents", {});
  const statement = await agentsStatementFor(on.key, (await deviceList(on as Mac)).family, agents!, name);
  const out = await on.client.call("device.vouch", { request_id: `vouch-${on.name}`, statement: statement! });
  await until(async () => (await on.client.call("device.agents", {})).shared === true, 60_000);
  return out;
}

const transcript = async (on: AnyMac, sessionId: string) => {
  const events: Array<SessionEvent> = [];
  const sub = await on.client.attach(sessionId, 0, (e) => events.push(e));
  await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
  await sub.detach();
  return events;
};
const said = (events: ReadonlyArray<SessionEvent>, role: "user" | "assistant") => events.flatMap((e) => (e.type === "message.done" && e.payload.role === role ? [e.payload.text] : []));
const noted = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "notification" ? [JSON.stringify(e.payload)] : []));
/** Approvals asked in a chat and not answered yet. */
const openApprovals = (events: ReadonlyArray<SessionEvent>) => {
  const resolved = new Set(events.flatMap((e) => (e.type === "ask.resolved" ? [e.item_id] : [])));
  return events.filter((e) => e.type === "ask.user" && (e.payload as { kind: string }).kind === "approval" && !resolved.has(e.item_id));
};

/** A chat on `on` in the stand-in GitHub repository, its first turn done, with its Cloud workspace. */
async function chat(on: AnyMac, repo: string, title: string, access: "auto" | "ask", model = MODEL) {
  const clone = path.join(tempRoot(`mac-mail-${on.name.replace(/\W/g, "")}-`), "repo");
  execFileSync("git", ["clone", "-q", repo, clone]);
  const w = await on.client.call("workspace.create", { request_id: `w-${title}`, repo: { path: clone }, title, engine: "caveman", options: { model, access }, task: { text: `ask ${title}` } });
  await until(async () => said(await transcript(on, w.session_id), "assistant").some((t) => t.includes(`(on ${on.name})`)), 120_000);
  let cloudId = "";
  await until(() => (cloudId = sql(`SELECT workspace_id FROM code_sessions WHERE id = '${w.session_id}'`)) !== "", 60_000);
  return { id: w.id, session: w.session_id, cloudId };
}
type Chat = Awaited<ReturnType<typeof chat>>;

/** The person says it in a chat on `on`: its agent mails `to` with thread_send through its code tool (scriptedModel). */
const sayMail = (on: AnyMac, from: Chat, to: Chat, text: string) =>
  on.client.call("turn.submit", { request_id: `mail-${randomUUID()}`, session_id: from.session, kind: "followup", input: { text: `MAIL mac:${to.cloudId} ${text}` } });

/** Answers the approvals a chat on `on` waits on, allowing them, until `done` holds. */
async function allowUntil(on: AnyMac, sessionId: string, done: () => Promise<boolean>, ms: number) {
  await until(async () => {
    for (const ask of openApprovals(await transcript(on, sessionId))) {
      const allow = (ask.payload as { options: Array<{ id: string; decision: string }> }).options.find((o) => o.decision === "allow")!;
      await on.client.call("ask.respond", { request_id: `allow-${ask.item_id}`, session_id: sessionId, ask_id: ask.item_id!, response: { kind: "approval", option_id: allow.id } }).catch(() => undefined);
    }
    return done();
  }, ms);
}

/** The first mail on channel mac to chat `to` whose body is `words` (Cloud keeps earlier runs' mail too). */
const mailTo = (to: Chat, words: string, and = "") =>
  `SELECT e.id FROM code_mail_envelopes e JOIN code_mail_bodies b ON b.envelope_id = e.id WHERE e.channel = 'mac' AND e.receiver_workspace_id = '${to.cloudId}' AND b.body = '${words}'${and} ORDER BY e.created_at`;
const mailRow = (to: Chat, words: string) => sql(`${mailTo(to, words)} LIMIT 1`);

/** A row Cloud could write straight into its mailbox from a genuine one: another body, another envelope, the next number. */
function forge(genuineId: string, change: { readonly body?: string; readonly mail?: AgentMail | Record<string, unknown> }) {
  const id = randomUUID();
  const seq = Number(sql(`SELECT max(recipient_seq) FROM code_mail_envelopes WHERE receiver_workspace_id = (SELECT receiver_workspace_id FROM code_mail_envelopes WHERE id = '${genuineId}')`)) + 1;
  const mailPatch = change.mail === undefined ? "" : ` || jsonb_build_object('mail', '${JSON.stringify(change.mail).replace(/'/g, "''")}'::jsonb)`;
  sql(`INSERT INTO code_mail_envelopes (id, organization_id, tree_id, request_id, verb, channel, authority, sender_workspace_id, receiver_workspace_id, wakes, payload, sender_user_id, receiver_computer_id, recipient_seq)
    SELECT '${id}', organization_id, tree_id, 'forged:${id}', verb, channel, authority, sender_workspace_id, receiver_workspace_id, wakes,
      jsonb_set(payload, '{recipient_seq}', '${seq}'::jsonb)${mailPatch}, sender_user_id, receiver_computer_id, ${seq}
    FROM code_mail_envelopes WHERE id = '${genuineId}';
    INSERT INTO code_mail_bodies (envelope_id, organization_id, body)
    SELECT '${id}', e.organization_id, ${change.body === undefined ? "b.body" : `'${change.body.replace(/'/g, "''")}'`} FROM code_mail_envelopes e JOIN code_mail_bodies b ON b.envelope_id = e.id WHERE e.id = '${genuineId}';`);
  return id;
}

/** Every file under `dir`, as bytes, for a search for key material. */
function filesUnder(dir: string): Array<{ file: string; bytes: Buffer }> {
  const out: Array<{ file: string; bytes: Buffer }> = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ file: full, bytes: fs.readFileSync(full) });
    }
  };
  walk(dir);
  return out;
}
/** The forms an agents key's private half could take on disk: its PEM body (whole and by line) and its JWK `d`. */
const secretsOf = (pem: string) => {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const d = (createPrivateKey(pem).export({ format: "jwk" }) as { d: string }).d;
  return [body, ...pem.split("\n").filter((line) => line.length > 40 && !line.startsWith("-----")), d, Buffer.from(d, "base64url").toString("hex")];
};

test.skipIf(!live)(
  "a chat's agent on one Mac asks a chat on another through the real Cloud with thread_send: once, in order, never forged, never above its modes, and not after a removal it slept through",
  async () => {
    const me = await person();
    const origin = await front();
    const repo = github(tempRoot("mac-mail-github-"));
    const keys = { a: agentsKeyFile(), b: agentsKeyFile(), c: agentsKeyFile() };
    const pem = { a: fs.readFileSync(keys.a, "utf8"), b: fs.readFileSync(keys.b, "utf8"), c: fs.readFileSync(keys.c, "utf8") };
    const modelA = await scriptedModel("Mac A");
    const a = await startDesktopMac("Mac A", origin, me.access_token, { agentsKey: pem.a, model: modelA.url, env: repo.env });
    // Mac A's key went on the bootstrap descriptor only: the file it came from goes now.
    fs.rmSync(keys.a);
    const env = (file: string) => ({ ...repo.env, MOVES_AGENTS_KEY_FILE: file });
    const [b, c] = [await startMac("Mac B", origin, me.access_token, env(keys.b)), await startMac("Mac C", origin, me.access_token, env(keys.c))];
    const macs: Array<AnyMac> = [a, b, c];
    // B trusts A only through C.
    await allowOnScreen(c, a.key);
    await allowOnScreen(b, c.key);
    await allowOnScreen(a as unknown as Mac, b.key);
    for (const on of macs) for (const other of macs) if (other !== on) await until(() => trusts(on as Mac, other.key), 60_000);
    for (const on of macs) expect(await vouch(on)).toEqual({ vouched: true });
    for (const on of macs) {
      const { agents } = await on.client.call("device.agents", {});
      await until(() => sql(`SELECT count(*) FROM code_device_statements WHERE body->>'kind' = 'agents' AND body->>'device_id' = '${agents!.device_id}' AND user_id = '${me.user.id}'`) === "1", 60_000);
    }

    const [asker, helper] = [await chat(a, repo.url, "Asker", "auto", a.model), await chat(b, repo.url, "Helper", "auto")];
    // Mode of a chat with access "auto" (session-protocol access.ts): auto-accept-edits.
    const AUTO = "auto-accept-edits";
    const computers = () => sql(`SELECT string_agg(id || '=' || computer_id, ',' ORDER BY id) FROM code_workspaces WHERE id IN ('${asker.cloudId}', '${helper.cloudId}')`);
    const computersBefore = computers();

    // 1. A's agent asks B's chat with thread_send from its code tool: B runs it as the helper's next turn, and the
    // answer comes back to the asker as its next turn.
    const startedAt = Date.now();
    await sayMail(a, asker, helper, "ask from Mac A: what is in your README?");
    await until(async () => said(await transcript(b, helper.session), "user").some((t) => t.includes("ask from Mac A")), 120_000);
    const turnStartedMs = Date.now() - startedAt;
    await until(async () => said(await transcript(b, helper.session), "assistant").some((t) => t.includes("ask from Mac A") && t.includes("(on Mac B)")), 120_000);
    await until(async () => said(await transcript(a, asker.session), "user").some((t) => t.includes("(on Mac B)")), 120_000);
    const wokenMs = Date.now() - startedAt;
    // B's chat names the asker as "<its title> on <the Mac>", the Mac by the name B knows it under (C allowed A's desktop
    // key as "Mac A"): never the name A's runtime gives itself, which on this one host is every lab Mac's.
    const heard = (await transcript(b, helper.session)).find((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text.includes("ask from Mac A"));
    expect((heard?.payload as { from?: { title: string } } | undefined)?.from?.title).toBe("Asker on Mac A");
    // It went from the engine's code tool, as thread_send, and its signed limits are the asking chat's own modes.
    expect(modelA.calls.some((call) => codeTool(call.tools) !== undefined && call.last.includes("MAIL mac:"))).toBe(true);
    expect(said(await transcript(a, asker.session), "assistant").some((t) => t.startsWith("sent (on Mac A)") && t.includes("queued"))).toBe(true);
    const askRow = mailRow(helper, "ask from Mac A: what is in your README?");
    const row = sql(`SELECT verb || '|' || channel || '|' || recipient_seq || '|' || (payload->>'session_id') || '|' || (payload->>'from_session_id') || '|' || (payload->'mail'->>'runtime_mode') FROM code_mail_envelopes WHERE id = '${askRow}'`);
    expect(row).toBe(`ask|mac|1|${helper.session}|${asker.session}|${AUTO}`);
    const askId = sql(`SELECT payload->'mail'->>'message_id' FROM code_mail_envelopes WHERE id = '${askRow}'`);
    expect(sql(`SELECT count(*) FROM code_mail_envelopes WHERE channel = 'mac' AND verb = 'answer' AND payload->'mail'->>'in_reply_to' = '${askId}'`)).toBe("1");
    results.ask = { b_turn_started_ms: turnStartedMs, a_woken_ms: wokenMs, load: load() };
    save();

    // 2. Cloud hands the same mail out again: B runs it once.
    const userTurns = said(await transcript(b, helper.session), "user").length;
    sql(`UPDATE code_mail_envelopes SET delivered_at = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = '${askRow}'`);
    await until(() => sql(`SELECT delivered_at IS NOT NULL FROM code_mail_envelopes WHERE id = '${askRow}'`) === "t", 90_000);
    expect(said(await transcript(b, helper.session), "user")).toHaveLength(userTurns);

    // 3. Rows Cloud writes itself: none runs, and the chat gets at most one note for them (one an hour), never their words.
    const genuine = JSON.parse(sql(`SELECT payload->'mail' FROM code_mail_envelopes WHERE id = '${askRow}'`)) as AgentMail;
    const signedBy = async (key: DeviceKey, patch: Partial<AgentMail>, body: string) => signAgentMail(key, { ...genuine, message_id: randomUUID(), ...patch }, body);
    const phone = await testDevice("iPhone, Safari");
    await allowOnScreen(b, phone);
    const rogue = await testDevice("Rogue agents");
    const notesBefore = noted(await transcript(b, helper.session)).length;
    const forged = [
      forge(askRow, { body: "rewritten by Cloud" }),
      forge(askRow, { mail: { ...genuine, runtime_mode: "full-access", message_id: randomUUID() } }),
      forge(askRow, { mail: { ...genuine, message_id: randomUUID(), signature: "" } }),
      forge(askRow, { body: "for another person", mail: await signedBy((await agentsKeyOf(pem.a))!, { user_id: randomUUID() }, "for another person") }),
      forge(askRow, { body: "signed by another key", mail: await signedBy(rogue, {}, "signed by another key") }),
      forge(askRow, { body: "signed by the phone", mail: await signedBy(phone, {}, "signed by the phone") }),
    ];
    await until(() => sql(`SELECT count(*) FROM code_mail_envelopes WHERE id IN ('${forged.join("','")}') AND delivered_at IS NOT NULL`) === String(forged.length), 120_000);
    const afterForgery = await transcript(b, helper.session);
    const forgeryNotes = noted(afterForgery).slice(notesBefore);
    expect(forgeryNotes.length).toBe(1);
    expect(forgeryNotes[0]).toMatch(/valid signature|vouched for/);
    for (const words of ["rewritten by Cloud", "signed by another key", "signed by the phone", "for another person"]) {
      expect(said(afterForgery, "user").some((t) => t.includes(words))).toBe(false);
      expect(forgeryNotes.some((n) => n.includes(words))).toBe(false);
    }
    expect(said(afterForgery, "user")).toHaveLength(userTurns);

    // 4. A chat that asks for approvals mails the helper, which runs with broader modes: refused, with a status back.
    // Its agent's code tool waits on the person's approval first, as any tool there does.
    const careful = await chat(a, repo.url, "Careful", "ask", a.model);
    await sayMail(a, careful, helper, "ask from the careful chat");
    await allowUntil(a, careful.session, async () => said(await transcript(a, careful.session), "user").some((t) => t.startsWith("[refused]")), 120_000);
    expect(said(await transcript(b, helper.session), "user").some((t) => t.includes("careful chat"))).toBe(false);
    const carefulAsk = sql(`SELECT payload->'mail'->>'message_id' FROM code_mail_envelopes WHERE id = (${mailTo(helper, "ask from the careful chat")} LIMIT 1)`);
    expect(sql(`SELECT payload->'mail'->>'runtime_mode' FROM code_mail_envelopes WHERE id = (${mailTo(helper, "ask from the careful chat")} LIMIT 1)`)).toBe("approval-required");
    // The status line is signed with the helper's own modes, never the careful chat's limits it refused.
    expect(sql(`SELECT payload->'mail'->>'runtime_mode' FROM code_mail_envelopes WHERE channel = 'mac' AND payload->'mail'->>'in_reply_to' = '${carefulAsk}'`)).toBe(AUTO);

    // 5. A pending approval on B stays pending: mail to that chat queues behind the turn that waits on it.
    const strict = await chat(b, repo.url, "Strict", "ask");
    await b.client.call("turn.submit", { request_id: "approve-strict", session_id: strict.session, kind: "followup", input: { text: "approve this first" } });
    await until(async () => openApprovals(await transcript(b, strict.session)).length === 1, 60_000);
    await sayMail(a, asker, strict, "ask the strict chat");
    await until(() => sql(`SELECT count(*) FROM (${mailTo(strict, "ask the strict chat", " AND e.delivered_at IS NOT NULL")}) d`) === "1", 120_000);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const waiting = await transcript(b, strict.session);
    expect(openApprovals(waiting)).toHaveLength(1);
    expect(said(waiting, "user").some((t) => t.includes("ask the strict chat"))).toBe(false);
    await allowUntil(b, strict.session, async () => said(await transcript(b, strict.session), "assistant").some((t) => t.includes("ask the strict chat")), 120_000);
    // Its answer goes back to the asker, which runs with broader modes than the strict chat: word that it is there, never
 // its words (upstream rule, once for the ask A's chat sent).
    await until(async () => said(await transcript(a, asker.session), "user").some((t) => t.includes("Strict") && t.includes("can't be delivered to a chat with broader permissions")), 120_000);
    expect(said(await transcript(a, asker.session), "user").some((t) => t.includes("ask the strict chat (on Mac B)"))).toBe(false);

    // Each mail once in Cloud, and numbered 1..n for each receiving chat (the rows written above took the next numbers).
    expect(sql(`SELECT count(*) FROM (SELECT payload->'mail'->>'message_id' FROM code_mail_envelopes WHERE channel = 'mac' AND request_id LIKE 'mac:%' GROUP BY 1 HAVING count(*) > 1) d`)).toBe("0");
    for (const to of [helper, strict]) {
      const seqs = sql(`SELECT string_agg(recipient_seq::text, ',' ORDER BY recipient_seq) FROM code_mail_envelopes WHERE channel = 'mac' AND receiver_workspace_id = '${to.cloudId}'`).split(",").map(Number);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    }
    // No chat moved for any of it.
    expect(computers()).toBe(computersBefore);

    // Mac C's own screen pulls a chat (Continue on This Mac, signed by C's desktop key), stopping its turn when asked.
    const pullTo = async (on: Mac, sessionId: string, request_id: string, stop: boolean) => {
      const to = { computer_id: on.computerId };
      return on.client.call("session.move", {
        request_id,
        session_id: sessionId,
        to,
        device: await signMove(on.key, { session_id: sessionId, request_id, to }),
        ...(stop ? { stop: await signStop(on.key, { session_id: sessionId, move_request_id: request_id }) } : {}),
      });
    };
    const ownerOf = (c: Chat) => sql(`SELECT computer_id FROM code_workspaces WHERE id = '${c.cloudId}'`);
    // Mac C has a checkout of the repository (a chat there), so a chat may land on it (T15).
    await chat(c, repo.url, "On C", "auto");

    // 8. A chat on B runs a mail from A, then the person's long turn; an ask from A queues behind it; Mac C pulls the
    // chat, stopping that turn. B lets it go at the boundary and settles the ask first, while Cloud still has the chat on
    // B: it leaves the queue, and A hears it did not run. The chat lands on C without it.
    const leaver = await chat(b, repo.url, "Leaves", "auto");
    await sayMail(a, asker, leaver, "ask the leaver answers on B");
    await until(async () => said(await transcript(b, leaver.session), "assistant").some((t) => t.includes("ask the leaver answers on B") && t.includes("(on Mac B)")), 120_000);
    await until(async () => (await b.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === leaver.session)?.status === "idle", 60_000);
    await b.client.call("turn.submit", { request_id: "leaver-hang", session_id: leaver.session, kind: "followup", input: { text: "hang the person's long work" } });
    await until(async () => (await b.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === leaver.session)?.status === "working", 60_000);
    await sayMail(a, asker, leaver, "ask before the pull");
    await until(async () => (await b.client.call("queue.list", { session_id: leaver.session })).turns.some((t) => t.text.includes("ask before the pull")), 120_000);
    const pulledAt = Date.now();
    await pullTo(c, leaver.session, `pull-leaver-${randomUUID()}`, true);
    await until(async () => said(await transcript(a, asker.session), "user").some((t) => t.startsWith("[not run]") && t.includes("was moving to another computer")), 120_000);
    const toldMs = Date.now() - pulledAt;
    await until(() => ownerOf(leaver) === c.computerId, 120_000);
    const leftAsk = sql(`SELECT payload->'mail'->>'message_id' FROM code_mail_envelopes WHERE id = (${mailTo(leaver, "ask before the pull")} LIMIT 1)`);
    expect(sql(`SELECT count(*) FROM code_mail_envelopes WHERE channel = 'mac' AND verb = 'answer' AND payload->'mail'->>'in_reply_to' = '${leftAsk}'`)).toBe("1");
    expect(said(await transcript(c, leaver.session), "user").some((t) => t.includes("ask before the pull"))).toBe(false);
    results.leftBehind = { told_after_pull_ms: toldMs, load: load() };
    save();

    // 8b. Cloud hands both mails out again, now to Mac C where the chat is (a lease B let lapse, or a carrier replaying
    // them): the chat's copy said B ran the one and acted on the other, so C runs neither, and no second answer goes.
    const ranRow = mailRow(leaver, "ask the leaver answers on B");
    const leftRow = mailRow(leaver, "ask before the pull");
    const ranOnC = () => transcript(c, leaver.session).then((events) => said(events, "user").filter((t) => t.includes("ask the leaver answers on B")).length);
    const ranBefore = await ranOnC();
    const turnsOnC = async () => (await transcript(c, leaver.session)).filter((e) => e.type === "turn.started").length;
    const turnsBefore = await turnsOnC();
    sql(`UPDATE code_mail_envelopes SET delivered_at = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id IN ('${ranRow}', '${leftRow}')`);
    await until(() => sql(`SELECT count(*) FROM code_mail_envelopes WHERE id IN ('${ranRow}', '${leftRow}') AND delivered_at IS NOT NULL`) === "2", 120_000);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await ranOnC()).toBe(ranBefore);
    expect(await turnsOnC()).toBe(turnsBefore);
    expect(said(await transcript(c, leaver.session), "user").some((t) => t.includes("ask before the pull"))).toBe(false);
    expect(sql(`SELECT count(*) FROM code_mail_envelopes WHERE channel = 'mac' AND verb = 'answer' AND payload->'mail'->>'in_reply_to' = '${leftAsk}'`)).toBe("1");
    results.replayedAfterPull = { ran_on_c: 0, load: load() };
    save();

    // 9. A chat on A asks a chat on B, which works on it; Mac C pulls the asking chat from A meanwhile. The answer (its
    // turn stopped on B) goes to the chat where it is now: C takes it as the answer to the ask its copy carried. The
 // asking chat runs with broader modes than B's, so it arrives as word that it is there (upstream rule), never refused.
    const traveller = await chat(a, repo.url, "Traveller", "auto", a.model);
    const strictTwo = await chat(b, repo.url, "Strict two", "ask");
    await sayMail(a, traveller, strictTwo, "hang work on this for the traveller");
    await until(async () => (await b.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === strictTwo.session)?.status === "working", 120_000);
    await until(async () => said(await transcript(a, traveller.session), "assistant").some((t) => t.startsWith("sent (on Mac A)")), 60_000);
    await pullTo(c, traveller.session, `pull-traveller-${randomUUID()}`, false);
    await until(() => ownerOf(traveller) === c.computerId, 120_000);
    await until(async () => (await c.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === traveller.session)?.status === "idle", 120_000);
    await b.client.call("turn.interrupt", { request_id: `stop-strict-two-${randomUUID()}`, session_id: strictTwo.session });
    await until(async () => said(await transcript(c, traveller.session), "user").some((t) => t.includes("Strict two") && t.includes("can't be delivered to a chat with broader permissions")), 120_000);
    expect(noted(await transcript(c, traveller.session)).some((n) => n.includes("broader permissions than the chat that sent it"))).toBe(false);
    results.answerFollowed = { load: load() };
    save();

    // 6. Mac B sleeps; Mac A mails it, and Mac C removes Mac A meanwhile. B wakes: the mail waits for a fresh read of
    // the log, which says A is removed (B trusted A only through C), and is refused then. And an ask A sent before, queued
    // on B behind the person's long turn, never runs either: it leaves B's queue once B read the removal, before that
    // turn ends, and A hears only that it was removed (A-4).
    await b.client.call("turn.submit", { request_id: "helper-hang", session_id: helper.session, kind: "followup", input: { text: "hang the person's long work on the helper" } });
    await until(async () => (await b.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === helper.session)?.status === "working", 60_000);
    await sayMail(a, asker, helper, "ask queued before the removal");
    await until(async () => (await b.client.call("queue.list", { session_id: helper.session })).turns.some((t) => t.text.includes("ask queued before the removal")), 120_000);
    const queuedAsk = sql(`SELECT payload->'mail'->>'message_id' FROM code_mail_envelopes WHERE id = (${mailTo(helper, "ask queued before the removal")} LIMIT 1)`);
    b.child.kill("SIGSTOP");
    const sleptAt = Date.now();
    await sayMail(a, asker, helper, "ask after the removal");
    await until(() => sql(`SELECT count(*) FROM (${mailTo(helper, "ask after the removal")}) d`) === "1", 120_000);
    await removeOnScreen(c, a.key);
    await until(() => sql(`SELECT count(*) FROM code_device_statements WHERE body->>'kind' = 'remove' AND body->>'device_id' = '${a.key.device_id}' AND user_id = '${me.user.id}'`) !== "0", 60_000);
    // Asleep past a read's freshness (35 s), as a lid closed for a while.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 45_000 - (Date.now() - sleptAt))));
    const removedRow = mailRow(helper, "ask after the removal");
    expect(sql(`SELECT delivered_at IS NULL FROM code_mail_envelopes WHERE id = '${removedRow}'`)).toBe("t");
    b.child.kill("SIGCONT");
    const wokeAt = Date.now();
    // Refused once B read the log afresh (the helper's note for refused mail was given this hour, so this one is only
    // logged): taken off Cloud's hands, and never run.
    await until(() => sql(`SELECT delivered_at IS NOT NULL FROM code_mail_envelopes WHERE id = '${removedRow}'`) === "t", 120_000);
    const refusedMs = Date.now() - wokeAt;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(said(await transcript(b, helper.session), "user").some((t) => t.includes("after the removal"))).toBe(false);
    expect(await trusts(b, a.key)).toBe(false);
    // The ask A queued before: out of B's queue while the person's turn still runs, and A told it was removed.
    await until(async () => !(await b.client.call("queue.list", { session_id: helper.session })).turns.some((t) => t.text.includes("ask queued before the removal")), 60_000);
    const droppedMs = Date.now() - wokeAt;
    expect((await b.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === helper.session)?.status).toBe("working");
    await until(() => sql(`SELECT count(*) FROM code_mail_envelopes WHERE channel = 'mac' AND verb = 'answer' AND payload->'mail'->>'in_reply_to' = '${queuedAsk}'`) === "1", 120_000);
    const toldAsker = mailRow(asker, "[not run] The Mac that sent this was removed from your Macs, so this mail did not run.");
    expect(toldAsker).not.toBe("");
    await b.client.call("turn.interrupt", { request_id: `stop-helper-hang-${randomUUID()}`, session_id: helper.session });
    await until(async () => (await b.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === helper.session)?.status === "idle", 60_000);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(said(await transcript(b, helper.session), "user").some((t) => t.includes("ask queued before the removal"))).toBe(false);
    results.removal = { asleep_ms: wokeAt - sleptAt, refused_after_wake_ms: refusedMs, queued_dropped_after_wake_ms: droppedMs, load: load() };

    // 6b. Cloud writes a vouch the removed Mac A signed (its desktop key, still able to sign) for an agents key of its
    // own into the person's log, and mail that key signs into the mailbox for a chat on B that never refused mail
    // before: B reads the vouch (a key it does not know) and counts it for nothing, since its signer is removed. The mail
    // runs nowhere, and the chat says why, without its words.
    const ghost = await testDevice("Ghost agents");
    const ghostVouch = await signStatement(a.key, { kind: "agents", organization_id: me.user.organization_id, user_id: me.user.id, device_id: ghost.device_id, public_key: ghost.public_key, name: "Mac A" });
    sql(`INSERT INTO code_device_statements (organization_id, user_id, id, body, from_runtime_id) VALUES ('${me.user.organization_id}', '${me.user.id}', '${createHash("sha256").update(randomUUID()).digest("base64url")}', $j$${JSON.stringify(ghostVouch)}$j$::jsonb, '${randomUUID()}')`);
    const strictRow = mailRow(strict, "ask the strict chat");
    const strictMail = JSON.parse(sql(`SELECT payload->'mail' FROM code_mail_envelopes WHERE id = '${strictRow}'`)) as AgentMail;
    const ghostWords = "words under the ghost key";
    const ghostRow = forge(strictRow, { body: ghostWords, mail: await signAgentMail(ghost, { ...strictMail, message_id: randomUUID() }, ghostWords) });
    await until(() => sql(`SELECT delivered_at IS NOT NULL FROM code_mail_envelopes WHERE id = '${ghostRow}'`) === "t", 120_000);
    const strictAfter = await transcript(b, strict.session);
    expect(said(strictAfter, "user").some((t) => t.includes(ghostWords))).toBe(false);
    const ghostNotes = noted(strictAfter).filter((n) => /none of your Macs this Mac trusts vouched for/.test(n));
    expect(ghostNotes).toHaveLength(1);
    expect(ghostNotes[0]).not.toContain(ghostWords);
    results.removedMacVouch = { ran: false, note: JSON.parse(ghostNotes[0]!) as unknown };

    // 7. No agents key on disk in the clear, in any Mac's state (Mac A's whole home and runtime log included).
    for (const [name, key, dir] of [["Mac A", pem.a, path.dirname(a.log)], ["Mac B", pem.b, b.stateDir], ["Mac C", pem.c, c.stateDir]] as const) {
      const secrets = secretsOf(key);
      for (const { file, bytes } of filesUnder(dir)) for (const secret of secrets) expect(bytes.includes(secret), `${name}: ${file}`).toBe(false);
    }
    results.done = { load: load() };
    save();
    console.log(
      `mac mail (real local Cloud, lab-only, ${load()}): Mac B's turn started ${turnStartedMs} ms after Mac A's agent sent it; the answer woke Mac A at ${wokenMs} ms; after a ${wokeAt - sleptAt} ms sleep B refused the removed Mac's mail ${refusedMs} ms after waking`,
    );
  },
  900_000,
);

test.skipIf(!live)(
  "an ask running in a chat the lid hands to a Cloud computer mid-turn: its asker hears the turn carries on there, never the stop's words, and the computer carries it on (F-5)",
  async () => {
    const me = await person();
    const origin = await front();
    const root = tempRoot("mac-mail-lid-");
    const repo = github(root);
    const keys = { a: agentsKeyFile(), b: agentsKeyFile() };
    const modelA = await scriptedModel("Mac A");
    const a = await startDesktopMac("Mac A", origin, me.access_token, { agentsKey: fs.readFileSync(keys.a, "utf8"), model: modelA.url, env: repo.env });
    fs.rmSync(keys.a);
    const b = await startMac("Mac B", origin, me.access_token, { ...repo.env, MOVES_AGENTS_KEY_FILE: keys.b });
    await allowOnScreen(b, a.key);
    await allowOnScreen(a as unknown as Mac, b.key);
    for (const [on, other] of [[a, b], [b, a]] as const) await until(() => trusts(on as Mac, other.key), 60_000);
    for (const on of [a, b]) expect(await vouch(on)).toEqual({ vouched: true });
    const [asker, helper] = [await chat(a, repo.url, "Asker", "auto", a.model), await chat(b, repo.url, "Helper", "auto")];
    // One of the person's Cloud computers, with its own checkout: where the lid hands Mac B's chat.
    const boxCheckout = path.join(root, "box-one");
    execFileSync("git", ["clone", "-q", repo.url, boxCheckout]);
    const box = await startBox("Box one", origin, me, boxCheckout, repo.env);
    await b.client.call("settings.set", { request_id: `moves-on-${randomUUID()}`, settings: { move_to_cloud: true } });

    // A's agent asks B's chat; on Mac B its turn runs until it is stopped ("hang").
    await sayMail(a, asker, helper, "hang the migration of the 7 tables");
    await until(async () => said(await transcript(b, helper.session), "user").some((t) => t.includes("hang the migration")), 120_000);
    await until(async () => (await b.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === helper.session)?.status === "working", 60_000);
    const askId = sql(`SELECT payload->'mail'->>'message_id' FROM code_mail_envelopes WHERE id = (${mailTo(helper, "hang the migration of the 7 tables")} LIMIT 1)`);
    // Mac B's lid hands the chat to the Cloud computer mid-turn (the lid's own move, from B's own client).
    const movedAt = Date.now();
    await b.client.call("session.move", { request_id: `lid-${randomUUID()}`, session_id: helper.session, to: { computer_id: box.computerId }, reason: "lid" });
    await until(() => sql(`SELECT computer_id FROM code_workspaces WHERE id = '${helper.cloudId}'`) === box.computerId, 120_000);
    // A hears, once, that the turn carries on where the chat continues and no answer comes back from there: never the
    // stop's words as the answer, which would have it ask again and run the work twice.
    const answers = () => sql(`SELECT count(*) FROM code_mail_envelopes WHERE channel = 'mac' AND verb = 'answer' AND payload->'mail'->>'in_reply_to' = '${askId}'`);
    await until(() => answers() === "1", 120_000);
    const answeredMs = Date.now() - movedAt;
    const body = sql(`SELECT b.body FROM code_mail_envelopes e JOIN code_mail_bodies b ON b.envelope_id = e.id WHERE e.channel = 'mac' AND e.verb = 'answer' AND e.payload->'mail'->>'in_reply_to' = '${askId}'`);
    expect(body).toMatch(/^\[no answer\] That chat's Mac closed its lid in the middle of this mail's turn/);
    await until(async () => said(await transcript(a, asker.session), "user").some((t) => t.startsWith("[no answer] That chat's Mac closed its lid")), 120_000);
    expect(said(await transcript(a, asker.session), "user").some((t) => t.startsWith("[interrupted]"))).toBe(false);
    // The Cloud computer carried the turn on (told what ran and who asked), as the line says.
    await until(async () => said(await transcript(box as unknown as AnyMac, helper.session), "assistant").some((t) => t.includes("hang the migration") && t.includes("(on Box one)")), 120_000);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(answers()).toBe("1");
    results.lidCarried = { answered_after_move_ms: answeredMs, answer: body, load: load() };
    save();
    console.log(`mac mail (real local Cloud, lab-only, ${load()}): an ask running on Mac B as its lid handed the chat on was answered "carries on" ${answeredMs} ms after the move`);
  },
  900_000,
);
