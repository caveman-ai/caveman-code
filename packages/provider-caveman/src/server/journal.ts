/**
 * The Caveman engine's journal: where each engine run leaves the conversation it ended on, so resume, rollback, fork
 * and a move (Caveman Cloud the spec) restore it from the head run alone.
 *
 * - A harness run (every run now) leaves one checkpoint file under `<stateDir>/caveman/harness` (harness.ts).
 * - A run of the classic engine, before the harness took over, left a durable journal under `<stateDir>/caveman/
 *   journal`, its `run_started` / `run_completed` lines carrying the checkpoint. Those are only read now: a thread
 *   from before continues on the harness from its classic head.
 *
 * A move carries the head run as journal lines: a classic run's own, or a harness checkpoint as one line whose
 * `conversation` holds the messages, so the move's packing (runtime cloudLink/moves.ts packJournal) sends only what
 * each copy adds, whichever engine wrote it.
 *
 * And what a deleted chat leaves of the engine here: its runs, its harness checkpoints and what its SessionStart hooks
 * printed (forgetCavemanThreads).
 *
 * @module provider-caveman/server/journal
 */
import { readdir, rm } from "node:fs/promises";
import * as path from "node:path";

import { DiskDurableStore, durableConversationCheckpoint, durableRunSummary } from "@caveman-ai/agent/durable";

import { messagesSha, readHarnessCheckpoint, writeHarnessCheckpoint, type HarnessCheckpoint } from "./harness.ts";

/** Where the classic engine journaled its runs under a provider host's state dir. */
export const cavemanJournalRoot = (stateDir: string) => path.join(stateDir, "caveman", "journal");
/** Where each harness run's checkpoint is, under a provider host's state dir. */
export const cavemanHarnessRoot = (stateDir: string) => path.join(stateDir, "caveman", "harness");

/** A harness checkpoint as one journal line. */
const HARNESS_LINE = "harness_checkpoint";

/** Where the adapter keeps what each native thread's SessionStart hooks printed, a file named for the thread (adapter.ts startSession). */
export const cavemanSessionStartRoot = (stateDir: string) => path.join(stateDir, "caveman", "session-start");

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const parsed = (line: string): Record<string, unknown> | undefined => {
  try {
    return record(JSON.parse(line));
  } catch {
    return undefined;
  }
};

/**
 * The conversation a classic run left: its result, or where it started if it never finished. Undefined when the run
 * has no journal here or no conversation in it; a tampered or torn checkpoint never becomes a conversation (its
 * digest is recomputed).
 */
export async function classicRunMessages(stateDir: string, runId: string): Promise<ReadonlyArray<unknown> | undefined> {
  const lines = await new DiskDurableStore(cavemanJournalRoot(stateDir)).load(runId);
  if (lines.length === 0) return undefined;
  let base: unknown;
  let terminal: unknown;
  for (const line of lines) {
    const event = parsed(line);
    if (event?.type === "run_started") base = event.conversation;
    if (event?.type === "run_completed") terminal = event.conversation;
  }
  const status = durableRunSummary(lines).status;
  const chosen = record(status === "completed" ? terminal : status === "failed" ? (terminal ?? base) : base);
  if (chosen === undefined || typeof chosen.sessionId !== "string" || !Array.isArray(chosen.messages)) return undefined;
  const checkpoint = durableConversationCheckpoint(chosen.sessionId, chosen.messages);
  return checkpoint.messagesSha256 === chosen.messagesSha256 ? checkpoint.messages : undefined;
}

/** A run's journal lines for a move: a harness run's checkpoint as one line, else a classic run's lines; empty when it has none here. */
export async function readCavemanRun(stateDir: string, runId: string): Promise<ReadonlyArray<string>> {
  const checkpoint = await readHarnessCheckpoint(cavemanHarnessRoot(stateDir), runId);
  if (checkpoint !== undefined) return [JSON.stringify({ type: HARNESS_LINE, conversation: checkpoint })];
  return new DiskDurableStore(cavemanJournalRoot(stateDir)).load(runId);
}

