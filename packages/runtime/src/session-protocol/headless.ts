// Sessions nobody sits at (Caveman Cloud CONTRACT §3.2-§3.5, §4.1-§4.2, §7): on a Cloud computer, a session an API
// key or an automation started arrives as mail on the "session" channel. Its first mail (`task` with
// `payload.kind = "session_start"`) makes the local workspace from Cloud's row: the repository is the computer's
// checkout, the engine and model come from the agent version it names (loaded through the one agent loader) or the
// request, and the task is the session's instruction. An automation's trigger event rides along as data, never as
// instructions. Later mail steers it: `task` (a message), `interrupt` (Stop) and `answer` (the named ask only).
//
// For an org workload (origin api or automation) every Session Protocol event is mapped to its public events in
// one place (cloudLink/publicEvents.ts), kept in the outbox and posted, scrubbed, to Cloud; its trace spans go to
// Cloud's trace ingest. A person's chat sends nothing of the sort. Its input files are mounted read-only, what it
// writes under outputs is uploaded when it goes idle, and the memory stores it attached are files it reads and
// writes, kept in step with Cloud through the runtime routes. Every session Cloud started here keeps Cloud's row (its
// run state) told, retried until Cloud took each change; an org workload's model calls go to Cloud's meter, which
// charges its tree budget, and a parked tree stops its work with `budget_reached`. A start is registered before it
// makes anything, so a runtime that stops midway resumes it when the mail comes again.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseAgentFile, type ParsedAgent } from "@caveman-app/automations";
import type { AccessMode, Scrubber, SessionEvent, Workspace } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { agentTypePrompt } from "../agents/agentTypes.ts";
import { DATA_LINE, renderBlocks } from "../automations/steps.ts";
import { batchesOf, makeOutbox, type CloudSessionRow } from "../cloudLink/eventOutbox.ts";
import type { CloudComputerInfo, LinkState } from "../cloudLink/index.ts";
import { CloudError, type Identity } from "../cloudLink/identity.ts";
import { waitComputerMail } from "../cloudLink/mail.ts";
import {
  expectInput,
  isOrgWorkload,
  mapSessionEvent,
  outputEvent,
  pullRequestEvent,
  sessionError,
  stopReasonOf,
  terminated,
  type MapperState,
  type PublicEvent,
  type StopReason,
} from "../cloudLink/publicEvents.ts";
import {
  ackSessionMail,
  deleteMemory,
  getAgentVersion,
  getFileContent,
  listMemories,
  postOutput,
  postSessionEvents,
  postSessionUsage,
  postTraces,
  putMemory,
  takeSessionMail,
  SESSION_CHANNEL,
  type AnswerPayload,
  type SessionMail,
  type SessionStartPayload,
} from "../cloudLink/sessions.ts";
import { call as runtimeCall } from "../cloudLink/computers.ts";
import { treeOf, USAGE_BATCH, usageEventOf } from "../cloudLink/sessionUsage.ts";
import { initialTraceState, otlpRequest, traceEvent, type TraceContext } from "../cloudLink/traces.ts";
import { responseFor, steeredNote } from "./askAnswers.ts";
import type { CustomTool } from "./clientTools.ts";
import type { AskResponse } from "./runtimeAsks.ts";
import { submittedMessageId, type SessionStore, type WorkspaceRecord } from "./store.ts";

/** Where a session's files live on its computer (CONTRACT §4.1): CAVEMAN_SESSION_MOUNT, else /mnt/session. */
export const sessionMountOf = (env: NodeJS.ProcessEnv = process.env) => env.CAVEMAN_SESSION_MOUNT || "/mnt/session";

/**
 * Session mail is taken when Cloud's long wait for this computer says some is there (notified, not polled), at the
 * latest every MAIL_WAIT_MS. A Cloud without that wait is asked every MAIL_FALLBACK_MS instead.
 */
const MAIL_WAIT_MS = 25_000;
const MAIL_FALLBACK_MS = 5_000;
const SEND_TICK_MS = 250;
const MAX_BACKOFF_MS = 30_000;
/** Usage goes to Cloud's meter when a call is journaled, and at least this often (side spend has no event). */
const METER_MS = 5_000;
/** Run-state changes kept for Cloud while it is away; past this only the latest are said. */
const OWED_MAX = 16;
/** An output larger than this stays on the computer (Cloud's files take up to 100 MB). */
const OUTPUT_MAX_BYTES = 100 * 1024 * 1024;

/** An automation's session, handed to the automation runner: it runs from its revision, not from the task text. */
export interface CloudAutomationStart {
  readonly sessionId: string;
  /** The project the computer's checkout is (the workspaces its steps make belong to it). */
  readonly projectId: string;
  readonly automation: NonNullable<SessionStartPayload["automation"]>;
  /**
   * Says something of the session to Cloud through the one outbox (public event types, CONTRACT §3.4): its steps
   * (`automation.step`), an approval gate (`requires_action`), its status. A `session.status` also moves Cloud's row.
   */
  readonly emit: (type: string, data: Record<string, unknown>) => Effect.Effect<void>;
}

/**
 * The automation runner for sessions an automation starts (automations v2, automations/cloudHost.ts), when this
 * runtime has one; without it such a session runs its task with the trigger event as data.
 */
export interface CloudAutomationsService {
  readonly start: (input: CloudAutomationStart) => Effect.Effect<void, { readonly message: string }>;
  /** An `answer` mail for one of its gates (ask ids `automation:...`): true when it took it. */
  readonly answer: (askId: string, answer: AnswerPayload) => Effect.Effect<boolean>;
  /** An `interrupt` mail for its session (a stopped or superseded run): cancels the run; true when one was running. */
  readonly stop?: (sessionId: string) => Effect.Effect<boolean>;
}
export class CloudAutomations extends Context.Reference<CloudAutomationsService | undefined>("caveman/session-protocol/CloudAutomations", {
  defaultValue: () => undefined,
}) {}

/** Cloud's run state for a public status: what its row and webhooks read. */
const RUN_STATE_OF: Record<string, string> = { starting: "starting", running: "working", requires_action: "needs_input", idle: "idle" };

/** What makes the workspace (handlers.ts createWorkspace, as a runtime caller). */
export interface HeadlessCreate {
  readonly request_id: string;
  readonly repo: { readonly url: string };
  readonly title: string;
  readonly engine: string;
  readonly branch?: string;
  readonly base_ref?: string;
  readonly options: { readonly model?: string; readonly access?: AccessMode };
  readonly task: { readonly text: string };
  /** What the engine reads instead of the task's text (the agent's instructions, the data blocks). */
  readonly brief?: string;
  readonly customTools?: ReadonlyArray<CustomTool>;
}

