// A synced chat's summary row in Caveman Cloud: what every device lists (title, engine, where
// and how it runs, the ask waiting on the person, a short preview, its journal's head and pull request). The runtime
// that owns the chat writes it from the chat's workspace record: at once when what it is doing changes (its status,
// the ask waiting on the person: S14), else 500 ms after the chat changes (one write for a burst of previews and
// heads), and in batches of up to 100 at start and once Cloud answers again after an outage, so the list converges.
// One write per chat is in flight at a time, so a later state never lands under an older one, and a write that fails
// is tried again (1 s doubling to 60 s) until it lands. Previews and asks are scrubbed of every secret value before
// they leave, and cut to Cloud's lengths.
import { NEEDS_YOU_MAX, PREVIEW_MAX, type ChatKind, type ChatPullRequest, type ChatStatus, type ChatSummaryInput, type Scrubber, type SessionEvent, type SummaryBatchItem, type Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { call } from "./computers.ts";
import type { Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";
import type { ChatPlace } from "./stays.ts";

/** A burst of changes to one chat writes its summary once, this long after the last. */
export const SUMMARY_DEBOUNCE_MS = 500;
/** Cloud's batch route takes at most this many. */
export const SUMMARY_BATCH = 100;
/** A write that failed is tried again after this long, doubling up to SUMMARY_RETRY_MAX_MS. */
export const SUMMARY_RETRY_MS = 1_000;
export const SUMMARY_RETRY_MAX_MS = 60_000;

/** What the summary needs beyond the workspace: the facts the runtime keeps elsewhere. */
export interface SummaryFacts {
  readonly epoch: number;
  readonly head: number;
  /** The chat's repository on GitHub (owner/name), when it has one. */
  readonly repo?: string | undefined;
  /** The model the latest turn ran on. */
  readonly model?: string | undefined;
  /** The latest assistant message, as stored (scrubbed again here). */
  readonly lastText?: string | undefined;
  /** A builder's or delegated agent's lead, by session. */
  readonly parentSessionId?: string | undefined;
  readonly delegated?: boolean;
  readonly automation?: boolean;
  /** What the projector folded as waiting on the person: the latest open ask. */
  readonly ask?: { readonly kind: "question" | "approval" | "secret" | "tool"; readonly prompt: string } | undefined;
  /**
   * Whether the chat can run somewhere else, and the code of why not (stays.ts placeOf). Undefined says nothing of it:
   * the summary then carries neither `movable` nor `stays` nor `moving` (a Cloud from before them refuses the fields).
   */
  readonly place?: ChatPlace | undefined;
}

/**
 * The chat's own mark of a move (the protocol's Workspace.moving, set by the runtime that holds it): on its way to
 * Cloud or to a Mac, since when, and whether it waits for its turn to end. Read by shape, so a workspace from before
 * the mark has none.
 */
interface MovingMark {
  readonly to: "cloud" | "mac";
  readonly computer_id?: string | undefined;
  readonly waiting?: true | undefined;
  readonly since: string;
}

/**
 * The move as Cloud's chat list carries it (CONTRACT §11): `to` is "cloud" or the Mac's computer id in Caveman Cloud,
 * never a name. A move to a Mac this runtime cannot name by its computer says nothing: Cloud's own record of the move
 * names it once the move is under way.
 */
export const movingOf = (workspace: Workspace): ChatSummaryInput["moving"] => {
  const mark = (workspace as Workspace & { readonly moving?: MovingMark }).moving;
  if (mark === undefined) return undefined;
  const to = mark.to === "cloud" ? "cloud" : mark.computer_id;
  return to === undefined ? undefined : { to, waiting_turn: mark.waiting === true, since: mark.since };
};

/** `text` on one line, at most `max` characters (an ellipsis where it was cut). */
export const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

const kindOf = (workspace: Workspace, facts: SummaryFacts): ChatKind =>
  workspace.kind === "chief" ? "chief" : workspace.kind === "setup" ? "setup" : facts.automation || workspace.automation ? "automation" : facts.delegated || workspace.parent_workspace_id ? "builder" : "chat";

// A chat whose turn ended while work that will wake it still runs (activity.awaiting) is at work: its summary is all
// another computer's window sees of it.
const statusOf = (workspace: Workspace, facts: SummaryFacts): ChatStatus =>
  facts.ask !== undefined || workspace.status === "needs_input"
    ? "needs_you"
    : workspace.status === "starting" || workspace.status === "working" || workspace.status === "waiting" || (workspace.status === "idle" && workspace.activity?.awaiting === true)
      ? "working"
      : workspace.status === "failed"
        ? "error"
        : "idle";

const pullRequestOf = (workspace: Workspace): ChatPullRequest | undefined =>
  workspace.pull_request ? { number: workspace.pull_request.number, url: workspace.pull_request.url, state: workspace.pull_request.state, checks: "none" } : undefined;

/** The summary Cloud keeps for a chat, scrubbed by `scrubber`. */
export function summaryOf(workspace: Workspace, facts: SummaryFacts, scrubber: Scrubber): ChatSummaryInput {
  const status = statusOf(workspace, facts);
  const ask = facts.ask ?? workspace.activity?.ask;
  const pr = pullRequestOf(workspace);
  const moving = facts.place === undefined || workspace.status === "archived" ? undefined : movingOf(workspace);
  return {
    session_id: workspace.session_id,
    workspace_id: workspace.id,
    title: oneLine(scrubber.scrub(workspace.title), 200) || "Chat",
    engine: workspace.engine,
    ...(facts.model ? { model: facts.model } : {}),
    ...(facts.repo ? { repo: facts.repo } : {}),
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    ...(workspace.base_ref ? { base_branch: workspace.base_ref } : {}),
    kind: kindOf(workspace, facts),
    ...(facts.parentSessionId ? { parent_session_id: facts.parentSessionId } : {}),
    ...(workspace.asked_by_session_id ? { asked_by_session_id: workspace.asked_by_session_id } : {}),
    status,
    ...(status === "needs_you" && ask
      ? { needs_you: { kind: ask.kind === "approval" || ask.kind === "tool" ? ("approval" as const) : ("question" as const), summary: oneLine(scrubber.scrub(ask.prompt), NEEDS_YOU_MAX) } }
      : {}),
    last_activity_at: workspace.updated_at,
    ...(facts.lastText ? { preview: oneLine(scrubber.scrub(facts.lastText), PREVIEW_MAX) } : {}),
    epoch: facts.epoch,
    head: facts.head,
    ...(pr ? { pull_request: pr } : {}),
    archived: workspace.status === "archived",
    // Written only while the chat syncs: a chat whose sync was off and is on again comes back into every list.
    sync: true,
    // Where it can run and where it is going (CONTRACT §11): said whole each time, so a move that ended is gone.
    ...(facts.place === undefined ? {} : facts.place.movable ? { movable: true } : { movable: false, stays: { code: facts.place.stays.code } }),
    ...(moving ? { moving } : {}),
  };
}

/** Whether a summary says where its chat can run or is going (the three fields a Cloud from before them refuses). */
export const namesPlace = (summary: ChatSummaryInput) => summary.movable !== undefined || summary.stays !== undefined || summary.moving !== undefined;

/**
 * A summary as a Cloud from before movable, stays and moving takes it: its strict decoder refuses an unknown field
 * (400), so once one did, summaries go without the three (devices then ask the chat's own runtime, as they did).
 */
export const withoutPlace = (summary: ChatSummaryInput): ChatSummaryInput => {
  const { movable: _movable, stays: _stays, moving: _moving, ...rest } = summary;
  return rest;
};

/**
 * A summary as a Cloud from before asked_by_session_id takes it: its strict decoder refuses an unknown field (400), so
 * once one did, summaries go without it (the asking chat's devices then also tell the person of the asked chat).
 */
export const withoutAskedBy = (summary: ChatSummaryInput): ChatSummaryInput => {
  const { asked_by_session_id: _gone, ...rest } = summary;
  return rest;
};

/** A summary as a Cloud from before placed_workspace_id takes it (its strict decoder refuses an unknown field). */
export const withoutPlaced = (summary: ChatSummaryInput): ChatSummaryInput => {
  const { placed_workspace_id: _gone, ...rest } = summary;
  return rest;
};

/** The latest assistant text among `events` (newest last), for the preview. */
export const lastAssistantText = (events: ReadonlyArray<SessionEvent>) => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.trim() !== "") return e.payload.text;
  }
  return undefined;
};

