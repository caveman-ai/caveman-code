// check's if-failed-never-runs against the real machine: across every graph of four steps, check warns about a
// failure handler exactly when the machine can never run it (SEMANTICS §1.3, §1.4, §2.2).
import { checkProject, parseAutomation } from "@caveman-app/automations";
import { describe, expect, it } from "vitest";

import { next, planOf, type Action, type RunEvent, type RunState } from "./machine.ts";

const at = "2026-10-20T00:00:00.000Z";
const PATH = ".caveman/automations/handlers.yaml";
const NAMES = ["a", "b", "c", "d"] as const;

type Draft = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at"> : never) : never;

/**
 * Each step's status after a run in which the `failing` steps fail and every other step succeeds, in the order kindest
 * to the handlers: a failing attempt ends only once nothing else can move, so every step that could start before it
 * did. The failing attempts then end in the order given.
 */
function statusesWhen(
  text: string,
  failing: ReadonlyArray<string>,
): Readonly<Record<string, string>> {
  let state: RunState | undefined;
  const todo: Action[] = [];
  const held: Array<{ readonly step: string; readonly n: number }> = [];
  const send = (event: Draft) => {
    const t = next(state, { at, ...event } as RunEvent);
    state = t.state;
    todo.push(...t.actions);
  };
  send({
    type: "run_admitted",
    run: "r_1",
    plan: planOf(parseAutomation({ path: PATH, text }).file!, [], true, "handlers"),
  });
  for (;;) {
    const action = todo.shift();
    if (action === undefined) {
      const first = failing.flatMap((name) => held.filter((h) => h.step === name))[0];
      if (first === undefined) break;
      held.splice(held.indexOf(first), 1);
      send({
        type: "attempt_failed",
        step: first.step,
        n: first.n,
        reason: "agent_error",
        message: "boom",
      });
    } else if (action.type === "start_attempt") {
      send({
        type: "step_started",
        step: action.step,
        n: action.n,
        model: { asked: action.asked, resolved: action.asked },
        computer: "readonly",
        session: "new",
        thread_id: `t-${action.step}`,
        start_sha: "s0",
      });
      if (failing.includes(action.step)) held.push(action);
      else
        send({
          type: "attempt_finished",
          step: action.step,
          n: action.n,
          result: { summary: "done" },
        });
    } else if (action.type === "finish") send({ type: "run_finished" });
    else if (action.type !== "release_step") throw new Error(`no event for ${action.type}`);
  }
  return Object.fromEntries(state!.steps.map((s) => [s.name, s.status]));
}

/** Every graph of four steps (each needs any of the ones above it), every step that fails, and every set of its handlers. */
function* cases() {
  for (let shape = 0; shape < 64; shape++) {
    const needs: Record<string, ReadonlyArray<string>> = {
      a: [],
      b: shape & 1 ? ["a"] : [],
      c: NAMES.slice(0, 2).filter((_, j) => (shape >> (1 + j)) & 1),
      d: NAMES.slice(0, 3).filter((_, j) => (shape >> (3 + j)) & 1),
    };
    const below = (name: string): ReadonlySet<string> =>
      new Set(needs[name]!.flatMap((n) => [n, ...below(n)]));
    for (const failing of ["a", "b", "c"]) {
      const able = NAMES.filter((n) => below(n).has(failing));
      for (let pick = 1; pick < 1 << able.length; pick++) {
        const handlers = able.filter((_, j) => (pick >> j) & 1);
        const text = `steps:\n${NAMES.map((n) => `  ${n}: { prompt: ${n}${needs[n]!.length > 0 ? `, needs: [${needs[n]!.join(", ")}]` : ""}${handlers.includes(n) ? `, if: { ${failing}: failed }` : ""} }`).join("\n")}\n`;
        yield { text, failing, handlers };
      }
    }
  }
}

