import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cavemanRunCarries, readCavemanRun, writeCavemanRun } from "@caveman-app/provider-caveman/server";
import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { gzipSync } from "node:zlib";

import { PROTOCOL_REVISION } from "@caveman-app/session-protocol";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import { decodeSegment, encodeSegment, NewerCopyError, type SegmentHead } from "./copySegments.ts";
import { carriedReceipts, checkMove, decodeBundle, encodeBundle, journalKnown, mergeBundles, movedFromAfter, packJournal, placeRefs, SIGNED_MOVE, unpackJournal, type MoveBundle } from "./moves.ts";

const event = (cursor: number, type = "turn.done"): SessionEvent => ({ session_id: "s", cursor, at: "2026-10-18T00:00:00.000Z", type, payload: { status: "completed" } }) as SessionEvent;
const segment = (after: number, cursors: Array<number>, extra: Partial<MoveBundle> = {}): MoveBundle =>
  ({
    v: 1,
    runtime_id: "r",
    after,
    repo: "acme/web",
    record: { workspace: { id: "w" }, session: { id: "s", head: cursors.at(-1) ?? after }, internal: { threadId: "caveman:w" } },
    events: cursors.map((c) => event(c)),
    display: [],
    engine: { native_thread_id: "cvm-1", head_run_id: `run-${after}`, journal: [], model: "{}", runtime_mode: "full-access", interaction_mode: "default" },
    wip: null,
    ...extra,
  }) as unknown as MoveBundle;

test("segments merge into one copy: every event once in cursor order, the latest of the rest, the last engine that journaled", () => {
  const merged = mergeBundles([segment(0, [1, 2]), segment(2, [3]), segment(2, [3], { pending: "ask two" }), segment(3, [], { engine: null })]);
  expect(merged.events.map((e) => e.cursor)).toEqual([1, 2, 3]);
  expect(merged.pending).toBeUndefined();
  expect(merged.engine?.head_run_id).toBe("run-2");
  expect(merged.after).toBe(0);
  expect(() => mergeBundles([segment(0, [1]), segment(2, [3])])).toThrow("missing event 2");
  expect(() => mergeBundles([])).toThrow();
});

test("the copy says which cursor its work in progress was taken at: the last segment that carried it, a boundary or a running turn's that says so (decision 25)", () => {
  const at = (after: number, cursors: Array<number>, boundary: boolean, extra: Partial<MoveBundle> = {}) => ({ ...segment(after, cursors, { wip: "w1", ...extra }), through: cursors.at(-1) ?? after, boundary }) as MoveBundle;
  // A boundary at 2, then a turn copied mid-way (3..5, the Mac gone before its end) carrying none: the checkout is cursor 2's.
  expect(mergeBundles([at(0, [1, 2], true), at(2, [3, 4], false), at(4, [5], false)]).wip_at).toBe(2);
  // The running turn's copy at 4 carried its work in progress: the checkout is cursor 4's, whatever came after.
  const mid = mergeBundles([at(0, [1, 2], true), at(2, [3, 4], false, { wip: "w2", wip_bundle: "b2", wip_at: 4 } as Partial<MoveBundle>), at(4, [5], false, { wip: "w2" })]);
  expect(mid.wip_at).toBe(4);
  expect(mid.wip).toBe("w2");
  expect(mid.wip_bundles).toEqual(["b2"]);
  // The next boundary takes it over.
  expect(mergeBundles([at(0, [1, 2], false, { wip_at: 2 } as Partial<MoveBundle>), at(2, [3], true)]).wip_at).toBe(3);
  // A move's final copy is a boundary: the work in progress is the turn's own.
  expect(mergeBundles([at(0, [1, 2], true), at(2, [3, 4], false), at(4, [5], true)]).wip_at).toBe(5);
  // Segments from before they said (v1): not known.
  expect(mergeBundles([segment(0, [1, 2])]).wip_at).toBeUndefined();
});

test("a copy whose last boundary went without its work in progress says so; a later boundary that carried it clears it (F-5)", () => {
  const at = (after: number, cursors: Array<number>, boundary: boolean, extra: Partial<MoveBundle> = {}) => ({ ...segment(after, cursors, { wip: "w1", ...extra }), through: cursors.at(-1) ?? after, boundary }) as MoveBundle;
  const dropped = { wip_dropped: true } as Partial<MoveBundle>;
  expect(mergeBundles([at(0, [1, 2], true), at(2, [3], true, dropped)]).wip_dropped).toBe(true);
  // Mid-turn segments after it name the same older work in progress: still dropped.
  expect(mergeBundles([at(0, [1, 2], true), at(2, [3], true, dropped), at(3, [4], false)]).wip_dropped).toBe(true);
  expect(mergeBundles([at(0, [1, 2], true, dropped), at(2, [3], true, { wip: "w2" })]).wip_dropped).toBeUndefined();
  expect(mergeBundles([at(0, [1, 2], true)]).wip_dropped).toBeUndefined();
});

