import { parseAutomation } from "@caveman-app/automations";
import { describe, expect, it } from "vitest";

import { CHECK_TAIL_BYTES, FAILURES_MAX_BYTES, capFromHead, type AttemptFailure, failureText, next, planOf, replay, type Action, type PlanStep, type RunEvent, type RunPlan, type RunState } from "./machine.ts";

const at = "2026-10-20T00:00:00.000Z";
const step = (name: string, over: Partial<PlanStep> = {}): PlanStep => ({ name, model: "base", computer: "readonly", checks: [], retries: 0, timeoutMs: 600_000, ...over });
const plan = (steps: PlanStep[], over: Partial<RunPlan> = {}): RunPlan => ({ automation: "a", steps, outputs: [], apply: true, ...over });

type Draft = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at"> & { at?: string } : never) : never;

/** Drives a run through events; each step returns the actions of the last event. */
function run(p: RunPlan) {
  let state: RunState | undefined;
  const log: RunEvent[] = [];
  let actions: ReadonlyArray<Action> = [];
  const send = (event: Draft) => {
    const full = { at, ...event } as RunEvent;
    log.push(full);
    const t = next(state, full);
    state = t.state;
    actions = t.actions;
    return actions;
  };
  send({ type: "run_admitted", run: "r_1", plan: p });
  const started = (stepName: string, n: number, asked = "base", session: "new" | "continue" = "new") =>
    send({ type: "step_started", step: stepName, n, model: { asked, resolved: asked }, computer: "readonly", session, thread_id: `t-${stepName}-${n}`, start_sha: "s0" });
  const finished = (stepName: string, n: number, decision?: string) => send({ type: "attempt_finished", step: stepName, n, result: { summary: `${stepName} done`, ...(decision ? { decision } : {}) } });
  return {
    send,
    started,
    finished,
    /** Starts and finishes attempt n with a decision. */
    ok: (stepName: string, n = 1, decision?: string) => (started(stepName, n), finished(stepName, n, decision)),
    get state() {
      return state!;
    },
    get actions() {
      return actions;
    },
    status: (name: string) => state!.steps.find((s) => s.name === name)!,
    log,
  };
}

describe("run machine: order, if, skipping (§1-2)", () => {
  it("runs steps one at a time in file order and succeeds", () => {
    const r = run(plan([step("one"), step("two")]));
    expect(r.actions).toEqual([{ type: "start_attempt", step: "one", n: 1, asked: "base", escalated: false, session: "new" }]);
    expect(r.ok("one")).toEqual([{ type: "release_step", step: "one" }, { type: "start_attempt", step: "two", n: 1, asked: "base", escalated: false, session: "new" }]);
    expect(r.ok("two")).toEqual([{ type: "release_step", step: "two" }, { type: "finish" }]);
    expect(r.state).toMatchObject({ status: "succeeded", reason: null, endedAt: at });
  });

  it("branches on a decision: a false if skips (condition_false) without blocking later steps", () => {
    const r = run(plan([step("triage"), step("implement", { if: { triage: "implement" } }), step("ask", { if: { triage: "needs_info" } }), step("after")]));
    expect(r.ok("triage", 1, "needs_info")).toContainEqual({ type: "start_attempt", step: "ask", n: 1, asked: "base", escalated: false, session: "new" });
    expect(r.status("implement")).toMatchObject({ status: "skipped", reason: "condition_false" });
    r.ok("ask");
    r.ok("after");
    expect(r.state.status).toBe("succeeded");
  });

  it("ANDs every key of an if", () => {
    const r = run(plan([step("a"), step("b"), step("c", { if: { a: "yes", b: "yes" } })]));
    r.ok("a", 1, "yes");
    r.ok("b", 1, "no");
    expect(r.status("c")).toMatchObject({ status: "skipped", reason: "condition_false" });
    expect(r.state.status).toBe("succeeded");
  });

  it("all remaining steps skipped by if is a success (triage found nothing to do)", () => {
    const r = run(plan([step("triage"), step("implement", { if: { triage: "implement" } })]));
    r.ok("triage", 1, "skip");
    expect(r.state).toMatchObject({ status: "succeeded", reason: null });
  });

  it("after a failure only a handler naming it with failed runs; the rest are need_failed and the run fails", () => {
    const r = run(plan([step("implement"), step("next"), step("handler", { if: { implement: "failed" } }), step("tail")]));
    r.started("implement", 1);
    const actions = r.send({ type: "attempt_failed", step: "implement", n: 1, reason: "agent_error", message: "boom" });
    expect(actions).toContainEqual(expect.objectContaining({ type: "start_attempt", step: "handler" }));
    expect(r.status("next")).toMatchObject({ status: "skipped", reason: "need_failed" });
    r.ok("handler");
    expect(r.status("tail")).toMatchObject({ status: "skipped", reason: "need_failed" });
    expect(r.state).toMatchObject({ status: "failed", reason: "agent_error" });
  });

  it("a failed handler condition (the step succeeded) skips the handler as condition_false", () => {
    const r = run(plan([step("implement"), step("handler", { if: { implement: "failed" } })]));
    r.ok("implement");
    expect(r.status("handler")).toMatchObject({ status: "skipped", reason: "condition_false" });
  });

  it("a skipped step's decision never holds", () => {
    const r = run(plan([step("a", { if: { x: "y" } }), step("b", { if: { a: "go" } })]));
    expect(r.status("a").status).toBe("skipped");
    expect(r.status("b")).toMatchObject({ status: "skipped", reason: "condition_false" });
  });
});

