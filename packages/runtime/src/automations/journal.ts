// The runs' journal in the runtime's SQLite (migration 063): a row per run (what it was admitted with, and
// a cache of its status for listing) and an append-only list of its events, the SEMANTICS §11.1 records.
// A run's state is the fold of its events through the machine (machine.ts replay); the run record the
// Session Protocol serves (SEMANTICS §12) is drawn from that state and the row.
import type { AutomationRunRecord, AutomationRunSummary } from "@caveman-app/session-protocol/protocol";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Wallet } from "./budget.ts";
import { NO_COST, attemptId, type Cost, type RunEvent, type RunState, type RunStatus } from "./machine.ts";
import type { Revision, TriggerEvent } from "./services.ts";
import type { StepMarker } from "./steps.ts";

export interface RunRow {
  readonly runId: string;
  readonly automationId: string;
  readonly automation: string;
  readonly projectId: string;
  readonly subject: string;
  readonly concurrencyKey: string;
  readonly revision: Revision;
  readonly trigger: TriggerEvent;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly apply: boolean;
  readonly status: RunStatus;
  readonly reason: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly wallet: Wallet;
  readonly spent: Cost;
  readonly steps: ReadonlyArray<{ readonly name: string; readonly status: string; readonly decision?: string }>;
  readonly branch: string | null;
  readonly head: string | null;
  readonly worktree: string | null;
  /**
   * Where the run started: the default branch and its commit then (a pull request's base), or a pull request's
   * head (F-6), with the pull request it came from.
   */
  readonly base: RunBase | null;
  /** Milliseconds of work the run has used of its deadline (§10.2): a restart goes on from them. */
  readonly workedMs: number;
}

export interface RunBase {
  readonly branch: string;
  readonly sha: string;
  /** A pull request subject: its number, its head and base as fetched, and whether the head is in this repository. */
  readonly pr?: { readonly number: number; readonly head: string; readonly baseBranch?: string; readonly baseSha?: string; readonly sameRepo: boolean };
}

interface Row {
  run_id: string;
  automation_id: string;
  automation: string;
  project_id: string;
  subject: string;
  concurrency_key: string;
  revision_json: string;
  trigger_json: string;
  inputs_json: string | null;
  apply: number;
  status: string;
  reason: string | null;
  started_at: string;
  ended_at: string | null;
  wallet_json: string;
  spent_json: string | null;
  steps_json: string;
  branch: string | null;
  head: string | null;
  worktree: string | null;
  base_json: string | null;
  worked_ms: number;
}

const fromRow = (row: Row): RunRow => ({
  runId: row.run_id,
  automationId: row.automation_id,
  automation: row.automation,
  projectId: row.project_id,
  subject: row.subject,
  concurrencyKey: row.concurrency_key,
  revision: JSON.parse(row.revision_json) as Revision,
  trigger: JSON.parse(row.trigger_json) as TriggerEvent,
  ...(row.inputs_json === null ? {} : { inputs: JSON.parse(row.inputs_json) as Record<string, string> }),
  apply: row.apply === 1,
  status: row.status as RunStatus,
  reason: row.reason,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  wallet: JSON.parse(row.wallet_json) as Wallet,
  spent: row.spent_json === null ? NO_COST : (JSON.parse(row.spent_json) as Cost),
  steps: JSON.parse(row.steps_json) as RunRow["steps"],
  branch: row.branch,
  head: row.head,
  worktree: row.worktree,
  base: row.base_json === null ? null : (JSON.parse(row.base_json) as RunRow["base"]),
  workedMs: row.worked_ms,
});

export type Journal = Effect.Success<typeof makeJournal>;

