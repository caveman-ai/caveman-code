// An automation run on a Cloud computer, end to end on the real runtime against the stand-in Cloud (platform
// CONTRACT §5, §7): a `session_start` mail with `automation` set reaches headless.ts, which hands it to the Cloud host
// the handlers serve (no CloudAutomations given). The host reads the revision Cloud names, checks it, and runs it in
// the automations interpreter on this computer's checkout (a command step, then an agent step on a scripted engine):
// the steps' moves and the approval gate go out as the session's public events (Slack text is untrusted, but the
// reply goes back to the thread it came from, so the owner's gate of SECURITY M1 does not apply), an `answer` mail
// approves the gate, the Slack reply goes through Cloud's outputs route, and one run record reaches Cloud's runs route. A revision that
// does not check fails its run with result_invalid. An interrupt mail stops a run: its record says cancelled.
import * as path from "node:path";

import { ProjectId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterAll, beforeAll, expect, test } from "vitest";

import { enroll } from "../cloudLink/identity.ts";
import { CloudComputer, CloudLinkState } from "../cloudLink/index.ts";
import { startTestCloud, type TestCloud } from "../cloudLink/testCloud.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeConfig, makeRepo, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeJournal } from "./journal.ts";
import { makeRunner } from "./runner.ts";
import { AutomationRunner } from "./services.ts";
import { DATA_LINE, gitOf, type StepEngine } from "./steps.ts";

const FILE = [
  "host: cloud",
  "on:",
  "  slack: { mention: true }",
  "steps:",
  "  gather:",
  "    run: cat README.md",
  "  answer:",
  "    needs: [gather]",
  "    prompt: Answer the question from what gather found.",
  "    approve: { by: members }",
  "outputs:",
  "  slack.message: answer.summary",
  "",
].join("\n");
const ANSWER = "It is the acme widget service.";

/** Plays the agent: every step's prompt is kept, and answered at once. */
const prompts: string[] = [];
const engine: StepEngine = {
  select: (input) =>
    Effect.succeed({ engine: "caveman", modelSelection: { instanceId: "caveman", model: "fake" } as never, runtimeMode: "auto-accept-edits", model: { asked: input.asked, resolved: "fake", via: "default" } }),
  start: (input) => Effect.sync(() => (prompts.push(input.text), { runId: input.threadId })),
  send: (input) => Effect.succeed({ runId: `${input.threadId}:${input.key}` }),
  wait: () => Effect.succeed({ status: "completed" as const, text: ANSWER }),
  stop: () => Effect.void,
  settle: () => Effect.void,
  close: () => Effect.void,
  usage: () => Effect.succeed(new Map()),
  workspaces: () => Effect.succeed(new Map()),
};

let cloud: TestCloud;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
const cleanups: Array<() => unknown> = [];

// Skipped on Windows: each test runs a Cloud computer's runtime, and a Cloud computer is Linux; the runtime runs git in
// its checkout only where the owner uid and mode bits show the agent cannot write it (gitTrusts).
const WIN = process.platform === "win32";
const onComputer = test.skipIf(WIN);

