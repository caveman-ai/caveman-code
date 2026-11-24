// Bounded model check of the run machine (machine.ts `next`, `replay`, `planOf`): from plans that real automation
// files make (checkProject, then planOf), every event the runner can append for every action it is doing, plus a
// restart and a cancel at any point, in every order. Read .claude/skills/automation-run-machine/SKILL.md before
// changing this file or the code it covers.
import { checkProject, type AgentInfo } from "@caveman-app/automations";
import { assertHolds, canonicalKey, check, type Step } from "@caveman-app/model-check";
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { stringify } from "yaml";

import {
  isTerminal,
  next,
  planOf,
  replay,
  type Action,
  type AttemptFailure,
  type CancelReason,
  type PlanStep,
  type Reason,
  type RunEvent,
  type RunPlan,
  type RunState,
  type StepState,
} from "./machine.ts";

// ------------------------------------------------------------------ plans from real files

const AGENTS: ReadonlyArray<AgentInfo> = [
  {
    name: "reviewer",
    description: "Reviews a change.",
    decides: ["approve", "request_changes"],
    source: "builtin",
  },
];

/** The plan the runner admits for this file text (runner.ts admit), or undefined when check blocks the file. */
function admit(
  name: string,
  text: string,
  options: { readonly untrusted?: boolean; readonly apply?: boolean } = {},
): RunPlan | undefined {
  const path = `.caveman/automations/${name}.yaml`;
  const target = /^host: cloud$/m.test(text) ? "cloud" : "code";
  const project = checkProject({ files: [{ path, text }], agents: AGENTS, target });
  const loaded = project.automations.find((a) => a.path === path);
  if (loaded === undefined || project.diagnostics.some((d) => d.severity === "error"))
    return undefined;
  return planOf(loaded.file, project.agents, options.apply ?? true, name, {
    untrusted: options.untrusted === true,
  });
}

interface Fixture {
  readonly name: string;
  readonly yaml: string;
  /** The trigger's text came from outside the trusted people, and these steps can write (SECURITY M1). */
  readonly untrusted?: { readonly gates: ReadonlyArray<string> };
  readonly apply?: boolean;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    name: "retry-ladder",
    yaml: `steps:
  fix:
    prompt: Fix the failing test.
    retries: 2
    escalate: [{ model: frontier }, { engine: codex }]
    checks: [pnpm test, { agent: reviewer }]
`,
  },
  {
    name: "triage-implement",
    yaml: `on: { github: { event: issues.labeled, label: caveman } }
steps:
  triage:
    prompt: Decide whether to implement it.
    decides: [implement, skip]
    model: fast
    computer: none
  implement:
    if: { triage: implement }
    prompt: Implement it.
    computer: full
    retries: 1
    checks: [pnpm test]
  report:
    if: { implement: failed }
    prompt: Say what went wrong.
    model: fast
    computer: none
outputs:
  github.pull_request: { from: implement }
  github.comment: report.summary
`,
  },
  {
    name: "wait-approve-dry-run",
    apply: false,
    yaml: `steps:
  cool-off:
    wait: 1h
  report:
    prompt: Summarise the week.
    model: fast
    computer: none
    approve: { by: owner }
outputs:
  github.comment: report.summary
`,
  },
  {
    name: "rubric",
    yaml: `steps:
  notes:
    prompt: Write the release notes.
    retries: 1
    escalate: frontier
    checks: [pnpm lint]
    outcome: { rubric: Every merged change is listed., max_iterations: 2 }
`,
  },
  {
    name: "parallel-best",
    yaml: `steps:
  solve:
    prompt: Make the build pass.
    computer: full
    parallel: 2
    pick: best
    retries: 1
    checks: [pnpm test]
`,
  },
  {
    name: "parallel-first",
    yaml: `steps:
  hunt:
    prompt: Find the flaky test.
    parallel: 3
    pick: first
    checks: [pnpm test]
`,
  },
  {
    name: "parallel-first-full",
    yaml: `steps:
  patch:
    prompt: Patch the bug.
    computer: full
    parallel: 2
    pick: first
    checks: [pnpm test]
`,
  },
  {
    name: "parallel-then-handler",
    yaml: `steps:
  try:
    prompt: Try the fix.
    parallel: 2
    checks: [pnpm test]
  report:
    if: { try: failed }
    prompt: Say why it failed.
    model: fast
    computer: none
`,
  },
  {
    name: "graph-turns",
    yaml: `steps:
  plan:
    prompt: Plan the change.
    model: fast
    computer: none
  api:
    needs: [plan]
    prompt: Change the API.
    computer: full
    checks: [pnpm test]
  web:
    needs: [plan]
    prompt: Change the web app.
    computer: full
  notify:
    needs: [api, web]
    if: { api: failed }
    prompt: Say the API change failed.
    model: fast
    computer: none
outputs:
  github.pull_request: { from: web }
`,
  },
  {
    name: "graph-wait-run",
    yaml: `steps:
  build:
    run: pnpm build
  settle:
    wait: 10m
  smoke:
    needs: [build, settle]
    prompt: Check the deploy.
    parallel: 2
    checks: [pnpm smoke]
`,
  },
  {
    name: "untrusted-slack",
    untrusted: { gates: ["change"] },
    yaml: `host: cloud
on: { slack: { mention: true } }
steps:
  read:
    prompt: Read the request.
    decides: [change, answer]
    model: fast
  change:
    if: { read: change }
    prompt: Make the change.
    computer: full
    checks: [pnpm test]
  answer:
    prompt: Answer in the thread.
    model: fast
    computer: none
outputs:
  github.pull_request: { from: change }
  slack.message: answer.summary
`,
  },
  {
    name: "untrusted-webhook-graph",
    untrusted: { gates: ["fix", "tell"] },
    yaml: `host: cloud
on: { webhook: {} }
steps:
  read:
    prompt: Read the payload.
    model: fast
  fix:
    needs: [read]
    prompt: Fix it.
    computer: full
    retries: 1
    checks: [pnpm test]
    approve: { by: members }
  tell:
    needs: [read]
    prompt: Tell the team.
    model: fast
    computer: none
outputs:
  slack.message: { from: tell, channel: "#ops" }
`,
  },
];

