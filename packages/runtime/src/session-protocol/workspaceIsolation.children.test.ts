// What the projector adopts gets what is a workspace's own too (finding P7): a delegated child in its lead's
// checkout shares the lead's variables, one with a worktree of its own has its own until it is archived, and an
// automation run has one set for its command steps, its checks and its steps' agents until it ends. Each is adopted by
// the real projector (daemon.ts) from upstream own events and read off what a terminal of its workspace is started with;
// the run's commands go through the real runner.
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  checkProject,
  parseAgentFile,
  type AgentInfo,
  type ParsedAgent,
  type SourceFile,
} from "@caveman-app/automations";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@caveman-app/protocol";
import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, expect, test } from "vitest";

import { BUILTIN_AGENT_TYPES } from "../agents/agentTypes.ts";
import { makeJournal } from "../automations/journal.ts";
import { makeRunner } from "../automations/runner.ts";
import { AutomationFiles, AutomationRunner, type Revision } from "../automations/services.ts";
import { gitOf, type StepEngine, type StepLauncher } from "../automations/steps.ts";
import { CLAUDE_DEFAULT_INSTANCE_ID } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { projectIdFor } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { workspaceTag } from "./computerConfig.ts";
import {
  createReady,
  delegateFrom,
  git,
  makeConfig,
  makeRepo,
  MODEL,
  orchestratorOf,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";
import { runScopeId } from "./workspaceIsolation.ts";

const root = tempRoot("sp-iso-children-");
const out = path.join(root, "out");
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let orchestrator: Orchestrator.OrchestratorV2["Service"];
let runner: AutomationRunner["Service"];
let repo: string;
const hold = process.env.SMOKE_CLAUDE_HOLD_MS;

/** What each terminal was started with: the environment a workspace's children get. */
const opened: Array<Record<string, string>> = [];
const layerTerminal = Layer.mock(TerminalManager.TerminalManager)({
  open: (input) => Effect.sync(() => (opened.push({ ...input.env }), {} as never)),
  getShell: () => Effect.succeed("/bin/sh"),
  write: () => Effect.void,
  close: () => Effect.void,
  subscribe: () => Effect.succeed(() => undefined),
});
const envOf = async (workspaceId: string, request: string) => {
  await client.call("term.open", {
    request_id: request,
    workspace_id: workspaceId,
    cols: 80,
    rows: 24,
    command: "env",
  });
  return opened.at(-1)!;
};

const db = <A>(fn: (db: DatabaseSync) => A): A => {
  const handle = new DatabaseSync(config.dbPath);
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
};
const portsOf = (workspaceId: string) =>
  db(
    (d) =>
      d
        .prepare("SELECT name, port FROM caveman_sp_ports WHERE workspace_id = ? ORDER BY name")
        .all(workspaceId) as Array<{ name: string; port: number }>,
  );
const adopted = (threadId: string) =>
  db(
    (d) =>
      d.prepare("SELECT id FROM caveman_sp_workspaces WHERE thread_id = ?").get(threadId) as
        | { id: string }
        | undefined,
  )?.id;

/**
 * Plays a step's agent as the production engine starts one (steps.ts makeThreadEngine): the thread registered for its
 * run, then made in the step's checkout through T3, so the real projector adopts it as the step's workspace.
 */
const stepThreads: Array<string> = [];
const engine: StepEngine = {
  select: (input) =>
    Effect.succeed({
      engine: "claude-agent",
      modelSelection: {
        instanceId: ProviderInstanceId.make(CLAUDE_DEFAULT_INSTANCE_ID),
        model: MODEL,
      } as never,
      runtimeMode: "auto-accept-edits",
      model: { asked: input.asked, resolved: MODEL, via: "default" },
    }),
  start: (input) =>
    Effect.promise(async () => {
      db((d) =>
        d
          .prepare(
            "INSERT INTO automation_run_threads (thread_id, run_id, automation, step, attempt, check_index) VALUES (?, ?, ?, ?, ?, NULL)",
          )
          .run(
            input.threadId,
            input.marker.run,
            input.marker.automation,
            input.marker.step,
            input.marker.attempt,
          ),
      );
      const threadId = ThreadId.make(input.threadId);
      const modelSelection = {
        instanceId: ProviderInstanceId.make(CLAUDE_DEFAULT_INSTANCE_ID),
        model: MODEL,
      };
      await Effect.runPromise(
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "system",
          creationSource: "server",
          commandId: CommandId.make(`${input.threadId}:create`),
          threadId,
          projectId: ProjectId.make(input.projectId),
          title: input.title,
          modelSelection,
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          branch: null,
          worktreePath: input.cwd,
        }),
      );
      await Effect.runPromise(
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "system",
          creationSource: "server",
          commandId: CommandId.make(`${input.threadId}:message`),
          threadId,
          messageId: MessageId.make(`${input.threadId}:message`),
          text: "Respond with the following text: done",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        }),
      );
      stepThreads.push(input.threadId);
      return { runId: input.threadId };
    }),
  send: (input) => Effect.succeed({ runId: `${input.threadId}:${input.key}` }),
  wait: (input) =>
    Effect.promise(() => until(() => adopted(input.threadId) !== undefined, 60_000)).pipe(
      Effect.as({ status: "completed" as const, text: "Done." }),
    ),
  stop: () => Effect.void,
  settle: () => Effect.void,
  close: () => Effect.void,
  usage: () => Effect.succeed(new Map()),
  workspaces: () => Effect.succeed(new Map()),
};

