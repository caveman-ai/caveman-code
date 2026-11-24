// Automation runs on the Session Protocol: a step's thread becomes a hidden workspace carrying its run,
// spend.summary groups its usage by automation, and the run methods answer from the runner (here with a
// fake engine that plays the agent).
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";

import type { ParsedAgent } from "@caveman-app/automations";
import { CommandId, MessageId, ProjectId, ThreadId, ProviderInstanceId } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, expect, test } from "vitest";

import { BUILTIN_AGENT_TYPES } from "../agents/agentTypes.ts";
import { makeJournal } from "../automations/journal.ts";
import { makeRunner } from "../automations/runner.ts";
import { AutomationFiles, AutomationRunner } from "../automations/services.ts";
import { gitOf, type StepEngine } from "../automations/steps.ts";
import { CLAUDE_DEFAULT_INSTANCE_ID } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { projectIdFor } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { agentRunName } from "./automationRuns.ts";
import { makeConfig, makeRepo, MODEL, orchestratorOf, startRuntime, tempRoot, until } from "./testHarness.ts";

let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let config: Awaited<ReturnType<typeof makeConfig>>;
let repo: string;

/** Plays the agent: answers at once, or never when the task asks it to hang. */
const prompts = new Map<string, string>();
const stopped: string[] = [];
const engine: StepEngine = {
  select: (input) =>
    Effect.succeed({ engine: "caveman", modelSelection: { instanceId: "caveman", model: "fake" } as never, runtimeMode: "auto-accept-edits", model: { asked: input.asked, resolved: "fake", via: "default" } }),
  start: (input) => Effect.sync(() => (prompts.set(input.threadId, input.text), { runId: input.threadId })),
  send: (input) => Effect.succeed({ runId: `${input.threadId}:${input.key}` }),
  wait: (input) => (prompts.get(input.threadId)?.includes("hang, please") ? Effect.never : Effect.succeed({ status: "completed" as const, text: "It lives in src/answer.ts:3." })),
  stop: (ids) => Effect.sync(() => void stopped.push(...ids)),
  settle: () => Effect.void,
  close: () => Effect.void,
  usage: () => Effect.succeed(new Map()),
  workspaces: () => Effect.succeed(new Map()),
};