describe("run machine: attempts, retries, escalate (§3.1-3.4)", () => {
  const cases: Array<{ reason: AttemptFailure; retried: boolean }> = [
    { reason: "agent_error", retried: true },
    { reason: "timeout", retried: true },
    { reason: "result_invalid", retried: true },
    { reason: "budget_exhausted", retried: false },
    { reason: "engine_unavailable", retried: false },
  ];
  for (const { reason, retried } of cases) {
    it(`${reason} is ${retried ? "" : "not "}retried`, () => {
      const r = run(plan([step("s", { retries: 2 })]));
      r.started("s", 1);
      const actions = r.send({ type: "attempt_failed", step: "s", n: 1, reason, message: "why" });
      if (retried) expect(actions).toEqual([expect.objectContaining({ type: "start_attempt", step: "s", n: 2, session: "continue", failures: "why" })]);
      else expect(r.state).toMatchObject({ status: "failed", reason });
    });
  }

  it("retries: N allows N+1 attempts, then the step fails with the last reason", () => {
    const r = run(plan([step("s", { retries: 1 })]));
    r.started("s", 1);
    r.send({ type: "attempt_failed", step: "s", n: 1, reason: "timeout", message: "slow" });
    r.started("s", 2, "base", "continue");
    r.send({ type: "attempt_failed", step: "s", n: 2, reason: "agent_error", message: "broke" });
    expect(r.status("s")).toMatchObject({ status: "failed", reason: "agent_error" });
    expect(r.status("s").attempts.map((a) => [a.n, a.status, a.reason])).toEqual([
      [1, "failed", "timeout"],
      [2, "failed", "agent_error"],
    ]);
  });

  it("a step's start is the first one an attempt recorded, even when its first attempt never got its checkout", () => {
    const r = run(plan([step("s", { retries: 2, computer: "full" })]));
    r.send({ type: "step_started", step: "s", n: 1, model: { asked: "base", resolved: "base" }, computer: "full", session: "new" });
    r.send({ type: "attempt_failed", step: "s", n: 1, reason: "agent_error", message: "The step's checkout could not be made." });
    expect(r.status("s").startSha).toBeUndefined();
    r.send({ type: "step_started", step: "s", n: 2, model: { asked: "base", resolved: "base" }, computer: "full", session: "new", start_sha: "s0" });
    expect(r.status("s").startSha).toBe("s0");
    r.send({ type: "attempt_failed", step: "s", n: 2, reason: "timeout", message: "slow" });
    r.send({ type: "step_started", step: "s", n: 3, model: { asked: "base", resolved: "base" }, computer: "full", session: "new", start_sha: "s1" });
    expect(r.status("s").startSha).toBe("s0");
    // Each attempt keeps the commit its own checkout started from.
    expect(r.status("s").attempts.map((a) => a.startSha)).toEqual([undefined, "s0", "s1"]);
  });

  it("escalate: attempts 2+ ask for the class; the move up is a new session, a retry at that class continues it", () => {
    const r = run(plan([step("s", { retries: 2, escalate: "frontier", checks: [{ kind: "command", command: "pnpm test" }] })]));
    r.ok("s", 1);
    let actions = r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: false, exit: 1, text: "FAIL" });
    expect(actions).toEqual([expect.objectContaining({ type: "start_attempt", n: 2, asked: "frontier", escalated: true, session: "new" })]);
    r.started("s", 2, "frontier");
    r.finished("s", 2);
    actions = r.send({ type: "check_result", step: "s", n: 2, index: 0, passed: false, exit: 1, text: "FAIL again" });
    expect(actions).toEqual([expect.objectContaining({ type: "start_attempt", n: 3, asked: "frontier", session: "continue" })]);
  });

  it("checks run in order after the result and stop at the first failure; a passing set succeeds", () => {
    const r = run(plan([step("s", { checks: [{ kind: "command", command: "lint" }, { kind: "command", command: "test" }, { kind: "agent", agent: "reviewer" }] })]));
    r.started("s", 1);
    expect(r.finished("s", 1)).toEqual([{ type: "run_check", step: "s", n: 1, index: 0 }]);
    expect(r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: true, exit: 0 })).toEqual([{ type: "run_check", step: "s", n: 1, index: 1 }]);
    expect(r.send({ type: "check_result", step: "s", n: 1, index: 1, passed: true, exit: 0 })).toEqual([{ type: "run_check", step: "s", n: 1, index: 2 }]);
    r.send({ type: "check_result", step: "s", n: 1, index: 2, passed: true, decision: "approve" });
    expect(r.state.status).toBe("succeeded");
  });

  it("a failed command check is checks_failed, a rejecting agent check is review_rejected", () => {
    const r = run(plan([step("s", { checks: [{ kind: "command", command: "test" }] })]));
    r.ok("s");
    r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: false, exit: 2 });
    expect(r.state).toMatchObject({ status: "failed", reason: "checks_failed" });
    const q = run(plan([step("s", { checks: [{ kind: "agent", agent: "reviewer" }] })]));
    q.ok("s");
    q.send({ type: "check_result", step: "s", n: 1, index: 0, passed: false, decision: "request_changes", text: "fix x" });
    expect(q.state).toMatchObject({ status: "failed", reason: "review_rejected" });
  });

  it("success = result and every check, then the commit for a full step (§3.8, §6.2)", () => {
    const r = run(plan([step("s", { computer: "full", checks: [{ kind: "command", command: "test" }] })]));
    r.ok("s");
    expect(r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: true, exit: 0 })).toEqual([{ type: "commit", step: "s", n: 1 }]);
    expect(r.status("s").status).toBe("running");
    r.send({ type: "attempt_committed", step: "s", n: 1, sha: "abc" });
    expect(r.status("s")).toMatchObject({ status: "succeeded", sha: "abc" });
    expect(r.status("s").attempts[0]).toMatchObject({ status: "succeeded", sha: "abc" });
  });

  it("orders command checks before agent checks, each in file order (§3.7)", () => {
    const file = parseAutomation({
      path: ".caveman/automations/x.yaml",
      text: "steps:\n  s:\n    prompt: go\n    computer: full\n    checks: [{ agent: reviewer }, pnpm lint, { agent: second }, pnpm test]\n    retries: 1\n",
    }).file!;
    expect(planOf(file, [], true, "x").steps[0]!.checks).toEqual([
      { kind: "command", command: "pnpm lint" },
      { kind: "command", command: "pnpm test" },
      { kind: "agent", agent: "reviewer" },
      { kind: "agent", agent: "second" },
    ]);
  });

  it("a prompt step's own decides reaches the plan, so it can branch the steps after it", () => {
    const file = parseAutomation({
      path: ".caveman/automations/x.yaml",
      text: "steps:\n  gate:\n    prompt: Is this worth a review?\n    decides: [review, skip]\n  review:\n    if: { gate: review }\n    prompt: go\n",
    }).file!;
    expect(planOf(file, [], true, "x").steps[0]!.decides).toEqual(["review", "skip"]);
  });

  it("the plan: step model, else the agent's, else the new-chat default; timeouts by computer; outputs in declaration order", () => {
    const file = parseAutomation({
      path: ".caveman/automations/x.yaml",
      text: "steps:\n  a:\n    agent: tri\n  b:\n    prompt: go\n    computer: full\n    model: frontier\n  c:\n    prompt: go\n    computer: none\noutputs:\n  github.pull_request: { from: b, draft: true }\n  github.comment: a.summary\n",
    }).file!;
    const p = planOf(file, [{ name: "tri", model: "fast", effort: "low" }], false, "x");
    expect(p.steps.map((s) => [s.name, s.model, s.computer, s.timeoutMs, s.effort])).toEqual([
      ["a", "fast", "readonly", 600_000, "low"],
      ["b", "frontier", "full", 1_800_000, undefined],
      ["c", "default", "none", 600_000, undefined],
    ]);
    expect(p.outputs).toEqual([
      { kind: "github.pull_request", step: "b", field: "summary", draft: true },
      { kind: "github.comment", step: "a", field: "summary" },
    ]);
  });

  it("ignores stale events: another attempt's result, a check out of order", () => {
    const r = run(plan([step("s", { checks: [{ kind: "command", command: "t" }] })]));
    r.started("s", 1);
    expect(r.send({ type: "attempt_finished", step: "s", n: 2, result: { summary: "x" } })).toEqual([]);
    expect(r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: true })).toEqual([]);
    expect(r.status("s").attempts[0]!.checks).toEqual([]);
  });
});

