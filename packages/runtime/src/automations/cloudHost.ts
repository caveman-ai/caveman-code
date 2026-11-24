// The Cloud host (CONTRACT §5, §7, §9 A2): on a Cloud computer, a session Caveman Cloud started for an automation run
// (`session_start` with `automation` set) runs the automation's interpreter, not a chat. The revision is fetched by
// id, checked by the same `check` as everywhere (a bad file fails the run with result_invalid), and admitted to the
// runner with Cloud's run id. While it runs, each step's moves go out as `automation.step` events, an approval gate
// as `requires_action`, Slack, Linear and Jira outputs through Cloud's outputs route, and when it ends, one run
// record (SEMANTICS §12) to Cloud's runs route, owed in the journal until Cloud takes it. The trigger's event is the
// run's data, never its instructions. A restarted runtime finds its hosted runs again by the session outbox, so they
// keep speaking, posting and stopping; the computer reads busy only while a run works, and a timer asks Cloud to wake
// it at its deadline.
import { hostOf, type ParsedAgent, type SourceFile } from "@caveman-app/automations";
import type { AutomationRunRecord } from "@caveman-app/session-protocol/protocol";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { stepSpan, type OtlpSpan } from "../cloudLink/traces.ts";
import { blockingErrors, checkSources, revisionFrom } from "./files.ts";
import { REGISTRY, recordOf, type CloudRecords, type CloudRunRecordBody, type RunRow } from "./journal.ts";
import { approvalAskId, isTerminal, type RunEvent, type RunState } from "./machine.ts";
import { CloudError } from "../cloudLink/identity.ts";
import { OutputError } from "./outputs.ts";
import type { AutomationRunner, TriggerEvent } from "./services.ts";

/** One §3.4 public event, as the session's outbox takes it. */
export interface HostEvent {
  readonly type: string;
  readonly created_at: string;
  readonly data: Record<string, unknown>;
}

/** What `session_start` names when Cloud fired an automation (CONTRACT §3.2; headless.ts CloudAutomationStart). */
export interface CloudAutomationStart {
  readonly sessionId: string;
  /** The Session Protocol project whose checkout is this computer's repository. */
  readonly projectId: string;
  readonly automation: {
    readonly automation_id: string;
    readonly revision_id: string;
    readonly run_id: string;
    readonly trigger: string;
    readonly event?: unknown;
    /** What the run is about, as Cloud verified it (`github:<repo>#<n>`, `github:<repo>@<branch>`): its concurrency key's half. */
    readonly subject?: string;
  };
  /** Says one public event of the session through its outbox; a `session.status` also moves Cloud's row. */
  readonly emit: (type: string, data: Record<string, unknown>) => Effect.Effect<void>;
}

export interface CloudHostDeps {
  readonly runner: AutomationRunner["Service"];
  /** One `/api/v1/code/runtime/<path>` call with this computer's runtime token. */
  readonly call: <A>(method: "GET" | "POST" | "PUT", path: string, body?: unknown) => Effect.Effect<A, unknown>;
  /** The agents any file can name here: the built-ins and the computer's own. */
  readonly registry: Effect.Effect<ReadonlyArray<ParsedAgent>>;
  readonly now?: () => string;
  /** How often a revision read is tried before the run fails (Cloud may be briefly away). */
  readonly fetchTries?: number;
  /**
   * Pushes the checked commit to its caveman/* branch through Caveman Cloud's git proxy (from the tools container's
   * checkout through the runtime's mirror, CORRECTNESS C1). Absent: a pull request output fails, saying so. It returns
   * the branch it pushed: `branch`, or `<branch>-cloud` when the proxy lets `branch` only fast-forward.
   */
  readonly push?: (input: { readonly root: string; readonly branch: string; readonly sha: string }) => Effect.Effect<string, { readonly message: string }>;
  /** Before a run starts: this computer's checkout as the run's project. Failing, the run fails start_failed. */
  readonly prepare?: (input: CloudAutomationStart) => Effect.Effect<void, { readonly message: string }>;
  /** The automation sessions Cloud started here (the session outbox): a restart finds its runs again by them (H1). */
  readonly sessions?: Effect.Effect<ReadonlyArray<HostedSession>>;
  /** The project a restarted session's run goes in, when its start never reached the runner (L7). */
  readonly projectId?: Effect.Effect<string | undefined>;
  /** Records owed to Cloud, durable (the journal's automation_cloud_records); absent, kept in memory. */
  readonly records?: CloudRecords;
  /** A run record's tries: a first wait, doubling, this many times; then it waits for the next start of the runtime. */
  readonly recordRetry?: { readonly base: Duration.Input; readonly times: number };
  /** One span into the session's trace outbox (M7). */
  readonly span?: (sessionId: string, span: OtlpSpan) => Effect.Effect<void>;
}