describe("a failure handler in a graph", () => {
  it("is reported by check exactly when the machine can never run it", () => {
    const wrong: string[] = [];
    let handlers = 0;
    let dead = 0;
    for (const c of cases()) {
      const diagnostics = checkProject({
        files: [{ path: PATH, text: c.text }],
        agents: [],
      }).diagnostics;
      expect(
        diagnostics.filter((d) => d.code !== "if-failed-never-runs"),
        c.text,
      ).toEqual([]);
      const warned = new Set(diagnostics.map((d) => /^"([a-d])"/.exec(d.message)?.[1]));
      const status = statusesWhen(c.text, [c.failing]);
      for (const h of c.handlers) {
        handlers++;
        if (status[h] !== "succeeded") dead++;
        if (warned.has(h) !== (status[h] !== "succeeded"))
          wrong.push(
            `${c.failing} fails, ${h} ${status[h]}, check ${warned.has(h) ? "warns" : "says nothing"}:\n${c.text}`,
          );
      }
    }
    expect(wrong).toEqual([]);
    // The sweep reaches both kinds of handler.
    expect(handlers).toBeGreaterThan(200);
    expect(dead).toBeGreaterThan(50);
  });

  it("among handlers of different failures, is reported by check exactly when the machine can never run it", () => {
    // Every graph of four steps, each step testing any set of the steps it needs, directly or not, with failed. A handler
    // runs only when every step it tests fails, so it is judged over every set of the tested steps failing, in every order.
    const subsets = <T>(xs: ReadonlyArray<T>): T[][] =>
      xs.reduce<T[][]>((all, x) => [...all, ...all.map((s) => [...s, x])], [[]]);
    const orders = <T>(xs: ReadonlyArray<T>): T[][] =>
      xs.length <= 1
        ? [[...xs]]
        : xs.flatMap((x, i) =>
            orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((o) => [x, ...o]),
          );
    const wrong: string[] = [];
    let handlers = 0;
    let dead = 0;
    for (let shape = 0; shape < 64; shape++) {
      const needs: Record<string, ReadonlyArray<string>> = {
        a: [],
        b: shape & 1 ? ["a"] : [],
        c: NAMES.slice(0, 2).filter((_, j) => (shape >> (1 + j)) & 1),
        d: NAMES.slice(0, 3).filter((_, j) => (shape >> (3 + j)) & 1),
      };
      const below = (name: string): ReadonlyArray<string> =>
        [...new Set(needs[name]!.flatMap((n) => [n, ...below(n)]))].sort();
      const files = NAMES.reduce<string[][][]>(
        (all, n) => all.flatMap((tests) => subsets(below(n)).map((own) => [...tests, own])),
        [[]],
      );
      for (const tests of files) {
        const refs = [...new Set(tests.flat())].sort();
        // One failure tested throughout is the sweep above.
        if (refs.length < 2) continue;
        const text = `steps:\n${NAMES.map((n, i) => `  ${n}: { prompt: ${n}${needs[n]!.length > 0 ? `, needs: [${needs[n]!.join(", ")}]` : ""}${tests[i]!.length > 0 ? `, if: { ${tests[i]!.map((r) => `${r}: failed`).join(", ")} }` : ""} }`).join("\n")}\n`;
        const diagnostics = checkProject({ files: [{ path: PATH, text }], agents: [] }).diagnostics;
        expect(
          diagnostics.filter((d) => d.code !== "if-failed-never-runs"),
          text,
        ).toEqual([]);
        const warned = new Set(diagnostics.map((d) => /^"([a-d])"/.exec(d.message)?.[1]));
        const runs = subsets(refs)
          .flatMap(orders)
          .filter((o) => o.length > 0)
          .map((failing) => statusesWhen(text, failing));
        NAMES.forEach((h, i) => {
          if (tests[i]!.length === 0) return;
          handlers++;
          const canRun = runs.some((status) => status[h] === "succeeded");
          if (!canRun) dead++;
          if (warned.has(h) === canRun)
            wrong.push(
              `${h} ${canRun ? "can run" : "never runs"}, check ${warned.has(h) ? "warns" : "says nothing"}:\n${text}`,
            );
        });
      }
    }
    expect(wrong).toEqual([]);
    expect(handlers).toBeGreaterThan(1500);
    expect(dead).toBeGreaterThan(500);
  });
});