export const putSummary = (identity: Identity, state: LinkState, summary: ChatSummaryInput, fetchImpl?: typeof fetch) =>
  call<unknown>(identity, state, "PUT", `chats/${encodeURIComponent(summary.session_id)}`, summary, fetchImpl);

/** A batch: Cloud answers each chat on its own (`{chats: [{session_id, seq} | {session_id, error}]}`). */
export const putSummaries = (identity: Identity, state: LinkState, summaries: ReadonlyArray<ChatSummaryInput>, fetchImpl?: typeof fetch) =>
  call<{ readonly chats?: ReadonlyArray<SummaryBatchItem> } | undefined>(identity, state, "PUT", "chats", { chats: summaries }, fetchImpl);

/** What devices must hear at once: what the chat is doing, what it waits on, and whether it is on its way somewhere or can go. */
const urgentPart = (summary: ChatSummaryInput | undefined) =>
  summary === undefined
    ? ""
    : JSON.stringify([summary.status, summary.needs_you ?? null, summary.archived, summary.kind, summary.movable ?? null, summary.stays?.code ?? null, summary.moving ?? null]);

/** The summary writer: debounced per chat, the last summary written kept so an unchanged one is not sent again. */
export interface SummaryWriter {
  /** The chat changed: written at once when its status or ask changed, else SUMMARY_DEBOUNCE_MS after the last change of a burst. */
  readonly changed: (sessionId: string) => Effect.Effect<void>;
  /** Writes it now (a copy needs the chat registered first); fails as Cloud did, and is tried again later on its own. */
  readonly now: (sessionId: string) => Effect.Effect<void, { readonly message: string }>;
  /** Writes every chat `all` names in batches, skipping those whose summary Cloud already has (start, after an outage). */
  readonly reconcile: Effect.Effect<number, { readonly message: string }>;
  /** Sent and not answered since: the next success reconciles. */
  readonly behind: () => boolean;
  /** Cloud no longer has the chat's summary (sync off, signed out): its next write goes whatever was sent before. All chats without an id. */
  readonly forget: (sessionId?: string) => void;
}