describe("run machine: failure text (§3.5)", () => {
  it("keeps each failed check's exit and tail, and an agent check's findings", () => {
    const r = run(plan([step("s", { retries: 1, checks: [{ kind: "command", command: "pnpm test" }] })]));
    r.ok("s");
    const actions = r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: false, exit: 1, text: "1 failing" });
    expect((actions[0] as { failures: string }).failures).toBe("The check `pnpm test` exited 1. The end of its output:\n1 failing");
  });

  it("caps the total at 24 KiB, cut from the head, with a marker naming the attempt", () => {
    const attempt = {
      n: 1, status: "failed" as const, reason: "checks_failed" as const, startedAt: at, endedAt: at, model: { asked: "base", resolved: "base" }, computer: "full" as const,
      session: "new" as const, cost: { usd: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0, billing: "none" as const }, sha: null,
      checks: [0, 1, 2, 3].map((i) => ({ index: i, check: `c${i}`, kind: "command" as const, passed: false, exit: 1, text: `${i}`.repeat(CHECK_TAIL_BYTES) })),
    };
    const text = failureText("r_1", "s", attempt)!;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FAILURES_MAX_BYTES);
    expect(text.startsWith("[Earlier text cut. The full check output is in the run record, attempt r_1.s.1.]")).toBe(true);
    expect(text.endsWith("3".repeat(100))).toBe(true);
    expect(capFromHead("short", 10, "x")).toBe("short");
  });
});

describe("run machine: outputs (§7.2)", () => {
  const p = plan([step("implement", { computer: "full" }), step("ask")], {
    outputs: [{ kind: "github.pull_request", step: "implement", field: "summary" }, { kind: "github.comment", step: "ask", field: "summary" }],
  });

  it("apply at run end in declaration order, each only if its step succeeded", () => {
    const r = run(p);
    r.started("implement", 1);
    r.send({ type: "attempt_failed", step: "implement", n: 1, reason: "budget_exhausted", message: "empty" });
    // ask is need_failed: neither output's source succeeded.
    expect(r.state.outputs.map((o) => o.status)).toEqual(["dropped", "dropped"]);
    expect(r.state).toMatchObject({ status: "failed", reason: "budget_exhausted" });
  });

  it("writes each output in order, then finishes; a manual run previews instead", () => {
    const r = run(p);
    r.ok("implement");
    r.send({ type: "attempt_committed", step: "implement", n: 1, sha: "abc" });
    const actions = r.ok("ask");
    expect(actions).toContainEqual({ type: "output", key: "r_1.implement.github.pull_request", mode: "apply" });
    r.send({ type: "output_intent", key: "r_1.implement.github.pull_request" });
    expect(r.send({ type: "output_applied", key: "r_1.implement.github.pull_request", url: "u" })).toEqual([{ type: "output", key: "r_1.ask.github.comment", mode: "apply" }]);
    expect(r.send({ type: "output_applied", key: "r_1.ask.github.comment", url: "c" })).toEqual([{ type: "finish" }]);
    expect(r.state.status).toBe("succeeded");

    const manual = run({ ...p, apply: false });
    manual.ok("implement");
    manual.send({ type: "attempt_committed", step: "implement", n: 1, sha: "abc" });
    expect(manual.ok("ask")).toContainEqual({ type: "output", key: "r_1.implement.github.pull_request", mode: "preview" });
  });

  it("a failed output fails the run with output_failed (§7.5); a dry run can be applied after the run ended", () => {
    const r = run(plan([step("ask")], { outputs: [{ kind: "github.comment", step: "ask", field: "summary" }], apply: false }));
    r.ok("ask");
    r.send({ type: "output_dry_run", key: "r_1.ask.github.comment", preview: "hello" });
    expect(r.state).toMatchObject({ status: "succeeded" });
    r.send({ type: "output_intent", key: "r_1.ask.github.comment" });
    r.send({ type: "output_applied", key: "r_1.ask.github.comment", url: "https://x" });
    expect(r.state.outputs[0]).toMatchObject({ status: "applied", url: "https://x" });

    const failing = run(plan([step("ask")], { outputs: [{ kind: "github.comment", step: "ask", field: "summary" }] }));
    failing.ok("ask");
    failing.send({ type: "output_intent", key: "r_1.ask.github.comment" });
    failing.send({ type: "output_failed", key: "r_1.ask.github.comment", error: "403" });
    expect(failing.state).toMatchObject({ status: "failed", reason: "output_failed" });
  });
});