export const makeJournal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const die = Effect.orDie;

  /** A run and its first event; a run that never started (a skipped schedule tick) has none. */
  const insert = (run: RunRow, first?: RunEvent) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO automation_runs (run_id, automation_id, automation, project_id, subject, concurrency_key, revision_digest, revision_json,
              trigger_json, inputs_json, apply, status, reason, started_at, ended_at, wallet_json, spent_json, steps_json, branch, head, worktree, base_json)
            VALUES (${run.runId}, ${run.automationId}, ${run.automation}, ${run.projectId}, ${run.subject}, ${run.concurrencyKey}, ${run.revision.digest},
              ${JSON.stringify(run.revision)}, ${JSON.stringify(run.trigger)}, ${run.inputs === undefined ? null : JSON.stringify(run.inputs)}, ${run.apply ? 1 : 0},
              ${run.status}, ${run.reason}, ${run.startedAt}, ${run.endedAt}, ${JSON.stringify(run.wallet)}, ${JSON.stringify(run.spent)},
              ${JSON.stringify(run.steps)}, ${run.branch}, ${run.head}, ${run.worktree}, ${run.base === null ? null : JSON.stringify(run.base)})`;
          if (first !== undefined) {
            yield* sql`INSERT INTO automation_run_events (run_id, seq, type, payload, at) VALUES (${run.runId}, 1, ${first.type}, ${JSON.stringify(first)}, ${first.at})`;
          }
        }),
      )
      .pipe(die);

  /** One event and the row's cached status in one transaction; `seq` is the next free one. */
  const append = (runId: string, event: RunEvent, state: RunState) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [last] = yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM automation_run_events WHERE run_id = ${runId}`;
          yield* sql`INSERT INTO automation_run_events (run_id, seq, type, payload, at) VALUES (${runId}, ${(last?.seq ?? 0) + 1}, ${event.type}, ${JSON.stringify(event)}, ${event.at})`;
          yield* sql`UPDATE automation_runs SET status = ${state.status}, reason = ${state.reason}, ended_at = ${state.endedAt},
              steps_json = ${JSON.stringify(state.steps.map((s) => ({ name: s.name, status: s.status, ...(s.decision === undefined ? {} : { decision: s.decision }) })))} WHERE run_id = ${runId}`;
        }),
      )
      .pipe(die);

  const events = (runId: string) =>
    sql<{ payload: string }>`SELECT payload FROM automation_run_events WHERE run_id = ${runId} ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map((r) => JSON.parse(r.payload) as RunEvent)),
      die,
    );

  const get = (runId: string) =>
    sql<Row>`SELECT * FROM automation_runs WHERE run_id = ${runId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : fromRow(rows[0]))),
      die,
    );

  const update = (
    runId: string,
    patch: {
      readonly branch?: string;
      readonly head?: string | null;
      readonly worktree?: string;
      readonly spent?: Cost;
      readonly base?: RunRow["base"];
      readonly workedMs?: number;
    },
  ) =>
    Effect.gen(function* () {
      if (patch.branch !== undefined) yield* sql`UPDATE automation_runs SET branch = ${patch.branch} WHERE run_id = ${runId}`;
      if (patch.head !== undefined) yield* sql`UPDATE automation_runs SET head = ${patch.head} WHERE run_id = ${runId}`;
      if (patch.worktree !== undefined) yield* sql`UPDATE automation_runs SET worktree = ${patch.worktree} WHERE run_id = ${runId}`;
      if (patch.spent !== undefined) yield* sql`UPDATE automation_runs SET spent_json = ${JSON.stringify(patch.spent)} WHERE run_id = ${runId}`;
      if (patch.base !== undefined) yield* sql`UPDATE automation_runs SET base_json = ${patch.base === null ? null : JSON.stringify(patch.base)} WHERE run_id = ${runId}`;
      if (patch.workedMs !== undefined) yield* sql`UPDATE automation_runs SET worked_ms = ${patch.workedMs} WHERE run_id = ${runId}`;
    }).pipe(die);

  /** Newest first. `live`: every run still going, with no limit (a negative LIMIT is none in SQLite). */
  const list = (filter: { readonly projectId?: string; readonly automationId?: string; readonly automation?: string; readonly status?: RunStatus; readonly agentRuns?: boolean; readonly live?: boolean; readonly limit?: number }) =>
    sql<Row>`SELECT * FROM automation_runs
      WHERE (${filter.projectId ?? null} IS NULL OR project_id = ${filter.projectId ?? null})
        AND (${filter.automationId ?? null} IS NULL OR automation_id = ${filter.automationId ?? null})
        AND (${filter.automation ?? null} IS NULL OR automation = ${filter.automation ?? null})
        AND (${filter.status ?? null} IS NULL OR status = ${filter.status ?? null})
        AND (${filter.agentRuns === true ? 1 : 0} = 0 OR automation_id LIKE 'agent:%')
        AND (${filter.live === true ? 1 : 0} = 0 OR status IN ('queued', 'running', 'waiting'))
      ORDER BY started_at DESC, run_id DESC LIMIT ${filter.live === true ? -1 : (filter.limit ?? 50)}`.pipe(Effect.map((rows) => rows.map(fromRow)), die);

  /** The newest succeeded run of an automation on a subject before `runId`, with a base: what a rerun builds on. */
  const lastSucceeded = (filter: { readonly automationId: string; readonly subject: string; readonly runId: string }) =>
    sql<Row>`SELECT * FROM automation_runs
      WHERE automation_id = ${filter.automationId} AND subject = ${filter.subject} AND status = 'succeeded' AND run_id != ${filter.runId} AND base_json IS NOT NULL
      ORDER BY started_at DESC, run_id DESC LIMIT 1`.pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : fromRow(rows[0]))), die);

  /** A run that never started (queued, then replaced or stopped): its row's status, with no events. */
  const settleQueued = (runId: string, patch: { readonly status: RunStatus; readonly reason: string; readonly endedAt: string; readonly steps: RunRow["steps"] }) =>
    sql`UPDATE automation_runs SET status = ${patch.status}, reason = ${patch.reason}, ended_at = ${patch.endedAt}, steps_json = ${JSON.stringify(patch.steps)} WHERE run_id = ${runId}`.pipe(die);

  /** Runs whose worktree is still on disk, oldest first (K2). */
  const withWorktrees = sql<Row>`SELECT * FROM automation_runs WHERE worktree IS NOT NULL ORDER BY started_at`.pipe(Effect.map((rows) => rows.map(fromRow)), die);

  /** The run's worktree is gone (K2): the row forgets it. */
  const forgetWorktree = (runId: string) => sql`UPDATE automation_runs SET worktree = NULL WHERE run_id = ${runId}`.pipe(die);

  /**
   * Runs a restart left unfinished: going, or ended with no run_finished yet. `append` writes the terminal status with
   * the event that ended the run, so a runtime that stopped before its finish ran leaves an ended row still owed one.
   */
  const live = sql<Row>`SELECT * FROM automation_runs r WHERE r.status IN ('queued', 'running', 'waiting')
      OR (EXISTS (SELECT 1 FROM automation_run_events e WHERE e.run_id = r.run_id)
        AND NOT EXISTS (SELECT 1 FROM automation_run_events e WHERE e.run_id = r.run_id AND e.type = 'run_finished'))
    ORDER BY r.started_at`.pipe(
    Effect.map((rows) => rows.map(fromRow)),
    die,
  );

  const register = (threadId: string, marker: StepMarker) =>
    sql`INSERT OR REPLACE INTO automation_run_threads (thread_id, run_id, automation, step, attempt, check_index)
      VALUES (${threadId}, ${marker.run}, ${marker.automation}, ${marker.step}, ${marker.attempt}, ${marker.check ?? null})`.pipe(die);

  return { insert, append, events, get, update, list, lastSucceeded, live, register, settleQueued, withWorktrees, forgetWorktree };
});

