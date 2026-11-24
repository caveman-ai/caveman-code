// A lead's limits on its builders (findings P4, P12) on a real Cloud computer's runtime, with the stand-in Claude
// CLI: builders start as delegate_task starts them (Builders.start, with the limits every delegation passes as its
// `admit`), in worktrees of the computer's checkout. Settings > Agents' own numbers are OrchestratorMcpService's
// (mcp/OrchestratorMcpService.test.ts, "a lead's builders meet Settings > Agents' limits"); the first two tests here
// call its delegate_task for real, over the same runtime, to say that one number holds: Settings > Agents'.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import { EnvironmentId, ThreadId, type ServerProvider } from "@caveman-app/protocol";
import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterEach, expect, test } from "vitest";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import {
  CLAUDE_DEFAULT_INSTANCE_ID,
  CLAUDE_PROVIDER,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BuilderError, Builders } from "../session-protocol/builders.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { builderKit } from "./builders.kit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { startTools, githubWith, checkoutOf, computerRuntime } = builderKit(cleanups);

type Settings = ServerSettings.ServerSettingsService["Service"];

/** Settings > Agents as a test holds them: the defaults (eight agents at once) until it says otherwise. */
const settingsOf = async (): Promise<Settings> => {
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return Context.get(
    await Effect.runPromise(Layer.buildWithScope(ServerSettings.layerTest(), scope)),
    ServerSettings.ServerSettingsService,
  );
};

/**
 * A Cloud computer with room for every chat here: the limits under test are the lead's and the Chiefs', not its size.
 * `settings`: its Settings > Agents; without, it has none and reads the defaults.
 */
async function roomyComputer(name: string, settings?: Settings) {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  await startTools();
  process.env.CAVEMAN_COMPUTER_CPUS = "16";
  process.env.CAVEMAN_COMPUTER_MEMORY_GIB = "64";
  cleanups.push(
    () => (
      delete process.env.CAVEMAN_COMPUTER_CPUS,
      delete process.env.CAVEMAN_COMPUTER_MEMORY_GIB
    ),
  );
  cloud.state.gitBackend = githubWith(
    makeRepo(tempRoot(`limits-${name}-source-`), { "README.md": "widgets\n" }),
  );
  return computerRuntime(
    cloud,
    checkoutOf(cloud.state.gitBackend, `limits-${name}-`),
    name,
    undefined,
    settings === undefined
      ? undefined
      : Layer.succeed(ServerSettings.ServerSettingsService, settings),
  );
}

/** One delegate_task with isolation "worktree": the builder it started, or the refusal's words. */
const start = (
  builders: Builders["Service"],
  lead: Workspace,
  key: string,
  task: string,
  admit?: Effect.Effect<void, BuilderError>,
) =>
  Effect.runPromise(
    builders
      .start({
        parentThreadId: `caveman:${lead.id}`,
        task,
        title: key,
        requestKey: key,
        ...(admit === undefined ? {} : { admit }),
      })
      .pipe(
        Effect.match({
          onSuccess: (started) => started?.workspaceId ?? "T3's child",
          onFailure: (error) => `${error.reason}: ${error.message}`,
        }),
      ),
  );

/**
 * delegate_task as a chat's agent calls it: the real OrchestratorMcpService over this runtime's own orchestrator and
 * builders' route (as server.ts wires them), with Settings > Agents as that service reads them: eight agents at once
 * until `agentsAtOnce` says otherwise. Only what picks a child's harness is stood in: one Claude Agent, the stand-in CLI.
 * `shared`: the Settings the runtime reads too (roomyComputer), so one Settings > Agents holds both; without, its own.
 */