describe("run machine: cancellation (§8.3) and resume (§11)", () => {
  it("cancel: the running step cancelled, pending skipped, outputs dropped, run cancelled with the reason", () => {
    const r = run(plan([step("a"), step("b"), step("c")], { outputs: [{ kind: "github.comment", step: "a", field: "summary" }] }));
    r.ok("a");
    r.started("b", 1);
    const actions = r.send({ type: "run_cancelled", reason: "superseded" });
    expect(actions).toEqual([{ type: "release_step", step: "b" }, { type: "finish" }]);
    expect(r.state.steps.map((s) => [s.name, s.status, s.reason])).toEqual([
      ["a", "succeeded", null],
      ["b", "cancelled", "superseded"],
      ["c", "skipped", "run_cancelled"],
    ]);
    expect(r.status("b").attempts[0]).toMatchObject({ status: "cancelled", reason: "superseded" });
    expect(r.state.outputs[0]!.status).toBe("dropped");
    expect(r.state).toMatchObject({ status: "cancelled", reason: "superseded" });
    expect(r.send({ type: "attempt_finished", step: "b", n: 1, result: { summary: "late" } })).toEqual([]);
  });

  it("cancel: an attempt still being stopped after its step ended is recorded stopped, never left running in the ended run", () => {
    const checks = [{ kind: "command" as const, command: "t" }];
    const r = run(plan([step("try", { parallel: 2, checks }), step("report", { if: { try: "failed" }, computer: "none" })]));
    r.started("try", 1);
    r.started("try", 2);
    // A wallet that ran dry fails the step at once (§9.4): attempt 2 is owed a stop, and the handler starts.
    r.send({ type: "attempt_failed", step: "try", n: 1, reason: "budget_exhausted", message: "The run's wallet is empty." });
    expect(r.state.owed).toContainEqual({ type: "stop_attempt", step: "try", n: 2 });
    r.started("report", 1);
    // The Stop interrupts the runner while it stops attempt 2, so that stop never lands.
    r.send({ type: "run_cancelled", reason: "cancelled" });
    r.send({ type: "run_finished" });
    expect(r.state).toMatchObject({ status: "cancelled", owed: [] });
    expect(r.status("try").attempts.map((a) => [a.n, a.status])).toEqual([
      [1, "failed"],
      [2, "cancelled"],
    ]);
    expect(r.status("report").attempts.map((a) => [a.n, a.status])).toEqual([[1, "cancelled"]]);
  });

  it("an ended run's finish waits for the attempts still being stopped, so a restart before they stop still owes their stops", () => {
    const checks = [{ kind: "command" as const, command: "t" }];
    const r = run(plan([step("s", { parallel: 2, pick: "first", checks })]));
    r.started("s", 1);
    r.started("s", 2);
    r.finished("s", 1);
    expect(r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: true, exit: 0 })).toEqual([
      { type: "stop_attempt", step: "s", n: 2 },
      { type: "release_step", step: "s" },
    ]);
    expect(r.state).toMatchObject({ status: "succeeded", owed: [{ type: "stop_attempt", step: "s", n: 2 }] });
    expect(r.send({ type: "attempt_stopped", step: "s", n: 2 })).toEqual([{ type: "finish" }]);
    expect(r.send({ type: "attempt_stopped", step: "s", n: 2 })).toEqual([]);
    r.send({ type: "run_finished" });
    expect(r.state).toMatchObject({ status: "succeeded", owed: [] });
    expect(r.status("s").attempts.map((a) => [a.n, a.status, a.reason])).toEqual([
      [1, "succeeded", null],
      [2, "skipped", "not_picked"],
    ]);
  });

  it("replay folds the journal to the same state", () => {
    const r = run(plan([step("a"), step("b", { if: { a: "go" } })]));
    r.ok("a", 1, "go");
    r.ok("b");
    expect(replay(r.log)).toEqual(r.state);
  });

  it("resume re-issues what was owed; an agent turn that was under way fails as agent_error and the retry rules decide", () => {
    const r = run(plan([step("a"), step("b", { retries: 1, checks: [{ kind: "command", command: "t" }] })]));
    r.ok("a");
    // b was owed but never started: start it.
    expect(next(replay(r.log), { type: "run_resumed", at }).actions).toEqual([expect.objectContaining({ type: "start_attempt", step: "b", n: 1 })]);
    r.started("b", 1);
    const resumed = next(replay(r.log), { type: "run_resumed", at });
    expect(resumed.state.steps[1]!.attempts[0]).toMatchObject({ status: "failed", reason: "agent_error" });
    expect(resumed.actions).toEqual([expect.objectContaining({ type: "start_attempt", step: "b", n: 2, session: "continue" })]);
    // A check that was running is run again; a completed step is never re-run.
    r.finished("b", 1);
    expect(next(replay(r.log), { type: "run_resumed", at }).actions).toEqual([{ type: "run_check", step: "b", n: 1, index: 0 }]);
    expect(replay(r.log)!.steps[0]!.attempts).toHaveLength(1);
  });

  it("refuses a journal that does not start with run_admitted", () => {
    expect(() => next(undefined, { type: "run_resumed", at })).toThrow(/run_admitted/);
  });
});

// ---------------------------------------------------------------- v2: graphs, parallel, timers, approvals, rubrics

const graph = (steps: PlanStep[], over: Partial<RunPlan> = {}): RunPlan => plan(steps, { graph: true, limit: 4, ...over });
const starts = (actions: ReadonlyArray<Action>) => actions.filter((a): a is Extract<Action, { type: "start_attempt" }> => a.type === "start_attempt").map((a) => `${a.step}.${a.n}`);