/** An automation session Cloud started on this computer, as the session outbox keeps it. */
export interface HostedSession {
  readonly sessionId: string;
  /** Cloud's workspace: its run state, and the wake-ups a timer asks for. */
  readonly workspaceId: string;
  readonly automation: CloudAutomationStart["automation"];
  /** Its last public status: `terminated` means it ended. */
  readonly status?: string | undefined;
}

/** A Cloud call worth trying again: no answer at all, or a 429 or 5xx. */
export const retryableCall = (error: unknown): boolean => !(error instanceof CloudError) || error.status === 429 || error.status >= 500;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : typeof value === "number" ? String(value) : undefined);

/** The headless sessions' CloudAutomations service (session-protocol/headless.ts), served by the interpreter. */
export interface CloudHost {
  /** Runs the automation the session names; a revision that does not check fails the run with result_invalid. */
  readonly start: (input: CloudAutomationStart) => Effect.Effect<void, { readonly message: string }>;
  /**
   * An `answer` mail for an approval gate (`automation:<run>:<step>`): only a `user.approval` with a decision (allow
   * or deny) answers it; anything else is not ours to act on (false), so headless.ts refuses it (CORRECTNESS M3).
   */
  readonly answer: (askId: string, answer: { readonly kind?: string; readonly decision?: string; readonly message?: string }) => Effect.Effect<boolean>;
  /** A Stop (`interrupt` mail, or Cloud superseding the run) for a session this host runs: its run is cancelled. */
  readonly stop: (sessionId: string) => Effect.Effect<boolean>;
  /**
   * Once the session outbox is up (headless.ts): how any hosted session speaks. Then what a restart left is taken up:
   * owed records go again, runs left going speak again, and a session whose run never started starts.
   */
  readonly attach: (emitTo: (sessionId: string, type: string, data: Record<string, unknown>) => Effect.Effect<void>) => Effect.Effect<void>;
  /** A hosted run is working (a step, a check, a command, an output), not waiting at a gate or a timer: the computer stays up. */
  readonly working: () => boolean;
}

const TRIGGER_KINDS = new Set<TriggerEvent["kind"]>(["manual", "schedule", "github", "webhook", "slack", "linear", "jira"]);
const pick = (value: unknown, ...keys: string[]): string | undefined => {
  let at: unknown = value;
  for (const key of keys) at = at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
  return typeof at === "string" && at !== "" ? at : typeof at === "number" ? String(at) : undefined;
};

/**
 * Cloud's trigger (`github.issues.labeled`, `slack.app_mention`, `schedule`) as the runner's: what the run is about
 * (its subject, the concurrency key's half) and the event as data. A Cloud computer is isolated, so the text of an
 * outsider's event may reach its steps (SEMANTICS §13 rule 3), but it is trusted only when Cloud says so (`trusted:
 * true`, a GitHub author in the actors' set): Slack, Linear, Jira and webhook text never is, and a step that can
 * write then waits for the owner's approval before it runs (SECURITY M1). A schedule or a run by hand has no text.
 */