/** Whether a run's lines carry its conversation: a harness checkpoint, or a classic run that journaled its start. */
export const cavemanRunCarries = (lines: ReadonlyArray<string>): boolean =>
  lines.some((line) => line.includes(`"${HARNESS_LINE}"`) || line.includes('"run_started"'));

/**
 * Writes a run journaled on another computer; a run already journaled here is kept as it is. A harness checkpoint
 * whose messages do not match the digest it carried is refused, so a torn copy never becomes a conversation.
 */
export async function writeCavemanRun(stateDir: string, runId: string, lines: ReadonlyArray<string>): Promise<void> {
  if (lines.length === 0) return;
  const first = parsed(lines[0]!);
  if (first?.type === HARNESS_LINE) {
    const checkpoint = record(first.conversation) as Partial<HarnessCheckpoint> | undefined;
    if (checkpoint === undefined || !Array.isArray(checkpoint.messages)) throw new Error(`Caveman run ${runId}: the moved checkpoint has no conversation`);
    if (messagesSha(checkpoint.messages) !== checkpoint.messagesSha256) throw new Error(`Caveman run ${runId}: the moved checkpoint is corrupt`);
    const dir = cavemanHarnessRoot(stateDir);
    if ((await readHarnessCheckpoint(dir, runId).catch(() => undefined)) !== undefined) return;
    await writeHarnessCheckpoint(dir, { runId, model: String(checkpoint.model ?? ""), loadout: String(checkpoint.loadout ?? ""), messages: checkpoint.messages });
    return;
  }
  const store = new DiskDurableStore(cavemanJournalRoot(stateDir));
  if ((await store.load(runId)).length > 0) return;
  await store.append(runId, `${lines.join("\n")}\n`);
  await store.close(runId);
}

/**
 * Removes what the engine kept of native threads no chat continues (`forget`): every run journaled on one, every
 * harness checkpoint of one, and what its SessionStart hooks printed. A run is `<nativeThreadId>-<random>` (adapter.ts
 * startTurn), and the engine's store keeps it in a directory whose name begins with the run's id, as a harness
 * checkpoint is `<runId>.json`, so a name begins with its native thread's id too. A run or native thread named in
 * `keep` stays: a live chat continues from it.
 */
export async function forgetCavemanThreads(
  stateDir: string,
  input: { readonly forget: ReadonlySet<string>; readonly keep: ReadonlySet<string> },
): Promise<void> {
  if (input.forget.size === 0) return;
  const journalRoot = cavemanJournalRoot(stateDir);
  for (const name of await entries(journalRoot)) {
    const ids = leadingIds(name);
    if (ids.some((id) => input.forget.has(id)) && !ids.some((id) => input.keep.has(id))) {
      await rm(path.join(journalRoot, name), { recursive: true, force: true });
    }
  }
  const harnessRoot = cavemanHarnessRoot(stateDir);
  for (const name of await entries(harnessRoot)) {
    // `<runId>.json`, or its write in progress `<runId>.json.<pid>.tmp`; a run id holds no ".".
    const ids = leadingIds(name.split(".")[0]!);
    if (ids.some((id) => input.forget.has(id)) && !ids.some((id) => input.keep.has(id))) {
      await rm(path.join(harnessRoot, name), { force: true });
    }
  }
  const sessionStartRoot = cavemanSessionStartRoot(stateDir);
  for (const name of await entries(sessionStartRoot)) {
    if (input.forget.has(name) && !input.keep.has(name)) await rm(path.join(sessionStartRoot, name), { force: true });
  }
}

/** The name itself and each of its leading parts that ends before a "-". */
const leadingIds = (name: string) => [...name.matchAll(/-/g)].map((dash) => name.slice(0, dash.index)).concat(name);

const entries = (dir: string) =>
  readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
