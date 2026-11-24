// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, ProviderInstanceId, ScheduledTaskId, ScheduledTaskUpsertInput, type ScheduledTask } from "@caveman-app/protocol";
import * as Automations from "@caveman-app/automations";
import * as GitHubCredentials from "@caveman-app/source-control-github/server/GitHubCredentials";
import {
  Automation,
  AutomationDiagnostic,
  AutomationExplanation,
  AutomationTemplateSummary,
  Methods,
  type Params,
} from "@caveman-app/session-protocol/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { layer as filesLayer } from "../automations/files.ts";
import { DIGEST, fakeRunner, gitFailing, projectStoreFor, testRepo, type TestRepo } from "../automations/testing.ts";
import { makeTriggers, AutomationTriggers } from "../automations/triggers.ts";
import { automationOf, cloudAutomationOf, deliveryOf, GITHUB_MENTION_TEMPLATE, last30, makeAutomationHandlers, mentionsToRun, scheduleFor, type GitHubComment } from "./automations.ts";
import { SessionStore } from "./store.ts";

const task = (over: Partial<ScheduledTask>): ScheduledTask => ({
  id: ScheduledTaskId.make("task-1"),
  title: "Nightly triage",
  prompt: "Triage new issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project-1"),
  threadId: null,
  workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
  modelSelection: { instanceId: ProviderInstanceId.make("caveman"), model: "openai/gpt-5.4-mini" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
  nextRunAt: "2026-10-16T01:00:00.000Z",
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...over,
});