export function triggerFrom(input: {
  readonly trigger: string;
  readonly event: unknown;
  readonly runId: string;
  readonly automation: string;
  readonly receivedAt: string;
  /** Cloud's own subject (CORRECTNESS M2): it wins, so Cloud's runs and this computer's branches agree. */
  readonly subject?: string | undefined;
}): TriggerEvent {
  const [source = "", ...rest] = input.trigger.split(".");
  const kind: TriggerEvent["kind"] = TRIGGER_KINDS.has(source as TriggerEvent["kind"]) ? (source as TriggerEvent["kind"]) : "webhook";
  const event = rest.length > 0 ? rest.join(".") : undefined;
  const e = input.event;
  const derived = (() => {
    switch (kind) {
      case "github": {
        // C3's event keys first (repo, push.after, workflow_run.head_sha), then GitHub's own.
        const repo = pick(e, "repo") ?? pick(e, "repository", "full_name");
        const n = pick(e, "issue", "number") ?? pick(e, "pull_request", "number") ?? pick(e, "number");
        const sha = pick(e, "push", "after") ?? pick(e, "workflow_run", "head_sha") ?? pick(e, "check_suite", "head_sha") ?? pick(e, "after");
        if (repo === undefined) return `github:${input.runId}`;
        return n !== undefined ? `github:${repo}#${n}` : sha !== undefined ? `github:${repo}@${sha}` : `github:${repo}`;
      }
      case "slack": {
        const channel = pick(e, "channel") ?? pick(e, "event", "channel");
        const thread = pick(e, "thread_ts") ?? pick(e, "event", "thread_ts") ?? pick(e, "ts") ?? pick(e, "event", "ts");
        return channel === undefined ? `slack:${input.runId}` : `slack:${channel}/${thread ?? ""}`;
      }
      case "linear":
        return `linear:${pick(e, "issue", "id") ?? pick(e, "issue_id") ?? pick(e, "data", "id") ?? input.runId}`;
      case "jira":
        return `jira:${pick(e, "issue", "key") ?? pick(e, "issue_key") ?? input.runId}`;
      case "schedule":
        return `schedule:${input.automation}`;
      case "manual":
        return `manual:${input.runId}`;
      default:
        return `webhook:${input.runId}`;
    }
  })();
  const subject = input.subject !== undefined && input.subject !== "" ? input.subject : derived;
  const title = pick(e, "issue", "title") ?? pick(e, "pull_request", "title") ?? pick(e, "title");
  const url = pick(e, "issue", "url") ?? pick(e, "issue", "html_url") ?? pick(e, "pull_request", "url") ?? pick(e, "pull_request", "html_url") ?? pick(e, "url");
  return {
    kind,
    ...(event === undefined ? {} : { event }),
    subject,
    delivery: input.runId,
    ...(e === undefined || e === null ? {} : { payload: e }),
    ...(title === undefined ? {} : { subjectTitle: title }),
    ...(url === undefined ? {} : { subjectUrl: url }),
    trusted: kind === "schedule" || kind === "manual" || (kind === "github" && e !== null && typeof e === "object" && (e as { trusted?: unknown }).trusted === true),
    receivedAt: input.receivedAt,
  };
}

/** The ask an approval gate travels under, back to its run and step. */
export function approvalOf(askId: string): { readonly runId: string; readonly step: string } | undefined {
  const match = /^automation:([^:]+):(.+)$/.exec(askId);
  return match === null ? undefined : { runId: match[1]!, step: match[2]! };
}

/** The `automation.step` events a transition owes: every attempt whose status moved since the last one said. */
export function stepEvents(state: RunState, said: Map<string, string>, at: string): HostEvent[] {
  const out: HostEvent[] = [];
  for (const step of state.steps) {
    // SECURITY M1: the step waits for the owner first because the run's trigger text is untrusted.
    const untrusted = state.plan.steps.find((p) => p.name === step.name)?.gate === undefined ? {} : { untrusted_trigger: true };
    for (const attempt of step.attempts) {
      const key = `${step.name}.${attempt.n}`;
      const status = attempt.status === "succeeded" && step.status === "waiting" ? "waiting" : attempt.status;
      if (said.get(key) === status) continue;
      said.set(key, status);
      out.push({
        type: "automation.step",
        created_at: at,
        data: {
          run_id: state.run,
          step: step.name,
          attempt: attempt.n,
          status,
          engine: attempt.engine ?? null,
          model: attempt.model.resolved,
          ...(attempt.reason === null ? {} : { reason: attempt.reason }),
          ...(step.decision === undefined || attempt.status !== "succeeded" ? {} : { decision: step.decision }),
          ...untrusted,
        },
      });
    }
    // A wait step, or a step held for the owner before it runs, has no attempts: its timer or its gate is its move.
    if (step.attempts.length === 0 && (step.status === "waiting" || step.status === "succeeded" || step.status === "skipped" || step.status === "failed")) {
      const key = `${step.name}.0`;
      if (said.get(key) === step.status) continue;
      said.set(key, step.status);
      out.push({
        type: "automation.step",
        created_at: at,
        data: { run_id: state.run, step: step.name, attempt: 0, status: step.status, engine: null, model: null, ...(step.reason === null ? {} : { reason: step.reason }), ...untrusted },
      });
    }
  }
  return out;
}

/** The record of a run whose revision never checked: no step ran, and it says why. */
function failedRecord(input: {
  readonly start: Pick<CloudAutomationStart, "automation">;
  readonly name: string;
  readonly trigger: TriggerEvent;
  readonly digest: string;
  readonly at: string;
  readonly reason: NonNullable<AutomationRunRecord["reason"]>;
}): AutomationRunRecord {
  return {
    run: input.start.automation.run_id,
    automation: input.name,
    automation_id: input.start.automation.automation_id,
    revision: input.digest === "" ? "" : input.digest.startsWith("sha256:") ? input.digest : `sha256:${input.digest}`,
    trigger: {
      kind: input.trigger.kind,
      ...(input.trigger.event === undefined ? {} : { event: input.trigger.event }),
      subject: input.trigger.subject,
      delivery: input.start.automation.run_id,
      received_at: input.trigger.receivedAt,
    },
    concurrency_key: `${input.name}:${input.trigger.subject}`,
    status: "failed",
    reason: input.reason,
    started_at: input.at,
    ended_at: input.at,
    environment: "cloud",
    population: "agent",
    registry: REGISTRY,
    budget: { limit_usd: null, spent_usd: 0, label: "measured" },
    workspace: { computer: "caveman-cloud", branch: "", head: null },
    steps: [],
    outputs: [],
  };
}