// ------------------------------------------------------------------ what the runner does and appends

const AT = "2026-11-06T09:00:00.000Z";
/** The sampled-files bound: how many files, how many states each, and the seed that makes a run repeatable. */
const SAMPLED_RUNS = 50;
const SAMPLED_MAX_STATES = 2_000;
const SAMPLED_SEED = 20261106;
const ATTEMPT_FAILURES: ReadonlyArray<AttemptFailure> = [
  "agent_error",
  "timeout",
  "result_invalid",
  "budget_exhausted",
  "engine_unavailable",
  "needs_isolation",
];
/** What runner.ts runCheck and grade append when the check or the grader itself could not run. */
const REVIEW_FAILURES: ReadonlyArray<AttemptFailure> = [
  "timeout",
  "budget_exhausted",
  "agent_error",
];
const CANCEL_REASONS: ReadonlyArray<CancelReason> = [
  "cancelled",
  "superseded",
  "deadline",
  "policy_denied",
];

/**
 * An action runner.ts is performing. `drive` performs every action it is handed at once, whether or not the machine
 * still owes it, and each ends once its events are appended: start_attempt appends step_started and then its result,
 * and an output being applied appends its intent and then its result. `second`: the first of those two has landed.
 */
interface Doing {
  readonly action: Action;
  readonly second?: true;
}

interface World {
  readonly run: RunState;
  /** The journal (journal.ts) that made `run`: what a restart replays. */
  readonly journal: ReadonlyArray<RunEvent>;
  /** The same journal as journal.ts stores and reads it back (each event through JSON). */
  readonly stored: ReadonlyArray<RunEvent>;
  /** What the runner is doing for this run. */
  readonly doing: ReadonlyArray<Doing>;
  /** A property of the transition into this state that broke, named. */
  readonly broke?: string;
}

/** One step of the world: the runner appends what an action it is doing produced, the runtime restarts, or the run is cancelled. */
type Move =
  | {
      readonly kind: "append";
      readonly label: string;
      readonly event: RunEvent;
      readonly from: number;
    }
  | { readonly kind: "restart"; readonly label: string; readonly event?: RunEvent }
  /** `stops`: the cancel first ends each stop it cut short with attempt_stopped; without, reading a stop's cost failed. */
  | {
      readonly kind: "cancel";
      readonly label: string;
      readonly event: RunEvent;
      readonly stops: boolean;
    };

const planStepOf = (state: RunState, name: string): PlanStep =>
  state.plan.steps.find((s) => s.name === name)!;
const stepOf = (state: RunState, name: string): StepState =>
  state.steps.find((s) => s.name === name)!;
const attemptOf = (state: RunState, step: string, n: number) =>
  stepOf(state, step).attempts.find((a) => a.n === n);
/** The machine hands the runner the very action objects it records as owed, so their JSON is their identity. */
const actionKey = (a: Action) => JSON.stringify(a);
const asStored = (event: RunEvent): RunEvent => JSON.parse(JSON.stringify(event)) as RunEvent;

interface Append {
  readonly label: string;
  readonly event: RunEvent;
}
const attemptFailed = (step: string, n: number, reason: AttemptFailure): Append => ({
  label: `attempt_failed ${step}#${n} ${reason}`,
  event: { type: "attempt_failed", at: AT, step, n, reason, message: `${reason} on attempt ${n}` },
});

/**
 * Every event runner.ts can append next while it performs `doing` (perform and the function it calls: startAttempt,
 * runCheck, grade, pickOne, stopAttempt, commit, waitUntil, awaitApproval, writeOutput, finish). perform turns any
 * unplanned failure of a stop into attempt_stopped (with no cost), of any other action that names an attempt into
 * attempt_failed agent_error, of a pick into picked null, and of an output into output_failed.
 */