const builtins: ParsedAgent[] = BUILTIN_AGENT_TYPES.map((t) => ({ ...t, ignoredKeys: [] }));
function revisionOf(files: ReadonlyArray<SourceFile>, name: string): Revision {
  const checked = checkProject({
    files: [...files],
    agents: builtins as AgentInfo[],
    target: "code",
  });
  const errors = checked.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(JSON.stringify(errors));
  const automation = checked.automations.find((a) => a.name === name)!;
  const agents = files
    .filter((f) => f.path.startsWith(".caveman/agents/") && f.path.endsWith(".md"))
    .map((f) => parseAgentFile(f, "project").agent!);
  return {
    digest: automation.digest,
    automation,
    agents: [...agents, ...builtins.filter((b) => !agents.some((a) => a.name === b.name))],
    from: "working_tree",
  };
}

/** `env` as a command printed it. */
const readEnv = (file: string) =>
  Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
/** The variables that are a workspace's own. */
const own = (env: Record<string, string>) =>
  Object.fromEntries(
    [
      "CAVEMAN_WORKSPACE_ID",
      "COMPOSE_PROJECT_NAME",
      "AGENT_BROWSER_SESSION",
      "CAVEMAN_PORT_WEB",
      "CAVEMAN_PORT",
      "PORT",
      "TMPDIR",
      "CAVEMAN_BROWSER_PROFILE",
      "AGENT_BROWSER_PROFILE",
      "GREETING",
    ].map((name) => [name, env[name]]),
  );

