// A known finding as a test that pins its counterexample (client.modelcheck.test.ts here; chat-feed.modelcheck.test.ts
// and sender.modelcheck.test.ts in apps/web/src/state/sync). A bare test.fails passes whenever its run throws for any
// reason; this passes only while the run breaks the finding's own property along a trace with the finding's steps and
// harm, so a regression elsewhere fails the test instead of passing for it.
import { formatTrace, type Verdict } from "@caveman-app/model-check";

export interface Expected {
  /** The verdict kind and property (its exact text in the spec) the finding breaks. */
  readonly kind: "invariant" | "eventually" | "atEnd";
  readonly property: string;
  /** Steps of the counterexample in order, each a substring of a step's action name or a pattern: the recipe. */
  readonly steps: ReadonlyArray<string | RegExp>;
  /** The harm, read off the rendering of the trace's last state. */
  readonly shows: RegExp;
}

const matches = (action: string, want: string | RegExp) =>
  typeof want === "string" ? action.includes(want) : want.test(action);

/**
 * Throws "NO LONGER REPRODUCES" when the run passes (a fix landed?), and "A DIFFERENT FAILURE" when it breaks
 * another property, or this one by another path or harm (a regression, or the finding changed shape). Neither means
 * fixed until the trace has been read.
 */
export const expectFinding = <S>(
  verdict: Verdict<S>,
  expected: Expected,
  show: (state: S) => string,
): void => {
  if (verdict.ok) {
    throw new Error(
      `NO LONGER REPRODUCES: the run passes (${verdict.states} states, exhaustive ${verdict.exhaustive}). If a fix for this finding landed, ` +
        `turn this test into a verified run (assertHolds) and lift its exclusion from the verified run (.claude/skills/client-delivery/SKILL.md, "Known findings").`,
    );
  }
  const trace = `${formatTrace(verdict.trace, show)}${verdict.error !== undefined ? `\nerror: ${String(verdict.error)}` : ""}`;
  const different = (why: string) =>
    new Error(
      `A DIFFERENT FAILURE, not this finding: ${why}. Read the trace as a new counterexample:\n${trace}`,
    );
  if (verdict.kind !== expected.kind || verdict.property !== expected.property) {
    throw different(
      `expected ${expected.kind} "${expected.property}", got ${verdict.kind} "${verdict.property}"`,
    );
  }
  let from = 0;
  for (const want of expected.steps) {
    const at = verdict.trace.findIndex(
      (step, index) => index >= from && matches(step.action, want),
    );
    if (at < 0) throw different(`the trace has no step ${String(want)} after step ${from}`);
    from = at + 1;
  }
  const last = show(verdict.trace.at(-1)!.state);
  if (!expected.shows.test(last))
    throw different(`its last state does not show ${String(expected.shows)}: ${last}`);
};