function appendsFor(state: RunState, doing: Doing): Append[] {
  const { action } = doing;
  switch (action.type) {
    case "start_attempt": {
      const { step, n } = action;
      if (doing.second !== true) {
        const event: RunEvent = {
          type: "step_started",
          at: AT,
          step,
          n,
          model: { asked: action.asked, resolved: action.asked },
          ...(action.engine === undefined ? {} : { engine: action.engine }),
          computer: planStepOf(state, step).computer,
          thread_id: `${step}#${n}`,
          session: action.session,
          start_sha: "base",
        };
        return [{ label: `step_started ${step}#${n}`, event }];
      }
      const decisions = [undefined, ...(planStepOf(state, step).decides ?? [])];
      return [
        ...decisions.map((decision): Append => ({
          label: `attempt_finished ${step}#${n}${decision === undefined ? "" : ` deciding ${decision}`}`,
          event: {
            type: "attempt_finished",
            at: AT,
            step,
            n,
            result: { summary: `${step} done`, ...(decision === undefined ? {} : { decision }) },
          },
        })),
        ...ATTEMPT_FAILURES.map((reason) => attemptFailed(step, n, reason)),
      ];
    }
    case "run_check": {
      const { step, n, index } = action;
      const kind = planStepOf(state, step).checks[index]?.kind;
      const verdict = (passed: boolean): Append => ({
        label: `check_result ${step}#${n} check ${index} ${passed ? "passed" : "failed"}`,
        event: {
          type: "check_result",
          at: AT,
          step,
          n,
          index,
          passed,
          ...(kind === "agent"
            ? { decision: passed ? "approve" : "request_changes" }
            : { exit: passed ? 0 : 1 }),
          text: passed ? "" : "1 test failed",
        },
      });
      return [
        verdict(true),
        verdict(false),
        ...REVIEW_FAILURES.map((reason) => attemptFailed(step, n, reason)),
      ];
    }
    case "grade": {
      const { step, n } = action;
      const graded = (satisfied: boolean): Append => ({
        label: `graded ${step}#${n} ${satisfied ? "satisfied" : "unmet"}`,
        event: {
          type: "graded",
          at: AT,
          step,
          n,
          satisfied,
          text: satisfied ? "Meets it." : "A change is missing.",
        },
      });
      return [
        graded(true),
        graded(false),
        ...REVIEW_FAILURES.map((reason) => attemptFailed(step, n, reason)),
      ];
    }
    case "pick":
      return [...action.candidates, null].map((n): Append => ({
        label: `picked ${action.step} ${n === null ? "none" : `#${n}`}`,
        event: { type: "picked", at: AT, step: action.step, n },
      }));
    case "stop_attempt":
      // A stop that fails after it was sent appends the same event, without its cost.
      return [
        {
          label: `attempt_stopped ${action.step}#${action.n}`,
          event: { type: "attempt_stopped", at: AT, step: action.step, n: action.n },
        },
      ];
    case "commit":
      return [
        {
          label: `attempt_committed ${action.step}#${action.n}`,
          event: {
            type: "attempt_committed",
            at: AT,
            step: action.step,
            n: action.n,
            sha: `sha-${action.step}-${action.n}`,
          },
        },
        {
          label: `attempt_committed ${action.step}#${action.n} with no changes`,
          event: { type: "attempt_committed", at: AT, step: action.step, n: action.n, sha: null },
        },
        attemptFailed(action.step, action.n, "agent_error"),
      ];
    case "wait_until":
      return [
        {
          label: `timer_fired ${action.step}`,
          event: { type: "timer_fired", at: AT, step: action.step },
        },
      ];
    case "await_approval":
      return [
        {
          label: `approval_answered ${action.step} approve`,
          event: {
            type: "approval_answered",
            at: AT,
            step: action.step,
            decision: "approve",
            by: "owner",
          },
        },
        {
          label: `approval_answered ${action.step} reject`,
          event: {
            type: "approval_answered",
            at: AT,
            step: action.step,
            decision: "reject",
            by: "owner",
            message: "Not this.",
          },
        },
        {
          label: `approval_expired ${action.step}`,
          event: { type: "approval_expired", at: AT, step: action.step },
        },
      ];
    case "output": {
      const { key } = action;
      const failed: Append = {
        label: `output_failed ${key}`,
        event: { type: "output_failed", at: AT, key, error: "GitHub said no." },
      };
      const dropped: Append = {
        label: `output_dropped ${key}`,
        event: { type: "output_dropped", at: AT, key, note: "No changes to propose." },
      };
      if (action.mode === "preview")
        return [
          {
            label: `output_dry_run ${key}`,
            event: { type: "output_dry_run", at: AT, key, preview: "Would post." },
          },
          dropped,
          failed,
        ];
      if (doing.second !== true)
        return [
          { label: `output_intent ${key}`, event: { type: "output_intent", at: AT, key } },
          failed,
        ];
      return [
        {
          label: `output_applied ${key}`,
          event: { type: "output_applied", at: AT, key, url: `https://github.com/acme/api/${key}` },
        },
        failed,
        dropped,
      ];
    }
    case "finish":
      return [{ label: "run_finished", event: { type: "run_finished", at: AT } }];
    case "release_step":
      return [];
  }
}

/** What the runner is doing, in any order (keyOf's part of a state). */
const doingKey = (doing: ReadonlyArray<Doing>): string =>
  JSON.stringify(doing.map((d) => JSON.stringify(d)).sort());

/**
 * Everything that can happen next. A restart while the run is live replays it and appends run_resumed (runner.ts
 * resume). Once the run has ended, journal.ts `live` still lists it until run_finished, and resume launches it with
 * what it still owes (its stops, its finish), appending nothing first; that restart is left out where the runner is
 * already doing just that, as it leads to the same state. A cancel (Stop, superseded, the deadline, policy_denied)
 * comes only while the run is live (runner.ts cancel); it first ends the stops it cut short with attempt_stopped, or,
 * where reading a stop's cost failed, leaves that stop to run_cancelled.
 */
function moves(w: World): Move[] {
  const owed = new Set(w.run.owed.map(actionKey));
  const out: Move[] = [];
  w.doing.forEach((doing, from) => {
    const late = owed.has(actionKey(doing.action)) ? "" : "late ";
    for (const a of appendsFor(w.run, doing))
      out.push({ kind: "append", label: late + a.label, event: a.event, from });
  });
  if (!isTerminal(w.run.status)) {
    out.push({ kind: "restart", label: "run_resumed", event: { type: "run_resumed", at: AT } });
    const stopping = w.run.owed.some((a) => a.type === "stop_attempt");
    for (const reason of CANCEL_REASONS) {
      const event: RunEvent = { type: "run_cancelled", at: AT, reason };
      out.push({ kind: "cancel", label: `run_cancelled ${reason}`, event, stops: false });
      if (stopping)
        out.push({
          kind: "cancel",
          label: `attempt_stopped for each stop under way, run_cancelled ${reason}`,
          event,
          stops: true,
        });
    }
  } else if (doingKey(w.doing) !== doingKey(w.run.owed.map((action) => ({ action })))) {
    out.push({
      kind: "restart",
      label: "the runtime restarts after the run ended (resume does what it still owes)",
    });
  }
  return out;
}