describe("run machine: graphs (§1.2-1.4)", () => {
  it("starts every step whose needs are done, side by side, and joins on the step that needs them all", () => {
    const r = run(graph([step("a", { needs: [] }), step("b", { needs: ["a"] }), step("c", { needs: ["a"] }), step("d", { needs: ["b", "c"] })]));
    expect(starts(r.actions)).toEqual(["a.1"]);
    expect(starts(r.ok("a"))).toEqual(["b.1", "c.1"]);
    expect(r.state.steps.map((s) => s.status)).toEqual(["succeeded", "running", "running", "pending"]);
    expect(starts(r.ok("b"))).toEqual([]);
    expect(starts(r.ok("c"))).toEqual(["d.1"]);
    expect(r.ok("d")).toEqual([{ type: "release_step", step: "d" }, { type: "finish" }]);
    expect(r.state.status).toBe("succeeded");
  });

  it("runs at most the run's limit of steps at once, and the next starts when one ends", () => {
    const five = ["a", "b", "c", "d", "e"].map((n) => step(n, { needs: [] }));
    const r = run(graph(five, { limit: 4 }));
    expect(starts(r.actions)).toEqual(["a.1", "b.1", "c.1", "d.1"]);
    expect(starts(r.ok("c"))).toEqual(["e.1"]);
  });

  it("steps that write the run's branch take turns; readers run beside a writer", () => {
    const r = run(graph([step("w1", { needs: [], computer: "full" }), step("w2", { needs: [], computer: "full" }), step("read", { needs: [] })]));
    expect(starts(r.actions)).toEqual(["w1.1", "read.1"]);
    r.ok("w1");
    expect(starts(r.send({ type: "attempt_committed", step: "w1", n: 1, sha: "s1" }))).toEqual(["w2.1"]);
  });

  it("a skip propagates (need_skipped), a failed need is need_not_succeeded unless if names it failed, and a failure stops new branches", () => {
    const r = run(
      graph([
        step("gate", { needs: [], if: { nothing: "x" } }),
        step("after-gate", { needs: ["gate"] }),
        step("work", { needs: [] }),
        step("on-fail", { needs: ["work"], if: { work: "failed" } }),
        step("on-ok", { needs: ["work"] }),
      ]),
    );
    expect(r.state.steps.map((s) => [s.name, s.status, s.reason])).toEqual([
      ["gate", "skipped", "condition_false"],
      ["after-gate", "skipped", "need_skipped"],
      ["work", "running", null],
      ["on-fail", "pending", null],
      ["on-ok", "pending", null],
    ]);
    r.started("work", 1);
    expect(starts(r.send({ type: "attempt_failed", step: "work", n: 1, reason: "agent_error", message: "boom" }))).toEqual(["on-fail.1"]);
    expect(r.status("on-ok")).toMatchObject({ status: "skipped", reason: "need_failed" });
    r.ok("on-fail");
    expect(r.state).toMatchObject({ status: "failed", reason: "agent_error" });
  });

  it("planOf marks a file with needs as a graph and carries every v2 key", () => {
    const file = parseAutomation({
      path: ".caveman/automations/x.yaml",
      text: [
        "host: cloud",
        "on: { slack: { mention: true } }",
        "steps:",
        "  build: { run: make, computer: full }",
        "  fix:",
        "    needs: [build]",
        "    prompt: fix it",
        "    parallel: 3",
        "    checks: [make test]",
        "    retries: 1",
        "    escalate: [{ model: frontier }, { engine: codex }]",
        "    outcome: { rubric: tests pass }",
        "    approve: { by: owner }",
        "  pause: { needs: [fix], wait: 30m }",
        "outputs:",
        "  slack.message: { from: fix, channel: \"#ops\" }",
        "",
      ].join("\n"),
    }).file!;
    const p = planOf(file, [], true, "x");
    expect(p).toMatchObject({ graph: true, limit: 4, outputs: [{ kind: "slack.message", step: "fix", field: "summary", channel: "#ops" }] });
    expect(p.steps[0]).toMatchObject({ name: "build", kind: "run", run: "make", model: "none", computer: "full" });
    expect(p.steps[1]).toMatchObject({
      needs: ["build"],
      parallel: 3,
      pick: "best",
      escalate: [{ model: "frontier" }, { engine: "codex" }],
      outcome: { rubric: "tests pass", maxIterations: 2 },
      approve: { by: "owner", timeoutMs: 72 * 3_600_000 },
    });
    expect(p.steps[2]).toMatchObject({ kind: "wait", waitMs: 30 * 60_000 });
  });
});

describe("run machine: escalation ladders (§3.3)", () => {
  it("climbs one rung per failure, and a rung that names another engine starts a new session there", () => {
    const r = run(plan([step("s", { retries: 2, escalate: [{ model: "frontier" }, { engine: "codex", model: "frontier" }], checks: [{ kind: "command", command: "t" }] })]));
    r.ok("s", 1);
    let actions = r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: false, exit: 1, text: "FAIL" });
    expect(actions).toEqual([expect.objectContaining({ type: "start_attempt", n: 2, asked: "frontier", escalated: true, session: "new" })]);
    expect(actions[0]).not.toHaveProperty("engine");
    r.send({ type: "step_started", step: "s", n: 2, model: { asked: "frontier", resolved: "frontier" }, engine: "caveman", computer: "readonly", session: "new", thread_id: "t2" });
    r.finished("s", 2);
    actions = r.send({ type: "check_result", step: "s", n: 2, index: 0, passed: false, exit: 1, text: "FAIL again" });
    expect(actions).toEqual([expect.objectContaining({ type: "start_attempt", n: 3, asked: "frontier", engine: "codex", escalated: true, session: "new" })]);
  });
});