export interface HeadlessDeps {
  readonly store: SessionStore["Service"];
  readonly scope: Scope.Scope;
  readonly cloud: CloudComputerInfo | undefined;
  readonly cloudLink: LinkState;
  readonly linkIdentity: () => Identity | undefined;
  readonly scrubber: Effect.Effect<Scrubber>;
  /** The send backstop (rejectSecretInput): fails when the text holds a secret. createWorkspace, submit and steer run it too. */
  readonly checkInput: (text: string) => Effect.Effect<void, { readonly message: string }>;
  readonly createWorkspace: (p: HeadlessCreate) => Effect.Effect<Workspace, { readonly message: string }>;
  readonly submit: (record: WorkspaceRecord, text: string, requestId: string) => Effect.Effect<unknown, { readonly message: string }>;
  /** A message into the running turn, as a person's steer; the next turn's when none runs. */
  readonly steer: (record: WorkspaceRecord, text: string, requestId: string) => Effect.Effect<unknown, { readonly message: string }>;
  readonly interrupt: (sessionId: string, requestId: string) => Effect.Effect<unknown, { readonly message: string }>;
  readonly respond: (sessionId: string, askId: string, response: AskResponse, requestId: string) => Effect.Effect<unknown, { readonly message: string }>;
  /** A model class (fast, base, frontier) as the engine's model; anything else as it is. */
  readonly resolveModel: (engine: string, model: string | undefined) => Effect.Effect<string | undefined>;
  /** A session nobody can answer runs with this access (an automation's: never `ask`). */
  readonly unattendedAccess: (engine: string) => Effect.Effect<AccessMode | undefined>;
  readonly note: (record: WorkspaceRecord, level: "info" | "warning", title: string, body?: string) => Effect.Effect<unknown>;
  /** A finished tool's output from the engine's thread (the journal keeps none for a command). */
  readonly toolOutput: (threadId: string, itemId: string) => Effect.Effect<unknown>;
  /** The project of the computer's checkout, for an automation runner's steps. */
  readonly projectId: () => Effect.Effect<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly sessionMount?: string;
}

/** A registered session whose start is under way: a redelivered start resumes it instead of acking it done. */
const PENDING = "pending:";
const pendingId = (sessionId: string) => `${PENDING}${sessionId}`;

/** The session's files could not be put on this computer's disk. */
class MountError extends Error {}

/** A mail's outcome: acknowledged (done, or refused for good), or left for a later take. */
type Outcome = "done" | "retry";

const now = () => new Date().toISOString();
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
/** A refusal Cloud will repeat, as opposed to a network failure or a 5xx worth retrying. */
const permanent = (error: unknown) => error instanceof CloudError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A run state Cloud takes, from the workspace's status; archived and parked say nothing. */
const RUN_STATE: Partial<Record<Workspace["status"], string>> = { starting: "starting", working: "working", needs_input: "needs_input", idle: "idle", failed: "failed" };

/** `file.txt`, never a path out of its folder. */
const safeName = (name: string) => path.basename(name.replace(/\\/g, "/")).replace(/^\.+/, "").slice(0, 200) || "file";

/** A memory's path inside its store's folder; undefined when it would leave it. */
function memoryFile(dir: string, memoryPath: string): string | undefined {
  const parts = memoryPath.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return undefined;
  return path.join(dir, ...parts);
}

