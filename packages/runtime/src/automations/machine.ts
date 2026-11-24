// The run machine (SEMANTICS v1 and v2): `next(state, event)` returns the run's new state and what the runner
// does next. Pure: no clock, no I/O, every time comes in on an event. The events are the run's journal
// (journal.ts), so a run's state is always the fold of its journal (`replay`), and a runtime restart resumes from
// it (`run_resumed`). Without `needs`, steps run one at a time in file order (§1.1); with them, the run is a graph
// whose ready steps start together up to the run's limit, and steps that write the run's branch take turns (§1.2).
// Attempts, retries and escalation ladders follow §3, parallel attempts and pick §4, approvals §5, outputs apply at
// the end in declaration order (§7.2), and cancellation follows §8.3. A wait step is a timer whose deadline is in
// the journal, so it survives restarts; a rubric (outcome) is graded after the checks, and work that falls short
// goes back with the grader's feedback.
import {
  approvalMsOf,
  computerOf,
  durationMs,
  isGraph,
  outputSource,
  rungsOf,
  stepKindOf,
  timeoutMsOf,
  writingSteps,
  DEFAULT_APPROVAL_MS,
  DEFAULT_ITERATIONS,
  type AutomationFile,
  type Computer,
  type ModelClass,
} from "@caveman-app/automations";

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped" | "cancelled";
/** SEMANTICS §12, the closed list, plus outcome_unmet (a rubric not met in its iterations) and not_picked (a parallel attempt another beat). */
export type Reason =
  | "condition_false"
  | "need_not_succeeded"
  | "need_skipped"
  | "need_failed"
  | "run_cancelled"
  | "checks_failed"
  | "review_rejected"
  | "agent_error"
  | "timeout"
  | "result_invalid"
  | "budget_exhausted"
  | "cancelled"
  | "superseded"
  | "policy_denied"
  | "deadline"
  | "approval_rejected"
  | "approval_expired"
  | "engine_unavailable"
  | "output_failed"
  | "skipped_overlap"
  | "pick_invalid"
  | "not_home"
  | "needs_isolation"
  | "outcome_unmet"
  /** A hosted run that never reached the runner: its checkout, its revision or the runtime could not start it. */
  | "start_failed"
  | "not_picked";
/** What stops a whole run from outside (§8.3); budget exhaustion fails its step instead (§9.4). */
export type CancelReason = "cancelled" | "superseded" | "deadline" | "policy_denied";
/** Why an attempt ended other than by its checks; needs_isolation: a fork's code may not be checked out to write on This Mac. */
export type AttemptFailure = "agent_error" | "timeout" | "result_invalid" | "budget_exhausted" | "engine_unavailable" | "needs_isolation";

/** §3.2: everything else is final. A rubric not met is retried by its own count (max_iterations), not by `retries`. */
export const RETRYABLE: ReadonlySet<Reason> = new Set<Reason>(["checks_failed", "review_rejected", "agent_error", "timeout", "result_invalid"]);

/** §3.5 */
export const CHECK_TAIL_BYTES = 8 * 1024;
export const FAILURES_MAX_BYTES = 24 * 1024;
/** Steps of one run going at once in a graph; waiting steps (a timer, an approval) do not count. */
export const STEP_LIMIT = 4;

export type PlanCheck = { readonly kind: "command"; readonly command: string } | { readonly kind: "agent"; readonly agent: string };

/** One rung of an escalation ladder. */
export interface PlanRung {
  readonly model?: string;
  readonly engine?: string;
  readonly effort?: string;
}

export interface PlanStep {
  readonly name: string;
  readonly agent?: string;
  /** The step's own prompt; beside an agent (agent.run), the person's brief for that agent. */
  readonly prompt?: string;
  /** A prompt step's own `decides:` (an agent step decides what its agent file says). */
  readonly decides?: ReadonlyArray<string>;
  readonly if?: Readonly<Record<string, string>>;
  /**
   * What attempt 1 asks for: a class, `auto` (Caveman Auto), a pin or an alias (the step's, else its agent's), else
   * `default`: the new-chat default.
   */
  readonly model: string;
  /** What attempts after a failure run on: rung 1 for attempt 2, then the next; the last repeats. A class (journals before v2) is one rung. */
  readonly escalate?: ModelClass | ReadonlyArray<PlanRung>;
  readonly effort?: string;
  readonly computer: Computer;
  /** Command checks first, then agent checks, each in file order (§3.7). */
  readonly checks: ReadonlyArray<PlanCheck>;
  readonly retries: number;
  readonly timeoutMs: number;
  /** agent (absent too): an agent's work; run: a command with no model; wait: a timer. */
  readonly kind?: "agent" | "run" | "wait";
  readonly run?: string;
  readonly waitMs?: number;
  readonly needs?: ReadonlyArray<string>;
  /** Attempts at once (§4); absent: one. */
  readonly parallel?: number;
  readonly pick?: "first" | "best";
  readonly approve?: { readonly by: "owner" | "members"; readonly timeoutMs: number };
  /**
   * SECURITY M1: the run's trigger text came from outside the trusted people and this step can write (a full
   * computer, or an output reads it), so it waits for the owner's approval before it runs.
   */
  readonly gate?: { readonly by: "owner"; readonly timeoutMs: number };
  readonly outcome?: { readonly rubric: string; readonly maxIterations: number };
}

/** chief: the step's summary goes to a Chief (a routine: the one it names, else one that works in the project), in a manual run too. */
export type OutputKind = "github.comment" | "github.pull_request" | "slack.message" | "linear.comment" | "jira.comment" | "chief";

export interface PlanOutput {
  readonly kind: OutputKind;
  readonly step: string;
  readonly field: string;
  readonly draft?: boolean;
  /** slack.message: post in this channel instead of replying in the thread that fired the run. */
  readonly channel?: string;
  /** chief: the Chief it reports to (outputs.chief.to). */
  readonly to?: string;
}

export interface RunPlan {
  readonly automation: string;
  readonly steps: ReadonlyArray<PlanStep>;
  readonly outputs: ReadonlyArray<PlanOutput>;
  /** false: outputs are a dry run (a manual run) until applied. */
  readonly apply: boolean;
  /** Steps start when their needs are done (§1.2), up to `limit` at once; absent: file order. */
  readonly graph?: boolean;
  readonly limit?: number;
}

/** A step that names no model starts on the new-chat default (B14); `auto` asks for Caveman Auto. */
export const DEFAULT_MODEL = "default";
/** What a run step records as its model: it has none. */
export const NO_MODEL = "none";

/**
 * The plan a file makes: what the machine needs of it, fixed at admission. `untrusted`: the trigger's text came from
 * outside the trusted people, so every step that can write gets an approval by the owner before it runs.
 */