/** The world after `move`, and the actions the machine handed the runner on it. */
function apply(
  w: World,
  move: Move,
): { readonly world: World; readonly actions: ReadonlyArray<Action> } {
  if (move.event === undefined)
    return {
      world: {
        run: w.run,
        journal: w.journal,
        stored: w.stored,
        doing: w.run.owed.map((action) => ({ action })),
      },
      actions: [],
    };
  // runner.ts cancel ends each stop it cut short as that stop would have (attempt_stopped, with the attempt's cost).
  const before: RunEvent[] =
    move.kind === "cancel" && move.stops
      ? w.run.owed.flatMap((a): RunEvent[] =>
          a.type === "stop_attempt"
            ? [{ type: "attempt_stopped", at: AT, step: a.step, n: a.n }]
            : [],
        )
      : [];
  const t = next(
    before.reduce((run, event) => next(run, event).state, w.run),
    move.event,
  );
  const handed = t.actions
    .filter((a) => a.type !== "release_step")
    .map((action): Doing => ({ action }));
  let doing: ReadonlyArray<Doing> = handed;
  if (move.kind === "append") {
    const done = w.doing[move.from]!;
    const rest = w.doing.filter((_, i) => i !== move.from);
    const a = done.action;
    // runner.ts startAttempt goes on only when its step_started was recorded; writeOutput goes on after its intent.
    const goesOn =
      done.second !== true &&
      ((a.type === "start_attempt" &&
        move.event.type === "step_started" &&
        attemptOf(t.state, a.step, a.n) !== undefined) ||
        (a.type === "output" && move.event.type === "output_intent"));
    doing = [...rest, ...(goesOn ? [{ action: a, second: true as const }] : []), ...handed];
  }
  const events = [...before, move.event];
  // A restart or a cancel ends everything the runner was doing (cancel interrupts the run's fiber first, A6).
  return {
    world: {
      run: t.state,
      journal: [...w.journal, ...events],
      stored: [...w.stored, ...events.map(asStored)],
      doing,
    },
    actions: t.actions,
  };
}

// ------------------------------------------------------------------ the properties

const runKey = (run: RunState): string =>
  JSON.stringify([run.status, run.reason, run.endedAt, run.steps, run.outputs, run.owed]);
/** The same state, whatever order its keys were written in. */
const sameState = (a: RunState | undefined, b: RunState): boolean =>
  (a !== undefined && JSON.stringify(a) === JSON.stringify(b)) ||
  canonicalKey(a) === canonicalKey(b);
const stepDone = (status: StepState["status"]) =>
  status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";
const isGraph = (plan: RunPlan) =>
  plan.graph === true || plan.steps.some((s) => s.needs !== undefined);
const writesBranch = (p: PlanStep) => p.kind !== "wait" && p.computer === "full";

/**
 * SECURITY M1 (SEMANTICS §13 rule 11), read from the plan on its own, not through writingSteps: a step can write when it
 * has a full computer, or an output reads it that goes anywhere but the trigger's own thread or issue (a pull request,
 * a Slack post to a channel). A wait step writes nothing.
 */
const canWrite = (plan: RunPlan, step: string): boolean => {
  const p = plan.steps.find((s) => s.name === step)!;
  if (p.kind === "wait") return false;
  return (
    p.computer === "full" ||
    plan.outputs.some(
      (o) =>
        o.step === step &&
        (o.kind === "github.pull_request" ||
          (o.kind === "slack.message" && o.channel !== undefined)),
    )
  );
};

/** SEMANTICS §1.5: every key names a step that decided that value, or that failed for `failed`. */
const ifHolds = (state: RunState, condition: PlanStep["if"]) =>
  Object.entries(condition ?? {}).every(([ref, value]) => {
    const s = state.steps.find((x) => x.name === ref);
    return (
      s !== undefined &&
      (value === "failed"
        ? s.status === "failed"
        : s.status === "succeeded" && s.decision === value)
    );
  });

/** The most attempts SEMANTICS allows a step: retries + 1 (§3.1), a rubric's own count on top (§3.9), N per round (§4.3). */
const mostAttempts = (p: PlanStep) =>
  (p.parallel ?? 1) > 1
    ? p.parallel! * (p.retries + 1)
    : p.retries + 1 + (p.outcome === undefined ? 0 : p.outcome.maxIterations - 1);

/** SEMANTICS §3.2's retryable reasons, and outcome_unmet, retried by its own count (§3.9). Any other reason is final (§2.1). */
const RETRIED: ReadonlySet<Reason> = new Set<Reason>([
  "checks_failed",
  "review_rejected",
  "agent_error",
  "timeout",
  "result_invalid",
  "outcome_unmet",
]);

/** A step has begun once it passed its turn: it started, waited, asked its gate, or ended any way but skipped. */
const begun = (s: StepState) =>
  (s.status !== "pending" && s.status !== "skipped") || s.approval !== undefined;