describe("automations on the Session Protocol", () => {
  it("stores each trigger as a T3 schedule", () => {
    expect(scheduleFor({ type: "interval", every_minutes: 30 })).toEqual({ type: "interval", everyMs: 1_800_000 });
    expect(scheduleFor({ type: "daily", time: "09:30", weekdays: [1, 5] })).toEqual({ type: "fixed_time", timeOfDay: "09:30", weekdays: [1, 5] });
    expect(scheduleFor({ type: "webhook" })).toEqual({ type: "webhook", signature: null });
    expect(scheduleFor({ type: "webhook", secret: "s3cret" })).toEqual({
      type: "webhook",
      signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", secret: "s3cret" },
    });
    expect(scheduleFor({ type: "webhook", keep_secret: true })).toEqual({
      type: "webhook",
      signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
    });
    // GitHub mentions arrive as deliveries only the runtime makes.
    expect(scheduleFor({ type: "github_mention", repo: "acme/api" })).toEqual({ type: "webhook", signature: null });
  });

  it("carries one-time runs, month days, cron and a repeat's bounds both ways", () => {
    const wire = [
      { type: "once", run_at: "2026-11-09T08:00:00.000Z" },
      { type: "monthly", time: "18:00", days: [1, -1], timezone: "Europe/Amsterdam", max_runs: 12 },
      { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York", until: "2027-06-30T23:59:59.999Z" },
      { type: "daily", time: "10:00", weekdays: [1], every_weeks: 2, start_at: "2026-11-09T00:00:00.000Z" },
      { type: "daily", time: "07:00", every_days: 3, timezone: "UTC", start_at: "2026-11-09T00:00:00.000Z" },
      { type: "interval", every_minutes: 90, start_at: "2026-11-09T08:00:00.000Z", max_runs: 4 },
    ] as const;
    expect(wire.map(scheduleFor)).toEqual([
      { type: "once", runAt: "2026-11-09T08:00:00.000Z" },
      { type: "monthly", timeOfDay: "18:00", days: [1, -1], timeZone: "Europe/Amsterdam", maxRuns: 12 },
      { type: "cron", expression: "0 9 * * 1-5", timeZone: "America/New_York", until: "2027-06-30T23:59:59.999Z" },
      { type: "fixed_time", timeOfDay: "10:00", weekdays: [1], everyWeeks: 2, startAt: "2026-11-09T00:00:00.000Z" },
      { type: "fixed_time", timeOfDay: "07:00", everyDays: 3, timeZone: "UTC", startAt: "2026-11-09T00:00:00.000Z" },
      { type: "interval", everyMs: 5_400_000, startAt: "2026-11-09T08:00:00.000Z", maxRuns: 4 },
    ]);
    for (const trigger of wire) {
      const shown = automationOf(task({ schedule: scheduleFor(trigger) as ScheduledTask["schedule"] }), undefined);
      expect(shown.trigger).toEqual(trigger);
      expect(Schema.is(Automation)(shown)).toBe(true);
    }
  });

  it("shows a stored task as an automation, never a webhook secret", () => {
    const interval = automationOf(task({}), undefined);
    expect(interval).toMatchObject({ trigger: { type: "interval", every_minutes: 60 }, engine: "caveman", model: "openai/gpt-5.4-mini", last_status: "never" });
    expect(Schema.is(Automation)(interval)).toBe(true);
    const hook = automationOf(
      task({ schedule: { type: "webhook", signature: { header: "x-sig", encoding: "hex", prefix: "" } }, webhook: { path: "/api/hooks/task-1/tok", url: null, hasSecret: true } }),
      undefined,
    );
    expect(hook.trigger).toEqual({ type: "webhook", path: "/api/hooks/task-1/tok", url: null, signed: true });
    const gh = automationOf(task({ prompt: `Fix it${GITHUB_MENTION_TEMPLATE}`, schedule: { type: "webhook", signature: null } }), { repo: "acme/api", since: "x" });
    expect(gh).toMatchObject({ prompt: "Fix it", trigger: { type: "github_mention", repo: "acme/api" } });
    expect(Schema.is(Automation)(gh)).toBe(true);
  });

  it("starts runs only for the signed-in user's new @caveman mentions, oldest first", () => {
    const c = (id: number, login: string, body: string, created_at: string): GitHubComment => ({
      id,
      body,
      created_at,
      user: { login },
      issue_url: `https://api.github.com/repos/acme/api/issues/${id}`,
      html_url: `https://github.com/acme/api/issues/${id}#c`,
    });
    const since = "2026-10-16T10:00:00Z";
    const comments = [
      c(1, "dev", "@caveman fix the flaky test", "2026-10-16T10:05:00Z"),
      c(2, "stranger", "@caveman delete everything", "2026-10-16T10:06:00Z"),
      c(3, "dev", "old @caveman ask", "2026-10-16T09:00:00Z"),
      c(4, "Dev", "please, @Caveman: add a test", "2026-10-16T10:01:00Z"),
      c(5, "dev", "mail me at a@caveman.so", "2026-10-16T10:07:00Z"),
      c(6, "dev", "no mention", "2026-10-16T10:08:00Z"),
    ];
    expect(mentionsToRun(comments, "dev", since).map((m) => m.id)).toEqual([4, 1]);
  });
});

describe("editing a signed webhook automation", () => {
 // automation.save's trigger, through scheduleFor, into upstream ScheduledTaskService (in-memory store).
  const save = (service: ScheduledTaskService.ScheduledTaskService["Service"], trigger: Params<"automation.save">["trigger"], title = "Deploy hook") =>
    Schema.decodeUnknownEffect(ScheduledTaskUpsertInput)({
      id: "task-hook",
      title,
      prompt: "Deploy {{body.ref}}",
      enabled: true,
      schedule: scheduleFor(trigger),
      projectId: "project-1",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "caveman", model: "openai/gpt-5.4-mini" },
      runtimeMode: "full-access",
      interactionMode: "default",
    }).pipe(Effect.flatMap((input) => service.upsert(input)), Effect.map(({ task }) => task));
  const body = new TextEncoder().encode(JSON.stringify({ ref: "main" }));
  const post = (task: ScheduledTask, headers: Record<string, string> = {}) =>
    ({
      hookId: task.id,
      token: task.webhook?.path.split("/").at(-1) ?? "",
      method: "POST",
      path: `/api/hooks/${task.id}`,
      query: "",
      headers: { "content-type": "application/json", ...headers },
      body,
      bodyText: new TextDecoder().decode(body),
    }) satisfies ScheduledTaskService.WebhookTriggerRequest;
  const signed = (secret: string) => ({ "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}` });
  /** The model each run was launched on. */
  const launched: Array<unknown> = [];
  const run = <A, E>(body: (service: ScheduledTaskService.ScheduledTaskService["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* body(yield* ScheduledTaskService.ScheduledTaskService);
      }).pipe(
        Effect.provide(
          ScheduledTaskService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodePlatformCrypto.layer,
                Scheduler.layer,
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: (input) => Effect.sync(() => launched.push(input.modelSelection)).pipe(Effect.as({ threadId: "thread-1", resumed: false } as never)),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.succeed(ScheduledTaskService.ScheduledTaskWebhookOrigin, Effect.succeed({ relayHookBaseUrl: null })),
              ),
            ),
          ),
        ),
        Effect.provide(SqlitePersistence.layerMemory),
      ) as Effect.Effect<A, E, never>,
    );

  it("keeps the HMAC check when a title-only edit sends keep_secret, and drops it only when asked", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* save(service, { type: "webhook", secret: "s3cret" });
        const edited = yield* save(service, { type: "webhook", keep_secret: true }, "Deploy hook, renamed");
        expect(automationOf(edited, undefined).trigger).toMatchObject({ type: "webhook", signed: true });
        // An unsigned POST is refused (the route answers 401); the old secret still signs.
        expect((yield* service.triggerWebhook(post(edited)))._tag).toBe("rejected_signature");
        expect((yield* service.triggerWebhook(post(edited, signed("s3cret"))))._tag).toBe("accepted");
        // Neither secret nor keep_secret: the person chose to remove the check.
        const unsigned = yield* save(service, { type: "webhook" });
        expect(automationOf(unsigned, undefined).trigger).toMatchObject({ type: "webhook", signed: false });
      }),
    );
  });

  it("runs an automation that follows the default on that default as it is when it runs", async () => {
    const now = { instanceId: "claudeAgent", model: "claude-sonnet-4-6" };
    await run((service) =>
      Effect.gen(function* () {
        const saved = yield* save(service, { type: "interval", every_minutes: 60 });
        expect(automationOf(saved, undefined, true).follows_default).toBe(true);
        expect(automationOf(saved, undefined).follows_default).toBeUndefined();
        yield* service.setRunModel((task) => Effect.succeed(task.id === saved.id ? (now as never) : undefined));
        yield* service.runNow({ id: saved.id });
        expect(launched.at(-1)).toEqual(now);
        // No answer: the model it was saved with.
        yield* service.setRunModel(() => Effect.succeed(undefined));
        yield* service.runNow({ id: saved.id });
        expect(launched.at(-1)).toEqual(saved.modelSelection);
      }),
    );
  });

  it("sets which requests start a run and its dedupe, and keeps everything else it stores (automation.set_webhook_rules)", async () => {
    const kv = new Map<string, string>();
    const store = { kvGet: (key: string) => Effect.sync(() => kv.get(key)), kvSet: (key: string, value: string) => Effect.sync(() => void kv.set(key, value)) };
    await run((service) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeAutomationHandlers({ store: store as never, launch: () => Effect.die("no launches here") });
          // An agent's webhook task (schedule_task): signed, its own permissions, workspace and age limit.
          const stored = yield* Schema.decodeUnknownEffect(ScheduledTaskUpsertInput)({
            id: "task-rules",
            title: "Triage pushes",
            prompt: "Triage {{body.ref}}",
            enabled: true,
            schedule: { type: "webhook", signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", secret: "s3cret" }, maxDeliveryAgeMinutes: 30 },
            projectId: "project-1",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "caveman", model: "openai/gpt-5.4-mini" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            creationSource: "mcp",
          }).pipe(Effect.flatMap((input) => service.upsert(input)), Effect.map(({ task }) => task));
          const filters = [
            { path: "headers.x-github-event", op: "equals", value: "push" },
            { path: "body.ref", op: "in", value: ["main", "release"] },
          ] as const;
          const set = yield* h["automation.set_webhook_rules"]({ request_id: "1", id: stored.id, filters: [...filters], dedupe: { replay_key: "{{headers.x-github-delivery}}" } });
          expect(set.trigger).toEqual({ type: "webhook", path: stored.webhook!.path, url: null, signed: true, filters: [...filters], dedupe: { replay_key: "{{headers.x-github-delivery}}" } });
          expect(Schema.is(Automation)(set)).toBe(true);
          const [after] = (yield* service.list()).tasks;
          expect(after).toMatchObject({ runtimeMode: "approval-required", workspaceStrategy: { type: "root" }, creationSource: "mcp", schedule: { maxDeliveryAgeMinutes: 30 } });
          expect(after!.schedule).toMatchObject({ filters: [{ path: "headers.x-github-event", op: "equals", value: "push" }, { path: "body.ref", op: "in", value: ["main", "release"] }], dedupe: { replayKey: "{{headers.x-github-delivery}}" } });
          // The secret stays: an unsigned push is refused, a signed one runs, a signed request the filters skip runs nothing.
          expect((yield* service.triggerWebhook(post(after!, { "x-github-event": "push" })))._tag).toBe("rejected_signature");
          expect(yield* service.triggerWebhook(post(after!, { ...signed("s3cret"), "x-github-event": "issues" }))).toMatchObject({ _tag: "accepted", outcome: "filtered" });
          expect(yield* service.triggerWebhook(post(after!, { ...signed("s3cret"), "x-github-event": "push", "x-github-delivery": "d1" }))).toMatchObject({ _tag: "accepted", outcome: "accepted" });
          expect(yield* service.triggerWebhook(post(after!, { ...signed("s3cret"), "x-github-event": "push", "x-github-delivery": "d1" }))).toMatchObject({ _tag: "accepted", outcome: "duplicate" });
          // Absent keeps what is stored; [] and {} clear.
          expect((yield* h["automation.set_webhook_rules"]({ request_id: "2", id: stored.id, dedupe: {} })).trigger).toMatchObject({ filters: [...filters] });
          const cleared = yield* h["automation.set_webhook_rules"]({ request_id: "3", id: stored.id, filters: [] });
          expect(cleared.trigger).toEqual({ type: "webhook", path: stored.webhook!.path, url: null, signed: true });
          // A key with no request placeholder, a task no webhook starts, and a file are refused.
          expect((yield* Effect.flip(h["automation.set_webhook_rules"]({ request_id: "4", id: stored.id, dedupe: { coalesce_key: "always" } }))).reason).toBe("invalid_params");
          const nightly = yield* save(service, { type: "interval", every_minutes: 60 }, "Nightly");
          expect((yield* Effect.flip(h["automation.set_webhook_rules"]({ request_id: "5", id: nightly.id, filters: [] }))).message).toMatch(/not started by a webhook/);
          expect((yield* Effect.flip(h["automation.set_webhook_rules"]({ request_id: "6", id: "file:p:me:x", filters: [] }))).reason).toBe("invalid_params");
          // automation.save carries them too: absent keeps, as a client that predates them saves.
          expect(scheduleFor({ type: "webhook", keep_secret: true, filters: [{ path: "query.source", op: "starts_with", value: "gh" }], dedupe: { coalesce_key: "{{body.id}}", coalesce_window_seconds: 60 } })).toEqual({
            type: "webhook",
            signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
            filters: [{ path: "query.source", op: "startsWith", value: "gh" }],
            dedupe: { coalesceKey: "{{body.id}}", coalesceWindowSeconds: 60 },
          });
        }),
      ),
    );
  });

  it("refuses keep_secret on a webhook that has no secret to keep", async () => {
    await expect(
      run((service) =>
        Effect.gen(function* () {
          yield* save(service, { type: "webhook" });
          return yield* save(service, { type: "webhook", keep_secret: true });
        }),
      ),
    ).rejects.toThrow(/signing secret/);
  });
});

