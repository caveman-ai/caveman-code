// Workspace.inbox and workspace.inbox: a chat's done, snooze, pin and read state lives on its T3 thread
// (Orchestrator + ThreadSettlementService) and reaches the workspace in the call's answer and through the
// projector. Real Claude adapter and SDK on scripts/smoke-claude.mjs.
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { ThreadId } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as ServerSettings from "../serverSettings.ts";
import { dueForArchive } from "./inbox.ts";
import type { WorkspaceRecord } from "./store.ts";
import { makeConfig, makeRepo, MODEL, orchestratorOf, PROMPT, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-inbox-");
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: ServerSettings.layerTest().pipe(Layer.orDie) });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const finishedChat = async (id: string) => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: id, repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: PROMPT } });
  // Its first turn finished: idle alone also holds before that turn starts.
  await until(async () => {
    const now = await client.call("workspace.get", { workspace_id: w.id });
    return now.status === "idle" && now.activity?.last_outcome === "completed";
  });
  return client.call("workspace.get", { workspace_id: w.id });
};

test("done, reopen, pin, snooze and wake land on the thread and the workspace without moving updated_at", async () => {
  const w = await finishedChat("inbox-states");
  const act = (n: number, action: Parameters<typeof client.call<"workspace.inbox">>[1]["action"]) =>
    client.call("workspace.inbox", { request_id: `inbox-states-${n}`, workspace_id: w.id, action });

  const done = await act(1, { do: "done" });
  expect(done.inbox?.done_at).toBeDefined();
  expect(done.updated_at).toBe(w.updated_at);
  const shell = await Effect.runPromise(orchestratorOf(runtime).getThreadShell(ThreadId.make(`caveman:${w.id}`)));
  expect(shell?.settledOverride).toBe("settled");
  expect((await client.call("workspace.list", {})).workspaces.find((x) => x.id === w.id)?.inbox?.done_at).toBe(done.inbox?.done_at);

  expect((await act(2, { do: "reopen" })).inbox?.done_at).toBeUndefined();

 // Pinning takes it out of done; done unpins (upstream rules).
  await act(3, { do: "done" });
  const pinned = await act(4, { do: "pin" });
  expect(pinned.inbox).toMatchObject({ pinned_at: expect.any(String) });
  expect(pinned.inbox?.done_at).toBeUndefined();
  const doneAgain = await act(5, { do: "done" });
  expect(doneAgain.inbox?.pinned_at).toBeUndefined();
  await act(6, { do: "reopen" });

  const wakeAt = new Date(Date.now() + 3_600_000).toISOString();
  const snoozed = await act(7, { do: "snooze", until: wakeAt });
  expect(Date.parse(snoozed.inbox!.snoozed_until!)).toBe(Date.parse(wakeAt));
  expect(snoozed.inbox?.snoozed_at).toBeDefined();
  const woke = await act(8, { do: "wake" });
  expect(woke.inbox?.snoozed_until).toBeUndefined();
  expect(woke.updated_at).toBe(w.updated_at);
});

test("a done chat restored from the archive comes back off the Done shelf, so the sweep cannot archive it again", async () => {
  const w = await finishedChat("inbox-restore");
  await client.call("workspace.inbox", { request_id: "inbox-restore-1", workspace_id: w.id, action: { do: "done" } });
  await client.call("workspace.archive", { request_id: "inbox-restore-2", workspace_id: w.id });
  const restored = await client.call("workspace.restore", { request_id: "inbox-restore-3", workspace_id: w.id });
  expect(restored.status).toBe("idle");
  expect(restored.inbox?.done_at).toBeUndefined();
  const shell = await Effect.runPromise(orchestratorOf(runtime).getThreadShell(ThreadId.make(`caveman:${w.id}`)));
  expect(shell?.settledOverride).not.toBe("settled");
});

test("Undo of an archive (keep_done) brings a done chat back done from when it was, so it archives again when it would have", async () => {
  const w = await finishedChat("inbox-keep");
  const done = await client.call("workspace.inbox", { request_id: "inbox-keep-1", workspace_id: w.id, action: { do: "done" } });
  await client.call("workspace.archive", { request_id: "inbox-keep-2", workspace_id: w.id });
  const restored = await client.call("workspace.restore", { request_id: "inbox-keep-3", workspace_id: w.id, keep_done: true });
  expect(restored.status).toBe("idle");
  expect(restored.inbox?.done_at).toBe(done.inbox?.done_at);
  const shell = await Effect.runPromise(orchestratorOf(runtime).getThreadShell(ThreadId.make(`caveman:${w.id}`)));
  expect(shell?.settledOverride).toBe("settled");
  expect(shell?.settledAt ? DateTime.toEpochMillis(shell.settledAt) : null).toBe(Date.parse(done.inbox!.done_at!));
});

