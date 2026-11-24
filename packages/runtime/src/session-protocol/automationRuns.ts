// automation.runs, run_get, run_cancel, run_apply and agent.run: an automation's runs on the Session
// Protocol, served by the AutomationRunner (automations/runner.ts). agent.run is a one-step manual run
// of a named agent, so a shell or another client can call any agent file: the task is its brief, an
// implementation agent writes on caveman/agent-<name>/<run>, and its runs list as `agent-<name>`.
import { createHash } from "node:crypto";

import { NAME_PATTERN, type AutomationFile } from "@caveman-app/automations";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { splitProjectRef } from "../automations/drafts.ts";
import { ulid } from "../automations/runner.ts";
import { AutomationFiles, AutomationRunner, type Revision } from "../automations/services.ts";
import type { StepLauncher } from "../automations/steps.ts";
import type { Handler } from "./handlers.ts";
import { ProtocolError } from "./handlers.ts";

type AutomationRunMethod = "automation.runs" | "automation.run_get" | "automation.run_cancel" | "automation.run_apply" | "automation.approve" | "agent.run";

/** An automation (and step) name for an agent's one-step run: `agent-<name>`, lowercase letters, digits and dashes. */
export function agentRunName(agent: string): string {
  const slug = agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `agent-${slug}`.slice(0, 40).replace(/-+$/, "");
  return NAME_PATTERN.test(name) ? name : "agent-run";
}

/** The Session Protocol's launcher goes to the runner here: how a step starts like a new chat in its project. */
export const makeAutomationRunHandlers = (launcher: StepLauncher) =>
  Effect.gen(function* () {
    const runner = yield* Effect.serviceOption(AutomationRunner);
    const files = yield* Effect.serviceOption(AutomationFiles);
    if (Option.isSome(runner)) yield* runner.value.useLauncher(launcher);
    const fail = (reason: string, message: string) => new ProtocolError({ reason, message });
    const need: Effect.Effect<AutomationRunner["Service"], ProtocolError> = Option.isNone(runner)
      ? Effect.fail(fail("unsupported", "this runtime does not run automations"))
      : Effect.succeed(runner.value);
    const exists = (r: AutomationRunner["Service"], runId: string) =>
      r.get(runId).pipe(Effect.flatMap((run) => (run === undefined ? Effect.fail(fail("not_found", `no run ${runId}`)) : Effect.succeed(run))));

    return {
      "automation.runs": (p) =>
        need.pipe(
          Effect.flatMap((r) =>
            r.runs({
              // A draft (`<project>@<branch>`) shares the project's runs.
              ...(p.project_id === undefined ? {} : { projectId: splitProjectRef(p.project_id).projectId }),
              ...(p.name === undefined ? {} : { automation: p.name }),
              ...(p.scope === undefined ? {} : { scope: p.scope }),
              ...(p.status === undefined ? {} : { status: p.status }),
              ...(p.agent_runs === true ? { agentRuns: true } : {}),
              limit: p.limit ?? 50,
            }),
          ),
          Effect.map((runs) => ({ runs: [...runs] })),
        ),
      "automation.run_get": (p) => need.pipe(Effect.flatMap((r) => exists(r, p.run_id)), Effect.map((run) => ({ run }))),
      "automation.run_cancel": (p) =>
        need.pipe(
          Effect.tap((r) => exists(r, p.run_id)),
          Effect.flatMap((r) => r.cancel(p.run_id, "cancelled")),
          Effect.as({}),
        ),
      "automation.run_apply": (p) =>
        need.pipe(
          Effect.flatMap((r) =>
            exists(r, p.run_id).pipe(
              Effect.flatMap((run) =>
                run.status === "running" || run.status === "queued" || run.status === "waiting"
                  ? Effect.fail(fail("invalid_state", "the run is still going; apply its outputs once it ends"))
                  : p.key !== undefined && !run.outputs.some((o) => o.key === p.key)
                    ? Effect.fail(fail("not_found", `run ${p.run_id} has no output ${p.key}`))
                    : r.applyOutputs(p.run_id, p.key),
              ),
            ),
          ),
          Effect.map((outputs) => ({ outputs: [...outputs] })),
        ),
      // An approval gate answered from the app: the person at this computer is the automation's owner here.
      "automation.approve": (p, ctx) =>
        need.pipe(
          Effect.flatMap((r) =>
            r.approve({
              runId: p.run_id,
              step: p.step,
              decision: p.decision,
              by: ctx.principal ?? "local",
              ...(p.message === undefined ? {} : { message: p.message }),
            }),
          ),
          Effect.flatMap((answer) => ("refused" in answer ? Effect.fail(fail(answer.refused, answer.message)) : Effect.succeed({ run: answer.run }))),
        ),
      "agent.run": (p) =>
        Effect.gen(function* () {
          const r = yield* need;
          if (Option.isNone(files)) return yield* fail("unsupported", "this runtime cannot read agent files");
          const agents = yield* files.value.agents(p.project_id);
          const agent = agents.find((a) => a.name === p.agent);
          if (agent === undefined) return yield* fail("not_found", `No agent named ${p.agent}. Known: ${agents.map((a) => a.name).join(", ")}.`);
          const name = agentRunName(agent.name);
          // B6 (F-4): an implementation agent writes by default, on its own branch; any other agent reads a copy.
          const computer = p.computer ?? (agent.role === "implementation" || agent.name === "builder" ? "full" : "readonly");
          // The task is the agent's brief: the person's own words, placed with its instructions (never as trigger data).
          const file = { steps: { [name]: { agent: agent.name, prompt: p.task, computer, ...(p.model === undefined ? {} : { model: p.model }) } } } as unknown as AutomationFile;
          const text = JSON.stringify(file);
          const digest = createHash("sha256").update(JSON.stringify({ file, agent })).digest("hex");
          const revision: Revision = { digest, automation: { name, scope: "me", path: "", file, digest, text }, agents, from: "working_tree" };
          const admitted = yield* r.admit({
            projectId: p.project_id,
            revision,
            agent: agent.name,
            trigger: { kind: "manual", event: "agent.run", subject: `manual:${ulid().toLowerCase()}`, trusted: true, receivedAt: new Date().toISOString() },
            apply: false,
          });
          if ("refused" in admitted) return yield* fail(admitted.refused === "engine_unavailable" ? "engine_unavailable" : "invalid_state", admitted.message);
          return { run_id: admitted.runId };
        }),
    } satisfies { readonly [M in AutomationRunMethod]: Handler<M> };
  });