describe("an app-saved @caveman mention automation changed around its GitHub checks", () => {
  const SOURCES_KEY = "automation_github_sources";
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });
  const comment = (id: number, created_at: string, repo = "acme/api"): GitHubComment => ({
    id,
    body: `@caveman please fix ${id}`,
    created_at,
    user: { login: "dev" },
    issue_url: `https://api.github.com/repos/${repo}/issues/${id}`,
    html_url: `https://github.com/${repo}/issues/${id}#c`,
  });
  type Handlers = Effect.Success<ReturnType<typeof makeAutomationHandlers>>;

  /**
   * The task saved in the app listening to acme/api since `since`, turned off. `check` builds the handlers, lets their
   * GitHub check run once and then runs `then` (the next check is a minute away); with `holding`, its `during` runs
   * while the check waits on GitHub's answer to `holding.at`, which `answer` (or `during`'s end) sends. `fired` holds
 * the comments that started a run, in order; `asked` the paths asked of GitHub; `afterSwitch` runs once upstream service
   * has turned the task on or off for the handlers, before they go on.
   */
  const withMentions = (
    onGitHub: Array<GitHubComment>,
    since: string,
    body: (input: {
      readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
      readonly check: (
        then?: (h: Handlers) => Effect.Effect<unknown, unknown>,
        holding?: { readonly at: string; readonly during: (h: Handlers, answer: () => void) => Effect.Effect<unknown, unknown> },
      ) => Effect.Effect<void, unknown>;
      readonly fired: ReadonlyArray<number>;
      readonly asked: ReadonlyArray<string>;
      readonly afterSwitch: (then: Effect.Effect<void>) => void;
    }) => Effect.Effect<void, unknown>,
  ) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const kv = new Map([[SOURCES_KEY, JSON.stringify({ "task-gh": { repo: "acme/api", since } })]]);
    /** The fiber the test calls the handlers on: any other that writes the sources is a check the handlers forked. */
    let caller = -1;
    let checkWrites = 0;
    const store = {
      kvGet: (key: string) => Effect.sync(() => kv.get(key)),
      kvSet: (key: string, value: string) =>
        Effect.fiberId.pipe(Effect.map((fiber) => void (kv.set(key, value), key === SOURCES_KEY && fiber !== caller && checkWrites++))),
    };
    const asked: Array<string> = [];
    /** A request whose answer, as GitHub had it when asked, reaches the check only once `answered` settles. */
    let held: { readonly path: string; asked: boolean; readonly answered: Promise<void> } | undefined;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      asked.push(url.pathname);
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
      const repo = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments$/.exec(url.pathname)?.[1];
      const answer =
        url.pathname === "/user"
          ? json({ login: "dev" })
          : repo !== undefined
            ? json(onGitHub.filter((c) => c.issue_url.includes(`/repos/${repo}/`) && c.created_at >= (url.searchParams.get("since") ?? "")))
            : /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname)
              ? json({ html_url: `https://github.com${url.pathname}`, title: "Flaky test" })
              : new Response("not found", { status: 404 });
      if (held?.path === url.pathname && !held.asked) {
        held.asked = true;
        await held.answered;
      }
      return answer;
    }) as typeof fetch;
    const credentials = Layer.succeed(
      GitHubCredentials.GitHubCredentials,
      GitHubCredentials.GitHubCredentials.of({
        get: (host) => Effect.succeed({ host, token: Redacted.make("gh-token"), source: "gh" as const, fingerprint: `${host}:gh` }),
        invalidate: () => Effect.void,
      }),
    );
    const fired: Array<number> = [];
    let switched: Effect.Effect<void> = Effect.void;
    return Effect.runPromise(
      Effect.gen(function* () {
        const real = yield* ScheduledTaskService.ScheduledTaskService;
        const service = ScheduledTaskService.ScheduledTaskService.of({
          ...real,
          setEnabled: (input) => real.setEnabled(input).pipe(Effect.tap(() => Effect.suspend(() => switched))),
          triggerWebhook: (request) =>
            real.triggerWebhook(request).pipe(
              Effect.tap((result) => Effect.sync(() => void (result._tag === "accepted" && fired.push((JSON.parse(request.bodyText) as { comment: GitHubComment }).comment.id)))),
            ),
        });
        yield* Schema.decodeUnknownEffect(ScheduledTaskUpsertInput)({
          id: "task-gh",
          title: "Mentions",
          prompt: `Do what I ask${GITHUB_MENTION_TEMPLATE}`,
          enabled: false,
          schedule: { type: "webhook", signature: null },
          projectId: "project-1",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "caveman", model: "openai/gpt-5.4-mini" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }).pipe(Effect.flatMap((input) => real.upsert(input)));
        const check = (
          then: (h: Handlers) => Effect.Effect<unknown, unknown> = () => Effect.void,
          holding?: { readonly at: string; readonly during: (h: Handlers, answer: () => void) => Effect.Effect<unknown, unknown> },
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              caller = yield* Effect.fiberId;
              let answer = () => {};
              const hold = holding && { path: holding.at, asked: false, answered: new Promise<void>((resolve) => (answer = resolve)) };
              held = hold;
              const before = checkWrites;
              const h = yield* makeAutomationHandlers({
                store: store as never,
                launch: () => Effect.succeed({ modelSelection: { instanceId: ProviderInstanceId.make("caveman"), model: "openai/gpt-5.4-mini" }, runtimeMode: "full-access" as const }),
              }).pipe(
                Effect.provideService(ScheduledTaskService.ScheduledTaskService, service),
                Effect.provide(credentials),
              );
              if (holding !== undefined && hold !== undefined) {
                while (!hold.asked) yield* Effect.yieldNow;
                yield* holding.during(h, answer);
                answer();
              }
              // The check forked with the handlers ends by writing the sources.
              while (checkWrites === before) yield* Effect.yieldNow;
              held = undefined;
              switched = Effect.void;
              yield* then(h);
            }),
          );
        yield* body({ service: real, check, fired, asked, afterSwitch: (then) => void (switched = then) });
      }).pipe(
        Effect.provide(
          ScheduledTaskService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodePlatformCrypto.layer,
                Scheduler.layer,
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({ launch: () => Effect.succeed({ threadId: "thread-1", resumed: false } as never) }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects", isScratchProject: () => Effect.succeed(false) }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.succeed(ScheduledTaskService.ScheduledTaskWebhookOrigin, Effect.succeed({ relayHookBaseUrl: null })),
              ),
            ),
          ),
        ),
        Effect.provide(SqlitePersistence.layerMemory),
      ) as Effect.Effect<void, unknown, never>,
    );
  };
  const at = (iso: string) => Effect.sync(() => vi.setSystemTime(new Date(iso)));

  it("starts a run only for the mentions made after its switch turned it back on", async () => {
    const onGitHub = [comment(1, "2026-10-02T09:00:00.000Z")];
    await withMentions(onGitHub, "2026-10-01T00:00:00.000Z", ({ check, fired }) =>
      Effect.gen(function* () {
        yield* at("2026-10-03T00:00:00.000Z");
        yield* check((h) =>
          Effect.gen(function* () {
            // Still off, after that check and before the next one.
            onGitHub.push(comment(2, "2026-10-03T00:00:20.000Z"));
            yield* at("2026-10-03T00:00:40.000Z");
            yield* h["automation.set_enabled"]({ request_id: "1", id: "task-gh", enabled: true });
          }),
        );
        onGitHub.push(comment(3, "2026-10-03T00:00:50.000Z"));
        yield* at("2026-10-03T00:01:00.000Z");
        yield* check();
        expect(fired).toEqual([3]);
      }),
    );
  });

  it("starts a run only for the mentions made after a save turned it back on", async () => {
    const onGitHub = [comment(1, "2026-10-02T09:00:00.000Z")];
    await withMentions(onGitHub, "2026-10-01T00:00:00.000Z", ({ check, fired }) =>
      Effect.gen(function* () {
        yield* at("2026-10-03T00:00:00.000Z");
        yield* check((h) =>
          Effect.gen(function* () {
            // Still off, after that check and before the next one.
            onGitHub.push(comment(2, "2026-10-03T00:00:20.000Z"));
            yield* at("2026-10-03T00:00:40.000Z");
            yield* h["automation.save"]({ request_id: "1", id: "task-gh", title: "Mentions", prompt: "Do what I ask", enabled: true, trigger: { type: "github_mention", repo: "acme/api" }, project_id: "project-1", engine: "caveman" });
          }),
        );
        onGitHub.push(comment(3, "2026-10-03T00:00:50.000Z"));
        yield* at("2026-10-03T00:01:00.000Z");
        yield* check();
        expect(fired).toEqual([3]);
      }),
    );
  });

  it("starts no run for the mentions its checks saw while it was off, however it is turned back on", async () => {
    const onGitHub = [comment(1, "2026-10-02T09:00:00.000Z")];
    await withMentions(onGitHub, "2026-10-01T00:00:00.000Z", ({ service, check, fired }) =>
      Effect.gen(function* () {
        yield* at("2026-10-03T00:00:00.000Z");
        yield* check();
 // upstream own route for scheduled tasks turns it on.
        yield* service.setEnabled({ id: ScheduledTaskId.make("task-gh"), enabled: true });
        onGitHub.push(comment(3, "2026-10-03T09:00:00.000Z"));
        yield* at("2026-10-03T09:01:00.000Z");
        yield* check();
        expect(fired).toEqual([3]);
      }),
    );
  });

  it("starts no run for what was said while it was off when its switch turns it on as a check asks GitHub who is signed in", async () => {
    const onGitHub = [comment(1, "2026-10-02T09:00:00.000Z")];
    await withMentions(onGitHub, "2026-10-01T00:00:00.000Z", ({ check, fired }) =>
      Effect.gen(function* () {
        yield* at("2026-10-03T00:00:00.000Z");
        yield* check();
        onGitHub.push(comment(2, "2026-10-03T00:00:20.000Z"));
        yield* at("2026-10-03T00:01:00.000Z");
        yield* check(undefined, {
          at: "/user",
          during: (h) => at("2026-10-03T00:01:01.000Z").pipe(Effect.andThen(h["automation.set_enabled"]({ request_id: "1", id: "task-gh", enabled: true }))),
        });
        onGitHub.push(comment(3, "2026-10-03T00:01:30.000Z"));
        yield* at("2026-10-03T00:02:00.000Z");
        yield* check();
        expect(fired).toEqual([3]);
      }),
    );
  });

  it("starts no run for what was said while it was off when a check lists it just as its switch turns it on", async () => {
    const onGitHub = [comment(1, "2026-10-02T09:00:00.000Z")];
    await withMentions(onGitHub, "2026-10-01T00:00:00.000Z", ({ check, fired, asked, afterSwitch }) =>
      Effect.gen(function* () {
        yield* at("2026-10-03T00:00:00.000Z");
        yield* check();
        onGitHub.push(comment(2, "2026-10-03T00:00:20.000Z"));
        yield* at("2026-10-03T00:01:00.000Z");
        yield* check(undefined, {
          at: "/user",
          during: (h, answer) =>
            Effect.gen(function* () {
              // T3 has turned it on and the switch has yet to say from when it hears: the check gets as far as it can.
              afterSwitch(
                Effect.gen(function* () {
                  answer();
                  while (!asked.includes("/repos/acme/api/issues/comments")) yield* Effect.yieldNow;
                }).pipe(Effect.timeoutOption("200 millis"), Effect.asVoid),
              );
              yield* at("2026-10-03T00:01:01.000Z");
              yield* h["automation.set_enabled"]({ request_id: "1", id: "task-gh", enabled: true });
            }),
        });
        onGitHub.push(comment(3, "2026-10-03T00:01:30.000Z"));
        yield* at("2026-10-03T00:02:00.000Z");
        yield* check();
        expect(fired).toEqual([3]);
      }),
    );
  });

  it("starts no run for what was said while it was off when its switch turns it off and on as a check reads its comments", async () => {
    const onGitHub: Array<GitHubComment> = [];
    await withMentions(onGitHub, "2026-10-03T00:00:00.000Z", ({ service, check, fired }) =>
      Effect.gen(function* () {
        yield* at("2026-10-03T00:00:00.000Z");
        yield* service.setEnabled({ id: ScheduledTaskId.make("task-gh"), enabled: true });
        onGitHub.push(comment(1, "2026-10-03T00:00:30.000Z"));
        yield* at("2026-10-03T00:01:00.000Z");
        yield* check(undefined, {
          at: "/repos/acme/api/issues/comments",
          during: (h) =>
            Effect.gen(function* () {
              yield* at("2026-10-03T00:01:01.000Z");
              yield* h["automation.set_enabled"]({ request_id: "1", id: "task-gh", enabled: false });
              onGitHub.push(comment(2, "2026-10-03T00:01:10.000Z"));
              yield* at("2026-10-03T00:01:20.000Z");
              yield* h["automation.set_enabled"]({ request_id: "2", id: "task-gh", enabled: true });
            }),
        });
        onGitHub.push(comment(3, "2026-10-03T00:01:30.000Z"));
        yield* at("2026-10-03T00:02:00.000Z");
        yield* check();
        // The first was said while it was on, and was in GitHub's answer to that check.
        expect(fired).toEqual([1, 3]);
      }),
    );
  });

  it("hears the repository a save moved it to as a check reads the old one's comments", async () => {
    const onGitHub: Array<GitHubComment> = [];
    await withMentions(onGitHub, "2026-10-03T00:00:00.000Z", ({ service, check, fired }) =>
      Effect.gen(function* () {
        yield* at("2026-10-03T00:00:00.000Z");
        yield* service.setEnabled({ id: ScheduledTaskId.make("task-gh"), enabled: true });
        yield* at("2026-10-03T00:01:00.000Z");
        yield* check(undefined, {
          at: "/repos/acme/api/issues/comments",
          during: (h) =>
            at("2026-10-03T00:01:01.000Z").pipe(
              Effect.andThen(
                h["automation.save"]({ request_id: "1", id: "task-gh", title: "Mentions", prompt: "Do what I ask", enabled: true, trigger: { type: "github_mention", repo: "acme/web" }, project_id: "project-1", engine: "caveman" }),
              ),
            ),
        });
        onGitHub.push(comment(4, "2026-10-03T00:01:30.000Z", "acme/web"));
        yield* at("2026-10-03T00:02:00.000Z");
        yield* check();
        expect(fired).toEqual([4]);
      }),
    );
  });
});