beforeAll(async () => {
  if (WIN) return;
  cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("automation-host-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  // The computer's checkout, as the snapshot build leaves it.
  const checkout = makeRepo(tempRoot("automation-host-checkout-"), { "README.md": "widgets: the acme widget service\n" });
  process.env.CAVEMAN_SESSION_MOUNT = tempRoot("automation-host-mount-");
  const config = await makeConfig();
  // The runtime's runner, as runtimeLayer.ts makes it, with a scripted engine in place of the agents.
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
  const provide = Layer.mergeAll(
    ProjectStore.layer,
    runner,
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  cleanups.push(runtime.close);
}, 60_000);

afterAll(async () => {
  delete process.env.CAVEMAN_SESSION_MOUNT;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const events = (session: string) => cloud.state.sessions.eventsOf(session);
const runStates = (workspace: string) => cloud.state.sessions.runStates.filter((r) => r.workspace === workspace).map((r) => r.run_state);
const start = (session: string, workspace: string, automation: Record<string, unknown>) =>
  cloud.state.sessions.post({
    verb: "task",
    authority: "automation",
    to_workspace_id: workspace,
    body: "Run the slack-answers automation.",
    payload: { kind: "session_start", session_id: session, agent: null, repo: "acme/widgets", automation },
  });

onComputer("a session_start with an automation runs its revision: step events, a gate answered by mail, the Slack reply and one run record", async () => {
  cloud.state.automations.revisions.set("rev_1", { files: { ".caveman/automations/slack-answers.yaml": FILE }, sha256: "sha256:abc" });
  start("sesn_auto", "ws-auto-1", {
    automation_id: "aut_1",
    revision_id: "rev_1",
    run_id: "run_1",
    trigger: "slack.app_mention",
    event: { source: "slack", event: "app_mention", channel: "C42", ts: "1700.00", text: "<@caveman> what is this repo?", trusted: false },
  });

  const asks = () => events("sesn_auto").filter((e) => e.type === "requires_action").map((e) => e.data);
  const approve = () =>
    cloud.state.sessions.post({
      verb: "answer",
      authority: "api",
      to_workspace_id: "ws-auto-1",
      payload: { kind: "user.approval", session_id: "sesn_auto", ask_id: "automation:run_1:answer", decision: "allow" },
    });

  // The command step ran, the agent step answered in the thread's place (no owner's gate: the reply goes back where
  // the text came from), then the run stopped at the step's own gate. The ask says who may answer it (M3).
  await until(() => asks().length === 1 || events("sesn_auto").some((e) => e.data.status === "terminated"), 60_000);
  expect(asks()[0], JSON.stringify(events("sesn_auto"))).toMatchObject({ ask_id: "automation:run_1:answer", kind: "approval", by: "members", input: { run_id: "run_1", step: "answer", by: "members", before_run: false, summary: ANSWER } });
  expect(asks()[0]).not.toHaveProperty("untrusted_trigger");
  const steps = events("sesn_auto").filter((e) => e.type === "automation.step").map((e) => [e.data.step, e.data.attempt, e.data.status, e.data.untrusted_trigger ?? false]);
  expect(steps).toEqual([
    ["gather", 1, "running", false],
    ["gather", 1, "succeeded", false],
    ["answer", 1, "running", false],
    ["answer", 1, "waiting", false],
  ]);
  // The agent read the command step's output and the Slack message after the data line, never as its instructions.
  expect(prompts).toHaveLength(1);
  const data = prompts[0]!.indexOf(DATA_LINE);
  expect(prompts[0]!.indexOf("Answer the question from what gather found.")).toBeLessThan(data);
  expect(prompts[0]!.indexOf("widgets: the acme widget service")).toBeGreaterThan(data);
  expect(prompts[0]!.indexOf("what is this repo?")).toBeGreaterThan(data);
  await until(() => runStates("ws-auto-1").includes("needs_input"));
  // Held until approved: nothing posted, no record yet.
  expect(cloud.state.automations.outputs).toEqual([]);
  expect(cloud.state.automations.runs).toEqual([]);

  // Someone approves in Cloud: the answer mail reaches the gate.
  approve();
  await until(() => cloud.state.automations.runs.length === 1, 60_000);

  expect(cloud.state.automations.outputs).toEqual([{ session_id: "sesn_auto", kind: "slack.message", target: "C42/1700.00", body: ANSWER, idempotency_key: "run_1.answer.slack.message" }]);
  expect(cloud.state.automations.runs[0]).toMatchObject({
    session_id: "sesn_auto",
    automation_id: "aut_1",
    record: {
      run: "run_1",
      automation: "slack-answers",
      automation_id: "aut_1",
      status: "succeeded",
      environment: "cloud",
      trigger: { kind: "slack", event: "app_mention", subject: "slack:C42/1700.00" },
      steps: [
        { name: "gather", status: "succeeded" },
        { name: "answer", status: "succeeded", approval: { by: "members", decision: "approve", decided_by: "cloud" } },
      ],
      outputs: [{ kind: "slack.message", status: "applied" }],
    },
  });
  await until(() => events("sesn_auto").at(-1)?.type === "session.status" && events("sesn_auto").at(-1)?.data.status === "idle");
  expect(events("sesn_auto").at(-1)!.data).toEqual({ status: "idle", stop_reason: "end_turn" });
  const seqs = events("sesn_auto").map((e) => e.seq);
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  await until(() => runStates("ws-auto-1").at(-1) === "idle");
  expect(runStates("ws-auto-1")).toEqual(["working", "needs_input", "working", "idle"]);
}, 120_000);

onComputer("an interrupt mail for an automation's session stops its run: cancelled record, terminated interrupted, Cloud's row idle", async () => {
  start("sesn_stop", "ws-auto-3", {
    automation_id: "aut_1",
    revision_id: "rev_1",
    run_id: "run_3",
    trigger: "slack.app_mention",
    event: { source: "slack", event: "app_mention", channel: "C42", ts: "1700.02", text: "<@caveman> and this?", trusted: false },
  });
  // Held at its gate, as a run superseded or disabled in Cloud would be mid-way.
  await until(() => events("sesn_stop").some((e) => e.type === "requires_action"), 60_000);
  const before = cloud.state.automations.runs.length;
  const id = cloud.state.sessions.post({ verb: "interrupt", authority: "automation", to_workspace_id: "ws-auto-3", payload: { kind: "user.interrupt", session_id: "sesn_stop" } });
  await until(() => cloud.state.automations.runs.length === before + 1, 30_000);
  expect(cloud.state.automations.runs.at(-1)).toMatchObject({ session_id: "sesn_stop", record: { run: "run_3", status: "cancelled", steps: [{ name: "gather", status: "succeeded" }, { name: "answer" }] } });
  await until(() => events("sesn_stop").at(-1)?.data.status === "terminated", 30_000);
  expect(events("sesn_stop").at(-1)!.data).toEqual({ status: "terminated", stop_reason: "interrupted" });
  await until(() => runStates("ws-auto-3").at(-1) === "idle");
  // Nothing went out for the stopped run, and the interrupt was taken once.
  expect(cloud.state.automations.outputs.filter((o) => o.session_id === "sesn_stop")).toEqual([]);
  await until(() => cloud.state.sessions.acks.includes(id));
}, 120_000);

onComputer("a revision that does not check fails its run with result_invalid, and nothing runs; its record survives Cloud answering 503 (H2)", async () => {
  // control-api restarting: the first try of the record gets a 503; the record is owed in the journal and tried again.
  cloud.state.automations.runsDown = 1;
  cloud.state.automations.revisions.set("rev_2", { files: { ".caveman/automations/slack-answers.yaml": FILE.replace("run: cat README.md", "agent: answrer") }, sha256: "sha256:def" });
  start("sesn_bad", "ws-auto-2", { automation_id: "aut_1", revision_id: "rev_2", run_id: "run_2", trigger: "slack.app_mention", event: { source: "slack", channel: "C42", ts: "1700.01" } });
  await until(() => events("sesn_bad").some((e) => e.type === "session.status" && e.data.status === "terminated"), 30_000);
  expect(events("sesn_bad").map((e) => [e.type, e.data.code ?? e.data.status])).toEqual([
    ["session.error", "result_invalid"],
    ["session.status", "terminated"],
  ]);
  expect(String(events("sesn_bad")[0]!.data.message)).toContain('No agent "answrer"');
  await until(() => cloud.state.automations.runs.some((r) => r.session_id === "sesn_bad"));
  expect(cloud.state.automations.runs.find((r) => r.session_id === "sesn_bad")).toMatchObject({ session_id: "sesn_bad", record: { run: "run_2", status: "failed", reason: "result_invalid", steps: [] } });
  expect(cloud.state.automations.runsDown).toBe(0);
  expect(cloud.state.automations.runs.filter((r) => r.session_id === "sesn_bad")).toHaveLength(1);
  // The failed run state is posted after the events, from its own queue.
  await until(() => runStates("ws-auto-2").length > 0, 15_000);
  expect(runStates("ws-auto-2")).toEqual(["failed"]);
}, 60_000);