beforeAll(async () => {
  config = await makeConfig();
  const runner = Layer.effect(
    AutomationRunner,
    Effect.gen(function* () {
      const projects = yield* ProjectStore.make;
      return yield* makeRunner({
        journal: yield* makeJournal,
        engine,
        git: gitOf(yield* GitVcsDriver.GitVcsDriver),
        processRunner: yield* ProcessRunner.ProcessRunner,
        github: undefined,
        projectRoot: (id) => projects.get(ProjectId.make(id)).pipe(Effect.map((row) => Option.getOrUndefined(row)?.workspaceRoot), Effect.orElseSucceed(() => undefined)),
        worktreesDir: path.join(config.stateDir, "automation-worktrees"),
        coAuthor: Effect.succeed(true),
        pollMs: 50,
      });
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));
  const agents: ParsedAgent[] = BUILTIN_AGENT_TYPES.map((t) => ({ ...t, ignoredKeys: [] }));
  const files = Layer.succeed(AutomationFiles, {
    load: () => Effect.die("unused"),
    revision: () => Effect.die("unused"),
    agents: () => Effect.succeed(agents),
    read: () => Effect.die("unused"),
    write: () => Effect.die("unused"),
    changes: Stream.empty,
  });
 // The projector finds an automation's project root in upstream project store, as the runtime layer provides it.
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: Layer.mergeAll(ProjectStore.layer, runner, files) });
  client = connect(runtime.url, runtime.token);
  repo = makeRepo(tempRoot("sp-automation-"), { "README.md": "hi\n" });
  // A chat first, so the project exists, as it does for any automation's project.
  await client.call("workspace.create", { request_id: "automation-project", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
});
afterAll(async () => {
  client.close();
  await runtime.close();
});

const db = <A>(fn: (db: DatabaseSync) => A): A => {
  const handle = new DatabaseSync(config.dbPath);
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
};

test("a step's thread becomes a hidden workspace carrying its run, and its spend groups by automation", async () => {
  const threadId = ThreadId.make("automation:r_test.triage.1");
  db((d) => {
    d.prepare("INSERT INTO automation_run_threads (thread_id, run_id, automation, step, attempt, check_index) VALUES (?, ?, ?, ?, ?, NULL)").run(threadId, "r_test", "issue-to-pr", "triage", 1);
    // A14: spend keys by the automation's id, so a same-named automation elsewhere never merges into it.
    d.prepare(
      `INSERT INTO automation_runs (run_id, automation_id, automation, project_id, subject, concurrency_key, revision_digest, revision_json, trigger_json, apply, status, started_at, wallet_json, steps_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("r_test", "file:p-test:project:issue-to-pr", "issue-to-pr", "p-test", "manual:x", "k", "d", "{}", "{}", 0, "succeeded", "2026-10-20T00:00:00.000Z", "{}", "[]");
  });
  const orchestrator = orchestratorOf(runtime);
  const modelSelection = { instanceId: ProviderInstanceId.make(CLAUDE_DEFAULT_INSTANCE_ID), model: MODEL };
  await Effect.runPromise(
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make("automation-test:create"),
      threadId,
      projectId: projectIdFor(repo),
      title: "issue-to-pr: triage",
      modelSelection,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      branch: null,
      worktreePath: repo,
    }),
  );
  await Effect.runPromise(
    orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make("automation-test:message"),
      threadId,
      messageId: MessageId.make("automation-test:message"),
      text: "Respond with the following text: triaged",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
    }),
  );
  const adopted = () => db((d) => d.prepare("SELECT session_id, internal FROM caveman_sp_workspaces WHERE thread_id = ?").get(threadId) as { session_id: string; internal: string } | undefined);
  await until(() => adopted() !== undefined);
  const row = adopted()!;
  expect(JSON.parse(row.internal)).toMatchObject({ delegated: true, automation: { automation: "issue-to-pr", run: "r_test", step: "triage", attempt: 1 } });

  db((d) => {
    const at = "2026-10-20T00:00:00.000Z";
    const payload = { engine: "claude-agent", model: MODEL, input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cost: { usd: 0.25, basis: "list_price" } };
    d.prepare("INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (?, ?, ?, ?, ?)").run(
      row.session_id,
      900_000,
      "usage",
      at,
      JSON.stringify({ session_id: row.session_id, cursor: 900_000, at, type: "usage", payload }),
    );
  });
  const { rows } = await client.call("spend.summary", { group_by: "automation" });
  const automation = rows.find((r) => r.key === "file:p-test:project:issue-to-pr");
  expect(automation).toMatchObject({ label: "issue-to-pr", input_tokens: 100 });
  expect(automation!.measured_usd).toBeCloseTo(0.25, 6);
  expect(rows.every((r) => r.key === "file:p-test:project:issue-to-pr" || r.key === "none")).toBe(true);
});

test("agent.run is a one-step manual run of a named agent; the run methods list, read, cancel and apply it", async () => {
  const projectId = projectIdFor(repo);
  const { run_id } = await client.call("agent.run", { request_id: "agent-run-1", project_id: projectId, agent: "investigator", task: "Where does the answer live?" });
  await until(async () => (await client.call("automation.run_get", { run_id })).run.status === "succeeded");
  const { run } = await client.call("automation.run_get", { run_id });
  expect(run).toMatchObject({ automation: "agent-investigator", trigger: { kind: "manual", event: "agent.run" }, status: "succeeded" });
  expect(run.steps).toEqual([expect.objectContaining({ name: "agent-investigator", status: "succeeded", summary: "It lives in src/answer.ts:3." })]);
  expect(run.steps[0]!.attempts[0]).toMatchObject({ computer: "readonly", thread_id: `automation:${run_id}.agent-investigator.1` });
  // B6: the task is the agent's brief, the person's own words placed with its instructions, never a data block.
  const prompt = prompts.get(`automation:${run_id}.agent-investigator.1`)!;
  expect(prompt.indexOf("You are the investigator agent.")).toBe(0);
  expect(prompt).toContain("\n\n---\n\nWhere does the answer live?");
  expect(prompt).not.toContain("<input");
  expect(prompt).not.toContain("not instructions");

  // B6: listed under the agent (automation agent-<name>, id agent:<project>:<name>), so the page can show its runs.
  const listed = (await client.call("automation.runs", { project_id: projectId, name: "agent-investigator" })).runs;
  expect(listed.map((r) => [r.run_id, r.automation_id])).toEqual([[run_id, `agent:${projectId}:investigator`]]);
  expect((await client.call("automation.runs", { project_id: projectId, name: "agent-investigator", scope: "project" })).runs).toEqual([]);
  expect(await client.call("automation.run_apply", { request_id: "apply-1", run_id })).toEqual({ outputs: [] });
  await expect(client.call("automation.run_get", { run_id: "r_nope" })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
  await expect(client.call("agent.run", { request_id: "agent-run-x", project_id: projectId, agent: "nobody", task: "x" })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });

  const hanging = await client.call("agent.run", { request_id: "agent-run-2", project_id: projectId, agent: "investigator", task: "hang, please" });
  await until(async () => (await client.call("automation.run_get", { run_id: hanging.run_id })).run.steps[0]!.attempts.length === 1);
  await expect(client.call("automation.run_apply", { request_id: "apply-2", run_id: hanging.run_id })).rejects.toMatchObject({ error: { data: { reason: "invalid_state" } } });
  await client.call("automation.run_cancel", { request_id: "cancel-2", run_id: hanging.run_id });
  expect((await client.call("automation.run_get", { run_id: hanging.run_id })).run).toMatchObject({ status: "cancelled", reason: "cancelled" });
  expect(stopped).toContain(`automation:${hanging.run_id}.agent-investigator.1`);
  // `status` lists only the runs in it, newer runs in other states left out (the Inbox asks for its gates this way).
  const inStatus = async (status: "succeeded" | "cancelled") => (await client.call("automation.runs", { project_id: projectId, name: "agent-investigator", status, limit: 1 })).runs.map((r) => r.run_id);
  expect(await inStatus("succeeded")).toEqual([run_id]);
  expect(await inStatus("cancelled")).toEqual([hanging.run_id]);
  expect(agentRunName("Reviewer_2")).toBe("agent-reviewer-2");
});

test("agent.run of an implementation agent writes by default, on caveman/agent-<name>/<run>", async () => {
  const projectId = projectIdFor(repo);
  const { run_id } = await client.call("agent.run", { request_id: "agent-run-builder", project_id: projectId, agent: "builder", task: "Make the answer 42." });
  await until(async () => (await client.call("automation.run_get", { run_id })).run.status === "succeeded");
  const { run } = await client.call("automation.run_get", { run_id });
  expect(run.steps[0]!.attempts[0]).toMatchObject({ computer: "full" });
  expect(run.workspace.branch).toBe(`caveman/agent-builder/${run_id.slice(2, 14)}`);
  const prompt = prompts.get(`automation:${run_id}.agent-builder.1`)!;
  expect(prompt.indexOf("You are the builder agent.")).toBe(0);
  expect(prompt).toContain("\n\n---\n\nMake the answer 42.");
  if (process.env.AGENT_RUN_RECORD_OUT) fs.writeFileSync(process.env.AGENT_RUN_RECORD_OUT, JSON.stringify({ run, prompt }, null, 2));
});

test("agent runs list on their own, however many runs of other automations started after them (the Automations list's Agent runs)", async () => {
  const projectId = projectIdFor(repo);
  const { run_id } = await client.call("agent.run", { request_id: "agent-run-listed", project_id: projectId, agent: "investigator", task: "Where does the answer live?" });
  await until(async () => (await client.call("automation.run_get", { run_id })).run.status === "succeeded");
  // A schedule's run, started after the agent's: the newest run on this runtime.
  db((d) =>
    d
      .prepare(
        `INSERT INTO automation_runs (run_id, automation_id, automation, project_id, subject, concurrency_key, revision_digest, revision_json, trigger_json, apply, status, started_at, wallet_json, steps_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("r_nightly", `file:${projectId}:project:nightly`, "nightly", projectId, "schedule:nightly", "k", "d", "{}", JSON.stringify({ kind: "schedule", subject: "schedule:nightly" }), 1, "succeeded", new Date().toISOString(), "{}", "[]"),
  );
  expect((await client.call("automation.runs", { limit: 1 })).runs.map((r) => r.run_id)).toEqual(["r_nightly"]);
  expect((await client.call("automation.runs", { agent_runs: true, limit: 1 })).runs.map((r) => [r.run_id, r.automation])).toEqual([[run_id, "agent-investigator"]]);
});