export function planOf(
  file: AutomationFile,
  agents: ReadonlyArray<{ readonly name: string; readonly model?: string; readonly effort?: string }>,
  apply: boolean,
  automation: string,
  options: { readonly untrusted?: boolean } = {},
): RunPlan {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const gated = new Set(options.untrusted === true ? writingSteps(file) : []);
  const steps = Object.entries(file.steps).map(([name, step]): PlanStep => {
    const agent = step.agent === undefined ? undefined : byName.get(step.agent);
    const agentModel = agent?.model === "inherit" ? undefined : agent?.model;
    const checks = (step.checks ?? []).map((c): PlanCheck => (typeof c === "string" ? { kind: "command", command: c } : { kind: "agent", agent: c.agent }));
    const effort = step.effort ?? agent?.effort;
    const kind = stepKindOf(step);
    const rungs = rungsOf(step.escalate).map((r) => ({ ...(r.model === undefined ? {} : { model: r.model }), ...(r.engine === undefined ? {} : { engine: r.engine }), ...(r.effort === undefined ? {} : { effort: r.effort }) }));
    return {
      name,
      ...(step.agent === undefined ? {} : { agent: step.agent }),
      ...(step.prompt === undefined ? {} : { prompt: step.prompt }),
      ...(step.decides === undefined ? {} : { decides: [...step.decides] }),
      ...(step.if === undefined ? {} : { if: step.if }),
      model: kind === "run" ? NO_MODEL : (step.model ?? agentModel ?? DEFAULT_MODEL),
      // A class stays a class, so a plan reads as the file does; a ladder is its rungs.
      ...(step.escalate === undefined ? {} : { escalate: typeof step.escalate === "string" ? step.escalate : rungs }),
      ...(effort === undefined ? {} : { effort }),
      computer: computerOf(step),
      checks: [...checks.filter((c) => c.kind === "command"), ...checks.filter((c) => c.kind === "agent")],
      retries: step.retries ?? 0,
      timeoutMs: timeoutMsOf(step),
      ...(kind === "agent" ? {} : { kind }),
      ...(step.run === undefined ? {} : { run: step.run }),
      ...(kind === "wait" ? { waitMs: durationMs(step.wait!) ?? 0 } : {}),
      ...(step.needs === undefined ? {} : { needs: [...step.needs] }),
      ...(step.parallel === undefined ? {} : { parallel: step.parallel, pick: step.pick ?? "best" }),
      ...(step.approve === undefined ? {} : { approve: { by: step.approve.by, timeoutMs: approvalMsOf(step) } }),
      ...(gated.has(name) ? { gate: { by: "owner" as const, timeoutMs: DEFAULT_APPROVAL_MS } } : {}),
      ...(step.outcome === undefined ? {} : { outcome: { rubric: step.outcome.rubric, maxIterations: step.outcome.max_iterations ?? DEFAULT_ITERATIONS } }),
    };
  });
  const outputs: PlanOutput[] = [];
  for (const [kind, value] of Object.entries(file.outputs ?? {})) {
    if (value === undefined) continue;
    if (kind === "github.pull_request") {
      const pr = value as { from: string; draft?: boolean };
      outputs.push({ kind, step: pr.from, field: "summary", ...(pr.draft === undefined ? {} : { draft: pr.draft }) });
    } else if (kind === "github.comment" || kind === "slack.message" || kind === "linear.comment" || kind === "jira.comment") {
      const written = value as string | { from: string; field?: string; channel?: string };
      const source = outputSource(written);
      const channel = typeof written === "string" ? undefined : written.channel;
      outputs.push({ kind, step: source.step, field: source.field, ...(channel === undefined ? {} : { channel }) });
    } else if (kind === "chief") {
      const chief = value as { from: string; to?: string };
      outputs.push({ kind, step: chief.from, field: "summary", ...(chief.to === undefined ? {} : { to: chief.to }) });
    }
  }
  return { automation, steps, outputs, apply, ...(isGraph(file) ? { graph: true, limit: STEP_LIMIT } : {}) };
}