beforeAll(async () => {
  // The lead's turn must outlive its children's starts.
  process.env.SMOKE_CLAUDE_HOLD_MS = "30000";
  fs.mkdirSync(out, { recursive: true });
  config = await makeConfig();
  // The runner as automations/runner.ts builds it: the Session Protocol's launcher gives a run its variables.
  let launcher: StepLauncher | undefined;
  const layerRunner = Layer.effect(
    AutomationRunner,
    Effect.gen(function* () {
      const projects = yield* ProjectStore.make;
      runner = yield* makeRunner({
        journal: yield* makeJournal,
        engine,
        git: gitOf(yield* GitVcsDriver.GitVcsDriver),
        processRunner: yield* ProcessRunner.ProcessRunner,
        github: undefined,
        projectRoot: (id) =>
          projects.get(ProjectId.make(id)).pipe(
            Effect.map((row) => Option.getOrUndefined(row)?.workspaceRoot),
            Effect.orElseSucceed(() => undefined),
          ),
        worktreesDir: path.join(config.stateDir, "automation-worktrees"),
        coAuthor: Effect.succeed(true),
        pollMs: 50,
        setLauncher: (next) => Effect.sync(() => void (launcher = next)),
        runEnv: (runId, cwd) =>
          Effect.suspend(() => launcher?.runEnv?.(runId, cwd) ?? Effect.succeed(undefined)),
        runEnded: (runId) => Effect.suspend(() => launcher?.runEnded?.(runId) ?? Effect.void),
      });
      return runner;
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));
  const files = Layer.succeed(AutomationFiles, {
    load: () => Effect.die("unused"),
    revision: () => Effect.die("unused"),
    agents: () => Effect.succeed(builtins),
    read: () => Effect.die("unused"),
    write: () => Effect.die("unused"),
    changes: Stream.empty,
  });
  runtime = await startRuntime(config, "fake-claude", undefined, {
    provide: Layer.mergeAll(ProjectStore.layer, layerRunner, files, layerTerminal) as Layer.Layer<
      any,
      never,
      any
    >,
  });
  client = connect(runtime.url, runtime.token);
  orchestrator = orchestratorOf(runtime);
  repo = makeRepo(root, {
    "README.md": "hi\n",
    // [services] with no service run here: the workspace still gets a port for a stack it runs itself.
    ".caveman/computer.toml": `[run]\nports = ["web"]\n[services]\npostgres = "16"\n[env]\nGREETING = "hello"\nOUT = "${out.split(path.sep).join("/")}"\n`,
    // What an automation's command sees; the check then holds its run open until the test lets it go.
    "probe.sh":
      'env > "$OUT/$1.env.tmp" && mv "$OUT/$1.env.tmp" "$OUT/$1.env"\nif [ "$1" = check ]; then i=0; while [ ! -f "$OUT/go" ] && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done; fi\n',
  });
}, 180_000);

afterAll(async () => {
  if (hold === undefined) delete process.env.SMOKE_CLAUDE_HOLD_MS;
  else process.env.SMOKE_CLAUDE_HOLD_MS = hold;
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a delegated child in its lead's checkout gets the lead's variables; one with a worktree of its own gets its own, freed when it is archived", async () => {
  const lead = await client.call("workspace.create", {
    request_id: "iso-lead",
    repo: { path: repo },
    engine: "claude-agent",
    options: { model: MODEL },
    task: { text: "slow: lead" },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (e) => events.push(e));
  await until(() => events.some((e) => e.type === "turn.started"), 60_000);
  const children = async () =>
    (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces;
  const leadEnv = await envOf(lead.id, "iso-lead-term");
  const { ports: leadPorts, root_path: leadRoot } = await client.call("workspace.get", {
    workspace_id: lead.id,
  });
  const ports = leadPorts!;
  expect(Object.keys(ports)).toEqual(["web", "postgres"]);
  expect(own(leadEnv)).toEqual({
    CAVEMAN_WORKSPACE_ID: lead.id,
    COMPOSE_PROJECT_NAME: workspaceTag(lead.id),
    AGENT_BROWSER_SESSION: workspaceTag(lead.id),
    CAVEMAN_PORT_WEB: String(ports.web),
    CAVEMAN_PORT: String(ports.web),
    PORT: String(ports.web),
    TMPDIR: leadEnv.TMPDIR,
    CAVEMAN_BROWSER_PROFILE: leadEnv.CAVEMAN_BROWSER_PROFILE,
    AGENT_BROWSER_PROFILE: leadEnv.CAVEMAN_BROWSER_PROFILE,
    GREETING: "hello",
  });
  expect(leadEnv.CAVEMAN_PORT_POSTGRES).toBe(String(ports.postgres));
  expect(path.basename(leadEnv.TMPDIR!)).toBe(workspaceTag(lead.id));
  expect(
    fs.statSync(leadEnv.TMPDIR!).isDirectory() &&
      fs.statSync(leadEnv.CAVEMAN_BROWSER_PROFILE!).isDirectory(),
  ).toBe(true);

  // One working copy, one environment: the child that works where its lead does gets every one of the lead's variables.
  await delegateFrom(orchestrator, lead, "slow: shared work", "Shared");
  let shared: Workspace | undefined;
  await until(
    async () => (shared = (await children()).find((w) => w.title === "Shared")) !== undefined,
    60_000,
  );
  expect(shared!.root_path).toBe(leadRoot);
  expect(await envOf(shared!.id, "iso-shared-term")).toEqual(leadEnv);
  expect(portsOf(shared!.id)).toEqual([]);

  // A child asked for with a worktree of its own: T3 makes its thread with none yet, so until it has one it is in its lead's.
  const parentThreadId = ThreadId.make(`caveman:${lead.id}`);
  const projection = await Effect.runPromise(orchestrator.getThreadProjection(parentThreadId));
  const run = projection.runs.find((r) => r.status === "running")!;
  await Effect.runPromise(
    orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make("test-delegate:Own"),
      parentThreadId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "slow: own work",
      title: "Own",
      modelSelection: projection.thread.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
      completionWake: "always",
    }),
  );
  let mine: Workspace | undefined;
  await until(
    async () => (mine = (await children()).find((w) => w.title === "Own")) !== undefined,
    60_000,
  );
  expect(await envOf(mine!.id, "iso-own-before")).toEqual(leadEnv);
  // T3 prepares the worktree and says so on the thread (ThreadLaunchService, which this harness runs without): the
  // same command, for a worktree made here. The projector follows it onto the child's workspace.
  const worktree = path.join(root, "own-worktree");
  git(repo, "worktree", "add", "-q", "-b", "caveman/own", worktree, "HEAD");
  const childThreadId = db(
    (d) =>
      d.prepare("SELECT thread_id FROM caveman_sp_workspaces WHERE id = ?").get(mine!.id) as {
        thread_id: string;
      },
  ).thread_id;
  await Effect.runPromise(
    orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("test-delegate:Own:worktree"),
      threadId: ThreadId.make(childThreadId),
      worktreePath: worktree,
      branch: "caveman/own",
    }),
  );
  await until(
    async () =>
      (await client.call("workspace.get", { workspace_id: mine!.id })).root_path === worktree,
    60_000,
  );
  // From its first child process on, it has its own.
  const mineEnv = await envOf(mine!.id, "iso-own-term");
  const minePorts = Object.fromEntries(portsOf(mine!.id).map((row) => [row.name, row.port]));
  expect(Object.keys(minePorts).sort()).toEqual(["postgres", "web"]);
  expect(own(mineEnv)).toEqual({
    CAVEMAN_WORKSPACE_ID: mine!.id,
    COMPOSE_PROJECT_NAME: workspaceTag(mine!.id),
    AGENT_BROWSER_SESSION: workspaceTag(mine!.id),
    CAVEMAN_PORT_WEB: String(minePorts.web),
    CAVEMAN_PORT: String(minePorts.web),
    PORT: String(minePorts.web),
    TMPDIR: mineEnv.TMPDIR,
    CAVEMAN_BROWSER_PROFILE: mineEnv.CAVEMAN_BROWSER_PROFILE,
    AGENT_BROWSER_PROFILE: mineEnv.CAVEMAN_BROWSER_PROFILE,
    GREETING: "hello",
  });
  // Nothing of it is the lead's.
  expect(new Set([ports.web, ports.postgres, minePorts.web, minePorts.postgres]).size).toBe(4);
  expect(mineEnv.TMPDIR).not.toBe(leadEnv.TMPDIR);
  expect(fs.statSync(mineEnv.TMPDIR!).isDirectory()).toBe(true);
  // Its ports show on its workspace, and a second terminal gets the same ones.
  expect((await client.call("workspace.get", { workspace_id: mine!.id })).ports).toEqual(minePorts);
  expect(own(await envOf(mine!.id, "iso-own-term-2"))).toEqual(own(mineEnv));

  // Archived: what was its own goes; the lead's stays.
  await client.call("workspace.archive", { request_id: "iso-own-archive", workspace_id: mine!.id });
  expect(portsOf(mine!.id)).toEqual([]);
  expect(fs.existsSync(mineEnv.TMPDIR!) || fs.existsSync(mineEnv.CAVEMAN_BROWSER_PROFILE!)).toBe(
    false,
  );
  await client.call("workspace.archive", {
    request_id: "iso-shared-archive",
    workspace_id: shared!.id,
  });
  expect(portsOf(lead.id).map((row) => row.name)).toEqual(["postgres", "web"]);
  expect(fs.statSync(leadEnv.TMPDIR!).isDirectory()).toBe(true);
  await client.call("turn.interrupt", { request_id: "iso-lead-stop", session_id: lead.session_id });
}, 300_000);