describe("run machine: parallel attempts and pick (§4)", () => {
  const checks = [{ kind: "command" as const, command: "t" }];
  const pass = (r: ReturnType<typeof run>, n: number, ok: boolean) => {
    r.started("s", n);
    r.finished("s", n);
    return r.send({ type: "check_result", step: "s", n, index: 0, passed: ok, exit: ok ? 0 : 1 });
  };

  it("pick best: N attempts at once; with two that passed, the picker chooses, the other is not picked", () => {
    const r = run(plan([step("s", { parallel: 3, pick: "best", checks })]));
    expect(r.actions).toEqual([1, 2, 3].map((n) => expect.objectContaining({ type: "start_attempt", step: "s", n, candidate: n })));
    expect(pass(r, 1, true)).toEqual([]);
    expect(pass(r, 2, false)).toEqual([]);
    expect(pass(r, 3, true)).toEqual([{ type: "pick", step: "s", candidates: [1, 3] }]);
    r.send({ type: "picked", step: "s", n: 3, text: "3 is smaller" });
    expect(r.status("s")).toMatchObject({ status: "succeeded", chosen: 3, result: { summary: "s done" } });
    expect(r.status("s").attempts.map((a) => [a.n, a.status, a.reason])).toEqual([
      [1, "skipped", "not_picked"],
      [2, "failed", "checks_failed"],
      [3, "succeeded", null],
    ]);
  });

  it("an invalid pick takes the cheapest passing attempt and records pick_invalid", () => {
    const r = run(plan([step("s", { parallel: 2, checks })]));
    r.started("s", 1);
    r.send({ type: "attempt_finished", step: "s", n: 1, result: { summary: "one" }, cost: { ...NO_COST_FOR_TESTS, usd: 0.5 } });
    r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: true });
    r.started("s", 2);
    r.send({ type: "attempt_finished", step: "s", n: 2, result: { summary: "two" }, cost: { ...NO_COST_FOR_TESTS, usd: 0.1 } });
    r.send({ type: "check_result", step: "s", n: 2, index: 0, passed: true });
    r.send({ type: "picked", step: "s", n: null });
    expect(r.status("s")).toMatchObject({ status: "succeeded", chosen: 2, pickNote: "pick_invalid", result: { summary: "two" } });
  });

  it("pick first: the first attempt that passes wins at once, and the others still working are stopped", () => {
    const r = run(plan([step("s", { parallel: 3, pick: "first", checks, computer: "full" })]));
    r.started("s", 1);
    r.started("s", 2);
    r.started("s", 3);
    r.finished("s", 2);
    const actions = r.send({ type: "check_result", step: "s", n: 2, index: 0, passed: true });
    expect(actions).toEqual([{ type: "stop_attempt", step: "s", n: 1 }, { type: "stop_attempt", step: "s", n: 3 }, { type: "commit", step: "s", n: 2 }]);
    // A loser's late result changes nothing; its stop is recorded.
    expect(r.finished("s", 1)).toEqual([]);
    r.send({ type: "attempt_stopped", step: "s", n: 1 });
    r.send({ type: "attempt_committed", step: "s", n: 2, sha: "c2" });
    r.send({ type: "attempt_stopped", step: "s", n: 3 });
    expect(r.status("s").attempts.map((a) => [a.n, a.status, a.reason])).toEqual([
      [1, "skipped", "not_picked"],
      [2, "succeeded", null],
      [3, "skipped", "not_picked"],
    ]);
    expect(r.state.status).toBe("succeeded");
  });

  it("a round where nothing passed runs again as a whole under retries, then fails checks_failed", () => {
    const r = run(plan([step("s", { parallel: 2, checks, retries: 1 })]));
    pass(r, 1, false);
    expect(starts(pass(r, 2, false))).toEqual(["s.3", "s.4"]);
    pass(r, 3, false);
    pass(r, 4, false);
    expect(r.status("s")).toMatchObject({ status: "failed", reason: "checks_failed" });
    expect(r.status("s").attempts).toHaveLength(4);
  });

  // runner.ts commit fails with a StepError when the picked copy is gone (always, after a restart) or git fails, and
  // perform appends attempt_failed agent_error for it.
  const commitFails = (r: ReturnType<typeof run>, n: number) => r.send({ type: "attempt_failed", step: "s", n, reason: "agent_error", message: "The picked attempt's copy is gone, so its work cannot be committed." });

  it("pick best: a chosen attempt whose commit fails fails its round, and the retry round is chosen and committed", () => {
    const r = run(plan([step("s", { parallel: 2, pick: "best", checks, retries: 1, computer: "full" })]));
    pass(r, 2, false);
    expect(pass(r, 1, true)).toEqual([{ type: "commit", step: "s", n: 1 }]);
    expect(starts(commitFails(r, 1))).toEqual(["s.3", "s.4"]);
    expect(r.status("s")).not.toHaveProperty("chosen");
    pass(r, 4, false);
    expect(pass(r, 3, true)).toEqual([{ type: "commit", step: "s", n: 3 }]);
    r.send({ type: "attempt_committed", step: "s", n: 3, sha: "c3" });
    expect(r.status("s")).toMatchObject({ status: "succeeded", chosen: 3, sha: "c3" });
    expect(r.state).toMatchObject({ status: "succeeded", owed: [{ type: "finish" }] });
  });

  it("pick first: a winner whose commit fails with no retries left fails the step, and the run ends once the loser has stopped", () => {
    const r = run(plan([step("s", { parallel: 2, pick: "first", checks, computer: "full" })]));
    r.started("s", 1);
    r.started("s", 2);
    r.finished("s", 1);
    expect(r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: true, exit: 0 })).toEqual([
      { type: "stop_attempt", step: "s", n: 2 },
      { type: "commit", step: "s", n: 1 },
    ]);
    commitFails(r, 1);
    expect(r.status("s")).toMatchObject({ status: "failed", reason: "agent_error" });
    expect(r.state).toMatchObject({ status: "failed", reason: "agent_error" });
    r.send({ type: "attempt_stopped", step: "s", n: 2 });
    expect(r.state.owed).toEqual([{ type: "finish" }]);
    r.send({ type: "run_finished" });
    expect(r.status("s").attempts.map((a) => [a.n, a.status])).toEqual([
      [1, "failed"],
      [2, "cancelled"],
    ]);
    expect(r.state.owed).toEqual([]);
  });

  for (const retries of [0, 1]) {
    it(`pick first, retries: ${retries}: an attempt that runs out of the run's wallet fails the step at once with budget_exhausted, stops the others, and starts no new round`, () => {
      const r = run(plan([step("s", { parallel: 2, pick: "first", checks, retries })]));
      r.started("s", 1);
      r.started("s", 2);
      const atFailure = r.send({ type: "attempt_failed", step: "s", n: 1, reason: "budget_exhausted", message: "The run's wallet is empty." });
      // The other attempt then fails its check, before or after its stop lands.
      r.finished("s", 2);
      const atCheck = r.send({ type: "check_result", step: "s", n: 2, index: 0, passed: false, exit: 1 });
      expect(starts([...atFailure, ...atCheck])).toEqual([]);
      expect(r.status("s")).toMatchObject({ status: "failed", reason: "budget_exhausted" });
      expect(atFailure).toContainEqual({ type: "stop_attempt", step: "s", n: 2 });
      r.send({ type: "attempt_stopped", step: "s", n: 2 });
      expect(r.state).toMatchObject({ status: "failed", reason: "budget_exhausted" });
    });
  }

  it("pick first: a winner whose commit fails starts a new round; the loser still stopping is stopped once and its late result changes nothing", () => {
    const r = run(plan([step("s", { parallel: 2, pick: "first", checks, retries: 1, computer: "full" })]));
    r.started("s", 1);
    r.started("s", 2);
    r.finished("s", 1);
    r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: true, exit: 0 });
    expect(starts(commitFails(r, 1))).toEqual(["s.3", "s.4"]);
    // Attempt 2 is still being stopped: its own late result is no part of the new round.
    expect(r.finished("s", 2)).toEqual([]);
    r.started("s", 3);
    r.started("s", 4);
    r.finished("s", 3);
    expect(r.send({ type: "check_result", step: "s", n: 3, index: 0, passed: true, exit: 0 })).toEqual([
      { type: "stop_attempt", step: "s", n: 4 },
      { type: "commit", step: "s", n: 3 },
    ]);
    expect(r.state.owed.filter((a) => a.type === "stop_attempt")).toEqual([
      { type: "stop_attempt", step: "s", n: 2 },
      { type: "stop_attempt", step: "s", n: 4 },
    ]);
    r.send({ type: "attempt_committed", step: "s", n: 3, sha: "c3" });
    r.send({ type: "attempt_stopped", step: "s", n: 2 });
    r.send({ type: "attempt_stopped", step: "s", n: 4 });
    expect(r.status("s")).toMatchObject({ status: "succeeded", chosen: 3 });
    expect(r.status("s").attempts.map((a) => [a.n, a.status, a.reason])).toEqual([
      [1, "failed", "agent_error"],
      [2, "skipped", "not_picked"],
      [3, "succeeded", null],
      [4, "skipped", "not_picked"],
    ]);
  });
});