export const makeSummaryWriter = (input: {
  /** The summary a chat has now, or undefined when it does not sync. */
  readonly build: (sessionId: string) => Effect.Effect<ChatSummaryInput | undefined>;
  /** Every synced chat's session id. */
  readonly all: Effect.Effect<ReadonlyArray<string>>;
  readonly put: (summary: ChatSummaryInput) => Effect.Effect<void, { readonly message: string }>;
  /** A batch, answered per chat (Cloud's `chats`); an answer without them took every one. */
  readonly putMany: (summaries: ReadonlyArray<ChatSummaryInput>) => Effect.Effect<ReadonlyArray<SummaryBatchItem> | undefined, { readonly message: string }>;
  readonly debounceMs?: number;
  /** The first wait before a failed write is tried again (doubling up to SUMMARY_RETRY_MAX_MS). */
  readonly retryMs?: number;
  readonly log?: (message: string) => Effect.Effect<void>;
  /** Runs a write in the background, in the runtime's scope. */
  readonly fork?: (effect: Effect.Effect<void>) => void;
}) => {
  const debounce = input.debounceMs ?? SUMMARY_DEBOUNCE_MS;
  const retryMs = input.retryMs ?? SUMMARY_RETRY_MS;
  const log = input.log ?? ((message: string) => Effect.logWarning(message));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** What Cloud last took for each chat (JSON), so an unchanged summary is never sent twice. */
  const sent = new Map<string, string>();
  /** The status part of the last summary sent (urgentPart). */
  const sentUrgent = new Map<string, string>();
  /** One write of a chat at a time: a later one builds after the earlier landed, so Cloud never ends on an older state. */
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (sessionId: string) => {
    let lock = locks.get(sessionId);
    if (lock === undefined) locks.set(sessionId, (lock = Semaphore.makeUnsafe(1)));
    return lock;
  };
  /** Single writes that landed, per chat: a batch that raced one sends that chat again. */
  const landed = new Map<string, number>();
  /** A failed chat's next try: how many failed in a row, and its timer. */
  const retries = new Map<string, { readonly failed: number; readonly timer: ReturnType<typeof setTimeout> }>();
  let outage = false;
  const runFork = <A, E>(effect: Effect.Effect<A, E>) => (input.fork ?? ((e: Effect.Effect<void>) => void Effect.runFork(e)))(effect.pipe(Effect.ignore));

  const settled = (sessionId: string) => {
    const retry = retries.get(sessionId);
    if (retry !== undefined) clearTimeout(retry.timer);
    retries.delete(sessionId);
  };
  /** Tried again after 1 s, 2 s, 4 s... up to 60 s, until it lands (or the chat stops syncing). */
  const retryLater = (sessionId: string) => {
    const failed = (retries.get(sessionId)?.failed ?? 0) + 1;
    settled(sessionId);
    const timer = setTimeout(() => runFork(background(sessionId)), Math.min(retryMs * 2 ** (failed - 1), SUMMARY_RETRY_MAX_MS));
    timer.unref?.();
    retries.set(sessionId, { failed, timer });
  };

  const writeNow = (sessionId: string) =>
    lockOf(sessionId).withPermits(1)(
      Effect.gen(function* () {
        const summary = yield* input.build(sessionId);
        if (summary === undefined) return settled(sessionId);
        const json = JSON.stringify(summary);
        if (sent.get(sessionId) === json) return settled(sessionId);
        const wasDown = outage;
        yield* input.put(summary).pipe(Effect.tapError(() => Effect.sync(() => ((outage = true), retryLater(sessionId)))));
        sent.set(sessionId, json);
        sentUrgent.set(sessionId, urgentPart(summary));
        landed.set(sessionId, (landed.get(sessionId) ?? 0) + 1);
        settled(sessionId);
        outage = false;
        // Cloud answers again: what changed while it did not goes up in batches.
        if (wasDown) runFork(reconcile.pipe(Effect.catch((error) => log(`summaries: reconciling after an outage failed: ${error.message}`))));
      }),
    );
  const background = (sessionId: string) => writeNow(sessionId).pipe(Effect.catch((error) => log(`summaries: ${sessionId} did not reach Caveman Cloud (tried again): ${error.message}`)));

  const reconcile: Effect.Effect<number, { readonly message: string }> = Effect.gen(function* () {
    const ids = yield* input.all;
    const owed: Array<ChatSummaryInput> = [];
    for (const id of ids) {
      const summary = yield* input.build(id);
      if (summary !== undefined && sent.get(id) !== JSON.stringify(summary)) owed.push(summary);
    }
    let took = 0;
    for (let i = 0; i < owed.length; i += SUMMARY_BATCH) {
      const batch = owed.slice(i, i + SUMMARY_BATCH);
      const before = new Map(batch.map((summary) => [summary.session_id, landed.get(summary.session_id) ?? 0]));
      const answer = yield* input.putMany(batch).pipe(Effect.tapError(() => Effect.sync(() => (outage = true))));
      const refusedHere = new Map((answer ?? []).flatMap((item) => (item.error ? [[item.session_id, item.error] as const] : [])));
      for (const summary of batch) {
        const refusal = refusedHere.get(summary.session_id);
        // Refused on its own (another epoch, another computer's now): not sent, so the next reconcile or change tries it again.
        if (refusal !== undefined) {
          yield* log(`summaries: Caveman Cloud refused ${summary.session_id}: ${refusal.code} ${refusal.message}`);
          continue;
        }
        took++;
        sent.set(summary.session_id, JSON.stringify(summary));
        sentUrgent.set(summary.session_id, urgentPart(summary));
        settled(summary.session_id);
        // A single write landed while the batch was out: the batch may have put an older state over it.
        if ((landed.get(summary.session_id) ?? 0) !== before.get(summary.session_id)) runFork(background(summary.session_id));
      }
    }
    outage = false;
    return took;
  });

  return {
    changed: (sessionId) =>
      Effect.gen(function* () {
        clearTimeout(timers.get(sessionId));
        timers.delete(sessionId);
        // Needs you, done, working: every device hears now (S14). Previews and heads wait out a burst.
        const summary = yield* input.build(sessionId);
        if (summary === undefined) return;
        if (urgentPart(summary) !== sentUrgent.get(sessionId)) return runFork(background(sessionId));
        const timer = setTimeout(() => {
          timers.delete(sessionId);
          runFork(background(sessionId));
        }, debounce);
        timer.unref?.();
        timers.set(sessionId, timer);
      }),
    now: writeNow,
    reconcile,
    behind: () => outage,
    forget: (sessionId?: string) => {
      for (const id of sessionId === undefined ? [...sent.keys()] : [sessionId]) {
        sent.delete(id);
        sentUrgent.delete(id);
      }
    },
  } satisfies SummaryWriter;
};
