// SEMANTICS §8.5: turning an automation off, or deleting it, cancels its running runs with policy_denied. Driven
// through the real Session Protocol handlers (automation.set_enabled, automation.delete) over the real files and
// triggers services and a temp git repository, for every sequence of those operations up to a bound, with a runner
// that holds one live run of the automation. Read .claude/skills/automation-run-machine/SKILL.md first.
import { sequences } from "@caveman-app/model-check";
import type { AutomationRunSummary } from "@caveman-app/session-protocol/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vitest";

import { layer as filesLayer } from "../automations/files.ts";
import { AutomationRunner } from "../automations/services.ts";
import { DIGEST, projectStoreFor, testRepo, type TestRepo } from "../automations/testing.ts";
import { AutomationTriggers, fileAutomationId, makeTriggers } from "../automations/triggers.ts";
import { makeAutomationHandlers } from "./automations.ts";
import { SessionStore } from "./store.ts";

const PROJECT = "caveman-repo:abc123";
const ID = fileAutomationId(PROJECT, "project", "digest");
const LIVE_RUN = "r_live";
/** Every sequence of these, up to this length, from a state where the automation is on and has one run going. */
const OPERATIONS = ["turn on", "turn off", "delete"] as const;
const MAX_LENGTH = 2;
type Operation = (typeof OPERATIONS)[number];

/** A runner holding one live run of the automation; it records every cancel (runner.ts cancel is the only way to stop a run). */
function liveRunner() {
  const cancels: Array<{ readonly runId: string; readonly reason: string }> = [];
  let status: AutomationRunSummary["status"] = "running";
  const summary = (): AutomationRunSummary => ({
    run_id: LIVE_RUN,
    automation_id: ID,
    automation: "digest",
    project_id: PROJECT,
    status,
    reason: status === "cancelled" ? "policy_denied" : null,
    trigger: { kind: "schedule", subject: "schedule:digest" },
    started_at: "2026-11-06T09:00:00.000Z",
    ended_at: null,
    spent_usd: 0,
    steps: [{ name: "digest", status: status === "cancelled" ? "cancelled" : "running" }],
  });
  const layer = Layer.succeed(AutomationRunner, {
    admit: () => Effect.succeed({ runId: "r_new" }),
    cancel: (runId, reason) =>
      Effect.sync(() => {
        cancels.push({ runId, reason });
        if (runId === LIVE_RUN) status = "cancelled";
      }),
    applyOutputs: () => Effect.succeed([]),
    runs: (filter) =>
      Effect.sync(() =>
        [summary()].filter(
          (r) =>
            (filter.projectId === undefined || filter.projectId === r.project_id) &&
            (filter.automationId === undefined || filter.automationId === r.automation_id) &&
            (filter.automation === undefined || filter.automation === r.automation) &&
            (filter.scope === undefined || filter.scope === "project") &&
            (filter.live !== true ||
              r.status === "queued" ||
              r.status === "running" ||
              r.status === "waiting"),
        ),
      ),
    get: () => Effect.succeed(undefined),
    useLauncher: () => Effect.void,
    approve: (input) =>
      Effect.succeed({ refused: "not_found", message: `No run ${input.runId}.` } as const),
    useHost: () => Effect.void,
    useChief: () => Effect.void,
  });
  return { cancels, layer, isLive: () => status === "running" };
}

interface Step {
  readonly operation: Operation;
  /** "ok", or the handler's refusal: a refusal is an outcome, not a harness failure. */
  readonly result: string;
  readonly runWasLive: boolean;
  readonly cancels: ReadonlyArray<string>;
}

const repos: TestRepo[] = [];
afterEach(() => repos.splice(0).forEach((r) => r.remove()));

/** Runs one sequence against the real handlers and says what each operation did to the live run. */
async function run(ops: ReadonlyArray<Operation>): Promise<ReadonlyArray<Step>> {
  const repo = testRepo({ ".caveman/automations/digest.yaml": DIGEST });
  repos.push(repo);
  const kv = new Map<string, string>();
  const store = {
    kvGet: (key: string) => Effect.succeed(kv.get(key)),
    kvSet: (key: string, value: string) => Effect.sync(() => void kv.set(key, value)),
  };
  const runner = liveRunner();
  const services = Layer.mergeAll(
    filesLayer.pipe(Layer.provide(projectStoreFor({ [PROJECT]: repo.root }))),
    runner.layer,
    Layer.succeed(SessionStore, store as never),
  );
  const triggers = Layer.effect(AutomationTriggers, makeTriggers()).pipe(
    Layer.provideMerge(services),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeAutomationHandlers({
          store: store as never,
          launch: () => Effect.die("no launches here"),
        });
        yield* h["automation.set_enabled"]({ request_id: "start", id: ID, enabled: true });
        const steps: Step[] = [];
        for (const [i, operation] of ops.entries()) {
          const runWasLive = runner.isLive();
          const before = runner.cancels.length;
          const call =
            operation === "delete"
              ? h["automation.delete"]({ request_id: `op${i}`, id: ID })
              : h["automation.set_enabled"]({
                  request_id: `op${i}`,
                  id: ID,
                  enabled: operation === "turn on",
                });
          const result = yield* call.pipe(
            Effect.as("ok"),
            Effect.catch((error) =>
              Effect.succeed(
                `refused: ${(error as { message?: string }).message ?? String(error)}`,
              ),
            ),
          );
          steps.push({
            operation,
            result,
            runWasLive,
            cancels: runner.cancels.slice(before).map((c) => `${c.runId} ${c.reason}`),
          });
        }
        return steps;
      }).pipe(Effect.provide(triggers)),
    ) as Effect.Effect<ReadonlyArray<Step>, unknown>,
  );
}

/** The promise for one operation: off or delete cancels a live run with policy_denied; nothing else cancels anything. */
const kept = (step: Step): boolean =>
  step.operation !== "turn on" && step.runWasLive
    ? step.cancels.includes(`${LIVE_RUN} policy_denied`)
    : step.cancels.length === 0;

async function firstCounterexample(): Promise<ReadonlyArray<Step> | undefined> {
  let explored = 0;
  for (const ops of sequences(OPERATIONS, MAX_LENGTH)) {
    if (ops.length === 0) continue;
    explored++;
    const steps = await run(ops);
    if (!steps.every(kept)) {
      console.log(
        `[automation-run-machine] disable sequences: counterexample after ${explored} sequences`,
      );
      return steps;
    }
  }
  console.log(
    `[automation-run-machine] disable sequences: ${explored} sequences of up to ${MAX_LENGTH} operations, all kept`,
  );
  return undefined;
}

describe("turning an automation off or deleting it (SEMANTICS §8.5)", () => {
  it("turning a file automation off, or deleting it, cancels its running run with policy_denied, and nothing else cancels anything", async () => {
    expect(await firstCounterexample()).toBeUndefined();
  }, 60_000);
});
