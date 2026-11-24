// Cloud schedules (session-protocol/cloudSchedules.ts) end to end against the stand-in Cloud, with the stand-in Claude
// CLI (no model): an agent in a chat on This Mac schedules work on Cloud; it waits for the person's Allow; then a
// builder on a Cloud computer of its own holds the schedule on its chat, asks Cloud to wake it for the next run, runs
// it, and each run's answer comes back by mail and wakes the chat that set it. An agent's change waits for the person
// again; deleting it ends it on the Cloud computer too.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { ScheduledTaskId, ThreadId, type ScheduledTask } from "@caveman-app/protocol";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { afterEach, expect, test } from "vitest";

import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { CloudSchedules } from "../session-protocol/cloudSchedules.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";
import { TOOLS_EXEC } from "./tools.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const userTexts = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) =>
    e.type === "message.done" && e.payload.role === "user" ? [e.payload.text] : [],
  );

async function startTools() {
  const socket = path.join(tempRoot("schedules-tools-sock-"), "tools.sock");
  const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], {
    env: { ...process.env, TOOLS_SIDE: "yes" },
    stdio: "ignore",
  });
  cleanups.push(() => tools.kill());
  await until(() => fs.existsSync(socket));
  process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = socket;
  cleanups.push(() => delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS);
}

/**
 * The Cloud computer's scheduled tasks, in memory: the session harness runs no ScheduledTaskService of its own
 * (production's runtimeLayer does). Run now sends the prompt into the bound chat as a run does, so the builder's real
 * report goes back by mail.
 */
function scheduledTasksHere(run: (task: ScheduledTask) => Promise<void>) {
  const tasks = new Map<string, ScheduledTask>();
  const list = () => Effect.sync(() => ({ tasks: [...tasks.values()] }));
  const nextOf = (task: Pick<ScheduledTask, "enabled" | "schedule">) => {
    const next = task.enabled
      ? nextScheduledRunAt(task.schedule, DateTime.makeUnsafe(Date.now()))
      : null;
    return next === null ? null : DateTime.formatIso(DateTime.toUtc(next));
  };
  return Layer.mock(ScheduledTaskService.ScheduledTaskService)({
    list,
    subscribeList: () =>
      Stream.fromEffect(list()).pipe(Stream.repeat(Schedule.spaced("250 millis"))),
    setRunModel: () => Effect.void,
    upsert: (input) =>
      Effect.suspend(() => {
        const id = input.id ?? ScheduledTaskId.make(`scheduled-task:${input.commandId}`);
        const before = tasks.get(id);
        if (input.requireExisting === true && before === undefined)
          return Effect.die(new Error("Schedule task not found."));
        const at = new Date().toISOString();
        const schedule = input.schedule as ScheduledTask["schedule"];
        const task: ScheduledTask = {
          id,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule,
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdBy: input.createdBy ?? "user",
          creationSource: input.creationSource ?? "web",
          createdAt: before?.createdAt ?? at,
          updatedAt: at,
          nextRunAt: nextOf({ enabled: input.enabled, schedule }),
          lastRunAt: before?.lastRunAt ?? null,
          lastRunStatus: before?.lastRunStatus ?? "never",
          lastRunError: null,
          runCount: before?.runCount ?? 0,
        };
        tasks.set(id, task);
        return Effect.succeed({ task });
      }),
    delete: ({ id }) => Effect.sync(() => (tasks.delete(id), { id })),
    runNow: ({ id }) =>
      Effect.promise(async () => {
        const task = tasks.get(id)!;
        await run(task);
        return { task, threadId: ThreadId.make(task.threadId!) };
      }),
  });
}