test("a fork of a pinned or done chat is a new chat in the queue: never shown pinned or done, not even at first", async () => {
  const w = await finishedChat("inbox-fork");
  const shown: Array<{ readonly id: string; readonly inbox?: unknown }> = [];
  client.on("workspace.changed", (changed) => shown.push(changed));
  for (const [n, action] of (["pin", "done"] as const).entries()) {
    const marked = await client.call("workspace.inbox", { request_id: `inbox-fork-${n}`, workspace_id: w.id, action: { do: action } });
    expect(marked.inbox?.[action === "pin" ? "pinned_at" : "done_at"]).toBeDefined();
    const fork = await client.call("session.fork", { request_id: `inbox-fork-fork-${n}`, session_id: w.session_id });
    expect(fork.workspace.inbox).toBeUndefined();
    // The fork's thread reaches the projector: every record of the fork published until then is the new chat's own.
    await until(async () => (await Effect.runPromise(orchestratorOf(runtime).getThreadShell(ThreadId.make(`caveman:${fork.workspace.id}`)))) != null);
    await until(async () => shown.some((changed) => changed.id === fork.workspace.id));
    expect(shown.flatMap((changed) => (changed.id === fork.workspace.id && changed.inbox !== undefined ? [changed.inbox] : []))).toEqual([]);
  }
});

test("an archived chat takes no done, snooze or pin until Restore brings it back, and says so; it can still be read", async () => {
  const w = await finishedChat("inbox-archived");
  await client.call("workspace.archive", { request_id: "inbox-archived-1", workspace_id: w.id });
  for (const [n, action] of [{ do: "done" }, { do: "pin" }, { do: "snooze", until: new Date(Date.now() + 3_600_000).toISOString() }].entries()) {
    await expect(client.call("workspace.inbox", { request_id: `inbox-archived-2-${n}`, workspace_id: w.id, action: action as never })).rejects.toMatchObject({
      message: expect.stringMatching(/archived: Restore brings it back/),
      error: { data: { reason: "invalid_state" } },
    });
  }
  const seen = await client.call("workspace.inbox", { request_id: "inbox-archived-3", workspace_id: w.id, action: { do: "seen", through: w.updated_at } });
  expect(seen.inbox?.visited_at).toBeDefined();
  await client.call("workspace.restore", { request_id: "inbox-archived-4", workspace_id: w.id });
  const pinned = await client.call("workspace.inbox", { request_id: "inbox-archived-5", workspace_id: w.id, action: { do: "pin" } });
  expect(pinned.inbox?.pinned_at).toBeDefined();
});

test("seen reads a chat through its updated_at and unread puts it back; the next message clears done and snooze", async () => {
  const w = await finishedChat("inbox-read");
  const seen = await client.call("workspace.inbox", { request_id: "inbox-read-1", workspace_id: w.id, action: { do: "seen", through: w.updated_at } });
  expect(Date.parse(seen.inbox!.visited_at!)).toBe(Date.parse(w.updated_at));
  const unread = await client.call("workspace.inbox", { request_id: "inbox-read-2", workspace_id: w.id, action: { do: "unread" } });
  expect(Date.parse(unread.inbox!.visited_at!)).toBeLessThan(Date.parse(w.updated_at));

  await client.call("workspace.inbox", { request_id: "inbox-read-3", workspace_id: w.id, action: { do: "done" } });
  const sent = Date.now();
  await client.call("turn.submit", { request_id: "inbox-read-4", session_id: w.session_id, kind: "followup", input: { text: PROMPT } });
 // The projector carries upstream unsettle onto the workspace.
  await until(async () => (await client.call("workspace.get", { workspace_id: w.id })).inbox?.done_at === undefined);
  // That turn finished, so nothing waits to start (T3 refuses a snooze then).
  await until(async () => {
    const shell = await Effect.runPromise(orchestratorOf(runtime).getThreadShell(ThreadId.make(`caveman:${w.id}`)));
    return shell?.latestRunCompletedAt != null && shell.latestRunCompletedAt.epochMilliseconds >= sent;
  });

  const snoozed = await client.call("workspace.inbox", {
    request_id: "inbox-read-5",
    workspace_id: w.id,
    action: { do: "snooze", until: new Date(Date.now() + 3_600_000).toISOString() },
  });
  expect(snoozed.inbox?.snoozed_until).toBeDefined();
  await client.call("turn.submit", { request_id: "inbox-read-6", session_id: w.session_id, kind: "followup", input: { text: PROMPT } });
  await until(async () => (await client.call("workspace.get", { workspace_id: w.id })).inbox?.snoozed_until === undefined);
});