export const makeCloudHost = (deps: CloudHostDeps) =>
  Effect.gen(function* () {
    const now = deps.now ?? (() => new Date().toISOString());
    type Emit = (sessionId: string, type: string, data: Record<string, unknown>) => Effect.Effect<void>;
    interface Hosted {
      readonly sessionId: string;
      readonly workspaceId?: string | undefined;
      readonly automationId: string;
      readonly emit: CloudAutomationStart["emit"];
      /** What each attempt last said (automation.step), the gates asked, the session status said, the wake-up asked for. */
      readonly said: Map<string, string>;
      readonly asked: Set<string>;
      readonly spanned: Set<string>;
      status?: string;
      wakeAt?: string | null;
      /** Something of the run works now (status running): the computer must stay up. */
      working: boolean;
    }
    /** Runs this computer is hosting for Cloud, by run id. */
    const runs = new Map<string, Hosted>();
    /** How any hosted session speaks, once headless.ts's outbox is up (attach). */
    const emitter = yield* Deferred.make<Emit>();
    const sayAll = (emit: CloudAutomationStart["emit"], events: ReadonlyArray<HostEvent>) => Effect.forEach(events, (e) => emit(e.type, e.data), { discard: true });
    /** A Cloud refusal as an output's failure: tried again only when Cloud did not answer, or answered 429 or 5xx. */
    const refusedBy = (what: string) => (error: unknown) => new OutputError({ message: `Caveman did not ${what}: ${messageOf(error)}`, retryable: retryableCall(error) });

    // ------------------------------------------------------------ the record Cloud is owed (H2)

    const memory = new Map<string, { body: CloudRunRecordBody; tries: number }>();
    const records: CloudRecords = deps.records ?? {
      owe: (runId, body) => Effect.sync(() => void memory.set(runId, { body, tries: 0 })),
      sent: (runId) => Effect.sync(() => void memory.delete(runId)),
      tried: (runId) => Effect.sync(() => void (memory.get(runId) !== undefined && (memory.get(runId)!.tries += 1))),
      owed: Effect.sync(() => [...memory.entries()].map(([runId, r]) => ({ runId, body: r.body, tries: r.tries }))),
    };
    const sending = new Set<string>();
    /** Sends an owed record, again on no answer, a 429 or a 5xx; Cloud's refusal for good drops it, said in the log. */
    const send = (runId: string, body: CloudRunRecordBody) =>
      Effect.suspend(() => {
        if (sending.has(runId)) return Effect.void;
        sending.add(runId);
        const retry = deps.recordRetry ?? { base: "1 second", times: 8 };
        return deps.call("POST", "runs", body).pipe(
          Effect.tapError((error) => records.tried(runId, messageOf(error))),
          Effect.retry({ schedule: Schedule.exponential(retry.base), times: retry.times, while: retryableCall }),
          Effect.matchEffect({
            onSuccess: () => records.sent(runId),
            onFailure: (error) =>
              retryableCall(error)
                ? Effect.logWarning(`automations: Caveman Cloud did not take the record of run ${runId}; it goes again when the runtime next starts`, messageOf(error))
                : records.sent(runId).pipe(Effect.andThen(Effect.logWarning(`automations: Caveman Cloud refused the record of run ${runId}`, messageOf(error)))),
          }),
          Effect.ensuring(Effect.sync(() => void sending.delete(runId))),
        );
      });
    /** Owed first (durable), then sent in the background: a run's end never waits on Cloud. */
    const owe = (runId: string, body: CloudRunRecordBody) => records.owe(runId, body).pipe(Effect.andThen(send(runId, body).pipe(Effect.forkDetach)), Effect.asVoid);

    // ------------------------------------------------------------ finding a hosted run (H1)

    /** A run this host speaks for: started here, or (after a restart) found in the session outbox. */
    const bind = (runId: string): Effect.Effect<Hosted | undefined> =>
      Effect.gen(function* () {
        const known = runs.get(runId);
        if (known !== undefined) return known;
        const session = (yield* deps.sessions ?? Effect.succeed([] as ReadonlyArray<HostedSession>)).find((s) => s.automation.run_id === runId);
        if (session === undefined) return undefined;
        const emitTo = yield* Deferred.await(emitter).pipe(Effect.timeoutOption("60 seconds"));
        if (Option.isNone(emitTo)) return undefined;
        const again = runs.get(runId);
        if (again !== undefined) return again;
        const run: Hosted = {
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          automationId: session.automation.automation_id,
          emit: (type, data) => emitTo.value(session.sessionId, type, data),
          said: new Map(),
          asked: new Set(),
          spanned: new Set(),
          working: true,
        };
        runs.set(runId, run);
        return run;
      });
    const sessionOf = (sessionId: string) => (deps.sessions ?? Effect.succeed([] as ReadonlyArray<HostedSession>)).pipe(Effect.map((all) => all.find((s) => s.sessionId === sessionId)));

    /** The session's status (running, requires_action), said once per change: it moves Cloud's row too. */
    const status = (run: Hosted, next: "running" | "requires_action") =>
      run.status === next
        ? Effect.void
        : Effect.suspend(() => {
            run.status = next;
            return run.emit("session.status", { status: next, stop_reason: next === "requires_action" ? "requires_action" : null });
          });

    /** The earliest deadline the run waits for (a timer, a gate's expiry): Cloud wakes the computer then, if it sleeps. */
    const wakeAt = (run: Hosted, state: RunState) =>
      Effect.suspend(() => {
        const waits = state.steps.filter((s) => s.status === "waiting" && s.waitingUntil !== undefined).map((s) => s.waitingUntil!);
        const at = !isTerminal(state.status) && waits.length > 0 ? waits.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
        if (run.workspaceId === undefined || run.workspaceId === "" || (run.wakeAt ?? null) === at) return Effect.void;
        run.wakeAt = at;
        return deps.call("PUT", `workspaces/${encodeURIComponent(run.workspaceId)}/wake-at`, { at }).pipe(Effect.ignore);
      });

    /** M7: each attempt that ended, as one span in the session's traces. */
    const spans = (run: Hosted, row: RunRow, state: RunState) =>
      Effect.forEach(
        state.steps.flatMap((step) => step.attempts.map((attempt) => ({ step, attempt }))),
        ({ step, attempt }) => {
          const key = `${step.name}.${attempt.n}`;
          if (deps.span === undefined || attempt.endedAt === null || run.spanned.has(key)) return Effect.void;
          run.spanned.add(key);
          return deps.span(
            run.sessionId,
            stepSpan({
              sessionId: run.sessionId,
              automation: row.automation,
              step: step.name,
              runId: row.runId,
              attempt: attempt.n,
              engine: attempt.engine ?? "caveman",
              ...(attempt.model.resolved === undefined || attempt.model.resolved === null ? {} : { model: String(attempt.model.resolved) }),
              start: attempt.startedAt,
              end: attempt.endedAt,
              status: attempt.status,
              inputTokens: attempt.cost.input,
              outputTokens: attempt.cost.output,
              costUsd: attempt.cost.usd,
            }),
          );
        },
        { discard: true },
      );

    /** Each transition of a hosted run: its step moves, its gates, its spans, and at the end its record. */
    const observe = (row: RunRow, event: RunEvent, state: RunState) =>
      Effect.gen(function* () {
        const run = yield* bind(row.runId);
        if (run === undefined) return;
        run.working = state.status === "running" || state.status === "queued";
        const at = now();
        const events: HostEvent[] = stepEvents(state, run.said, at);
        for (const step of state.steps) {
          const gate = step.approval;
          if (step.status !== "waiting" || gate === undefined || gate.decision !== undefined || run.asked.has(step.name)) continue;
          run.asked.add(step.name);
          // SECURITY M3: who may answer travels with the ask (Cloud checks the approver against it).
          events.push({
            type: "requires_action",
            created_at: at,
            data: {
              ask_id: approvalAskId(row.runId, step.name),
              kind: "approval",
              by: gate.by,
              name: `${row.automation}: ${step.name}`,
              question:
                gate.before === true
                  ? `The text that started this run came from outside the trusted people, so step ${step.name} waits for the owner's approval before it runs.`
                  : `Step ${step.name} is done; approve its result so the run goes on.`,
              ...(gate.before === true ? { untrusted_trigger: true } : {}),
              input: { run_id: row.runId, step: step.name, by: gate.by, expires_at: gate.expiresAt, before_run: gate.before === true, summary: step.result?.summary ?? "" },
            },
          });
        }
        const waitingOnPerson = state.steps.some((s) => s.status === "waiting" && s.approval !== undefined && s.approval.decision === undefined);
        if (event.type === "approval_answered" || event.type === "approval_expired") run.asked.delete(event.step);
        // Spans before the events: the events' post wakes the outbox, which then sends both.
        yield* spans(run, row, state);
        if (events.length > 0) yield* sayAll(run.emit, events);
        yield* wakeAt(run, state);
        if (event.type === "run_finished" && isTerminal(state.status)) {
          run.working = false;
          yield* owe(row.runId, { session_id: run.sessionId, automation_id: row.automationId, record: recordOf(row, state, new Map(), "cloud") as unknown as Record<string, unknown> });
          // A run that worked leaves its session idle; one that failed ends it with the reason (Cloud's row: failed);
          // one that was stopped or superseded ends it as interrupted (Cloud's row: idle).
          if (state.status === "failed") yield* run.emit("session.error", { code: state.reason ?? "failed", message: `The run failed: ${state.reason ?? "failed"}` });
          yield* run.emit(
            "session.status",
            state.status === "succeeded"
              ? { status: "idle", stop_reason: "end_turn" }
              : { status: "terminated", stop_reason: state.status === "failed" ? "error" : "interrupted" },
          );
          runs.delete(row.runId);
          return;
        }
        yield* status(run, waitingOnPerson ? "requires_action" : "running");
      });

    yield* deps.runner.useHost({
      environment: "cloud",
      observe,
      post: (input) =>
        Effect.gen(function* () {
          const run = yield* bind(input.runId);
          if (run === undefined) return yield* new OutputError({ message: "This run's session is not known here.", retryable: false });
          const posted = yield* deps
            .call<{ url?: string; remote_id?: string }>("POST", "outputs", { session_id: run.sessionId, kind: input.kind, target: input.target, body: input.body, idempotency_key: input.idempotencyKey })
            .pipe(Effect.mapError(refusedBy(`post the ${input.kind}`)));
          return { ...(posted?.url === undefined ? {} : { url: posted.url }), ...(posted?.remote_id === undefined ? {} : { remoteId: posted.remote_id }) };
        }),
      cloudGitHub: {
        // CORRECTNESS C1: the branch goes through Cloud's git proxy, then Cloud opens (or edits) the pull request as the
        // repository's App, fenced to the session's own repository and caveman/* heads.
        pullRequest: (input) =>
          Effect.gen(function* () {
            const run = yield* bind(input.runId);
            if (run === undefined) return yield* new OutputError({ message: "This run's session is not known here.", retryable: false });
            const push = deps.push;
            if (push === undefined) return yield* new OutputError({ message: "This computer cannot push to Caveman's git proxy, so no pull request was opened.", retryable: false });
            const head = yield* push({ root: input.root, branch: input.head, sha: input.sha }).pipe(
              Effect.mapError((error) => new OutputError({ message: `The push of ${input.head} through Caveman's git proxy failed: ${error.message}`, retryable: true })),
            );
            const opened = yield* deps
              .call<{ url?: unknown; html_url?: unknown; number?: unknown }>("POST", "pull-requests", {
                session_id: run.sessionId,
                repo: input.repo,
                head,
                base: input.base,
                sha: input.sha,
                title: input.title,
                body: input.body,
                draft: input.draft,
                idempotency_key: input.idempotencyKey,
              })
              .pipe(Effect.mapError(refusedBy("open the pull request")));
            const url = textOf(opened?.url) ?? textOf(opened?.html_url);
            const number = textOf(opened?.number);
            return { ...(url === undefined ? {} : { url }), ...(number === undefined ? {} : { remoteId: number }) };
          }),
        comment: (input) =>
          Effect.gen(function* () {
            const run = yield* bind(input.runId);
            if (run === undefined) return yield* new OutputError({ message: "This run's session is not known here.", retryable: false });
            const posted = yield* deps
              .call<{ url?: unknown; html_url?: unknown; id?: unknown }>("POST", "comments", {
                session_id: run.sessionId,
                repo: input.repo,
                ...(input.issue === undefined ? {} : { issue_number: input.issue }),
                ...(input.commit === undefined ? {} : { commit_sha: input.commit }),
                body: input.body,
                marker: input.marker,
                idempotency_key: input.idempotencyKey,
              })
              .pipe(Effect.mapError(refusedBy("post the comment")));
            const url = textOf(posted?.url) ?? textOf(posted?.html_url);
            const id = textOf(posted?.id);
            return { ...(url === undefined ? {} : { url }), ...(id === undefined ? {} : { remoteId: id }) };
          }),
      },
    });

    /** A run that ends before the runner has it: the session says why and ends, and Cloud gets its failed record. */
    const failStart = (input: CloudAutomationStart, failure: { readonly name: string; readonly trigger: TriggerEvent; readonly digest: string; readonly reason: NonNullable<AutomationRunRecord["reason"]>; readonly message: string }, speak: boolean) =>
      Effect.gen(function* () {
        const record = { ...failedRecord({ start: input, name: failure.name, trigger: failure.trigger, digest: failure.digest, at: now(), reason: failure.reason }), message: failure.message };
        yield* owe(input.automation.run_id, { session_id: input.sessionId, automation_id: input.automation.automation_id, record: record as unknown as Record<string, unknown> });
        if (!speak) return;
        yield* input.emit("session.error", { code: failure.reason, message: failure.message });
        yield* input.emit("session.status", { status: "terminated", stop_reason: "error" });
      });

    /** One start at a time per run: a redelivered start waits for the first, then finds its run. */
    const starting = new Map<string, Semaphore.Semaphore>();
    const startLock = (runId: string) => {
      let lock = starting.get(runId);
      if (lock === undefined) starting.set(runId, (lock = Semaphore.makeUnsafe(1)));
      return lock;
    };

    const start: CloudHost["start"] = (input) => startLock(input.automation.run_id).withPermits(1)(startOnce(input));

    /**
     * Idempotent by run id (A1 hands a redelivered start back): a run this host holds, or one the journal has (left
     * going, resumed or ended), is adopted, never started a second time.
     */
    const startOnce = (input: CloudAutomationStart) =>
      Effect.gen(function* () {
        const at = now();
        const { automation } = input;
        if (runs.has(automation.run_id)) return;
        const known = yield* deps.runner.get(automation.run_id);
        if (known !== undefined) {
          if (!isTerminal(known.status)) {
            const session = yield* sessionOf(input.sessionId);
            runs.set(automation.run_id, {
              sessionId: input.sessionId,
              workspaceId: session?.workspaceId,
              automationId: automation.automation_id,
              emit: input.emit,
              said: new Map(),
              asked: new Set(),
              spanned: new Set(),
              working: known.status === "running" || known.status === "queued",
            });
          }
          return;
        }
        const early = triggerFrom({ trigger: automation.trigger, event: automation.event, runId: automation.run_id, automation: automation.automation_id, receivedAt: at, subject: automation.subject });
        // Failing here, headless.ts says start_failed and ends the session; Cloud gets the failed record (H2).
        const startFailed = (message: string) =>
          failStart(input, { name: automation.automation_id, trigger: early, digest: "", reason: "start_failed", message }, false).pipe(Effect.andThen(Effect.fail({ message })));
        const prepared = yield* (deps.prepare?.(input) ?? Effect.void).pipe(Effect.result);
        if (prepared._tag === "Failure") return yield* startFailed(prepared.failure.message);
        const fetched = yield* deps
          .call<{ files?: Record<string, string>; sha256?: string }>("GET", `automations/revisions/${encodeURIComponent(automation.revision_id)}`)
          .pipe(Effect.retry({ schedule: Schedule.exponential("1 second"), times: Math.max(0, (deps.fetchTries ?? 3) - 1) }), Effect.result);
        if (fetched._tag === "Failure") return yield* startFailed(`The automation's revision ${automation.revision_id} could not be read: ${messageOf(fetched.failure)}`);
        const files: SourceFile[] = Object.entries(fetched.success.files ?? {}).map(([path, text]) => ({ path, text }));
        const automationFile = files.find((f) => /^\.caveman\/automations\/[^/]+\.yaml$/.test(f.path));
        const name = automationFile === undefined ? automation.automation_id : automationFile.path.slice(".caveman/automations/".length, -".yaml".length);
        const trigger = triggerFrom({ trigger: automation.trigger, event: automation.event, runId: automation.run_id, automation: name, receivedAt: at, subject: automation.subject });
        const registry = yield* deps.registry;
        const sources = { files, claude: [], problems: [] };
        const check = checkSources({ sources, registry, target: "cloud" });
        const loaded = check.automations.find((a) => a.name === name && a.scope === "project");
        const problems =
          loaded === undefined
            ? [automationFile === undefined ? "The revision holds no automation file." : (check.diagnostics.find((d) => d.path === automationFile.path)?.message ?? "The automation file does not load.")]
            : hostOf(loaded.file) !== "cloud"
              ? ["The file says it runs on This Mac (host: this-mac), so Cloud does not run it."]
              : blockingErrors(check, loaded).map((d) => `${d.path}:${d.line}:${d.column}  ${d.message}`);
        const revision = loaded === undefined ? undefined : revisionFrom({ sources, registry, check, name, scope: "project", from: "default_branch" });
        const digest = fetched.success.sha256 ?? "";
        if (problems.length > 0 || revision === undefined) {
          // §6.4's result_invalid for the whole run: the file is what is wrong, so nothing runs.
          return yield* failStart(input, { name, trigger, digest, reason: "result_invalid", message: `The automation's files do not check: ${problems.join(" ")}` }, true);
        }
        const session = yield* sessionOf(input.sessionId);
        const run: Hosted = {
          sessionId: input.sessionId,
          workspaceId: session?.workspaceId,
          automationId: automation.automation_id,
          emit: input.emit,
          said: new Map(),
          asked: new Set(),
          spanned: new Set(),
          working: true,
        };
        runs.set(automation.run_id, run);
        yield* status(run, "running");
        const admitted = yield* deps.runner.admit({
          projectId: input.projectId,
          revision,
          trigger,
          apply: true,
          runId: automation.run_id,
          automationId: automation.automation_id,
        });
        if ("refused" in admitted) {
          runs.delete(automation.run_id);
          yield* failStart(input, { name, trigger, digest, reason: admitted.refused, message: admitted.message }, true);
        }
      });

    const answer: CloudHost["answer"] = (askId, given) =>
      Effect.gen(function* () {
        const gate = approvalOf(askId);
        // CORRECTNESS M3: only a user.approval with a decision answers a gate; a text answer is no decision at all.
        if (gate === undefined || given.kind !== "user.approval" || (given.decision !== "allow" && given.decision !== "deny")) return false;
        const decision = given.decision === "allow" ? "approve" : "reject";
        const approve = deps.runner.approve({
          runId: gate.runId,
          step: gate.step,
          decision,
          by: "cloud",
          ...(given.message === undefined ? {} : { message: given.message }),
        });
        // A gate a restart left is asked again as its run resumes: an answer that came first waits for it a little.
        const pending = (refused: unknown) =>
          "refused" in (refused as object) &&
          deps.runner.get(gate.runId).pipe(Effect.map((r) => r?.steps.some((s) => s.name === gate.step && s.status === "waiting" && s.approval !== undefined && s.approval.decision === undefined) === true));
        let result = yield* approve;
        for (let i = 0; i < 50 && "refused" in result && (yield* (pending(result) || Effect.succeed(false))); i++) {
          yield* Effect.sleep("100 millis");
          result = yield* approve;
        }
        const run = yield* bind(gate.runId);
        if ("refused" in result && run !== undefined) yield* run.emit("session.error", { code: "answer_refused", message: `ask ${askId}: ${result.message}` });
        return true;
      });

    const stop: CloudHost["stop"] = (sessionId) =>
      Effect.gen(function* () {
        const runId = [...runs.entries()].find(([, run]) => run.sessionId === sessionId)?.[0] ?? (yield* sessionOf(sessionId))?.automation.run_id;
        if (runId === undefined || (yield* deps.runner.get(runId)) === undefined) return false;
        yield* deps.runner.cancel(runId, "cancelled");
        return true;
      });

    const attach: CloudHost["attach"] = (emitTo) =>
      Effect.gen(function* () {
        if (!(yield* Deferred.succeed(emitter, emitTo))) return;
        // What the last runtime still owed Cloud goes again.
        for (const owed of yield* records.owed) yield* send(owed.runId, owed.body).pipe(Effect.forkDetach);
        for (const session of yield* deps.sessions ?? Effect.succeed([] as ReadonlyArray<HostedSession>)) {
          const record = yield* deps.runner.get(session.automation.run_id);
          if (record !== undefined) {
            // A run left going speaks for its session again (the runner resumes it; its next move re-says where it is).
            if (!isTerminal(record.status)) yield* bind(session.automation.run_id);
            continue;
          }
          // L7: the session was registered but its run never reached the runner (a crash in between): it starts now.
          if (session.status === "terminated" || (yield* records.owed).some((o) => o.runId === session.automation.run_id)) continue;
          const projectId = yield* deps.projectId ?? Effect.succeed(undefined);
          const emit: CloudAutomationStart["emit"] = (type, data) => emitTo(session.sessionId, type, data);
          const input: CloudAutomationStart = { sessionId: session.sessionId, projectId: projectId ?? "", automation: session.automation, emit };
          if (projectId === undefined) {
            const trigger = triggerFrom({ trigger: session.automation.trigger, event: session.automation.event, runId: session.automation.run_id, automation: session.automation.automation_id, receivedAt: now(), subject: session.automation.subject });
            yield* failStart(input, { name: session.automation.automation_id, trigger, digest: "", reason: "start_failed", message: "This computer has no checkout to run the automation in." }, true);
            continue;
          }
          yield* start(input).pipe(
            Effect.catch((failure: { readonly message: string }) =>
              Effect.gen(function* () {
                yield* emit("session.error", { code: "start_failed", message: failure.message });
                yield* emit("session.status", { status: "terminated", stop_reason: "error" });
              }),
            ),
            Effect.forkDetach,
          );
        }
      });

    const working: CloudHost["working"] = () => [...runs.values()].some((run) => run.working);

    const host = { start, answer, stop, attach, working } satisfies CloudHost;
    return host;
  });