/** What the projector stores on a step thread's workspace (session-protocol/daemon.ts adoptAutomationRun). */
export const threadMarker = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ run_id: string; automation: string; step: string; attempt: number; check_index: number | null }>`SELECT run_id, automation, step, attempt, check_index
      FROM automation_run_threads WHERE thread_id = ${threadId}`;
    const row = rows[0];
    if (row === undefined) return undefined;
    return { automation: row.automation, run: row.run_id, step: row.step, attempt: row.attempt, ...(row.check_index === null ? {} : { check: row.check_index }) } satisfies StepMarker;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** The record's registry stamp: the format and class table this runtime runs (SEMANTICS §12). */
export const REGISTRY = "2026-10-19";

const revisionLabel = (digest: string) => (digest.startsWith("sha256:") ? digest : `sha256:${digest}`);

/** SEMANTICS §12, in the Session Protocol's shape. `workspaces`: the workspace each thread was adopted as. */
export function recordOf(row: RunRow, state: RunState | undefined, workspaces: ReadonlyMap<string, string> = new Map(), environment: "this-mac" | "cloud" = "this-mac"): AutomationRunRecord {
  const workspaceOf = (threadId: string | undefined) => {
    const id = threadId === undefined ? undefined : workspaces.get(threadId);
    return id === undefined ? {} : { workspace_id: id };
  };
  const steps = state?.steps ?? [];
  const spent = steps.reduce((sum, s) => sum + s.attempts.reduce((a, t) => a + t.cost.usd, 0), 0);
  return {
    run: row.runId,
    automation: row.automation,
    automation_id: row.automationId,
    project_id: row.projectId,
    revision: revisionLabel(row.revision.digest),
    trigger: {
      kind: row.trigger.kind,
      ...(row.trigger.event === undefined ? {} : { event: row.trigger.event }),
      subject: row.trigger.subject,
      ...(row.trigger.subjectTitle === undefined ? {} : { subject_title: row.trigger.subjectTitle }),
      ...(row.trigger.subjectUrl === undefined ? {} : { subject_url: row.trigger.subjectUrl }),
      ...(row.trigger.delivery === undefined ? {} : { delivery: row.trigger.delivery }),
      received_at: row.trigger.receivedAt,
    },
    concurrency_key: row.concurrencyKey,
    status: state?.status ?? row.status,
    reason: (state?.reason ?? row.reason) as AutomationRunRecord["reason"],
    started_at: row.startedAt,
    ended_at: state?.endedAt ?? row.endedAt,
    environment,
    population: "agent",
    registry: REGISTRY,
    budget: { limit_usd: row.wallet.usd ?? null, spent_usd: Math.max(spent, row.spent.usd), label: "measured" },
    workspace: { computer: environment === "cloud" ? "caveman-cloud" : "this-mac", branch: row.branch ?? "", head: row.head },
    steps: steps.map((s) => ({
      name: s.name,
      status: s.status,
      reason: s.reason,
      ...(s.decision === undefined ? {} : { decision: s.decision }),
      ...((s.status === "succeeded" || s.status === "waiting") && s.result !== undefined ? { summary: s.result.summary } : {}),
      ...((): { needs?: string[] } => {
        const needs = state?.plan.steps.find((p) => p.name === s.name)?.needs;
        return needs === undefined ? {} : { needs: [...needs] };
      })(),
      ...(s.waitingUntil === undefined ? {} : { waiting_until: s.waitingUntil }),
      ...(s.approval === undefined
        ? {}
        : {
            approval: {
              by: s.approval.by,
              asked_at: s.approval.askedAt,
              expires_at: s.approval.expiresAt,
              ...(s.approval.decision === undefined ? {} : { decision: s.approval.decision }),
              ...(s.approval.decidedBy === undefined ? {} : { decided_by: s.approval.decidedBy }),
              ...(s.approval.decidedAt === undefined ? {} : { decided_at: s.approval.decidedAt }),
              ...(s.approval.message === undefined ? {} : { message: s.approval.message }),
              ...(s.approval.before === true ? { before_run: true } : {}),
            },
          }),
      // SECURITY M1: the run added the owner's approval before this step, because its trigger text is untrusted.
      ...(state?.plan.steps.find((p) => p.name === s.name)?.gate === undefined ? {} : { untrusted_trigger: true }),
      ...(s.chosen === undefined ? {} : { chosen: s.chosen }),
      ...(s.pickNote === undefined ? {} : { pick_note: s.pickNote }),
      attempts: s.attempts.map((a) => ({
        n: a.n,
        id: attemptId(row.runId, s.name, a.n),
        status: a.status,
        reason: a.reason,
        ...(a.engine === undefined ? {} : { engine: a.engine }),
        model: a.model,
        ...(a.effort === undefined ? {} : { effort: a.effort }),
        computer: a.computer,
        started_at: a.startedAt,
        ended_at: a.endedAt,
        cost: {
          usd: a.cost.usd,
          input: a.cost.input,
          output: a.cost.output,
          cache_read: a.cost.cache_read,
          cache_write: a.cost.cache_write,
          label: "measured",
          billing: a.cost.billing,
        },
        checks: a.checks.map((c) => ({
          check: c.check,
          ...(c.exit === undefined ? {} : { exit: c.exit }),
          ...(c.ms === undefined ? {} : { ms: c.ms }),
          ...(c.decision === undefined ? {} : { decision: c.decision }),
          ...(c.text === undefined ? {} : { output_tail_ref: `${attemptId(row.runId, s.name, a.n)}.check.${c.index}` }),
          ...(c.text === undefined || c.passed ? {} : { text: c.text }),
          // An agent check's summary, whatever it decided (B4).
          ...(c.kind === "agent" && c.text !== undefined ? { summary: c.text } : {}),
          ...workspaceOf(c.threadId),
        })),
        ...(a.result === undefined ? {} : { result_ref: `${attemptId(row.runId, s.name, a.n)}.result` }),
        sha: a.sha,
        ...(a.threadId === undefined ? {} : { thread_id: a.threadId }),
        ...workspaceOf(a.threadId),
        ...(a.message === undefined ? {} : { message: a.message }),
        ...(a.candidate === undefined ? {} : { candidate: a.candidate }),
        ...(a.grade === undefined ? {} : { grade: { satisfied: a.grade.satisfied, text: a.grade.text, ...workspaceOf(a.grade.threadId) } }),
      })),
    })),
    outputs: (state?.outputs ?? []).map((o) => ({
      kind: o.kind,
      key: o.key,
      status: o.status,
      ...(o.url === undefined ? {} : { url: o.url }),
      ...(o.preview === undefined ? {} : { preview: o.preview }),
      ...(o.error === undefined ? {} : { error: o.error }),
    })),
  };
}