test("an automation run has one set of variables for its command step, its check and its step's agent, gone when it ends", async () => {
  // A chat first, so the project exists, as it does for any automation's project.
  await createReady(client, {
    request_id: "iso-project",
    repo: { path: repo },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const yaml = [
    "steps:",
    "  build:",
    "    run: sh probe.sh step",
    "    computer: full",
    "  fix:",
    "    needs: [build]",
    "    prompt: Fix it.",
    "    computer: full",
    "    checks: [sh probe.sh check]",
    "",
  ].join("\n");
  const admitted = await Effect.runPromise(
    runner.admit({
      projectId: projectIdFor(repo),
      revision: revisionOf([{ path: ".caveman/automations/probe.yaml", text: yaml }], "probe"),
      trigger: {
        kind: "manual",
        subject: "manual:01jc8z3k5m0000000000000001",
        trusted: true,
        receivedAt: new Date().toISOString(),
      },
      apply: false,
    }),
  );
  const runId = (admitted as { runId?: string }).runId!;
  expect(runId).toBeDefined();
  const scope = runScopeId(runId);
  try {
    await until(() => fs.existsSync(path.join(out, "check.env")), 120_000);
    const step = readEnv(path.join(out, "step.env"));
    const check = readEnv(path.join(out, "check.env"));
    const ports = Object.fromEntries(portsOf(scope).map((row) => [row.name, row.port]));
    expect(Object.keys(ports).sort()).toEqual(["postgres", "web"]);
    expect(own(step)).toEqual({
      CAVEMAN_WORKSPACE_ID: scope,
      COMPOSE_PROJECT_NAME: workspaceTag(scope),
      AGENT_BROWSER_SESSION: workspaceTag(scope),
      CAVEMAN_PORT_WEB: String(ports.web),
      CAVEMAN_PORT: String(ports.web),
      PORT: String(ports.web),
      TMPDIR: step.TMPDIR,
      CAVEMAN_BROWSER_PROFILE: step.CAVEMAN_BROWSER_PROFILE,
      AGENT_BROWSER_PROFILE: step.CAVEMAN_BROWSER_PROFILE,
      GREETING: "hello",
    });
    expect(step.CAVEMAN_PORT_POSTGRES).toBe(String(ports.postgres));
    expect(path.basename(step.TMPDIR!)).toBe(workspaceTag(scope));
    // The check runs signed out of everything, and still in the run's own environment.
    expect(own(check)).toEqual(own(step));
    expect(check.GIT_TERMINAL_PROMPT).toBe("0");
    // The step's agent, adopted by the projector as the step's workspace while the run goes: the same variables.
    expect(stepThreads).toHaveLength(1);
    const workspaceId = adopted(stepThreads[0]!)!;
    expect(workspaceId).toBeDefined();
    expect(own(await envOf(workspaceId, "iso-step-term"))).toEqual(own(step));
    expect(fs.statSync(step.TMPDIR!).isDirectory()).toBe(true);

    // The run ends: its ports are free and its folders are gone.
    fs.writeFileSync(path.join(out, "go"), "");
    await until(
      async () =>
        ["succeeded", "failed", "cancelled"].includes(
          (await Effect.runPromise(runner.get(runId)))!.status,
        ),
      120_000,
    );
    expect((await Effect.runPromise(runner.get(runId)))!.status).toBe("succeeded");
    await until(() => portsOf(scope).length === 0, 30_000);
    expect(fs.existsSync(step.TMPDIR!) || fs.existsSync(step.CAVEMAN_BROWSER_PROFILE!)).toBe(false);
  } finally {
    fs.writeFileSync(path.join(out, "go"), "");
  }
}, 300_000);