const invariants: Record<string, (w: World) => boolean> = {
  "a transition broke a promise (see BROKE in the state)": (w) => w.broke === undefined,
  "a terminal run carries exactly one reason, and only a success has none (§0, §12)": ({ run }) =>
    !isTerminal(run.status) ||
    (run.endedAt !== null && (run.status === "succeeded") === (run.reason === null)),
  "a live run always owes the runner an action, so it cannot hang": ({ run }) =>
    isTerminal(run.status) || run.owed.length > 0,
  "a live run owes only what the runner is doing, so every owed action will be answered": ({
    run,
    doing,
  }) => {
    if (isTerminal(run.status)) return true;
    const done = new Set(doing.map((d) => actionKey(d.action)));
    return run.owed.every((a) => done.has(actionKey(a)));
  },
  "the runner never does one action twice at once": ({ doing }) =>
    new Set(doing.map((d) => actionKey(d.action))).size === doing.length,
  "no action is owed twice (the runner would do it twice)": ({ run }) =>
    new Set(run.owed.map(actionKey)).size === run.owed.length,
  "attempts per step stay within retries + 1 (§3.1), the rubric's count (§3.9) and N per round (§4.3)":
    ({ run }) =>
      run.steps.every((s) => {
        const p = planStepOf(run, s.name);
        if (s.attempts.length > mostAttempts(p)) return false;
        if ((p.parallel ?? 1) > 1) return true;
        const failures = s.attempts.filter(
          (a) => a.status === "failed" && a.reason !== "outcome_unmet",
        ).length;
        const graded = s.attempts.filter((a) => a.grade !== undefined).length;
        return failures <= p.retries + 1 && graded <= (p.outcome?.maxIterations ?? 0);
      }),
  "a step's reason is set exactly when it ended other than succeeded": ({ run }) =>
    run.steps.every(
      (s) =>
        (s.status === "failed" || s.status === "skipped" || s.status === "cancelled") ===
        (s.reason !== null),
    ),
  "a skipped step never ran": ({ run }) =>
    run.steps.every((s) => s.status !== "skipped" || s.attempts.length === 0),
  "sequential: one step at a time (§1.1)": ({ run }) =>
    isGraph(run.plan) ||
    run.steps.filter((s) => s.status === "running" || s.status === "waiting").length <= 1,
  "graph: at most the limit at once, and computer: full steps take turns (§1.2)": ({ run }) => {
    if (!isGraph(run.plan)) return true;
    const running = run.steps.filter((s) => s.status === "running");
    return (
      running.length <= (run.plan.limit ?? 4) &&
      running.filter((s) => writesBranch(planStepOf(run, s.name))).length <= 1
    );
  },
  "an output is written only from a step that succeeded (§7.2)": ({ run }) =>
    run.outputs.every((o) => {
      const touched =
        o.status === "applied" ||
        o.status === "dry_run" ||
        o.status === "failed" ||
        o.intent ||
        run.owed.some((a) => a.type === "output" && a.key === o.key);
      return !touched || stepOf(run, o.step).status === "succeeded";
    }),
  "outputs are written only once every step is done (§7.2)": ({ run }) =>
    !run.owed.some((a) => a.type === "output") || run.steps.every((s) => stepDone(s.status)),
  "a cancelled run writes no output and drops the unwritten ones (§7.2, §8.3)": ({ run }) =>
    run.status !== "cancelled" ||
    (!run.owed.some((a) => a.type === "output") &&
      run.outputs.every((o) => o.status !== "pending")),
  "a cancelled run leaves no step pending, running or waiting (§8.3)": ({ run }) =>
    run.status !== "cancelled" || run.steps.every((s) => stepDone(s.status)),
  "an ended run's status follows its steps and outputs (§2.3, §7.5)": ({ run }) => {
    if (!isTerminal(run.status) || run.status === "cancelled") return true;
    const failedSteps = run.steps.filter((s) => s.status === "failed");
    const outputFailed = run.outputs.some((o) => o.status === "failed");
    if (failedSteps.length === 0 && !outputFailed) return run.status === "succeeded";
    return (
      run.status === "failed" &&
      (failedSteps.some((s) => s.reason === run.reason) ||
        (outputFailed && run.reason === "output_failed"))
    );
  },
  "replaying the journal, as stored (JSON), gives the live state (§11)": ({ run, stored }) =>
    sameState(replay(stored), run),
};

/** What must hold of each transition: a promise about order, which no single state shows. */
function transitionBroke(
  before: World,
  after: RunState,
  actions: ReadonlyArray<Action>,
  journal: ReadonlyArray<RunEvent>,
  gated: ReadonlySet<string>,
): string | undefined {
  const was = before.run;
  if (
    isTerminal(was.status) &&
    (after.status !== was.status || after.reason !== was.reason || after.endedAt !== was.endedAt)
  ) {
    return `an ended run changed its status: ${was.status}(${was.reason}) to ${after.status}(${after.reason})`;
  }
  for (const s of was.steps) {
    const now = stepOf(after, s.name);
    if (stepDone(s.status) && (now.status !== s.status || now.reason !== s.reason))
      return `step ${s.name} ended ${s.status} and became ${now.status}`;
  }
  for (const s of was.steps) {
    if (s.status !== "running") continue;
    const now = stepOf(after, s.name);
    const final = now.attempts.find(
      (a) =>
        a.status === "failed" &&
        a.reason !== null &&
        !RETRIED.has(a.reason) &&
        s.attempts.some((b) => b.n === a.n && b.status === "running"),
    );
    if (final !== undefined && (now.status !== "failed" || now.reason !== final.reason)) {
      return `attempt ${s.name}#${final.n} failed ${final.reason}, which no retry fixes, and step ${s.name} is ${now.status}(${now.reason}) (§2.1, §3.2)`;
    }
  }
  const owed = new Set(after.owed.map(actionKey));
  const unowed = actions.find((a) => a.type !== "release_step" && !owed.has(actionKey(a)));
  if (unowed !== undefined)
    return `the runner was told ${unowed.type} ${"step" in unowed ? unowed.step : ""} and the journal does not owe it, so a restart loses it`;
  for (const a of actions) {
    if (a.type !== "start_attempt" || !gated.has(a.step)) continue;
    if (
      !journal.some(
        (e) => e.type === "approval_answered" && e.step === a.step && e.decision === "approve",
      )
    ) {
      return `gated step ${a.step} was started (attempt ${a.n}) before the owner approved it (SECURITY M1, §13 rule 11)`;
    }
  }
  for (const s of after.steps) {
    const prior = stepOf(was, s.name);
    if (begun(prior) || !begun(s)) continue;
    const p = planStepOf(after, s.name);
    if (!ifHolds(after, p.if)) return `step ${s.name} began though its if does not hold (§1.5)`;
    const handles = (failed: ReadonlyArray<string>) =>
      Object.entries(p.if ?? {}).some(([ref, value]) => value === "failed" && failed.includes(ref));
    if (isGraph(after.plan)) {
      const needs = (p.needs ?? []).map((n) => stepOf(after, n));
      if (needs.some((n) => !stepDone(n.status)))
        return `step ${s.name} began before its needs finished (§1.3)`;
      if (
        needs.some(
          (n) =>
            n.status !== "succeeded" && !(n.status === "failed" && p.if?.[n.name] === "failed"),
        )
      )
        return `step ${s.name} began though a need did not succeed (§1.3, §1.4)`;
    } else {
      const earlier = after.steps.slice(0, after.steps.indexOf(s));
      if (earlier.some((e) => !stepDone(e.status)))
        return `step ${s.name} began before an earlier step finished (§1.1)`;
    }
    const failed = after.steps.filter((x) => x.status === "failed" && x !== s).map((x) => x.name);
    if (failed.length > 0 && !handles(failed))
      return `step ${s.name} began after ${failed.join(", ")} failed without handling it (§2.2)`;
  }
  return undefined;
}

