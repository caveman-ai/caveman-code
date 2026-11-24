// A chat's summary (CONTRACT §3, S14): scrubbed and cut to Cloud's lengths; a change of what the chat is doing goes at
// once, a burst of previews once; an unchanged summary is never sent again; after an outage the rest go in batches.
import { createScrubber, type ChatSummaryInput, type Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { makeSummaryWriter, movingOf, namesPlace, summaryOf, withoutAskedBy, withoutPlace } from "./summaries.ts";

const SECRET = "sk-live-0c5e9b2d7f1a4c8e4f9a2c7e1b8d3f6a";
const scrubber = createScrubber([{ name: "API_TOKEN", value: SECRET }]);
const workspace = (over: Partial<Workspace> = {}): Workspace =>
  ({
    id: "w1",
    session_id: "s1",
    title: "Fix login",
    repo: { path: "/r" },
    base_ref: "main",
    branch: "caveman/fix-login",
    engine: "codex",
    computer: { id: "c1", kind: "this_mac", label: "This Mac", status: "online" },
    status: "idle",
    created_at: "2026-10-21T10:00:00.000Z",
    updated_at: "2026-10-21T10:05:00.000Z",
    ...over,
  }) as Workspace;

describe("chat summaries", () => {
  it("are scrubbed of secret values and cut to Cloud's lengths", () => {
    const summary = summaryOf(
      workspace({ status: "needs_input" }),
      { epoch: 2, head: 40, repo: "acme/web", lastText: `the key is ${SECRET} ${"and more ".repeat(60)}`, ask: { kind: "approval", prompt: `run curl -H ${SECRET}` } },
      scrubber,
    );
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(summary.preview!.length).toBeLessThanOrEqual(280);
    expect(summary).toMatchObject({ session_id: "s1", workspace_id: "w1", engine: "codex", kind: "chat", status: "needs_you", needs_you: { kind: "approval" }, epoch: 2, head: 40, repo: "acme/web", archived: false });
    expect(summaryOf(workspace({ status: "archived", kind: "chief" }), { epoch: 1, head: 0 }, scrubber)).toMatchObject({ kind: "chief", status: "idle", archived: true });
    // A chat running mail from another Mac names the asking chat; a Cloud from before the field gets it without.
    const asked = summaryOf(workspace({ asked_by_session_id: "sess-asker" }), { epoch: 1, head: 0 }, scrubber);
    expect(asked).toMatchObject({ asked_by_session_id: "sess-asker" });
    expect(withoutAskedBy(asked)).not.toHaveProperty("asked_by_session_id");
    expect(summaryOf(workspace(), { epoch: 1, head: 0 }, scrubber)).not.toHaveProperty("asked_by_session_id");
  });

  it("call a chat at work while its turn ended but work that will wake it still runs (activity.awaiting)", () => {
    const awaiting = workspace({ activity: { last_outcome: "completed", awaiting: true } });
    expect(summaryOf(awaiting, { epoch: 1, head: 0 }, scrubber).status).toBe("working");
    expect(summaryOf(workspace({ activity: { last_outcome: "completed" } }), { epoch: 1, head: 0 }, scrubber).status).toBe("idle");
  });

  it("say where the chat can run and where it is going, whole each time, and nothing of it when the runtime does not say", () => {
    const facts = { epoch: 1, head: 3 };
    // Nothing said (a Cloud from before the fields refused them): none of the three is in the summary.
    const silent = summaryOf(workspace({ moving: { to: "cloud", since: "2026-11-10T09:00:00.000Z" } } as Partial<Workspace>), facts, scrubber);
    expect(silent).not.toHaveProperty("movable");
    expect(silent).not.toHaveProperty("stays");
    expect(silent).not.toHaveProperty("moving");
    expect(namesPlace(silent)).toBe(false);
    // It can run somewhere else: movable, and no reason.
    const free = summaryOf(workspace(), { ...facts, place: { movable: true } }, scrubber);
    expect(free).toMatchObject({ movable: true });
    expect(free).not.toHaveProperty("stays");
    expect(free).not.toHaveProperty("moving");
    // It stays: movable false with the code, and only the code.
    const kept = summaryOf(workspace(), { ...facts, place: { movable: false, stays: { code: "folder" } } }, scrubber);
    expect(kept).toMatchObject({ movable: false, stays: { code: "folder" } });
    expect(Object.keys(kept.stays!)).toEqual(["code"]);
    // A move asked for when the turn ends, to Cloud; one under way to a Mac goes by that Mac's computer in Cloud, never its name.
    const since = "2026-11-10T09:00:00.000Z";
    const waiting = summaryOf(workspace({ status: "working", moving: { to: "cloud", waiting: true, since } } as Partial<Workspace>), { ...facts, place: { movable: true } }, scrubber);
    expect(waiting.moving).toEqual({ to: "cloud", waiting_turn: true, since });
    const toMac = workspace({ moving: { to: "mac", name: "Studio", computer_id: "0b1f6c1e-52f6-4f0e-8a51-6b7c8d9e0f1a", since } } as Partial<Workspace>);
    expect(movingOf(toMac)).toEqual({ to: "0b1f6c1e-52f6-4f0e-8a51-6b7c8d9e0f1a", waiting_turn: false, since });
    expect(JSON.stringify(summaryOf(toMac, { ...facts, place: { movable: true } }, scrubber))).not.toContain("Studio");
    // A Mac this runtime cannot name by its computer says nothing; an archived chat goes nowhere.
    expect(movingOf(workspace({ moving: { to: "mac", name: "Studio", since } } as Partial<Workspace>))).toBeUndefined();
    expect(summaryOf(workspace({ status: "archived", moving: { to: "cloud", since } } as Partial<Workspace>), { ...facts, place: { movable: true } }, scrubber)).not.toHaveProperty("moving");
    // The move ended: the next summary says none, so Cloud's row loses it.
    expect(summaryOf(workspace(), { ...facts, place: { movable: true } }, scrubber)).not.toHaveProperty("moving");
    // For a Cloud from before the fields: the same summary without the three, and nothing else changed.
    const full = summaryOf(workspace({ moving: { to: "cloud", waiting: true, since } } as Partial<Workspace>), { ...facts, place: { movable: false, stays: { code: "not_saved" } } }, scrubber);
    expect(namesPlace(full)).toBe(true);
    const older = withoutPlace(full);
    expect(namesPlace(older)).toBe(false);
    const { movable: _movable, stays: _stays, moving: _moving, ...rest } = full;
    expect(older).toEqual(rest);
  });

  it("writes a change of where the chat can run, or that it is on its way, at once, as it does a status", async () => {
    const since = "2026-11-10T09:00:00.000Z";
    let current: ChatSummaryInput = summaryOf(workspace(), { epoch: 1, head: 1, place: { movable: true } }, scrubber);
    const puts: Array<ChatSummaryInput> = [];
    const writer = makeSummaryWriter({
      build: () => Effect.succeed(current),
      all: Effect.succeed(["s1"]),
      put: (s) => Effect.sync(() => void puts.push(s)),
      putMany: () => Effect.succeed(undefined),
      debounceMs: 60_000, // nothing here waits out a burst
      log: () => Effect.void,
    });
    const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e as Effect.Effect<A>);
    await run(writer.changed("s1"));
    await waitFor(() => puts.length === 1);
    current = summaryOf(workspace({ moving: { to: "cloud", waiting: true, since } } as Partial<Workspace>), { epoch: 1, head: 1, place: { movable: true } }, scrubber);
    await run(writer.changed("s1"));
    await waitFor(() => puts.length === 2);
    expect(puts[1]!.moving).toEqual({ to: "cloud", waiting_turn: true, since });
    current = summaryOf(workspace(), { epoch: 1, head: 1, place: { movable: false, stays: { code: "save_failing" } } }, scrubber);
    await run(writer.changed("s1"));
    await waitFor(() => puts.length === 3);
    expect(puts[2]).toMatchObject({ movable: false, stays: { code: "save_failing" } });
    expect(puts[2]).not.toHaveProperty("moving");
  });

  it("writes a status change at once, a burst of previews once, nothing unchanged, and reconciles after an outage", async () => {
    let current: ChatSummaryInput = summaryOf(workspace(), { epoch: 1, head: 1 }, scrubber);
    const puts: Array<ChatSummaryInput> = [];
    const batches: Array<number> = [];
    let down = false;
    const writer = makeSummaryWriter({
      build: () => Effect.succeed(current),
      all: Effect.succeed(["s1"]),
      put: (s) => (down ? Effect.fail({ message: "Caveman Cloud is not reachable" }) : Effect.sync(() => void puts.push(s))),
      putMany: (list) => Effect.sync(() => (batches.push(list.length), undefined)),
      debounceMs: 50,
      log: () => Effect.void,
    });
    const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e as Effect.Effect<A>);
    await run(writer.changed("s1"));
    await waitFor(() => puts.length === 1);
    // Working now: at once, no debounce.
    current = { ...current, status: "working", head: 2 };
    const at = Date.now();
    await run(writer.changed("s1"));
    await waitFor(() => puts.length === 2);
    expect(Date.now() - at).toBeLessThan(40);
    // Three previews in a burst: one write, the last.
    for (const text of ["a", "b", "c"]) {
      current = { ...current, preview: text };
      await run(writer.changed("s1"));
    }
    await waitFor(() => puts.length === 3);
    await new Promise((r) => setTimeout(r, 120));
    expect(puts.map((p) => p.preview ?? null)).toEqual([null, null, "c"]);
    // Unchanged: nothing.
    await run(writer.now("s1"));
    expect(puts).toHaveLength(3);
    // Cloud down: the write fails and the writer is behind; once Cloud answers, the rest go up in a batch.
    down = true;
    current = { ...current, status: "idle" };
    await run(writer.changed("s1"));
    await waitFor(() => writer.behind());
    down = false;
    current = { ...current, title: "Fixed login" };
    await run(writer.reconcile);
    expect(batches).toEqual([1]);
    expect(writer.behind()).toBe(false);
  });

  it("tries a failed write again until it lands, with nothing else changing (X-10)", async () => {
    const current = summaryOf(workspace({ status: "needs_input" }), { epoch: 1, head: 9, ask: { kind: "approval", prompt: "run the migration?" } }, scrubber);
    const puts: Array<ChatSummaryInput> = [];
    let failures = 2;
    const writer = makeSummaryWriter({
      build: () => Effect.succeed(current),
      all: Effect.succeed(["s1"]),
      put: (s) => (failures-- > 0 ? Effect.fail({ message: "502 from Caveman Cloud" }) : Effect.sync(() => void puts.push(s))),
      putMany: () => Effect.succeed(undefined),
      retryMs: 20,
      log: () => Effect.void,
    });
    await Effect.runPromise(writer.changed("s1"));
    // Two failures, then it lands: the ask reaches every device though the chat never changes again.
    await waitFor(() => puts.length === 1, 3_000);
    expect(puts[0]).toMatchObject({ status: "needs_you", needs_you: { kind: "approval" } });
    expect(writer.behind()).toBe(false);
  });

  it("keeps a chat Cloud refused inside a batch unsent, so the next reconcile sends it again (X-10)", async () => {
    const summaries = new Map(["s1", "s2"].map((id) => [id, { ...summaryOf(workspace({ id: `w-${id}`, session_id: id }), { epoch: 1, head: 3 }, scrubber) }]));
    const batches: Array<Array<string>> = [];
    let refuse = true;
    const writer = makeSummaryWriter({
      build: (id) => Effect.succeed(summaries.get(id)),
      all: Effect.succeed(["s1", "s2"]),
      put: () => Effect.void,
      putMany: (list) =>
        Effect.sync(() => {
          batches.push(list.map((s) => s.session_id));
          return list.map((s) => (refuse && s.session_id === "s2" ? { session_id: s.session_id, error: { code: "cave_code_journal_epoch", message: "another epoch" } } : { session_id: s.session_id, seq: 1 }));
        }),
      log: () => Effect.void,
    });
    expect(await Effect.runPromise(writer.reconcile)).toBe(1);
    refuse = false;
    expect(await Effect.runPromise(writer.reconcile)).toBe(1);
    expect(batches).toEqual([["s1", "s2"], ["s2"]]);
  });

  it("has one write of a chat in flight at a time, and the last one carries the newest state (F-4)", async () => {
    let current = summaryOf(workspace({ status: "working" }), { epoch: 1, head: 1 }, scrubber);
    const landed: Array<string> = [];
    let inFlight = 0;
    let most = 0;
    const writer = makeSummaryWriter({
      build: () => Effect.succeed(current),
      all: Effect.succeed(["s1"]),
      put: (s) =>
        Effect.gen(function* () {
          inFlight++;
          most = Math.max(most, inFlight);
          // The first write is slow (a far Cloud): the next state comes while it is out.
          yield* Effect.sleep(landed.length === 0 ? 80 : 5);
          inFlight--;
          landed.push(s.status);
        }),
      putMany: () => Effect.succeed(undefined),
      log: () => Effect.void,
    });
    await Effect.runPromise(writer.changed("s1"));
    await new Promise((r) => setTimeout(r, 10));
    current = { ...current, status: "idle", head: 2 };
    await Effect.runPromise(writer.changed("s1"));
    await waitFor(() => landed.length === 2);
    expect(most).toBe(1);
    expect(landed).toEqual(["working", "idle"]);
  });

  it("sends a chat again after `forget`, though nothing changed (F-5: sync off and on again)", async () => {
    const current = summaryOf(workspace(), { epoch: 1, head: 2 }, scrubber);
    const puts: Array<ChatSummaryInput> = [];
    const writer = makeSummaryWriter({
      build: () => Effect.succeed(current),
      all: Effect.succeed(["s1"]),
      put: (s) => Effect.sync(() => void puts.push(s)),
      putMany: () => Effect.succeed(undefined),
      log: () => Effect.void,
    });
    await Effect.runPromise(writer.now("s1"));
    await Effect.runPromise(writer.now("s1"));
    expect(puts).toHaveLength(1);
    writer.forget("s1");
    await Effect.runPromise(writer.now("s1"));
    expect(puts).toHaveLength(2);
    expect(puts[1]!.sync).toBe(true);
  });
});

async function waitFor(check: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