// Skipped on Windows: the builder's computer is a Cloud computer, which is Linux, with its tools channel on a Unix socket.
test.skipIf(process.platform === "win32")(
  "an agent on This Mac schedules work on Cloud: it waits for the person, then a Cloud computer holds it, is woken for it, and each run wakes the chat",
  async () => {
    const cloud = await startTestCloud();
    cleanups.push(cloud.close);
    await startTools();
    const source = makeRepo(tempRoot("schedules-source-"), { "README.md": "widgets\n" });
    const backend = tempRoot("schedules-github-");
    fs.mkdirSync(path.join(backend, "acme"), { recursive: true });
    execFileSync("git", [
      "clone",
      "--bare",
      "--quiet",
      source,
      path.join(backend, "acme", "widgets.git"),
    ]);
    cloud.state.gitBackend = backend;

    // The builder's Cloud computer, enrolled; Cloud places the spawn there.
    const checkout = path.join(tempRoot("schedules-builder-"), "workspace");
    execFileSync("git", ["clone", "--quiet", path.join(backend, "acme", "widgets.git"), checkout]);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/acme/widgets.git"], {
      cwd: checkout,
    });
    const linkDir = path.join(tempRoot("schedules-builder-link-"), "link");
    const identity = await enroll({
      dir: linkDir,
      cloudUrl: cloud.url,
      bearer: cloud.state.personToken,
      name: "builder",
    });
    let builderClientRef: ReturnType<typeof connect> | undefined;
    const runs: Array<string> = [];
    const tasksHere = scheduledTasksHere(async (task) => {
      runs.push(task.prompt);
      const chat = (await builderClientRef!.call("workspace.list", {})).workspaces.find(
        (w) => `caveman:${w.id}` === task.threadId,
      )!;
      await builderClientRef!.call("turn.submit", {
        request_id: `run-${runs.length}`,
        session_id: chat.session_id,
        kind: "followup",
        input: { text: task.prompt },
      });
    });
    const builderRuntime = await startRuntime(await makeConfig(), "fake-claude", undefined, {
      provide: Layer.mergeAll(
        Layer.succeed(CloudComputer, {
          linkDir,
          computerId: identity.computerId,
          workspaceRoot: checkout,
        }),
        Layer.succeed(CloudLinkState, {}),
        tasksHere,
      ) as unknown as Layer.Layer<any>,
    });
    cleanups.push(builderRuntime.close);
    const builderClient = connect(builderRuntime.url, builderRuntime.token);
    builderClientRef = builderClient;
    cleanups.push(() => builderClient.close());
    await until(
      async () => (await builderClient.call("cloud.status", {})).state === "connected",
      15_000,
    );
    cloud.state.tree.nextComputers.push(identity.computerId);

    // This Mac, and the chat whose agent sets the schedule.
    const mac = await startRuntime(await makeConfig(), "fake-claude");
    cleanups.push(mac.close);
    const client = connect(mac.url, mac.token);
    cleanups.push(() => client.close());
    await client.call("cloud.enroll", {
      request_id: "e1",
      cloud_url: cloud.url,
      token: cloud.state.personToken,
      name: "Test Mac",
    });
    cloud.state.tree.laptops.add(
      [...cloud.state.runtimes.values()].find((r) => r.computerId !== identity.computerId)!
        .computerId,
    );
    const repo = makeRepo(tempRoot("schedules-mac-"), { "README.md": "widgets\n" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
      cwd: repo,
    });
    const lead = await createReady(client, {
      request_id: "lead",
      repo: { path: repo },
      title: "Flaky tests",
      engine: "claude-agent",
      options: { model: MODEL },
    });
    const events: Array<SessionEvent> = [];
    await client.attach(lead.session_id, 0, (event) => events.push(event));
    const schedules = Context.get(
      mac.context as unknown as Context.Context<CloudSchedules>,
      CloudSchedules,
    );

    // The agent's schedule_task with where: "cloud". Nothing starts until the person allows it.
    const made = await Effect.runPromise(
      schedules.create({
        threadId: `caveman:${lead.id}`,
        title: "Nightly sweep",
        prompt: "slow 0: Sweep the flaky tests",
        schedule: { type: "interval", everyMs: 3_600_000 },
        requestKey: "agent-1",
        by: "agent",
      }),
    );
    expect(made).toMatchObject({
      state: "awaiting_approval",
      nextRunAt: null,
      leadWorkspaceId: lead.id,
    });
    expect(cloud.state.tree.spawns).toHaveLength(0);
    // A retry of the same call is the same schedule.
    expect(
      (
        await Effect.runPromise(
          schedules.create({
            threadId: `caveman:${lead.id}`,
            title: "Nightly sweep",
            prompt: "x",
            schedule: { type: "interval", everyMs: 3_600_000 },
            requestKey: "agent-1",
            by: "agent",
          }),
        )
      ).id,
    ).toBe(made.id);
    // A webhook runs where its URL is, never on Cloud.
    await expect(
      Effect.runPromise(
        schedules.create({
          threadId: `caveman:${lead.id}`,
          title: "Hook",
          prompt: "x",
          schedule: { type: "webhook" },
          requestKey: "agent-2",
          by: "agent",
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    const listed = (await client.call("automation.list", {})).automations.find(
      (a) => a.id === made.id,
    );
    expect(listed).toMatchObject({
      host: "cloud",
      awaiting_approval: true,
      workspace_id: lead.id,
      trigger: { type: "interval", every_minutes: 60 },
      enabled: true,
    });

    // The person allows it: a builder of the chat's spawns on a Cloud computer of its own, carrying the schedule.
    const allowed = await client.call("automation.allow", { request_id: "allow-1", id: made.id });
    expect(allowed.awaiting_approval).toBeUndefined();
    expect(cloud.state.tree.spawns).toHaveLength(1);
    expect(cloud.state.tree.spawns[0]).toMatchObject({
      made: true,
      computer: identity.computerId,
      body: {
        where: "cloud",
        brief: "slow 0: Sweep the flaky tests",
        schedule: { type: "interval", everyMs: 3_600_000 },
      },
    });
    const spawned = [...cloud.state.tree.workspaces.values()].find((w) => w.parent !== null)!;

    // Its computer makes the builder's chat with no turn, and holds the schedule on it as a scheduled task.
    let held:
      | {
          id: string;
          workspace_id?: string;
          next_run_at: string | null;
          prompt: string;
          enabled: boolean;
        }
      | undefined;
    await until(async () => {
      held = (await builderClient.call("automation.list", {})).automations.find(
        (a) => a.title === "Nightly sweep",
      );
      return held !== undefined;
    }, 30_000);
    const hosted = (await builderClient.call("workspace.list", {})).workspaces.find(
      (w) => w.session_id === spawned.session_id,
    )!;
    expect(held).toMatchObject({ workspace_id: hosted.id, enabled: true });
    expect(held!.prompt).toContain("Sweep the flaky tests");
    expect(held!.prompt).toContain("runs on a schedule, on a Cloud computer of its own");
    expect(Date.parse(held!.next_run_at!) - Date.now()).toBeGreaterThan(50 * 60_000);
    // Asleep, the computer is woken for it: it told Cloud its next run, on the builder's workspace.
    await until(
      () =>
        cloud.state.automations.wakeAts.some(
          (w) => w.workspace === spawned.id && w.at === held!.next_run_at,
        ),
      30_000,
    );

    // Run now (the person's): its answer comes back by mail and wakes the chat.
    await client.call("automation.run", { request_id: "run-1", id: made.id });
    await until(
      () => userTexts(events).some((text) => text.includes('Cloud schedule "Nightly sweep" ran')),
      60_000,
    );
    expect(runs).toHaveLength(1);
    expect(userTexts(events).find((text) => text.includes("Nightly sweep"))).toContain(
      "Sweep the flaky tests",
    );
    await until(
      async () =>
        (await client.call("automation.list", {})).automations.find((a) => a.id === made.id)
          ?.run_count === 1,
      10_000,
    );
    expect(
      (await client.call("automation.list", {})).automations.find((a) => a.id === made.id),
    ).toMatchObject({ last_status: "succeeded" });

    // The agent changes what it runs: it waits for the person again, paused on its computer meanwhile.
    const changed = await Effect.runPromise(
      schedules.update(made.id, { prompt: "slow 0: Sweep and file issues" }, "agent"),
    );
    expect(changed.state).toBe("awaiting_approval");
    await until(
      async () =>
        (await builderClient.call("automation.list", {})).automations.find((a) => a.id === held!.id)
          ?.enabled === false,
      30_000,
    );
    await client.call("automation.allow", { request_id: "allow-2", id: made.id });
    await until(async () => {
      const now = (await builderClient.call("automation.list", {})).automations.find(
        (a) => a.id === held!.id,
      );
      return now?.enabled === true && now.prompt.includes("Sweep and file issues");
    }, 30_000);
    expect(cloud.state.tree.spawns).toHaveLength(1);

    // Deleted here, it ends there too.
    await client.call("automation.delete", { request_id: "delete-1", id: made.id });
    expect(
      (await client.call("automation.list", {})).automations.find((a) => a.id === made.id),
    ).toBeUndefined();
    await until(
      async () =>
        (await builderClient.call("automation.list", {})).automations.every(
          (a) => a.id !== held!.id,
        ),
      30_000,
    );
    expect(cloud.state.tree.refused).toEqual([]);
  },
  180_000,
);