const atEnd: Record<string, (w: World) => boolean> = {
  "every run ends: terminal, every step done, nothing owed": ({ run }) =>
    isTerminal(run.status) && run.steps.every((s) => stepDone(s.status)) && run.owed.length === 0,
  "an ended run has no attempt still running: each was stopped, failed or finished (§4.3, §8.3)": ({
    run,
  }) => run.steps.every((s) => s.attempts.every((a) => a.status !== "running")),
};

// ------------------------------------------------------------------ the check

const describeAction = (a: Action) =>
  a.type === "output"
    ? `output ${a.key} (${a.mode})`
    : a.type === "pick"
      ? `pick ${a.step} of ${a.candidates.join("/")}`
      : "n" in a
        ? `${a.type} ${a.step}#${a.n}${"index" in a ? `.${a.index}` : ""}`
        : "step" in a
          ? `${a.type} ${a.step}`
          : a.type;

const show = (w: World): string => {
  const r = w.run;
  const steps = r.steps
    .map((s) => {
      const attempts = s.attempts
        .map((a) => `${a.n}:${a.status}${a.reason === null ? "" : `/${a.reason}`}`)
        .join(" ");
      const approval =
        s.approval === undefined
          ? ""
          : ` approval(${s.approval.before === true ? "before" : "after"}${s.approval.decision === undefined ? "" : `=${s.approval.decision}`})`;
      return `${s.name}:${s.status}${s.reason === null ? "" : `(${s.reason})`}${attempts === "" ? "" : `[${attempts}]`}${approval}`;
    })
    .join(", ");
  const outputs = r.outputs
    .map((o) => `${o.kind}<-${o.step}:${o.status}${o.intent ? "+intent" : ""}`)
    .join(", ");
  return [
    `run ${r.status}${r.reason === null ? "" : `(${r.reason})`}`,
    `steps ${steps}`,
    `owed ${r.owed.map(describeAction).join(", ") || "nothing"}`,
    `runner doing ${w.doing.map((d) => describeAction(d.action) + (d.second === true ? " (2nd)" : "")).join(", ") || "nothing"}`,
    ...(outputs === "" ? [] : [`outputs ${outputs}`]),
    ...(w.broke === undefined ? [] : [`BROKE ${w.broke}`]),
  ].join(" | ");
};

const keys = new WeakMap<World, string>();
/**
 * A state's identity: everything in RunState but the plan, run id and start time, which no event changes, and what the
 * runner is doing, in any order. RunState is plain JSON (journal.ts stores it so), so equal JSON is an equal state; a key
 * order that differs by path only splits one state in two, which costs time and misses nothing.
 */
const keyOf = (w: World): string => {
  let key = keys.get(w);
  if (key === undefined) {
    key = JSON.stringify([runKey(w.run), doingKey(w.doing), w.broke ?? null]);
    keys.set(w, key);
  }
  return key;
};

interface Exploration {
  readonly states: number;
  readonly transitions: number;
  readonly depth: number;
  readonly exhaustive: boolean;
}

/**
 * Explores every reachable state of a run of `plan`, checks the invariants in each, the transition promises on each
 * step, the end state, and afterwards that every state can still reach the end by runner responses alone.
 */