export function summaryOf(row: RunRow): AutomationRunSummary {
  return {
    run_id: row.runId,
    automation_id: row.automationId,
    automation: row.automation,
    project_id: row.projectId,
    status: row.status,
    reason: row.reason as AutomationRunSummary["reason"],
    trigger: {
      kind: row.trigger.kind,
      subject: row.trigger.subject,
      ...(row.trigger.subjectTitle === undefined ? {} : { subject_title: row.trigger.subjectTitle }),
    },
    started_at: row.startedAt,
    ended_at: row.endedAt,
    spent_usd: row.spent.usd,
    steps: row.steps.map((s) => ({
      name: s.name,
      status: s.status as AutomationRunSummary["steps"][number]["status"],
      ...(s.decision === undefined ? {} : { decision: s.decision }),
    })),
  };
}

/** A hosted run's record as Cloud's POST /runtime/runs takes it. */
export interface CloudRunRecordBody {
  readonly session_id: string;
  readonly automation_id: string;
  readonly record: Record<string, unknown>;
}

/** The records a Cloud computer still owes Cloud (CORRECTNESS H2): durable until Cloud takes each one. */
export interface CloudRecords {
  readonly owe: (runId: string, body: CloudRunRecordBody) => Effect.Effect<void>;
  readonly sent: (runId: string) => Effect.Effect<void>;
  readonly tried: (runId: string, error: string) => Effect.Effect<void>;
  readonly owed: Effect.Effect<ReadonlyArray<{ readonly runId: string; readonly body: CloudRunRecordBody; readonly tries: number }>>;
}

export const makeCloudRecords = (sql: SqlClient.SqlClient): CloudRecords => ({
  owe: (runId, body) =>
    sql`INSERT INTO automation_cloud_records (run_id, session_id, body_json, owed_at) VALUES (${runId}, ${body.session_id}, ${JSON.stringify(body)}, ${new Date().toISOString()})
        ON CONFLICT (run_id) DO UPDATE SET body_json = excluded.body_json`.pipe(Effect.asVoid, Effect.orDie),
  sent: (runId) => sql`DELETE FROM automation_cloud_records WHERE run_id = ${runId}`.pipe(Effect.asVoid, Effect.orDie),
  tried: (runId, error) => sql`UPDATE automation_cloud_records SET tries = tries + 1, last_error = ${error.slice(0, 500)} WHERE run_id = ${runId}`.pipe(Effect.asVoid, Effect.orDie),
  owed: sql<{ run_id: string; body_json: string; tries: number }>`SELECT run_id, body_json, tries FROM automation_cloud_records ORDER BY owed_at`.pipe(
    Effect.map((rows) => rows.map((r) => ({ runId: r.run_id, body: JSON.parse(r.body_json) as CloudRunRecordBody, tries: r.tries }))),
    Effect.orDie,
  ),
});