/** §6.4: `{ summary, decision?, ...returns }`. */
export interface Envelope {
  readonly summary: string;
  readonly decision?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface Cost {
  readonly usd: number;
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly turns: number;
  /** api_key: priced per token; plan: a subscription login, tokens only (§9.6); mixed; none: nothing was used. */
  readonly billing: "api_key" | "plan" | "mixed" | "none";
}

export const NO_COST: Cost = { usd: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0, billing: "none" };

export function addCost(a: Cost, b: Cost | undefined): Cost {
  if (b === undefined) return a;
  const billing = a.billing === "none" ? b.billing : b.billing === "none" || b.billing === a.billing ? a.billing : "mixed";
  return {
    usd: a.usd + b.usd,
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
    turns: a.turns + b.turns,
    billing,
  };
}

export interface ModelChoice {
  readonly asked: string;
  readonly resolved: string;
  /** Who set it: `class`, `escalate`, `pin`, `default`, or why a class fell back to the engine's model. */
  readonly via?: string;
}

export interface CheckState {
  readonly index: number;
  readonly check: string;
  readonly kind: PlanCheck["kind"];
  readonly passed: boolean;
  readonly exit?: number;
  readonly ms?: number;
  readonly decision?: string;
  /** An agent check's summary, or a command check's last 8 KiB of output. */
  readonly text?: string;
  readonly threadId?: string;
}

/** The grader's verdict on an attempt (outcome). */
export interface GradeState {
  readonly satisfied: boolean;
  readonly text: string;
  readonly threadId?: string;
}

export interface AttemptState {
  readonly n: number;
  readonly status: StepStatus;
  readonly reason: Reason | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly model: ModelChoice;
  readonly engine?: string;
  readonly effort?: string;
  readonly computer: Computer;
  readonly threadId?: string;
  readonly session: "new" | "continue";
  /** The commit its checkout held when it started (a parallel attempt's own copy can be newer than the step's start). */
  readonly startSha?: string | null;
  readonly result?: Envelope;
  readonly checks: ReadonlyArray<CheckState>;
  readonly grade?: GradeState;
  /** A parallel attempt: its place in its round (1..N), and that it passed everything and waits to be picked. */
  readonly candidate?: number;
  readonly passed?: boolean;
  readonly cost: Cost;
  /** Why it failed, in words (an agent error, a timeout); checks carry their own. */
  readonly message?: string;
  readonly sha: string | null;
}

export interface ApprovalState {
  readonly by: "owner" | "members";
  readonly askedAt: string;
  readonly expiresAt: string;
  /** Asked before the step runs (its plan's gate), not after its work. */
  readonly before?: true;
  readonly decision?: "approve" | "reject";
  readonly decidedBy?: string;
  readonly message?: string;
  readonly decidedAt?: string;
}

export interface StepState {
  readonly name: string;
  readonly status: StepStatus;
  readonly reason: Reason | null;
  readonly decision?: string;
  readonly result?: Envelope;
  /** The run head when the step started: a full step's commits squash onto it. */
  readonly startSha?: string | null;
  readonly sha: string | null;
  readonly attempts: ReadonlyArray<AttemptState>;
  /** A wait step's timer, or an approval's expiry. */
  readonly waitingUntil?: string;
  readonly approval?: ApprovalState;
  /** A parallel step's chosen attempt, and `pick_invalid` when the pick named none and the cheapest won. */
  readonly chosen?: number;
  readonly pickNote?: "pick_invalid";
}

export type OutputStatus = "pending" | "dry_run" | "applied" | "failed" | "dropped";

export interface OutputState extends PlanOutput {
  /** `<run>.<step>.<kind>` (§7.3): no attempt number, so a retried step cannot write twice. */
  readonly key: string;
  readonly status: OutputStatus;
  /** An output_intent with no applied record yet: a resume searches by marker before creating (§7.3). */
  readonly intent: boolean;
  readonly url?: string;
  readonly remoteId?: string;
  readonly preview?: string;
  readonly error?: string;
}

export type Action =
  | {
      readonly type: "start_attempt";
      readonly step: string;
      readonly n: number;
      readonly asked: string;
      /** The model came from an escalation rung (attempts 2+). */
      readonly escalated: boolean;
      /** §3.4: a same-model retry continues the previous attempt's session; anything else starts a new one. */
      readonly session: "new" | "continue";
      /** §3.5: what failed before, capped at 24 KiB from the head; for a rubric, the grader's feedback. */
      readonly failures?: string;
      /** An escalation rung's engine and effort. */
      readonly engine?: string;
      readonly effort?: string;
      /** A parallel attempt's place in its round. */
      readonly candidate?: number;
    }
  | { readonly type: "run_check"; readonly step: string; readonly n: number; readonly index: number }
  /** The grader scores attempt n against the step's rubric (outcome). */
  | { readonly type: "grade"; readonly step: string; readonly n: number }
  /** pick: best, with two or more attempts that passed: a reviewer chooses (§4.3). */
  | { readonly type: "pick"; readonly step: string; readonly candidates: ReadonlyArray<number> }
  /** pick: first: another attempt won, so this one stops. */
  | { readonly type: "stop_attempt"; readonly step: string; readonly n: number }
  /** A full step passed: commit its workspace as one commit (§3.8, §6.2). */
  | { readonly type: "commit"; readonly step: string; readonly n: number }
  /** The step is over: its throwaway checkout (readonly, none) can go. */
  | { readonly type: "release_step"; readonly step: string }
  /** A wait step: nothing happens until `until`. */
  | { readonly type: "wait_until"; readonly step: string; readonly until: string }
  /** §5: a person approves (or not) before `until`. */
  | { readonly type: "await_approval"; readonly step: string; readonly by: "owner" | "members"; readonly until: string }
  | { readonly type: "output"; readonly key: string; readonly mode: "apply" | "preview" }
  | { readonly type: "finish" };

export type RunEvent =
  | { readonly type: "run_admitted"; readonly at: string; readonly run: string; readonly plan: RunPlan }
  | {
      readonly type: "step_started";
      readonly at: string;
      readonly step: string;
      readonly n: number;
      readonly model: ModelChoice;
      readonly engine?: string;
      readonly effort?: string;
      readonly computer: Computer;
      readonly thread_id?: string;
      readonly session: "new" | "continue";
      readonly start_sha?: string | null;
    }
  | { readonly type: "attempt_finished"; readonly at: string; readonly step: string; readonly n: number; readonly result: Envelope; readonly cost?: Cost }
  | {
      readonly type: "attempt_failed";
      readonly at: string;
      readonly step: string;
      readonly n: number;
      readonly reason: AttemptFailure;
      readonly message: string;
      readonly cost?: Cost;
    }
  | {
      readonly type: "check_result";
      readonly at: string;
      readonly step: string;
      readonly n: number;
      readonly index: number;
      readonly passed: boolean;
      readonly exit?: number;
      readonly ms?: number;
      readonly decision?: string;
      readonly text?: string;
      readonly thread_id?: string;
      readonly cost?: Cost;
    }
  | { readonly type: "graded"; readonly at: string; readonly step: string; readonly n: number; readonly satisfied: boolean; readonly text: string; readonly thread_id?: string; readonly cost?: Cost }
  | { readonly type: "picked"; readonly at: string; readonly step: string; readonly n: number | null; readonly text?: string; readonly thread_id?: string; readonly cost?: Cost }
  | { readonly type: "attempt_stopped"; readonly at: string; readonly step: string; readonly n: number; readonly cost?: Cost }
  | { readonly type: "attempt_committed"; readonly at: string; readonly step: string; readonly n: number; readonly sha: string | null }
  | { readonly type: "timer_fired"; readonly at: string; readonly step: string }
  | { readonly type: "approval_answered"; readonly at: string; readonly step: string; readonly decision: "approve" | "reject"; readonly by?: string; readonly message?: string }
  | { readonly type: "approval_expired"; readonly at: string; readonly step: string }
  | { readonly type: "output_intent"; readonly at: string; readonly key: string }
  | { readonly type: "output_applied"; readonly at: string; readonly key: string; readonly url?: string; readonly remote_id?: string }
  | { readonly type: "output_dry_run"; readonly at: string; readonly key: string; readonly preview: string }
  | { readonly type: "output_failed"; readonly at: string; readonly key: string; readonly error: string }
  /** Nothing to write (no changes to propose; no GitHub remote for a dry run): not a failure, and `note` says why. */
  | { readonly type: "output_dropped"; readonly at: string; readonly key: string; readonly note: string }
  | { readonly type: "run_cancelled"; readonly at: string; readonly reason: CancelReason; readonly cost?: Cost }
  | { readonly type: "run_resumed"; readonly at: string }
  | { readonly type: "run_finished"; readonly at: string };

export interface RunState {
  readonly run: string;
  readonly plan: RunPlan;
  readonly status: RunStatus;
  readonly reason: Reason | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly steps: ReadonlyArray<StepState>;
  readonly outputs: ReadonlyArray<OutputState>;
  /** The actions the runner owes an event for; a resume does them again (or fails an attempt it cannot resume). */
  readonly owed: ReadonlyArray<Action>;
}

export interface Transition {
  readonly state: RunState;
  readonly actions: ReadonlyArray<Action>;
}

export const isTerminal = (status: RunStatus): boolean => status === "succeeded" || status === "failed" || status === "cancelled";
const stepDone = (status: StepStatus): boolean => status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";

export const attemptId = (run: string, step: string, n: number): string => `${run}.${step}.${n}`;
export const outputKey = (run: string, step: string, kind: string): string => `${run}.${step}.${kind}`;
/** The ask id an approval travels under (Cloud's `requires_action`, an `answer` mail). */
export const approvalAskId = (run: string, step: string): string => `automation:${run}:${step}`;
export const stepKind = (step: PlanStep): "agent" | "run" | "wait" => step.kind ?? "agent";
export const isGraphPlan = (plan: RunPlan): boolean => plan.graph === true || plan.steps.some((s) => s.needs !== undefined);
const ladderOf = (step: PlanStep): ReadonlyArray<PlanRung> => (step.escalate === undefined ? [] : typeof step.escalate === "string" ? [{ model: step.escalate }] : step.escalate);

/** The run's state after its journal. */
export function replay(events: ReadonlyArray<RunEvent>): RunState | undefined {
  let state: RunState | undefined;
  for (const event of events) state = next(state, event).state;
  return state;
}

const stepOf = (state: RunState, name: string) => state.steps.find((s) => s.name === name);
const planStep = (state: RunState, name: string) => state.plan.steps.find((s) => s.name === name)!;

function withStep(state: RunState, name: string, update: (step: StepState) => StepState): RunState {
  return { ...state, steps: state.steps.map((s) => (s.name === name ? update(s) : s)) };
}
function withAttempt(step: StepState, n: number, update: (attempt: AttemptState) => AttemptState): StepState {
  return { ...step, attempts: step.attempts.map((a) => (a.n === n ? update(a) : a)) };
}

/**
 * Whether an event is about an attempt the step is on now; anything else is stale and changes nothing. An attempt
 * being stopped is stale: once one is chosen (§4.3), every other attempt has ended or is being stopped.
 */
function current(state: RunState, step: string, n: number): AttemptState | undefined {
  const s = stepOf(state, step);
  if (s?.status !== "running" || beingStopped(state, step, n)) return undefined;
  const attempt = s.attempts.find((a) => a.n === n);
  return attempt?.status === "running" ? attempt : undefined;
}

// ------------------------------------------------------------------ what the runner owes

/** The step and attempt an owed action is about. */
const aboutAttempt = (a: Action, step: string, n: number) => "step" in a && a.step === step && "n" in a && a.n === n;
const aboutStep = (a: Action, step: string) => "step" in a && a.step === step;
const beingStopped = (state: RunState, step: string, n: number) => state.owed.some((a) => a.type === "stop_attempt" && aboutAttempt(a, step, n));

/** The actions, owed until their event arrives (a step's release is done once and never owed). */
function emit(state: RunState, ...actions: ReadonlyArray<Action>): Transition {
  const owed = actions.filter((a) => a.type !== "release_step");
  return { state: { ...state, owed: [...state.owed, ...owed] }, actions };
}
const settle = (state: RunState, done: (a: Action) => boolean): RunState => ({ ...state, owed: state.owed.filter((a) => !done(a)) });
const then = (first: Transition, second: (state: RunState) => Transition): Transition => {
  const after = second(first.state);
  return { state: after.state, actions: [...first.actions, ...after.actions] };
};

/** running while any step works, waiting while the rest wait on a timer or a person. */
function withStatus(state: RunState): RunState {
  if (isTerminal(state.status)) return state;
  const status: RunStatus = state.steps.some((s) => s.status === "running") ? "running" : state.steps.some((s) => s.status === "waiting") ? "waiting" : "running";
  return status === state.status ? state : { ...state, status };
}
const done = (t: Transition): Transition => ({ state: withStatus(t.state), actions: t.actions });

export function next(state: RunState | undefined, event: RunEvent): Transition {
  if (event.type === "run_admitted") {
    if (state !== undefined) return { state, actions: [] };
    const admitted: RunState = {
      run: event.run,
      plan: event.plan,
      status: "running",
      reason: null,
      startedAt: event.at,
      endedAt: null,
      steps: event.plan.steps.map((s) => ({ name: s.name, status: "pending", reason: null, sha: null, attempts: [] })),
      outputs: event.plan.outputs.map((o) => ({ ...o, key: outputKey(event.run, o.step, o.kind), status: "pending", intent: false })),
      owed: [],
    };
    return done(advance(admitted, event.at));
  }
  if (state === undefined) throw new Error(`run journal starts with ${event.type}, not run_admitted`);
  if (isTerminal(state.status)) {
    const after = settled(state, event);
    // An ended run's finish waits for its last stop (outputsOrFinish).
    const lastStop = event.type === "attempt_stopped" && beingStopped(state, event.step, event.n) && after.owed.length === 0;
    return lastStop ? emit(after, { type: "finish" }) : { state: after, actions: [] };
  }
  return done(step(state, event));
}

/**
 * A finished run: a manual run's dry-run outputs are applied after it ended (automation.run_apply); a parallel
 * attempt that was stopped records its end; nothing else moves it.
 */
function settled(state: RunState, event: RunEvent): RunState {
  if (event.type === "output_intent") return withOutput(state, event.key, (o) => (o.status === "dry_run" ? { ...o, intent: true } : o));
  if (event.type === "output_applied" || event.type === "output_failed" || event.type === "output_dropped") {
    return withOutput(state, event.key, (o) =>
      o.status !== "dry_run" || !o.intent
        ? o
        : event.type === "output_applied"
          ? { ...o, status: "applied", ...(event.url === undefined ? {} : { url: event.url }), ...(event.remote_id === undefined ? {} : { remoteId: event.remote_id }) }
          : event.type === "output_dropped"
            ? { ...o, status: "dropped", preview: event.note }
            : { ...o, status: "failed", error: event.error },
    );
  }
  if (event.type === "attempt_stopped") return stopped(state, event.step, event.n, event.cost, event.at);
  if (event.type === "run_finished") return { ...state, owed: [] };
  return state;
}

function step(state: RunState, event: Exclude<RunEvent, { type: "run_admitted" }>): Transition {
  switch (event.type) {
    case "step_started": {
      const s = stepOf(state, event.step);
      const owed = state.owed.some((a) => a.type === "start_attempt" && a.step === event.step && a.n === event.n);
      if (s?.status !== "running" || s.attempts.some((a) => a.n === event.n) || !owed) return { state, actions: [] };
      const action = state.owed.find((a): a is Extract<Action, { type: "start_attempt" }> => a.type === "start_attempt" && a.step === event.step && a.n === event.n)!;
      const attempt: AttemptState = {
        n: event.n,
        status: "running",
        reason: null,
        startedAt: event.at,
        endedAt: null,
        model: event.model,
        ...(event.engine === undefined ? {} : { engine: event.engine }),
        ...(event.effort === undefined ? {} : { effort: event.effort }),
        computer: event.computer,
        ...(event.thread_id === undefined ? {} : { threadId: event.thread_id }),
        session: event.session,
        ...(event.start_sha === undefined ? {} : { startSha: event.start_sha }),
        ...(action.candidate === undefined ? {} : { candidate: action.candidate }),
        checks: [],
        cost: NO_COST,
        sha: null,
      };
      // An attempt that failed before its checkout existed recorded no start; the next one that has one sets it.
      const startSha = s.startSha === undefined && event.start_sha !== undefined ? { startSha: event.start_sha } : {};
      return { state: withStep(state, event.step, (x) => ({ ...x, ...startSha, attempts: [...x.attempts, attempt] })), actions: [] };
    }
    case "attempt_finished": {
      if (current(state, event.step, event.n) === undefined) return { state, actions: [] };
      const recorded = withStep(state, event.step, (s) => withAttempt(s, event.n, (a) => ({ ...a, result: event.result, cost: addCost(a.cost, event.cost) })));
      return afterCheck(settle(recorded, (a) => a.type === "start_attempt" && aboutAttempt(a, event.step, event.n)), event.step, event.n, -1, event.at);
    }
    case "check_result": {
      const attempt = current(state, event.step, event.n);
      const check = planStep(state, event.step).checks[event.index];
      if (attempt === undefined || attempt.result === undefined || check === undefined || event.index !== attempt.checks.length) return { state, actions: [] };
      const owed = state.owed.some((a) => a.type === "run_check" && aboutAttempt(a, event.step, event.n) && a.index === event.index);
      if (!owed) return { state, actions: [] };
      const recorded: CheckState = {
        index: event.index,
        check: check.kind === "command" ? check.command : `agent:${check.agent}`,
        kind: check.kind,
        passed: event.passed,
        ...(event.exit === undefined ? {} : { exit: event.exit }),
        ...(event.ms === undefined ? {} : { ms: event.ms }),
        ...(event.decision === undefined ? {} : { decision: event.decision }),
        ...(event.text === undefined ? {} : { text: event.text }),
        ...(event.thread_id === undefined ? {} : { threadId: event.thread_id }),
      };
      const next = settle(
        withStep(state, event.step, (s) => withAttempt(s, event.n, (a) => ({ ...a, checks: [...a.checks, recorded], cost: addCost(a.cost, event.cost) }))),
        (a) => a.type === "run_check" && aboutAttempt(a, event.step, event.n),
      );
      if (!event.passed) return attemptFailed(next, event.step, event.n, check.kind === "command" ? "checks_failed" : "review_rejected", undefined, event.at);
      return afterCheck(next, event.step, event.n, event.index, event.at);
    }
    case "graded": {
      const attempt = current(state, event.step, event.n);
      if (attempt === undefined || !state.owed.some((a) => a.type === "grade" && aboutAttempt(a, event.step, event.n))) return { state, actions: [] };
      const grade: GradeState = { satisfied: event.satisfied, text: event.text, ...(event.thread_id === undefined ? {} : { threadId: event.thread_id }) };
      const next = settle(
        withStep(state, event.step, (s) => withAttempt(s, event.n, (a) => ({ ...a, grade, cost: addCost(a.cost, event.cost) }))),
        (a) => a.type === "grade" && aboutAttempt(a, event.step, event.n),
      );
      if (!event.satisfied) return attemptFailed(next, event.step, event.n, "outcome_unmet", event.text, event.at);
      return attemptPassed(next, event.step, event.n, event.at);
    }
    case "picked": {
      const s = stepOf(state, event.step);
      const owed = state.owed.find((a): a is Extract<Action, { type: "pick" }> => a.type === "pick" && a.step === event.step);
      if (s?.status !== "running" || owed === undefined) return { state, actions: [] };
      const candidates = s.attempts.filter((a) => owed.candidates.includes(a.n));
      const named = event.n === null ? undefined : candidates.find((a) => a.n === event.n);
      // §4.3: an invalid choice takes the lowest-cost candidate, and the record says so.
      const chosen = named ?? candidates.toSorted((a, b) => a.cost.usd - b.cost.usd || a.n - b.n)[0]!;
      const charged = event.cost === undefined ? s : withAttempt(s, chosen.n, (a) => ({ ...a, cost: addCost(a.cost, event.cost) }));
      const next = settle(
        withStep(state, event.step, () => ({ ...charged, ...(named === undefined ? { pickNote: "pick_invalid" as const } : {}) })),
        (a) => a.type === "pick" && a.step === event.step,
      );
      return choose(next, event.step, chosen.n, event.at);
    }
    case "attempt_stopped":
      return { state: stopped(state, event.step, event.n, event.cost, event.at), actions: [] };
    case "attempt_failed": {
      if (current(state, event.step, event.n) === undefined) return { state, actions: [] };
      const charged = withStep(state, event.step, (s) => withAttempt(s, event.n, (a) => ({ ...a, cost: addCost(a.cost, event.cost) })));
      return attemptFailed(charged, event.step, event.n, event.reason, event.message, event.at);
    }
    case "attempt_committed": {
      const attempt = current(state, event.step, event.n);
      if (attempt === undefined || !state.owed.some((a) => a.type === "commit" && aboutAttempt(a, event.step, event.n))) return { state, actions: [] };
      return stepSucceeded(settle(state, (a) => a.type === "commit" && aboutAttempt(a, event.step, event.n)), event.step, event.n, event.sha, event.at);
    }
    case "timer_fired": {
      const s = stepOf(state, event.step);
      if (s?.status !== "waiting" || s.approval !== undefined || !state.owed.some((a) => a.type === "wait_until" && a.step === event.step)) return { state, actions: [] };
      const fired = settle(
        withStep(state, event.step, (x) => ({ ...x, status: "succeeded", reason: null, result: { summary: `Waited until ${event.at}.` } })),
        (a) => a.type === "wait_until" && a.step === event.step,
      );
      return advance(fired, event.at);
    }
    case "approval_answered":
    case "approval_expired": {
      const s = stepOf(state, event.step);
      if (s?.status !== "waiting" || s.approval === undefined || s.approval.decision !== undefined) return { state, actions: [] };
      const approved = event.type === "approval_answered" && event.decision === "approve";
      const approval: ApprovalState = {
        ...s.approval,
        ...(event.type === "approval_answered"
          ? { decision: event.decision, decidedAt: event.at, ...(event.by === undefined ? {} : { decidedBy: event.by }), ...(event.message === undefined ? {} : { message: event.message }) }
          : {}),
      };
      const reason: Reason | null = approved ? null : event.type === "approval_expired" ? "approval_expired" : "approval_rejected";
      if (s.approval.before === true) {
        // A gate before the step: approved, it waits its turn to start like any ready step; else it fails unrun.
        const decided = settle(
          withStep(state, event.step, (x) => {
            const { waitingUntil: _w, ...rest } = x;
            return { ...rest, approval, status: approved ? "pending" : "failed", reason };
          }),
          (a) => a.type === "await_approval" && a.step === event.step,
        );
        return advance(decided, event.at);
      }
      const answered = settle(
        withStep(state, event.step, (x) => ({ ...x, approval, status: approved ? "succeeded" : "failed", reason })),
        (a) => a.type === "await_approval" && a.step === event.step,
      );
      return then({ state: answered, actions: [{ type: "release_step", step: event.step }] }, (st) => advance(st, event.at));
    }
    case "output_intent":
      return { state: withOutput(state, event.key, (o) => ({ ...o, intent: true })), actions: [] };
    case "output_applied":
      return outputDone(state, event.key, (o) => ({ ...o, status: "applied", ...(event.url === undefined ? {} : { url: event.url }), ...(event.remote_id === undefined ? {} : { remoteId: event.remote_id }) }), event.at);
    case "output_dry_run":
      return outputDone(state, event.key, (o) => ({ ...o, status: "dry_run", preview: event.preview }), event.at);
    case "output_failed":
      return outputDone(state, event.key, (o) => ({ ...o, status: "failed", error: event.error }), event.at);
    case "output_dropped":
      return outputDone(state, event.key, (o) => ({ ...o, status: "dropped", preview: event.note }), event.at);
    case "run_cancelled":
      return cancel(state, event.reason, event.cost, event.at);
    case "run_resumed":
      return resume(state, event.at);
    case "run_finished":
      return { state, actions: [] };
  }
}

/** After the agent's result (index -1) or a passing check: the next check, the grader, or the attempt passed. */
function afterCheck(state: RunState, step: string, n: number, index: number, at: string): Transition {
  const plan = planStep(state, step);
  if (index + 1 < plan.checks.length) return emit(state, { type: "run_check", step, n, index: index + 1 });
  if (plan.outcome !== undefined && stepKind(plan) === "agent") return emit(state, { type: "grade", step, n });
  return attemptPassed(state, step, n, at);
}

/** Everything about attempt n passed: a single attempt goes on; a parallel one becomes a candidate (§4.3). */
function attemptPassed(state: RunState, step: string, n: number, at: string): Transition {
  const plan = planStep(state, step);
  if ((plan.parallel ?? 1) < 2) return commitOrSucceed(state, step, n, at);
  const marked = withStep(state, step, (s) => withAttempt(s, n, (a) => ({ ...a, passed: true })));
  if (plan.pick === "first") return choose(marked, step, n, at);
  return roundSettled(marked, step, at);
}

/** The attempts of the round attempt n belongs to (parallel steps start N at a time). */
function roundOf(state: RunState, step: string): ReadonlyArray<AttemptState> {
  const s = stepOf(state, step)!;
  const width = planStep(state, step).parallel ?? 1;
  const last = s.attempts.at(-1);
  if (last === undefined) return [];
  const round = Math.ceil(last.n / width);
  return s.attempts.filter((a) => Math.ceil(a.n / width) === round);
}

/** An attempt of the step not yet started, or started and not yet through its checks. */
const stillWorking = (state: RunState, step: string): boolean =>
  state.owed.some((a) => a.type === "start_attempt" && a.step === step) || roundOf(state, step).some((a) => a.status === "running" && a.passed !== true);

/** pick: best, once every attempt of the round has settled: none passed fails the round, one wins, two or more go to the pick. */
function roundSettled(state: RunState, step: string, at: string): Transition {
  const round = roundOf(state, step);
  if (stillWorking(state, step)) return { state, actions: [] };
  const passed = round.filter((a) => a.passed === true);
  if (passed.length === 1) return choose(state, step, passed[0]!.n, at);
  if (passed.length > 1) return emit(state, { type: "pick", step, candidates: passed.map((a) => a.n) });
  return roundFailed(state, step, at);
}

/**
 * The chosen attempt goes on. The others step aside: one that passed is not picked, one still working stops, and
 * one owed a start that never began never starts.
 */
function choose(state: RunState, step: string, n: number, at: string): Transition {
  const s = stepOf(state, step)!;
  // A loser of an earlier round (whose winner failed at its commit) may still be stopping: it is stopped once.
  const working = s.attempts.filter((a) => a.n !== n && a.status === "running" && a.passed !== true && !beingStopped(state, step, a.n)).map((a) => a.n);
  const marked = withStep(state, step, (x) => ({
    ...x,
    chosen: n,
    attempts: x.attempts.map((a) => (a.n !== n && a.status === "running" && a.passed === true ? { ...dropKey(a, "passed"), status: "skipped", reason: "not_picked", endedAt: at } : a)),
  }));
  const cleared = settle(marked, (a) => aboutStep(a, step) && "n" in a && a.n !== n && a.type !== "stop_attempt");
  return then(emit(cleared, ...working.map((m): Action => ({ type: "stop_attempt", step, n: m }))), (st) => commitOrSucceed(st, step, n, at));
}

/** An attempt another beat (or a failed step) stopped: its end is recorded, and its cost stays in the record. */
function stopped(state: RunState, step: string, n: number, cost: Cost | undefined, at: string): RunState {
  const s = stepOf(state, step);
  const attempt = s?.attempts.find((a) => a.n === n);
  const cleared = settle(state, (a) => aboutAttempt(a, step, n));
  if (attempt === undefined || attempt.status !== "running") return cleared;
  const lost = s!.chosen !== undefined && s!.chosen !== n;
  return withStep(cleared, step, (x) =>
    withAttempt(x, n, (a) => ({ ...dropKey(a, "passed"), status: lost ? "skipped" : "cancelled", reason: lost ? "not_picked" : "cancelled", endedAt: at, cost: addCost(a.cost, cost) })),
  );
}

function commitOrSucceed(state: RunState, step: string, n: number, at: string): Transition {
  const plan = planStep(state, step);
  if (plan.computer === "full") return emit(state, { type: "commit", step, n });
  return stepSucceeded(state, step, n, null, at);
}

function stepSucceeded(state: RunState, step: string, n: number, sha: string | null, at: string): Transition {
  const plan = planStep(state, step);
  const cleaned = withStep(state, step, (s): StepState => {
    const attempt = s.attempts.find((a) => a.n === n)!;
    return {
      ...withAttempt(s, n, (a) => ({ ...dropKey(a, "passed"), status: "succeeded", reason: null, endedAt: at, sha })),
      status: plan.approve === undefined ? "succeeded" : "waiting",
      reason: null,
      sha,
      ...(attempt.result === undefined ? {} : { result: attempt.result }),
      ...(attempt.result?.decision === undefined ? {} : { decision: attempt.result.decision }),
    };
  });
  if (plan.approve !== undefined) {
    // §5.1: the gate comes after the step succeeds, before its outputs and its dependents.
    const until = new Date(Date.parse(at) + plan.approve.timeoutMs).toISOString();
    const waiting = withStep(cleaned, step, (s) => ({ ...s, waitingUntil: until, approval: { by: plan.approve!.by, askedAt: at, expiresAt: until } }));
    return then(emit(waiting, { type: "await_approval", step, by: plan.approve.by, until }), (st) => advance(st, at));
  }
  return then({ state: cleaned, actions: [{ type: "release_step", step }] }, (st) => advance(st, at));
}

const dropKey = <T extends object, K extends keyof T>(value: T, key: K): T => {
  const { [key]: _drop, ...rest } = value;
  return rest as T;
};

/** The rung attempt k (2 and later) runs on, after `failures` failed attempts: the last rung repeats. */
function rungFor(plan: PlanStep, failures: number): PlanRung | undefined {
  const ladder = ladderOf(plan);
  return ladder.length === 0 ? undefined : ladder[Math.min(failures - 1, ladder.length - 1)];
}

/** What a retry after this many failures asks for, and whether it may continue the session. */
function retryOf(plan: PlanStep, failures: number, previous: AttemptState): { asked: string; escalated: boolean; session: "new" | "continue"; engine?: string; effort?: string } {
  const rung = rungFor(plan, failures);
  const asked = rung?.model ?? plan.model;
  const engine = rung?.engine;
  const sameEngine = engine === undefined || engine === previous.engine;
  return {
    asked,
    escalated: rung !== undefined,
    session: asked === previous.model.asked && sameEngine ? "continue" : "new",
    ...(engine === undefined ? {} : { engine }),
    ...(rung?.effort === undefined ? {} : { effort: rung.effort }),
  };
}

function attemptFailed(state: RunState, step: string, n: number, reason: Reason, message: string | undefined, at: string): Transition {
  const cleanFailed = settle(
    withStep(state, step, (s) => withAttempt(s, n, (a) => ({ ...dropKey(a, "passed"), status: "failed", reason, endedAt: at, ...(message === undefined ? {} : { message }) }))),
    (a) => aboutAttempt(a, step, n),
  );
  const plan = planStep(cleanFailed, step);
  if ((plan.parallel ?? 1) > 1) {
    if (stepOf(cleanFailed, step)!.chosen === n) {
      // §4.4: the chosen attempt failed at its commit. The rest of its round already stepped aside (not picked, or
      // being stopped), so the round failed and nothing is chosen.
      const unchosen = withStep(cleanFailed, step, (s) => dropKey(dropKey(s, "chosen"), "pickNote"));
      return RETRYABLE.has(reason) ? roundFailed(unchosen, step, at, { n, reason }) : stepFailed(unchosen, step, reason, at);
    }
    // §2.1: a reason no retry can fix (an empty run wallet, say) fails the step at once, under either pick.
    if (!RETRYABLE.has(reason) && reason !== "outcome_unmet") return stepFailed(cleanFailed, step, reason, at);
    // §4.3: a parallel attempt that failed is one fewer candidate; the round decides once all of it settled.
    if (plan.pick === "first" && stillWorking(cleanFailed, step)) return { state: cleanFailed, actions: [] };
    return roundSettled(cleanFailed, step, at);
  }
  const attempts = stepOf(cleanFailed, step)!.attempts;
  const attempt = attempts.find((a) => a.n === n)!;
  if (reason === "outcome_unmet") {
    // The rubric's own count: the step runs at most max_iterations times to meet it, each time with the grader's feedback.
    const graded = attempts.filter((a) => a.grade !== undefined).length;
    if (graded < (plan.outcome?.maxIterations ?? 1)) {
      return emit(cleanFailed, {
        type: "start_attempt",
        step,
        n: n + 1,
        asked: attempt.model.asked,
        escalated: false,
        session: "continue",
        failures: `The grader checked this work against the rubric and it falls short:\n${message ?? ""}`,
        ...(attempt.engine === undefined ? {} : { engine: attempt.engine }),
      });
    }
    return stepFailed(cleanFailed, step, reason, at);
  }
  const failures = attempts.filter((a) => a.status === "failed" && a.reason !== "outcome_unmet").length;
  if (RETRYABLE.has(reason) && failures <= plan.retries) {
    // §3.3: attempts after a failure climb the escalation ladder, one rung per failure.
    const retry = retryOf(plan, failures, attempt);
    const text = failureText(cleanFailed.run, step, attempt);
    return emit(cleanFailed, { type: "start_attempt", step, n: n + 1, ...retry, ...(text === undefined ? {} : { failures: text }) });
  }
  return stepFailed(cleanFailed, step, reason, at);
}

/**
 * A parallel round where no attempt passed, or whose chosen attempt (`chosen`) failed: retries re-run the whole
 * fan-out (§4.3), else the step fails.
 */
function roundFailed(state: RunState, step: string, at: string, chosen?: { readonly n: number; readonly reason: Reason }): Transition {
  const plan = planStep(state, step);
  const width = plan.parallel ?? 1;
  const s = stepOf(state, step)!;
  const rounds = Math.ceil((s.attempts.at(-1)?.n ?? 0) / width);
  if (rounds <= plan.retries) {
    const previous = chosen === undefined ? s.attempts.at(-1)! : s.attempts.find((a) => a.n === chosen.n)!;
    const retry = retryOf(plan, rounds, previous);
    const text = failureText(state.run, step, previous);
    const starts: Action[] = Array.from({ length: width }, (_, i) => ({
      type: "start_attempt" as const,
      step,
      n: rounds * width + i + 1,
      ...retry,
      // Each attempt of a new round runs in its own new copy.
      session: "new" as const,
      candidate: i + 1,
      ...(text === undefined ? {} : { failures: text }),
    }));
    return emit(state, ...starts);
  }
  return stepFailed(state, step, chosen?.reason ?? "checks_failed", at);
}

function stepFailed(state: RunState, step: string, reason: Reason, at: string): Transition {
  const failed = settle(
    withStep(state, step, (s) => ({ ...s, status: "failed", reason })),
    (a) => aboutStep(a, step) && a.type !== "stop_attempt",
  );
  const stopping = (m: number) => failed.owed.some((a) => a.type === "stop_attempt" && aboutAttempt(a, step, m));
  const stops: Action[] = stepOf(failed, step)!.attempts.filter((a) => a.status === "running" && !stopping(a.n)).map((a) => ({ type: "stop_attempt", step, n: a.n }));
  return then(emit(failed, { type: "release_step", step }, ...stops), (st) => advance(st, at));
}

/** §3.5: each failed command check's exit and output tail, each agent check's summary, or the error; 24 KiB at most, cut from the head. */
export function failureText(run: string, step: string, attempt: AttemptState): string | undefined {
  const parts: string[] = [];
  for (const check of attempt.checks) {
    if (check.passed) continue;
    if (check.kind === "command") {
      const exit = check.exit === undefined ? "did not finish" : `exited ${check.exit}`;
      parts.push(`The check \`${check.check}\` ${exit}. The end of its output:\n${check.text ?? ""}`);
    } else {
      parts.push(`The check ${check.check} decided ${check.decision ?? "nothing"}. Its findings:\n${check.text ?? ""}`);
    }
  }
  if (parts.length === 0 && attempt.message !== undefined) parts.push(attempt.message);
  if (parts.length === 0) return undefined;
  return capFromHead(parts.join("\n\n"), FAILURES_MAX_BYTES, `[Earlier text cut. The full check output is in the run record, attempt ${attemptId(run, step, attempt.n)}.]\n`);
}

/** The last `max` bytes of `text` (UTF-8), behind `marker` when anything was cut. */
export function capFromHead(text: string, max: number, marker: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  const keep = Math.max(0, max - Buffer.byteLength(marker, "utf8"));
  // Drop a split character at the cut.
  return marker + bytes.subarray(bytes.length - keep).toString("utf8").replace(/^�+/, "");
}

/** Whether a step's `if` holds: every key names a step that decided that value (or failed, for `failed`). */
export function ifHolds(condition: Readonly<Record<string, string>> | undefined, steps: ReadonlyArray<StepState>): boolean {
  return Object.entries(condition ?? {}).every(([ref, value]) => {
    const s = steps.find((x) => x.name === ref);
    if (s === undefined) return false;
    return value === "failed" ? s.status === "failed" : s.status === "succeeded" && s.decision === value;
  });
}

/** A step's needs and theirs, in file order: what its data blocks carry in a graph. */
export function needsOf(plan: RunPlan, name: string): ReadonlyArray<string> {
  const all = new Set<string>();
  const visit = (step: string) => {
    for (const need of plan.steps.find((s) => s.name === step)?.needs ?? []) {
      if (all.has(need) || need === name) continue;
      all.add(need);
      visit(need);
    }
  };
  visit(name);
  return plan.steps.map((s) => s.name).filter((s) => all.has(s));
}

/** Starts a step: a timer waits, anything else gets its first attempt (N at once when parallel). */
/**
 * A ready step whose plan has a gate (M1) not yet approved waits for the owner first: asked at once, taking no turn
 * and no place among the steps going at once. undefined: it may start.
 */
function gateFirst(state: RunState, name: string, at: string): Transition | undefined {
  const plan = planStep(state, name);
  const approval = stepOf(state, name)?.approval;
  if (plan.gate === undefined || (approval?.before === true && approval.decision === "approve")) return undefined;
  const until = new Date(Date.parse(at) + plan.gate.timeoutMs).toISOString();
  const waiting = withStep(state, name, (s) => ({ ...s, status: "waiting", waitingUntil: until, approval: { by: plan.gate!.by, askedAt: at, expiresAt: until, before: true } }));
  return emit(waiting, { type: "await_approval", step: name, by: plan.gate.by, until });
}

function startStep(state: RunState, name: string, at: string): Transition {
  const plan = planStep(state, name);
  if (stepKind(plan) === "wait") {
    const until = new Date(Date.parse(at) + (plan.waitMs ?? 0)).toISOString();
    const waiting = withStep(state, name, (s) => ({ ...s, status: "waiting", waitingUntil: until }));
    return emit(waiting, { type: "wait_until", step: name, until });
  }
  const running = withStep(state, name, (s) => ({ ...s, status: "running" }));
  const width = plan.parallel ?? 1;
  const starts: Action[] = Array.from({ length: width }, (_, i) => ({
    type: "start_attempt" as const,
    step: name,
    n: i + 1,
    asked: plan.model,
    escalated: false,
    session: "new" as const,
    ...(width > 1 ? { candidate: i + 1 } : {}),
  }));
  return emit(running, ...starts);
}

/** Sequential mode (§1.1): the next step to start, skipping those whose turn is over, else the outputs. */
function advanceInOrder(state: RunState, at: string): Transition {
  let next = state;
  if (next.steps.some((s) => s.status === "running" || s.status === "waiting")) return { state: next, actions: [] };
  for (let i = 0; i < next.steps.length; i++) {
    const step = next.steps[i]!;
    if (step.status !== "pending") continue;
    const plan = next.plan.steps[i]!;
    const earlier = next.steps.slice(0, i);
    const failed = earlier.filter((s) => s.status === "failed").map((s) => s.name);
    // §2.2: after a failure only a step whose if names that failure with `failed` may start.
    const handles = Object.entries(plan.if ?? {}).some(([ref, value]) => value === "failed" && failed.includes(ref));
    const skip: Reason | undefined = failed.length > 0 && !handles ? "need_failed" : !ifHolds(plan.if, earlier) ? "condition_false" : undefined;
    if (skip !== undefined) {
      next = withStep(next, step.name, (s) => ({ ...s, status: "skipped", reason: skip }));
      continue;
    }
    return gateFirst(next, step.name, at) ?? startStep(next, step.name, at);
  }
  return outputsOrFinish(next, at);
}

/**
 * Graph mode (§1.2-1.4): every pending step whose needs are all done starts, in file order, up to the run's limit;
 * a step whose needs did not all succeed (or whose if is false) is skipped, which may free others, so it loops.
 * Steps that write the run's branch (computer: full) take turns: one at a time.
 */
function advanceGraph(state: RunState, at: string): Transition {
  let current = state;
  const actions: Action[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    const failed = current.steps.filter((s) => s.status === "failed").map((s) => s.name);
    for (const step of current.steps) {
      if (step.status !== "pending") continue;
      const plan = planStep(current, step.name);
      const needs = (plan.needs ?? []).map((n) => stepOf(current, n)).filter((s): s is StepState => s !== undefined);
      if (needs.some((s) => !stepDone(s.status))) continue;
      const handles = Object.entries(plan.if ?? {}).some(([ref, value]) => value === "failed" && failed.includes(ref));
      const handled = (need: StepState) => need.status === "failed" && plan.if?.[need.name] === "failed";
      const skip: Reason | undefined =
        failed.length > 0 && !handles
          ? "need_failed"
          : needs.some((s) => s.status === "skipped")
            ? "need_skipped"
            : needs.some((s) => s.status !== "succeeded" && !handled(s))
              ? "need_not_succeeded"
              : !ifHolds(plan.if, current.steps)
                ? "condition_false"
                : undefined;
      if (skip !== undefined) {
        current = withStep(current, step.name, (s) => ({ ...s, status: "skipped", reason: skip }));
        changed = true;
        continue;
      }
      const gated = gateFirst(current, step.name, at);
      if (gated !== undefined) {
        current = gated.state;
        actions.push(...gated.actions);
        changed = true;
        continue;
      }
      const running = current.steps.filter((s) => s.status === "running");
      if (running.length >= (current.plan.limit ?? STEP_LIMIT)) break;
      const writes = (name: string) => {
        const p = planStep(current, name);
        return stepKind(p) !== "wait" && p.computer === "full";
      };
      if (writes(step.name) && running.some((s) => writes(s.name))) continue;
      const started = startStep(current, step.name, at);
      current = started.state;
      actions.push(...started.actions);
      changed = true;
    }
  }
  if (current.steps.every((s) => stepDone(s.status))) return then({ state: current, actions }, (st) => outputsOrFinish(st, at));
  return { state: current, actions };
}

function advance(state: RunState, at: string): Transition {
  return isGraphPlan(state.plan) ? advanceGraph(state, at) : advanceInOrder(state, at);
}

/** §7.2: in declaration order, each only if its step succeeded; then the run's status (§2.3). */
function outputsOrFinish(state: RunState, at: string): Transition {
  let next = state;
  if (next.owed.some((a) => a.type === "output" || a.type === "finish")) return { state: next, actions: [] };
  for (const output of next.outputs) {
    if (output.status !== "pending") continue;
    if (stepOf(next, output.step)?.status !== "succeeded") {
      next = withOutput(next, output.key, (o) => ({ ...o, status: "dropped" }));
      continue;
    }
    return emit(next, { type: "output", key: output.key, mode: next.plan.apply ? "apply" : "preview" });
  }
  const failedStep = next.steps.find((s) => s.status === "failed");
  const outputFailed = next.outputs.some((o) => o.status === "failed");
  const status: RunStatus = failedStep !== undefined || outputFailed ? "failed" : "succeeded";
  const reason: Reason | null = failedStep !== undefined ? failedStep.reason : outputFailed ? "output_failed" : null;
  const ended: RunState = { ...next, status, reason, endedAt: at };
  // Finish is the run's last action: run_finished settles everything, so a stop still under way would be lost to a
  // restart after it. The last stop to land hands it out (next).
  return next.owed.some((a) => a.type === "stop_attempt") ? { state: ended, actions: [] } : emit(ended, { type: "finish" });
}

function withOutput(state: RunState, key: string, update: (o: OutputState) => OutputState): RunState {
  return { ...state, outputs: state.outputs.map((o) => (o.key === key ? update(o) : o)) };
}

function outputDone(state: RunState, key: string, update: (o: OutputState) => OutputState, at: string): Transition {
  if (!state.owed.some((a) => a.type === "output" && a.key === key)) return { state: withOutput(state, key, update), actions: [] };
  return outputsOrFinish(settle(withOutput(state, key, update), (a) => a.type === "output" && a.key === key), at);
}

/**
 * §8.3: running and waiting steps cancelled, pending ones skipped, unapplied outputs dropped; the workspace stays. An
 * attempt being stopped (a loser, or the rest of a failed step) ends as that stop would have ended it: the cancel
 * replaces what is owed, its stop too.
 */
function cancel(before: RunState, reason: CancelReason, cost: Cost | undefined, at: string): Transition {
  const state = before.owed.reduce((st, a) => (a.type === "stop_attempt" ? stopped(st, a.step, a.n, undefined, at) : st), before);
  const live = state.steps.filter((s) => s.status === "running" || s.status === "waiting").map((s) => s.name);
  let charged = false;
  const steps = state.steps.map((s): StepState => {
    if (s.status === "running" || s.status === "waiting") {
      const attempts = s.attempts.map((a) => {
        if (a.status !== "running") return a;
        // The run's cost since the last record lands on the first attempt still going.
        const share = charged ? undefined : cost;
        charged = true;
        return { ...a, status: "cancelled" as const, reason, endedAt: at, cost: addCost(a.cost, share) };
      });
      return { ...s, status: "cancelled", reason, attempts };
    }
    return s.status === "pending" ? { ...s, status: "skipped", reason: "run_cancelled" } : s;
  });
  const outputs = state.outputs.map((o): OutputState => (o.status === "pending" ? { ...o, status: "dropped" } : o));
  return {
    state: { ...state, steps, outputs, status: "cancelled", reason, endedAt: at, owed: [{ type: "finish" }] },
    actions: [...live.map((step): Action => ({ type: "release_step", step })), { type: "finish" }],
  };
}

/**
 * After a restart: what the runner owed is done again (a timer re-armed at the same deadline, an approval asked
 * again), except an agent turn that was under way. That attempt cannot be picked up where it was, so it fails
 * (`agent_error`) and the retry rules decide; a parallel attempt that was being stopped is recorded as stopped.
 */
function resume(state: RunState, at: string): Transition {
  if (state.owed.length === 0) return advance(state, at);
  let result: Transition = { state, actions: [] };
  for (const action of state.owed) {
    const now = result.state;
    if (!now.owed.includes(action)) continue;
    if (action.type === "start_attempt" && current(now, action.step, action.n) !== undefined) {
      if (now.owed.some((a) => a.type === "stop_attempt" && a.step === action.step && a.n === action.n)) {
        result = { state: stopped(now, action.step, action.n, undefined, at), actions: result.actions };
        continue;
      }
      result = then(result, (st) => attemptFailed(st, action.step, action.n, "agent_error", "The runtime restarted while this attempt ran, so it was stopped.", at));
      continue;
    }
    if (action.type === "stop_attempt") {
      result = { state: stopped(now, action.step, action.n, undefined, at), actions: result.actions };
      continue;
    }
    result = { state: result.state, actions: [...result.actions, action] };
  }
  return result;
}

/** Every step terminal and nothing owed: the runner may forget the run. */
export const finished = (state: RunState): boolean => isTerminal(state.status) && state.steps.every((s) => stepDone(s.status));