test("work in progress a segment named by ref goes back in its place among the bundles, once fetched (AC-08)", () => {
  const at = (after: number, cursors: Array<number>, extra: Partial<MoveBundle>) => ({ ...segment(after, cursors, { wip: "w", ...extra }), through: cursors.at(-1) ?? after, boundary: true }) as MoveBundle;
  const ref = (n: number) => ({ sha256: `${n}`.repeat(64), bytes: 9 << 20, chunks: [`${n}`.repeat(64)] });
  const merged = mergeBundles([at(0, [1], { wip_bundle: "b1" }), at(1, [2], { wip_ref: ref(2) }), at(2, [3], { wip_bundle: "b3" }), at(3, [4], { wip_ref: ref(4) })]);
  expect(merged.wip_bundles).toEqual(["b1", "b3"]);
  expect(merged.wip_refs).toEqual([
    { at: 1, ref: ref(2) },
    { at: 3, ref: ref(4) },
  ]);
  expect("wip_ref" in merged).toBe(false);
  const placed = placeRefs(merged, [Buffer.from("f2"), Buffer.from("f4")]);
  expect(placed.wip_bundles).toEqual(["b1", Buffer.from("f2"), "b3", Buffer.from("f4")]);
  expect(placed.wip_refs).toBeUndefined();
  // A copy with none is as it was.
  const plain = mergeBundles([at(0, [1], { wip_bundle: "b1" })]);
  expect(plain.wip_refs).toBeUndefined();
  expect(placeRefs(plain, [])).toBe(plain);
});

test("a segment round-trips through its gzip encoding", () => {
  const bundle = segment(0, [1, 2], { pending: "hang four", display: [{ message_id: "m", text: "typed" }] });
  const body = encodeBundle(bundle);
  expect(body[0]).toBe(0x1f);
  expect(decodeBundle(body)).toEqual(bundle);
});

test("a segment says which runtime wrote it, and one from before runtimes said still reads", () => {
  const head = { runtime_id: "r", repo: "acme/web", record: segment(0, []).record, epoch: 1 } as SegmentHead;
  const written = decodeSegment(encodeSegment(head, [event(1)], [], { from: 1, through: 1, boundary: true }));
  expect(written).toMatchObject({ v: 2, revision: PROTOCOL_REVISION, runtime_version: RUNTIME_VERSION });
  expect(written.events.map((e) => e.cursor)).toEqual([1]);
  // v1, and v2 from before the revision: revision 0.
  expect(decodeBundle(encodeBundle(segment(0, [1]))).events).toHaveLength(1);
  expect(decodeSegment(gzipSync(JSON.stringify({ v: 2, events: [], display: [] }))).events).toEqual([]);
});

test("a segment a newer runtime wrote is refused in words naming both builds: a newer revision or an unknown format", () => {
  const body = (extra: Record<string, unknown>) => gzipSync(JSON.stringify({ v: 2, runtime_id: "r", events: [], display: [], ...extra }));
  const newer = () => decodeSegment(body({ revision: PROTOCOL_REVISION + 1, runtime_version: "9.9.0-nightly.20261201.1" }));
  expect(newer).toThrow(NewerCopyError);
  expect(newer).toThrow(
    `Caveman Code ${RUNTIME_VERSION} can't read this chat's copy, which Caveman Code 9.9.0-nightly.20261201.1 made (copy format 2, protocol revision ${PROTOCOL_REVISION + 1}; it reads formats 1 and 2 up to revision ${PROTOCOL_REVISION}), so it needs updating before it takes the chat`,
  );
  // A format this runtime has never seen, from a writer that did not say which it was.
  expect(() => decodeSegment(body({ v: 3 }))).toThrow(/which a newer Caveman Code made \(copy format 3, protocol revision 0;/);
  expect(() => decodeSegment(body({ v: undefined }))).toThrow(NewerCopyError);
});

// The head run's journal as the Caveman engine writes it: run_started and run_completed carry the whole conversation.
const msg = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });
const run = (id: string, before: Array<unknown>, after: Array<unknown>) => [
  JSON.stringify({ type: "run_started", runId: id, conversation: { sessionId: "c", messagesSha256: `sha-${before.length}`, messages: before } }),
  JSON.stringify({ type: "tool_intent", runId: id, name: "read" }),
  JSON.stringify({ type: "run_completed", runId: id, conversation: { sessionId: "c", messagesSha256: `sha-${after.length}`, messages: after } }),
];