async function agentOf(runtime: { readonly context: unknown }, shared?: Settings) {
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const settings = shared ?? (await settingsOf());
  const own = runtime.context as Context.Context<
    Orchestrator.OrchestratorV2 | ProviderSessionManager.ProviderSessionManagerV2 | Builders
  >;
  const orchestrator = Context.get(own, Orchestrator.OrchestratorV2);
  const fromRuntime = Layer.mergeAll(
    Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      Context.get(own, ProviderSessionManager.ProviderSessionManagerV2),
    ),
    Layer.succeed(Builders, Context.get(own, Builders)),
    Layer.succeed(ServerSettings.ServerSettingsService, settings),
  );
  const claude: ServerProvider = {
    instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
    driver: CLAUDE_PROVIDER,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-10T00:00:00.000Z",
    models: [{ slug: MODEL, name: MODEL, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      ThreadManagementService.layer.pipe(
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([claude]),
          refreshInstance: () => Effect.succeed([claude]),
        }),
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            list: () => Effect.succeed([CLAUDE_DEFAULT_INSTANCE_ID]),
            get: (instanceId) =>
              Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
          }),
        ),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
    Layer.provide(fromRuntime),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const service = Context.get(
    await Effect.runPromise(Layer.buildWithScope(layer, scope)),
    OrchestratorMcpService.OrchestratorMcpService,
  );
  /** The MCP credential of `lead`'s agent while its turn runs. */
  const callerOf = async (lead: Workspace): Promise<McpInvocationScope> => {
    const threadId = ThreadId.make(`caveman:${lead.id}`);
    const shell = await Effect.runPromise(orchestrator.getThreadShell(threadId));
    return {
      environmentId: EnvironmentId.make("session-protocol-test"),
      requestNamespace: `agent:${lead.id}`,
      thread: {
        threadId,
        providerSessionId: `agent:${lead.id}`,
        providerInstanceId: shell!.providerInstanceId!,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
  };
  const refusalOf = (error: { readonly code: string; readonly message: string }) => ({
    refusal: `${error.code}: ${error.message}`,
  });
  return {
    orchestrator,
    /** Settings > Agents, "Agents working at once". */
    agentsAtOnce: (maxConcurrent: number) =>
      Effect.runPromise(settings.updateSettings({ subagents: { maxConcurrent } })),
    /** One delegate_task from `lead`'s running turn: the thread it started, or the refusal its agent reads. */
    delegate: async (
      lead: Workspace,
      key: string,
      input: { readonly task: string; readonly isolation?: "worktree" },
    ): Promise<{ readonly child?: string; readonly refusal?: string }> =>
      Effect.runPromise(
        service
          .delegateTask(await callerOf(lead), {
            ...input,
            title: key,
            mode: "async",
            clientRequestId: key,
          })
          .pipe(
            Effect.match({
              onSuccess: (task) => ({ child: task.childThreadId ?? "" }),
              onFailure: refusalOf,
            }),
          ),
      ),
    /** One thread_send from `lead`'s running turn to an agent it delegated to: how it was delivered, or the refusal. */
    send: async (
      lead: Workspace,
      key: string,
      to: string,
      message: string,
    ): Promise<{ readonly delivery?: string; readonly refusal?: string }> =>
      Effect.runPromise(
        service
          .sendToThread(await callerOf(lead), {
            threadId: ThreadId.make(to),
            message,
            clientRequestId: key,
          })
          .pipe(
            Effect.match({
              onSuccess: (sent) => ({ delivery: sent.delivery }),
              onFailure: refusalOf,
            }),
          ),
      ),
  };
}

/**
 * What keeps the stand-in CLI's turn open until the test ends: a line of its own, so it holds after the boot note a
 * Cloud computer puts before a chat's first message too (a leading "slow <ms>:" does not there).
 */
const HOLD = "hold: 600000";

/** A chat with a turn at work, as its agent is when it calls delegate_task. */
async function atWork(client: ReturnType<typeof connect>, lead: Workspace) {
  await client.call("turn.submit", {
    request_id: `${lead.id}:lead`,
    session_id: lead.session_id,
    kind: "followup",
    input: { text: `lead the work\n${HOLD}` },
  });
  await until(
    async () =>
      (await client.call("workspace.get", { workspace_id: lead.id })).status === "working",
    30_000,
  );
}

/** Delegations one after another, each kept at work: how many started, and what the first one refused was told. */
async function fanOut(
  agent: Awaited<ReturnType<typeof agentOf>>,
  lead: Workspace,
  asks: number,
  isolation?: "worktree",
) {
  let started = 0;
  for (let n = 1; n <= asks; n++) {
    const outcome = await agent.delegate(lead, `${lead.id}-b${n}`, {
      task: `part ${n}\n${HOLD}`,
      ...(isolation === undefined ? {} : { isolation }),
    });
    if (outcome.refusal !== undefined) return { started, refusal: outcome.refusal };
    started++;
  }
  return { started, refusal: undefined };
}

/** What a chat's agent is told when as many agents as its one number allows are at work under it. */
const treeFull = (atOnce: number) =>
  `limit_reached: Not delegated: ${atOnce} delegated agents are already working in this task. Wait for one to finish (its result wakes you), then delegate again.`;

// One number says how many of a chat's agents work at once: Settings > Agents' "Agents working at once". No chat
// carries a number of its own.
test.skipIf(process.platform === "win32")(
  "Settings > Agents' number is how many of a chat's builders work at once on a Cloud computer, raised or lowered",
  async () => {
    const settings = await settingsOf();
    const { client, builders, runtime } = await roomyComputer("settings", settings);
    const agent = await agentOf(runtime, settings);
    const chat = (id: string) =>
      createReady(client, {
        request_id: id,
        repo: { url: "https://github.com/acme/widgets" },
        title: id,
        engine: "claude-agent",
        options: { model: MODEL },
      });
    const tree = (lead: Workspace) => Effect.runPromise(builders.tree(`caveman:${lead.id}`));
    const more = (lead: Workspace, key: string) =>
      agent.delegate(lead, key, { task: `one more\n${HOLD}`, isolation: "worktree" });

    // Settings > Agents as it comes: eight agents at once, and the ninth is told so.
    const first = await chat("first");
    await atWork(client, first);
    expect(await fanOut(agent, first, 9, "worktree")).toEqual({ started: 8, refusal: treeFull(8) });
    // Its tree names no number of its own.
    expect(await tree(first)).toEqual({ running: 8, threadIds: expect.any(Array), tokens: 0 });

    // Raised to twelve, the same chat starts four more, and the thirteenth is told twelve.
    await agent.agentsAtOnce(12);
    for (const n of [9, 10, 11, 12])
      expect((await more(first, `first-more-${n}`)).refusal).toBeUndefined();
    expect(await more(first, "first-more-13")).toEqual({ refusal: treeFull(12) });
    expect(await tree(first)).toMatchObject({ running: 12 });

    // Lowered to three, a new chat runs three.
    await agent.agentsAtOnce(3);
    const second = await chat("second");
    await atWork(client, second);
    expect(await fanOut(agent, second, 4, "worktree")).toEqual({
      started: 3,
      refusal: treeFull(3),
    });
  },
  300_000,
);

test("Settings > Agents' number holds on This Mac too, where a chat's agents are T3's children, and for a message that sets a finished one working again", async () => {
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  cleanups.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  cleanups.push(() => client.close());
  const agent = await agentOf(runtime);
  const repo = makeRepo(tempRoot("limits-mac-"), { "README.md": "widgets\n" });
  const chat = (id: string) =>
    createReady(client, {
      request_id: id,
      repo: { path: repo },
      title: id,
      engine: "claude-agent",
      options: { model: MODEL },
    });
  /** The chats under `lead`: each agent it delegated to is one. */
  const under = async (lead: Workspace) =>
    (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces.length;

  // Settings at four. One that finished gave its place back, and a message that would set it working again is a
  // fifth at work, so it is refused as a fifth delegation is.
  await agent.agentsAtOnce(4);
  const four = await chat("four");
  await atWork(client, four);
  const quick = await agent.delegate(four, "four-quick", { task: "a quick part" });
  const fourThread = ThreadId.make(`caveman:${four.id}`);
  await until(
    async () =>
      (await Effect.runPromise(agent.orchestrator.getThreadProjection(fourThread))).subagents.some(
        (task) => task.childThreadId === quick.child && task.status === "completed",
      ),
    30_000,
  );
  expect(await fanOut(agent, four, 5)).toEqual({ started: 4, refusal: treeFull(4) });
  expect(await agent.send(four, "four-again", quick.child!, `look again\n${HOLD}`)).toEqual({
    refusal: treeFull(4),
  });
  // The quick one and the four at work: five chats under it.
  await until(async () => (await under(four)) === 5, 30_000);

  // Raised to twelve, a new chat runs twelve.
  await agent.agentsAtOnce(12);
  const twelve = await chat("twelve");
  await atWork(client, twelve);
  expect(await fanOut(agent, twelve, 13)).toEqual({ started: 12, refusal: treeFull(12) });
  await until(async () => (await under(twelve)) === 12, 30_000);
}, 300_000);

test.skipIf(process.platform === "win32")(
  "a lead's builders hold a place only while they work: one that finished frees it, a retry takes none, and a new one passes the limits every delegation meets",
  async () => {
    // Settings > Agents at two agents at once.
    const settings = await settingsOf();
    await Effect.runPromise(settings.updateSettings({ subagents: { maxConcurrent: 2 } }));
    const { client, builders } = await roomyComputer("lead", settings);
    const lead = await createReady(client, {
      request_id: "lead",
      repo: { url: "https://github.com/acme/widgets" },
      title: "Lead of two",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const atWork = async () =>
      (await Effect.runPromise(builders.tree(`caveman:${lead.id}`))).running;
    const FULL =
      "limit_reached: Not started: this lead runs 2 builders at once, and they are all at work. Wait for one to finish (its result wakes you), then start the next.";

    // Two at work fill a lead of two; the third is told to wait, in words that say what frees a place.
    const one = await start(builders, lead, "k1", "slow 5000: part one");
    const two = await start(builders, lead, "k2", "slow 5000: part two");
    expect(await atWork()).toBe(2);
    expect(await start(builders, lead, "k3", "slow 0: part three")).toBe(FULL);
    // A retry of one that started is that builder, full or not, and whatever the limits say now.
    const refusing = Effect.fail(
      new BuilderError({
        reason: "limit_reached",
        message: "Not delegated: the agents in this task have used their budget.",
      }),
    );
    expect(await start(builders, lead, "k1", "slow 5000: part one", refusing)).toBe(one);
    // Both finish: their places are free, though this lead has started two already.
    await until(async () => (await atWork()) === 0, 60_000);
    const three = await start(builders, lead, "k3", "slow 0: part three");
    const four = await start(builders, lead, "k4", "slow 0: part four");
    expect(new Set([one, two, three, four]).size).toBe(4);
    for (const id of [three, four]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await until(async () => (await atWork()) === 0, 60_000);
    // A new one passes what every delegation passes (Settings > Agents, as delegate_task hands it over): refused there,
    // nothing is started and no place is taken.
    expect(await start(builders, lead, "k5", "slow 0: part five", refusing)).toBe(
      "limit_reached: Not delegated: the agents in this task have used their budget.",
    );
    expect(await atWork()).toBe(0);
    // Four builders in all under a lead of two: four worktrees, each on its own branch.
    const children = (await client.call("workspace.list", {})).workspaces.filter(
      (w) => w.parent_workspace_id === lead.id,
    );
    expect(children).toHaveLength(4);
    expect(new Set(children.map((w) => w.branch)).size).toBe(4);
    // A builder is one level under its lead and starts none of its own.
    expect(await start(builders, children[0]!, "nested", "slow 0: nested")).toBe(
      "invalid_request: A builder does its own work: only its lead starts builders. Message the lead if the work needs more hands.",
    );
  },
  300_000,
);

test.skipIf(process.platform === "win32")(
  "the Chiefs' number of agents at once counts their chats' builders: a chat on a Chief's board starts no builder past it, a person's own chat is not held (P12)",
  async () => {
    const { client, builders } = await roomyComputer("chief");
    // The Chiefs run two agents at once.
    await client.call("settings.set", { request_id: "c1", settings: { chief_max_concurrent: 2 } });
    const chat = (id: string) =>
      createReady(client, {
        request_id: id,
        repo: { url: "https://github.com/acme/widgets" },
        title: `Chat ${id}`,
        engine: "claude-agent",
        options: { model: MODEL },
      });
    // A chat no Chief started is the person's own: the Chiefs' number does not hold its builders.
    const own = await chat("own");
    const mine = await Promise.all(
      ["a", "b", "c"].map((key) => start(builders, own, key, "slow 0: own")),
    );
    for (const id of mine) expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // A chat on a Chief's board is one of the Chiefs' agents. At work itself it is one; its first builder is the
    // second; the next is past the Chiefs' two, though Settings > Agents' number is eight.
    const theirs = await chat("theirs");
    await client.call("chief.attach", { request_id: "c2", workspace_id: theirs.id });
    const events: Array<SessionEvent> = [];
    await client.attach(theirs.session_id, 0, (event) => events.push(event));
    await client.call("turn.submit", {
      request_id: "t1",
      session_id: theirs.session_id,
      kind: "followup",
      input: { text: "slow 15000: lead the work" },
    });
    await until(
      async () =>
        (await client.call("workspace.get", { workspace_id: theirs.id })).status === "working",
      30_000,
    );
    expect(await start(builders, theirs, "one", "slow 8000: one")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await start(builders, theirs, "two", "slow 0: two")).toBe(
      "limit_reached: Not started: the Chiefs run 2 agents at once (Settings > Chiefs), builders included, and they are all at work. Do this part yourself, or wait for one to finish.",
    );
    expect((await Effect.runPromise(builders.tree(`caveman:${theirs.id}`))).running).toBe(1);
    // With the Chiefs' limit off the same start goes through.
    await client.call("settings.set", { request_id: "c3", settings: { chief_max_concurrent: 0 } });
    expect(await start(builders, theirs, "two", "slow 0: two")).toMatch(/^[0-9a-f-]{36}$/);
  },
  300_000,
);