describe("run machine: timers survive restarts", () => {
  it("a wait step waits until a time fixed in the journal; a resume re-arms the same deadline; the run waits meanwhile", () => {
    const r = run(plan([step("first"), step("pause", { kind: "wait", waitMs: 90 * 60_000 }), step("after")]));
    r.ok("first");
    const until = "2026-10-20T01:30:00.000Z";
    expect(r.actions).toEqual([{ type: "release_step", step: "first" }, { type: "wait_until", step: "pause", until }]);
    expect(r.state.status).toBe("waiting");
    expect(r.status("pause")).toMatchObject({ status: "waiting", waitingUntil: until });
    // A restart: the journal folds to the same state, and resume asks for the same timer again.
    const resumed = next(replay(r.log), { type: "run_resumed", at: "2026-10-20T00:45:00.000Z" });
    expect(resumed.actions).toEqual([{ type: "wait_until", step: "pause", until }]);
    expect(starts(r.send({ type: "timer_fired", step: "pause" }))).toEqual(["after.1"]);
    expect(r.status("pause").status).toBe("succeeded");
    // A second firing (a timer from before the restart) changes nothing.
    expect(r.send({ type: "timer_fired", step: "pause" })).toEqual([]);
  });
});

describe("run machine: approvals (§5)", () => {
  it("pauses after the step succeeds, with its dependents and outputs held, until a person approves", () => {
    const r = run(plan([step("deploy", { approve: { by: "owner", timeoutMs: 3_600_000 } }), step("announce")], { outputs: [{ kind: "github.comment", step: "deploy", field: "summary" }] }));
    expect(r.ok("deploy")).toEqual([{ type: "await_approval", step: "deploy", by: "owner", until: "2026-10-20T01:00:00.000Z" }]);
    expect(r.state.status).toBe("waiting");
    expect(r.status("deploy")).toMatchObject({ status: "waiting", approval: { by: "owner", askedAt: at, expiresAt: "2026-10-20T01:00:00.000Z" } });
    expect(r.status("announce").status).toBe("pending");
    expect(next(replay(r.log), { type: "run_resumed", at }).actions).toEqual([{ type: "await_approval", step: "deploy", by: "owner", until: "2026-10-20T01:00:00.000Z" }]);
    const approved = r.send({ type: "approval_answered", step: "deploy", decision: "approve", by: "julius" });
    expect(approved).toEqual([{ type: "release_step", step: "deploy" }, expect.objectContaining({ type: "start_attempt", step: "announce" })]);
    expect(r.status("deploy")).toMatchObject({ status: "succeeded", approval: { decision: "approve", decidedBy: "julius" } });
    // Answering twice does nothing.
    expect(r.send({ type: "approval_answered", step: "deploy", decision: "reject" })).toEqual([]);
  });

  it("a rejection fails the step (approval_rejected) and only a failure handler runs; no answer in time is approval_expired", () => {
    const p = plan([step("deploy", { approve: { by: "members", timeoutMs: 60_000 } }), step("next"), step("undo", { if: { deploy: "failed" } })]);
    const rejected = run(p);
    rejected.ok("deploy");
    expect(starts(rejected.send({ type: "approval_answered", step: "deploy", decision: "reject", message: "not today" }))).toEqual(["undo.1"]);
    expect(rejected.status("deploy")).toMatchObject({ status: "failed", reason: "approval_rejected", approval: { message: "not today" } });
    expect(rejected.status("next")).toMatchObject({ status: "skipped", reason: "need_failed" });
    const expired = run(p);
    expired.ok("deploy");
    expired.send({ type: "approval_expired", step: "deploy" });
    expect(expired.status("deploy")).toMatchObject({ status: "failed", reason: "approval_expired" });
  });
});