test("segments carry only what the conversation adds, and merge back to the head run's journal as written", () => {
  const u1 = msg("user", "ask one");
  const a1 = msg("assistant", "heard one");
  const u2 = msg("user", "ask two");
  const a2 = msg("assistant", "heard two");
  const first = run("run-1", [u1], [u1, a1]);
  const second = run("run-2", [u1, a1, u2], [u1, a1, u2, a2]);
  const one = packJournal(first, []);
  const two = packJournal(second, one.known);
  // Nothing already sent goes again: each checkpoint names how many it keeps and adds the rest.
  const tails = two.journal.flatMap((line) => {
    const c = (JSON.parse(line) as { conversation?: { messages_from: number; messages_tail: Array<unknown>; messages?: unknown } }).conversation;
    return c ? [[c.messages_from, c.messages_tail.length, c.messages === undefined]] : [];
  });
  expect(tails).toEqual([
    [2, 1, true],
    [3, 1, true],
  ]);
  const engine = (journal: ReadonlyArray<string>, head: string) => ({ native_thread_id: "cvm-1", head_run_id: head, journal, model: "{}", runtime_mode: "full-access", interaction_mode: "default" });
  const merged = mergeBundles([
    segment(0, [1], { engine: engine(one.journal, "run-1"), wip_bundle: "b0" }),
    segment(1, [2], { engine: null }),
    segment(2, [3], { engine: engine(two.journal, "run-2"), wip_bundle: "b2" }),
  ]);
  expect(merged.engine?.head_run_id).toBe("run-2");
  expect(merged.engine?.journal.map((line) => JSON.parse(line))).toEqual(second.map((line) => JSON.parse(line)));
  expect(journalKnown(merged.engine!.journal)).toEqual(two.known);
  // Every work-in-progress bundle, in segment order (each builds on the one before).
  expect(merged.wip_bundles).toEqual(["b0", "b2"]);
  expect("wip_bundle" in merged).toBe(false);
});

test("a harness checkpoint travels as one line: a later copy sends only the messages it adds, and both unpack to the line the journal wrote", async () => {
  // As readCavemanRun gives a harness run's head: one line, its conversation the checkpoint file with its digest.
  const checkpoint = (runId: string, messages: Array<unknown>) =>
    JSON.stringify({
      type: "harness_checkpoint",
      conversation: { format: "caveman-harness/1", runId, model: "anthropic/claude-haiku-4-5", loadout: "app-claude", messages, messagesSha256: createHash("sha256").update(JSON.stringify(messages)).digest("hex") },
    });
  const u1 = msg("user", "<env>\ncwd: /w\n</env>\n\nask one");
  const a1 = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } }] };
  const r1 = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "hello" }], isError: false };
  const u2 = msg("user", "ask two");
  const a2 = msg("assistant", "heard two");
  const first = [checkpoint("cvm-1-aaaa", [u1, a1, r1])];
  const second = [checkpoint("cvm-1-bbbb", [u1, a1, r1, u2, a2])];
  const one = packJournal(first, []);
  const two = packJournal(second, one.known);
  const packed = (journal: ReadonlyArray<string>) => (JSON.parse(journal[0]!) as { conversation: { messages_from: number; messages_tail: Array<unknown>; messages?: unknown; messagesSha256: string } }).conversation;
  // The first copy sends the whole conversation; the second only what it adds, with the digest of the whole.
  expect([packed(one.journal).messages_from, packed(one.journal).messages_tail.length, packed(one.journal).messages]).toEqual([0, 3, undefined]);
  expect([packed(two.journal).messages_from, packed(two.journal).messages_tail]).toEqual([3, [u2, a2]]);
  expect(packed(two.journal).messagesSha256).toBe((JSON.parse(second[0]!) as { conversation: { messagesSha256: string } }).conversation.messagesSha256);
  expect(two.journal[0]!.length).toBeLessThan(second[0]!.length);

  const engine = (journal: ReadonlyArray<string>, head: string) => ({ native_thread_id: "cvm-1", head_run_id: head, journal, model: "{}", runtime_mode: "full-access", interaction_mode: "default" });
  const merged = mergeBundles([
    segment(0, [1], { engine: engine(one.journal, "cvm-1-aaaa") }),
    segment(1, [2], { engine: engine(two.journal, "cvm-1-bbbb") }),
  ]);
  expect(merged.engine?.head_run_id).toBe("cvm-1-bbbb");
  expect(merged.engine?.journal.map((line) => JSON.parse(line))).toEqual(second.map((line) => JSON.parse(line)));
  expect(unpackJournal(one.journal, []).journal.map((line) => JSON.parse(line))).toEqual(first.map((line) => JSON.parse(line)));
  expect(journalKnown(merged.engine!.journal)).toEqual(two.known);

  // Where it lands, the line writes the checkpoint whole (its digest checked again) and reads back as the same run.
  const stateDir = mkdtempSync(join(tmpdir(), "moves-harness-"));
  try {
    expect(cavemanRunCarries(merged.engine!.journal)).toBe(true);
    await writeCavemanRun(stateDir, "cvm-1-bbbb", merged.engine!.journal);
    expect((await readCavemanRun(stateDir, "cvm-1-bbbb")).map((line) => JSON.parse(line))).toEqual(second.map((line) => JSON.parse(line)));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a conversation rewritten from the start (compaction) goes whole; a copy missing its start is refused", () => {
  const known = packJournal(run("run-1", [msg("user", "a")], [msg("user", "a"), msg("assistant", "b")]), []).known;
  const compacted = packJournal(run("run-2", [msg("user", "summary")], [msg("user", "summary"), msg("assistant", "c")]), known);
  expect((JSON.parse(compacted.journal[0]!) as { conversation: { messages_from: number } }).conversation.messages_from).toBe(0);
  const later = packJournal(run("run-3", [msg("user", "x"), msg("user", "y")], [msg("user", "x"), msg("user", "y")]), packJournal(run("run-2", [msg("user", "x")], [msg("user", "x")]), []).known);
  expect(() => unpackJournal(later.journal, [])).toThrow("missing part");
});