/** The protocol holds its own copy of the package's wire shapes (it depends on no package); these keep them one shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShapes: [
  Same<Automations.Diagnostic, typeof AutomationDiagnostic.Type>,
  Same<Automations.Explanation, typeof AutomationExplanation.Type>,
  Same<Automations.TemplateSummary, typeof AutomationTemplateSummary.Type>,
] = [true, true, true];

describe("automation files on the Session Protocol", () => {
  it("decodes the package's diagnostics, explanations and templates with the protocol's schemas", () => {
    expect(sameShapes).toEqual([true, true, true]);
    const broken = Automations.checkProject({
      files: [{ path: ".caveman/automations/a.yaml", text: "steps:\n  a:\n    agent: buidler\n    modle: fast\n" }],
      agents: [{ name: "builder", description: "", source: "builtin" }],
    });
    expect(broken.diagnostics.length).toBeGreaterThan(0);
    for (const d of broken.diagnostics) expect(Schema.decodeUnknownSync(AutomationDiagnostic)(d)).toEqual(d);

    const template = Automations.templates.find((t) => t.id === "issue-to-pr")!;
    const check = Automations.checkProject({ files: template.files, agents: [{ name: "builder", description: "", source: "builtin" }] });
    const env: Automations.EnvSnapshot = { host: "this-mac", defaultEngine: "caveman", engines: [], classes: {}, levers: [], servedTriggers: ["manual"] };
    const explanation = Automations.explain({ automation: check.automations[0]!, agents: check.agents, env });
    expect(Schema.decodeUnknownSync(AutomationExplanation)(explanation)).toEqual(explanation);
    for (const t of Automations.templates) {
      const summary = Automations.templateSummary(t);
      expect(Schema.decodeUnknownSync(AutomationTemplateSummary)(summary)).toEqual(summary);
    }
  });

  it("file reads and writes reach only the automation and agent folders", () => {
    const params = Methods["automation.file_read"].params;
    const ok = (path: string) => Schema.decodeUnknownSync(params)({ project_id: "p", path });
    for (const path of [".caveman/automations/a.yaml", ".caveman/local/automations/a.yaml", ".caveman/agents/reviewer.md"]) expect(ok(path).path).toBe(path);
    for (const path of [".caveman/computer.toml", ".caveman/agents/../../.env", "src/index.ts", "/etc/passwd", ".caveman/automations/../x"]) expect(() => ok(path), path).toThrow();
  });
});

describe("automation file handlers", () => {
  const PROJECT = "caveman-repo:abc123";
  const repos: TestRepo[] = [];
  afterEach(() => repos.splice(0).forEach((r) => r.remove()));

  /** The handlers over a temp repository, with the real files and triggers services and a recording runner. */
  const withHandlers = <A>(
    files: Record<string, string>,
    body: (h: Effect.Success<ReturnType<typeof makeAutomationHandlers>>, r: TestRepo, admitted: ReturnType<typeof fakeRunner>["admitted"]) => Effect.Effect<A, unknown>,
  ) => {
    const r = testRepo(files);
    repos.push(r);
    const kv = new Map<string, string>();
    const store = { kvGet: (key: string) => Effect.sync(() => kv.get(key)), kvSet: (key: string, value: string) => Effect.sync(() => void kv.set(key, value)) };
    const runner = fakeRunner();
    const services = Layer.mergeAll(filesLayer.pipe(Layer.provide(projectStoreFor({ [PROJECT]: r.root }))), runner.layer, Layer.succeed(SessionStore, store as never));
    const triggers = Layer.effect(AutomationTriggers, makeTriggers()).pipe(Layer.provideMerge(services));
    return Effect.runPromise(
      Effect.scoped(
        makeAutomationHandlers({ store: store as never, launch: () => Effect.die("no launches here") }).pipe(
          Effect.flatMap((h) => body(h, r, runner.admitted)),
          Effect.provide(triggers),
        ),
      ) as Effect.Effect<A, unknown>,
    );
  };

  it("lists file automations with their steps, problems, triggers and state", async () => {
    const manual = DIGEST.replace("on: { schedule: { every: 6h } }\n", "inputs:\n  issue: { description: Issue number, required: true }\n");
    const files = {
      ".caveman/.gitignore": "local/\n",
      ".caveman/automations/digest.yaml": DIGEST,
      ".caveman/automations/by-hand.yaml": manual,
      ".caveman/local/automations/mine.yaml": DIGEST.replace("model: fast", "modle: fast"),
    };
    await withHandlers(files, (h) =>
      Effect.gen(function* () {
        const { automations } = yield* h["automation.list"]({});
        for (const a of automations) expect(Schema.is(Automation)(a)).toBe(true);
        const digest = automations.find((a) => a.title === "digest")!;
        expect(digest).toMatchObject({
          id: `file:${PROJECT}:project:digest`,
          source: "file",
          scope: "project",
          path: ".caveman/automations/digest.yaml",
          enabled: false,
          trigger: { type: "file", kinds: ["manual", "schedule"], words: ["Every 6h", "By hand"] },
          steps: [{ name: "digest", model: "fast", computer: "none" }],
          diagnostics: 0,
          errors: 0,
          default_branch: "main",
          runs_on: "this_mac",
          on_default_branch: true,
          runs_running: 0,
          spend_30d_usd: 0,
          last_status: "never",
        });
        expect(digest.last30).toHaveLength(30);
        // A Me file with an error is listed, with its problems, so breaking it never makes it vanish; check says why.
        const { diagnostics } = yield* h["automation.check"]({ project_id: PROJECT });
        expect(diagnostics).toEqual([expect.objectContaining({ path: ".caveman/local/automations/mine.yaml", code: "unknown-key" })]);
        expect(automations.find((a) => a.title === "mine")).toMatchObject({ scope: "me", enabled: false, diagnostics: 1, errors: 1, steps: [], trigger: { words: ["Does not load: fix its errors"] } });
        // By hand only: its inputs for the form; where triggers fire and whether it is on main say nothing about it.
        const byHand = automations.find((a) => a.title === "by-hand")!;
        expect(byHand).toMatchObject({ inputs: [{ name: "issue", description: "Issue number", required: true }] });
        expect(byHand).not.toHaveProperty("on_default_branch");
        expect(byHand).not.toHaveProperty("runs_on");
        expect(byHand).not.toHaveProperty("triggers_off_reason");
      }),
    );
  });

  it("checks unsaved editor text and explains what will happen here", async () => {
    await withHandlers({ ".caveman/automations/digest.yaml": DIGEST }, (h) =>
      Effect.gen(function* () {
        const live = yield* h["automation.check"]({ project_id: PROJECT, files: [{ path: ".caveman/automations/digest.yaml", text: DIGEST.replace("every: 6h", "every: 1m") }] });
        expect(live.diagnostics).toEqual([expect.objectContaining({ code: "schedule-every-invalid", line: 1 })]);
        const { text, explanation } = yield* h["automation.explain"]({ project_id: PROJECT, name: "digest", scope: "project" });
        expect(Schema.decodeUnknownSync(AutomationExplanation)(explanation)).toEqual(explanation);
        expect(text).toContain("digest");
        expect(text).toMatch(/runs on +This Mac/);
        const missing = yield* Effect.flip(h["automation.explain"]({ project_id: PROJECT, name: "digest", scope: "project", step: "nope" }));
        expect(missing.message).toBe("digest has no step nope; its steps are digest.");
        const gone = yield* Effect.flip(h["automation.explain"]({ project_id: PROJECT, name: "other", scope: "me" }));
        expect(gone).toMatchObject({ reason: "not_found" });
      }),
    );
  });

  it("creates from a template (on, bound to what was made), reads and writes files, and deletes one", async () => {
    await withHandlers({}, (h, r) =>
      Effect.gen(function* () {
        const { templates } = yield* h["automation.templates"]();
        expect(templates.find((t) => t.id === "issue-to-pr")?.paths).toContain(".caveman/automations/issue-to-pr.yaml");
        const created = yield* h["automation.create"]({ request_id: "1", project_id: PROJECT, scope: "project", from: { template: "issue-to-pr" } });
        expect(created.written).toContain(".caveman/automations/issue-to-pr.yaml");
        expect(created.automation).toMatchObject({
          id: `file:${PROJECT}:project:issue-to-pr`,
          enabled: true,
          on_default_branch: false,
          triggers_off_reason: "It runs on Cloud (host: cloud); send it there with caveman-runtime apply. Running it by hand here still works.",
          takes_subject: "issue",
        });
        expect(created).not.toHaveProperty("renamed");
        const again = yield* h["automation.create"]({ request_id: "1b", project_id: PROJECT, scope: "project", from: { template: "issue-to-pr" } });
        expect(again.renamed ?? []).toEqual([]);
        const text = yield* h["automation.file_read"]({ project_id: PROJECT, path: ".caveman/automations/issue-to-pr.yaml" });
        expect(text.text).toContain("issues.labeled");
        const written = yield* h["automation.file_write"]({ request_id: "2", project_id: PROJECT, path: ".caveman/automations/issue-to-pr.yaml", text: text.text.replace("agent: builder", "agent: buidler") });
        expect(written.diagnostics).toEqual([expect.objectContaining({ code: "agent-unknown", message: 'No agent "buidler". Did you mean "builder"?' })]);
        const refused = yield* Effect.flip(h["automation.file_read"]({ project_id: PROJECT, path: ".caveman/computer.toml" as never }));
        expect(refused.reason).toBe("invalid_params");
        const fromText = yield* h["automation.create"]({ request_id: "3", project_id: PROJECT, scope: "me", from: { name: "digest", text: DIGEST } });
        expect(fromText.automation).toMatchObject({ scope: "me", enabled: true, path: ".caveman/local/automations/digest.yaml" });
        // F-1: a Me file saved here is on; one written any other way is off until turned on.
        const savedHere = yield* h["automation.file_write"]({ request_id: "3b", project_id: PROJECT, path: ".caveman/local/automations/saved.yaml", text: DIGEST });
        expect(savedHere.diagnostics.filter((d) => d.path.includes("saved"))).toEqual([]);
        r.write(".caveman/local/automations/by-agent.yaml", DIGEST);
        yield* Effect.sleep("1100 millis");
        const listed = (yield* h["automation.list"]({ project_id: PROJECT })).automations;
        expect(listed.find((a) => a.title === "saved")).toMatchObject({ scope: "me", enabled: true, runs_on: "this_mac" });
        expect(listed.find((a) => a.title === "by-agent")).toMatchObject({ scope: "me", enabled: false });
        yield* h["automation.delete"]({ request_id: "4", id: fromText.automation.id });
        expect(fs.existsSync(path.join(r.root, ".caveman/local/automations/digest.yaml"))).toBe(false);
        const unknownTemplate = yield* Effect.flip(h["automation.create"]({ request_id: "5", project_id: PROJECT, scope: "me", from: { template: "nope" } }));
        expect(unknownTemplate).toMatchObject({ reason: "not_found", message: "No template nope; pick one from automation.templates." });
      }),
    );
  });

  it("a Me routine a chat writes in its worktree is a draft that cannot turn on; its text created in the project is on, and the draft is gone", async () => {
    const ROUTINE = [
      "description: New bug reports this week",
      'on: { schedule: { at: "09:00", timezone: Europe/Amsterdam, until: "2026-11-22" } }',
      "steps:",
      "  check:",
      "    run: |",
      '      echo "Nothing new."',
      '      echo "decision: quiet"',
      "    decides: [news, quiet]",
      "outputs:",
      "  chief: { from: check }",
      "",
    ].join("\n");
    const branch = "caveman/chat-1a2b";
    const file = ".caveman/local/automations/launch-bugs.yaml";
    await withHandlers({ ".caveman/.gitignore": "local/\n" }, (h, r) => {
      // The chat's own checkout: a git worktree of the project on its branch.
      const wt = `${r.root}-chat`;
      return Effect.gen(function* () {
        r.git("worktree", "add", "-q", "-b", branch, wt);
        fs.mkdirSync(path.join(wt, ".caveman/local/automations"), { recursive: true });
        fs.writeFileSync(path.join(wt, file), ROUTINE);
        yield* Effect.sleep("1100 millis");
        const draft = (yield* h["automation.list"]({ project_id: PROJECT })).automations.find((a) => a.title === "launch-bugs")!;
        expect(draft).toMatchObject({ id: `file:${PROJECT}@${branch}:me:launch-bugs`, scope: "me", enabled: false, errors: 0, path: file, worktree: { branch, path: wt }, routine: { step: "check", until: "2026-11-22" } });
        const refused = yield* Effect.flip(h["automation.set_enabled"]({ request_id: "1", id: draft.id, enabled: true }));
        expect(refused.message).toBe(`launch-bugs is a draft on ${branch}: run it by hand now, and merge it to turn it on.`);

        // Turn on: the draft's text, read from its worktree, created in the project's own checkout.
        const { text } = yield* h["automation.file_read"]({ project_id: `${PROJECT}@${branch}`, path: file });
        expect(text).toBe(ROUTINE);
        const made = yield* h["automation.create"]({ request_id: "2", project_id: PROJECT, scope: "me", from: { name: "launch-bugs", text } });
        expect(made.automation).toMatchObject({ id: `file:${PROJECT}:me:launch-bugs`, enabled: true, routine: { step: "check" } });
        expect(made).not.toHaveProperty("renamed");
        expect(fs.readFileSync(path.join(r.root, file), "utf8")).toBe(ROUTINE);
        yield* Effect.sleep("1100 millis");
        const listed = (yield* h["automation.list"]({ project_id: PROJECT })).automations.filter((a) => a.title === "launch-bugs");
        expect(listed.map((a) => [a.id, a.enabled])).toEqual([[`file:${PROJECT}:me:launch-bugs`, true]]);

        // The chat changes its copy: a draft again, beside the project's file of that name, which the client never
        // creates over (it finds that row and says so); a create would take another name, never write over it.
        fs.writeFileSync(path.join(wt, file), ROUTINE.replace('"09:00"', '"10:00"'));
        yield* Effect.sleep("1100 millis");
        const both = (yield* h["automation.list"]({ project_id: PROJECT })).automations.filter((a) => a.title === "launch-bugs");
        expect(both.map((a) => a.id).sort()).toEqual([`file:${PROJECT}:me:launch-bugs`, `file:${PROJECT}@${branch}:me:launch-bugs`]);
        expect(fs.readFileSync(path.join(r.root, file), "utf8")).toBe(ROUTINE);
      }).pipe(Effect.ensuring(Effect.sync(() => fs.rmSync(wt, { recursive: true, force: true }))));
    });
  });

  it("runs a file by hand from the working tree: inputs checked, a manual subject, outputs a dry run", async () => {
    const withInput = `${DIGEST}inputs:\n  issue: { description: Issue number, required: true }\n  depth: { default: "2" }\n`;
    await withHandlers({ ".caveman/automations/digest.yaml": withInput }, (h, _r, admitted) =>
      Effect.gen(function* () {
        const id = `file:${PROJECT}:project:digest`;
        const missing = yield* Effect.flip(h["automation.run"]({ request_id: "1", id }));
        expect(missing.message).toBe("digest needs the input issue (Issue number); pass it as issue=<value>.");
        const unknown = yield* Effect.flip(h["automation.run"]({ request_id: "2", id, inputs: { isue: "1" } }));
        expect(unknown.message).toBe("digest has no input isue; its inputs are issue, depth.");
        const ran = yield* h["automation.run"]({ request_id: "3", id, inputs: { issue: "12" } });
        expect((ran as { run_id?: string }).run_id).toBe("r_1");
        expect(admitted[0]).toMatchObject({ projectId: PROJECT, inputs: { issue: "12", depth: "2" }, apply: false, trigger: { kind: "manual", trusted: true } });
        expect(admitted[0]!.trigger.subject).toMatch(/^manual:[0-9A-Z]{26}$/);
        expect(admitted[0]!.revision.from).toBe("working_tree");
        // A subject is an issue or pull request of this repo's GitHub origin, which this one has none of.
        const subject = yield* Effect.flip(h["automation.run"]({ request_id: "4", id, inputs: { issue: "12" }, subject: "github:acme/api#12" }));
        expect(subject).toMatchObject({ reason: "invalid_state", message: "This repo has no GitHub origin remote, so a run cannot be about one of its issues." });
      }),
    );
  });

  it("lists a Project automation whose default branch git cannot read as not read, never as off it", async () => {
    const shim = gitFailing();
    try {
      await withHandlers({ ".caveman/automations/digest.yaml": DIGEST }, (h) =>
        Effect.gen(function* () {
          const id = `file:${PROJECT}:project:digest`;
          // From the runtime's start, so no read of main worked yet.
          shim.failNext("cat-file", 100);
          const turnedOn = yield* h["automation.set_enabled"]({ request_id: "1", id, enabled: true });
          const { automations } = yield* h["automation.list"]({});
          shim.heal();
          for (const digest of [turnedOn, automations.find((a) => a.id === id)!]) {
            expect(digest).not.toHaveProperty("on_default_branch");
            expect(digest).toMatchObject({ enabled: true, default_branch: "main", triggers_off_reason: "Could not read main with git; Caveman tries again in a few seconds." });
          }
          const read = (yield* h["automation.list"]({})).automations.find((a) => a.id === id)!;
          expect(read).toMatchObject({ on_default_branch: true });
          expect(read).not.toHaveProperty("triggers_off_reason");
        }),
      );
    } finally {
      shim.restore();
    }
  });

  it("turns a file automation on and off in the runtime's state, and refuses a new app-saved one", async () => {
    await withHandlers({ ".caveman/automations/digest.yaml": DIGEST }, (h) =>
      Effect.gen(function* () {
        const id = `file:${PROJECT}:project:digest`;
        expect((yield* h["automation.set_enabled"]({ request_id: "1", id, enabled: true })).enabled).toBe(true);
        expect((yield* h["automation.set_enabled"]({ request_id: "2", id, enabled: false })).enabled).toBe(false);
        expect((yield* h["automation.deliveries"]({ id })).deliveries).toEqual([]);
        const save = yield* Effect.flip(
          h["automation.save"]({ request_id: "3", title: "x", prompt: "y", enabled: true, trigger: { type: "interval", every_minutes: 5 }, project_id: PROJECT, engine: "caveman" }),
        );
        expect(save.message).toMatch(/^New automations are files/);
      }),
    );
  });

  it("sends deliveries as data, with outcome still one sentence (B5)", () => {
    const base = { id: "gh:acme/api:issues.labeled:7", at: "2026-10-20T09:00:00.000Z", kind: "github" as const, event: "issues.labeled", subject: "github:acme/api#12", subjectTitle: "Login fails" };
    expect(deliveryOf({ ...base, outcome: "started", runId: "r_abc", by: "labelled by maya (collaborator); the issue is by stranger (none)" })).toEqual({
      id: base.id,
      received_at: base.at,
      outcome: "Started r_abc for github:acme/api#12 (Login fails), labelled by maya (collaborator); the issue is by stranger (none).",
      error: null,
      status: "started",
      run_id: "r_abc",
      event: "issues.labeled",
      subject: "github:acme/api#12",
      subject_title: "Login fails",
    });
    const refused = deliveryOf({ ...base, outcome: "refused", reason: "policy_denied", message: "Outsiders never start automations.", by: "stranger (none)" });
    expect(refused).toMatchObject({ status: "refused", reason: "policy_denied", error: "Outsiders never start automations.", outcome: "Refused github:acme/api#12 (Login fails), by stranger (none): Outsiders never start automations." });
    expect(deliveryOf({ id: "s", at: base.at, kind: "schedule", subject: "schedule:digest", outcome: "skipped", reason: "skipped_overlap", message: "Its last run is still going." })).toMatchObject({ status: "skipped", event: "schedule" });
  });

  it("draws the 30-day strip from finished runs, the day's last run deciding", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const cells = last30(
      [
        { status: "failed", started_at: "2026-10-20T08:00:00Z", ended_at: "2026-10-20T08:05:00Z" },
        { status: "succeeded", started_at: "2026-10-20T09:00:00Z", ended_at: "2026-10-20T09:05:00Z" },
        { status: "failed", started_at: "2026-10-19T09:00:00Z", ended_at: "2026-10-19T09:05:00Z" },
        { status: "running", started_at: "2026-10-18T09:00:00Z", ended_at: null },
      ],
      now,
    );
    expect(cells.slice(-3)).toEqual(["none", "failed", "worked"]);
    expect(cells.filter((c) => c === "none")).toHaveLength(28);
  });
});