test("the Chief has no inbox state, and auto-done's settings are T3's", async () => {
  await client.call("project.create", { request_id: "inbox-project", path: makeRepo(root, { "README.md": "chief\n" }), name: "chief-project" });
  const chief = await client.call("chief.get", {});
  await expect(client.call("workspace.inbox", { request_id: "inbox-chief", workspace_id: chief.workspace.id, action: { do: "done" } })).rejects.toMatchObject({
    error: { data: { reason: "invalid_state" } },
  });
  expect(await client.call("settings.get", {})).toMatchObject({ inbox_done_on_merge: true, inbox_done_after_days: 3, inbox_keep_pull_requests: false });
  const next = await client.call("settings.set", { request_id: "inbox-settings", settings: { inbox_done_after_days: null, inbox_keep_pull_requests: true } });
  expect(next).toMatchObject({ inbox_done_on_merge: true, inbox_done_after_days: null, inbox_keep_pull_requests: true });
  expect(await client.call("settings.get", {})).toMatchObject({ inbox_done_after_days: null, inbox_keep_pull_requests: true });
});

test("Claude Agent's idle compaction is T3's compactIdleThreads, on return by default", async () => {
  expect(await client.call("settings.get", {})).toMatchObject({ claude_idle_compaction: "on_return" });
  const next = await client.call("settings.set", { request_id: "idle-compaction", settings: { claude_idle_compaction: "before_cache_expires" } });
  expect(next).toMatchObject({ claude_idle_compaction: "before_cache_expires" });
  expect(await client.call("settings.get", {})).toMatchObject({ claude_idle_compaction: "before_cache_expires" });
  await client.call("settings.set", { request_id: "idle-compaction-back", settings: { claude_idle_compaction: "on_return" } });
});

test("Review's settings are T3's review guide settings, never saved in the runtime's own", async () => {
  const before = await client.call("settings.get", {});
  expect(before).toMatchObject({
    review_guides: true,
    review_prewarm: true,
    review_short_lines: 30,
    review_chat_tldr: true,
    review_step_up: true,
    review_single_pass_kb: 48,
    review_prewarm_daily: 20,
    review_prewarm_plan_percent: 70,
    review_prewarm_idle_minutes: 2,
    review_instructions: "",
  });
  // Auto: no guide model pinned.
  expect(before).not.toHaveProperty("review_model");
  const pin = { engine: "claude-agent" as const, instance_id: "claudeAgent:default", model: "claude-haiku-5-5" };
  const next = await client.call("settings.set", {
    request_id: "review-settings",
    settings: {
      review_short_lines: 0,
      review_chat_tldr: false,
      review_step_up: false,
      review_single_pass_kb: 96,
      review_prewarm_daily: 5,
      review_prewarm_plan_percent: 50,
      review_prewarm_idle_minutes: 10,
      review_model: pin,
      review_instructions: "  Skip test files.  ",
    },
  });
  const set = {
    review_guides: true,
    review_short_lines: 0,
    review_chat_tldr: false,
    review_step_up: false,
    review_single_pass_kb: 96,
    review_prewarm_daily: 5,
    review_prewarm_plan_percent: 50,
    review_prewarm_idle_minutes: 10,
    review_model: pin,
    review_instructions: "Skip test files.",
  };
  expect(next).toMatchObject(set);
  expect(await client.call("settings.get", {})).toMatchObject(set);
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const saved = (db.prepare("SELECT value FROM caveman_sp_kv WHERE key = 'settings'").get() as { value: string } | undefined)?.value ?? "{}";
  db.close();
  expect(Object.keys(JSON.parse(saved)).filter((key) => key.startsWith("review_"))).toEqual([]);
  // A pin that names a connection (an engine that lists nothing else, as on a Cloud computer) is the engine's default
  // instance: a connection is no instance of its own, the person's order decides.
  await client.call("settings.set", { request_id: "review-settings-connection", settings: { review_model: { ...pin, instance_id: "connection:2f6c0d6e-0000-4000-8000-000000000001" } } });
  expect((await client.call("settings.get", {})).review_model).toEqual(pin);
  // null is Auto again.
  await client.call("settings.set", { request_id: "review-settings-auto", settings: { review_model: null, review_guides: false } });
  const after = await client.call("settings.get", {});
  expect(after).not.toHaveProperty("review_model");
  expect(after.review_guides).toBe(false);
  await client.call("settings.set", { request_id: "review-settings-on", settings: { review_guides: true } });
});