function explore(
  plan: RunPlan,
  options: {
    readonly untrusted?: boolean;
    readonly maxStates?: number;
    readonly leaveOut?: (move: Move, w: World) => boolean;
  } = {},
): Exploration {
  const bounded = options.maxStates !== undefined;
  const gated = new Set(
    plan.steps
      .filter((s) => s.gate !== undefined || (options.untrusted === true && canWrite(plan, s.name)))
      .map((s) => s.name),
  );
  const admitted: RunEvent = { type: "run_admitted", at: AT, run: "r_model", plan };
  const first = next(undefined, admitted);
  const init: World = {
    run: first.state,
    journal: [admitted],
    stored: [asStored(admitted)],
    doing: first.actions.filter((a) => a.type !== "release_step").map((action) => ({ action })),
  };
  const progress = new Map<string, ReadonlyArray<string>>();
  const ended = new Set<string>();
  const parent = new Map<
    string,
    { readonly from: string | undefined; readonly label: string; readonly world: World }
  >([[keyOf(init), { from: undefined, label: "run_admitted", world: init }]]);

  const verdict = check<World>({
    init: [init],
    key: keyOf,
    maxStates: options.maxStates ?? 1_000_000,
    invariants,
    atEnd,
    next: (w) => {
      const from = keyOf(w);
      const steps: Array<Step<World>> = [];
      const appended: string[] = [];
      if (w.broke === undefined) {
        for (const move of moves(w)) {
          if (options.leaveOut?.(move, w) === true) continue;
          const { world, actions } = apply(w, move);
          const broke =
            move.event === undefined
              ? undefined
              : transitionBroke(w, world.run, actions, world.journal, gated);
          const after: World = broke === undefined ? world : { ...world, broke };
          const to = keyOf(after);
          if (!parent.has(to)) parent.set(to, { from, label: move.label, world: after });
          if (move.kind === "append") appended.push(to);
          steps.push({ action: move.label, state: after });
        }
      }
      progress.set(from, appended);
      if (steps.length === 0) ended.add(from);
      return steps;
    },
  });
  assertHolds(verdict, { show, requireExhaustive: !bounded });
  if (!verdict.ok) throw new Error("unreachable");

  // Liveness (AG EF ended): walk back from the ended states along runner responses only. Under a state bound, a state
  // the search never expanded counts as able to end, so only a proven hang is reported.
  const into = new Map<string, string[]>();
  for (const [from, tos] of progress)
    for (const to of tos) into.set(to, [...(into.get(to) ?? []), from]);
  const unexpanded = [...into.keys()].filter((k) => !progress.has(k));
  const canEnd = new Set([...ended, ...unexpanded]);
  const queue = [...canEnd];
  for (let i = 0; i < queue.length; i++) {
    for (const from of into.get(queue[i]!) ?? []) {
      if (canEnd.has(from)) continue;
      canEnd.add(from);
      queue.push(from);
    }
  }
  const stuck = [...progress.keys()].find((k) => !canEnd.has(k));
  if (stuck !== undefined) {
    const trace: string[] = [];
    for (let at: string | undefined = stuck; at !== undefined; at = parent.get(at)?.from) {
      const p = parent.get(at)!;
      trace.unshift(`  ${p.label}\n     ${show(p.world)}`);
    }
    throw new Error(
      `a run can hang: from this state nothing the runner appends leads to the end (only a cancel, the 2 h deadline or a restart would):\n${trace.join("\n")}`,
    );
  }
  return {
    states: verdict.states,
    transitions: verdict.transitions,
    depth: verdict.depth,
    exhaustive: verdict.exhaustive,
  };
}

const report = (name: string, result: Exploration, ms: number) =>
  console.log(
    `[automation-run-machine] ${name}: ${result.states} states, ${result.transitions} transitions, depth ${result.depth}, exhaustive ${result.exhaustive}, ${Math.round(ms)} ms`,
  );

/**
 * An exploration is bounded by its state count (explore's maxStates), the same work on every run. A wall-clock limit
 * measured the machine instead: vitest checks a synchronous test's deadline only once it returns, so on a loaded
 * machine parallel-best finished, every property held, and the test still failed.
 */
const BOUNDED_BY_STATES = { timeout: 0 } as const;

describe("run machine model check (machine.ts next/replay over planOf plans)", () => {
  for (const fixture of FIXTURES) {
    it(
      `${fixture.name}: every reachable state keeps the run's promises, and every run can end`,
      BOUNDED_BY_STATES,
      () => {
        const plan = admit(fixture.name, fixture.yaml, {
          untrusted: fixture.untrusted !== undefined,
          ...(fixture.apply === undefined ? {} : { apply: fixture.apply }),
        });
        if (plan === undefined) return expect.fail(`${fixture.name} must load clean`);
        const gated = plan.steps.filter((s) => s.gate !== undefined).map((s) => s.name);
        expect(
          gated,
          "untrusted trigger text gates exactly the steps that can write (SECURITY M1)",
        ).toEqual(fixture.untrusted?.gates ?? []);
        const started = performance.now();
        const result = explore(plan, { untrusted: fixture.untrusted !== undefined });
        report(fixture.name, result, performance.now() - started);
        expect(result.exhaustive).toBe(true);
      },
    );
  }
});

// ------------------------------------------------------------------ sampled files

const oneOf = <const A extends ReadonlyArray<string | number | boolean>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));
const StepShape = Arbitrary.all({
  kind: oneOf(["prompt", "run", "wait"]),
  computer: oneOf(["default", "none", "readonly", "full"]),
  retries: oneOf([0, 1, 2]),
  checks: oneOf(["none", "command", "agent", "both"]),
  parallel: oneOf([1, 2, 3]),
  pick: oneOf(["first", "best"]),
  approve: oneOf([false, true]),
  outcome: oneOf([0, 1, 2]),
  /** Bit j: needs the j-th earlier step. */
  needs: oneOf([0, 1, 2, 3, 4, 5, 6, 7]),
  ifStep: oneOf([-1, 0, 1, 2]),
  ifValue: oneOf(["failed", "go"]),
  decides: oneOf([false, true]),
});
const FileShape = Arbitrary.all({
  count: oneOf([1, 2, 3, 4]),
  steps: Arbitrary.all([StepShape, StepShape, StepShape, StepShape]),
  comment: oneOf([-1, 0, 1, 2, 3]),
  pullRequest: oneOf([-1, 0, 1, 2, 3]),
  post: oneOf([-1, 0, 1, 2, 3]),
  trigger: oneOf(["manual", "github", "slack", "webhook"]),
  cloud: oneOf([false, true]),
  untrusted: oneOf([false, true]),
  apply: oneOf([true, false]),
});
type Generated<A> = A extends Arbitrary.Arbitrary<infer T> ? T : never;