describe("run machine: untrusted trigger text (SECURITY M1)", () => {
  const FILE = [
    "host: cloud",
    "on: { slack: { mention: true } }",
    "steps:",
    "  look: { prompt: look around }",
    "  build: { needs: [look], prompt: build it, computer: full }",
    "  answer: { needs: [look], prompt: answer, computer: none }",
    "  pause: { needs: [build], wait: 5m }",
    "  notes: { needs: [look], prompt: notes }",
    "outputs:",
    "  slack.message: answer.summary",
    "",
  ].join("\n");
  const gate = { by: "owner" as const, timeoutMs: 72 * 3_600_000 };
  const until = "2026-10-23T00:00:00.000Z";

  it("planOf gates every step that can write when the text is untrusted, and none when it is trusted", () => {
    const parse = (text: string) => parseAutomation({ path: ".caveman/automations/x.yaml", text }).file!;
    const file = parse(FILE);
    const gated = (p: RunPlan) => p.steps.filter((s) => s.gate !== undefined).map((s) => s.name);
    // build has a full computer; answer only replies in the Slack thread the text came from, so it runs as usual,
    // as do look and notes (they read) and pause (a timer).
    expect(gated(planOf(file, [], true, "x", { untrusted: true }))).toEqual(["build"]);
    expect(planOf(file, [], true, "x", { untrusted: true }).steps[1]!.gate).toEqual(gate);
    // The same answer posted to another channel waits; so does a pull request's step.
    expect(gated(planOf(parse(FILE.replace("slack.message: answer.summary", 'slack.message: { from: answer, channel: "#ops" }')), [], true, "x", { untrusted: true }))).toEqual(["build", "answer"]);
    expect(gated(planOf(parse(FILE.replace("slack.message: answer.summary", "github.pull_request: { from: build }")), [], true, "x", { untrusted: true }))).toEqual(["build"]);
    expect(gated(planOf(file, [], true, "x"))).toEqual([]);
    expect(gated(planOf(file, [], true, "x", { untrusted: false }))).toEqual([]);
  });

  it("a writing step waits for the owner before it runs, while steps that only read run as usual", () => {
    const r = run(plan([step("look"), step("post", { gate })], { outputs: [{ kind: "github.comment", step: "post", field: "summary" }] }));
    expect(starts(r.actions)).toEqual(["look.1"]);
    // look done: post is asked about before anything of it runs.
    expect(r.ok("look")).toEqual([{ type: "release_step", step: "look" }, { type: "await_approval", step: "post", by: "owner", until }]);
    expect(r.status("post")).toMatchObject({ status: "waiting", attempts: [], waitingUntil: until, approval: { by: "owner", askedAt: at, expiresAt: until, before: true } });
    expect(r.state.status).toBe("waiting");
    // A restart asks again.
    expect(next(replay(r.log), { type: "run_resumed", at }).actions).toEqual([{ type: "await_approval", step: "post", by: "owner", until }]);
    expect(r.send({ type: "approval_answered", step: "post", decision: "approve", by: "julius" })).toEqual([
      { type: "start_attempt", step: "post", n: 1, asked: "base", escalated: false, session: "new" },
    ]);
    expect(r.status("post")).toMatchObject({ status: "running", approval: { before: true, decision: "approve", decidedBy: "julius" } });
    expect(r.status("post").waitingUntil).toBeUndefined();
    expect(r.ok("post")).toContainEqual({ type: "output", key: "r_1.post.github.comment", mode: "apply" });
  });

  it("a rejection or no answer fails the step unrun: its output is dropped and the steps after it do not run", () => {
    const p = plan([step("post", { gate }), step("after")], { outputs: [{ kind: "github.comment", step: "post", field: "summary" }] });
    const rejected = run(p);
    expect(rejected.actions).toEqual([{ type: "await_approval", step: "post", by: "owner", until }]);
    rejected.send({ type: "approval_answered", step: "post", decision: "reject", message: "spam" });
    expect(rejected.status("post")).toMatchObject({ status: "failed", reason: "approval_rejected", attempts: [], approval: { before: true, decision: "reject", message: "spam" } });
    expect(rejected.status("after")).toMatchObject({ status: "skipped", reason: "need_failed" });
    expect(rejected.state).toMatchObject({ status: "failed", reason: "approval_rejected", outputs: [{ status: "dropped" }] });
    const expired = run(p);
    expired.send({ type: "approval_expired", step: "post" });
    expect(expired.status("post")).toMatchObject({ status: "failed", reason: "approval_expired", attempts: [] });
  });

  it("in a graph the gate is asked at once and takes no turn; approved, the writer waits for the branch like any other", () => {
    const r = run(graph([step("w1", { needs: [], computer: "full" }), step("w2", { needs: [], computer: "full", gate }), step("read", { needs: [] })]));
    expect(r.actions).toEqual([
      { type: "start_attempt", step: "w1", n: 1, asked: "base", escalated: false, session: "new" },
      { type: "await_approval", step: "w2", by: "owner", until },
      { type: "start_attempt", step: "read", n: 1, asked: "base", escalated: false, session: "new" },
    ]);
    // Approved while w1 still writes the branch: w2 waits its turn.
    expect(starts(r.send({ type: "approval_answered", step: "w2", decision: "approve" }))).toEqual([]);
    expect(r.status("w2")).toMatchObject({ status: "pending", approval: { before: true, decision: "approve" } });
    r.ok("w1");
    expect(starts(r.send({ type: "attempt_committed", step: "w1", n: 1, sha: "s1" }))).toEqual(["w2.1"]);
  });

  it("a gated step that also has approve asks the owner before it runs, then whoever approve names after", () => {
    const r = run(plan([step("ship", { gate, approve: { by: "members", timeoutMs: 3_600_000 } })]));
    expect(r.actions).toEqual([{ type: "await_approval", step: "ship", by: "owner", until }]);
    r.send({ type: "approval_answered", step: "ship", decision: "approve", by: "julius" });
    expect(r.ok("ship")).toEqual([{ type: "await_approval", step: "ship", by: "members", until: "2026-10-20T01:00:00.000Z" }]);
    expect(r.status("ship").approval).toEqual({ by: "members", askedAt: at, expiresAt: "2026-10-20T01:00:00.000Z" });
    r.send({ type: "approval_answered", step: "ship", decision: "approve", by: "ana" });
    expect(r.state.status).toBe("succeeded");
  });
});

describe("run machine: the rubric loop (outcome)", () => {
  it("grades after the checks; work that falls short goes back with the feedback; the loop stops at max_iterations", () => {
    const r = run(plan([step("s", { retries: 3, checks: [{ kind: "command", command: "t" }], outcome: { rubric: "covers page 0", maxIterations: 2 } })]));
    r.ok("s", 1);
    expect(r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: true })).toEqual([{ type: "grade", step: "s", n: 1 }]);
    const again = r.send({ type: "graded", step: "s", n: 1, satisfied: false, text: "page 0 is not tested" });
    expect(again).toEqual([expect.objectContaining({ type: "start_attempt", step: "s", n: 2, asked: "base", session: "continue", failures: expect.stringContaining("page 0 is not tested") })]);
    r.started("s", 2, "base", "continue");
    r.finished("s", 2);
    r.send({ type: "check_result", step: "s", n: 2, index: 0, passed: true });
    // The second shortfall is the last: max_iterations bounds the loop, whatever retries allows.
    expect(r.send({ type: "graded", step: "s", n: 2, satisfied: false, text: "still not" })).toEqual([{ type: "release_step", step: "s" }, { type: "finish" }]);
    expect(r.status("s")).toMatchObject({ status: "failed", reason: "outcome_unmet" });
    expect(r.status("s").attempts.map((a) => [a.n, a.reason, a.grade?.satisfied])).toEqual([
      [1, "outcome_unmet", false],
      [2, "outcome_unmet", false],
    ]);
  });

  it("a satisfied grade lets the step succeed; a failed check before the grade still retries under retries", () => {
    const r = run(plan([step("s", { retries: 1, checks: [{ kind: "command", command: "t" }], outcome: { rubric: "r", maxIterations: 1 } })]));
    r.ok("s", 1);
    expect(starts(r.send({ type: "check_result", step: "s", n: 1, index: 0, passed: false, exit: 1 }))).toEqual(["s.2"]);
    r.started("s", 2, "base", "continue");
    r.finished("s", 2);
    r.send({ type: "check_result", step: "s", n: 2, index: 0, passed: true });
    r.send({ type: "graded", step: "s", n: 2, satisfied: true, text: "meets it" });
    expect(r.state.status).toBe("succeeded");
  });
});

describe("run machine: command steps", () => {
  it("a run step is an attempt with no model; a full one commits what it changed", () => {
    const r = run(plan([step("build", { kind: "run", run: "make", model: "none", computer: "full" })]));
    expect(r.actions).toEqual([expect.objectContaining({ type: "start_attempt", step: "build", n: 1, asked: "none" })]);
    r.started("build", 1, "none");
    expect(r.finished("build", 1)).toEqual([{ type: "commit", step: "build", n: 1 }]);
  });
});

const NO_COST_FOR_TESTS = { usd: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0, billing: "api_key" as const };