describe("a Cloud schedule on the wire", () => {
  const schedule = {
    id: "cloud-schedule:1", title: "Nightly sweep", prompt: "sweep", schedule: { type: "fixed_time", timeOfDay: "02:00" }, enabled: true,
    state: "awaiting_approval" as const, leadWorkspaceId: "ws-lead", leadThreadId: "caveman:ws-lead", projectId: "p", engine: "codex",
    createdBy: "agent" as const, createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z",
    nextRunAt: null, lastRunAt: null, lastStatus: "never" as const, lastError: null, runCount: 0, builderWorkspaceId: null,
  };

  it("fires in Cloud on its computer's UTC clock, names the chat it wakes, and waits for the person", () => {
    expect(cloudAutomationOf(schedule)).toMatchObject({
      host: "cloud", source: "app", workspace_id: "ws-lead", awaiting_approval: true,
      trigger: { type: "daily", time: "02:00", timezone: "UTC" },
    });
    expect(cloudAutomationOf({ ...schedule, state: "active" })?.awaiting_approval).toBeUndefined();
  });

  it("says when it could not start, and leaves out a kind this build cannot show", () => {
    expect(cloudAutomationOf({ ...schedule, state: "failed" })).toMatchObject({ last_status: "failed", last_error: expect.stringMatching(/could not start/) });
    expect(cloudAutomationOf({ ...schedule, schedule: { type: "lunar" } })).toBeUndefined();
  });
});