test("a Claude Agent chat's session file merges across segments; an engine switch starts it over", () => {
  const native = (from: number, lines: Array<string>, id = "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c") => ({ kind: "claude" as const, id, head: lines.at(-1) ?? null, cwd: "/w", files: [{ path: `${id}.jsonl`, from, lines }] });
  const engine = (n: ReturnType<typeof native> | undefined) =>
    ({ engine: { native_thread_id: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c", head_run_id: null, journal: [], model: "{}", runtime_mode: "full-access", interaction_mode: "default", ...(n ? { native: n } : {}) } }) as Partial<MoveBundle>;
  const merged = mergeBundles([segment(0, [1], engine(native(0, ["a", "b"]))), segment(1, [2], { engine: null }), segment(2, [3], engine(native(2, ["c"])))]);
  expect(merged.engine?.native?.files).toEqual([{ path: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c.jsonl", from: 0, lines: ["a", "b", "c"] }]);
  expect(merged.engine?.native?.head).toBe("c");
  // A segment past a gap in the file: the copy still merges, without the file, marked so the chat hands over (K8).
  const gap = mergeBundles([segment(0, [1], engine(native(0, ["a"]))), segment(1, [2], engine(native(3, ["d"])))]);
  expect(gap.events.map((e) => e.cursor)).toEqual([1, 2]);
  expect(gap.engine?.native).toBeUndefined();
  expect(gap.engine?.native_incomplete).toBe(true);
  // Mac, Cloud, Mac, Cloud with a session handed over mid-chain: each computer's first part goes whole, crossed deltas
  // of the old session included, and the last session's file comes out whole.
  const second = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const chain = mergeBundles([
    segment(0, [1], engine(native(0, ["a", "b"]))),
    segment(1, [2], engine(native(5, ["stale"]))),
    segment(2, [3], { engine: { ...engine(native(0, ["x"], second)).engine!, native_thread_id: second } }),
    segment(3, [4], { engine: { ...engine(native(1, ["y"], second)).engine!, native_thread_id: second } }),
  ]);
  expect(chain.engine?.native?.files).toEqual([{ path: `${second}.jsonl`, from: 0, lines: ["x", "y"] }]);
  // Back on the Caveman engine: no native session travels.
  expect(mergeBundles([segment(0, [1], engine(native(0, ["a"])))]).engine?.native).toBeDefined();
  expect(mergeBundles([segment(0, [1])]).engine?.native).toBeUndefined();
});

test("a session file that stopped travelling leaves no stale part behind", () => {
  const id = "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
  const engine = (extra: object) => ({ engine: { native_thread_id: id, head_run_id: null, journal: [], model: "{}", runtime_mode: "full-access", interaction_mode: "default", ...extra } }) as Partial<MoveBundle>;
  const merged = mergeBundles([segment(0, [1], engine({ native: { kind: "claude", id, head: "a", cwd: "/w", files: [{ path: `${id}.jsonl`, from: 0, lines: ["a"] }] } })), segment(1, [2], engine({ native_dropped: true }))]);
  expect(merged.engine?.native).toBeUndefined();
  expect(merged.engine).not.toHaveProperty("native_dropped");
});

test("a look at where a chat could go is never an offer; a Cloud without the no-offer ask is passed over, a move's offer is not", async () => {
  const sent: Array<Record<string, unknown>> = [];
  // As Cloud decodes move-check (DisallowUnknownFields): a Cloud from before `offer` refuses the field outright.
  const cloud = (knowsOffer: boolean) =>
    (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if ("offer" in body && !knowsOffer) return new Response(JSON.stringify({ error: { code: "cave_bad_request", message: "Invalid JSON." } }), { status: 400 });
      return new Response(JSON.stringify(body.offer === false ? { login: "vault_key" } : { login: "vault_key", move_id: "m1", computer_id: "box" }), { status: 200 });
    }) as unknown as typeof fetch;
  const identity = { cloudUrl: "https://cloud.test", runtimeId: "r1" } as never;
  const state = { cloudUrl: "https://cloud.test", token: "t" };
  expect(await checkMove(identity, state, "s1", "cloud", { reason: "user", offer: false }, cloud(true))).toEqual({ login: "vault_key" });
  expect(sent.at(-1)).toEqual({ to: "cloud", reason: "user", offer: false });
  expect(await checkMove(identity, state, "s1", "cloud", { reason: "user", offer: false }, cloud(false))).toBeUndefined();
  // A move about to happen is offered: no `offer` field, and a refusal is the move's.
  expect(await checkMove(identity, state, "s1", "cloud", { reason: "lid" }, cloud(false))).toEqual({ login: "vault_key", move_id: "m1", computer_id: "box" });
  expect(sent.at(-1)).toEqual({ to: "cloud", reason: "lid" });
  const refusing = (async () => new Response(JSON.stringify({ error: { code: "cave_bad_request", message: "Invalid JSON." } }), { status: 400 })) as unknown as typeof fetch;
  await expect(checkMove(identity, state, "s1", "cloud", { reason: "lid" }, refusing)).rejects.toThrow();
});

test("a copy's receipts are answered again where it lands while in date, never a signed move's (that Mac's own record)", () => {
  const receipt = (method: string, request_id: string, expires_at: number) => ({ principal: "device-a", method, request_id, params_hash: "", result: null, expires_at });
  const now = 1_000_000;
  const carried = [receipt("turn.submit", "r1", now + 60_000), receipt("turn.submit", "r2", now), receipt(SIGNED_MOVE, "m-to-b", now + 1_000), receipt(SIGNED_MOVE, "m-old", now - 1)];
  // A copy from Cloud that names a move this Mac spent, to expire in 1 s: never put over the 23 h receipt this Mac keeps.
  expect(carriedReceipts(carried, now).map((r) => [r.method, r.request_id])).toEqual([["turn.submit", "r1"]]);
  expect(carriedReceipts(undefined, now)).toEqual([]);
});

test("an adopt remembers the runtime it left as where the chat came from only when that was a Mac; one a Cloud computer hands on keeps its Mac (C2)", () => {
  // Mac A -> Cloud computer 1: Mac A.
  expect(movedFromAfter(undefined, { from_runtime_id: "rt-mac-a", from_kind: "laptop" })).toBe("rt-mac-a");
  // Cloud computer 1 -> Cloud computer 2, or -> Mac B: still Mac A, never the Cloud computer (Back to Mac A stays Mac A).
  expect(movedFromAfter("rt-mac-a", { from_runtime_id: "rt-box-1", from_kind: "cloud" })).toBe("rt-mac-a");
  expect(movedFromAfter(undefined, { from_runtime_id: "rt-box-1", from_kind: "cloud" })).toBeUndefined();
  // An older Cloud names no kind: the runtime it left, as before.
  expect(movedFromAfter("rt-mac-a", { from_runtime_id: "rt-box-1" })).toBe("rt-box-1");
  // No source named (a pull Cloud moved itself): what the copy carried.
  expect(movedFromAfter("rt-mac-a", {})).toBe("rt-mac-a");
});