const STEP_NAMES = ["a", "b", "c", "d"] as const;

/**
 * An automation file of 1 to 4 steps drawn from every step kind and option the machine reads, written so that check
 * accepts most of them (each rule it would break is steered around: outcome only on agent steps, a check beside
 * parallel, a pull request from a full step, an if in a graph on a need, Cloud-only triggers and outputs on Cloud).
 */
function fileOf(shape: Generated<typeof FileShape>): string {
  const names = STEP_NAMES.slice(0, shape.count);
  const shapes: ReadonlyArray<Generated<typeof StepShape>> = shape.steps;
  const graph = names.some((_, i) => i > 0 && (shapes[i]!.needs & ((1 << i) - 1)) !== 0);
  const decides = (i: number) => shapes[i]!.kind === "prompt" && shapes[i]!.decides;
  const pullRequestFrom =
    shape.pullRequest >= 0 &&
    shape.pullRequest < shape.count &&
    shapes[shape.pullRequest]!.kind !== "wait"
      ? shape.pullRequest
      : -1;
  const steps: Record<string, Record<string, unknown>> = {};
  names.forEach((name, i) => {
    const s = shapes[i]!;
    const step: Record<string, unknown> =
      s.kind === "prompt"
        ? { prompt: `Do ${name}.` }
        : s.kind === "run"
          ? { run: `pnpm ${name}` }
          : { wait: "5m" };
    if (s.kind !== "wait") {
      const checks = s.parallel > 1 && s.checks === "none" ? "command" : s.checks;
      const computer =
        i === pullRequestFrom
          ? "full"
          : s.computer === "none" && (checks === "command" || checks === "both")
            ? "readonly"
            : s.computer;
      if (computer !== "default") step.computer = computer;
      if (s.retries > 0) step.retries = s.retries;
      if (checks !== "none")
        step.checks = [
          ...(checks === "agent" ? [] : ["pnpm test"]),
          ...(checks === "command" ? [] : [{ agent: "reviewer" }]),
        ];
      if (s.parallel > 1) Object.assign(step, { parallel: s.parallel, pick: s.pick });
    }
    if (s.kind === "prompt" && s.outcome > 0)
      step.outcome = { rubric: "It is done right.", max_iterations: s.outcome };
    if (s.kind === "prompt" && s.decides) step.decides = ["go", "stop"];
    if (s.approve) step.approve = { by: "owner" };
    const needs = new Set(names.slice(0, i).filter((_, j) => ((s.needs >> j) & 1) === 1));
    if (s.ifStep >= 0 && s.ifStep < i) {
      const ref = names[s.ifStep]!;
      step.if = { [ref]: s.ifValue === "go" && decides(s.ifStep) ? "go" : "failed" };
      if (graph) needs.add(ref);
    }
    if (needs.size > 0) step.needs = names.filter((n) => needs.has(n));
    steps[name] = step;
  });
  const from = (i: number) => names[i];
  const outputs: Record<string, unknown> = {
    ...(from(shape.comment) === undefined
      ? {}
      : { "github.comment": `${from(shape.comment)}.summary` }),
    ...(pullRequestFrom === -1 ? {} : { "github.pull_request": { from: from(pullRequestFrom) } }),
    ...(from(shape.post) === undefined || !shape.cloud
      ? {}
      : { "slack.message": { from: from(shape.post), channel: "#ops" } }),
  };
  const trigger = shape.cloud || shape.trigger === "github" ? shape.trigger : "manual";
  const on =
    trigger === "github"
      ? { github: { event: "issues.labeled", label: "caveman" } }
      : trigger === "slack"
        ? { slack: { mention: true } }
        : trigger === "webhook"
          ? { webhook: {} }
          : undefined;
  return stringify({
    ...(shape.cloud ? { host: "cloud" } : {}),
    ...(on === undefined ? {} : { on }),
    steps,
    ...(Object.keys(outputs).length === 0 ? {} : { outputs }),
  });
}

describe("run machine over sampled files (file-parse-check-total)", () => {
  let accepted = 0;
  let exhaustive = 0;
  it.prop(
    "any file check accepts gates its writing steps when untrusted, and runs through planOf and next keeping every promise",
    [FileShape],
    ([shape]) => {
      const text = fileOf(shape);
      const plan = admit("sampled", text, { untrusted: shape.untrusted, apply: shape.apply });
      if (plan === undefined) return;
      accepted++;
      const gated = plan.steps.filter((s) => s.gate !== undefined).map((s) => s.name);
      expect(gated, `gates for:\n${text}`).toEqual(
        shape.untrusted ? plan.steps.filter((s) => canWrite(plan, s.name)).map((s) => s.name) : [],
      );
      try {
        if (explore(plan, { untrusted: shape.untrusted, maxStates: SAMPLED_MAX_STATES }).exhaustive)
          exhaustive++;
      } catch (error) {
        throw new Error(
          `${(error as Error).message}\nfile:\n${text}untrusted: ${shape.untrusted}, apply: ${shape.apply}`,
          { cause: error },
        );
      }
    },
    { ...BOUNDED_BY_STATES, arbitrary: { runs: SAMPLED_RUNS, seed: SAMPLED_SEED } },
  );
  it("the sample reached the machine", () => {
    console.log(
      `[automation-run-machine] sampled files: ${accepted} of ${SAMPLED_RUNS} loaded clean; ${exhaustive} explored exhaustively, the rest up to ${SAMPLED_MAX_STATES} states each`,
    );
    expect(accepted, "most sampled files must load, or the sample tests nothing").toBeGreaterThan(
      SAMPLED_RUNS / 4,
    );
  });
});