test("the Snooze menu's choices are T3's snoozePresets, never saved in the runtime's own (T3 Code #26208)", async () => {
  expect(await client.call("settings.get", {})).toMatchObject({
    inbox_snooze_options: [
      { kind: "after", minutes: 60 },
      { kind: "after", minutes: 180 },
      { kind: "at", day: "today", time: "18:00" },
      { kind: "at", day: "tomorrow", time: "09:00" },
      { kind: "at", day: "monday", time: "09:00" },
    ],
  });
  const mine = [
    { kind: "after", minutes: 30 },
    { kind: "at", day: "friday", time: "16:30" },
  ] as const;
  expect(await client.call("settings.set", { request_id: "snooze-options", settings: { inbox_snooze_options: [...mine] } })).toMatchObject({ inbox_snooze_options: mine });
  expect(await client.call("settings.get", {})).toMatchObject({ inbox_snooze_options: mine });
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const saved = (db.prepare("SELECT value FROM caveman_sp_kv WHERE key = 'settings'").get() as { value: string } | undefined)?.value ?? "{}";
  db.close();
  expect(JSON.parse(saved)).not.toHaveProperty("inbox_snooze_options");
  // Nine is one too many; a time that is not HH:MM is refused before it reaches T3.
  await expect(client.call("settings.set", { request_id: "snooze-options-9", settings: { inbox_snooze_options: Array.from({ length: 9 }, () => ({ kind: "after" as const, minutes: 5 })) } })).rejects.toBeDefined();
  await expect(client.call("settings.set", { request_id: "snooze-options-bad", settings: { inbox_snooze_options: [{ kind: "at", day: "today", time: "9:00" }] } })).rejects.toBeDefined();
  await client.call("settings.set", { request_id: "snooze-options-none", settings: { inbox_snooze_options: [] } });
  expect(await client.call("settings.get", {})).toMatchObject({ inbox_snooze_options: [] });
});

test("how chats are named is T3's thread title instructions, never saved in the runtime's own (T3 Code #21882)", async () => {
  expect(await client.call("settings.get", {})).toMatchObject({ thread_title_instructions: "" });
  const next = await client.call("settings.set", { request_id: "title-instructions", settings: { thread_title_instructions: "  Two to four words.  " } });
  expect(next).toMatchObject({ thread_title_instructions: "Two to four words." });
  expect(await client.call("settings.get", {})).toMatchObject({ thread_title_instructions: "Two to four words." });
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const saved = (db.prepare("SELECT value FROM caveman_sp_kv WHERE key = 'settings'").get() as { value: string } | undefined)?.value ?? "{}";
  db.close();
  expect(JSON.parse(saved)).not.toHaveProperty("thread_title_instructions");
  await client.call("settings.set", { request_id: "title-instructions-clear", settings: { thread_title_instructions: "" } });
  expect(await client.call("settings.get", {})).toMatchObject({ thread_title_instructions: "" });
});

test("a chat done long enough, at rest, is due for archive; pinned, busy, recent, under review and the Chief's are not", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const record = (id: string, workspace: Record<string, unknown>) => ({ workspace: { id, status: "idle", ...workspace } }) as unknown as WorkspaceRecord;
  const done = (at: string) => ({ inbox: { done_at: at } });
  const due = dueForArchive(
    [
      record("old", done("2026-10-12T12:00:00Z")),
      record("edge", done("2026-10-13T12:00:00Z")),
      record("recent", done("2026-10-19T12:00:00Z")),
      record("asleep", { status: "parked", ...done("2026-10-01T00:00:00Z") }),
      record("busy", { status: "working", ...done("2026-10-01T00:00:00Z") }),
      record("pinned", { inbox: { done_at: "2026-10-01T00:00:00Z", pinned_at: "2026-10-01T00:00:00Z" } }),
      record("chief", { kind: "chief", ...done("2026-10-01T00:00:00Z") }),
      record("open", {}),
      record("in-review", { pull_request: { number: 1, url: "u", state: "open" }, ...done("2026-10-01T00:00:00Z") }),
      record("draft", { pull_request: { number: 2, url: "u", state: "draft" }, ...done("2026-10-01T00:00:00Z") }),
      record("merged", { pull_request: { number: 3, url: "u", state: "merged" }, ...done("2026-10-01T00:00:00Z") }),
    ],
    7,
    now,
  );
  expect(due.map((r) => r.workspace.id)).toEqual(["old", "edge", "asleep", "merged"]);
});

test("auto-archive is a week until set, null turns it off, and it is the runtime's own setting", async () => {
  expect((await client.call("settings.get", {})).inbox_archive_done_after_days).toBe(7);
  await client.call("settings.set", { request_id: "inbox-archive-on", settings: { inbox_archive_done_after_days: 14 } });
  expect((await client.call("settings.get", {})).inbox_archive_done_after_days).toBe(14);
  await client.call("settings.set", { request_id: "inbox-archive-off", settings: { inbox_archive_done_after_days: null } });
  expect((await client.call("settings.get", {})).inbox_archive_done_after_days).toBeNull();
});