/** Every regular file under `dir` (symlinks are never followed), as paths relative to it. */
function filesUnder(dir: string): Array<string> {
  const out: Array<string> = [];
  const walk = (at: string) => {
    let entries: Array<fs.Dirent>;
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** The engine's first message: the agent's instructions and the task, where its files are, then the trigger as data. */
export function briefFor(input: {
  readonly task: string;
  readonly agent: ParsedAgent | undefined;
  readonly mounts: ReadonlyArray<string>;
  readonly automation: SessionStartPayload["automation"];
}): string | undefined {
  const parts: Array<string> = [input.agent ? agentTypePrompt({ ...input.agent, role: input.agent.role ?? "general" }, input.task) : input.task];
  if (input.mounts.length > 0) parts.push(input.mounts.join("\n"));
  const event = input.automation?.event;
  if (input.automation && event !== undefined && event !== null) {
    parts.push(
      "---",
      DATA_LINE,
      renderBlocks([
        {
          tag: "input",
          attrs: { source: input.automation.trigger },
          body: typeof event === "string" ? event : JSON.stringify(event, null, 2),
          where: `automation run ${input.automation.run_id}`,
        },
      ]),
    );
  }
  const brief = parts.join("\n\n");
  return brief === input.task ? undefined : brief;
}

// One rule for an answer, shared with `agent exec`'s stdin (askAnswers.ts).
export { responseFor, steeredNote };

export const makeHeadless = (deps: HeadlessDeps) =>
  Effect.gen(function* () {
    const { store } = deps;
    const automations = yield* CloudAutomations;
    const outbox = makeOutbox(store.sql);
    const fetchImpl = deps.fetch ?? fetch;
    const mount = deps.sessionMount ?? sessionMountOf();
    const wake = yield* Queue.sliding<void>(1);
    const locks = new Map<string, Semaphore.Semaphore>();
    const lock = (id: string) => {
      let s = locks.get(id);
      if (!s) locks.set(id, (s = Semaphore.makeUnsafe(1)));
      return s;
    };
    const cloudTry = <A>(run: (identity: Identity) => Promise<A>) =>
      Effect.suspend(() => {
        const identity = deps.linkIdentity();
        return identity === undefined ? Effect.fail(new Error("this computer is not linked to Caveman")) : Effect.tryPromise({ try: () => run(identity), catch: (error) => error });
      });

    // ------------------------------------------------------------ events out

    const traceContext = (row: CloudSessionRow, record: WorkspaceRecord | undefined): TraceContext => ({
      sessionId: row.sessionId,
      origin: row.origin === "person" ? "api" : row.origin,
      engine: record?.workspace.engine ?? row.start.engine ?? "caveman",
      model: row.start.model ?? undefined,
      // Names, never ids: the agent file's name (an id only on a row kept before names were), else what ran.
      agentName: row.start.agent?.name ?? row.start.agent?.id ?? (row.start.automation ? "automation" : "session"),
      caveSession: row.start.automation?.run_id ?? row.sessionId,
    });

    /** Queues what happened in the session since it was last mapped: its public events and finished spans. */
    const forward = (sessionId: string) =>
      lock(sessionId).withPermits(1)(
        Effect.gen(function* () {
          const row = yield* outbox.byCloudId(sessionId);
          if (row === undefined || !isOrgWorkload(row.origin)) return;
          const record = yield* store.getBySession(row.localSessionId);
          if (record === undefined) return;
          const events = yield* store.readEvents(row.localSessionId, row.mappedThrough, Number.MAX_SAFE_INTEGER);
          if (events.length === 0) return;
          const state: MapperState = structuredClone(row.state);
          const trace = state.trace ?? initialTraceState(row.sessionId);
          const ctx = traceContext(row, record);
          const outputs = new Map<string, unknown>();
          for (const event of events) {
            if (event.type === "tool.done" && event.item_id !== undefined && event.payload.result === undefined) {
              outputs.set(event.item_id, yield* deps.toolOutput(record.internal.threadId, event.item_id).pipe(Effect.orElseSucceed(() => undefined)));
            }
          }
          const mapped = events.flatMap((event) => mapSessionEvent(state, event, row.origin as "api" | "automation", (id) => outputs.get(id)));
          const spans = events.flatMap((event) => traceEvent(trace, event, ctx));
          state.trace = trace;
          yield* outbox.enqueue(row.sessionId, mapped, { mappedThrough: events.at(-1)!.cursor, state, spans });
          yield* Queue.offer(wake, undefined);
          if (events.some((event) => event.type === "turn.done")) yield* settle(row.sessionId).pipe(Effect.forkIn(deps.scope));
        }),
      );

    /** Queues events the runtime itself has to say (a refused answer, an output, the end). */
    const say = (sessionId: string, events: ReadonlyArray<PublicEvent> | ((state: MapperState) => ReadonlyArray<PublicEvent>), extra: Parameters<typeof outbox.enqueue>[2] = {}) =>
      lock(sessionId).withPermits(1)(
        Effect.gen(function* () {
          const row = yield* outbox.byCloudId(sessionId);
          if (row === undefined || !isOrgWorkload(row.origin)) return;
          const state: MapperState = structuredClone(row.state);
          const list = typeof events === "function" ? events(state) : events;
          yield* outbox.enqueue(sessionId, list, { ...extra, state });
          yield* Queue.offer(wake, undefined);
        }),
      );

    /** One public event for a session (an automation runner's step, gate or status); a status also moves Cloud's row. */
    const emit = (sessionId: string, type: string, data: Record<string, unknown>) =>
      Effect.gen(function* () {
        yield* say(sessionId, (state) => {
          if (type !== "session.status" || typeof data.status !== "string") return [{ type, created_at: now(), data }];
          state.status = data.status as NonNullable<MapperState["status"]>;
          // A run the budget stopped (Cloud parked its tree) says so, whatever the runner calls its stop.
          const stop = data.status === "idle" || data.status === "terminated" ? stopReasonOf(state, (data.stop_reason ?? null) as StopReason | null) : data.stop_reason;
          return [{ type, created_at: now(), data: { ...data, stop_reason: stop ?? null } }];
        });
        if (type !== "session.status") return;
        const runState = data.status === "terminated" ? (data.stop_reason === "error" ? "failed" : "idle") : RUN_STATE_OF[String(data.status)];
        if (runState !== undefined) yield* oweRunState(sessionId, runState);
      });

    // ------------------------------------------------------------ run state out

    // Cloud's row for each session (its run state: what the session object's status and code.session.status_changed
    // read) is owed until Cloud took it: each change queued in order in the runtime's database beside the outbox, sent
    // after the events and sent again after a failure, so a blip never leaves a session reading `running` forever.
    const owedKey = (sessionId: string) => `headless:run-owed:${sessionId}`;
    const toldKey = (sessionId: string) => `headless:run:${sessionId}`;
    const owing = new Set<string>();
    const owedOf = (sessionId: string) => store.kvGet(owedKey(sessionId)).pipe(Effect.map((raw) => (raw ? (JSON.parse(raw) as Array<string>) : [])));
    const oweRunState = (sessionId: string, state: string) =>
      lock(`run:${sessionId}`).withPermits(1)(
        Effect.gen(function* () {
          const owed = yield* owedOf(sessionId);
          if ((owed.at(-1) ?? (yield* store.kvGet(toldKey(sessionId)))) === state) return;
          // While Cloud is away for long, only the latest changes are worth saying.
          yield* store.kvSet(owedKey(sessionId), JSON.stringify([...owed, state].slice(-OWED_MAX)));
          owing.add(sessionId);
          yield* Queue.offer(wake, undefined);
        }),
      );
    const tellRunStates = Effect.gen(function* () {
      // A snapshot: sessions leave and join the set while this goes.
      for (const sessionId of Array.from(owing)) {
        if (waiting(`run:${sessionId}`)) continue;
        const row = yield* outbox.byCloudId(sessionId);
        if (row === undefined || row.workspaceId === "") {
          owing.delete(sessionId);
          continue;
        }
        while (true) {
          // Read and, when nothing is owed, let go under the lock oweRunState holds: a change owed meanwhile stays.
          const state = yield* lock(`run:${sessionId}`).withPermits(1)(
            owedOf(sessionId).pipe(Effect.tap((owed) => Effect.sync(() => void (owed.length === 0 && owing.delete(sessionId)))), Effect.map((owed) => owed[0])),
          );
          if (state === undefined) break;
          const put = yield* cloudTry((identity) => runtimeCall(identity, deps.cloudLink, "PUT", `workspaces/${encodeURIComponent(row.workspaceId)}/run-state`, { run_state: state }, fetchImpl)).pipe(Effect.result);
          if (put._tag === "Failure" && !permanent(put.failure)) {
            later(`run:${sessionId}`);
            yield* Effect.logWarning(`sessions: telling Cloud ${sessionId} is ${state} failed (${messageOf(put.failure)}); it goes again shortly`);
            break;
          }
          // Refused for good (a parked tree, an archived workspace): nothing more to say of this change.
          if (put._tag === "Failure") yield* Effect.logWarning(`sessions: Cloud refused ${sessionId}'s run state ${state}: ${messageOf(put.failure)}`);
          backoff.delete(`run:${sessionId}`);
          // oweRunState only appends, so the head is still the change just sent.
          yield* lock(`run:${sessionId}`).withPermits(1)(
            Effect.gen(function* () {
              yield* store.kvSet(owedKey(sessionId), JSON.stringify((yield* owedOf(sessionId)).slice(1)));
              yield* store.kvSet(toldKey(sessionId), state);
            }),
          );
        }
      }
    });

    const backoff = new Map<string, { until: number; delay: number }>();
    const later = (key: string) => {
      const delay = Math.min(MAX_BACKOFF_MS, (backoff.get(key)?.delay ?? 250) * 2);
      backoff.set(key, { until: Date.now() + delay, delay });
    };
    const waiting = (key: string) => (backoff.get(key)?.until ?? 0) > Date.now();

    /** Posts every queued event and span; what Cloud refuses for good is dropped, the rest waits and goes again. */
    const flush = Effect.gen(function* () {
      if (deps.linkIdentity() === undefined) return;
      const scrubber = yield* deps.scrubber;
      for (const sessionId of yield* outbox.sessionsWithPending) {
        if (waiting(`events:${sessionId}`)) continue;
        const queued = yield* outbox.pending(sessionId);
        for (const batch of batchesOf(queued, scrubber)) {
          const sent = yield* cloudTry((identity) => postSessionEvents(identity, deps.cloudLink, sessionId, batch, fetchImpl)).pipe(Effect.result);
          if (sent._tag === "Failure" && !permanent(sent.failure)) {
            later(`events:${sessionId}`);
            yield* Effect.logWarning(`sessions: posting ${sessionId}'s events failed (${messageOf(sent.failure)}); they go again shortly`);
            break;
          }
          if (sent._tag === "Failure") yield* Effect.logWarning(`sessions: Cloud refused ${sessionId}'s events ${batch[0]!.seq}-${batch.at(-1)!.seq}: ${messageOf(sent.failure)}`);
          backoff.delete(`events:${sessionId}`);
          yield* outbox.posted(sessionId, batch.at(-1)!.seq);
        }
      }
      for (const sessionId of yield* outbox.sessionsWithSpans) {
        if (waiting(`spans:${sessionId}`)) continue;
        const row = yield* outbox.byCloudId(sessionId);
        const queued = yield* outbox.pendingSpans(sessionId);
        if (queued.length === 0) continue;
        const spans = queued.map((q) => scrubber.scrubDeep(q.span));
        const sent = yield* cloudTry((identity) => postTraces(identity, deps.cloudLink, otlpRequest(spans, { sessionId, origin: row?.origin === "automation" ? "automation" : "api" }), fetchImpl)).pipe(Effect.result);
        if (sent._tag === "Failure" && !permanent(sent.failure)) {
          later(`spans:${sessionId}`);
          continue;
        }
        backoff.delete(`spans:${sessionId}`);
        yield* outbox.postedSpans(sessionId, queued.at(-1)!.id);
      }
      yield* tellRunStates;
      yield* meter;
    });

    // ------------------------------------------------------------ usage out

    // Every model call of an org workload's tree goes to Cloud's meter keyed by Cloud's session id: it charges the
    // tree budget the caller set and is what the session object's `usage` reads. How far each session's calls went
    // is kept with the runtime's database; Cloud records each call once, so sending one again charges nothing twice.
    const usageKey = (sessionId: string) => `headless:usage:${sessionId}`;
    let meterDue = true;
    let meteredAt = 0;
    const meter = Effect.gen(function* () {
      if (!meterDue && Date.now() - meteredAt < METER_MS) return;
      meterDue = false;
      meteredAt = Date.now();
      const rows = (yield* outbox.all).filter((row) => isOrgWorkload(row.origin) && !row.localSessionId.startsWith(PENDING) && !row.localSessionId.startsWith("none:"));
      if (rows.length === 0) return;
      // Where the journal ends before the trees are read: every call up to it is of a workspace the trees already hold.
      const [end] = yield* store.sql<{ events: number | null; spend: number | null }>`SELECT
          (SELECT max(rowid) FROM caveman_sp_events) AS events, (SELECT max(seq) FROM caveman_sp_spend) AS spend`.pipe(Effect.orDie);
      const records = yield* store.listWorkspaces();
      const scrubber = yield* deps.scrubber;
      for (const row of rows) {
        if (waiting(`usage:${row.sessionId}`)) continue;
        const tree = treeOf(row, records);
        if (tree.sessions.length === 0) continue;
        const raw = yield* store.kvGet(usageKey(row.sessionId));
        const cursor = raw ? (JSON.parse(raw) as { events: number; spend: number }) : { events: 0, spend: 0 };
        const calls = yield* store.sql<{ rowid: number; event: string }>`SELECT rowid, event FROM caveman_sp_events
          WHERE type = 'usage' AND session_id IN ${store.sql.in(tree.sessions)} AND rowid > ${cursor.events} AND rowid <= ${end?.events ?? 0}
          ORDER BY rowid LIMIT ${USAGE_BATCH}`.pipe(Effect.orDie);
        const side =
          calls.length < USAGE_BATCH
            ? yield* store.sql<{ seq: number; at: string; usage: string }>`SELECT seq, at, usage FROM caveman_sp_spend
                WHERE workspace_id IN ${store.sql.in(tree.workspaces)} AND seq > ${cursor.spend} AND seq <= ${end?.spend ?? 0}
                ORDER BY seq LIMIT ${USAGE_BATCH - calls.length}`.pipe(Effect.orDie)
            : [];
        if (calls.length === 0 && side.length === 0) continue;
        const events = [
          ...calls.map((c) => {
            const event = JSON.parse(scrubber.scrub(c.event)) as Extract<SessionEvent, { type: "usage" }>;
            return usageEventOf(`${event.session_id}:${event.cursor}`, row.sessionId, event.at, event.payload);
          }),
          ...side.map((r) => usageEventOf(`spend:${r.seq}`, row.sessionId, r.at, JSON.parse(scrubber.scrub(r.usage)))),
        ].filter((e) => e !== undefined);
        const next = { events: calls.at(-1)?.rowid ?? cursor.events, spend: side.at(-1)?.seq ?? cursor.spend };
        if (events.length > 0) {
          const sent = yield* cloudTry((identity) => postSessionUsage(identity, deps.cloudLink, events, fetchImpl)).pipe(Effect.result);
          if (sent._tag === "Failure") {
            later(`usage:${row.sessionId}`);
            meterDue = true;
            yield* Effect.logWarning(`sessions: reporting ${row.sessionId}'s usage failed (${messageOf(sent.failure)}); it goes again shortly`);
            continue;
          }
          backoff.delete(`usage:${row.sessionId}`);
          for (const refused of sent.success.refused ?? []) yield* Effect.logWarning(`sessions: Cloud refused usage ${refused.request_id} of ${row.sessionId}: ${refused.code}`);
          yield* store.kvSet(usageKey(row.sessionId), JSON.stringify(next));
          if ((sent.success.budgets ?? []).some((b) => b.parked)) yield* budgetReached(row, tree.records);
        } else {
          yield* store.kvSet(usageKey(row.sessionId), JSON.stringify(next));
        }
        if (calls.length + side.length === USAGE_BATCH) meterDue = true;
      }
    });

    /**
     * Cloud parked the session's tree (its spend reached the budget): the work stops, and its status says
     * budget_reached. Said once a park; a turn after a person raised the limit starts afresh (the mapper's turn.started).
     */
    const budgetReached = (row: CloudSessionRow, tree: ReadonlyArray<WorkspaceRecord>) =>
      Effect.gen(function* () {
        let first = false;
        yield* say(row.sessionId, (state) => {
          if (state.budget !== true) {
            state.budget = true;
            first = true;
          }
          return [];
        });
        if (!first) return;
        yield* Effect.logWarning(`sessions: ${row.sessionId}'s budget is spent; Cloud parked its tree, so its work stops`);
        if (row.localSessionId.startsWith("automation:")) {
          if (automations?.stop !== undefined) yield* automations.stop(row.sessionId);
          return;
        }
        const busy = (r: WorkspaceRecord) => r.workspace.status === "working" || r.workspace.status === "needs_input" || r.workspace.status === "starting";
        for (const record of tree.filter(busy)) yield* deps.interrupt(record.session.id, `budget:${row.sessionId}:${record.session.id}:${Date.now()}`).pipe(Effect.ignore);
        // Nothing was running (the call that spent it was the turn's last): the status says so now.
        const root = tree.find((r) => r.session.id === row.localSessionId);
        if (root === undefined || !busy(root)) {
          yield* say(row.sessionId, (state) => {
            state.status = "idle";
            return [{ type: "session.status", created_at: now(), data: { status: "idle", stop_reason: "budget_reached" } }];
          });
        }
      });

    // ------------------------------------------------------------ files and memory

    /** One session per computer, so its files sit at the mount's top: /mnt/session/uploads, outputs, memory. */
    const dirsOf = (_sessionId: string) => ({ uploads: path.join(mount, "uploads"), outputs: path.join(mount, "outputs"), memory: path.join(mount, "memory") });
    const memoryKey = (sessionId: string, storeId: string) => `headless:memory:${sessionId}:${storeId}`;

    /** The session's inputs read-only, an outputs folder it writes, its memory stores as files. Answers the lines that tell the agent. */
    const prepareMounts = (sessionId: string, start: SessionStartPayload) =>
      Effect.gen(function* () {
        const files = start.files ?? [];
        const stores = start.memory_stores ?? [];
        const dirs = dirsOf(sessionId);
        const lines: Array<string> = [];
        // Outputs for every session the mount allows; inputs and stores it was given must mount, or it cannot start.
        const outputs = yield* Effect.try({
          try: () => {
            fs.mkdirSync(dirs.outputs, { recursive: true });
            fs.chmodSync(dirs.outputs, 0o777);
          },
          catch: (error) => new MountError(`${dirs.outputs}: ${messageOf(error)}`),
        }).pipe(Effect.result);
        if (outputs._tag === "Failure" && (files.length > 0 || stores.length > 0)) return yield* Effect.fail(outputs.failure);
        if (files.length > 0) {
          fs.mkdirSync(dirs.uploads, { recursive: true });
          fs.chmodSync(dirs.uploads, 0o755);
          const names: Array<string> = [];
          for (const entry of files) {
            const id = typeof entry === "string" ? entry : entry.id;
            const got = yield* cloudTry((identity) => getFileContent(identity, deps.cloudLink, id, fetchImpl));
            let name = safeName((typeof entry === "string" ? undefined : entry.name) ?? got.name ?? id);
            if (names.includes(name)) name = `${id}-${name}`;
            names.push(name);
            const file = path.join(dirs.uploads, name);
            if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
            fs.writeFileSync(file, got.bytes);
            fs.chmodSync(file, 0o444);
          }
          fs.chmodSync(dirs.uploads, 0o555);
          lines.push(`The files for this task are in ${dirs.uploads}/ (read-only): ${names.join(", ")}.`);
        }
        if (outputs._tag === "Success") lines.push(`Write files meant for whoever asked under ${dirs.outputs}/; they are handed back when you finish.`);
        for (const ref of stores) {
          const dir = path.join(dirs.memory, safeName(ref.name ?? ref.id));
          const readOnly = ref.access === "read_only";
          const memories = yield* cloudTry((identity) => listMemories(identity, deps.cloudLink, ref.id, sessionId, fetchImpl));
          fs.mkdirSync(dir, { recursive: true });
          const known: Record<string, string> = {};
          for (const memory of memories) {
            const file = memoryFile(dir, memory.path);
            if (file === undefined) continue;
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, memory.content);
            fs.chmodSync(file, readOnly ? 0o444 : 0o666);
            known[memory.path] = memory.sha256 ?? sha256(memory.content);
          }
          if (readOnly) for (const sub of [dir, ...filesUnder(dir).map((f) => path.dirname(path.join(dir, f)))]) fs.chmodSync(sub, 0o555);
          else fs.chmodSync(dir, 0o777);
          yield* store.kvSet(memoryKey(sessionId, ref.id), JSON.stringify({ dir, readOnly, known }));
          lines.push(`Memory store ${ref.name ?? ref.id} is in ${dir}/ (${readOnly ? "read-only" : "read and write; what you change there is kept for later sessions"}).`);
        }
        return lines;
      });

    /** Uploads new or changed outputs and writes changed memories back to their stores. */
    const settle = (sessionId: string) =>
      lock(`settle:${sessionId}`).withPermits(1)(
        Effect.gen(function* () {
          const row = yield* outbox.byCloudId(sessionId);
          if (row === undefined) return;
          const dirs = dirsOf(sessionId);
          // Outputs
          if (fs.existsSync(dirs.outputs)) {
            const outputs: Record<string, string> = { ...row.outputs };
            const said: Array<PublicEvent> = [];
            for (const rel of filesUnder(dirs.outputs)) {
              const file = path.join(dirs.outputs, rel);
              const size = fs.statSync(file).size;
              if (size > OUTPUT_MAX_BYTES) continue;
              const bytes = new Uint8Array(fs.readFileSync(file));
              const digest = sha256(bytes);
              if (outputs[rel] === digest) continue;
              const up = yield* cloudTry((identity) => postOutput(identity, deps.cloudLink, sessionId, { path: rel, bytes, sha256: digest }, fetchImpl)).pipe(Effect.result);
              if (up._tag === "Failure") {
                yield* Effect.logWarning(`sessions: uploading ${rel} for ${sessionId} failed: ${messageOf(up.failure)}`);
                continue;
              }
              outputs[rel] = digest;
              said.push(outputEvent(now(), up.success.id, rel, size));
            }
            if (said.length > 0 || Object.keys(outputs).length !== Object.keys(row.outputs).length) {
              if (isOrgWorkload(row.origin)) yield* say(sessionId, said, { outputs });
              else yield* outbox.enqueue(sessionId, [], { outputs });
            }
          }
          // Memory stores the session may write
          for (const ref of row.start.memory_stores ?? []) {
            if (ref.access === "read_only") continue;
            const raw = yield* store.kvGet(memoryKey(sessionId, ref.id));
            if (raw === undefined) continue;
            const kept = JSON.parse(raw) as { dir: string; readOnly: boolean; known: Record<string, string> };
            const known = { ...kept.known };
            const present = new Set<string>();
            for (const rel of filesUnder(kept.dir)) {
              present.add(rel);
              const content = fs.readFileSync(path.join(kept.dir, rel), "utf8");
              const digest = sha256(content);
              if (known[rel] === digest) continue;
              // Written over the version it was read at (or only if still absent): another writer's change is never lost.
              const put = yield* cloudTry((identity) => putMemory(identity, deps.cloudLink, ref.id, sessionId, { path: rel, content, if_sha256: known[rel] ?? "" }, fetchImpl)).pipe(Effect.result);
              if (put._tag === "Failure") {
                const record = yield* store.getBySession(row.localSessionId);
                if (record) yield* deps.note(record, "warning", `Memory ${rel} was not saved`, messageOf(put.failure));
                continue;
              }
              known[rel] = put.success.sha256 ?? digest;
            }
            for (const rel of Object.keys(known)) {
              if (present.has(rel)) continue;
              const gone = yield* cloudTry((identity) => deleteMemory(identity, deps.cloudLink, ref.id, sessionId, rel, known[rel]!, fetchImpl)).pipe(Effect.result);
              if (gone._tag === "Success") delete known[rel];
            }
            yield* store.kvSet(memoryKey(sessionId, ref.id), JSON.stringify({ ...kept, known }));
          }
        }),
      ).pipe(Effect.catchCause((cause) => Effect.logWarning(`sessions: settling ${sessionId} failed`, cause)));

    // ------------------------------------------------------------ mail in

    const recordOf = (row: CloudSessionRow) => store.getBySession(row.localSessionId);

    /** A session that cannot run: its error and end said, and Cloud told it failed. */
    const failSession = (mail: SessionMail, start: SessionStartPayload, origin: "api" | "automation" | "person", code: string, message: string) =>
      Effect.gen(function* () {
        yield* outbox.register({ sessionId: start.session_id, workspaceId: mail.to_workspace_id ?? "", localSessionId: `none:${start.session_id}`, origin, start });
        yield* outbox.adopt(start.session_id, `none:${start.session_id}`);
        const at = now();
        yield* say(start.session_id, (state) => [sessionError(at, code, message), ...terminated(state, at, "error")]);
        yield* oweRunState(start.session_id, "failed");
        yield* Effect.logWarning(`sessions: ${start.session_id} could not start (${code}): ${message}`);
        return "done" as Outcome;
      });

    /** The agent version a session names, read by the one agent loader; a string says why it cannot run. */
    const loadAgent = (ref: NonNullable<SessionStartPayload["agent"]>) =>
      Effect.gen(function* () {
        const got = yield* cloudTry((identity) => getAgentVersion(identity, deps.cloudLink, ref.id, ref.version, fetchImpl)).pipe(Effect.result);
        if (got._tag === "Failure") return permanent(got.failure) ? { invalid: `agent ${ref.id} version ${ref.version}: ${messageOf(got.failure)}` } : { retry: messageOf(got.failure) };
        if (got.success.file_sha256 && sha256(got.success.file) !== got.success.file_sha256) return { invalid: `agent ${ref.id} version ${ref.version} does not match its digest` };
        const parsed = parseAgentFile({ path: `.caveman/agents/${ref.id}.md`, text: got.success.file }, "project");
        const errors = parsed.diagnostics.filter((d) => d.severity === "error");
        if (parsed.agent === undefined || errors.length > 0) {
          return { invalid: errors.map((d) => `line ${d.line}: ${d.message}`).join(" ") || `agent ${ref.id} version ${ref.version} has no usable name` };
        }
        return { agent: parsed.agent };
      });

    /**
     * The workspace a start made before the runtime stopped (its row still pending): the one whose first message is
     * the start's task, as createWorkspace numbers it from the request id.
     */
    const madeFor = (sessionId: string) =>
      Effect.gen(function* () {
        const taskId = (localSessionId: string) => submittedMessageId(localSessionId, `session:${sessionId}:task`);
        for (const record of yield* store.listWorkspaces()) {
          if (record.workspace.status === "archived" || record.internal.delegated) continue;
          const hit = yield* store.sql<{ n: number }>`SELECT 1 AS n FROM caveman_sp_events
            WHERE session_id = ${record.session.id} AND type = 'message.done' AND json_extract(event, '$.item_id') = ${taskId(record.session.id)} LIMIT 1`.pipe(Effect.orDie);
          if (hit.length > 0) return record;
        }
        return undefined;
      });

    const start = (mail: SessionMail, payload: SessionStartPayload) =>
      Effect.gen(function* () {
        if (typeof payload.session_id !== "string" || payload.session_id === "") return "done" as Outcome;
        const known = yield* outbox.byCloudId(payload.session_id);
        if (known !== undefined && !known.localSessionId.startsWith(PENDING)) return "done" as Outcome;
        const origin = mail.authority === "api" || mail.authority === "automation" ? mail.authority : "person";
        let agent: ParsedAgent | undefined;
        if (payload.agent) {
          const loaded = yield* loadAgent(payload.agent);
          if ("retry" in loaded) return "retry" as Outcome;
          if ("invalid" in loaded) return yield* failSession(mail, payload, origin, "agent_invalid", loaded.invalid!);
          agent = loaded.agent;
        }
        // Registered pending before anything is made: a runtime that stops from here on resumes this start when the
        // mail comes again, rather than acking it done (an automation never run) or failing it (its workspace held).
        if (known === undefined) {
          const start = payload.agent && agent ? { ...payload, agent: { ...payload.agent, name: agent.name } } : payload;
          yield* outbox.register({ sessionId: payload.session_id, workspaceId: mail.to_workspace_id ?? "", localSessionId: pendingId(payload.session_id), origin, start });
        }
        // An automation's session runs from its revision in the automation runner, when this runtime has one. The
        // runner takes a run it already holds as admitted, so a start again after a stop is safe.
        if (payload.automation && automations !== undefined) {
          const projectId = yield* deps.projectId();
          if (projectId === undefined) return yield* failSession(mail, payload, origin, "start_failed", "this computer has no checkout to run the automation in");
          const handed = yield* automations
            .start({ sessionId: payload.session_id, projectId, automation: payload.automation, emit: (type, data) => emit(payload.session_id, type, data) })
            .pipe(Effect.result);
          yield* outbox.adopt(payload.session_id, `automation:${payload.session_id}`);
          if (handed._tag === "Failure") {
            const at = now();
            yield* say(payload.session_id, (state) => [sessionError(at, "start_failed", handed.failure.message), ...terminated(state, at, "error")]);
            yield* oweRunState(payload.session_id, "failed");
          }
          return "done" as Outcome;
        }
        const resumed = known === undefined ? undefined : yield* madeFor(payload.session_id);
        let made: WorkspaceRecord | undefined = resumed;
        if (made === undefined) {
          // A file the disk refuses (the mount is missing or read-only) never gets better: the session fails.
          const mounts = yield* prepareMounts(payload.session_id, payload).pipe(
            Effect.catchDefect((defect) => Effect.fail(new MountError(messageOf(defect)))),
            Effect.result,
          );
          if (mounts._tag === "Failure") {
            if (!(mounts.failure instanceof MountError) && !permanent(mounts.failure)) return "retry" as Outcome;
            return yield* failSession(mail, payload, origin, "files_unavailable", messageOf(mounts.failure));
          }
          // The agent file's engine wins, then the request's, then the Caveman engine.
          const engine = agent?.engine ?? payload.engine ?? "caveman";
          const model = yield* deps.resolveModel(engine, payload.model ?? agent?.model);
          const access = origin === "automation" ? yield* deps.unattendedAccess(engine) : undefined;
          const task = mail.body.trim() || "Start.";
          const brief = briefFor({ task, agent, mounts: mounts.success, automation: payload.automation });
          const created = yield* deps
            .createWorkspace({
              request_id: `session:${payload.session_id}`,
              repo: { url: `https://github.com/${payload.repo ?? "unknown/unknown"}` },
              title: payload.title || task.split("\n")[0]!.slice(0, 80),
              engine,
              ...(payload.branch ? { branch: payload.branch } : {}),
              ...(payload.base_branch ? { base_ref: payload.base_branch } : {}),
              options: { ...(model ? { model } : {}), ...(access ? { access } : {}) },
              task: { text: task },
              ...(brief ? { brief } : {}),
              ...(agent?.customTools?.length ? { customTools: agent.customTools } : {}),
            })
            .pipe(Effect.result);
          if (created._tag === "Failure") return yield* failSession(mail, payload, origin, "start_failed", created.failure.message);
          made = yield* store.getBySession(created.success.session_id);
          if (made === undefined) return yield* failSession(mail, payload, origin, "start_failed", `workspace ${created.success.id} is gone`);
        }
        yield* outbox.adopt(payload.session_id, made.session.id);
        yield* Effect.logInfo(`sessions: ${payload.session_id} ${resumed ? "resumed" : "started"} (${origin}${agent ? `, agent ${agent.name}` : ""})`);
        // What it did before the row named it: its run state and events so far.
        yield* watchWorkspace((yield* store.getBySession(made.session.id))?.workspace ?? made.workspace);
        yield* forward(payload.session_id);
        return "done" as Outcome;
      });

    /** Mail for a session already running here: its record, or retry when its start has not landed yet. */
    const sessionFor = (mail: SessionMail) =>
      Effect.gen(function* () {
        const row = mail.to_workspace_id ? yield* outbox.byWorkspace(mail.to_workspace_id) : undefined;
        const record = row === undefined ? undefined : yield* recordOf(row);
        return { row, record };
      });

    const answer = (mail: SessionMail, row: CloudSessionRow, record: WorkspaceRecord | undefined, payload: AnswerPayload) =>
      Effect.gen(function* () {
        const refuse = (message: string) =>
          say(row.sessionId, [sessionError(now(), "answer_refused", `ask ${payload.ask_id}: ${message}`)]).pipe(Effect.as("done" as Outcome));
        if (typeof payload?.ask_id !== "string" || payload.ask_id === "") return yield* refuse("an answer names its ask_id");
        // An automation's approval gate is its runner's to answer.
        if (payload.ask_id.startsWith("automation:") && automations !== undefined && (yield* automations.answer(payload.ask_id, payload))) return "done" as Outcome;
        if (record === undefined) return yield* refuse("no such ask in this session");
        const rows = yield* store.sql<{ event: string }>`SELECT event FROM caveman_sp_events
          WHERE session_id = ${record.session.id} AND type = 'ask.user' AND json_extract(event, '$.item_id') = ${payload.ask_id}`.pipe(Effect.orDie);
        const ask = rows[0] ? (JSON.parse(rows[0].event) as Extract<SessionEvent, { type: "ask.user" }>) : undefined;
        if (ask === undefined) return yield* refuse("no such ask in this session");
        // A secret in a deny's note holds back the note, never the deny: a refused answer would leave the agent waiting
        // on an ask its caller has already answered. The call is refused without the note, on every engine.
        const note = ask.payload.kind === "approval" && payload.decision === "deny" ? payload.message?.trim() : undefined;
        const checked = note ? yield* deps.checkInput(note).pipe(Effect.result) : undefined;
        const held = checked?._tag === "Failure" ? checked.failure : undefined;
        const { message: _note, ...withoutNote } = payload;
        const sent = held === undefined ? payload : withoutNote;
        const response = responseFor(ask.payload, sent);
        if (typeof response === "string") return yield* refuse(response);
        const done = yield* deps.respond(record.session.id, payload.ask_id, response, `mail:${mail.id}`).pipe(Effect.result);
        if (done._tag === "Failure") return yield* refuse(done.failure.message);
        if (held !== undefined) yield* say(row.sessionId, [sessionError(now(), "message_refused", `ask ${payload.ask_id}: the deny went through without its note. ${held.message}`)]);
        // A deny's note reaches the turn that asked, never a turn of its own after it: with the refusal where the engine
        // takes one (responseFor), else steered in.
        const steered = steeredNote(ask.payload, sent, response);
        if (steered !== undefined) yield* deps.steer(record, steered, `mail:${mail.id}:message`).pipe(Effect.ignore);
        return "done" as Outcome;
      });

    const act = (mail: SessionMail): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const payload = (mail.payload ?? null) as Record<string, unknown> | null;
        if (mail.verb === "task" && payload?.kind === "session_start") return yield* start(mail, payload as unknown as SessionStartPayload);
        const { row, record } = yield* sessionFor(mail);
        if (row === undefined) return mail.verb === "task" || mail.verb === "interrupt" || mail.verb === "answer" ? ("retry" as Outcome) : ("done" as Outcome);
        // An automation's session has no chat of its own: answers to its gates and a Stop reach its run.
        if (mail.verb === "answer" && record === undefined) return yield* answer(mail, row, undefined, (payload ?? {}) as unknown as AnswerPayload);
        if (mail.verb === "interrupt" && record === undefined) {
          const stopped = automations?.stop === undefined ? false : yield* automations.stop(row.sessionId);
          if (!stopped) yield* Effect.logInfo(`sessions: an interrupt for ${row.sessionId} found no run of it here to stop`);
          return "done" as Outcome;
        }
        if (record === undefined || record.workspace.status === "archived") return "done" as Outcome;
        switch (mail.verb) {
          case "task": {
            // Its user.message says the mail's id, which Cloud answered the caller's post with: the caller knows the turn
            // its message started, among turns it never sent.
            const item = submittedMessageId(record.session.id, `mail:${mail.id}`);
            yield* say(row.sessionId, (state) => {
              expectInput(state, item, mail.id);
              return [];
            });
            const sent = yield* deps.submit(record, mail.body, `mail:${mail.id}`).pipe(Effect.result);
            if (sent._tag === "Failure") {
              yield* say(row.sessionId, (state) => {
                delete state.inputs?.[item];
                return [sessionError(now(), "message_refused", sent.failure.message, mail.id)];
              });
            }
            return "done" as Outcome;
          }
          case "interrupt":
            yield* deps.interrupt(record.session.id, `mail:${mail.id}`).pipe(Effect.ignore);
            return "done" as Outcome;
          case "answer":
            return yield* answer(mail, row, record, (payload ?? {}) as unknown as AnswerPayload);
          default:
            yield* Effect.logWarning(`sessions: mail ${mail.id} has verb ${mail.verb}, which a session does not take`);
            return "done" as Outcome;
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`sessions: mail ${mail.id} (${mail.verb}) failed; it is taken again later`, cause).pipe(Effect.as("retry" as Outcome))),
      );

    /** Takes the session mail, acts on it in order, and acknowledges what was done. */
    const takeMail = Effect.gen(function* () {
      if (deps.linkIdentity() === undefined || deps.cloudLink.token === undefined) return;
      const taken = yield* cloudTry((identity) => takeSessionMail(identity, deps.cloudLink, fetchImpl)).pipe(Effect.orElseSucceed(() => ({ lease: null, messages: [] as Array<SessionMail> })));
      if (taken.lease === null || taken.messages.length === 0) return;
      const done: Array<string> = [];
      // In order: a session's start before its messages; a mail left for later holds back that session's next ones.
      const blocked = new Set<string>();
      for (const mail of taken.messages) {
        const key = mail.to_workspace_id ?? "";
        if (blocked.has(key)) continue;
        const outcome = yield* act(mail);
        if (outcome === "done") done.push(mail.id);
        else blocked.add(key);
      }
      if (done.length > 0) yield* cloudTry((identity) => ackSessionMail(identity, deps.cloudLink, taken.lease!, done, fetchImpl)).pipe(Effect.ignore);
    });

    // ------------------------------------------------------------ workspace state out

    /** Run state for Cloud's row, the pull request and the end, for every session Cloud started here. */
    const watchWorkspace = (workspace: Workspace) =>
      Effect.gen(function* () {
        const row = yield* outbox.byLocal(workspace.session_id);
        if (row === undefined) return;
        const state = RUN_STATE[workspace.status];
        if (state !== undefined && row.workspaceId !== "") yield* oweRunState(row.sessionId, state);
        if (!isOrgWorkload(row.origin)) return;
        const pr = pullRequestEvent(workspace, row.pullRequest);
        if (pr.event) yield* say(row.sessionId, [pr.event], { pullRequest: pr.key! });
        if (workspace.status === "archived") yield* say(row.sessionId, (s) => terminated(s, workspace.updated_at, s.status === "idle" ? "end_turn" : null));
        if (workspace.status === "failed" && row.state.status !== "terminated") {
          const record = yield* store.getBySession(row.localSessionId);
          const why = record?.internal.startFailed;
          if (why !== undefined) yield* say(row.sessionId, (s) => [sessionError(now(), "start_failed", why), ...terminated(s, workspace.updated_at, "error")]);
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`sessions: reporting ${workspace.id} failed`, cause)));

    // ------------------------------------------------------------ the loops

    const run = Effect.gen(function* () {
      // Events: whatever a session journals is mapped (forward reads from the store, so nothing is missed).
      const events = yield* PubSub.subscribe(store.events);
      yield* Effect.forever(
        PubSub.take(events).pipe(
          Effect.tap((event) => Effect.sync(() => void (event.type === "usage" && (meterDue = true)))),
          Effect.flatMap((event) =>
            outbox.byLocal(event.session_id).pipe(
              Effect.flatMap((row) => (row === undefined || !isOrgWorkload(row.origin) ? Effect.void : forward(row.sessionId))),
            ),
          ),
          Effect.catchCause((cause) => Effect.logWarning("sessions: mapping events failed", cause)),
        ),
      ).pipe(Effect.forkIn(deps.scope));
      const changes = yield* PubSub.subscribe(store.workspaceChanges);
      yield* Effect.forever(PubSub.take(changes).pipe(Effect.flatMap(watchWorkspace))).pipe(Effect.forkIn(deps.scope));
      // Catch up after a restart: what was journaled while nothing mapped it, and what never got to Cloud (events,
      // run states owed, usage).
      for (const row of yield* outbox.all) {
        owing.add(row.sessionId);
        if (isOrgWorkload(row.origin)) yield* forward(row.sessionId).pipe(Effect.ignore);
      }
      yield* Effect.forever(
        Effect.race(Queue.take(wake), Effect.sleep(`${SEND_TICK_MS * 4} millis`)).pipe(
          Effect.andThen(Effect.sleep(`${SEND_TICK_MS} millis`)),
          Effect.andThen(flush),
          Effect.catchCause((cause) => Effect.logWarning("sessions: sending events failed", cause)),
        ),
      ).pipe(Effect.forkIn(deps.scope));
      // Mail: only a Cloud computer holds sessions Cloud started. Taken, then Cloud's long wait until there is more (an
      // answer of none sooner than a second is held for the rest of it, waitComputerMail).
      if (deps.cloud === undefined) return;
      let longWait = true;
      const waitMail = Effect.gen(function* () {
        const identity = deps.linkIdentity();
        if (!longWait || identity === undefined || deps.cloudLink.token === undefined) return yield* Effect.sleep(`${MAIL_FALLBACK_MS} millis`);
        yield* Effect.tryPromise({ try: () => waitComputerMail(identity, deps.cloudLink, SESSION_CHANNEL, MAIL_WAIT_MS, fetchImpl), catch: (error) => error }).pipe(
          Effect.catch((error) =>
            error instanceof CloudError && (error.status === 400 || error.status === 404) ? Effect.sync(() => void (longWait = false)) : Effect.sleep(`${MAIL_FALLBACK_MS} millis`),
          ),
        );
      });
      yield* Effect.forever(
        takeMail.pipe(
          Effect.catchCause((cause) => Effect.logWarning("sessions: a mail pass failed", cause)),
          Effect.andThen(waitMail),
        ),
      );
    });

    return { run, emit };
  });
